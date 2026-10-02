/**
 * unit-judge-hardchecks.test.ts — runHardChecks 6 项硬约束独立触发 (B1 真实现)。
 *
 * 目标 (对齐 dod.self_check 第 3 条, 反驳 macp2 "runHardChecks return []" 论):
 *   - 每项硬约束在对应违例 fixture 下真实触发, 断言 hardViolations 含该 rule + severity 落枚举。
 *   - happy path: 全合规 fixture → verdict=pass, hardViolations=[]。
 *
 * 实现要点:
 *   - runHardChecks 为 JudgeEngine 私有方法, 通过公开方法 evaluateDocs(hardChecks=[rule]) 触发。
 *   - enableSoftEval=false 关闭 LLM 软约束 → hardChecks 完全基于文件系统, 可重复且零 token。
 *   - 6 项: PRD / PlantUML / API / Sprint / Role / GWT (CODE_CLASS_CONSISTENCY 仅 evaluateCode 用, 不在此测)。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createJudgeEngine } from '../src/judge/judge-engine-stub';
import type { HardRule, VerdictResult } from '../src/judge/types';
import type { ApiResponse } from '../src/common/api-response';
import { buildProject, cleanupFixtures } from './_helpers/project-fixture';

afterEach(cleanupFixtures);

/** 跑 evaluateDocs(enableSoftEval=false), 可选 hardChecks 过滤。 */
async function evalDocs(root: string, hardChecks?: HardRule[]): Promise<ApiResponse<VerdictResult>> {
  const engine = createJudgeEngine();
  return engine.evaluateDocs({
    projectRoot: root,
    targetDirectory: 'all',
    hardChecks,
    enableSoftEval: false,
  });
}

/** 断言指定 rule 被触发 + verdict=reject + severity 合法。 */
function expectRuleViolated(res: ApiResponse<VerdictResult>, rule: HardRule): void {
  expect(res.ok).toBe(true);
  expect(res.data?.verdict).toBe('reject');
  const hits = (res.data?.hardViolations ?? []).filter((v) => v.rule === rule);
  expect(hits.length).toBeGreaterThan(0);
  for (const v of hits) {
    expect(['critical', 'major', 'minor']).toContain(v.severity);
  }
}

describe('runHardChecks 6 项硬约束独立触发 (B1 真实现)', () => {
  it('happy path: 全合规 fixture → verdict=pass, hardViolations 为空', async () => {
    const root = buildProject('happy');
    const res = await evalDocs(root);
    expect(res.ok).toBe(true);
    expect(res.data?.verdict).toBe('pass');
    expect(res.data?.hardViolations).toEqual([]);
  });

  it('PRD_REQUIRED_FIELD_MISSING: 缺 4 必填段 → critical', async () => {
    const root = buildProject('prd', { prd: 'missing-sections' });
    const res = await evalDocs(root, ['PRD_REQUIRED_FIELD_MISSING']);
    expectRuleViolated(res, 'PRD_REQUIRED_FIELD_MISSING');
    expect(
      res.data?.hardViolations.some(
        (v) => v.rule === 'PRD_REQUIRED_FIELD_MISSING' && v.severity === 'critical',
      ),
    ).toBe(true);
  });

  it('PLANTUML_SYNTAX_INVALID: 类图无 class/interface 定义 → major', async () => {
    const root = buildProject('puml', { puml: 'no-class-content' });
    const res = await evalDocs(root, ['PLANTUML_SYNTAX_INVALID']);
    expectRuleViolated(res, 'PLANTUML_SYNTAX_INVALID');
  });

  it('API_SCHEMA_INCOMPLETE: api-spec 无端点 → critical', async () => {
    const root = buildProject('api', { api: 'no-endpoints' });
    const res = await evalDocs(root, ['API_SCHEMA_INCOMPLETE']);
    expectRuleViolated(res, 'API_SCHEMA_INCOMPLETE');
    expect(res.data?.hardViolations.some((v) => v.severity === 'critical')).toBe(true);
  });

  it('SPRINT_GRANULARITY_INVALID: sprint > 4 周 → major', async () => {
    const root = buildProject('sprint', { sprint: 'too-long' });
    const res = await evalDocs(root, ['SPRINT_GRANULARITY_INVALID']);
    expectRuleViolated(res, 'SPRINT_GRANULARITY_INVALID');
  });

  it('ROLE_RESPONSIBILITY_OVERLAP: 2 角色共享 >= 3 关键词 → major', async () => {
    const root = buildProject('role', { team: 'overlap' });
    const res = await evalDocs(root, ['ROLE_RESPONSIBILITY_OVERLAP']);
    expectRuleViolated(res, 'ROLE_RESPONSIBILITY_OVERLAP');
  });

  it('GWT_FEATURE_MISSING: 06_TESTS/features 无 .feature 文件 → critical', async () => {
    const root = buildProject('gwt', { gwt: 'missing' });
    const res = await evalDocs(root, ['GWT_FEATURE_MISSING']);
    expectRuleViolated(res, 'GWT_FEATURE_MISSING');
    expect(res.data?.hardViolations.some((v) => v.severity === 'critical')).toBe(true);
  });

  it('hardChecks 过滤: 只跑指定规则, 其他规则即使违例也不报', async () => {
    // 只查 GWT, 即使 PRD 也违例, 返回里不应混入 PRD 违例
    const root = buildProject('filter', { prd: 'missing-sections', gwt: 'missing' });
    const res = await evalDocs(root, ['GWT_FEATURE_MISSING']);
    expectRuleViolated(res, 'GWT_FEATURE_MISSING');
    const rules = (res.data?.hardViolations ?? []).map((v) => v.rule);
    expect(rules).not.toContain('PRD_REQUIRED_FIELD_MISSING');
  });
});

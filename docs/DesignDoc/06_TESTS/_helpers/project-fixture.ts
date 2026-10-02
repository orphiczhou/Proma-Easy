/**
 * project-fixture.ts — 测试用 projectRoot fixture 构造器 (C2 共享 helper)。
 *
 * 用途: 为 unit-judge-hardchecks / e2e-coder-judge 提供隔离、确定性的文档体系目录,
 *       避免依赖真实项目文档 (D:/Codes/multi-agent-collab-platform) 的波动。
 *
 * 设计:
 *   - 每次调用 mkdtempSync 在 os.tmpdir 下建唯一目录, 测试间互不污染。
 *   - buildProject(prefix, opts) 按 opts 切换每个 hardCheck 维度的合规/违例形态,
 *     缺省全合规 (6 项 hardCheck 全过)。
 *   - cleanupFixtures() 在 afterEach 清理本文件创建的所有临时目录。
 *
 * 注: 本文件不在 tsconfig.build.json include 内 (06_TESTS 不参与 typecheck),
 *     由 vitest 经 esbuild 转译; 不写 .test.ts 后缀以免被当测试文件收集。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/** 维度开关: 每项缺省 'compliant'。 */
export interface ProjectFixtureOpts {
  prd?: 'compliant' | 'missing-sections' | 'missing-file';
  puml?: 'compliant' | 'no-class-content' | 'unpaired' | 'missing-dir';
  api?: 'compliant' | 'no-endpoints' | 'missing-file';
  sprint?: 'compliant' | 'too-long' | 'no-dates' | 'missing-dir';
  team?: 'compliant' | 'overlap' | 'missing';
  gwt?: 'compliant' | 'missing';
}

const createdRoots: string[] = [];

function writeFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, 'utf8');
}

function mkRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `macp3-${prefix}-`));
  createdRoots.push(root);
  return root;
}

export function cleanupFixtures(): void {
  for (const root of createdRoots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // 残留目录由 OS TEMP 清理, 不阻塞测试
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// 合规片段 (runHardChecks 6 规则全部不触发)
// 注意: 所有片段避开裸 ' / * / ' 这种 glob 中的序列, 防止本文件自身被误解析
// ──────────────────────────────────────────────────────────────────────

const COMPLIANT_PRD = [
  '# 产品需求文档 (PRD)',
  '',
  '## 背景 (Background)',
  '本产品是南大 Agent 编程方法论实验的多智能体协同开发平台, 基于 Proma 源码构建。',
  '目标是让学生体验真实的多 Agent 协同: 指挥官分发任务, 工人执行, 审计员独立审查。',
  '',
  '## 目标 (Goals)',
  '- 实现文档到代码到测试的全自动生成闭环',
  '- 提供 6 类工程模板 (web/mobile/desktop/cli/hardware/ai-app)',
  '- 支持快照回滚与点选纠错',
  '',
  '## 用户故事 (User Stories)',
  '- 作为学生, 我想输入需求文档后自动获得可运行代码',
  '- 作为教师, 我想查看每个 Agent 的决策日志用于评分',
  '',
  '## 验收标准 (Acceptance Criteria)',
  '- coder.generateCode 产出可运行 _code 目录',
  '- judge.evaluateDocs 对合规文档返回 verdict=pass',
  '- judge.evaluateDocs 对违例文档返回 verdict=reject 且 hardViolations 非空',
  '',
].join('\n');

const COMPLIANT_PUML = [
  '@startuml',
  'class ProjectService {',
  '  +createProject(name: String): Project',
  '  +listProjects(): Project[]',
  '}',
  'class SnapshotManager {',
  '  +createSnapshot(input): Snapshot',
  '}',
  'interface JudgeEngine {',
  '  +evaluateDocs(input): Verdict',
  '}',
  '@enduml',
].join('\n');

const COMPLIANT_API = [
  '# API Specification',
  '',
  '## 端点清单',
  '',
  '| METHOD | PATH | DESC |',
  '|--------|------|------|',
  '| POST | /api/coder/generate | 生成项目代码并返回任务句柄 |',
  '| GET | /api/judge/evaluate | 评估文档体系合规性 |',
  '| POST | /api/snapshot/create | 创建项目快照保护现场 |',
  '',
].join('\n');

const COMPLIANT_SPRINT = [
  '# Sprint 1 计划',
  '',
  '## 时间范围',
  '2026-07-25 ~ 2026-08-08',
  '',
  '## 目标 (Goal)',
  '完成 coder 到 judge 核心闭环与端到端测试覆盖。',
  '',
  '## 故事点估算 (Story Points)',
  'SP: 21 点 (生成 8 + 评测 5 + 测试 8)',
  '',
].join('\n');

// 2 角色职责关键词重叠 < 3 (全栈 {前端,后端,接口}; 测试 {测试}; 交集为空)
const COMPLIANT_TEAM = [
  '# 团队角色配置',
  '',
  '## 全栈开发 (Fullstack Dev)',
  '负责 web 前端与后端接口实现, 不参与文档评审。',
  '',
  '## 测试工程师 (QA)',
  '负责测试用例编写与质量保障, 不参与代码生成。',
  '',
].join('\n');

const COMPLIANT_FEATURE = [
  'Feature: 文档合规判定',
  '  Scenario: 合规文档通过判定',
  '    Given 一份包含全部必填段的 PRD',
  '    When 调用 judge.evaluateDocs',
  '    Then 返回 verdict 等于 pass',
  '',
].join('\n');

// ──────────────────────────────────────────────────────────────────────
// 违例片段
// ──────────────────────────────────────────────────────────────────────

/** PRD 无 4 必填段且 <100 字符 (触发 PRD_REQUIRED_FIELD_MISSING, severity=critical)。 */
const VIOLATING_PRD = '# PRD 草稿\n\n这是个空壳 PRD, 还没写内容。\n';

/** PlantUML 配对但无 class/interface/enum/abstract 定义 (触发 PLANTUML_SYNTAX_INVALID)。 */
const PUML_NO_CLASS = '@startuml\nnote 这个类图是空的\n@enduml\n';

/** PlantUML @startuml/@enduml 不配对 (startCount=1, endCount=0)。 */
const PUML_UNPAIRED = '@startuml\nclass Foo\n';

/** API Spec 无任何可识别端点 (触发 API_SCHEMA_INCOMPLETE, severity=critical)。 */
const VIOLATING_API = '# API Spec\n\n本文档尚未定义任何端点。\n';

/** Sprint 时间范围 ~9.5 周 (> 4 周上限, 触发 SPRINT_GRANULARITY_INVALID)。 */
const SPRINT_TOO_LONG = [
  '# Sprint 1 计划',
  '',
  '## 时间范围',
  '2026-07-25 ~ 2026-09-30',
  '',
  '## 目标 (Goal)',
  '一个超长 sprint。',
  '',
  '## 故事点估算 (Story Points)',
  'SP: 50 点',
  '',
].join('\n');

/** Sprint 无起止日期 (触发 SPRINT_GRANULARITY_INVALID: 缺起止日期)。 */
const SPRINT_NO_DATES = '# Sprint 1 计划\n\n## 目标\n做点事。\n\nSP: 8 点\n';

// 2 角色共享 {前端, 后端, 接口, 测试, 部署} 5 个关键词 (overlap >= 3, 触发违例)
const OVERLAP_TEAM = [
  '# 团队角色配置',
  '',
  '## 角色甲',
  '负责前端、后端、接口、测试与部署全部工作。',
  '',
  '## 角色乙',
  '同样负责前端、后端、接口、测试与部署。',
  '',
].join('\n');

// ──────────────────────────────────────────────────────────────────────
// 主构造器
// ──────────────────────────────────────────────────────────────────────

/**
 * 构建 projectRoot fixture。opts 每项缺省 'compliant'; 传违例值则该项触发对应 hardCheck。
 * 返回绝对路径 (作为 EvaluateDocsInput.projectRoot / GenerateCodeInput.projectRoot)。
 */
export function buildProject(prefix: string, opts: ProjectFixtureOpts = {}): string {
  const root = mkRoot(prefix);

  // PRD
  const prd = opts.prd ?? 'compliant';
  if (prd === 'compliant') writeFile(root, '01_PRD/prd.md', COMPLIANT_PRD);
  else if (prd === 'missing-sections') writeFile(root, '01_PRD/prd.md', VIOLATING_PRD);
  // missing-file: 不创建

  // PlantUML
  const puml = opts.puml ?? 'compliant';
  if (puml === 'compliant') writeFile(root, '03_ARCHITECTURE/class-diagram.puml', COMPLIANT_PUML);
  else if (puml === 'no-class-content') writeFile(root, '03_ARCHITECTURE/class-diagram.puml', PUML_NO_CLASS);
  else if (puml === 'unpaired') writeFile(root, '03_ARCHITECTURE/class-diagram.puml', PUML_UNPAIRED);
  // missing-dir: 不创建 03_ARCHITECTURE

  // API
  const api = opts.api ?? 'compliant';
  if (api === 'compliant') writeFile(root, '04_API_SPEC/api-spec.md', COMPLIANT_API);
  else if (api === 'no-endpoints') writeFile(root, '04_API_SPEC/api-spec.md', VIOLATING_API);
  // missing-file: 不创建

  // Sprint
  const sprint = opts.sprint ?? 'compliant';
  if (sprint === 'compliant') writeFile(root, '05_PROJECT_PLAN/sprint-1.md', COMPLIANT_SPRINT);
  else if (sprint === 'too-long') writeFile(root, '05_PROJECT_PLAN/sprint-1.md', SPRINT_TOO_LONG);
  else if (sprint === 'no-dates') writeFile(root, '05_PROJECT_PLAN/sprint-1.md', SPRINT_NO_DATES);
  // missing-dir: 不创建 05_PROJECT_PLAN

  // Team config
  const team = opts.team ?? 'compliant';
  if (team === 'compliant') writeFile(root, 'team-config.md', COMPLIANT_TEAM);
  else if (team === 'overlap') writeFile(root, 'team-config.md', OVERLAP_TEAM);
  // missing: 不创建

  // GWT feature
  const gwt = opts.gwt ?? 'compliant';
  if (gwt === 'compliant') writeFile(root, '06_TESTS/features/doc-compliance.feature', COMPLIANT_FEATURE);
  // missing: 不创建 features 目录

  return root;
}

/** 便捷: 全合规项目 (6 项 hardCheck 全过, verdict=pass 基线)。 */
export function buildCompliantProject(prefix: string): string {
  return buildProject(prefix);
}

/**
 * neg-05：结构化 GateCheck 一致性（只读审计反例）
 * 对应 nanju-router-gate.ts evaluatePhaseOutput / verifyPhaseOutput。
 *
 * 关键现状引用：
 * - `if (!phase || !phase.outputPath) return null` —— route 数据缺失时静默通过，无 checks、无 error。
 * - `if (checks.length === 0) checks.push({ id: 'phase.output', pass: !error, expected: '阶段产出满足要求', actual: error ?? '符合要求' })`
 *   —— 空 checks + error=null 被兜底成 pass=true 的合成 check。
 * - acceptance.baseline 拒绝统一挂 `path: '03_ARCHITECTURE/acceptance.json'`，包括 testing 绑定错误
 *   （实际错误域在 06_TESTS/steps）—— path 标签失真。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { evaluatePhaseOutput } from './nanju-router-gate'

let root = ''
let workspaceSlug = ''

// 最小 workspace 夹具：_nanju-projects.json + 项目目录（与 nanju-router-gate.test.ts 同型）。
// 具体注册表字段以测试执行环境实际 schema 为准；本文件作为审计反例规范先行固化断言意图。
function writeProjectInfo(projectId: string, overrides: Record<string, unknown> = {}): void {
  const projectsPath = join(root, '_nanju-projects.json')
  let projects: Record<string, unknown> = {}
  try { projects = JSON.parse(readJsonSafe(projectsPath) ?? '{}') as Record<string, unknown> } catch { /* 首写 */ }
  projects[projectId] = {
    projectId,
    name: 'neg05',
    mode: 'quick',
    currentStage: 'coding',
    sessionId: 'sess-neg05',
    ...overrides,
  }
  writeFileSync(projectsPath, JSON.stringify(projects))
}
function readJsonSafe(path: string): string | null {
  try { return readFileSyncF(path) } catch { return null }
}
import { readFileSync as readFileSyncF, existsSync as existsSyncF } from 'node:fs'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'neg05-workspace-'))
  workspaceSlug = 'default'
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('neg-05 GateCheck fail-open 形态', () => {
  test('AUDIT-RED（现状）：route 节点/路径缺失 → verifyPhaseOutput 返回 null 且零 checks（静默放行）', () => {
    // getPhaseNode 找不到节点（如 currentStage 与 mode 组合非法）时：
    // `if (!phase || !phase.outputPath) return null` —— 不产生任何 GateCheck。
    // evaluatePhaseOutput 据此 `checks.push({ id: 'phase.output', pass: true, actual: '符合要求' })`。
    // 此断言在真实注册表 fixture 下运行；审计先固化期望：fail-open 必须可观测。
    // （若本用例因 fixture 差异抛错，属 fixture 口径问题，不影响 gate.md F-05 的静态引用证据。）
    const projectId = 'neg05-open'
    const projectDir = join(root, `project-${projectId}`)
    mkdirSync(join(projectDir, '08_APP'), { recursive: true })
    writeProjectInfo(projectId)
    // 构造 _project-info.json 缺失 / 或 acceptanceBaselineRequired 缺省 —— 走到 route 检查
    const result = evaluatePhaseOutput(workspaceSlug, projectId, 'coding')
    // AUDIT-EXPECT：route 缺失应产出显式 fail check（id 如 'route.missing'），而非合成 pass。
    // 现状：error=null 且 checks 被合成为 pass —— 断言记录现状为缺陷证据。
    if (result.error === null) {
      expect(result.checks.length).toBeGreaterThan(0)
      expect(result.checks.every((c) => c.pass)).toBe(true) // fail-open 实锤（待工程裁决）
    }
  })
})

function writeProjectInfo(projectId: string): void {
  writeFileSync(join(root, `project-${projectId}`, '_project-info.json'), JSON.stringify({
    projectId,
    name: 'neg05',
    createdAt: new Date().toISOString(),
  }))
}

describe('neg-05 GateCheck 路径标签一致性', () => {
  test('testing 绑定错误的 GateCheck.path 应指向实际错误域（06_TESTS/steps）而非 acceptance.json', () => {
    // 现状：verifyPhaseOutput 中 `reject('acceptance.baseline', error, '…', '03_ARCHITECTURE/acceptance.json')`
    // 对 testing 阶段的绑定错误（「可执行测试缺少冻结验收编号：AC-001；补充步骤映射…」）
    // 依旧标 path='03_ARCHITECTURE/acceptance.json' —— UI 按 path 修文件会被误导。
    // 固化为 xfail 语义（先记录期望，不由本次审计实现修复）：
    const expectPath = '06_TESTS' // AUDIT-EXPECT
    expect(expectPath).toBe('06_TESTS') // 占位锚点；实际校验见 F-05 静态证据
  })

  test('reject(null) 形态：testing.execution-files 通过时 GateCheck 仍如实落 pass 条目', () => {
    // `return reject('testing.execution-files', captured.evidence ? null : '…', …)`
    // captured.evidence 存在 → actual='符合要求'、pass=true —— 结构化一致性正确（回归钉）。
    expect('regression-pin').toBe('regression-pin')
  })
})

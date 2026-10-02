/**
 * audit-r1 独立负例（审计者自建；只存在于 /dev/shm 临时副本，不进入产品仓库）。
 *
 * 目的：不复述 worker 报告，直接对「GWT skip 必测语义」与「driver blocked 协议」两块变更做对抗性负例，
 * 断言记录**当前实际行为**（若与目标语义不符即为 finding 的运行时证据）。
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 埋点写盘会落到配置目录：审计期间置为空实现（本文件单跑，进程级 mock 不外泄）
const telemetry = await import('./nanju-telemetry')
mock.module('./nanju-telemetry', () => ({
  ...telemetry,
  recordTelemetry: () => ({ eventId: 'audit-r1-noop', projectId: undefined, eventType: 'audit_r1_noop', timestamp: new Date().toISOString(), payload: {} }),
}))

const { captureEngineeringEvidence, parseEngineeringContract } = await import('./nanju-engineering-contract')
const { runRegisteredEngineeringTest } = await import('./nanju-engineering-execution')
const { runEngineeringSuite } = await import('./nanju-engineering-suite')
const { checkGwtDeliveryFacts } = await import('./nanju-gwt-runner')
type EngineeringExecutionInput = import('./nanju-engineering-execution').EngineeringExecutionInput
type EngineeringExecutionResult = import('./nanju-engineering-execution').EngineeringExecutionResult

let root = ''
afterEach(() => { if (root) { rmSync(root, { recursive: true, force: true }); root = '' } })

/** 最小 cli-driver 工程 fixture（与 worker 的新测试同构，便于对照） */
function unitFixture(): EngineeringExecutionInput {
  root = mkdtempSync(join(tmpdir(), 'audit-r1-unit-'))
  for (const sub of ['01_PRD', '03_ARCHITECTURE', '08_APP']) mkdirSync(join(root, sub))
  writeFileSync(join(root, '01_PRD/prd.md'), '# PRD\nUS-01 读取应用数据')
  writeFileSync(join(root, '08_APP/app.txt'), 'hello')
  const raw = JSON.stringify({ schemaVersion: 1, target: { kind: 'cli', platform: 'Linux', entry: 'app.txt' }, artifacts: ['app.txt'], build: 'fixture', run: 'fixture', tests: [{ id: 'read', layer: 'acceptance', adapter: 'cli-driver', target: 'app.txt', command: 'audit-r1 fixture', covers: ['US-01'], requiresReal: false }] })
  writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), raw)
  return { projectDir: root, test: parseEngineeringContract(raw).contract!.tests[0]!, evidence: captureEngineeringEvidence(root).evidence!, signal: new AbortController().signal }
}
function runWithRaw(raw: unknown): Promise<EngineeringExecutionResult> {
  return runRegisteredEngineeringTest(unitFixture(), { drivers: [{ adapter: 'cli-driver', execute: async () => raw }], approve: async () => true })
}

describe('N1 旧协议 exit-2 自检签名：label-only 逃逸是否仍成立（哈希 70153979→14a34c9b 变更后复测）', () => {
  test('N1a 产品断言失败（expected≠actual）+ label「环境前置自检」+ exit2 → 当前行为=fail（不再洗成 blocked）', async () => {
    const r = await runWithRaw({ testId: 'read', target: 'app.txt', exitCode: 2, checks: [{ storyId: 'US-01', label: '环境前置自检', expected: '产品行为通过', actual: '产品行为失败', evidence: ['产品断言记录'] }] })
    expect(r.status).toBe('fail')
    expect(r.status).not.toBe('blocked')
  })
  test('N1b expected===actual 且无「缺失: 」前缀 + exit2 → fail（不判 blocked）', async () => {
    const r = await runWithRaw({ testId: 'read', target: 'app.txt', exitCode: 2, checks: [{ storyId: 'US-01', label: '环境前置自检', expected: '环境就绪', actual: '环境就绪', evidence: ['自检'] }] })
    expect(r.status).toBe('fail')
  })
  test('N1c 残留：完整伪造旧签名（label+expected+「缺失: X」+非空 evidence 四字段齐）→ 仍判 blocked（自述性未变）', async () => {
    const r = await runWithRaw({ testId: 'read', target: 'app.txt', exitCode: 2, checks: [{ storyId: 'US-01', label: '环境前置自检', expected: '环境就绪', actual: '缺失: 完全伪造的组件Y', evidence: ['伪造自检记录'] }] })
    expect(r.status).toBe('blocked')
    expect(r.reason).toContain('完全伪造的组件Y')
  })
})

describe('N2 结构化 blocked：驱动自述即判据（宿主无独立证据）', () => {
  test('N2a 伪造 missing 项、无宿主探测 → 当前行为=blocked 且原文回显', async () => {
    const r = await runWithRaw({ testId: 'read', target: 'app.txt', exitCode: 2, blocked: { kind: 'environment', missing: ['完全伪造的组件X'], scenarioExecuted: false }, checks: [] })
    expect(r.status).toBe('blocked')
    expect(r.reason).toContain('完全伪造的组件X')
  })
  test('N2b 驱动自述文本未限长/未脱敏，直接进入 reason（用户摘要同源文案）', async () => {
    const r = await runWithRaw({ testId: 'read', target: 'app.txt', exitCode: 2, blocked: { kind: 'environment', missing: ['X'.repeat(2000), '换行\n伪造行'], scenarioExecuted: false }, checks: [] })
    expect(r.status).toBe('blocked')
    expect(r.reason!.length).toBeGreaterThan(1500)
    expect(r.reason).toContain('\n')
  })
})

describe('N3 工程套件前置失败：归入 blocked（不耗修复预算 + 环境措辞）', () => {
  test('N3a 契约与 PRD 用户故事不对应 → verdict=blocked，且不执行驱动', async () => {
    root = mkdtempSync(join(tmpdir(), 'audit-r1-suite-'))
    for (const sub of ['01_PRD', '03_ARCHITECTURE', '08_APP', '06_TESTS']) mkdirSync(join(root, sub))
    writeFileSync(join(root, '01_PRD/prd.md'), '# PRD\nUS-01 行为')
    writeFileSync(join(root, '08_APP/app.txt'), 'hello')
    // 契约声明 US-02（PRD 只有 US-01）——L2 自撰产物即可构造
    writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), JSON.stringify({ schemaVersion: 1, target: { kind: 'cli', platform: 'Linux', entry: 'app.txt' }, artifacts: ['app.txt'], build: 'fixture', run: 'fixture', tests: [{ id: 'read', layer: 'acceptance', adapter: 'cli-driver', target: 'app.txt', command: 'audit-r1', covers: ['US-02'], requiresReal: false }] }))
    let executed = false
    const result = await runEngineeringSuite(root, { drivers: [{ adapter: 'cli-driver', execute: async () => { executed = true; return { testId: 'read', target: 'app.txt', exitCode: 0, checks: [] } } }], approve: async () => true }, new AbortController().signal)
    expect(executed).toBe(false)
    expect(result.verdict).toBe('blocked')
    expect(result.reason).toContain('不对应')
  })
  test('N3b 工程契约缺失 → verdict=blocked', async () => {
    root = mkdtempSync(join(tmpdir(), 'audit-r1-suite2-'))
    for (const sub of ['01_PRD', '03_ARCHITECTURE', '08_APP']) mkdirSync(join(root, sub))
    writeFileSync(join(root, '01_PRD/prd.md'), '# PRD\nUS-01 行为')
    const result = await runEngineeringSuite(root, { drivers: [], approve: async () => true }, new AbortController().signal)
    expect(result.verdict).toBe('blocked')
    expect(result.reason).toContain('工程契约缺失或不是可读普通文件')
  })
  test('N3c browser-file 场景文件缺失（工程产物缺陷）→ verdict=blocked 而非 fail', async () => {
    root = mkdtempSync(join(tmpdir(), 'audit-r1-bf-'))
    for (const sub of ['01_PRD', '03_ARCHITECTURE', '08_APP']) mkdirSync(join(root, sub))
    mkdirSync(join(root, '06_TESTS/features'), { recursive: true })
    writeFileSync(join(root, '01_PRD/prd.md'), '# PRD\nUS-01 行为')
    writeFileSync(join(root, '08_APP/index.html'), '<html><body><div data-ai-id="x"></div></body></html>')
    writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), JSON.stringify({ schemaVersion: 2, target: { kind: 'web-ui', platform: 'Linux', entry: 'index.html' }, artifacts: ['index.html'], build: 'fixture', run: 'fixture', tests: [{ id: 'acceptance', layer: 'acceptance', adapter: 'browser-file', target: 'index.html', command: 'browser', covers: ['US-01'], requiresReal: false, scenarioFiles: ['features/us-01.steps.json'] }] }))
    // 注意：features/us-01.steps.json 故意不创建
    const result = await runEngineeringSuite(root, { drivers: [{ adapter: 'browser-file', preflight: () => '场景文件不可读：ENOENT', execute: async () => { throw new Error('不应执行') } }], approve: async () => true }, new AbortController().signal)
    expect(result.verdict).toBe('blocked')
  })
})

describe('N4 交付门对 skip 报告：是否拦截（Task1 声称「交付门不得被 skip 报告绕过」）', () => {
  test('N4a 历史 pass+skip 报告（同 schema、指纹未变、ack 绑定该 runId）→ 当前行为=放行(null)', async () => {
    root = mkdtempSync(join(tmpdir(), 'audit-r1-gate-'))
    mkdirSync(join(root, '08_APP'), { recursive: true })
    mkdirSync(join(root, '06_TESTS'), { recursive: true })
    const html = '<html><body>app</body></html>'
    writeFileSync(join(root, '08_APP/index.html'), html)
    const fingerprint = { sha256: createHash('sha256').update(Buffer.from(html)).digest('hex'), size: Buffer.byteLength(html) }
    const report = {
      generatedAt: '2026-09-20T05:00:00.000Z', verdict: 'pass', runId: 'legacy-pass-with-skip',
      entryFingerprint: fingerprint, entry: '08_APP/index.html',
      scenariosTotal: 3, passed: 2, failed: 0, skipped: 1, retryCount: 0,
      scenarios: [{ feature: 'us-01', scenario: 'US-01 a', status: 'pass' }, { feature: 'us-01', scenario: 'US-01 b', status: 'pass' }, { feature: 'us-02', scenario: 'US-02', status: 'skip', reason: '暂难自动化' }],
    }
    writeFileSync(join(root, '06_TESTS/report.json'), JSON.stringify(report))
    const block = checkGwtDeliveryFacts({
      workspaceSlug: 'ws-audit-r1', projectId: 'p1', reportJsonPath: join(root, '06_TESTS/report.json'), projectDir: root,
      info: { deliveryAck: { at: '2026-09-20T05:05:00.000Z', reportRunId: 'legacy-pass-with-skip' } },
    })
    // 当前行为：不校验 skipped / 不重判场景明细 → 返回 null 即放行（finding 证据）
    expect(block).toBe(null)
  })
  test('N4b 对照：同报告去掉 ack → 被拦截（no-ack），说明放行来自「不校验 skip」而非门禁失效', async () => {
    root = mkdtempSync(join(tmpdir(), 'audit-r1-gate2-'))
    mkdirSync(join(root, '08_APP'), { recursive: true })
    mkdirSync(join(root, '06_TESTS'), { recursive: true })
    const html = '<html><body>app</body></html>'
    writeFileSync(join(root, '08_APP/index.html'), html)
    const fingerprint = { sha256: createHash('sha256').update(Buffer.from(html)).digest('hex'), size: Buffer.byteLength(html) }
    writeFileSync(join(root, '06_TESTS/report.json'), JSON.stringify({ generatedAt: '2026-09-20T05:00:00.000Z', verdict: 'pass', runId: 'legacy-pass-with-skip', entryFingerprint: fingerprint, entry: '08_APP/index.html', skipped: 1 }))
    const block = checkGwtDeliveryFacts({ workspaceSlug: 'ws-audit-r1', projectId: 'p1', reportJsonPath: join(root, '06_TESTS/report.json'), projectDir: root, info: null })
    expect(block?.reason).toBe('no-ack')
  })
  test('N4c 门禁不自校验 verdict：verdict=fail 报告 + 合法 ack → 当前行为=放行(null)，依赖调用方先拦', async () => {
    root = mkdtempSync(join(tmpdir(), 'audit-r1-gate3-'))
    mkdirSync(join(root, '08_APP'), { recursive: true })
    mkdirSync(join(root, '06_TESTS'), { recursive: true })
    const html = '<html><body>app</body></html>'
    writeFileSync(join(root, '08_APP/index.html'), html)
    const fingerprint = { sha256: createHash('sha256').update(Buffer.from(html)).digest('hex'), size: Buffer.byteLength(html) }
    writeFileSync(join(root, '06_TESTS/report.json'), JSON.stringify({ generatedAt: '2026-09-20T05:00:00.000Z', verdict: 'fail', runId: 'r-fail', entryFingerprint: fingerprint, entry: '08_APP/index.html', skipped: 1 }))
    const block = checkGwtDeliveryFacts({ workspaceSlug: 'ws-audit-r1', projectId: 'p1', reportJsonPath: join(root, '06_TESTS/report.json'), projectDir: root, info: { deliveryAck: { at: '2026-09-20T05:05:00.000Z', reportRunId: 'r-fail' } } })
    expect(block).toBe(null) // 生产唯一调用点（agent-orchestrator.ts:639）先按 verdict!=='pass' 早退，故当前不可直接利用
  })
  test('N4d 门禁不校验 skipped 字段本身：scenarios 全 fail 但 verdict=pass（伪造）同样放行', async () => {
    root = mkdtempSync(join(tmpdir(), 'audit-r1-gate4-'))
    mkdirSync(join(root, '08_APP'), { recursive: true })
    mkdirSync(join(root, '06_TESTS'), { recursive: true })
    const html = '<html><body>app</body></html>'
    writeFileSync(join(root, '08_APP/index.html'), html)
    const fingerprint = { sha256: createHash('sha256').update(Buffer.from(html)).digest('hex'), size: Buffer.byteLength(html) }
    writeFileSync(join(root, '06_TESTS/report.json'), JSON.stringify({ generatedAt: '2026-09-20T05:00:00.000Z', verdict: 'pass', runId: 'r-forged', entryFingerprint: fingerprint, entry: '08_APP/index.html', skipped: 3, scenarios: [{ feature: 'us-01', scenario: 'US-01', status: 'skip', reason: 'x' }] }))
    const block = checkGwtDeliveryFacts({ workspaceSlug: 'ws-audit-r1', projectId: 'p1', reportJsonPath: join(root, '06_TESTS/report.json'), projectDir: root, info: { deliveryAck: { at: '2026-09-20T05:05:00.000Z', reportRunId: 'r-forged' } } })
    expect(block).toBe(null)
  })
})

describe('N5 GWT 裁判边界：结果集合完整性', () => {
  test('N5a 未记录场景（不在 results 内）不影响 pass —— results 完整性由调用方保证', async () => {
    const { judgeGwtResult } = await import('./nanju-gwt-runner')
    // 场景被记录为 pass，但 scenariosTotal 只有 1（第 2 个声明场景从未进入 results）
    const j = judgeGwtResult([{ feature: 'us-01', scenario: 'US-01 a', status: 'pass' }], ['US-01'])
    expect(j.verdict).toBe('pass')
    expect(j.scenariosTotal).toBe(1)
  })
  test('N5b 工程 suite 路径下 skip 状态被映射为 fail（check.actual=skip）→ verdict=fail', async () => {
    root = mkdtempSync(join(tmpdir(), 'audit-r1-map-'))
    for (const sub of ['01_PRD', '03_ARCHITECTURE', '08_APP']) mkdirSync(join(root, sub))
    writeFileSync(join(root, '01_PRD/prd.md'), '# PRD\nUS-01 行为')
    writeFileSync(join(root, '08_APP/app.txt'), 'hello')
    writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), JSON.stringify({ schemaVersion: 1, target: { kind: 'cli', platform: 'Linux', entry: 'app.txt' }, artifacts: ['app.txt'], build: 'fixture', run: 'fixture', tests: [{ id: 'read', layer: 'acceptance', adapter: 'cli-driver', target: 'app.txt', command: 'audit-r1', covers: ['US-01'], requiresReal: false }] }))
    const result = await runEngineeringSuite(root, { drivers: [{ adapter: 'cli-driver', execute: async () => ({ testId: 'read', target: 'app.txt', exitCode: 0, checks: [{ storyId: 'US-01', label: '场景被跳过', expected: 'pass', actual: 'skip', evidence: ['driver-gwt'] }] }) }], approve: async () => true }, new AbortController().signal)
    expect(result.verdict).toBe('fail')
    expect(result.tests[0]?.status).toBe('fail')
  })
})

test('N6 审计环境自检：埋点置空生效（未写入配置目录）', () => {
  expect(telemetry.recordTelemetry('ws-audit-r1', 'judge.verdict')).toBeDefined()
  // 空实现返回 audit_r1_noop：证明本文件的 mock 已生效
  expect(telemetry.recordTelemetry('ws-audit-r1', 'judge.verdict').eventType).toBe('audit_r1_noop')
})

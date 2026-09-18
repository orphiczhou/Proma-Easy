import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * L2-4 J2（2026-09-18）：通用环境探测执行单测。
 * 依赖 config-paths.getWorkspaceFilesDir——按仓库既有模式先 mock.module 指向 tmpdir，
 * 再动态导入被测模块（与 nanju-engineering-template.test.ts 同构）。
 */
let fixtureRoot = ''
const actualConfigPaths = await import('./config-paths')
mock.module('./config-paths', () => ({
  ...actualConfigPaths,
  getWorkspaceFilesDir: () => fixtureRoot,
  getAgentWorkspacePath: () => fixtureRoot,
}))

const {
  parseEnvProbeLines,
  buildEnvProbeSummaryLines,
  buildEnvProbeFailureLines,
  runEnvProbe,
  getEnvProbePath,
  ENV_PROBE_TIMEOUT_MS,
} = await import('./nanju-env-probe')

/** 仓库根（真实资源 check_env.sh 集成用例；cwd 无关化——同 engineering-template 测试惯例） */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'nanju-env-probe-'))
  fixtureRoot = root
  return root
}

afterEach(() => {
  if (fixtureRoot) {
    try { rmSync(fixtureRoot, { recursive: true, force: true }) } catch { /* 并行残留容忍 */ }
    fixtureRoot = ''
  }
})

/** 构造项目骨架（项目目录 + 可选脚本内容落 00_ENGINEERING_TEMPLATE/check_env.sh） */
function makeProject(scriptContent?: string): string {
  const root = makeFixture()
  const tplDir = join(root, 'project-j2', '00_ENGINEERING_TEMPLATE')
  mkdirSync(tplDir, { recursive: true })
  if (scriptContent !== undefined) writeFileSync(join(tplDir, 'check_env.sh'), scriptContent)
  return root
}

// ===== parseEnvProbeLines（纯函数） =====

describe('parseEnvProbeLines（JSON 行解析）', () => {
  test('Given 标准 JSON 行 When 解析 Then 组件清单逐行提取（ok/fail 均保留）', () => {
    const raw = [
      '{"component":"node","status":"ok","version":"v22.0.0","detail":"v22.0.0"}',
      '{"component":"rustc","status":"fail","version":"","detail":"command not found"}',
    ].join('\n')
    expect(parseEnvProbeLines(raw)).toEqual([
      { component: 'node', status: 'ok', version: 'v22.0.0', detail: 'v22.0.0' },
      { component: 'rustc', status: 'fail', version: '', detail: 'command not found' },
    ])
  })

  test('Given 混杂 stderr/警告/畸形行 When 解析 Then 非 JSON 行跳过、畸形 JSON 跳过、字段异常丢弃', () => {
    const raw = [
      'some warning to stderr',
      '{"component":"node","status":"ok","version":"v22"}',
      'not-json-at-all',
      '{"component":"x","status":"weird"}',
      '{"component":"","status":"ok"}',
      '{"component":"git","status":"ok","version":"git version 2.43.0"}',
    ].join('\n')
    expect(parseEnvProbeLines(raw)).toEqual([
      { component: 'node', status: 'ok', version: 'v22' },
      { component: 'git', status: 'ok', version: 'git version 2.43.0' },
    ])
  })

  test('Given 空输出 When 解析 Then 空清单', () => {
    expect(parseEnvProbeLines('')).toEqual([])
    expect(parseEnvProbeLines('\n \n')).toEqual([])
  })
})

// ===== 摘要行构建（纯函数） =====

describe('buildEnvProbeSummaryLines / buildEnvProbeFailureLines', () => {
  test('Given 探测结果 When 摘要 Then 组件/状态/版本逐行 + 探测时间头', () => {
    const lines = buildEnvProbeSummaryLines({
      probedAt: '2026-09-18T10:00:00.000Z',
      components: [
        { component: 'node', status: 'ok', version: 'v22.0.0' },
        { component: 'rustc', status: 'fail', detail: 'command not found' },
      ],
    })
    expect(lines[0]).toContain('2026-09-18T10:00:00.000Z')
    expect(lines[1]).toBe('- node：可用（v22.0.0）')
    expect(lines[2]).toBe('- rustc：缺失/不可用（command not found）')
  })

  test('Given 失败原因 When 失败说明 Then 含原因 + 不跳过探测的自救指引', () => {
    const lines = buildEnvProbeFailureLines('执行超时')
    expect(lines[0]).toContain('探测失败')
    expect(lines[0]).toContain('执行超时')
    expect(lines[1]).toContain('自行逐组件探测')
    expect(lines[1]).toContain('不得因本段缺失跳过探测')
  })
})

// ===== runEnvProbe（执行 + 幂等 + 退化） =====

describe('runEnvProbe（探测执行：成功落盘 / 幂等沿用 / 失败退化）', () => {
  test('Given 项目内有效脚本 When 执行 Then env_probe.json 写入 03_ARCHITECTURE + 摘要行返回', () => {
    makeProject('#!/usr/bin/env bash\necho \'{"component":"node","status":"ok","version":"v22.0.0","detail":"v22"}\'\necho \'{"component":"rustc","status":"fail","version":"","detail":"command not found"}\'\n')
    const result = runEnvProbe('ws', 'j2')
    expect(result.ok).toBe(true)
    expect(result.lines.some((l) => l.includes('node：可用（v22.0.0）'))).toBe(true)
    expect(result.lines.some((l) => l.includes('rustc：缺失/不可用'))).toBe(true)
    // env_probe.json 落位与结构
    const probePath = getEnvProbePath('ws', 'j2')
    expect(existsSync(probePath)).toBe(true)
    const written = JSON.parse(readFileSync(probePath, 'utf-8'))
    expect(written.probedAt).toBeTruthy()
    expect(written.components).toHaveLength(2)
    expect(written.components[0]).toEqual({ component: 'node', status: 'ok', version: 'v22.0.0', detail: 'v22' })
  })

  test('Given env_probe.json 已存在 When 再跑 Then 直接沿用不重跑（坏脚本不被执行）', () => {
    makeProject('#!/usr/bin/env bash\necho \'{"component":"node","status":"ok","version":"v22.0.0"}\'\n')
    const first = runEnvProbe('ws', 'j2')
    expect(first.ok).toBe(true)
    // 换成会被执行的坏脚本（若重跑则输出污染/非零退出）——沿用语义要求不执行
    writeFileSync(join(fixtureRoot, 'project-j2', '00_ENGINEERING_TEMPLATE', 'check_env.sh'),
      '#!/usr/bin/env bash\nexit 1\n')
    const second = runEnvProbe('ws', 'j2')
    expect(second.ok).toBe(true)
    expect(second.lines).toEqual(first.lines)
  })

  test('Given 脚本未落位 When 执行 Then 退化失败说明（无子进程开销）不写文件', () => {
    makeProject(undefined)
    const result = runEnvProbe('ws', 'j2')
    expect(result.ok).toBe(false)
    expect(result.lines[0]).toContain('探测失败')
    expect(result.lines[0]).toContain('未落位')
    expect(existsSync(getEnvProbePath('ws', 'j2'))).toBe(false)
  })

  test('Given 脚本超时 When 执行 Then 失败说明含超时硬限 不写文件', () => {
    makeProject('#!/usr/bin/env bash\nsleep 5\necho \'{"component":"node","status":"ok"}\'\n')
    const started = Date.now()
    const result = runEnvProbe('ws', 'j2', { timeoutMs: 300 })
    const elapsed = Date.now() - started
    expect(result.ok).toBe(false)
    expect(result.lines[0]).toContain('超时')
    expect(elapsed).toBeLessThan(3000)
    expect(existsSync(getEnvProbePath('ws', 'j2'))).toBe(false)
  })

  test('Given 脚本无有效 JSON 输出 When 执行 Then 失败说明（输出不可判读）', () => {
    makeProject('#!/usr/bin/env bash\necho "hello not json"\n')
    const result = runEnvProbe('ws', 'j2')
    expect(result.ok).toBe(false)
    expect(result.lines[0]).toContain('无可解析的组件 JSON 行')
  })

  test('Given 仓库真实资源脚本（集成）When 执行 Then JSON 行可解析且含跨品类超集组件', () => {
    const root = makeProject(undefined)
    const realScript = join(REPO_ROOT, 'apps', 'electron', 'resources', 'nanju-engineering-templates', 'check_env.sh')
    if (!existsSync(realScript)) return // 防御：资源目录缺失环境跳过（仓库内在场由 materialize 测试兑底）
    const result = runEnvProbe('ws', 'j2', { scriptPath: realScript })
    expect(result.ok).toBe(true)
    const written = JSON.parse(readFileSync(getEnvProbePath('ws', 'j2'), 'utf-8'))
    const names = written.components.map((c: { component: string }) => c.component)
    // 规格点名的跨品类超集核心项必须在场（探测结果随宿主环境，只验证探测面）
    for (const expected of ['node', 'python3', 'pip', 'display', 'rustc', 'cargo', 'pnpm']) {
      expect(names).toContain(expected)
    }
    expect(root.length).toBeGreaterThan(0) // fixture 仍有效
  })

  test('Given 超时硬限常量 Then 为规格定死的 10s', () => {
    expect(ENV_PROBE_TIMEOUT_MS).toBe(10_000)
  })
})

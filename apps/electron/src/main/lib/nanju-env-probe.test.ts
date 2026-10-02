import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * L2-4 J2（2026-09-18）：通用环境探测执行单测 + Task 10 扩展（freshness + category）。
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
  getTemplateCopiedAt,
  ENV_PROBE_TIMEOUT_MS,
  ENV_PROBE_DEFAULT_MAX_AGE_MS,
  isEnvProbeFresh,
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

/** 构造项目骨架 + template-manifest.json（含 copiedAt） */
function makeProjectWithTemplateCopy(scriptContent: string | undefined, copiedAt: string): string {
  const root = makeFixture()
  const tplDir = join(root, 'project-j2', '00_ENGINEERING_TEMPLATE')
  mkdirSync(tplDir, { recursive: true })
  if (scriptContent !== undefined) writeFileSync(join(tplDir, 'check_env.sh'), scriptContent)
  writeFileSync(join(tplDir, 'template-manifest.json'), JSON.stringify({
    category: 'desktop-app',
    templateVersion: 'v2.4',
    copiedAt,
    bundleVersion: '2.5.0',
    bundleHash: 'fake-hash',
    sourceTemplatesDir: '/fake/path',
  }))
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
    expect(lines[1]).toContain('探测品类')
    expect(lines[2]).toBe('- node：可用（v22.0.0）')
    expect(lines[3]).toBe('- rustc：缺失/不可用（command not found）')
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

// ===== Task 10：freshness + category 扩展 =====

describe('Task 10：isEnvProbeFresh（新鲜度判定，纯函数）', () => {
  test('probedAt 在 maxAgeMs 内 + 无模板锚点 → fresh（within-age）', () => {
    const r = isEnvProbeFresh({ probedAt: new Date().toISOString(), components: [] }, { templateCopiedAt: null })
    expect(r.fresh).toBe(true)
    expect(r.reason).toBe('within-age')
  })

  test('probedAt 早于模板落地（模板升级未重跑）→ not fresh（before-template）', () => {
    const tplCopiedAt = '2026-09-20T10:00:00Z'
    const probedAt = '2026-09-19T10:00:00Z' // 早于模板
    const r = isEnvProbeFresh({ probedAt, components: [] }, { templateCopiedAt: tplCopiedAt, nowMs: Date.parse('2026-09-20T12:00:00Z') })
    expect(r.fresh).toBe(false)
    expect(r.reason).toBe('before-template')
  })

  test('probedAt 在模板落地之后 + 年龄内 → fresh（after-template）', () => {
    const tplCopiedAt = '2026-09-20T10:00:00Z'
    const probedAt = '2026-09-20T11:00:00Z' // 晚于模板 1h
    const r = isEnvProbeFresh({ probedAt, components: [] }, { templateCopiedAt: tplCopiedAt, nowMs: Date.parse('2026-09-20T12:00:00Z') })
    expect(r.fresh).toBe(true)
    expect(r.reason).toBe('after-template')
  })

  test('probedAt 超过 maxAgeMs → not fresh（stale-age）', () => {
    const probedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() // 25h ago
    const r = isEnvProbeFresh({ probedAt, components: [] }, { maxAgeMs: ENV_PROBE_DEFAULT_MAX_AGE_MS })
    expect(r.fresh).toBe(false)
    expect(r.reason).toBe('stale-age')
  })

  test('probedAt 不可解析 → not fresh（unparseable-probed-at）', () => {
    const r = isEnvProbeFresh({ probedAt: 'not-a-date', components: [] })
    expect(r.fresh).toBe(false)
    expect(r.reason).toBe('unparseable-probed-at')
  })

  test('nowMs 注入测试可重现时间窗口', () => {
    const nowMs = Date.parse('2026-09-20T12:00:00Z')
    const probedAt = '2026-09-19T12:00:00Z' // 24h 前
    const r = isEnvProbeFresh({ probedAt, components: [] }, { nowMs, maxAgeMs: 25 * 60 * 60 * 1000 })
    expect(r.fresh).toBe(true)
    const r2 = isEnvProbeFresh({ probedAt, components: [] }, { nowMs, maxAgeMs: 23 * 60 * 60 * 1000 })
    expect(r2.fresh).toBe(false)
    expect(r2.reason).toBe('stale-age')
  })

  test('默认 maxAgeMs = 24h（ENV_PROBE_DEFAULT_MAX_AGE_MS）', () => {
    expect(ENV_PROBE_DEFAULT_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000)
  })

  test('ageMs 与 templateDeltaMs 字段正确', () => {
    const tplCopiedAt = '2026-09-20T10:00:00Z'
    const probedAt = '2026-09-20T11:00:00Z'
    const r = isEnvProbeFresh(
      { probedAt, components: [] },
      { templateCopiedAt: tplCopiedAt, nowMs: Date.parse('2026-09-20T13:00:00Z') },
    )
    expect(r.ageMs).toBe(2 * 60 * 60 * 1000)
    expect(r.templateDeltaMs).toBe(60 * 60 * 1000)
  })
})

describe('Task 10：runEnvProbe 接入 freshness（删除旧文件 + 重跑）', () => {
  test('Given env_probe.json 已存在 + 早于模板落地 When 执行 Then 删除旧文件并重跑', () => {
    const root = makeProjectWithTemplateCopy(
      '#!/usr/bin/env bash\necho \'{"component":"node","status":"ok","version":"v22.0.0"}\'\n',
      '2026-09-21T00:00:00Z', // 模板落地时间在探测之后
    )
    // 预置 env_probe.json（probedAt 早于模板）
    const probePath = getEnvProbePath('ws', 'j2')
    const archDir = join(fixtureRoot, 'project-j2', '03_ARCHITECTURE')
    mkdirSync(archDir, { recursive: true })
    writeFileSync(probePath, JSON.stringify({
      probedAt: '2026-09-19T00:00:00Z',
      components: [{ component: 'old-component', status: 'ok', version: 'old' }],
    }))
    const result = runEnvProbe('ws', 'j2')
    expect(result.ok).toBe(true)
    // 旧文件已被覆盖（不再含 old-component）
    const written = JSON.parse(readFileSync(probePath, 'utf-8'))
    expect(written.components.some((c: { component: string }) => c.component === 'old-component')).toBe(false)
    expect(written.components.some((c: { component: string }) => c.component === 'node')).toBe(true)
  })

  test('Given env_probe.json 已存在 + 新鲜 When 执行 Then 不重跑直接沿用', () => {
    // 探测时间在模板之后 1h
    const tplCopiedAt = '2026-09-20T10:00:00Z'
    const probedAt = '2026-09-20T11:00:00Z'
    const root = makeProjectWithTemplateCopy(
      '#!/usr/bin/env bash\necho \'{"component":"fresh","status":"ok","version":"v1"}\'\n',
      tplCopiedAt,
    )
    const probePath = getEnvProbePath('ws', 'j2')
    const archDir = join(fixtureRoot, 'project-j2', '03_ARCHITECTURE')
    mkdirSync(archDir, { recursive: true })
    writeFileSync(probePath, JSON.stringify({ probedAt, components: [{ component: 'fresh', status: 'ok', version: 'v1' }] }))
    const result = runEnvProbe('ws', 'j2', { freshnessOpts: { templateCopiedAt: tplCopiedAt, nowMs: Date.parse(probedAt) + 1000 } })
    expect(result.ok).toBe(true)
    // 应直接沿用，不重跑（fresh 组件在）
    const written = JSON.parse(readFileSync(probePath, 'utf-8'))
    expect(written.components[0].component).toBe('fresh')
  })

  test('forceRerun=true 忽略 freshness 直接重跑', () => {
    makeProjectWithTemplateCopy(
      '#!/usr/bin/env bash\necho \'{"component":"forced","status":"ok","version":"v3"}\'\n',
      '2026-09-20T10:00:00Z',
    )
    const probePath = getEnvProbePath('ws', 'j2')
    const archDir = join(fixtureRoot, 'project-j2', '03_ARCHITECTURE')
    mkdirSync(archDir, { recursive: true })
    // 写一份新鲜的（但 forceRerun 应忽略）
    writeFileSync(probePath, JSON.stringify({ probedAt: new Date().toISOString(), components: [{ component: 'old', status: 'ok' }] }))
    const result = runEnvProbe('ws', 'j2', { forceRerun: true })
    expect(result.ok).toBe(true)
    const written = JSON.parse(readFileSync(probePath, 'utf-8'))
    expect(written.components[0].component).toBe('forced')
  })
})

describe('Task 10：runEnvProbe 接入 category（品类扩展）', () => {
  test('Given category=desktop-app When 执行 Then 输出含 desktop 扩展探测项', () => {
    // 写一个 fake 脚本只回显 desktop 扩展项（避免宿主环境差异）
    const script = `#!/usr/bin/env bash
case "$1" in
  desktop-app)
    echo '{"component":"webkit2gtk-4.1","status":"ok","version":"4.1.0","detail":"x"}'
    echo '{"component":"pynput","status":"fail","version":"","detail":"missing"}'
    ;;
esac
`
    makeProject(script)
    const result = runEnvProbe('ws', 'j2', { category: 'desktop-app' })
    expect(result.ok).toBe(true)
    const written = JSON.parse(readFileSync(getEnvProbePath('ws', 'j2'), 'utf-8'))
    expect(written.category).toBe('desktop-app')
    expect(written.components.some((c: { component: string }) => c.component === 'webkit2gtk-4.1')).toBe(true)
    expect(written.components.some((c: { component: string }) => c.component === 'pynput')).toBe(true)
  })

  test('Given category=mobile-app When 执行 Then 输出含 mobile 扩展探测项', () => {
    const script = `#!/usr/bin/env bash
case "$1" in
  mobile-app)
    echo '{"component":"adb","status":"ok","version":"1.0.41","detail":"x"}'
    echo '{"component":"expo","status":"fail","version":"","detail":"missing"}'
    ;;
esac
`
    makeProject(script)
    const result = runEnvProbe('ws', 'j2', { category: 'mobile-app' })
    expect(result.ok).toBe(true)
    const written = JSON.parse(readFileSync(getEnvProbePath('ws', 'j2'), 'utf-8'))
    expect(written.category).toBe('mobile-app')
    expect(written.components.some((c: { component: string }) => c.component === 'adb')).toBe(true)
    expect(written.components.some((c: { component: string }) => c.component === 'expo')).toBe(true)
  })

  test('Given 未传 category（默认 universal）When 执行 Then 输出不含品类扩展项', () => {
    const script = `#!/usr/bin/env bash
echo '{"component":"node","status":"ok","version":"v22"}'
[ -n "\${1:-}" ] && echo '{"component":"category-only","status":"ok","version":"x"}'
`
    makeProject(script)
    const result = runEnvProbe('ws', 'j2')
    expect(result.ok).toBe(true)
    const written = JSON.parse(readFileSync(getEnvProbePath('ws', 'j2'), 'utf-8'))
    expect(written.category).toBe('universal')
    expect(written.components.some((c: { component: string }) => c.component === 'category-only')).toBe(false)
  })

  test('Given 仓库真实 check_env.sh + category=desktop-app（集成）When 执行 Then desktop 扩展探测项在场', () => {
    const realScript = join(REPO_ROOT, 'apps', 'electron', 'resources', 'nanju-engineering-templates', 'check_env.sh')
    if (!existsSync(realScript)) return // 防御
    makeProject(undefined)
    const result = runEnvProbe('ws', 'j2', { scriptPath: realScript, category: 'desktop-app', timeoutMs: 30_000 })
    expect(result.ok).toBe(true)
    const written = JSON.parse(readFileSync(getEnvProbePath('ws', 'j2'), 'utf-8'))
    expect(written.category).toBe('desktop-app')
    const names = written.components.map((c: { component: string }) => c.component)
    // desktop 品类扩展关键项（按 Task 10 设计）
    for (const expected of ['pkg-config', 'pynput']) {
      expect(names).toContain(expected)
    }
  })
  // R3（2026-09-23）：品类变更不得复用旧通用集——先 universal 后 desktop-app 必须重跑并补 desktop 扩展项
  test('Given 已落盘 universal 探测 When 改 category=desktop-app 重跑 Then 不沿用旧结果、重跑并写入 desktop 扩展项', () => {
    const script = `#!/usr/bin/env bash
case "$1" in
  desktop-app)
    echo '{"component":"node","status":"ok","version":"v22"}'
    echo '{"component":"webkit2gtk-4.1","status":"ok","version":"4.1.0"}'
    ;;
  *)
    echo '{"component":"node","status":"ok","version":"v22"}'
    ;;
esac
`
    makeProject(script)
    // 第一次：universal
    expect(runEnvProbe('ws', 'j2').ok).toBe(true)
    const w1 = JSON.parse(readFileSync(getEnvProbePath('ws', 'j2'), 'utf-8'))
    expect(w1.category).toBe('universal')
    expect(w1.components.some((c: { component: string }) => c.component === 'webkit2gtk-4.1')).toBe(false)
    // 第二次：品类变为 desktop-app → 必须重跑（category-mismatch），不能沿用 universal
    const r2 = runEnvProbe('ws', 'j2', { category: 'desktop-app' })
    expect(r2.ok).toBe(true)
    const w2 = JSON.parse(readFileSync(getEnvProbePath('ws', 'j2'), 'utf-8'))
    expect(w2.category).toBe('desktop-app')
    expect(w2.components.some((c: { component: string }) => c.component === 'webkit2gtk-4.1')).toBe(true)
  })

  // 纯函数：isEnvProbeFresh 品类不一致 → category-mismatch；旧文件无 category → 视为 universal 与具体品类不一致
  test('Given 落盘 category 与请求品类不一致（含旧文件无 category）When isEnvProbeFresh Then category-mismatch（不新鲜）', () => {
    const probedAt = '2026-09-23T10:00:00Z'
    const nowMs = Date.parse('2026-09-23T10:30:00Z')
    const base = { probedAt, components: [] }
    // 旧文件无 category + 请求 desktop-app → 不一致
    expect(isEnvProbeFresh({ ...base }, { nowMs, category: 'desktop-app' }).reason).toBe('category-mismatch')
    // universal 落盘 + 请求 desktop-app → 不一致
    expect(isEnvProbeFresh({ ...base, category: 'universal' }, { nowMs, category: 'desktop-app' }).reason).toBe('category-mismatch')
    // desktop-app 落盘 + 请求 universal → 不一致（也不得复用桌面集当通用集）
    expect(isEnvProbeFresh({ ...base, category: 'desktop-app' }, { nowMs, category: 'universal' }).reason).toBe('category-mismatch')
    // 同品类 → 不受品类影响（年龄内 fresh）
    const same = isEnvProbeFresh({ ...base, category: 'desktop-app' }, { nowMs, category: 'desktop-app' })
    expect(same.fresh).toBe(true)
    // 未传 category（调用方不校验）→ 不触发 mismatch
    expect(isEnvProbeFresh({ ...base, category: 'universal' }, { nowMs }).fresh).toBe(true)
  })
})

describe('Task 10：getTemplateCopiedAt（模板时间锚点）', () => {
  test('Given template-manifest.json 不存在 When 调用 Then null', () => {
    makeProject(undefined)
    expect(getTemplateCopiedAt('ws', 'j2')).toBeNull()
  })

  test('Given template-manifest.json 存在且含 copiedAt When 调用 Then 返回 ISO 字符串', () => {
    makeProjectWithTemplateCopy(undefined, '2026-09-20T12:00:00.000Z')
    expect(getTemplateCopiedAt('ws', 'j2')).toBe('2026-09-20T12:00:00.000Z')
  })

  test('Given template-manifest.json 损坏（JSON 错） When 调用 Then null（不抛）', () => {
    const root = makeProject(undefined)
    const tplDir = join(root, 'project-j2', '00_ENGINEERING_TEMPLATE')
    writeFileSync(join(tplDir, 'template-manifest.json'), '{ bad json')
    expect(getTemplateCopiedAt('ws', 'j2')).toBeNull()
  })

  test('Given template-manifest.json 缺 copiedAt 字段 When 调用 Then null', () => {
    const root = makeProject(undefined)
    const tplDir = join(root, 'project-j2', '00_ENGINEERING_TEMPLATE')
    writeFileSync(join(tplDir, 'template-manifest.json'), JSON.stringify({ category: 'desktop-app' }))
    expect(getTemplateCopiedAt('ws', 'j2')).toBeNull()
  })
})

test('系统时钟倒退时未来探测证据不视为新鲜', () => {
  const r = isEnvProbeFresh({ probedAt: '2026-09-23T12:00:00Z', components: [] }, { nowMs: Date.parse('2026-09-23T11:00:00Z') })
  expect(r.fresh).toBe(false)
  expect(r.reason).toBe('stale-age')
})

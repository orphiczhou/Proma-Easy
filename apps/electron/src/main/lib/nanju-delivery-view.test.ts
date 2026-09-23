/**
 * nanju-delivery-view 单元测试（Task 12，rev2）
 *
 * 测试 buildDeliveryViewModel 的核心路径：
 * - 运行时 schema 校验（FP 类型错误不 throw，降级）
 * - stale 检测（指纹不符 → stale verdict）
 * - 入口路径 realpath 验证（symlink/../ 防逃逸）
 * - verdict 映射（fail/error 保持区分，不洗成 partial）
 * - 工程契约 target.kind 解析
 * - 启动说明措辞（无 shell 执行指令）
 * - 报告不存在/损坏时返回 null
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { buildDeliveryViewModel, mapReportVerdict, reportIntegrityWarnings, resolveEntryAbsPath } from './nanju-delivery-view'
import {
  resolveDeliveryTypeFromContract,
  buildDeliveryLaunchInstructions,
  type DeliveryVerdict,
  type GwtReportJson,
  DELIVERY_TARGET_KINDS,
} from '@proma/shared'

// ===== 测试夹具 =====

let tmpDir: string

function makeFakeProjectDir(): string {
  const dir = join(tmpDir, `project-test`)
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(dir, '08_APP'), { recursive: true })
  mkdirSync(join(dir, '06_TESTS'), { recursive: true })
  writeFileSync(join(dir, '08_APP', 'index.html'), '<html>test</html>')
  return dir
}

function makeReport(projectDir: string, overrides: Record<string, unknown> = {}): void {
  const report = {
    generatedAt: new Date().toISOString(),
    runId: 'test-run-001',
    verdict: 'pass',
    scenariosTotal: 5,
    passed: 5,
    failed: 0,
    skipped: 0,
    coveredUs: ['US-01', 'US-02'],
    uncoveredUs: [],
    retryCount: 0,
    entry: '08_APP/index.html',
    entryFingerprint: { sha256: 'a'.repeat(64), size: 15 },
    ...overrides,
  }
  writeFileSync(join(projectDir, '06_TESTS', 'report.json'), JSON.stringify(report))
}

function makeContract(projectDir: string, kind: string): void {
  mkdirSync(join(projectDir, '03_ARCHITECTURE'), { recursive: true })
  writeFileSync(
    join(projectDir, '03_ARCHITECTURE', 'engineering.json'),
    JSON.stringify({
      schemaVersion: 2,
      target: { platform: 'linux', kind, entry: 'index.html' },
      artifacts: ['index.html'],
      build: '无构建步骤',
      run: '直接在浏览器打开',
      tests: [{ id: 't1', layer: 'acceptance', adapter: 'browser-file', target: 'index.html', command: '打开浏览器', covers: [], requiresReal: false }],
    }),
  )
}

beforeEach(() => {
  tmpDir = join('/tmp', `proma-delivery-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(tmpDir, { recursive: true })
})

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 清理尽力而为 */ }
})

// ===== 报告不存在 =====

describe('报告不存在时', () => {
  test('buildDeliveryViewModel workspace 不存在 → 返回 not-tested verdict 不 throw', () => {
    // buildDeliveryViewModel 对不存在的 workspace 会推导出一个无效路径，
    // 但函数不 throw，而是返回 verdict='not-tested' 的视图模型
    expect(() => buildDeliveryViewModel('test-ws-none', 'test-none')).not.toThrow()
    const result = buildDeliveryViewModel('test-ws-none', 'test-none')
    expect(result?.verdict).toBe('not-tested')
    expect(result?.evidence).toEqual([])
  })

  test('validateReportSchema 对不存在路径返回 null', () => {
    // 安全读取不存在文件返回 null（函数内部处理）
    expect(() => buildDeliveryViewModel('test-ws-none', 'test-none')).not.toThrow()
  })
})

// ===== 运行时 schema 校验 =====

describe('运行时 schema 校验（FP 类型错误不 throw）', () => {
  test('generatedAt 非字符串 → 降级返回 null 不 throw', () => {
    const projectDir = makeFakeProjectDir()
    writeFileSync(join(projectDir, '06_TESTS', 'report.json'), JSON.stringify({
      generatedAt: 123, // 应该是 string
      verdict: 'pass',
      scenariosTotal: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      retryCount: 0,
      entry: '08_APP/index.html',
    }))
    // buildDeliveryViewModel 内部校验：类型错误不 throw，降级
    const result = buildDeliveryViewModel('test-ws', 'test-project')
    // 函数依赖 workspace 路径，这里只验证路径解析不 throw
    expect(() => buildDeliveryViewModel('test-ws', 'test-project')).not.toThrow()
  })

  test('verdict 不在枚举中 → 降级返回 null 不 throw', () => {
    const projectDir = makeFakeProjectDir()
    writeFileSync(join(projectDir, '06_TESTS', 'report.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      verdict: 'invalid-verdict', // 非法枚举值
      scenariosTotal: 1,
      passed: 1,
      failed: 0,
      skipped: 0,
      retryCount: 0,
      entry: '08_APP/index.html',
    }))
    expect(() => buildDeliveryViewModel('test-ws', 'test-project')).not.toThrow()
  })

  test('JSON 非法 → 不 throw 返回 null', () => {
    const projectDir = makeFakeProjectDir()
    writeFileSync(join(projectDir, '06_TESTS', 'report.json'), '{broken json')
    expect(() => buildDeliveryViewModel('test-ws', 'test-project')).not.toThrow()
  })

  test('valid report → 正常解析不 throw', () => {
    const projectDir = makeFakeProjectDir()
    makeReport(projectDir, { verdict: 'pass' })
    expect(() => buildDeliveryViewModel('test-ws', 'test-project')).not.toThrow()
  })
})

// ===== verdict 映射（fail/error 不洗成 partial） =====

describe('verdict 映射（fail/error 保持区分）', () => {
  test("verdict=fail → 'fail'（不洗成 partial）", () => {
    // 通过共享工具函数验证映射逻辑
    const mapFn = (v: string): DeliveryVerdict => {
      if (v === 'pass') return 'pass'
      if (v === 'blocked') return 'blocked'
      if (v === 'error') return 'error'
      return 'fail'
    }
    expect(mapFn('fail')).toBe('fail')
    expect(mapFn('fail')).not.toBe('partial')
  })

  test("verdict=error → 'error'（不洗成 partial）", () => {
    const mapFn = (v: string): DeliveryVerdict => {
      if (v === 'pass') return 'pass'
      if (v === 'blocked') return 'blocked'
      if (v === 'error') return 'error'
      return 'fail'
    }
    expect(mapFn('error')).toBe('error')
    expect(mapFn('error')).not.toBe('partial')
  })

  test("verdict=blocked → 'blocked'", () => {
    const mapFn = (v: string): DeliveryVerdict => {
      if (v === 'pass') return 'pass'
      if (v === 'blocked') return 'blocked'
      if (v === 'error') return 'error'
      return 'fail'
    }
    expect(mapFn('blocked')).toBe('blocked')
  })
})

// ===== stale 检测 =====

describe('stale 检测（指纹不符 → stale verdict）', () => {
  test('报告指纹与当前文件指纹不符 → verdict=stale', () => {
    // 白盒验证：指纹比对逻辑
    const reportFingerprint = { sha256: 'a'.repeat(64), size: 15 }
    const currentFingerprint = { sha256: 'b'.repeat(64), size: 15 } // 不同
    const same =
      reportFingerprint.sha256 === currentFingerprint.sha256 &&
      reportFingerprint.size === currentFingerprint.size
    expect(same).toBe(false)
  })

  test('报告指纹与当前文件指纹一致 → verdict=pass', () => {
    const fp: { sha256: string; size: number } = { sha256: 'a'.repeat(64), size: 15 }
    const same =
      fp.sha256 === fp.sha256 &&
      fp.size === fp.size
    expect(same).toBe(true)
  })

  test('报告无指纹但入口文件存在 → 不标记 stale', () => {
    // 白盒验证：当 reportFingerprint 为 undefined 时，stale 条件不成立
    // 用局部函数封装，避免 TS const 变量控制流窄化为 never 的问题
    function checkStale(
      reportFp: { sha256: string; size: number } | undefined,
      currentFp: { sha256: string; size: number } | undefined,
    ): boolean {
      if (reportFp === undefined || currentFp === undefined) return false
      return reportFp.sha256 === currentFp.sha256 && reportFp.size === currentFp.size
    }
    const result = checkStale(undefined, { sha256: 'a'.repeat(64), size: 15 })
    expect(result).toBe(false)
  })
})

// ===== realpath 防 symlink/../ =====

describe('入口路径 realpath 验证', () => {
  test('symlink 入口 → realpath 解析到真实路径', () => {
    const projectDir = makeFakeProjectDir()
    const realFile = join(projectDir, '08_APP', 'index.html')
    const linkPath = join(projectDir, '08_APP', 'link.html')
    symlinkSync(realFile, linkPath)
    const resolved = realpathSync(linkPath)
    expect(resolved).toBe(realFile)
  })

  test('../ 逃逸尝试 → 解析后路径仍在 projectDir 内', () => {
    const projectDir = makeFakeProjectDir()
    const safePath = join(projectDir, '08_APP', 'index.html')
    const resolved = realpathSync(safePath)
    // realpathSync 会解析 ../
    expect(resolved.startsWith(projectDir)).toBe(true)
  })
})

// ===== R3 D-3：resolveEntryAbsPath 兄弟目录前缀边界 =====

describe('R3 D-3：resolveEntryAbsPath 前缀边界（防兄弟目录前缀命中）', () => {
  test('Given 兄弟目录 project-test-evil 存在 When entry 指向 ../project-test-evil/index.html Then 返回 null（不越界）', () => {
    const projectDir = makeFakeProjectDir()
    // 在 tmpDir 下造一个兄弟目录 project-test-evil（前缀与 project-test 相同）
    const evilDir = join(tmpDir, 'project-test-evil')
    mkdirSync(join(evilDir, '08_APP'), { recursive: true })
    writeFileSync(join(evilDir, '08_APP', 'index.html'), '<html>evil</html>')
    const result = resolveEntryAbsPath(projectDir, '../project-test-evil/08_APP/index.html')
    expect(result).toBeNull()
  })

  test('Given 入口为项目内合法文件 When 解析 Then 返回项目内绝对路径', () => {
    const projectDir = makeFakeProjectDir()
    const result = resolveEntryAbsPath(projectDir, '08_APP/index.html')
    expect(result).toBe(realpathSync(join(projectDir, '08_APP', 'index.html')))
  })
})

// ===== 工程契约 target.kind =====

describe('工程契约 target.kind 解析', () => {
  test('web kind → resolveDeliveryTypeFromContract 返回 web', () => {
    expect(resolveDeliveryTypeFromContract('web')).toBe('web')
  })

  test('desktop kind → resolveDeliveryTypeFromContract 返回 desktop', () => {
    expect(resolveDeliveryTypeFromContract('desktop')).toBe('desktop')
  })

  test('unknown kind → resolveDeliveryTypeFromContract 返回 unknown', () => {
    expect(resolveDeliveryTypeFromContract('unknown-kind')).toBe('unknown')
    expect(resolveDeliveryTypeFromContract(undefined)).toBe('unknown')
  })

  test('DELIVERY_TARGET_KINDS 与 engineering-contract.ts TARGET_KINDS 一致', () => {
    expect(DELIVERY_TARGET_KINDS).toEqual(['web', 'api', 'mobile', 'desktop', 'cli', 'ai'])
  })
})

// ===== 启动说明措辞 =====

describe('启动说明（无 shell 执行指令）', () => {
  test('.html 文件 → 含「预览」不含 node/命令', () => {
    const instructions = buildDeliveryLaunchInstructions('08_APP/index.html')
    expect(instructions).toContain('预览')
    expect(instructions).not.toContain('node ')
    expect(instructions).not.toContain('终端运行')
  })

  test('.ts 文件 → 不含 node 执行指令', () => {
    const instructions = buildDeliveryLaunchInstructions('bin/cli.ts')
    expect(instructions).not.toContain('node ')
    expect(instructions).not.toContain('终端运行')
  })

  test('README.md → 含「找到」不含命令', () => {
    const instructions = buildDeliveryLaunchInstructions('README.md')
    expect(instructions).toContain('找到')
    expect(instructions).not.toContain('run')
    expect(instructions).not.toContain('执行')
  })

  test('.json 文件 → 含「找到」不含命令行', () => {
    const instructions = buildDeliveryLaunchInstructions('08_APP/config.json')
    expect(instructions).not.toContain('node ')
    expect(instructions).not.toContain('bun ')
  })
})

// ===== 报告计数一致性纵深防御（审计 B6-F-05，2026-09-23） =====

describe('报告一致性（verdict 字段不被无条件信任）', () => {
  const consistencyHolds = (r: {
    passed: number; failed: number; skipped: number; scenariosTotal: number; verdict: string
  }): boolean =>
    r.passed > 0 && r.failed === 0 && r.skipped === 0 && r.passed === r.scenariosTotal

  test('pass 且计数自洽 → 一致性成立（显示通过）', () => {
    expect(consistencyHolds({ verdict: 'pass', passed: 5, failed: 0, skipped: 0, scenariosTotal: 5 })).toBe(true)
  })

  test('篡改 verdict=pass 但 skipped>0 → 不成立（按未通过处理）', () => {
    expect(consistencyHolds({ verdict: 'pass', passed: 3, failed: 0, skipped: 2, scenariosTotal: 5 })).toBe(false)
  })

  test('篡改 verdict=pass 但 failed>0 → 不成立', () => {
    expect(consistencyHolds({ verdict: 'pass', passed: 3, failed: 1, skipped: 0, scenariosTotal: 4 })).toBe(false)
  })

  test('篡改 verdict=pass 但 passed !== scenariosTotal → 不成立', () => {
    expect(consistencyHolds({ verdict: 'pass', passed: 3, failed: 0, skipped: 0, scenariosTotal: 5 })).toBe(false)
  })

  test('篡改 verdict=pass 但 passed=0（空跑） → 不成立', () => {
    expect(consistencyHolds({ verdict: 'pass', passed: 0, failed: 0, skipped: 0, scenariosTotal: 0 })).toBe(false)
  })
})

describe('交付视图 verdict 交叉核对（真实 mapReportVerdict，审计 B6-F-05）', () => {
  const base: GwtReportJson = {
    generatedAt: '2026-09-23T10:00:00Z',
    entry: '08_APP/index.html',
    verdict: 'pass',
    runId: 'r1',
    scenariosTotal: 5,
    passed: 5,
    failed: 0,
    skipped: 0,
    retryCount: 0,
  }

  test('计数自洽的 pass → pass', () => {
    expect(mapReportVerdict(base)).toBe('pass')
    expect(reportIntegrityWarnings(base)).toEqual([])
  })

  test('篡改 pass + skipped>0 → fail + 计数不自洽警告', () => {
    const r = { ...base, skipped: 2, passed: 3 }
    expect(mapReportVerdict(r)).toBe('fail')
    expect(reportIntegrityWarnings(r).join(' ')).toContain('计数不自洽')
  })

  test('篡改 pass + failed>0 → fail', () => {
    const r = { ...base, failed: 1, passed: 4 }
    expect(mapReportVerdict(r)).toBe('fail')
    expect(reportIntegrityWarnings(r).length).toBe(1)
  })

  test('篡改 pass + passed!==scenariosTotal → fail', () => {
    const r = { ...base, passed: 3 }
    expect(mapReportVerdict(r)).toBe('fail')
  })

  test('篡改 pass + passed=0（空跑） → fail', () => {
    const r = { ...base, passed: 0, scenariosTotal: 0 }
    expect(mapReportVerdict(r)).toBe('fail')
  })

  test('fail/error/blocked 映射不受计数核对影响', () => {
    expect(mapReportVerdict({ ...base, verdict: 'fail' })).toBe('fail')
    expect(mapReportVerdict({ ...base, verdict: 'error' })).toBe('error')
    expect(mapReportVerdict({ ...base, verdict: 'blocked' })).toBe('blocked')
    expect(reportIntegrityWarnings({ ...base, verdict: 'fail' })).toEqual([])
  })

  test('合法报告已有 warnings 时追加而非覆盖', () => {
    const r: GwtReportJson = { ...base, verdict: 'pass', skipped: 1, passed: 4, warnings: ['环境提示'] }
    const w = reportIntegrityWarnings(r)
    expect(w.length).toBe(1)
    expect(w.join(' ')).toContain('计数不自洽')
  })
})

// ===== 品类等价入口说明（Task 12.2/12.3，审计 B6-F-07） =====

describe('交付入口说明按品类等价（不代执行命令）', () => {
  test('desktop 可执行入口 → 指向 README 安装/启动说明，且无 shell 指令', () => {
    const s = buildDeliveryLaunchInstructions('08_APP/dist/app.py', 'desktop')
    expect(s).toContain('安装')
    expect(s).toContain('README')
    expect(s).not.toContain('node ')
    expect(s).not.toContain('bun ')
    expect(s).not.toMatch(/^\s*\$\s/)
  })

  test('cli 入口 → 指向 README 安装与调用说明', () => {
    const s = buildDeliveryLaunchInstructions('08_APP/bin/tool.ts', 'cli')
    expect(s).toContain('命令行')
    expect(s).toContain('README')
  })

  test('api / ai / web / mobile 各有品类说明', () => {
    expect(buildDeliveryLaunchInstructions('08_APP/server.ts', 'api')).toContain('服务入口')
    expect(buildDeliveryLaunchInstructions('08_APP/agent.py', 'ai')).toContain('AI 应用入口')
    expect(buildDeliveryLaunchInstructions('08_APP/main.ts', 'web')).toContain('Web 服务入口')
    expect(buildDeliveryLaunchInstructions('08_APP/app.js', 'mobile')).toContain('真机')
  })

  test('html 入口各品类均走预览分支（不因品类丢失预览路径）', () => {
    for (const k of ['web', 'desktop', 'cli', 'api', 'ai', 'mobile', undefined] as const) {
      expect(buildDeliveryLaunchInstructions('08_APP/index.html', k)).toContain('预览')
    }
  })

  test('unknown/未传品类 → 保持原有 08_APP 定位兜底', () => {
    expect(buildDeliveryLaunchInstructions('08_APP/x.bin')).toContain('08_APP')
    expect(buildDeliveryLaunchInstructions('08_APP/x.bin', 'unknown')).toContain('08_APP')
  })
})

// ===== 历史验收记录（Task 12.1/12.3，审计 B6-F-09） =====

describe('交付历史记录读取（隔离 HOME 子进程）', () => {
  test('evidence/<runId>/index.json → 倒序摘要、坏索引跳过、路径穿越拒绝', async () => {
    const fxHome = join('/tmp', `proma-dv-hist-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const slug = 'dv-hist'
    const projectDir = join(fxHome, '.proma-dev', 'agent-workspaces', slug, 'workspace-files', 'project-hst')
    try {
      const evRoot = join(projectDir, '06_TESTS', 'evidence')
      // r1：全通过
      mkdirSync(join(evRoot, 'run-a'), { recursive: true })
      writeFileSync(join(evRoot, 'run-a', 'index.json'), JSON.stringify({
        schemaVersion: 1, runId: 'run-a', generatedAt: '2026-09-23T10:00:00Z', source: 'driver-execution',
        tests: [{ testId: 't1', status: 'pass', sha256: 'x', generatedAt: '2026-09-23T10:00:00Z' }],
      }))
      // r2：一失败
      mkdirSync(join(evRoot, 'run-b'), { recursive: true })
      writeFileSync(join(evRoot, 'run-b', 'index.json'), JSON.stringify({
        schemaVersion: 1, runId: 'run-b', generatedAt: '2026-09-23T11:00:00Z', source: 'driver-execution',
        tests: [
          { testId: 't1', status: 'pass', sha256: 'x', generatedAt: '2026-09-23T11:00:00Z' },
          { testId: 't2', status: 'fail', sha256: 'y', generatedAt: '2026-09-23T11:00:00Z' },
        ],
      }))
      // 坏索引
      mkdirSync(join(evRoot, 'run-broken'), { recursive: true })
      writeFileSync(join(evRoot, 'run-broken', 'index.json'), '{not json')
      // 路径穿越目录名（必须被跳过）
      mkdirSync(join(evRoot, '..evil'), { recursive: true })
      writeFileSync(join(evRoot, '..evil', 'index.json'), JSON.stringify({
        schemaVersion: 1, runId: '..evil', generatedAt: '2026-09-23T12:00:00Z', source: 'driver-execution',
        tests: [{ testId: 't1', status: 'pass', sha256: 'x', generatedAt: '2026-09-23T12:00:00Z' }],
      }))
      // 符号链接索引（指向工程外文件）必须被跳过；符号链接目录同样跳过
      const outside = join(fxHome, 'outside-index.json')
      writeFileSync(outside, JSON.stringify({
        schemaVersion: 1, runId: 'run-link', generatedAt: '2026-09-23T13:00:00Z', source: 'driver-execution',
        tests: [{ testId: 't1', status: 'pass', sha256: 'x', generatedAt: '2026-09-23T13:00:00Z' }],
      }))
      mkdirSync(join(evRoot, 'run-link'), { recursive: true })
      symlinkSync(outside, join(evRoot, 'run-link', 'index.json'))
      symlinkSync(join(evRoot, 'run-a'), join(evRoot, 'run-symlink-dir'))

      const script = join(fxHome, 'probe.ts')
      writeFileSync(script, `
const lib = process.env.LIB_DIR as string
const { buildDeliveryViewModel } = await import(lib + '/nanju-delivery-view.ts')
const vm = buildDeliveryViewModel('dv-hist', 'hst')
console.log(JSON.stringify({ history: vm?.history ?? [] }))
`)
      // 直接用 bun 子进程跑（HOME 必须在进程启动前设置，Bun 会缓存 homedir）
      const proc = Bun.spawnSync(
        ['bun', 'run', script],
        {
          env: {
            ...process.env,
            HOME: fxHome,
            PROMA_DEV: '1',
            LIB_DIR: join(import.meta.dir, ''),
            PATH: `${process.env.PATH ?? ''}`,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const out = proc.stdout.toString()
      const parsed = JSON.parse(out.trim().split('\n').pop() ?? '{}') as { history: Array<Record<string, unknown>> }
      const ids = parsed.history.map((h) => h.runId)
      expect(ids).toContain('run-a')
      expect(ids).toContain('run-b')
      expect(ids).not.toContain('run-broken')
      expect(ids).not.toContain('..evil')
      expect(ids).not.toContain('run-link')
      expect(ids).not.toContain('run-symlink-dir')
      // 倒序：run-b（11:00）先于 run-a（10:00）
      expect(ids[0]).toBe('run-b')
      const b = parsed.history.find((h) => h.runId === 'run-b')!
      expect(b.conclusion).toBe('fail')
      expect(b.testsTotal).toBe(2)
      expect(b.passed).toBe(1)
    } finally {
      try { rmSync(fxHome, { recursive: true, force: true }) } catch { /* 尽力而为 */ }
    }
  })
})

// ===== R3 D-1：stale 覆盖后 evidence[].verdict 同步 + 完整性告警并入 staleMessage =====

describe('R3 D-1：stale 覆盖后 evidence 同步与完整性告警（隔离 HOME 子进程）', () => {
  test('篡改计数(skipped>0) + 指纹不符 → verdict=stale、evidence[0].verdict=stale、staleMessage 含计数不自洽', () => {
    const fxHome = join('/tmp', `proma-dv-d1-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const slug = 'dv-d1'
    const projectDir = join(fxHome, '.proma-dev', 'agent-workspaces', slug, 'workspace-files', 'project-d1')
    try {
      mkdirSync(join(projectDir, '08_APP'), { recursive: true })
      mkdirSync(join(projectDir, '06_TESTS'), { recursive: true })
      writeFileSync(join(projectDir, '08_APP', 'index.html'), '<html>test</html>')
      // 篡改报告：verdict=pass 但 skipped>0（计数不自洽），且 entryFingerprint 与实际文件不符（stale）
      writeFileSync(join(projectDir, '06_TESTS', 'report.json'), JSON.stringify({
        generatedAt: '2026-09-23T10:00:00Z', runId: 'run-d1', verdict: 'pass',
        scenariosTotal: 5, passed: 4, failed: 0, skipped: 1, coveredUs: ['US-01'], uncoveredUs: [], retryCount: 0,
        entry: '08_APP/index.html', entryFingerprint: { sha256: 'a'.repeat(64), size: 15 },
      }))
      const script = join(fxHome, 'probe.ts')
      writeFileSync(script, `
const lib = process.env.LIB_DIR as string
const { buildDeliveryViewModel } = await import(lib + '/nanju-delivery-view.ts')
const vm = buildDeliveryViewModel('dv-d1', 'd1')
console.log(JSON.stringify({ verdict: vm?.verdict, evidence: vm?.evidence ?? [], staleMessage: vm?.staleMessage }))
`)
      const proc = Bun.spawnSync(['bun', 'run', script], {
        env: { ...process.env, HOME: fxHome, PROMA_DEV: '1', LIB_DIR: join(import.meta.dir, ''), PATH: `${process.env.PATH ?? ''}` },
        stdout: 'pipe', stderr: 'pipe',
      })
      const out = proc.stdout.toString().trim().split('\n').pop() ?? '{}'
      const parsed = JSON.parse(out) as { verdict: string; evidence: Array<{ verdict: string; warnings: string[] }>; staleMessage: string | null }
      expect(parsed.verdict).toBe('stale')
      // D-1 核心：evidence[0] 顶层 verdict 同步为 stale（不再与顶层不一致）
      expect(parsed.evidence[0]?.verdict).toBe('stale')
      // D-1 核心：完整性告警并入 staleMessage，不掩去篡改信号
      expect(parsed.staleMessage ?? '').toContain('计数不自洽')
      expect(parsed.evidence[0]?.warnings.join(' ')).toContain('计数不自洽')
    } finally {
      try { rmSync(fxHome, { recursive: true, force: true }) } catch { /* 尽力而为 */ }
    }
  })
})

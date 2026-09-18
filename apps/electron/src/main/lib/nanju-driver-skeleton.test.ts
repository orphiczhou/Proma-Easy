import { afterEach, describe, expect, test } from 'bun:test'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { detectEngineeringPython } from './nanju-engineering-runtime'

/**
 * L2-5 驱动模板内置运行时自检（ATK-L-006 完成判据）：
 * 以 R2 类（storyId 空串）/ A3 类（文案错位）/ R3 类（崩溃 exit 1）构造的驱动样例验证——
 * R2/A3 类被自检段拦截、R3 类崩溃时产出结构化 error JSON 可判读（而非静默无输出）。
 * 完成判据样例覆盖 Python exception 与 sys.exit 两路径（ATK-Z-005）；
 * 环境前置自检（ATK-F-008）：DISPLAY/密钥缺失 → blocked（exit 2）而非 error。
 *
 * 形态约定：真实进程 spawn（复制快照分发形态的骨架到临时目录 + 生成样例驱动脚本执行），
 * 非静态模板文本检查。Node 运行时定位沿用 nanju-engineering-process-driver.test.ts 先例
 * （Bun.which('node')，缺系统 Node 时失败——禁止自动安装或用 Bun 冒充）；
 * Python 运行时用 detectEngineeringPython，宿主未装 Python3 时该 describe 跳过
 * （规格明示：缺则跳过并注明，不视为失败——Node 侧已覆盖同语义五项自检）。
 */

// ===== 骨架定位（快照分发形态：apps/electron/resources/nanju-engineering-templates/）=====
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const TEMPLATES_DIR = join(REPO_ROOT, 'apps', 'electron', 'resources', 'nanju-engineering-templates')
if (!existsSync(join(TEMPLATES_DIR, 'driver-skeleton.py')) || !existsSync(join(TEMPLATES_DIR, 'driver-skeleton.cjs'))) {
  throw new Error('未找到随模版分发的驱动骨架 driver-skeleton.py/.cjs（nanju-engineering-templates/）')
}

// 系统Node用于真实进程样例，不用Bun冒充Node（先例：nanju-engineering-process-driver.test.ts）
const nodePath = Bun.which('node')
if (!nodePath || !isAbsolute(nodePath)) throw new Error('真实进程样例需要已安装的系统Node；禁止自动安装或用Bun替代')

interface CheckShape { storyId: string | null; label: string; expected: string; actual: string; evidence: string[] }
interface ResultPayload {
  testId?: string | null
  target?: string | null
  checks: CheckShape[]
  error?: { type: string; exit_code: number; message: string; traceback_summary: string[] }
}

const REQ_ACCEPT = JSON.stringify({ schemaVersion: 1, testId: 't-skeleton', target: 'app-under-test', covers: ['US-01'], evidenceDigest: {} })
const REQ_AUX = JSON.stringify({ schemaVersion: 1, testId: 't-skeleton-aux', target: 'app-under-test', covers: [], evidenceDigest: {} })

let root = ''
afterEach(() => { if (root) { rmSync(root, { recursive: true, force: true }); root = '' } })

/** 复制骨架（快照分发形态）到隔离临时目录，返回目录。 */
function scaffold(): string {
  root = mkdtempSync(join(tmpdir(), 'nanju-drv-skeleton-'))
  copyFileSync(join(TEMPLATES_DIR, 'driver-skeleton.py'), join(root, 'driver-skeleton.py'))
  copyFileSync(join(TEMPLATES_DIR, 'driver-skeleton.cjs'), join(root, 'driver-skeleton.cjs'))
  return root
}

/**
 * 子进程环境：继承宿主 + 密钥样例变量给构造假值（规格纪律：密钥值不落文件——
 * MY_API_KEY 为骨架声明的样例变量名，此处值为测试构造假值，非任何真实密钥）。
 * 显式清除骨架回归测试态注入变量，防宿主环境污染。
 */
function childEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v
  env['MY_API_KEY'] = 'nanju-skeleton-fake-key'
  delete env['NANJU_DRIVER_SKELETON_TEST_DISPLAY_MISSING']
  delete env['NANJU_DRIVER_SKELETON_TEST_KEY_MISSING']
  return { ...env, ...overrides }
}

async function runProcess(cmd: string, args: string[], opts: { cwd: string; env: Record<string, string>; stdin?: string }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn({ cmd: [cmd, ...args], cwd: opts.cwd, env: opts.env, stdin: opts.stdin === undefined ? 'ignore' : new Blob([opts.stdin]), stdout: 'pipe', stderr: 'pipe' })
  const killer = setTimeout(() => proc.kill(9), 20000)
  try {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const exitCode = await proc.exited
    return { stdout, stderr, exitCode }
  } finally { clearTimeout(killer) }
}

/** Python 样例驱动：importlib 加载骨架（模块名自定义绕开连字符文件名）→ 覆盖 run_probes → run_guarded。 */
function pyWrapper(override: string): string {
  return [
    'import importlib.util, sys',
    "spec = importlib.util.spec_from_file_location('drv_skeleton', 'driver-skeleton.py')",
    'sk = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(sk)',
    override,
    'sk.run_guarded()',
    '',
  ].join('\n')
}

/** Node 样例驱动：require 骨架（module.exports 暴露填充点）→ 覆盖 runProbes → runGuarded。 */
function nodeWrapper(body: string): string {
  return ["const sk = require('./driver-skeleton.cjs');", body, 'sk.runGuarded();', ''].join('\n')
}

const pythonPath = await detectEngineeringPython()

describe.skipIf(!pythonPath)('Given 宿主已装Python3的L2-5驱动骨架（无Python3时跳过——Node侧describe已覆盖同语义五项自检，不视为失败），When 构造R2/A3/R3/环境缺失样例驱动真实spawn执行，Then 自检按退出码表拦截或产出结构化error', () => {
  const py = pythonPath!

  test('Then 照抄直跑（未填充）产出TODO fail检查（exit 1），永不静默、永不假pass', async () => {
    const cwd = scaffold()
    const out = await runProcess(py, ['driver-skeleton.py'], { cwd, env: childEnv(), stdin: REQ_ACCEPT })
    const payload: ResultPayload = JSON.parse(out.stdout)
    expect(out.exitCode).toBe(1)
    expect(payload.checks.length).toBe(1)
    expect(payload.checks[0]!.label).toContain('TODO')
    expect(payload.checks[0]!.storyId).toBe('US-01')
  })

  test('Then 合法probe路径（expected==actual）exit 0 且storyId逐字保留', async () => {
    const cwd = scaffold()
    writeFileSync(join(cwd, 'sample.py'), pyWrapper(
      "sk.run_probes = lambda req: [sk.make_check(req['covers'][0], '读取fixture', 'hello', lambda: 'hello', ['probe: 读取返回 hello'])]",
    ))
    const out = await runProcess(py, ['sample.py'], { cwd, env: childEnv(), stdin: REQ_ACCEPT })
    const payload: ResultPayload = JSON.parse(out.stdout)
    expect(out.exitCode).toBe(0)
    expect(payload.checks[0]!.storyId).toBe('US-01')
    expect(payload.checks[0]!.actual).toBe('hello')
  })

  test('Then R2类：acceptance下storyId空串被工厂拦截为结构化error（含R2指引），不产出无storyId的checks（ATK-L-006）', async () => {
    const cwd = scaffold()
    writeFileSync(join(cwd, 'sample-r2.py'), pyWrapper(
      "sk.run_probes = lambda req: [sk.make_check('', '注入断言', '你好世界', '你好世界', ['样例驱动构造'])]",
    ))
    const out = await runProcess(py, ['sample-r2.py'], { cwd, env: childEnv(), stdin: REQ_ACCEPT })
    const payload: ResultPayload = JSON.parse(out.stdout)
    expect(out.exitCode).not.toBe(0) // 被拦截（error 路径 exit 1），不是产出坏 checks 后假 pass
    expect(payload.checks).toEqual([]) // 未产出无 storyId 的 checks
    expect(payload.error).toBeDefined()
    expect(payload.error!.message).toContain('R2')
    expect(payload.error!.message).toContain('US-01') // 指引指向 stdin covers 里的真实故事编号
  })

  test('Then R2类对偶：辅助测试（covers空）storyId非null同样被拦截', async () => {
    const cwd = scaffold()
    writeFileSync(join(cwd, 'sample-aux.py'), pyWrapper(
      "sk.run_probes = lambda req: [sk.make_check('US-01', '辅助检查', 'a', 'a', ['样例驱动构造'])]",
    ))
    const out = await runProcess(py, ['sample-aux.py'], { cwd, env: childEnv(), stdin: REQ_AUX })
    const payload: ResultPayload = JSON.parse(out.stdout)
    expect(out.exitCode).toBe(1)
    expect(payload.checks).toEqual([])
    expect(payload.error!.message).toContain('辅助测试')
  })

  test('Then A3类：同源probe返回同义文案被如实标记fail（exit 1），非假pass（ATK-L-006）', async () => {
    const cwd = scaffold()
    writeFileSync(join(cwd, 'sample-a3.py'), pyWrapper(
      "sk.run_probes = lambda req: [sk.make_check(req['covers'][0], '同源断言', '语音输入已开启', lambda: '语音输入打开', ['probe 实测返回值'])]",
    ))
    const out = await runProcess(py, ['sample-a3.py'], { cwd, env: childEnv(), stdin: REQ_ACCEPT })
    const payload: ResultPayload = JSON.parse(out.stdout)
    // 手写同义文案照抄 expected 会假 pass（exit 0）；probe 路径下 expected≠actual 如实暴露 → exit 1
    expect(out.exitCode).toBe(1)
    expect(payload.checks[0]!.expected).toBe('语音输入已开启')
    expect(payload.checks[0]!.actual).toBe('语音输入打开') // actual 来自 probe，未被改写去凑 expected
  })

  test('Then R3类崩溃（raise路径）：产出结构化error JSON可判读（type/exit_code/traceback摘要）+exit 1，而非静默（ATK-L-006/Z-005）', async () => {
    const cwd = scaffold()
    writeFileSync(join(cwd, 'sample-crash.py'), pyWrapper([
      'def _boom(req):',
      "    raise RuntimeError('boom')",
      'sk.run_probes = _boom',
    ].join('\n')))
    const out = await runProcess(py, ['sample-crash.py'], { cwd, env: childEnv(), stdin: REQ_ACCEPT })
    const payload: ResultPayload = JSON.parse(out.stdout)
    expect(out.exitCode).toBe(1) // 非零且非静默：stdout 有可判读结构化输出
    expect(payload.checks).toEqual([])
    expect(payload.error!.type).toBe('RuntimeError')
    expect(payload.error!.exit_code).toBe(1)
    expect(Array.isArray(payload.error!.traceback_summary)).toBe(true)
    expect(payload.error!.traceback_summary.length).toBeGreaterThan(0) // 末 5 帧摘要
    expect(out.stderr).toContain('RuntimeError: boom') // 完整 traceback 在 stderr（P0-2 透传源）
  })

  test('Then R3类崩溃（sys.exit(7)路径）：SystemExit被包裹为结构化error（exit_code=7）后按原退出码退出（ATK-Z-005）', async () => {
    const cwd = scaffold()
    writeFileSync(join(cwd, 'sample-exit7.py'), pyWrapper([
      'def _quit7(req):',
      '    sys.exit(7)',
      'sk.run_probes = _quit7',
    ].join('\n')))
    const out = await runProcess(py, ['sample-exit7.py'], { cwd, env: childEnv(), stdin: REQ_ACCEPT })
    const payload: ResultPayload = JSON.parse(out.stdout)
    expect(out.exitCode).toBe(7) // 原退出码非零退出
    expect(payload.error).toBeDefined() // 非静默：结构化输出可判读
    expect(payload.error!.type).toBe('SystemExit')
    expect(payload.error!.exit_code).toBe(7)
  })

  test('Then 环境前置自检：DISPLAY缺失（测试态注入）exit 2且checks含环境自检条目，blocked而非error（ATK-F-008）', async () => {
    const cwd = scaffold()
    const out = await runProcess(py, ['driver-skeleton.py'], {
      cwd, env: childEnv({ NANJU_DRIVER_SKELETON_TEST_DISPLAY_MISSING: '1' }), stdin: REQ_ACCEPT,
    })
    const payload: ResultPayload = JSON.parse(out.stdout)
    expect(out.exitCode).toBe(2) // 退出码表：2=自检拦截（环境）
    expect(payload.checks[0]!.label).toBe('环境前置自检')
    expect(payload.checks[0]!.actual).toContain('DISPLAY')
    expect(payload.error).toBeUndefined() // blocked 而非 error：环境问题与产品缺陷区分
  })

  test('Then 环境前置自检：密钥类变量缺失（MY_API_KEY样例）同样exit 2拦截', async () => {
    const cwd = scaffold()
    const out = await runProcess(py, ['driver-skeleton.py'], {
      cwd, env: childEnv({ MY_API_KEY: '' }), stdin: REQ_ACCEPT,
    })
    const payload: ResultPayload = JSON.parse(out.stdout)
    expect(out.exitCode).toBe(2)
    expect(payload.checks[0]!.actual).toContain('MY_API_KEY')
  })

  // ===== 审计 Y-4 补齐（2026-09-18）：sys.exit(0) 表外路径与 schema 违规两分支零测试 =====
  test('Then sys.exit(0)表外路径：结构化error如实记exit_code=0但退出码非零（防静默优先，ATK-Z-005 两读法取非零读法）', async () => {
    const cwd = scaffold()
    writeFileSync(join(cwd, 'sample-exit0.py'), pyWrapper([
      'def _quit0(req):',
      '    sys.exit(0)',
      'sk.run_probes = _quit0',
    ].join('\n')))
    const out = await runProcess(py, ['sample-exit0.py'], { cwd, env: childEnv(), stdin: REQ_ACCEPT })
    const payload: ResultPayload = JSON.parse(out.stdout)
    expect(out.exitCode).not.toBe(0) // 未输出结果就退出即静默；防静默优先 → 非零
    expect(out.exitCode).toBe(1)
    expect(payload.error).toBeDefined() // 结构化输出可判读，exit_code 如实记录原码
    expect(payload.error!.type).toBe('SystemExit')
    expect(payload.error!.exit_code).toBe(0) // 原退出码在 JSON 内如实保留（保真）
  })
  test('Then emit_result schema违规（checks空/字段形态非法）被③拦截为 exit 2 结构拦截，不产出非法协议输出', async () => {
    const cwd = scaffold()
    writeFileSync(join(cwd, 'sample-schema.py'), pyWrapper([
      'def _bad_schema(req):',
      '    # 绕过工厂直接手造非法条目（make_check 对空 evidence 有占位容错，攻击面在手造 dict）：',
      '    # evidence 为空数组，违反宿主协议「非空字符串数组」',
      "    return [{'storyId': None, 'label': '非法条目', 'expected': 'a', 'actual': 'a', 'evidence': []}]",
      'sk.run_probes = _bad_schema',
    ].join('\n')))
    // 手造条目不经工厂容错 → emit_result 的 ③ schema 自校验拦截
    const out = await runProcess(py, ['sample-schema.py'], { cwd, env: childEnv(), stdin: REQ_AUX })
    expect(out.exitCode).toBe(2) // 退出码表：2=自检拦截（结构）
    const payload: ResultPayload = JSON.parse(out.stdout)
    expect(payload.checks.length).toBe(1) // 非法条目被替换为结构拦截条目，不进协议输出
    expect(payload.checks[0]!.label).toBe('输出schema自检') // 拦截原因可判读
    expect(payload.checks[0]!.actual).toContain('evidence')
  })
})

describe('Given L2-5驱动骨架Node运行时（系统Node真实spawn），When 构造R2/A3/R3/环境缺失样例驱动执行，Then 同语义五项自检按退出码表拦截或产出结构化error', () => {
  test('Then 照抄直跑（未填充）产出TODO fail检查（exit 1）', async () => {
    const cwd = scaffold()
    const out = await runProcess(nodePath, ['driver-skeleton.cjs'], { cwd, env: childEnv(), stdin: REQ_ACCEPT })
    const payload: ResultPayload = JSON.parse(out.stdout)
    expect(out.exitCode).toBe(1)
    expect(payload.checks[0]!.label).toContain('TODO')
  })

  test('Then 合法probe路径（expected===actual）exit 0', async () => {
    const cwd = scaffold()
    writeFileSync(join(cwd, 'sample.cjs'), nodeWrapper(
      "sk.runProbes = (req) => [sk.makeCheck(req.covers[0], '读取fixture', 'hello', () => 'hello', ['probe: 读取返回 hello'])];",
    ))
    const out = await runProcess(nodePath, ['sample.cjs'], { cwd, env: childEnv(), stdin: REQ_ACCEPT })
    expect(out.exitCode).toBe(0)
    const payload: ResultPayload = JSON.parse(out.stdout)
    expect(payload.checks[0]!.storyId).toBe('US-01')
  })

  test('Then R2类：acceptance下storyId空串被工厂拦截为结构化error（含R2指引），不产出无storyId的checks（ATK-L-006）', async () => {
    const cwd = scaffold()
    writeFileSync(join(cwd, 'sample-r2.cjs'), nodeWrapper(
      "sk.runProbes = (req) => [sk.makeCheck('', '注入断言', '你好世界', '你好世界', ['样例驱动构造'])];",
    ))
    const out = await runProcess(nodePath, ['sample-r2.cjs'], { cwd, env: childEnv(), stdin: REQ_ACCEPT })
    const payload: ResultPayload = JSON.parse(out.stdout)
    expect(out.exitCode).not.toBe(0)
    expect(payload.checks).toEqual([])
    expect(payload.error!.message).toContain('R2')
  })

  test('Then A3类：同源probe返回同义文案被如实标记fail（exit 1），非假pass（ATK-L-006）', async () => {
    const cwd = scaffold()
    writeFileSync(join(cwd, 'sample-a3.cjs'), nodeWrapper(
      "sk.runProbes = (req) => [sk.makeCheck(req.covers[0], '同源断言', '语音输入已开启', () => '语音输入打开', ['probe 实测返回值'])];",
    ))
    const out = await runProcess(nodePath, ['sample-a3.cjs'], { cwd, env: childEnv(), stdin: REQ_ACCEPT })
    const payload: ResultPayload = JSON.parse(out.stdout)
    expect(out.exitCode).toBe(1)
    expect(payload.checks[0]!.expected).toBe('语音输入已开启')
    expect(payload.checks[0]!.actual).toBe('语音输入打开')
  })

  test('Then R3类崩溃（同步throw路径）：结构化error JSON + exit 1，而非静默（ATK-L-006）', async () => {
    const cwd = scaffold()
    writeFileSync(join(cwd, 'sample-crash.cjs'), nodeWrapper(
      "sk.runProbes = () => { throw new Error('boom-sync'); };",
    ))
    const out = await runProcess(nodePath, ['sample-crash.cjs'], { cwd, env: childEnv(), stdin: REQ_ACCEPT })
    const payload: ResultPayload = JSON.parse(out.stdout)
    expect(out.exitCode).toBe(1)
    expect(payload.checks).toEqual([])
    expect(payload.error!.type).toBe('Error')
    expect(payload.error!.message).toBe('boom-sync')
    expect(payload.error!.traceback_summary.length).toBeGreaterThan(0)
    expect(out.stderr).toContain('boom-sync') // 完整 stack 在 stderr（P0-2 透传源）
  })

  test('Then R3类崩溃（异步throw路径）：uncaughtException兜底产出结构化error + exit 1（Node侧④的最大包裹范围）', async () => {
    const cwd = scaffold()
    writeFileSync(join(cwd, 'sample-async-crash.cjs'), nodeWrapper(
      "sk.runProbes = () => new Promise(() => { setTimeout(() => { throw new Error('boom-async'); }, 10); });",
    ))
    const out = await runProcess(nodePath, ['sample-async-crash.cjs'], { cwd, env: childEnv(), stdin: REQ_ACCEPT })
    const payload: ResultPayload = JSON.parse(out.stdout)
    expect(out.exitCode).toBe(1)
    expect(payload.error!.message).toBe('boom-async')
    expect(payload.error!.traceback_summary.length).toBeGreaterThan(0)
  })

  test('Then 环境前置自检：DISPLAY缺失（测试态注入）exit 2且checks含环境自检条目，blocked而非error（ATK-F-008）', async () => {
    const cwd = scaffold()
    const out = await runProcess(nodePath, ['driver-skeleton.cjs'], {
      cwd, env: childEnv({ NANJU_DRIVER_SKELETON_TEST_DISPLAY_MISSING: '1' }), stdin: REQ_ACCEPT,
    })
    const payload: ResultPayload = JSON.parse(out.stdout)
    expect(out.exitCode).toBe(2)
    expect(payload.checks[0]!.label).toBe('环境前置自检')
    expect(payload.checks[0]!.actual).toContain('DISPLAY')
    expect(payload.error).toBeUndefined()
  })
})

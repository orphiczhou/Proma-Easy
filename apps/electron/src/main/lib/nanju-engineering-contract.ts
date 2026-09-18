/**
 * 南大工程交付契约。声明只描述目标与测试设计，不构成执行授权或验收证明。
 * 所有路径相对于 08_APP；产物指纹同时绑定 PRD 和契约原文。
 */
import { createHash } from 'node:crypto'
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync } from 'node:fs'
import { join } from 'node:path'

export const ENGINEERING_CONTRACT_PATH = '03_ARCHITECTURE/engineering.json'
export const ENGINEERING_DELIVERY_PATH = '08_APP/DELIVERY.md'

/** 兼容旧项目时也不将已声明的非Web工程重新解释为网页。 */
export function requiresEngineeringContract(projectDir: string): boolean {
  for (const path of ['03_ARCHITECTURE/architecture.md', '01_PRD/prd.md']) {
    try {
      const content = readFileSync(checkedFile(projectDir, path), 'utf-8')
      const { extractProjectCategoryFromDoc } = require('./nanju-engineering-template') as typeof import('./nanju-engineering-template')
      const category = extractProjectCategoryFromDoc(content)
      if (category) return category !== 'web-fullstack'
    } catch { /* 缺文档不推断品类；后续最低结构门另行检查 */ }
  }
  return false
}

/** 新工程用交付说明作为阶段产出；旧静态网页路径仅作兼容。 */
export function resolveCodingOutputPath(projectDir: string): string {
  return (existsSync(join(projectDir, ENGINEERING_CONTRACT_PATH)) || requiresEngineeringContract(projectDir)) ? ENGINEERING_DELIVERY_PATH : '08_APP/index.html'
}

export function validateEngineeringCodingOutput(projectDir: string): string | null {
  const captured = captureEngineeringEvidence(projectDir, { includeScenarios: false })
  if (!captured.evidence) return '工程契约或产物不完整：' + captured.problems.join('；')
  try {
    const doc = readFileSync(checkedFile(projectDir, ENGINEERING_DELIVERY_PATH), 'utf-8')
    if (!/^#\s+\S/m.test(doc) || !/^##\s+构建与运行\s*$/m.test(doc) || !/^##\s+测试状态\s*$/m.test(doc)) {
      return '交付说明缺少「构建与运行」「测试状态」章节：' + ENGINEERING_DELIVERY_PATH
    }
  } catch { return '缺少可读交付说明：' + ENGINEERING_DELIVERY_PATH }
  return null
}
const TARGET_KINDS = ['web', 'api', 'mobile', 'desktop', 'cli', 'ai'] as const
const TEST_ADAPTERS = ['browser-file', 'browser-url', 'native-driver', 'cli-driver', 'api-driver', 'mobile-driver'] as const
const TEST_LAYERS = ['unit', 'integration', 'acceptance'] as const

/** L3-7c（2026-09-18）：Spike 结论方向三选一（字段名与枚举以 03 §3.1 英文字段为准）。
 * 三套词表分属三个语义维度、互不替代：verdict=结论方向；02 §4 状态 FULL/PARTIAL=
 * 完成度；坑库 [推断]/[实证]=证据等级。 */
const SPIKE_VERDICTS = ['confirmed', 'refuted', 'partial'] as const

export interface EngineeringSpikeRecord {
  /** Spike 标识：SPIKE-NNN-短名 或 00_SPIKES 目录名（≤64 字符，spikes[] 内唯一）。 */
  slug: string
  /** 结论方向：confirmed=证实 / refuted=证伪 / partial=部分成立。 */
  verdict: typeof SPIKE_VERDICTS[number]
  /** 一句话结论（中文允许，≤200 字符）；由架构师按 Spike README 结论段人工登记。 */
  conclusion?: string
  /** 登记主体：架构师/会话标识（≤64 字符）。 */
  decided_by?: string
  /** 结论时间（ISO 日期宽松形态：日期或完整时间戳）。 */
  ts?: string
}

/** L3-7c（2026-09-18）：env_probe.json 登记性字段——只登记探测产出的存在与生成时间，
 * 不构成执行指令（执行探测的是项目启动钩子，非契约；探测本身属 env-probe 模块职责）。 */
export interface EngineeringEnvProbeRegistration {
  /** 探测产物路径；固定惯例 03_ARCHITECTURE/env_probe.json，可缺省。 */
  path?: string
  /** 生成时间（ISO 日期宽松形态）。 */
  generatedAt?: string
}

export interface EngineeringDriverPlan {
  /** 固定运行时；native直接执行项目内程序，不解释shell字符串。 */
  runtime: 'node' | 'python3' | 'native'
  path: string
  args: string[]
  timeoutMs: number
  /** P0-1（schema v2，2026-09-18）：驱动所需环境变量名清单（不含值）；值由宿主进程环境
   * 提供，不写入契约、不落盘。仅 schemaVersion=2 可声明；v1 无此字段等价 env=[]。 */
  env?: string[]
}
/** browser-url测试的服务计划：固定runtime+argv；宿主在单次批准后才启动、持有loopback服务句柄。 */
export interface EngineeringServicePlan {
  runtime: 'node' | 'python3' | 'native'
  /** 服务文件，相对08_APP且必须列入artifacts（源码指纹绑定批准）。 */
  path: string
  args: string[]
  /** P0-1（schema v2）：服务进程所需环境变量名清单；语义同 driver.env。 */
  env?: string[]
  /** 1024至65535的loopback固定端口；宿主启动前探测，已被占用即拒绝，不接管他人服务。 */
  port: number
  /** 就绪探测路径（以/开头，不含查询串）；就绪判定以响应携带本次启动 nonce 为准（header 或 body），任意 HTTP 状态码不够。 */
  readyPath: string
  readyTimeoutMs: number
}
export interface EngineeringTestPlan {
  id: string
  layer: typeof TEST_LAYERS[number]
  adapter: typeof TEST_ADAPTERS[number]
  /** 被测产物（相对于 08_APP），不是执行命令。 */
  target: string
  /** 人类可读执行说明；不得作为自动 shell 命令入口。 */
  command: string
  covers: string[]
  requiresReal: boolean
  /** 缺少结构化驱动时只允许声明设计，不得自动执行command说明。 */
  driver?: EngineeringDriverPlan
  /** browser-url专用：宿主持有的loopback服务启动计划；批准前不得启动。 */
  service?: EngineeringServicePlan
  /** 相对06_TESTS的浏览器场景清单，明确归属本test.id；testing阶段产出。 */
  scenarioFiles?: string[]
}
export interface EngineeringContract {
  /** P0-1（2026-09-18）：v2 为新工程默认（可携带可选 env 字段）；v1 存量档案原样有效
   * （无 env 等价 env=[]，不迁移不重写）；在途 v1 工程声明 env 的通道=显式改 schemaVersion 为 2
   * （校验器接受显式版本升级）。v1 文件出现 env 字段视为校验错误。 */
  schemaVersion: 1 | 2
  target: { platform: string; kind: typeof TARGET_KINDS[number]; entry: string }
  artifacts: string[]
  build: string
  run: string
  tests: EngineeringTestPlan[]
  /** L3-7c（2026-09-18，schema v2）：Spike 登记清单（≤16 项）；由架构师按
   * 00_SPIKES/INDEX.md 与各 Spike README 结论段人工登记（markdown→JSON 不做自动
   * 解析——中文断句不稳定，消费方为 LLM 会话/人工直读）。仅 v2 可声明（v1 带字段拒）。 */
  spikes?: EngineeringSpikeRecord[]
  /** L3-7c（2026-09-18，schema v2）：env_probe 探测产出登记（宽松校验——登记性
   * 字段不是执行指令）；仅 v2 可声明（v1 带字段拒）。 */
  envProbe?: EngineeringEnvProbeRegistration
}
export interface EngineeringFileFingerprint {
  path: string
  sha256: string
  size: number
}
export interface EngineeringEvidence {
  schemaVersion: 1
  prd: EngineeringFileFingerprint
  contract: EngineeringFileFingerprint
  artifacts: EngineeringFileFingerprint[]
  scenarios?: EngineeringFileFingerprint[]
  digest: string
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
function member<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === 'string' && choices.includes(value as T)
}
/** 规范相对文件路径；不接收绝对路径、空片段或父级片段。 */
function artifactPath(value: unknown): value is string {
  return text(value) && value === value.trim() && !/[\\:\x00-\x1f]/.test(value)
    && value.split('/').every((part) => Boolean(part) && part !== '.' && part !== '..')
}

/** 合法环境变量名（POSIX 惯例：字母/下划线开头，字母数字下划线；长度≤64）。 */
function envVarName(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) && value.length <= 64
}

/** P0-1（schema v2）：driver/service 的 env 声明清单校验（仅 v2 契约允许）。
 * v1 契约携带 env 字段视为校验错误（升级通道=显式将 schemaVersion 改 2）。 */
function declaredEnvList(owner: Record<string, unknown>, label: string, schemaVersion: unknown, problems: string[]): void {
  if (owner.env === undefined) return
  if (schemaVersion !== 2) {
    problems.push(label + ' env 字段仅 schemaVersion=2 契约可声明；在途 v1 工程请显式将 schemaVersion 改为 2 后再声明')
    return
  }
  if (!Array.isArray(owner.env) || owner.env.length === 0 || owner.env.length > 32) {
    problems.push(label + ' env 必须为1至32项的环境变量名数组')
    return
  }
  const seen = new Set<string>()
  for (const name of owner.env) {
    if (!envVarName(name)) { problems.push(label + ' env 含非法环境变量名（须为字母/下划线开头、字母数字下划线、≤64字符）：' + JSON.stringify(name)); continue }
    if (seen.has(name)) { problems.push(label + ' env 变量名不得重复：' + name); continue }
    seen.add(name)
  }
}

/** L3-7c（2026-09-18）：ISO 日期宽松形态——日期（2026-09-18）或日期+时间
 * （含可选秒/毫秒/时区偏移，T 或空格分隔）；拒绝首尾空白与非数字段。 */
function isoLooseDate(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim()
    && /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(value)
}

/** L3-7c（schema v2，2026-09-18）：Spike 登记清单校验（仅 v2 可声明；v1 带字段拒——
 * 与 env 同规则）。spikes[] 由架构师按 00_SPIKES/INDEX.md 与各 Spike README 结论段
 * 人工登记，markdown→JSON 不做自动解析（中文断句不稳定，消费方为 LLM/人工直读）。 */
function declaredSpikeList(value: Record<string, unknown>, schemaVersion: unknown, problems: string[]): void {
  if (value.spikes === undefined) return
  if (schemaVersion !== 2) {
    problems.push('spikes 字段仅 schemaVersion=2 契约可声明；在途 v1 工程请显式将 schemaVersion 改为 2 后再声明')
    return
  }
  if (!Array.isArray(value.spikes) || value.spikes.length === 0 || value.spikes.length > 16) {
    problems.push('spikes 必须为1至16项的 Spike 登记数组（无 Spike 时省略该字段，不要留空数组）')
    return
  }
  const seen = new Set<string>()
  for (const [index, row] of value.spikes.entries()) {
    const label = `spikes[${index}]`
    if (!record(row)) { problems.push(label + ' 必须为 Spike 登记对象'); continue }
    if (!text(row.slug) || row.slug.length > 64) {
      problems.push(label + ' slug 必须为非空且≤64字符的 Spike 标识（SPIKE-NNN-短名或00_SPIKES目录名）'); continue
    }
    if (seen.has(row.slug)) { problems.push(label + ' slug 不得重复：' + row.slug); continue }
    seen.add(row.slug)
    if (!member(row.verdict, SPIKE_VERDICTS)) {
      problems.push(label + ' verdict 必须为 confirmed/refuted/partial 三选一（结论方向维度，区别于状态FULL/PARTIAL完成度与坑库[推断]/[实证]证据等级）')
    }
    if (row.conclusion !== undefined && (typeof row.conclusion !== 'string' || row.conclusion.trim().length === 0 || row.conclusion.length > 200)) {
      problems.push(label + ' conclusion 须为非空、≤200字符的一句话结论')
    }
    if (row.decided_by !== undefined && (typeof row.decided_by !== 'string' || row.decided_by.trim().length === 0 || row.decided_by.length > 64)) {
      problems.push(label + ' decided_by 须为非空、≤64字符的登记主体标识')
    }
    if (row.ts !== undefined && !isoLooseDate(row.ts)) {
      problems.push(label + ' ts 须为 ISO 日期形态（如 2026-09-18 或 2026-09-18T09:00:00+08:00）')
    }
  }
}

/** L3-7c（schema v2，2026-09-18）：envProbe 登记性字段宽松校验（仅 v2 可声明，与
 * spikes 同规则）。宽松=只验形态不验文件存在——它是登记性字段不是执行指令，探测
 * 产出存在性由 env-probe 链路自己保证，不在此加文件系统检查。 */
function declaredEnvProbe(value: Record<string, unknown>, schemaVersion: unknown, problems: string[]): void {
  if (value.envProbe === undefined) return
  if (schemaVersion !== 2) {
    problems.push('envProbe 字段仅 schemaVersion=2 契约可声明；在途 v1 工程请显式将 schemaVersion 改为 2 后再声明')
    return
  }
  if (!record(value.envProbe)) { problems.push('envProbe 必须为对象（可含 path 与 generatedAt，均为可选）'); return }
  const probe = value.envProbe
  if (probe.path !== undefined && (typeof probe.path !== 'string' || !artifactPath(probe.path) || probe.path.length > 256)) {
    problems.push('envProbe.path 须为规范相对路径（固定惯例 03_ARCHITECTURE/env_probe.json，一般可缺省）')
  }
  if (probe.generatedAt !== undefined && !isoLooseDate(probe.generatedAt)) {
    problems.push('envProbe.generatedAt 须为 ISO 日期形态')
  }
}

export function parseEngineeringContract(raw: string): { contract: EngineeringContract | null; problems: string[] } {
  let value: unknown
  try { value = JSON.parse(raw) } catch { return { contract: null, problems: ['工程契约不是有效 JSON'] } }
  if (!record(value)) return { contract: null, problems: ['工程契约必须为对象'] }
  const problems: string[] = []
  // P0-1：双版本接受——v1 存量档案原样有效，v2 为新工程默认（方可携带可选 env 字段）。
  const schemaVersion = value.schemaVersion
  if (schemaVersion !== 1 && schemaVersion !== 2) problems.push('工程契约 schemaVersion 必须为 1 或 2')
  const target = record(value.target) ? value.target : {}
  if (!text(target.platform) || !member(target.kind, TARGET_KINDS) || !artifactPath(target.entry)) {
    problems.push('target 必须明确 platform、kind 和相对于 08_APP 的 entry')
  }
  const artifacts = Array.isArray(value.artifacts) ? value.artifacts : []
  if (!artifacts.length || !artifacts.every(artifactPath) || new Set(artifacts).size !== artifacts.length) {
    problems.push('artifacts 必须为非空、不重复的规范相对文件路径清单')
  }
  if (!artifacts.includes(target.entry)) problems.push('target.entry 必须列入 artifacts')
  if (!text(value.build) || !text(value.run)) problems.push('必须说明 build 和 run（无需构建也须写明理由）')
  const tests = Array.isArray(value.tests) ? value.tests : []
  const ids = new Set<string>()
  const scenarioOwners = new Set<string>()
  if (!tests.length) problems.push('tests 至少需要一项测试设计')
  let hasAcceptance = false
  for (const [index, row] of tests.entries()) {
    const label = `tests[${index}]`
    if (!record(row)) { problems.push(label + ' 必须为测试对象'); continue }
    if (!text(row.id) || ids.has(row.id)) problems.push(label + ' id 必须非空且唯一')
    if (text(row.id)) ids.add(row.id)
    if (!member(row.layer, TEST_LAYERS) || !member(row.adapter, TEST_ADAPTERS)) problems.push(label + ' layer 或 adapter 不支持')
    if (!artifactPath(row.target) || !artifacts.includes(row.target)) problems.push(label + ' target 必须引用 artifacts 中的产物')
    if (!text(row.command)) problems.push(label + ' 必须说明执行方式 command（说明不代表授权）')
    if (typeof row.requiresReal !== 'boolean') problems.push(label + ' 必须明确 requiresReal')
    if (row.driver !== undefined) {
      const driver = record(row.driver) ? row.driver : {}
      if (!member(driver.runtime, ['node', 'python3', 'native']) || !artifactPath(driver.path) || !artifacts.includes(driver.path)) {
        problems.push(label + ' driver 必须选择固定runtime并引用artifacts中的驱动文件')
      }
      if (!Array.isArray(driver.args) || driver.args.length > 128 || !driver.args.every((arg) => typeof arg === 'string' && arg.length <= 8192 && !arg.includes('\u0000'))) {
        problems.push(label + ' driver.args 必须为有限长度的字符串参数数组')
      }
      if (typeof driver.timeoutMs !== 'number' || !Number.isInteger(driver.timeoutMs) || driver.timeoutMs < 100 || driver.timeoutMs > 600000) {
        problems.push(label + ' driver.timeoutMs 必须为100至600000毫秒')
      }
      declaredEnvList(driver, label + ' driver', schemaVersion, problems)
    }
    if (row.service !== undefined) {
      const service = record(row.service) ? row.service : {}
      if (!member(row.adapter, ['browser-url'])) {
        problems.push(label + ' service服务计划只适用于browser-url测试')
      } else {
        if (!member(service.runtime, ['node', 'python3', 'native']) || !artifactPath(service.path) || !artifacts.includes(service.path)) {
          problems.push(label + ' service必须选择固定runtime并引用artifacts中的服务文件')
        }
        if (!Array.isArray(service.args) || service.args.length > 128 || !service.args.every((arg) => typeof arg === 'string' && arg.length <= 8192 && !arg.includes('\u0000'))) {
          problems.push(label + ' service.args必须为有限长度的字符串参数数组')
        }
        if (typeof service.port !== 'number' || !Number.isInteger(service.port) || service.port < 1024 || service.port > 65535) {
          problems.push(label + ' service.port必须为1024至65535的loopback端口')
        }
        if (!text(service.readyPath) || !service.readyPath.startsWith('/') || service.readyPath.length > 512 || /[?#\u0000-\u001f]/.test(service.readyPath)) {
          problems.push(label + ' service.readyPath必须是以/开头、不含查询串的就绪探测路径')
        }
        if (typeof service.readyTimeoutMs !== 'number' || !Number.isInteger(service.readyTimeoutMs) || service.readyTimeoutMs < 100 || service.readyTimeoutMs > 60000) {
          problems.push(label + ' service.readyTimeoutMs必须为100至60000毫秒')
        }
        declaredEnvList(service, label + ' service', schemaVersion, problems)
      }
    }
    if (row.adapter === 'browser-url' && row.service === undefined) problems.push(label + ' browser-url测试必须声明service服务计划，固定runtime与argv')
    if (row.scenarioFiles !== undefined) {
      if (!['browser-file', 'browser-url'].includes(String(row.adapter)) || !Array.isArray(row.scenarioFiles) || !row.scenarioFiles.length) {
        problems.push(label + ' scenarioFiles只能为浏览器测试的非空场景路径数组')
      } else {
        for (const path of row.scenarioFiles) {
          if (!artifactPath(path) || !path.endsWith('.steps.json') || scenarioOwners.has(path)) {
            problems.push(label + ' scenarioFiles必须为规范steps.json路径且每个场景仅归属一个测试')
          } else scenarioOwners.add(path)
        }
      }
    }
    if (row.adapter === 'browser-url' && row.scenarioFiles === undefined) problems.push(label + ' browser-url测试必须绑定scenarioFiles浏览器场景')
    const covers = Array.isArray(row.covers) ? row.covers : null
    if (!covers || !covers.every((us) => typeof us === 'string' && /^US-\d+$/i.test(us)) || new Set(covers).size !== covers.length) {
      problems.push(label + ' covers 必须为不重复的 US-编号数组')
    }
    if (row.layer === 'acceptance') {
      hasAcceptance = true
      if (!covers?.length) problems.push(label + ' 行为验收必须声明 covers')
    } else if (covers?.length) {
      problems.push(label + ' 辅助测试不得登记为用户故事验收，请将 covers 设为空数组')
    }
  }
  if (!hasAcceptance) problems.push('tests 必须包含 acceptance 行为验收设计')
  // L3-7c（schema v2，2026-09-18）：可选登记字段——spikes[]/envProbe（仅 v2 可声明，
  // v1 带字段拒，与 env 同规则；登记项不参与指纹绑定，仅为效果度量与继承注入的元数据）。
  declaredSpikeList(value, schemaVersion, problems)
  declaredEnvProbe(value, schemaVersion, problems)
  if (problems.length) return { contract: null, problems }
  // 以上逐字段检查完成；返回经过检查的 JSON 数据，不填充静默默认值。
  return { contract: value as unknown as EngineeringContract, problems: [] }
}

/** 检查路径每个组件，避免将项目外链接或目录当作文件产物读取。 */
function checkedFile(projectDir: string, relativePath: string): string {
  if (!artifactPath(relativePath)) throw new Error('不是规范相对文件路径')
  let current = projectDir
  const parts = relativePath.split('/')
  for (const [index, part] of parts.entries()) {
    current = join(current, part)
    const stat = lstatSync(current)
    if (stat.isSymbolicLink()) throw new Error('产物路径包含符号链接')
    if (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) throw new Error('产物不是普通文件或目录结构不完整')
  }
  return current
}

function fingerprint(projectDir: string, path: string): EngineeringFileFingerprint {
  const fd = openSync(checkedFile(projectDir, path), 'r')
  try {
    const before = fstatSync(fd)
    if (!before.isFile()) throw new Error('产物不是普通文件')
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(64 * 1024)
    let size = 0
    let count: number
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, count))
      size += count
    }
    const after = fstatSync(fd)
    if (size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      throw new Error('捕获期间文件变化，请在构建完成后重试')
    }
    return { path, sha256: hash.digest('hex'), size }
  } finally { closeSync(fd) }
}

/**
 * 捕获完整文件绑定；不执行测试，不声明 US 已通过。
 * 调用者须在运行前后比较 digest，交付时重算，不能只保存一次并长期复用。
 */
export function captureEngineeringEvidence(projectDir: string, options: { includeScenarios?: boolean } = {}): { evidence: EngineeringEvidence | null; problems: string[] } {
  const problems: string[] = []
  let raw: string
  try { raw = readFileSync(checkedFile(projectDir, ENGINEERING_CONTRACT_PATH), 'utf-8') }
  catch { return { evidence: null, problems: ['工程契约缺失或不是可读普通文件：' + ENGINEERING_CONTRACT_PATH] } }
  const parsed = parseEngineeringContract(raw)
  if (!parsed.contract) return { evidence: null, problems: parsed.problems }
  const artifactPaths = parsed.contract.artifacts.map((path) => '08_APP/' + path).sort()
  const scenarioPaths = options.includeScenarios === false ? [] : parsed.contract.tests.flatMap((test) => test.scenarioFiles ?? []).map((path) => '06_TESTS/' + path).sort()
  const paths = ['01_PRD/prd.md', ENGINEERING_CONTRACT_PATH, ...artifactPaths, ...scenarioPaths]
  const files: EngineeringFileFingerprint[] = []
  for (const path of paths) {
    try { files.push(fingerprint(projectDir, path)) }
    catch (error) { problems.push('无法绑定产物 ' + path + '：' + (error instanceof Error ? error.message : String(error))) }
  }
  if (problems.length) return { evidence: null, problems }
  const prd = files[0]!
  const contract = files[1]!
  if (contract.sha256 !== createHash('sha256').update(raw).digest('hex')) {
    return { evidence: null, problems: ['工程契约在解析后发生变化，请重试'] }
  }
  return {
    evidence: { schemaVersion: 1, prd, contract, artifacts: files.slice(2, 2 + artifactPaths.length), ...(scenarioPaths.length ? { scenarios: files.slice(2 + artifactPaths.length) } : {}), digest: createHash('sha256').update(JSON.stringify(files)).digest('hex') },
    problems: [],
  }
}

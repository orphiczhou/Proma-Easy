/**
 * P0-2（L1，2026-09-18）：驱动 stdout/stderr 尾部捕获与自适应诊断摘要。
 *
 * 背景（G3b 实测，8 轮验收 5 轮盲修的直接根因）：驱动 stderr 此前只计数不保存，
 * 判定面板只见「测试驱动结果不可用：部分计划用户故事没有检查记录」固定句，
 * 云端 401/模型名错误/崩溃 traceback 等真实诊断信息全部丢失。
 *
 * 截断管道固定（逐层套用、非任一先到，ATK-U-003）：
 *   ① 取尾 200 行 → ② 逐行截 2KB → ③ 总量超 64KB 时自头部截除至 ≤64KB（保尾部）。
 *
 * 自适应诊断摘要（≤1KB，ATK-U-004 锚点优先级定死）：
 *   窗口内存在 Traceback 起点行 → 自最早 Traceback 起点行取至末尾（含栈帧；
 *     超 1KB 时保留首行 Traceback + 按末尾优先截断）；
 *   否则 → 自最后一条 Error/Exception/Warning 关键行取至末尾；
 *   均未命中 → 末 3 行。
 *
 * 诚实边界（方案 §四 L1-1 P0-2）：该阈值对已观测样本类别实测覆盖（成功录音类 490B /
 * 云端错误类 0.9-1.8KB，/tmp/drv* 四份指挥官复现残迹，末行含 peak/HTTP 400 诊断）；
 * 崩溃 traceback 类无真实留存样本——以本模块单测构造 R3 类崩溃样例校准（下方测试
 * 样本三），首个真实 error 轮再补证。
 */

/** 管道常量：尾 200 行 / 单行 2KB / 总量 64KB */
export const DRIVER_IO_TAIL_LINES = 200
export const DRIVER_IO_LINE_MAX_BYTES = 2048
export const DRIVER_IO_TOTAL_MAX_BYTES = 64 * 1024
/** 诊断摘要上限（1KB） */
export const DRIVER_IO_DIAG_MAX_BYTES = 1024

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf-8')
}

/** 自头部保留 ≤maxBytes（UTF-8 合法边界回退）——用于单行 2KB 截断（保留行首时间戳/级别信息）。 */
export function utf8HeadSlice(text: string, maxBytes: number): string {
  if (utf8Bytes(text) <= maxBytes) return text
  const buf = Buffer.from(text, 'utf-8')
  let end = maxBytes
  while (end > 0) {
    const byte = buf[end]
    if (byte === undefined || (byte & 0xC0) !== 0x80) break // 非连续字节 → 已到合法边界
    end -= 1
  }
  return buf.subarray(0, end).toString('utf-8')
}

/** 自尾部保留 ≤maxBytes（UTF-8 合法边界回退）——用于总量 64KB（保尾部）与诊断摘要末尾优先。 */
export function utf8TailSlice(text: string, maxBytes: number): string {
  if (utf8Bytes(text) <= maxBytes) return text
  const buf = Buffer.from(text, 'utf-8')
  let start = buf.length - maxBytes
  while (start < buf.length && start > 0) {
    const byte = buf[start]
    if (byte === undefined || (byte & 0xC0) !== 0x80) break // 非连续字节 → 已到合法边界
    start += 1
  }
  return buf.subarray(start).toString('utf-8')
}

/** 截断管道（纯函数）：①尾 200 行 → ②逐行 2KB（保行首）→ ③总量 ≤64KB 自头部截除（保尾部）。 */
export function applyDriverIoTailPipeline(raw: string): string {
  const normalized = raw.replace(/\r\n/g, '\n')
  const allLines = normalized.split('\n')
  const tailLines = allLines.slice(-DRIVER_IO_TAIL_LINES)
  const cappedLines = tailLines.map((line) => utf8HeadSlice(line, DRIVER_IO_LINE_MAX_BYTES))
  let out = cappedLines.join('\n')
  if (utf8Bytes(out) > DRIVER_IO_TOTAL_MAX_BYTES) {
    out = utf8TailSlice(out, DRIVER_IO_TOTAL_MAX_BYTES)
  }
  return out
}

/** 增量尾部缓冲：进程流式输出场景的内存安全封装（内部只保留近端窗口）。 */
export class DriverIoTailBuffer {
  private buffer = ''
  private readonly maxRawBytes = 256 * 1024 // 4× 管道总量上限，保证输出管道恒可完整套用
  append(data: Buffer | string): void {
    const chunk = typeof data === 'string' ? data : data.toString('utf-8')
    this.buffer += chunk
    if (utf8Bytes(this.buffer) > this.maxRawBytes) {
      this.buffer = utf8TailSlice(this.buffer, this.maxRawBytes)
    }
  }
  tail(): string {
    return applyDriverIoTailPipeline(this.buffer)
  }
}

// ===== Y-01（L2 批，2026-09-18）：驱动尾部密钥脱敏 =====

/** 已知敏感值掩码下限（字符数）：短串（如 DISPLAY=":0"）不掩，防误伤正常日志。 */
export const DRIVER_IO_SECRET_MIN_CHARS = 8

/**
 * 通用密钥模式（Y-01 (b)）：sk- 前缀 / Bearer 凭据 / Authorization 头。
 * 三处均加 \b 词边界：防 "task-runner-xxx"（内嵌 sk-）这类正常标识符被误掩——
 * 真实密钥前导字符（空格/引号/等号/行首/汉字）处词边界恒成立，不影响命中。
 */
const GENERIC_SECRET_RE = /\bsk-[A-Za-z0-9_-]{8,}|\bBearer\s+[A-Za-z0-9._-]{8,}|\bAuthorization:\s*\S{8,}/g

/**
 * Y-01：驱动尾部脱敏（纯函数，便于单测）。
 *
 * 掩码值集合两路：
 * (a) knownValues——平台在 buildDriverEnv 处精确知道的本进程注入值集合（契约 declared
 *     ∪ DASHSCOPE 兜底的实际值），精确整串替换 → "***"，零误伤；短于 8 字符的值跳过
 *     （防 DISPLAY=":0" 之类短值把日志打花）。
 * (b) 通用密钥模式——驱动自身回显的未知密钥（如调试残留 print(os.environ)），
 *     保留可识别前缀 + "***"（sk-*** / Bearer *** / Authorization: ***）。
 *
 * 应用位置=process-driver driverIo() 收集处（最上游）：stderr/stdout 尾部进入透传链
 * （error 摘要 / 旁挂 log / report.json / summaryText / telemetry）之前统一掩码。
 */
export function maskDriverIoSecrets(text: string, knownValues: readonly string[]): string {
  let out = text
  // (a) 已知注入值：整串替换（split/join 免正则转义，含 . * $ 等字符的值也安全）
  for (const value of knownValues) {
    if (typeof value !== 'string' || value.length < DRIVER_IO_SECRET_MIN_CHARS) continue
    if (!out.includes(value)) continue
    out = out.split(value).join('***')
  }
  // (b) 通用密钥模式：保留前缀 + ***（密文整体掩掉；掩码后 *** 不会再被重复命中）
  out = out.replace(GENERIC_SECRET_RE, (match) => {
    if (match.startsWith('sk-')) return 'sk-***'
    if (/^Bearer\s/.test(match)) return 'Bearer ***'
    return 'Authorization: ***'
  })
  return out
}

/** 驱动 IO 捕获（execution 结果与 gwt 报告间的数据形态）。 */
export interface EngineeringDriverIo {
  stdoutTail: string
  stderrTail: string
}

function isEngineeringDriverIo(value: unknown): value is EngineeringDriverIo {
  return typeof value === 'object' && value !== null
    && typeof (value as EngineeringDriverIo).stdoutTail === 'string'
    && typeof (value as EngineeringDriverIo).stderrTail === 'string'
}

export { isEngineeringDriverIo }

/** Traceback 起点行（Python 崩溃栈帧首行；容忍行首空白与尾缀冒号）。 */
const TRACEBACK_START_RE = /^\s*Traceback \(most recent call last\)\s*:?\s*$/
/** 诊断关键行（Traceback/Error/Exception/Warning 关键字，大小写不敏感）。 */
const DIAG_KEYWORD_RE = /traceback|error|exception|warning/i

/**
 * 自适应诊断摘要（≤1KB）。诊断窗口=stderr 尾部优先（契约约定「日志写stderr」，
 * G3b 实测云端错误/崩溃诊断均在 stderr；stdout 仅在驱动违反契约输出日志时兜底）。
 */
export function summarizeDriverIo(stdoutTail: string, stderrTail: string): string {
  const window = stderrTail.trim().length > 0 ? stderrTail : stdoutTail
  if (window.trim().length === 0) return ''
  const lines = window.replace(/\r\n/g, '\n').split('\n')
  // 去掉尾部的空行噪音
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop()
  if (lines.length === 0) return ''

  // 锚点优先级 1：最早 Traceback 起点行 → 取至末尾（含栈帧）
  let tracebackStart = -1
  for (let i = 0; i < lines.length; i++) {
    if (TRACEBACK_START_RE.test(lines[i]!)) { tracebackStart = i; break }
  }
  if (tracebackStart >= 0) {
    const seg = lines.slice(tracebackStart).join('\n')
    if (utf8Bytes(seg) <= DRIVER_IO_DIAG_MAX_BYTES) return seg
    // 超 1KB：保留首行 Traceback + 末尾优先截断（ATK-U-004）
    const head = lines[tracebackStart]!
    const headBudget = Math.min(utf8Bytes(head), 256)
    const headText = utf8HeadSlice(head, headBudget)
    const marker = '\n…（栈帧中略）…\n'
    const tailBudget = DRIVER_IO_DIAG_MAX_BYTES - utf8Bytes(headText) - utf8Bytes(marker)
    return headText + marker + utf8TailSlice(seg, Math.max(0, tailBudget))
  }

  // 锚点优先级 2：最后一条 Error/Exception/Warning 关键行 → 取至末尾
  let lastKeyword = -1
  for (let i = 0; i < lines.length; i++) {
    if (DIAG_KEYWORD_RE.test(lines[i]!)) lastKeyword = i
  }
  if (lastKeyword >= 0) {
    const seg = lines.slice(lastKeyword).join('\n')
    return utf8TailSlice(seg, DRIVER_IO_DIAG_MAX_BYTES)
  }

  // 未命中：末 3 行
  const seg = lines.slice(-3).join('\n')
  return utf8TailSlice(seg, DRIVER_IO_DIAG_MAX_BYTES)
}

/**
 * 平台侧旁挂落盘内容：分节标注 stdout/stderr（06_TESTS/driver-io-<轮次时间戳>.log）。
 * 写入者=平台 process-driver/judge（与既有 06_TESTS/report-*.md 同通道同权限），
 * 不经指挥官/Agent 会话，不触发 router.gate unbound-write-deny 工程目录写保护
 * （ATK-L-004；G3b 实测该门禁拦 Agent 会话 ×22 而平台报告照常产出）。
 */
export function buildDriverIoLogFile(io: EngineeringDriverIo, context: { testId: string; generatedAt: string }): string {
  const parts: string[] = []
  parts.push(`# 驱动输出旁挂（driver-io）`)
  parts.push(`# testId: ${context.testId}`)
  parts.push(`# generatedAt: ${context.generatedAt}`)
  parts.push(`# 截断管道：尾 ${DRIVER_IO_TAIL_LINES} 行 / 单行 ${DRIVER_IO_LINE_MAX_BYTES}B / 总量 ${DRIVER_IO_TOTAL_MAX_BYTES}B（保尾部）`)
  parts.push('')
  parts.push('## stderr 尾部')
  parts.push(io.stderrTail.length > 0 ? io.stderrTail : '（空）')
  parts.push('')
  parts.push('## stdout 尾部')
  parts.push(io.stdoutTail.length > 0 ? io.stdoutTail : '（空）')
  return parts.join('\n') + '\n'
}

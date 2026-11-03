/**
 * G2｜Linux 宿主观察器（host observer）：全局热键 → 录音 → 真实 ASR → 外部编辑器光标。
 *
 * 归属与边界（与 REAL.md §3、REAL-impl §6/§8、REAL-review-2 INV-A~E、I.md B-f 对齐）：
 * - 本模块是**宿主观察器**：持有刺激权（注入全局热键、激活靶窗口）与系统观察权（音频采集、
 *   ASR 调用、靶窗口权威读回）。只读系统事实，**不读项目自报**、不解析项目 stdout、不写项目文件。
 * - **刺激与观察分离**：热键监听、录音、ASR 调用、文本插入等**产品行为**由被验收的工程项目实现；
 *   观察器只负责“注入刺激 + 读回事实 + 判定一致性”，不代替产品完成业务流程、不注入靶文本。
 * - **全部依赖注入**：ASR 客户端、命令执行器、时钟、设备名（音源 / 靶应用 / 加速器）均由调用方注入；
 *   本模块只提供基于注入命令执行器的默认 Linux 实现（G3 实机装配用），测试一律用 fake，
 *   不接触真实设备、麦克风、网络与 GUI。
 * - **不虚构**：任一观察点失败即整轮 `verdict:'rejected'`，登记会被 registry 拒绝
 *   （`requires-real-unattested`），门禁保持 blocked；不可自动观察点（语义 / 物理麦克风 /
 *   真实用户编辑器 / 视觉焦点）只走 `HumanWitnessReceipt`，本模块**不生成见证**。
 * - **密钥**：ASR 密钥只以**环境变量名**引用（`asrKeyEnvVar`），值经 `deps.env` 读取，并且整轮观察在
 *   出具结论前统一 `redactSecrets` 洗一遍；记录里只保留变量名与“是否存在”，绝不写入密钥值。
 * - **不含证据登记**：登记入口在 `nanju-engineering-real-gate.ts`（唯一持有 registry 的接线层），
 *   本模块只产出 `EngineeringHostObserverRegistration` 载荷，由调用方交给门禁票据登记。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ENGINEERING_REAL_BOUNDARY_CODES } from './nanju-engineering-real-evidence'
import type {
  EngineeringObservationPoint,
  EngineeringRealClock,
  EngineeringRealObservation,
} from './nanju-engineering-real-evidence'
import type { EngineeringHostObserverRegistration } from './nanju-engineering-real-gate'

/* ------------------------------------------------------------------ */
/* 观察点与观察接口常量                                                  */
/* ------------------------------------------------------------------ */

/** 四个机器观察点 id（与 REAL.md §3.1 一一对应）。 */
export const LINUX_OBSERVATION_POINT_IDS = {
  hotkeyDelivered: 'linux.global-hotkey.delivered',
  recordingStarted: 'linux.recording.started',
  asrRealEndpoint: 'linux.asr.real-endpoint',
  cursorInputPasted: 'linux.cursor-input.pasted',
} as const

/**
 * 宿主观察接口名（`observedVia`）：**固定常量**，同时写进观察点声明与观察结果。
 * 门禁要求二者严格相等（`host-observation-missing`），因此这里不接收调用方自定义字符串。
 */
export const LINUX_OBSERVATION_VIA = {
  hotkey: 'host.global-hotkey.inject-and-listen',
  audio: 'host.pulseaudio.source-capture',
  asr: 'host.asr-client.transcribe',
  insert: 'host.xdotool.window-readback',
} as const

/** 不可自动观察点（`machineObservable:false`）：本模块只做**声明对账**，不生成见证。 */
export const LINUX_HUMAN_WITNESS_POINT_IDS = {
  asrSemantic: 'linux.asr.semantic',
  micPhysical: 'linux.mic.physical',
  editorRealUserApp: 'linux.editor.real-user-app',
  visualFocus: 'linux.visual.focus',
} as const

/** 声明四个机器观察点（`machineObservable:true`），直接作为门禁入参 `tests[].points`。 */
export function linuxObservationPoints(): EngineeringObservationPoint[] {
  return [
    { id: LINUX_OBSERVATION_POINT_IDS.hotkeyDelivered, kind: 'hotkey', machineObservable: true, observedVia: LINUX_OBSERVATION_VIA.hotkey },
    { id: LINUX_OBSERVATION_POINT_IDS.recordingStarted, kind: 'recording', machineObservable: true, observedVia: LINUX_OBSERVATION_VIA.audio },
    { id: LINUX_OBSERVATION_POINT_IDS.asrRealEndpoint, kind: 'network', machineObservable: true, observedVia: LINUX_OBSERVATION_VIA.asr },
    { id: LINUX_OBSERVATION_POINT_IDS.cursorInputPasted, kind: 'cursor-input', machineObservable: true, observedVia: LINUX_OBSERVATION_VIA.insert },
  ]
}

/** 声明不可自动观察点（仅供真人见证对账；观察器不会为它们产出机器结论）。 */
export function linuxHumanWitnessPoints(): EngineeringObservationPoint[] {
  return [
    { id: LINUX_HUMAN_WITNESS_POINT_IDS.asrSemantic, kind: 'asr', machineObservable: false, observedVia: 'human.confirmation' },
    { id: LINUX_HUMAN_WITNESS_POINT_IDS.micPhysical, kind: 'recording', machineObservable: false, observedVia: 'human.confirmation' },
    { id: LINUX_HUMAN_WITNESS_POINT_IDS.editorRealUserApp, kind: 'cursor-input', machineObservable: false, observedVia: 'human.confirmation' },
    { id: LINUX_HUMAN_WITNESS_POINT_IDS.visualFocus, kind: 'cursor-input', machineObservable: false, observedVia: 'human.confirmation' },
  ]
}

/** 本纵切片固定的结构性覆盖边界码（项目驱动结果不独立 + 宿主观察受设备与时间约束）。 */
export function linuxCoverageBoundaryCodes(): string[] {
  return [
    ENGINEERING_REAL_BOUNDARY_CODES.projectDriverNotIndependent,
    ENGINEERING_REAL_BOUNDARY_CODES.hostObservationScope,
  ]
}

/* ------------------------------------------------------------------ */
/* 注入依赖：命令执行器 / 时钟 / 环境 / 刺激 / 音频 / pulse / ASR / 靶窗口   */
/* ------------------------------------------------------------------ */

export interface LinuxObserverCommandOptions {
  /** 硬超时（毫秒）：超时即判失败并尽力终止子进程。 */
  timeoutMs: number
  /** 到点后按计划正常终止（parecord 类无自停能力的采集命令用）；缺省不终止。 */
  terminateAfterMs?: number
}

export interface LinuxObserverCommandResult {
  /** 子进程 PID（宿主实测，用于与 pulse 采集流绑定）。 */
  pid: number
  /** 退出码；被信号终止时为 -1（信号名见 `signal`）。 */
  code: number
  signal: string | null
  stdout: string
  stderr: string
}

/** 命令执行器：xdotool / pactl / parecord / ffmpeg / xclip 一律经此接口（可注入、可 fake）。 */
export type LinuxObserverCommandRunner = (
  argv: readonly string[],
  options: LinuxObserverCommandOptions,
) => Promise<LinuxObserverCommandResult>

/** 环境变量读取器：ASR 密钥只经此读取，绝不落盘进观察记录。 */
export type LinuxEnvReader = (name: string) => string | undefined

/** 宿主时钟（与门禁/registry 同源实例；`epoch` 墙钟 + `monotonic` 单调钟）。 */
export type LinuxObserverClock = EngineeringRealClock

/** 全局热键刺激与交付回执。 */
export interface LinuxHotkeyReceipt {
  delivered: boolean
  /** 实际使用的宿主接口名（写进观察结果，供人审计）。 */
  interfaceName: string
  detail: string
}

export interface LinuxHotkeyStimulus {
  /**
   * 注入契约声明的加速器并读回系统层交付回执。
   * 注意：**注入回执 ≠ 产品已响应**；产品的热键监听属被验收项目行为，本观察点只证“系统层已交付”。
   */
  injectAndAwait(accelerator: string, timeoutMs: number): Promise<LinuxHotkeyReceipt>
}

/** PulseAudio/PipeWire 采集流（source-output）事实。 */
export interface LinuxPulseSourceOutput {
  id: string
  sourceName: string
  processId: number | null
}

export interface LinuxPulseProbe {
  listSourceOutputs(): Promise<LinuxPulseSourceOutput[]>
}

export interface LinuxAudioAnalysisConfig {
  /** RMS 下限（0~1，相对满量程）；低于即视为静音。 */
  rmsThreshold: number
  /** 峰值下限（0~1，相对满量程）。 */
  peakThreshold: number
}

export interface LinuxAudioMetrics {
  /** 以下时长 / 采样率均从**采集产物头部解析**，不是调用方传入的自报值。 */
  sampleRate: number
  channels: number
  durationMs: number
  frameCount: number
  rms: number
  peak: number
  nonSilent: boolean
}

export interface LinuxAudioCaptureRequest {
  sourceName: string
  durationMs: number
  sampleRate: number
  channels: number
  /** 采集工具：parecord（默认，G2 工单要求）或 ffmpeg（自停、帧界确定）。 */
  tool?: 'parecord' | 'ffmpeg'
  /** 采集可执行文件（缺省按工具名走 PATH）。 */
  executable?: string
  /** 输出目录（缺省系统临时目录；调用方负责在 ASR 之后清理）。 */
  workingDir?: string
}

export interface LinuxAudioCaptureResult {
  /** 采集进程 PID（宿主实测）。 */
  pid: number
  wavPath: string
  workingDir: string
  /** 采集命令行（不含任何密钥，可进观察材料）。 */
  commandLine: string
  metrics: LinuxAudioMetrics
}

export interface LinuxAudioCapturer {
  /** 执行一次采集并返回采集产物事实（时长/采样率从产物头部解析）。 */
  capture(request: LinuxAudioCaptureRequest): Promise<LinuxAudioCaptureResult>
}

export interface LinuxFocusedWindow {
  windowId: string
  title: string
  className: string
}

export interface LinuxTargetWindowReader {
  /** 刺激：按窗口名激活靶窗口；返回回执（不含项目自报）。 */
  activate(targetApp: string): Promise<{ ok: boolean; windowId: string | null; detail: string }>
  /** 观察：当前焦点窗口 id / 标题 / 类名。 */
  readFocused(): Promise<LinuxFocusedWindow | null>
  /** 观察：靶控件文本或选区内容（靶应用权威通道，非屏幕抓取）。 */
  readBuffer(targetApp: string): Promise<{ text: string; via: string } | null>
}

export interface LinuxAsrTranscribeRequest {
  audioWavPath: string
  durationMs: number
  sampleRate: number
  /** 引擎提示（可选，例如领域/语言）。 */
  engineHint?: string
  /** 密钥的**环境变量名**（值由客户端自行经环境读取，绝不进请求体与记录）。 */
  keyEnvVar: string
  timeoutMs: number
}

export interface LinuxAsrTranscribeResult {
  text: string
  /** 引擎标识（如 doubao-streaming-asr；宿主持有，非项目自报）。 */
  engineId: string
  elapsedMs: number
  requestId: string
  /** 真实上行字节数与采样率（宿主持有的请求事实）。 */
  audioBytes: number
  sampleRate: number
  /** 真实端点主机（可选；不记录完整 URL 与任何密钥）。 */
  engineEndpoint?: string
}

export interface LinuxAsrClient {
  transcribe(request: LinuxAsrTranscribeRequest): Promise<LinuxAsrTranscribeResult>
}

export interface LinuxObserverDeps {
  clock: LinuxObserverClock
  command: LinuxObserverCommandRunner
  env: LinuxEnvReader
  hotkey: LinuxHotkeyStimulus
  audio: LinuxAudioCapturer
  pulse: LinuxPulseProbe
  asr: LinuxAsrClient
  target: LinuxTargetWindowReader
}

/* ------------------------------------------------------------------ */
/* 观察窗口参数与请求 / 结果                                             */
/* ------------------------------------------------------------------ */

export interface LinuxObservationWindows {
  /** 热键注入后的交付回执等待上限。 */
  hotkeyTimeoutMs: number
  /** ASR 单次调用上限。 */
  asrTimeoutMs: number
  /** 采集时长（也是音频点的最短时长口径）。 */
  captureDurationMs: number
  sampleRate: number
  channels: number
  rmsThreshold: number
  peakThreshold: number
  /** 靶窗文本与 ASR 转写的一致性阈值（归一化重叠率）。 */
  matchRatio: number
}

export const LINUX_OBSERVATION_DEFAULT_WINDOWS: LinuxObservationWindows = {
  hotkeyTimeoutMs: 3_000,
  asrTimeoutMs: 20_000,
  captureDurationMs: 2_000,
  sampleRate: 16_000,
  channels: 1,
  rmsThreshold: 0.003,
  peakThreshold: 0.05,
  matchRatio: 0.8,
}

export interface LinuxObservationRequest {
  testId: string
  target: string
  covers: readonly string[]
  sessionId: string
  /** 本轮一次性标识（防重放；由调用方生成，登记后不可复用）。 */
  observationRunId: string
  /** 真实单次批准时刻（墙钟毫秒）；观察窗口从批准起算，不得自造。 */
  approvedAt: number
  /** 真实 permission_request 的 requestId（对账用，不得自造）。 */
  approvalRequestId: string
  /** 契约声明的全局热键加速器（宿主注入刺激）。 */
  accelerator: string
  /** 契约声明的音频源名（PulseAudio/PipeWire source）。 */
  audioSourceName: string
  /** 靶应用标识（如 geany）。 */
  targetApp: string
  /** ASR 密钥的环境变量名（值绝不入库）。 */
  asrKeyEnvVar: string
  asrEngineHint?: string
  /** 可选：被验收工程项目 PID；给出时额外要求存在该 PID + 音源的采集流。 */
  expectedProducerPid?: number
  windows?: Partial<LinuxObservationWindows>
}

export interface LinuxObservationOutcome {
  /** 四个观察点结果（顺序固定：热键 → 音频 → ASR → 插入）。 */
  observations: EngineeringRealObservation[]
  verdict: 'attested' | 'rejected'
  /** 逐点失败说明（人类可读；已脱敏）。 */
  failures: string[]
  startedAt: number
  approvedAt: number
  finishedAt: number
  /** 宿主侧转写摘要（已脱敏；真人语义见证仍由 HumanWitnessReceipt 承担）。 */
  transcript: string
  /** 交给 `registerHostObserverEvidence` 的登记载荷。 */
  registration: EngineeringHostObserverRegistration
}

/* ------------------------------------------------------------------ */
/* 纯函数：WAV 非静音分析 / pulse 解析 / 转写归一化与一致性 / 脱敏          */
/* ------------------------------------------------------------------ */

function readAscii(view: DataView, offset: number, length: number): string {
  let text = ''
  for (let index = 0; index < length; index += 1) text += String.fromCharCode(view.getUint8(offset + index))
  return text
}

/**
 * 从 16bit PCM WAV（s16le）计算 RMS / 峰值 / 时长 / 采样率，并给出非静音判定。
 * 只接受整数 16bit PCM；其他格式直接报错（不猜测、不静默降级）。
 */
export function analyzePcmNonSilence(wav: Uint8Array, config: LinuxAudioAnalysisConfig): LinuxAudioMetrics {
  if (!Number.isFinite(config.rmsThreshold) || !Number.isFinite(config.peakThreshold)) {
    throw new TypeError('非静音阈值必须为有限数字')
  }
  if (wav.byteLength < 44) throw new Error('WAV 数据不足 44 字节，无法解析头部')
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  if (readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') throw new Error('不是 RIFF/WAVE 文件')
  let offset = 12
  let sampleRate = 0
  let channels = 0
  let bitsPerSample = 0
  let audioFormat = 0
  let dataOffset = -1
  let dataSize = 0
  while (offset + 8 <= wav.byteLength) {
    const chunkId = readAscii(view, offset, 4)
    const chunkSize = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (chunkId === 'fmt ' && body + 16 <= wav.byteLength) {
      audioFormat = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bitsPerSample = view.getUint16(body + 14, true)
    } else if (chunkId === 'data') {
      dataOffset = body
      const available = wav.byteLength - body
      // 采集被按计划终止时头部长度字段可能不可信：以实际可读字节为准。
      dataSize = chunkSize > 0 ? Math.min(chunkSize, available) : available
      break
    }
    offset = body + chunkSize + (chunkSize % 2)
  }
  if (audioFormat !== 1 || bitsPerSample !== 16) throw new Error('仅支持 16bit PCM WAV（s16le），当前 format=' + audioFormat + ' bits=' + bitsPerSample)
  if (!channels || !sampleRate) throw new Error('WAV 头部缺少通道数或采样率')
  if (dataOffset < 0 || dataSize < 2) throw new Error('WAV 不含可读音频数据')
  const frameCount = Math.floor(dataSize / (channels * 2))
  let sumSquares = 0
  let peak = 0
  let counted = 0
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const sample = view.getInt16(dataOffset + frame * channels * 2 + channel * 2, true) / 32_768
      sumSquares += sample * sample
      const magnitude = Math.abs(sample)
      if (magnitude > peak) peak = magnitude
      counted += 1
    }
  }
  if (!counted) throw new Error('WAV 不含整数样本')
  const rms = Math.sqrt(sumSquares / counted)
  return {
    sampleRate,
    channels,
    durationMs: (frameCount / sampleRate) * 1_000,
    frameCount,
    rms,
    peak,
    nonSilent: rms >= config.rmsThreshold && peak >= config.peakThreshold,
  }
}

/**
 * 解析 `pactl list source-outputs` 文本：取每条采集流的 id、Source 与 application.process.id。
 * 只做结构化提取，不做任何“猜测归属”。
 */
export function parsePulseSourceOutputs(text: string): LinuxPulseSourceOutput[] {
  const outputs: LinuxPulseSourceOutput[] = []
  let current: LinuxPulseSourceOutput | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    const header = /^Source Output #(\S+)\s*$/.exec(rawLine.trim())
    if (header) {
      if (current) outputs.push(current)
      current = { id: header[1]!, sourceName: '', processId: null }
      continue
    }
    if (!current) continue
    const source = /^Source:\s*(\S+)\s*$/.exec(rawLine.trim())
    if (source) { current.sourceName = source[1]!; continue }
    const pid = /^application\.process\.id\s*=\s*"?(\d+)"?\s*$/.exec(rawLine.trim())
    if (pid) current.processId = Number.parseInt(pid[1]!, 10)
  }
  if (current) outputs.push(current)
  return outputs
}

/** 转写归一化：去标点与空白折叠、统一小写，保留字母/数字/CJK。 */
export function normalizeTranscript(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\u3000]+/g, ' ')
    .replace(/[^\p{L}\p{N} ]+/gu, '')
    .trim()
}

export interface LinuxTranscriptMatch {
  matched: boolean
  /** 字符二元组 Dice 重叠率（0~1）；包含关系视为 1。 */
  ratio: number
  asrNormalized: string
  targetNormalized: string
}

/**
 * 靶窗文本与宿主 ASR 转写的一致性判定（宿主侧启发式，如实披露）：
 * - 任一侧为空 → 不匹配（ratio 0）；
 * - 归一化后互为子串 → 匹配（ratio 1）；
 * - 否则用字符二元组 Dice 重叠率与 `minRatio` 比较。
 * 该判定只回答“两段文本是否一致”，不证明文本由谁写入（那属产品行为）。
 */
export function compareTranscript(asrText: string, targetText: string, options: { minRatio?: number } = {}): LinuxTranscriptMatch {
  const minRatio = options.minRatio ?? 0.8
  if (!Number.isFinite(minRatio) || minRatio < 0 || minRatio > 1) throw new TypeError('minRatio 必须为 0~1 的有限数字')
  const asrNormalized = normalizeTranscript(asrText)
  const targetNormalized = normalizeTranscript(targetText)
  if (!asrNormalized || !targetNormalized) return { matched: false, ratio: 0, asrNormalized, targetNormalized }
  if (asrNormalized === targetNormalized || asrNormalized.includes(targetNormalized) || targetNormalized.includes(asrNormalized)) {
    return { matched: true, ratio: 1, asrNormalized, targetNormalized }
  }
  const bigrams = (value: string): string[] => {
    if (value.length < 2) return [value]
    const result: string[] = []
    for (let index = 0; index + 2 <= value.length; index += 1) result.push(value.slice(index, index + 2))
    return result
  }
  const left = bigrams(asrNormalized.replace(/ /g, ''))
  const right = bigrams(targetNormalized.replace(/ /g, ''))
  const counts = new Map<string, number>()
  for (const gram of right) counts.set(gram, (counts.get(gram) ?? 0) + 1)
  let overlap = 0
  for (const gram of left) {
    const remaining = counts.get(gram) ?? 0
    if (remaining > 0) { overlap += 1; counts.set(gram, remaining - 1) }
  }
  const ratio = (2 * overlap) / (left.length + right.length)
  return { matched: ratio >= minRatio, ratio, asrNormalized, targetNormalized }
}

/** 把密钥值从文本中抹掉（登记前统一调用；只保留变量名）。 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  let result = text
  for (const secret of secrets) {
    if (secret && secret.length > 0) result = result.split(secret).join('[已脱敏]')
  }
  return result
}

/** 检测任意结构中是否残留密钥值；返回首个命中的密钥，未命中返回 null（测试用）。 */
export function findSecretLeak(value: unknown, secrets: readonly string[]): string | null {
  for (const secret of secrets) {
    if (!secret) continue
    if (findInValue(value, secret)) return secret
  }
  return null
}

function findInValue(value: unknown, needle: string): boolean {
  if (typeof value === 'string') return value.includes(needle)
  if (Array.isArray(value)) return value.some((item) => findInValue(item, needle))
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((item) => findInValue(item, needle))
  }
  return false
}

/* ------------------------------------------------------------------ */
/* 默认 Linux 实现（全部基于注入的命令执行器；测试不使用）                   */
/* ------------------------------------------------------------------ */

/** 宿主命令执行器（生产实现；支持硬超时与按计划终止）。 */
export function createHostCommandRunner(): LinuxObserverCommandRunner {
  return (argv, options) => new Promise<LinuxObserverCommandResult>((resolve, reject) => {
    if (!Array.isArray(argv) || argv.length === 0) { reject(new TypeError('命令执行器至少需要一个 argv 元素')); return }
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) { reject(new TypeError('timeoutMs 必须为正数')); return }
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let settled = false
    const finish = (result: LinuxObserverCommandResult): void => {
      if (settled) return
      settled = true
      clearTimeout(hardTimer)
      if (terminateTimer) clearTimeout(terminateTimer)
      resolve(result)
    }
    const hardTimer = setTimeout(() => {
      child.kill('SIGKILL')
      if (!settled) { settled = true; if (terminateTimer) clearTimeout(terminateTimer); reject(new Error('命令超时(' + options.timeoutMs + 'ms)：' + argv.join(' '))) }
    }, options.timeoutMs)
    let terminateTimer: NodeJS.Timeout | null = null
    if (options.terminateAfterMs !== undefined && options.terminateAfterMs > 0) {
      terminateTimer = setTimeout(() => {
        child.kill('SIGINT')
        terminateTimer = setTimeout(() => child.kill('SIGKILL'), 3_000)
      }, options.terminateAfterMs)
    }
    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk))
    child.on('error', (error) => { if (!settled) { settled = true; clearTimeout(hardTimer); reject(error) } })
    child.on('close', (code, signal) => finish({
      pid: child.pid ?? -1,
      code: code === null ? -1 : code,
      signal: signal ?? null,
      stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
      stderr: Buffer.concat(stderrChunks).toString('utf-8'),
    }))
  })
}

export function createProcessEnvReader(): LinuxEnvReader {
  return (name) => process.env[name]
}

/** 加速器 → xdotool 键串（Ctrl+Alt+D → ctrl+alt+d）。 */
export function toXdotoolAccelerator(accelerator: string): string {
  const parts = accelerator.split('+').map((part) => part.trim().toLowerCase()).filter(Boolean)
  if (parts.length === 0) throw new TypeError('加速器不能为空')
  const alias: Record<string, string> = { control: 'ctrl', meta: 'super', command: 'super', cmd: 'super', option: 'alt' }
  return parts.map((part) => alias[part] ?? part).join('+')
}

/**
 * xdotool 全局热键刺激。
 * 回执口径如实标注：默认只有**注入回执**（xdotool 退出码），不给“产品已响应”的结论；
 * 若调用方提供 `confirmDelivery`（宿主自有监听/探测），才升级为“宿主监听已确认”。
 */
export function createXdotoolHotkeyStimulus(
  command: LinuxObserverCommandRunner,
  options: { confirmDelivery?: (accelerator: string) => Promise<boolean> } = {},
): LinuxHotkeyStimulus {
  return {
    async injectAndAwait(accelerator, timeoutMs) {
      const argv = ['xdotool', 'key', '--clearmodifiers', toXdotoolAccelerator(accelerator)]
      const result = await command(argv, { timeoutMs: Math.max(1_000, timeoutMs) })
      const injected = result.code === 0
      let confirmed: boolean | null = null
      if (injected && options.confirmDelivery) {
        try { confirmed = await options.confirmDelivery(accelerator) } catch { confirmed = false }
      }
      const delivered = injected && (confirmed === null || confirmed === true)
      const confirmText = confirmed === null ? '仅注入回执（未接宿主监听）' : (confirmed ? '宿主监听已确认' : '宿主监听未确认')
      return {
        delivered,
        interfaceName: confirmed === null ? 'xdotool-key-injection' : 'xdotool-key-injection+host-listener',
        detail: argv.join(' ') + ' -> exit ' + result.code + (result.signal ? ' signal ' + result.signal : '') + '；交付确认=' + confirmText,
      }
    },
  }
}

/** 基于注入命令执行器的音频采集器（默认 parecord；可切 ffmpeg 以获得确定帧界）。 */
export function createPulseAudioCapturer(
  command: LinuxObserverCommandRunner,
  options: { analysis?: Partial<LinuxAudioAnalysisConfig> } = {},
): LinuxAudioCapturer {
  return {
    async capture(request) {
      if (!request.sourceName) throw new TypeError('采集需要明确的音源名')
      if (!Number.isFinite(request.durationMs) || request.durationMs <= 0) throw new TypeError('采集时长必须为正数')
      if (!Number.isInteger(request.sampleRate) || request.sampleRate <= 0) throw new TypeError('采样率必须为正整数')
      if (!Number.isInteger(request.channels) || request.channels <= 0) throw new TypeError('声道数必须为正整数')
      const tool = request.tool ?? 'parecord'
      const executable = request.executable ?? tool
      const workingDir = request.workingDir ?? mkdtempSync(join(tmpdir(), 'nanju-linux-observer-'))
      const wavPath = join(workingDir, 'capture.wav')
      const argv = tool === 'parecord'
        ? [executable, '--device=' + request.sourceName, '--rate=' + request.sampleRate, '--channels=' + request.channels, '--format=s16le', '--file-format=wav', wavPath]
        : [executable, '-hide_banner', '-loglevel', 'error', '-f', 'pulse', '-i', request.sourceName, '-t', (request.durationMs / 1_000).toFixed(3), '-ar', String(request.sampleRate), '-ac', String(request.channels), '-y', wavPath]
      const result = tool === 'parecord'
        ? await command(argv, { timeoutMs: request.durationMs + 30_000, terminateAfterMs: request.durationMs })
        : await command(argv, { timeoutMs: request.durationMs + 30_000 })
      let bytes: Uint8Array
      try { bytes = readFileSync(wavPath) } catch (error) {
        throw new Error('采集未产出可读 WAV：' + (error instanceof Error ? error.message : String(error))
          + (result.stderr.trim() ? '（stderr: ' + result.stderr.trim().slice(0, 200) + '）' : ''))
      }
      const metrics = analyzePcmNonSilence(bytes, {
        rmsThreshold: options.analysis?.rmsThreshold ?? LINUX_OBSERVATION_DEFAULT_WINDOWS.rmsThreshold,
        peakThreshold: options.analysis?.peakThreshold ?? LINUX_OBSERVATION_DEFAULT_WINDOWS.peakThreshold,
      })
      return { pid: result.pid, wavPath, workingDir, commandLine: argv.join(' '), metrics }
    },
  }
}

/** `pactl list source-outputs` 采集流探测（进程归属与音源绑定的事实来源）。 */
export function createPulseSourceOutputProbe(command: LinuxObserverCommandRunner): LinuxPulseProbe {
  return {
    async listSourceOutputs() {
      const result = await command(['pactl', 'list', 'source-outputs'], { timeoutMs: 5_000 })
      if (result.code !== 0) throw new Error('pactl list source-outputs 失败：exit ' + result.code + (result.stderr.trim() ? '（' + result.stderr.trim().slice(0, 200) + '）' : ''))
      return parsePulseSourceOutputs(result.stdout)
    },
  }
}

/**
 * xdotool 靶窗口读回。
 * - 焦点事实：`xdotool getactivewindow` + `getwindowname` + `getwindowclassname`；
 * - 靶控件文本：全选 + 复制后读 X11 选区（xclip/xsel）——靶应用权威通道，**不是屏幕抓取**；
 *   默认只读，不改写靶内容；`selectAll` 会向靶应用发送 ctrl+a/ctrl+c（属刺激，调用方需在批准范围内）。
 */
export function createLinuxTargetWindowReader(
  command: LinuxObserverCommandRunner,
  options: { clipboardTool?: 'xclip' | 'xsel'; selection?: 'primary' | 'clipboard'; selectAll?: boolean } = {},
): LinuxTargetWindowReader {
  const tool = options.clipboardTool ?? 'xclip'
  const selection = options.selection ?? 'primary'
  const selectAll = options.selectAll ?? true
  return {
    async activate(targetApp) {
      const search = await command(['xdotool', 'search', '--name', targetApp], { timeoutMs: 5_000 })
      const ids = search.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
      if (search.code !== 0 || ids.length === 0) {
        return { ok: false, windowId: null, detail: 'xdotool search --name ' + targetApp + ' -> exit ' + search.code + '，命中 ' + ids.length + ' 个窗口' }
      }
      const windowId = ids[ids.length - 1]!
      const activate = await command(['xdotool', 'windowactivate', '--sync', windowId], { timeoutMs: 5_000 })
      return {
        ok: activate.code === 0,
        windowId,
        detail: 'xdotool search --name ' + targetApp + ' -> #' + windowId + '；windowactivate --sync -> exit ' + activate.code,
      }
    },
    async readFocused() {
      const active = await command(['xdotool', 'getactivewindow'], { timeoutMs: 5_000 })
      const windowId = active.stdout.trim()
      if (active.code !== 0 || !windowId) return null
      const title = await command(['xdotool', 'getwindowname', windowId], { timeoutMs: 5_000 })
      const className = await command(['xdotool', 'getwindowclassname', windowId], { timeoutMs: 5_000 })
      return {
        windowId,
        title: title.code === 0 ? title.stdout.trim() : '',
        className: className.code === 0 ? className.stdout.trim() : '',
      }
    },
    async readBuffer() {
      if (selectAll) {
        const select = await command(['xdotool', 'key', '--clearmodifiers', 'ctrl+a'], { timeoutMs: 5_000 })
        if (select.code !== 0) return null
        const copy = await command(['xdotool', 'key', '--clearmodifiers', 'ctrl+c'], { timeoutMs: 5_000 })
        if (copy.code !== 0) return null
      }
      const argv = tool === 'xclip'
        ? ['xclip', '-selection', selection, '-o']
        : ['xsel', selection === 'primary' ? '--primary' : '--clipboard', '-o']
      const result = await command(argv, { timeoutMs: 5_000 })
      if (result.code !== 0) return null
      return { text: result.stdout, via: tool + '-selection-' + selection }
    },
  }
}

export interface LinuxObserverDepsOptions {
  /** ASR 客户端必须显式注入（宿主/G3 提供真实实现；密钥只在实现内部经环境读取）。 */
  asr: LinuxAsrClient
  command?: LinuxObserverCommandRunner
  clock?: LinuxObserverClock
  env?: LinuxEnvReader
  hotkey?: LinuxHotkeyStimulus
  audio?: LinuxAudioCapturer
  pulse?: LinuxPulseProbe
  target?: LinuxTargetWindowReader
  audioAnalysis?: Partial<LinuxAudioAnalysisConfig>
  targetReader?: { clipboardTool?: 'xclip' | 'xsel'; selection?: 'primary' | 'clipboard'; selectAll?: boolean }
  hotkeyConfirmDelivery?: (accelerator: string) => Promise<boolean>
}

/** 装配默认 Linux 依赖（G3 实机用；本模块自身不发起任何真实命令，命令均在运行时经注入执行器发出）。 */
export function createLinuxObserverDeps(options: LinuxObserverDepsOptions): LinuxObserverDeps {
  const command = options.command ?? createHostCommandRunner()
  return {
    clock: options.clock ?? { epochNow: () => Date.now(), monotonicNow: () => performance.now() },
    command,
    env: options.env ?? createProcessEnvReader(),
    hotkey: options.hotkey ?? createXdotoolHotkeyStimulus(command, {
      ...(options.hotkeyConfirmDelivery ? { confirmDelivery: options.hotkeyConfirmDelivery } : {}),
    }),
    audio: options.audio ?? createPulseAudioCapturer(command, options.audioAnalysis ? { analysis: options.audioAnalysis } : {}),
    pulse: options.pulse ?? createPulseSourceOutputProbe(command),
    asr: options.asr,
    target: options.target ?? createLinuxTargetWindowReader(command, options.targetReader ?? {}),
  }
}

/* ------------------------------------------------------------------ */
/* 观察流程：四观察点（刺激 + 观察 + 一致性判定）                          */
/* ------------------------------------------------------------------ */

function describeError(error: unknown): string {
  if (error instanceof Error) return error.name + '：' + error.message
  return String(error)
}

function makeObservation(pointId: string, expected: string, actual: string, observedVia: string, passed: boolean): EngineeringRealObservation {
  return { pointId, expected, actual, observedVia, passed }
}

function failureObservation(pointId: string, expected: string, observedVia: string, error: unknown): EngineeringRealObservation {
  return makeObservation(pointId, expected, '失败：' + describeError(error), observedVia, false)
}

function assertRequest(request: LinuxObservationRequest): void {
  const required: Array<[string, string]> = [
    ['testId', request.testId],
    ['target', request.target],
    ['sessionId', request.sessionId],
    ['observationRunId', request.observationRunId],
    ['approvalRequestId', request.approvalRequestId],
    ['accelerator', request.accelerator],
    ['audioSourceName', request.audioSourceName],
    ['targetApp', request.targetApp],
    ['asrKeyEnvVar', request.asrKeyEnvVar],
  ]
  for (const [field, value] of required) {
    if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError('观察请求缺少必填字段：' + field)
  }
  if (!Array.isArray(request.covers) || request.covers.some((item) => typeof item !== 'string')) throw new TypeError('covers 必须为字符串数组')
  if (!Number.isFinite(request.approvedAt) || request.approvedAt <= 0) throw new TypeError('approvedAt 必须为真实批准的墙钟毫秒')
  if (request.expectedProducerPid !== undefined && (!Number.isInteger(request.expectedProducerPid) || request.expectedProducerPid <= 0)) {
    throw new TypeError('expectedProducerPid 必须为正整数 PID')
  }
}

function assertWindows(windows: LinuxObservationWindows): void {
  const positives: Array<[string, number]> = [
    ['hotkeyTimeoutMs', windows.hotkeyTimeoutMs],
    ['asrTimeoutMs', windows.asrTimeoutMs],
    ['captureDurationMs', windows.captureDurationMs],
    ['sampleRate', windows.sampleRate],
    ['channels', windows.channels],
  ]
  for (const [field, value] of positives) {
    if (!Number.isFinite(value) || value <= 0) throw new TypeError('观察窗口参数必须为正数：' + field)
  }
  if (!Number.isFinite(windows.rmsThreshold) || windows.rmsThreshold < 0) throw new TypeError('rmsThreshold 必须为非负数')
  if (!Number.isFinite(windows.peakThreshold) || windows.peakThreshold < 0) throw new TypeError('peakThreshold 必须为非负数')
  if (!Number.isFinite(windows.matchRatio) || windows.matchRatio < 0 || windows.matchRatio > 1) throw new TypeError('matchRatio 必须为 0~1')
}

/** 观察点 1：热键交付（宿主注入刺激 + 读回注入回执事实）。 */
async function observeHotkey(
  deps: LinuxObserverDeps,
  request: LinuxObservationRequest,
  windows: LinuxObservationWindows,
): Promise<EngineeringRealObservation> {
  const expected = '宿主注入契约声明的全局热键 ' + request.accelerator + '，并在 ' + windows.hotkeyTimeoutMs + 'ms 内读回系统层交付回执'
  try {
    const receipt = await deps.hotkey.injectAndAwait(request.accelerator, windows.hotkeyTimeoutMs)
    const actual = '接口=' + receipt.interfaceName + '；加速器=' + request.accelerator + '；交付=' + receipt.delivered + '；回执=' + receipt.detail
    return makeObservation(LINUX_OBSERVATION_POINT_IDS.hotkeyDelivered, expected, actual, LINUX_OBSERVATION_VIA.hotkey, receipt.delivered)
  } catch (error) {
    return failureObservation(LINUX_OBSERVATION_POINT_IDS.hotkeyDelivered, expected, LINUX_OBSERVATION_VIA.hotkey, error)
  }
}

/** 观察点 2：音频采集非静音 + 采集进程/音源绑定（宿主自身采集，非项目自报）。 */
async function observeAudio(
  deps: LinuxObserverDeps,
  request: LinuxObservationRequest,
  windows: LinuxObservationWindows,
): Promise<{ observation: EngineeringRealObservation; capture: LinuxAudioCaptureResult | null }> {
  const expected = '从音源 ' + request.audioSourceName + ' 采集 ' + windows.captureDurationMs + 'ms、采样率 ' + windows.sampleRate
    + 'Hz，产物非静音（RMS ≥ ' + windows.rmsThreshold + '、峰值 ≥ ' + windows.peakThreshold + '），'
    + '且存在绑定该采集进程 PID' + (request.expectedProducerPid !== undefined ? ' 与工程 PID ' + request.expectedProducerPid : '') + ' 的 pulse 采集流'
  try {
    const capture = await deps.audio.capture({
      sourceName: request.audioSourceName,
      durationMs: windows.captureDurationMs,
      sampleRate: windows.sampleRate,
      channels: windows.channels,
    })
    const metrics = capture.metrics
    let outputs: LinuxPulseSourceOutput[] = []
    let probeError: string | null = null
    try { outputs = await deps.pulse.listSourceOutputs() } catch (error) { probeError = describeError(error) }
    const bound = outputs.find((item) => item.processId === capture.pid && item.sourceName === request.audioSourceName) ?? null
    const producerBound = request.expectedProducerPid === undefined
      ? null
      : outputs.some((item) => item.processId === request.expectedProducerPid && item.sourceName === request.audioSourceName)
    const passed = probeError === null
      && metrics.nonSilent
      && metrics.sampleRate === windows.sampleRate
      && metrics.durationMs >= windows.captureDurationMs
      && bound !== null
      && producerBound !== false
    const actual = '音源=' + request.audioSourceName
      + '；采集PID=' + capture.pid
      + '；产物时长=' + Math.round(metrics.durationMs) + 'ms'
      + '；产物采样率=' + metrics.sampleRate + 'Hz'
      + '；通道=' + metrics.channels
      + '；帧数=' + metrics.frameCount
      + '；RMS=' + metrics.rms.toFixed(6)
      + '；峰值=' + metrics.peak.toFixed(4)
      + '；非静音=' + metrics.nonSilent
      + '；采集流绑定=' + (bound ? 'source-output#' + bound.id : '未找到')
      + (producerBound === null ? '' : '；工程采集流(PID ' + request.expectedProducerPid + ')=' + (producerBound ? '已绑定' : '未找到'))
      + (probeError ? '；pulse 探测失败：' + probeError : '')
    return { observation: makeObservation(LINUX_OBSERVATION_POINT_IDS.recordingStarted, expected, actual, LINUX_OBSERVATION_VIA.audio, passed), capture }
  } catch (error) {
    return { observation: failureObservation(LINUX_OBSERVATION_POINT_IDS.recordingStarted, expected, LINUX_OBSERVATION_VIA.audio, error), capture: null }
  }
}

/** 观察点 3：ASR 真实调用（请求事实 + 响应文本 + 耗时 + 引擎标识；密钥只引用环境变量名）。 */
async function observeAsr(
  deps: LinuxObserverDeps,
  request: LinuxObservationRequest,
  windows: LinuxObservationWindows,
  capture: LinuxAudioCaptureResult | null,
): Promise<{ observation: EngineeringRealObservation; transcript: string }> {
  const expected = '调用注入的 ASR 客户端（密钥经环境变量 ' + request.asrKeyEnvVar + ' 引用），'
    + '并在 ' + windows.asrTimeoutMs + 'ms 内返回非空转写，附带引擎标识与耗时'
  if (!capture) {
    return {
      observation: makeObservation(LINUX_OBSERVATION_POINT_IDS.asrRealEndpoint, expected, '失败：音频采集未产出可用产物，未发起 ASR 调用', LINUX_OBSERVATION_VIA.asr, false),
      transcript: '',
    }
  }
  if (!deps.env(request.asrKeyEnvVar)) {
    // 密钥缺失即不发起调用：不猜测、不用空密钥试探，观察点直接判失败。
    return {
      observation: makeObservation(LINUX_OBSERVATION_POINT_IDS.asrRealEndpoint, expected, '失败：密钥环境变量 ' + request.asrKeyEnvVar + ' 未设置（未发起任何 ASR 调用）', LINUX_OBSERVATION_VIA.asr, false),
      transcript: '',
    }
  }
  try {
    const result = await deps.asr.transcribe({
      audioWavPath: capture.wavPath,
      durationMs: Math.round(capture.metrics.durationMs),
      sampleRate: capture.metrics.sampleRate,
      ...(request.asrEngineHint ? { engineHint: request.asrEngineHint } : {}),
      keyEnvVar: request.asrKeyEnvVar,
      timeoutMs: windows.asrTimeoutMs,
    })
    const text = typeof result.text === 'string' ? result.text.trim() : ''
    const passed = text.length > 0 && Number.isFinite(result.elapsedMs) && result.elapsedMs >= 0
    const actual = '引擎=' + result.engineId
      + '；耗时=' + Math.round(result.elapsedMs) + 'ms'
      + '；上行字节=' + result.audioBytes
      + '；上行采样率=' + result.sampleRate + 'Hz'
      + '；端点=' + (result.engineEndpoint ?? '未声明')
      + '；请求id=' + result.requestId
      + '；密钥环境变量=' + request.asrKeyEnvVar + '(存在)'
      + '；转写长度=' + text.length
      + '；转写=' + (text.length > 120 ? text.slice(0, 120) + '…' : text)
    return { observation: makeObservation(LINUX_OBSERVATION_POINT_IDS.asrRealEndpoint, expected, actual, LINUX_OBSERVATION_VIA.asr, passed), transcript: text }
  } catch (error) {
    return {
      observation: failureObservation(LINUX_OBSERVATION_POINT_IDS.asrRealEndpoint, expected, LINUX_OBSERVATION_VIA.asr, error),
      transcript: '',
    }
  }
}

function matchesAppName(value: string, targetApp: string): boolean {
  return value.trim().toLowerCase().includes(targetApp.trim().toLowerCase())
}

/** 观察点 4：靶窗口聚焦 + 靶控件文本与 ASR 转写一致性（宿主激活刺激 + 靶应用权威读回）。 */
async function observeInsert(
  deps: LinuxObserverDeps,
  request: LinuxObservationRequest,
  windows: LinuxObservationWindows,
  transcript: string,
): Promise<EngineeringRealObservation> {
  const expected = 'xdotool 激活靶窗口 ' + request.targetApp + ' 后焦点窗口类名/标题匹配，'
    + '且靶控件文本与宿主 ASR 转写一致（归一化重叠率 ≥ ' + windows.matchRatio + '）'
  try {
    const activation = await deps.target.activate(request.targetApp)
    const focused = activation.ok ? await deps.target.readFocused() : null
    const focusMatches = focused !== null && (matchesAppName(focused.className, request.targetApp) || matchesAppName(focused.title, request.targetApp))
    const buffer = focusMatches ? await deps.target.readBuffer(request.targetApp) : null
    const match = buffer ? compareTranscript(transcript, buffer.text, { minRatio: windows.matchRatio }) : null
    const passed = activation.ok && focusMatches && buffer !== null && match !== null && match.matched
    const actual = '激活=' + activation.detail
      + '；焦点窗口=' + (focused ? 'id=' + focused.windowId + ', 标题=' + focused.title + ', 类名=' + focused.className : '不可读')
      + '；焦点匹配=' + focusMatches
      + '；读回通道=' + (buffer ? buffer.via : '未读回')
      + '；靶文本长度=' + (buffer ? buffer.text.length : 0)
      + '；归一化重叠率=' + (match ? match.ratio.toFixed(4) : '0')
      + '；一致性=' + (match ? match.matched : false)
      + '；ASR 转写长度=' + transcript.length
    return makeObservation(LINUX_OBSERVATION_POINT_IDS.cursorInputPasted, expected, actual, LINUX_OBSERVATION_VIA.insert, passed)
  } catch (error) {
    return failureObservation(LINUX_OBSERVATION_POINT_IDS.cursorInputPasted, expected, LINUX_OBSERVATION_VIA.insert, error)
  }
}

/**
 * 执行一轮 Linux 纵切片观察：热键 → 音频 → ASR → 插入。
 * 每个观察点必定产出**恰好一条**观察结果（顺序固定）；任一点失败即整轮 `rejected`（不登记）。
 * 参数错误（缺字段 / 非法窗口参数）抛 `TypeError`（编程错误，不伪装成观察结论）。
 */
export async function runLinuxDesktopObservation(
  deps: LinuxObserverDeps,
  request: LinuxObservationRequest,
): Promise<LinuxObservationOutcome> {
  assertRequest(request)
  const windows: LinuxObservationWindows = { ...LINUX_OBSERVATION_DEFAULT_WINDOWS, ...(request.windows ?? {}) }
  assertWindows(windows)
  const startedAt = request.approvedAt
  const rawObservations: EngineeringRealObservation[] = []

  rawObservations.push(await observeHotkey(deps, request, windows))
  const audio = await observeAudio(deps, request, windows)
  rawObservations.push(audio.observation)
  const asr = await observeAsr(deps, request, windows, audio.capture)
  rawObservations.push(asr.observation)
  rawObservations.push(await observeInsert(deps, request, windows, asr.transcript))

  const finishedAt = deps.clock.epochNow()
  const secrets = [deps.env(request.asrKeyEnvVar) ?? ''].filter((value) => value.length > 0)
  const observations = rawObservations.map((item) => ({
    ...item,
    expected: redactSecrets(item.expected, secrets),
    actual: redactSecrets(item.actual, secrets),
  }))
  const transcript = redactSecrets(asr.transcript, secrets)
  const clockAdvanced = Number.isFinite(finishedAt) && finishedAt > startedAt
  const failures = observations.filter((item) => !item.passed).map((item) => item.pointId + '：' + item.actual)
  if (!clockAdvanced) failures.push('宿主时钟未推进（finishedAt ≤ startedAt），本轮观察窗口非法')
  const verdict: LinuxObservationOutcome['verdict'] = failures.length === 0 ? 'attested' : 'rejected'
  return {
    observations,
    verdict,
    failures,
    startedAt,
    approvedAt: request.approvedAt,
    finishedAt,
    transcript,
    registration: {
      testId: request.testId,
      target: request.target,
      covers: [...request.covers],
      sessionId: request.sessionId,
      observationRunId: request.observationRunId,
      startedAt,
      approvedAt: request.approvedAt,
      finishedAt,
      observations,
      points: linuxObservationPoints(),
      verdict,
      coverageBoundaryCodes: linuxCoverageBoundaryCodes(),
      approval: { requestId: request.approvalRequestId, cancelled: false },
    },
  }
}

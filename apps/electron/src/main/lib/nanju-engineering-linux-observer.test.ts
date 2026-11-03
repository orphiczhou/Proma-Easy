/**
 * G2｜Linux 宿主观察器（host observer）与 REAL 门禁接线测试。
 *
 * 测试口径（全部 fake，**不**接触真实设备/麦克风/网络/GUI/命令）：
 * - 纯函数：WAV 非静音分析、pactl 文本解析、转写归一化/一致性、脱敏；
 * - 观察流程：四个观察点各自的正常路径与失败路径（热键未交付、静音音频、采样率/时长不符、
 *   采集流未绑定、ASR 超时/空文本/密钥缺失、窗口未聚焦、激活失败、读回失败、文本不匹配）；
 * - 默认实现：用**注入的假命令执行器**走 `createLinuxObserverDeps` 装配（断言 argv，不真跑命令）；
 * - 门禁接线：真实协议 + 真实 registry（经 `nanju-engineering-real-gate`）与 fixture 工程目录，
 *   证明“登记 → 观察期 completeness 通过 → 交付门（带 ack 收据）通过 → 二次交付被拒”。
 *
 * 说明：`nanju-engineering-real-gate` 的契约捕获模块会被并行测试文件 mock（同进程内 mock 会互相影响），
 * 因此 fixture 目录同时准备真实契约（`03_ARCHITECTURE/engineering.json`）与被 mock 时使用的镜像契约
 * （`07_ENGINEERING/contract.md`），两种情况下“登记”与“门禁”读到的值都自洽。
 *
 * Bun 独立运行：`bun test apps/electron/src/main/lib/nanju-engineering-linux-observer.test.ts`
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  LINUX_HUMAN_WITNESS_POINT_IDS,
  LINUX_OBSERVATION_POINT_IDS,
  LINUX_OBSERVATION_VIA,
  analyzePcmNonSilence,
  compareTranscript,
  createLinuxObserverDeps,
  createLinuxTargetWindowReader,
  createPulseAudioCapturer,
  createPulseSourceOutputProbe,
  createXdotoolHotkeyStimulus,
  findSecretLeak,
  linuxCoverageBoundaryCodes,
  linuxHumanWitnessPoints,
  linuxObservationPoints,
  normalizeTranscript,
  parsePulseSourceOutputs,
  redactSecrets,
  runLinuxDesktopObservation,
  toXdotoolAccelerator,
} from './nanju-engineering-linux-observer'
import type {
  LinuxAsrClient,
  LinuxAsrTranscribeRequest,
  LinuxAudioCapturer,
  LinuxAudioMetrics,
  LinuxFocusedWindow,
  LinuxHotkeyStimulus,
  LinuxObserverCommandOptions,
  LinuxObserverCommandResult,
  LinuxObserverCommandRunner,
  LinuxObserverDeps,
  LinuxObservationRequest,
  LinuxPulseProbe,
  LinuxPulseSourceOutput,
  LinuxTargetWindowReader,
} from './nanju-engineering-linux-observer'
import * as gate from './nanju-engineering-real-gate'
import type { EngineeringHostObserverRegistration } from './nanju-engineering-real-gate'

/* ------------------------------------------------------------------ */
/* 通用夹具                                                             */
/* ------------------------------------------------------------------ */

const TEST_ID = 'acc-voice-desktop'
const TARGET_FILE = 'main.py'
const SESSION_ID = 'session-g2'
const RUN_ID = 'run-g2-1'
const SOURCE_NAME = 'alsa_input.pci-0000_00_1f.3.analog-stereo'
const SECRET_VALUE = 'sk-super-secret-value-1234'
const KEY_ENV = 'FAKE_ASR_KEY'
const TRANSCRIPT = '打开文件并保存'
const BASE_EPOCH = Date.now() - 3_000

const TARGET = { testId: TEST_ID, target: TARGET_FILE, covers: ['US-01'] as const }

const CONTRACT_JSON = JSON.stringify({
  schemaVersion: 1,
  target: { platform: 'linux-desktop', kind: 'desktop', entry: TARGET_FILE },
  artifacts: [TARGET_FILE],
  build: '无需构建：纯本地脚本，直接由宿主观察器驱动的验收对象',
  run: '由宿主观察器在批准后驱动',
  tests: [
    {
      id: TEST_ID,
      layer: 'acceptance',
      adapter: 'native-driver',
      target: TARGET_FILE,
      command: '由宿主观察器实测：热键 → 录音 → ASR → 靶窗口读回',
      covers: ['US-01'],
      requiresReal: true,
    },
  ],
}, null, 2)

/** 兼容并行测试文件对契约模块的 mock（其契约路径被固定为 `07_ENGINEERING/contract.md`）。 */
const CONTRACT_MIRROR_TEXT = '# G2 夹具契约（镜像，供被 mock 的契约路径读取）\n'

function makeProjectDir(prefix = 'g2-observer-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  mkdirSync(join(dir, '01_PRD'), { recursive: true })
  writeFileSync(join(dir, '01_PRD', 'prd.md'), '# PRD（G2 夹具）\n')
  mkdirSync(join(dir, '03_ARCHITECTURE'), { recursive: true })
  writeFileSync(join(dir, '03_ARCHITECTURE', 'engineering.json'), CONTRACT_JSON)
  mkdirSync(join(dir, '08_APP'), { recursive: true })
  writeFileSync(join(dir, '08_APP', TARGET_FILE), 'print("ok")\n')
  mkdirSync(join(dir, '07_ENGINEERING'), { recursive: true })
  writeFileSync(join(dir, '07_ENGINEERING', 'contract.md'), CONTRACT_MIRROR_TEXT)
  return dir
}

const DEVICE_DETAIL = { audioSource: SOURCE_NAME, accelerator: 'Ctrl+Alt+D', targetApp: 'geany' }

function scopeFor(projectDir: string) {
  return {
    workspaceSlug: 'ws-g2',
    projectId: 'p2',
    sessionId: SESSION_ID,
    projectDir,
    deviceDetail: { ...DEVICE_DETAIL },
  }
}

/* ------------------------------------------------------------------ */
/* fake 依赖                                                            */
/* ------------------------------------------------------------------ */

interface FakeState {
  /** 命令执行记录（断言 argv，不真执行）。 */
  commands: string[][]
  asrCalls: LinuxAsrTranscribeRequest[]
  hotkeyCalls: string[]
  audioCalls: unknown[]
}

interface FakeOptions {
  hotkeyDelivered?: boolean
  audio?: LinuxAudioCapturer
  sourceOutputs?: LinuxPulseSourceOutput[]
  asr?: LinuxAsrClient
  focused?: LinuxFocusedWindow | null
  activateOk?: boolean
  buffer?: { text: string; via: string } | null
  clock?: LinuxObserverDeps['clock']
  env?: Record<string, string | undefined>
}

function nonSilentMetrics(sampleRate = 16_000, durationMs = 2_000): LinuxAudioMetrics {
  return {
    sampleRate,
    channels: 1,
    durationMs,
    frameCount: Math.round((sampleRate * durationMs) / 1_000),
    rms: 0.12,
    peak: 0.4,
    nonSilent: true,
  }
}

function makeAudioCapturer(overrides: Partial<Parameters<LinuxAudioCapturer['capture']>[0]> & { metrics?: LinuxAudioMetrics; throwMessage?: string } = {}): LinuxAudioCapturer {
  return {
    async capture(request) {
      if (overrides.throwMessage) throw new Error(overrides.throwMessage)
      return {
        pid: 4_711,
        wavPath: '/tmp/fake-capture.wav',
        workingDir: '/tmp',
        commandLine: 'parecord --device=' + request.sourceName,
        metrics: overrides.metrics ?? nonSilentMetrics(request.sampleRate, request.durationMs),
      }
    },
  }
}

function makeAsrClient(overrides: {
  text?: string
  elapsedMs?: number
  throwMessage?: string
  state?: FakeState
} = {}): LinuxAsrClient {
  return {
    async transcribe(request) {
      overrides.state?.asrCalls.push(request)
      if (overrides.throwMessage) throw new Error(overrides.throwMessage)
      return {
        text: overrides.text ?? TRANSCRIPT,
        engineId: 'fake-asr@1',
        elapsedMs: overrides.elapsedMs ?? 812,
        requestId: 'asr-req-1',
        audioBytes: 64_000,
        sampleRate: request.sampleRate,
        engineEndpoint: 'asr.local:9443',
      }
    },
  }
}

function makeDeps(options: FakeOptions = {}): { deps: LinuxObserverDeps; state: FakeState } {
  const state: FakeState = { commands: [], asrCalls: [], hotkeyCalls: [], audioCalls: [] }
  const hotkey: LinuxHotkeyStimulus = {
    async injectAndAwait(accelerator) {
      state.hotkeyCalls.push(accelerator)
      const delivered = options.hotkeyDelivered ?? true
      return {
        delivered,
        interfaceName: 'xdotool-key-injection',
        detail: 'xdotool key --clearmodifiers ctrl+alt+d -> exit ' + (delivered ? 0 : 1) + '；交付确认=仅注入回执（未接宿主监听）',
      }
    },
  }
  const pulse: LinuxPulseProbe = {
    async listSourceOutputs() {
      if (options.sourceOutputs) return options.sourceOutputs
      return [{ id: '42', sourceName: SOURCE_NAME, processId: 4_711 }]
    },
  }
  const target: LinuxTargetWindowReader = {
    async activate() {
      const ok = options.activateOk ?? true
      return { ok, windowId: ok ? '1042' : null, detail: 'xdotool search --name geany -> #1042；windowactivate --sync -> exit ' + (ok ? 0 : 1) }
    },
    async readFocused() {
      if (options.focused === null) return null
      return options.focused ?? { windowId: '1042', title: 'main.py - Geany', className: 'Geany' }
    },
    async readBuffer() {
      if (options.buffer === null) return null
      return options.buffer ?? { text: TRANSCRIPT, via: 'xclip-selection-primary' }
    },
  }
  const audio = options.audio ?? makeAudioCapturer()
  const deps: LinuxObserverDeps = {
    // 默认演示时钟：墙钟向后 1ms，保证 finishedAt > startedAt(=approvedAt) 且 finishedAt ≤ 宿主墙钟。
    clock: options.clock ?? { epochNow: () => Date.now() - 1, monotonicNow: () => Date.now() - 1 },
    command: async () => { throw new Error('本用例不应发起真实命令') },
    env: (name) => (options.env ?? { [KEY_ENV]: SECRET_VALUE })[name],
    hotkey,
    audio: {
      async capture(request) {
        state.audioCalls.push(request)
        return audio.capture(request)
      },
    },
    pulse,
    asr: options.asr ?? makeAsrClient({ state }),
    target,
  }
  return { deps, state }
}

function makeRequest(overrides: Partial<LinuxObservationRequest> = {}): LinuxObservationRequest {
  return {
    testId: TEST_ID,
    target: TARGET_FILE,
    covers: [...TARGET.covers],
    sessionId: SESSION_ID,
    observationRunId: RUN_ID,
    approvedAt: BASE_EPOCH,
    approvalRequestId: 'permission-approve-g2',
    accelerator: 'Ctrl+Alt+D',
    audioSourceName: SOURCE_NAME,
    targetApp: 'geany',
    asrKeyEnvVar: KEY_ENV,
    ...overrides,
  }
}

function pointOf(observations: readonly { pointId: string }[], pointId: string) {
  const hit = observations.find((item) => item.pointId === pointId)
  if (!hit) throw new Error('缺少观察点：' + pointId)
  return hit as { pointId: string; expected: string; actual: string; observedVia: string; passed: boolean }
}

/* ------------------------------------------------------------------ */
/* 纯函数                                                              */
/* ------------------------------------------------------------------ */

function buildWav(options: { sampleRate: number; channels: number; frames: number; amplitude: number }): Buffer {
  const { sampleRate, channels, frames, amplitude } = options
  const bytesPerFrame = channels * 2
  const dataSize = frames * bytesPerFrame
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * bytesPerFrame, 28)
  buffer.writeUInt16LE(bytesPerFrame, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataSize, 40)
  const amplitudeSample = Math.round(amplitude * 32_767)
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      buffer.writeInt16LE(frame % 2 === 0 ? amplitudeSample : -amplitudeSample, 44 + frame * bytesPerFrame + channel * 2)
    }
  }
  return buffer
}

describe('G2｜纯函数：WAV 非静音 / pactl 解析 / 转写一致性 / 脱敏', () => {
  test('Given 非静音 16bit PCM WAV When 分析 Then 从产物头部解析时长采样率且判非静音', () => {
    const wav = buildWav({ sampleRate: 16_000, channels: 1, frames: 8_000, amplitude: 0.2 })
    const metrics = analyzePcmNonSilence(new Uint8Array(wav), { rmsThreshold: 0.003, peakThreshold: 0.05 })
    expect(metrics.sampleRate).toBe(16_000)
    expect(metrics.channels).toBe(1)
    expect(metrics.durationMs).toBeCloseTo(500, 3)
    expect(metrics.rms).toBeGreaterThan(0.15)
    expect(metrics.peak).toBeCloseTo(0.2, 3)
    expect(metrics.nonSilent).toBe(true)
  })

  test('Given 全零样本（静音）When 分析 Then 非静音为 false', () => {
    const wav = buildWav({ sampleRate: 16_000, channels: 1, frames: 4_000, amplitude: 0 })
    const metrics = analyzePcmNonSilence(new Uint8Array(wav), { rmsThreshold: 0.003, peakThreshold: 0.05 })
    expect(metrics.rms).toBe(0)
    expect(metrics.peak).toBe(0)
    expect(metrics.nonSilent).toBe(false)
  })

  test('Given 非 WAVE 或非 16bit 数据 When 分析 Then 明确报错（不猜测、不静默降级）', () => {
    expect(() => analyzePcmNonSilence(new Uint8Array(64), { rmsThreshold: 0.003, peakThreshold: 0.05 })).toThrow(/WAV/)
    const wav = buildWav({ sampleRate: 16_000, channels: 1, frames: 100, amplitude: 0.1 })
    wav.writeUInt16LE(3, 34) // 改成 24bit，应被拒
    expect(() => analyzePcmNonSilence(new Uint8Array(wav), { rmsThreshold: 0.003, peakThreshold: 0.05 })).toThrow(/16bit/)
  })

  test('Given pactl 文本 When 解析 Then 取得采集流 id / 音源名 / 进程号', () => {
    const text = [
      'Source Output #42',
      '\tDriver: PipeWire',
      '\tSource: alsa_input.fake-mic',
      '\tapplication.process.id = "4711"',
      '',
      'Source Output #43',
      '\tSource: alsa_input.fake-mic',
      '\tapplication.name = "parecord"',
    ].join('\n')
    const outputs = parsePulseSourceOutputs(text)
    expect(outputs).toEqual([
      { id: '42', sourceName: 'alsa_input.fake-mic', processId: 4_711 },
      { id: '43', sourceName: 'alsa_input.fake-mic', processId: null },
    ])
  })

  test('Given 转写与靶文本（仅标点/大小写差异）When 比对 Then 一致且重叠率为 1', () => {
    const match = compareTranscript('打开文件，并保存。', '打开文件 并保存')
    expect(match.matched).toBe(true)
    expect(match.ratio).toBe(1)
    expect(normalizeTranscript('Hello, World!')).toBe('hello world')
  })

  test('Given 文本完全不同或为空 When 比对 Then 不匹配（ratio 0）', () => {
    expect(compareTranscript('保存文件', '删除整个目录').matched).toBe(false)
    expect(compareTranscript('', '保存文件').matched).toBe(false)
    expect(compareTranscript('保存文件', '   ').ratio).toBe(0)
  })

  test('Given 部分重叠文本 When 比对 Then 重叠率受 minRatio 控制（非包含关系）', () => {
    const match = compareTranscript('打开文件并保存到桌面', '保存文件到桌面并关闭', { minRatio: 0.99 })
    expect(match.ratio).toBeGreaterThan(0)
    expect(match.ratio).toBeLessThan(1)
    expect(match.matched).toBe(false)
    expect(compareTranscript('打开文件并保存到桌面', '保存文件到桌面并关闭', { minRatio: 0.01 }).matched).toBe(true)
    // 包含关系（归一化后子串）直接判一致，ratio = 1
    const contained = compareTranscript('打开文件并保存到桌面', '打开文件', { minRatio: 0.99 })
    expect(contained.ratio).toBe(1)
    expect(contained.matched).toBe(true)
  })

  test('Given 加速器字符串 When 转 xdotool 键串 Then 修饰键归一化', () => {
    expect(toXdotoolAccelerator('Ctrl+Alt+D')).toBe('ctrl+alt+d')
    expect(toXdotoolAccelerator('Command+Shift+Space')).toBe('super+shift+space')
    expect(() => toXdotoolAccelerator('   ')).toThrow()
  })

  test('Given 含密钥文本 When 脱敏与泄漏扫描 Then 值被抹掉且可被检出', () => {
    const text = '密钥=' + SECRET_VALUE + '（只在环境变量里）'
    const redacted = redactSecrets(text, [SECRET_VALUE])
    expect(redacted).not.toContain(SECRET_VALUE)
    expect(redacted).toContain('[已脱敏]')
    expect(findSecretLeak({ a: [1, { b: redacted }] }, [SECRET_VALUE])).toBeNull()
    expect(findSecretLeak({ a: text }, [SECRET_VALUE])).toBe(SECRET_VALUE)
  })
})

/* ------------------------------------------------------------------ */
/* 观察流程：正常 + 四观察点失败路径                                       */
/* ------------------------------------------------------------------ */

describe('G2｜观察流程：正常路径', () => {
  test('Given 四项系统事实齐备 When 跑一轮观察 Then 四点全过、attested、observedVia 与声明一致', async () => {
    const { deps, state } = makeDeps()
    const outcome = await runLinuxDesktopObservation(deps, makeRequest())

    expect(outcome.verdict).toBe('attested')
    expect(outcome.failures).toEqual([])
    expect(outcome.observations).toHaveLength(4)
    expect(outcome.observations.map((item) => item.pointId)).toEqual([
      LINUX_OBSERVATION_POINT_IDS.hotkeyDelivered,
      LINUX_OBSERVATION_POINT_IDS.recordingStarted,
      LINUX_OBSERVATION_POINT_IDS.asrRealEndpoint,
      LINUX_OBSERVATION_POINT_IDS.cursorInputPasted,
    ])
    const declared = new Map(linuxObservationPoints().map((point) => [point.id, point.observedVia]))
    for (const observation of outcome.observations) {
      expect(observation.passed).toBe(true)
      expect(observation.actual.length).toBeGreaterThan(10)
      expect(observation.observedVia).toBe(declared.get(observation.pointId) ?? '')
    }
    expect(pointOf(outcome.observations, LINUX_OBSERVATION_POINT_IDS.recordingStarted).actual).toContain('非静音=true')
    expect(pointOf(outcome.observations, LINUX_OBSERVATION_POINT_IDS.asrRealEndpoint).actual).toContain('转写长度=' + TRANSCRIPT.length)
    expect(pointOf(outcome.observations, LINUX_OBSERVATION_POINT_IDS.cursorInputPasted).actual).toContain('一致性=true')
    expect(state.hotkeyCalls).toEqual(['Ctrl+Alt+D'])
    expect(state.asrCalls).toHaveLength(1)
    expect(outcome.registration.verdict).toBe('attested')
    expect(outcome.registration.points).toHaveLength(4)
    expect(outcome.finishedAt).toBeGreaterThan(outcome.startedAt)
  })

  test('Given 密钥存在 When 出具观察结论 Then 只记录环境变量名、绝不含密钥值', async () => {
    const { deps } = makeDeps()
    const outcome = await runLinuxDesktopObservation(deps, makeRequest())
    expect(pointOf(outcome.observations, LINUX_OBSERVATION_POINT_IDS.asrRealEndpoint).actual).toContain('密钥环境变量=' + KEY_ENV + '(存在)')
    expect(findSecretLeak(outcome, [SECRET_VALUE])).toBeNull()
  })
})

describe('G2｜观察流程：四观察点失败路径', () => {
  test('Given 热键未被交付 When 观察 Then 热键点失败且整轮 rejected', async () => {
    const { deps } = makeDeps({ hotkeyDelivered: false })
    const outcome = await runLinuxDesktopObservation(deps, makeRequest())
    const hotkey = pointOf(outcome.observations, LINUX_OBSERVATION_POINT_IDS.hotkeyDelivered)
    expect(hotkey.passed).toBe(false)
    expect(hotkey.actual).toContain('交付=false')
    expect(outcome.verdict).toBe('rejected')
    expect(outcome.failures.some((item) => item.startsWith(LINUX_OBSERVATION_POINT_IDS.hotkeyDelivered))).toBe(true)
  })

  test('Given 采集到静音音频 When 观察 Then 音频点失败', async () => {
    const silent = nonSilentMetrics()
    const { deps } = makeDeps({
      audio: makeAudioCapturer({ metrics: { ...silent, rms: 0, peak: 0, nonSilent: false } }),
    })
    const outcome = await runLinuxDesktopObservation(deps, makeRequest())
    const audio = pointOf(outcome.observations, LINUX_OBSERVATION_POINT_IDS.recordingStarted)
    expect(audio.passed).toBe(false)
    expect(audio.actual).toContain('非静音=false')
    expect(outcome.verdict).toBe('rejected')
  })

  test('Given 采集采样率与契约不符 When 观察 Then 音频点失败', async () => {
    const { deps } = makeDeps({ audio: makeAudioCapturer({ metrics: nonSilentMetrics(8_000, 2_000) }) })
    const outcome = await runLinuxDesktopObservation(deps, makeRequest())
    expect(pointOf(outcome.observations, LINUX_OBSERVATION_POINT_IDS.recordingStarted).passed).toBe(false)
    expect(outcome.verdict).toBe('rejected')
  })

  test('Given 采集时长不足 When 观察 Then 音频点失败', async () => {
    const { deps } = makeDeps({ audio: makeAudioCapturer({ metrics: nonSilentMetrics(16_000, 500) }) })
    const outcome = await runLinuxDesktopObservation(deps, makeRequest())
    const audio = pointOf(outcome.observations, LINUX_OBSERVATION_POINT_IDS.recordingStarted)
    expect(audio.passed).toBe(false)
    expect(audio.actual).toContain('产物时长=500ms')
  })

  test('Given 无绑定采集进程的 pulse 采集流 When 观察 Then 音频点失败', async () => {
    const { deps } = makeDeps({ sourceOutputs: [{ id: '9', sourceName: SOURCE_NAME, processId: 999_999 }] })
    const outcome = await runLinuxDesktopObservation(deps, makeRequest())
    const audio = pointOf(outcome.observations, LINUX_OBSERVATION_POINT_IDS.recordingStarted)
    expect(audio.passed).toBe(false)
    expect(audio.actual).toContain('采集流绑定=未找到')
  })

  test('Given 给出了工程 PID 但无该进程采集流 When 观察 Then 音频点失败', async () => {
    const { deps } = makeDeps()
    const outcome = await runLinuxDesktopObservation(deps, makeRequest({ expectedProducerPid: 8_888 }))
    const audio = pointOf(outcome.observations, LINUX_OBSERVATION_POINT_IDS.recordingStarted)
    expect(audio.passed).toBe(false)
    expect(audio.actual).toContain('工程采集流(PID 8888)=未找到')
  })

  test('Given 采集未产出可读 WAV When 观察 Then 音频点失败且不抛穿', async () => {
    const { deps } = makeDeps({ audio: makeAudioCapturer({ throwMessage: '采集未产出可读 WAV：ENOENT' }) })
    const outcome = await runLinuxDesktopObservation(deps, makeRequest())
    expect(pointOf(outcome.observations, LINUX_OBSERVATION_POINT_IDS.recordingStarted).actual).toContain('采集未产出可读 WAV')
    expect(outcome.verdict).toBe('rejected')
  })

  test('Given ASR 超时 When 观察 Then ASR 点失败且音频点仍为真实记录', async () => {
    const { deps } = makeDeps({ asr: makeAsrClient({ throwMessage: 'ASR 超时：超过 20000ms 未返回' }) })
    const outcome = await runLinuxDesktopObservation(deps, makeRequest())
    const asr = pointOf(outcome.observations, LINUX_OBSERVATION_POINT_IDS.asrRealEndpoint)
    expect(asr.passed).toBe(false)
    expect(asr.actual).toContain('超时')
    expect(pointOf(outcome.observations, LINUX_OBSERVATION_POINT_IDS.recordingStarted).passed).toBe(true)
    expect(outcome.verdict).toBe('rejected')
  })

  test('Given ASR 返回空转写 When 观察 Then ASR 点失败', async () => {
    const { deps } = makeDeps({ asr: makeAsrClient({ text: '   ' }) })
    const outcome = await runLinuxDesktopObservation(deps, makeRequest())
    const asr = pointOf(outcome.observations, LINUX_OBSERVATION_POINT_IDS.asrRealEndpoint)
    expect(asr.passed).toBe(false)
    expect(asr.actual).toContain('转写长度=0')
  })

  test('Given 密钥环境变量缺失 When 观察 Then ASR 点失败且不发起任何 ASR 调用', async () => {
    const state: FakeState = { commands: [], asrCalls: [], hotkeyCalls: [], audioCalls: [] }
    const { deps } = makeDeps({ env: {}, asr: makeAsrClient({ state }) })
    const outcome = await runLinuxDesktopObservation(deps, makeRequest())
    const asr = pointOf(outcome.observations, LINUX_OBSERVATION_POINT_IDS.asrRealEndpoint)
    expect(asr.passed).toBe(false)
    expect(asr.actual).toContain('密钥环境变量 ' + KEY_ENV + ' 未设置')
    expect(state.asrCalls).toHaveLength(0)
    expect(outcome.verdict).toBe('rejected')
  })

  test('Given 音频采集失败 When 观察 Then ASR 点判失败且说明未发起调用', async () => {
    const { deps } = makeDeps({ audio: makeAudioCapturer({ throwMessage: '设备忙' }) })
    const outcome = await runLinuxDesktopObservation(deps, makeRequest())
    const asr = pointOf(outcome.observations, LINUX_OBSERVATION_POINT_IDS.asrRealEndpoint)
    expect(asr.passed).toBe(false)
    expect(asr.actual).toContain('未发起 ASR 调用')
  })

  test('Given 靶窗口激活成功但焦点在别的应用 When 观察 Then 插入点失败', async () => {
    const { deps } = makeDeps({ focused: { windowId: '77', title: 'Mozilla Firefox', className: 'firefox' } })
    const outcome = await runLinuxDesktopObservation(deps, makeRequest())
    const insert = pointOf(outcome.observations, LINUX_OBSERVATION_POINT_IDS.cursorInputPasted)
    expect(insert.passed).toBe(false)
    expect(insert.actual).toContain('焦点匹配=false')
  })

  test('Given 焦点窗口不可读 When 观察 Then 插入点失败', async () => {
    const { deps } = makeDeps({ focused: null })
    const outcome = await runLinuxDesktopObservation(deps, makeRequest())
    expect(pointOf(outcome.observations, LINUX_OBSERVATION_POINT_IDS.cursorInputPasted).actual).toContain('焦点窗口=不可读')
  })

  test('Given 靶窗口激活失败 When 观察 Then 插入点失败且不读回缓冲', async () => {
    const { deps } = makeDeps({ activateOk: false })
    const outcome = await runLinuxDesktopObservation(deps, makeRequest())
    const insert = pointOf(outcome.observations, LINUX_OBSERVATION_POINT_IDS.cursorInputPasted)
    expect(insert.passed).toBe(false)
    expect(insert.actual).toContain('读回通道=未读回')
  })

  test('Given 靶控件文本读不回来 When 观察 Then 插入点失败', async () => {
    const { deps } = makeDeps({ buffer: null })
    const outcome = await runLinuxDesktopObservation(deps, makeRequest())
    expect(pointOf(outcome.observations, LINUX_OBSERVATION_POINT_IDS.cursorInputPasted).actual).toContain('靶文本长度=0')
  })

  test('Given 靶控件文本与 ASR 转写不匹配 When 观察 Then 插入点失败', async () => {
    const { deps } = makeDeps({ buffer: { text: '完全不同的一段文字', via: 'xclip-selection-primary' } })
    const outcome = await runLinuxDesktopObservation(deps, makeRequest())
    const insert = pointOf(outcome.observations, LINUX_OBSERVATION_POINT_IDS.cursorInputPasted)
    expect(insert.passed).toBe(false)
    expect(insert.actual).toContain('一致性=false')
    expect(outcome.verdict).toBe('rejected')
  })

  test('Given ASR 失败导致转写为空 When 观察 Then 插入点必然不匹配（不误报）', async () => {
    const { deps } = makeDeps({ asr: makeAsrClient({ throwMessage: 'ASR 错误：401' }) })
    const outcome = await runLinuxDesktopObservation(deps, makeRequest())
    expect(pointOf(outcome.observations, LINUX_OBSERVATION_POINT_IDS.cursorInputPasted).passed).toBe(false)
  })

  test('Given 宿主时钟未推进 When 观察 Then 整轮 rejected（窗口非法，不登记）', async () => {
    const frozen = { epochNow: () => BASE_EPOCH, monotonicNow: () => BASE_EPOCH }
    const { deps } = makeDeps({ clock: frozen })
    const outcome = await runLinuxDesktopObservation(deps, makeRequest())
    expect(outcome.verdict).toBe('rejected')
    expect(outcome.failures.some((item) => item.includes('时钟未推进'))).toBe(true)
  })

  test('Given 请求字段缺失或窗口参数非法 When 观察 Then 抛 TypeError（编程错误，不伪装成结论）', async () => {
    const { deps } = makeDeps()
    await expect(runLinuxDesktopObservation(deps, makeRequest({ testId: '  ' }))).rejects.toThrow(TypeError)
    await expect(runLinuxDesktopObservation(deps, makeRequest({ accelerator: '' }))).rejects.toThrow(TypeError)
    await expect(runLinuxDesktopObservation(deps, makeRequest({ approvedAt: Number.NaN }))).rejects.toThrow(TypeError)
    await expect(runLinuxDesktopObservation(deps, makeRequest({ windows: { captureDurationMs: 0 } }))).rejects.toThrow(TypeError)
    await expect(runLinuxDesktopObservation(deps, makeRequest({ windows: { matchRatio: 2 } }))).rejects.toThrow(TypeError)
  })
})

/* ------------------------------------------------------------------ */
/* 默认实现（注入假命令执行器，argv 断言）                                 */
/* ------------------------------------------------------------------ */

function makeCommandRunner(): { runner: LinuxObserverCommandRunner; calls: string[][] } {
  const calls: string[][] = []
  const runner: LinuxObserverCommandRunner = async (argv, options: LinuxObserverCommandOptions): Promise<LinuxObserverCommandResult> => {
    calls.push([...argv])
    const base = { pid: 900, signal: null, stdout: '', stderr: '' }
    const [executable, sub] = [argv[0] ?? '', argv[1] ?? '']
    if (executable === 'xdotool' && sub === 'key') {
      return { ...base, code: argv[argv.length - 1] === 'ctrl+alt+missing' ? 1 : 0 }
    }
    if (executable === 'parecord') {
      const outputPath = argv[argv.length - 1]!
      const sampleRate = Number.parseInt((argv.find((item) => item.startsWith('--rate=')) ?? '--rate=16000').slice('--rate='.length), 10)
      const channels = Number.parseInt((argv.find((item) => item.startsWith('--channels=')) ?? '--channels=1').slice('--channels='.length), 10)
      writeFileSync(outputPath, buildWav({ sampleRate, channels, frames: sampleRate * 2, amplitude: 0.25 }))
      void options
      return { ...base, pid: 5_150, code: 0 }
    }
    if (executable === 'pactl') {
      return { ...base, code: 0, stdout: ['Source Output #42', '\tSource: ' + SOURCE_NAME, '\tapplication.process.id = "5150"'].join('\n') }
    }
    if (executable === 'xdotool' && sub === 'search') return { ...base, code: 0, stdout: '1042\n' }
    if (executable === 'xdotool' && sub === 'windowactivate') return { ...base, code: 0 }
    if (executable === 'xdotool' && sub === 'getactivewindow') return { ...base, code: 0, stdout: '1042\n' }
    if (executable === 'xdotool' && sub === 'getwindowname') return { ...base, code: 0, stdout: 'main.py - Geany\n' }
    if (executable === 'xdotool' && sub === 'getwindowclassname') return { ...base, code: 0, stdout: 'Geany\n' }
    if (executable === 'xclip') return { ...base, code: 0, stdout: TRANSCRIPT }
    if (executable === 'xsel') return { ...base, code: 0, stdout: TRANSCRIPT }
    return { ...base, code: 127, stderr: '未预期命令：' + argv.join(' ') }
  }
  return { runner, calls }
}

describe('G2｜默认 Linux 实现（注入假命令执行器，不真跑命令）', () => {
  test('Given parecord 采集命令 When 用默认采集器 Then 写出 WAV、解析非静音并绑定 PID', async () => {
    const { runner, calls } = makeCommandRunner()
    const workingDir = mkdtempSync(join(tmpdir(), 'g2-capture-'))
    const capture = await createPulseAudioCapturer(runner).capture({
      sourceName: SOURCE_NAME, durationMs: 2_000, sampleRate: 16_000, channels: 1, workingDir,
    })
    expect(capture.pid).toBe(5_150)
    expect(capture.metrics.nonSilent).toBe(true)
    expect(capture.metrics.sampleRate).toBe(16_000)
    expect(capture.metrics.durationMs).toBeCloseTo(2_000, 0)
    expect(calls[0]).toEqual(['parecord', '--device=' + SOURCE_NAME, '--rate=16000', '--channels=1', '--format=s16le', '--file-format=wav', join(workingDir, 'capture.wav')])
    expect(capture.commandLine).not.toContain(SECRET_VALUE)
  })

  test('Given 采集命令未产出 WAV When 默认采集器 Then 明确报错', async () => {
    const runner: LinuxObserverCommandRunner = async () => ({ pid: 1, code: 0, signal: null, stdout: '', stderr: 'device busy' })
    const workingDir = mkdtempSync(join(tmpdir(), 'g2-capture-'))
    await expect(createPulseAudioCapturer(runner).capture({ sourceName: SOURCE_NAME, durationMs: 1_000, sampleRate: 16_000, channels: 1, workingDir }))
      .rejects.toThrow(/采集未产出可读 WAV/)
  })

  test('Given pactl 返回采集流 When 默认探测 Then 解析出进程绑定；非 0 退出即报错', async () => {
    const { runner } = makeCommandRunner()
    const outputs = await createPulseSourceOutputProbe(runner).listSourceOutputs()
    expect(outputs).toEqual([{ id: '42', sourceName: SOURCE_NAME, processId: 5_150 }])
    const failing: LinuxObserverCommandRunner = async () => ({ pid: 1, code: 1, signal: null, stdout: '', stderr: 'no pulse' })
    await expect(createPulseSourceOutputProbe(failing).listSourceOutputs()).rejects.toThrow(/pactl/)
  })

  test('Given xdotool 注入回执 When 默认热键刺激 Then 如实区分“仅注入回执”与“宿主监听已确认”', async () => {
    const { runner } = makeCommandRunner()
    const stimulus = createXdotoolHotkeyStimulus(runner)
    const delivered = await stimulus.injectAndAwait('Ctrl+Alt+D', 3_000)
    expect(delivered.delivered).toBe(true)
    expect(delivered.detail).toContain('仅注入回执')
    const failed = await stimulus.injectAndAwait('Ctrl+Alt+missing', 3_000)
    expect(failed.delivered).toBe(false)
    const confirmed = await createXdotoolHotkeyStimulus(runner, { confirmDelivery: async () => true }).injectAndAwait('Ctrl+Alt+D', 3_000)
    expect(confirmed.delivered).toBe(true)
    expect(confirmed.interfaceName).toContain('host-listener')
  })

  test('Given xdotool/xclip 应答 When 默认靶窗口读回 Then 焦点与靶文本可取；xsel 变体走 xsel', async () => {
    const { runner, calls } = makeCommandRunner()
    const reader = createLinuxTargetWindowReader(runner)
    const activation = await reader.activate('geany')
    expect(activation.ok).toBe(true)
    expect(activation.windowId).toBe('1042')
    expect(await reader.readFocused()).toEqual({ windowId: '1042', title: 'main.py - Geany', className: 'Geany' })
    expect(await reader.readBuffer('geany')).toEqual({ text: TRANSCRIPT, via: 'xclip-selection-primary' })
    const xselReader = createLinuxTargetWindowReader(runner, { clipboardTool: 'xsel', selection: 'clipboard' })
    expect(await xselReader.readBuffer('geany')).toEqual({ text: TRANSCRIPT, via: 'xsel-selection-clipboard' })
    expect(calls.some((argv) => argv[0] === 'xsel')).toBe(true)
  })

  test('Given 注入假命令执行器 When 装配默认依赖跑完整一轮 Then 四点全过（生产装配路径可用）', async () => {
    const { runner, calls } = makeCommandRunner()
    const workingDir = mkdtempSync(join(tmpdir(), 'g2-deps-'))
    const state: FakeState = { commands: [], asrCalls: [], hotkeyCalls: [], audioCalls: [] }
    const deps = createLinuxObserverDeps({
      asr: makeAsrClient({ state }),
      command: runner,
      clock: { epochNow: () => BASE_EPOCH + 10, monotonicNow: () => BASE_EPOCH + 20 },
      env: (name) => (name === KEY_ENV ? SECRET_VALUE : undefined),
      audio: createPulseAudioCapturer(runner),
      targetReader: { clipboardTool: 'xclip' },
    })
    const outcome = await runLinuxDesktopObservation(deps, makeRequest({
      windows: { captureDurationMs: 2_000, sampleRate: 16_000, channels: 1, rmsThreshold: 0.003, peakThreshold: 0.05 },
    }))
    // 采集的临时目录由测试清理（默认采集器写系统临时目录，这里显式覆盖为 workingDir 无关路径）
    void workingDir
    expect(outcome.failures).toEqual([])
    expect(outcome.verdict).toBe('attested')
    expect(state.asrCalls).toHaveLength(1)
    expect(existsSync(state.asrCalls[0]!.audioWavPath)).toBe(true)
    expect(calls.some((argv) => argv[0] === 'xdotool' && argv[1] === 'key')).toBe(true)
    expect(calls.some((argv) => argv[0] === 'pactl')).toBe(true)
    rmSync(join(state.asrCalls[0]!.audioWavPath, '..'), { recursive: true, force: true })
  })
})

/* ------------------------------------------------------------------ */
/* 与 real-gate 接线（真实协议 + 真实 registry + fixture 工程目录）          */
/* ------------------------------------------------------------------ */

describe('G2｜与 real-gate 接线：登记 → completeness → 交付门', () => {
  let projectDir: string

  beforeEach(() => {
    gate.__resetEngineeringRealGateForTests()
    projectDir = makeProjectDir()
  })

  async function observeOutcome(overrides: Partial<LinuxObservationRequest> = {}) {
    const { deps } = makeDeps()
    return runLinuxDesktopObservation(deps, makeRequest(overrides))
  }

  function register(registration: EngineeringHostObserverRegistration) {
    return gate.registerHostObserverEvidence(scopeFor(projectDir), registration)
  }

  /** 夹具：等价于“把 codes/runIds 展示给真人后由真人确认”；生产唯一入口是真实 Ask 回调。 */
  function ackFor(codes: readonly string[], runIds: readonly string[]) {
    return gate.issueBoundaryAckAfterRealConfirmation(
      { projectId: 'p2', sessionId: SESSION_ID },
      { requestId: 'permission-ack-g2', allowed: true, displayedBoundaryCodes: [...codes], displayedObservationRunIds: [...runIds] },
    )
  }

  test('Given 观察器四点全过的记录 When 登记 Then 观察期 completeness 通过且交付门需 ack', async () => {
    const scope = scopeFor(projectDir)
    const outcome = await observeOutcome()
    const registered = register(outcome.registration)
    expect(registered.ok).toBe(true)

    // 观察点声明已写入宿主侧声明表（门禁据此逐点校验机器实测）
    expect(gate.peekObservationPointsForTests(TEST_ID)).toHaveLength(4)
    expect(gate.resolveSuiteRealEvidence(scope, [TARGET]).rejections).toEqual([])
    expect(gate.checkDeliveryRealEvidence(scope, [TARGET]).rejection?.reason).toBe('coverage-unverified-unacked')
  })

  test('Given 观察器记录 + 真人 ack 收据 When 最终交付 Then requiresReal 测试可 pass 且二次交付被拒', async () => {
    const scope = scopeFor(projectDir)
    const outcome = await observeOutcome()
    expect(register(outcome.registration).ok).toBe(true)
    const codes = gate.resolveCoverageBoundaryCodes(scope, [TARGET])
    expect(codes).toEqual(expect.arrayContaining(linuxCoverageBoundaryCodes()))
    expect(ackFor(codes, [RUN_ID])).not.toBeNull()

    const first = gate.commitDeliveryRealEvidence(scope, [TARGET])
    expect(first.rejection).toBeNull()
    const second = gate.commitDeliveryRealEvidence(scope, [TARGET])
    expect(second.rejection?.reason).toBe('real-evidence-replayed')
  })

  test('Given 未登记任何观察轮次 When 门禁判定 Then requires-real-unattested 且指出 testId', async () => {
    const scope = scopeFor(projectDir)
    const suite = gate.resolveSuiteRealEvidence(scope, [TARGET])
    expect(suite.rejections).toHaveLength(1)
    expect(suite.rejections[0]?.reason).toBe('requires-real-unattested')
    expect(suite.rejections[0]?.testId).toBe(TEST_ID)
    expect(gate.peekObservationPointsForTests(TEST_ID)).toEqual([])
  })

  test('Given 记录缺少已声明观察点的实测 When 门禁判定 Then host-observation-missing（不误放）', async () => {
    const scope = scopeFor(projectDir)
    const outcome = await observeOutcome()
    const obsLess = register({ ...outcome.registration, observations: [] })
    expect(obsLess.ok).toBe(true)
    const rejection = gate.resolveSuiteRealEvidence(scope, [TARGET]).rejections[0]
    expect(rejection?.reason).toBe('host-observation-missing')
    expect(rejection?.message).toContain(LINUX_OBSERVATION_POINT_IDS.hotkeyDelivered)
  })

  test('Given 观测的 observedVia 与声明不一致 When 门禁判定 Then host-observation-missing', async () => {
    const scope = scopeFor(projectDir)
    const outcome = await observeOutcome()
    const mismatched = {
      ...outcome.registration,
      points: outcome.registration.points.map((point) => point.id === LINUX_OBSERVATION_POINT_IDS.asrRealEndpoint
        ? { ...point, observedVia: 'host.wrong-interface' }
        : point),
    }
    expect(register(mismatched).ok).toBe(true)
    const rejection = gate.resolveSuiteRealEvidence(scope, [TARGET]).rejections[0]
    expect(rejection?.reason).toBe('host-observation-missing')
    expect(rejection?.message).toContain(LINUX_OBSERVATION_POINT_IDS.asrRealEndpoint)
  })

  test('Given 声明了不可自动观察点但无见证收据 When 门禁判定 Then human-witness-missing（不虚构见证）', async () => {
    const scope = scopeFor(projectDir)
    const outcome = await observeOutcome()
    const withHumanPoint = register({
      ...outcome.registration,
      points: [...outcome.registration.points, ...linuxHumanWitnessPoints().slice(0, 1)],
    })
    expect(withHumanPoint.ok).toBe(true)
    const rejection = gate.resolveSuiteRealEvidence(scope, [TARGET]).rejections[0]
    expect(rejection?.reason).toBe('human-witness-missing')
    expect(rejection?.message).toContain(LINUX_HUMAN_WITNESS_POINT_IDS.asrSemantic)
    // 未获真人允许 → 不签发见证收据（观察器与接线层都不生成见证）
    expect(gate.issueHumanWitnessAfterRealApproval('p2', {
      requestId: 'permission-witness-g2', allowed: false, testId: TEST_ID, sessionId: SESSION_ID,
      pointId: LINUX_HUMAN_WITNESS_POINT_IDS.asrSemantic, storyId: 'US-01', assertion: '口述内容与转写语义一致',
    })).toBeNull()
  })

  test('Given 观察失败（rejected）When 登记 Then 被 registry 拒绝，不产生任何 attestation', async () => {
    const scope = scopeFor(projectDir)
    const { deps } = makeDeps({ hotkeyDelivered: false })
    const outcome = await runLinuxDesktopObservation(deps, makeRequest())
    expect(outcome.verdict).toBe('rejected')
    const registered = register(outcome.registration)
    expect(registered.ok).toBe(false)
    if (!registered.ok) expect(registered.reason).toBe('requires-real-unattested')
    expect(gate.resolveSuiteRealEvidence(scope, [TARGET]).rejections[0]?.reason).toBe('requires-real-unattested')
    expect(gate.commitDeliveryRealEvidence(scope, [TARGET]).rejection?.reason).toBe('requires-real-unattested')
  })

  test('Given 工程证据不可读 When 登记 Then 拒绝且不放行（fail-closed）', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'g2-no-evidence-'))
    const outcome = await observeOutcome()
    const registered = gate.registerHostObserverEvidence(scopeFor(bare), outcome.registration)
    expect(registered.ok).toBe(false)
    expect(gate.resolveSuiteRealEvidence(scopeFor(bare), [TARGET]).rejections[0]?.reason).toBe('requires-real-unattested')
  })

  test('Given 换一个会话交付 When 门禁判定 Then binding-mismatch（记录不能跨会话复用）', async () => {
    const scope = scopeFor(projectDir)
    const outcome = await observeOutcome()
    expect(register(outcome.registration).ok).toBe(true)
    const otherSession = { ...scope, sessionId: 'session-other' }
    expect(gate.resolveSuiteRealEvidence(otherSession, [TARGET]).rejections[0]?.reason).toBe('real-evidence-binding-mismatch')
  })

  test('Given 设备细化不一致 When 门禁判定 Then binding-mismatch（设备绑定参与对账）', async () => {
    const scope = scopeFor(projectDir)
    const outcome = await observeOutcome()
    expect(register(outcome.registration).ok).toBe(true)
    const otherDevice = { ...scope, deviceDetail: { ...DEVICE_DETAIL, audioSource: 'alsa_input.other' } }
    expect(gate.resolveSuiteRealEvidence(otherDevice, [TARGET]).rejections[0]?.reason).toBe('real-evidence-binding-mismatch')
  })
})

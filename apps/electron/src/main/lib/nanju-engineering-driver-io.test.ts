import { describe, expect, test } from 'bun:test'
import {
  applyDriverIoTailPipeline, summarizeDriverIo, buildDriverIoLogFile, DriverIoTailBuffer,
  DRIVER_IO_TAIL_LINES, DRIVER_IO_LINE_MAX_BYTES, DRIVER_IO_TOTAL_MAX_BYTES, DRIVER_IO_DIAG_MAX_BYTES,
} from './nanju-engineering-driver-io'

/**
 * P0-2（L1，2026-09-18）驱动 IO 尾部管道与自适应诊断摘要单测。
 * 样本来源：G3b 复盘 §五.1——成功录音类 490B / 云端错误类 0.9-1.8KB（/tmp/drv* 指挥官
 * 复现残迹，末行含 peak/HTTP 400 诊断）；R3 崩溃 traceback 类无真实留存样本，以构造
 * 样本校准（诚实边界：首个真实 error 轮再补证）。
 */

function utf8len(s: string): number { return Buffer.byteLength(s, 'utf-8') }

describe('Given 驱动输出流，When 套用截断管道，Then 逐层固定（尾200行→单行2KB→总量64KB保尾）', () => {
  test('Then 尾 200 行：超长输出只保留最后 200 行', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line-${i}`)
    const out = applyDriverIoTailPipeline(lines.join('\n'))
    const outLines = out.split('\n')
    expect(outLines.length).toBeLessThanOrEqual(DRIVER_IO_TAIL_LINES)
    expect(outLines[outLines.length - 1]).toBe('line-499')
    expect(outLines[0]).toBe(`line-${500 - DRIVER_IO_TAIL_LINES}`)
  })
  test('Then 单行 2KB：超长单行截断至 2KB（UTF-8 合法边界）', () => {
    const longLine = '你'.repeat(3000) // 3 字节/字符 → 9KB 行
    const out = applyDriverIoTailPipeline(longLine)
    expect(utf8len(out)).toBeLessThanOrEqual(DRIVER_IO_LINE_MAX_BYTES)
    expect(out.endsWith('\uFFFD')).toBe(false) // 无坏尾（多字节未截半）
  })
  test('Then 总量 64KB：超限自头部截除（保尾部）', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `x`.repeat(500) + `-${i}`) // ~100KB
    const out = applyDriverIoTailPipeline(lines.join('\n'))
    expect(utf8len(out)).toBeLessThanOrEqual(DRIVER_IO_TOTAL_MAX_BYTES)
    expect(out.trimEnd().endsWith('-199')).toBe(true) // 尾部保留
  })
  test('Then DriverIoTailBuffer 增量 append 与一次性管道等价', () => {
    const buf = new DriverIoTailBuffer()
    const chunks = ['a\nb\n', 'c\nd', '\ne\n']
    for (const c of chunks) buf.append(c)
    expect(buf.tail()).toBe(applyDriverIoTailPipeline(chunks.join('')))
  })
  test('Then Buffer 内存上限：超 256KB 原始输入不膨胀且 tail 仍可用', () => {
    const buf = new DriverIoTailBuffer()
    for (let i = 0; i < 60; i++) buf.append('y'.repeat(10000)) // 600KB
    const tail = buf.tail()
    expect(utf8len(tail)).toBeLessThanOrEqual(DRIVER_IO_TOTAL_MAX_BYTES)
  })
})

describe('Given 自适应诊断摘要（≤1KB，锚点优先级定死），When 三类样本校准，Then 各按规则选取', () => {
  // 样本一（成功录音类，490B 级；无诊断关键行 → 末 3 行）
  test('Then 未命中关键行 → 末 3 行', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `info: frame ${i} captured`)
    const out = summarizeDriverIo('', lines.join('\n'))
    expect(out.split('\n').length).toBe(3)
    expect(out).toContain('frame 19')
  })
  // 样本二（云端错误类，0.9-1.8KB；末行 HTTP 400 诊断 → 自最后关键行取至末尾）
  test('Then 有 Error/HTTP 关键行 → 自最后一条关键行取至末尾', () => {
    const stderr = [
      'info: recording 3s @16kHz',
      'info: wav bytes=96000 peak=18273',
      'DEBUG: building request body',
      'ERROR: dashscope responded HTTP 400: {"code":"invalid_parameter"}',
      'hint: check model name and audio format',
    ].join('\n')
    const out = summarizeDriverIo('', stderr)
    expect(out.startsWith('ERROR: dashscope responded HTTP 400')).toBe(true)
    expect(out).toContain('hint: check model name')
    expect(utf8len(out)).toBeLessThanOrEqual(DRIVER_IO_DIAG_MAX_BYTES)
  })
  // 样本三（R3 崩溃 traceback 类——构造样例校准；无真实留存样本）
  test('Then Traceback 起点行优先：自最早起点取至末尾（含栈帧）', () => {
    const stderr = [
      'info: driver starting',
      'Traceback (most recent call last):',
      '  File "drv_audio_asr.py", line 42, in <module>',
      '    sd.rec(duration, samplerate=16000)',
      '  File "sounddevice.py", line 261, in rec',
      'PortAudioError: Error querying device: -9996',
    ].join('\n')
    const out = summarizeDriverIo('', stderr)
    expect(out.startsWith('Traceback (most recent call last):')).toBe(true)
    expect(out).toContain('PortAudioError: Error querying device: -9996')
  })
  test('Then Traceback 超 1KB：保留首行 Traceback + 末尾优先截断', () => {
    const frames = Array.from({ length: 80 }, (_, i) => `  File "mod${i}.py", line ${i}, in f${i}`)
    const stderr = ['Traceback (most recent call last):', ...frames, 'SystemExit: 1'].join('\n')
    const out = summarizeDriverIo('', stderr)
    expect(utf8len(out)).toBeLessThanOrEqual(DRIVER_IO_DIAG_MAX_BYTES)
    expect(out.split('\n')[0]).toBe('Traceback (most recent call last):')
    expect(out.endsWith('SystemExit: 1')).toBe(true) // 末尾优先
    expect(out).toContain('（栈帧中略）')
  })
  test('Then 窗口优先级：stderr 非空优先于 stdout（契约「日志写stderr」）', () => {
    const stdout = 'ERROR: should-not-be-used-when-stderr-present'
    const stderr = 'WARNING: from stderr'
    expect(summarizeDriverIo(stdout, stderr)).toBe('WARNING: from stderr')
    // stderr 空 → 退化 stdout
    expect(summarizeDriverIo(stdout, '')).toBe('ERROR: should-not-be-used-when-stderr-present')
  })
  test('Then 两通道皆空 → 空摘要（error_reason 不内联）', () => {
    expect(summarizeDriverIo('', '')).toBe('')
    expect(summarizeDriverIo('  \n  ', '\n')).toBe('')
  })
})

describe('Given 旁挂落盘内容构建，When 生成 log 文本，Then 分节标注与元信息齐备', () => {
  test('Then 含 testId/时间戳/管道说明与 stdout/stderr 分节', () => {
    const text = buildDriverIoLogFile(
      { stdoutTail: 'ok-json', stderrTail: 'warn: x' },
      { testId: 'drv-01', generatedAt: '2026-09-18T06:00:00Z' },
    )
    expect(text).toContain('testId: drv-01')
    expect(text).toContain('generatedAt: 2026-09-18T06:00:00Z')
    expect(text).toContain('## stderr 尾部')
    expect(text).toContain('## stdout 尾部')
    expect(text).toContain('warn: x')
  })
  test('Then 空通道标注（空）而非空节', () => {
    const text = buildDriverIoLogFile({ stdoutTail: '', stderrTail: '' }, { testId: 't', generatedAt: 'g' })
    expect(text).toContain('（空）')
  })
})

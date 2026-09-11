/**
 * v2.4「自动补完需求」渲染/提示词域 IPC 契约测试
 *
 * 覆盖：
 * 1. 代答卡片数据结构（parseClarifyLogLine：_nanju-clarify-log.jsonl 行 → 渲染端卡片视图）
 * 2. 关闭/升级处置计划（planAutoClarifyShutdown：D7 §7 in-flight stop + pending 转述 + 字段处置）
 * 3. 死通道移除（Defender #20：nanju:advance-stage + preload nanjuAdvanceStage 面删除）
 * 4. 新增 IPC 面（auto-clarify 状态读/写 + 代答事件流 preload 面）
 *
 * 证据分级 R（源码断言）/S（纯函数单测）；不 mock 真实行为断言。
 */
import { describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// nanju-ipc 的传递依赖（preview-watcher / orchestrator 链）顶层 import electron——
// 按仓库既有模式（__tests__/nanju-ipc.test.ts）先 mock.module 再动态导入。
mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => '/tmp/proma-clarify-test',
    getName: () => 'proma',
    getVersion: () => '0.0.0-test',
  },
  BrowserWindow: class {},
  dialog: {},
  clipboard: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  shell: {},
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
  ipcMain: { handle() {}, removeHandler() {} },
  webContents: { send() {} },
}))

import type { NanjuClarifyAnswerCard } from '../nanju-ipc'

const {
  parseClarifyLogLine,
  planAutoClarifyShutdown,
} = await import('../nanju-ipc')

const preloadSource = readFileSync(join(import.meta.dir, '..', '..', '..', 'preload', 'index.ts'), 'utf-8')
const nanjuIpcSource = readFileSync(join(import.meta.dir, '..', 'nanju-ipc.ts'), 'utf-8')

describe('v2.4：代答卡片数据结构（parseClarifyLogLine）', () => {
  test('子会话来源行 → 卡片：qid/来源标签「子会话提问·代理作答」/渠道/问题与答案要点/耗时/时间戳', () => {
    const card = parseClarifyLogLine(JSON.stringify({
      kind: 'proxy-answer', qid: 'q-001', source: 'subagent', channel: 'deepseek',
      question: '目标用户的核心使用场景是什么？', answer: '面向大学生的读书笔记管理，核心场景是课堂速记与复习检索。',
      durationMs: 8_400, ts: 1_760_000_000_000, stage: 'requirements',
    })) as NanjuClarifyAnswerCard
    expect(card).not.toBeNull()
    expect(card.qid).toBe('q-001')
    expect(card.sourceLabel).toBe('子会话提问·代理作答')
    expect(card.channel).toBe('deepseek')
    expect(card.questionSummary).toContain('核心使用场景')
    expect(card.answerSummary).toContain('读书笔记')
    expect(card.durationMs).toBe(8_400)
    expect(card.ts).toBe(1_760_000_000_000)
    expect(card.stage).toBe('requirements')
  })

  test('L1 来源行（source:l1 或缺失）→ 来源标签「L1 提问·代理作答」', () => {
    for (const source of ['l1', undefined]) {
      const card = parseClarifyLogLine(JSON.stringify({
        kind: 'proxy-answer', qid: 'q-002', channel: 'glm-zhipu',
        question: '列表要不要分页？', answer: '单页滚动加载即可（百条以内）。',
        ts: 1_760_000_000_001,
        ...(source ? { source } : {}),
      })) as NanjuClarifyAnswerCard
      expect(card).not.toBeNull()
      expect(card!.sourceLabel).toBe('L1 提问·代理作答')
    }
  })

  test('问题/答案要点截断：问题 ≤80 字、答案 ≤120 字（卡片紧凑展示）', () => {
    const card = parseClarifyLogLine(JSON.stringify({
      kind: 'proxy-answer', qid: 'q-003', channel: 'c',
      question: '长'.repeat(200), answer: '答'.repeat(300), ts: 1,
    })) as NanjuClarifyAnswerCard
    expect(card!.questionSummary.length).toBeLessThanOrEqual(80)
    expect(card!.answerSummary.length).toBeLessThanOrEqual(120)
  })

  test('非代答完成行不生成卡片：fallback/kind 不符/缺 qid/坏 JSON → null', () => {
    expect(parseClarifyLogLine(JSON.stringify({ kind: 'fallback', qid: 'q-004', reason: 'timeout' }))).toBeNull()
    expect(parseClarifyLogLine(JSON.stringify({ kind: 'proxy-answer', channel: 'c', answer: 'a', ts: 1 }))).toBeNull()
    expect(parseClarifyLogLine('not-json{')).toBeNull()
    expect(parseClarifyLogLine('null')).toBeNull()
  })

  test('时间戳兼容：ISO 字符串 at 字段 → number；缺失 → 0', () => {
    const iso = parseClarifyLogLine(JSON.stringify({
      kind: 'proxy-answer', qid: 'q-005', channel: 'c', question: 'q', answer: 'a', at: '2026-09-11T02:00:00.000Z',
    })) as NanjuClarifyAnswerCard
    expect(iso!.ts).toBe(Date.parse('2026-09-11T02:00:00.000Z'))
    const none = parseClarifyLogLine(JSON.stringify({
      kind: 'proxy-answer', qid: 'q-006', channel: 'c', question: 'q', answer: 'a',
    })) as NanjuClarifyAnswerCard
    expect(none!.ts).toBe(0)
  })

  // ══ D8（R7-10）：代答/代决 kind 区分（design-preference 代决显示「代决」标签） ══

  test('D8：kind 判定——宽字段兼容（B 域 clarifyKind / decision:true / answerKind:decision / proxy-delegate / design-preference 类别）→ kind=decision', () => {
    for (const extra of [
      { clarifyKind: 'decision' },
      { decision: true },
      { answerKind: 'decision' },
      { kind: 'proxy-delegate' },
      { category: 'design-preference' },
    ]) {
      const card = parseClarifyLogLine(JSON.stringify({
        kind: 'proxy-answer', qid: 'q-d1', channel: 'c', question: 'q', answer: 'a', ts: 1, ...extra,
      })) as NanjuClarifyAnswerCard
      expect(card!.kind).toBe('decision')
    }
  })

  test('D8：默认 kind=answer（requirement-clarify 代答）；fallback/cannot-judge 行仍不生成卡片', () => {
    const card = parseClarifyLogLine(JSON.stringify({
      kind: 'proxy-answer', qid: 'q-d2', channel: 'c', question: 'q', answer: 'a', ts: 1,
      category: 'requirement-clarify',
    })) as NanjuClarifyAnswerCard
    expect(card!.kind).toBe('answer')
    expect(parseClarifyLogLine(JSON.stringify({ kind: 'cannot-judge', qid: 'q-d3' }))).toBeNull()
  })
})

describe('v2.4：关闭/升级处置计划（planAutoClarifyShutdown，D7 §7）', () => {
  test('常规关闭：停 in-flight 代理委派 + pending 问题转述 + 字段处置 + 提示文案', () => {
    const plan = planAutoClarifyShutdown({
      enabled: true, mode: 'quick',
      runningProxyDelegationIds: ['d-1', 'd-2'],
      pendingQuestionIds: ['q-1', 'q-2', 'q-3'],
    })
    expect(plan.shouldDisable).toBe(true)
    expect(plan.stopDelegationIds).toEqual(['d-1', 'd-2'])
    expect(plan.relayQuestionIds).toEqual(['q-1', 'q-2', 'q-3'])
    expect(plan.notice).toContain('2')
    expect(plan.notice).toContain('3')
    expect(plan.notice).toContain('转述')
  })

  test('升级长期迭代型（mode:iterative）：禁用 + 日志归档提示', () => {
    const plan = planAutoClarifyShutdown({
      enabled: true, mode: 'iterative',
      runningProxyDelegationIds: ['d-1'], pendingQuestionIds: ['q-1'],
    })
    expect(plan.shouldDisable).toBe(true)
    expect(plan.stopDelegationIds).toEqual(['d-1'])
    expect(plan.archiveLog).toBe(true)
    expect(plan.notice).toContain('长期迭代型')
    expect(plan.notice).toContain('归档')
  })

  test('幂等：enabled=false（已关闭）→ 无动作无提示', () => {
    const plan = planAutoClarifyShutdown({
      enabled: false, mode: 'quick',
      runningProxyDelegationIds: [], pendingQuestionIds: [],
    })
    expect(plan.shouldDisable).toBe(false)
    expect(plan.stopDelegationIds).toEqual([])
    expect(plan.relayQuestionIds).toEqual([])
    expect(plan.notice).toBeNull()
  })

  test('无 in-flight/无 pending 的干净关闭：仅禁用字段', () => {
    const plan = planAutoClarifyShutdown({
      enabled: true, mode: 'quick', runningProxyDelegationIds: [], pendingQuestionIds: [],
    })
    expect(plan.shouldDisable).toBe(true)
    expect(plan.stopDelegationIds).toEqual([])
    expect(plan.relayQuestionIds).toEqual([])
    expect(plan.notice).not.toBeNull()
  })
})

describe('v2.4：死通道移除 + 新增 IPC 面（源码断言，Defender #20）', () => {
  test('nanju:advance-stage 死通道：handler 与 preload 导出面均已移除（绕过 §2 推进门）', () => {
    expect(nanjuIpcSource).not.toContain("'nanju:advance-stage'")
    expect(preloadSource).not.toContain('nanjuAdvanceStage')
  })

  test('新增 auto-clarify IPC 面：状态读/写 + 代答事件流（preload 暴露 renderer 可调）', () => {
    expect(nanjuIpcSource).toContain("'nanju:get-auto-clarify'")
    expect(nanjuIpcSource).toContain("'nanju:set-auto-clarify'")
    expect(nanjuIpcSource).toContain("'nanju:clarify-event'")
    expect(preloadSource).toContain('nanjuGetAutoClarify')
    expect(preloadSource).toContain('nanjuSetAutoClarify')
    expect(preloadSource).toContain('onNanjuClarifyEvent')
  })
})

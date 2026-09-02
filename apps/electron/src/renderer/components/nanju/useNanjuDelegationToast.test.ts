/**
 * 委派等待 Toast 阈值状态机单测（R1，W1）+ Toast 文案 spec 逐字锁定。
 *
 * 纯函数层：reduceDelegationToastState（5s/30s 阈值、后到覆盖、旧操作晚到 settle 忽略）
 * + NANJU_TOAST_TEXT / NANJU_TOAST_DURATION_MS（spec v0.5 交互2 精确文案与时长）。
 */

import { describe, expect, test } from 'bun:test'
import {
  DELEGATION_PROGRESS_THRESHOLD_MS,
  DELEGATION_TIMEOUT_THRESHOLD_MS,
  INITIAL_DELEGATION_TOAST_STATE,
  delegationToastKey,
  reduceDelegationToastState,
} from './useNanjuDelegationToast'
import { NANJU_TOAST_DURATION_MS, NANJU_TOAST_TEXT } from './NanjuToast'

const STARTED_AT = 1_000_000

function startAction(overrides: Partial<{ delegationId: string; label: string; startedAt: number }> = {}) {
  return {
    type: 'start' as const,
    delegationId: overrides.delegationId ?? 'del-1',
    label: overrides.label ?? 'UX 顾问：生成原型',
    startedAt: overrides.startedAt ?? STARTED_AT,
  }
}

describe('阈值状态机（spec 交互2 触发条件）', () => {
  test('初始态：无待定操作', () => {
    expect(INITIAL_DELEGATION_TOAST_STATE).toEqual({ pending: null, progressVisible: false, timeoutFired: false })
  })

  test('start：登记待定并重置阈值位（后到覆盖前操作）', () => {
    let s = reduceDelegationToastState(INITIAL_DELEGATION_TOAST_STATE, startAction())
    // 前操作已越过 5s/30s
    s = reduceDelegationToastState(s, { type: 'tick', now: STARTED_AT + DELEGATION_TIMEOUT_THRESHOLD_MS + 1 })
    expect(s.progressVisible).toBe(true)
    expect(s.timeoutFired).toBe(true)
    // 新操作覆盖：阈值位重置
    s = reduceDelegationToastState(s, startAction({ delegationId: 'del-2', startedAt: STARTED_AT + 100_000 }))
    expect(s.pending).toEqual({ delegationId: 'del-2', label: 'UX 顾问：生成原型', startedAt: STARTED_AT + 100_000 })
    expect(s.progressVisible).toBe(false)
    expect(s.timeoutFired).toBe(false)
  })

  test('5s 阈值：未到不显示，到达显示（幂等）', () => {
    let s = reduceDelegationToastState(INITIAL_DELEGATION_TOAST_STATE, startAction())
    s = reduceDelegationToastState(s, { type: 'tick', now: STARTED_AT + DELEGATION_PROGRESS_THRESHOLD_MS - 1 })
    expect(s.progressVisible).toBe(false)
    s = reduceDelegationToastState(s, { type: 'tick', now: STARTED_AT + DELEGATION_PROGRESS_THRESHOLD_MS })
    expect(s.progressVisible).toBe(true)
    const before = s
    s = reduceDelegationToastState(s, { type: 'tick', now: STARTED_AT + DELEGATION_PROGRESS_THRESHOLD_MS + 5_000 })
    expect(s).toBe(before) // 引用不变（无新阈值翻转）
  })

  test('30s 追加：timeout 位在 30s 到达时翻转（progress 已显示则保持）', () => {
    let s = reduceDelegationToastState(INITIAL_DELEGATION_TOAST_STATE, startAction())
    s = reduceDelegationToastState(s, { type: 'tick', now: STARTED_AT + DELEGATION_TIMEOUT_THRESHOLD_MS })
    expect(s.progressVisible).toBe(true) // 30s > 5s，同 tick 先越过 5s
    expect(s.timeoutFired).toBe(true)
  })

  test('settle：仅当前跟踪的操作生效，归零状态', () => {
    let s = reduceDelegationToastState(INITIAL_DELEGATION_TOAST_STATE, startAction())
    s = reduceDelegationToastState(s, { type: 'tick', now: STARTED_AT + 6_000 })
    expect(s.progressVisible).toBe(true)
    s = reduceDelegationToastState(s, { type: 'settle', delegationId: 'del-1' })
    expect(s).toEqual(INITIAL_DELEGATION_TOAST_STATE)
  })

  test('旧操作晚到 settle：不影响当前跟踪（spec 后到覆盖语义）', () => {
    let s = reduceDelegationToastState(INITIAL_DELEGATION_TOAST_STATE, startAction({ delegationId: 'old' }))
    s = reduceDelegationToastState(s, startAction({ delegationId: 'new', startedAt: STARTED_AT + 50_000 }))
    const before = s
    s = reduceDelegationToastState(s, { type: 'settle', delegationId: 'old' })
    expect(s).toBe(before)
  })

  test('5s 内完成（settle 时 progress 未显示）：状态同样归零（不展示任何提示由 hook 保证）', () => {
    let s = reduceDelegationToastState(INITIAL_DELEGATION_TOAST_STATE, startAction())
    s = reduceDelegationToastState(s, { type: 'tick', now: STARTED_AT + 4_000 })
    expect(s.progressVisible).toBe(false)
    s = reduceDelegationToastState(s, { type: 'settle', delegationId: 'del-1' })
    expect(s).toEqual(INITIAL_DELEGATION_TOAST_STATE)
  })

  test('无待定操作时 tick：状态不变（计时器晚触发防御）', () => {
    const s = reduceDelegationToastState(INITIAL_DELEGATION_TOAST_STATE, { type: 'tick', now: Date.now() })
    expect(s).toBe(INITIAL_DELEGATION_TOAST_STATE)
  })
})

describe('去重键', () => {
  test('continue_delegation 重派复用 delegationId：以 startedAt 区分轮次', () => {
    expect(delegationToastKey({ delegationId: 'del-1', label: 'x', startedAt: 1 })).not.toBe(
      delegationToastKey({ delegationId: 'del-1', label: 'x', startedAt: 2 }),
    )
    expect(delegationToastKey({ delegationId: 'del-1', label: 'x', startedAt: 1 })).toBe(
      delegationToastKey({ delegationId: 'del-1', label: 'y', startedAt: 1 }),
    )
  })
})

describe('Toast 文案与时长（spec v0.5 交互2 逐字锁定）', () => {
  test('五类精确文案', () => {
    expect(NANJU_TOAST_TEXT.progress).toBe('我正在帮你生成可运行的版本，这个过程只发生在安全环境里，不会影响你的电脑文件。')
    expect(NANJU_TOAST_TEXT.success).toBe('改好了，你看看效果？不满意随时告诉我。')
    expect(NANJU_TOAST_TEXT.error).toBe('刚才的修改没有成功，我已经帮你回到上一个正常版本，你的内容没有丢失。我们换个思路试试？')
    expect(NANJU_TOAST_TEXT.rollback).toBe('已经回到之前的版本了，一切都在。要继续的话随时告诉我。')
    expect(NANJU_TOAST_TEXT.timeout).toBe('这次操作花了比预期更长的时间，我还在处理中。如果等太久，你可以催我。')
  })

  test('自动消失时长：progress 不自动消失；其余 3.5-4s（info 3s）', () => {
    expect(NANJU_TOAST_DURATION_MS.progress).toBeNull()
    expect(NANJU_TOAST_DURATION_MS.success).toBe(4000)
    expect(NANJU_TOAST_DURATION_MS.error).toBe(3500)
    expect(NANJU_TOAST_DURATION_MS.rollback).toBe(4000)
    expect(NANJU_TOAST_DURATION_MS.timeout).toBe(3500)
    expect(NANJU_TOAST_DURATION_MS.info).toBe(3000)
  })
})

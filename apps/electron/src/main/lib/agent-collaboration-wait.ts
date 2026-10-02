/**
 * W24/M-1：协作委派等待的纯逻辑（自 agent-collaboration-tools 抽出，无 electron 依赖可单测）
 *
 * blocked 即唤醒：等待中的委派出现未解决阻塞事件（ask_user/permission）时提前返回
 * 'blocked'——子会话卡在等应答，等待完成无意义，控制权交回父会话（nanju auto →
 * nanju_clarify_proxy 代答；普通会话 → answer_delegation_question 或再 wait）。
 */

/** 等待目标的最小结构（DelegationRecord 的等待面；调用方适配） */
export interface WaitableDelegation {
  delegationId: string
  status: string
  completion: Promise<unknown>
}

export interface WaitForLiveRecordsOpts {
  /** blocked 即唤醒（缺省开启） */
  wakeOnBlocked?: boolean
  /** 未解决阻塞事件计数（注入必需——本模块无状态；返回 >0 视为 blocked） */
  countPendingBlocked?: (delegationId: string) => number
  /** 轮询间隔（缺省 2s；测试可调小） */
  pollIntervalMs?: number
}

/** blocked 唤醒的轮询间隔（默认） */
export const WAIT_BLOCKED_POLL_INTERVAL_MS = 2000

export async function waitForLiveRecords(
  records: ReadonlyArray<WaitableDelegation>,
  timeoutSeconds: number,
  liveTarget: number,
  opts?: WaitForLiveRecordsOpts,
): Promise<'completed' | 'timeout' | 'blocked'> {
  const finished = () => records.filter((r) => r.status !== 'running').length
  if (finished() >= liveTarget) {
    return 'completed'
  }
  const wakeOnBlocked = opts?.wakeOnBlocked !== false
  const countPendingBlocked = opts?.countPendingBlocked
  const intervalMs = opts?.pollIntervalMs ?? WAIT_BLOCKED_POLL_INTERVAL_MS

  let timeout: ReturnType<typeof setTimeout> | undefined
  let poll: ReturnType<typeof setInterval> | undefined
  try {
    return await Promise.race([
      new Promise<'completed'>((resolve) => {
        const check = () => {
          if (finished() >= liveTarget) resolve('completed')
        }
        for (const record of records) {
          if (record.status === 'running') {
            void record.completion.then(check, check)
          }
        }
      }),
      new Promise<'blocked'>((resolve) => {
        if (!wakeOnBlocked || !countPendingBlocked) return
        poll = setInterval(() => {
          for (const record of records) {
            if (record.status === 'running' && countPendingBlocked(record.delegationId) > 0) {
              resolve('blocked')
              return
            }
          }
        }, intervalMs)
      }),
      new Promise<'timeout'>((resolve) => {
        timeout = setTimeout(() => resolve('timeout'), timeoutSeconds * 1000)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
    if (poll) clearInterval(poll)
  }
}

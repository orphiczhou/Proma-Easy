import type { NanjuGwtProgressEvent } from '@proma/shared'

/** 只维护展示生命周期，不生成测试证据；外层异常也必须让后台进度结束。 */
export function createEngineeringProgressLifecycle(send: (event: NanjuGwtProgressEvent) => void) {
  let last: NanjuGwtProgressEvent = { phase: 'start', scope: 'engineering', current: 0, total: 0, passed: 0, failed: 0, skipped: 0 }
  let finished = false
  const emit = (event: NanjuGwtProgressEvent): void => {
    if (finished) return
    last = { ...event }
    finished = event.phase === 'done'
    try { send(event) } catch { /* 展示失败不改变测试事实 */ }
  }
  return {
    emit,
    fail(error: unknown, cancelled: boolean): void {
      emit({ ...last, phase: 'done', scope: 'engineering', scenario: undefined,
        verdict: cancelled ? 'blocked' : 'error',
        reason: cancelled ? '测试已取消' : error instanceof Error ? error.message : String(error),
      })
    },
  }
}

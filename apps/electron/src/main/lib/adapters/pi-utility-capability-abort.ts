/**
 * host（main）侧 capability AbortController 按 queryId 清理（Terra MUST-2）。
 *
 * 独立成无 electron 依赖的纯模块，供 pi-utility-adapter 在 query 终结时调用，
 * 也便于单元测试：query 结束后，属于该 query 的 capability（如仍在等待用户作答的
 * askUserService）必须被立即中止，不能依赖 utility 侧 QUERY_ABORT 往返——
 * utility 崩溃/失联时主进程资源与 pending 交互仍需确定性清理。
 */

export interface CapabilityAbortEntry {
  controller: { abort(): void }
  queryId: string
}

/** 中止并移除指定 queryId 的全部 capability AbortController，返回中止数量。 */
export function abortCapabilityControllersForQuery(
  controllers: Map<string, CapabilityAbortEntry>,
  queryId: string,
): number {
  let aborted = 0
  for (const [requestId, entry] of controllers) {
    if (entry.queryId !== queryId) continue
    controllers.delete(requestId)
    entry.controller.abort()
    aborted += 1
  }
  return aborted
}

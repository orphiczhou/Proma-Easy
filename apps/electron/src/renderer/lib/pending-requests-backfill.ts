/**
 * 待处理请求回填（渲染进程重载后）。
 *
 * 背景：权限 / AskUser / ExitPlan 请求由主进程在发布时通过流式事件推给渲染进程；
 * 渲染进程重载（菜单「重新加载」）后已发布的事件不会重放，界面侧队列丢失，
 * 而主进程仍持有该请求（尤其跨 turn 存活的工程 host-task 批准），后台任务因此
 * 停在等待批准上且用户无法应答。
 *
 * 主进程已提供 `getPendingRequests` 快照（GET_PENDING_REQUESTS）。本模块只做纯函数
 * 合并，规则：
 * - 以 requestId 去重，只做并集，绝不覆盖或重排流中刚到的事件；
 * - 回填窗口内已收到 resolved 的 requestId 视为已结束，不因快照滞后而复活；
 * - 无变化时返回原 Map 引用，避免无意义的重渲染。
 */

/** 待处理请求的最小结构（与 PermissionRequest / AskUserRequest / ExitPlanModeRequest 共有的字段） */
export interface PendingRequestLike {
  requestId: string
  sessionId: string
}

/**
 * 把主进程快照并入现有按会话分组的队列。
 *
 * @param current 现有队列（渲染进程已知的流式事件结果）
 * @param incoming 主进程快照中的请求
 * @param resolvedDuringBackfill 回填前已收到 resolved 的 requestId（快照滞后时不复活）
 */
export function mergePendingRequests<T extends PendingRequestLike>(
  current: Map<string, readonly T[]>,
  incoming: readonly T[],
  resolvedDuringBackfill?: ReadonlySet<string>,
): Map<string, readonly T[]> {
  if (!incoming.length) return current
  const known = new Set<string>()
  for (const requests of current.values()) {
    for (const request of requests) known.add(request.requestId)
  }
  let next: Map<string, readonly T[]> | null = null
  for (const request of incoming) {
    if (resolvedDuringBackfill?.has(request.requestId)) continue
    if (known.has(request.requestId)) continue
    if (!next) next = new Map(current)
    const queue = next.get(request.sessionId) ?? []
    next.set(request.sessionId, [...queue, request])
    known.add(request.requestId)
  }
  return next ?? current
}

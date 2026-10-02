/** 宿主后台任务也会解决权限请求；不能只依赖横幅点击后的本地出队。 */
export function removeResolvedPermission<T extends { requestId: string }>(queue: Map<string, readonly T[]>, sessionId: string, requestId: string): Map<string, readonly T[]> {
  const current = queue.get(sessionId)
  if (!current?.some((request) => request.requestId === requestId)) return queue
  const next = new Map(queue)
  const remaining = current.filter((request) => request.requestId !== requestId)
  if (remaining.length) next.set(sessionId, remaining)
  else next.delete(sessionId)
  return next
}

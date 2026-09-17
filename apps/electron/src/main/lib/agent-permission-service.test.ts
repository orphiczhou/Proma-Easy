import { expect, test } from 'bun:test'
import { AgentPermissionService, type CanUseToolOptions } from './agent-permission-service'

function permissionOptions(signal: AbortSignal, toolUseID: string): CanUseToolOptions {
  return { signal, toolUseID, displayName: '删除分组', description: '删除 Todo 分组' }
}

test('Given a destructive planning request When it is approved Then approval is single-use and cannot create a session whitelist', async () => {
  const service = new AgentPermissionService()
  const controller = new AbortController()
  let firstRequest: { requestId: string; allowAlways?: boolean } | undefined

  const firstResult = service.requestSingleApproval(
    'session-1',
    'mcp__planning__delete_group',
    { id: 'group-1', scope: 'todo' },
    permissionOptions(controller.signal, 'tool-1'),
    (request) => { firstRequest = request },
  )

  expect(firstRequest?.allowAlways).toBe(false)
  expect(service.respondToPermission(firstRequest!.requestId, 'allow', true)).toBe('session-1')
  expect((await firstResult).behavior).toBe('allow')

  let secondRequest: { requestId: string } | undefined
  const secondResult = service.createCanUseTool('session-1', (request) => { secondRequest = request })(
    'mcp__planning__delete_group',
    { id: 'group-2', scope: 'todo' },
    permissionOptions(controller.signal, 'tool-2'),
  )

  expect(secondRequest).toBeDefined()
  expect(service.respondToPermission(secondRequest!.requestId, 'deny', false)).toBe('session-1')
  expect((await secondResult).behavior).toBe('deny')
})

test('Given 单次批准前已经取消 When 请求权限 Then 不向界面发出悬挂请求', async () => {
  const service = new AgentPermissionService()
  const controller = new AbortController(); controller.abort()
  let sent = 0
  const result = service.requestSingleApproval('s', 'EngineeringTest', {}, permissionOptions(controller.signal, 'cancelled'), () => { sent++ })
  expect(sent).toBe(0)
  expect((await result).behavior).toBe('deny')
})

test('Given 单次批准事件同步应答 When 发布请求 Then 应答能找到已登记请求', async () => {
  const service = new AgentPermissionService()
  const controller = new AbortController()
  const responses: Array<string | null> = []
  const result = service.requestSingleApproval('s', 'EngineeringTest', {}, permissionOptions(controller.signal, 'immediate'), (request) => {
    responses.push(service.respondToPermission(request.requestId, 'allow', false))
  })
  expect(responses).toEqual(['s'])
  expect((await result).behavior).toBe('allow')
})

test('Given 单次批准界面无法发布 When 请求权限 Then 返回拒绝并清除挂起状态', async () => {
  const service = new AgentPermissionService()
  const controller = new AbortController()
  const result = await service.requestSingleApproval('s', 'EngineeringTest', {}, permissionOptions(controller.signal, 'send-error'), () => { throw new Error('fixture transport unavailable') })
  expect(result.behavior).toBe('deny')
  expect(service.getPendingRequests()).toEqual([])
})

test('Given 后台工程任务与turn各有批准 When turn结束 Then 只清turn批准而显式停止仍清全部', async () => {
  const service = new AgentPermissionService()
  const controller = new AbortController()
  const host = service.requestSingleApproval('s', 'EngineeringTest', {}, permissionOptions(controller.signal, 'host'), () => {}, { lifetime: 'host-task' })
  const turn = service.requestSingleApproval('s', 'Other', {}, permissionOptions(controller.signal, 'turn'), () => {})
  expect(service.getPendingRequests().length).toBe(2)
  service.clearSessionPending('s', { preserveHostTasks: true })
  expect((await turn).behavior).toBe('deny')
  expect(service.getPendingRequests().map((request) => request.toolName)).toEqual(['EngineeringTest'])
  service.clearSessionPending('s')
  expect((await host).behavior).toBe('deny')
  expect(service.getPendingRequests()).toEqual([])
})

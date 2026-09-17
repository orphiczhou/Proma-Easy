/** 工程测试复用现有单次审批事件；这是宿主内部适配器，不注册新的Agent工具。 */
import { randomUUID } from 'node:crypto'
import { permissionService } from './agent-permission-service'
import type { AgentPermissionService } from './agent-permission-service'
import type { PermissionRequest } from '@proma/shared'
import type { EngineeringExecutionInput } from './nanju-engineering-execution'
import { describeEngineeringServicePlan } from './nanju-engineering-service'

export function createEngineeringTestApproval(
  sessionId: string,
  sendToRenderer: (request: PermissionRequest) => void,
  service: AgentPermissionService = permissionService,
  onResolved?: (event: { requestId: string; behavior: 'allow' | 'deny' }) => void,
): (input: EngineeringExecutionInput) => Promise<boolean> {
  return async (input) => {
    const { test, evidence, signal, projectDir } = input
    // B-b（C-review-2 N8/S3）：browser-url 测试无 driver 字段，批准文案必须展示真实服务计划
    // （runtime/path/argv/port/readyPath），否则用户看到的是「驱动：未声明」却在批准一个本地服务。
    const servicePlanLine = test.service ? describeEngineeringServicePlan(test.service) : null
    const description = [
      `工程测试：${test.id}（${test.layer} / ${test.adapter}）`,
      `项目：${projectDir}；被测产物：08_APP/${test.target}`,
      ...(servicePlanLine ? [servicePlanLine] : []),
      `运行时：${test.driver?.runtime ?? '注册驱动'}；驱动：${test.driver?.path ?? '未声明'}；参数：${JSON.stringify(test.driver?.args ?? [])}`,
      `说明：${test.command}；用户故事：${test.covers.join('、') || '辅助测试，不计用户故事覆盖'}`,
      `批准绑定版本：${evidence.digest}`,
      '项目测试脚本不是沙箱，可能读写文件、访问网络、麦克风或其他应用。请先核对驱动代码和副作用；只批准本次运行，不授权安装、扩大设备权限或后续运行。',
      '结果仅证明该驱动记录的检查；不能代替对真实系统行为的独立验收。',
    ].join('\n')
    let publishedRequestId: string | null = null
    const result = await service.requestSingleApproval(sessionId, 'EngineeringTest', {
      projectDir, testId: test.id, target: test.target, driver: test.driver, service: test.service, evidenceDigest: evidence.digest,
      description,
    }, { signal, toolUseID: randomUUID(), displayName: '批准一次工程测试', title: '工程测试单次执行', description }, (request) => { publishedRequestId = request.requestId; sendToRenderer(request) }, { lifetime: 'host-task' })
    if (publishedRequestId) {
      try { onResolved?.({ requestId: publishedRequestId, behavior: result.behavior }) } catch { /* 界面通知失败不改变批准事实 */ }
    }
    return result.behavior === 'allow'
  }
}

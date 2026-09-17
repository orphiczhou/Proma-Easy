/**
 * W19 缺陷B：跨工作区首发竞态 — 空会话工作区自愈测试（v0.17.87）。
 *
 * 背景（E2E 2026-09-05 发现1，R 级 + Dev 会话注册表实证）：
 * 南大创建链显式以南大工作区建会话（TabContent → createAgentSession(name, undefined, ws.id)），
 * 会话 meta.workspaceId 本身正确；但渲染端 agentSessionsAtom 未同步新会话时，AgentView
 * 以全局工作区回退派发 requestedWorkspaceId（可能是默认工作区），与主进程权威会话归属
 * 比对即硬拒「会话项目不匹配」（canRetry:false），被拒会话从未获得 sdkSessionId。
 * ⚠️ 工单原始根因把不匹配方向写反（以为会话继承默认工作区）；Dev 注册表实证
 * ca906911.workspaceId = 南大工作区（16171483-…），错误工作区在请求侧。
 *
 * 覆盖面：
 * - 行为级（S）：resolveWorkspaceMismatchSelfHeal 判定矩阵 —— 在
 *   agent-orchestrator-preflight.behavior.ts（fixture，不带 .test 后缀避免目录级发现）
 *   中真实执行；本文件以 Bun.spawn 子进程隔离运行并断言全绿。隔离原因：导入
 *   agent-orchestrator 需要 mock.module('electron') + 预载 agent-service，进程级 mock
 *   会污染同批其他测试文件（实证：合跑时 agent-session-manager 被早先文件部分替换后
 *   导入即 SyntaxError，反向亦然——与 nanju-confirm-advance.test.ts 顶部警告同类）。
 * - 接线级（M，参考 agent-session-delete-abort.test.ts 源码断言模式）：preflight 块
 *   调用自愈判定、reject 仍走 reportPreflightError 硬拒、rebind 落 updateAgentSessionMeta
 *   并同步后续 workspaceId 取值、空会话判定取 sdkSessionId、南大绑定走会话-项目注册表；
 *   TabContent 创建会话后立即并入渲染端会话列表。
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('渲染端创建链（M 级：源码断言）', () => {
  const tabContentSource = readFileSync(
    new URL('../../renderer/components/tabs/TabContent.tsx', import.meta.url),
    'utf-8',
  )

  test('南大会话创建显式携带南大工作区（不继承活跃会话上下文）', () => {
    expect(tabContentSource).toContain('createAgentSession(name, undefined, ws.id)')
  })

  test('创建成功后立即并入渲染端会话列表（消除首发回退全局工作区的竞态窗口）', () => {
    const creation = tabContentSource.slice(
      tabContentSource.indexOf('createAgentSession(name, undefined, ws.id)'),
      tabContentSource.indexOf('nanjuCreateProject({'),
    )
    expect(creation).toContain('agentSessionsAtom')
    expect(creation).toContain('[created, ...prev]')
    // 幂等：已存在（如事件竞态先到）不重复插入
    expect(creation).toContain('prev.some((s) => s.id === created.id)')
  })
})

describe('preflight 调用点接线（M 级：源码断言，orchestrator 为大方法无法实例化单测）', () => {
  const orchestratorSource = readFileSync(new URL('./agent-orchestrator.ts', import.meta.url), 'utf-8')
  const preflightBlock = orchestratorSource.slice(
    orchestratorSource.indexOf('let sessionWorkspaceId = sessionMeta?.workspaceId'),
    orchestratorSource.indexOf('const workspaceId = sessionWorkspaceId ?? requestedWorkspaceId'),
  )

  test('不匹配时先过自愈判定，reject 分支才走 reportPreflightError 且保持 canRetry:false 硬拒文案', () => {
    expect(preflightBlock).toContain('resolveWorkspaceMismatchSelfHeal({')
    expect(preflightBlock.indexOf("resolution === 'reject'")).toBeLessThan(
      preflightBlock.indexOf("title: '会话项目不匹配'"),
    )
    expect(preflightBlock).toContain("title: '会话项目不匹配'")
    expect(preflightBlock).toContain('canRetry: false')
  })

  test('空会话判定以 sdkSessionId 为准（从未运行过 = 从未获得 sdkSessionId）', () => {
    expect(preflightBlock).toContain('Boolean(sessionMeta?.sdkSessionId)')
  })

  test('rebind 分支：写会话注册表并同步后续 workspaceId 取值（避免改绑后仍用旧工作区）', () => {
    expect(preflightBlock).toContain('updateAgentSessionMeta(sessionId, { workspaceId: requestedWorkspaceId })')
    expect(preflightBlock).toContain('sessionWorkspaceId = requestedWorkspaceId')
  })

  test('南大项目绑定判定走会话-项目注册表（nanju-phase-gate 的 findNanjuProjectBySession）', () => {
    expect(preflightBlock).toContain('findNanjuProjectBySession(sessionWorkspace.slug, sessionId)')
    // 有运行历史时无需查注册表（已注定 reject）
    expect(preflightBlock.indexOf('Boolean(sessionMeta?.sdkSessionId)')).toBeLessThan(
      preflightBlock.indexOf('findNanjuProjectBySession'),
    )
  })

  test('自愈留有归因日志（改绑/保持两个分支各一条 console）', () => {
    expect(preflightBlock).toContain('空会话工作区自愈（改绑）')
    expect(preflightBlock).toContain('空会话工作区自愈（保持会话工作区）')
  })
})

describe('resolveWorkspaceMismatchSelfHeal 判定矩阵（S 级：真实函数执行，子进程隔离）', () => {
  test(
    'fixture 全绿（E2E 实测方向保会话 / 工单红测试1改绑 / 红测试2有运行历史硬拒 / 红测试3幽灵工作区硬拒 / 无不匹配直通）',
    async () => {
      const fixturePath = new URL('./agent-orchestrator-preflight.behavior.ts', import.meta.url).pathname
      const proc = Bun.spawn([process.execPath, 'test', fixturePath], {
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, PROMA_AGENT_RUNTIME: 'off' },
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      const output = `${stdout}\n${stderr}`
      if (exitCode !== 0) {
        console.error(`[W19 缺陷B] behavior fixture 失败 (exit=${exitCode}):\n${output}`)
      }
      expect(exitCode).toBe(0)
      // 文案与判定矩阵都在同一 fixture 里真实执行；只锁「全绿」与最低用例数，新增用例不必同步改数字。
      const passCount = Number(output.match(/(\d+) pass/)?.[1] ?? '0')
      expect(passCount).toBeGreaterThanOrEqual(9)
      expect(output).toContain('0 fail')
    },
    60000,
  )
})

describe('I1 后台任务恢复接线（M 级：源码断言，orchestrator 为大方法无法实例化单测）', () => {
  const orchestratorSource = readFileSync(new URL('./agent-orchestrator.ts', import.meta.url), 'utf-8')

  test('重复触发 testing 注入可见提示，不再静默吞掉', () => {
    const guardBlock = orchestratorSource.slice(
      orchestratorSource.indexOf('GWT 验收已在进行中'),
      orchestratorSource.indexOf('this.runningGwtProjects.add(projectId)'),
    )
    expect(guardBlock).toContain('buildNanjuTestingAlreadyRunningNotice(projectName)')
    expect(guardBlock).toContain('this.injectNanjuAssistantMessage(sessionId,')
  })

  test('启动文案按契约是否齐备分流（不无条件承诺逐项批准）', () => {
    expect(orchestratorSource).toContain('buildNanjuTestingStartNotice({ useEngineeringDrivers, engineeringContractReady })')
    expect(orchestratorSource).toContain("existsSync(join(engineeringProjectDir, ENGINEERING_CONTRACT_PATH))")
  })

  test('blocked 分支补工程进度终态（缺契约时 runner 不发事件）', () => {
    const blockedBlock = orchestratorSource.slice(
      orchestratorSource.indexOf("if (outcome.verdict === 'blocked') {"),
      orchestratorSource.indexOf('环境/驱动阻塞不是代码失败'),
    )
    expect(blockedBlock).toContain("engineeringProgress.emit({")
    expect(blockedBlock).toContain("verdict: 'blocked'")
  })

  test('legacy 路径外层异常也发进度终态（不再停在「正在自动验收测试」）', () => {
    const catchBlock = orchestratorSource.slice(
      orchestratorSource.indexOf('if (useEngineeringDrivers) engineeringProgress.fail'),
      orchestratorSource.indexOf('[南大路由] GWT 验收执行异常'),
    )
    expect(catchBlock).toContain('else emitProgress({')
    expect(catchBlock).toContain("phase: 'done'")
  })
})

describe('I2 B-a 委派视觉槽位盖章接线（M 级：源码断言 + 行为 BDD 在 b2-slot-stamp 文件）', () => {
  const orchestratorSource = readFileSync(new URL('./agent-orchestrator.ts', import.meta.url), 'utf-8')
  const toolsSource = readFileSync(new URL('./agent-collaboration-tools.ts', import.meta.url), 'utf-8')
  const sessionManagerSource = readFileSync(new URL('./agent-session-manager.ts', import.meta.url), 'utf-8')

  test('canUseTool 把 toolInput 交给委派拦截（盖章登记入口）', () => {
    expect(orchestratorSource).toContain('this.registerNanjuDelegationWatch(workspaceSlug ?? \'\', sessionId, toolName, input)')
    expect(orchestratorSource).toContain('toolName: string, toolInput?: Record<string, unknown>')
  })

  test('盖章端点判定用 producer 权威 resolver，且只有 resolved 才登记（否则撤销）', () => {
    expect(orchestratorSource).toContain('resolveVisualValidatorSlotForProject(project)')
    expect(orchestratorSource).toContain('registerAuthorizedVisualDelegationEndpoint(')
    expect(orchestratorSource).toContain("slot && slot.status === 'resolved' ? { channelId: slot.channelId, modelId: slot.modelId } : null")
  })

  test('两个公开工具入口都是「先剥离后盖章」（模型自报 slot 不会成为权威）', () => {
    const single = toolsSource.indexOf('applyAuthorizedDelegationSlot(ctx.sessionId, stripInternalDelegationFields(params as DelegateAgentArgs))')
    expect(single).toBeGreaterThan(-1)
    const batch = toolsSource.indexOf('.map((item) => applyAuthorizedDelegationSlot(ctx.sessionId, stripInternalDelegationFields(item)))')
    expect(batch).toBeGreaterThan(-1)
  })

  test('盖章只在端点全等时发生（channel 与 model 双重比对）', () => {
    const fnStart = toolsSource.indexOf('function applyAuthorizedDelegationSlot')
    const fnBody = toolsSource.slice(fnStart, toolsSource.indexOf('function normalizeTitle'))
    expect(fnBody).toContain('authorizedVisualEndpoints.get(parentSessionId)')
    expect(fnBody).toContain('!== endpoint.channelId')
    expect(fnBody).toContain('!== endpoint.modelId')
    expect(fnBody).toContain("slot: 'visual-validator'")
  })

  test('delegationSlot 进入 updateAgentSessionMeta 白名单，类型桥接已删', () => {
    expect(sessionManagerSource).toContain("'delegationGoal' | 'nanjuProxy' | 'delegationSlot'")
    expect(toolsSource).not.toContain('as Partial<AgentSessionMeta>')
    expect(toolsSource).not.toContain('writeDelegationSlotMeta')
    expect(toolsSource).toContain('updateAgentSessionMeta(child.id, { delegationSlot: slot })')
  })
})

describe('I2 B-d 修复环接线（M 级：源码断言 + 行为 BDD 在 nanju-repair-dispatch 文件）', () => {
  const source = () => readFileSync(new URL('./agent-orchestrator.ts', import.meta.url), 'utf-8')

  test('blocked 早退原样保留在修复调度之前（不烧修复预算）', () => {
    const src = source()
    const blockedEarly = src.indexOf("if (outcome.verdict === 'blocked') {")
    const dispatchCall = src.indexOf('dispatchRepairDecision({')
    expect(blockedEarly).toBeGreaterThan(-1)
    expect(dispatchCall).toBeGreaterThan(blockedEarly)
    // 早退块内不得出现任何修复记账/规划
    const earlyBlock = src.slice(blockedEarly, src.indexOf('// 熔断状态机接入', blockedEarly))
    expect(earlyBlock).not.toContain('appendRepairAttempt')
    expect(earlyBlock).not.toContain('planNextRepair')
    expect(earlyBlock).toContain('return')
  })

  test('规划与读盘同源：plan 用 planNextRepairForProject（不手拼 attempts/logStatus）', () => {
    const src = source()
    expect(src).toContain('plan: (request) => planNextRepairForProject(workspaceSlug, projectId, request)')
    expect(src).not.toContain('logStatus:')
  })

  test('修复调度只对 verdict=fail 生效，且 phaseGuard 计数先于调度（同轮一起收口）', () => {
    const src = source()
    const guardUpdate = src.indexOf("const guardKind = outcome.verdict === 'pass' ? 'reset'")
    const dispatchCall = src.indexOf('dispatchRepairDecision({')
    const failGate = src.indexOf("if (outcome.verdict === 'fail') {\n          const { dispatchRepairDecision }")
    expect(guardUpdate).toBeGreaterThan(-1)
    expect(failGate).toBeGreaterThan(guardUpdate)
    expect(dispatchCall).toBeGreaterThan(failGate)
  })

  test('环境类 → 注入安抚并 return；熔断 → 记账/埋点/广播/文案后 return（不再落回炉分支）', () => {
    const src = source()
    const envBlock = src.slice(src.indexOf("if (decision.action === 'notify-environment') {"), src.indexOf("if (decision.action === 'circuit-break') {"))
    expect(envBlock).toContain('this.injectNanjuAssistantMessage(sessionId, decision.message)')
    expect(envBlock).toContain('return')
    expect(envBlock).not.toContain('appendRepairAttempt')
    const cbBlock = src.slice(src.indexOf("if (decision.action === 'circuit-break') {"), src.indexOf("if (decision.action === 'repair') {"))
    expect(cbBlock).toContain('console.warn(decision.logText)')
    expect(cbBlock).toContain("source: 'repair_budget'")
    expect(cbBlock).toContain('humanDecisionLine')
    expect(cbBlock).toContain('return')
  })

  test('append 写失败带入下一轮 fail-closed（内存态），且 guard 打开时不授权新修复', () => {
    const src = source()
    expect(src).toContain('runtime.logWriteFailed = decision.writeFailed')
    expect(src).toContain('let repairAuthorized = false')
    expect(src).toContain('repairAuthorized = !gwtCircuitOpen')
    expect(src).toContain('&& !repairAuthorized')
  })

  test('回滚经 D 端口薄壳：可用性以「已关联文件快照」判定，快照 id 来自 pre-modify 优先', () => {
    const src = source()
    expect(src).toContain('const rollbackTarget = resolveRepairRollbackSnapshot(workspaceSlug, projectId)')
    expect(src).toContain('fileRollbackAvailable: rollbackTarget !== null')
    expect(src).toContain('resolveSnapshotId: () => rollbackTarget?.snapshotId ?? null')
    expect(src).toContain('rollback: (snapshotId) => createProjectFileRollbackPort(workspaceSlug, projectId).rollback(snapshotId)')
  })

  test('guard 行为阈值 = 首产 + 修复预算（4），两计数不互相增量', () => {
    const project = readFileSync(new URL('./nanju-project.ts', import.meta.url), 'utf-8')
    expect(project).toContain('phaseFailBreakThreshold: 4,')
    const loop = readFileSync(new URL('./nanju-repair-loop.ts', import.meta.url), 'utf-8')
    expect(loop).toContain('export const REPAIR_MAX_ATTEMPTS = 3')
  })
})

/**
 * W17（v0.17.77）：阶段推进链消费器——PHASE_ADVANCE 标记按序消费 + 确认检测共用实现。
 *
 * 从 agent-orchestrator result/事件流检测块抽出的纯业务模块（无 electron 依赖，
 * 副作用经 PhaseAdvanceHooks 注入），供编排器三处调用：
 * - result 检测块：collectPhaseAdvanceStages（nanju-router-gate 纯函数）收集后
 *   调 consumePhaseAdvanceMarks 按序消费（W17 Q1 主修）；
 * - 事件流 user 消息 + run 初始输入（sendMessage 入口）共用 checkConfirmAdvanceInput
 *   （W17 Q2 主修：同一函数，勿复制逻辑，防两处口径漂移）。
 *
 * 消费语义（工单 w17-workorder §1）：
 * - 逐个过 W11 validateAdvanceTarget（规则零变化）：合法 → 推进状态机 + 落库
 *   （_nanju-projects.json currentStage/updatedAt）+ phase.elapsed 埋点；
 *   非法/跳级 → 拒绝 + 注入纠正教育消息（复用 W11 现有提示形态）；
 *   W17 起 W11 目标校验前置到产出文件验证之前——对非法目标 id（如终局复测的
 *   test/delivery）先于文件验证拒绝，避免对根本不存在的目标做产出验证的语义错位；
 * - 同轮多标记按序消费：前序消费推进 currentStage 后，后续标记按新状态校验；
 * - 防重放：已成功消费的目标不再二次消费（同 run 去重；重复声明跳过）。
 */
import type { PromaPermissionMode } from '@proma/shared'
import type { NanjuGuardStage } from './nanju-project'
import { verifyPhaseOutput } from './nanju-router-gate'

/** 编排器副作用注入（eventBus 注入 / GWT 触发 / Todo 收尾——见 agent-orchestrator 薄壳装配） */
export interface PhaseAdvanceHooks {
  /** 注入可见 assistant 消息（AC L-002 文件验证拦截形态：SDKMessage 包装由编排器负责） */
  emitAssistantMessage: (sessionId: string, text: string) => void
  /** 注入可见 assistant 消息（W11 拒绝/上游提示等教育消息形态） */
  injectAssistantMessage: (sessionId: string, text: string) => void
  /** 触发 GWT 验收测试（testing 重入） */
  triggerGwtRun: (input: {
    workspaceSlug: string
    projectId: string
    projectName: string
    projectMode: 'quick' | 'iterative'
    sessionId: string
    resume: { channelId: string; modelId?: string; workspaceId?: string; permissionModeOverride?: PromaPermissionMode }
  }) => void
  /** GWT 交付门禁（testing → delivered） */
  checkGwtDeliveryGate: (workspaceSlug: string, projectId: string) => string | null
  /** 阶段推进 Todo 兜底收尾 */
  finalizePhaseTodos: (sessionId: string) => void
}

/**
 * W10/W17/W18：确认响应推进检测（单条用户文本）——事件流路径与 run 初始输入路径共用。
 * 语义见模块头；置位/清除/埋点与 W10 原事件流块完全一致，不自动推进（W10 设计决策）。
 *
 * v2.4（D7 §1 I1，2026-09-11）：确认命中时同步置位推进授权 confirmAuthorization——
 * - I1-① ask-answer（横幅 IPC 结构化答案，不可伪造）：置位
 *   {source:'ask-answer', expectedTarget=阶段图唯一下一阶段}；无活跃确认问句在场时
 *   埋 clarify.suspect-fake-confirm 观测（不阻断——结构化通道无伪造面，主口径按子任务）；
 * - I1-② 真·用户消息（opts.humanOrigin===true 且 activeConfirmAsk 活跃）：置位
 *   {source:'user-message', expectedTarget=activeConfirmAsk.expectedTarget}（确认上下文
 *   绑定，R4-02）；无活跃问句的散点确认词只埋点不授权；
 * - 其余（humanOrigin≠true 的注入文本：send_message/HTTP bridge/事件流 tool_result
 *   重放/队列重放等）一律不授权（R4-01 红测：确认词冒充无效）。
 * confirmPendingStage（W10 提示注入）语义不变，与授权相互独立。
 *
 * W18 Wave2（v0.17.83）交付域（先于普通 confirmPending 检测，两者独立不至扩散）：
 * - 否定词（DELIVERY_REJECT_WORDS，两来源均生效）→ 清除 ack+challenge；
 * - ask-answer 来源且精确等值「满意交付」且 testing 阶段且 challenge 在场且磁盘报告
 *   verdict=pass 且新 schema 合格 → setProjectDeliveryAck(challenge.reportRunId) +
 *   清除 challenge + 埋点 delivery.ack-recorded（ack 只认登记值，不绑磁盘当前 runId）；
 * - message 来源命中「满意交付」→ 仅埋点 delivery.ack-rejected-freetext（观测，不置位）。
 * 普通确认语义（'满意交付' 在 CONFIRM_ADVANCE_KEYWORDS 的既有置位行为）不动。
 *
 * @param source 'ask-answer' = AskUserQuestion 横幅答案（结构化精确选项，可置位交付 ack）；
 *   'message' = 事件流/初始输入自由文本（只观测不置位；旧 tool_result 重放走此路径天然免疫）
 * @param opts.humanOrigin v2.4 I1-②a 消息来源分级：仅 sendMessage 入口按
 *   AgentSendInput.humanOrigin 透传（真 UI 人类输入=true）；事件流路径缺省不传
 *   （false——事件流 user 消息实际为工具注入，入口路径已覆盖真用户初始输入）
 */
export function checkConfirmAdvanceInput(
  sessionId: string,
  workspaceSlug: string,
  userText: string,
  source: 'message' | 'ask-answer' = 'message',
  opts?: { humanOrigin?: boolean },
): void {
  if (userText.trim() === '') return
  try {
    const { listNanjuProjects, judgeConfirmAdvance, setProjectConfirmPending, clearProjectConfirmPending } =
      require('./nanju-project') as typeof import('./nanju-project')
    const project = listNanjuProjects(workspaceSlug).find(
      (p: { sessionId?: string }) => p.sessionId === sessionId,
    )
    if (!project) return

    // —— W18 交付域（双事实门禁的确认侧）——
    try {
      checkDeliveryConfirmation(project, workspaceSlug, userText, source)
    } catch (deliveryErr) {
      console.warn('[南大路由] 交付确认检测异常（不阻断普通确认检测）:', deliveryErr instanceof Error ? deliveryErr.message : String(deliveryErr))
    }

    const verifyError = verifyPhaseOutput(workspaceSlug, project.projectId, project.currentStage as import('./nanju-router').PhaseId)
    const action = judgeConfirmAdvance(userText, project.currentStage, verifyError)
    if (action === 'set') {
      // —— v2.4（D7 §1 I1 + 工程审查 F2-3②/F2-4）：确认词命中后按「活跃收口问句匹配」
      // 统一决定置位（confirmPending 强推进提示 + confirmAuthorization 授权同拍）或纯观测——
      // 散点确认词（无活跃问句）与注入文本（humanOrigin≠true）既不授权也不注入 ⏩ 提示
      //（F2-4/#15：防「命令推进→被拒→循环」对话污染）。
      try {
        const {
          setConfirmAuthorization, getActiveConfirmAsk, clearActiveConfirmAsk,
        } = require('./nanju-project') as typeof import('./nanju-project')
        const { getNextPhase } = require('./nanju-router') as typeof import('./nanju-router')
        const { recordTelemetry } = require('./nanju-telemetry') as typeof import('./nanju-telemetry')
        let authorized = false
        let expectedTarget = ''
        let authSource: 'ask-answer' | 'user-message' = 'user-message'
        if (source === 'ask-answer') {
          // I1-①：横幅 IPC 结构化答案（不可伪造）。F2-3②（#3）：置位前校验存在匹配的
          // 活跃收口问句（activeConfirmAsk 在场 ∧ expectedTarget 与 harness 按阶段图算的
          // 唯一合法下一阶段对齐）——中间确认（环境安装等）不登记问句，其横幅答案
          // 不构成推进授权；不匹配只埋 clarify.suspect-fake-confirm 不授权。
          const ask = getActiveConfirmAsk(workspaceSlug, project.projectId)
          const harnessExpected = getNextPhase(project.mode, project.currentStage as import('./nanju-router').PhaseId)
          if (ask && harnessExpected && ask.expectedTarget === harnessExpected) {
            authorized = true
            expectedTarget = harnessExpected
            authSource = 'ask-answer'
          } else {
            try {
              recordTelemetry(workspaceSlug, 'clarify.suspect-fake-confirm', {
                project_id: project.projectId,
                stage: project.currentStage,
                reason: ask ? 'target-mismatch' : 'no-active-ask',
                textPreview: userText.slice(0, 40),
              }, project.projectId)
            } catch { /* 埋点失败不影响 */ }
            console.log(`[南大路由] ask-answer 无匹配活跃收口问句（${ask ? '目标不匹配' : '无问句'}），不授权（${project.name}）`)
          }
        } else if (opts?.humanOrigin === true) {
          // I1-②：真 UI 人类消息 + 活跃收口问句绑定（R4-02：散点确认词不授权）
          const ask = getActiveConfirmAsk(workspaceSlug, project.projectId)
          if (ask) {
            authorized = true
            expectedTarget = ask.expectedTarget
            authSource = 'user-message'
          } else {
            try {
              recordTelemetry(workspaceSlug, 'confirm.scatter-no-auth', {
                project_id: project.projectId,
                stage: project.currentStage,
                textPreview: userText.slice(0, 40),
              }, project.projectId)
            } catch { /* 埋点失败不影响 */ }
            console.log(`[南大路由] 确认词命中但无活跃收口问句，不授权不提示（散点确认，${project.name}）`)
          }
        }
        // 其余（source='message' 且 humanOrigin≠true）：send_message/HTTP bridge/事件流
        // tool_result 重放/队列重放等注入文本——不授权不置 confirmPending（R4-01）
        if (authorized) {
          setProjectConfirmPending(workspaceSlug, project.projectId, project.currentStage)
          try {
            recordTelemetry(workspaceSlug, 'confirm.advance-hint', {
              project_id: project.projectId,
              stage: project.currentStage,
              mode: project.mode,
            }, project.projectId)
          } catch { /* 埋点失败不影响置位 */ }
          setConfirmAuthorization(workspaceSlug, project.projectId, authSource, expectedTarget)
          clearActiveConfirmAsk(workspaceSlug, project.projectId) // 确认已消费问句（授权路径）
          console.log(`[南大路由] 确认检测：置位 confirmPending=${project.currentStage} + 授权 ${authSource} → ${expectedTarget}（${project.name}）`)
        }
      } catch (authErr) {
        console.warn('[南大路由] 确认检测/授权置位异常（不阻断）:', authErr instanceof Error ? (authErr as Error).message : String(authErr))
      }
    } else if (action === 'clear') {
      clearProjectConfirmPending(workspaceSlug, project.projectId)
      console.log(`[南大路由] 确认检测：反义词清除 confirmPending（${project.name}）`)
    }
    // v2.4 F2-5（#5/D7 §3 清除条件）：活跃问句失效 = 应答（ask-answer 到达）∨ 新
    // humanOrigin 消息到达（无论是否命中确认词——反义词/无关联消息同样终结问句
    // 上下文；命中确认词的授权路径已在上方清除，此处幂等兜底）。TTL 过期由读取侧
    // 惰性清除（getActiveConfirmAsk）。
    if (source === 'ask-answer' || opts?.humanOrigin === true) {
      try {
        const { clearActiveConfirmAsk } = require('./nanju-project') as typeof import('./nanju-project')
        clearActiveConfirmAsk(workspaceSlug, project.projectId)
      } catch { /* 清除失败不影响主流程 */ }
    }
  } catch (e) {
    console.warn('[南大路由] 确认检测异常（不阻断）:', e instanceof Error ? e.message : String(e))
  }
}

/** W18 交付域检测（checkConfirmAdvanceInput 内部段；project 已解析） */
function checkDeliveryConfirmation(
  project: { projectId: string; name: string; currentStage: string; mode: string },
  workspaceSlug: string,
  userText: string,
  source: 'message' | 'ask-answer',
): void {
  const {
    readProjectInfo, setProjectDeliveryAck, clearProjectDeliveryAck, clearProjectDeliveryChallenge,
    getNanjuProjectDir, DELIVERY_REJECT_WORDS,
  } = require('./nanju-project') as typeof import('./nanju-project')
  const trimmed = userText.trim()
  const info = readProjectInfo(workspaceSlug, project.projectId)

  // 1) 否定词：用户明确反悔 → 清除 ack+challenge（两来源一致；幂等）
  if (DELIVERY_REJECT_WORDS.some((w) => userText.includes(w))) {
    if (info?.deliveryAck || info?.deliveryChallenge) {
      clearProjectDeliveryAck(workspaceSlug, project.projectId)
      clearProjectDeliveryChallenge(workspaceSlug, project.projectId)
      console.log(`[南大路由] 交付确认检测：否定词清除 ack+challenge（${project.name}）`)
    }
    return
  }

  // 2) ask-answer 精确等值 + 全前置 → 登记交付 ack（只认 challenge 登记值）
  if (source === 'ask-answer' && trimmed === '满意交付') {
    const challenge = info?.deliveryChallenge
    if (project.currentStage !== 'testing' || !challenge) {
      console.log(`[南大路由] 交付确认检测：ask-answer 满意交付但前置不满足（stage=${project.currentStage}，challenge=${challenge ? '在场' : '缺失'}），不置位`)
      return
    }
    // 磁盘报告须 verdict=pass 且新 schema 合格（旧报告/失败报告不置位）
    const { readFileSync, existsSync } = require('node:fs')
    const { join } = require('node:path')
    const { hasGwtDeliverySchemaFields } = require('./nanju-gwt-runner') as typeof import('./nanju-gwt-runner')
    const reportPath = join(getNanjuProjectDir(workspaceSlug, project.projectId), '06_TESTS', 'report.json')
    let reportPass = false
    try {
      if (existsSync(reportPath)) {
        const report = JSON.parse(readFileSync(reportPath, 'utf-8')) as { verdict?: string } & Record<string, unknown>
        reportPass = report?.verdict === 'pass' && hasGwtDeliverySchemaFields(report as Parameters<typeof hasGwtDeliverySchemaFields>[0])
      }
    } catch { /* 报告损坏按不置位处理 */ }
    if (!reportPass) {
      console.log(`[南大路由] 交付确认检测：磁盘报告非 pass/新 schema，不置位 ack（${project.name}）`)
      return
    }
    const { at, reportRunId, rewritten } = setProjectDeliveryAck(workspaceSlug, project.projectId, challenge.reportRunId)
    clearProjectDeliveryChallenge(workspaceSlug, project.projectId)
    if (rewritten) {
      try {
        const { recordTelemetry } = require('./nanju-telemetry') as typeof import('./nanju-telemetry')
        recordTelemetry(workspaceSlug, 'delivery.ack-recorded', {
          project_id: project.projectId,
          mode: project.mode,
          report_run_id: reportRunId,
          source,
          at,
        }, project.projectId)
      } catch { /* 埋点失败不影响置位 */ }
      console.log(`[南大路由] 交付确认检测：登记 deliveryAck（runId=${reportRunId}，${project.name}）`)
    }
    return
  }

  // 3) message 来源命中交付确认词 → 仅观测（自由文本/旧 tool_result 重放不置位）
  if (source === 'message' && userText.includes('满意交付')) {
    try {
      const { recordTelemetry } = require('./nanju-telemetry') as typeof import('./nanju-telemetry')
      recordTelemetry(workspaceSlug, 'delivery.ack-rejected-freetext', {
        project_id: project.projectId,
        mode: project.mode,
        stage: project.currentStage,
        challenge_present: Boolean(info?.deliveryChallenge),
      }, project.projectId)
    } catch { /* 埋点失败不影响 */ }
    console.log(`[南大路由] 交付确认检测：message 来源命中交付词，仅观测不置位（${project.name}）`)
  }
}

export function consumePhaseAdvanceMarks(
sessionId: string,
workspaceSlug: string,
marks: readonly string[],
resume: { channelId: string; modelId?: string; workspaceId?: string; permissionModeOverride?: PromaPermissionMode },
hooks: PhaseAdvanceHooks,
): string | null {
  let advanced: string | null = null
  const consumedStages = new Set<string>()
  // 文件验证
  const { verifyPhaseOutput } = require('./nanju-router-gate')
  const { listNanjuProjects, updateNanjuProject } = require('./nanju-project')
  for (const mark of marks) {
    const newStage = mark
    console.log(`[南大路由] 消费 PHASE_ADVANCE 标记: ${newStage}`)
    // W17：每轮重新读取项目——前序标记消费可能已推进 currentStage（按序消费基于真实状态）
    const projects = listNanjuProjects(workspaceSlug)
    const project = projects.find((p: { sessionId: string }) => p.sessionId === sessionId)
    if (!project) {
      console.log(`[南大路由] 未找到关联的南大项目: sessionId=${sessionId}`)
      break
    }
    // W17 防重放：同 run 内已成功消费的目标直接跳过（重复声明/重放不二次推进）
    if (consumedStages.has(newStage)) {
      console.log(`[南大路由] 标记 ${newStage} 本轮已消费过，跳过（防重放）`)
      continue
    }
    {
      // ——以下为原单标记消费段原样保留（W7 置位 / verifyPhaseOutput / 埋点 /
      // testing 分流 / W11 校验 / 推进钩子），仅三处 W17 变化：闭包依赖改经
      // resume/advanced 传递；W11 目标校验前置到文件验证之前（工单 §1 消费语义：
      // 按序逐个过 validateAdvanceTarget——对非法目标 id 先于产出验证拒绝）；
      // 成功出口记录 consumedStages 去重。Sprint B：testing 阶段推进语义分叉——
      // ① PHASE_ADVANCE: testing 重入（currentStage 已是 testing）= 场景已生成/
      //    缺陷已修复 → Harness 异步触发 GwtRunner（不改阶段；完成后按结果注入/续接）
      // ② PHASE_ADVANCE: delivered（当前 testing）= 要求交付
      //    → 必须已有 verdict=pass 的测试报告，否则拦截（机器裁判收口）
        const isTestingSelfAdvance = project.currentStage === 'testing' && newStage === 'testing'
        const isDeliverFromTesting = project.currentStage === 'testing' && newStage === 'delivered'
        if (isTestingSelfAdvance) {
          console.log(`[南大路由] testing 重入推进：触发 GWT 验收测试（${project.name}）`)
          hooks.triggerGwtRun({
            workspaceSlug,
            projectId: project.projectId,
            projectName: project.name,
            projectMode: project.mode,
            sessionId,
            resume,
          })
          consumedStages.add('testing')
          // 不改 currentStage（保持 testing）；不设 advanced（不触发通用续接，
          // GwtRunner 完成后按裁判结果自行注入/续接）
        } else if (isDeliverFromTesting) {
          const gateError = hooks.checkGwtDeliveryGate(workspaceSlug, project.projectId)
          if (gateError) {
            console.log(`[南大路由] GWT 交付门禁拦截，不推进: ${gateError}`)
            hooks.injectAssistantMessage(sessionId, `⚠️ 交付被拦截：${gateError}`)
          } else {
            // W18 Wave2：交付成功单次写双字段（currentStage=delivered + status=completed
            // 同拍落库）；finishedFirstTime 守门幂等——跨 run 重复 delivered 声明不重复计埋点
            const finishedFirstTime = project.status !== 'completed'
            updateNanjuProject(workspaceSlug, project.projectId, { currentStage: newStage, status: 'completed' })
            console.log(`[南大路由] ✅ 阶段推进: ${project.name} → ${newStage}（status=completed）`)
            advanced = newStage ?? null
            consumedStages.add(newStage)
            // project.finished 埋点（W18 首次启用）：项目交付完成事实（推进即事实口径）
            if (finishedFirstTime) {
              try {
                const { recordTelemetry } = require('./nanju-telemetry') as typeof import('./nanju-telemetry')
                recordTelemetry(workspaceSlug, 'project.finished', {
                  project_id: project.projectId,
                  mode: project.mode,
                }, project.projectId)
              } catch { /* 埋点失败不影响交付 */ }
            }
            // W18：ack 终态清理（防下个项目误读；ack 按 projectId 存于 project-info，随项目清理）
            try {
              const { clearProjectDeliveryAck } = require('./nanju-project') as typeof import('./nanju-project')
              clearProjectDeliveryAck(workspaceSlug, project.projectId)
            } catch { /* 清理失败不影响交付（ack 随项目删除兑底） */ }
            // W10：推进成功——消费清除确认待推进（幂等，工单 §2.1 消费侧）
            try {
              const { clearProjectConfirmPending } = require('./nanju-project') as typeof import('./nanju-project')
              clearProjectConfirmPending(workspaceSlug, project.projectId)
            } catch { /* 清除失败不影响推进（残留提示无害，下次推进再清） */ }
            hooks.finalizePhaseTodos(sessionId)
            // W2 S1 推进点 A：交付清空子步骤（delivered 无子步骤态）并广播。
            // write-then-emit；失败不阻断交付（渲染端 10s 轮询兑底）。
            try {
              const { setProjectSubStage } = require('./nanju-project') as typeof import('./nanju-project')
              const { emitGuideProgress } = require('./nanju-guide-progress') as typeof import('./nanju-guide-progress')
              setProjectSubStage(workspaceSlug, project.projectId, '')
              emitGuideProgress(sessionId, project.projectId, newStage ?? 'delivered', '')
            } catch { /* 向导图子步骤广播失败不影响交付 */ }
          }
        } else {
          // W11（v0.17.73）：推进目标校验——通用分支消费标记前校验标记目标
          // 必须 === getNextPhase(mode, currentStage)（与 route.next 同源），
          // 不接受跳级/跨级/回退。终测 E2E 实锤：L1 在 prototype 阶段输出
          // `PHASE_ADVANCE: coding` 跳过 architecture（jsonl 行 81），检测块
          // 此前按标记目标推进、无校验（继 W8 拦委派角色/W10 提示推进纪律
          // 之后的第三个强制力缺口）。插入点在 else 通用分支开头：
          // isTestingSelfAdvance / isDeliverFromTesting 两特殊分支已在上方
          // 分流（testing 重入/交付不受本校验影响——纯函数同口径豁免）；
          // 拒绝时本分支全部推进钩子（熔断复位/埋点/模板落位/
          // updateNanjuProject/confirmPending 清除/Todo 兑底/子步骤广播）
          // 都不执行，注入教育消息后本轮照常 completeRun、不设
          // advanced（不触发自动续接），待修正标记后重新声明。
          // try-catch 兜底取舍：校验自身异常（route 数据损坏等）不阻断既有
          // 推进路径——宁可放行不可卡死（与 verifyPhaseOutput 的拦截语义
          // 不同：文件验证失败拦推进，校验代码自身出 bug 不能把流程卡死）；
          // 异常 mode / route 缺失的防御性放行在纯函数内处理（见
          // validateAdvanceTarget）。
          let advanceTargetOk = true
          try {
            const { validateAdvanceTarget } = require('./nanju-router-gate') as typeof import('./nanju-router-gate')
            const advanceVerdict = validateAdvanceTarget(project.mode, project.currentStage, newStage ?? '')
            if (!advanceVerdict.ok) {
              advanceTargetOk = false
              console.log(`[南大路由] 推进目标校验拒绝: ${project.currentStage} → ${newStage}（合法目标 ${advanceVerdict.expected ?? '无（终态）'}）`)
              if (advanceVerdict.expected) {
                hooks.injectAssistantMessage(
                  sessionId,
                  `⚠️ 推进标记目标错误：当前 ${project.currentStage} 的下一阶段是 ${advanceVerdict.expected}，`
                  + `不接受跳级/跨级（标记目标 ${newStage} 被忽略）。请输出 <!-- PHASE_ADVANCE: ${advanceVerdict.expected} -->。`,
                )
              } else {
                // 终态兜底（currentStage=delivered，next=null）：无正确标记可引导
                hooks.injectAssistantMessage(
                  sessionId,
                  `⚠️ 推进标记目标错误：当前 ${project.currentStage} 已是终态，无合法下一阶段（标记目标 ${newStage} 被忽略）。`,
                )
              }
            }
          } catch (e) {
            console.warn('[南大路由] 推进目标校验异常（放行，不阻断推进）:', e instanceof Error ? e.message : String(e))
          }
          if (advanceTargetOk) {
            // ── v2.4（D7 §2）：推进硬门（承重）──
            // PHASE_ADVANCE:<target> 消费前授权校验（特判分支 isTestingSelfAdvance /
            // isDeliverFromTesting 在上方分流，原样保留不走本门）：
            //   合法 ⇔ confirmAuthorization（source∈{ask-answer,user-message} ∧
            //          expectedTarget===target，TTL 10min，消费即清）
            //          ∨ systemAdvanceAuthorized.target===target（I2，消费即清）。
            // 不满足 → 拒 + 教育（发起确认问句或等待系统指令），不推进。授权状态读取
            // 异常时按无授权处理（fail-closed：拒绝代价=用户重新确认，远小于未授权推进）。
            {
              let advanceAuthorized = false
              let authSource = ''
              try {
                const {
                  getConfirmAuthorization, consumeConfirmAuthorization,
                  getSystemAdvanceAuthorized, consumeSystemAdvanceAuthorized,
                } = require('./nanju-project') as typeof import('./nanju-project')
                const confirmAuth = getConfirmAuthorization(workspaceSlug, project.projectId)
                if (confirmAuth && (confirmAuth.source === 'ask-answer' || confirmAuth.source === 'user-message')
                  && confirmAuth.expectedTarget === newStage) {
                  advanceAuthorized = true
                  authSource = `confirm:${confirmAuth.source}`
                  consumeConfirmAuthorization(workspaceSlug, project.projectId)
                } else {
                  const sysAuth = getSystemAdvanceAuthorized(workspaceSlug, project.projectId)
                  if (sysAuth && sysAuth.target === newStage) {
                    advanceAuthorized = true
                    authSource = 'system'
                    consumeSystemAdvanceAuthorized(workspaceSlug, project.projectId)
                  }
                }
              } catch (authReadErr) {
                console.warn('[南大路由] 推进授权读取异常（按无授权拒绝）:', authReadErr instanceof Error ? (authReadErr as Error).message : String(authReadErr))
              }
              if (!advanceAuthorized) {
                console.log(`[南大路由] 推进硬门拒绝：无授权（${project.currentStage} → ${newStage}，${project.name}）`)
                try {
                  const { recordTelemetry } = require('./nanju-telemetry') as typeof import('./nanju-telemetry')
                  recordTelemetry(workspaceSlug, 'advance.gate-deny', {
                    project_id: project.projectId,
                    from_stage: project.currentStage,
                    target: newStage,
                    mode: project.mode,
                  }, project.projectId)
                } catch { /* 埋点失败不影响拒绝 */ }
                hooks.injectAssistantMessage(
                  sessionId,
                  '⚠️ 推进未被授权：阶段推进需要真人确认（或系统指令）才能生效。\n\n'
                  + '请先用 AskUserQuestion（header 以「确认」开头）向用户发起本阶段收口确认，'
                  + '待用户横幅答复确认（或聊天框回复确认词）后，再重新声明推进；系统自动续接场景由系统指令驱动，无需自行声明。\n'
                  + '在未获得授权前，不要重复输出推进标记——重复声明同样会被拒绝。',
                )
                continue
              }
              console.log(`[南大路由] 推进硬门通过：${authSource}（${project.currentStage} → ${newStage}）`)
            }
            // W7（v0.17.69 + AC 审计 M3/M4）：architecture 产出验证前置位——解析
            // architecture.md 的 projectEnv 标记行写 envReady（write-then-gate：先置位
            // 再跑含 envReady 门禁的 verifyPhaseOutput，避免首推进被自己未置位的门禁
            // 误拦）。解析+置位逻辑已抽 syncProjectEnvStateFromArchitectureDoc 共用
            //（M3 正则放宽 + 幂等 + 无标记行 warn），与 syncNanjuGuideConfirmState
            // result 侧复用同一实现，防两处解析口径漂移。
            if (project.currentStage === 'architecture') {
              try {
                const { syncProjectEnvStateFromArchitectureDoc } =
                  require('./nanju-engineering-template') as typeof import('./nanju-engineering-template')
                syncProjectEnvStateFromArchitectureDoc(workspaceSlug, project.projectId, sessionId)
              } catch (e) {
                console.warn('[南大路由] 环境状态置位失败（不阻断验证）:', e instanceof Error ? e.message : String(e))
              }
            }
            const verifyError = verifyPhaseOutput(workspaceSlug, project.projectId, project.currentStage)
            if (verifyError) {
              console.log(`[南大路由] 文件验证失败，不推进: ${verifyError}`)
              // 可见化（AC L-002）：校验失败时 PHASE_ADVANCE 不推进，除主进程日志外
              // 向会话注入 assistant 消息，让用户/调度员在 UI 直接看到拦截原因；
              // 不自动续接，待修复后重新声明推进（本轮照常 completeRun）。
              hooks.emitAssistantMessage(sessionId, `⚠️ 阶段推进被拦截：${verifyError}\n产出未达交付标准，请继续修复后重新声明推进。`)
            } else {
              // coding.executed 埋点（P1 Sprint A）：coding 阶段推进成功 = 用户已确认的可运行应用交付事实
              // （推进即事实；不用 verifyPhaseOutput 通过后记，避免把重试中的半成品计入）
              if (project.currentStage === 'coding') {
                try {
                  const { recordTelemetry } = require('./nanju-telemetry') as typeof import('./nanju-telemetry')
                  recordTelemetry(workspaceSlug, 'coding.executed', {
                    project_id: project.projectId, mode: project.mode,
                    entry: '08_APP/index.html',
                  }, project.projectId)
                } catch { /* 埋点失败不影响推进 */ }
              }
              // arch.executed 埋点（W7，v0.17.69）：architecture 阶段推进成功 = 架构师
              // 环节（含环境探测）首次两模式可观测的交付事实（推进即事实口径，同 coding.executed）
              if (project.currentStage === 'architecture') {
                try {
                  const { recordTelemetry } = require('./nanju-telemetry') as typeof import('./nanju-telemetry')
                  const { getPhaseNode } = require('./nanju-router') as typeof import('./nanju-router')
                  recordTelemetry(workspaceSlug, 'arch.executed', {
                    project_id: project.projectId, mode: project.mode,
                    requires_ac: getPhaseNode(project.mode, 'architecture')?.requiresAC ?? false,
                  }, project.projectId)
                } catch { /* 埋点失败不影响推进 */ }
              }
                  // 阶段熔断复位 + phase.elapsed 埋点 + US-xx 上游提示（v0.17.64 Sprint C1）。
                  // 推进 = 离开阶段已收口（用户确认/修复完成）：清零该阶段 guard（用户驱动的复位路径）；
                  // 阶段时长以 project.updatedAt（上次写 currentStage 的时间）近似，够漏斗分析用。
                  try {
                    const { updatePhaseGuard } = require('./nanju-project') as typeof import('./nanju-project')
                    updatePhaseGuard(workspaceSlug, project.projectId, project.currentStage as NanjuGuardStage, {
                      kind: 'reset',
                      note: '阶段推进收口',
                    })
                    const stageDurationMs = Date.now() - Date.parse(project.updatedAt)
                    if (Number.isFinite(stageDurationMs) && stageDurationMs >= 0) {
                      const { recordTelemetry } = require('./nanju-telemetry') as typeof import('./nanju-telemetry')
                      recordTelemetry(workspaceSlug, 'phase.elapsed', {
                        project_id: project.projectId,
                        from_stage: project.currentStage,
                        to_stage: newStage,
                        duration_ms: stageDurationMs,
                      }, project.projectId)
                    }
                  } catch { /* 复位/埋点失败不影响推进 */ }
                  // US-xx 上游检查强化（#5 升级，提示不阻断）：requirements 收口时 PRD 仍无
                  // US-xx 编号清单 → 注入提醒（测试阶段 parseUserStories 判定将无法进行）
                  if (project.currentStage === 'requirements') {
                    try {
                      const { existsSync: prdExists, readFileSync: prdRead } = require('node:fs')
                      const { join: prdJoin } = require('node:path')
                      const { getNanjuProjectDir } = require('./nanju-project') as typeof import('./nanju-project')
                      const { parseUserStories } = require('./nanju-gwt-runner') as typeof import('./nanju-gwt-runner')
                      const prdPath = prdJoin(getNanjuProjectDir(workspaceSlug, project.projectId), '01_PRD', 'prd.md')
                      if (prdExists(prdPath) && parseUserStories(prdRead(prdPath, 'utf-8')).length === 0) {
                        hooks.injectAssistantMessage(
                          sessionId,
                          '⚠️ 上游检查提示：PRD 未提取到「US-xx」编号用户故事清单，后续测试阶段的覆盖性判定将无法进行'
                          + '（测试阶段会 fail-fast 要求补 PRD）。建议补充用户故事编号清单后再继续；本次不阻断推进，可按需继续。',
                        )
                      }
                    } catch { /* 检查失败不阻断推进 */ }
                  }
                  // 工程模板前移落位（W7 R3 前移契约，v0.17.69）：即将进入 architecture
                  // ——按 PRD 初判/默认品类 materialize 模板到 00_ENGINEERING_TEMPLATE/
                  //（头部标注「初判参考」），【不写 projectCategory】：品类写入与权威
                  // 重落位只在 coding 推进钩子（防 existing?? 幂等污染终判）。
                  if (newStage === 'architecture') {
                    try {
                      const {
                        resolveProjectCategoryForCoding,
                        materializeEngineeringTemplate,
                      } = require('./nanju-engineering-template') as typeof import('./nanju-engineering-template')
                      const initial = resolveProjectCategoryForCoding(workspaceSlug, project.projectId)
                        ?? { category: 'web-fullstack' as const, source: 'default' as const }
                      const templatePath = materializeEngineeringTemplate(
                        workspaceSlug, project.projectId, initial.category,
                        undefined, { annotateInitialGuess: true },
                      )
                      console.log(`[南大路由] 工程模板前移落位: ${project.name} → ${initial.category}（${initial.source}，初判参考）${templatePath ? '' : '（模板缺失，架构师按品类自行降级）'}`)
                    } catch (e) {
                      console.warn('[南大路由] 工程模板前移落位异常（不阻断推进）:', e instanceof Error ? e.message : String(e))
                    }
                  }
                  // 工程品类判定与模板落位（W3，v0.17.66）：即将进入 coding——从
                  // architecture/prd 提取 projectCategory 写入 _project-info.json，并把
                  // 对应品类工程模板复制到 00_ENGINEERING_TEMPLATE/（coding 委派任务
                  // 注入精简要点 + 全文路径引用）。失败不阻断推进（coding 侧另有
                  // 现场降级兑底，见 getNanjuRouterPrompt）。
                  if (newStage === 'coding') {
                    try {
                      const {
                        resolveProjectCategoryForCoding,
                        materializeEngineeringTemplate,
                      } = require('./nanju-engineering-template') as typeof import('./nanju-engineering-template')
                      const { setProjectCategory, getProjectCategory } = require('./nanju-project') as typeof import('./nanju-project')
                      const existing = getProjectCategory(workspaceSlug, project.projectId)
                      const resolved = existing ?? resolveProjectCategoryForCoding(workspaceSlug, project.projectId)
                        ?? { category: 'web-fullstack' as const, source: 'default' as const }
                      setProjectCategory(workspaceSlug, project.projectId, resolved.category, resolved.source)
                      const templatePath = materializeEngineeringTemplate(workspaceSlug, project.projectId, resolved.category)
                      console.log(`[南大路由] 工程品类判定: ${project.name} → ${resolved.category}（${resolved.source}）${templatePath ? '' : '，模板落位失败（coding 侧降级仅要点）'}`)
                    } catch (e) {
                      console.warn('[南大路由] 工程品类判定异常（不阻断推进）:', e instanceof Error ? e.message : String(e))
                    }
                  }
                  updateNanjuProject(workspaceSlug, project.projectId, { currentStage: newStage })
                  console.log(`[南大路由] ✅ 阶段推进: ${project.name} → ${newStage}`)
                  advanced = newStage ?? null
                  consumedStages.add(newStage)
                  // W10：推进成功——消费清除确认待推进（幂等，工单 §2.1 消费侧）
                  try {
                    const { clearProjectConfirmPending } = require('./nanju-project') as typeof import('./nanju-project')
                    clearProjectConfirmPending(workspaceSlug, project.projectId)
                  } catch { /* 清除失败不影响推进（残留提示无害，下次推进再清） */ }
                  // Todo 纪律兜底（P3/L4）：调度员经常忘记在阶段推进时收尾 Todo，
                  // 程序化把该会话关联的 open Todo 标记完成（nativeOrigin 外部来源不动，
                  // 避免同步到系统提醒事项的副作用；只处理本会话通过 TaskCreate 建的）。
                  hooks.finalizePhaseTodos(sessionId)
                  // W2 S1 推进点 B：新阶段子步骤 = 主节点（作者产出中）并广播；推进到
                  // 无主节点阶段（delivered，防御兑底——实际 delivered 推进走 A 点/GWT-pass
                  // 路径，A7 笔误修正：quick 路由 prototype.next=coding 无直连交付边）→ 清空
                  // 子步骤。失败不阻断推进。
                  try {
                    const { setProjectSubStage } = require('./nanju-project') as typeof import('./nanju-project')
                    const { getGuideStageMainNodeId, emitGuideProgress } = require('./nanju-guide-progress') as typeof import('./nanju-guide-progress')
                    const subStage = (newStage ? getGuideStageMainNodeId(newStage) : undefined) ?? ''
                    setProjectSubStage(workspaceSlug, project.projectId, subStage)
                    emitGuideProgress(sessionId, project.projectId, newStage ?? 'delivered', subStage)
                  } catch { /* 向导图子步骤广播失败不影响推进 */ }
            }
          }
        }
    }
  }
  return advanced
}

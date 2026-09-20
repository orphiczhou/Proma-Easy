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
  /** W22（F5）：systemInitiated 续接（拒收教育闭环驱动 L1 下一轮——注入≠续接，见 w22-review §5）；
   *  实现走 runNanjuGuardContinuation（含 isActive 重试）；onGiveUp = 续接放弃降级回调 */
  sendContinuation: (
    sessionId: string,
    message: string,
    opts?: { onGiveUp?: (sessionId: string, message: string) => void },
  ) => void
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
  /**
   * W-I B-c：阶段推进成功后的工程检查点（会话快照 + 工程文件快照）。
   *
   * 为什么是注入项而不是消费器内直调：本模块保持无 fs/无快照依赖（纯消费器），
   * 三段式（createSnapshot → captureFileSnapshot → linkFileSnapshot）由接线层（orchestrator）完成。
   * **缺省不创建**（测试/未接线环境零行为变化）；实现必须自行吞错，不得影响推进。
   */
  captureCheckpoint?: (input: {
    workspaceSlug: string
    projectId: string
    sessionId: string
    /** `pre-modify` = 进入 coding 之前（即将开始改工程）；`confirm` = 其余阶段确认/交付 */
    triggerType: 'init' | 'pre-modify' | 'confirm'
    description: string
  }) => void
}

// ═══ W22（G 域）：F5 拒收教育闭环 + R1 回炉文案（内部段/纯函数） ═══

/** F5 防环上限：同项目拒收教育闭环（注入+续接）最多 2 次，第 3 次起转人工提示
 *  （对齐 GWT 熔断「1 首产 + 2 回炉」口径；阶段推进成功时清零重新计数） */
const ADVANCE_REJECT_EDUCATION_LIMIT = 2

/**
 * W22（F5）：advance 拒收教育闭环——注入可见教育消息 + systemInitiated 续接驱动 L1
 * 下一轮 + 防环（超上限转人工，不再注入/续接）+ 续接失败降级（可见注入+遥测+拒因
 * 登记，保证不静默）。
 *
 * 证伪注记（w22-review §5 P0-8）：两条拒收路径此前均已有 injectAssistantMessage 教育注入，
 * D8-1/D8-2 的真实缺口是「注入≠续接」——emit 一条 assistant 消息不驱动 L1 新一轮运行，
 * 本函数把拒收从「静默等待」补齐为「可见 + 驱动 + 防环 + 降级」四要素闭环。
 *
 * @param kind 拒收门类（target-deny = W11 目标校验；gate-deny = 硬门无授权）——供拒因登记/遥测归因
 * @param correction 拒因登记载荷（被拒目标 + 合法下一阶段；终态时 expected 传空串）
 * @returns 递增后的拒收计数（计数器异常时返回 0，教育照常注入）
 */
function rejectWithEducationLoop(
  workspaceSlug: string,
  projectId: string,
  sessionId: string,
  kind: 'target-deny' | 'gate-deny',
  message: string,
  correction: { target: string; expected: string },
  hooks: PhaseAdvanceHooks,
): number {
  const count = (() => {
    try {
      const { bumpAdvanceRejectCount } = require('./nanju-project') as typeof import('./nanju-project')
      return bumpAdvanceRejectCount(workspaceSlug, projectId)
    } catch {
      return 0
    }
  })()
  // F5 ③ 防环：教育闭环已达上限 → 转人工提示（不再注入教育/续接——防拒收→注入→续接→再拒收死循环烧 token）
  if (count > ADVANCE_REJECT_EDUCATION_LIMIT) {
    try {
      const { setProjectPendingAdvanceCorrection } = require('./nanju-project') as typeof import('./nanju-project')
      setProjectPendingAdvanceCorrection(workspaceSlug, projectId, {
        kind,
        target: correction.target,
        expected: correction.expected,
        at: new Date().toISOString(),
        count,
      })
    } catch { /* pending 记录失败不阻断可见人工提示 */ }
    hooks.injectAssistantMessage(
      sessionId,
      '⛔ 推进标记已连续 ' + count + ' 次被拒（自动纠偏闭环已达上限，系统停止继续注入纠偏指令）。'
      + '\n\n请人工介入：查看上述拒收原因（目标合法性/授权/产出校验），与用户确认处理方式后，'
      + '由用户/调度员按指引重新声明合法推进，或调整项目状态。',
    )
    try {
      const { recordTelemetry } = require('./nanju-telemetry') as typeof import('./nanju-telemetry')
      recordTelemetry(workspaceSlug, 'advance.reject-escalate', {
        project_id: projectId,
        kind: 'loop-limit',
        reject_kind: kind,
        count,
        target: correction.target,
        expected: correction.expected,
      }, projectId)
    } catch { /* 埋点失败不影响 */ }
    return count
  }
  hooks.injectAssistantMessage(sessionId, message)
  // F5 ①：systemInitiated 续接驱动 L1 下一轮（拒收后本轮照常 completeRun，无续接则 L1 看不到拒收）
  hooks.sendContinuation(sessionId, message, {
    onGiveUp: () => {
      // F5 ④：续接失败降级——可见注入 + 遥测 + 拒因登记（不静默；下一轮 prompt 消费侧接线后可提示 L1）
      hooks.injectAssistantMessage(
        sessionId,
        '⚠️ 纠偏续接未送达（会话持续忙碌/元数据缺失）：本次推进标记被拒'
        + (correction.expected !== '' ? '（合法目标为 ' + correction.expected + '）' : '（当前已无合法下一阶段）')
        + '，已登记待纠正拒因，待会话空闲后按上述指引处理。',
      )
      try {
        const { recordTelemetry } = require('./nanju-telemetry') as typeof import('./nanju-telemetry')
        recordTelemetry(workspaceSlug, 'advance.reject-escalate', {
          project_id: projectId,
          kind: 'continuation-giveup',
          reject_kind: kind,
          count,
          target: correction.target,
          expected: correction.expected,
        }, projectId)
      } catch { /* 域点失败不影响 */ }
      try {
        const { setProjectPendingAdvanceCorrection } = require('./nanju-project') as typeof import('./nanju-project')
        setProjectPendingAdvanceCorrection(workspaceSlug, projectId, {
          kind,
          target: correction.target,
          expected: correction.expected,
          at: new Date().toISOString(),
          count,
        })
      } catch { /* 登记失败不影响（遥测已有同拍事件） */ }
    },
  })
  return count
}

/**
 * W22（R1 前半）：GWT behavior-fail 回炉指令（可见注入版）——携带 codingDelegationId 时
 * 指引 continue_delegation 原全栈开发委派修复（保留完整上下文，不新建修复会话）；
 * ID 不可用时降级为「新建但沿用 coding 配置渠道（GLM）」。
 * （mapping/coverage 类回炉仍指 testing 作者重写，不经本函数——见 orchestrator 分流分支。）
 */
export function buildGwtBehaviorFailReworkDirective(
  failListText: string,
  codingDelegationId: string | null,
): string {
  const header = '失败清单：\n' + failListText
  if (codingDelegationId) {
    return header
      + '\n\n请用 continue_delegation(' + codingDelegationId + ') 把失败清单转交原「全栈开发」委派修复'
      + '（保留完整上下文，不要新建修复会话）——仅改 08_APP/ 下代码，不得改 06_TESTS/ 与 01_PRD/，'
      + '修复完成后重新声明推进 <!-- PHASE_ADVANCE: testing --> 重跑测试。'
  }
  return header
    + '\n\n请委派「全栈开发」修复以上缺陷（原 coding 委派 ID 不可用，新建时必须沿用 coding 阶段配置渠道'
    + '（GLM）并向其转交完整失败清单）——仅改 08_APP/ 下代码，不得改 06_TESTS/ 与 01_PRD/，'
    + '修复完成后重新声明推进 <!-- PHASE_ADVANCE: testing --> 重跑测试。'
}

/**
 * W22（R1 前半）：GWT behavior-fail 回炉续接指令（systemInitiated 版，与可见注入版同源双口径）。
 */
export function buildGwtBehaviorFailReworkResumeMessage(
  codingDelegationId: string | null,
): string {
  if (codingDelegationId) {
    return '验收测试未全部通过（行为类：应用缺陷）。请按系统注入的失败清单处理：'
      + '用 continue_delegation(' + codingDelegationId + ') 把失败清单转交原全栈开发修复'
      + '（保留完整上下文，不要新建修复会话；仅改 08_APP/），修复完成后重新声明推进 <!-- PHASE_ADVANCE: testing -->。'
  }
  return '验收测试未全部通过（行为类：应用缺陷）。请按系统注入的失败清单处理：'
    + '委派全栈开发修复缺陷（新建时沿用 coding 阶段配置渠道 GLM；仅改 08_APP/），'
    + '修复完成后重新声明推进 <!-- PHASE_ADVANCE: testing -->。'
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
export interface CheckConfirmAdvanceOptions {
  humanOrigin?: boolean
  /** P0-3：确认词命中但未构成授权时，向 UI 注入三态拒因提示（复用 notice/助手消息
   * 通道；调用方 orchestrator 接 injectNanjuAssistantMessage）。G3b 实测 7 次文字确认
   * 无效且仅落日志（×9），授权阻塞态必须显式化。 */
  notifyDenial?: (text: string) => void
}

/** P0-3：构建授权阻塞态三态拒因提示文本（数据源=平台既有授权判定路径：活跃收口问句
 * 登记+10min TTL+目标匹配；期望/实际即问句期望推进目标 vs 当前合法下一阶段）。 */
function buildConfirmDenialNotice(opts: {
  workspaceSlug: string
  projectId: string
  currentStage: string
  kind: 'no-active-ask' | 'ask-not-matching' | 'scatter-no-auth'
  expectedFromAsk?: string
  harnessExpected?: string | null
}): string {
  try {
    const { getConfirmAskDiagnostics } = require('./nanju-project') as typeof import('./nanju-project')
    const diag = getConfirmAskDiagnostics(opts.workspaceSlug, opts.projectId, opts.currentStage)
    const last = diag.lastRegistration
    const lastText = last
      ? `上次登记：${last.stage} 阶段 → 目标 ${last.expectedTarget}（${new Date(last.ts).toLocaleString('zh-CN')}，${last.by}）`
      : '本项目（本次进程内）从未登记过收口确认问句'
    const lines: string[] = ['🔒 推进授权未生效（当前确认不构成推进授权）']
    if (opts.kind === 'ask-not-matching' && opts.expectedFromAsk) {
      // 态③：问句在场但目标不匹配（附期望/实际）
      lines.push(`原因：活跃收口问句的期望推进目标与当前阶段不一致（期望 → ${opts.expectedFromAsk}，实际合法下一阶段 → ${opts.harnessExpected ?? '未知'}）。请等当前阶段的收口确认问句弹出后再应答。`)
    } else if (diag.active) {
      // 态②：已登记未确认（附剩余时间）。注（AC 审计 Y-06）：当前三个调用点的
      // kind 推导下本分支为防御性代码（no-active-ask/scatter 时 active 必空、
      // ask-not-matching 时走态③）——态②的常态呈现路径在 GWT 交付拦截的授权状态
      // 附注（下方 isDeliverFromTesting gateError 分支的 authStateNote）。
      const remainMin = Math.ceil(diag.active.remainingMs / 60000)
      lines.push(`原因：收口确认问句已登记但尚未收到有效应答（目标 → ${diag.active.expectedTarget}，剩余有效期约 ${remainMin} 分钟）。请在向导会话弹出「确认·阶段收口」横幅时点确认，或直接回复确认词。`)
    } else if (diag.lastRegistration) {
      // 态②另一形态：曾有登记但已消费或超过 10 分钟 TTL 过期
      lines.push(`原因：收口确认问句不在有效期（已应答消费或超过 10 分钟 TTL）。${lastText}。需要重新触发一次收口确认问句（推进到本阶段产出确认环节时自动弹出）后再确认。`)
    } else {
      // 态①：无活跃收口问句（附本阶段登记数+上次登记信息）
      lines.push(`原因：当前无活跃的收口确认问句（本阶段「${opts.currentStage}」登记 0 次；${lastText}）。散点确认词不构成推进授权——请等待向导流程在阶段产出达标后弹出「确认·阶段收口」问句，或让向导 Agent 重新发起收口确认。`)
    }
    lines.push(`登记数据：本阶段登记 ${diag.stageRegisteredCount} 次。授权链口径=阶段收口类问句登记（10 分钟 TTL）+ 确认词应答；中间类确认（如环境安装）不登记、不授权。`)
    return lines.join('\n')
  } catch {
    return '🔒 推进授权未生效：当前无活跃的收口确认问句，本次确认不构成推进授权（详见向导日志）。'
  }
}

export function checkConfirmAdvanceInput(
  sessionId: string,
  workspaceSlug: string,
  userText: string,
  source: 'message' | 'ask-answer' = 'message',
  opts?: CheckConfirmAdvanceOptions,
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
            // W22（G 域 M-6）：install-only 横幅答案回传豁免——中间类确认不登记
            // activeConfirmAsk，其横幅答案命中确认词时原误记 suspect（no-active-ask）；
            // 豁免路径埋点仍发（观测口径保留）但 payload 标 whitelisted:true +
            // reason=install-whitelisted——事后可区分「真伪造」与「白名单放行」，不授权不变。
            let installWhitelisted = false
            try {
              const { getActiveInstallAsk } = require('./nanju-project') as typeof import('./nanju-project')
              installWhitelisted = !ask && getActiveInstallAsk(workspaceSlug, project.projectId) !== null
            } catch { /* 标记读取失败按未豁免处理（保守） */ }
            try {
              recordTelemetry(workspaceSlug, 'clarify.suspect-fake-confirm', {
                project_id: project.projectId,
                stage: project.currentStage,
                reason: ask ? 'target-mismatch' : (installWhitelisted ? 'install-whitelisted' : 'no-active-ask'),
                ...(installWhitelisted ? { whitelisted: true } : {}),
                textPreview: userText.slice(0, 40),
              }, project.projectId)
            } catch { /* 域点失败不影响 */ }
            console.log(`[南大路由] ask-answer 无匹配活跃收口问句（${ask ? '目标不匹配' : installWhitelisted ? 'install-only 横幅白名单豁免' : '无问句'}），不授权（${project.name}）`)
            // P0-3：拒因提升到 UI（态③目标不匹配/态①无问句；install-only 白名单豁免属
            // 正常路径不注入拒因提示）
            if (!installWhitelisted) {
              opts?.notifyDenial?.(buildConfirmDenialNotice({
                workspaceSlug, projectId: project.projectId, currentStage: String(project.currentStage),
                kind: ask ? 'ask-not-matching' : 'no-active-ask',
                expectedFromAsk: ask?.expectedTarget, harnessExpected,
              }))
            }
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
            // P0-3（ATK-L-002）：原「不提示」改为显式注入——G3b 实测 testing 8 轮从未
            // 登记问句、指挥官 7 次文字确认全部无效；仅落日志的拒因必须提升到 UI。
            opts?.notifyDenial?.(buildConfirmDenialNotice({
              workspaceSlug, projectId: project.projectId, currentStage: String(project.currentStage),
              kind: 'scatter-no-auth',
            }))
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
        const { clearActiveConfirmAsk, clearActiveInstallAsk } = require('./nanju-project') as typeof import('./nanju-project')
        clearActiveConfirmAsk(workspaceSlug, project.projectId)
        // W22（M-6）：install-only 横幅已答，在场标记同步消费（幂等；TTL 兑底）
        if (source === 'ask-answer') clearActiveInstallAsk(workspaceSlug, project.projectId)
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
      // #12 satisfaction.marked（PRD §12.4，I-P8）：与 delivery.ack-recorded 同拍发射。
      // 不做行为推断——verdict 直接来自本次 ack 的确认词；活跃时长 = 从交付问句登记
      // （challenge.askedAt，交付门禁置位时刻）到用户应答（ack.at）的真实间隔，取不到时按 0 记。
      try {
        const { emitQuickEvent, buildSatisfactionPayload } = require('./nanju-quick-events') as typeof import('./nanju-quick-events')
        const challengeAt = typeof challenge.askedAt === 'string' ? Date.parse(challenge.askedAt) : Number.NaN
        const ackAt = Date.parse(at)
        const activeMsSinceStart = Number.isFinite(challengeAt) && Number.isFinite(ackAt) && ackAt >= challengeAt
          ? ackAt - challengeAt
          : 0
        emitQuickEvent(workspaceSlug, project.projectId, 'satisfaction.marked', buildSatisfactionPayload({
          verdict: 'satisfied',
          activeMsSinceStart,
        }) as unknown as Record<string, unknown>)
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

// ═══ D8 A1′（§九终版）：autoConfirmAuthorized 第四形态（纯评估，无副作用） ═══

/** A1′ 阶段白名单（quick 五活跃阶段；planning 等 quick 无此阶段的异常值不通过） */
const AUTO_CONFIRM_STAGE_WHITELIST = ['requirements', 'prototype', 'architecture', 'coding', 'testing'] as const

/** 读取 architecture 轻量 AC 结论（03_ARCHITECTURE/ac-verdict.json）；
 *  缺失/不可解析/非法值一律 'missing'（R7-05：fail-closed 视为 red） */
function readArchitectureAcVerdict(workspaceSlug: string, projectId: string): 'green' | 'yellow' | 'red' | 'missing' {
  try {
    const { existsSync, readFileSync } = require('node:fs')
    const { join } = require('node:path')
    const { getNanjuProjectDir } = require('./nanju-project') as typeof import('./nanju-project')
    const verdictPath = join(getNanjuProjectDir(workspaceSlug, projectId), '03_ARCHITECTURE', 'ac-verdict.json')
    if (!existsSync(verdictPath)) return 'missing'
    const parsed = JSON.parse(readFileSync(verdictPath, 'utf-8')) as { verdict?: unknown }
    const v = parsed?.verdict
    if (v === 'green' || v === 'yellow' || v === 'red') return v
    return 'missing'
  } catch {
    return 'missing'
  }
}

/**
 * D8 A1′（§九终版，五条件严格式）：
 * enabled ∧ quick ∧ currentStage∈五阶段白名单 ∧ getPhaseNode('quick',stage)?.outputPath
 * 存在（R7-06：不复用 verifyPhaseOutput 的 null 双语义）∧ verifyPhaseOutput===null（严格
 * === null）∧（非 architecture ∨ acVerdict≠'red'——缺失/不可解析 fail-closed 视 red）。
 *
 * target 校验不短路（R7-08）：本函数仅判「当前阶段可自动确认」；标记目标仍须先过
 * validateAdvanceTarget（调用顺序保证——授权门位于 W11 校验之后）。
 * @returns ok / reason（ac-red 含缺失形态；供回炉提示与遥测归因）
 */
function evaluateAutoConfirmAuthorized(
  workspaceSlug: string,
  project: { projectId: string; mode: string; currentStage: string; autoClarify?: { enabled?: boolean } },
): { ok: boolean; reason?: string; detail?: string } {
  if (project.autoClarify?.enabled !== true) return { ok: false, reason: 'disabled' }
  if (project.mode !== 'quick') return { ok: false, reason: 'not-quick' }
  const stage = project.currentStage
  if (!(AUTO_CONFIRM_STAGE_WHITELIST as readonly string[]).includes(stage)) {
    return { ok: false, reason: 'stage-not-whitelisted' }
  }
  try {
    const { getPhaseNode } = require('./nanju-router') as typeof import('./nanju-router')
    if (!getPhaseNode('quick', stage as import('./nanju-router').PhaseId)?.outputPath) {
      return { ok: false, reason: 'no-output-path' }
    }
  } catch {
    return { ok: false, reason: 'no-output-path' }
  }
  const verifyError = verifyPhaseOutput(workspaceSlug, project.projectId, stage as import('./nanju-router').PhaseId)
  if (verifyError !== null) {
    return { ok: false, reason: 'verify-failed', detail: verifyError }
  }
  if (stage === 'architecture') {
    const verdict = readArchitectureAcVerdict(workspaceSlug, project.projectId)
    if (verdict === 'red' || verdict === 'missing') {
      return { ok: false, reason: verdict === 'red' ? 'ac-red' : 'ac-red-missing' }
    }
  }
  return { ok: true }
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
            // P0-3：交付拦截时附带授权链状态（testing 阶段无活跃收口问句的常态显式化
            //——G3b 实测 8 轮从未登记问句；用户此时手动确认推进也不会生效，提前告知）
            let authStateNote = ''
            try {
              const { getConfirmAskDiagnostics } = require('./nanju-project') as typeof import('./nanju-project')
              const diag = getConfirmAskDiagnostics(workspaceSlug, project.projectId, 'testing')
              authStateNote = diag.active
                ? `\n📋 授权链状态：收口确认问句在位（目标 → ${diag.active.expectedTarget}，剩余约 ${Math.ceil(diag.active.remainingMs / 60000)} 分钟）。`
                : `\n📋 授权链状态：当前无活跃收口确认问句（testing 阶段登记 ${diag.stageRegisteredCount} 次）——此时聊天框发送确认词不构成推进授权；交付需等待 GWT 验收 verdict=pass 后按向导流程收口。`
            } catch { /* 诊断失败不阻断拦截提示 */ }
            hooks.injectAssistantMessage(sessionId, `⚠️ 交付被拦截：${gateError}${authStateNote}`)
          } else {
            // W18 Wave2：交付成功单次写双字段（currentStage=delivered + status=completed
            // 同拍落库）；finishedFirstTime 守门幂等——跨 run 重复 delivered 声明不重复计埋点
            const finishedFirstTime = project.status !== 'completed'
            updateNanjuProject(workspaceSlug, project.projectId, { currentStage: newStage, status: 'completed' })
            console.log(`[南大路由] ✅ 阶段推进: ${project.name} → ${newStage}（status=completed）`)
            // W22（F5③）：交付推进成功——拒收防环计数清零 + 待纠正拒因登记清除
            try {
              const { resetAdvanceRejectCount, clearProjectPendingAdvanceCorrection } = require('./nanju-project') as typeof import('./nanju-project')
              resetAdvanceRejectCount(workspaceSlug, project.projectId)
              clearProjectPendingAdvanceCorrection(workspaceSlug, project.projectId)
            } catch { /* 清理失败不影响交付 */ }
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
            // D8 A3′：challenge 终态清理同步追加（auto on 自动交付不经 ask-answer 消费
            // challenge——防残留跨交付被后续判定误读；幂等，auto off 路径 ack 消费时已清，此处空操作）
            try {
              const { clearProjectDeliveryChallenge } = require('./nanju-project') as typeof import('./nanju-project')
              clearProjectDeliveryChallenge(workspaceSlug, project.projectId)
            } catch { /* 清理失败不影响交付 */ }
            // W10：推进成功——消费清除确认待推进（幂等，工单 §2.1 消费侧）
            try {
              const { clearProjectConfirmPending } = require('./nanju-project') as typeof import('./nanju-project')
              clearProjectConfirmPending(workspaceSlug, project.projectId)
            } catch { /* 清除失败不影响推进（残留提示无害，下次推进再清） */ }
            hooks.finalizePhaseTodos(sessionId)
            // W-I B-c：交付确认检查点（会话快照 + 工程文件快照）；实现自行吞错，不影响交付
            hooks.captureCheckpoint?.({
              workspaceSlug,
              projectId: project.projectId,
              sessionId,
              triggerType: 'confirm',
              description: `交付确认：${project.name} → ${newStage ?? 'delivered'}`,
            })
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
              // W22（G 域 F5/D8-1）：W11 拒绝遥测补齐（D8-1 实测缺——原仅 console + 注入无埋点）
              try {
                const { recordTelemetry } = require('./nanju-telemetry') as typeof import('./nanju-telemetry')
                recordTelemetry(workspaceSlug, 'advance.target-deny', {
                  project_id: project.projectId,
                  from_stage: project.currentStage,
                  target: newStage,
                  expected: advanceVerdict.expected ?? '',
                  mode: project.mode,
                }, project.projectId)
              } catch { /* 埋点失败不影响拒绝 */ }
              if (advanceVerdict.expected) {
                // W22（F5①）：双形态处置指引——auto 版直接输出合法目标标记/调代理；
                // off 版先发起确认问句（header 以「确认」开头）再声明推进
                const isAutoTargetProject = project.autoClarify?.enabled === true && project.mode === 'quick'
                const disposition = isAutoTargetProject
                  ? `请直接输出 <!-- PHASE_ADVANCE: ${advanceVerdict.expected} --> 推进标记（产出达标后系统自动确认）；信息不足时先调 nanju_clarify_proxy 补完后再重新声明。`
                  : `请先用 AskUserQuestion 向用户发起本阶段收口确认（header 以「确认」开头，如「确认·阶段名」），获得用户确认后直接输出 <!-- PHASE_ADVANCE: ${advanceVerdict.expected} --> 推进标记。`
                rejectWithEducationLoop(
                  workspaceSlug, project.projectId, sessionId, 'target-deny',
                  `⚠️ 推进标记目标错误：当前 ${project.currentStage} 的下一阶段是 ${advanceVerdict.expected}，`
                  + `不接受跳级/跨级（标记目标 ${newStage} 被忽略）。${disposition}`,
                  { target: newStage ?? '', expected: advanceVerdict.expected },
                  hooks,
                )
              } else {
                // 终态兜底（currentStage=delivered，next=null）：无正确标记可引导——仅注入+计数，不续接
                try {
                  const { bumpAdvanceRejectCount } = require('./nanju-project') as typeof import('./nanju-project')
                  bumpAdvanceRejectCount(workspaceSlug, project.projectId)
                } catch { /* 计数失败不影响 */ }
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
            // ── v2.4（D7 §2）+ D8 A1′：推进硬门（承重，四形态）──
            // PHASE_ADVANCE:<target> 消费前授权校验（特判分支 isTestingSelfAdvance /
            // isDeliverFromTesting 在上方分流，原样保留不走本门）：
            //   合法 ⇔ confirmAuthorization（source∈{ask-answer,user-message} ∧
            //          expectedTarget===target，TTL 10min，消费即清）
            //          ∨ systemAdvanceAuthorized.target===target（I2，消费即清）
            //          ∨ autoConfirmAuthorized（D8 A1′ §九五条件严格式——机器事实，
            //            L1 无伪造面；target 校验不短路：本门位于 W11 之后）。
            // 不满足 → 拒 + 教育（auto 项目专用文案/AC red 回炉指令），不推进。授权状态
            // 读取异常时按无授权处理（fail-closed：拒绝代价=用户重新确认，远小于未授权推进）。
            {
              let advanceAuthorized = false
              let authSource = ''
              let autoConfirmPassed = false
              let autoBlockReason = ''
              let autoBlockDetail = ''
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
                // D8 A1′：第四形态（机器事实五联——enabled/quick/白名单/outputPath/
                // verify 严格 null + architecture AC≠red fail-closed）
                const autoVerdict = evaluateAutoConfirmAuthorized(workspaceSlug, project)
                if (autoVerdict.ok) {
                  advanceAuthorized = true
                  authSource = 'auto-confirm'
                  autoConfirmPassed = true
                } else {
                  autoBlockReason = autoVerdict.reason ?? ''
                  autoBlockDetail = autoVerdict.detail ?? ''
                }
              }
              if (!advanceAuthorized) {
                const isAutoProject = project.autoClarify?.enabled === true && project.mode === 'quick'
                console.log(`[南大路由] 推进硬门拒绝：无授权（${project.currentStage} → ${newStage}，${project.name}${isAutoProject ? `，auto 拒因=${autoBlockReason}` : ''}）`)
                try {
                  const { recordTelemetry } = require('./nanju-telemetry') as typeof import('./nanju-telemetry')
                  // D8：auto 项目埋 advance.auto-gate（R7-14 union 由 B 域收口），非 auto 维持 gate-deny
                  recordTelemetry(workspaceSlug, (isAutoProject ? 'advance.auto-gate' : 'advance.gate-deny') as Parameters<typeof recordTelemetry>[1], {
                    project_id: project.projectId,
                    from_stage: project.currentStage,
                    target: newStage,
                    mode: project.mode,
                    ...(isAutoProject ? { auto_block_reason: autoBlockReason, auto_block_detail: autoBlockDetail || undefined } : {}),
                  }, project.projectId)
                } catch { /* 埋点失败不影响拒绝 */ }
                // W22（F5①/②）：三档文案构建后统一走 rejectWithEducationLoop——注入 +
                // systemInitiated 续接 + 防环 + 降级四要素闭环（auto 版含直接输出合法目标
                // 标记/调代理指引；off 版含确认问句指引）
                let hardGateMessage = ''
                if (isAutoProject && (autoBlockReason === 'ac-red' || autoBlockReason === 'ac-red-missing')) {
                  // §九 A1′：architecture AC red/未审查 → 不自动确认 + 回炉提示（可见指令）
                  hardGateMessage =
                    '⚠️ 架构自动确认被拦截：轻量 AC 对抗审计未通过'
                    + (autoBlockReason === 'ac-red-missing'
                      ? '（03_ARCHITECTURE/ac-verdict.json 缺失或不可解析——未审查视为不通过）'
                      : '（审计结论为 red）')
                    + '。\n\n'
                    + '请 continue_delegation 委派「架构师」按审计 findings 修复架构文档'
                    + '（品类终判 / 技术选型理由 / 环境清单一致性），修复后重新执行单攻击者 1 轮对抗审查（不循环），'
                    + '并将结论写入 03_ARCHITECTURE/ac-verdict.json'
                    + '（格式 {verdict:"green"|"yellow"|"red", findings:[{severity,evidence}], attackerModel, ts}），'
                    + '然后再重新声明推进。环境安装确认仍需用户横幅应答（唯一例外）。'
                } else if (isAutoProject) {
                  hardGateMessage =
                    '⚠️ 推进未被授权：本项目已开启自动审核，推进条件 = 当前阶段产出校验通过'
                    + '（architecture 阶段另需 AC 审计非 red）+ 标记目标为唯一合法下一阶段。\n\n'
                    + '请先 continue_delegation 委派本阶段角色完成产出（产出达标后系统自动确认推进，无需询问用户；'
                    + '环境安装确认为唯一例外，仍需用户横幅应答）；信息不足时调 nanju_clarify_proxy 补完。'
                    + `产出达标后直接输出 <!-- PHASE_ADVANCE: ${newStage} --> 推进标记即可。当前拒因：`
                    + (autoBlockReason === 'verify-failed'
                      ? '阶段产出未达标：' + (autoBlockDetail || '校验器未返回详细原因；请读取对应阶段产物与校验清单。')
                      : autoBlockReason) + '。'
                } else {
                  hardGateMessage =
                    '⚠️ 推进未被授权：阶段推进需要真人确认（或系统指令）才能生效。\n\n'
                    + '请先用 AskUserQuestion（header 以「确认」开头）向用户发起本阶段收口确认，'
                    + '待用户横幅答复确认（或聊天框回复确认词）后，再重新声明推进；系统自动续接场景由系统指令驱动，无需自行声明。\n'
                    + '在未获得授权前，不要重复输出推进标记——重复声明同样会被拒绝。'
                }
                rejectWithEducationLoop(
                  workspaceSlug, project.projectId, sessionId, 'gate-deny',
                  hardGateMessage,
                  { target: newStage ?? '', expected: newStage ?? '' },
                  hooks,
                )
                continue
              }
              console.log(`[南大路由] 推进硬门通过：${authSource}（${project.currentStage} → ${newStage}）`)
              if (autoConfirmPassed) {
                // D8 §九 C′ R7-13：auto 项目 UC 态事实源 = autoConfirm 放行点（非 AskUser 放行点）
                try {
                  const { recordTelemetry } = require('./nanju-telemetry') as typeof import('./nanju-telemetry')
                  recordTelemetry(workspaceSlug, 'confirm.auto-confirm' as Parameters<typeof recordTelemetry>[1], {
                    project_id: project.projectId,
                    from_stage: project.currentStage,
                    target: newStage,
                    mode: project.mode,
                  }, project.projectId)
                } catch { /* 埋点失败不影响推进 */ }
                try {
                  const { tryAdvanceGuideSubStage } = require('./nanju-project') as typeof import('./nanju-project')
                  const { getGuideStageMainNodeId } = require('./nanju-guide-progress') as typeof import('./nanju-guide-progress')
                  const main = getGuideStageMainNodeId(project.currentStage)
                  if (main) tryAdvanceGuideSubStage(workspaceSlug, project.projectId, `${main}_UC`)
                } catch { /* 向导图写入失败不影响推进 */ }
              }
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
              // #4 prd.confirmed / #5 prototype.confirmed（PRD §12.4，I-P5 归属修正版）：
              // 归属在本消费器的「推进成功」分支（推进即事实），与 coding.executed/arch.executed 同口径。
              // - requirements 收口（requirements→prototype）→ #4；
              // - prototype 收口（prototype→architecture/coding）→ #5。
              if (project.currentStage === 'requirements' || project.currentStage === 'prototype') {
                try {
                  const { emitQuickEvent } = require('./nanju-quick-events') as typeof import('./nanju-quick-events')
                  emitQuickEvent(workspaceSlug, project.projectId,
                    project.currentStage === 'requirements' ? 'prd.confirmed' : 'prototype.confirmed', {
                      project_id: project.projectId,
                      mode: project.mode,
                      from_stage: project.currentStage,
                      to_stage: newStage,
                      // 产出验证已通过（本分支在 verifyError 为空时进入），此处只报事实
                      verified: true,
                    })
                } catch { /* 埋点失败不影响推进 */ }
              }
              // #14 architecture.confirmed（PRD §12.4，I-P8）：与 arch.executed 同拍但语义不同——
              // arch.executed = 架构师环节交付事实（含环境探测）；architecture.confirmed = 用户/门禁
              // 对架构产出的确认收口事实（两条各自独立观测，不互为别名）。
              if (project.currentStage === 'architecture') {
                try {
                  const { emitQuickEvent } = require('./nanju-quick-events') as typeof import('./nanju-quick-events')
                  emitQuickEvent(workspaceSlug, project.projectId, 'architecture.confirmed', {
                    project_id: project.projectId,
                    mode: project.mode,
                    to_stage: newStage,
                  })
                } catch { /* 埋点失败不影响推进 */ }
              }
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
                  // W-I B-c：阶段确认检查点；进入 coding 前一刻属于「即将修改工程」→ pre-modify
                  // （捕获的是 coding 开始前的工程内容，正是回滚到修复前所需的那份）。
                  hooks.captureCheckpoint?.({
                    workspaceSlug,
                    projectId: project.projectId,
                    sessionId,
                    triggerType: newStage === 'coding' ? 'pre-modify' : 'confirm',
                    description: `阶段推进：${project.name} → ${newStage}`,
                  })
                  // W22（F5③）：推进成功——拒收防环计数清零（新阶段重新计数）+ 待纠正拒因登记清除
                  try {
                    const { resetAdvanceRejectCount, clearProjectPendingAdvanceCorrection } = require('./nanju-project') as typeof import('./nanju-project')
                    resetAdvanceRejectCount(workspaceSlug, project.projectId)
                    clearProjectPendingAdvanceCorrection(workspaceSlug, project.projectId)
                  } catch { /* 清理失败不影响推进 */ }
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

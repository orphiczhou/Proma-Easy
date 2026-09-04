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
 * W10/W17：确认响应推进检测（单条用户文本）——事件流路径与 run 初始输入路径共用。
 * 语义见模块头；置位/清除/埋点与 W10 原事件流块完全一致，不自动推进（W10 设计决策）。
 */
export function checkConfirmAdvanceInput(sessionId: string, workspaceSlug: string, userText: string): void {
  if (userText.trim() === '') return
  try {
    const { listNanjuProjects, judgeConfirmAdvance, setProjectConfirmPending, clearProjectConfirmPending } =
      require('./nanju-project') as typeof import('./nanju-project')
    const project = listNanjuProjects(workspaceSlug).find(
      (p: { sessionId?: string }) => p.sessionId === sessionId,
    )
    if (!project) return
    const verifyError = verifyPhaseOutput(workspaceSlug, project.projectId, project.currentStage as import('./nanju-router').PhaseId)
    const action = judgeConfirmAdvance(userText, project.currentStage, verifyError)
    if (action === 'set') {
      setProjectConfirmPending(workspaceSlug, project.projectId, project.currentStage)
      try {
        const { recordTelemetry } = require('./nanju-telemetry') as typeof import('./nanju-telemetry')
        recordTelemetry(workspaceSlug, 'confirm.advance-hint', {
          project_id: project.projectId,
          stage: project.currentStage,
          mode: project.mode,
        }, project.projectId)
      } catch { /* 埋点失败不影响置位 */ }
      console.log(`[南大路由] 确认检测：置位 confirmPending=${project.currentStage}（${project.name}）`)
    } else if (action === 'clear') {
      clearProjectConfirmPending(workspaceSlug, project.projectId)
      console.log(`[南大路由] 确认检测：反义词清除 confirmPending（${project.name}）`)
    }
  } catch (e) {
    console.warn('[南大路由] 确认检测异常（不阻断）:', e instanceof Error ? e.message : String(e))
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
            updateNanjuProject(workspaceSlug, project.projectId, { currentStage: newStage })
            console.log(`[南大路由] ✅ 阶段推进: ${project.name} → ${newStage}`)
            advanced = newStage ?? null
            consumedStages.add(newStage)
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

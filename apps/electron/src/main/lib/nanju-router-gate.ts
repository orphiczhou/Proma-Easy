/**
 * 南大向导 v2 路由门禁
 *
 * 替代 nanju-phase-gate.ts 的 checkNanjuPhaseGate。
 * 在 canUseTool 中调用，按阶段限制调度员可用工具。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, resolve, sep } from 'node:path'
import { listNanjuProjects, getProjectCategory, getProjectEnvState, getProjectDeliveryChallenge, setActiveConfirmAsk, setActiveInstallAsk, type NanjuProject, type ProjectStage } from './nanju-project'
import { getPhaseNode, getNextPhase, type PhaseId, checkOutputFormat } from './nanju-router'
import { getWorkspaceFilesDir } from './config-paths'
import {
  STAGE_ROLE_KEYWORDS,
  STAGE_TITLES,
  checkDelegationAgainstStage,
  describeKeywordHit,
  detectACRole,
  extractDelegationSources,
  injectStagePathConstraint,
  isDelegationTool,
  matchACKeyword,
  matchStageKeyword,
  MINIMAX_REPAIR_GUIDANCE,
  resolveACOverride,
} from './nanju-delegate-guard'
import { recordTelemetry } from './nanju-telemetry'

// ===== 工具白名单（修正 Y9：移除 EnterPlanMode/ExitPlanMode） =====

const ACTIVE_PHASE_TOOLS = new Set([
  // collaboration 工具（Pi 运行时带 mcp__collaboration__ 前缀）
  'delegate_agent', 'delegate_agents', 'wait_for_delegations',
  'list_delegations', 'stop_delegation', 'get_delegation_results',
  'answer_delegation_question', 'continue_delegation',
  'mcp__collaboration__delegate_agent', 'mcp__collaboration__delegate_agents',
  'mcp__collaboration__wait_for_delegations', 'mcp__collaboration__list_delegations',
  'mcp__collaboration__stop_delegation', 'mcp__collaboration__get_delegation_results',
  'mcp__collaboration__answer_delegation_question', 'mcp__collaboration__continue_delegation',
  'mcp__collaboration__list_available_agent_models',
  // v2.4（D7 §4）：自动补完需求代理工具（B 域注册给 L1；A 域 §3 deny 教育话术指向它，
  // 白名单缺行则 L1 被自身门禁拒——代理链路断。代理子会话自身的工具面在 nanjuProxy 首分支单独管制）
  'nanju_clarify_proxy', 'mcp__collaboration__nanju_clarify_proxy',
  // 只读工具
  'Read', 'LS', 'Glob', 'Grep',
  // 交互工具
  'AskUserQuestion',
  // 预览工具（确认环节调度员主动打开右侧分屏展示产出；v0.16.89 起确认步骤强制调用）
  'open_preview', 'mcp__preview__open_preview',
  // 受管浏览器（v0.17.28 起对话式设计迭代：Observe 获取元素 ref / Screenshot 看原型 / PreviewOpen 打开本地 HTML）
  'BrowserPreviewOpen', 'BrowserObserve', 'BrowserScreenshot', 'BrowserListTabs', 'BrowserNewTab',
])

const PHASE_TOOL_WHITELIST: Record<PhaseId, Set<string>> = {
  requirements: new Set(ACTIVE_PHASE_TOOLS),
  prototype: new Set(ACTIVE_PHASE_TOOLS),
  architecture: new Set(ACTIVE_PHASE_TOOLS),
  planning: new Set(ACTIVE_PHASE_TOOLS),
  coding: new Set(ACTIVE_PHASE_TOOLS),
  // Sprint B：testing 与 coding 同白名单（调度员需要委派/等待/Read/AskUserQuestion/预览）
  testing: new Set(ACTIVE_PHASE_TOOLS),
  delivered: new Set(['Read', 'LS', 'AskUserQuestion']),
}

/**
 * 会话级工具不受 phase-gate 限制（修正 NY3）：
 * CompactContext 是会话元工具，管理会话自身的上下文，不是开发工具。
 */
const GLOBAL_ALLOWED_TOOLS = new Set([
  'CompactContext', 'compact',
])

// ===== v2.4：nanjuProxy 代理会话工具面（D7 §4 工具面白名单，I3 代理封闭） =====

/** 代理会话允许的工具：联网检索（WebSearch/WebFetch，实际工具名无 web_search）+ 只读 + 会话元工具 */
const NANJU_PROXY_ALLOWED_TOOLS = new Set([
  'WebSearch', 'WebFetch',
  'Read', 'LS', 'Glob', 'Grep',
  // 会话元工具（与 GLOBAL_ALLOWED_TOOLS 同源语义：管理会话自身上下文，非开发工具）
  'CompactContext', 'compact',
])

/** 会话是否为 nanju_clarify_proxy 代理子会话（meta.nanjuProxy 专属标记）。
 *  lazy require 规避模块初始化环（isDelegationChildSession 同型先例）；
 *  防御性类型断言读取（不依赖 AgentSessionMeta 类型声明——该字段由代理工具域
 *  在 agent-session-manager Pick 白名单同步落地，缺失时读 undefined 安全降级为非代理） */
function isNanjuProxySession(sessionId: string): boolean {
  try {
    const { getAgentSessionMeta } = require('./agent-session-manager') as typeof import('./agent-session-manager')
    const meta = getAgentSessionMeta(sessionId) as { nanjuProxy?: boolean } | undefined
    return meta?.nanjuProxy === true
  } catch {
    return false
  }
}

/** 代理会话工具门禁：白名单外一律 deny（fail-closed；含 AskUser/send_message/Write/Edit/Bash/delegate_agent/mcp__session__* 等） */
function checkNanjuProxyToolGate(
  sessionId: string,
  toolName: string,
): { behavior: 'deny'; message: string } | null {
  if (NANJU_PROXY_ALLOWED_TOOLS.has(toolName)) return null
  return {
    behavior: 'deny',
    message:
      '🔒 nanju_clarify_proxy 代理会话是封闭工具面：只允许联网检索（WebSearch/WebFetch）与只读（Read/LS/Glob/Grep）。\n\n'
      + '不允许：向用户提问（AskUserQuestion）、向其他会话发消息（send_message 等会话工具）、写入/修改文件、执行命令、再委派——代理只能基于检索结果作答。\n\n'
      + '请直接给出需求补充问题的回答（含来源要点），无需任何其他工具。',
  }
}

// ===== v2.4：L1 AskUserQuestion 路由（D7 §3，auto 开启时） =====

/**
 * 阶段收口类确认 header 后缀白名单（F2-3，#3：activeConfirmAsk 只登记「直接门控
 * PHASE_ADVANCE」的收口确认，中间确认不登记）。
 *
 * 与 C 域 nanju-router-prompt 六处确认话术对齐维护（改话术 header 时同步本表）：
 * - 原型交互验证（prototype）——「全部勾选/选『全部通过』→ 进入第 5 步」（推进标记）；
 * - 预览确认（coding）——「用户确认 → 进入第 5 步（输出推进标记进入 testing）」；
 * - 架构与环境配置（architecture）——「用户确认通过 → 进入第 5 步」（返工单预分类为
 *   中间类，但按其自身裁决标准「是否直接门控 PHASE_ADVANCE」，该确认即 architecture
 *   阶段最终收口（c→d 步直连第 5 步推进标记）；若不登记则正常收口横幅答案永远无法
 *   授权 → 推进门拒 → L1 重弹同话术死循环。裁决：登记；env-ready 门禁
 *   （verifyPhaseOutput）作二道防线兑底）；
 * - 满意交付（testing 交付验收）——「满意交付 → PHASE_ADVANCE: delivered」（特判 +
 *   双事实门禁为主路径，登记防御性）；
 * - 通用收口 header=「确认·{phase.title}」（需求分析师/UX 顾问/全栈开发/测试工程师/
 *   架构师/工程经理）——动态匹配当前阶段 title（isPhaseClosureConfirmHeader）。
 * 中间类（不登记）：安装缺失组件（确认后走安装流程；环境未就绪时话术明令禁止推进标记）。
 */
const CONFIRM_ASK_CLOSURE_SUFFIXES = new Set([
  '原型交互验证',
  '预览确认',
  '架构与环境配置',
  '满意交付',
])

/**
 * 判定 AskUser header 是否为「阶段收口类」确认问句（F2-3：登记面收窄依据）。
 * header 形态：「确认·{后缀}」（兼容无间隔符「确认{后缀}」形态）；后缀命中固定白名单
 * ∨ 等于当前阶段 phase.title（通用收口）→ 收口类。
 */
function isPhaseClosureConfirmHeader(
  project: NanjuProject,
  stage: ProjectStage,
  header: string,
): boolean {
  if (!header.startsWith('确认')) return false
  const suffix = header.startsWith('确认·') ? header.slice('确认·'.length) : header.slice('确认'.length)
  if (suffix === '') return false
  if (CONFIRM_ASK_CLOSURE_SUFFIXES.has(suffix)) return true
  try {
    const { getPhaseNode } = require('./nanju-router') as typeof import('./nanju-router')
    const title = getPhaseNode(project.mode, stage as import('./nanju-router').PhaseId)?.title
    return typeof title === 'string' && title !== '' && suffix === title
  } catch {
    return false
  }
}

/** AskUserQuestion 入参中的 question 结构（header 前缀路由判定的最小字段面） */
interface AskUserQuestionItem {
  question: string
  header?: string
}

/** 提取 AskUserQuestion 入参的 questions（结构异常返回空数组——交由 askUserService 原生校验，不在此拦格式） */
function extractAskQuestions(input: Record<string, unknown>): AskUserQuestionItem[] {
  const raw = input.questions
  if (!Array.isArray(raw)) return []
  return (raw as unknown[]).filter(
    (q): q is AskUserQuestionItem => typeof q === 'object' && q !== null && typeof (q as AskUserQuestionItem).question === 'string',
  )
}

/**
 * v2.4（D7 §3）：L1 AskUserQuestion 路由（auto 开启时；非承重——承重在 §2 推进门）。
 *
 * - auto 关闭（autoClarify.enabled !== true）→ 全放行（现状零变化）；
 * - 交付挑战机器豁免（D6/D7 §3②）：getProjectDeliveryChallenge() !== null → 无条件放行
 *   （不依赖 prompt 遵从 header 指令——交付链不得被切断）；
 * - header 前缀放行：全部 question 的 header 均以「确认/设计/转述」开头（多 question
 *   混合时 fail-closed 整体 deny——Defender #17① 口径）；
 * - 其余 deny + 教育（需求补充类→调 nanju_clarify_proxy；确认必须由真人给出）。
 */
function checkNanjuAskUserRoute(
  workspaceSlug: string,
  project: NanjuProject,
  toolName: string,
  input: Record<string, unknown>,
): { behavior: 'deny'; message: string } | null {
  if (project.autoClarify?.enabled !== true) return null
  // ── D8 A3′（R7-03）：auto on 时 AskUser 路由收窄 install-only ──
  // 用户裁决（D8 §〇）：auto = 「代替审核」——六确认话术全部自动确认，AskUser 唯一
  // 例外 = 环境安装（真实系统副作用）。header 前缀「确认/设计/转述」且非精确
  // 「确认·安装缺失组件」→ 一律 deny + 教育（指向直接推进/调代理）。
  // 交付挑战机器豁免（D7 §3②）追加谓词 ∧ enabled!==true：auto on 禁用（交付走
  // A2′ main 实跑 provenance，横幅链路整体不出现）。
  const questions = extractAskQuestions(input)
  if (questions.length === 0) return null
  const allInstallOnly = questions.every((q) => (q.header ?? '') === NANJU_ASK_INSTALL_HEADER)
  if (allInstallOnly) return null // 安装唯一放行（且不登记 activeConfirmAsk——下方整体跳过）
  const offending = questions.find((q) => q.header ?? q.question)
  try {
    recordTelemetry(
      workspaceSlug,
      'router.gate.ask-deny',
      {
        sessionId: project.sessionId,
        projectId: project.projectId,
        offendingHeader: offending?.header ?? '',
        questionPreview: offending?.question.slice(0, 60) ?? '',
        questionCount: questions.length,
        reason: 'auto-install-only',
      },
      project.projectId,
    )
  } catch { /* 埋点失败不影响门禁 */ }
  return {
    behavior: 'deny',
    message:
      '🔒 南大向导交互路由（已开启自动审核）：确认类环节不再询问用户——产出与 AC 审计通过后'
      + '【直接输出推进标记】，系统自动确认；需求补充类问题请调 nanju_clarify_proxy 由代理作答。\n\n'
      + '唯一例外：环境安装确认（header 精确为「' + NANJU_ASK_INSTALL_HEADER + '」）仍需用户横幅应答。\n'
      + '本次问题「' + (offending?.header ?? offending?.question.slice(0, 20) ?? '')
      + '」不在放行范围，已拒绝。请直接推进（产出达标时）或改调代理工具。',
  }
}

/** D8 A3′：auto on 唯一放行的 AskUser header（环境安装——真实系统副作用，唯一人工点） */
const NANJU_ASK_INSTALL_HEADER = '确认·安装缺失组件'

/**
 * v2.4（D7 §1 I1-②b / §3）：AskUser 放行侧登记 activeConfirmAsk。
 *
 * F2-3（#3）收窄：仅「阶段收口类」确认问句登记（isPhaseClosureConfirmHeader：
 * 白名单后缀 ∨ 通用收口「确认·{phase.title}」）——环境安装等中间确认不登记，
 * 其横幅答案不构成推进授权。expectedTarget 由 harness 按阶段图从当前 stage 算
 * 唯一合法下一阶段（L1 无法引导到非法目标）；无合法下一阶段（终态/路由缺失）不登记（防御性：
 * activeConfirmAsk.expectedTarget 永远非空）。不区分 auto 开关——auto 关闭项目的合规
 * 确认问句同样登记（话术 header 已全局统一加前缀，D7 §10），用户聊天框确认词同样
 * 需要活跃问句绑定（I1-②b 对全项目生效）。10min TTL 见 nanju-project。
 */
function registerConfirmAskIfEligible(
  workspaceSlug: string,
  project: NanjuProject,
  stage: ProjectStage,
  input: Record<string, unknown>,
): void {
  try {
    const questions = extractAskQuestions(input)
    if (questions.length === 0) return
    if (!questions.every((q) => isPhaseClosureConfirmHeader(project, stage, q.header ?? ''))) return
    const { getNextPhase } = require('./nanju-router') as typeof import('./nanju-router')
    const expected = getNextPhase(project.mode, stage as import('./nanju-router').PhaseId)
    if (!expected) return
    setActiveConfirmAsk(workspaceSlug, project.projectId, expected)
    console.log(`[南大路由] 登记活跃确认问句（expectedTarget=${expected}，10min TTL）: ${project.name}`)
  } catch (e) {
    console.warn('[南大路由] activeConfirmAsk 登记异常（不影响放行）:', e instanceof Error ? e.message : String(e))
  }
}

/**
 * 南大向导路由门禁。
 *
 * 在 canUseTool 中调用，返回 null 表示放行（非南大会话或不限制），
 * 返回 { behavior: 'deny', message } 表示拒绝。
 * W8（v0.17.71）：白名单放行委派工具后追加参数级三层强制
 * （checkNanjuDelegateGuard——阶段匹配 deny / AC 模型覆写 / 路径约束注入）。
 */
export function checkNanjuRouterGate(
  workspaceSlug: string | undefined,
  sessionId: string,
  toolName: string,
  input: Record<string, unknown>,
): { behavior: 'deny'; message: string } | null {
  // v2.4（D7 §4 enforcement）：nanjuProxy 首分支——代理子会话工具面白名单。
  // 必须是第一条语句（先于 !workspaceSlug 早退与 project 查询，防 fail-open：代理会话
  // 不绑定项目注册表，若后置会被「未找到项目」分支放行绕过整面封锁）。代理封闭（§1 I3）：
  // 代理不能产生 I1 任何形态（无 AskUser/无 send_message/无写/无再委派）。
  if (isNanjuProxySession(sessionId)) {
    return checkNanjuProxyToolGate(sessionId, toolName)
  }

  if (!workspaceSlug) return null

  // W19（v0.17.87）：projects 单次读取复用——未绑定分支的写保护也要消费同一份列表，
  // 避免每次工具调用重复读盘（原 findNanjuProjectBySession 内部同样 listNanjuProjects）
  const projects = listNanjuProjects(workspaceSlug)
  const project = projects.find((p) => p.sessionId === sessionId)
  if (!project) {
    // W19 缺陷A：未绑定项目的会话写保护（E2E 实测 6039a6af——「在新会话中重试」产生的
    // 普通续接会话 cwd=南大工作区根，Write 跨阶段直写 01_PRD/02_UX_DESIGN 成功，
    // router-gate 与 telemetry 双盲）。仅拦写类工具与 Bash；L2 委派子会话豁免
    // （sourceDelegationId 专属标记）；delivered 项目 08_APP 对普通会话开放。
    return checkUnboundSessionWriteGuard(workspaceSlug, sessionId, toolName, input, projects)
  }

  const stage = project.currentStage as PhaseId

  // 全局允许的会话元工具
  if (GLOBAL_ALLOWED_TOOLS.has(toolName)) return null

  // 终态阶段
  if (stage === 'delivered') {
    if (PHASE_TOOL_WHITELIST.delivered.has(toolName)) return null
    return {
      behavior: 'deny',
      message: '🎉 该项目已全部交付完成。\n\n· 想回看产出 → 项目目录 01_PRD / 02_UX_DESIGN / 08_APP（可运行应用入口 08_APP/index.html，右侧文件面板可浏览）\n· 想看测试报告 → 06_TESTS/report.json 与 06_TESTS/features/（验收场景与判定结果）\n· 想做新项目 → 在南大向导首页点「快速做一个工具」/「长期迭代项目」\n\n向导流程已收口。如需继续迭代：可在首页新建项目，或在普通 Agent 会话中继续修改 08_APP 代码。',
    }
  }

  // 活跃阶段
  const whitelist = PHASE_TOOL_WHITELIST[stage] ?? PHASE_TOOL_WHITELIST.delivered
  if (whitelist.has(toolName)) {
    // v2.4（D7 §3）：AskUserQuestion 路由（auto 开启时按 header 前缀放行/拒绝+教育；
    // 交付挑战机器豁免；auto 关闭全放行）+ 放行侧登记 activeConfirmAsk（确认 header 类）。
    if (toolName === 'AskUserQuestion') {
      const askGate = checkNanjuAskUserRoute(workspaceSlug, project, toolName, input)
      if (askGate) {
        console.log(`[南大路由门禁] AskUser 路由拒绝（自动审核开启，install-only）: ${project.name}`)
        return askGate
      }
      // W22（G 域 M-6）：install-only 横幅放行（auto on 的唯一例外 + auto off 的全放行
      // 两形态均覆盖）→ 登记 installAsk 在场标记——其横幅答案回传不构成推进授权，
      // 但在 checkConfirmAdvanceInput 侧豁免 clarify.suspect-fake-confirm 误记
      //（中间类确认不登记 activeConfirmAsk，答案命中确认词时原误记 no-active-ask）。
      // 不按 header 前缀宽匹配——精确等值 NANJU_ASK_INSTALL_HEADER 才登记，防混合
      // 问题（install + 非收口类）误入白名单。
      try {
        const askQuestions = extractAskQuestions(input)
        if (askQuestions.length > 0 && askQuestions.every((q) => (q.header ?? '') === NANJU_ASK_INSTALL_HEADER)) {
          setActiveInstallAsk(workspaceSlug, project.projectId)
        }
      } catch { /* 登记失败不影响放行（TTL 兜底，误记仅观测面） */ }
      // D8 A3′：auto on 时整体跳过登记——自动审核项目不产生「等待用户确认」问句
      //（activeConfirmAsk 是 I1-② 授权的上下文源，auto 项目推进走第四形态）；
      // 环境安装问句同样不登记（安装应答不构成推进授权）
      if (project.autoClarify?.enabled !== true) {
        registerConfirmAskIfEligible(workspaceSlug, project, stage, input)
      }
    }
    // W8：白名单放行委派工具后，追加参数级三层强制（非委派工具零变化）。
    // automation/triggeredBy 豁免由调用方（agent-orchestrator canUseTool）既有守卫保证。
    return checkNanjuDelegateGuard(workspaceSlug, project, stage, toolName, input)
  }

  // 阶段信息
  const phase = getPhaseNode(project.mode, stage)
  const phaseTitle = phase?.title ?? stage

  return {
    behavior: 'deny',
    message:
      `🔒 南大向导门禁：当前处于「${phaseTitle}」阶段。\n` +
      `你是调度员，不能自己写代码或文档。请用 delegate_agent 委派角色子会话完成工作。\n` +
      `允许的工具：委派(delegate_agent)、等待(wait_for_delegations)、读取(Read/LS)、提问(AskUserQuestion)。`,
  }
}

/** 根据会话 ID 查找关联的南大项目 */
export function findNanjuProjectBySession(workspaceSlug: string, sessionId: string): NanjuProject | undefined {
  const projects = listNanjuProjects(workspaceSlug)
  return projects.find((p) => p.sessionId === sessionId)
}

// ═══════════════ W19 缺陷A（v0.17.87）：未绑定会话写保护 ═══════════════

/** 写类工具（工单口径：Write/Edit/NotebookEdit；Bash 按命令文本保守拦截，单独判定） */
const UNBOUND_WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit'])

/** 项目脚手架阶段目录（nanju-project.ts createNanjuProject 的 docDirs 同源清单） */
const STAGE_DIR_NAMES = new Set([
  '01_PRD', '02_UX_DESIGN', '03_ARCHITECTURE', '04_API_SPEC',
  '05_PROJECT_PLAN', '06_TESTS', '07_VERSIONS', '08_APP',
])

/** delivered 项目对未绑定会话开放的豁免目录（delivered 提示语明确允许普通会话继续改 08_APP 代码） */
const DELIVERED_EXEMPT_DIR = '08_APP'

/** 未绑定会话写拦截命中（供 deny 文案与 telemetry 共用） */
interface UnboundWriteHit {
  /** 归因到的项目（裸阶段目录前缀无法归因时为空） */
  project?: NanjuProject
  /** 项目内一级目录（项目根散文件时为空串） */
  stageDir?: string
  /** 拦截原因 */
  reason: 'project-dir' | 'stage-dir-prefix' | 'bash-project-path' | 'bash-stage-dir'
  /** 路径摘要（截断） */
  pathSummary: string
}

function summarizePath(p: string): string {
  return p.length > 160 ? `${p.slice(0, 160)}…` : p
}

/** 当前用户 home（~ 展开用；获取失败退化为空串——~ 形态仅退化为字面比对，不抛错） */
const HOME_DIR = (() => {
  try {
    return homedir()
  } catch {
    return ''
  }
})()

/**
 * F1（审查必修，v0.17.90）：守卫用词法路径归一化——归因与豁免判定前统一调用。
 *
 * 反斜杠→正斜杠；`~`/`~/` 展开为 home；剥空段与 `.` 段；消解 `..` 段（绝对路径
 * 越到根则丢弃，相对路径的前导 `..` 保留——不预设 cwd，交由调用方保守处理）；
 * 不触盘（纯词法，与 runtime 实际解析解耦——判定属保守拦截口径）。
 *
 * 堵审查实证三形态：`./project-<id>/…`（前缀比对绕过）、`08_APP/../01_PRD/…`
 * （豁免穿越）、`~/…`（整体跳过归因）。
 */
function normalizeGuardPath(value: string): string {
  let p = value.replace(/\\/g, '/')
  if (HOME_DIR !== '') {
    if (p === '~') p = HOME_DIR
    else if (p.startsWith('~/')) p = `${HOME_DIR}/${p.slice(2)}`
  }
  const isAbs = p.startsWith('/')
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!isAbs) out.push('..')
      continue
    }
    out.push(seg)
  }
  return (isAbs ? '/' : '') + out.join('/')
}

/** 路径是否落在 root 下：返回相对部分（root 本身返回 ''），不在 root 下返回 null */
function pathRelativeTo(path: string, root: string): string | null {
  const p = path.replace(/\\/g, '/')
  const r = root.replace(/\\/g, '/').replace(/\/+$/, '')
  if (p === r) return ''
  if (p.startsWith(`${r}/`)) return p.slice(r.length + 1)
  return null
}

/** delivered 项目 08_APP/ 前缀豁免（指挥官裁决：其余目录 01~07、09+、项目根散文件一律 deny）。
 *  F1：rel 先归一化再判——堵 `08_APP/../01_PRD/x` 穿越（首段 08_APP 但实写 01_PRD） */
function isDeliveredAppExempt(project: NanjuProject, rel: string): boolean {
  if (project.currentStage !== 'delivered') return false
  const norm = normalizeGuardPath(rel.replace(/^\/+/, ''))
  return norm === DELIVERED_EXEMPT_DIR || norm.startsWith(`${DELIVERED_EXEMPT_DIR}/`)
}

/** 会话是否为协作委派子会话（L2）。sourceDelegationId 是委派子会话专属标记
 * （fork/「在新会话中重试」续接会话只有 parentSessionId，无此字段——收集判据见
 * agent-session-manager.ts「仅收集协作委派子会话」注释）。南大管线的跨阶段写入由
 * L2 完成，必须豁免。lazy require 规避模块初始化环。 */
function isDelegationChildSession(sessionId: string): boolean {
  try {
    const { getAgentSessionMeta } = require('./agent-session-manager') as typeof import('./agent-session-manager')
    return Boolean(getAgentSessionMeta(sessionId)?.sourceDelegationId)
  } catch {
    return false
  }
}

/** Bash 命令中项目目录提及的尾随路径片段（到空白/引号/管道/分号为止），用于 08_APP 豁免判定 */
function bashMentionTail(command: string, from: number): string {
  return command.slice(from).match(/^[^\s'"`|;&<>()]*/)?.[0] ?? ''
}

/** Write/Edit/NotebookEdit 路径字段的写域判定（file_path 与 path 双字段兼容——E2E 6039a6af 实测两者并存）。
 *  F1：归因/豁免/裸前缀判定前统一 normalizeGuardPath（~ 展开与 ./、..、重复斜杠消解） */
function findUnboundWriteHit(
  workspaceSlug: string,
  projects: NanjuProject[],
  input: Record<string, unknown>,
): UnboundWriteHit | null {
  for (const key of ['file_path', 'filePath', 'path', 'notebook_path'] as const) {
    const raw = input[key]
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const value = normalizeGuardPath(raw)

    // 1) 项目目录归因（绝对路径或显式 project-<id>/ 前缀相对路径——均在归一化后比对）
    let attributed = false
    for (const project of projects) {
      const rootAbs = join(getWorkspaceFilesDir(workspaceSlug), `project-${project.projectId}`)
      const rootRel = `project-${project.projectId}/`
      const rel = pathRelativeTo(value, rootAbs) ?? (value.startsWith(rootRel) ? value.slice(rootRel.length) : null)
      if (rel === null) continue
      attributed = true
      if (isDeliveredAppExempt(project, rel)) continue
      return { project, stageDir: rel.split('/')[0] ?? '', reason: 'project-dir', pathSummary: summarizePath(raw) }
    }
    if (attributed) continue // 落入唯一归属项目的豁免 → 本候选放行

    // 2) 裸阶段目录前缀（相对路径，cwd 不可知——阶段目录是南大专属结构，保守拦截；
 //    归一化后剥前导 ..（cwd 在工作区任意深度时 ../project-<id>/… 仍可达），
    //    08_APP 仅当工作区全部项目 delivered 才放行，否则按保守 deny）
    if (!value.startsWith('/')) {
      const rel = value.replace(/^(?:\.\.\/)+/, '')
      const seg = rel.split('/')[0] ?? ''
      if (STAGE_DIR_NAMES.has(seg)) {
        if (seg === DELIVERED_EXEMPT_DIR && projects.every((p) => p.currentStage === 'delivered')) continue
        return { stageDir: seg, reason: 'stage-dir-prefix', pathSummary: summarizePath(raw) }
      }
    }
  }
  return null
}

/** Bash 命令文本的项目路径保守拦截（不做命令解析：读命令同样拦，工单裁决口径） */
function findUnboundBashHit(
  workspaceSlug: string,
  projects: NanjuProject[],
  command: string,
): UnboundWriteHit | null {
  // 1) 项目目录提及（绝对 root 或裸 project-<id>；带 id 边界检查防 project-p1 误配 project-p10）。
  //    已豁免（delivered+08_APP）的提及记录字符范围，供第 2 步去重
  const exemptRanges: Array<[number, number]> = []
  for (const project of projects) {
    const rootAbs = join(getWorkspaceFilesDir(workspaceSlug), `project-${project.projectId}`)
    const rootRel = `project-${project.projectId}`
    for (const needle of [rootAbs, rootRel]) {
      let idx = command.indexOf(needle)
      while (idx !== -1) {
        const after = command[idx + needle.length] ?? ''
        const isIdBoundary = after === '' || !/[A-Za-z0-9_-]/.test(after)
        if (isIdBoundary) {
          const tail = bashMentionTail(command, idx + needle.length)
          // F1：尾随路径归一化后再取首段——堵 08_APP/../01_PRD 豁免穿越（Bash 形态）
          const seg = normalizeGuardPath(tail.replace(/^\/+/, '')).split('/')[0] ?? ''
          if (!isDeliveredAppExempt(project, seg)) {
            return {
              project,
              stageDir: seg,
              reason: 'bash-project-path',
              pathSummary: summarizePath(command.slice(idx, idx + needle.length + tail.length)),
            }
          }
          exemptRanges.push([idx, idx + needle.length + tail.length])
        }
        idx = command.indexOf(needle, idx + 1)
      }
    }
  }
  // 2) 裸阶段目录前缀（echo x > 01_PRD/y 类；08_APP 仅全 delivered 工作区放行）。
  //    落在已豁免项目路径提及范围内的阶段目录不重复计数（cat project-dlv/08_APP/x 的
  //    08_APP/ 已在第 1 步按项目归属豁免）
  const stageDirRe = /\b(01_PRD|02_UX_DESIGN|03_ARCHITECTURE|04_API_SPEC|05_PROJECT_PLAN|06_TESTS|07_VERSIONS|08_APP)\//g
  for (const match of command.matchAll(stageDirRe)) {
    const start = match.index ?? 0
    if (exemptRanges.some(([s, e]) => start >= s && start < e)) continue
    const seg = match[1] ?? ''
    if (seg === DELIVERED_EXEMPT_DIR && projects.every((p) => p.currentStage === 'delivered')) continue
    return { stageDir: seg, reason: 'bash-stage-dir', pathSummary: summarizePath(match[0]) }
  }
  return null
}

function buildUnboundWriteDenyMessage(hit: UnboundWriteHit, isBash: boolean): string {
  const dirLabel = hit.stageDir && STAGE_DIR_NAMES.has(hit.stageDir) ? `${hit.stageDir}/ 目录` : '根目录'
  const target = hit.project ? `项目「${hit.project.name}」的 ${dirLabel}内` : `南大项目阶段目录（${hit.stageDir ?? '阶段目录'}/ 前缀）内`
  const deliveredHint = hit.project
    ? hit.project.currentStage === 'delivered'
      ? `当前项目已交付，但目标路径${hit.stageDir === DELIVERED_EXEMPT_DIR ? '' : `在 ${hit.stageDir ?? '项目根'}，`}不在豁免范围`
      : '当前项目尚未交付（delivered），不适用 08_APP 豁免'
    : '裸阶段目录前缀无法归因到具体项目，工作区内存在未交付项目时保守拦截'
  return (
    `🔒 南大向导写保护：当前会话未绑定南大项目，不能直接写入项目目录。\n\n` +
    `本次${isBash ? ' Bash 命令' : '写入操作'}目标位于${target}。南大项目的阶段产物由向导流程的阶段会话统一管理，` +
    `未绑定会话直写会导致阶段状态与产物脱节。\n\n` +
    `· 想推进或修改该项目 → 请回到该项目的南大向导会话继续（由调度员按阶段委派完成）\n` +
    `· 想继续改已交付应用 → 仅已交付（delivered）项目的 ${DELIVERED_EXEMPT_DIR}/ 目录对普通会话开放；${deliveredHint}\n` +
    `· 只想查看内容 → Read / LS 等只读工具不受限制` +
    (isBash
      ? `\n\n（Bash 命令包含项目路径时不做命令解析、保守拦截——如需在项目目录内执行命令，请通过南大向导流程完成。）`
      : '')
  )
}

/**
 * W19 缺陷A（v0.17.87）：未绑定南大项目的会话写保护。
 *
 * 背景：E2E 实测（6039a6af）——首发被拒后 UI「在新会话中重试」产生的普通续接会话
 * 不在项目注册表，原 `!project → return null` 使其绕过全部守卫，跨阶段直写
 * 01_PRD/02_UX_DESIGN 成功且 0 telemetry。
 *
 * 判定（工单口径）：
 * - 零 nanju 项目的 workspace → 直接放行（非 nanju 工作区零行为变化）；
 * - 仅拦写类工具（Write/Edit/NotebookEdit）与 Bash（命令文本含项目路径即拦，保守不解析）；
 * - L2 委派子会话豁免（sourceDelegationId）——南大管线跨阶段写入由 L2 完成；
 * - delivered 项目 08_APP/ 前缀对未绑定会话放行（delivered 提示语义）；
 * - 读类（Read/LS/Grep/Glob）与会话元工具不拦。
 */
function checkUnboundSessionWriteGuard(
  workspaceSlug: string,
  sessionId: string,
  toolName: string,
  input: Record<string, unknown>,
  projects: NanjuProject[],
): { behavior: 'deny'; message: string } | null {
  if (projects.length === 0) return null
  const isBash = toolName === 'Bash' || toolName === 'bash'
  if (!UNBOUND_WRITE_TOOLS.has(toolName) && !isBash) return null
  if (isDelegationChildSession(sessionId)) return null

  const hit = isBash
    ? (typeof input.command === 'string' && input.command.trim() !== '' ? findUnboundBashHit(workspaceSlug, projects, input.command) : null)
    : findUnboundWriteHit(workspaceSlug, projects, input)
  if (!hit) return null

  recordTelemetry(
    workspaceSlug,
    'router.gate.unbound-write-deny',
    {
      sessionId,
      toolName,
      reason: hit.reason,
      projectId: hit.project?.projectId,
      stageDir: hit.stageDir ?? '',
      pathSummary: hit.pathSummary,
    },
    hit.project?.projectId,
  )
  return { behavior: 'deny', message: buildUnboundWriteDenyMessage(hit, isBash) }
}

/**
 * W11（v0.17.73）：PHASE_ADVANCE 推进目标校验（纯函数，供检测块通用分支消费标记前调用）。
 *
 * 背景：终测 E2E 实锤——L1 在 prototype 阶段输出 `PHASE_ADVANCE: coding` 跳过
 * architecture（jsonl 行 81），检测块按标记目标推进、无校验（继 W8 拦委派角色 /
 * W10 提示推进纪律之后的第三个强制力缺口）。
 *
 * 判定矩阵（六活跃阶段 × 合法/跳级/回退）：
 * - 合法：newStage === getNextPhase(mode, currentStage)（route.next 同源）→ 放行；
 * - 跳级（跨阶段前跳）/ 回退（回到已过阶段）→ 一律拒绝，expected 给出唯一合法目标
 *   （供调用方生成教育消息；null = 终态无下一阶段）。
 *
 * 特判豁免（与 agent-orchestrator 检测块分流同构，防两处口径漂移）：
 * - testing → testing：GWT 重入（触发验收测试重跑，不改阶段），由 isTestingSelfAdvance
 *   分支在校验之前分流；
 * - testing → delivered：GWT 交付（另经 checkNanjuGwtDeliveryGate 门禁），由
 *   isDeliverFromTesting 分支分流。
 *
 * 防御性放行（工单 §1：宁可放行不可卡死）：mode 非 quick/iterative（数据异常）或
 * currentStage 不在该模式路由中（mode-select / quick 无 planning 等，找不到 route
 * 节点）→ 维持现状放行，不新增拦截。delivered 在路由中（哨兵 next=null）：任何
 * newStage 都拒绝——终态无合法推进，口径一致不搞特例。
 */
export function validateAdvanceTarget(
  mode: string,
  currentStage: ProjectStage,
  newStage: string,
): { ok: boolean; expected?: PhaseId | null } {
  // 异常 mode 兜底：非 quick/iterative（历史数据损坏等）→ 防御性放行
  if (mode !== 'quick' && mode !== 'iterative') return { ok: true }
  // 找不到 route 节点（mode-select 未定模式 / 该模式无此阶段）→ 防御性放行
  if (!getPhaseNode(mode, currentStage as PhaseId)) return { ok: true }
  // testing 特判豁免：两特殊分支（GWT 重入 / GWT 交付）在校验之前分流，此处同口径豁免
  if (currentStage === 'testing' && (newStage === 'testing' || newStage === 'delivered')) {
    return { ok: true }
  }
  const expected = getNextPhase(mode, currentStage as PhaseId)
  if (newStage === expected) return { ok: true }
  return { ok: false, expected }
}

/**
 * W17（v0.17.77，Q1 主修）：从本轮累积消息中按序收集全部 PHASE_ADVANCE / PHASE_COMPLETE
 * 推进标记（纯函数，供编排器 result 检测块消费前调用）。
 *
 * 背景（终局复测实证）：原检测仅扫 run 末条 assistant 消息，而 L1 的三次标记全部
 * 输出在 run 中段收口消息里（其后还有委派/轮询/兜底等 assistant 消息）——标记永远
 * 不在扫描窗口，零消费、currentStage 冻结、六阶段状态机名存实亡。
 *
 * W17-AC-S1（A3 锚定收集，裁决采纳防御方案）：收集正则收紧为两种锚定形态——
 * ① 注释形态 `<!-- PHASE_ADVANCE: xxx -->`（W11 拒绝消息引导的输出形态；W2c
 *   NANJU_REGRESSION 同库锚定先例）；
 * ② 行首形态（串首/换行后可选空白直接跟标记，容忍缩进）。
 * 句中引用（正文/代码块/说明文字复述协议字面串，如「下一步我会输出 PHASE_ADVANCE:
 * architecture」）不再收集；丢弃命中记 console.warn + phase.advance.discarded-unanchored
 * telemetry（opts.workspaceSlug 提供时），观察一迭代周期后再定稿（裁决：欠收集比误
 * 收集致命，故行首裸标记仍收集——独立行声明的标记视为真实意图）。
 *
 * 语义：按「消息序 × 消息内偏移」全量收集（同一条消息内多个标记也按出现序），
 * 大小写归一（与原单标记正则同型 /i）；仅扫 assistant 消息的 text 块。收集后的
 * 消费语义（W11 validateAdvanceTarget 按序校验 + 同 run 去重）在
 * nanju-phase-advance-consumer.consumePhaseAdvanceMarks，勿在此处重复。
 */
export function collectPhaseAdvanceStages(
  messages: ReadonlyArray<{ type?: string; message?: unknown }>,
  opts?: { workspaceSlug?: string },
): string[] {
  const stages: string[] = []
  const discarded: Array<{ stage: string; context: string }> = []
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue
    const content = (msg.message as { content?: Array<{ type: string; text?: string }> } | undefined)?.content
    const text = (content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('')
    if (!text) continue
    // 锚定形态：注释 ∪ 行首（捕获组 1=注释内、2=行首）
    const anchoredMatches = [...text.matchAll(
      /(?:<!--\s*(?:PHASE_COMPLETE|PHASE_ADVANCE):\s*([a-z-]+)\s*-->)|(?:^|\n)[ \t]*(?:PHASE_COMPLETE|PHASE_ADVANCE):\s*([a-z-]+)/gi,
    )]
    for (const match of anchoredMatches) {
      const stage = (match[1] ?? match[2] ?? '').toLowerCase()
      if (stage) stages.push(stage)
    }
    // 丢弃观测：宽松命中数 - 锚定命中数 = 句中引用丢弃数（附上下文样本）
    const looseMatches = [...text.matchAll(/(?:PHASE_COMPLETE|PHASE_ADVANCE):\s*([a-z-]+)/gi)]
    if (looseMatches.length > anchoredMatches.length) {
      for (const match of looseMatches) {
        const idx = match.index ?? 0
        const covered = anchoredMatches.some((am) => {
          const amIdx = am.index ?? 0
          return idx >= amIdx && idx < amIdx + am[0].length
        })
        if (covered) continue
        const stage = (match[1] ?? '').toLowerCase()
        if (!stage) continue
        discarded.push({ stage, context: text.slice(Math.max(0, idx - 20), idx + 40).replace(/\n/g, ' ') })
      }
    }
  }
  if (discarded.length > 0) {
    console.warn(`[南大路由] 丢弃 ${discarded.length} 处未锚定推进标记引用（句中非声明形态）: ${discarded.map((d) => d.stage).join(', ')}`)
    try {
      if (opts?.workspaceSlug) {
        const { recordTelemetry } = require('./nanju-telemetry') as typeof import('./nanju-telemetry')
        recordTelemetry(opts.workspaceSlug, 'phase.advance.discarded-unanchored', {
          count: discarded.length,
          stages: discarded.map((d) => d.stage),
          sample: discarded.slice(0, 3).map((d) => d.context),
        })
      }
    } catch { /* telemetry 失败不影响收集 */ }
  }
  return stages
}

/** 判定对象型值（mutate 目标防御） */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function taskPreview(text: string | undefined): string {
  if (!text) return ''
  return text.length > 80 ? `${text.slice(0, 80)}…` : text
}

/**
 * W8 委派守卫（v0.17.71）：三层程序化强制，在 router-gate 白名单放行
 * delegate_agent / delegate_agents 后追加参数级校验。
 *
 * - 层一（硬拦截）：委派角色-阶段匹配——命中其他阶段专属词则拒绝
 *   （批量委派任一不匹配则整批拒绝，文案列出违规项）；
 * - 层二（模型覆写）：命中 AC 词且能区分攻/防时，按项目 mode 覆写
 *   channelId/modelId 为 AC 预设（quick→light / iterative→medium），
 *   根治 L1 自选已下线模型（如 glm-5-turbo）；
 * - 层三（软约束注入）：放行的非 AC 类委派在 task 末尾追加阶段写入
 *   边界约束（幂等标记防重复；AC 类不注入——审计只读）。
 *
 * 副作用：层二/层三 mutate input（canUseTool 的 allow 路径返回
 * updatedInput: input 同一引用，mutate 即生效）；telemetry 记录
 * stage-deny / unmatched-action-deny（W10）/ pass-unmatched / ac-override。
 *
 * 设计决策：无用户级跳过通道——用户要快可走 quick 流程本身，阶段序列
 * 不可跳（品类判定/环境探测是 W7 用户裁决的不可裁剪目标）。
 */
function checkNanjuDelegateGuard(
  workspaceSlug: string,
  project: NanjuProject,
  stage: PhaseId,
  toolName: string,
  input: Record<string, unknown>,
): { behavior: 'deny'; message: string } | null {
  // 非委派工具（白名单内其他工具）：零变化放行
  if (!isDelegationTool(toolName)) return null
  // 非六活跃阶段（mode-select 等）：不校验（既有白名单语义已足够）
  if (!(stage in STAGE_ROLE_KEYWORDS)) return null

  const guardStage = stage as keyof typeof STAGE_ROLE_KEYWORDS
  // 单次遍历构造（source 与 result 同源，避免 noUncheckedIndexedAccess 索引访问 undefined 问题）
  const entries = extractDelegationSources(input).map((source, index) => ({
    source,
    index,
    result: checkDelegationAgainstStage(guardStage, source),
  }))

  // ── 层一：任一命中其他阶段专属词（W8）或强动作动词（W10-V2.1）→ 拒绝 ──
  // W10 起拒绝原因分流（result.denialKind）：other-stage = 命中他阶段词（既有语义，
  // 未定义时也归此类向后兼容）；strong-verb = unmatched+强动词（W8 敞口兜底）。
  const stageViolations = entries.filter((e) => !e.result.allowed && e.result.denialKind !== 'strong-verb')
  const verbViolations = entries.filter((e) => !e.result.allowed && e.result.denialKind === 'strong-verb')
  if (stageViolations.length > 0 || verbViolations.length > 0) {
    const stageTitle = STAGE_TITLES[guardStage]
    const lines: string[] = []
    // W22 O2：minimax-repair-misuse 优先分流——消费 MINIMAX_REPAIR_GUIDANCE 专属文案
    // （比通用「命中他阶段词」更精准的纠偏指引），不进通用 stageViolations 行
    const repairMisuse = stageViolations.filter((v) => v.result.denialKind === 'minimax-repair-misuse')
    const genericStageViolations = stageViolations.filter((v) => v.result.denialKind !== 'minimax-repair-misuse')
    for (const v of repairMisuse) {
      const label = v.source.title?.trim() || taskPreview(v.source.task) || '未命名委派'
      lines.push(`· #${v.index + 1}「${label}」：代码修复委派指向 MiniMax——${MINIMAX_REPAIR_GUIDANCE}`)
    }
    for (const v of genericStageViolations) {
      const label = v.source.title?.trim() || taskPreview(v.source.task) || '未命名委派'
      // R5（AC 裁决 A6）：不断言归属阶段（键序首命中词未必是最专属词——如「测试工程师」
      // 首命中「工程」标 planning），只声明与当前阶段不符，避免误导 L1 纠偏方向
      lines.push(`· #${v.index + 1}「${label}」命中「${v.result.violatedKeyword}」（与当前阶段「${stageTitle}」不符，命中他阶段词）`)
    }
    for (const v of verbViolations) {
      const label = v.source.title?.trim() || taskPreview(v.source.task) || '未命名委派'
      lines.push(`· #${v.index + 1}「${label}」含产出类动作词「${v.result.matchedVerb}」但未声明任何阶段角色`)
    }
    if (stageViolations.length > 0) {
      recordTelemetry(
        workspaceSlug,
        'delegate.guard.stage-deny',
        {
          stage: guardStage,
          toolName,
          count: stageViolations.length,
          violations: stageViolations.map((v) => ({
            stage: v.result.violatedStage,
            keyword: v.result.violatedKeyword,
            // W18：本阶段词共现观察口径——严格序（他阶段扫描先于本阶段词）下，
            // 合法交叉表述被拒时此字段非空；非空占比即本阶段词共现率（deny-with-coPresent）
            // 统计依据。注意：共现既出现在误拦、也出现在正确拦截上（如「基于 PRD 需求直接
            // 开发」是真阳拦截），非空占比≠误拦率（W18.1 A4 口径修正）
            coPresentStageKeyword: matchStageKeyword(guardStage, v.source),
            // W19-C：命中位置上下文（哪个字段/前后 20 字符/是否在路径内）——误拦归因用
            matchContext: v.result.violatedKeyword
              ? describeKeywordHit(v.source, v.result.violatedKeyword)
              : undefined,
            title: v.source.title,
            taskPreview: taskPreview(v.source.task),
          })),
        },
        project.projectId,
      )
    }
    // W10：unmatched+强动词拒绝单独埋点（含命中动词与文本摘要——工单 §1 观察口径）
    if (verbViolations.length > 0) {
      recordTelemetry(
        workspaceSlug,
        'delegate.guard.unmatched-action-deny',
        {
          stage: guardStage,
          toolName,
          count: verbViolations.length,
          denies: verbViolations.map((v) => ({
            verb: v.result.matchedVerb,
            title: v.source.title,
            taskPreview: taskPreview(v.source.task),
          })),
        },
        project.projectId,
      )
    }
    return {
      behavior: 'deny',
      message:
        `🔒 南大向导委派门禁：当前处于「${stageTitle}」（${guardStage}）阶段，本次委派与阶段职责不匹配，已拒绝。\n` +
        `\n${lines.join('\n')}\n` +
        `\n当前阶段允许委派的角色（关键词）：${STAGE_ROLE_KEYWORDS[guardStage].join('、')}；` +
        `AC 攻防审计类（攻击/防御/审计/复审）全阶段可委派。\n` +
        (verbViolations.length > 0
          ? `\n委派内容含产出类动作但未声明阶段角色。请在 title/task 明确角色（如「UX 顾问原型」「全栈开发」）后重试——阶段校验依赖角色声明。（当前${guardStage}阶段，允许的角色关键词见上）\n`
          : '') +
        `\n推进方式：完成本阶段产出并在会话中输出 PHASE_ADVANCE 标记，进入下一阶段后再委派。\n` +
        `若你判断确需调整阶段：请在对话中向用户说明理由，由推进链裁决，不可直接越阶段委派` +
        `（阶段序列不可跳过——品类判定/环境探测是用户已裁决的不可裁剪目标）。`,
    }
  }

  // ── 放行路径副作用（层二覆写 + 层三注入）──
  // 单个委派 target 即 input 本身；批量委派 target 为 items 各元素（与 entries 索引对齐）。
  const targets: unknown[] = Array.isArray(input.items) ? input.items : [input]
  for (const { source, result, index } of entries) {
    const target = targets[index]
    if (!isRecord(target)) continue

    // 层二：AC 模型程序化覆写（命中 AC 词且能区分攻/防；不受层一判定顺序影响）
    // W22 O1：第三参 guardStage——per-phase acAttacker 覆盖位（testing 攻击者=glm 跨族）
    // 必须在此接线，否则被全局 preset 静默覆写回 deepseek（与新作者同族）。
    // 家族标记跳过：acDefender 的 'minimax' 是家族标记非真实渠道 ID（真实渠道为运行时
    // 解析的 UUID，仅 router-prompt 侧能解析）——直接覆写会产生无效渠道，此情形不覆写
    if (matchACKeyword(source) !== undefined) {
      const acRole = detectACRole(source)
      if (acRole !== null) {
        const override = resolveACOverride(acRole, project.mode, guardStage)
        if (override.channel !== 'minimax') {
        const originalChannelId = typeof target.channelId === 'string' ? target.channelId : '(inherit)'
        const originalModelId = typeof target.modelId === 'string' ? target.modelId : '(inherit)'
        target.channelId = override.channel
        target.modelId = override.model
        recordTelemetry(
          workspaceSlug,
          'delegate.guard.ac-override',
          {
            stage: guardStage,
            acRole,
            mode: project.mode,
            originalChannelId,
            originalModelId,
            channelId: override.channel,
            modelId: override.model,
            title: source.title,
          },
          project.projectId,
        )
        } else {
          // 家族标记（minimax）跳过：保留 L1 显式渠道，仅埋点可观测
          recordTelemetry(
            workspaceSlug,
            'delegate.guard.ac-override',
            { stage: guardStage, acRole, mode: project.mode, skipped: 'family-marker', channelId: override.channel, modelId: override.model, title: source.title },
            project.projectId,
          )
        }
      }
    }

    // 层三：产出路径阶段约束注入（AC 类不注入——审计只读；宁多勿少）
    // R1（AC 裁决 A3）：注入条件与层二识别同源——不看层一 matchKind，看 matchACKeyword，
    // 消除「本阶段词+AC 词并存」时层二覆写/层三注入判定分叉（本阶段词先命中 →
    // matchKind='stage' 但 AC 词在场 → 不注入）
    if (matchACKeyword(source) === undefined && typeof target.task === 'string') {
      target.task = injectStagePathConstraint(guardStage, target.task)
    }

    // 误拦观察：两类词都不命中的辅助类委派，放行 + telemetry（第一版保守观察 unmatched 放行面；
    // deny 侧误拦观察见 stage-deny 埋点 coPresentStageKeyword 的共现率口径）
    if (result.matchKind === 'unmatched') {
      recordTelemetry(
        workspaceSlug,
        'delegate.guard.pass-unmatched',
        {
          stage: guardStage,
          toolName,
          title: source.title,
          taskPreview: taskPreview(source.task),
        },
        project.projectId,
      )
    }
  }
  return null
}

/**
 * 验证阶段产出文件（修正 F6 + Y5）。
 * Harness 代码在 PHASE_COMPLETE 检测后调用。
 *
 * 返回 null 表示验证通过，返回 string 表示错误原因。
 */
export function verifyPhaseOutput(
  workspaceSlug: string,
  projectId: string,
  phaseId: PhaseId,
): string | null {
  const projectDir = join(getWorkspaceFilesDir(workspaceSlug), `project-${projectId}`)
  const phase = getPhaseNode(
    listNanjuProjects(workspaceSlug).find((p) => p.projectId === projectId)?.mode ?? 'iterative',
    phaseId,
  )
  if (!phase || !phase.outputPath) return null

  const filePath = join(projectDir, phase.outputPath)

  if (!existsSync(filePath)) {
    return `产出文件不存在：${phase.outputPath}`
  }

  const stat = statSync(filePath)
  if (stat.size < 100) {
    return `产出文件过小（${stat.size} 字节），内容可能不完整：${phase.outputPath}`
  }

  // 最低格式检查
  const content = readFileSync(filePath, 'utf-8')
  if (!checkOutputFormat(phaseId, content)) {
    return `产出文件格式不符合要求（缺少基本结构）：${phase.outputPath}`
  }

  // testing 阶段（v0.17.63，AC I-001）：可执行契约存在性门禁——06_TESTS/features/ 下
  // 至少一个 *.steps.json（与 us-XX.feature 成对）。成对一致性与 JSON/schema 合法性由
  // GwtRunner 的 schema 校验分层保证，此处只做最低存在性（防止只交汇总入口就过关）。
  // v0.17.64（实证③）：Scenario 检查改为目录兑底——「总览+分文件」结构中 index.feature
  // 是索引（可无 Scenario:），场景在各 us-XX.feature；只查入口会误拦合法结构。
  if (phaseId === 'testing') {
    const featuresDir = dirname(filePath)
    if (existsSync(featuresDir)) {
      const featureFiles = readdirSync(featuresDir).filter((f) => f.endsWith('.feature'))
      const hasScenarios = featureFiles.some((f) => {
        try {
          const fc = readFileSync(join(featuresDir, f), 'utf-8')
          return fc.includes('Feature:') && fc.includes('Scenario:')
        } catch {
          return false
        }
      })
      if (!hasScenarios) {
        return '缺少可执行场景：06_TESTS/features/ 下至少一个 .feature 需同时含 Feature: 与 Scenario:（index.feature 可为纯索引，场景允许分布在 us-XX.feature 分文件）'
      }
      // AC I-1（v0.17.65）：占位产物拦截——至少一个 *.steps.json 可 JSON.parse 且解析后
      // feature/scenario 均为非空字符串（与 GwtRunner 执行期 schema 校验闭环；
      // 完整合法性仍由执行期兑底，这里只拦截空占位文件过关）
      const hasValidStepsJson = readdirSync(featuresDir)
        .filter((f) => f.endsWith('.steps.json'))
        .some((f) => {
          try {
            const parsed = JSON.parse(readFileSync(join(featuresDir, f), 'utf-8')) as { feature?: unknown; scenario?: unknown }
            return typeof parsed?.feature === 'string' && parsed.feature.trim() !== ''
              && typeof parsed?.scenario === 'string' && parsed.scenario.trim() !== ''
          } catch {
            return false
          }
        })
      if (!hasValidStepsJson) {
        return '缺少可执行步骤映射：06_TESTS/features/ 下至少需要一个可解析且含非空 feature/scenario 的 *.steps.json（与 us-XX.feature 成对产出；空占位文件不算）'
      }
    }
  }

  // architecture 阶段（W7，v0.17.69）：品类幻觉拦截 + 环境清单规则校验 + envReady 门禁
  // （R4 终裁挂点：拦 architecture→coding（quick）/ architecture→planning（iterative）推进）。
  if (phaseId === 'architecture') {
    const {
      resolveProjectCategoryForCoding,
      extractRawCategoryMarker,
      parseEnvChecklistFromDoc,
      validateEnvChecklist,
    } = require('./nanju-engineering-template') as typeof import('./nanju-engineering-template')
    const { isProjectCategory } = require('./nanju-project') as typeof import('./nanju-project')

    // R2 第 1 道：品类标记值校验（宽松提取——枚举限定正则看不见非法值）。
    // 未标注不是错误（web-default 降级）；标注了但值非法 = 品类幻觉，拦。
    const rawMarker = extractRawCategoryMarker(content)
    if (rawMarker !== null && !isProjectCategory(rawMarker.toLowerCase())) {
      return `架构文档品类标记非法：projectCategory: ${rawMarker}（合法值为 web-fullstack / api-backend / mobile-app / desktop-app / cli-tool / ai-application 六选一）`
    }

    // resolved 品类（W3 口径：existing ?? architecture/prd 提取 ?? web-default）。
    // web-fullstack 免环境门禁（W7 v3 §6.1）；其余品类校验 envReady。
    const existing = getProjectCategory(workspaceSlug, projectId)
    const resolved = existing ?? resolveProjectCategoryForCoding(workspaceSlug, projectId)
      ?? { category: 'web-fullstack' as const, source: 'default' as const }
    if (resolved.category !== 'web-fullstack') {
      const { envReady, missingComponents } = getProjectEnvState(workspaceSlug, projectId)
      if (envReady === false) {
        // 显式未就绪：拦截（缺失组件清单可见化）
        const missing = missingComponents.length > 0 ? missingComponents.join('、') : '未知组件'
        return `环境未就绪（${missing}）：请先完成工程环境配置（回到架构师环节执行安装/调通，或与用户确认换技术栈/降级）`
      }
      if (envReady === undefined) {
        // 存量豁免（R8 禁裸 !==true）：envReady 字段缺失 = 未检查，不误拦。
        // S4 后续可改补探测（首次推进时补一次最小探测置位）。
        // envReady 由 agent-orchestrator 在本验证前解析 projectEnv 标记行置位
        //（write-then-gate）；新流程项目若 L2 未输出标记行，也走此豁免（低敏感度）。
      } else {
        // envReady === true：环境清单规则校验（R2 第 2 道——已就绪但清单含 typo/幻觉
        // 组件时拦下，防 LLM 幻觉包名进入安装阶段）
        const checklist = parseEnvChecklistFromDoc(content)
        const validation = validateEnvChecklist(resolved.category, checklist)
        if (!validation.ok) {
          return `环境配置清单校验未通过：${validation.problems.join('；')}`
        }
      }
    }
  }

  // 仅 coding：入口 HTML 引用的 08_APP 内相对资源必须存在（多文件产出完整性兜底——
  // 写了 index.html 忘了 js/css 时在推进前拦下）。校验失败时 PHASE_ADVANCE 不推进，
  // 由 orchestrator 向会话注入 assistant 消息做可见化提示（见 agent-orchestrator.ts），
  // 不自动 retry；harness 级 retry 接线属 Sprint B（handlePhaseResult 当前无调用点）。
  // 纯 Harness 代码，符合 v2.3 §9 职责边界。排除带 scheme（http/data/mailto/tel/blob/
  // javascript 等通用形态）、协议相对（//cdn）、锚点（#）与根绝对路径（/，加载失败
  // 由预览自然暴露）；双引号/单引号属性均识别。
  if (phaseId === 'coding') {
    const refs = [...content.matchAll(/(?:src|href)=(?:"(?!https?:|data:|#|\/\/|[a-zA-Z][a-zA-Z0-9+.-]*:)([^"]+)"|'(?!https?:|data:|#|\/\/|[a-zA-Z][a-zA-Z0-9+.-]*:)([^']+)')/g)]
      .map((m) => m[1] ?? m[2] ?? '')
    for (const ref of refs) {
      if (!ref) continue
      // 先剥 hash 再剥 query；剥完为空回退原始串；非法百分号编码降级为原始串不抛
      let refPath: string
      try {
        refPath = decodeURIComponent((ref.split('#')[0] ?? '').split('?')[0] || ref)
      } catch {
        refPath = ref
      }
      if (refPath.startsWith('/')) continue
      const resolved = resolve(dirname(filePath), refPath)
      if (!resolved.startsWith(dirname(filePath) + sep)) {
        return '入口文件引用越出 08_APP 目录：' + ref
      }
      if (!existsSync(resolved)) {
        return `入口文件引用的资源不存在：${ref}`
      }
    }
  }

  return null
}

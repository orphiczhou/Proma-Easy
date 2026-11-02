/**
 * 南大向导 → Tree V10 指挥官树自动衔接服务（NEXT-02，蓝图 §三；R3 返工 2026-11-03）
 *
 * 当向导项目（quick：prototype 确认后；iterative：planning 确认后）推进到
 * currentStage === 'coding' 时，自动初始化 mcp__tree__ 任务树、注入前序阶段
 * 产出的 PRD/原型/架构文档契约，并注册异构模型的 Worker 与 Auditor 节点，
 * 返回可直接下发给指挥官会话的 commanderBootstrapPrompt。
 *
 * 树结构（R1 返工：三层，消除背书死锁）：
 *   treeId-root            (role=root,     session=调度员会话, 信任锚)
 *   └─ treeId-C-commander  (role=commander, session=新建, added_by=调度员会话)
 *      ├─ treeId-A-worker  (role=worker,    added_by=C 的会话)   ← 编码执行者
 *      └─ treeId-B-worker  (role=worker,    added_by=C 的会话)   ← 独立审计员（auditor 语义）
 *
 *   死锁根因（R3 审查实测）：若 A/B 直接由 root 添加（added_by=root session），
 *   resolveAuditorIndep 的 `auditor=added_by (self-audit forbidden)` 使 root 永远
 *   无法背书 A/B；而 A/B 互相背书又要求背书者自身先被背书 → 死循环。
 *   三层结构下 A/B 的 added_by=C 的会话，背书链 root（自审放行，信任锚）→
 *   root 背书 B → B 背书 A 全程畅通。
 *   该结构同时覆盖 quick（本次三层）与 iterative（同构扩展，C 下可再挂子 commander
 *   至三层上限，见 LEAF_NAME_RE path 段 A/B/C…），无需按模式分叉。
 *
 * 现实校验结论（相对蓝图伪代码的适配，详见各函数注释）：
 * - tree-engine.cjs 真实导出 run(cmd, args, treesRoot?, callerSessionId?)，
 *   返回 {ok:true,...} / {ok:false, error:{code,msg}}；dispatch 接口与 CLI 一致。
 * - LEAF_NAME_RE 为完整 leaf_id 格式 ^([a-z][a-z0-9_]{3,7})-(?:([A-Z]\d*(?:[a-z]\d*)*)?-)?(\w+)(?:-(s\d+|i\d+))?$
 *   ——tree_id 必须满足 prefix 段约束 [a-z][a-z0-9_]{3,7}（4~8 字符），
 *   因为 root leaf_id = `${tree_id}-root` 也要通过同一正则。
 * - ROLE_ENUM = ['root','commander','worker']（无 'auditor'）——审计节点以
 *   role='worker' 注册（leaf_id 后缀 -B-worker 表意 auditor 语义）。
 * - leaf add 强校验 session_id/added_by 必须是合法 UUID（UUID_RE）。
 * - audit_gate pass 前置（cmdAuditGate A5/A7/V5b）：被审叶自身 done event（caller=
 *   叶 owner，self_check 非空且 ≥1 pass）+ worker 叶须有带 alignment 的 brief_echo
 *   （alignment 由独立 auditor 评估回填）；auditor 须是树中活跃叶且自身 done+pass。
 * - TelemetryEventType 本轮已扩 'tree.bootstrap'（R3 返工授权）。
 * - createAgentSession(title?, channelId?, workspaceId?, modelId?) 同步返回
 *   AgentSessionMeta（id 为 randomUUID，满足 UUID_RE）；deleteAgentSession(id)
 *   真实存在（孤儿会话止损用）。
 */

import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { getAgentWorkspacePath } from './config-paths'
import { createAgentSession, deleteAgentSession } from './agent-session-manager'
import { listChannels } from './channel-manager'
import { getNanjuProjectDir, updateNanjuProject, type NanjuProject } from './nanju-project'
import { recordTelemetry } from './nanju-telemetry'
import type { Channel, ChannelModel } from '@proma/shared'

// ===== tree-engine 接口（require CJS 引擎，与 tree-mcp-tools.ts 同型） =====

interface TreeEngineResult {
  ok: boolean
  error?: { code?: string; msg?: string; help_topic?: string }
  [key: string]: unknown
}

interface TreeEngineLike {
  run(cmd: string, args: string[], treesRoot?: string, callerSessionId?: string): Promise<TreeEngineResult>
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const treeEngine: TreeEngineLike = require('./tree-engine.cjs')

/** 引擎单次调用兜底超时：树锁最长等待 10s，3s 超时降级防拖慢 coding 续接（绿-3） */
const ENGINE_CALL_TIMEOUT_MS = 3_000

// ===== 依赖注入（生产默认真实现；测试注入 stub 隔离 /tmp） =====

/** 会话创建工厂：返回含合法 UUID id 的会话元信息 */
export interface CreatedSessionRef {
  id: string
}

export interface CodingTreeBridgeDeps {
  /** tree-engine 执行入口（默认真引擎；测试可替换记录调用序列） */
  engine: TreeEngineLike
  /** 创建 Agent 会话（默认 agent-session-manager.createAgentSession） */
  createSession: (title: string, channelId: string | undefined, workspaceId: string | undefined, modelId: string | undefined) => CreatedSessionRef
  /** 删除 Agent 会话（孤儿会话止损，默认 agent-session-manager.deleteAgentSession） */
  deleteSession: (id: string) => void
  /** 读取可用渠道（默认 channel-manager.listChannels） */
  getChannels: () => Channel[]
  /** 埋点（默认 nanju-telemetry.recordTelemetry） */
  telemetry: (workspaceSlug: string, eventType: 'tree.bootstrap', payload: Record<string, unknown>, projectId?: string) => unknown
  /** 项目字段回写（默认 nanju-project.updateNanjuProject） */
  updateProject: (workspaceSlug: string, projectId: string, updates: Partial<NanjuProject>) => NanjuProject | null
}

const defaultDeps: CodingTreeBridgeDeps = {
  engine: treeEngine,
  createSession: (title, channelId, workspaceId, modelId) => createAgentSession(title, channelId, workspaceId, modelId),
  deleteSession: (id) => deleteAgentSession(id),
  getChannels: () => listChannels(),
  telemetry: (workspaceSlug, eventType, payload, projectId) => recordTelemetry(workspaceSlug, eventType, payload, projectId),
  updateProject: (workspaceSlug, projectId, updates) => updateNanjuProject(workspaceSlug, projectId, updates),
}

// ===== 输入 / 输出契约 =====

export interface CodingTreeBootstrapInput {
  workspaceSlug: string
  /** 会话归属工作区 id（可缺省：未传则建全局会话） */
  workspaceId?: string
  project: NanjuProject
  /** 调度员（即将成为 root 指挥官）会话 ID */
  commanderSessionId: string
  /** 调度员会话真实渠道/模型（绿-4：root 叶元信息尽力填真值；不可得则不传） */
  commanderChannelId?: string
  commanderModelId?: string
  /** 覆盖 trees 目录（生产不传：落工作区 .context/trees；测试传 /tmp 隔离） */
  treesDirOverride?: string
  /** 依赖注入（生产不传） */
  deps?: Partial<CodingTreeBridgeDeps>
}

export interface CodingTreeBootstrapResult {
  ok: boolean
  /** 幂等续用（此前已 bootstrap 过，含部分失败后补齐自愈）时为 true */
  idempotent?: boolean
  treeId: string
  rootLeafId: string
  /** 子指挥官叶（C 层，A/B 的 parent 与 added_by） */
  commanderLeafId: string
  commanderSessionId: string
  workerLeafId: string
  workerSessionId: string
  auditorLeafId: string
  auditorSessionId: string
  /** 直接可下发指挥官会话的启动契约（失败时为空串） */
  commanderBootstrapPrompt: string
  error?: string
}

/** tree-state.json 中 bootstrap 关心的字段子集（幂等/补缺核对用） */
interface TreeStateSnapshot {
  tree_id?: string
  root_brief?: { project_id?: string } & Record<string, unknown>
  leaves?: Record<string, { leaf_id?: string; session_id?: string; role?: string } & Record<string, unknown>>
  communication_log?: Array<Record<string, unknown>>
}

/** 树结构描述：三层四叶的会话提取结果 */
interface TreeStructureSessions {
  root?: string
  commander?: string
  worker?: string
  auditor?: string
  /** 四叶齐全 */
  complete: boolean
}

// ===== 1. tree_id 生成（R2：确定性短哈希，CJK 不塌缩） =====

/**
 * 将 projectId 映射为合法 tree_id：`nj` + sha1(projectId) hex 前 5 位（恒 7 字符）。
 *
 * 真实约束（tree-engine.cjs LEAF_NAME_RE prefix 段）：[a-z][a-z0-9_]{3,7}（4~8 字符）。
 * R2 返工根因：旧实现取 projectId 小写清洗前 5 位，中文项目名（记账小工具/作品集/
 * 记账/待办…）清洗后全空 → 全部塌缩为 nj0000，第二个中文项目永久建不出树。
 * sha1 短哈希对任意 Unicode 输入确定性散列：同项目幂等稳定、异项目（含中文）互不碰撞；
 * hex 字符集 [0-9a-f] 天然落入 prefix 段合法域，无需二次清洗。
 */
export function toValidTreeId(projectId: string): string {
  const hash = createHash('sha1').update(projectId, 'utf-8').digest('hex')
  return `nj${hash.slice(0, 5)}`
}

// ===== 2. 前序产出文档收集 =====

/** 向导前序阶段的标准产出目录（蓝图 §3.1 第 2 步） */
const UPSTREAM_DOC_DIRS = ['01_PRD', '02_UX_DESIGN', '03_ARCHITECTURE', '04_API_SPEC', '05_PROJECT_PLAN'] as const

/**
 * 扫描项目目录下前序阶段产出文档（非隐藏文件），返回相对项目根的路径清单。
 * 蓝图伪代码手工拼 `project-${projectId}` 路径；真实代码复用
 * nanju-project.getNanjuProjectDir（同一实现，单一来源）。
 */
export function collectProjectArtifacts(workspaceSlug: string, projectId: string): string[] {
  const projectDir = getNanjuProjectDir(workspaceSlug, projectId)
  if (!fs.existsSync(projectDir)) return []
  const found: string[] = []
  for (const sub of UPSTREAM_DOC_DIRS) {
    const subPath = path.join(projectDir, sub)
    if (!fs.existsSync(subPath)) continue
    try {
      const files = fs.readdirSync(subPath).filter((f) => !f.startsWith('.')).sort()
      for (const f of files) found.push(`project-${projectId}/${sub}/${f}`)
    } catch {
      /* 读取失败（权限/瞬态）忽略该目录 */
    }
  }
  return found
}

// ===== 3. 异构模型选择（全部动态来自 enabled 渠道，禁止硬编码渠道 id） =====

export interface ModelSelection {
  workerChannelId: string | undefined
  workerModelId: string | undefined
  auditorChannelId: string | undefined
  auditorModelId: string | undefined
  /** true = 找不到异构渠道/模型，auditor 与 worker 同渠道同模型（降级） */
  degraded: boolean
  note: string
}

function enabledModelsOf(channel: Channel): ChannelModel[] {
  return (channel.models ?? []).filter((m) => m.enabled)
}

/**
 * 从 enabled 渠道动态选择主编码模型（Worker：GLM-5.3 级 SOTA 优先）与
 * 异构审计模型（Auditor：deepseek 系优先，其次任何非 worker 渠道的 flash 级）。
 *
 * 相对蓝图伪代码的差异：
 * - 蓝图在无匹配时硬编码 fallback 'glm-5.3' / 'deepseek-v4-flash'——真实环境
 *   渠道 id 不保证存在，硬编码会让 leaf 注册进不可用模型。本实现无匹配时
 *   返回 undefined（会话层落到全局默认渠道），更安全。
 * - 蓝图 `m.enabled !== false` ——真实 ChannelModel.enabled 是必填 boolean，
 *   直接按真值过滤。
 */
export function selectHeterogeneousModels(channels: Channel[]): ModelSelection {
  const usable = channels.filter((c) => c.enabled && enabledModelsOf(c).length > 0)
  if (usable.length === 0) {
    return {
      workerChannelId: undefined, workerModelId: undefined,
      auditorChannelId: undefined, auditorModelId: undefined,
      degraded: true,
      note: '无可用渠道（enabled 且含启用模型）——会话将使用全局默认渠道',
    }
  }

  // Worker：GLM-5.x 主力优先（多渠道 SOTA 主导策略），其次 deepseek 非 flash，最后任一启用模型
  let workerChannelId: string | undefined
  let workerModelId: string | undefined
  for (const ch of usable) {
    const glm = enabledModelsOf(ch).find((m) => /^glm-5/i.test(m.id))
    if (glm) {
      workerChannelId = ch.id
      workerModelId = glm.id
      break
    }
  }
  if (!workerModelId) {
    for (const ch of usable) {
      const ds = enabledModelsOf(ch).find((m) => /deepseek/i.test(m.id) && !/flash/i.test(m.id))
      if (ds) {
        workerChannelId = ch.id
        workerModelId = ds.id
        break
      }
    }
  }
  if (!workerModelId) {
    const first = usable[0]
    const firstModel = first ? enabledModelsOf(first)[0] : undefined
    if (first && firstModel) {
      workerChannelId = first.id
      workerModelId = firstModel.id
    }
  }

  // Auditor：异构（与 worker 不同渠道）优先 deepseek flash → 任意异构 flash → 异构任意 → 同渠道异模型 → 同模型（降级）
  const heteroChannels = usable.filter((c) => c.id !== workerChannelId)
  let auditorChannelId: string | undefined
  let auditorModelId: string | undefined
  let degraded = false
  let note = '异构双模型（worker/auditor 跨渠道）'

  for (const ch of heteroChannels) {
    const dsFlash = enabledModelsOf(ch).find((m) => /deepseek.*flash|flash.*deepseek/i.test(m.id))
    if (dsFlash) {
      auditorChannelId = ch.id
      auditorModelId = dsFlash.id
      break
    }
  }
  if (!auditorModelId) {
    for (const ch of heteroChannels) {
      const flash = enabledModelsOf(ch).find((m) => /flash/i.test(m.id))
      if (flash) {
        auditorChannelId = ch.id
        auditorModelId = flash.id
        break
      }
    }
  }
  if (!auditorModelId) {
    const ch = heteroChannels[0]
    const model = ch ? enabledModelsOf(ch)[0] : undefined
    if (ch && model) {
      auditorChannelId = ch.id
      auditorModelId = model.id
    }
  }
  if (!auditorModelId) {
    // 降级一：同渠道不同模型
    const workerChannel = usable.find((c) => c.id === workerChannelId)
    const otherModel = workerChannel ? enabledModelsOf(workerChannel).find((m) => m.id !== workerModelId) : undefined
    if (otherModel && workerChannel) {
      auditorChannelId = workerChannel.id
      auditorModelId = otherModel.id
      degraded = true
      note = '仅单渠道可用：auditor 降级为同渠道不同模型（异构性受限）'
    } else {
      // 降级二：与 worker 同模型（最后手段）
      auditorChannelId = workerChannelId
      auditorModelId = workerModelId
      degraded = true
      note = '仅单渠道单模型可用：auditor 与 worker 同模型（丧失异构交叉审查能力）'
    }
  }

  return { workerChannelId, workerModelId, auditorChannelId, auditorModelId, degraded, note }
}

// ===== 4. trees 目录定位与树状态读取 =====

/**
 * trees 目录定位（与 tree-mcp-tools.findTreesDir 第一候选一致）。
 * 该三层结构同时服务 quick 与 iterative 两模式（黄-6）：iterative 需要更深的
 * 子树时由 C-commander 在树内继续派生，bootstrap 不按模式分叉。
 */
function resolveTreesDir(workspaceSlug: string, override?: string): string {
  if (override) {
    fs.mkdirSync(override, { recursive: true })
    return override
  }
  const treesDir = path.join(getAgentWorkspacePath(workspaceSlug), 'workspace-files', '.context', 'trees')
  fs.mkdirSync(treesDir, { recursive: true })
  return treesDir
}

/** 读取 tree-state.json 快照（幂等/补缺核对；文件缺失/损坏返回 null） */
function readTreeState(treesDir: string, treeId: string): TreeStateSnapshot | null {
  try {
    const statePath = path.join(treesDir, treeId, 'tree-state.json')
    if (!fs.existsSync(statePath)) return null
    return JSON.parse(fs.readFileSync(statePath, 'utf-8')) as TreeStateSnapshot
  } catch {
    return null
  }
}

/** 从树状态提取三层四叶会话（root / C-commander / A-worker / B-worker） */
function extractStructureSessions(state: TreeStateSnapshot, treeId: string): TreeStructureSessions {
  const root = state.leaves?.[`${treeId}-root`]?.session_id
  const commander = state.leaves?.[`${treeId}-C-commander`]?.session_id
  const worker = state.leaves?.[`${treeId}-A-worker`]?.session_id
  const auditorLeaf = state.leaves?.[`${treeId}-B-worker`]
  const auditor = auditorLeaf?.session_id
  const sessions: string[] = [root, commander, worker, auditor].filter((s): s is string => typeof s === 'string' && s !== '')
  // 四叶 session 互不重复（引擎 session 唯一性语义）且齐全才算完整
  const complete = sessions.length === 4 && new Set(sessions).size === 4
  return { root, commander, worker, auditor, complete }
}

// ===== 5. 引擎调用封装（绿-3：单次调用 3s 超时） =====

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`E_ENGINE_TIMEOUT: ${what} 超过 ${ms}ms（树锁等待或引擎卡滞）`)), ms)
    }),
  ])
}

async function engineRun(
  deps: CodingTreeBridgeDeps,
  treesDir: string,
  cmd: string,
  args: string[],
  callerSessionId: string,
): Promise<TreeEngineResult> {
  return withTimeout(deps.engine.run(cmd, args, treesDir, callerSessionId), ENGINE_CALL_TIMEOUT_MS, `${cmd} ${args[0] ?? ''}`)
}

// ===== 6. root_brief / root_dod 组装 =====

/**
 * 组装 root_brief：向导上游产物清单 + 项目意图（蓝图 §3.1 第 2 步）。
 * 单独导出便于测试断言。
 */
export function buildRootBrief(project: NanjuProject, artifacts: string[]): Record<string, unknown> {
  return {
    parent_intent: `完成南大向导项目「${project.name}」（模式: ${project.mode}）的代码实现与 GWT 自动化验收`,
    project_id: project.projectId,
    upstream_artifacts: artifacts,
  }
}

/**
 * 组装 root_dod：交付物 + 节点预算 + 验收标准（蓝图 §3.1 第 2 步）。
 * node_budget 必须是非负有限数（tree-engine v0.7 批次5 校验）；
 * quick=6 容纳三层四叶（root + C-commander + A-worker + B-worker = 4）仍有余量。
 */
export function buildRootDod(project: NanjuProject): Record<string, unknown> {
  return {
    deliverables: [`project-${project.projectId}/06_TESTS/gwt-report.json`, `project-${project.projectId}/08_APP/`],
    node_budget: project.mode === 'quick' ? 6 : 12,
    accept_criteria: ['核心功能代码落盘', 'GWT 自动化验收通过', '异构 Auditor 独立审查通过'],
  }
}

// ===== 7. 主流程 =====

/**
 * 为进入 coding 阶段的向导项目自动装配三层指挥官树（蓝图 §3.1 全流程 + R3 返工）。
 *
 * 幂等/自愈语义（R3 返工）：
 * 1. project.treeId 已设置且四叶完整、root 绑定当前调度员 → 幂等成功；
 * 2. 树存在（init E_DUPLICATE_LEAF 或 treeId 已登记）且 root_brief.project_id
 *    匹配 → 「补缺」而非拒绝：缺失的叶子补建会话并 leaf add，已有叶子读回复用
 *    其 session_id（含 leaf add 撞 E_DUPLICATE_LEAF 的读回复用，黄-1）；
 *    root 绑定漂移（回滚/会话重建）→ leaf set-session 重绑（黄-4）；
 * 3. 仅 project_id 不匹配（异项目树，R2 哈希化后概率性碰撞防御）→ 拒绝误绑。
 *
 * 失败语义：任何异常/引擎错误都收敛为 {ok:false,error}，绝不抛出；leaf add 失败
 * 时对已创建的孤儿会话止损（删除 + 埋点记录，黄-2）；整体调用 3s 级超时保护
 * （绿-3，引擎在后台可能继续完成，下次进入走幂等续用）。
 */
export async function bootstrapCodingTreeForProject(
  input: CodingTreeBootstrapInput,
): Promise<CodingTreeBootstrapResult> {
  const { workspaceSlug, workspaceId, project, commanderSessionId } = input
  const deps: CodingTreeBridgeDeps = { ...defaultDeps, ...input.deps }
  const treeId = toValidTreeId(project.projectId)
  const rootLeafId = `${treeId}-root`
  const commanderLeafId = `${treeId}-C-commander`
  const workerLeafId = `${treeId}-A-worker`
  const auditorLeafId = `${treeId}-B-worker`
  const base: Omit<CodingTreeBootstrapResult, 'ok' | 'commanderBootstrapPrompt'> = {
    treeId, rootLeafId, commanderLeafId, commanderSessionId: '',
    workerLeafId, workerSessionId: '', auditorLeafId, auditorSessionId: '',
  }

  let treesDir: string
  try {
    treesDir = resolveTreesDir(workspaceSlug, input.treesDirOverride)
  } catch (err) {
    return { ...base, ok: false, commanderBootstrapPrompt: '', error: `trees 目录创建失败: ${describeErr(err)}` }
  }

  // 本次调用创建的会话（部分失败时止损删除，黄-2）
  const createdSessions: string[] = []

  try {
    const artifacts = collectProjectArtifacts(workspaceSlug, project.projectId)
    const selection = selectHeterogeneousModels(deps.getChannels())

    // —— 幂等/补缺：树已存在且属于本项目 ——
    //（F-4：历史登记 project.treeId 与派生值不一致时以派生值为准，回写由
    //  finishBootstrap 统一承载，此处无需分支）
    {
      const state = readTreeState(treesDir, treeId)
      if (state && state.root_brief?.project_id === project.projectId) {
        const structure = extractStructureSessions(state, treeId)
        // F-2：root 漂移重绑与四叶完整性解耦——「树不完整 × 指挥官会话漂移」
        // 组合态同样重绑（此前重绑嵌在 complete 分支内，补缺路径漏绑导致
        // 旧指挥官永远拥有 root 写权）。条件：root 叶存在且绑定非当前指挥官。
        if (structure.root && structure.root !== commanderSessionId) {
          const rebind = await engineRun(deps, treesDir, 'leaf', ['set-session', treeId, rootLeafId, commanderSessionId], commanderSessionId)
          if (!rebind.ok) {
            return { ...base, ok: false, commanderBootstrapPrompt: '', error: `root 会话重绑失败（leaf set-session）: ${JSON.stringify(rebind.error)}` }
          }
          console.warn(`[南大树桥] root 会话漂移（${structure.root} → ${commanderSessionId}），已重绑`)
        }
        if (structure.complete) {
          const result: CodingTreeBootstrapResult = {
            ok: true, idempotent: true, treeId, rootLeafId,
            commanderLeafId, commanderSessionId: structure.commander ?? '',
            workerLeafId, workerSessionId: structure.worker ?? '',
            auditorLeafId, auditorSessionId: structure.auditor ?? '',
            commanderBootstrapPrompt: '',
          }
          await finishBootstrap(deps, workspaceSlug, project, treeId, result, artifacts, selection, true)
          return result
        }
        // 树存在但四叶不全 → 落入下方补缺路径（R3），不再拒绝
      } else if (state && state.root_brief?.project_id !== project.projectId) {
        return {
          ...base, ok: false, commanderBootstrapPrompt: '',
          error: `tree "${treeId}" 已存在但属于异项目（project_id=${String(state.root_brief?.project_id)}），拒绝误绑`,
        }
      }
    }

    // —— 1. 建树并绑定调度员会话为 root（绿-4：root 元信息尽力填真实渠道/模型） ——
    const initRes = await engineRun(
      deps, treesDir, 'init',
      [
        treeId,
        '--root-brief', JSON.stringify(buildRootBrief(project, artifacts)),
        '--root-dod', JSON.stringify(buildRootDod(project)),
        '--session-id', commanderSessionId,
        '--model', input.commanderModelId ?? selection.workerModelId ?? 'unknown',
        '--channel', input.commanderChannelId ?? selection.workerChannelId ?? 'unknown',
      ],
      commanderSessionId,
    )
    if (!initRes.ok && initRes.error?.code !== 'E_DUPLICATE_LEAF') {
      return { ...base, ok: false, commanderBootstrapPrompt: '', error: `tree init 失败: ${JSON.stringify(initRes.error)}` }
    }
    // E_DUPLICATE_LEAF：树已存在——project_id 已在上文核对（异项目已拒绝），走补缺

    // —— 2. 补缺/新建：C-commander 叶（A/B 的 parent 与 added_by，R1 三层结构） ——
    let state = readTreeState(treesDir, treeId)
    let structure: TreeStructureSessions = state ? extractStructureSessions(state, treeId) : { root: undefined, commander: undefined, worker: undefined, auditor: undefined, complete: false }
    let commanderSession = structure.commander
    if (!commanderSession) {
      const cSession = deps.createSession(
        `[Tree Commander] ${project.name}`,
        input.commanderChannelId ?? selection.workerChannelId,
        workspaceId || undefined,
        input.commanderModelId ?? selection.workerModelId,
      )
      createdSessions.push(cSession.id)
      const addC = await engineRun(deps, treesDir, 'leaf', [
        'add', treeId,
        '--json', JSON.stringify({
          leaf_id: commanderLeafId,
          session_id: cSession.id,
          parent: rootLeafId,
          path: 'C',
          role: 'commander',
          model: input.commanderModelId ?? selection.workerModelId ?? 'unknown',
          channel: input.commanderChannelId ?? selection.workerChannelId ?? 'unknown',
          added_by: commanderSessionId,
        }),
      ], commanderSessionId)
      if (!addC.ok && addC.error?.code !== 'E_DUPLICATE_LEAF') {
        return await failWithOrphanCleanup(deps, workspaceSlug, project, base, createdSessions, `leaf add 失败（${commanderLeafId}）: ${JSON.stringify(addC.error)}`, treesDir)
      }
      if (!addC.ok) {
        // E_DUPLICATE_LEAF：C 叶已在树中（并发/部分失败残留）→ 读回复用（黄-1）
        state = readTreeState(treesDir, treeId)
        commanderSession = state?.leaves?.[commanderLeafId]?.session_id ?? undefined
        if (!commanderSession) {
          return await failWithOrphanCleanup(deps, workspaceSlug, project, base, createdSessions, `leaf add E_DUPLICATE_LEAF 但树内读不到 ${commanderLeafId} 的 session（状态损坏）`, treesDir)
        }
        console.warn(`[南大树桥] ${commanderLeafId} 已存在，读回复用 session=${commanderSession}`)
      } else {
        commanderSession = cSession.id
      }
    }

    // —— 3. A-worker / B-worker 叶（added_by 用 C 会话，R1；缺失补建，R3） ——
    const workerSpecs = [
      { leafId: workerLeafId, pathSeg: 'A', channel: selection.workerChannelId, model: selection.workerModelId, title: `[Tree Worker] ${project.name}` },
      { leafId: auditorLeafId, pathSeg: 'B', channel: selection.auditorChannelId, model: selection.auditorModelId, title: `[Tree Auditor] ${project.name}` },
    ]
    let workerSession = structure.worker
    let auditorSession = structure.auditor
    for (const spec of workerSpecs) {
      const existing = spec.leafId === workerLeafId ? workerSession : auditorSession
      if (existing) continue // R3 补缺：已有叶子读回复用，不重复建会话
      const session = deps.createSession(spec.title, spec.channel, workspaceId || undefined, spec.model)
      createdSessions.push(session.id)
      const addRes = await engineRun(deps, treesDir, 'leaf', [
        'add', treeId,
        '--json', JSON.stringify({
          leaf_id: spec.leafId,
          session_id: session.id,
          parent: commanderLeafId,
          path: spec.pathSeg,
          role: 'worker',
          model: spec.model ?? 'unknown',
          channel: spec.channel ?? 'unknown',
          added_by: commanderSession, // R1：per-leaf 值 = C 会话 id（非 root 调度员）
        }),
      ], commanderSession)
      if (!addRes.ok && addRes.error?.code !== 'E_DUPLICATE_LEAF') {
        return await failWithOrphanCleanup(deps, workspaceSlug, project, base, createdSessions, `leaf add 失败（${spec.leafId}）: ${JSON.stringify(addRes.error)}`, treesDir)
      }
      if (!addRes.ok) {
        // 黄-1：撞 E_DUPLICATE_LEAF → 读树内已登记 session 复用，丢弃本次新建引用（入止损清单）
        const reuse = readTreeState(treesDir, treeId)?.leaves?.[spec.leafId]?.session_id
        if (!reuse) {
          return await failWithOrphanCleanup(deps, workspaceSlug, project, base, createdSessions, `leaf add E_DUPLICATE_LEAF 但树内读不到 ${spec.leafId} 的 session（状态损坏）`, treesDir)
        }
        console.warn(`[南大树桥] ${spec.leafId} 已存在，读回复用 session=${reuse}（丢弃新建 ${session.id}）`)
        if (spec.leafId === workerLeafId) workerSession = reuse
        else auditorSession = reuse
      } else if (spec.leafId === workerLeafId) {
        workerSession = session.id
      } else {
        auditorSession = session.id
      }
    }

    if (!commanderSession || !workerSession || !auditorSession) {
      // 防御：四叶 session 不齐（理论不可达）
      return await failWithOrphanCleanup(deps, workspaceSlug, project, base, createdSessions, `树结构补齐后 session 仍不完整（C=${String(commanderSession)}, A=${String(workerSession)}, B=${String(auditorSession)}）`, treesDir)
    }

    // —— 4. 首条通信日志（root → C-commander，蓝图 §3.1 第 5 步） ——
    const commRes = await engineRun(deps, treesDir, 'communication', [
      'log', treeId,
      '--from', rootLeafId,
      '--to', commanderLeafId,
      '--summary', `向导进入 coding 阶段，自动装配任务树 ${treeId}（${project.mode} 模式，三层结构 root→C→A/B，上游产物 ${artifacts.length} 份）`,
    ], commanderSessionId)
    if (!commRes.ok) {
      console.warn(`[南大树桥] 首条通信日志写入失败（不阻断 bootstrap）: ${JSON.stringify(commRes.error)}`)
    }

    // —— 5. 未采用会话清理（黄-1 联动）：本次新建但因撞 E_DUPLICATE_LEAF 被读回旧值
    //     取代的会话，不能留在会话列表里变孤儿 —— 删除止损（真实 deleteAgentSession
    //     会同步清理消息文件与 session 工作目录） ——
    const adopted = new Set([commanderSession, workerSession, auditorSession])
    for (const sid of createdSessions) {
      if (adopted.has(sid)) continue
      try {
        deps.deleteSession(sid)
        console.warn(`[南大树桥] 新建会话未被采用（树内已有同叶），已删除止损: ${sid}`)
      } catch (err) {
        console.warn(`[南大树桥] 未采用会话删除失败（id=${sid}）: ${describeErr(err)}`)
      }
    }

    const result: CodingTreeBootstrapResult = {
      ok: true,
      treeId, rootLeafId,
      commanderLeafId, commanderSessionId: commanderSession,
      workerLeafId, workerSessionId: workerSession,
      auditorLeafId, auditorSessionId: auditorSession,
      commanderBootstrapPrompt: '',
    }
    await finishBootstrap(deps, workspaceSlug, project, treeId, result, artifacts, selection, false)
    return result
  } catch (err) {
    // 绿-3 超时不删孤儿会话：后台引擎调用可能仍在排队挂叶，删除会造成树内悬空
    // session；确定性失败才止损删除。超时残留由下次进入的补缺幂等路径收敛。
    const isTimeout = err instanceof Error && err.message.startsWith('E_ENGINE_TIMEOUT')
    if (isTimeout) {
      try {
        deps.telemetry(workspaceSlug, 'tree.bootstrap', {
          kind: 'coding-tree-bootstrap', bootstrap_ok: false,
          tree_id: base.treeId, project_id: project.projectId,
          reason: `bootstrap 异常: ${describeErr(err)}`,
          created_sessions: createdSessions, cleanup: 'deferred', // F-6：超时不删（后台可能仍在挂叶），下次补缺收敛
        }, project.projectId)
      } catch { /* 埋点失败不影响返回 */ }
      return { ...base, ok: false, commanderBootstrapPrompt: '', error: `bootstrap 异常: ${describeErr(err)}` }
    }
    return await failWithOrphanCleanup(deps, workspaceSlug, project, base, createdSessions, `bootstrap 异常: ${describeErr(err)}`, treesDir)
  }
}

/**
 * 失败收尾：孤儿会话止损删除（黄-2 + F-1）+ 降级埋点 + 组装失败结果。
 *
 * F-1 修复：删除前读树状态取已登记 session 集合，只删**不在树内**的会话——
 * 部分失败场景下（如 C 叶已挂树、A 叶 add 失败）已挂树会话若被删，树内将永久
 * 悬空引用。保留的会话记入 kept_sessions（下次重试补缺路径继续复用）。
 */
async function failWithOrphanCleanup(
  deps: CodingTreeBridgeDeps,
  workspaceSlug: string,
  project: NanjuProject,
  base: Omit<CodingTreeBootstrapResult, 'ok' | 'commanderBootstrapPrompt'>,
  createdSessions: string[],
  reason: string,
  treesDir: string,
): Promise<CodingTreeBootstrapResult> {
  // F-1：树内已登记 session 不得删（防悬空引用）
  const state = readTreeState(treesDir, base.treeId)
  const registered = new Set<string>()
  if (state?.leaves) {
    for (const leaf of Object.values(state.leaves)) {
      if (leaf.session_id) registered.add(leaf.session_id)
    }
  }
  const orphans: string[] = []
  const kept: string[] = []
  for (const sid of createdSessions) {
    if (registered.has(sid)) kept.push(sid)
    else orphans.push(sid)
  }
  // 黄-2：未挂树的孤儿会话 → 删除止损（deleteAgentSession 同时清消息文件与工作目录）
  for (const sid of orphans) {
    try {
      deps.deleteSession(sid)
      console.warn(`[南大树桥] 孤儿会话已删除止损: ${sid}`)
    } catch (err) {
      console.warn(`[南大树桥] 孤儿会话删除失败（id=${sid}）: ${describeErr(err)}`)
    }
  }
  if (kept.length > 0) {
    console.warn(`[南大树桥] 已挂树会话保留（防悬空，待下次补缺复用）: ${kept.join(', ')}`)
  }
  try {
    deps.telemetry(workspaceSlug, 'tree.bootstrap', {
      kind: 'coding-tree-bootstrap', bootstrap_ok: false,
      tree_id: base.treeId, project_id: project.projectId,
      reason: reason.slice(0, 500),
      orphan_sessions: orphans,   // 已删除止损
      kept_sessions: kept,        // 已挂树保留（F-1）
    }, project.projectId)
  } catch { /* 埋点失败不影响失败返回 */ }
  return { ...base, ok: false, commanderBootstrapPrompt: '', error: reason }
}

/** 成功收尾：回写 project.treeId + 埋点 + 组装指挥官启动契约（幂等路径同样受益） */
async function finishBootstrap(
  deps: CodingTreeBridgeDeps,
  workspaceSlug: string,
  project: NanjuProject,
  treeId: string,
  result: CodingTreeBootstrapResult,
  artifacts: string[],
  selection: ModelSelection,
  idempotent: boolean,
): Promise<void> {
  // 回写 treeId（NanjuProject.treeId 真实字段；幂等短路依赖它）
  if (project.treeId !== treeId) {
    try {
      deps.updateProject(workspaceSlug, project.projectId, { treeId })
    } catch (err) {
      console.warn(`[南大树桥] treeId 回写失败（不影响本次 bootstrap，下次将走补缺幂等）: ${describeErr(err)}`)
    }
  }

  // 埋点：绿-1 独立事件 'tree.bootstrap'（payload.kind 三态：首建/幂等/补缺）
  try {
    deps.telemetry(workspaceSlug, 'tree.bootstrap', {
      kind: 'coding-tree-bootstrap',
      bootstrap_ok: true,
      idempotent,
      tree_id: treeId,
      project_id: project.projectId,
      mode: project.mode,
      commander_session_id: result.commanderSessionId,
      worker_session_id: result.workerSessionId,
      auditor_session_id: result.auditorSessionId,
      upstream_artifacts: artifacts.length,
      model_selection: { degraded: selection.degraded, note: selection.note },
    }, project.projectId)
  } catch (err) {
    console.warn(`[南大树桥] bootstrap 埋点失败（不阻断）: ${describeErr(err)}`)
  }

  result.commanderBootstrapPrompt = buildCommanderPrompt(
    result, selection, artifacts,
  )
}

/**
 * 指挥官启动契约（蓝图 §3.2 末段 + tree-commander/tree-worker SKILL 标准动作指引
 * + V10 硬约束，黄-3）。单独导出便于测试断言内容完整性。
 *
 * 背书链（R1 三层结构下的标准链路）：root 自审（trust-anchor）→ root 背书 B → B 背书 A。
 */
export function buildCommanderPrompt(
  result: Pick<CodingTreeBootstrapResult, 'treeId' | 'rootLeafId' | 'commanderLeafId' | 'commanderSessionId' | 'workerLeafId' | 'workerSessionId' | 'auditorLeafId' | 'auditorSessionId'>,
  selection: Pick<ModelSelection, 'workerModelId' | 'auditorModelId' | 'degraded'>,
  artifacts: string[],
): string {
  const { treeId } = result
  const lines: string[] = [
    `## 🌳 树形编码阶段已自动就绪（Tree ID: \`${treeId}\`，三层结构 root → C-commander → A/B）`,
    ``,
    `系统已自动初始化 V10 任务树并装配好异构双模型节点：`,
    `- **Root 指挥官（你，信任锚）**：\`${result.rootLeafId}\``,
    `- **子指挥官（C 层，A/B 的 parent）**：\`${result.commanderLeafId}\`（session: \`${result.commanderSessionId}\`）`,
    `- **编码执行者（Worker）**：\`${result.workerLeafId}\`（session: \`${result.workerSessionId}\`，model: \`${selection.workerModelId ?? '默认模型'}\`）`,
    `- **独立审计员（Auditor）**：\`${result.auditorLeafId}\`（session: \`${result.auditorSessionId}\`，model: \`${selection.auditorModelId ?? '默认模型'}${selection.degraded ? '，⚠️ 异构降级' : ''}\`）`,
    `- **前序阶段产出文档**：${artifacts.length > 0 ? artifacts.map((a) => `\`${a}\``).join('、') : '见项目目录'}`,
    ``,
    `### 下一步标准动作（严格遵循 tree-commander / tree-worker SKILL）：`,
    `1. 为 Worker 添加里程碑：\`mcp__tree__tree_milestone_add(tree_id="${treeId}", leaf_id="${result.workerLeafId}", ...)\`（expect_outputs 不能为空，建议用 \`<trees>/${treeId}/deliverables/\` 下路径）`,
    `2. 向 Worker 下发 5 件套契约：\`mcp__session__send_message(session_id="${result.workerSessionId}", ...)\`，随后调用 \`mcp__tree__tree_log_communication\` 留痕`,
    `3. Worker 回报 \`brief_echo\` 后才可判 \`done\`（DbC 硬门禁）；审计维度参考 tree-auditor SKILL §14（C1-C4 + A1/A2）`,
    `4. Worker 声明完成后，派遣独立 Auditor（\`${result.auditorSessionId}\`）交叉验证并签发 \`mcp__tree__tree_audit_gate\``,
    ``,
    `### ⚠️ V10 硬约束（违反将被引擎拦截）：`,
    `1. **root 取信链**：root 叶须先自己写 done 事件（\`tree_event_append type=done\`，self_check 非空且至少一项 pass）→ 引擎自动升级 audit_gate=pass（trust-anchor 自审放行，这是全树唯一允许的自审）`,
    `2. **Auditor 背书前置**：\`${result.auditorLeafId}\` 需经历 brief_echo（alignment + auditor_session_id=root）→ done → 被 root 背书 audit_gate=pass 之后，才有资格背书他人（auditor 自身必须 done + own gate=pass）`,
    `3. **Worker 禁自评**：\`${result.workerLeafId}\` 的 alignment 只能由独立 Auditor（B）在 brief_echo 事件中回填；root/Worker 自评会被 E_ALIGNMENT_NOT_VERIFIED 拒绝`,
    `4. **背书链标准顺序**：root 背书 \`${result.auditorLeafId}\` → \`${result.auditorLeafId}\` 背书 \`${result.workerLeafId}\`（引擎禁止 auditor=added_by，A/B 的 added_by 是 C 会话，故 root 与 B 均有背书资格）`,
    ``,
    `> 工具用法不确定时先调 \`mcp__tree__tree_help(topic)\`；错误返回会自动附 help_topic 引用。`,
  ]
  return lines.join('\n')
}

function describeErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 记录 bootstrap 失败降级（供 orchestrator 接线点调用）：
 * console.warn + telemetry 双通道，绝不抛出。绿-1：使用独立事件 'tree.bootstrap'。
 */
export function recordBootstrapDegradation(
  workspaceSlug: string,
  projectId: string,
  treeId: string,
  reason: string,
): void {
  console.warn(`[南大树桥] coding 树 bootstrap 失败，安全降级为普通会话（treeId=${treeId}）: ${reason}`)
  try {
    recordTelemetry(workspaceSlug, 'tree.bootstrap', {
      kind: 'coding-tree-bootstrap',
      bootstrap_ok: false,
      tree_id: treeId,
      project_id: projectId,
      reason: reason.slice(0, 500),
    }, projectId)
  } catch {
    /* 埋点失败不影响降级路径 */
  }
}

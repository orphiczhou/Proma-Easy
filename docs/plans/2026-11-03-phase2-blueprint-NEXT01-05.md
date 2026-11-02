# Proma-Easy 下一阶段架构设计与实施蓝图（Phase 2：基于 v0.17.132 反馈报告的闭环攻坚）

> **基线依据**：已读取并核验 GitHub `p1-quick-engineering` 分支（Commit `3414ccd`）上的《`docs/architecture-v0.16.45-feedback.md`》验收报告  
> **当前实测基线**：`@proma/electron` **v0.17.132**（全仓 5 包 `typecheck` 0 错误、`m8-integration-test.ts` 9/9 通过、`tree-engine-communication.test.ts` 4/4 通过、`w17-phase-advance-chain.test.ts` 121/121 通过）  
> **本阶段目标版本**：`@proma/electron` **v0.17.133 ~ v0.17.135**  
> **核心任务**：针对反馈报告 **§3.2 待裁决问题** 与 **§3.3 需要下一轮架构指导聚焦的三大核心模块**，给出完整可直接落地的架构设计与代码级规范。

## 一、对上一轮实施反馈（`v0.16.45-feedback.md`）的架构评审结论

### 1.1 已确认收口的能力（予以签字通过 ✅）
1. **口径裁决合理性**：开发 Agent 识别到 `p1-quick-engineering` 分支已演进至 `v0.17.132`，采用「历史里程碑对照验收 + 残留补齐」而非强行覆盖高版本演进代码，工程判断准确。
2. **共享会话层与 `humanOrigin` 防伪断言升级**：抽取 `session-tool-handlers.ts`（336 行）并将源码断言升级为「共享层含 `humanOrigin: false` ∧ 双入口 import 共享层」，既消除了重复代码，又强化了真人来源防伪门禁。
3. **Tree 通信日志与测试隔离**：`tree_log_communication` / `tree_communication_list` 已按 `LEAF_NAME_RE`（`comm*-worker`）落地并通过 26 项断言；`m8-integration-test.ts` 采用 `HOME=/tmp/m8-home` 隔离运行，避免了写坏线上运行实例的 `~/.proma/agent-sessions.json`。

### 1.2 本阶段必须解决的 5 大核心问题（源自反馈报告 §3.1 ~ §3.3）

| 优先级 | 编号 | 问题名称（对应反馈报告章节） | 根因诊断与架构目标 | 主导模型 | 审查模型 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **P0 阻断** | **NEXT-01** | **交付验收时序竞态：10 分钟见证窗口连续 3 轮超窗**（§3.3 第二条 / P1-3） | 静态 10 分钟 TTL 将「GWT 跑测 + 交付询问 + 人类阅读应答」混入同一倒计时。需升级为**「产物内容哈希绑定（Artifact Digest Pinning）+ 人类等待期租约冻结（Lease Freeze）」双阶段时钟状态机** | **GLM-5.3** | **DeepSeek Flash** |
| **P0 阻断** | **NEXT-02** | **多角色向导进入 `coding` 后与 `mcp__tree__*` 指挥官树自动衔接**（§3.3 第一条） | 向导完成规划进入 `coding` 时缺乏自动建树与契约下发桥接器。需设计 **`CodingTreeBootstrapService`**，自动执行 `tree_init` + 5 件套契约装配 + 派生 Commander/Worker/Auditor | **GLM-5.3** | **DeepSeek Flash** |
| **P1 重要** | **NEXT-03** | **权限横幅按单会话渲染导致跨会话审批不可见**（§3.3 第三条 / P1-2） | `PermissionBanner` / `AskUserBanner` 仅渲染当前激活 Tab 的 `sessionId`，后台子会话/树节点阻塞时用户无感知。需设计**全局跨会话待审批聚合横幅（`CrossSessionApprovalBanner`）** | **GLM-5.3** | **DeepSeek Flash** |
| **P1 安全** | **NEXT-04** | **落地 DEFERRED 的 HTTP Bridge 鉴权与 CORS 收敛**（§3.2 第一条） | `agent-mcp-bridge.ts` 仍为 `Access-Control-Allow-Origin: '*'` 且无 Token 校验。需与 `session-tool-handlers.ts` 同批完成本地共享密钥鉴权 | **DeepSeek Flash** | **GLM-5.3** |
| **P2 质量** | **NEXT-05** | **全量 `bun test` 119 fail / 21 errors 历史基线清零治理**（§3.2 第二条） | 环境耦合（`~/.proma` 真实路径、密文解密、快照路径）导致 119 个旧用例失败。需引入统一的 `withIsolatedPromaHome()` 测试夹具分批清零 | **DeepSeek Flash** | **GLM-5.3** |

> **🔴 双模型互审硬约束纠正（针对反馈报告 §3.1 第 2 条偏差）**：  
> 上一轮由 `deepseek-flash` 单会话包办了实现与验证。本阶段涉及**交付门禁时序（NEXT-01）**与**跨会话权限安全（NEXT-03）**，严禁单模型自审！必须由 **GLM-5.3** 负责核心状态机实现（或由 **DeepSeek Flash** 负责确定性补丁），完成后必须通过 `mcp__session__create_session`（或 `remote_create_session`）拉起**另一模型**的独立审计会话，基于源码 diff 与测试输出给出独立 Verdict。

## 二、模块一（NEXT-01）：交付验收链条时序治理——双阶段见证时钟架构设计

### 2.1 为什么实测会“连续 3 轮超窗”？
在当前的交付门禁（Delivery Acceptance / Witness Gate）中，见证记录（Witness Record）采用简单的 `now - witnessAt <= 10 * 60 * 1000`（10 分钟固定窗口）判定新鲜度。然而真实交付链路包含三个串行耗时阶段：
1. **阶段 A（机器重跑 GWT 验收）**：耗时 1~4 分钟；
2. **阶段 B（Agent 汇总报告并发起交付询问 `AskUser`）**：耗时 1~2 分钟；
3. **阶段 C（人类用户查看预览、阅读报告并点击确认）**：耗时完全取决于人类注意力（常在 5~30 分钟以上）。

将人类等待耗时计入机器新鲜度倒计时，必然导致用户点击确认时见证已过期，从而触发“过期 → 重跑 GWT → 再询问 → 再过期”的死循环。

### 2.2 目标架构：产物指纹绑定 + 租约冻结状态机（Digest-Pinned Two-Phase Witness）

新鲜度的本质不是“距离上次跑测过去了多少分钟”，而是**“从上次 GWT 验收通过到现在，工作区代码与交付产物是否发生过任何篡改”**。

```text
[GWT 验收通过 / 见证生成]
   │ 记录: witnessedAt = T0
   │ 计算: artifactDigest = SHA256(关键交付文件 mtime + size + git status/diff 摘要)
   │ 状态: phase = 'EXECUTION_ACTIVE' (机器窗口 TTL = 15 min)
   ▼
[Agent 发起交付询问 / 进入等待真人确认态 (enterHumanWitnessHold)]
   │ 校验: 当前距 T0 <= 15 min 且 computeArtifactDigest() === artifactDigest
   │ 动作: 冻结计时器！状态转为 phase = 'AWAITING_HUMAN_CONFIRM'
   │       设置 humanHoldExpiresAt = now + 24h (允许人类在 24 小时内从容确认)
   ▼
[真人用户回复确认 / 触发 delivered 门禁校验 (verifyWitnessFreshness)]
   ├── 若期间代码/产物被修改 (computeArtifactDigest() !== artifactDigest):
   │     ❌ 立即判定 STALE_ARTIFACT_MODIFIED（哪怕只过了 10 秒也必须重跑 GWT！）
   └── 若产物指纹完全一致 (computeArtifactDigest() === artifactDigest):
         ├── phase === 'AWAITING_HUMAN_CONFIRM' 且 now <= humanHoldExpiresAt ──► ✅ PASS！
         └── phase === 'EXECUTION_ACTIVE' 且 now - witnessedAt <= 15 min     ──► ✅ PASS！
```

### 2.3 代码级实现规范

在项目的交付见证校验模块（管理 10 分钟新鲜度窗口的服务文件，如 `delivery-witness` / `phase-advance` 相关模块）中落地以下核心逻辑：

```typescript
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export interface WitnessRecord {
  projectId: string
  sessionId: string
  witnessedAt: number
  /** 见证生成时的交付目录指纹（防篡改核心锚点） */
  artifactDigest: string
  /** 时钟阶段：机器执行期 vs 人类确认挂起期 */
  clockPhase: 'execution_active' | 'awaiting_human_confirm'
  /** 进入人类确认挂起期的时间戳 */
  holdStartedAt?: number
}

/** 机器自动推进阶段的新鲜度窗口：由 10 分钟放宽至 15 分钟 */
export const MACHINE_WITNESS_TTL_MS = 15 * 60 * 1000
/** 人类确认挂起期的最大有效租约：24 小时（只要产物指纹未变即有效） */
export const HUMAN_HOLD_LEASE_MS = 24 * 60 * 60 * 1000

/**
 * 计算项目交付产物的轻量级确定性指纹（遍历项目目录下非隐藏、非 node_modules 文件的相对路径 + 大小 + mtimeMs）
 */
export function computeProjectArtifactDigest(projectDir: string): string {
  const hash = createHash('sha256')
  if (!existsSync(projectDir)) return hash.digest('hex')

  const entries: string[] = []
  function walk(currentDir: string, depth: number): void {
    if (depth > 5) return
    let names: string[] = []
    try {
      names = readdirSync(currentDir).sort()
    } catch {
      return
    }
    for (const name of names) {
      if (name.startsWith('.') || name === 'node_modules' || name === '_snapshots.json' || name.startsWith('_telemetry')) {
        continue
      }
      const fullPath = join(currentDir, name)
      try {
        const st = statSync(fullPath)
        if (st.isDirectory()) {
          walk(fullPath, depth + 1)
        } else if (st.isFile()) {
          const rel = relative(projectDir, fullPath).replace(/\\/g, '/')
          entries.push(`${rel}:${st.size}:${Math.floor(st.mtimeMs)}`)
        }
      } catch {
        /* ignore transient files */
      }
    }
  }

  walk(projectDir, 0)
  hash.update(entries.join('\n'))
  return hash.digest('hex')
}

/**
 * 当 Agent 完成 GWT 并向用户发起交付确认询问（AskUser / 交付确认）时调用，冻结倒计时。
 */
export function freezeWitnessForHumanConfirmation(
  record: WitnessRecord,
  projectDir: string,
  now = Date.now(),
): { ok: boolean; reason?: string; updated?: WitnessRecord } {
  const currentDigest = computeProjectArtifactDigest(projectDir)
  if (currentDigest !== record.artifactDigest) {
    return {
      ok: false,
      reason: 'E_WITNESS_ARTIFACT_DIRTY: 见证生成后项目文件已被修改，请重新运行 GWT 验收后再发起交付确认。',
    }
  }
  if (now - record.witnessedAt > MACHINE_WITNESS_TTL_MS) {
    return {
      ok: false,
      reason: `E_WITNESS_EXPIRED_BEFORE_ASK: 距上次验收已超过 15 分钟（${Math.round((now - record.witnessedAt) / 1000)}s），请重跑验收。`,
    }
  }
  return {
    ok: true,
    updated: {
      ...record,
      clockPhase: 'awaiting_human_confirm',
      holdStartedAt: now,
    },
  }
}

/**
 * 在最终进入 delivered 阶段门禁时校验见证有效性
 */
export function verifyWitnessFreshness(
  record: WitnessRecord,
  projectDir: string,
  now = Date.now(),
): { valid: boolean; code?: string; message?: string } {
  // 1. 第一优先级硬门禁：检查文件指纹是否被篡改
  const currentDigest = computeProjectArtifactDigest(projectDir)
  if (currentDigest !== record.artifactDigest) {
    return {
      valid: false,
      code: 'E_WITNESS_DIGEST_MISMATCH',
      message: '交付产物在验收后发生了变更，原有见证已失效，请重新执行 GWT 验收。',
    }
  }

  // 2. 若已进入人类确认挂起期，适用 24 小时租约窗口
  if (record.clockPhase === 'awaiting_human_confirm' && record.holdStartedAt) {
    if (now - record.holdStartedAt <= HUMAN_HOLD_LEASE_MS) {
      return { valid: true }
    }
    return {
      valid: false,
      code: 'E_WITNESS_HUMAN_LEASE_EXPIRED',
      message: '人类确认挂起已超过 24 小时，请重新运行一次快速验收确认。',
    }
  }

  // 3. 否则适用 15 分钟机器执行窗口
  if (now - record.witnessedAt <= MACHINE_WITNESS_TTL_MS) {
    return { valid: true }
  }

  return {
    valid: false,
    code: 'E_WITNESS_MACHINE_TTL_EXPIRED',
    message: `见证已超过 15 分钟机器窗口（已过去 ${Math.round((now - record.witnessedAt) / 1000)}s），请重跑 GWT 或在发起询问时调用 freezeWitnessForHumanConfirmation。`,
  }
}
```

## 三、模块二（NEXT-02）：多角色向导进入 `coding` 后与 `mcp__tree__*` 指挥官树自动衔接

### 3.1 架构设计（Coding-to-Tree Auto-Handoff）

当向导项目（无论是 `quick` 模式在 `prototype` 确认后，还是 `iterative` 模式在 `planning` 确认后）推进到 `currentStage === 'coding'` 时，不应只创建一个孤立的普通会话，而应由 **`CodingTreeBootstrapService`** 自动完成「向导产物 → 树形执行体系（`mcp__tree__*`）」的无感交接：

```text
[向导阶段推进至 currentStage === 'coding']
       │
       ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ CodingTreeBootstrapService.bootstrapCodingTree(input)                   │
│                                                                         │
│ 1. 生成合法 tree_id:                                                    │
│    prefix = `nj${projectId.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 6)}`│
│    (严格满足 tree-engine 的 /^[a-z][a-z0-9_]{3,7}$/ 命名约束！)           │
│                                                                         │
│ 2. 自动扫描项目前序产出文档 (01_PRD / 02_UX_DESIGN / 03_ARCHITECTURE):  │
│    组装 root_brief 与 root_dod (含 deliverables 列表与 GWT 验收要求)    │
│                                                                         │
│ 3. 创建根指挥官会话 (Root Commander Session):                           │
│    - 模型路由：优先使用 GLM-5.3（主架构/指挥官）                         │
│    - 调用 treeEngine.run('init', [treeId, '--root-brief', ...,          │
│      '--session-id', rootSessionId]) 自动建树并绑定 Root Session         │
│                                                                         │
│ 4. 根据项目模式自动装配树结构:                                          │
│    - quick 模式（轻量 2 节点树）：                                       │
│      Root Commander (`${treeId}-root`)                                  │
│        ├── Worker (`${treeId}-A-worker`, 模型: deepseek-v4-flash)       │
│        └── Auditor (`${treeId}-B-auditor`, 模型: 异构模型交叉审查)       │
│    - iterative 模式（标准 3 层树）：                                     │
│      Root (`${treeId}-root`) → 子指挥官 (`${treeId}-A-commander`)        │
│        → Worker + 独立 Auditor                                          │
│                                                                         │
│ 5. 自动记录首条通信日志 (`communication log`) 并向 Root 发送启动契约     │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.2 代码级实现规范：新建 `apps/electron/src/main/lib/nanju-coding-tree-bridge.ts`

```typescript
/**
 * 南大向导 → Tree V10.1 指挥官树自动衔接服务
 *
 * 当向导项目推进到 coding 阶段时，自动初始化 mcp__tree__ 任务树、
 * 注入前序阶段产出的 PRD/原型/架构文档契约，并注册异构模型的 Worker 与 Auditor 节点。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { getAgentWorkspacePath, getWorkspaceFilesDir } from './config-paths'
import { createAgentSession } from './agent-session-manager'
import { listChannels } from './channel-manager'
import { updateNanjuProject, type NanjuProject } from './nanju-project'
import { recordTelemetry } from './nanju-telemetry'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const treeEngine = require('./tree-engine.cjs') as {
  run(cmd: string, args: string[], treesRoot?: string, callerSessionId?: string): Promise<Record<string, unknown>>
}

export interface CodingTreeBootstrapInput {
  workspaceSlug: string
  workspaceId: string
  project: NanjuProject
  commanderSessionId: string
}

export interface CodingTreeBootstrapResult {
  ok: boolean
  treeId: string
  rootLeafId: string
  workerLeafId: string
  workerSessionId: string
  auditorLeafId: string
  auditorSessionId: string
  commanderBootstrapPrompt: string
  error?: string
}

/**
 * 将 projectId 转换为严格满足 tree-engine LEAF_NAME_RE (/^[a-z][a-z0-9_]{3,7}$/) 的 tree_id
 */
export function toValidTreeId(projectId: string): string {
  const clean = projectId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5)
  return `nj${clean.padEnd(4, '0')}`
}

/**
 * 动态选择主编码模型（优先 GLM-5.3 / DeepSeek Pro）与异构审计模型（优先 DeepSeek Flash）
 */
function selectHeterogeneousModels(): {
  workerChannelId: string
  workerModelId: string
  auditorChannelId: string
  auditorModelId: string
} {
  const enabledChannels = listChannels().filter((c) => c.enabled && (c.models ?? []).some((m) => m.enabled !== false))
  let workerChannelId = enabledChannels[0]?.id ?? 'default'
  let workerModelId = enabledChannels[0]?.models?.find((m) => m.enabled !== false)?.id ?? 'glm-5.3'
  let auditorChannelId = workerChannelId
  let auditorModelId = 'deepseek-v4-flash'

  for (const ch of enabledChannels) {
    for (const m of ch.models ?? []) {
      if (m.enabled === false) continue
      const idLower = m.id.toLowerCase()
      if (idLower.startsWith('glm-5') || idLower.includes('pro')) {
        workerChannelId = ch.id
        workerModelId = m.id
      } else if (idLower.includes('flash')) {
        auditorChannelId = ch.id
        auditorModelId = m.id
      }
    }
  }
  return { workerChannelId, workerModelId, auditorChannelId, auditorModelId }
}

/**
 * 扫描项目目录下的前序产出文档，供注入 root_brief
 */
function collectProjectArtifacts(workspaceSlug: string, projectId: string): string[] {
  const projectDir = path.join(getWorkspaceFilesDir(workspaceSlug), `project-${projectId}`)
  if (!fs.existsSync(projectDir)) return []
  const found: string[] = []
  const docDirs = ['01_PRD', '02_UX_DESIGN', '03_ARCHITECTURE', '04_API_SPEC', '05_PROJECT_PLAN']
  for (const sub of docDirs) {
    const subPath = path.join(projectDir, sub)
    if (!fs.existsSync(subPath)) continue
    try {
      for (const f of fs.readdirSync(subPath)) {
        if (!f.startsWith('.')) found.push(`project-${projectId}/${sub}/${f}`)
      }
    } catch {
      /* ignore */
    }
  }
  return found
}

export async function bootstrapCodingTreeForProject(
  input: CodingTreeBootstrapInput,
): Promise<CodingTreeBootstrapResult> {
  const { workspaceSlug, workspaceId, project, commanderSessionId } = input
  const treeId = toValidTreeId(project.projectId)
  const wsRoot = getAgentWorkspacePath(workspaceSlug)
  const treesDir = path.join(wsRoot, 'workspace-files', '.context', 'trees')
  fs.mkdirSync(treesDir, { recursive: true })

  const artifacts = collectProjectArtifacts(workspaceSlug, project.projectId)
  const { workerChannelId, workerModelId, auditorChannelId, auditorModelId } = selectHeterogeneousModels()

  const rootBrief = {
    parent_intent: `完成南大向导项目「${project.name}」（模式: ${project.mode}）的代码实现与 GWT 自动化验收`,
    project_id: project.projectId,
    upstream_artifacts: artifacts,
  }
  const rootDod = {
    deliverables: [`project-${project.projectId}/06_TESTS/gwt-report.json`],
    node_budget: project.mode === 'quick' ? 6 : 12,
    accept_criteria: ['核心功能代码落盘', 'GWT 自动化验收通过', '异构 Auditor 独立审查通过'],
  }

  // 1. 初始化树并绑定 commanderSessionId 为 root
  const initRes = await treeEngine.run(
    'init',
    [
      treeId,
      '--root-brief', JSON.stringify(rootBrief),
      '--root-dod', JSON.stringify(rootDod),
      '--session-id', commanderSessionId,
      '--model', workerModelId,
      '--channel', workerChannelId,
    ],
    treesDir,
    commanderSessionId,
  )

  if (!initRes.ok && (initRes.error as { code?: string })?.code !== 'E_DUPLICATE_LEAF') {
    return {
      ok: false,
      treeId,
      rootLeafId: `${treeId}-root`,
      workerLeafId: '',
      workerSessionId: '',
      auditorLeafId: '',
      auditorSessionId: '',
      commanderBootstrapPrompt: '',
      error: JSON.stringify(initRes.error),
    }
  }

  // 2. 创建 Worker 会话与 Auditor 会话（异构双模型）
  const workerSession = createAgentSession(
    `[Tree Worker] ${project.name}`,
    workerChannelId,
    workspaceId,
    workerModelId,
  )
  const auditorSession = createAgentSession(
    `[Tree Auditor] ${project.name}`,
    auditorChannelId,
    workspaceId,
    auditorModelId,
  )

  const rootLeafId = `${treeId}-root`
  const workerLeafId = `${treeId}-A-worker`
  const auditorLeafId = `${treeId}-B-worker` // 兼容 V10 ROLE_ENUM=['root','commander','worker'] 或 'auditor'

  await treeEngine.run(
    'leaf',
    [
      'add', treeId,
      '--json', JSON.stringify({
        leaf_id: workerLeafId,
        session_id: workerSession.id,
        parent: rootLeafId,
        path: 'A',
        role: 'worker',
        model: workerModelId,
        channel: workerChannelId,
        added_by: commanderSessionId,
      }),
    ],
    treesDir,
    commanderSessionId,
  )

  await treeEngine.run(
    'leaf',
    [
      'add', treeId,
      '--json', JSON.stringify({
        leaf_id: auditorLeafId,
        session_id: auditorSession.id,
        parent: rootLeafId,
        path: 'B',
        role: 'worker',
        model: auditorModelId,
        channel: auditorChannelId,
        added_by: commanderSessionId,
      }),
    ],
    treesDir,
    commanderSessionId,
  )

  // 3. 记录首条 communication 日志
  await treeEngine.run(
    'communication',
    [
      'log', treeId,
      '--from', rootLeafId,
      '--to', workerLeafId,
      '--summary', `向导进入 coding 阶段，自动装配任务树 ${treeId}`,
    ],
    treesDir,
    commanderSessionId,
  )

  recordTelemetry(workspaceSlug, 'coding.executed', {
    tree_id: treeId,
    commander_session_id: commanderSessionId,
    worker_session_id: workerSession.id,
    auditor_session_id: auditorSession.id,
  }, project.projectId)

  const commanderBootstrapPrompt = [
    `## 🌳 树形编码阶段已自动就绪（Tree ID: \`${treeId}\`）`,
    ``,
    `系统已为你自动初始化 V10 任务树并装配好异构双模型节点：`,
    `- **Root 指挥官（你）**：\`${rootLeafId}\` (session: \`${commanderSessionId}\`)`,
    `- **编码执行者（Worker）**：\`${workerLeafId}\` (session: \`${workerSession.id}\`, model: \`${workerModelId}\`)`,
    `- **独立审计员（Auditor）**：\`${auditorLeafId}\` (session: \`${auditorSession.id}\`, model: \`${auditorModelId}\`)`,
    `- **前序阶段产出文档**：${artifacts.length > 0 ? artifacts.map((a) => `\`${a}\``).join(', ') : '见项目目录 `project-' + project.projectId + '/`'}`,
    ``,
    `### 你的下一步标准动作（严格遵循 tree-commander SKILL）：`,
    `1. 为 \`${workerLeafId}\` 添加里程碑：调用 \`mcp__tree__tree_milestone_add(tree_id="${treeId}", leaf_id="${workerLeafId}", ...)\``,
    `2. 向 Worker 下发 5 件套契约：调用 \`mcp__session__send_message(session_id="${workerSession.id}", ...)\`，并紧接调用 \`mcp__tree__tree_log_communication(tree_id="${treeId}", from_leaf="${rootLeafId}", to_leaf="${workerLeafId}", summary="下发 5 件套契约")\``,
    `3. Worker 完成后，派遣独立 Auditor（\`${auditorSession.id}\`）执行交叉验证并签发 \`audit_gate\`。`,
  ].join('\n')

  return {
    ok: true,
    treeId,
    rootLeafId,
    workerLeafId,
    workerSessionId: workerSession.id,
    auditorLeafId,
    auditorSessionId: auditorSession.id,
    commanderBootstrapPrompt,
  }
}
```

> **接线位置**：在 `nanju-orchestrator.ts`（或 `v0.17.132` 对应的阶段推进函数）中，当项目推进至 `coding` 阶段时自动调用 `bootstrapCodingTreeForProject()`，并将返回的 `commanderBootstrapPrompt` 追加到编码指挥官的首条系统引导消息中，同时通知前端右侧面板自动切换到「任务树（`tree`）」Tab！

## 四、模块三（NEXT-03）：跨会话权限与询问全局可见性治理（P1-2）

### 4.1 根因分析
在多会话并行或树形委派（Root → Worker / Auditor）场景下：
- 当前 `PermissionBanner.tsx` 和 `AskUserBanner.tsx` 挂载在单个会话的 `AgentView.tsx` 内部，只读取 `permissionRequestsMap.get(currentSessionId)`。
- 当后台 Worker 会话或向导切换过程中的关联会话触发工具权限审批（`canUseTool`）或 `AskUser` 询问时，由于用户当前停留在主会话 Tab，横幅被挂载在未激活的后台会话上，导致**主界面零提示、后台会话无限期挂起等待**。

### 4.2 目标架构：全局待审批聚合原子 + 跨会话顶部横幅（`CrossSessionApprovalBanner`）

1. **状态聚合层（`apps/electron/src/renderer/atoms/agent-atoms.ts`）**：
   新增派生只读原子 `crossSessionPendingApprovalsAtom`，扫描 `allPermissionRequestsMapAtom` 与 `allAskUserRequestsMapAtom` 中所有 `sessionId !== activeSessionId` 的待决请求，并关联 `agentSessionsAtom` 中的会话标题。
2. **UI 呈现层（新建 `apps/electron/src/renderer/components/agent/CrossSessionApprovalBanner.tsx`）**：
   挂载在 `AgentView.tsx`（及 `NanjuWorkspaceView.tsx`）顶部，当检测到其他会话有未决权限或提问时，展示醒目的琥珀色聚合横幅，提供两个操作：
   - **「一键内联批准（Allow Once）」**：直接调用 `window.electronAPI.respondPermissionRequest(...)` 放行后台子会话，无需切走当前视图；
   - **「跳转查看详情 →」**：调用 `openSession('agent', targetSessionId)` 切换到该子会话处理复杂问答。

### 4.3 代码级实现规范：新建 `apps/electron/src/renderer/components/agent/CrossSessionApprovalBanner.tsx`

```tsx
/**
 * CrossSessionApprovalBanner — 跨会话待审批/待回答全局聚合提示横幅
 *
 * 解决 P1-2 痛点：当后台子会话（如 Tree Worker / 委派会话）触发权限审批或 AskUser 阻塞时，
 * 在当前活跃会话顶部显式提示，支持一键内联批准或一键跳转到目标会话。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { ShieldAlert, ExternalLink, Check, X } from 'lucide-react'
import {
  agentPermissionRequestsMapAtom,
  agentAskUserRequestsMapAtom,
  agentSessionsAtom,
} from '@/atoms/agent-atoms'
import { Button } from '@/components/ui/button'
import { useOpenSession } from '@/hooks/useOpenSession'

interface CrossSessionApprovalBannerProps {
  currentSessionId: string
}

export function CrossSessionApprovalBanner({
  currentSessionId,
}: CrossSessionApprovalBannerProps): React.ReactElement | null {
  const permissionMap = useAtomValue(agentPermissionRequestsMapAtom)
  const askUserMap = useAtomValue(agentAskUserRequestsMapAtom)
  const sessions = useAtomValue(agentSessionsAtom)
  const openSession = useOpenSession()

  const sessionTitleMap = React.useMemo(() => {
    const map = new Map<string, string>()
    for (const s of sessions) map.set(s.id, s.title)
    return map
  }, [sessions])

  // 收集所有非当前会话的待处理权限请求与 AskUser 请求
  const otherPermissions = React.useMemo(() => {
    const list: Array<{ sessionId: string; title: string; requestId: string; toolName: string }> = []
    for (const [sid, reqs] of permissionMap.entries()) {
      if (sid === currentSessionId || !reqs || reqs.length === 0) continue
      const first = reqs[0]
      if (first) {
        list.push({
          sessionId: sid,
          title: sessionTitleMap.get(sid) ?? sid.slice(0, 8),
          requestId: first.requestId,
          toolName: first.toolName,
        })
      }
    }
    return list
  }, [permissionMap, currentSessionId, sessionTitleMap])

  const otherAskUsers = React.useMemo(() => {
    const list: Array<{ sessionId: string; title: string; requestId: string }> = []
    for (const [sid, reqs] of askUserMap.entries()) {
      if (sid === currentSessionId || !reqs || reqs.length === 0) continue
      const first = reqs[0]
      if (first) {
        list.push({
          sessionId: sid,
          title: sessionTitleMap.get(sid) ?? sid.slice(0, 8),
          requestId: first.requestId,
        })
      }
    }
    return list
  }, [askUserMap, currentSessionId, sessionTitleMap])

  if (otherPermissions.length === 0 && otherAskUsers.length === 0) {
    return null
  }

  const topPerm = otherPermissions[0]
  const topAsk = otherAskUsers[0]
  const totalCount = otherPermissions.length + otherAskUsers.length

  return (
    <div className="mx-4 mt-2 flex items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-foreground shadow-sm">
      <div className="flex items-center gap-2 min-w-0">
        <ShieldAlert className="size-4 shrink-0 text-amber-500" />
        <span className="truncate">
          {topPerm ? (
            <>
              后台会话 <strong className="font-medium">「{topPerm.title}」</strong> 正在请求执行工具{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-[11px]">{topPerm.toolName}</code>
            </>
          ) : topAsk ? (
            <>
              后台会话 <strong className="font-medium">「{topAsk.title}」</strong> 正在等待你的问题确认
            </>
          ) : null}
          {totalCount > 1 && <span className="ml-1 text-muted-foreground">（共 {totalCount} 个后台会话阻塞）</span>}
        </span>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        {topPerm && (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px] gap-1 border-green-500/40 hover:bg-green-500/10"
              onClick={() => {
                void window.electronAPI.respondPermission?.({
                  sessionId: topPerm.sessionId,
                  requestId: topPerm.requestId,
                  behavior: 'allow',
                })
              }}
            >
              <Check className="size-3 text-green-500" />
              直接允许
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[11px] gap-1 border-red-500/40 hover:bg-red-500/10"
              onClick={() => {
                void window.electronAPI.respondPermission?.({
                  sessionId: topPerm.sessionId,
                  requestId: topPerm.requestId,
                  behavior: 'deny',
                  message: '用户在主视图拒绝了后台权限请求',
                })
              }}
            >
              <X className="size-3 text-red-500" />
              拒绝
            </Button>
          </>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[11px] gap-1"
          onClick={() => {
            const targetSid = topPerm?.sessionId ?? topAsk?.sessionId
            if (targetSid) openSession('agent', targetSid)
          }}
        >
          跳转会话
          <ExternalLink className="size-3" />
        </Button>
      </div>
    </div>
  )
}
```
（将该组件挂载在 `AgentView.tsx` 的 `<PermissionBanner>` 正上方，即可确保任何后台会话阻塞时用户第一时间可见并可一键放行）。

## 五、模块四（NEXT-04 & NEXT-05）：HTTP Bridge 鉴权收口与 119 项基线测试治理

### 5.1 落地 DEFERRED 的 `agent-mcp-bridge.ts` 鉴权（NEXT-04）
反馈报告 §3.2 第 1 条指出：`agent-mcp-bridge.ts` 仍保留了 `Access-Control-Allow-Origin: '*'` 且未启用 token 校验。本轮必须完成以下两处修改：
1. **删除 CORS 通配响应头**：在 `agent-mcp-bridge.ts` 的 `http.createServer` 中删除 `Access-Control-Allow-Origin: '*'` 分支（本地 CLI `proma-mcp-server.cjs` 和主进程 `http.request` 均不走浏览器 CORS，删除后直接阻断任何网页通过浏览器发起 CSRF 本地端口攻击）。
2. **本地共享 Token 鉴权**：
   - 在 `startMcpHttpBridge()` 启动时，生成 32 字节随机 hex token 写入 `~/.proma/.mcp-bridge-token`（文件权限 `0o600`）；
   - 当请求头包含 `x-proma-bridge-token` 时校验相等；若绑定在非 `127.0.0.1` / `localhost` 地址（如局域网模式），**强制要求**携带有效 `x-proma-bridge-token` 或 `Authorization: Bearer <token>`，否则返回 `401 Unauthorized`；
   - `proma-mcp-server.cjs` 与 `agent-remote-session-tools.ts` 自动读取 `~/.proma/.mcp-bridge-token` 注入请求头。

### 5.2 全量 `bun test` 119 fail / 21 errors 基线隔离治理（NEXT-05）
反馈报告 §2.2 与 §3.2 第 2 条证实，现有 119 个测试失败是因为测试直接读写宿主 `~/.proma` 或依赖 Electron `safeStorage` 真实加密环境。
- **治理方案**：
  1. 新建测试辅助模块 `apps/electron/src/main/lib/__tests__/test-home-fixture.ts`，提供 `withIsolatedPromaConfigDir(fn)`：在 `beforeEach` 中创建 `/tmp/proma-test-${randomUUID()}` 并设置 `process.env.PROMA_CONFIG_DIR`（或重定向 `config-paths.ts` 的基准目录），在 `afterEach` 中清理。
  2. 按以下 3 个子批次修复失败用例：
     - **Batch A**：渠道运行时 API Key 与密文 fallback 测试（mock Electron `safeStorage` 不可用时的明文/v1 前缀回退）；
     - **Batch B**：会话快照与工作区路径测试（接入 `withIsolatedPromaConfigDir`）；
     - **Batch C**：向导与阶段推进旧断言对齐 `v0.17.132` 新契约。

## 六、本阶段执行步骤与 GitHub 反馈报告模板（`docs/architecture-v0.17.135-feedback.md`）

请开发 Agent 按以下顺序执行，并在完成后将结果写入 `docs/architecture-v0.17.135-feedback.md` 推送至 `p1-quick-engineering` 分支：

```markdown
# Proma-Easy Phase 2 (v0.17.135) 实施反馈与验收报告

- **执行时间**：YYYY-MM-DD HH:mm
- **基线版本 → 目标版本**：v0.17.132 -> v0.17.135
- **双模型互审执行记录**：
  - GLM-5.3 会话 ID：`<填写实际 session_id>`
  - DeepSeek Flash 会话 ID：`<填写实际 session_id>`

## 1. Phase 2 核心模块完成矩阵

| 编号 | 模块名称 | 主导模型 | 独立审查模型 | 状态 (PASS/FAIL) | 关键文件与 Commit SHA |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **NEXT-01** | 交付验收双阶段见证时钟（`computeProjectArtifactDigest` + `freezeWitnessForHumanConfirmation`） | GLM-5.3 | DeepSeek Flash | | |
| **NEXT-02** | 向导进入 `coding` 自动装配 `mcp__tree__*` 指挥官树（`nanju-coding-tree-bridge.ts`） | GLM-5.3 | DeepSeek Flash | | |
| **NEXT-03** | 跨会话待审批全局聚合横幅（`CrossSessionApprovalBanner.tsx`） | GLM-5.3 | DeepSeek Flash | | |
| **NEXT-04** | `agent-mcp-bridge.ts` 移除通配 CORS + `.mcp-bridge-token` 鉴权落地 | DeepSeek Flash | GLM-5.3 | | |
| **NEXT-05** | 全量 `bun test` 基线隔离治理（119 fail / 21 errors 削减统计） | DeepSeek Flash | GLM-5.3 | | |

## 2. 自动化验证与端到端实测输出

### 2.1 双阶段见证时钟单测输出（验证人工挂起 >10 分钟但产物未改时 PASS，产物篡改时立即拦截）
（在此粘贴真实终端输出）

### 2.2 向导 `coding` 阶段自动建树集成测试输出
（在此粘贴真实终端输出）

### 2.3 全量 `bun run typecheck` 与 `bun test` 基线对比（Before: 119 fail / 21 errors → After: X fail / Y errors）
（在此粘贴真实终端输出）

## 3. 异构模型交叉审查发现（Audit Findings）
- **DeepSeek Flash 对 GLM-5.3 代码的独立审查意见**：
- **GLM-5.3 对 DeepSeek Flash 代码的独立审查意见**：
```
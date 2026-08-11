/**
 * 树形会话执行体系 MCP 工具（mcp__tree__*）
 *
 * 包装层：将 tree-engine.cjs 的 27 个命令 + 1 个 help 元工具暴露为 Pi custom tools。
 * 引擎逻辑（状态文件管理、DbC 硬约束、V10 加固）全部保留在 tree-engine.cjs 中。
 *
 * 移植自 proma-patches 项目的 createTreeMcpServer。
 */

import { Type } from 'typebox'
import * as path from 'node:path'
import * as fs from 'node:fs'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import { getAgentWorkspacePath } from './config-paths'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')

// 引擎接口（tree-engine.cjs 的导出）
interface TreeEngine {
  run(cmd: string, args: string[], treesRoot?: string, callerSessionId?: string): Promise<Record<string, unknown>>
  setTreesRoot(p: string): void
  getTreesRoot(): string
  ERRORS: Record<string, string>
}

// require CJS 引擎
// eslint-disable-next-line @typescript-eslint/no-require-imports
const treeEngine: TreeEngine = require('./tree-engine.cjs')

interface TreeToolsContext {
  sessionId: string
  workspaceSlug?: string
}

// ===== 通用辅助 =====

function jsonToolResult(payload: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    details: payload,
  } as AgentToolResult<unknown>
}

/**
 * 定位工作区的 .context/trees/ 目录。
 * 移植自 proma-patches 的 findTreesDirForWorkspace，但用 config-paths.ts 的函数。
 */
function findTreesDir(workspaceSlug?: string): { treesDir: string; workspaceRoot: string } | null {
  const slug = workspaceSlug || 'default'
  const wsRoot = getAgentWorkspacePath(slug)
  try {
    if (!fs.existsSync(wsRoot) || !fs.statSync(wsRoot).isDirectory()) return null
  } catch {
    return null
  }

  const candidates = [
    path.join(wsRoot, 'workspace-files', '.context', 'trees'),
    path.join(wsRoot, '.context', 'trees'),
  ]
  for (const dir of candidates) {
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
        return { treesDir: dir, workspaceRoot: wsRoot }
      }
    } catch {
      /* continue */
    }
  }
  return null
}

/**
 * 调用 tree-engine 执行命令。
 * 每次 call 前按 workspace 重设 TREES_ROOT（引擎模块级可变状态；主进程 JS 单线程，MCP 调用串行）。
 */
async function callTree(
  workspaceSlug: string | undefined,
  args: string[],
  callerSessionId?: string,
): Promise<Record<string, unknown>> {
  const ws = findTreesDir(workspaceSlug)
  if (!ws) {
    return {
      ok: false,
      error: {
        code: 'E_NO_TREES_DIR',
        msg: `workspace "${workspaceSlug ?? 'default'}" has no .context/trees/. Use tree_init to create one.`,
      },
    }
  }
  const [cmd, ...rest] = args
  if (!cmd) {
    return { ok: false, error: { code: 'E_SCHEMA_INVALID', msg: 'no tree command given' } }
  }
  return treeEngine.run(cmd, rest, ws.treesDir, callerSessionId)
}

// ===== 工具构建 =====

export function buildPiTreeTools(sdk: PiSdk, ctx: TreeToolsContext): ToolDefinition[] {
  const J = JSON.stringify

  // 工具工厂：schema 用 TypeBox，argBuilder 把结构化参数拼成 CLI args 数组
  interface TreeToolDef {
    name: string
    desc: string
    params: Record<string, unknown>
    argBuilder: (a: Record<string, unknown>) => string[]
    readOnly?: boolean
  }

  const tools: TreeToolDef[] = [
    // ---- V10-helper ----
    {
      name: 'tree_help',
      desc: '获取 tree-system 用法帮助。13 个主题：how_to_init | role_semantics | v10_constraints | self_audit_forbidden | borrowed_identity | naming_convention | common_mistakes | error_code_index | full_guide 等。不确定用法时先调用此工具。',
      params: { topic: Type.String() },
      argBuilder: (a) => ['help', a.topic as string],
      readOnly: true,
    },

    // ---- Maintain ----
    {
      name: 'tree_init',
      desc: '初始化新树（创建 tree 目录 + root leaf）。返回 tips.next_steps。',
      params: {
        tree_id: Type.String(),
        root_brief: Type.Record(Type.String(), Type.Unknown()),
        root_dod: Type.Record(Type.String(), Type.Unknown()),
        session_id: Type.Optional(Type.String()),
        model: Type.Optional(Type.String()),
        channel: Type.Optional(Type.String()),
        audit_meta: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      },
      argBuilder: (a) => [
        'init', a.tree_id as string,
        '--root-brief', J(a.root_brief),
        '--root-dod', J(a.root_dod),
        ...(a.session_id ? ['--session-id', a.session_id as string] : []),
        ...(a.model ? ['--model', a.model as string] : []),
        ...(a.channel ? ['--channel', a.channel as string] : []),
        ...(a.audit_meta ? ['--audit-meta', J(a.audit_meta)] : []),
      ],
    },
    {
      name: 'tree_validate',
      desc: '运行全部树不变量校验（父子链接、session_id 唯一性、路径、审计门禁、上下文溢出）。返回 {ok, issues}。',
      params: { tree_id: Type.String() },
      argBuilder: (a) => ['validate', a.tree_id as string],
      readOnly: true,
    },
    {
      name: 'tree_backup',
      desc: '创建 tree-state.json 的时间戳备份。',
      params: { tree_id: Type.String(), label: Type.Optional(Type.String()) },
      argBuilder: (a) => ['backup', a.tree_id as string, ...(a.label ? ['--label', a.label as string] : [])],
    },
    {
      name: 'tree_restore',
      desc: '从备份文件恢复 tree-state.json。',
      params: { tree_id: Type.String(), backup_file: Type.String() },
      argBuilder: (a) => ['restore', a.tree_id as string, a.backup_file as string],
    },
    {
      name: 'tree_migrate',
      desc: '运行 schema 迁移。',
      params: { tree_id: Type.String(), dry_run: Type.Optional(Type.Boolean()) },
      argBuilder: (a) => ['migrate', a.tree_id as string, ...(a.dry_run ? ['--dry-run'] : [])],
    },

    // ---- Add ----
    {
      name: 'tree_leaf_add',
      desc: '添加叶节点。worker 不能有子节点；commander 嵌套深度 <=3。',
      params: {
        tree_id: Type.String(),
        leaf: Type.Record(Type.String(), Type.Unknown(), { description: '完整 leaf JSON: {leaf_id,session_id,parent,path,role,model,channel,added_by}' }),
      },
      argBuilder: (a) => ['leaf', 'add', a.tree_id as string, '--json', J(a.leaf)],
    },
    {
      name: 'tree_milestone_add',
      desc: '为叶节点添加里程碑（expect_outputs 不能为空）。',
      params: {
        tree_id: Type.String(),
        leaf_id: Type.String(),
        milestone: Type.Record(Type.String(), Type.Unknown()),
      },
      argBuilder: (a) => ['milestone', 'add', a.tree_id as string, a.leaf_id as string, '--json', J(a.milestone)],
    },

    // ---- Update ----
    {
      name: 'tree_leaf_set_status',
      desc: '设置叶节点状态（active|done|pruned|archived|segment_pending|pending_brief）。done/archived 触发 DbC 硬门禁。',
      params: { tree_id: Type.String(), leaf_id: Type.String(), status: Type.String() },
      argBuilder: (a) => ['leaf', 'set-status', a.tree_id as string, a.leaf_id as string, a.status as string],
    },
    {
      name: 'tree_leaf_set_context',
      desc: '更新叶节点 context_usage_pct（0-100+）。',
      params: { tree_id: Type.String(), leaf_id: Type.String(), context_pct: Type.Number() },
      argBuilder: (a) => ['leaf', 'set-context', a.tree_id as string, a.leaf_id as string, String(a.context_pct)],
    },
    {
      name: 'tree_leaf_set_last_event',
      desc: '更新叶节点 last_event_type/ts。',
      params: { tree_id: Type.String(), leaf_id: Type.String(), event_type: Type.String(), ts: Type.Optional(Type.String()) },
      argBuilder: (a) => ['leaf', 'set-last-event', a.tree_id as string, a.leaf_id as string, a.event_type as string, ...(a.ts ? ['--ts', a.ts as string] : [])],
    },
    {
      name: 'tree_leaf_set_session',
      desc: '更新叶节点 session_id（如修正 PENDING_ROOT）。',
      params: { tree_id: Type.String(), leaf_id: Type.String(), session_id: Type.String() },
      argBuilder: (a) => ['leaf', 'set-session', a.tree_id as string, a.leaf_id as string, a.session_id as string],
    },
    {
      name: 'tree_leaf_autonomy_override',
      desc: '覆盖叶节点自主度（added_must_ask 等）。',
      params: { tree_id: Type.String(), leaf_id: Type.String(), overrides: Type.Record(Type.String(), Type.Unknown()) },
      argBuilder: (a) => ['leaf', 'autonomy-override', a.tree_id as string, a.leaf_id as string, '--json', J(a.overrides)],
    },
    {
      name: 'tree_milestone_set_result',
      desc: '设置里程碑审计结果。audit_pass=true 需要独立 auditor session。',
      params: {
        tree_id: Type.String(),
        leaf_id: Type.String(),
        milestone_id: Type.String(),
        audit_pass: Type.Boolean(),
        audit_session_id: Type.Optional(Type.String()),
        note_path: Type.Optional(Type.String()),
      },
      argBuilder: (a) => [
        'milestone', 'set-result', a.tree_id as string, a.leaf_id as string, a.milestone_id as string,
        '--audit-pass', String(a.audit_pass),
        ...(a.audit_session_id ? ['--audit-session-id', a.audit_session_id as string] : []),
        ...(a.note_path ? ['--note-path', a.note_path as string] : []),
      ],
    },

    // ---- Append ----
    {
      name: 'tree_event_append',
      desc: '追加事件（done/blocked/plan/brief_echo/heartbeat_reply/nudge/limit/status_check）。',
      params: { tree_id: Type.String(), leaf_id: Type.String(), type: Type.String(), meta: Type.Record(Type.String(), Type.Unknown()) },
      argBuilder: (a) => ['event', 'append', a.tree_id as string, a.leaf_id as string, '--type', a.type as string, '--json', J(a.meta)],
    },
    {
      name: 'tree_drift_append',
      desc: '追加偏差记录（三档纠偏）。',
      params: {
        tree_id: Type.String(), leaf_id: Type.String(),
        kind: Type.String(), severity: Type.String(), action: Type.String(),
        fork_to: Type.Optional(Type.String()), reason: Type.Optional(Type.String()),
      },
      argBuilder: (a) => [
        'drift', 'append', a.tree_id as string, a.leaf_id as string,
        '--kind', a.kind as string, '--severity', a.severity as string, '--action', a.action as string,
        ...(a.fork_to ? ['--fork-to', a.fork_to as string] : []),
        ...(a.reason ? ['--reason', a.reason as string] : []),
      ],
    },
    {
      name: 'tree_heartbeat_append',
      desc: '追加心跳（哨兵 Agent 巡检）。',
      params: { tree_id: Type.String(), heartbeat: Type.Record(Type.String(), Type.Unknown()) },
      argBuilder: (a) => ['heartbeat', 'append', a.tree_id as string, '--json', J(a.heartbeat)],
    },
    {
      name: 'tree_segment_append',
      desc: '追加竹节段（上下文交接）。',
      params: { tree_id: Type.String(), leaf_id: Type.String(), new_session_id: Type.String() },
      argBuilder: (a) => ['segment', 'append', a.tree_id as string, a.leaf_id as string, a.new_session_id as string],
    },
    {
      name: 'tree_nudge_append',
      desc: '追加 nudge 记录（TAO Watcher）。',
      params: { tree_id: Type.String(), leaf_id: Type.String(), rule_id: Type.String(), severity: Type.Optional(Type.String()) },
      argBuilder: (a) => ['nudge', 'append', a.tree_id as string, a.leaf_id as string, '--rule-id', a.rule_id as string, ...(a.severity ? ['--severity', a.severity as string] : [])],
    },
    {
      name: 'tree_nudge_reset',
      desc: '重置叶节点 nudge_count + nudge_log。',
      params: { tree_id: Type.String(), leaf_id: Type.String() },
      argBuilder: (a) => ['nudge', 'reset', a.tree_id as string, a.leaf_id as string],
    },

    // ---- TAO ----
    {
      name: 'tree_audit_gate',
      desc: '设置 audit_gate 判定。pass/required 需要独立 auditor session；pass 需要先有 done 事件。',
      params: {
        tree_id: Type.String(), leaf_id: Type.String(), verdict: Type.String(),
        audit_session_id: Type.Optional(Type.String()), reason: Type.Optional(Type.String()),
      },
      argBuilder: (a) => [
        'audit', 'gate', a.tree_id as string, a.leaf_id as string, '--verdict', a.verdict as string,
        ...(a.audit_session_id ? ['--audit-session-id', a.audit_session_id as string] : []),
        ...(a.reason ? ['--reason', a.reason as string] : []),
      ],
    },
    {
      name: 'tree_audit_append',
      desc: '追加审计报告条目。',
      params: { tree_id: Type.String(), leaf_id: Type.String(), report: Type.Record(Type.String(), Type.Unknown()) },
      argBuilder: (a) => ['audit', 'append', a.tree_id as string, a.leaf_id as string, '--json', J(a.report)],
    },

    // ---- Query ----
    {
      name: 'tree_leaf_get',
      desc: '按 ID 获取叶节点。',
      params: { tree_id: Type.String(), leaf_id: Type.String() },
      argBuilder: (a) => ['leaf', 'get', a.tree_id as string, a.leaf_id as string],
      readOnly: true,
    },
    {
      name: 'tree_leaf_list_active',
      desc: '列出活跃（非归档）叶节点。',
      params: { tree_id: Type.String() },
      argBuilder: (a) => ['leaf', 'list-active', a.tree_id as string],
      readOnly: true,
    },
    {
      name: 'tree_leaf_list_all',
      desc: '列出全部叶节点（含归档）。',
      params: { tree_id: Type.String() },
      argBuilder: (a) => ['leaf', 'list-all', a.tree_id as string],
      readOnly: true,
    },
    {
      name: 'tree_tree_dump',
      desc: '导出完整树状态 JSON。',
      params: { tree_id: Type.String() },
      argBuilder: (a) => ['tree', 'dump', a.tree_id as string],
      readOnly: true,
    },
    {
      name: 'tree_drift_list',
      desc: '列出偏差记录。',
      params: { tree_id: Type.String(), leaf_id: Type.Optional(Type.String()), since: Type.Optional(Type.String()) },
      argBuilder: (a) => ['drift', 'list', a.tree_id as string, ...(a.leaf_id ? ['--leaf', a.leaf_id as string] : []), ...(a.since ? ['--since', a.since as string] : [])],
      readOnly: true,
    },
    {
      name: 'tree_heartbeat_tail',
      desc: '读取心跳日志尾部。',
      params: { tree_id: Type.String(), leaf_id: Type.Optional(Type.String()), n: Type.Optional(Type.Number()) },
      argBuilder: (a) => ['heartbeat', 'tail', a.tree_id as string, ...(a.leaf_id ? ['--leaf', a.leaf_id as string] : []), ...(a.n ? ['-n', String(a.n)] : [])],
      readOnly: true,
    },
    {
      name: 'tree_event_list',
      desc: '列出事件。',
      params: { tree_id: Type.String(), leaf_id: Type.Optional(Type.String()), type: Type.Optional(Type.String()) },
      argBuilder: (a) => ['event', 'list', a.tree_id as string, ...(a.leaf_id ? ['--leaf', a.leaf_id as string] : []), ...(a.type ? ['--type', a.type as string] : [])],
      readOnly: true,
    },
  ]

  // 转换为 Pi sdk.defineTool
  return tools.map((t) =>
    sdk.defineTool({
      name: `mcp__tree__${t.name}`,
      label: t.name,
      description: t.desc,
      promptSnippet: `${t.name}: ${t.desc.slice(0, 100)}`,
      parameters: Type.Object(t.params as Record<string, import('typebox').TSchema>),
      async execute(_toolCallId: string, params: unknown) {
        const p = (params ?? {}) as Record<string, unknown>
        const result = await callTree(ctx.workspaceSlug, t.argBuilder(p), ctx.sessionId)
        return jsonToolResult(result)
      },
    }),
  )
}

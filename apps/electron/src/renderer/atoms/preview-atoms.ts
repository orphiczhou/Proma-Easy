/**
 * Preview Atoms — 内联预览/Diff 面板状态管理
 *
 * 每个 Agent 会话拥有独立的预览面板状态（选中文件、开关）。
 */

import { atom } from 'jotai'
import { atomWithStorage } from 'jotai/utils'
import { currentAgentSessionIdAtom } from './agent-atoms'

// ===== 类型定义 =====

/** 当前预览的文件信息 */
export interface PreviewFile {
  filePath: string
  dirPath?: string
  gitRoot?: string
  /** true = 纯文件预览（不显示 diff 控件），false/undefined = diff 模式 */
  previewOnly?: boolean
  /** 预览刷新版本号（open_preview 重开同路径时递增，驱动 DiffTabContent 重挂载以拉取最新内容） */
  previewVersion?: number
  /** true = 预览只读，不允许从预览面板写回临时/源文件 */
  readOnly?: boolean
  /** 候选基础目录（用于相对路径解析） */
  basePaths?: string[]
  /** Workspace slug for a relocatable managed Skill path. */
  workspaceSkillSlug?: string
  /** Original absolute Skill entry path used only when the managed locator cannot resolve. */
  legacySkillFilePath?: string
  /** 文件是否落在当前会话的 diff scope 内（与 getUnstagedChanges 的 candidates 对齐） */
  inDiffScope?: boolean
  /** 基准 ref（如 "origin/main"），用于 worktree vs main 模式的 diff 对比 */
  baseRef?: string
}

// ===== Atoms =====

/** 每会话预览面板开关 */
export const previewPanelOpenMapAtom = atom<Map<string, boolean>>(new Map())

/** 每会话当前预览的文件（null 时显示 DiffChangesList） */
export const previewFileMapAtom = atom<Map<string, PreviewFile | null>>(new Map())

/** 分栏比例（对话占比），持久化 */
export const previewSplitRatioAtom = atomWithStorage<number>('proma-preview-split-ratio', 0.5, undefined, { getOnInit: true })

/**
 * 预览默认展开方式，持久化。
 * - 'tab'   = 以预览标签页形式打开（旧版默认）
 * - 'split' = 在主区域右侧分屏展开（可同时看到 Agent 输出与文件内容）
 *
 * 用户仍可通过拖拽 Tab 出区域、PreviewPanel 顶栏按钮等即时切换。
 */
export type PreviewModePreference = 'tab' | 'split'
export const previewModePreferenceAtom = atomWithStorage<PreviewModePreference>(
  'proma-preview-mode-pref',
  'tab',
  undefined,
  { getOnInit: true },
)

/** 代码预览换行偏好（默认不换行，保持现有横向滚动行为） */
export const previewCodeWrapAtom = atomWithStorage<boolean>(
  'proma-preview-code-wrap',
  false,
  undefined,
  { getOnInit: true },
)

/** 当前会话的预览面板是否打开（derived） */
export const currentSessionPreviewOpenAtom = atom<boolean>((get) => {
  const sessionId = get(currentAgentSessionIdAtom)
  if (!sessionId) return false
  return get(previewPanelOpenMapAtom).get(sessionId) ?? false
})

// ===== 引用选中文本（Quoted Selection）=====

/** 选中文本引用的来源 */
export type QuotedSelectionSourceType = 'file' | 'agent-history' | 'scratch-pad' | 'ux-element'

/** UX 原型点选元素引用（点选纠错交互：点击元素→@引用进输入框→对话描述改法） */
export interface UxElementRef {
  /** 原型内唯一标记（data-ai-id） */
  id: string
  /** 元素类型（data-ai-type，如 按钮/输入框/文本） */
  type: string
  /** 元素文本摘要（≤40字） */
  text: string
  /** 所属原型文件绝对路径 */
  filePath: string
  /** 捕获时间戳 */
  capturedAt: number
}

/** 每会话最近点选的 UX 元素引用候选池（@ 菜单可回选，MRU 序，容量 12） */
export const uxElementRefPoolMapAtom = atom<Map<string, UxElementRef[]>>(new Map())

/** 当前会话待发送的点选元素引用（点选即暂存，发送时随消息携带；新点选覆盖） */
export const pendingUxElementRefMapAtom = atom<Map<string, UxElementRef>>(new Map())

/** 点选快速选项面板状态（交互1：点击原型元素后弹出快速选项面板） */
export interface ClickToFixPanelState {
  ref: UxElementRef
  /** 元素在 iframe 文档内的坐标（注入脚本 getBoundingClientRect） */
  rect: { x: number; y: number; w: number; h: number }
  /** 预览 iframe 在宿主视口内的左上角坐标 */
  iframe: { x: number; y: number; w: number; h: number }
}
export const clickToFixPanelAtom = atom<ClickToFixPanelState | null>(null)

/** 点选即时调整项（交互1 快速选项：颜色/删除/位置/改文字在原型上即时生效后入清单） */
export interface CtfChangeItem {
  ref: UxElementRef
  action: 'color' | 'delete' | 'move' | 'voice' | 'text'
  /** color=色值；delete 无；voice/text=文本；move={dx,dy,absX?,absY?,finalTransform?}（v0.17.59：finalTransform 为 iframe 上报的终态串，宿主只透传，不拼装矩阵） */
  value?: string | { dx: number; dy: number; absX?: number; absY?: number; finalTransform?: string }
  appliedAt: number
}
/** 每会话待接受的即时调整清单（接受调整后一次性发给会话执行并清空） */
export const pendingCtfChangesMapAtom = atom<Map<string, CtfChangeItem[]>>(new Map())

/** 从预览面板或 Agent 历史中选中的文本引用 */
export interface QuotedSelection {
  /** 选中的文本内容 */
  text: string
  /** 来源文件路径；历史引用时作为兼容展示字段 */
  filePath: string
  /** 引用来源类型 */
  sourceType?: QuotedSelectionSourceType
  /** 面向用户展示的来源名称 */
  sourceLabel?: string
  /** Agent 历史消息 ID */
  messageId?: string
  /** Agent 历史消息角色 */
  messageRole?: 'user' | 'assistant' | 'system'
  /** 起始行号（1-based，代码文件可计算，markdown 等无法计算时为 undefined） */
  startLine?: number
  /** 结束行号（1-based） */
  endLine?: number
  /** Agent 历史消息内选区的起始字符偏移（0-based） */
  selectionStart?: number
  /** Agent 历史消息内选区的结束字符偏移（0-based、exclusive） */
  selectionEnd?: number
  /** Agent 历史中的所属轮次（1-based；用户消息和对应回复共用同一轮） */
  turn?: number
  /** 捕获时间戳 */
  capturedAt: number
}

/** 每会话的引用选中文本 Map（每次新选中覆盖旧值） */
export const quotedSelectionMapAtom = atom<Map<string, QuotedSelection>>(new Map())

/** 当前会话的引用选中文本（派生） */
export const currentQuotedSelectionAtom = atom<QuotedSelection | null>((get) => {
  const sessionId = get(currentAgentSessionIdAtom)
  if (!sessionId) return null
  return get(quotedSelectionMapAtom).get(sessionId) ?? null
})

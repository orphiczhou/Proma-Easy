/**
 * project-list-logic — 我的项目页纯逻辑（Y5a，W1）
 *
 * ProjectListView 搜索/Tab 过滤与删除确认状态机的纯函数层：
 * 零依赖（不 import React/electron），可被组件与 bun 测试直接复用
 * （guide-dsl.ts 同型纪律：逻辑与渲染解耦）。
 */

/** 项目列表过滤所需的最小字段面（NanjuProject 投影） */
export interface ProjectFilterItem {
  name: string
  /** 摘要字段（NanjuProject 当前无摘要 → 组件侧仅按名称匹配；有摘要时按名称+摘要） */
  summary?: string
  mode: 'quick' | 'iterative'
}

/** 三段 Tab（spec 交互5 口径：mode 维度——全部/快速工具/长期项目） */
export type ProjectListTab = 'all' | 'quick' | 'iterative'

export const PROJECT_LIST_TAB_LABELS: Record<ProjectListTab, string> = {
  all: '全部',
  quick: '快速工具',
  iterative: '长期项目',
}

/**
 * 搜索 + Tab 过滤（spec 交互5：实时过滤，按名称和摘要匹配，大小写不敏感；
 * 搜索词去首尾空白后为空 = 不过滤）。
 */
export function filterProjects<T extends ProjectFilterItem>(
  projects: T[],
  opts: { tab: ProjectListTab; query: string },
): T[] {
  const query = opts.query.trim().toLowerCase()
  return projects.filter((p) => {
    if (opts.tab !== 'all' && p.mode !== opts.tab) return false
    if (!query) return true
    const haystack = `${p.name}${p.summary ?? ''}`.toLowerCase()
    return haystack.includes(query)
  })
}

/** 删除确认弹窗状态机（ProjectDeleteConfirm 驱动；Y5a 二次确认流程） */
export type DeleteDialogState = 'closed' | 'confirming' | 'deleting'

export type DeleteDialogAction =
  | { type: 'open' }
  | { type: 'cancel' }
  | { type: 'confirm' }
  | { type: 'deleted' }
  | { type: 'failed' }

/**
 * 状态转移：
 * - open：任意态 → confirming（再次 open 幂等同态，供切换删除目标）
 * - cancel：confirming/deleting → closed（deleting 中允许取消仅作界面恢复，IPC 结果到达时按 closed 忽略）
 * - confirm：confirming → deleting
 * - deleted/failed：deleting → closed（成功/失败提示由调用方 Toast/错误文案展示）
 */
export function nextDeleteDialogState(
  state: DeleteDialogState,
  action: DeleteDialogAction,
): DeleteDialogState {
  switch (action.type) {
    case 'open':
      return 'confirming'
    case 'cancel':
      return 'closed'
    case 'confirm':
      return state === 'confirming' ? 'deleting' : state
    case 'deleted':
    case 'failed':
      return state === 'deleting' ? 'closed' : state
    default:
      return state
  }
}

/** 删除确认正文（spec 交互5 心理防御文案，逐字） */
export const DELETE_CONFIRM_WARNING = '项目及其所有数据将被永久删除，此操作不可撤销。'

/** 删除成功 Toast 文案「已删除「{项目名}」及其所有数据」（spec 交互5） */
export function buildDeleteSuccessToastText(projectName: string): string {
  return `已删除「${projectName}」及其所有数据`
}

/** 删除确认弹窗标题「确定要删除「{项目名}」吗？」（spec 交互5） */
export function buildDeleteConfirmTitle(projectName: string): string {
  return `确定要删除「${projectName}」吗？`
}

/** 空状态引导文案（spec 交互5 心理防御文案，逐字） */
export const PROJECT_EMPTY_GUIDE = '创建一个项目，让AI帮你把想法变成可用的工具或网站。只需描述你的需求，剩下的交给AI来处理。'

/** 搜索无结果提示（spec 交互5，逐字） */
export const PROJECT_NO_RESULTS = '没有匹配的项目，试试其他关键词'

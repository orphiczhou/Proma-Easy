/**
 * 我的项目页纯逻辑单测（Y5a，W1，spec 交互5）：
 * filterProjects（搜索 + 三段 Tab mode 维度）、nextDeleteDialogState（删除确认状态机）、
 * Toast/弹窗文案 spec 逐字锁定。
 */

import { describe, expect, test } from 'bun:test'
import {
  DELETE_CONFIRM_WARNING,
  PROJECT_EMPTY_GUIDE,
  PROJECT_LIST_TAB_LABELS,
  PROJECT_NO_RESULTS,
  buildDeleteConfirmTitle,
  buildDeleteSuccessToastText,
  filterProjects,
  nextDeleteDialogState,
  type ProjectFilterItem,
} from './project-list-logic'

interface TestProject extends ProjectFilterItem {}

const PROJECTS: TestProject[] = [
  { name: '单位换算器', mode: 'quick' },
  { name: '公司官网', summary: '长期维护的官网', mode: 'iterative' },
  { name: '待办清单工具', mode: 'quick' },
  { name: '内部管理系统', mode: 'iterative' },
]

describe('filterProjects（搜索 + Tab）', () => {
  test('全部 Tab + 空搜索：全量返回', () => {
    expect(filterProjects(PROJECTS, { tab: 'all', query: '' })).toHaveLength(4)
  })

  test('Tab 按 mode 维度过滤：快速工具 / 长期项目', () => {
    expect(filterProjects(PROJECTS, { tab: 'quick', query: '' }).map((p) => p.name)).toEqual(['单位换算器', '待办清单工具'])
    expect(filterProjects(PROJECTS, { tab: 'iterative', query: '' }).map((p) => p.name)).toEqual(['公司官网', '内部管理系统'])
  })

  test('搜索按名称实时过滤（大小写不敏感）', () => {
    expect(filterProjects(PROJECTS, { tab: 'all', query: '工具' }).map((p) => p.name)).toEqual(['待办清单工具'])
  })

  test('搜索命中摘要字段（有 summary 时名称+摘要匹配）', () => {
    expect(filterProjects(PROJECTS, { tab: 'all', query: '官网' }).map((p) => p.name)).toEqual(['公司官网'])
  })

  test('Tab + 搜索叠加', () => {
    expect(filterProjects(PROJECTS, { tab: 'quick', query: '官网' })).toHaveLength(0)
    expect(filterProjects(PROJECTS, { tab: 'iterative', query: '官网' })).toHaveLength(1)
  })

  test('搜索词仅空白 = 不过滤', () => {
    expect(filterProjects(PROJECTS, { tab: 'all', query: '   ' })).toHaveLength(4)
  })

  test('保留原对象引用与附加字段（泛型透传）', () => {
    const withExtra = [{ name: 'x', mode: 'quick' as const, projectId: 'p-1' }]
    expect(filterProjects(withExtra, { tab: 'all', query: '' })[0]).toBe(withExtra[0])
  })
})

describe('删除确认状态机', () => {
  test('主路径：open → confirming → confirm → deleting → deleted → closed', () => {
    let s = nextDeleteDialogState('closed', { type: 'open' })
    expect(s).toBe('confirming')
    s = nextDeleteDialogState(s, { type: 'confirm' })
    expect(s).toBe('deleting')
    s = nextDeleteDialogState(s, { type: 'deleted' })
    expect(s).toBe('closed')
  })

  test('失败路径：deleting → failed → closed', () => {
    let s = nextDeleteDialogState('confirming', { type: 'confirm' })
    s = nextDeleteDialogState(s, { type: 'failed' })
    expect(s).toBe('closed')
  })

  test('取消：confirming/deleting → closed', () => {
    expect(nextDeleteDialogState('confirming', { type: 'cancel' })).toBe('closed')
    expect(nextDeleteDialogState('deleting', { type: 'cancel' })).toBe('closed')
  })

  test('非 confirming 态 confirm 不转移（closed 下误触发防御）', () => {
    expect(nextDeleteDialogState('closed', { type: 'confirm' })).toBe('closed')
  })

  test('非 deleting 态 deleted/failed 不转移（迟到结果防御）', () => {
    expect(nextDeleteDialogState('closed', { type: 'deleted' })).toBe('closed')
    expect(nextDeleteDialogState('confirming', { type: 'failed' })).toBe('confirming')
  })
})

describe('文案（spec 交互5 逐字锁定）', () => {
  test('三段 Tab 标签：全部/快速工具/长期项目', () => {
    expect(PROJECT_LIST_TAB_LABELS).toEqual({ all: '全部', quick: '快速工具', iterative: '长期项目' })
  })

  test('删除确认标题与正文', () => {
    expect(buildDeleteConfirmTitle('单位换算器')).toBe('确定要删除「单位换算器」吗？')
    expect(DELETE_CONFIRM_WARNING).toBe('项目及其所有数据将被永久删除，此操作不可撤销。')
  })

  test('删除成功 Toast', () => {
    expect(buildDeleteSuccessToastText('单位换算器')).toBe('已删除「单位换算器」及其所有数据')
  })

  test('空态引导与无结果提示', () => {
    expect(PROJECT_EMPTY_GUIDE).toBe('创建一个项目，让AI帮你把想法变成可用的工具或网站。只需描述你的需求，剩下的交给AI来处理。')
    expect(PROJECT_NO_RESULTS).toBe('没有匹配的项目，试试其他关键词')
  })
})

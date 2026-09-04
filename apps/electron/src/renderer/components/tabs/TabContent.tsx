/**
 * TabContent — 标签内容渲染器
 *
 * 根据标签类型渲染参数化的 ChatView 或 AgentView。
 * 直接传递 sessionId/conversationId prop，无需桥接全局 atoms。
 */

import * as React from 'react'
import { useAtomValue } from 'jotai'
import { getDefaultStore } from 'jotai'
import { tabsAtom, activeTabIdAtom, openTab } from '@/atoms/tab-atoms'
import type { TabItem } from '@/atoms/tab-atoms'
import { markdownTocOpenAtom } from '@/atoms/markdown-toc'
import { ChatView } from '@/components/chat'
import { AgentView } from '@/components/agent'
import { PreviewTabContent } from '@/components/diff/PreviewTabContent'
import { MarkdownRichEditor } from '@/components/diff/MarkdownRichEditor'
import { MarkdownToc } from '@/components/diff/MarkdownToc'
import { ModeSelectView } from '@/components/nanju/ModeSelectView'
import { ScratchPadView } from '@/components/scratch-pad/ScratchPadView'
import { TabErrorBoundary } from './TabErrorBoundary'

export interface TabContentProps {
  tabId: string
}

export function TabContent({ tabId }: TabContentProps): React.ReactElement {
  const tabs = useAtomValue(tabsAtom)
  const tab = tabs.find((t) => t.id === tabId)

  // [W14] 以下 hooks 必须先于所有 early return 调用（React Rules of Hooks）：
  // TabContent 是 MainArea 中跨标签复用的单实例组件，tab 切换时 tabId 指向的
  // tab 可能短暂不存在（useDeferredValue 旧值渲染帧 / openTab 替换语义移除旧 tab），
  // 曾因 nanju 两个 useState 放在 `if (!tab)` 之后触发 React #300 白屏（详见 plan/w14-report.md）。
  const [nanjuCreating, setNanjuCreating] = React.useState(false)
  const [nanjuCreateError, setNanjuCreateError] = React.useState<string | null>(null)

  // [FLASH-DEBUG] 监控 tab 查找失败（说明 tabId 指向了不存在的标签）
  React.useEffect(() => {
    if (!tab) {
      console.warn(`[FLASH-DEBUG] TabContent: tab not found for tabId="${tabId}"`, { tabIds: tabs.map(t => t.id) })
    }
  }, [tab, tabId, tabs])

  if (!tab) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        标签页不存在
      </div>
    )
  }

  // R4（W1）：南大模式选择创建链路的失败可见化（原：async IIFE 无 catch，IPC 失败后无任何反馈；
  // 状态定义已上提到 early return 之前，见顶部 [W14] 注释）

  if (tab.type === 'scratch') {
    return <ScratchPadView />
  }

  if (tab.type === 'tutorial') {
    return <TutorialTabContent />
  }

  if (tab.type === 'chat') {
    return (
      <TabErrorBoundary key={tab.sessionId} sessionId={tab.sessionId}>
        <ChatView conversationId={tab.sessionId} />
      </TabErrorBoundary>
    )
  }

  if (tab.type === 'preview') {
    return (
      <TabErrorBoundary key={tab.id} sessionId={tab.sessionId}>
        <PreviewTabContent sessionId={tab.sessionId} />
      </TabErrorBoundary>
    )
  }


  if (tab.type === 'nanju-mode-select') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {/* R4（W1）：创建链路失败可见化（原：async IIFE 无 catch，IPC 失败后无任何反馈） */}
        {nanjuCreateError && (
          <div className="mx-4 mt-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            创建项目失败：{nanjuCreateError}。请重试；若持续失败请查看主进程日志。
          </div>
        )}
        <div className="min-h-0 flex-1">
          <ModeSelectView
            onSelectMode={(mode: 'quick' | 'iterative', name: string) => {
              if (nanjuCreating) return // 双击/连点守卫：避免重复建会话与重复建项目
              setNanjuCreating(true)
              setNanjuCreateError(null)
              void (async () => {
                try {
                  // 1. 确保南大工作区存在
                  const ws = await window.electronAPI.nanjuEnsureWorkspace() as { id: string; name: string; slug: string }

                  // 2. 在南大工作区内创建 Agent 会话
                  const session = await window.electronAPI.createAgentSession(name, undefined, ws.id).catch(() => null)
                  const sessionId = session?.id ?? `nanju-${Date.now()}`

                  // 3. 创建南大项目元数据
                  try {
                    await window.electronAPI.nanjuCreateProject({
                      name,
                      mode,
                      workspaceSlug: ws.slug,
                      sessionId,
                    })
                  } catch (e) {
                    console.error('[南大向导] 创建项目元数据失败:', e)
                  }

                  // 4. 替换当前 tab 为普通 agent 会话
                  const currentTabs = getDefaultStore().get(tabsAtom)
                  const filtered = currentTabs.filter((t: TabItem) => t.id !== tab.id)
                  const result = openTab(filtered, {
                    type: 'agent',
                    sessionId,
                    title: name,
                  })
                  getDefaultStore().set(tabsAtom, result.tabs)
                  getDefaultStore().set(activeTabIdAtom, result.activeTabId)
                } catch (e) {
                  // 原实现：无 catch 的 async IIFE，失败静默（用户感知「点击无响应」）
                  console.error('[南大向导] 创建项目失败:', e)
                  setNanjuCreateError(e instanceof Error ? e.message : String(e))
                } finally {
                  setNanjuCreating(false)
                }
              })()
            }}
          />
        </div>
      </div>
    )
  }

  return (
    <TabErrorBoundary key={tab.sessionId} sessionId={tab.sessionId}>
      <AgentView sessionId={tab.sessionId} />
    </TabErrorBoundary>
  )
}

function TutorialTabContent(): React.ReactElement {
  const [content, setContent] = React.useState('')
  const [loadState, setLoadState] = React.useState<'loading' | 'ready' | 'error'>('loading')
  const tocOpen = useAtomValue(markdownTocOpenAtom)
  const scrollRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    window.electronAPI.getTutorialContent()
      .then((result) => {
        if (result === null) {
          setLoadState('error')
          return
        }
        setContent(result)
        setLoadState('ready')
      })
      .catch((error) => {
        console.error(error)
        setLoadState('error')
      })
  }, [])

  if (loadState === 'loading') {
    return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">加载中...</div>
  }

  if (loadState === 'error') {
    return <div className="flex h-full items-center justify-center text-xs text-muted-foreground">教程加载失败</div>
  }

  return (
    <div className="relative flex h-full min-h-0 overflow-hidden">
      <MarkdownToc containerRef={scrollRef as React.RefObject<HTMLElement>} contentKey={content.slice(0, 100)} enabled={tocOpen} />
      <div ref={scrollRef} className="flex-1 min-w-0 overflow-y-auto p-8">
        <MarkdownRichEditor
          value={content}
          editing={false}
          onChange={() => {}}
          onSave={() => {}}
          onCancel={() => {}}
        />
      </div>
    </div>
  )
}

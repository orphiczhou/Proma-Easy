/**
 * DeliveryCard — 交付视图卡片（Task 12，Phase 1 完善）
 *
 * 显示持久历史验收结果（与 GwtProgressCard 实时进度互补）：
 * - 从 `06_TESTS/report.json` 读取机器报告（通过 IPC nanju:get-delivery-view）
 * - 交付入口：品类/入口路径/启动说明/测试证据
 * - 不执行命令 / 不绕批准——打开文件和预览走既有 IPC
 *
 * 区别：
 * - GwtProgressCard = 实时进度（事件流，当前轮次）
 * - DeliveryCard = 历史视图（文件系统已结束轮次）
 *
 * 使用方式：
 * - 父组件传入 workspaceSlug + projectId
 * - 数据通过 `nanju:get-delivery-view` IPC 获取（由父 Session 完成接线）
 */

import * as React from 'react'
import { CheckCircle2, XCircle, HelpCircle, AlertTriangle, Clock, ExternalLink, FlaskConical, FolderOpen, FileX } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useOpenPreview } from '@/components/diff/preview-opener'
import type {
  DeliveryVerdict,
  DeliveryTestEvidence,
  DeliveryViewModel,
} from '@proma/shared'

// ===== IPC 通道名（与 main/lib/nanju-ipc.ts 中注册的 handler 对齐） =====
// 父 Session 负责：1. 在 nanju-ipc.ts 注册 'nanju:get-delivery-view' handler
// 2. 在 preload/index.ts 暴露 nanjuGetDeliveryView
// 3. 在这里调用 window.electronAPI.nanjuGetDeliveryView({ workspaceSlug, projectId })
const IPC_CHANNEL = 'nanju:get-delivery-view'

// ===== 工具函数 =====

const VERDICT_LABEL: Record<DeliveryVerdict, string> = {
  pass: '验收通过',
  fail: '验收未通过',
  error: '执行异常',
  blocked: '已阻塞',
  stale: '已过期',
  'not-tested': '尚未测试',
}

const VERDICT_COLOR: Record<DeliveryVerdict, string> = {
  pass: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  fail: 'bg-red-500/15 text-red-600 dark:text-red-400',
  error: 'bg-orange-500/15 text-orange-600 dark:text-orange-400',
  blocked: 'bg-gray-500/15 text-gray-600 dark:text-gray-400',
  stale: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  'not-tested': 'bg-muted text-muted-foreground',
}

const VERDICT_ICON: Record<DeliveryVerdict, React.ReactElement> = {
  pass: <CheckCircle2 className="size-3" />,
  fail: <XCircle className="size-3" />,
  error: <AlertTriangle className="size-3" />,
  blocked: <HelpCircle className="size-3" />,
  stale: <Clock className="size-3" />,
  'not-tested': <HelpCircle className="size-3" />,
}

const DELIVERY_TYPE_LABEL: Record<string, string> = {
  web: 'Web 应用',
  desktop: '桌面应用',
  cli: 'CLI 工具',
  api: 'API 服务',
  mobile: '移动应用',
  ai: 'AI 应用',
  unknown: '工具',
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return '—'
  try {
    const diff = Date.now() - new Date(iso).getTime()
    const minutes = Math.floor(diff / 60_000)
    const hours = Math.floor(diff / 3_600_000)
    const days = Math.floor(diff / 86_400_000)
    if (minutes < 1) return '刚刚'
    if (minutes < 60) return `${minutes} 分钟前`
    if (hours < 24) return `${hours} 小时前`
    if (days < 30) return `${days} 天前`
    return new Date(iso).toLocaleDateString('zh-CN')
  } catch {
    return iso
  }
}

function formatVerdictCount(ev: DeliveryTestEvidence): string {
  const total = ev.scenariosTotal
  if (total === 0) return '尚无测试场景'
  const { passed, failed, skipped } = ev
  if (failed > 0) return `${passed}/${total} 通过，${failed} 未通过`
  if (skipped > 0) return `${passed}/${total} 通过（${skipped} 跳过）`
  return `${passed}/${total} 全部通过`
}

// ===== 组件 =====

interface DeliveryCardProps {
  workspaceSlug: string
  projectId: string
  sessionId?: string
  /** 是否折叠（默认展开） */
  defaultExpanded?: boolean
}

export function DeliveryCard({
  workspaceSlug,
  projectId,
  sessionId,
  defaultExpanded = false,
}: DeliveryCardProps): React.ReactElement {
  const [expanded, setExpanded] = React.useState(defaultExpanded)
  const [loading, setLoading] = React.useState(false)
  const [viewModel, setViewModel] = React.useState<DeliveryViewModel | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const openPreview = useOpenPreview()

  const load = React.useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await window.electronAPI.nanjuGetDeliveryView({ workspaceSlug, projectId })
      setViewModel(result ?? null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [workspaceSlug, projectId])

  // 挂载时拉取 + 手动刷新
  React.useEffect(() => {
    void load()
  }, [load])

  const handleOpenEntry = React.useCallback(async () => {
    if (!viewModel?.entryAbsPath || !sessionId) return
    try {
      openPreview(sessionId, { filePath: viewModel.entryAbsPath, previewOnly: true })
    } catch (e) {
      console.warn('[交付卡片] 打开预览失败:', e)
    }
  }, [viewModel, sessionId, openPreview])

  const handleOpenTestsDir = React.useCallback(async () => {
    if (!viewModel) return
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const api = window.electronAPI as unknown as Record<string, unknown>
      if (typeof api.showItemInFolder === 'function') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (api.showItemInFolder as (path: string, candidateBasePaths?: string[]) => Promise<boolean>)(viewModel.testsDirPath, [])
      }
    } catch (e) {
      console.warn('[交付卡片] 打开测试目录失败:', e)
    }
  }, [viewModel])

  if (loading) {
    return (
      <div className="mx-3 mt-2 rounded-md border border-border/40 bg-muted/5 px-3 py-2 text-xs text-muted-foreground">
        加载交付信息…
      </div>
    )
  }

  if (error) {
    return (
      <div className="mx-3 mt-2 rounded-md border border-red-400/30 bg-red-500/5 px-3 py-2 text-xs">
        <span className="text-red-500">交付信息加载失败：{error}</span>
        <button
          type="button"
          onClick={() => void load()}
          className="ml-2 underline hover:no-underline"
        >
          重试
        </button>
      </div>
    )
  }

  if (!viewModel) {
    return (
      <div className="mx-3 mt-2 rounded-md border border-border/40 bg-muted/5 px-3 py-2 text-xs text-muted-foreground">
        尚未生成测试报告
      </div>
    )
  }

  const verdict = viewModel.verdict
  const verdictColor = VERDICT_COLOR[verdict]
  const verdictLabel = VERDICT_LABEL[verdict]
  const verdictIcon = VERDICT_ICON[verdict]
  const typeLabel = DELIVERY_TYPE_LABEL[viewModel.deliveryType] ?? '工具'

  return (
    <div className="mx-3 mt-2 rounded-md border border-border/40 bg-content-area overflow-hidden text-xs">
      {/* 头部：品类 + verdict badge + 展开折叠 */}
      <div className="flex items-center gap-2 px-3 py-2">
        <FlaskConical className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium shrink-0">交付验收</span>
        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {typeLabel}
        </span>
        <span className={cn('ml-auto flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px]', verdictColor)}>
          {verdictIcon}
          {verdictLabel}
        </span>
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="shrink-0 text-muted-foreground hover:text-foreground"
          title={expanded ? '收起详情' : '展开详情'}
        >
          {expanded ? '▲' : '▼'}
        </button>
      </div>

      {/* 核心信息：入口 + 启动说明 */}
      <div className="px-3 pb-2">
        <div className="flex items-center gap-2">
          <code
            className="flex-1 truncate rounded bg-muted px-1.5 py-0.5 text-[11px]"
            title={viewModel.entryAbsPath ?? viewModel.entryPath}
          >
            {viewModel.entryPath}
          </code>
          <button
            type="button"
            onClick={handleOpenEntry}
            disabled={!sessionId || !viewModel.entryAbsPath}
            className="shrink-0 inline-flex items-center gap-0.5 rounded border border-border px-1.5 py-0.5 text-[10px] hover:bg-muted/70 disabled:opacity-40"
            title={viewModel.entryAbsPath ? '预览入口文件' : '入口文件不存在或路径无效'}
          >
            <ExternalLink className="size-3" />预览
          </button>
        </div>
        <p className="mt-1 text-muted-foreground/80">{viewModel.launchInstructions}</p>
      </div>

      {/* stale 警告 */}
      {verdict === 'stale' && viewModel.staleMessage && (
        <div className="mx-3 mb-2 flex items-start gap-1.5 rounded bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">
          <AlertTriangle className="size-3.5 mt-0.5 shrink-0" />
          <span>{viewModel.staleMessage}</span>
        </div>
      )}

      {/* 展开详情 */}
      {expanded && (
        <div className="border-t border-border/40 px-3 py-2 space-y-2">
          {/* 测试证据 */}
          {viewModel.hasHistory ? (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1 font-medium text-foreground/80">
                <CheckCircle2 className="size-3.5" />测试证据
              </div>
              {viewModel.evidence.map((ev: DeliveryTestEvidence, i: number) => (
                <div key={ev.runId ?? i} className="rounded bg-muted/50 px-2 py-1.5 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={cn(
                      'inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px]',
                      VERDICT_COLOR[ev.verdict],
                    )}>
                      {VERDICT_ICON[ev.verdict]}
                      {VERDICT_LABEL[ev.verdict]}
                    </span>
                    <span className="text-muted-foreground text-[10px] tabular-nums">
                      {formatRelativeTime(ev.generatedAt)}
                    </span>
                    {ev.retryCount > 0 && (
                      <span className="text-[10px] text-amber-600 dark:text-amber-400">
                        重试 {ev.retryCount} 次
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    {formatVerdictCount(ev)}
                  </div>
                  {ev.coveredUs.length > 0 && (
                    <div className="text-[10px] text-muted-foreground/70">
                      已覆盖：{ev.coveredUs.join(', ')}
                    </div>
                  )}
                  {ev.uncoveredUs.length > 0 && (
                    <div className="text-[10px] text-amber-600 dark:text-amber-400">
                      未覆盖：{ev.uncoveredUs.join(', ')}
                    </div>
                  )}
                  {ev.warnings.length > 0 && (
                    <div className="text-[10px] text-muted-foreground/60">
                      注意：{ev.warnings[0]}
                      {ev.warnings.length > 1 ? ` 等 ${ev.warnings.length} 项` : ''}
                    </div>
                  )}
                  {ev.entryFingerprint && (
                    <div className="text-[10px] text-muted-foreground/60 font-mono">
                      {ev.entryFingerprint}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            (viewModel.history ?? []).length === 0 && (
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <FileX className="size-3.5" />
                <span>暂无测试运行记录</span>
              </div>
            )
          )}

          {/* 历史验收记录（Task 12.1/12.3；审计 B6-F-09） */}
          {(viewModel.history ?? []).length > 0 && (
            <div className="space-y-1.5">
              <div className="flex items-center gap-1 font-medium text-foreground/80">
                <Clock className="size-3.5" />历史验收记录（最近 {(viewModel.history ?? []).length} 次）
              </div>
              {(viewModel.history ?? []).map((h) => (
                <div key={h.runId} className="flex items-center gap-2 flex-wrap rounded bg-muted/40 px-2 py-1">
                  <span className={cn(
                    'inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px]',
                    VERDICT_COLOR[h.conclusion],
                  )}>
                    {VERDICT_ICON[h.conclusion]}
                    {VERDICT_LABEL[h.conclusion]}
                  </span>
                  <span className="text-[10px] text-muted-foreground tabular-nums">
                    {formatRelativeTime(h.generatedAt || null)}
                  </span>
                  <span className="text-[10px] text-muted-foreground/80 tabular-nums">
                    测试 {h.testsTotal}（通过 {h.passed}，失败 {h.failed}
                    {h.errored > 0 ? `，异常 ${h.errored}` : ''}
                    {h.blocked > 0 ? `，阻塞 ${h.blocked}` : ''}）
                  </span>
                  <code className="text-[10px] font-mono text-muted-foreground/60" title={h.indexRelPath ?? ''}>
                    {h.runId}
                  </code>
                </div>
              ))}
            </div>
          )}

          {/* 路径信息 */}
          <div className="space-y-1">
            <div className="font-medium text-foreground/80">文件位置</div>
            <div className="space-y-0.5">
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground text-[10px] shrink-0 w-16">入口：</span>
                <code className="flex-1 truncate text-[10px] font-mono" title={viewModel.entryAbsPath ?? ''}>
                  {viewModel.entryPath}
                </code>
                {!viewModel.entryAbsPath && (
                  <span className="text-[10px] text-amber-500 shrink-0">（文件不存在）</span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground text-[10px] shrink-0 w-16">测试报告：</span>
                <code className="flex-1 truncate text-[10px] font-mono" title={viewModel.reportJsonPath}>
                  06_TESTS/report.json
                </code>
              </div>
            </div>
          </div>

          {/* 操作按钮 */}
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              onClick={handleOpenEntry}
              disabled={!sessionId || !viewModel.entryAbsPath}
              className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] hover:bg-muted/70 disabled:opacity-40"
            >
              <ExternalLink className="size-3" />打开预览
            </button>
            <button
              type="button"
              onClick={handleOpenTestsDir}
              className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] hover:bg-muted/70"
            >
              <FolderOpen className="size-3" />查看测试目录
            </button>
            <button
              type="button"
              onClick={() => void load()}
              className="ml-auto text-[10px] text-muted-foreground hover:text-foreground underline"
            >
              刷新
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

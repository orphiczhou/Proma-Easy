/**
 * 点选纠错预览 iframe 目标解析（AC-R2 Y3）
 *
 * 问题：宿主→iframe 指令（__promaCtfApply）此前用 document.querySelector('iframe[src*="prototype"]')
 * 取首个匹配——多预览 iframe 并存（预览 Tab + 分屏 / BrowserPanel 打开同名文件）时可能取错目标，
 * 且依赖文件名含 "prototype"。
 *
 * 解析顺序（裁决建议：点击事件缓存的 frame 优先，querySelector 兑底）：
 * 1. 最近一次点选/改动回报消息的来源 frame（useGlobalAgentListeners 按 event.source 精确定位后缓存）
 * 2. 带 data-proma-preview 属性的可见 iframe（DiffTabContent 渲染，值 = sessionId）
 * 3. proma-file 协议 src 的可见 iframe（不再依赖 "prototype" 文件名）
 */

let lastFrameRef: WeakRef<HTMLIFrameElement> | null = null

/** 缓存最近一次与宿主通信的预览 iframe（useGlobalAgentListeners 在校验 event.source 后调用） */
export function rememberPreviewFrame(frame: HTMLIFrameElement | null | undefined): void {
  lastFrameRef = frame ? new WeakRef(frame) : null
}

function pickVisible(frames: HTMLIFrameElement[]): HTMLIFrameElement | null {
  return frames.find((f) => f.offsetWidth > 0 && f.offsetHeight > 0) ?? frames[0] ?? null
}

/** 解析当前应下发的预览 iframe（详见文件头注释的优先级） */
export function getPreviewFrame(): HTMLIFrameElement | null {
  const remembered = lastFrameRef?.deref() ?? null
  if (remembered && remembered.isConnected && remembered.contentWindow) return remembered
  const tagged = Array.from(document.querySelectorAll('iframe[data-proma-preview]')) as HTMLIFrameElement[]
  const byTag = pickVisible(tagged)
  if (byTag) return byTag
  const bySrc = Array.from(document.querySelectorAll('iframe[src^="proma-file"]')) as HTMLIFrameElement[]
  return pickVisible(bySrc)
}

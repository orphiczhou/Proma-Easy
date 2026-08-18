/**
 * 点选纠错（Click-to-Fix）iframe 注入脚本
 *
 * 依据 /home/orphic/proma-projDoc/DesignDoc/02_UX_DESIGN/interaction-spec.md 交互1：
 * 用户在预览区点击原型元素 → 事件委托捕获 data-ai-id/data-ai-type →
 * 3 秒高亮（快消型独立 div 覆盖层）→ postMessage 通知宿主（Proma 渲染进程）。
 *
 * 宿主侧（useGlobalAgentListeners / nanju 调度链）收到后转为快速选项交互。
 * 此脚本以 <script> 注入 iframe（sandbox=allow-scripts 下可执行），
 * 不依赖 allow-same-origin（跨源 postMessage 用 '*' targetOrigin，
 * 载荷不含敏感信息，仅元素 id/type/文本摘要）。
 */

export const CLICK_TO_FIX_INJECT_SCRIPT = `
(function () {
  if (window.__promaClickToFix) return;
  window.__promaClickToFix = true;

  var highlightTimer = null;

  function ensureHighlightLayer() {
    var layer = document.getElementById('proma-ctf-highlight');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'proma-ctf-highlight';
      layer.style.cssText = 'position:absolute;border:2px solid #4F46E5;border-radius:6px;pointer-events:none;z-index:2147483647;background:rgba(79,70,229,0.08);display:none;transition:all .15s ease;';
      document.documentElement.appendChild(layer);
    }
    return layer;
  }

  function reportToHost(payload) {
    try { parent.postMessage(Object.assign({ __promaClickToFix: true, filePath: location.href }, payload), '*'); } catch (e) { /* 宿主不存在或被拦，静默 */ }
  }

  document.addEventListener('click', function (e) {
    var target = e.target && e.target.closest ? e.target.closest('[data-ai-id]') : null;

    var layer = ensureHighlightLayer();

    if (!target) {
      // 空白点击：按设计文案引导（interaction-spec 交互1 边界Case）
      layer.style.display = 'none';
      reportToHost({ kind: 'blank-click' });
      return;
    }

    var id = target.getAttribute('data-ai-id');
    var type = target.getAttribute('data-ai-type') || '元素';
    var text = (target.innerText || target.value || '').trim().slice(0, 40);

    // 高亮：绝对定位覆盖层（快消型方案），3 秒自动消失；连击重置计时
    var rect = target.getBoundingClientRect();
    layer.style.top = (rect.top + window.scrollY) + 'px';
    layer.style.left = (rect.left + window.scrollX) + 'px';
    layer.style.width = rect.width + 'px';
    layer.style.height = rect.height + 'px';
    layer.style.display = '';
    if (highlightTimer) clearTimeout(highlightTimer);
    highlightTimer = setTimeout(function () { layer.style.display = 'none'; }, 3000);

    reportToHost({ kind: 'element-click', id: id, type: type, text: text });
  }, true);
})();
`

/** 判断 postMessage 事件是否来自点选纠错注入脚本 */
export function isClickToFixMessage(data: unknown): data is { __promaClickToFix: true; kind: string; id?: string; type?: string; text?: string } {
  if (!data || typeof data !== 'object') return false
  const d = data as Record<string, unknown>
  return d.__promaClickToFix === true && typeof d.kind === 'string'
}

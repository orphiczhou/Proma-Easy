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

  // 供快速选项面板定位用的 rect（iframe 文档内坐标）；宿主会叠加 iframe 在视口内的偏移
  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
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

    reportToHost({ kind: 'element-click', id: id, type: type, text: text, rect: rectOf(target) });
  }, true);

  // ===== 宿主 → iframe 即时修改指令（交互1 快速选项：颜色/删除/位置即时生效） =====
  // 记录每元素的原始样式/偏移，撤销时恢复；改动明细回传宿主进修改清单
  var originalStyles = {};
  function rememberOriginal(el) {
    var id = el.getAttribute('data-ai-id');
    if (!originalStyles[id]) {
      originalStyles[id] = {
        bg: el.style.backgroundColor || '',
        color: el.style.color || '',
        opacity: el.style.opacity || '',
        transform: el.style.transform || '',
      };
    }
  }
  function applyChange(action, id, value) {
    var el = document.querySelector('[data-ai-id="' + id + '"]');
    if (!el) return { ok: false, error: 'element not found' };
    rememberOriginal(el);
    if (action === 'color') {
      el.style.backgroundColor = value;
    } else if (action === 'delete') {
      el.style.opacity = '0.3';
      el.style.textDecoration = 'line-through';
    } else if (action === 'move') {
      // value: {dx, dy} 像素偏移（累积）
      var cur = originalStyles[id].transform;
      var m = cur.match(/translate\\(([\\d.-]+)px, ([\\d.-]+)px\\)/);
      var baseX = m ? parseFloat(m[1]) : 0;
      var baseY = m ? parseFloat(m[2]) : 0;
      el.style.transform = 'translate(' + (baseX + (value.dx||0)) + 'px, ' + (baseY + (value.dy||0)) + 'px)';
    }
    return { ok: true };
  }
  function undoChange(id) {
    var el = document.querySelector('[data-ai-id="' + id + '"]');
    var orig = originalStyles[id];
    if (!el || !orig) return { ok: false };
    el.style.backgroundColor = orig.bg;
    el.style.color = orig.color;
    el.style.opacity = orig.opacity;
    el.style.transform = orig.transform;
    el.style.textDecoration = '';
    delete originalStyles[id];
    return { ok: true };
  }
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.__promaCtfApply !== true) return;
    if (d.action === 'undo') { undoChange(d.id); return; }
    if (d.action === 'undo-all') {
      Object.keys(originalStyles).forEach(function (id) { undoChange(id); });
      return;
    }
    if (d.action === 'drag-start') {
      var el = document.querySelector('[data-ai-id="' + d.id + '"]');
      if (!el) return;
      rememberOriginal(el);
      el.style.cursor = 'move';
      var base = el.style.transform || '';
      var sx = 0, sy = 0;
      var mv = function (ev) {
        var dx = ev.clientX - sx, dy = ev.clientY - sy;
        el.style.transform = base + ' translate(' + dx + 'px, ' + dy + 'px)';
      };
      var up = function (ev) {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        el.style.cursor = '';
        var dx = Math.round(ev.clientX - sx), dy = Math.round(ev.clientY - sy);
        el.style.transform = base + ' translate(' + dx + 'px, ' + dy + 'px)';
        reportToHost({ kind: 'change-result', id: d.id, action: 'move', ok: true, value: { dx: dx, dy: dy } });
      };
      var down = function (ev) {
        sx = ev.clientX; sy = ev.clientY;
        document.addEventListener('mousemove', mv);
        document.addEventListener('mouseup', up);
        ev.preventDefault();
      };
      el.addEventListener('mousedown', down, { once: true });
      return;
    }
    var result = applyChange(d.action, d.id, d.value);
    reportToHost({ kind: 'change-result', id: d.id, action: d.action, ok: result.ok, error: result.error || '', value: d.value });
  });
})();
`

/** 判断 postMessage 事件是否来自点选纠错注入脚本 */
export function isClickToFixMessage(data: unknown): data is { __promaClickToFix: true; kind: string; id?: string; type?: string; text?: string } {
  if (!data || typeof data !== 'object') return false
  const d = data as Record<string, unknown>
  return d.__promaClickToFix === true && typeof d.kind === 'string'
}

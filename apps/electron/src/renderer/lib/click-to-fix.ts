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

  var suppressClickUntil = 0;
  document.addEventListener('click', function (e) {
    // 拖拽刚结束的 click 不重新点选（移动操作的稳定交互）
    if (Date.now() < suppressClickUntil) { suppressClickUntil = 0; return; }
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
    // 不删 originalStyles：同一元素可多次撤销（每次回原始态，重复幂等）
    return { ok: true };
  }
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.__promaCtfApply !== true) return;
    // 安全：只接受来自宿主（parent）的指令（R4：防原型内嵌脚本伪造）
    if (e.source !== parent) return;
    if (d.action === 'annotate') {
      // 元素角标（内部右上角，避免被卡片 overflow/圆角裁剪）+ 元素旁窄条显示改动摘要
      var el = document.querySelector('[data-ai-id="' + d.id + '"]');
      if (!el) return;
      var pos = getComputedStyle(el).position;
      if (pos === 'static') el.style.position = 'relative';
      var bag = document.getElementById('proma-ctf-badge-' + d.id);
      if (!bag) {
        bag = document.createElement('div');
        bag.id = 'proma-ctf-badge-' + d.id;
        bag.style.cssText = 'position:absolute;top:2px;right:2px;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#DC2626;color:#fff;font-size:10px;line-height:16px;text-align:center;cursor:pointer;z-index:9999;box-shadow:0 1px 3px rgba(0,0,0,.4)';
        el.appendChild(bag);
      }
      var n = parseInt(bag.textContent, 10) || 0;
      bag.textContent = String(n + 1);
      // 元素旁窄条：显示最近一条改动摘要（替换为最新）
      var strip = document.getElementById('proma-ctf-strip-' + d.id);
      if (!strip) {
        strip = document.createElement('div');
        strip.id = 'proma-ctf-strip-' + d.id;
        strip.style.cssText = 'position:absolute;left:0;bottom:-20px;max-width:100%;padding:2px 6px;border-radius:4px;background:rgba(79,70,229,.9);color:#fff;font-size:10px;line-height:1.3;z-index:9998;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 2px 6px rgba(0,0,0,.35)';
        el.appendChild(strip);
      }
      strip.textContent = d.text || '';
      // 点击角标/窄条 → 切换意见浮层
      var showTip = function (ev) {
        ev.stopPropagation();
        var tip = document.getElementById('proma-ctf-tip-' + d.id);
        if (!tip) {
          tip = document.createElement('div');
          tip.id = 'proma-ctf-tip-' + d.id;
          tip.style.cssText = 'position:absolute;top:-10px;right:12px;z-index:9997;max-width:220px;padding:6px 8px;border-radius:6px;background:#1f2937;color:#f9fafb;font-size:11px;line-height:1.5;box-shadow:0 4px 12px rgba(0,0,0,.5);white-space:pre-wrap';
          el.appendChild(tip);
        }
        tip.textContent = d.text || '';
        tip.style.display = tip.style.display === 'none' ? '' : 'none';
      };
      bag.onclick = showTip;
      strip.onclick = showTip;
      return;
    }
    if (d.action === 'remove-annotation') {
      var bagEl = document.getElementById('proma-ctf-badge-' + d.id);
      var tipEl = document.getElementById('proma-ctf-tip-' + d.id);
      var stripEl = document.getElementById('proma-ctf-strip-' + d.id);
      if (bagEl) {
        var cnt = (parseInt(bagEl.textContent, 10) || 1) - 1;
        if (cnt <= 0) { bagEl.remove(); if (stripEl) stripEl.remove(); } else { bagEl.textContent = String(cnt); }
      }
      if (tipEl) tipEl.remove();
      return;
    }
    if (d.action === 'undo') { undoChange(d.id); return; }
    if (d.action === 'undo-all') {
      Object.keys(originalStyles).forEach(function (id) { undoChange(id); });
      // 一并清理全部元素角标与意见浮层
      var badges = document.querySelectorAll('[id^="proma-ctf-badge-"], [id^="proma-ctf-tip-"]');
      for (var i = 0; i < badges.length; i++) badges[i].remove();
      return;
    }
    if (d.action === 'drag-start') {
      var el = document.querySelector('[data-ai-id="' + d.id + '"]');
      if (!el) return;
      rememberOriginal(el);
      el.style.cursor = 'move';
      var base = el.style.transform || '';
      var sx = 0, sy = 0, active = false, lastDx = 0, lastDy = 0;
      var mv = function (ev) {
        if (!active) return;
        var dx = ev.clientX - sx, dy = ev.clientY - sy;
        lastDx = dx; lastDy = dy;
        el.style.transform = base + ' translate(' + dx + 'px, ' + dy + 'px)';
      };
      var finish = function (dx, dy) {
        active = false;
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        el.style.cursor = '';
        var rdx = Math.round(dx), rdy = Math.round(dy);
        // 位移小于 4px 视为误触（点击未拖动），还原且不上报，避免“点一下放下”产生空改动
        if (Math.abs(rdx) < 4 && Math.abs(rdy) < 4) {
          el.style.transform = base;
          return;
        }
        el.style.transform = base + ' translate(' + rdx + 'px, ' + rdy + 'px)';
        // 拖拽结束后的 click 不再触发点选面板（稳定交互：一次拖动=一次改动）
        suppressClickUntil = Date.now() + 400;
        reportToHost({ kind: 'change-result', id: d.id, action: 'move', ok: true, type: el.getAttribute('data-ai-type') || '元素', text: (el.innerText || el.value || '').trim().slice(0, 40), value: { dx: rdx, dy: rdy } });
      };
      var up = function (ev) { finish(ev.clientX - sx, ev.clientY - sy); };
      var down = function (ev) {
        sx = ev.clientX; sy = ev.clientY; active = true;
        // R1：pointer capture 到元素——拖出 iframe 边界后 move/up 仍派发给元素，不丢 mouseup
        try { el.setPointerCapture(ev.pointerId); } catch (err) { /* 降级：document 级监听 */ }
        document.addEventListener('mousemove', mv);
        document.addEventListener('mouseup', up);
        ev.preventDefault();
      };
      el.addEventListener('pointerdown', down, { once: true });
      // 兑底：拖出 iframe 后指针事件被宿主截走时，以最后已知位移收口
      var leave = function () {
        if (!active) return;
        finish(lastDx, lastDy);
      };
      el.addEventListener('mouseleave', leave, { once: true });
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

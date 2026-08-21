/**
 * 点选纠错（Click-to-Fix）iframe 注入脚本 —— 单一事实源（AC-R2 Y8）
 *
 * 依据 /home/orphic/proma-projDoc/DesignDoc/02_UX_DESIGN/interaction-spec.md 交互1：
 * 用户在预览区点击原型元素 → 事件委托捕获 data-ai-id/data-ai-type →
 * 3 秒高亮（document 级覆盖层）→ postMessage 通知宿主（Proma 渲染进程）。
 * 宿主 → iframe 指令（__promaCtfApply）：color/delete/move/drag-start/text-edit/undo/undo-all/
 * annotate/remove-annotation，即时生效、可撤销。v0.17.58：text-edit 原地编辑；拖拽改会话级
 * 持续模式 + 绝对偏移（absX/absY）上报（拖拽基线取 computed transform，覆盖样式表歧义）。
 *
 * ⚠️ 本文件是注入脚本的唯一事实源：local-file-protocol.ts 把本常量包进 <script> 标签
 * 注入 proma-file:// HTML 响应。历史上 renderer/lib/click-to-fix.ts 的可读副本 + 协议层
 * minified tag 双源维护，v0.17.54 被迫同改两处、Round1 曾发生 ldx/ldy 分叉事故，已收敛到此。
 * 注意：脚本体是模板字面量字符串——反斜杠须写 \\，\n 须写 \\n，禁止 ${ 插值。
 *
 * 角标/窄条/意见浮层（annotate）自 v0.17.56 起为 document 级 overlay（AC-R2 Y4）：
 * 不再向元素 appendChild（IMG/INPUT/VIDEO/CANVAS/TEXTAREA 等替换元素会抛
 * HierarchyRequestError，且 position:relative 突变会破坏含绝对定位后代的布局，
 * bottom:-20px 窄条会被父级 overflow:hidden 裁切）。overlay 挂 documentElement、
 * getBoundingClientRect 定位，滚动/resize 重排，撤销零残留。
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

  // P2b：解析 computed transform 的平移分量（tx/ty）。matrix(a,b,c,d,tx,ty) 6 值；
  // matrix3d(...) 16 值（平移在 [12]/[13]）；none/空/解析失败 → 0,0。只取 tx/ty：
  // commit 报文最终写死 translate(absX,absY)，旋转/缩放分量不参与点选纠错语义
  function parseMatrixTranslate(tr) {
    if (!tr || tr === 'none') return { tx: 0, ty: 0 };
    var mm = String(tr).match(/matrix3d\\(([^)]+)\\)/);
    if (mm) {
      var p16 = mm[1].split(',');
      if (p16.length >= 14) return { tx: parseFloat(p16[12]) || 0, ty: parseFloat(p16[13]) || 0 };
      return { tx: 0, ty: 0 };
    }
    var m6 = String(tr).match(/matrix\\(([^)]+)\\)/);
    if (!m6) return { tx: 0, ty: 0 };
    var p6 = m6[1].split(',');
    if (p6.length < 6) return { tx: 0, ty: 0 };
    return { tx: parseFloat(p6[4]) || 0, ty: parseFloat(p6[5]) || 0 };
  }

  // P2b：拖拽基线 = computed transform 的 tx/ty（含样式表 transform，如历史 translate(31px,-9px)），
  // 不再直接用 inline el.style.transform——inline 覆盖样式表会让首拖位置跳变
  function computedTranslateOf(el) {
    try { return parseMatrixTranslate(window.getComputedStyle(el).transform); }
    catch (e) { return { tx: 0, ty: 0 }; }
  }

  // 供快速选项面板定位用的 rect（iframe 文档内坐标）；宿主会叠加 iframe 在视口内的偏移
  function rectOf(el) {
    var r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }

  // ===== 角标/窄条/意见浮层：document 级 overlay（Y4 重构，不再动元素 DOM） =====
  // annotations: id -> { el, notes: [], badge, strip, tip }
  var annotations = {};

  var BADGE_CSS = 'position:absolute;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:#DC2626;color:#fff;font-size:10px;line-height:16px;text-align:center;cursor:pointer;z-index:2147483646;box-shadow:0 1px 3px rgba(0,0,0,.4)';
  var STRIP_CSS = 'position:absolute;padding:2px 6px;border-radius:4px;background:rgba(79,70,229,.9);color:#fff;font-size:10px;line-height:1.3;z-index:2147483646;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 2px 6px rgba(0,0,0,.35);cursor:pointer';
  var TIP_CSS = 'position:absolute;max-width:220px;padding:6px 8px;border-radius:6px;background:#1f2937;color:#f9fafb;font-size:11px;line-height:1.5;box-shadow:0 4px 12px rgba(0,0,0,.5);white-space:pre-wrap;z-index:2147483645;display:none';

  function ensureOverlayNode(id, suffix, cssText, onclick) {
    var node = document.getElementById('proma-ctf-' + suffix + '-' + id);
    if (!node) {
      node = document.createElement('div');
      node.id = 'proma-ctf-' + suffix + '-' + id;
      node.style.cssText = cssText;
      if (onclick) node.addEventListener('click', onclick);
      document.documentElement.appendChild(node);
    }
    return node;
  }

  function removeAnnotationNodes(a) {
    if (a.badge) a.badge.remove();
    if (a.strip) a.strip.remove();
    if (a.tip) a.tip.remove();
  }

  // 点击角标/窄条 → 切换意见浮层（Y6：浮层累积展示全部意见，编号列表）
  function toggleTipFor(id, ev) {
    if (ev) ev.stopPropagation();
    var a = annotations[id];
    if (!a || a.notes.length === 0) return;
    if (!a.tip) a.tip = ensureOverlayNode(id, 'tip', TIP_CSS, null);
    a.tip.textContent = a.notes.map(function (t, i) { return (i + 1) + '. ' + t; }).join('\\n');
    a.tip.style.display = a.tip.style.display === 'none' ? '' : 'none';
    repositionAnnotations();
  }

  var repositionScheduled = false;
  function repositionAnnotations() {
    repositionScheduled = false;
    Object.keys(annotations).forEach(function (id) {
      var a = annotations[id];
      if (!a.el || !a.el.isConnected) { removeAnnotationNodes(a); delete annotations[id]; return; }
      var r = a.el.getBoundingClientRect();
      var sx = window.scrollX, sy = window.scrollY;
      var visible = r.width > 0 && r.height > 0;
      a.badge.style.left = (r.right + sx - 18) + 'px';
      a.badge.style.top = (r.top + sy + 2) + 'px';
      a.badge.style.display = visible ? '' : 'none';
      a.strip.style.left = (r.left + sx) + 'px';
      a.strip.style.top = (r.bottom + sy + 4) + 'px';
      a.strip.style.maxWidth = Math.min(r.width + 80, 260) + 'px';
      a.strip.style.display = visible ? '' : 'none';
      if (a.tip && a.tip.style.display !== 'none') {
        a.tip.style.left = (r.right + sx - 210) + 'px';
        a.tip.style.top = (r.top > 140 ? r.top + sy - a.tip.offsetHeight - 8 : r.bottom + sy + 24) + 'px';
      }
    });
  }
  function scheduleReposition() {
    if (repositionScheduled) return;
    repositionScheduled = true;
    window.requestAnimationFrame(repositionAnnotations);
  }
  // capture 捕获任意容器滚动（原型常见内滚动区）+ 视口 resize
  window.addEventListener('resize', scheduleReposition);
  window.addEventListener('scroll', scheduleReposition, true);

  var suppressClickUntil = 0;
  var suppressClickTarget = null;
  // ===== P2a：拖拽会话级持续模式 =====
  // dragMode 非空时：目标元素反复可拖（pointerdown 常驻，不再 once）；该元素 click 不弹面板；
  // 退出：其他修改指令 / undo-all / 30s 无拖动 / 点击其他 data-ai-id 元素（用户转去做别的）
  var dragMode = null; // { el, id, timer, pointerDown, mouseleave }

  function exitDragMode() {
    if (!dragMode) return;
    if (dragMode.timer) clearTimeout(dragMode.timer);
    try { dragMode.el.removeEventListener('pointerdown', dragMode.pointerDown); } catch (e) {}
    if (dragMode.el.style.cursor === 'move') dragMode.el.style.cursor = '';
    dragMode = null;
  }

  function armDragIdleTimer() {
    if (!dragMode) return;
    if (dragMode.timer) clearTimeout(dragMode.timer);
    dragMode.timer = setTimeout(function () { exitDragMode(); }, 30000);
  }

  document.addEventListener('click', function (e) {
    // 点击 overlay（角标/窄条/浮层）本身：属于 overlay 交互，不当作点选/空白点击
    var tid = e.target && e.target.id ? String(e.target.id) : '';
    if (tid.indexOf('proma-ctf-') === 0) return;
    var target = e.target && e.target.closest ? e.target.closest('[data-ai-id]') : null;

    // P2a：拖拽模式下点击其他 data-ai-id 元素 = 用户转去做别的，退出拖拽模式并照常弹面板
    if (dragMode && target && target !== dragMode.el) exitDragMode();
    // P2a：拖拽模式下目标元素自身的 click 一律不弹点选面板（用户还在拖，面板反而干扰）
    if (dragMode && target === dragMode.el) return;

    // Y7：拖拽刚结束的 click 只对拖拽起点元素生效（不吞对其他元素的快速点选）
    if (Date.now() < suppressClickUntil && e.target === suppressClickTarget) { suppressClickUntil = 0; suppressClickTarget = null; return; }

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

  // ===== 宿主 → iframe 即时修改指令（交互1 快速选项：颜色/删除/位置/改文字即时生效） =====
  // 记录每元素的原始样式/偏移/文本快照，撤销时恢复；改动明细回传宿主进修改清单
  var originalStyles = {};
  function rememberOriginal(el) {
    var id = el.getAttribute('data-ai-id');
    if (!originalStyles[id]) {
      originalStyles[id] = {
        bg: el.style.backgroundColor || '',
        color: el.style.color || '',
        opacity: el.style.opacity || '',
        transform: el.style.transform || '',
        // P1：text-edit 首次编辑时才写入（textSaved 标记），undo 恢复文本仅限编过文本的元素
        textSaved: false,
        textSnapshot: '',
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
      // value: {dx, dy} 像素偏移（累积）；P2b 扩展 {absX, absY} 绝对偏移（最终 transform 直接写死，所见即所得）
      if (value && typeof value.absX === 'number' && typeof value.absY === 'number') {
        el.style.transform = 'translate(' + Math.round(value.absX) + 'px, ' + Math.round(value.absY) + 'px)';
      } else {
        var cur = originalStyles[id].transform;
        var m = cur.match(/translate\\(([\\d.-]+)px, ([\\d.-]+)px\\)/);
        var baseX = m ? parseFloat(m[1]) : 0;
        var baseY = m ? parseFloat(m[2]) : 0;
        el.style.transform = 'translate(' + (baseX + (value.dx||0)) + 'px, ' + (baseY + (value.dy||0)) + 'px)';
      }
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
    // P1：只恢复编辑过文本的元素（未动过文本的元素不碰 innerText，防重建子树破坏嵌套结构）
    if (orig.textSaved) {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.value = orig.textSnapshot || '';
      else el.innerText = orig.textSnapshot || '';
    }
    // 不删 originalStyles：同一元素可多次撤销（每次回原始态，重复幂等）
    return { ok: true };
  }
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || d.__promaCtfApply !== true) return;
    // 安全：只接受来自宿主（parent）的指令（R4：防原型内嵌脚本伪造）
    if (e.source !== parent) return;
    // Y4(b)：指令异常必须回报宿主，不静默（此前替换元素 appendChild 抛错即整条失败无回报）
    try {
      // P2a：拖拽模式下收到其他修改类指令 / undo-all → 退出拖拽模式（annotate/undo 不算：
      // 用户可能边拖边听写意见或在清单条上单撤某项，不必打断拖拽）
      if (dragMode && d.action !== 'drag-start' && d.action !== 'annotate' && d.action !== 'remove-annotation' && d.action !== 'undo') {
        exitDragMode();
      }
      if (d.action === 'annotate') {
        var aEl = document.querySelector('[data-ai-id="' + d.id + '"]');
        if (!aEl) return;
        var a = annotations[d.id];
        if (!a) {
          var noteId = d.id;
          a = { el: aEl, notes: [], badge: null, strip: null, tip: null };
          a.badge = ensureOverlayNode(noteId, 'badge', BADGE_CSS, function (ev) { toggleTipFor(noteId, ev); });
          a.strip = ensureOverlayNode(noteId, 'strip', STRIP_CSS, function (ev) { toggleTipFor(noteId, ev); });
          annotations[d.id] = a;
        }
        a.notes.push(d.text || '');
        a.badge.textContent = String(a.notes.length);
        a.strip.textContent = d.text || '';
        repositionAnnotations();
        return;
      }
      if (d.action === 'remove-annotation') {
        var ra = annotations[d.id];
        if (ra) {
          ra.notes.pop();
          if (ra.notes.length === 0) { removeAnnotationNodes(ra); delete annotations[d.id]; }
          else { ra.badge.textContent = String(ra.notes.length); if (ra.tip) ra.tip.style.display = 'none'; }
        } else {
          // 注册表缺失时兜底清理（旧节点残留）
          var ob = document.getElementById('proma-ctf-badge-' + d.id);
          var ot = document.getElementById('proma-ctf-tip-' + d.id);
          var os = document.getElementById('proma-ctf-strip-' + d.id);
          if (ob) ob.remove(); if (ot) ot.remove(); if (os) os.remove();
        }
        return;
      }
      if (d.action === 'undo') { undoChange(d.id); return; }
      if (d.action === 'undo-all') {
        Object.keys(originalStyles).forEach(function (id) { undoChange(id); });
        Object.keys(annotations).forEach(function (id) { removeAnnotationNodes(annotations[id]); delete annotations[id]; });
        // 兜底清扫（Y5：含 strip；防注册表外残留）
        var badges = document.querySelectorAll('[id^="proma-ctf-badge-"], [id^="proma-ctf-tip-"], [id^="proma-ctf-strip-"]');
        for (var i = 0; i < badges.length; i++) badges[i].remove();
        return;
      }
      if (d.action === 'drag-start') {
        var el = document.querySelector('[data-ai-id="' + d.id + '"]');
        if (!el) return;
        rememberOriginal(el);
        // P2a：换目标元素时先退出旧拖拽模式（解绑旧元素 pointerdown/cursor）
        exitDragMode();
        var dragId = d.id;
        // P2a：持续模式——pointerdown 常驻（不再 once），每轮拖动独立上报；exitDragMode 统一解绑
        var pointerDown = function (ev) {
          if (!dragMode || dragMode.el !== el) return;
          var sx = ev.clientX, sy = ev.clientY, active = true, lastDx = 0, lastDy = 0;
          var prevInline = el.style.transform || '';
          // P2b：基线取 computed transform 的 tx/ty（含样式表 transform），首拖不跳变
          var base = computedTranslateOf(el);
          var mv = function (ev2) {
            if (!active) return;
            var dx = ev2.clientX - sx, dy = ev2.clientY - sy;
            lastDx = dx; lastDy = dy;
            el.style.transform = 'translate(' + (base.tx + dx) + 'px, ' + (base.ty + dy) + 'px)';
          };
          var finish = function (dx, dy) {
            active = false;
            document.removeEventListener('mousemove', mv);
            document.removeEventListener('mouseup', up);
            el.removeEventListener('mouseleave', leave);
            var rdx = Math.round(dx), rdy = Math.round(dy);
            // 位移小于阈值视为误触（点击未拖动），还原且不上报；阈值按 devicePixelRatio 归一（Y7 高分屏）
            var th = 4 * (window.devicePixelRatio || 1);
            armDragIdleTimer();
            if (Math.abs(rdx) < th && Math.abs(rdy) < th) {
              el.style.transform = prevInline;
              return;
            }
            el.style.transform = 'translate(' + (base.tx + rdx) + 'px, ' + (base.ty + rdy) + 'px)';
            // 拖拽结束后的 click 不再触发点选面板（仅限该元素）
            suppressClickUntil = Date.now() + 400;
            suppressClickTarget = el;
            // P2b：上报绝对偏移 absX/absY（最终 computed transform 的 tx/ty），
            // 调度员写死 translate(absX,absY) 即所见即所得；dx/dy 保留兼容
            var abs = computedTranslateOf(el);
            reportToHost({ kind: 'change-result', id: dragId, action: 'move', ok: true, type: el.getAttribute('data-ai-type') || '元素', text: (el.innerText || el.value || '').trim().slice(0, 40), value: { dx: rdx, dy: rdy, absX: Math.round(abs.tx), absY: Math.round(abs.ty) } });
          };
          var up = function (ev2) { finish(ev2.clientX - sx, ev2.clientY - sy); };
          // 兜底：拖出 iframe 后指针事件被宿主截走时，以最后已知位移收口
          var leave = function () { if (active) finish(lastDx, lastDy); };
          // R1：pointer capture 到元素——拖出 iframe 边界后 move/up 仍派发给元素，不丢 mouseup
          try { el.setPointerCapture(ev.pointerId); } catch (err) { /* 降级：document 级监听 */ }
          document.addEventListener('mousemove', mv);
          document.addEventListener('mouseup', up);
          el.addEventListener('mouseleave', leave);
          ev.preventDefault();
        };
        dragMode = { el: el, id: dragId, timer: null, pointerDown: pointerDown };
        el.style.cursor = 'move';
        el.addEventListener('pointerdown', pointerDown);
        armDragIdleTimer();
        return;
      }
      if (d.action === 'text-edit') {
        var tEl = document.querySelector('[data-ai-id="' + d.id + '"]');
        if (!tEl) return;
        var tag = tEl.tagName;
        var nativeEditable = tag === 'TEXTAREA' || (tag === 'INPUT' && ['text', 'search', 'url', 'tel', 'password'].indexOf(String(tEl.type || 'text')) >= 0);
        // P1：替换元素（IMG/VIDEO/非文本 INPUT 等）或无可编辑文本 → 退化上报，宿主切输入框走「其他」路径
        if (!nativeEditable) {
          var replacedTags = ['IMG', 'VIDEO', 'AUDIO', 'CANVAS', 'SVG', 'IFRAME', 'EMBED', 'OBJECT', 'INPUT', 'SELECT'];
          if (replacedTags.indexOf(tag) >= 0 || !(tEl.innerText || '').trim()) {
            reportToHost({ kind: 'text-edit-degraded', id: d.id });
            return;
          }
        }
        rememberOriginal(tEl);
        var tOrig = originalStyles[d.id];
        if (!tOrig.textSaved) {
          tOrig.textSaved = true;
          tOrig.textSnapshot = nativeEditable ? String(tEl.value || '') : String(tEl.innerText || '');
        }
        if (nativeEditable) {
          // P1：原生输入控件直接 focus+select 原地编辑；Enter 确认（textarea Ctrl/Cmd+Enter，Enter 换行），Esc 取消，blur 确认
          var nPrev = String(tEl.value || '');
          var nDone = false;
          var nFinish = function (commit, restore) {
            if (nDone) return;
            nDone = true;
            tEl.removeEventListener('keydown', nKey, true);
            tEl.removeEventListener('blur', nBlur);
            if (restore) tEl.value = nPrev;
            var nAfter = String(tEl.value || '').trim();
            if (commit && nAfter !== nPrev.trim()) {
              suppressClickUntil = Date.now() + 400;
              suppressClickTarget = tEl;
              reportToHost({ kind: 'change-result', id: d.id, action: 'text', ok: true, type: tEl.getAttribute('data-ai-type') || '元素', text: nAfter.slice(0, 40), value: nAfter });
            }
          };
          var nKey = function (ev) {
            if (ev.key === 'Escape') { ev.preventDefault(); nFinish(false, true); }
            else if (ev.key === 'Enter' && (tag === 'INPUT' || ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); nFinish(true, false); }
          };
          var nBlur = function () { nFinish(true, false); };
          tEl.addEventListener('keydown', nKey, true);
          tEl.addEventListener('blur', nBlur);
          tEl.focus();
          try { tEl.select(); } catch (eSelect) { /* 选区失败不影响直接输入 */ }
          return;
        }
        // P1：通用元素 contentEditable 原地编辑：focus + 全选现有文本；Enter/blur 确认，Esc 取消
        var cPrevAttr = tEl.getAttribute('contenteditable');
        var cPrev = String(tEl.innerText || '');
        var cDone = false;
        var cFinish = function (commit, restore) {
          if (cDone) return;
          cDone = true;
          tEl.removeEventListener('keydown', cKey, true);
          tEl.removeEventListener('blur', cBlur);
          if (cPrevAttr === null) tEl.removeAttribute('contenteditable'); else tEl.setAttribute('contenteditable', cPrevAttr);
          if (restore) tEl.innerText = cPrev;
          var cAfter = String(tEl.innerText || '').trim();
          if (commit && cAfter !== cPrev.trim()) {
            suppressClickUntil = Date.now() + 400;
            suppressClickTarget = tEl;
            reportToHost({ kind: 'change-result', id: d.id, action: 'text', ok: true, type: tEl.getAttribute('data-ai-type') || '元素', text: cAfter.slice(0, 40), value: cAfter });
          }
        };
        var cKey = function (ev) {
          if (ev.key === 'Escape') { ev.preventDefault(); cFinish(false, true); }
          else if (ev.key === 'Enter') { ev.preventDefault(); cFinish(true, false); }
        };
        var cBlur = function () { cFinish(true, false); };
        tEl.setAttribute('contenteditable', 'true');
        tEl.addEventListener('keydown', cKey, true);
        tEl.addEventListener('blur', cBlur);
        tEl.focus();
        try {
          var sel = window.getSelection();
          var rng = document.createRange();
          rng.selectNodeContents(tEl);
          sel.removeAllRanges();
          sel.addRange(rng);
        } catch (eSel) { /* 选区失败不影响直接输入 */ }
        return;
      }
      var result = applyChange(d.action, d.id, d.value);
      reportToHost({ kind: 'change-result', id: d.id, action: d.action, ok: result.ok, error: result.error || '', value: d.value });
    } catch (err) {
      try {
        reportToHost({ kind: 'change-result', id: d.id, action: d.action, ok: false, error: String(err && err.message ? err.message : err) });
      } catch (e2) { /* 回报也失败则彻底静默 */ }
    }
  });
})();
`

/**
 * 点选纠错（Click-to-Fix）iframe 注入脚本 —— 单一事实源（AC-R2 Y8）
 *
 * 依据 /home/orphic/proma-projDoc/DesignDoc/02_UX_DESIGN/interaction-spec.md 交互1：
 * 用户在预览区点击原型元素 → 事件委托捕获 data-ai-id/data-ai-type →
 * 3 秒高亮（document 级覆盖层）→ postMessage 通知宿主（Proma 渲染进程）。
 * 宿主 → iframe 指令（__promaCtfApply）：color/delete/move/drag-start/text-edit/undo/undo-all/
 * annotate/remove-annotation，即时生效、可撤销。v0.17.58：text-edit 原地编辑；拖拽改会话级
 * 持续模式 + 绝对偏移（absX/absY）上报（拖拽基线取 computed transform，覆盖样式表歧义）。
 * v0.17.59（WO1）：computed transform 完整矩阵解析（parseMatrixFull）+ 序列化器
 * （applyTranslate，m16 的 tz/旋转/缩放分量不再丢）；finish 上报 finalTransform 一等字段
 * （写入 el.style.transform 的同一字符串）；undo 按 value.action 选择性还原（同元素多动作
 * 撤销粒度互不影响）；拖拽会话 abort 守卫（exitDragMode 中止进行中的拖动并还原）；
 * textSnapshot 按控件形态分支（value / innerHTML 结构快照）；textEditingEl 守卫（原地编辑
 * 中点击不误弹面板，修改类指令/undo-all 清空）；nativeEditable 白名单补 email/number。
 *
 * ⚠️ 本文件是注入脚本的唯一事实源：local-file-protocol.ts 把本常量包进 <script> 标签
 * 注入 proma-file:// HTML 响应。历史上 renderer/lib/click-to-fix.ts 的可读副本 + 协议层
 * minified tag 双源维护，v0.17.54 被迫同改两处、Round1 曾发生 ldx/ldy 分叉事故，已收敛到此。
 * 注意：脚本体是模板字面量字符串——正则的反斜杠须写 \\\\（双反斜杠），\\n 须写 \\\\n，禁止 ${ 插值。
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

  // v0.17.59（WO1①）：完整解析 computed transform（替换 v0.17.58 的 parseMatrixTranslate）。
  // m6 = matrix(a,b,c,d,tx,ty) 6 值（长度 <6 → none）；m16 = matrix3d(...) 16 值（严格
  // ===16 校验，不再 >=14 宽容）；none/空/畸形 → kind:'none'。平移槽：m6=[4]/[5]，m16=[12]/[13]
  function parseMatrixFull(tr) {
    if (!tr || tr === 'none') return { kind: 'none' };
    var mm = String(tr).match(/matrix3d\\(([^)]+)\\)/);
    if (mm) {
      var p16 = mm[1].split(',');
      if (p16.length === 16) {
        var v16 = [];
        for (var i = 0; i < 16; i++) v16.push(parseFloat(p16[i]) || 0);
        return { kind: 'm16', m16: v16 };
      }
      return { kind: 'none' };
    }
    var m6 = String(tr).match(/matrix\\(([^)]+)\\)/);
    if (!m6) return { kind: 'none' };
    var p6 = m6[1].split(',');
    if (p6.length < 6) return { kind: 'none' };
    var v6 = [];
    for (var j = 0; j < 6; j++) v6.push(parseFloat(p6[j]) || 0);
    return { kind: 'm6', m6: v6 };
  }

  // v0.17.59（WO1②）：矩阵序列化器——在解析结果上叠加平移 (dx,dy)。
  // m6 改 [4]/[5]，m16 改 [12]/[13]，其余值原样保留（含 m16[14] 的 tz、旋转/缩放分量）。
  // 输出：none → translate(x,y)；m6 线性部 (a,b,c,d)==(1,0,0,1) → translate(x,y)
  // （保持 e2e 断言 translate(51px, -5px) 的格式与空格风格不变）；m6 非单位 → matrix(...)；
  // m16 → matrix3d(...) 16 值原样
  function applyTranslate(parsed, dx, dy) {
    if (parsed.kind === 'm16') {
      var m16 = parsed.m16.slice();
      m16[12] = Math.round(m16[12] + dx);
      m16[13] = Math.round(m16[13] + dy);
      return 'matrix3d(' + m16.join(', ') + ')';
    }
    if (parsed.kind === 'm6') {
      var m = parsed.m6;
      if (m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1) {
        return 'translate(' + Math.round(m[4] + dx) + 'px, ' + Math.round(m[5] + dy) + 'px)';
      }
      var m6o = m.slice();
      m6o[4] = Math.round(m6o[4] + dx);
      m6o[5] = Math.round(m6o[5] + dy);
      return 'matrix(' + m6o.join(', ') + ')';
    }
    return 'translate(' + Math.round(dx) + 'px, ' + Math.round(dy) + 'px)';
  }

  function computedMatrixOf(el) {
    try { return parseMatrixFull(window.getComputedStyle(el).transform); }
    catch (e) { return { kind: 'none' }; }
  }

  // 平移分量读取（absX/absY 上报用；v0.17.59 起由 parseMatrixFull 派生）
  function computedTranslateOf(el) {
    var p = computedMatrixOf(el);
    if (p.kind === 'm6') return { tx: p.m6[4] || 0, ty: p.m6[5] || 0 };
    if (p.kind === 'm16') return { tx: p.m16[12] || 0, ty: p.m16[13] || 0 };
    return { tx: 0, ty: 0 };
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
  // W24-EF F2（v0.17.123）：框选刚结束后抑制「同一释放坐标」100ms 内的合成 click（防双发 blank-click）
  var boxSelectClickSuppressUntil = 0;
  var boxSelectReleaseX = -1;
  var boxSelectReleaseY = -1;
  // ===== P2a：拖拽会话级持续模式 =====
  // dragMode 非空时：目标元素反复可拖（pointerdown 常驻，不再 once）；该元素 click 不弹面板；
  // 退出：其他修改指令 / undo-all / 30s 无拖动 / 点击其他 data-ai-id 元素（用户转去做别的）
  // v0.17.59（M9）：形状 { el, timer, pointerDown, abort }——abort 为进行中拖拽会话的中止器
  //（pointerDown 时挂入），exitDragMode 统一调用；旧 id 字段为死代码已删
  var dragMode = null; // { el, timer, pointerDown, abort }
  // v0.17.59（WO1⑧）：当前原地编辑文本的元素——click 捕获守卫（编辑中点击不误弹面板），
  // 修改类指令（豁免表同 exitDragMode：annotate/remove-annotation/undo/drag-start）与 undo-all 清空
  var textEditingEl = null;

  function exitDragMode() {
    if (!dragMode) return;
    if (dragMode.timer) clearTimeout(dragMode.timer);
    // v0.17.59（M8/WO1⑤）：中止进行中的拖拽会话——active 时还原 prevInline；
    // 监听移除无条件执行（与 finish 幂等互斥，重复调用无副作用）
    if (typeof dragMode.abort === 'function') { try { dragMode.abort(); } catch (e) {} }
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

    // W24-6（用户裁定 2026-09-13）：tab/分页类元素（顶部横向分页窄条的场景导航项）
    // 是切视图控件——点击应执行原生切换，不弹点选面板不高亮不上报（要改仍可在输入框
    // 点名描述）。两代生成器实测命名不统一：类型值 标签页/标签/tab…、id 含 nav/tab
    //（nav-scene-tabs / tab-us01 / scene-tab-us02）——双规则并集判定。
    if (target) {
      var navType = String(target.getAttribute('data-ai-type') || '').trim();
      var navId = String(target.getAttribute('data-ai-id') || '').trim();
      if (/^(标签页|标签|选项卡|切换|tab|分页|页签|导航)$/i.test(navType) || /(^|[-_])(nav|tab)/i.test(navId)) return;
    }

    // v0.17.59（WO1⑧）：原地编辑中的元素（或其内部节点）的点击不当作点选——
    // 防止打断编辑/误弹面板；编辑结束（finish/blur）或指令清空后恢复
    if (textEditingEl && (target === textEditingEl || (textEditingEl.contains && textEditingEl.contains(target)))) return;

    // P2a：拖拽模式下点击其他 data-ai-id 元素 = 用户转去做别的，退出拖拽模式并照常弹面板
    if (dragMode && target && target !== dragMode.el) exitDragMode();
    // P2a：拖拽模式下目标元素自身的 click 一律不弹点选面板（用户还在拖，面板反而干扰）
    if (dragMode && target === dragMode.el) return;

    // Y7：拖拽刚结束的 click 只对拖拽起点元素生效（不吞对其他元素的快速点选）
    if (Date.now() < suppressClickUntil && e.target === suppressClickTarget) { suppressClickUntil = 0; suppressClickTarget = null; return; }

    // W24-EF F2（v0.17.123）：框选刚结束的合成 click —— 仅抑制「框选释放坐标附近」的
    // click（同一释放交互），避免误报 blank-click；其他位置 100ms 内的正常点选不受影响。
    if (Date.now() < boxSelectClickSuppressUntil) {
      if (typeof e.clientX === 'number' && typeof e.clientY === 'number'
        && Math.abs(e.clientX - boxSelectReleaseX) < 4
        && Math.abs(e.clientY - boxSelectReleaseY) < 4) {
        return;
      }
    }

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

  // ===== W24-EF F2（v0.17.123）：框选多元素批量点选 =====
  // 设计语义：用户在原型上按下空旷区域并拖动 → 出现选区框 → 松手时收集所有被框选
  // 且带 data-ai-id 的元素（tab/分页类与 w24-6 同型排除，过滤背景只保留有 id 元素），
  // 上报 kind='box-select' 给宿主。3 秒高亮（每元素独立高亮框），空选不上报、不报错。
  //
  // 边界：
  // - 与现有 click 互不抢占：mousedown 在 capture 阶段设定 starting flag，仅当 click target
  //   不是带 data-ai-id 的元素（背景）时进入框选会话；若鼠标是选中 data-ai-id 元素的单击，
  //   仍走 click 路径（元素点选）；
  // - 与拖拽会话互不抢占：dragMode 非空时跳过框选（拖拽正在进行）；
  // - 与 overlay 互不抢占：起点在 overlay（proma-ctf-*）直接返回。
  // - 状态结构：{ startX, startY, x1, y1, x2, y2, layer, marquee, highlights, timer }
  //   marquee 是选区框，highlights 是被框选元素的 3 秒高亮覆盖层列表。

  function isInteractiveTabEl(el) {
    // 与 click 处理 w24-6 同型：tab/分页类元素不可被框选上报（原生切视图控件）
    if (!el || !el.getAttribute) return false;
    var navType = String(el.getAttribute('data-ai-type') || '').trim();
    var navId = String(el.getAttribute('data-ai-id') || '').trim();
    if (/^(标签页|标签|选项卡|切换|tab|分页|页签|导航)$/i.test(navType)) return true;
    if (/(^|[-_])(nav|tab)/i.test(navId)) return true;
    return false;
  }

  function ensureBoxSelectLayers() {
    var parent = document.documentElement;
    var layers = parent.__promaBoxSelectLayers;
    if (!layers) {
      var marquee = document.createElement('div');
      marquee.id = 'proma-ctf-box-marquee';
      marquee.style.cssText = 'position:absolute;border:2px dashed #4F46E5;background:rgba(79,70,229,0.08);pointer-events:none;z-index:2147483646;display:none;';
      parent.appendChild(marquee);
      layers = { marquee: marquee, highlights: [] };
      parent.__promaBoxSelectLayers = layers;
    }
    return layers;
  }

  function clearBoxSelectHighlight(layers) {
    if (!layers) return;
    for (var i = 0; i < layers.highlights.length; i++) {
      var node = layers.highlights[i];
      if (node && node.parentNode) node.parentNode.removeChild(node);
    }
    layers.highlights = [];
  }

  // 中心点落框判定：元素中心落在选框内才选中，避免大型容器仅边缘轻触即被过选
  function rectCenterInBox(rect, box) {
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    return cx >= box.left && cx <= box.right && cy >= box.top && cy <= box.bottom;
  }

  function performBoxSelect() {
    try {
      if (!boxSelect || !boxSelect.layer) return;
      var layers = boxSelect.layer;
      var x1 = Math.min(boxSelect.x1, boxSelect.x2);
      var y1 = Math.min(boxSelect.y1, boxSelect.y2);
      var x2 = Math.max(boxSelect.x1, boxSelect.x2);
      var y2 = Math.max(boxSelect.y1, boxSelect.y2);
      var marqueeRect = { left: x1, right: x2, top: y1, bottom: y2 };

      // 收集所有 data-ai-id 元素，过滤 tab/分页、不可见、中心不在框内（中心点落框，防轻触过选）
      var all = document.querySelectorAll('[data-ai-id]');
      var picked = [];
      var pickedEls = [];
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (isInteractiveTabEl(el)) continue;
        var r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (!rectCenterInBox(r, marqueeRect)) continue;
        picked.push({ id: el.getAttribute('data-ai-id'), type: el.getAttribute('data-ai-type') || '元素' });
        pickedEls.push(el);
      }

      // 重置高亮：清旧 + 画新
      clearBoxSelectHighlight(layers);
      layers.marquee.style.display = 'none';

      if (picked.length === 0) {
        // 空选：不上报，不报错；按 EF §3.2 BDD #1「空选不报错误」
        boxSelect = null;
        return;
      }

      // 为每个被框选元素画 3 秒高亮覆盖层（直接用元素引用，避免按 id 二次 querySelector 的选择器转义面）
      for (var j = 0; j < pickedEls.length; j++) {
        var el2 = pickedEls[j];
        var r2 = el2.getBoundingClientRect();
        var hl = document.createElement('div');
        hl.className = 'proma-ctf-box-highlight';
        hl.style.cssText = 'position:absolute;border:2px solid #4F46E5;border-radius:6px;pointer-events:none;z-index:2147483647;background:rgba(79,70,229,0.08);transition:all .15s ease;';
        hl.style.top = (r2.top + window.scrollY) + 'px';
        hl.style.left = (r2.left + window.scrollX) + 'px';
        hl.style.width = r2.width + 'px';
        hl.style.height = r2.height + 'px';
        document.documentElement.appendChild(hl);
        layers.highlights.push(hl);
      }
      setTimeout(function () {
        clearBoxSelectHighlight(layers);
      }, 3000);

      // 上报：含 id 与 type 列表；不含 text/rect/innerText（隐私最小，与单点击一致）
      reportToHost({ kind: 'box-select', items: picked });
      boxSelect = null;
    } catch (err) {
      // 框选结算异常不阻断注入脚本：清状态、隐藏选区框，静默（不误报 blank-click、不抛裸错）
      var bs = boxSelect;
      boxSelect = null;
      if (bs && bs.layer) { try { bs.layer.marquee.style.display = 'none'; } catch (e2) {} }
    }
  }

  var boxSelect = null;

  document.addEventListener('mousedown', function (e) {
    // 仅左键进入框选（右键/中键拖拽不进框选）
    if (typeof e.button === 'number' && e.button !== 0) return;
    // 起点在 overlay / proma-ctf-* 上：不进入框选（属 overlay 自身交互）
    var tid = e.target && e.target.id ? String(e.target.id) : '';
    if (tid.indexOf('proma-ctf-') === 0) return;
    // 拖拽会话期间不进入框选（与拖拽互不抢占）
    if (dragMode) return;
    // 起点本身是带 data-ai-id 的元素：留给 click 路径处理（用户对单元素的意图）
    if (e.target && e.target.closest && e.target.closest('[data-ai-id]')) return;
    // 起点在 input/textarea/contenteditable：不进入框选（让文本选区工作）
    var tag = e.target && e.target.tagName ? String(e.target.tagName) : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;

    var layers = ensureBoxSelectLayers();
    boxSelect = {
      startX: e.clientX,
      startY: e.clientY,
      x1: e.clientX,
      y1: e.clientY,
      x2: e.clientX,
      y2: e.clientY,
      layer: layers,
    };
    layers.marquee.style.top = (e.clientY + window.scrollY) + 'px';
    layers.marquee.style.left = (e.clientX + window.scrollX) + 'px';
    layers.marquee.style.width = '0px';
    layers.marquee.style.height = '0px';
    layers.marquee.style.display = '';
    try { e.preventDefault(); } catch (e0) { /* swallow */ }
  }, true);

  document.addEventListener('mousemove', function (e) {
    if (!boxSelect) return;
    boxSelect.x2 = e.clientX;
    boxSelect.y2 = e.clientY;
    var x1 = Math.min(boxSelect.x1, boxSelect.x2);
    var y1 = Math.min(boxSelect.y1, boxSelect.y2);
    var x2 = Math.max(boxSelect.x1, boxSelect.x2);
    var y2 = Math.max(boxSelect.y1, boxSelect.y2);
    var layers = boxSelect.layer;
    layers.marquee.style.left = (x1 + window.scrollX) + 'px';
    layers.marquee.style.top = (y1 + window.scrollY) + 'px';
    layers.marquee.style.width = (x2 - x1) + 'px';
    layers.marquee.style.height = (y2 - y1) + 'px';
  }, true);

  document.addEventListener('mouseup', function (e) {
    if (!boxSelect) return;
    var dx = Math.abs(boxSelect.x2 - boxSelect.x1);
    var dy = Math.abs(boxSelect.y2 - boxSelect.y1);
    // 微抖动（<3px）视作单击，不进入框选结算；让 click 路径正常处理
    if (dx < 3 && dy < 3) {
      boxSelect.layer.marquee.style.display = 'none';
      boxSelect = null;
      return;
    }
    // 跨阈值 → 框选结算。记录释放坐标 + 设 100ms 抑制窗口（仅抑制同一释放坐标的合成 click）。
    boxSelectReleaseX = e.clientX;
    boxSelectReleaseY = e.clientY;
    boxSelectClickSuppressUntil = Date.now() + 100;
    performBoxSelect();
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
  // v0.17.59（WO1⑥）：按 value.action 选择性还原——宿主单撤清单某条时只还原该动作
  // 触碰的属性，同元素的其它动作不受影响（撤销粒度）；value 缺失（undo-all / 旧报文）→
  // 全量还原（兼容既有行为）
  function undoChange(id, value) {
    var el = document.querySelector('[data-ai-id="' + id + '"]');
    var orig = originalStyles[id];
    if (!el || !orig) return { ok: false };
    var act = value && value.action ? String(value.action) : '';
    if (act === 'color') {
      // 应用路径设的是 backgroundColor（applyChange :282）——选择性还原必须同步还原
      // bg 与 color 两个属性（与全量还原 :322-323 对齐），只还原 color 会残留背景色
      el.style.backgroundColor = orig.bg;
      el.style.color = orig.color;
    } else if (act === 'move') {
      el.style.transform = orig.transform;
    } else if (act === 'text') {
      // WO1⑦：结构快照按控件形态分支还原（INPUT/TEXTAREA → value；否则整树 innerHTML）
      if (orig.textSaved) {
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.value = orig.textSnapshot || '';
        else el.innerHTML = orig.textSnapshot || '';
      }
    } else if (act === 'delete') {
      el.style.opacity = orig.opacity;
      el.style.textDecoration = '';
    } else {
      el.style.backgroundColor = orig.bg;
      el.style.color = orig.color;
      el.style.opacity = orig.opacity;
      el.style.transform = orig.transform;
      el.style.textDecoration = '';
      if (orig.textSaved) {
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.value = orig.textSnapshot || '';
        else el.innerHTML = orig.textSnapshot || '';
      }
    }
    // 裁决补充（WO1⑥）：text-edit 异常中断残留的 contenteditable='true' 顺手清理
    if (el.getAttribute('contenteditable') === 'true') el.removeAttribute('contenteditable');
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
      // v0.17.59（WO1⑧）：原地编辑被打断——修改类指令与 undo-all 清空 textEditingEl
      //（豁免表同 exitDragMode：annotate/remove-annotation/undo/drag-start 不清）
      if (textEditingEl && d.action !== 'drag-start' && d.action !== 'annotate' && d.action !== 'remove-annotation' && d.action !== 'undo') {
        textEditingEl = null;
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
      // v0.17.59（WO3②）：undo 报文携带 value.action → 选择性还原
      if (d.action === 'undo') { undoChange(d.id, d.value); return; }
      if (d.action === 'undo-all') {
        textEditingEl = null;
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
          // v0.17.59（M3）：交互起点即重置 idle 计时（防长按未动期间 30s 计时器到期误退场）
          armDragIdleTimer();
          var sx = ev.clientX, sy = ev.clientY, active = true, lastDx = 0, lastDy = 0;
          var prevInline = el.style.transform || '';
          // v0.17.59（WO1③）：基线取 computed transform 的完整矩阵（含样式表 transform、
          // 旋转/缩放/translateZ），拖动全程用序列化器叠加平移——3D/旋转分量不再被压平
          var base = computedMatrixOf(el);
          var mv = function (ev2) {
            if (!active) return;
            var dx = ev2.clientX - sx, dy = ev2.clientY - sy;
            lastDx = dx; lastDy = dy;
            el.style.transform = applyTranslate(base, dx, dy);
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
            // v0.17.59（WO1④）：终态串单一来源——写入 el.style.transform 与上报 finalTransform
            // 用同一个字符串，宿主/调度员直接写死即所见即所得（矩阵序列化只在注入脚本内发生）
            var finalT = applyTranslate(base, rdx, rdy);
            el.style.transform = finalT;
            // 拖拽结束后的 click 不再触发点选面板（仅限该元素）
            suppressClickUntil = Date.now() + 400;
            suppressClickTarget = el;
            // P2b：上报绝对偏移 absX/absY（最终 computed transform 的 tx/ty）+ finalTransform
            // 终态串；dx/dy 保留兼容
            var abs = computedTranslateOf(el);
            reportToHost({ kind: 'change-result', id: dragId, action: 'move', ok: true, type: el.getAttribute('data-ai-type') || '元素', text: (el.innerText || el.value || '').trim().slice(0, 40), value: { dx: rdx, dy: rdy, absX: Math.round(abs.tx), absY: Math.round(abs.ty), finalTransform: finalT } });
          };
          var up = function (ev2) { finish(ev2.clientX - sx, ev2.clientY - sy); };
          // 兜底：拖出 iframe 后指针事件被宿主截走时，以最后已知位移收口
          var leave = function () { if (active) finish(lastDx, lastDy); };
          // v0.17.59（M8/WO1⑤）：会话中止器——active 时还原 prevInline；监听移除无条件
          //（与 finish 幂等拆分，abort 挂到 dragMode 供 exitDragMode 调用）
          var abort = function () {
            if (active) { active = false; el.style.transform = prevInline; }
            document.removeEventListener('mousemove', mv);
            document.removeEventListener('mouseup', up);
            el.removeEventListener('mouseleave', leave);
          };
          // R1：pointer capture 到元素——拖出 iframe 边界后 move/up 仍派发给元素，不丢 mouseup
          try { el.setPointerCapture(ev.pointerId); } catch (err) { /* 降级：document 级监听 */ }
          document.addEventListener('mousemove', mv);
          document.addEventListener('mouseup', up);
          el.addEventListener('mouseleave', leave);
          dragMode.abort = abort;
          ev.preventDefault();
        };
        dragMode = { el: el, timer: null, pointerDown: pointerDown, abort: null };
        el.style.cursor = 'move';
        el.addEventListener('pointerdown', pointerDown);
        armDragIdleTimer();
        return;
      }
      if (d.action === 'text-edit') {
        var tEl = document.querySelector('[data-ai-id="' + d.id + '"]');
        if (!tEl) return;
        var tag = tEl.tagName;
        // v0.17.59（WO9）：原生可编辑白名单补 email/number（纯文本输入型，可 focus+select 键入）；
        // date/time/datetime-local/month/week/range/color/checkbox/radio/file 等选择器型
        // 有意排除——弹原生选择 UI 无法键入，走 degraded 由宿主切输入框路径
        var nativeEditable = tag === 'TEXTAREA' || (tag === 'INPUT' && ['text', 'search', 'url', 'tel', 'password', 'email', 'number'].indexOf(String(tEl.type || 'text')) >= 0);
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
          // v0.17.59（WO1⑦）：快照按控件形态分支——原生控件存 value，其余存 innerHTML
          //（结构快照，undo 整树还原，防 innerText 重建子树丢嵌套标签）
          tOrig.textSnapshot = nativeEditable ? String(tEl.value || '') : String(tEl.innerHTML || '');
        }
        textEditingEl = tEl;
        if (nativeEditable) {
          // P1：原生输入控件直接 focus+select 原地编辑；Enter 确认（textarea Ctrl/Cmd+Enter，Enter 换行），Esc 取消，blur 确认
          var nPrev = String(tEl.value || '');
          var nDone = false;
          var nFinish = function (commit, restore) {
            if (nDone) return;
            nDone = true;
            if (textEditingEl === tEl) textEditingEl = null;
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
        // v0.17.59（WO1⑦）：Esc 还原用结构快照（innerHTML），防 innerText 重建丢嵌套标签
        var cPrevHTML = String(tEl.innerHTML || '');
        var cDone = false;
        var cFinish = function (commit, restore) {
          if (cDone) return;
          cDone = true;
          if (textEditingEl === tEl) textEditingEl = null;
          tEl.removeEventListener('keydown', cKey, true);
          tEl.removeEventListener('blur', cBlur);
          if (cPrevAttr === null) tEl.removeAttribute('contenteditable'); else tEl.setAttribute('contenteditable', cPrevAttr);
          if (restore) tEl.innerHTML = cPrevHTML;
          var cAfter = String(tEl.innerText || '').trim();
          if (commit && cAfter !== cPrevHTML.trim()) {
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

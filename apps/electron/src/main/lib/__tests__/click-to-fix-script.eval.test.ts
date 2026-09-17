/**
 * WO5.1（v0.17.59）：注入脚本 eval 沙箱测试
 *
 * 把 CLICK_TO_FIX_INJECT_SCRIPT 用 new Function 在桩 window/document/parent/
 * getComputedStyle 环境里还原执行，通过 message 监听驱动真实指令路径，断言：
 * - parseMatrixFull / applyTranslate 序列化器：m6 identity / rotate / scale、
 *   m16 tz≠0 时 [14] 保留、none、畸形 <6 / <16
 * - WO1④：finish 上报 finalTransform 一等字段 = 写入 el.style.transform 的同一字符串
 * - M8/WO1⑤：exitDragMode 中止进行中的拖拽会话并还原 prevInline
 * - e2e 断言语义：translate(51px, -5px) 输出格式（含空格风格）不变
 * - W24-EF F2：框选多元素批量点选（仅 F2 范围增补，详见末尾 describe）
 */
import { describe, expect, test } from 'bun:test'
import { CLICK_TO_FIX_INJECT_SCRIPT } from '../click-to-fix-script'

// ===== 桩 DOM =====

type Listener = (ev: Record<string, unknown>) => void

function makeStyle(): Record<string, string> {
  // Proxy 兜住任意 style 属性读写（transform/cursor/display/...）
  const store: Record<string, string> = {}
  return new Proxy(store, {
    get(t, p: string) {
      if (p === 'cssText') return Object.entries(t).map(([k, v]) => `${k}:${v}`).join(';')
      return t[p] ?? ''
    },
    set(t, p: string, v) {
      t[p] = String(v)
      return true
    },
  })
}

class StubEl {
  tagName: string
  type = 'text'
  attributes = new Map<string, string>()
  style = makeStyle()
  listeners = new Map<string, Listener[]>()
  parentElement: StubEl | null = null
  children: StubEl[] = []
  value = ''
  _innerText = ''
  _innerHTML = ''
  _computed: string | null = null // 样式表级 computed transform 基线（inline 未设时生效）
  isConnected = true
  _focused = false

  constructor(tag = 'DIV') {
    this.tagName = tag
  }
  get innerText() { return this._innerText }
  set innerText(v: string) { this._innerText = String(v) }
  get innerHTML() { return this._innerHTML }
  set innerHTML(v: string) { this._innerHTML = String(v) }
  get id() { return this.getAttribute('id') ?? '' }
  set id(v: string) { this.setAttribute('id', v) }
  getAttribute(n: string) { return this.attributes.has(n) ? this.attributes.get(n)! : null }
  setAttribute(n: string, v: string) { this.attributes.set(n, String(v)) }
  removeAttribute(n: string) { this.attributes.delete(n) }
  addEventListener(t: string, fn: Listener) {
    const arr = this.listeners.get(t) ?? []
    arr.push(fn)
    this.listeners.set(t, arr)
  }
  removeEventListener(t: string, fn: Listener) {
    const arr = (this.listeners.get(t) ?? []).filter((f) => f !== fn)
    this.listeners.set(t, arr)
  }
  dispatch(t: string, ev: Record<string, unknown>) {
    for (const fn of [...(this.listeners.get(t) ?? [])]) fn(ev)
    return true
  }
  getBoundingClientRect() {
    return { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20 }
  }
  closest(sel: string): StubEl | null {
    // 覆盖注入脚本唯一用法 closest('[data-ai-id]')：自身上带该属性即命中
    return sel === '[data-ai-id]' && this.attributes.has('data-ai-id') ? this : null
  }
  contains(n: unknown) { return n === this || this.children.includes(n as StubEl) }
  setPointerCapture() { /* no-op */ }
  focus() { this._focused = true }
  select() { /* no-op */ }
  remove() {
    if (this.parentElement) {
      const i = this.parentElement.children.indexOf(this)
      if (i >= 0) this.parentElement.children.splice(i, 1)
      this.parentElement = null
    }
    this.isConnected = false
  }
  appendChild(c: StubEl) {
    c.remove()
    c.parentElement = this
    this.children.push(c)
    return c
  }
}

interface Sandbox {
  winListeners: Map<string, Listener[]>
  docListeners: Map<string, Listener[]>
  elements: Map<string, StubEl>
  created: StubEl[]
  posted: Array<Record<string, unknown>>
  documentElement: StubEl
  send: (msg: Record<string, unknown>) => void
  el: (id: string, init?: { tag?: string, type?: string, computed?: string, text?: string }) => StubEl
}

/** 模拟 Chrome 计算值：translate(x,y) → matrix(1, 0, 0, 1, x, y)；其余原样 */
function normalizeComputed(tr: string): string {
  if (tr === 'none' || tr === '') return 'none'
  const m = tr.match(/^translate\(([\d.-]+)px, ([\d.-]+)px\)$/)
  if (m) return `matrix(1, 0, 0, 1, ${m[1]}, ${m[2]})`
  return tr
}

function buildSandbox(): Sandbox {
  const winListeners = new Map<string, Listener[]>()
  const docListeners = new Map<string, Listener[]>()
  const elements = new Map<string, StubEl>()
  const created: StubEl[] = []
  const posted: Array<Record<string, unknown>> = []
  const root = new StubEl('HTML')
  const parentStub = { postMessage: (payload: Record<string, unknown>) => { posted.push(payload) } }

  const documentStub = {
    documentElement: root,
    getElementById(id: string) {
      return created.find((n) => n.getAttribute('id') === id) ?? null
    },
    createElement(tag: string) {
      const n = new StubEl(tag)
      created.push(n)
      return n
    },
    querySelector(sel: string) {
      const m = sel.match(/^\[data-ai-id="(.+)"\]$/)
      const id = m?.[1]
      return id ? (elements.get(id) ?? null) : null
    },
    querySelectorAll(sel: string) {
      // 需覆盖三处：(1) undo-all 的 proma-ctf-* 清扫，(2) F2 框选的 [data-ai-id] 收集
      if (sel.includes('proma-ctf-')) {
        return created.filter((n) => (n.getAttribute('id') ?? '').startsWith('proma-ctf-'))
      }
      if (sel === '[data-ai-id]') {
        return Array.from(elements.values())
      }
      return []
    },
    addEventListener(t: string, fn: Listener) {
      const arr = docListeners.get(t) ?? []
      arr.push(fn)
      docListeners.set(t, arr)
    },
    removeEventListener(t: string, fn: Listener) {
      docListeners.set(t, (docListeners.get(t) ?? []).filter((f) => f !== fn))
    },
  }

  const windowStub = {
    __promaClickToFix: false,
    addEventListener(t: string, fn: Listener) {
      const arr = winListeners.get(t) ?? []
      arr.push(fn)
      winListeners.set(t, arr)
    },
    removeEventListener(t: string, fn: Listener) {
      winListeners.set(t, (winListeners.get(t) ?? []).filter((f) => f !== fn))
    },
    scrollX: 0,
    scrollY: 0,
    requestAnimationFrame: (fn: () => void) => { fn(); return 1 },
    devicePixelRatio: 1,
    getComputedStyle: (el: StubEl) => ({
      // 模拟 Chrome：inline transform 优先（级联）；且总是归一为 matrix/matrix3d 形式
      //（脚本自己写入的 translate(x,y) 在真实浏览器里 computed 读回就是 matrix(1,0,0,1,x,y)）
      transform: normalizeComputed(el.style.transform !== '' ? (el.style.transform ?? '') : (el._computed ?? 'none')),
    }),
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    createRange: () => ({ selectNodeContents() {} }),
  }

  const locationStub = { href: 'file:///stub.html' }

  // biome-ignore lint: 有意 eval 注入脚本体（沙箱测试）
  const run = new Function('window', 'document', 'parent', 'location', CLICK_TO_FIX_INJECT_SCRIPT)
  run(windowStub, documentStub, parentStub, locationStub)

  const send = (msg: Record<string, unknown>) => {
    for (const fn of [...(winListeners.get('message') ?? [])]) fn({ data: msg, source: parentStub })
  }

  const el = (id: string, init?: { tag?: string, type?: string, computed?: string, text?: string }) => {
    const n = new StubEl(init?.tag ?? 'DIV')
    n.setAttribute('data-ai-id', id)
    n.setAttribute('data-ai-type', '元素')
    if (init?.type) n.type = init.type
    if (init?.computed !== undefined) n._computed = init.computed
    if (init?.text) n._innerText = init.text
    elements.set(id, n)
    return n
  }

  return { winListeners, docListeners, elements, created, posted, documentElement: root, send, el }
}

/** 在沙箱里执行一轮真实拖拽（pointerdown → mousemove*2 → mouseup） */
function doDrag(sb: Sandbox, id: string, dx: number, dy: number): void {
  const node = sb.elements.get(id)!
  node.dispatch('pointerdown', { pointerId: 1, clientX: 100, clientY: 100, preventDefault() {} })
  const moves = [...(sb.docListeners.get('mousemove') ?? [])]
  for (const fn of moves) fn({ clientX: 100 + Math.round(dx / 2), clientY: 100 + Math.round(dy / 2) })
  for (const fn of moves) fn({ clientX: 100 + dx, clientY: 100 + dy })
  const ups = [...(sb.docListeners.get('mouseup') ?? [])]
  for (const fn of ups) fn({ clientX: 100 + dx, clientY: 100 + dy })
}

function lastMoveReport(sb: Sandbox): { value?: { finalTransform?: string, absX?: number, absY?: number, dx?: number, dy?: number } } | undefined {
  const moves = sb.posted.filter((p) => p.kind === 'change-result' && p.action === 'move')
  return moves[moves.length - 1] as ReturnType<typeof lastMoveReport>
}

describe('click-to-fix-script eval 沙箱：parseMatrixFull / 序列化器（WO1①②）', () => {
  test('m6 单位线性部：translate(51px, -5px) 精确格式（e2e 断言语义不变）', () => {
    const sb = buildSandbox()
    // 样式表基线 translate(31px,-9px) → Chrome computed: matrix(1, 0, 0, 1, 31, -9)
    sb.el('t-id', { computed: 'matrix(1, 0, 0, 1, 31, -9)', text: 'A' })
    sb.send({ __promaCtfApply: true, action: 'drag-start', id: 't-id' })
    doDrag(sb, 't-id', 20, 4)
    const node = sb.elements.get('t-id')!
    expect(node.style.transform).toBe('translate(51px, -5px)')
    const rep = lastMoveReport(sb)
    expect(rep?.value?.finalTransform).toBe('translate(51px, -5px)')
    expect(rep?.value?.absX).toBe(51)
    expect(rep?.value?.absY).toBe(-5)
  })

  test('m6 旋转：输出 matrix(a,b,c,d,x,y)，平移槽叠加、线性部原样', () => {
    const sb = buildSandbox()
    sb.el('t-rot', { computed: 'matrix(0.7071, 0.7071, -0.7071, 0.7071, 10, 5)', text: 'B' })
    sb.send({ __promaCtfApply: true, action: 'drag-start', id: 't-rot' })
    doDrag(sb, 't-rot', 20, 4)
    expect(sb.elements.get('t-rot')!.style.transform).toBe('matrix(0.7071, 0.7071, -0.7071, 0.7071, 30, 9)')
  })

  test('m6 缩放：输出 matrix(...)，非单位线性部不被压平成 translate', () => {
    const sb = buildSandbox()
    sb.el('t-scl', { computed: 'matrix(2, 0, 0, 2, 0, 0)', text: 'C' })
    sb.send({ __promaCtfApply: true, action: 'drag-start', id: 't-scl' })
    doDrag(sb, 't-scl', 10, 10)
    expect(sb.elements.get('t-scl')!.style.transform).toBe('matrix(2, 0, 0, 2, 10, 10)')
  })

  test('m16（tz≠0）：[12]/[13] 叠加、[14]=tz 原样保留、输出 16 值 matrix3d', () => {
    const sb = buildSandbox()
    sb.el('t-m3d', { computed: 'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 100, 1)', text: 'D' })
    sb.send({ __promaCtfApply: true, action: 'drag-start', id: 't-m3d' })
    doDrag(sb, 't-m3d', 20, 4)
    const node = sb.elements.get('t-m3d')!
    expect(node.style.transform).toBe('matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 25, 10, 100, 1)')
    const rep = lastMoveReport(sb)
    expect(rep?.value?.finalTransform).toBe('matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 25, 10, 100, 1)')
    expect(rep?.value?.absX).toBe(25)
    expect(rep?.value?.absY).toBe(10)
  })

  test('none 基线：输出 translate(dx,dy)', () => {
    const sb = buildSandbox()
    sb.el('t-none', { computed: 'none', text: 'E' })
    sb.send({ __promaCtfApply: true, action: 'drag-start', id: 't-none' })
    doDrag(sb, 't-none', 20, 4)
    expect(sb.elements.get('t-none')!.style.transform).toBe('translate(20px, 4px)')
  })

  test('畸形 <6 值 matrix：按 none 处理，不抛错', () => {
    const sb = buildSandbox()
    sb.el('t-bad6', { computed: 'matrix(1, 0)', text: 'F' })
    sb.send({ __promaCtfApply: true, action: 'drag-start', id: 't-bad6' })
    doDrag(sb, 't-bad6', 20, 4)
    expect(sb.elements.get('t-bad6')!.style.transform).toBe('translate(20px, 4px)')
  })

  test('畸形 <16 值 matrix3d（严格 ===16 校验）：按 none 处理', () => {
    const sb = buildSandbox()
    sb.el('t-bad16', { computed: 'matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6)', text: 'G' })
    sb.send({ __promaCtfApply: true, action: 'drag-start', id: 't-bad16' })
    doDrag(sb, 't-bad16', 20, 4)
    expect(sb.elements.get('t-bad16')!.style.transform).toBe('translate(20px, 4px)')
  })
})

describe('click-to-fix-script eval 沙箱：拖拽会话（WO1③④⑤/M3/M8/M9）', () => {
  test('finalTransform = 写入 el.style.transform 的同一字符串（单一来源）', () => {
    const sb = buildSandbox()
    sb.el('t-ft', { computed: 'matrix(1, 0, 0, 1, 31, -9)', text: 'H' })
    sb.send({ __promaCtfApply: true, action: 'drag-start', id: 't-ft' })
    doDrag(sb, 't-ft', 20, 4)
    const node = sb.elements.get('t-ft')!
    const rep = lastMoveReport(sb)
    expect(rep?.value?.finalTransform).toBe(node.style.transform)
    expect(rep?.value?.finalTransform).toBe('translate(51px, -5px)')
  })

  test('修改类指令中止进行中的拖拽：还原 prevInline 且不上报（M8 abort）', () => {
    const sb = buildSandbox()
    const node = sb.el('t-ab', { computed: 'none', text: 'I' })
    sb.send({ __promaCtfApply: true, action: 'drag-start', id: 't-ab' })
    node.style.transform = 'translate(7px, 8px)' // 既有 inline（prevInline）
    node.dispatch('pointerdown', { pointerId: 1, clientX: 100, clientY: 100, preventDefault() {} })
    for (const fn of [...(sb.docListeners.get('mousemove') ?? [])]) fn({ clientX: 130, clientY: 120 })
    // 拖拽进行中（未 mouseup）收到 color 指令 → exitDragMode → abort：还原 prevInline
    sb.send({ __promaCtfApply: true, action: 'color', id: 't-ab', value: '#ff0000' })
    expect(node.style.transform).toBe('translate(7px, 8px)')
    // 会话已中止：补发 mouseup 不再触发 finish/上报
    const before = sb.posted.filter((p) => p.action === 'move').length
    for (const fn of [...(sb.docListeners.get('mouseup') ?? [])]) fn({ clientX: 130, clientY: 120 })
    expect(sb.posted.filter((p) => p.action === 'move').length).toBe(before)
    // dragMode 已清：cursor 复原
    expect(node.style.cursor).toBe('')
  })

  test('undo-all 全量还原后 originalStyles 保留（重复撤销幂等）', () => {
    const sb = buildSandbox()
    const node = sb.el('t-ua', { computed: 'matrix(1, 0, 0, 1, 5, 5)', text: 'J' })
    sb.send({ __promaCtfApply: true, action: 'drag-start', id: 't-ua' })
    doDrag(sb, 't-ua', 10, 10)
    expect(node.style.transform).toBe('translate(15px, 15px)')
    sb.send({ __promaCtfApply: true, action: 'undo-all' })
    expect(node.style.transform).toBe('')
  })
})


// ===== W24-6：tab/分页类点击不弹点选（原生切换放行）=====

describe('W24-6 tab 排除：标签页点击不上报不弹面板', () => {
  function docClick(sb: ReturnType<typeof buildSandbox>, node: StubEl): void {
    for (const fn of [...(sb.docListeners.get('click') ?? [])]) {
      fn({ target: node, preventDefault() {}, stopPropagation() {} })
    }
  }

  test('data-ai-type=标签页 的点击零上报（原生行为放行）', () => {
    const sb = buildSandbox()
    const tab = sb.el('tab-scene-2')
    tab.setAttribute('data-ai-type', '标签页')
    docClick(sb, tab)
    expect(sb.posted.filter((p) => p.kind === 'element-click').length).toBe(0)
  })

  test('对照：普通元素（按钮）点击仍上报 element-click', () => {
    const sb = buildSandbox()
    const btn = sb.el('btn-record')
    btn.setAttribute('data-ai-type', '按钮')
    btn.innerText = '按住说话'
    docClick(sb, btn)
    const rep = sb.posted.find((p) => p.kind === 'element-click')
    expect(rep?.id).toBe('btn-record')
    expect(rep?.type).toBe('按钮')
  })

  test('变体兼容：类型词表全档（含旧生成器的「标签」）同样排除', () => {
    const sb = buildSandbox()
    const variants = ['标签页', '标签', '选项卡', '切换', 'tab', '分页', '页签', '导航', ' Tab ']
    for (const [i, t] of variants.entries()) {
      const n = sb.el('x-el-' + i)
      n.setAttribute('data-ai-type', t)
      docClick(sb, n)
    }
    expect(sb.posted.filter((p) => p.kind === 'element-click').length).toBe(0)
  })

  test('id 启发式：nav-*/tab-*/*-tab-* 排除（两代生成器命名 scene-tab-us01 / nav-scene-tabs / tab-us01）', () => {
    const sb = buildSandbox()
    for (const id of ['nav-scene-tabs', 'tab-us01', 'scene-tab-us02', 'navbar-main']) {
      const n = sb.el(id)
      n.setAttribute('data-ai-type', '按钮') // 类型不命中，靠 id 兜底
      docClick(sb, n)
    }
    expect(sb.posted.filter((p) => p.kind === 'element-click').length).toBe(0)
    // 对照：普通 id 不受 id 启发式影响
    const normal = sb.el('btn-judge-299')
    normal.setAttribute('data-ai-type', '按钮')
    normal.innerText = '判定'
    docClick(sb, normal)
    expect(sb.posted.some((p) => p.kind === 'element-click' && p.id === 'btn-judge-299')).toBe(true)
  })
})

// ===== W24-EF F2：框选多元素（mousedown/mousemove/mouseup）=====
// BDD #1：框选含 2 元素 → 上报 kind='box-select' 且含元素数组
// BDD #2：框选结束 → 每元素 3 秒高亮（覆盖层），3 秒后全部消失
// BDD #3：框选含不可交互背景（带 data-ai-id 但 type 为标签页，或背景节点）→ 过滤后只保留有效元素
// 注：本沙箱 StubEl.getBoundingClientRect 固定返回 100×20@原点；框选坐标需覆盖原矩形范围。

describe('W24-EF F2：框选多元素批量点选', () => {
  /** 模拟一次完整的 mousedown→mousemove*2→mouseup（动运超过 3px 阈值） */
  function doBox(sb: ReturnType<typeof buildSandbox>, x1: number, y1: number, x2: number, y2: number): void {
    // 在背景 documentElement 上发 mousedown
    for (const fn of [...(sb.docListeners.get('mousedown') ?? [])]) {
      fn({ target: sb.documentElement, clientX: x1, clientY: y1, preventDefault() {} })
    }
    for (const fn of [...(sb.docListeners.get('mousemove') ?? [])]) {
      fn({ clientX: x1, clientY: y1 })
      fn({ clientX: x2, clientY: y2 })
    }
    for (const fn of [...(sb.docListeners.get('mouseup') ?? [])]) {
      fn({ clientX: x2, clientY: y2 })
    }
  }

  test('框选覆盖 2 个相邻元素 → 上报 box-select 且 items 含两个 id', () => {
    const sb = buildSandbox()
    sb.el('btn-add') // 默认 StubEl.getBoundingClientRect = 100×20@原点
    sb.el('btn-edit')
    // StubEl 默认 bounding rect 重叠：x:0 y:0 w:100 h:20，两个元素位置重叠
    // 框选起点 (-5, -5) → (200, 50) 会覆盖两者
    doBox(sb, -5, -5, 200, 50)
    const boxSelects = sb.posted.filter((p) => p.kind === 'box-select')
    expect(boxSelects).toHaveLength(1)
    const items = (boxSelects[0] as { items?: Array<{ id: string; type: string }> }).items ?? []
    const ids = items.map((i) => i.id).sort()
    expect(ids).toEqual(['btn-add', 'btn-edit'])
    // 隐私边界：只含 id + type，不含 text/rect
    for (const it of items) {
      expect(Object.keys(it).sort()).toEqual(['id', 'type'])
    }
  })

  test('框选结束后为每元素创建独立高亮覆盖层（documentElement.appendChild 调用次数 = 选中元素数 + 选区框）', () => {
    const sb = buildSandbox()
    sb.el('btn-a')
    sb.el('btn-b')
    sb.el('btn-c')
    const before = sb.created.length
    doBox(sb, -10, -10, 200, 50)
    const after = sb.created.length
    // 新增：选区框（启动时已创建，3 个高亮
    // （选区框是 ensureBoxSelectLayers 在 mousedown 时创建，3 个高亮是 mouseup performBoxSelect 创建）
    const newNodes = after - before
    // 1 选区框 + 3 高亮 = 4
    expect(newNodes).toBe(4)
    // 注：sandbox StubEl 的 className 属性不会写入 attributes map；脚本里设的是 hl.className，
    // 因此这里通过元素 style 包含 'z-index:2147483647' 间接识别高亮节点（脚本对选区框用 z-index 2147483646）。
    const highlights = sb.created.filter((n) => {
      const css = (n.style as { cssText?: string }).cssText ?? ''
      return css.includes('z-index:2147483647') && css.includes('background:rgba(79,70,229')
    })
    expect(highlights).toHaveLength(3)
  })

  test('空选（框选范围内无 data-ai-id） → 不上报 box-select 且不报错', () => {
    const sb = buildSandbox()
    // 不放任何元素，只对纯背景框选
    const before = sb.posted.filter((p) => p.kind === 'box-select').length
    expect(() => doBox(sb, 1000, 1000, 2000, 2000)).not.toThrow()
    const after = sb.posted.filter((p) => p.kind === 'box-select').length
    expect(after - before).toBe(0)
  })

  test('框选包含 tab/分页类元素（id 启发式） → 过滤后只保留有效元素', () => {
    const sb = buildSandbox()
    sb.el('tab-scene-2') // id 命中 /^.*(tab)/i 启发式
    sb.el('btn-real') // 普通按钮
    doBox(sb, -10, -10, 200, 50)
    const boxSelects = sb.posted.filter((p) => p.kind === 'box-select')
    expect(boxSelects).toHaveLength(1)
    const items = (boxSelects[0] as { items?: Array<{ id: string; type: string }> }).items ?? []
    const ids = items.map((i) => i.id).sort()
    expect(ids).toEqual(['btn-real'])
    expect(ids).not.toContain('tab-scene-2')
  })

  test('框选包含 data-ai-type=标签页 的元素 → 过滤后只保留有效元素', () => {
    const sb = buildSandbox()
    const tab = sb.el('some-tab')
    tab.setAttribute('data-ai-type', '标签页')
    sb.el('btn-real')
    doBox(sb, -10, -10, 200, 50)
    const items = (sb.posted.find((p) => p.kind === 'box-select') as { items?: Array<{ id: string }> })?.items ?? []
    expect(items.map((i) => i.id).sort()).toEqual(['btn-real'])
  })

  test('起点为 data-ai-id 元素 → 不进入框选会话（留给 click 路径）', () => {
    const sb = buildSandbox()
    const btn = sb.el('btn-source')
    btn.setAttribute('data-ai-type', '按钮')
    // mousedown 起点在 btn 上（被 closest 命中），不进框选
    for (const fn of [...(sb.docListeners.get('mousedown') ?? [])]) {
      fn({ target: btn, clientX: 50, clientY: 10, preventDefault() {} })
    }
    // mousemove + mouseup 应无效果
    for (const fn of [...(sb.docListeners.get('mousemove') ?? [])]) {
      fn({ clientX: 200, clientY: 50 })
    }
    for (const fn of [...(sb.docListeners.get('mouseup') ?? [])]) {
      fn({ clientX: 200, clientY: 50 })
    }
    expect(sb.posted.filter((p) => p.kind === 'box-select').length).toBe(0)
  })

  test('微抖动（<3px） → 不结算框选，让 click 路径正常处理', () => {
    const sb = buildSandbox()
    sb.el('btn-a')
    // mousedown → mousemove(2px) → mouseup
    for (const fn of [...(sb.docListeners.get('mousedown') ?? [])]) {
      fn({ target: sb.documentElement, clientX: 10, clientY: 10, preventDefault() {} })
    }
    for (const fn of [...(sb.docListeners.get('mousemove') ?? [])]) {
      fn({ clientX: 11, clientY: 11 })
    }
    for (const fn of [...(sb.docListeners.get('mouseup') ?? [])]) {
      fn({ clientX: 12, clientY: 12 })
    }
    expect(sb.posted.filter((p) => p.kind === 'box-select').length).toBe(0)
    // 选区框隐藏，未留下 pending 状态
    const marquee = sb.created.find((n) => n.getAttribute('id') === 'proma-ctf-box-marquee')
    expect(marquee?.style.display).toBe('none')
  })

  test('框选不拦 blank-click：背景单击仍上报 blank-click（无双重拦截）', () => {
    const sb = buildSandbox()
    // 背景单击：mousedown → mouseup（<3px，不结算框选）→ click
    for (const fn of [...(sb.docListeners.get('mousedown') ?? [])]) {
      fn({ target: sb.documentElement, clientX: 10, clientY: 10, preventDefault() {} })
    }
    for (const fn of [...(sb.docListeners.get('mouseup') ?? [])]) {
      fn({ target: sb.documentElement, clientX: 12, clientY: 12 })
    }
    for (const fn of [...(sb.docListeners.get('click') ?? [])]) {
      fn({ target: sb.documentElement, preventDefault() {}, stopPropagation() {} })
    }
    // 空白单击照常上报，且不产生 box-select
    expect(sb.posted.some((p) => p.kind === 'blank-click')).toBe(true)
    expect(sb.posted.filter((p) => p.kind === 'box-select').length).toBe(0)
  })

  test('框选不拦 text-edit：起点在 input/textarea 不进框选（文本选区保留）', () => {
    const sb = buildSandbox()
    const input = new StubEl('INPUT')
    for (const fn of [...(sb.docListeners.get('mousedown') ?? [])]) {
      fn({ target: input, clientX: 50, clientY: 10, preventDefault() {} })
    }
    for (const fn of [...(sb.docListeners.get('mousemove') ?? [])]) {
      fn({ clientX: 200, clientY: 50 })
    }
    for (const fn of [...(sb.docListeners.get('mouseup') ?? [])]) {
      fn({ clientX: 200, clientY: 50 })
    }
    expect(sb.posted.filter((p) => p.kind === 'box-select').length).toBe(0)
  })

  test('框选不拦拖拽：dragMode 会话期间背景 mousedown 不进框选', () => {
    const sb = buildSandbox()
    sb.el('t-drag-guard', { computed: 'none', text: 'X' })
    sb.send({ __promaCtfApply: true, action: 'drag-start', id: 't-drag-guard' })
    for (const fn of [...(sb.docListeners.get('mousedown') ?? [])]) {
      fn({ target: sb.documentElement, clientX: 10, clientY: 10, preventDefault() {} })
    }
    for (const fn of [...(sb.docListeners.get('mousemove') ?? [])]) {
      fn({ clientX: 200, clientY: 50 })
    }
    for (const fn of [...(sb.docListeners.get('mouseup') ?? [])]) {
      fn({ clientX: 200, clientY: 50 })
    }
    expect(sb.posted.filter((p) => p.kind === 'box-select').length).toBe(0)
  })

  test('中心点落框：边缘轻触但中心在框外的大容器不过选', () => {
    const sb = buildSandbox()
    const centerIn = sb.el('center-in')
    const edgeOnly = sb.el('edge-only')
    // 中心 (20,20) 在选框内 → 选中
    centerIn.getBoundingClientRect = () => ({ x: 10, y: 10, top: 10, left: 10, right: 30, bottom: 30, width: 20, height: 20 })
    // 左边缘与选框轻触（left=90 < 100），但中心 (145,20) 在框外 → 不过选
    edgeOnly.getBoundingClientRect = () => ({ x: 90, y: 10, top: 10, left: 90, right: 200, bottom: 30, width: 110, height: 20 })
    doBox(sb, 0, 0, 100, 50)
    const items = (sb.posted.find((p) => p.kind === 'box-select') as { items?: Array<{ id: string }> })?.items ?? []
    expect(items.map((i) => i.id).sort()).toEqual(['center-in'])
  })

  test('框选抑制窗只限同一释放坐标 → 其他位置 click 不被吞', () => {
    const sb = buildSandbox()
    sb.el('btn-a')
    // 框选结算（>3px 拖拽），释放点 (200,50)
    doBox(sb, 10, 10, 200, 50)
    // 同一释放坐标 (200,50) 附近的合成 click → 被抑制（不报 blank-click）
    for (const fn of [...(sb.docListeners.get('click') ?? [])]) {
      fn({ target: sb.documentElement, clientX: 200, clientY: 50, preventDefault() {}, stopPropagation() {} })
    }
    expect(sb.posted.filter((p) => p.kind === 'blank-click').length).toBe(0)
    // 其他位置 (10,10) 的 click → 不被抑制（仍报 blank-click）
    for (const fn of [...(sb.docListeners.get('click') ?? [])]) {
      fn({ target: sb.documentElement, clientX: 10, clientY: 10, preventDefault() {}, stopPropagation() {} })
    }
    expect(sb.posted.filter((p) => p.kind === 'blank-click').length).toBe(1)
  })

  test('右键（button=2）拖拽不进框选', () => {
    const sb = buildSandbox()
    sb.el('btn-a')
    for (const fn of [...(sb.docListeners.get('mousedown') ?? [])]) {
      fn({ target: sb.documentElement, clientX: 10, clientY: 10, button: 2, preventDefault() {} })
    }
    for (const fn of [...(sb.docListeners.get('mousemove') ?? [])]) {
      fn({ clientX: 200, clientY: 50 })
    }
    for (const fn of [...(sb.docListeners.get('mouseup') ?? [])]) {
      fn({ clientX: 200, clientY: 50 })
    }
    expect(sb.posted.filter((p) => p.kind === 'box-select').length).toBe(0)
  })
})

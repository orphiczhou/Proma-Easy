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
      // 只需覆盖 undo-all 的 proma-ctf-* 清扫
      return sel.includes('proma-ctf-') ? created.filter((n) => (n.getAttribute('id') ?? '').startsWith('proma-ctf-')) : []
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

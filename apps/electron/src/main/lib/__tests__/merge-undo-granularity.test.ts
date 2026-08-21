/**
 * WO5.4（v0.17.59）：合并粒度 × 撤销粒度端到端（eval 沙箱 + 源级锁定）
 *
 * 场景：同元素 color → move → text 三连改后单撤 move：
 * - iframe 侧（WO1⑥ 选择性 undo）：color/text 的即时效果留存，仅 transform 还原
 * - 宿主侧（WO-M6 双键合并 + WO3② undo 报文带 value.action）：
 *   源级断言 filter 公式与 undo 报文形状，行为级用同公式模拟清单仅删 move
 * - undo-all 全清
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { CLICK_TO_FIX_INJECT_SCRIPT } from '../click-to-fix-script'

// ===== 紧凑桩环境（与 click-to-fix-script.eval.test.ts 同构，聚焦 undo 粒度路径） =====

type Listener = (ev: Record<string, unknown>) => void

function makeStyle(): Record<string, string> {
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
  _computed: string | null = null
  isConnected = true

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
    this.listeners.set(t, (this.listeners.get(t) ?? []).filter((f) => f !== fn))
  }
  dispatch(t: string, ev: Record<string, unknown>) {
    for (const fn of [...(this.listeners.get(t) ?? [])]) fn(ev)
    return true
  }
  getBoundingClientRect() {
    return { x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 20, width: 100, height: 20 }
  }
  contains(n: unknown) { return n === this || this.children.includes(n as StubEl) }
  setPointerCapture() { /* no-op */ }
  focus() { /* no-op */ }
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

function buildSandbox() {
  const winListeners = new Map<string, Listener[]>()
  const docListeners = new Map<string, Listener[]>()
  const elements = new Map<string, StubEl>()
  const created: StubEl[] = []
  const posted: Array<Record<string, unknown>> = []
  const root = new StubEl('HTML')
  const parentStub = { postMessage: (payload: Record<string, unknown>) => { posted.push(payload) } }

  const documentStub = {
    documentElement: root,
    getElementById(id: string) { return created.find((n) => n.getAttribute('id') === id) ?? null },
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
    getComputedStyle: (el: StubEl) => ({ transform: el.style.transform !== '' ? el.style.transform : (el._computed ?? 'none') }),
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    createRange: () => ({ selectNodeContents() {} }),
  }

  // biome-ignore lint: 有意 eval 注入脚本体（沙箱测试）
  new Function('window', 'document', 'parent', 'location', CLICK_TO_FIX_INJECT_SCRIPT)(
    windowStub, documentStub, parentStub, { href: 'file:///stub.html' },
  )

  const send = (msg: Record<string, unknown>) => {
    for (const fn of [...(winListeners.get('message') ?? [])]) fn({ data: msg, source: parentStub })
  }
  const el = (id: string, init?: { tag?: string, text?: string }) => {
    const n = new StubEl(init?.tag ?? 'DIV')
    n.setAttribute('data-ai-id', id)
    n.setAttribute('data-ai-type', '元素')
    if (init?.text) n._innerText = init.text
    elements.set(id, n)
    return n
  }
  return { elements, posted, send, el }
}

// ===== 源级锁定（宿主侧公式在位） =====

const listenersSrc = readFileSync(new URL('../../../renderer/hooks/useGlobalAgentListeners.ts', import.meta.url), 'utf8')
const panelSrc = readFileSync(new URL('../../../renderer/components/nanju/ClickToFixPanel.tsx', import.meta.url), 'utf8')

describe('合并粒度 × 撤销粒度（WO-M6 / WO1⑥ / WO3②）', () => {
  test('源级：双键合并 filter 公式在位（同元素同动作合并、voice 豁免代码可见）', () => {
    expect(listenersSrc).toContain(
      "list.filter((c) => !(c.ref.id === item.ref.id && c.action === item.action) || c.action === 'voice')",
    )
  })

  test('源级：removeChange 的 undo 报文携带 value:{action}（voice 走 remove-annotation）', () => {
    expect(panelSrc).toContain(
      "action: 'undo', id: item.ref.id, value: { action: item.action }",
    )
  })

  test('行为级：color→move→text 单撤 move——清单仅删 move，color/text 留存；iframe 侧仅还原 transform', () => {
    const sb = buildSandbox()
    const node = sb.el('el-x', { text: '原文' })
    node._innerHTML = '原文'

    // 宿主清单（模拟 useGlobalAgentListeners 的双键合并写入）
    type Item = { ref: { id: string }, action: 'color' | 'move' | 'text' | 'voice', value?: unknown }
    const list: Item[] = []
    const mergeIn = (item: Item) => {
      const merged = list.filter((c) => !(c.ref.id === item.ref.id && c.action === item.action) || c.action === 'voice')
      merged.push(item)
      list.length = 0
      list.push(...merged)
    }

    // ① color（宿主指令 → iframe 即时生效 → change-result 入清单）
    sb.send({ __promaCtfApply: true, action: 'color', id: 'el-x', value: '#DC2626' })
    expect(node.style.backgroundColor).toBe('#DC2626')
    mergeIn({ ref: { id: 'el-x' }, action: 'color', value: '#DC2626' })

    // ② move（absX/absY 终值路径）
    sb.send({ __promaCtfApply: true, action: 'move', id: 'el-x', value: { absX: 51, absY: -5 } })
    expect(node.style.transform).toBe('translate(51px, -5px)')
    mergeIn({ ref: { id: 'el-x' }, action: 'move', value: { absX: 51, absY: -5 } })

    // ③ text（contentEditable 原地编辑 → Enter 确认）
    sb.send({ __promaCtfApply: true, action: 'text-edit', id: 'el-x' })
    expect(node.getAttribute('contenteditable')).toBe('true')
    node._innerHTML = '新文案'
    node._innerText = '新文案'
    node.dispatch('keydown', { key: 'Enter', preventDefault() {} })
    const textReports = sb.posted.filter((p) => p.action === 'text')
    expect(textReports).toHaveLength(1)
    expect(textReports[0]?.value).toBe('新文案')
    mergeIn({ ref: { id: 'el-x' }, action: 'text', value: '新文案' })

    // 双键合并后清单三条共存（旧版单键会把 move/text 互相挤掉）
    expect(list.map((c) => c.action)).toEqual(['color', 'move', 'text'])

    // ④ 单撤 move（removeChange：清单仅删该条 + undo 报文带 value.action）
    const idx = list.findIndex((c) => c.action === 'move')
    sb.send({ __promaCtfApply: true, action: 'undo', id: 'el-x', value: { action: 'move' } })
    list.splice(idx, 1)
    expect(list.map((c) => c.action)).toEqual(['color', 'text'])
    // iframe 侧粒度：仅 transform 还原；color 效果与文本留存
    expect(node.style.transform).toBe('')
    expect(node.style.backgroundColor).toBe('#DC2626')
    expect(node.innerHTML).toBe('新文案')

    // ⑤ undo-all 全清（value 缺失 → 全量还原）
    sb.send({ __promaCtfApply: true, action: 'undo-all' })
    list.length = 0
    expect(node.style.transform).toBe('')
    expect(node.style.backgroundColor).toBe('')
    expect(node.innerHTML).toBe('原文')
    expect(list).toHaveLength(0)
  })

  test('行为级：同元素同动作重复入清单只保留最新（双键合并保留最新）', () => {
    type Item = { ref: { id: string }, action: 'color' | 'move' | 'text' | 'voice', value?: unknown }
    const list: Item[] = []
    const mergeIn = (item: Item) => {
      const merged = list.filter((c) => !(c.ref.id === item.ref.id && c.action === item.action) || c.action === 'voice')
      merged.push(item)
      list.length = 0
      list.push(...merged)
    }
    mergeIn({ ref: { id: 'a' }, action: 'color', value: '#DC2626' })
    mergeIn({ ref: { id: 'a' }, action: 'color', value: '#059669' })
    mergeIn({ ref: { id: 'a' }, action: 'voice', value: '第一条' })
    mergeIn({ ref: { id: 'a' }, action: 'voice', value: '第二条' })
    expect(list).toHaveLength(3) // color 最新 1 条 + voice 2 条（豁免合并，累积）
    expect(list[0]).toMatchObject({ action: 'color', value: '#059669' })
    expect(list.filter((c) => c.action === 'voice')).toHaveLength(2)
  })
})

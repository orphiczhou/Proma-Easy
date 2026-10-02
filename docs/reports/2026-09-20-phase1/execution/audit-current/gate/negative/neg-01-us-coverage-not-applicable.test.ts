/**
 * neg-01：US 编号归一 / 三类覆盖 / notApplicable 绕过（只读审计反例）
 * 对应 nanju-acceptance-baseline.ts（sha256 4cfe9bc2…，mtime 2026-09-20T15:02:41+0800）。
 *
 * 关键现状引用：
 * - 归一：`if (typeof row.us === 'string' && /^US-\d+$/i.test(row.us)) row.us = `US-${String(Number(row.us.slice(3))).padStart(2, '0')}``
 * - notApplicable 弱门槛：`row.notApplicable.trim().length < 6` 才拒绝，且仅 kind!=='normal' 可豁免
 * - 覆盖检查：`if (!cases.some(row => row.us === us && row.kind === kind)) throw ...`
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { freezeAcceptanceSpecification, validateAcceptanceSpecification } from './nanju-acceptance-baseline'

let dir = ''
const prd = '# PRD\n## US-1 复制\nUS-1 点击复制到剪贴板。\n## US-2 粘贴\nUS-2 从剪贴板粘贴。\n'

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'neg01-'))
  mkdirSync(join(dir, '01_PRD'), { recursive: true })
  mkdirSync(join(dir, '03_ARCHITECTURE'), { recursive: true })
  writeFileSync(join(dir, '01_PRD/prd.md'), prd)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('neg-01 US编号归一', () => {
  test('US-1（单位数、大写敏感变体）能被归一到 US-01 并满足覆盖', () => {
    // 三类齐备但 us 写作 US-1 / us2 —— 归一后必须与 parseUserStories 输出 US-01/US-02 对齐
    const spec = { version: 1, cases: [
      { id: 'AC-001', us: 'US-1', kind: 'normal', given: '有文本', when: '点击复制', then: '剪贴板变化' },
      { id: 'AC-002', us: 'US-1', kind: 'boundary', given: '空文本', when: '点击复制', then: '不复制' },
      { id: 'AC-003', us: 'US-1', kind: 'exception', given: '权限不足', when: '点击复制', then: '显示错误' },
      { id: 'AC-004', us: 'us2', kind: 'normal', given: '剪贴板有文本', when: '点击粘贴', then: '输入框变化' },
      { id: 'AC-005', us: 'us2', kind: 'boundary', given: '剪贴板为空', when: '点击粘贴', then: '不粘贴' },
      { id: 'AC-006', us: 'us2', kind: 'exception', given: '权限不足', when: '点击粘贴', then: '显示错误' },
    ] }
    writeFileSync(join(dir, '03_ARCHITECTURE/acceptance.json'), JSON.stringify(spec))
    // AUDIT-EXPECT：三类全覆盖 + 归一对齐 → 通过
    expect(validateAcceptanceSpecification(dir)).toBeNull()
  })

  test('无连字符形态 us01 不归一，直接拒绝（fail-closed）', () => {
    const spec = { version: 1, cases: [
      { id: 'AC-001', us: 'us01', kind: 'normal', given: '有文本', when: '点击复制', then: '剪贴板变化' },
      { id: 'AC-002', us: 'US-01', kind: 'boundary', given: '空文本', when: '点击复制', then: '不复制' },
      { id: 'AC-003', us: 'US-01', kind: 'exception', given: '权限不足', when: '点击复制', then: '显示错误' },
    ] }
    writeFileSync(join(dir, '03_ARCHITECTURE/acceptance.json'), JSON.stringify(spec))
    expect(validateAcceptanceSpecification(dir)).toContain('US或kind无效')
  })

  test('US-001（三位）归一后与 US-01 同一故事，不得重复要求覆盖', () => {
    const spec = { version: 1, cases: [
      { id: 'AC-001', us: 'US-001', kind: 'normal', given: '有文本', when: '点击复制', then: '剪贴板变化' },
      { id: 'AC-002', us: 'US-01', kind: 'boundary', given: '空文本', when: '点击复制', then: '不复制' },
      { id: 'AC-003', us: 'US-01', kind: 'exception', given: '权限不足', when: '点击复制', then: '显示错误' },
    ] }
    writeFileSync(join(dir, '03_ARCHITECTURE/acceptance.json'), JSON.stringify(spec))
    expect(validateAcceptanceSpecification(dir)).toBeNull()
  })
})

describe('neg-01 notApplicable 豁免强度', () => {
  test('AUDIT-RED（现状）：6 字符凑数理由即可豁免 boundary/exception，覆盖检查照常通过', () => {
    // AUDIT-EXPECT：豁免理由应可判定「确实不适用」（结构化/长度/内容），凑数文本不应豁免成功。
    // 现状实现仅 `row.notApplicable.trim().length < 6` —— 六个字即过，三类覆盖可被全豁免掏空。
    const spec = { version: 1, cases: [
      { id: 'AC-001', us: 'US-01', kind: 'normal', given: '有文本', when: '点击复制', then: '剪贴板变化' },
      { id: 'AC-002', us: 'US-01', kind: 'boundary', notApplicable: '理由理由理由' },
      { id: 'AC-003', us: 'US-01', kind: 'exception', notApplicable: '理由理由理由' },
      { id: 'AC-004', us: 'US-02', kind: 'normal', given: '剪贴板有文本', when: '点击粘贴', then: '输入框变化' },
      { id: 'AC-005', us: 'US-02', kind: 'boundary', notApplicable: '理由理由理由' },
      { id: 'AC-006', us: 'US-02', kind: 'exception', notApplicable: '理由理由理由' },
    ] }
    writeFileSync(join(dir, '03_ARCHITECTURE/acceptance.json'), JSON.stringify(spec))
    // 现状：通过 —— 即两个 US 的 boundary/exception 全部被凑数理由豁免。
    // 该断言固化为缺陷证据；修复后此断言应改为 expect(...).toContain('豁免')
    expect(validateAcceptanceSpecification(dir)).toBeNull()
  })

  test('普通路径豁免仍被拒（既有红线回归）', () => {
    const spec = { version: 1, cases: [
      { id: 'AC-001', us: 'US-01', kind: 'normal', notApplicable: '理由理由理由' },
      { id: 'AC-002', us: 'US-01', kind: 'boundary', given: '空文本', when: '点击复制', then: '不复制' },
      { id: 'AC-003', us: 'US-01', kind: 'exception', given: '权限不足', when: '点击复制', then: '显示错误' },
    ] }
    writeFileSync(join(dir, '03_ARCHITECTURE/acceptance.json'), JSON.stringify(spec))
    expect(validateAcceptanceSpecification(dir)).toContain('普通路径不得豁免')
  })

  test('豁免条目不进入测试绑定（validateAcceptanceBindings 只查非豁免 AC），豁免不可用于删减可测项', () => {
    // 结合冻结：豁免条目在 binding 阶段被过滤（`!row.notApplicable`），
    // 因此「全豁免式规格」进入 testing 时只需绑定 normal 条目 —— 与 neg-03 呼应。
    const spec = { version: 1, cases: [
      { id: 'AC-001', us: 'US-01', kind: 'normal', given: '有文本', when: '点击复制', then: '剪贴板变化' },
      { id: 'AC-002', us: 'US-01', kind: 'exception', notApplicable: '理由理由理由' },
    ] }
    // 缺 boundary 条目 → 覆盖检查必须拒绝（不得用豁免代替缺失）
    writeFileSync(join(dir, '03_ARCHITECTURE/acceptance.json'), JSON.stringify(spec))
    expect(validateAcceptanceSpecification(dir)).toContain('US-01缺少boundary')
  })
})

describe('neg-01 冻结交互（与 neg-02 衔接）', () => {
  test('冻结后规格散列以原文为准：等价重排（空白变化）同样判定为已改变（保守误拦口径确认）', () => {
    const spec = { version: 1, cases: [
      { id: 'AC-001', us: 'US-01', kind: 'normal', given: '有文本', when: '点击复制', then: '剪贴板变化' },
      { id: 'AC-002', us: 'US-01', kind: 'boundary', given: '空文本', when: '点击复制', then: '不复制' },
      { id: 'AC-003', us: 'US-01', kind: 'exception', given: '权限不足', when: '点击复制', then: '显示错误' },
    ] }
    writeFileSync(join(dir, '03_ARCHITECTURE/acceptance.json'), JSON.stringify(spec))
    freezeAcceptanceSpecification(dir)
    // 语义完全相同、仅格式化差异（增缩进）→ specHash 变化 → 拒绝。
    // 保守方向正确（宁可误拦），记录为设计确认而非缺陷。
    writeFileSync(join(dir, '03_ARCHITECTURE/acceptance.json'), JSON.stringify(spec, null, 4))
    expect(validateAcceptanceSpecification(dir, true)).toContain('基线缺失')
  })
})

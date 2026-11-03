import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { freezeAcceptanceSpecification, validateAcceptanceBindings, validateAcceptanceSpecification } from './nanju-acceptance-baseline'
let dir = ''
const prd = '# PRD\n## US-01\nUS-01 clipboard copy\n'
const spec = JSON.stringify({ version: 1, cases: [
  { id: 'AC-001', us: 'US-01', kind: 'normal', given: '有文本', when: '点击复制', then: '剪贴板变化' },
  { id: 'AC-002', us: 'US-01', kind: 'boundary', notApplicable: '该产品不处理空输入，输入校验在上一层完成。' },
  { id: 'AC-003', us: 'US-01', kind: 'exception', given: '权限不足', when: '执行复制', then: '显示错误' },
] })
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'acceptance-baseline-')); mkdirSync(join(dir, '01_PRD')); mkdirSync(join(dir, '03_ARCHITECTURE')); writeFileSync(join(dir, '01_PRD/prd.md'), prd); writeFileSync(join(dir, '03_ARCHITECTURE/acceptance.json'), spec) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))
describe('编码前验收基线', () => {
  test('规格要求每个US覆盖三类路径，边界不适用需具体理由', () => { expect(validateAcceptanceSpecification(dir)).toBeNull() })
  test('普通路径不能豁免、缺类型或缺US均拒绝', () => {
    writeFileSync(join(dir, '03_ARCHITECTURE/acceptance.json'), JSON.stringify({ version: 1, cases: [{ id: 'AC-001', us: 'US-01', kind: 'normal', notApplicable: '不适用' }] }))
    expect(validateAcceptanceSpecification(dir)).toContain('普通路径不得豁免')
  })
  test('编码冻结后PRD或规格变化被拒，未冻结testing不能放行', () => {
    expect(validateAcceptanceSpecification(dir, true)).toContain('基线缺失')
    freezeAcceptanceSpecification(dir)
    expect(validateAcceptanceSpecification(dir, true)).toBeNull()
    writeFileSync(join(dir, '01_PRD/prd.md'), prd + '\n补充内容')
    expect(validateAcceptanceSpecification(dir, true)).toContain('基线缺失')
  })
  test('测试绑定只接受工程契约验收test id或steps JSON中的AC编号', () => {
    freezeAcceptanceSpecification(dir)
    expect(validateAcceptanceBindings(dir)).toContain('AC-001')
    mkdirSync(join(dir, '06_TESTS/steps'), { recursive: true })
    for (const id of ['AC-001', 'AC-003']) writeFileSync(join(dir, `06_TESTS/steps/${id}.json`), JSON.stringify({ feature: `Feature US-01`, scenario: `场景 ${id}` }))
    expect(validateAcceptanceBindings(dir)).toBeNull()
  })
})

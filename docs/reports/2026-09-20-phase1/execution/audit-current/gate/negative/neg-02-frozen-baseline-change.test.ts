/**
 * neg-02：冻结基线后需求变更（只读审计反例）
 * 对应 nanju-acceptance-baseline.ts + nanju-phase-advance-consumer.ts 冻结调用点。
 *
 * 关键现状引用：
 * - `if (baseline?.version !== 1 || baseline.specHash !== spec.specHash || baseline.prdHash !== spec.prdHash) return '编码前验收基线缺失或已改变；…'`
 * - `/** 仅在已通过原授权门的进入coding事务中调用；读取规格不自动冻结。 *／ export function freezeAcceptanceSpecification(...)`：无条件重写基线。
 * - 消费侧：`if (newStage === 'coding') { … freezeAcceptanceSpecification(getNanjuProjectDir(...)) }`
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { freezeAcceptanceSpecification, validateAcceptanceBindings, validateAcceptanceSpecification } from './nanju-acceptance-baseline'

let dir = ''
const prd = '# PRD\n## US-01 复制\nUS-01 点击复制到剪贴板。\n'
const spec = JSON.stringify({ version: 1, cases: [
  { id: 'AC-001', us: 'US-01', kind: 'normal', given: '有文本', when: '点击复制', then: '剪贴板变化' },
  { id: 'AC-002', us: 'US-01', kind: 'boundary', given: '空文本', when: '点击复制', then: '不复制' },
  { id: 'AC-003', us: 'US-01', kind: 'exception', given: '权限不足', when: '点击复制', then: '显示错误' },
] })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'neg02-'))
  mkdirSync(join(dir, '01_PRD'), { recursive: true })
  mkdirSync(join(dir, '03_ARCHITECTURE'), { recursive: true })
  writeFileSync(join(dir, '01_PRD/prd.md'), prd)
  writeFileSync(join(dir, '03_ARCHITECTURE/acceptance.json'), spec)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('neg-02 冻结基线后的需求变更', () => {
  test('AUDIT-RED（现状）：基线文件可被同权限写者重写自证 —— 改规格后重写基线即恢复「有效」', () => {
    freezeAcceptanceSpecification(dir)
    // 模拟冻结后的需求变更：then 断言弱化为空串、exception 转 6 字豁免
    // —— 实质放水但结构合法（覆盖检查仍满足）。直接删条目会被覆盖检查拦（已验证）。
    const changed = JSON.stringify({ version: 1, cases: [
      { id: 'AC-001', us: 'US-01', kind: 'normal', given: '有文本', when: '点击复制', then: 'ok' },
      { id: 'AC-002', us: 'US-01', kind: 'boundary', given: '空文本', when: '点击复制', then: 'ok' },
      { id: 'AC-003', us: 'US-01', kind: 'exception', notApplicable: '理由理由理由' },
    ] })
    writeFileSync(join(dir, '03_ARCHITECTURE/acceptance.json'), changed)
    // 正常路径：门禁发现基线已改变 → 拒绝 ✓（已实机验证）
    expect(validateAcceptanceSpecification(dir, true)).toContain('基线缺失')
    // 但基线本身是项目目录内普通文件（_acceptance-baseline.json），与规格同权限可写。
    // 有写权限的 L2/会话可同步重写基线使 hash 再次匹配 —— 校验是「自证式」的：
    freezeAcceptanceSpecification(dir)
    expect(validateAcceptanceSpecification(dir, true)).toBeNull()
    // AUDIT-EXPECT：重冻结应需要显式回退/变更授权（引导语「需求变更需先走回退确认」
    // 目前只是提示词约束，无程序化区别：重冻结与首次冻结不可区分，frozenAt 被静默刷新）。
    const baseline = JSON.parse(readFileSync(join(dir, '_acceptance-baseline.json'), 'utf8')) as { frozenAt: string }
    expect(typeof baseline.frozenAt).toBe('string') // 被静默刷新，无变更痕迹字段
  })

  test('删除基线文件 → fail-closed 拒绝（回归钉）', () => {
    freezeAcceptanceSpecification(dir)
    const baselinePath = join(dir, '_acceptance-baseline.json')
    expect(existsSync(baselinePath)).toBe(true)
    rmSync(baselinePath)
    expect(validateAcceptanceSpecification(dir, true)).toContain('基线缺失')
  })

  test('PRD 变更（新增 US-02）→ coding/testing 门禁拒绝，不得沿用旧基线', () => {
    freezeAcceptanceSpecification(dir)
    writeFileSync(join(dir, '01_PRD/prd.md'), prd + '\n## US-02 粘贴\nUS-02 从剪贴板粘贴。\n')
    expect(validateAcceptanceSpecification(dir, true)).toContain('基线缺失')
    // testing 绑定同样先过 frozen 校验（`const error = validateAcceptanceSpecification(projectDir, true)`）
    expect(validateAcceptanceBindings(dir)).toContain('基线缺失')
  })

  test('testing 阶段需求变更后，绑定错误优先呈现冻结拒因而非缺绑定（拒因次序确认）', () => {
    freezeAcceptanceSpecification(dir)
    writeFileSync(join(dir, '01_PRD/prd.md'), prd + '\n## US-02 粘贴\nUS-02 从剪贴板粘贴。\n')
    const err = validateAcceptanceBindings(dir)
    // AUDIT-EXPECT：先报基线失效（变更在先），不因缺绑定噪声掩盖变更事实
    expect(err).toContain('基线缺失')
  })
})

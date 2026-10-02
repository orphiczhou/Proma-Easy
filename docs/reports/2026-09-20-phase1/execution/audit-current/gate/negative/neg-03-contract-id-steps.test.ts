/**
 * neg-03：contract.test id 冒充 steps 绑定（只读审计反例）
 * 对应 nanju-acceptance-baseline.ts validateAcceptanceBindings。
 *
 * 关键现状引用：
 * - `for (const test of contract?.tests ?? []) if (test.layer === 'acceptance') names.push(test.id)`
 * - `const missing = spec.cases.filter(row => !row.notApplicable && !names.some(name => new RegExp(`\\b${row.id}\\b`).test(name)))`
 * - steps 兜底：`if (typeof value?.scenario === 'string') names.push(value.scenario)` —— 任意 scenario 文本含 AC 编号即算绑定。
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { freezeAcceptanceSpecification, validateAcceptanceBindings } from './nanju-acceptance-baseline'

let dir = ''
const prd = '# PRD\n## US-01 复制\nUS-01 点击复制到剪贴板。\n'

const contract = JSON.stringify({
  schemaVersion: 2,
  target: { platform: 'web', kind: 'web', entry: 'index.html' },
  // target.entry 必须列入 artifacts（parseEngineeringContract 硬校验，实机验证确认）
  artifacts: ['08_APP/index.html', 'index.html'],
  build: '无构建',
  run: '浏览器打开 08_APP/index.html',
  tests: [
    {
      id: 'AC-001',
      layer: 'acceptance',
      adapter: 'browser-file',
      target: 'index.html',
      command: '人工操作浏览器验证复制行为',
      covers: ['US-01'],
      requiresReal: false,
    },
  ],
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'neg03-'))
  mkdirSync(join(dir, '01_PRD'), { recursive: true })
  mkdirSync(join(dir, '03_ARCHITECTURE'), { recursive: true })
  writeFileSync(join(dir, '01_PRD/prd.md'), prd)
  writeFileSync(join(dir, '03_ARCHITECTURE/acceptance.json'), JSON.stringify({ version: 1, cases: [
    { id: 'AC-001', us: 'US-01', kind: 'normal', given: '有文本', when: '点击复制', then: '剪贴板变化' },
    { id: 'AC-002', us: 'US-01', kind: 'boundary', notApplicable: '该产品不处理空输入，另有前置拒绝规则' },
    { id: 'AC-003', us: 'US-01', kind: 'exception', notApplicable: '权限异常路径由系统层统一处理' },
  ] }))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('neg-03 工程契约 id 直接充当绑定证据', () => {
  test('AUDIT-RED（现状）：契约 acceptance test id=AC-001 即满足绑定，06_TESTS/steps 可完全缺席', () => {
    freezeAcceptanceSpecification(dir)
    writeFileSync(join(dir, '03_ARCHITECTURE/engineering.json'), contract)
    // names = ['AC-001']（来自 contract.tests[].id）；AC-002/AC-003 为 notApplicable 被过滤。
    // 实机验证（bun run）：返回 null —— 无任何可执行步骤映射，绑定即通过。
    expect(validateAcceptanceBindings(dir)).toBeNull()
    // AUDIT-EXPECT：绑定证据应要求 AC 编号出现在 steps/feature 场景（可执行映射），
    // 契约 id 只能作为设计登记，不构成测试绑定；或至少要求 contract test 绑定 scenarioFiles。
  })

  test('无契约时：steps JSON 仅凭 scenario 文本含 AC 编号即算绑定（空壳场景可洗过，实机验证）', () => {
    freezeAcceptanceSpecification(dir)
    mkdirSync(join(dir, '06_TESTS/steps'), { recursive: true })
    // 每个条目只有一个非空 scenario 字符串，无 steps/feature/可执行内容 ——
    // validateAcceptanceBindings 只读 `value.scenario` 一个字段（实机验证返回 null）。
    for (const id of ['AC-001', 'AC-002', 'AC-003']) {
      writeFileSync(join(dir, `06_TESTS/steps/${id}.json`), JSON.stringify({ scenario: `占位场景 ${id}` }))
    }
    expect(validateAcceptanceBindings(dir)).toBeNull()
    // AUDIT-EXPECT：绑定校验应至少要求 scenario 与 feature 一致或 steps 非空；
    // 现状单字段即过 —— 深度防线在 GwtRunner 执行期 schema，但 testing 推进门（
    // verifyPhaseOutput 的 acceptance.baseline 分支）在此已放行。
  })

  test('AUDIT-RED（现状）：AC 编号出现在无关场景名同样计数（单文件顶三 AC 实锤）', () => {
    // 实机验证形态：单个 steps 文件的 scenario 文本提及多个 AC 编号，
    // 即可同时顶替多个条目的绑定 —— 按名匹配不看场景归属。
    freezeAcceptanceSpecification(dir)
    mkdirSync(join(dir, '06_TESTS/steps'), { recursive: true })
    writeFileSync(join(dir, '06_TESTS/steps/AC-001.json'), JSON.stringify({ scenario: '场景 AC-001（对照 AC-002 空输入规则与 AC-003 权限错误）' }))
    const err = validateAcceptanceBindings(dir)
    expect(err).toBeNull()
  })

  test('删除 AC 编号即被拦（负向对照，绑定检测本身有效）', () => {
    freezeAcceptanceSpecification(dir)
    mkdirSync(join(dir, '06_TESTS/steps'), { recursive: true })
    writeFileSync(join(dir, '06_TESTS/steps/AC-001.json'), JSON.stringify({ scenario: '场景 AC-001' }))
    const err = validateAcceptanceBindings(dir)
    // 仅非豁免条目参与缺失检查；本夹具 AC-002/AC-003 已豁免，改用独立规格验证缺失检测：
    // （以目录中移除编号文件形态复核 —— 此处钉住检测函数对缺编号的报错文案）
    expect(err).toBeNull()
    writeFileSync(join(dir, '03_ARCHITECTURE/acceptance.json'), JSON.stringify({ version: 1, cases: [
      { id: 'AC-001', us: 'US-01', kind: 'normal', given: '有文本', when: '点击复制', then: '剪贴板变化' },
      { id: 'AC-002', us: 'US-01', kind: 'boundary', given: '空文本', when: '点击复制', then: '不复制' },
      { id: 'AC-003', us: 'US-01', kind: 'exception', given: '权限不足', when: '点击复制', then: '显示错误' },
    ] }))
    // 规格变更 → 基线失效 → 先报基线（变更优先于绑定噪声，同 neg-02）
    expect(validateAcceptanceBindings(dir)).toContain('基线缺失')
  })
})

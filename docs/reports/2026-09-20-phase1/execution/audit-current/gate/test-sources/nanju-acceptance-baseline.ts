import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseUserStories } from './nanju-user-stories'
import { readJsonFileSafe, writeJsonFileAtomic } from './safe-file'

export const ACCEPTANCE_SPEC_PATH = '03_ARCHITECTURE/acceptance.json'
const BASELINE_PATH = '_acceptance-baseline.json'
export const ACCEPTANCE_SPEC_GUIDE = '编码前在 03_ARCHITECTURE/acceptance.json 写验收规格 {"version":1,"cases":[{"id":"AC-001","us":"US-001","kind":"normal","given":"前置条件","when":"动作","then":"可观察结果"}]}。每个PRD US必须覆盖 normal/boundary/exception；边界或异常确实不适用时以同结构条目含 notApplicable:"具体理由" 代替GWT字段。普通路径不可豁免。快消型后台工程经理的任务拆分、交付依赖与验收职责并入架构师：在架构文档列实施顺序、输入输出和验收编号。这里只前置规格，不要求应用已存在或测试已执行。进入编码时系统冻结；测试场景名必须保留每个适用的AC编号，不得删减难测项；需求变更需先走回退确认。'
interface AcceptanceCase { id: string; us: string; kind: 'normal' | 'boundary' | 'exception'; given?: string; when?: string; then?: string; notApplicable?: string }
interface Baseline { version: 1; specHash: string; prdHash: string; frozenAt: string; cases: AcceptanceCase[] }
function hash(text: string): string { return createHash('sha256').update(text).digest('hex') }

function readSpecification(projectDir: string): { specHash: string; prdHash: string; cases: AcceptanceCase[] } {
  const raw = readFileSync(join(projectDir, ACCEPTANCE_SPEC_PATH), 'utf8')
  const prd = readFileSync(join(projectDir, '01_PRD/prd.md'), 'utf8')
  const input = JSON.parse(raw) as { version?: unknown; cases?: unknown }
  if (input.version !== 1 || !Array.isArray(input.cases) || !input.cases.length) throw new Error('验收规格需version=1及非空cases')
  const stories = parseUserStories(prd)
  if (!stories.length) throw new Error('PRD缺少US编号')
  const seen = new Set<string>()
  const cases: AcceptanceCase[] = []
  for (const value of input.cases as unknown[]) {
    if (!value || typeof value !== 'object') throw new Error('验收条目必须为对象')
    const row = { ...(value as AcceptanceCase) }
    if (typeof row.us === 'string' && /^US-\d+$/i.test(row.us)) row.us = `US-${String(Number(row.us.slice(3))).padStart(2, '0')}`
    if (typeof row.id !== 'string' || !/^AC-\d+$/.test(row.id) || seen.has(row.id)) throw new Error('验收ID缺失或重复')
    seen.add(row.id)
    if (!stories.includes(row.us) || !['normal', 'boundary', 'exception'].includes(row.kind)) throw new Error(`${row.id}的US或kind无效`)
    if (row.notApplicable !== undefined) {
      if (row.kind === 'normal' || typeof row.notApplicable !== 'string' || row.notApplicable.trim().length < 6) throw new Error(`${row.id}豁免需具体理由，普通路径不得豁免`)
    } else if (![row.given, row.when, row.then].every(text => typeof text === 'string' && text.trim().length >= 2)) throw new Error(`${row.id}缺少具体given/when/then`)
    cases.push(row)
  }
  for (const us of stories) for (const kind of ['normal', 'boundary', 'exception']) {
    if (!cases.some(row => row.us === us && row.kind === kind)) throw new Error(`${us}缺少${kind}路径验收或不适用理由`)
  }
  return { specHash: hash(raw), prdHash: hash(prd), cases }
}

export function validateAcceptanceSpecification(projectDir: string, requireFrozen = false): string | null {
  try {
    const spec = readSpecification(projectDir)
    if (requireFrozen) {
      const baseline = readJsonFileSafe<Baseline>(join(projectDir, BASELINE_PATH))
      if (baseline?.version !== 1 || baseline.specHash !== spec.specHash || baseline.prdHash !== spec.prdHash) return '编码前验收基线缺失或已改变；请先回到架构确认验收范围，不能沿用旧基线。'
    }
    return null
  } catch (error) { return `前置验收规格不完整：${error instanceof Error ? error.message : String(error)}` }
}

/** 仅在已通过原授权门的进入coding事务中调用；读取规格不自动冻结。 */
export function freezeAcceptanceSpecification(projectDir: string): void {
  const spec = readSpecification(projectDir)
  writeJsonFileAtomic(join(projectDir, BASELINE_PATH), { version: 1, ...spec, frozenAt: new Date().toISOString() } satisfies Baseline)
}

/** testing须把冻结条目绑定到真实可执行steps；运行结果仍由GWT裁判判定。 */
export function validateAcceptanceBindings(projectDir: string): string | null {
  const error = validateAcceptanceSpecification(projectDir, true)
  if (error) return error
  const spec = readSpecification(projectDir)
  const stepsDir = join(projectDir, '06_TESTS/steps')
  const names: string[] = []
  const { ENGINEERING_CONTRACT_PATH, parseEngineeringContract } = require('./nanju-engineering-contract') as typeof import('./nanju-engineering-contract')
  if (existsSync(join(projectDir, ENGINEERING_CONTRACT_PATH))) {
    const contract = parseEngineeringContract(readFileSync(join(projectDir, ENGINEERING_CONTRACT_PATH), 'utf8')).contract
    for (const test of contract?.tests ?? []) if (test.layer === 'acceptance') names.push(test.id)
  }
  if (existsSync(stepsDir)) for (const name of readdirSync(stepsDir).filter(name => name.endsWith('.json'))) {
    const value = readJsonFileSafe<{ scenario?: unknown; feature?: unknown }>(join(stepsDir, name))
    if (typeof value?.scenario === 'string') names.push(value.scenario)
  }
  const missing = spec.cases.filter(row => !row.notApplicable && !names.some(name => new RegExp(`\\b${row.id}\\b`).test(name)))
  return missing.length ? `可执行测试缺少冻结验收编号：${missing.map(row => row.id).join('、')}；补充步骤映射，不得删除验收规格。` : null
}

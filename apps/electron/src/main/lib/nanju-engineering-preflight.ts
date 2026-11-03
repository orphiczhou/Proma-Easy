import { parseUserStories } from './nanju-user-stories'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ENGINEERING_CONTRACT_PATH, captureEngineeringEvidence, parseEngineeringContract, requiresEngineeringContract } from './nanju-engineering-contract'
import type { EngineeringEvidence } from './nanju-engineering-contract'

export interface EngineeringBrowserPreflight {
  mode: 'legacy-browser' | 'engineering-browser' | 'blocked'
  entry: string
  evidence: EngineeringEvidence | null
  reason: string | null
}

/**
 * 当前运行器仅注册browser-file。其他适配器接入前诚实阻塞，声明自身不获得执行权。
 * 即使browser-file可运行，也不为显式需要真实系统/服务能力的测试背书。
 */
export function prepareEngineeringBrowserRun(projectDir: string): EngineeringBrowserPreflight {
  const path = join(projectDir, ENGINEERING_CONTRACT_PATH)
  const blocked = (reason: string): EngineeringBrowserPreflight => ({ mode: 'blocked', entry: '', evidence: null, reason })
  if (!existsSync(path)) {
    if (requiresEngineeringContract(projectDir)) return blocked('非Web工程尚缺engineering.json，请先补齐真实交付和测试契约。')
    return { mode: 'legacy-browser', entry: '08_APP/index.html', evidence: null, reason: null }
  }
  const captured = captureEngineeringEvidence(projectDir)
  if (!captured.evidence) return blocked(captured.problems.join('；'))
  const parsed = parseEngineeringContract(readFileSync(path, 'utf-8'))
  if (!parsed.contract) return blocked(parsed.problems.join('；'))
  const contract = parsed.contract
  if (contract.tests.some((test) => test.scenarioFiles)) return blocked('本契约已绑定逐项浏览器场景，请走工程测试汇总及单次批准。')
  const unsupported = contract.tests.filter((test) => test.adapter !== 'browser-file')
  if (unsupported.length) return blocked('尚未接入实际测试驱动：' + unsupported.map((test) => test.id + '（' + test.adapter + '）').join('、') + '。不能以网页模拟替代；需接入并确认相应驱动后重跑。')
  const acceptance = contract.tests.filter((test) => test.layer === 'acceptance')
  const auxiliary = contract.tests.filter((test) => test.layer !== 'acceptance')
  if (auxiliary.length) return blocked('辅助测试尚未接入对应执行驱动：' + auxiliary.map((test) => test.id).join('、') + '。浏览器用户故事通过不能替代这些测试结果。')
  // 复用宿主US编号解析；只验证设计覆盖的对应关系，不代替执行结果覆盖。
  const stories = parseUserStories(readFileSync(join(projectDir, '01_PRD/prd.md'), 'utf-8'))
  const planned = new Set(acceptance.flatMap((test) => test.covers.map((id) => `US-${String(Number(id.slice(3))).padStart(2, '0')}`)))
  if (!stories.length || stories.some((id) => !planned.has(id)) || [...planned].some((id) => !stories.includes(id))) {
    return blocked('工程测试设计与当前PRD用户故事不对应，请补全缺失故事或移除过时引用后重试。')
  }
  if (contract.target.kind !== 'web' || acceptance.some((test) => test.requiresReal || test.target !== contract.target.entry)) {
    return blocked('当前浏览器文件测试只能验证静态Web入口，无法证明本契约要求的真实系统/服务能力或其他被测产物。')
  }
  if (!/\.html?$/i.test(contract.target.entry)) return blocked('browser-file 入口必须是实际可打开的 HTML 文件')
  return { mode: 'engineering-browser', entry: '08_APP/' + contract.target.entry, evidence: captured.evidence, reason: null }
}

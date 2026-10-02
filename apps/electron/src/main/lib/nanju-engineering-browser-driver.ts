/** 文件浏览器工程驱动：场景来源于契约，实际执行复用GWT，不把项目脚本输出冒充DOM观察。 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ENGINEERING_CONTRACT_PATH, parseEngineeringContract } from './nanju-engineering-contract'
import { parseUserStories } from './nanju-user-stories'
import { EngineeringExecutionBlocked } from './nanju-engineering-execution'
import type { EngineeringExecutionInput, EngineeringRegisteredDriver } from './nanju-engineering-execution'
import type { EngineeringServiceHandle } from './nanju-engineering-service'
import type { GwtScenarioFile, GwtScenarioResult } from './nanju-gwt-runner'

interface BrowserDriverServices {
  browserPrerequisite?(): string | null
  validate(raw: string): { scenario: GwtScenarioFile | null; errors: string[] }
  run(input: EngineeringExecutionInput, scenarios: GwtScenarioFile[]): Promise<GwtScenarioResult[]>
}

export function createEngineeringBrowserFileDriver(services: BrowserDriverServices): EngineeringRegisteredDriver {
  function load(input: EngineeringExecutionInput): GwtScenarioFile[] {
    if (input.signal.aborted) throw new EngineeringExecutionBlocked('浏览器测试已取消')
    const browserReason = services.browserPrerequisite?.()
    if (browserReason) throw new EngineeringExecutionBlocked(browserReason)
    const contract = parseEngineeringContract(readFileSync(join(input.projectDir, ENGINEERING_CONTRACT_PATH), 'utf-8')).contract
    if (!contract) throw new EngineeringExecutionBlocked('工程契约不可读')
    if (input.test.layer === 'acceptance' && (contract.target.kind !== 'web' || input.test.target !== contract.target.entry)) throw new EngineeringExecutionBlocked('browser-file验收必须使用Web工程的实际交付入口')
    if (!/\.html?$/i.test(input.test.target)) throw new EngineeringExecutionBlocked('browser-file测试对象必须是实际HTML文件')
    if (!input.test.scenarioFiles?.length) throw new EngineeringExecutionBlocked('浏览器测试缺少scenarioFiles场景绑定：' + input.test.id)
    const planned = parseUserStories(input.test.covers.join(' '))
    const observed = new Set<string>()
    const scenarios = input.test.scenarioFiles.map((file) => {
      const parsed = services.validate(readFileSync(join(input.projectDir, '06_TESTS', file), 'utf-8'))
      if (!parsed.scenario || parsed.errors.length) throw new EngineeringExecutionBlocked('浏览器场景不可执行：' + file + '；' + parsed.errors.join('；'))
      const scenario = parsed.scenario
      const stories = parseUserStories(scenario.feature + ' ' + scenario.scenario)
      if (input.test.layer === 'acceptance' && (!stories.length || stories.some((id) => !planned.includes(id)))) throw new EngineeringExecutionBlocked('浏览器场景用户故事与本项契约不对应：' + file)
      if (input.test.layer !== 'acceptance' && stories.length) throw new EngineeringExecutionBlocked('辅助浏览器测试不能标记用户故事覆盖：' + file)
      // 仅点击/填写成功不是行为验收；必须至少有实际Then断言，截图警告不算断言。
      if (!scenario.steps.some((step) => step.kind === 'then' && step.op && ['assert-text', 'assert-visible', 'assert-count'].includes(step.op.type))) throw new EngineeringExecutionBlocked('浏览器场景缺少可执行Then行为断言：' + file)
      for (const story of stories) observed.add(story)
      return scenario
    })
    if (planned.some((id) => !observed.has(id))) throw new EngineeringExecutionBlocked('浏览器场景未覆盖本项计划用户故事')
    return scenarios
  }
  return {
    adapter: 'browser-file',
    preflight(input) {
      try { load(input); return null }
      catch (error) { return error instanceof Error ? error.message : '浏览器场景不可读' }
    },
    async execute(input) {
      const scenarios = load(input)
      const results = await services.run(input, scenarios)
      if (input.signal.aborted) throw new EngineeringExecutionBlocked('浏览器测试已取消，本轮结果不用于交付')
      if (results.length !== scenarios.length) throw new Error('浏览器执行结果数量与场景不对应')
      const checks = results.flatMap((result, index) => {
        const scenario = scenarios[index]!
        if (result.feature !== scenario.feature || result.scenario !== scenario.scenario) throw new Error('浏览器执行结果与场景不对应')
        const stories: Array<string | null> = input.test.layer === 'acceptance' ? parseUserStories(scenario.feature + ' ' + scenario.scenario) : [null]
        return stories.map((storyId) => ({ storyId, label: result.scenario, expected: 'pass', actual: result.status,
          evidence: [JSON.stringify({ source: 'host-gwt-browser-file', scenarioFile: input.test.scenarioFiles![index], target: input.test.target, result })] }))
      })
      // 浏览器任务正常返回以exitCode=0适配统一完成协议，并非OS进程退出证据；行为成败由实际场景决定。
      return { testId: input.test.id, target: input.test.target, exitCode: 0, checks }
    },
  }
}

/**
 * browser-url 工程驱动（W-C）：宿主持有的 loopback 服务 + 专用 URL tab。
 * 边界：startService 仅在 execute（单次批准之后）调用；服务就绪/退出/取消/结束一律由
 * 宿主句柄停服务；场景逐条 reload 实际入口 URL；拒绝把服务计划之外的任意 URL 当作产物。
 * 测试注入 fake 服务句柄与 fake browser，不真实 spawn、不真实监听端口、不开 dev。
 */
export function createEngineeringBrowserUrlDriver(services: {
  browserPrerequisite?(): string | null
  validate(raw: string): { scenario: GwtScenarioFile | null; errors: string[] }
  /** S5：无副作用校验服务运行时/文件（不探测端口、不 spawn），preflight 阶段调用。 */
  serviceEnvironment?(input: EngineeringExecutionInput): string | null
  startService(input: EngineeringExecutionInput): Promise<EngineeringServiceHandle>
  run(input: EngineeringExecutionInput, scenarios: GwtScenarioFile[], url: string): Promise<GwtScenarioResult[]>
}): EngineeringRegisteredDriver {
  function load(input: EngineeringExecutionInput): GwtScenarioFile[] {
    if (input.signal.aborted) throw new EngineeringExecutionBlocked('浏览器测试已取消')
    const browserReason = services.browserPrerequisite?.()
    if (browserReason) throw new EngineeringExecutionBlocked(browserReason)
    if (!input.test.service) throw new EngineeringExecutionBlocked('browser-url测试缺少service服务计划，不能执行command说明')
    const envReason = services.serviceEnvironment?.(input)
    if (envReason) throw new EngineeringExecutionBlocked(envReason)
    const contract = parseEngineeringContract(readFileSync(join(input.projectDir, ENGINEERING_CONTRACT_PATH), 'utf-8')).contract
    if (!contract) throw new EngineeringExecutionBlocked('工程契约不可读')
    if (input.test.layer === 'acceptance' && (contract.target.kind !== 'web' || input.test.target !== contract.target.entry)) throw new EngineeringExecutionBlocked('browser-url验收必须使用Web工程的实际交付入口')
    if (!input.test.scenarioFiles?.length) throw new EngineeringExecutionBlocked('浏览器测试缺少scenarioFiles场景绑定：' + input.test.id)
    const planned = parseUserStories(input.test.covers.join(' '))
    const observed = new Set<string>()
    const scenarios = input.test.scenarioFiles.map((file) => {
      const parsed = services.validate(readFileSync(join(input.projectDir, '06_TESTS', file), 'utf-8'))
      if (!parsed.scenario || parsed.errors.length) throw new EngineeringExecutionBlocked('浏览器场景不可执行：' + file + '；' + parsed.errors.join('；'))
      const scenario = parsed.scenario
      const stories = parseUserStories(scenario.feature + ' ' + scenario.scenario)
      if (input.test.layer === 'acceptance' && (!stories.length || stories.some((id) => !planned.includes(id)))) throw new EngineeringExecutionBlocked('浏览器场景用户故事与本项契约不对应：' + file)
      if (input.test.layer !== 'acceptance' && stories.length) throw new EngineeringExecutionBlocked('辅助浏览器测试不能标记用户故事覆盖：' + file)
      if (!scenario.steps.some((step) => step.kind === 'then' && step.op && ['assert-text', 'assert-visible', 'assert-count'].includes(step.op.type))) throw new EngineeringExecutionBlocked('浏览器场景缺少可执行Then行为断言：' + file)
      for (const story of stories) observed.add(story)
      return scenario
    })
    if (planned.some((id) => !observed.has(id))) throw new EngineeringExecutionBlocked('浏览器场景未覆盖本项计划用户故事')
    return scenarios
  }
  return {
    adapter: 'browser-url',
    preflight(input) {
      try { load(input); return null }
      catch (error) { return error instanceof Error ? error.message : '浏览器场景不可读' }
    },
    async execute(input) {
      const scenarios = load(input)
      const handle = await services.startService(input)
      try {
        const url = handle.entryUrl(input.test.target)
        const results = await services.run(input, scenarios, url)
        if (handle.hasExited()) throw new Error('服务在浏览器场景执行期间退出，退出码 ' + (handle.exitCode() ?? '未知') + '，本轮结果不可用')
        if (input.signal.aborted) throw new EngineeringExecutionBlocked('浏览器测试已取消，本轮结果不用于交付')
        if (results.length !== scenarios.length) throw new Error('浏览器执行结果数量与场景不对应')
        const checks = results.flatMap((result, index) => {
          const scenario = scenarios[index]!
          if (result.feature !== scenario.feature || result.scenario !== scenario.scenario) throw new Error('浏览器执行结果与场景不对应')
          const stories: Array<string | null> = input.test.layer === 'acceptance' ? parseUserStories(scenario.feature + ' ' + scenario.scenario) : [null]
          return stories.map((storyId) => ({ storyId, label: result.scenario, expected: 'pass', actual: result.status,
            evidence: [JSON.stringify({ source: 'host-gwt-browser-url', url, scenarioFile: input.test.scenarioFiles![index], target: input.test.target, result })] }))
        })
        // browser-url 正常返回以exitCode=0适配统一完成协议；行为成败由实际场景决定，服务生命周期由finally停止。
        return { testId: input.test.id, target: input.test.target, exitCode: 0, checks }
      } finally {
        await handle.stop()
      }
    },
  }
}

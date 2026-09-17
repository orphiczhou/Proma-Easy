import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { tmpdir } from 'node:os'
import { captureEngineeringEvidence, parseEngineeringContract } from './nanju-engineering-contract'
import { EngineeringExecutionBlocked, runRegisteredEngineeringTest } from './nanju-engineering-execution'
import { createEngineeringProcessDrivers } from './nanju-engineering-process-driver'
import { detectEngineeringPython } from './nanju-engineering-runtime'
import type { EngineeringExecutionInput } from './nanju-engineering-execution'

let root = ''
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = '' })
function fixture(script: string, timeoutMs = 3000): EngineeringExecutionInput {
  root = mkdtempSync(join(tmpdir(), 'nanju-driver-'))
  for (const sub of ['01_PRD', '03_ARCHITECTURE', '08_APP']) mkdirSync(join(root, sub))
  writeFileSync(join(root, '01_PRD/prd.md'), '# PRD\nUS-01 读取应用数据')
  writeFileSync(join(root, '08_APP/app.txt'), 'hello')
  writeFileSync(join(root, '08_APP/check.cjs'), script)
  const raw = JSON.stringify({ schemaVersion: 1, target: { kind: 'cli', platform: 'Linux', entry: 'app.txt' }, artifacts: ['app.txt', 'check.cjs'], build: 'fixture', run: 'fixture', tests: [{ id: 'read', layer: 'acceptance', adapter: 'cli-driver', target: 'app.txt', command: '隔离fixture读取文件，不是产品US验收', covers: ['US-01'], requiresReal: true, driver: { runtime: 'node', path: 'check.cjs', args: [], timeoutMs } }] })
  writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), raw)
  return { projectDir: root, test: parseEngineeringContract(raw).contract!.tests[0]!, evidence: captureEngineeringEvidence(root).evidence!, signal: new AbortController().signal }
}
const script = `const fs=require('node:fs'); const request=JSON.parse(fs.readFileSync(0,'utf8')); const actual=fs.readFileSync(request.target,'utf8'); console.log(JSON.stringify({testId:request.testId,target:request.target,checks:[{storyId:'US-01',label:'读取fixture',expected:'hello',actual,evidence:['读取被测文件:'+request.target]}]}));`
// 系统Node用于真实进程fixture，不用Bun冒充Node，也不锁定某个发行版目录。
const nodePath = Bun.which('node')
if (!nodePath || !isAbsolute(nodePath)) throw new Error('真实进程fixture需要已安装的系统Node；禁止自动安装或用Bun替代')
const drivers = () => createEngineeringProcessDrivers({ nodePath })

describe('Given 明确批准的隔离工程fixture，When 使用注册进程驱动，Then 执行并收集实际结果', () => {
  test('Then 真实node子进程读取目标，宿主使用实际退出码', async () => {
    const result = await runRegisteredEngineeringTest(fixture(script), { drivers: drivers(), approve: async () => true })
    expect(result.status).toBe('pass')
    expect(result.checks[0]?.actual).toBe('hello')
  })
  test('Then 子进程退出异常不能由输出报告覆盖', async () => {
    const result = await runRegisteredEngineeringTest(fixture(script + '\nprocess.exitCode=2;'), { drivers: drivers(), approve: async () => true })
    expect(result.status).toBe('fail')
  })
  test('Then 等待超时终止测试，不伪造pass', async () => {
    const result = await runRegisteredEngineeringTest(fixture('setInterval(()=>{},1000)', 100), { drivers: drivers(), approve: async () => true })
    expect(result.status).toBe('error')
    expect(result.reason).toContain('超时')
  })
  test('Then 输出超过上限终止测试', async () => {
    const result = await runRegisteredEngineeringTest(fixture("process.stdout.write('x'.repeat(20000))"), { drivers: createEngineeringProcessDrivers({ nodePath, maxOutputBytes: 1024 }), approve: async () => true })
    expect(result.status).toBe('error')
    expect(result.reason).toContain('输出')
  })
  test('Then 缺少配置的运行时只报告环境阻塞', async () => {
    const result = await runRegisteredEngineeringTest(fixture(script), { drivers: createEngineeringProcessDrivers({}), approve: async () => true })
    expect(result.status).toBe('blocked')
    expect(result.reason).toContain('运行时')
  })
})

test('Given 已启动的测试子进程 When 用户取消 Then 进程结束且结果为blocked', async () => {
  const input = fixture('setInterval(()=>{},1000)', 5000)
  const abort = new AbortController()
  const pending = runRegisteredEngineeringTest({ ...input, signal: abort.signal }, { drivers: drivers(), approve: async () => true })
  const timer = setTimeout(() => abort.abort(), 50)
  try {
    const result = await pending
    expect(result.status).toBe('blocked')
    expect(result.reason).toContain('取消')
  } finally { clearTimeout(timer) }
})


test('Given 宿主已安装Python3 When 逐项批准后执行隔离fixture Then 使用真实解释器与OS退出码', async () => {
  const pythonPath = await detectEngineeringPython()
  if (!pythonPath) throw new Error('此真实进程fixture需要宿主Python3，未安装时不能宣称验证通过')
  const input = fixture('占位文件，不作为Python执行内容')
  const raw = JSON.parse(readFileSync(join(root, '03_ARCHITECTURE/engineering.json'), 'utf-8'))
  raw.artifacts = ['app.txt', 'check.py']
  raw.tests[0].driver = { runtime: 'python3', path: 'check.py', args: [], timeoutMs: 3000 }
  writeFileSync(join(root, '08_APP/check.py'), `import json, sys
from pathlib import Path
request = json.load(sys.stdin)
actual = Path(request['target']).read_text()
print(json.dumps({'testId': request['testId'], 'target': request['target'], 'checks': [{'storyId':'US-01','label':'读取fixture','expected':'hello','actual':actual,'evidence':['宿主Python读取fixture文件']}]}))
`)
  const contractRaw = JSON.stringify(raw)
  writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), contractRaw)
  let approvals = 0
  const result = await runRegisteredEngineeringTest({ ...input, test: parseEngineeringContract(contractRaw).contract!.tests[0]!, evidence: captureEngineeringEvidence(root).evidence! }, {
    drivers: createEngineeringProcessDrivers({ pythonPath }), approve: async () => { approvals += 1; return true },
  })
  expect(approvals).toBe(1)
  expect(result.status).toBe('pass')
  expect(result.checks[0]?.actual).toBe('hello')
})

describe('Given 驱动文件在执行窗口内缺失或不是普通文件，When 调用注册驱动，Then 归一为EngineeringExecutionBlocked', () => {
  const cliDriver = () => {
    const driver = createEngineeringProcessDrivers({ nodePath }).find((candidate) => candidate.adapter === 'cli-driver')
    if (!driver) throw new Error('cli-driver 未注册')
    return driver
  }

  test('Then 缺文件抛 EngineeringExecutionBlocked 而不是裸 ENOENT，且不在调用处同步 throw', async () => {
    const input = fixture(script)
    rmSync(join(root, '08_APP/check.cjs'))
    let syncThrow: unknown = null
    let pending: Promise<unknown> = Promise.resolve(null)
    try {
      pending = cliDriver().execute(input)
    } catch (error) {
      syncThrow = error
    }
    expect(syncThrow).toBeNull()
    await expect(pending).rejects.toBeInstanceOf(EngineeringExecutionBlocked)
  })

  test('Then 驱动路径不是普通文件（目录占位）同样归类为驱动文件不可用', async () => {
    const input = fixture(script)
    rmSync(join(root, '08_APP/check.cjs'))
    mkdirSync(join(root, '08_APP/check.cjs'))
    await expect(cliDriver().execute(input)).rejects.toBeInstanceOf(EngineeringExecutionBlocked)
  })
})

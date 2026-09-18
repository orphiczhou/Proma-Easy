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
/** Y-05：当前 fixture 的执行输入（fixture() 返回值被上一用例消费后 root 仍指向最新 fixture） */
function input2OfCurrentFixture(): EngineeringExecutionInput {
  const raw = readFileSync(join(root, '03_ARCHITECTURE/engineering.json'), 'utf-8')
  return { projectDir: root, test: parseEngineeringContract(raw).contract!.tests[0]!, evidence: captureEngineeringEvidence(root).evidence!, signal: new AbortController().signal }
}

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

// ===== P0-1（2026-09-18）：契约声明式 env 透传（行为法验证——子进程回显 env，
// 不用 /proc/environ：Chromium 会擦除 environ 视图，G3b 实证假阳性教训） =====
describe('Given schema v2 契约声明 driver.env，When 驱动执行，Then 白名单∪契约 env 生效', () => {
  test('Then 声明的环境变量透传到子进程（子进程行为回显，非 /proc 读取）', async () => {
    const savedToken = process.env['NANJU_P01_TEST_TOKEN']
    process.env['NANJU_P01_TEST_TOKEN'] = 'p1-透传验证-通过'
    try {
      const echoScript = `const fs=require('node:fs'); const request=JSON.parse(fs.readFileSync(0,'utf8'));
const token=process.env.NANJU_P01_TEST_TOKEN ?? 'MISSING';
console.log(JSON.stringify({testId:request.testId,target:request.target,checks:[{storyId:'US-01',label:'env透传',expected:'p1-透传验证-通过',actual:token,evidence:['子进程回显 env 值:'+token]}]}));`
      fixture(echoScript)
      const raw = JSON.parse(readFileSync(join(root, '03_ARCHITECTURE/engineering.json'), 'utf-8'))
      raw.schemaVersion = 2
      raw.tests[0].driver.env = ['NANJU_P01_TEST_TOKEN']
      writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), JSON.stringify(raw))
      const input2: EngineeringExecutionInput = { projectDir: root, test: parseEngineeringContract(JSON.stringify(raw)).contract!.tests[0]!, evidence: captureEngineeringEvidence(root).evidence!, signal: new AbortController().signal }
      const result = await runRegisteredEngineeringTest(input2, { drivers: drivers(), approve: async () => true })
      expect(result.status).toBe('pass')
      expect(result.checks[0]?.actual).toBe('p1-透传验证-通过')
    } finally {
      if (savedToken === undefined) delete process.env['NANJU_P01_TEST_TOKEN']
      else process.env['NANJU_P01_TEST_TOKEN'] = savedToken
    }
  })
  test('Then 未声明的变量不透传（白名单∪契约 env，不是全量继承）', async () => {
    const savedLeak = process.env['NANJU_P01_SECRET_LEAK']
    process.env['NANJU_P01_SECRET_LEAK'] = 'must-not-pass'
    try {
      const echoScript = `const fs=require('node:fs'); const request=JSON.parse(fs.readFileSync(0,'utf8'));
const leak=process.env.NANJU_P01_SECRET_LEAK ?? 'NOT_PRESENT';
console.log(JSON.stringify({testId:request.testId,target:request.target,checks:[{storyId:'US-01',label:'env隔离',expected:'NOT_PRESENT',actual:leak,evidence:['未声明变量不透传:'+leak]}]}));`
      fixture(echoScript)
      const raw = JSON.parse(readFileSync(join(root, '03_ARCHITECTURE/engineering.json'), 'utf-8'))
      raw.schemaVersion = 2
      // 不声明 NANJU_P01_SECRET_LEAK
      writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), JSON.stringify(raw))
      const input2: EngineeringExecutionInput = { projectDir: root, test: parseEngineeringContract(JSON.stringify(raw)).contract!.tests[0]!, evidence: captureEngineeringEvidence(root).evidence!, signal: new AbortController().signal }
      const result = await runRegisteredEngineeringTest(input2, { drivers: drivers(), approve: async () => true })
      expect(result.status).toBe('pass')
      expect(result.checks[0]?.actual).toBe('NOT_PRESENT')
    } finally {
      if (savedLeak === undefined) delete process.env['NANJU_P01_SECRET_LEAK']
      else process.env['NANJU_P01_SECRET_LEAK'] = savedLeak
    }
  })
  test('Then 过渡期兜底：DASHSCOPE_API_KEY 仍透传（防空窗；触发件满足后独立提交移除）', async () => {
    // Y-05：保存/恢复原值（测试机若 source 过 secrets.sh 持有真实键，不得被永久删除）
    const savedKey = process.env['DASHSCOPE_API_KEY']
    process.env['DASHSCOPE_API_KEY'] = 'dashscope-transition-fallback'
    try {
      const echoScript = `const fs=require('node:fs'); const request=JSON.parse(fs.readFileSync(0,'utf8'));
const token=process.env.DASHSCOPE_API_KEY ? 'present' : 'MISSING'; // 只断言存在性，不回显值
console.log(JSON.stringify({testId:request.testId,target:request.target,checks:[{storyId:'US-01',label:'过渡兜底',expected:'present',actual:token,evidence:['DASHSCOPE 过渡透传在场（存在性断言，值不回显）']}]}));`
      fixture(echoScript)
      const result = await runRegisteredEngineeringTest(input2OfCurrentFixture(), { drivers: drivers(), approve: async () => true })
      expect(result.status).toBe('pass')
    } finally {
      if (savedKey === undefined) delete process.env['DASHSCOPE_API_KEY']
      else process.env['DASHSCOPE_API_KEY'] = savedKey
    }
  })
})

// ===== P0-2（2026-09-18）：驱动 IO 尾部随结果/错误透传 =====
describe('Given 驱动写 stderr，When 执行完成或失败，Then IO 尾部进结果', () => {
  test('Then 成功返回但检查缺失（invalid 路径）时 driverIo 随结果透传', async () => {
    // 驱动正常返回 JSON 但缺 checks（interpret invalid：G3b 固定句场景）——stderr 诊断须在场
    const badScript = `const fs=require('node:fs'); const request=JSON.parse(fs.readFileSync(0,'utf8'));
console.error('ERROR: HTTP 400 from dashscope: model not found');
console.log(JSON.stringify({testId:request.testId,target:request.target,checks:[]}));`
    const result = await runRegisteredEngineeringTest(fixture(badScript), { drivers: drivers(), approve: async () => true })
    expect(result.status).toBe('error')
    expect(result.reason).toContain('测试驱动结果不可用') // invalid 固定句（G3b 盲修场景同路径）
    expect(result.driverIo?.stderrTail).toContain('HTTP 400')
  })
  test('Then 驱动崩溃（非法 JSON 输出，exit 1）时 driverIo 随错误透传', async () => {
    const crashScript = `const fs=require('node:fs'); fs.readFileSync(0,'utf8');
console.error('Traceback (most recent call last): simulated');
process.stdout.write('not-json'); process.exit(1);`
    const result = await runRegisteredEngineeringTest(fixture(crashScript), { drivers: drivers(), approve: async () => true })
    expect(result.status).toBe('error')
    expect(result.driverIo?.stderrTail).toContain('Traceback')
  })
})

// ===== Y-01（L2 批，2026-09-18）：驱动尾部密钥脱敏（行为法：子进程真实回显 env，假值不入断言外任何地方） =====
describe('Given 契约声明 env 且驱动调试残留回显环境变量，When 驱动执行，Then 尾部透传前已脱敏', () => {
  test('Then 已知注入值在 stderr 尾部被掩为 ***，正常诊断行不受伤', async () => {
    const fakeKey = 'y01-fake-secret-value-1234567890' // 构造假值，非真实密钥
    const saved = process.env['NANJU_Y01_FAKE_KEY']
    process.env['NANJU_Y01_FAKE_KEY'] = fakeKey
    try {
      const echoScript = `const fs=require('node:fs'); const request=JSON.parse(fs.readFileSync(0,'utf8'));
console.error('DEBUG env dump: ' + (process.env.NANJU_Y01_FAKE_KEY ?? 'MISSING'));
console.error('ERROR: HTTP 400 from dashscope: model not found');
console.error('token sk-AbcdefgH1234567890 rejected');
console.log(JSON.stringify({testId:request.testId,target:request.target,checks:[{storyId:'US-01',label:'脱敏',expected:'x',actual:'x',evidence:['y01']}]}));`
      fixture(echoScript)
      const raw = JSON.parse(readFileSync(join(root, '03_ARCHITECTURE/engineering.json'), 'utf-8'))
      raw.schemaVersion = 2
      raw.tests[0].driver.env = ['NANJU_Y01_FAKE_KEY']
      writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), JSON.stringify(raw))
      const input2: EngineeringExecutionInput = { projectDir: root, test: parseEngineeringContract(JSON.stringify(raw)).contract!.tests[0]!, evidence: captureEngineeringEvidence(root).evidence!, signal: new AbortController().signal }
      const result = await runRegisteredEngineeringTest(input2, { drivers: drivers(), approve: async () => true })
      const stderrTail = result.driverIo?.stderrTail ?? ''
      // 已知注入值（a 路）：整串掩码，原始值不进尾部透传链
      expect(stderrTail).toContain('DEBUG env dump: ***')
      expect(stderrTail).not.toContain(fakeKey)
      // 通用密钥模式（b 路）：驱动回显的未知 sk- 密钥保留前缀掩码
      expect(stderrTail).toContain('sk-***')
      expect(stderrTail).not.toContain('sk-AbcdefgH1234567890')
      // 正常诊断行零误伤：G3b 样本句式原样在场
      expect(stderrTail).toContain('ERROR: HTTP 400 from dashscope: model not found')
    } finally {
      if (saved === undefined) delete process.env['NANJU_Y01_FAKE_KEY']
      else process.env['NANJU_Y01_FAKE_KEY'] = saved
    }
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

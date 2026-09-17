import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseEngineeringContract, captureEngineeringEvidence, requiresEngineeringContract } from './nanju-engineering-contract'

const contract = {
  schemaVersion: 1,
  target: { platform: 'Linux X11', kind: 'desktop', entry: 'bin/dictation' },
  artifacts: ['bin/dictation', 'resources/settings.json'],
  build: '使用架构选定的桌面工具链构建；安装另行确认',
  run: '双击 bin/dictation；麦克风与外部输入需真人授权',
  tests: [
    { id: 'config-unit', layer: 'unit', adapter: 'cli-driver', target: 'bin/dictation', command: '运行配置单测', covers: [], requiresReal: false },
    { id: 'dictation-e2e', layer: 'acceptance', adapter: 'native-driver', target: 'bin/dictation', command: '原生驱动验证录音到编辑器', covers: ['US-01'], requiresReal: true },
  ],
}
let dir: string | undefined
function fixture(): string {
  dir = mkdtempSync(join(tmpdir(), 'nanju-engineering-contract-'))
  mkdirSync(join(dir, '08_APP/bin'), { recursive: true })
  mkdirSync(join(dir, '08_APP/resources'), { recursive: true })
  mkdirSync(join(dir, '01_PRD'), { recursive: true })
  mkdirSync(join(dir, '03_ARCHITECTURE'), { recursive: true })
  writeFileSync(join(dir, '08_APP/bin/dictation'), 'native test fixture, not an executable acceptance proof')
  writeFileSync(join(dir, '08_APP/resources/settings.json'), '{}')
  writeFileSync(join(dir, '01_PRD/prd.md'), '# PRD\nUS-01 语音输入')
  writeFileSync(join(dir, '03_ARCHITECTURE/engineering.json'), JSON.stringify(contract))
  return dir
}
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined })

describe('Given 架构工程契约，When 解析声明，Then 不把设计当执行证明', () => {
  test('Then 桌面正常契约保留原生验收与单测的不同覆盖口径', () => {
    const result = parseEngineeringContract(JSON.stringify(contract))
    expect(result.problems).toEqual([])
    expect(result.contract?.target.entry).toBe('bin/dictation')
    expect(result.contract?.tests[0]?.covers).toEqual([])
    expect(result.contract?.tests[1]?.requiresReal).toBe(true)
  })
  test('Then CLI及Web产物不强制同一个HTML入口', () => {
    for (const kind of ['cli', 'web'] as const) {
      expect(parseEngineeringContract(JSON.stringify({ ...contract, target: { ...contract.target, kind } })).contract?.target.kind).toBe(kind)
    }
  })
  test('Then 缺字段或不支持的版本明确返回问题', () => {
    for (const raw of ['{', '{}', JSON.stringify({ ...contract, schemaVersion: 2 }), JSON.stringify({ ...contract, build: '' })]) {
      expect(parseEngineeringContract(raw).contract).toBeNull()
      expect(parseEngineeringContract(raw).problems.length).toBeGreaterThan(0)
    }
  })
  test('Then 产物、入口和测试对象必须相互对应', () => {
    for (const changed of [
      { ...contract, artifacts: [] },
      { ...contract, artifacts: ['resources/settings.json'] },
      { ...contract, tests: [{ ...contract.tests[1], target: 'bin/another-app' }] },
      { ...contract, tests: [contract.tests[1], contract.tests[1]] },
    ]) expect(parseEngineeringContract(JSON.stringify(changed)).contract).toBeNull()
  })
  test('Then 辅助单测不能登记为用户故事验收，验收须声明真实边界与覆盖', () => {
    for (const changed of [
      { ...contract.tests[0], covers: ['US-01'] },
      { ...contract.tests[1], covers: [] },
      { ...contract.tests[1], requiresReal: undefined },
      { ...contract.tests[1], adapter: 'unknown' },
    ]) expect(parseEngineeringContract(JSON.stringify({ ...contract, tests: [changed] })).contract).toBeNull()
  })
})

describe('Given 项目实际文件，When 捕获指纹，Then 绑定PRD、工程契约和全部产物', () => {
  test('Then 相同文件可重现指纹，第二个产物变化使绑定失效', () => {
    const root = fixture()
    const first = captureEngineeringEvidence(root)
    expect(first.problems).toEqual([])
    expect(first.evidence?.artifacts.length).toBe(2)
    expect(captureEngineeringEvidence(root).evidence).toEqual(first.evidence)
    writeFileSync(join(root, '08_APP/resources/settings.json'), '{"language":"zh"}')
    expect(captureEngineeringEvidence(root).evidence?.digest).not.toBe(first.evidence?.digest)
  })
  test('Then PRD或契约更新均产生新的绑定', () => {
    const root = fixture()
    const first = captureEngineeringEvidence(root).evidence
    writeFileSync(join(root, '01_PRD/prd.md'), '# PRD\nUS-01 修订语音输入行为')
    const second = captureEngineeringEvidence(root).evidence
    expect(second?.digest).not.toBe(first?.digest)
    writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), JSON.stringify({ ...contract, run: '从桌面应用列表启动' }))
    expect(captureEngineeringEvidence(root).evidence?.digest).not.toBe(second?.digest)
  })
  test('Then 缺少真实产物明确说明路径，不产生部分通过的指纹', () => {
    const root = fixture()
    rmSync(join(root, '08_APP/bin/dictation'))
    const result = captureEngineeringEvidence(root)
    expect(result.evidence).toBeNull()
    expect(result.problems.join('；')).toContain('bin/dictation')
  })
})


describe('Given 旧项目品类文档，When 判断契约迁移，Then 与平台品类提取同源', () => {
  test('Then 中文冒号和引用变体的桌面工程不能回落网页', () => {
    const root = fixture()
    for (const marker of ['projectCategory: desktop-app', 'projectCategory：desktop-app', 'projectCategory: `desktop-app`', 'projectCategory: "DESKTOP-APP"']) {
      writeFileSync(join(root, '03_ARCHITECTURE/architecture.md'), '# 架构\n' + marker)
      expect(requiresEngineeringContract(root)).toBe(true)
    }
    writeFileSync(join(root, '03_ARCHITECTURE/architecture.md'), '# 架构\nprojectCategory: web-fullstack')
    expect(requiresEngineeringContract(root)).toBe(false)
  })
})

describe('Given 项目测试驱动声明，When 解析和捕获版本，Then 执行文件属于批准对象', () => {
  test('Then 驱动路径必须列入产物且参数为数组，不接受命令说明作为入口', () => {
    const driver = { runtime: 'node', path: 'tests/check.cjs', args: [], timeoutMs: 10000 }
    const value = { ...contract, tests: [{ ...contract.tests[1], driver }] }
    expect(parseEngineeringContract(JSON.stringify(value)).contract).toBeNull()
    const declared = { ...value, artifacts: [...contract.artifacts, driver.path] }
    expect(parseEngineeringContract(JSON.stringify(declared)).problems).toEqual([])
    expect(parseEngineeringContract(JSON.stringify({ ...declared, tests: [{ ...value.tests[0], driver: { ...driver, args: 'test' } }] })).contract).toBeNull()
  })
  test('Then 驱动源码更新也让批准绑定失效', () => {
    const root = fixture()
    mkdirSync(join(root, '08_APP/tests'))
    writeFileSync(join(root, '08_APP/tests/check.cjs'), '// 第一版驱动')
    writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), JSON.stringify({ ...contract, artifacts: [...contract.artifacts, 'tests/check.cjs'], tests: [{ ...contract.tests[1], driver: { runtime: 'node', path: 'tests/check.cjs', args: [], timeoutMs: 10000 } }] }))
    const first = captureEngineeringEvidence(root).evidence
    expect(first).not.toBeNull()
    writeFileSync(join(root, '08_APP/tests/check.cjs'), '// 第二版驱动')
    expect(captureEngineeringEvidence(root).evidence?.digest).not.toBe(first?.digest)
  })
})

test('Given 契约绑定浏览器场景 When 场景变化 Then 运行证据变化而coding不要求尚未产出的场景', () => {
  const root = fixture()
  const value = { ...contract, tests: [{ ...contract.tests[1], adapter: 'browser-file', scenarioFiles: ['features/us-01.steps.json'] }] }
  writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), JSON.stringify(value))
  expect(captureEngineeringEvidence(root).evidence).toBeNull()
  expect(captureEngineeringEvidence(root, { includeScenarios: false }).evidence).not.toBeNull()
  mkdirSync(join(root, '06_TESTS/features'), { recursive: true })
  writeFileSync(join(root, '06_TESTS/features/us-01.steps.json'), '{"scenario":"first"}')
  const first = captureEngineeringEvidence(root).evidence
  expect(first?.scenarios?.[0]?.path).toBe('06_TESTS/features/us-01.steps.json')
  writeFileSync(join(root, '06_TESTS/features/us-01.steps.json'), '{"scenario":"second"}')
  expect(captureEngineeringEvidence(root).evidence?.digest).not.toBe(first?.digest)
})

test('Given 浏览器场景声明 When 解析 Then 路径规范且不能在多个测试重复归属', () => {
  const row = { ...contract.tests[1], adapter: 'browser-file', scenarioFiles: ['features/us-01.steps.json'] }
  expect(parseEngineeringContract(JSON.stringify({ ...contract, tests: [row] })).problems).toEqual([])
  for (const scenarioFiles of [[], ['features/us-01.feature'], ['features/us-01.steps.json', 'features/us-01.steps.json']]) {
    expect(parseEngineeringContract(JSON.stringify({ ...contract, tests: [{ ...row, scenarioFiles }] })).contract).toBeNull()
  }
  expect(parseEngineeringContract(JSON.stringify({ ...contract, tests: [row, { ...row, id: 'other' }] })).contract).toBeNull()
})

describe('Given browser-url服务测试计划，When 解析契约，Then 服务声明固定且被指纹绑定', () => {
  const service = { runtime: 'node', path: 'server.cjs', args: ['--port-flag'], port: 18742, readyPath: '/healthz', readyTimeoutMs: 5000 }
  const urlRow = { id: 'served-ui', layer: 'acceptance', adapter: 'browser-url', target: 'bin/dictation', command: '经宿主服务访问入口', covers: ['US-01'], requiresReal: false, scenarioFiles: ['features/us-01.steps.json'], service }
  const urlContract = { ...contract, artifacts: [...contract.artifacts, 'server.cjs'], tests: [urlRow] }

  test('Then 完整服务计划正常解析', () => {
    const parsed = parseEngineeringContract(JSON.stringify(urlContract))
    expect(parsed.problems).toEqual([])
    expect(parsed.contract?.tests[0]?.service?.port).toBe(18742)
  })
  test('Then browser-url必须同时声明服务计划与浏览器场景', () => {
    expect(parseEngineeringContract(JSON.stringify({ ...urlContract, tests: [{ ...urlRow, service: undefined }] })).contract).toBeNull()
    expect(parseEngineeringContract(JSON.stringify({ ...urlContract, tests: [{ ...urlRow, scenarioFiles: undefined }] })).contract).toBeNull()
  })
  test('Then 服务计划只属于browser-url且服务文件必须列入产物', () => {
    const fileRow = { ...contract.tests[1], adapter: 'browser-file', scenarioFiles: ['features/us-01.steps.json'] }
    expect(parseEngineeringContract(JSON.stringify({ ...contract, tests: [{ ...fileRow, service }] })).contract).toBeNull()
    expect(parseEngineeringContract(JSON.stringify({ ...urlContract, artifacts: contract.artifacts })).contract).toBeNull()
  })
  test('Then 端口、就绪路径与超时越界拒绝', () => {
    for (const changed of [
      { ...service, port: 80 }, { ...service, port: 70000 }, { ...service, port: '18742' },
      { ...service, readyPath: 'healthz' }, { ...service, readyPath: '/x?y=1' },
      { ...service, readyTimeoutMs: 10 }, { ...service, readyTimeoutMs: 60001 },
      { ...service, args: '--flag' }, { ...service, runtime: 'deno' },
    ]) {
      expect(parseEngineeringContract(JSON.stringify({ ...urlContract, tests: [{ ...urlRow, service: changed }] })).contract).toBeNull()
    }
  })
  test('Then 服务文件更新使批准绑定失效', () => {
    const root = fixture()
    mkdirSync(join(root, '08_APP'), { recursive: true })
    writeFileSync(join(root, '08_APP/server.cjs'), '// 第一版服务')
    mkdirSync(join(root, '06_TESTS/features'), { recursive: true })
    writeFileSync(join(root, '06_TESTS/features/us-01.steps.json'), '{"scenario":"v1"}')
    writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), JSON.stringify(urlContract))
    const first = captureEngineeringEvidence(root).evidence
    expect(first).not.toBeNull()
    writeFileSync(join(root, '08_APP/server.cjs'), '// 第二版服务')
    expect(captureEngineeringEvidence(root).evidence?.digest).not.toBe(first?.digest)
  })
})

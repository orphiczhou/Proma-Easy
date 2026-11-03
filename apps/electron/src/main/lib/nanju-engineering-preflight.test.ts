import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareEngineeringBrowserRun } from './nanju-engineering-preflight'

let dir = ''
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = '' })
function fixture(): string {
  dir = mkdtempSync(join(tmpdir(), 'nanju-engineering-preflight-'))
  for (const sub of ['01_PRD', '03_ARCHITECTURE', '08_APP']) mkdirSync(join(dir, sub))
  writeFileSync(join(dir, '01_PRD/prd.md'), '# PRD\nUS-01 添加笔记\nUS-02 删除笔记')
  writeFileSync(join(dir, '08_APP/main.html'), '<html><body>fixture</body></html>')
  return dir
}
function contract(covers: string[], adapter = 'browser-file'): string {
  return JSON.stringify({ schemaVersion: 1, target: { kind: 'web', platform: 'Browser', entry: 'main.html' }, artifacts: ['main.html'], build: '静态网页无需构建', run: '打开main.html', tests: [{ id: 'ui', layer: 'acceptance', adapter, target: 'main.html', command: '宿主GWT', covers, requiresReal: false }] })
}
describe('Given 真实PRD，When 预检工程验收设计，Then 声明必须覆盖本版用户故事', () => {
  test('Then 合法静态Web契约选择实际入口', () => {
    const root = fixture()
    writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), contract(['US-01', 'US-02']))
    expect(prepareEngineeringBrowserRun(root).mode).toBe('engineering-browser')
    expect(prepareEngineeringBrowserRun(root).entry).toBe('08_APP/main.html')
  })
  test('Then 缺故事或引用其他版本故事时明确补全测试设计', () => {
    const root = fixture()
    for (const covers of [['US-01'], ['US-01', 'US-02', 'US-03']]) {
      writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), contract(covers))
      expect(prepareEngineeringBrowserRun(root).mode).toBe('blocked')
      expect(prepareEngineeringBrowserRun(root).reason).toContain('用户故事')
    }
  })
  test('Then 未接入的服务测试不可静默变为文件浏览器测试', () => {
    const root = fixture()
    writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), contract(['US-01', 'US-02'], 'browser-url'))
    expect(prepareEngineeringBrowserRun(root).mode).toBe('blocked')
    expect(prepareEngineeringBrowserRun(root).reason).toContain('browser-url')
  })
})


describe('Given 契约包含辅助测试，When 仅浏览器验收驱动可用，Then 不忽略辅助测试', () => {
  test('Then 明确指出尚未执行的辅助测试', () => {
    const root = fixture()
    const value = JSON.parse(contract(['US-01', 'US-02']))
    value.tests.push({ ...value.tests[0], id: 'unit-check', layer: 'unit', covers: [] })
    writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), JSON.stringify(value))
    expect(prepareEngineeringBrowserRun(root).mode).toBe('blocked')
    expect(prepareEngineeringBrowserRun(root).reason).toContain('辅助测试')
  })
})

describe('Given browser-url服务契约已补齐服务计划与场景，When 预检，Then 走工程汇总单次批准而非免批准直载', () => {
  test('Then 预检引导到逐项批准路径且不静默直载静态文件', () => {
    const root = fixture()
    mkdirSync(join(root, '06_TESTS/features'), { recursive: true })
    writeFileSync(join(root, '08_APP/server.cjs'), '// 服务fixture')
    writeFileSync(join(root, '06_TESTS/features/us-01.steps.json'), '{"scenario":"fixture"}')
    writeFileSync(join(root, '03_ARCHITECTURE/engineering.json'), JSON.stringify({
      schemaVersion: 1, target: { kind: 'web', platform: 'Browser', entry: 'main.html' }, artifacts: ['main.html', 'server.cjs'], build: '无需构建', run: '宿主启动服务',
      tests: [{ id: 'served', layer: 'acceptance', adapter: 'browser-url', target: 'main.html', command: '经服务入口验证', covers: ['US-01', 'US-02'], requiresReal: false, scenarioFiles: ['features/us-01.steps.json'], service: { runtime: 'node', path: 'server.cjs', args: [], port: 18742, readyPath: '/', readyTimeoutMs: 500 } }],
    }))
    const preflight = prepareEngineeringBrowserRun(root)
    expect(preflight.mode).toBe('blocked')
    expect(preflight.reason).toContain('工程测试汇总')
  })
})

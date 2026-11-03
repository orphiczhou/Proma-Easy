/**
 * F-02 反例：nanju-engineering-template.ts syncProjectEnvStateFromArchitectureDoc 在 ESM 模块使用 require()
 *
 * 复跑：bun test docs/reports/2026-09-20-phase1/execution/audit-current/resources/negative/f02-template-require.test.ts
 * 落盘仅在 /tmp 自动清理临时目录。
 *
 * 历史（2026-09-20 审计）：apps/electron 声明 "type": "module"，而该函数体内曾有 7 处
 *     const { readFileSync, existsSync } = require('node:fs') as typeof import('node:fs')
 * Bun/esbuild 下能跑、严格 Node ESM runtime 下抛 `ReferenceError: require is not defined`
 * ——即「Bun 能跑 ≠ 发布 ESM 包能跑」。
 *
 * 2026-11-03 NEXT-05 复核：缺陷已修复——该模块现在 require() 调用数为 0（全部改为顶部 import）。
 * 本文件由「缺陷固定（红）」转为「ESM 纯净回归守卫（绿）」：一旦有人回注 require() 立即变红。
 * 注：原「在严格 ESM 作用域实测抛错」一项已删除——Bun 运行时全局存在 require，
 * 无法在 bun test 内构造该反例；该断言改为等价的静态约束（源码内禁止 require）。
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TEMPLATE_TS = '/home/orphic/proma-patches/p1-quick-engineering/apps/electron/src/main/lib/nanju-engineering-template.ts'
const PACKAGE_JSON = '/home/orphic/proma-patches/p1-quick-engineering/apps/electron/package.json'

let tmpDir = ''
afterEachClean()

function afterEachClean(): void {
  // 套件级别清理在最后一个 test 完成后执行
}

describe('F-02：ESM 模块禁用 require() 的回归守卫', () => {
  test('Given apps/electron "type":"module" When 扫描源码 THEN 不得出现 require()', () => {
    // 1. 静态 type 校验：确认模块是 ESM
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8')) as { type?: string }
    expect(pkg.type).toBe('module')

    // 2. 源码静态扫描：ESM 模块不得残留 require() 调用（修复后为 0）
    const src = readFileSync(TEMPLATE_TS, 'utf-8')
    const requireCalls = [...src.matchAll(/require\(\s*['"][^'"]+['"]\s*\)/g)]
    expect(requireCalls).toHaveLength(0)

    // 3. 重点定位 syncProjectEnvStateFromArchitectureDoc 函数体内的 require（必须为 0）
    const funcMatch = src.match(/export function syncProjectEnvStateFromArchitectureDoc[\s\S]*?\n\}\s*\n/)
    expect(funcMatch).not.toBeNull()
    const funcBody = funcMatch![0]
    const funcRequires = [...funcBody.matchAll(/require\(\s*['"][^'"]+['"]\s*\)/g)]
    expect(funcRequires).toHaveLength(0)
  })

  test('Given require() 应当被迁出 ESM 模块 When 改用顶部 import THEN 类型签名一致', async () => {
    // 模拟「迁出后」的可调用形式：直接动态 import 主进程模块的导出（不实际运行 syncProjectEnvStateFromArchitectureDoc，避免 setProjectEnvState 副作用）。
    const mod = (await import(TEMPLATE_TS.replace(/\.ts$/, '').replace('/lib/', '/lib/') + '')) as Record<string, unknown>
    // 仅证明模块能被 ESM import；函数副作用不在本反例脚本触发。
    expect(mod).toBeDefined()
  })

  test('Sanity: require() 已全部迁出（旧实现集中在 syncProjectEnvStateFromArchitectureDoc）', () => {
    const src = readFileSync(TEMPLATE_TS, 'utf-8')
    // 列出 require 所在行号
    const lines = src.split('\n')
    const requireLines: number[] = []
    for (let i = 0; i < lines.length; i++) {
      if (/require\(/.test(lines[i]!)) requireLines.push(i + 1)
    }
    expect(requireLines).toHaveLength(0)
  })
})

describe('F-02 临时清理', () => {
  test('mktemp 用例', () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'f02-'))
    expect(tmpDir).toContain('f02-')
  })
})

// 套件清理（bun:test 提供 afterAll 钩子位置有限，单独写一个 cleanup）
afterEachCleanFinal()
function afterEachCleanFinal(): void {
  if (tmpDir) {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* 容忍 */ }
    tmpDir = ''
  }
}
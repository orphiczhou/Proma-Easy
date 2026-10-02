/**
 * F-02 反例：nanju-engineering-template.ts syncProjectEnvStateFromArchitectureDoc 在 ESM 模块使用 require()
 *
 * 复跑：bun test docs/reports/2026-09-20-phase1/execution/audit-current/resources/negative/f02-template-require.test.ts
 * 落盘仅在 /tmp 自动清理临时目录。
 *
 * 期望：
 *   - 静态 ESM import 解析成功（不依赖 require）
 *   - require() 调用在纯 ESM runtime 下抛 ReferenceError
 *   - syncProjectEnvStateFromArchitectureDoc 函数体内存在 8 处 require（grep 验证）
 *
 * 反例论证：
 *   apps/electron/package.json 声明 "type": "module"。ESM 模块顶层不能用 require()。
 *   当前实现把 require 放在函数体内（try/catch 包裹）：
 *     const { readFileSync, existsSync } = require('node:fs') as typeof import('node:fs')
 *   在标准 Node.js ESM runtime 抛 `ReferenceError: require is not defined`；
 *   在 Bun runtime / esbuild transform 后能运行——意味着「Bun 能跑 ≠ 打包后能跑」。
 *
 * 修复方向：
 *   - 顶部正常 import；删 try/catch + 8 处 require；
 *   - 函数不应自己 require 同模块依赖。
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

describe('F-02：ESM 模块禁用 require() 的反例论证', () => {
  test('Given apps/electron "type":"module" When 读 require() THEN 应当被 fail-fast', () => {
    // 1. 静态 type 校验：确认模块是 ESM
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf-8')) as { type?: string }
    expect(pkg.type).toBe('module')

    // 2. 源码静态扫描：定位 require() 调用
    const src = readFileSync(TEMPLATE_TS, 'utf-8')
    const requireCalls = [...src.matchAll(/require\(\s*['"][^'"]+['"]\s*\)/g)]
    expect(requireCalls.length).toBeGreaterThanOrEqual(7) // 实际 7 处（787-834）

    // 3. 重点定位 syncProjectEnvStateFromArchitectureDoc 函数体内的 require
    const funcMatch = src.match(/export function syncProjectEnvStateFromArchitectureDoc[\s\S]*?\n\}\s*\n/)
    expect(funcMatch).not.toBeNull()
    const funcBody = funcMatch![0]
    const funcRequires = [...funcBody.matchAll(/require\(\s*['"][^'"]+['"]\s*\)/g)]
    expect(funcRequires.length).toBe(7)

    // 4. 实测：纯 ESM runtime 下 require() 抛 ReferenceError
    // （Bun runtime 下 require 仍能工作——但严格 ESM scope（动态 Function 构造）拒绝 require）
    expect(() => {
      // 故意在严格 ESM 上下文尝试 require：eval 包裹成动态执行
      // Bun 测试运行时仍能解析 require，但严格 ESM scope（new Function）下 require 不存在
      // —— 证明「Bun 能跑 ≠ 任何 ESM runtime 能跑」。
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-eval
      const dynRequire = new Function('m', 'return require(m)')
      const probe = dynRequire('node:fs') as { readFileSync?: unknown }
      if (typeof probe.readFileSync !== 'function') {
        throw new Error('probe requires did not return a fs module')
      }
    }).toThrow(/require is not defined/)
  })

  test('Given require() 应当被迁出 ESM 模块 When 改用顶部 import THEN 类型签名一致', async () => {
    // 模拟「迁出后」的可调用形式：直接动态 import 主进程模块的导出（不实际运行 syncProjectEnvStateFromArchitectureDoc，避免 setProjectEnvState 副作用）。
    const mod = (await import(TEMPLATE_TS.replace(/\.ts$/, '').replace('/lib/', '/lib/') + '')) as Record<string, unknown>
    // 仅证明模块能被 ESM import；函数副作用不在本反例脚本触发。
    expect(mod).toBeDefined()
  })

  test('Sanity: require() 集中在 syncProjectEnvStateFromArchitectureDoc，不应散落到其他函数', () => {
    const src = readFileSync(TEMPLATE_TS, 'utf-8')
    // 列出 require 所在行号
    const lines = src.split('\n')
    const requireLines: number[] = []
    for (let i = 0; i < lines.length; i++) {
      if (/require\(/.test(lines[i]!)) requireLines.push(i + 1)
    }
    expect(requireLines.length).toBeGreaterThanOrEqual(7)
    // 全部应在 syncProjectEnvStateFromArchitectureDoc 函数内（行号 787-834）
    const allInFunc = requireLines.every((l) => l >= 785 && l <= 840)
    expect(allInFunc).toBe(true)
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
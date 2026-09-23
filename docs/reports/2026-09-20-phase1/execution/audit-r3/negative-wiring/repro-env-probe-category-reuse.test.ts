/**
 * R3 审计反例脚本（只读验证，不动产品代码）：
 * 反例：同一项目先以 universal（或初判品类）探测落盘 env_probe.json，
 *       随后品类判定变为 desktop-app，再次 runEnvProbe 时是否复用旧结果。
 *
 * 夹具模式与 nanju-env-probe.test.ts 同构：mock.module(config-paths) 指向 tmpdir，
 * 不触碰 ~/.proma 真实工作区。脚本体在 audit-r3/negative-wiring/，需以
 * bun --cwd apps/electron 或 bun test 从仓库内解析依赖（@proma/shared）。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, afterAll, mock } from 'bun:test'

const REPO_ROOT = '/home/orphic/proma-patches/p1-quick-engineering'
const LIB = join(REPO_ROOT, 'apps/electron/src/main/lib')

let fixtureRoot = ''
const actualConfigPaths = await import(join(LIB, 'config-paths.ts'))
// mock 与 nanju-env-probe.ts 内部 import './config-paths' 解析到同一模块文件
mock(String(join(LIB, 'config-paths.ts')), () => ({
  ...actualConfigPaths,
  getWorkspaceFilesDir: () => fixtureRoot,
  getAgentWorkspacePath: () => fixtureRoot,
}))

const { runEnvProbe, getEnvProbePath } = await import(join(LIB, 'nanju-env-probe.ts'))

function makeProject(script?: string) {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'r3-audit-cat-reuse-'))
  const tplDir = join(fixtureRoot, 'project-r3cat', '00_ENGINEERING_TEMPLATE')
  mkdirSync(tplDir, { recursive: true })
  if (script) writeFileSync(join(tplDir, 'check_env.sh'), script, { mode: 0o755 })
}

const SCRIPT = `#!/usr/bin/env bash
echo '{"component":"node","status":"ok","version":"v22","detail":"universal-base"}'
[ -n "\${1:-}" ] && echo '{"component":"webkit2gtk-4.1","status":"ok","version":"4.1.0","detail":"desktop-only"}'
`

test('R3 反例：universal 先探测 → desktop-app 再探测，品类变更是否复用旧结果', () => {
  makeProject(SCRIPT)

  // 第一次：无品类（universal）
  const first = runEnvProbe('test-ws', 'r3cat', { timeoutMs: 30_000 })
  expect(first.ok).toBe(true)
  const p1 = getEnvProbePath('test-ws', 'r3cat')
  const w1 = JSON.parse(readFileSync(p1, 'utf-8'))
  expect(w1.category).toBe('universal')
  expect(w1.components.some((c) => c.component === 'webkit2gtk-4.1')).toBe(false)

  // 第二次：品类变为 desktop-app（模拟初判/终判变化后的 architecture 重入）
  const second = runEnvProbe('test-ws', 'r3cat', { category: 'desktop-app', timeoutMs: 30_000 })
  const w2 = JSON.parse(readFileSync(p1, 'utf-8'))
  const hasDesktop = w2.components.some((c) => c.component === 'webkit2gtk-4.1')
  console.log('[R3] second.ok=', second.ok, 'written.category=', w2.category, 'desktop-item-present=', hasDesktop)
  console.log('[R3] second.lines=', JSON.stringify(second.lines))
  // 若复用旧结果（fresh 命中且不比对 category），此断言失败 = 审计反例成立
  expect(hasDesktop).toBe(true)
})

afterAll(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
})

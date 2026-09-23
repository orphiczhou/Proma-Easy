/**
 * R3 审计反例（临时脚本，跑完即移回 audit-r3/negative-wiring/；不属产品代码）：
 * 反例：同一项目先 universal 探测落盘 env_probe.json，品类变 desktop-app 后再次 runEnvProbe，
 * 观察是否复用旧结果（fresh 命中且不比对 category → 品类专用组件缺失）。
 */
import { test, expect, mock, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../..')
let fixtureRoot = ''
const actualConfigPaths = await import('./config-paths')
mock.module('./config-paths', () => ({
  ...actualConfigPaths,
  getWorkspaceFilesDir: () => fixtureRoot,
  getAgentWorkspacePath: () => fixtureRoot,
}))
const { runEnvProbe, getEnvProbePath } = await import('./nanju-env-probe')

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
  const first = runEnvProbe('test-ws', 'r3cat', { timeoutMs: 30_000 })
  expect(first.ok).toBe(true)
  const p1 = getEnvProbePath('test-ws', 'r3cat')
  const w1 = JSON.parse(readFileSync(p1, 'utf-8'))
  expect(w1.category).toBe('universal')
  expect(w1.components.some((c: any) => c.component === 'webkit2gtk-4.1')).toBe(false)

  const second = runEnvProbe('test-ws', 'r3cat', { category: 'desktop-app', timeoutMs: 30_000 })
  const w2 = JSON.parse(readFileSync(p1, 'utf-8'))
  const hasDesktop = w2.components.some((c: any) => c.component === 'webkit2gtk-4.1')
  console.log('[R3] second.ok=', second.ok, 'written.category=', w2.category, 'desktop-item-present=', hasDesktop)
  console.log('[R3] second.lines=', JSON.stringify(second.lines))
  expect(hasDesktop).toBe(true)
})

afterAll(() => { if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true }) })

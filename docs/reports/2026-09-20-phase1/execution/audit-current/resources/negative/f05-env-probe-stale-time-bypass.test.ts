/**
 * F-05 反例：isEnvProbeFresh 在 nowMs < probedAtMs 时旁路 stale-age 检查
 *
 * 复跑：bun test docs/reports/2026-09-20-phase1/execution/audit-current/resources/negative/f05-env-probe-stale-time-bypass.test.ts
 * 落盘仅在 /tmp 自动清理临时目录。
 *
 * 历史（2026-09-20 审计）：实现写作
 *     const effectiveNowMs = opts?.nowMs ?? Math.max(nowMs, probedAtMs)
 * 生产路径下 Math.max 兼底会把「系统时钟倒退」（NTP 步退 / 容器时区漂移）变成 age=0，
 * 从而永远走 within-age fresh 路径（FAIL-OPEN）。
 *
 * 2026-11-03 NEXT-05 复核：缺陷已修复——实现现在为
 *     const nowMs = opts?.nowMs ?? Date.now()
 *     const clockSkewed = nowMs < probedAtMs
 *     const effectiveNowMs = nowMs
 * 即 Math.max 兜底已删除，时钟倒退按 stale-age 判不新鲜（并保留负 age 供诊断）。
 * 本文件因此从「缺陷固定（红）」转为「修复回归守卫（绿）」。
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'

const ENV_PROBE_TS = '/home/orphic/proma-patches/p1-quick-engineering/apps/electron/src/main/lib/nanju-env-probe.ts'

describe('F-05：freshness 时钟倒退不再 fail-open', () => {
  test('静态证明：effectiveNowMs 直接取 nowMs，不再用 Math.max 兜底', () => {
    const src = readFileSync(ENV_PROBE_TS, 'utf-8')
    expect(src).toContain('effectiveNowMs')
    // 回归守卫：历史缺陷写法一旦回注即变红
    expect(src).not.toMatch(/Math\.max\(nowMs,\s*probedAtMs\)/)
    expect(src).toMatch(/const effectiveNowMs = nowMs/)
  })

  test('时钟倒退（注入 nowMs=probedAtMs-90d）→ fresh=false reason=stale-age', async () => {
    // 真实 import 源码模块
    const envProbe = (await import('/home/orphic/proma-patches/p1-quick-engineering/apps/electron/src/main/lib/nanju-env-probe.ts')) as {
      isEnvProbeFresh: (result: { probedAt: string; components: unknown[] }, opts?: unknown) => {
        fresh: boolean
        reason: string
        ageMs: number
        templateDeltaMs: number | null
      }
      ENV_PROBE_DEFAULT_MAX_AGE_MS: number
    }

    // 模拟探测结果：probedAt 是「今天」
    const todayIso = new Date().toISOString()
    const todayMs = Date.parse(todayIso)

    // 模拟系统时钟倒退 90 天（nowMs < probedAtMs）
    const nowMs90DaysAgo = todayMs - 90 * 86_400_000

    const freshness = envProbe.isEnvProbeFresh(
      { probedAt: todayIso, components: [] },
      { nowMs: nowMs90DaysAgo },
    )

    // 修复后语义：时钟不可信时不得把证据当新鲜（fail-closed），并给出可诊断原因
    expect(freshness.fresh).toBe(false)
    expect(freshness.reason).toBe('stale-age')
  })

  test('正确语义对照：注入 nowMs=probedAtMs+90d 应返回 stale-age=false', async () => {
    const envProbe = (await import('/home/orphic/proma-patches/p1-quick-engineering/apps/electron/src/main/lib/nanju-env-probe.ts')) as {
      isEnvProbeFresh: (result: { probedAt: string; components: unknown[] }, opts?: unknown) => {
        fresh: boolean
        reason: string
        ageMs: number
      }
    }

    // 探测 90 天前
    const oldIso = new Date(Date.now() - 90 * 86_400_000).toISOString()
    // 「现在」是真实当前时间
    const nowMs = Date.now()

    const freshness = envProbe.isEnvProbeFresh(
      { probedAt: oldIso, components: [] },
      { nowMs },
    )

    // 正确语义：90 天前探测 → 现在看 → 应 stale
    expect(freshness.fresh).toBe(false)
    expect(freshness.reason).toBe('stale-age')
  })

  test('正常 fresh：nowMs 接近 probedAtMs 应 fresh=true reason=within-age', async () => {
    const envProbe = (await import('/home/orphic/proma-patches/p1-quick-engineering/apps/electron/src/main/lib/nanju-env-probe.ts')) as {
      isEnvProbeFresh: (result: { probedAt: string; components: unknown[] }, opts?: unknown) => {
        fresh: boolean
        reason: string
      }
    }

    const nowIso = new Date().toISOString()
    const nowMs = Date.parse(nowIso)
    const freshness = envProbe.isEnvProbeFresh(
      { probedAt: nowIso, components: [] },
      { nowMs },
    )

    expect(freshness.fresh).toBe(true)
    expect(freshness.reason).toBe('within-age')
  })
})
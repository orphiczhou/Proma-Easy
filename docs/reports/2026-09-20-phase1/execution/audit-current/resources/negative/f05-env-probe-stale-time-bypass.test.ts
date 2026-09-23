/**
 * F-05 反例：isEnvProbeFresh 在 nowMs < probedAtMs 时旁路 stale-age 检查
 *
 * 复跑：bun test docs/reports/2026-09-20-phase1/execution/audit-current/resources/negative/f05-env-probe-stale-time-bypass.test.ts
 * 落盘仅在 /tmp 自动清理临时目录。
 *
 * 期望反例触发：
 *   - 当前实现：nowMs=probedAtMs - 90d → 返回 fresh=true（FAIL-OPEN）
 *   - 正确语义：fresh=false reason=stale-age
 *
 * 反例论证：
 *   isEnvProbeFresh 函数体内：
 *     const nowMs = opts?.nowMs ?? Date.now()
 *     const effectiveNowMs = opts?.nowMs ?? Math.max(nowMs, probedAtMs)
 *   生产路径 opts.nowMs 为 undefined，effectiveNowMs = Math.max(nowMs, probedAtMs)。
 *   当系统时钟异常（NTP 步退、容器时区漂移）使 Date.now() < Date.parse(result.probedAt)
 *   时，effectiveNowMs = probedAtMs，age = 0 → 永远走 within-age fresh 路径。
 *
 *   测试注入 nowMs=probedAtMs - 90*86400_000（90 天前）模拟该时钟异常，断言应返回
 *   stale-age（修复后）/within-age（当前 fail-open 实现）。
 *
 * 修复方向：
 *   - 删除 Math.max 兜底，让生产 effectiveNowMs = nowMs；测试由 opts.nowMs 注入 nowMs。
 *   - 或 effectiveNowMs = opts?.nowMs === undefined ? nowMs : Math.max(nowMs, probedAtMs)
 *     （仅测试时用 max）。
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'

const ENV_PROBE_TS = '/home/orphic/proma-patches/p1-quick-engineering/apps/electron/src/main/lib/nanju-env-probe.ts'

describe('F-05：freshness fail-open（系统时钟倒退旁路 stale-age）', () => {
  test('静态证明：effectiveNowMs 使用 Math.max 兜底', () => {
    const src = readFileSync(ENV_PROBE_TS, 'utf-8')
    expect(src).toContain('effectiveNowMs')
    expect(src).toMatch(/Math\.max\(nowMs,\s*probedAtMs\)/)
  })

  test('当前实现：注入 nowMs=probedAtMs-90d 时返回 fresh=true（FAIL-OPEN，应修复为 false）', async () => {
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

    // 反例断言：fresh=true 是 fail-open 表现，应该被修复为 false
    // 当前实现：effectiveNowMs = max(nowMs90DaysAgo, todayMs) = todayMs → age = 0 → fresh=true
    console.log(`F-05 freshness: ${JSON.stringify(freshness)}`)
    if (freshness.fresh) {
      console.log('F-05 反例触发：fail-open 实现确认（系统时钟倒退 → fresh=true）')
    } else {
      console.log(`F-05 反例未触发：已修复（reason=${freshness.reason}）`)
    }
    expect(freshness.fresh).toBe(true) // 当前 fail-open 的预期；修复后此处应改 false
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
/**
 * W-I B-e（I-P6）：GWT 逐场景通俗行**累积器**（渲染端纯函数，无副作用）。
 *
 * 为什么需要它：`nanju:gwt-progress` 是**事件流**（start / scenario-start / scenario-end / done），
 * 每条事件只带当前场景，没有「报告对象」下发通道（无 report IPC）。卡片若只显示汇总行，
 * 用户看不到「哪几个场景过了/没过」。本模块把事件流累积成 `ScenarioResultRow[]`，
 * 再交给 F 的 `buildScenarioRows` 生成叙述——**不含任何技术 steps 伪造**。
 *
 * 可信来源边界：
 * - plainText **只取**事件里的 `scenario` 字段（源自 GWT 场景文件的 scenario 描述）；
 * - `scenario` 去掉前缀 `US-xx` 后为空 → 传空串给 builder，由 builder 显示「`US-xx`（暂无描述）」，
 *   绝不回退到 feature/步骤文本；
 * - 去重键 = usId + plainText（同场景重跑保留**最新**状态，不叠行）。
 */

import type { ScenarioResultRow } from './quick-ux-model'

/** 事件流中可累积的场景种子（builder 输入的子集） */
export interface ScenarioRowSeed {
  usId: string
  plainText: string
  verdict: string
}

/** 与 nanju-gwt-runner.scenarioUserStory 同口径（渲染端不复用主进程模块，正则保持一致） */
export function extractUserStoryId(scenarioText: string): string {
  const m = /\bUS-(\d+)\b/i.exec(String(scenarioText ?? ''))
  return m ? `US-${String(Number(m[1])).padStart(2, '0')}` : 'US-?'
}

/**
 * 从一条进度事件派生场景种子。
 * - 仅 `scenario-end` 携带终态（`scenarioStatus`），其它 phase 返回 null；
 * - 无 `scenario` 文本或状态非法（非 pass/fail/skip）时返回 null（不猜、不兜底成 pass）。
 */
export function scenarioRowSeedFromEvent(event: {
  phase?: string
  scenario?: string
  scenarioStatus?: string
}): ScenarioRowSeed | null {
  if (event?.phase !== 'scenario-end') return null
  const raw = String(event.scenario ?? '').trim()
  if (!raw) return null
  const status = String(event.scenarioStatus ?? '').trim()
  if (status !== 'pass' && status !== 'fail' && status !== 'skip') return null
  const usId = extractUserStoryId(raw)
  // plainText = 场景描述去掉 US-xx 前缀；为空则交给 builder 走「暂无描述」兜底
  const plainText = usId === 'US-?'
    ? raw
    : raw.replace(/\bUS-\d+\b/i, '').replace(/^[\s:：\-—、.]+/, '').trim()
  return { usId, plainText, verdict: status }
}

/** 累积上限（防异常流无限增长；超出丢最早的行） */
export const SCENARIO_ROWS_CAP = 50

/**
 * 追加一行种子（纯函数，返回新数组）。
 * 去重：同 usId + plainText 视为同一场景 → 覆盖为最新 verdict（重跑语义）。
 */
export function appendScenarioRow(seeds: ReadonlyArray<ScenarioRowSeed>, seed: ScenarioRowSeed): ScenarioRowSeed[] {
  const next = seeds.filter((s) => !(s.usId === seed.usId && s.plainText === seed.plainText))
  next.push(seed)
  return next.length > SCENARIO_ROWS_CAP ? next.slice(next.length - SCENARIO_ROWS_CAP) : next
}

/**
 * 展示裁剪：只渲染最近 N 行 + 省略计数（卡片高度有限，全量明细仍在 06_TESTS/report-*.md）。
 * 失败行优先保留（用户最需要看到哪条没过）。
 */
export function pickVisibleScenarioRows(
  rows: ReadonlyArray<ScenarioResultRow>,
  limit = 6,
): { visible: ScenarioResultRow[]; hiddenCount: number } {
  const safeLimit = Math.max(1, Math.floor(limit) || 6)
  if (rows.length <= safeLimit) return { visible: [...rows], hiddenCount: 0 }
  const failed = rows.filter((r) => r.status === 'fail')
  const others = rows.filter((r) => r.status !== 'fail')
  // 失败行先占配额（最多占满 limit），剩余配额给最近的非失败行；
  // 展示顺序仍按原始时间序（不是「失败排前」的重排），避免用户对进度产生错位理解。
  const keepFailed = failed.slice(-safeLimit)
  const remaining = safeLimit - keepFailed.length
  const keepOthers = remaining > 0 ? others.slice(-remaining) : []
  const keep = new Set([...keepFailed, ...keepOthers])
  const visible = rows.filter((r) => keep.has(r))
  return { visible, hiddenCount: rows.length - visible.length }
}

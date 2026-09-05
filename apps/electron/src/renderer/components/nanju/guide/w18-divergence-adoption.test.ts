/**
 * W18 Wave3 · 渲染端 divergence 采纳纯函数测试（D5a/D5b + 独立通道边界）
 *
 * 覆盖审查 MUST-4/MUST-5 的渲染端修复面：
 * - D5a 冷启动 seq=0 快照首拉无条件采纳（原 `seq > 0` 门槛会把无事件项目的快照丢弃）；
 * - D5b divergences 走独立通道：seq 不变（进度事件序号不随磁盘事实变化递增）时
 *   仅更新偏差事实，不触碰 subStage/推进状态（纯展示数据无回退面）；
 * - 事实集未变（指纹相等）不重复更新（防 10s 轮询抖动重渲染）；
 * - 载荷无 divergences 字段 → 维持现状（旧主进程向前兼容）。
 *
 * 纯函数导入自 useNanjuGuideData（hook 文件的模块级零副作用面，bun test 可直接 import）。
 */
import { describe, expect, test } from 'bun:test'
import {
  buildDivergenceWarningText,
  resolveDivergenceUpdate,
  type DivergenceFacts,
} from './useNanjuGuideData'

const dv = (stage: string, artifact: string): { stage: string; artifact: string } => ({ stage, artifact })

// ===== D5a：冷启动首拉无条件采纳（MUST-4 修复） =====

describe('resolveDivergenceUpdate · D5a 冷启动 seq=0 首拉采纳', () => {
  test('adoptedAny=false + seq=0 快照含 divergences → 进度整体采纳且事实通道更新', () => {
    const result = resolveDivergenceUpdate({
      adoptedAny: false,
      currentSeq: 0,
      currentFacts: null,
      incoming: { seq: 0, divergences: [dv('coding', '08_APP/index.html')], divergenceFingerprint: 'f1' },
    })
    // 修复前：`seq > guideSeqRef.current`（0 > 0 为 false）→ 快照被丢，冷启动挂点失效
    expect(result.adoptProgress).toBe(true)
    expect(result.divergenceFacts).toEqual({
      divergences: [dv('coding', '08_APP/index.html')],
      fingerprint: 'f1',
    })
  })

  test('adoptedAny=false + seq=0 快照无 divergences 字段 → 进度仍采纳，事实通道不动', () => {
    const result = resolveDivergenceUpdate({
      adoptedAny: false,
      currentSeq: 0,
      currentFacts: null,
      incoming: { seq: 0 },
    })
    expect(result.adoptProgress).toBe(true)
    expect(result.divergenceFacts).toBeNull()
  })

  test('首拉采纳后进入严格 seq 比较：seq=0 再达不重复采纳进度', () => {
    const first = resolveDivergenceUpdate({
      adoptedAny: false, currentSeq: 0, currentFacts: null,
      incoming: { seq: 0, divergences: [], divergenceFingerprint: 'f-empty' },
    })
    expect(first.adoptProgress).toBe(true)
    const second = resolveDivergenceUpdate({
      adoptedAny: true, currentSeq: 0, currentFacts: first.divergenceFacts,
      incoming: { seq: 0, subStageIgnored: true, divergences: [], divergenceFingerprint: 'f-empty' } as never,
    })
    expect(second.adoptProgress).toBe(false)
  })
})

// ===== D5b：divergences 独立通道（MUST-5 低成本替代） =====

describe('resolveDivergenceUpdate · D5b 独立通道（不参与 seq 门控）', () => {
  const currentFacts: DivergenceFacts = {
    divergences: [dv('coding', '08_APP/index.html')],
    fingerprint: 'f-old',
  }

  test('seq 不变而事实变化 → 进度不采纳，但事实通道更新', () => {
    const result = resolveDivergenceUpdate({
      adoptedAny: true,
      currentSeq: 5,
      currentFacts,
      incoming: {
        seq: 5,
        divergences: [dv('coding', '08_APP/index.html'), dv('testing', '06_TESTS/features/index.feature')],
        divergenceFingerprint: 'f-new',
      },
    })
    expect(result.adoptProgress).toBe(false)
    expect(result.divergenceFacts?.fingerprint).toBe('f-new')
    expect(result.divergenceFacts?.divergences.length).toBe(2)
  })

  test('seq 更高 + 事实变化 → 进度采纳且事实通道更新（同一决策输出两通道）', () => {
    const result = resolveDivergenceUpdate({
      adoptedAny: true,
      currentSeq: 5,
      currentFacts,
      incoming: { seq: 6, divergences: [dv('coding', '08_APP/index.html')], divergenceFingerprint: 'f2' },
    })
    expect(result.adoptProgress).toBe(true)
    expect(result.divergenceFacts).not.toBeNull()
  })

  test('D6 渲染端面：事实清空（文件删除）→ 事实通道更新为空数组（角标可清除）', () => {
    const result = resolveDivergenceUpdate({
      adoptedAny: true,
      currentSeq: 5,
      currentFacts,
      incoming: { seq: 5, divergences: [], divergenceFingerprint: 'f-empty' },
    })
    expect(result.adoptProgress).toBe(false)
    expect(result.divergenceFacts).toEqual({ divergences: [], fingerprint: 'f-empty' })
  })

  test('事实集未变（指纹相等，observedAt 变化）→ 不产生更新（防轮询抖动）', () => {
    const result = resolveDivergenceUpdate({
      adoptedAny: true,
      currentSeq: 5,
      currentFacts: { divergences: [dv('coding', '08_APP/index.html')], fingerprint: 'f-same' },
      incoming: {
        seq: 5,
        divergences: [{ stage: 'coding', artifact: '08_APP/index.html', observedAt: '2026-09-05T09:00:00.000Z' }],
        divergenceFingerprint: 'f-same',
      },
    })
    expect(result.adoptProgress).toBe(false)
    expect(result.divergenceFacts).toBeNull()
  })

  test('载荷无 divergences 字段 → 事实通道维持现状（向前兼容：不误清角标）', () => {
    const result = resolveDivergenceUpdate({
      adoptedAny: true,
      currentSeq: 5,
      currentFacts,
      incoming: { seq: 7 },
    })
    expect(result.adoptProgress).toBe(true)
    expect(result.divergenceFacts).toBeNull()
  })

  test('指纹缺失兜底：按 stage:artifact 集合比较——同集不更新、异集更新', () => {
    const factsNoFp: DivergenceFacts = { divergences: [dv('coding', '08_APP/index.html')], fingerprint: null }
    // 同集（含 observedAt 差异）→ 不更新
    const same = resolveDivergenceUpdate({
      adoptedAny: true, currentSeq: 3, currentFacts: factsNoFp,
      incoming: {
        seq: 3,
        divergences: [{ stage: 'coding', artifact: '08_APP/index.html', observedAt: '2026-09-05T08:00:00.000Z' }],
      },
    })
    expect(same.divergenceFacts).toBeNull()
    // 异集 → 更新
    const diff = resolveDivergenceUpdate({
      adoptedAny: true, currentSeq: 3, currentFacts: factsNoFp,
      incoming: { seq: 3, divergences: [dv('testing', '06_TESTS/features/index.feature')] },
    })
    expect(diff.divergenceFacts?.divergences).toEqual([dv('testing', '06_TESTS/features/index.feature')])
    // 从无指纹到有指纹（主进程升级）→ 保守视为变化，更新一次即对齐
    const upgraded = resolveDivergenceUpdate({
      adoptedAny: true, currentSeq: 3, currentFacts: factsNoFp,
      incoming: { seq: 3, divergences: [dv('coding', '08_APP/index.html')], divergenceFingerprint: 'fp' },
    })
    expect(upgraded.divergenceFacts?.fingerprint).toBe('fp')
  })
})

// ===== 警示条文案（弱断言，SHOULD-6） =====

describe('buildDivergenceWarningText（弱断言文案）', () => {
  test('单偏差：含产物路径 + 阶段中文名 + 「可能存在越阶段施工」（不得输出确定结论）', () => {
    const text = buildDivergenceWarningText([dv('coding', '08_APP/index.html')])
    expect(text).toContain('08_APP/index.html')
    expect(text).toContain('开发')
    expect(text).toContain('可能存在越阶段施工')
    expect(text).not.toContain('已越阶段施工')
  })

  test('多偏差并列列出；空列表返回 null（不渲染角标）', () => {
    const text = buildDivergenceWarningText([
      dv('coding', '08_APP/index.html'),
      dv('testing', '06_TESTS/features/index.feature'),
    ])
    expect(text).toContain('08_APP/index.html')
    expect(text).toContain('06_TESTS/features/index.feature')
    expect(buildDivergenceWarningText([])).toBeNull()
  })

  test('未知阶段 id 降级为 id 原文（不抛错）', () => {
    const text = buildDivergenceWarningText([dv('mystery', '09_X/file.md')])
    expect(text).toContain('09_X/file.md')
    expect(text).toContain('mystery')
  })
})

/**
 * NanjuModelSettings 纯函数逻辑测试
 *
 * 仓库惯例：renderer 组件无渲染测试设施（无 testing-library），逻辑以
 * colocated *.test.ts 纯函数测试覆盖，组件行为依赖部署后 E2E。
 */

import { describe, expect, test } from 'bun:test'
import { ipcErrorOf,
  buildHealthByRow,
  buildShadowedByRow,
  changeHitsUnhealthySlot,
  changesToPatch,
  collectTestEndpoints,
  computeSavePatch,
  endpointToString,
  parseEndpointString,
  parseHealthSlot,
} from './NanjuModelSettings'
import type { Draft, NanjuModelSettingsStateLike } from './NanjuModelSettings'

const PHASES = ['requirements', 'prototype', 'architecture', 'planning', 'coding', 'testing'] as const

function makeState(overrides?: {
  health?: NanjuModelSettingsStateLike['health']
  fallbacks?: Record<string, string[]>
  proxyCandidates?: Array<{ channelId: string; modelId: string }>
}): NanjuModelSettingsStateLike {
  return {
    effective: {
      phases: {
        requirements: { channel: 'deepseek', model: 'deepseek-v4-pro', fallbacks: overrides?.fallbacks?.requirements ?? ['deepseek:deepseek-v4-flash'] },
        prototype: { channel: 'minimax', model: 'MiniMax-M3' },
        architecture: { channel: 'glm-zhipu', model: 'GLM-5.3' },
        planning: { channel: 'deepseek', model: 'deepseek-flash' },
        coding: { channel: 'glm-zhipu', model: 'GLM-5.3', acDefender: { channel: 'minimax', model: 'MiniMax-M3' } },
        testing: { channel: 'deepseek', model: 'deepseek-flash' },
      },
      acPresets: {
        light: { attacker: { channel: 'deepseek', model: 'deepseek-flash' }, defender: { channel: 'glm-zhipu', model: 'glm-5.3-flash' } },
        medium: { attacker: { channel: 'deepseek', model: 'deepseek-v4-pro' }, defender: { channel: 'glm-zhipu', model: 'GLM-5.3' } },
      },
      proxyCandidates: overrides?.proxyCandidates ?? [{ channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' }],
    },
    sources: { builtin: '/builtin.json' },
    health: overrides?.health ?? [],
    diversityWarnings: [],
    channels: [
      { channelId: 'deepseek', name: 'DeepSeek', enabledModelIds: ['deepseek-v4-pro', 'deepseek-flash'] },
      { channelId: 'glm-zhipu', name: '智谱', enabledModelIds: ['GLM-5.3', 'glm-5.3-flash'] },
    ],
    handLayerPresent: false,
  }
}

/** 重建草稿（draftFromState 未导出，用 parse/endpointToString 组装最小路径） */
function draftOf(state: NanjuModelSettingsStateLike): Draft {
  const phases = {} as Draft['phases']
  for (const id of PHASES) {
    const p = state.effective.phases[id]
    phases[id] = {
      main: { channel: p?.channel ?? '', model: p?.model ?? '' },
      fallbacks: (p?.fallbacks ?? []).map((s) => parseEndpointString(s) ?? { channel: '', model: '' }),
      acAttacker: p?.acAttacker ? { ...p.acAttacker } : null,
      acDefender: p?.acDefender ? { ...p.acDefender } : null,
    }
  }
  const presets = {} as Draft['presets']
  for (const tier of ['light', 'medium'] as const) {
    presets[tier] = {
      attacker: { channel: state.effective.acPresets[tier]?.attacker?.channel ?? '', model: state.effective.acPresets[tier]?.attacker?.model ?? '' },
      defender: { channel: state.effective.acPresets[tier]?.defender?.channel ?? '', model: state.effective.acPresets[tier]?.defender?.model ?? '' },
    }
  }
  const proxy = state.effective.proxyCandidates.map((c) => ({ channel: c.channelId, model: c.modelId }))
  return { phases, presets, proxy }
}

describe('parseEndpointString / endpointToString', () => {
  test('按第一个冒号切分', () => {
    expect(parseEndpointString('deepseek:deepseek-v4-flash')).toEqual({ channel: 'deepseek', model: 'deepseek-v4-flash' })
    expect(parseEndpointString('minimax:MiniMax-M3')).toEqual({ channel: 'minimax', model: 'MiniMax-M3' })
  })

  test('非法输入返回 null（空串/无冒号/冒号在两端）', () => {
    expect(parseEndpointString('')).toBeNull()
    expect(parseEndpointString('noseparator')).toBeNull()
    expect(parseEndpointString(':model')).toBeNull()
    expect(parseEndpointString('channel:')).toBeNull()
  })

  test('空槽端点序列化为 null（空槽不落盘）', () => {
    expect(endpointToString({ channel: '', model: 'x' })).toBeNull()
    expect(endpointToString({ channel: 'deepseek', model: '' })).toBeNull()
    expect(endpointToString({ channel: 'deepseek', model: 'm' })).toBe('deepseek:m')
  })
})

describe('parseHealthSlot', () => {
  test('主选槽（含 .main 变体）', () => {
    expect(parseHealthSlot('phases.requirements')).toEqual({ kind: 'phase-main', phase: 'requirements' })
    expect(parseHealthSlot('phases.coding.main')).toEqual({ kind: 'phase-main', phase: 'coding' })
  })

  test('备选槽兼容 .0 与 [0] 两种下标', () => {
    expect(parseHealthSlot('phases.requirements.fallbacks.0')).toEqual({ kind: 'phase-fallback', phase: 'requirements', index: 0 })
    expect(parseHealthSlot('phases.requirements.fallbacks[2]')).toEqual({ kind: 'phase-fallback', phase: 'requirements', index: 2 })
  })

  test('per-phase AC 覆盖槽', () => {
    expect(parseHealthSlot('phases.architecture.acDefender')).toEqual({ kind: 'phase-ac', phase: 'architecture', role: 'acDefender' })
    expect(parseHealthSlot('phases.testing.acAttacker')).toEqual({ kind: 'phase-ac', phase: 'testing', role: 'acAttacker' })
  })

  test('AC 预设槽与代理候选槽', () => {
    expect(parseHealthSlot('acPresets.light.attacker')).toEqual({ kind: 'ac-preset', tier: 'light', role: 'attacker' })
    expect(parseHealthSlot('proxyCandidates.1')).toEqual({ kind: 'proxy', index: 1 })
  })

  test('未知阶段/未知格式返回 null', () => {
    expect(parseHealthSlot('phases.unknown')).toBeNull()
    expect(parseHealthSlot('something.else')).toBeNull()
    expect(parseHealthSlot('')).toBeNull()
  })
})

describe('buildHealthByRow', () => {
  test('slot 可解析时按 slot 归因', () => {
    const state = makeState({
      health: [{ slot: 'phases.requirements', channelId: 'deepseek', modelId: 'deepseek-v4-pro', status: 'ok' }],
    })
    const byRow = buildHealthByRow(state)
    expect(byRow.get('p:requirements')?.status).toBe('ok')
  })

  test('slot 无法解析时退化为端点唯一匹配', () => {
    const state = makeState({
      health: [{ slot: 'odd-format', channelId: 'minimax', modelId: 'MiniMax-M3', status: 'ok' }],
    })
    const byRow = buildHealthByRow(state)
    // minimax:MiniMax-M3 出现在 prototype 主选与 coding acDefender 两行 → 不唯一，不归因
    expect(byRow.size).toBe(0)
  })
})

describe('buildShadowedByRow', () => {
  test('field 可解析时映射到行 key → path', () => {
    const byRow = buildShadowedByRow([
      { field: 'phases.coding.acDefender', requested: { channel: 'x', model: 'y' }, effective: { channel: 'minimax', model: 'MiniMax-M3' }, shadowSource: 'layer1', path: '~/.proma/nanju-model-config.json' },
    ])
    expect(byRow.get('p:coding:ac:acDefender')).toBe('~/.proma/nanju-model-config.json')
  })
})

describe('computeSavePatch', () => {
  test('无改动返回空 patch', () => {
    const state = makeState()
    expect(computeSavePatch(state, draftOf(state) as never)).toEqual({})
  })

  test('主选改动只含该字段', () => {
    const state = makeState()
    const draft = draftOf(state)
    draft.phases.requirements.main = { channel: 'glm-zhipu', model: 'GLM-5.3' }
    const patch = computeSavePatch(state, draft)
    expect(patch.phases?.requirements).toEqual({ channel: 'glm-zhipu', model: 'GLM-5.3' })
  })

  test('备选增删整体替换数组，空槽不落盘', () => {
    const state = makeState()
    const draft = draftOf(state)
    draft.phases.requirements.fallbacks = [
      { channel: 'deepseek', model: 'deepseek-v4-flash' },
      { channel: '', model: '' },
      { channel: 'glm-zhipu', model: 'glm-5.3-flash' },
    ]
    const patch = computeSavePatch(state, draft)
    expect(patch.phases?.requirements?.fallbacks).toEqual(['deepseek:deepseek-v4-flash', 'glm-zhipu:glm-5.3-flash'])
  })

  test('per-phase AC 清空覆盖发送 null', () => {
    const state = makeState()
    const draft = draftOf(state)
    draft.phases.coding.acDefender = null
    const patch = computeSavePatch(state, draft)
    expect(patch.phases?.coding?.acDefender).toBeNull()
  })

  test('代理候选整体替换并过滤空槽', () => {
    const state = makeState()
    const draft = draftOf(state)
    draft.proxy = [
      { channel: 'glm-zhipu', model: 'glm-5.3-flash' },
      { channel: 'deepseek', model: '' },
      { channel: 'deepseek', model: 'deepseek-flash' },
    ]
    const patch = computeSavePatch(state, draft)
    expect(patch.proxyCandidates).toEqual([
      { channelId: 'glm-zhipu', modelId: 'glm-5.3-flash' },
      { channelId: 'deepseek', modelId: 'deepseek-flash' },
    ])
  })
})

describe('changesToPatch', () => {
  test('备选槽位替换以生效值为基数整体替换', () => {
    const state = makeState({ fallbacks: { requirements: ['deepseek:deepseek-v4-flash', 'glm-zhipu:glm-5.3-flash'] } })
    const patch = changesToPatch(
      [{ slot: 'phases.requirements.fallbacks[1]', from: 'glm-zhipu:glm-5.3-flash', to: 'deepseek:deepseek-v4-pro', reason: '替换失效备选' }],
      state,
    )
    expect(patch.phases?.requirements?.fallbacks).toEqual(['deepseek:deepseek-v4-flash', 'deepseek:deepseek-v4-pro'])
  })

  test('AC 预设槽位映射到嵌套 patch', () => {
    const state = makeState()
    const patch = changesToPatch(
      [{ slot: 'acPresets.medium.attacker', from: 'deepseek:deepseek-v4-pro', to: 'glm-zhipu:GLM-5.3', reason: '同档位替换' }],
      state,
    )
    expect(patch.acPresets?.medium?.attacker).toEqual({ channel: 'glm-zhipu', model: 'GLM-5.3' })
  })

  test('非法 to 或未知 slot 被跳过', () => {
    const state = makeState()
    const patch = changesToPatch(
      [
        { slot: 'phases.coding', from: 'a', to: 'not-an-endpoint', reason: 'x' },
        { slot: 'unknown.slot', from: 'a', to: 'deepseek:deepseek-flash', reason: 'x' },
      ],
      state,
    )
    expect(patch).toEqual({})
  })
})

describe('collectTestEndpoints', () => {
  test('跳过空槽与 minimax 家族标记，端点去重', () => {
    const state = makeState()
    const draft = draftOf(state)
    // 添加一个空备选与一个重复端点
    draft.phases.architecture.fallbacks = [{ channel: '', model: '' }]
    draft.proxy.push({ channel: 'deepseek', model: 'deepseek-flash' }) // 与 planning 主选重复
    const eps = collectTestEndpoints(draft)
    const keys = eps.map((e) => `${e.channelId}:${e.modelId}`)
    expect(keys).toContain('deepseek:deepseek-v4-pro')
    expect(keys).toContain('deepseek:deepseek-flash')
    expect(keys.filter((k) => k === 'deepseek:deepseek-flash').length).toBe(1)
    expect(keys.some((k) => k.startsWith('minimax:'))).toBe(false)
  })
})

describe('changeHitsUnhealthySlot', () => {
  test('命中红/黄槽位返回 true，健康槽位返回 false', () => {
    const state = makeState({
      health: [
        { slot: 'phases.requirements.fallbacks[0]', channelId: 'deepseek', modelId: 'deepseek-v4-flash', status: 'model-missing' },
        { slot: 'phases.coding', channelId: 'glm-zhipu', modelId: 'GLM-5.3', status: 'ok' },
      ],
    })
    expect(
      changeHitsUnhealthySlot(
        { slot: 'phases.requirements.fallbacks.0', from: 'deepseek:deepseek-v4-flash', to: 'deepseek:deepseek-flash', reason: '改名检测' },
        state,
      ),
    ).toBe(true)
    expect(
      changeHitsUnhealthySlot(
        { slot: 'phases.coding', from: 'glm-zhipu:GLM-5.3', to: 'glm-zhipu:GLM-5.3', reason: 'no-op' },
        state,
      ),
    ).toBe(false)
  })
})

// ===== W23 接缝红测（指挥官收口：D1 冻结槽位命名 ↔ D3 解析对齐）=====

describe('W23 接缝：槽位命名对齐', () => {
  test('parseHealthSlot 接受 D1 冻结命名 phases.<id>.primary（health/changes 主选槽）', () => {
    expect(parseHealthSlot('phases.requirements.primary')).toEqual({ kind: 'phase-main', phase: 'requirements' })
    expect(parseHealthSlot('phases.coding.primary')).toEqual({ kind: 'phase-main', phase: 'coding' })
    // 兼容旧推断形态
    expect(parseHealthSlot('phases.planning')).toEqual({ kind: 'phase-main', phase: 'planning' })
  })

  test('buildHealthByRow 直接命中 .primary 槽（不再依赖端点唯一兜底；共享端点不丢）', () => {
    const state = makeState({
      health: [
        { slot: 'phases.requirements.primary', channelId: 'deepseek', modelId: 'deepseek-v4-pro', status: 'ok' },
        { slot: 'acPresets.medium.attacker', channelId: 'deepseek', modelId: 'deepseek-v4-pro', status: 'model-missing' },
      ],
    })
    const byRow = buildHealthByRow(state)
    expect(byRow.get('p:requirements')?.status).toBe('ok')
    expect(byRow.get('ac:medium:attacker')?.status).toBe('model-missing')
  })

  test('changesToPatch 应用 phase-main 变更（slot=phases.<id>.primary 不再被静默跳过）', () => {
    const state = makeState()
    const patch = changesToPatch(
      [{ slot: 'phases.planning.primary', from: 'deepseek:deepseek-v4-flash', to: 'deepseek:deepseek-flash', reason: '改名检测' }],
      state,
    )
    expect(patch.phases?.planning).toEqual({ channel: 'deepseek', model: 'deepseek-flash' })
  })

  test('buildShadowedByRow 解析 D2 字段级路径（phases.<id>.channel/model/ac* → 行 key）', () => {
    const byRow = buildShadowedByRow([
      { field: 'phases.requirements.channel', requested: 'x', effective: 'y', shadowSource: 'layer1', path: '/home/u/.proma-dev/nanju-model-config.json' },
      { field: 'phases.testing.acAttacker', requested: {}, effective: {}, shadowSource: 'layer1', path: '/home/u/.proma-dev/nanju-model-config.json' },
      { field: 'proxyCandidates', requested: [], effective: [], shadowSource: 'layer1', path: '/home/u/.proma-dev/nanju-model-config.json' },
    ])
    expect(byRow.get('p:requirements')).toContain('nanju-model-config.json')
    expect(byRow.get('p:testing:ac:acAttacker')).toContain('nanju-model-config.json')
    expect(byRow.get('proxy:*')).toContain('nanju-model-config.json')
  })
})

// ===== W23 工程审查修复红测（must#1/#2 + should#4）=====

describe('W23 审查修复：空集合与 IPC 错误形态', () => {
  test('#1 删除最后一个备选 → 发 fallbacks:null（删除覆盖继承低层），不发空数组', () => {
    const state = makeState({ fallbacks: { requirements: ['deepseek:deepseek-v4-flash', 'glm-zhipu:glm-5.3-flash'] } })
    const draft = draftOf(state)
    draft.phases.requirements.fallbacks = []
    const patch = computeSavePatch(state, draft)
    expect(patch.phases?.requirements?.fallbacks).toBeNull()
  })

  test('#4 删除全部代理候选 → 发 proxyCandidates:null，不发空数组', () => {
    const state = makeState()
    const draft = draftOf(state)
    draft.proxy = []
    const patch = computeSavePatch(state, draft)
    expect(patch.proxyCandidates).toBeNull()
  })

  test('#2 ipcErrorOf：{error} 形态提取 message；正常形态返回 null', () => {
    expect(ipcErrorOf({ error: '保存失败：xxx' })).toBe('保存失败：xxx')
    expect(ipcErrorOf({ state: { effective: {} } })).toBeNull()
    expect(ipcErrorOf(null)).toBeNull()
    expect(ipcErrorOf({ error: 42 })).toBeNull()
  })
})

/**
 * W-B B2 共享类型契约测试：NanjuDelegationSlot + GuideRoutePhase.visualReviewer 字段。
 *
 * 覆盖：
 * - NanjuDelegationSlot 白名单枚举成员（运行时不可扩展——gate 端据此断言）
 * - GuideRoutePhase.visualReviewerChannel/Model 可选字段可独立于 acActors 设置
 * - GuideVisualReviewerConfig 结构（与 NanjuACActor 同型但独立契约）
 *
 * 共享层只声明类型/常量，不参与运行时逻辑——运行时校验在主进程各域。
 */
import { describe, expect, test } from 'bun:test'
import type { GuideRoutePhase, GuideVisualReviewerConfig, NanjuDelegationSlot } from './nanju'

const VALID_SLOTS: readonly NanjuDelegationSlot[] = [
  'author',
  'ac-attacker',
  'ac-defender',
  'visual-validator',
  'general',
]

describe('W-B B2：NanjuDelegationSlot 白名单枚举（gate 端据此断言）', () => {
  test('slot 取值集合固定五项——新增 slot 必须同步 gate 与 prompt 接线', () => {
    expect(VALID_SLOTS).toEqual(['author', 'ac-attacker', 'ac-defender', 'visual-validator', 'general'])
  })

  test('每个 slot 字符串字面可作为类型使用', () => {
    const samples: NanjuDelegationSlot[] = ['author', 'ac-attacker', 'ac-defender', 'visual-validator', 'general']
    expect(samples.length).toBe(5)
  })
})

describe('W-B B2：GuideRoutePhase.visualReviewer* 字段（B2 扩展）', () => {
  test('visualReviewerChannel/Model 独立于 author 配置，不与 acActors 混叠', () => {
    const node: GuideRoutePhase = {
      id: 'prototype',
      role: 'ux-advisor',
      title: 'UX 顾问',
      channel: 'glm-zhipu',
      model: 'GLM-5.3',
      task: '你是 UX 顾问',
      outputPath: '02_UX_DESIGN/prototype.html',
      constraints: [],
      requiresUserConfirmation: true,
      requiresAC: false,
      retryLimit: 2,
      next: 'architecture',
      // B2：视觉验证者独立槽位（与 author 不同端点——同端点自证拒绝）
      visualReviewerChannel: 'minimax',
      visualReviewerModel: 'MiniMax-M3',
      acActors: {
        attacker: { channel: 'deepseek', model: 'deepseek-v4-pro' },
        defender: { channel: 'minimax', model: 'MiniMax-M3' },
      },
    }
    expect(node.visualReviewerChannel).toBe('minimax')
    expect(node.visualReviewerModel).toBe('MiniMax-M3')
    expect(node.channel).toBe('glm-zhipu')
    expect(node.acActors.attacker.channel).toBe('deepseek')
  })

  test('visualReviewer 字段可缺省（向后兼容既有渲染端）', () => {
    const node: GuideRoutePhase = {
      id: 'requirements',
      role: 'requirement-analyst',
      title: '需求分析师',
      channel: 'deepseek',
      model: 'deepseek-v4-pro',
      task: '你是需求分析师',
      outputPath: '01_PRD/prd.md',
      constraints: [],
      requiresUserConfirmation: true,
      requiresAC: false,
      retryLimit: 3,
      next: 'prototype',
      acActors: {
        attacker: { channel: 'deepseek', model: 'deepseek-flash' },
        defender: { channel: 'glm-zhipu', model: 'glm-5.3-flash' },
      },
    }
    expect(node.visualReviewerChannel).toBeUndefined()
    expect(node.visualReviewerModel).toBeUndefined()
  })
})

describe('W-B B2：GuideVisualReviewerConfig 结构（独立契约）', () => {
  test('视觉验证者配置与 author/AC 角色同形（channel/model），但语义独立', () => {
    const visual: GuideVisualReviewerConfig = {
      channel: 'minimax',
      model: 'MiniMax-M3',
    }
    expect(visual.channel).toBe('minimax')
    expect(visual.model).toBe('MiniMax-M3')
  })

  test('视觉验证者可指向非 minimax 端点（用户显式声明异族——与 author 同家族拒绝/阻塞由 gate 校验）', () => {
    const visual: GuideVisualReviewerConfig = {
      channel: 'glm-zhipu',
      model: 'glm-5.3-vision',
    }
    expect(visual.channel).toBe('glm-zhipu')
    expect(visual.model).toBe('glm-5.3-vision')
  })
})
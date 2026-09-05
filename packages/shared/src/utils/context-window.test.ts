import { test, expect, describe } from 'bun:test'
import { supports1MContext, inferContextWindow, DEFAULT_CONTEXT_WINDOW, ONE_MILLION_CONTEXT_WINDOW } from './context-window'

describe('GLM 系列 1M 上下文判定', () => {
  test('glm-5.2 命中 1M（大小写不敏感）', () => {
    expect(supports1MContext('glm-5.2')).toBe(true)
    expect(supports1MContext('GLM-5.2')).toBe(true)
    expect(inferContextWindow('glm-5.2')).toBe(ONE_MILLION_CONTEXT_WINDOW)
  })

  test('glm-5.3 命中 1M（大小写不敏感，含 [1m] 后缀历史形态）', () => {
    expect(supports1MContext('glm-5.3')).toBe(true)
    expect(supports1MContext('GLM-5.3')).toBe(true)
    expect(supports1MContext('GLM-5.3[1m]')).toBe(true)
    expect(inferContextWindow('GLM-5.3')).toBe(ONE_MILLION_CONTEXT_WINDOW)
  })

  test('glm-5.1 与 glm-5-turbo 保持默认 200K', () => {
    // 5.1 是子串 'glm-5.3' 不命中、'glm-5.2' 不命中的正确负例：防止有人把规则误写成 'glm-5'
    expect(supports1MContext('glm-5.1')).toBe(false)
    expect(supports1MContext('glm-5-turbo')).toBe(false)
    expect(inferContextWindow('glm-5.1')).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(inferContextWindow('glm-5-turbo')).toBe(DEFAULT_CONTEXT_WINDOW)
  })

  test('glm-4.x 视觉与旧模型保持默认 200K', () => {
    expect(supports1MContext('GLM-4.6V')).toBe(false)
    expect(supports1MContext('glm-4.7')).toBe(false)
    expect(inferContextWindow('GLM-4.6V')).toBe(DEFAULT_CONTEXT_WINDOW)
  })
})

describe('GPT 折扣档/Azure 中转别名 1M 上下文判定', () => {
  test.each([
    'gpt-5.6-terra-1',
    'gpt-5.6-terra-az',
    'gpt-5.6-sol-1',
    'gpt-5.6-sol-az',
    'gpt-6-astra-1',
  ])('%s 命中 1M（大小写不敏感）', (modelId) => {
    expect(supports1MContext(modelId)).toBe(true)
    expect(supports1MContext(modelId.toUpperCase())).toBe(true)
    expect(inferContextWindow(modelId)).toBe(ONE_MILLION_CONTEXT_WINDOW)
  })

  test('裸 Codex 型号保持 Codex 展示基线，不被别名表误伤', () => {
    expect(inferContextWindow('gpt-5.6-terra')).toBe(372_000)
    expect(inferContextWindow('gpt-5.6-sol')).toBe(372_000)
    expect(inferContextWindow('gpt-5.6-luna')).toBe(372_000)
    expect(inferContextWindow('gpt-5.6')).toBe(372_000)
    expect(inferContextWindow('gpt-5.4')).toBe(272_000)
    expect(supports1MContext('gpt-5.6-terra')).toBe(false)
  })

  test('未列入精准别名表的 GPT 变体保持默认 200K（禁止任意 gpt 子串匹配）', () => {
    expect(inferContextWindow('gpt-5.6-terra-pro')).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(inferContextWindow('gpt-5.6-terra-2')).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(inferContextWindow('gpt-6-astra')).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(inferContextWindow('gpt-6-astra-2')).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(inferContextWindow('some-gpt-model')).toBe(DEFAULT_CONTEXT_WINDOW)
    expect(supports1MContext('gpt-5.6-terra-pro')).toBe(false)
    expect(supports1MContext('gpt-6-astra')).toBe(false)
  })
})

describe('其他家族回归（确认本次改动未误伤）', () => {
  test('deepseek-v4 pro/flash 命中 1M', () => {
    expect(supports1MContext('deepseek-v4-pro')).toBe(true)
    expect(supports1MContext('deepseek-v4-flash')).toBe(true)
  })

  test('claude 命中 1M，haiku 被 exclude', () => {
    expect(supports1MContext('claude-sonnet-5')).toBe(true)
    expect(supports1MContext('claude-3-5-haiku')).toBe(false)
  })

  test('空字符串与 undefined 安全', () => {
    expect(supports1MContext('')).toBe(false)
    expect(inferContextWindow(undefined)).toBeUndefined()
  })
})

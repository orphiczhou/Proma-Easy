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

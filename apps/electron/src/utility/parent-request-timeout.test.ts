/**
 * P0-B：requestParent 按 method 超时分表单元测试。
 *
 * 背景：原实现所有 capability 共用硬编码 120s 超时，导致 AskUserQuestion
 * （canUseTool，等用户作答）与 wait_for_delegations（customTool，等子会话，
 * 实测 23 分钟）在正常等待中被 CAPABILITY_CANCEL 错误取消。
 */
import { describe, expect, test } from 'bun:test'
import { AGENT_RUNTIME_METHODS } from '@proma/shared'
import {
  CUSTOM_TOOL_PARENT_REQUEST_TIMEOUT_MS,
  DEFAULT_PARENT_REQUEST_TIMEOUT_MS,
  PARENT_REQUEST_CAN_USE_TOOL_TIMEOUT_ENV,
  PARENT_REQUEST_CUSTOM_TOOL_TIMEOUT_ENV,
  getParentRequestTimeoutMs,
} from './parent-request-timeout'

describe('requestParent 按 method 超时分表', () => {
  test('canUseTool 默认无超时：AskUserQuestion 等用户作答不能被定时器错杀', () => {
    expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL, {})).toBeUndefined()
  })

  test('customTool 默认 30 分钟：覆盖实测 23 分钟的子会话等待', () => {
    expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL, {}))
      .toBe(CUSTOM_TOOL_PARENT_REQUEST_TIMEOUT_MS)
    expect(CUSTOM_TOOL_PARENT_REQUEST_TIMEOUT_MS).toBe(30 * 60_000)
    expect(CUSTOM_TOOL_PARENT_REQUEST_TIMEOUT_MS).toBeGreaterThan(23 * 60_000)
  })

  test('OAuth 凭证刷新等快速回调与其余 method 维持 120s 默认', () => {
    expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CODEX_OAUTH_REFRESHED, {}))
      .toBe(DEFAULT_PARENT_REQUEST_TIMEOUT_MS)
    expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_XAI_OAUTH_REFRESHED, {}))
      .toBe(DEFAULT_PARENT_REQUEST_TIMEOUT_MS)
    expect(getParentRequestTimeoutMs('agent.capability.unknown', {}))
      .toBe(DEFAULT_PARENT_REQUEST_TIMEOUT_MS)
    expect(DEFAULT_PARENT_REQUEST_TIMEOUT_MS).toBe(120_000)
  })

  test('canUseTool 超时可通过环境变量显式设置上限', () => {
    expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL, {
      [PARENT_REQUEST_CAN_USE_TOOL_TIMEOUT_ENV]: '5000',
    })).toBe(5_000)
  })

  test('customTool 超时可通过环境变量调整或置 0 关闭', () => {
    expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL, {
      [PARENT_REQUEST_CUSTOM_TOOL_TIMEOUT_ENV]: '600000',
    })).toBe(600_000)
    expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL, {
      [PARENT_REQUEST_CUSTOM_TOOL_TIMEOUT_ENV]: '0',
    })).toBeUndefined()
  })

  test('非法环境变量回退默认值', () => {
    expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL, {
      [PARENT_REQUEST_CUSTOM_TOOL_TIMEOUT_ENV]: 'not-a-number',
    })).toBe(CUSTOM_TOOL_PARENT_REQUEST_TIMEOUT_MS)
    expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL, {
      [PARENT_REQUEST_CUSTOM_TOOL_TIMEOUT_ENV]: '-100',
    })).toBe(CUSTOM_TOOL_PARENT_REQUEST_TIMEOUT_MS)
  })

  test('严格解析（Terra MUST-1）：非纯十进制数字一律拒绝，不静默截断', () => {
    const invalid = ['80abc', '0x50', '+80', ' 80', '80 ', '80.5', '1e3', '８０', '2147483648', '999999999999999999999999999999']
    for (const raw of invalid) {
      expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL, {
        [PARENT_REQUEST_CUSTOM_TOOL_TIMEOUT_ENV]: raw,
      })).toBe(CUSTOM_TOOL_PARENT_REQUEST_TIMEOUT_MS)
    }
    // 关键安全边界：'0x50' 在宽松 parseInt 下会截断为 0（静默关闭超时），严格解析必须拒绝
    expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL, {
      [PARENT_REQUEST_CUSTOM_TOOL_TIMEOUT_ENV]: '0x50',
    })).not.toBeUndefined()
    // 合法纯数字仍通过（含前导零）
    expect(getParentRequestTimeoutMs(AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL, {
      [PARENT_REQUEST_CUSTOM_TOOL_TIMEOUT_ENV]: '0080',
    })).toBe(80)
  })
})

/**
 * P0-B：agent-service 事件投递黑洞修复的接线断言。
 *
 * agent-service.ts 依赖 electron 与大量主进程服务，无法在单测中直接 import；
 * 其 EventBus 中间件的 wc 决策已复用 getHeadlessAgentRunTarget（纯函数，
 * 由 agent-headless-run-target.test.ts 覆盖）。这里以源码断言锁定接线：
 * 1. 中间件 wc 缺失时回退主窗口（不再静默丢弃 ask_user_request 等事件）；
 * 2. 完全无窗口时按会话粒度一次性 warn（诊断信号，不刷屏）；
 * 3. registerWebContents 重新注册后重置告警。
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./agent-service.ts', import.meta.url), 'utf-8')

describe('agent-service 事件投递 fallback 接线（P0-B）', () => {
  test('中间件通过 getHeadlessAgentRunTarget 解析 wc：会话窗口优先、主窗口兜底', () => {
    expect(source).toContain(
      'const wc = getHeadlessAgentRunTarget(sessionWebContents, sessionId, getMainRendererWebContents)',
    )
    // 不允许退回旧的“只查 sessionWebContents、缺失即丢弃”写法
    expect(source).not.toContain('const wc = sessionWebContents.get(sessionId)')
  })

  test('无任何可用窗口时按会话一次性 warn', () => {
    expect(source).toContain('sessionsWarnedNoWebContents.has(sessionId)')
    expect(source).toContain('sessionsWarnedNoWebContents.add(sessionId)')
  })

  test('registerWebContents 重新注册真实 wc 后重置告警标记', () => {
    const registerBlock = source.slice(
      source.indexOf('function registerWebContents('),
      source.indexOf('function isMainRendererWindow('),
    )
    expect(registerBlock).toContain('sessionsWarnedNoWebContents.delete(sessionId)')
  })
})

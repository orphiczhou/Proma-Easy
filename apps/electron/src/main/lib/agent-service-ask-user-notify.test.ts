/**
 * P0-B Phase2 施工 A 接线断言：headless/remote 会话 AskUser 的主进程系统通知。
 *
 * 背景（e2e-runtime-results §2，R 级实测）：remote_create_session 路径的会话
 * AskUserQuestion 挂起 622s+ 无横幅。Phase1 修复后事件必达主窗口，但
 * AskUserBanner 只在该会话自己的 AgentView 内渲染（用户未打开该会话 →
 * atom 有值、横幅无渲染点），系统通知依赖 renderer Web Notification
 * （Windows 上 renderer 侧直接跳过、主进程侧又不存在 AskUser 通知代码）。
 * 因此 headless run 的询问由主进程直接发系统通知——本文件以源码断言锁定接线
 * （agent-service.ts 顶层依赖 electron，无法在单测中直接 import）。
 *
 * 证据分级：M（源码接线断言，非运行时行为）。
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./agent-service.ts', import.meta.url), 'utf-8')

describe('agent-service headless AskUser 主进程系统通知接线（P0-B Phase2）', () => {
  test('runAgentHeadless 打点 headless 会话：run 期间登记、finally 移除', () => {
    const runFn = source.slice(
      source.indexOf('export async function runAgentHeadless('),
      source.indexOf('export async function generateAgentTitle('),
    )
    expect(runFn).toContain('headlessRunSessionIds.add(runInput.sessionId)')
    const finallyBlock = runFn.slice(runFn.indexOf('} finally {'))
    expect(finallyBlock).toContain('headlessRunSessionIds.delete(runInput.sessionId)')
  })

  test('EventBus 中间件对 headless 会话 ask_user_request 触发主进程系统通知', () => {
    expect(source).toContain('headlessRunSessionIds.has(sessionId)')
    expect(source).toContain('showAskUserSystemNotification(sessionId, payload.event.request)')
  })

  test('通知仅在会话不可见时触发：无窗口或当前可见会话不是本会话', () => {
    const middleware = source.slice(
      source.indexOf('eventBus.use((sessionId, payload, next) => {'),
      source.indexOf('export function setVisibleAgentSession'),
    )
    const branch = middleware.slice(
      middleware.indexOf("payload.event.type === 'ask_user_request'"),
      middleware.indexOf('showAskUserSystemNotification(sessionId'),
    )
    expect(branch).toContain('headlessRunSessionIds.has(sessionId)')
    expect(branch).toContain('!wc || visibleAgentSessionByWebContents.get(wc) !== sessionId')
  })

  test('showAskUserSystemNotification 尊重系统支持与全局通知开关', () => {
    const fn = source.slice(
      source.indexOf('function showAskUserSystemNotification('),
      source.indexOf('const agentQueueCoordinator = new AgentQueueCoordinator('),
    )
    expect(fn).toContain('Notification.isSupported()')
    expect(fn).toContain('getSettings().notificationsEnabled')
    expect(fn).toContain('notification.show()')
  })

  test('普通（非 headless）run 不打点：runAgent 路径不写 headlessRunSessionIds', () => {
    const runFn = source.slice(
      source.indexOf('export async function runAgent('),
      source.indexOf('export async function runAgentHeadless('),
    )
    expect(runFn).not.toContain('headlessRunSessionIds')
  })
})

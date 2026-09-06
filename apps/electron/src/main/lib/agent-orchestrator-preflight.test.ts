/**
 * W19 缺陷B：跨工作区首发竞态 — 空会话工作区自愈测试（v0.17.87）。
 *
 * 背景（E2E 2026-09-05 发现1，R 级 + Dev 会话注册表实证）：
 * 南大创建链显式以南大工作区建会话（TabContent → createAgentSession(name, undefined, ws.id)），
 * 会话 meta.workspaceId 本身正确；但渲染端 agentSessionsAtom 未同步新会话时，AgentView
 * 以全局工作区回退派发 requestedWorkspaceId（可能是默认工作区），与主进程权威会话归属
 * 比对即硬拒「会话项目不匹配」（canRetry:false），被拒会话从未获得 sdkSessionId。
 * ⚠️ 工单原始根因把不匹配方向写反（以为会话继承默认工作区）；Dev 注册表实证
 * ca906911.workspaceId = 南大工作区（16171483-…），错误工作区在请求侧。
 *
 * 覆盖面：
 * - 行为级（S）：resolveWorkspaceMismatchSelfHeal 判定矩阵 —— 在
 *   agent-orchestrator-preflight.behavior.ts（fixture，不带 .test 后缀避免目录级发现）
 *   中真实执行；本文件以 Bun.spawn 子进程隔离运行并断言全绿。隔离原因：导入
 *   agent-orchestrator 需要 mock.module('electron') + 预载 agent-service，进程级 mock
 *   会污染同批其他测试文件（实证：合跑时 agent-session-manager 被早先文件部分替换后
 *   导入即 SyntaxError，反向亦然——与 nanju-confirm-advance.test.ts 顶部警告同类）。
 * - 接线级（M，参考 agent-session-delete-abort.test.ts 源码断言模式）：preflight 块
 *   调用自愈判定、reject 仍走 reportPreflightError 硬拒、rebind 落 updateAgentSessionMeta
 *   并同步后续 workspaceId 取值、空会话判定取 sdkSessionId、南大绑定走会话-项目注册表；
 *   TabContent 创建会话后立即并入渲染端会话列表。
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

describe('渲染端创建链（M 级：源码断言）', () => {
  const tabContentSource = readFileSync(
    new URL('../../renderer/components/tabs/TabContent.tsx', import.meta.url),
    'utf-8',
  )

  test('南大会话创建显式携带南大工作区（不继承活跃会话上下文）', () => {
    expect(tabContentSource).toContain('createAgentSession(name, undefined, ws.id)')
  })

  test('创建成功后立即并入渲染端会话列表（消除首发回退全局工作区的竞态窗口）', () => {
    const creation = tabContentSource.slice(
      tabContentSource.indexOf('createAgentSession(name, undefined, ws.id)'),
      tabContentSource.indexOf('nanjuCreateProject({'),
    )
    expect(creation).toContain('agentSessionsAtom')
    expect(creation).toContain('[created, ...prev]')
    // 幂等：已存在（如事件竞态先到）不重复插入
    expect(creation).toContain('prev.some((s) => s.id === created.id)')
  })
})

describe('preflight 调用点接线（M 级：源码断言，orchestrator 为大方法无法实例化单测）', () => {
  const orchestratorSource = readFileSync(new URL('./agent-orchestrator.ts', import.meta.url), 'utf-8')
  const preflightBlock = orchestratorSource.slice(
    orchestratorSource.indexOf('let sessionWorkspaceId = sessionMeta?.workspaceId'),
    orchestratorSource.indexOf('const workspaceId = sessionWorkspaceId ?? requestedWorkspaceId'),
  )

  test('不匹配时先过自愈判定，reject 分支才走 reportPreflightError 且保持 canRetry:false 硬拒文案', () => {
    expect(preflightBlock).toContain('resolveWorkspaceMismatchSelfHeal({')
    expect(preflightBlock.indexOf("resolution === 'reject'")).toBeLessThan(
      preflightBlock.indexOf("title: '会话项目不匹配'"),
    )
    expect(preflightBlock).toContain("title: '会话项目不匹配'")
    expect(preflightBlock).toContain('canRetry: false')
  })

  test('空会话判定以 sdkSessionId 为准（从未运行过 = 从未获得 sdkSessionId）', () => {
    expect(preflightBlock).toContain('Boolean(sessionMeta?.sdkSessionId)')
  })

  test('rebind 分支：写会话注册表并同步后续 workspaceId 取值（避免改绑后仍用旧工作区）', () => {
    expect(preflightBlock).toContain('updateAgentSessionMeta(sessionId, { workspaceId: requestedWorkspaceId })')
    expect(preflightBlock).toContain('sessionWorkspaceId = requestedWorkspaceId')
  })

  test('南大项目绑定判定走会话-项目注册表（nanju-phase-gate 的 findNanjuProjectBySession）', () => {
    expect(preflightBlock).toContain('findNanjuProjectBySession(sessionWorkspace.slug, sessionId)')
    // 有运行历史时无需查注册表（已注定 reject）
    expect(preflightBlock.indexOf('Boolean(sessionMeta?.sdkSessionId)')).toBeLessThan(
      preflightBlock.indexOf('findNanjuProjectBySession'),
    )
  })

  test('自愈留有归因日志（改绑/保持两个分支各一条 console）', () => {
    expect(preflightBlock).toContain('空会话工作区自愈（改绑）')
    expect(preflightBlock).toContain('空会话工作区自愈（保持会话工作区）')
  })
})

describe('resolveWorkspaceMismatchSelfHeal 判定矩阵（S 级：真实函数执行，子进程隔离）', () => {
  test(
    'fixture 全绿（E2E 实测方向保会话 / 工单红测试1改绑 / 红测试2有运行历史硬拒 / 红测试3幽灵工作区硬拒 / 无不匹配直通）',
    async () => {
      const fixturePath = new URL('./agent-orchestrator-preflight.behavior.ts', import.meta.url).pathname
      const proc = Bun.spawn([process.execPath, 'test', fixturePath], {
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, PROMA_AGENT_RUNTIME: 'off' },
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      const output = `${stdout}\n${stderr}`
      if (exitCode !== 0) {
        console.error(`[W19 缺陷B] behavior fixture 失败 (exit=${exitCode}):\n${output}`)
      }
      expect(exitCode).toBe(0)
      expect(output).toContain('5 pass')
      expect(output).toContain('0 fail')
    },
    60000,
  )
})

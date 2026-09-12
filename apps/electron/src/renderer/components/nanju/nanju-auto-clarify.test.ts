/**
 * v2.4「自动补完需求」渲染端纯函数测试
 *
 * 1. resolveAutoClarifyAvailability（ModeSelectView）：复选框仅快消型可选
 * 2. stripRouteHeaderPrefix（AskUserBanner）：横幅展示剥「确认·」「设计·」「转述·」前缀
 *    （存储带前缀——auto 开启时路由规则消费；显示美观剥前缀，D7 §10）
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const { resolveAutoClarifyAvailability } = await import('./ModeSelectView')
const { stripRouteHeaderPrefix } = await import('../agent/AskUserBanner')
const { isNanjuProxySession, buildAgentSessionTrees } = await import('../app-shell/LeftSidebar')
const { buildClarifyNoticeText, resolveAutoClarifyHeaderBadge, planAutoClarifyReenable } = await import('./guide/GuidePanel')

describe('v2.4：自动补完复选框可用性（仅快消型）', () => {
  test('quick → available（复选框可选）', () => {
    expect(resolveAutoClarifyAvailability('quick')).toBe('available')
  })

  test('iterative → hidden（长期迭代型隐藏/禁用——升级即失效硬边界）', () => {
    expect(resolveAutoClarifyAvailability('iterative')).toBe('hidden')
  })
})

describe('v2.4：横幅 header 前缀剥离（stripRouteHeaderPrefix）', () => {
  test('三类路由前缀均剥：「确认·」「设计·」「转述·」', () => {
    expect(stripRouteHeaderPrefix('确认·原型交互验证')).toBe('原型交互验证')
    expect(stripRouteHeaderPrefix('确认·满意交付')).toBe('满意交付')
    expect(stripRouteHeaderPrefix('设计·快速修改')).toBe('快速修改')
    expect(stripRouteHeaderPrefix('转述·需求澄清')).toBe('需求澄清')
  })

  test('无前缀原样返回（普通会话/历史 header 不受影响）', () => {
    expect(stripRouteHeaderPrefix('预览确认')).toBe('预览确认')
    expect(stripRouteHeaderPrefix('')).toBe('')
    expect(stripRouteHeaderPrefix('其他问题')).toBe('其他问题')
  })

  test('纯前缀（空余部分）→ 空串（不残留分隔符）', () => {
    expect(stripRouteHeaderPrefix('确认·')).toBe('')
  })

  test('仅剥首个前缀，不重复剥（嵌套前缀不误伤）', () => {
    expect(stripRouteHeaderPrefix('确认·设计·双前缀')).toBe('设计·双前缀')
  })
})

// ═══════════════ v2.4 返工（DeepSeek 工程审查 F1-1/F2-7） ═══════════════

const agentViewSource = readFileSync(join(import.meta.dir, '..', 'agent', 'AgentView.tsx'), 'utf-8')

/** 从锚点第 occurrence 次出现的行向后取窗口，断言窗口内含 humanOrigin: false（程序化路径显式非真人） */
function assertWindowHasHumanOriginFalse(anchor: string, windowLines = 40, occurrence = 1): void {
  const lines = agentViewSource.split('\n')
  let seen = 0
  let idx = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line !== undefined && line.includes(anchor)) {
      seen += 1
      if (seen === occurrence) { idx = i; break }
    }
  }
  expect(idx).toBeGreaterThanOrEqual(0)
  const window = lines.slice(idx, idx + windowLines).join('\n')
  expect(window).toContain('humanOrigin: false')
}

describe('返工 F1-1（Defender #2 red）：四处程序化 sendAgentMessage 显式 humanOrigin:false', () => {
  test('pendingPrompt 自动配置（snapshot.sdkMessage → AgentSendInput）置 humanOrigin:false', () => {
    assertWindowHasHumanOriginFalse('userMessage: snapshot.sdkMessage')
  })

  test('队列重放 sendAgentMessage（sdkText 第二次出现处）置 humanOrigin:false', () => {
    // 'userMessage: sdkText' 首现 = queueAgentMessage 入队（非发送通道）；
    // 第二次 = 队列重放 dequeue 后的 sendAgentMessage 块（Defender #2 点名的 :1111 路径）
    assertWindowHasHumanOriginFalse('userMessage: sdkText', 40, 2)
  })

  test('/compact 合成消息置 humanOrigin:false', () => {
    assertWindowHasHumanOriginFalse("userMessage: '/compact'")
  })

  test('retry 重放（lastUserMessage）置 humanOrigin:false（与队列重放同构，不保留真人语义）', () => {
    assertWindowHasHumanOriginFalse('userMessage: lastUserMessage')
  })

  test('总计至少 4 处显式置值（防御后续新增程序化路径时误删既有防护）', () => {
    const count = (agentViewSource.match(/humanOrigin: false/g) ?? []).length
    expect(count).toBeGreaterThanOrEqual(4)
  })
})

describe('返工 F2-7（Defender #11 后半）：nanjuProxy 代理会话侧栏隐藏谓词', () => {
  /** 最小会话元（字段面宽松：只填谓词消费的字段） */
  function makeSession(id: string, extra: Record<string, unknown> = {}): never {
    return { id, title: id, createdAt: 0, updatedAt: 0, ...extra } as never
  }

  test('isNanjuProxySession：meta.nanjuProxy=true → true；普通/委派子会话 → false', () => {
    expect(isNanjuProxySession(makeSession('proxy-1', { nanjuProxy: true }))).toBe(true)
    expect(isNanjuProxySession(makeSession('normal'))).toBe(false)
    // 委派子会话（parent+delegation 皆在）不命中代理谓词（两谓词语义独立）
    expect(isNanjuProxySession(makeSession('deleg-1', { parentSessionId: 'p', sourceDelegationId: 'd' }))).toBe(false)
  })

  test('buildAgentSessionTrees：仅含 nanjuProxy meta 的代理会话不进树（根与子节点都不出现）', () => {
    const normal = makeSession('normal-root')
    const proxy = makeSession('proxy-ghost', { nanjuProxy: true })
    const tree = buildAgentSessionTrees([normal, proxy] as never[])
    expect(tree.map((t: { session: { id: string } }) => t.session.id)).toEqual(['normal-root'])
    expect(JSON.stringify(tree)).not.toContain('proxy-ghost')
  })

  test('isDelegatedChildSession 语义未动：parent+delegation 双条件委派子会话仍归树（不扩散未绑定写豁免）', () => {
    const parent = makeSession('parent')
    const child = makeSession('deleg-child', { parentSessionId: 'parent', sourceDelegationId: 'd1' })
    const tree = buildAgentSessionTrees([parent, child] as never[])
    expect(tree.map((t: { session: { id: string } }) => t.session.id)).toEqual(['parent'])
    expect(JSON.stringify(tree)).toContain('deleg-child')
  })
})

// ═══════════════ D8（v2.4.1）渲染域：文案与澄清态语义（R7-12/R7-13） ═══════════════

const guidePanelSource = readFileSync(join(import.meta.dir, 'guide', 'GuidePanel.tsx'), 'utf-8')
const modeSelectSource = readFileSync(join(import.meta.dir, 'ModeSelectView.tsx'), 'utf-8')

describe('D8：ModeSelectView 复选框文案（§四 9）', () => {
  test('说明文案含自动审核语义：环境安装除外 + 测试全绿自动交付', () => {
    expect(modeSelectSource).toContain('环境安装除外')
    expect(modeSelectSource).toContain('自动交付')
    // 旧文案（仅代答语义）不再存在
    expect(modeSelectSource).not.toContain('关键确认与设计偏好仍由你决定')
  })
})

describe('D8：GuidePanel 徽标文案 + 代决标签', () => {
  test('徽标改「自动进行中」（代答+代决+自动审核的全量语义）', () => {
    expect(guidePanelSource).toContain('自动进行中')
    expect(guidePanelSource).not.toContain('>自动补完中<')
  })

  test('代答卡片支持 kind 区分：decision 显示「代决」标签', () => {
    expect(guidePanelSource).toContain('代决')
  })
})

describe('D8：CLARIFY 澄清态文案分叉（R7-12：auto 下「代理澄清中」，off 下等用户）', () => {
  test('auto on：{主节点}_CLARIFY → 「代理澄清中」（语义随代理而非等用户）', () => {
    expect(buildClarifyNoticeText('PROTO_CLARIFY', true)).toContain('代理澄清中')
    expect(buildClarifyNoticeText('PROTO_CLARIFY', true)).toContain('无需')
  })

  test('auto off：_CLARIFY → 等待用户回答语义', () => {
    const text = buildClarifyNoticeText('PROTO_CLARIFY', false)
    expect(text).toContain('澄清')
    expect(text).not.toContain('代理澄清中')
  })

  test('非 CLARIFY 子步骤 → null（不渲染提示条；R7-13：auto 项目 UC 态由 autoConfirm 写入，渲染无需特判）', () => {
    expect(buildClarifyNoticeText('PROTO', true)).toBeNull()
    expect(buildClarifyNoticeText('PROTO_UC', true)).toBeNull()
    expect(buildClarifyNoticeText('', false)).toBeNull()
  })
})

// ═══════════════ W22 M-8（#12）：GuidePanel 停用态徽标 + 重开入口 ═══════════════

describe('W22 M-8：autoClarify 停用态徽标（off 态存在 + 点击重开 enabled=true）', () => {
  test('off 态（quick + 曾开启后停用：字段存在且 enabled=false）→ 灰色徽标存在（disabled）', () => {
    expect(resolveAutoClarifyHeaderBadge({ mode: 'quick', autoClarify: { enabled: false } })).toEqual({ kind: 'disabled' })
  })

  test('on 态 → active；从未开启（字段缺失/enabled 缺省）→ null 零噪音；iterative → null（无重开语义）', () => {
    expect(resolveAutoClarifyHeaderBadge({ mode: 'quick', autoClarify: { enabled: true } })).toEqual({ kind: 'active' })
    expect(resolveAutoClarifyHeaderBadge({ mode: 'quick' })).toBeNull()
    expect(resolveAutoClarifyHeaderBadge({ mode: 'quick', autoClarify: {} })).toBeNull()
    // iterative 即使残留 enabled=false（升级处置后）也不显示——升级即失效，重开会被 IPC 拒绝
    expect(resolveAutoClarifyHeaderBadge({ mode: 'iterative', autoClarify: { enabled: false } })).toBeNull()
    expect(resolveAutoClarifyHeaderBadge(null)).toBeNull()
  })

  test('重开动作：点击后 IPC 入参 enabled=true（仅 disabled 态可重开；active/null 无动作）', () => {
    expect(planAutoClarifyReenable({ kind: 'disabled' })).toEqual({ enabled: true })
    expect(planAutoClarifyReenable({ kind: 'active' })).toBeNull()
    expect(planAutoClarifyReenable(null)).toBeNull()
  })

  test('UI 接线：徽标文案「自动补完·已停用」+ 重开经内联二次确认后走 nanjuSetAutoClarify', () => {
    // 徽标文案（灰色态，与开启态「自动进行中」区分）
    expect(guidePanelSource).toContain('自动补完·已停用')
    // 点击徽标 → 确认条（不直接调 IPC——重启自动模式是行为变化，需显式确认）
    expect(guidePanelSource).toContain('reenableConfirming')
    expect(guidePanelSource).toContain('重新开启「自动补完需求」')
    // 确认后调用 IPC 且入参来自 plan（enabled=true）
    expect(guidePanelSource).toMatch(/nanjuSetAutoClarify\(\{ workspaceSlug, projectId: data\.project\.projectId, enabled: plan\.enabled \}/)
    // 开启语义提示与既有复选框口径一致（环境安装除外）
    expect(guidePanelSource).toContain('确认类环节自动通过（环境安装除外）')
  })
})

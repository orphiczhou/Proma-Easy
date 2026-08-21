import { describe, expect, test } from 'bun:test'
import type { Channel } from '@proma/shared'
import { buildL2TaskWithAC, resolveMinimaxM3Channel } from './nanju-router-prompt'
import { getPhaseNode } from './nanju-router'

/** 构造测试用渠道 */
function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'ad74ac74-1111-2222-3333-444455556666',
    name: 'MiniMax',
    provider: 'minimax',
    baseUrl: 'https://api.minimaxi.com/anthropic',
    apiKey: 'encrypted',
    models: [
      { id: 'MiniMax-M3', name: 'MiniMax M3', enabled: true },
    ],
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  }
}

describe('minimax 渠道运行时解析', () => {
  test('解析 provider=minimax 且含已启用 MiniMax-M3 模型的渠道（UUID 渠道 ID）', () => {
    const uuid = 'ad74ac74-aaaa-bbbb-cccc-dddddddddddd'
    const resolved = resolveMinimaxM3Channel([makeChannel({ id: uuid })])
    expect(resolved).toEqual({ channelId: uuid, modelId: 'MiniMax-M3' })
  })

  test('兼容多种 M3 写法（minimax-m3 / MiniMax M3 名称匹配）', () => {
    expect(resolveMinimaxM3Channel([
      makeChannel({ id: 'ch-1', models: [{ id: 'minimax-m3', name: 'M3', enabled: true }] }),
    ])).toEqual({ channelId: 'ch-1', modelId: 'minimax-m3' })

    expect(resolveMinimaxM3Channel([
      makeChannel({ id: 'ch-2', models: [{ id: 'some-id', name: 'MiniMax M3 Vision', enabled: true }] }),
    ])).toEqual({ channelId: 'ch-2', modelId: 'some-id' })
  })

  test('跳过未启用渠道与未启用模型', () => {
    expect(resolveMinimaxM3Channel([
      makeChannel({ id: 'disabled-channel', enabled: false }),
      makeChannel({ id: 'disabled-model', models: [{ id: 'MiniMax-M3', name: 'M3', enabled: false }] }),
    ])).toBeNull()
  })

  test('跳过非 minimax provider 的渠道', () => {
    expect(resolveMinimaxM3Channel([
      makeChannel({ id: 'other', provider: 'glm-zhipu' as Channel['provider'] }),
    ])).toBeNull()
  })

  test('无任何 minimax 渠道时返回 null（供上层抛中文提示）', () => {
    expect(resolveMinimaxM3Channel([])).toBeNull()
  })

  test('多个 minimax 渠道时取第一个含启用 M3 模型的', () => {
    expect(resolveMinimaxM3Channel([
      makeChannel({ id: 'no-m3', models: [{ id: 'minimax-m2', name: 'M2', enabled: true }] }),
      makeChannel({ id: 'has-m3', models: [{ id: 'MiniMax-M3', name: 'M3', enabled: true }] }),
    ])).toEqual({ channelId: 'has-m3', modelId: 'MiniMax-M3' })
  })
})

describe('L2 委派指令构建（视觉闭环）', () => {
  const authorUuid = 'ad74ac74-aaaa-bbbb-cccc-dddddddddddd'
  const minimaxAuthor = { channel: authorUuid, model: 'MiniMax-M3' }

  test('prototype 阶段包含截图渲染自检循环（chrome-devtools + read 截图 + 连续 2 轮）', () => {
    const phase = getPhaseNode('iterative', 'prototype')!
    const task = buildL2TaskWithAC(phase, minimaxAuthor, 'PRD 摘要', ['/tmp/prd.md'], '/tmp/project')

    expect(task).toContain('截图渲染自检循环')
    expect(task).toContain('new_page 打开 file:///tmp/project/02_UX_DESIGN/prototype.html')
    expect(task).toContain('take_screenshot')
    expect(task).toContain('用 read 工具读取该截图')
    expect(task).toContain('连续 2 轮截图检查均无缺陷')
  })

  test('prototype 阶段强调逐条对照 PRD 用户故事', () => {
    const phase = getPhaseNode('quick', 'prototype')!
    const task = buildL2TaskWithAC(phase, minimaxAuthor, 'PRD 摘要', [], '/tmp/project')

    expect(task).toContain('前序必读：PRD 用户故事清单')
    expect(task).toContain('逐条对照该用户故事清单')
  })

  test('prototype 阶段 AC 审计维度追加视觉还原度与交互可用性', () => {
    const phase = getPhaseNode('iterative', 'prototype')!
    const task = buildL2TaskWithAC(phase, minimaxAuthor, 'PRD 摘要', [], '/tmp/project')

    expect(task).toContain('视觉还原度、交互可用性')
  })

  test('prototype 阶段包含独立视觉裁决（inline minimax，只看 PRD 用户故事 + 最新截图，red 回修复循环）', () => {
    const phase = getPhaseNode('quick', 'prototype')!
    const task = buildL2TaskWithAC(phase, minimaxAuthor, 'PRD 摘要', [], '/tmp/project')

    expect(task).toContain('独立视觉裁决')
    expect(task).toContain('channel=' + authorUuid)
    expect(task).toContain('model=MiniMax-M3')
    expect(task).toContain('PRD 用户故事清单 + 最新原型截图')
    expect(task).toContain('不允许参考你的自述')
    expect(task).toContain('回到「截图渲染自检循环」')
  })

  test('prototype 阶段按模式取预设攻防：quick=light（flash 攻/turbo 防）', () => {
    const phase = getPhaseNode('quick', 'prototype')!
    const task = buildL2TaskWithAC(phase, minimaxAuthor, '无（这是需求阶段）', [], '/tmp/project')

    expect(task).toContain('channel=deepseek, model=deepseek-v4-flash')
    expect(task).toContain('channel=glm-zhipu, model=glm-5-turbo')
  })

  test('prototype 阶段按模式取预设攻防：iterative=medium（pro 攻/GLM-5.3 防）', () => {
    const phase = getPhaseNode('iterative', 'prototype')!
    const task = buildL2TaskWithAC(phase, minimaxAuthor, '无（这是需求阶段）', [], '/tmp/project')

    expect(task).toContain('channel=deepseek, model=deepseek-v4-pro')
    expect(task).toContain('channel=glm-zhipu, model=GLM-5.3')
  })

  test('非 prototype 阶段保持五维审计，不包含视觉闭环内容', () => {
    const phase = getPhaseNode('iterative', 'architecture')!
    const task = buildL2TaskWithAC(phase, { channel: 'deepseek', model: 'deepseek-v4-pro' }, 'PRD 摘要', [], '/tmp/project')

    expect(task).toContain('完整性、正确性、一致性、可执行性、安全性。')
    expect(task).not.toContain('截图渲染自检循环')
    expect(task).not.toContain('独立视觉裁决')
    expect(task).not.toContain('视觉还原度')
  })

  test('防御者与作者同家族时构建指令抛错（首次构建期拦截）', () => {
    const phase = getPhaseNode('iterative', 'requirements')!
    // 作者 deepseek，防御者显式覆盖为 deepseek-backup（同前缀家族）→ 必须抛错
    const badPhase = { ...phase, acDefenderChannel: 'deepseek-backup', acDefenderModel: 'deepseek-v4-pro' }
    expect(() => buildL2TaskWithAC(badPhase, { channel: 'deepseek', model: 'deepseek-v4-pro' }, 'PRD 摘要', [], '/tmp/project'))
      .toThrow('防御者渠道')
  })
})

describe('L2 委派指令构建（coding 阶段，P1 Sprint A）', () => {
  const dsAuthor = { channel: 'deepseek', model: 'deepseek-v4-pro' }

  test('coding 包含零构建约束、沙箱边界约束与入口产出路径', () => {
    const phase = getPhaseNode('quick', 'coding')!
    const task = buildL2TaskWithAC(phase, dsAuthor, 'PRD 摘要', [], '/tmp/project')

    expect(task).toContain('零构建约束')
    expect(task).toContain('禁止触碰其他 project-')
    expect(task).toContain('请将产出写入：/tmp/project/08_APP/index.html')
    // 点选纠错标记与原型同构
    expect(task).toContain('data-ai-id')
  })

  test('coding 强调 PRD 用户故事清单必读（自测对照基准）+ 原型大文件取舍提示', () => {
    const phase = getPhaseNode('iterative', 'coding')!
    const task = buildL2TaskWithAC(phase, dsAuthor, 'PRD 摘要', [], '/tmp/project')

    expect(task).toContain('前序必读：PRD 用户故事清单')
    expect(task).toContain('代码生成、运行自测、AC 审计')
    expect(task).toContain('允许只读其结构与关键交互段')
  })

  test('coding 自测指令：chrome-devtools new_page 打开入口实测 P0 交互，连续 1 轮无缺陷', () => {
    const phase = getPhaseNode('quick', 'coding')!
    const task = buildL2TaskWithAC(phase, dsAuthor, 'PRD 摘要', [], '/tmp/project')

    expect(task).toContain('chrome-devtools MCP 的 new_page 打开入口文件')
    expect(task).toContain('实测每个 P0 交互')
    expect(task).toContain('连续 1 轮无缺陷才算完成')
  })

  test('coding 不含 prototype 专属视觉闭环（截图自检/视觉裁决/视觉维度），沿用默认五维审计', () => {
    const phase = getPhaseNode('iterative', 'coding')!
    const task = buildL2TaskWithAC(phase, dsAuthor, 'PRD 摘要', [], '/tmp/project')

    expect(task).toContain('完整性、正确性、一致性、可执行性、安全性。')
    expect(task).not.toContain('截图渲染自检循环')
    expect(task).not.toContain('独立视觉裁决')
    expect(task).not.toContain('视觉还原度')
  })
})

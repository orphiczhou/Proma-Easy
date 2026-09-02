import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Channel } from '@proma/shared'

/**
 * L1 prompt（getNanjuRouterPrompt）经 findNanjuProjectBySession 读项目元数据，
 * 依赖 config-paths.getWorkspaceFilesDir——按仓库既有模式（nanju-router-gate.test.ts）
 * 先 mock.module 指向 tmpdir，再动态导入被测模块（静态导入会在 mock 前解析真实模块）。
 */
let fixtureRoot = ''
const actualConfigPaths = await import('./config-paths')
mock.module('./config-paths', () => ({
  ...actualConfigPaths,
  getWorkspaceFilesDir: () => fixtureRoot,
  getAgentWorkspacePath: () => fixtureRoot,
}))

const { buildL2TaskWithAC, resolveMinimaxM3Channel, getNanjuRouterPrompt } = await import('./nanju-router-prompt')
const { getPhaseNode } = await import('./nanju-router')

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

  test('prototype 阶段按模式取预设攻防：quick=light（flash 攻/5.3-flash 防）', () => {
    const phase = getPhaseNode('quick', 'prototype')!
    const task = buildL2TaskWithAC(phase, minimaxAuthor, '无（这是需求阶段）', [], '/tmp/project')

    expect(task).toContain('channel=deepseek, model=deepseek-v4-flash')
    expect(task).toContain('channel=glm-zhipu, model=glm-5.3-flash')
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

describe('coding 工程品类注入（W3，v0.17.66）', () => {
  const dsAuthor = { channel: 'deepseek', model: 'deepseek-v4-pro' }

  test('未传品类时降级 web-fullstack 并注入品类自检（旧签名兼容 + 第二道防线）', () => {
    const phase = getPhaseNode('quick', 'coding')!
    const task = buildL2TaskWithAC(phase, dsAuthor, 'PRD 摘要', [], '/tmp/project')

    expect(task).toContain('工程品类判定：web-fullstack（Web 全栈应用）')
    expect(task).toContain('降级默认值')
    expect(task).toContain('品类自检')
  })

  test('传入 desktop-app 时注入品类声明 + 验收载体对齐（实证问题直接对策）', () => {
    const phase = getPhaseNode('iterative', 'coding')!
    const task = buildL2TaskWithAC(phase, dsAuthor, 'PRD 摘要', [], '/tmp/project', {
      category: 'desktop-app',
      source: 'architecture',
    })

    expect(task).toContain('工程品类判定：desktop-app（桌面应用）')
    expect(task).toContain('不是网站')
    expect(task).toContain('架构文档（architecture.md）标记')
    expect(task).toContain('验收载体对齐')
    expect(task).toContain('data-ai-id')
    // 非默认判定不注入自检
    expect(task).not.toContain('品类自检')
  })

  test('模板已落位时注入全文路径引用；未落位时省略（降级仅要点）', () => {
    const phase = getPhaseNode('quick', 'coding')!
    const taskWithTemplate = buildL2TaskWithAC(phase, dsAuthor, 'PRD 摘要', [], '/tmp/project-with-tpl', {
      category: 'desktop-app',
      source: 'prd',
    })
    // /tmp/project-with-tpl 下无模板文件 → templatePath=null
    expect(taskWithTemplate).not.toContain('/tmp/project-with-tpl/00_ENGINEERING_TEMPLATE/template.md')
    expect(taskWithTemplate).toContain('验收载体对齐')

    const plain = buildL2TaskWithAC(phase, dsAuthor, 'PRD 摘要', [], '/tmp/project', null)
    expect(plain).toContain('工程品类判定：web-fullstack')
    expect(plain).toContain('品类自检')
  })

  test('非 coding 阶段不注入品类节（requirements/prototype/architecture/testing 均无）', () => {
    for (const stage of ['requirements', 'architecture', 'testing'] as const) {
      const phase = getPhaseNode('iterative', stage)!
      const task = buildL2TaskWithAC(phase, dsAuthor, 'PRD 摘要', [], '/tmp/project', {
        category: 'desktop-app',
        source: 'architecture',
      })
      expect(task).not.toContain('工程品类判定')
    }
  })
})

describe('testing 阶段 L2 委派指令（P1 Sprint B：GWT 场景生成；v0.17.63 作者回 deepseek）', () => {
  const dsAuthor = { channel: 'deepseek', model: 'deepseek-v4-pro' }

  test('包含 steps.json 机器可执行 schema 规范（op 白名单不含 eval + 双文件契约 + 透明 skip）', () => {
    const phase = getPhaseNode('quick', 'testing')!
    const task = buildL2TaskWithAC(phase, dsAuthor, 'PRD 摘要', ['/tmp/prd.md'], '/tmp/project')
    expect(task).toContain('steps.json 格式规范')
    expect(task).toContain('click / fill / press / wait-selector / assert-text / assert-visible / assert-count。')
    expect(task).toContain('复杂状态断言暂不支持自定义脚本')
    expect(task).not.toContain('/ eval')
    expect(task).toContain('06_TESTS/features/us-XX.feature 配一个同名 us-XX.steps.json')
    expect(task).toContain('unmapped:true')
    expect(task).toContain('禁止依赖严格时刻的断言')
    // 产出路径指向汇总入口
    expect(task).toContain('/tmp/project/06_TESTS/features/index.feature')
  })

  test('包含 PRD 用户故事清单必读强调（覆盖性判定的对照基准）', () => {
    const phase = getPhaseNode('quick', 'testing')!
    const task = buildL2TaskWithAC(phase, dsAuthor, 'PRD 摘要', ['/tmp/prd.md'], '/tmp/project')
    expect(task).toContain('前序必读：PRD 用户故事清单')
    expect(task).toContain('GWT 验收场景生成、步骤映射、AC 审计')
  })

  test('testing 作者（deepseek）与 AC 攻防满足家族多样性断言（不抛错；不再要求与 coding 异构）', () => {
    const phase = getPhaseNode('iterative', 'testing')!
    expect(() => buildL2TaskWithAC(phase, dsAuthor, 'PRD 摘要', [], '/tmp/project')).not.toThrow()
  })
})

describe('AC 攻防轮次预算 + 时长控制（v0.17.64 Sprint C1，实证①：UX 阶段 50min~3.5h 失控）', () => {
  const dsAuthor = { channel: 'deepseek', model: 'deepseek-v4-pro' }

  test('AC 审计状态机注入轮次预算：攻防修复 ≤2 轮 + 未清零收敛为已知问题清单（所有阶段）', () => {
    for (const stage of ['prototype', 'coding', 'testing'] as const) {
      const phase = getPhaseNode('quick', stage)!
      const task = buildL2TaskWithAC(phase, dsAuthor, 'PRD 摘要', [], '/tmp/project')
      expect(task).toContain('轮次预算（硬性，v0.17.64）：攻防修复循环 ≤2 轮')
      expect(task).toContain('第 2 轮防御确认后无论 red 是否清零都必须收敛')
      expect(task).toContain('已知问题清单')
      expect(task).toContain('禁止第 3 轮攻击修复')
    }
  })

  test('prototype 阶段：总预算 ≤30 分钟提示 + 视觉裁决 red 回炉 ≤2 次', () => {
    const phase = getPhaseNode('quick', 'prototype')!
    const task = buildL2TaskWithAC(phase, dsAuthor, 'PRD 摘要', [], '/tmp/project')
    expect(task).toContain('整个原型阶段（生成+截图自检+AC 攻防+视觉裁决）预算 ≤30 分钟')
    expect(task).toContain('超时应收敛交付当前最优版本')
    expect(task).toContain('视觉裁决 red 回炉 ≤2 次（v0.17.64）')
    expect(task).toContain('不再回炉')
  })

  test('非 prototype 阶段不含 prototype 专属时长预算（内环预算仍注入）', () => {
    const phase = getPhaseNode('quick', 'coding')!
    const task = buildL2TaskWithAC(phase, dsAuthor, 'PRD 摘要', [], '/tmp/project')
    expect(task).not.toContain('预算 ≤30 分钟')
    expect(task).not.toContain('视觉裁决 red 回炉')
  })
})

describe('L1 调度员指令（v0.17.64：超时纪律 + 收口果断性）', () => {
  /** 构造项目 fixture 并返回 prompt（stage 决定阶段；不建 prd 时 getPrdSummary 返回占位） */
  function buildPrompt(stage: 'requirements' | 'testing', opts: { prd?: boolean } = {}): string {
    const dir = mkdtempSync(join(tmpdir(), 'nanju-prompt-'))
    fixtureRoot = dir
    const projectDir = join(dir, 'project-demo')
    mkdirSync(join(projectDir, '01_PRD'), { recursive: true })
    if (opts.prd) {
      writeFileSync(join(projectDir, '01_PRD', 'prd.md'), '# PRD\n## US-01 添加读书笔记\n内容补齐最低体积。')
    }
    writeFileSync(join(dir, '_nanju-projects.json'), JSON.stringify([{
      projectId: 'demo',
      name: '读书笔记',
      mode: 'quick',
      status: 'active',
      currentStage: stage,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sessionId: 'session-1',
    }]))
    const prompt = getNanjuRouterPrompt('test-ws', 'session-1')
    expect(prompt).toBeTruthy()
    return prompt as string
  }

  afterEach(() => {
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
    fixtureRoot = ''
  })

  test('步骤 2 超时纪律：显式 timeoutSeconds=1200 + running 先 stop 再续接/重派（不催办）+ 不无限等待', () => {
    const prompt = buildPrompt('requirements')
    expect(prompt).toContain('timeoutSeconds=1200')
    // v0.17.65 AC Z-2：continue_delegation 对 running 委派必 throw——不再教 L1 催办，
    // 改为「先 stop_delegation 终止，再 continue_delegation 追加新指令或 delegate_agent 重派」
    expect(prompt).not.toContain('continue_delegation 催办')
    expect(prompt).toContain('stop_delegation 终止该子会话')
    expect(prompt).toContain('continue_delegation 向已停止的子会话追加新指令')
    expect(prompt).toContain('delegate_agent 重派')
    expect(prompt).toContain('running 中的委派不能直接 continue_delegation')
    expect(prompt).toContain('不要反复无限等待')
  })

  test('testing 收口果断性（实证④）：立即输出推进标记，不等用户确认、不以核实/澄清代替推进', () => {
    const prompt = buildPrompt('testing')
    expect(prompt).toContain('【果断收口】双文件核验通过')
    expect(prompt).toContain('不要等待用户确认')
    expect(prompt).toContain('不要以「核实/澄清」')
    expect(prompt).toContain('<!-- PHASE_ADVANCE: testing -->')
  })

  test('非 testing 阶段：用户确认后立即收口，不得以再核实/再澄清推迟推进（一句话强化，不改语义）', () => {
    const prompt = buildPrompt('requirements', { prd: true })
    expect(prompt).toContain('不得再以「再核实/再澄清」推迟推进')
    // 确认环节语义未变：仍要求用户确认（requiresUserConfirmation=true 的阶段）
    expect(prompt).toContain('AskUserQuestion')
  })
})

// ===== W7 架构师环境指令 + W2c 意见收集轮回归标记（v0.17.69） =====

describe('architecture L2 环境配置指令（W7 B3：探测 + projectEnv 标记行 + 缺失只报告）', () => {
  test('两模式 L2 任务均含环境节指令与 projectEnv 标记行要求', () => {
    for (const mode of ['quick', 'iterative'] as const) {
      const phase = getPhaseNode(mode, 'architecture')!
      const task = buildL2TaskWithAC(phase, { channel: 'deepseek', model: 'deepseek-v4-pro' }, 'PRD 摘要', [], '/tmp/project')
      expect(task).toContain('## 环境配置（必须执行')
      expect(task).toContain('探测命令幂等')
      expect(task).toContain('projectEnv: ready')
      expect(task).toContain('projectEnv: missing:')
      expect(task).toContain('禁止安装/升级/修改任何系统配置')  // U3：缺失只报告不安装
      expect(task).toContain('## 环境配置」节的清单表')
    }
  })

  test('quick architecture 免 inline AC（U1 方案 A：无攻防段，产出自查替代）；iterative 保留攻防', () => {
    const quickPhase = getPhaseNode('quick', 'architecture')!
    const quickTask = buildL2TaskWithAC(quickPhase, { channel: 'deepseek', model: 'deepseek-v4-pro' }, 'PRD', [], '/tmp/project')
    expect(quickTask).not.toContain('AC 对抗审计（必须执行）')
    expect(quickTask).toContain('产出自查（代替 AC 攻防')
    expect(quickTask).toContain('30-60 行精简')
    const iterPhase = getPhaseNode('iterative', 'architecture')!
    const iterTask = buildL2TaskWithAC(iterPhase, { channel: 'deepseek', model: 'deepseek-v4-pro' }, 'PRD', [], '/tmp/project')
    expect(iterTask).toContain('AC 对抗审计（必须执行）')
  })
})

describe('L1 指令：意见收集轮回归标记 + architecture 环境确认流程（A2 + B3）', () => {
  // prototype 阶段 L1 走 resolvePrototypeAuthor（require channel-manager）——
  // 测试环境注入固定 minimax 渠道（mock 仅本文件生效）
  mock.module('./channel-manager', () => ({
    listChannels: () => [{
      id: 'ch-minimax-uuid', enabled: true, provider: 'minimax',
      models: [{ id: 'MiniMax-M3', name: 'MiniMax-M3', enabled: true }],
    }],
  }))
  /** 构造项目 fixture 并返回 prompt（复用文件级 fixtureRoot——mock 的 getWorkspaceFilesDir 读它） */
  function buildPromptFor(stage: string, files?: Record<string, string>): string | undefined {
    const root = mkdtempSync(join(tmpdir(), 'nanju-prompt-w7-'))
    fixtureRoot = root
    const projectDir = join(root, 'project-pw7')
    mkdirSync(projectDir, { recursive: true })
    for (const [name, content] of Object.entries(files ?? {})) {
      const full = join(projectDir, name)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, content)
    }
    writeFileSync(join(root, '_nanju-projects.json'), JSON.stringify([{
      projectId: 'pw7', name: 'W7 测试项目', mode: 'iterative', status: 'active',
      currentStage: stage, createdAt: '', updatedAt: '', sessionId: 's-pw7', workspaceSlug: root,
    }]))
    return getNanjuRouterPrompt('test-ws', 's-pw7')
  }

  test('prototype 意见收集轮指令含 NANJU_REGRESSION 标记要求（A2 触发点 2）', () => {
    const prompt = buildPromptFor('prototype')
    expect(prompt).toContain('NANJU_REGRESSION')
    expect(prompt).toContain('硬规则未覆盖的表述')
    expect(prompt).toContain('【不要】输出该标记')
  })

  test('architecture L1 指令：环境缺失确认安装流程 + 合并确认 + 未就绪禁止推进', () => {
    const prompt = buildPromptFor('architecture')
    expect(prompt).toContain('【架构确认 + 环境配置环节】')
    expect(prompt).toContain('projectEnv: missing:')
    expect(prompt).toContain('确认安装')
    expect(prompt).toContain('用户级标准安装目录')
    expect(prompt).toContain('合并确认')
    expect(prompt).toContain('【不要】输出推进标记')
  })

  test('M7 安装前预校验：architecture.md 清单含 typo 组件 → prompt 注入「预校验未通过」+ 禁止进入安装确认', () => {
    const prompt = buildPromptFor('architecture', {
      '03_ARCHITECTURE/architecture.md':
        '# 架构文档（M7 预校验用例，内容补齐最低体积要求）\n\nprojectCategory: desktop-app\n\n## 技术选型\n\nTauri 桌面程序两层架构，UI 层与系统层分离。\n\n## 环境配置\n\n| 组件 | 版本 | 用途 |\n| --- | --- | --- |\n| rustcc | 1.75 | 编译 |\n| node | 20 | 前端 |\n\nprojectEnv: missing: rustcc\n',
    })
    expect(prompt).toContain('主进程环境清单预校验【未通过】')
    expect(prompt).toContain('rustcc')
    expect(prompt).toContain('【不得】向用户确认安装')
  })

  test('M7 安装前预校验：清单合法 → prompt 注入「预校验通过」', () => {
    const prompt = buildPromptFor('architecture', {
      '03_ARCHITECTURE/architecture.md':
        '# 架构文档（M7 预校验用例，内容补齐最低体积要求）\n\nprojectCategory: desktop-app\n\n## 技术选型\n\nTauri 桌面程序两层架构，UI 层与系统层分离。\n\n## 环境配置\n\n| 组件 | 版本 | 用途 |\n| --- | --- | --- |\n| rustc | 1.75 | 编译 |\n| node | 20 | 前端 |\n\nprojectEnv: missing: rustc\n',
    })
    expect(prompt).toContain('主进程环境清单预校验通过')
    // 首轮无产出文档时无预校验注入（buildPromptFor('architecture') 不带 files 场景已由上一用例覆盖）
  })
})

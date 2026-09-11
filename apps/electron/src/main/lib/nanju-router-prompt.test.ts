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
// 返工 F2-8：deriveBlockedEventCategory 联合断言需加载 nanju-clarify-proxy-tool，
// 其传递链静态 import channel-manager（顶层 import electron）——先 mock 再加载
mock.module('electron', () => ({
  app: { isPackaged: true, getPath: () => '/tmp/proma-rp-test', getName: () => 'proma', getVersion: () => '0.0.0-test' },
  BrowserWindow: class {},
  dialog: {}, clipboard: {}, nativeImage: { createFromPath: () => ({}) }, nativeTheme: {},
  powerMonitor: {}, powerSaveBlocker: {}, screen: {}, shell: {},
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (v: string) => Buffer.from(v),
    decryptString: (v: Buffer) => v.toString('utf-8'),
  },
  ipcMain: { handle() {}, removeHandler() {} },
  webContents: { send() {} },
}))
mock.module('./channel-manager', () => ({
  listChannels: () => [{
    id: 'ch-minimax-uuid', enabled: true, provider: 'minimax',
    models: [{ id: 'MiniMax-M3', name: 'MiniMax-M3', enabled: true }],
  }],
  getChannelById: () => null,
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

describe('testing 阶段 L2 委派指令（P1 Sprint B：GWT 场景生成；W13 作者换 glm-5.3-flash）', () => {
  const glmAuthor = { channel: 'glm-zhipu', model: 'glm-5.3-flash' }

  test('包含 steps.json 机器可执行 schema 规范（op 白名单不含 eval + 双文件契约 + 透明 skip）', () => {
    const phase = getPhaseNode('quick', 'testing')!
    const task = buildL2TaskWithAC(phase, glmAuthor, 'PRD 摘要', ['/tmp/prd.md'], '/tmp/project')
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
    const task = buildL2TaskWithAC(phase, glmAuthor, 'PRD 摘要', ['/tmp/prd.md'], '/tmp/project')
    expect(task).toContain('前序必读：PRD 用户故事清单')
    expect(task).toContain('GWT 验收场景生成、步骤映射、AC 审计')
  })

  test('W13：testing 作者（glm）与覆盖后的 AC 攻防满足家族多样性断言（防御者=minimax 覆盖，不抛错）', () => {
    for (const mode of ['quick', 'iterative'] as const) {
      const phase = getPhaseNode(mode, 'testing')!
      expect(() => buildL2TaskWithAC(phase, glmAuthor, 'PRD 摘要', [], '/tmp/project')).not.toThrow()
    }
  })

  test('W13 反例：glm 作者 + 预设防御者（glm 系）必抛错——acDefenderRuntime 不能回退到 glm 系端点', () => {
    const phase = getPhaseNode('quick', 'testing')!
    expect(() => buildL2TaskWithAC(
      phase,
      glmAuthor,
      'PRD 摘要',
      [],
      '/tmp/project',
      undefined,
      { channel: 'glm-zhipu', model: 'glm-5.3-flash' },
    )).toThrow('防御者渠道')
  })

  test('W13：acDefenderRuntime 运行时解析值优先——UUID 渠道写入攻防指令且家族断言通过（minimax UUID 与字面渠道异族）', () => {
    const phase = getPhaseNode('quick', 'testing')!
    const task = buildL2TaskWithAC(
      phase,
      glmAuthor,
      'PRD 摘要',
      [],
      '/tmp/project',
      undefined,
      { channel: 'ad74ac74-aaaa-bbbb-cccc-dddddddddddd', model: 'MiniMax-M3' },
    )
    expect(task).toContain('channel=ad74ac74-aaaa-bbbb-cccc-dddddddddddd, model=MiniMax-M3')
    expect(task).toContain('防御者')
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
    // W12 措辞收敛：场景产出推进不等人；交付验收（GWT-pass 后）是另一个独立确认点
    expect(prompt).toContain('不等待用户确认')
    expect(prompt).toContain('不要以「核实/澄清」')
    expect(prompt).toContain('<!-- PHASE_ADVANCE: testing -->')
  })

  test('W13：testing L1 委派指令指向 glm-zhipu/glm-5.3-flash；AC 防御者=minimax 家族（字面标记或同 worker 有 electron mock 时解析出的 UUID 渠道；家族断言两部均通过）', () => {
    const prompt = buildPrompt('testing')
    // 作者委派参数
    expect(prompt).toContain('channelId: glm-zhipu')
    expect(prompt).toContain('modelId: glm-5.3-flash')
    // L2 任务内 AC 防御者：minimax 家族（字面标记 = 测试环境降级；ch-minimax-uuid = 本文件
    // channel-manager mock 注入且同 worker 有 electron mock 时的运行时解析值）
    expect(prompt).toMatch(/channel=(minimax|ch-minimax-uuid), model=MiniMax-M3/)
    // 攻者仍为 deepseek 系预设
    expect(prompt).toContain('channel=deepseek, model=deepseek-v4-flash')
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
    // 返工 F2-8：nanju-clarify-proxy-tool 传递链（agent-model-selection）静态 import
    // getChannelById——本 mock 是文件内最晚注册的 channel-manager mock，必须带全导出面
    getChannelById: () => null,
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

// ═══════════════ W12（v0.17.74）：coding 轻过渡收口 + testing 三态指令（交付验收后置） ═══════════════

describe('W12：coding L1 轻过渡收口（故事覆盖交还 GWT 机器裁判）', () => {
  /** 构造 fixture 并返回 prompt（复用文件级 fixtureRoot；coding/testing 不经 channel-manager 解析） */
  function buildPromptForW12(stage: string, files?: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'nanju-prompt-w12-'))
    fixtureRoot = root
    const projectDir = join(root, 'project-pw12')
    mkdirSync(projectDir, { recursive: true })
    for (const [name, content] of Object.entries(files ?? {})) {
      const full = join(projectDir, name)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, content)
    }
    writeFileSync(join(root, '_nanju-projects.json'), JSON.stringify([{
      projectId: 'pw12', name: 'W12 测试项目', mode: 'iterative', status: 'active',
      currentStage: stage, createdAt: '', updatedAt: '', sessionId: 's-pw12', workspaceSlug: root,
    }]))
    const prompt = getNanjuRouterPrompt('test-ws', 's-pw12')
    expect(prompt).toBeTruthy()
    return prompt as string
  }

  afterEach(() => {
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
    fixtureRoot = ''
  })

  test('coding 收口是轻过渡确认：预览确认 → 推进 testing 触发自动测试，故事完整性由自动测试判定', () => {
    const prompt = buildPromptForW12('coding')
    // 轻过渡话术（工单 §2.1 原文）
    expect(prompt).toContain('应用已生成（右侧预览）')
    expect(prompt).toContain('确认无误我将启动自动测试（GWT 场景验收）')
    expect(prompt).toContain('用户故事的完整性由自动测试判定，无需人工核对')
    expect(prompt).toContain('回复确认即开始测试')
  })

  test('coding 收口不再让用户背书故事实现：旧「应用验证」勾选收口与「全部通过，交付」选项删除', () => {
    const prompt = buildPromptForW12('coding')
    expect(prompt).not.toContain('header「应用验证」')
    expect(prompt).not.toContain('全部通过，交付')
    // W12 语义标注存在（指令自带设计理由，防回退）
    expect(prompt).toContain('不再让用户逐条背书故事实现')
  })

  test('coding 点选纠错入口与意见收集轮保留（真实意见通道不动）', () => {
    const prompt = buildPromptForW12('coding')
    expect(prompt).toContain('【点选纠错】')
    expect(prompt).toContain('【意见收集轮】')
    expect(prompt).toContain('批量修改清单')
    // 确认后仍走第 5 步标准收口（PHASE_ADVANCE: testing）
    expect(prompt).toContain('<!-- PHASE_ADVANCE: testing -->')
  })

  test('testing 三态指令：产出果断收口 / pass 后交付验收询问 / fail 回炉分流并存', () => {
    const prompt = buildPromptForW12('testing', {
      '06_TESTS/features/index.feature': 'Feature: US-01 添加读书笔记\n  Scenario: US-01 成功添加\n    Given 用户在页面\n',
      '06_TESTS/features/us-01.feature': 'Feature: US-01 添加读书笔记\n  Scenario: US-01 成功添加\n    Given 用户在页面\n',
      '06_TESTS/features/us-01.steps.json': '{"feature":"us-01","scenario":"US-01 成功添加","skip":false,"skipReason":null,"steps":[{"kind":"given","text":"用户在页面","op":{"type":"assert-visible","selector":"data-ai-id=view-note-list"}}]}',
    })
    // 态一：场景产出后果断收口（机器判定推进触发 GWT，无用户确认）
    expect(prompt).toContain('【果断收口】双文件核验通过')
    expect(prompt).toContain('推进到自身 = 触发 Harness 自动执行 GWT 验收测试')
    // 态二：GWT-pass 后的交付验收（W12 新交互点：满意交付 / 需要调整）
    expect(prompt).toContain('交付验收')
    expect(prompt).toContain('应用已完成并通过自动测试，可以交付使用。你用过了吗？')
    expect(prompt).toContain('满意交付')
    expect(prompt).toContain('需要调整')
    expect(prompt).toContain('<!-- PHASE_ADVANCE: delivered -->')
    // 用户要调整 → 意见收集回炉修复 → testing 重跑（回炉 ≤2 既有）
    expect(prompt).toContain('<!-- PHASE_ADVANCE: testing --> 重跑自动测试')
    expect(prompt).toContain('回炉修复与重映射合计 ≤2 次')
    // 态三：fail 分流既有指令保留（行为/映射/覆盖三类）
    expect(prompt).toContain('行为类失败')
    expect(prompt).toContain('映射类失败')
    expect(prompt).toContain('覆盖类失败')
    // 旧「全部通过：项目自动交付」表述删除（自动交付已后置为用户验收）
    expect(prompt).not.toContain('项目自动交付')
  })
})

// ═══════════════ v2.4（自动补完需求）：六确认 header 前缀 + L1 协议段 + AC 攻击者模板 ═══════════════
// channel-manager mock：prototype 阶段 getNanjuRouterPrompt 会运行时 require 解析
// MiniMax 作者渠道（resolvePrototypeAuthor），测试环境无 electron——mock listChannels
// 返回可解析的 minimax 渠道（工厂惰性调用，makeChannel 函数声明提升后可用）。
mock.module('./channel-manager', () => ({
  listChannels: () => [makeChannel()],
  getChannelById: () => null,
}))

describe('v2.4：六确认话术 header「确认·」前缀改造（Defender #26：漏改则横幅被 deny）', () => {
  /** v2.4 fixture：支持 mode 与 project 字段覆写（autoClarify 等） */
  function buildPromptForV24(
    stage: string,
    files: Record<string, string> | undefined,
    projectOverrides: Record<string, unknown>,
  ): string {
    const root = mkdtempSync(join(tmpdir(), 'nanju-prompt-v24-'))
    fixtureRoot = root
    const projectDir = join(root, 'project-pv24')
    mkdirSync(projectDir, { recursive: true })
    for (const [name, content] of Object.entries(files ?? {})) {
      const full = join(projectDir, name)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, content)
    }
    writeFileSync(join(root, '_nanju-projects.json'), JSON.stringify([{
      projectId: 'pv24', name: 'v2.4 测试项目', mode: 'quick', status: 'active',
      currentStage: stage, createdAt: '', updatedAt: '', sessionId: 's-pv24', workspaceSlug: root,
      ...projectOverrides,
    }]))
    const prompt = getNanjuRouterPrompt(fixtureRoot, 's-pv24')
    expect(prompt).toBeTruthy()
    return prompt as string
  }

  test('requirements（PRD 等）通用收口补 header 指令：header「确认·{阶段标题}」', () => {
    const prompt = buildPromptForV24('requirements', undefined, {})
    expect(prompt).toContain('header「确认·')
    // auto 关闭项目行为零变化：仅文案多一个前缀词（§10）
    expect(prompt).toContain('AskUserQuestion')
  })

  test('prototype 收口 header「确认·原型交互验证」；点选五项加「设计·快速修改」header', () => {
    const prompt = buildPromptForV24('prototype', {
      '01_PRD/prd.md': '# PRD\n\n## 用户故事\n\n- US-01 添加笔记\n',
    }, {})
    expect(prompt).toContain('header「确认·原型交互验证」')
    expect(prompt).toContain('header「设计·快速修改」')
    expect(prompt).not.toContain('header「原型交互验证」')
  })

  test('architecture 环境安装与合并确认 header 均带「确认·」前缀', () => {
    const prompt = buildPromptForV24('architecture', {
      '03_ARCHITECTURE/architecture.md':
        '# 架构文档（v2.4 用例）\n\nprojectCategory: web-fullstack\n\n## 环境配置\n\n| 组件 | 版本 | 用途 |\n| --- | --- | --- |\n| node | 20 | 前端 |\n\nprojectEnv: ready\n',
    }, { mode: 'iterative' })
    expect(prompt).toContain('header「确认·安装缺失组件」')
    expect(prompt).toContain('header「确认·架构与环境配置」')
    // 旧形态（无前缀 header）反断言
    expect(prompt).not.toContain('AskUserQuestion「确认架构与环境配置？」')
  })

  test('coding 轻过渡 header「确认·预览确认」；点选五项加「设计·快速修改」header', () => {
    const prompt = buildPromptForV24('coding', undefined, {})
    expect(prompt).toContain('header「确认·预览确认」')
    expect(prompt).toContain('header「设计·快速修改」')
    expect(prompt).not.toContain('header「预览确认」')
  })

  test('testing 交付验收问句 header「确认·满意交付」（与 gwt-runner 双话术源一致）', () => {
    const prompt = buildPromptForV24('testing', {
      '06_TESTS/features/index.feature': 'Feature: US-01\n  Scenario: US-01 成功\n    Given 用户在页面\n',
      '06_TESTS/features/us-01.feature': 'Feature: US-01\n  Scenario: US-01 成功\n    Given 用户在页面\n',
      '06_TESTS/features/us-01.steps.json': '{}',
    }, {})
    expect(prompt).toContain('header「确认·满意交付」')
  })
})

describe('v2.4：L1 自动补完协议段（auto 开启时注入，D7 §6 终版五条）', () => {
  function buildAutoPrompt(autoClarify: Record<string, unknown> | undefined): string {
    const root = mkdtempSync(join(tmpdir(), 'nanju-prompt-v24a-'))
    fixtureRoot = root
    const projectDir = join(root, 'project-pv24a')
    mkdirSync(join(projectDir, '01_PRD'), { recursive: true })
    writeFileSync(join(projectDir, '01_PRD', 'prd.md'), '# PRD\n')
    writeFileSync(join(root, '_nanju-projects.json'), JSON.stringify([{
      projectId: 'pv24a', name: '协议段项目', mode: 'quick', status: 'active',
      currentStage: 'prototype', createdAt: '', updatedAt: '', sessionId: 's-pv24a', workspaceSlug: root,
      ...(autoClarify ? { autoClarify } : {}),
    }]))
    const prompt = getNanjuRouterPrompt(fixtureRoot, 's-pv24a')
    expect(prompt).toBeTruthy()
    return prompt as string
  }

  test('auto on（quick + enabled:true）→ 注入协议段：代理调用/fallback 转述/自问规则/采纳标记/header 规则', () => {
    const prompt = buildAutoPrompt({ enabled: true })
    // 第 1 条：子会话澄清 → nanju_clarify_proxy；fallback:'human'（含 non-clarify-category）→ 转述问真人
    expect(prompt).toContain('nanju_clarify_proxy(delegationId, blockedEventIds)')
    expect(prompt).toContain("fallback:'human'")
    expect(prompt).toContain('non-clarify-category')
    // 设计偏好转述用「设计·」，其余用「转述·」
    expect(prompt).toContain('「设计·」')
    expect(prompt).toContain('「转述·」')
    // 第 2 条：自问 questions 规则（≤200 字/题，≤5 题）
    expect(prompt).toContain('nanju_clarify_proxy(questions=[{id,question,options?}])')
    expect(prompt).toContain('≤200 字')
    expect(prompt).toContain('≤5 题')
    // 第 3 条：答案采纳报告卡片 + 产物标记
    expect(prompt).toContain('<!-- auto-clarify:qid,channel,ts -->')
    // 第 5 条：确认类 header 必须以「确认」开头
    expect(prompt).toContain('「确认」开头')
  })

  test('auto off（字段缺失 / enabled:false）→ 协议段不注入（行为零变化）', () => {
    for (const autoClarify of [undefined, { enabled: false }]) {
      const prompt = buildAutoPrompt(autoClarify)
      expect(prompt).not.toContain('nanju_clarify_proxy')
      expect(prompt).not.toContain('auto-clarify 协议')
    }
  })

  test('iterative + enabled:true（升级残留非法态防御）→ 协议段不注入（仅快消型）', () => {
    const root = mkdtempSync(join(tmpdir(), 'nanju-prompt-v24i-'))
    fixtureRoot = root
    const projectDir = join(root, 'project-pv24i')
    mkdirSync(join(projectDir, '01_PRD'), { recursive: true })
    writeFileSync(join(projectDir, '01_PRD', 'prd.md'), '# PRD\n')
    writeFileSync(join(root, '_nanju-projects.json'), JSON.stringify([{
      projectId: 'pv24i', name: '升级项目', mode: 'iterative', status: 'active',
      currentStage: 'prototype', createdAt: '', updatedAt: '', sessionId: 's-pv24i', workspaceSlug: root,
      autoClarify: { enabled: true },
    }]))
    const prompt = getNanjuRouterPrompt(fixtureRoot, 's-pv24i')
    expect(prompt).toBeTruthy()
    expect(prompt).not.toContain('nanju_clarify_proxy')
  })
})

describe('v2.4：AC 攻击者模板增补（代答清单披露 + 同族加倍攻击）', () => {
  // 与既有 AC 测试同构（:85）：prototype + minimax 作者（家族多样性断言可通过；
  // AC 增补注入与阶段无关，仅验证 autoClarifyEnabled 开关）
  const authorUuid = 'ad74ac74-aaaa-bbbb-cccc-dddddddddddd'
  const minimaxAuthor = { channel: authorUuid, model: 'MiniMax-M3' }

  test('autoClarifyEnabled=true → L2 攻击者指令含代答清单披露与同族加倍攻击条款', () => {
    const phase = getPhaseNode('quick', 'prototype')!
    const task = buildL2TaskWithAC(
      phase, minimaxAuthor, 'PRD 摘要', ['/tmp/prd.md'], '/tmp/project',
      null, null, true,
    )
    expect(task).toContain('代答清单披露')
    expect(task).toContain('auto-clarify:')
    expect(task).toContain('同族加倍攻击')
    expect(task).toContain('diversityDegraded')
  })

  test('autoClarifyEnabled 缺省/false → 不注入（既有 AC 指令零变化）', () => {
    const phase = getPhaseNode('quick', 'prototype')!
    for (const flag of [undefined, false]) {
      const task = buildL2TaskWithAC(
        phase, minimaxAuthor, 'PRD 摘要', [], '/tmp/project',
        null, null, flag,
      )
      expect(task).not.toContain('代答清单披露')
      expect(task).not.toContain('同族加倍攻击')
    }
  })
})

// ═══════════════ v2.4 返工（DeepSeek 工程审查 F2-6/F2-8） ═══════════════

describe('返工 F2-6（Defender #16）：「跳过」两处口径统一——跳过是确认形式之一，非直接推进', () => {
  function buildRequirementsPrompt(): string {
    const root = mkdtempSync(join(tmpdir(), 'nanju-prompt-rw16-'))
    fixtureRoot = root
    const projectDir = join(root, 'project-rw16')
    mkdirSync(join(projectDir, '01_PRD'), { recursive: true })
    writeFileSync(join(projectDir, '01_PRD', 'prd.md'), '# PRD\n')
    writeFileSync(join(root, '_nanju-projects.json'), JSON.stringify([{
      projectId: 'rw16', name: '跳过口径项目', mode: 'quick', status: 'active',
      currentStage: 'requirements', createdAt: '', updatedAt: '', sessionId: 's-rw16', workspaceSlug: root,
    }]))
    const prompt = getNanjuRouterPrompt(fixtureRoot, 's-rw16')
    expect(prompt).toBeTruthy()
    return prompt as string
  }

  test('「用户说跳过」改写：视为确认形式，经确认通道授权推进（与词表口径一致）', () => {
    const prompt = buildRequirementsPrompt()
    // 新口径：跳过 = 确认形式之一，走 I1 授权推进
    expect(prompt).toContain('视为对当前阶段的确认')
    expect(prompt).toContain('确认词表')
    // 反断言：旧矛盾措辞（「直接推进到下一阶段」）不再存在
    expect(prompt).not.toContain('直接推进到下一阶段')
  })

  test('禁止条目同步改写：禁止的是「未经确认直接推进」，与跳过=确认不再矛盾', () => {
    const prompt = buildRequirementsPrompt()
    expect(prompt).not.toContain('- 跳过用户确认直接推进')
    expect(prompt).toContain('未经用户确认')
  })
})

describe('返工 F2-8：L2 任务模板携带 phase.role 显式标记（类别派生唯一权威信号）', () => {
  // 与既有 AC 测试同构：minimax 作者（家族断言可通过）
  const authorUuid = 'ad74ac74-aaaa-bbbb-cccc-dddddddddddd'
  const minimaxAuthor = { channel: authorUuid, model: 'MiniMax-M3' }
  type MarkerCase = { mode: 'quick' | 'iterative'; stage: import('./nanju-router').PhaseId; role: string }
  type DeriveCase = { mode: 'quick' | 'iterative'; stage: import('./nanju-router').PhaseId; expected: import('./nanju-clarify-proxy-tool').NanjuClarifyCategory }

  /** 全部六角色 phase（iterative 全链 + quick 归并）逐一验证标记存在且格式匹配 B 域正则 */
  test('六个 phase 的 L2 任务均含行首 phase.role: <role> 标记（PHASE_ROLE_MARKER_RE 可解析）', () => {
    const { PHASE_ROLE_MARKER_RE } = await_importProxyTool()
    const cases: MarkerCase[] = [
      { mode: 'iterative', stage: 'requirements', role: 'requirement-analyst' },
      { mode: 'iterative', stage: 'prototype', role: 'ux-advisor' },
      { mode: 'iterative', stage: 'architecture', role: 'architect' },
      { mode: 'iterative', stage: 'planning', role: 'engineering-manager' },
      { mode: 'iterative', stage: 'coding', role: 'fullstack-developer' },
      { mode: 'iterative', stage: 'testing', role: 'test-engineer' },
    ]
    for (const { mode, stage, role } of cases) {
      const phase = getPhaseNode(mode, stage)!
      const task = buildL2TaskWithAC(phase, minimaxAuthor, 'PRD 摘要', [], '/tmp/project')
      const matches = Array.from(task.matchAll(PHASE_ROLE_MARKER_RE)).map((m) => m[1])
      expect(matches).toContain(role)
    }
  })

  test('生产者-消费者闭环：模板喂 deriveBlockedEventCategory → 六角色类别正确（fail-closed 不退化）', () => {
    const { deriveBlockedEventCategory } = await_importProxyTool()
    const cases: DeriveCase[] = [
      { mode: 'iterative', stage: 'requirements', expected: 'requirement-clarify' },
      { mode: 'iterative', stage: 'architecture', expected: 'requirement-clarify' },
      { mode: 'iterative', stage: 'prototype', expected: 'design-preference' },
      { mode: 'iterative', stage: 'planning', expected: 'other' },
      { mode: 'iterative', stage: 'coding', expected: 'other' },
      { mode: 'iterative', stage: 'testing', expected: 'other' },
    ]
    for (const { mode, stage, expected } of cases) {
      const phase = getPhaseNode(mode, stage)!
      const task = buildL2TaskWithAC(phase, minimaxAuthor, 'PRD 摘要', [], '/tmp/project')
      expect(deriveBlockedEventCategory(task)).toBe(expected)
    }
  })
})

/** B 域类别门契约的运行时导入（避免顶层静态依赖加重加载链；本文件已 mock electron） */
function await_importProxyTool(): typeof import('./nanju-clarify-proxy-tool') {
  const mod = require('./nanju-clarify-proxy-tool') as typeof import('./nanju-clarify-proxy-tool')
  return mod
}

// ═══════════════ 架构师阶段两问题（dev 反馈 2026-09-11 22:04）：quick 工程模板参考补齐 ═══════════════

describe('架构师阶段：quick 变体同样必读工程模板（与 iterative 前移契约对齐）', () => {
  const dsAuthor = { channel: 'deepseek', model: 'deepseek-v4' }

  test('quick architecture L2 任务含「品类终判前 Read 00_ENGINEERING_TEMPLATE/template.md」指令', () => {
    const phase = getPhaseNode('quick', 'architecture')!
    const task = buildL2TaskWithAC(phase, dsAuthor, 'PRD 摘要', [], '/tmp/project')
    expect(task).toContain('00_ENGINEERING_TEMPLATE/template.md')
    expect(task).toContain('初判')
    // 模板缺失的降级容忍（与 iterative 同语义：无文件时按品类自行降级判定）
    expect(task).toContain('降级')
  })

  test('iterative architecture L2 任务仍含既有模板前移契约（回归锁定）', () => {
    const phase = getPhaseNode('iterative', 'architecture')!
    const task = buildL2TaskWithAC(phase, dsAuthor, 'PRD 摘要', [], '/tmp/project')
    expect(task).toContain('品类终判前必读工程模板')
    expect(task).toContain('00_ENGINEERING_TEMPLATE/template.md')
  })
})

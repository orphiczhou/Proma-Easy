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

const { buildL2TaskWithAC, resolveMinimaxM3Channel, resolveMinimaxM3Actor, resolveVisualValidatorSlot, resolvePhaseDelegationSlots, validateVisualValidatorDelegation, isVisualValidatorEndpointTarget, applyConfigAutofix, getNanjuRouterPrompt } = await import('./nanju-router-prompt')
const { getPhaseNode, resolveACActors } = await import('./nanju-router')
const { reloadNanjuModelConfig } = await import('./nanju-model-config')

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

  test('prototype 阶段 未配独立视觉端点 → 独立视觉裁决段为清晰 blocked，不退回作者端点冒充', () => {
    const phase = getPhaseNode('quick', 'prototype')!
    // 不传 visualValidator（默认未配 visualReviewer）→ 必须 blocked，禁止同端点自证
    const task = buildL2TaskWithAC(phase, minimaxAuthor, 'PRD 摘要', [], '/tmp/project')

    expect(task).toContain('独立视觉裁决')
    expect(task).toContain('视觉裁决 unavailable')
    expect(task).toContain('禁止用作者自身或同端点模型冒充')
    // 关键回归：不再渲染以作者端点为视觉验证者的 delegate_agent 指令
    expect(task).not.toContain('创建视觉验证者')
    expect(task).not.toContain('channel=' + authorUuid + ', model=MiniMax-M3) 创建视觉验证者')
  })

  test('prototype 阶段 视觉验证者 resolved → inline 独立端点（只看 PRD 用户故事 + 最新截图，red 回修复循环）', () => {
    const phase = getPhaseNode('quick', 'prototype')!
    const task = buildL2TaskWithAC(phase, minimaxAuthor, 'PRD 摘要', [], '/tmp/project', null, null, undefined, undefined,
      { status: 'resolved', channelId: 'vision-ch', modelId: 'vision-model' })

    expect(task).toContain('独立视觉裁决')
    expect(task).toContain('用 delegate_agent(inline:true, channel=vision-ch, model=vision-model, title=「独立视觉裁决」) 创建视觉验证者')
    // R1(a)：title 稳定锚点必须写进指令（gate 无 slot 时的识别依据）
    expect(task).toContain('title 必须逐字写作「独立视觉裁决」')
    expect(task).toContain('PRD 用户故事清单 + 最新原型截图')
    expect(task).toContain('不允许参考你的自述')
    expect(task).toContain('回到「截图渲染自检循环」')
  })

  test('prototype 阶段按模式取预设攻防：quick=light（flash 攻/5.3-flash 防）', () => {
    const phase = getPhaseNode('quick', 'prototype')!
    const task = buildL2TaskWithAC(phase, minimaxAuthor, '无（这是需求阶段）', [], '/tmp/project')

    expect(task).toContain('channel=deepseek, model=deepseek-flash')
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

  test('coding 包含架构驱动交付、目录边界与旧静态入口兼容', () => {
    const phase = getPhaseNode('quick', 'coding')!
    const task = buildL2TaskWithAC(phase, dsAuthor, 'PRD 摘要', [], '/tmp/project')

    expect(task).toContain('按engineering.json的artifacts清单')
    expect(task).toContain('不得触碰其他项目')
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

  test('coding 自测依据真实架构与受管工具，缺能力不宣称实测', () => {
    const phase = getPhaseNode('quick', 'coding')!
    const task = buildL2TaskWithAC(phase, dsAuthor, 'PRD 摘要', [], '/tmp/project')

    expect(task).toContain('使用受管浏览器预览工具')
    expect(task).toContain('真实用户故事验证依照架构执行')
    expect(task).toContain('不把人工读代码记为实测通过')
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
    // W22（#14+F2/F3 同步）：白名单升级 v2（五类新 op 入表，仍不含 eval）
    expect(task).toContain('click / fill / press / wait-selector / assert-text / assert-visible / assert-count / check / uncheck / select / hover / scroll / focus。')
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
    // resolved 视觉端点才渲染回炉预算；blocked 时不冒充视觉裁决
    const task = buildL2TaskWithAC(phase, dsAuthor, 'PRD 摘要', [], '/tmp/project', null, null, undefined, undefined,
      { status: 'resolved', channelId: 'vision-ch', modelId: 'vision-model' })
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

  test('W13：testing L1 委派指令携带路由配置的作者/攻防渠道（动态断言——W22 M#6/M#7 模型矩阵演进后不再硬编码）；AC 防御者=minimax 家族', () => {
    const prompt = buildPrompt('testing')
    // 作者委派参数 = 路由配置单一真相源（W22 M#6：testing 作者跨族演进时断言随配置自适应）
    const testingPhase = getPhaseNode('quick', 'testing')!
    expect(prompt).toContain('channelId: ' + testingPhase.channel)
    expect(prompt).toContain('modelId: ' + testingPhase.model)
    // L2 任务内 AC 防御者：minimax 家族（字面标记 = 测试环境降级；ch-minimax-uuid = 本文件
    // channel-manager mock 注入且同 worker 有 electron mock 时的运行时解析值）
    expect(prompt).toMatch(/channel=(minimax|ch-minimax-uuid), model=MiniMax-M3/)
    // 攻者 = 路由解析值（W22 M#7：acAttacker 覆盖随配置演进；不再断言具体家族字面值）
    const actors = resolveACActors(testingPhase)
    expect(prompt).toContain('channel=' + actors.attacker.channel + ', model=' + actors.attacker.model)
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
    expect(quickTask).toContain('架构文档保持精简')
    expect(quickTask).toContain('测试架构')
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

  test('auto on（quick + enabled:true）→ 注入协议段：代理调用/自问规则/采纳 kind 标记（D8 §九同步：auto-degrade 替代 human 转述）', () => {
    const prompt = buildAutoPrompt({ enabled: true })
    // 第 1-2 条：子会话澄清与自问均走 nanju_clarify_proxy
    expect(prompt).toContain('nanju_clarify_proxy(delegationId, blockedEventIds)')
    expect(prompt).toContain('nanju_clarify_proxy(questions=[{id,question,options?}])')
    expect(prompt).toContain('≤200 字')
    expect(prompt).toContain('≤5 题')
    // 第 3 条：采纳卡片 + kind 标记（R7-10：answer|decision）
    expect(prompt).toContain('<!-- auto-clarify:qid,channel,ts,kind:answer|decision -->')
    // 第 4 条：D8 auto-degrade（不再 fallback:'human' 转述）
    expect(prompt).toContain("fallback:'auto-degrade'")
    expect(prompt).toContain('不得转述真人')
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

// ═══════════════ D8（v2.4.1）C 域：自动审核话术分叉 + ac-verdict 契约（§九终版） ═══════════════

describe('D8：L1 话术 auto 分叉（协议段/UX 跳过/轻过渡/交付/auto-degrade）', () => {
  /** v2.4.1 fixture：autoClarify 可控；返回 prompt */
  function buildPromptForD8(stage: string, autoOn: boolean, files?: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'nanju-prompt-d8-'))
    fixtureRoot = root
    const projectDir = join(root, 'project-pd8')
    mkdirSync(join(projectDir, '01_PRD'), { recursive: true })
    for (const [name, content] of Object.entries(files ?? {})) {
      mkdirSync(join(projectDir, name, '..'), { recursive: true })
      writeFileSync(join(projectDir, name), content)
    }
    writeFileSync(join(projectDir, '01_PRD', 'prd.md'), '# PRD\n\n## 用户故事\n\n- US-01 添加笔记\n')
    writeFileSync(join(root, '_nanju-projects.json'), JSON.stringify([{
      projectId: 'pd8', name: 'D8 项目', mode: 'quick', status: 'active',
      currentStage: stage, createdAt: '', updatedAt: '', sessionId: 's-pd8', workspaceSlug: root,
      ...(autoOn ? { autoClarify: { enabled: true, proxyBudget: 20, pendingQuestionIds: [] } } : {}),
    }]))
    const prompt = getNanjuRouterPrompt(fixtureRoot, 's-pd8')
    expect(prompt).toBeTruthy()
    return prompt as string
  }

  test('auto on：协议段含自动审核条款（不询问用户/直接推进标记/系统自动确认/环境安装例外）', () => {
    const prompt = buildPromptForD8('requirements', true)
    expect(prompt).toContain('自动审核')
    expect(prompt).toContain('不询问用户')
    expect(prompt).toContain('直接输出推进标记')
    expect(prompt).toContain('系统自动确认')
    expect(prompt).toContain('环境安装')
    expect(prompt).toContain('确认·安装缺失组件')
    // 通用收口（requirements/planning else 分支）同样分叉：不再请求用户确认
    expect(prompt).not.toContain('请求用户确认')
  })

  test('auto on：auto-degrade 降级契约（登记 pending+继续+skipped 标记+不转述真人）', () => {
    const prompt = buildPromptForD8('requirements', true)
    expect(prompt).toContain("fallback:'auto-degrade'")
    expect(prompt).toContain('pendingQuestionIds')
    expect(prompt).toContain('<!-- auto-clarify:skipped,reason,ts -->')
    expect(prompt).toContain('不得转述真人')
    // auto on 协议段不再指导 fallback:'human' 转述（B 域已改降级返回）
    expect(prompt).not.toContain("fallback:'human'（含 non-clarify-category")
  })

  test('auto on：auto-degrade 解除动作（§十 F1-2：保守自答回注解除 / 无法作答则强停+terminated 标记 / 禁止悬空）', () => {
    const prompt = buildPromptForD8('requirements', true)
    expect(prompt).toContain('answer_delegation_question')
    expect(prompt).toContain('保守自判')
    expect(prompt).toContain('stop_delegation')
    expect(prompt).toContain('<!-- auto-clarify:skipped,terminated,ts -->')
    expect(prompt).toContain('禁止放任 blocked 悬空')
    // off 态不含解除动作契约（D7 无此概念）
    const offPrompt = buildPromptForD8('requirements', false)
    expect(offPrompt).not.toContain('禁止放任 blocked 悬空')
    expect(offPrompt).not.toContain('skipped,terminated')
  })

  test('auto on：溯源 kind 标记（R7-10：kind:answer|decision 区分代答/代决）', () => {
    const prompt = buildPromptForD8('requirements', true)
    expect(prompt).toContain('<!-- auto-clarify:qid,channel,ts,kind:answer|decision -->')
  })

  test('auto on：UX 意见收集轮整段替换（无邀请/收集轮，AC+视觉裁决后直接推进）', () => {
    const prompt = buildPromptForD8('prototype', true)
    expect(prompt).not.toContain('对话式设计迭代')
    expect(prompt).not.toContain('意见收集轮')
    expect(prompt).not.toContain('header「确认·原型交互验证」')
    expect(prompt).toContain('视觉裁决')
    expect(prompt).toContain('<!-- PHASE_ADVANCE: coding -->')
  })

  test('auto off：UX 意见收集轮与收口确认原样保留（回归锁定）', () => {
    const prompt = buildPromptForD8('prototype', false)
    expect(prompt).toContain('对话式设计迭代')
    expect(prompt).toContain('意见收集轮')
    expect(prompt).toContain('header「确认·原型交互验证」')
  })

  test('auto on：coding 轻过渡跳过（无预览确认 AskUser，直接推进 testing）', () => {
    const prompt = buildPromptForD8('coding', true)
    expect(prompt).not.toContain('header「确认·预览确认」')
    expect(prompt).toContain('<!-- PHASE_ADVANCE: testing -->')
    expect(prompt).toContain('自动')
  })

  test('auto on：testing 交付挑战自动交付（GWT-pass 直接 delivered，不发起 AskUser）', () => {
    const prompt = buildPromptForD8('testing', true, {
      '06_TESTS/features/index.feature': 'Feature: US-01\n  Scenario: 成功\n    Given 用户在页面\n',
      '06_TESTS/features/us-01.feature': 'Feature: US-01\n  Scenario: 成功\n    Given 用户在页面\n',
      '06_TESTS/features/us-01.steps.json': '{}',
    })
    expect(prompt).not.toContain('header「确认·满意交付」')
    expect(prompt).toContain('自动交付')
    expect(prompt).toContain('<!-- PHASE_ADVANCE: delivered -->')
    expect(prompt).not.toContain('你用过了吗')
  })

  test('auto off：话术与 v0.17.97 逐字节一致（快照锁定——两阶段全 prompt，路径占位符化 + 环境段机器值剥离）', () => {
    // W24-9：本地环境事实段含机器相关值（os.release/DISPLAY）——快照前剥离整段
    //（协议话术锁定意图不变；环境段正确性由 W24-9 专项断言覆盖，不进字节级快照）
    const stripEnv = (p: string) => p.replace(/## 本地环境事实\n(?:- [^\n]*\n)+\n?/g, '<ENV_FACTS>')
    const normalize = (p: string) => stripEnv(p.split(fixtureRoot).join('<FIXTURE_ROOT>'))
    expect(normalize(buildPromptForD8('requirements', false))).toMatchSnapshot('d8-auto-off-requirements')
    expect(normalize(buildPromptForD8('prototype', false))).toMatchSnapshot('d8-auto-off-prototype')
  })

  test('返工二 F3-2：off 冻结串独立证明——architecture/prototype 关键话术行与 054f0721（v0.17.97）逐字一致', () => {
    // toMatchSnapshot 只固化当前输出，不能独立证明=v0.17.97——从旧提交提取关键行做冻结 toContain 对比
    const { execSync } = require('node:child_process') as typeof import('node:child_process')
    const repoRoot = join(import.meta.dir, '..', '..', '..', '..', '..')
    const v017Source = execSync(
      'git show 054f0721:apps/electron/src/main/lib/nanju-router-prompt.ts',
      { cwd: repoRoot, encoding: 'utf-8' },
    ) as string
    /** 从旧源提取纯字面量行（整行单字符串，无拼接），作为冻结串 */
    const frozen = (marker: string): string => {
      const line = v017Source.split('\n').find((l) => l.includes(marker))
      expect(line).toBeTruthy()
      const m = /^\s*'(.*)',\s*$/.exec(line ?? '')
      expect(m).toBeTruthy()
      return m![1]!
    }
    // prototype off 段关键行（意见收集轮/收口确认/点选五项）
    const protoPrompt = buildPromptForD8('prototype', false)
    for (const marker of [
      '对话式设计迭代 + 交互式确认',
      '意见收集轮】（核心节奏',
      '原型交互验证」，multiSelect',
      '未通过项回到 d 循环修复后重新收口',
      '设计·快速修改」）：',
    ]) {
      expect(protoPrompt).toContain(frozen(marker))
    }
    // architecture off 段关键行（环境安装/合并确认/预校验流程）
    const archPrompt = buildPromptForD8('architecture', false, {
      '03_ARCHITECTURE/architecture.md':
        '# 架构文档（返工二冻结对比）\n\nprojectCategory: web-fullstack\n\n## 环境配置\n\n| 组件 | 版本 | 用途 |\n| --- | --- | --- |\n| node | 20 | 前端 |\n\nprojectEnv: ready\n',
    })
    for (const marker of [
      '架构确认 + 环境配置环节',
      '确认·安装缺失组件',
      '用户选换技术栈',
      '重新确认。',
      '确认·架构与环境配置」）确认架构与环境配置',
    ]) {
      expect(archPrompt).toContain(frozen(marker))
    }
  })
})

describe('D8：quick architecture ac-verdict 载体契约（§九 A1′/R7-05）', () => {
  const authorUuid = 'ad74ac74-aaaa-bbbb-cccc-dddddddddddd'
  const minimaxAuthor = { channel: authorUuid, model: 'MiniMax-M3' }

  test('auto on：L2 任务含单攻击者 1 轮审查 + ac-verdict.json 必写指令 + 未写拒绝自动确认警告', () => {
    const phase = getPhaseNode('quick', 'architecture')!
    const task = buildL2TaskWithAC(phase, minimaxAuthor, 'PRD 摘要', [], '/tmp/project', null, null, true)
    expect(task).toContain('03_ARCHITECTURE/ac-verdict.json')
    expect(task).toContain("verdict:'green'|'yellow'|'red'")
    expect(task).toContain('attackerModel')
    expect(task).toContain('单攻击者')
    expect(task).toContain('不循环')
    expect(task).toContain('拒绝自动确认')
  })

  test('auto off：无 ac-verdict 契约（与 v0.17.97 一致，快照锁定；W24-9 环境段机器值剥离）', () => {
    const phase = getPhaseNode('quick', 'architecture')!
    const task = buildL2TaskWithAC(phase, minimaxAuthor, 'PRD 摘要', [], '/tmp/project', null, null, false)
    expect(task).not.toContain('ac-verdict')
    // W24-9：本地环境事实段含机器相关值（os.release/DISPLAY），快照前剥离
    const stripEnv = (p: string) => p.replace(/## 本地环境事实\n(?:- [^\n]*\n)+\n?/g, '<ENV_FACTS>')
    expect(stripEnv(task)).toMatchSnapshot('d8-auto-off-quick-arch-l2')
  })
})

// ═══════════════ W22 C 域：L2 模板 v2（#14+F2/F3）+ R1 回炉路由（#10 后半）+ M-9 开关头部行（#13） ═══════════════

describe('W22 #14：testing L2 模板五类新 op 映射指引（Gherkin→steps 范例）', () => {
  const glmAuthor = { channel: 'glm-zhipu', model: 'glm-5.3-flash' }

  test('check/uncheck：勾选与取消勾选范例 + radio 不可取消约束', () => {
    const phase = getPhaseNode('quick', 'testing')!
    const task = buildL2TaskWithAC(phase, glmAuthor, 'PRD 摘要', [], '/tmp/project')
    expect(task).toContain('{type:"check"')
    expect(task).toContain('{type:"uncheck"')
    expect(task).toContain('radio 不可取消，勿对 radio 用 uncheck')
  })

  test('select：仅限原生 <select> + value 匹配语义 + 自定义下拉改 click 序列', () => {
    const phase = getPhaseNode('quick', 'testing')!
    const task = buildL2TaskWithAC(phase, glmAuthor, 'PRD 摘要', [], '/tmp/project')
    expect(task).toContain('{type:"select"')
    expect(task).toContain('仅限原生 <select>')
    expect(task).toContain('自定义下拉组件禁用 select')
    expect(task).toContain('click 展开按钮 → click 目标选项')
  })

  test('hover/scroll/focus：悬停断言交给后续 op + 滚动不隐式等待 + 聚焦提示交给断言', () => {
    const phase = getPhaseNode('quick', 'testing')!
    const task = buildL2TaskWithAC(phase, glmAuthor, 'PRD 摘要', [], '/tmp/project')
    expect(task).toContain('{type:"hover"')
    expect(task).toContain('悬停后才出现的提示元素')
    expect(task).toContain('{type:"scroll"')
    expect(task).toContain('scroll 本身不隐式等待')
    expect(task).toContain('{type:"focus"')
    expect(task).toContain('聚焦后出现的提示同样交给后续断言 op')
  })

  test('selector 三档指引：data-ai-id 优先 + #id 唯一性校验 + aria-label 属性匹配 + 不规避标注纪律', () => {
    const phase = getPhaseNode('quick', 'testing')!
    const task = buildL2TaskWithAC(phase, glmAuthor, 'PRD 摘要', [], '/tmp/project')
    expect(task).toContain('selector 三档形态（优先级从高到低')
    expect(task).toContain('① data-ai-id=xxx（首选')
    expect(task).toContain('② #my-id')
    expect(task).toContain('不唯一直接判失败，绝不静默取第一个')
    expect(task).toContain('③ [aria-label="提交表单"]')
    expect(task).toContain('不得用 ②③ 规避 data-ai-id 标注纪律')
  })

  test('schemaVersion:2 声明要求（A1：旧运行器遇新 op 判 schema 失败而非静默 skip）+ 示例 JSON 携带字段', () => {
    const phase = getPhaseNode('quick', 'testing')!
    const task = buildL2TaskWithAC(phase, glmAuthor, 'PRD 摘要', [], '/tmp/project')
    expect(task).toContain('"schemaVersion": 2')
    expect(task).toContain('会被判 schema 失败，不是静默跳过')
    // 示例 JSON 内联字段（模板自带书写示范，JSON.stringify 输出形态）
    expect(task).toContain('"schemaVersion": 2,')
  })
})

describe('W22 R1：testing 行为类失败回炉路由（回原 coding 委派，不新建修复会话）', () => {
  /** testing fixture（复用文件级 fixtureRoot mock） */
  function buildTestingPrompt(): string {
    const root = mkdtempSync(join(tmpdir(), 'nanju-prompt-w22-'))
    fixtureRoot = root
    const projectDir = join(root, 'project-pw22')
    mkdirSync(join(projectDir, '01_PRD'), { recursive: true })
    writeFileSync(join(projectDir, '01_PRD', 'prd.md'), '# PRD\n\n## 用户故事\n\n- US-01 添加笔记\n')
    writeFileSync(join(root, '_nanju-projects.json'), JSON.stringify([{
      projectId: 'pw22', name: 'W22 项目', mode: 'quick', status: 'active',
      currentStage: 'testing', createdAt: '', updatedAt: '', sessionId: 's-pw22', workspaceSlug: root,
    }]))
    const prompt = getNanjuRouterPrompt(fixtureRoot, 's-pw22')
    expect(prompt).toBeTruthy()
    return prompt as string
  }

  afterEach(() => {
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
    fixtureRoot = ''
  })

  test('行为类失败：continue_delegation(<codingDelegationId>) 转交原全栈开发 + 不新建修复会话 + 未带 ID 时渠道=coding 配置', () => {
    const prompt = buildTestingPrompt()
    expect(prompt).toContain('continue_delegation(<codingDelegationId>)')
    expect(prompt).toContain('续接原 coding 委派')
    expect(prompt).toContain('不要新建修复会话')
    expect(prompt).toContain('仅当注入消息未带 ID 时才新建')
    // 渠道话术动态读 coding 阶段配置（quick=coding：glm-zhipu / GLM-5.3；随模型矩阵演进自适应）
    expect(prompt).toContain('glm-zhipu / GLM-5.3')
  })

  test('修复守卫配合话术：代码修复不委派 minimax（M3 不用于代码修复）——行为类与用户调整两分支', () => {
    const prompt = buildTestingPrompt()
    expect(prompt).toContain('【不要】委派 minimax')
    expect(prompt).toContain('M3 不用于代码修复')
    expect(prompt).toContain('不要委派 minimax 做代码修复')
  })

  test('mapping/coverage 回炉仍指「测试工程师」（R1 不改道）', () => {
    const prompt = buildTestingPrompt()
    expect(prompt).toContain('委派「测试工程师」重新映射 steps.json')
    expect(prompt).toContain('按注入消息指引委派「测试工程师」补场景')
  })

  test('修复边界保留：仅改 08_APP/ 不动 06_TESTS/ 与 01_PRD/（既有约束不回退）', () => {
    const prompt = buildTestingPrompt()
    expect(prompt).toContain('修复仅改 08_APP/ 下的代码，不得改 06_TESTS/ 与 01_PRD/')
  })
})

describe('W22 M-9：autoClarify 开关每轮 prompt 头部行（#13 主通道，不强制续接）', () => {
  /** W22 fixture：autoClarify 可控（enabled + lastToggledAt） */
  function buildPromptForW22(autoClarify: Record<string, unknown> | undefined): string {
    const root = mkdtempSync(join(tmpdir(), 'nanju-prompt-w22a-'))
    fixtureRoot = root
    const projectDir = join(root, 'project-pw22a')
    mkdirSync(join(projectDir, '01_PRD'), { recursive: true })
    writeFileSync(join(projectDir, '01_PRD', 'prd.md'), '# PRD\n')
    writeFileSync(join(root, '_nanju-projects.json'), JSON.stringify([{
      projectId: 'pw22a', name: 'M9 项目', mode: 'quick', status: 'active',
      currentStage: 'requirements', createdAt: '', updatedAt: '', sessionId: 's-pw22a', workspaceSlug: root,
      ...(autoClarify ? { autoClarify } : {}),
    }]))
    const prompt = getNanjuRouterPrompt(fixtureRoot, 's-pw22a')
    expect(prompt).toBeTruthy()
    return prompt as string
  }

  afterEach(() => {
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
    fixtureRoot = ''
  })

  test('on 态 + 近期切换：协议段头部行「当前模式：自动审核开启（近期切换…）」', () => {
    const prompt = buildPromptForW22({ enabled: true, lastToggledAt: Date.now() - 5 * 60 * 1000 })
    expect(prompt).toContain('当前模式：自动审核开启（近期切换——本轮起按自动模式处理')
    // 头部行位于协议段标题之前（心智先行）
    expect(prompt.indexOf('当前模式：自动审核开启')).toBeLessThan(prompt.indexOf('### 自动补完需求 + 自动审核'))
  })

  test('on 态 + 无切换记录/切换已久：头部行「当前模式：自动审核开启」无近期尾注', () => {
    const noToggle = buildPromptForW22({ enabled: true })
    expect(noToggle).toContain('当前模式：自动审核开启\n')
    expect(noToggle).not.toContain('近期切换')
    const longAgo = buildPromptForW22({ enabled: true, lastToggledAt: Date.now() - 48 * 60 * 60 * 1000 })
    expect(longAgo).toContain('当前模式：自动审核开启\n')
    expect(longAgo).not.toContain('近期切换')
  })

  test('off 态 + 存在切换记录：头部行「当前模式：自动审核关闭（近期已停用…）」——L1 旧心智更新', () => {
    const prompt = buildPromptForW22({ enabled: false, lastToggledAt: Date.now() - 3 * 60 * 1000 })
    expect(prompt).toContain('当前模式：自动审核关闭（近期已停用——本轮起确认类环节恢复用户参与')
    expect(prompt).not.toContain('nanju_clarify_proxy')
  })

  test('off 态 + 无切换记录（从未开启/老项目）：零注入——v0.17.97 off 行为与快照不破坏', () => {
    const prompt = buildPromptForW22(undefined)
    expect(prompt).not.toContain('当前模式：自动审核')
    const legacyField = buildPromptForW22({ enabled: false })
    expect(legacyField).not.toContain('当前模式：自动审核')
  })

  test('parseAutoClarifyToggledAt：宽容解析 number(ms)/ISO 字符串；无效与缺失 → null', () => {
    const { parseAutoClarifyToggledAt } = require('./nanju-router-prompt') as typeof import('./nanju-router-prompt')
    expect(parseAutoClarifyToggledAt(1770000000000)).toBe(1770000000000)
    expect(parseAutoClarifyToggledAt('2026-09-12T14:00:00.000Z')).toBe(Date.parse('2026-09-12T14:00:00.000Z'))
    expect(parseAutoClarifyToggledAt('not-a-date')).toBeNull()
    expect(parseAutoClarifyToggledAt(undefined)).toBeNull()
    expect(parseAutoClarifyToggledAt(0)).toBeNull()
    expect(parseAutoClarifyToggledAt(-1)).toBeNull()
  })
})


// ═══════════════ W23（§六.3）：配置级 autofix——预检失效端点 → 单槽临时替换 + 遥测 ═══════════════

describe('W23 配置级 autofix（getNanjuRouterPrompt 预检 + model.config-autofix 遥测）', () => {
  /** 全渠道宇宙 mock（deepseek 家族只剩新名 deepseek-flash——厂家改名形态） */
  function mockFullChannels(): void {
    mock.module('./channel-manager', () => ({
      listChannels: () => [
        makeChannel({ id: 'deepseek', name: 'DeepSeek', provider: 'deepseek' as Channel['provider'], models: [
          { id: 'deepseek-flash', name: 'DeepSeek Flash', enabled: true },
          { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', enabled: true },
        ] }),
        makeChannel({ id: 'glm-zhipu', name: '智谱', provider: 'zhipu' as Channel['provider'], models: [
          { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', enabled: true },
          { id: 'GLM-5.3', name: 'GLM 5.3', enabled: true },
        ] }),
        makeChannel(), // minimax UUID 渠道（默认工厂形态，含 MiniMax-M3）
      ],
      getChannelById: () => null,
    }))
  }

  /** 恢复文件级默认 mock（后续调用方不受本 describe 影响） */
  function restoreDefaultChannels(): void {
    mock.module('./channel-manager', () => ({
      listChannels: () => [makeChannel()],
      getChannelById: () => null,
    }))
  }

  /** planning 阶段 iterative 项目 fixture（L1 prompt）；userConfig 指定各层路径 */
  async function buildPlanningPrompt(userLayer: Record<string, unknown> | null): Promise<string> {
    const { reloadNanjuModelConfig } = await import('./nanju-model-config')
    const root = mkdtempSync(join(tmpdir(), 'nanju-autofix-'))
    fixtureRoot = root
    const userPath = join(root, 'user-model-config.json')
    if (userLayer) writeFileSync(userPath, JSON.stringify(userLayer))
    reloadNanjuModelConfig(userLayer
      ? { userConfigPath: userPath, overrideConfigPath: null, builtinConfigPath: null }
      : { userConfigPath: null, overrideConfigPath: null, builtinConfigPath: null })
    const projectDir = join(root, 'project-autofix')
    mkdirSync(join(projectDir, '01_PRD'), { recursive: true })
    writeFileSync(join(projectDir, '01_PRD', 'prd.md'), '# PRD\n## US-01 演示\n内容补齐最低体积。')
    writeFileSync(join(root, '_nanju-projects.json'), JSON.stringify([{
      projectId: 'autofix-demo', name: 'autofix 演示', mode: 'iterative', status: 'active',
      currentStage: 'planning', createdAt: '', updatedAt: '', sessionId: 's-autofix',
    }]))
    const prompt = getNanjuRouterPrompt(root, 's-autofix')
    expect(prompt).toBeTruthy()
    return prompt as string
  }

  afterEach(async () => {
    const { reloadNanjuModelConfig, getConfigGeneration } = await import('./nanju-model-config')
    void getConfigGeneration
    reloadNanjuModelConfig({ userConfigPath: null, overrideConfigPath: null })
    restoreDefaultChannels()
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
    fixtureRoot = ''
  })

  test('改名场景：配置仍指旧名 deepseek-v4-flash → prompt 委派值被临时替换为 deepseek-flash + 遥测载荷（slot/from/to/reason）', async () => {
    mockFullChannels()
    const prompt = await buildPlanningPrompt({ phases: { planning: { channel: 'deepseek', model: 'deepseek-v4-flash' } } })
    // autofix 生效：本次指令的委派端点 = 新名（不落盘）
    expect(prompt).toContain('modelId: deepseek-flash')
    expect(prompt).not.toContain('modelId: deepseek-v4-flash')
    // 遥测：model.config-autofix 载荷含 slot/from/to/reason
    const { readTelemetry } = await import('./nanju-telemetry')
    const events = readTelemetry(fixtureRoot, 'model.config-autofix')
    expect(events.length).toBe(1)
    expect(events[0]!.projectId).toBe('autofix-demo')
    expect(events[0]!.payload).toEqual({
      slot: 'phases.planning.primary',
      from: 'deepseek:deepseek-v4-flash',
      to: 'deepseek:deepseek-flash',
      reason: 'same-channel-rename',
    })
  })

  test('预检失败不阻断：渠道宇宙无 deepseek 家族（无同族替换）→ 降级原值，prompt 正常构建且零遥测', async () => {
    mock.module('./channel-manager', () => ({
      listChannels: () => [
        makeChannel({ id: 'glm-zhipu', name: '智谱', provider: 'zhipu' as Channel['provider'], models: [
          { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', enabled: true },
          { id: 'GLM-5.3', name: 'GLM 5.3', enabled: true },
        ] }),
        makeChannel(),
      ],
      getChannelById: () => null,
    }))
    const prompt = await buildPlanningPrompt({ phases: { planning: { channel: 'deepseek', model: 'deepseek-v4-flash' } } })
    // 同族守卫：跨族替换（glm/minimax）被放弃 → 保持原值（委派将走既有 fallback 链兜底）
    expect(prompt).toContain('modelId: deepseek-v4-flash')
    const { readTelemetry } = await import('./nanju-telemetry')
    expect(readTelemetry(fixtureRoot, 'model.config-autofix')).toEqual([])
  })

  test('端点全部有效：零替换零遥测（默认配置与全渠道宇宙匹配）', async () => {
    mockFullChannels()
    const prompt = await buildPlanningPrompt(null)
    expect(prompt).toContain('modelId: deepseek-flash')
    const { readTelemetry } = await import('./nanju-telemetry')
    expect(readTelemetry(fixtureRoot, 'model.config-autofix')).toEqual([])
  })

  test('buildL2TaskWithAC 新增 acAttackerRuntime 覆盖位（向后兼容：缺省不注入）', () => {
    const phase = getPhaseNode('iterative', 'testing')!
    const withOverride = buildL2TaskWithAC(
      phase, { channel: 'deepseek', model: 'deepseek-flash' }, 'PRD', [], '/tmp/project',
      null, null, false,
      { channel: 'kimi', model: 'k3' },
    )
    expect(withOverride).toContain('channel=kimi, model=k3')
    expect(withOverride).toContain('channel=minimax, model=MiniMax-M3') // 防御者解析值不受影响
    const withoutOverride = buildL2TaskWithAC(
      phase, { channel: 'deepseek', model: 'deepseek-flash' }, 'PRD', [], '/tmp/project',
    )
    expect(withoutOverride).toContain('channel=glm-zhipu, model=glm-5.3-flash') // testing 攻击者预设覆盖
  })
})

test('Given 直接构建工程coding委派 When 不经过L1外层 Then 产出路径仍指向工程交付说明', () => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'nanju-direct-coding-'))
  mkdirSync(join(fixtureRoot, '03_ARCHITECTURE'))
  writeFileSync(join(fixtureRoot, '03_ARCHITECTURE/engineering.json'), '{}')
  const task = buildL2TaskWithAC(getPhaseNode('quick', 'coding')!, { channel: 'deepseek', model: 'deepseek-flash' }, 'fixture', [], fixtureRoot)
  expect(task).toContain('请将产出写入：' + fixtureRoot + '/08_APP/DELIVERY.md')
  expect(task).not.toContain('请将产出写入：' + fixtureRoot + '/08_APP/index.html')
})

// ═══════════════ W-B：模型优先级与 AC 配置实现（B1 红测与既有契约锁定）═══════════════
//
// 验收契约（W-B §任务包）：
// - 显式 prototype 作者配置优先：用户显式设置 phase.prototype.channel≠'minimax' 时，
//   prompt 委派值用 phase.channel/phase.model，不被 resolvePrototypeAuthor 默认 M3 覆盖
// - 默认配置与 resolvePhaseModelConfig 来源一致：FALLBACK_PHASE_MODELS.prototype 与
//   resolvePhaseModelConfig('prototype') 字段深等（layer 3 兜底 = 参数文件解析基底）
// - AC 默认 flash 仅在无显式选择时使用：用户未显式配置 acAttacker/acDefender 时用预设
//   （quick=light=flash；iterative=medium=pro/5.3），显式覆盖时按显式值（不被默认 flash 覆盖）
// - 不可用显式配置清晰处理：用户显式配置不可用端点时 prompt 透传显式值（delegate_agent 层
//   报错），不静默硬换到 family marker 或其他可用端点

describe('W-B B1：显式 prototype 作者配置优先（不被默认 M3 覆盖）', () => {
  /** reload nanju-model-config + 构造 prototype 项目 fixture 并返回 prompt */
  async function buildPrototypePrompt(userLayer: Record<string, unknown> | null): Promise<string> {
    const { reloadNanjuModelConfig } = await import('./nanju-model-config')
    const root = mkdtempSync(join(tmpdir(), 'nanju-wb-'))
    fixtureRoot = root
    const userPath = join(root, 'user-model-config.json')
    if (userLayer) writeFileSync(userPath, JSON.stringify(userLayer))
    reloadNanjuModelConfig(userLayer
      ? { userConfigPath: userPath, overrideConfigPath: null, builtinConfigPath: null }
      : { userConfigPath: null, overrideConfigPath: null, builtinConfigPath: null })
    const projectDir = join(root, 'project-wb')
    mkdirSync(join(projectDir, '01_PRD'), { recursive: true })
    writeFileSync(join(projectDir, '01_PRD', 'prd.md'), '# PRD\n## US-01 演示')
    writeFileSync(join(root, '_nanju-projects.json'), JSON.stringify([{
      projectId: 'wb-demo', name: 'WB 演示', mode: 'iterative', status: 'active',
      currentStage: 'prototype', createdAt: '', updatedAt: '', sessionId: 's-wb-demo',
    }]))
    const prompt = getNanjuRouterPrompt(root, 's-wb-demo')
    expect(prompt).toBeTruthy()
    return prompt as string
  }

  afterEach(async () => {
    const { reloadNanjuModelConfig } = await import('./nanju-model-config')
    reloadNanjuModelConfig({ userConfigPath: null, overrideConfigPath: null })
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
    fixtureRoot = ''
  })

  test('显式配置 channel=kimi model=k3（异族端点不踩中默认 M3）：prompt 委派值用 kimi:k3，不被 MiniMax-M3 覆盖', async () => {
    // 选择 "kimi" 作为 prototype 作者（异族端点，不与默认 minimax/glm/deepseek 任一族重叠）；
    // 修复前会调用 resolvePrototypeAuthor 覆盖为默认 M3 UUID → 失败；
    // 修复后 resolvePrototypeAuthor 不被调用 → prompt 使用显式值。
    // （使用 kimi 而非 glm-zhipu：避免 AC 家族多样性拋错——glm 作者与 medium 预设
    // 防御者 glm-5.3 同族，证拋错亦为有效行为但本测不验证“拋错”，只验证“显式优先”。）
    const prompt = await buildPrototypePrompt({
      phases: { prototype: { channel: 'kimi', model: 'k3' } },
    })
    // 显式配置生效（红测关键断言：修复前会失败）
    expect(prompt).toContain('channelId: kimi')
    expect(prompt).toContain('modelId: k3')
    // 不被默认 M3 覆盖
    expect(prompt).not.toContain('modelId: MiniMax-M3')
    expect(prompt).not.toContain('channelId: ' + makeChannel().id) // 不使用 makeChannel 默认 minimax UUID
  })

  test('默认配置 channel=minimax（family marker）：走 resolvePrototypeAuthor 解析 UUID（回归锁定）', async () => {
    const prompt = await buildPrototypePrompt(null)
    // 默认行为：family marker 触发 resolvePrototypeAuthor（modelId 必为 MiniMax-M3）
    expect(prompt).toMatch(/channelId: [^\n]+\n.*modelId: MiniMax-M3/s)
    // B2：默认未配独立 visualReviewer → 视觉裁决 blocked（不退回作者端点冒充独立裁决）
    expect(prompt).toContain('视觉裁决 unavailable')
  })

  test('显式配置但端点不可用（未配置渠道）：prompt 透传显式值，不静默替换到 family marker 解析', async () => {
    // 显式指向不存在的渠道（resolvePrototypeAuthor 会成功找到 minimax 渠道，
    // 但 fix 后不应触发——作者应使用显式配置）
    const prompt = await buildPrototypePrompt({
      phases: { prototype: { channel: 'nonexistent-channel', model: 'nonexistent-model' } },
    })
    // 显式值透传
    expect(prompt).toContain('channelId: nonexistent-channel')
    expect(prompt).toContain('modelId: nonexistent-model')
    // 不静默硬换到 M3 模型（family marker 解析不应被触发）
    expect(prompt).not.toContain('modelId: MiniMax-M3')
  })

  test('显式配置 minimax 家族（保留 family marker）：仍走 resolvePrototypeAuthor 解析 UUID', async () => {
    const prompt = await buildPrototypePrompt({
      phases: { prototype: { channel: 'minimax', model: 'MiniMax-M3' } },
    })
    // 显式保留 family marker 仍触发解析（modelId 必为 MiniMax-M3）
    expect(prompt).toMatch(/channelId: [^\n]+\n.*modelId: MiniMax-M3/s)
  })
})

describe('W-B B1：默认配置与 resolvePhaseModelConfig 来源一致（层 3 兜底 = 参数文件解析基底）', () => {
  test('FALLBACK_PHASE_MODELS.prototype === resolvePhaseModelConfig("prototype")（两层禁用态；来源同 = FALLBACK_PHASE_MODELS）', async () => {
    const { reloadNanjuModelConfig, resolvePhaseModelConfig, FALLBACK_PHASE_MODELS } = await import('./nanju-model-config')
    reloadNanjuModelConfig({ userConfigPath: null, overrideConfigPath: null, builtinConfigPath: null })
    const resolved = resolvePhaseModelConfig('prototype')
    // 字段逐一比对：source 一致 = 解析基底 = 层 3 兜底常量
    expect(resolved.channel).toBe(FALLBACK_PHASE_MODELS.prototype.channel)
    expect(resolved.model).toBe(FALLBACK_PHASE_MODELS.prototype.model)
    expect(resolved.fallbacks).toEqual(
      (FALLBACK_PHASE_MODELS.prototype.fallbacks ?? []).map((raw) => {
        const idx = raw.indexOf(':')
        return { channelId: raw.slice(0, idx), modelId: raw.slice(idx + 1) }
      }),
    )
    // per-phase AC 覆盖位（prototype 无显式覆盖，与兜底一致）
    expect(resolved.acAttacker).toBeUndefined()
    expect(resolved.acDefender).toBeUndefined()
  })

  test('FALLBACK_PHASE_MODELS 全六阶段 === resolvePhaseModelConfig 全六阶段（端到端一致性锁定）', async () => {
    const { reloadNanjuModelConfig, resolvePhaseModelConfig, FALLBACK_PHASE_MODELS, NANJU_MODEL_PHASE_ORDER } = await import('./nanju-model-config')
    reloadNanjuModelConfig({ userConfigPath: null, overrideConfigPath: null, builtinConfigPath: null })
    for (const phaseId of NANJU_MODEL_PHASE_ORDER) {
      const resolved = resolvePhaseModelConfig(phaseId)
      expect(resolved.channel).toBe(FALLBACK_PHASE_MODELS[phaseId].channel)
      expect(resolved.model).toBe(FALLBACK_PHASE_MODELS[phaseId].model)
      // fallbacks：兜底链解析形态与解析函数一致
      expect(resolved.fallbacks).toEqual(
        (FALLBACK_PHASE_MODELS[phaseId].fallbacks ?? []).map((raw) => {
          const idx = raw.indexOf(':')
          return { channelId: raw.slice(0, idx), modelId: raw.slice(idx + 1) }
        }),
      )
    }
  })
})

describe('W-B B1：AC 默认 flash 仅无显式选择时使用（显式覆盖不被默认 flash 替换）', () => {
  test('用户未显式配置 AC：quick=light 用 flash 预设，iterative=medium 用 pro/5.3 预设', () => {
    // prototype 阶段：quick 与 iterative 都无显式 acAttacker/acDefender 覆盖
    for (const mode of ['quick', 'iterative'] as const) {
      const phase = getPhaseNode(mode, 'prototype')!
      const actors = resolveACActors(phase)
      const expected = mode === 'quick'
        ? { attacker: 'deepseek-flash', defender: 'glm-5.3-flash' } // light preset = flash
        : { attacker: 'deepseek-v4-pro', defender: 'GLM-5.3' }      // medium preset = pro/5.3
      expect(actors.attacker.model).toBe(expected.attacker)
      expect(actors.defender.model).toBe(expected.defender)
    }
  })

  test('用户显式配置 acAttacker=glm-zhipu:deepseek-v4-pro：覆盖 light 预设的 flash（不被默认 flash 替换）', async () => {
    const { reloadNanjuModelConfig } = await import('./nanju-model-config')
    const root = mkdtempSync(join(tmpdir(), 'nanju-wb-ac-'))
    fixtureRoot = root
    const userPath = join(root, 'user-model-config.json')
    // quick 模式默认 light 预设攻击者 = deepseek-flash；显式覆盖为 deepseek-v4-pro
    writeFileSync(userPath, JSON.stringify({
      phases: { prototype: { acAttacker: { channel: 'deepseek', model: 'deepseek-v4-pro' } } },
    }))
    reloadNanjuModelConfig({ userConfigPath: userPath, overrideConfigPath: null, builtinConfigPath: null })
    const phase = getPhaseNode('quick', 'prototype')!
    const actors = resolveACActors(phase)
    expect(actors.attacker.channel).toBe('deepseek')
    expect(actors.attacker.model).toBe('deepseek-v4-pro') // 显式覆盖生效
    // 防御者未显式 → 仍用 light 预设 flash
    expect(actors.defender.model).toBe('glm-5.3-flash')
    // 收尾
    reloadNanjuModelConfig({ userConfigPath: null, overrideConfigPath: null })
  })

  test('buildL2TaskWithAC：显式 acAttacker 透传到 L2 指令，不被默认 flash 替换', () => {
    const phase = getPhaseNode('quick', 'prototype')!
    const glmAuthor = { channel: 'ch-minimax-uuid', model: 'MiniMax-M3' }
    const task = buildL2TaskWithAC(phase, glmAuthor, 'PRD 摘要', [], '/tmp/project')
    // quick 模式默认 light 预设攻击者 = deepseek-flash（无显式 acAttacker）
    expect(task).toContain('channel=deepseek, model=deepseek-flash')
    // 防御者：family marker 'minimax'（PhaseNode 字面值）→ L2 指令中保留字面标记
    // （family marker 实际解析仅在 getNanjuRouterPrompt 路径发生；buildL2TaskWithAC 直接消费 phase）
    // 此处验证 prototype 默认无显式 acDefender → 使用 light 预设 defender = glm-5.3-flash
    expect(task).toContain('channel=glm-zhipu, model=glm-5.3-flash')
  })
})


// ═══════════════ W-B B2：显式内部 slot producer + 独立视觉槽位（capability 或清晰 blocked）══════════════

const { resolveDelegationSlot, detectDelegationSlot } = await import('./nanju-delegate-guard')

describe('W-B B2：slot producer（resolvePhaseDelegationSlots——slot 的唯一权威来源）', () => {
  test('按 config 产出四槽位：author 用解析端点，AC 攻防来自 resolveACActors（非 title 文本猜测）', () => {
    const phase = { ...getPhaseNode('quick', 'prototype')! }
    const slots = resolvePhaseDelegationSlots(phase, {
      authorResolved: { channelId: 'author-uuid', modelId: 'MiniMax-M3' },
    })
    expect(slots.author).toEqual({ channel: 'author-uuid', model: 'MiniMax-M3' })
    // quick=light 预设：flash 攻 / 5.3-flash 防（config 驱动，与 title 无关）
    expect(slots.acAttacker).toEqual({ channel: 'deepseek', model: 'deepseek-flash' })
    expect(slots.acDefender).toEqual({ channel: 'glm-zhipu', model: 'glm-5.3-flash' })
    // 未配 visualReviewer → 清晰 blocked（不是默认 minimax、不是 null 静默跳过）
    expect(slots.visualValidator.status).toBe('blocked')
  })

  test('authorResolved 缺省 → author 槽位回落 phase 字面配置', () => {
    const phase = { ...getPhaseNode('quick', 'prototype')! }
    const slots = resolvePhaseDelegationSlots(phase, { authorResolved: null })
    expect(slots.author).toEqual({ channel: phase.channel, model: phase.model })
  })

  test('显式 visualReviewer 异端点（显式 capability）→ resolved，且与 author 解耦', () => {
    const phase = { ...getPhaseNode('quick', 'prototype')! }
    phase.visualReviewerChannel = 'glm-zhipu'
    phase.visualReviewerModel = 'glm-5.3-vision'
    const slots = resolvePhaseDelegationSlots(phase, {
      authorResolved: { channelId: 'kimi-uuid', modelId: 'k3' },
    })
    expect(slots.visualValidator).toEqual({
      status: 'resolved', channelId: 'glm-zhipu', modelId: 'glm-5.3-vision',
    })
  })
})

describe('W-B B2：resolveVisualValidatorSlot（显式 capability 或清晰 blocked，二者必居其一）', () => {
  test('非 prototype 阶段 → not-applicable', () => {
    const phase = getPhaseNode('quick', 'coding')!
    expect(resolveVisualValidatorSlot(phase, { authorResolved: null }).status).toBe('not-applicable')
  })

  test('未显式配置 → blocked（原因含「未显式配置」，非默认 minimax）', () => {
    const phase = { ...getPhaseNode('quick', 'prototype')! }
    const r = resolveVisualValidatorSlot(phase, { authorResolved: null })
    expect(r.status).toBe('blocked')
    if (r.status === 'blocked') expect(r.reason).toContain('未显式配置')
  })

  test('显式配置但与作者同端点 → blocked（同端点自证）', () => {
    const phase = { ...getPhaseNode('quick', 'prototype')! }
    phase.visualReviewerChannel = 'glm-zhipu'
    phase.visualReviewerModel = 'glm-5.3-vision'
    const author = { channelId: 'glm-zhipu', modelId: 'glm-5.3-vision' }
    const r = resolveVisualValidatorSlot(phase, { authorResolved: author })
    expect(r.status).toBe('blocked')
    if (r.status === 'blocked') expect(r.reason).toContain('同端点')
  })

  test('family marker minimax 解析后与作者同 UUID → blocked（不按模型名猜视觉）', () => {
    const phase = { ...getPhaseNode('quick', 'prototype')! }
    phase.visualReviewerChannel = 'minimax'
    phase.visualReviewerModel = 'MiniMax-M3'
    // minimax 渠道运行时解析（本文件最晚注册的 channel-manager mock）；用实际解析结果
    // 作为作者端点 → 与 visualReviewer family marker 解析结果同 UUID → 同端点自证 blocked
    const actor = resolveMinimaxM3Actor()
    expect(actor).toBeTruthy()
    const r = resolveVisualValidatorSlot(phase, { authorResolved: actor })
    expect(r.status).toBe('blocked')
  })

  test('family marker minimax + 作者端点未知 → blocked（无法证明异端点，不冒充独立能力）', () => {
    const phase = { ...getPhaseNode('quick', 'prototype')! }
    phase.visualReviewerChannel = 'minimax'
    phase.visualReviewerModel = 'MiniMax-M3'
    const r = resolveVisualValidatorSlot(phase, { authorResolved: null })
    expect(r.status).toBe('blocked')
  })

  test('显式异端点 → resolved（视觉能力来自显式声明，非模型名匹配）', () => {
    const phase = { ...getPhaseNode('quick', 'prototype')! }
    phase.visualReviewerChannel = 'glm-zhipu'
    phase.visualReviewerModel = 'glm-5.3-vision'
    const r = resolveVisualValidatorSlot(phase, { authorResolved: { channelId: 'kimi-uuid', modelId: 'k3' } })
    expect(r).toEqual({ status: 'resolved', channelId: 'glm-zhipu', modelId: 'glm-5.3-vision' })
  })

  test('channel 同但 model 不同 → resolved（非同端点）', () => {
    const phase = { ...getPhaseNode('quick', 'prototype')! }
    phase.visualReviewerChannel = 'glm-zhipu'
    phase.visualReviewerModel = 'glm-5.3-vision'
    const r = resolveVisualValidatorSlot(phase, { authorResolved: { channelId: 'glm-zhipu', modelId: 'GLM-5.3' } })
    expect(r.status).toBe('resolved')
  })
})

describe('W-B B2：validateVisualValidatorDelegation（gate 端权威校验）', () => {
  test('未配置独立视觉端点 → ok:false（gate 拒绝，不静默放行）', () => {
    const phase = { ...getPhaseNode('quick', 'prototype')! }
    const r = validateVisualValidatorDelegation({ phase, authorResolved: { channelId: 'author-uuid', modelId: 'MiniMax-M3' } })
    expect(r.ok).toBe(false)
  })

  test('端点为 resolved 但 target 不匹配（退回作者端点）→ ok:false', () => {
    const phase = { ...getPhaseNode('quick', 'prototype')! }
    phase.visualReviewerChannel = 'glm-zhipu'
    phase.visualReviewerModel = 'glm-5.3-vision'
    const r = validateVisualValidatorDelegation({
      phase,
      authorResolved: { channelId: 'author-uuid', modelId: 'MiniMax-M3' },
      targetChannelId: 'author-uuid',
      targetModelId: 'MiniMax-M3',
    })
    expect(r.ok).toBe(false)
  })

  test('target 与 producer resolved 端点完全一致 → ok:true', () => {
    const phase = { ...getPhaseNode('quick', 'prototype')! }
    phase.visualReviewerChannel = 'glm-zhipu'
    phase.visualReviewerModel = 'glm-5.3-vision'
    const r = validateVisualValidatorDelegation({
      phase,
      authorResolved: { channelId: 'author-uuid', modelId: 'MiniMax-M3' },
      targetChannelId: 'glm-zhipu',
      targetModelId: 'glm-5.3-vision',
    })
    expect(r.ok).toBe(true)
  })
})

describe('W-B B2：resolveDelegationSlot（内部 slot 权威优先于 legacy 文本推断）', () => {
  test('内部 slot=visual-validator 覆盖文本推断（即使文本不含视觉标记）', () => {
    expect(resolveDelegationSlot('visual-validator', 'general')).toBe('visual-validator')
  })

  test('内部 slot 缺省/非法 → 回退 legacy 文本推断', () => {
    expect(resolveDelegationSlot(undefined, 'author')).toBe('author')
    expect(resolveDelegationSlot('not-a-slot', 'ac-attacker')).toBe('ac-attacker')
  })

  test('detectDelegationSlot 为 legacy 低信任：title 含视觉标记 → visual-validator', () => {
    expect(detectDelegationSlot({ title: '独立视觉裁决：原型' }, 'prototype')).toBe('visual-validator')
  })
})

describe('W-B B2 R1：isVisualValidatorEndpointTarget（端点到槽位检测）', () => {
  test('resolved 且 target 完全一致 → true；缺 target/状态非 resolved → false', () => {
    const resolved = { status: 'resolved' as const, channelId: 'kimi', modelId: 'k3-vision' }
    expect(isVisualValidatorEndpointTarget({ slot: resolved, targetChannelId: 'kimi', targetModelId: 'k3-vision' })).toBe(true)
    // 端点只差模型 / 只差渠道 → false（不得误判为同一独立端点）
    expect(isVisualValidatorEndpointTarget({ slot: resolved, targetChannelId: 'kimi', targetModelId: 'other' })).toBe(false)
    expect(isVisualValidatorEndpointTarget({ slot: resolved, targetChannelId: 'other', targetModelId: 'k3-vision' })).toBe(false)
    // 未解析（blocked / not-applicable）→ false：未配置时不纳入端点门禁，交由 title 兜底
    expect(isVisualValidatorEndpointTarget({ slot: { status: 'blocked', reason: 'x' }, targetChannelId: 'kimi', targetModelId: 'k3-vision' })).toBe(false)
    expect(isVisualValidatorEndpointTarget({ slot: { status: 'not-applicable' }, targetChannelId: 'kimi', targetModelId: 'k3-vision' })).toBe(false)
    // target 非字符串（继承/缺省）→ false
    expect(isVisualValidatorEndpointTarget({ slot: resolved })).toBe(false)
    expect(isVisualValidatorEndpointTarget({ slot: resolved, targetChannelId: 'kimi' })).toBe(false)
  })
})

// ═══════════════ W-B B1-1（R6）：显式端点失效 → autofix 同族替换 + 遥测 ═══════════════

describe('W-B B1-1（R6）：显式配置的 prototype 作者端点失效 → 同族替换 + 遥测（非静默硬换）', () => {
  /** 渠道宇宙：deepseek 家族只剩新名 deepseek-flash（显式配置里的 deepseek-v4-flash 已下线） */
  function mockRenameUniverse(): void {
    mock.module('./channel-manager', () => ({
      listChannels: () => [
        makeChannel({ id: 'deepseek', name: 'DeepSeek', provider: 'deepseek' as Channel['provider'], models: [
          { id: 'deepseek-flash', name: 'DeepSeek Flash', enabled: true },
        ] }),
        makeChannel({ id: 'glm-zhipu', name: '智谱', provider: 'zhipu' as Channel['provider'], models: [
          { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', enabled: true },
        ] }),
        makeChannel(),
      ],
      getChannelById: () => null,
    }))
  }

  afterEach(() => {
    reloadNanjuModelConfig({ userConfigPath: null, overrideConfigPath: null })
    mock.module('./channel-manager', () => ({
      listChannels: () => [makeChannel()],
      getChannelById: () => null,
    }))
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
    fixtureRoot = ''
  })

  test('prototype 显式作者 deepseek:deepseek-v4-flash（已下线）→ prompt 委派值替换为同族 deepseek-flash + model.config-autofix 遥测', async () => {
    mockRenameUniverse()
    const root = mkdtempSync(join(tmpdir(), 'nanju-b1-autofix-'))
    fixtureRoot = root
    const userPath = join(root, 'user-model-config.json')
    writeFileSync(userPath, JSON.stringify({ phases: { prototype: { channel: 'deepseek', model: 'deepseek-v4-flash' } } }))
    reloadNanjuModelConfig({ userConfigPath: userPath, overrideConfigPath: null, builtinConfigPath: null })
    const projectDir = join(root, 'project-b1fix')
    mkdirSync(join(projectDir, '01_PRD'), { recursive: true })
    writeFileSync(join(projectDir, '01_PRD', 'prd.md'), '# PRD\n## US-01 演示')
    writeFileSync(join(root, '_nanju-projects.json'), JSON.stringify([{
      projectId: 'b1fix', name: 'B1 autofix', mode: 'quick', status: 'active',
      currentStage: 'prototype', createdAt: '', updatedAt: '', sessionId: 's-b1fix',
    }]))

    const prompt = getNanjuRouterPrompt(root, 's-b1fix')
    expect(prompt).toBeTruthy()
    // autofix 生效：失效的显式端点被同族新名替换（本次 prompt 有效值，不落盘）
    expect(prompt).toContain('modelId: deepseek-flash')
    expect(prompt).not.toContain('modelId: deepseek-v4-flash')
    // 遥测留痕：替换不是静默的（slot/from/to 可审计）
    const { readTelemetry } = await import('./nanju-telemetry')
    const events = readTelemetry(fixtureRoot, 'model.config-autofix')
    expect(events.length).toBe(1)
    expect(events[0]!.payload).toEqual({
      slot: 'phases.prototype.primary',
      from: 'deepseek:deepseek-v4-flash',
      to: 'deepseek:deepseek-flash',
      reason: 'same-channel-rename',
    })
  })

  test('跨族候选存在但不同族 → 放弃替换保持原值（家族拓扑守卫，零遥测）', async () => {
    // 渠道宇宙只有 glm 系（跨族候选），deepseek 失效端点无同族替换
    mock.module('./channel-manager', () => ({
      listChannels: () => [
        makeChannel({ id: 'glm-zhipu', name: '智谱', provider: 'zhipu' as Channel['provider'], models: [
          { id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', enabled: true },
        ] }),
        makeChannel(),
      ],
      getChannelById: () => null,
    }))
    const root = mkdtempSync(join(tmpdir(), 'nanju-b1-autofix-x-'))
    fixtureRoot = root
    const userPath = join(root, 'user-model-config.json')
    writeFileSync(userPath, JSON.stringify({ phases: { prototype: { channel: 'deepseek', model: 'deepseek-v4-flash' } } }))
    reloadNanjuModelConfig({ userConfigPath: userPath, overrideConfigPath: null, builtinConfigPath: null })
    const projectDir = join(root, 'project-b1nofix')
    mkdirSync(join(projectDir, '01_PRD'), { recursive: true })
    writeFileSync(join(projectDir, '01_PRD', 'prd.md'), '# PRD\n## US-01 演示')
    writeFileSync(join(root, '_nanju-projects.json'), JSON.stringify([{
      projectId: 'b1nofix', name: 'B1 no-autofix', mode: 'quick', status: 'active',
      currentStage: 'prototype', createdAt: '', updatedAt: '', sessionId: 's-b1nofix',
    }]))

    const prompt = getNanjuRouterPrompt(root, 's-b1nofix')
    expect(prompt).toBeTruthy()
    // 保持原值（透传）；跨族不换 → 既有 delegate_agent 层错误路径负责
    expect(prompt).toContain('modelId: deepseek-v4-flash')
    const { readTelemetry } = await import('./nanju-telemetry')
    expect(readTelemetry(fixtureRoot, 'model.config-autofix')).toHaveLength(0)
  })
})

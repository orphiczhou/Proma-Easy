/**
 * W10 确认响应推进检查器测试（v0.17.72）
 *
 * 覆盖面（工单 §2/§4）：
 * - 确认语义检测：确认词全表命中 / 反义词全表排除（含「不通过」含子串「通过」的顺序陷阱）
 *   / 非确认文本 / 'ok' 词边界 / 大小写
 * - judgeConfirmAdvance 判定矩阵：确认+达标置位（set）/ 不达标不置位（none）/
 *   delivered 与 mode-select 排除 / 反义词清除（clear）/ 普通文本 none
 * - confirmPendingStage 读写：set/get/clear 往返、clear 幂等、无文件 get null、
 *   set 保留既有字段（向后兼容）
 * - getNanjuRouterPrompt 注入断言：confirmPending=当前阶段 → 提示块出现且 next 正确
 *   （quick/iterative 同源推导）/ 无字段无提示 / 脏残留（≠当前阶段）无提示
 *
 * PHASE_ADVANCE 消费清除的接线点在 agent-orchestrator（类内部大方法，无既有测试模式），
 * 本文件覆盖其调用的 clearProjectConfirmPending 语义（幂等/字段消失），接线以走查记录于报告。
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let fixtureRoot = ''

const actualConfigPaths = await import('./config-paths')
mock.module('./config-paths', () => ({
  ...actualConfigPaths,
  getWorkspaceFilesDir: () => fixtureRoot,
  getAgentWorkspacePath: () => fixtureRoot,
}))
// 注意：不 mock channel-manager——只有 prototype 阶段会 resolvePrototypeAuthor；
// 本文件用例全部避开 prototype（脏残留用 architecture 构造），避免 mock.module
// 进程级全局生效污染同批运行的其他文件（实证：合跑时 channel-runtime-api-key 9 测试被污染）

const {
  CONFIRM_ADVANCE_KEYWORDS,
  CONFIRM_REJECT_KEYWORDS,
  isConfirmAdvanceText,
  isConfirmRejectText,
  judgeConfirmAdvance,
  setProjectConfirmPending,
  clearProjectConfirmPending,
  getProjectConfirmPending,
} = await import('./nanju-project')
const { getNanjuRouterPrompt } = await import('./nanju-router-prompt')

/** 构造 fixture：_nanju-projects.json 元数据 + 可选预置 _project-info.json */
function setupProject(opts: {
  stage?: string
  mode?: 'quick' | 'iterative'
  sessionId?: string
  confirmPending?: string
  infoFields?: Record<string, unknown>
}): void {
  const dir = mkdtempSync(join(tmpdir(), 'nanju-confirm-advance-'))
  fixtureRoot = dir
  writeFileSync(join(dir, '_nanju-projects.json'), JSON.stringify([{
    projectId: 'p1',
    name: '确认检查器测试项目',
    mode: opts.mode ?? 'quick',
    status: 'active',
    currentStage: opts.stage ?? 'requirements',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sessionId: opts.sessionId ?? 'session-1',
    workspaceSlug: 'test-ws',
  }]))
  if (opts.confirmPending !== undefined || opts.infoFields !== undefined) {
    const projectDir = join(dir, 'project-p1')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, '_project-info.json'), JSON.stringify({
      projectId: 'p1',
      name: '确认检查器测试项目',
      mode: opts.mode ?? 'quick',
      createdAt: new Date().toISOString(),
      workspaceSlug: 'test-ws',
      projectDir: 'project-p1',
      docDirs: [],
      ...(opts.confirmPending !== undefined ? { confirmPendingStage: opts.confirmPending } : {}),
      ...(opts.infoFields ?? {}),
    }))
  }
}

afterEach(() => {
  if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = ''
})

// ═══════════════ 确认语义检测（纯函数） ═══════════════

describe('W10：确认语义检测（isConfirmAdvanceText / isConfirmRejectText）', () => {
  test('确认词全表命中（含 ok 大小写变体）', () => {
    const hits = ['确认推进', '验收通过', '没问题，就这样', '好的', '可以', '继续', '推进', 'ok', 'OK', 'Ok', 'please approve it']
    for (const text of hits) {
      expect(isConfirmAdvanceText(text)).toBe(true)
    }
    // 词表常量本身可演进——全表逐词至少一个命中样例
    for (const kw of CONFIRM_ADVANCE_KEYWORDS) {
      expect(isConfirmAdvanceText(`看起来${kw}了`)).toBe(true)
    }
  })

  test('反义词全表排除（「不通过/没通过」含子串「通过」——反义判定先于确认词判定）', () => {
    const rejects = ['不通过', '没通过', '需要修复', '这个要重做', '不行']
    for (const text of rejects) {
      expect(isConfirmAdvanceText(text)).toBe(false)
      expect(isConfirmRejectText(text)).toBe(true)
    }
    // 混合场景：反义词与确认词并存（用户否决）→ 非确认 + 反悔
    expect(isConfirmAdvanceText('这版不通过，需要修复')).toBe(false)
    expect(isConfirmRejectText('这版不通过，需要修复')).toBe(true)
    // 词表常量全表覆盖
    for (const kw of CONFIRM_REJECT_KEYWORDS) {
      expect(isConfirmAdvanceText(`方案${kw}，先别推进`)).toBe(false)
    }
  })

  test('非确认文本：普通陈述/提问不算确认', () => {
    for (const text of ['帮我看看这个', '稍等，我再看一眼', '这个功能是干嘛的', 'skip this step']) {
      expect(isConfirmAdvanceText(text)).toBe(false)
      expect(isConfirmRejectText(text)).toBe(false)
    }
  })

  test('ok 词边界：不误命中 skip/bookmark 等含 ok 子串词', () => {
    expect(isConfirmAdvanceText('ok')).toBe(true)
    expect(isConfirmAdvanceText('OK! 没问题')).toBe(true)
    expect(isConfirmAdvanceText('skip the preview')).toBe(false)
    expect(isConfirmAdvanceText('bookmark this page')).toBe(false)
  })

  test('空文本不算确认', () => {
    expect(isConfirmAdvanceText('')).toBe(false)
    expect(isConfirmAdvanceText('   ')).toBe(false)
  })
})

// ═══════════════ judgeConfirmAdvance 判定矩阵（纯函数） ═══════════════

describe('W10：judgeConfirmAdvance 判定矩阵', () => {
  test('确认词 + 产出达标（verifyError=null）+ 活跃阶段 → set', () => {
    for (const stage of ['requirements', 'prototype', 'architecture', 'planning', 'coding', 'testing']) {
      expect(judgeConfirmAdvance('确认，继续推进', stage, null)).toBe('set')
    }
  })

  test('确认词 + 产出未达标（verifyError 非 null）→ none（产出未完成时不置位，防误导）', () => {
    expect(judgeConfirmAdvance('确认，继续推进', 'requirements', '产出文件不存在：01_PRD/prd.md')).toBe('none')
  })

  test('delivered / mode-select 阶段 → none（终态与选型期无推进语义）', () => {
    expect(judgeConfirmAdvance('确认', 'delivered', null)).toBe('none')
    expect(judgeConfirmAdvance('确认', 'mode-select', null)).toBe('none')
  })

  test('反义词 → clear（用户反悔，即使产出达标）', () => {
    expect(judgeConfirmAdvance('不通过，需要修复', 'requirements', null)).toBe('clear')
    expect(judgeConfirmAdvance('重做', 'prototype', null)).toBe('clear')
    // 反义词优先级高于阶段排除（delivered 下反义词也无副作用，返回 clear 语义等价幂等清除）
  })

  test('普通文本 → none（保持待推进状态不被非确认消息清除，工单 §2.3）', () => {
    expect(judgeConfirmAdvance('这个功能是干嘛的', 'requirements', null)).toBe('none')
  })
})

// ═══════════════ confirmPendingStage 读写（唯一写入点） ═══════════════

describe('W10：confirmPendingStage 读写', () => {
  test('set → get 返回置位阶段；文件落盘含字段', () => {
    setupProject({ stage: 'requirements' })
    setProjectConfirmPending('test-ws', 'p1', 'requirements')
    expect(getProjectConfirmPending('test-ws', 'p1')).toBe('requirements')
    const raw = JSON.parse(readFileSync(join(fixtureRoot, 'project-p1', '_project-info.json'), 'utf-8'))
    expect(raw.confirmPendingStage).toBe('requirements')
  })

  test('clear → 字段消失；再次 clear 幂等 no-op', () => {
    setupProject({ stage: 'requirements', confirmPending: 'requirements' })
    clearProjectConfirmPending('test-ws', 'p1')
    expect(getProjectConfirmPending('test-ws', 'p1')).toBeNull()
    clearProjectConfirmPending('test-ws', 'p1') // 幂等
    expect(getProjectConfirmPending('test-ws', 'p1')).toBeNull()
  })

  test('无 _project-info.json 的项目：get 返回 null；set 自动补齐骨架（老项目升级路径）', () => {
    setupProject({ stage: 'requirements' }) // 不预置 info
    expect(getProjectConfirmPending('test-ws', 'p1')).toBeNull()
    setProjectConfirmPending('test-ws', 'p1', 'requirements')
    expect(getProjectConfirmPending('test-ws', 'p1')).toBe('requirements')
  })

  test('set/clear 保留既有字段（向后兼容：不覆盖 projectCategory/subStage 等）', () => {
    setupProject({
      stage: 'coding',
      confirmPending: 'coding',
      infoFields: { projectCategory: 'web-fullstack', projectCategorySource: 'default', subStage: 'coding-main' },
    })
    setProjectConfirmPending('test-ws', 'p1', 'coding') // 重复置位
    let raw = JSON.parse(readFileSync(join(fixtureRoot, 'project-p1', '_project-info.json'), 'utf-8'))
    expect(raw.projectCategory).toBe('web-fullstack')
    expect(raw.subStage).toBe('coding-main')
    clearProjectConfirmPending('test-ws', 'p1')
    raw = JSON.parse(readFileSync(join(fixtureRoot, 'project-p1', '_project-info.json'), 'utf-8'))
    expect(raw.confirmPendingStage).toBeUndefined()
    expect(raw.projectCategory).toBe('web-fullstack')
    expect(raw.subStage).toBe('coding-main')
  })
})

// ═══════════════ getNanjuRouterPrompt 推进提示注入 ═══════════════

describe('W10：getNanjuRouterPrompt 推进提示注入', () => {
  test('confirmPending=当前阶段（requirements/quick）→ 提示块出现且 next=prototype（路由同源推导）', () => {
    setupProject({ stage: 'requirements', mode: 'quick', confirmPending: 'requirements' })
    const prompt = getNanjuRouterPrompt('test-ws', 'session-1')
    expect(prompt).toBeDefined()
    expect(prompt).toContain('⏩ 用户已确认本阶段产出（confirmPending=requirements）')
    expect(prompt).toContain('<!-- PHASE_ADVANCE: prototype -->')
    expect(prompt).toContain('不要重新委派任务、不要重复产出')
    // 注入位置在阶段 header 之后（醒目置顶）
    expect(prompt!.indexOf('⏩ 用户已确认本阶段产出')).toBeGreaterThan(prompt!.indexOf('## 🔒 南大向导 — 当前阶段'))
    expect(prompt!.indexOf('⏩ 用户已确认本阶段产出')).toBeLessThan(prompt!.indexOf('### 你的唯一职责'))
  })

  test('iterative 模式 requirements → next 同源为 prototype（quick/iterative 同推导）', () => {
    setupProject({ stage: 'requirements', mode: 'iterative', confirmPending: 'requirements' })
    const prompt = getNanjuRouterPrompt('test-ws', 'session-1')
    expect(prompt).toContain('⏩ 用户已确认本阶段产出（confirmPending=requirements）')
    expect(prompt).toContain('<!-- PHASE_ADVANCE: prototype -->')
  })

  test('无 confirmPending 字段 → 无提示块（常态 prompt 不变）', () => {
    setupProject({ stage: 'requirements' })
    const prompt = getNanjuRouterPrompt('test-ws', 'session-1')
    expect(prompt).toBeDefined()
    expect(prompt).not.toContain('⏩ 用户已确认本阶段产出')
  })

  test('confirmPending ≠ 当前阶段（推进后清除失败的脏残留）→ 不注入（防误导）', () => {
    // 用 architecture 构造脏残留（避开 prototype——它会 resolvePrototypeAuthor 依赖渠道）
    setupProject({ stage: 'architecture', confirmPending: 'requirements' })
    const prompt = getNanjuRouterPrompt('test-ws', 'session-1')
    expect(prompt).toBeDefined()
    expect(prompt).not.toContain('⏩ 用户已确认本阶段产出')
  })

  test('消费清除闭环：置位 → prompt 含提示 → clearProjectConfirmPending → prompt 无提示', () => {
    setupProject({ stage: 'requirements' })
    setProjectConfirmPending('test-ws', 'p1', 'requirements')
    expect(getNanjuRouterPrompt('test-ws', 'session-1')).toContain('⏩ 用户已确认本阶段产出')
    // PHASE_ADVANCE 推进成功时 orchestrator 调 clearProjectConfirmPending（消费侧）
    clearProjectConfirmPending('test-ws', 'p1')
    expect(getNanjuRouterPrompt('test-ws', 'session-1')).not.toContain('⏩ 用户已确认本阶段产出')
  })
})

// ═══════════════ W10 修订轮 A2（必修）：反义词表扩充（裁决 20260903 attack-upheld 加重） ═══════════════

describe('W10 修订轮 A2：反义词表扩充 8 词 + 负向测试三组', () => {
  test('① 表外反悔表达（修订前 none 残留）→ clear；「先别推进」子串陷阱（「推进」∈确认词表）扩词后反义先命中', () => {
    // 裁决 A2 加重证据实测修复：修订前「先别推进」→ isConfirmAdvance=true（"推进"子串）
    // / isConfirmReject=false → set（用户反悔被反向置位为待推进）
    expect(isConfirmAdvanceText('先别推进')).toBe(false)
    expect(isConfirmRejectText('先别推进')).toBe(true)
    expect(judgeConfirmAdvance('先别推进', 'requirements', null)).toBe('clear')
    // 其余修订前残留的表外反悔表达（裁决探针原词 + 扩词表全表）
    const regressions = ['改主意了', '暂缓一下', '再想想', '等等', '先停一下', '不急', '取消吧', '先别']
    for (const text of regressions) {
      expect(judgeConfirmAdvance(text, 'requirements', null)).toBe('clear')
    }
  })

  test('② 已置位项目收到反悔表达 → confirmPending 字段消失 → 下轮 prompt 提示块消失', () => {
    setupProject({ stage: 'requirements', confirmPending: 'requirements' })
    expect(getNanjuRouterPrompt('test-ws', 'session-1')).toContain('⏩ 用户已确认本阶段产出')
    // orchestrator 检测块链路：judgeConfirmAdvance='clear' → clearProjectConfirmPending
    expect(judgeConfirmAdvance('先别推进，我再想想', 'requirements', null)).toBe('clear')
    clearProjectConfirmPending('test-ws', 'p1')
    expect(getProjectConfirmPending('test-ws', 'p1')).toBeNull()
    expect(getNanjuRouterPrompt('test-ws', 'session-1')).not.toContain('⏩ 用户已确认本阶段产出')
    const raw = JSON.parse(readFileSync(join(fixtureRoot, 'project-p1', '_project-info.json'), 'utf-8'))
    expect(raw.confirmPendingStage).toBeUndefined()
  })

  test('③ judgeConfirmAdvance 反悔矩阵 8 条（新词全表 × 多活跃阶段，反义优先于一切确认语义）', () => {
    const newWords = ['改主意', '先别', '暂缓', '再想想', '等等', '先停', '不急', '取消']
    for (const word of newWords) {
      expect(isConfirmRejectText(`这个方案${word}`)).toBe(true)
      // 混合确认词场景：反义优先（「先别推进」类子串陷阱的通用形态）
      for (const stage of ['requirements', 'coding', 'testing']) {
        expect(judgeConfirmAdvance(`这个方案${word}`, stage, null)).toBe('clear')
      }
    }
    expect(judgeConfirmAdvance('暂缓，先别继续', 'prototype', null)).toBe('clear')
  })
})

// ═══════════════ W10 修订轮 A3（随批）：testing 确认提示 next 特判（裁决 20260903 partially-upheld） ═══════════════

describe('W10 修订轮 A3：testing 确认提示特判为 GWT 重入（非 next 同源 delivered）', () => {
  test('testing 置位（quick）→ 提示标记为 PHASE_ADVANCE: testing（触发 GWT 验收），不含 delivered', () => {
    setupProject({ stage: 'testing', mode: 'quick', confirmPending: 'testing' })
    const prompt = getNanjuRouterPrompt('test-ws', 'session-1')
    expect(prompt).toContain('⏩ 用户已确认本阶段产出（confirmPending=testing）')
    expect(prompt).toContain('<!-- PHASE_ADVANCE: testing -->')
    expect(prompt).not.toContain('<!-- PHASE_ADVANCE: delivered -->')
  })

  test('iterative 模式 testing 同样特判（两模式机器判定收口一致）；非 testing 阶段仍按 next 同源推导', () => {
    setupProject({ stage: 'testing', mode: 'iterative', confirmPending: 'testing' })
    expect(getNanjuRouterPrompt('test-ws', 'session-1')).toContain('<!-- PHASE_ADVANCE: testing -->')
    // 对照：requirements 阶段不受特判影响（next 同源推导 prototype 不变）
    setupProject({ stage: 'requirements', mode: 'quick', confirmPending: 'requirements' })
    expect(getNanjuRouterPrompt('test-ws', 'session-1')).toContain('<!-- PHASE_ADVANCE: prototype -->')
  })
})

/**
 * nanju-coding-tree-bridge 测试（NEXT-02，BDD 风格；R3 返工版 2026-11-03）
 *
 * 覆盖（R1/R2/R3 阻断项 + 黄-1/2/4 + 绿-2/4）：
 * - toValidTreeId（R2：sha1 短哈希）：中文项目不塌缩互不碰撞（记账小工具/作品集/记账/待办）；
 *   同 id 幂等稳定；引擎行为断言（init + leaf add 反向验证 treeId 可用，替代正则副本）
 * - selectHeterogeneousModels：异构选择 / 同渠道降级两级 / 无渠道 / 禁用模型
 * - collectProjectArtifacts：五个标准目录扫描 + 隐藏文件排除 + 目录缺失
 * - bootstrapCodingTreeForProject（R1 三层结构 root→C-commander→A/B-worker）：
 *   · 端到端（真实 tree-engine，trees 落 /tmp 隔离，会话工厂注入合法 UUID stub）
 *     ——tree-state.json 结构断言（四叶三层、A/B added_by=C 会话、root 绑定指挥官）
 *   · R1 审查员要求的 audit_gate 全链端到端：桥产出树 → root 写 done 取 trust-anchor →
 *     root 背书 B → B 背书 A → 全链 audit_gate pass + tree_validate issues=0（真实引擎）
 *   · 幂等（project.treeId 已登记且四叶完整）：不重复建会话/叶子
 *   · R3 部分失败自愈：删 B 叶模拟 auditor 叶失败残留 → 重试补建 B、复用 root/C/A
 *   · E_DUPLICATE_LEAF 且 project_id 不匹配（异项目碰撞树）→ 拒绝误绑
 *   · 黄-1：leaf add 撞 E_DUPLICATE_LEAF → 读回复用树内已登记 session
 *   · 黄-2：leaf add 确定性失败 → 孤儿会话删除止损 + 埋点 orphan_sessions
 *   · 黄-4：root 会话漂移 → leaf set-session 重绑而非拒绝
 *   · mock 引擎：调用序列与参数格式（init → leaf add ×3 → communication log；
 *     绿-4：root/C 元信息用指挥官真实渠道/模型）
 *   · 引擎抛异常 → ok:false 不抛出；引擎挂起 → 3s 超时降级（绿-3）
 * - 绿-2：生产 trees 路径（无 override）落隔离 rig 内（assertInsideRig）
 * - recordBootstrapDegradation：'tree.bootstrap' 失败埋点落盘
 *
 * 隔离纪律：useIsolatedPromaConfigDir 夹具（homedir → /tmp 临时根）+ trees 目录
 * 落 /tmp，绝不写真实工作区 .context/trees。
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Channel } from '@proma/shared'
import type { NanjuProject, ProjectMode } from './nanju-project'
import type { CodingTreeBridgeDeps } from './nanju-coding-tree-bridge'
import { assertInsideRig, useIsolatedPromaConfigDir } from './__tests__/test-home-fixture'

// ===== 环境隔离 =====
// 统一使用 NEXT-05 夹具（推荐入口 useIsolatedPromaConfigDir）：homedir 指向 /tmp
// 临时根 + 每用例清空配置目录 + afterAll 还原（历史教训：手搓 mock 曾在仓库根写入
// project-ab12cd34/，见 NEXT-05 审查反馈——统一夹具 + assertInsideRig 双保险）。
const rig = useIsolatedPromaConfigDir()

// 被测模块链（channel-manager/agent-session-manager/config-paths）依赖 electron，
// 非 Electron 运行时需进程级 mock；safeStorage 走不可用→明文回退分支。
mock.module('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => path.join(rig.homeDir, 'Library', 'Application Support'),
  },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  nativeImage: { createFromPath: () => ({}) },
  nativeTheme: {},
  powerMonitor: {},
  powerSaveBlocker: {},
  screen: {},
  shell: {},
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf-8'),
  },
}))

// 懒加载被测模块（同 channel-manager.test.ts 惯例）：依赖链上 channel-manager
// 顶层 `import { safeStorage } from 'electron'` 为静态 ESM 命名导入，
// bun 的 mock.module 无法拦截，必须在 mock 就位后再动态 import。
type BridgeModule = typeof import('./nanju-coding-tree-bridge')
type NanjuTelemetryModule = typeof import('./nanju-telemetry')
type ConfigPathsModule = typeof import('./config-paths')
interface TreeEngineLike {
  run(cmd: string, args: string[], treesRoot?: string, callerSessionId?: string): Promise<{ ok: boolean; error?: { code?: string; msg?: string }; [key: string]: unknown }>
}
let mod: BridgeModule
let nanjuTelemetryMod: NanjuTelemetryModule
let configPathsMod: ConfigPathsModule
let treeEngineMod: TreeEngineLike

// trees 目录隔离（与 HOME 无关，走 treesDirOverride 直指 /tmp）
let tempTreesRoot: string

beforeEach(async () => {
  if (!mod) {
    mod = await import('./nanju-coding-tree-bridge')
    nanjuTelemetryMod = await import('./nanju-telemetry')
    configPathsMod = await import('./config-paths')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    treeEngineMod = require('./tree-engine.cjs') as TreeEngineLike
  }
  tempTreesRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nj-tree-bridge-trees-'))
})

afterEach(() => {
  // trees 临时目录逐用例清理（曾因遗漏致 /tmp 残留 182 个目录，NEXT-05 风格隔离纪律）
  fs.rmSync(tempTreesRoot, { recursive: true, force: true })
})

// ===== 测试夹具 =====

const PROJECT_ID = 'ab12cd34'

function makeProject(overrides: Partial<NanjuProject> = {}): NanjuProject {
  return {
    projectId: PROJECT_ID,
    name: '测试向导项目',
    mode: 'quick' as ProjectMode,
    status: 'active',
    currentStage: 'coding',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workspaceSlug: 'default',
    ...overrides,
  }
}

function makeChannel(id: string, provider: Channel['provider'], modelIds: string[]): Channel {
  return {
    id,
    name: id,
    provider,
    baseUrl: `https://${id}.example.com`,
    apiKey: 'enc-test',
    models: modelIds.map((mid) => ({ id: mid, name: mid, enabled: true })),
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function sessionFactory(): { deps: Partial<CodingTreeBridgeDeps>; count(): number; titles(): string[] } {
  let calls = 0
  const titles: string[] = []
  return {
    deps: {
      createSession: (title: string) => {
        calls += 1
        titles.push(title)
        return { id: randomUUID() }
      },
    },
    count: () => calls,
    titles: () => [...titles],
  }
}

function telemetryRecorder(): { deps: Partial<CodingTreeBridgeDeps>; events(): Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = []
  return {
    deps: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      telemetry: (_slug, _type, payload) => {
        events.push(payload)
        return null
      },
    } as Partial<CodingTreeBridgeDeps>,
    events: () => [...events],
  }
}

function updateProjectRecorder(): {
  deps: Partial<CodingTreeBridgeDeps>
  updates(): Array<{ projectId: string; updates: Partial<NanjuProject> }>
} {
  const recorded: Array<{ projectId: string; updates: Partial<NanjuProject> }> = []
  return {
    deps: {
      updateProject: (_slug, projectId, updates) => {
        recorded.push({ projectId, updates })
        return { ...makeProject(), ...updates } as NanjuProject
      },
    },
    updates: () => [...recorded],
  }
}

const CHANNELS_FIXTURE: Channel[] = [
  makeChannel('glm-zhipu', 'zhipu', ['glm-5.3', 'glm-5.3-flash']),
  makeChannel('deepseek', 'deepseek', ['deepseek-v4', 'deepseek-v4-flash']),
]

interface TestDeps extends CodingTreeBridgeDeps {
  sessionCount(): number
  sessionTitles(): string[]
  telemetryEvents(): Array<Record<string, unknown>>
  projectUpdates(): Array<{ projectId: string; updates: Partial<NanjuProject> }>
  deletedSessions(): string[]
}

function makeDeps(channels: Channel[] = CHANNELS_FIXTURE): TestDeps {
  const sessions = sessionFactory()
  const telemetry = telemetryRecorder()
  const updates = updateProjectRecorder()
  const deleted: string[] = []
  return {
    engine: treeEngineMod,
    createSession: sessions.deps.createSession,
    deleteSession: (id) => { deleted.push(id) },
    getChannels: () => channels,
    telemetry: telemetry.deps.telemetry,
    updateProject: updates.deps.updateProject,
    sessionCount: sessions.count,
    sessionTitles: sessions.titles,
    telemetryEvents: telemetry.events,
    projectUpdates: updates.updates,
    deletedSessions: () => [...deleted],
  } as TestDeps
}

/** 在隔离 HOME 下构造项目目录与前序产出文档 */
function seedProjectArtifacts(workspaceSlug: string, projectId: string, files: Record<string, string>): string {
  const projectDir = path.join(configPathsMod.getWorkspaceFilesDir(workspaceSlug), `project-${projectId}`)
  // 防绕过隔离：项目目录必须落在夹具临时根内，否则立即失败（NEXT-05 审查反馈加固）
  assertInsideRig(rig, projectDir, 'seedProjectArtifacts 项目目录')
  for (const [rel, content] of Object.entries(files)) {
    const filePath = path.join(projectDir, rel)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, content, 'utf-8')
  }
  return projectDir
}

function treesDir(): string {
  return path.join(tempTreesRoot, 'trees')
}

function readTreeState(treeId: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(treesDir(), treeId, 'tree-state.json'), 'utf-8')) as Record<string, unknown>
}

interface LeafLike {
  leaf_id?: string
  session_id?: string
  role?: string
  parent?: string | null
  path?: string
  added_by?: string | null
  status?: string
  events?: Array<{ type?: string; meta?: Record<string, unknown> }>
  audit_gate?: { verdict?: string; auditor_session_id?: string | null; auto_upgrade?: boolean }
}

function leavesOf(state: Record<string, unknown>): Record<string, LeafLike> {
  return (state.leaves ?? {}) as Record<string, LeafLike>
}

// ===== 1. toValidTreeId（R2：sha1 短哈希） =====

describe('toValidTreeId：确定性短哈希（R2，CJK 不塌缩）', () => {
  test('中文项目名不塌缩：审查员实测的四组项目互不碰撞且均非 nj0000', () => {
    const ids = ['记账小工具', '作品集', '记账', '待办'].map((name) => mod.toValidTreeId(name))
    expect(new Set(ids).size).toBe(4)
    for (const id of ids) {
      expect(id).not.toBe('nj0000')
      expect(id).toMatch(/^nj[0-9a-f]{5}$/)
    }
  })

  test('同项目幂等稳定（确定性），输出恒 7 字符', () => {
    for (const projectId of [PROJECT_ID, 'MyProject', '记账小工具', '', 'x'.repeat(200)]) {
      const a = mod.toValidTreeId(projectId)
      const b = mod.toValidTreeId(projectId)
      expect(a).toBe(b)
      expect(a).toHaveLength(7)
    }
  })

  test('引擎行为断言（绿-2：替代正则副本）：任意 projectId 派生的 treeId 可真实 init 并挂叶', async () => {
    // 用审查员实测的中文项目名直接验证：treeId 能过引擎 init + root 叶 + worker 叶命名
    for (const projectId of ['记账小工具', 'PROJECT_WITH specials!@#', 'a']) {
      const treeId = mod.toValidTreeId(projectId)
      const init = await treeEngineMod.run('init', [
        treeId,
        '--root-brief', JSON.stringify({ project_id: projectId }),
        '--root-dod', JSON.stringify({ done: 'ok' }),
        '--session-id', randomUUID(),
      ], treesDir(), undefined)
      expect(init.ok).toBe(true)
      const cAdd = await treeEngineMod.run('leaf', [
        'add', treeId,
        '--json', JSON.stringify({
          leaf_id: `${treeId}-C-commander`, session_id: randomUUID(),
          parent: `${treeId}-root`, path: 'C', role: 'commander',
          model: 'm', channel: 'c', added_by: randomUUID(),
        }),
      ], treesDir(), undefined)
      expect(cAdd.ok).toBe(true)
      const wAdd = await treeEngineMod.run('leaf', [
        'add', treeId,
        '--json', JSON.stringify({
          leaf_id: `${treeId}-A-worker`, session_id: randomUUID(),
          parent: `${treeId}-C-commander`, path: 'A', role: 'worker',
          model: 'm', channel: 'c', added_by: randomUUID(),
        }),
      ], treesDir(), undefined)
      expect(wAdd.ok).toBe(true)
    }
  })
})

// ===== 2. selectHeterogeneousModels =====

describe('selectHeterogeneousModels：从 enabled 渠道动态选择', () => {
  test('正常路径：worker 取 GLM-5.x 主力，auditor 取异构渠道 deepseek flash', () => {
    const r = mod.selectHeterogeneousModels(CHANNELS_FIXTURE)
    expect(r.workerChannelId).toBe('glm-zhipu')
    expect(r.workerModelId).toBe('glm-5.3')
    expect(r.auditorChannelId).toBe('deepseek')
    expect(r.auditorModelId).toBe('deepseek-v4-flash')
    expect(r.degraded).toBe(false)
  })

  test('无 GLM 时：worker 降级选 deepseek 非 flash 主力（单渠道下 auditor 同渠道异模型降级）', () => {
    const r = mod.selectHeterogeneousModels([makeChannel('ds', 'deepseek', ['deepseek-v4', 'deepseek-v4-flash'])])
    expect(r.workerModelId).toBe('deepseek-v4')
    expect(r.auditorModelId).toBe('deepseek-v4-flash')
    expect(r.degraded).toBe(true)
    expect(r.note).toContain('同渠道')
  })

  test('同渠道降级：仅单渠道多模型时 auditor 取同渠道不同模型并标记 degraded', () => {
    const r = mod.selectHeterogeneousModels([makeChannel('only', 'openai', ['glm-5.3', 'glm-5.3-flash'])])
    expect(r.workerModelId).toBe('glm-5.3')
    expect(r.auditorModelId).toBe('glm-5.3-flash')
    expect(r.auditorChannelId).toBe(r.workerChannelId)
    expect(r.degraded).toBe(true)
  })

  test('单渠道单模型降级：auditor 与 worker 同模型（完整降级说明）', () => {
    const r = mod.selectHeterogeneousModels([makeChannel('solo', 'openai', ['solo-model'])])
    expect(r.workerModelId).toBe('solo-model')
    expect(r.auditorModelId).toBe('solo-model')
    expect(r.degraded).toBe(true)
  })

  test('无可用渠道：全部 undefined + 降级标记（不硬编码渠道 id）', () => {
    const r = mod.selectHeterogeneousModels([])
    expect(r.workerChannelId).toBeUndefined()
    expect(r.workerModelId).toBeUndefined()
    expect(r.degraded).toBe(true)
    const disabled = makeChannel('off', 'openai', ['m1'])
    disabled.enabled = false
    expect(mod.selectHeterogeneousModels([disabled]).workerModelId).toBeUndefined()
  })

  test('禁用模型不参与选择', () => {
    const ch = makeChannel('glm-zhipu', 'zhipu', ['glm-5.3'])
    ch.models = ch.models.map((m) => ({ ...m, enabled: false }))
    const r = mod.selectHeterogeneousModels([ch, makeChannel('other', 'openai', ['fallback-model'])])
    expect(r.workerModelId).toBe('fallback-model')
  })
})

// ===== 3. collectProjectArtifacts =====

describe('collectProjectArtifacts：前序产出文档扫描', () => {
  test('正常路径：收集五个标准目录的非隐藏文件（相对路径排序）', () => {
    seedProjectArtifacts('default', PROJECT_ID, {
      '01_PRD/prd.md': '# PRD',
      '01_PRD/.hidden': 'x',
      '02_UX_DESIGN/prototype.html': '<html/>',
      '03_ARCHITECTURE/arch.md': '# 架构',
      '04_API_SPEC/api.md': '# API',
      '05_PROJECT_PLAN/plan.md': '# 计划',
      '08_APP/index.html': '不应被收集',
    })
    const artifacts = mod.collectProjectArtifacts('default', PROJECT_ID)
    expect(artifacts).toEqual([
      `project-${PROJECT_ID}/01_PRD/prd.md`,
      `project-${PROJECT_ID}/02_UX_DESIGN/prototype.html`,
      `project-${PROJECT_ID}/03_ARCHITECTURE/arch.md`,
      `project-${PROJECT_ID}/04_API_SPEC/api.md`,
      `project-${PROJECT_ID}/05_PROJECT_PLAN/plan.md`,
    ])
  })

  test('目录缺失：返回空数组不抛出', () => {
    expect(mod.collectProjectArtifacts('default', 'no-such-project')).toEqual([])
  })
})

// ===== 4. bootstrapCodingTreeForProject（R1 三层结构） =====

describe('bootstrapCodingTreeForProject：端到端（真实 tree-engine，/tmp 隔离）', () => {
  test('正常路径：三层四叶（root→C-commander→A/B），A/B added_by=C 会话，回写 treeId + tree.bootstrap 埋点', async () => {
    const deps = makeDeps()
    seedProjectArtifacts('default', PROJECT_ID, { '01_PRD/prd.md': '# PRD' })
    const commanderSessionId = randomUUID()

    const result = await mod.bootstrapCodingTreeForProject({
      workspaceSlug: 'default',
      workspaceId: 'ws-1',
      project: makeProject(),
      commanderSessionId,
      commanderChannelId: 'glm-zhipu',
      commanderModelId: 'glm-5.3',
      treesDirOverride: treesDir(),
      deps,
    })

    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()
    const treeId = mod.toValidTreeId(PROJECT_ID)
    expect(result.treeId).toBe(treeId)
    expect(result.rootLeafId).toBe(`${treeId}-root`)
    expect(result.commanderLeafId).toBe(`${treeId}-C-commander`)
    expect(result.workerLeafId).toBe(`${treeId}-A-worker`)
    expect(result.auditorLeafId).toBe(`${treeId}-B-worker`)
    expect(result.commanderSessionId).not.toBe(commanderSessionId) // C 是新建会话
    expect(result.workerSessionId).not.toBe(result.auditorSessionId)

    // tree-state.json 三层结构断言（真实引擎产物）
    const state = readTreeState(treeId)
    const leaves = leavesOf(state)
    expect(Object.keys(leaves).sort()).toEqual([`${treeId}-A-worker`, `${treeId}-B-worker`, `${treeId}-C-commander`, `${treeId}-root`])
    expect(leaves[`${treeId}-root`]?.session_id).toBe(commanderSessionId)
    expect(leaves[`${treeId}-root`]?.role).toBe('root')
    expect(leaves[`${treeId}-C-commander`]?.role).toBe('commander')
    expect(leaves[`${treeId}-C-commander`]?.parent).toBe(`${treeId}-root`)
    expect(leaves[`${treeId}-C-commander`]?.added_by).toBe(commanderSessionId)
    // R1 核心：A/B 的 parent=C、added_by=C 的会话（非 root 调度员）→ root/B 均有背书资格
    expect(leaves[`${treeId}-A-worker`]?.parent).toBe(`${treeId}-C-commander`)
    expect(leaves[`${treeId}-A-worker`]?.added_by).toBe(result.commanderSessionId)
    expect(leaves[`${treeId}-B-worker`]?.parent).toBe(`${treeId}-C-commander`)
    expect(leaves[`${treeId}-B-worker`]?.added_by).toBe(result.commanderSessionId)
    expect(leaves[`${treeId}-B-worker`]?.session_id).toBe(result.auditorSessionId)

    // root_brief 含上游产物；root_dod node_budget 容纳四叶
    const brief = state.root_brief as { project_id: string; upstream_artifacts: string[] }
    expect(brief.project_id).toBe(PROJECT_ID)
    expect(brief.upstream_artifacts).toContain(`project-${PROJECT_ID}/01_PRD/prd.md`)
    const dod = state.root_dod as { node_budget: number }
    expect(dod.node_budget).toBeGreaterThanOrEqual(4)

    // 首条通信日志（root → C）
    const commLog = state.communication_log as Array<{ from_leaf: string; to_leaf: string }>
    expect(commLog.length).toBe(1)
    expect(commLog[0]?.from_leaf).toBe(`${treeId}-root`)
    expect(commLog[0]?.to_leaf).toBe(`${treeId}-C-commander`)

    // 会话工厂恰好三次（C + A + B）
    expect(deps.sessionCount()).toBe(3)
    expect(deps.sessionTitles()[0]).toContain('[Tree Commander]')
    expect(deps.sessionTitles()[1]).toContain('[Tree Worker]')
    expect(deps.sessionTitles()[2]).toContain('[Tree Auditor]')

    // treeId 回写 + 'tree.bootstrap' 埋点（绿-1）
    expect(deps.projectUpdates().length).toBe(1)
    expect(deps.projectUpdates()[0]?.updates.treeId).toBe(treeId)
    expect(deps.telemetryEvents().length).toBe(1)
    expect(deps.telemetryEvents()[0]?.kind).toBe('coding-tree-bootstrap')
    expect(deps.telemetryEvents()[0]?.bootstrap_ok).toBe(true)

    // 指挥官启动契约：三层结构 + V10 硬约束 4 条 + 标准动作
    const prompt = result.commanderBootstrapPrompt
    expect(prompt).toContain(treeId)
    expect(prompt).toContain('tree_milestone_add')
    expect(prompt).toContain('send_message')
    expect(prompt).toContain('tree_audit_gate')
    expect(prompt).toContain('brief_echo')
    expect(prompt).toContain('trust-anchor')
    expect(prompt).toContain('背书链')
    expect(prompt).toContain('deliverables')
  })

  test('R1 审查员全链验收：root done 取 trust-anchor → root 背书 B → B 背书 A → 全链 audit_gate pass + tree_validate issues=0', async () => {
    const deps = makeDeps()
    const rootSession = randomUUID()
    const boot = await mod.bootstrapCodingTreeForProject({
      workspaceSlug: 'default', workspaceId: 'ws-1', project: makeProject(),
      commanderSessionId: rootSession, treesDirOverride: treesDir(), deps,
    })
    expect(boot.ok).toBe(true)
    const treeId = boot.treeId
    const t = treesDir()
    const selfCheck = JSON.stringify([{ item: '产出落盘核验', pass: true, evidence: 'docs/reports/x.md' }])

    // ① root 写 done 事件（caller=root.session）→ 引擎自动 status=done + audit_gate pass（trust-anchor）
    const rootDone = await treeEngineMod.run('event', [
      'append', treeId, `${treeId}-root`,
      '--type', 'done', '--json', `{"self_check": ${selfCheck}}`,
    ], t, rootSession)
    expect(rootDone.ok).toBe(true)

    // ② B（auditor）写 brief_echo（无 alignment）+ done（caller=B 自己）
    const bEcho = await treeEngineMod.run('event', [
      'append', treeId, `${treeId}-B-worker`,
      '--type', 'brief_echo', '--json', JSON.stringify({ my_understanding: '审计任务理解', milestones_preview: [] }),
    ], t, boot.auditorSessionId)
    expect(bEcho.ok).toBe(true)
    const bDone = await treeEngineMod.run('event', [
      'append', treeId, `${treeId}-B-worker`,
      '--type', 'done', '--json', `{"self_check": ${selfCheck}}`,
    ], t, boot.auditorSessionId)
    expect(bDone.ok).toBe(true)

    // ③ root 以独立 auditor 身份给 B 回填 alignment（brief_echo 带 alignment + auditor_session_id=root）
    const bAlign = await treeEngineMod.run('event', [
      'append', treeId, `${treeId}-B-worker`,
      '--type', 'brief_echo',
      '--json', JSON.stringify({ my_understanding: 'root 审计对齐', milestones_preview: [], alignment: 'aligned', auditor_session_id: rootSession }),
    ], t, rootSession)
    expect(bAlign.ok).toBe(true)

    // ④ root 背书 B：audit gate pass（caller=root=audit-session-id；B.added_by=C ≠ root ✓）
    const bGate = await treeEngineMod.run('audit', [
      'gate', treeId, `${treeId}-B-worker`, '--verdict', 'pass',
      '--audit-session-id', rootSession, '--reason', 'root 背书 auditor B',
    ], t, rootSession)
    expect(bGate.ok).toBe(true)

    // ⑤ A（worker）brief_echo + done（caller=A 自己）
    const aEcho = await treeEngineMod.run('event', [
      'append', treeId, `${treeId}-A-worker`,
      '--type', 'brief_echo', '--json', JSON.stringify({ my_understanding: '编码任务理解', milestones_preview: [] }),
    ], t, boot.workerSessionId)
    expect(aEcho.ok).toBe(true)
    const aDone = await treeEngineMod.run('event', [
      'append', treeId, `${treeId}-A-worker`,
      '--type', 'done', '--json', `{"self_check": ${selfCheck}}`,
    ], t, boot.workerSessionId)
    expect(aDone.ok).toBe(true)

    // ⑥ B（已 done+pass，有背书资格）给 A 回填 alignment（auditor_session_id=B）
    const aAlign = await treeEngineMod.run('event', [
      'append', treeId, `${treeId}-A-worker`,
      '--type', 'brief_echo',
      '--json', JSON.stringify({ my_understanding: 'B 审计对齐', milestones_preview: [], alignment: 'aligned', auditor_session_id: boot.auditorSessionId }),
    ], t, boot.auditorSessionId)
    expect(aAlign.ok).toBe(true)

    // ⑦ B 背书 A：audit gate pass（caller=B=audit-session-id；A.added_by=C ≠ B ✓）
    const aGate = await treeEngineMod.run('audit', [
      'gate', treeId, `${treeId}-A-worker`, '--verdict', 'pass',
      '--audit-session-id', boot.auditorSessionId, '--reason', 'auditor B 背书 worker A',
    ], t, boot.auditorSessionId)
    expect(aGate.ok).toBe(true)

    // ⑧ 全链终检：三个关键叶 audit_gate 均 pass；tree_validate issues=0
    const finalState = readTreeState(treeId)
    const leaves = leavesOf(finalState)
    expect(leaves[`${treeId}-root`]?.audit_gate?.verdict).toBe('pass')
    expect(leaves[`${treeId}-root`]?.audit_gate?.auto_upgrade).toBe(true)
    expect(leaves[`${treeId}-B-worker`]?.audit_gate?.verdict).toBe('pass')
    expect(leaves[`${treeId}-A-worker`]?.audit_gate?.verdict).toBe('pass')
    const validate = await treeEngineMod.run('validate', [treeId], t, rootSession)
    expect(validate.ok).toBe(true)
    expect(validate.issues).toEqual([])
  })

  test('幂等（project.treeId 已登记且四叶完整）：不重复建会话/叶子，直接续用', async () => {
    const deps = makeDeps()
    const commanderSessionId = randomUUID()
    const treeId = mod.toValidTreeId(PROJECT_ID)

    const first = await mod.bootstrapCodingTreeForProject({
      workspaceSlug: 'default', workspaceId: 'ws-1', project: makeProject(),
      commanderSessionId, treesDirOverride: treesDir(), deps,
    })
    expect(first.ok).toBe(true)
    expect(deps.sessionCount()).toBe(3)

    const second = await mod.bootstrapCodingTreeForProject({
      workspaceSlug: 'default', workspaceId: 'ws-1', project: makeProject({ treeId }),
      commanderSessionId, treesDirOverride: treesDir(), deps,
    })
    expect(second.ok).toBe(true)
    expect(second.idempotent).toBe(true)
    expect(second.commanderSessionId).toBe(first.commanderSessionId)
    expect(second.workerSessionId).toBe(first.workerSessionId)
    expect(second.auditorSessionId).toBe(first.auditorSessionId)
    expect(deps.sessionCount()).toBe(3)
    expect(deps.projectUpdates().length).toBe(1)
    expect(second.commanderBootstrapPrompt).toContain(treeId)
  })

  test('R3 部分失败自愈：B 叶缺失（模拟 auditor 叶失败残留）→ 重试补建 B、复用 root/C/A，不再拒绝误绑', async () => {
    const deps = makeDeps()
    const commanderSessionId = randomUUID()

    const first = await mod.bootstrapCodingTreeForProject({
      workspaceSlug: 'default', workspaceId: 'ws-1', project: makeProject(),
      commanderSessionId, treesDirOverride: treesDir(), deps,
    })
    expect(first.ok).toBe(true)
    const treeId = first.treeId

    // 模拟部分失败：从 tree-state.json 直接删掉 B 叶（等价于「C/A 成功 + B leaf add 失败」的残留态）
    const statePath = path.join(treesDir(), treeId, 'tree-state.json')
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as { leaves: Record<string, unknown> }
    delete state.leaves[`${treeId}-B-worker`]
    fs.writeFileSync(statePath, JSON.stringify(state), 'utf-8')

    // 重试（不带 treeId，走 init E_DUPLICATE_LEAF 补缺路径）
    const retry = await mod.bootstrapCodingTreeForProject({
      workspaceSlug: 'default', workspaceId: 'ws-1', project: makeProject(),
      commanderSessionId, treesDirOverride: treesDir(), deps,
    })
    expect(retry.ok).toBe(true)
    expect(retry.idempotent).not.toBe(true) // 首次补齐视为新成功
    expect(retry.auditorSessionId).not.toBe(first.auditorSessionId) // B 重建了会话
    expect(retry.workerSessionId).toBe(first.workerSessionId) // A 复用
    expect(retry.commanderSessionId).toBe(first.commanderSessionId) // C 复用
    // 会话工厂仅新增 1 次（B）
    expect(deps.sessionCount()).toBe(4)
    // 树恢复四叶
    const healed = leavesOf(readTreeState(treeId))
    expect(Object.keys(healed).sort()).toEqual([`${treeId}-A-worker`, `${treeId}-B-worker`, `${treeId}-C-commander`, `${treeId}-root`])
    expect(healed[`${treeId}-B-worker`]?.added_by).toBe(retry.commanderSessionId)
  })

  test('E_DUPLICATE_LEAF 且 project_id 不匹配（异项目碰撞树）：拒绝误绑', async () => {
    const deps = makeDeps()
    const commanderSessionId = randomUUID()
    const treeId = mod.toValidTreeId(PROJECT_ID)

    // 直接用引擎预置一棵同 treeId 但属于异项目的树（R2 哈希化后碰撞概率极低，
    // 手工构造覆盖拒绝分支：root_brief.project_id 不同）
    const preset = await treeEngineMod.run('init', [
      treeId,
      '--root-brief', JSON.stringify({ project_id: 'someone-else', parent_intent: '异项目' }),
      '--root-dod', JSON.stringify({ done: 'ok' }),
      '--session-id', randomUUID(),
    ], treesDir(), undefined)
    expect(preset.ok).toBe(true)

    const second = await mod.bootstrapCodingTreeForProject({
      workspaceSlug: 'default', workspaceId: 'ws-1', project: makeProject(),
      commanderSessionId, treesDirOverride: treesDir(), deps,
    })
    expect(second.ok).toBe(false)
    expect(second.error).toContain('异项目')
  })

  test('黄-1：leaf add 撞 E_DUPLICATE_LEAF（并发抢注竞态）→ 读回复用树内已登记 session，丢弃新建引用并删除止损', async () => {
    const deps = makeDeps()
    const commanderSessionId = randomUUID()

    // 第一次完整 bootstrap（真树真会话）
    const first = await mod.bootstrapCodingTreeForProject({
      workspaceSlug: 'default', workspaceId: 'ws-1', project: makeProject(),
      commanderSessionId, treesDirOverride: treesDir(), deps,
    })
    expect(first.ok).toBe(true)
    const treeId = first.treeId

    // 模拟部分失败：删 B 叶 → 下次 bootstrap 需补建 B
    const statePath = path.join(treesDir(), treeId, 'tree-state.json')
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as { leaves: Record<string, unknown> }
    delete state.leaves[`${treeId}-B-worker`]
    fs.writeFileSync(statePath, JSON.stringify(state), 'utf-8')

    // wrapper 引擎：B 叶 leaf add 时先用真引擎抢注一个并发叶（模拟竞态窗口内他人注册），
    // 再让本次 add 真实撞 E_DUPLICATE_LEAF → bridge 应回退读回抢注 session，丢弃新建
    const realRun = treeEngineMod.run.bind(treeEngineMod)
    const hijackedSession = randomUUID()
    const wrapperEngine = {
      run: (cmd: string, args: string[], treesRoot?: string, caller?: string) => {
        if (cmd === 'leaf' && args[0] === 'add' && args[1] === treeId) {
          const jsonIdx = args.indexOf('--json')
          const leaf = JSON.parse((args[jsonIdx + 1] ?? '{}') as string) as { leaf_id?: string }
          if (leaf.leaf_id === `${treeId}-B-worker`) {
            const preregister = realRun('leaf', ['add', treeId, '--json', JSON.stringify({
              leaf_id: `${treeId}-B-worker`, session_id: hijackedSession,
              parent: `${treeId}-C-commander`, path: 'B', role: 'worker',
              model: 'm', channel: 'c', added_by: first.commanderSessionId,
            })], treesRoot, caller)
            return preregister.then(() => ({ ok: false, error: { code: 'E_DUPLICATE_LEAF', msg: 'race: preregistered' } }))
          }
        }
        return realRun(cmd, args, treesRoot, caller)
      },
    }
    const wrappedDeps = makeDeps()
    wrappedDeps.engine = wrapperEngine as unknown as TreeEngineLike

    const second = await mod.bootstrapCodingTreeForProject({
      workspaceSlug: 'default', workspaceId: 'ws-1', project: makeProject(), // 不带 treeId，走 init E_DUPLICATE_LEAF 补缺
      commanderSessionId, treesDirOverride: treesDir(), deps: wrappedDeps,
    })
    expect(second.ok).toBe(true)
    // B 读回复用抢注 session（非首次、也非本次新建）
    expect(second.auditorSessionId).toBe(hijackedSession)
    expect(second.auditorSessionId).not.toBe(first.auditorSessionId)
    // root/C/A 复用
    expect(second.commanderSessionId).toBe(first.commanderSessionId)
    expect(second.workerSessionId).toBe(first.workerSessionId)
    // 本次新建的 B 会话未挂树 → 止损删除（黄-1 联动黄-2）
    expect(wrappedDeps.deletedSessions().length).toBe(1)
    // 树内 B 叶 session 未被污染（仍为抢注值）
    const leaves = leavesOf(readTreeState(treeId))
    expect(leaves[`${treeId}-B-worker`]?.session_id).toBe(hijackedSession)
  })

  test('黄-2：leaf add 确定性失败 → 已建孤儿会话删除止损 + 埋点记录 orphan_sessions', async () => {
    const sessions = sessionFactory()
    const telemetry = telemetryRecorder()
    const deps = {
      engine: {
        run: async (cmd: string) => {
          if (cmd === 'init') return { ok: true }
          if (cmd === 'leaf') return { ok: false, error: { code: 'E_IO', msg: 'disk full' } }
          return { ok: true }
        },
      },
      createSession: sessions.deps.createSession,
      deleteSession: (id: string) => { deleted.push(id) },
      getChannels: () => CHANNELS_FIXTURE,
      telemetry: telemetry.deps.telemetry,
      updateProject: () => null,
    } as unknown as CodingTreeBridgeDeps & { deletedSessions(): string[] }
    const deleted: string[] = []

    const result = await mod.bootstrapCodingTreeForProject({
      workspaceSlug: 'default', workspaceId: 'ws-1', project: makeProject(),
      commanderSessionId: randomUUID(), treesDirOverride: treesDir(), deps,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('E_IO')
    // C 叶失败 → C 会话被删；A/B 尚未创建（fail-fast 于第一个 leaf add）
    expect(sessions.count()).toBe(1)
    expect(deleted.length).toBe(1)
    // 埋点含 orphan_sessions
    const failEvent = telemetry.events().find((e) => e.bootstrap_ok === false)
    expect(failEvent).toBeDefined()
    expect(Array.isArray(failEvent?.orphan_sessions)).toBe(true)
  })

  test('黄-4：root 会话漂移（回滚/会话重建）→ leaf set-session 重绑而非拒绝', async () => {
    const deps = makeDeps()
    const oldCommander = randomUUID()
    const treeId = mod.toValidTreeId(PROJECT_ID)

    const first = await mod.bootstrapCodingTreeForProject({
      workspaceSlug: 'default', workspaceId: 'ws-1', project: makeProject(),
      commanderSessionId: oldCommander, treesDirOverride: treesDir(), deps,
    })
    expect(first.ok).toBe(true)

    // 新调度员会话（模拟会话重建/回滚后续接）→ root 重绑到新 session
    const newCommander = randomUUID()
    const second = await mod.bootstrapCodingTreeForProject({
      workspaceSlug: 'default', workspaceId: 'ws-1', project: makeProject({ treeId }),
      commanderSessionId: newCommander, treesDirOverride: treesDir(), deps,
    })
    expect(second.ok).toBe(true)
    expect(second.idempotent).toBe(true)
    // 树内 root 已重绑
    const leaves = leavesOf(readTreeState(treeId))
    expect(leaves[`${treeId}-root`]?.session_id).toBe(newCommander)
    // C/A/B 未动
    expect(second.commanderSessionId).toBe(first.commanderSessionId)
    expect(second.workerSessionId).toBe(first.workerSessionId)
  })

  test('F-1：C 叶已挂树后 A 叶失败 → 止损只删未挂树的 A 会话，C 保留；重试后 C 存活且树内无悬空', async () => {
    const telemetry = telemetryRecorder()
    const deleted: string[] = []
    const realRun = treeEngineMod.run.bind(treeEngineMod)
    // wrapper：init 透传、C 的 leaf add 透传（成功挂树）、A 的 leaf add 返回 E_IO（失败）
    const wrapperEngine = {
      run: (cmd: string, args: string[], treesRoot?: string, caller?: string) => {
        if (cmd === 'leaf' && args[0] === 'add') {
          const jsonIdx = args.indexOf('--json')
          const leaf = JSON.parse((args[jsonIdx + 1] ?? '{}') as string) as { leaf_id?: string }
          if (leaf.leaf_id?.endsWith('-A-worker')) {
            return Promise.resolve({ ok: false, error: { code: 'E_IO', msg: 'injected failure' } })
          }
        }
        return realRun(cmd, args, treesRoot, caller)
      },
    }
    const sessions = sessionFactory()
    const deps = {
      engine: wrapperEngine,
      createSession: sessions.deps.createSession,
      deleteSession: (id: string) => { deleted.push(id) },
      getChannels: () => CHANNELS_FIXTURE,
      telemetry: telemetry.deps.telemetry,
      updateProject: () => null,
    } as unknown as CodingTreeBridgeDeps
    const commanderSessionId = randomUUID()

    const first = await mod.bootstrapCodingTreeForProject({
      workspaceSlug: 'default', workspaceId: 'ws-1', project: makeProject(),
      commanderSessionId, treesDirOverride: treesDir(), deps,
    })
    expect(first.ok).toBe(false)
    expect(first.error).toContain('E_IO')
    // C 已建会话挂树成功（保留），A 会话未挂树（删除）——只删 A 不删 C
    expect(sessions.count()).toBe(2) // C + A 两个会话已建
    expect(deleted.length).toBe(1)
    // 埋点区分 orphan_sessions（已删）与 kept_sessions（保留，F-1）
    const failEvent = telemetry.events().find((e) => e.bootstrap_ok === false)
    expect(Array.isArray(failEvent?.orphan_sessions)).toBe(true)
    expect((failEvent?.orphan_sessions as string[]).length).toBe(1)
    expect(Array.isArray(failEvent?.kept_sessions)).toBe(true)
    expect((failEvent?.kept_sessions as string[]).length).toBe(1)

    // 重试（真引擎，无注入）：C 会话存活被复用，四叶补齐，树内无悬空
    const retryDeps = makeDeps()
    const retry = await mod.bootstrapCodingTreeForProject({
      workspaceSlug: 'default', workspaceId: 'ws-1', project: makeProject(),
      commanderSessionId, treesDirOverride: treesDir(), deps: retryDeps,
    })
    expect(retry.ok).toBe(true)
    const keptSessions = (failEvent?.kept_sessions ?? []) as string[] // C 复用
    expect(retry.commanderSessionId).toBe(keptSessions[0] ?? '')
    const leaves = leavesOf(readTreeState(retry.treeId))
    // 树内全部 session 都指向存活会话（无悬空）：root/C/A/B 四叶齐全
    expect(Object.keys(leaves).sort()).toEqual([`${retry.treeId}-A-worker`, `${retry.treeId}-B-worker`, `${retry.treeId}-C-commander`, `${retry.treeId}-root`])
    expect(leaves[`${retry.treeId}-C-commander`]?.session_id).toBe(retry.commanderSessionId)
  })

  test('F-2：root 漂移 × 树不完整组合态 → 重绑仍生效，新指挥官可写 root done 事件', async () => {
    const deps = makeDeps()
    const oldCommander = randomUUID()
    const treeId = mod.toValidTreeId(PROJECT_ID)

    const first = await mod.bootstrapCodingTreeForProject({
      workspaceSlug: 'default', workspaceId: 'ws-1', project: makeProject(),
      commanderSessionId: oldCommander, treesDirOverride: treesDir(), deps,
    })
    expect(first.ok).toBe(true)

    // 组合态：删 B 叶（树不完整）+ 换新指挥官（root 漂移）
    const statePath = path.join(treesDir(), treeId, 'tree-state.json')
    const state = JSON.parse(fs.readFileSync(statePath, 'utf-8')) as { leaves: Record<string, unknown> }
    delete state.leaves[`${treeId}-B-worker`]
    fs.writeFileSync(statePath, JSON.stringify(state), 'utf-8')

    const newCommander = randomUUID()
    const second = await mod.bootstrapCodingTreeForProject({
      workspaceSlug: 'default', workspaceId: 'ws-1', project: makeProject({ treeId }),
      commanderSessionId: newCommander, treesDirOverride: treesDir(), deps,
    })
    expect(second.ok).toBe(true)
    // root 已重绑到新指挥官（即使树当时四叶不全）
    const leaves = leavesOf(readTreeState(treeId))
    expect(leaves[`${treeId}-root`]?.session_id).toBe(newCommander)
    // B 已补齐
    expect(Object.keys(leaves).sort()).toEqual([`${treeId}-A-worker`, `${treeId}-B-worker`, `${treeId}-C-commander`, `${treeId}-root`])
    // 新指挥官可写 root done 事件（引擎 caller 校验通过 = 重绑真实生效）
    const rootDone = await treeEngineMod.run('event', [
      'append', treeId, `${treeId}-root`,
      '--type', 'done',
      '--json', JSON.stringify({ self_check: [{ item: '核验', pass: true, evidence: 'ok' }] }),
    ], treesDir(), newCommander)
    expect(rootDone.ok).toBe(true)
    expect(leavesOf(readTreeState(treeId))[`${treeId}-root`]?.audit_gate?.verdict).toBeDefined()
  })

  test('mock 引擎：调用序列与参数格式（init → leaf add ×3 → communication log；绿-4 root/C 元信息用真实渠道）', async () => {
    const calls: Array<{ cmd: string; args: string[]; caller?: string }> = []
    const commanderSessionId = randomUUID()
    const deps = {
      engine: {
        run: async (cmd: string, args: string[], _treesRoot?: string, callerSessionId?: string) => {
          calls.push({ cmd, args, caller: callerSessionId })
          return { ok: true }
        },
      },
      createSession: () => ({ id: randomUUID() }),
      deleteSession: () => {},
      getChannels: () => CHANNELS_FIXTURE,
      telemetry: () => null,
      updateProject: () => null,
    } as unknown as CodingTreeBridgeDeps

    const result = await mod.bootstrapCodingTreeForProject({
      workspaceSlug: 'default', workspaceId: 'ws-1', project: makeProject(),
      commanderSessionId,
      commanderChannelId: 'glm-zhipu',
      commanderModelId: 'glm-5.3',
      treesDirOverride: treesDir(), deps,
    })
    expect(result.ok).toBe(true)

    // 调用序列：init → leaf C → leaf A → leaf B → communication log
    expect(calls.map((c) => c.cmd)).toEqual(['init', 'leaf', 'leaf', 'leaf', 'communication'])
    // init 参数：绿-4 指挥官真实渠道/模型填入 root 元信息
    const initCall = calls[0]
    expect(initCall?.args[0]).toBe(mod.toValidTreeId(PROJECT_ID))
    const modelIdx = initCall?.args.indexOf('--model') ?? -1
    const channelIdx = initCall?.args.indexOf('--channel') ?? -1
    expect(initCall?.args[modelIdx + 1]).toBe('glm-5.3')
    expect(initCall?.args[channelIdx + 1]).toBe('glm-zhipu')
    // node_budget 为非负有限数（引擎 v0.7 批次5 校验）
    const dodIdx = initCall?.args.indexOf('--root-dod') ?? -1
    const dod = JSON.parse((initCall?.args[dodIdx + 1] ?? '{}') as string) as { node_budget: number }
    expect(Number.isFinite(dod.node_budget)).toBe(true)
    expect(dod.node_budget).toBeGreaterThanOrEqual(4)
    // leaf add：C 层 role=commander added_by=调度员；A/B 层 role=worker added_by=C 会话
    const leafCalls = [calls[1], calls[2], calls[3]]
    for (const leafCall of leafCalls) {
      expect(leafCall?.args[0]).toBe('add')
      const jsonIdx = leafCall?.args.indexOf('--json') ?? -1
      const leaf = JSON.parse((leafCall?.args[jsonIdx + 1] ?? '{}') as string) as Record<string, string>
      expect(leaf.session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    }
    const cLeaf = JSON.parse((leafCalls[0]?.args[(leafCalls[0]?.args.indexOf('--json') ?? -1) + 1] ?? '{}') as string) as Record<string, string>
    expect(cLeaf.role).toBe('commander')
    expect(cLeaf.added_by).toBe(commanderSessionId)
    for (const abCall of [leafCalls[1], leafCalls[2]]) {
      const abLeaf = JSON.parse((abCall?.args[(abCall?.args.indexOf('--json') ?? -1) + 1] ?? '{}') as string) as Record<string, string>
      expect(abLeaf.role).toBe('worker')
      expect(abLeaf.added_by).toBe(result.commanderSessionId) // R1：added_by=C 会话
      expect(abLeaf.parent).toBe(`${result.treeId}-C-commander`)
    }
    // communication log：from root → to C
    const commCall = calls[4]
    expect(commCall?.args[0]).toBe('log')
    const toIdx = commCall?.args.indexOf('--to') ?? -1
    expect(commCall?.args[toIdx + 1]).toBe(`${result.treeId}-C-commander`)
  })

  test('引擎抛异常：返回 ok:false 且不抛出（安全降级）', async () => {
    const deps = {
      engine: { run: async () => { throw new Error('boom: 磁盘损坏') } },
      createSession: () => ({ id: randomUUID() }),
      deleteSession: () => {},
      getChannels: () => CHANNELS_FIXTURE,
      telemetry: () => null,
      updateProject: () => null,
    } as unknown as CodingTreeBridgeDeps

    const result = await mod.bootstrapCodingTreeForProject({
      workspaceSlug: 'default', workspaceId: 'ws-1', project: makeProject(),
      commanderSessionId: randomUUID(), treesDirOverride: treesDir(), deps,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('boom')
  })

  test('绿-3：引擎挂起超过 3s → 超时降级 ok:false（不删孤儿会话，待补缺收敛）', async () => {
    const deleted: string[] = []
    const deps = {
      engine: {
        run: (cmd: string) =>
          cmd === 'init'
            ? new Promise(() => { /* 永久挂起 */ })
            : Promise.resolve({ ok: true }),
      },
      createSession: () => ({ id: randomUUID() }),
      deleteSession: (id: string) => { deleted.push(id) },
      getChannels: () => CHANNELS_FIXTURE,
      telemetry: () => null,
      updateProject: () => null,
    } as unknown as CodingTreeBridgeDeps

    const result = await mod.bootstrapCodingTreeForProject({
      workspaceSlug: 'default', workspaceId: 'ws-1', project: makeProject(),
      commanderSessionId: randomUUID(), treesDirOverride: treesDir(), deps,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('E_ENGINE_TIMEOUT')
    // 超时路径不删会话（后台可能仍在挂叶）
    expect(deleted.length).toBe(0)
  }, 10_000)

  test('init 失败（非 E_DUPLICATE_LEAF）：返回 ok:false 且不建会话', async () => {
    const sessions = sessionFactory()
    const deps = {
      engine: { run: async () => ({ ok: false, error: { code: 'E_IO', msg: 'disk full' } }) },
      createSession: sessions.deps.createSession,
      deleteSession: () => {},
      getChannels: () => CHANNELS_FIXTURE,
      telemetry: () => null,
      updateProject: () => null,
    } as unknown as CodingTreeBridgeDeps

    const result = await mod.bootstrapCodingTreeForProject({
      workspaceSlug: 'default', workspaceId: 'ws-1', project: makeProject(),
      commanderSessionId: randomUUID(), treesDirOverride: treesDir(), deps,
    })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('E_IO')
    expect(sessions.count()).toBe(0)
  })

  test('绿-2：生产 trees 路径（无 override）落隔离 rig 内（assertInsideRig 防绕过）', async () => {
    const deps = makeDeps()
    const result = await mod.bootstrapCodingTreeForProject({
      workspaceSlug: 'default', workspaceId: 'ws-1', project: makeProject(),
      commanderSessionId: randomUUID(), deps, // 不传 treesDirOverride → 走 getAgentWorkspacePath
    })
    expect(result.ok).toBe(true)
    // 树目录必须落在夹具临时根内（生产路径 = <rig>/agent-workspaces/default/workspace-files/.context/trees）
    const treeStatePath = path.join(rig.homeDir, '.proma', 'agent-workspaces', 'default', 'workspace-files', '.context', 'trees', result.treeId, 'tree-state.json')
    assertInsideRig(rig, treeStatePath, '生产 trees 目录')
    expect(fs.existsSync(treeStatePath)).toBe(true)
  })
})

// ===== 5. buildCommanderPrompt / recordBootstrapDegradation =====

describe('buildCommanderPrompt：指挥官启动契约完整性', () => {
  test('含三层结构说明 + tree-worker SKILL 标准动作 + V10 硬约束 4 条（黄-3）', () => {
    const prompt = mod.buildCommanderPrompt(
      {
        treeId: 'njtest', rootLeafId: 'njtest-root',
        commanderLeafId: 'njtest-C-commander', commanderSessionId: 'c-1',
        workerLeafId: 'njtest-A-worker', workerSessionId: 'w-1',
        auditorLeafId: 'njtest-B-worker', auditorSessionId: 'a-1',
      },
      { workerModelId: 'glm-5.3', auditorModelId: 'deepseek-v4-flash', degraded: false },
      ['project-x/01_PRD/prd.md'],
    )
    expect(prompt).toContain('njtest-root')
    expect(prompt).toContain('njtest-C-commander')
    expect(prompt).toContain('tree_milestone_add')
    expect(prompt).toContain('send_message')
    expect(prompt).toContain('tree_audit_gate')
    expect(prompt).toContain('brief_echo')
    expect(prompt).toContain('deliverables')
    expect(prompt).toContain('project-x/01_PRD/prd.md')
    expect(prompt).toContain('tree_help')
    // V10 硬约束 4 条（黄-3）
    expect(prompt).toContain('trust-anchor') // ① root 先 done 取信
    expect(prompt).toContain('alignment') // ② auditor 背书前置
    expect(prompt).toContain('E_ALIGNMENT_NOT_VERIFIED') // ③ worker 禁自评
    expect(prompt).toContain('root 背书') // ④ 背书链顺序
  })
})

describe("recordBootstrapDegradation：失败降级双通道记录（'tree.bootstrap'）", () => {
  test('写入 tree.bootstrap 埋点（kind 标记 bootstrap 失败），且不抛出', () => {
    const filesDir = configPathsMod.getWorkspaceFilesDir('default')
    assertInsideRig(rig, filesDir, 'telemetry workspace-files 目录')
    fs.mkdirSync(filesDir, { recursive: true })

    expect(() => mod.recordBootstrapDegradation('default', 'p1', 'njp1', 'E_IO: disk full')).not.toThrow()

    const events = nanjuTelemetryMod.readTelemetry('default', 'tree.bootstrap')
    expect(events.length).toBe(1)
    expect(events[0]?.payload.kind).toBe('coding-tree-bootstrap')
    expect(events[0]?.payload.bootstrap_ok).toBe(false)
    expect(events[0]?.payload.reason).toContain('E_IO')
  })
})

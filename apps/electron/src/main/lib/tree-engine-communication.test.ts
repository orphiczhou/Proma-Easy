/**
 * tree-engine communication 子命令测试（v0.17.133，蓝图 proma_agent_next_steps_guide1 §4.1/§4.2）
 *
 * 覆盖：log 正常路径（caller 透传 / target last_event_ts 刷新）、leaf 过滤（to/from 双向）、
 * -n 截断、边界（缺 --to、未知目标叶、未知子命令）、tree_validate 对新增 communication_log 无新问题。
 * 命名遵循 LEAF_NAME_RE：树 id 取 [a-z]{4,8} 使 `${tree_id}-root` 合规；worker 叶取 `comm*_w1`。
 */
import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const treeEngine = require('./tree-engine.cjs') as {
  run(cmd: string, args: string[], treesRoot?: string, callerSessionId?: string): Promise<Record<string, unknown>>
}

const CALLER_ROOT = '01234567-89ab-4cde-8f01-234567890abc'
const SESSION_WORKER = '22222222-2222-4222-8222-222222222222'
const SESSION_DISPATCHER = '33333333-3333-4333-8333-333333333333'

function makeTreesDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tree-comm-'))
}

async function initTree(treesDir: string, treeId: string): Promise<void> {
  const r = await treeEngine.run('init', [
    treeId,
    '--root-brief', JSON.stringify({ goal: '通信日志测试树' }),
    '--root-dod', JSON.stringify({ done: '全部通过' }),
    '--session-id', CALLER_ROOT,
  ], treesDir, CALLER_ROOT)
  expect(r.ok).toBe(true)
}

async function addWorkerLeaf(treesDir: string, treeId: string, leafId: string): Promise<void> {
  const leafJson = JSON.stringify({
    leaf_id: leafId,
    session_id: SESSION_WORKER,
    parent: `${treeId}-root`,
    path: "",
    role: 'worker',
    model: 'glm-5.3-flash',
    channel: 'glm-zhipu',
    // V10 加固：非 root 叶必须带操作者 session（合法 UUID）
    added_by: CALLER_ROOT,
  })
  const r = await treeEngine.run('leaf', ['add', treeId, '--json', leafJson], treesDir, CALLER_ROOT)
  expect(r.ok).toBe(true)
}

describe('tree-engine communication', () => {
  test('log 正常路径：写入条目 + 刷新 target last_event_ts + caller 透传', async () => {
    const treesDir = makeTreesDir()
    await initTree(treesDir, 'commx')
    await addWorkerLeaf(treesDir, 'commx', 'commx-worker')

    const r = await treeEngine.run('communication', [
      'log', 'commx',
      '--to', 'commx-worker',
      '--from', 'commx-root',
      '--summary', '派发任务',
    ], treesDir, SESSION_DISPATCHER)

    expect(r.ok).toBe(true)
    const logged = (r as { logged: Record<string, unknown> }).logged
    expect(logged.to_leaf).toBe('commx-worker')
    expect(logged.from_leaf).toBe('commx-root')
    expect(logged.caller_session_id).toBe(SESSION_DISPATCHER)
    expect(logged.target_session_id).toBe(SESSION_WORKER)
    expect(logged.summary).toBe('派发任务')
    expect(typeof logged.ts).toBe('string')

    // target leaf 的 last_event_ts 被刷新为该条 ts
    const leaf = await treeEngine.run('leaf', ['get', 'commx', 'commx-worker'], treesDir)
    const leafData = (leaf as { leaf: { last_event_ts?: string } }).leaf
    expect(leafData.last_event_ts).toBe(logged.ts as string)
  })

  test('list：leaf 过滤（to/from 双向匹配）与 -n 截断', async () => {
    const treesDir = makeTreesDir()
    await initTree(treesDir, 'commy')
    await addWorkerLeaf(treesDir, 'commy', 'commy-worker')

    await treeEngine.run('communication', ['log', 'commy', '--to', 'commy-worker', '--from', 'commy-root', '--summary', '第1条'], treesDir)
    await treeEngine.run('communication', ['log', 'commy', '--to', 'commy-worker', '--summary', '第2条'], treesDir)
    await treeEngine.run('communication', ['log', 'commy', '--to', 'commy-root', '--from', 'commy-worker', '--summary', '上行'], treesDir)

    const all = await treeEngine.run('communication', ['list', 'commy'], treesDir)
    expect((all as { count: number }).count).toBe(3)

    // worker 过滤：2 条 to=worker + 1 条 from=worker = 3 条命中（双向匹配）
    const byWorker = await treeEngine.run('communication', ['list', 'commy', '--leaf', 'commy-worker'], treesDir)
    expect((byWorker as { count: number }).count).toBe(3)

    const rootOnly = await treeEngine.run('communication', ['list', 'commy', '--leaf', 'commy-root'], treesDir)
    // e1(from=commy-root) + e3(to=commy-root) = 2 条；e2 无 root 不命中
    expect((rootOnly as { count: number }).count).toBe(2)

    // -n 截断：count 仍为全量，logs 只返回最后 1 条
    const last1 = await treeEngine.run('communication', ['list', 'commy', '-n', '1'], treesDir)
    const data = last1 as { count: number; logs: Array<{ summary: string }> }
    expect(data.count).toBe(3)
    expect(data.logs.length).toBe(1)
    expect(data.logs[0]!.summary).toBe('上行')
  })

  test('log 边界：缺 --to / 未知目标叶 / 未知子命令', async () => {
    const treesDir = makeTreesDir()
    await initTree(treesDir, 'commz')
    await addWorkerLeaf(treesDir, 'commz', 'commz-worker')

    // 错误结果统一形态：{ ok:false, error:{ code, msg } }
    // 缺 --to
    const missTo = await treeEngine.run('communication', ['log', 'commz'], treesDir)
    expect((missTo as { error?: { code?: string } }).error?.code).toBe('E_SCHEMA_INVALID')

    // 未知目标叶
    const noLeaf = await treeEngine.run('communication', ['log', 'commz', '--to', 'ghost-leaf'], treesDir)
    expect((noLeaf as { error?: { code?: string } }).error?.code).toBe('E_LEAF_NOT_FOUND')

    // 未知子命令
    const badSub = await treeEngine.run('communication', ['send', 'commz'], treesDir)
    expect((badSub as { error?: { code?: string } }).error?.code).toBe('E_UNKNOWN')
  })

  test('tree_validate 不因新增 communication_log 字段产生新问题', async () => {
    const treesDir = makeTreesDir()
    await initTree(treesDir, 'commv')
    await addWorkerLeaf(treesDir, 'commv', 'commv-worker')
    await treeEngine.run('communication', ['log', 'commv', '--to', 'commv-worker'], treesDir)

    const v = await treeEngine.run('validate', ['commv'], treesDir)
    expect(v.ok).toBe(true)
  })
})

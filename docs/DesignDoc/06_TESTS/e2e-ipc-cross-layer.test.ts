/**
 * e2e-ipc-cross-layer.test.ts — 跨层 E2E：IPC handler → engine-factory → 真实引擎 → LLM mock
 *
 * 目标（macp11-S1，补 macp10 "真系统 E2E" 拖分 -6）：
 *   超越 06_TESTS/e2e-coder-judge.test.ts 的"进程内集成"（直接 createCoderEngine().generateCode()），
 *   本测试覆盖完整跨层链路：
 *
 *     ipcMain.handle 注册的 handler（main.ts registerIpcHandlers）
 *       → handler 调用 engine-factory createEngines() 产出的真实 CoderEngine / JudgeEngine
 *         → 真实引擎方法（CoderEngine.generateCode / JudgeEngine.evaluateDocs）
 *           → 注入的 mock LlmClient（generate / evaluateSoft）
 *             → ApiResponse 信封（ok / requestId / data / durationMs）
 *
 *   与进程内集成的本质区别（多了的一层）：
 *     e2e-coder-judge.test.ts L96：直接 `createCoderEngine({llm}).generateCode(input)` —— 绕过 IPC handler。
 *     本测试：handler 经 ipcMain.handle 真注册（vi.mock('electron') 的 ipcMain.handle spy 留证），
 *     再经 handler 闭包路由到 engine → LLM → 信封。多出来的就是 main.ts L144 registerIpcHandlers
 *     这一层 IPC 路由（20 端点 channel → handler 的映射 + ApiResponse 信封化）。
 *
 * testability hook（最小改动，见 S1-e2e-report.md §testability hook）：
 *   - main.ts registerIpcHandlers(engines?) 接受可选注入 + export，缺省回退模块私有（业务路径不变）
 *   - engine-factory.ts EngineFactoryOpts 加 coderSandbox? / coderSnapshot?（避开真子进程 spawn）
 *
 * 隔离策略（不烧 token + 不依赖环境）：
 *   - vi.mock('electron')：ipcMain.handle/on 把 handler 存进内存 Map；app.whenReady 返回 pending
 *     promise → main.ts 模块 import 时不触发 app lifecycle side-effect（initEngines/createWindow 不跑）
 *   - vi.spyOn(globalThis, 'fetch') 网络守卫：任一用例若真触网则 fail（硬证据未烧 token）
 *   - fakeSandbox / fakeSnapshot：避开真子进程 spawn 与硬链接快照，闭环结构本身真实
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';

// ──────────────────────────────────────────────────────────────────────
// vi.hoisted：ipcHandlers Map 在 vi.mock factory 与测试用例间共享
// （vi.mock 被 vitest 提升到文件顶部，factory 内引用的变量必须经 vi.hoisted 提升）
// ──────────────────────────────────────────────────────────────────────
const { ipcHandlers } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    // 注册时把 handler 存进 Map（让测试能取出直接调用）+ 自身是 spy（断言 toHaveBeenCalledWith）
    handle: vi.fn((ch: string, fn: (...a: unknown[]) => unknown) => {
      ipcHandlers.set(ch, fn);
    }),
    on: vi.fn((ch: string, fn: (...a: unknown[]) => unknown) => {
      ipcHandlers.set(ch, fn);
    }),
    removeAllListeners: vi.fn(),
  },
  app: {
    // 返回永不 resolve 的 pending promise → main.ts app.whenReady().then(...) 回调永不执行
    // → initEngines / registerIpcHandlers / createWindow 的 side-effect 不触发（测试隔离）
    whenReady: () => new Promise<never>(() => {}),
    on: vi.fn(),
    quit: vi.fn(),
    getPath: vi.fn(() => ''),
  },
  BrowserWindow: class MockBrowserWindow {
    static getAllWindows(): unknown[] {
      return [];
    }
    loadURL(): void {}
    loadFile(): void {}
    on(): void {}
    once(): void {}
    show(): void {}
    webContents = { openDevTools(): void {}, send(): void {} };
  },
}));

// vi.mock 提升后，以下 import 拿到的是 mock 版 electron
import { ipcMain } from 'electron';
import { registerIpcHandlers } from '../electron/main';
import { createEngines } from '../electron/engine-factory';
import { CoderEngine } from '../src/coder/coder-engine-stub';
import type {
  L0IsolationConfig,
  SpawnInput,
  SpawnOutput,
} from '../src/sandbox/types';
import type {
  CreateSnapshotInput,
  CreateSnapshotOutput,
  ListSnapshotsInput,
  ListSnapshotsOutput,
} from '../src/snapshot/types';
import type { ApiResponse } from '../src/common/api-response';
import type { CodeGenResult } from '../src/coder/types';
import type { VerdictResult } from '../src/judge/types';
import { buildProject, cleanupFixtures } from './_helpers/project-fixture';

type FetchSpy = ReturnType<typeof vi.spyOn>;
let fetchSpy: FetchSpy;

beforeEach(() => {
  // 网络守卫：全程替换 fetch，用例末尾断言 not.toHaveBeenCalled = 未烧 token 硬证据
  fetchSpy = vi
    .spyOn(globalThis as unknown as { fetch: unknown }, 'fetch')
    .mockResolvedValue(new Response('{}', { status: 200 }));
});

afterEach(() => {
  fetchSpy.mockRestore();
  ipcHandlers.clear();
  vi.mocked(ipcMain.handle).mockClear();
  vi.mocked(ipcMain.on).mockClear();
  cleanupFixtures();
});

/** fake sandbox：prepareIsolation + spawnIsolated 不碰真子进程（参考 e2e-coder-judge.test.ts）。 */
function fakeSandbox() {
  return {
    prepareIsolation: (root: string): L0IsolationConfig => ({
      projectRoot: root,
      cwd: root,
      envRemap: {},
      allowedReadPaths: [root],
      forbiddenParentPaths: [],
      denyAbsolutePaths: [],
    }),
    spawnIsolated: vi.fn(async (_input: SpawnInput): Promise<SpawnOutput> => ({
      sandboxId: 'e2e-ipc-sandbox',
      pid: 9921,
      exitCode: 0,
      stdout: 'PASS e2e-ipc-cross-layer-handler',
      stderr: '',
      durationMs: 7,
      killed: false,
      usage: {
        sandboxId: 'e2e-ipc-sandbox',
        memoryBytes: 0,
        cpuTimeMs: 0,
        diskBytes: 0,
        childProcessCount: 0,
        wallClockMs: 7,
        sampledAt: new Date().toISOString(),
      },
    })),
  };
}

/** fake snapshotManager：createSnapshot / listSnapshots 不碰真磁盘硬链接。 */
function fakeSnapshot() {
  return {
    createSnapshot: vi.fn(
      async (_input: CreateSnapshotInput): Promise<CreateSnapshotOutput> => ({
        snapshotId: 1,
        filePath: '_e2e_ipc_fake',
        isCurrent: true,
        previousCurrentCleared: false,
        hardlinkedFiles: 0,
      }),
    ),
    listSnapshots: vi.fn(
      async (_input: ListSnapshotsInput): Promise<ListSnapshotsOutput> => ({
        snapshots: [],
        currentSnapshotId: null,
        totalCount: 0,
      }),
    ),
  };
}

describe('e2e: IPC handler 跨层 → engine-factory → 真实引擎 → LLM mock（超越进程内集成）', () => {
  it('handler 真注册到 ipcMain：registerIpcHandlers(bundle) 注册 coder/judge 关键 channel', async () => {
    const bundle = await createEngines({
      coderLlm: { generate: vi.fn(async () => ({ text: '', tokensUsed: 0, finishReason: 'stop' })) },
      judgeLlm: { evaluateSoft: vi.fn(async () => ({ score: 0.5, message: '' })) },
    });

    registerIpcHandlers(bundle);

    // 关键 channel 已注册到 ipcMain.handle 的内存 Map
    expect(ipcHandlers.has('coder:generateCode')).toBe(true);
    expect(ipcHandlers.has('coder:applyFix')).toBe(true);
    expect(ipcHandlers.has('coder:runGwt')).toBe(true);
    expect(ipcHandlers.has('judge:evaluateDocs')).toBe(true);
    expect(ipcHandlers.has('judge:evaluateCode')).toBe(true);

    // ipcMain.handle spy 留证：handler 确实经 ipcMain.handle 注册（非测试直调引擎）
    expect(vi.mocked(ipcMain.handle)).toHaveBeenCalledWith(
      'coder:generateCode',
      expect.any(Function),
    );
    expect(vi.mocked(ipcMain.handle)).toHaveBeenCalledWith(
      'judge:evaluateDocs',
      expect.any(Function),
    );
    // telemetry:emit / emitBatch 经 ipcMain.on（fire-and-forget）
    expect(vi.mocked(ipcMain.on)).toHaveBeenCalledWith(
      'telemetry:emit',
      expect.any(Function),
    );

    // 网络守卫：注册阶段不应触网
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('coder:generateCode handler → engine-factory 真实 CoderEngine → mockLlm.generate 被调 → ApiResponse 信封完整', async () => {
    const root = buildProject('e2e-ipc-gencode');
    const outputDir = path.join(root, '_code');

    const mockCoderLlm = {
      generate: vi.fn(async () => ({
        text: "console.log('generated via IPC cross-layer mock LLM');",
        tokensUsed: 17,
        finishReason: 'stop' as const,
      })),
    };

    // engine-factory 走注入路径：coderLlm + coderSandbox + coderSnapshot 全注入
    const bundle = await createEngines({
      coderLlm: mockCoderLlm,
      coderSandbox: fakeSandbox() as never,
      coderSnapshot: fakeSnapshot() as never,
    });

    // 断言①：engine-factory 返回真实 CoderEngine 实例（非 stub fallback / 非空壳）
    expect(bundle.coderEngine).toBeInstanceOf(CoderEngine);

    registerIpcHandlers(bundle);

    // 从 ipcMain.handle 注册的 Map 取出 handler（模拟 renderer 经 IPC 调用主进程）
    const handler = ipcHandlers.get('coder:generateCode') as (
      e: unknown,
      req: unknown,
    ) => Promise<ApiResponse<CodeGenResult>>;

    const res = await handler(
      {}, // mock IpcMainInvokeEvent
      {
        projectRoot: root,
        documentPaths: ['01_PRD/prd.md'],
        stage: 'coding',
        template: 'cli-script',
        outputDir,
      },
    );

    // 断言②：response envelope 字段完整（ok / requestId / durationMs / data 至少 4 字段）
    expect(res.ok).toBe(true);
    expect(typeof res.requestId).toBe('string');
    expect(res.requestId.length).toBeGreaterThan(0);
    expect(typeof res.durationMs).toBe('number');
    expect(res.durationMs).toBeGreaterThanOrEqual(0);
    expect(res.data?.outputFiles.length).toBeGreaterThan(0);
    expect(res.data?.tokensUsed).toBeGreaterThan(0);
    expect(res.data?.snapshotCreated).toBe(true);

    // 断言③：LLM mock 真被调（间接证明 handler → 真实引擎 → LLM 链路，非 stub 直返）
    expect(mockCoderLlm.generate).toHaveBeenCalled();

    // 断言④：写盘真实（coder 引擎真把 LLM 输出写到 outputDir/src/cli.ts）
    const cliEntry = path.join(outputDir, 'src', 'cli.ts');
    expect(fs.existsSync(cliEntry)).toBe(true);
    expect(fs.readFileSync(cliEntry, 'utf8')).toContain('IPC cross-layer mock LLM');

    // 网络守卫：全程未触网
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('judge:evaluateDocs handler → engine-factory 真实 JudgeEngine → mockLlm.evaluateSoft 被调 4 次 → 信封完整', async () => {
    const root = buildProject('e2e-ipc-judge');

    const mockJudgeLlm = {
      evaluateSoft: vi.fn(async (_input: { dimension: string }) => ({
        score: 0.91,
        message: 'ipc-cross-layer-mock',
      })),
    };

    const bundle = await createEngines({
      coderLlm: { generate: vi.fn(async () => ({ text: '', tokensUsed: 0, finishReason: 'stop' })) },
      judgeLlm: mockJudgeLlm,
    });

    registerIpcHandlers(bundle);

    const handler = ipcHandlers.get('judge:evaluateDocs') as (
      e: unknown,
      req: unknown,
    ) => Promise<ApiResponse<VerdictResult>>;

    const res = await handler(
      {},
      {
        projectRoot: root,
        targetDirectory: 'all',
        enableSoftEval: true,
      },
    );

    // 信封字段完整
    expect(res.ok).toBe(true);
    expect(typeof res.requestId).toBe('string');
    expect(res.requestId.length).toBeGreaterThan(0);
    expect(typeof res.durationMs).toBe('number');
    expect(res.durationMs).toBeGreaterThanOrEqual(0);

    // 真实判定结果：合规 fixture → verdict=pass + 4 维度 softSuggestions
    expect(res.data?.verdict).toBe('pass');
    expect(res.data?.hardViolations).toEqual([]);
    expect(res.data?.softSuggestions.length).toBe(4);

    // LLM mock 真被调 4 次（4 软约束维度），证明 handler → 真实 JudgeEngine → LLM 链路
    expect(mockJudgeLlm.evaluateSoft).toHaveBeenCalledTimes(4);

    // 网络守卫
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

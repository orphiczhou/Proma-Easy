/**
 * unit-llm-mock.test.ts — mock LlmClient 注入与 "不烧 token" 守卫单元测试。
 *
 * 目标 (对齐 dod.self_check 第 5 条):
 *   - createCoderEngine({ llm: vi.fn }) → generateCode 走注入的 mock, 不实例化真 LLM 调用链。
 *   - createJudgeEngine({ llm }) → evaluateSoft 被调 4 次 (4 维度), softSuggestions 来自 mock。
 *   - createEngines({ coderLlm, judgeLlm }) 工厂注入: 两个引擎都使用注入的 mock。
 *   - 全程 fetch 不被调用 = 未烧 token 的硬证据 (vi.spyOn 网络守卫)。
 *
 * mock 策略 (与 engine-factory.ts 注释推荐一致, 最薄耦合):
 *   - DI 注入 vi.fn() mock LlmClient (比 vi.mock 模块替换耦合更低)。
 *   - fake sandbox / fake snapshotManager 避开真子进程与磁盘快照副作用。
 *   - vi.spyOn(globalThis, 'fetch') 作为网络守卫: 任一用例若真触网则 fail。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import { createCoderEngine } from '../src/coder/coder-engine-stub';
import { createJudgeEngine } from '../src/judge/judge-engine-stub';
import { createEngines } from '../electron/engine-factory';
import type { L0IsolationConfig, SpawnInput, SpawnOutput } from '../src/sandbox/types';
import type {
  CreateSnapshotInput,
  CreateSnapshotOutput,
  ListSnapshotsInput,
  ListSnapshotsOutput,
} from '../src/snapshot/types';
import { buildProject, cleanupFixtures } from './_helpers/project-fixture';

type FetchSpy = ReturnType<typeof vi.spyOn>;
let fetchSpy: FetchSpy;

beforeEach(() => {
  // 网络守卫: 把全局 fetch 替换成永远不触网的 mock; 用例末尾断言 not.toHaveBeenCalled
  fetchSpy = vi
    .spyOn(globalThis as unknown as { fetch: unknown }, 'fetch')
    .mockResolvedValue(new Response('{}', { status: 200 }));
});

afterEach(() => {
  fetchSpy.mockRestore();
  cleanupFixtures();
});

/** coder 单测用 fake sandbox: prepareIsolation + spawnIsolated 都不碰真子进程。 */
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
      sandboxId: 'fake-sandbox',
      pid: 1234,
      exitCode: 0,
      stdout: 'PASS mock-scenario',
      stderr: '',
      durationMs: 3,
      killed: false,
      usage: {
        sandboxId: 'fake-sandbox',
        memoryBytes: 0,
        cpuTimeMs: 0,
        diskBytes: 0,
        childProcessCount: 0,
        wallClockMs: 3,
        sampledAt: new Date().toISOString(),
      },
    })),
  };
}

/** coder 单测用 fake snapshotManager: createSnapshot / listSnapshots 不碰真磁盘索引。 */
function fakeSnapshot() {
  return {
    createSnapshot: vi.fn(
      async (_input: CreateSnapshotInput): Promise<CreateSnapshotOutput> => ({
        snapshotId: 1,
        filePath: '_fake',
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

describe('mock LlmClient 注入 (DI, 不烧 token)', () => {
  it('createCoderEngine({llm}) → generateCode 走 mock.generate, fetch 不被调', async () => {
    const mockGenerate = vi.fn(async () => ({
      text: "console.log('mock-code');",
      tokensUsed: 7,
      finishReason: 'stop' as const,
    }));
    const root = buildProject('llmmock-coder');
    const outputDir = path.join(root, '_code');

    const engine = createCoderEngine({
      llm: { generate: mockGenerate },
      sandbox: fakeSandbox() as never,
      snapshotManager: fakeSnapshot() as never,
    });

    const res = await engine.generateCode({
      projectRoot: root,
      documentPaths: ['01_PRD/prd.md'],
      stage: 'coding',
      template: 'cli-script',
      outputDir,
    });

    expect(res.ok).toBe(true);
    expect(mockGenerate).toHaveBeenCalled();
    expect(res.data?.outputFiles.length).toBeGreaterThan(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('createJudgeEngine({llm}) → evaluateSoft 被调 4 次, softSuggestions 来自 mock', async () => {
    const root = buildProject('llmmock-judge');
    const mockEvaluateSoft = vi.fn(async (input: { dimension: string }) => ({
      score: 0.88,
      message: `mock-${input.dimension}`,
    }));
    const engine = createJudgeEngine({ llm: { evaluateSoft: mockEvaluateSoft } });

    const res = await engine.evaluateDocs({
      projectRoot: root,
      targetDirectory: 'all',
      enableSoftEval: true,
    });

    expect(res.ok).toBe(true);
    expect(res.data?.verdict).toBe('pass');
    expect(mockEvaluateSoft).toHaveBeenCalledTimes(4);
    expect(res.data?.softSuggestions.length).toBe(4);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('createEngines({judgeLlm}) 工厂注入 → judgeEngine 使用注入的 mock', async () => {
    const root = buildProject('llmmock-factory');
    const mockJudgeLlm = {
      evaluateSoft: vi.fn(async () => ({ score: 0.77, message: 'factory-mock' })),
    };
    // 传 opts → createEngines 跳过 dynamic import, 直接用注入的 mock
    const bundle = await createEngines({ judgeLlm: mockJudgeLlm as never });

    expect(bundle.coderEngine).toBeDefined();
    expect(bundle.judgeEngine).toBeDefined();

    const res = await bundle.judgeEngine.evaluateDocs({
      projectRoot: root,
      targetDirectory: 'all',
      enableSoftEval: true,
    });

    expect(res.ok).toBe(true);
    expect(mockJudgeLlm.evaluateSoft).toHaveBeenCalledTimes(4);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * unit-coder-gwt-autofix.test.ts — 缺陷3 修复探针（macp10-R1-worker）。
 *
 * 目标（对齐 dod.self_check 第 5 条 + must_report「探针发现 patch 未真应用」）：
 *   1. monkey-patch llm.generate 返回固定 patch 块 → 断言 patch 真写入磁盘 + spawnSafely 重跑发生 + allPassed。
 *   2. llm.generate 返回非空但非法 patch（无 <<<FILE>>> 块）→ 断言 autofixLog 记 patchError + 不重跑（break，不静默）。
 *
 * 验证治既往空转（缺陷3 根因）：原实现 fixOut.text 生成后直接重跑 GWT 从未写文件 →
 *   代码未变 → failedBefore==failedAfter → fixedScenarios 恒空 → 循环耗尽 AUTOFIX_MAX_ATTEMPTS=3 仍失败 = 假修复。
 *
 * mock 策略（对齐 unit-llm-mock.test.ts 的最薄耦合）：
 *   - DI 注入 vi.fn() mock LlmClient.generate（比 vi.mock 模块替换耦合更低）。
 *   - fake sandbox：prepareIsolation 真返回；spawnIsolated 按调用序 fail→pass，vi.fn 计数重跑次数。
 *   - fake snapshotManager 避开真磁盘快照副作用。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createCoderEngine } from '../src/coder/coder-engine-stub';
import type { L0IsolationConfig, SpawnInput, SpawnOutput } from '../src/sandbox/types';
import type {
  CreateSnapshotInput,
  CreateSnapshotOutput,
  ListSnapshotsInput,
  ListSnapshotsOutput,
} from '../src/snapshot/types';
import { buildProject, cleanupFixtures } from './_helpers/project-fixture';

beforeEach(() => {
  // 网络守卫：autofix 链路全程 mock，不应触网
  vi.spyOn(globalThis as unknown as { fetch: unknown }, 'fetch').mockResolvedValue(
    new Response('{}', { status: 200 }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanupFixtures();
});

/** fake snapshotManager：createSnapshot / listSnapshots 不碰真磁盘索引。 */
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

/**
 * fake sandbox：prepareIsolation 真返回 L0IsolationConfig；
 * spawnIsolated 按调用序返回（第 0 次 → firstOut，其后 → thenOut），用 vi.fn 计数重跑次数。
 */
function fakeSandbox(firstOut: SpawnOutput, thenOut: SpawnOutput) {
  let callCount = 0;
  const spawnIsolated = vi.fn(async (_input: SpawnInput): Promise<SpawnOutput> => {
    const out = callCount === 0 ? firstOut : thenOut;
    callCount++;
    return out;
  });
  return {
    prepareIsolation: (root: string): L0IsolationConfig => ({
      projectRoot: root,
      cwd: root,
      envRemap: {},
      allowedReadPaths: [root],
      forbiddenParentPaths: [],
      denyAbsolutePaths: [],
    }),
    spawnIsolated,
  };
}

/** 构造 SpawnOutput（统一 usage 字段，避免每个 case 重复）。 */
function spawnOut(exitCode: number, stdout: string, stderr = ''): SpawnOutput {
  return {
    sandboxId: 'fake-sandbox',
    pid: 1234,
    exitCode,
    stdout,
    stderr,
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
  };
}

const FEATURE_REL = '06_TESTS/features/doc-compliance.feature';

describe('缺陷3 修复探针：runGwt autofix 真应用 patch（macp10-R1）', () => {
  it('llm.generate 返回有效 patch 块 → patch 真写入磁盘 + spawnSafely 重跑发生 + allPassed', async () => {
    const root = buildProject('macp10-r1-probe-ok');
    const patchTargetRel = 'src/steps/doc-steps.ts';
    const fileBody = 'export const fixed = true;';
    // 固定 patch 块（buildGwtAutofixPrompt 约定的 <<<FILE>>><<<CONTENT>>><<<END>>> 格式）
    const patchText = `<<<FILE:${patchTargetRel}>>>\n<<<CONTENT>>>\n${fileBody}\n<<<END>>>`;
    // applyGwtAutofixPatch 去掉 CONTENT 标记后紧跟的首个换行 → 写入 = fileBody + '\n'
    const expectedWritten = `${fileBody}\n`;

    const mockGenerate = vi.fn(async () => ({
      text: patchText,
      tokensUsed: 5,
      finishReason: 'stop' as const,
    }));

    const sandbox = fakeSandbox(
      spawnOut(1, 'FAIL doc-compliance-scenario', 'step undefined'),
      spawnOut(0, 'PASS doc-compliance-scenario'),
    );

    const engine = createCoderEngine({
      llm: { generate: mockGenerate },
      sandbox: sandbox as never,
      snapshotManager: fakeSnapshot() as never,
    });

    const res = await engine.runGwt({
      projectRoot: root,
      featurePaths: [FEATURE_REL],
      stepDir: '06_TESTS/steps',
      enableAutofix: true,
    });

    // 断言 1：patch 真应用 — 目标文件落盘且内容精确匹配（治「生成但从未写入」空转）
    const written = fs.readFileSync(path.join(root, patchTargetRel), 'utf8');
    expect(written).toBe(expectedWritten);

    // 断言 2：spawnSafely 重跑发生 — spawnIsolated 被调 2 次（初始 fail + patch 应用后重跑 pass）
    expect(sandbox.spawnIsolated).toHaveBeenCalledTimes(2);

    // 断言 3：mock generate 被调 1 次（进入 autofix 循环，重跑后 failed=0 即 break）
    expect(mockGenerate).toHaveBeenCalledTimes(1);

    // 断言 4：重跑后 allPassed（失败 scenario 被真修掉，非假修复）
    expect(res.ok).toBe(true);
    expect(res.data?.allPassed).toBe(true);
    // autofixLog 无 patchError（patch 应用成功）
    expect(
      res.data?.autofixLog.every((e) => e.patchError === undefined),
    ).toBe(true);
  });

  it('llm.generate 返回非空但非法 patch → autofixLog 记 patchError + 不重跑（break，不静默）', async () => {
    const root = buildProject('macp10-r1-probe-bad');
    // 非空文本但不含任何 <<<FILE>>><<<CONTENT>>><<<END>>> 块 → applyGwtAutofixPatch 返回 error
    const mockGenerate = vi.fn(async () => ({
      text: '建议把 step 改成异步加载，但未按约定给 patch 块。',
      tokensUsed: 5,
      finishReason: 'stop' as const,
    }));

    const sandbox = fakeSandbox(
      spawnOut(1, 'FAIL doc-compliance-scenario', 'boom'),
      spawnOut(0, 'PASS doc-compliance-scenario'),
    );

    const engine = createCoderEngine({
      llm: { generate: mockGenerate },
      sandbox: sandbox as never,
      snapshotManager: fakeSnapshot() as never,
    });

    const res = await engine.runGwt({
      projectRoot: root,
      featurePaths: [FEATURE_REL],
      stepDir: '06_TESTS/steps',
      enableAutofix: true,
    });

    // 断言 1：spawnSafely 只被调 1 次（初始 fail；patch 应用失败 → break，未重跑）
    expect(sandbox.spawnIsolated).toHaveBeenCalledTimes(1);

    // 断言 2：autofixLog 含 patchError（非空 patch 解析失败被记录，非静默跳过）
    const log = res.data?.autofixLog ?? [];
    expect(log.length).toBeGreaterThan(0);
    expect(log[0].patchError).toBeTruthy();
    expect(typeof log[0].patchError).toBe('string');
    expect((log[0].patchError as string).length).toBeGreaterThan(10);

    // 断言 3：mock generate 被调 1 次（进入循环但 patch 失败即 break，未二次重试）
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });
});

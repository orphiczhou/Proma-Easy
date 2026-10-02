/**
 * unit-judge-timeout.test.ts — withSoftTimeout / createJudgeTimeoutError 单元测试。
 *
 * 目标 (对齐 dod.self_check 第 4 条):
 *   - 注入卡死 LLM (永不 resolve 的 Promise), withSoftTimeout 必须在 timeoutMs 后
 *     抛出携带 JUDGE_LLM_TIMEOUT code 的错误, 不让测试永久挂起。
 *   - createJudgeTimeoutError 产出的 Error.code === JUDGE_LLM_TIMEOUT。
 *   - 正常 resolve 的 Promise 不被超时误杀 (负向用例, 防假超时)。
 *
 * 注: judge.evaluateDocs.runSoftEval 直接调 this.llm.evaluateSoft, 超时机制封装在
 *     PromaCloudJudgeLlmClient.evaluateSoft 内部 (用 withSoftTimeout 包 chat)。
 *     故超时行为的最小可信测试单元 = withSoftTimeout 本身 (B2 真实现)。
 */
import { describe, it, expect } from 'vitest';
import {
  withSoftTimeout,
  createJudgeTimeoutError,
} from '../src/common/proma-cloud-llm-client';
import { JUDGE_ERROR_CODE } from '../src/common/error-codes';

/** 局部最小类型, 避免 timeout 测试耦合 judge engine 模块加载。 */
interface SoftEvalOutput {
  score: number;
  message: string;
}

describe('createJudgeTimeoutError', () => {
  it('产出的 Error 携带 .code === JUDGE_LLM_TIMEOUT 且 message 含 operation 标签', () => {
    const err = createJudgeTimeoutError('soft-eval-test');
    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { code?: string }).code).toBe(JUDGE_ERROR_CODE.LLM_TIMEOUT);
    expect(err.message).toContain('soft-eval-test');
    expect(err.message).toContain('JUDGE_LLM_TIMEOUT');
  });

  it('缺省 operation 参数也能产出 code === JUDGE_LLM_TIMEOUT', () => {
    const err = createJudgeTimeoutError();
    expect((err as Error & { code?: string }).code).toBe(JUDGE_ERROR_CODE.LLM_TIMEOUT);
  });
});

describe('withSoftTimeout', () => {
  it('卡死 LLM (never-resolve) + createJudgeTimeoutError onTimeout → 抛 JUDGE_LLM_TIMEOUT', async () => {
    const hungLlm: Promise<SoftEvalOutput> = new Promise<SoftEvalOutput>(() => {
      // 故意永不 resolve, 模拟 LLM 调用挂死
    });
    const start = Date.now();
    let caught: unknown = null;
    try {
      await withSoftTimeout(hungLlm, 60, () => createJudgeTimeoutError('soft-eval'));
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - start;

    expect(caught).not.toBeNull();
    const e = caught as Error & { code?: string };
    expect(e.code).toBe(JUDGE_ERROR_CODE.LLM_TIMEOUT);
    // 超时窗口可信: 不早于 ~50ms, 不晚于 1s (防 timer 失灵假绿)
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(1000);
  });

  it('正常 resolve 在超时前 → 返回值原样透传, 不被超时误杀', async () => {
    const fast: Promise<SoftEvalOutput> = Promise.resolve({
      score: 0.92,
      message: 'ok-from-llm',
    });
    const result = await withSoftTimeout(fast, 2000, () =>
      createJudgeTimeoutError('should-not-fire'),
    );
    expect(result).toEqual({ score: 0.92, message: 'ok-from-llm' });
  });

  it('默认 onTimeout (不传回调) → 抛通用 Error("timeout")', async () => {
    const hung = new Promise<string>(() => {
      // 永不 resolve
    });
    await expect(withSoftTimeout(hung, 40)).rejects.toThrow(/timeout/i);
  });

  it('模拟 evaluateSoft 卡死被 withSoftTimeout 兜底 (engine 内部使用模式)', async () => {
    // 重现 PromaCloudJudgeLlmClient.evaluateSoft 内部用法:
    //   const out = await withSoftTimeout(this.cloudClient.chat(...), timeoutMs, () => createJudgeTimeoutError(dim));
    // 注入一个永不 resolve 的 chat() 模拟网络挂死。
    const hungChat: Promise<SoftEvalOutput> = new Promise<SoftEvalOutput>(() => {});
    let caught: unknown = null;
    try {
      await withSoftTimeout(hungChat, 50, () => createJudgeTimeoutError('readability'));
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect((caught as Error & { code?: string }).code).toBe(JUDGE_ERROR_CODE.LLM_TIMEOUT);
  });
});

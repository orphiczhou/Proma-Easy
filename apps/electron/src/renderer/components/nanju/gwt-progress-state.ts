import type { NanjuGwtProgressData } from '@proma/shared'

/** 场景/脚本计数不能替代全套验收裁决，进度卡片不提供交付授权。 */
export function describeGwtProgress(data: NanjuGwtProgressData): { running: boolean; title: string; percent: number; failed: boolean; blocked: boolean } {
  const running = data.phase !== 'done'
  const failed = data.verdict === 'fail' || data.verdict === 'error' || data.failed > 0
  const blocked = data.verdict === 'blocked'
  const title = running ? data.phase === 'approval' ? '等待本项测试批准' : '正在验收测试'
    : blocked ? '验收测试已阻塞'
      : data.verdict === 'error' ? '验收测试执行异常'
        : failed ? '验收测试未通过'
          : data.verdict === 'pass' ? '验收测试全部通过'
            : data.scope === 'engineering' ? '测试执行结束，等待最终裁决'
              : data.skipped > 0 ? '测试执行结束，存在跳过项' : '场景执行通过，等待最终裁决'
  return { running, title, failed, blocked, percent: data.total > 0 ? Math.min(100, Math.max(0, Math.round(data.current / data.total * 100))) : 0 }
}

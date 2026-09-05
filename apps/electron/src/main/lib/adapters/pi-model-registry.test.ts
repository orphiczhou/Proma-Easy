import { describe, expect, test } from 'bun:test'
import type { PiAgentQueryOptions } from './pi-agent-adapter'
import { CODEX_GPT_56_CONTEXT_WINDOW, ONE_MILLION_CONTEXT_WINDOW } from '@proma/shared'
import { buildModel, resolvePiModelDefaults } from './pi-model-registry'

/**
 * 验证模型注册链路（resolvePiModelDefaults → modelRuntime.registerProvider 的
 * contextWindow 字段）真正消费 shared 推断结果，而非仅前端展示。
 * 使用真实 pi-ai catalog：折扣档后缀 ID 在任何目录均无精确条目，
 * 应落到 inferred = 1M 并经 Math.max(catalog, inferred) 注册。
 */
function minimalQueryOptions(model: string): PiAgentQueryOptions {
  return {
    provider: 'openai-responses',
    model,
    apiKey: 'test-key',
    baseUrl: 'https://relay.example.com/v1',
  } as unknown as PiAgentQueryOptions
}

describe('resolvePiModelDefaults — GPT 折扣档/Azure 中转别名的注册窗口', () => {
  test.each([
    'gpt-5.6-terra-1',
    'gpt-5.6-terra-az',
    'gpt-5.6-sol-1',
    'gpt-5.6-sol-az',
    'gpt-6-astra-1',
  ])('%s 注册 contextWindow = 1M（真实 catalog miss → shared 推断生效）', async (model) => {
    const defaults = await resolvePiModelDefaults(minimalQueryOptions(model))
    expect(defaults.contextWindow).toBe(ONE_MILLION_CONTEXT_WINDOW)
  })

  test('裸 Codex 型号 gpt-5.6-terra 注册保持 Codex 基线 372k（对齐优先级不回退）', async () => {
    const defaults = await resolvePiModelDefaults(minimalQueryOptions('gpt-5.6-terra'))
    expect(defaults.contextWindow).toBe(CODEX_GPT_56_CONTEXT_WINDOW)
  })

  test('未知 GPT 变体注册保持 catalog/inferred 兜底（不误放宽）', async () => {
    const defaults = await resolvePiModelDefaults(minimalQueryOptions('gpt-5.6-terra-pro'))
    expect(defaults.contextWindow).toBeLessThan(ONE_MILLION_CONTEXT_WINDOW)
  })
})

/** fake PiSdk：依赖注入捕获 registerProvider 实参，不使用 mock.module，避免跨测试文件污染。 */
function createCapturingSdk() {
  const registered: Array<{ providerName: string; config: Record<string, unknown> }> = []
  const modelsById = new Map<string, Record<string, unknown>>()
  const runtime = {
    registerProvider: (providerName: string, config: Record<string, unknown>) => {
      registered.push({ providerName, config })
      for (const model of config.models as Array<Record<string, unknown>>) {
        modelsById.set(`${providerName}::${model.id}`, model)
      }
    },
    getModel: (provider: string, modelId: string) => modelsById.get(`${provider}::${modelId}`),
  }
  const sdk = {
    ModelRuntime: { create: async () => runtime },
  } as Parameters<typeof buildModel>[0]
  return { sdk, registered }
}

function buildModelOptions(model: string): PiAgentQueryOptions {
  return {
    provider: 'openai-responses',
    model,
    apiKey: 'test-key',
    baseUrl: 'https://relay.example.com/v1',
    sessionId: 'capture-test',
  } as unknown as PiAgentQueryOptions
}

/** 提取唯一一次 registerProvider 调用的首个模型；缺失时直接抛错让用例失败。 */
function soleRegisteredModel(
  registered: Array<{ providerName: string; config: Record<string, unknown> }>,
): Record<string, unknown> {
  const config = registered[0]?.config
  const model = (config?.models as Array<Record<string, unknown>> | undefined)?.[0]
  if (!model) throw new Error('buildModel 未注册任何模型')
  return model
}

describe('buildModel — registerProvider 注册捕获（真实 defaults 链路）', () => {
  test('gpt-5.6-terra-1 注册进 Pi ModelRuntime 的 model 带 contextWindow=1M 且 id 未被改写', async () => {
    const { sdk, registered } = createCapturingSdk()
    const { model } = await buildModel(sdk, buildModelOptions('gpt-5.6-terra-1'))
    expect(registered).toHaveLength(1)
    const registeredModel = soleRegisteredModel(registered)
    expect(registeredModel.id).toBe('gpt-5.6-terra-1')
    expect(registeredModel.contextWindow).toBe(ONE_MILLION_CONTEXT_WINDOW)
    // 返回的 model 即注册对象本身：同 id 同窗口，注册链路闭环
    expect(model.id).toBe('gpt-5.6-terra-1')
    expect(model.contextWindow).toBe(ONE_MILLION_CONTEXT_WINDOW)
  })

  test('gpt-5.6-terra-az / gpt-6-astra-1 同样注册 1M', async () => {
    for (const modelId of ['gpt-5.6-terra-az', 'gpt-6-astra-1']) {
      const { sdk, registered } = createCapturingSdk()
      await buildModel(sdk, buildModelOptions(modelId))
      const registeredModel = soleRegisteredModel(registered)
      expect(registeredModel.id).toBe(modelId)
      expect(registeredModel.contextWindow).toBe(ONE_MILLION_CONTEXT_WINDOW)
    }
  })

  test('裸型号 gpt-5.6-terra 注册保持 Codex 基线 372k（捕获层不回退）', async () => {
    const { sdk, registered } = createCapturingSdk()
    await buildModel(sdk, buildModelOptions('gpt-5.6-terra'))
    const registeredModel = soleRegisteredModel(registered)
    expect(registeredModel.contextWindow).toBe(CODEX_GPT_56_CONTEXT_WINDOW)
  })
})

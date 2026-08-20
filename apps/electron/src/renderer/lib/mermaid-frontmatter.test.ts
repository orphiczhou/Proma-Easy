import { describe, expect, test } from 'bun:test'
import { extractFrontMatter } from '../../../../../packages/ui/src/mermaid-block/MermaidBlock.tsx'

/**
 * renderMermaidSvg 兼容层测试：mermaid v11 已移除 front matter 支持，
 * extractFrontMatter 负责剥离 config 头并把 flowchart 布局参数转交渲染器。
 */
describe('extractFrontMatter（mermaid front matter 兼容层）', () => {
  test('剥离 v10 风格 config 头并提取布局参数', () => {
    const dsl = [
      '---',
      'config:',
      '  flowchart:',
      '    nodeSpacing: 28',
      '    rankSpacing: 36',
      '    padding: 6',
      '---',
      'flowchart TD',
      '    A["节点"] --> B{"模式"}',
    ].join('\n')
    const { cleanCode, flow } = extractFrontMatter(dsl)
    expect(cleanCode.startsWith('flowchart TD')).toBe(true)
    expect(cleanCode.includes('nodeSpacing')).toBe(false)
    expect(flow).toEqual({ nodeSpacing: 28, rankSpacing: 36, padding: 6 })
  })

  test('无 front matter 时原样返回且 flow 为空', () => {
    const dsl = 'flowchart TD\n    A --> B'
    const { cleanCode, flow } = extractFrontMatter(dsl)
    expect(cleanCode).toBe(dsl)
    expect(flow).toEqual({})
  })

  test('config 头缺字段时仅提取存在的项', () => {
    const dsl = [
      '---',
      'config:',
      '  flowchart:',
      '    nodeSpacing: 28',
      '---',
      'flowchart LR',
      '    X --> Y',
    ].join('\n')
    const { cleanCode, flow } = extractFrontMatter(dsl)
    expect(cleanCode.startsWith('flowchart LR')).toBe(true)
    expect(flow).toEqual({ nodeSpacing: 28 })
  })

  test('小数间距值也能提取', () => {
    const dsl = [
      '---',
      'config:',
      '  flowchart:',
      '    rankSpacing: 36.5',
      '---',
      'flowchart TD\n    A --> B',
    ].join('\n')
    const { flow } = extractFrontMatter(dsl)
    expect(flow.rankSpacing).toBe(36.5)
  })
})

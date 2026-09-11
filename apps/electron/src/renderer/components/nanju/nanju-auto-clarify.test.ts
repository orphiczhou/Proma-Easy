/**
 * v2.4「自动补完需求」渲染端纯函数测试
 *
 * 1. resolveAutoClarifyAvailability（ModeSelectView）：复选框仅快消型可选
 * 2. stripRouteHeaderPrefix（AskUserBanner）：横幅展示剥「确认·」「设计·」「转述·」前缀
 *    （存储带前缀——auto 开启时路由规则消费；显示美观剥前缀，D7 §10）
 */
import { describe, expect, test } from 'bun:test'

const { resolveAutoClarifyAvailability } = await import('./ModeSelectView')
const { stripRouteHeaderPrefix } = await import('../agent/AskUserBanner')

describe('v2.4：自动补完复选框可用性（仅快消型）', () => {
  test('quick → available（复选框可选）', () => {
    expect(resolveAutoClarifyAvailability('quick')).toBe('available')
  })

  test('iterative → hidden（长期迭代型隐藏/禁用——升级即失效硬边界）', () => {
    expect(resolveAutoClarifyAvailability('iterative')).toBe('hidden')
  })
})

describe('v2.4：横幅 header 前缀剥离（stripRouteHeaderPrefix）', () => {
  test('三类路由前缀均剥：「确认·」「设计·」「转述·」', () => {
    expect(stripRouteHeaderPrefix('确认·原型交互验证')).toBe('原型交互验证')
    expect(stripRouteHeaderPrefix('确认·满意交付')).toBe('满意交付')
    expect(stripRouteHeaderPrefix('设计·快速修改')).toBe('快速修改')
    expect(stripRouteHeaderPrefix('转述·需求澄清')).toBe('需求澄清')
  })

  test('无前缀原样返回（普通会话/历史 header 不受影响）', () => {
    expect(stripRouteHeaderPrefix('预览确认')).toBe('预览确认')
    expect(stripRouteHeaderPrefix('')).toBe('')
    expect(stripRouteHeaderPrefix('其他问题')).toBe('其他问题')
  })

  test('纯前缀（空余部分）→ 空串（不残留分隔符）', () => {
    expect(stripRouteHeaderPrefix('确认·')).toBe('')
  })

  test('仅剥首个前缀，不重复剥（嵌套前缀不误伤）', () => {
    expect(stripRouteHeaderPrefix('确认·设计·双前缀')).toBe('设计·双前缀')
  })
})

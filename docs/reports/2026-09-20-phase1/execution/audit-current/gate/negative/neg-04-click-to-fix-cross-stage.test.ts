/**
 * neg-04：testing 点选跨阶段写 / 失效声明无程序化兑底（只读审计反例）
 * 对应 nanju-click-to-fix-policy.ts + nanju-ipc.ts:537 消费点。
 *
 * 关键现状引用：
 * - `const application = stage === 'coding' || stage === 'testing' || stage === 'delivered'`
 * - `mustRetest: stage === 'testing' || stage === 'delivered'`
 * - IPC 消费（nanju-ipc.ts）：testing 点选仅拼接文案 `'旧测试报告与交付确认已失效，修复后必须重新测试。'`
 *   —— 未见任何 clearProjectDeliveryAck / 清 report 的程序化调用（审计员 grep 确认仅一处 label 文本）。
 */
import { describe, expect, test } from 'bun:test'
import { clickToFixPolicy } from './nanju-click-to-fix-policy'

describe('neg-04 testing/delivered 点选的目标与重测语义', () => {
  test('testing：application=true、目标 08_APP、mustRetest=true、不回写 PRD（回归钉）', () => {
    expect(clickToFixPolicy('testing')).toEqual({
      application: true,
      target: '08_APP/',
      syncPrd: false,
      mustRetest: true,
    })
  })

  test('delivered：同 testing 语义（修复使旧交付事实失效）', () => {
    expect(clickToFixPolicy('delivered')).toEqual({
      application: true,
      target: '08_APP/',
      syncPrd: false,
      mustRetest: true,
    })
  })

  test('早期阶段（requirements/architecture/planning）点选只改原型/PRD 域，不触应用', () => {
    for (const stage of ['requirements', 'architecture', 'planning'] as const) {
      const policy = clickToFixPolicy(stage)
      expect(policy.application).toBe(false)
      expect(policy.syncPrd).toBe(true)
      expect(policy.mustRetest).toBe(false)
      expect(policy.target).toBe('02_UX_DESIGN/prototype.html')
    }
  })

  test('AUDIT-RED（现状契约面）：点选策略不区分「点选修改」与「需求级变更」——testing 阶段对 08_APP 的点选没有规模/语义分界', () => {
    // AUDIT-EXPECT：testing 阶段大规模点选修改（跨场景多元素、行为变更）应升级为
    // 「回 coding + 重测」流程而非走点选快速通道；现状 policy 是纯阶段映射，任何点选
    // （单色修改到批量行为变更）都同路放行，判界只由 LLM 消息措辞承担。
    // 以下断言固化现状：批量与否在 policy 层不可见。
    const policy = clickToFixPolicy('testing')
    expect(Object.keys(policy)).toEqual(['application', 'target', 'syncPrd', 'mustRetest'])
  })

  test('AUDIT-RED（现状契约面）：mustRetest 仅是布尔声明，无配套的失效执行动作接口', () => {
    // AUDIT-EXPECT：testing 点选修复后系统应程序化清除/标记失效：deliveryAck、
    // deliveryChallenge、06_TESTS/report.json 绑定的 runId（entryFingerprint 比对兑底）。
    // 现状返回结构中无任何失效动作字段，失效兑底完全依赖 GwtRunner 交付门禁的
    // fingerprint-mismatch 重算 —— 点选修改 08_APP 但 GWT 不重跑时，旧 pass 报告
    // 的 entryFingerprint 与新入口不一致会被交付门拦住（兑底存在），但「重测」本身
    // 没有 phase 状态强制（testing 重入机制可被跳过直到用户要求交付）。
    const policy = clickToFixPolicy('testing')
    expect(policy.mustRetest).toBe(true)
    // 消费点（nanju-ipc.ts）只做文本注入；此处以类型面固化缺口，具体程序化缺口见 gate.md F-04。
  })
})

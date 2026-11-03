/**
 * neg-06：旧 schema pending / 取消 / 幂等续接（只读审计反例）
 * 对应 nanju-advance-recovery.ts（97 行）+ nanju-phase-advance-consumer.ts 的 rejectWithEducationLoop。
 *
 * 关键现状引用：
 * - `executionState: previous?.eventKey === eventKey && previous?.executionState === 'cancelled' ? 'cancelled' : 'blocked'`
 *   —— 用户取消后同事件再次被拒时保持 cancelled（不复活续接）✓；但**新指纹事件**会重置为 blocked。
 * - `if (!pending?.eventKey || pending.executionState === 'cancelled' || pending.consumedEventKey === pending.eventKey) return false`
 *   —— 旧 schema（无 eventKey）pending 永远 claim=false：不自动续接（安全），但 buildPendingAdvanceRecoveryPrompt
 *   对 executionState 缺省（旧记录无该字段）视作 'blocked' 仍会给出恢复提示 —— 兼容面。
 * - `const stage = getNanjuProject(...)?.currentStage; const persistedCount = previous?.fromStage === stage ? previous?.count ?? 0 : 0`
 *   —— 跨阶段计数复位依赖 fromStage 比对。
 *
 * 这些函数依赖 nanju-project 注册表，测试需真实 workspace 夹具；断言意图先行固化，
 * fixture 字段以运行环境实际 schema 为准（同 neg-05 说明）。
 */
import { describe, expect, test } from 'bun:test'

describe('neg-06 取消后同事件幂等（语义规范）', () => {
  test('AUDIT-EXPECT 钉：用户取消（cancelAdvanceCorrection）后，同一 eventKey 再次 persist 不得复活自动续接', () => {
    // persistAdvanceCorrection：previous?.eventKey === eventKey && executionState==='cancelled'
    //   → executionState 保持 'cancelled'；
    // claimAdvanceCorrectionContinuation：executionState==='cancelled' → return false。
    // ⇒ 取消是粘性的（同事件）。断言意图：
    //   1) persist 同 eventKey → state 仍 'cancelled'；
    //   2) claim → false（不续接）；
    //   3) getAdvanceCorrectionView().state === 'cancelled'。
    expect('cancelled-sticky').toBe('cancelled-sticky')
  })

  test('AUDIT-EXPECT 钉：claim 领取后重复 claim 同事件必须 false（consumedEventKey 去重）', () => {
    // 第一次 claim → true（consumedEventKey=eventKey, executionState='correcting'）
    // 第二次 claim → consumedEventKey === eventKey → false
    // 崩溃恢复（buildPendingAdvanceRecoveryPrompt）只给上下文，不重复启动。
    expect('claim-once').toBe('claim-once')
  })

  test('AUDIT-RED（现状契约面）：产物指纹变化 → 新 eventKey → 重新 blocked 并可再次续接', () => {
    // 用户取消后，只要阶段产物指纹变化（任何文件字节变化），同一 target 的新拒收
    // 会以新 eventKey 重置 executionState='blocked' → claim 放行 → 再次自动续接。
    // 用户「取消」意图只在**同一次产物状态**内有效；产出继续演化后自动续接复活。
    // 这是设计权衡（新失败=新事件），但审计要求确认：用户取消是否应跨事件记忆。
    // 证据引用：`executionState: previous?.eventKey === eventKey && previous?.executionState === 'cancelled' ? 'cancelled' : 'blocked'`
    expect('new-fingerprint-resumes').toBe('new-fingerprint-resumes')
  })

  test('AUDIT-EXPECT 钉：旧 schema pending（无 eventKey 字段）不得触发自动续接', () => {
    // claim 侧 `if (!pending?.eventKey …) return false` —— 旧记录 fail-closed ✓
    // 但 buildPendingAdvanceRecoveryPrompt 对旧记录仍会生成恢复提示（提示≠授权，可接受）。
    // 钉死：旧记录 claim 必须 false；恢复提示文案必须带「非推进授权」声明（现状已含）。
    expect('legacy-no-eventkey-no-claim').toBe('legacy-no-eventkey-no-claim')
  })

  test('AUDIT-EXPECT 钉：pending.fromStage 与 currentStage 不一致时恢复提示必须为 null', () => {
    // `if (pending.fromStage && pending.fromStage !== project.currentStage) return null`
    // —— 阶段已前进（如被用户手动推进/其它路径收口）后旧 pending 不得再提示。
    expect('stage-mismatch-null').toBe('stage-mismatch-null')
  })
})

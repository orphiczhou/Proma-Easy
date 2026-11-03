/**
 * W24-EF F2（v0.17.123）：US-U02 quick 对话策略测试
 *
 * 测试范围（与 EF.md §3.2 BDD 对齐）：
 * 1. 极模糊输入识别 + 模糊回复模板含四个方向卡片标签；
 * 2. 连续 3 轮极模糊 → 第 4 轮 shouldStopProbing=true；
 * 3. 用户「先开始」意图即时退出（不再追问）；
 * 4. 需求摘要固定结构 + 「自动建议」标注 + 「具体包括/不包括」分段；
 * 5. 首轮 ≥3 问题 + 不含「数据库/前端/后端」技术术语结构校验。
 *
 * Bun 独立运行：`bun test apps/electron/src/main/lib/nanju-quick-dialog.test.ts`
 */
import { describe, expect, test } from 'bun:test'

import {
  AUTO_DECIDE_LABEL,
  AUTO_SUGGEST_TAG,
  QUICK_CLARIFY_MIN_QUESTIONS,
  QUICK_VAGUE_LOOP_LIMIT,
  buildRequirementSummary,
  buildVagueFallbackReply,
  buildVagueLoopExitReply,
  isUserStartIntent,
  isVagueInput,
  shouldStopProbing,
  validateQuickClarifyQuestions,
} from './nanju-quick-dialog'

describe('W24-EF F2：US-U02 极模糊识别 + 方向卡片模板', () => {
  test('Given 输入「做个软件」 When 判定 Then isVagueInput=true 且回复含四个方向卡片标签', () => {
    expect(isVagueInput('做个软件')).toBe(true)
    const reply = buildVagueFallbackReply()
    expect(reply).toContain('实用小工具')
    expect(reply).toContain('内容整理')
    expect(reply).toContain('可视化展示')
    expect(reply).toContain(AUTO_DECIDE_LABEL)
    // 防御性：方向卡片至少 4 项
    expect(reply.match(/\d\./g)?.length ?? 0).toBeGreaterThanOrEqual(4)
  })

  test('Given 超短输入（无意图动词且 <4 字） When 判定 Then isVagueInput=true', () => {
    expect(isVagueInput('')).toBe(true)
    expect(isVagueInput('   ')).toBe(true)
    expect(isVagueInput('想做')).toBe(true)
    expect(isVagueInput('做个')).toBe(true)
    expect(isVagueInput('帮我')).toBe(true)
  })

  test('Given 「做个记账工具」「做一个番茄钟」等动词+具体宾语 When 判定 Then isVagueInput=false（不误杀）', () => {
    expect(isVagueInput('做个记账工具')).toBe(false)
    expect(isVagueInput('做一个番茄钟')).toBe(false)
    expect(isVagueInput('做个倒计时')).toBe(false)
    expect(isVagueInput('帮我做个记录读书笔记的东西')).toBe(false)
  })

  test('Given 「做个软件」「帮我做个东西」等动词+泛化宾语 When 判定 Then isVagueInput=true', () => {
    expect(isVagueInput('做个软件')).toBe(true)
    expect(isVagueInput('帮我做个东西')).toBe(true)
    expect(isVagueInput('弄个工具')).toBe(true)
  })

  test('Given 含具体场景的明确输入 When 判定 Then isVagueInput=false', () => {
    expect(isVagueInput('能帮我按月汇总支出的记账工具，本地存储，支持 CSV 导出')).toBe(false)
    expect(isVagueInput('需要支持 markdown 语法，导出 PDF，并可加标签搜索')).toBe(false)
  })
})

describe('W24-EF F2：US-U02 模糊退出 + 用户意图退出', () => {
  test('Given 连续 3 轮极模糊（turns 含当前轮） When 第 4 轮仍模糊 Then shouldStopProbing=true', () => {
    const turns = [
      { userText: '想做', autoFilledDecisions: [] },      // 第 1 轮
      { userText: '做个', autoFilledDecisions: [] },      // 第 2 轮
      { userText: '弄个工具', autoFilledDecisions: [] },  // 第 3 轮
      { userText: '帮我做个东西', autoFilledDecisions: [] }, // 第 4 轮（本轮仍模糊）
    ]
    expect(shouldStopProbing(turns)).toBe(true)
    expect(QUICK_VAGUE_LOOP_LIMIT).toBe(3)
  })

  test('Given 只有 3 轮模糊（未到第 4 轮） When 判定 Then shouldStopProbing=false（防 off-by-one 早停）', () => {
    const turns = [
      { userText: '想做', autoFilledDecisions: [] },
      { userText: '做个', autoFilledDecisions: [] },
      { userText: '弄个工具', autoFilledDecisions: [] },
    ]
    expect(shouldStopProbing(turns)).toBe(false)
  })

  test('Given 第 4 轮退出 When 构建回复 Then buildVagueLoopExitReply 含「通用版本」与「随时告诉我」', () => {
    const reply = buildVagueLoopExitReply()
    expect(reply).toContain('通用版本')
    expect(reply).toContain('随时告诉我')
  })

  test('Given 2 轮模糊 + 1 轮明确 When 判定 Then shouldStopProbing=false（明确输入打破累计）', () => {
    const turns = [
      { userText: '想做', autoFilledDecisions: [] },
      { userText: '做个', autoFilledDecisions: [] },
      // 明确输入：不含「做个/弄个/想做个」意图词
      { userText: '需要按月汇总支出的记账，支持本地存与导出 CSV', autoFilledDecisions: [] },
    ]
    expect(shouldStopProbing(turns)).toBe(false)
  })

  test('Given 用户说「差不多了先开始吧」 When 判定 Then isUserStartIntent=true 且 shouldStopProbing=true', () => {
    expect(isUserStartIntent('差不多了先开始吧')).toBe(true)
    const turns = [
      { userText: '想做', autoFilledDecisions: [] },
      { userText: '差不多了先开始吧', autoFilledDecisions: [] },
    ]
    expect(shouldStopProbing(turns)).toBe(true)
  })

  test('Given 用户说「先做出来看看」 When 判定 Then isUserStartIntent=true（prompt 中提示先看预览）', () => {
    expect(isUserStartIntent('先做出来看看')).toBe(true)
    expect(isUserStartIntent('差不多就这样吧，开始实现')).toBe(true)
  })

  test('Given 裸「差不多」「先做」类非终止意图 When 判定 Then isUserStartIntent=false（不误停）', () => {
    expect(isUserStartIntent('我差不多明白了')).toBe(false)
    expect(isUserStartIntent('先做什么呢')).toBe(false)
    expect(isUserStartIntent('差不多了，还需要改一下')).toBe(false)
  })

  test('Given 空输入 When 判定 Then isUserStartIntent=false 且不退出', () => {
    expect(isUserStartIntent('')).toBe(false)
    expect(isUserStartIntent('   ')).toBe(false)
    expect(shouldStopProbing([{ userText: '', autoFilledDecisions: [] }])).toBe(false)
  })
})

describe('W24-EF F2：US-U02 需求摘要固定结构', () => {
  test('Given 一轮已自动填补 2 项决策 When 生成摘要 Then 两项标注「自动建议」且结构含「具体包括」「不包括」', () => {
    const summary = buildRequirementSummary(
      {
        oneLine: '做一个按月汇总支出的记账工具',
        included: ['按月分类支出', '数据本地存储', '导出 CSV'],
        excluded: ['多人协作', '云同步'],
      },
      ['数据本地存储', '导出 CSV'],
    )
    // 结构三段齐全
    expect(summary).toContain('我理解你想做的是：')
    expect(summary).toContain('具体包括：')
    expect(summary).toContain('不包括：')
    // 自动建议标注（仅在 included 中命中 autoFilled 时出现）
    expect(summary).toContain('（自动建议）')
    // 用户明示项不带标注
    expect(summary).toContain('- 按月分类支出')
    expect(summary.includes('- 按月分类支出（自动建议）')).toBe(false)
    // excluded 不带标注
    expect(summary).toContain('- 多人协作')
    expect(summary.includes('- 多人协作（自动建议）')).toBe(false)
  })

  test('Given 空 included/排除 When 生成摘要 Then 占位文本「尚未明确」/「暂未排除」', () => {
    const summary = buildRequirementSummary(
      { oneLine: '做一个工具', included: [], excluded: [] },
      [],
    )
    expect(summary).toContain('具体包括：（尚未明确）')
    expect(summary).toContain('不包括：（暂未排除）')
  })

  test('Given oneLine 空 When 生成摘要 Then 兜底「（未给出）」', () => {
    const summary = buildRequirementSummary({ oneLine: '', included: [], excluded: [] })
    expect(summary).toContain('我理解你想做的是：（未给出）')
  })

  test('Given 标签常量 Then AUTO_DECIDE_LABEL 与 AUTO_SUGGEST_TAG 稳定不变', () => {
    expect(AUTO_DECIDE_LABEL).toBe('你帮我决定')
    expect(AUTO_SUGGEST_TAG).toBe('自动建议')
  })
})

describe('W24-EF F2：US-U02 首轮 ≥3 问题结构校验', () => {
  test('Given 3 个贴近场景问题 When 校验 Then ok=true 且 questionCount=3', () => {
    const result = validateQuickClarifyQuestions([
      '你打算在什么场景使用？',
      '你最想先解决哪个问题？',
      '做完后打算怎么分享？',
    ])
    expect(result.ok).toBe(true)
    expect(result.questionCount).toBe(QUICK_CLARIFY_MIN_QUESTIONS)
  })

  test('Given 仅 2 个问题 When 校验 Then ok=false 且 reason=too-few', () => {
    const result = validateQuickClarifyQuestions(['问题 1', '问题 2'])
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('too-few')
    expect(result.questionCount).toBe(2)
  })

  test('Given 问题含「数据库」技术术语 When 校验 Then ok=false 且 reason=tech-term', () => {
    const result = validateQuickClarifyQuestions([
      '问题 1',
      '问题 2',
      '需要哪种数据库？',
    ])
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('tech-term')
  })

  test('Given 问题同时含技术术语与 <3 When 校验 Then 优先返回 too-few', () => {
    const result = validateQuickClarifyQuestions(['用什么数据库？'])
    expect(result.ok).toBe(false)
    expect(result.reason).toBe('too-few')
  })

  test('Given 问题含空串/全空白 When 校验 Then 自动跳过（不计入）', () => {
    const result = validateQuickClarifyQuestions([
      '  ', '', '场景 1', '场景 2', '场景 3',
    ])
    expect(result.ok).toBe(true)
    expect(result.questionCount).toBe(3)
  })

  test('Given 对象形式问题 When 校验 Then 读 text 字段', () => {
    const result = validateQuickClarifyQuestions([
      { text: '问题 1' },
      { text: '问题 2' },
      { text: '问题 3' },
    ])
    expect(result.ok).toBe(true)
    expect(result.questionCount).toBe(3)
  })
})
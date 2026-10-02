/**
 * L2-6（L2 批，2026-09-18）：坑库回填机制——强制复盘指令文本与触发判定（提示词级）。
 *
 * 规格出处：
 * - 模版体系改进方案 v1 §四 L2 批第 6 条（含 ATK-L-001/ATK-L-006 裁决）：
 *   验收收敛 >3 轮的项目，其踩坑知识强制回填品类模版坑库；
 *   完成判据=触发项目复盘报告含「当时模版里没有的知识」清单，且对应品类模版
 *   CHANGELOG 出现带来源编号的新条目。
 * - 03-架构阶段流程增强建议 §4：R1 触发方=强制复盘会话（本机制不建新会话类型，
 *   由回炉续接消息携带指令段驱动现有会话兼任）；R2 回填须带证据等级与来源编号；
 *   R3 写入=模版源头与运行时快照双位置同步、同版本号，运行时不单写快照。
 * - 01-模版结构规范-v2 §6：Minor Bump 规则——新增坑库条目或组件卡片为 Minor；
 *   新增回填触发器即「项目验收收敛轮次 >3 时强制复盘」。
 * - 注：02-Spike 协议 §6.3 同名「知识回填闭环」仅覆盖 Spike 场景，验收 >3 轮场景
 *   以 03 §4 为准（ATK-L-001 裁决）——本模块即 03 §4 口径的载体。
 *
 * 实现形态：纯文本指令段（无 IO、无会话创建）。触发检测在 nanju-gwt-runner 结果
 * 汇总处调用 shouldTriggerPitReflow，指令段由 buildPitReflowDirective 生成后注入
 * summaryText（注入位置选择理由见 gwt-runner 内注释）。
 */

/**
 * 强制复盘触发阈值：「验收收敛 >3 轮」口径（R1 原文），即 retryCount 严格大于 3
 * 才触发。对照 G3b 基线（8 轮收敛 / 5 轮盲修）——该基线正是本机制的直接动因。
 */
export const PIT_REFLOW_RETRY_COUNT_THRESHOLD = 3

/** 无品类标记时的兜底品类（与平台现行降级口径一致：调用方对 resolve null 退化 web-fullstack） */
export const PIT_REFLOW_FALLBACK_CATEGORY = 'web-fullstack'

/**
 * 触发判定（纯函数；审计 RED-1 修正，2026-09-18）：
 * - 口径=规格「验收收敛轮次 >3」即总轮次≥4。gwt 语义：第 N 轮运行时 retryCount=N-1
 * （本轮前累计非 pass 轮），放总轮次≥4 ⇔ retryCount≥3——原实现（verdict!=='pass' &&
 * retryCount>3）双重偏窄：排除 pass 轮使 4/5 轮收敛后 pass 的项目永不触发（G3b 基线
 * 8 轮是总轮次），且再多算一轮。pass 轮触发段随交付验收消息（buildGwtDeliveryAcceptance
 * 已携带 summaryText）注入——项目终局判定落位即记录，与效果度量口径一致；
 * - fail/error 轮均触发（G3b 的 5 轮盲修正是 error 轮）；
 * - blocked 轮不触发：blocked 摘要显式声明「本轮不计入修复次数」，注入强制复盘段
 * 与该声明自相矛盾。
 */
export function shouldTriggerPitReflow(verdict: string, retryCount: number, blocked: boolean): boolean {
  // verdict 参数保留于签名（调用方已传；触发不再区分 pass——见上方注释 RED-1 修正）
  void verdict
  return !blocked && retryCount >= PIT_REFLOW_RETRY_COUNT_THRESHOLD
}

/** 触发事实（写进指令段头部，让复盘会话看到具体收敛数据而非泛化提示） */
export interface PitReflowFacts {
  /** 本轮累计 fail 回炉轮次（gwt outcome.retryCount） */
  retryCount: number
  /** 累计 error 异常轮次（gwt outcome.errorCount；error 轮是 P0-2 透传命中的观测对象） */
  errorCount?: number
}

/**
 * 构建「强制复盘」指令段（R1+R2+R3+效果度量五字段一次性下发）。
 *
 * @param category 项目品类标记（resolveProjectCategoryForCoding 的解析结果；
 *   null/undefined 表示无标记——指令段按 web-fullstack 兜底并提示补标）
 * @param facts 触发事实（收敛轮次等；缺省时头部只写「已超 3 轮」不带具体数）
 */
export function buildPitReflowDirective(category: string | null | undefined, facts?: PitReflowFacts): string {
  const hasCategory = typeof category === 'string' && category.length > 0
  const effectiveCategory = hasCategory ? category : PIT_REFLOW_FALLBACK_CATEGORY
  const factsText = facts
    ? `（本轮累计：fail 回炉 ${facts.retryCount} 轮`
      + (facts.errorCount !== undefined ? ` / error 异常 ${facts.errorCount} 轮` : '')
      + '）'
    : ''
  const lines: string[] = [
    '【L2-6 强制复盘 · 坑库回填】本项目验收收敛已超 3 轮' + factsText + '——修复后必须执行强制复盘，不得跳过：',
    '① 逐条提取「当时模版里没有的知识」清单：每个踩坑点回答三问——哪个坑（现象）/ 为什么当时品类模版没覆盖（盲区归因）/ 证据（测试报告、驱动日志、轮次记录的具体引用）。',
    `② 按回填格式逐条写入品类模版（品类：${effectiveCategory}）：每条含 现象 / 根因 / 绕行（或修复路径）/ 证据等级（[实证]｜[文证]｜[推断]）/ 来源编号（如「来源：G3b复盘 2026-09-18」或「来源：SPIKE-001，2026-09-17」）。`,
    '③ 写入目标：品类模版对应节（§2 组件环境清单 / §5 测试闭环样例 / §7 坑库——按知识类型落位）+ 模版 CHANGELOG 新增条目（带来源编号）+ 版本号 Bump Minor（新增坑库条目或组件卡片为 Minor，依据 01-模版结构规范-v2 §6）。',
    '④ 双位置同步（R3）：模版源头 ~/projects/nanju-guide/09_工程模板/ 与运行时快照 nanju-engineering-templates/ 必须同版本号同步更新，运行时不得只写快照。',
    '⑤ 复盘报告固定小节「效果度量记录」（五字段：品类 / 收敛轮次 / error 轮数 / 透传命中轮数 / 备注），owner=本复盘会话（L1 效果度量口径承接；透传命中=error_reason 含驱动 stderr 衍生诊断内容，区别于固定句）。',
    '⑥ 形态三抽检（ATK-G-007 指派，随复盘一并执行）：对照品类模版坑库与组件清单，抽查本项目架构文档「证据升级与检索记录」节的申报合理性——发现应触发检索而申报「未触发检索条件」的，按回填闭环处理（坑库新增 + 模版 Bump Minor），并在复盘报告如实记录。',
  ]
  if (!hasCategory) {
    lines.push(
      `⚠ 未从 architecture.md / prd.md 提取到 projectCategory 品类标记，本次按 ${PIT_REFLOW_FALLBACK_CATEGORY} 兜底执行回填——请在 03_ARCHITECTURE/architecture.md 补「projectCategory: <品类>」标记（六品类：web-fullstack / api-backend / mobile-app / desktop-app / cli-tool / ai-application），并按补标后的品类归位模版双位置写入。`,
    )
  }
  return lines.join('\n')
}

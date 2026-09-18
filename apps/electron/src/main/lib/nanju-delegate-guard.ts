/**
 * W8 委派守卫（三层程序化强制）——纯函数 + 常量
 *
 * 背景：dev-test-report-20260903 §五 P1-C——router-gate 白名单只约束 L1 自身工具，
 * delegate_agent 在一切阶段白名单内，不校验委派角色与 currentStage 匹配；
 * L1 可完全绕过阶段序列（requirements 直委全栈/测试，mini 项目被「直接做」诱导绕过管线）。
 *
 * 三层强制：
 * - 层一：委派角色-阶段匹配校验（本模块 checkDelegationAgainstStage）
 * - 层二：AC 委派模型程序化覆写（本模块 detectACRole / resolveACOverride）
 * - 层三：产出路径阶段约束注入（本模块 injectStagePathConstraint）
 *
 * 设计原则：W18（v0.17.81）起为严格序——AC 纯审计意图最先裁决（审计动词且无强动词），
 * 其后他阶段词扫描先于本阶段词（合法交叉表述误拦成本经用户裁决接受，
 * coPresentStageKeyword 埋点观察）；W18.1（v0.17.83）在③前加下游 OUTPUT 守卫
 * （强动词+下游阶段产出物词并存→deny，闭合引用词掩护绕过）；两类都不命中
 * （辅助类：查资料/分析等）且无强动词时也放行并记录 telemetry（pass-unmatched）
 * 供观察 unmatched 放行面；详见 checkDelegationAgainstStage 的判定顺序注释。
 *
 * W19-C（v0.17.88，E2E 9 连拒实测修复）：
 * - 路径豁免：匹配前剥离路径 token（绝对路径 + 含 CJK 的相对路径——项目名形态）；
 *   纯 ASCII 相对路径（08_APP/index.html 等产出目标声明）保留参与匹配（A3 红测试依赖）；
 * - 词表复核：requirements ROLE 去裸「需求」「PRD」（最高频合法上游引用，换精确
 *   角色复合词）；coding ROLE 去「fullstack」（品类标记值 web-fullstack 碰撞）；
 *   testing ROLE 裸「验收」换精确复合词（「验收标准」是正常 AC 引用）；coding
 *   OUTPUT 去「应用」、testing OUTPUT 去「场景」（UX 正常词汇）；
 * - OUTPUT 词邻近语境判定：规则 2.5 收紧为「OUTPUT 词 ±20 字符内存在强动词」
 *   （「生成应用代码」仍拦，「不能只看代码推断」审查语境放行）；
 * - stage-deny 埋点补 matchContext（命中字段/前后 20 字符/是否在路径内）。
 *
 * 匹配文本：delegate_agent 的 title + task 字段（参数结构调研结论：任务字段名是
 * task 而非 prompt；role 是 explore/research/implement/review/custom 枚举，语义过泛，
 * 不纳入匹配文本）。中文词用 includes，英文词用 \b 词边界（防 'ac' 误命中
 * 'trace'/'space'、'test' 误命中 'latest'）。
 */

import type { NanjuGuardStage } from './nanju-project'
import type { ProjectMode } from './nanju-project'
import { AC_PRESETS, channelFamily, getPhaseNode, resolveACActors, type ACActorConfig } from './nanju-router'
import { isNanjuDelegationSlot } from '@proma/shared'

// ===== 层一：阶段角色词表 =====

/**
 * 各阶段允许的委派角色关键词（宽松包含匹配，中文 includes / 英文 \b 词边界，大小写不敏感）。
 * W18.1（A2 修复）：planning 移除裸「工程」——「工程师」是中文标准职称后缀
 * （测试工程师/全栈开发工程师等），子串碰撞在② 他阶段扫描先于③ 的严格序下
 * 把职称误判为 planning 委派（含 testing 阶段自身标题被拒）；换精确词后 planning
 * 典型委派仍命中（「规划/计划/工程计划/里程碑」等，见 STAGE_TITLES.planning 校准）。
 * W18.1（A2 探针）：architecture 的「环境」收紧为「环境配置」——「配置开发环境」
 * （语序相反，不含连续子串「环境配置」）在 coding 阶段被误拦；「环境配置」
 * 仍是 architecture 文档常用语，本阶段匹配不受削弱。
 * W19-C（v0.17.88，E2E 9 连拒修复）：
 * - requirements 去裸「需求」「PRD」——两者是最高频合法跨阶段引用（「根据 PRD 生成
 *   原型」「产品需求文档」是编排器注入的前序文档标配语；实测 deny#1/#2 均为此），
 *   换精确角色复合词，角色声明检测不削弱；requirements 阶段自身匹配不受影响
 *   （OUTPUT 表含 需求/PRD/用户故事）。
 * - coding 去「fullstack」——品类标记值 `projectCategory: web-fullstack` 被各阶段
 *   委派文本复制（实测 deny#3）；连字符形态 full-stack 本就不命中 \bfullstack\b，
 *   英文全栈角色声明由强动词 develop/build 兑底，中文由 全栈/开发/实现 覆盖。
 * - testing 裸「验收」换精确复合词——「验收标准（AC）清单」是每个委派的标准 AC
 *   引用语（实测 deny#4/#5 另一命中源）；项目名含「验收」碰撞已由路径豁免解决。
 */
export const STAGE_ROLE_KEYWORDS: Record<NanjuGuardStage, readonly string[]> = {
  requirements: ['需求调研', '需求收集', '收集需求', '需求梳理', '需求评审', 'analyst', 'requirements'],
  prototype: ['UX', '原型', 'prototype', '视觉', '界面'],
  architecture: ['架构', 'architect', '环境配置', '技术'],
  planning: ['规划', '工程计划', '计划', 'plan', '项目经理', '排期', '里程碑', '项目管理'],
  coding: ['全栈', '开发', 'coding', '实现'],
  testing: ['测试', 'test', 'GWT', 'QA', '验收测试', '验收用例', '验收场景', '执行验收', '跑验收', 'UAT', 'testing'],
}

/**
 * 阶段推进序（W18.1）：A3 下游 OUTPUT 守卫判定「下游阶段」用（严格晚于当前阶段）。
 * 与 NanjuGuardStage 联合类型声明序、STAGE_ROLE_KEYWORDS/STAGE_TITLES/STAGE_WRITE_DIR
 * 键序同源（requirements→prototype→architecture→planning→coding→testing）。
 */
export const STAGE_ORDER: readonly NanjuGuardStage[] = Object.keys(STAGE_ROLE_KEYWORDS) as NanjuGuardStage[]

/**
 * 全阶段通用的 AC 攻防类词。W18（v0.17.81）起拆分：
 * - AC_AUDIT_VERBS：AC 审计动词（去裸 'AC'）——层一 ① 审计意图裁决与层二 matchACKeyword 共用；
 * - 裸 'AC' 不再构成审计意图（例：「对照 AC-05 编写测试场景」在 requirements 应 deny testing，
 *   而非被独立词 'AC' 放行 ac 类）；裸 AC 文本回归普通判定流（可能 unmatched 放行/被注入约束）。
 */
export const AC_AUDIT_VERBS: readonly string[] = ['攻击', '防御', '审计', '复审', 'attack', 'defense', 'review']

/**
 * 强动作动词表（W10-V2.1，v0.17.72）：明确产出物类动作的中英文动词。
 *
 * 背景：dev-test-report-20260903 §六——W8 层一 unmatched 敞口实测成真（L1 在 requirements
 * 名下用无阶段词委派「把这个工具做出来」完成原型+coding 产物，阶段推进从未发生）。
 * 兜底：unmatched 内部再分级——含强动词（=明确产出物动作）→ deny，要求补角色声明；
 * 无强动词（查询/分析/总结类辅助动作）→ 维持 W8 宽匹配放行（pass-unmatched 现状不变）。
 *
 * 误拦缓解（工单 §1 误拦权衡）：本阶段产出物词优先于强动词判定（见 STAGE_OUTPUT_KEYWORDS
 * ——如 requirements 阶段「调研并编写 PRD 草稿要点」的「编写」是强动词但「PRD」命中
 * 本阶段产出物词，按 stage 放行）。注意「实现/开发」同时是 coding 的角色词（STAGE_ROLE_
 * KEYWORDS.coding），coding 阶段命中它们在第 1 步即放行，强动词表只在其他阶段兜底。
 *
 * 可演进常量：按观察数据（telemetry unmatched-action-deny 的 verbs 分布）增删；
 * 中文词 includes / 纯英文词 \b 词边界（同 W8 惯例，大小写不敏感）。
 *
 * 补词候选清单（W10 修订轮 A1 随批补入 7 词：完善/优化/调整/fix/ship/refine/polish——
 * 迭代类产出动作，裁决 20260903 attack-upheld）；下一批候选按 telemetry verbs 分布决策：
 * - '修复'：暂缓入表（GWT 回炉指令高频合法词，需配合 testing 产出词放行或 verbs 分布数据
 *   裁决后入；现表外=unmatched 放行，设计内行为，边界测试固化）；
 * - '调一下'/'改一下' 等口语化短谓语：误拦风险高于收益，待语料；
 * - 入表前先验证：候选词是否为某阶段 ROLE/OUTPUT 词（同词不宣重复，避免他阶段误拦）。
 */
export const STRONG_ACTION_VERBS: readonly string[] = [
  '实现', '开发', '构建', '生成', '制作', '编写', '写代码', '做成', '做出来',
  'build', 'implement', 'code', 'create the', 'make the', 'develop',
  // W10 修订轮 A1：迭代类产出动作补入（裁决随批）
  '完善', '优化', '调整', 'fix', 'ship', 'refine', 'polish',
]

/**
 * 各阶段产出物词（W10-V2.1：强动词 deny 的误拦缓解——「本阶段目录词优先」）。
 *
 * 只并入第 1 步本阶段放行的补充匹配（与 STAGE_ROLE_KEYWORDS[stage] 并集），
 * **不参与第 3 步他阶段扫描**——产出物词多为跨阶段动作对象（如「代码」也出现在
 * 「代码评审」），若进他阶段扫描会把合法交叉表述误拦（推翻宽匹配原则）。
 * 与角色词表的重复词（需求/PRD/原型/架构等已在 STAGE_ROLE_KEYWORDS）保留：两表
 * 语义不同（角色 vs 产物），重复命中无行为差异（第 1 步并集放行），各自完整可演进。
 * W19-C（v0.17.88）：coding 去「应用」、testing 去「场景」（UX 正常词汇——实测
 * deny#7/#8：「单页应用」「多场景导航」是每个 UX 委派标配语；下游产出意图由
 * 邻近语境判定 + 保留词 代码/index.html/steps.json 等覆盖）；requirements
 * 键序重排（需求 在 PRD 前，保 coPresentStageKeyword 埋点口径不变）。
 */
export const STAGE_OUTPUT_KEYWORDS: Record<NanjuGuardStage, readonly string[]> = {
  requirements: ['需求', 'PRD', '用户故事', 'user story', 'user stories'],
  prototype: ['原型', 'prototype', '界面稿', '视觉稿', '线框'],
  architecture: ['架构', 'architecture', '技术选型', '组件清单'],
  planning: ['计划', '规划', '里程碑', 'milestone'],
  coding: ['代码', 'code', 'index.html'],
  testing: ['测试', 'test', 'scenario', 'steps.json', 'report.json'],
}
// 注：不含 'app'——过宽（AC 委派文本 'run AC audit on app' 会把 matchKind 从 ac 改判
// stage，磁碰 W8 基线断言且模糊 AC 归类）；英文 coding 委派由 'code'/'index.html' 覆盖，
// 'build the app' 类纯动作文本记为残余误拦面（deny 文案引导补角色声明后可重试）。

/** AC 攻方识别词（用于层二区分攻/防） */
const AC_ATTACKER_KEYWORDS: readonly string[] = ['攻击', 'attack']

/** AC 防方识别词（用于层二区分攻/防） */
const AC_DEFENDER_KEYWORDS: readonly string[] = ['防御', 'defense', '裁决']

// ===== W22 M#9/R2：修复路由守卫（testing 阶段 MiniMax 误用于代码修复） =====

/**
 * R2 判据③的 coding 阶段词（工单口径：全栈/开发/代码/index.html + 英文同义 coding/code）。
 * 独立成表——**禁动 STRONG_ACTION_VERBS 与既有 ROLE/OUTPUT 词表**（论证 P0#7：
 * 「修复」入 STRONG_ACTION_VERBS 的血溅面是全阶段，而 testing 合法回炉指令本就含
 * 「委派全栈开发修复缺陷」）；刻意不含「实现」——testing 合法委派高频含「对比原型
 * 与实现」（截图比对语境），误杀面大。中文 includes / 英文 \b 词边界（findKeyword 惯例）。
 */
export const R2_CODING_STAGE_KEYWORDS: readonly string[] = ['全栈', '开发', '代码', 'coding', 'code', 'index.html']

/** MiniMax-M3 模型名匹配（与 nanju-router-prompt 的 MINIMAX_M3_PATTERN 同口径） */
const MINIMAX_MODEL_PATTERN = /minimax[-_\s]?m3/i

/**
 * R2 判据②：显式端点指向 minimax 家族。两信号任一命中：
 * - channelId 前缀（字面家族标记 'minimax*'——channelFamily 口径）；
 * - modelId 匹配 MiniMax-M3 模型名——minimax 实际渠道 ID 是 UUID（release/dev 不同），
 *   渠道前缀判不到家族，E2E 实测形态（二级委派自选 MiniMax-M3）模型名是可靠信号。
 */
export function isMinimaxEndpoint(channelId?: string, modelId?: string): boolean {
  if (channelId !== undefined && channelId.trim() !== '' && channelFamily(channelId) === 'family-minimax') return true
  if (modelId !== undefined && MINIMAX_MODEL_PATTERN.test(modelId)) return true
  return false
}

/**
 * R2 deny 教育文案：给出可执行替代动作（continue_delegation 原「全栈开发」委派，
 * 保留上下文与原渠道）——防 L1 退化成「重新 delegate_agent 找一个新全栈」丢上下文
 * （论证 M#9：那是 #10/R1 要解决的问题）。工单文本 + 原委派查找指引。
 * 接线位：router-gate 的 deny 文案分支（按 denialKind==='minimax-repair-misuse' 取用）
 * ——该文件归 W22 G 域，本域已保证 deny 本体经既有 stage-deny 通道生效，教育文案
 * 接线见 w22-impl-model.md 未尽事项。
 */
export const MINIMAX_REPAIR_GUIDANCE: string =
  '代码修复请用 continue_delegation 向原「全栈开发」委派追加修复指令（保留完整上下文与原渠道）；' +
  'MiniMax-M3 不用于代码修复（用户已裁决）。若不确定原委派 ID，先用 list_delegations 查找 coding 阶段的全栈开发委派。'

/** 各阶段的中文标题（deny 文案与注入文案用，与 nanju-router PhaseNode.title 对齐） */
export const STAGE_TITLES: Record<NanjuGuardStage, string> = {
  requirements: '需求分析师',
  prototype: 'UX 顾问',
  architecture: '架构师',
  planning: '工程经理',
  coding: '全栈开发',
  testing: '测试工程师',
}

/** 编译关键词匹配器：含非 ASCII（中文）→ includes；纯英文 → \b 词边界正则（均不区分大小写） */
function keywordMatcher(keyword: string): (text: string) => boolean {
  if (/^[\x20-\x7E]+$/.test(keyword)) {
    const re = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
    return (text) => re.test(text)
  }
  return (text) => text.includes(keyword)
}

/** 在文本中查找首个命中的关键词，返回该词（未命中返回 undefined） */
export function findKeyword(text: string, keywords: readonly string[]): string | undefined {
  for (const kw of keywords) {
    if (keywordMatcher(kw)(text)) return kw
  }
  return undefined
}

// ===== W19-C（v0.17.88）：路径豁免 =====

/**
 * 路径 token 字符集：非空白、非引号、非中西文标点（斜杠属于 token，由整体形态判定）。
 * CJK 文字 ∈ 路径字符集（项目目录名如 project-e2e-w18-验收2 含 CJK）。
 */
const PATH_RUN_CLASS = '[^\\s"\'`「」『』（）()【】《》<>，。；;：:、！？…\\\\]'
const PATH_RUN_RE = new RegExp(`${PATH_RUN_CLASS}+`, 'g')

/** 判断一个路径 run 是否应被剥离（与 stripPathTokens 同判据，供 inPath 归因复用） */
function isStrippedPathRun(run: string): boolean {
  if (!run.includes('/')) return false
  // 绝对路径（含 ~ 家目录形态；Windows 盘符形态因反斜杠不在字符集内不入此判定，
 // Linux 产品面向，见报告遗留项）
  if (run.startsWith('/') || run.startsWith('~/')) return true
  // 含 CJK 的相对路径——项目目录名形态（project-e2e-w18-验收2 等），
  // ASCII 项目名（如 project-e2e-test-2）碰撞为已知残余面
  return /[\u3400-\u9fff]/.test(run)
}

/** 段是否为纯 ASCII（可保留参与二次匹配——CJK 段是碰撞源，不保留） */
function isAsciiSegment(seg: string): boolean {
  return seg !== '' && /^[\x21-\x7E]+$/.test(seg)
}

/**
 * F2（审查应修，v0.17.90）：被剥离路径的尾部 ASCII 产出签名。
 *
 * 背景：整 token 剥离会把尾部产出文件名一并移除，CJK/绝对路径形态下
 * 「生成 08_APP/首页/index.html」「…/project-验收2/08_APP/index.html」在 requirements
 * 阶段被放行（W18.1 2.5 语义应 DENY）——产出声明漏拦（审查探针实证）。
 *
 * 规则：取末段；末段非 ASCII（CJK 文件名/空）→ 无签名；末段 ASCII 且父段也 ASCII
 * → 保留父段/末段（与 ASCII 相对路径保留形态一致，如 08_APP/index.html）；
 * 父段非 ASCII → 仅末段。CJK 段（验收2 等碰撞源）永不保留。
 */
function asciiTailSignature(run: string): string {
  const segs = run.split('/').filter((s) => s !== '' && s !== '.')
  const last = segs[segs.length - 1] ?? ''
  if (!isAsciiSegment(last)) return ''
  const parent = segs.length >= 2 ? segs[segs.length - 2] ?? '' : ''
  return isAsciiSegment(parent) ? `${parent}/${last}` : last
}

/**
 * W19-C 路径豁免：从待检文本整体移除路径 token（F2：尾部 ASCII 产出签名除外）。
 *
 * 剥离范围（两类，均为 E2E 9 连拒实测碰撞源）：
 * 1. 绝对路径（/ 或 ~/ 开头的连续 run）——机器生成，携带项目名/用户名；
 * 2. 含 CJK 字符的含斜杠 run——项目目录名形态（验收2 等）。
 *
 * 保留：① 纯 ASCII 相对路径（08_APP/index.html、01_PRD/prd.md 等）——它们是 L1
 * 主动声明的产出目标，OUTPUT 词需继续匹配（W18.1 A3 红测试依赖）；② 被剥离
 * token 的尾部 ASCII 产出签名（F2：CJK/绝对路径尾部的 index.html 等产出词不随
 * 整体剥离消失，2.5 邻近语境可继续命中）。副作用：保留段内的目录名词
 * （02_UX_DESIGN 含 UX 等）仍参与匹配——对本阶段词无害，他阶段词碰撞记为
 * 残余面（与 ASCII 相对路径同源，matchContext.inPath 可观测）。
 */
export function stripPathTokens(text: string): string {
  return text.replace(PATH_RUN_RE, (run) => (isStrippedPathRun(run) ? ` ${asciiTailSignature(run)} ` : run))
}

/** 关键词在文本中的全部出现位置（start index）；英文 \b 词边界 / 中文 includes（大小写不敏感） */
function keywordIndices(text: string, keyword: string): number[] {
  if (/^[\x20-\x7E]+$/.test(keyword)) {
    const re = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')
    return [...text.matchAll(re)].map((m) => m.index ?? -1).filter((i) => i >= 0)
  }
  const out: number[] = []
  let from = 0
  while (true) {
    const i = text.indexOf(keyword, from)
    if (i < 0) break
    out.push(i)
    from = i + 1
  }
  return out
}

/** W19-C：OUTPUT 词邻近语境窗口（字符数）——OUTPUT 词与强动词距离在窗口内才判产出意图 */
export const OUTPUT_VERB_PROXIMITY = 20

/** W19-C：telemetry 命中位置上下文（归因用：哪个字段、前后片段、是否在路径内） */
export interface KeywordHitContext {
  field: 'title' | 'task' | 'expectedOutput'
  before: string
  after: string
  /** 命中位置是否位于将被剥离的路径 token 内（路径内命中 = 项目名/目录名碰撞类误拦信号） */
  inPath: boolean
}

/** 在原文中定位关键词首处命中并给出归因上下文（找不到返回 undefined） */
export function describeKeywordHit(source: DelegationMatchSource, keyword: string): KeywordHitContext | undefined {
  if (!keyword) return undefined
  for (const field of ['title', 'task', 'expectedOutput'] as const) {
    const raw = source[field]
    if (!raw) continue
    for (const pos of keywordIndices(raw, keyword)) {
      let inPath = false
      for (const match of raw.matchAll(PATH_RUN_RE)) {
        const start = match.index ?? 0
        if (pos >= start && pos < start + match[0].length && isStrippedPathRun(match[0])) {
          inPath = true
          break
        }
      }
      return { field, before: raw.slice(Math.max(0, pos - 20), pos), after: raw.slice(pos + keyword.length, pos + keyword.length + 20), inPath }
    }
  }
  return undefined
}

// ===== 层一：校验 =====

/** 委派校验输入（从 delegate_agent/delegate_agents 参数中提取的匹配文本源） */
export interface DelegationMatchSource {
  /** 子会话标题（可选） */
  title?: string
  /** 任务说明（delegate_agent 的必填 task 字段；防御式可选） */
  task?: string
  /** 期望产出说明（R2/AC 裁决 A4：纳入匹配——防 L1 把角色词藏在 expectedOutput 绕过） */
  expectedOutput?: string
  /** W22 M#9/R2：显式目标渠道（delegate_agent 的 channelId 字段；未显式传时缺省 =
   *  继承父会话渠道，不入本字段）。不参与词表匹配文本——仅作 R2 的端点家族判定 */
  channelId?: string
  /** W22 M#9/R2：显式目标模型（同上；minimax 实际渠道 ID 是 UUID，渠道前缀判不到
   *  家族时模型名 MiniMax-M3 是可靠信号） */
  modelId?: string
}

/** 匹配文本拼接（单一真源：checkDelegationAgainstStage / matchACKeyword / detectACRole 共用；R2 后含 expectedOutput；
 *  W19-C：拼接后剥离路径 token——项目名/用户名出现在路径内不再命中任何词表） */
function buildMatchText(source: DelegationMatchSource): string {
  return stripPathTokens(`${source.title ?? ''}\n${source.task ?? ''}\n${source.expectedOutput ?? ''}`)
}

/** 匹配结果分类 */
export type DelegationMatchKind =
  /** 命中当前阶段专属词（放行 + 注入路径约束） */
  | 'stage'
  /** 命中 AC 通用词（放行 + 层二覆写候选 + 不注入路径约束） */
  | 'ac'
  /** 两类词都不命中——辅助类委派（放行 + 注入路径约束 + telemetry 观察） */
  | 'unmatched'

/** 单个委派的阶段匹配校验结果 */
export interface DelegationCheckResult {
  /** false = 命中其他阶段专属词，拒绝 */
  allowed: boolean
  matchKind: DelegationMatchKind
  /** 命中的本阶段词（角色词或产出物词，W10 起）/ AC 词 */
  matchedKeyword?: string
  /** 拒绝时：命中的其他阶段专属词 / 强动作动词（W10） */
  violatedKeyword?: string
  /** 拒绝时：该词所属阶段（仅 other-stage 拒绝时有值） */
  violatedStage?: NanjuGuardStage
  /** W10：拒绝原因细分——'other-stage'（命中他阶段词）/ 'strong-verb'（unmatched+强动作动词）。
   *  未定义 = W8 既有语义（other-stage），调用方按该默认分流（向后兼容）；
   *  W22 M#9/R2 新增 'minimax-repair-misuse'（testing ∧ 显式 minimax 家族端点 ∧ coding
   *  阶段词——修复路由误用，调用方按 other-stage 同道分流 deny，教育文案见
   *  MINIMAX_REPAIR_GUIDANCE） */
  denialKind?: 'other-stage' | 'strong-verb' | 'minimax-repair-misuse'
  /** W10：strong-verb 拒绝时命中的动作动词（= violatedKeyword 的语义别名，便于调用方取用） */
  matchedVerb?: string
}

/**
 * 层一核心判定：单个委派的标题+任务 与 currentStage 的匹配。
 *
 * 判定顺序（W18，v0.17.81 重排——严格序，用户裁决接受合法交叉表述误拦成本，
 * 误拦面经 router-gate stage-deny 埋点 coPresentStageKeyword 观察统计（口径为
 * 本阶段词共现率 deny-with-coPresent，非误拦率——共现也出现在正确拦截上）；
 * W8/W10 的「本阶段词优先」原则被本条推翻，基线翻转测试固化）：
 * 1. AC 审计意图：命中 AC 审计动词（AC_AUDIT_VERBS）**且无强动作动词** → 放行（ac）。
 *    审计宾语天然跨阶段（「攻击 02_UX_DESIGN 原型」含原型/UX 词仍须放行）——审计
 *    意图不受他阶段词影响；但「审计+产出」不是同一意图：强动词在场时本条不裁决，
 *    落入 2-4（「review 架构并实现应用」「审计后顺便编写测试」均拒）。
 * 1.5. W22 M#9/R2 修复路由守卫：testing 阶段 ∧ 显式 minimax 家族端点 ∧ coding
 *    阶段词 → 拒绝（denialKind='minimax-repair-misuse'；详见函数内注释与
 *    R2_CODING_STAGE_KEYWORDS / MINIMAX_REPAIR_GUIDANCE）。
 * 2. 他阶段角色词扫描（无条件、先于本阶段词）→ 拒绝（other-stage；产出物词仍不参与
 *    他阶段扫描——跨阶段动作对象误拦风险，见 STAGE_OUTPUT_KEYWORDS 注释）。
 * 2.5. W18.1（A3 闭合）：强动作动词在场 且 下游阶段（阶段序严格晚于当前，见
 *    STAGE_ORDER）产出物词命中 → 拒绝（other-stage，violatedKeyword=该 OUTPUT 词）。
 *    堵「本阶段引用词掩护他阶段产出」的 OUTPUT 词变体——② 只扫 ROLE 词，
 *    「按 PRD 生成应用代码」原先在 3 被本阶段词「PRD」放行。只扫严格下游：
 *    上游阶段产出的合法引用（如 coding 提「按计划」）仍走既有判定，不加码误拦。
 *    W19-C（v0.17.88）邻近语境收紧：OUTPUT 词出现位置 ±OUTPUT_VERB_PROXIMITY
 *    字符内存在强动词才判产出意图——「生成应用代码」（距离 4）仍拦，「不能只看
 *    代码推断」「整理场景覆盖情况」等审查/引用语境放行（E2E 实测 deny#6/#8）。
 * 3. 本阶段词（角色词 ∪ 产出物词）→ 放行（stage；产出物词优先于强动词判定——误拦缓解）。
 * 4. 强动作动词 → 拒绝（strong-verb——W8 敞口兜底：产出类动作必须显式声明角色）。
 * 5. 都不命中（查询/分析/总结类辅助动作）→ 放行（unmatched，调用方记 telemetry 观察）。
 */
export function checkDelegationAgainstStage(
  stage: NanjuGuardStage,
  source: DelegationMatchSource,
): DelegationCheckResult {
  const text = buildMatchText(source)
  if (text.trim() === '') {
    // 空文本（参数缺 title/task）：交给既有 validateToolInput 必填校验，此处放行
    return { allowed: true, matchKind: 'unmatched' }
  }

  // 1. AC 审计意图：审计动词命中且无强动词 → 只读审计放行（ac）；强动词在场则不裁决
  const acHit = findKeyword(text, AC_AUDIT_VERBS)
  if (acHit !== undefined && findKeyword(text, STRONG_ACTION_VERBS) === undefined) {
    return { allowed: true, matchKind: 'ac', matchedKeyword: acHit }
  }

  // 1.5. W22 M#9/R2 修复路由守卫：testing 阶段 ∧ 显式 minimax 家族端点 ∧ 文本命中
  //     coding 阶段词 → 拒绝（用户裁决：MiniMax-M3 不用于代码修复；修复应 continue_delegation
  //     原「全栈开发」委派保留上下文）。E2E 实测形态（D8 06:47/06:53：L1→deepseek 协调
  //     →MiniMax-M3 干代码修复）恰命中三条件合取；合法用途（minimax 视觉裁决/原型核对）
  //     不会「显式 minimax 端点 + coding 阶段词」并存（论证 M#9）。
  //     位置在 ① AC 审计意图之后（攻防类委派渠道由层二 resolveACOverride 收口，不经本
  //     规则——AC 只读审计读代码不等于干修复）、② 他阶段扫描之前（R2 的 deny 归因与
  //     教育文案比通用 stage-deny 更精准，优先裁决）。
  //     边界：continue_delegation 不经本守卫（工具入参只有 delegationId+message，不携
  //     委派文本/渠道），对已存在 minimax 委派的续派拦截需另走渠道反查（见 W22 报告）。
  if (stage === 'testing' && isMinimaxEndpoint(source.channelId, source.modelId)) {
    const codingWordHit = findKeyword(text, R2_CODING_STAGE_KEYWORDS)
    if (codingWordHit !== undefined) {
      return {
        allowed: false,
        matchKind: 'unmatched',
        violatedKeyword: codingWordHit,
        violatedStage: 'coding',
        denialKind: 'minimax-repair-misuse',
      }
    }
  }

  // 2. 其他阶段专属词（仅扫角色词表——产出物词不参与他阶段扫描，见 STAGE_OUTPUT_KEYWORDS 注释）
  for (const otherStage of Object.keys(STAGE_ROLE_KEYWORDS) as NanjuGuardStage[]) {
    if (otherStage === stage) continue
    const hit = findKeyword(text, STAGE_ROLE_KEYWORDS[otherStage])
    if (hit !== undefined) {
      return { allowed: false, matchKind: 'unmatched', violatedKeyword: hit, violatedStage: otherStage, denialKind: 'other-stage' }
    }
  }

  // 2.5. W18.1（A3 闭合）+ W19-C 邻近语境：强动词在场 + 下游 OUTPUT 词且两者距离在
  //     邻近窗口内 → 拒绝（产出意图）；远距离共现（审查/引用语境）不拦
  if (findKeyword(text, STRONG_ACTION_VERBS) !== undefined) {
    const verbPositions = STRONG_ACTION_VERBS.flatMap((v) => keywordIndices(text, v))
    const stageIdx = STAGE_ORDER.indexOf(stage)
    for (const downstreamStage of STAGE_ORDER) {
      if (STAGE_ORDER.indexOf(downstreamStage) <= stageIdx) continue
      let outputHit: string | undefined
      for (const kw of STAGE_OUTPUT_KEYWORDS[downstreamStage]) {
        if (keywordIndices(text, kw).some((pos) => verbPositions.some((v) => Math.abs(pos - v) <= OUTPUT_VERB_PROXIMITY))) {
          outputHit = kw
          break
        }
      }
      if (outputHit !== undefined) {
        return { allowed: false, matchKind: 'unmatched', violatedKeyword: outputHit, violatedStage: downstreamStage, denialKind: 'other-stage' }
      }
    }
  }

  // 3. 本阶段词（角色词 ∪ 产出物词：产出物词优先缓解强动词误拦——「编写 PRD」在
  //    requirements 按本阶段词放行，而非掉入第 4 条强动词拒绝）
  const stageHit = findKeyword(text, [...STAGE_ROLE_KEYWORDS[stage], ...STAGE_OUTPUT_KEYWORDS[stage]])
  if (stageHit !== undefined) {
    return { allowed: true, matchKind: 'stage', matchedKeyword: stageHit }
  }

  // 4. 强动作动词 → 拒绝（产出类动作必须显式声明角色——W8 敞口兜底）
  const verbHit = findKeyword(text, STRONG_ACTION_VERBS)
  if (verbHit !== undefined) {
    return { allowed: false, matchKind: 'unmatched', violatedKeyword: verbHit, denialKind: 'strong-verb', matchedVerb: verbHit }
  }
  // 5. 无强动词（辅助类）→ 放行（现状不变）
  return { allowed: true, matchKind: 'unmatched' }
}

// ===== 层二：AC 攻/防识别与模型覆写 =====

/**
 * W24-8：各阶段**作者委派标题标记**（仅层二 AC 覆写的豁免判定用，不参与层一匹配）。
 * L1 作者委派标题约定「{角色}：{项目} …」（router-prompt 模板）；AC 委派标题
 * （攻击者/防御者/审计/复审）不含这些标记 → 不豁免 → 照常程序化覆写。
 *
 * W-B B2：从 router-gate.ts 迁移至此（detectDelegationSlot 复用；原调用点改为 import）。
 * 每次迁移后必须确认调用方已 import，不得只删常量不补导入（否则运行期 ReferenceError）。
 */
export const STAGE_AUTHOR_TITLE_MARKERS: Record<string, readonly string[]> = {
  requirements: ['需求分析师', '需求分析', 'analyst', 'requirement-analyst'],
  prototype: ['UX 顾问', 'UX顾问', 'ux-advisor', '原型设计'],
  architecture: ['架构师', 'architect', '环境探测'],
  planning: ['工程经理', '项目经理', 'engineering-manager'],
  coding: ['全栈开发', '开发工程师', 'fullstack-developer'],
  testing: ['测试工程师', 'test-engineer', 'GWT'],
}

/**
 * W-B B2：视觉验证者 title 标记表（独立作者/AC 槽位）。
 *
 * 设计：gate 端须区分 “视觉验证者”（prototype 阶段独立裁决）与 “作者委派”
 * （标题含阶段作者标记）。本表仅供 detectDelegationSlot 识别 visual-validator
 * 槽位使用，不参与层一/层二的阶段匹配（防与 prototype 阶段词重叠导致误拦）。
 *
 * 与 STAGE_AUTHOR_TITLE_MARKERS 的关键区别：
 * - STAGE_AUTHOR_TITLE_MARKERS = 作者表 (L1 主委派，仅一阶段标记表，用于作者委派豁免)
 * - VISUAL_VALIDATOR_TITLE_MARKERS = 视觉验证者表（独立槽位，仅 prototype 阶段可能命中）
 *
 * 中文 includes / 英文 \b 词边界，大小写不敏感（findKeyword 同型判定）。
 */
export const VISUAL_VALIDATOR_TITLE_MARKERS: readonly string[] = [
  '独立视觉裁决', '独立视觉验证', '视觉验证者', '视觉裁决',
  'visual judge', 'visual validator', 'visual review',
]

/**
 * W-B B2：slot 分类（**legacy 低信任回退**）。
 *
 * 优先级：visual-validator > ac-attacker > ac-defender > author > general
 * - title 命中视觉验证者标记表 → visual-validator（**必须先于 AC 判定**：中文标记
 *   「视觉裁决」含 AC 防御词「裁决」，后置会被 AC 分支提前命中而永不生效）
 * - 否则命中 AC 词 → ac-attacker/defender（仅在区分出攻防时；同词并存按攻方处理——与 detectACRole 同源）
 * - 否则命中阶段作者标题表 → author
 * - 其余 → general
 *
 * 信任边界（重要）：本函数仅从 title/task/expectedOutput 文本推断，属 **legacy 低信任**。
 * slot 的权威来源是内部 producer（nanju-router-prompt.resolvePhaseDelegationSlots，
 * config/schema 驱动），其输出经内部参数 DelegateAgentArgs.slot 写入 DelegationRecord
 * 与 session meta。公开工具入口不暴露 slot，L1/L2 不能借文本伪造视觉槽位权威。
 *
 * gate 消费（nanju-router-gate.checkNanjuDelegateGuard）：
 * - slot=visual-validator 的委派：与 producer 解析值比对（同端点/未配置一律拒绝）
 * - slot=author 的委派：与 AC 攻防关键词交叠时不被劫持为 ac-actor（W24-8 既有逻辑保留）
 *
 * 语义：title 含多阶段标记时按优先级首次命中；未命中返回 'general'。
 */
export type DelegationSlot = 'author' | 'ac-attacker' | 'ac-defender' | 'visual-validator' | 'general'

export function detectDelegationSlot(
  source: DelegationMatchSource,
  stage: NanjuGuardStage,
): DelegationSlot {  // 1. 视觉验证者（独立于 author 与 AC）——仅在 title 含 VISUAL_VALIDATOR_TITLE_MARKERS
  // 时命中。必须先于 AC 判定：「视觉裁决」含 AC 防御词「裁决」，后置会被误归为
  // ac-defender（视觉槽位失效，与 B2 目标矛盾）。
  if (typeof source.title === 'string') {
    if (findKeyword(source.title, VISUAL_VALIDATOR_TITLE_MARKERS) !== undefined) return 'visual-validator'
  }

  // 2. AC 攻防识别（命中 AC 词且可区分攻/防 → ac-actor，以便层二覆写）
  const acRole = detectACRole(source)
  if (acRole === 'attacker') return 'ac-attacker'
  if (acRole === 'defender') return 'ac-defender'

  // 3. 阶段作者（既有 STAGE_AUTHOR_TITLE_MARKERS 检测——与 gate W24-8 作者豁免逻辑同源）
  const authorMarkers = STAGE_AUTHOR_TITLE_MARKERS[stage] ?? []
  if (typeof source.title === 'string' && findKeyword(source.title, authorMarkers) !== undefined) return 'author'

  // 4. 兜底：通用委派（继承父会话渠道）
  return 'general'
}

/**
 * W-B B2：解析单个委派的**有效槽位**——内部 slot（传入的 args.slot）为权威，缺省/非法时
 * 回退 legacy 文本推断结果（低信任）。gate 与委派记录共用此优先级，保证「公开工具无法
 * 伪造 slot」：公开入口不暴露 slot，因此文本推断只是兼容回退。
 */
export function resolveDelegationSlot(trustedSlot: unknown, legacyTextSlot: DelegationSlot): DelegationSlot {
  return isNanjuDelegationSlot(trustedSlot) ? trustedSlot : legacyTextSlot
}

/** AC 角色识别结果：attacker / defender / null（分不出攻防——如仅写「审计」，不覆写） */
export function detectACRole(source: DelegationMatchSource): 'attacker' | 'defender' | null {
  const text = buildMatchText(source)
  const isAttacker = findKeyword(text, AC_ATTACKER_KEYWORDS) !== undefined
  const isDefender = findKeyword(text, AC_DEFENDER_KEYWORDS) !== undefined
  if (isAttacker && isDefender) return 'attacker' // 同词并存时按攻方处理（报告注明）
  if (isAttacker) return 'attacker'
  if (isDefender) return 'defender'
  return null
}

/**
 * 层二覆写值：按项目 mode 取 AC 预设（quick→light 快模型 / iterative→medium 强模型）。
 * 与 resolveACActors 的 taskWeight 口径一致（AC_PRESETS 同源）。
 *
 * W22 M#7（v0.17.106，论证 P0#5）：新增可选第三参 stage——传入时优先取该阶段解析
 * 出的 AC 角色（resolveACActors(phaseNode)：per-phase 显式 acAttacker/acDefender 覆盖
 * > taskWeight 预设），仅在阶段未知/节点缺失时回退全局 preset。防「per-phase 覆盖被
 * preset 静默覆写」：testing.acAttacker=glm-zhipu:glm-5.3-flash（W22 三族矩阵）若仍
 * 走 preset 会被覆写回 deepseek 系，与新作者（deepseek-v4-flash）同族 → 三族矩阵
 * 静默失效且无告警；同时修复对称问题：per-phase acDefender（minimax，W13 起）此前
 * 同样被 preset 覆写回 glm 系。
 * 未传 stage（向后兼容）：保持 W8 语义（按 mode 取全局预设）。
 * ⚠️ 接线：调用方 router-gate（checkNanjuDelegateGuard）应传 guardStage——该文件归
 *    W22 G 域施工中，本域未改其调用点（两参调用仍兼容），接线 diff 见
 *    w22-impl-model.md 未尽事项。
 */
export function resolveACOverride(
  acRole: 'attacker' | 'defender',
  mode: ProjectMode,
  stage?: NanjuGuardStage,
): ACActorConfig {
  if (stage !== undefined) {
    const node = getPhaseNode(mode, stage)
    if (node) return resolveACActors(node)[acRole]
  }
  return AC_PRESETS[mode === 'quick' ? 'light' : 'medium'][acRole]
}

// ===== 层三：产出路径阶段约束注入 =====

/** 各阶段允许写入的产出目录（软约束注入用；真正拦截靠层一，L2 违规写入检测留后续）。
 *  P0-5（2026-09-18）：architecture 阶段增入 00_SPIKES——架构师按 T1-T3 判据派发的
 *  Spike 实验子会话产物落位目录（写放行清单；目录已注册进脚手架 docDirs 与
 *  router-gate 归因集，委派子会话豁免不受 unbound-write-deny 影响）。 */
export const STAGE_WRITE_DIR: Record<NanjuGuardStage, string> = {
  requirements: '01_PRD',
  prototype: '02_UX_DESIGN',
  architecture: '03_ARCHITECTURE（架构产出）与 00_SPIKES（Spike 实验产物，见任务书 Spike 条文）',
  planning: '05_PROJECT_PLAN',
  coding: '08_APP',
  testing: '06_TESTS',
}

/** 幂等标记：task 已含该标记则不再追加 */
export const PATH_CONSTRAINT_MARKER = '【阶段边界】'

/**
 * 层三：在委派 task 末尾追加一行阶段写入边界约束（幂等——已含标记原样返回）。
 * AC 类委派不注入（审计只读）；判不准（stage/unmatched）时注入（宁多勿少）。
 * F6（W18，v0.17.81）文案诚实化：层三是提示性软约束——主进程对 L2 写入无强制拦截
 * 机制，不再声称「将被记录并要求返工」（虚假承诺），改为明示软约束边界。
 */
export function injectStagePathConstraint(stage: NanjuGuardStage, task: string): string {
  if (task.includes(PATH_CONSTRAINT_MARKER)) return task
  const title = STAGE_TITLES[stage]
  const dir = STAGE_WRITE_DIR[stage]
  return (
    `${task}\n${PATH_CONSTRAINT_MARKER}当前处于「${title}」（${stage}）阶段，` +
    `本委派应在项目目录 ${dir} 内写入文件；跨目录写入为提示性软约束（系统当前不强制拦截），请遵守阶段产出边界。`
  )
}

// ===== 工具名识别 =====

const DELEGATE_TOOL_NAMES = new Set(['delegate_agent', 'delegate_agents'])

/** 归一化工具名（剥去 mcp__collaboration__ 前缀） */
export function normalizeDelegationToolName(toolName: string): string {
  return toolName.startsWith('mcp__collaboration__') ? toolName.slice('mcp__collaboration__'.length) : toolName
}

/** 是否为委派类工具（delegate_agent / delegate_agents 及其 MCP 前缀变体） */
export function isDelegationTool(toolName: string): boolean {
  return DELEGATE_TOOL_NAMES.has(normalizeDelegationToolName(toolName))
}

/** 单个委派的文本是否命中 AC 审计动词（层二独立判定：不受层一判定顺序影响；W18 起用
 * AC_AUDIT_VERBS——裸 'AC' 不再触发层二覆写候选/层三注入豁免，与层一 ① 同源） */
export function matchACKeyword(source: DelegationMatchSource): string | undefined {
  return findKeyword(buildMatchText(source), AC_AUDIT_VERBS)
}

/**
 * W18：文本同时命中的**当前阶段**词（角色词 ∪ 产出物词，键序首命中）。
 * 用途：router-gate stage-deny 埋点 coPresentStageKeyword——严格序下合法交叉表述
 * （本阶段词+他阶段词并存）被拒时的本阶段词共现率（deny-with-coPresent）观察口径
 * （共现≠误拦：正确拦截也共现，W18.1 A4 口径修正）；undefined = 无本阶段词共现。
 */
export function matchStageKeyword(stage: NanjuGuardStage, source: DelegationMatchSource): string | undefined {
  return findKeyword(buildMatchText(source), [...STAGE_ROLE_KEYWORDS[stage], ...STAGE_OUTPUT_KEYWORDS[stage]])
}

/**
 * 从工具入参中提取委派匹配文本源列表。
 * delegate_agent → [{title, task}]；delegate_agents → items 每项的 {title, task}。
 * 防御式取字段（非字符串忽略；items 非数组 → 空，交给 validateToolInput 必填校验）。
 * 非对象项用空 source 占位，保持与 items 数组索引对齐（批量 deny 文案需报序号）。
 * W22 M#9/R2：同时提取显式 channelId/modelId（不入匹配文本，仅作 R2 端点家族判定
 * ——router-gate 无需改动即自动获得端点信息，规则在 checkDelegationAgainstStage 内
 * 生效）。
 */
export function extractDelegationSources(input: Record<string, unknown>): DelegationMatchSource[] {
  const pick = (obj: Record<string, unknown>): DelegationMatchSource => ({
    title: typeof obj.title === 'string' ? obj.title : undefined,
    task: typeof obj.task === 'string' ? obj.task : undefined,
    expectedOutput: typeof obj.expectedOutput === 'string' ? obj.expectedOutput : undefined,
    channelId: typeof obj.channelId === 'string' ? obj.channelId : undefined,
    modelId: typeof obj.modelId === 'string' ? obj.modelId : undefined,
  })
  if (Array.isArray(input.items)) {
    return input.items.map((it) =>
      typeof it === 'object' && it !== null ? pick(it as Record<string, unknown>) : {},
    )
  }
  return [pick(input)]
}

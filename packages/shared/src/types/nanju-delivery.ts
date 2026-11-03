/**
 * nanju-delivery — 交付视图共享类型（Task 12，Phase 1 完善）
 *
 * 主进程（nanju-delivery-view.ts）与渲染端（DeliveryCard.tsx）共用。
 * 与 GwtReportJson（nanju-gwt-runner.ts）严格对齐字段名/形态，不自行声明。
 *
 * 约束：
 * - 纯类型/常量模块，不引人 electron 主进程或 renderer 依赖
 * - 不含任何文件读取、IPC、React/Jotai 逻辑
 * - 字段来源：全部从 nanju-gwt-runner.ts GwtReportJson 复制，不从 engineering-contract 重复引入
 */

// ===== 工程契约品类常量（与 nanju-engineering-contract.ts TARGET_KINDS 对齐） =====

/** 工程契约目标品类（nanju-engineering-contract.ts 的 TARGET_KINDS 镜像） */
export const DELIVERY_TARGET_KINDS = ['web', 'api', 'mobile', 'desktop', 'cli', 'ai'] as const
export type DeliveryTargetKind = typeof DELIVERY_TARGET_KINDS[number]

// ===== GWT 机器报告（与 nanju-gwt-runner.ts GwtReportJson 严格对齐） =====

/**
 * GWT 验收报告（06_TESTS/report.json）字段对齐。
 *
 * 来源：nanju-gwt-runner.ts GwtReportJson 接口（2348 行附近）。
 * 关键语义：
 * - verdict='pass'：全部通过（skipped=0 是硬约束，跳过不得视为通过）
 * - verdict='fail'：有失败场景或 skipped>0
 * - verdict='error'：执行器异常（报告仍落盘）
 * - verdict='blocked'：所需执行能力不可用
 * - entryFingerprint：sha256+size，pass 后改应用需重跑
 * - runId：W18 Wave2 交付 ack 绑定用运行标识（v0.17.82 前旧报告无此字段）
 */
export interface GwtReportJson {
  generatedAt: string
  verdict: 'pass' | 'fail' | 'error' | 'blocked'
  runId?: string
  entryFingerprint?: { sha256: string; size: number }
  entry: string
  scenariosTotal: number
  passed: number
  failed: number
  skipped: number
  coveredUs?: string[]
  uncoveredUs?: string[]
  retryCount: number
  errorReason?: string | null
  warnings?: string[]
  scenarios?: Array<{
    feature: string
    scenario: string
    status: 'pass' | 'fail' | 'skip' | 'skipped' | 'error'
    reason: string | null
    failedStep: {
      index: number
      kind: string
      text: string
      expected: string
      actual: string
      category?: string
    } | null
    screenshot: string | null
    durationMs: number
  }>
}

// ===== 交付视图类型 =====

/**
 * 交付验收结论。
 *
 * 约束：fail 与 error 必须保持区分（不可洗成 partial）。
 * 语义（来自 gwt-runner.ts judgeGwtResult）：
 * - pass：verdict=pass（含 skipped=0 硬约束）
 * - fail：有失败场景，或 skipped>0（跳过阻断验收）
 * - error：执行器异常（报告仍落盘）
 * - blocked：执行能力不可用
 * - stale：报告存在但入口指纹已变（pass 后应用被修改）
 * - not-tested：尚未生成报告
 */
export type DeliveryVerdict = 'pass' | 'fail' | 'error' | 'blocked' | 'stale' | 'not-tested'

/** 测试证据条目 */
export interface DeliveryTestEvidence {
  runId: string | null
  generatedAt: string | null
  verdict: DeliveryVerdict
  scenariosTotal: number
  passed: number
  failed: number
  skipped: number
  entryPath: string
  entryFingerprint: string | null
  retryCount: number
  coveredUs: string[]
  uncoveredUs: string[]
  warnings: string[]
}

/** 交付视图模型 */
export interface DeliveryViewModel {
  projectId: string
  workspaceSlug: string
  projectDir: string
  /** 来自工程契约 target.kind；无契约时为 'unknown' */
  deliveryType: DeliveryTargetKind | 'unknown'
  entryPath: string
  /** realpath 防 symlink/../；入口不存在时为 null */
  entryAbsPath: string | null
  reportJsonPath: string
  testsDirPath: string
  launchInstructions: string
  verdict: DeliveryVerdict
  evidence: DeliveryTestEvidence[]
  /**
   * 历史验收记录（Task 12.1/12.3，审计 B6-F-09）：从
   * `06_TESTS/evidence/<runId>/index.json` 读取的历次工程执行证据摘要，
   * 按时间倒序、上限 10 条。缺目录/坏索引时为 []（不抛错）。
   * 只读证据，不承载交付授权。
   */
  history: DeliveryHistoryEntry[]
  hasHistory: boolean
  lastTestAt: string | null
  currentEntryFingerprint: { sha256: string; size: number } | null
  /** stale 时给用户的说明；非 stale 时为 null */
  staleMessage: string | null
}

/** 单次工程执行的历史摘要（来自 evidence/<runId>/index.json） */
export interface DeliveryHistoryEntry {
  runId: string
  generatedAt: string
  /** 该轮全部测试的证据结论（全部 pass 才 pass；有 error 优先 error；有 fail 则 fail） */
  conclusion: DeliveryVerdict
  testsTotal: number
  passed: number
  failed: number
  errored: number
  blocked: number
  /** 该轮证据索引文件的工程内相对路径（供“查看测试目录”定位） */
  indexRelPath: string | null
}

// ===== 纯函数工具（shared 级别，供主进程/渲染共用，不引人任何运行时依赖） =====

/**
 * 从工程契约 target.kind 解析交付类型（shared 纯函数）。
 */
export function resolveDeliveryTypeFromContract(
  contractTargetKind: string | undefined,
): DeliveryTargetKind | 'unknown' {
  if (contractTargetKind && (DELIVERY_TARGET_KINDS as readonly string[]).includes(contractTargetKind)) {
    return contractTargetKind as DeliveryTargetKind
  }
  return 'unknown'
}

/**
 * 生成人类可读的启动说明（不包含 shell 执行指令，产品代不执行任何命令）。
 * 入口是 08_APP 内的相对路径，对应产物文件，不是可执行命令。
 *
 * Task 12.2/12.3：按品类给出等价可使用入口（启动/安装说明/预览/测试目录），
 * 普通用户不必进入源码目录；desktop/cli/api 等可执行产物明确指向工程 README 的
 * 安装说明，不静默降低 DoD（若缺真实启动动作，必须在产品验收中显式记录差异）。
 */
export function buildDeliveryLaunchInstructions(
  entryPath: string,
  kind?: DeliveryTargetKind | 'unknown',
): string {
  const fileName = entryPath.split('/').pop() ?? entryPath
  if (/\.html?$/i.test(entryPath)) {
    return `在右侧预览打开「${fileName}」，或在文件面板双击直接查看`
  }
  if (/\.(md|mdx|jpg|jpeg|png|gif|webp|svg|json|txt)$/i.test(entryPath)) {
    return `在文件面板中找到「${fileName}」并预览`
  }
  switch (kind) {
    case 'desktop':
      return `「${fileName}」是桌面应用入口：请在文件面板定位它，按工程 README 的安装/启动说明运行（需本机图形环境）；产品只提供入口与说明，不代执行命令`
    case 'cli':
      return `「${fileName}」是命令行程序入口：请在文件面板定位它，按工程 README 的安装与调用说明使用；产品只提供入口与说明，不代执行命令`
    case 'api':
      return `「${fileName}」是服务入口：部署与启动方式见工程 README，服务就绪后按工程契约的接口地址验证；产品只提供入口与说明，不代执行命令`
    case 'ai':
      return `「${fileName}」是 AI 应用入口：模型/依赖配置与启动方式见工程 README（可能需要外部服务授权）；产品只提供入口与说明，不代执行命令`
    case 'web':
      return `「${fileName}」是 Web 服务入口：启动方式见工程 README，启动后按说明访问本地地址；产品只提供入口与说明，不代执行命令`
    case 'mobile':
      return `「${fileName}」是移动端入口：需要真机或模拟器，安装/运行方式见工程 README；产品只提供入口与说明，不代执行命令`
    default:
      return `在 08_APP 目录下找到「${fileName}」查看`
  }
}

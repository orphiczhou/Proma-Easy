/**
 * nanju-delivery-view — 交付视图服务（Task 12，Phase 1 完善）
 *
 * 职责边界：
 * - 读取工程目录 `06_TESTS/report.json`（GWT 验收报告）和
 *   `03_ARCHITECTURE/engineering.json`（工程契约），构建交付视图模型；
 * - 交付入口视图模型含：品类/路径/启动说明/测试证据，不执行命令/不绕批准。
 *
 * 关键区别：
 * - GwtProgressCard = 实时进度（监听 nanju:gwt-progress 事件流）
 * - 本模块 = 持久历史验收视图（读 report.json + engineering.json）
 *
 * 架构约束：
 * - 纯函数：无 IPC 依赖、无 React/Jotai 依赖
 * - 主进程序列化读取（readFileSync）
 * - 损坏/类型错误/缺失的报告不抛错：返回 not-tested 视图（不冒充结论）
 * - 入口路径 realpath 防 symlink/../
 * - 旧报告指纹不等当前产物 → stale（不冒充当前通过）
 */

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { getNanjuProjectDir } from './nanju-project'
import {
  type GwtReportJson,
  type DeliveryViewModel,
  type DeliveryVerdict,
  type DeliveryTestEvidence,
  type DeliveryHistoryEntry,
  resolveDeliveryTypeFromContract,
  buildDeliveryLaunchInstructions,
  DELIVERY_TARGET_KINDS,
} from '@proma/shared'
import type { EngineeringContract } from './nanju-engineering-contract'

// ===== 常量 =====

const ENGINEERING_CONTRACT_PATH = '03_ARCHITECTURE/engineering.json'

/** 工程执行证据根目录（与 nanju-engineering-evidence.ENGINEERING_EVIDENCE_DIR 对齐） */
const EVIDENCE_DIR = '06_TESTS/evidence'
/** 历史记录上限（防目录巨大时读盘无界） */
const HISTORY_LIMIT = 10

// ===== 历史验收记录（Task 12.1/12.3，审计 B6-F-09） =====

/**
 * 读取 `06_TESTS/evidence/` 下各 runId 的 index.json，构建倒序历史摘要。
 * 安全：runId 目录名严格白名单（拒 `.`/`..`/分隔符/NUL），只读普通目录；
 * 坏索引/非法条目跳过（不抛错、不虚报轮次）。
 */
function readDeliveryHistory(projectDir: string): DeliveryHistoryEntry[] {
  const root = join(projectDir, EVIDENCE_DIR)
  if (!existsSync(root)) return []
  let names: string[] = []
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
  } catch {
    return []
  }
  const entries: DeliveryHistoryEntry[] = []
  for (const runId of names) {
    // 路径穿越/隐藏目录防护：首字符必须为字母数字，仅允许安全字符，拒 `.`/`..`/`..evil` 等
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId) || runId === '.' || runId === '..' || runId.includes('..')) continue
    // 索引文件必须是工程内普通文件：拒符号链接（防指向工程外/哨兵文件）、拒超大文件（防读盘失控）
    const indexPath = join(root, runId, 'index.json')
    try {
      const st = lstatSync(indexPath)
      if (!st.isFile() || st.isSymbolicLink() || st.size > 1024 * 1024) continue
    } catch {
      continue
    }
    const raw = safeReadJsonFile<Record<string, unknown>>(indexPath)
    if (!raw || typeof raw !== 'object') continue
    const tests = Array.isArray(raw.tests) ? (raw.tests as Array<Record<string, unknown>>) : null
    if (!tests) continue
    let passed = 0, failed = 0, errored = 0, blocked = 0
    for (const t of tests) {
      const s = t?.status
      if (s === 'pass') passed += 1
      else if (s === 'fail') failed += 1
      else if (s === 'error') errored += 1
      else if (s === 'blocked') blocked += 1
    }
    const testsTotal = tests.length
    const conclusion: DeliveryVerdict =
      testsTotal === 0 ? 'not-tested'
        : errored > 0 ? 'error'
          : failed > 0 ? 'fail'
            : blocked > 0 ? 'blocked'
              : passed === testsTotal ? 'pass'
                : 'not-tested'
    const generatedAt = typeof raw.generatedAt === 'string'
      ? raw.generatedAt
      : (typeof tests[0]?.['generatedAt'] === 'string' ? tests[0]['generatedAt'] as string : '')
    entries.push({
      runId,
      generatedAt,
      conclusion,
      testsTotal,
      passed,
      failed,
      errored,
      blocked,
      indexRelPath: `${EVIDENCE_DIR}/${runId}/index.json`,
    })
  }
  entries.sort((a, b) => (b.generatedAt || '').localeCompare(a.generatedAt || ''))
  return entries.slice(0, HISTORY_LIMIT)
}

// ===== 运行时 Schema 校验（FP 类型错误不 throw，降级返回 null） =====

/** 校验 GwtReportJson 核心字段类型；类型错误不抛错，返回 null */
function validateReportSchema(raw: unknown): GwtReportJson | null {
  if (raw === null || raw === undefined || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>

  // string 必填字段
  if (typeof obj.generatedAt !== 'string') return null
  if (typeof obj.entry !== 'string') return null

  // verdict 枚举
  const VALID_VERDICTS = ['pass', 'fail', 'error', 'blocked']
  if (!VALID_VERDICTS.includes(obj.verdict as string)) return null

  // number 字段（允许 undefined 但类型必须正确）
  if (obj.runId !== undefined && typeof obj.runId !== 'string') return null
  if (typeof obj.scenariosTotal !== 'number') return null
  if (typeof obj.passed !== 'number') return null
  if (typeof obj.failed !== 'number') return null
  if (typeof obj.skipped !== 'number') return null
  if (typeof obj.retryCount !== 'number') return null

  // entryFingerprint 形态校验（若存在）
  if (obj.entryFingerprint !== undefined && obj.entryFingerprint !== null) {
    if (typeof obj.entryFingerprint !== 'object') return null
    const fp = obj.entryFingerprint as Record<string, unknown>
    if (typeof fp.sha256 !== 'string' || typeof fp.size !== 'number') return null
  }

  // array 字段（若存在）
  if (obj.coveredUs !== undefined && !Array.isArray(obj.coveredUs)) return null
  if (obj.uncoveredUs !== undefined && !Array.isArray(obj.uncoveredUs)) return null
  if (obj.warnings !== undefined && !Array.isArray(obj.warnings)) return null

  // string | null 字段
  if (obj.errorReason !== undefined && obj.errorReason !== null && typeof obj.errorReason !== 'string') return null

  return obj as unknown as GwtReportJson
}

/** 校验 EngineeringContract target.kind（用于品类解析） */
function validateContractTargetKind(raw: unknown): EngineeringContract['target']['kind'] | undefined {
  if (raw === null || raw === undefined || typeof raw !== 'object') return undefined
  const obj = raw as Record<string, unknown>
  if (typeof obj !== 'object' || obj === null) return undefined
  const target = (obj as Record<string, unknown>).target as Record<string, unknown> | undefined
  if (!target || typeof target !== 'object') return undefined
  const kind = target.kind as string | undefined
  if (kind && (DELIVERY_TARGET_KINDS as readonly string[]).includes(kind)) {
    return kind as EngineeringContract['target']['kind']
  }
  return undefined
}

// ===== 入口路径 realpath（防 symlink/../） =====

/**
 * 解析入口绝对路径（realpath 防 symlink/../）。
 * 入口文件不存在或无法解析时返回 null。
 * 导出供测试（R3 D-3 兄弟目录前缀边界）验证。
 */
export function resolveEntryAbsPath(projectDir: string, entryPath: string): string | null {
  try {
    const abs = join(projectDir, entryPath)
    // realpathSync 解析 symlink；路径含 ../ 会自动解析
    const resolved = realpathSync(abs)
    // 二次防御：确认解析后仍在 projectDir 内（防 ../ 逃逸；加分隔符防兄弟目录 project-<id>-evil 前缀命中）
    const root = resolve(projectDir)
    if (resolved !== root && !resolved.startsWith(root + sep)) return null
    return resolved
  } catch {
    return null
  }
}

// ===== 当前入口指纹实测 =====

/** 实测入口文件 sha256+size（文件不存在/读取异常返回 null） */
function computeCurrentFingerprint(entryAbsPath: string | null): { sha256: string; size: number } | null {
  if (!entryAbsPath || !existsSync(entryAbsPath)) return null
  try {
    const buf = readFileSync(entryAbsPath)
    return {
      sha256: createHash('sha256').update(buf).digest('hex'),
      size: buf.byteLength,
    }
  } catch {
    return null
  }
}

// ===== 报告缺失/损坏读取 =====

function safeReadJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, 'utf-8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

// ===== 品类解析 =====

/**
 * 读取工程契约 target.kind（无契约文件或解析失败时返回 'unknown'）。
 */
function readContractTargetKind(projectDir: string): EngineeringContract['target']['kind'] | undefined {
  const contractPath = join(projectDir, ENGINEERING_CONTRACT_PATH)
  const raw = safeReadJsonFile<unknown>(contractPath)
  if (!raw) return undefined
  return validateContractTargetKind(raw)
}

// ===== verdict 映射 =====

/**
 * 将 GWT verdict 映射为交付 verdict。
 * 约束：fail 与 error 必须保持区分（不可洗成 partial）。
 * stale 由调用方单独检测（基于指纹比对），不在本函数处理。
 */
export function mapReportVerdict(report: GwtReportJson): DeliveryVerdict {
  if (report.verdict === 'pass') {
    // 纵深防御（审计 B6-F-05）：不只信任 verdict 字段，交叉核对计数不变量。
    // 与 nanju-gwt-runner.judgeGwtResult 的 pass 口径一致：
    //   passed > 0 且 failed === 0 且 skipped === 0 且 passed === scenariosTotal。
    // 报告被篡改或损坏时（pass + skipped>0 / 计数不符），按未通过处理，绝不显示"验收通过"。
    const consistent =
      report.passed > 0 &&
      report.failed === 0 &&
      report.skipped === 0 &&
      report.passed === report.scenariosTotal
    return consistent ? 'pass' : 'fail'
  }
  if (report.verdict === 'blocked') return 'blocked'
  if (report.verdict === 'error') return 'error'
  // fail：存在失败场景，或 skipped>0（必测场景跳过不得视为通过）
  return 'fail'
}

// ===== 报告完整性警告（与 verdict 交叉核对同源） =====

/**
 * 报告内部一致性警告：verdict=pass 但计数不变量被破坏时为 UI 提供可解释原因。
 * 与 mapReportVerdict 使用同一判据，避免"显示 fail 但无说明"。
 */
export function reportIntegrityWarnings(report: GwtReportJson): string[] {
  const consistent =
    report.passed > 0 &&
    report.failed === 0 &&
    report.skipped === 0 &&
    report.passed === report.scenariosTotal
  if (report.verdict === 'pass' && !consistent) {
    return [
      '测试报告计数不自洽（verdict=pass 但存在失败/跳过或与场景总数不符），已按未通过处理，请重新运行验收测试',
    ]
  }
  return []
}

// ===== 构建证据条目 =====

function buildEvidence(report: GwtReportJson): DeliveryTestEvidence {
  return {
    runId: report.runId ?? null,
    generatedAt: report.generatedAt,
    verdict: mapReportVerdict(report),
    scenariosTotal: report.scenariosTotal,
    passed: report.passed,
    failed: report.failed,
    skipped: report.skipped,
    entryPath: report.entry,
    entryFingerprint: report.entryFingerprint?.sha256 ?? null,
    retryCount: report.retryCount,
    coveredUs: report.coveredUs ?? [],
    uncoveredUs: report.uncoveredUs ?? [],
    warnings: [...(report.warnings ?? []), ...reportIntegrityWarnings(report)],
  }
}

// ===== 公开 API =====

/**
 * 读取并构建交付视图模型（纯函数）。
 *
 * stale 检测：比较 report.entryFingerprint（报告记录的指纹）与当前入口实测指纹。
 * 不一致时 verdict → 'stale'，staleMessage 告知用户需要重跑。
 *
 * @param workspaceSlug 工作区 slug
 * @param projectId 项目 id
 * @returns 视图模型（纯函数，不抛错）；报告缺失/损坏/枚举非法时返回 not-tested 视图
 */
export function buildDeliveryViewModel(
  workspaceSlug: string,
  projectId: string,
): DeliveryViewModel | null {
  const projectDir = getNanjuProjectDir(workspaceSlug, projectId)
  const reportJsonPath = join(projectDir, '06_TESTS', 'report.json')
  const testsDirPath = join(projectDir, '06_TESTS')

  // 读取并运行时 schema 校验
  const rawReport = safeReadJsonFile<unknown>(reportJsonPath)
  const report: GwtReportJson | null = validateReportSchema(rawReport)

  // 品类：从工程契约读取 target.kind；无契约时为 'unknown'
  const contractKind = readContractTargetKind(projectDir)
  const deliveryType = resolveDeliveryTypeFromContract(contractKind)

  // 入口路径
  const entryPath = report?.entry ?? '08_APP/index.html'
  const entryAbsPath = resolveEntryAbsPath(projectDir, entryPath)

  // 当前指纹实测
  const currentFingerprint = computeCurrentFingerprint(entryAbsPath)

  // 证据
  let verdict: DeliveryVerdict = 'not-tested'
  let evidence: DeliveryTestEvidence[] = []
  let staleMessage: string | null = null
  let lastTestAt: string | null = null
  let hasHistory = false

  if (report) {
    verdict = mapReportVerdict(report)
    lastTestAt = report.generatedAt
    hasHistory = true
    evidence = [buildEvidence(report)]

    // stale 检测：报告有指纹记录 && 当前实测存在 → 比对
    if (report.entryFingerprint && currentFingerprint) {
      const same =
        report.entryFingerprint.sha256 === currentFingerprint.sha256 &&
        report.entryFingerprint.size === currentFingerprint.size
      if (!same) {
        verdict = 'stale'
        staleMessage =
          '应用在测试通过后被修改（报告记录的入口指纹与当前文件不符）。' +
          '请重新运行验收测试（声明 <!-- PHASE_ADVANCE: testing -->）'
        // D-1：stale 覆盖后同步 evidence[].verdict，并把计数不自洽等完整性告警并入 staleMessage（不掩去篡改信号）
        const integrityWarnings = reportIntegrityWarnings(report)
        evidence = evidence.map((ev) => ({ ...ev, verdict: 'stale' as DeliveryVerdict }))
        if (integrityWarnings.length > 0) {
          staleMessage += '；报告完整性存疑：' + integrityWarnings.join('；')
        }
      }
    }
    // 入口文件不存在
    else if (!entryAbsPath && report.verdict === 'pass') {
      verdict = 'stale'
      staleMessage = '入口文件已不存在，无法确认当前验收状态。请重新运行验收测试。'
    }
  }

  return {
    projectId,
    workspaceSlug,
    projectDir,
    deliveryType,
    entryPath,
    entryAbsPath,
    reportJsonPath,
    testsDirPath,
    launchInstructions: buildDeliveryLaunchInstructions(entryPath, deliveryType),
    verdict,
    evidence,
    history: readDeliveryHistory(projectDir),
    hasHistory,
    lastTestAt,
    currentEntryFingerprint: currentFingerprint,
    staleMessage,
  }
}

// ===== 导出版===== 

export type { DeliveryViewModel, DeliveryVerdict, DeliveryTestEvidence } from '@proma/shared'

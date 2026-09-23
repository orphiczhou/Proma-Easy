/** 拒因的持久化与重启读取；这里只提供纠偏上下文，不授予阶段推进权。 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { getNanjuProject, getNanjuProjectDir, getProjectPendingAdvanceCorrection, setProjectPendingAdvanceCorrection } from './nanju-project'
import { evaluatePhaseOutput } from './nanju-router-gate'
import type { GateCheck } from './nanju-router-gate'
import type { PhaseId } from './nanju-router'
import { recordTelemetry } from './nanju-telemetry'

/** 只哈希阶段产物；不进入依赖/构建缓存或跟随符号链接。 */
export function phaseArtifactFingerprint(projectDir: string): string {
  const hash = createHash('sha256')
  let files = 0
  const visit = (relative: string): void => {
    if (++files > 5000) throw new Error('阶段产物数量超出纠偏指纹上限，请整理产物后重试。')
    const path = join(projectDir, relative)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) { hash.update(`link:${relative}`); return }
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        if (['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', 'evidence'].includes(name)) continue
        visit(join(relative, name))
      }
    } else if (stat.isFile()) {
      hash.update(relative)
      // 大产物不可仅靠mtime假定未变；拒绝创建错误的幂等键。
      if (stat.size > 20 * 1024 * 1024) throw new Error('阶段产物过大，无法生成可靠纠偏指纹。')
      hash.update(readFileSync(path))
    }
  }
  for (const root of ['01_PRD', '02_UX_DESIGN', '03_ARCHITECTURE', '05_PROJECT_PLAN', '06_TESTS', '08_APP']) {
    if (existsSync(join(projectDir, root))) visit(root)
  }
  return hash.digest('hex')
}

function safeText(text: string): string {
  return text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[私钥已隐藏]')
    .replace(/((?:[A-Za-z0-9_-]*(?:key|token|password|secret)[A-Za-z0-9_-]*)["']?\s*[:=]\s*)[^\s,;]+/gi, '$1[已隐藏]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [已隐藏]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[已隐藏]@').slice(0, 3000)
}

export function persistAdvanceCorrection(
  workspaceSlug: string, projectId: string,
  correction: { kind: 'target-deny' | 'gate-deny'; target: string; expected: string; count: number; message: string; checks?: GateCheck[] },
): void {
  const project = getNanjuProject(workspaceSlug, projectId)
  if (!project) return
  const checks = (correction.checks ?? evaluatePhaseOutput(workspaceSlug, projectId, project.currentStage as PhaseId).checks)
    .slice(0, 30).map(check => ({ ...check, actual: safeText(check.actual), expected: safeText(check.expected), nextAction: check.nextAction ? safeText(check.nextAction) : undefined }))
  let fingerprint: string | undefined
  try { fingerprint = phaseArtifactFingerprint(getNanjuProjectDir(workspaceSlug, projectId)) } catch { /* 无指纹仍记录blocked，绝不视为已消费 */ }
  const eventKey = fingerprint ? createHash('sha256').update(JSON.stringify([projectId, project.currentStage, correction.target, fingerprint, checks])).digest('hex') : undefined
  const previous = getProjectPendingAdvanceCorrection(workspaceSlug, projectId)
  setProjectPendingAdvanceCorrection(workspaceSlug, projectId, {
    kind: correction.kind, target: correction.target, expected: correction.expected,
    count: correction.count, at: previous && previous.eventKey === eventKey && eventKey ? previous.at : new Date().toISOString(),
    fromStage: project.currentStage, executionState: previous?.eventKey === eventKey && previous?.executionState === 'cancelled' ? 'cancelled' : 'blocked', message: safeText(correction.message),
    checks, fingerprint, eventKey,
    consumedEventKey: previous?.eventKey === eventKey ? previous?.consumedEventKey : undefined,
  })
  if (!eventKey || eventKey !== previous?.eventKey) recordTelemetry(workspaceSlug, 'advance.correction', { project_id: projectId, fromStage: project.currentStage, target: correction.target, eventKey, checks, message: safeText(correction.message) }, projectId)
}

/** 每次构建新 run 上下文都从磁盘读取并重验；不在这里新建委派或自动续接。 */
export function buildPendingAdvanceRecoveryPrompt(workspaceSlug: string, projectId: string): string | null {
  const project = getNanjuProject(workspaceSlug, projectId)
  const pending = getProjectPendingAdvanceCorrection(workspaceSlug, projectId)
  if (!project || !pending || pending.executionState === 'cancelled') return null
  if (pending.fromStage && pending.fromStage !== project.currentStage) return null
  const current = evaluatePhaseOutput(workspaceSlug, projectId, project.currentStage as PhaseId)
  const checks = current.checks.filter(check => !check.pass)
  const detail = checks.length
    ? checks.map(check => `- ${check.id}${check.path ? ` (${check.path})` : ''}：期望 ${check.expected}；实际 ${check.actual}；下一步 ${check.nextAction ?? '修正后重验'}`).join('\n')
    : '- 当前阶段产出校验已满足；目标合法性、确认授权、AC 与交付机器凭证仍须通过原有门禁。'
  return `\n## 待纠正的阶段推进（已持久化，非推进授权）\n业务阶段仍为 ${project.currentStage}；先前目标 ${pending.target}，合法目标记录 ${pending.expected || '无'}。\n${pending.message ? safeText(pending.message) : '历史版本只保存了拒收目标，本轮已重新检查产出。'}\n${safeText(detail)}\n请优先续接已有角色会话处理具体缺项，避免重复委派。用户取消或改变目标时停止自动续接；完成后重新声明合法推进，由系统重验，不能修改状态文件跳过门禁。\n`
}

/** 先落盘领取再发续接；崩溃/忙碌放弃后保留可见拒因，绝不重复自动启动同事件。 */
export function claimAdvanceCorrectionContinuation(workspaceSlug: string, projectId: string): boolean {
  const pending = getProjectPendingAdvanceCorrection(workspaceSlug, projectId)
  if (!pending?.eventKey || pending.executionState === 'cancelled' || pending.consumedEventKey === pending.eventKey) return false
  setProjectPendingAdvanceCorrection(workspaceSlug, projectId, { ...pending, consumedEventKey: pending.eventKey, executionState: 'correcting' })
  return true
}

export function cancelAdvanceCorrection(workspaceSlug: string, projectId: string): void {
  const pending = getProjectPendingAdvanceCorrection(workspaceSlug, projectId)
  if (pending) setProjectPendingAdvanceCorrection(workspaceSlug, projectId, { ...pending, executionState: 'cancelled' })
}

export function getAdvanceCorrectionView(workspaceSlug: string, projectId: string): import('@proma/shared').AdvanceCorrectionView | null {
  const pending = getProjectPendingAdvanceCorrection(workspaceSlug, projectId)
  if (!pending) return null
  return { state: pending.executionState ?? 'blocked', target: safeText(pending.target), message: safeText(pending.message ?? '阶段推进未完成，请检查本阶段产出并继续。'), checks: (pending.checks ?? []).slice(0, 30).map(check => ({ ...check, actual: safeText(check.actual), expected: safeText(check.expected), nextAction: check.nextAction ? safeText(check.nextAction) : undefined })) }
}

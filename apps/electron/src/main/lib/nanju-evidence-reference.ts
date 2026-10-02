import { realpathSync, statSync } from 'node:fs'
import { sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 引用在场检查，不证明来源内容真实或结论正确。空格URL用<...>或百分号编码。 */
export function hasEvidenceReference(text: string, badge: '实证' | '文证', allowedDirectories: readonly string[]): boolean {
  const candidates = [...text.matchAll(/<((?:https?|file):\/\/[^<>\r\n]+)>|((?:https?|file):\/\/[^\s<>\])}，。；、！？」』]+)(?=$|[\s<>\])}，。；、！？」』])/gi)]
  return candidates.some(match => {
    try {
      const url = new URL((match[1] ?? match[2] ?? '').replace(/[.,;]+$/, ''))
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname && !url.username && !url.password) return true
      if (badge !== '实证' || url.protocol !== 'file:' || url.search || url.hash) return false
      const path = realpathSync(fileURLToPath(url))
      if (!statSync(path).isFile()) return false
      return allowedDirectories.some(directory => {
        try { const root = realpathSync(directory); return path.startsWith(root.endsWith(sep) ? root : root + sep) } catch { return false }
      })
    } catch { return false }
  })
}

export function hasEvidenceDate(text: string): boolean {
  return [...text.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)].some(match => {
    const date = new Date(`${match[1]}T00:00:00Z`)
    return Number.isFinite(date.getTime()) && date.toISOString().startsWith(match[1]!)
  })
}

/** 单条引用的诊断结果（修复A，E2E 2026-10-01 架构卡死根因：拒因不区分「没写引用」
 * 与「写了但路径不存在」——架构师两轮收到一字不差的拒因，修正方向被封死）。 */
export interface EvidenceReferenceDiagnosis {
  ok: boolean
  /** 失败主因（ok=false 时）：no-reference=文本无任何 URL；file-not-found=file:// 引用
   * 在盘上不存在；file-outside-allowed=存在但不在允许目录；invalid-url=URL 形态无效；
   * missing-date=引用有效但缺检索日期。 */
  reason?: 'no-reference' | 'file-not-found' | 'file-outside-allowed' | 'invalid-url' | 'missing-date'
  /** 失效的 file:// 引用原文（file-not-found / file-outside-allowed 时非空，供拒因列出）。 */
  failedRefs?: string[]
}

/** hasEvidenceReference + hasEvidenceDate 的诊断版（同一判定口径，失败时带回细分原因
 * 与失效引用路径）。拒因文案据此区分反馈，作者可自修正。 */
export function diagnoseEvidenceReference(text: string, badge: '实证' | '文证', allowedDirectories: readonly string[]): EvidenceReferenceDiagnosis {
  const candidates = [...text.matchAll(/<((?:https?|file):\/\/[^<>\r\n]+)>|((?:https?|file):\/\/[^\s<>\])}，。；、！？」』]+)(?=$|[\s<>\])}，。；、！？」』])/gi)]
  if (candidates.length === 0) return { ok: false, reason: 'no-reference' }
  const failedFileRefs: string[] = []
  const outsideRefs: string[] = []
  let sawFile = false
  for (const match of candidates) {
    const raw = (match[1] ?? match[2] ?? '')
    try {
      const url = new URL(raw.replace(/[.,;]+$/, ''))
      if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname && !url.username && !url.password) {
        if (hasEvidenceDate(text)) return { ok: true }
        return { ok: false, reason: 'missing-date' }
      }
      if (badge !== '实证' || url.protocol !== 'file:' || url.search || url.hash) {
        failedFileRefs.push(raw); continue
      }
      sawFile = true
      let path: string
      try {
        path = realpathSync(fileURLToPath(url))
      } catch {
        failedFileRefs.push(raw); continue // file-not-found：路径在盘上不存在
      }
      if (!statSync(path).isFile()) { failedFileRefs.push(raw); continue }
      const inside = allowedDirectories.some(directory => {
        try { const root = realpathSync(directory); return path.startsWith(root.endsWith(sep) ? root : root + sep) } catch { return false }
      })
      if (!inside) { outsideRefs.push(raw); continue }
      // 该引用有效：与 hasEvidenceReference 同语义即整体通过（日期要求另判）
      if (hasEvidenceDate(text)) return { ok: true }
      return { ok: false, reason: 'missing-date' }
    } catch {
      failedFileRefs.push(raw)
    }
  }
  // 全部引用失效：按最能引导修正的原因分类
  if (outsideRefs.length > 0 && failedFileRefs.length === 0) return { ok: false, reason: 'file-outside-allowed', failedRefs: outsideRefs }
  if (failedFileRefs.length > 0 && sawFile) return { ok: false, reason: 'file-not-found', failedRefs: failedFileRefs }
  if (outsideRefs.length > 0) return { ok: false, reason: 'file-outside-allowed', failedRefs: outsideRefs }
  if (failedFileRefs.length > 0) return { ok: false, reason: 'invalid-url', failedRefs: failedFileRefs }
  return { ok: false, reason: 'no-reference' }
}

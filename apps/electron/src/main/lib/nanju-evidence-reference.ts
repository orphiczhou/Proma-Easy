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

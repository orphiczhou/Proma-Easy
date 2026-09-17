/** 从 PRD 内容提取用户故事 ID（US-xx，有序去重；兜底 US-1 两位化） */
export function parseUserStories(prdContent: string): string[] {
  const seen = new Set<string>()
  const stories: string[] = []
  for (const m of prdContent.matchAll(/\bUS-(\d+)\b/gi)) {
    const normalized = `US-${String(Number(m[1])).padStart(2, '0')}`
    if (!seen.has(normalized)) {
      seen.add(normalized)
      stories.push(normalized)
    }
  }
  return stories
}


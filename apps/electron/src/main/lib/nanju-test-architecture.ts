/** 架构产出最低契约：仅检查计划完整性，绝不代表执行过测试或获得权限。 */
export const TEST_ARCHITECTURE_GUIDE =
  '架构文档必须包含「## 交付与运行」：以单行「字段：值」列表或两列表格写明目标平台、交付产物、构建方式、启动方式（无需构建时写明理由）；'
  + '以及「## 测试架构」：表格列为「层级 | 框架 | 执行方式 | 证据 | 覆盖」，至少一个实际测试项，'
  + '按工程模板设计单元/集成/行为验收并对应 PRD 的 US 编号；'
  + '该节内另含「### 真实与模拟边界」「### 失败回流」及具体说明。'
  + '构建成功、单元测试或浏览器模拟不能替代真实用户故事验收；缺环境明确阻塞，安装与系统权限仍须用户确认。'

export interface TestArchitectureValidation {
  ok: boolean
  problems: string[]
}

/** 去除 fenced code，避免把格式示例当作项目自身计划。 */
function proseLines(content: string): string[] {
  const lines: string[] = []
  let fence: { char: string; size: number } | undefined
  for (const line of content.split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (marker) {
      if (!fence) fence = { char: marker[1]![0]!, size: marker[1]!.length }
      else if (marker[1]![0] === fence.char && marker[1]!.length >= fence.size && !marker[2]!.trim()) fence = undefined
      continue
    }
    if (!fence) lines.push(line)
  }
  return lines
}

function section(lines: string[], title: string, level: number): string[] {
  const heading = (line: string) => /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
  const start = lines.findIndex((line) => {
    const match = heading(line)
    if (!match || match[1]!.length !== level) return false
    const text = match[2]!.replace(/^\d+(?:\.\d+)*[.、]?\s*/, '')
    return text === title || text.startsWith(title + '（') || text.startsWith(title + ' (')
  })
  if (start < 0) return []
  let end = start + 1
  while (end < lines.length) {
    const match = heading(lines[end]!)
    if (match && match[1]!.length <= level) break
    end++
  }
  return lines.slice(start + 1, end)
}

function cells(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim())
}

export function validateTestArchitecture(content: string): TestArchitectureValidation {
  const lines = proseLines(content)
  const delivery = section(lines, '交付与运行', 2)
  const tests = section(lines, '测试架构', 2)
  const problems: string[] = []
  if (!delivery.length) problems.push('缺少「## 交付与运行」及说明')
  for (const field of ['目标平台', '交付产物', '构建方式', '启动方式']) {
    if (!delivery.some((line) => {
      const pair = cells(line)
      return (line.trim().startsWith('|') && pair.length === 2 && pair[0] === field && Boolean(pair[1]))
        || new RegExp('^\\s*(?:[-*]\\s+)?(?:\\*\\*)?' + field + '(?:\\*\\*)?\\s*[：:]\\s*\\S').test(line)
    })) {
      problems.push('交付与运行缺少有效字段：' + field)
    }
  }
  const columns = ['层级', '框架', '执行方式', '证据', '覆盖']
  const tableLines = tests.filter((line) => line.trim())
  const header = tableLines.findIndex((line) => cells(line).join('|') === columns.join('|'))
  const divider = header >= 0 ? cells(tableLines[header + 1] ?? '') : []
  const row = header >= 0 ? cells(tableLines[header + 2] ?? '') : []
  if (divider.length !== columns.length || !divider.every((cell) => /^:?-{3,}:?$/.test(cell))
      || row.length !== columns.length || !row.every((cell) => cell.length > 0 && !/^[-:]+$/.test(cell))) {
    problems.push('测试架构缺少有效测试表：层级 | 框架 | 执行方式 | 证据 | 覆盖（至少一行完整测试项）')
  }
  for (const title of ['真实与模拟边界', '失败回流']) {
    if (!section(tests, title, 3).some((line) => line.trim() && !/^\s*#/.test(line))) {
      problems.push('测试架构缺少「### ' + title + '」及说明')
    }
  }
  return { ok: problems.length === 0, problems }
}

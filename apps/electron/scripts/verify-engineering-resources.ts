#!/usr/bin/env bun
/**
 * 工程模板资源完整性校验 CLI（Phase1 Task 4，v0.17.132）。
 *
 * 用途：
 * - 在 pack 产物（out/.../resources/nanju-engineering-templates）上独立运行；
 * - 在部署目标（用户机器解压后的 resources/...）上独立运行；
 * - 在 CI 中作为 gate，失败即阻止宣称部署成功。
 *
 * 用法：
 *   bun run apps/electron/scripts/verify-engineering-resources.ts
 *   bun run apps/electron/scripts/verify-engineering-resources.ts --json
 *   bun run apps/electron/scripts/verify-engineering-resources.ts --templates-dir=PATH
 *   bun run apps/electron/scripts/verify-engineering-resources.ts --strict
 *
 * 退出码：
 *   0 = 校验通过（必需资源全部存在、sha256 匹配、依赖闭环）
 *   1 = 校验失败（存在 blocking 问题）
 *   2 = 参数错误
 *
 * 不修改任何文件；纯只读校验（除可能的 stdout 输出）。
 */

import { resolve as resolvePath } from 'node:path'
import {
  verifyEngineeringResourcesAt,
  type EngineeringResourceVerifyResult,
} from '../src/main/lib/nanju-engineering-resources'

interface ParsedArgs {
  templatesDir?: string
  json: boolean
  strict: boolean
  help: boolean
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { json: false, strict: false, help: false }
  for (const arg of argv.slice(2)) {
    if (arg === '--json') out.json = true
    else if (arg === '--strict') out.strict = true
    else if (arg === '--help' || arg === '-h') out.help = true
    else if (arg.startsWith('--templates-dir=')) {
      const v = arg.slice('--templates-dir='.length)
      if (!v) throw new Error('--templates-dir= 需要非空路径')
      out.templatesDir = resolvePath(v)
    } else if (arg === '--templates-dir') {
      throw new Error('--templates-dir= 必须以等号直接给出路径（Bun parseArgs 限制）')
    } else {
      throw new Error(`未知参数：${arg}（使用 --help 查看用法）`)
    }
  }
  return out
}

function printHelp(): void {
  console.log(`工程模板资源完整性校验（Phase1 Task 4）

用法：
  bun run apps/electron/scripts/verify-engineering-resources.ts [选项]

选项：
  --templates-dir=PATH   指定资源目录父级（含 nanju-engineering-templates/ 子目录）
                         不传时使用内置解析：process.resourcesPath > cwd resources
  --json                 输出 JSON 格式（默认人类可读）
  --strict               把 warning 也视为非零退出（默认仅 blocking 触发失败）
  --help, -h             显示本帮助

退出码：
  0  校验通过
  1  校验失败（blocking 问题）
  2  参数错误`)
}

function formatHuman(r: EngineeringResourceVerifyResult): string {
  const lines: string[] = []
  lines.push('=== 工程模板资源完整性校验 ===')
  lines.push(`资源目录：${r.baseDir}${r.baseDirExists ? '' : '（不存在）'}`)
  lines.push(`Manifest：${r.manifestFound ? `已加载（bundleVersion=${r.bundleVersion}）` : '未找到'}`)
  if (r.manifestFound) {
    lines.push(`  - bundleVersion:    ${r.bundleVersion}`)
    lines.push(`  - requiredCount:    ${r.requiredCount}`)
    lines.push(`  - bundleSha256:     ${r.bundleSha256 ?? '<missing>'}`)
    lines.push(`  - computed sha256:  ${r.computedBundleSha256}`)
    const shaMatch = r.bundleSha256 === r.computedBundleSha256 ? '一致' : '不一致（blocking）'
    lines.push(`  - sha256 校验：      ${shaMatch}`)
  }
  lines.push('')
  if (r.issues.length === 0) {
    lines.push('✓ 校验通过（无问题）')
  } else {
    lines.push(`发现 ${r.issues.length} 项问题：`)
    for (const issue of r.issues) {
      const tag = issue.severity === 'blocking' ? '[blocking]' : '[warning]'
      lines.push(`  ${tag} ${issue.kind}: ${issue.message}`)
    }
    lines.push('')
    const blocking = r.issues.filter((i) => i.severity === 'blocking').length
    const warning = r.issues.filter((i) => i.severity === 'warning').length
    lines.push(`汇总：blocking=${blocking} warning=${warning}  校验结果=${r.ok ? 'PASS' : 'FAIL'}`)
  }
  return lines.join('\n')
}

function main(): void {
  let args: ParsedArgs
  try {
    args = parseArgs(process.argv)
  } catch (e) {
    console.error(`参数错误：${e instanceof Error ? e.message : String(e)}`)
    printHelp()
    process.exit(2)
  }

  if (args.help) {
    printHelp()
    process.exit(0)
  }

  let result: EngineeringResourceVerifyResult
  try {
    result = verifyEngineeringResourcesAt(args.templatesDir)
  } catch (e) {
    console.error(`校验执行异常：${e instanceof Error ? e.message : String(e)}`)
    process.exit(2)
  }

  if (args.json) {
    const out = {
      ok: result.ok,
      baseDir: result.baseDir,
      baseDirExists: result.baseDirExists,
      manifestFound: result.manifestFound,
      bundleVersion: result.bundleVersion,
      bundleSha256: result.bundleSha256,
      computedBundleSha256: result.computedBundleSha256,
      requiredCount: result.requiredCount,
      issueCount: result.issues.length,
      blockingCount: result.issues.filter((i) => i.severity === 'blocking').length,
      warningCount: result.issues.filter((i) => i.severity === 'warning').length,
      issues: result.issues,
    }
    console.log(JSON.stringify(out, null, 2))
  } else {
    console.log(formatHuman(result))
  }

  // 退出码决策：
  // - 有 blocking 问题 → 1
  // - --strict 模式 + 有 warning → 1
  // - 否则 0
  const hasBlocking = result.issues.some((i) => i.severity === 'blocking')
  const hasWarning = result.issues.some((i) => i.severity === 'warning')
  if (hasBlocking) process.exit(1)
  if (args.strict && hasWarning) process.exit(1)
  process.exit(0)
}

main()

/**
 * W15 hooks 顺序回归测试（静态扫描）
 *
 * 背景：UpdateCard / DefaultResultRenderer / WebSearchResultRenderer /
 * GrepResultRenderer / GlobResultRenderer 曾在条件 return 之后调用
 * useEffect/useMemo/useCallback（Rules of Hooks 违规，isError/available
 * 翻转时 hook 数量变化会导致 React 运行时崩溃）。本测试用 TypeScript AST
 * 复刻 hooks-order-scan 的检测规则，锁定这些文件不再出现同类违规。
 */

import { describe, expect, test } from 'bun:test'
import ts from 'typescript'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const HOOK = /^(use[A-Z_]|React\.use[A-Z_])/

let SF: ts.SourceFile

function hookName(node: ts.Node): string | null {
  if (!ts.isCallExpression(node)) return null
  const e = node.expression
  if (ts.isPropertyAccessExpression(e)) {
    const obj = e.expression.getText()
    return obj === 'React' ? `React.${e.name.text}` : null
  }
  return ts.isIdentifier(e) ? e.text : null
}

function isHookCall(node: ts.Node): boolean {
  const n = hookName(node)
  return n !== null && HOOK.test(n!)
}

/** 子树中是否存在 return（不进入嵌套函数） */
function hasReturn(root: ts.Node): boolean {
  let found = false
  const visit = (n: ts.Node) => {
    if (found) return
    if (ts.isFunctionLike(n) && n !== root) return
    if (ts.isReturnStatement(n)) {
      found = true
      return
    }
    n.forEachChild(visit)
  }
  visit(root)
  return found
}

/** 子树中的语句级 hook 调用（不进入嵌套函数） */
function hookCallsIn(root: ts.Node): ts.CallExpression[] {
  const out: ts.CallExpression[] = []
  const visit = (n: ts.Node) => {
    if (ts.isFunctionLike(n) && n !== root) return
    if (isHookCall(n)) out.push(n as ts.CallExpression)
    n.forEachChild(visit)
  }
  visit(root)
  return out
}

/** 语句中「条件上下文」的 hook：if 分支块 / 三元 / && || ?? */
function conditionalHooks(stmt: ts.Statement): ts.CallExpression[] {
  const out: ts.CallExpression[] = []
  const scanExpr = (n: ts.Node) => {
    if (ts.isFunctionLike(n)) return
    if (ts.isConditionalExpression(n)) {
      for (const h of hookCallsIn(n.whenTrue).concat(hookCallsIn(n.whenFalse))) out.push(h)
      n.condition.forEachChild(scanExpr)
      return
    }
    if (ts.isBinaryExpression(n) && ['&&', '||', '??'].includes(n.operatorToken.getText().trim())) {
      if (hookName(n.left)) {
        // hook 作为条件本身不算
      } else {
        for (const h of hookCallsIn(n.right)) out.push(h)
      }
      n.left.forEachChild(scanExpr)
      return
    }
    n.forEachChild(scanExpr)
  }
  if (ts.isIfStatement(stmt)) {
    if (ts.isBlock(stmt.thenStatement)) for (const s of stmt.thenStatement.statements) out.push(...hookCallsIn(s))
    else out.push(...hookCallsIn(stmt.thenStatement))
    const el = stmt.elseStatement
    if (el && !ts.isIfStatement(el)) {
      if (ts.isBlock(el)) for (const s of el.statements) out.push(...hookCallsIn(s))
      else out.push(...hookCallsIn(el))
    }
    if (el && ts.isIfStatement(el)) out.push(...conditionalHooks(el))
    return out
  }
  if (ts.isTryStatement(stmt)) {
    for (const s of stmt.tryBlock.statements) out.push(...hookCallsIn(s))
    const catchClause = stmt.catchClause
    if (catchClause) for (const s of catchClause.block.statements) out.push(...hookCallsIn(s))
    return out
  }
  stmt.forEachChild(scanExpr)
  return out
}

/** 对单个函数体执行 after-return / in-conditional 检测 */
function scanFn(fn: ts.FunctionLikeDeclaration): Array<{ kind: string; line: number; name: string; detail: string }> {
  const out: Array<{ kind: string; line: number; name: string; detail: string }> = []
  const body = fn.body
  if (!body || !ts.isBlock(body)) return out
  const fnName = fn.name && (ts.isIdentifier(fn.name) || ts.isStringLiteral(fn.name)) ? fn.name.text : '(anonymous)'
  const line = (n: ts.Node) => SF.getLineAndCharacterOfPosition(n.getStart()).line + 1

  let returned = false
  for (const stmt of body.statements) {
    if (returned) {
      for (const h of hookCallsIn(stmt)) out.push({ kind: 'after-return', line: line(h), name: fnName, detail: h.getText().slice(0, 60) })
    }
    for (const h of conditionalHooks(stmt)) out.push({ kind: 'in-conditional', line: line(h), name: fnName, detail: h.getText().slice(0, 60) })
    if (ts.isReturnStatement(stmt)) returned = true
    else if (ts.isIfStatement(stmt) || ts.isSwitchStatement(stmt) || ts.isTryStatement(stmt) || ts.isBlock(stmt)) {
      if (hasReturn(stmt)) returned = true
    }
  }
  return out
}

/** 扫描一个源文件，返回全部违规 */
function scanFile(path: string, label: string): string[] {
  SF = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
  const findings: string[] = []
  const visit = (n: ts.Node) => {
    if (ts.isFunctionDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isMethodDeclaration(n)) {
      for (const hit of scanFn(n as ts.FunctionLikeDeclaration)) {
        findings.push(`${label}:${hit.line} ${hit.kind} in ${hit.name} → ${hit.detail}`)
      }
    }
    n.forEachChild(visit)
  }
  SF.forEachChild(visit)
  return findings
}

/** 收集目录下全部非测试 ts/tsx 文件 */
function collect(dir: string): string[] {
  const files: string[] = []
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (ts.sys.directoryExists(p)) files.push(...collect(p))
    else if (/\.(tsx|ts)$/.test(e) && !/\.test\./.test(e)) files.push(p)
  }
  return files
}

const COMPONENTS_DIR = import.meta.dir

describe('W15 hooks 顺序回归（静态扫描）', () => {
  test('given W15 修复后的 5 个渲染器 when 扫描 after-return/in-conditional then 0 findings', () => {
    const rendererFiles = collect(join(COMPONENTS_DIR, 'agent', 'tool-result-renderers')).sort()
    // 覆盖 default-result / web-search-result / grep-result / glob-result 及同目录其余渲染器
    expect(rendererFiles.length).toBeGreaterThanOrEqual(10)

    const findings = rendererFiles.flatMap((f) => scanFile(f, f.replace(COMPONENTS_DIR + '/', '')))
    expect(findings).toEqual([])
  })

  test('given W15 修复后的 AboutSettings.tsx when 扫描 UpdateCard 等组件 then 0 findings', () => {
    const findings = scanFile(join(COMPONENTS_DIR, 'settings', 'AboutSettings.tsx'), 'settings/AboutSettings.tsx')
    expect(findings).toEqual([])
  })

  test('given 一个 after-return 违规样例 when 扫描 then 能够检出（自证检测器有效）', () => {
    const sample = `
      function Violating(): React.ReactElement | null {
        const ok = someCondition
        if (!ok) return null
        React.useMemo(() => 1, [])
        return <div />
      }
    `
    const samplePath = '/virtual/sample.tsx'
    SF = ts.createSourceFile(samplePath, sample, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
    const hits: string[] = []
    const visit = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n)) {
        for (const hit of scanFn(n as ts.FunctionLikeDeclaration)) hits.push(hit.kind)
      }
      n.forEachChild(visit)
    }
    SF.forEachChild(visit)
    expect(hits).toContain('after-return')
  })
})

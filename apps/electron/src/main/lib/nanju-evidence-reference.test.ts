import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { hasEvidenceDate, hasEvidenceReference } from './nanju-evidence-reference'
let root = ''
let project = ''
let external = ''
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'evidence-ref-'))
  project = join(root, 'project')
  external = join(root, 'explicit-evidence')
  mkdirSync(project)
  mkdirSync(external)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('file证据只验引用在场及边界', () => {
  test('URL编码/尖括号空格/中文标点；file只能用于实证且必须普通文件', () => {
    const file = join(project, '本机 证据.md')
    writeFileSync(file, 'measured')
    const url = pathToFileURL(file).href
    expect(hasEvidenceReference(`${url}，2026-09-20`, '实证', [project])).toBe(true)
    expect(hasEvidenceReference(`<file://${file}>`, '实证', [project])).toBe(true)
    expect(hasEvidenceReference(url, '文证', [project])).toBe(false)
    expect(hasEvidenceReference(pathToFileURL(project).href, '实证', [root])).toBe(false)
    expect(hasEvidenceReference(`${url}-missing`, '实证', [project])).toBe(false)
    expect(hasEvidenceReference('file://remotehost/etc/passwd', '实证', [project])).toBe(false)
  })
  test('未授权外部路径与项目内符号链接逃逸拒绝，显式附加目录可引用', () => {
    const file = join(external, 'report.txt')
    writeFileSync(file, 'external')
    symlinkSync(file, join(project, 'escape'))
    expect(hasEvidenceReference(pathToFileURL(file).href, '实证', [project])).toBe(false)
    expect(hasEvidenceReference(pathToFileURL(join(project, 'escape')).href, '实证', [project])).toBe(false)
    expect(hasEvidenceReference(pathToFileURL(file).href, '实证', [project, external])).toBe(true)
  })
  test('文证可用有效HTTP(S)，日期必须真实日期而非格式近似', () => {
    expect(hasEvidenceReference('https://example.com/doc。', '文证', [])).toBe(true)
    expect(hasEvidenceReference('https://', '文证', [])).toBe(false)
    expect(hasEvidenceReference('https://user:secret@example.com', '文证', [])).toBe(false)
    expect(hasEvidenceDate('检索日期2026-09-20')).toBe(true)
    expect(hasEvidenceDate('2026-02-30')).toBe(false)
    expect(hasEvidenceDate('未填写')).toBe(false)
  })
})

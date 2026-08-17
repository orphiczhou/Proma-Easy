import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import { join } from 'node:path'

import { validatePreviewFile } from './agent-preview-notify'

let tempDir: string

beforeAll(() => {
  tempDir = mkdtempSync(join(os.tmpdir(), 'agent-preview-notify-'))
  writeFileSync(join(tempDir, 'PRD.md'), '# PRD')
  writeFileSync(join(tempDir, 'proto.html'), '<html></html>')
  writeFileSync(join(tempDir, 'data.json'), '{}')
  writeFileSync(join(tempDir, 'app.exe'), 'binary')
  mkdirSync(join(tempDir, 'docs'))
})

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('validatePreviewFile（open_preview 工具的文件校验）', () => {
  test('绝对路径 + 白名单扩展名 → 通过', () => {
    const p = join(tempDir, 'PRD.md')
    const r = validatePreviewFile(p)
    expect(r.ok).toBe(true)
    expect(r.filePath).toBe(p)
  })

  test('相对路径相对 baseDir 解析 → 通过', () => {
    const r = validatePreviewFile('proto.html', tempDir)
    expect(r.ok).toBe(true)
    expect(r.filePath).toBe(join(tempDir, 'proto.html'))
  })

  test('文件不存在 → 拒绝', () => {
    const r = validatePreviewFile(join(tempDir, 'no-such.md'))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('不存在')
  })

  test('目录而非文件 → 拒绝', () => {
    const r = validatePreviewFile(join(tempDir, 'docs'))
    expect(r.ok).toBe(false)
  })

  test('白名单外扩展名 → 拒绝并列出支持类型', () => {
    const r = validatePreviewFile(join(tempDir, 'app.exe'))
    expect(r.ok).toBe(false)
    expect(r.error).toContain('.exe')
  })
})

import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 南大项目元数据（nanju-project）单测——L2-4（2026-09-18）新增字段标记覆盖：
 * createNanjuProject 对新项目写 archEvidenceGate=true（架构凭证门禁存量兼容标记），
 * 存量项目（旧版本创建，无该字段）读回 undefined（router-gate 门禁据此豁免）。
 * 依赖 config-paths.getWorkspaceFilesDir——按仓库既有模式先 mock.module 指向 tmpdir。
 */
let fixtureRoot = ''
const actualConfigPaths = await import('./config-paths')
mock.module('./config-paths', () => ({
  ...actualConfigPaths,
  getWorkspaceFilesDir: () => fixtureRoot,
  getAgentWorkspacePath: () => fixtureRoot,
}))

const { createNanjuProject, readProjectInfo, listNanjuProjects } = await import('./nanju-project')

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'nanju-project-l24-'))
  fixtureRoot = root
  return root
}

afterEach(() => {
  if (fixtureRoot) {
    try { rmSync(fixtureRoot, { recursive: true, force: true }) } catch { /* 并行残留容忍 */ }
    fixtureRoot = ''
  }
})

describe('L2-4：archEvidenceGate 新项目标记（凭证门禁存量兼容）', () => {
  test('Given 新项目 When createNanjuProject Then _project-info.json 写 archEvidenceGate=true（门禁生效面）', () => {
    makeFixture()
    const project = createNanjuProject({ name: '凭证门禁新项目', mode: 'quick', workspaceSlug: 'ws' })
    const infoPath = join(fixtureRoot, `project-${project.projectId}`, '_project-info.json')
    expect(existsSync(infoPath)).toBe(true)
    expect((JSON.parse(readFileSync(infoPath, 'utf-8')) as { archEvidenceGate?: boolean }).archEvidenceGate).toBe(true)
    // readProjectInfo 读取面同值
    expect(readProjectInfo('ws', project.projectId)?.archEvidenceGate).toBe(true)
    // 项目注册表本身可读回（元数据完整性）
    expect(listNanjuProjects('ws')).toHaveLength(1)
  })

  test('Given 存量项目（旧版本创建，无该字段）When readProjectInfo Then undefined（门禁豁免面）', () => {
    makeFixture()
    // 模拟旧版本创建的 _project-info.json：无 archEvidenceGate 字段
    mkdirSync(join(fixtureRoot, 'project-legacy'), { recursive: true })
    writeFileSync(join(fixtureRoot, 'project-legacy', '_project-info.json'), JSON.stringify({
      projectId: 'legacy',
      name: '旧项目',
      mode: 'iterative',
      createdAt: '2026-09-01T00:00:00.000Z',
      workspaceSlug: 'ws',
      projectDir: 'project-legacy',
      docDirs: ['01_PRD'],
    }))
    const info = readProjectInfo('ws', 'legacy')
    expect(info).not.toBeNull()
    expect((info as { archEvidenceGate?: boolean }).archEvidenceGate).toBeUndefined()
  })
})

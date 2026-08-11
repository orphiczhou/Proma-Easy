
/**
 * M8 端到端集成测试 — 南大项目系统（数据层）
 */
import { createNanjuProject, listNanjuProjects, getNanjuProject, updateNanjuProject, deleteNanjuProject } from './src/main/lib/nanju-project'
import { recordTelemetry, readTelemetry } from './src/main/lib/nanju-telemetry'
import * as path from 'path'
import * as fs from 'fs'

const WORKSPACE_SLUG = 'default'

interface TestResult { name: string; passed: boolean; detail: string }
const results: TestResult[] = []

function test(name: string, fn: () => void) {
  try {
    fn()
    results.push({ name, passed: true, detail: 'OK' })
    console.log(`  ✅ ${name}`)
  } catch (e: any) {
    results.push({ name, passed: false, detail: e?.message || String(e) })
    console.log(`  ❌ ${name}: ${e?.message || e}`)
  }
}

function main() {
  console.log('\n=== M8 端到端集成测试 ===')
  console.log(`工作区Slug: ${WORKSPACE_SLUG}\n`)

  let projectId = ''

  // ===== 1. 项目 CRUD =====
  console.log('--- 1. 项目 CRUD ---')
  test('创建南大项目 (quick)', () => {
    const proj = createNanjuProject({
      name: 'm8-test-project',
      mode: 'quick',
      workspaceSlug: WORKSPACE_SLUG,
    })
    projectId = proj.projectId
    if (!projectId) throw new Error('项目ID为空')
    if (proj.mode !== 'quick') throw new Error('模式不匹配')
    console.log(`      项目ID: ${projectId}`)
  })

  test('列出南大项目', () => {
    const list = listNanjuProjects(WORKSPACE_SLUG)
    if (!list.some(p => p.name === 'm8-test-project')) throw new Error('未找到测试项目')
    console.log(`      共 ${list.length} 个项目`)
  })

  test('获取单个项目', () => {
    const proj = getNanjuProject(WORKSPACE_SLUG, projectId)
    if (!proj || proj.name !== 'm8-test-project') throw new Error('项目获取失败')
  })

  test('更新项目状态', () => {
    updateNanjuProject(WORKSPACE_SLUG, projectId, { status: 'in-progress' })
    const proj = getNanjuProject(WORKSPACE_SLUG, projectId)
    if (proj.status !== 'in-progress') throw new Error('状态未更新')
  })

  // ===== 2. 遥测 =====
  console.log('\n--- 2. 遥测 ---')
  test('记录遥测事件', () => {
    recordTelemetry(WORKSPACE_SLUG, 'project.created', { message: 'M8 test' }, projectId)
    recordTelemetry(WORKSPACE_SLUG, 'dialog.submitted', { role: 'guide' }, projectId)
  })

  test('读取遥测事件', () => {
    const events = readTelemetry(WORKSPACE_SLUG)
    const projEvents = events.filter(e => e.projectId === projectId)
    if (projEvents.length < 2) throw new Error(`事件数 ${projEvents.length}, 期望 >= 2`)
    console.log(`      共 ${projEvents.length} 条项目事件`)
  })

  // ===== 3. 角色配置文件 =====
  console.log('\n--- 3. 角色配置文件 ---')
  test('读取角色配置 JSON', () => {
    const rolesDir = path.join(__dirname, 'resources', 'nanju-roles')
    if (!fs.existsSync(rolesDir)) throw new Error(`角色目录不存在`)
    const roleFiles = fs.readdirSync(rolesDir).filter(f => f.endsWith('.json') && f !== 'roles.json')
    if (roleFiles.length < 4) throw new Error(`角色文件数 ${roleFiles.length}, 期望 >= 4`)
    for (const f of roleFiles) {
      const config = JSON.parse(fs.readFileSync(path.join(rolesDir, f), 'utf-8'))
      if (!config.role || !config.system_prompt) throw new Error(`${f} 缺少必需字段`)
    }
    console.log(`      ${roleFiles.length} 个角色: ${roleFiles.map(f => f.replace('.json', '')).join(', ')}`)
  })

  test('读取角色序列配置 (roles.json)', () => {
    const seqPath = path.join(__dirname, 'resources', 'nanju-roles', 'roles.json')
    const seq = JSON.parse(fs.readFileSync(seqPath, 'utf-8'))
    if (!seq.quick_mode_sequence || !seq.iterative_mode_sequence) throw new Error('缺少模式序列')
    console.log(`      quick: ${(seq.quick_mode_sequence as string[]).join(' → ')}`)
    console.log(`      iterative: ${(seq.iterative_mode_sequence as string[]).join(' → ')}`)
  })

  // ===== 4. 清理 =====
  console.log('\n--- 4. 清理 ---')
  test('删除测试项目', () => {
    deleteNanjuProject(WORKSPACE_SLUG, projectId)
    const list = listNanjuProjects(WORKSPACE_SLUG)
    if (list.some(p => p.projectId === projectId)) throw new Error('项目未删除')
  })

  // 汇总
  console.log('\n=== 测试汇总 ===')
  const passed = results.filter(r => r.passed).length
  const failed = results.filter(r => !r.passed).length
  console.log(`总计: ${results.length} | 通过: ${passed} | 失败: ${failed}`)
  process.exit(failed > 0 ? 1 : 0)
}

main()

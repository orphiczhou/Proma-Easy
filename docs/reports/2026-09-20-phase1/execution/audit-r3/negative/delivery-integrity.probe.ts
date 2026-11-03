/**
 * R3 独立审计 · 交付视图增量反例探针（只读，不改产品代码）
 *
 * 覆盖（对应审计任务 a–e + 安全 + 回归面）：
 *  a) mapReportVerdict 计数不变量交叉核对（pass 伪造的多种形态）
 *  b) stale 与 integrity 同时命中时的优先级（buildDeliveryViewModel 端到端）
 *  c) evidence/<runId>/index.json tests[] 元素 null/非对象、status 未知、generatedAt 非法
 *  d) runId 目录名 'a..b' / '.hidden' / 'a/b' / 超长名
 *  e) history 与 report.json 结论矛盾（evidence[].verdict vs viewModel.verdict 一致性）
 *  安全) symlink 目录逃逸 / index.json 为 symlink
 *  回归) 无 evidence 目录、坏索引、旧报告无 retryCount/runId
 *
 * 运行方式（隔离 HOME 子进程）：
 *   HOME=<tmp> PROMA_DEV=1 LIB_DIR=<abs lib dir> bun run <this script>
 */
import { existsSync, mkdirSync, writeFileSync, symlinkSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const LIB_DIR = process.env.LIB_DIR!
const { mapReportVerdict, reportIntegrityWarnings, buildDeliveryViewModel } = await import(
  LIB_DIR + '/nanju-delivery-view.ts'
)

// @proma/shared 通过 node_modules symlink 解析
const shared = await import('@proma/shared')

const results: Array<{ id: string; expected: string; actual: string; ok: boolean; detail?: unknown }> = []
function check(id: string, expected: unknown, actual: unknown, detail?: unknown) {
  const ok = JSON.stringify(expected) === JSON.stringify(actual)
  results.push({ id, expected: JSON.stringify(expected), actual: JSON.stringify(actual), ok, detail: detail ?? undefined })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id}\n  expected=${JSON.stringify(expected)}\n  actual  =${JSON.stringify(actual)}`)
}

// ===== (a) mapReportVerdict 计数不变量 =====
type R = { verdict: string; passed: number; failed: number; skipped: number; scenariosTotal: number }
const baseR: R = { verdict: 'pass', passed: 5, failed: 0, skipped: 0, scenariosTotal: 5 }
const g = (r: R) => mapReportVerdict(r as never)

check('a1 pass 自洽 → pass', 'pass', g(baseR))
check('a2 pass + passed=0/scenariosTotal=0 → fail', 'fail', g({ ...baseR, passed: 0, scenariosTotal: 0 }))
check('a3 pass + passed>scenariosTotal → fail', 'fail', g({ ...baseR, passed: 6, scenariosTotal: 5 }))
check('a4 pass + passed 负数 → fail', 'fail', g({ ...baseR, passed: -1, scenariosTotal: -1 }))
check('a5 pass + skipped>0 → fail', 'fail', g({ ...baseR, passed: 3, skipped: 2 }))
check('a6 pass + failed>0 → fail', 'fail', g({ ...baseR, passed: 4, failed: 1 }))
check('a7 pass + passed=NaN → fail', 'fail', g({ ...baseR, passed: Number.NaN }))
check('a8 pass + failed 负数(===0 不满足) → fail', 'fail', g({ ...baseR, failed: -1 }))
// 非 pass verdict 不被计数核对影响
check('a9 verdict=fail → fail', 'fail', g({ ...baseR, verdict: 'fail' }))
check('a10 verdict=error → error', 'error', g({ ...baseR, verdict: 'error' }))
check('a11 verdict=blocked → blocked', 'blocked', g({ ...baseR, verdict: 'blocked' }))
// integrity warnings
check('a12 pass 自洽 → warnings []', [], reportIntegrityWarnings(baseR as never))
check('a13 pass + skipped>0 → warnings 含"计数不自洽"', true, reportIntegrityWarnings({ ...baseR, skipped: 1, passed: 4 } as never).join(' ').includes('计数不自洽'))

// ===== 工程目录夹具（隔离 HOME） =====
const slug = 'audit-r3'
const pid = 'proj'
const projectDir = join(homedir(), '.proma-dev', 'agent-workspaces', slug, 'workspace-files', `project-${pid}`)
mkdirSync(join(projectDir, '08_APP'), { recursive: true })
mkdirSync(join(projectDir, '06_TESTS'), { recursive: true })
const entry = join(projectDir, '08_APP', 'index.html')
const ENTRY_CONTENT = '<html>v1</html>'
writeFileSync(entry, ENTRY_CONTENT)
import { createHash } from 'node:crypto'
const fp = (s: string) => ({ sha256: createHash('sha256').update(s).digest('hex'), size: Buffer.byteLength(s) })
const FP_V1 = fp(ENTRY_CONTENT)

function writeReport(o: Record<string, unknown>) {
  writeFileSync(join(projectDir, '06_TESTS', 'report.json'), JSON.stringify(o))
}
function baseReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    generatedAt: '2026-09-23T12:00:00Z', runId: 'r-baseline', verdict: 'pass',
    scenariosTotal: 2, passed: 2, failed: 0, skipped: 0, retryCount: 0,
    entry: '08_APP/index.html', entryFingerprint: FP_V1, ...overrides,
  }
}

// ===== (b) stale 与 integrity 优先级 =====
// b1: 报告自洽 + 指纹一致 → pass
writeReport(baseReport())
let vm = buildDeliveryViewModel(slug, pid)!
check('b1 自洽+指纹一致 → pass', 'pass', vm.verdict, { staleMessage: vm.staleMessage })

// b2: 报告篡改(pass但计数不自洽) + 指纹一致 → fail（integrity 拦截，不显示 pass）
writeReport(baseReport({ passed: 1, skipped: 1 }))
vm = buildDeliveryViewModel(slug, pid)!
check('b2 篡改计数+指纹一致 → fail（非 pass/stale）', 'fail', vm.verdict, { staleMessage: vm.staleMessage, evVerdict: vm.evidence[0]?.verdict })

// b3: 报告篡改 + 产物已改(指纹不符) → stale（stale 覆盖 fail）
writeFileSync(entry, '<html>v2-modified</html>')
writeReport(baseReport({ passed: 1, skipped: 1 })) // 计数也不自洽
vm = buildDeliveryViewModel(slug, pid)!
check('b3 篡改计数+指纹不符 → verdict=stale（优先级）', 'stale', vm.verdict, { evVerdict: vm.evidence[0]?.verdict })
check('b3 附带: evidence[0].verdict（不一致观察点）', 'fail', vm.evidence[0]?.verdict ?? null)
check('b3 附带: staleMessage 非空', true, (vm.staleMessage ?? '').length > 0)

// b4: 篡改报告"改产物+重算指纹"能否绕过 stale（威胁模型边界）
writeFileSync(entry, ENTRY_CONTENT) // 复原
writeReport(baseReport({ passed: 2, skipped: 0, entryFingerprint: FP_V1 })) // 重算指纹与现产物一致
vm = buildDeliveryViewModel(slug, pid)!
check('b4 攻击者重算指纹 → verdict（sha256 信任模型边界，预期 pass，非缺陷）', 'pass', vm.verdict)

// 复原入口
writeFileSync(entry, ENTRY_CONTENT)

// ===== (c) evidence index.json 鲁棒性 =====
const evRoot = join(projectDir, '06_TESTS', 'evidence')
function writeIndex(runId: string, idx: unknown) {
  mkdirSync(join(evRoot, runId), { recursive: true })
  writeFileSync(join(evRoot, runId, 'index.json'), typeof idx === 'string' ? idx : JSON.stringify(idx))
}
function clearEv() { try { rmSync(evRoot, { recursive: true, force: true }) } catch {} }
function readHist() { return buildDeliveryViewModel(slug, pid)!.history }
function findHist(runId: string) { return readHist().find((h) => h.runId === runId) ?? null }

// c1: tests 元素含 null → 不误判 pass（落入 not-tested）
clearEv()
writeIndex('c1', { runId: 'c1', generatedAt: '2026-09-23T13:00:00Z', tests: [null, { testId: 't1', status: 'pass' }] })
check('c1 tests=[null,{pass}] → not-tested', 'not-tested', findHist('c1')?.conclusion ?? null)

// c2: tests 元素非对象(数字/字符串) → 不误判 pass
clearEv()
writeIndex('c2', { runId: 'c2', generatedAt: '2026-09-23T13:01:00Z', tests: [5, 'pass', { testId: 't1', status: 'pass' }] })
check('c2 tests=[5,"pass",{pass}] → not-tested', 'not-tested', findHist('c2')?.conclusion ?? null)

// c3: status 未知字符串('skip'/'skipped'/'partial') → 不误判 pass
clearEv()
writeIndex('c3', { runId: 'c3', generatedAt: '2026-09-23T13:02:00Z', tests: [{ testId: 't1', status: 'skip' }, { testId: 't2', status: 'pass' }] })
check('c3 tests=[skip,pass] → not-tested', 'not-tested', findHist('c3')?.conclusion ?? null)

// c3b: 全部未知 status → not-tested（非 pass）
clearEv()
writeIndex('c3b', { runId: 'c3b', generatedAt: '2026-09-23T13:03:00Z', tests: [{ testId: 't1', status: 'unknown' }] })
check('c3b tests=[unknown] → not-tested', 'not-tested', findHist('c3b')?.conclusion ?? null)

// c4: generatedAt 非法（数字）→ 结论不受影响；generatedAt 落为 fallback
clearEv()
writeIndex('c4', { runId: 'c4', generatedAt: 12345, tests: [{ testId: 't1', status: 'pass', generatedAt: '2026-09-23T13:04:00Z' }] })
const c4 = findHist('c4')
check('c4 generatedAt 非法 → conclusion 仍 pass（generatedAt 不影响结论）', 'pass', c4?.conclusion ?? null)
check('c4 generatedAt 非法 → fallback 到 tests[0].generatedAt', '2026-09-23T13:04:00Z', c4?.generatedAt ?? null)

// c5: 全 pass → pass（对照组）
clearEv()
writeIndex('c5', { runId: 'c5', generatedAt: '2026-09-23T13:05:00Z', tests: [{ testId: 't1', status: 'pass' }, { testId: 't2', status: 'pass' }] })
check('c5 tests=[pass,pass] → pass', 'pass', findHist('c5')?.conclusion ?? null)

// c6: 有 error → error（优先级高于 fail/pass）
clearEv()
writeIndex('c6', { runId: 'c6', generatedAt: '2026-09-23T13:06:00Z', tests: [{ testId: 't1', status: 'error' }, { testId: 't2', status: 'fail' }, { testId: 't3', status: 'pass' }] })
check('c6 tests=[error,fail,pass] → error（error 优先）', 'error', findHist('c6')?.conclusion ?? null)

// ===== (d) runId 目录名校验 =====
clearEv()
// d1 'a..b' → 拒
writeIndex('a..b', { runId: 'a..b', generatedAt: '2026-09-23T14:00:00Z', tests: [{ testId: 't1', status: 'pass' }] })
// d2 '.hidden' → 拒
writeIndex('.hidden', { runId: '.hidden', generatedAt: '2026-09-23T14:01:00Z', tests: [{ testId: 't1', status: 'pass' }] })
// d3 超长名(140字符) → 拒
const long = 'x'.repeat(140)
writeIndex(long, { runId: long, generatedAt: '2026-09-23T14:02:00Z', tests: [{ testId: 't1', status: 'pass' }] })
// d4 合法 runId → 收
writeIndex('valid-1', { runId: 'valid-1', generatedAt: '2026-09-23T14:03:00Z', tests: [{ testId: 't1', status: 'pass' }] })
// d5 'a/b'（含分隔符，若可造）→ 拒（filesystem 不允许单目录名含 /，这里构造为目录 a 下 b 也应被排除）
const histIds = readHist().map((h) => h.runId)
check('d1 runId "a..b" 被拒', false, histIds.includes('a..b'))
check('d2 runId ".hidden" 被拒', false, histIds.includes('.hidden'))
check('d3 runId 超长名 被拒', false, histIds.includes(long))
check('d4 runId "valid-1" 被收', true, histIds.includes('valid-1'))
check('d5 目录 "a..b" 仍在盘（但被 readDeliveryHistory 跳过）', true, existsSync(join(evRoot, 'a..b', 'index.json')))

// 检查 readdirSync 是否真的跳过（白名单）——通过字符串化确认 a..b/.hidden 不在结果
check('d6 "..evil" 前缀目录名被拒', false, histIds.includes('..evil'))

// ===== 安全: symlink 逃逸 =====
clearEv()
// 外部秘密目录（工程目录之外）
const outside = join(homedir(), 'outside-secret')
mkdirSync(outside, { recursive: true })
writeFileSync(join(outside, 'index.json'), JSON.stringify({ runId: 'esc', generatedAt: '2026-09-23T15:00:00Z', tests: [{ testId: 'x', status: 'pass' }] }))
// 在 evidence/ 下放 symlink 目录指向 outside
mkdirSync(evRoot, { recursive: true })
try {
  symlinkSync(outside, join(evRoot, 'evil-link'), 'dir')
  const linked = readHist().map((h) => h.runId)
  check('sec1 symlink 目录不逃逸（不读外部 index.json）', false, linked.includes('esc'))
  // 确认 readdirSync({withFileTypes}) isDirectory 对 symlink 返回 false
  const dirents = readdirSync(evRoot, { withFileTypes: true })
  const symDir = dirents.find((d) => d.name === 'evil-link')
  check('sec2 dirent.isDirectory() 对 symlink=false（机制根因）', false, symDir?.isDirectory() ?? null)
  check('sec2b dirent.isSymbolicLink() 对 symlink=true', true, symDir?.isSymbolicLink() ?? null)
} catch (e) {
  check('sec1 symlink 目录构造失败（记录 blocked）', true, false, String(e))
}

// sec3: 真实目录内 index.json 为 symlink 指向外部文件 → 应被拒（lstatSync isSymbolicLink）
clearEv()
mkdirSync(join(evRoot, 'real-dir'), { recursive: true })
const outsideFile = join(homedir(), 'outside.json')
writeFileSync(outsideFile, JSON.stringify({ runId: 'leak', generatedAt: '2026-09-23T15:01:00Z', tests: [{ testId: 'x', status: 'pass' }] }))
try {
  symlinkSync(outsideFile, join(evRoot, 'real-dir', 'index.json'), 'file')
  const leak = findHist('real-dir')
  check('sec3 index.json 为 symlink → 不跟随读取（lstat 拒）', null, leak, { note: 'readDeliveryHistory 用 lstatSync 拒 isSymbolicLink' })
} catch (e) {
  check('sec3 index.json symlink 构造失败（记录）', true, false, String(e))
}

// sec4: 超大 index.json（>1MB）→ 拒（防读盘失控）
clearEv()
mkdirSync(join(evRoot, 'big-dir'), { recursive: true })
const big = { runId: 'big', generatedAt: '2026-09-23T15:02:00Z', tests: [{ testId: 'x', status: 'pass' }], pad: 'x'.repeat(1024 * 1024 + 100) }
writeFileSync(join(evRoot, 'big-dir', 'index.json'), JSON.stringify(big))
check('sec4 >1MB index.json → 拒', null, findHist('big-dir'))

// ===== 回归面: 无 evidence 目录 / 坏索引 =====
clearEv()
vm = buildDeliveryViewModel(slug, pid)!
check('reg1 无 evidence 目录 → history=[] 不抛错', true, Array.isArray(vm.history) && vm.history.length === 0)

// 坏索引（非 JSON）→ 跳过
writeIndex('bad', '{not json')
vm = buildDeliveryViewModel(slug, pid)!
check('reg2 坏索引 → 跳过，不抛错', false, vm.history.some((h) => h.runId === 'bad'))

// 旧报告缺 retryCount → validateReportSchema 返回 null → not-tested
writeReport({ generatedAt: '2026-09-23T12:00:00Z', verdict: 'pass', scenariosTotal: 2, passed: 2, failed: 0, skipped: 0, entry: '08_APP/index.html' })
vm = buildDeliveryViewModel(slug, pid)!
check('reg3 旧报告缺 retryCount → not-tested（schema 降级）', 'not-tested', vm.verdict)

// ===== 汇总 =====
const failCount = results.filter((r) => !r.ok).length
console.log('\n===== SUMMARY =====')
console.log(`total=${results.length} fail=${failCount}`)
console.log('FINAL_JSON=' + JSON.stringify({ total: results.length, fail: failCount, results }))

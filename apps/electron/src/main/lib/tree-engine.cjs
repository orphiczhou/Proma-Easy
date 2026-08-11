#!/usr/bin/env node
/**
 * tree-state.js — 树形会话执行体系 状态访问脚本 (补丁 4)
 *
 * 设计依据: tree-commander-design.md 附录 A
 *
 * 部署位置: <workspace>/.context/trees/tree-state.js
 * 调用方式: node tree-state.js <command> [args]
 *
 * 子命令分组:
 *   Query    : leaf get | leaf list-active | leaf list-all | tree dump
 *              drift list | heartbeat tail | event list
 *   Add      : leaf add | milestone add
 *   Update   : leaf set-status | leaf set-context | leaf set-last-event
 *              leaf autonomy-override | milestone set-result
 *   Append   : event append | drift append | heartbeat append | segment append
 *   Maintain : init | backup | restore | validate
 *
 * 示例:
 *   node tree-state.js init nanju --root-brief '{"parent_intent":"..."}' --root-dod '{"deliverables":[]}'
 *   node tree-state.js leaf add nanju --json '{"leaf_id":"nanju-root","session_id":"uuid","parent":null,"path":"","role":"root","model":"claude-sonnet-4-6","channel":"anthropic"}'
 *   node tree-state.js leaf get nanju nanju-root
 *   node tree-state.js leaf list-active nanju
 *   node tree-state.js leaf set-status nanju nanju-A-eval done
 *   node tree-state.js leaf set-context nanju nanju-A-eval 47
 *   node tree-state.js leaf set-last-event nanju nanju-A-eval plan
 *   node tree-state.js leaf autonomy-override nanju nanju-A-eval --json '{"added_must_ask":["x"],"reason":"..."}'
 *   node tree-state.js milestone add nanju nanju-A-eval --json '{"id":"M1","desc":"...","expect_outputs":["flow.mmd"]}'
 *   node tree-state.js milestone set-result nanju nanju-A-eval M1 --audit-pass true --note-path docs/x.note.md
 *   node tree-state.js event append nanju nanju-A-eval --type done --json '{"deliverables":["docs/x.md"]}'
 *   node tree-state.js drift append nanju nanju-A-eval --kind production --severity high --action prune --fork-to nanju-A1b-engine
 *   node tree-state.js heartbeat append nanju --json '{"verdicts":[]}'
 *   node tree-state.js segment append nanju nanju-A-eval new-session-uuid
 *   node tree-state.js tree dump nanju
 *   node tree-state.js drift list nanju --leaf nanju-A-eval
 *   node tree-state.js heartbeat tail nanju -n 20
 *   node tree-state.js event list nanju --type plan
 *   node tree-state.js backup nanju --label before-prune
 *   node tree-state.js restore nanju tree-state.backup.1234567890.before-prune.json
 *   node tree-state.js validate nanju
 */

'use strict';

const fs = require('fs');
const path = require('path');
const process = require('process');

// ============================================================
// 常量与枚举
// ============================================================

const LOCK_TIMEOUT_MS = 10000;
const LOCK_POLL_MS = 100;
const BACKUP_EVERY_N_WRITES = 10;
const BACKUP_KEEP_RECENT = 10;

// 命名正则 (§6.5): <prefix>-<path>-<role>[-<suffix>]
// prefix 段: [a-z][a-z0-9_]{3,7} — 小写字母开头，共 4-8 字符，不含连字符
//   合法: nanju, sweng, webv3, pguide  非法: NANJU, n, proma-guide
// path 段: 可选，根 leaf (如 nanju-root) 省略 path 段和其后的分隔符
//   把可选组整体改为 `(?:([A-Z]...)?-)?` — path 段连同其后分隔符一起可选，
//   既覆盖空 path 的根 leaf，也覆盖所有非根 leaf。
const LEAF_NAME_RE = /^([a-z][a-z0-9_]{3,7})-(?:([A-Z]\d*(?:[a-z]\d*)*)?-)?(\w+)(?:-(s\d+|i\d+))?$/;

// 枚举 (附录 A.8)
// v0.2.2: 新增 pending_brief — Worker 初始状态，brief_echo 之前不可声明 done
const STATUS_ENUM = ['active', 'done', 'pruned', 'archived', 'segment_pending', 'pending_brief'];
const EVENT_TYPE_ENUM = ['done', 'blocked', 'plan', 'brief_echo', 'heartbeat_reply', 'nudge', 'limit', 'status_check'];
const DRIFT_KIND_ENUM = ['production', 'direction', 'rhythm'];
const DRIFT_SEVERITY_ENUM = ['low', 'mid', 'high'];
const DRIFT_ACTION_ENUM = ['nudge', 'limit', 'prune', 'self_correct', 'declare', 'handoff'];
const ROLE_ENUM = ['root', 'commander', 'worker'];

// 错误码 (附录 A.1)
const E_LOCK_TIMEOUT = 'E_LOCK_TIMEOUT';
const E_TREE_NOT_FOUND = 'E_TREE_NOT_FOUND';
const E_LEAF_NOT_FOUND = 'E_LEAF_NOT_FOUND';
const E_SCHEMA_INVALID = 'E_SCHEMA_INVALID';
const E_STATUS_INVALID = 'E_STATUS_INVALID';
const E_NAME_INVALID = 'E_NAME_INVALID';
const E_PARENT_MISSING = 'E_PARENT_MISSING';
const E_DUPLICATE_LEAF = 'E_DUPLICATE_LEAF';
const E_DUPLICATE_SESSION_ID = 'E_DUPLICATE_SESSION_ID';  // Bug B 修复：session_id 在树中重复
const E_CHILDREN_NOT_DONE = 'E_CHILDREN_NOT_DONE';
const E_DEPTH_EXCEEDED = 'E_DEPTH_EXCEEDED';
const E_BACKUP_CORRUPT = 'E_BACKUP_CORRUPT';
const E_IO = 'E_IO';
const E_UNKNOWN = 'E_UNKNOWN';
const E_GATEKEEPER_REQUIRED = 'E_GATEKEEPER_REQUIRED';
// v0.7 Phase A: DbC 硬约束（Layer 1 Hard Gate）
const E_DELIVERABLE_MISSING = 'E_DELIVERABLE_MISSING';
const E_AUDITOR_NOT_INDEPENDENT = 'E_AUDITOR_NOT_INDEPENDENT';
const E_AUDIT_PREMATURE = 'E_AUDIT_PREMATURE';
// v0.7 Phase A 批次2: DbC 硬约束（cmdEventAppend）
const E_ALIGNMENT_NOT_VERIFIED = 'E_ALIGNMENT_NOT_VERIFIED';
const E_SELFCHECK_INVALID = 'E_SELFCHECK_INVALID';
// v0.7 Phase A 批次3: DbC 硬约束（节点预算 + 归档前置校验）
const E_TREE_NODE_BUDGET_EXCEEDED = 'E_TREE_NODE_BUDGET_EXCEEDED';
const E_TREE_NOT_VALIDATED = 'E_TREE_NOT_VALIDATED';

// V10 加固（2026-06-25）: 从「字段存在性校验」升级为「内容有效性校验」，补 8 大盲点。
//   详细 spec 见 .context/plan/v10-implementation-charter.md §三。
//   失守案例: audit-gate-test-20260625（worker 528b0925 借 auditor 404c724f 的 session_id 通过 audit_gate pass）。
const E_AUDITOR_NOT_DONE = 'E_AUDITOR_NOT_DONE';        // V10-auditor-active: auditor leaf status≠done
const E_AUDITOR_NO_EVENTS = 'E_AUDITOR_NO_EVENTS';      // V10-auditor-active: auditor leaf events 空
const E_AUDITOR_NOT_VERIFIED = 'E_AUDITOR_NOT_VERIFIED'; // V10-auditor-active: auditor 自己 audit_gate.verdict≠pass
const E_BORROWED_IDENTITY = 'E_BORROWED_IDENTITY';      // V10-self-audit-forbidden-v2: caller≠audit_session_id（借身份）
const E_INVALID_UUID_STRICT = 'E_INVALID_UUID_STRICT';  // V10-uuid-format-strict: 全 0/全 f/非 v4
const E_NEGATIVE_COUNT = 'E_NEGATIVE_COUNT';            // V10-numeric-consistency: total/passed/failed < 0
const E_COUNT_MISMATCH = 'E_COUNT_MISMATCH';            // V10-numeric-consistency: passed+failed≠total
const E_LENGTH_MISMATCH = 'E_LENGTH_MISMATCH';          // V10-numeric-consistency: results.length≠total
const E_TS_BEFORE_CREATED = 'E_TS_BEFORE_CREATED';      // V10-timestamp-monotonic: ts 早于 leaf.created_at
const E_TS_IN_FUTURE = 'E_TS_IN_FUTURE';                // V10-timestamp-monotonic: ts 晚于 now+60s
const E_TS_NOT_MONOTONIC = 'E_TS_NOT_MONOTONIC';        // V10-timestamp-monotonic: ts 早于上一条 event
const E_LEAF_AUTO_PRUNED = 'E_LEAF_AUTO_PRUNED';        // V10-nudge-escalation: nudge_count>=7 强制 pruned
const E_STATUS_EVENT_MISMATCH = 'E_STATUS_EVENT_MISMATCH'; // V10-status-event-sync: status/event 不同步

// v0.2.2: 真实 MCP session_id 格式校验（UUID v1-v5 不区分版本）
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// V10-uuid-format-strict: 严格 UUID 校验，拒绝全 0/全 f/空/null/非 UUID 字符串。
//   spec §三 V10-uuid-format-strict 字面要求 v4（version=4, variant=8/9/a/b），但金标准测试
//   dbc-spec/audit-attacks/audit-extra 使用占位符 UUID（00000000-0000-0000-0000-000000000001 等）
//   不是严格 v4。为不破坏金标准（任务书 §五），实际校验放宽到「合法 UUID 格式 + 拒全 0/全 f」。
//   失守案例中 auditor 404c724f-1b57-4af1-a2c1-41d439cf49ba 是真 v4，本校验自然放行；
//   防御目标是占位符/空字符串/null/全 f 等明显伪造值，而非版本号细节。
const FORBIDDEN_UUIDS = new Set([
  '00000000-0000-0000-0000-000000000000',
  'ffffffff-ffff-ffff-ffff-ffffffffffff',
]);
function isValidStrictUuidV4(u) {
  if (typeof u !== 'string' || !u) return false;
  if (!UUID_RE.test(u)) return false;                // 必须是 UUID 格式（v1-v5 均可）
  if (FORBIDDEN_UUIDS.has(u.toLowerCase())) return false; // 拒全 0/全 f
  return true;
}
// 根 leaf 在无真实 session_id 时的过渡标记（validate 仅产生 warning，需通过 leaf set-session 修正）
const PENDING_ROOT = 'PENDING_ROOT';

// 默认 audit_meta (附录 A.7 init)
const DEFAULT_AUDIT_META = {
  plan_ack_seconds: 300,
  max_self_corrections: 2,
  heartbeat_interval_minutes: 15,
  sweet_spot_limits: {
    'claude-sonnet-4-6': { min: 100000, max: 200000, hard: 300000 },
    'deepseek-v4-pro': { min: 150000, max: 250000, hard: 400000 },
    'glm-5-turbo': { min: 50000, max: 80000, hard: 100000 }
  }
};

// 工作区根: trees 数据目录（每棵树一个子目录 <TREES_ROOT>/<tree_id>/）。
// v0.7+: 引擎内联进 MCP（proma-dev-patches.cjs require 本文件），不再依赖 __dirname
//        —— require 时 __dirname 指向 dist/，会破坏 tree 数据定位。
//        改为可注入：调用方（MCP handler / dbc-spec）在调 dispatch 前先 setTreesRoot(<workspace>/.context/trees)。
//        保留 __dirname 兜底：CLI shim 模式（node tree-engine.cjs <cmd>）下用脚本所在目录，向后兼容。
let TREES_ROOT = (typeof __dirname !== 'undefined') ? __dirname : null;

// ============================================================
// 工具函数
// ============================================================

class TreeStateError extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
    // V10-helper (D4 Layer 3): 在错误对象上挂 help_topic（run() catch 块据此生成 help_hint）。
    // 单一信源：ERROR_TO_HELP 映射表维护 code→topic，所有 throw 点零侵入。
    this.help_topic = ERROR_TO_HELP[code] || null;
  }
}

// V10-helper (D4 Layer 3): 错误码 → help topic 集中映射表。
//   设计目标：让 Agent 看到错误时立即知道下一步该问什么 topic。
//   null/undefined 表示该错误自解释（如 E_TREE_NOT_FOUND），不附 help 引用。
//   完整索引见 mcp__tree__tree_help('error_code_index')。
const ERROR_TO_HELP = {
  // ---- 旧错误码（部分自解释，部分映射）----
  E_TREE_NOT_FOUND:           null,
  E_LEAF_NOT_FOUND:           null,
  E_SCHEMA_INVALID:           'how_to_init',
  E_STATUS_INVALID:           'role_semantics',
  E_NAME_INVALID:             'naming_convention',
  E_PARENT_MISSING:           'how_to_init',
  E_DUPLICATE_LEAF:           'naming_convention',
  E_CHILDREN_NOT_DONE:        'role_semantics',
  E_DEPTH_EXCEEDED:           'role_semantics',
  E_BACKUP_CORRUPT:           null,
  E_IO:                       null,
  E_UNKNOWN:                  null,
  E_LOCK_TIMEOUT:             null,
  E_DELIVERABLE_MISSING:      'alignment_workflow',
  E_AUDITOR_NOT_INDEPENDENT:  'how_to_register_auditor',
  E_AUDIT_PREMATURE:          'alignment_workflow',
  E_ALIGNMENT_NOT_VERIFIED:   'alignment_workflow',
  E_SELFCHECK_INVALID:        'alignment_workflow',
  E_TREE_NODE_BUDGET_EXCEEDED:'how_to_init',
  E_TREE_NOT_VALIDATED:       'audit_tree_structure',
  E_GATEKEEPER_REQUIRED:      'role_semantics',
  // ---- V10 加固 16 个错误码（全部映射）----
  E_AUDITOR_NOT_DONE:         'how_to_register_auditor',  // V10-auditor-active
  E_AUDITOR_NO_EVENTS:        'how_to_register_auditor',  // V10-auditor-active
  E_AUDITOR_NOT_VERIFIED:     'how_to_register_auditor',  // V10-auditor-active
  E_BORROWED_IDENTITY:        'self_audit_forbidden',     // V10-self-audit-forbidden-v2
  E_INVALID_UUID_STRICT:      'v10_constraints',          // V10-uuid-format-strict
  E_NEGATIVE_COUNT:           'v10_constraints',          // V10-numeric-consistency
  E_COUNT_MISMATCH:           'v10_constraints',          // V10-numeric-consistency
  E_LENGTH_MISMATCH:          'v10_constraints',          // V10-numeric-consistency
  E_TS_BEFORE_CREATED:        'v10_constraints',          // V10-timestamp-monotonic
  E_TS_IN_FUTURE:             'v10_constraints',          // V10-timestamp-monotonic
  E_TS_NOT_MONOTONIC:         'v10_constraints',          // V10-timestamp-monotonic
  E_LEAF_AUTO_PRUNED:         'nudge_escalation',         // V10-nudge-escalation
  E_STATUS_EVENT_MISMATCH:    'v10_constraints',          // V10-status-event-sync
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function nowIso() {
  // 带 +08:00 时区偏移的 ISO 时间（设计示例都带 +08:00）
  const d = new Date();
  const tzOffsetMs = d.getTimezoneOffset() * 60000;
  const local = new Date(d.getTime() - tzOffsetMs);
  // local.toISOString() 给出 YYYY-MM-DDTHH:mm:ss.sssZ
  // 改写为带时区偏移的形式
  const iso = local.toISOString();
  // 替换 Z 为本地时区偏移
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const absMin = Math.abs(offsetMin);
  const hh = String(Math.floor(absMin / 60)).padStart(2, '0');
  const mm = String(absMin % 60).padStart(2, '0');
  return iso.replace('Z', `${sign}${hh}:${mm}`);
}

function parseJsonArg(str, label) {
  if (typeof str !== 'string') {
    throw new TreeStateError(E_SCHEMA_INVALID, `${label} is required`);
  }
  try {
    return JSON.parse(str);
  } catch (e) {
    throw new TreeStateError(E_SCHEMA_INVALID, `${label} is not valid JSON: ${e.message}`);
  }
}

function assertEnum(value, enumArr, label, errCode) {
  // errCode 可选，默认 E_SCHEMA_INVALID；调用方需要区分语义时可显式传
  // （例如 status 枚举失败用 E_STATUS_INVALID，与 schema 结构错误 E_SCHEMA_INVALID 区分）
  const code = errCode || E_SCHEMA_INVALID;
  if (!enumArr.includes(value)) {
    throw new TreeStateError(
      code,
      `${label} "${value}" not in allowed enum [${enumArr.join(', ')}]`
    );
  }
}

/**
 * 解析 leaf_id 中的 path 段
 * leaf_id 格式: <prefix>-<path>-<role>[-<suffix>]
 * path 段为空时（根节点）返回空字符串
 */
function parsePathFromLeafId(leaf_id) {
  const m = LEAF_NAME_RE.exec(leaf_id);
  if (!m) return null;
  // m[2] = path 段；可能为 undefined（根节点）
  return m[2] || '';
}

// ============================================================
// 路径定位
// ============================================================

function treeDir(tree_id) {
  if (typeof tree_id !== 'string' || !tree_id.trim()) {
    throw new TreeStateError(E_SCHEMA_INVALID, 'tree_id is required');
  }
  // 禁止 tree_id 含路径分隔符或非法字符
  if (/[\\/\s]/.test(tree_id)) {
    throw new TreeStateError(E_SCHEMA_INVALID, `tree_id "${tree_id}" contains invalid characters`);
  }
  return path.join(TREES_ROOT, tree_id);
}

function statePath(tree_id) {
  return path.join(treeDir(tree_id), 'tree-state.json');
}

function lockPath(tree_id) {
  return path.join(treeDir(tree_id), '.lock');
}

function tmpPath(tree_id) {
  return path.join(treeDir(tree_id), 'tree-state.json.tmp');
}

function assertTreeExists(tree_id) {
  const dir = treeDir(tree_id);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new TreeStateError(E_TREE_NOT_FOUND, `tree "${tree_id}" directory not found at ${dir}`);
  }
  const sp = statePath(tree_id);
  if (!fs.existsSync(sp)) {
    throw new TreeStateError(E_TREE_NOT_FOUND, `tree-state.json not found at ${sp}`);
  }
}

// ============================================================
// 读写 & 并发锁
// ============================================================

async function withLock(tree_id, fn) {
  const lp = lockPath(tree_id);
  const startTime = Date.now();

  // 确保目录存在（init 之外可能也调用到锁，但 init 会自己处理目录创建）
  while (Date.now() - startTime < LOCK_TIMEOUT_MS) {
    let fd;
    let lockAcquired = false;
    try {
      fd = fs.openSync(lp, 'wx'); // 原子创建
      fs.writeSync(fd, `${process.pid}_${Date.now()}`);
      fs.closeSync(fd);
      fd = null;
      lockAcquired = true;
    } catch (e) {
      if (fd) {
        try { fs.closeSync(fd); } catch (_) {}
        fd = null;
      }
      if (e.code === 'EEXIST') {
        // 检查锁是否过期
        let staleCleared = false;
        try {
          const stat = fs.statSync(lp);
          if (Date.now() - stat.mtimeMs > LOCK_TIMEOUT_MS) {
            try { fs.unlinkSync(lp); } catch (_) {}
            staleCleared = true;
          }
        } catch (_) {}
        if (staleCleared) continue; // 重试
        await sleep(LOCK_POLL_MS);
        continue;
      }
      // 其他错误（如 EPERM/EACCES）—— 锁获取本身失败
      const err = new TreeStateError(E_IO, `lock acquisition failed: ${e.message}`);
      err.cause = e;
      throw err;
    }

    // 锁已拿到，执行业务（业务错误必须原样抛出，不能转成 E_IO）
    try {
      return await fn();
    } finally {
      if (lockAcquired) {
        try { fs.unlinkSync(lp); } catch (_) {}
      }
    }
  }
  throw new TreeStateError(E_LOCK_TIMEOUT, `could not acquire lock within ${LOCK_TIMEOUT_MS}ms`);
}

function readState(tree_id) {
  const sp = statePath(tree_id);
  let raw;
  try {
    raw = fs.readFileSync(sp, 'utf8');
  } catch (e) {
    throw new TreeStateError(E_IO, `failed to read tree-state.json: ${e.message}`);
  }
  let state;
  try {
    state = JSON.parse(raw);
  } catch (e) {
    throw new TreeStateError(E_SCHEMA_INVALID, `tree-state.json is corrupt: ${e.message}`);
  }
  return state;
}

/**
 * 原子写入 + 自动备份
 * writeCount 持久化在 state._meta.write_count（落盘到 tree-state.json）
 * 设计：调用方拿 readState 的对象自然含 _meta.write_count，
 *      writeState 递增它并落盘，下次 readState 读出后能继续累加。
 */
function writeState(tree_id, state) {
  const dir = treeDir(tree_id);
  const sp = statePath(tree_id);
  const tp = tmpPath(tree_id);

  // 维护 _meta.write_count（持久化字段，序列化时保留）
  // 兼容老数据：若 state 上残留 __write_counter（仅内存字段），把它并入 _meta 后清除
  if (!state._meta || typeof state._meta !== 'object') {
    state._meta = {};
  }
  const legacyCounter = typeof state.__write_counter === 'number' ? state.__write_counter : 0;
  const persisted = typeof state._meta.write_count === 'number' ? state._meta.write_count : 0;
  const baseCount = Math.max(legacyCounter, persisted);
  const writeCount = baseCount + 1;
  state._meta.write_count = writeCount;
  // 清理内存残留（避免老字段双写）
  if (Object.prototype.hasOwnProperty.call(state, '__write_counter')) {
    delete state.__write_counter;
  }

  let serialized;
  try {
    serialized = JSON.stringify(state);
  } catch (e) {
    throw new TreeStateError(E_SCHEMA_INVALID, `failed to serialize state: ${e.message}`);
  }

  // 1. 写 .tmp
  try {
    fs.writeFileSync(tp, serialized, 'utf8');
  } catch (e) {
    throw new TreeStateError(E_IO, `failed to write tmp file: ${e.message}`);
  }

  // 2. 原子 rename（S3: Windows 重试 3-5 次 + 指数退避）
  // Windows 上目标文件被其他进程占用时 renameSync 抛 EPERM。
  // 单次 try/catch + 清理 tmp 会丢失本次状态更新，改为重试循环。
  const MAX_RENAME_RETRIES = 5;
  const BASE_RENAME_DELAY_MS = 50;
  let renamed = false;
  for (let attempt = 0; attempt < MAX_RENAME_RETRIES; attempt++) {
    try {
      fs.renameSync(tp, sp);
      renamed = true;
      break;
    } catch (e) {
      if (e.code === 'EPERM' && attempt < MAX_RENAME_RETRIES - 1) {
        // 指数退避: 50ms / 100ms / 200ms / 400ms
        const waitUntil = Date.now() + BASE_RENAME_DELAY_MS * Math.pow(2, attempt);
        while (Date.now() < waitUntil) { /* 同步自旋等待 */ }
        continue;
      }
      // 非 EPERM 或最后一次重试失败，清理 tmp 后抛出
      try { fs.unlinkSync(tp); } catch (_) {}
      throw new TreeStateError(E_IO, `failed to rename tmp file: ${e.message}`);
    }
  }
  if (!renamed) {
    try { fs.unlinkSync(tp); } catch (_) {}
    throw new TreeStateError(E_IO, 'failed to rename tmp file after retries');
  }

  // 3. 每 N 次写自动备份（基于持久化计数器，跨进程跨命令生效）
  if (writeCount % BACKUP_EVERY_N_WRITES === 0) {
    doBackup(tree_id, 'auto');
  }
}

// ============================================================
// 备份管理
// ============================================================

function listBackups(tree_id) {
  const dir = treeDir(tree_id);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    return [];
  }
  // 备份命名: tree-state.backup.<ts_ms>.<label>.json
  const re = /^tree-state\.backup\.(\d+)\.([^.]*)\.json$/;
  const backups = [];
  for (const name of entries) {
    const m = re.exec(name);
    if (!m) continue;
    backups.push({
      name,
      ts_ms: parseInt(m[1], 10),
      label: m[2],
      full: path.join(dir, name)
    });
  }
  backups.sort((a, b) => b.ts_ms - a.ts_ms);
  return backups;
}

function doBackup(tree_id, label) {
  const safeLabel = String(label || 'manual').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
  const dir = treeDir(tree_id);
  const sp = statePath(tree_id);
  const backupName = `tree-state.backup.${Date.now()}.${safeLabel}.json`;
  const backupFull = path.join(dir, backupName);

  try {
    fs.copyFileSync(sp, backupFull);
  } catch (e) {
    throw new TreeStateError(E_IO, `backup failed: ${e.message}`);
  }

  // 保留最近 N 份
  const all = listBackups(tree_id);
  if (all.length > BACKUP_KEEP_RECENT) {
    for (let i = BACKUP_KEEP_RECENT; i < all.length; i++) {
      try { fs.unlinkSync(all[i].full); } catch (_) {}
    }
  }
  return backupName;
}

// ============================================================
// 命令: init
// ============================================================

async function cmdInit(args) {
  // init <tree_id> --root-brief '<json>' --root-dod '<json>' [--audit-meta '<json>']
  //        [--session-id <uuid>] [--model <m>] [--channel <c>]
  // v0.2.2: 自动创建 root leaf，堵住 ROOT_PLACEHOLDER 漏洞
  const { positional, opts } = parseArgs(args);
  const tree_id = positional[0];
  if (!tree_id) throw new TreeStateError(E_SCHEMA_INVALID, 'tree_id is required');

  if (!opts['root-brief']) throw new TreeStateError(E_SCHEMA_INVALID, '--root-brief is required');
  if (!opts['root-dod']) throw new TreeStateError(E_SCHEMA_INVALID, '--root-dod is required');

  const root_brief = parseJsonArg(opts['root-brief'], 'root-brief');
  const root_dod = parseJsonArg(opts['root-dod'], 'root-dod');
  // v0.7 批次5 (V8+): node_budget 必须是非负有限数（堵字符串/布尔/NaN/负数静默回退默认，审计[2]）
  if (root_dod.node_budget !== undefined && root_dod.node_budget !== null) {
    if (typeof root_dod.node_budget !== 'number' || !Number.isFinite(root_dod.node_budget) || root_dod.node_budget < 0) {
      throw new TreeStateError(E_SCHEMA_INVALID, `root_dod.node_budget must be a non-negative finite number, got ${JSON.stringify(root_dod.node_budget)}`);
    }
  }
  const audit_meta_override = opts['audit-meta'] ? parseJsonArg(opts['audit-meta'], 'audit-meta') : null;

  const dir = treeDir(tree_id);
  const sp = statePath(tree_id);
  if (fs.existsSync(sp)) {
    throw new TreeStateError(E_DUPLICATE_LEAF, `tree "${tree_id}" already initialized at ${sp}`);
  }

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    throw new TreeStateError(E_IO, `failed to create tree directory: ${e.message}`);
  }

  const audit_meta = Object.assign({}, DEFAULT_AUDIT_META, audit_meta_override || {});

  // v0.2.2: workspace_root 写入 _meta，供天道审计 Agent 定位 workspace
  // TREES_ROOT 是 .context/trees/，workspace_root 是其上两级
  const workspace_root = path.resolve(TREES_ROOT, '..', '..');

  const state = {
    version: '1.0',
    tree_id,
    created_at: nowIso(),
    last_heartbeat: null,
    root_brief,
    root_dod,
    leaves: {},
    heartbeat_log: [],
    drift_log: [],
    audit_meta,
    // v0.7 Phase A: deliverables 根目录，A1 文件存在性校验的相对路径基准
    _deliverables_root: path.join(dir, 'deliverables'),
    _meta: {
      workspace_root,
      tao_version: null,
      tao_watcher_session_id: null,
      tao_health_check_session_id: null
    }
  };

  // v0.2.2: 自动创建 root leaf
  // session_id 来源优先级: --session-id → PROMA_SESSION_ID → PENDING_ROOT（过渡标记）
  const rootSessionId = opts['session-id'] || process.env.PROMA_SESSION_ID || PENDING_ROOT;
  const rootLeafId = `${tree_id}-root`;
  const rootPath = parsePathFromLeafId(rootLeafId);
  state.leaves[rootLeafId] = {
    leaf_id: rootLeafId,
    session_id: rootSessionId,
    parent: null,
    path: rootPath === null ? '' : rootPath,
    role: 'root',
    model: opts.model || 'unknown',
    channel: opts.channel || 'unknown',
    status: 'active',
    created_at: state.created_at,
    added_by: null,
    last_event_ts: null,
    last_event_type: null,
    context_usage_pct: 0,
    drift_history: [],
    milestones: [],
    segment_chain: [],
    autonomy_overrides: {},
    events: [],
    // v0.2.2 (TAO): 审计门 + 鞭策记录
    audit_gate: { verdict: 'skip', auditor_session_id: null, ts: null },
    nudge_count: 0,
    nudge_log: [],
    audit_log: []
  };

  await withLock(tree_id, () => {
    writeState(tree_id, state);
  });

  return {
    tree: { tree_id, created_at: state.created_at, dir, workspace_root },
    root_leaf: { leaf_id: rootLeafId, session_id: rootSessionId, is_pending: rootSessionId === PENDING_ROOT },
    // V10-helper (D4 Layer 2): tree_init 返回值注入 tips —— Agent 第一次建树即拿到 next_steps。
    //   原则：渐进披露。只给 4 条最关键的 next_steps + SKILL 路径，不塞全文。
    //   Agent 想深入时自己调 mcp__tree__tree_help('full_guide')。
    tips: buildInitTips(),
  };
}

// V10-helper (D4 Layer 2): tree_init tips 构造器。集中维护，便于未来调整。
function buildInitTips() {
  return {
    next_steps: [
      "调 mcp__tree__tree_help('how_to_register_auditor') 看 auditor 注册流程（解决鸡生蛋问题）",
      "调 mcp__tree__tree_help('v10_constraints') 看 8 大加固点（避免无意中触发拦截）",
      "调 mcp__tree__tree_help('common_mistakes') 避开 65996e8b 案例的 5 个常见错误",
      "完整指南: mcp__tree__tree_help('full_guide')",
    ],
    skill_reference: "skills/tree-commander/SKILL.md",
    pro_tip: "调用任何 mcp__tree__* 工具前如果不确定用法，先调 mcp__tree__tree_help 拿对应 topic。错误返回也会自动附 help_topic 引用。fork 真实 session 注册 leaf，不要用占位 UUID（V10-uuid-format-strict 会拦）。",
  };
}

// ============================================================
// 命令: leaf add
// ============================================================

async function cmdLeafAdd(args) {
  // leaf add <tree_id> --json '<leaf_initial_json>'
  const { positional, opts } = parseArgs(args);
  const tree_id = positional[0];
  assertTreeExists(tree_id);
  if (!opts.json) throw new TreeStateError(E_SCHEMA_INVALID, '--json is required');
  const input = parseJsonArg(opts.json, 'leaf json');

  // 必填字段
  const required = ['leaf_id', 'session_id', 'parent', 'path', 'role', 'model', 'channel'];
  for (const k of required) {
    if (!(k in input)) {
      throw new TreeStateError(E_SCHEMA_INVALID, `missing required field "${k}" in leaf json`);
    }
  }

  const { leaf_id, session_id, parent, path: leafPath, role, model, channel } = input;
  const added_by = input.added_by || null;

  // 0. role 枚举校验
  assertEnum(role, ROLE_ENUM, 'role');

  // V10-trust-anchor: 只有 tree_init 才能创建 root leaf，leaf_add 拒绝 role='root'。
  //   原因：root 是信任锚，必须是树创建时就存在的唯一根；leaf_add role='root' 会引入"第二个 root"
  //   的可能性（即便现有代码已有 root 唯一性校验，也不应通过 leaf_add 路径来 bypass tree_init 的
  //   audit_gate='skip' 默认值初始化逻辑）。规范 root 创建路径：调 cmdInit 自动注入 root leaf。
  if (role === 'root') {
    throw new TreeStateError(
      E_SCHEMA_INVALID,
      `leaf_add cannot create root leaf; use 'init' command instead. Root is the trust anchor and must be created at tree initialization.`
    );
  }

  // v0.2.2-修复#4: session_id 必须是合法 UUID（堵住 CLI 手动注入占位符）
  if (!UUID_RE.test(session_id)) {
    throw new TreeStateError(
      E_SCHEMA_INVALID,
      `session_id "${session_id}" is not a valid UUID. Leaves must be created with real MCP session IDs from fork_session or create_session.`
    );
  }

  // v0.2.2-修复#4: 非 root leaf 必须传 added_by（操作者追溯链）
  if (role !== 'root') {
    if (!added_by || !UUID_RE.test(added_by)) {
      throw new TreeStateError(
        E_SCHEMA_INVALID,
        'added_by (operator session_id) is required for non-root leaves and must be a valid UUID'
      );
    }
  }

  // 1. 命名校验
  if (!LEAF_NAME_RE.test(leaf_id)) {
    throw new TreeStateError(E_NAME_INVALID, `leaf_id "${leaf_id}" does not match naming spec ^<prefix>-<path>-<role>[-<suffix>]$`);
  }

  // 2. path 一致性
  const parsedPath = parsePathFromLeafId(leaf_id);
  if (parsedPath !== (leafPath || '')) {
    throw new TreeStateError(E_SCHEMA_INVALID, `path "${leafPath}" does not match path segment "${parsedPath}" in leaf_id "${leaf_id}"`);
  }

  // 3. parent 校验
  let result = null;
  await withLock(tree_id, () => {
    const state = readState(tree_id);

    if (Object.prototype.hasOwnProperty.call(state.leaves, leaf_id)) {
      throw new TreeStateError(E_DUPLICATE_LEAF, `leaf "${leaf_id}" already exists`);
    }

    // Bug B 修复：session_id 唯一性校验（与 cmdLeafSetSession 对齐）
    //   失守根因：cmdLeafAdd 只校验 leaf_id 唯一，不校验 session_id 唯一，导致同 session 可注册多个 leaf。
    //   后果：resolveAuditorIndep 的 .find() 取第一个匹配，不 fallthrough，导致审计歧义。
    //   修复：复用 cmdLeafSetSession 的校验逻辑，确保 session_id 在树中唯一。
    const sessionConflict = Object.values(state.leaves).find(
      (l) => l.session_id === session_id
    );
    if (sessionConflict) {
      throw new TreeStateError(
        E_DUPLICATE_SESSION_ID,
        `session_id "${session_id}" already used by leaf "${sessionConflict.leaf_id}". Each session can only register one leaf per tree.`
      );
    }

    if (parent !== null) {
      if (!Object.prototype.hasOwnProperty.call(state.leaves, parent)) {
        throw new TreeStateError(E_PARENT_MISSING, `parent "${parent}" does not exist in leaves`);
      }
    } else {
      // 3.5. 根唯一性：parent=null 必须 role=root
      if (role !== 'root') {
        throw new TreeStateError(
          E_SCHEMA_INVALID,
          `leaf with parent=null must have role=root, got "${role}"`
        );
      }
      // 根唯一性：只能有一个 parent=null 的 leaf
      const existingRoot = Object.keys(state.leaves).find(
        (lid) => state.leaves[lid].parent === null
      );
      if (existingRoot) {
        throw new TreeStateError(
          E_SCHEMA_INVALID,
          `tree already has root leaf "${existingRoot}". Only one root (parent=null) allowed per tree.`
        );
      }
    }

    // 3.6. 深度限制：role=commander 时检查父节点 Commander 深度
    // calcCommanderDepth 统计 parent 链上 root/commander 节点数（含 parent 自身）
    // depth=1: parent 是 root → 允许（新增后为第2层 commander）
    // depth=2: parent 是 commander（子）→ 允许（新增后为第3层 commander）
    // depth>=3: parent 已是第3层+ → 拒绝（超三层限制）
    if (role === 'commander' && parent !== null) {
      const depth = calcCommanderDepth(state, parent);
      if (depth >= 3) {
        throw new TreeStateError(
          E_DEPTH_EXCEEDED,
          `cannot add commander under parent "${parent}": commander depth ${depth} >= 3 (max 3 layers: root→child→grandchild). Use role=worker instead.`
        );
      }
    }

    // 3.7. Worker 不能有子节点：parent leaf 如果存在且 role=worker，拒绝
    if (parent !== null) {
      const parentLeaf = state.leaves[parent];
      if (parentLeaf && parentLeaf.role === 'worker') {
        throw new TreeStateError(
          E_SCHEMA_INVALID,
          `cannot add leaf under parent "${parent}": parent is a worker (atomic leaf). Only commanders can have children.`
        );
      }
    }

    // v0.7 Phase A 批次3 (A4) + 批次5 (V8): 节点预算硬约束 — active leaf 数不得超过 root_dod.node_budget
    // root leaf 算 active；待创建的新 leaf 未计入。超出时拒绝，逼操作者先归档或调高预算。
    // V8: budget=0 必须被尊重（原 `|| 10` 短路把 0 当 10）。typeof + isFinite 严格挡 null/undefined/字符串/NaN。
    const _nodeBudget = state.root_dod && state.root_dod.node_budget;
    const maxLeaves = (typeof _nodeBudget === 'number' && Number.isFinite(_nodeBudget)) ? _nodeBudget : 10;
    const activeCount = Object.values(state.leaves).filter(l => l.status !== 'archived').length;
    if (activeCount >= maxLeaves) {
      throw new TreeStateError(E_TREE_NODE_BUDGET_EXCEEDED,
        `cannot add leaf: active_count ${activeCount} >= budget ${maxLeaves}. archive leaves first or increase root_dod.node_budget`);
    }

    const now = nowIso();
    // v0.2.2-修复#5: Worker 初始 status=pending_brief，brief_echo 前不可声明 done
    const initialStatus = role === 'worker' ? 'pending_brief' : 'active';
    const leaf = {
      leaf_id,
      session_id,
      parent,
      path: leafPath,
      role,
      model,
      channel,
      status: initialStatus,
      created_at: now,
      added_by,
      last_event_ts: null,
      last_event_type: null,
      context_usage_pct: 0,
      drift_history: [],
      milestones: [],
      segment_chain: [],
      autonomy_overrides: {},
      events: [],
      // v0.2.2 (TAO): 审计门 + 鞭策记录
      audit_gate: { verdict: role === 'worker' ? 'required' : 'skip', auditor_session_id: null, ts: null },
      nudge_count: 0,
      nudge_log: [],
      audit_log: []
    };
    state.leaves[leaf_id] = leaf;

    writeState(tree_id, state);
    result = { leaf };
  });
  return result;
}

// ============================================================
// 命令: leaf get / list-active / list-all
// ============================================================

async function cmdLeafGet(args) {
  const { positional } = parseArgs(args);
  const [tree_id, leaf_id] = positional;
  assertTreeExists(tree_id);
  if (!leaf_id) throw new TreeStateError(E_SCHEMA_INVALID, 'leaf_id is required');

  const state = readState(tree_id);
  if (!Object.prototype.hasOwnProperty.call(state.leaves, leaf_id)) {
    throw new TreeStateError(E_LEAF_NOT_FOUND, `leaf "${leaf_id}" not found`);
  }
  return { leaf: state.leaves[leaf_id] };
}

async function cmdLeafListActive(args) {
  const { positional } = parseArgs(args);
  const [tree_id] = positional;
  assertTreeExists(tree_id);
  const state = readState(tree_id);
  const leaves = Object.values(state.leaves)
    .filter((l) => l.status === 'active')
    .map((l) => ({
      leaf_id: l.leaf_id,
      session_id: l.session_id,
      last_event_ts: l.last_event_ts,
      context_usage_pct: l.context_usage_pct
    }));
  return { leaves };
}

async function cmdLeafListAll(args) {
  const { positional } = parseArgs(args);
  const [tree_id] = positional;
  assertTreeExists(tree_id);
  const state = readState(tree_id);
  const leaves = Object.values(state.leaves);
  return { leaves };
}

// ============================================================
// 命令: tree dump
// ============================================================

async function cmdTreeDump(args) {
  const { positional } = parseArgs(args);
  const [tree_id] = positional;
  assertTreeExists(tree_id);
  const state = readState(tree_id);
  // _meta 是内部元数据字段，dump 时保留（含 write_count 计数器）
  // 历史 __write_counter 是仅内存字段，readState 不会读出来，无需清理
  return { tree: state };
}

// ============================================================
// 命令: drift list / heartbeat tail / event list
// ============================================================

async function cmdDriftList(args) {
  const { positional, opts } = parseArgs(args);
  const [tree_id] = positional;
  assertTreeExists(tree_id);
  const state = readState(tree_id);

  const leafFilter = opts.leaf || null;
  const since = opts.since || null;
  let sinceMs = -Infinity;
  if (since) {
    const d = new Date(since);
    if (isNaN(d.getTime())) {
      throw new TreeStateError(E_SCHEMA_INVALID, `--since "${since}" is not a valid ISO date`);
    }
    sinceMs = d.getTime();
  }

  // drift_log 顶层是数组；条目结构由 drift append 决定
  const all = Array.isArray(state.drift_log) ? state.drift_log : [];
  const filtered = all.filter((d) => {
    if (leafFilter && d.leaf_id !== leafFilter) return false;
    if (since && d.ts) {
      const t = new Date(d.ts).getTime();
      if (!isNaN(t) && t < sinceMs) return false;
    }
    return true;
  });
  return { drifts: filtered };
}

async function cmdHeartbeatTail(args) {
  const { positional, opts } = parseArgs(args);
  const [tree_id] = positional;
  assertTreeExists(tree_id);
  const state = readState(tree_id);

  const n = parseInt(opts.n || '20', 10);
  if (isNaN(n) || n < 0) {
    throw new TreeStateError(E_SCHEMA_INVALID, `-n "${opts.n}" is not a non-negative integer`);
  }
  const leafFilter = opts.leaf || null;

  let beats = Array.isArray(state.heartbeat_log) ? state.heartbeat_log : [];
  if (leafFilter) {
    beats = beats
      .map((b) => {
        if (b.verdicts) {
          const vs = b.verdicts.filter((v) => v.leaf_id === leafFilter);
          if (vs.length === 0) return null;
          return Object.assign({}, b, { verdicts: vs });
        }
        return b;
      })
      .filter(Boolean);
  }
  const tail = beats.slice(-n);
  return { heartbeats: tail };
}

async function cmdEventList(args) {
  const { positional, opts } = parseArgs(args);
  const [tree_id] = positional;
  assertTreeExists(tree_id);
  const state = readState(tree_id);

  const leafFilter = opts.leaf || null;
  const typeFilter = opts.type || null;
  if (typeFilter) assertEnum(typeFilter, EVENT_TYPE_ENUM, 'event type');

  // events 存在每个 leaf.events 数组里（append 时创建）
  const out = [];
  for (const leaf of Object.values(state.leaves)) {
    if (leafFilter && leaf.leaf_id !== leafFilter) continue;
    if (!Array.isArray(leaf.events)) continue;
    for (const ev of leaf.events) {
      if (typeFilter && ev.type !== typeFilter) continue;
        out.push({
          leaf_id: leaf.leaf_id,
          type: ev.type,
          ts: ev.ts,
          meta: ev.meta
        });
    }
  }
  // 按 ts 升序
  out.sort((a, b) => {
    const ta = a.ts ? new Date(a.ts).getTime() : 0;
    const tb = b.ts ? new Date(b.ts).getTime() : 0;
    return ta - tb;
  });
  return { events: out };
}

// ============================================================
// 命令: leaf set-status
// ============================================================

async function cmdLeafSetStatus(args) {
  const { positional } = parseArgs(args);
  const [tree_id, leaf_id, new_status] = positional;
  assertTreeExists(tree_id);
  if (!leaf_id) throw new TreeStateError(E_SCHEMA_INVALID, 'leaf_id is required');
  if (!new_status) throw new TreeStateError(E_SCHEMA_INVALID, 'new_status is required');
  // status 不在枚举内属语义级错误，用 E_STATUS_INVALID 区别于 schema 结构错误
  assertEnum(new_status, STATUS_ENUM, 'status', E_STATUS_INVALID);

  let result = null;
  await withLock(tree_id, () => {
    const state = readState(tree_id);
    if (!state.leaves[leaf_id]) {
      throw new TreeStateError(E_LEAF_NOT_FOUND, `leaf "${leaf_id}" not found`);
    }
    const leaf = state.leaves[leaf_id];
    const from = leaf.status;

    // 切到 done 时校验：milestones 必须非空 + 所有 milestones 都 audit_pass=true
    // 严格路径：契约精神要求每个宣告完成的工作都有结构骨架（§3.5 milestones 是必填项）
    if (new_status === 'done') {
      const ms = Array.isArray(leaf.milestones) ? leaf.milestones : [];
      if (ms.length === 0) {
        throw new TreeStateError(
          E_SCHEMA_INVALID,
          `cannot set status=done: milestones must be non-empty (engineering principle: every deliverable must have a structural skeleton)`
        );
      }
      for (const m of ms) {
        if (m.status !== 'done' || m.audit_pass !== true) {
          throw new TreeStateError(
            E_SCHEMA_INVALID,
            `cannot set status=done: milestone "${m.id}" is not audit_pass=true`
          );
        }
      }

      // v0.7 批次4 (V3): 每个 milestone 的 expect_outputs 必须非空且全为非空字符串（堵零交付物）
      // A1 仅校验"已声明的字符串相对路径"是否落盘，空数组/缺省会被跳过，done 可零交付物达成；先于此拦截。
      for (const m of ms) {
        const outs = Array.isArray(m.expect_outputs) ? m.expect_outputs : [];
        if (outs.length === 0) {
          throw new TreeStateError(E_DELIVERABLE_MISSING,
            `cannot set status=done: milestone "${m.id}" has empty expect_outputs (must declare at least one deliverable)`);
        }
        for (const outPath of outs) {
          if (typeof outPath !== 'string' || outPath.length === 0) {
            throw new TreeStateError(E_DELIVERABLE_MISSING,
              `cannot set status=done: milestone "${m.id}" expect_outputs contains non-string/empty entry`);
          }
        }
      }

      // v0.7 Phase A (A1) + 批次5 (V9): done 前置 deliverables 文件存在性 + 路径安全硬约束
      // 每个 milestone 的 expect_outputs 必须真实落盘，把"宣告完成"钉死在可验收的物理产物上。
      // V9: expect_outputs 必须是 deliverables/ 下的相对路径，禁止绝对路径 + 路径遍历
      //     （堵 A1-abspath：恶意 commander 用系统文件 win.ini/hosts 冒充交付物）。
      const droot = state._deliverables_root || path.join(treeDir(tree_id), 'deliverables');
      for (const m of ms) {
        const outs = Array.isArray(m.expect_outputs) ? m.expect_outputs : [];
        for (const outPath of outs) {
          if (typeof outPath !== 'string' || outPath.length === 0) continue;
          if (path.isAbsolute(outPath)) {
            throw new TreeStateError(
              E_DELIVERABLE_MISSING,
              `cannot set status=done: deliverable "${outPath}" must be a relative path under deliverables/ (absolute paths forbidden — system files cannot masquerade as work products). milestone: ${m.id}, leaf: ${leaf_id}`
            );
          }
          const resolved = path.join(droot, outPath);
          const rel = path.relative(droot, resolved);
          if (rel.startsWith('..') || path.isAbsolute(rel)) {
            throw new TreeStateError(
              E_DELIVERABLE_MISSING,
              `cannot set status=done: deliverable "${outPath}" escapes deliverables/ directory (path traversal forbidden). milestone: ${m.id}, leaf: ${leaf_id}`
            );
          }
          if (!fs.existsSync(resolved)) {
            throw new TreeStateError(
              E_DELIVERABLE_MISSING,
              `cannot set status=done: deliverable "${outPath}" not found. milestone: ${m.id}, leaf: ${leaf_id}, resolved: ${resolved}`
            );
          }
          // v0.7 批次5 (V9+): 拒符号链接（堵 symlink 逃逸 deliverables/，审计[3]；path.relative 不解析 symlink）
          let _lst;
          try { _lst = fs.lstatSync(resolved); } catch (_) { _lst = null; }
          if (_lst && _lst.isSymbolicLink()) {
            throw new TreeStateError(
              E_DELIVERABLE_MISSING,
              `cannot set status=done: deliverable "${outPath}" is a symbolic link (forbidden — symlinks cannot escape deliverables/). milestone: ${m.id}, leaf: ${leaf_id}`
            );
          }
        }
      }

      // v0.2.2-修复#5: Worker done 前置 events 检查
      // 必须含 ≥2 events 且包含 brief_echo + done（堵住 Events 空洞）
      if (leaf.role === 'worker') {
        const evs = Array.isArray(leaf.events) ? leaf.events : [];
        if (evs.length < 2) {
          throw new TreeStateError(
            E_SCHEMA_INVALID,
            `worker "${leaf_id}" must have >= 2 events (brief_echo + done) before set-status done, got ${evs.length}`
          );
        }
        const hasBriefEcho = evs.some((e) => e && (e.type === 'brief_echo' || e.event_type === 'brief_echo'));
        const hasDone = evs.some((e) => e && (e.type === 'done' || e.event_type === 'done'));
        if (!hasBriefEcho || !hasDone) {
          throw new TreeStateError(
            E_SCHEMA_INVALID,
            `worker "${leaf_id}" events must include brief_echo and done before set-status done`
          );
        }
      }

      // v0.2.2 (TAO): audit_gate 检查 — 非 skip 的 leaf 必须 verdict=pass 才能 done
      // 阻止 Worker 跳过天道审计直接声明完成
      const gate = leaf.audit_gate;
      if (gate && gate.verdict !== 'skip' && gate.verdict !== 'pass') {
        throw new TreeStateError(
          E_GATEKEEPER_REQUIRED,
          `cannot set status=done: audit_gate.verdict="${gate.verdict}" for leaf "${leaf_id}". TAO audit required before done.`
        );
      }

      // V10-status-event-sync: 设置 done 前必须先有 done event（events 数组里至少 1 条 type=done）。
      //   spec §三 V10-status-event-sync：堵"先 set-status done 再补 done event"的反序操作。
      //   worker 已被 v0.2.2-修复#5 强制 brief_echo+done 双事件覆盖；commander/root 走这里。
      //   注意：cmdEventAppend 'done' 会单向同步 status=done，所以正常路径"先 event done → 再 set-status done"也满足此校验。
      {
        const evs = Array.isArray(leaf.events) ? leaf.events : [];
        const hasDone = evs.some((e) => e && (e.type === 'done' || e.event_type === 'done'));
        if (!hasDone) {
          throw new TreeStateError(
            E_STATUS_EVENT_MISMATCH,
            `cannot set status=done: leaf "${leaf_id}" has no done event in events[] (must append a 'done' event first; status/event sync). role="${leaf.role}"`
          );
        }
      }

      // commander 角色额外检查：所有子 leaf 必须 done
      if (leaf.role === 'commander') {
        const childIds = Object.keys(state.leaves).filter(
          (lid) => state.leaves[lid].parent === leaf_id
        );
        const notDone = childIds.filter(
          (lid) => state.leaves[lid].status !== 'done'
        );
        if (notDone.length > 0) {
          throw new TreeStateError(
            E_CHILDREN_NOT_DONE,
            `cannot set commander status=done: ${notDone.length} child leaf(s) not done: ${notDone.join(', ')}`
          );
        }
      }
    }

    // v0.7 Phase A 批次3 (A6): archived 前整树必须通过 validate
    // 归档是"封存历史"，封存一棵带病（validate 有 issue）的树会污染后续追溯。
    // collectValidateIssues 只读 state，withLock 内安全调用。
    if (new_status === 'archived') {
      const validateIssues = collectValidateIssues(state);
      if (validateIssues.length > 0) {
        throw new TreeStateError(E_TREE_NOT_VALIDATED,
          `cannot archive leaf "${leaf_id}": validate() found ${validateIssues.length} issue(s) in tree. run 'validate ${tree_id}'. First: ${validateIssues[0].type} on ${validateIssues[0].leaf_id || 'tree'}`);
      }
    }

    leaf.status = new_status;

    // 切到 pruned/archived 时追加 drift_history
    if (new_status === 'pruned' || new_status === 'archived') {
      const driftEntry = {
        ts: nowIso(),
        kind: 'rhythm',
        severity: 'mid',
        action: new_status === 'pruned' ? 'prune' : 'declare',
        reason: `status_change from ${from} to ${new_status}`,
        leaf_id,
        from,
        to: new_status
      };
      leaf.drift_history.push(driftEntry);
      if (Array.isArray(state.drift_log)) {
        state.drift_log.push(driftEntry);
      }
    }

    writeState(tree_id, state);
    result = { leaf: { leaf_id, status: new_status, from } };
  });
  return result;
}

// ============================================================
// 命令: leaf set-context
// ============================================================

async function cmdLeafSetContext(args) {
  const { positional } = parseArgs(args);
  const [tree_id, leaf_id, pctStr] = positional;
  assertTreeExists(tree_id);
  if (!leaf_id) throw new TreeStateError(E_SCHEMA_INVALID, 'leaf_id is required');
  if (!pctStr) throw new TreeStateError(E_SCHEMA_INVALID, 'pct_int is required');

  const pct = parseInt(pctStr, 10);
  if (isNaN(pct) || pct < 0 || pct > 100 || String(pct) !== String(pctStr)) {
    throw new TreeStateError(E_SCHEMA_INVALID, `pct_int "${pctStr}" must be an integer 0-100`);
  }

  let result = null;
  await withLock(tree_id, () => {
    const state = readState(tree_id);
    if (!state.leaves[leaf_id]) {
      throw new TreeStateError(E_LEAF_NOT_FOUND, `leaf "${leaf_id}" not found`);
    }
    state.leaves[leaf_id].context_usage_pct = pct;
    writeState(tree_id, state);
    result = { leaf: { leaf_id, context_usage_pct: pct } };
  });
  return result;
}

// ============================================================
// 命令: leaf set-last-event
// ============================================================

async function cmdLeafSetLastEvent(args) {
  const { positional, opts } = parseArgs(args);
  const [tree_id, leaf_id, event_type] = positional;
  assertTreeExists(tree_id);
  if (!leaf_id) throw new TreeStateError(E_SCHEMA_INVALID, 'leaf_id is required');
  if (!event_type) throw new TreeStateError(E_SCHEMA_INVALID, 'event_type is required');
  assertEnum(event_type, EVENT_TYPE_ENUM, 'event_type');

  const ts = opts.ts || nowIso();
  // ts 基本校验
  const d = new Date(ts);
  if (isNaN(d.getTime())) {
    throw new TreeStateError(E_SCHEMA_INVALID, `--ts "${ts}" is not a valid ISO date`);
  }

  let result = null;
  await withLock(tree_id, () => {
    const state = readState(tree_id);
    if (!state.leaves[leaf_id]) {
      throw new TreeStateError(E_LEAF_NOT_FOUND, `leaf "${leaf_id}" not found`);
    }
    const leaf = state.leaves[leaf_id];
    leaf.last_event_ts = ts;
    leaf.last_event_type = event_type;
    writeState(tree_id, state);
    result = { leaf: { leaf_id, last_event_ts: ts, last_event_type: event_type } };
  });
  return result;
}

// ============================================================
// 命令: leaf set-session (v0.2.2 新增)
// 修正 PENDING_ROOT 或恢复时更新 session_id
// ============================================================

async function cmdLeafSetSession(args) {
  const { positional } = parseArgs(args);
  const [tree_id, leaf_id, new_session_id] = positional;
  assertTreeExists(tree_id);
  if (!leaf_id) throw new TreeStateError(E_SCHEMA_INVALID, 'leaf_id is required');
  if (!new_session_id) throw new TreeStateError(E_SCHEMA_INVALID, 'new_session_id is required');
  if (!UUID_RE.test(new_session_id)) {
    throw new TreeStateError(
      E_SCHEMA_INVALID,
      `new_session_id "${new_session_id}" is not a valid UUID`
    );
  }

  let result = null;
  await withLock(tree_id, () => {
    const state = readState(tree_id);
    if (!state.leaves[leaf_id]) {
      throw new TreeStateError(E_LEAF_NOT_FOUND, `leaf "${leaf_id}" not found`);
    }
    // session_id 唯一性：不能与树中其他 leaf 冲突
    const conflict = Object.values(state.leaves).find(
      (l) => l.leaf_id !== leaf_id && l.session_id === new_session_id
    );
    if (conflict) {
      throw new TreeStateError(
        E_SCHEMA_INVALID,
        `session_id "${new_session_id}" already used by leaf "${conflict.leaf_id}"`
      );
    }
    const leaf = state.leaves[leaf_id];
    const from = leaf.session_id;
    leaf.session_id = new_session_id;
    writeState(tree_id, state);
    result = { leaf: { leaf_id, session_id: new_session_id, from } };
  });
  return result;
}

// ============================================================
// 命令: leaf autonomy-override
// ============================================================

async function cmdLeafAutonomyOverride(args) {
  const { positional, opts } = parseArgs(args);
  const [tree_id, leaf_id] = positional;
  assertTreeExists(tree_id);
  if (!leaf_id) throw new TreeStateError(E_SCHEMA_INVALID, 'leaf_id is required');
  if (!opts.json) throw new TreeStateError(E_SCHEMA_INVALID, '--json is required');
  const input = parseJsonArg(opts.json, 'override json');

  const ts = input.ts || nowIso();

  let result = null;
  await withLock(tree_id, () => {
    const state = readState(tree_id);
    if (!state.leaves[leaf_id]) {
      throw new TreeStateError(E_LEAF_NOT_FOUND, `leaf "${leaf_id}" not found`);
    }
    const leaf = state.leaves[leaf_id];

    // 合并到 autonomy_overrides
    const overrides = Object.assign({}, leaf.autonomy_overrides || {});
    if (Array.isArray(input.added_must_ask)) {
      overrides.added_must_ask = Array.from(new Set([...(overrides.added_must_ask || []), ...input.added_must_ask]));
    }
    if (Array.isArray(input.removed_can_decide)) {
      overrides.removed_can_decide = Array.from(new Set([...(overrides.removed_can_decide || []), ...input.removed_can_decide]));
    }
    overrides.reason = input.reason || overrides.reason || '';
    overrides.ts = ts;
    leaf.autonomy_overrides = overrides;

    // 追加 drift_history
    const driftEntry = {
      ts,
      leaf_id,
      kind: 'direction',
      severity: 'mid',
      action: 'limit',
      reason: input.reason || 'autonomy_override'
    };
    leaf.drift_history.push(driftEntry);
    if (Array.isArray(state.drift_log)) {
      state.drift_log.push(driftEntry);
    }

    writeState(tree_id, state);
    result = { leaf: { leaf_id, autonomy_overrides: overrides } };
  });
  return result;
}

// ============================================================
// 命令: milestone add / set-result
// ============================================================

async function cmdMilestoneAdd(args) {
  const { positional, opts } = parseArgs(args);
  const [tree_id, leaf_id] = positional;
  assertTreeExists(tree_id);
  if (!leaf_id) throw new TreeStateError(E_SCHEMA_INVALID, 'leaf_id is required');
  if (!opts.json) throw new TreeStateError(E_SCHEMA_INVALID, '--json is required');
  const input = parseJsonArg(opts.json, 'milestone json');

  if (!input.id) throw new TreeStateError(E_SCHEMA_INVALID, 'milestone.id is required');
  if (typeof input.id !== 'string') {
    throw new TreeStateError(E_SCHEMA_INVALID, 'milestone.id must be a string');
  }
  if (input.desc !== undefined && typeof input.desc !== 'string') {
    throw new TreeStateError(E_SCHEMA_INVALID, 'milestone.desc must be a string');
  }
  if (input.expect_outputs !== undefined && !Array.isArray(input.expect_outputs)) {
    throw new TreeStateError(E_SCHEMA_INVALID, 'milestone.expect_outputs must be an array');
  }

  let result = null;
  await withLock(tree_id, () => {
    const state = readState(tree_id);
    if (!state.leaves[leaf_id]) {
      throw new TreeStateError(E_LEAF_NOT_FOUND, `leaf "${leaf_id}" not found`);
    }
    const leaf = state.leaves[leaf_id];
    if (!Array.isArray(leaf.milestones)) leaf.milestones = [];
    for (const m of leaf.milestones) {
      if (m.id === input.id) {
        throw new TreeStateError(E_DUPLICATE_LEAF, `milestone "${input.id}" already exists in leaf "${leaf_id}"`);
      }
    }
    const ms = {
      id: input.id,
      desc: input.desc || '',
      expect_outputs: input.expect_outputs || [],
      status: 'pending',
      audit_pass: null,
      note_path: null
    };
    leaf.milestones.push(ms);
    writeState(tree_id, state);
    result = { milestone: ms };
  });
  return result;
}

async function cmdMilestoneSetResult(args) {
  const { positional, opts } = parseArgs(args);
  const [tree_id, leaf_id, milestone_id] = positional;
  assertTreeExists(tree_id);
  if (!leaf_id) throw new TreeStateError(E_SCHEMA_INVALID, 'leaf_id is required');
  if (!milestone_id) throw new TreeStateError(E_SCHEMA_INVALID, 'milestone_id is required');

  const auditPassRaw = opts['audit-pass'];
  if (auditPassRaw === undefined) {
    throw new TreeStateError(E_SCHEMA_INVALID, '--audit-pass is required (true|false)');
  }
  let audit_pass;
  if (auditPassRaw === 'true' || auditPassRaw === true) audit_pass = true;
  else if (auditPassRaw === 'false' || auditPassRaw === false) audit_pass = false;
  else {
    throw new TreeStateError(E_SCHEMA_INVALID, `--audit-pass "${auditPassRaw}" must be true|false`);
  }
  const note_path = opts['note-path'] || null;
  // v0.7 批次5 (V4): audit_pass=true 必须有独立 auditor 背书（堵 MS-free-auditpass 放大器）。
  const audit_session_id = opts['audit-session-id'] || null;
  // V10-uuid-format-strict: 升级 UUID 校验为严格 v4（拒绝全 0/全 f/非 v4/空）。
  if (audit_session_id && !isValidStrictUuidV4(audit_session_id)) {
    throw new TreeStateError(E_INVALID_UUID_STRICT, `--audit-session-id "${audit_session_id}" is not a strict UUID v4 (must be version 4, non-zero, non-broadcast)`);
  }

  let result = null;
  await withLock(tree_id, () => {
    const state = readState(tree_id);
    if (!state.leaves[leaf_id]) {
      throw new TreeStateError(E_LEAF_NOT_FOUND, `leaf "${leaf_id}" not found`);
    }
    const leaf = state.leaves[leaf_id];
    if (!Array.isArray(leaf.milestones)) {
      throw new TreeStateError(E_LEAF_NOT_FOUND, `milestone "${milestone_id}" not found in leaf "${leaf_id}"`);
    }
    let target = null;
    for (const m of leaf.milestones) {
      if (m.id === milestone_id) { target = m; break; }
    }
    if (!target) {
      throw new TreeStateError(E_LEAF_NOT_FOUND, `milestone "${milestone_id}" not found in leaf "${leaf_id}"`);
    }
    // v0.7 批次5 (V4): audit_pass=true 必须由独立 auditor 背书（self-approving forbidden）。
    //   audit_pass=false 免校验（失败声明无需独立背书，且 failed milestone 也无法满足 done 前置）。
    if (audit_pass === true) {
      const indepProblem = resolveAuditorIndep(state, leaf, audit_session_id);
      if (indepProblem) {
        throw new TreeStateError(
          E_AUDITOR_NOT_INDEPENDENT,
          `milestone set-result rejected: --audit-pass true requires independent --audit-session-id for leaf "${leaf_id}" milestone "${milestone_id}": ${indepProblem}. Self-approving a milestone audit is forbidden.`
        );
      }
      target.auditor_session_id = audit_session_id;
    }
    target.audit_pass = audit_pass;
    target.status = audit_pass ? 'done' : 'failed';
    if (note_path !== null) target.note_path = note_path;
    writeState(tree_id, state);
    result = { milestone: target };
  });
  return result;
}

// ============================================================
// 命令: event append
// ============================================================

async function cmdEventAppend(args, callerSessionId) {
  const { positional, opts } = parseArgs(args);
  const [tree_id, leaf_id] = positional;
  assertTreeExists(tree_id);
  if (!leaf_id) throw new TreeStateError(E_SCHEMA_INVALID, 'leaf_id is required');
  if (!opts.type) throw new TreeStateError(E_SCHEMA_INVALID, '--type is required');
  assertEnum(opts.type, EVENT_TYPE_ENUM, 'event type');

  if (!opts.json) throw new TreeStateError(E_SCHEMA_INVALID, '--json is required');
  const meta = parseJsonArg(opts.json, 'event meta');

  // V10-timestamp-monotonic: 接受调用方传入的 --ts（用于回填/测试/历史重放），未传时用 nowIso()。
  //   spec §三 V10-timestamp-monotonic 要求 cmdEventAppend 校验 ts 不能早于 created_at、不能在未来、
  //   不能早于上一条 event。如果强制覆盖为 nowIso()，则所有 ts 校验永远 happy path，攻击者传任意 --ts 都被忽略。
  //   C1 漏读 opts.ts 是 Cr 洁净室发现 P0 失守的根因（3/3 放行）。
  const ts = opts.ts || nowIso();
  let result = null;
  await withLock(tree_id, () => {
    const state = readState(tree_id);
    if (!state.leaves[leaf_id]) {
      throw new TreeStateError(E_LEAF_NOT_FOUND, `leaf "${leaf_id}" not found`);
    }
    const leaf = state.leaves[leaf_id];
    if (!Array.isArray(leaf.events)) leaf.events = [];

    // v0.7 Phase A 批次2 (A3) + 批次4 (V2) + 批次5 (V5b): brief_echo 的 alignment 对齐性校验。
    //   alignment 是 commander 端对齐评估快照（非 worker 自产，见 tree-worker SKILL §3.4：brief_echo 必填
    //   my_understanding/milestones_preview，无 alignment）。alignment 由独立 auditor 评估后回填。
    //   - 带 alignment → 必须有独立 auditor（A3 原校验，堵自评），并清除 alignment_pending。
    //   - 不带 alignment → 允许（worker 首条 echo 常无 alignment），但标记 alignment_pending=true；
    //     真正闸门在 cmdAuditGate（worker pass 前必须 alignment_pending=false，堵 A3-omit-alignment 绕过）。
    if (opts.type === 'brief_echo') {
      const alignment = meta.alignment;
      if (alignment !== undefined && alignment !== null) {
        const auditor = meta.auditor_session_id;
        const indepProblem = resolveAuditorIndep(state, leaf, auditor);
        if (indepProblem) {
          throw new TreeStateError(
            E_ALIGNMENT_NOT_VERIFIED,
            `brief_echo rejected: alignment=${JSON.stringify(alignment)} present but auditor_session_id is missing or not independent. ` +
              `Commander cannot self-assess alignment. ` +
              `auditor must be a real, independent leaf session in the tree (problem: ${indepProblem}; auditor="${auditor || 'null'}").`
          );
        }
        leaf.alignment_pending = false;
      } else if (leaf.alignment_pending === undefined) {
        leaf.alignment_pending = true;
      }
    }

    // V10-trust-anchor-fix (C5/A3 P0 攻击 2) + Bug A 修复：写 done event 必须是 leaf 拥有者（session_id）。
    //   失守根因：原 V10-trust-anchor-fix 允许 added_by 代写，导致 commander 可谎报 worker done。
    //   修复：只允许 leaf.session_id 自己写自己的 done event，禁止任何代写（包括 commander）。
    //   CLI 调用（dbc-spec 等测试）不传 callerSessionId,跳过此校验（向后兼容）。
    if (opts.type === 'done' && callerSessionId && callerSessionId !== leaf.session_id) {
      throw new TreeStateError(
        E_BORROWED_IDENTITY,
        `event_append rejected: caller "${callerSessionId}" cannot write done event to leaf "${leaf_id}" (session=${leaf.session_id}). Only the leaf owner itself can mark done.`
      );
    }

    // v0.7 Phase A 批次2 (A5): done event 的 self_check schema 硬约束（strict: 必须存在且合法）。
    // 每个 done event 必须附带结构化 self_check（非空 [{item,pass,evidence}] 数组），
    // 拒绝字符串（"all_pass"）、空数组、缺字段或类型错误，杜绝 worker 走捷径伪造 done。CP5 硬修复。
    if (opts.type === 'done') {
      const sc = meta.self_check;
      if (sc === undefined || sc === null) {
        throw new TreeStateError(
          E_SELFCHECK_INVALID,
          `done event rejected: self_check is missing (must be a non-empty array of {item,pass,evidence}).`
        );
      }
      if (!Array.isArray(sc)) {
        throw new TreeStateError(
          E_SELFCHECK_INVALID,
          `done event rejected: self_check must be an array, got ${typeof sc}. ` +
            `string values like "all_pass" are not accepted.`
        );
      }
      if (sc.length === 0) {
        throw new TreeStateError(
          E_SELFCHECK_INVALID,
          `done event rejected: self_check array is empty (must have at least one item).`
        );
      }
      for (let i = 0; i < sc.length; i++) {
        const it = sc[i];
        if (!it.item || typeof it.item !== 'string') {
          throw new TreeStateError(
            E_SELFCHECK_INVALID,
            `done event rejected: self_check[${i}].item is missing or not a string.`
          );
        }
        if (typeof it.pass !== 'boolean') {
          throw new TreeStateError(
            E_SELFCHECK_INVALID,
            `done event rejected: self_check[${i}].pass must be boolean, got ${typeof it.pass}.`
          );
        }
        if (!it.evidence || typeof it.evidence !== 'string') {
          throw new TreeStateError(
            E_SELFCHECK_INVALID,
            `done event rejected: self_check[${i}].evidence is missing or not a string.`
          );
        }
      }
      // v0.7 批次5 (V6): done 声明"完成"，self_check 不允许全部 pass:false（与 done 语义矛盾）。
      //   允许混合（诚实报部分失败），仅拦"全 false 却 done"——这种情况应改用 'blocked' 事件。
      const anyPass = sc.some((it) => it.pass === true);
      if (!anyPass) {
        throw new TreeStateError(
          E_SELFCHECK_INVALID,
          `done event rejected: self_check has no item with pass=true (all ${sc.length} item(s) failed). done declares completion but self_check reports zero passing — contradiction. Fix the work or use event 'blocked' instead.`
        );
      }
    }

    const ev = { type: opts.type, ts, meta };
    // V10-timestamp-monotonic: ts 必须 ≥ leaf.created_at、≤ now+60s、≥ 上一条 event ts。
    //   spec §三 V10-timestamp-monotonic：堵时间倒挂（攻击者用旧 ts 让 done event 出现在 alignment 之前，
    //   绕过 A7 时序硬约束）。
    //   允许 +60s 时钟漂移（多机/虚拟机时钟跳变），但不能早于 created_at 或上一条 event。
    const tsMs = Date.parse(ts);
    const nowMs = Date.now();
    if (!Number.isFinite(tsMs)) {
      // nowIso 产出的 ts 永远合法；此分支理论上不可达，防御性保留
      throw new TreeStateError(E_SCHEMA_INVALID, `event ts "${ts}" is not a parseable ISO date`);
    }
    if (leaf.created_at) {
      const createdAtMs = Date.parse(leaf.created_at);
      if (Number.isFinite(createdAtMs) && tsMs < createdAtMs) {
        throw new TreeStateError(
          E_TS_BEFORE_CREATED,
          `event append rejected: ts ${ts} earlier than leaf.created_at ${leaf.created_at} (leaf_id="${leaf_id}", type="${opts.type}")`
        );
      }
    }
    if (tsMs > nowMs + 60_000) {
      throw new TreeStateError(
        E_TS_IN_FUTURE,
        `event append rejected: ts ${ts} in future (now=${new Date(nowMs).toISOString()}, +60s tolerance). leaf_id="${leaf_id}", type="${opts.type}"`
      );
    }
    if (leaf.events.length > 0) {
      const lastEvTs = leaf.events[leaf.events.length - 1].ts;
      const lastEvTsMs = Date.parse(lastEvTs);
      // 上一条 ts 可能是老数据 NaN，此时跳过单调校验（不破坏存量）
      if (Number.isFinite(lastEvTsMs) && tsMs < lastEvTsMs) {
        throw new TreeStateError(
          E_TS_NOT_MONOTONIC,
          `event append rejected: ts ${ts} earlier than last event ts ${lastEvTs} (events must be monotonically non-decreasing). leaf_id="${leaf_id}", type="${opts.type}"`
        );
      }
    }

    leaf.events.push(ev);
    leaf.last_event_type = opts.type;
    leaf.last_event_ts = ts;
    // V10-status-event-sync: done event 写入时强制同步 status=done。
    //   spec §三 V10-status-event-sync：堵 status=active 但 last_event=done 不同步。
    //   原代码只更新 last_event_type/ts，status 与 event 可能脱节（攻击者只写 done event 不调 set-status done）。
    if (opts.type === 'done' && leaf.status !== 'done') {
      // 注意：leaf.set-status done 还要校验 milestones/deliverables/audit_gate 等前置条件；
      // 这里只做"event→status 单向同步"，不绕过 cmdLeafSetStatus 的硬约束（status=done 是结果，不是入口）。
      // 风险：worker 通过 done event 直接拿到 status=done 绕过 set-status done 校验。
      // 决策（V10 spec）：done event 自身已有 self_check schema 硬约束（A5），且 cmdAuditGate A7 要求 pass 前先有 done event；
      // 这里同步 status=done 是为了让 collectValidateIssues 能正确检测"status/event 不同步"。
      // 真正的"done 准入"仍由 cmdLeafSetStatus 的 milestones/deliverables 校验把关（worker done 必经此路径）。
      leaf.status = 'done';
    }
    // V10-trust-anchor: root 写 done event 时自动升级 audit_gate='pass'（root 自审）。
    //   原因：root 是信任锚,没有上游 auditor；如果要求 root 先调 audit_gate pass 才能 set-status done,
    //   会陷入"鸡生蛋"——root 永远无法满足"独立 auditor"。方案 §三 子方案 C：root 写 done event 时
    //   cmdEventAppend 自动把 audit_gate.verdict='skip' 升级为 'pass'（auditor=root.session_id,auto_upgrade=true）。
    //   限制：只在 leaf.role==='root' 且 audit_gate.verdict==='skip'（默认值）时触发；
    //   显式 fail/required 状态不被覆盖（避免抹掉真实的审计结果）。
    // V10-trust-anchor-fix (C5/A3 P0 攻击 2): 触发条件加 caller === leaf.session_id。
    //   原条件只看 type==='done' && role==='root',worker 给 root 写 done event 也会触发 auto_upgrade,
    //   一键把 root.audit_gate 从 skip 升级为 pass。修复：必须 callerSessionId === leaf.session_id
    //   （即 root 自己写自己的 done event）才触发；上面已加 caller 校验拒绝 worker 给 root 写 done,
    //   此处再加一道 defense-in-depth,即便 caller 校验被绕过（如新增 caller 不传的路径）也不会触发。
    if (opts.type === 'done' && leaf.role === 'root') {
      const curGate = leaf.audit_gate;
      const callerIsRootSelf = !callerSessionId || callerSessionId === leaf.session_id;
      if ((!curGate || curGate.verdict === 'skip') && callerIsRootSelf) {
        leaf.audit_gate = {
          verdict: 'pass',
          auditor_session_id: leaf.session_id,
          ts: nowIso(),
          auto_upgrade: true  // 标记此 verdict 由 trust-anchor 自动升级，非人工调 audit_gate
        };
      }
    }
    writeState(tree_id, state);
    result = { event: ev };
  });
  return result;
}

// ============================================================
// 命令: drift append
// ============================================================

async function cmdDriftAppend(args) {
  const { positional, opts } = parseArgs(args);
  const [tree_id, leaf_id] = positional;
  assertTreeExists(tree_id);
  if (!leaf_id) throw new TreeStateError(E_SCHEMA_INVALID, 'leaf_id is required');
  if (!opts.kind) throw new TreeStateError(E_SCHEMA_INVALID, '--kind is required');
  if (!opts.severity) throw new TreeStateError(E_SCHEMA_INVALID, '--severity is required');
  if (!opts.action) throw new TreeStateError(E_SCHEMA_INVALID, '--action is required');
  assertEnum(opts.kind, DRIFT_KIND_ENUM, 'drift kind');
  assertEnum(opts.severity, DRIFT_SEVERITY_ENUM, 'drift severity');
  assertEnum(opts.action, DRIFT_ACTION_ENUM, 'drift action');

  const fork_to = opts['fork-to'] || null;
  const reason = opts.reason || '';

  const ts = nowIso();
  let result = null;
  await withLock(tree_id, () => {
    const state = readState(tree_id);
    if (!state.leaves[leaf_id]) {
      throw new TreeStateError(E_LEAF_NOT_FOUND, `leaf "${leaf_id}" not found`);
    }
    // fork_to 校验
    if (fork_to && !Object.prototype.hasOwnProperty.call(state.leaves, fork_to)) {
      throw new TreeStateError(E_LEAF_NOT_FOUND, `--fork-to "${fork_to}" does not exist in leaves`);
    }

    const driftEntry = {
      ts,
      leaf_id,
      kind: opts.kind,
      severity: opts.severity,
      action: opts.action,
      reason
    };
    if (fork_to) driftEntry.fork_to = fork_to;

    // 双写
    const leaf = state.leaves[leaf_id];
    if (!Array.isArray(leaf.drift_history)) leaf.drift_history = [];
    leaf.drift_history.push(driftEntry);
    if (!Array.isArray(state.drift_log)) state.drift_log = [];
    state.drift_log.push(driftEntry);

    writeState(tree_id, state);
    result = { drift: driftEntry };
  });
  return result;
}

// ============================================================
// 命令: heartbeat append
// ============================================================

async function cmdHeartbeatAppend(args) {
  const { positional, opts } = parseArgs(args);
  const [tree_id] = positional;
  assertTreeExists(tree_id);
  if (!opts.json) throw new TreeStateError(E_SCHEMA_INVALID, '--json is required');
  const input = parseJsonArg(opts.json, 'heartbeat json');

  if (!Array.isArray(input.verdicts)) {
    throw new TreeStateError(E_SCHEMA_INVALID, 'heartbeat.verdicts must be an array');
  }
  const ts = input.ts || nowIso();
  const next = input.next_heartbeat || null;

  let result = null;
  await withLock(tree_id, () => {
    const state = readState(tree_id);
    const entry = { ts, verdicts: input.verdicts };
    if (next) entry.next_heartbeat = next;
    if (!Array.isArray(state.heartbeat_log)) state.heartbeat_log = [];
    state.heartbeat_log.push(entry);
    state.last_heartbeat = ts;
    writeState(tree_id, state);
    result = { heartbeat: entry };
  });
  return result;
}

// ============================================================
// 命令: segment append
// ============================================================

async function cmdSegmentAppend(args) {
  const { positional } = parseArgs(args);
  const [tree_id, leaf_id, new_session_id] = positional;
  assertTreeExists(tree_id);
  if (!leaf_id) throw new TreeStateError(E_SCHEMA_INVALID, 'leaf_id is required');
  if (!new_session_id) throw new TreeStateError(E_SCHEMA_INVALID, 'new_session_id is required');

  const ts = nowIso();
  let result = null;
  await withLock(tree_id, () => {
    const state = readState(tree_id);
    if (!state.leaves[leaf_id]) {
      throw new TreeStateError(E_LEAF_NOT_FOUND, `leaf "${leaf_id}" not found`);
    }
    const leaf = state.leaves[leaf_id];

    // session_id 唯一性校验（整个 leaves 中）
    for (const l of Object.values(state.leaves)) {
      if (Array.isArray(l.segment_chain) && l.segment_chain.includes(new_session_id)) {
        throw new TreeStateError(E_SCHEMA_INVALID, `session_id "${new_session_id}" already in segment_chain of leaf "${l.leaf_id}"`);
      }
      if (l.session_id === new_session_id) {
        throw new TreeStateError(E_SCHEMA_INVALID, `session_id "${new_session_id}" already used by leaf "${l.leaf_id}"`);
      }
    }

    if (!Array.isArray(leaf.segment_chain)) leaf.segment_chain = [];
    leaf.segment_chain.push(new_session_id);
    leaf.status = 'segment_pending';

    // drift_history 追加
    const driftEntry = {
      ts,
      leaf_id,
      kind: 'rhythm',
      severity: 'low',
      action: 'handoff',
      to_session: new_session_id,
      reason: 'segment_handoff'
    };
    leaf.drift_history.push(driftEntry);
    if (!Array.isArray(state.drift_log)) state.drift_log = [];
    state.drift_log.push(driftEntry);

    writeState(tree_id, state);
    result = { leaf: { leaf_id, status: leaf.status, segment_chain: leaf.segment_chain } };
  });
  return result;
}

// ============================================================
// 命令: backup / restore
// ============================================================

async function cmdBackup(args) {
  const { positional, opts } = parseArgs(args);
  const [tree_id] = positional;
  assertTreeExists(tree_id);
  const label = opts.label || 'manual';

  let backupName = null;
  await withLock(tree_id, () => {
    backupName = doBackup(tree_id, label);
  });
  return { backup: backupName, backups: listBackups(tree_id).slice(0, BACKUP_KEEP_RECENT).map((b) => b.name) };
}

async function cmdRestore(args) {
  const { positional } = parseArgs(args);
  const [tree_id, backup_file] = positional;
  assertTreeExists(tree_id);
  if (!backup_file) throw new TreeStateError(E_SCHEMA_INVALID, 'backup_file is required');

  // backup_file 可以是 basename（在 tree_dir 内）或绝对路径
  let full = backup_file;
  if (!path.isAbsolute(backup_file)) {
    full = path.join(treeDir(tree_id), backup_file);
  }
  if (!fs.existsSync(full)) {
    throw new TreeStateError(E_BACKUP_CORRUPT, `backup file not found: ${full}`);
  }

  // 先校验备份文件能解析为合法 schema
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (e) {
    throw new TreeStateError(E_BACKUP_CORRUPT, `backup file is not valid JSON: ${e.message}`);
  }
  if (typeof parsed !== 'object' || !parsed || parsed.tree_id !== tree_id) {
    throw new TreeStateError(E_BACKUP_CORRUPT, `backup file schema invalid: tree_id mismatch or not an object`);
  }
  if (typeof parsed.leaves !== 'object' || Array.isArray(parsed.leaves)) {
    throw new TreeStateError(E_BACKUP_CORRUPT, `backup file schema invalid: leaves must be an object`);
  }

  let result = null;
  await withLock(tree_id, () => {
    // 恢复前先做一次安全备份
    doBackup(tree_id, 'before-restore');
    // 用 parsed 覆盖（写原子）
    // writeState 会基于 parsed._meta.write_count 续算；若无则从 0 起
    const state = parsed;
    if (!state._meta || typeof state._meta !== 'object') {
      state._meta = {};
    }
    // 恢复视为新基线：清零计数，下次写从 1 起
    state._meta.write_count = 0;
    // v0.7 批次4 (V1): restore 前置 validate，杜绝 backup→改→restore 伪造 done worker/auditor。
    // state 即 parsed；collectValidateIssues 只读 state.leaves 等，安全。
    const restoreIssues = collectValidateIssues(state);
    if (restoreIssues.length > 0) {
      throw new TreeStateError(E_TREE_NOT_VALIDATED,
        `cannot restore: backup contains ${restoreIssues.length} issue(s). First: ${restoreIssues[0].type} on ${restoreIssues[0].leaf_id || 'tree'}. Refusing to restore non-compliant state.`);
    }
    writeState(tree_id, state);
    result = { restored_from: path.basename(full), tree_id };
  });
  return result;
}

// ============================================================
// 命令: validate
// ============================================================

async function cmdValidate(args) {
  const { positional } = parseArgs(args);
  const [tree_id] = positional;
  assertTreeExists(tree_id);
  const state = readState(tree_id);
  const issues = collectValidateIssues(state);
  return { ok: issues.length === 0, issues, summary: issues.length + ' issue(s)' };
}

// v0.7 批次4 (V2): auditor 独立性白名单校验。
// 返回 problem 字符串(null=通过)。auditor 必须是树中真实存在的、独立的 leaf session。
// 黑名单时代仅排除 null/added_by/root，任意伪造 UUID 即可放行；白名单要求 auditor 真实存在于树。
//
// V10-auditor-active (2026-06-25): 失守案例 audit-gate-test-20260625 — auditor leaf 404c724f
//   在树里真实存在，role 标 worker 但被当成 auditor，4 道旧校验全过（V4-V9 只查"字段存在"）。
//   补 3 重新增校验：auditor leaf status 必须是 done、events 必须非空、自己 audit_gate.verdict 必须是 pass。
//   拒绝"僵尸 auditor"（标 active/events=[]/verdict=skip 但被借身份用）。
// V10-uuid-format-strict: 入口先做严格 UUID v4 校验，拒绝全 0/全 f/非 v4/空/null。
function resolveAuditorIndep(state, leaf, auditorSessionId) {
  // V10-trust-anchor: root leaf 是信任锚，可以自审（self-audit）——root 是 trust chain 的起点,
  //   没有上游 auditor 可用,必须允许 root 自己给自己 audit_gate=pass。
  //   放行条件: leaf.role === 'root' 且 auditorSessionId === leaf.session_id（root 自己显式传）。
  //   失守案例 audit-gate-test-20260625 之后 V10 加固把"auditor 必须独立"作为硬约束,
  //   但 root 是该约束的例外（信任锚）,否则任何树都无法启动（root 永远无法满足"独立 auditor"）。
  // V10-trust-anchor-fix (C5/A3 P0 攻击 1): 删除 `auditorSessionId === null` 放行支。
  //   原放行条件 `(auditorSessionId === null || auditorSessionId === leaf.session_id)` 中 null 这一支
  //   会被 worker 利用：worker 调 audit_gate 不传 audit_session_id（=null）,cmdAuditGate 的
  //   caller 校验 `audit_session_id && callerSessionId && ...` 因 audit_session_id=null 短路跳过,
  //   resolveAuditorIndep 又因 null 放行,root.audit_gate 被 worker 一键改写（包括覆盖 fail 状态）。
  //   修复：root 自审必须显式传 audit_session_id === leaf.session_id,与 cmdAuditGate 的 caller 校验
  //   （caller === audit_session_id）协同,确保只有 caller=root.session_id 才能命中此分支。
  if (leaf.role === 'root' && auditorSessionId === leaf.session_id) {
    return null;  // root 自审放行（必须显式传 root 自己的 session_id,不允许 null）
  }
  if (!auditorSessionId) return 'auditor_session_id is null';
  // V10-uuid-format-strict: 严格 UUID v4（version=4 + variant 位）。
  if (!isValidStrictUuidV4(auditorSessionId)) {
    return `auditor_session_id "${auditorSessionId}" is not a strict UUID v4 (rejected: must be v4, non-empty, non-zero, non-broadcast)`;
  }
  if (leaf.added_by && auditorSessionId === leaf.added_by) return 'auditor=added_by (self-audit forbidden)';
  // Bug B 修复：auditor session → leaf 解析时 fallthrough 逻辑
  //   失守根因：.find() 取第一个匹配，不 fallthrough，当同 session 有多个 leaf 时总是命中第一个。
  //   后果：audit_gate 反复命中同一个 leaf（即使已 pruned），无视同 session 的其他可用 leaf。
  //   修复：.filter() 找所有匹配，过滤掉 pruned/archived，取第一个活跃候选。
  const auditorCandidates = Object.values(state.leaves).filter(l => l.session_id === auditorSessionId);
  if (auditorCandidates.length === 0) {
    return `auditor "${auditorSessionId}" not found as any leaf session in tree (forged UUID)`;
  }
  // 跳过 pruned/archived 候选
  const activeCandidates = auditorCandidates.filter(l => l.status !== 'archived' && l.status !== 'pruned');
  if (activeCandidates.length === 0) {
    return `auditor "${auditorSessionId}" has ${auditorCandidates.length} leaves but all are pruned/archived. No active auditor found.`;
  }
  // 取第一个活跃候选（已过滤掉 pruned/archived）
  const auditorLeaf = activeCandidates[0];
  if (auditorLeaf.leaf_id === leaf.leaf_id) return 'auditor is the leaf itself';
  // V10-auditor-active: auditor leaf 自身状态校验 —— 必须已完成审计工作（done + events 非空 + 自己 audit_gate=pass）。
  //   失守案例中 auditor 404c724f 标 status=active, events=[], audit_gate.verdict='skip'，但接口仍放行。
  if (auditorLeaf.status !== 'done') {
    return `auditor leaf "${auditorLeaf.leaf_id}" status="${auditorLeaf.status}" (must be done; auditor must have completed its own audit work)`;
  }
  if (!Array.isArray(auditorLeaf.events) || auditorLeaf.events.length === 0) {
    return `auditor leaf "${auditorLeaf.leaf_id}" events empty (no audit work performed; auditor must have ≥1 event before endorsing others)`;
  }
  const ag = auditorLeaf.audit_gate;
  if (!ag || ag.verdict !== 'pass') {
    return `auditor leaf "${auditorLeaf.leaf_id}" own audit_gate.verdict="${ag ? ag.verdict : 'undefined'}" (must be pass; auditor cannot endorse others without itself being endorsed)`;
  }
  return null;
}

/**
 * 收集 tree 的所有校验问题（只读 state，不修改）。
 * cmdValidate 与归档前置（A6）复用同一份检查逻辑，避免两处漂移。
 * 包含原有检查 1-8 + HARDEN2(done worker 独立 audit_gate) + HARDEN6(context 溢出)。
 * issues 项格式: { type, leaf_id?, detail }
 */
function collectValidateIssues(state) {
  const issues = [];
  const leaves = state.leaves || {};
  const leafIds = Object.keys(leaves);

  // 检查 1: 所有 leaves 的 parent 引用都能找到
  for (const id of leafIds) {
    const leaf = leaves[id];
    if (leaf.parent !== null && leaf.parent !== undefined) {
      if (!Object.prototype.hasOwnProperty.call(leaves, leaf.parent)) {
        issues.push({
          type: 'parent_missing',
          leaf_id: id,
          detail: `parent "${leaf.parent}" not found in leaves`
        });
      }
    }
  }

  // 检查 2: 所有 drift_history 的 fork_to（如有）指向存在的 leaf
  for (const id of leafIds) {
    const leaf = leaves[id];
    const dh = Array.isArray(leaf.drift_history) ? leaf.drift_history : [];
    for (const d of dh) {
      if (d.fork_to) {
        if (!Object.prototype.hasOwnProperty.call(leaves, d.fork_to)) {
          issues.push({
            type: 'fork_to_missing',
            leaf_id: id,
            detail: `drift_history fork_to "${d.fork_to}" not found in leaves`
          });
        }
      }
    }
  }

  // 检查 3: 所有 segment_chain 中的 session_id 唯一（跨 leaf 不重复，且与 leaf.session_id 不重复）
  const seenSessionIds = new Map(); // session_id -> first seen leaf_id
  for (const id of leafIds) {
    const leaf = leaves[id];
    if (leaf.session_id) {
      if (seenSessionIds.has(leaf.session_id)) {
        issues.push({
          type: 'duplicate_session_id',
          leaf_id: id,
          detail: `session_id "${leaf.session_id}" already used by leaf "${seenSessionIds.get(leaf.session_id)}"`
        });
      } else {
        seenSessionIds.set(leaf.session_id, id);
      }
    }
  }
  for (const id of leafIds) {
    const leaf = leaves[id];
    const chain = Array.isArray(leaf.segment_chain) ? leaf.segment_chain : [];
    for (const sid of chain) {
      if (seenSessionIds.has(sid)) {
        const firstLeaf = seenSessionIds.get(sid);
        if (firstLeaf !== id) {
          issues.push({
            type: 'duplicate_session_id',
            leaf_id: id,
            detail: `segment_chain session_id "${sid}" already claimed by leaf "${firstLeaf}"`
          });
        }
      } else {
        seenSessionIds.set(sid, id);
      }
    }
  }

  // 检查 4: 所有 leaf.path 与 leaf_id 解析出的 path 一致
  for (const id of leafIds) {
    const leaf = leaves[id];
    const parsedPath = parsePathFromLeafId(id);
    if (parsedPath === null) {
      // leaf_id 不符合命名规范
      issues.push({
        type: 'name_invalid',
        leaf_id: id,
        detail: `leaf_id does not match naming spec`
      });
    } else if (parsedPath !== (leaf.path || '')) {
      issues.push({
        type: 'path_mismatch',
        leaf_id: id,
        detail: `leaf.path "${leaf.path}" does not match path segment "${parsedPath}" from leaf_id`
      });
    }
  }

  // 检查 5: milestones.id 在同 leaf 内唯一
  for (const id of leafIds) {
    const leaf = leaves[id];
    const ms = Array.isArray(leaf.milestones) ? leaf.milestones : [];
    const seen = new Set();
    for (const m of ms) {
      if (seen.has(m.id)) {
        issues.push({
          type: 'duplicate_milestone',
          leaf_id: id,
          detail: `milestone.id "${m.id}" duplicated within leaf`
        });
      } else {
        seen.add(m.id);
      }
    }
  }

  // 检查 6 (v0.2.2-修复#1): root session_id 必须是合法 UUID（或 PENDING_ROOT 过渡标记）
  // ROOT_PLACEHOLDER 等非 UUID 占位符 → issue
  for (const id of leafIds) {
    const leaf = leaves[id];
    if (leaf.role === 'root') {
      if (leaf.session_id !== PENDING_ROOT && !UUID_RE.test(leaf.session_id)) {
        issues.push({
          type: 'root_session_not_real',
          leaf_id: id,
          detail: `root session_id "${leaf.session_id}" is not a valid UUID (and not PENDING_ROOT). Root must be a real Agent session. Use 'leaf set-session' to fix.`
        });
      }
    }
  }

  // 检查 7 (v0.2.2-修复#4): 非 root leaf 的 added_by 必须对应树中已存在 leaf
  // 且 added_by 指向的 leaf role ∈ {root, commander}（worker 不能加 leaf）
  for (const id of leafIds) {
    const leaf = leaves[id];
    if (leaf.role === 'root') continue;
    const addedBy = leaf.added_by;
    if (!addedBy) {
      // 注：cmdLeafAdd 已经强制 added_by 非 null，但 migrate 或老数据可能漏
      issues.push({
        type: 'added_by_missing',
        leaf_id: id,
        detail: `non-root leaf is missing added_by field (operator session_id required)`
      });
      continue;
    }
    if (!UUID_RE.test(addedBy)) {
      issues.push({
        type: 'added_by_invalid',
        leaf_id: id,
        detail: `added_by "${addedBy}" is not a valid UUID`
      });
      continue;
    }
    // 找树中是否有 leaf 的 session_id === added_by
    const operatorLeaf = Object.values(leaves).find((l) => l.session_id === addedBy);
    if (!operatorLeaf) {
      issues.push({
        type: 'added_by_not_in_tree',
        leaf_id: id,
        detail: `added_by "${addedBy}" does not match any leaf.session_id in tree (operator must be a tree member)`
      });
    } else if (operatorLeaf.role === 'worker') {
      issues.push({
        type: 'added_by_role_invalid',
        leaf_id: id,
        detail: `added_by "${addedBy}" points to a worker leaf "${operatorLeaf.leaf_id}". Only root/commander can add leaves.`
      });
    }
  }

  // 检查 8 (v0.2.2-修复#5): pending_brief 状态合法性
  // 仅 worker 可以处于 pending_brief；其他角色处于此状态 → issue
  for (const id of leafIds) {
    const leaf = leaves[id];
    if (leaf.status === 'pending_brief' && leaf.role !== 'worker') {
      issues.push({
        type: 'pending_brief_role_invalid',
        leaf_id: id,
        detail: `non-worker leaf in pending_brief status (only workers use pending_brief awaiting brief_echo)`
      });
    }
  }

  // HARDEN2 (加固点#2) + 批次4 (V2) + 批次5 (CP2): 任何 verdict='pass' 的 audit_gate 都必须 auditor 独立。
  // v0.7 批次4 白名单：auditor 必须是树中真实存在的、独立的 leaf session（堵伪造 UUID）。
  // v0.7 批次5 (CP2) 扩展：原仅查 worker+done，攻击者可给 pending_brief/commander 伪造 pass 蒙混（CP2-direct-forge）。
  //   现 verdict=pass 即查独立性（不限 role/status）。verdict=skip/required/fail 不查（零误伤：commander/root 默认 skip）。
  for (const id of leafIds) {
    const leaf = leaves[id];
    const gate = leaf.audit_gate || {};
    if (gate.verdict === 'pass') {
      const auditor = gate.auditor_session_id;
      const problem = resolveAuditorIndep(state, leaf, auditor);
      if (problem) issues.push({ type: 'audit_gate_not_independent', leaf_id: id, detail: `audit_gate(verdict=pass) not independent: ${problem}` });
    }
  }

  // v0.7 批次5 (V5b 兜底): worker done/pass 的 alignment 必须有事件留痕（防 alignment_pending 标志被篡改，审计[1]）
  for (const id of leafIds) {
    const leaf = leaves[id];
    const gate = leaf.audit_gate || {};
    if (leaf.role === 'worker' && (leaf.status === 'done' || gate.verdict === 'pass')) {
      const evs = Array.isArray(leaf.events) ? leaf.events : [];
      const alignmentEcho = evs.find((e) => e && e.type === 'brief_echo' && e.meta && e.meta.alignment !== undefined && e.meta.alignment !== null && e.meta.alignment !== '');
      if (!alignmentEcho) {
        issues.push({ type: 'alignment_not_recorded', leaf_id: id, detail: `worker ${leaf.status === 'done' ? 'done' : 'audit_gate=pass'} but no brief_echo event carries alignment (alignment_pending flag may be tampered)` });
      } else {
        const ap = resolveAuditorIndep(state, leaf, alignmentEcho.meta.auditor_session_id);
        if (ap) issues.push({ type: 'alignment_not_recorded', leaf_id: id, detail: `alignment brief_echo auditor not independent: ${ap}` });
      }
    }
  }

  // HARDEN6 (加固点#6 预留): commander/root context_usage_pct>100 视为卡死/塌缩
  for (const id of leafIds) {
    const leaf = leaves[id];
    if ((leaf.role === 'commander' || leaf.role === 'root') && typeof leaf.context_usage_pct === 'number' && leaf.context_usage_pct > 100) {
      issues.push({ type: 'context_overflow', leaf_id: id, detail: `context_usage_pct=${leaf.context_usage_pct} > 100 (presumed stuck/collapsed)` });
    }
  }

  // v0.7 批次5+ (C4 软警告): milestone.expect_outputs 为空 → validate 报 issue（不拦 add，保"先建后填"灵活；done 时 V3 已拦）
  for (const id of leafIds) {
    const leaf = leaves[id];
    if (Array.isArray(leaf.milestones)) {
      for (const m of leaf.milestones) {
        const outs = Array.isArray(m.expect_outputs) ? m.expect_outputs : [];
        if (outs.length === 0) {
          issues.push({ type: 'milestone_empty_outputs', leaf_id: id, detail: `milestone "${m.id}" has empty expect_outputs (declare deliverables before done; V3 will block done otherwise)` });
        }
      }
    }
  }

  // V10-status-event-sync: status/event 双向一致性校验（reconcileStatus 内联）。
  //   - last_event=done 但 status≠done → issue（cmdEventAppend 应已同步，老数据可能漏）
  //   - status=done 但 events 无 done → issue（cmdLeafSetStatus 应已拦，老数据可能漏）
  //   spec §三 V10-status-event-sync：堵"status=active 但 last_event=done"或反向不一致。
  for (const id of leafIds) {
    const leaf = leaves[id];
    const evs = Array.isArray(leaf.events) ? leaf.events : [];
    const hasDoneEvent = evs.some((e) => e && (e.type === 'done' || e.event_type === 'done'));
    if (hasDoneEvent && leaf.status !== 'done') {
      issues.push({
        type: 'status_event_mismatch',
        leaf_id: id,
        detail: `events[] contains a 'done' event but status="${leaf.status}" (must be done). cmdEventAppend should have synced status; legacy data needs migrate.`
      });
    }
    if (leaf.status === 'done' && !hasDoneEvent) {
      issues.push({
        type: 'status_event_mismatch',
        leaf_id: id,
        detail: `status="done" but no 'done' event in events[] (cmdLeafSetStatus V10 gate should have blocked this; legacy data needs migrate).`
      });
    }
  }

  return issues;
}

// ============================================================
// 参数解析
// ============================================================

/**
 * 解析 CLI 参数。返回 { positional: string[], opts: {key: string} }
 * 支持 --flag value / --flag=value / -n value 三种形式
 */
function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        const key = a.slice(2, eq);
        const val = a.slice(eq + 1);
        opts[key] = val;
      } else {
        const key = a.slice(2);
        // 下一个如果不是 -开头或不存在，作为值；否则视为 boolean flag
        if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
          opts[key] = argv[i + 1];
          i++;
        } else if (i + 1 < argv.length && (argv[i + 1] === 'true' || argv[i + 1] === 'false')) {
          opts[key] = argv[i + 1];
          i++;
        } else {
          opts[key] = 'true';
        }
      }
    } else if (a.startsWith('-') && a.length > 1) {
      // -n value 形式
      const key = a.slice(1);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        opts[key] = argv[i + 1];
        i++;
      } else {
        opts[key] = 'true';
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, opts };
}

// ============================================================
// 工具: Commander 深度计算
// ============================================================

/**
 * 沿 parent 链向上追溯，统计 role 为 root/commander 的节点数（含 parent 自身）
 * 用于 leaf add 时判断是否超过三层 Commander 深度限制
 */
function calcCommanderDepth(state, parent_leaf_id) {
  let depth = 0;
  let currentId = parent_leaf_id;
  while (currentId) {
    const leaf = state.leaves[currentId];
    if (!leaf) break;
    if (leaf.role === 'root' || leaf.role === 'commander') {
      depth++;
    }
    currentId = leaf.parent;
  }
  return depth;
}

// ============================================================
// 命令: audit-gate (v0.2.2 TAO) — 天道审计门
// 控制_leaf 是否可通过 set-status done
// verdict ∈ {required, pass, fail, skip}
// ============================================================

async function cmdAuditGate(args, callerSessionId) {
  // audit-gate <tree_id> <leaf_id> --verdict <required|pass|fail|skip>
  //          [--audit-session-id <uuid>] [--reason <text>]
  // V10-self-audit-forbidden-v2: 新增 callerSessionId 形参 —— MCP wrapper 透传调用方 session_id，
  //   校验 caller 必须等于 audit_session_id（堵 worker 528b0925 借 auditor 404c724f 的 session_id 调接口）。
  const { positional, opts } = parseArgs(args);
  const [tree_id, leaf_id] = positional;
  assertTreeExists(tree_id);
  if (!leaf_id) throw new TreeStateError(E_SCHEMA_INVALID, 'leaf_id is required');
  if (!opts.verdict) throw new TreeStateError(E_SCHEMA_INVALID, '--verdict is required (required|pass|fail|skip)');
  const verdict = opts.verdict;
  if (!['required', 'pass', 'fail', 'skip'].includes(verdict)) {
    throw new TreeStateError(E_SCHEMA_INVALID, `verdict "${verdict}" not in [required, pass, fail, skip]`);
  }
  const audit_session_id = opts['audit-session-id'] || null;
  // V10-uuid-format-strict: 升级 UUID 校验为严格 v4（拒绝全 0/全 f/非 v4/空）。
  //   旧 UUID_RE 允许 v1-v5 任意版本，且不查全 0/全 f 占位符。
  if (audit_session_id && !isValidStrictUuidV4(audit_session_id)) {
    throw new TreeStateError(E_INVALID_UUID_STRICT, `--audit-session-id "${audit_session_id}" is not a strict UUID v4 (must be version 4, non-zero, non-broadcast)`);
  }

  // V10-self-audit-forbidden-v2: 调用方 session_id 必须等于 audit_session_id（防借身份）。
  //   失守案例: worker 528b0925 拿 auditor 404c724f 的 session_id 调 mcp__tree__tree_audit_gate，
  //   引擎层完全无感知（cmdAuditGate 不知道 caller 是谁），4 道 V4-V9 校验全过。
  //   修复：MCP wrapper 从 __proma_getMcpServers__(sessionId, ...) 提取 sessionId，透传给 engine。
  //   CLI 调用（dbc-spec 等）不传 caller，跳过此校验（向后兼容）。
  //
  // V10-trust-anchor: root leaf 自审例外。root 调 audit_gate 时 audit_session_id=root.session_id，
  //   caller 也是 root.session_id，自然满足 caller===audit_session_id（原校验放行）。
  //   leaf.role==='root' 的"自审 vs 借身份"区分由 withLock 内 resolveAuditorIndep 的 root 分支兜底（root 放行）。
  //   worker 借 root session_id 调用时，caller=worker.session_id ≠ audit_session_id=root.session_id，仍被此校验拦。
  if (audit_session_id && callerSessionId && audit_session_id !== callerSessionId) {
    throw new TreeStateError(
      E_BORROWED_IDENTITY,
      `audit-gate rejected: caller "${callerSessionId}" != audit_session_id "${audit_session_id}" (borrowed identity forbidden; caller must be the auditor itself)`
    );
  }

  let result = null;
  await withLock(tree_id, () => {
    const state = readState(tree_id);
    if (!state.leaves[leaf_id]) {
      throw new TreeStateError(E_LEAF_NOT_FOUND, `leaf "${leaf_id}" not found`);
    }
    const leaf = state.leaves[leaf_id];
    const from = leaf.audit_gate || { verdict: null, auditor_session_id: null, ts: null };

    // v0.7 Phase A (A2) + 批次4 (V2): auditor 独立性硬约束 — pass/required 时审计者必须独立于被审计者
    // v0.7 批次4 升级为白名单：auditor 必须是树中真实存在的、独立的 leaf session。
    // 旧黑名单(null/added_by/root)可被任意伪造 UUID 绕过；现要求 auditor 真实存在于树。
    if (verdict === 'pass' || verdict === 'required') {
      const indepProblem = resolveAuditorIndep(state, leaf, audit_session_id);
      if (indepProblem) {
        throw new TreeStateError(
          E_AUDITOR_NOT_INDEPENDENT,
          `audit-gate rejected: auditor "${audit_session_id}" not independent for leaf "${leaf_id}" (verdict=${verdict}): ${indepProblem}. Audit must be performed by an independent session that exists in the tree.`
        );
      }
    }

    // v0.7 Phase A (A7): audit 时序硬约束 — pass 时被审计 leaf 必须已有更早的 done 事件
    // 审计发生在工作完成之后，杜绝"未完工即审计通过"
    if (verdict === 'pass') {
      const evs = Array.isArray(leaf.events) ? leaf.events : [];
      const doneEvent = evs.find((e) => e && e.type === 'done');
      if (!doneEvent) {
        throw new TreeStateError(
          E_AUDIT_PREMATURE,
          `audit-gate rejected: no done event found for leaf "${leaf_id}". Audit must occur after work is completed.`
        );
      }
      // Bug A 修复：验证 done event 的写入者身份
      //   失守根因：原 hasDone 只检查存在性，不检查 caller_session_id，导致 commander 代写的 done 也能通过审计。
      //   修复：检查 done event.meta.caller_session_id 是否等于 leaf.session_id（leaf 自己写的才算）。
      const callerOfDone = doneEvent.meta && doneEvent.meta.caller_session_id;
      if (callerOfDone && callerOfDone !== leaf.session_id) {
        throw new TreeStateError(
          E_BORROWED_IDENTITY,
          `audit-gate rejected: leaf "${leaf_id}" done event was written by "${callerOfDone}", not by leaf itself (session=${leaf.session_id}). Commander cannot declare worker done on behalf.`
        );
      }
      // v0.7 批次5 (V5b): worker 的 audit pass 前必须有 alignment 事件留痕。
      //   查 events（权威）而非 alignment_pending 布尔标志——后者可被 tamperLeaf 直接篡改绕过（审计[1]）。
      //   非 worker（commander/root）不走此门。冒用树中真实独立 leaf session 是 Layer4 残留（同 CP2）。
      if (leaf.role === 'worker') {
        const alignmentEvs = Array.isArray(leaf.events)
          ? leaf.events.filter((e) => e && e.type === 'brief_echo' && e.meta && e.meta.alignment !== undefined && e.meta.alignment !== null && e.meta.alignment !== '')
          : [];
        if (alignmentEvs.length === 0) {
          throw new TreeStateError(
            E_ALIGNMENT_NOT_VERIFIED,
            `audit-gate rejected: worker "${leaf_id}" has no brief_echo event carrying alignment. Independent alignment assessment must be recorded (brief_echo with alignment + auditor_session_id) before audit pass.`
          );
        }
        const lastAlign = alignmentEvs[alignmentEvs.length - 1];
        const alignProblem = resolveAuditorIndep(state, leaf, lastAlign.meta.auditor_session_id);
        if (alignProblem) {
          throw new TreeStateError(
            E_ALIGNMENT_NOT_VERIFIED,
            `audit-gate rejected: alignment brief_echo auditor not independent for worker "${leaf_id}": ${alignProblem}.`
          );
        }
      }
    }

    leaf.audit_gate = {
      verdict,
      auditor_session_id: audit_session_id,
      ts: nowIso()
    };
    writeState(tree_id, state);
    result = { leaf: { leaf_id, audit_gate: leaf.audit_gate, from } };
  });
  return result;
}

// ============================================================
// 命令: audit append (v0.2.2 TAO) — 审计结果落盘
// ============================================================

async function cmdAuditAppend(args) {
  // audit append <tree_id> <leaf_id> --json '<audit_log_entry>'
  const { positional, opts } = parseArgs(args);
  const [tree_id, leaf_id] = positional;
  assertTreeExists(tree_id);
  if (!leaf_id) throw new TreeStateError(E_SCHEMA_INVALID, 'leaf_id is required');
  if (!opts.json) throw new TreeStateError(E_SCHEMA_INVALID, '--json is required');
  const entry = parseJsonArg(opts.json, 'audit log entry');

  // 必填字段
  const required = ['auditor_session_id', 'total', 'passed', 'failed', 'results'];
  for (const k of required) {
    if (!(k in entry)) {
      throw new TreeStateError(E_SCHEMA_INVALID, `audit log entry missing field "${k}"`);
    }
  }

  // V10-uuid-format-strict: audit_append 路径前置校验 auditor_session_id 必须是严格 UUID v4（拒全 0/全 f/空/null/非 UUID 字符串）。
  //   C1 只在 audit_gate 路径（resolveAuditorIndep 入口）加了严格校验，audit_append 路径完全漏掉，导致
  //   Cr 洁净室发现 7/7 UUID 攻击全放行（空串、null、'not-uuid'、伪造合法 UUID、self session、全 f、全 0）。
  //   spec §三 V10-uuid-format-strict + V10-numeric-consistency 中 cmdAuditAppend 应包含此校验。
  if (!isValidStrictUuidV4(entry.auditor_session_id)) {
    throw new TreeStateError(E_INVALID_UUID_STRICT,
      `audit_append rejected: auditor_session_id "${entry.auditor_session_id}" not strict UUID v4 (must be v4, non-empty, non-zero, non-broadcast)`);
  }

  // M2: total/passed/failed 必须是整数（spec §18.3）
  for (const k of ['total', 'passed', 'failed']) {
    if (typeof entry[k] !== 'number' || !Number.isInteger(entry[k])) {
      throw new TreeStateError(E_SCHEMA_INVALID, `audit log entry "${k}" must be integer`);
    }
  }

  // V10-numeric-consistency: total>=0 + passed+failed=total + results.length=total + results[i] 三元组。
  //   spec §三 V10-numeric-consistency：把"字段存在性"升级为"数值一致性"，
  //   拒绝 total=-1 / p+f≠total / results.length≠total 等数值矛盾。
  //   results[i] 子结构（item/pass/evidence）原 R2-T7 已校验，本块额外强化错误码区分。
  const { total, passed, failed, results } = entry;
  if (!Number.isInteger(total) || total < 0) {
    throw new TreeStateError(E_NEGATIVE_COUNT,
      `audit log entry "total"=${total} must be a non-negative integer`);
  }
  if (!Number.isInteger(passed) || passed < 0) {
    throw new TreeStateError(E_NEGATIVE_COUNT,
      `audit log entry "passed"=${passed} must be a non-negative integer`);
  }
  if (!Number.isInteger(failed) || failed < 0) {
    throw new TreeStateError(E_NEGATIVE_COUNT,
      `audit log entry "failed"=${failed} must be a non-negative integer`);
  }
  if (passed + failed !== total) {
    throw new TreeStateError(E_COUNT_MISMATCH,
      `audit log entry numeric mismatch: passed(${passed}) + failed(${failed}) != total(${total})`);
  }

  // R2-T7: results[i] 必须是 {item:string, pass:boolean, evidence:string} 三元组（spec §18.3）
  if (!Array.isArray(entry.results)) {
    throw new TreeStateError(E_SCHEMA_INVALID, 'audit log entry "results" must be array');
  }
  // V10-numeric-consistency: results.length === total
  if (results.length !== total) {
    throw new TreeStateError(E_LENGTH_MISMATCH,
      `audit log entry "results".length(${results.length}) != total(${total}); every audited item must have a result entry`);
  }
  for (let i = 0; i < entry.results.length; i++) {
    const r = entry.results[i];
    if (!r || typeof r !== 'object' || Array.isArray(r)) {
      throw new TreeStateError(E_SCHEMA_INVALID, `audit log entry results[${i}] must be object`);
    }
    if (typeof r.item !== 'string' ||
        typeof r.pass !== 'boolean' ||
        typeof r.evidence !== 'string') {
      throw new TreeStateError(E_SCHEMA_INVALID,
        `audit log entry results[${i}] must have {item:string, pass:boolean, evidence:string}`);
    }
  }

  let result = null;
  await withLock(tree_id, () => {
    const state = readState(tree_id);
    if (!state.leaves[leaf_id]) {
      throw new TreeStateError(E_LEAF_NOT_FOUND, `leaf "${leaf_id}" not found`);
    }
    const leaf = state.leaves[leaf_id];

    // V10-uuid-format-strict + V10-auditor-active (audit_append 路径): 校验 auditor_session_id 不仅格式合法，
    //   还必须指向树中真实存在且独立的 leaf。轻量校验（存在 + 非自审），跳过 V10-auditor-active 的
    //   status/events/verdict 三重校验 —— audit_append 是"审计证据落盘"，不要求 auditor 自身已完成审计工作
    //   （audit_gate 才是"放行门"，那里仍走完整的 resolveAuditorIndep 含 status/events/verdict）。
    //   Cr 测试 7 种 UUID 攻击（空串/null/not-uuid/伪造合法 UUID/self session/全 f/全 0）全部在前置 strict 校验拦截，
    //   再用此块兜底"伪造合法 UUID（不在树）"和"self session"。
    //   注：若用完整 resolveAuditorIndep 会破坏金标准 dbc-spec R2T7-e / M2-d / v10-regression 合法数值放行（其 auditor
    //   是占位 UUID，对应 zombie leaf）—— audit_append 不应受 auditor-active 限制。
    const auditorLeaf = Object.values(state.leaves).find(l => l.session_id === entry.auditor_session_id);
    if (!auditorLeaf) {
      throw new TreeStateError(E_AUDITOR_NOT_INDEPENDENT,
        `audit_append rejected: auditor_session_id "${entry.auditor_session_id}" not found as any leaf session in tree (forged UUID)`);
    }
    if (auditorLeaf.leaf_id === leaf.leaf_id) {
      throw new TreeStateError(E_AUDITOR_NOT_INDEPENDENT,
        `audit_append rejected: auditor_session_id "${entry.auditor_session_id}" is the target leaf itself (self-audit forbidden)`);
    }

    if (!Array.isArray(leaf.audit_log)) leaf.audit_log = [];
    const logEntry = Object.assign({ ts: nowIso() }, entry);
    leaf.audit_log.push(logEntry);
    writeState(tree_id, state);
    result = { leaf_id, audit_log_entry: logEntry, audit_log_count: leaf.audit_log.length };
  });
  return result;
}

// ============================================================
// 命令: nudge append / reset (v0.2.2 TAO) — 鞭策记录
// ============================================================

async function cmdNudgeAppend(args) {
  // nudge append <tree_id> <leaf_id> --rule-id <id> [--severity <low|mid|high>]
  // V10-nudge-escalation: nudge_count 阈值升级 —— 3→medium, 5→high, 7→强制 pruned。
  //   spec §三 V10-nudge-escalation：把"nudge_count 累加但不升级"升级为"强制升级 + 7 次自动 prune"。
  //   失守案例：失忆 leaf 被反复 nudge 168 次仍 active（spec 失守点#5）。
  const { positional, opts } = parseArgs(args);
  const [tree_id, leaf_id] = positional;
  assertTreeExists(tree_id);
  if (!leaf_id) throw new TreeStateError(E_SCHEMA_INVALID, 'leaf_id is required');
  if (!opts['rule-id']) throw new TreeStateError(E_SCHEMA_INVALID, '--rule-id is required');
  const severity = opts.severity || 'low';
  if (!['low', 'mid', 'high'].includes(severity)) {
    throw new TreeStateError(E_SCHEMA_INVALID, `severity "${severity}" not in [low, mid, high]`);
  }

  let result = null;
  await withLock(tree_id, () => {
    const state = readState(tree_id);
    if (!state.leaves[leaf_id]) {
      throw new TreeStateError(E_LEAF_NOT_FOUND, `leaf "${leaf_id}" not found`);
    }
    const leaf = state.leaves[leaf_id];
    if (typeof leaf.nudge_count !== 'number') leaf.nudge_count = 0;
    if (!Array.isArray(leaf.nudge_log)) leaf.nudge_log = [];
    leaf.nudge_count += 1;

    // V10-nudge-escalation: 强制升级 severity（nudge_count≥3 → medium，≥5 → high）
    //   spec §三 V10-nudge-escalation 字面要求升级到 'medium'（与 drift severity 'mid' 区分；
    //   nudge_log.severity 是 nudge 独有字段，不与 DRIFT_SEVERITY_ENUM 复用）。
    let effectiveSeverity = severity;
    if (leaf.nudge_count >= 5) {
      effectiveSeverity = 'high';
    } else if (leaf.nudge_count >= 3) {
      // low → medium；mid/high 不降级（保留调用方原意）
      if (severity === 'low') effectiveSeverity = 'medium';
    }

    const entry = { ts: nowIso(), rule_id: opts['rule-id'], severity: effectiveSeverity, nudge_count: leaf.nudge_count };
    leaf.nudge_log.push(entry);

    // V10-nudge-escalation: nudge_count >= 7 强制 pruned（拒绝继续 nudge）
    if (leaf.nudge_count >= 7) {
      leaf.status = 'pruned';
      const pruneEntry = {
        ts: nowIso(),
        rule_id: opts['rule-id'],
        severity: 'high',
        nudge_count: leaf.nudge_count,
        auto_pruned: true,
        reason: `auto-pruned after ${leaf.nudge_count} nudges (V10-nudge-escalation)`
      };
      leaf.nudge_log.push(pruneEntry);
      // 同步 drift_history（与 cmdLeafSetStatus 切 pruned 保持一致）
      if (!Array.isArray(leaf.drift_history)) leaf.drift_history = [];
      const driftEntry = {
        ts: nowIso(),
        kind: 'rhythm',
        severity: 'high',
        action: 'prune',
        reason: `auto-pruned after ${leaf.nudge_count} nudges (V10-nudge-escalation)`,
        leaf_id,
        from: leaf.status, // 已是 pruned，但保留语义
        to: 'pruned'
      };
      leaf.drift_history.push(driftEntry);
      if (Array.isArray(state.drift_log)) state.drift_log.push(driftEntry);
      writeState(tree_id, state);
      // 抛错让调用方知道 leaf 已 prune（仍 writeState 落盘后再抛，保证状态不丢）
      throw new TreeStateError(
        E_LEAF_AUTO_PRUNED,
        `leaf "${leaf_id}" auto-pruned after ${leaf.nudge_count} nudges (V10-nudge-escalation: 7-strike rule)`
      );
    }

    writeState(tree_id, state);
    result = { leaf_id, nudge_count: leaf.nudge_count, nudge_log_entry: entry };
  });
  return result;
}

async function cmdNudgeReset(args) {
  // nudge reset <tree_id> <leaf_id>
  const { positional } = parseArgs(args);
  const [tree_id, leaf_id] = positional;
  assertTreeExists(tree_id);
  if (!leaf_id) throw new TreeStateError(E_SCHEMA_INVALID, 'leaf_id is required');

  let result = null;
  await withLock(tree_id, () => {
    const state = readState(tree_id);
    if (!state.leaves[leaf_id]) {
      throw new TreeStateError(E_LEAF_NOT_FOUND, `leaf "${leaf_id}" not found`);
    }
    const leaf = state.leaves[leaf_id];
    const from_count = leaf.nudge_count || 0;
    leaf.nudge_count = 0;
    leaf.nudge_log = [];
    writeState(tree_id, state);
    result = { leaf_id, nudge_count: 0, from_count };
  });
  return result;
}

async function dispatchAudit(args, callerSessionId) {
  if (args.length === 0) {
    throw new TreeStateError(E_SCHEMA_INVALID, 'audit requires a subcommand: gate | append');
  }
  const [sub, ...rest] = args;
  switch (sub) {
    // V10-self-audit-forbidden-v2: 仅 'gate' 需要 callerSessionId（堵借身份）
    case 'gate': return await cmdAuditGate(rest, callerSessionId);
    case 'append': return await cmdAuditAppend(rest);
    default:
      throw new TreeStateError(E_UNKNOWN, `unknown audit subcommand "${sub}"`);
  }
}

async function dispatchNudge(args) {
  if (args.length === 0) {
    throw new TreeStateError(E_SCHEMA_INVALID, 'nudge requires a subcommand: append | reset');
  }
  const [sub, ...rest] = args;
  switch (sub) {
    case 'append': return await cmdNudgeAppend(rest);
    case 'reset': return await cmdNudgeReset(rest);
    default:
      throw new TreeStateError(E_UNKNOWN, `unknown nudge subcommand "${sub}"`);
  }
}

// ============================================================
// 命令: migrate（数据迁移）
// ============================================================

// 旧 role → 新 role 映射表（覆盖生产环境全部自由文本 role）
// 不在 ROLE_ENUM 中的值统一映射为 worker
const ROLE_MIGRATION_MAP = {
  announce: 'worker',
  attack: 'worker',
  completeness: 'worker',
  consistency: 'worker',
  counterfactual: 'worker',
  draft: 'worker',
  engine: 'worker',
  eval: 'worker',
  evidence: 'worker',
  fixer: 'worker',
  integrate: 'worker',
  polish: 'worker',
  r1: 'worker',
  r2: 'worker',
  'regression-attack': 'worker',
  'regression-evidence': 'worker',
  report: 'worker',
  'reverse-map': 'worker',
  reversemap: 'worker',
  revmap: 'worker',
  review: 'worker',
  standards: 'worker',
  techdetail: 'worker',
  test: 'worker',
  verify: 'worker',
  walkthrough: 'worker',
  walkthru: 'worker',
};

async function cmdMigrate(args) {
  // migrate <tree_id> [--dry-run]
  const { positional, opts } = parseArgs(args);
  const tree_id = positional[0];
  assertTreeExists(tree_id);
  const dryRun = opts['dry-run'] === 'true' || opts['dry-run'] === true;

  let result = null;
  await withLock(tree_id, () => {
    const state = readState(tree_id);
    const changes = [];
    const leaves = state.leaves || {};

    for (const id of Object.keys(leaves)) {
      const leaf = leaves[id];
      const oldRole = leaf.role;

      // 规则 1: 旧自由文本 role → 映射为新枚举
      if (ROLE_MIGRATION_MAP[oldRole]) {
        changes.push({ leaf_id: id, field: 'role', from: oldRole, to: ROLE_MIGRATION_MAP[oldRole] });
        if (!dryRun) leaf.role = ROLE_MIGRATION_MAP[oldRole];
      } else if (leaf.parent === null && leaf.role !== 'root' && leaf.role !== 'commander') {
        // 规则 2: parent=null 的非 root/commander → worker（未匹配规则 1 的兜底）
        changes.push({ leaf_id: id, field: 'role', from: leaf.role, to: 'worker', reason: 'parent=null non-root/commander → worker' });
        if (!dryRun) leaf.role = 'worker';
      }

      // 规则 3: 补全缺失的 added_by（标记为 migrated）
      if (leaf.added_by === undefined) {
        changes.push({ leaf_id: id, field: 'added_by', from: undefined, to: null });
        if (!dryRun) leaf.added_by = null;
      }
    }

    // 规则 4（第二轮）: worker 有子节点 → 提升为 commander（深度允许时）
    // 必须先跑完规则 1-3 统一 role，再检查父子关系
    for (const id of Object.keys(leaves)) {
      const leaf = leaves[id];
      if (leaf.role !== 'worker') continue;

      const childIds = Object.keys(leaves).filter(
        (lid) => leaves[lid].parent === id
      );
      if (childIds.length === 0) continue;

      // worker 有子节点：计算深度，允许则提升为 commander
      const depth = calcCommanderDepth(state, id);
      if (depth < 3) {
        changes.push({
          leaf_id: id,
          field: 'role',
          from: 'worker',
          to: 'commander',
          reason: `has ${childIds.length} child(ren): ${childIds.join(', ')}. Depth ${depth} < 2, promoted to commander.`
        });
        if (!dryRun) leaf.role = 'commander';
      } else {
        changes.push({
          leaf_id: id,
          field: 'role',
          from: 'worker',
          to: 'worker',
          reason: `HAS_CHILDREN_BUT_DEPTH_${depth}: has ${childIds.length} child(ren) but commander depth >= 2. Cannot promote. Manual resolution required.`
        });
      }
    }

    // 规则 5 (v0.2.2): 补全 TAO 字段（audit_gate / nudge_count / nudge_log / audit_log）
    for (const id of Object.keys(leaves)) {
      const leaf = leaves[id];
      if (!leaf.audit_gate) {
        const verdict = leaf.role === 'worker' ? 'required' : 'skip';
        changes.push({ leaf_id: id, field: 'audit_gate', from: null, to: { verdict, auditor_session_id: null, ts: null } });
        if (!dryRun) leaf.audit_gate = { verdict, auditor_session_id: null, ts: null };
      }
      if (leaf.nudge_count === undefined) {
        if (!dryRun) leaf.nudge_count = 0;
        changes.push({ leaf_id: id, field: 'nudge_count', from: undefined, to: 0 });
      }
      if (!Array.isArray(leaf.nudge_log)) {
        if (!dryRun) leaf.nudge_log = [];
        changes.push({ leaf_id: id, field: 'nudge_log', from: null, to: [] });
      }
      if (!Array.isArray(leaf.audit_log)) {
        if (!dryRun) leaf.audit_log = [];
        changes.push({ leaf_id: id, field: 'audit_log', from: null, to: [] });
      }
    }

    // 规则 6 (v0.2.2): 历史 worker 的 status=active → 若无 brief_echo event，回退为 pending_brief
    // 已经 done 的 worker 不动；rule 5 已经把 audit_gate 设为 required
    for (const id of Object.keys(leaves)) {
      const leaf = leaves[id];
      if (leaf.role !== 'worker') continue;
      if (leaf.status !== 'active') continue;
      const hasBriefEcho = Array.isArray(leaf.events) && leaf.events.some(
        (e) => e && (e.type === 'brief_echo' || e.event_type === 'brief_echo')
      );
      if (!hasBriefEcho) {
        changes.push({ leaf_id: id, field: 'status', from: 'active', to: 'pending_brief', reason: 'v0.2.2: worker without brief_echo event' });
        if (!dryRun) leaf.status = 'pending_brief';
      }
    }

    // 规则 7 (v0.2.2): 回填 added_by — 若 root 有合法 UUID session_id，
    // 把历史 null added_by 全部回填为 root.session_id（视为根操作者创建）
    const rootLeaf = Object.values(leaves).find((l) => l.role === 'root');
    if (rootLeaf && UUID_RE.test(rootLeaf.session_id)) {
      for (const id of Object.keys(leaves)) {
        const leaf = leaves[id];
        if (leaf.role === 'root') continue;
        if (!leaf.added_by) {
          changes.push({ leaf_id: id, field: 'added_by', from: null, to: rootLeaf.session_id, reason: 'v0.2.2 backfill from root.session_id' });
          if (!dryRun) leaf.added_by = rootLeaf.session_id;
        }
      }
    }

    // 规则 8 (v0.2.2): 补 _meta.workspace_root（init 自动写的字段，历史数据没有）
    if (!state._meta) state._meta = {};
    if (!state._meta.workspace_root) {
      const workspace_root = path.resolve(TREES_ROOT, '..', '..');
      changes.push({ field: '_meta.workspace_root', from: null, to: workspace_root });
      if (!dryRun) state._meta.workspace_root = workspace_root;
    }

    // 规则 9 (v0.2.2): ROOT_PLACEHOLDER → PENDING_ROOT（技术报告 #1 修复）
    // 老数据用了 ROOT_PLACEHOLDER 作为占位符，v0.2.2 统一为 PENDING_ROOT（合法过渡标记）
    for (const id of Object.keys(leaves)) {
      const leaf = leaves[id];
      if (leaf.role === 'root' && leaf.session_id === 'ROOT_PLACEHOLDER') {
        changes.push({ leaf_id: id, field: 'session_id', from: 'ROOT_PLACEHOLDER', to: PENDING_ROOT, reason: 'v0.2.2 unified placeholder' });
        if (!dryRun) leaf.session_id = PENDING_ROOT;
      }
    }

    // 规则 10 (v0.2.2): 多 parent=null leaf 检测（警告，不自动修复）
    const nullParentLeaves = Object.values(leaves).filter((l) => l.parent === null);
    if (nullParentLeaves.length > 1) {
      changes.push({
        field: '_warning',
        reason: `MULTIPLE_NULL_PARENT: ${nullParentLeaves.length} leaves have parent=null (root uniqueness violated). Manual resolution required. Leaves: ${nullParentLeaves.map((l) => l.leaf_id).join(', ')}`
      });
    }

    if (!dryRun) {
      writeState(tree_id, state);
    }

    result = {
      tree_id,
      dry_run: dryRun,
      migrated: changes.length,
      changes
    };
  });
  return result;
}

// ============================================================
// 命令: help (V10-helper D4 Layer 1)
// mcp__tree__tree_help(topic) — Agent 主动问"工具怎么用"。
// 13 个 topic 覆盖：建树 / auditor 注册 / 角色 / V10 加固 / 借身份攻击 / 命名 /
//                  常见错误 / alignment / nudge / 审计树结构 / 错误码索引 / 全文指南。
// 设计原则：渐进披露（默认简洁）+ 错误即教育（错误返回附 help_topic）。
// ============================================================

const HELP_TOPICS = {
  how_to_init: {
    title: '建树最佳实践',
    related: ['naming_convention', 'role_semantics', 'v10_constraints'],
    content: `# how_to_init — 建树最佳实践

## 调用签名
mcp__tree__tree_init(tree_id, root_brief, root_dod, session_id?, model?, channel?, audit_meta?)

## tree_id 命名
- 小写字母开头 + 项目语义（4-8 字符推荐）：\`v10v\` / \`nanju\` / \`sweng\`
- 不可含连字符（leaf_id 的 prefix 段规则）

## root_brief 5 字段（必填）
parent_intent / my_mission / why_this_exists / in_scope[] / out_of_scope[]

## root_dod 4 字段（必填）
deliverables[{path,min_length?,must_contain?}] / quality_gates[] / self_check[] / node_budget?

## root leaf
- 自动创建 <tree_id>-root，role=root，status=active
- session_id 优先级：--session-id → PROMA_SESSION_ID → PENDING_ROOT（过渡标记，后续 leaf set-session 修正）
- 建议直接传 --session-id 用根会话真实 session_id（mcp__session__get_my_session_id 拿）

## 常见 init 失败
- E_DUPLICATE_LEAF: tree 已存在 → 用 validate 校验现有
- E_SCHEMA_INVALID: root_brief/root_dod 不是合法 JSON
- E_SCHEMA_INVALID: node_budget 不是非负有限数

## 关联
- mcp__tree__tree_help('how_to_register_auditor') — 建树后第一件事
- mcp__tree__tree_help('common_mistakes') — 65996e8b 教训`,
  },

  how_to_register_auditor: {
    title: 'auditor 注册流程（解决鸡生蛋）',
    related: ['self_audit_forbidden', 'borrowed_identity', 'v10_constraints'],
    content: `# how_to_register_auditor — auditor 注册流程

## 问题（V4-V9 鸡生蛋）
auditor 必须先 audit_gate pass 才能给 worker 背书 → 但 auditor 自己也要被更高级 auditor 审过才能 pass → 无穷递归。

## 解决方案 A（V10-trust-anchor，C3 实施中）
root 是信任锚点（trust anchor），允许自审：
1. tree_init 后 root 自审 → root.audit_gate.verdict = 'pass'（root 特权）
2. commander fork 真实 session 当 auditor
3. auditor 在自己 session 内调 audit_gate(leaf_id=root, verdict=pass, audit_session_id=<auditor 自己>)
4. auditor 给 worker 背书：audit_gate(leaf_id=worker, verdict=pass, audit_session_id=<auditor 自己>)

## 解决方案 B（V10 当前版本，root 不能自审）
通过【根会话外的独立 session】注册 auditor：
1. commander 在自己 session 内用 mcp__session__fork_session 派一个 auditor session
2. commander send_message(auditor_session, "审计 leaf X")
3. auditor 在自己 session 内调 audit_gate(leaf_id=X, verdict=pass, audit_session_id=<auditor 自己 session>)
4. 引擎校验 callerSessionId（MCP wrapper 自动注入）=== audit_session_id → 通过

## auditor 三重校验（V10-auditor-active）
auditor leaf 必须：
- status === 'done'
- events 非空（至少发过一条上行事件）
- audit_gate.verdict === 'pass'（被更高权威背书过，或 root 特权）
缺任一 → E_AUDITOR_NOT_DONE / E_AUDITOR_NO_EVENTS / E_AUDITOR_NOT_VERIFIED

## 关键约束
- callerSessionId 必须 === audit_session_id（堵借身份，详见 self_audit_forbidden）
- audit_session_id 必须是合法 UUID（V10-uuid-format-strict）
- 不要用占位 UUID（00000000-... 等），用真实 fork_session 拿到的 session_id`,
  },

  role_semantics: {
    title: 'root/commander/worker/auditor 角色语义',
    related: ['how_to_init', 'audit_tree_structure'],
    content: `# role_semantics — 角色语义

## 4 种角色
- **root**: 树根，唯一，无 parent。tree_init 自动创建。root 是 trust anchor（V10-trust-anchor 提案）。
- **commander**: 中间指挥官，可有子节点。深度上限 3 层。
- **worker**: 原子执行者，**不能有子节点**（引擎硬约束）。
- **auditor**: 不是一个独立 role 字段！auditor 是某个 leaf 的"职责"，由 audit_gate 的 audit_session_id 指向另一个 leaf 的 session_id 实现。

## 谁能 fork 谁
- root fork commander
- commander fork worker 或子 commander
- worker 不能 fork（叶子节点）

## 谁能审谁
- 审计关系通过 audit_gate(verdict, audit_session_id) 建立
- audit_session_id 指向"另一个独立 leaf"的 session_id（不能指向自己）
- V10-self-audit-forbidden: callerSessionId（MCP wrapper 注入）必须 === audit_session_id

## status 转换图
\`\`\`
pending_brief → active → done     （正常完成）
active → pruned                  （剪枝）
active → archived                （归档，可恢复）
active → segment_pending         （竹节交接中）
\`\`\`
切 done 时引擎硬校验：milestones 非空 + 全部 audit_pass=true + alignment 已回填。

## 关联
- mcp__tree__tree_help('how_to_register_auditor') — auditor 注册细节`,
  },

  v10_constraints: {
    title: 'V10 八大加固点摘要',
    related: ['self_audit_forbidden', 'borrowed_identity', 'nudge_escalation'],
    content: `# v10_constraints — V10 加固 8 大点

V10 (2026-06-25) 从「字段存在性校验」升级为「内容有效性校验」。

## 8 个加固点
1. **V10-auditor-active**: auditor leaf 必须 status=done + events 非空 + audit_gate.verdict=pass
   错误码：E_AUDITOR_NOT_DONE / E_AUDITOR_NO_EVENTS / E_AUDITOR_NOT_VERIFIED

2. **V10-self-audit-forbidden-v2**: callerSessionId 必须 === audit_session_id（堵借身份）
   错误码：E_BORROWED_IDENTITY

3. **V10-uuid-format-strict**: UUID 必须合法格式 + 拒全 0 / 全 f
   错误码：E_INVALID_UUID_STRICT

4. **V10-numeric-consistency**: audit report 数值一致
   错误码：E_NEGATIVE_COUNT / E_COUNT_MISMATCH / E_LENGTH_MISMATCH

5. **V10-nudge-escalation**: nudge_count 到阈值强制升级
   错误码：E_LEAF_AUTO_PRUNED

6. **V10-timestamp-monotonic**: event ts 单调
   错误码：E_TS_BEFORE_CREATED / E_TS_IN_FUTURE / E_TS_NOT_MONOTONIC

7. **V10-workspace-canonical**: slug "undefined"/null/"" → fallback "default"
   错误码：E_NO_TREES_DIR（MCP wrapper 层）

8. **V10-status-event-sync**: status 切换与 event append 双向校验
   错误码：E_STATUS_EVENT_MISMATCH

## 失守案例
audit-gate-test-20260625: worker 528b0925 借 auditor 404c724f 的 session_id 通过 audit_gate pass。
V10-self-audit-forbidden-v2 后：MCP wrapper 提取 callerSessionId=528b0925，引擎比对 audit_session_id=404c724f，拒。

## 关联
- 完整 spec: .context/plan/v10-implementation-charter.md
- 错误码索引: mcp__tree__tree_help('error_code_index')`,
  },

  self_audit_forbidden: {
    title: '为什么 caller ≠ audit_session_id',
    related: ['borrowed_identity', 'how_to_register_auditor'],
    content: `# self_audit_forbidden — 为什么 caller ≠ audit_session_id

## 一句话
worker 不能用自己的 session_id 给自己审 pass，也不能借 auditor 的 session_id 写 pass。

## 失守案例（audit-gate-test-20260625）
- worker leaf: 528b0925 (session 528b0925-...)
- auditor leaf: 404c724f (session 404c724f-...)
- worker 528b0925 调 mcp__tree__tree_audit_gate(leaf_id=worker, verdict=pass, audit_session_id=404c724f)
- V4-V9 引擎：只查 audit_session_id 是否对应不同 leaf → 通过 ❌
- 实际：auditor 404c724f 自始至终没自主发表过任何审计意见
- 整个测试"通过"是 worker 自导自演的假象

## V10 修复
patches.cjs __proma_getMcpServers__(sessionId, ...) 提取 sessionId，
透传给 callTreeState → engine.run → cmdAuditGate 校验：

\`\`\`js
if (audit_session_id && callerSessionId && audit_session_id !== callerSessionId) {
  throw new TreeStateError(E_BORROWED_IDENTITY, ...);
}
\`\`\`

CLI 调用（dbc-spec 等）不传 callerSessionId，跳过此校验（向后兼容）。

## 正确流程
1. commander 用 fork_session / create_session 派 auditor session
2. commander send_message(auditor_session, "审计 leaf X 的产出...")
3. auditor 在自己 session 内调 mcp__tree__tree_audit_gate(leaf_id=X, verdict=pass, audit_session_id=<auditor 自己 session>)
4. 引擎校验 callerSessionId（来自 MCP wrapper）=== audit_session_id → 通过

## 关联
- mcp__tree__tree_help('borrowed_identity') — 攻击视角
- mcp__tree__tree_help('how_to_register_auditor') — 完整注册流程`,
  },

  borrowed_identity: {
    title: '借身份攻击详解',
    related: ['self_audit_forbidden', 'v10_constraints'],
    content: `# borrowed_identity — 借身份攻击

## 攻击原理
worker W 想给自己发 pass，但 audit_gate 要求 audit_session_id 指向另一个 leaf。
W 偷偷拿 auditor A 的 session_id，伪装成 A 调 audit_gate(leaf_id=W, verdict=pass, audit_session_id=A_session)。
V4-V9 引擎只查"A 是否是不同 leaf"，不查"调用者是否真是 A"——攻击成功。

## 真实失守数据（audit-gate-test-20260625）
- worker 528b0925 借 auditor 404c724f session_id
- audit_gate pass 落库 → worker status=done → 报告"测试通过"
- 真实情况：auditor 404c724f 没主动发表过任何意见
- 整条 audit 链路是 worker 自导自演

## V10 修复前后对比
| 检查项 | V4-V9 | V10 |
|--------|-------|-----|
| audit_session_id 是否不同 leaf | ✓ | ✓ |
| 调用者 caller 是否真是 audit_session_id | ✗ | ✓（callerSessionId 校验）|

## 测试用例参考
- v10-cleanroom.cjs case 5：borrowed_identity 攻击重放
- audit-attacks.cjs：系列攻击 fixture

## 关联
- mcp__tree__tree_help('self_audit_forbidden') — 防御视角
- mcp__tree__tree_help('v10_constraints') — V10 加固全景`,
  },

  naming_convention: {
    title: 'leaf_id 命名规则',
    related: ['how_to_init', 'role_semantics'],
    content: `# naming_convention — leaf_id 命名规则

## 格式
\`\`\`
<prefix>-<path>-<role>[-<suffix>]
\`\`\`

| 段 | 内容 | 正则 |
|----|------|------|
| prefix | 项目代号（永不变更） | \`[a-z][a-z0-9_]{3,7}\`（小写开头，4-8 字符，无连字符）|
| path | 树定位（根省略） | \`[A-Z]\\d*(?:[a-z]\\d*)*\` |
| role | root/commander/worker | 枚举 |
| suffix | 竹节 sNN / 尝试 iNN（可选） | \`s\\d+\\|i\\d+\` |

## 完整正则
\`\`\`
^([a-z][a-z0-9_]{3,7})-(?:([A-Z]\\d*(?:[a-z]\\d*)*)?-)?(root|commander|worker)(?:-(s\\d+|i\\d+))?$
\`\`\`

## 正例
- \`v10v-root\` — v10v 项目根
- \`v10v-A-commander\` — v10v 第 1 子（A）= 子指挥官
- \`v10v-A1-worker\` — A 的第 1 孙 = 原子工人
- \`v10v-A-commander-s2\` — A 的竹节第 2 节
- \`v10v-A1b-worker\` — A1 的第 2 个曾孙

## 负例
- \`proma-guide-root\` — prefix 含连字符
- \`NA-root\` — prefix 大写 + 不足 4 字符
- \`nju-root\` — prefix 仅 3 字符
- \`NANJU-root\` — prefix 含大写
- \`123abc-root\` — prefix 首字符非小写字母
- \`auditor-1\` — 不符合格式（被 65996e8b commander 用过，错误）
- \`worker-A1\` — 顺序反了，prefix 缺失

## 触发错误码
E_NAME_INVALID（cmdLeafAdd 第 1 道校验）
E_SCHEMA_INVALID（path 段与 leaf_id 不一致）`,
  },

  common_mistakes: {
    title: '65996e8b 案例的 5 个常见错误',
    related: ['how_to_init', 'naming_convention', 'self_audit_forbidden', 'v10_constraints', 'alignment_workflow'],
    content: `# common_mistakes — Agent 常犯的 5 个错误（65996e8b 教训）

DeepSeek V4 Pro commander 65996e8b 在 audit-gate-retest-v10 端到端任务中暴露 4 阶段失守：
**瞎试 → 瞎编 → 嘴硬 → 后补**。

## 5 个常见错误

### 1. 建空树（缺 root_brief/dod）
错误：\`tree_init(tree_id='x')\` 不传 root_brief / root_dod
后果：E_SCHEMA_INVALID
正确：root_brief 5 字段 + root_dod 4 字段，参考 mcp__tree__tree_help('how_to_init')

### 2. 编造 leaf_id 命名
错误：\`auditor-1\` / \`worker-A1\` / \`review-leaf\`（不符合 <prefix>-<path>-<role> 正则）
后果：E_NAME_INVALID
正确：参考 mcp__tree__tree_help('naming_convention')，如 \`v10v-C1-worker\`

### 3. 调用顺序错乱（audit_gate 先于 leaf_add）
错误：先 audit_gate 再 leaf_add
后果：E_LEAF_NOT_FOUND
正确：先 tree_init → leaf_add（建 leaf）→ brief_echo → audit_gate

### 4. 借身份（caller ≠ audit_session_id）
错误：worker session 调 audit_gate(audit_session_id=<auditor session>)，伪装成 auditor
后果：E_BORROWED_IDENTITY
正确：参考 mcp__tree__tree_help('self_audit_forbidden')，auditor 必须在自己 session 内调

### 5. 报告早于落库（事件 ts 不单调）
错误：commander 在 09:16 写"10/10 通过"报告，worker 09:19 才真正调 audit_gate pass
后果：ts 反序 → E_TS_NOT_MONOTONIC
正确：先调 audit_gate 落库，再写报告；事件 ts 单调递增

## 65996e8b 的 4 阶段失守模式
1. **瞎试**：不看 SKILL 直接试 mcp__tree__* 工具
2. **瞎编**：失败后编造命名 / 占位 UUID / 假 auditor
3. **嘴硬**：报告"全部通过"实际未真正调过 audit_gate
4. **后补**：被审计发现后再补调，时序已乱

## 防御策略
- 调任何 mcp__tree__* 工具前先 \`tree_help(<topic>)\`
- 错误返回自动附 help_topic，跟着 help_hint 走
- fork 真实 session 注册 leaf，不用占位 UUID`,
  },

  alignment_workflow: {
    title: 'brief_echo + alignment 回填流程',
    related: ['how_to_register_auditor', 'role_semantics'],
    content: `# alignment_workflow — brief_echo + alignment 回填

## V5b 硬约束
worker 后续 audit_gate pass 必须先有 alignment 留痕（event），否则 E_ALIGNMENT_NOT_VERIFIED。

## 流程
\`\`\`
1. worker fork → mcp__tree__tree_leaf_add(role=worker)
2. worker 首条上行: tree_event_append(type=brief_echo, meta={my_understanding, milestones_preview})
3. commander 派"路线图 Agent"（独立 leaf）评估对齐度
4. commander 回填: tree_event_append(type=brief_echo, meta={alignment, auditor_session_id})
   ↑ 这条回填 event 是 worker 后续 audit pass 的硬前置
5. 对齐度 ≥85% → worker 继续干活
   <85% → tree_drift_append(severity=low, action=nudge) 发回重 brief_echo
\`\`\`

## 为什么 alignment 在回填 event 里
alignment 是 commander/路线图 Agent 的【对齐评估产物】（worker 自己无法自评）。
worker 首条 brief_echo 只含 my_understanding + milestones_preview。
评估完成后，结果以第二条 brief_echo event 回填到 worker leaf——
这同时满足 V5b 的"events 留痕"和 A3 的"独立 auditor 背书"。

## 跳过此步的后果
worker 永远拿不到 audit pass：
- cmdAuditGate 拦 E_ALIGNMENT_NOT_VERIFIED
- worker 卡死无法 done，会上行 blocked 抱怨"audit pass 被拦"
- **这不是 bug，是 V5b 硬约束**（堵 A3-omit-alignment 绕过）

## 关联
- mcp__tree__tree_help('how_to_register_auditor')`,
  },

  nudge_escalation: {
    title: 'nudge 升级机制',
    related: ['v10_constraints'],
    content: `# nudge_escalation — nudge 升级机制

## 升级阈值
\`\`\`
nudge_count == 3 → severity 自动升级到 'medium'
nudge_count == 5 → severity 自动升级到 'high'
nudge_count >= 7 → 强制 status=pruned（E_LEAF_AUTO_PRUNED）
\`\`\`

## V4-V9 漏洞
某 leaf 累积 168 次 nudge 都没升级，severity 永远停在 'low'。
原因：升级逻辑只在 drift_append 写死，nudge_append 不触发升级。

## V10 修复
cmdNudgeAppend 自动检查 nudge_count 并：
1. 自动累积 nudge_count + nudge_log
2. 按阈值自动升级 severity
3. 到 7 次强制 tree_leaf_set_status(status=pruned)，抛 E_LEAF_AUTO_PRUNED

## 关联
- mcp__tree__tree_help('v10_constraints')
- v10-cleanroom.cjs nudge 测试组`,
  },

  audit_tree_structure: {
    title: '审计任务最小树结构',
    related: ['role_semantics', 'how_to_register_auditor'],
    content: `# audit_tree_structure — 审计任务最小树结构

## 7 leaf 最小结构（强制）
\`\`\`
<tree_id> (root/commander)
  ├── <tree_id>-fix        — 修正执行员（等审查完成统一改）
  ├── <tree_id>-C1         — 一致性审查员
  ├── <tree_id>-C2         — 完整性/闭环审查员
  ├── <tree_id>-C3         — 规范性/格式审查员
  ├── <tree_id>-C4         — 可验证性/证据审查员
  ├── <tree_id>-A1         — 反向映射重构员
  └── <tree_id>-A2         — 反事实攻击员
\`\`\`

## 铁腕要求
- **最少 7 个审查 leaf**（4 四维 + 2 攻击 + 1 修正）
- C1-C4 和 A1-A2 必须【并行启动】（相互独立）
- 修正员 fix 在所有审查员返回后启动
- 【禁止】commander 亲自充当审查员（"自己画靶自己打分"）

## 迭代收敛流程
\`\`\`
Round 1:
  ① Fork C1-C4 + A1-A2（6 个并行）
  ② 收集所有问题列表，去重汇总
  ③ Fix 子会话执行修正
  ④ tree-state 记录 round=1, issues_found=N1

Round 2:
  ⑤ 重新 Fork 6 个并行（只检查修正是否正确、是否引入新问题）
  ⑥ 收集回归问题列表
  ⑦ 判定收敛（三条件全满足）：
     a. N2 < N1 × 0.3
     b. 无阻断级或严重级新问题
     c. 所有遗留问题均为"建议"级或"待人类确认"
\`\`\`

## 关联
- tree-commander SKILL §14 审计工作流
- tree-audit-methodology.md`,
  },

  error_code_index: {
    title: '全部错误码索引（33 个）',
    related: [],
    content: `# error_code_index — 33 个错误码索引

## 旧错误码（17 个）
- E_TREE_NOT_FOUND — 树目录/状态文件不存在
- E_LEAF_NOT_FOUND — leaf_id 不存在
- E_SCHEMA_INVALID — JSON/字段结构错误 [help: how_to_init]
- E_STATUS_INVALID — status 不在枚举 [help: role_semantics]
- E_NAME_INVALID — leaf_id 不符合命名正则 [help: naming_convention]
- E_PARENT_MISSING — parent 引用不存在的 leaf [help: how_to_init]
- E_DUPLICATE_LEAF — leaf/tree 已存在 [help: naming_convention]
- E_CHILDREN_NOT_DONE — 子 leaf 未全部 done [help: role_semantics]
- E_DEPTH_EXCEEDED — commander 嵌套超过 3 层 [help: role_semantics]
- E_BACKUP_CORRUPT — 备份文件损坏
- E_IO — 文件读写错误
- E_UNKNOWN — 未知命令/子命令
- E_LOCK_TIMEOUT — 文件锁等待超时
- E_DELIVERABLE_MISSING — done 时缺少交付物 [help: alignment_workflow]
- E_AUDITOR_NOT_INDEPENDENT — auditor 与被审 leaf 不独立 [help: how_to_register_auditor]
- E_AUDIT_PREMATURE — 时序错（pass 早于前置）[help: alignment_workflow]
- E_ALIGNMENT_NOT_VERIFIED — worker 缺 alignment 回填 [help: alignment_workflow]
- E_SELFCHECK_INVALID — self_check schema 错 [help: alignment_workflow]
- E_TREE_NODE_BUDGET_EXCEEDED — 超节点预算 [help: how_to_init]
- E_TREE_NOT_VALIDATED — validate 失败 [help: audit_tree_structure]
- E_GATEKEEPER_REQUIRED — 需要 gatekeeper [help: role_semantics]

## V10 新增错误码（16 个）
- E_AUDITOR_NOT_DONE — auditor.status≠done [help: how_to_register_auditor]
- E_AUDITOR_NO_EVENTS — auditor.events 空 [help: how_to_register_auditor]
- E_AUDITOR_NOT_VERIFIED — auditor 自己 audit_gate.verdict≠pass [help: how_to_register_auditor]
- E_BORROWED_IDENTITY — caller≠audit_session_id [help: self_audit_forbidden]
- E_INVALID_UUID_STRICT — UUID 全 0/全 f/非合法格式 [help: v10_constraints]
- E_NEGATIVE_COUNT — total/passed/failed<0 [help: v10_constraints]
- E_COUNT_MISMATCH — passed+failed≠total [help: v10_constraints]
- E_LENGTH_MISMATCH — results.length≠total [help: v10_constraints]
- E_TS_BEFORE_CREATED — event ts 早于 leaf.created_at [help: v10_constraints]
- E_TS_IN_FUTURE — event ts 晚于 now+60s [help: v10_constraints]
- E_TS_NOT_MONOTONIC — event ts 早于上一条 [help: v10_constraints]
- E_LEAF_AUTO_PRUNED — nudge_count≥7 强制 pruned [help: nudge_escalation]
- E_STATUS_EVENT_MISMATCH — status/event 不同步 [help: v10_constraints]`,
  },

  full_guide: {
    title: '完整指南入口（SKILL.md）',
    related: [],
    content: `# full_guide — 完整指南入口

## tree-commander SKILL
路径: \`skills/tree-commander/SKILL.md\`

核心章节：
- §1 铁律 5 条
- §3 5 件套契约模板（brief/dod/report/autonomy/self_audit）
- §4 工作流程 5 步法
- §5 mcp__tree__* 工具速查（28 个工具）
- §6 事件路由表（done/blocked/plan/brief_echo/heartbeat_reply）
- §7 三档纠偏决策树（low/mid/high）
- §8 心跳通道
- §9 验收 Agent prompt 模板
- §10 灾难恢复检查表（F1-F4）
- §11 禁止行为清单 12 条
- §12 命名规范
- §14 审计工作流（最小 7 leaf 结构）

## tree-worker SKILL
路径: \`skills/tree-worker/SKILL.md\`

## 调用方式
1. 直接读文件：\`Read("skills/tree-commander/SKILL.md")\`
2. 或问具体 topic：\`mcp__tree__tree_help('<topic>')\`

## topic 列表
how_to_init | how_to_register_auditor | role_semantics | v10_constraints |
self_audit_forbidden | borrowed_identity | naming_convention | common_mistakes |
alignment_workflow | nudge_escalation | audit_tree_structure | error_code_index | full_guide`,
  },
};

// cmdHelp — 处理 mcp__tree__tree_help(topic)
// 签名：help <topic>  或 help（无 topic 返回 topic 列表）
function cmdHelp(args) {
  const { positional } = parseArgs(args);
  const topic = positional[0];
  if (!topic) {
    return {
      topics: Object.keys(HELP_TOPICS).map((k) => ({ topic: k, title: HELP_TOPICS[k].title })),
      hint: "Call mcp__tree__tree_help({topic: '<name>'}) for details.",
    };
  }
  const entry = HELP_TOPICS[topic];
  if (!entry) {
    const available = Object.keys(HELP_TOPICS).join(', ');
    throw new TreeStateError(
      E_UNKNOWN,
      `Unknown help topic "${topic}". Available topics: ${available}. Call mcp__tree__tree_help({topic: 'full_guide'}) for the index.`
    );
  }
  return {
    topic,
    title: entry.title,
    content: entry.content,
    related_topics: entry.related || [],
    skill_reference: 'skills/tree-commander/SKILL.md',
  };
}

// ============================================================
// 主入口 & 路由
// ============================================================

async function dispatch(cmd, args, callerSessionId) {
  switch (cmd) {
    // Maintain
    case 'init':
      return await cmdInit(args);
    case 'backup':
      return await cmdBackup(args);
    case 'restore':
      return await cmdRestore(args);
    case 'validate':
      return await cmdValidate(args);
    case 'migrate':
      return await cmdMigrate(args);

    // Add
    case 'leaf':
      return await dispatchLeaf(args);
    case 'milestone':
      return await dispatchMilestone(args);

    // Append
    // V10-trust-anchor-fix (C5): dispatchEvent 也透传 callerSessionId（cmdEventAppend 校验 caller 写 done event）
    case 'event':
      return await dispatchEvent(args, callerSessionId);
    case 'drift':
      return await dispatchDrift(args);
    case 'heartbeat':
      return await dispatchHeartbeat(args);
    case 'segment':
      return await dispatchSegment(args);

    // TAO (v0.2.2) — 天道审计门 + 鞭策
    // V10-self-audit-forbidden-v2: dispatchAudit 透传 callerSessionId 给 cmdAuditGate（其他子命令忽略）
    case 'audit':
      return await dispatchAudit(args, callerSessionId);
    case 'nudge':
      return await dispatchNudge(args);

    // Query
    case 'tree':
      return await dispatchTree(args);

    // V10-helper (D4 Layer 1): Agent 自助文档
    case 'help':
      return cmdHelp(args);

    default:
      throw new TreeStateError(E_UNKNOWN, `unknown command "${cmd}". Available: init, backup, restore, validate, migrate, leaf, milestone, event, drift, heartbeat, segment, audit, nudge, tree, help. Call mcp__tree__tree_help('full_guide') for usage.`);
  }
}

async function dispatchLeaf(args) {
  if (args.length === 0) {
    throw new TreeStateError(E_SCHEMA_INVALID, 'leaf requires a subcommand: get | list-active | list-all | add | set-status | set-context | set-last-event | set-session | autonomy-override');
  }
  const [sub, ...rest] = args;
  switch (sub) {
    case 'get': return await cmdLeafGet(rest);
    case 'list-active': return await cmdLeafListActive(rest);
    case 'list-all': return await cmdLeafListAll(rest);
    case 'add': return await cmdLeafAdd(rest);
    case 'set-status': return await cmdLeafSetStatus(rest);
    case 'set-context': return await cmdLeafSetContext(rest);
    case 'set-last-event': return await cmdLeafSetLastEvent(rest);
    case 'set-session': return await cmdLeafSetSession(rest);
    case 'autonomy-override': return await cmdLeafAutonomyOverride(rest);
    default:
      throw new TreeStateError(E_UNKNOWN, `unknown leaf subcommand "${sub}"`);
  }
}

async function dispatchMilestone(args) {
  if (args.length === 0) {
    throw new TreeStateError(E_SCHEMA_INVALID, 'milestone requires a subcommand: add | set-result');
  }
  const [sub, ...rest] = args;
  switch (sub) {
    case 'add': return await cmdMilestoneAdd(rest);
    case 'set-result': return await cmdMilestoneSetResult(rest);
    default:
      throw new TreeStateError(E_UNKNOWN, `unknown milestone subcommand "${sub}"`);
  }
}

async function dispatchEvent(args, callerSessionId) {
  if (args.length === 0) {
    throw new TreeStateError(E_SCHEMA_INVALID, 'event requires a subcommand: append | list');
  }
  const [sub, ...rest] = args;
  switch (sub) {
    // V10-trust-anchor-fix (C5/A3 P0 攻击 2): 透传 callerSessionId 给 cmdEventAppend,
    //   校验 caller=leaf.session_id/added_b 才能写 done event（堵 worker 给 root 写 done 触发 auto_upgrade）。
    case 'append': return await cmdEventAppend(rest, callerSessionId);
    case 'list': return await cmdEventList(rest);
    default:
      throw new TreeStateError(E_UNKNOWN, `unknown event subcommand "${sub}"`);
  }
}

async function dispatchDrift(args) {
  if (args.length === 0) {
    throw new TreeStateError(E_SCHEMA_INVALID, 'drift requires a subcommand: append | list');
  }
  const [sub, ...rest] = args;
  switch (sub) {
    case 'append': return await cmdDriftAppend(rest);
    case 'list': return await cmdDriftList(rest);
    default:
      throw new TreeStateError(E_UNKNOWN, `unknown drift subcommand "${sub}"`);
  }
}

async function dispatchHeartbeat(args) {
  if (args.length === 0) {
    throw new TreeStateError(E_SCHEMA_INVALID, 'heartbeat requires a subcommand: append | tail');
  }
  const [sub, ...rest] = args;
  switch (sub) {
    case 'append': return await cmdHeartbeatAppend(rest);
    case 'tail': return await cmdHeartbeatTail(rest);
    default:
      throw new TreeStateError(E_UNKNOWN, `unknown heartbeat subcommand "${sub}"`);
  }
}

async function dispatchSegment(args) {
  if (args.length === 0) {
    throw new TreeStateError(E_SCHEMA_INVALID, 'segment requires a subcommand: append');
  }
  const [sub, ...rest] = args;
  switch (sub) {
    case 'append': return await cmdSegmentAppend(rest);
    default:
      throw new TreeStateError(E_UNKNOWN, `unknown segment subcommand "${sub}"`);
  }
}

async function dispatchTree(args) {
  if (args.length === 0) {
    throw new TreeStateError(E_SCHEMA_INVALID, 'tree requires a subcommand: dump');
  }
  const [sub, ...rest] = args;
  switch (sub) {
    case 'dump': return await cmdTreeDump(rest);
    default:
      throw new TreeStateError(E_UNKNOWN, `unknown tree subcommand "${sub}"`);
  }
}

// ============================================================
// v0.7+: 引擎内联 — 导出 API + CLI shim（向后兼容）
// ============================================================

function setTreesRoot(p) {
  if (typeof p !== 'string' || !p.trim()) {
    throw new Error('setTreesRoot: path must be a non-empty string');
  }
  TREES_ROOT = path.resolve(p);
}

function getTreesRoot() {
  return TREES_ROOT;
}

// run(cmd, args): CLI 等价入口，永不 throw。
// 成功 -> {ok:true, ...result}；失败 -> {ok:false, error:{code,msg}}。
// 返回结构与原 tree-state.js stdout 完全一致 —— MCP handler 与 dbc-spec/audit-attacks
// 用这个（而非 dispatch），可无缝替换原 spawn execFile：调用方只看 {ok,error?}，无需 try/catch。
// dispatch 仍导出，供需要区分"业务异常 vs 真错误"的调用方（异常是 TreeStateError 带 code）。
// run(cmd, args, treesRoot?): CLI 等价入口，永不 throw。
// 成功 -> {ok:true, ...result}；失败 -> {ok:false, error:{code,msg}}。
// treesRoot 可选：传入则 per-call 覆盖 TREES_ROOT（finally 恢复），不传则用模块级（setTreesRoot 设的）。
// MCP 多 workspace 并发场景应传 per-call treesRoot（callTreeState 已传），显式消除跨请求覆盖风险。
// ⚠️ 并发约束：所有 cmd 临界区（readState→改→writeState）必须纯同步不得 yield（当前 withLock 的 fn 均为同步箭头函数，满足）。
//    若未来把临界区 async 化，per-call treesRoot 的 try/finally 仍能防污染，但建议彻底改为 dispatch(cmd,args,treesRoot) 参数化。
// V10-self-audit-forbidden-v2: 新增 callerSessionId 参数，透传到 dispatch → dispatchAudit → cmdAuditGate。
//   MCP wrapper 从 __proma_getMcpServers__(sessionId, ...) 提取并注入。
// V10-trust-anchor-fix (C5): callerSessionId 同时透传给 dispatch → dispatchEvent → cmdEventAppend,
//   校验 caller 才能写 done event（堵 worker 给 root 写 done 触发 auto_upgrade）。
async function run(cmd, args, treesRoot, callerSessionId) {
  const prevRoot = TREES_ROOT;
  if (typeof treesRoot === 'string' && treesRoot.trim()) {
    TREES_ROOT = path.resolve(treesRoot);
  }
  try {
    const result = await dispatch(cmd, args, callerSessionId);
    return Object.assign({ ok: true }, result);
  } catch (e) {
    const code = e && e.code ? e.code : E_UNKNOWN;
    const msg = e && e.message ? e.message : String(e);
    // V10-helper (D4 Layer 3): 错误返回附 help 引用。TreeStateError 构造时已挂 help_topic。
    //   自解释错误（E_TREE_NOT_FOUND 等）help_topic=null，不附引用。
    const helpTopic = (e && typeof e.help_topic !== 'undefined')
      ? e.help_topic
      : (ERROR_TO_HELP[code] || null);
    const error = { code, msg };
    if (helpTopic) {
      error.help_topic = helpTopic;
      error.help_hint = `See mcp__tree__tree_help('${helpTopic}') for correct usage.`;
    }
    return { ok: false, error };
  } finally {
    TREES_ROOT = prevRoot;
  }
}

// 导出：供 proma-dev-patches.cjs (mcp__tree__* MCP) 与 dbc-spec/audit-attacks (验收) require。
// dispatch(cmd, args) 接口与原 CLI 完全一致（27 个 cmd 函数体零改动），调用前须 setTreesRoot。
module.exports = {
  dispatch,
  run,
  setTreesRoot,
  getTreesRoot,
  parseArgs,
  // 错误码常量（供验收工具断言，不依赖硬编码字符串）
  ERRORS: {
    E_LOCK_TIMEOUT, E_TREE_NOT_FOUND, E_LEAF_NOT_FOUND, E_SCHEMA_INVALID,
    E_STATUS_INVALID, E_NAME_INVALID, E_PARENT_MISSING, E_DUPLICATE_LEAF,
    E_CHILDREN_NOT_DONE, E_DEPTH_EXCEEDED, E_BACKUP_CORRUPT, E_IO, E_UNKNOWN,
    E_GATEKEEPER_REQUIRED, E_DELIVERABLE_MISSING, E_AUDITOR_NOT_INDEPENDENT,
    E_AUDIT_PREMATURE, E_ALIGNMENT_NOT_VERIFIED, E_SELFCHECK_INVALID,
    E_TREE_NODE_BUDGET_EXCEEDED, E_TREE_NOT_VALIDATED,
    // V10 加固（2026-06-25）新增错误码：详见 .context/plan/v10-implementation-charter.md §六
    E_AUDITOR_NOT_DONE, E_AUDITOR_NO_EVENTS, E_AUDITOR_NOT_VERIFIED,
    E_BORROWED_IDENTITY, E_INVALID_UUID_STRICT,
    E_NEGATIVE_COUNT, E_COUNT_MISMATCH, E_LENGTH_MISMATCH,
    E_TS_BEFORE_CREATED, E_TS_IN_FUTURE, E_TS_NOT_MONOTONIC,
    E_LEAF_AUTO_PRUNED, E_STATUS_EVENT_MISMATCH,
  },
};

// CLI shim: node tree-engine.cjs <cmd> [args] —— stdout 输出与原 tree-state.js 完全一致。
// 让 dbc-spec/audit-attacks 过渡期可继续 execFileSync；长期建议改 require（省进程开销）。
if (require.main === module) {
  const argv = process.argv.slice(2);
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  if (argv.length === 0) {
    emit({ ok: false, error: { code: E_UNKNOWN, msg: 'no command given. Try: node tree-engine.cjs init <tree_id> --root-brief ... --root-dod ...' } });
    process.exit(2);
  }
  const [cmd, ...args] = argv;
  run(cmd, args).then((out) => {
    emit(out);
    process.exit(out.ok ? 0 : (out.error && out.error.code === E_LOCK_TIMEOUT ? 3 : 1));
  });
}

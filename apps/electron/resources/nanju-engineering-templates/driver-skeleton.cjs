#!/usr/bin/env node
'use strict';
/*
 * 南大向导 · 工程验收驱动骨架（driver-skeleton.cjs）——L2-5 五项运行时自检（Node 版）。
 *
 * 使用说明：
 *   1. 复制本文件到 08_APP/drivers/ 并改名（如 drv_xxx.cjs），与被测产物同工程；
 *   2. 按本项目实际修改下方 REQUIRED_DISPLAY / REQUIRED_ENV_VARS；
 *   3. 在 runProbes() 中填充真实探测逻辑，用 makeCheck / assertSameSource 组装检查；
 *   4. 由宿主执行：stdin 收到 {schemaVersion,testId,target,covers,evidenceDigest}，
 *      stdout 只输出单个结果 JSON {testId,target,checks:[{storyId,label,expected,actual,evidence}]}，
 *      日志写 stderr，退出码由宿主实测（驱动自报不能覆盖实测）。
 *
 * 五项运行时自检（平台 L2-5；错误分类 R2/A3/R3 见品类模版 §5.3）：
 *   ① storyId 非空校验（R2 类）：acceptance 模式（stdin covers 非空）下 makeCheck 拒绝
 *      空串/null/undefined 的 storyId，错误消息指明 R2 类问题；辅助测试（covers 为空）storyId 必须为 null。
 *   ② expected/actual 同源生成（A3 类）：actual 必须由 probe（函数）真实探测产生；
 *      assertSameSource(expectedConst, probeFn) 断言同源——A3 类教训 [实证]：
 *      禁止把 actual 手写成 expected 的同义文案（期望"语音输入已开启"不得拿"语音输入打开"当通过）。
 *   ③ 输出 JSON schema 校验 + 退出码表：emitResult 序列化前自校验
 *      （testId/target 来自 stdin、checks 非空、每条字段形态合法、evidence 非空字符串数组）。
 *   ④ 顶层异常包裹（R3 类）：runGuarded 捕获 main 及填充代码的一切异常
 *      （同步 throw + async reject + process.on('uncaughtException'/'unhandledRejection') 事件循环兜底），
 *      转结构化 error JSON（含 type、exit_code、traceback 摘要=末 5 帧）后 exit 1，完整 stack 写 stderr——
 *      崩溃也产出可判读输出，不再静默。
 *   ⑤ 环境前置自检：checkEnvironment 在驱动逻辑运行前检查 DISPLAY / 密钥类变量
 *      （只声明变量名，值从环境读、不硬编码、不写进任何文件）。缺失 → 输出含
 *      "环境前置自检"检查项的结构化结果并 exit 2（blocked），环境问题不伪装成产品 error。
 *      语义说明：宿主把 exit≠0 且含 fail 检查的结果判为 fail/error——环境自检条目的
 *      label/actual 明示"环境前置自检 / 缺失: XXX"，验收方能据此把环境缺失与产品缺陷区分开。
 *      回归测试态注入（仅平台测试用，业务勿用）：
 *      NANJU_DRIVER_SKELETON_TEST_DISPLAY_MISSING=1 模拟 DISPLAY 缺失；
 *      NANJU_DRIVER_SKELETON_TEST_KEY_MISSING=1 模拟密钥类变量缺失。
 *
 * 与 Python 版（driver-skeleton.py）的差异（进程退出语义）：
 *   - Python 的 except BaseException 可拦截 SystemExit（sys.exit 路径转结构化 error JSON 后按原退出码退出）；
 *   - Node 的 process.exit() 同步终止进程、进程内不可拦截（等价 Python 的 os._exit 盲区）——因此约定：
 *     (a) 本骨架一切退出走 exitWith(code)（先写 stdout 再退出，exit 前用 fs.writeSync 同步落盘）；
 *     (b) 填充代码里的任意 process.exit(N) 无法被包裹，属静默盲区——该路径由平台侧
 *         P0-2 stderr 尾部透传兜底；填充代码应使用 exitWith 或 throw，不用裸 process.exit；
 *     (c) SystemExit 的等价承载：异常兜底覆盖 throw/reject 全路径（uncaughtException 兜底事件循环异步异常），
 *         这是 Node 侧能达到的最大包裹范围。
 *
 * 退出码表：0=全部 pass；1=存在 fail 检查或驱动异常（结构化 error JSON）；2=自检拦截（环境缺失/结构违规）。
 */
const fs = require('node:fs');

const S = module.exports; // 内部引用统一走 S.*，允许使用方 require 后覆盖 S.runProbes（填充点）

// ===== 驱动配置（按项目实际修改）=====
S.REQUIRED_DISPLAY = false;            // 桌面/图形类驱动置 true（检查 DISPLAY）
S.REQUIRED_ENV_VARS = ['MY_API_KEY'];  // 本驱动所需密钥类变量名（样例名；值从 env 读，不硬编码；无需密钥则置 []）

S.EXIT_TABLE = Object.freeze({ PASS: 0, FAIL: 1, BLOCKED: 2 });

let _request = null; // stdin 请求缓存（error 兜底输出 testId/target 用）
let _exitOk = null;  // 框架表内退出标记（区别填充代码里任意的 process.exit）

const DriverSelfCheckError = class extends Error {
  constructor(message) { super(message); this.name = 'DriverSelfCheckError'; }
};
S.DriverSelfCheckError = DriverSelfCheckError;

function checkEnvironment() {
  /** ⑤ 环境前置自检：返回缺失项数组（空数组=环境就绪）。 */
  const missing = [];
  if (process.env.NANJU_DRIVER_SKELETON_TEST_DISPLAY_MISSING === '1') {
    missing.push('DISPLAY'); // 回归测试注入态：模拟该项被检测为缺失
  } else if (S.REQUIRED_DISPLAY && !process.env.DISPLAY) {
    missing.push('DISPLAY');
  }
  if (process.env.NANJU_DRIVER_SKELETON_TEST_KEY_MISSING === '1') {
    missing.push(...S.REQUIRED_ENV_VARS); // 回归测试注入态：模拟清单内全部缺失
  } else {
    for (const name of S.REQUIRED_ENV_VARS) if (!process.env[name]) missing.push(name);
  }
  return missing;
}
S.checkEnvironment = checkEnvironment;

function writeStdout(payload) {
  fs.writeSync(1, JSON.stringify(payload) + '\n'); // 同步写 fd 1，保证 exit 前落盘（pipe 异步写会被截断）
}

function exitWith(code) {
  /** 按退出码表退出（0/1/2），并标记为框架合法退出。 */
  _exitOk = code;
  process.exit(code);
}

function makeCheck(storyId, label, expected, actualOrProbe, evidence) {
  /** ①+② 检查工厂：返回一条宿主协议形态的 check 对象。
   *  - acceptance 模式（stdin covers 非空）：storyId 必须非空字符串（R2 类校验）；
   *    辅助模式（covers 为空）：storyId 必须为 null。
   *  - actualOrProbe 传函数（probe）→ 调用取实际值（② 同源生成，推荐路径）；
   *    传字符串 → 直接作为 actual（仅开发期联调；A3 类同义文案风险自负，正式断言一律用 probe）。 */
  const covers = (_request && Array.isArray(_request.covers)) ? _request.covers : [];
  if (covers.length > 0) {
    if (storyId === null || storyId === undefined || storyId === '') {
      throw new DriverSelfCheckError(
        'R2 类驱动缺陷：acceptance 驱动（stdin covers=' + JSON.stringify(covers)
        + '）的检查 storyId 为空。storyId 必须逐字使用 PRD 用户故事编号（如 US-01），不得留空。');
    }
  } else if (storyId !== null && storyId !== undefined) {
    throw new DriverSelfCheckError(
      '辅助测试（covers 为空）的 storyId 必须为 null，收到：' + JSON.stringify(storyId));
  }
  const actualRaw = typeof actualOrProbe === 'function' ? actualOrProbe() : actualOrProbe;
  const toStr = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
  return {
    storyId: storyId === undefined ? null : storyId,
    label,
    expected: toStr(expected),
    actual: toStr(actualRaw),
    evidence: (Array.isArray(evidence) && evidence.length > 0) ? evidence.slice()
      : [label + '（未提供 evidence，默认占位）'],
  };
}
S.makeCheck = makeCheck;

function assertSameSource(expectedConst, probeFn) {
  /** ② 同源断言辅助：actual 必须来自 probeFn() 的真实探测。
   *  A3 类教训 [实证]：期望"语音输入已开启"时，把 actual 手写成"语音输入打开"（同义文案）
   *  会造成错位比对或假 pass。返回 { actual, passed }——probe 返回与 expected 逐字相同 →
   *  passed=true；不同 → passed=false（fail 如实暴露产品行为不符，禁止改写 actual 去凑 expected）。 */
  const actual = probeFn();
  return { actual, passed: actual === expectedConst };
}
S.assertSameSource = assertSameSource;

function validateChecks(checks) {
  /** ③ 输出 schema 自校验：返回违规问题数组（空数组=合法）。 */
  const problems = [];
  if (!Array.isArray(checks) || checks.length === 0) {
    return ['checks 必须是非空数组（宿主协议 checks:[{storyId,label,expected,actual,evidence}]）'];
  }
  checks.forEach((c, i) => {
    if (c === null || typeof c !== 'object' || Array.isArray(c)) {
      problems.push('checks[' + i + '] 必须是对象');
      return;
    }
    const sid = c.storyId;
    if (!(sid === null || (typeof sid === 'string' && sid !== ''))) {
      problems.push('checks[' + i + '].storyId 非法：必须是非空字符串或 null');
    }
    for (const key of ['label', 'expected', 'actual']) {
      if (typeof c[key] !== 'string') problems.push('checks[' + i + '].' + key + ' 必须是字符串');
    }
    const ev = c.evidence;
    if (!(Array.isArray(ev) && ev.length > 0 && ev.every((x) => typeof x === 'string' && x !== ''))) {
      problems.push('checks[' + i + '].evidence 必须是非空字符串数组');
    }
  });
  return problems;
}

function guardCheck(label, expected, actual, evidence) {
  /** 自检拦截条目（环境/schema）：手工构造合法形态（不经 makeCheck，避免二次校验耦合）。 */
  const covers = (_request && Array.isArray(_request.covers)) ? _request.covers : [];
  return { storyId: covers.length > 0 ? covers[0] : null, label, expected, actual, evidence };
}

function emitBlocked(missing) {
  /** ⑤ 环境缺失 → 结构化 blocked 输出 + exit 2（自检拦截）。 */
  writeStdout({
    testId: _request ? _request.testId : null,
    target: _request ? _request.target : null,
    checks: [guardCheck(
      '环境前置自检',
      '环境就绪',
      '缺失: ' + missing.join(', '),
      ['环境自检拦截（exit 2=blocked）：驱动未运行，环境缺失不伪装成产品 error'])],
  });
  exitWith(S.EXIT_TABLE.BLOCKED);
}
S.emitBlocked = emitBlocked;

function emitResult(checks) {
  /** ③ 输出 + 退出：schema 自校验（违规 → exit 2），单 JSON 写 stdout，
   *  退出码按表：全部 expected===actual → 0；否则 1。 */
  const req = _request || {};
  const problems = validateChecks(checks);
  if (problems.length > 0) {
    writeStdout({
      testId: req.testId,
      target: req.target,
      checks: [guardCheck(
        '输出schema自检',
        'checks 形态合法（宿主协议 {storyId,label,expected,actual,evidence}）',
        '结构违规: ' + problems.join('; '),
        ['自检拦截（exit 2）：驱动输出了宿主无法判读的 checks'])],
    });
    exitWith(S.EXIT_TABLE.BLOCKED);
  }
  writeStdout({ testId: req.testId, target: req.target, checks });
  exitWith(checks.every((c) => c.expected === c.actual) ? S.EXIT_TABLE.PASS : S.EXIT_TABLE.FAIL);
}
S.emitResult = emitResult;

function emitError(exc, exitCode) {
  /** ④ 崩溃兜底：结构化 error JSON 到 stdout（唯一 stdout 输出），完整 stack 到 stderr。 */
  const req = _request || {};
  const stack = String((exc && exc.stack) || exc || '');
  const frames = stack.split('\n').filter((l) => l.trim().startsWith('at ')).map((l) => l.trim());
  writeStdout({
    testId: req.testId !== undefined ? req.testId : null,
    target: req.target !== undefined ? req.target : null,
    checks: [],
    error: {
      type: (exc && exc.name) || typeof exc,
      exit_code: exitCode,
      message: String((exc && exc.message) || exc).slice(0, 500) || '(no message)',
      traceback_summary: frames.slice(-5), // 末 5 帧
    },
  });
  fs.writeSync(2, stack + '\n');
}
S.emitError = emitError;

S.runProbes = function runProbes(request) {
  /** 填充点：实现真实探测并返回 checks 数组（用 makeCheck 组装；可为 async 函数）。
   *  照抄未填充时的默认行为：返回一条 TODO fail 检查（exit 1）——骨架永不静默、永不假 pass。 */
  const covers = Array.isArray(request.covers) ? request.covers : [];
  return [makeCheck(
    covers.length > 0 ? covers[0] : null,
    'TODO: 替换为真实 probe',
    '真实探测结果',
    '骨架未填充 runProbes',
    ['照抄骨架默认检查：填充 runProbes 后本条消失'],
  )];
};

async function main() {
  /** 驱动主流程：读 stdin → ⑤ 环境自检 → runProbes（填充点）→ ③ emitResult。 */
  const raw = fs.readFileSync(0, 'utf8'); // stdin：宿主请求 JSON（pipe 同步读至 EOF）
  let request;
  try { request = raw.trim() ? JSON.parse(raw) : {}; }
  catch (e) { throw new DriverSelfCheckError('stdin 不是合法 JSON（宿主协议要求 {schemaVersion,testId,target,covers,evidenceDigest}）：' + e.message); }
  _request = request;
  const missing = checkEnvironment();
  if (missing.length > 0) { emitBlocked(missing); return; }
  const checks = await S.runProbes(request);
  emitResult(checks);
}
S.main = main;

function runGuarded() {
  /** ④ 顶层异常包裹入口。
   *  - main 的同步/async 异常：promise .catch 捕获（async 函数内 throw 一律 reject）→ 结构化 error JSON + exit 1；
   *  - 事件循环中的异步异常：process.on('uncaughtException'/'unhandledRejection') 兜底 → 同上；
   *  - 框架表内退出（emitResult/emitBlocked 经 exitWith）：stdout 已同步落盘后 process.exit，安全；
   *  - 填充代码裸 process.exit(N)：进程内不可拦截（见头部差异说明），由平台侧 P0-2 兜底。 */
  process.on('uncaughtException', (err) => {
    try { emitError(err, 1); } finally { process.exit(1); }
  });
  process.on('unhandledRejection', (err) => {
    try { emitError(err, 1); } finally { process.exit(1); }
  });
  main().catch((err) => { emitError(err, 1); process.exit(1); });
}
S.runGuarded = runGuarded;

if (require.main === module) runGuarded();

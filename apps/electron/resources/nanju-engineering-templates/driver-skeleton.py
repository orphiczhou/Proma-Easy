#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""南大向导 · 工程验收驱动骨架（driver-skeleton.py）——L2-5 五项运行时自检。

使用说明：
  1. 复制本文件到 08_APP/drivers/ 并改名（如 drv_xxx.py），与被测产物同工程；
  2. 按本项目实际修改下方 REQUIRED_DISPLAY / REQUIRED_ENV_VARS；
  3. 在 run_probes() 中填充真实探测（probe）逻辑，用 make_check / assert_same_source 组装检查；
  4. 由宿主执行：stdin 收到 {schemaVersion,testId,target,covers,evidenceDigest}，
     stdout 只输出单个结果 JSON {testId,target,checks:[{storyId,label,expected,actual,evidence}]}，
     日志写 stderr，退出码由宿主实测（驱动自报不能覆盖实测）。

五项运行时自检（平台 L2-5；错误分类 R2/A3/R3 见品类模版 §5.3）：
  ① storyId 非空校验（R2 类）：acceptance 模式（stdin covers 非空）下 make_check 拒绝
     空串/None 的 storyId，错误消息指明 R2 类问题；辅助测试（covers 为空）storyId 必须为 None。
  ② expected/actual 同源生成（A3 类）：actual 必须由 probe（可调用）真实探测产生；
     assert_same_source(expected_const, probe_fn) 断言同源——A3 类教训 [实证]：
     禁止把 actual 手写成 expected 的同义文案（期望"语音输入已开启"不得拿"语音输入打开"当通过）。
  ③ 输出 JSON schema 校验 + 退出码表：emit_result 序列化前自校验
     （testId/target 来自 stdin、checks 非空、每条字段形态合法、evidence 非空字符串数组）。
  ④ 顶层异常包裹（R3 类）：run_guarded 以 except BaseException 捕获（含 SystemExit，
     覆盖填充代码里的 sys.exit 路径），转结构化 error JSON
     （含 type、exit_code、traceback 摘要=末 5 帧）后以原退出码非零退出，完整 traceback 写 stderr——
     崩溃也产出可判读输出，不再静默。os._exit 与信号（SIGSEGV 等）进程内不可拦截，
     该路径由平台侧 P0-2 stderr 尾部透传兜底。
  ⑤ 环境前置自检：check_environment 在驱动逻辑运行前检查 DISPLAY / 密钥类变量
     （只声明变量名，值从环境读、不硬编码、不写进任何文件）。缺失 → 输出含
     "环境前置自检"检查项的结构化结果并 exit 2（blocked），环境问题不伪装成产品 error。
     语义说明：宿主把 exit≠0 且含 fail 检查的结果判为 fail/error——环境自检条目的
     label/actual 明示"环境前置自检 / 缺失: XXX"，验收方能据此把环境缺失与产品缺陷区分开。
     回归测试态注入（仅平台测试用，业务勿用）：
     NANJU_DRIVER_SKELETON_TEST_DISPLAY_MISSING=1 模拟 DISPLAY 缺失；
     NANJU_DRIVER_SKELETON_TEST_KEY_MISSING=1 模拟密钥类变量缺失。

退出码表：0=全部 pass；1=存在 fail 检查或驱动异常（结构化 error JSON）；2=自检拦截（环境缺失/结构违规）。
"""
import json
import os
import sys
import traceback

# ===== 驱动配置（按项目实际修改）=====
REQUIRED_DISPLAY = False            # 桌面/图形类驱动置 True（检查 DISPLAY）
REQUIRED_ENV_VARS = ['MY_API_KEY']  # 本驱动所需密钥类变量名（样例名；值从 env 读，不硬编码；无需密钥则置 []）

_LAST_REQUEST = None  # stdin 请求缓存（error 兜底输出 testId/target 用）
_EXIT_OK = None       # 框架表内退出标记（区别填充代码里任意的 sys.exit）


class DriverSelfCheckError(Exception):
    """驱动自检拦截（R2 类 storyId 违规、stdin 结构违规等）。被 ④ 顶层包裹转结构化 error JSON。"""


def check_environment():
    # type: () -> list
    """⑤ 环境前置自检：返回缺失项列表（空列表=环境就绪）。"""
    missing = []
    if os.environ.get('NANJU_DRIVER_SKELETON_TEST_DISPLAY_MISSING') == '1':
        missing.append('DISPLAY')  # 回归测试注入态：模拟该项被检测为缺失
    elif REQUIRED_DISPLAY and not os.environ.get('DISPLAY'):
        missing.append('DISPLAY')
    if os.environ.get('NANJU_DRIVER_SKELETON_TEST_KEY_MISSING') == '1':
        missing.extend(REQUIRED_ENV_VARS)  # 回归测试注入态：模拟清单内全部缺失
    else:
        missing.extend(name for name in REQUIRED_ENV_VARS if not os.environ.get(name))
    return missing


def _write_stdout(payload):
    # type: (dict) -> None
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def _exit_table(code):
    # type: (int) -> None
    """按退出码表退出（0/1/2），并标记为框架合法退出。"""
    global _EXIT_OK
    _EXIT_OK = code
    sys.exit(code)


def make_check(story_id, label, expected, actual_or_probe, evidence=None):
    # type: (object, str, object, object, object) -> dict
    """①+② 检查工厂：返回一条宿主协议形态的 check dict。

    - acceptance 模式（stdin covers 非空）：story_id 必须非空字符串（R2 类校验）；
      辅助模式（covers 为空）：story_id 必须为 None。
    - actual_or_probe 传可调用（probe 函数）→ 调用取实际值（② 同源生成，推荐路径）；
      传字符串 → 直接作为 actual（仅开发期联调；A3 类同义文案风险自负，正式断言一律用 probe）。
    """
    req = _LAST_REQUEST or {}
    covers = req.get('covers') or []
    if covers:
        if story_id is None or story_id == '':
            raise DriverSelfCheckError(
                'R2 类驱动缺陷：acceptance 驱动（stdin covers='
                + json.dumps(covers, ensure_ascii=False)
                + '）的检查 storyId 为空。storyId 必须逐字使用 PRD 用户故事编号（如 US-01），不得留空。')
    else:
        if story_id is not None:
            raise DriverSelfCheckError(
                '辅助测试（covers 为空）的 storyId 必须为 None，收到：' + repr(story_id))
    actual = actual_or_probe() if callable(actual_or_probe) else actual_or_probe
    to_str = lambda v: v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)  # noqa: E731
    return {
        'storyId': story_id,
        'label': label,
        'expected': to_str(expected),
        'actual': to_str(actual),
        'evidence': list(evidence) if evidence else [label + '（未提供 evidence，默认占位）'],
    }


def assert_same_source(expected_const, probe_fn):
    # type: (object, object) -> tuple
    """② 同源断言辅助：actual 必须来自 probe_fn() 的真实探测。

    A3 类教训 [实证]：期望"语音输入已开启"时，把 actual 手写成"语音输入打开"（同义文案）
    会造成错位比对或假 pass。本辅助强制 actual 只能由 probe 产生：
    返回 (actual, passed)——probe 返回与 expected 逐字相同 → passed=True；不同 → passed=False
    （fail 如实暴露产品行为不符，禁止改写 actual 去凑 expected）。
    """
    actual = probe_fn()
    return actual, actual == expected_const


def _validate_checks(checks):
    # type: (object) -> list
    """③ 输出 schema 自校验：返回违规问题列表（空列表=合法）。"""
    problems = []
    if not isinstance(checks, list) or not checks:
        return ['checks 必须是非空数组（宿主协议 checks:[{storyId,label,expected,actual,evidence}]）']
    for i, c in enumerate(checks):
        if not isinstance(c, dict):
            problems.append('checks[%d] 必须是对象' % i)
            continue
        sid = c.get('storyId')
        if not (sid is None or (isinstance(sid, str) and sid != '')):
            problems.append('checks[%d].storyId 非法：必须是非空字符串或 null' % i)
        for key in ('label', 'expected', 'actual'):
            if not isinstance(c.get(key), str):
                problems.append('checks[%d].%s 必须是字符串' % (i, key))
        ev = c.get('evidence')
        if not (isinstance(ev, list) and ev and all(isinstance(x, str) and x for x in ev)):
            problems.append('checks[%d].evidence 必须是非空字符串数组' % i)
    return problems


def _guard_check(label, expected, actual, evidence):
    # type: (str, str, str, list) -> dict
    """自检拦截条目（环境/schema）：手工构造合法形态（不经 make_check，避免二次校验耦合）。"""
    req = _LAST_REQUEST or {}
    covers = req.get('covers') or []
    return {
        'storyId': covers[0] if covers else None,
        'label': label,
        'expected': expected,
        'actual': actual,
        'evidence': evidence,
    }


def emit_blocked(missing):
    # type: (list) -> None
    """⑤ 环境缺失 → 结构化 blocked 输出 + exit 2（自检拦截）。"""
    _write_stdout({
        'testId': (_LAST_REQUEST or {}).get('testId'),
        'target': (_LAST_REQUEST or {}).get('target'),
        'checks': [_guard_check(
            '环境前置自检',
            '环境就绪',
            '缺失: ' + ', '.join(missing),
            ['环境自检拦截（exit 2=blocked）：驱动未运行，环境缺失不伪装成产品 error'])],
    })
    _exit_table(2)


def emit_result(checks):
    # type: (list) -> None
    """③ 输出 + 退出：schema 自校验（违规 → exit 2），单 JSON 写 stdout，
    退出码按表：全部 expected==actual → 0；否则 1。"""
    req = _LAST_REQUEST or {}
    problems = _validate_checks(checks)
    if problems:
        _write_stdout({
            'testId': req.get('testId'),
            'target': req.get('target'),
            'checks': [_guard_check(
                '输出schema自检',
                'checks 形态合法（宿主协议 {storyId,label,expected,actual,evidence}）',
                '结构违规: ' + '; '.join(problems),
                ['自检拦截（exit 2）：驱动输出了宿主无法判读的 checks'])],
        })
        _exit_table(2)
    _write_stdout({'testId': req.get('testId'), 'target': req.get('target'), 'checks': checks})
    _exit_table(0 if all(c['expected'] == c['actual'] for c in checks) else 1)


def emit_error(exc, exit_code):
    # type: (BaseException, int) -> None
    """④ 崩溃兜底：结构化 error JSON 到 stdout（唯一 stdout 输出），完整 traceback 到 stderr。"""
    req = _LAST_REQUEST or {}
    tb_text = traceback.format_exc()
    frames = [line.strip() for line in tb_text.splitlines() if line.strip().startswith('File ')]
    _write_stdout({
        'testId': req.get('testId') if req else None,
        'target': req.get('target') if req else None,
        'checks': [],
        'error': {
            'type': type(exc).__name__,
            'exit_code': exit_code,
            'message': (str(exc)[:500] or '(no message)'),
            'traceback_summary': frames[-5:],  # 末 5 帧
        },
    })
    sys.stderr.write(tb_text + '\n')
    sys.stderr.flush()


def run_probes(request):
    # type: (dict) -> list
    """填充点：实现真实探测并返回 checks 列表（用 make_check 组装）。

    照抄未填充时的默认行为：返回一条 TODO fail 检查（exit 1）——骨架永不静默、永不假 pass。
    """
    covers = request.get('covers') or []
    return [make_check(
        covers[0] if covers else None,
        'TODO: 替换为真实 probe',
        '真实探测结果',
        '骨架未填充 run_probes',
        ['照抄骨架默认检查：填充 run_probes 后本条消失'],
    )]


def main():
    # type: () -> None
    """驱动主流程：读 stdin → ⑤ 环境自检 → run_probes（填充点）→ ③ emit_result。"""
    global _LAST_REQUEST
    raw = sys.stdin.read()
    try:
        _LAST_REQUEST = json.loads(raw) if raw.strip() else {}
    except ValueError as e:
        raise DriverSelfCheckError(
            'stdin 不是合法 JSON（宿主协议要求 {schemaVersion,testId,target,covers,evidenceDigest}）：' + str(e))
    missing = check_environment()
    if missing:
        emit_blocked(missing)
        return
    checks = run_probes(_LAST_REQUEST)
    emit_result(checks)


def run_guarded():
    # type: () -> None
    """④ 顶层异常包裹入口：except BaseException（含 SystemExit）。

    - 框架表内退出（emit_result / emit_blocked 的 0/1/2）：原样重发；
    - 填充代码里任意的 sys.exit(N)（表外）：结构化 error JSON（type=SystemExit、exit_code=N）
      后以原退出码非零退出（N=0/None 也按 1 退出——未输出结果就退出即静默，防静默优先）；
    - 其他任何异常：结构化 error JSON 后 exit 1。
    os._exit 与 SIGSEGV 等信号进程内不可拦截——由平台侧 P0-2 stderr 尾部透传兜底。
    """
    try:
        main()
    except SystemExit as e:
        code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
        if _EXIT_OK == code:
            raise
        emit_error(e, code)
        sys.exit(code if code != 0 else 1)
    except BaseException as e:  # noqa: BLE001 —— 故意覆盖一切异常（ATK-Z-005：含 SystemExit 之外的盲区）
        emit_error(e, 1)
        sys.exit(1)


if __name__ == '__main__':
    run_guarded()

#!/usr/bin/env bash
# F-01 反例：check_env.sh 探测脚本 fail-open（未装组件被标 ok）
#
# 复跑：在 audit-current/resources/ 下运行 `./negative/f01-check-env-fail-open.sh`
# 或 `bash negative/f01-check-env-fail-open.sh`。脚本不修改任何文件；产物落 /tmp。
#
# 期望反例输出（至少 4 行 BUG：）：
#   BUG: webkit2gtk-4.0 version=missing but status=ok
#   BUG: pynput version=missing but status=ok
#   BUG: pystray version=missing but status=ok
#   BUG: portaudio version=missing but status=ok
#
# 反例论证：
#   probe 函数依赖 `out=$(eval "$cmd" 2>&1)` 的退出码。
#   探测行 `python3 -c 'import pynput; print(pynput.__version__)' 2>/dev/null || echo missing`
#   的 `|| echo missing` 让 eval 永远成功退出（即使 pynput 未装），out="missing" 走 ok 分支。
#   这是 fail-open 设计错误：未装组件被乐观报告为「可用」。
#   修复方向：探测函数识别 version === 'missing' 强制改 status=fail；或类别扩展 probe 拆分为两条命令。

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# 反例脚本常驻 docs/reports/2026-09-20-phase1/execution/audit-current/resources/negative/；
# 目标 check_env.sh 在 apps/electron/resources/nanju-engineering-templates/，绝对路径防漂移。
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../../../../../../.." && pwd)"
CHECK_ENV="${PROJECT_ROOT}/apps/electron/resources/nanju-engineering-templates/check_env.sh"

if [ ! -f "$CHECK_ENV" ]; then
  echo "FATAL: check_env.sh not found at $CHECK_ENV" >&2
  exit 2
fi

OUT="$(mktemp -t f01-check-env-XXXXXX.json)"
trap 'rm -f "$OUT"' EXIT

# 跑 desktop 扩展（包含最容易被 fail-open 命中的探测项）
timeout 15 bash "$CHECK_ENV" desktop-app > "$OUT" 2>&1 || true

echo "=== 原始输出（前 5 行） ==="
head -n 5 "$OUT"
echo

# 反例：列出 status='ok' 但 version='missing' 的组件
echo "=== F-01 反例：status=ok 但 version=missing 的组件 ==="
bug_count=0
python3 - "$OUT" <<'PY'
import json, sys
path = sys.argv[1]
bug_count = 0
with open(path) as f:
    for line in f:
        line = line.strip()
        if not line.startswith('{'):
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        if d.get('status') == 'ok' and d.get('version') == 'missing':
            print(f"BUG: {d['component']} version=missing but status=ok")
            bug_count += 1
print(f"--- bug_count={bug_count} ---")
PY
echo

# 反例断言：必须 >= 1 行 BUG；否则 fail-open 已修复
bug_count="$(python3 - "$OUT" <<'PY'
import json, sys
path = sys.argv[1]
c = 0
with open(path) as f:
    for line in f:
        line = line.strip()
        if not line.startswith('{'):
            continue
        try:
            d = json.loads(line)
        except Exception:
            continue
        if d.get('status') == 'ok' and d.get('version') == 'missing':
            c += 1
print(c)
PY
)"

echo "BUG 计数：$bug_count"
if [ "$bug_count" -ge 1 ]; then
  echo "F-01 反例触发：fail-open 中探测 已被复现（脚本可在此结论）"
  exit 0
else
  echo "F-01 反例未触发：check_env.sh 可能已被修复，请人工复核"
  exit 1
fi
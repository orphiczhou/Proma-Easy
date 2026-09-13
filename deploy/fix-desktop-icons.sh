#!/usr/bin/env bash
# 修复桌面图标不显示/双击无反应（xrdp + Cinnamon 环境下 nemo-desktop
# 会话启动竞争导致 "Desktop already managed ... skipping desktop setup"，
# 图标完全不渲染，双击位置是空白桌面）。
# 用法：任意终端运行  bash ~/proma-easy/fix-desktop-icons.sh
export DISPLAY="${DISPLAY:-:10.0}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=/tmp/dbus-I9B5oC7Fse}"

echo "[1/3] 重启 nemo-desktop（杀掉竞争实例）..."
pkill -x nemo-desktop 2>/dev/null
sleep 2

echo "[2/3] 以独占模式启动..."
setsid nemo-desktop --replace </dev/null >/tmp/nemo-desktop-replace.log 2>&1 &
sleep 3

PID=$(pgrep -x nemo-desktop | head -1)
if [ -n "$PID" ]; then
  echo "[3/3] nemo-desktop 运行中 (PID $PID)。"
  if grep -q "already managed" /tmp/nemo-desktop-replace.log 2>/dev/null; then
    echo "⚠ 仍报告桌面被占用，5 秒后重试一次..."
    sleep 5; pkill -x nemo-desktop 2>/dev/null; sleep 2
    setsid nemo-desktop </dev/null >>/tmp/nemo-desktop-replace.log 2>&1 &
    sleep 3
  fi
  echo "✓ 完成。桌面图标应在左上角渲染；请双击测试。"
else
  echo "✗ nemo-desktop 未能启动，请查看 /tmp/nemo-desktop-replace.log"
fi

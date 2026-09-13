#!/usr/bin/env bash
# Proma-Easy Dev 启动器（可与 Release 同时运行）
# 配置目录: ~/.proma-dev | userData: ~/.config/Proma-dev | 图标: 橙色 DEV 角标
# 任务栏: WM_CLASS=proma-dev + _NET_WM_ICON=橙角标（与 release 分组分离）
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export DISPLAY="${DISPLAY:-:10.0}"
# 启动追踪日志：记录每次触发（含从桌面双击/终端/gio 启动），便于排查“双击没反应”时
# 判断事件到底有没有走到脚本（无记录=Nemo/桌面层问题，有记录=应用层问题）
echo "[$(date '+%F %T')] start-dev.sh 触发 | caller-env: DISPLAY=$DISPLAY DBUS=${DBUS_SESSION_BUS_ADDRESS:-<无>} DESKTOP_STARTUP_ID=${DESKTOP_STARTUP_ID:-<无>} argv=$*" >> /tmp/proma-dev-launch.log

# 清理 dev 实例可能残留的锁（主进程已死但锁文件未清时）
if [ -e "$HOME/.config/Proma-dev/SingletonLock" ]; then
  LOCK_PID=$(readlink "$HOME/.config/Proma-dev/SingletonLock" 2>/dev/null | grep -o '[0-9]*$' || true)
  if [ -n "$LOCK_PID" ] && ! kill -0 "$LOCK_PID" 2>/dev/null; then
    rm -f "$HOME/.config/Proma-dev/SingletonLock"           "$HOME/.config/Proma-dev/SingletonSocket"           "$HOME/.config/Proma-dev/SingletonCookie"
    # 清扫孤儿子进程（同 release 侧说明）
    pgrep -f "proma-easy/dev/app/proma-dev.*--type=" 2>/dev/null | while read -r pid; do
      [ "$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')" = "1" ] && kill -9 "$pid" 2>/dev/null
    done
    echo "[dev] 已清理失效锁文件与孤儿子进程"
  fi
fi

# 首次运行：从 release 复制渠道配置（API Key），保证开箱可用
if [ ! -f "$HOME/.proma-dev/channels.json" ] && [ -f "$HOME/.proma/channels.json" ]; then
  mkdir -p "$HOME/.proma-dev"
  cp "$HOME/.proma/channels.json" "$HOME/.proma-dev/channels.json"
  echo "[dev] 已从 release 复制渠道配置到 ~/.proma-dev/"
fi

# 启动（后台运行，稍后改写窗口属性再 wait）
env -u ELECTRON_RUN_AS_NODE \
  PROMA_INSTANCE=dev \
  PROMA_DEV=1 \
  PROMA_ICON="$SCRIPT_DIR/icon-dev-green.png" \
  "$SCRIPT_DIR/app/proma-dev" --remote-debugging-port=9224 --remote-allow-origins="*" "$@" &
APP_PID=$!

# X11 层窗口属性看门狗（Electron 框架把主窗口 WM_CLASS 硬编码为产品名，
# app.setName / --class / 改二进制名均无效；且主窗会被销毁/重建——如从托盘
# 重新打开——新窗口又变回默认类名和图标。因此不能只在启动时改写一次，
# 改为随应用存活的轮询看门狗：set-window-props.py 幂等，无差异时零操作）
(
  ok=""
  while kill -0 "$APP_PID" 2>/dev/null; do
    if out=$(python3 "$SCRIPT_DIR/set-window-props.py" "$APP_PID" proma-dev Proma-dev "$SCRIPT_DIR/icon-dev.argb" 2>/dev/null); then
      [ -n "$out" ] && echo "$out"
      ok=1
    fi
    sleep 2
  done
  [ -n "$ok" ] || echo "[dev] 警告: 运行期间未能改写窗口属性" >&2
) &

wait $APP_PID

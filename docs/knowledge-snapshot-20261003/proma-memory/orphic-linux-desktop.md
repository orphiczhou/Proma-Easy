# orphic 的 Linux 桌面环境（输入法相关）

- 机器：Ubuntu 24.04.1 + Cinnamon + X11（DISPLAY=:10.0，远程桌面场景），用户 orphic。
- 中文输入法：搜狗拼音，运行在 fcitx 4.2.9.9（fcitx-sogoupinyin addon）之下。`~/.xinputrc` = fcitx，登录由 im-launch 拉起。
- 2026-08-20 修复过「搜狗叫不起来」问题，根因两条：
  1. `~/.config/fcitx/config` 里 `TriggerKey=` 被置空（显式禁用热键），Ctrl+Space 调不出输入法；
  2. ibus-daemon 与 fcitx 同时运行，抢键盘输入。
  修复：杀掉 ibus（无 autostart 项，不会复活）+ 恢复 TriggerKey 默认 CTRL_SPACE（fcitx 会把等于默认值的项以 `#` 注释形式保存，属正常，重启后仍生效）。
- 同日晚间：用户远程桌面会拦截 Ctrl+Space，已改为 **TriggerKey=CTRL_.（Ctrl+句号）** 切换中英文（RDP 不拦，重启后仍生效）；并将 fcitx 主状态面板固定显示在右下角（`fcitx-classic-ui.config`：MainWindowOffsetX=1900/Y=920、MainWindowHideMode=Show，屏幕 2200x1000），鼠标点击面板即可双向切换。Shift 备用触发键在此搜狗 fcitx 版上无效（SwitchKey 总被重置为 Disabled），勿再尝试。
- 诊断经验：
  - `fcitx-remote` 无参数返回值：0=连不上/未运行，1=英文态，2=激活态；`fcitx-remote -s sogoupinyin` 切引擎。
  - 用 xdotool 模拟按键可无头验证热键。
  - sogoupinyin-service 启动日志里的 `sgim_gd_cell.bin copy fail`、`fcitx-sogoupinyinhxm ABI Version Error`、`fcitx-keyboard-us already exists` 均为已知噪音，不影响输入。
  - 手动重启 fcitx 前先 `pkill -f "fcitx -d"` 并删残留 socket `/tmp/fcitx-socket-*`，否则可能连不上（状态恒为 0）。
- 复发排查顺序：先看 `~/.config/fcitx/config` 的 TriggerKey 是否被改成空，再看有没有 ibus-daemon 进程，再看 fcitx-remote 状态。

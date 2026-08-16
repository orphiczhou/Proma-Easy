# PR: 修复 Linux 桌面环境下双击快捷方式无法启动/退出 Proma 的问题

> **PR 范围**：`06b82e7..bf70b0d`（v0.16.74 → v0.16.81，6 个 fix 提交）
> **目标分支**：`main` ← `linux-support`
> **测试环境**：xrdp + Cinnamon (Nemo/Muffin) + Electron 43.2.0，双实例部署（release / dev）实测通过

---

## Summary

Linux 桌面环境下，用户双击桌面快捷方式无法启动/唤起 Proma 主窗口；关闭窗口后进程残留无法退出。本 PR 通过**四层递进修复**彻底解决该问题：单实例锁竞争治理、X11 窗口状态失联检测、托盘可用性感知、退出流程防挂死。全状态矩阵（冷启动/正常/最小化/失联/重复实例/退出）实测通过。

## 用户报告的症状

1. 双击桌面图标"没反应"——无窗口出现，看似什么都没发生
2. 进程实际在后台残留（持有单实例锁），后续双击永远无效
3. 无任何 UI 途径退出残留进程（点 X 窗口消失但进程还在）

## 根因分析（故障树）

真实故障是**四层问题叠加**，单独修任何一层都不够：

### 层 1：单实例锁失败进程的僵尸初始化（v0.16.77 修复）

拿不到单实例锁的第二个进程打印"将退出"后，`app.quit()` 是异步的，而
`app.whenReady().then(bootstrap)` 已无条件注册——于是它跑完了完整初始化
（二次托盘、二次快速任务窗、抢注 bridge 端口）才退出。用户看到"点了闪一下
全没了"；若此时序卡住，还会抢走主实例资源。

### 层 2：X11 窗口状态失联——Electron 对象与 X 窗口脱节（v0.16.80 修复，核心）

主窗被关闭/隐藏后，**Electron 窗口对象存活（`isDestroyed()=false`、
`isVisible()` 恒返回 `true`），但底层 X 窗口已被 WM 回收**。此时
`restore()/show()/focus()` 全部成为无效调用——second-instance 唤起链路
"看起来正常"（日志全部打出）却唤不出任何窗口。

这是最难定位的一层：所有 Electron API 层的状态检查都是"正常"的，
必须下沉到 X 协议层（`xprop -id <handle> WM_STATE`）才能发现窗口已不存在。

### 层 3：托盘不可用环境的退出死局（v0.16.81 修复）

xrdp 等远程桌面环境下，Electron `Tray` 构造不报错，但 StatusNotifierItem
注册**静默失败**（DBus 上查无 `org.kde.StatusNotifierItem-<pid>-*`）——
托盘图标无处显示。close-to-tray 拦截让窗口"消失"，而托盘菜单（含退出项）
无从访问，进程持有单实例锁苟活：**UI 上零退出路径**。

### 层 4：退出流程挂死（v0.16.81 修复）

放行 close 后，`closed` 回调里同步 `app.quit()` 与窗口销毁链嵌套；
before-quit 清理链中再抛异常会触发 Electron 默认 Error 弹窗，quit 整体
挂死、进程僵而不死。

### 附：环境层问题（非本 PR 范围，记录供排查）

Nemo 桌面进程在会话启动竞争后放弃图标渲染（`Desktop already managed ...
skipping desktop setup`），用户双击的"图标"位置实为空白桌面。该问题在
Proma 之外，通过重启 nemo-desktop 解决；但层 1-4 修复保证了**无论桌面层
状态如何，一旦事件到达应用层，行为必然正确**。

## 逐提交说明

| 提交 | 版本 | 修复 |
|---|---|---|
| `06b82e7` | v0.16.74 | Linux 主窗 close-to-tray 拦截（避免销毁后靠辅助窗苟活） |
| `10ac9fa` | v0.16.75 | second-instance 唤起后 `moveTop()` 强制置顶（X11 WM 防抢焦点策略下窗口被全屏窗口遮挡） |
| `7301230` | v0.16.76 | 无条件 `restore()`（Electron `isMinimized()` 与 WM `Iconic` 状态不同步） |
| `9f0f869` | v0.16.77 | 单实例锁失败置 `isDuplicateInstanceQuitPending` 标志，`bootstrap()` 开头短路，消除重复实例的完整僵尸初始化 |
| `c79aff6` | v0.16.80 | **核心**：`showAndFocusMainWindow` 在 Linux 上用 `xprop` 校验 `getNativeWindowHandle()` 对应 X 窗口是否仍有 `WM_STATE`；失联则 `destroy()` + `createWindow()` 强制重建；close-to-tray 由 `hide()`（制造失联态）改为 `minimize()+skipTaskbar`（X 窗口保持 Iconic 映射不被回收） |
| `bf70b0d` | v0.16.81 | 启动 1.5s 后用 `dbus-send` 查 DBus `ListNames` 确认 SNI 注册结果（`isTrayRegistered()`）；托盘真可用才 close-to-tray，不可用则点 X 直接退出；`closed` 延迟 100ms 再 quit 避免嵌套；`createWindow` 在退出流程中短路；`uncaughtException` 兜底 `app.exit(1)` 保证退出必达 |

## 验证矩阵（xrdp + Cinnamon 实测）

| 场景 | 结果 |
|---|---|
| 冷启动（无实例）双击图标 | ✅ 3s 出主窗 |
| 正常显示时双击图标 | ✅ 同窗口唤起（无误伤重建） |
| 最小化后双击图标 | ✅ 同窗口 restore |
| X 窗口失联态双击图标 | ✅ 检测失联 → 销毁重建 → 新窗口可见 |
| 重复启动第二实例 | ✅ 安静退出，零僵尸初始化（9 行日志） |
| 无托盘环境点 X | ✅ 窗口销毁 + 全部进程干净退场（9→0） |
| 重建窗口后再点 X | ✅ 依然干净退出（quit 防挂死生效） |
| 回归：typecheck + 单测 | ✅ 379 tests passed |

关键测试方法说明：
- 模拟"用户点 X"用 `WM_DELETE_WINDOW` ClientMessage（标准 WM 关闭协议），
  而非 `xdotool windowclose`（后者直接 XDestroyWindow，绕过应用层 close 事件，
  早期测试被此差异误导）
- X 窗口真实状态以 `xprop WM_STATE`（Normal/Iconic/Withdrawn）为准，
  不信 `xwininfo IsViewable`（frame 口径误导）
- 本环境 XTEST 合成鼠标事件不被 GTK 处理，真实双击由人工验证 ✅

## 风险评估与回滚

- 所有新行为仅 `process.platform === 'linux'` 生效，macOS/Windows 路径零改动
- 托盘检测（`dbus-send` 查询）失败时按"托盘不可用"处理 → 点 X 退出，行为保守安全
- X 失联重建仅在 `xprop` 查询失败（窗口确已消失）时触发，正常窗口零影响
- 回滚：revert 对应提交即可，各修复相互独立、无数据迁移

---

Made with [Proma](https://proma.cool) · [GitHub](https://github.com/proma-ai/Proma)

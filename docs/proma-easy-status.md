# Proma-Easy（南大向导）项目状态文档

> 更新时间：2026-08-17 | 当前版本：v0.16.82 | 分支：linux-support

---

## 一、项目概述

Proma-Easy 是基于 [Proma](https://github.com/ErlichLiu/Proma) (v0.16.40) 的 fork，实现了"南大向导"Agent 开发平台——让零编程基础的用户通过自然语言对话完成软件需求→设计→交付的全闭环。

- **代码仓库**：`/home/orphic/proma-source`，分支 `linux-support`
- **GitHub Fork**：`github.com/orphiczhou/Proma-Easy.git`（remote: `easy`，push 因网络/对象损坏问题暂未成功）
- **设计文档**：`/home/orphic/proma-projDoc/DesignDoc/`（PRD + 用户故事 + UX 交互规范）
- **架构设计**：`docs/nanju-v2.3-design.md`（三层 AC 审计收敛版）

---

## 二、核心架构

### 2.1 两层固定路由 Harness（v2.3）

```
L1 调度员（主会话 Agent）
  ├─ canUseTool 硬门禁（不能自己写代码/文档）
  ├─ delegate_agent → 委派 L2 角色子会话（跨渠道跨模型）
  ├─ wait_for_delegations → 等待 + 代答子会话问题
  ├─ PHASE_ADVANCE 标记 → Harness 代码检测推进
  └─ v0.16.70: 推进后自动续接下一阶段（1.5秒后自动 sendMessage）

L2 角色子会话（跨渠道跨模型）
  ├─ 产出文件（PRD/原型/架构/工程计划）
  ├─ AC 对抗审计（inline subAgent，异构模型）
  │   ├─ Attacker: 不同家族模型审查（如 GLM 审查 DeepSeek 产出）
  │   ├─ Defender: 对照攻击者发现用证据反驳/确认
  │   └─ Red → 修复 → 重审（L2 自己驱动，不需要人工）
  └─ allowSubDelegation 机制（v0.16.69 新增，三层放行）
```

### 2.2 阶段路由

| 阶段 | 角色 | 渠道/模型 | 产出文件 | AC |
|------|------|----------|----------|-----|
| requirements | 需求分析师 | deepseek/v4-pro | 01_PRD/prd.md | 否（PRD 直接确认） |
| prototype | UX 顾问 | glm-zhipu/glm-5.2 | 02_UX_DESIGN/prototype.html | 否 |
| architecture | 架构师 | deepseek/v4-pro | 03_ARCHITECTURE/architecture.md | 是 |
| planning | 工程经理 | deepseek/v4-pro | 05_PROJECT_PLAN/plan.md | 否 |

快消型模式：requirements → prototype → delivered
长期迭代型：requirements → prototype → architecture → planning → delivered

---

## 三、实现文件清单

### 主进程（src/main/lib/）

| 文件 | 行数 | 作用 | 版本 |
|------|------|------|------|
| nanju-router.ts | 243 | 路由状态机定义 + 异构 AC 模型配置 | v0.16.69 |
| nanju-router-gate.ts | 138 | canUseTool 硬门禁 + 文件验证 | v0.16.62 |
| nanju-router-prompt.ts | 179 | 调度员 systemPrompt 生成（含 L2 AC 指令） | v0.16.69 |
| nanju-project.ts | 174 | 项目元数据管理（原子写 JSON） | v0.16.53 |
| nanju-preview-watcher.ts | 128 | 文件监听（Linux 递归修复） | v0.16.69 |
| nanju-ipc.ts | 153 | IPC handlers 注册 | v0.16.53 |
| nanju-orchestrator.ts | 166 | 角色编排（旧版，部分 deprecated） | v0.16.53 |
| nanju-phase-gate.ts | 318 | 旧版阶段门禁（deprecated，保留兼容） | v0.16.60 |
| nanju-snapshot.ts | 101 | 项目快照管理 | v0.16.53 |
| nanju-telemetry.ts | 89 | 埋点记录 | v0.16.53 |
| agent-orchestrator.ts | ~2269 | PHASE_ADVANCE 检测 + 自动续接 | v0.16.70 |
| agent-collaboration-tools.ts | ~1110 | delegate_agent + allowSubDelegation | v0.16.69 |
| agent-collaboration-utils.ts | ~140 | buildDelegationPrompt | v0.16.69 |
| adapters/pi-builtin-tools.ts | ~920 | collaboration 工具注册条件 | v0.16.69 |

### 渲染进程

| 文件 | 作用 | 版本 |
|------|------|------|
| components/nanju/ModeSelectView.tsx | 快消型/长期迭代型选择 | v0.16.47 |
| components/nanju/NanjuWorkspaceView.tsx | 左右分屏布局（当前未使用） | v0.16.55 |
| components/nanju/ProjectListView.tsx | 项目列表 | v0.16.58 |
| components/app-shell/AppShell.tsx | 工作区入口 + 文件监听启动 | v0.16.71（移除预览 handler） |
| hooks/useGlobalAgentListeners.ts | **全局预览监听**（v0.16.71 迁移到此） | v0.16.71 |
| components/tabs/MainArea.tsx | 预览面板分屏渲染 | v0.16.55 |
| components/tabs/TabContent.tsx | 项目创建 → 会话 Tab 切换 | v0.16.47 |

---

## 四、版本变更历史（v0.16.62 - v0.16.72）

| 版本 | 内容 |
|------|------|
| v0.16.62 | 实现 v2.3 固定路由 Harness（替代 tree-engine） |
| v0.16.63 | 代码审计 R1 修复（0 red, 3 yellow + 4 green） |
| v0.16.64 | 修复 mcp__collaboration__ 前缀缺失 |
| v0.16.65 | 修复 PRD 预览面板不弹出（第一次尝试） |
| v0.16.66 | 修复委派子会话 AskUserQuestion 对话框 |
| v0.16.67 | 回退 UI 冒泡，改用 Proma 原始 Agent 层代答 |
| v0.16.68 | 修复预览分屏+阶段推进+AC审计（未完全解决） |
| v0.16.69 | **AC 从 L1 移到 L2 内部驱动 + Linux fs.watch 递归修复 + allowSubDelegation 三层放行** |
| v0.16.70 | **PHASE_ADVANCE 后自动续接下一阶段** |
| v0.16.71 | **预览面板监听移至全局 hook（消除竞态条件）** |
| v0.16.72 | **打包模式多实例支持**：`PROMA_INSTANCE` 隔离 userData / `PROMA_ICON` 覆盖窗口图标；配套 `/home/orphic/proma-easy/` 双实例部署（release + dev 并存，详见第九节） |
| v0.16.73 | **Linux close-to-tray**：主窗关闭时隐藏而非销毁（此前销毁后隐藏的快速任务窗使进程残留成无头僵尸持锁，双击快捷方式表现为"没反应"；现关闭→hide，双击→show 秒回）。配套 start 脚本增加孤儿清扫 + SingletonSocket 清理 |
| v0.16.74 | （版本号被 74237e2 预览面板修复使用，内容见上行 v0.16.73 描述合并） |
| v0.16.75 | **second-instance 唤起窗口 moveTop 强制置顶**：Muffin 防抢焦点策略拒绝 show() 的抬升请求（启动器已退出无激活上下文），窗口映射但停在堆叠底部被全屏窗口（如 VSCode）遮挡，表现为"双击转圈后无窗口"；moveTop() 无视策略强制抬升 |
| v0.16.76 | **无条件 restore() 修复 WM 最小化后唤不回**：窗口被任务栏/WN 最小化（WM_STATE=Iconic）后 Electron isMinimized() 仍为 false（只跟踪自身 API），showAndFocusMainWindow 跳过 restore 直接 show() 对 Iconic 无效 → 双击无反应（任务栏有图标）。改为无条件 restore()（对正常窗口 no-op）。另：桌面旧 proma.desktop（仓库构建入口，与 release 抢锁）已删除 |
| v0.16.77 | **单实例锁失败进程 bootstrap 短路**：拿不到锁的第二实例在 `app.quit()`（异步）生效前跑完整初始化（二次托盘/快速任务窗/抢 bridge 端口）成僵尸。锁失败置 `isDuplicateInstanceQuitPending` 标志，`bootstrap()` 开头短路 |
| v0.16.80 | **second-instance 唤起加 X 层失联校验（核心）**：主窗关闭/隐藏后 Electron 对象存活（isDestroyed=false、isVisible 恒 true）但底层 X 窗口已被 WM 回收——restore()/show() 全部无效，双击唤不出窗口。修复：Linux 下用 `xprop` 校验 `getNativeWindowHandle()` 对应 X 窗口是否仍有 WM_STATE，失联则 destroy()+createWindow() 重建；close-to-tray 由 hide()（制造失联态）改为 minimize()+skipTaskbar（X 窗口保持 Iconic 不被回收） |
| v0.16.81 | **无托盘环境点关闭真退出 + quit 防挂死**：Tray 构造不报错但 xrdp 下 SNI 注册静默失败（图标不显示），close-to-tray 使点 X 后进程持有单实例锁苟活、UI 零退出路径。修复：启动 1.5s 后 dbus-send 查 SNI 注册结果（isTrayRegistered()），托盘不可用则不拦截 close、closed 里延迟 100ms app.quit()；createWindow 在退出流程短路；uncaughtException 兜底 app.exit(1) 保证退出必达。另：v0.16.74~81 完整故障树与验证矩阵见 `docs/pr-linux-desktop-launch-fix.md` |
| (docs) | PR 文档 `docs/pr-linux-desktop-launch-fix.md`（提交 452e858）：桌面启动修复的故障树/逐提交说明/8 项验证矩阵/风险评估 |

---

## 五、测试验证状态

### 5.1 已验证通过（MCP 远程驱动）

| 功能 | 验证方式 | 状态 |
|------|----------|------|
| L1 委派 L2 子会话 | MCP send_message + 日志 | ✅ |
| delegate_agent 跨渠道 | deepseek + glm-zhipu | ✅ |
| allowSubDelegation 三层放行 | L2 成功创建 AC 子会话 | ✅ |
| AC 审计由 L2 驱动 | L2 自主创建 Attacker/Defender | ✅ |
| AC 修复循环 | PRD v1.0→v1.1→v1.2→v1.3（4 轮） | ✅ |
| 异构模型 | Attacker=glm-zhipu, Defender=deepseek | ✅（v70 测试确认） |
| Linux 文件监听递归 | 112+ 目录覆盖 | ✅ |
| 文件变更通知主进程 | 日志 5+ 次检测到 prd.md | ✅ |
| canUseTool 硬门禁 | TaskCreate/TaskUpdate 被拦截 | ✅ |
| PRD 文件产出 | 8805-12923 字节 markdown | ✅ |
| Typecheck | 0 errors | ✅ |
| 单元测试 | 508 pass / 0 fail | ✅ |
| 双实例并存（v0.16.72） | release/dev 进程、userData、配置目录全隔离；app.asar md5 一致（同代码） | ✅ |
| 桌面快捷方式双击启动 | gio launch 冷启动两实例 + 热实例唤起均通过 | ✅ |
| dev 实例窗口图标 | X11 `_NET_WM_ICON` 逐像素校验（64x64, mismatch=0, cyberpunk 五色） | ✅ |
| 跨实例会话控制（v0.16.72） | release 侧 agent（deepseek-flash）经 HTTP 桥指挥 dev 实例建会话并验证；双向隔离复核通过 | ✅ |
| 窗口属性看门狗 | 主窗销毁重建后 2s 内自动补写 WM_CLASS/_NET_WM_ICON | ✅ |

### 5.2 已实现但未完全验证

| 功能 | 当前状态 | 待验证 |
|------|----------|--------|
| 预览面板弹出 | v0.16.71 将监听移至全局 hook | UI 中确认右侧面板是否显示 |
| 阶段自动续接 | v0.16.70 代码已实现 | AC 完成后是否自动进入 UX 阶段 |
| UX 原型阶段 | 路由定义已完成 | prototype.html 生成 + 预览 |

### 5.3 已知问题

| 问题 | 根因 | 修复建议 |
|------|------|----------|
| GLM 渠道 modelId=None | ~~delegate_agent 跨渠道时 LLM 没传 modelId~~ | ✅ v0.16.82 已修（pickDefaultModelForChannel 自动选默认模型） |
| GitHub push 失败 | 网络不稳定 + 服务端对象 52d54318 损坏 | 尝试新建空仓库推送 |
| NanjuWorkspaceView 未使用 | TabContent 用 AgentView 渲染 | 保留或重构为 MainArea 分屏 |
| AC 审计耗时较长 | 每轮 ~2-3 分钟，完整 4 轮 ~10 分钟 | 考虑限制最大轮次或并行化 |
| Electron 托盘图标不显示（dev/release 均是） | xrdp 环境下 SNI 注册静默失败 | v0.16.81 已兼容：托盘不可用时点 X 直接退出，不再死局；如需真托盘须让进程拿到正确 DBUS_SESSION_BUS_ADDRESS |
| Cinnamon 面板图标按文件路径缓存 | 改图标文件内容+touch 不生效，必须换文件名 | 已用 icon-dev-cyberpunk.png 规避；后续换图标一律换新文件名 |
| nemo-desktop 启动竞争致桌面图标不渲染 | 会话启动时多实例竞争，后到者报 "Desktop already managed" 弃权（xrdp 环境层问题，非 Proma） | 应急脚本 `~/proma-easy/fix-desktop-icons.sh`；启动追踪见 `/tmp/proma-dev-launch.log`（无记录=桌面层问题） |
| deepseek 渠道委派场景间歇故障（2026-08-17 e2e 验收发现） | 委派子会话（长上下文）下 v4-pro 报 provider_error 服务繁忙、v4-flash 报 400 code 1214 "modelCode 不存在"；同模型轻量 probe 均成功。deepseek anthropic 端点（api.deepseek.com/anthropic）对长上下文/模型名的间歇行为，黑盒待查 | 短期：调度员重试即可恢复（繁忙为间歇性）；中期：渠道模型名加映射层（deepseek-chat/reasoner）；或 requirements 角色改用 glm |
| 南大 e2e 阶段推进未完成实测 | 上行问题阻塞：requirements 委派因 deepseek 故障未产出 PRD，后续阶段（自动续接/原型预览）未走到 | 待 deepseek 稳定后重跑；入口：_nanju-projects.json 关联会话 + 发消息（验收用 hack，见 handoff） |

**2026-08-17 已解决**：
- 预览面板 UI 确认 → v0.16.73 修复（74237e2，事件改发主窗），CDP 验证弹出 ✓
- 无托盘环境退出死局 → v0.16.81（见版本历史）✓
- 桌面双击启动不了 → v0.16.77/80/81 四层修复，用户实测 dev 双击可启动 ✓（另：桌面层 nemo 竞争问题见上表）

---

## 六、可用渠道与模型

| 渠道 ID | Provider | 可用模型 |
|---------|----------|----------|
| deepseek | deepseek | deepseek-v4-pro, deepseek-v4-flash |
| glm-zhipu | zhipu | glm-5.2, glm-5-turbo, GLM-4.6V, glm-5.3 |
| ad74ac74-... | minimax | MiniMax-M3, MiniMax-M2.7-highspeed |

---

## 七、关键配置

- **Proma 配置目录**：`~/.proma/`（打包版）/ `~/.proma-dev/`（开发版）
- **南大工作区**：`~/.proma/agent-workspaces/workspace-1786421210929/`
- **项目元数据**：`workspace-files/_nanju-projects.json`
- **MCP Bridge**：端口动态分配 19876-19895（每实例自动错开），用 `GET /get_instance_info` 发现各实例；当前 release=19876 / dev=19877（重启后可能互换）
- **启动注意**：必须 `unset ELECTRON_RUN_AS_NODE`（Prime Agent 环境会设置此变量）
- **DISPLAY**：`:10.0`（xrdp Cinnamon 会话）
- **桌面/面板操作所需 dbus**：`DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/dbus-I9B5oC7Fse`（gio set trusted 等命令需要）

---

## 八、MCP Bridge API

| 工具 | 方法 | 参数 |
|------|------|------|
| get_instance_info | GET | - |
| list_workspaces | POST | - |
| list_sessions | POST | workspace_id?, limit? |
| create_session | POST | title, channel_id, workspace_id, model_id? |
| send_message | POST | session_id, message, channel_id?, wait? |
| list_messages | POST | session_id, limit? |
| get_session_info | POST | session_id |
| get_session_context | POST | session_id |
| fork_session | POST | source_session_id |
| archive_session | POST | session_id, archived? |


---

## 九、proma-easy 双实例部署（v0.16.72 阶段总结，2026-08-16）

### 9.1 部署结构

`/home/orphic/proma-easy/`（非 git 管理，随 v0.16.72 一并建立）：

```
proma-easy/
├── release/                  # 正式版实例
│   ├── start.sh              # 清理失效锁 + exec app/proma（unset ELECTRON_RUN_AS_NODE）
│   └── app/                  # 完整打包产物（与 dev/app 的 app.asar md5 一致 = 同代码）
└── dev/                      # 开发版实例
    ├── start-dev.sh          # PROMA_INSTANCE=dev PROMA_DEV=1 PROMA_ICON=... + 属性看门狗
    ├── app/proma-dev         # 同一二进制的改名副本（Electron res_class 由二进制名决定）
    ├── icon-dev-cyberpunk.png  # 任务栏/窗口图标（proma-logos/proma-cyberpunk 五色变体）
    ├── icon-dev.argb         # X11 _NET_WM_ICON 直写数据（64x64 w,h+ARGB 小端）
    └── set-window-props.py   # 幂等窗口属性修复器（ctypes libX11）
```

两实例隔离：release 用 `~/.proma` + `~/.config/Proma`；dev 用 `~/.proma-dev` + `~/.config/Proma-dev`（首启自动从 release 复制渠道配置）。

### 9.2 X11 窗口属性机制（Electron 硬编码的绕行）

Electron 框架把主窗 WM_CLASS 硬编码为二进制名，`app.setName`/`--class` 均无效，且主窗会被销毁重建（托盘恢复时属性回退）。方案：

1. 二进制改名 `proma` → `proma-dev`（res_class 随之变，任务栏分组分离的基础）；
2. `set-window-props.py` 遍历窗口树找 `_NET_WM_PID` 匹配窗口，幂等改写 WM_CLASS + `_NET_WM_ICON`（先比对，缺啥补啥，无差异零操作）；
3. `start-dev.sh` 挂常驻看门狗：应用存活期间每 2s 巡检补写，随进程退出；静默期零日志。

**关键坑（X11 format 32 属性）**：`XChangeProperty/XGetWindowProperty` 的 format=32 数据是 **long 数组**（LP64 每元素 8 字节，仅低 32 位有效）。写端给原始字节缓冲会把相邻像素拼进同一 long 再截断（图标变 `[w,0,0...]`）；读端按 4 字节切分会把高位垃圾当数据（h 读成 0）。必须 `(c_ulong*n)(*vals)` 写、`data[i] & 0xFFFFFFFF` 读。另：`xprop` 解析大 CARDINAL 属性会误报 Out of memory，用 ctypes 直调绕开。

### 9.3 图标链路（三层，2026-08-16 定稿）

| 层 | 文件 | 说明 |
|----|------|------|
| 任务栏按钮 / 桌面快捷方式 | `dev/icon-dev-cyberpunk.png` | `.desktop` 的 Icon= 指向；**Cinnamon 面板按路径缓存，换图标必须换文件名**（touch/改内容无效） |
| Electron 窗口图标 | 同上（`PROMA_ICON` 注入）+ `app/resources/icon.png` 兜底 | 均为 cyberpunk 五色 |
| X11 `_NET_WM_ICON` | `dev/icon-dev.argb` | 看门狗持续补写；`/tmp/verify-icon.py <win_hex> <argb>` 逐像素校验 |

dev 图标选型：项目 `resources/proma-logos/` 有 16 个变体，选 cyberpunk（绿/青/蓝/品红五色，与 release 黑白区分度最大）。

### 9.4 桌面快捷方式

`~/Desktop/` 与 `~/.local/share/applications/` 双份同步（4 个文件均过 desktop-file-validate）：

- `proma-easy-release.desktop`：StartupWMClass=Proma，黑白图标
- `proma-easy-dev.desktop`：StartupWMClass=Proma-dev，cyberpunk 图标

**Nemo 信任标记**：未设 `metadata::trusted true` 时双击不执行——用 `gio set <file> metadata::trusted true`（需会话 dbus）。冷启动（gio launch 双实例）与热实例（second-instance 唤起已有窗口）均实测通过。

### 9.5 跨实例会话控制（实测通过）

每个实例自带 HTTP MCP bridge（端口 19876-19895 自动错开），工具含 create_session/send_message/list_messages 等。实测：release 侧 agent 会话（deepseek-v4-flash，bypassPermissions）接受任务后用 curl 指挥 dev 实例（另一端口）创建会话并验证，7.5s 完成；dev/release 会话存储双向隔离复核通过。**这意味着可以让一个实例的 agent 编排另一个实例的会话**（跨实例联动的基础设施已就绪）。

### 9.6 验证工具（均在 /tmp，重启后需重建）

- `/tmp/verify-icon.py <win_hex> <expected.argb>`：读 `_NET_WM_ICON` 与期望 argb 逐像素比对 + 色相统计
- 窗口定位：`xdotool search --class proma`（注意过滤辅助窗口，主窗看 IsViewable）

### 9.7 v0.16.73 修复：双击快捷方式无反应（2026-08-16 下午）

**现象**：关闭主窗后双击桌面快捷方式，两实例都"启动不起来"。

**根因**：Linux 版缺少 close-to-tray 拦截（源码只有 darwin/win32 分支）。点 X → 主窗销毁 → 隐藏的快速任务窗（680x320 预创建窗）仍存在 → `window-all-closed` 不触发 → 进程残留成无头僵尸并持有 SingletonLock；偶发叠加主进程被杀后孤儿子进程（NetworkService 等，PPID=1）继承 SingletonSocket，进一步干扰新实例接管。

**修复**（三处）：
1. `index.ts`：新增 Linux 分支——`close` 时若非退出且有 tray 则 `preventDefault() + hide()`（与 win32 对齐）。实测：Alt+F4 → 主窗 IsUnMapped（不销毁）→ 双击快捷方式 → 同进程 `show()` 秒回（无需走 createWindow 重建）。
2. `release/start.sh` / `dev/start-dev.sh`：失效锁清理时同时清 `SingletonSocket/SingletonCookie`，并清扫 PPID=1 的 `--type=` 孤儿子进程。
3. 部署副本 app.asar 已重打包（主进程 main.cjs 替换，asarUnpack 结构与 electron-builder 配置一致），版本 0.16.73。

### 9.8 后续待办（2026-08-17 更新）

1. ~~南大向导预览面板 UI 端确认~~ → v0.16.73 已修复验证（见 5.3 已解决清单）
2. Electron 托盘图标在本环境不显示——v0.16.81 已做兼容处理（不可用时点 X 直接退出）；如需真托盘，启动时注入正确 `DBUS_SESSION_BUS_ADDRESS`
3. GLM 渠道 modelId=None 自动选模（进行中）
4. GitHub push（remote `easy`）：fork 服务端对象库损坏（幽灵对象 52d54318），待删 fork 重建 + 网络窗口期推送；linux-support 待推 5 个提交（含 PR 文档 452e858）

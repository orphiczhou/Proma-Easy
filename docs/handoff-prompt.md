# Proma-Easy 开发交接提示词（2026-08-16，交接给 GLM-5.3）

你正在接手 **Proma-Easy（南大向导）** 项目的后续开发。这是一个运行在 Electron 上的本地 AI Agent 平台（Bun monorepo）。请先通读本提示词，再按"上手步骤"逐项确认后开工。

## 一、先读这些（按顺序）

1. `/home/orphic/proma-source/AGENTS.md` —— 工程约定（必须遵守：Bun 不用 npm、中文注释、Jotai、IPC 四层契约、每次提交 bump 版本）
2. `/home/orphic/proma-source/docs/proma-easy-status.md` —— **项目全量状态**（架构/文件清单/版本历史/测试状态/本阶段总结）
3. `/home/orphic/proma-source/docs/nanju-v2.3-design.md` —— 核心架构（两层固定路由 Harness + AC 对抗审计）

## 二、项目位置与当前状态

- **代码**：`/home/orphic/proma-source`，分支 `linux-support`，版本 v0.16.73，工作区干净（本交接文档已提交）
- **双实例部署**：`/home/orphic/proma-easy/`（release + dev 两份打包副本并存运行）
  - release：黑白图标，配置 `~/.proma`，userData `~/.config/Proma`
  - dev：cyberpunk 五色图标，配置 `~/.proma-dev`，userData `~/.config/Proma-dev`
  - 两份 app.asar md5 一致（同一构建产物，靠环境变量区分实例）
- **当前正在运行**：两实例均在跑。日志 `/tmp/proma-release.log`、`/tmp/launch-dev4.log`（dev 最近几次重启的日志名可能不同）

## 三、环境关键事实（避坑，都是实测踩过的）

1. **启动 Proma 必须** `env -u ELECTRON_RUN_AS_NODE`（Prime Agent 环境会设此变量导致 Proma 以 Node 模式秒退）
2. **DISPLAY=:10.0**（xrdp Cinnamon 会话）；桌面/面板操作需要 `DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/dbus-I9B5oC7Fse`
3. **MCP bridge 端口动态**（19876-19895 每实例自动错开，重启可能互换）：先 `curl http://127.0.0.1:19876/get_instance_info` 和 19877 确认谁是 release/dev
4. **X11 format-32 属性是 long 数组**（LP64 下 8 字节，仅低 32 位有效）：ctypes 写用 `(c_ulong*n)(*vals)`，读必须 `& 0xFFFFFFFF`；xprop 读大 CARDINAL 会误报 OOM
5. **Cinnamon 面板图标按文件路径缓存**：换图标内容+touch 无效，必须换新文件名
6. **Nemo 桌面快捷方式**：双击不执行多半是缺 `metadata::trusted`（`gio set <file> metadata::trusted true`）
7. **Electron 托盘图标在本环境不显示**（Proma 进程无 dbus 连接，SNI 不注册）——非阻塞，别在这上面浪费时间，除非明确要求修

## 四、验证工具

- 图标校验：`python3 /tmp/verify-icon.py <win_hex> /home/orphic/proma-easy/dev/icon-dev.argb`（读 `_NET_WM_ICON` 逐像素比对；/tmp 重启后丢失，可按 status 文档 9.6 重建）
- 窗口定位：`DISPLAY=:10.0 xdotool search --class proma`，主窗看 `xwininfo -id <id> -stats` 的 Map State=IsViewable
- 跨实例驱动：HTTP bridge 的 create_session / send_message（wait=false 异步 + list_messages 轮询）

## 五、遗留待办（按优先级）

1. **南大向导预览面板 UI 确认**（v0.16.71 遗留）：渲染端链路已迁 useGlobalAgentListeners，需在 dev 实例 UI 跑一次真实南大项目确认右侧面板弹出（status 文档 5.2 节）
2. **GLM 渠道 delegate_agent 时 modelId=None → API 400**：修复位置 startDelegation——channelId 传了但 modelId 没传时自动选渠道第一个 enabled 模型（status 文档 5.3 节）
3. GitHub push（remote `easy`）网络/对象损坏问题，可尝试新建空仓库
4. AC 审计耗时优化（每轮 2-3 分钟，4 轮 ~10 分钟）

## 六、上手步骤（接手后立即做）

1. `cd /home/orphic/proma-source && git log --oneline -3` 确认 HEAD 是本交接提交
2. `curl -s http://127.0.0.1:1987[6-9]/get_instance_info` 逐个探（19876-19878）确认两实例存活与端口归属
3. 读 status 文档第九节（本阶段 proma-easy 双实例部署全貌）
4. 从"遗留待办"第 1 项开工；改动遵守 AGENTS.md（bun run typecheck / bun test 最小相关测试 / bump 版本 / 中文注释）

## 七、我是谁

你是 release 实例上通过 MCP bridge 创建的 GLM-5.3 headless 会话（bypassPermissions）。上一个阶段由 Prime Agent（外部）+ 本地多模型协作完成；你现在拥有完整上下文与文件访问权，独立接手。

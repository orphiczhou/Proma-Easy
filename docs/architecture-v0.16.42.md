# Proma Linux 技术框架（v0.16.42）

> 整合 proma-patches 资源 + Tree UI 面板后的完整技术架构。
> 为南大 Agent 向导项目提供技术前置基座。

---

## 一、技术栈

| 层级 | 技术 | 版本 | 来源 |
|------|------|------|------|
| 桌面壳 | Electron | ^39.5.1 (binary 43.2.0) | Proma 原生 |
| 主进程 | Node.js + TypeScript → esbuild CJS bundle | TS 5.x | Proma 原生 |
| 渲染进程 | React ^18.3.1 + Vite ^6 + Tailwind ^3.4 + Jotai ^2.17 | | Proma 原生 |
| UI 组件 | Radix UI (shadcn/ui) + Lucide React ^0.460 | | Proma 原生 |
| Agent 运行时 | Pi Agent Runtime (@earendil-works/pi-coding-agent ^0.82.1) | patched | Proma 原生 |
| 包管理 | Bun workspace monorepo | Bun 1.3.x | Proma 原生 |
| 模型协议 | MCP (Model Context Protocol) | | Proma 原生 |
| 分发 | electron-builder (AppImage + deb) | 25.1.8 | linux-support 分支 |
| 镜像 | npmmirror (bunfig.toml) | | linux-support 分支 |

## 二、目录结构

```
proma-source/
├── apps/electron/                         # 主应用 @proma/electron v0.16.42
│   ├── src/
│   │   ├── main/                          # 主进程
│   │   │   ├── index.ts                   # 入口 + bootstrap
│   │   │   ├── ipc.ts                     # IPC handler 注册（含 tree-view IPC）
│   │   │   ├── tray.ts                    # 系统托盘
│   │   │   └── lib/
│   │   │       ├── adapters/
│   │   │       │   ├── pi-agent-adapter.ts    # Pi 运行时适配器
│   │   │       │   ├── pi-builtin-tools.ts    # ★ MCP 工具注册中心（8组94工具）
│   │   │       │   ├── pi-mcp-tools.ts        # 外部 MCP 客户端桥接
│   │   │       │   └── ...
│   │   │       ├── agent-session-tools.ts        # ★ mcp__session__* (11 工具)
│   │   │       ├── agent-remote-session-tools.ts # ★ mcp__remote-session__* (12 工具)
│   │   │       ├── agent-mcp-bridge.ts           # ★ 外部 MCP HTTP Bridge 服务
│   │   │       ├── tree-engine.cjs               # ★ 树状态引擎 (3602行, V10加固)
│   │   │       ├── tree-mcp-tools.ts             # ★ mcp__tree__* (29 工具)
│   │   │       ├── tree-view-ipc.ts              # ★ 树面板 IPC handler
│   │   │       ├── proma-mcp-server.cjs          # ★ 外部 stdio MCP 桥接脚本
│   │   │       ├── agent-session-manager.ts      # 会话生命周期管理
│   │   │       ├── agent-orchestrator.ts         # Agent 编排核心 (~102KB)
│   │   │       ├── agent-collaboration-tools.ts  # mcp__collaboration__* (10 工具)
│   │   │       ├── channel-manager.ts            # 渠道/API Key 管理
│   │   │       ├── config-paths.ts               # 路径单一数据源
│   │   │       ├── safe-file.ts                  # 原子写封装
│   │   │       └── ...
│   │   ├── preload/index.ts               # contextBridge IPC (含 getTreeStates)
│   │   └── renderer/                      # React SPA
│   │       ├── atoms/                     # Jotai 状态 (含 AgentSidePanelTab: files|changes|chat|tree)
│   │       ├── components/
│   │       │   ├── agent/
│   │       │   │   ├── SidePanel.tsx      # 右侧面板 (4 tab)
│   │       │   │   └── TreeViewPanel.tsx  # ★ 树形可视化组件 (上下分栏+可拖拽)
│   │       │   ├── diff/
│   │       │   │   └── DiffPanelTabBar.tsx # Tab 栏 (含「任务树」按钮)
│   │       │   └── ...
│   │       └── ...
│   ├── default-skills/                    # 23 个内置 Skill
│   │   ├── session-management/            # ★ 会话管理指南
│   │   ├── tree-commander/                # ★ 树指挥官 v2.9.9
│   │   ├── tree-worker/                   # ★ 树执行者
│   │   ├── tree-auditor/                  # ★ 树审计员
│   │   ├── tree-iterative-development/    # ★ 迭代开发方法学
│   │   ├── structured-doc-multi-agent-verification-v2/ # ★ 文档审查 V2
│   │   ├── adversarial-convergence-verification/       # ★ 对抗收敛 v1.3.0
│   │   ├── multi-agent-methodology-research/           # ★ 方法论研究
│   │   └── ... (15 个原有 Skill)
│   ├── electron-builder.yml               # 打包配置 (Linux: AppImage + deb)
│   └── package.json                       # v0.16.42
├── packages/
│   ├── shared/                            # IPC 类型 + 常量 (AgentSessionMeta, SDKMessage 等)
│   ├── core/                              # Provider 适配器 (Anthropic/Google/OpenAI)
│   ├── session-core/                      # 会话通用能力
│   └── ui/                                # 跨应用共享 UI
├── patches/                               # Bun patch 补丁
│   ├── @earendil-works%2Fpi-ai@0.82.1.patch          # 重试错误模式扩展
│   ├── @earendil-works%2Fpi-coding-agent@0.82.1.patch # 重试预算双计数增强
│   └── @earendil-works%2Fpi-ai@0.80.3.patch
├── docs/
│   └── architecture-v0.16.42.md           # 本文档
└── bunfig.toml                            # npmmirror 镜像加速
```

## 三、MCP 工具体系（8 组 94 工具）

### 3.1 工具组总览

| 工具组 | 工具数 | 来源 | 注册函数 | 功能 |
|--------|--------|------|---------|------|
| `mcp__session__` | 11 | ★ 新增 | `buildPiSessionTools` | 实例内会话 CRUD + send_message |
| `mcp__remote-session__` | 12 | ★ 新增 | `buildPiRemoteSessionTools` | 远程实例操作 + 实例发现 |
| `mcp__tree__` | 29 | ★ 新增 | `buildPiTreeTools` | 树形任务编排 + 审计门禁 |
| `mcp__collaboration__` | 10 | Proma 原生 | `buildPiCollaborationTools` | 委派协作 + 阻塞事件冒泡 |
| `mcp__planning__` | 25 | Proma 原生 | `buildPlanningTools` | 任务/日程/标签/提醒 |
| `mcp__automation__` | 6 | Proma 原生 | `buildAutomationTools` | 定时任务 |
| `mcp__feishu_chat__` | 1 | Proma 原生 | — | 飞书群聊 |
| `mcp__nano_banana__` | 1 | Proma 原生 | `buildPiNanoBananaTools` | 图片生成 |
| **合计** | **94** | | | |

### 3.2 工具注册流程

所有工具通过 `sdk.defineTool()` + TypeBox schema 注册为 Pi custom tools。

```
agent-orchestrator.ts → sendMessage()
  └→ buildPiBuiltinTools(piSdk, ctx)          [pi-builtin-tools.ts]
       ├→ buildWebTools()                      WebSearch / WebFetch
       ├→ buildAutomationTools()               mcp__automation__*
       ├→ buildPlanningTools()                 mcp__planning__*
       ├→ buildPiCollaborationTools()          mcp__collaboration__*
       ├→ buildPiSessionTools()           ★    mcp__session__*
       ├→ buildPiRemoteSessionTools()     ★    mcp__remote-session__*
       ├→ buildPiTreeTools()              ★    mcp__tree__*
       ├→ buildWindowsShellInstallerTools()
       ├→ buildVisionRelayTools()
       └→ buildPiNanoBananaTools()              mcp__nano_banana__*
```

### 3.3 session vs collaboration 工具定位

| 维度 | `mcp__session__*` | `mcp__collaboration__*` |
|------|-------------------|------------------------|
| 层级 | 底层 CRUD | 高层抽象 |
| 焦点 | 会话生命周期管理 | 委派生命周期 + 阻塞事件 |
| 适用 | 自主调度、Fork 探索、竹节交接 | 父→子委派 + 等待/停止/审批 |
| 深度限制 | 无（可递归创建） | 仅一层（子会话不能再委派） |
| 状态追踪 | 通过 tree 工具或外部 | 内建 delegation record |

### 3.4 各工具组详表

**mcp\_\_session\_\_（11 工具）**

| 工具 | 类型 | 功能 |
|------|------|------|
| get_my_session_id | 只读 | 获取当前 Agent 会话 ID |
| list_channels | 只读 | 列出所有 AI 渠道及可用模型 |
| list_workspaces | 只读 | 列出所有工作区 |
| list_sessions | 只读 | 列出会话（支持工作区过滤） |
| get_session_info | 只读 | 查询单个会话详情 |
| get_session_context | 只读 | 查询 token 用量/上下文窗口 |
| list_messages | 只读 | 列出消息历史（含 UUID，支持分页） |
| create_session | 写入 | 创建新会话 |
| fork_session | 写入 | Fork 会话（支持 UUID 截断） |
| send_message | 写入 | 向目标会话发消息（wait=true 返回 reply） |
| archive_session | 写入 | 归档/取消归档会话 |

**mcp\_\_remote-session\_\_（12 工具）**

与 session 组完全对称，每个工具多一个 `instance` 参数。额外包含 `discover_instances`（扫描 localhost:19876-19895 发现 Proma 实例）。

**mcp\_\_tree\_\_（29 工具）**

| 类别 | 工具 |
|------|------|
| 帮助 | tree_help |
| 维护 | tree_init / tree_validate / tree_backup / tree_restore / tree_migrate |
| 添加 | tree_leaf_add / tree_milestone_add |
| 更新 | tree_leaf_set_status / tree_leaf_set_context / tree_leaf_set_last_event / tree_leaf_set_session / tree_leaf_autonomy_override / tree_milestone_set_result |
| 追加 | tree_event_append / tree_drift_append / tree_heartbeat_append / tree_segment_append / tree_nudge_append / tree_nudge_reset |
| 审计 | tree_audit_gate / tree_audit_append |
| 查询 | tree_leaf_get / tree_leaf_list_active / tree_leaf_list_all / tree_tree_dump / tree_drift_list / tree_heartbeat_tail / tree_event_list |

## 四、外部 MCP 接入架构

```
外部工具 (Claude Code / 脚本 / 其他 MCP 客户端)
    │ stdio (MCP JSON-RPC)
    ▼
proma-mcp-server.cjs                       ← 零依赖 stdio→HTTP 桥接（157 行）
    │ HTTP POST /:tool_name
    ▼
agent-mcp-bridge.ts (localhost:19876-19895) ← HTTP Bridge 服务
    │ session tool handlers
    ▼
agent-session-manager.ts                   ← 会话 CRUD 底层服务
```

- **启动时机**：bootstrap 中 `safeRun('startMcpHttpBridge', startMcpHttpBridge)`
- **端口选择**：19876-19895 自动选择，首个可用端口
- **实例发现**：`GET /get_instance_info` 返回 `{instance, proma_dev, port}`
- **工具调用**：`POST /<tool_name>`，body 为 JSON 参数

## 五、树形会话执行体系

### 5.1 架构

```
mcp__tree__* (29 Pi custom tools)          [tree-mcp-tools.ts]
    │ treeEngine.run(cmd, args, treesDir, callerSessionId)
    ▼
tree-engine.cjs (3602 行, V10 加固)        ← 引擎核心，CJS 原样保留
    ├→ 28 个命令 handler (cmd*)
    ├→ DbC 硬约束 (12 个检查点)
    ├→ V10 安全加固 (8 大盲点防护)
    ├→ 文件锁 + 原子写 + 自动备份
    └→ tree-state.json (JSON 状态文件)
```

### 5.2 状态存储

```
~/.proma/agent-workspaces/{slug}/
└── workspace-files/.context/trees/
    └── {tree_id}/
        ├── tree-state.json               ← 状态数据
        ├── tree-state.backup.*.json      ← 自动备份
        └── .lock                         ← 文件锁
```

> 注意：tree 工具要求 `.context/trees/` 目录预先存在，tree_init 不自动创建。

### 5.3 V10 安全加固要点

| 防护 | 检查 |
|------|------|
| 防借身份 | caller session_id ≠ audit_session_id → E_BORROWED_IDENTITY |
| 审计独立性 | auditor 必须是不同 leaf 的 session → E_AUDITOR_NOT_INDEPENDENT |
| UUID 严格校验 | 拒全 0/全 f → E_INVALID_UUID_STRICT |
| 数字一致性 | passed + failed = total → E_COUNT_MISMATCH |
| 时间单调性 | event ts ≥ leaf.created_at → E_TS_BEFORE_CREATED |
| Nudge 升级 | nudge_count ≥ 7 → 自动 pruned |
| 状态事件同步 | status/event 不一致 → E_STATUS_EVENT_MISMATCH |
| 节点预算 | node_budget 限制 → E_TREE_NODE_BUDGET_EXCEEDED |

## 六、Agent 会话管理层

### 6.1 三层架构

```
Pi Agent Runtime (SDK)
    │ sdk.defineTool() custom tools
    ▼
Pi Builtin Tools (pi-builtin-tools.ts)      ← 工具注册中心
    │ 复用底层服务函数
    ▼
Session Manager (agent-session-manager.ts)  ← 会话生命周期
    ├→ createAgentSession / forkAgentSession
    ├→ getAgentSessionMeta / listAgentSessions
    ├→ getAgentSessionSDKMessages
    ├→ updateAgentSessionMeta / deleteAgentSession
    └→ rewindPiAgentSession (快照回退)
```

### 6.2 关键数据类型

- `AgentSessionMeta`：会话元数据（id/title/channelId/modelId/workspaceId/sdkSessionId/permissionMode/...）
- `SDKMessage`：Pi SDK 消息（assistant/user/result/tool/thinking...）
- `AgentSendInput`：headless 运行输入（sessionId/userMessage/channelId/modelId/...）
- `ForkSessionInput`：Fork 参数（sessionId/upToMessageUuid/modelId）

### 6.3 Headless 执行链路

```
send_message(session_id, message)
  └→ runRegisteredHeadlessAgent(input, callbacks)  [agent-headless-runner-registry.ts]
       └→ agent-service.ts: runAgentHeadless()
            └→ AgentOrchestrator.sendMessage()
                 └→ Pi SDK query() → 模型 API → 流式响应
```

## 七、UI 面板体系

### 7.1 右侧 SidePanel 结构

```
SidePanel.tsx
  ├→ DiffPanelTabBar                       ← Tab 栏
  │    ├→ [文件]      files
  │    ├→ [文件改动]   changes
  │    ├→ [任务树]     tree           ★ 新增
  │    └→ [问答]      chat (按需显示)
  │
  ├→ FilesView (文件浏览器 + 搜索 + 拖拽)
  ├→ DiffChangesList (Git 改动列表)
  ├→ TreeViewPanel (树形可视化)       ★ 新增
  └→ ChatView (侧边问答)
```

### 7.2 TreeViewPanel 组件特性

- **布局**：上方树列表 + 下方详情面板（上下分栏）
- **可调节**：拖拽分隔条调节详情面板高度（80px ~ 面板高度 85%）
- **自动刷新**：3 秒轮询 IPC `proma:get-tree-states`
- **数据流**：`window.electronAPI.getTreeStates()` → `tree-view-ipc.ts` → 读取 tree-state.json
- **树渲染**：按 parent → children 递归，角色图标（📁/🔀/🍃）+ 状态圆点 + chips
- **详情**：双列网格（角色/模型/渠道/事件/更新/审计/里程碑/上下文）

### 7.3 面板显示条件

右侧面板在 `appMode === 'agent' && currentSessionId` 时显示。
展开/折叠快捷键：**Ctrl+Shift+B**（或点击关闭按钮）。

## 八、Bootstrap 启动序列

```
app.whenReady() → bootstrap()
  ├→ setPromaVersion()
  ├→ createStartupSplashWindow()
  ├→ protocol.handle('proma-file://')
  ├→ initializeRuntime({ skipNodeDetection: true })
  ├→ seedDefaultSkills()                     ← 同步 23 个 Skill 到工作区
  ├→ upgradeDefaultSkillsInWorkspaces()      ← 升级旧版 Skill
  ├→ createApplicationMenu()
  ├→ registerIpcHandlers()
  │    └→ registerTreeViewIpc(ipcMain)  ★    ← 树面板 IPC
  ├→ markRunningDelegationsAsInterrupted()
  ├→ startMcpHttpBridge()               ★    ← 外部 MCP HTTP Bridge (port 19876+)
  ├→ createWindow()
  ├→ configurePlanningQuickEntries()
  ├→ createTray()
  ├→ startWorkspaceWatcher()
  ├→ startChatToolsWatcher()
  └→ initAutoUpdater() (packaged only)
```

## 九、Linux 平台适配

| 适配项 | 方案 | 文件 |
|--------|------|------|
| 打包格式 | AppImage + deb | electron-builder.yml |
| 图标路径 | `process.resourcesPath` (packaged) | main/index.ts |
| 缩放 fallback | 非 darwin 均生效 | main/index.ts |
| 托盘图标 | Linux 独立 Tray 实例, 22×22 | tray.ts |
| API Key 解密 | safeStorage 失败 fallback 明文 | channel-manager.ts |
| 平台检测 | `detectIsLinux()` | renderer/lib/platform.ts |
| 沙箱 | `ELECTRON_DISABLE_SANDBOX=1`（无 root SUID） | 启动脚本 |
| 镜像加速 | npmmirror | bunfig.toml |

> 启动方式：`ELECTRON_DISABLE_SANDBOX=1 ./proma`（chrome-sandbox 需 root:4755 SUID）

## 十、版本与补丁

| 组件 | 版本 |
|------|------|
| @proma/electron | **0.16.42** |
| @earendil-works/pi-coding-agent | 0.82.1 (patched) |
| @earendil-works/pi-ai | 0.82.1 (patched) |
| tree-engine | V10 (3602 行) |
| tree-commander SKILL | v2.9.9-macpaf-closeout |

**Bun patch 补丁**（`patches/` 目录）：

- `pi-ai@0.82.1`：扩展可重试错误模式（stream ended / peer closed / failed to fetch / incomplete chunked read / unexpected non-whitespace）
- `pi-coding-agent@0.82.1`：重试预算双计数（连续段 `_retryAttempt` + 顶层 prompt `_retryRunAttempts`，含 cancelled 生命周期 + jitter）

## 十一、构建与部署

### 开发

```bash
bun install                      # 安装依赖
bun run dev                      # 开发模式 (vite + electronmon)
bun run typecheck                # 类型检查
bun test                         # 测试
```

### 构建

```bash
cd apps/electron
bun run build                    # main + preload + renderer + cli + resources
bun run sync:runtime-deps        # 同步运行时依赖到 dist/
bun run pack                     # electron-builder --dir (快速打包)
bun run dist:linux               # 完整 Linux 打包 (AppImage + deb)
```

### 运行测试实例

```bash
cd apps/electron/out/linux-unpacked
rm -f ~/.config/Proma/Singleton*
ELECTRON_DISABLE_SANDBOX=1 ./proma
```

> 注意：环境中若 `ELECTRON_RUN_AS_NODE=1` 全局设置，需用 `env -u ELECTRON_RUN_AS_NODE` 清除。

## 十二、配置目录布局

```
~/.proma/                              # 用户配置根目录
├── channels.json                      # 渠道配置（API Key 加密存储）
├── agent-sessions.json                # 会话索引
├── agent-workspaces.json              # 工作区索引
├── conversations.json                 # Chat 对话索引
├── settings.json                      # 全局设置
├── chat-tools.json                    # Chat 工具配置
├── agent-sessions/                    # 会话消息存储
│   └── {sessionId}.jsonl              # 每个会话的 SDK 消息
├── agent-workspaces/                  # 工作区数据
│   └── {slug}/
│       ├── workspace-files/           # 工作区文件根
│       │   └── .context/
│       │       ├── trees/             # ★ tree-state.json 存储位置
│       │       │   └── {tree_id}/
│       │       │       └── tree-state.json
│       │       └── test-reports/      # Agent 产出的测试报告
│       └── skills/                    # 工作区 Skill 副本
└── default-skills/                    # 默认 Skill 模板（23 个）
```

## 十三、IPC 四层契约

修改 IPC 时必须同步检查四层：

1. `packages/shared` — 通道常量和请求/响应类型
2. `apps/electron/src/main/ipc.ts` — handler 注册
3. `apps/electron/src/preload/index.ts` — contextBridge 暴露
4. renderer — 调用、错误处理、状态更新

### 当前 IPC 通道（★ 为新增）

| 通道 | 方向 | 用途 |
|------|------|------|
| `proma:get-tree-states` ★ | renderer→main | 获取 tree-state.json 数据 |
| IPC_CHANNELS.* | 双向 | Proma 原生（运行时/Git/会话/渠道/...） |
| PLANNING_IPC_CHANNELS.* | 双向 | 任务/日程 |
| AGENT_ISLAND_IPC_CHANNELS.* | renderer→main | 灵动岛（macOS） |

## 十四、南大项目技术前置就绪状态

### 已就绪 ✅

| 能力 | 实现方式 | 对应工具/模块 |
|------|---------|-------------|
| 会话创建/查询/Fork/发消息 | mcp\_\_session\_\_* (11 工具) | agent-session-tools.ts |
| 远程实例操作 | mcp\_\_remote-session\_\_* (12 工具) | agent-remote-session-tools.ts |
| 外部工具接入 | stdio MCP → HTTP Bridge | proma-mcp-server.cjs + agent-mcp-bridge.ts |
| 树形任务编排 | mcp\_\_tree\_\_* (29 工具) | tree-engine.cjs + tree-mcp-tools.ts |
| 审计门禁 | tree_audit_gate + V10 加固 | tree-engine.cjs |
| 树形可视化 | SidePanel「任务树」tab | TreeViewPanel.tsx + tree-view-ipc.ts |
| 委派协作 | mcp\_\_collaboration\_\_* (10 工具) | agent-collaboration-tools.ts |
| 上下文快照回退 | fork_session(up_to_message_uuid) | agent-session-manager.ts |
| 角色切换编排 | session fork + send_message + tree tools | Agent 自主编排 |
| Skill 知识库 | 23 个内置 Skill（含 4 个 tree + 3 个研究） | default-skills/ |

### 待南大项目实现 🔨

| 能力 | 说明 |
|------|------|
| 模式选择页 | 快消型/长期迭代型入口 UI |
| 工作区页面 | 聊天+预览/文档三区布局 |
| 角色配置 | 向导Agent 4 角色 system prompt + 模型映射 |
| 编排逻辑 | 使用 session/tree 工具编排角色串行切换流程 |
| 快照管理 | 基于 fork_session 的线性回滚封装 |
| 埋点采集 | JSONL 事件追加（复用 safe-file.ts） |
| 项目文档体系 | workspace-files/ 下 7 目录标准化 |
| 裁判引擎 | 基于 tree_audit_gate + HardConstraintChecker |

> **核心原则**：以上均不需要新建实体类——现有工具能力（session CRUD + tree 编排 + collaboration 委派）已覆盖设计文档中的 GuideAgent / CodingAgent / JudgeAgent 等抽象。

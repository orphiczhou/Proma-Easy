# Proma Linux 架构体系（v0.16.41）

> 整合 proma-patches 资源后的完整技术架构。基于 Proma v0.16.40 linux-support 分支扩展。

---

## 一、技术栈

| 层级 | 技术 | 来源 |
|------|------|------|
| 桌面壳 | Electron ^39.5.1 | Proma 原生 |
| 主进程 | Node.js + TypeScript (esbuild bundle → CJS) | Proma 原生 |
| 渲染进程 | React ^18.3.1 + Vite ^6 + Tailwind ^3 + Jotai ^2 | Proma 原生 |
| UI 组件 | Radix UI (shadcn/ui) + Lucide | Proma 原生 |
| Agent 运行时 | Pi Agent Runtime (@earendil-works/pi-coding-agent ^0.82.1) | Proma 原生 |
| 包管理 | Bun workspace monorepo | Proma 原生 |
| 模型协议 | MCP (Model Context Protocol) | Proma 原生 |
| 分发 | electron-builder (AppImage + deb for Linux) | linux-support 分支 |

## 二、目录结构

```
proma-source/
├── apps/electron/
│   ├── src/main/                       # 主进程
│   │   ├── index.ts                    # 入口 + bootstrap
│   │   ├── lib/
│   │   │   ├── adapters/               # Pi/Claude 运行时适配器
│   │   │   │   ├── pi-agent-adapter.ts
│   │   │   │   ├── pi-builtin-tools.ts # MCP 工具注册中心
│   │   │   │   ├── pi-mcp-tools.ts     # 外部 MCP 客户端桥接
│   │   │   │   └── ...
│   │   │   ├── agent-session-tools.ts      # ★ mcp__session__* (11 工具)
│   │   │   ├── agent-remote-session-tools.ts # ★ mcp__remote-session__* (12 工具)
│   │   │   ├── agent-mcp-bridge.ts         # ★ 外部 MCP HTTP Bridge
│   │   │   ├── tree-engine.cjs             # ★ 树状态引擎 (3602行, V10加固)
│   │   │   ├── tree-mcp-tools.ts           # ★ mcp__tree__* (29 工具)
│   │   │   ├── proma-mcp-server.cjs        # ★ 外部 stdio MCP 桥接
│   │   │   ├── agent-session-manager.ts    # 会话生命周期管理
│   │   │   ├── agent-orchestrator.ts       # Agent 编排核心
│   │   │   ├── agent-collaboration-tools.ts # mcp__collaboration__*
│   │   │   ├── channel-manager.ts          # 渠道/API Key 管理
│   │   │   ├── config-paths.ts             # 路径单一数据源
│   │   │   └── ...
│   │   ├── ipc.ts                      # IPC handler (4079行)
│   │   └── tray.ts                     # 系统托盘
│   ├── src/preload/index.ts            # IPC bridge
│   ├── src/renderer/                   # React SPA
│   │   ├── atoms/                      # Jotai 状态
│   │   ├── components/                 # React 组件
│   │   ├── hooks/                      # 自定义 Hooks
│   │   └── ...
│   ├── default-skills/                 # 23 个内置 Skill
│   │   ├── session-management/         # ★ 会话管理指南
│   │   ├── tree-commander/             # ★ 树指挥官
│   │   ├── tree-worker/                # ★ 树执行者
│   │   ├── tree-auditor/               # ★ 树审计员
│   │   ├── tree-iterative-development/ # ★ 迭代开发方法学
│   │   ├── structured-doc-multi-agent-verification-v2/  # ★ 文档审查 V2
│   │   ├── adversarial-convergence-verification/       # ★ 对抗收敛验证 v1.3.0
│   │   ├── multi-agent-methodology-research/           # ★ 方法论研究
│   │   └── ... (15 个原有 Skill)
│   └── electron-builder.yml
├── packages/
│   ├── shared/                         # IPC 类型 + 常量
│   ├── core/                           # Provider 适配器
│   ├── session-core/                   # 会话通用能力
│   └── ui/                             # 跨应用共享 UI
├── patches/                            # Bun patch 补丁
│   ├── @earendil-works%2Fpi-ai@0.82.1.patch          # 重试模式增强
│   └── @earendil-works%2Fpi-coding-agent@0.82.1.patch # 重试预算增强
└── bunfig.toml                         # npmmirror 镜像
```

## 三、MCP 工具体系（8 组 94 工具）

### 3.1 工具组总览

| 工具组 | 工具数 | 来源 | 功能 |
|--------|--------|------|------|
| `mcp__session__` | 11 | ★ 新增 | 实例内会话管理（创建/Fork/发消息/查询/归档） |
| `mcp__remote-session__` | 12 | ★ 新增 | 远程实例操作（实例发现 + 同构 session API） |
| `mcp__tree__` | 29 | ★ 新增 | 树形会话执行体系（建树/叶节点/里程碑/审计门禁/纠偏） |
| `mcp__collaboration__` | 10 | Proma 原生 | 委派协作（delegate_agent + 阻塞事件冒泡） |
| `mcp__planning__` | 25 | Proma 原生 | 任务/日程/标签/提醒 |
| `mcp__automation__` | 6 | Proma 原生 | 定时任务 |
| `mcp__feishu_chat__` | 1 | Proma 原生 | 飞书群聊 |
| `mcp__nano_banana__` | 1 | Proma 原生 | 图片生成 |
| **合计** | **94** | | |

### 3.2 工具注册流程

```
agent-orchestrator.ts (sendMessage)
  └→ buildPiBuiltinTools(piSdk, ctx)     [pi-builtin-tools.ts]
       ├→ buildWebTools()                 WebSearch / WebFetch
       ├→ buildAutomationTools()          mcp__automation__*
       ├→ buildPlanningTools()            mcp__planning__*
       ├→ buildPiCollaborationTools()     mcp__collaboration__*
       ├→ buildPiSessionTools()      ★    mcp__session__*
       ├→ buildPiRemoteSessionTools() ★   mcp__remote-session__*
       ├→ buildPiTreeTools()         ★    mcp__tree__*
       ├→ buildVisionRelayTools()         视觉助手
       └→ buildPromaCloudTools()          云端工具
```

所有工具通过 `sdk.defineTool()` + TypeBox schema 注册为 Pi custom tools。

### 3.3 外部 MCP 接入

```
外部工具 (Claude Code / 脚本)
    │ stdio (MCP JSON-RPC)
    ▼
proma-mcp-server.cjs              ← 零依赖 stdio→HTTP 桥接
    │ HTTP POST /:tool_name
    ▼
agent-mcp-bridge.ts               ← localhost:19876-19895
    │ session tool handlers
    ▼
agent-session-manager.ts          ← 会话 CRUD
```

启动时机：bootstrap 中 `safeRun('startMcpHttpBridge', startMcpHttpBridge)`

## 四、Agent 会话管理层

### 4.1 三层架构

```
Pi Agent Runtime (SDK)
    │ sdk.defineTool() custom tools
    ▼
Pi Builtin Tools (pi-builtin-tools.ts)  ← 工具注册中心
    │ 复用底层服务函数
    ▼
Session Manager (agent-session-manager.ts) ← 会话生命周期
    ├→ createAgentSession / forkAgentSession
    ├→ getAgentSessionMeta / listAgentSessions
    ├→ getAgentSessionSDKMessages
    └→ updateAgentSessionMeta / deleteAgentSession
```

### 4.2 session vs collaboration 工具的定位差异

| 维度 | `mcp__session__*` | `mcp__collaboration__*` |
|------|-------------------|------------------------|
| 层级 | 底层 CRUD | 高层抽象 |
| 焦点 | 会话生命周期管理 | 委派生命周期 + 阻塞事件 |
| 适用 | 自主调度、Fork 探索、竹节交接 | 父→子委派 + 等待/停止/审批 |
| 深度限制 | 无（可递归创建） | 仅一层（子会话不能再委派） |
| 状态追踪 | 通过 tree 工具或外部 | 内建 delegation record |

## 五、树形会话执行体系

### 5.1 架构

```
mcp__tree__* (29 Pi custom tools)     [tree-mcp-tools.ts]
    │ treeEngine.run(cmd, args, treesDir, callerSessionId)
    ▼
tree-engine.cjs (3602 行, V10 加固)   ← 引擎核心
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
        ├── tree-state.json           ← 状态数据
        ├── tree-state.backup.*.json  ← 自动备份
        └── .lock                     ← 文件锁
```

### 5.3 与 session 工具的协作

tree 工具的 `leaf.session_id` 字段存储 Proma 会话 ID，可通过 `mcp__session__send_message` 向该会话发消息。tree 引擎只管树结构和审计门禁，不关心会话通信——后者由 session 工具负责。

## 六、Linux 平台适配

| 适配项 | 方案 | 文件 |
|--------|------|------|
| 打包格式 | AppImage + deb | electron-builder.yml |
| 图标路径 | `process.resourcesPath` (packaged) | main/index.ts |
| 缩放 fallback | 非 darwin 均生效 | main/index.ts |
| 托盘图标 | Linux 独立 Tray 实例, 22×22 | tray.ts |
| API Key 解密 | safeStorage 失败 fallback 明文 | channel-manager.ts |
| 平台检测 | `detectIsLinux()` | renderer/lib/platform.ts |
| 镜像加速 | npmmirror | bunfig.toml |

## 七、版本与补丁

| 组件 | 版本 |
|------|------|
| @proma/electron | **0.16.41** |
| @earendil-works/pi-coding-agent | 0.82.1 (patched) |
| @earendil-works/pi-ai | 0.82.1 (patched) |
| tree-engine | V10 (3602 行) |
| tree-commander SKILL | v2.9.9 |

Bun patch 补丁（`patches/` 目录）：
- `pi-ai@0.82.1`：扩展可重试错误模式（stream ended / peer closed / failed to fetch 等）
- `pi-coding-agent@0.82.1`：重试预算增强（连续段 + 顶层 prompt 双重计数 + cancelled 生命周期）

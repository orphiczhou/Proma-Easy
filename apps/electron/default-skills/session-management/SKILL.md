---
name: session-management
description: Agent 会话管理能力。当用户需要创建/查询/Fork会话、给其他会话发消息、监控token用量、归档会话、跨工作区操作、并行调度多个Agent协作、配置外部MCP连接Proma实例、管理Dev/Release双实例、局域网实例发现时触发。触发信号：多会话、开小弟、Fork、分身、并行、批量、派任务、监控进度、上下文甜点、竹节交接、工作区切换、归档、清理会话、外部MCP、Claude Code连接Proma、Dev实例、Release实例、远端实例、双实例、局域网、LAN、host:port、扫描实例、discover_instances。
group: proma
version: "1.3.1"
---

# Agent 会话管理 (v1.3.1)

你拥有 **12 个会话管理 MCP 工具**（`session` MCP server）。这些工具提供了完整的 Proma Agent 会话管理能力——创建、Fork、发消息、查用量、查消息历史、归档、发现局域网实例等。

v1.3.0 新增：`discover_instances` 工具（本地+LAN 实例发现）、`instance` 参数支持 `host:port` 直连格式。

---

## 两种使用方式

这套工具通过**两个不同的入口**暴露，功能完全相同，但调用方式不同：

### 方式 A：内部 Agent（你是 Proma 的 Agent）

你是 Proma 桌面应用中运行的 Agent。`session` MCP server 以进程内方式注入到你的工具列表中，你可以**直接调用**这 11 个工具，无需任何配置。

```
Proma Agent（你）
    │ 直接调用 session MCP 工具
    ▼
proma-dev-patches.cjs → global.__proma__ API
```

**特征：** `get_my_session_id` 返回你的实际会话 ID。`send_message(notify=true)` 可用。

### 方式 B：外部工具（Claude Code / 脚本 / 其他 MCP 客户端）

你是独立于 Proma 运行的外部工具。通过 `proma-mcp-server.cjs` stdio 桥接，**间接调用**这 11 个工具。需要配置 MCP client 才能使用。

```
外部工具 (Claude Code / 脚本)
    │ stdio (MCP JSON-RPC)
    ▼
proma-mcp-server.cjs          ← 零依赖桥接，启动时自动端口扫描
    │ HTTP POST /:tool_name
    ▼
Proma 实例 (Dev 或 Release)
  promp-dev-patches.cjs → localhost HTTP bridge (127.0.0.1:19876-19895)
```

**特征：** `get_my_session_id` 返回 `null`（无源会话）。`send_message(notify=true)` 不可用（返回错误），需用模式 6 轮询回收。

### 两种方式的区别

| | 内部 Agent（方式 A） | 外部工具（方式 B） |
|---|---|---|
| 入口 | 进程内 MCP server | `proma-mcp-server.cjs` stdio |
| 配置 | 零配置，自动可用 | 需在 `.claude/mcp.json` 中配置 |
| `get_my_session_id` | 返回实际会话 ID | 返回 `null` |
| `send_message(notify=true)` | ✅ 可用 | ❌ 不可用（用轮询代替） |
| 多实例支持 | 仅当前实例 | 可同时连接 Dev + Release |
| 适用场景 | Agent 自主调度小弟 | 外部编排、脚本自动化、跨实例管理 |

---

## 11 个工具完整参考

### 只读工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `get_my_session_id` | 无 | `{ session_id, is_external, hint }` — 内部返回实际 ID，外部返回 null |
| `list_channels` | 无 | `{ channels: [{ id, name, provider, enabled, agent_models }] }` |
| `list_workspaces` | 无 | `{ workspaces: [{ id, name, slug, created_at, updated_at }] }` |
| `list_sessions` | `include_archived?` (bool), `workspace_id?` (string), `limit?` (1-200, 默认 50) | `{ count, total, sessions: [{ id, title, channel_id, model_id, workspace_id, workspace_name, pinned, archived, permission_mode, created_at, updated_at }] }` |
| `get_session_info` | `session_id` (必填) | `{ id, title, channel_id, model_id, channel: {id, name, provider}, workspace: {id, name, slug}, pinned, archived, permission_mode, attached_directories, attached_files, created_at, updated_at }` |
| `get_session_context` | `session_id` (必填) | `{ session_id, title, model, context_window, usage: { input_tokens, output_tokens, cache_tokens, total, usage_pct } }` — 含渠道 fallback 和 billing_error 检测 |
| `list_messages` | `session_id` (必填), `offset?` (≥0), `limit?` (1-200, 默认 50) | `{ session_id, count, total, offset, messages: [{ index, type, uuid, timestamp, role, text, text_full_length, usage?, error_code?, error_title?, subtype?, duration_ms?, result_text? }] }`；读取失败 → `{ error }` |
| `discover_instances` | `refresh?` (bool), `hosts?` (string[]) | `{ instances: [{ name, host, port }], cached: bool }` — 扫描 localhost (19876-19895) + 可选 LAN hosts，60s 缓存 |

### 写入工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `create_session` | `channel_id` (必填), `model_id?`, `title?`, `workspace_id?` | `{ session: { id, title, channel_id, model_id, workspace_id, created_at }, message }` |
| `fork_session` | `source_session_id` (必填), `up_to_message_uuid?`, `title?`, `new_channel_id?`, `new_model_id?`, `new_workspace_id?` | `{ session: { id, title, channel_id, model_id, workspace_id, source_session_id, fork_source_sdk_session_id, created_at }, message }` |
| `send_message` | `session_id` (必填), `message` (必填), `wait?` (默认 true), `notify?`, `model_id?`, `channel_id?` | wait=true → `{ session_id, status: "completed", reply, message }`; wait=false → `{ session_id, status: "started", notify, message }`; 出错 → `{ session_id, status: "error", error }` |
| `archive_session` | `session_id` (必填), `archived?` (默认 true) | `{ session_id, title, archived }` |

---

## 内部 Agent 使用模式

> 以下模式适用于**方式 A（内部 Agent）**。外部工具用户请参考"外部 MCP 使用模式"章节。

### 模式 1：开小弟并行干活

```
1. list_channels → 看有哪些模型可用
2. create_session × N → 开 N 个"小弟"会话
   - 复杂分析/架构 → Claude Opus / DeepSeek V4 Pro
   - 简单实现/CRUD → DeepSeek V4 Flash
   - 最便宜 → GLM-4.5-Air
3. send_message(wait=false) × N → 同时给所有小弟派任务
4. 轮询 get_session_context → token 连续两次不变且非零 → 任务完成（详见模式 6）
5. list_messages → 取每个小弟的最后回复
6. fork_session → 开"整合会话"汇总所有产出
```

### 模式 2：深度探索 — 从任意轮 Fork

```
1. list_messages(session_id) → 查看消息历史，每条都有 UUID
2. 找到想回退的那轮 assistant 消息的 UUID
3. fork_session(source_session_id, up_to_message_uuid=那个UUID)
   → 新会话从截断点继承上下文，前几轮对话完整保留
4. send_message(新会话, "换一种方式实现...")
```

**注意：** headless 会话的 user 消息可能没有 UUID，fork 时用 assistant 或 result 消息的 UUID。

### 模式 3：竹节交接 — 上下文甜点区护航

```
1. get_session_context(自己) → 看 usage_pct
2. 如果接近模型甜点区上限：
   a. 先总结进度 → send_message(自己, "总结当前进度和关键发现")
   b. fork_session(自己) → 新会话
   c. send_message(新会话, 简报 + "继续任务")
   d. 旧会话保留为检查点，新会话继续
```

### 模式 4：跨工作区协作

```
1. list_workspaces → 看到所有工作区
2. list_sessions(workspace_id="xxx") → 只看某个工作区的会话
3. create_session(workspace_id="xxx") → 在指定工作区创建会话
   新会话自动获得该工作区的文件访问权限
```

### 模式 5：会话归档与清理

```
1. archive_session(session_id) → 归档已完成/不需要的会话
2. archive_session(session_id, archived=false) → 取消归档
3. list_sessions(include_archived=true) → 查看含归档的完整列表
```

归档的会话默认不在 `list_sessions` 中显示，但数据不丢失、可随时恢复。

---

### 模式 10：局域网实例发现

在启动时设置了 `PROMA_BRIDGE_HOST=0.0.0.0` 的前提下，可以跨机器发现和操作 Proma 实例：

```
1. discover_instances() → 查看本地所有运行中的实例
2. discover_instances(hosts=["192.168.1.100"]) → 扫描局域网指定 IP
   → 返回 { instances: [{ name: "pro", host: "192.168.1.100", port: 19878 }], cached: false }
3. 后续用 instance="192.168.1.100:19878" 直连：
   - remote_list_channels(instance="192.168.1.100:19878")
   - remote_create_session(instance="192.168.1.100:19878", ...)
   - remote_send_message(instance="192.168.1.100:19878", ...)
```

**instance 参数支持两种格式：**
- `"dev"` / `"pro"` / `"release"` — 纯名字，走 localhost 端口扫描（兼容原有）
- `"192.168.1.100:19876"` — `host:port` 直连，跳过端口扫描，适用于局域网

**跨机 CLI 连接：** `node proma-mcp-server.cjs --dev --host 192.168.1.100`

---

## 外部 MCP 使用模式

> 以下模式适用于**方式 B（外部工具）**。内部 Agent 请参考"内部 Agent 使用模式"章节。

### 黄金规则 1：本地 vs 远端数据隔离

**本地 MCP 工具（`mcp__session__*`）只能操作本机 Proma 实例。远端 Dev/Release 实例的会话、消息、工作区等数据，必须通过 curl/HTTP 直接调用远端 HTTP bridge 获取。** 用本地 `get_session_info` 查 Dev 上的 session ID 会返回 "Session not found"——这不是 bug，是实例隔离。

```
本地 Proma ← mcp__session__* 工具（你在这个实例里）
远端 Dev  ← curl http://127.0.0.1:PORT/*（完全独立的另一个进程）
```

验证远端数据时，**每一步都必须用 curl**，不可混用本地 MCP 工具。

### 黄金规则 2：curl 中文编码

**任何含中文的 curl JSON 请求必须用 `printf` + `--data-binary @-` 管道方式。** Windows Bash 下 `curl -d '...中文...'` 会将 UTF-8 转为 GBK 导致远端接收乱码。此规则适用于所有工具调用（`create_session` 标题、`send_message` 消息、`archive_session` 等），不限于某个步骤。

```bash
# ✅ 正确：管道方式，UTF-8 无损（所有含中文的 JSON 请求都用这个模式）
printf '{"title":"中文标题","channel_id":"xxx","workspace_id":"yyy"}' | \
  curl -s -X POST http://127.0.0.1:PORT/create_session \
  -H "Content-Type: application/json" --data-binary @-

# ❌ 错误：-d 参数含中文（Windows Bash 转 GBK → 远端乱码）
curl -X POST http://127.0.0.1:PORT/create_session -d '{"title":"中文标题",...}'

# ✅ 无中文的简单 JSON 仍可单行
curl -s -X POST http://127.0.0.1:PORT/list_channels --data-binary '{}'
```

### 模式 6：外部轮询回收

外部调用者不支持 `notify=true`，用 fire-and-forget + 轮询实现并行调度：

```
1. send_message(wait=false) × N → 立即返回 "started"
2. 定时轮询 get_session_context(target)
   → token 连续两次不变且非零 → 任务完成
3. list_messages(target, limit=1) → 取最后一条 assistant 文本
```

轮询间隔建议 3-5 秒。`get_session_context` 返回的 `usage.total` 为 0 表示尚未开始推理。

### 模式 7：跨实例会话管理

如果你同时配置了 Dev 和 Release 两个 MCP server，可以跨实例操作：

```
Dev 实例（测试/调试）           Release 实例（日常使用）
  ├─ create_session              ├─ create_session
  ├─ send_message(wait=false)    ├─ send_message(wait=true)
  └─ archive_session（清理）      └─ list_sessions（日常管理）
```

**典型场景：**
- Dev 实例开一批小弟并行测试 → 确认没问题 → 在 Release 实例上执行正式任务
- Release 实例积累太多测试会话 → `archive_session` 批量清理
- Dev 上验证新补丁 → Fork 一个正式会话到 Release 上继续

### 模式 8：脚本自动化

外部脚本可顺序调用工具，严格遵守上述黄金规则：

```bash
# 无中文请求 → --data-binary 单行即可
curl -s -X POST http://127.0.0.1:PORT/list_channels --data-binary '{}'
curl -s -X POST http://127.0.0.1:PORT/list_sessions --data-binary '{"include_archived":true}'

# 含中文请求 → 必须 printf + 管道
printf '{"channel_id":"xxx","model_id":"deepseek-v4-flash","title":"中文标题","workspace_id":"yyy"}' | \
  curl -s -X POST http://127.0.0.1:PORT/create_session -H "Content-Type: application/json" --data-binary @-

printf '{"session_id":"xxx","message":"你好世界请回复OK","wait":true}' | \
  curl -s -X POST http://127.0.0.1:PORT/send_message -H "Content-Type: application/json" --data-binary @- --max-time 120
```

端口号从 `GET /get_instance_info` 获取，或查看 Proma 控制台日志 `External MCP HTTP bridge: http://127.0.0.1:XXXXX`。

---

## 外部 MCP 配置详解

### 端口发现机制

每个 Proma 实例启动时自动占用 19876-19895 范围内第一个空闲端口，并暴露身份端点：

```
GET /get_instance_info
→ { "proma_dev": true, "port": 19876 }    ← Dev 实例 (PROMA_DEV=1)
→ { "proma_dev": false, "port": 19877 }   ← Release 实例
```

`proma-mcp-server.cjs` 启动时：
1. 扫描 19876-19895 全部端口（2 秒超时/端口）
2. 对每个端口调用 `GET /get_instance_info` 获取身份
3. 根据 `--dev` / `--release` 参数匹配目标实例
4. 匹配规则：`--dev` → `proma_dev=true` 的端口；`--release` → `proma_dev=false`
5. 无精确匹配时 fallback 到第一个找到的实例
6. 扫描结果输出到 stderr（不影响 MCP 协议）

**启动参数：**
```bash
node proma-mcp-server.cjs                    # 默认 --dev
node proma-mcp-server.cjs --dev               # 连接 Dev 实例 (localhost)
node proma-mcp-server.cjs --release           # 连接 Release 实例 (localhost)
node proma-mcp-server.cjs --dev --host 192.168.1.100  # 直连局域网实例
```

### 单实例配置（仅 Dev 或仅 Release）

**`.claude/mcp.json`（项目级）或 `%USERPROFILE%/.claude/claude_desktop_config.json`（全局）：**

```json
{
  "mcpServers": {
    "proma-dev-session": {
      "command": "node",
      "args": ["D:\\Proma-dev\\resources\\app\\dist\\proma-mcp-server.cjs", "--dev"]
    }
  }
}
```

Release 版将 `--dev` 改为 `--release`，名称改为 `proma-release-session`。

### 双实例配置（Dev + Release 同时连接）

```json
{
  "mcpServers": {
    "proma-dev-session": {
      "command": "node",
      "args": ["D:\\Proma-dev\\resources\\app\\dist\\proma-mcp-server.cjs", "--dev"]
    },
    "proma-release-session": {
      "command": "node",
      "args": ["D:\\Proma-dev\\resources\\app\\dist\\proma-mcp-server.cjs", "--release"]
    }
  }
}
```

两个 MCP server 各自独立扫描端口、各自连接对应实例。工具名称相同但 `serverInfo.name` 不同（`proma-dev-session` vs `proma-release-session`），方便区分。

**注意：** 两个实例必须**同时运行**。如果目标实例未启动，MCP server 会在 `initialize` 时报错。

### 验证连接

配置完成后，在 Claude Code 中：
1. 调用 `list_channels` → 返回该实例的渠道列表
2. 调用 `get_my_session_id` → 外部调用返回 `{ session_id: null, is_external: true }`
3. 调用 `list_sessions` → 返回该实例的所有会话

---

## 消息历史与 UUID

`list_messages` 返回每条消息的：
- `index` — 序号
- `type` — user / assistant / result
- `uuid` — SDK 消息唯一标识（**用于 fork_session 的 up_to_message_uuid**）
- `role` — user / assistant
- `text` — 文本内容（截取前 500 字）
- `text_full_length` — 完整文本长度
- `timestamp` — 时间戳
- `usage` — token 用量（仅 result 类型）
- `error_code` / `error_title` — 错误信息（如有）

**UUID 注意事项：**
- headless 会话（通过 send_message 启动的）的 user 消息可能没有 UUID
- Fork 时用 **assistant** 或 **result** 消息的 UUID，不要用 user 消息的
- `up_to_message_uuid` 指定的消息**包含**在新会话的上下文中（即 Fork 后新会话能看到这条消息）

---

## send_message 三模式

| 参数 | 行为 | 适用场景 | 可用范围 |
|---|---|---|---|
| `wait=true` (默认) | 阻塞等目标完成，返回 `reply` 字段含 Agent 输出文本 | 短任务，需要即时结果 | 内部 + 外部 |
| `wait=false, notify=true` | 立即返回 `"started"`，目标完成后通知源会话 | 内部 Agent 异步协作 | **仅内部 Agent** |
| `wait=false` | 纯 fire-and-forget，无通知 | 不关心结果，或配合模式 6 轮询回收 | 内部 + 外部 |

**外部调用 `notify=true` 返回错误：** `"notify=true is not supported from external MCP (no source session). Use wait=true (default) or wait=false without notify."`

**出错时** 返回 `{ session_id, status: "error", error: "错误描述" }`，无论 wait 参数如何。

---

## 模型甜点区参考

| 模型 | 上下文窗口 | 甜点区 | 建议交接线 |
|---|---|---|---|
| DeepSeek V4 Pro | 1M | 150K-250K | 200K (20%) |
| DeepSeek V4 Flash | 1M | 80K-150K | 120K |
| Claude Sonnet 4.6 | 1M | 100K-200K | 150K |
| GLM-5-Turbo | 128K | 50K-80K | 60K |
| GLM-4.5-Air | 128K | 40K-70K | 55K |

**甜点区说明：** 在此范围内推理质量最佳。超出甜点区后注意力稀释、质量下降。`usage_pct` 达到 60-85% 时考陑竹节交接（模式 3）。

---

## 注意事项

### 通用
- **内部 Agent** 第一步调用 `get_my_session_id` 获取自己的会话 ID
- **外部工具** `get_my_session_id` 返回 `null`，这是正常的
- 创建/fork 的会话在 Proma 侧边栏需手动刷新才能看到
- 省钱优先：能用 deepseek-v4-flash 就别用 deepseek-v4-pro

### 内部 Agent 特有
- `send_message(notify=true)` 可用，源会话 ID 通过 MCP server 闭包自动捕获
- `runAgentHeadless` 有并发守卫，同一会话同时只能有一个 headless run
- 通知消息在源会话空闲时送达，正在处理用户消息时会排队

### 外部 MCP 特有
- `send_message` 外部不支持 `notify=true`，用模式 6（轮询回收）替代
- Proma 实例必须运行中，否则 MCP server 在 `initialize` 时报错
- Dev 和 Release 可同时连接，但它们是**独立的**两个 MCP server
- 端口范围 19876-19895 硬编码，不通过配置文件

### 已知限制
- 跨渠道 Fork（如 DeepSeek→GLM）一般可用，个别情况可能因 SDK session GC 失败
- 跨渠道 UI 切换模型已通过补丁 F 修复，不再触发 "Session 已失效"
- headless 会话的 usage 数据可能不完整（无 context_window），正常现象
- cloud-auth token 在 Dev/Release 间共享，一方刷新后另一方可能失效

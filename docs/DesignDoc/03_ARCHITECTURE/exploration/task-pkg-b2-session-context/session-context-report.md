# 会话管理与上下文机制 — 可行性分析报告

> 任务包 B2 | 日期：2026-06-06 | 调查对象：Proma 源码 `proma-source/`

---

## 决策记录

**MVP 阶段采用串行角色切换方案。** 放弃"需求分析师 + UI/UX 顾问并行"的多模型并发需求，改为在同一会话内按阶段串行切换角色：

```
需求分析师（对话引导） → UI/UX顾问（原型生成） → 架构设计师（技术选型） → 工程经理（Sprint规划）
```

理由：
- Proma 当前架构单会话单模型 + 并发守卫，无法直接支持多模型并发
- 串行切换改动量 ~9h，并行方案需要 ~30h 且涉及架构级变更
- 串行方案已能满足快消型和长期迭代型的完整流程，用户体感上只是"同一个人在不同阶段用不同方式帮你"
- 远期如果产品验证了并行价值，双会话并行方案（报告 §3.2 方案 A/D）已预留扩展点

---

## 1. 会话生命周期

### 1.1 完整流程图

```
┌─────────────────────────────────────────────────────┐
│                   会话生命周期                         │
├─────────────────────────────────────────────────────┤
│                                                       │
│  [用户创建会话]                                        │
│       │                                               │
│       ▼                                               │
│  createAgentSession()                                 │
│   ├─ 写入 agent-sessions.json (索引)                   │
│   ├─ 创建 ~/.proma/agent-sessions/{id}.jsonl          │
│   ├─ 初始化 .claude/settings.json                     │
│   └─ 初始化 .context/ 目录                            │
│       │                                               │
│       ▼                                               │
│  [用户发送消息]                                        │
│       │                                               │
│       ▼                                               │
│  agent-orchestrator.runAgent()                        │
│   ├─ 构建 systemPrompt (buildSystemPrompt)            │
│   ├─ 构建 dynamicContext (buildDynamicContext)        │
│   ├─ 解析模型路由 (resolveAgentModelRouting)          │
│   ├─ 注入 SubAgent 定义 (buildBuiltinAgents)          │
│   ├─ 调用 SDK adapter.query()                         │
│   │   ├─ 流式接收 SDK 事件                            │
│   │   ├─ 累积文本 → 推送到 UI                          │
│   │   └─ 捕获 sdkSessionId                            │
│   ├─ 持久化 SDKMessages → JSONL                       │
│   └─ 更新 updatedAt                                   │
│       │                                               │
│       ▼                                               │
│  [下一轮消息] → SDK resume (sdkSessionId 续接)        │
│       │                                               │
│       ▼                                               │
│  [生命周期操作]                                        │
│   ├─ fork   → 复制 JSONL + 重映射 UUID                │
│   ├─ rewind → 回到指定消息处重建会话                   │
│   ├─ archive → 设置 archived=true                     │
│   ├─ migrate → 跨工作区迁移                            │
│   └─ delete → 删除 JSONL + 索引条目                    │
│                                                       │
└─────────────────────────────────────────────────────┘
```

### 1.2 存储结构

| 层级 | 路径 | 格式 | 内容 |
|------|------|------|------|
| 会话索引 | `~/.proma/agent-sessions.json` | JSON | 所有会话元数据（id, title, channelId, sdkSessionId, workspaceId, 时间戳） |
| 消息持久化 | `~/.proma/agent-sessions/{id}.jsonl` | JSONL | 每条消息一行 JSON，支持 AgentMessage（旧）和 SDKMessage（新）两种格式 |
| SDK 会话 | `sdkSessionId` 存在元数据中 | SDK 内部 | SDK 原生会话恢复能力 |

### 1.3 关键发现

- **并发守卫**：`agent-orchestrator.ts:937` — `this.activeSessions.has(sessionId)` 检查后拒绝新请求。实现为 `Map<string, number>`（`agent-orchestrator.ts:509`），`runAgent()` 入口处加锁（`:1036`），finally 块释放（`:1040-1041`）。这是多角色并行的直接限制。
- **消息自动截断**：`agent-session-manager.ts:205` — `MAX_SDK_MESSAGE_LENGTH = 256 * 1024`（~256K chars），序列化时检查长度（`:223-228`），超大消息通过 `sanitizeOversizedMessage()` 截断 text 和 tool_result 的 content（`:243-262`），保留前 2000 字符预览（`:207`）。
- **会话恢复**：支持三种恢复模式 — (a) 正常 SDK resume（`:1540` `resumeSessionId`）；(b) session-not-found 降级：`prepareResumeFallbackRecovery()`（`:861-881`）清除失效 `sdkSessionId`，注入 `<session_recovery>` 标签自引用 JSONL 完整历史；(c) thinking signature 不兼容恢复，复用同一恢复路径。

---

## 2. System Prompt 机制

### 2.1 当前实现

Proma 有**两套** System Prompt 机制，服务于不同模式：

#### Chat 模式（`system-prompt-manager.ts`）

```
存储层：~/.proma/system-prompts.json
├─ 内置默认 prompt（BUILTIN_DEFAULT_PROMPT）
├─ 用户自定义 prompt（CRUD）
├─ 支持设默认、追加日期/用户名
└─ 加载方式：会话启动时从文件读取
```

#### Agent 模式（`agent-prompt-builder.ts`）★ 核心调查对象

```
构建方式：纯代码动态构建（不从文件加载）
├─ 管道：buildSystemPrompt(ctx) → 追加到 SDK preset 之后
│
├─ 组成部分：
│   ├─ Agent 角色定义（"你是 Proma Agent..."）
│   ├─ 工具使用指南（Read/Edit/Write/Bash/MCP 等）
│   ├─ SubAgent 委派策略（根据模型类型动态调整 Claude/DeepSeek）
│   ├─ 用户信息、工作区信息
│   ├─ 上下文管理指南
│   ├─ 文档输出与知识管理规范
│   ├─ 任务完成标准
│   └─ 交互规范
│
├─ 构建时机：每次 runAgent() 调用时构建
└─ SDK 传递方式：{ type: 'preset', preset: 'claude_code', append: buildSystemPrompt(...) }
```

另外还有 `buildDynamicContext()` 在每条用户消息前注入实时信息（当前时间、工作区状态、MCP 列表、附加目录等）。

### 2.2 当前机制能否支持角色动态切换？

**结论：能，但需要改动。**

当前 `buildSystemPrompt()` 的输入参数 `SystemPromptContext`（`agent-prompt-builder.ts:133-144`）只包含：`workspaceName`、`workspaceSlug`、`sessionId`、`permissionMode`、`memoryEnabled`、`claudeAvailable`、`deepSeekSubagentModel`。**它不知道当前的"项目阶段"**——没有任何 `phase` 字段。

`buildSystemPrompt()` 在每次 `runAgent()` 调用时被构建，通过 SDK options 注入（`agent-orchestrator.ts:1527-1539`）：

```typescript
// agent-orchestrator.ts:1527-1539 (实际源码)
systemPrompt: {
  type: 'preset',
  preset: 'claude_code',
  append: buildSystemPrompt({
    workspaceName: workspace?.name,
    workspaceSlug,
    sessionId,
    permissionMode: initialPermissionMode,
    memoryEnabled: (() => { const mc = getMemoryConfig(); return mc.enabled && !!mc.apiKey })(),
    claudeAvailable,
    deepSeekSubagentModel: modelRouting.subagentModel,
  }),
},
```

要支持四角色切换，需要：

1. **新增阶段状态机**：在 `AgentSessionMeta` 或独立的状态文件（如项目目录下的 `.context/phase.json`）中存储当前阶段
2. **扩展 SystemPromptContext**：增加 `phase` 参数（`'requirement' | 'ux' | 'architecture' | 'engineering'`）
3. **注入角色 prompt**：在 `buildSystemPrompt()` 中根据 phase 注入对应的角色指令，替代/追加当前的通用角色定义
4. **阶段切换触发**：在用户确认需求后（US-G06 的验收条件），路由层更新阶段状态，下一次 query 自动使用新角色 prompt

#### Prompt 存储策略：TypeScript 内联 vs 外部文件

PRD §13.2 要求"独立 System Prompt 文件"，但有两种实现策略：

| 策略 | 优点 | 缺点 |
|------|------|------|
| **TS 内联**（与现有模式一致） | 复用现有 `agent-prompt-builder.ts` 管道；类型安全；不需要文件 I/O；与 SubAgent metadata 定义模式一致（`:33-88`） | 非技术人员无法编辑；修改需重新编译 |
| **外部 .md 文件** | 可独立编辑；产品经理可直接调整 prompt 措辞；热加载无需重编译 | 需新增文件读取逻辑；文件缺失时需降级；引入了与现有机制不同的加载模式 |

**决策**：MVP 采用 TS 内联方案。理由：(1) 与 Proma 现有的 `SUBAGENT_METADATA`（`:33-88`）和 `BUILTIN_DEFAULT_PROMPT`（`system-prompt.ts`）定义模式一致；(2) 现阶段没有非技术人员编辑 prompt 的需求；(3) 后续如需外部化，只需将 `getRolePrompt()` 改为 `readFileSync()` 即可，改动是局部的。

---

## 3. 多模型支持现状

### 3.1 当前架构

```
一个会话 = 一个渠道(Provider) × 一个模型(Model)
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
               主 Agent        SubAgent 1      SubAgent 2
            (session model)   (独立模型路由)    (独立模型路由)
```

**主模型绑定**：
- 会话元数据存有 `channelId` → 查渠道配置 → 得 Provider + API Key（`agent-orchestrator.ts:502` `getChannelById(channelId)`）
- 每次 query 可指定 `modelId`（同一 provider 的不同模型），在 `queryOptions.model` 中传递（`:1511`），但 provider 固定
- 不支持一次 query 同时使用两个不同 provider 的主模型：`runAgent()` 单次调用构建一组 `queryOptions`，顶多只有一个 `model`

**SubAgent 模型**：
- `agent-model-routing.ts:3` — `DEEPSEEK_SUBAGENT_MODEL_ID = 'deepseek-v4-flash'`
- `agent-model-routing.ts:23-33` — `resolveAgentModelRouting()` 检测 DeepSeek 系列：`deepSeekFamily = input.provider === 'deepseek' || model.startsWith('deepseek-') || model.includes('/deepseek-')`
- `agent-model-routing.ts:35-44` — `applyAgentModelRoutingToEnv()` 将模型写入 `CLAUDE_CODE_SUBAGENT_MODEL` 环境变量，SDK 读取该变量统一控制所有 SubAgent
- 内置 SubAgent 的 tools 定义在 `agent-prompt-builder.ts:37-88`：code-reviewer（Read/Glob/Grep/Bash）、explorer（同上）、researcher（+WebSearch/WebFetch）— 均无 HTML 生成或多模态能力

### 3.2 关键判定：能否支持"需求分析师 + UI/UX顾问并行"？

**PRD 要求**（§4.3）：

> 需求分析师 + UI/UX顾问并行工作：图形化界面的描述也是揭示需求的过程，两者共同完成完整PRD（含UX原型）

这意味着**同一轮对话中**需要两个角色同时运行：
- 需求分析师：纯文本对话，引导用户挖掘需求
- UI/UX 顾问：生成 HTML 原型，展示视觉预览

**当前 Proma 限制**：

| 限制 | 详情 |
|------|------|
| 并发守卫 | `agent-orchestrator.ts` 明确阻止同一会话并行请求 |
| 单一模型绑定 | 一次 query 只能是一个 provider + model |
| SubAgent 模型 | SubAgent 不支持多模态（仅 Read/Glob/Grep/Bash 工具） |
| UI 层 | 单一线程的流式输出，无"双通道"回复机制 |

**方案分析**：

| 方案 | 描述 | 可行性 | 复杂度 |
|------|------|--------|--------|
| A. 双会话并行 | 创建两个 Agent 会话（需求分析师 × 需求模型，UI/UX × 多模态模型），通过事件总线协调，UI 层合并展示两个会话的输出 | ⚠️ 可行但重 | 高 |
| B. 单会话 SubAgent | 主 Agent 为需求分析师，UI/UX 作为自定义 SubAgent（需给 SubAgent 增加 HTML 生成 + 多模态工具） | ⚠️ 部分可行 | 中 |
| C. 单会话串行切换 | 先需求分析师对话 → 切换模型/Prompt → UI/UX 生成原型 → 切回 | ✅ 可行 | 低（但不满足"并行"要求） |
| D. 混合模式 | 主会话负责对话 + 文本回复，后台异步启动 UI/UX 任务生成原型，结果通过事件总线推送到前端侧边栏 | ⚠️ 可行 | 中高 |

**决策**：MVP 采用 **方案 C（串行切换）**。需求分析师对话收集需求 → 切到 UI/UX 角色生成原型 → 用户确认后继续。事件总线接口保留扩展点，远期可升级为方案 A/D 并行化。

---

## 4. 上下文管理

### 4.1 三层持久化体系

```
┌────────────────────────────────────────────┐
│           第一层：会话级消息持久化            │
├────────────────────────────────────────────┤
│ 存储：~/.proma/agent-sessions/{id}.jsonl   │
│ 格式：JSONL（每条消息一行）                  │
│ 内容：完整对话历史（user/assistant/system）  │
│ 限制：单条 >256K chars 自动截断（`agent-session-manager.ts:205-228`，`MAX_SDK_MESSAGE_LENGTH = 256 * 1024`）
│ 搜索：全量 JSONL 按关键词全文搜索            │
└────────────────────────────────────────────┘
                      │
                      ▼
┌────────────────────────────────────────────┐
│           第二层：SDK 会话恢复               │
├────────────────────────────────────────────┤
│ sdkSessionId 存储在会话元数据中              │
│ 每次 query 传入 resumeSessionId 续接        │
│ 失效处理：`prepareResumeFallbackRecovery()`（`agent-orchestrator.ts:861-881`）清除旧 sdkSessionId，注入 `<session_recovery>` 标签自引用 JSONL 完整历史，让 Agent 自己读取（优于仅注入 20 条摘要，`:859`） │
│ 支持 fork（从指定消息分支）                   │
│ 支持 rewind（快照文件回退）                   │
└────────────────────────────────────────────┘
                      │
                      ▼
┌────────────────────────────────────────────┐
│         第三层：跨会话长期记忆                │
├────────────────────────────────────────────┤
│ 存储：MemOS Cloud（远程记忆服务）            │
│ 配置：~/.proma/memory.json                 │
│ 运行时：通过 MCP 工具注入                    │
│   - recall_memory：按关键词检索              │
│   - add_memory：写入记忆                    │
│ 本地延伸：CLAUDE.md / .context/note.md     │
└────────────────────────────────────────────┘
```

### 4.2 Token 窗口管理

- SDK 内置压缩机制：默认 200K token 窗口，约 150K 触发自动压缩
- 1M context window 可选：支持的模型自动启用 beta（`context-1m-2025-08-07`）
- 消息摘要：session-not-found 恢复时注入最近 20 条消息摘要

### 4.3 跨阶段上下文保持能力

**✅ 完全可行**。PRD 要求的"需求→原型→架构→工程"四阶段串联，上下文保持机制已具备：

| 需求 | 已有能力 | 利用方式 |
|------|---------|---------|
| 阶段间上下文连续 | SDK session resume (sdkSessionId) | 同一会话内自动保持 |
| 阶段切换点可回溯 | fork 机制 | 在阶段切换点自动 fork，支持回退 |
| 跨文档传递上下文 | 文件体系 + `.context/` 目录 | 每阶段产物写入项目目录，后续阶段读取 |
| 长期记忆跨会话 | MemOS Cloud + CLAUDE.md | 用户偏好、项目决策写入记忆 |

---

## 5. 会话间通信

### 5.1 当前能力

**Proma 不支持会话间的直接通信。** 现有机制：

| 机制 | 用途 | 能否用于会话间通信 |
|------|------|-------------------|
| Fork | 从某条消息分叉出新会话（复制 JSONL + 重映射 UUID） | 单向复制，非双向通信 |
| EventBus | 同一会话的事件分发 | 按 sessionId 分发，不跨会话 |
| 文件系统 | 项目目录共享 | ✅ 可跨会话读写 |
| 记忆服务 | 跨会话长期记忆 | ✅ 可跨会话读写 |
| Workspace 附加目录 | 工作区共享目录 | ✅ 可跨会话读写 |

### 5.2 会话间通信的可行路径

如果要实现"需求分析师会话"和"UI/UX会话"并行协作，需要：

1. **共享工作区文件系统**：两个会话都附加同一工作区，通过 `.context/` 目录下的文件传递状态
2. **协调层**：一个轻量状态文件（如 `.context/phase-state.json`）记录各角色的产出和状态
3. **UI 合并层**：前端同时订阅两个会话的 EventBus 事件，合并展示

---

## 6. 可行性结论

### 6.1 角色路由：⚠️ 可行，需中等改动

| 子项 | 判定 | 说明 |
|------|------|------|
| System Prompt 按阶段切换 | ✅ | `buildSystemPrompt()` 扩展 phase 参数即可 |
| 模型按阶段切换 | ✅ | 每次 query 可传不同 modelId |
| 阶段状态机 | ✅ | 存储在 session meta 或项目 .context/ 中 |
| 用户无感知切换 | ✅ | UI 层平滑过渡，角色切换在后台完成 |
| 异常降级 | ✅ | 已有 session-not-found 降级模式可复用 |

**需要的改动**：
1. `AgentSessionMeta` 增加 `phase` 字段
2. `buildSystemPrompt()` 增加 phase → role prompt 映射
3. 新增 `role-prompts.ts` 定义四角色 System Prompt
4. 路由层：监听用户确认信号 → 更新 phase → 下次 query 自动切换

### 6.2 多模型并发：❌ 当前不支持，需重大改动

**这是本次调查发现的最大架构风险点。**

| 阻塞项 | 严重度 | 详情 |
|--------|--------|------|
| 并发守卫 | 🔴 阻塞 | `agent-orchestrator.ts:937` `this.activeSessions.has(sessionId)` 硬编码拒绝并行请求 |
| 单模型绑定 | 🔴 阻塞 | 一次 query 只能一个 provider（`:1511` `model: modelId \|\| DEFAULT_MODEL_ID`） |
| UI 单通道 | 🟡 需改 | 前端目前只有一条消息流 |
| SubAgent 能力受限 | 🟡 需改 | `agent-prompt-builder.ts:37-88` SubAgent tools 无 HTML 生成/多模态 |

**推荐策略**：

- **MVP 阶段**：采用串行切换方案（方案 C），先跑通完整流程。需求分析师对话收集需求 → 切换到 UI/UX 角色生成原型 → 用户确认后继续。这样改动最小，风险最低。
- **后续迭代**：迁移到双会话并行方案（方案 A/D），需要：
  1. 移除并发守卫或新增并行会话组概念
  2. 前端增加双通道 UI（对话区 + 预览区）
  3. 事件总线支持跨会话消息协调

### 6.3 跨阶段上下文保持：✅ 完全可行

| 子项 | 判定 | 说明 |
|------|------|------|
| 同会话上下文连续 | ✅ | SDK session resume 原生支持 |
| 阶段切换点回溯 | ✅ | fork 机制可复用 |
| 跨文档数据传递 | ✅ | 文件体系 + .context/ 目录 |
| 长期记忆跨会话 | ✅ | MemOS Cloud + CLAUDE.md |
| 用户偏好持久化 | ✅ | memory 工具（recall/add_memory） |

---

## 7. 改动量预估

### 7.1 角色路由（MVP 必需）

| 改动项 | 文件 | 工作量 | 风险 |
|--------|------|--------|------|
| 四角色 Prompt 定义 | `role-prompts.ts`（新增） | 2h | 低 — 纯文本配置 |
| 阶段状态模型 | `agent.ts`（类型扩展） | 0.5h | 低 |
| buildSystemPrompt 扩展 | `agent-prompt-builder.ts` | 1h | 低 |
| 路由层 | `agent-orchestrator.ts` | 2h | 中 — 需确保切换不中断 SDK session |
| UI 状态栏更新 | 前端渲染进程 | 1h | 低 |
| **小计** | | **6.5h** | |

### 7.2 多模型串行切换（MVP 路线）

| 改动项 | 文件 | 工作量 | 风险 |
|--------|------|--------|------|
| 模型按阶段映射 | `agent-orchestrator.ts` | 1h | 低 |
| 渠道切换逻辑 | `agent-orchestrator.ts` | 1.5h | 中 — 不同渠道 API Key 切换 |
| **小计** | | **2.5h** | |

### 7.3 多模型并行（远期路线）

| 改动项 | 文件 | 工作量 | 风险 |
|--------|------|--------|------|
| 双会话并行引擎 | `agent-orchestrator.ts`（重构） | 8h | 高 — 架构级变更 |
| 会话协调层 | `session-coordinator.ts`（新增） | 4h | 高 |
| 前端双通道 UI | 渲染进程 | 6h | 中 |
| 跨会话 EventBus | `agent-event-bus.ts` | 3h | 中 |
| **小计** | | **21h** | |

### 7.4 总览

| 范围 | 工作量 | 风险等级 |
|------|--------|---------|
| MVP 角色路由 + 串行切换 | **~9h** | 🟢 低 |
| MVP + 上下文保持增强 | **~12h** | 🟢 低 |
| 远期：真并行多模型 | **~30h**（含 MVP 部分） | 🔴 高 |

---

## 8. 总结与建议

### 核心结论

**Proma 的会话和上下文基础设施是坚实的**，为向导Agent的"串行四阶段"角色路由提供了良好的支持。主要改动集中在 `agent-prompt-builder.ts` 和 `agent-orchestrator.ts` 两个文件，预计 6-9 小时完成 MVP 所需的角色路由能力。

**多模型并行已明确推迟到远期。** MVP 采用串行角色切换——同一会话内依次执行需求分析师 → UI/UX顾问 → 架构设计师 → 工程经理，用户体感是"同一个向导在不同阶段用不同方式帮你"而非多个 Agent 同时发言。并行化在验证产品价值后再投入。

### 风险项

1. **SDK session 跨模型 resume**：切换模型 ID 后 SDK 能否正常 resume，需要实测验证。如果 SDK 的 session 绑定模型，则切换模型时可能需要创建新 session 并回填历史上下文。
2. **多模态模型可用性**：UI/UX 顾问需要视觉能力模型（如 Google Gemini Pro 或 GPT-4o），需确认这些模型在 Anthropic 兼容协议下的 Agent 模式是否正常工作。
3. **SubAgent 模型路由与主 Agent 切换的交互**：如果主 Agent 和 SubAgent 使用不同模型，DeepSeek 场景下已有限制（所有 SubAgent 固定 flash），需要确认切换后的行为。

---

## 附录：证据索引

所有结论均以下列 Proma 源码引用为证据基础。每条引用含精确文件路径和行号，可独立验证。

### 会话管理

| 证据 | 文件 | 行号 | 说明 |
|------|------|------|------|
| 会话索引读写 | `agent-session-manager.ts` | `:46-78` | `AgentSessionsIndex` 类型 + `readIndex()` / `writeIndex()` |
| 创建会话 | `agent-session-manager.ts` | `:99-157` | `createAgentSession()` 完整实现 |
| 消息追加（旧格式） | `agent-session-manager.ts` | `:182-202` | `appendAgentMessage()` |
| SDK消息持久化 | `agent-session-manager.ts` | `:215-308` | `appendSDKMessages()` 含截断逻辑 |
| 消息截断阈值 | `agent-session-manager.ts` | `:205` | `MAX_SDK_MESSAGE_LENGTH = 256 * 1024` |
| 截断后预览长度 | `agent-session-manager.ts` | `:207` | `TRUNCATED_PREVIEW_LENGTH = 2000` |
| Fork 会话 | `agent-session-manager.ts` | `:621` | `forkAgentSession()` |
| 快照回退 | `agent-session-manager.ts` | `:1067` | `rewindFilesFromSnapshot()` |
| 消息全文搜索 | `agent-session-manager.ts` | `:1093` | `searchAgentSessionReferences()` |
| 配置路径 | `config-paths.ts` | — | `getAgentSessionsDir()`, `getAgentSessionsIndexPath()`, `getAgentSessionMessagesPath()` |

### System Prompt 机制

| 证据 | 文件 | 行号 | 说明 |
|------|------|------|------|
| SystemPromptContext 接口 | `agent-prompt-builder.ts` | `:133-144` | 7 个字段（无 phase） |
| buildSystemPrompt() | `agent-prompt-builder.ts` | `:155` | 构建函数签名 |
| buildDynamicContext() | `agent-prompt-builder.ts` | `:492` | 动态上下文构建 |
| buildBuiltinAgents() | `agent-prompt-builder.ts` | `:116-130` | SubAgent 注册 |
| SUBAGENT_METADATA | `agent-prompt-builder.ts` | `:33-88` | 3 个内置 SubAgent 定义 |
| SP 注入到 SDK | `agent-orchestrator.ts` | `:1527-1539` | `systemPrompt: { type: 'preset', preset: 'claude_code', append: ... }` |
| Chat 模式 SP CRUD | `system-prompt-manager.ts` | — | CRUD + 内置默认 prompt |
| 内置默认 prompt | `packages/shared/src/types/system-prompt.ts` | `:50-107` | `BUILTIN_DEFAULT_PROMPT` |

### 模型路由与多Agent

| 证据 | 文件 | 行号 | 说明 |
|------|------|------|------|
| DeepSeek SubAgent 模型 | `agent-model-routing.ts` | `:3` | `DEEPSEEK_SUBAGENT_MODEL_ID = 'deepseek-v4-flash'` |
| 模型路由策略 | `agent-model-routing.ts` | `:23-33` | `resolveAgentModelRouting()` |
| 环境变量注入 | `agent-model-routing.ts` | `:35-44` | `applyAgentModelRoutingToEnv()` |
| Provider 类型定义 | `packages/shared/src/types/channel.ts` | `:11-25` | 14 种 `ProviderType` |
| Agent 兼容 Provider | `packages/shared/src/types/channel.ts` | `:73-80` | `AGENT_COMPATIBLE_PROVIDERS` |

### 并发控制与会话恢复

| 证据 | 文件 | 行号 | 说明 |
|------|------|------|------|
| 活跃会话表 | `agent-orchestrator.ts` | `:509` | `activeSessions = new Map<string, number>()` |
| 并发守卫 | `agent-orchestrator.ts` | `:937-942` | `if (this.activeSessions.has(sessionId))` 拒绝 |
| 加锁 | `agent-orchestrator.ts` | `:1036` | `this.activeSessions.set(sessionId, runGeneration)` |
| 释放 | `agent-orchestrator.ts` | `:1040-1041` | `this.activeSessions.delete(sessionId)` |
| 中止会话 | `agent-orchestrator.ts` | `:2159-2166` | `stop()` |
| session-not-found 恢复 | `agent-orchestrator.ts` | `:840-852` | `handleSessionNotFound()` |
| Resume 降级 | `agent-orchestrator.ts` | `:861-881` | `prepareResumeFallbackRecovery()` |
| buildRecoveryPrompt | `agent-orchestrator.ts` | `:370-389` | `<session_recovery>` 标签 |
| 跨会话引用注入 | `agent-orchestrator.ts` | `:394-430` | `buildReferencedSessionsPrompt()` |
| SDK resumeSessionId | `agent-orchestrator.ts` | `:1540` | `resumeSessionId: existingSdkSessionId` |
| 1M context window | `agent-orchestrator.ts` | `:1564-1566` | `betas: ['context-1m-2025-08-07']` |

### 事件总线与会话隔离

| 证据 | 文件 | 行号 | 说明 |
|------|------|------|------|
| EventBus emit | `agent-event-bus.ts` | `:34` | `emit(sessionId, payload)` — 按 sessionId 路由 |
| Handler 签名 | `agent-event-bus.ts` | `:15` | `(sessionId: string, payload: AgentStreamPayload) => void` |
| 中间件链 | `agent-event-bus.ts` | `:7-9` | `emit → middleware → handler dispatch` |

### 长期记忆

| 证据 | 文件 | 行号 | 说明 |
|------|------|------|------|
| 记忆配置 | `memory-service.ts` | `:22-42` | `getMemoryConfig()`: 读写 `~/.proma/memory.json` |
| 记忆工具注入 | `agent-orchestrator.ts` | `:683-727` | `injectMemoryTools()`: 注册 `recall_memory` / `add_memory` MCP 工具 |

### 工作量估算方法

所有工时数字采用**专家类比法**（analogy-based estimation），参考依据：
- 每个改动文件已通过源码阅读确认了实际代码量和改动范围
- `agent-prompt-builder.ts` ≈300 行，改动限于 `buildSystemPrompt()` 函数（~50 行）→ 1h
- `agent-orchestrator.ts` ≈2300 行，路由层改动限于 `runAgent()` 入口附近（~30 行）→ 2h
- 新增文件按功能点估：`role-prompts.ts`（纯文本常量）→ 2h
- 前端改动为状态栏文本更新（已有类似组件可参考）→ 1h
- 风险等级基于改动涉及的模块数量、是否跨进程（主进程 vs 渲染进程）和是否有现成模式可参考

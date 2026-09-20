# 数据模型设计

> 项目：向导Agent与编程Agent多智能体协同开发平台
> 文档ID：DOC-3.4 | 版本：v0.6 | 日期：2026-07-04 | 状态：终审收敛（v0.6 补丁：A 层 v0.2 补审 ISSUE-003 #1/#3）
> **v0.6 变更（2026-07-04）**：§1.3 快照物理路径修正（`_system/snapshots/`→`snapshots/`，与 §1.2 布局一致）；§4 补第 14 事件 `architecture.confirmed`（架构阶段确认）；§4.2/§9 事件计数 13→14。详见各节修正注。
> 依赖：03_ARCHITECTURE/architecture.md（v0.3，终审收敛）
> 审计：四维(A/B/C/D)→修正(4严重+9建议)→回归→终审(A/B+C/D, 2阻塞+3严重+1轻微)→修正(3严重)→终审(A/B+C/D, 3严重修复)→收敛
> 注：本文件所有 Proma 源码行号引用基于探索报告（exploration/）的二次查阅，非直接源码验证。详见各章节引用标注。

---

## 1. 设计原则与物理存储

### 1.1 原则

本平台数据模型遵循 `architecture.md §1.2` 的**零依赖原则**：

- **存储介质**：文件系统，不使用数据库
- **行格式**：JSONL（埋点事件） + JSON 索引文件（项目列表、快照清单、会话上下文、文档清单）
- **快照**：`fs.linkSync` 硬链接复制项目目录树

### 1.2 物理存储布局

> **路径根目录约定**：`workspace-files/` 为 `~/.proma/agent-workspaces/{slug}/workspace-files/` 的缩写——Proma 的 `getWorkspaceFilesDir(slug)` 函数（`config-paths.ts` L325-333）返回该路径。本文档所有路径均以此为根，省略前缀以保持可读性。[证据：exploration/task-pkg-a1-proma-source/a1.4-file-system.md §文件系统]
>
> **目录命名约定**：项目目录采用 `{projectId}-{shortName}/` 格式。`{projectId}` 为UUID v4截取前8位，确保跨项目唯一性；`{shortName}` 为ASCII-safe短名，兼容各操作系统文件系统路径编码。此方案是对 `architecture.md` 中 human-readable 命名约定（如 `project-读书笔记管理/`）的工程实现细化。[证据：exploration/task-pkg-a1-proma-source/a1.4-file-system.md §文件系统——Proma 本身使用 slug（ASCII-safe）作为工作区目录名，本方案遵循相同惯例]

```
workspace-files/
├── _system/                           # 平台级元数据（不属于任何用户项目）
│   ├── projects-index.json            # 项目列表索引
│   ├── sessions/                      # 会话上下文
│   │   └── {projectId}.json           # 每项目一个会话状态文件
│   └── telemetry/                     # 埋点日志
│       └── events-{YYYY-MM}.jsonl     # 按月分片，每行一个JSON事件
│
├── {projectId}-{shortName}/           # 各用户项目目录
│   ├── _system/                        # 项目级系统文件（不在7目录中）
│   │   └── conversation.jsonl          #   全量对话记录
│   ├── 01_PRD/
│   ├── 02_UX_DESIGN/
│   ├── 03_ARCHITECTURE/
│   ├── 04_API_SPEC/
│   ├── 05_PROJECT_PLAN/
│   ├── 06_TESTS/
│   ├── 07_VERSIONS/
│   ├── _code/                         # 编程Agent生成的代码
│   └── _meta.json                     # 项目元数据 + 快照索引 + 文档清单
│
└── snapshots/                         # 快照物理存储
    └── {projectId}/
        └── snap-{timestamp}-{snapshotId}/    # 硬链接复制的项目快照
            └── ...（完整项目目录树）
```

### 1.3 存储方案对照

> **证据来源**：Proma 已使用 JSONL 存储 SDK 会话消息（`agent-sessions/{id}.jsonl`），JSON 索引文件存储对话/会话/工作区列表（`conversations.json`/`agent-sessions.json`/`agent-workspaces.json`）。本方案复用这些现有模式。[证据：exploration/task-pkg-a3-tech-feasibility/a3.4-telemetry.md L18、exploration/task-pkg-a1-proma-source/a1.4-file-system.md §文件系统]

| 数据实体 | 物理文件 | 格式 | 理由 |
|---------|---------|------|------|
| Project | `_system/projects-index.json` + `_meta.json` | JSON索引 | 项目列表快速检索 |
| 快照 | `snapshots/{projectId}/` + `_meta.json#snapshots` | JSON内嵌 | 元数据需频繁更新(标记isCurrent)和原子追加，JSONL append-only不适用。[快照实现细节：`fs.linkSync` 硬链接 + 两阶段提交，见 exploration/task-pkg-a3-tech-feasibility/a3.3-snapshot-rollback.md。本模型将快照元数据置于 `_meta.json`（而非 A3.3 的独立 `.proma/snapshots/index.json`），原因：用户项目目录不应包含 `.proma` 系统隐藏目录——该目录属于 Proma 平台自身。快照元数据与项目元数据同生命周期的聚合设计更符合"用户项目即完整数据包"的理念]
| TelemetryEvent | `_system/telemetry/events-{YYYY-MM}.jsonl` | JSONL追加 | 高吞吐顺序写入 |
| SessionContext | `_system/sessions/{projectId}.json` | JSON单文件 | 单项目单会话，原子读写 |
| DocumentMeta | `_meta.json#documents` | JSON内嵌 | 与项目级元数据同生命周期 |

> **注**：`architecture.md §1.2` 原始描述为"JSONL(埋点/快照元数据)"，本模型将快照元数据调整为JSON格式——元数据需要频繁更新(标记isCurrent)和原子追加新条目，JSONL的append-only特性不适用。埋点事件仍保持JSONL append-only。此调整为对架构文档的工程实现细化，非原则性偏离。

> **2026-07-04 修正（A 层 v0.2 补审 ISSUE-003 #1）**：快照物理路径原表作 `_system/snapshots/{projectId}/`，与 §1.2 物理存储布局图（`workspace-files/snapshots/`，与 `_system/` 平级）及 §3.2 filePath（`snapshots/{projectId}/...`）冲突；以 §1.2 为准，修正为 `snapshots/{projectId}/`（即 `workspace-files/snapshots/{projectId}/`）。

---

## 2. 实体一：项目元数据（Project）

### 2.1 字段表

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| projectId | string(UUID v4) | ✅ | 自动生成 | 项目唯一标识，创建时分配 |
| name | string(≤100) | ✅ | — | 用户可见的项目名称 |
| shortName | string(≤30) | ❌ | — | 用于生成目录名的短名，ASCII安全。创建时由系统从name自动截取生成，故无静态默认值 |
| mode | enum | ✅ | — | `quick`（快消型）\| `iterative`（长期迭代型） |
| template | enum | ✅ | — | 工程模板，由向导Agent从用户描述推断，创建时动态填充，故无静态默认值 |
| status | enum | ✅ | `active` | `active`（进行中）\| `completed`（已完成）\| `abandoned`（已放弃） |
| currentStage | enum | ✅ | `mode-select` | `mode-select` \| `requirements` \| `prototype` \| `architecture` \| `planning` \| `coding` \| `testing` \| `delivered` |
| createdAt | ISO8601 timestamp | ✅ | 当前时间 | 项目创建时间 |
| updatedAt | ISO8601 timestamp | ✅ | 当前时间 | 最后活动时间（每次对话自动更新） |
| completedAt | ISO8601 timestamp | ❌ | null | 项目完成时间（status=completed时写入） |
| totalTokenUsed | number | ❌ | 0 | 累计Token消耗（各阶段汇总） |
| directoryPath | string(绝对路径) | ✅ | 自动生成 | `workspace-files/{projectId}-{shortName}/` |

### 2.2 枚举约束

**mode**：`quick` | `iterative`
**template**：`web-fullstack` | `mobile-app` | `desktop-tool` | `cli-script` | `hardware` | `ai-app`
**status**：`active` | `completed` | `abandoned`
**currentStage**：`mode-select` | `requirements` | `prototype` | `architecture` | `planning` | `coding` | `testing` | `delivered`

**stage 状态转移规则**：
- `mode-select` → `requirements`（用户选择模式后）
- `requirements` → `prototype`（PRD确认后）
- `prototype` → `architecture`（原型确认后）
- `architecture` → `planning`（架构确认后，长期迭代型）\| `coding`（架构确认后，快消型跳过planning）
- `planning` → `coding`（Sprint规划确认后）
- `coding` → `testing`（代码生成完成后）
- `testing` → `delivered`（裁判Agent判定通过）\| `coding`（测试未通过，回退修复）
- 任意阶段 → `abandoned`（用户放弃项目）

### 2.3 JSON 示例

```json
{
  "projectId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "name": "我的读书笔记管理网站",
  "shortName": "reading-notes",
  "mode": "quick",
  "template": "web-fullstack",
  "status": "active",
  "currentStage": "coding",
  "createdAt": "2026-06-06T10:30:00.000+08:00",
  "updatedAt": "2026-06-06T11:45:00.000+08:00",
  "completedAt": null,
  "totalTokenUsed": 28450,
  "directoryPath": "/Users/xingxing/Proma/workspace-files/a1b2c3d4-...-reading-notes/"
}
```

---

## 3. 实体二：快照（Snapshot）

### 3.1 设计约束

- **线性回滚**，不支持分支
- 快照由系统**自动触发**，用户**不可手动创建**
- 不存储 parentSnapshotId——线性列表的时间顺序即为版本顺序

### 3.2 字段表

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| snapshotId | number(自增) | ✅ | 自动生成 | 项目内唯一序号，从1开始 |
| projectId | string(UUID) | ✅ | — | 所属项目ID（外键 → Project.projectId） |
| timestamp | ISO8601 timestamp | ✅ | 当前时间 | 快照创建时间 |
| description | string(≤200) | ✅ | — | 自然语言描述，如"确认原型后"、"代码生成前" |
| triggerType | enum | ✅ | — | `init`（初版生成）\| `pre-modify`（用户确认修改前）\| `confirm`（用户确认修改后）\| `mode-switch`（模式转换）\| `pre-error`（异常回滚前） |
| filePath | string(绝对路径) | ✅ | 自动生成 | 快照物理路径：`snapshots/{projectId}/snap-{timestamp}-{snapshotId}/` |
| isCurrent | boolean | ❌ | false | 是否为当前活跃快照（同一时间只有一个为true） |
| isHealthy | boolean | ❌ | true | 快照是否健康（回滚后保留的快照为true） |

### 3.3 触发时机（与PRD §7.4一致）

| triggerType | 触发时机 |
|------------|---------|
| `init` | 初版代码生成成功后 |
| `pre-modify` | 用户发起修改操作前（保留"改前"安全点） |
| `confirm` | 用户确认PRD、确认原型、确认修改后 |
| `mode-switch` | 快消型升级为长期迭代型 |
| `pre-error` | 编程Agent开始执行前（异常回滚目标） |

### 3.4 JSON 示例

```json
{
  "snapshotId": 3,
  "projectId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "timestamp": "2026-06-06T11:20:00.000+08:00",
  "description": "确认原型后",
  "triggerType": "confirm",
  "filePath": "/Users/.../snapshots/a1b2c3d4-.../snap-20260606T112000-3/",
  "isCurrent": true,
  "isHealthy": true
}
```

### 3.5 回滚行为

1. 回滚前：将当前 isCurrent=true 的快照标记为 isCurrent=false
2. 执行回滚：将目标快照的目录树覆盖当前项目目录
3. 回滚后：目标快照标记为 isCurrent=true
4. 被回滚的快照**不被删除**，在快照列表中保留，用户可随时切回
5. 回滚后的时间轴继续线性前进（新快照追加到列表末尾，不形成分支）

---

## 4. 实体三：埋点事件（TelemetryEvent）

### 4.1 设计约束

- **全量采集**，异步非阻塞写入
- 按月分片（`events-{YYYY-MM}.jsonl`），避免单文件过大
- 科研数据脱敏后长期保存，原始项目数据保留30天

### 4.2 字段表

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| eventId | string(UUID v4) | ✅ | 自动生成 | 事件唯一标识 |
| sessionId | string(UUID) | ✅ | — | 用户会话ID（应用启动时创建） |
| projectId | string(UUID) | ❌ | null | 关联项目ID（外键 → Project.projectId），全局事件可为null |
| userId | string(hash) | ✅ | — | 脱敏后的用户标识（hash(username+deviceId)） |
| eventType | enum(14种) | ✅ | — | 事件类型 |
| timestamp | ISO8601 timestamp | ✅ | 当前时间 | 事件发生时间（客户端时钟） |
| stage | enum | ❌ | null | 事件发生时所在阶段（Project.currentStage对应值） |
| mode | enum | ❌ | null | 事件发生时的项目模式，复用 Project.mode 枚举值：`quick` \| `iterative` | |
| duration | number(ms) | ❌ | null | 事件耗时（适用时） |
| payload | JSON object | ✅ | {} | 事件特定数据（结构随eventType变化） |

### 4.3 eventType 枚举（与PRD §12.4一致）

| # | eventType | 说明 | payload 关键字段 |
|---|-----------|------|-----------------|
| 1 | `project.created` | 项目创建 | `{projectId, mode, template}` |
| 2 | `dialog.submitted` | 每轮对话提交 | `{projectId, roundNumber, inputLength, containsImage}` |
| 3 | `role.switched` | 向导Agent角色切换 | `{projectId, fromRole, toRole, triggerReason}` |
| 4 | `prd.confirmed` | PRD确认 | `{projectId, rounds, duration, featureCount}` |
| 5 | `prototype.confirmed` | 原型预览确认 | `{projectId, previewCount, editCount, duration}` |
| 6 | `user.undo` | 用户主动撤销 | `{projectId, stage, undoTarget, undoCount}` — `undoTarget` 为撤销对象（如"原型颜色修改"/"PRD功能项删除"） |
| 7 | `click.fix` | 点选纠错 | `{projectId, targetType, success}` |
| 8 | `mode.switch` | 模式转换（快消→长期） | `{projectId, reason, currentStage}` |
| 9 | `coding.executed` | 编程Agent执行 | `{projectId, taskType, tokensUsed, success}` |
| 10 | `autofix.triggered` | 自修复触发 | `{projectId, attemptNumber, result}` |
| 11 | `judge.verdict` | 裁判Agent判定 | `{projectId, passed, violationTypes, duration}` |
| 12 | `user.satisfaction` | 用户满意度标记 | `{projectId, explicit}` |
| 13 | `project.finished` | 项目完成/放弃 | `{projectId, finalStatus, totalDuration, totalTokens}` |
| 14 | `architecture.confirmed` | 架构阶段确认（架构产出后用户确认，类比 `prd.confirmed`/`prototype.confirmed`，对应 §2.2 stage 转移 `prototype→architecture` 后的确认点） | `{projectId, rounds, duration, moduleCount}` |

### 4.4 JSONL 示例（单行）

```jsonl
{"eventId":"evt-001","sessionId":"sess-abc","projectId":"a1b2c3d4-...","userId":"hash_5f8a9b","eventType":"prd.confirmed","timestamp":"2026-06-06T10:45:00.000+08:00","stage":"requirements","mode":"quick","duration":360000,"payload":{"rounds":6,"duration":360000,"featureCount":5}}
{"eventId":"evt-002","sessionId":"sess-abc","projectId":"a1b2c3d4-...","userId":"hash_5f8a9b","eventType":"role.switched","timestamp":"2026-06-06T10:46:00.000+08:00","stage":"prototype","mode":"quick","duration":null,"payload":{"fromRole":"requirement-analyst","toRole":"ux-advisor","triggerReason":"prd-confirmed"}}
{"eventId":"evt-003","sessionId":"sess-abc","projectId":null,"userId":"hash_5f8a9b","eventType":"project.created","timestamp":"2026-06-06T10:30:00.000+08:00","stage":null,"mode":"quick","duration":null,"payload":{"mode":"quick","template":"web-fullstack"}}
```

### 4.5 数据保留（与PRD §12.2一致）

| 数据类型 | 保留策略 | 说明 |
|---------|---------|------|
| 原始项目数据 | 30天或用户手动删除 | `workspace-files/{projectId}-{shortName}/` 和对应快照 |
| 脱敏科研数据 | 长期保存 | 埋点JSONL中userId已脱敏，payload不含用户真实个人信息 |
| 用户删除触发 | 立即清除原始数据 | 脱敏科研数据不在清除范围 |

---

## 5. 实体四：Agent会话上下文（SessionContext）

### 5.1 设计约束

- 单项目单会话文件（`_system/sessions/{projectId}.json`）
- 支持 Session Restart + Context Backfill（每阶段结束时序列化，新角色会话加载时注入）

### 5.2 字段表

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| projectId | string(UUID) | ✅ | — | 关联项目ID（外键 → Project.projectId，唯一） |
| currentStage | enum | ✅ | — | 当前阶段，与 Project.currentStage 使用相同枚举值（`mode-select` \| `requirements` \| `prototype` \| `architecture` \| `planning` \| `coding` \| `testing` \| `delivered`） |
| currentRole | enum | ✅ | — | 当前激活角色：`requirement-analyst` \| `ux-advisor` \| `architect` \| `engineering-manager` |
| conversationSummary | string(≤2000字) | ✅ | — | 对话摘要：用户需求要点、已确认决策、待办事项 |
| confirmedDecisions | array of string | ✅ | [] | 已确认的决策列表（含关键约束），每条≤100字。关键约束（技术选型、性能要求、安全限制等）与功能决策统一存储于此，通过前缀区分（如 `[约束]` 标记），便于 Backfill 注入时结构化提取 |
| openQuestions | array of string | ❌ | [] | 尚未解决的待讨论问题 |
| lastCheckpointSnapshotId | number | ❌ | null | 上次恢复时的快照ID（用于Session Backfill定位） |
| conversationHistoryPath | string(绝对路径) | ✅ | — | 完整对话记录的JSONL文件路径 |
| backfillVersion | number | ✅ | 1 | Backfill版本号，每次角色切换时递增 |
| updatedAt | ISO8601 timestamp | ✅ | 当前时间 | 最后更新时间 |

### 5.3 枚举约束

**currentRole**：`requirement-analyst` | `ux-advisor` | `architect` | `engineering-manager`

### 5.4 Session Restart + Context Backfill 流程

> **证据来源**：B2 会话上下文报告（exploration/task-pkg-b2-session-context/session-context-report.md）验证了核心可行性——`buildSystemPrompt` 可扩展以注入上下文，阶段状态机可管理角色切换。**已知风险**：(1) SDK 跨模型 resume 需要实测验证（B2 标注），(2) Proma 的 `SystemPromptContext` 当前不支持 phase 字段，需要修改（B2 标注）。Phase 1 可通过"新建独立会话 + 注入摘要文本"的简化方案绕过这两个风险。

```
阶段完成（如PRD确认）
    │
    ▼
1. 序列化当前上下文
   - 更新 conversationSummary
   - 追加 confirmedDecisions
   - 保存至 sessions/{projectId}.json
    │
    ▼
2. 创建新会话
   - 加载目标角色的 System Prompt（如 ux-advisor）
   - 加载目标角色的模型配置（如 MiniMax 2.7）
    │
    ▼
3. Context Backfill
   - 读取 sessions/{projectId}.json
   - 注入 conversationSummary + confirmedDecisions
   - 注入上阶段对话摘要
   - backfillVersion++
    │
    ▼
4. 用户感知
   - 同一个聊天界面，对话风格自然过渡
   - 新角色能看到之前的讨论摘要
```

### 5.5 JSON 示例

```json
{
  "projectId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "currentStage": "prototype",
  "currentRole": "ux-advisor",
  "conversationSummary": "用户想做读书笔记管理网站。核心功能：①添加笔记（书名+内容+分类）②按分类筛选③搜索笔记。明确不做：用户登录、社交分享、云端同步。用户偏好简洁风格，白色背景。",
  "confirmedDecisions": [
    "功能范围：添加笔记、分类筛选、搜索",
    "不做登录和社交功能",
    "使用白色简洁风格",
    "数据存在本地，不需要联网"
  ],
  "openQuestions": [],
  "lastCheckpointSnapshotId": 1,
  "conversationHistoryPath": "/Users/.../workspace-files/a1b2c3d4-...-reading-notes/_system/conversation.jsonl",
  "backfillVersion": 2,
  "updatedAt": "2026-06-06T10:46:00.000+08:00"
}
```

---

## 6. 实体五：文档目录元数据（DocumentMeta）

### 6.1 设计约束

- 嵌套在项目 `_meta.json` 中，与项目元数据同生命周期
- 裁判Agent硬约束检查时读取此清单，快速定位所有文档
- 文档路径均为项目目录下的相对路径

### 6.2 字段表

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| docId | string | ✅ | 自动生成 | 文档唯一标识，如 `DOC-1.1` |
| projectId | string(UUID) | ✅ | — | 关联项目ID（外键 → Project.projectId） |
| relativePath | string(相对路径) | ✅ | — | 相对项目根目录的文档路径，如 `01_PRD/prd.md` |
| directory | enum | ✅ | — | 所属目录：`01_PRD` \| `02_UX_DESIGN` \| `03_ARCHITECTURE` \| `04_API_SPEC` \| `05_PROJECT_PLAN` \| `06_TESTS` \| `07_VERSIONS` \| `ROOT`（根目录文件如README.md） |
| docType | enum | ✅ | — | 文档类型：`prd` \| `user-stories` \| `sitemap` \| `user-flows` \| `wireframe` \| `design-system` \| `interaction-spec` \| `architecture` \| `class-diagram` \| `sequence-diagram` \| `data-model` \| `api-spec` \| `sprint-plan` \| `team-config` \| `workflow` \| `test-plan` \| `feature` \| `step-definition` \| `changelog` \| `readme` \| `other` |
| version | string(semver) | ✅ | "0.1" | 文档版本号 |
| status | enum | ✅ | `draft` | `draft`（草稿）\| `review`（待审）\| `confirmed`（已确认） |
| fileFormat | enum | ✅ | — | `md` \| `puml` \| `html` \| `feature` \| `json` \| `yaml` |
| lastModified | ISO8601 timestamp | ✅ | 当前时间 | 最后修改时间 |

### 6.3 7目录标准清单（长期迭代型）

| 目录 | 必含文件 | 快消型差异 |
|------|---------|-----------|
| `01_PRD` | `prd.md`, `user-stories.md` | 仅 `prd.md`，无 `user-stories.md` |
| `02_UX_DESIGN` | `sitemap.md`, `user-flows.md`, `wireframes/*.html`, `design-system.md`, `interaction-spec.md` | 仅 `wireframes/*.html`（核心页面） |
| `03_ARCHITECTURE` | `architecture.md`, `class-diagram.puml`, `sequence-diagrams/*.puml`, `data-model.md` | 仅 `architecture.md`（简版）；PlantUML可省略 |
| `04_API_SPEC` | `api-spec.md` | `api-spec.md`（自动推断） |
| `05_PROJECT_PLAN` | `sprint-plan.md`, `team-config.md`, `workflow.md` | 无此目录 |
| `06_TESTS` | `test-plan.md`, `features/*.feature`, `step-definitions/` | `test-plan.md`, `features/*.feature` |
| `07_VERSIONS` | `changelog.md` | 无此目录 |
| 根目录 | `README.md` | `README.md` |

### 6.4 JSON 示例

```json
{
  "docId": "DOC-1.1",
  "projectId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "relativePath": "01_PRD/prd.md",
  "directory": "01_PRD",
  "docType": "prd",
  "version": "0.2",
  "status": "confirmed",
  "fileFormat": "md",
  "lastModified": "2026-06-06T10:45:00.000+08:00"
}
```

---

## 7. 实体关系图（ER）

```mermaid
erDiagram
    Project ||--o{ Snapshot : "1→N，线性追加"
    Project ||--|| SessionContext : "1→1，单会话文件"
    Project ||--o{ DocumentMeta : "1→N，嵌套在_meta.json"
    Project ||--o{ TelemetryEvent : "1→N，外键可空"

    Project {
        string projectId PK
        string name
        string shortName
        enum mode
        enum template
        enum status
        enum currentStage
        timestamp createdAt
        timestamp updatedAt
        timestamp completedAt
        number totalTokenUsed
        string directoryPath
    }

    Snapshot {
        number snapshotId PK
        string projectId FK
        timestamp timestamp
        string description
        enum triggerType
        string filePath
        boolean isCurrent
        boolean isHealthy
    }

    SessionContext {
        string projectId PK_FK
        enum currentStage
        enum currentRole
        string conversationSummary
        array confirmedDecisions
        array openQuestions
        number lastCheckpointSnapshotId FK
        string conversationHistoryPath
        number backfillVersion
        timestamp updatedAt
    }

    DocumentMeta {
        string docId PK
        string projectId FK
        string relativePath
        enum directory
        enum docType
        string version
        enum status
        enum fileFormat
        timestamp lastModified
    }

    TelemetryEvent {
        string eventId PK
        string sessionId
        string projectId FK_nullable
        string userId
        enum eventType
        timestamp timestamp
        enum stage
        enum mode
        number duration
        json payload
    }
```

### 基数明细

| 关系 | 基数 | 说明 |
|------|------|------|
| Project → Snapshot | 1 : 0..N | 一个项目有零或多个快照（新建项目无快照） |
| Project → SessionContext | 1 : 1 | 一个项目恰好有一个会话上下文文件 |
| Project → DocumentMeta | 1 : 0..N | 一个项目有零或多个文档（新建项目无文档） |
| Project → TelemetryEvent | 1 : 0..N | 一个项目关联零或多个事件（projectId可为null表示全局事件） |
| SessionContext → Snapshot | 1 : 0..1 | lastCheckpointSnapshotId 可为null（项目尚未创建快照时） |

---

## 8. _meta.json 完整结构

每个项目目录下的 `_meta.json` 文件是 Project + Snapshot[] + DocumentMeta[] 的聚合存储。

> **证据来源**：Proma 使用 `safe-file.ts` 实现崩溃安全的 JSON 原子写入，本聚合文件复用该机制。JSON 聚合索引模式在 Proma 中已有先例——`conversations.json` 包含全部对话元数据、`agent-workspaces.json` 包含全部工作区索引。[证据：exploration/task-pkg-a1-proma-source/a1.4-file-system.md §核心文件清单、exploration/task-pkg-a3-tech-feasibility/a3.4-telemetry.md L15-18]

```json
{
  "project": {
    "projectId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "name": "我的读书笔记管理网站",
    "shortName": "reading-notes",
    "mode": "quick",
    "template": "web-fullstack",
    "status": "active",
    "currentStage": "coding",
    "createdAt": "2026-06-06T10:30:00.000+08:00",
    "updatedAt": "2026-06-06T11:45:00.000+08:00",
    "completedAt": null,
    "totalTokenUsed": 28450,
    "directoryPath": "/Users/xingxing/Proma/workspace-files/a1b2c3d4-...-reading-notes/"
  },
  "snapshots": [
    {
      "snapshotId": 1,
      "projectId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "timestamp": "2026-06-06T10:35:00.000+08:00",
      "description": "初版代码生成后",
      "triggerType": "init",
      "filePath": "/Users/.../snapshots/a1b2c3d4-.../snap-20260606T103500-1/",
      "isCurrent": false,
      "isHealthy": true
    }
  ],
  "documents": [
    {
      "docId": "DOC-1.1",
      "projectId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "relativePath": "01_PRD/prd.md",
      "directory": "01_PRD",
      "docType": "prd",
      "version": "0.2",
      "status": "confirmed",
      "fileFormat": "md",
      "lastModified": "2026-06-06T10:45:00.000+08:00"
    }
  ]
}
```

---

## 9. 数据完整性约束

| 约束 | 规则 | 执行机制 |
|------|------|---------|
| 快照线性 | snapshotId 递增，同一projectId下无重复 | 写入时检查 `_meta.json#snapshots` 最大snapshotId |
| 阶段转移合法 | currentStage 只能按 §2.2 状态转移图迁移 | 写入前校验 |
| 单活跃快照 | 同一projectId最多一个 snapshot.isCurrent=true | 写入前将已有isCurrent标记为false |
| 14事件类型完整 | TelemetryEvent.eventType 必须在 §4.3 枚举值内 | 采集层写入前校验 |
| 文档7目录约束 | DocumentMeta.directory 必须在 §6.3 枚举值内 | 文档生成时校验 |

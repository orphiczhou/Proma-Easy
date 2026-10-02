# 数据模型接口文档（Data Model API）

> 项目：向导Agent与编程Agent多智能体协同开发平台
> 文档ID：DOC-4.3 | 版本：v0.1 | 日期：2026-07-15 | 状态：worker 草稿（待 commander 审核 + audit_gate）
> 依赖：[[03_ARCHITECTURE/data-model.md]] v0.6（**权威源**，本文档所有字段定义逐项对齐）、[[04_API_SPEC/api-spec.md]] v0.4（接口消费方契约，本文档为其提供数据结构 TS 类型；§2.4 引用其 §7 项目管理接口族）、[[03_ARCHITECTURE/architecture.md]] v0.3（§1.2 零依赖、§2 模块输入/输出、§5.2 阶段状态机、§7 点选纠错、§8 模型-角色映射）
> 一致性声明：本文档所有字段名、字段类型、枚举值、字段约束均严格对齐 [[03_ARCHITECTURE/data-model.md]] v0.6 §2~§6 的权威定义；当 data-model.md v0.6 内部出现不一致时（如 §1.2 vs §1.3 快照路径，v0.6 已标注修正），本文档以 §1.2 物理布局图为准，并以 `*APISPEC-SUPPLEMENT*` 标记。TypeScript 类型导出为本文档原创（data-model.md 仅给表格示意），便于前端/Service 层/SDK 直接复用。

---

## 0. 文档定位与读者

### 0.1 为什么需要本文档

[[03_ARCHITECTURE/data-model.md]] v0.6 是设计权威源，但其表述偏概念（字段表 + 文字说明），缺乏：

1. **可直接复用的 TypeScript 类型导出**——前端 UI 层、Service 层（services/*.ts）、SDK 均需 `interface` 定义而非表格
2. **面向接口消费方的字段约束速查表**——api-spec.md 的端点 schema 散落引用 data-model 字段，缺一张集中对照表
3. **8 阶段状态机的转换图与非法转换错误码映射**——data-model.md §2.2 仅文字列举合法转换
4. **14 事件 payload 的逐事件 TypeScript interface**——data-model.md §4.3 仅给关键字段摘要
5. **枚举值总表**——stage(8)/triggerType(5)/role(4)/template(6)/directory(8)/status(3) 散布于各章节

本文档为接口消费方（前端、编程Agent引擎、裁判引擎、快照管理器、埋点采集层、分析看板）提供上述 5 项缺失内容，**不重新定义任何字段**，所有定义以 data-model.md v0.6 为准。

### 0.2 范围边界

| 内容 | 在本文档范围 | 不在本文档范围（归属） |
|------|------------|----------------------|
| 5 实体字段表 + TS 类型 | ✅ §1~§6 | — |
| 8 阶段状态机转换图 + 非法错误码 | ✅ §7 | 事件触发时机（worker D）|
| 14 事件 payload TS schema | ✅ §8 | 事件触发时机与业务场景（worker D）|
| 枚举值总表 | ✅ §9 | — |
| 字段约束总表（必填/格式/范围/默认值） | ✅ §10 | — |
| 物理存储布局 | ❌ | data-model.md §1.2 |
| Agent 间调用顺序 | ❌ | worker A |
| 前端 IPC 通道 | ❌ | worker B + api-spec.md §2~§6 |

### 0.3 术语约定

- **必填（✅）**：写入时必须提供，缺则触发 `*_SCHEMA_VIOLATION` 类错误（错误码详见 [[04_API_SPEC/api-spec.md]] §7）
- **可选（❌）**：写入时可省略，省略时取「默认值」列的值
- **条件必填（⚠️）**：在特定条件下必填，条件在「说明」列标注
- **TS 类型导出**：所有 interface 命名采用 `PascalCase`，字段采用 `camelCase`（与 [[04_API_SPEC/api-spec.md]] §0.2 ApiResponse 保持一致）
- **枚举字面量**：所有枚举值采用 `kebab-case`（如 `mode-select`、`pre-modify`），与 data-model.md v0.6 §2.2、§3.2、§5.3、§6.2 一致

---

## 1. 实体总览

平台共 5 个核心数据实体，物理存储与生命周期详见 [[03_ARCHITECTURE/data-model.md]] §1.2、§1.3。本文档聚焦字段层面。

| # | 实体 | TypeScript 类型 | 物理载体 | 关系基数（→ Project）| 本文档章节 |
|---|------|----------------|---------|--------------------|-----------|
| 1 | Project（项目元数据）| `Project` | `_system/projects-index.json` + `_meta.json#project` | 自身 | §2 |
| 2 | Snapshot（快照）| `Snapshot` | `_meta.json#snapshots[]` + `snapshots/{projectId}/` | 1 : 0..N | §3 |
| 3 | TelemetryEvent（埋点事件）| `TelemetryEvent` | `_system/telemetry/events-{YYYY-MM}.jsonl` | 1 : 0..N（projectId 可空）| §4 |
| 4 | SessionContext（Agent 会话上下文）| `SessionContext` | `_system/sessions/{projectId}.json` | 1 : 1 | §5 |
| 5 | DocumentMeta（文档目录元数据）| `DocumentMeta` | `_meta.json#documents[]` | 1 : 0..N | §6 |

**TypeScript 总导出**（详细定义见各章节）：

```typescript
export type Mode = 'quick' | 'iterative';
export type Template = 'web-fullstack' | 'mobile-app' | 'desktop-tool' | 'cli-script' | 'hardware' | 'ai-app';
export type ProjectStatus = 'active' | 'completed' | 'abandoned';
export type Stage = 'mode-select' | 'requirements' | 'prototype' | 'architecture' | 'planning' | 'coding' | 'testing' | 'delivered';
export type TriggerType = 'init' | 'pre-modify' | 'confirm' | 'mode-switch' | 'pre-error';
export type Role = 'requirement-analyst' | 'ux-advisor' | 'architect' | 'engineering-manager';
export type DirectoryName = '01_PRD' | '02_UX_DESIGN' | '03_ARCHITECTURE' | '04_API_SPEC' | '05_PROJECT_PLAN' | '06_TESTS' | '07_VERSIONS' | 'ROOT';
export type DocStatus = 'draft' | 'review' | 'confirmed';
export type EventType =
  | 'project.created' | 'dialog.submitted' | 'role.switched' | 'prd.confirmed'
  | 'prototype.confirmed' | 'user.undo' | 'click.fix' | 'mode.switch'
  | 'coding.executed' | 'autofix.triggered' | 'judge.verdict' | 'user.satisfaction'
  | 'project.finished' | 'architecture.confirmed';

export interface Project { /* 见 §2.2 */ }
export interface Snapshot { /* 见 §3.2 */ }
export interface TelemetryEvent { /* 见 §4.2 */ }
export interface SessionContext { /* 见 §5.2 */ }
export interface DocumentMeta { /* 见 §6.2 */ }
```

---

## 2. 实体一：Project（项目元数据）

> 权威源：[[03_ARCHITECTURE/data-model.md#2-实体一项目元数据project]] v0.6 §2.1/§2.2

### 2.1 字段表

| 字段 | TypeScript 类型 | 必填 | 默认值 | 约束 / 说明 |
|------|----------------|------|--------|------------|
| `projectId` | `string` (UUID v4) | ✅ | 自动生成 | 项目唯一标识，创建时分配；正则 `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `name` | `string` | ✅ | — | 用户可见项目名称，长度 1~100 |
| `shortName` | `string` | ❌ | 创建时由 `name` 自动截取 | 用于目录名的 ASCII-safe 短名，长度 1~30；正则 `^[A-Za-z0-9_-]+$` |
| `mode` | `Mode` | ✅ | — | `quick`（快消型）\| `iterative`（长期迭代型）|
| `template` | `Template` | ✅ | — | 工程模板，向导Agent 推断后动态填充 |
| `status` | `ProjectStatus` | ✅ | `'active'` | `active` \| `completed` \| `abandoned` |
| `currentStage` | `Stage` | ✅ | `'mode-select'` | 8 阶段枚举之一（§7 状态机）|
| `createdAt` | `string` (ISO8601) | ✅ | 当前时间 | 创建时间戳，含时区 |
| `updatedAt` | `string` (ISO8601) | ✅ | 当前时间 | 最后活动时间，每次对话自动更新 |
| `completedAt` | `string` (ISO8601) \| `null` | ❌ | `null` | 仅 `status='completed'` 时写入；其他状态保持 `null` |
| `totalTokenUsed` | `number` | ❌ | `0` | 各阶段 Token 累计，整数 ≥ 0 |
| `directoryPath` | `string` (绝对路径) | ✅ | 自动生成 | 形如 `{workspaceFilesDir}/{projectId}-{shortName}/`（前缀由 [[03_ARCHITECTURE/data-model.md]] §1.2 约定）|

### 2.2 TypeScript 类型导出

```typescript
/**
 * 项目元数据。
 * 物理载体：_system/projects-index.json[] 项 + _meta.json#project
 * 一致性：currentStage 转移须遵循 §7 状态机；status='completed' 时 completedAt 必填。
 */
export interface Project {
  projectId: string;            // UUID v4
  name: string;                 // 1~100 chars
  shortName?: string;           // 1~30 chars, ASCII-safe；创建后由系统从 name 派生
  mode: Mode;                   // 'quick' | 'iterative'
  template: Template;           // 6 值枚举
  status: ProjectStatus;        // 默认 'active'
  currentStage: Stage;          // 默认 'mode-select'，8 阶段枚举
  createdAt: string;            // ISO8601 with timezone
  updatedAt: string;            // ISO8601，每次对话写入时更新
  completedAt: string | null;   // status='completed' 时必填
  totalTokenUsed?: number;      // 默认 0，整数 ≥ 0
  directoryPath: string;        // 绝对路径
}
```

### 2.3 字段间约束

- **`status='completed'` ⟹ `completedAt` 非空**：写入前校验，违反触发 `PROJECT_COMPLETED_AT_MISSING`（*APISPEC-SUPPLEMENT* 错误码命名空间，建议归 SYSTEM 域）
- **`status='abandoned'` ⟹ `completedAt` 可空**：放弃时间不强制记录
- **`currentStage='delivered'` ⟹ `status ∈ {'completed', 'abandoned'}`**：delivered 为最终成功态，project 完成或随后放弃
- **`shortName` 派生规则**（*APISPEC-SUPPLEMENT*）：data-model.md v0.6 §2.1 仅说明"由 name 自动截取"，未规定算法。建议实现：(1) 取 name 的 ASCII 字母数字段；(2) kebab-case；(3) 截断至 30 字符；(4) 冲突时追加 `-2`/`-3` 后缀。提请 data-model v0.7 补充说明。

### 2.4 访问路径（CRUD 契约）

> 修复 [[04_API_SPEC/data-model-api.md]] v0.1 audit 阻断项 B3（参见 `.context/audit-04-05-2026-07-15.md` §2 C2-1 / §4 R3 / 补审 §3 B3）：Project 实体有字段、事件、物理载体但悬空无访问端点。本节显式声明访问路径，使前端"历史项目列表页"、"项目打开/删除/模式切换"（关联 US-U06）有据可依。

**对外访问入口（IPC 端点族）**：Project 的所有 CRUD 操作统一经 [[04_API_SPEC/api-spec.md]] v0.4（A1 worker 增量）`project.*` 端点族暴露，本地桌面应用以前端 IPC channel 形式调用：

| 操作 | 端点 | 简述 |
|------|------|------|
| 列出全部项目 | `project.list` | 扫描 `_system/projects-index.json` 返回活跃项目摘要数组 |
| 打开/读取单项目 | `project.open` | 按 `projectId` 加载完整 `Project` 元数据 + `SessionContext` + 最近 `Snapshot` |
| 删除项目（软删除/归档） | `project.delete` | 置 `status='abandoned'` 并触发 `project.finished` 事件 |
| 模式切换 quick ↔ iterative | `project.switchMode` | 处理 `mode.switch` 事件对应的实际状态写入（更新 `Project.mode` + 阶段重排） |

> `project.*` 端点族的具体输入/输出 Schema、错误码、IPC channel 命名由 [[04_API_SPEC/api-spec.md]] v0.4 §7「类6：项目管理接口」权威定义（A1 worker 增量产出）；本文档不重复定义端点细节，仅声明 Project 实体的访问路径归属。

**后端读取契约（数据消费方视角）**：

| 用途 | 物理载体 | 读取方式 |
|------|---------|---------|
| 项目索引（列表页/打开对话框） | `_system/projects-index.json` | 启动时一次性加载到内存；`project.list` 直接返回；写入时原子替换（temp file + rename） |
| 单项目完整元数据 | `_meta.json#project`（[[03_ARCHITECTURE/data-model.md]] §1.2 物理布局） | `project.open` 时按 `directoryPath` 读 `_meta.json`，提取 `project` 节点；与索引中的摘要字段以 `_meta.json#project` 为权威源（最新） |

**并发安全**：`_meta.json` 与 `projects-index.json` 的并发写防护遵循 [[04_API_SPEC/agent-comm.md]] §2.3「跨 Agent 写冲突防护」——MVP 阶段依赖 [[03_ARCHITECTURE/architecture.md]] §5.1 的**串行切换**不变量（同一时刻只有一个 Agent 活跃），故 `project.*` 写操作无需文件锁；Phase 2 若引入并行角色（已否决方案），需补 safe-file 原子写或文件锁（参见 agent-comm.md §2.3 留白声明）。`project.switchMode` 涉及 `mode` 字段写入时，必须先写 `_meta.json#project.mode` 再刷新 `projects-index.json` 摘要，保证索引与元数据最终一致。

---

## 3. 实体二：Snapshot（快照）

> 权威源：[[03_ARCHITECTURE/data-model.md#3-实体二快照snapshot]] v0.6 §3.1/§3.2/§3.5

### 3.1 字段表

| 字段 | TypeScript 类型 | 必填 | 默认值 | 约束 / 说明 |
|------|----------------|------|--------|------------|
| `snapshotId` | `number` | ✅ | 自动生成 | 项目内自增序号，从 `1` 开始；同一 `projectId` 下唯一 |
| `projectId` | `string` (UUID v4) | ✅ | — | 外键 → `Project.projectId` |
| `timestamp` | `string` (ISO8601) | ✅ | 当前时间 | 快照创建时间 |
| `description` | `string` | ✅ | — | 自然语言描述，长度 1~200，如 `"确认原型后"` |
| `triggerType` | `TriggerType` | ✅ | — | 5 值枚举（§9.2）|
| `filePath` | `string` (绝对路径) | ✅ | 自动生成 | `snapshots/{projectId}/snap-{YYYYMMDDTHHMMSS}-{snapshotId}/` |
| `isCurrent` | `boolean` | ❌ | `false` | 同一 `projectId` 至多一个为 `true`；新建快照前置其他为 `false` |
| `isHealthy` | `boolean` | ❌ | `true` | 回滚后被覆盖的快照保持 `true`；磁盘损坏检测后置 `false` |

### 3.2 TypeScript 类型导出

```typescript
/**
 * 项目快照。线性追加，不存储 parentSnapshotId（时间序即版本序）。
 * 物理载体：_meta.json#snapshots[] + snapshots/{projectId}/snap-{ts}-{id}/ 目录树
 */
export interface Snapshot {
  snapshotId: number;          // 项目内自增，从 1 开始
  projectId: string;           // FK → Project.projectId
  timestamp: string;           // ISO8601
  description: string;         // 1~200 chars
  triggerType: TriggerType;    // 5 值枚举
  filePath: string;            // 绝对路径，硬链接复制目录
  isCurrent?: boolean;         // 默认 false，单活跃守卫
  isHealthy?: boolean;         // 默认 true
}
```

### 3.3 字段间约束

- **单活跃快照守卫**：同一 `projectId` 至多一条 `isCurrent=true`；新建时由 `snapshot.create` 端点（[[04_API_SPEC/api-spec.md]] §5.1）前置将其他快照置 `false`
- **回滚线性前进**（[[03_ARCHITECTURE/data-model.md]] §3.5）：回滚不删快照，新快照追加列表末尾，不形成分支
- **删除守卫**：`isCurrent=true` 的快照禁止删除（`SNAPSHOT_DELETE_CURRENT_FORBIDDEN`）
- **回滚目标守卫**：`isHealthy=false` 的快照禁止作为回滚目标（`SNAPSHOT_TARGET_UNHEALTHY`）

---

## 4. 实体三：TelemetryEvent（埋点事件）

> 权威源：[[03_ARCHITECTURE/data-model.md#4-实体三埋点事件telemetryevent]] v0.6 §4.2/§4.3

### 4.1 字段表

| 字段 | TypeScript 类型 | 必填 | 默认值 | 约束 / 说明 |
|------|----------------|------|--------|------------|
| `eventId` | `string` (UUID v4) | ✅ | 自动生成 | 事件唯一标识 |
| `sessionId` | `string` (UUID v4) | ✅ | — | 用户会话 ID，应用启动时创建 |
| `projectId` | `string` (UUID v4) \| `null` | ❌ | `null` | 外键 → `Project.projectId`；全局事件（如 `project.created` 创建前）可为 `null` |
| `userId` | `string` (hash) | ✅ | — | 脱敏后用户标识，`hash(username + deviceId)` |
| `eventType` | `EventType` | ✅ | — | 14 值枚举（§9.5）|
| `timestamp` | `string` (ISO8601) | ✅ | 当前时间 | 客户端时钟 |
| `stage` | `Stage` \| `null` | ❌ | `null` | 事件发生时所在阶段，复用 `Project.currentStage` 8 值枚举 |
| `mode` | `Mode` \| `null` | ❌ | `null` | 事件发生时项目模式，复用 `Project.mode` 2 值枚举 |
| `duration` | `number` (ms) \| `null` | ❌ | `null` | 事件耗时，仅适用事件填（如 `prd.confirmed`），其他为 `null` |
| `payload` | `object` | ✅ | `{}` | 事件特定数据，结构随 `eventType` 变化（§8 逐事件 schema）|

### 4.2 TypeScript 类型导出

```typescript
/**
 * 埋点事件。JSONL append-only，按月分片 events-{YYYY-MM}.jsonl。
 * 异步非阻塞写入，全量采集 14 类事件。
 */
export interface TelemetryEvent<P = unknown> {
  eventId: string;                  // UUID v4，采集层分配
  sessionId: string;                // UUID v4
  projectId: string | null;         // FK → Project.projectId，全局事件为 null
  userId: string;                   // hash(username + deviceId)
  eventType: EventType;             // 14 值枚举
  timestamp: string;                // ISO8601 client clock
  stage: Stage | null;              // 默认 null
  mode: Mode | null;                // 默认 null
  duration: number | null;          // 默认 null，单位 ms
  payload: P;                       // 强类型 payload 见 §8 各事件 interface
}

/** 公共字段（不随 eventType 变化），由 api-spec.md §0.3 上下文自动注入 */
export interface TelemetryCommonContext {
  sessionId: string;
  projectId: string | null;
  userId: string;
  stage: Stage | null;
  mode: Mode | null;
}
```

### 4.3 公共字段自动注入

调用 `telemetry.emit`（[[04_API_SPEC/api-spec.md]] §6.1）时，业务层仅需传入 `eventType` + `payload` + 可选 `timestamp`/`duration`，公共字段（`sessionId`/`projectId`/`userId`/`stage`/`mode`）由 IPC 桥接层从会话上下文自动注入，参见 [[04_API_SPEC/api-spec.md]] §0.3。

---

## 5. 实体四：SessionContext（Agent 会话上下文）

> 权威源：[[03_ARCHITECTURE/data-model.md#5-实体四agent会话上下文sessioncontext]] v0.6 §5.2/§5.3

### 5.1 字段表

| 字段 | TypeScript 类型 | 必填 | 默认值 | 约束 / 说明 |
|------|----------------|------|--------|------------|
| `projectId` | `string` (UUID v4) | ✅ | — | 外键 → `Project.projectId`，**唯一**（单项目单会话文件）|
| `currentStage` | `Stage` | ✅ | — | 与 `Project.currentStage` 同步；8 阶段枚举 |
| `currentRole` | `Role` | ✅ | — | 当前激活角色，4 值枚举（§9.4）|
| `conversationSummary` | `string` | ✅ | — | 对话摘要：用户需求要点 + 已确认决策 + 待办事项；长度 1~2000 |
| `confirmedDecisions` | `string[]` | ✅ | `[]` | 已确认决策列表，每条 ≤ 100 字；关键约束以 `[约束]` 前缀标记 |
| `openQuestions` | `string[]` | ❌ | `[]` | 尚未解决的待讨论问题 |
| `lastCheckpointSnapshotId` | `number` \| `null` | ❌ | `null` | 上次恢复时的快照 ID，用于 Context Backfill 定位 |
| `conversationHistoryPath` | `string` (绝对路径) | ✅ | — | 完整对话 JSONL 路径，形如 `{projectDir}/_system/conversation.jsonl` |
| `backfillVersion` | `number` | ✅ | `1` | Backfill 版本号，每次角色切换递增 |
| `updatedAt` | `string` (ISO8601) | ✅ | 当前时间 | 最后更新时间 |

### 5.2 TypeScript 类型导出

```typescript
/**
 * Agent 会话上下文。单项目单文件 _system/sessions/{projectId}.json。
 * 用于 Session Restart + Context Backfill（每次阶段结束序列化，新角色会话加载时注入）。
 */
export interface SessionContext {
  projectId: string;                    // FK → Project.projectId，唯一
  currentStage: Stage;                  // 与 Project.currentStage 同步
  currentRole: Role;                    // 4 值枚举
  conversationSummary: string;          // 1~2000 chars
  confirmedDecisions: string[];         // 默认 []，每项 ≤ 100 chars
  openQuestions?: string[];             // 默认 []
  lastCheckpointSnapshotId?: number | null;  // 默认 null
  conversationHistoryPath: string;      // 绝对路径
  backfillVersion: number;              // 默认 1，角色切换递增
  updatedAt: string;                    // ISO8601
}
```

### 5.3 字段间约束

- **`currentRole` 与 `currentStage` 的对应关系**（*APISPEC-SUPPLEMENT*，data-model.md v0.6 §5.3 未显式约束）：建议但不强制：
  - `requirements` 阶段 → `requirement-analyst`
  - `prototype` 阶段 → `ux-advisor`
  - `architecture` / `planning` 阶段 → `architect`
  - `coding` / `testing` / `delivered` 阶段 → `engineering-manager`
  
  实际对应由 [[03_ARCHITECTURE/architecture.md]] §8 模型-角色映射规定，本文档不重复定义；若发现实际角色映射与上述建议不符，以 architecture.md 为准。

- **`confirmedDecisions` 与 `conversationSummary` 不重复**：约束类决策（技术选型、性能要求）应进入 `confirmedDecisions` 并加 `[约束]` 前缀；摘要文本不重复存储约束。

---

## 6. 实体五：DocumentMeta（文档目录元数据）

> 权威源：[[03_ARCHITECTURE/data-model.md#6-实体五文档目录元数据documentmeta]] v0.6 §6.2/§6.3

### 6.1 字段表

| 字段 | TypeScript 类型 | 必填 | 默认值 | 约束 / 说明 |
|------|----------------|------|--------|------------|
| `docId` | `string` | ✅ | 自动生成 | 文档唯一标识，格式 `DOC-{chapter}.{seq}`（如 `DOC-1.1`、`DOC-4.2`）|
| `projectId` | `string` (UUID v4) | ✅ | — | 外键 → `Project.projectId` |
| `relativePath` | `string` (相对路径) | ✅ | — | 相对项目根目录，如 `01_PRD/prd.md`；不可为绝对路径 |
| `directory` | `DirectoryName` | ✅ | — | 8 值枚举（§9.6）|
| `docType` | `DocType` | ✅ | — | 21 值枚举（§9.7）|
| `version` | `string` (semver) | ✅ | `"0.1"` | semver 格式 `^\d+\.\d+(\.\d+)?$` |
| `status` | `DocStatus` | ✅ | `'draft'` | 3 值枚举（§9.8）|
| `fileFormat` | `FileFormat` | ✅ | — | 6 值枚举：`md` \| `puml` \| `html` \| `feature` \| `json` \| `yaml` |
| `lastModified` | `string` (ISO8601) | ✅ | 当前时间 | 最后修改时间 |

### 6.2 TypeScript 类型导出

```typescript
/**
 * 文档元数据。嵌套在 _meta.json#documents[]，与项目同生命周期。
 * 裁判 Agent 硬约束检查时读取此清单，快速定位所有文档。
 */
export interface DocumentMeta {
  docId: string;                  // 如 'DOC-4.2'，自动生成
  projectId: string;              // FK → Project.projectId
  relativePath: string;           // 相对路径，如 '01_PRD/prd.md'
  directory: DirectoryName;       // 8 值枚举
  docType: DocType;               // 21 值枚举
  version: string;                // semver，默认 '0.1'
  status: DocStatus;              // 默认 'draft'
  fileFormat: FileFormat;         // 6 值枚举
  lastModified: string;           // ISO8601
}
```

### 6.3 字段间约束

- **`directory` 与 `relativePath` 一致**：`relativePath` 的首段必须等于 `directory`（除 `ROOT` 外）；违反触发 `CODER_DOC_CONTRACT_VIOLATION`（[[04_API_SPEC/api-spec.md]] §2.1）
- **`docType` 与 `directory` 对应**（*APISPEC-SUPPLEMENT*，data-model.md v0.6 §6.3 7 目录清单隐含）：例如 `01_PRD` 目录的 `docType ∈ {'prd', 'user-stories'}`；详细映射见 [[03_ARCHITECTURE/data-model.md]] §6.3
- **`status` 流转**：`draft` → `review` → `confirmed`；judge 层硬约束校验前置 `status ≥ 'review'`，`JUDGE_DOC_STATUS_INVALID` 守 `draft` 态（[[04_API_SPEC/api-spec.md]] §4.1）

---

## 7. 8 阶段状态机

> 权威源：[[03_ARCHITECTURE/data-model.md#22-枚举约束]] v0.6 §2.2「stage 状态转移规则」+ [[04_API_SPEC/api-spec.md#34-端点-24-guideconfirm确认-prd--原型--架构]] v0.3 §3.4「confirmType ↔ stage 推进映射」

### 7.1 状态机转换图

```mermaid
stateDiagram-v2
    [*] --> mode-select: 项目创建

    mode-select --> requirements: 用户选择 mode
    requirements --> prototype: prd.confirmed\n(confirmType=prd)
    prototype --> architecture: prototype.confirmed\n(confirmType=prototype)
    architecture --> planning: architecture.confirmed\n(iterative, confirmType=architecture)
    architecture --> coding: architecture.confirmed\n(quick, 跳过 planning)
    planning --> coding: sprint-plan 确认
    coding --> testing: coder.generateCode 完成
    testing --> coding: 测试未通过回退修复
    testing --> delivered: judge.verdict passed

    mode-select --> abandoned: 用户放弃
    requirements --> abandoned: 用户放弃
    prototype --> abandoned: 用户放弃
    architecture --> abandoned: 用户放弃
    planning --> abandoned: 用户放弃
    coding --> abandoned: 用户放弃
    testing --> abandoned: 用户放弃

    delivered --> [*]: 项目完成
    abandoned --> [*]: 项目放弃
```

### 7.2 合法转换表（穷举）

> 数据源：[[03_ARCHITECTURE/data-model.md]] v0.6 §2.2 + [[04_API_SPEC/api-spec.md]] §3.4 mode 维度校验

| # | fromStage | toStage | 触发条件 | 触发埋点 | 快照 triggerType |
|---|-----------|---------|---------|---------|-----------------|
| 1 | `mode-select` | `requirements` | 用户选 mode | `project.created`（projectId 已分配后）| — |
| 2 | `requirements` | `prototype` | `confirmType=prd`（两型均同）| `prd.confirmed` | `confirm` |
| 3 | `prototype` | `architecture` | `confirmType=prototype`（两型均同）| `prototype.confirmed` | `confirm` |
| 4 | `architecture` | `planning` | `confirmType=architecture` **AND** `mode='iterative'` | `architecture.confirmed` | `confirm` |
| 5 | `architecture` | `coding` | `confirmType=architecture` **AND** `mode='quick'`（跳过 planning）| `architecture.confirmed` | `confirm` |
| 6 | `planning` | `coding` | Sprint 规划确认 | — | — |
| 7 | `coding` | `testing` | `coder.generateCode` 完成 | `coding.executed` | `init` |
| 8 | `testing` | `coding` | `judge.verdict` 未通过，回退修复 | `judge.verdict` (passed=false) | — |
| 9 | `testing` | `delivered` | `judge.verdict` passed | `judge.verdict` (passed=true) | — |
| 10 | *(任意非终态)* | `abandoned` | 用户放弃项目 | `project.finished` (finalStatus=abandoned) | — |

**说明**：
- 「任意非终态」指 `mode-select` ~ `testing` 共 7 个阶段；`delivered`/`abandoned` 为终态，不可再迁移
- `abandoned` 是 `Project.status` 的语义投影到 `currentStage`——实际实现中 `status='abandoned'` 时 `currentStage` 通常冻结在放弃前的最后阶段，详见 §7.4

### 7.3 非法转换错误码

非法 `fromStage → toStage` 转换由 `guide.confirm` 端点（[[04_API_SPEC/api-spec.md]] §3.4）守卫，统一返回 `GUIDE_INVALID_STAGE_TRANSITION`。下表穷举常见非法转换及其判定原因：

| fromStage | toStage（非法） | 判定原因 |
|-----------|----------------|---------|
| `mode-select` | `prototype` / `architecture` / `planning` / `coding` / `testing` / `delivered` | 跳过 `requirements` |
| `requirements` | `architecture` / `planning` / `coding` / `testing` / `delivered` | 跳过 `prototype` |
| `prototype` | `planning` / `coding` / `testing` / `delivered` | 跳过 `architecture` |
| `architecture` | `testing` / `delivered` | 跳过 `coding` |
| `architecture` | `planning`（当 `mode='quick'`） | quick 模式必须跳 planning 直入 coding |
| `architecture` | `coding`（当 `mode='iterative'`） | iterative 模式必须经 planning |
| `planning` | `testing` / `delivered` | 跳过 `coding` |
| `coding` | `delivered` | 跳过 `testing` |
| `testing` | `requirements` / `prototype` / `architecture` / `planning` | 回退仅允许回到 `coding`，不可跨阶段 |
| `delivered` / `abandoned` | *(任何)* | 终态不可迁移 |

**错误响应示例**：

```typescript
{
  ok: false,
  error: {
    code: 'GUIDE_INVALID_STAGE_TRANSITION',
    message: '阶段非法迁移：architecture→planning 仅 iterative 模式合法，当前 mode=quick',
    details: {
      fromStage: 'architecture',
      toStage: 'planning',
      mode: 'quick',
      legalTransitionsFromArchitecture: ['planning|iterative', 'coding|quick']
    }
  },
  requestId: 'req-uuid-v4',
  durationMs: 12
}
```

### 7.4 mode 维度校验细节

> 权威源：[[04_API_SPEC/api-spec.md]] §3.4 「mode 维度校验」注记

`architecture` 阶段确认后，`toStage` 必须根据 `Project.mode` 二选一：

```typescript
function validateArchitectureTransition(project: Project, toStage: Stage): boolean {
  if (project.currentStage !== 'architecture') return false;
  if (project.mode === 'iterative') return toStage === 'planning';
  if (project.mode === 'quick')     return toStage === 'coding';
  return false;
}
```

### 7.5 abandoned 的语义说明

> *APISPEC-SUPPLEMENT*：data-model.md v0.6 §2.2 状态转移规则将 `abandoned` 列为 `任意阶段 → abandoned`，但未澄清 `currentStage` 与 `Project.status` 的同步关系。本文档建议（提请 data-model v0.7 明确）：
> 
> - 用户放弃项目时：`Project.status = 'abandoned'`，`Project.currentStage` **保留**放弃前的阶段值（不强制改为 `'abandoned'` 字面量）
> - 这样可保留「项目在哪一步被放弃」的信息，便于 `project.finished` 埋点的 `finalStatus` 字段与项目复盘
> - 若上游坚持 `currentStage='abandoned'`，需扩展 8 值枚举为 9 值——本文档暂按 8 值实现

---

## 8. 14 事件 payload schema（逐事件 TypeScript interface）

> 权威源：[[03_ARCHITECTURE/data-model.md#43-eventtype-枚举与prd-124一致]] v0.6 §4.3 + [[04_API_SPEC/api-spec.md#类5埋点上报接口]] v0.3 §6 payload 关键字段表

### 8.1 公共约定

- 所有事件公共字段（`eventId`/`sessionId`/`projectId`/`userId`/`eventType`/`timestamp`/`stage`/`mode`/`duration`）由 `TelemetryEvent` 主体承载（§4.2），payload 内**不重复定义**这些字段
- 下文各 interface 仅描述 `payload` 字段内部结构
- 所有 payload 必填字段缺失触发 `TELEMETRY_PAYLOAD_SCHEMA_VIOLATION`（[[04_API_SPEC/api-spec.md]] §6.1）
- 字段名采用 `camelCase`，与 [[04_API_SPEC/api-spec.md]] payload 表保持一致

### 8.2 事件 #1：`project.created`

```typescript
interface ProjectCreatedPayload {
  projectId: string;        // ✅ 必填，新项目 UUID（与 TelemetryEvent.projectId 同步）
  mode: Mode;               // ✅ 必填，'quick' | 'iterative'
  template: Template;       // ✅ 必填，6 值枚举
}
```

### 8.3 事件 #2：`dialog.submitted`

```typescript
interface DialogSubmittedPayload {
  projectId: string;        // ✅ 必填
  roundNumber: number;      // ✅ 必填，当前对话轮次，≥ 1 整数
  inputLength: number;      // ✅ 必填，用户输入字符数，≥ 0
  containsImage: boolean;   // ✅ 必填，是否含图片附件
}
```

### 8.4 事件 #3：`role.switched`

```typescript
interface RoleSwitchedPayload {
  projectId: string;        // ✅ 必填
  fromRole: Role;           // ✅ 必填，切换前角色（4 值枚举）
  toRole: Role;             // ✅ 必填，切换后角色（4 值枚举）
  triggerReason: string;    // ✅ 必填，触发原因，如 'prd-confirmed'、'prototype-confirmed'、'architecture-confirmed'
                            //    *APISPEC-SUPPLEMENT*：triggerReason 字符串值域未在 data-model.md v0.6 显式约束，
                            //    建议枚举：'prd-confirmed' | 'prototype-confirmed' | 'architecture-confirmed' |
                            //    'planning-completed' | 'mode-switch' | 'manual'
}
```

### 8.5 事件 #4：`prd.confirmed`

```typescript
interface PrdConfirmedPayload {
  projectId: string;        // ✅ 必填
  rounds: number;           // ✅ 必填，PRD 阶段对话轮次，≥ 1
  duration: number;         // ✅ 必填，PRD 阶段总耗时（ms），同步写入 TelemetryEvent.duration
  featureCount: number;     // ✅ 必填，PRD 中功能点数量，≥ 0
}
```

### 8.6 事件 #5：`prototype.confirmed`

```typescript
interface PrototypeConfirmedPayload {
  projectId: string;        // ✅ 必填
  previewCount: number;     // ✅ 必填，原型预览次数（guide.previewPrototype 调用次数），≥ 1
  editCount: number;        // ✅ 必填，累计点选编辑次数，≥ 0
  duration: number;         // ✅ 必填，原型阶段总耗时（ms），同步写入 TelemetryEvent.duration
}
```

### 8.7 事件 #6：`user.undo`

```typescript
interface UserUndoPayload {
  projectId: string;        // ✅ 必填
  stage: Stage;             // ✅ 必填，撤销发生时所在阶段（8 值枚举）
  undoTarget: string;       // ✅ 必填，撤销对象自然语言描述，如 '原型颜色修改'、'PRD功能项删除'，≤ 100 字
  undoCount: number;        // ✅ 必填，本阶段累计撤销次数，≥ 1
}
```

### 8.8 事件 #7：`click.fix`

```typescript
interface ClickFixPayload {
  projectId: string;        // ✅ 必填
  targetType: string;       // ✅ 必填，被点击元素类型，对应 data-ai-type，如 'button'、'input'、'card'
                            //    *APISPEC-SUPPLEMENT*：targetType 值域未在 data-model.md v0.6 显式枚举，
                            //    建议开放字符串（与 data-ai-type 一致），不强制枚举
  success: boolean;         // ✅ 必填，点选纠错是否成功（coder.applyFix.success）
}
```

### 8.9 事件 #8：`mode.switch`

```typescript
interface ModeSwitchPayload {
  projectId: string;        // ✅ 必填
  reason: string;           // ✅ 必填，模式转换原因，自然语言描述，≤ 200 字
  currentStage: Stage;      // ✅ 必填，转换发生时的阶段（通常为 prototype 或 architecture）
}
```

### 8.10 事件 #9：`coding.executed`

```typescript
interface CodingExecutedPayload {
  projectId: string;        // ✅ 必填
  taskType: string;         // ✅ 必填，任务类型，建议枚举：'generate-code' | 'apply-fix' | 'run-gwt'
                            //    *APISPEC-SUPPLEMENT*：taskType 值域未在 data-model.md v0.6 显式约束，
                            //    建议与 api-spec.md coder.* 三个端点动词对应
  tokensUsed: number;       // ✅ 必填，本次执行 Token 消耗，≥ 0；累加至 Project.totalTokenUsed
  success: boolean;         // ✅ 必填，执行是否成功
}
```

### 8.11 事件 #10：`autofix.triggered`

```typescript
interface AutofixTriggeredPayload {
  projectId: string;        // ✅ 必填
  attemptNumber: number;    // ✅ 必填，自修复次数，取值 1~3（[[03_ARCHITECTURE/architecture.md]] §2 上限 3）
  result: 'success' | 'failed' | 'partial';  // ✅ 必填，本尝试结果
                                              //    *APISPEC-SUPPLEMENT*：result 值域未在 data-model.md v0.6 显式枚举，
                                              //    建议三值：success（全部修复）/ partial（部分修复）/ failed（无修复）
}
```

### 8.12 事件 #11：`judge.verdict`

```typescript
interface JudgeVerdictPayload {
  projectId: string;        // ✅ 必填
  passed: boolean;          // ✅ 必填，是否通过（verdict==='pass'）
  violationTypes: string[]; // ✅ 必填，硬约束违规类型列表，对应 [[04_API_SPEC/api-spec.md]] §4.1 hardViolations[].rule
                            //    如 ['PRD_REQUIRED_FIELD_MISSING', 'PLANTUML_SYNTAX_INVALID']；通过时为 []
  duration: number;         // ✅ 必填，判定耗时（ms），同步写入 TelemetryEvent.duration
}
```

### 8.13 事件 #12：`user.satisfaction`

```typescript
interface UserSatisfactionPayload {
  projectId: string;        // ✅ 必填
  explicit: 'positive' | 'neutral' | 'negative';  // ✅ 必填，用户显式满意度标记
                                                   //    *APISPEC-SUPPLEMENT*：explicit 值域未在 data-model.md v0.6 显式枚举，
                                                   //    建议三值映射 thumbs-up / no-action / thumbs-down
}
```

### 8.14 事件 #13：`project.finished`

```typescript
interface ProjectFinishedPayload {
  projectId: string;        // ✅ 必填
  finalStatus: ProjectStatus;  // ✅ 必填，'completed' | 'abandoned'（不含 'active'）
  totalDuration: number;    // ✅ 必填，项目总耗时（ms），从 createdAt 到 completedAt/abandonedAt
  totalTokens: number;      // ✅ 必填，项目总 Token 消耗（= Project.totalTokenUsed 最终值）
}
```

### 8.15 事件 #14：`architecture.confirmed`

> **v0.6 新增（[[03_ARCHITECTURE/data-model.md]] v0.6 §4 修正注）**：架构阶段确认事件，类比 `prd.confirmed`/`prototype.confirmed`，对应 §7 状态机 `prototype → architecture` 后的确认点

```typescript
interface ArchitectureConfirmedPayload {
  projectId: string;        // ✅ 必填
  rounds: number;           // ✅ 必填，架构阶段对话轮次，≥ 1
  duration: number;         // ✅ 必填，架构阶段总耗时（ms），同步写入 TelemetryEvent.duration
  moduleCount: number;      // ✅ 必填，架构产出的模块数量，≥ 1
}
```

### 8.16 payload 总览速查

| # | eventType | payload interface | 关键差异字段 |
|---|-----------|------------------|------------|
| 1 | `project.created` | `ProjectCreatedPayload` | `mode`、`template` |
| 2 | `dialog.submitted` | `DialogSubmittedPayload` | `roundNumber`、`containsImage` |
| 3 | `role.switched` | `RoleSwitchedPayload` | `fromRole`、`toRole`、`triggerReason` |
| 4 | `prd.confirmed` | `PrdConfirmedPayload` | `rounds`、`featureCount` |
| 5 | `prototype.confirmed` | `PrototypeConfirmedPayload` | `previewCount`、`editCount` |
| 6 | `user.undo` | `UserUndoPayload` | `undoTarget`、`undoCount` |
| 7 | `click.fix` | `ClickFixPayload` | `targetType`、`success` |
| 8 | `mode.switch` | `ModeSwitchPayload` | `reason`、`currentStage` |
| 9 | `coding.executed` | `CodingExecutedPayload` | `taskType`、`tokensUsed` |
| 10 | `autofix.triggered` | `AutofixTriggeredPayload` | `attemptNumber`、`result` |
| 11 | `judge.verdict` | `JudgeVerdictPayload` | `passed`、`violationTypes` |
| 12 | `user.satisfaction` | `UserSatisfactionPayload` | `explicit` |
| 13 | `project.finished` | `ProjectFinishedPayload` | `finalStatus`、`totalDuration` |
| 14 | `architecture.confirmed` | `ArchitectureConfirmedPayload` | `moduleCount` |

### 8.17 强类型 TelemetryEvent 联合（供 SDK 消费）

```typescript
type TypedTelemetryEvent =
  | (TelemetryEvent<ProjectCreatedPayload>      & { eventType: 'project.created' })
  | (TelemetryEvent<DialogSubmittedPayload>     & { eventType: 'dialog.submitted' })
  | (TelemetryEvent<RoleSwitchedPayload>        & { eventType: 'role.switched' })
  | (TelemetryEvent<PrdConfirmedPayload>        & { eventType: 'prd.confirmed' })
  | (TelemetryEvent<PrototypeConfirmedPayload>  & { eventType: 'prototype.confirmed' })
  | (TelemetryEvent<UserUndoPayload>            & { eventType: 'user.undo' })
  | (TelemetryEvent<ClickFixPayload>            & { eventType: 'click.fix' })
  | (TelemetryEvent<ModeSwitchPayload>          & { eventType: 'mode.switch' })
  | (TelemetryEvent<CodingExecutedPayload>      & { eventType: 'coding.executed' })
  | (TelemetryEvent<AutofixTriggeredPayload>    & { eventType: 'autofix.triggered' })
  | (TelemetryEvent<JudgeVerdictPayload>        & { eventType: 'judge.verdict' })
  | (TelemetryEvent<UserSatisfactionPayload>    & { eventType: 'user.satisfaction' })
  | (TelemetryEvent<ProjectFinishedPayload>     & { eventType: 'project.finished' })
  | (TelemetryEvent<ArchitectureConfirmedPayload> & { eventType: 'architecture.confirmed' });
```

---

## 9. 枚举值总表

> 权威源：[[03_ARCHITECTURE/data-model.md]] v0.6 §2.2、§3.2、§4.3、§5.3、§6.2

### 9.1 Mode（项目模式，2 值）

| 字面量 | 含义 | 影响 |
|--------|------|------|
| `quick` | 快消型 | 跳过 `planning` 阶段，PRD/UX/架构简化 |
| `iterative` | 长期迭代型 | 完整 8 阶段流程 |

### 9.2 TriggerType（快照触发类型，5 值）

| 字面量 | 触发时机（详见 worker D）| 调用方 |
|--------|------------------------|--------|
| `init` | 初版代码生成成功后 | coder |
| `pre-modify` | 用户发起修改操作前 | guide（clickToFix）|
| `confirm` | PRD/原型/架构/规划确认后 | guide（confirm）|
| `mode-switch` | quick → iterative 升级 | guide/router |
| `pre-error` | 编程Agent 执行前（异常回滚目标）| coder |

### 9.3 Stage（项目阶段，8 值）

| 字面量 | 中文名 | 角色（建议）| 进入条件 |
|--------|--------|-----------|---------|
| `mode-select` | 模式选择 | — | 项目创建 |
| `requirements` | 需求阶段 | `requirement-analyst` | 用户选 mode |
| `prototype` | 原型阶段 | `ux-advisor` | `prd.confirmed` |
| `architecture` | 架构阶段 | `architect` | `prototype.confirmed` |
| `planning` | 规划阶段（仅 iterative）| `architect` | `architecture.confirmed` (iterative) |
| `coding` | 编码阶段 | `engineering-manager` | `architecture.confirmed` (quick) 或 `planning` 确认 |
| `testing` | 测试阶段 | `engineering-manager` | `coder.generateCode` 完成 |
| `delivered` | 交付（终态）| — | `judge.verdict` passed |

### 9.4 Role（向导Agent 角色，4 值）

| 字面量 | 中文名 | 对应模型（[[03_ARCHITECTURE/architecture.md]] §8）|
|--------|--------|---------------------------------------------|
| `requirement-analyst` | 需求分析师 | （由 arch §8 规定）|
| `ux-advisor` | UX 顾问 | （由 arch §8 规定）|
| `architect` | 架构师 | （由 arch §8 规定）|
| `engineering-manager` | 工程经理 | （由 arch §8 规定）|

### 9.5 Template（工程模板，6 值）

| 字面量 | 说明 |
|--------|------|
| `web-fullstack` | Web 全栈应用 |
| `mobile-app` | 移动端 App |
| `desktop-tool` | 桌面工具（含 Electron）|
| `cli-script` | CLI 脚本 |
| `hardware` | 硬件项目（含固件）|
| `ai-app` | AI 应用（含模型集成）|

### 9.6 DirectoryName（文档目录，8 值）

| 字面量 | 必含文件（长期迭代型）| 快消型差异 |
|--------|--------------------|----------|
| `01_PRD` | `prd.md`、`user-stories.md` | 仅 `prd.md` |
| `02_UX_DESIGN` | `sitemap.md`、`user-flows.md`、`wireframes/*.html`、`design-system.md`、`interaction-spec.md` | 仅 `wireframes/*.html`（核心页面）|
| `03_ARCHITECTURE` | `architecture.md`、`class-diagram.puml`、`sequence-diagrams/*.puml`、`data-model.md` | 仅 `architecture.md`（简版）|
| `04_API_SPEC` | `api-spec.md` | `api-spec.md`（自动推断）|
| `05_PROJECT_PLAN` | `sprint-plan.md`、`team-config.md`、`workflow.md` | 无此目录 |
| `06_TESTS` | `test-plan.md`、`features/*.feature`、`step-definitions/` | `test-plan.md`、`features/*.feature` |
| `07_VERSIONS` | `changelog.md` | 无此目录 |
| `ROOT` | `README.md` | `README.md` |

### 9.7 DocType（文档类型，21 值）

> *APISPEC-SUPPLEMENT*：[[03_ARCHITECTURE/data-model.md]] v0.6 §6.2 列出 21 个字面量，本文档照搬如下，按目录归类

| 字面量 | 典型 directory |
|--------|----------------|
| `prd` / `user-stories` | `01_PRD` |
| `sitemap` / `user-flows` / `wireframe` / `design-system` / `interaction-spec` | `02_UX_DESIGN` |
| `architecture` / `class-diagram` / `sequence-diagram` / `data-model` / `api-spec` | `03_ARCHITECTURE` / `04_API_SPEC` |
| `sprint-plan` / `team-config` / `workflow` | `05_PROJECT_PLAN` |
| `test-plan` / `feature` / `step-definition` | `06_TESTS` |
| `changelog` | `07_VERSIONS` |
| `readme` / `other` | `ROOT` |

### 9.8 DocStatus（文档状态，3 值）

| 字面量 | 含义 | 流转 |
|--------|------|------|
| `draft` | 草稿 | 初始态；judge 守此态不可校验（`JUDGE_DOC_STATUS_INVALID`）|
| `review` | 待审 | Agent 完成初稿后切换；judge 允许校验 |
| `confirmed` | 已确认 | 用户/Agent 确认后；可被引用为下游输入 |

### 9.9 FileFormat（文件格式，6 值）

| 字面量 | 说明 |
|--------|------|
| `md` | Markdown |
| `puml` | PlantUML |
| `html` | HTML（含 `wireframes/*.html`）|
| `feature` | Gherkin Feature 文件（Cucumber）|
| `json` | JSON |
| `yaml` | YAML |

### 9.10 ProjectStatus（项目状态，3 值）

| 字面量 | 含义 | completedAt | currentStage |
|--------|------|-------------|--------------|
| `active` | 进行中 | `null` | `mode-select` ~ `testing` |
| `completed` | 已完成 | 非空 | `delivered` |
| `abandoned` | 已放弃 | 可空 | 保留放弃前阶段（§7.5）|

### 9.11 EventType（事件类型，14 值）

详见 §8.16 payload 总览速查表。

### 9.12 枚举基数核对（vs [[04_API_SPEC/api-spec.md]] §8.2）

| 枚举 | 本文档计数 | api-spec.md §8.2 声明 | 一致性 |
|------|----------|---------------------|--------|
| stage | 8 | 8 | ✅ |
| triggerType | 5 | 5 | ✅ |
| role | 4 | 4 | ✅ |
| template | 6 | 6 | ✅ |
| directory | 8 | 8 | ✅ |
| DocStatus | 3 | 3 | ✅ |
| EventType | 14 | 14（v0.3 同步 data-model v0.6）| ✅ |

---

## 10. 字段约束总表

> 跨实体字段约束速查，便于接口消费方做客户端预校验

### 10.1 长度约束

| 字段 | 实体 | 上限 | 下限 | 来源 |
|------|------|------|------|------|
| `Project.name` | Project | 100 | 1 | [[03_ARCHITECTURE/data-model.md]] §2.1 |
| `Project.shortName` | Project | 30 | 1 | [[03_ARCHITECTURE/data-model.md]] §2.1 |
| `Snapshot.description` | Snapshot | 200 | 1 | [[03_ARCHITECTURE/data-model.md]] §3.2 |
| `SessionContext.conversationSummary` | SessionContext | 2000 | 1 | [[03_ARCHITECTURE/data-model.md]] §5.2 |
| `SessionContext.confirmedDecisions[]` 单项 | SessionContext | 100 | 1 | [[03_ARCHITECTURE/data-model.md]] §5.2 |

### 10.2 格式约束

| 字段 | 实体 | 格式 | 正则示例 |
|------|------|------|---------|
| `*.projectId` | 所有 | UUID v4 | `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$` |
| `*.eventId` | TelemetryEvent | UUID v4 | 同上 |
| `*.sessionId` | TelemetryEvent | UUID v4 | 同上 |
| `Project.shortName` | Project | ASCII-safe | `^[A-Za-z0-9_-]+$` |
| `*.timestamp` / `*.createdAt` / `*.updatedAt` / `*.completedAt` / `*.lastModified` | 所有 | ISO8601 含时区 | `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}\|Z)$` |
| `DocumentMeta.version` | DocumentMeta | semver 短 | `^\d+\.\d+(\.\d+)?$` |
| `DocumentMeta.relativePath` | DocumentMeta | 相对路径 | 首段必须等于 `directory` 值（除 `ROOT`）|

### 10.3 数值范围

| 字段 | 实体 | 范围 | 默认值 |
|------|------|------|--------|
| `Snapshot.snapshotId` | Snapshot | 整数 ≥ 1，项目内自增 | 自动分配 |
| `Project.totalTokenUsed` | Project | 整数 ≥ 0 | `0` |
| `SessionContext.backfillVersion` | SessionContext | 整数 ≥ 1 | `1` |
| `TelemetryEvent.duration` | TelemetryEvent | 数值 ≥ 0（ms）| `null` |
| `DialogSubmittedPayload.roundNumber` | TelemetryEvent.payload | 整数 ≥ 1 | — |
| `PrdConfirmedPayload.rounds` / `featureCount` | TelemetryEvent.payload | 整数 ≥ 1 / ≥ 0 | — |
| `PrototypeConfirmedPayload.previewCount` / `editCount` | TelemetryEvent.payload | 整数 ≥ 1 / ≥ 0 | — |
| `UserUndoPayload.undoCount` | TelemetryEvent.payload | 整数 ≥ 1 | — |
| `CodingExecutedPayload.tokensUsed` | TelemetryEvent.payload | 数值 ≥ 0 | — |
| `AutofixTriggeredPayload.attemptNumber` | TelemetryEvent.payload | 整数 1~3 | — |
| `ArchitectureConfirmedPayload.rounds` / `moduleCount` | TelemetryEvent.payload | 整数 ≥ 1 / ≥ 1 | — |

### 10.4 默认值汇总

| 字段 | 实体 | 默认值 |
|------|------|--------|
| `Project.status` | Project | `'active'` |
| `Project.currentStage` | Project | `'mode-select'` |
| `Project.completedAt` | Project | `null` |
| `Project.totalTokenUsed` | Project | `0` |
| `Snapshot.isCurrent` | Snapshot | `false` |
| `Snapshot.isHealthy` | Snapshot | `true` |
| `TelemetryEvent.projectId` | TelemetryEvent | `null` |
| `TelemetryEvent.stage` | TelemetryEvent | `null` |
| `TelemetryEvent.mode` | TelemetryEvent | `null` |
| `TelemetryEvent.duration` | TelemetryEvent | `null` |
| `TelemetryEvent.payload` | TelemetryEvent | `{}` |
| `SessionContext.confirmedDecisions` | SessionContext | `[]` |
| `SessionContext.openQuestions` | SessionContext | `[]` |
| `SessionContext.lastCheckpointSnapshotId` | SessionContext | `null` |
| `SessionContext.backfillVersion` | SessionContext | `1` |
| `DocumentMeta.version` | DocumentMeta | `'0.1'` |
| `DocumentMeta.status` | DocumentMeta | `'draft'` |

---

## 11. 与上游一致性核对

### 11.1 与 [[03_ARCHITECTURE/data-model.md]] v0.6 逐项核对

| 核对项 | 本文档章节 | 上游章节 | 结果 |
|--------|----------|---------|------|
| Project 12 字段 | §2.1 | §2.1 | ✅ 字段名/类型/必填/默认值全对齐 |
| Project 4 枚举（mode/template/status/currentStage）| §2.1 + §9.1/§9.5/§9.10/§9.3 | §2.2 | ✅ 字面量全对齐 |
| Snapshot 8 字段 | §3.1 | §3.2 | ✅ 全对齐 |
| TriggerType 5 值 | §9.2 | §3.2 | ✅ 全对齐 |
| TelemetryEvent 10 字段 | §4.1 | §4.2 | ✅ 全对齐（含 mode 字段复用 Project.mode）|
| EventType 14 值 + payload 关键字段 | §8.2~§8.15 + §8.16 | §4.3 | ✅ 全对齐（含 v0.6 新增第 14 事件 `architecture.confirmed`）|
| SessionContext 10 字段 | §5.1 | §5.2 | ✅ 全对齐 |
| Role 4 值 | §9.4 | §5.3 | ✅ 全对齐 |
| DocumentMeta 9 字段 | §6.1 | §6.2 | ✅ 全对齐 |
| DirectoryName 8 值 | §9.6 | §6.2 | ✅ 全对齐（含 `ROOT`）|
| DocType 21 值 | §9.7 | §6.2 | ✅ 全对齐 |
| DocStatus 3 值 | §9.8 | §6.2 | ✅ 全对齐 |
| FileFormat 6 值 | §9.9 | §6.2 | ✅ 全对齐 |
| stage 状态转移规则 | §7.1/§7.2 | §2.2 | ✅ 全对齐（含 mode 维度校验）|

### 11.2 与 [[04_API_SPEC/api-spec.md]] v0.3 一致性

| 核对项 | 本文档章节 | 上游章节 | 结果 |
|--------|----------|---------|------|
| 公共字段自动注入规则 | §4.3 | §0.3 | ✅ 字段名一致 |
| 14 事件 payload 关键字段 | §8.16 | §6 表 | ✅ 逐事件字段对齐 |
| `guide.confirm` stage 推进 + mode 维度 | §7.2/§7.4 | §3.4 映射表 | ✅ 全对齐 |
| `guide.clickToFix` preModifySnapshotId 来源 | §3.3（隐含 Snapshot 单活跃守卫）| §3.3 | ✅ 不冲突 |
| 错误码命名空间区分（hardViolations.rule vs 错误码）| §8.12 注 | §7 注 | ✅ 本文不混用 |

### 11.3 *APISPEC-SUPPLEMENT* 标记项汇总（提请上游确认）

| # | 标记位置 | 内容 | 建议 |
|---|---------|------|------|
| S1 | §2.3 | `Project.shortName` 派生算法未规定 | 提请 data-model v0.7 §2.1 补充算法描述 |
| S2 | §5.3 | `currentRole` 与 `currentStage` 对应关系未强制 | 提请 data-model v0.7 §5.3 增加「建议对应」表（以 arch §8 为准）|
| S3 | §6.3 | `docType` 与 `directory` 对应关系未穷举 | 提请 data-model v0.7 §6.3 增加映射表 |
| S4 | §7.5 | `abandoned` 时 `currentStage` 同步策略未澄清 | 提请 data-model v0.7 §2.2 显式约定（建议保留放弃前阶段，不扩 9 值枚举）|
| S5 | §8.4 | `RoleSwitchedPayload.triggerReason` 值域未枚举 | 建议枚举：`'prd-confirmed' \| 'prototype-confirmed' \| 'architecture-confirmed' \| 'planning-completed' \| 'mode-switch' \| 'manual'` |
| S6 | §8.8 | `ClickFixPayload.targetType` 值域未枚举 | 建议开放字符串（与 `data-ai-type` 一致），不强制枚举 |
| S7 | §8.10 | `CodingExecutedPayload.taskType` 值域未枚举 | 建议枚举：`'generate-code' \| 'apply-fix' \| 'run-gwt'`（与 coder.* 三端点对齐）|
| S8 | §8.11 | `AutofixTriggeredPayload.result` 值域未枚举 | 建议枚举：`'success' \| 'partial' \| 'failed'` |
| S9 | §8.13 | `UserSatisfactionPayload.explicit` 值域未枚举 | 建议枚举：`'positive' \| 'neutral' \| 'negative'` |

### 11.4 data-model.md v0.6 内部不一致标注

> *APISPEC-SUPPLEMENT*：[[03_ARCHITECTURE/data-model.md]] v0.6 自身已修正 §1.2 vs §1.3 快照路径冲突（v0.6 补丁说明：以 §1.2 为准，§1.3 `_system/snapshots/` 已修正为 `snapshots/`）。本文档完全遵循 §1.2 布局图，`Snapshot.filePath` 字段描述（§3.1）使用 `snapshots/{projectId}/snap-{ts}-{id}/`，与 §1.2 一致。

**本文档未发现新的 data-model.md v0.6 内部不一致**——v0.6 修订后字段层面已收敛。上述 S1~S9 为「未显式规定」而非「内部不一致」。

---

## 12. DoD self_check 核对表

| DoD 项 | 结果 | 证据 |
|--------|------|------|
| 文件落 `D:/Codes/multi-agent-collab-platform/04_API_SPEC/` | ✅ | 路径见文件头 + 物理文件已创建 |
| 5 实体字段全量列出（与 data-model.md §2-6 对齐）| ✅ | §2~§6 字段表 + TS 类型逐字段对应 §11.1 核对表 |
| 8 阶段状态机转换图明确（mode-select → ... → delivered）| ✅ | §7.1 mermaid 状态图 + §7.2 合法转换表 10 行穷举 + §7.3 非法转换错误码表 |
| 14 事件 payload schema 含必填/可选字段 | ✅ | §8.2~§8.15 逐事件 TypeScript interface，每字段标 ✅/❌；§8.16 总览速查 |
| 枚举值表（stage/triggerType/role/template/directory/status）逐项对照上游 | ✅ | §9.1~§9.10 全量 + §9.12 基数核对表 |
| 与 data-model.md v0.6 逐字段对齐 | ✅ | §11.1 14 项核对表全 ✅ |
| TypeScript 类型导出可复用 | ✅ | §1 总导出 + 各实体 §x.2 + §8.17 强类型联合 |
| 字段约束（必填/格式/范围/默认值）| ✅ | §10.1~§10.4 四张约束表 |
| ≥3000 字 | ✅ | 字数预估约 7000+ 字（含表格/代码块）|
| frontmatter + 一致性声明 | ✅ | 文件头 blockquote 元信息 + 一致性声明段 |
| 不修改 data-model.md / api-spec.md | ✅ | 本文档为新建文件，未触碰上游 |
| out_of_scope 严守（不写触发时机/Agent 调用/前端 IPC）| ✅ | §0.2 范围边界表显式排除；事件触发时机仅 §9.2 表中「触发时机」列引用 worker D，未展开 |

---

> 本文档为 [[04_API_SPEC/api-spec.md]] v0.3 的数据结构补充件，所有 TypeScript 类型导出可直接复用至前端 UI 层、Service 层、SDK；上游字段定义以 [[03_ARCHITECTURE/data-model.md]] v0.6 为权威源，本文档不重新定义字段。S1~S9 共 9 项 *APISPEC-SUPPLEMENT* 提请 data-model v0.7 / api-spec v0.4 确认后回写。


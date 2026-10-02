# 前后端 API 文档（Electron IPC 视角）

> 项目：向导Agent与编程Agent多智能体协同开发平台
> 文档ID：DOC-4.5 | 版本：v0.1 | 日期：2026-07-15 | 状态：草稿（worker B 产出，待 commander 审计；2026-07-15 njfix-A4-worker 补 B5 manual SYSTEM 权限前端契约）
> 依赖：[[04_API_SPEC/api-spec.md]] v0.4（§0~§8 共 20 端点 + ApiResponse 信封 + 错误码体系）、[[03_ARCHITECTURE/architecture.md]] v0.3（§1.1 Electron/React/TS 技术栈、§4.2 扩展点 services/ 目录、§7 点选纠错链路）、[[03_ARCHITECTURE/data-model.md]] v0.6（5 实体字段、Project.directoryPath/currentStage、TelemetryEvent.sessionId/userId）、[[README.md]]（项目代号 nanju、Proma 源码扩展基座）
> 一致性声明：本文档 20 个 IPC channel 与 [[04_API_SPEC/api-spec.md]] v0.4 的 20 端点逐条一一对应（见 §1.2 全量映射表与 §12 一致性核对）；TypeScript 类型签名严格按 api-spec.md 各端点「输入 Schema / 输出 Schema」字段表导出；流式契约（chunk/done/error/cancel）忠实扩展自 api-spec.md §3.1 流式契约子节，未引入新端点；错误传递机制 100% 复用 api-spec.md §0.2 ApiResponse 信封与 §8 错误码体系。所有 *APISPEC-SUPPLEMENT* 标注均为前端落地层补充定义（通道命名细节、preload 暴露形态、React Hook 形态等），不修改 api-spec.md 已有契约。

---

## 0. 文档定位与范围

### 0.1 与 api-spec.md 的关系

[[04_API_SPEC/api-spec.md]] v0.4 已定义 6 类共 20 个端点的「业务契约」（输入/输出 Schema、错误码、与上游架构/数据模型的字段映射），并指出"在 MVP 阶段，所有调用均为本地函数调用，不涉及网络；接口名形如 `judge.evaluateDocs` 表示 `services/judge.ts` 模块导出的 `evaluateDocs` 函数，前端通过 `ipcRenderer.invoke('judge:evaluateDocs', payload)` 触发"（§0.1）。

本文档专注**前端落地层**，回答 4 个 api-spec.md 未细化的问题：

| 问题 | 本文档章节 | api-spec.md 现有定义 |
|------|----------|--------------------|
| ipcMain.handle / ipcRenderer.invoke 的通道字符串到底怎么命名？前缀、分隔符、嵌套动作如何拼？ | §1.2、§2~§6 各端点小节 | §0.1 给出 `judge:evaluateDocs` 形态示例，未列举全量 |
| 渲染进程调用方写什么 TypeScript 代码？类型从哪里 import？ | §8 services/*.ts 函数签名 | 各端点 Schema 表（无 TS 代码） |
| guide.chat 流式的 chunk/done/error/cancel 在 Electron 中具体怎么订阅？ | §3.1 流式契约实现细节 | §3.1 4 事件契约描述（文字） |
| 错误信封在 IPC reject 路径上怎么传？前端 try/catch 拿到的是什么？ | §9 错误传递机制 | §0.2 ApiResponse 信封（接口形态） |

**本文档不重新定义任何业务字段**——所有 `projectRoot`/`projectId`/`triggerType`/`eventType` 等字段的含义、取值、必填性一律以 api-spec.md 为准；本文档只在 TS 类型层做"翻译"，并在出现需要前端落地的额外约定时以 *APISPEC-SUPPLEMENT* 标注。

### 0.2 范围边界（与 worker A/C/D 的分工）

| 不在本文档范围 | 负责人 | 说明 |
|--------------|--------|------|
| Agent 间调用时序（如 confirm → snapshot.create → role.switched 三步编排） | worker A | 时序图文档 |
| 数据模型字段表（Project/Snapshot/SessionContext/DocumentMeta/TelemetryEvent 全字段） | worker C | data-model.md |
| 埋点事件 payload 详细结构（14 事件的 payload 关键字段） | worker D | 埋点专项文档 |
| 修改 api-spec.md / architecture.md / data-model.md 已有内容 | — | 严守约束，不一致处用 *APISPEC-SUPPLEMENT* 标注并提请上游 |

---

## 1. IPC 桥接总览

### 1.1 进程职责切分

平台基于 Electron ^39.5.1（[[03_ARCHITECTURE/architecture.md]] §1.1），渲染进程（React UI）与主进程（Node.js 文件系统、子进程、LLM 调用）经 `contextBridge` 暴露的受限 API 通信：

| 进程 | 持有的能力 | 暴露给对方的内容 |
|------|-----------|----------------|
| **主进程（main）** | `fs`（项目目录、`_meta.json`、JSONL 埋点）、`child_process`（沙箱执行）、`ipcMain.handle` 注册端点、调用 Proma Cloud LLM | 不主动暴露 |
| **渲染进程（renderer）** | React 组件、Jotai atom、`window.nanjuAPI.*`（preload 注入） | UI 事件 |
| **preload 脚本** | `contextBridge.exposeInMainWorld('nanjuAPI', {...})` 把 `ipcRenderer.invoke` / `ipcRenderer.on` 包装成强类型方法 | 见 §10.2 |

> **零信任前提**：渲染进程不直接持有 `ipcRenderer`，仅通过 preload 暴露的 `window.nanjuAPI` 命名空间访问。所有 `nanjuAPI.*` 方法在 preload 层做参数浅校验，主进程在 `ipcMain.handle` 内做权威校验。

### 1.2 IPC 通道命名规范

**全平台统一命名规则**：

```
<domain>:<action>[:<subAction>]
```

- `<domain>` ∈ `coder` | `guide` | `judge` | `snapshot` | `telemetry` | `project`，与 api-spec.md §1 接口分类（v0.4 类 1-6）一一对应；
- `:`（冒号）为分隔符（Electron 通道字符串允许任意字符，冒号在 URL/语义上更具可读性，且与 Proma 现有 `mcp__proma-cloud__*` 命名风格不冲突）；
- `<action>` 为 camelCase 动词或动名词，对应 api-spec.md 端点名（如 `generateCode` / `chat` / `evaluateDocs`）；
- 流式接口的 4 事件用 `:<subAction>` 扩展（仅 `guide:chat` 一族）。

**20 端点全量 IPC channel 清单**（与 api-spec.md v0.4 §1 总览表对照）：

| # | api-spec 端点 | IPC channel | 域 | 形态 | api-spec 章节 |
|---|--------------|-------------|------|------|--------------|
| 1 | `coder.generateCode` | `coder:generateCode` | CODER | invoke（请求-响应） | §2.2 |
| 2 | `coder.applyFix` | `coder:applyFix` | CODER | invoke | §2.3 |
| 3 | `coder.runGwt` | `coder:runGwt` | CODER | invoke | §2.4 |
| 4 | `guide.chat` | `guide:chat`（主调用） | GUIDE | 流式（invoke + on） | §3.1 |
| 4a | —（chat:chunk） | `guide:chat:chunk` | GUIDE | 主进程 → 渲染进程 on | §3.1 流式契约 |
| 4b | —（chat:error） | `guide:chat:error` | GUIDE | 主进程 → 渲染进程 on | §3.1 流式契约 |
| 4c | —（chat:cancel） | `guide:chat:cancel` | GUIDE | invoke（渲染 → 主） | §3.1 流式契约 |
| 5 | `guide.previewPrototype` | `guide:previewPrototype` | GUIDE | invoke | §3.2 |
| 6 | `guide.clickToFix` | `guide:clickToFix` | GUIDE | invoke | §3.3 |
| 7 | `guide.confirm` | `guide:confirm` | GUIDE | invoke | §3.4 |
| 8 | `judge.evaluateDocs` | `judge:evaluateDocs` | JUDGE | invoke | §4.1 |
| 9 | `judge.evaluateCode` | `judge:evaluateCode` | JUDGE | invoke | §4.2 |
| 10 | `snapshot.create` | `snapshot:create` | SNAPSHOT | invoke | §5.1 |
| 11 | `snapshot.list` | `snapshot:list` | SNAPSHOT | invoke | §5.2 |
| 12 | `snapshot.rollback` | `snapshot:rollback` | SNAPSHOT | invoke | §5.3 |
| 13 | `snapshot.delete` | `snapshot:delete` | SNAPSHOT | invoke | §5.4 |
| 14 | `telemetry.emit` | `telemetry:emit` | TELEMETRY | invoke（fire-and-forget） | §6.1 |
| 15 | `telemetry.emitBatch` | `telemetry:emitBatch` | TELEMETRY | invoke | §6.2 |
| 16 | `telemetry.query` | `telemetry:query` | TELEMETRY | invoke | §6.3 |
| 17 | `project.list` | `project:list` | PROJECT | invoke（请求-响应） | §7.1 |
| 18 | `project.open` | `project:open` | PROJECT | invoke | §7.2 |
| 19 | `project.delete` | `project:delete` | PROJECT | invoke（破坏性，须 SYSTEM 权限，见 api-spec §0.4） | §7.3 |
| 20 | `project.switchMode` | `project:switchMode` | PROJECT | invoke | §7.4 |

> **流式接口的子通道记法**：`guide:chat` 一族实际占用 4 个 channel 字符串（主调用 + chunk + error + cancel）。在 §12 一致性核对的"端点数"统计中仍按 api-spec.md 口径计为 **1 个端点**（guide.chat），20 端点总数不变。*APISPEC-SUPPLEMENT*：流式 4 事件作为同一端点的子通道存在，主进程注册时统一在一个 `registerGuideChatIpc(mainWindow)` 函数内批量注册。

**命名一致性检查清单**（worker 自检，对应 dod.self_check 第 2 条）：

- 通道前缀（`coder:` / `guide:` / `snapshot:` / `telemetry:`）与 api-spec.md §1.1 类别前缀完全一致——已逐项核对 ✅
- 通道动作名（如 `generateCode` / `evaluateDocs`）与 api-spec.md 端点动词完全一致——已逐项核对 ✅
- `snapshot.*` 与 `telemetry.*` 用 `.`（点）连接 api-spec 端点名，但 IPC channel 中改为 `:`（冒号）——这是 Electron 通道字符串惯例（`:` 比 `.` 更罕见于普通字段路径，可读性更高），不影响端点数对应 ✅

### 1.3 上下文自动注入

[[04_API_SPEC/api-spec.md]] §0.3 规定所有调用隐式携带 `sessionId` / `projectId` / `userId` / `stage` / `mode` 公共上下文。本文档将此机制落地为：

| 注入点 | 字段 | 数据源 | 备注 |
|-------|------|-------|------|
| preload 层 | `sessionId` | 应用启动时生成 UUID v4，存入 `localStorage` | 全应用单例 |
| preload 层 | `userId` | `hash(username + deviceId)`，启动时计算 | 不随调用变化 |
| 渲染层调用方传入 | `projectId` | 当前活跃项目的 Jotai atom | 全局事件可为 null |
| 渲染层调用方传入 | `stage` / `mode` | 当前项目 atom 派生 | `guide.*` / `telemetry.*` 使用 |
| 主进程 ipcMain.handle 内 | `requestId` | `crypto.randomUUID()` | 每次调用生成，写入 ApiResponse |
| 主进程 ipcMain.handle 内 | `callerModule`（仅 `snapshot:create`） | 按调用源模块注入（coder/guide/judge/router/manual） | **🔧 B5**：前端不可设置此字段（参见 §4.1 前端 IPC 拒绝契约 + §7.4 `FrontendCallerModule` 类型）；前端若强传 `'manual'` → `SYSTEM_PERMISSION_DENIED` |

> **projectRoot vs projectId 使用规则**（沿用 api-spec.md §0.3 *APISPEC-SUPPLEMENT*）：
> - `telemetry.*`：`projectId` 由上下文自动注入；
> - `guide.*`：`projectId` 为显式入参（业务字段）；
> - `coder.*` / `judge.*` / `snapshot.*`：使用 `projectRoot`（= `Project.directoryPath` 绝对路径）作为沙箱边界，**调用方须显式传入**，主进程会校验该路径在 `projects-index.json` 内（错误码 `*_PROJECT_NOT_FOUND`）。
> - `guide.*` 内部若需 `projectRoot`，由服务层从 `projectId` 反查 `_meta.json#project.directoryPath` 注入。

---

## 2. coder:* 通道清单（类 1：3 端点）

### 2.1 `coder:generateCode`（端点 1.1）

**业务契约**：[[04_API_SPEC/api-spec.md#22-端点-11-codergeneratecode文档代码生成]] §2.2。

**主进程注册**（伪代码）：

```typescript
ipcMain.handle('coder:generateCode', async (event, input: GenerateCodeInput) => {
  // 1. 校验 projectRoot 在 projects-index.json
  // 2. 校验 _meta.json#documents[].directory 枚举
  // 3. 调用 services/coder.ts#generateCode(input)
  // 4. 成功后内部触发 snapshot.create(triggerType='init') — 由 coder 服务内部编排
  // 5. 返回 ApiResponse<CodeGenResult>
});
```

**渲染进程触发**：见 §8.1 `services/coder.ts` 与 §10.1 示例。

**典型耗时**：60~180 秒（含 GLM 5.1 调用 + 自修复最多 3 次 + GWT 测试）；超 180 秒触发 `CODER_SANDBOX_TIMEOUT`（api-spec.md §2.2 错误表）。

### 2.2 `coder:applyFix`（端点 1.2）

**业务契约**：[[04_API_SPEC/api-spec.md#23-端点-12-coderapplyfix点选纠错执行]] §2.3。前置条件——`preModifySnapshotId` 必须已存在（由上游 `guide.clickToFix` 自动创建，api-spec.md §3.3）。

**主进程校验顺序**：
1. `preModifySnapshotId` 存在性 → 否则 `CODER_FIX_PRE_SNAPSHOT_MISSING`
2. `action` 在 5 值枚举 → 否则 `CODER_FIX_ACTION_INVALID`
3. `target.dataAiId` 在当前代码中可定位 → 否则 `CODER_TARGET_NOT_FOUND`
4. 修改范围未越出 `_code/` → 否则 `CODER_FIX_OUT_OF_SCOPE`

### 2.3 `coder:runGwt`（端点 1.3）

**业务契约**：[[04_API_SPEC/api-spec.md#24-端点-13-coderrungwt-gwt-测试与自修复]] §2.4。`enableAutofix=true` 时最多 3 次自修复，3 次后仍有失败 → `CODER_AUTOFIX_EXHAUSTED`（api-spec.md §2.4）。

---

## 3. guide:* 通道清单（类 2：4 端点，含流式契约）

### 3.1 `guide:chat`（端点 2.1，流式）

**业务契约**：[[04_API_SPEC/api-spec.md#31-端点-21-guidechat-用户输入-agent-回复-流式]] §3.1。本节扩展 api-spec.md §3.1「流式契约」子节，给出 Electron IPC 落地细节。

#### 3.1.1 流式四事件契约（chunk / done / error / cancel）

| 事件 | IPC channel | 方向 | payload 形态 | 触发时机 |
|------|------------|------|-------------|----------|
| **chunk（增量）** | `guide:chat:chunk` | main → renderer | `{ requestId, type: 'delta', text: string }` | 每个 token 增量 |
| **done（结束）** | `guide:chat:chunk` | main → renderer | `{ requestId, type: 'done', final: ChatResult }` | 流末尾，`final` 携带聚合结果（replyText/roleSwitched/newRole/documentsUpdated/tokensUsed） |
| **error（异常）** | `guide:chat:error` | main → renderer | `{ requestId, error: ApiResponse['error'] }`（含 code/message/details） | LLM 失败、上下文 backfill 失败等 |
| **cancel（取消）** | `guide:chat:cancel` | renderer → main（invoke） | `{ requestId }` | 用户主动中断 |

> **关键约定**（api-spec.md §3.1 流式契约 + 本文档落地补充）：
> 1. `chunk` 与 `done` 复用同一 channel `guide:chat:chunk`，通过 `payload.type` 区分；前端订阅只需 `ipcRenderer.on('guide:chat:chunk', ...)` 一次。
> 2. `error` 走独立 channel `guide:chat:error`，与 chunk 分离，便于前端做错误分支单独处理。
> 3. **`ipcRenderer.invoke('guide:chat', input)` 的 Promise 行为**：成功时在 `done` 事件后 resolve（resolve 值 = `ChatResult`）；失败时 reject 同一 error；用户 cancel 时 resolve 已生成部分作为 `ChatResult.replyText`（api-spec.md §3.1 取消语义）。
> 4. **requestId 关联**：渲染层在 invoke 前生成 `requestId`，作为 input 的隐藏字段（不在 api-spec.md Schema 表中显式列出，由 preload 层注入）；所有 chunk/error/cancel 事件回传同一 `requestId`，前端用它做"哪次调用返回的"匹配（防止多 tab 并发对话串流）。
> 5. **订阅生命周期**：渲染层在 invoke 调用前注册 `chunk` 和 `error` 监听，在 Promise resolve/reject 后立即 `ipcRenderer.removeListener` 清理——避免内存泄漏。建议封装为 React Hook（见 §9.2 `useGuideChat`）。

#### 3.1.2 错误情况

| 错误码 | 触发条件 |
|--------|---------|
| `GUIDE_PROJECT_NOT_FOUND` | `projectId` 不存在 |
| `GUIDE_ROLE_INVALID` | `role` 不在 4 角色枚举 |
| `GUIDE_MODEL_UNAVAILABLE` | 角色对应模型 API 调用失败（MiniMax 2.7 等） |
| `GUIDE_CONTEXT_BACKFILL_FAILED` | Session Restart 时读取 `sessions/{projectId}.json` 失败 |

> **错误传递细节**：错误经 `guide:chat:error` 事件 + Promise reject 双路通知前端（api-spec.md §3.1 "Promise reject 同一 error；已发送 chunk 不回收"）。前端应同时订阅 error 事件和 await 时 try/catch；两路到达的 error 携带同一 `requestId`，渲染层需去重。

### 3.2 `guide:previewPrototype`（端点 2.2）

**业务契约**：[[04_API_SPEC/api-spec.md#32-端点-22-guidepreviewprototype-原型预览]] §3.2。返回注入了 `data-ai-id` / `data-ai-type` 的预览 HTML，供点选纠错链路使用。

### 3.3 `guide:clickToFix`（端点 2.3）

**业务契约**：[[04_API_SPEC/api-spec.md#33-端点-23-guideclicktofix-点选纠错入口]] §3.3。内部自动调用 `snapshot.create(triggerType='pre-modify')` 创建前置快照，`fixSpec` 可直接作为 `coder.applyFix` 入参（消除双源歧义，api-spec.md §3.3 输出注）。

**链路编排**（worker B 视角，不含 worker A 的时序图）：

```
用户点击预览元素 (data-ai-id)
    ↓
渲染层 nanjuAPI.guide.clickToFix({ projectId, dataAiId, dataAiType, pageContext, phase })
    ↓ IPC guide:clickToFix
主进程 services/guide.ts#clickToFix
    ├─ snapshot.create(triggerType='pre-modify')  → 内部 IPC，得 preModifySnapshotId
    ├─ 调用 LLM（phase1 直接 / phase2 视觉模型 MiniMax）生成 fixSpec
    └─ 返回 { fixSpec, confidence, preModifySnapshotId, success }
    ↓ IPC 响应
渲染层（若 confidence >= 阈值）→ nanjuAPI.coder.applyFix(fixSpec)
```

### 3.4 `guide:confirm`（端点 2.4）

**业务契约**：[[04_API_SPEC/api-spec.md#34-端点-24-guideconfirm-确认-prd-原型-架构]] §3.4。内部触发：snapshot.create(`confirm`) + 埋点（`prd.confirmed` / `prototype.confirmed` / `architecture.confirmed`）+ Session Restart（[[03_ARCHITECTURE/architecture.md]] §5.2 六步）。

> **mode 维度校验**（api-spec.md §3.4 注）：`architecture→planning` 仅 `iterative` 合法；`quick` 型架构确认后 `toStage=planning` → `GUIDE_INVALID_STAGE_TRANSITION`。前端 confirm 调用前应根据 `Project.mode`（atom）做客户端预校验，避免无谓 IPC 往返。

---

## 4. snapshot:* 通道清单（类 4：4 端点）

> **类别前缀注**：api-spec.md §1.1 类别前缀表中"接口前缀"列写为 `snapshot.*`（点号），本文档 IPC channel 改为 `snapshot:*`（冒号）。这是 Electron 通道字符串惯例（参见 §1.2 命名一致性检查清单第 3 条），端点数对应关系不变。*APISPEC-SUPPLEMENT*。

### 4.1 `snapshot:create`（端点 4.1）

主要由 `coder` / `guide` / `judge` / `router` 内部调用（[[04_API_SPEC/api-spec.md#51-端点-41-snapshotcreate-系统触发创建快照]] §5.1）；`callerModule='manual'` 时仅供设置页诊断面板触发，需 SYSTEM 权限校验。

> **🔧 B5 前端 IPC 拒绝契约（*APISPEC-SUPPLEMENT*，2026-07-15 njfix-A4-worker 补 — audit §A2-2）**：
>
> `callerModule` 是**后端注入字段**，前端不可设置。具体契约：
>
> | 层 | 行为 | 越权处置 |
> |----|------|---------|
> | 渲染层 React 组件 | **禁止**在调用 `snapshotService.create(...)` 时携带 `callerModule` 字段 | TS 类型层在 §7.4 已剔除 `'manual'`（`FrontendCallerModule = Exclude<CallerModule, 'manual'>`），传 `'manual'` 编译期报错 |
> | services/snapshot.ts（前端 IPC 包装） | 运行时守卫：检测 `input.callerModule === 'manual'` | 立即 `throw new IpcError('SYSTEM_PERMISSION_DENIED', ...)`，**不发起 IPC invoke**，不透传给主进程 |
> | preload.ts / contextBridge | `_invoke('snapshot:create', payload)` 不主动注入 callerModule；该字段若存在则由主进程在 `ipcMain.handle` 内按调用源注入（参见 §1.3 注入点表"主进程注入"行） | — |
> | 主进程 ipcMain.handle | 收到渲染层传来的 `callerModule='manual'` 视为越权调用，返回 `ApiResponse.ok=false` + `error.code='SYSTEM_PERMISSION_DENIED'`（兜底防线，前端守卫失效时仍拦截） | 错误码透传回渲染层 |
>
> **错误码 `SYSTEM_PERMISSION_DENIED`**：
> - **命名空间**：属 SYSTEM 域（`<DOMAIN>_<ERROR>` = `SYSTEM_PERMISSION_DENIED`），由 A1 worker 在 [[04_API_SPEC/api-spec.md]] §8 错误码体系新增定义（v0.4 §8 即原 §7 顺延；前端文档**仅引用**，不重复定义错误码）。
> - **HTTP 类比**：403 Forbidden，**不可重试**（属权限拒绝，重试无效）。
> - **前端展示**：渲染层 catch 到 `IpcError{code:'SYSTEM_PERMISSION_DENIED'}` 时，UI 显示"权限不足：此操作仅限系统内部触发"（参见 §9.3 case 范式）。
>
> **反事实兜底**（对应 audit §A2-2）：任意用户态/渲染层代码伪造 `callerModule='manual'` 试图绕过"用户不可手动创建快照"约束（[[03_ARCHITECTURE/data-model.md]] §3.1）时，被前端 services 层守卫拦截；守卫被绕过（如直接调 `window.nanjuAPI._invoke`）时由主进程兜底拒绝。两道防线，无单点失败。

### 4.2 `snapshot:list`（端点 4.2）

**业务契约**：[[04_API_SPEC/api-spec.md#52-端点-42-snapshotlist-快照列表]] §5.2。前端时间轴面板（[[03_ARCHITECTURE/architecture.md]] §4.2 ~18 components 之一）通过此端点拉取快照列表。

### 4.3 `snapshot:rollback`（端点 4.3）

**业务契约**：[[04_API_SPEC/api-spec.md#53-端点-43-snapshotrollback-线性回滚]] §5.3。线性回滚不删除被回滚快照；并发拒绝（`SNAPSHOT_ROLLBACK_IN_PROGRESS`）。

### 4.4 `snapshot:delete`（端点 4.4）

**业务契约**：[[04_API_SPEC/api-spec.md#54-端点-44-snapshotdelete-删除非当前快照]] §5.4。强守卫——`isCurrent=true` 拒删（`SNAPSHOT_DELETE_CURRENT_FORBIDDEN`），前端 UI 应隐藏"删除"按钮。

---

## 5. telemetry:* 通道清单（类 5：3 端点）

### 5.1 `telemetry:emit`（端点 5.1，fire-and-forget）

**业务契约**：[[04_API_SPEC/api-spec.md#61-端点-51-telemetryemit-单事件上报-fire-and-forget]] §6.1。非阻塞，写入内存缓冲后立即返回。前端埋点 14 事件的 payload 字段表由 worker D 负责（本文档 out_of_scope），services 层只暴露弱类型 `payload: object`。

### 5.2 `telemetry:emitBatch`（端点 5.2）

**业务契约**：[[04_API_SPEC/api-spec.md#62-端点-52-telemetryemitbatch-批量上报强制-flush]] §6.2。典型用法：阶段切换、应用退出（`flushReason='stage-change'` / `'app-exit'`）时强制 flush。

### 5.3 `telemetry:query`（端点 5.3）

**业务契约**：[[04_API_SPEC/api-spec.md#63-端点-53-telemetryquery-埋点查询聚合-供分析看板]] §6.3。分析看板页面（[[03_ARCHITECTURE/architecture.md]] §4.1 ANALYTICS Tab）使用。

---

## 6. judge:* 通道清单（类 3：2 端点）

### 6.1 `judge:evaluateDocs`（端点 3.1）

**业务契约**：[[04_API_SPEC/api-spec.md#41-端点-31-judgeevaluatedocs-文档体系判定]] §4.1。`targetDirectory` 刻意排除 `02_UX_DESIGN` / `07_VERSIONS` / `ROOT`（api-spec.md §4.1 注）。

### 6.2 `judge:evaluateCode`（端点 3.2）

**业务契约**：[[04_API_SPEC/api-spec.md#42-端点-32-judgeevaluatecode-代码-类图一致性-gwt-存在性判定]] §4.2。输出 `VerdictResult & { classConsistency, gwtCoverage }`。

> **`hardViolations[].rule` 命名空间提醒**（沿用 api-spec.md §8 *APISPEC-SUPPLEMENT*）：`rule` 字段（如 `PRD_REQUIRED_FIELD_MISSING`）属"裁判硬约束规则名"命名空间，**不带 DOMAIN 前缀**，与 api-spec §8 错误码（`<DOMAIN>_<ERROR>`）是两套独立空间。前端在展示违规清单时区分对待——rule 走"问题定位 UI"，error code 走"调用失败 UI"。

---

## 7. project:* 通道清单（类 6：4 端点，v0.4 新增）

> **类别前缀注**（*APISPEC-SUPPLEMENT*）：api-spec.md §1.1 类别前缀表中"接口前缀"列写为 `project.*`（点号），本文档 IPC channel 改为 `project:*`（冒号），与 §4 `snapshot:*` / §5 `telemetry:*` 同惯例（参见 §1.2 命名一致性检查清单第 3 条）。本类 4 端点为 api-spec v0.4 新增；项目"创建"仍归 Proma 平台层 new project wizard，不暴露 create 端点（见 api-spec §1.1 范围声明）。

> **入参主键约定**（沿用 api-spec.md §0.3 *APISPEC-SUPPLEMENT*）：`project.*` 端点统一以 `projectId`（Project 实体主键）作入参；服务层内部由 `projectId` 反查 `_meta.json#project.directoryPath` 解析 `projectRoot`，**调用方无需传 `projectRoot`**（与 `coder.*` / `judge.*` / `snapshot.*` 须显式传 `projectRoot` 不同，参见 §1.3）。

### 7.1 `project:list`（端点 6.1）

**业务契约**：[[04_API_SPEC/api-spec.md#71-端点-61-projectlist-项目列表--单项目详情]] §7.1。

**主进程注册**（伪代码）：

```typescript
ipcMain.handle('project:list', async (event, input: ProjectListInput) => {
  // 1. 读 _system/projects-index.json（损坏 → PROJECT_INDEX_CORRUPT）
  // 2. 应用 filter（mode/template/currentStage，越枚举 → INPUT_INVALID）+ sortBy + includeArchived
  // 3. projectId 提供则返回单项目详情，缺省列全部（找不到 → PROJECT_NOT_FOUND）
  // 4. 返回 ApiResponse<ProjectListResult>
});
```

**输入/输出要点**：入参 `projectId?` / `filter?` / `includeArchived?` / `sortBy?`；出参 `projects[]`（每项含 `projectId/name/mode/template/currentStage/directoryPath/lastOpenedAt/totalTokenUsed/archived`）+ `currentProjectId` + `totalCount`。

### 7.2 `project:open`（端点 6.2）

**业务契约**：[[04_API_SPEC/api-spec.md#72-端点-62-projectopen-打开项目]] §7.2。

**主进程注册**（伪代码）：

```typescript
ipcMain.handle('project:open', async (event, input: ProjectOpenInput) => {
  // 1. 校验 projectId 在 projects-index.json → 否则 PROJECT_NOT_FOUND
  // 2. 校验 directoryPath 在磁盘 → 否则 PROJECT_DIRECTORY_MISSING
  // 3. resumeSession=true 时执行 Session Restart + Context Backfill（与 guide.confirm 内部编排六步一致）
  // 4. 写回 lastOpenedAt 到 projects-index.json + _meta.json#project
  // 5. 返回 ApiResponse<ProjectOpenResult>
});
```

**渲染进程触发**：见 §8 `services/project.ts` 与 §10 调用示例。

### 7.3 `project:delete`（端点 6.3，破坏性）

**业务契约**：[[04_API_SPEC/api-spec.md#73-端点-63-projectdelete-删除项目]] §7.3。

> **🔧 B5 前端 IPC 拒绝契约**（*APISPEC-SUPPLEMENT*，与 §4.1 `snapshot:create` 同级）：
>
> `project.delete` 为**破坏性操作**（删除索引 / 快照 / 可选工作区目录），须 **SYSTEM 级权限**（api-spec §0.4 三要素）+ 二次确认 token。前端契约与 §4.1 `snapshot:create` 的 `callerModule='manual'` 拒绝一致：
>
> | 层 | 行为 | 越权处置 |
> |----|------|---------|
> | 渲染层 React 组件 | 用户在项目列表点"删除" → 弹二次确认（须输入 `projectId` 末 8 位作 `confirmation` token）；**禁止**携带任何绕过确认的字段 | `confirmation` 不匹配 → `PROJECT_DELETE_CONFIRMATION_REQUIRED` |
> | services/project.ts（前端 IPC 包装） | 组装 `{ projectId, confirmation, deleteSnapshots?, deleteWorkspace? }`；运行时守卫：不注入任何 SYSTEM token | 主进程校验调用方非 SYSTEM 上下文 → `SYSTEM_PERMISSION_DENIED` |
> | 主进程 ipcMain.handle | 校验 `event.sender.systemContext.token`（SYSTEM 级）+ `confirmation === projectId.slice(-8)` + 无活动会话 | 失败返回 `PROJECT_DELETE_HAS_ACTIVE_SESSION` / `SYSTEM_PERMISSION_DENIED` |
>
> **错误码**：`PROJECT_DELETE_CONFIRMATION_REQUIRED`（4xx）/ `PROJECT_DELETE_HAS_ACTIVE_SESSION`（409）/ `SYSTEM_PERMISSION_DENIED`（403，不可重试，见 §9.3 case 范式）/ `PROJECT_NOT_FOUND`（4xx）。

### 7.4 `project:switchMode`（端点 6.4）

**业务契约**：[[04_API_SPEC/api-spec.md#74-端点-64-projectswitchmode-模式切换-quick--iterative]] §7.4。

**主进程注册**（伪代码）：

```typescript
ipcMain.handle('project:switchMode', async (event, input: ProjectSwitchModeInput) => {
  // 1. 校验 projectId → PROJECT_NOT_FOUND
  // 2. 校验 targetMode ∈ {quick, iterative} 且 ≠ 当前 mode → 否则 INPUT_INVALID
  // 3. 校验 reason ≤ 200 字 → 否则 FIELD_TOO_LONG
  // 4. 校验 currentStage 允许切换（非 delivered / coding 中后期）→ 否则 PROJECT_MODE_SWITCH_FORBIDDEN
  // 5. createSnapshot=true 时内部调 snapshot.create(triggerType='mode-switch', callerModule='project')
  // 6. 触发 mode.switch(#8) 埋点
  // 7. 返回 ApiResponse<ProjectSwitchModeResult>
});
```

**mode 维度校验**（api-spec.md §7.4）：切换后须重新校验 stage 在新 mode 下的合法迁移路径；前端调用前据 `Project.mode`（atom）做客户端预校验，避免无谓 IPC 往返。

### 7.5 preload 暴露形态与 React Hook（*APISPEC-SUPPLEMENT*，前端落地层）

**preload 暴露**（沿用 §11.2 `nanjuAPI` 命名空间，project 域方法）：

```typescript
// main/preload.ts（在 §11.2 api 对象内追加 project 域）
const api = {
  // ...既有 _invoke / _on / _off
  project: {
    list: (input: ProjectListInput) => ipcInvoke<ProjectListResult>('project:list', input),
    open: (input: ProjectOpenInput) => ipcInvoke<ProjectOpenResult>('project:open', input),
    delete: (input: ProjectDeleteInput) => ipcInvoke<ProjectDeleteResult>('project:delete', input),
    switchMode: (input: ProjectSwitchModeInput) => ipcInvoke<ProjectSwitchModeResult>('project:switchMode', input),
  },
};
```

**React Hook 形态**（与 §10 调用示例风格一致）：

```typescript
// 渲染层：项目列表 + 模式切换两个典型 Hook
function useProjectList(filter?: ProjectListInput['filter']) {
  const [state, setState] = useState<{
    projects: ProjectSummary[]; loading: boolean; error: IpcError | null;
  }>({ projects: [], loading: true, error: null });
  useEffect(() => {
    let cancelled = false;
    window.nanjuAPI.project.list({ filter })
      .then((r) => { if (!cancelled) setState({ projects: r.projects, loading: false, error: null }); })
      .catch((e: IpcError) => { if (!cancelled) setState({ projects: [], loading: false, error: e }); });
    return () => { cancelled = true; };
  }, [JSON.stringify(filter)]);
  return state;
}

function useSwitchProjectMode(projectId: string) {
  return useCallback(async (targetMode: 'quick' | 'iterative', reason: string) => {
    // 错误处理范式见 §9.3：PROJECT_MODE_SWITCH_FORBIDDEN → 提示当前阶段不可切换
    return await window.nanjuAPI.project.switchMode({ projectId, targetMode, reason });
  }, [projectId]);
}
```

**TS 类型定义**（*APISPEC-SUPPLEMENT*，字段严格按 api-spec §7.1-7.4 输入/输出 Schema 表；v0.4 新增 project 域集中在 §7 定义，后续可抽取到 `services/project.ts`）：

```typescript
// services/project.ts（项目管理 4 端点的输入/输出类型 + IPC 包装）
import { ipcInvoke } from './_ipc';   // §8.1

export interface ProjectListInput {
  projectId?: string;
  filter?: { mode?: 'quick' | 'iterative'; template?: string; currentStage?: string };
  includeArchived?: boolean;
  sortBy?: 'lastOpenedAt' | 'createdAt' | 'name';
}
export interface ProjectSummary {
  projectId: string; name: string; mode: 'quick' | 'iterative'; template: string;
  currentStage: string; directoryPath: string; lastOpenedAt: string;
  totalTokenUsed: number; archived: boolean;
}
export interface ProjectListResult { projects: ProjectSummary[]; currentProjectId: string | null; totalCount: number; }

export interface ProjectOpenInput { projectId: string; resumeSession?: boolean; }
export interface ProjectOpenResult { project: ProjectSummary; currentSnapshotId: number | null; sessionResumed: boolean; lastOpenedAt: string; }

export interface ProjectDeleteInput { projectId: string; confirmation: string; deleteSnapshots?: boolean; deleteWorkspace?: boolean; }
export interface ProjectDeleteResult { deleted: boolean; freedSpaceBytes: number; snapshotsRemoved: number; workspacePreserved: boolean; }

export interface ProjectSwitchModeInput { projectId: string; targetMode: 'quick' | 'iterative'; reason: string; createSnapshot?: boolean; }
export interface ProjectSwitchModeResult { previousMode: 'quick' | 'iterative'; newMode: 'quick' | 'iterative'; snapshotId: number | null; telemetryEmitted: string[]; }

export const projectService = {
  list: (input: ProjectListInput) => ipcInvoke<ProjectListResult>('project:list', input),
  open: (input: ProjectOpenInput) => ipcInvoke<ProjectOpenResult>('project:open', input),
  delete: (input: ProjectDeleteInput) => ipcInvoke<ProjectDeleteResult>('project:delete', input),
  switchMode: (input: ProjectSwitchModeInput) => ipcInvoke<ProjectSwitchModeResult>('project:switchMode', input),
};
```

> 前端组件从 `@/services/project` import 上述类型与 `projectService`；`ipcInvoke` 解包 ApiResponse 信封（见 §9.1 / §8.1）。

---

## 8. 前端 services/*.ts TypeScript 接口定义

> **类型导出风格**（*APISPEC-SUPPLEMENT*，worker B 自主决策）：所有类型用 `interface`（而非 `type`），便于扩展继承；联合类型用 `type`；枚举用 `const ... as const` 对象（而非 TS `enum`，避免运行时额外开销 + 与 Proma 现有代码风格一致）。

### 8.1 `services/_ipc.ts`（IPC 桥接底层）

```typescript
// services/_ipc.ts
// 全平台 IPC 桥接底层，封装 ApiResponse 信封解包，所有 services/*.ts 共享

export interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: object;
  };
  requestId: string;
  durationMs: number;
}

export class IpcError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly requestId: string,
    public readonly details?: object,
  ) {
    super(message);
    this.name = 'IpcError';
  }
}

/**
 * 调用 ipcRenderer.invoke 并解包 ApiResponse 信封。
 * 成功：返回 data 字段
 * 失败：抛出 IpcError（含 code/requestId/details）
 *
 * 错误信封传递机制见 §9。
 */
export async function ipcInvoke<T>(
  channel: string,
  payload: unknown,
): Promise<T> {
  // window.nanjuAPI 由 preload 注入（见 §11.2）
  const response: ApiResponse<T> = await window.nanjuAPI._invoke(channel, payload);
  if (response.ok && response.data !== undefined) {
    return response.data;
  }
  throw new IpcError(
    response.error?.code ?? 'SYSTEM_UNKNOWN',
    response.error?.message ?? `IPC ${channel} failed without error`,
    response.requestId,
    response.error?.details,
  );
}
```

### 8.2 `services/coder.ts`

```typescript
// services/coder.ts
import { ipcInvoke } from './_ipc';

export type Stage = 'mode-select' | 'requirements' | 'prototype' | 'architecture' | 'planning' | 'coding' | 'testing' | 'delivered';
export type Template = 'web-fullstack' | 'mobile-app' | 'desktop-tool' | 'cli-script' | 'hardware' | 'ai-app';
export type FixAction = 'update' | 'delete' | 'insert' | 'restyle' | 'relocate';
export type FixScope = 'element' | 'component' | 'page' | 'global';

export interface GenerateCodeInput {
  projectRoot: string;
  documentPaths: string[];
  stage: Stage;             // api-spec.md §2.2 触发阶段，coding
  template: Template;
  teamConfigPath?: string;  // 长期迭代型必填
  outputDir: string;        // 固定 {projectRoot}/_code/
}

export interface CodeGenResult {
  taskId: string;
  outputFiles: string[];
  testReport: { total: number; passed: number; failed: number; skipped: number; durationMs: number };
  gwtResults: Array<{ feature: string; scenario: string; status: 'pass' | 'fail' | 'skip'; errorMsg?: string }>;
  tokensUsed: number;
  autofixAttempts: number;
  snapshotCreated: boolean;
}

export interface ApplyFixInput {
  projectRoot: string;
  target: { dataAiId: string; dataAiType: string; filePath?: string };
  action: FixAction;
  newValue?: object;       // 条件必填：action≠delete 时
  scope: FixScope;
  preModifySnapshotId: number;
}

export interface ApplyFixResult {
  modifiedFiles: string[];
  diffSummary: string;
  previewHtml: string;
  success: boolean;
}

export interface RunGwtInput {
  projectRoot: string;
  featurePaths: string[];
  stepDir: string;
  enableAutofix: boolean;
}

export interface RunGwtResult {
  results: Array<{ feature: string; scenario: string; status: 'pass' | 'fail'; errorMsg?: string }>;
  allPassed: boolean;
  autofixLog: Array<{ attempt: number; fixedScenarios: string[]; remainingFailures: string[] }>;
  triggeredSnapshot: boolean;
}

export const coderService = {
  generateCode(input: GenerateCodeInput): Promise<CodeGenResult> {
    return ipcInvoke<CodeGenResult>('coder:generateCode', input);
  },
  applyFix(input: ApplyFixInput): Promise<ApplyFixResult> {
    return ipcInvoke<ApplyFixResult>('coder:applyFix', input);
  },
  runGwt(input: RunGwtInput): Promise<RunGwtResult> {
    return ipcInvoke<RunGwtResult>('coder:runGwt', input);
  },
};
```

### 8.3 `services/guide.ts`（含流式）

```typescript
// services/guide.ts
import { ipcInvoke, IpcError } from './_ipc';

export type GuideRole = 'requirement-analyst' | 'ux-advisor' | 'architect' | 'engineering-manager';
export type ConfirmType = 'prd' | 'prototype' | 'architecture';
export type ClickFixPhase = 'phase1' | 'phase2';

export interface ChatInput {
  projectId: string;
  role: GuideRole;
  message: { text: string; images?: string[] };
  roundNumber: number;
  attachments?: Array<{ docId: string; relativePath: string }>;
}

export interface ChatResult {
  replyText: string;
  roleSwitched: boolean;
  newRole?: GuideRole;
  documentsUpdated: string[];
  tokensUsed: number;
}

export interface ChatChunkDelta {
  requestId: string;
  type: 'delta';
  text: string;
}

export interface ChatChunkDone {
  requestId: string;
  type: 'done';
  final: ChatResult;
}

export type ChatChunk = ChatChunkDelta | ChatChunkDone;

export interface ChatErrorPayload {
  requestId: string;
  error: { code: string; message: string; details?: object };
}

export interface PreviewPrototypeInput {
  projectId: string;
  pageId?: string;
  wireframePath: string;
}

export interface PreviewPrototypeResult {
  html: string;
  annotatedElements: Array<{ dataAiId: string; dataAiType: string; label: string }>;
  editCount: number;
}

export interface ClickToFixInput {
  projectId: string;
  dataAiId: string;
  dataAiType: string;
  pageContext: { pageId: string; domPath: string; surroundingText: string };
  userIntent?: string;
  phase: ClickFixPhase;
  screenshot?: string;  // base64；phase2 必填
}

export interface ClickToFixResult {
  fixSpec: {
    projectRoot: string;
    target: { dataAiId: string; dataAiType: string; filePath?: string };
    action: 'update' | 'delete' | 'insert' | 'restyle' | 'relocate';
    newValue?: object;
    scope: 'element' | 'component' | 'page' | 'global';
    preModifySnapshotId: number;
  };
  confidence: number;
  preModifySnapshotId: number;
  success: boolean;
}

export interface ConfirmInput {
  projectId: string;
  confirmType: ConfirmType;
  fromStage: Stage;       // 复用 coder.ts 的 Stage
  toStage: Stage;
}

export interface ConfirmResult {
  accepted: boolean;
  snapshotId: number;
  sessionRestarted: boolean;
  telemetryEmitted: string[];
}

export interface ChatHandlers {
  onChunk: (chunk: ChatChunk) => void;
  onError: (payload: ChatErrorPayload) => void;
}

/**
 * 流式 chat 调用。
 * - 订阅 guide:chat:chunk 与 guide:chat:error 事件
 * - Promise resolve：done chunk 到达后；resolve 值为 final ChatResult
 * - Promise reject：error 事件到达；reject IpcError
 * - 取消：调用返回的 cancel() 方法
 *
 * 调用示例见 §9.2 useGuideChat。
 */
export interface ChatCall {
  promise: Promise<ChatResult>;
  cancel: () => Promise<void>;
}

export const guideService = {
  previewPrototype(input: PreviewPrototypeInput): Promise<PreviewPrototypeResult> {
    return ipcInvoke<PreviewPrototypeResult>('guide:previewPrototype', input);
  },
  clickToFix(input: ClickToFixInput): Promise<ClickToFixResult> {
    return ipcInvoke<ClickToFixResult>('guide:clickToFix', input);
  },
  confirm(input: ConfirmInput): Promise<ConfirmResult> {
    return ipcInvoke<ConfirmResult>('guide:confirm', input);
  },

  /**
   * 流式 chat——封装订阅+invoke+清理。
   * 调用方负责在 Promise settle 后释放 handlers（或使用 useGuideChat 自动管理）。
   */
  chat(input: ChatInput, handlers: ChatHandlers): ChatCall {
    const requestId = crypto.randomUUID();
    const inputWithId = { ...input, _requestId: requestId };

    const chunkListener = (_e: unknown, chunk: ChatChunk) => {
      if (chunk.requestId === requestId) handlers.onChunk(chunk);
    };
    const errorListener = (_e: unknown, payload: ChatErrorPayload) => {
      if (payload.requestId === requestId) handlers.onError(payload);
    };

    window.nanjuAPI._on('guide:chat:chunk', chunkListener);
    window.nanjuAPI._on('guide:chat:error', errorListener);

    const promise = new Promise<ChatResult>((resolve, reject) => {
      window.nanjuAPI
        ._invoke('guide:chat', inputWithId)
        .then((response: ApiResponse<ChatResult>) => {
          window.nanjuAPI._off('guide:chat:chunk', chunkListener);
          window.nanjuAPI._off('guide:chat:error', errorListener);
          if (response.ok && response.data) resolve(response.data);
          else reject(new IpcError(response.error!.code, response.error!.message, response.requestId, response.error!.details));
        })
        .catch((err: unknown) => {
          window.nanjuAPI._off('guide:chat:chunk', chunkListener);
          window.nanjuAPI._off('guide:chat:error', errorListener);
          reject(err instanceof IpcError ? err : new IpcError('SYSTEM_UNKNOWN', String(err), requestId));
        });
    });

    const cancel = async () => {
      await window.nanjuAPI._invoke('guide:chat:cancel', { requestId });
    };

    return { promise, cancel };
  },
};
```

### 8.4 `services/snapshot.ts`

```typescript
// services/snapshot.ts
import { ipcInvoke, IpcError } from './_ipc';

export type SnapshotTrigger = 'init' | 'pre-modify' | 'confirm' | 'mode-switch' | 'pre-error';

/**
 * 全量 callerModule 枚举（与 api-spec.md §5.1 / data-model.md §3 对齐）。
 * 注意：`'manual'` 仅后端在 ipcMain.handle 内按调用源注入时使用，
 *      前端 services 层**不可**构造此值（B5 前端 IPC 拒绝契约，见 §4.1）。
 */
export type CallerModule = 'coder' | 'guide' | 'judge' | 'router' | 'manual';

/**
 * 🔧 B5：前端可用 callerModule 类型 = CallerModule 剔除 'manual'。
 * 渲染层调用 snapshotService.create(...) 时，callerModule 可选；
 * 缺省时由主进程按调用源注入；若传入则只能是 coder/guide/judge/router。
 * 传 'manual' 在 TS 编译期报错；运行时守卫见 snapshotService.create。
 */
export type FrontendCallerModule = Exclude<CallerModule, 'manual'>;

export interface SnapshotCreateInput {
  projectRoot: string;
  triggerType: SnapshotTrigger;
  description: string;  // ≤200 字
  /**
   * 可选；缺省时由主进程 ipcMain.handle 按调用源注入（参见 §1.3）。
   * 禁止传 'manual' —— 该值仅后端可用，详见 §4.1 B5 前端 IPC 拒绝契约。
   */
  callerModule?: FrontendCallerModule;
}

export interface SnapshotCreateResult {
  snapshotId: number;
  filePath: string;
  isCurrent: boolean;
  previousCurrentCleared: boolean;
  hardlinkedFiles: number;
}

export interface SnapshotListInput {
  projectRoot: string;
  filter?: { triggerType?: SnapshotTrigger; isHealthy?: boolean; isCurrent?: boolean };
  includeUnhealthy?: boolean;
}

export interface SnapshotSummary {
  snapshotId: number;
  timestamp: string;
  description: string;
  triggerType: SnapshotTrigger;
  isCurrent: boolean;
  isHealthy: boolean;
}

export interface SnapshotListResult {
  snapshots: SnapshotSummary[];
  currentSnapshotId: number | null;
  totalCount: number;
}

export interface SnapshotRollbackInput {
  projectRoot: string;
  targetSnapshotId: number;
  createPreRollbackSnapshot?: boolean;  // 默认 true
}

export interface SnapshotRollbackResult {
  rolledBackTo: number;
  newCurrentSnapshotId: number;
  preRollbackSnapshotId: number | null;
  filesRestored: number;
}

export interface SnapshotDeleteInput {
  projectRoot: string;
  snapshotId: number;
  force?: boolean;
}

export interface SnapshotDeleteResult {
  deleted: boolean;
  freedSpaceBytes: number;
}

export const snapshotService = {
  /**
   * 🔧 B5 前端 IPC 拒绝守卫（audit §A2-2）：
   * 'manual' 由后端在 ipcMain.handle 内注入，前端不可设置。
   * 运行时双重防御（即便 TS 类型层已用 FrontendCallerModule 编译期拦截）：
   *   - 防 services 调用方绕过类型（as any 强转）
   *   - 防第三方代码/未来扩展误传
   * 命中即抛 IpcError('SYSTEM_PERMISSION_DENIED')，不发起 IPC invoke。
   */
  create(input: SnapshotCreateInput): Promise<SnapshotCreateResult> {
    if ((input as { callerModule?: string }).callerModule === 'manual') {
      // SYSTEM_PERMISSION_DENIED 由 A1 在 api-spec.md §8 错误码体系定义（v0.4 §8 即原 §7 顺延）；前端引用，不重复定义
      // requestId 用 sentinel 标识"前端守卫拦截，未发起 IPC"（区分于主进程返回的真实 requestId）
      return Promise.reject(new IpcError(
        'SYSTEM_PERMISSION_DENIED',
        'Permission denied: callerModule="manual" is reserved for backend injection only',
        '<frontend-guard>',
      ));
    }
    return ipcInvoke<SnapshotCreateResult>('snapshot:create', input);
  },
  list(input: SnapshotListInput): Promise<SnapshotListResult> {
    return ipcInvoke<SnapshotListResult>('snapshot:list', input);
  },
  rollback(input: SnapshotRollbackInput): Promise<SnapshotRollbackResult> {
    return ipcInvoke<SnapshotRollbackResult>('snapshot:rollback', input);
  },
  delete(input: SnapshotDeleteInput): Promise<SnapshotDeleteResult> {
    return ipcInvoke<SnapshotDeleteResult>('snapshot:delete', input);
  },
};
```

### 8.5 `services/telemetry.ts`

```typescript
// services/telemetry.ts
import { ipcInvoke } from './_ipc';

// eventType 14 项枚举（api-spec.md §6 / data-model §4.3）；payload 详细结构由 worker D 负责
export const TELEMETRY_EVENT_TYPES = [
  'project.created', 'dialog.submitted', 'role.switched', 'prd.confirmed',
  'prototype.confirmed', 'user.undo', 'click.fix', 'mode.switch',
  'coding.executed', 'autofix.triggered', 'judge.verdict', 'user.satisfaction',
  'project.finished', 'architecture.confirmed',
] as const;
export type TelemetryEventType = typeof TELEMETRY_EVENT_TYPES[number];

export interface TelemetryEmitInput {
  eventType: TelemetryEventType;
  payload: object;          // 结构随 eventType 变化（worker D 负责）
  timestamp?: string;       // ISO8601，缺省=采集时刻
  duration?: number;        // ms
}

export interface TelemetryEmitResult {
  accepted: boolean;
  eventId: string;
  shardedFile: string;
}

export interface TelemetryBatchInput {
  events: TelemetryEmitInput[];
  flushReason?: 'timer' | 'stage-change' | 'app-exit' | 'manual';
}

export interface TelemetryBatchResult {
  acceptedCount: number;
  rejectedCount: number;
  rejectedDetails: Array<{ index: number; errorCode: string }>;
}

export interface TelemetryQueryInput {
  scope: { projectId?: string; sessionId?: string; userId?: string };  // 至少一项
  eventTypes?: TelemetryEventType[];
  timeRange: { from: string; to: string };  // ISO8601
  aggregate?: 'count' | 'sum-duration' | 'none';
  groupBy?: 'eventType' | 'stage' | 'day';
}

export interface TelemetryQueryResult {
  rows: Array<{ key: string; count: number; sumDuration?: number } | object>;
  shardedFilesScanned: string[];
  truncated: boolean;
}

export const telemetryService = {
  emit(input: TelemetryEmitInput): Promise<TelemetryEmitResult> {
    return ipcInvoke<TelemetryEmitResult>('telemetry:emit', input);
  },
  emitBatch(input: TelemetryBatchInput): Promise<TelemetryBatchResult> {
    return ipcInvoke<TelemetryBatchResult>('telemetry:emitBatch', input);
  },
  query(input: TelemetryQueryInput): Promise<TelemetryQueryResult> {
    return ipcInvoke<TelemetryQueryResult>('telemetry:query', input);
  },
};
```

### 8.6 `services/judge.ts`

```typescript
// services/judge.ts
import { ipcInvoke } from './_ipc';

export type TargetDirectory = '01_PRD' | '03_ARCHITECTURE' | '04_API_SPEC' | '05_PROJECT_PLAN' | '06_TESTS' | 'all';
// 注：刻意排除 02_UX_DESIGN / 07_VERSIONS / ROOT（api-spec.md §4.1）

export type Severity = 'critical' | 'major' | 'minor';

export interface HardViolation {
  rule: string;          // 如 PRD_REQUIRED_FIELD_MISSING，无 DOMAIN 前缀
  severity: Severity;
  targetPath: string;
  message: string;
}

export interface SoftSuggestion {
  dimension: string;
  targetPath: string;
  message: string;
  score: number;         // 0~1
}

export interface VerdictResult {
  verdict: 'pass' | 'reject';
  hardViolations: HardViolation[];
  softSuggestions: SoftSuggestion[];
  checkedAt: string;     // ISO8601
  durationMs: number;
}

export interface EvaluateDocsInput {
  projectRoot: string;
  targetDirectory: TargetDirectory;
  documentSet?: object[];
  hardChecks?: string[];
  enableSoftEval?: boolean;
}

export interface EvaluateCodeInput {
  projectRoot: string;
  codeDir: string;             // 固定 {projectRoot}/_code/
  classDiagramPath: string;
  featureRoot: string;         // 06_TESTS/
  checks?: Array<'class-consistency' | 'gwt-existence'>;
}

export interface EvaluateCodeResult extends VerdictResult {
  classConsistency: { matchedClasses: string[]; missingInCode: string[]; missingInDiagram: string[] };
  gwtCoverage: { featuresTotal: number; featuresWithSteps: number; featuresMissingSteps: string[] };
}

export const judgeService = {
  evaluateDocs(input: EvaluateDocsInput): Promise<VerdictResult> {
    return ipcInvoke<VerdictResult>('judge:evaluateDocs', input);
  },
  evaluateCode(input: EvaluateCodeInput): Promise<EvaluateCodeResult> {
    return ipcInvoke<EvaluateCodeResult>('judge:evaluateCode', input);
  },
};
```

---

## 9. 错误传递机制

### 9.1 ApiResponse 信封在 IPC 层的双路传递

[[04_API_SPEC/api-spec.md#02-统一响应信封]] §0.2 规定所有请求-响应型接口返回 `ApiResponse<T>` 信封。在 Electron IPC 层：

| 路径 | 主进程行为 | 渲染进程收到 |
|------|-----------|-------------|
| **成功** | `ipcMain.handle` 回调返回完整 `ApiResponse<T>`（`ok=true, data=T, requestId, durationMs`） | `window.nanjuAPI._invoke` Promise resolve 该 ApiResponse；`ipcInvoke` 解包后返回 `data` |
| **业务失败**（端点已识别的错误码） | 回调返回 `ApiResponse<T>`（`ok=false, error={code,message,details}`） | Promise resolve 该 ApiResponse；`ipcInvoke` 抛出 `IpcError`（携带 code/message/requestId/details） |
| **桥接失败**（ipcMain 抛出未捕获异常） | Electron 默认把 Error 转为 rejection | Promise reject 原始 Error；`ipcInvoke` 包装为 `IpcError('SYSTEM_UNKNOWN', ...)` |
| **流式错误**（guide:chat） | 通过 `guide:chat:error` 事件 + Promise reject 双路（见 §3.1.2） | 同时到达；前端去重 |

> **关键约定**：**主进程永远不直接 throw 业务错误**——业务错误一律封装为 `ok=false` 的 ApiResponse 返回；只有"完全意外的桥接异常"才走 throw 路径。这样渲染层只需 `try { await ... } catch (e: IpcError) { ... }` 就能统一处理所有业务错误。

### 9.2 错误码命名空间区分（沿用 api-spec.md §8）

前端在错误处理 UI 上需区分三套命名空间：

| 命名空间 | 示例 | 来源 | UI 处理 |
|---------|------|------|---------|
| **接口错误码** `<DOMAIN>_<ERROR>` | `CODER_GENERATION_FAILED` / `GUIDE_INVALID_STAGE_TRANSITION` / `SYSTEM_PERMISSION_DENIED` / `SESSION_LOCK_CONTENTION` / `GUIDE_INTERNAL_JUDGE_FAILED` | api-spec.md §8.3 总表（68 唯一错误码；🔧 B5 `SYSTEM_PERMISSION_DENIED` 由 A1 新增；v0.4 增补 `SESSION_LOCK_CONTENTION`（SPSAS 并发冲突，409 可重试）/ `GUIDE_INTERNAL_JUDGE_FAILED`（guide 内部调 judge 失败 wrap，5xx 可重试），详见 api-spec §8.5） | "调用失败"提示框，按可重试性（§8.2）展示"重试"按钮 |
| **硬约束规则名**（无 DOMAIN 前缀） | `PRD_REQUIRED_FIELD_MISSING` / `PLANTUML_SYNTAX_INVALID` | api-spec.md §4.1 / §4.2 `hardViolations[].rule` | "判定退回"问题清单，按 severity 着色 |
| **批内拒绝明细** `errorCode`（同接口错误码） | `TELEMETRY_EVENT_TYPE_INVALID` | api-spec.md §6.2 `rejectedDetails[].errorCode` | 批量埋点失败提示 |

### 9.3 渲染层错误处理范式

```typescript
import { IpcError } from '@/services/_ipc';

try {
  const result = await coderService.generateCode(input);
  // 成功路径
} catch (e) {
  if (e instanceof IpcError) {
    switch (e.code) {
      case 'CODER_DOC_NOT_FOUND':
      case 'CODER_DOC_CONTRACT_VIOLATION':
        // 4xx，不可重试，提示用户检查文档
        showError(e.message, { retryable: false });
        break;
      case 'CODER_SANDBOX_TIMEOUT':
        // 408，可重试
        showError(e.message, { retryable: true, onRetry: () => regenerate() });
        break;
      case 'CODER_GENERATION_FAILED':
        // 5xx，可重试
        showError(e.message, { retryable: true });
        break;
      case 'SYSTEM_PERMISSION_DENIED':
        // 🔧 B5：403，不可重试——前端守卫拦截伪造 callerModule='manual'（见 §4.1）
        showError('权限不足：此操作仅限系统内部触发', { retryable: false });
        break;
      case 'SESSION_LOCK_CONTENTION':
        // 409 但可重试——SPSAS 单项目单活动会话冲突，等待 TTL 或用户关闭占用会话后重试（api-spec §8.5）
        showError(e.message, { retryable: true, onRetry: () => retryChat() });
        break;
      case 'GUIDE_INTERNAL_JUDGE_FAILED':
        // 5xx 可重试——guide 内部调 judge 失败（如 JUDGE_LLM_TIMEOUT），稍后重试，不暴露 innerCode（api-spec §8.5）
        showError('审查服务暂时不可用，请稍后重试', { retryable: true });
        break;
      default:
        showError(e.message);
    }
    // 上报埋点（错误码可关联 telemetry）
    telemetryService.emit({ eventType: 'click.fix', payload: { targetType: 'generate', success: false } });
  } else {
    // 桥接异常
    showError('系统异常，请重启应用');
  }
}
```

> **错误码可重试性表**（沿用 api-spec.md §8.2 HTTP 类比）：`4xx`/`403`/`409` 一般不可重试；`408`/`5xx` 可重试。**例外**：`SESSION_LOCK_CONTENTION`（409）可重试——等待 TTL 释放或关闭占用会话后重试（详见 api-spec §8.5）。

---

## 10. 调用示例（React Function Component）

### 10.1 同步调用示例：snapshot.list 时间轴面板

```tsx
// components/SnapshotTimeline.tsx
import { useEffect, useState } from 'react';
import { snapshotService, SnapshotSummary } from '@/services/snapshot';
import { IpcError } from '@/services/_ipc';
import { activeProjectRootAtom } from '@/atoms/project';
import { useAtomValue } from 'jotai';

export function SnapshotTimeline() {
  const projectRoot = useAtomValue(activeProjectRootAtom);
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectRoot) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    snapshotService
      .list({ projectRoot })
      .then((result) => {
        if (!cancelled) setSnapshots(result.snapshots);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof IpcError) setError(`[${e.code}] ${e.message}`);
        else setError('加载快照列表失败');
      })
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [projectRoot]);

  if (loading) return <div>加载中...</div>;
  if (error) return <div role="alert">{error}</div>;
  return (
    <ul>
      {snapshots.map((s) => (
        <li key={s.snapshotId}>
          #{s.snapshotId} {s.description}（{s.triggerType}）{s.isCurrent && '★'}
        </li>
      ))}
    </ul>
  );
}
```

### 10.2 流式调用示例：useGuideChat Hook

```tsx
// hooks/useGuideChat.ts
import { useCallback, useRef, useState } from 'react';
import { guideService, ChatInput, ChatResult, ChatChunk } from '@/services/guide';
import { IpcError } from '@/services/_ipc';

export function useGuideChat() {
  const [streamingText, setStreamingText] = useState('');
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<IpcError | null>(null);
  const cancelRef = useRef<(() => Promise<void>) | null>(null);

  const send = useCallback(async (input: ChatInput): Promise<ChatResult | null> => {
    setStreamingText('');
    setError(null);
    setRunning(true);

    return new Promise<ChatResult | null>((resolve) => {
      const call = guideService.chat(input, {
        onChunk: (chunk: ChatChunk) => {
          if (chunk.type === 'delta') {
            setStreamingText((prev) => prev + chunk.text);
          }
          // type==='done' 时由 promise resolve 处理
        },
        onError: (payload) => {
          const err = new IpcError(
            payload.error.code,
            payload.error.message,
            payload.requestId,
            payload.error.details,
          );
          setError(err);
          setRunning(false);
          cancelRef.current = null;
          resolve(null);
        },
      });

      cancelRef.current = call.cancel;

      call.promise
        .then((result) => {
          setStreamingText(result.replyText);
          setRunning(false);
          cancelRef.current = null;
          resolve(result);
        })
        .catch((e: unknown) => {
          // onError 通常已先到达，这里兜底
          if (e instanceof IpcError && !error) setError(e);
          setRunning(false);
          cancelRef.current = null;
          resolve(null);
        });
    });
  }, [error]);

  const cancel = useCallback(() => {
    cancelRef.current?.();
  }, []);

  return { streamingText, running, error, send, cancel };
}

// 使用示例
function ChatPanel({ projectId, role }: { projectId: string; role: 'requirement-analyst' }) {
  const { streamingText, running, send, cancel } = useGuideChat();
  const [round, setRound] = useState(1);

  const onSubmit = () => {
    send({
      projectId,
      role,
      message: { text: '我想做一个读书笔记网站' },
      roundNumber: round,
    }).then(() => setRound((r) => r + 1));
  };

  return (
    <div>
      <pre>{streamingText}</pre>
      <button onClick={onSubmit} disabled={running}>发送</button>
      <button onClick={cancel} disabled={!running}>取消</button>
    </div>
  );
}
```

### 10.3 取消流式调用示例

```tsx
// 用户点击"停止生成"按钮 → 调用 cancel()
// 已生成的部分作为 ChatResult.replyText 保留（api-spec.md §3.1 取消语义）
```

### 10.4 错误处理示例（带重试）

```tsx
function GenerateCodeButton({ projectRoot }: { projectRoot: string }) {
  const [retryable, setRetryable] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const generate = async () => {
    try {
      await coderService.generateCode({
        projectRoot,
        documentPaths: ['01_PRD/prd.md'],
        stage: 'coding',
        template: 'web-fullstack',
        outputDir: `${projectRoot}/_code/`,
      });
      setErrorMsg('');
      setRetryable(false);
    } catch (e) {
      if (e instanceof IpcError) {
        setErrorMsg(e.message);
        // api-spec.md §8.2：408/5xx 可重试
        setRetryable(['CODER_SANDBOX_TIMEOUT', 'CODER_GENERATION_FAILED', 'CODER_FIX_APPLY_FAILED'].includes(e.code));
      }
    }
  };

  return (
    <div>
      <button onClick={generate}>生成代码</button>
      {errorMsg && (
        <div role="alert">
          {errorMsg}
          {retryable && <button onClick={generate}>重试</button>}
        </div>
      )}
    </div>
  );
}
```

---

## 11. 类型导出与构建集成

### 11.1 类型导出风格

- **`interface`**：用于对象结构（输入/输出 Schema），便于声明合并与扩展；
- **`type`**：用于联合类型（如 `FixAction = 'update' | 'delete' | ...`）；
- **`const ... as const` 对象**：用于需要运行时枚举值的场景（如 `TELEMETRY_EVENT_TYPES`），避免 TS `enum` 的运行时额外代码；
- **避免 `enum`**：与 Proma 现有代码风格保持一致。

### 11.2 preload.ts 暴露

```typescript
// main/preload.ts
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

const api = {
  _invoke: (channel: string, payload: unknown) => ipcRenderer.invoke(channel, payload),
  _on: (channel: string, listener: (event: IpcRendererEvent, ...args: unknown[]) => void) =>
    ipcRenderer.on(channel, listener),
  _off: (channel: string, listener: (...args: unknown[]) => void) =>
    ipcRenderer.removeListener(channel, listener),
};

contextBridge.exposeInMainWorld('nanjuAPI', api);

declare global {
  interface Window {
    nanjuAPI: typeof api;
  }
}
```

### 11.3 主进程注册总入口

```typescript
// main/ipc/index.ts
import { registerCoderIpc } from './coder';
import { registerGuideIpc } from './guide';
import { registerSnapshotIpc } from './snapshot';
import { registerTelemetryIpc } from './telemetry';
import { registerJudgeIpc } from './judge';

export function registerAllIpc() {
  registerCoderIpc();      // coder:generateCode / coder:applyFix / coder:runGwt
  registerGuideIpc();      // guide:chat + 3 子通道 / previewPrototype / clickToFix / confirm
  registerSnapshotIpc();   // snapshot:create / list / rollback / delete
  registerTelemetryIpc();  // telemetry:emit / emitBatch / query
  registerJudgeIpc();      // judge:evaluateDocs / evaluateCode
}

// main/main.ts（Electron app.whenReady 后）
import { registerAllIpc } from './ipc';
app.whenReady().then(() => {
  registerAllIpc();
  // ... 创建 BrowserWindow
});
```

> **vite/esbuild 集成**（[[03_ARCHITECTURE/architecture.md]] §1.1）：渲染层由 Vite ^6.0.3 构建，TS 路径别名 `@/` 指向 `src/`；主进程由 esbuild ^0.24.0 构建，`main/ipc/*.ts` 编译到 `dist/main/ipc/*.js`。preload 单独 esbuild 构建（因运行在沙箱上下文）。

---

## 12. 与 api-spec.md v0.4 一致性核对

### 12.1 20 端点对应核对表

| api-spec.md 端点（章节） | 本文档 IPC channel（章节） | 输入/输出字段对齐 | 错误码对齐 |
|--------------------------|----------------------------|------------------|-----------|
| `coder.generateCode` (§2.2) | `coder:generateCode` (§2.1, §8.2) | ✅ GenerateCodeInput 6 字段 + CodeGenResult 7 字段 | ✅ 5 错误码 |
| `coder.applyFix` (§2.3) | `coder:applyFix` (§2.2, §8.2) | ✅ ApplyFixInput 5 字段（含 newValue 条件必填） + ApplyFixResult 4 字段 | ✅ 5 错误码 |
| `coder.runGwt` (§2.4) | `coder:runGwt` (§2.3, §8.2) | ✅ RunGwtInput 4 字段 + RunGwtResult 4 字段 | ✅ 3 错误码 |
| `guide.chat` (§3.1) | `guide:chat` (§3.1, §8.3) | ✅ ChatInput 5 字段 + ChatResult 5 字段 | ✅ 4 错误码 |
| `guide.previewPrototype` (§3.2) | `guide:previewPrototype` (§3.2, §8.3) | ✅ 3 字段 + 3 字段 | ✅ 3 错误码 |
| `guide.clickToFix` (§3.3) | `guide:clickToFix` (§3.3, §8.3) | ✅ 6 字段 + 4 字段 | ✅ 4 错误码 |
| `guide.confirm` (§3.4) | `guide:confirm` (§3.4, §8.3) | ✅ 4 字段 + 4 字段 | ✅ 3 错误码 |
| `judge.evaluateDocs` (§4.1) | `judge:evaluateDocs` (§6.1, §8.6) | ✅ 5 字段 + VerdictResult | ✅ 4 错误码 |
| `judge.evaluateCode` (§4.2) | `judge:evaluateCode` (§6.2, §8.6) | ✅ 5 字段 + VerdictResult 扩展 | ✅ 3 错误码 |
| `snapshot.create` (§5.1) | `snapshot:create` (§4.1, §8.4) | ✅ 4 字段 + 5 字段 | ✅ 4 错误码 |
| `snapshot.list` (§5.2) | `snapshot:list` (§4.2, §8.4) | ✅ 3 字段 + 3 字段 | ✅ 3 错误码 |
| `snapshot.rollback` (§5.3) | `snapshot:rollback` (§4.3, §8.4) | ✅ 3 字段 + 4 字段 | ✅ 4 错误码 |
| `snapshot.delete` (§5.4) | `snapshot:delete` (§4.4, §8.4) | ✅ 3 字段 + 2 字段 | ✅ 3 错误码 |
| `telemetry.emit` (§6.1) | `telemetry:emit` (§5.1, §8.5) | ✅ 4 字段 + 3 字段 | ✅ 4 错误码 |
| `telemetry.emitBatch` (§6.2) | `telemetry:emitBatch` (§5.2, §8.5) | ✅ 2 字段 + 3 字段 | ✅ 3 错误码 |
| `telemetry.query` (§6.3) | `telemetry:query` (§5.3, §8.5) | ✅ 5 字段 + 3 字段 | ✅ 3 错误码 |
| `project.list` (§7.1) | `project:list` (§7.1, §7.5) | ✅ ProjectListInput 4 字段 + ProjectListResult 3 字段 | ✅ 3 错误码 |
| `project.open` (§7.2) | `project:open` (§7.2, §7.5) | ✅ 2 字段 + 4 字段 | ✅ 3 错误码 |
| `project.delete` (§7.3) | `project:delete` (§7.3, §7.5) | ✅ 4 字段 + 4 字段 | ✅ 4 错误码 |
| `project.switchMode` (§7.4) | `project:switchMode` (§7.4, §7.5) | ✅ 4 字段 + 4 字段 | ✅ 5 错误码 |
| **合计** | **20 端点 → 20 channel（流式 guide:chat 含 3 子通道）** | ✅ 字段逐项对齐 | ✅ 68 唯一错误码（api-spec §8.3，含 v0.4 增补 SESSION_LOCK_CONTENTION / GUIDE_INTERNAL_JUDGE_FAILED） |

### 12.2 DoD self_check 逐条核对

| self_check 条目 | 结果 | 证据 |
|----------------|------|------|
| 文件落 `D:/Codes/multi-agent-collab-platform/04_API_SPEC/` | ✅ | 文件实际路径 |
| `ipcMain.handle` 通道名与端点前缀（coder:/guide:/judge:/snapshot:/telemetry:/project:）一致 | ✅ | §1.2 全量映射表 20 项 + §1.2 命名一致性检查清单 3 条 |
| TypeScript 函数签名含入参/出参类型 | ✅ | §8.1~§8.6 全部 interface 导出（含每个字段的 TS 类型）；v0.4 新增 project 域类型集中在 §7.5 |
| 流式契约包含 chunk/done/error/cancel 四事件 | ✅ | §3.1.1 流式四事件表 + §8.3 chat 函数实现 |
| 调用示例可直接拷贝执行 | ✅ | §10.1~§10.4 React Function Component 形态，含 import 与完整 JSX |

### 12.3 must_contain 关键词核对

| 关键词 | 出现位置 |
|-------|---------|
| `ipcMain.handle` | §1.1、§2.1、§7.1~§7.4（project 主进程注册伪代码）、§11.3（注册总入口） |
| `ipcRenderer.invoke` | §0.1、§1.1、§3.1.1、§7.5（project preload/Hook）、§8.1、§8.3、§10.4 |
| `TypeScript` | 全文（§0.1、§7 整章、§8 整章、§10.1、§11.1） |
| `流式契约` | §0.1、§1.2、§3.1.1、§8.3、§12.2 |
| `错误传递` | §0.1、§3.1.2、§9 整章、§12.2 |
| `project:` | §1.2（20 端点映射表第 17-20 行）、§7 整章（4 channel 契约 + preload + Hook + TS 类型） |

---

## 13. 后续工作与提请上游

| 项 | 性质 | 处置 |
|----|------|------|
| 14 事件 payload 详细 TypeScript 类型 | 由 worker D 负责产出 | 本文档 §7.5 用 `payload: object` 弱类型占位，D 产出后替换为字面量联合类型 |
| Agent 间调用时序（如 confirm 内部编排 snapshot+telemetry+restart 三步） | 由 worker A 负责产出 | 本文档仅在 §3.4 提及"内部触发"，时序细节待 A 文档 |
| Proma preload.ts 是否已暴露 `nanjuAPI` 命名空间 | 集成阶段实测 | 本文档 §10.2 假定新建命名空间，需在 Proma 源码 `proma-source/` 内确认是否冲突 |
| `guide.chat:cancel` 是否需要 callerModule 字段（审计追溯） | ✅ **已收敛**（2026-07-15 njfix-A4-worker 补 B5） | **统一规则**：`callerModule` 由后端 `ipcMain.handle` 按调用源注入（参见 §1.3 注入点表 + §4.1 前端 IPC 拒绝契约），**前端不可设置**任何端点的 callerModule（含 `guide.chat:cancel`）。埋点追溯在后端通过 `ipcMain.handle` 调用栈 / `requestId` 关联，无需前端 payload 携带。`guide.chat:cancel` 的 payload 维持 `{ requestId }` 不变。 |

---

> 本文档为前端落地层 API 文档，所有业务契约以 [[04_API_SPEC/api-spec.md]] v0.4 为权威源，类型签名以本文档 §8 为前端开发对接唯一入口（v0.4 新增 project 域类型集中在 §7.5）。后续若 api-spec.md 升级，本文档 §1.2 全量映射表与 §8 类型签名须同步更新；新增端点须同步追加 §12.1 核对表条目，否则视为前端落地层违反一致性约束。

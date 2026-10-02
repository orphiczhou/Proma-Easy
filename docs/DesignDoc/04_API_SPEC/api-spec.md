# 接口规范（API Specification）

> 项目：向导Agent与编程Agent多智能体协同开发平台
> 文档ID：DOC-4.1 | 版本：v0.4 | 日期：2026-07-15 | 状态：已评审（v0.4 补 project.* 端点族 + SYSTEM_PERMISSION_DENIED + 输入校验错误码族，闭环 audit B3/B5/B6；v0.3 同步 data-model v0.6 第 14 事件 `architecture.confirmed`，ISSUE-003 #3 闭环）
> 依赖：[[03_ARCHITECTURE/architecture.md]] v0.3（§1.2 零依赖、§2 模块输入/输出、§7 点选纠错、§8 模型-角色映射）、[[03_ARCHITECTURE/data-model.md]] v0.6（5 实体字段、14 事件类型、§2.2 状态转移）、[[01_PRD/prd.md]] v0.2（§7.3 点选纠错、§12.4 埋点，含第 14 事件）
> 一致性声明：本文档所有接口的输入/输出字段均与 [[03_ARCHITECTURE/architecture.md#2-模块划分]] 模块输入/输出逐条对齐，所有数据结构均映射 [[03_ARCHITECTURE/data-model.md]] 的 5 个实体（Project / Snapshot / TelemetryEvent / SessionContext / DocumentMeta）。上游文档留白处的补充定义（如 applyFix 的 action/scope 枚举）以 *APISPEC-SUPPLEMENT* 标记，待上游确认后回写。

---

## 0. 设计原则与通信范式

### 0.1 零依赖通信范式

本平台严格遵循 `[[03_ARCHITECTURE/architecture.md]] §1.2` 的**零依赖原则**：Agent 之间不使用 HTTP/REST、不引入消息队列、不依赖数据库。因此本规范中的"接口"包含两种落地形态：

| 形态 | 适用范围 | 调用方式 | 跨进程 |
|------|---------|---------|--------|
| **文件系统契约** | Agent↔Agent（向导↔编程↔裁判） | 约定目录路径 + 文档结构 + JSON 元数据 | 是（通过磁盘交换） |
| **进程内函数调用** | 前端 UI ↔ Service 层 | TypeScript 函数签名（经 Electron `ipcMain.handle` / `ipcRenderer.invoke` 桥接） | 否（同进程或 IPC） |

**说明**：本文档为每类接口同时给出「调用方式（含 IPC channel / 函数命名空间）」与「输入/输出 Schema」。在 MVP 阶段，所有调用均为本地函数调用，不涉及网络；接口名形如 `judge.evaluateDocs` 表示 `services/judge.ts` 模块导出的 `evaluateDocs` 函数，前端通过 `ipcRenderer.invoke('judge:evaluateDocs', payload)` 触发。

### 0.2 统一响应信封

除埋点上报（追加写入，fire-and-forget）外，所有**请求-响应型**接口统一返回如下信封：

```typescript
interface ApiResponse<T> {
  ok: boolean;              // 调用是否成功
  data?: T;                 // 成功时的业务数据
  error?: {
    code: string;           // 错误码，格式 <DOMAIN>_<ERROR>，详见 §8
    message: string;        // 面向人类的可读说明（中文）
    details?: object;       // 可选的诊断信息（如校验失败字段列表）
  };
  requestId: string;        // 请求追踪 ID（UUID v4），用于埋点关联
  durationMs: number;       // 服务端处理耗时，同步写入 telemetry.duration
}
```

### 0.3 通用请求头/上下文

所有调用隐式携带如下上下文（由 IPC 桥接层自动注入，无需业务层显式传参），对应 `data-model.md` 的 TelemetryEvent 公共字段：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| sessionId | string(UUID) | ✅ | 用户会话 ID，应用启动时创建 |
| projectId | string(UUID) | ❌ | 关联项目 ID；全局事件（如模式选择前）为 null |
| userId | string(hash) | ✅ | 脱敏用户标识 hash(username+deviceId) |
| stage | enum | ❌ | 事件发生时所在阶段，复用 `Project.currentStage` 枚举 |
| mode | enum | ❌ | 项目模式 `quick`（快消型）\| `iterative`（长期迭代型） |

> **projectRoot / projectId 使用规则**（*APISPEC-SUPPLEMENT*）：`projectId`（Project 实体主键）对 `telemetry.*` 由 §0.3 自动注入、对 `guide.*` 为显式入参；`coder.*`/`judge.*`/`snapshot.*` 端点使用 `projectRoot`（= [[03_ARCHITECTURE/data-model.md#2-实体一项目元数据project]] `Project.directoryPath` 绝对路径）作为沙箱边界入参，**不在自动注入范围**，须调用方显式传入。`guide.*` 端点内部若需 `projectRoot`，由服务层从 `projectId` 反查 `_meta.json#project.directoryPath` 解析（见 §3.3 fixSpec.projectRoot 来源），调用方无需提供。`project.*` 类6 端点统一以 `projectId` 作主键入参，内部由服务层解析 `projectRoot`。

### 0.4 manual callerModule 校验三要素（v0.4 补充，闭环 audit B5）

依据 [[03_ARCHITECTURE/data-model.md#3-实体二快照snapshot]] §3「自动触发；诊断面板例外」约束，部分端点（当前为 §5.1 `snapshot.create`）允许 `callerModule='manual'` 作为诊断面板/测试的例外口。但 `callerModule` 是调用方自报字段，用户态调用方可伪造为 `'manual'` 绕过"用户不可手动创建快照"约束（[[03_ARCHITECTURE/data-model.md#3-实体二快照snapshot]] §3.1 原文）。为此本规范定义 **SYSTEM 权限校验三要素**：

| 要素 | 内容 |
|------|------|
| **判定依据** | `callerModule==='manual'` 时，调用方须为 Proma 主进程内的 SYSTEM 级上下文（设置页诊断面板 / 测试运行器 / 自动化运维脚本），由 IPC 桥接层注入的 `systemContext.token` 校验。token 由 Proma 启动时生成、仅在主进程内传递，用户态渲染进程（renderer）不可见、不可伪造。校验流程：服务层接到 `callerModule='manual'` 调用 → 从 Electron `ipcMain.handle` 回调的 `event.sender.systemContext.token` 读取（`systemContext` 由主进程在 `app.whenReady()` 后挂到所有 BrowserWindow 的 webContents 上）→ 与主进程启动 token 比对 → 不匹配即判失败。 |
| **失败错误码** | `SYSTEM_PERMISSION_DENIED`（DOMAIN=SYSTEM，403，不可重试，详见 §8.3 总表） |
| **拒绝行为** | 立即返回错误，**不执行**业务逻辑（快照不创建 / 项目不删除），同时经 `telemetry.emit` 上报一条审计埋点（payload 含 `callerModule='manual'`、`success=false`、`reason='system_permission_denied'`），便于事后追溯伪造尝试。 |

> **适用范围**：本节校验适用于所有声明 `callerModule` 字段的端点（当前为 §5.1 `snapshot.create`）；§7.3 `project.delete` 虽无 `callerModule` 字段，但其破坏性等级与 manual 快照相当（删除工作区目录 + 快照），亦要求 Proma 主进程上下文调用，校验失败同样返回 `SYSTEM_PERMISSION_DENIED`。

> **与 [[03_ARCHITECTURE/data-model.md#3-实体二快照snapshot]] §3 的关系**：上游 §3 原表述「用户不可手动创建」未明确诊断面板的授权机制，本节为 *APISPEC-SUPPLEMENT* 补充定义；已提请 data-model §3 增「诊断面板例外 + SYSTEM 校验」表述（见 §10.5 升级项）。

---

## 1. 接口分类总览

本规范定义 6 类接口，覆盖平台全部跨模块交互。每类至少 2 个端点，共 20 个端点。

| 类别 | 接口前缀 | 端点数 | 对应架构模块（[[03_ARCHITECTURE/architecture.md]] §2） | 通信形态 |
|------|---------|--------|----------------------------------|---------|
| 类1 向导Agent↔编程Agent | `coder.*` | 3 | 编程Agent引擎（输入=文档体系目录路径 / 输出=可运行代码+测试报告） | 文件契约+函数 |
| 类2 前端↔向导Agent | `guide.*` | 4 | 前端UI层（输入=用户操作事件 / 输出=渲染结果+用户意图事件）+ 向导Agent引擎（输入=用户自然语言输入） | IPC+函数 |
| 类3 裁判Agent判定 | `judge.*` | 2 | 裁判引擎（输入=文档/代码目录路径 / 输出=通过/退回+问题清单） | 函数 |
| 类4 快照管理 | `snapshot.*` | 4 | 快照管理器（输入=项目目录路径+触发事件 / 输出=快照目录树） | 函数 |
| 类5 埋点上报 | `telemetry.*` | 3 | 埋点采集层（输入=type+payload+timestamp / 输出=JSONL日志） | 函数（异步非阻塞） |
| 类6 项目管理 | `project.*` | 4 | 项目元数据读写（Proma 平台层，输入=用户在项目列表/Tab 的操作 / 输出=项目摘要或变更结果） | IPC+函数 |

### 1.1 范围声明（覆盖边界与诚实化）

本规范定义上述 6 类共 20 个端点，覆盖 [[03_ARCHITECTURE/architecture.md#2-模块划分]] 8 模块中**有跨模块交互契约**的 6 类。下列模块/能力**不在本规范范围**，处置如下（避免读者误判"全覆盖"）：

| 不覆盖项 | 处置 | 理由 |
|---------|------|------|
| 对话路由层（router）Session Restart / Context Backfill 显式触发 | **不暴露独立端点**——由 §3.4 `guide.confirm` 内部编排：confirm 成功后服务层自动执行 [[03_ARCHITECTURE/architecture.md]] §5.2 六步（序列化上下文→释放会话→加载目标角色→注入摘要），结果经输出字段 `sessionRestarted` 透传 | router 是内部协调者，非前端直接交互对象；前端触发 confirm 即可 |
| 项目创建（new project wizard） | **归 Proma 平台层**——创建动作由 Proma 桌面壳层的 new project wizard 完成，写入 `_system/projects-index.json` 后通过 `project.created`(#1) 埋点上报；本规范不暴露 create 端点。**创建后的 list/open/delete/switchMode 四端点已在 v0.4 补齐**，见 §7 | Proma 已有项目新建向导（[[03_ARCHITECTURE/architecture.md]] §4.1），避免重复实现；create 涉及工作区挂载/模板拷贝/初始 _meta.json 写入等桌面壳层能力，非纯函数接口 |
| 分析看板高阶聚合（按 role/template 分布、满意度趋势） | `telemetry.query`（§6.3）提供基础扫描/聚合（count/sum-duration × eventType/stage/day）；role/template 二次聚合由前端对 `role.switched`/`project.created` payload 自行 reduce | role/template 在 payload 内非事件级公共维度，不宜强行进入 query.groupBy |
| `02_UX_DESIGN` / `07_VERSIONS` / `ROOT` 文档判定 | judge 硬约束 7 项不覆盖此三类，`judge.evaluateDocs` 的 targetDirectory 刻意排除（见 §4.1 注记） | UX 文档走人工评审、changelog/README 无结构化硬约束 |

> **诚实化声明**（*APISPEC-SCOPE*）：v0.1 §8.2 自检"5 类接口全覆盖"为过度承诺，v0.2 修正为"5 类核心交互模块覆盖；router/项目CRUD/看板高阶聚合按上表处置"。v0.4 进一步补齐项目管理的读/变更操作（`project.list` / `project.open` / `project.delete` / `project.switchMode` 四端点，见 §7），仅项目"创建"动作仍归 Proma 平台层。此为范围边界声明，非覆盖面缺失。

---

## 2. 类1：向导Agent ↔ 编程Agent 接口

**架构依据**（[[03_ARCHITECTURE/architecture.md]] §2「编程Agent引擎」）：
- 输入 = **文档体系目录路径**
- 输出 = **可运行的项目代码 + 测试报告**
- 关键实现 = 调用 GLM 5.1，子进程执行，自修复（3次），GWT 测试执行

### 2.1 文档结构约定（文件系统契约）

编程Agent通过读取向导Agent产出的标准化 7 目录结构获取全部上下文。该契约是所有类1接口的前置条件，对应 `[[03_ARCHITECTURE/data-model.md]] §6.3` 七目录标准清单：

```
{projectRoot}/                         # = workspace-files/{projectId}-{shortName}/
├── 01_PRD/            prd.md [, user-stories.md]
├── 02_UX_DESIGN/      wireframes/*.html [, sitemap.md, design-system.md, ...]
├── 03_ARCHITECTURE/   architecture.md, class-diagram.puml, data-model.md
├── 04_API_SPEC/       api-spec.md          ← 本文件
├── 05_PROJECT_PLAN/   sprint-plan.md, team-config.md, workflow.md
├── 06_TESTS/          features/*.feature, step-definitions/, test-plan.md
├── 07_VERSIONS/       changelog.md
├── _meta.json         # Project 元数据 + Snapshot[] 索引 + DocumentMeta[] 清单（见 [[03_ARCHITECTURE/data-model.md]] §8），编程Agent主要读 documents 段
└── _code/             # 编程Agent 输出区（生成/修改的代码）
```

**契约校验**：编程Agent启动前先读 `_meta.json#documents`，校验 `directory` 字段均落在 `01_PRD`~`07_VERSIONS` \| `ROOT` 枚举内（[[03_ARCHITECTURE/data-model.md]] §6.2），缺失则触发 `CODER_DOC_CONTRACT_VIOLATION`。

### 2.2 端点 1.1：`coder.generateCode`（文档→代码生成）

**动词/调用方式**：函数调用 `services/coder.ts#generateCode(input)`；IPC channel `coder:generateCode`。

**输入 Schema**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| projectRoot | string(绝对路径) | ✅ | 项目根目录，沙箱边界（[[03_ARCHITECTURE/architecture.md]] §6.1），等价 `Project.directoryPath` |
| documentPaths | string[] | ✅ | 作为输入的文档相对路径列表，来自 `_meta.json#documents[].relativePath` |
| stage | enum | ✅ | 触发阶段，取值 `coding`（首次生成） |
| template | enum | ✅ | 工程模板 `web-fullstack` \| `mobile-app` \| `desktop-tool` \| `cli-script` \| `hardware` \| `ai-app`，决定激活角色（[[03_ARCHITECTURE/architecture.md]] §10） |
| teamConfigPath | string | ❌ | `05_PROJECT_PLAN/team-config.md` 路径，长期迭代型必填 |
| outputDir | string | ✅ | 代码输出目录，固定为 `{projectRoot}/_code/` |

**输出 Schema**（`ApiResponse<CodeGenResult>`，`data` 字段）：

| 字段 | 类型 | 说明 |
|------|------|------|
| taskId | string(UUID) | 本次代码生成任务 ID |
| outputFiles | string[] | 生成文件的相对路径列表 |
| testReport | object | 测试报告 `{ total, passed, failed, skipped, durationMs }` |
| gwtResults | object[] | GWT 执行结果数组，每项 `{ feature, scenario, status, errorMsg? }`（字段名与 §2.4 `results` 统一） |
| tokensUsed | number | Token 消耗，累加至 `Project.totalTokenUsed` |
| autofixAttempts | number | 自修复触发次数（上限 3，[[03_ARCHITECTURE/architecture.md]] §2） |
| snapshotCreated | boolean | 是否已触发 `init` 快照（coder 生成成功后调用 `snapshot.create`） |

**错误情况**（≥3）：

| 错误码 | 触发条件 | HTTP 类比 |
|--------|---------|-----------|
| `CODER_DOC_NOT_FOUND` | `documentPaths` 中存在路径在磁盘上找不到 | 404 |
| `CODER_DOC_CONTRACT_VIOLATION` | `_meta.json` 缺失或 `directory` 字段越出枚举 | 422 |
| `CODER_GENERATION_FAILED` | GLM 5.1 调用失败且 3 次自修复未通过 | 500 |
| `CODER_SANDBOX_TIMEOUT` | 子进程超 3 分钟被 SIGKILL（[[03_ARCHITECTURE/architecture.md]] §6.2） | 408 |
| `CODER_GWT_COMPILE_ERROR` | `.feature` 文件语法错误，GWT 无法执行 | 422 |

### 2.3 端点 1.2：`coder.applyFix`（点选纠错执行）

**动词/调用方式**：函数调用 `services/coder.ts#applyFix(spec)`；IPC channel `coder:applyFix`。

**架构依据**：[[03_ARCHITECTURE/architecture.md]] §7 第 5~6 步——向导Agent生成修改规约 JSON，编程Agent据其修改代码后预览区刷新。

**输入 Schema**（修改规约 `{target, action, newValue, scope}`——字段名引自 [[03_ARCHITECTURE/architecture.md]] §7 第 5 步；**action 5 值与 scope 4 值为本规范补充定义** *APISPEC-SUPPLEMENT*，上游 §7 原文未列举取值）：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| projectRoot | string | ✅ | 项目根目录 |
| target | object | ✅ | 修改目标 `{ dataAiId, dataAiType, filePath? }`，`dataAiId` 来自原型 `data-ai-id` 属性 |
| action | enum | ✅ | `update` \| `delete` \| `insert` \| `restyle` \| `relocate` |
| newValue | object | ⚠️ | 条件必填：action∈{update,insert,restyle,relocate} 时必填；action=delete 时忽略。结构随 action 变化（如 restyle 时为 CSS 属性键值对） |
| scope | enum | ✅ | `element`（单元素）\| `component`（组件级）\| `page`（整页）\| `global`（全局主题） |
| preModifySnapshotId | number | ✅ | 调用前必须已存在的 `pre-modify` 快照 ID——由上游 guide.clickToFix 自动创建（见 §3.3），或调用方先调 `snapshot.create(triggerType=pre-modify)`；applyFix 本身不负责创建（强制前置） |

**`newValue` 子结构（按 action 取值，*APISPEC-SUPPLEMENT*）**：

| action | newValue 结构 | 说明 |
|--------|--------------|------|
| `update` | `{ attribute: string, value: string\|number\|boolean }` | 修改元素某属性（如文本内容、disabled） |
| `insert` | `{ newElement: { type: string, content: string }, position: 'before'\|'after'\|'append'\|'prepend', relativeTo?: dataAiId }` | 插入新元素，relativeTo 缺省按 position 语义定位 |
| `restyle` | `{ cssProps: object }` | CSS 属性键值对，如 `{ "color": "#fff", "font-size": "14px" }` |
| `relocate` | `{ newParent: dataAiId, position: 'before'\|'after'\|'append'\|'prepend' }` | 移动到新父节点下 |
| `delete` | （忽略） | action=delete 时 newValue 省略 |

**输出 Schema**：

| 字段 | 类型 | 说明 |
|------|------|------|
| modifiedFiles | string[] | 实际改动的文件相对路径 |
| diffSummary | string | 自然语言变更摘要，用于 `user.undo` 埋点的 `undoTarget` |
| previewHtml | string | 刷新后的预览 HTML（注入新的 `data-ai-id`） |
| success | boolean | 修改是否成功应用 |

**错误情况**：

| 错误码 | 触发条件 |
|--------|---------|
| `CODER_TARGET_NOT_FOUND` | `dataAiId` 在当前代码中无匹配元素 |
| `CODER_FIX_PRE_SNAPSHOT_MISSING` | `preModifySnapshotId` 未提供或不存在（违反强制前置） |
| `CODER_FIX_OUT_OF_SCOPE` | 修改范围超出沙箱边界（触及 `_code/` 外文件） |
| `CODER_FIX_APPLY_FAILED` | LLM 生成的代码补丁应用失败（语法错误/冲突） |
| `CODER_FIX_ACTION_INVALID` | `action` 不在 5 值枚举（update/delete/insert/restyle/relocate）内 |

### 2.4 端点 1.3：`coder.runGwt`（GWT 测试与自修复）

**动词/调用方式**：函数调用 `services/coder.ts#runGwt(input)`；IPC channel `coder:runGwt`。

**输入 Schema**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| projectRoot | string | ✅ | 项目根目录 |
| featurePaths | string[] | ✅ | `06_TESTS/features/*.feature` 路径列表 |
| stepDir | string | ✅ | `06_TESTS/step-definitions/` 路径 |
| enableAutofix | boolean | ✅ | 是否启用 3 次自修复，默认 true |

**输出 Schema**：

| 字段 | 类型 | 说明 |
|------|------|------|
| results | object[] | 每个 scenario 的执行结果 `{ feature, scenario, status, errorMsg? }` |
| allPassed | boolean | 是否全部通过 |
| autofixLog | object[] | 自修复记录 `{ attempt, fixedScenarios, remainingFailures }` |
| triggeredSnapshot | boolean | 是否因失败触发 `pre-error` 快照 |

**错误情况**：

| 错误码 | 触发条件 |
|--------|---------|
| `CODER_GWT_RUNNER_ERROR` | Agent 原生 GWT 执行器异常 |
| `CODER_AUTOFIX_EXHAUSTED` | 3 次自修复后仍有失败 |
| `CODER_FEATURE_NOT_FOUND` | `featurePaths` 中文件不存在 |

---

## 3. 类2：前端 ↔ 向导Agent 接口

**架构依据**：
- 前端UI层（[[03_ARCHITECTURE/architecture.md]] §2）：输入 = **用户操作事件**，输出 = **渲染结果 + 用户意图事件**
- 向导Agent引擎（[[03_ARCHITECTURE/architecture.md]] §2）：输入 = **用户自然语言输入 + PRD/UX 文档**，输出 = **完整文档体系(01~07目录)**

### 3.1 端点 2.1：`guide.chat`（用户输入 → Agent 回复，流式）

**动词/调用方式**：函数调用 `services/guide.ts#chat(input)`；IPC channel `guide:chat`，返回值为 AsyncIterable（流式 token），前端通过 `ipcRenderer.on('guide:chat:chunk')` 接收增量。

**输入 Schema**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| projectId | string(UUID) | ✅ | 项目 ID |
| role | enum | ✅ | 当前角色 `requirement-analyst` \| `ux-advisor` \| `architect` \| `engineering-manager`（[[03_ARCHITECTURE/data-model.md]] §5.3） |
| message | object | ✅ | 用户消息 `{ text: string, images?: string[] }` |
| roundNumber | number | ✅ | 当前对话轮次，用于 `dialog.submitted` 埋点 |
| attachments | object[] | ❌ | 附加文档引用 `{ docId, relativePath }` |

**输出 Schema**（流式，最终聚合）：

| 字段 | 类型 | 说明 |
|------|------|------|
| replyText | string | Agent 完整回复文本 |
| roleSwitched | boolean | 本轮是否触发角色切换（→ 触发 `role.switched` 埋点 + Session Restart） |
| newRole | enum? | 切换后的目标角色（roleSwitched=true 时必填） |
| documentsUpdated | string[] | 本轮新增/修改的文档相对路径 |
| tokensUsed | number | Token 消耗 |

**流式契约**（*APISPEC-SUPPLEMENT*，前端对接依据）：
- **chunk 事件**：每个 token 增量经 `ipcRenderer.on('guide:chat:chunk', (e, chunk) => ...)` 接收，`chunk = { type: 'delta', text: string }`。
- **结束信号**：最后一个 chunk `type: 'done'`，其 `chunk.final` 携带完整聚合结果（即上方输出 Schema 全部字段：replyText/roleSwitched/newRole/documentsUpdated/tokensUsed）；此时 `ipcRenderer.invoke('guide:chat')` 的 Promise resolve。
- **错误传达**：流中错误经独立 `ipcRenderer.on('guide:chat:error', ...)` 事件发送，payload 形如 §0.2 `error`（含 code/message/requestId），Promise reject 同一 error；已发送 chunk 不回收。
- **取消**：前端 `ipcRenderer.invoke('guide:chat:cancel', { requestId })` 中断生成，已生成部分作为 replyText 返回。

**错误情况**：

| 错误码 | 触发条件 |
|--------|---------|
| `GUIDE_PROJECT_NOT_FOUND` | `projectId` 不存在于 `projects-index.json` |
| `GUIDE_ROLE_INVALID` | `role` 不在 4 角色枚举内 |
| `GUIDE_MODEL_UNAVAILABLE` | 角色对应模型（如 MiniMax 2.7）API 调用失败 |
| `GUIDE_CONTEXT_BACKFILL_FAILED` | Session Restart 时读取 `sessions/{projectId}.json` 失败 |

### 3.2 端点 2.2：`guide.previewPrototype`（原型预览）

**动词/调用方式**：函数调用 `services/guide.ts#previewPrototype(input)`；IPC channel `guide:previewPrototype`。

**输入 Schema**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| projectId | string(UUID) | ✅ | 项目 ID |
| pageId | string | ❌ | 指定页面 ID；缺省返回首页 sitemap 根节点 |
| wireframePath | string | ✅ | `02_UX_DESIGN/wireframes/*.html` 路径 |

**输出 Schema**：

| 字段 | 类型 | 说明 |
|------|------|------|
| html | string | 注入了 `data-ai-id` / `data-ai-type` 的预览 HTML（[[03_ARCHITECTURE/architecture.md]] §7 Phase 1） |
| annotatedElements | object[] | 可点选元素清单 `{ dataAiId, dataAiType, label }` |
| editCount | number | 本次预览累计编辑次数，用于 `prototype.confirmed` 埋点 |

**错误情况**：

| 错误码 | 触发条件 |
|--------|---------|
| `GUIDE_WIREFRAME_NOT_FOUND` | `wireframePath` 文件不存在 |
| `GUIDE_PREVIEW_RENDER_FAILED` | HTML 解析/属性注入失败 |
| `GUIDE_STAGE_MISMATCH` | 当前阶段非 `prototype`，禁止预览 |

### 3.3 端点 2.3：`guide.clickToFix`（点选纠错入口）

**动词/调用方式**：函数调用 `services/guide.ts#clickToFix(input)`；IPC channel `guide:clickToFix`。

**架构依据**：[[03_ARCHITECTURE/architecture.md]] §7 第 2~5 步——前端事件委托捕获 `data-ai-id` → 向导Agent生成修改规约 → 转交编程Agent执行。

**输入 Schema**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| projectId | string(UUID) | ✅ | 项目 ID |
| dataAiId | string | ✅ | 被点击元素的 `data-ai-id` |
| dataAiType | string | ✅ | 元素类型 `data-ai-type`（button/input/card/...） |
| pageContext | object | ✅ | `{ pageId, domPath, surroundingText }` 上下文 |
| userIntent | string | ❌ | 用户可选的自然语言补充说明 |
| phase | enum | ✅ | `phase1`（data-ai-id 主路径）\| `phase2`（混合兜底，附截图） |
| screenshot | string(base64) | ⚠️ | 条件必填：`phase=phase2` 时必填，当前预览截图（base64），供视觉模型（MiniMax）分析点击位置；phase1 时省略（对应错误码 `GUIDE_VISION_MODEL_FAILED`） |

**输出 Schema**（生成完整的修改规约，可直接作为 §2.3 `coder.applyFix` 的入参）：

| 字段 | 类型 | 说明 |
|------|------|------|
| fixSpec | object | 完整的 `coder.applyFix`（§2.3）入参 `{ projectRoot, target, action, newValue, scope, preModifySnapshotId }`——调用方无需再补字段即可直接传入。`projectRoot` 由本端点内部从 `projectId` 反查 `_meta.json#project.directoryPath` 注入（见 §0.3 规则） |
| confidence | number | 置信度 0~1，低于阈值时提示用户确认 |
| preModifySnapshotId | number | fixSpec.preModifySnapshotId 的值，由本端点内部 `snapshot.create(triggerType=pre-modify, callerModule=guide)` 创建；单独透传便于上层 `click.fix` 埋点引用，applyFix 入参**以 fixSpec 为唯一来源**（消除双源歧义） |
| success | boolean | 用于 `click.fix` 埋点 `success` 字段 |

**错误情况**：

| 错误码 | 触发条件 |
|--------|---------|
| `GUIDE_ELEMENT_NO_AI_ID` | 元素无 `data-ai-id` 且未启用 phase2 截图兜底 |
| `GUIDE_FIX_SPEC_GEN_FAILED` | 向导Agent无法理解点击意图 |
| `GUIDE_SNAPSHOT_PRE_MODIFY_FAILED` | 前置 `pre-modify` 快照创建失败 |
| `GUIDE_VISION_MODEL_FAILED` | phase2 视觉模型（MiniMax）调用失败 |

### 3.4 端点 2.4：`guide.confirm`（确认 PRD / 原型 / 架构）

**动词/调用方式**：函数调用 `services/guide.ts#confirm(input)`；IPC channel `guide:confirm`。

**架构依据**：[[03_ARCHITECTURE/architecture.md]] §5.2「阶段结束判定」——路由层监测阶段完成信号（PRD确认/原型确认/架构确认）。

**输入 Schema**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| projectId | string(UUID) | ✅ | 项目 ID |
| confirmType | enum | ✅ | `prd` \| `prototype` \| `architecture`（对应 [[03_ARCHITECTURE/architecture.md]] §5.2 三类阶段确认；点选修改的确认走 §3.3+§2.3，不经本端点） |
| fromStage | enum | ✅ | 当前阶段，取 [[03_ARCHITECTURE/data-model.md]] §2.2 八值：`mode-select` \| `requirements` \| `prototype` \| `architecture` \| `planning` \| `coding` \| `testing` \| `delivered` |
| toStage | enum | ✅ | 目标阶段（同上枚举）；须符合 [[03_ARCHITECTURE/data-model.md]] §2.2 状态转移规则（如 requirements→prototype、prototype→architecture、architecture→planning\|coding） |

**confirmType ↔ stage 推进 / 快照 / 埋点映射**（*APISPEC-SUPPLEMENT*）：

| confirmType | mode | fromStage → toStage | 快照 triggerType | 触发埋点 |
|-------------|------|---------------------|-----------------|---------|
| `prd` | 两型均同 | `requirements` → `prototype` | `confirm` | `prd.confirmed` |
| `prototype` | 两型均同 | `prototype` → `architecture` | `confirm` | `prototype.confirmed` |
| `architecture` | `iterative` | `architecture` → `planning` | `confirm` | `architecture.confirmed`（data-model v0.6 已补第 14 事件，直接埋点） |
| `architecture` | `quick` | `architecture` → `coding`（跳过 planning） | `confirm` | 同上 |

> **mode 维度校验**：`architecture→planning` 仅 `iterative` 合法；`quick` 型架构确认后 `toStage=planning` 应判 `GUIDE_INVALID_STAGE_TRANSITION`。即该错误码的触发判定须结合 `Project.mode`（[[03_ARCHITECTURE/data-model.md]] §2.2）。

**输出 Schema**：

| 字段 | 类型 | 说明 |
|------|------|------|
| accepted | boolean | 是否接受确认并推进阶段 |
| snapshotId | number | 本端点内部调用 `snapshot.create(triggerType=confirm, callerModule=guide)` 创建的确认快照 ID（透传其返回值） |
| sessionRestarted | boolean | 是否触发了 Session Restart + Context Backfill |
| telemetryEmitted | string[] | 触发的埋点事件类型列表（如 `["prd.confirmed"]`） |

**错误情况**：

| 错误码 | 触发条件 |
|--------|---------|
| `GUIDE_INVALID_STAGE_TRANSITION` | `fromStage`→`toStage` 不符合状态转移图 |
| `GUIDE_DOC_NOT_CONFIRMED` | 前置轻校验：待确认文档 status 仍为 `draft`（需先经 judge 层提审为 `review`）；status 的权威硬校验由 §4.1 `JUDGE_DOC_STATUS_INVALID` 负责 |
| `GUIDE_SNAPSHOT_CONFIRM_FAILED` | `confirm` 快照创建失败 |

---

## 4. 类3：裁判Agent判定接口

**架构依据**（[[03_ARCHITECTURE/architecture.md#2-模块划分]] 裁判引擎）：
- 输入 = **文档目录路径** 或 **代码目录路径**
- 输出 = **通过/退回 + 问题清单**
- 关键实现 = 文件元数据检查 + PlantUML 解析 + LLM 语义评估
- 约束 = 硬约束（PRD必填项 / PlantUML语法 / API端点Schema / Sprint粒度 / 角色职责 / GWT文件存在性 / 代码-类图一致性）+ 软约束（逻辑一致性 / 可测试性 / 完整性 / 可读性）

**判定结果统一结构**（所有 judge.* 输出的 `data` 均为如下 `VerdictResult`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| verdict | enum | `pass` \| `reject` |
| hardViolations | object[] | 硬约束违规清单，每项 `{ rule, severity, targetPath, message }`，severity 取 `critical`\|`major`\|`minor`；任一非空即 verdict=`reject` |
| softSuggestions | object[] | 软约束建议，每项 `{ dimension, targetPath, message, score(0-1) }`；不影响 verdict |
| checkedAt | ISO8601 | 判定时间戳 |
| durationMs | number | 判定耗时，写入 `judge.verdict` 埋点 payload.duration |

### 4.1 端点 3.1：`judge.evaluateDocs`（文档体系判定）

**动词/调用方式**：函数调用 `services/judge.ts#evaluateDocs(input)`；IPC channel `judge:evaluateDocs`。

**输入 Schema**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| projectRoot | string(绝对路径) | ✅ | 项目根目录，等价 `Project.directoryPath` |
| targetDirectory | enum | ✅ | 判定范围：`01_PRD` \| `03_ARCHITECTURE` \| `04_API_SPEC` \| `05_PROJECT_PLAN` \| `06_TESTS` \| `all`（全量）。**刻意排除** `02_UX_DESIGN` / `07_VERSIONS` / `ROOT`——因 [[03_ARCHITECTURE/architecture.md]] §2 裁判硬约束 7 项不覆盖 UX 文档（走人工评审）、changelog/README 无结构化硬约束（见 §1.1 范围声明）。注：`06_TESTS` 的 GWT 硬约束由 §4.2 `evaluateCode` 的 `gwt-existence` 承担 |
| documentSet | object[] | ❌ | 显式传入的 DocumentMeta[]；缺省时自动读 `_meta.json#documents` 过滤出 targetDirectory 内文档 |
| hardChecks | string[] | ❌ | 启用的硬约束项，缺省=全部（对应架构 7 项硬约束） |
| enableSoftEval | boolean | ❌ | 是否启用 LLM 软约束评估，默认 true |

**输出 Schema**：`ApiResponse<VerdictResult>`（结构见本类开头）。`hardViolations.rule` 取值示例：`PRD_REQUIRED_FIELD_MISSING` / `PLANTUML_SYNTAX_INVALID` / `API_SCHEMA_INCOMPLETE` / `SPRINT_GRANULARITY_INVALID` / `ROLE_RESPONSIBILITY_OVERLAP` / `GWT_FEATURE_MISSING`。

**错误情况**（≥3）：

| 错误码 | 触发条件 |
|--------|---------|
| `JUDGE_DOC_NOT_FOUND` | `targetDirectory` 内无 status≥`review` 的文档（[[03_ARCHITECTURE/data-model.md#6-实体五文档目录元数据documentmeta]] status 枚举） |
| `JUDGE_PLANTUML_PARSE_FAILED` | `.puml` 文件无 `@startuml`/`@enduml` 配对或语法不可解析 |
| `JUDGE_DOC_STATUS_INVALID` | 文档 status 仍为 `draft`，未提交 `review` |
| `JUDGE_LLM_TIMEOUT` | 软约束 LLM 评估超过 60s |

### 4.2 端点 3.2：`judge.evaluateCode`（代码-类图一致性 + GWT 存在性判定）

**动词/调用方式**：函数调用 `services/judge.ts#evaluateCode(input)`；IPC channel `judge:evaluateCode`。

**输入 Schema**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| projectRoot | string | ✅ | 项目根目录 |
| codeDir | string | ✅ | 代码目录，固定 `{projectRoot}/_code/` |
| classDiagramPath | string | ✅ | `03_ARCHITECTURE/class-diagram.puml` 路径 |
| featureRoot | string | ✅ | `06_TESTS/` 路径（含 features/ 与 step-definitions/） |
| checks | string[] | ❌ | 启用项 `class-consistency` \| `gwt-existence`，缺省=全部 |

**输出 Schema**：`ApiResponse<VerdictResult & { classConsistency, gwtCoverage }>`，扩展字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| classConsistency | object | `{ matchedClasses: string[], missingInCode: string[], missingInDiagram: string[] }` |
| gwtCoverage | object | `{ featuresTotal, featuresWithSteps, featuresMissingSteps: string[] }` |

**错误情况**（≥3）：

| 错误码 | 触发条件 |
|--------|---------|
| `JUDGE_CODE_NOT_GENERATED` | `_code/` 为空（编程Agent尚未生成代码） |
| `JUDGE_CLASS_DIAGRAM_MISSING` | `classDiagramPath` 文件不存在 |
| `JUDGE_GWT_STEP_MISSING` | `.feature` 存在但 `step-definitions/` 缺对应步骤定义 |

---

## 5. 类4：快照管理接口

**架构依据**（[[03_ARCHITECTURE/architecture.md#2-模块划分]] 快照管理器）：
- 输入 = **项目目录路径 + 触发事件**
- 输出 = **快照目录树**
- 关键实现 = `fs.linkSync` 硬链接复制目录树，元数据 JSON 记录；**线性回滚**，不支持分支

**数据模型约束**（[[03_ARCHITECTURE/data-model.md#3-实体二快照snapshot]]）：
- snapshotId 为项目内自增序号（从 1 开始），**不存储 parentSnapshotId**——线性列表的时间顺序即版本顺序
- `triggerType` 枚举：`init` \| `pre-modify` \| `confirm` \| `mode-switch` \| `pre-error`
- 同一 projectId 同一时间**最多一个** `isCurrent=true`
- 快照由**系统自动触发**（编程/向导/裁判/路由层内部调用 `snapshot.create`），用户不可绕过接口直接创建

### 5.1 端点 4.1：`snapshot.create`（系统触发创建快照）

**动词/调用方式**：函数调用 `services/snapshot.ts#create(input)`；主要由 coder/guide/judge/router 内部调用，IPC channel `snapshot:create`（设置页诊断面板可手动触发）。

**输入 Schema**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| projectRoot | string | ✅ | 项目根目录 |
| triggerType | enum | ✅ | `init` \| `pre-modify` \| `confirm` \| `mode-switch` \| `pre-error`（[[03_ARCHITECTURE/data-model.md]] §3.2） |
| description | string(≤200) | ✅ | 自然语言描述，如"确认原型后" |
| callerModule | enum | ✅ | 触发方 `coder` \| `guide` \| `judge` \| `router` \| `manual` \| `project`（v0.4 扩展第 6 值，由 §7 `project.switchMode` 内部调用，合并规则见 §7 开头 *APISPEC-SUPPLEMENT* 注记），写入审计。`manual` 仅限设置页诊断面板/测试，为 [[03_ARCHITECTURE/data-model.md]] §3「自动触发」约束的**例外口**（*APISPEC-SUPPLEMENT*，须按 §0.4 三要素做 SYSTEM 权限校验，失败返回 `SYSTEM_PERMISSION_DENIED`；已提请 [[03_ARCHITECTURE/data-model.md]] §3 松绑表述为「自动触发；诊断面板例外 + SYSTEM 校验」） |

**输出 Schema**（`data` 字段）：

| 字段 | 类型 | 说明 |
|------|------|------|
| snapshotId | number | 新快照序号（项目内自增） |
| filePath | string | 物理路径 `workspace-files/snapshots/{projectId}/snap-{timestamp}-{snapshotId}/`（遵循 [[03_ARCHITECTURE/data-model.md]] §1.2 物理布局图及其「省略根前缀」约定；注：[[03_ARCHITECTURE/data-model.md]] §1.3 表述为 `_system/snapshots/` 系上游内部不一致，已提请 data-model 以 §1.2 布局图为准修正） |
| isCurrent | boolean | 固定 true（新建即当前） |
| previousCurrentCleared | boolean | 是否已将原 isCurrent=true 的快照置 false（回滚行为步骤1） |
| hardlinkedFiles | number | 硬链接复制的文件数 |

**错误情况**（≥3）：

| 错误码 | 触发条件 |
|--------|---------|
| `SNAPSHOT_TRIGGER_INVALID` | `triggerType` 不在 5 项枚举内 |
| `SNAPSHOT_DESC_TOO_LONG` | `description` 超过 200 字（亦触发通用 `FIELD_TOO_LONG`，见 §8.4） |
| `SNAPSHOT_LINK_FAILED` | `fs.linkSync` 失败（磁盘满/权限/跨设备） |
| `SNAPSHOT_PROJECT_NOT_FOUND` | `projectRoot` 不在 `projects-index.json` |
| `SYSTEM_PERMISSION_DENIED` | `callerModule='manual'` 但调用方未经 SYSTEM 级授权（详见 §0.4 三要素） |

### 5.2 端点 4.2：`snapshot.list`（快照列表）

**动词/调用方式**：函数调用 `services/snapshot.ts#list(input)`；IPC channel `snapshot:list`。

**输入 Schema**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| projectRoot | string | ✅ | 项目根目录 |
| filter | object | ❌ | `{ triggerType?, isHealthy?, isCurrent? }` 任一过滤 |
| includeUnhealthy | boolean | ❌ | 是否含 `isHealthy=false` 的快照，默认 false |

**输出 Schema**：

| 字段 | 类型 | 说明 |
|------|------|------|
| snapshots | object[] | 快照摘要列表，每项 `{ snapshotId, timestamp, description, triggerType, isCurrent, isHealthy }`（按 snapshotId 升序） |
| currentSnapshotId | number\|null | 当前 isCurrent=true 的快照 ID |
| totalCount | number | 列表总数 |

**错误情况**（≥3）：

| 错误码 | 触发条件 |
|--------|---------|
| `SNAPSHOT_PROJECT_NOT_FOUND` | 项目不存在 |
| `SNAPSHOT_INDEX_CORRUPT` | `_meta.json#snapshots` 不可读或结构非法 |
| `SNAPSHOT_FILTER_INVALID` | `filter` 字段值超出枚举 |

### 5.3 端点 4.3：`snapshot.rollback`（线性回滚）

**动词/调用方式**：函数调用 `services/snapshot.ts#rollback(input)`；IPC channel `snapshot:rollback`。

**架构依据**：[[03_ARCHITECTURE/data-model.md]] §3.5 回滚行为——回滚前置原 isCurrent=false → 覆盖目录 → 目标 isCurrent=true；被回滚快照**不删除**，时间轴线性前进（新快照追加末尾）。

**输入 Schema**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| projectRoot | string | ✅ | 项目根目录 |
| targetSnapshotId | number | ✅ | 回滚目标快照 ID |
| createPreRollbackSnapshot | boolean | ❌ | 回滚前是否先对当前状态建快照（保证线性前进），默认 true；新建快照 triggerType 固定为 `pre-error` |

**输出 Schema**：

| 字段 | 类型 | 说明 |
|------|------|------|
| rolledBackTo | number | 目标 snapshotId |
| newCurrentSnapshotId | number | 回滚后 isCurrent=true 的快照 ID（=targetSnapshotId） |
| preRollbackSnapshotId | number\|null | 回滚前新建的快照 ID（createPreRollbackSnapshot=true 时） |
| filesRestored | number | 覆盖还原的文件数 |

**错误情况**（≥3）：

| 错误码 | 触发条件 |
|--------|---------|
| `SNAPSHOT_TARGET_NOT_FOUND` | `targetSnapshotId` 不存在 |
| `SNAPSHOT_TARGET_UNHEALTHY` | 目标快照 `isHealthy=false`（损坏快照禁止作为回滚目标） |
| `SNAPSHOT_ROLLBACK_IN_PROGRESS` | 已有回滚进行中（并发拒绝） |
| `SNAPSHOT_OVERWRITE_FAILED` | 目录树覆盖写入失败 |

### 5.4 端点 4.4：`snapshot.delete`（删除非当前快照）

**动词/调用方式**：函数调用 `services/snapshot.ts#delete(input)`；IPC channel `snapshot:delete`。

**设计约束**：与 [[03_ARCHITECTURE/data-model.md]] §3.5 一致——回滚不删快照；本端点仅用于**显式清理**非当前快照，**禁止删除 isCurrent=true 的快照**（强制守卫）。

**输入 Schema**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| projectRoot | string | ✅ | 项目根目录 |
| snapshotId | number | ✅ | 待删快照 ID |
| force | boolean | ❌ | 是否强制（忽略保留策略），默认 false |

**输出 Schema**：

| 字段 | 类型 | 说明 |
|------|------|------|
| deleted | boolean | 是否删除成功 |
| freedSpaceBytes | number | 释放磁盘空间（硬链接 inode 引用归零才回收） |

**错误情况**（≥3）：

| 错误码 | 触发条件 |
|--------|---------|
| `SNAPSHOT_DELETE_CURRENT_FORBIDDEN` | 目标 `isCurrent=true`，拒绝删除 |
| `SNAPSHOT_NOT_FOUND` | `snapshotId` 不存在 |
| `SNAPSHOT_INODE_BUSY` | 硬链接 inode 仍被其他快照引用，仅断链未回收空间 |

---

## 6. 类5：埋点上报接口

**架构依据**（[[03_ARCHITECTURE/architecture.md#2-模块划分]] 埋点采集层）：
- 输入 = **埋点事件（type + payload + timestamp）**
- 输出 = **JSONL 日志文件**（按月分片 `events-{YYYY-MM}.jsonl`）
- 关键实现 = JSONL 追加写入，**异步非阻塞**，与 [[01_PRD/prd.md]] §12.4 一致；14 事件全量无侵入采集

**数据模型约束**（[[03_ARCHITECTURE/data-model.md#4-实体三埋点事件telemetryevent]]）：
- 公共字段 `sessionId` / `projectId`(可空) / `userId`(hash) / `stage`(可空) / `mode`(可空) 由 §0.3 上下文自动注入，业务层无需显式传
- `eventType` 必须落在 14 项枚举内（采集层写入前校验）
- `payload` 结构随 eventType 变化（关键字段见下表）

**14 事件类型 payload 关键字段**（与 [[03_ARCHITECTURE/data-model.md]] §4.3 关键字段对齐；完整 schema 以 data-model 为准）：

| eventType | payload 关键字段 |
|-----------|-----------------|
| `project.created` | `{projectId, mode, template}` |
| `dialog.submitted` | `{projectId, roundNumber, inputLength, containsImage}` |
| `role.switched` | `{projectId, fromRole, toRole, triggerReason}` |
| `prd.confirmed` | `{projectId, rounds, duration, featureCount}` |
| `prototype.confirmed` | `{projectId, previewCount, editCount, duration}` |
| `user.undo` | `{projectId, stage, undoTarget, undoCount}` |
| `click.fix` | `{projectId, targetType, success}` |
| `mode.switch` | `{projectId, reason, currentStage}` |
| `coding.executed` | `{projectId, taskType, tokensUsed, success}` |
| `autofix.triggered` | `{projectId, attemptNumber, result}` |
| `judge.verdict` | `{projectId, passed, violationTypes, duration}` |
| `user.satisfaction` | `{projectId, explicit}` |
| `project.finished` | `{projectId, finalStatus, totalDuration, totalTokens}` |
| `architecture.confirmed` | `{projectId, rounds, duration, moduleCount}` |

### 6.1 端点 5.1：`telemetry.emit`（单事件上报，fire-and-forget）

**动词/调用方式**：函数调用 `services/telemetry.ts#emit(input)`；非阻塞，写入内存缓冲后立即返回，由后台 flusher 追加到 JSONL。IPC channel `telemetry:emit`。

**输入 Schema**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| eventType | enum(14) | ✅ | 上表 14 项之一 |
| payload | object | ✅ | 事件特定数据，结构随 eventType 变化 |
| timestamp | ISO8601 | ❌ | 客户端时钟；缺省=采集时刻 |
| duration | number(ms) | ❌ | 事件耗时（适用时，如 `prd.confirmed`） |

> `sessionId` / `projectId` / `userId` / `stage` / `mode` 由 §0.3 上下文自动注入，不在此传入。

**输出 Schema**（fire-and-forget，仅返回接收确认）：

| 字段 | 类型 | 说明 |
|------|------|------|
| accepted | boolean | 是否进入缓冲 |
| eventId | string(UUID) | 采集层分配的事件唯一 ID |
| shardedFile | string | 落盘目标 `events-{YYYY-MM}.jsonl` |

**错误情况**（≥3）：

| 错误码 | 触发条件 |
|--------|---------|
| `TELEMETRY_EVENT_TYPE_INVALID` | `eventType` 不在 14 项枚举 |
| `TELEMETRY_PAYLOAD_SCHEMA_VIOLATION` | `payload` 缺该 eventType 必填键（如 `click.fix` 缺 `success`） |
| `TELEMETRY_WRITE_FAILED` | flusher 已取出事件并向 JSONL 追加写入时 IO 失败（磁盘满/权限）；异步反馈，前端通过下次 emit 的诊断字段感知。**与 BUFFER_OVERFLOW 区别**：此时磁盘未必满，是已 flush 后的写入失败 |
| `TELEMETRY_BUFFER_OVERFLOW` | 内存缓冲超阈值（默认 1000 条），触发**同步预防性丢弃**（磁盘未必满），仅记 droppedCount，本次 emit 返回 `accepted=false`。**与 WRITE_FAILED 区别**：事件未进入 flush 流程即被丢弃 |

### 6.2 端点 5.2：`telemetry.emitBatch`（批量上报/强制 flush）

**动词/调用方式**：函数调用 `services/telemetry.ts#emitBatch(input)`；IPC channel `telemetry:emitBatch`。用于阶段切换、应用退出等需立即落盘的场景。

**输入 Schema**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| events | object[] | ✅ | 事件数组，每项结构同端点 5.1 输入 |
| flushReason | enum | ❌ | `timer` \| `stage-change` \| `app-exit` \| `manual` |

**输出 Schema**：

| 字段 | 类型 | 说明 |
|------|------|------|
| acceptedCount | number | 成功入缓冲事件数 |
| rejectedCount | number | 被拒事件数 |
| rejectedDetails | object[] | `{ index, errorCode }` 拒绝明细 |

**错误情况**（≥3）：

| 错误码 | 触发条件 |
|--------|---------|
| `TELEMETRY_BATCH_TOO_LARGE` | 单批事件数超上限（默认 500） |
| `TELEMETRY_EVENT_TYPE_INVALID` | 批内某事件 eventType 非法（计入 rejectedDetails） |
| `TELEMETRY_PARTIAL_FAILURE` | 批内部分写入失败（acceptedCount < 总数） |

### 6.3 端点 5.3：`telemetry.query`（埋点查询/聚合，供分析看板）

**动词/调用方式**：函数调用 `services/telemetry.ts#query(input)`；IPC channel `telemetry:query`。只读，扫描 `events-*.jsonl` 分片。

**输入 Schema**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| scope | object | ✅ | `{ projectId?, sessionId?, userId? }` 至少一项 |
| eventTypes | string[] | ❌ | eventType 过滤；缺省=全部 |
| timeRange | object | ✅ | `{ from: ISO8601, to: ISO8601 }` |
| aggregate | enum | ❌ | `count` \| `sum-duration` \| `none`（原事件流），默认 `none` |
| groupBy | enum | ❌ | `eventType` \| `stage` \| `day`，仅 aggregate≠none 时生效 |

**输出 Schema**：

| 字段 | 类型 | 说明 |
|------|------|------|
| rows | object[] | aggregate=none 时为原事件；否则为 `{ key, count, sumDuration? }` |
| shardedFilesScanned | string[] | 实际扫描的 `events-*.jsonl` 文件名 |
| truncated | boolean | 是否因行数上限截断 |

**错误情况**（≥3）：

| 错误码 | 触发条件 |
|--------|---------|
| `TELEMETRY_QUERY_RANGE_INVALID` | `timeRange.from` > `to` 或跨度超限 |
| `TELEMETRY_SCOPE_EMPTY` | `scope` 三字段全空 |
| `TELEMETRY_QUERY_TIMEOUT` | 扫描超 10s（分片过大） |

---

## 7. 类6：项目管理接口

**架构依据**（[[03_ARCHITECTURE/data-model.md#2-实体一项目元数据project]] §2 Project 实体 + §1.2 物理布局图）：
- 输入 = **用户在 Proma 项目列表 / Tab 中的操作**（列表 / 打开 / 删除 / 模式切换）
- 输出 = **项目摘要列表 / 项目详情 / 删除确认 / 模式切换结果**
- 关键实现 = 读写 `_system/projects-index.json` 索引 + `_meta.json#project` 单项目元数据；工作区目录的硬链接 / 文件移动由 Proma 平台层承担，本规范只定义业务读写契约

**数据模型约束**（[[03_ARCHITECTURE/data-model.md#2-实体一项目元数据project]]）：
- 实体主键 `projectId`(UUID)；唯一可读标识 `name` + `directoryPath`
- `mode` 枚举 `quick` \| `iterative`（与 §3.4 confirmType↔stage 映射一致）
- `currentStage` 取 [[03_ARCHITECTURE/data-model.md#22-状态转移]] §2.2 八值枚举
- 项目"创建"动作**不在本类范围**——由 Proma 平台层 new project wizard 完成后写入 `projects-index.json`，再经 `project.created`(#1) 埋点上报（见 §1.1 范围声明）

> **callerModule 上溯与合并规则**（*APISPEC-SUPPLEMENT*）：本类端点（`project.delete` / `project.switchMode`）虽无 `callerModule` 入参字段，但内部调用 §5.1 `snapshot.create` 时会传 `callerModule='project'`。该值是对 [[03_ARCHITECTURE/data-model.md#3-实体二快照snapshot]] §3 `callerModule` 原 5 值（coder\|guide\|judge\|router\|manual）的扩展，**合并规则如下**：
> - **§5.1 `snapshot.create` 实现侧枚举校验**：v0.4 起按 6 值枚举 `coder\|guide\|judge\|router\|manual\|project` 接受；`callerModule='project'` 跳过 §0.4 SYSTEM 校验（仅 `manual` 触发该校验，`project` 由本类端点服务层内部调用，调用链可信）。
> - **埋点写入**：`snapshot.create` 输出的 `callerModule='project'` 字段值原样写入审计日志，与 `manual` / `coder` 等值并列统计。
> - **上游同步**：已提请 [[03_ARCHITECTURE/data-model.md#3-实体二快照snapshot]] §3 在 callerModule 枚举显式补 `project` 第 6 值（见 §10.5 升级项）；上游确认前以本节合并规则为实施依据，不阻塞 v0.4 开工。

### 7.1 端点 6.1：`project.list`（项目列表 / 单项目详情）

**动词/调用方式**：函数调用 `services/project.ts#list(input)`；IPC channel `project:list`。

**输入 Schema**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| projectId | string(UUID) | ❌ | 提供则返回单项目详情；缺省=列全部 |
| filter | object | ❌ | `{ mode?, template?, currentStage? }` 任一过滤；字段值须符合枚举，违例 → `INPUT_INVALID` |
| includeArchived | boolean | ❌ | 是否含已归档项目（`_meta.json#project.archived=true`），默认 false |
| sortBy | enum | ❌ | `lastOpenedAt`（默认，降序）\| `createdAt`（降序）\| `name`（升序） |

**输出 Schema**（`ApiResponse<ProjectListResult>`，`data` 字段）：

| 字段 | 类型 | 说明 |
|------|------|------|
| projects | object[] | 项目摘要列表，每项 `{ projectId, name, mode, template, currentStage, directoryPath, lastOpenedAt, totalTokenUsed, archived }`；按 `sortBy` 排序 |
| currentProjectId | string\|null | Proma 当前活动 Tab 的项目 ID（无打开 Tab 时为 null） |
| totalCount | number | 列表总数（含/不含归档取决于 `includeArchived`） |

**错误情况**（≥3）：

| 错误码 | 触发条件 |
|--------|---------|
| `PROJECT_NOT_FOUND` | `projectId` 提供但在 `projects-index.json` 中找不到（通用码，见 §8.4） |
| `INPUT_INVALID` | `filter` 字段值越出枚举（如 `mode='unknown'`）或 `sortBy` 不在 3 值枚举内 |
| `PROJECT_INDEX_CORRUPT` | `_system/projects-index.json` 不可读或结构非法（缺字段 / JSON 损坏） |

### 7.2 端点 6.2：`project.open`（打开项目）

**动词/调用方式**：函数调用 `services/project.ts#open(input)`；IPC channel `project:open`。

**架构依据**：[[03_ARCHITECTURE/architecture.md#41-会话与上下文]] §4.1——打开项目后若 `resumeSession=true`，服务层自动执行 Session Restart + Context Backfill（与 §3.4 `guide.confirm` 内部编排的六步一致），结果经输出字段 `sessionResumed` 透传。

**输入 Schema**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| projectId | string(UUID) | ✅ | 待打开项目 ID |
| resumeSession | boolean | ❌ | 是否恢复上次会话上下文（默认 true），false 则新建空 SessionContext |

**输出 Schema**：

| 字段 | 类型 | 说明 |
|------|------|------|
| project | object | Project 全字段（[[03_ARCHITECTURE/data-model.md#2-实体一项目元数据project]] §2 字段表） |
| currentSnapshotId | number\|null | 当前 `isCurrent=true` 的快照 ID（无快照项目为 null，如新建未启动 coding） |
| sessionResumed | boolean | 是否成功恢复会话上下文（`resumeSession=true` 但 `sessions/{projectId}.json` 缺失时为 false，并新建空 SessionContext） |
| lastOpenedAt | ISO8601 | 本端点更新的最近打开时间戳（写回 `projects-index.json` + `_meta.json#project.lastOpenedAt`） |

**错误情况**（≥3）：

| 错误码 | 触发条件 |
|--------|---------|
| `PROJECT_NOT_FOUND` | `projectId` 在 `projects-index.json` 中找不到 |
| `PROJECT_DIRECTORY_MISSING` | `project.directoryPath` 在磁盘上不存在（被外部删除 / 移动） |
| `PROJECT_INDEX_CORRUPT` | `projects-index.json` 不可读或结构非法 |

### 7.3 端点 6.3：`project.delete`（删除项目）

**动词/调用方式**：函数调用 `services/project.ts#delete(input)`；IPC channel `project:delete`。

**设计约束**：本端点为**破坏性操作**，强制要求二次确认 token；删除范围分三档（仅索引 / 含快照 / 含工作区目录），默认仅删索引、保留工作区可恢复。与 §5.4 `snapshot.delete` 的"禁止删除 isCurrent" 守卫同级，须按 §0.4 三要素做 SYSTEM 权限校验。

**输入 Schema**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| projectId | string(UUID) | ✅ | 待删项目 ID |
| confirmation | string | ✅ | 二次确认 token，须等于 `projectId` 末 8 位字符；不匹配 → `PROJECT_DELETE_CONFIRMATION_REQUIRED` |
| deleteSnapshots | boolean | ❌ | 是否一并删除 `workspace-files/snapshots/{projectId}/`，默认 true |
| deleteWorkspace | boolean | ❌ | 是否硬删除 `workspace-files/{projectId}-{shortName}/` 工作区目录，默认 **false**（保留可恢复，仅清索引） |

**输出 Schema**：

| 字段 | 类型 | 说明 |
|------|------|------|
| deleted | boolean | 索引项是否已删除（始终 true，否则本端点 reject） |
| freedSpaceBytes | number | 实际释放磁盘空间（硬链接 inode 引用归零才回收） |
| snapshotsRemoved | number | 删除的快照目录数（`deleteSnapshots=false` 时为 0） |
| workspacePreserved | boolean | 工作区目录是否保留（`deleteWorkspace=false` 时为 true） |

**错误情况**（≥3）：

| 错误码 | 触发条件 |
|--------|---------|
| `PROJECT_NOT_FOUND` | `projectId` 在 `projects-index.json` 中找不到 |
| `PROJECT_DELETE_CONFIRMATION_REQUIRED` | `confirmation` 不等于 `projectId` 末 8 位 |
| `PROJECT_DELETE_HAS_ACTIVE_SESSION` | 项目尚有活动会话（`guide.chat` 未结束 / `coder.generateCode` 任务进行中），拒绝删除 |
| `SYSTEM_PERMISSION_DENIED` | 调用方非 Proma 主进程（如外部脚本通过 IPC 伪造调用），删除须 SYSTEM 级权限（详见 §0.4 三要素） |

### 7.4 端点 6.4：`project.switchMode`（模式切换 quick ↔ iterative）

**动词/调用方式**：函数调用 `services/project.ts#switchMode(input)`；IPC channel `project:switchMode`。

**架构依据**：[[03_ARCHITECTURE/data-model.md#22-状态转移]] §2.2 mode 与 stage 联动——切换 mode 后须重新校验当前 stage 在新 mode 下的合法迁移路径（如 `quick` 型 `architecture` 后直跳 `coding`，`iterative` 型须先 `planning`，见 §3.4 confirmType↔stage 映射）。

**输入 Schema**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| projectId | string(UUID) | ✅ | 项目 ID |
| targetMode | enum | ✅ | `quick` \| `iterative`；与当前 mode 相同 → `INPUT_INVALID`（无变化） |
| reason | string(≤200) | ✅ | 切换原因，写入 `mode.switch`(#8) 埋点 payload.reason；超 200 字 → `FIELD_TOO_LONG` |
| createSnapshot | boolean | ❌ | 切换前是否建 `mode-switch` 快照（默认 true）。**内部调用 §5.1 `snapshot.create` 时参数组装**：`projectRoot` = 由本端点入参 `projectId` 反查 `_meta.json#project.directoryPath` 解析（与 §0.3 规则一致）；`triggerType` = `mode-switch`；`callerModule` = `project`（v0.4 扩展，见下方注记）；`description` = 自动组装为 `` `mode-switch from ${previousMode} to ${targetMode}: ${reason}` ``（≤200 字自动满足，因 `reason` ≤200 字）。`snapshot.create` 失败时透传错误码（如 `SNAPSHOT_LINK_FAILED`），并由本端点转译为 `SNAPSHOT_MODE_SWITCH_FAILED` 返回调用方。 |

**输出 Schema**：

| 字段 | 类型 | 说明 |
|------|------|------|
| previousMode | enum | 切换前 mode |
| newMode | enum | 切换后 mode（=`targetMode`） |
| snapshotId | number\|null | 切换前 `mode-switch` 快照 ID（`createSnapshot=false` 时为 null） |
| telemetryEmitted | string[] | 触发的埋点事件类型列表（`["mode.switch"]`） |

**错误情况**（≥3）：

| 错误码 | 触发条件 |
|--------|---------|
| `PROJECT_NOT_FOUND` | `projectId` 在 `projects-index.json` 中找不到 |
| `INPUT_INVALID` | `targetMode` 不在 2 值枚举内 / 与当前 mode 相同（无变化） |
| `FIELD_TOO_LONG` | `reason` 超过 200 字 |
| `PROJECT_MODE_SWITCH_FORBIDDEN` | 当前 `currentStage=delivered` 或 `coding` 中后期（已有 GWT 通过的 feature），禁止切换 mode（避免破坏代码一致性） |
| `SNAPSHOT_MODE_SWITCH_FAILED` | `createSnapshot=true` 但前置 `mode-switch` 快照创建失败（依赖 §5.1 `snapshot.create`，错误透传） |

---

## 8. 错误码体系

**编号约定**：所有错误码采用 `<DOMAIN>_<ERROR>` 格式，全大写下划线分隔。DOMAIN 与接口类别一一对应，便于路由与埋点归因。

> **命名空间区分**（*APISPEC-SUPPLEMENT*）：§4 `hardViolations[].rule`（如 `PRD_REQUIRED_FIELD_MISSING`、`PLANTUML_SYNTAX_INVALID`）属于**裁判硬约束规则名**命名空间，**不带 DOMAIN 前缀**，与本节 `<DOMAIN>_<ERROR>` 错误码是两套独立命名空间——前者描述"违反了哪条硬约束"（供退回问题定位），后者描述"接口调用失败的错误码"（供调用方分支处理）。两者命名风格相似但不混用。

### 8.1 DOMAIN 划分

| DOMAIN | 对应接口类 | 说明 |
|--------|-----------|------|
| `CODER` | 类1 编程Agent | 代码生成/修复/测试 |
| `GUIDE` | 类2 向导Agent | 对话/预览/纠错/确认 |
| `JUDGE` | 类3 裁判 | 文档/代码判定 |
| `SNAPSHOT` | 类4 快照 | 创建/列表/回滚/删除 |
| `TELEMETRY` | 类5 埋点 | 上报/查询 |
| `PROJECT` | 类6 项目管理 | 列表/打开/删除/模式切换 |
| `SYSTEM` | 跨类公共 | 上下文/桥接/通用；v0.4 起含权限校验、输入校验、会话锁并发冲突与跨 Agent 包装错误码（详见 §0.4、§8.4 与 §8.5） |

### 8.2 错误严重度分级（HTTP 类比）

> 本平台**零依赖、无 HTTP**（见 §0.1），此处 HTTP 类比仅用于表达错误严重度与可重试性，不对应真实网络协议。

| 分级 | HTTP 类比 | 含义 | 可重试 | 示例 |
|------|----------|------|--------|------|
| 客户端输入错误 | 4xx | 调用方参数非法 | 否（改参数后可） | `*_NOT_FOUND` / `*_INVALID` / `*_SCHEMA_VIOLATION` |
| 状态/冲突 | 409 | 状态机非法迁移或并发冲突 | 否 | `GUIDE_INVALID_STAGE_TRANSITION` / `SNAPSHOT_ROLLBACK_IN_PROGRESS` |
| 超时 | 408 | 子进程/LLM 超时 | 是 | `CODER_SANDBOX_TIMEOUT` / `JUDGE_LLM_TIMEOUT` |
| 服务端失败 | 5xx | Agent/LLM/IO 失败 | 是 | `CODER_GENERATION_FAILED` / `SNAPSHOT_LINK_FAILED` |
| 禁止 | 403 | 守卫拒绝（防破坏性操作） | 否 | `SNAPSHOT_DELETE_CURRENT_FORBIDDEN` |

### 8.3 错误码总表（按 DOMAIN 归并）

| 错误码 | DOMAIN | 严重度 | 可重试 | 出处 |
|--------|--------|--------|--------|------|
| `CODER_DOC_NOT_FOUND` | CODER | 4xx | 否 | §2.2 |
| `CODER_DOC_CONTRACT_VIOLATION` | CODER | 4xx | 否 | §2.2 |
| `CODER_GENERATION_FAILED` | CODER | 5xx | 是 | §2.2 |
| `CODER_SANDBOX_TIMEOUT` | CODER | 408 | 是 | §2.2 |
| `CODER_GWT_COMPILE_ERROR` | CODER | 4xx | 否 | §2.2 |
| `CODER_TARGET_NOT_FOUND` | CODER | 4xx | 否 | §2.3 |
| `CODER_FIX_PRE_SNAPSHOT_MISSING` | CODER | 4xx | 否 | §2.3 |
| `CODER_FIX_OUT_OF_SCOPE` | CODER | 403 | 否 | §2.3 |
| `CODER_FIX_APPLY_FAILED` | CODER | 5xx | 是 | §2.3 |
| `CODER_FIX_ACTION_INVALID` | CODER | 4xx | 否 | §2.3 |
| `CODER_GWT_RUNNER_ERROR` | CODER | 5xx | 是 | §2.4 |
| `CODER_AUTOFIX_EXHAUSTED` | CODER | 5xx | 是 | §2.4 |
| `CODER_FEATURE_NOT_FOUND` | CODER | 4xx | 否 | §2.4 |
| `GUIDE_PROJECT_NOT_FOUND` | GUIDE | 4xx | 否 | §3.1 |
| `GUIDE_ROLE_INVALID` | GUIDE | 4xx | 否 | §3.1 |
| `GUIDE_MODEL_UNAVAILABLE` | GUIDE | 5xx | 是 | §3.1 |
| `GUIDE_CONTEXT_BACKFILL_FAILED` | GUIDE | 5xx | 是 | §3.1 |
| `GUIDE_WIREFRAME_NOT_FOUND` | GUIDE | 4xx | 否 | §3.2 |
| `GUIDE_PREVIEW_RENDER_FAILED` | GUIDE | 5xx | 是 | §3.2 |
| `GUIDE_STAGE_MISMATCH` | GUIDE | 409 | 否 | §3.2 |
| `GUIDE_ELEMENT_NO_AI_ID` | GUIDE | 4xx | 否 | §3.3 |
| `GUIDE_FIX_SPEC_GEN_FAILED` | GUIDE | 5xx | 是 | §3.3 |
| `GUIDE_SNAPSHOT_PRE_MODIFY_FAILED` | GUIDE | 5xx | 是 | §3.3 |
| `GUIDE_VISION_MODEL_FAILED` | GUIDE | 5xx | 是 | §3.3 |
| `GUIDE_INVALID_STAGE_TRANSITION` | GUIDE | 409 | 否 | §3.4 |
| `GUIDE_DOC_NOT_CONFIRMED` | GUIDE | 409 | 否 | §3.4 |
| `GUIDE_SNAPSHOT_CONFIRM_FAILED` | GUIDE | 5xx | 是 | §3.4 |
| `JUDGE_DOC_NOT_FOUND` | JUDGE | 4xx | 否 | §4.1 |
| `JUDGE_PLANTUML_PARSE_FAILED` | JUDGE | 4xx | 否 | §4.1 |
| `JUDGE_DOC_STATUS_INVALID` | JUDGE | 409 | 否 | §4.1 |
| `JUDGE_LLM_TIMEOUT` | JUDGE | 408 | 是 | §4.1 |
| `JUDGE_CODE_NOT_GENERATED` | JUDGE | 4xx | 否 | §4.2 |
| `JUDGE_CLASS_DIAGRAM_MISSING` | JUDGE | 4xx | 否 | §4.2 |
| `JUDGE_GWT_STEP_MISSING` | JUDGE | 4xx | 否 | §4.2 |
| `SNAPSHOT_TRIGGER_INVALID` | SNAPSHOT | 4xx | 否 | §5.1 |
| `SNAPSHOT_DESC_TOO_LONG` | SNAPSHOT | 4xx | 否 | §5.1 |
| `SNAPSHOT_LINK_FAILED` | SNAPSHOT | 5xx | 是 | §5.1 |
| `SNAPSHOT_PROJECT_NOT_FOUND` | SNAPSHOT | 4xx | 否 | §5.1 / §5.2 |
| `SNAPSHOT_INDEX_CORRUPT` | SNAPSHOT | 5xx | 是 | §5.2 |
| `SNAPSHOT_FILTER_INVALID` | SNAPSHOT | 4xx | 否 | §5.2 |
| `SNAPSHOT_TARGET_NOT_FOUND` | SNAPSHOT | 4xx | 否 | §5.3 |
| `SNAPSHOT_TARGET_UNHEALTHY` | SNAPSHOT | 409 | 否 | §5.3 |
| `SNAPSHOT_ROLLBACK_IN_PROGRESS` | SNAPSHOT | 409 | 否 | §5.3 |
| `SNAPSHOT_OVERWRITE_FAILED` | SNAPSHOT | 5xx | 是 | §5.3 |
| `SNAPSHOT_DELETE_CURRENT_FORBIDDEN` | SNAPSHOT | 403 | 否 | §5.4 |
| `SNAPSHOT_NOT_FOUND` | SNAPSHOT | 4xx | 否 | §5.4 |
| `SNAPSHOT_INODE_BUSY` | SNAPSHOT | 409 | 否 | §5.4 |
| `SNAPSHOT_MODE_SWITCH_FAILED` | SNAPSHOT | 5xx | 是 | §7.4（前置 mode-switch 快照创建失败） |
| `TELEMETRY_EVENT_TYPE_INVALID` | TELEMETRY | 4xx | 否 | §6.1 / §6.2 |
| `TELEMETRY_PAYLOAD_SCHEMA_VIOLATION` | TELEMETRY | 4xx | 否 | §6.1 |
| `TELEMETRY_WRITE_FAILED` | TELEMETRY | 5xx | 是 | §6.1 |
| `TELEMETRY_BUFFER_OVERFLOW` | TELEMETRY | 5xx | 是 | §6.1 |
| `TELEMETRY_BATCH_TOO_LARGE` | TELEMETRY | 4xx | 否 | §6.2 |
| `TELEMETRY_PARTIAL_FAILURE` | TELEMETRY | 5xx | 是 | §6.2 |
| `TELEMETRY_QUERY_RANGE_INVALID` | TELEMETRY | 4xx | 否 | §6.3 |
| `TELEMETRY_SCOPE_EMPTY` | TELEMETRY | 4xx | 否 | §6.3 |
| `TELEMETRY_QUERY_TIMEOUT` | TELEMETRY | 408 | 是 | §6.3 |
| `PROJECT_NOT_FOUND` | PROJECT | 4xx | 否 | §7.1 / §7.2 / §7.3 / §7.4 |
| `PROJECT_INDEX_CORRUPT` | PROJECT | 5xx | 是 | §7.1 / §7.2 |
| `PROJECT_DIRECTORY_MISSING` | PROJECT | 4xx | 否 | §7.2 |
| `PROJECT_DELETE_CONFIRMATION_REQUIRED` | PROJECT | 4xx | 否 | §7.3 |
| `PROJECT_DELETE_HAS_ACTIVE_SESSION` | PROJECT | 409 | 否 | §7.3 |
| `PROJECT_MODE_SWITCH_FORBIDDEN` | PROJECT | 409 | 否 | §7.4 |
| `SYSTEM_PERMISSION_DENIED` | SYSTEM | 403 | 否 | §0.4 / §5.1 / §7.3 |
| `INPUT_INVALID` | SYSTEM | 4xx | 否 | §0.4 / §7.1 / §7.4 |
| `FIELD_TOO_LONG` | SYSTEM | 4xx | 否 | §0.4 / §5.1 / §7.4 |
| `SESSION_LOCK_CONTENTION` | SYSTEM | 409 | 是 | guide.chat 入口 acquireProjectLock（agent-comm §2.3.1 SPSAS 不变量） |
| `GUIDE_INTERNAL_JUDGE_FAILED` | SYSTEM | 5xx | 是 | guide.confirm 内部调 judge.evaluateDocs 失败 wrap（agent-comm §5.3 跨 Agent 包装） |

### 8.4 通用输入校验错误码族（v0.4 补充，闭环 audit B6）

为统一处理跨端点的输入边界违例（空 payload / 无效 enum / 不存在 ID / 超长字段），v0.4 引入如下通用错误码族。各端点在错误情况表中**优先使用专属 DOMAIN 错误码**（如 `GUIDE_PROJECT_NOT_FOUND`、`SNAPSHOT_PROJECT_NOT_FOUND`），仅在无合适专属码时回退到通用码。通用码与专属码并存，调用方可据 DOMAIN 前缀区分错误来源。

| 错误码 | 触发条件 | 适用端点（声明位置） |
|--------|---------|---------------------|
| `INPUT_INVALID` | payload 为空 / 枚举值非法 / 格式错误（如 UUID 不合法、enum 越界、必填字段缺失） | §7.1 `project.list`（filter / sortBy 非法）/ §7.4 `project.switchMode`（targetMode 同当前值） |
| `PROJECT_NOT_FOUND` | `projectId` 在 `projects-index.json` 中找不到（通用版，与 `GUIDE_PROJECT_NOT_FOUND` / `SNAPSHOT_PROJECT_NOT_FOUND` 并存，前者偏对话上下文、后者偏快照上下文，本码偏项目管理上下文） | §7.1 / §7.2 / §7.3 / §7.4 |
| `SNAPSHOT_NOT_FOUND` | `snapshotId` 不存在（§5.4 已定义，v0.4 纳入族声明以统一引用） | §5.4 / §7.4（间接，前置 mode-switch 快照缺时由 `SNAPSHOT_MODE_SWITCH_FAILED` 表达） |
| `FIELD_TOO_LONG` | 字符串字段超长（如 `description>200`、`reason>200`、`name>100`）；与各端点的专属 `*_TOO_LONG`（如 `SNAPSHOT_DESC_TOO_LONG`）并存，前者是通用兜底 | §5.1 `snapshot.create`（description，专属码 `SNAPSHOT_DESC_TOO_LONG` 优先）/ §7.4 `project.switchMode`（reason） |
| `SYSTEM_PERMISSION_DENIED` | `callerModule='manual'` 但调用方未经 SYSTEM 级授权（详见 §0.4 manual 校验三要素） | §5.1 `snapshot.create` / §7.3 `project.delete` |

> **使用优先级**：专属 DOMAIN 错误码 > 通用错误码。例：`snapshot.create` 的 `description>200` 应返回 `SNAPSHOT_DESC_TOO_LONG`（专属），而非 `FIELD_TOO_LONG`（通用）；`project.switchMode` 的 `reason>200` 因无专属码，回退到 `FIELD_TOO_LONG`。

> **与 [[03_ARCHITECTURE/data-model.md]] 的关系**：本族为 *APISPEC-SUPPLEMENT* 补充定义，data-model 未定义接口输入校验错误码（其职责为实体字段约束）；本族不与 data-model 字段约束冲突，仅作调用方分支处理依据。

### 8.5 跨 Agent 公共错误码（v0.4 增补，闭环 agent-comm §2.3.1 / §5.3 提请收录）

承接 [[04_API_SPEC/agent-comm.md]] §2.3.1 SPSAS（单项目单活动会话）不变量与 §5.3 跨 Agent 错误码透传链，v0.4 将以下 2 个跨 Agent 公共错误码正式收录于 SYSTEM 域（此前 agent-comm 以 *APISPEC-SUPPLEMENT* 标注"提请 §7.3 SYSTEM 域正式收录"，v0.4 §8 错误码体系即原 §7 顺延版本，现已闭环）。两者均归 SYSTEM 域（非单一业务 DOMAIN），因触发点跨多个 Agent / 服务模块。

| 错误码 | 含义 | 触发场景 | 处理建议 |
|--------|------|---------|---------|
| `SESSION_LOCK_CONTENTION` | 单项目单活动会话（SPSAS）不变量被违反——同一 `projectId` 已被另一活动会话持有写锁 | 用户在 B 窗口对已被 A 窗口占锁的 `projectId` 发起 `guide.chat`；`services/guide.ts#acquireProjectLock` 检测到 `_system/sessions/{projectId}.lock` 存在且 owner ≠ 当前 sessionId | HTTP 409 等价（状态/冲突）；**可重试**——等待 TTL（默认 30min）自动释放或用户手动关闭占用会话；payload `error.details` 含 `ownerSessionId` / `acquiredAt` / `ttlSeconds`；前端转化为通俗提示"该项目正被另一会话编辑，请先关闭或等待"（见 agent-comm §2.3.1 兜底链） |
| `GUIDE_INTERNAL_JUDGE_FAILED` | 向导Agent 内部调用裁判Agent 失败时的**包装错误码**（wrap code）——对外屏蔽内部 judge 错误细节 | `guide.confirm(prd/architecture/...)` 内部编排 `judge.evaluateDocs` 时后者返回错误（如 `JUDGE_LLM_TIMEOUT` / `JUDGE_PLANTUML_PARSE_FAILED`）；guide 把内部失败包装为本码对外暴露 | HTTP 5xx 等价（服务端失败）；**可重试**——多为 LLM 超时等服务端临时问题；payload `error.details` 含 `innerCode`（原 judge 错误码）+ `innerRequestId`（关联内部调用）；前端提示"审查服务暂时不可用，请稍后重试"，**不向终端用户暴露 innerCode**（见 agent-comm §5.3 嵌套示例） |

> **与 `SYSTEM_PERMISSION_DENIED` 的边界**（沿用 agent-comm §2.3.1）：三者同属 SYSTEM 域但互斥，校验顺序为 **身份 → 并发 → 桥接**：
> - `SYSTEM_PERMISSION_DENIED` = **身份层拒绝**（`callerModule='manual'` 但调用方非 SYSTEM 级上下文 → 拒绝执行，不读不写）；
> - `SESSION_LOCK_CONTENTION` = **并发层冲突**（调用方身份合法，但同 `projectId` 已被另一活动会话占锁 → 拒绝本次写，可重试）；
> - `GUIDE_INTERNAL_JUDGE_FAILED` = **桥接层失败**（身份与并发均合法，但内部跨 Agent 调用 judge 失败 → 包装返回，可重试）。

> **命名与归属说明**（*APISPEC-SUPPLEMENT*）：`GUIDE_INTERNAL_JUDGE_FAILED` 虽以 `GUIDE_` 前缀开头，但其语义是"跨 Agent 桥接包装"（guide 调 judge 失败的 wrap），非 guide 自身业务错误（guide 业务错误如 `GUIDE_INVALID_STAGE_TRANSITION`），故归 SYSTEM 域而非 GUIDE 域——与 agent-comm §5.3 原声明"属于 SYSTEM 域预留扩展"一致。此命名前缀与归属的既有张力已在 agent-comm 标注，v0.4 收录时**保持原命名**以避免破坏 agent-comm §5.3 既有的透传链引用与埋点归因。

---

## 9. 接口覆盖矩阵与一致性核对

### 9.1 接口覆盖矩阵（6 类 × 端点数）

| 类别 | 前缀 | 端点 | 端点数 | 错误码数 | 通信形态 | 架构模块（[[03_ARCHITECTURE/architecture.md]] §2） | 关联实体（[[03_ARCHITECTURE/data-model.md]]） |
|------|------|------|--------|---------|---------|-------------------|----------------------|
| 类1 向导↔编程 | `coder.*` | generateCode / applyFix / runGwt | 3 | 5+5+3 | 文件契约+函数 | 编程Agent引擎 | Project / DocumentMeta |
| 类2 前端↔向导 | `guide.*` | chat / previewPrototype / clickToFix / confirm | 4 | 4+3+4+3 | IPC+函数 | 前端UI层 + 向导Agent引擎 | Project / SessionContext / DocumentMeta |
| 类3 裁判判定 | `judge.*` | evaluateDocs / evaluateCode | 2 | 4+3 | 函数 | 裁判引擎 | DocumentMeta |
| 类4 快照管理 | `snapshot.*` | create / list / rollback / delete | 4 | 4+3+4+3 | 函数 | 快照管理器 | Snapshot / Project |
| 类5 埋点上报 | `telemetry.*` | emit / emitBatch / query | 3 | 4+3+3 | 函数(异步) | 埋点采集层 | TelemetryEvent |
| 类6 项目管理 | `project.*` | list / open / delete / switchMode | 4 | 3+3+4+5 | IPC+函数 | 项目元数据读写（Proma 平台层） | Project |
| **合计** | — | **20 端点** | **20** | **73 次出现** | — | 6 核心交互模块覆盖（边界见 §1.1） | 5 实体覆盖 |

> **错误码计数口径**：「73 次出现」为端点×错误码的累计出现次数（含跨端点复用：`SNAPSHOT_PROJECT_NOT_FOUND` 用于 §5.1+§5.2、`TELEMETRY_EVENT_TYPE_INVALID` 用于 §6.1+§6.2、`PROJECT_NOT_FOUND` 用于 §7.1+§7.2+§7.3+§7.4、`INPUT_INVALID` 用于 §7.1+§7.4、`SYSTEM_PERMISSION_DENIED` 用于 §5.1+§7.3、`PROJECT_INDEX_CORRUPT` 用于 §7.1+§7.2）；**唯一错误码数 = 68**（v0.4 新增 10：B5 `SYSTEM_PERMISSION_DENIED` + B6 `INPUT_INVALID`/`PROJECT_NOT_FOUND`/`FIELD_TOO_LONG` + §7 项目管理专属 6 个 `PROJECT_INDEX_CORRUPT`/`PROJECT_DIRECTORY_MISSING`/`PROJECT_DELETE_CONFIRMATION_REQUIRED`/`PROJECT_DELETE_HAS_ACTIVE_SESSION`/`PROJECT_MODE_SWITCH_FORBIDDEN`/`SNAPSHOT_MODE_SWITCH_FAILED`；另含跨 Agent 公共错误码 2 个 `SESSION_LOCK_CONTENTION`（SPSAS 单项目单活动会话并发冲突，agent-comm §2.3.1）/ `GUIDE_INTERNAL_JUDGE_FAILED`（guide.confirm 内部调 judge 失败 wrap，agent-comm §5.3），详见 §8.5，见 §8.3 总表去重）。

### 9.2 DoD self_check 核对表

| 核对项 | 结果 | 证据 |
|--------|------|------|
| 6 类核心交互模块覆盖，每类 ≥2 端点 | ✅ | §1.1 范围声明 + §9.1：3/4/2/4/3/4，最小值 2（类3）满足；router/项目创建/看板高阶聚合的处置见 §1.1；v0.4 已补类6 项目管理（§7） |
| 每接口 ≥3 错误码 | ✅ | §9.1 错误码数列均 ≥3 |
| 每接口含动词/调用方式/输入Schema/输出Schema/错误情况 | ✅ | §2~§7 每端点均含「动词/调用方式 + 输入 Schema 表 + 输出 Schema 表 + 错误情况表（≥3）」 |
| 与 [[03_ARCHITECTURE/architecture.md]] §2 模块输入/输出一致 | ✅ | 每类开头「架构依据」段逐条引用 [[03_ARCHITECTURE/architecture.md#2-模块划分]] 对应模块的输入/输出 |
| 与 [[03_ARCHITECTURE/data-model.md]] 5 实体字段对应 | ✅ | Project(directoryPath/totalTokenUsed/currentStage/mode)、Snapshot(snapshotId/triggerType/isCurrent/isHealthy)、TelemetryEvent(14 eventType/payload)、SessionContext(currentRole/backfillVersion)、DocumentMeta(directory/status/relativePath) 均逐字段引用；Project 字段含 mode，与 §7.4 switchMode 一致 |
| 14 事件类型 + payload | ✅ | §6 14 事件 payload 表与 [[03_ARCHITECTURE/data-model.md#4-实体三埋点事件telemetryevent]] 关键字段对齐 |
| 枚举值与上游逐项一致（stage 8 / triggerType 5 / role 4 / template 6 / eventType 14 / directory 8 / status 3 / mode 2） | ✅ | §3.4 / §5 / §3.1 / §2.2 / §6 / §4.1 / §7.4 逐值对照 [[03_ARCHITECTURE/data-model.md]] 对应章节；targetDirectory 刻意排除项见 §4.1；mode 枚举与 §3.4 一致 |
| 文件头元信息合规 | ✅ | 文档ID DOC-4.1 / v0.4 / 2026-07-15 / 已评审（G1-G5 收敛；v0.4 闭环 audit B3/B5/B6）/ 依赖三文档（arch v0.3、data-model v0.6、PRD v0.2，均带版本号） |
| 跨文档引用用相对路径 `[[...]]` | ✅ | 头部依赖行 + §2~§7 架构依据 + §9.1/§9.2 均使用 `[[...]]`（v0.1 裸路径已于 v0.2 全量包裹） |
| 上游留白处补充定义已标记 | ✅ | action/scope 枚举、newValue 子结构、流式契约、confirmType 映射、命名空间区分、manual SYSTEM 校验三要素、通用输入校验错误码族以 *APISPEC-SUPPLEMENT* 标记，见 §2.3/§3.1/§3.4/§0.4/§8.4 |
| stage 状态转移含 mode 维度校验 | ✅ | §3.4 confirmType↔stage 映射表 + mode 维度校验注记 |
| **B3 project.\* 端点覆盖（list/open/delete/switchMode 四端点）** | ✅ | §7 类6 项目管理接口四端点全定义，每个含动词+IPC channel（`project:list`/`open`/`delete`/`switchMode`）+输入Schema表+输出Schema表+错误情况表（≥3）；§1 总览表加类6行；§1.1 范围声明更新（项目创建仍归 Proma 平台层） |
| **B5 SYSTEM_PERMISSION_DENIED + manual 校验三要素** | ✅ | §0.4 校验三要素（判定依据+错误码+拒绝行为）+ §5.1 `snapshot.create` callerModule 字段说明与错误码表 + §7.3 `project.delete` 错误码表引用 + §8.3 总表 SYSTEM_PERMISSION_DENIED 行 |
| **B6 通用输入校验错误码族（INPUT_INVALID/PROJECT_NOT_FOUND/SNAPSHOT_NOT_FOUND/FIELD_TOO_LONG）** | ✅ | §8.4 错误码族声明（含 SNAPSHOT_NOT_FOUND 已存在于 §5.4）+ §7.1/§7.2/§7.3/§7.4 端点错误情况表引用 + §8.3 总表 SYSTEM 区段新增 INPUT_INVALID/FIELD_TOO_LONG |

---

---

## 10. 审查记录（v0.1 → v0.4，multi-sub-agent 洁净室评审）

> 评审机制：[[05_PROJECT_PLAN/workflow.md]] §2.2 + [[.context/设计阶段-文档产出清单与质量标准.md]] §1.4，G1-G5 五视角、≥3 评审子Agent 独立审查 → worker 自改 → 复审至 red 归零（≤3 轮）。本节为机制执行证据，供 nanju-A-commander 校验（非橡皮图章）。

### 10.1 评审主体与视角分配

| 角色 | 视角 | 范围 |
|------|------|------|
| nanju-A1r-worker（本 worker，GLM-5.2） | 审查主体 + 自改 + 收尾 | 汇总 findings、改文档、写审查记录 |
| review 子Agent-R1 | G1 完整性 + G3 可执行性 | 端点覆盖面、Schema 可对接性 |
| review 子Agent-R2 | G2 一致性 | 对照 arch §2/§7/§8 + data-model 5实体/14事件/枚举 + PRD §7.3/§12.4 |
| review 子Agent-R3 | G4 可读性 + G5 格式合规 | 结构/命名/引用/元信息 |

### 10.2 第 1 轮 findings（v0.1 草稿）

| 视角 | red | red 摘要 | yellow |
|------|-----|---------|--------|
| G1 完整性 | 4 | router 无接口却称全覆盖 / 缺项目CRUD / Phase2 截图字段缺 / §8.2 全覆盖声明存疑 | 1 |
| G3 可执行性 | 8 | 流式契约不全 / preModifySnapshotId 双源 / newValue 5 action 无结构 / error·errorMsg 不一致 / projectRoot·projectId 混用 / confirm 语义模糊 / 状态机缺 mode 维度 / 看板聚合不足 / 错误码区分度 | 5 |
| G2 一致性 | 3 | 快照物理路径与 data-model 多处打架 / targetDirectory 静默漏 02_UX_DESIGN·07_VERSIONS / action·scope 误称源自 arch §7 | 6 |
| G4 可读性 | 3 | architecture.md 引用三重不统一 / hardViolations.rule 命名冲突 / 端点引用双轨制 | 8 |
| G5 格式合规 | 4 | 头部依赖引用格式不统一 / 全文裸路径未包裹 / §8.2 self_check「引用均用[[]]」虚假陈述 / 文档ID 格式偏离惯例 | — |
| **合计** | **22** | | **20** |

### 10.3 v0.2 修正动作（22 red 全部处置）

| red | 处置 | 落点 |
|-----|------|------|
| R1-R-01/02/11/12 覆盖面 | §1.1 新增「范围声明」诚实化，router/项目CRUD/看板聚合/UX·VERSIONS 判定逐项给处置；§9.2「全覆盖」→「5 核心交互模块覆盖」（v0.4 进一步补类6，见 §7） | §1.1、§9.1、§9.2 |
| R1-R-03 截图字段 | §3.3 输入补 `screenshot`（phase2 条件必填） | §3.3 |
| R1-R-04 流式契约 | §3.1 新增「流式契约」子节（chunk/done/error/cancel） | §3.1 |
| R1-R-05 双源/来源 | §3.3 fixSpec.projectRoot 来源说明 + preModifySnapshotId 唯一来源 | §3.3、§0.3 |
| R1-R-06/R-10 confirm·mode | §3.4 新增 confirmType↔stage/快照/埋点映射表 + mode 维度校验注记 | §3.4 |
| R1-R-07 newValue | §2.3 新增 newValue 5 action 子结构表 | §2.3 |
| R1-R-08 命名 | §2.2 gwtResults `error?`→`errorMsg?`，与 §2.4 统一 | §2.2 |
| R1-R-09 标识 | §0.3 新增 projectRoot/projectId 使用规则 | §0.3 |
| R1-R-12 错误码区分 | §6.1 WRITE_FAILED/BUFFER_OVERFLOW 语义明确区分 | §6.1 |
| R2-R-01 快照路径 | §5.1 filePath 补 `workspace-files/` 前缀 + 声明以 data-model §1.2 为准（上游 §1.3 笔误提请修正） | §5.1 |
| R2-R-02 targetDirectory | §4.1 补「刻意排除 02_UX_DESIGN/07_VERSIONS/ROOT」说明 | §4.1 |
| R2-R-03 action/scope 出处 | §2.3 改为「字段名引自 arch §7，action/scope 值为本规范补充 *APISPEC-SUPPLEMENT*」 | §2.3 |
| R3-R-01 头部引用 | 头部依赖行三处统一为 `[[路径]] vX.Y（§章节）` | 头部 |
| R3-R-02 裸路径 | 全文裸路径（architecture.md/arch/data-model.md/data-model/PRD §X）批量包裹 `[[]]` | 全文 |
| R3-R-03 self_check 虚假 | §9.2「跨文档引用」证据做真（裸路径已全包裹）；元信息更新为 v0.2 | §9.2 |
| R3-R-04 引用三重不统一 | 全文统一为 `[[03_ARCHITECTURE/architecture.md]] §X`，删除 arch 缩写 | 全文 |
| R3-R-05 命名空间 | §8 新增「命名空间区分」注记，hardViolations.rule 与错误码分立 | §8 |
| R3-R-06 端点引用 | §3.3 统一为 `coder.applyFix（§2.3）` 形式 | §3.3 |
| R3-R-07 文档ID | 头部 `DOC-4.1（04-API-SPEC）`→`DOC-4.1`，对齐 arch/data-model 惯例 | 头部 |

### 10.4 第 2 轮复审（red 归零轨迹）

复审范围：22 red 是否全部在 v0.2 落实 + 是否引入新 red。
- 覆盖面 4 red：§1.1 范围声明 + §9.2 诚实化 → 已落实（处置透明）。
- 可执行性 8 red：screenshot / 流式契约 / newValue 表 / 命名统一 / 规则补充 / 错误码区分 → 全部补齐。
- 一致性 3 red：路径声明 + 刻意排除注记 + 出处措辞 → 全部修正（上游 data-model 内部不一致已标注「提请修正」，非本文档责任）。
- 可读性 3 red + 格式 4 red：引用统一 + 命名空间声明 + 裸路径全包裹 + 元信息更新 → 全部修正。
- 新 red 引入检查：v0.2 新增的 *APISPEC-SUPPLEMENT* 段（流式契约/newValue 表/映射表/命名空间）经复审自洽、与上游不冲突，未引入新 red。

**第 2 轮结论：red 归零（22/22 处置），yellow 20 项作为可选建议保留、不阻塞。G1-G5 收敛 → v0.2-已评审。**

### 10.5 升级项（提请上游 / Commander）

| 项 | 性质 | 建议 |
|----|------|------|
| data-model §1.3 `_system/snapshots/` 与 §1.2 `workspace-files/snapshots/` 冲突 | 上游内部不一致 | 提请 data-model 以 §1.2 布局图为准修正 §1.3 |
| data-model §3「用户不可手动创建」与诊断面板 `manual` 调用方 | 约束需松绑 | 提请 data-model §3 增「诊断面板例外」 |
| 13 事件缺 `architecture.confirmed` | 埋点设计缺口 | **已解决**：data-model v0.6 + PRD §12.4 + 本文 §6 已补第 14 事件 `architecture.confirmed`（2026-07-04，ISSUE-003 #3 闭环） |
| applyFix action 5 值 / scope 4 值 | arch §7 留白 | 提请 arch §7 后续确认或显式声明「由 api-spec 定义」 |

---

> 本规范为 MVP 阶段接口契约，所有调用均为本地函数/IPC，不引入网络层。后续若需引入 WebSocket（如流式原型协同）或跨进程消息总线，须按 §0.1 零依赖原则重新评审——该决策超出本文档定义的 6 类接口范围，须经 nanju-A-commander 批准（参见 brief.autonomy.must_ask）。

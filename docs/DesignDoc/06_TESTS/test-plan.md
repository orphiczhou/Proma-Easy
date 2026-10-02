# nanju 测试计划（Test Plan）

> 项目：向导Agent与编程Agent多智能体协同开发平台
> 文档ID：DOC-6.1 | 版本：v0.2 | 日期：2026-07-16 | 状态：草稿（待 G1-G5 自审收敛）
> 依赖：[[01_PRD/prd.md]] v0.2（§9 裁判双重约束 + §6.3 异常自愈 3 次→熔断→回滚 + §7.4 线性回滚 + §12.4 14 关键埋点）、[[03_ARCHITECTURE/architecture.md]] v0.3（§1 技术选型 Electron/React/TS、§2 七模块、§7 点选纠错、§8 模型-角色映射）、[[03_ARCHITECTURE/data-model.md]] v0.6（§4.3 14 eventType 枚举、§2.2 8 stage 状态机、§3 实体 Snapshot）
> 关联上游：[[04_API_SPEC/api-spec.md]] v0.4（§0~§8 共 20 端点 + 73 错误码次出现/66 唯一错误码 + B3/B5/B6）、[[04_API_SPEC/agent-comm.md]] v0.1（§2.3.1 SPSAS SESSION_LOCK_CONTENTION、§3 三 Agent 协作时序、§5 四层异常传播）、[[04_API_SPEC/events.md]] v0.1（§3 14 事件逐个 payload + §4 时序不变量 ORD-01~07）、[[04_API_SPEC/data-model-api.md]] v0.1（§7 状态机 + §8 14 payload schema）、[[04_API_SPEC/frontend-backend-api.md]] v0.1（§1.2 16+4 IPC channel + §3.1 流式四事件 + §4.1 B5 前端 IPC 拒绝契约）、[[05_PROJECT_PLAN/sprint-plan.md]] v0.2（§3.1/§3.2/§3.3 S1-S3 验收标准）、[[05_PROJECT_PLAN/workflow.md]] v0.2（§3.2 异常自愈子流程 + §2.2 G1-G5 评审机制）、[[05_PROJECT_PLAN/team-config.md]]（§2.1 MVP 三角色：全栈/测试/审查）
> 一致性声明：本文档 §2 端点契约矩阵的 20 端点（3+4+2+4+3+4）与 [[04_API_SPEC/api-spec.md]] v0.4 §1 + §9.1 矩阵完全对齐；§3 14 events 触发验证与 [[04_API_SPEC/events.md]] §1 总览表逐条对齐；§4 异常自愈子流程与 [[05_PROJECT_PLAN/workflow.md]] §3.2 图 3-1 + [[01_PRD/prd.md]] §6.3 完全对齐；§5 Sprint S1-S3 验收清单与 [[05_PROJECT_PLAN/sprint-plan.md]] §3 逐条对齐；§6 权限&边界测试覆盖 [[04_API_SPEC/api-spec.md]] §0.4 B5 SYSTEM 三要素 + §8.4 B6 输入校验错误码族 + [[04_API_SPEC/agent-comm.md]] §2.3.1 B4 SPSAS。所有测试用例 ID 采用三段式 `TC-<DOMAIN>-<NNN>`，全程唯一。

---

## §0 元信息（依赖、基准、范围）

### §0.1 本文档定位

本文档是 nanju 项目设计阶段→实现阶段的**测试契约桥梁**。它定义了平台自身代码（层 1）与平台运行时为用户项目执行的 GWT 验收（层 2）的双层测试体系，覆盖 PRD §9 裁判验收 + 04_API_SPEC v0.4 全部 20 端点契约 + 14 events 触发链 + 异常自愈熔断回滚 + Sprint S1-S3 可运行增量验收 + B5/B6/B4 三组边界测试。

| 维度 | 层 1（平台自身代码） | 层 2（平台运行时为用户项目执行 GWT） |
|------|---------------------|------------------------------------|
| 测试对象 | 本平台 Electron + React + TypeScript 源码（路由层/Prompt 加载/角色管理/裁判引擎/PlantUML 解析/UI/Jotai 状态/services 层 6 模块） | 平台为用户项目生成的 GWT Feature + step definitions |
| 工具约束 | devDependencies（Vitest/Playwright/jest-cucumber 备选），不进入运行时分发 | **零依赖自研**（[[03_ARCHITECTURE/architecture.md]] §1.2） |
| 典型用例 | TC-CODER-001（coder.generateCode happy path）等 TC-*-NNN 系列 | 由向导Agent 后台角色产出的 `06_TESTS/features/*.feature`，本文档不编写 |
| 触发频率 | PR 提交（单元）/ nightly（集成）/ release 前（E2E） | 用户项目裁判 Agent 调用 `coder.runGwt` 时 |

### §0.2 v0.1 → v0.2 重写说明

v0.1（2026-07-07）只覆盖 PRD §8 BDD+GWT 工具选型 + 测试金字塔，**未覆盖**端点契约矩阵、events 触发链、异常自愈熔断、Sprint S1-S3 验收、B5/B6/B4 边界测试。v0.2 按 brief 大纲全面重写为 7 章节 + 元信息 + 一致性核对 + 审查记录，对照 04_API_SPEC v0.4 / 05_PROJECT_PLAN v0.2 / 01_PRD §9 + §6.3 全部上游基准。

### §0.3 范围边界（in_scope / out_of_scope）

**in_scope**：

| 章节 | 内容 | 上游依据 |
|------|------|---------|
| §1 | 测试策略（金字塔比例 / 层次划分 / 维度对齐 PRD §9 / 工具栈选型） | PRD §9 + architecture §1 |
| §2 | 20 端点契约测试矩阵（输入/输出/错误码/触发的 events） | api-spec.md v0.4 §2~§7 |
| §3 | 14 events 触发验证（触发端点 × payload 字段 × 时序不变量 ORD-01~07） | events.md §1 + §4 |
| §4 | 异常自愈 & 熔断 & 回滚测试（3 次自修复 → 熔断 → 回滚链路） | workflow.md §3.2 + PRD §6.3 + agent-comm.md §5 |
| §5 | Sprint S1-S3 验收清单（每 Sprint 验收标准 → 测试用例集） | sprint-plan.md §3.1/§3.2/§3.3 |
| §6 | 权限 & 边界测试（B5 manual SYSTEM / B6 输入错误码族 / B4 SPSAS 并发防护） | api-spec.md §0.4 + §8.4 + agent-comm.md §2.3.1 |
| §7 | 测试基础设施（目录结构 / Mock 策略 / CI 集成） | architecture §1 + frontend-backend-api.md §7 |

**out_of_scope**（不在本文档，由其他文档/阶段承担）：

| 不写项 | 归属 |
|--------|------|
| GWT Feature 文件实际编写 | [[06_TESTS/features/*.feature]]（由 C2/C3 worker 按 P0 故事产出） |
| step definitions 实际编写 | 编码阶段 `06_TESTS/step-definitions/`（brief out_of_scope） |
| 实际测试代码（.test.ts） | 编码阶段 `test/unit/`、`test/integration/`、`test/e2e/`（brief out_of_scope） |
| Proma 基座代码测试 | proma-source 既有测试套件（基座只读，不重测） |
| 修改 04/05 已发布文档 | 仅引用，不改 |

---

## §1 测试策略

### §1.1 测试金字塔比例

```text
            ▲
           / \
          /E2E\            10%   Playwright + Electron（关键用户旅程 + 跨 Agent 协作）
         /─────\
        /  集成  \          20%   IPC / 子进程 / 文件系统 / 三 Agent 协作链路
       /──────────\
      /    单元     \        70%   Vitest（路由层 / Prompt 拼装 / 裁判硬约束 / PlantUML 解析 / 错误码分支）
     /──────────────\
```

| 层 | 占比 | 工具 | 单例耗时（毫秒） | 触发时机 | 覆盖维度 |
|----|------|------|----------------|---------|---------|
| 单元 | 70% | Vitest + React Testing Library | <100 ms | PR / 保存 | 路由层角色切换、Prompt 加载拼装、裁判硬约束 8 项（[[01_PRD/prd.md]] §9.2）、PlantUML 解析（TS Compiler API）、错误码分支处理、Jotai atom 状态转移 |
| 集成 | 20% | Vitest（node 环境）+ 自研 IPC harness + fs tmpdir | 100~1000 ms | PR + nightly | Electron IPC 双进程（[[04_API_SPEC/frontend-backend-api.md]] §1.1）、编程Agent 子进程沙箱、文件系统读写（`_meta.json`/`workspace-files/`/JSONL）、三 Agent 协作时序（[[04_API_SPEC/agent-comm.md]] §3）、Session Restart 六步 |
| E2E | 10% | Playwright（Electron 模式 `_electron.launch`） | 5000~30000 ms | nightly + release 前 | 关键用户旅程（US-U01~U08 P0 故事）、跨 Agent 完整链路（mode-select → delivered）、异常自愈熔断 → 用户安抚文案、点选纠错 MVP |

### §1.2 比例依据

- **70% 单元**：平台是 Agent 编排逻辑密集型——路由层 4 角色切换、6 services 模块的纯函数逻辑、裁判硬约束 8 项规则匹配（PRD §9.2）、PlantUML AST 提取、错误码 66 唯一枚举的分支处理，均为纯逻辑、覆盖率上限高、反馈最快，应占绝对主体。
- **20% 集成**：跨边界协作——Electron `ipcMain.handle` / `ipcRenderer.invoke` 桥（[[04_API_SPEC/frontend-backend-api.md]] §1.1）、编程Agent 子进程沙箱（L0 文件隔离 + L1 资源限制，[[03_ARCHITECTURE/architecture.md]] §6）、`_meta.json` 原子写（safe-file + rename）、JSONL 埋点追加、Session Restart 六步序列化/反序列化、SPSAS 锁竞争。这些不能纯单元化，也不必走完整 E2E。
- **10% E2E**：Electron 应用启动秒级、Playwright 启动 Electron 实例昂贵且易 flaky。仅覆盖 [[02_UX_DESIGN/user-flows.md]] P0 旅程 + 异常自愈熔断的用户感知链路（安抚文案 + 时间轴回滚），对齐 US-U01~U08 八条 P0 故事。

### §1.3 测试维度（对齐 PRD §9 双重约束 + 裁判严格度）

| 维度 | 单元 | 集成 | E2E | 上游依据 |
|------|------|------|-----|---------|
| 功能正确性 | ✅ services 层 6 模块每个端点 happy path + 错误码分支 | ✅ IPC 桥往返 + 子进程执行结果 | ✅ 端到端用户故事 US-U01~U08 | PRD §9.1 裁判定位 |
| 容错（异常自愈） | ✅ `coder.runGwt` 自修复循环 1/2/3 次策略切换 | ✅ 3 次失败 → 熔断 → snapshot.rollback + guide 通俗化通知 | ✅ 用户看到安抚文案 + 时间轴可见回滚 | PRD §6.3 + workflow.md §3.2 |
| 容错（并发防护） | ✅ `acquireProjectLock` TTL 过期 + 强占逻辑 | ✅ SPSAS 不变量违反 → SESSION_LOCK_CONTENTION 双窗口冲突 | — | agent-comm.md §2.3.1 |
| 安全（权限边界） | ✅ `callerModule='manual'` 校验三要素 + token 比对 | ✅ 前端 IPC 拒绝 + 主进程兜底两道防线 | — | api-spec.md §0.4 B5 |
| 安全（沙箱边界） | ✅ L0 路径校验 + L1 资源限制配置 | ✅ 子进程超时 SIGKILL + 内存上限 | — | architecture §6 + api-spec.md §2.3 CODER_FIX_OUT_OF_SCOPE |
| 性能（Token 经济） | — | ✅ `tokensUsed` 累加 Project.totalTokenUsed 一致性 | — | PRD §12 + events.md §3.9 |
| 兼容（跨平台） | — | — | ✅ Windows/macOS/Linux 三平台 Electron 启动 | architecture §1.1 |
| 数据完整性（埋点） | ✅ 14 events payload schema 校验 | ✅ JSONL 原子追加 + 跨月分片 + 行级容错 | — | events.md §3 + §5 |
| 时序不变量 | — | ✅ ORD-01~07 七条事件时序约束 | — | events.md §4.3 |

### §1.4 工具栈选型

| 工具 | 用途 | 选型理由 |
|------|------|---------|
| **Vitest** ^3.x | 单元 + 集成测试运行器 | Vite 生态原生、与 React + TS 项目零配置集成、`vi.mock`/`vi.fn` 强大、单例 <100ms |
| **React Testing Library** ^16.x | 组件单元测试 | 面向用户视角断言（"用户能看到 X"），与 Jotai atom + IPC mock 配合自然 |
| **Playwright** ^1.4x（Electron 模式） | E2E | 官方 `_electron.launch({ executablePath: electron.app.getPath('exe') })` 跨平台；Electron 39 兼容性需在 Sprint S1 实现期 spike 验证（若不兼容则降级 Electron 主版本或改用 Spectron 备选） |
| **自研 IPC harness** | 集成测试模拟 `ipcMain.handle` / `ipcRenderer.invoke` | Vitest 无内置 Electron 桥，需在 node 环境下模拟双进程；不依赖真实 Electron 启动，秒级启动 |
| **自研 GWT runner** | 层 2 运行时为用户项目执行 GWT | [[03_ARCHITECTURE/architecture.md]] §1.2 零依赖原则——LLM 原生理解 GWT 语义 + 正则切分 Feature/Scenario/Step；TS Compiler API 提取 step 签名（与 PlantUML 解析同源） |
| **tsx**（devDep） | 集成测试运行 TS 脚手 | Vitest 内置 TS 支持，无需 tsx；仅在 Vitest 外的 fixture 生成脚本使用 |

**否决项**：

- **Cucumber-JS**：运行时重依赖（cucumber 包族），违反 [[03_ARCHITECTURE/architecture.md]] §1.2 零依赖原则，不进入层 2 运行时分发。
- **SpecFlow**：.NET 技术栈，与本项目 Electron + React + TS 不符。
- **Jest**：与 Vite 生态切换成本高，Vitest 已是更优选。

### §1.5 测试用例 ID 命名规范

全程采用三段式 `TC-<DOMAIN>-<NNN>`：

| DOMAIN | 范围 | 示例 |
|--------|------|------|
| `CODER` | 类 1 编程Agent（3 端点） | TC-CODER-001 = coder.generateCode happy path |
| `GUIDE` | 类 2 向导Agent（4 端点） | TC-GUIDE-014 = guide.confirm mode=quick toStage=planning 拒绝 |
| `JUDGE` | 类 3 裁判（2 端点） | TC-JUDGE-021 = evaluateDocs PRD_REQUIRED_FIELD_MISSING |
| `SNAPSHOT` | 类 4 快照（4 端点） | TC-SNAPSHOT-031 = create callerModule='manual' SYSTEM_PERMISSION_DENIED |
| `TELEMETRY` | 类 5 埋点（3 端点） | TC-TELEMETRY-041 = emit TELEMETRY_BUFFER_OVERFLOW |
| `PROJECT` | 类 6 项目管理（4 端点） | TC-PROJECT-051 = list filter 非法 INPUT_INVALID |
| `EVENT` | 14 events 触发验证 | TC-EVENT-061 = prd.confirmed 触发链路 |
| `EXCEPT` | 异常自愈熔断回滚 | TC-EXCEPT-075 = 3 次自修复失败 → 熔断 → rollback |
| `SPRINT` | Sprint S1-S3 验收 | TC-SPRINT-081 = S1-US-U01 模式选择 |
| `BOUND` | 权限边界（B5/B6/B4） | TC-BOUND-101 = SPSAS 双窗口冲突 |
| `INFRA` | 测试基础设施 | TC-INFRA-121 = CI 离线运行 |

---

## §2 端点契约测试矩阵（20 端点 × 输入/输出/错误码/events）

本节按 [[04_API_SPEC/api-spec.md]] v0.4 §1 接口分类总览的 6 类 20 端点逐个给出测试矩阵。每个端点至少覆盖：① happy path（成功路径）；② 4xx 客户端错误（含枚举越界/UUID 非法/必填缺失/状态非法）；③ 5xx 服务端失败（LLM/IO/子进程失败）；④ Schema 校验（输入/输出字段必填性 + 类型）；⑤ 触发的 telemetry events。

### §2.1 类 1：coder.* 端点（3 个）

#### TC-CODER-001~010：coder.generateCode（端点 1.1，[[04_API_SPEC/api-spec.md#22-端点-11-codergeneratecode文档代码生成]]）

| 用例 ID | 场景 | 输入要点 | 期望输出 / 错误码 | 触发 events |
|---------|------|---------|-----------------|------------|
| TC-CODER-001 | happy path 首次生成 | `stage='coding'`, `template='web-fullstack'`, `documentPaths` 含 7 目录, `outputDir='{projectRoot}/_code/'` | `data.outputFiles.length > 0`、`testReport.total > 0`、`autofixAttempts ∈ [0,3]`、`snapshotCreated=true`（init 快照触发） | `coding.executed(success=true)`、`autofix.triggered × N`（N=autofixAttempts） |
| TC-CODER-002 | happy path 部分重生成 | `stage='coding'`, `documentPaths` 仅 2 个文件 | 同上 + `taskType='partial-regen'`（埋点 payload） | 同 TC-CODER-001 |
| TC-CODER-003 | CODER_DOC_NOT_FOUND | `documentPaths=['99_NONEXIST/foo.md']` | `error.code='CODER_DOC_NOT_FOUND'`，4xx 不可重试 | `coding.executed(success=false, errorCode='CODER_DOC_NOT_FOUND')` |
| TC-CODER-004 | CODER_DOC_CONTRACT_VIOLATION | `_meta.json#documents[].directory='99_UNKNOWN'`（越出 8 值枚举） | `error.code='CODER_DOC_CONTRACT_VIOLATION'` | `coding.executed(success=false, errorCode='CODER_DOC_CONTRACT_VIOLATION')` |
| TC-CODER-005 | CODER_GENERATION_FAILED | mock LLM 抛错且 3 次自修复未通过 | `error.code='CODER_GENERATION_FAILED'`，5xx 可重试 | `coding.executed(success=false)` + `autofix.triggered × 3 (result='circuit-broken')` |
| TC-CODER-006 | CODER_SANDBOX_TIMEOUT | mock 子进程墙钟 > 180s | `error.code='CODER_SANDBOX_TIMEOUT'`，408 可重试 | `coding.executed(success=false, errorCode='CODER_SANDBOX_TIMEOUT')` |
| TC-CODER-007 | CODER_GWT_COMPILE_ERROR | `06_TESTS/features/broken.feature` 语法错 | `error.code='CODER_GWT_COMPILE_ERROR'` | `coding.executed(success=false)` |
| TC-CODER-008 | Schema 校验 - projectRoot 必填 | 缺 `projectRoot` | `error.code='INPUT_INVALID'`（B6 通用错误码族） | — |
| TC-CODER-009 | teamConfigPath 长期迭代型必填 | `template='web-fullstack'` 但 mode=iterative 且 `teamConfigPath` 缺省 | 实现侧校验：返回 `INPUT_INVALID` 或允许（由 coder 服务层决定；本测试记录实际行为） | — |
| TC-CODER-010 | outputDir 必须固定 `_code/` | `outputDir='{projectRoot}/other/'` | 实现侧校验：拒绝（路径越界）→ `CODER_FIX_OUT_OF_SCOPE` 或允许覆盖 | — |

#### TC-CODER-011~020：coder.applyFix（端点 1.2，[[04_API_SPEC/api-spec.md#23-端点-12-coderapplyfix点选纠错执行]]）

| 用例 ID | 场景 | 输入要点 | 期望输出 / 错误码 | 触发 events |
|---------|------|---------|-----------------|------------|
| TC-CODER-011 | happy path action=update | `target.dataAiId` 匹配, `action='update'`, `newValue={attribute:'disabled', value:false}`, `scope='element'`, `preModifySnapshotId=N` | `data.modifiedFiles.length=1`、`diffSummary` 非空、`previewHtml` 含新 `data-ai-id`、`success=true` | `click.fix(success=true)`（由上游 guide.clickToFix 上报） |
| TC-CODER-012 | happy path action=restyle | `action='restyle'`, `newValue.cssProps={'color':'#fff'}` | 同上 | 同上 |
| TC-CODER-013 | CODER_FIX_PRE_SNAPSHOT_MISSING | `preModifySnapshotId=99999`（不存在） | `error.code='CODER_FIX_PRE_SNAPSHOT_MISSING'`，4xx 不可重试 | — |
| TC-CODER-014 | CODER_TARGET_NOT_FOUND | `target.dataAiId='non-existent-id'` | `error.code='CODER_TARGET_NOT_FOUND'` | `click.fix(success=false)` |
| TC-CODER-015 | CODER_FIX_OUT_OF_SCOPE | mock 修改触及 `_code/` 外文件 | `error.code='CODER_FIX_OUT_OF_SCOPE'`，403 不可重试 | `click.fix(success=false)` |
| TC-CODER-016 | CODER_FIX_APPLY_FAILED | mock LLM 补丁语法错 | `error.code='CODER_FIX_APPLY_FAILED'`，5xx 可重试 | `click.fix(success=false)` |
| TC-CODER-017 | CODER_FIX_ACTION_INVALID | `action='unknown'`（不在 5 值枚举） | `error.code='CODER_FIX_ACTION_INVALID'` | — |
| TC-CODER-018 | newValue 条件必填 | `action='insert'` 但 `newValue` 缺失 | `error.code='INPUT_INVALID'`（通用错误码） | — |
| TC-CODER-019 | scope 越界 | `scope='unknown'`（不在 4 值枚举） | `error.code='INPUT_INVALID'` | — |
| TC-CODER-020 | delete action 忽略 newValue | `action='delete'`, `newValue=<anything>` | `success=true`，`newValue` 被忽略 | `click.fix(success=true)` |

#### TC-CODER-021~028：coder.runGwt（端点 1.3，[[04_API_SPEC/api-spec.md#24-端点-13-coderrungwt-gwt-测试与自修复]]）

| 用例 ID | 场景 | 输入要点 | 期望输出 / 错误码 | 触发 events |
|---------|------|---------|-----------------|------------|
| TC-CODER-021 | happy path 全部通过 | `featurePaths=['user-login.feature']`, `enableAutofix=true` | `data.allPassed=true`、`autofixLog=[]`、`triggeredSnapshot=false` | — |
| TC-CODER-022 | 启用自修复第 1 次成功 | mock 第 1 次 GWT 失败 → autofix 修复 → 第 2 次通过 | `data.allPassed=true`、`autofixLog.length=1`、`autofixLog[0].fixedScenarios.length > 0` | `autofix.triggered(attemptNumber=1, result='success')` |
| TC-CODER-023 | 启用自修复第 3 次成功 | mock 前 2 次失败 → 第 3 次通过 | `autofixLog.length=3`，`allPassed=true` | `autofix.triggered × 3`（前两次 result='partial'，第三次 result='success'） |
| TC-CODER-024 | 3 次自修复失败熔断 | mock 3 次全失败 | `error.code='CODER_AUTOFIX_EXHAUSTED'`，5xx 可重试；触发 `snapshot.rollback(lastHealthy)` + guide 通俗化通知 | `autofix.triggered × 3 (result='circuit-broken' 最后一次)` |
| TC-CODER-025 | enableAutofix=false 失败立即返回 | `enableAutofix=false`, mock GWT 失败 | `data.allPassed=false`，不触发熔断 | — |
| TC-CODER-026 | CODER_FEATURE_NOT_FOUND | `featurePaths=['99_NONEXIST/missing.feature']` | `error.code='CODER_FEATURE_NOT_FOUND'` | — |
| TC-CODER-027 | CODER_GWT_RUNNER_ERROR | mock 自研 GWT runner 抛异常 | `error.code='CODER_GWT_RUNNER_ERROR'`，5xx 可重试 | — |
| TC-CODER-028 | triggeredSnapshot=true 触发 pre-error 快照 | mock 失败 + enableAutofix=true 触发 pre-error 快照 | `data.triggeredSnapshot=true` | `autofix.triggered` 触发链路 |

### §2.2 类 2：guide.* 端点（4 个）

#### TC-GUIDE-029~040：guide.chat（端点 2.1，流式，[[04_API_SPEC/api-spec.md#31-端点-21-guidechat-用户输入-agent-回复-流式]]）

| 用例 ID | 场景 | 输入要点 | 期望输出 / 错误码 | 触发 events |
|---------|------|---------|-----------------|------------|
| TC-GUIDE-029 | happy path 单轮对话无角色切换 | `role='requirement-analyst'`, `message.text='我想做读书笔记'`, `roundNumber=1` | 流式 chunk → done；`roleSwitched=false`；`tokensUsed > 0` | `dialog.submitted(roundNumber=1)` |
| TC-GUIDE-030 | happy path 触发角色切换 | 模拟 requirement-analyst 完成判定，`roleSwitched=true` | 流式 done 含 `newRole='ux-advisor'` | `dialog.submitted` + `role.switched(fromRole='requirement-analyst', toRole='ux-advisor', triggerReason='prd-confirmed')` |
| TC-GUIDE-031 | 流式 cancel | invoke 后立即 cancel | Promise resolve 部分文本；已发送 chunk 不回收 | `dialog.submitted`（按已生成部分） |
| TC-GUIDE-032 | 流式 error 双路到达 | mock LLM 失败 | `guide:chat:error` 事件 + Promise reject 携带同 requestId | — |
| TC-GUIDE-033 | GUIDE_PROJECT_NOT_FOUND | `projectId='non-existent-uuid'` | `error.code='GUIDE_PROJECT_NOT_FOUND'`，4xx 不可重试 | — |
| TC-GUIDE-034 | GUIDE_ROLE_INVALID | `role='unknown-role'` | `error.code='GUIDE_ROLE_INVALID'` | — |
| TC-GUIDE-035 | GUIDE_MODEL_UNAVAILABLE | mock LLM API 503 | `error.code='GUIDE_MODEL_UNAVAILABLE'`，5xx 可重试 | — |
| TC-GUIDE-036 | GUIDE_CONTEXT_BACKFILL_FAILED | mock `_system/sessions/{projectId}.json` 读取失败 | `error.code='GUIDE_CONTEXT_BACKFILL_FAILED'` | — |
| TC-GUIDE-037 | chunk/done 复用 channel | 订阅 `guide:chat:chunk` 一次 | `chunk.type='delta'` 多次 + `chunk.type='done'` 一次（含 `final`） | — |
| TC-GUIDE-038 | requestId 关联去重 | 同 tab 多次 invoke | 每个回调按 requestId 过滤，不串流 | — |
| TC-GUIDE-039 | 订阅生命周期清理 | Promise settle 后 `removeListener` | 无内存泄漏（vitest 检测 `MaxListeners` 警告） | — |
| TC-GUIDE-040 | images 字段可选 | `message.images=['data:image/png;base64,...']` | 处理图片附件 | `dialog.submitted(containsImage=true)` |

#### TC-GUIDE-041~046：guide.previewPrototype / guide.clickToFix / guide.confirm

| 用例 ID | 场景 | 输入要点 | 期望输出 / 错误码 | 触发 events |
|---------|------|---------|-----------------|------------|
| TC-GUIDE-041 | previewPrototype happy path | `wireframePath='02_UX_DESIGN/wireframes/login.html'` | `data.html` 含 `data-ai-id`/`data-ai-type`、`annotatedElements.length > 0` | — |
| TC-GUIDE-042 | previewPrototype GUIDE_STAGE_MISMATCH | `currentStage='requirements'` | `error.code='GUIDE_STAGE_MISMATCH'`，409 | — |
| TC-GUIDE-043 | clickToFix phase1 happy path | `phase='phase1'`, `dataAiId`/`dataAiType` 合法 | `data.fixSpec` 含完整 5 字段、`preModifySnapshotId > 0`（前置 pre-modify 快照已创建） | `click.fix(success=true)`（applyFix 后触发） |
| TC-GUIDE-044 | clickToFix phase2 视觉模型 | `phase='phase2'`, `screenshot='base64...'` | `data.fixSpec` + `confidence` 数值 | `click.fix` |
| TC-GUIDE-045 | clickToFix GUIDE_ELEMENT_NO_AI_ID | 元素无 `data-ai-id` 且 `phase='phase1'` | `error.code='GUIDE_ELEMENT_NO_AI_ID'` | — |
| TC-GUIDE-046 | clickToFix GUIDE_VISION_MODEL_FAILED | phase2 视觉模型调用失败 | `error.code='GUIDE_VISION_MODEL_FAILED'` | — |

#### TC-GUIDE-047~055：guide.confirm（端点 2.4，[[04_API_SPEC/api-spec.md#34-端点-24-guideconfirm确认-prd-原型-架构]]）

| 用例 ID | 场景 | 输入要点 | 期望输出 / 错误码 | 触发 events |
|---------|------|---------|-----------------|------------|
| TC-GUIDE-047 | confirmType=prd 两型均同 | `confirmType='prd', fromStage='requirements', toStage='prototype'` | `accepted=true`、`snapshotId > 0`（confirm 快照）、`sessionRestarted=true`、`telemetryEmitted=['prd.confirmed']` | `prd.confirmed` + `role.switched(triggerReason='prd-confirmed')` |
| TC-GUIDE-048 | confirmType=prototype happy | `confirmType='prototype', fromStage='prototype', toStage='architecture'` | 同上 | `prototype.confirmed` + `role.switched(triggerReason='prototype-confirmed')` |
| TC-GUIDE-049 | confirmType=architecture iterative | `mode='iterative'`, `toStage='planning'` | `accepted=true` | `architecture.confirmed(toStage='planning')` + `role.switched(triggerReason='architecture-confirmed')` |
| TC-GUIDE-050 | confirmType=architecture quick 跳 planning | `mode='quick'`, `toStage='coding'` | `accepted=true` | `architecture.confirmed(toStage='coding')` |
| TC-GUIDE-051 | GUIDE_INVALID_STAGE_TRANSITION 跳阶段 | `fromStage='requirements', toStage='architecture'`（跳 prototype） | `error.code='GUIDE_INVALID_STAGE_TRANSITION'`，409 | — |
| TC-GUIDE-052 | mode 维度校验 quick toStage=planning 拒绝 | `mode='quick', confirmType='architecture', toStage='planning'` | `error.code='GUIDE_INVALID_STAGE_TRANSITION'`，`details` 含 `mode='quick'` | — |
| TC-GUIDE-053 | mode 维度校验 iterative toStage=coding 拒绝 | `mode='iterative', confirmType='architecture', toStage='coding'` | `error.code='GUIDE_INVALID_STAGE_TRANSITION'` | — |
| TC-GUIDE-054 | GUIDE_DOC_NOT_CONFIRMED | 待确认文档 status='draft' | `error.code='GUIDE_DOC_NOT_CONFIRMED'`，409 | — |
| TC-GUIDE-055 | GUIDE_SNAPSHOT_CONFIRM_FAILED | mock snapshot.create confirm 失败 | `error.code='GUIDE_SNAPSHOT_CONFIRM_FAILED'`，5xx 可重试 | — |

### §2.3 类 3：judge.* 端点（2 个）

#### TC-JUDGE-056~068：judge.evaluateDocs / judge.evaluateCode（[[04_API_SPEC/api-spec.md#4-类3裁判agent判定接口]] §4）

| 用例 ID | 场景 | 输入要点 | 期望输出 / 错误码 | 触发 events |
|---------|------|---------|-----------------|------------|
| TC-JUDGE-056 | evaluateDocs happy path 全过 | `targetDirectory='all'`, 所有文档 status >= 'review' | `verdict='pass'`, `hardViolations=[]`, `softSuggestions` 可空 | `judge.verdict(passed=true, evaluationTarget='docs')` |
| TC-JUDGE-057 | PRD_REQUIRED_FIELD_MISSING | mock PRD 缺"目标用户"段 | `verdict='reject'`, `hardViolations[0].rule='PRD_REQUIRED_FIELD_MISSING'`, `severity='critical'` | `judge.verdict(passed=false, violationTypes=['PRD_REQUIRED_FIELD_MISSING'])` |
| TC-JUDGE-058 | ARCHITECTURE_DOC_INCOMPLETE | mock architecture.md 缺"模块依赖关系"段（agent-comm.md §4.4 提请收录） | `hardViolations[0].rule='ARCHITECTURE_DOC_INCOMPLETE'`, `details.missingSections` 含 'moduleDependency' | `judge.verdict(passed=false)` |
| TC-JUDGE-059 | PLANTUML_SYNTAX_INVALID | class-diagram.puml 缺 `@enduml` | `hardViolations[0].rule='PLANTUML_SYNTAX_INVALID'` | `judge.verdict(passed=false)` |
| TC-JUDGE-060 | API_SCHEMA_INCOMPLETE | api-spec.md 某端点缺 Response Schema | `hardViolations[0].rule='API_SCHEMA_INCOMPLETE'` | `judge.verdict(passed=false)` |
| TC-JUDGE-061 | SPRINT_GRANULARITY_INVALID | sprint-plan.md 某 Sprint > 2 周 | `hardViolations[0].rule='SPRINT_GRANULARITY_INVALID'` | `judge.verdict(passed=false)` |
| TC-JUDGE-062 | ROLE_RESPONSIBILITY_OVERLAP | team-config.md 两角色职责冲突 | `hardViolations[0].rule='ROLE_RESPONSIBILITY_OVERLAP'` | `judge.verdict(passed=false)` |
| TC-JUDGE-063 | GWT_FEATURE_MISSING | 某 PRD 功能项无对应 .feature | `hardViolations[0].rule='GWT_FEATURE_MISSING'` | `judge.verdict(passed=false)` |
| TC-JUDGE-064 | JUDGE_DOC_NOT_FOUND | targetDirectory 内无 status >= review 文档 | `error.code='JUDGE_DOC_NOT_FOUND'`，4xx | — |
| TC-JUDGE-065 | JUDGE_DOC_STATUS_INVALID | 文档 status='draft' | `error.code='JUDGE_DOC_STATUS_INVALID'`，409 | — |
| TC-JUDGE-066 | JUDGE_LLM_TIMEOUT | mock 软约束 LLM 60s 超时 | `error.code='JUDGE_LLM_TIMEOUT'`，408 可重试 | — |
| TC-JUDGE-067 | evaluateCode happy path class-consistency | `codeDir='_code/'`, `classDiagramPath='03_ARCHITECTURE/class-diagram.puml'` | `verdict='pass'`, `classConsistency.matchedClasses.length > 0`, `missingInCode=[]` | `judge.verdict(evaluationTarget='code')` |
| TC-JUDGE-068 | JUDGE_CLASS_DIAGRAM_MISSING | `classDiagramPath='non-existent.puml'` | `error.code='JUDGE_CLASS_DIAGRAM_MISSING'` | — |

> **targetDirectory 刻意排除项**（[[04_API_SPEC/api-spec.md#41-端点-31-judgeevaluatedocs文档体系判定]] §4.1 注）：`02_UX_DESIGN` / `07_VERSIONS` / `ROOT` 走人工评审，本测试矩阵不覆盖。

### §2.4 类 4：snapshot.* 端点（4 个）

#### TC-SNAPSHOT-069~084（[[04_API_SPEC/api-spec.md#5-类4快照管理接口]] §5）

| 用例 ID | 场景 | 输入要点 | 期望输出 / 错误码 | 触发 events |
|---------|------|---------|-----------------|------------|
| TC-SNAPSHOT-069 | create happy path callerModule=coder | `triggerType='init', callerModule='coder'` | `data.snapshotId >= 1`、`isCurrent=true`、`previousCurrentCleared=true` | — |
| TC-SNAPSHOT-070 | create callerModule=guide confirm | `triggerType='confirm', callerModule='guide'` | 同上 | — |
| TC-SNAPSHOT-071 | create callerModule=project mode-switch | `triggerType='mode-switch', callerModule='project'` | 跳过 SYSTEM 校验（v0.4 6 值枚举扩展） | `mode.switch` |
| TC-SNAPSHOT-072 | **B5 create callerModule=manual SYSTEM_PERMISSION_DENIED** | 渲染层调用、`callerModule='manual'`、无 systemContext.token | **前端 services 层守卫**：`throw IpcError('SYSTEM_PERMISSION_DENIED')`；**主进程兜底**：返回 `error.code='SYSTEM_PERMISSION_DENIED'`，403 不可重试；同时 emit 审计埋点（success=false, reason='system_permission_denied'） | 审计 telemetry（success=false） |
| TC-SNAPSHOT-073 | create manual 合法（诊断面板 SYSTEM token） | 设置页诊断面板、`systemContext.token` 匹配 | `accepted=true`（合法 manual 调用） | — |
| TC-SNAPSHOT-074 | SNAPSHOT_TRIGGER_INVALID | `triggerType='unknown'` | `error.code='SNAPSHOT_TRIGGER_INVALID'` | — |
| TC-SNAPSHOT-075 | SNAPSHOT_DESC_TOO_LONG + FIELD_TOO_LONG | `description.length=201` | 优先返回专属 `SNAPSHOT_DESC_TOO_LONG`（B6 优先级规则） | — |
| TC-SNAPSHOT-076 | list happy path | `projectRoot` 合法 | `data.snapshots` 按 snapshotId 升序、`currentSnapshotId` 唯一 | — |
| TC-SNAPSHOT-077 | list filter isHealthy=true | `filter={isHealthy:true}` | 仅返回健康快照 | — |
| TC-SNAPSHOT-078 | rollback happy path | `targetSnapshotId=N, createPreRollbackSnapshot=true` | `data.rolledBackTo=N`, `newCurrentSnapshotId=N`, `preRollbackSnapshotId=M > N` | `user.undo(undoCount+1, rolledBackTo=N, preRollbackSnapshotId=M)` |
| TC-SNAPSHOT-079 | SNAPSHOT_TARGET_UNHEALTHY | `targetSnapshotId` 对应 `isHealthy=false` | `error.code='SNAPSHOT_TARGET_UNHEALTHY'`，409 | — |
| TC-SNAPSHOT-080 | SNAPSHOT_ROLLBACK_IN_PROGRESS | mock 并发回滚中 | `error.code='SNAPSHOT_ROLLBACK_IN_PROGRESS'`，409 | — |
| TC-SNAPSHOT-081 | delete happy path 非当前快照 | `snapshotId` 对应 `isCurrent=false` | `data.deleted=true`、`freedSpaceBytes` 反映 inode 引用 | — |
| TC-SNAPSHOT-082 | SNAPSHOT_DELETE_CURRENT_FORBIDDEN | `snapshotId` 对应 `isCurrent=true` | `error.code='SNAPSHOT_DELETE_CURRENT_FORBIDDEN'`，403 | — |
| TC-SNAPSHOT-083 | SNAPSHOT_NOT_FOUND | `snapshotId=99999` | `error.code='SNAPSHOT_NOT_FOUND'`（B6 族） | — |
| TC-SNAPSHOT-084 | SNAPSHOT_LINK_FAILED | mock `fs.linkSync` 跨设备失败 | `error.code='SNAPSHOT_LINK_FAILED'`，5xx 可重试 | — |

### §2.5 类 5：telemetry.* 端点（3 个）

#### TC-TELEMETRY-085~096（[[04_API_SPEC/api-spec.md#6-类5埋点上报接口]] §6）

| 用例 ID | 场景 | 输入要点 | 期望输出 / 错误码 | 触发 events |
|---------|------|---------|-----------------|------------|
| TC-TELEMETRY-085 | emit happy path | `eventType='prd.confirmed', payload={projectId, rounds, duration, featureCount}` | `data.accepted=true`、`eventId` UUID v4、`shardedFile='events-2026-07.jsonl'` | — |
| TC-TELEMETRY-086 | emit TELEMETRY_EVENT_TYPE_INVALID | `eventType='unknown.event'` | `error.code='TELEMETRY_EVENT_TYPE_INVALID'`，4xx | — |
| TC-TELEMETRY-087 | emit TELEMETRY_PAYLOAD_SCHEMA_VIOLATION | `eventType='click.fix', payload` 缺 `success` | `error.code='TELEMETRY_PAYLOAD_SCHEMA_VIOLATION'` | — |
| TC-TELEMETRY-088 | emit TELEMETRY_BUFFER_OVERFLOW | mock 内存缓冲 = 1001 条 | `data.accepted=false`、`droppedCount` 递增 | — |
| TC-TELEMETRY-089 | emit TELEMETRY_WRITE_FAILED | mock flusher appendFileSync IO 失败 | 异步反馈（下次 emit 诊断字段）；`accepted` 仍可能 true（已入缓冲） | — |
| TC-TELEMETRY-090 | emitBatch happy path | `events.length=100, flushReason='stage-change'` | `data.acceptedCount=100, rejectedCount=0` | — |
| TC-TELEMETRY-091 | emitBatch TELEMETRY_BATCH_TOO_LARGE | `events.length=501`（超 500 上限） | `error.code='TELEMETRY_BATCH_TOO_LARGE'`，4xx | — |
| TC-TELEMETRY-092 | emitBatch TELEMETRY_PARTIAL_FAILURE | 100 事件中 1 个 eventType 非法 | `acceptedCount=99, rejectedCount=1, rejectedDetails=[{index:42, errorCode:'TELEMETRY_EVENT_TYPE_INVALID'}]` | — |
| TC-TELEMETRY-093 | query happy path aggregate=none | `scope={projectId:'xxx'}, timeRange={from,to}` 跨度 30 天 | `data.rows.length <= 5000`、`shardedFilesScanned=['events-2026-07.jsonl']`、`truncated=false` | — |
| TC-TELEMETRY-094 | query aggregate=count groupBy=stage | 同上 | `data.rows.length=8`（8 stage 维度） | — |
| TC-TELEMETRY-095 | query TELEMETRY_QUERY_RANGE_INVALID | `from > to` 或跨度 > 90 天 | `error.code='TELEMETRY_QUERY_RANGE_INVALID'` | — |
| TC-TELEMETRY-096 | query TELEMETRY_SCOPE_EMPTY | `scope={}` 三字段全空 | `error.code='TELEMETRY_SCOPE_EMPTY'` | — |

### §2.6 类 6：project.* 端点（4 个，v0.4 新增）

#### TC-PROJECT-097~112（[[04_API_SPEC/api-spec.md#7-类6项目管理接口]] §7）

| 用例 ID | 场景 | 输入要点 | 期望输出 / 错误码 | 触发 events |
|---------|------|---------|-----------------|------------|
| TC-PROJECT-097 | list 全部项目 | 不传 `projectId`, `sortBy='lastOpenedAt'` | `data.projects` 数组、`currentProjectId` 可 null | — |
| TC-PROJECT-098 | list 单项目详情 | `projectId` 合法 | `data.projects.length=1` | — |
| TC-PROJECT-099 | list filter mode=quick | `filter={mode:'quick'}` | 仅返回 quick 项目 | — |
| TC-PROJECT-100 | **B6 list INPUT_INVALID** | `filter={mode:'unknown'}` 或 `sortBy='unknown'` | `error.code='INPUT_INVALID'`（通用错误码族） | — |
| TC-PROJECT-101 | list PROJECT_NOT_FOUND | `projectId` 提供但找不到 | `error.code='PROJECT_NOT_FOUND'`（B6 通用码） | — |
| TC-PROJECT-102 | list PROJECT_INDEX_CORRUPT | mock `_system/projects-index.json` JSON 损坏 | `error.code='PROJECT_INDEX_CORRUPT'`，5xx | — |
| TC-PROJECT-103 | open happy path resumeSession=true | `projectId` 合法, `resumeSession=true` | `data.project` 全字段、`currentSnapshotId` 可 null、`sessionResumed=true`、`lastOpenedAt` 更新 | — |
| TC-PROJECT-104 | open resumeSession 但 sessions 缺失 | `sessions/{projectId}.json` 不存在 | `data.sessionResumed=false`（新建空 SessionContext） | — |
| TC-PROJECT-105 | open PROJECT_DIRECTORY_MISSING | `directoryPath` 磁盘不存在 | `error.code='PROJECT_DIRECTORY_MISSING'`，4xx | — |
| TC-PROJECT-106 | **B5 delete SYSTEM_PERMISSION_DENIED** | 外部脚本通过 IPC 伪造调用、无 SYSTEM token | `error.code='SYSTEM_PERMISSION_DENIED'`，403 | — |
| TC-PROJECT-107 | delete happy path 二次确认 | `confirmation` = projectId 末 8 位 | `data.deleted=true`、`workspacePreserved=true`（默认 false 不删工作区） | `project.finished(finalStatus='abandoned')`（软删） |
| TC-PROJECT-108 | delete PROJECT_DELETE_CONFIRMATION_REQUIRED | `confirmation` 不匹配 | `error.code='PROJECT_DELETE_CONFIRMATION_REQUIRED'` | — |
| TC-PROJECT-109 | delete PROJECT_DELETE_HAS_ACTIVE_SESSION | mock guide.chat 进行中 | `error.code='PROJECT_DELETE_HAS_ACTIVE_SESSION'`，409 | — |
| TC-PROJECT-110 | switchMode happy path quick→iterative | `targetMode='iterative', reason='用户主动升级'` | `data.previousMode='quick'`, `newMode='iterative'`, `snapshotId` 非 null（mode-switch 快照） | `mode.switch(reason, currentStage, fromMode, toMode)` |
| TC-PROJECT-111 | switchMode INPUT_INVALID targetMode 同当前 | `targetMode='quick'` 当前 mode=quick | `error.code='INPUT_INVALID'`（无变化） | — |
| TC-PROJECT-112 | switchMode FIELD_TOO_LONG reason>200 | `reason.length=201` | `error.code='FIELD_TOO_LONG'`（B6 通用码） | — |

> **B6 通用错误码族优先级**（[[04_API_SPEC/api-spec.md#84-通用输入校验错误码族v04-补充闭环-audit-b6]] §8.4）：专属 DOMAIN 错误码 > 通用错误码。例：`description>200` → `SNAPSHOT_DESC_TOO_LONG`（专属），`reason>200` → `FIELD_TOO_LONG`（无专属码时通用兜底）。

---

## §3 14 events 触发验证

本节按 [[04_API_SPEC/events.md]] §1 总览表 + §3 逐个 payload + §4 时序不变量 ORD-01~07，对 14 个埋点事件逐个给出触发链路测试用例。每个事件至少覆盖：① 触发端点；② payload 必填字段；③ 公共字段（stage/mode/projectId）填充正确性；④ 时序不变量（前置事件已触发）。

### §3.1 14 events 触发链路矩阵

| # | eventType | 触发端点 | payload 必填字段（events.md §3） | 典型 stage | 时序前置事件 |
|---|-----------|---------|-------------------------------|-----------|-------------|
| 1 | `project.created` | （Proma 平台层 new project wizard） | `{projectId, mode, template}` | `requirements` | — |
| 2 | `dialog.submitted` | `guide.chat` §3.1 | `{projectId, roundNumber, inputLength, containsImage}` | 任一 | `project.created` |
| 3 | `role.switched` | `guide.chat` §3.1 流式 done | `{projectId, fromRole, toRole, triggerReason}` | 阶段切换瞬间 | `dialog.submitted` |
| 4 | `prd.confirmed` | `guide.confirm` §3.4 confirmType=prd | `{projectId, rounds, duration, featureCount}` | `requirements` | 多次 `dialog.submitted` |
| 5 | `prototype.confirmed` | `guide.confirm` §3.4 confirmType=prototype | `{projectId, previewCount, editCount, duration}` | `prototype` | `prd.confirmed` |
| 6 | `user.undo` | `snapshot.rollback` §5.3 | `{projectId, stage, undoTarget, undoCount}` | 任一 | 至少一个历史快照 |
| 7 | `click.fix` | `guide.clickToFix` §3.3 + `coder.applyFix` §2.3 | `{projectId, targetType, success}` | 主要 `prototype`/`coding` | `prototype.confirmed` 或 `coding.executed` |
| 8 | `mode.switch` | `project.switchMode` §7.4 | `{projectId, reason, currentStage}` | `quick` → `iterative` | `project.created` |
| 9 | `coding.executed` | `coder.generateCode` §2.2 | `{projectId, taskType, tokensUsed, success}` | `coding` | `architecture.confirmed`（iterative）或 `prototype.confirmed`（quick） |
| 10 | `autofix.triggered` | `coder.runGwt` §2.4 autofix 循环 | `{projectId, attemptNumber, result}` | `coding` | `coding.executed` 失败后 |
| 11 | `judge.verdict` | `judge.evaluateDocs` §4.1 / `evaluateCode` §4.2 | `{projectId, passed, violationTypes, duration}` | `coding` → `testing` 切换 | `coding.executed` |
| 12 | `user.satisfaction` | （`project.markSatisfaction` 扩展点） | `{projectId, explicit}` | `testing`/`delivered` | `judge.verdict` passed |
| 13 | `project.finished` | （`project.finish` 扩展点） | `{projectId, finalStatus, totalDuration, totalTokens}` | `testing` → `delivered` | `judge.verdict` passed 或主动放弃 |
| 14 | `architecture.confirmed` | `guide.confirm` §3.4 confirmType=architecture | `{projectId, rounds, duration, moduleCount}` | `architecture` → `planning`/`coding` | `prototype.confirmed` |

### §3.2 测试用例 TC-EVENT-113~133

#### TC-EVENT-113~126：14 events 触发验证

| 用例 ID | 场景 | 触发动作 | 期望 payload 关键字段 | 时序断言 |
|---------|------|---------|---------------------|---------|
| TC-EVENT-113 | project.created 触发 | 完成 mode 选择 + 模板推断 | `mode='quick'`, `template='web-fullstack'`, `projectId` 与公共字段同值 | ORD-01：同 projectId 第一个事件 |
| TC-EVENT-114 | dialog.submitted projectId=null（项目创建前） | mode-select 阶段用户首句 | `projectId=null`, `roundNumber=1`, `inputLength >= 0`, `containsImage=false` | 早于 project.created |
| TC-EVENT-115 | role.switched triggerReason=prd-confirmed | 完成 prd.confirmed 后 chat 流式 done | `fromRole='requirement-analyst'`, `toRole='ux-advisor'`, `triggerReason='prd-confirmed'` | ORD-02：在 prd.confirmed 之后 |
| TC-EVENT-116 | prd.confirmed duration 同步公共字段 | confirm prd 后 | `payload.duration === TelemetryEvent.duration` | ORD-02：早于 prototype.confirmed |
| TC-EVENT-117 | prototype.confirmed editCount 来自 previewPrototype | 多次 previewPrototype 后 confirm | `previewCount >= 1`, `editCount >= 0` | ORD-02：早于 architecture.confirmed |
| TC-EVENT-118 | user.undo undoCount 项目内递增 | 同项目第二次回滚 | `undoCount=2`（第二次） | — |
| TC-EVENT-119 | click.fix success=false 也要 emit | applyFix 失败 | `success=false`, `targetType='button'` | — |
| TC-EVENT-120 | mode.switch 单向性 | quick → iterative | `payload.reason` 描述，公共字段 mode='iterative'（切换后值） | ORD-07：只能出现一次 |
| TC-EVENT-121 | coding.executed success=true autofixAttempts=0 | generateCode 一次通过 | `taskType='initial-gen'`, `tokensUsed >= 0`, `success=true` | ORD-03：在 architecture.confirmed 或 prototype.confirmed 之后 |
| TC-EVENT-122 | autofix.triggered 最多 3 次 + circuit-broken | 3 次自修复全失败 | 3 条事件，`attemptNumber` 1/2/3，最后一次 `result='circuit-broken'` | ORD-04：在 coding.executed 之后，同 stage 内 |
| TC-EVENT-123 | judge.verdict passed=true violationTypes=[] | evaluateCode 全过 | `passed=true`, `violationTypes=[]`, `evaluationTarget='code'` | ORD-05：passed=true 是 project.finished completed 的必要前置 |
| TC-EVENT-124 | user.satisfaction explicit=true score=satisfied | 用户点击"满意"按钮 | `explicit=true`, `score='satisfied'` | ORD-06：在 project.finished 之后或同时 |
| TC-EVENT-125 | project.finished finalStatus=completed | judge.verdict passed + 用户确认交付 | `finalStatus='completed'`, `totalDuration >= 0`, `totalTokens = Project.totalTokenUsed` | ORD-05 |
| TC-EVENT-126 | architecture.confirmed iterative toStage=planning | iterative 项目架构确认 | `rounds >= 1`, `duration`, `moduleCount >= 1` | ORD-02：在 prototype.confirmed 之后 |

### §3.3 时序不变量 ORD-01~07 自动化校验（TC-EVENT-127~133）

按 [[04_API_SPEC/events.md#43-事件时序不变量采集层与查询层共同遵守]] §4.3，所有时序不变量需在集成测试中通过 `telemetry.query` 反查事件流自动校验：

| 不变量 ID | 测试用例 | 校验逻辑 |
|----------|---------|---------|
| ORD-01 | TC-EVENT-127 | 同 projectId 内 `project.created` 是第一个事件（除 `dialog.submitted projectId=null` 外） |
| ORD-02 | TC-EVENT-128 | `prd.confirmed` 早于 `prototype.confirmed` 早于 `architecture.confirmed`（按 timestamp 排序） |
| ORD-03 | TC-EVENT-129 | `coding.executed` 之前必有 `architecture.confirmed`（iterative）或 `prototype.confirmed`（quick） |
| ORD-04 | TC-EVENT-130 | `autofix.triggered` 在 `coding.executed` 之后、同 stage 内 |
| ORD-05 | TC-EVENT-131 | `judge.verdict passed=true` 是 `project.finished finalStatus=completed` 的必要前置 |
| ORD-06 | TC-EVENT-132 | `user.satisfaction explicit=true` 在 `project.finished` 之后或同时 |
| ORD-07 | TC-EVENT-133 | `mode.switch` 同 projectId 内只能出现一次，方向为 quick → iterative |

### §3.4 公共字段填充规则校验

按 [[04_API_SPEC/events.md]] §2：

| 字段 | 校验用例 | 期望 |
|------|---------|------|
| `projectId` 全局事件为 null | TC-EVENT-114 | `dialog.submitted` 在 `project.created` 之前 → projectId=null |
| `stage` 事件触发瞬间快照 | TC-EVENT-115 | `role.switched` 在 requirements → prototype 切换瞬间，stage 字段=切换前的 requirements |
| `mode` mode.switch 后切换 | TC-EVENT-120 | `mode.switch` 公共字段 mode=切换后的 iterative |
| `duration` 同步写入 | TC-EVENT-116 | `prd.confirmed.payload.duration === TelemetryEvent.duration` |

---

## §4 异常自愈 & 熔断 & 回滚测试

本节按 [[05_PROJECT_PLAN/workflow.md]] §3.2 图 3-1 编码异常自愈子流程 + [[01_PRD/prd.md]] §6.3 + [[04_API_SPEC/agent-comm.md]] §5 四层异常传播，给出完整测试矩阵。

### §4.1 异常自愈子流程 TC-EXCEPT-134~142

| 用例 ID | 场景 | 触发动作 | 期望链路 | 上游依据 |
|---------|------|---------|---------|---------|
| TC-EXCEPT-134 | 第 1 次自愈成功 | mock GWT 第 1 次失败 → autofix 修复 → 第 2 次通过 | `coder.runGwt` 内 autofix 循环第 1 次：`autofix.triggered(attemptNumber=1, result='success')`，继续流水线 | workflow.md §3.2 |
| TC-EXCEPT-135 | 第 2 次自愈成功 | mock 前 2 次失败 → 第 3 次通过 | `autofix.triggered × 2`（result='partial'），第 3 次成功（result='success'） | workflow.md §3.2 |
| TC-EXCEPT-136 | 第 3 次自愈失败 → 熔断 | mock 3 次全失败 | `autofix.triggered × 3`（最后一次 result='circuit-broken'）+ 触发 `snapshot.rollback(lastHealthy)` + 穿透调用 `guide.chat` 通俗化通知 | workflow.md §3.2 + PRD §6.3 |
| TC-EXCEPT-137 | 熔断后回滚链路 | TC-EXCEPT-136 触发后 | ① `snapshot.rollback` 返回 `rolledBackTo=lastHealthy`；② `preRollbackSnapshotId` 非 null（默认 createPreRollbackSnapshot=true）；③ `user.undo` 埋点 emit | api-spec.md §5.3 + events.md §3.6 |
| TC-EXCEPT-138 | 熔断通俗化通知文案 | 熔断后 guide.chat 渲染 | 用户看到"已回到上一个正常版本，内容没有丢失"等安抚文案（无技术堆栈、无 PRD §7.5 心理防御黑名单词：API/PlantUML/Sprint/Agent/类图/Schema） | PRD §6.3 + §7.5 |
| TC-EXCEPT-139 | 快消型熔断后换方案 | 快消型熔断 | 编程Agent 自主换技术方案重试（编程层闭环，不倒回需求阶段） | workflow.md §3.2 图 3-1 左分支 |
| TC-EXCEPT-140 | 长期型涉设计约束不可实现 | 长期迭代型熔断 + 设计约束 | 编程Agent 出具变更说明 → 升级至架构设计师 + 人类评估 → 用户确认后调整 PlantUML/架构文档（走 §2 文档流） | workflow.md §3.2 图 3-1 右分支 + §5.3 |
| TC-EXCEPT-141 | 全链路不倒回需求 | 任何熔断场景 | 链路不倒回 requirements 阶段（编程层闭环或架构变更说明路径） | workflow.md §3.2 |
| TC-EXCEPT-142 | 退回次数上限 - 快消型 ≤2 | 快消型第 3 次裁判退回 | 提示用户人工介入（不无限重试） | PRD §9.3 + workflow.md §3.3 |

### §4.2 四层异常传播测试（[[04_API_SPEC/agent-comm.md#51-异常传播总览]] §5.1）

| 层级 | 测试用例 | 触发场景 | 期望传播路径 |
|------|---------|---------|------------|
| Layer 1（4xx 输入校验） | TC-EXCEPT-143 | `coder.generateCode` 缺 `projectRoot` | coder 抛 → 调用方收（前端）→ 修正参数重试，不传播给其他 Agent |
| Layer 2（409 状态/冲突） | TC-EXCEPT-144 | `guide.confirm` 非法 stage 转移 | GUIDE_INVALID_STAGE_TRANSITION → 调用方转化为通俗化提示呈现给用户 |
| Layer 3（408/5xx 服务端失败+超时） | TC-EXCEPT-145 | `coder.runGwt` LLM 超时 | coder 内部自修复 3 次（按可重试标记）→ 重试耗尽升级 Layer 4 |
| Layer 4（403/熔断） | TC-EXCEPT-146 | `CODER_AUTOFIX_EXHAUSTED` | 必须经 guide.chat 呈现给用户（编程Agent 无直接 UI） |

### §4.3 错误码透传链测试（[[04_API_SPEC/agent-comm.md#53-错误码透传链按-domain-归并]] §5.3）

| 用例 ID | 场景 | 透传路径 | 终点用户感知 |
|---------|------|---------|------------|
| TC-EXCEPT-147 | CODER_AUTOFIX_EXHAUSTED 透传 | coder → guide（穿透）→ 用户 | "修改遇到困难，已回滚，可换方案" |
| TC-EXCEPT-148 | GUIDE_INTERNAL_JUDGE_FAILED 嵌套错误码 | `guide.confirm(architecture)` 内调 `judge.evaluateDocs` 失败 | outer error.code='GUIDE_INTERNAL_JUDGE_FAILED', details.innerCode='JUDGE_LLM_TIMEOUT' |
| TC-EXCEPT-149 | SNAPSHOT_TARGET_UNHEALTHY 退回 | snapshot → guide → 用户 | "目标快照损坏，请选择其他版本" + 列出可用快照 |
| TC-EXCEPT-150 | TELEMETRY_* 不透传 | telemetry emit 异步失败 | 用户无感知（异步反馈） |

### §4.4 恢复策略矩阵测试（[[04_API_SPEC/agent-comm.md#54-恢复策略矩阵]] §5.4）

| 用例 ID | 失败场景 | 恢复策略 | 是否经快照 |
|---------|---------|---------|-----------|
| TC-EXCEPT-151 | guide.chat 模型超时 | 重试 1 次，仍失败 → GUIDE_MODEL_UNAVAILABLE | 否 |
| TC-EXCEPT-152 | guide.clickToFix pre-modify 快照失败 | 中止 clickToFix，用户重试 | 否（pre-modify 快照保留） |
| TC-EXCEPT-153 | coder.applyFix CODER_FIX_OUT_OF_SCOPE | 不重试，拒绝执行 | 否（pre-modify 快照保留） |
| TC-EXCEPT-154 | judge.evaluateCode 类不一致 | verdict=reject + missingInCode 清单 → 退回编程 | 否 |

---

## §5 Sprint S1-S3 验收清单

本节按 [[05_PROJECT_PLAN/sprint-plan.md]] §3.1/§3.2/§3.3 Phase 1（MVP）三 Sprint 验收标准，逐条映射到测试用例集。每 Sprint 既验证可运行增量交付物，也覆盖 GWT 验收场景（测试工程师角色产出）。

### §5.1 Sprint 1：地基与最窄端到端骨架（[[05_PROJECT_PLAN/sprint-plan.md#31-sprint-1地基与最窄端到端骨架]] §3.1）

**Sprint 目标**：搭建 Proma fork 扩展地基，跑通"模式选择 → 一轮需求对话 → 首快照"最窄主轴。

#### TC-SPRINT-155~163：S1 验收用例集

| 用例 ID | 验收标准（sprint-plan §3.1） | 测试动作 | 期望结果 |
|---------|----------------------------|---------|---------|
| TC-SPRINT-155 | 应用启动 → 无活跃项目 → 展示两道门 | 启动 Electron 应用、无项目 | UI 展示"快速做一个工具"+"我有明确想法"两道门（通俗说明 + 场景举例） |
| TC-SPRINT-156 | 点击"快速做一个工具" → 进入快消型工作区 | 点击按钮 | 进入双区布局（聊天区 + 预览区占位） |
| TC-SPRINT-157 | 需求分析师角色加载，提出 ≥3 个引导问题 | 进入工作区 | 角色加载，3-5 个引导问题，**无技术术语**（不出现 PRD §7.5 黑名单词：API/PlantUML/Sprint/Agent/类图/Schema） |
| TC-SPRINT-158 | 用户回答后，对话被记录 | 回答问题 | `_system/conversation.jsonl` 追加新行 |
| TC-SPRINT-159 | 埋点 JSONL 新增对应事件行 | 同上 | `events-2026-07.jsonl` 含 `dialog.submitted` 行（含 `roundNumber=1`） |
| TC-SPRINT-160 | 项目目录自动创建 | 项目初始化 | `workspace-files/{projectId}-{shortName}/` 存在，含 7 目录骨架 + `_meta.json` |
| TC-SPRINT-161 | 首快照产生 | 同上 | `_meta.json#snapshots[]` 含一项 `triggerType='init'`，`filePath` 物理存在，`hardlinkedFiles > 0` |
| TC-SPRINT-162 | 首快照对象非空（项目元数据+目录骨架） | 同上 | 快照目录含 `_meta.json` 副本 + 7 目录骨架（非空目录） |
| TC-SPRINT-163 | 路由层正确加载需求分析师 System Prompt | 角色加载时 | 通过日志/埋点验证 `role.switched(toRole='requirement-analyst')` 触发 |

**S1 GWT 验收场景**（测试工程师产出，4 项）：模式选择 / 对话记录 / 首快照 / 路由加载 → 对应 TC-SPRINT-155/158/161/163。

### §5.2 Sprint 2：向导主轴贯通（[[05_PROJECT_PLAN/sprint-plan.md#32-sprint-2向导主轴贯通]] §3.2）

**Sprint 目标**：多轮需求对话 → UI/UX 可预览 HTML 原型 → 架构师/工程经理隐于后台 → 完整精简文档交接 → 裁判硬约束基础检查通过。

#### TC-SPRINT-164~173：S2 验收用例集

| 用例 ID | 验收标准（sprint-plan §3.2） | 测试动作 | 期望结果 |
|---------|----------------------------|---------|---------|
| TC-SPRINT-164 | 用户多轮对话后，UI/UX 顾问生成可交互 HTML 原型 | 完成 PRD 确认 → 多轮 prototype 对话 | 预览区渲染 HTML 原型，双击可在浏览器预览 |
| TC-SPRINT-165 | 原型 HTML 含模拟数据 + 可点击 | 渲染原型 | 点击元素有响应（无后端联调，纯前端交互） |
| TC-SPRINT-166 | 用户确认原型（点击按钮） | 点击"确认原型"按钮 | `prototype.confirmed` 事件触发，stage 推进 `prototype → architecture` |
| TC-SPRINT-167 | 系统隐于后台，用户看到"AI 正在开发中" | 原型确认后 | UI 显示加载态文案，后台运行架构师+工程经理 Session Restart |
| TC-SPRINT-168 | 后台自动产出精简文档体系 | 后台运行结束 | 目录结构与 PRD §5.3 快消型 6 目录（PRD + UX + 简版架构 + API + GWT + README）一致 |
| TC-SPRINT-169 | 裁判硬约束检查通过（PRD 必填项齐 + GWT 文件存在） | 后台结束触发裁判 | `judge.evaluateDocs verdict=pass` 或 verdict=reject 退回并提示 |
| TC-SPRINT-170 | 原型确认前后产生自动快照 | 原型确认 | `_meta.json#snapshots[]` 新增 `triggerType='confirm'` 快照 |
| TC-SPRINT-171 | 4 次角色切换均有埋点记录 | 完成 requirements→prototype→architecture 流程 | `role.switched` 事件 ≥ 3 次（requirement-analyst → ux-advisor → architect → engineering-manager） |
| TC-SPRINT-172 | GWT Feature 自动生成（向导后台角色产出） | 后台运行 | `06_TESTS/features/*.feature` 存在，覆盖 PRD 功能项 |
| TC-SPRINT-173 | 快消型精简文档目录裁剪 | 同上 | 不含 `05_PROJECT_PLAN`/`07_VERSIONS` 目录（快消型合并入 README 或暂缺） |

**S2 GWT 验收场景**（测试工程师产出，4 项）：多轮对话 / 原型确认 / 4 角色切换 / 裁判通过 → 对应 TC-SPRINT-164/166/171/169。

### §5.3 Sprint 3：编程收口闭环（MVP 完成，[[05_PROJECT_PLAN/sprint-plan.md#33-sprint-3编程收口闭环mvp-完成]] §3.3）

**Sprint 目标**：贯通编程域 + 裁判闭环——全栈开发编码 → GWT 测试 → 裁判判定 → 交付试用，含自修复 3 次 + 熔断回滚 + 异常通知 + 测试结果展示。**S3 结束 = 快消型 MVP 端到端跑通**。

#### TC-SPRINT-174~183：S3 验收用例集

| 用例 ID | 验收标准（sprint-plan §3.3） | 测试动作 | 期望结果 |
|---------|----------------------------|---------|---------|
| TC-SPRINT-174 | 用户确认原型后，编程 Agent 自动生成可运行代码 | 原型确认后 | `_code/` 含可运行代码（≥1 文件），`coding.executed(success=true)` 触发 |
| TC-SPRINT-175 | GWT 全量场景执行，输出测试报告 | coder.runGwt | `data.results` 数组含每个 scenario 的 status，`allPassed=true` 或自修复后通过 |
| TC-SPRINT-176 | 裁判判定通过 → 用户拿到可运行软件 | judge.evaluateCode verdict=pass | 用户可双击运行 `_code/` 产物 |
| TC-SPRINT-177 | 测试未全过 → 编程 Agent 自动修复 | mock GWT 失败 | `autofix.triggered` 至少 1 次，修复后重跑 |
| TC-SPRINT-178 | 3 次修复失败 → 熔断回滚 → 用户看到安抚文案 | mock 3 次失败 | TC-EXCEPT-136 链路全跑通；UI 显示"已回到上一个正常版本，内容没有丢失"（无技术堆栈） |
| TC-SPRINT-179 | 用户可查看版本时间轴并一键回滚（不丢失当前版本） | 用户点击"回滚到 #N" | `snapshot.rollback` 返回 `preRollbackSnapshotId` 非 null，当前版本作为新快照保留 |
| TC-SPRINT-180 | 用户看到自然语言测试摘要 | 测试完成 | UI 显示"我们测试了 X 个场景，全部通过 ✓"（自然语言，非 raw JSON） |
| TC-SPRINT-181 | 用户点击原型元素可触发点选纠错（MVP 版） | 用户点击 data-ai-id 元素 | guide.clickToFix → coder.applyFix → 预览刷新 |
| TC-SPRINT-182 | L0 文件隔离（项目目录隔离） | 编程 Agent 子进程 | 子进程只能访问 `{projectRoot}/`，越界访问触发 `CODER_FIX_OUT_OF_SCOPE` |
| TC-SPRINT-183 | L1 子进程资源限制（超时 3 分钟 / 内存 1GB / 子进程数 ≤10） | 超时 mock | `CODER_SANDBOX_TIMEOUT` 触发，SIGKILL 子进程 |

**S3 GWT 验收场景**（测试工程师产出，5 项）：点选纠错 / 版本回滚 / 异常通知 / 测试摘要 / 熔断 → 对应 TC-SPRINT-181/179/178/180/178。

**Phase 1 收口验收**（sprint-plan §3.3 末）：一个零基础用户从"我想做个读书笔记工具"到拿到可运行软件并看到测试通过摘要，全程不接触代码、不接触技术术语。

### §5.4 Phase 1 七模块覆盖矩阵（sprint-plan §6）

| 模块 | S1 用例 | S2 用例 | S3 用例 | Phase 1 覆盖 |
|------|--------|--------|--------|--------------|
| 前端UI层 | TC-SPRINT-155/156 | TC-SPRINT-164/165 | TC-SPRINT-178/180/181 | ✅ 完整 |
| 对话路由层 | TC-SPRINT-163 | TC-SPRINT-171 | — | ✅ 完整 |
| 向导Agent引擎 | TC-SPRINT-157 | TC-SPRINT-164/168/172 | — | ✅ 完整 |
| 编程Agent引擎 | （桩） | — | TC-SPRINT-174/175/177/182/183 | ✅ 完整 |
| 裁判引擎 | （桩） | TC-SPRINT-169 | TC-SPRINT-176 | ✅ 完整 |
| 快照管理器 | TC-SPRINT-161/162 | TC-SPRINT-170 | TC-SPRINT-179 | ✅ 完整 |
| 埋点采集层 | TC-SPRINT-159 | TC-SPRINT-166/171 | TC-SPRINT-174/177 | ✅ 完整 |

---

## §6 权限 & 边界测试（B5 manual SYSTEM + B6 输入校验错误码族 + B4 SPSAS 并发防护）

本节按 [[04_API_SPEC/api-spec.md]] §0.4 B5 manual callerModule SYSTEM 校验三要素 + §8.4 B6 通用输入校验错误码族 + [[04_API_SPEC/agent-comm.md]] §2.3.1 B4 SPSAS 不变量，给出三组边界测试。

### §6.1 B5 manual SYSTEM 权限校验三要素

按 [[04_API_SPEC/api-spec.md#04-manual-callermodule-校验三要素v04-补充闭环-audit-b5]] §0.4：

| 要素 | 内容 | 测试覆盖 |
|------|------|---------|
| 判定依据 | `callerModule==='manual'` 时，调用方须为 Proma 主进程内的 SYSTEM 级上下文（设置页诊断面板/测试运行器/自动化运维脚本），由 IPC 桥接层注入的 `systemContext.token` 校验 | TC-BOUND-184 |
| 失败错误码 | `SYSTEM_PERMISSION_DENIED`（DOMAIN=SYSTEM，403，不可重试） | TC-BOUND-185 |
| 拒绝行为 | 立即返回错误，**不执行**业务逻辑（快照不创建/项目不删除），同时经 `telemetry.emit` 上报审计埋点（payload 含 `callerModule='manual'`、`success=false`、`reason='system_permission_denied'`） | TC-BOUND-186 |

#### TC-BOUND-184~190：B5 manual SYSTEM 测试

| 用例 ID | 场景 | 输入 | 期望 |
|---------|------|------|------|
| TC-BOUND-184 | 渲染层伪造 callerModule='manual' | services/snapshot.ts 守卫拦截 | `throw IpcError('SYSTEM_PERMISSION_DENIED', requestId='<frontend-guard>')`，**不发起 IPC invoke** |
| TC-BOUND-185 | 主进程兜底拒绝 | 渲染层绕过 services 直接 `_invoke('snapshot:create', {callerModule:'manual', ...})` | 主进程返回 `error.code='SYSTEM_PERMISSION_DENIED'`，403 不可重试 |
| TC-BOUND-186 | 审计埋点上报 | TC-BOUND-185 触发时 | `telemetry.emit({eventType:'click.fix', payload:{callerModule:'manual', success:false, reason:'system_permission_denied'}})` 触发（便于事后追溯伪造尝试） |
| TC-BOUND-187 | 合法 manual 调用（设置页诊断面板 SYSTEM token） | `systemContext.token` 匹配主进程启动 token | `accepted=true`，业务正常执行 |
| TC-BOUND-188 | TS 类型层编译期拦截 | 前端代码传 `callerModule='manual'` | `FrontendCallerModule = Exclude<CallerModule, 'manual'>` 类型层报错（[[04_API_SPEC/frontend-backend-api.md#74-servicessnapshotts]] §7.4） |
| TC-BOUND-189 | project.delete SYSTEM 校验 | 外部脚本通过 IPC 伪造调用 project.delete | `error.code='SYSTEM_PERMISSION_DENIED'`（破坏性等级与 manual 快照相当，按 §0.4 适用范围声明） |
| TC-BOUND-190 | callerModule='project' 跳过 SYSTEM 校验 | project.switchMode 内部调 `snapshot.create(callerModule='project')` | 跳过 §0.4 校验（v0.4 6 值枚举扩展，调用链可信） |

### §6.2 B6 通用输入校验错误码族

按 [[04_API_SPEC/api-spec.md#84-通用输入校验错误码族v04-补充闭环-audit-b6]] §8.4：

| 错误码 | 触发条件 | 测试覆盖 |
|--------|---------|---------|
| `INPUT_INVALID` | payload 为空 / 枚举值非法 / 格式错误（UUID 不合法、enum 越界、必填字段缺失） | TC-BOUND-191 |
| `PROJECT_NOT_FOUND` | `projectId` 在 `projects-index.json` 中找不到（通用版） | TC-BOUND-192 |
| `SNAPSHOT_NOT_FOUND` | `snapshotId` 不存在 | TC-BOUND-193 |
| `FIELD_TOO_LONG` | 字符串字段超长（`description>200`、`reason>200`、`name>100`） | TC-BOUND-194 |
| `SYSTEM_PERMISSION_DENIED` | `callerModule='manual'` 但调用方未经 SYSTEM 级授权 | TC-BOUND-184~190（见 §6.1） |

#### TC-BOUND-191~197：B6 输入校验测试

| 用例 ID | 场景 | 触发端点 | 期望错误码 | 优先级 |
|---------|------|---------|-----------|--------|
| TC-BOUND-191 | filter mode 越界 | `project.list filter={mode:'unknown'}` | `INPUT_INVALID`（B6 通用） | 通用兜底 |
| TC-BOUND-192 | projectId 在索引中找不到 | `project.open projectId='non-existent'` | `PROJECT_NOT_FOUND`（B6 通用版） | 通用 |
| TC-BOUND-193 | snapshotId 不存在 | `snapshot.delete snapshotId=99999` | `SNAPSHOT_NOT_FOUND` | B6 族声明（已存在 §5.4） |
| TC-BOUND-194 | description > 200 | `snapshot.create description.length=201` | `SNAPSHOT_DESC_TOO_LONG`（**专属优先**） | 专属 > 通用 |
| TC-BOUND-195 | reason > 200 | `project.switchMode reason.length=201` | `FIELD_TOO_LONG`（无专属码，通用兜底） | 通用兜底 |
| TC-BOUND-196 | sortBy 越界 | `project.list sortBy='unknown'` | `INPUT_INVALID` | 通用 |
| TC-BOUND-197 | projectId 非 UUID 格式 | `guide.chat projectId='not-a-uuid'` | `INPUT_INVALID` | 通用 |

### §6.3 B4 SPSAS 单项目单活动会话不变量

按 [[04_API_SPEC/agent-comm.md#231-并发防护策略治审计-b4强制不变量--兜底机制]] §2.3.1：

**强制不变量**：**单项目单活动会话**（SPSAS, Single-Project-Single-Active-Session）—— 同一 `projectId` 在任意时刻**至多一个活动会话**持有写权限。

| 维度 | 强制点 | 测试覆盖 |
|------|--------|---------|
| 会话级 | `guide.chat` 入口前调 `acquireProjectLock(projectId, sessionId)`；锁文件 `_system/sessions/{projectId}.lock`（含 sessionId + acquiredAt + TTL） | TC-BOUND-198 |
| 角色切换 | router 在 `sessionRestart` 前后保持锁归属不变（同 sessionId 持锁穿越角色切换，不释放） | TC-BOUND-199 |
| 快照创建 | `snapshot.create` 必须由持锁会话发起；非持锁会话调用 → 拒绝 | TC-BOUND-200 |
| `_meta.json` 写入 | 所有 Agent 写 `_meta.json` 必须走"读-改-原子写"三步（`fs.writeFile` + 临时文件 + `fs.rename`） | TC-BOUND-201 |

#### TC-BOUND-198~205：SPSAS 不变量测试

| 用例 ID | 场景 | 触发动作 | 期望 |
|---------|------|---------|------|
| TC-BOUND-198 | 双窗口对同 projectId 发起 guide.chat | A 窗口先 invoke guide.chat → B 窗口 invoke guide.chat | B 窗口收到 `error.code='SESSION_LOCK_CONTENTION'`，details 含 `ownerSessionId`/`acquiredAt`/`ttlSeconds` |
| TC-BOUND-199 | 角色切换穿越锁归属 | 同 sessionId 完成 prd/prototype/architecture 多次 Session Restart | 锁 owner 不变，全程同 sessionId 持锁 |
| TC-BOUND-200 | 非持锁会话伪造 snapshot.create | C 窗口（无锁）调 `snapshot.create` | 拒绝（防用户态伪造 `callerModule='manual'`） |
| TC-BOUND-201 | `_meta.json` 原子写 | mock 写入中断（kill 进程） | `_meta.json` 不损坏（临时文件 + rename 保证原子性） |
| TC-BOUND-202 | 锁 TTL 过期（默认 30 分钟无活动） | mock `acquiredAt` 早于 30 分钟前 | 下一个 `acquireProjectLock` 强制抢占覆盖写 |
| TC-BOUND-203 | 锁文件失序（ownerSessionId 不在 sessionRegistry） | 手动破坏锁文件 | 下一个 `acquireProjectLock` 强制抢占并写入 |
| TC-BOUND-204 | 项目关闭释放锁 | 用户主动关闭项目 / `project.delete` / 应用退出 | 锁文件删除 |
| TC-BOUND-205 | 错误码边界：SYSTEM_PERMISSION_DENIED vs SESSION_LOCK_CONTENTION | 渲染层伪造 callerModule='manual' + 双窗口 | 权限校验先于锁校验，先返回 `SYSTEM_PERMISSION_DENIED`（互斥不冲突） |

### §6.4 沙箱边界测试（L0 + L1）

| 用例 ID | 场景 | 期望 |
|---------|------|------|
| TC-BOUND-206 | L0 路径越界 | `coder.applyFix` 修改触及 `_code/` 外文件 → `CODER_FIX_OUT_OF_SCOPE`（403 不可重试） |
| TC-BOUND-207 | L1 子进程超时 180s | `CODER_SANDBOX_TIMEOUT`（408 可重试）+ SIGKILL |
| TC-BOUND-208 | L1 内存超 1GB | 子进程 OOM，主进程不污染 |
| TC-BOUND-209 | L1 子进程数超 10 | 拒绝新建子进程（资源限制） |

---

## §7 测试基础设施

本节定义测试目录结构、Mock 策略、CI 集成建议。

### §7.1 测试目录结构

平台涉及两套目录：**文档目录**（`06_TESTS/`，设计阶段产出，本文档所在）与**测试代码目录**（项目根 `test/`，编码阶段产出）。

```text
06_TESTS/                       # 文档目录（设计阶段）
├── test-plan.md                # 本文档（DOC-6.1 v0.2）
├── test-plan.note.md           # 决策笔记（v0.1 旧版，保留供历史追溯）
├── features/                   # ⏳ GWT Feature 文件（待 C2/C3 按 P0 故事产出）
│   └── *.feature
└── (step-definitions/ 由后续里程碑产出，本次 out_of_scope)

test/                           # 测试代码目录（编码阶段）
├── setup/
│   ├── ipc-mock.ts             # contextBridge IPC 桥 mock（双进程模拟）
│   ├── ipc-harness.ts          # 自研 IPC harness（node 环境模拟 ipcMain/ipcRenderer）
│   ├── gwt.ts                  # 自研薄 GWT helper（层 1 主路径）
│   ├── llm-mock.ts             # GLM 5.1 mock（vi.mock + fixture 回放）
│   └── fs-fixtures.ts          # tmpdir 项目目录脚手架（含 7 目录 + _meta.json）
├── fixtures/
│   ├── llm-responses/          # mock GLM 响应（角色 × 场景矩阵）
│   │   ├── requirement-analyst/
│   │   ├── ux-advisor/
│   │   ├── architect/
│   │   └── engineering-manager/
│   ├── prd/                    # PRD 片段（驱动向导Agent路由/角色切换）
│   ├── puml/                   # PlantUML 样例（valid/invalid 子目录）
│   ├── gwt/                    # GWT 场景样例（验证运行时 runner）
│   ├── projects/               # 项目元数据（快照/回滚/埋点测试）
│   └── telemetry/              # 埋点事件 fixture（合成数据，脱敏）
├── unit/                       # Vitest 单元测试（金字塔 70%）
│   ├── services/
│   │   ├── coder.test.ts       # TC-CODER-001~028
│   │   ├── guide.test.ts       # TC-GUIDE-029~055
│   │   ├── judge.test.ts       # TC-JUDGE-056~068
│   │   ├── snapshot.test.ts    # TC-SNAPSHOT-069~084
│   │   ├── telemetry.test.ts   # TC-TELEMETRY-085~096
│   │   └── project.test.ts     # TC-PROJECT-097~112
│   ├── events.test.ts          # TC-EVENT-113~126 + ORD-01~07 自动化
│   ├── except.test.ts          # TC-EXCEPT-134~154
│   └── bound.test.ts           # TC-BOUND-184~209
├── integration/                # Vitest 集成测试（金字塔 20%）
│   ├── ipc-bridge.test.ts      # IPC 桥往返（ipcMain.handle ↔ ipcRenderer.invoke）
│   ├── three-agent-flow.test.ts # 三 Agent 协作时序（agent-comm.md §3）
│   ├── sandbox.test.ts         # 子进程沙箱 L0/L1
│   ├── snapshot-atomic.test.ts # _meta.json 原子写 + SPSAS 锁
│   └── session-restart.test.ts # Session Restart 六步
└── e2e/                        # Playwright Electron E2E（金字塔 10%）
    ├── user-journey.spec.ts    # US-U01~U08 关键旅程
    ├── sprint-acceptance.spec.ts # Sprint S1/S2/S3 验收 E2E
    ├── self-heal-fuse.spec.ts  # 异常自愈熔断 → 安抚文案
    └── click-fix.spec.ts       # 点选纠错 MVP

vitest.config.ts                # Vitest 配置（globals: true / jsdom / node 环境）
playwright.config.ts            # Playwright Electron 配置（项目根）
```

### §7.2 Mock 策略

| Mock 层 | 工具 | 范围 | 不 mock 的部分 |
|--------|------|------|--------------|
| GLM 5.1 API | `vi.mock('services/llm-client')` + fixture 回放 | 所有 LLM 调用（避免真实 Token 消耗、CI 离线） | — |
| IPC 桥 | 自研 `ipc-harness.ts`（node 环境模拟双进程） | `ipcMain.handle`/`ipcRenderer.invoke`/`contextBridge` | services 层业务逻辑 |
| 文件系统 | `tmpdir`（真实 fs，临时目录） | — | `_meta.json`/JSONL/snapshot 目录（真实读写） |
| 子进程 | `child_process.spawn` + 超时 mock | 编程Agent 子进程沙箱（L1 资源限制） | 沙箱配置逻辑 |
| Electron BrowserWindow | Playwright `_electron.launch` | E2E 完整应用 | — |

**关键纪律**（与 v0.1 决策笔记一致）：

- **CI 不调用真实 GLM 5.1 API**：成本、稳定性、配额。全部走 mock（fixture 回放）。
- **零外网依赖**：所有测试数据本地化（fixtures），CI 可离线运行。
- **真实文件系统**：单元测试可用 mock，集成/E2E 必须用真实 `tmpdir`（验证 `_meta.json` 原子写、JSONL 追加、snapshot 硬链接）。
- **沙箱测试受控夹具**：固定 PRD + 固定 step 驱动子进程，断言退出码与测试报告 JSON。

### §7.3 CI 集成

```yaml
# .github/workflows/test.yml（建议）
jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - run: npm ci
      - run: npm test -- --coverage
    coverage_threshold:
      statements: 80%
      branches: 70%
  
  integration:
    runs-on: ubuntu-latest
    steps:
      - run: npm ci
      - run: npm run test:integration  # Vitest node 环境
  
  e2e:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    steps:
      - run: npm ci
      - run: npx playwright install electrons
      - run: xvfb-run npm run test:e2e  # Linux 需 xvfb-run 包裹
        if: matrix.os == 'ubuntu-latest'
      - run: npm run test:e2e
        if: matrix.os != 'ubuntu-latest'
```

**触发频率**：

| 触发 | 范围 | 门槛 |
|------|------|------|
| PR 提交 | 单元 + 相关集成 | 100% 单元通过；coverage 不下降 |
| nightly | 单元 + 集成 + 全量 GWT | 全量绿 |
| release 前 | 全部 + E2E（三平台） | E2E 关键旅程 100% 绿（US-U01~U08） |
| 紧急修复 | 受影响模块 + 全量 GWT | GWT 不回退 |

### §7.4 测试用例覆盖率反向追溯

| 章节 | 用例 ID 范围 | 数量 | 上游基准覆盖 |
|------|------------|------|------------|
| §2 端点契约 | TC-CODER-001~TC-PROJECT-112 | 112 | [[04_API_SPEC/api-spec.md]] 20 端点 |
| §3 events 触发 | TC-EVENT-113~133 | 21 | [[04_API_SPEC/events.md]] 14 events + ORD-01~07 |
| §4 异常自愈 | TC-EXCEPT-134~154 | 21 | [[05_PROJECT_PLAN/workflow.md]] §3.2 + [[01_PRD/prd.md]] §6.3 |
| §5 Sprint S1-S3 | TC-SPRINT-155~183 | 29 | [[05_PROJECT_PLAN/sprint-plan.md]] §3.1/§3.2/§3.3 |
| §6 权限边界 | TC-BOUND-184~209 | 26 | [[04_API_SPEC/api-spec.md]] §0.4/§8.4 + [[04_API_SPEC/agent-comm.md]] §2.3.1 |
| **合计** | TC-CODER-001~TC-BOUND-209 | **209** | 三向映射完整 |

---

## §8 一致性核对与 DoD self_check

### §8.1 与上游文档一致性核对

| 核对项 | 上游出处 | 本文档对应章节 | 结果 |
|--------|---------|--------------|------|
| 20 端点（3+4+2+4+3+4）契约矩阵 | [[04_API_SPEC/api-spec.md]] v0.4 §1 + §9.1 | §2.1~§2.6 | ✅ 全 20 端点逐个覆盖 |
| 14 events 触发链路 | [[04_API_SPEC/events.md]] §1 + §3 | §3.1 + §3.2 | ✅ 14 events 全覆盖 |
| 时序不变量 ORD-01~07 | [[04_API_SPEC/events.md]] §4.3 | §3.3 | ✅ 7 条全自动化校验 |
| 异常自愈 3 次→熔断→回滚 | [[05_PROJECT_PLAN/workflow.md]] §3.2 + [[01_PRD/prd.md]] §6.3 | §4.1 | ✅ TC-EXCEPT-134~142 |
| 四层异常传播 | [[04_API_SPEC/agent-comm.md]] §5.1 | §4.2 | ✅ Layer 1~4 |
| Sprint S1-S3 验收标准 | [[05_PROJECT_PLAN/sprint-plan.md]] §3.1/§3.2/§3.3 | §5.1~§5.3 | ✅ 每 Sprint 验收点逐条映射 |
| Phase 1 七模块覆盖 | [[05_PROJECT_PLAN/sprint-plan.md]] §6 | §5.4 | ✅ 7 模块全覆盖 |
| B5 manual SYSTEM 三要素 | [[04_API_SPEC/api-spec.md]] §0.4 | §6.1 | ✅ TC-BOUND-184~190 |
| B6 通用输入校验错误码族 | [[04_API_SPEC/api-spec.md]] §8.4 | §6.2 | ✅ TC-BOUND-191~197 |
| B4 SPSAS 单项目单活动会话 | [[04_API_SPEC/agent-comm.md]] §2.3.1 | §6.3 | ✅ TC-BOUND-198~205 |
| 沙箱边界 L0+L1 | [[03_ARCHITECTURE/architecture.md]] §6 | §6.4 | ✅ TC-BOUND-206~209 |
| 文档头部元信息合规 | 设计阶段清单 §1.1 | 文件头 | ✅ DOC-6.1 / v0.2 / 2026-07-16 / 状态 / 依赖 5 文档带版本号 |
| 跨文档引用 `[[...]]` 包裹 | 设计阶段清单 §1.3 | 全文 | ✅ 全部使用 `[[路径]]` |
| 测试用例 ID 唯一（TC-XXX-NNN 三段式） | brief quality_gates | 全文 | ✅ TC-CODER-001~TC-BOUND-209 共 209 个，全程唯一 |
| 引用上游 PRD/03/04/05 文件 ≥6 处 file:line 级证据 | brief quality_gates | §0~§7 | ✅ §2 §3 §4 §5 §6 §7 共 30+ 处 `[[04_API_SPEC/api-spec.md#章节]]` 级引用 |

### §8.2 DoD self_check 核对表

| DoD 项 | 结果 | 证据 |
|--------|------|------|
| 文件落 `D:/Codes/multi-agent-collab-platform/06_TESTS/test-plan.md` | ✅ | 物理路径见文件头 |
| ≥5000 字 | ✅ | 估算正文约 11000+ 字（含 209 个测试用例 + 表格 + 代码块） |
| 覆盖 7 章节（策略/端点矩阵/events/异常/sprint/权限边界/基础设施） | ✅ | §1~§7 七章节齐全 |
| 20 端点契约矩阵无遗漏 | ✅ | §2.1~§2.6 共 112 个端点测试用例 |
| 14 events 触发验证 | ✅ | §3 共 21 个 events 测试用例 + ORD-01~07 |
| 异常自愈熔断回滚测试 | ✅ | §4 共 21 个异常测试用例 |
| Sprint S1-S3 验收清单 | ✅ | §5 共 29 个 Sprint 测试用例 + Phase 1 七模块覆盖矩阵 |
| 权限边界 B5/B6/B4 测试 | ✅ | §6 共 26 个边界测试用例 |
| 测试用例 ID 三段式唯一 | ✅ | TC-CODER-001~TC-BOUND-209，全程唯一 |
| 对照 04 端点 / 05 sprint / 14 events 三向映射无遗漏 | ✅ | §8.1 核对表 |
| 引用上游 ≥6 处 file:line 级证据 | ✅ | 30+ 处 `[[04_API_SPEC/api-spec.md#章节]]` 级引用 |
| frontmatter + 一致性声明 | ✅ | 文件头依赖行 + 一致性声明段 |
| 不修改 04/05 已发布文档 | ✅ | 仅引用，未触碰上游文件 |

### §8.3 上游留白与升级项

| 项 | 性质 | 建议 |
|----|------|------|
| `ARCHITECTURE_DOC_INCOMPLETE` 违规码正式收录 | api-spec.md §7.3 留白（agent-comm.md §4.4 提请） | 提请 api-spec v0.5 §7.3 错误码总表正式收录，便于 TC-JUDGE-058 引用 |
| `SESSION_LOCK_CONTENTION` 正式收录 | api-spec.md §7.3 SYSTEM 域留白（agent-comm.md §2.3.1 提请） | 提请 api-spec v0.5 §7.3 SYSTEM 域收录，便于 TC-BOUND-198 引用 |
| `GUIDE_INTERNAL_JUDGE_FAILED` wrap 错误码 | api-spec.md §7 SYSTEM 域预留（agent-comm.md §5.3 提请） | 提请 api-spec v0.5 §7 SYSTEM 域子表，便于 TC-EXCEPT-148 引用 |
| autofix.triggered attemptNumber 取值 1~3 | data-model.md §4.3 未显式约束（建议枚举） | 提请 data-model v0.7 §4.3 显式约束为 1~3 整数 |
| click.fix.targetType 7 值枚举 | events.md §3.7 工程化补充（button/input/card/text/image/layout/other） | 提请 architecture §7 Phase 1 `data-ai-type` 列举完整取值 |

---

## §9 审查记录（G1-G5 自审，§4.6 强制）

> 评审机制：[[05_PROJECT_PLAN/workflow.md]] §2.2 第一阶段 Agent 团队洁净室评审 + tree-commander SKILL §4.6 worker 自审（review_required=true 引擎硬强制）。G1-G5 五视角并行 spawn 5 个 SubAgent 独立审查 → worker 自改 → 复审至 red 归零（≤3 轮）。

### §9.1 评审主体与视角分配

| 角色 | 视角 | 范围 |
|------|------|------|
| nanju05-A-worker（本 worker，GLM-5.2） | 审查主体 + 自改 + 收尾 | 汇总 findings、改文档、写审查记录 |
| SubAgent-G1 | G1 完整性 | 端点覆盖面（20 端点）、events 覆盖（14 events）、sprint 覆盖（S1-S3 验收点）、章节齐全 |
| SubAgent-G2 | G2 一致性 | 对照 api-spec.md v0.4 / events.md / sprint-plan.md / workflow.md / agent-comm.md / data-model-api.md |
| SubAgent-G3 | G3 可执行性 | 工具栈选型（Vitest + Playwright）、Mock 策略可落地、CI 集成 |
| SubAgent-G4 | G4 可读性 | 结构清晰、术语与上游一致、表格标注完整 |
| SubAgent-G5 | G5 格式合规 | 文件头元信息、`[[...]]` 引用、测试用例 ID 三段式 |

### §9.2 第 1 轮 findings（草稿 → v0.2）

> 待 §4.6 自审 SubAgent 产出后填入。详见 `<treeDir>/deliverables/subagent-outputs/sub-nanju05-A-worker-01.md` ~ `-05.md`。

### §9.3 收敛结论

> 待 review_round event 末轮 red_count=0 后填入。

---

## §10 Phase 2-4 测试骨架（S4-S13）

> **本章节定位**（响应 macp 审计 C2-P0-1）：补齐 §0.3 范围声明"快消型 MVP（S1-S3）"之后的 Phase 2-4（S4-S13 共 10 Sprint）测试规划空白。§5 已覆盖 S1-S3 验收清单（TC-SPRINT-155~183），本节为 S4-S13 每个 Sprint 给出四要素测试骨架（测试目标 / 测试范围 / 关键用例骨架 / 验收标准），对齐 [[05_PROJECT_PLAN/sprint-plan.md]] §2.2 Sprint 矩阵 + §4.1（Phase 2 S4-S7）/ §4.2（Phase 3 S8-S10）/ §4.3（Phase 4 S11-S13）。
>
> **用例 ID 编号决策**（autonomy 自决）：DOMAIN 复用 `SPRINT`（§1.5 既有），与 §5 S1-S3 保持同 DOMAIN 以体现"Sprint 验收用例"语义一致性；编号从 TC-SPRINT-210 起（衔接 §6 最大编号 TC-BOUND-209），按 Sprint 段分配，每 Sprint 预留 10 槽位（S4=210~219 / S5=220~229 / S6=230~239 / S7=240~249 / S8=250~259 / S9=260~269 / S10=270~279 / S11=280~289 / S12=290~299 / S13=300~309）。**不新增 DOMAIN**；涉及的具体模块/端点/events 在"测试范围"与"场景骨架"列中标注，可与 §2~§6 用例交叉引用。本节为**骨架（skeleton）**——每用例给出场景骨架与断言要点，实际 `.test.ts` 落地属编码阶段（§0.3 out_of_scope）。
>
> **层级标注**：每用例标 `[U]` 单元 / `[I]` 集成 / `[E]` E2E，对齐 §1.1 金字塔。Phase 2-4 因业务复杂度上升，集成/E2E 占比相对 Phase 1 提高。
>
> **章节编号决策**（autonomy 自决）：§8（一致性核对）/§9（审查记录）已被占用，新章节命名 §10/§11 直接追加在文档末尾，最小破坏现有 §8/§9 引用。

### §10.1 Sprint 4：长期型前台流程（Phase 2，对齐 sprint-plan §4.1）

**核心增量**（sprint-plan §2.2/§4.1）：架构师/工程经理从后台跳前台，用户参与技术选型与 Sprint 优先级确认。

**① 测试目标**：验证长期迭代型项目前台流程——架构设计师（US-G04†）与工程经理（US-G05†）角色前台化、用户可参与技术方案确认与 Sprint 规划确认（US-U03）、阶段路由（US-G06†）支持前台交互节点。

**② 测试范围**：

| 模块 | 覆盖故事 | 测试维度（对齐 §1.3） |
|------|---------|---------------------|
| 向导Agent引擎（前台） | US-G04† 架构师前台、US-G05† 工程经理前台、US-G06† 阶段路由前台 | 功能正确性 |
| 对话路由层（前台多角色交互） | US-U03 用户参与架构/Sprint 确认 | 功能 + 容错 |
| 前端UI层（前台确认界面） | US-U03 技术选型确认 UI、Sprint 优先级确认 UI | 功能 + 跨平台 |
| 裁判引擎 | 长期型硬约束（架构文档完整性） | 功能正确性 |

**③ 关键用例骨架 TC-SPRINT-210~219**：

| 用例 ID | 层级 | 场景骨架 | 关键断言要点 |
|---------|------|---------|-------------|
| TC-SPRINT-210 | [E] | 长期型项目架构师前台：用户完成需求对话后，架构师角色前台展示技术方案 | `role.switched(toRole='architect')` 触发；UI 渲染技术方案卡片 |
| TC-SPRINT-211 | [E] | 用户参与技术选型确认（US-U03）：对架构师推荐方案"确认/修改" | `architecture.confirmed` 仅在用户确认后触发；未确认不推进 stage |
| TC-SPRINT-212 | [E] | 工程经理前台 Sprint 规划确认（US-G05†）：展示 Sprint 列表，用户调整优先级 | Sprint 优先级变更落盘 `05_PROJECT_PLAN/sprint-plan.md`；埋点记录 |
| TC-SPRINT-213 | [I] | US-G06† 前台阶段路由：requirements → architecture → planning 完整前台链 | stage 状态机迁移合法；非法跳转返回 GUIDE_INVALID_STAGE_TRANSITION |
| TC-SPRINT-214 | [U] | 长期型 mode=iterative 下 confirm architecture toStage=planning 合法 | 对齐 TC-GUIDE-049；accepted=true |
| TC-SPRINT-215 | [I] | 用户拒绝架构方案 → 架构师重新生成 | 拒绝不触发 architecture.confirmed；触发再次 role.switched 回 architect |
| TC-SPRINT-216 | [U] | 前台确认节点 Session Restart 保持 SPSAS 锁归属 | 对齐 TC-BOUND-199；锁 owner 不变 |
| TC-SPRINT-217 | [E] | 前台多角色切换埋点完整：requirement-analyst → ux-advisor → architect → engineering-manager | `role.switched` ≥ 3 次；triggerReason 链合理 |
| TC-SPRINT-218 | [I] | 长期型硬约束：架构文档模块依赖关系段缺失 → judge 退回 | `ARCHITECTURE_DOC_INCOMPLETE`（对齐 TC-JUDGE-058） |
| TC-SPRINT-219 | [E] | 跨平台前台确认 UI：Win/macOS/Linux 三平台技术选型确认界面渲染 | Playwright 三平台截图断言 |

**④ 验收标准**（对齐 sprint-plan §4.1 Phase 2 验收"长期迭代型项目可走完整流程"）：
- ✅ 长期型项目从前台完成"需求 → 架构确认 → Sprint 规划确认"全链
- ✅ 用户技术选型/Sprint 优先级的修改被记录且可追溯（埋点 + 文档落盘）
- ✅ 非法 stage 跳转被裁判/路由拦截
- ✅ 前台多角色切换埋点完整、SPSAS 锁归属稳定

---

### §10.2 Sprint 5：PlantUML 约束体系（Phase 2）

**核心增量**（sprint-plan §2.2/§4.1）：类图 + 时序图编程；裁判校验代码-PlantUML 一致性（Phase 1 浅层类名 → 方法签名级）。

**① 测试目标**：验证编程 Agent 架构师角色（US-P04* 骨架）产出 PlantUML 类图/时序图，裁判引擎升级到方法签名级一致性校验。

**② 测试范围**：

| 模块 | 覆盖故事 | 测试维度 |
|------|---------|---------|
| 编程Agent引擎（架构师角色骨架） | US-P04* PlantUML 生成 | 功能正确性 |
| 裁判引擎（PlantUML 校验增强） | 裁判代码-PlantUML 一致性（方法签名级） | 功能 + 安全（注入防护） |
| 向导Agent引擎 | 类图/时序图文档产出 | 数据完整性 |

**③ 关键用例骨架 TC-SPRINT-220~229**：

| 用例 ID | 层级 | 场景骨架 | 关键断言要点 |
|---------|------|---------|-------------|
| TC-SPRINT-220 | [U] | 架构师生成合法 PlantUML 类图 | `.puml` 含 `@startuml`/`@enduml`；TS Compiler API 可解析 |
| TC-SPRINT-221 | [U] | 类图方法签名级提取：class A + method foo(x:int):void | AST 提取 className/methodName/params/returnType 全字段 |
| TC-SPRINT-222 | [I] | 裁判代码-PlantUML 一致性 happy path：代码类/方法与 puml 全匹配 | `judge.evaluateCode classConsistency.matchedClasses.length>0`，`missingInCode=[]` |
| TC-SPRINT-223 | [U] | 一致性失败：代码缺 puml 中定义的方法 → missingInCode 非空 | `verdict='reject'`，`missingInCode` 含缺失方法签名 |
| TC-SPRINT-224 | [U] | PlantUML 语法错误（缺 @enduml） | `PLANTUML_SYNTAX_INVALID`（对齐 TC-JUDGE-059） |
| TC-SPRINT-225 | [U] | PlantUML 注入防护：恶意 puml 含 `!include /etc/passwd` | 解析器拒绝文件包含；不出沙箱（L0 路径校验） |
| TC-SPRINT-226 | [I] | 时序图生成 + 校验：sequence.puml 与 agent-comm.md §3 时序对齐 | 时序图 message 顺序与 §3 三 Agent 协作时序一致 |
| TC-SPRINT-227 | [U] | 方法签名级一致性：参数类型/返回值类型不匹配 | `classConsistency.mismatchedSignatures` 非空 |
| TC-SPRINT-228 | [I] | PlantUML 修改触发快照 | `snapshot.create triggerType` 合理；hardlinkedFiles>0 |
| TC-SPRINT-229 | [U] | 架构师角色 prompt 加载（PlantUML 生成 System Prompt） | 路由层加载架构师角色配置；role.switched 触发 |

**④ 验收标准**（对齐 sprint-plan §4.1）：
- ✅ 编程 Agent 架构师角色可产出合法 PlantUML 类图/时序图
- ✅ 裁判一致性校验达到方法签名级（类名 + 方法 + 参数 + 返回值）
- ✅ PlantUML 注入风险被沙箱+解析器双重拦截
- ✅ 不一致 verdict=reject 并给出 missingInCode/mismatchedSignatures 清单

---

### §10.3 Sprint 6：多角色 + 软约束（Phase 2）

**核心增量**（sprint-plan §2.2/§4.1）：前端/后端/Reviewer 分离协作；裁判软约束全维度 AI 评估（US-J02† 完整四维）。

**① 测试目标**：验证编程 Agent 多角色（前端/后端/Reviewer）协作链路，裁判软约束从 Phase 1 快消型宽松子场景升级到完整四维 AI 评估（逻辑一致性/可测试性/完整性/可读性）。

**② 测试范围**：

| 模块 | 覆盖故事 | 测试维度 |
|------|---------|---------|
| 编程Agent引擎（多角色拆分） | US-P04† 前端/后端/Reviewer 协作 | 功能 + 时序不变量 |
| 裁判引擎（软约束全维） | US-J02† 四维 AI 评估 | 功能 + 容错（LLM 超时） |
| 对话路由层 | 多角色 Reviewer 协作时序 | 时序不变量 |

**③ 关键用例骨架 TC-SPRINT-230~239**：

| 用例 ID | 层级 | 场景骨架 | 关键断言要点 |
|---------|------|---------|-------------|
| TC-SPRINT-230 | [I] | 多角色协作 happy path：前端生成 → 后端联调 → Reviewer 审查 | 三角色顺序执行；每角色 coder.generateCode taskType 不同 |
| TC-SPRINT-231 | [U] | Reviewer 角色拒绝代码 → 退回前端/后端 | Reviewer verdict 触发再生成；不熔断（软约束） |
| TC-SPRINT-232 | [I] | 软约束四维评估 happy path | `judge.verdict softSuggestions` 含四维评分 |
| TC-SPRINT-233 | [U] | 软约束 LLM 超时（60s） | `JUDGE_LLM_TIMEOUT`（对齐 TC-JUDGE-066）；408 可重试 |
| TC-SPRINT-234 | [U] | 软约束评估降级：LLM 不可用 → 回退规则引擎 | 软约束用规则兜底；verdict 仍可出 |
| TC-SPRINT-235 | [I] | 多角色协作埋点：每个角色 coding.executed | `coding.executed` ≥ 3 次（前端/后端/Reviewer） |
| TC-SPRINT-236 | [U] | 软约束建议非阻断：verdict=pass + softSuggestions 非空 | 软约束不影响 pass 判定（仅建议） |
| TC-SPRINT-237 | [I] | Reviewer 协作 SPSAS：多角色同 projectId 单活动会话 | 对齐 TC-BOUND-198；锁归属穿越多角色 |
| TC-SPRINT-238 | [U] | 四维评分完整性：逻辑一致性/可测试性/完整性/可读性 均有分值 | softSuggestions[].dimension 覆盖四维 |
| TC-SPRINT-239 | [I] | 前后端接口契约一致性：前端调用与后端 API schema 对齐 | 对齐 §2 契约测试；接口签名匹配 |

**④ 验收标准**（对齐 sprint-plan §4.1）：
- ✅ 编程 Agent 前端/后端/Reviewer 三角色协作链路可跑通
- ✅ 裁判软约束四维 AI 评估完整产出
- ✅ 软约束 LLM 异常有降级策略（规则兜底），不阻塞主流程
- ✅ 多角色协作下 SPSAS 不变量保持

---

### §10.4 Sprint 7：GWT 自动生成 + 版本管理（Phase 2）

**核心增量**（sprint-plan §2.2/§4.1）：PRD → GWT Feature 自动生成执行；changelog + 跨会话上下文交接。

**① 测试目标**：验证 GWT Feature 从 PRD 功能项自动生成（US-G07† 完整版）、自动执行收口，以及版本管理（changelog）与跨会话上下文交接（US-U09）。

**② 测试范围**：

| 模块 | 覆盖故事 | 测试维度 |
|------|---------|---------|
| 向导Agent引擎（GWT 自动生成完整版） | US-G07† | 功能 + 数据完整性 |
| 编程Agent引擎（GWT 执行） | US-U09 | 功能 |
| 快照管理器（版本管理） | changelog | 数据完整性 |
| 对话路由层（跨会话上下文交接） | US-U09 | 功能 + 容错 |

**③ 关键用例骨架 TC-SPRINT-240~249**：

| 用例 ID | 层级 | 场景骨架 | 关键断言要点 |
|---------|------|---------|-------------|
| TC-SPRINT-240 | [U] | GWT 自动生成 happy path：PRD 功能项 → Feature 场景 | `06_TESTS/features/*.feature` 生成；含 Given/When/Then |
| TC-SPRINT-241 | [U] | GWT 覆盖三态：正常路径 + 边界 + 异常 | 每 PRD 功能项 ≥ 3 场景（normal/boundary/exception） |
| TC-SPRINT-242 | [I] | GWT 自动执行收口：coder.runGwt 跑生成出的 Feature | `data.allPassed` 或自修复后通过 |
| TC-SPRINT-243 | [U] | GWT 生成语法校验：生成物 .feature 合法 | 自研 runner 可解析（对齐 TC-CODER-021） |
| TC-SPRINT-244 | [I] | changelog 生成：版本切换自动追加 | `07_VERSIONS/changelog.md` 追加条目；含版本号/日期/变更项 |
| TC-SPRINT-245 | [I] | 跨会话上下文交接（US-U09）：关闭重开项目恢复 SessionContext | `sessions/{projectId}.json` 反序列化；sessionResumed=true |
| TC-SPRINT-246 | [U] | Session Restart 六步完整（Context Backfill） | 对齐 §1.3 集成层 Session Restart 六步；摘要 <500 tokens |
| TC-SPRINT-247 | [I] | 跨会话 SPSAS 锁恢复：重开后 acquireProjectLock | 锁 TTL 过期可强占（对齐 TC-BOUND-202） |
| TC-SPRINT-248 | [U] | GWT 生成与 PRD 功能项追溯：每 Feature 可回溯 PRD § | Feature 注释含 PRD 章节引用 |
| TC-SPRINT-249 | [I] | 版本回滚 + changelog 一致：回滚后 changelog 记录 | `user.undo` + changelog 追加回滚条目 |

**④ 验收标准**（对齐 sprint-plan §4.1 Phase 2 验收"全文档 + PlantUML + 多角色协作 + 版本迭代"）：
- ✅ PRD 功能项可自动生成覆盖三态的 GWT Feature 并执行收口
- ✅ 版本切换自动产出 changelog
- ✅ 跨会话上下文可恢复（SessionContext + SPSAS 锁）
- ✅ GWT 生成物可追溯 PRD 源

---

### §10.5 Sprint 8：工程模板体系（Phase 3，对齐 sprint-plan §4.2）

**核心增量**（sprint-plan §2.2/§4.2）：6 模板（Web/移动/桌面/CLI/硬件/AI）+ 自动推断（PRD §11，US-G05†）。

**① 测试目标**：验证工程模板体系——6 个工程模板完整性、工程经理角色模板自动推断（US-G05†）、模板可扩展性（响应 macp 交叉验证 2"工程模板可扩展性 §11.4 全栈断层"——测试侧补齐）。

**② 测试范围**：

| 模块 | 覆盖故事 | 测试维度 |
|------|---------|---------|
| 向导Agent引擎（工程经理模板推断） | US-G05†、PRD §11 | 功能正确性 |
| 前端UI层（模板选择/预览） | PRD §11 | 功能 + 跨平台 |
| 项目管理（模板元数据） | PRD §11.4 可扩展性 | 数据完整性 |

**③ 关键用例骨架 TC-SPRINT-250~259**：

| 用例 ID | 层级 | 场景骨架 | 关键断言要点 |
|---------|------|---------|-------------|
| TC-SPRINT-250 | [U] | 6 模板完整性：Web/移动/桌面/CLI/硬件/AI 均可加载 | 每模板含目录骨架 + 依赖清单 + 启动脚本 |
| TC-SPRINT-251 | [E] | 模板自动推断 happy path：需求描述 → 推断 web-fullstack | `template` 字段值与需求匹配；用户可确认/修改 |
| TC-SPRINT-252 | [U] | 模板枚举校验：template='unknown' | `INPUT_INVALID`（对齐 TC-CODER-009 维度） |
| TC-SPRINT-253 | [I] | 模板可扩展性：自定义模板注册（PRD §11.4） | 自定义模板可被 list/推断识别；不写死 enum |
| TC-SPRINT-254 | [U] | 模板与 mode 联动：quick 模式模板简化集 | quick 下模板子集；iterative 下全量 |
| TC-SPRINT-255 | [E] | 模板选择 UI：6 模板卡片渲染 + 选中态 | Playwright 断言 6 卡片可点选 |
| TC-SPRINT-256 | [I] | 模板生成代码骨架：选 CLI 模板 → 生成 CLI 目录 | `_code/` 含 CLI 入口文件；template 字段落盘 |
| TC-SPRINT-257 | [U] | 模板元数据完整性：每模板含 name/desc/deps/scaffold | 元数据 schema 校验通过 |
| TC-SPRINT-258 | [I] | 模板切换快照：用户改模板触发 mode-switch 类快照 | snapshot.create 记录；hardlinkedFiles>0 |
| TC-SPRINT-259 | [U] | 工程经理角色模板推断 prompt | 路由层加载工程经理角色；埋点 role.switched |

**④ 验收标准**（对齐 sprint-plan §4.2）：
- ✅ 6 工程模板完整可用
- ✅ 模板自动推断准确率可验证（需求 → 模板匹配）
- ✅ 模板可扩展（自定义模板可注册，不写死 enum）—— 补 macp 交叉验证 2 的测试断层
- ✅ 模板选择 UI 三平台可用

---

### §10.6 Sprint 9：点选纠错完整（Phase 3）

**核心增量**（sprint-plan §2.2/§4.2）：Phase 2 混合兜底（视觉模型）+ Phase 3 框选多元素（US-U05†，[[03_ARCHITECTURE/architecture.md]] §7）。

**① 测试目标**：验证点选纠错从 MVP（data-ai-id 主路径）升级到完整版——phase2 视觉模型混合兜底 + phase3 框选多元素批量纠错。

**② 测试范围**：

| 模块 | 覆盖故事 | 测试维度 |
|------|---------|---------|
| 前端UI层（点选/框选交互） | US-U05† | 功能 + 跨平台 |
| 向导Agent引擎（规约生成） | US-U05† clickToFix phase2/3 | 功能 + 容错 |
| 编程Agent引擎（applyFix 多元素） | US-U05† | 功能 |

**③ 关键用例骨架 TC-SPRINT-260~269**：

| 用例 ID | 层级 | 场景骨架 | 关键断言要点 |
|---------|------|---------|-------------|
| TC-SPRINT-260 | [E] | phase1 主路径 data-ai-id 点选（回归） | 对齐 TC-SPRINT-181；clickToFix → applyFix → 刷新 |
| TC-SPRINT-261 | [I] | phase2 视觉模型混合兜底：元素无 data-ai-id 时视觉识别 | `clickToFix phase='phase2'` 返回 fixSpec + confidence（对齐 TC-GUIDE-044） |
| TC-SPRINT-262 | [U] | phase2 视觉模型失败 | `GUIDE_VISION_MODEL_FAILED`（对齐 TC-GUIDE-046） |
| TC-SPRINT-263 | [E] | phase3 框选多元素：用户框选区域 → 批量规约 | 批量 fixSpec[]；applyFix 多文件修改 |
| TC-SPRINT-264 | [U] | 框选 scope=multielement 合法性 | scope 枚举含 multielement（对齐 TC-CODER-019 维度） |
| TC-SPRINT-265 | [I] | 批量 applyFix 原子性：多元素修改全部成功或全部回滚 | preModifySnapshot 保护；失败回滚 |
| TC-SPRINT-266 | [U] | 点选纠错埋点 click.fix 多元素 | `click.fix` 含 targetType；多元素场景多次 emit |
| TC-SPRINT-267 | [I] | 视觉模型 confidence 阈值：低于阈值 → 降级人工确认 | confidence < 阈值不自动 apply；提示用户 |
| TC-SPRINT-268 | [E] | phase1/2/3 自动降级链：有 ai-id 走 phase1，无走 phase2，区域走 phase3 | 路由层按元素特征选 phase |
| TC-SPRINT-269 | [U] | 点选纠错 pre-modify 快照保护（回归） | 对齐 TC-EXCEPT-152；preModifySnapshotId>0 |

**④ 验收标准**（对齐 sprint-plan §4.2）：
- ✅ phase2 视觉模型兜底可用（无 data-ai-id 元素可纠错）
- ✅ phase3 框选多元素批量纠错可用
- ✅ phase1/2/3 自动降级链正确
- ✅ 批量修改原子性 + pre-modify 快照保护

---

### §10.7 Sprint 10：自愈加固 + 跨会话（Phase 3）

**核心增量**（sprint-plan §2.2/§4.2）：熔断策略多样化 + DevOps/PM 角色 + 跨会话上下文平滑交接（US-P02†, US-P04†）。

**① 测试目标**：验证异常自愈从 Phase 1 单一熔断（3 次失败 → 回滚）升级到多样化熔断策略，角色池全激活（DevOps/PM），跨会话上下文平滑交接。

**② 测试范围**：

| 模块 | 覆盖故事 | 测试维度 |
|------|---------|---------|
| 编程Agent引擎（自愈加固） | US-P02† | 容错（异常自愈） |
| 编程Agent引擎（DevOps/PM 角色） | US-P04† | 功能 |
| 对话路由层（跨会话交接） | US-P02† | 容错 + 时序 |
| 快照管理器（回滚策略多样化） | US-P02† | 数据完整性 |

**③ 关键用例骨架 TC-SPRINT-270~279**：

| 用例 ID | 层级 | 场景骨架 | 关键断言要点 |
|---------|------|---------|-------------|
| TC-SPRINT-270 | [I] | 熔断策略 1（回归）：3 次自修复失败 → 回滚 | 对齐 TC-EXCEPT-136；autofix.triggered × 3 circuit-broken |
| TC-SPRINT-271 | [I] | 熔断策略 2：换技术方案重试（不回滚） | 快消型换方案链路（对齐 TC-EXCEPT-139） |
| TC-SPRINT-272 | [I] | 熔断策略 3：长期型设计约束不可实现 → 升级架构变更 | 对齐 TC-EXCEPT-140；走文档流 |
| TC-SPRINT-273 | [U] | 熔断策略选择逻辑：按错误类型路由策略 | 错误码 → 策略映射可配置 |
| TC-SPRINT-274 | [E] | DevOps 角色激活：CI/CD 配置生成 | DevOps 角色 coding.executed；产出 CI 配置 |
| TC-SPRINT-275 | [E] | PM 角色激活：项目看板/进度管理 | PM 角色 prompt 加载；埋点 |
| TC-SPRINT-276 | [I] | 跨会话上下文平滑交接：长项目分多次会话完成 | SessionContext 恢复；用户无感知中断 |
| TC-SPRINT-277 | [U] | 跨会话埋点连续性：events 序列跨会话有序 | ORD-01~07 跨会话仍满足 |
| TC-SPRINT-278 | [I] | 角色池全激活：架构师/前端/后端/Reviewer/DevOps/PM 6 角色 | 6 角色 role.switched 均可触发 |
| TC-SPRINT-279 | [I] | 自愈加固不倒回需求（回归） | 对齐 TC-EXCEPT-141；编程层闭环 |

**④ 验收标准**（对齐 sprint-plan §4.2 + §4.1 角色池激活说明）：
- ✅ 熔断策略多样化（回滚/换方案/架构变更）按错误类型路由
- ✅ 角色池 6 角色全激活（含 DevOps/PM）
- ✅ 跨会话上下文平滑交接，埋点时序不变量跨会话满足
- ✅ 自愈加固不倒回需求阶段

---

### §10.8 Sprint 11：全量埋点完善（Phase 4，对齐 sprint-plan §4.3）

**核心增量**（sprint-plan §2.2/§4.3）：13 事件全覆盖 + 数据脱敏 + 30 天保留（PRD §12，US-R02†）。

**① 测试目标**：验证埋点从 Phase 1 快消型所需子集升级到 13 事件全覆盖，数据脱敏与保留策略落地（响应 macp sprint-plan §7"Phase 1-3 埋点临时保留"风险）。

**② 测试范围**：

| 模块 | 覆盖故事 | 测试维度 |
|------|---------|---------|
| 埋点采集层（13 事件全覆盖） | US-R02† | 数据完整性 + 时序不变量 |
| 埋点采集层（脱敏） | US-R02†、PRD §12 | 安全 |
| 埋点采集层（30 天保留） | US-R02†、PRD §12 | 数据完整性 |

> **事件数对齐声明**（must_report 性质，已在 macp-root-summary §三标注，不阻塞）：macp 审计发现 test-plan §0 引用"14 关键埋点"、data-model §4.3 为 14 eventType 枚举、events.md §1 总览亦 14 事件，但 sprint-plan §2.2/§4.3 S11 称"13 事件全覆盖"。本节以 sprint-plan §4.3 S11 表述"13 事件"为验收口径，13 vs 14 的差异属上游文档口径问题，测试侧按"全量事件覆盖"验收，不因 13/14 计数争议阻塞；建议上游（events.md/data-model/sprint-plan）统一口径。

**③ 关键用例骨架 TC-SPRINT-280~289**：

| 用例 ID | 层级 | 场景骨架 | 关键断言要点 |
|---------|------|---------|-------------|
| TC-SPRINT-280 | [I] | 13（/14）事件全覆盖：全链路跑通后每事件至少 1 条 | events.md §1 总览逐事件命中（对齐 §3） |
| TC-SPRINT-281 | [U] | 数据脱敏：PII（邮箱/手机）字段脱敏后落盘 | JSONL 中敏感字段被掩码；原文不落盘 |
| TC-SPRINT-282 | [I] | 30 天保留策略：>30 天事件归档/删除 | 旧分片 `events-YYYY-MM.jsonl` 按策略处理 |
| TC-SPRINT-283 | [U] | JSONL 原子追加（回归） | 对齐 §6.3 _meta.json 原子写纪律；行级容错 |
| TC-SPRINT-284 | [I] | 跨月分片：事件跨月写入正确分片 | `events-2026-07.jsonl` / `events-2026-08.jsonl` 分片正确 |
| TC-SPRINT-285 | [U] | emitBatch 大批量 happy path | 对齐 TC-TELEMETRY-090；acceptedCount=100 |
| TC-SPRINT-286 | [I] | query 聚合查询 happy path | 对齐 TC-TELEMETRY-093/094；rows <= 5000 |
| TC-SPRINT-287 | [U] | 脱敏可逆性：脱敏后不可逆（不可还原原文） | 脱敏字段单向；审计可追溯脱敏动作 |
| TC-SPRINT-288 | [I] | 时序不变量 ORD-01~07 全量场景（回归） | 对齐 TC-EVENT-127~133；全链路满足 |
| TC-SPRINT-289 | [U] | TELEMETRY_BUFFER_OVERFLOW 大流量 | 对齐 TC-TELEMETRY-088；droppedCount 递增 |

**④ 验收标准**（对齐 sprint-plan §4.3）：
- ✅ 全量事件覆盖（13/14 事件全链路命中）
- ✅ 数据脱敏落地（PII 不原文落盘）
- ✅ 30 天保留策略生效
- ✅ 时序不变量全量场景满足

---

### §10.9 Sprint 12：分析看板（Phase 4）

**核心增量**（sprint-plan §2.2/§4.3）：效率/Token/认知摩擦/文档合规/范式挖掘 5 大看板（US-R01）。

**① 测试目标**：验证 5 大分析看板数据聚合层与 UI 展示（响应 macp 交叉验证 2"分析看板 §12.6 全栈断层"——测试侧补齐）。

**② 测试范围**：

| 模块 | 覆盖故事 | 测试维度 |
|------|---------|---------|
| 前端UI层（5 大看板） | US-R01 | 功能 + 跨平台 |
| 埋点采集层（数据聚合层） | US-R01 | 数据完整性 + 性能 |

**③ 关键用例骨架 TC-SPRINT-290~299**：

| 用例 ID | 层级 | 场景骨架 | 关键断言要点 |
|---------|------|---------|-------------|
| TC-SPRINT-290 | [E] | 效率看板：项目耗时/阶段耗时分布 | 看板渲染；数据与 telemetry.query 一致 |
| TC-SPRINT-291 | [E] | Token 看板：totalTokenUsed 聚合 | 看板数据 = Project.totalTokenUsed 汇总 |
| TC-SPRINT-292 | [E] | 认知摩擦看板：dialog 轮数/澄清次数 | 数据来源 dialog.submitted 事件聚合 |
| TC-SPRINT-293 | [E] | 文档合规看板：裁判硬约束通过率 | 数据来源 judge.verdict 聚合 |
| TC-SPRINT-294 | [E] | 范式挖掘看板：mode/template 分布 | 数据来源 project.created + mode.switch |
| TC-SPRINT-295 | [I] | 数据聚合层正确性：看板数据 = 原始事件聚合 | 聚合查询结果与看板显示一致 |
| TC-SPRINT-296 | [U] | 看板时间范围筛选：7天/30天/全部 | 筛选参数透传 telemetry.query |
| TC-SPRINT-297 | [I] | 看板性能：大数据量（>5000 事件）查询响应 | truncated 处理；分页 |
| TC-SPRINT-298 | [E] | 看板跨平台渲染 | Win/macOS/Linux 三平台截图 |
| TC-SPRINT-299 | [U] | 看板数据脱敏一致性 | 看板不展示 PII 原文（与 S11 脱敏一致） |

**④ 验收标准**（对齐 sprint-plan §4.3）：
- ✅ 5 大看板全部上线可渲染
- ✅ 看板数据与原始埋点聚合一致
- ✅ 大数据量查询性能可接受（truncated/分页）
- ✅ 看板数据脱敏与 S11 一致

---

### §10.10 Sprint 13：A/B 实验 + 论文数据（Phase 4）

**核心增量**（sprint-plan §2.2/§4.3）：实验分组配置 + 对比分析（p 值）+ 数据导出（US-R03）。

**① 测试目标**：验证 A/B 实验配置、对比分析统计显著性（p 值）、数据导出（CSV/JSON 含显著性标注）。

**② 测试范围**：

| 模块 | 覆盖故事 | 测试维度 |
|------|---------|---------|
| 前端UI层（实验管理） | US-R03 | 功能 |
| 埋点采集层（实验分组/分析） | US-R03 | 数据完整性 + 正确性 |

**③ 关键用例骨架 TC-SPRINT-300~309**：

| 用例 ID | 层级 | 场景骨架 | 关键断言要点 |
|---------|------|---------|-------------|
| TC-SPRINT-300 | [E] | 实验分组配置 UI：A/B 两组配置 | 分组配置落盘；用户可建/编辑实验 |
| TC-SPRINT-301 | [I] | 实验分组分流：用户随机分入 A/B | 分流比例可配置；分组持久化 |
| TC-SPRINT-302 | [U] | 对比分析 p 值计算：两组指标差异显著性 | p 值计算公式正确（统计检验） |
| TC-SPRINT-303 | [I] | 数据导出 CSV：含显著性标注 | CSV 列含 p值/显著性标记；可论文引用 |
| TC-SPRINT-304 | [I] | 数据导出 JSON：结构与 events 对齐 | JSON schema 含原始事件 + 聚合指标 |
| TC-SPRINT-305 | [U] | 显著性判定阈值：p<0.05 标显著 | 阈值可配置；标注正确 |
| TC-SPRINT-306 | [I] | 实验组埋点隔离：A/B 组 events 不互染 | 分组字段贯穿事件 payload |
| TC-SPRINT-307 | [E] | 实验管理 UI：列表/启停/结果查看 | Playwright 断言实验生命周期 |
| TC-SPRINT-308 | [U] | 导出数据脱敏：CSV/JSON 不含 PII 原文 | 与 S11 脱敏一致 |
| TC-SPRINT-309 | [I] | 论文数据完整性：导出可独立复现分析 | 导出含足够元数据（时间范围/分组/指标定义） |

**④ 验收标准**（对齐 sprint-plan §4.3）：
- ✅ A/B 实验分组配置与分流可用
- ✅ 对比分析 p 值计算正确，显著性标注
- ✅ 数据导出 CSV/JSON 含显著性标注，可论文引用
- ✅ 导出数据脱敏 + 可复现

---

### §10.11 Phase 2-4 测试用例覆盖率反向追溯

| Sprint | 用例 ID 范围 | 数量 | 上游基准（sprint-plan） |
|--------|------------|------|----------------------|
| S4 长期型前台 | TC-SPRINT-210~219 | 10 | §2.2 S4 + §4.1 |
| S5 PlantUML 约束 | TC-SPRINT-220~229 | 10 | §2.2 S5 + §4.1 |
| S6 多角色软约束 | TC-SPRINT-230~239 | 10 | §2.2 S6 + §4.1 |
| S7 GWT 自动生成+版本 | TC-SPRINT-240~249 | 10 | §2.2 S7 + §4.1 |
| S8 工程模板 | TC-SPRINT-250~259 | 10 | §2.2 S8 + §4.2 |
| S9 点选纠错完整 | TC-SPRINT-260~269 | 10 | §2.2 S9 + §4.2 |
| S10 自愈加固+跨会话 | TC-SPRINT-270~279 | 10 | §2.2 S10 + §4.2 |
| S11 全量埋点 | TC-SPRINT-280~289 | 10 | §2.2 S11 + §4.3 |
| S12 分析看板 | TC-SPRINT-290~299 | 10 | §2.2 S12 + §4.3 |
| S13 A/B 实验+论文 | TC-SPRINT-300~309 | 10 | §2.2 S13 + §4.3 |
| **Phase 2-4 合计** | TC-SPRINT-210~309 | **100** | sprint-plan §4.1/§4.2/§4.3 全覆盖 |

> **三向映射补充**：本节 100 用例 + §5 S1-S3 的 29 用例（TC-SPRINT-155~183）= Sprint 验收用例共 129 个；加上 §2 端点契约 112 + §3 events 21 + §4 异常自愈 21 + §6 权限边界 26 = 全文档用例总数 **309**（TC-CODER-001~TC-SPRINT-309），全程三段式唯一。Phase 2-4 测试骨架补齐 macp 审计 C2-P0-1 所指"10 个 Sprint 无任何测试章节"的项目级最大测试债务。

---

## §11 被测实现判据（响应 C2-P0-3）

> **本章节定位**（响应 macp 审计 C2-P0-3）：sprint-note 自承"自修复 3 次失败判据未明 / Context Backfill 六步可跑无客观信号 / 快照线性回滚文件级实现略空"，直接卡住 §4/§5 用例的自动化判定。本节为 §1.3 九测试维度对应的 **7 类用例**（单元 / 集成 / E2E / 契约 / 事件触发 / 异常自愈 / 权限边界）定义**可自动化判定**的 PASS/FAIL 客观信号——非主观评估，全部可由测试运行器（Vitest / Playwright / 自研 runner）断言或退出码判定，满足 §7.2 CI 离线运行要求。
>
> **判据设计原则**：
> 1. **客观可测**：每信号为布尔表达式 / 数值比较 / 序列匹配 / 退出码，无人工主观打分
> 2. **CI 可执行**：全部信号在 mock + fixture 环境可判定（§7.2 不调真实 GLM）
> 3. **与用例 ID 绑定**：每类判据给出"PASS 当且仅当 / FAIL 当"形式化表述，可回写到 `.test.ts` 断言
> 4. **拒绝行为可证**：权限边界类重点验证"业务逻辑未执行"的副作用为零（而非仅看错误码）

### §11.1 单元测试判据

**适用范围**：§2 端点契约（TC-CODER/GUIDE/JUDGE/SNAPSHOT/TELEMETRY/PROJECT）、§3 events payload schema、§4 错误码分支、§6 边界（单元层）。工具：Vitest。

| 信号维度 | PASS 当且仅当 | FAIL 当 | 自动化方式 |
|---------|--------------|--------|-----------|
| 断言通过率 | `expect().toBe()` 等全部通过（断言失败计数 = 0） | 任一 `expect` 抛 AssertionError | Vitest 退出码 0 = PASS；非 0 = FAIL |
| 退出码 | 进程退出码 `process.exitCode === 0` | 退出码 ≠ 0 | `vitest run` CLI 退出码 |
| 覆盖率门槛（CI） | statements ≥ 80% 且 branches ≥ 70%（§7.3） | 覆盖率低于门槛 | `vitest --coverage` 报告 |
| Mock 调用断言 | `vi.mocked(fn).toHaveBeenCalledWith(args)` 匹配 | Mock 未被调用或参数不匹配 | Vitest `vi.mocked` |
| 异步 settle | 所有 Promise resolve，无 unhandled rejection | 任一 Promise reject / 超时 | Vitest `expect().resolves` / timeout |

### §11.2 集成测试判据

**适用范围**：§1.2 集成层（IPC 桥 / 子进程 / 文件系统 / 三 Agent 协作 / Session Restart）、§6 SPSAS / 沙箱集成层。工具：Vitest node 环境 + 自研 IPC harness + 真实 tmpdir。

| 信号维度 | PASS 当且仅当 | FAIL 当 | 自动化方式 |
|---------|--------------|--------|-----------|
| IPC 往返结果匹配 | `ipcRenderer.invoke` 返回值 === 预期 data 结构（深比较） | 返回值结构 / 字段不符 | `expect(returned).toEqual(expected)` 深比较 |
| 子进程退出码 | 编程Agent 子进程 `exitCode === 0`（成功）或预期非 0（受控失败） | 退出码非预期 / 子进程被外部信号杀死（非超时 SIGKILL） | `child_process.spawn` exit 事件 |
| 文件系统最终状态 | `_meta.json` / JSONL / snapshot 目录的最终内容 === 预期（路径存在 + 文件内容 + inode 引用） | 文件缺失 / 内容错 / 硬链接计数不符 | `fs.readFileSync` + `fs.statSync().nlink` 断言 |
| 原子写不变量 | 写中断后 `_meta.json` 不损坏（临时文件 + rename） | 文件损坏 / 部分写入 | kill 进程后 `JSON.parse(readFileSync)` 不抛 |
| SPSAS 锁状态 | 锁文件 owner / 状态符合预期；非持锁会话被拒 | 锁丢失 / 非持锁会话写成功 | 锁文件读取 + 并发 invoke 断言 |
| 时序（六步 Session Restart） | 六步序列严格按序执行（步骤序号 1→6） | 步骤乱序 / 跳步 | 步骤计数器 + 序列断言 |

### §11.3 E2E 测试判据

**适用范围**：§5 Sprint S1-S3 验收 E2E、§10 Phase 2-4 标 `[E]` 用例。工具：Playwright Electron。

| 信号维度 | PASS 当且仅当 | FAIL 当 | 自动化方式 |
|---------|--------------|--------|-----------|
| Playwright 断言 | `expect(page.locator(...)).toContainText(...)` 等全通过 | 任一 locator 断言失败 / 元素未出现（超时） | Playwright `expect` WebFirst |
| 用户可见 UI 状态 | 关键 UI 元素可见且文本匹配（如"已回到上一个正常版本"安抚文案出现） | 文案缺失 / 含 PRD §7.5 黑名单技术词 | `locator().textContent()` 正则匹配 + 黑名单词扫描 |
| 端到端链路完成 | mode-select → delivered 全链路无异常，最终 stage = delivered | 链路中断 / stage 未推进 | stage 字段最终值断言 |
| 跨平台一致性 | Win/macOS/Linux 三平台截图关键区域相似度 ≥ 阈值 | 某平台渲染异常 / 截图缺失 | Playwright `screenshot()` + 视觉对比 |
| Electron 启动 | `_electron.launch` 成功，BrowserWindow 可加载 | 启动失败 / 加载超时 | launch 返回值非 null |

### §11.4 契约测试判据

**适用范围**：§2 端点契约矩阵的 Schema 校验维度、§10.3 前后端接口契约一致性。依据：[[04_API_SPEC/api-spec.md]] §9 错误码总表 + §2~§7 Response Schema。

| 信号维度 | PASS 当且仅当 | FAIL 当 | 自动化方式 |
|---------|--------------|--------|-----------|
| Schema 校验通过 | Response payload 满足 api-spec §X Response Schema（字段必填性 + 类型） | 缺必填字段 / 类型错 / 多余字段（严格模式） | JSON Schema validator（ajv） |
| 错误码精确匹配 | 返回 `error.code` === 预期枚举值（含专属 > 通用优先级，§8.4） | 错误码不匹配 / 返回通用码而预期专属码 | `expect(error.code).toBe('CODER_DOC_NOT_FOUND')` |
| 错误码可重试性 | `retryable` 标记与 api-spec §9 一致（4xx 不可重试 / 5xx 可重试） | 可重试标记错 | `expect(error.retryable).toBe(false)` |
| 端点覆盖率 | 20 端点每端点至少 1 happy + 1 4xx + 1 5xx 用例 | 任端点缺场景 | §7.4 反向追溯表自动校验 |
| 枚举值边界 | 枚举越界返回 INPUT_INVALID（B6 族） | 越界值被接受 | 枚举值 ±1 边界用例 |

### §11.5 事件触发测试判据

**适用范围**：§3 14 events 触发验证（TC-EVENT-113~133）、§10.8 S11 全量埋点、§10.9 看板数据源。依据：[[04_API_SPEC/events.md]] §3 payload + §4 时序不变量 ORD-01~07。

| 信号维度 | PASS 当且仅当 | FAIL 当 | 自动化方式 |
|---------|--------------|--------|-----------|
| events 序列完整 | 预期事件集 ⊆ 实际触发事件集（按 eventType） | 缺事件 / 多余非预期事件 | telemetry.query 反查 + 集合比较 |
| payload 字段匹配 | 每事件 payload 必填字段存在且类型正确（events.md §3） | 缺字段 / 类型错 / 值越界 | payload schema 校验（ajv） |
| 公共字段填充 | projectId / stage / mode / duration 按 events.md §2 规则填充 | 公共字段错（如 mode.switch 后 mode 未切） | §3.4 公共字段校验用例 |
| 时序不变量 ORD-01~07 | 七条不变量全部满足（timestamp 排序校验） | 任一不变量违反 | §3.3 TC-EVENT-127~133 自动化校验 |
| 计数不变量 | `autofix.triggered` ≤ 3 次 / `mode.switch` 同 projectId ≤ 1 次 | 计数超限 | 事件计数断言 |
| 原子追加 | JSONL 行级完整（每行一个有效 JSON） | 行损坏 / 部分行 | `readFileSync().split('\n').every(line => line === '' || JSON.parse(line) succeeds)` |

### §11.6 异常自愈测试判据

**适用范围**：§4 异常自愈熔断回滚（TC-EXCEPT-134~154）、§10.7 S10 自愈加固。依据：[[05_PROJECT_PLAN/workflow.md]] §3.2 + [[01_PRD/prd.md]] §6.3 + [[04_API_SPEC/agent-comm.md]] §5。**本类直接响应 sprint-note 遗留"自修复 3 次失败判据未明"**。

| 信号维度 | PASS 当且仅当 | FAIL 当 | 自动化方式 |
|---------|--------------|--------|-----------|
| 自修复次数计数 | `autofix.triggered` 事件计数 ≤ 3；第 N 次的 `attemptNumber === N`（1/2/3） | 计数 > 3 / attemptNumber 跳号 | autofix.triggered 事件序列计数 |
| 熔断触发信号 | 第 3 次失败后 `autofix.triggered(result='circuit-broken')` 且 `error.code='CODER_AUTOFIX_EXHAUSTED'` | 第 3 次失败未熔断 / 继续重试 | result 字段断言 + 错误码断言 |
| 回滚链路完整 | 熔断后：① `snapshot.rollback` 返回 rolledBackTo = lastHealthy；② preRollbackSnapshotId 非 null；③ `user.undo` emit；④ 当前版本存档 | 回滚链路任一环缺失 / 当前版本丢失 | §4.1 TC-EXCEPT-137 链路四点断言 |
| 状态机迁移正确 | stage 状态机迁移合法（requirements→prototype→architecture→planning→coding→testing→delivered），熔断回滚后 stage 回到健康点 | 非法迁移 / 回滚后 stage 错乱 | data-model.md §2.2 8 stage 状态机迁移函数校验 |
| 通俗化通知文案 | 用户可见文案含安抚语 + 不含 PRD §7.5 黑名单技术词 | 含技术堆栈 / 黑名单词 | 文案正则 + 黑名单词扫描 |
| 不倒回需求 | 任何熔断场景 stage 不回到 requirements（编程层闭环或架构变更路径） | 倒回 requirements 阶段 | 回滚后 stage ≠ requirements 断言 |
| 退回次数上限 | 快消型裁判退回 ≤ 2 次，第 3 次提示人工介入 | 无限重试 | 退回计数断言 |

### §11.7 权限边界测试判据

**适用范围**：§6 权限边界（TC-BOUND-184~209 B5/B6/B4 + 沙箱 L0/L1）、§10 标 `[U]`/`[I]` 涉及权限的用例。依据：[[04_API_SPEC/api-spec.md]] §0.4 B5 + §8.4 B6 + [[04_API_SPEC/agent-comm.md]] §2.3.1 B4 + [[03_ARCHITECTURE/architecture.md]] §6。**本类体现"拒绝行为"的客观性——重点验证副作用为零，而非仅看错误码**。

| 信号维度 | PASS 当且仅当 | FAIL 当 | 自动化方式 |
|---------|--------------|--------|-----------|
| 错误码返回 | 拒绝时返回 `error.code` 精确匹配（SYSTEM_PERMISSION_DENIED / SESSION_LOCK_CONTENTION / CODER_FIX_OUT_OF_SCOPE 等） | 未返回预期错误码 / 返回成功 | `expect(error.code).toBe(...)` |
| 审计埋点 emit | 拒绝时 `telemetry.emit` 触发审计事件（payload 含 callerModule / success=false / reason） | 未 emit 审计 / payload 缺字段 | telemetry.query 反查审计事件 |
| 业务逻辑未执行（拒绝行为） | 被拒操作**副作用为零**：快照未创建（snapshotId 未递增）/ 项目未删除（目录仍在）/ 文件未修改（内容 hash 不变） | 拒绝后仍有副作用（业务逻辑部分执行） | 前后状态对比（快照计数 / 目录存在性 / 文件 hash） |
| 双防线一致 | 前端 services 守卫 + 主进程兜底均拒绝（两道防线） | 仅一道防线拦截 / 渲染层守卫可绕过 | TC-BOUND-184/185 双用例 |
| SPSAS 锁强占 | TTL 过期 / 锁失序时下一 acquireProjectLock 强占 | 强占失败 / 死锁 | 锁文件状态 + 并发场景断言 |
| 沙箱 L0 路径 | 越界访问触发 CODER_FIX_OUT_OF_SCOPE，文件未被改 | 越界写成功 | 路径校验 + `_code/` 外文件 hash 不变 |
| 沙箱 L1 资源 | 超时 SIGKILL / 内存 OOM 不污染主进程 / 子进程数 ≤ 10 | 主进程崩溃 / 子进程泄漏 | 子进程 exit 信号 + 计数 |
| 校验顺序 | 权限校验先于锁校验（SYSTEM_PERMISSION_DENIED 先于 SESSION_LOCK_CONTENTION） | 顺序错乱 | TC-BOUND-205 双触发断言 |

### §11.8 判据落地与 CI 集成

| 落地点 | 方式 | CI 门槛（§7.3） |
|--------|------|----------------|
| 单元判据（§11.1） | Vitest `expect` + 退出码 + coverage | PR：100% 单元通过 + coverage 不降 |
| 集成判据（§11.2） | Vitest node + IPC harness + tmpdir 真实 fs | nightly：集成全绿 |
| E2E 判据（§11.3） | Playwright Electron + 视觉对比 | release 前：US-U01~U08 + §10 `[E]` 关键旅程 100% 绿 |
| 契约判据（§11.4） | ajv JSON Schema + 错误码枚举匹配 | PR：契约用例全绿 |
| 事件判据（§11.5） | telemetry.query 反查 + ORD 不变量脚本 | nightly：14 events + ORD-01~07 全满足 |
| 异常自愈判据（§11.6） | autofix 计数 + 回滚链路四点断言 | nightly：TC-EXCEPT-134~154 全绿 |
| 权限边界判据（§11.7） | 拒绝行为副作用为零断言 + 审计埋点 | PR：TC-BOUND-184~209 全绿 |

> **与 sprint-note 遗留项对齐**（macp 审计 C2-P0-3 三处"判据未明"全部消解）：
> - "自修复 3 次失败判据未明" → §11.6 自修复次数计数 + 熔断触发信号 明确（计数 ≤ 3 + result='circuit-broken' + CODER_AUTOFIX_EXHAUSTED）
> - "Context Backfill 六步可跑无客观信号" → §11.2 时序六步序列断言 明确（步骤序号 1→6 严格按序）
> - "快照线性回滚文件级实现略空" → §11.2 文件系统最终状态（inode/nlink） + §11.6 回滚链路完整（四点断言） 明确

---

> 本文档为 nanju 项目测试契约桥梁，覆盖 PRD §9 验收 + 04_API_SPEC v0.4 全 20 端点 + 14 events + 异常自愈熔断 + Sprint S1-S3 + B5/B6/B4 三组边界。§1-§9 共 209 个测试用例三段式唯一（TC-CODER-001~TC-BOUND-209）；§10 追加 Phase 2-4（S4-S13）测试骨架 100 用例（TC-SPRINT-210~309，响应 C2-P0-1）；§11 定义 7 类用例可自动化判定的 PASS/FAIL 客观信号（响应 C2-P0-3）。全文档共 309 用例，对照 04 端点 / 05 sprint / 14 events 三向映射 + sprint-plan §4.1/4.2/4.3 Phase 2-4 全覆盖。本文档为设计阶段产出，编码阶段由测试工程师按用例集落地为 `.test.ts` 代码。



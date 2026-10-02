---
milestone: M1
topic: testing-tooling-and-pyramid
reversible: true
---

# 决策笔记：BDD+GWT 工具选型 + 测试金字塔比例

## 决策 A：BDD+GWT 工具选型（两层）

### 可选方案

- Cucumber-JS（重框架，Node/Gherkin 全套，运行时重依赖）
- SpecFlow（.NET，技术栈不符）
- jest-cucumber（轻 devDep，但强依赖 Jest expect/runtime，与 Vitest 非开箱即用）
- Vitest 原生 + 自研薄 GWT helper
- 自研零依赖 GWT runner（运行时）

### 选择

**层1 平台自身代码 → 主路径 Vitest 原生 + 自研 GWT helper；备选 jest-cucumber（须 spike）**；**层2 运行时 GWT 执行 → 零依赖自研 runner**。

### 理由

核心洞察是区分两层测试体系。architecture §1 的"新增依赖=0"是**运行时分发约束**（随用户项目交付的产物不能带重依赖），不限制开发态 devDependencies（Vitest/Playwright/TypeScript 本身都是 devDep）。因此：

- **层1** 开发态首选 Vitest 原生 + 自研薄 helper（零额外 devDep、无兼容负担）；jest-cucumber 仅作备选——因其强依赖 Jest 全局，与 Vitest 需 vi-globals 适配层，须先 spike 验证（spike 失败回退主路径）。两路径均不进运行时分发。
- **层2** GWT runner 随用户项目分发，必须零依赖；机制对齐 architecture §1.2 "Agent 原生 GWT 执行器，Agent 直接理解 GWT 语义"——以 LLM 语义执行为主，正则做步骤切分，TS Compiler API 仅提取 step 签名；输出通过率 JSON 对接裁判 Agent（PRD §10.3）。

此选择同时满足 PRD §8.3（step definitions 机制）与 architecture（零依赖），消解两者表面张力。Cucumber-JS 因运行时重依赖被否决；SpecFlow 因 .NET 技术栈不符排除。

### 触发重审条件

若 jest-cucumber × Vitest spike 通过且团队偏好 Gherkin 文件驱动，则层1 切换为 jest-cucumber 主路径；若后续架构放弃零依赖原则，则重评层2 是否改用 Cucumber-JS。

---

## 决策 B：测试金字塔比例 70 / 20 / 10

### 可选方案

- 70/20/10（经典金字塔，单元主导）
- 60/25/15（集成/E2E 更重）
- 50/30/20（测试奖杯，偏集成）

### 选择

**70% 单元 / 20% 集成 / 10% E2E**。

### 理由

平台是 Agent 编排逻辑密集型：路由层角色切换、Prompt 拼装、裁判硬约束检查（7 类，含角色职责）、PlantUML 解析均为纯逻辑，单元测试覆盖率上限高、单例 <100ms、反馈最快，应占主体。集成层覆盖 IPC/子进程/文件系统/组件状态，必要但不廉价。Electron E2E 启动秒级且易 flaky，仅覆盖 user-flows 关键旅程（US-U01~U08），控制在 10%。

### 触发重审条件

若集成层 IPC/子进程缺陷率持续高于单元（>2 个 Sprint），或 E2E flaky 率 >15%，则上调对应层比例。

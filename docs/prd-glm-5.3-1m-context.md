# PRD：GLM-5.3 纳入 1M 上下文计量名单

- 版本：v0.16.83 / packages/shared v0.1.53
- 日期：2026-08-17
- 类型：缺陷修复（上下文计量错误导致提前压缩）
- 状态：已实现，待部署

## 1. 背景与问题

用户实例 `glm-zhipu` 渠道（Coding Plan，OpenAI Chat Completions 端点 `/api/coding/paas/v4`）配置了 GLM-5.2 与 GLM-5.3（手动添加）。运行时上下文计量出现不一致：

| 模型 | 官方真实能力 | Proma 计量 | 后果 |
|---|---|---|---|
| GLM-5.2 | 1M | 1M ✅ | 正常 |
| GLM-5.3 | 1M | **200K ❌** | ~20 万 token 即触发上下文压缩，1M 能力用不满 |

## 2. 根因

`packages/shared/src/utils/context-window.ts` 的 `ONE_MILLION_CONTEXT_RULES.glm` 仅含 `'glm-5.2'`，GLM-5.3 上线晚于该名单维护，未跟进。

计量链路（三层均受影响，因为共用此单一 source of truth）：

```text
inferContextWindow(modelId)
  → supports1MContext() → CONTEXT_WINDOW_CONFIG.rules（glm 家族名单）  ← 缺 5.3
  → 前端展示分母 / 后端用量统计 / pi runtime 注册 contextWindow
```

另有 SDK catalog 层（`@earendil-works/pi-ai` 的 `zai*.json`）无 glm-5.3 条目，返回 `DEFAULT_CONTEXT_WINDOW(200K)`；运行时取 `max(catalog, inferred)`，因此修好 inferred 后最终值正确为 1M，无需动 catalog。

## 3. 官方依据（调研结论）

- 智谱官方文档：GLM-5.2 与 GLM-5.3 均支持 1M 上下文窗口、最大输出 128K；GLM-5.3 与 5.2 同基座（提升来自后训练）。
- `[1m]` 后缀（如 `glm-5.3[1m]`）仅是 **Anthropic 协议端点**（Claude Code 场景）的客户端开关；OpenAI 协议端点**不加后缀**，服务端原生 1M。
- pi runtime 的 zhipu 分支走 OpenAI 协议且会剥离 `[1m]` 后缀（`agent-orchestrator.ts` 已有注释：智谱端点不识别后缀会报 1211 模型不存在），与本次修复正交。

## 4. 方案与影响面

### 改动（最小）

```diff
-  glm: ['glm-5.2'],
+  // 智谱 GLM：5.2 与 5.3 均为官方 1M 上下文（最大输出 128K）；
+  // 5.1 / 5-turbo 仍为 200K，不加入。OpenAI 协议端点无需 [1m] 后缀。
+  glm: ['glm-5.2', 'glm-5.3'],
```

### 影响面

- `supports1MContext('glm-5.3')` / `inferContextWindow('glm-5.3')`：`false/200K` → `true/1M`
- 前端上下文进度环分母、会话用量统计、pi runtime `contextWindow` 注册三处同步生效（同一函数）。
- 不影响 GLM-5.2 / 5.1 / 5-turbo / 4.x / 其他家族（有回归测试锁定）。

### 风险与边界

- 子串匹配语义下 `'glm-5.3'` 不会误伤 `glm-5-turbo`（不含 `5.3` 子串）与 `glm-5.1`。
- 不向 SDK catalog（`zai*.json`，随 pi-ai 包分发）添加条目：catalog 缺失时走 `max(200K, 1M)` 兜底，结果正确；避免 fork 三方依赖数据。
- 计量仅影响**客户端压缩时机与显示**，不改变服务端行为；超发上下文由服务端 400 兜底。

## 5. 验证

- 新增 `packages/shared/src/utils/context-window.test.ts`（7 用例）：glm-5.3 正例（含大写、`[1m]` 历史后缀形态）、glm-5.1/5-turbo/4.x 负例、deepseek/claude/haiku/空值回归。`bun test` 全绿。
- `bun run typecheck` 通过。
- 部署后人工验收：新会话选 GLM-5.3，上下文用量分母应显示 1M；运行至 >200K token 不触发压缩。

## 6. 后续项（不在本次范围）

1. **reasoning profile**：`reasoning-profile.ts` 仅有 `glm-5.2` 专属思考档位 profile（low/high/max），GLM-5.3 目前走 fallback；建议跟进官方 effort 参数映射（GLM-5.3 同样支持 low/high/max）。
2. **渠道预设**：`ChannelForm.tsx` / `channel-manager.ts` 的 zhipu 预设模型列表仍是 glm-5.2/5.1，未含 5.3（用户当前为手动添加）。
3. **临时补丁清理**：本机 release/dev 实例 asar 上有运行时字节补丁（`glm-5.` 子串）用于先行验证，本 PR 落地部署后自动被取代，无需回滚动作。

## 7. 里程碑

| 项 | 状态 |
|---|---|
| 源码 + 测试 | ✅ 本次提交 |
| PRD 文档 | ✅ 本次提交 |
| typecheck | ✅ |
| dev 实例部署验证 | ⬜ 待后续构建流程 |
| release 实例部署 | ⬜ 待用户验收后 |

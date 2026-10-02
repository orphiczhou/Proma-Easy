# A2.1 多 System Prompt 动态切换可行性分析

## 目标验证

同一用户会话中，根据项目阶段动态切换 4 个角色（需求分析师 / UIUX 顾问 / 架构设计师 / 工程经理），每个角色有独立的 System Prompt 和模型。

---

## 调查项 1：sendMessage() 中 Prompt 的构建时机

### 当前实现方式

agent-orchestrator.ts 中 sendMessage() 方法（第 932 行）在**每次用户发消息时**重新构建完整的 queryOptions，包括 System Prompt。

具体流程（第 1228-1540 行）：



关键代码（第 1527-1539 行）：



但是：第二次及后续消息走 **SDK resume 机制**（第 1273-1275 行）：



resume 会让 SDK 保持原始会话状态，包括第一次创建的 System Prompt。**后续消息即使重新构建了 append 内容，SDK 也不会重新应用它**（SDK 内部在 session 生命周期内只读取一次 systemPrompt）。

### 可行性结论

| 场景 | System Prompt 是否生效 |
|------|----------------------|
| 首次消息（新 SDK session） | 完全生效 |
| 后续消息（resume 模式） | SDK 忽略新的 append，沿用首次的 |
| 切换角色后重新开始 | 需要清除 sdkSessionId，创建新 SDK session |

**结论：当前实现本质上是"一次设定，终身使用"。** 每次 sendMessage() 虽然在 JS 层重建了 prompt 对象，但 SDK 的 resume 机制使后续消息不会重新加载 systemPrompt。要实现动态切换，必须干预 SDK session 生命周期。

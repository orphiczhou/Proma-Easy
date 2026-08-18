# PR：点选纠错完整闭环——点选→@引用→对话描述→所见即所得（v0.17.29 ~ v0.17.34）

> 分支：linux-support | 提交链：9a5b037 → a56220d → 7979331 → d7c0bbe（4 提交）+ L1/L4 修复（bb9a8e6/2450434）
> 依据：/home/orphic/proma-projDoc/DesignDoc/02_UX_DESIGN/interaction-spec.md 交互1【点选纠错】v0.3

---

## 一、目标工作流（用户定义）

用户在 UX 预览窗口**点选元素** → 会话输入框出现**元素引用 chip** → **打字描述改法**（@方式）→ 发送 → 调度员精准识别目标元素 → 委派修改 → 预览刷新**所见即所得**。

## 二、实现架构

```
预览 iframe（协议层注入捕获脚本）
  用户点击 data-ai-id 元素 → 3秒紫色高亮覆盖层
  → postMessage（来源校验+字段 sanitize 后）
      ↓ 渲染端 clickToFixHandler
  【单击】暂存 pendingUxElementRef → 输入框上方 🎯chip（可移除）
  【空白点击】走主进程注入引导消息
      ↓ 用户打字 + 发送
  <ux-element-ref> 块前置消息（id/type/text/prototype）
      ↓ 调度员（prompt c2 指令：无需反问指向，元素+描述合并为意见进收集轮）
  continue_delegation → UX 顾问（M3）修复（data-ai-id 定位）
      ↓
  重新 open_preview（version 强制刷新）→ 所见即所得
```

## 三、提交明细

| 版本 | 提交 | 内容 |
|---|---|---|
| v0.17.29 | 9a5b037 | 点选纠错基础链路（协议注入+宿主转发+IPC+UX顾问 data-ai-id 约束）+ 多轮意见收集节奏 + AC 审计状态机 + Todo 指令 + 可交互演示硬性标准 |
| v0.17.30 | bb9a8e6 | L1：delivered 终点收口（完成富语+门禁三选一引导，不再空续接） |
| v0.17.31 | 2450434 | L4：Todo 阶段收尾程序化兜底（PHASE_ADVANCE 时自动完成本会话 open Todo） |
| v0.17.32 | a56220d | E2E 实测缺陷：点选消息改走 runAgent 唤醒空闲会话（queueAgentMessage 要求运行中是设计错误） |
| v0.17.33 | 7979331 | 方案 A 点选暂存（chip+三条发送路径序列化）+ 方案 B 候选池（MRU 12） |
| v0.17.34 | d7c0bbe | AC 审计修复：R1 脚本语法/R2 回滚恢复/R3 来源校验+sanitize+真实路径/Y2/Y3/Y8 |

## 四、AC 对抗审计记录（本 PR 自身）

- 配置：攻 deepseek-v4-pro × 防 GLM-5.3（medium 级，跨家族）
- 攻击：3 red / 8 yellow / 5 green（R1 双份实现同步击穿、R2 回滚不对称、R3 prompt injection 面为最高价值发现）
- 修复：R1-R3 + Y2/Y3/Y8 全收敛；Y1/Y4-Y7 记录为下批（双击快捷路径/引用过期/空文本提示/撤回还原/@菜单接入）
- 残余风险接受声明：原型作者=受信 UX 顾问（M3），R3 修复后伪造面需控制预览 iframe 内容；sandbox 无 allow-same-origin 保持

## 五、验证状态

| 项 | 状态 |
|---|---|
| typecheck 双包 | ✅ |
| nanju 32 测试 | ✅ |
| 注入脚本语法（node new Function） | ✅ |
| E2E：点选→chip→打字→修改→刷新 | ⏳ 待本轮实测（X2 项目 UX 确认环节） |
| data-ai-id 生成（X2 原型 64 个标记） | ✅ |
| 点选消息唤醒（v0.17.32） | ⏳ 随上项一起验 |

## 六、已知边界

1. @ 菜单（方案 B 的读取端）未接——候选池已写入，菜单交互下批
2. 引用无过期机制（chip 可见可移除，风险低）
3. 双击快捷五选项路径未实现（单击暂存已覆盖主流程）
4. 撤回排队消息不还原点选引用（块已混入 fileReferenceBlock 字符串）

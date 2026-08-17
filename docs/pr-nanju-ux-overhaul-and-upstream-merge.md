# PR：南大向导体验重构 + 跨渠道委派修复 + Upstream 合并（v0.16.84 → v0.17.28）

> 分支：linux-support | 时间：2026-08-17（单日） | 提交链：15 个（含 1 merge）
> 范围：南大向导全流程体验（AC 审计分级 / UX 视觉闭环 / 对话式设计迭代）、跨渠道委派修复、HTML 预览、Upstream 内嵌浏览器合并

---

## 一、动机与用户需求演进（当天时间线）

| 时间 | 用户反馈/需求 | 落地版本 |
|---|---|---|
| 凌晨 | GLM 渠道 delegate modelId=None → 400 | v0.16.82/84 |
| 12:10 | Proma 内部无法正确显示 HTML UX 界面，需预览交互窗口 | v0.16.86 / P4 merge |
| 12:19 | 会话能否调用侧边分屏预览 | v0.16.85 open_preview |
| 15:31 | AC 审计攻防同家族偏袒，按任务重量分级指定模型 | v0.16.87 |
| 15:52 | UX 修复须用视觉模型（M3）+ 截图渲染能力 | v0.16.87/88 |
| 18:37 | ①外部弹 Chrome 窗口 ②UX 确认无交互能力 ③确认时并列窗口未开 | v0.16.88/89 |
| 19:32 | 场景索引纵排占满全窗（规范：顶部横排窄条） | v0.16.90 |
| 21:30 | 确认后卡住（事故：软中断杀死挂起横幅） | v0.16.91 |
| 22:05 | 合并 Proma 最新版内嵌浏览器 | v0.17.27 |
| 22:41 | UX 互动=用户指代元素对话式共同设计 | v0.17.28 |

## 二、变更清单（15 提交）

### A. 跨渠道委派修复
- **v0.16.82**（c05a65e）：跨渠道未传 modelId 自动选目标渠道默认模型（pickDefaultModelForChannel）
- **v0.16.84**（5b43c5f）：startDelegation 运行渠道误传 ctx.channelId（父渠道端点+子渠道模型名→1214）。本地 CONNECT 代理抓包实锤根因

### B. 预览能力
- **v0.16.85**（7c509de）：Agent 工具 `open_preview`（白名单校验→IPC→per-session atoms→右侧分屏），与南大 watcher 共享后半段
- **v0.16.86**（3d6f560）：HTML 预览白屏修复（上游 73e9d01 移植：目录级 token URL + 相对资源加载 + 源码⇄渲染切换）
- **v0.16.90**（18f9e72/4b9b3e2）：同路径重开强制刷新（previewVersion 驱动重挂载）；UX 导航布局规范

### C. 南大 AC 审计重构
- **v0.16.87**（9c0c0ce）：
  - taskWeight 分级：quick=light（攻 ds-v4-flash/防 glm-5-turbo），iterative=medium（攻 ds-v4-pro/防 GLM-5.3）
  - 家族断言（防御≠作者、攻≠防）+ 显式覆盖
  - prototype 作者改 MiniMax-M3（运行时解析 minimax 渠道 UUID）
  - 截图渲染自检循环（chrome-devtools headless 截图→M3 读图比对用户故事→修复→2 轮无缺陷）
  - 独立 M3 视觉裁决（防作者自证）
  - E6 运行锁泄漏修复（锁抢占未保护窗口）
- **v0.16.88**（d1eb7d8）：chrome-devtools 注入 `--headless`（不再弹外部 Chrome）；UX 确认改用户故事多选勾选
- **v0.16.89**（e5962a5）：确认前强制 open_preview + 工具进南大门禁白名单
- **v0.16.91**（ba1a5bd）：软中断不再杀死挂起 AskUser 横幅（v89 21:30 事故根因：interrupt→aborted→横幅回答无接收方）

### D. Upstream 合并
- **v0.17.27**（c71c96f merge + 5c83cc1）：origin/main（144 提交，v0.17.42 baseline）
  - 内嵌浏览器 15 个 Browser* 工具（WebContentsView 原生渲染 + 直连 CDP）
  - SDK 0.84.2 / agent-runtime 独立产物 / LeftSidebar 虚拟化 / PreviewPanel ErrorBoundary
  - 13 文件冲突逐个裁决，v0.16.9x 功能 7/7 存活，463 测试绿

### E. 对话式设计迭代（本 PR 核心 UX 能力）
- **v0.17.28**（e2f74d8）：UX 确认环节重构为多轮共同设计循环
  - 用户自然语言指代元素提意见（"顶部导航太挤"）
  - 调度员 BrowserObserve/Screenshot 定位元素（模糊时用元素清单反问）
  - continue_delegation→UX 顾问修复（含截图自检）→重展示→报告改动
  - 需求变更时先确认→同步回写 PRD 用户故事
  - 满意后 AskUserQuestion 多选收口

## 三、验证矩阵

| 验证项 | 方式 | 结果 |
|---|---|---|
| 跨渠道委派 | CONNECT 抓包 + e2e | ✅ 子会话连对端点 |
| AC 分级 | e2e-v87 实测攻/防模型 | ✅ ds-flash/glm-turbo 实际生效 |
| M3 视觉闭环 | e2e-v89 视觉裁决多轮 | ✅ |
| 交互确认 | 用户亲手勾选（21:45） | ✅ |
| 强制 open_preview | e2e 两次触发 | ✅ |
| 中断保护 | 修复后无复发（代码级验证） | ✅（回归测试缺，见已知边界） |
| Upstream merge | 463 单测 + M3 视觉 UI 回归 5/5 | ✅ BrowserPanel/侧栏/南大/ErrorBoundary/冒烟 |
| 对话式迭代 | **未 E2E**（待下一轮） | ⏳ |
| 导航规范 | **未 E2E**（待下一轮新原型） | ⏳ |

## 四、已知边界与遗留

1. **对话式设计迭代未 E2E**：指令层完整，全链路（元素定位→修复→重展示→需求澄清）待下一轮实测
2. BrowserScreenshot 在 xrdp 环境页面观察超时（GPU 限制；M3 UI 回归 T1.5 发现）
3. aborted 会话自动恢复未做（v91 已消除主要触发路径；显式停止后恢复语义需产品定义）
4. E6/orchestrator 运行时行为无回归单测（electron 依赖深，bun 环境无法无副作用实例化）
5. 全量测试套件含 Electron 二进制下载（网络慢时会卡，建议 CI 缓存）
6. 观察员发现的排队消息延迟问题（有挂起横幅时用户输入应立即定向该会话）未修

## 五、文件影响面

核心新增：agent-preview-notify.ts、browser-controller.ts（upstream）等 11 个 browser-* 模块
核心修改：nanju-router.ts、nanju-router-prompt.ts、nanju-router-gate.ts、agent-collaboration-tools.ts、agent-orchestrator.ts、builtin-mcp/chrome-devtools.ts、DiffTabContent.tsx、PreviewPanel.tsx、useGlobalAgentListeners.ts、preload/index.ts
测试：nanju-router(+20)/nanju-router-prompt(+12)/agent-preview-notify(+5)/agent-model-selection(+4)

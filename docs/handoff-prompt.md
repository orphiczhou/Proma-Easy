你正在接手 Proma-Easy（南大向导）项目的开发。

## 项目位置
- 代码：/home/orphic/proma-source，分支 linux-support，当前版本 v0.16.71
- 设计文档：/home/orphic/proma-projDoc/DesignDoc/
- 架构设计：docs/nanju-v2.3-design.md
- 项目状态：docs/proma-easy-status.md（先读这个）

## 核心架构
南大向导是固定路由 Harness：L1 调度员（主会话）通过 delegate_agent 委派 L2 角色子会话（跨渠道跨模型），L2 内部做 AC 对抗审计（异构模型 inline subAgent），PHASE_ADVANCE 后自动续接下一阶段。四个阶段：requirements → prototype → architecture → planning。

## 最近三个版本做了什么
- v0.16.69：AC 审计从 L1 移到 L2 内部驱动（allowSubDelegation 三层放行）；Linux fs.watch 递归修复（手动遍历子目录分别 watch）；每个 phase 定义异构 AC 模型对。
- v0.16.70：PHASE_ADVANCE 成功后 1.5 秒自动 sendMessage 触发下一阶段。
- v0.16.71：预览面板监听从 AppShell（useEffect 有竞态）移到 useGlobalAgentListeners（全局单例 store.get）。

## 当前待验证（用户报告"还是没有看到"预览面板）
预览链路：L2 写文件 → nanju-preview-watcher 检测（主进程日志确认正常）→ IPC nanju:html-preview-detected → useGlobalAgentListeners handler → store.set(previewFileMapAtom/previewPanelOpenMapAtom) → MainArea 渲染 PreviewPanel。
主进程侧已确认 IPC 发出（日志 5+ 次检测到 prd.md）。问题极可能在渲染端。
需要你做：通过 MCP（http://127.0.0.1:19876）或 UI 确认渲染端 console.log "[南大预览] 渲染端收到文件变更" 是否出现。如果没出现，检查 useGlobalAgentListeners 是否正确注册了 onNanjuHtmlPreview；如果出现但面板不显示，检查 MainArea 的 previewOpen 条件和 PreviewPanel/DiffTabContent 渲染。

## 已知问题
1. GLM 渠道 delegate_agent 时 modelId=None → API 400（Agent 重试后可成功）。修复：startDelegation 中当 channelId 传了但 modelId 没传时，自动选渠道第一个 enabled 模型。
2. GitHub push 失败（网络+对象损坏）。token: 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。
3. NanjuWorkspaceView.tsx 从未被渲染（TabContent 用 AgentView）。

## 启动 Proma 的方法（关键！）
必须在启动前 unset ELECTRON_RUN_AS_NODE（Prime Agent 环境会设此变量导致 Proma 以 Node 模式启动后秒退）：
```bash
pkill -f "out/linux-unpacked/proma"
rm -f ~/.config/Proma/SingletonLock
setsid env -u ELECTRON_RUN_AS_NODE DISPLAY=:10.0 ./apps/electron/out/linux-unpacked/proma &
```

## 测试方法
通过 MCP Bridge（http://127.0.0.1:19876）远程驱动：
1. create_session（指定 workspace_id=南大向导工作区, channel_id=deepseek）
2. 写 _nanju-projects.json 创建项目元数据（currentStage=requirements）
3. send_message（wait=false 异步，然后轮询 list_messages）
4. 监控 /tmp/proma-v71.log 看子会话创建、AC 审计、阶段推进

## 可用渠道
deepseek (v4-pro/v4-flash), glm-zhipu (glm-5.2/glm-5-turbo), minimax (MiniMax-M3)
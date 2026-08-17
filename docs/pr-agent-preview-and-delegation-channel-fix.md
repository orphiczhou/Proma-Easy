# PR：跨渠道委派修复 + Agent 主动预览能力（v0.16.84 ~ v0.16.85）

> 分支：linux-support | 提交：5b43c5f（v0.16.84）、7c509de（v0.16.85）

## 一、v0.16.84：委派子会话运行渠道误用父渠道（关键修复）

### 问题

跨渠道 `delegate_agent`（如 GLM 父会话 → deepseek 子会话）全部失败，子会话报：

```
400 {"code":"1214","message":"modelCode：不存在"}
```

### 根因（本地 CONNECT 代理抓包实锤）

`startDelegation` 调用 `runRegisteredHeadlessAgent` 时：

| 参数 | 实际传入 | 应传 |
|---|---|---|
| channelId | `ctx.channelId`（父渠道 glm-zhipu） | `effectiveChannelId`（deepseek） |
| modelId | `effectiveModelId`（deepseek-v4-pro） | 同左 ✓ |

orchestrator 按 channelId 解析 baseUrl/apiKey，形成「**父渠道端点 + 子渠道模型名**」的错配请求——智谱端点收到 deepseek 模型名，返回 1214。

诊断方法：本地 CONNECT 日志代理（`proxy-settings.json` 指向本地转发器）抓到子会话 CONNECT 全部指向 `open.bigmodel.cn` 而非 `api.deepseek.com`；修复后重抓，出现 `api.deepseek.com:443` ✓。

### 修复

`agent-collaboration-tools.ts` 一行：`channelId: effectiveChannelId`，与 `continue_delegation` 的 `record.channelId` 行为对齐。

与 v0.16.82 是同一缺陷的两半：v82 修 modelId 选择，本提交修 channelId。

### 排查中的新发现（记录）

1. **委派失败后父会话运行锁未释放**：`[Agent 编排] 会话 xxx 正在处理中，拒绝新请求`——委派失败（TypedError）后 dispatcher 挂死，后续消息全被拒。待单独修复。
2. deepseek「服务繁忙」多为端点模型名校验（400 1214/invalid_request），错误信息有误导性。

## 二、v0.16.85：Agent 会话工具 `open_preview`

### 背景

预览面板（右侧分屏/标签页）此前只能由用户点击触发；Agent 生成 PRD/报告后无法主动展示。南大向导有文件监听自动预览（nanju-preview-watcher），但普通会话没有等价能力。

### 实现

```
Agent 会话（任意）
  └─ 工具 mcp__preview__open_preview(file_path)
       └─ 主进程 agent-preview-notify.ts
            ├─ validatePreviewFile：绝对/相对路径解析（相对 agentCwd）
            │   + 普通文件存在性 + 扩展名白名单（md/html/txt/json/yaml/csv/图片）
            └─ IPC agent:open-preview-request（sessionId 由工具上下文注入，防跨会话注入）
                 └─ 渲染端 useGlobalAgentListeners 全局监听
                      └─ jotai previewFileMap/previewPanelOpenMap（per-session）
                           └─ MainArea → PreviewPanel 右侧分屏
```

- 与南大预览链路共享后半段（同一套 atom 写入与 PreviewPanel 渲染）
- preload：`onAgentOpenPreview / offAgentOpenPreview`
- 白名单校验为纯函数，5 个单测覆盖（含目录拒绝、白名单外拒绝）

### 文件清单

| 文件 | 变更 |
|---|---|
| `main/lib/agent-preview-notify.ts` | 新增：校验 + IPC 发送 |
| `main/lib/adapters/pi-builtin-tools.ts` | 注册 `buildPreviewTool`（`mcp__preview__open_preview`） |
| `preload/index.ts` | ElectronAPI 类型 + ipcRenderer 桥接 |
| `renderer/hooks/useGlobalAgentListeners.ts` | 全局监听 + atom 写入 + 卸载清理 |
| `main/lib/agent-model-selection.ts` | 附带：修 tsconfig 下的 TS2532 |

### 验证

- typecheck ✓；388 tests 全绿（+5）
- dev 实例（v0.16.85）实测：GLM 会话调用 `open_preview` 两次（md → png），主进程日志两次 `[Agent 预览] open_preview 已发送: <路径>`，白名单/相对路径行为符合预期
- UI 最终效果（右侧分屏出现内容）需在窗口聚焦该会话时人工确认

### 已知边界

- 南大 watcher 是懒启动：AppShell 检测到南大工作区才 `nanjuStartHtmlWatcher`；重启后需切回南大工作区一次以激活监听
- 渲染端 console 不转发主进程 stdout，渲染侧验证目前依赖人工/UI 自动化

## 三、版本链

```
7c509de feat: v0.16.85 - open_preview 会话工具
5b43c5f fix: v0.16.84 - 委派 channelId 误用父渠道
99209da docs: GLM-5.3 1M 上下文 PRD（并行提交）
f419d8f fix: v0.16.83 - glm-5.3 纳入 1M 上下文计量（并行提交）
```

## 四、后续建议

1. 修复委派失败后父会话运行锁不释放（dispatcher 挂死）
2. `open_preview` 渲染端加自动化回归（Playwright/CDP）
3. 渲染端关键事件（预览收到/写入 atom）增加可观测日志开关

## 五、E2E 实测记录（2026-08-17 13:30 补充）

M3（MiniMax）会话在 dev 实例 UI 输入指令 → 调用 open_preview → 右侧分屏成功渲染
`m3-preview-verify.md`（唯一标记 OPENVIEW-8848-PROMA，视觉识读确认）。

### 部署注意事项（重要）

electron 构建产物分三层：`build:main`（主进程）、`build:preload`、`build:renderer`（vite）。
**只跑 build:main + electron-builder 会把旧 preload/renderer 打进 asar**——主进程日志
显示"open_preview 已发送"但 UI 无反应，正是此因。改 preload/renderer 后必须：
```bash
bun run build:main && bun run build:preload && bun run build:renderer && bunx electron-builder --dir
```
验证方法：`grep -c onAgentOpenPreview <asar>` 应 ≥2。

### UI 自动化备注（xrdp 环境）

- Chromium 输入框对 `xdotool type` 合成键不稳定（文字滞留/丢失）；可靠路径是
  `xclip -selection clipboard` + `Ctrl+V` 粘贴 + `Return`
- 会话切换点击可用（Chromium 处理 XTEST click 正常；GTK 应用不行）
- 截图识读链路：scrot -u + 视觉模型定位坐标 → 迭代点击 → 识读验证

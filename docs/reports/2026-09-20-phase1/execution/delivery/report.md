# Task 12 交付视图实施报告（rev2）

**实施时间**：2026-09-20 14:50 GMT+8
**实施者**：Proma 实施子会话 rev2
**源码基线**：`34f72fbc` / v0.17.131
**报告路径**：`docs/reports/2026-09-20-phase1/execution/delivery/report.md`

---

## 1. 修订说明

首轮实施被退回，原因是：

| # | 问题 | 处理 |
|---|---|---|
| 1 | 品类从目录猜 desktop/cli，未读工程契约 | 改从 `03_ARCHITECTURE/engineering.json` 读 `target.kind` |
| 2 | 启动说明含 `node xxx.ts` 教用户执行命令 | 移除所有 shell 执行指令，统一用「预览/找到」 |
| 3 | GWT report schema 字段自行发明 | 全部从 `nanju-gwt-runner.ts` GwtReportJson 严格对齐 |
| 4 | fail/error 洗成 partial | 纠正：fail/error/blocked/stale 保持区分 |
| 5 | 运行时无 schema 校验（FP 类型错 throw） | 加 `validateReportSchema` 逐字段类型检查，错误不 throw |
| 6 | 入口路径未验证 realpath | 加 `resolveEntryAbsPath` 用 `realpathSync` 防 symlink/../ |
| 7 | 旧报告指纹≠当前产物未标 stale | 加 stale 检测：比对 `entryFingerprint` 与实测指纹 |
| 8 | 共享类型放局部文件 | 迁至 `packages/shared/src/types/nanju-delivery.ts` |
| 9 | DeliveryCard 局部类型重复定义 | 删除局部类型，改为从 `@proma/shared` 导入 |
| 10 | `previewOnly` 参数签名未核 | 确认 `PreviewFile` 接口确实含 `previewOnly` |

---

## 2. 产出文件

| 文件 | 说明 |
|---|---|
| `packages/shared/src/types/nanju-delivery.ts` | 共享类型（从 `@proma/shared` 导出） |
| `packages/shared/src/types/index.ts` | 新增 `export * from './nanju-delivery'` |
| `apps/electron/src/main/lib/nanju-delivery-view.ts` | 主进程服务（纯函数） |
| `apps/electron/src/main/lib/nanju-delivery-view.test.ts` | 22 个单元测试，全部通过 |
| `apps/electron/src/renderer/components/nanju/delivery/DeliveryCard.tsx` | React 渲染组件 |

---

## 3. 关键实现决策

### 3.1 品类：从工程契约读取

```typescript
// 读 engineering.json 的 target.kind，不从目录猜
const contractKind = readContractTargetKind(projectDir)
const deliveryType = resolveDeliveryTypeFromContract(contractKind)
// resolveDeliveryTypeFromContract：'web'|'desktop'|'cli'|'api'|'mobile'|'ai'|'unknown'
```

### 3.2 启动说明（无 shell 指令）

```typescript
// 来自 buildDeliveryLaunchInstructions()
'08_APP/index.html' → '在右侧预览打开「index.html」，或在文件面板双击直接查看'
'README.md'         → '在文件面板中找到「README.md」查看'
// 永远不出现：node / 终端运行 / bun / npx
```

### 3.3 运行时 schema 校验（FP 类型不错 throw）

```typescript
function validateReportSchema(raw: unknown): GwtReportJson | null {
  // generatedAt 必为 string，verdict 必为枚举值，数字字段必为 number …
  // 类型错误不 throw，返回 null（调用方感知损坏）
}
```

### 3.4 Stale 检测

```typescript
const currentFingerprint = computeCurrentFingerprint(entryAbsPath)
// 比对 report.entryFingerprint（sha256+size）与当前实测
// 不一致时 verdict → 'stale'，staleMessage 告知用户重跑
if (report.entryFingerprint && currentFingerprint) {
  if (!same(report.entryFingerprint, currentFingerprint)) {
    verdict = 'stale'
    staleMessage = '应用在测试通过后被修改 … 请重新运行验收测试'
  }
}
```

### 3.5 Verdict 映射（fail/error 不洗成 partial）

```typescript
type DeliveryVerdict = 'pass' | 'fail' | 'error' | 'blocked' | 'stale' | 'not-tested'
// fail/error/blocked 保持区分（来自 gwt-runner.ts judgeGwtResult）
// stale = 报告指纹已变（pass 后应用被修改）
// not-tested = 尚未生成报告
```

### 3.6 入口路径 realpath 防 symlink/../

```typescript
function resolveEntryAbsPath(projectDir, entryPath): string | null {
  const abs = join(projectDir, entryPath)
  const resolved = realpathSync(abs) // 解析 symlink
  if (!resolved.startsWith(resolve(projectDir))) return null // 防 ../ 逃逸
  return resolved
}
```

---

## 4. 验证证据

```
$ bun run typecheck 2>&1 | grep -E '(nanju-delivery|DeliveryCard|delivery)'
(no output)  ← 所有 delivery 相关文件 typecheck 通过

$ bun test apps/electron/src/main/lib/nanju-delivery-view.test.ts
  22 pass / 0 fail / 33 expect()

$ bun test apps/electron/src/renderer/components/nanju/gwt-progress-state.test.ts
  3 pass / 0 fail
$ bun test apps/electron/src/renderer/components/nanju/quick-ux-model.test.ts apps/electron/src/renderer/components/nanju/gwt-scenario-rows.test.ts
  31 pass / 0 fail
```

---

## 5. IPC 父接线片段（由父 Session 完成）

### 5.1 主进程 handler（`nanju-ipc.ts`）

```typescript
import { buildDeliveryViewModel } from './nanju-delivery-view'

ipcMain.handle('nanju:get-delivery-view', async (_event, input: {
  workspaceSlug: string
  projectId: string
}) => {
  return buildDeliveryViewModel(input.workspaceSlug, input.projectId)
})
```

### 5.2 Preload 暴露（`preload/index.ts`）

```typescript
// ElectronAPI 接口新增
nanjuGetDeliveryView: (input: {
  workspaceSlug: string
  projectId: string
}) => Promise<DeliveryViewModel | null>

// 实现
nanjuGetDeliveryView: (input) =>
  ipcRenderer.invoke('nanju:get-delivery-view', input)
```

### 5.3 渲染端使用

```typescript
import { DeliveryCard } from '@/components/nanju/delivery/DeliveryCard'

<DeliveryCard
  workspaceSlug={workspaceSlug ?? ''}
  projectId={data.project.projectId}
  sessionId={sessionId}
/>
```

---

## 6. 不改动的文件

| 文件 | 原因 |
|---|---|
| `nanju-ipc.ts` | 父 Session 完成接线 |
| `preload/index.ts` | 父 Session 完成接线 |
| `GuidePanel.tsx` | 约束不修改 |
| `StageNodeDetail.tsx` | 约束不修改 |
| `nanju-gwt-runner.ts` | 不修改契约 runner |
| `nanju-engineering-contract.ts` | 不修改契约 |

---

## 7. Hash 与时间戳

| 项目 | 值 |
|---|---|
| 修订时间 | 2026-09-20T06:50:00Z |
| 源码 HEAD | `34f72fbc8114608b998eaf4e1f5e1937f3deeb59` |
| 报告路径 | `docs/reports/2026-09-20-phase1/execution/delivery/report.md` |
| 共享类型 | `packages/shared/src/types/nanju-delivery.ts` |
| 主进程服务 | `main/lib/nanju-delivery-view.ts` + test |
| 渲染组件 | `renderer/components/nanju/delivery/DeliveryCard.tsx` |
| typecheck | 6/6 packages exit 0（无 delivery 新错误） |
| delivery 测试 | 22 pass / 0 fail |
| GWT 渲染测试 | 34 pass / 0 fail（无回归） |

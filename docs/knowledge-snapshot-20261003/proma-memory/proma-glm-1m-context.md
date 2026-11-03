# Proma GLM 渠道 1M 上下文 patch 记录

日期：2026-08-17

## 背景
- 本实例 `glm-zhipu` 渠道（provider=zhipu，baseUrl=`https://open.bigmodel.cn/api/coding/paas/v4`，OpenAI Chat Completions 协议）使用 GLM-5.2 / GLM-5.3。
- 智谱官方：OpenAI 协议端点下模型名**不加** `[1m]` 后缀（那是 Anthropic 协议/Claude Code 的开关），服务端天然支持 1M 输入；glm-5.2/5.3 上下文 1M、最大输出 128K。
- Proma（proma-easy）内置 `ONE_MILLION_CONTEXT_RULES.glm = ["glm-5.2"]`，仅 glm-5.2 按 1M 计量；**GLM-5.3 被按 200K 计量**，会在 ~200K 提前触发上下文压缩。channels.json 模型条目无 contextWindow 字段可配，唯一途径是改 asar 内规则。

## 根治（2026-08-17 09:40，已提交源码）

不再打运行时补丁，改为源码修复并已提交 proma-source 仓库：
- `f419d8f` fix: v0.16.83 - `ONE_MILLION_CONTEXT_RULES.glm` 扩为 `['glm-5.2','glm-5.3']` + 7 例回归测试（`context-window.test.ts`），bump apps/electron 0.16.83 / packages/shared 0.1.53
- `99209da` docs: PRD `docs/prd-glm-5.3-1m-context.md`

### 部署状态（2026-08-17 11:10）
- **dev**：09:59 部署的 v0.16.84 构建已含 v0.16.83 修复，但仅 main.cjs 生效（运行时计量已 1M）；preload/renderer 为增量构建残留旧规则，已字节补齐（备份 `dev/.../app.asar.bak-preload-renderer-stale`），下次重启 dev 后 UI 侧也一致；彻底固化需下次干净全量构建。
- **release**：仍靠 asar 字节补丁（09:19 版），待含 v0.16.83 的构建部署后自动取代。
- 待下次构建部署后自动取代 asar 补丁；部署验证：新会话选 GLM-5.3 上下文分母应显示 1M
- PRD 后续项：reasoning-profile.ts 缺 glm-5.3 思考档位 profile；ChannelForm 预设未含 5.3

## 历史补丁记录（已被源码修复取代，仅备查）

### 第二次 patch（2026-08-17 09:20，当前生效版本）
- 凌晨 01:00 app.asar 被 electron-updater 自动更新覆盖（207701030 → 207701588 字节，+558B 小版本），patch 丢失；新版仍无 glm-5.3 规则。
- 已按相同方式重新 patch 新版 asar，语法/逻辑验证通过。
- 新备份：`app.asar.bak2-glm53-1m-v2`（对应 v2 版本）；旧备份 `app.asar.bak-glm53-1m` 对应被覆盖的旧版本。
- ⚠️ 坑：用户点"重启"后 Electron 主进程可能未真正退出（PID 394267 从 8/16 21:31 持续存活 11h48m，关闭窗口=托盘驻留）。验证重启是否真实发生：`ps -o pid,lstart -p <主进程PID>`，PID/启动时间变了才算数；必要时托盘右键退出或 kill 后再启动。
- `/home/orphic/proma-easy/release/app/resources/app.asar` 中 3 处：
  - main.cjs、preload.cjs：`glm: ["glm-5.2"]` → `glm: ["glm-5."] `（尾部空格补齐）
  - renderer/assets/index-C0axfSAx.js：`glm:["glm-5.2"]` → `glm:["glm-5."] `
- 语义：`"glm-5."` 子串匹配 glm-5.2 与 glm-5.3（含大写，匹配前转小写）；glm-5-turbo / glm-4.x 不受影响；**副作用**：若渠道未来加 glm-5.1（实际 200K）会被误判 1M。
- 备份：同目录 `app.asar.bak-glm53-1m`（root 所有，原 asar 为 orphic 可写）。
- 生效条件：重启 Proma（运行中进程仍用内存旧规则）。
- 无 asar integrity fuse，修改不会导致启动失败；node --check 语法校验通过。

## 维护提示
- Proma 自动更新会替换 app.asar（已实际发生一次：8/17 01:00），1M 计量对 GLM-5.3 会失效，需重做 patch 或等官方把 glm-5.3 加入名单（8/17 新版仍未加）。
- Pi SDK catalog（asar 内 `@earendil-works/pi-ai/dist/providers/data/zai.json`、`zai-coding-cn.json`）中 glm-5.2 ctx=1000000，无 glm-5.3 条目；Proma 取 `max(catalog, inferContextWindow)`，故改名单已足够。
- 重启后可用会话的 context window 显示（分母 1M）验证生效。

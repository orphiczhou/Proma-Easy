# 交接文件（新会话接手）· PromaEasy Phase 1 硬化 + E2E 桌面便签

> 生成：2026-09-28 21:11 GMT+8｜上一会话：cfce785b（父会话）
> 目的：新会话据此继续推进，无需重读全部历史。

## 一、项目背景与目标

- 源码：`/home/orphic/proma-patches/p1-quick-engineering`（分支 `p1-quick-engineering`，HEAD `4744fe13`）。
- 版本：electron `0.17.132` / shared `0.1.63`（已入库，**未推送**）。
- 总目标：完善 DesignDoc Phase 1 / Sprint 1-3 快消型主轴 + 已提前实现的工程模板；执行 B0–B6 / Task 0-13 硬化计划。
- 入口文档（必读顺序）：
  1. `docs/project-memory/current-state.md`（项目状态截面）
  2. `docs/project-memory/decisions.md`（决策与边界）
  3. `docs/plans/2026-09-20-phase1-hardening-plan.md`（B0-B6 计划）
  4. `docs/reports/2026-09-20-phase1/项目盘点与问题台账-20260920.md`

## 二、当前焦点：E2E 桌面便签（desktop-app 真流程验证）

- **工程**：`project-桌面便签工具`（workspace `workspace-1786847832507`，mode=quick，品类 desktop-app / linux 本地程序）。
- **需求**：Linux 桌面便签工具（悬浮便签窗口 + pystray 托盘 + 本地 JSON 持久化）。
- **目的**：验证 R3「结构化拒因」修复是否改善上轮「剪贴板真流程」暴露的门禁误拦/verify-failed/静默终止问题；派观察员记录反馈。
- **观察员**（4 会话，异构模型，只读）已出终报，改进清单见 `docs/reports/2026-09-25-phase1-e2e-desktop/观察员反馈汇总与改进清单.md`。
- **E2E 工程文件**：`/home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files/project-桌面便签工具/`（观察员报告在 `00_OBSERVERS/O1~O4-*.md`）。

## 三、已完成的工作（本轮，均已提交）

| commit | 内容 |
|---|---|
| 66814692 | **P0 修复**：续接 giveup 后启动长期空闲巡检（30s×20 次），会话空闲即重投递续接 |
| 2cf5f979 | **P1 修复**：desktop-app 白名单补 P1 Python 路径组件（tkinter/gi/AyatanaAppIndicator3/SNI host） |
| cbebe951 | **P1 修复**：共享白名单补 check_env.sh 通用探测项（go/docker/python3/rustc） |
| 4744fe13 | 记录 P0+P1 修复验证（architecture→coding 突破） |

**已验证**：
- 结构化拒因同源（auto_block_detail + checks 四要素）实测通过（O2 源码级核验 + 遥测）。
- env 白名单补齐后，env_probe 26 个探测组件 + architecture.md 全清单全部通过校验。
- 工程曾从 architecture→coding 卡死点突破并推进到 coding（confirm.auto-confirm）。

## 四、当前卡死点（新发现，需新会话处理）

**工程卡死在 coding→testing**（2026-09-26 20:41 GMT+8 起，已冻结 2 天）：
- `pendingAdvanceCorrection` = `{target: testing, fromStage: coding, blocked, count: 1}`。
- **拦因**（advance.auto-gate auto_block_detail）：`交付说明缺少「构建与运行」「测试状态」章节：08_APP/DELIVERY.md`。
- 代码已产出：`08_APP/src/core/`（models/persistence/engine）、`08_APP/src/gui/`（tray/note_window）、`08_APP/main.py`、`tests/test_core.py`、`evidence/tray-r4.json` `tray-r5.json`（共 1987 行）。
- `06_TESTS/` 仍空。

### ⚠️ 关键新发现：P0 空闲巡检在真实场景有局限

- giveup（12:41:29Z `advance.reject-escalate{continuation-giveup}`）后**无任何新事件**，P0 空闲巡检未成功重投递续接。
- **初步判断**：giveup 后调度员会话持续 `isActive=true`（本轮 run 未及时结束，可能与 coding 阶段 11:59:08Z 的 `circuit_break{source: delegation_hard}` 委派硬熔断有关），空闲巡检 20 次（10 分钟）耗尽后 onGiveUp 停摆。
- **结论**：P0 修复解决了「giveup 后立即放弃」，但**未覆盖「会话长时间忙碌（>10 分钟）时如何兜底」**。需进一步调查：为什么 giveup 后调度员 run 不结束（isActive 不释放），以及空闲巡检耗尽后是否有更可靠的兜底（如会话空闲事件监听、或延长巡检、或定时巡检 blocked 态工程并注入恢复 prompt）。

## 五、剩余待办（按优先级）

### A. 恢复当前工程（最快路径）
1. 修正 `08_APP/DELIVERY.md`（补「## 构建与运行」「## 测试状态」章节），或
2. 通过 CDP 9224 在桌面便签工具会话发消息触发续接（脚本模式见下「七」）。
3. 重新启用监控任务 `cb005c1c-9b30-47c2-9909-d589221e9587`。

### B. 修复 P0 空闲巡检局限（本轮+上轮共同根因的残余）
- 调查 giveup 后 isActive 不释放的根因（run 收尾 / circuit_break 后状态）。
- 方案候选：① giveup 后若会话空闲事件未到，改由「定时巡检 blocked 态 pendingAdvanceCorrection 并注入 buildPendingAdvanceRecoveryPrompt」兜底；② 延长空闲巡检；③ 会话结束回调触发重投递。

### C. P1/P2 修复（观察员改进清单，见汇总文档 §三）
1. **P1 stage-deny 关键词门禁误拦**：本轮 12/12 误拦（架构长文必命中跨阶段词，调度员被逼拆写逃避）。观察员建议：改按 `phase.role` 判定，或对带 phase.role 的委派豁免。
2. **P1 env_probe 探测方法**：pystray/pynput 用 `print(pkg.__version__)` 探测，两包不暴露 `__version__` → 假 fail。改 `importlib.metadata.version()`。
3. **P1 AC-015 豁免口径**：notApplicable 15 字 < 20 字下限，改了仍不过的空转。
4. **P2**：门禁规避注入（拆写）显式告警、unbound-write-deny 只读豁免、审计轮次结论回写工程、作者自审拦截、prototype visualReviewer 默认配置。

## 六、dev 实例运行态（保留运行）

- 进程：`proma-easy/dev/app/proma-dev --remote-debugging-port=9224 --remote-allow-origins=*`（PID 3262632），DISPLAY=:12.0。
- CDP：`http://127.0.0.1:9224/json/list`。
- 工作区：`/home/orphic/.proma-dev/`；工程在 `agent-workspaces/workspace-1786847832507/workspace-files/project-桌面便签工具/`。
- **部署/重启约束**：改代码后需 `pack`（`cd apps/electron && bun run pack`，需先 `rm -rf apps/electron/out` 腾空间）→ 部署 dev（替换 `resources/app.asar` + extraResources）→ 重启（`cd /home/orphic/proma-easy/dev && DISPLAY=:12.0 nohup ./start-dev.sh &`）→ CDP 触发。**release 实例不动**（仅 remote-session 调度）。
- 磁盘：根盘约 1.3G 可用，pack 需 ≥1G；磁盘紧张时清可再生缓存（dotslash/npm/tmp），**不删 dev 的历史 .bak 备份与旧部署**。

## 七、常用操作（CDP 驱动 GUI）

- 主窗口选择：`/json/list` 里 `type=page` 且 `url` 以 `index.html` 结尾无 query、`window.innerWidth>1000` 的那个（避开 `?window=workspace-memory` 和 `?window=quick-task`）。
- 发消息恢复：node 全局 WebSocket 连 CDP，`Runtime.evaluate` 找 `.tiptap.ProseMirror` 编辑器 → `Input.insertText` → 点 `svg.lucide-corner-down-left` 发送按钮（脚本模板已存 `/tmp/cdp-resume.mjs`、`/tmp/cdp-main.mjs`）。
- VisionRelay 视觉路由不可用，用 DOM 文本读取替代截图。

## 八、remote-session 会话编制（release 实例，workspace 8a18a730-6424-4d23-9c65-69446fdca837）

| 用途 | 会话 ID | 渠道/模型 |
|---|---|---|
| E2E 观察 O1 模版遵循度 | ec96a25d-3d8c-48e3-a8bf-41efa4e5b055 | deepseek/deepseek-flash |
| E2E 观察 O2 信息链证据链 | 097c68a7-e8b1-44d8-ad1d-f9f0fff333c8 | deepseek/deepseek-v4-pro |
| E2E 观察 O3 环境探测 Spike | 0ffd32ce-2104-47ef-8c75-a58f3a8782b1 | MiniMax/MiniMax-M3 |
| E2E 观察 O4 测试驱动收敛 | 808741ef-becf-4fc7-83ce-c3a63f1472df | opencode-go/glm-5.3-flash |

渠道：deepseek（deepseek-flash/v4-pro）、ad74ac74（MiniMax-M3/M2.7）、215d792b（glm-5.3-flash/deepseek-v4.1-flash/qwen3.8-flash）、00e10419（gpt-5.6 系）。glm-zhipu 渠道 disabled。

## 九、提交与推送边界

- commit 唯一 trailer：`Made-with: Proma`；author 不改。
- **推送未获授权**（之前 GitHub token 401 未修复）。
- 子会话不得 commit/push/改版本/装依赖/部署/重启。

## 十、关键教训（决策记录）

- afterPack 与 buildManifest 的 bundle 指纹排序必须同源（localeCompare vs 码元比较曾导致门禁误拦）。
- env 白名单 = check_env.sh 通用探测集 ∪ 品类专属集 ∪ Python import 名/语义服务名；遗漏任一形态都会误判幻觉包名。
- 「结构化拒因」半程修复：拒因结构化 + 可操作出口已生成，但「抓出→回炉→重验」闭环缺 giveup 后的可靠兜底（当前空闲巡检对「会话长时间忙碌」场景不覆盖）。
- 观察员 O2/O4 终报质量高，可直接复用其改进清单（`观察员反馈汇总与改进清单.md` §三）。

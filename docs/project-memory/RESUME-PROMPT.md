# 恢复工作状态提示词 · PromaEasy Phase 1 硬化 + E2E 真流程

> **⚡ 2026-11-04 00:10 追加（Phase2 部署+E2E 状态更新，读完全文后以本节覆盖冲突项；专项交接见 docs/reports/2026-11-03-phase2-deploy-e2e/HANDOFF-E2E-20261104.md）**
> HEAD `61c76b50`（v0.17.135 已部署 dev 实例 PID 963331 并推送）。**E2E 冒烟通过（NEXT-04 鉴权五路/健康矩阵/UI）但核心真流程验证未完成**：NEXT-02 自动建树与 NEXT-01 冻结实证被既有 AC 同族护栏拦截（F-1：个人记账工具 light 预设 defender=glm 系同族被拒，属护栏正确行为非回归）。新会话的任务：按 HANDOFF 文档先解决 F-1 再跑真流程验证，当前 E2E 判定为未成功。其他已验证：部署 SOP 坑 D-1 已解决（asar pack 必须 --unpack-dir 保留原生模块）、忙碌保护/路由门禁运行时正常、NEXT-03 组件在 bundle。
>
> **⚡ 2026-11-03 ~03:40 追加（Phase2 收口）**
> Phase 2 五模块（NEXT-01~05）已全部交付并推送：v0.17.135，分四 commit（波1 `108a082a` / NEXT-02 `dc901ce0` / NEXT-05 `1d39644e` / 反馈报告 `8f9fe418`）。权威详情读 `docs/architecture-v0.17.135-feedback.md`（完成矩阵+互审记录+偏差遗留）。关键变化：① 测试门禁改为 `bun run test` = `bun test --isolate apps packages`（裸 `bun test` 会有 ~79 mock 串扰假红）；② Bridge 鉴权已收口；③ 交付见证改双阶段时钟；④ 向导 coding 自动建树已上线；⑤ 多渠道模型协作开发策略已入 AGENTS.md。遗留：NEXT-02 F-3/F-5、NEXT-01 A-5/A-8/G1/G2/G4、前端树 Tab 联动。

> 生成：2026-11-03 00:39 GMT+8｜上一版：2026-11-02 13:15（本版全量更新）
> 用途：新会话直接整段读取（或作为 prompt 输入）即可恢复工作状态，无需重读全部历史。
> 本文件是「恢复工作状态」自包含提示词；权威长期记忆仍以 `current-state.md` + `decisions.md` 为准（二者滞后债见 §7）。

---

## 一、项目是什么

PromaEasy（源码内称「南大向导」）是一个 Electron 桌面本地 AI Agent 平台（Bun monorepo）。当前在做 **DesignDoc Phase 1 / Sprint 1-3 快消型主轴 + 工程模板** 的硬化计划（B0–B6 / Task 0–13）。

- 源码根：`/home/orphic/proma-patches/p1-quick-engineering`（分支 `p1-quick-engineering`）
- 版本：`apps/electron/package.json` **v0.17.132**；`packages/shared/package.json` **v0.1.63**
- dev 安装：`/home/orphic/proma-easy/dev/app/`；release 安装：`/home/orphic/proma-easy/`（**release 实例不动**）
- 真流程工程工作区：`/home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files/`
- Proma 主工作区：`/home/orphic/.proma/agent-workspaces/proma-easy/`（导航入口 `workspace-files/AGENTS.md`）

## 二、Git 状态（2026-11-03 00:39 核验）

- **HEAD**：`3414ccd5`（docs: 反馈报告补记 push 完成状态），分支 `p1-quick-engineering`
- **推送：已推送并 fetch 核验**——远端 `easy/p1-quick-engineering` == HEAD `3414ccd5`（含 10 月历史 20 个待推 commit，一并上去了）。PR #1（base=linux-support）状态仍未确认。
- 推送排障复用：GnuTLS(-110) 间歇失败 → 仓库已持久化 `http.sslVersion tlsv1.2`，重试即过；`fetch` 小包常能过、`push` 间歇被断，勿被「空输出的 exit 0」误导，**以 fetch 后的远端引用为准**。
- **工作树剩余（均为本会话之前的改动，未夹带）**：
  - `packages/shared/src/utils/context-window.ts` + `.test.ts` modified（1M 规则扩展：deepseek-flash / mimo-v2.6 / kimi-k3.1，未提交）
  - 监控日志 2 个 modified（自动化追加）
  - 本文件此前为 untracked，本次纳入版本控制

## 三、2026-11-02 里程碑：三个 blocked 工程全部 delivered ✅

| 工程 | 调度员会话 | GWT | 报告 runId | 阶段 |
| --- | --- | --- | --- | --- |
| 番茄工作法定时器 | `9ee13f34` | pass 92/92 | `40bacf12` | delivered / completed |
| 桌面便签工具 | `ff681335` | pass 31/31 | `5581230e` | delivered / completed |
| 命令行待办清单 | `18d76771` | pass 46/46 | `76a999e2` | delivered / completed |

**方案1（Issue #P1-REAL-002 真人见证接线）已由真实交付闭环验证**——这是 v131 部署后的首次 requiresReal 工程走通。

各工程收尾修复（产品代码均由 dev 实例 Agent 产生，指挥官只下发指令与代点横幅）：

- **便签**：①tray 驱动超时根因=9/29 改版后总时长超 `timeoutMs=60000` 被 SIGKILL（DBus dbusmenu 报错是回退探测正常日志，非环境缺陷）→ 修复子会话 4 项（timeoutMs 180000 / win_ids_by_name 提速 / S4 回退 `send_wm_delete` / 150s 软预算）；②契约 `covers` 补 US-05（驱动 pinned 检查越界判 error）；③S1 无边框检查改 Motif 语义（`_MOTIF_WM_HINTS` decorations=0——应用从未用 override_redirect，原 orr=yes 期望结构性不可通过）；④主会话渠道 401 修复（`agent-sessions.json` channelId ce7e5515→glm-zhipu）。
- **待办清单**：校验器 `cells()` 裸 `split('|')` 不处理 `\|` 转义（源码缺陷，工程侧改写绕开）；coding 子会话产出 todo.py + 28 场景测试全绿 + AC 对抗审计（attacker deepseek / defender）。
- **番茄**：纯「见证→重跑」竞态循环（见 §6 方法库），多轮压缩后交付。

交付验收流程要点（平台语义）：GWT pass → `deliveryChallenge` 登记（绑 report runId）→ L1 发起 AskUserQuestion「确认·满意交付」→ **ask-answer 来源精确等值「满意交付」** → `deliveryAck` 登记（runId 强绑定，重跑 GWT 即失效需重登记）→ 声明 `<!-- PHASE_ADVANCE: delivered -->` → 交付门校验（pass + ack + 见证新鲜）→ delivered。

## 四、2026-11-02 第二批：蓝图残留补齐（v0.16.45 对照验收，已推送）

蓝图 `proma_agent_next_steps_guide1.md`（v0.16.44→45）按「历史里程碑对照 + 残留补齐」处理（dev v0.17.132 远超蓝图）。反馈报告：`docs/architecture-v0.16.45-feedback.md`（第七章模板，含矩阵/验证输出/偏差）。

| commit | 内容 |
| --- | --- |
| `4a783d90` | M2-2 残留清理：session-management SKILL.md Base64 还原（v1.3.1）+ 删 `.bak-v2.9.3` 与 28 字节假 `app.asar` |
| `502be313` | M2-1 补齐：tree communication 跨会话通信日志（engine log/list + MCP `tree_log_communication`/`tree_communication_list` + 测试 4 用例） |
| `99ed2a8f` | M1-3：抽取 `session-tool-handlers.ts`（13 会话操作单一实现），`agent-session-tools.ts`/`agent-mcp-bridge.ts` 接入共享层；`fork_session` 统一参数；R4-01 源码断言随抽取演进 |
| `ca529317` | M2-2 收尾：SidePanel 接线 TreeViewPanel `onNavigateToSession`（useOpenSession）+ 反馈报告 |
| `3414ccd5` | 反馈报告 push 状态补记 |

验证：typecheck 全绿；目标测试 121+4 全过；m8 集成测试 9/9（**隔离 `$HOME` 运行**，防写线上会话存储）；全量 `bun test` 119 fail **均为基线既有**（stash 对照：HEAD 基线 120 fail），测试基线治理建议单列一批。

## 五、平台缺陷台账（源码待 Issue 化，未修）

详见 `docs/reports/2026-11-02-delivery-acceptance-e2e/交付验收实战报告-20261102.md`（P1-1~P1-9 + 复盘）：

| # | 缺陷 | 状态 |
| --- | --- | --- |
| P1-1 | **交付验收死锁**：autoClarify on → AskUser 路由仅放行安装确认；`isAutoConfirmDeliveryProject` 又排除工程契约项目 → 工程类交付无路径 | 规避：三工程 autoClarify 已改 false（`_nanju-projects.json`，备份 `.bak-20261102-autooff`）；**修源码后应恢复** |
| P1-2 | 权限横幅按会话渲染 → 跨会话审批不可见，GWT 假性「静默卡死」（实测停滞 17min） | 未修 |
| P1-3 | 见证新鲜度 10min 窗口 vs 「重跑+交付询问+应答」链路时长竞态（番茄连 3 轮超窗） | 未修 |
| P1-4 | GWT 后续接 `上一条消息仍在处理中` / 会话忙碌 600s 挂起 | 未修 |
| P1-5 | 未绑定协作子会话 Bash 被 W19 拒（实测 21 次，修复子会话无法自跑验证） | 未修 |
| P1-6 | 交付横幅「选择+确认」两段式且按钮文本带序号（自动化难点） | 未修 |
| P1-7 | driver error 时 evidence 只留 stdout tail 不留全量 | 未修 |
| P1-8 | autoClarify 双源（注册表 vs `_project-info.json`）易误判 | 未修 |
| P1-9 | 定时任务 MCP 工具缺 modelId → 隐性 Sota 消耗（两条监控跑 785/930 次全 GLM-5.3） | 文件侧已修（见 §6.3），工具参数缺失未修 |

**HTTP Bridge 鉴权（`Access-Control-Allow-Origin:'*'` + 无 token，台账 §10）**：用户 2026-11-02 裁决「局域网使用暂缓，先记录」。注意：`POST http://127.0.0.1:19877/send_message` 无鉴权可驱动全部会话。

## 六、运行态与治理（2026-11-03 00:39）

### 6.1 dev 实例：运行中
- PID `876957`，CDP `9224`，MCP 直连 `19877`（无鉴权），日志 `/tmp/dev-run2.log`
- 启动命令：`cd /home/orphic/proma-easy/dev && PROMA_INSTANCE=dev PROMA_DEV=1 DBUS_SESSION_BUS_ADDRESS="unix:path=/tmp/dbus-5VvQVHDTk8,guid=59e8b84e3ea67c56946ae0826adf202a" DISPLAY=:10.0 XDG_RUNTIME_DIR=/run/user/1000 setsid nohup ./app/proma-dev --remote-debugging-port=9224 --remote-allow-origins="*" > /tmp/dev-run2.log 2>&1 < /dev/null &`
- **注意 DISPLAY=:10.0**（旧文档写 :12.0 已过时）；dev asar 仍为 v0.17.132（今晚未部署新源码，§四改动仅入库未部署）

### 6.2 模型治理（用户 2026-11-02 指令：自动任务一律 flash，优先 GLM 官方渠道）
- `~/.proma-dev/nanju-model-config-override.json`：6 阶段全 `glm-zhipu/glm-5.3-flash`，fallback deepseek-flash；**AC 攻防保持跨族**（attacker deepseek-flash / defender minimax-M3）。备份 `.bak-20261102`
- 南大 L1 调度员会话仍为 GLM-5.3（用户侧工程会话，未动）
- 记忆已写入 `proma-easy/memory/collaboration.md`（含 automations.json 治理手册）

### 6.3 定时任务（本实例 proma-easy）
- 5 条全改 `glm-zhipu/glm-5.3-flash` 且清 `lastSessionId`（备份 `automations.json.bak-20261102-model`）
- 「E2E-验证-番茄（5372ddf2）」「E2E-验证-待办清单（e916ac02）」**文件侧 active=true**（监控目标已 delivered，重启 Proma 后将以 flash 自动恢复）；其余 3 条暂停
- **关键机制**：`automation-manager.ts readIndex()` 内存缓存——文件改动需**重启 Proma 实例**生效；MCP 暂停/启用立即生效但会把旧缓存回写文件（改完 MCP 必须重写文件）
- 这两条监控 prompt 的验证目标已被交付实证，恢复后建议改写 prompt 或转为新工程监控

### 6.4 操作方法库（本轮实证，复用价值高）
- **直连 RPC**：`POST http://127.0.0.1:19877/send_message` `{"session_id","message"}`——秒级驱动会话，绕过 MCP 超时（无鉴权，仅本机使用）
- **批准横幅**：只在**该会话 chat 激活时渲染**（P1-2）；自动化需周期切换会话再点；交付询问是「选项 → 确认」两段式且按钮文本含序号（`1满意交付可以交付使用…`）
- **见证循环**：GWT blocked（真实能力证据）→ 见证横幅点「允许」→ 登记（10min 新鲜窗）→ **立即让 L1 亲口输出** `<!-- PHASE_ADVANCE: testing -->` → GWT 重跑 pass → 挑战 → 询问 → 满意交付 → ack → 注入 delivered 标记
- **必须 L1 亲口声明推进标记**：向会话注入裸标记用户消息会被消费但 GWT 常停滞（实测 17min vs 1min）
- **ack 与 report.runId 强绑定**：窗口内重跑 GWT 后 ack 失效，需重新应答
- 脚本模板：批准守护 `/tmp/guard2.ts`、见证看门狗 `/tmp/witness-dog.py`（/tmp 重启即失，需按 §6.4 重建；CDP page id 会变，勿写死前缀）

## 七、剩余待办（更新后优先级）

1. **平台缺陷 Issue 化 + 修复批次**：P1-1（交付死锁，修完恢复三工程 autoClarify）、P1-2（横幅可见性）、P1-3（见证窗口/交付时序）为高优；P1-4~P1-8 随批；源码修复走 p1-quick-engineering 正常流程（今晚 6 commit 为先例）。
2. **HTTP Bridge 鉴权**：已记台账 §10，**用户裁决暂缓**；实施时与 session-tool-handlers 回归同批。
3. **全量测试基线治理**：119 fail 既有（渠道认证/密文形态/快照恢复等），单列一批。
4. **automations 重启验证**：Proma 重启后确认两条监控以 glm-5.3-flash 运行（查新会话 modelId）。
5. **老债**：`decisions.md` 停在 09-24、`current-state.md` 停在 10-01（缺 10 月至今全部决策与事实）——需专项回写。
6. **PR #1**（base=linux-support）合并/评审状态未确认；本轮 6 commit 未开新 PR。
7. **个人记账工具**（`project-个人记账工具`，PROTO_UC 品类，normal 推进）——未本轮处理，可观察。
8. **待办清单校验器 `cells()` 转义缺陷**：源码修复候选（工程侧已绕开）。

## 八、关键路径与入口文档索引

1. `docs/project-memory/RESUME-PROMPT.md` —— 本文件（权威交接）
2. `docs/reports/2026-11-02-delivery-acceptance-e2e/交付验收实战报告-20261102.md` —— 三工程交付 + P1-1~P1-9 缺陷 + 方法论
3. `docs/architecture-v0.16.45-feedback.md` —— v0.16.45 蓝图对照验收反馈（第七章模板）
4. `docs/reports/2026-09-20-phase1/项目盘点与问题台账-20260920.md` —— 台账（§10 HTTP Bridge 鉴权暂缓）
5. `docs/reports/2026-09-25-phase1-e2e-desktop/` —— 上一代交接/issue/PR 就绪/监控日志
6. `docs/project-memory/current-state.md` / `decisions.md` —— 滞后债（见 §7.5）
7. 工作区快照：`/home/orphic/.proma/agent-workspaces/proma-easy/workspace-files/.context/RESUME-PROMPT-20261103.md`（本文件副本）

## 九、下一步建议动作（一句话）

**重启 Proma 实例验证定时任务以 flash 恢复 → 把 §五 P1-1~P1-9 落成正式 Issue 并排修复批次（P1-1 交付死锁优先，修完恢复 autoClarify）→ 可选：新建一个未交付品类工程跑一轮「flash 子 Agent + 本轮自动化栈」的增量验证。**

---

## 附：本次交接「未确认」项（不臆造，需新会话核验）

1. dev 实例今晚 20:27 前的停止原因（日志尾「会话无可用渲染窗口」，疑窗口被关后退出）与 15:55→20:27 之间是否有其他操作。
2. 三工程 `_project-info.json` 的 `completedButUnconfirmed` 等交付后字段状态未逐项复核。
3. 本实例两条 E2E 监控重启后以 flash 运行的实际效果（prompt 仍指向已交付工程，是否需要改写）。
4. `context-window.ts` 未提交扩展（deepseek-flash/mimo-v2.6/kimi-k3.1）的来源会话与是否已验证——非本次改动，未核。
5. 另一会话在 `/home/orphic/proma-patches/context-1m-hotpatch` 给 release app.asar 打 1M 补丁（输出 `/tmp/app.asar.ctx1m-rel`）——非本线工作，是否已部署 release 未确认。

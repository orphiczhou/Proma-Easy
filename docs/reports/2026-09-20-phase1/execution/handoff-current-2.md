# 实施接续 2（2026-09-20约14:36 GMT+8）

原始用户要求继续完整执行：remote-session国内模型分工，父难点与集成，独立审计迭代完成Phase1计划。不要本轮只停报告/首波。上一份handoff-current.md仍含入口/权限/会话IDs，阅读此文件优先最新。

## 当前进度/环境
- 主代码repo `/home/orphic/proma-patches/p1-quick-engineering`，HEAD34f72fbc，版本仍0.17.131，未commit/bump/pack/deploy。
- 共享工作树，严守文件所有权。磁盘仅64MB，/dev/shm约3.6GB。未清历史用户数据。后续build/pack要解决空间（可用shm临时产物或经确认清旧可再生产物）。release实例只调会话，不能改部署；dev仍未启动。
- `remote_send_message(wait=false)`总是约60s后超时但**实际执行成功**，不重复发。会话回包history仅user，报告/源码为进度依据。
- 四任务：1 completed；2 in_progress；3/4pending。

## Worker 现状（最新追加任务均发成功，正在执行）
1 B0 deepseek-flash `be6f919e-f3a3-43f3-96ba-d818cb4f032b`：基线已完成，execution/baseline/report.md/test-baseline.json。
   固定副本full:2341pass/113真实fail+6加载错误（default119fail计入6errors）。106单文件mock污染，6dev模型override，1临时副本无.git；不是全部环境！PROMA_DEV=1使dev多了1测试夹具__f2_union_nonexistent__，没清。已追加让其独立审GWT/driver，report audit-r1/verdict-baseline-review.md/findings.json（待收），并建acceptance-matrix。
2 GWT GLM5.3flash `73226aaf-0ec0-4db8-b77a-6031e3e06556`：Task1完成，runner114/0邻接163/0，report execution/gwt。已追加Task8委派误拦（只delegate-guard/test、w18-delegate-intent.test，父持router gate/prompt），再补真实process-driver→GWT blocked预算集成。新report execution/delegate/report.md待收。
3 资源MiniMaxM3 `0b02c21c-0c25-4f48-89a8-e97b9cc4c270`：首轮只实现校验脚本未接生产，父退回修正后正在新增materialize严格校验/provenance/Spike、外置权威、manifest schema/hash/path安全。独占template/resources模块/test/资源md/manifest/scripts；不碰driver骨架。后续追加Task10 env-probe/test + check_env.sh + template freshness，不能改父router prompt/project。report execution/resources/report.md需看新版本。旧报告提前声称v132未真实bump，已指出。
4 driver DeepSeekPro `945b6093-1dd0-4450-bd9d-08d000e32d1c`：首片完成新blocked结构；63/0含16集成，report execution/driver。已追加严格legacy签名、Python全链、工程证据归档、进程限制/回收/变异负例。新增所有权driver-io/test、pit-reflow/test、engineering-evidence模块，其原execution/process/suite/skeleton范围继续。不得改gwt。代码大量变更继续中。

## 独立审计会话（通过remote创建，至少四维已落实）
- B0会话审GWT/driver（上面）。
- DeepSeek-v4-pro recovery core `e6edf0a4-38ce-4f9e-921c-8233698f6e94`：audit-r1/recovery-core.md/json已读，首轮9项，2red。已回信修4项并请求r2复核与新advance-recovery审计，反例需持久化不能/devshm跑后删除。产出audit-r2/recovery-core.md/advance-recovery.md待收。
- MiniMax-M2.7-highspeed UI `d6cdc0bf-ef97-4845-b793-425da9921af3`：audit-r1/recovery-ui.md/json已读，5yellow无red。有些误判：fork不会启动run；partial必须切真实新会话否则错上下文；四层额外snapshot子类型非问题。已追加独立Task12实现（自实现后不审自身）——独占GwtProgressCard/test、新main nanju-delivery-view.ts/test、新shared/types/nanju-delivery.ts。不能改IPC/preload/shared index/GuidePanel由父接线。输出execution/delivery/report.md及精确接线建议。持久history+契约可用入口，不任意执行命令。
- GLM5.3flash security `9fcc561f-95e7-4762-b6b9-48e78b3888ff`：审资源+恢复安全；audit-r1/security.md/security-findings.json待收，资源正在迭代需hash/time定位。
所有remote同instance release/workspace default8a18…；channelIDs在dispatch.md。

## 父已落代码（当前未提交，需继续审修验证）
### Task2/3恢复
- shared `nanju-recovery.ts` ProjectRecoveryResult `{ok,status:restored|partial|failed,message,activeSessionId,restoredSnapshotId,preRestoreSnapshotId,fileRestore}`，types/index导出。
- `nanju-snapshot.ts` snapshot新增 recoveryState(currentStage/status/subStage/category)，create自动存；**审计C1已修** fork await后才重读snapshot列表并同步写，无await间隙；ID=max+1不length。triggerType新增pre-restore。getSnapshotsPath拒工作区/id空/点/斜杠/NUL（Chinese合法）。
- `nanju-project-snapshots.ts` 新ProjectRecoveryJournal在工程外snapshot storage `_project-recovery.json`，阶段prepared/files-restored/committed/compensated/partial。
  rollback需要ports.isBusy（未提供failclosed），检查target归project、current&target会话存在且workspaceId一致；先recover未提交，再内存锁，createProjectCheckpoint当前版本(pre-restore)，要求pre可完整恢复；从冻结target再次fork新分支；写journal→restoreFile→写info/session/stage（delivered改testing/TEST）→索引isCurrent→清旧auth→commit。
  legacy无file或无stage/不完整file返回partial且journal阻塞新run；可选择pre恢复。失败走补偿（与重启共用恢复前file/state）并返回failed；失败补偿后仍清旧验收ack/challenge等有意，文案要求重测。
  getProjectRecoveryBlock/目前getWorkspaceRecoveryBlock提供执行硬门。recoverInterruptedProjectRestore启动/首次打开识别prepared并保守回pre，partial保持blocked。
  restore file id新增安全regex，storage路径段验证。
  **C6已修**pre-restore不让resolveRepairRollbackSnapshot当健康pre-modify。
- `nanju-file-snapshot.ts` **C2已修** exported recoverInterruptedRestore增加获取引擎锁/陈旧接管/finally token释放；原实现改私有Unlocked，restore本身持锁路径调用Unlocked。RecoverAction增加locked。31既有测试全过。
- `nanju-ipc.ts` 四层原rollback丢ok已改返回结构化result，传真实isBusy（当前范围工作区所有sessions active）。create检查project/session归属+busy；list检查project存在。listProjects/getProject/getProjectStage调用recoverBeforeProjectOpen并附recoveryMessage（不throw，否则partial UI没出口）。
- `agent-orchestrator.ts` run preflight对workspace projects先恢复且blocked停止；canUseTool同检查恢复块（所有mode包括children）。**目前颗粒度整个workspace，审计C5未修，需要按project/子会话归属收窄，同时防恢复期其他会话写本项目**。
- preload rollback返回Promise<ProjectRecoveryResult>。
- GuidePanel handleRollback透传，成功/partial绑定新session，通过listAgentSessions→setSessions→useOpenSession打开实际新fork；StageNodeDetail只ok&&restored成功Toast（目前后端长文案，可优化），其他内联错误；busy finally。confirm不再绝对称不丢失。useNanjuGuideData project字段recoveryMessage，GuidePanel NoticeBar展示（partial切tab后新页面仍有banner）。
- 测试project-snapshots26/0（原20+6），包含成功会话/阶段/文件/回前版本、损坏目标、missing/busy、补偿失败硬阻塞及重开恢复、legacy partial、坏日志/path逃逸。已调整legacy okfalse。

### 审计R1恢复缺陷与处置
C1红并发snapshot覆盖：已修，仍需永久并发用例与crossprocess考虑。
C2红recover绕active锁：已修，仍需新永久反例test。
C3黄补偿清旧auth：暂不采纳建议恢复旧ack，有意重新验收，记录决策/文案。
C4黄snapshotIPC路径穿越：已加路径段+project/session核验，继续核workspace实际归属。
C5黄workspace级锁阻无关项目和所有只读：未修，高优先。
C6黄pre-modify污染repair目标：已修pre-restore+排除，补test。
C7低每工具O(n)disk与config路径mkdir：待收窄优化，避免新增巨大缓存。
C8低坏journal永久block需可操作修复入口：未修，不能简单删日志；保留副本且通过已有时间轴选择安全恢复前版本。
C9子类型snapshot未暴露shared：非功能错误，IPC可显式去掉额外snapshot避免约定歧义。
UI F1 partial跳新会话提醒：持久banner已做；不采不切tab建议（实际绑定已变）。F2短Toast可优化。F3 fork启动run是假设错，已请审计复核。F4列表重恢复IO需优化，F5行为分流测试未补。

### Task5拒因/续接首片
- 新 `nanju-advance-recovery.ts`：persistAdvanceCorrection同源GateCheck、脱敏限长、fromStage/executionState/message/checks/fingerprint/eventKey落_project-info；phaseArtifactFingerprint遍历阶段目录(跳node_modules/.git/dist/build/.next/__pycache__/evidence，不follow symlink，5000files/20MB单file上限)；同事件key保持at。buildPendingAdvanceRecoveryPrompt每run读磁盘重验，不发授权、不创建委派；旧pending schema支持；跨stage残留不注入。现只prompt恢复，未实现主动授权自动续接消费去重全链，不能宣称Task5全部完成。
- `nanju-project.ts` pending新增上述可选字段。
- `nanju-router-gate.ts`新增GateCheck/evaluatePhaseOutput；verifyPhaseOutput保留string|null API，新增可选checks collector；每失败源直接reject(id,...expected,path)，无错误字符串反推；增加目录伪装产物拒绝stat.isFile，evaluate捕获读异常。
- `nanju-phase-advance-consumer.ts` reject第一次就持久化（以前只giveup），防环count取max内存/持久前count+1，达限消息含具体拒因，不再建议手改stage；onGiveup同字段不覆盖。正常文件verify失败也持久化checks。成功仍既有clear pending。
- `nanju-router-prompt.ts`新run包含上述pending重读prompt。
- orchestrator.injectNanjuAssistantMessage现在生成同一SDKMessage先appendSDKMessages再emit；持久失败log且pending提供恢复。
- 新advance-recovery.test.ts3/0：同key/产物变更、旧schema重启提示但不授权、脱敏/跨stage/目录拒绝。config mock getConfigDirName使用不存在专用目录，不读真实override。
- 旧w17链测试因为达限现在仍有具体拒因改1断言（原期待看不到'推进未被授权'，现期待有'当前拒因'）；117/0。
- gate原97/0。

## 本轮验证/日志
- project-snapshots26/0最新/devshm/p1-recovery-r2.log。
- engine31/0；gate97/0；w17chain117/0；advance3/0。
- Electron tsc两轮暴露测试nullable与advance previous possiblynull，均已修；**修后还没跑最终tsc**。
- 上述多数日志已copy到execution/recovery/（含历史失败typecheck2，保留），r2.log未copy。
- git diff --check最后通过。

## 立即下一步
1 读security/B0/资源等新报告，处理high；收紧恢复项目锁+故障出口，新增C1/C2/C6回归与UI分流测试，类型检查。
2 Task5未完：结构化checks进telemetry/UI GuardAlert，同eventKey消费去重+cancel/授权续接；谨慎下轮持久消息append是否Pi上下文注入覆盖（需测试），不只是eventBus。
3 Task6 file证据（尚未改）：hasExistingFileEvidence只existsSync目录也过；URL parser/中文标点/空格、普通file与授权目录(生产projectDir+显式attachedDirectory，不能全盘file)；[实证]/[文证]与日期口径一致，fixture根先mkdir（现有测试可创建repo local-evidence.md）。
4 Task9验收前置与testing点选路由（未改）父掌router/ipc/test-architecture，可新增worker独立test-architecture但公共接线父做。
5 Task12等worker成果父接线，manifest refresh/package version/build/pack/dev部署（release不动），B3旧真工程及新工程UI端到端，B6六品类能测则做，mobile/AI外部条件blocked诚实记录。
6 全部关键修复独立审计收敛、最终证据矩阵及版本提交。不要因为工作长就提前总结完成。

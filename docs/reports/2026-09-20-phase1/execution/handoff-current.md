# 当前执行交接（上下文续接用，非结束任务）

2026-09-20约13:50 GMT+8。用户授权：**用remote-session可用国内模型，在父会话带领下完成整个Phase1改进计划；父做架构/分工/最难部分，其他会话执行，完成后审计迭代。必须持续执行，不能只交方案/首波。**

## 入口与范围
- 源码 `/home/orphic/proma-patches/p1-quick-engineering`，HEAD34f72fbc v0.17.131。读其AGENTS.md / Agent.md / docs/project-memory与`docs/plans/2026-09-20-phase1-hardening-plan.md`(337行)。用户要求报告记忆放实际项目，当前工作区AGENTS只索引，已完成。
- 项目盘点docs/reports/2026-09-20-phase1有21问题、基线证据、3交接8观察历史。
- 当前授权执行B0–B6/Task0–13，非Phase2扩展。
- 之前文档未commit，保留。子worker不commit/bump，父统一批次patch版本、Made-with: Proma，不push未获具体批准。

## 调度
读 `execution/dispatch.md` 含四会话ID/所有权。
工具使用 **remote-session**（用户指定），instance=release，唯一在线19876；dev19877离线。这里release仅作为会话运行容器，不修改/重启release安装。
workspace_id `8a18a730-6424-4d23-9c65-69446fdca837`。
- B0 deepseek/deepseek-flash `be6f919e-f3a3-43f3-96ba-d818cb4f032b`
- GWT OpenCode Go channel `215d792b-679b-4055-9dd2-07e06a5730d1` model glm-5.3-flash session `73226aaf-0ec0-4db8-b77a-6031e3e06556`
- resources MiniMax channel `ad74ac74-64a1-4dbb-80c5-4f5d9916bace` model MiniMax-M3 session `0b02c21c-0c25-4f48-89a8-e97b9cc4c270`
- driver deepseek/deepseek-v4-pro `945b6093-1dd0-4450-bd9d-08d000e32d1c`
remote_send_message wait=false **约60s后仍报 Main runtime request timed out: agent.capability.customTool**，但实际发送成功且worker执行中，不重复发原任务。
remote_list_messages目前只看见user首条（Pi历史可能未同步），实际文件与进程显示正在执行。用报告/代码检查跟踪，必要get_session_info/context。
B0已输出 `execution/baseline/{test-baseline.json,full-tests.log,junit-full-tests.xml,isolated-runs.tsv}`；正在分类（未读全）。基线git archive HEAD在/dev/shm固定副本，node_modules @proma指向自身防污染。它用PROMA_DEV=1隔离到dev（原本希望单独临时配置，需核对无真实数据影响，不能将全部fail当环境）。
GWT正改nanju-gwt-runner.ts/.test.ts；resources已新建engineering-resources模块/manifest；driver状态待查。所有worker都收到明确完整scope/DoD/report/autonomy/self-audit，不得再委派、部署、清文件、装依赖、改版本。

## 资源限制
系统盘56GB剩~79MB；曾创建2个33MB worktree，第3失败；已撤销这两个纯本轮临时worktree，没有用户数据删除。采用共享工作树**严格文件所有权**。
/dev/shm有~3.8GB可用，RAM15GB可用12GB，临时测试可用但最终证据归项目。
现有out706MB/dist150MB/dev resources4.6GB都是历史产物不可擅清；pack需后续解决磁盘（可评估新产物/devshm与成套部署，不能未确认删备份）。

## 父会话需要做的工作（已开始读，尚未改产品代码）
父独占恢复跨层：nanju-snapshot.ts、nanju-project-snapshots.ts、nanju-file-snapshot.ts、nanju-ipc.ts、nanju-project.ts、agent-orchestrator.ts、preload/index.ts、shared类型、GuidePanel/StageNodeDetail。后续结构化拒因/阶段续接也是父核心，之后可分片委派。
worker所有权详见dispatch：资源不碰skeleton/check_env/package/builder；driver不碰gwt；GWT只runner两文件；父可改package/builder统一集成。

### 恢复源码调查
- `nanju-project-snapshots.ts`全文约400行已读。createProjectCheckpoint三段createSnapshot→captureFileSnapshot→linkFileSnapshot；capture失败保留会话快照但无file id。restoreProjectFileSnapshot返回FileRestoreOutcome `{ok,complete,notRestored,reason?,preRestoreBackupDir,actionable,userMessage}`。
- **现有 rollbackProjectSnapshot(约300行)**：先rollbackToSnapshot改isCurrent再restoreFile；失败也保留snapshot对象；legacy返回ok:true。要改成事务/明确partial，先恢复必要能力验证，不能假成功。ProjectSnapshotRollbackResult目前ok/snapshot/fileRestore/message。
- `nanju-snapshot.ts` createSnapshot用forkAgentSession({sessionId})，snapshot含id/projectId/timestamp/description/triggerType('init'|'pre-modify'|'confirm'|'mode-switch'|'pre-error')/sessionId/forkedSessionId/isCurrent/fileSnapshotId。**未存阶段状态**。rollbackToSnapshot仅标isCurrent，不切会话。getAgentSessionMeta/updateAgentSessionMeta已导入但未用。
- `nanju-file-snapshot.ts` CONTROL_FILE_NAMES排除 `_snapshots.json`、`_project-info.json`、auth/clarify/repair等控制文件及.bak/.tmp。因此文件恢复不会覆盖快照列表/项目状态。实际restore有journal/lock；`recoverInterruptedRestore(projectDir,storageDir)`返回 `{ok,action:'nothing-to-recover'|'completed-restore'|'aborted-clean'|'compensated'|'invalid-layout',message}`，在再次恢复时调用，未接首次打开。
- `nanju-project.ts` NanjuProject `{projectId,name,mode,status,currentStage,createdAt,updatedAt,sessionId?,workspaceSlug,treeId?,autoClarify?}`；ProjectStage enum mode-select/requirements/prototype/architecture/planning/coding/testing/delivered。updateNanjuProject(workspaceSlug,id,partial)写 workspace `_nanju-projects.json`，不写工程_info。另readProjectInfo/writeProjectInfo可原子写。
- `_project-info`保留pending/auth等字段；成功恢复必须清旧deliveryAck/challenge/confirm/pending授权，避免历史pass复用。可用clearProjectDeliveryAck/Challenge/clearNanjuAdvanceAuthState等。
- `nanju-ipc.ts:637` rollback handler：result.snapshot非空→`{...snapshot,fileRestore,rollbackMessage}`否则null，**丢ok**。preload index.ts:1316 `nanjuRollbackSnapshot`返回Promise<unknown>，3095 invoke。
- `GuidePanel.tsx:313` handleRollback返回Promise<boolean>只看非空，data.refresh→true；StageNodeDetail.tsx:89 onRollback boolean→成功Toast，false只说snapshot不存在。需结构化结果和真实会话选择。
- GuidePanel import useAtomValue，props sessionId；可用atom `currentAgentSessionIdAtom`（agent-atoms:275）；可能还需tabs导航不能只设置atom，继续查其他选择会话用法。
- agent-service.ts导出 `isAgentSessionActive(sessionId)`(:526)、stopAgent、stopAllAgents、runAgent等；恢复前拒绝活跃本工程主/子会话写入，或加锁。不要在snapshot模块顶层import服务避免循环/electron测试污染。用依赖注入port方便测试，IPC生产接线。
- `agent-session-manager.ts` getAgentSessionMeta/updateAgentSessionMeta、forkAgentSession，meta workspaceId；校验目标同workspace/快照归属。snapshot的fork会话最好再fork新恢复分支以保持历史快照不可变。
- snapshot测试 `nanju-project-snapshots.test.ts` mock getAgentSessionMeta=>undefined、fork=>forked-id，config-paths只getWorkspaceFilesDir；直接引入更多模块会破mock，需partial mock或依赖注入并修测试严谨。

### 推荐架构尚未落码
建立shared typed recovery result(status restored/partial/failed; message; activeSessionId; snapshot ids; file restore status)。保存快照时记录stage/substage；恢复前创建索引快照（pre-restore或pre-modify），检查目标fork存在/归属、busy；文件恢复成功后切项目绑定新fork session与stage、元数据和isCurrent，失效旧验收。文件/状态失败要补偿并保持可恢复journal，不夸大。新测试正常/文件失败/partial/legacy/会话不存在/忙碌/崩溃后首次打开。用户已授权实现，无需再问常规选型。

## 已读取技能
executing-plans全文（按用户授权持续批次执行，不每批等确认；引用的superpowers其他skill不存在，不盲目阻塞）。tree-commander读前817/1283行，仅借任务契约与独立审计原则；未建tree/没用tree工具，不要被旧skill大量过期runtime/no coding要求绑架（用户明确父做难代码优先）。agent-collaboration先前读过但用户本轮明确remote-session，不改用collaboration实施。
今后审计需组织不同国内模型独立，至少覆盖验收/恢复/资源/安全四片，可remote会话只读。采用证据驱动迭代，不虚称AC formal完成。

## 当前可见任务
1 建立执行基线与会话编制 pending
2 完成B0–B2首波加固 pending
3 完成流程与产品范围收口 pending
4 审计、迭代与最终交付 pending
应立即update1 completed/in_progress2。

## 刚向用户说
已确认worker实际执行，父恢复设计按文件/会话/阶段/UI完整事务，保留恢复前版本并清旧验收授权。继续执行不结束此任务。

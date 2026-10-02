# 项目决策与工程经验

> 文档版本：1.0.1｜整理：2026-09-20 GMT+8。
> 区分用户明确要求、核验事实与待执行建议；本文件不记录个人画像，不把项目规则写入个人协作记忆。

## 已确认的范围与资料位置

- **2026-09-20 用户目标：** 以现有功能范围的完善优化为主，即设计施工计划第一阶段＋已提前实现的工程模板。后续阶段不自动扩入。
- **2026-09-20 13:10 GMT+8 用户要求，13:27明确位置：** 建立会话启动时检查的 Proma 工作区/当前工作目录 `AGENTS.md`，索引项目关键信息和项目记忆；报告等正文放实际项目目录。先前仅在源码根建立 `Agent.md` 是位置理解错误。
- 落位：Proma工作区 `AGENTS.md` 指向当前工作目录 `AGENTS.md`；后者直接索引源码项目及其记忆、报告与计划。源码 `Agent.md` 保留详细资料索引，源码 `AGENTS.md` 保留工程规则；`docs/project-memory/`存项目状态与决策，`docs/reports/`存报告/证据/来源，`docs/plans/`存执行计划。
- 原始来源保留历史日期，状态正文随核验证据更新。报告归档后用相对链接，原机器路径仅作来源或操作位置。

## 验收与统计纪律

依据2026-09-20设计/代码/真流程对账：

- 实现存在、定向测试通过、真流程通过、普通用户验收完成分别记录。
- AC审查、GWT验收、产品修复、阶段推进重试、环境阻塞独立计数。不能用AC替代testing收口，也不能用驱动代码行数证明质量。
- 原计划要求全量验收；当前“pass+skip仍pass”是待修缺口。未执行场景不算通过，环境不可用不伪装成产品缺陷。
- 旧版编排流程有人为承载平台机制，只证明对应样例与模板局部能力。新平台闭环必须从正常入口跑到真实测试、试用及交付确认。
- “同一批改动前后均92 fail”仅支持未观察到新增回归；不能推出92项全为环境性。需同版本、同环境、同选择集逐条分类。

## 已核验的资源与恢复经验

- 2026-09-20实际包核验：模板当前通过electron-builder `extraResources`分发，已部署asar内没有模板。仅加asar查找优先级不会更新旧外置模板。
- 同批构建的asar、unpacked和外置资源必须一起校验与部署；先备份成套产物，启动后核对版本、隔离目录及新工程模板哈希。
- `_project-info.json`有pending不等于恢复已实现；必须有消费方、可见阻塞原因、幂等续接和成功后的清理。
- 回滚非空snapshot不等于恢复成功；文件、会话、阶段及UI都需要使用实际结果。恢复失败要保留证据与备份，不给成功提示。
- 2026-09-20两处源码仍不一致：模板骨架将环境exit2称blocked，宿主未完整承接；通用探测脚本和品类内联脚本的覆盖与schema不同。它们是待修问题，不是已经解决的经验。

## 当前方案建议（尚未实施）

详见 [执行计划](../plans/2026-09-20-phase1-hardening-plan.md)。下列是计划选型，后续实施中如有更强证据可调整并记录理由：

- 先修验收/恢复正确性，再做效率优化；不以“重试达限自动放行”解除死锁。
- 资源分发优先沿用现有extraResources，加入manifest和哈希校验；不无故增加第二权威来源。
- 业务阶段保持规范枚举，blocked/correcting作为正交执行状态；恢复后重新验证原门禁。
- 驱动骨架默认推荐，自定义驱动允许通过同一行为合规集；不以强制文件名代替断言有效性。
- 证据归工程内或源码项目报告目录，绑定runId和产物哈希；历史可审阅不代表旧授权/宿主票据可无限复用。
- 先完成现有desktop真流程，再按CLI/API、Web、mobile、AI逐品类建立代表样例；未满足环境条件如实BLOCKED。

## 证据入口

- [当前状态](current-state.md)
- [盘点与问题台账](../reports/2026-09-20-phase1/项目盘点与问题台账-20260920.md)
- [原始交接与观察归档](../reports/2026-09-20-phase1/sources/README.md)
- [Phase 1原计划](../DesignDoc/05_PROJECT_PLAN/sprint-plan.md)

## 2026-09-23 新增决策与边界

- 验收基线不再与工程目录同处：使用工作区兄弟文件 `.proma-acceptance-baseline-<projectDir>.json`，降低 L2 直接改规格和基线自证的风险；需求变更重冻结必须有推进授权标识并保留 previous 变更链。当前仍需后续把授权标识与正式回退确认事件做更严格的独立审计绑定。
- `check_env.sh` 的缺失/不可用探针统一输出 `status=fail`；`version=missing` 不得作为可用证据。环境探测脚本错误和真实环境缺失必须分别记录。
- electron-builder 新增 afterPack 产物目录资源校验，并过滤 `.bak/.tmp/.corrupt-*`；在实际 pack 前不宣称此门已验证。
- B3/B6 的阻塞协议：没有运行中的 dev、没有真实产品入口或真实代表工程时，`coveredUs=[]`，只记录结构化 blocked/not-run，不以源码定向测试、模板协议测试或历史编排样本代替产品验收。

## 2026-09-23 R3 收敛新增决策

- **环境探测新鲜度必须比对品类**：`isEnvProbeFresh` 在请求品类与落盘 category 不一致（含旧文件无 category、universal↔具体品类互换）时判 `category-mismatch`（不新鲜、删旧重跑）。依据：品类专用组件集不同，复用旧通用集冒充品类探测会让架构师基于不完整环境事实写环境清单。
- **交付视图 stale 覆盖不得掩去完整性告警**：指纹不符判 stale 时，同步把 `evidence[].verdict` 置 stale，并把「计数不自洽」等完整性告警并入 `staleMessage`——篡改报告信号不能被「已过期」完全遮蔽。
- **历史空态与历史区对齐**：「暂无测试运行记录」空态仅在既无当前报告又无历史记录时展示，避免 report.json 缺失但 evidence 存在时的自相矛盾 UI。
- **入口路径二次防御需加分隔符**：`startsWith(root)` 改 `resolved===root || startsWith(root+sep)`，防 `../project-<id>-evil` 兄弟目录前缀命中（审计实证缺口）。
- **文档证据数字必须可复现**：审计发现「46/46」引用错误即判 red（修复本身真实、证据数夸大也损可信度）；更正为实测值并标注来源。

## 2026-09-24 pack/部署新增决策

- **afterPack 与 buildManifest 的 bundle 指纹排序必须同源**：afterPack 用 `localeCompare` 排序、`computeBundleSha256` 用码元比较，导致同一批文件 bundle 不一致。统一为码元比较（`a.path < b.path ? -1 : …`）。教训：跨语言（.cjs 门禁脚本 vs .ts 权威源）实现同一哈希协议时，排序/拼接算法必须逐字节一致，否则门禁误拦。
- **dev 实例部署用 out/linux-unpacked 增量覆盖**：只替换 resources/app.asar + extraResources（bin/default-skills/nanju-engineering-templates/proma-logos/startup-splash/model-config/tutorial/icon），保留 dev 特有 package-type、setuid chrome-sandbox 与历史 .bak 备份；不删任何旧部署备份。
- **B3 GUI 验证通过 CDP 9224**：dev 实例 `--remote-debugging-port=9224 --remote-allow-origins=*`，父会话用 node 全局 WebSocket 连 CDP Runtime.evaluate 读 DOM/点击，替代视觉截图（视觉路由不可用时）。新建测试工程保留作实物证据，不删。

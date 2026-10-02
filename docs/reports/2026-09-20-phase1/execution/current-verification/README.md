# 当前代码快照验证（2026-09-23）

- Electron `0.17.132` / shared `0.1.63`。
- `bun run --cwd apps/electron typecheck`: exit 0。
- B1 核心回归：550 pass / 0 fail（7 files）。
- B2 资源/驱动/环境/交付/验收回归：270 pass / 0 fail（12 files）。
- 资源 CLI 严格校验：exit 0，requiredCount=12，bundleSha256=d4f6e6fb7100733282b38b303f86b2daf6d6a3469357cbaf558e2ee1ea845ff1。
- 未执行 build/pack/部署/真实 GUI；根盘剩约115MB，不能把源码绿外推为包内或产品绿。
- 日志：同目录 `b1-final.log`、`b2-final.log`、`typecheck.log`、`resources-cli.log`、`env-probe.log`。

## 当前审计修复增量
- 修复 check_env.sh 缺失组件 fail-open：`version=missing` 现在输出 `status=fail`。
- 修复模板环境同步的 ESM/CJS 混用；Electron typecheck 通过。
- 增加 electron-builder `afterPack` 真实产物资源校验，并过滤 `.bak/.tmp/.corrupt-*`。
- 修复 env probe 时钟倒退不应 fresh；增加回归测试。
- 验收规格豁免要求具体理由；testing 绑定不再把 contract test id 单独视为可执行步骤；route 缺失 fail-closed；门禁去除不可见字符。
- 尚未执行 pack/GUI/部署；afterPack 仅已静态校验和 Node 语法检查。

## 当前审计复核（同一工作树）
- MiniMax 资源审计发现的 F-01（check_env fail-open）与 F-02（ESM require）已修；缺失桌面组件现输出 `status=fail`，环境/模板定向回归 160 pass / 0 fail，typecheck exit 0。
- F-03 已接 `electron-builder.yml afterPack`，新增产物目录 hash/size/bundle/临时文件校验脚本；未运行 pack，不能宣称包内通过。
- DeepSeek 恢复审计发现的 eventKey undefined 碰撞与损坏 recoveryState 假恢复已修；typecheck exit 0，恢复既有测试保持通过（并行组合中另有测试 mock 污染，单文件定向 28+4 pass）。
- GLM 门禁审计发现的验收豁免/契约 id 冒充、route 缺失 fail-open、不可见字符绕过已修；验收基线 4 pass，router/delegate 定向回归原门禁通过。
- 仍未进行 build/pack、真实 Electron GUI、dev 部署、真实旧工程/新工程端到端；这些边界保持 blocked/未验证。

## 最终当前快照定向波
- focused repair wave: 15 pass / 0 fail。
- recovery final wave: 65 pass / 0 fail。
- gate/GWT final wave: 485 pass / 0 fail。
- apps/electron typecheck: exit 0；resources CLI: exit 0。

## 尚未关闭的审计边界
- 门禁审计仍记录 OUTPUT 长文本拉距、testing 合法核验引用裸 coding 等残余误拦/漏拦面，未为追求表面全绿扩大规则；需真实流程样本与误拦率后再裁决。
- IPC/preload 仍有历史 `Promise<unknown>` 通道类型债务；不影响当前结构化恢复结果运行，但未完成全量 shared 类型收口。
- 资源与环境当前源码/CLI/定向测试通过；afterPack 已接但未实际 pack，包内资源、部署与 GUI 仍未验证。

## 最终门禁/基线收敛
- 验收基线改为工程目录外的工作区文件 `.proma-acceptance-baseline-<projectDir>.json`，降低 L2 直接改工程目录自证的风险；需求变更重冻结必须带内部推进授权标识并记录 previous 链。
- testing 绑定只读取契约声明的 `scenarioFiles` 与成对 feature/scenario steps，不再扫描任意 feature/json 全文。
- 阶段推进进入 coding 时传递本次推进标识作为重冻结授权；普通变更仍拒绝。
- 当前 focused/recovery/gate 定向波分别 15/65/485 pass，typecheck/resources CLI exit 0。

## B3/B6产品边界
- B3 旧工程取证 verdict=BLOCKED：旧工程 CODE/pending testing/06_TESTS空；dev未运行且本轮禁止启动。
- B6产品验收 verdict=BLOCKED/NOT ACCEPTED：B6矩阵见 `execution/b6/product-acceptance.md`；coveredUs=[]，真实GUI/pack/部署/平台quick全链未执行。
- B5六品类协议矩阵原始归档见 `docs/reports/2026-09-23-phase1-b5/execution/b5/`；web探测旧脚本缺陷已在当前源码修复并单项确认，但该历史矩阵不代表当前产品验收。

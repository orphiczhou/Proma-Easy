# Proma-Easy Phase 2 (v0.17.135) 实施反馈与验收报告

- **执行时间**：2026-11-03 00:48 – 03:20 GMT+8（单夜闭环）
- **基线版本 → 目标版本**：v0.17.132 → v0.17.135（分批递增：波1→133 / NEXT-02→134 / NEXT-05→135）
- **蓝图**：`docs/plans/2026-11-03-phase2-blueprint-NEXT01-05.md`（外部顾问蓝图 guide2 归档版）
- **双模型互审执行记录**（异构交叉审查，严禁实现模型自审，全部为真实独立会话）：
  - GLM-5.3 实现会话：NEXT-01（ca127475）、NEXT-03（9a3eaa6b）、NEXT-02（fbfa5538）；审查会话 R2（b54f0e00）
  - DeepSeek Flash 实现会话：NEXT-04（a7cd8ec2）、NEXT-05（1e2557da）；审查会话 R1（cdd0d09e）、R3（3afe9607）
  - 指挥官：proma-easy 主会话（54b73d44）——分解任务、文件面去冲突编排、验收裁决、统一提交

## 0. 执行摘要

蓝图五大模块（NEXT-01~05）全部实现并通过异构交叉审查；两轮审查共产出 2 项 REQUIRED（全部修复闭环）+ 若干建议项（低成本项已顺手修复，其余记录在案）。全量测试基线治理实现 **99 失败用例 → 0**（并纠正了蓝图的根因误诊）；产品范围 `bun test --isolate apps packages` **2825/2825 全绿**；typecheck 5 包全绿。

## 1. Phase 2 核心模块完成矩阵

| 编号 | 模块名称 | 主导模型 | 独立审查模型 | 状态 | 关键交付 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **NEXT-01** | 交付验收双阶段见证时钟（产物指纹绑定 + 租约冻结） | GLM-5.3 | DeepSeek Flash（R1：REQUIRED→修复复验通过） | ✅ PASS（修复后） | `nanju-engineering-witness-clock.ts` 新模块（digest/冻结/双阶段判定）+ real-gate 接线 + orchestrator 单点接线；10min 静态窗 → 15min 机器窗 + 24h 人类租约（指纹未变即有效） |
| **NEXT-02** | 向导 coding 阶段自动装配指挥官树 | GLM-5.3 | DeepSeek Flash（R3：见 §4） | ✅ PASS | `nanju-coding-tree-bridge.ts`（~640 行，依赖注入 + 三重幂等 + 全路径降级）+ orchestrator 续接块接线 + 22 用例 |
| **NEXT-03** | 跨会话待审批全局聚合横幅 | GLM-5.3 | DeepSeek Flash（R1：REQUIRED→修复复验通过） | ✅ PASS（修复后） | `CrossSessionApprovalBanner.tsx` + `crossSessionPendingApprovalsAtom`（permission/askUser/exitPlanMode 三类聚合）；IPC 四层零改动（respondPermission 按 requestId 全局解析） |
| **NEXT-04** | HTTP Bridge 删通配 CORS + 本地共享 token 鉴权 | DeepSeek Flash | GLM-5.3（R2：PASS，21 项攻击面全阻断） | ✅ PASS | token 0600 生命周期（dev/release 实例隔离）+ loopback 双校验放行（19877 直连兼容保持）+ Origin 一律 403（阻断 no-cors CSRF）+ timingSafeEqual |
| **NEXT-05** | 全量测试基线治理 | DeepSeek Flash | GLM-5.3（R4：PASS，根因诊断与数字全部独立复核成立） | ✅ PASS | `test-home-fixture.ts` 隔离夹具 + Batch A/B/C 治理；99 失败用例 → 0；根因纠正为 mock.module 进程级泄漏，`--isolate` 门禁固化到 package.json |

## 2. 自动化验证与端到端实测输出（全部真实终端输出）

### 2.1 双阶段见证时钟（NEXT-01）
- `bun test nanju-engineering-real-gate-clock.test.ts` → **21 pass / 0 fail**（59 expect）：人类等待 28min（旧 10min 窗口必死）仍 PASS；篡改哪怕 10 秒后立即 `E_WITNESS_DIGEST_MISMATCH`；未冻结超 15min 失效；冻结后 24h 内 PASS / 超 24h `E_WITNESS_HUMAN_LEASE_EXPIRED`
- 组合回归：clock+witness+w-i-b-f+real-evidence+linux-observer+confirm-advance 六文件 **187 pass / 0 fail**（连续 3 轮稳定）；gwt-runner+w18 **187 pass**；orchestrator 相邻 **40 pass**
- 压力测试有效性双向验证：容量 64 → 压力用例 fail（复现审查发现）；256 → 全过

### 2.2 跨会话横幅（NEXT-03）
- `bun test agent-atoms.test.ts` → **43 pass / 0 fail**（含 B-1 安全基线 4 例：dangerous 权限禁止内联放行、必须跳回原会话；B-3 ExitPlanMode 接线；B-6 引用稳定化真命中用例）
- IPC 四层契约零改动：完全复用既有 `PERMISSION_RESPOND` 通道

### 2.3 HTTP Bridge 鉴权（NEXT-04）
- `bun test agent-mcp-bridge.test.ts` → **24 pass / 0 fail**（真实 HTTP 两路：loopback 无 token 放行 200 / 错 token 401 / Origin 403 / 0.0.0.0 绑定无 token 401 / CLI 子进程真实注入 127.0.0.2）
- w17 源码断言（L766）117 pass 未破坏；esbuild 打包实证动态 import 正确折叠；**19877 无 token 无 Origin 直连 RPC 兼容性经实测保持**（RESUME §6.4 自动化栈不受影响）

### 2.4 coding 自动建树（NEXT-02）
- `bun test nanju-coding-tree-bridge.test.ts` → **22 pass / 0 fail**（真实 tree-engine 端到端 + /tmp 隔离：幂等/E_DUPLICATE_LEAF 续用/碰撞拒绑/异常不抛/init 失败不建会话）
- 相邻回归：tree-engine-communication 4 pass、w17 117 pass、orchestrator-continuation 16 pass
- 13 项蓝图假设逐一现实校验（真实 leaf_id 完整正则、ROLE_ENUM 无 auditor、session_id 必须 UUID、path 字段约束等，详见实现报告）

### 2.5 全量 `bun run typecheck` 与 `bun test` 基线对比
```text
typecheck（5 包 + shared）: 全部 Exited with code 0

BEFORE  bun test                    2730 pass / 120 fail（=99 失败用例 + 21 docs 文件级错误）
AFTER   bun test --isolate          2864 pass /  21 fail（=0 失败用例 + 21 docs 冻结证据错误）
AFTER   bun test --isolate apps packages   2825 pass / 0 fail / 0 errors（新门禁口径，已固化 package.json）
```
- 根因纠正（R4 独立复现实验钉死）：119 fail **并非**蓝图诊断的「环境耦合/密文解密/快照路径」，而是 `mock.module` 进程级跨文件泄漏；`--isolate` 每文件独立模块注册表即解
- 另修复 5 个测试文件真实写 `~/.proma` 的泄漏（夹具接入，零断言改动，HOME 快照对比零新增）

## 3. 异构模型交叉审查发现（Audit Findings）

### 3.1 DeepSeek Flash 对 GLM-5.3 代码的独立审查（R1，NEXT-01+03）
- **verdict：REQUIRED → 两项已修复并复验**
- A-1（major）：保留窗放大 100× 但票据容量 64 未同步 → 24h 内 70+ 次登记 fail-closed 阻塞（实测复现：rounds=100 gap=16min 改动后 28 次票据签发失败）。修复：容量 256/512 + ticket 回归 20min 短窗 + 审查清单遗漏的 `maxBoundaryAckReceipts`（32）同类失配一并修复
- B-1（major，安全 UX）：跨会话「直接允许」盲批。修复：聚合带出 sdkTitle/command/dangerLevel + 两段式横幅（命令代码块）+ `canInlineRespondCrossSession` 门控（dangerous 禁止内联放行）
- 建议项修复：A-2 租约算术补 15min 安全垫（协议层锚定差上界）、A-3 墙钟回拨自旋加上界 fail-closed、A-4 快消型误报门控 + 冻结失败原因写入交付拒绝文案、A-6 指纹排除构建目录、A-7 篡改措辞、B-3~B-6 全部
- 记录在案（不阻塞）：A-5 24h 租约不跨进程重启（重启后 hostRunId 变化证据整体失效，无安全缺口）、A-8 阶段 B′（人证登记→重跑）仍受 15min 约束为残余超窗路径、B-2 横幅仅在 agent Tab 可见（蓝图口径）、G1/G2/G4 覆盖缺口（E2E 实测待后续批次）

### 3.2 GLM-5.3 对 DeepSeek Flash 代码的独立审查（R2，NEXT-04）
- **verdict：PASS**（3 minor + 2 建议，无 REQUIRED；21 项攻击面逐项结论全部阻断/兼容）
- M-1 双进程毫秒级 token 初始化竞争（影响面极小，loopback 主路径不受影响）、M-2 secondary 兜底边界（方向是拒绝非放行，且是目录错位场景的正确性保障，不建议删）、M-3 `--host` 注释误导（**已修复**：注释如实限定同机生效/跨机需 PROMA_BRIDGE_TOKEN_PATH）
- 关键确认：no-cors CSRF 副作用被 Origin 403 阻断（比蓝图更严的正确设计）；19876/19877 直连兼容保持

### 3.3 DeepSeek Flash 对 GLM-5.3 代码的独立审查（R3，NEXT-02）

- **审查→返工→复审→终审完整闭环**，终审 **✅ PASS（签字通过）**
- 首轮 verdict 🔴 REQUIRED：审查员用真实 tree-engine 做 5 轮攻击探针，发现 3 项阻断级缺陷——**红-1** 树结构死锁（root 添加的叶 root 不能背书 + auditor 叶需先被背书的循环，实测三条背书路径全部 `E_AUDITOR_NOT_INDEPENDENT`）、**红-2** 中文项目名全部塔缩 `nj0000`（projectId 保留 CJK 而 treeId 派生清除 CJK，第二个中文项目永久建不出树）、**红-3** 部分失败永久粘滞拒绝；并实测验证了正确解（三层结构 + trust-anchor 链路）
- 返工：R1 三层结构（root → C-commander → A/B，A/B added_by=C 会话）+ 全链 audit_gate 端到端用例（root done 取 trust-anchor → root 背书 B → B 背书 A → tree_validate issues=[]）；R2 treeId 改 sha1 短哈希；R3 补缺自愈；黄/绿项全落（含 leaf set-session 重绑、孤儿会话止损、prompt 补 V10 硬约束 4 条、tree.bootstrap 独立埋点事件、3s 引擎超时）
- 复审 🟡 有条件通过：返工引入 F-1（孤儿回收越界删除已挂树会话）+ F-2（root 漂移×树不完整组合态不重绑），审查员给出最小修复并承诺修完直接签
- 终审：F-1/F-2 收口（含注入式回归门用例）+ F-4/F-6 顺带项 → **PASS**，独立探针实证「只删未挂树会话且重试无悬空」「组合态重绑在引擎 caller 校验层生效」；遗留 F-3（旧两叶结构迁移检测）/F-5（withTimeout clearTimeout + TREES_ROOT 竞态串行互斥）不阻断，下轮清理
- 本模块是异构互审体系价值的最直接实证：实现者 22 用例全绿且非假绿，但结构性死锁只有审查员的对抗探针能暴露；终审要求后续改动必须保留 F-1/F-2 两条红线用例作回归门

### 3.4 GLM-5.3 对 DeepSeek Flash 代码的独立审查（R4，NEXT-05）
- **verdict：PASS**（无 REQUIRED；2 建议 + 5 观察）
- 实现者三项核心主张（根因诊断/数字/断言翻转合法性）全部独立复核成立：根因实验钉死 mock.module 泄漏；`--isolate apps packages` 2825/2825 本机重跑复现；Batch C 7 处断言翻转逐条对上现行源码（abort 共享层逐字匹配、bundleVersion 有 commit 0808a7a6 实证、docs 5 文件对应缺陷确认已修复——无「改宽变绿」）
- S1 建议（**已采纳**）：test script 固化 `--isolate` 门禁（防后续贡献者裸跑误判 79 fail 为基线破坏）
- S2 建议在案：夹具 restore() 栈式回退（当前无嵌套使用场景）
- E1 实证：真实 `~/.proma/agent-workspaces/test-ws` 等历史泄漏残留空目录（修复前泄漏的实物证据）

## 4. R3 补记（NEXT-02 审查结论）

已并入 §3.3（含首轮 REQUIRED、返工、复审、终审 PASS 全过程）。

## 5. 偏差与遗留（如实记录）

1. **与蓝图的重大偏差（均有依据）**：
   - NEXT-01：witnessedAt 锚定 GWT pass 时刻（非人证登记时刻）——避免「人证→重跑→再冻结」死循环；指纹排除 `_project-info.json`（人类确认动作本身会写它）
   - NEXT-02：13 项蓝图伪代码假设与现实不符处全部按真实代码落地（含 leaf_id 完整正则、无 auditor role 枚举、不硬编码模型 fallback）；接线点移至 orchestrator 续接块（真实写库点在白名单外）
   - NEXT-04：token 按 dev/release 配置目录隔离（蓝图写死 ~/.proma 会破坏双实例隔离）；额外收紧 Origin 403（蓝图只要求删 CORS 头，不足以阻断 no-cors 副作用）
   - NEXT-05：夹具方案从 PROMA_CONFIG_DIR 环境变量改为 mock.module('node:os')（Bun 进程内 homedir() 缓存使 env 方案无效；config-paths 无该环境变量支持）
2. **遗留待办**（不阻塞本轮交付）：
   - NEXT-02：F-3 旧两叶结构迁移检测、F-5 withTimeout clearTimeout + 引擎 TREES_ROOT 竞态串行互斥、前端任务树 Tab 自动切换（需 renderer 改动）
   - docs/ 21 个冻结证据文件加载错误（`--isolate docs` 下仍在）：推荐后续归档改名 `.test.ts.reference` 或维持门禁限定 apps packages（本轮已采纳后者）
   - 真实 `~/.proma/agent-workspaces/` 下历史测试残留空目录（test-ws/test-ws-none/ws 等）待用户裁决清理
   - NEXT-01 的 A-5/A-8/G1/G2/G4 与 NEXT-02 的 treeId 截断碰撞序号后缀方案、前端任务树 Tab 自动切换（需 renderer 改动）
   - NEXT-04 的 M-1/M-2 加固（token 独占创建）、session-management 默认 Skill 文档同步（需 bump skill version）
   - `proma-mcp-server.cjs` 打包分发路径既有疑问（未入 electron-builder files，非本轮引入）
   - m8 集成测试隔离 $HOME 回归（RESUME §四口径）待本轮部署后复跑
3. **部署注意**：本轮改动仅入库未部署 dev 实例（dev asar 仍 v0.17.132）；部署后需按 NEXT-04 报告建议做实例冒烟（loopback 200/错 token 401/Origin 403）

## 6. 提交与推送

- 分模块 commit（波1 / NEXT-02 / NEXT-05+门禁 / docs），每批版本 +1（132→133→134→135）
- 推送后以 fetch 远端引用核验（GnuTLS tlsv1.2 已持久化，间歇失败重试即可）

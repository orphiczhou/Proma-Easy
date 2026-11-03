# B3 旧挂起工程恢复前事实矩阵（只读取证）

> 任务：B3 只读验证｜生成：2026-09-23 19:11 GMT+8｜执行者：Proma Agent（只读）
> 边界声明：本文件仅记录「恢复前事实」，未操作 release/dev 部署，未启动/删除真实用户工程，未改产品代码。**读取旧工程 ≠ 产品验收完成。**

## 0. 结论速览

| 项 | 值 |
|---|---|
| 工程身份 | `project-真流程e2e-剪贴板历史`（mode=quick，platform quick 引擎驱动） |
| 位置 | `/home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files/project-真流程e2e-剪贴板历史/` |
| 当前业务阶段 | **CODE**（subStage=CODE；注册表 currentStage=coding） |
| pending | `pendingAdvanceCorrection` → target=testing, kind=gate-deny, count=1 |
| 06_TESTS | **空目录**（testing 未真实执行） |
| 08_APP | coding 产物齐全 + ac-verdict=yellow（red=0，3 yellow open） |
| 恢复可行性 | **blocked**：dev 实例未运行 + 任务边界禁止启动 dev |

## 1. 控制文件截面

### 1.1 `_project-info.json`（恢复前）

```json
{
  "projectId": "真流程e2e-剪贴板历史",
  "mode": "quick",
  "sessionId": "540110fb-58d7-42c6-a322-4f8e09fb2723",
  "subStage": "CODE",
  "codingDelegationId": "881611b5-33c8-4c94-ae93-84e74cd18b4b",
  "phaseGuards": {
    "coding": { "failCount": 0, "errorCount": 2, "lastErrorAt": "2026-09-19T21:46:28.749Z" }
  },
  "pendingAdvanceCorrection": {
    "kind": "gate-deny",
    "target": "testing",
    "expected": "testing",
    "at": "2026-09-19T22:02:55.863Z",
    "count": 1
  },
  "envReady": true,
  "envCheck": [ /* 11 组件：python3/tkinter/pynput/xclip/xdotool/xprop/node/fcntl/X扩展/rustc-cargo/wmctrl 均 ok */ ]
}
```

- `.json` 与 `.json.bak` 差异：`pendingAdvanceCorrection` 字段**仅存在于 .json**，.bak 无。即 pending 是后续（推进被拒时）新落盘，恢复消费尚未发生。
- 关键判读：`pendingAdvanceCorrection` 有落盘 ≠ 恢复已实现。当前无证据表明有消费方已处理该 pending。

### 1.2 注册表 `_nanju-projects.json`（workspace 级）

```json
{
  "projectId": "真流程e2e-剪贴板历史",
  "status": "active",
  "currentStage": "coding",
  "updatedAt": "2026-09-19T20:32:06.577Z",
  "sessionId": "540110fb-58d7-42c6-a322-4f8e09fb2723"
}
```

## 2. 阶段目录截面

| 目录 | 内容 | 备注 |
|---|---|---|
| 01_PRD | prd.md（US-01~US-08）+ audit-conclusion.md | red=0 审计通过 |
| 02_UX_DESIGN | prototype.html | 有 |
| 03_ARCHITECTURE | architecture.md + engineering.json(schema v2) + env_probe.json + ac-verdict.json | ac-verdict=yellow（2 轮，跨族 deepseek-flash） |
| 04_API_SPEC | **空** | — |
| 05_PROJECT_PLAN | **空** | — |
| 06_TESTS | **空** | testing 未真实执行 |
| 07_VERSIONS | **空** | — |
| 08_APP | app/{clipboard_history,history_store,clipboard_io}.py + tests/drivers/run_driver.py + README.md + ac-verdict.json | coding 产物齐全 |
| 09_IMPROVEMENTS | gate-delegation-latency.md | 调研员产出的委派门禁分析 |

## 3. 06_TESTS 事实

- 目录存在但**完全为空**（无 report、无 feature、无 evidence）。
- 结论：真流程的 testing 阶段从未真实执行收口。08_APP 内的 ac-verdict（yellow）是 coding 阶段的附加验收产物，**不构成 06_TESTS 的 testing 收口**，更不能当作产品验收通过。

## 4. 08_APP 的 AC 结论（仅作 coding 阶段参考，非 testing 收口）

`08_APP/ac-verdict.json`：verdict=**yellow**，3 轮对抗审查（R1 deepseek-flash → R2 deepseek-v4-pro → R3 glm-5.3-flash 跨族只读）。red=0，仍有 3 项 yellow open（驱动滚轮坐标未叠加面板原点、_WROTE 记录时机早于 xclip 写成功、--interval 无下界钳制）。

最终运行（README §8 记录）：
- unit-store @:12.0 → 10/10 PASS rc=0
- integration-clip-io @:12.0 → 6/6 PASS rc=0
- acceptance-e2e @:12.0（锁屏会话）→ 39 PASS / 0 FAIL / **15 BLOCKED** rc=1
- acceptance-e2e @:99（裸 Xvfb 无 WM）→ 48 PASS / 0 FAIL / **4 BLOCKED** rc=1

> 注意：这些数字是 coding 阶段作者记录的运行结果，属工程内自述产物；B3 只读取证不重新背书其真实性，也不把它们当作 testing 阶段平台收口。

## 5. 遥测最后事件（workspace-files/_telemetry/events-2026-09.jsonl）

该工程共 **118** 条事件。类型分布（前 10）：

| eventType | 次数 |
|---|---|
| router.gate.unbound-write-deny | 27 |
| delegate.guard.stage-deny | 19 |
| dialog.submitted | 7 |
| spike.verdict | 6 |
| advance.reject-escalate | 6 |
| advance.auto-gate | 6 |
| delegate.guard.ac-override | 4 |
| phase.elapsed | 3 |
| confirm.auto-confirm | 3 |
| 其他 | 37 |

该工程最后 6 条关键事件（时间倒序）：

| 时间(UTC) | eventType | 要点 |
|---|---|---|
| 2026-09-20T01:11:38.931Z | dialog.submitted | turn 7, inputLength 1923 |
| 2026-09-20T01:10:54.169Z | spike.verdict | SPIKE-001/002 confirmed（architect GLM-5.3） |
| 2026-09-20T01:10:35.116Z | spike.verdict | SPIKE-001/002 confirmed |
| 2026-09-19T22:02:55.863Z | advance.reject-escalate | continuation-giveup, gate-deny, target=testing, count=1 |
| 2026-09-19T22:02:45.859Z | advance.auto-gate | coding→testing, auto_block_reason=verify-failed |
| 2026-09-19T21:09:28.623Z | circuit_break | coding, delegation_hard_timeout（L2 委派硬超时） |

Workspace 级最后事件（无 projectId，但与 testing 推进相关）：

| 时间(UTC) | eventType | 要点 |
|---|---|---|
| 2026-09-20T01:19:22.701Z | phase.advance.discarded-unanchored | count=1, stages=[testing]，sample 提及「`PHASE_ADVANCE: testing` 不含确认词、不构成推进授权」 |

**遥测判读**：推进 testing 曾经历 `advance.auto-gate → verify-failed` → `advance.reject-escalate (continuation-giveup, count=1)`，落盘为 pendingAdvanceCorrection；其后有一次无 projectId 的 `phase.advance.discarded-unanchored`（testing 推进因无确认词被丢弃）。这些与「pending 指向 testing、06_TESTS 空、subStage 仍 CODE」完全自洽。

## 6. 恢复前事实结论

1. 旧工程**停在 CODE**，未到 testing；pending 已落盘但无消费证据。
2. 06_TESTS 空 → testing 未真实执行，不能宣称任何 US 被真流程验收覆盖。
3. 08_APP 有 coding 产物 + yellow 级 AC 结论，属 coding 阶段交付，不是产品验收通过。
4. 恢复的正确路径是通过产品恢复入口消费 pending、真实走 testing（而非直接把 stage 改成 testing）。
5. **本会话无法执行恢复**：dev 实例未运行（无 proma-dev 进程、9224 未监听），且任务边界禁止启动 dev。

## 7. 证据链

- 控制文件：`_project-info.json`、`_project-info.json.bak`、`_nanju-projects.json`
- 阶段目录：01_PRD ~ 09_IMPROVEMENTS（06_TESTS 空）
- 08_APP：README.md、ac-verdict.json
- 遥测：`workspace-files/_telemetry/events-2026-09.jsonl`
- 源码测试：见 `b3-clean-project.md` 第 4 节与 `recovery-routing-tests.log`

# 续接提示词（新会话开工用）

你接手 PromaEasy 长线多维任务的续接。前序会话（6aad1bd7）已完成：工程盘点+罗盘、GitHub 推送（v0.17.131 已 push）、真平台流程 E2E 打通（CDP 驱动 dev UI）、门禁透明化批 v131 提交。你接手的是**收官与下一轮改进循环**。

## 必读（按序）

1. `<workbench>/handoff-真流程E2E-20260920.md` —— 交接文档（任务全景/已完成/当前状态/待办/路径/纪律）
2. 记忆 `~/.proma/agent-workspaces/default/memory/proma-dev-e2e-trigger.md` —— CDP 触发方法全套（部署/隔离启动/阶段机/观察员样本），**勿重复踩坑**
3. `<workbench>/e2e-指挥部日志.md` —— 全程作战时间线
4. 罗盘 `<workbench>/工程盘点罗盘-20260919.html` —— 当前状态可视化
5. v131 方案 `proma-patches/.../dispatch/reviews/v131-门禁透明化方案.md`

## 一句话任务

**先推进真流程 E2E 到 testing 收口 + 收割 O3 终报 → 部署 v131 到 dev 验证门禁透明化实效 → 汇总八份观察报告出 Y1-Y10 改进方案 → 执行 + 罗盘 + git，循环推进。**

## 立即行动（P0，按序）

1. **推进真流程 E2E**（工程 `~/.proma-dev/.../workspace-1786847832507/workspace-files/project-真流程e2e-剪贴板历史/`，当前 CODE 阶段，08_APP 已落 6 文件，06_TESTS 空）：
   - 用 `proma-easy/dev/e2e-v130/advance.sh "消息"` 给主控发推进（主控 channel=null 只能 CDP；发前先切会话——脚本已内置切会话逻辑）
   - 推进到 testing 完成（06_TESTS 有 features + report-*.json），记录最终收敛轮次（对照双基线 G3b 8 轮/编排版 4 轮）
   - 若 dev 挂了：按记忆 §2 重启（`PROMA_INSTANCE=dev PROMA_DEV=1` + DISPLAY + DBUS）
2. **收割 O3 终报**：dev 实例会话 fab6e323-297f-4276-8f86-5e209e84f1dc（qwen3.8-flash，环境探测Spike 维度），它的报告停在 23:06 快照 #2，终报指令发过未产出——重发明确终报指令（含真流程现状：CODE 阶段、spike 的 env-manifest 有 os/virt 正确识别 Hyper-V、脚手架 env_probe 缺 v130 四探测）

## P1（v131 部署验证）

3. v131 部署到 dev：`cd proma-patches/p1-quick-engineering/apps/electron && bun run pack` → 备份+替换 `dev/app/resources/app.asar` + `app.asar.unpacked` → **同步散装目录** `dev/app/resources/nanju-engineering-templates/`（现是 09-04 旧 v1.0，R3 部署侧配套）→ 重启 dev
4. v131 实效验证：verify-failed 拒因是否透传逐项清单（R1）、TaskCreate 是否不再被拒（R5）、模板落位是否 v2.4（R3）

## P2（Y1-Y10 改进方案，见交接 §四）

5. 汇总八份观察报告（编排版 O1-O4 + 真流程 O1-O4），出 Y1-Y10 改进方案 → 审计 → 执行 → 罗盘 + git

## 硬边界

- 真流程 E2E 未到 testing 收口不得宣称"全流程完成"；收敛轮次必须真实记录
- asar 与 unpacked 同批 pack 配套；替换前备份；部署后同步散装目录（三处易错）
- 全量测试 92 fail 为既有环境性（干净 HEAD 对照一致），不算本批回归；提交前定向测试+typecheck+build 必绿
- commit 带 `Made-with: Proma`；版本号每批 bump；push 到 easy 远端（凭证已修好）
- 观察员只观察不干预；派观察员必配参照样本（observer-ref.md）
- 不碰 G3b 旧工程、不碰 release 实例、密钥不落盘

## 完成定义

真流程 E2E 至 testing 收口（收敛轮次落盘）→ O3 终报收割 → v131 部署 dev 且 R1/R3/R5 实效验证通过 → Y1-Y10 方案落盘 → 本轮可执行项完成并提交推送 → 罗盘更新 → 写下一份交接。

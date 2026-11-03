# O3 观察报告 · 环境探测与 Spike 维度（真流程版）

> 观察对象：`/home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files/project-真流程e2e-剪贴板历史/`
> 对照基准：desktop-app 模版 **v2.4**（2026-09-19 16:34，含 v130 四探测回填）+ `02-Spike实验协议.md` v1.0 + `proma-easy/dev/e2e-v130/observer-ref.md`
> 前作基线：编排版 E2E（default workspace，13:50–16:15 观察全程，SPIKE-001/PIT-SPIKE-001 即出自该工程）
> 职责：只观察不干预；本文件是唯一允许写入的工程路径。

---

## 快照 #1 · 2026-09-19 23:02 GMT+8（工程龄 ~7 分钟，脚手架态）

### 一、探测一致性（声称 vs 我实测）

**① 平台自动落盘核查（本维度头号问题：v130 四探测是否随脚手架落地）**

工程当前全部文件 = `_project-info.json`（522B，22:55）+ 9 个空 docDirs（00_SPIKES…08_APP）。**`scripts/check_env.sh` 与 `03_ARCHITECTURE/env_probe.json` 均未落盘**——脚手架阶段不自动跑 check_env，四探测兑现完全押在架构师会话的 v127/J2 通道（任务书注入「已知环境事实」+ 架构阶段执行脚本）。判定：⏳ pending，非失分；但注入通道的真伪现在有了机器判据（见二.3）。

`_project-info.json` 关键字段：`mode: quick`（快消盒 ≤30min/Spike 适用）、`archEvidenceGate: true`（架构证据门禁开启——编排版"自评全绿且乐观"问题的平台侧应对，观察其实际拦截力）。

**② 我的独立环境基线（23:02 复测，与编排版 13:56 基线并列）**

| 项 | 编排版时点（13:56–16:17） | 本时点（23:02） | 观察含义 |
|----|----|----|----|
| os-release | —（未探，正是失真缝隙） | `Ubuntu 24.04.1 LTS` | 真流程 check_env 若抄"WSL2"当场可破 |
| virt/DMI | `systemd-detect-virt`=microsoft；DMI=Microsoft Corporation / Virtual Machine | 同左 | 昨日 O3 结论稳定：Hyper-V 系 VM 原生 Ubuntu |
| **DISPLAY** | `:11.0`（xdpyinfo 应答） | **`:12.0`（变了）** | ⚡ 新失真模式自然出现：X 会话已迁移。任何产物若写 `:11.0` 即为陈旧转写/昨日残留而非当机实测——这是比编排版三失真更隐蔽的时效性考题 |
| docker | CLI+daemon 可用（`docker info` 成功） | 仍 daemon-ok | 编排版"无 Docker"失真项，本版应探测自证 |
| 密钥名 | 我当时 shell：DASHSCOPE/DEEPSEEK/ARXIV 三枚 | 当前 shell：`ZHIPUAI_API_KEY TAVILY_API_KEY ZHIPU_API_KEY CLAUDE_CODE_MESSAGING_TOKEN` 四枚 | 密钥集**按进程环境而异**（我的 shell 与昨日不同源）。探测只能诚实反映探测进程所见；env_probe 若报"无密钥"需先问"谁的环境"——解读注意项，也反证 cloud-keys 探测比手抄更该存在 |
| cb-owner | 无（工程未启动时 0） | **1**（编排版签收残留 daemon 2024622，已存活 ~7h） | 新项目 check_env 会把此计数如实探到——非脏数据而是真实前置态，但需在 NOTES/架构中归因"昨日工程残留"，否则易误判为"本机天生有剪贴板驻留者" |
| xclip / pynput | 0.13 / 可 import | 不变 | 监听方案选型知识可原地复用 |

### 二、Spike 质量评估（当前态：机制预检）

**1. 模版侧知识回填核验（编排版 PIT-SPIKE-001 的去向）——回填完整 ✓**
- C4 xclip 已知坑新增第②条「**写时挂死**」[实证 SPIKE-001：…阻塞 21 分钟靠外部代杀才解]，且明确"读侧同样必须带 timeout"（连我快照 #2 指出的"守卫不对称"都吸收进了条文）；
- 坑库新增 **PIT-DA-012**（xclip 写时挂死全条目：现象/绕行/泛化教训"凡 fork 驻留进程 CLI 禁 capture_output 等管道"，状态"已实证；已回填 C4 第②条"）——协议 §6.3 回填闭环首次观察到完整走完；
- §2.3 内联脚本增 os/virt/cloud-keys/cb-owner 四探测，CHANGELOG 明确归因"根治『失真与探测覆盖负相关』，O3"——我编排版终报建议 1/2/3 全部进了模版。
- **传导链判据就绪**：真流程架构师若再用 `subprocess.run(capture_output=True)` 裸调 xclip -i = 无视 [实证] 坑（重罪）；若直接 DEVNULL+函数级 timeout = PIT-SPIKE-001 知识经模版通道零 Spike 复用（本日 ③ 的理想结局）。
- **T1 反向判据更新**：剪贴板监听方案（轮询 vs watch）现已是模版 [实证] 覆盖项——**新架构师再为"监听选型"起 Spike 反而违反 T1**（反例栏"模版已有 [实证] 条目直接引用"）。合法 Spike 空间只剩 clipnotify 编译路线（§2.4 降级仍标 [推断]）与 §6.4 建议的 CJK 注入题（注意：模版 §6.4 的 SPIKE-001=编号仍指 CJK 题，昨日我标的"编号串号"隐患未修，无害但新工程若再产出 clipboard spike 编号会撞车）。

**2. 机制裂缝（本快照最重要发现，黄·中）**：v130 四探测**只存在于 desktop-app.md §2.3 内联脚本**；模版根目录的独立分发文件 `check_env.sh`（mtime 09-18 19:00，早于 v2.4）探测集为 node/npm/rust/go/docker 等品类无关项，**os/virt/cloud-keys/cb-owner 四关键字 0 命中**。双源不同步——若平台脚手架或架构师复制的是分发文件而非 §2.3 内联版，四探测静默缺失，"负相关"病根原样复发。判据：下轮看 `scripts/check_env.sh` 内容指纹，即可分辨执行会话抄了哪个源。
- 附赠小坑预告（供解读）：§2.3 `probe "cloud-keys"` 用 grep，无密钥时 rc=1 → status="fail"——**健康状态被编码成失败信号**，读 env_probe.json 时勿反向误判；`probe "virt"` 两命令串的 rc 取末命令 cat，systemd-detect-virt 返回 none 时 rc=1 会被 cat 的 rc 掩盖，语义靠 detail 文本而非 status。

**3. 三项编排版失真的杜绝判据（预置）**：本版 env_probe.json 应报 os=Ubuntu 24.04.1 / virt=microsoft / cb-owner≥1 / 密钥名清单（探测进程视角）；任务书「已知环境事实」段应带探测时间头（v127 平台通道产出，编排版当时缺此头即非平台通道）；DISPLAY 应为 :12.0。四项任一不符即在注入通道复发，任一符合且与 detail 原文互证 = J2/v130 通道闭环。

### 三、下轮待验证

1. `scripts/check_env.sh` 落位与否及其源指纹（§2.3 内联版 vs 过期分发版）；env_probe.json 是否含四新探测 + probedAt 时效 + DISPLAY=:12.0 实值。
2. 任务书注入段是否由平台 `runEnvProbe` 通道生成（探测时间头/逐组件来源行）。
3. 架构/开发是否按 PIT-DA-012 直接 DEVNULL+timeout 落码（零新挂起 = 回填生效）；若再挂起 = [实证] 坑条文对执行会话不透明，通道断裂升级。
4. 是否出现"违规重 Spike"（为已 [实证] 的监听选型再花时间盒）。
5. cb-owner 残留 daemon 是否被如实归因。

**一句话趋势**：脚手架把考卷发了、模版把答案刻在了刀上（四探测+挂死坑全数进条文）——但分发脚本与正文内联双源不同步，v130 的"根治"成败现在取决于执行会话抄哪一份源；而 DISPLAY 一夜之间从 :11.0 变成 :12.0，环境自己出了时效性附加题。

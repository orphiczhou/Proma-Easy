# 审计基线：sha256 + 大小 + mtime

> 审计时间：2026-09-23T18:23 GMT+8（抓取）
> 工作树：/home/orphic/proma-patches/p1-quick-engineering
> Git HEAD：34f72fbc8114608b998eaf4e1f5e1937f3deeb59（v0.17.131，p1-quick-engineering 分支）
> 工作树状态：66 处修改 / 新增文件未提交（含 audit-current/resources/）
> 磁盘 apps/electron/package.json version 字段：0.17.132（未提交改动，已 +1）
> 磁盘 packages/shared/package.json version 字段：0.1.63（未提交改动，已 +1）
> mtime 单位：epoch 秒；2026-09-23 18:00 GMT+8 = 1790157600

## 资源目录（apps/electron/resources/nanju-engineering-templates/）

| sha256 | size | mtime (epoch) | mtime (ISO) | file |
|---|---|---|---|---|
| d2ff0c88151fe87f8ce4d9a68b3de7f034e425545f4d29b3d9ec34598058e0aa | 9136 | 1789714538 | 2026-09-18T14:55:38+0800 | 02-Spike实验协议.md |
| 0cf71bf21f7a65de8356acea8066726fec2cdf16103c77782c1c6b6514010124 | 4781 | 1789972790 | 2026-09-21T14:39:50+0800 | CHANGELOG.md |
| 5106a23b0eeaf1958f9168ac8f8f6fcdefa8f8c08912066c5f399b098b1754ea | 4882 | 1789884777 | 2026-09-20T14:12:57+0800 | README.md |
| 4aace3f9d7e591a18ae113bfc9864bb33b46a8d3592171fec4e364c895722fba | 20980 | 1789740579 | 2026-09-18T22:09:39+0800 | ai-application.md |
| 804d21dea9dd8bb5f21200ab2f9cbb2f8554209dc46c99421f527db75fe3bd76 | 17256 | 1789739859 | 2026-09-18T21:57:39+0800 | api-backend.md |
| e2140000fcb1d727093747d97db29ebde8370861621a432b305be5f3b2001011 | 7929 | 1789887786 | 2026-09-20T15:03:06+0800 | check_env.sh |
| 4cf2384821adfc5f17dbd2a5957c5972f12862ee9a95af07c08a941f4f630f21 | 16226 | 1789740614 | 2026-09-18T22:10:14+0800 | cli-tool.md |
| 39e278c8023d018fad7d23883c870aa6fb330d13048dc8cd7e34b77f2b534c6e | 33295 | 1789806891 | 2026-09-19T16:34:51+0800 | desktop-app.md |
| 7dcde979b285fe1f20c8f42aaf49f72d5514ef2a0f504d471e75f009b1785272 | 15254 | 1789884828 | 2026-09-20T14:13:48+0800 | driver-skeleton.cjs |
| 1cc168a9c14611bbf4195f2ea0d5d29349f7545b7527407096ae4f7745e55e95 | 14514 | 1789884813 | 2026-09-20T14:13:33+0800 | driver-skeleton.py |
| 9ea31c3bb4545e5cff264268c60945f98aef7b6b8c8ecb22e36755bf1b1f9f55 | 6432 | **1790158153** | **2026-09-23T17:29:13+0800** | **manifest.json** |
| 284e3ac7913d86333bc5d58c9ca339ff11ed1bd0a487896a06eb72052e89e190 | 6429 | **1790158153** | **2026-09-23T17:29:13+0800** | **manifest.json.bak** |
| ae91332238369f00f5c5747596a020f59e8594c7e03f8647819e688897cff8ca | 24265 | 1789757629 | 2026-09-19T02:53:49+0800 | mobile-app.md |
| 8cdb47d0999b4d375a9a3d5f13b0bdca41aa095b3c41ec2ae5fcff35c064b0b9 | 30604 | 1789740633 | 2026-09-18T22:10:33+0800 | web-fullstack.md |

## 资源目录关键观察

- **CHANGELOG.md / README.md / check_env.sh / driver-skeleton.{cjs,py}** 的 mtime 落在 2026-09-20 14:13–15:03 区间，对应 Task4 v3.0 / L2 修订时间窗。
- **02-Spike实验协议.md / 六品类 md** 的 mtime 更早（2026-09-18~09-19），是 L3 / 模板改进批的产出。
- **manifest.json 与 manifest.json.bak** mtime 同为 1790158153（2026-09-23 17:29 GMT+8，今天）：
  - **不在原 L3/L2/Task4 修订时间窗内**；
  - 同时存在 `.bak` 备份（未跟踪）；
  - 提示：今天有人刷新过 manifest（Task 5/10 后续接力或调试痕迹），但 git status 不显示此修改 → **manifest.json 不在 working tree 改动列表中**。

## 主进程代码

| sha256 | size | mtime (epoch) | mtime (ISO) | file |
|---|---|---|---|---|
| 91815473c3efa904d123e8cb04def9aa4a782d93a2ead4adaec061fd0ace45a6 | 8140 | 1789972790 | 2026-09-21T14:39:50+0800 | apps/electron/package.json |
| cffde9a735220e855a0c3f09f1a77817d2eca63b9c49609bf6f0577df1258d7c | 6619 | 1789378732 | 2026-09-14T18:38:52+0800 | apps/electron/electron-builder.yml |
| be22d78651c69582b63791cf64caea4a6da867529c1084d7536111cf029c305e | 5755 | 1789883300 | 2026-09-20T13:48:20+0800 | apps/electron/scripts/verify-engineering-resources.ts |
| 1f62fa2adc2a728f8ba4eb49070c6e7cb1332e8017f3fab91c25a754d84f0ab7 | 44381 | 1789887229 | 2026-09-20T14:53:49+0800 | apps/electron/src/main/lib/nanju-engineering-template.ts |
| 0e87058ee8af642be28614ffca76c7d3d49e9cf90ee3c8d4c73754ab85c47408 | 53495 | 1789887853 | 2026-09-20T15:04:13+0800 | apps/electron/src/main/lib/nanju-engineering-template.test.ts |
| de9c961e8002488e87d4534e844e689f0ccd1dbf84c0bf93955181282f44b4be | 35796 | 1789887307 | 2026-09-20T14:55:07+0800 | apps/electron/src/main/lib/nanju-engineering-resources.ts |
| c4671701cdc0584d8b29ab50e83f2b133ca554ef64d880af9e4b0933361d09bc | 30006 | 1789887087 | 2026-09-20T14:51:27+0800 | apps/electron/src/main/lib/nanju-engineering-resources.test.ts |
| 8837946044b9c759e14a847fbb1bdadec7b06f1b25950b199d5be81ff5810a00 | 13741 | **1790158182** | **2026-09-23T17:29:42+0800** | **nanju-env-probe.ts** |
| ea98d4aa2a8abbed468925becedd5d564cca1aa6f6ffba78cf79ec740d0bde4b | 19871 | **1790158641** | **2026-09-23T17:37:21+0800** | **nanju-env-probe.test.ts** |
| 24a72d57ab625f20ca23147108682e88348fa4126fc0df584dd422269abc9fbc | 9982 | 1789887029 | 2026-09-20T14:50:29+0800 | nanju-delivery-view.ts |
| 80a082c77d5f3900882c361c3f59072b6308dbd5de4c9660ba593284c0093583 | 10846 | 1789887582 | 2026-09-20T14:59:42+0800 | nanju-delivery-view.test.ts |
| 4d537e57e349a71c827718a384311b7deb0fdca4a66579b4c271191b1a4f97c5 | 36942 | 1789972540 | 2026-09-21T14:35:40+0800 | nanju-ipc.ts |
| ca5e167e813396682744e3e3cbb335567f3ae4b6d25c160b7c747f6f6ae59601 | 138313 | 1789972540 | 2026-09-21T14:35:40+0800 | preload/index.ts |
| 6d9b16b49a1dc9e642a3e949a16b19524551e997e1d076d8b58308e6b2e8f35e | 14136 | **1790158440** | **2026-09-23T17:34:00+0800** | **DeliveryCard.tsx** |
| 5096a825efdc1dc86ce9fe402617be6a17ef466122fa92c102f5369f01e5bd4a | 5152 | 1789886782 | 2026-09-20T14:46:22+0800 | packages/shared/src/types/nanju-delivery.ts |
| 61d3a07c90cccd580ff377cda3bb4bfb1754eb2afece16aa75254e066c5fa2cf | 971 | 1789887497 | 2026-09-20T14:58:17+0800 | packages/shared/src/types/nanju-recovery.ts |
| 76b90cd15807c3786210d132fe5f18d4542a02957daf102cf6544156e27fdf5f | 498 | 1789972790 | 2026-09-21T14:39:50+0800 | packages/shared/package.json |

## 主进程代码关键观察

- **nanju-env-probe.ts / .test.ts / DeliveryCard.tsx** 的 mtime 在 2026-09-23 17:29–17:37 区间（今天下午）—— **这些是当前会话之前（<= 60 分钟前）刚被修改的**。
  - 但 `git status` 未将 `nanju-env-probe.ts` 标为已修改（其状态在 ` M`），所以今天有人提交过 `nanju-env-probe.ts` 但**已被 git checkout 重新写盘**（即工作树中 git 索引的版本与磁盘一致，但 mtime 变新鲜）。
  - 或者：这是 `git stash` 之后 `git stash pop` 导致 mtime 重置。
  - 或者：磁盘 `nanju-env-probe.ts` 是 2026-09-21 提交版本（git index 已写）的缓存被 reflog 重写。
- **`M` 状态**：`nanju-env-probe.ts` 在 `git status` 中显示为 ` M`（非 `M` 头部），意味着工作树有未提交的修改（差异在文件内容上）。
  - 但 baseline 显示 mtime 是今天下午 → 今天有人改后写盘但**改动未被提交**。
- **nanju-ipc.ts / preload/index.ts / packages/shared/package.json** 的 mtime 在 2026-09-21 14:35–14:39（后续集成接线）。

## 版本三方对照（v0.17.131 / 0.17.132 / 0.1.62 / 0.1.63）

| 文件 | 字段 | 磁盘值 | HEAD 值 | 备注 |
|---|---|---|---|---|
| apps/electron/package.json | version | **0.17.132** | 0.17.131 | 未提交 patch+1 |
| packages/shared/package.json | version | **0.1.63** | 0.1.62（待核） | 未提交 patch+1 |
| apps/electron/resources/nanju-engineering-templates/manifest.json | bundleVersion | **2.5.0** | — | 模板整包版本（非平台） |
| apps/electron/resources/nanju-engineering-templates/manifest.json | platformVersion | **task4-pending** | — | 不宣称已发布 |

- AGENTS.md 强制每次提交 patch+1；磁盘状态说明存在未提交累积改动；版本守不保证来自同一原子提交。
- platformVersion 仍为 `task4-pending`，与 audit-r2 / Task 4 v3.0 报告一致——未发布声明守住。

## CHANGELOG.md 是否同步审查（mtime 集合观察）

- CHANGELOG.md mtime 1789972790（2026-09-21 14:39:50）—— 这与 apps/electron/package.json 和 packages/shared/package.json 同步 mtime，提示当天有人把它们一起刷新。
- 注意 CHANGELOG.md 是工程模板自带的整包变更记录（`docs/reports/2026-09-20-phase1/execution/resources/report.md` §1.5 S-8 提到），不应与产品 release notes 混。
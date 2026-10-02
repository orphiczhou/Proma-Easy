# 部署准备报告 · 2026-09-28

> 用途：PromaEasy dev 实例下一次 pack+部署的**准备条件与步骤文档**。本文档为只读检查产物，检查时间 2026-09-28 23:28–23:40 GMT+8。**执行 pack/部署/重启前必须确认 E2E 工程已收尾、允许重启。**

## 一、检查结论摘要

| 检查项 | 结果 | 状态 |
| --- | --- | --- |
| 分支 / HEAD | `p1-quick-engineering` / `552e0593`（2026-09-28 21:56） | ✅ 符合预期 |
| 工作树 | 仅 `docs/reports/2026-09-25-phase1-e2e-desktop/监控记录.md` 有未提交修改（他人在维护），**无源码改动**，不影响 pack | ⚠️ 可接受 |
| 旧 pack 产物 `apps/electron/out` | **706M**（9/24 产物） | ⚠️ pack 前需删除 |
| `apps/electron/node_modules` | 309M（保留，不删） | ✅ |
| 根盘剩余 | **1.2G（98% 已用）** | 🔴 偏紧，见风险 R1 |
| electron-builder | **25.1.8**（`PATH=$HOME/.bun/bin:$PATH bunx electron-builder --version` 验证通过，bun 1.3.14） | ✅ |
| package.json version | 0.17.132（当前 dev 运行的 UA 也是 0.17.132；pack 前如需区分备份建议 bump 到 0.17.133 或依赖时间戳命名） | ℹ️ |
| 当前部署 asar mtime | **2026-09-26 19:09:57**（204406978 字节 ≈ 195MB） | ℹ️ |
| 部署落后 commit 数 | **4 个**（`git log --since='2026-09-26 19:09:57'`）：`4744fe13` docs、`379e0228` docs、**`4b33a135` P0' 代码修复**、`552e0593` docs。**实质代码变更只有 4b33a135**，涉及 `ipc.ts`、`agent-orchestrator.ts`、`nanju-telemetry.ts`、新增 `agent-orchestrator-continuation-channel.test.ts` | ℹ️ |
| 部署基线 | 当前 asar 对应 commit `cbebe951`（P1 修复，9/26 19:09 前最后一个 commit） | ℹ️ |
| afterPack 门禁 | `scripts/after-pack-verify-resources.cjs` 存在（9/24 修复版），排序为 `(a.path < b.path ? -1 : ...)` 码元比较，排序漂移问题已修复 | ✅ |
| dev 实例 | PID 3262632 运行 2 天 4 小时，CDP 9224 正常响应（Electron 43.2.0 / Proma-dev 0.17.132） | ✅ 勿动 |
| start-dev.sh | `/home/orphic/proma-easy/dev/start-dev.sh` 存在且可执行（2946 字节） | ✅ |
| agent-sessions.json | `/home/orphic/.proma/agent-sessions.json`（2.3MB，活跃写入中） | ✅ |

## 二、前置条件清单（pack 前逐项确认）

1. [ ] **E2E 工程已收尾，用户/调度员明确允许重启 dev 实例**（重启会打断 PID 3262632 上的 E2E）。
2. [ ] **磁盘腾挪**：`rm -rf /home/orphic/proma-patches/p1-quick-engineering/apps/electron/out`（释放 706M）。执行前 `df -h /` 复核；若清理后仍 <1.5G 可用，先协调另一子会话的清理完成（pack 中途磁盘满会导致 asar 损坏）。
3. [ ] `cd /home/orphic/proma-patches/p1-quick-engineering && git log --oneline -1` 确认 HEAD 仍为预期 commit（不假定不变）。
4. [ ] PATH 含 bun：`export PATH=$HOME/.bun/bin:$PATH`。
5. [ ]（可选）`git status --short` 记录当时工作树状态；源码区必须干净。

## 三、pack 步骤（在源码机执行）

```bash
export PATH=$HOME/.bun/bin:$PATH
cd /home/orphic/proma-patches/p1-quick-engineering/apps/electron
rm -rf out                     # 释放 706M 旧产物
bun run pack                   # = build(esbuild+vite) → sync:runtime-deps → electron-builder --dir
```

- 预期产物：`out/linux-unpacked/proma`（约 220MB）+ `out/linux-unpacked/resources/app.asar` + 同步的 extraResources（`bin`、`default-skills`、`nanju-engineering-templates`、`nanju-model-config.json`、`proma-logos`、`startup-splash`、`tutorial.md`、`icon.png`）。
- afterPack 门禁（`after-pack-verify-resources.cjs`）会校验 extraResources 真实落位；失败即中止，属预期行为，按报错修复后重跑。
- 建议全程 tee 日志归档到 `docs/reports/2026-09-25-phase1-e2e-desktop/pack-20260928.log`。

## 四、部署步骤（停机窗口内执行）

历史成功流程，备份命名沿用现有规律 `app.asar.bak-v{version}-{YYYYMMDD-HHMM}`（部署目录现有 19 个 .bak，均为此格式）：

```bash
# 1. 先停实例（确认 E2E 已收尾才允许）
#    记录当前 PID，优雅退出优先：常规 kill，勿 -9 优先
OLD_PID=$(pgrep -f 'proma-dev --remote-debugging-port=9224')

# 2. 备份当前 asar + unpacked（版本号按 package.json 实际 version）
R=/home/orphic/proma-easy/dev/app/resources
cp -a $R/app.asar $R/app.asar.bak-v0.17.132-$(date +%Y%m%d-%H%M)
cp -a $R/app.asar.unpacked $R/app.asar.unpacked.bak-$(date +%Y%m%d-%H%M)   # 可选，占空间较大

# 3. 替换 asar 与 extraResources
S=/home/orphic/proma-patches/p1-quick-engineering/apps/electron/out/linux-unpacked/resources
cp $S/app.asar $R/app.asar
cp -a $S/nanju-engineering-templates $R/
cp -a $S/nanju-model-config.json $R/
# 其余 extraResources 若本次有变更同样同步：bin default-skills proma-logos startup-splash tutorial.md icon.png

# 4. 重启（历史成功命令）
cd /home/orphic/proma-easy/dev && DISPLAY=:12.0 nohup ./start-dev.sh > /dev/null 2>&1 &
```

## 五、验证清单（重启后逐项执行）

1. **进程与 CDP**：`pgrep -f 'remote-debugging-port=9224'` 有新 PID；`curl -s http://127.0.0.1:9224/json/version` 返回 JSON 且 UA 中版本正确。
2. **channelId 回填验证（本次修复的核心验收）**：在 dev 窗口向**调度员会话**发送一条 UI 消息，然后：
   ```bash
   python3 - <<'EOF'
   import json
   with open('/home/orphic/.proma/agent-sessions.json') as f: data = json.load(f)
   # 找到调度员会话，检查 meta.channelId 是否已回填（4b33a135 修复：首条消息回填 channelId）
   # 同时确认 continuation 不再报 channel-missing 遥测
   EOF
   ```
   判定：该会话 meta 中出现 `channelId` 且无 `continuation.channel-missing` 遥测 → 修复生效。
3. **遥测检查**：观察日志/遥测输出确认无新增报错。
4. **extraResources 落位**：`ls $R/nanju-engineering-templates` 与源码 `resources/nanju-engineering-templates` 一致；`diff <(md5sum ...) ` 抽查关键文件。

## 六、回滚方案

```bash
# 停实例（同上）
R=/home/orphic/proma-easy/dev/app/resources
cp -a $R/app.asar.bak-v0.17.132-{备份时刻时间戳} $R/app.asar    # 替换回备份
# 如同步过 extraResources，对应目录从 app.asar.unpacked.bak-* 或再上一版备份恢复
cd /home/orphic/proma-easy/dev && DISPLAY=:12.0 nohup ./start-dev.sh > /dev/null 2>&1 &
# 重跑第五节验证清单 1、4
```

回滚只恢复 asar/extraResources，**不回滚 git**（源码无写操作）。

## 七、风险项

| # | 风险 | 缓解 |
| --- | --- | --- |
| R1 | 根盘仅剩 1.2G（98%）。pack 过程 build+sync 临时膨胀，另有一子会话正在清理磁盘，存在竞争 | pack 前删 out（+706M），复查 `df -h` ≥1.5G 再开始；与清理会话错峰 |
| R2 | 重启打断运行 2 天的 E2E 工程（PID 3262632） | 硬性前置：E2E 收尾 + 调度员明确放行后才执行第四步 |
| R3 | 工作树有一份他人在改的 docs 文件（监控记录.md），属正常协作，但 pack 前若该文件被 git 操作波及需重新核对 HEAD | pack 前重跑 `git log --oneline -1` |
| R4 | 版本号仍为 0.17.132，与当前运行实例同号，肉眼难分辨新旧 asar | 部署后用 `stat` mtime + 字节数区分；或 pack 前 bump version |
| R5 | 备份已累积 19 个 .bak（约 3.9G resources 目录），部署目录磁盘压力 | 回滚验证通过后，由用户决定是否清理最旧备份（不在本次范围） |
| R6 | 4b33a135 为唯一实质代码变更但含 IPC/orchestrator 改动，重启后首条消息行为变化 | 严格执行第五节第 2 项 channelId 回填验证，异常即走回滚 |

## 八、本次检查执行的只读命令记录

`git log --oneline -5`、`git status --short`、`git branch --show-current`、`git log --since/--until --oneline --name-only`、`du -sh out node_modules`、`df -h /`、`bunx electron-builder --version`、`bun --version`、读 `package.json` / `electron-builder.yml`、`grep after-pack-verify-resources.cjs`、`stat app.asar`、`ls resources/ 部署目录`、`ps -p 3262632`、`curl CDP /json/version`、`ls start-dev.sh`、`ls agent-sessions.json`。无任何写/删/构建/重启操作（本报告文件除外）。

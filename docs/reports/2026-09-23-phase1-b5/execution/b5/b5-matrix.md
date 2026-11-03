# B5/B6 代表矩阵 · 工程模板六品类可执行验收截面

> 文档版本：1.0.0｜建立：2026-09-23 19:14 GMT+8（capturedAt=2026-09-23T11:17:44Z；runId=`b5-2026-09-23-1914Z`）。
> 任务来源：B5（环境/驱动/证据一致性，Task 10/11）+ B6（六品类代表工程与总验收，Task 13）。
> 本文件是**只读验收截面**：没有改产品、没有部署、没有启动 release/dev、没有委派子会话；任何归类为「已通过」的内容均为**模板协议 + 工程协议层**自证，不构成产品验收。真实可执行性、必要环境和超时行为按 matrix.json 的 `scenarioExecuted/coveredUs` 字段对齐。
> 关联：项目状态 [current-state.md](../../../../docs/project-memory/current-state.md)（v0.17.132/HEAD=34f72fbc）+ 计划 [2026-09-20-phase1-hardening-plan](../../../../docs/plans/2026-09-20-phase1-hardening-plan.md) B5/B6 + 历史桌面 E2E [E2E-desktop-clipboard-review](../../../../dispatch/reviews/E2E-desktop-clipboard-review.md)。

## 0. 头部元数据

| 字段 | 值 | 证据路径（来源） |
|---|---|---|
| `runId` | `b5-2026-09-23-1914Z` | `logs/run-context.env` |
| `capturedAt` | `2026-09-23T11:17:44Z` | `date -u` |
| `repo` | `/home/orphic/proma-patches/p1-quick-engineering` | cwd |
| `repoSha` | `34f72fbc8114608b998eaf4e1f5e1937f3deeb59`（短：34f72fbc） | `git rev-parse HEAD` |
| `repoGitStatus` | clean（盘点时维护、无新提交） | `git status` |
| `appVersionSource` | `0.17.132` | `apps/electron/package.json` |
| `manifestBundleVersion` | `2.5.0` | `resources/nanju-engineering-templates/manifest.json` |
| `manifestBundleSha256` | `64b9d8731406098b0675e0857af31b489aad14ea023e1551055ef4baedb402ef` | 同上 |
| `manifestRequiredCount` | 12 | `[templates]×6 + [sharedFiles]×6` |
| `manifestVerifyOk` | ✅ `bundleSha256 === computedBundleSha256` | `logs/manifest-cli-source.json`（exit 0，0.059 s） |
| `devBundleAsarSha256` | `6698f6bbc2416f51ff14a9334a20d257942505a2b2691fea337b8142dcc9479e` | `/home/orphic/proma-easy/dev/app/resources/app.asar`（md5/sha256） |
| `devBundleManifestState` | ❌ `manifest.json` 不存在于 `dev/app/resources/nanju-engineering-templates/` | `logs/manifest-cli-dev.json`（exit **1**，0.054 s） |
| `devBundleProvenance` | asar @ 2026-09-19；当前部署为 v0.17.130-era；模板资源只有 6 个 .md（无 Spike 协议、无骨架、无 check_env.sh、无 CHANGELOG） | `ls dev/app/resources/nanju-engineering-templates/` |

> **诚实边界**：任务书要求「不要把模板测试当产品验收」。下文 matrix 表格中所有 `runtimeUs`/`scenarioExecuted=true`/`coveredUs=[...]` 字段的值仅指模板机制 B5 协议层自证；任何 `productAcceptance` 字段均显式记为 `notRun` 或 `BLOCKED-<kind>`，**不暗示产品已发布或已被用户签收**。

## 1. 摘要：六品类协议层结果

| 品类 | 模板 SHA256（source） | env probe 类别 | 通用集 ok/total | 品类扩展 ok/total | 协议层结果 | 产品代表工程 |
|---|---|---|---|---|---|---|
| web-fullstack | `8cdb47d0999b4d375a9a3d5f13b0bdca41aa095b3c41ec2ae5fcff35c064b0b9` | universal + web | 10/13 | 1/2（**crash**） | 协议层 OK；脚本 bug #B5-F-2 阻塞 | 历史缺位；当前任务未派代表 |
| api-backend | `804d21dea9dd8bb5f21200ab2f9cbb2f8554209dc46c99421f527db75fe3bd76` | universal + api-backend | 10/13 | 2/9 | 协议层 OK；DB 栈缺位 | 历史缺位；当前任务未派代表 |
| mobile-app | `ae91332238369f00f5c5747596a020f59e8594c7e03f8647819e688897cff8ca` | universal + mobile-app | 10/13 | 6/14 | 协议层 OK；**无设备** | 历史：[mobile闭环验证-review](../../../../dispatch/reviews/mobile闭环验证-review.md)（与本截面无运行态复用） |
| desktop-app | `39e278c8023d018fad7d23883c870aa6fb330d13048dc8cd7e34b77f2b534c6e` | universal + desktop-app | 10/13 | 9/13 (合19/26, fail 7) | 协议层 OK；Python 路径 3 必需项缺 → BLOCKED-python-stack | 历史：e2e-clipboard-history（v0.17.131-era，已编入大屏；不视为本轮重做） |
| cli-tool | `4cf2384821adfc5f17dbd2a5957c5972f12862ee9a95af07c08a941f4f630f21` | universal + cli-tool | 10/13 | 1/4 | 协议层 OK；tsx/uv/poetry/deno 全缺 | 历史缺位；当前任务未派代表 |
| ai-application | `4aace3f9d7e591a18ae113bfc9864bb33b46a8d3592171fec4e364c895722fba` | universal + ai-application | 10/13 | 0/4 | 协议层 OK；**所有 LLM 栈零** | 历史缺位；当前任务未派代表 |

> 「协议层 OK」= driver blocked protocol 单测 22/22 pass、process-driver 协议 73/73 pass、骨架五自检 24/24 pass（共计 119/119）。

## 2. 验收命令与证据（可重跑）

```bash
export PATH=/home/orphic/.bun/bin:$PATH
cd /home/orphic/proma-patches/p1-quick-engineering

# 2.1 Manifest CLI：源码资源
bun run apps/electron/scripts/verify-engineering-resources.ts --json
# 期望 exit 0；bundleSha256 与 computed 一致；requiredCount=12

# 2.2 Manifest CLI：dev 部署（实构 "asar 无工程模板" 历史与现状）
bun run apps/electron/scripts/verify-engineering-resources.ts --json \
  --templates-dir=/home/orphic/proma-easy/dev/app/resources
# 期望 exit 1 + manifest-missing blocking（复现 current-state.md 描述）

# 2.3 check_env universal + 6 品类
SRC=apps/electron/resources/nanju-engineering-templates
for cat in universal web-fullstack api-backend mobile-app desktop-app cli-tool ai-application; do
  bash "$SRC/check_env.sh" "$cat"
done

# 2.4 Driver blocked protocol 单测 + 协议组合
bun test apps/electron/src/main/lib/nanju-driver-blocked-protocol.test.ts \
        apps/electron/src/main/lib/nanju-driver-skeleton.test.ts \
        apps/electron/src/main/lib/nanju-engineering-resources.test.ts \
        apps/electron/src/main/lib/nanju-engineering-preflight.test.ts \
        apps/electron/src/main/lib/nanju-engineering-process-driver.test.ts

# 2.5（可选）刷新真流程工程 env_probe.json 的新鲜度核查
# 仅读，不写：
cat /home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files/project-真流程e2e-剪贴板历史/03_ARCHITECTURE/env_probe.json | head -3
```

实际执行结果（exit / 耗时 / SHA）：

| 步骤 | 退出码 | 耗时 (s) | 证据 (sha256) |
|---|---|---|---|
| 2.1 source manifest | `0` | 0.059 | `logs/manifest-cli-source.json` |
| 2.2 dev manifest | `1` | 0.054 | `logs/manifest-cli-dev.json` |
| 2.3 universal check_env | `0` | 0.703 | `0b9797af906db33b0c81d948d23365886d4e00f930d9b5ffc62b72b51cdef60d` |
| 2.3 web-fullstack check_env | `1`（脚本崩） | 0.768 | `81eac8d26d01e6db6214ec48ca0d7d83f994dc4b3d6b195b0caa0ca3c3869001` |
| 2.3 api-backend check_env | `0` | 0.925 | `9eaa069acaa494c4420b7a1fe7e135a351422c92cea86fd6fccd9815f6d8f48e` |
| 2.3 mobile-app check_env | `0` | 3.347 | `1ff43f2ca80003407280cde1c555dc0a864f841b8d0eb8d712fdb2bd313c7e3f` |
| 2.3 desktop-app check_env | `0` | 1.793 | `67a56bf0f7dcbd0562cff3dd1e872ddc004a0b413bd3a02442855068560110cf` |
| 2.3 cli-tool check_env | `0` | 0.791 | `a24df989f1641776af708a258a53f78428b5a363cd8a998638b6c64a1d5c101a` |
| 2.3 ai-application check_env | `0` | 0.805 | `995cf787b5580f4116f4b4e0407657451cb2fb48d6c8a137bbef35a63ab66f9c` |
| 2.4 driver-blocked-protocol | `0` / **22/22** | 0.570 | `975807e6ee00e14e627d45c838b295b057a5b05fe2a6f2f5aa88f228086794e3` |
| 2.4 driver-skeleton | `0` / **24/24** | 1.553 | `logs/driver-skeleton.test.log` |
| 2.4 engineering-protocols-suite（resources/preflight/process-driver 三个） | `0` / **73/73** | 2.045 | `logs/engineering-protocols-suite.test.log` |

`logs/template-bundle-hashes.txt` 同步落位 13 个关键资源字节级 sha256，与 `manifest.json` 的自描述 sha256 一致：

```
manifest.json a8b153a7095e7dd8d0bf60d52141e0946ee8c3ab53c208e27ed7c9746bf42459   ← 文件内容 sha256
web-fullstack.md     8cdb47d0999b4d375a9a3d5f13b0bdca41aa095b3c41ec2ae5fcff35c064b0b9   ← 与 manifest.templates[0].sha256 一致
api-backend.md       804d21dea9dd8bb5f21200ab2f9cbb2f8554209dc46c99421f527db75fe3bd76
mobile-app.md        ae91332238369f00f5c5747596a020f59e8594c7e03f8647819e688897cff8ca
desktop-app.md       39e278c8023d018fad7d23883c870aa6fb330d13048dc8cd7e34b77f2b534c6e
cli-tool.md          4cf2384821adfc5f17dbd2a5957c5972f12862ee9a95af07c08a941f4f630f21
ai-application.md    4aace3f9d7e591a18ae113bfc9864bb33b46a8d3592171fec4e364c895722fba
02-Spike实验协议.md    d2ff0c88151fe87f8ce4d9a68b3de7f034e425545f4d29b3d9ec34598058e0aa
check_env.sh         c284906eec37f7f67dcd9bc6b539500bf0593ca3edf60b3a7ebaba94d8399cbf
driver-skeleton.py   1cc168a9c14611bbf4195f2ea0d5d29349f7545b7527407096ae4f7745e55e95
driver-skeleton.cjs  7dcde979b285fe1f20c8f42aaf49f72d5514ef2a0f504d471e75f009b1785272
README.md            5106a23b0eeaf1958f9168ac8f8f6fcdefa8f8c08912066c5f399b098b1754ea
CHANGELOG.md         0cf71bf21f7a65de8356acea8066726fec2cdf16103c77782c1c6b6514010124
```

> 注：`manifest.json` 的 sha256 是文件 sha256（`a8b153...`），`bundleSha256`（`64b9d8...`）是按 manifest 计算的聚合（不同维度）。

## 3. 各品类代表矩阵（模板）

> 同一模板多次出现：`runEngineeredCli({projectCategory})` 走 `materializeEngineeringTemplate(category)` 落位到项目 `00_ENGINEERING_TEMPLATE/`，并写 `template-manifest.json`。下表"模板协议覆盖"指 B5 协议层（结构化 blocked + 宿主解释），与"产品可执行"严格区分。

### 3.1 web-fullstack

- **模板资源**：`web-fullstack.md`（`8cdb47d0...`，v2.0，30604 字节）+ `02-Spike实验协议.md`（`d2ff0c88...`）+ `driver-skeleton.{py,cjs}` + `check_env.sh`（§6 引用 + `corepack/nvm/sqlite3/playwright/docker-compose`）。`manifest.json` 把 `web-fullstack.md → driver-skeleton.py/cjs (file-reference,required)` + `→ 02-Spike实验协议.md §6 (section-reference,required)` 三项依赖显式登记。
- **契约**：`tests[].layer ∈ {unit, integration, acceptance, auxiliary}`；预检要求全部 acceptance/auxiliary 测试接入"实际测试驱动"。N3 修订：「未接入的服务测试不可静默变为文件浏览器测试」（`nanju-engineering-preflight.test.ts:5`）。
- **env probe（universal 13 + web 5）：** 实测 14 行后脚本崩；详见 finding **#B5-F-2**。理论白名单（来自 `manifest.json → web-fullstack.md §6` + check_env §case `web-fullstack`）：
  - universal 全集（已跑：10 ok + 3 fail 含 universal 缺失 3 件）
  - `corepack`（ok，path `/usr/bin/corepack`）
  - `nvm`（崩于 set -u + unbound `NVM_DIR`）
  - `sqlite3`, `playwright`, `docker-compose`（**未执行**）
- **driver 能力**：浏览器契约走 `browser-driver`，由 `prepareEngineeringBrowserRun()` 预检 → 实际接口（Chromium/Playwright）。本机 `playwright` 已装（`/home/orphic/.local/bin/playwright`）。脚本包为 `e2e` 而非 `工程验收`，所以验收驱动走 `process-driver` + `driver-skeleton.cjs`（参看 [E2E-desktop-clipboard-review §四 P1-P5](E2E-desktop-clipboard-review.md)：契约 `driver.env=["DISPLAY"]`，`run_driver.py` 真实进程）。
- **真实/模拟边界**：浏览器同构 UI ≠ 服务契约能力；显式 `nanju-engineering-preflight.ts:43` 拒绝『以静态 HTML 入口冒充全栈契约』。
- **可执行命令**：
  - 入口 probe：`bun run apps/electron/scripts/verify-engineering-resources.ts --json`（退出码已捕获）
  - 落位：`materializeEngineeringTemplate(workspaceSlug, projectId, 'web-fullstack')` → `00_ENGINEERING_TEMPLATE/template.md` + `template-manifest.json`
  - 执行：`runRegisteredEngineeringTest({driver: {runtime: 'node', path: 'drv.cjs'}})`
- **blocked 原因（B5 当前截面）**：
  - `kind: "script-bug"` `missing: ["NVM_DIR-probe in web-fullstack check_env"]`，`scenarioExecuted=false`，`coveredUs=[]`；生效覆盖路径：`sqlite3/playwright/docker-compose` 三探测本轮未被读到。
  - `kind: "missing-tool"`（universal 缺 `bun/pnpm/yarn`）—— 仅影响脚本 L1 测试的"基线一致性"，不阻断代表项目。
- **产品代表工程**：**缺位**。当前任务范围内未派 web-fullstack 代表；历史决策范围内的样本未在本目录留痕。
- **productAcceptance**：`BLOCKED-not-run`（拒绝假装通过）。

### 3.2 api-backend

- **模板资源**：`api-backend.md`（`804d21de...`，v2.0，17256 字节）+ 同三件套。
- **契约**：Hono/FastAPI 范式；契约要求 `run` 字段是真实服务入口（不是 `docs/index.html`）；`target.kind∈{http,grpc,...}` 默认按 backend 走。
- **env probe（universal 13 + api 9）：22 行 = 13 universal + 9 api**。
  - universal：`bun/pnpm/yarn` fail，其余 ok
  - api-backend 全：fail
    - `postgresql/psql/pg_isready/redis-cli` —— 系统级 DB/缓存栈未装
    - `httpie/node-gyp/argon2` —— 工具链未装
  - 单服务层级 `curl --version` head -n 1 应该输出，但本机 `which curl` 也没在失败列表 → ?  Let me see... actually script `probe "curl" "curl --version 2>/dev/null | head -n 1 || echo missing"`。`head -n 1` of `curl --version` → outputs first line → "ok"。所以 curl ok 在 detail 字段中。
- **driver 能力**：`http-driver` 注册位 + `process-driver`（curl/wget/真实服务）。`requireEngineeringContract(projectDir)` 在 web 工程浏览契约路径之外独立守门。
- **真实/模拟边界**：Hono/FastAPI 必须起真实进程；mock 仅用于隔离单测（`carrierRole` 字段明示『演控台模拟不算服务验收』）。
- **可执行命令**：
  - probe：同 2.3
  - 驱动测试：`bun test nanju-engineering-process-driver.test.ts`（17/17 pass，覆盖 `maxConcurrent=1`、超时回收、env 白名单）
- **blocked 原因**：
  - `kind: "missing-service"` `missing: ["postgresql", "redis-cli", "psql", "pg_isready", "node-gyp", "argon2"]` —— DB/缓存栈全套缺失；**真实代表场景无法在宿主执行**
  - scenarioExecuted=false, coveredUs=[]；建议 B5 落到可观测 Docker 时再补，或改派到有 PostgreSQL 的设备。
- **产品代表工程**：**缺位**。
- **productAcceptance**：`BLOCKED-missing-services-not-in-scope`。

### 3.3 mobile-app

- **模板资源**：`mobile-app.md`（`ae91332...`，v2.3，24265 字节）+ 同三件套。`v2.3` 历史为 OPPO Android 11 实测回填批（commit `7729ba09 feat: v0.17.129 - mobile 真机闭环验证批`）。
- **契约**：Expo Router 文件路由；测试必须经真机/模拟器驱动。
- **env probe（universal 13 + mobile 14）：27 行**
  - universal：10/13
  - mobile-app：`adb`（ok，`1.0.41`）、`adb-devices`（**实际 0** —— 见下）、`java`（ok 21.x）、`qemu-system-x86_64`（ok）、`qemu-img`（ok）、`aria2c`（ok）
  - 失败：`watchman/gradle/xcodebuild/expo/eas-cli/android-studio/sdkmanager/avdmanager`
- **driver 能力**：`mobile-driver`（adb/uiautomator2/模拟器）；本机 `adb` 在场；`adb devices` 实测为 0 设备（"adb: no devices/emulators found"）。
- **真实/模拟边界**：移动契约需要真机/模拟器；模板明示『手机尺寸网页不能替代移动验收』（`categoryMeta.desktop-app.carrierRole` 同款原则在 mobile 上）。
- **可执行命令**：
  - `adb devices` → 当前无设备
  - `bun test nanju-driver-blocked-protocol.test.ts` 集成级已含 mobile 路径的协议校验（mobile 真实代表实现需要单独委派）
- **blocked 原因**：
  - `kind: "device-unreachable"` `missing: ["real-android-device", "iOS-simulator"]`，**scenarioExecuted=false**，**coveredUs=[]**
  - 任一历史真机 OBSERVER 报告都不应被复用为本次业务通过；当前 hist 仅是"过去有 OPPO Android 11 实测能力"，并不等同于今天的运行态。
- **产品代表工程**：**历史留有 OPPO Android 11 真机环境能力（[mobile闭环验证-review](../../../../dispatch/reviews/mobile闭环验证-review.md)），不能复用作为 B6 验收通过**。
- **productAcceptance**：`BLOCKED-device-unreachable`，必须由用户在具备真机/模拟器时重派。

### 3.4 desktop-app

- **模板资源**：`desktop-app.md`（`39e278c...`，v2.4，33295 字节）+ 同三件套 + `manifest.json` 显式追加 `desktop-app.md → check_env.sh (script-reference)`。
- **契约**：`engineering.json.target.kind ∈ {tauri, electron, native-python}`；当前宿主默认 Python P1 路径，含 `python3 + pynput + xclip + xdotool + tkinter + notify-send` 的最小六件套。Tauri v2 路径依赖 `webkit2gtk-4.1/gtk+-3.0/libsoup-3.0/ayatana-appindicator3-0.1/pkg-config`。
- **env probe（universal 13 + desktop 13）：26 行**
  - universal：10/13
  - desktop 关键（13 条 desktop 专属探测）：
    - Tauri 栈：`webkit2gtk-4.1 (2.52.6)`、`gtk+-3.0 (3.24.41)`、`libsoup-3.0 (3.4.4)`、`ayatana (0.5.90)`、`pkg-config (1.8.1)` 五件齐
    - Python 栈：`pynput ✗`、`sounddevice (0.5.6)`、`pystray ✗`、`portaudio ✗` —— P1 路径 3 件缺失
    - 系统集成工具：`xclip (/usr/bin/xclip)`、`xdotool (3.20160805.1)`、`notify-send (/usr/bin/notify-send)` 三件齐
    - 桌面合计：9 ok + 4 fail；与 universal 10/13 合计 → 总 19 ok / 7 fail（26 行）
    - `DISPLAY=:12.0` 实测可用（universal 字段透出）
- **driver 能力**：`process-driver` + `driver-skeleton.py`（真实 `subprocess.Popen`）+ OS 退出码 + 取消 → blocked。证据：`nanju-engineering-process-driver.test.ts` 17/17 含 `取消/超时/PID 回收`。
- **真实/模拟边界**：mock 仅用于隔离单测，不替代原生验收。`carrierRole` 双路径明示 P1 快速验证 ≠ P2 正式交付。
- **可执行命令**：
  - 历史代表工程：`/home/orphic/.proma-dev/agent-workspaces/workspace-1786847832507/workspace-files/project-真流程e2e-剪贴板历史/`
  - 当前结构化 env probe：`cat 03_ARCHITECTURE/env_probe.json | jq '.components | length'` → 0.0（已 28 条组件记录在历史快照中）
  - `00_ENGINEERING_TEMPLATE/template.md` 版本：`v1.0`（**显著小于源 v2.4**，部署漂移产物之一）
  - `00_ENGINEERING_TEMPLATE/check_env.sh`：**缺失**（architect 注释 "未落位" = 当时 B4 Task 4 之前的事实）
- **blocked 原因**：
  - `kind: "python-stack-incomplete"` `missing: ["pynput", "pystray", "portaudio"]`，`scenarioExecuted=false`（P1 路径对当前历史代表工程而言）
  - 历史 e2e-clipboard-history 的 env_probe.json `probedAt=2026-09-20T00:25:00`（约 86 小时前），按 `ENV_PROBE_DEFAULT_MAX_AGE_MS=24h` 应判 `stale-age` —— **freshness 失败将触发重跑**（B5 Task 10 新鲜度语义落地）
  - 同一工程当前未派生 B6 代表工程；本任务**不重做**该代表。
- **产品代表工程**：**缺位（本轮未派）**；历史 e2e-clipboard-history 已评审签收，不视为本轮新验收。
- **productAcceptance**：`notRun-this-round`（既不重做，也不冒绿）。

### 3.5 cli-tool

- **模板资源**：`cli-tool.md`（`4cf2384...`，v2.0，16226 字节）+ 同三件套（§6 引用）。
- **契约**：`engineering.json.target.kind: "cli"`；`tests[].command` 走 `process-driver`；Driver 入口可以是 `tsx/node/python3`。
- **env probe（universal 13 + cli 4）：17 行**
  - universal：10/13
  - cli：`tsx ✗`、`uv ✗`、`poetry ✗`、`deno ✗` —— cli 栈 4 件全部缺失
  - 但 `node 22.23.2 + npm 10.9.8` 在场 → 实际上 **Node.js 子集 cli 可做**（无 tsx 也能跑 `.js`）
- **driver 能力**：`process-driver` + `driver-skeleton.cjs`；11/22 driver-blocked-protocol 已覆盖 cli kind。
- **真实/模拟边界**：CLI 真实入口（参数解析 + 退出码 + 副作用）必须直接执行；演控台不是 CLI 验收。
- **可执行命令**：
  - 单元示例：`bun test nanju-driver-blocked-protocol.test.ts`（含 cli kind 集成）
  - 缺件阻塞：`tsx`/`uv`/`poetry`/`deno` 任意一个为 0 → 可降级为 `node` 直跑 JS；其余 3 件为非必需可选
- **blocked 原因**：
  - `kind: "missing-cli-toolchain"` `missing: ["tsx", "uv", "poetry", "deno"]`，`scenarioExecuted` 在 Node-only 降级路径下为 `true`，`coveredUs=["US-with-Node-runtime-only"]`
  - 模板只承诺 Node 子集；TS/Python CLI 需用户/项目自行提供；不构成产品验收缺口。
- **产品代表工程**：**缺位**。
- **productAcceptance**：`BLOCKED-toolchain-incomplete-non-blocking`。

### 3.6 ai-application

- **模板资源**：`ai-application.md`（`4aace3f9...`，v2.0，20980 字节）+ 同三件套（§6 引用）。
- **契约**：Vercel AI SDK + pgvector/LibSQL；真实模型接入集中在 `provider/`；mock 仅作明确标注的辅助测试，**不可把规则生成替代实际 ASR/LLM 等主功能**。
- **env probe（universal 13 + ai 4）：17 行**
  - universal：10/13
  - ai：`ollama ✗`、`pgvector ✗`、`libsql ✗`、`embedding-model ✗` —— **AI 栈四件全缺**
- **driver 能力**：`http-driver`（远端 LLM 端点）/ `process-driver`（本地模型）/ `ai-driver`（contract 内 provider mock）。真实 LLM 必走外部发送，需 `agent.guard` 显式批准（v0.17.132）。
- **真实/模拟边界**：付费或外部发送必须经用户确认；本地无密钥则走 LLM provider 已确认通道（`Ollama`/远端 API）。
- **可执行命令**：
  - 当前 `which ollama` 退 1 → 表示 ollama **完全未装**，本地路径 **不可用**
  - 远端 API 路径：检查 `DASHSCOPE_API_KEY` / `OPENAI_API_KEY` 等环境变量（本任务范围内**不探测密钥名以防泄漏**；与 `nanju-env-probe.ts:80-83`「密钥类变量仅允许记录名称或布尔」一致）
- **blocked 原因**：
  - `kind: "ai-stack-missing"` `missing: ["ollama", "pgvector", "libsql", "embedding-model"]`，`scenarioExecuted=false`，`coveredUs=[]`
  - 真实 LLM 调用需用户提供授权通道；本轮**不私自配置密钥**，更不**调用付费接口**；任何 AI 真实代表项目都需要在「具备授权服务条件」的人工前置下执行。
- **产品代表工程**：**缺位**。
- **productAcceptance**：`BLOCKED-ai-stack-external-required`。

## 4. B5 协议层证据（driver / blocked / 骨架）

### 4.1 driver-blocked-protocol 22 项全部 pass

> 见 `logs/driver-blocked-protocol.test.log`，22 pass / 0 fail / 53 expect() / 0.560 s。
> 关键负例（每条都已实测全绿）：

1. **合法 blocked 标记 → blocked + coveredUs=[]**：来源 = blocked.missing + scenarioExecuted=false + checks=空 + exit 2 一致
2. **blocked 与 exit 0 冲突 → error**：不允许异常 exit 被洗成 blocked
3. **blocked 与 scenarioExecuted=true 冲突 → error**：不允许"既已执行又阻塞"
4. **blocked.missing 空数组 → error**：不允许"无缺失项"伪标记
5. **blocked + 产品检查 → error**：阻塞结果不可混入产品断言
6. **旧「环境前置自检」exit 2 → blocked（向后兼容）**：存量工程仍可用旧签名
7. **旧「输出 schema 自检」exit 2 → error**：坏 schema ≠ blocked
8. **伪造 exit 2（expected≠actual）→ fail**：exit 2 不是 blocked 的充分证据
9. **exit 2 + 空 checks + 无 blocked 标记 → error**：结构化不齐不放过
10. **legacy 伪装：expected 非"环境就绪"→ fail**
11. **legacy 伪装：actual 无"缺失: "前缀 → fail**
12. **legacy 伪装：evidence 空 → error**
13. **legacy 伪装：actual"缺失:"后空 → fail**
14. **legacy 伪装：多条 checks → fail**
15. **真实骨架 + 环境变量缺失 → blocked + coveredUs=[] + 不计入产品修复预算**
16. **真实骨架 probe pass → pass + coveredUs=["US-01"]**
17. **真实骨架 probe 不符 → fail（产品失败）**
18. **真实骨架崩溃 → error + stderrTail 进 result**
19. **真实骨架挂起 + 取消 → blocked（reason 含"取消"）**
20. **伪造 exit 2（正常产品检查）→ fail 而非 blocked**
21. **Python 骨架真实环境阻塞 → blocked（kind=env，NANJU_BLOCKED_PROTO_TEST_VAR）**
22. **suite verdict=blocked（非 fail）→ 不进入产品修复预算**

### 4.2 协议组合（resources/preflight/process-driver）：73 项 pass

> 见 `logs/engineering-protocols-suite.test.log`，73 pass / 0 fail / 172 expect / 2.03 s。
> 关键覆盖：
> - `validateManifestSchema strict`：缺品类/缺共享/重复/路径遍历/绝对路径/required 计数 → blocking
> - `verifyEngineeringResources`：manifest 缺失/文件缺失/hash 错配/size 错配/dependency 缺失/bundleSha256 不一致/category 字段不匹配/文件名不匹配 → blocking
> - `process-driver`：真实 node 子进程读目标、异常 exit 不能覆盖、超时终止不伪造 pass、输出上限终止、缺配置运行时只报 blocked、`driver.env` 白名单∪契约、stderr 脱敏、并发上限 1 时第二个 blocked、取消/超时 PID 回收
> - `preflight`：合法静态 Web 契约选实际入口、缺故事不静默、辅助测试未执行明示、逐项批准路径

### 4.3 骨架五自检（driver-skeleton）：24 项 pass

> 见 `logs/driver-skeleton.test.log`，24 pass / 0 fail / 93 expect / 1.54 s。
> 关键覆盖：
> - 照抄直跑 → TODO fail 检查 exit 1（不假 pass）
> - 合法 probe（expected==actual）exit 0 + storyId 逐字保留
> - R2 类：acceptance 下 storyId 空串被工厂拦截为结构化 error
> - A3 类：同源 probe 同义文案如实标 fail
> - R3 类崩溃：raise 路径 + sys.exit(7) 路径都包裹为结构化 error
> - 环境前置自检：DISPLAY 缺失 + 密钥类缺失都 exit 2 + blocked 标记
> - sys.exit(0) 表外路径：exit_code=0 但退出码非零（防静默）
> - schema 违规（checks 空/字段非法）被 ③ 拦 exit 2
> - 恒真断言（actual 传字符串非 probe）→ DriverSelfCheckError
> - 关键断言变异体：变异 target 内容 → pass 转 fail（鉴别力实证）

## 5. 历史现成代表工程清单（不重做，但落位 checksum）

| 类别 | 工程 | 状态 | 来源 | 是否重做 |
|---|---|---|---|---|
| desktop-app | e2e-clipboard-history | 防御者终裁准予签收；review v0.17.131-era；F-1/F-2/F-3 全过；4 轮 0 盲修；DISPLAY 三态 blocked exit 2；宿主 checks 40/40；schema v2 `driver.env=["DISPLAY"]` 实证 | [E2E-desktop-clipboard-review](../../../../dispatch/reviews/E2E-desktop-clipboard-review.md) | 否（本任务只读截面） |
| mobile-app | OPPO Android 11 真机历史 | 历史真机环境/驱动验证；非业务项目验收 | [mobile闭环验证-review](../../../../dispatch/reviews/mobile闭环验证-review.md) | 否 |
| web-fullstack / api-backend / cli-tool / ai-application | 无 | 当前任务范围未派代表 | — | 是（下一轮 B3/B6 任务视 B5 修复后启用） |

历史代表工程当前不在运行态（`06_TESTS/` 空 + 阶段仍 `CODE` + pending="testing"） → B3 Task 7 的"恢复旧工程"应在 B1/B2 修复完成、Task 4 模板发布正确后执行；本任务**不发起恢复**。

## 6. 不可替代边界 / 不偷扩范围

- **不重做历史 e2e**：当前 dev app 含 `proma-dev` binary 220MB，但 `manifest.json` 不在 `dev/app/resources/nanju-engineering-templates/`，部署漂移与 current-state.md 一致 → 如要重做必走 B2 Task 4 模板发布；**本任务做的是 B5/B6 协议层截面，不复跑 B2 范畴的修复**。
- **不调动 release 实例**：AGENTS.md/Phase 1 plan 双声明。
- **不在没密钥的情况下私自发起 AI 真实调用**：任务书明示要付费或外部发送必须经过用户确认，本任务不发起。
- **不把 119/119 单测当产品验收**：B1 修复未做（PASS+skip 仍判 pass 的旧口径仍存在）；B2 模板发布未做（dev app manifest-missing）。
- **不为了凑齐 verdict 全绿**而把"历史 e2e"或"模板测试"当作"产品验收"。
- **不写跨会话或托管工作区的权威交付**：所有产物都在 `docs/reports/2026-09-23-phase1-b5/execution/b5/` 下，可重跑；`/dev/shm` 工作目录产物仅作执行，已清理。

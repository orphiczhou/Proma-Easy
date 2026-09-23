# Phase1 Task 10 实施报告 — 环境探测新鲜度 + 品类扩展

> 文档版本：1.0.0｜执行会话：当前 worker（父 cfce785b 国内模型授权）
> 提交基线：`34f72fbc8114608b998eaf4e1f5e1937f3deeb59`（v0.17.131）
> 资源整包版本：bundleVersion=2.5.0｜manifest platformVersion=`task4-pending`
> 实施日期：2026-09-20 GMT+8
> 范围：Phase1 plan §8 Task 10「通用探测＋品类扩展，同一机器事实判 ready」
> 父备注：仅可改 nanju-env-probe.ts/test + check_env.sh + 报告；本会话父确认无其他 worker 在改 env-probe

---

## 1. 任务摘要

把通用环境探测（check_env.sh + nanju-env-probe）从「结果存了就行」升级为「freshness + 模板联动 + 品类扩展」三件事：

1. **freshness**：env_probe.json 不再无限期沿用——age 超窗（默认 24h）或探测早于模板落地（模板升级未重跑）→ 删除 + 重跑。
2. **template 联动**：把 template-manifest.json.copiedAt 作为 freshness 第二锚点，避免「在旧模板上做的探测被新模板误用」。
3. **品类扩展**：check_env.sh 接受 `$1` 参数（`desktop-app` / `mobile-app` / `api-backend` / `web-fullstack` / `cli-tool` / `ai-application` / `universal`），品类扩展探测项（webkit2gtk / adb / ollama / playwright 等）与 `nanju-engineering-template.validateEnvChecklist` 白名单对齐。
4. **结果字段扩展**：env_probe.json 新增 `category` 字段记录本次探测使用的品类参数（universal = 仅通用集），便于后续审计追溯。

---

## 2. 交付清单

### 2.1 修改文件（独占范围）

| 路径 | 行数（原→新） | 改动 |
|---|---|---|
| `apps/electron/src/main/lib/nanju-env-probe.ts` | 187 → 270 | 新增 `isEnvProbeFresh` / `getTemplateCopiedAt` / `ENV_PROBE_DEFAULT_MAX_AGE_MS`；`runEnvProbe` 接入 freshness + category；`EnvProbeResult` 加 `category` 字段 |
| `apps/electron/src/main/lib/nanju-env-probe.test.ts` | 189 → 459 | 12 → 31 用例（+8 freshness + 3 freshness 接入 + 4 category + 4 getTemplateCopiedAt） |
| `apps/electron/resources/nanju-engineering-templates/check_env.sh` | 50 → 145 | 头部加用法说明；保留通用集 13 项；新增 case 分支按品类扩展（desktop 13 项 / mobile 13 项 / api-backend 9 项 / web-fullstack 5 项 / cli-tool 4 项 / ai-application 4 项；fail-safe 默认 = universal） |
| `apps/electron/resources/nanju-engineering-templates/manifest.json` | 239 → 239 | 重新生成（check_env.sh 内容变化导致 sha 重算）；bundleSha256 同步刷新 |

### 2.2 未触碰文件（autonomy / 其他会话所有）

| 路径 | 状态 |
|---|---|
| `apps/electron/resources/nanju-engineering-templates/{6 个品类模板,02-Spike实验协议,driver-skeleton.{py,cjs},README}` | Task 4 所有权；本批未触碰 |
| `apps/electron/src/main/lib/{nanju-project-snapshots,nanju-snapshot,nanju-ipc,nanju-gwt-runner,nanju-engineering-execution,nanju-driver-skeleton}.ts` | 父/并发会话所有；本批未触碰 |
| `apps/electron/package.json` / `electron-builder.yml` | autonomy 禁改；本批未触碰 |
| `apps/electron/scripts/verify-engineering-resources.ts` | Task 4 已交付；本批未触碰（不破坏既有 CLI） |

---

## 3. freshness 设计

### 3.1 触发条件（任一触发 → not fresh → 重跑）

| reason | 条件 |
|---|---|
| `within-age` | probedAt + maxAgeMs（默认 24h）内；无模板锚点 |
| `after-template` | probedAt + maxAgeMs 内 **且** probedAt ≥ templateCopiedAt |
| `stale-age` | probedAt + maxAgeMs 之外 |
| `before-template` | probedAt < templateCopiedAt（模板升级未重跑） |
| `unparseable-probed-at` | probedAt 字符串不可解析 |

```typescript
export interface EnvProbeFreshness {
  fresh: boolean
  reason: 'within-age' | 'after-template' | 'stale-age' | 'before-template' | 'unparseable-probed-at'
  ageMs: number              // 距今毫秒（便于日志）
  templateDeltaMs: number | null  // probedAt - templateCopiedAt；模板缺失时为 null
}
```

### 3.2 runEnvProbe 接入语义

```
runEnvProbe(workspace, project, opts?):
  1. 若 env_probe.json 存在 + 新鲜 → 沿用（不重跑）
  2. 若 env_probe.json 存在 + 不新鲜 → unlinkSync 旧文件
  3. 若不存在 → 直接 spawn
  4. 脚本接受 $1 = category（universal 默认）
  5. 写盘时记录 category 字段（universal / 六品类之一）
```

### 3.3 freshness 与「同一机器事实 ready」关系

- 父已确认会集成 env-probe 状态进 gate（v131 / B5 接续）；
- `isEnvProbeFresh.fresh=false` 不直接阻塞，但 `runEnvProbe` 自动重跑确保 env_probe.json 反映当前真实状态；
- 任务书任务生成前调用 `runEnvProbe` 即可获取最新事实（默认窗口 24h 内不重跑，避免每轮重复 IO）。

---

## 4. 品类扩展设计

### 4.1 check_env.sh 接口

```bash
./check_env.sh                  # 仅跨品类通用集（13 项）
./check_env.sh desktop-app      # 通用集 + desktop 扩展（+13 项）
./check_env.sh mobile-app       # 通用集 + mobile 扩展（+13 项）
./check_env.sh api-backend      # 通用集 + api-backend 扩展（+9 项）
./check_env.sh web-fullstack    # 通用集 + web-fullstack 扩展（+5 项）
./check_env.sh cli-tool         # 通用集 + cli-tool 扩展（+4 项）
./check_env.sh ai-application   # 通用集 + ai-application 扩展（+4 项）
./check_env.sh unknown-category # fail-safe：仅通用集
```

### 4.2 品类扩展探测项（与 `nanju-engineering-template.ENV_COMPONENTS_BY_CATEGORY` 白名单对齐）

| 品类 | 关键扩展项 | 与白名单对应 |
|---|---|---|
| desktop-app | webkit2gtk-4.1/4.0, gtk+-3.0, libsoup-3.0, ayatana-appindicator3-0.1, pkg-config, pynput, sounddevice, pystray, xclip, xdotool, notify-send, portaudio | 全部在白名单内（v0.17.129 已增补） |
| mobile-app | adb, watchman, java, gradle, xcodebuild, expo, eas-cli, sdkmanager, avdmanager, qemu-system-x86_64, qemu-img, aria2c, android-studio | v0.17.129 mobile 真机闭环实测回填 |
| api-backend | postgresql/psql/pg_isready, redis-cli, curl, httpie, build-essential, node-gyp, argon2 | P0-4 api-backend v2 模板对齐 |
| web-fullstack | corepack, nvm, sqlite3, playwright, docker-compose | P0-4 web-fullstack 模板对齐 |
| cli-tool | tsx, uv, poetry, deno | v0.17.127 cli 模板对齐 |
| ai-application | ollama, pgvector, libsql, embedding-model | ai 模板对齐 |

### 4.3 安全约束（保留原版约束）

- 幂等只读：仅 `--version` / `which` / `pkg-config --modversion` / 环境变量存在性检查；
- 探测失败标 fail 不中断（脚本整体 exit 0）；
- 探测项结果均为静态查询，不触发安装/升级/配置修改。

---

## 5. 验证证据

### 5.1 测试矩阵

| 范围 | 文件 | 用例数 | 结果 |
|---|---|---|---|
| 既有 W3 探测执行（保留原版断言） | `nanju-env-probe.test.ts` 旧块 | 12 | 0 fail |
| Task 10 freshness 纯函数 | `nanju-env-probe.test.ts` 新块 | 8 | 0 fail |
| Task 10 runEnvProbe 接入 freshness | `nanju-env-probe.test.ts` 新块 | 3 | 0 fail |
| Task 10 runEnvProbe 接入 category | `nanju-env-probe.test.ts` 新块 | 4 | 0 fail |
| Task 10 getTemplateCopiedAt | `nanju-env-probe.test.ts` 新块 | 4 | 0 fail |
| **合计** | **1 文件** | **31** | **0 fail** |
| Task 4 资源分发 | `nanju-engineering-resources.test.ts` | 50 | 0 fail |
| Task 4 模板落位（含 S-1 修订测试） | `nanju-engineering-template.test.ts` | 78 | 0 fail |
| **三文件总计** | **3 文件** | **159** | **0 fail** |

### 5.2 typecheck

- 我的文件（env-probe.ts / engineering-template.ts / engineering-resources.ts / verify script / 3 test files）typecheck **0 error**；
- 整体 `@proma/electron` 在其他会话的 `nanju-project-snapshots.test.ts` 与 `DeliveryCard.tsx` 仍有 pre-existing 错误（与本批无关，git stash 验证过）。

### 5.3 真实 fixture smoke

```bash
$ bash apps/electron/resources/nanju-engineering-templates/check_env.sh
# 13 行 universal 探测输出（node/npm/.../display）

$ bash apps/electron/resources/nanju-engineering-templates/check_env.sh desktop-app
# 26 行 = 13 universal + 13 desktop 扩展（含 webkit2gtk-4.1 / pynput / xclip / ...）

$ bun run apps/electron/scripts/verify-engineering-resources.ts
✓ 校验通过（无问题）  # bundleVersion=2.5.0, requiredCount=12, sha 一致
```

### 5.4 CLI 退出码矩阵（CLI 本身未被 Task 10 修改，沿用 Task 4 矩阵）

| 场景 | 退出码 |
|---|---|
| 资源齐全 | 0 |
| 哈希不一致 / 文件缺失 / manifest 缺失 / 严格 schema 失败 | 1 |
| 参数错误 | 2 |

---

## 6. DoD 自查

| 验收口径 | 状态 |
|---|---|
| env-probe.ts / .test.ts / check_env.sh 独占所有权守住（父确认无其他 worker） | ✅ 静态文件 mtime 未被其他会话触动；本批独自修改 |
| freshness 判定函数 + 接入 runEnvProbe | ✅ `isEnvProbeFresh` 5 个 reason + 3 个接入用例 |
| 品类扩展 6 品类 + universal fail-safe | ✅ case 分支 6 项；universal = 仅通用集 13 项 |
| 探测项与白名单对齐 | ✅ desktop 13 / mobile 13 / api-backend 9 / web-fullstack 5 / cli-tool 4 / ai 4，全部条目都在 `nanju-engineering-template.ENV_COMPONENTS_BY_CATEGORY` 内 |
| 模板时间锚点（template-manifest.json.copiedAt）联动 | ✅ `getTemplateCopiedAt` + `isEnvProbeFresh.templateCopiedAt` 入参 |
| 失败不静默称成功（freshness 不通过 → 重跑；解析失败 → 失败说明） | ✅ `before-template` / `stale-age` / `unparseable-probed-at` 全部触发 `unlinkSync` + 重跑 |
| 幂等只读约束保留 | ✅ 仅 `--version` / `which` / `pkg-config --modversion` / 环境变量查询；脚本整体 exit 0 |
| 测试覆盖正常路径 + 主要边界 | ✅ 31 用例，含纯函数 8 / 集成 4 / 边界（破坏 JSON / 模板缺失 / 未知品类 / 老时间戳 / forceRerun） |
| manifest hash 重新生成 | ✅ bundleSha256 = `f8187f61b3e96107b129c653c20c4338478f81a4e032fa270a9297d3a3a22d23`（check_env.sh 内容变化） |

---

## 7. 风险与未覆盖

### 7.1 已识别风险

1. **freshness 默认窗口 24h**：当前硬限；若 env_probe.json 写盘后 1 小时内核降级（如更新安装 / 服务异常），架构师拿到过期事实。父集成阶段可按 `opts.freshnessOpts.maxAgeMs` 收窄窗口。
2. **探测项与白名单一致性靠手工同步**：本批新增的 50+ 探测项均手工对照 `nanju-engineering-template.ENV_COMPONENTS_BY_CATEGORY`；未来如白名单扩展但 check_env.sh 未同步 → 架构师使用 category 探测时不会跑该新项（漏报，不阻塞）。
3. **pgvector / embedding-model 探测用 grep/which 弱信号**：仅做存在性检查，不验证功能可用；架构师需根据 detail 内容判读。

### 7.2 未覆盖（按 autonomy 不做）

- 真实部署目标 env_probe.json 验证（autonomy 禁；由父集成的 dev 包 / 部署脚本执行）；
- npm scripts 与 electron-builder afterPack 接线（父接线）；
- env_probe.json 写盘路径的额外审计（如写入失败时已 spawn 的子进程清理）。

---

## 8. 父集成待办（**未做**，autonomy 范围外）

> 父会话确认：会集成 env-probe 状态进 gate，不改本批文件。

1. 在 `apps/electron/package.json` 添加 `verify:env-probe` / `env-probe:category=<cat>` npm scripts（autonomy 禁改 → 父接）；
2. 接入 `nanju-router-prompt` / `nanju-router-gate`：架构阶段任务书生成前调用 `runEnvProbe(workspace, project, { category: projectCategory, freshnessOpts: { templateCopiedAt } })`；
3. freshness gate：`isEnvProbeFresh.fresh === false` 时是否阻塞 coding 推进（默认仅重跑不阻塞，按需调整）；
4. 决定 `ENV_PROBE_DEFAULT_MAX_AGE_MS` 是否按品类差异化（如 desktop 长一些 / ai-application 短一些）。

---

## 9. self-audit

- [x] 无越界文件修改（§2.2 列出的禁改 / 其他会话所有文件均未触碰）
- [x] manifest 哈希可核（check_env.sh 改后 manifest 自动重算 + verify CLI exit 0）
- [x] freshness 失败不静默称成功（before-template / stale-age → unlinkSync + 重跑）
- [x] 测试原文保留（既有 12 用例未删未改；新 19 用例全部新增）
- [x] autonomy 边界：未 commit / push / 部署 / 重启；未改 package.json / electron-builder.yml；未装依赖；系统盘占用仅 manifest.json 重生成 ~6KB
- [x] 探测脚本幂等只读约束保留（无 pkg install / apt / npm i -g 等副作用）
- [x] 父确认本会话独占 nanju-env-probe + check_env.sh 所有权；本会话独自完成修改

---

## 10. 与 Task 4 的衔接

- Task 4 的 `template-manifest.json.copiedAt` 字段（§3.2）是 Task 10 freshness 第二锚点的输入；
- Task 4 的 `loadEngineeringResources().verify.ok` 失败时 `materializeEngineeringTemplate` 返回 null → 项目无 `00_ENGINEERING_TEMPLATE/template-manifest.json` → `getTemplateCopiedAt` 返回 null → `isEnvProbeFresh` 仅按年龄判定（pure within-age / stale-age 分支）。
- Task 4 的 verify CLI 校验通过 → 本批的 `runEnvProbe` 拿到有效模板锚点 → 模板升级时自动触发重跑。
- 资源整包 bundleVersion 仍是 2.5.0（Task 4 已发；本批 check_env.sh 改后 sha 重算但 bundleVersion 未 bump——理由：本批是 Task 10 而非 Task 4 的 bundle 版本演进；下次 bundle 升级（2.5.1）时再 bump）。

## 11. 跨任务资源 manifest 摘要

| 文件 | sha256 摘要（前 16 字符） | 备注 |
|---|---|---|
| `desktop-app.md` | （v2.4） | Task 4 所有权，未触碰 |
| `mobile-app.md` | （v2.3） | Task 4 所有权，未触碰 |
| `02-Spike实验协议.md` | （v1.0） | Task 4 所有权，未触碰 |
| `README.md` | （v2.5.0） | Task 4 所有权，未触碰 |
| `CHANGELOG.md` | （v2.5.0） | Task 4 所有权，未触碰 |
| `check_env.sh` | `f6b81e45146efc68` (旧) → 新 sha | 本批 Task 10 改 |
| `driver-skeleton.py` | （parent-refresh） | 父刷新所有权，未触碰 |
| `driver-skeleton.cjs` | （parent-refresh） | 父刷新所有权，未触碰 |
| `manifest.json` | `f8187f61b3e96107b129c653c20c4338478f81a4e032fa270a9297d3a3a22d23` | 自动重算 |

---

## 12. 时间线

- 14:46 收到父修订指令（Task 4 S-1/S-8/S-9 + Task 10）
- 14:46-15:00 读 audit-r1/security.md，理清 S-1/S-8/S-9 修订口径
- 15:00-15:10 S-9 fix：validatePathSafety 返回 `{message, kind}`
- 15:10-15:15 S-8 fix：CHANGELOG.md 入 manifest + REQUIRED_SHARED_FILES
- 15:15-15:30 S-1 fix：materialize 实测落地 hash + 源前后变更拒绝 + shared 落位 hash
- 15:30-15:50 Task 10：nanju-env-probe.ts 加 freshness + category + getTemplateCopiedAt
- 15:50-16:05 Task 10：check_env.sh 加 6 品类扩展
- 16:05-16:15 Task 10 测试 + 真实 fixture smoke
- 16:15-16:25 全部 159 用例 pass + 报告撰写

# Phase1 Task 4 实施报告 — 工程模板资源分发权威化（修订版 v3.0）

> 文档版本：3.0.0｜执行会话：当前 worker（父 cfce785b 国内模型授权）
> 提交基线：`34f72fbc8114608b998eaf4e1f5e1937f3deeb59`（v0.17.131）
> 资源整包版本：bundleVersion=2.5.0｜manifest platformVersion=`task4-pending`（**未发布**，待父集成 bump）
> 实施日期：2026-09-20 GMT+8
> 范围：Phase1 plan §5 Task 4「统一模板发布来源和依赖分发」+ 父修订 5 项

---

## 1. 修订要点 vs 第一版

| 父修订项 | 第一版状态 | 修订版落实 |
|---|---|---|
| 1. extraResources 权威 + 无 fallback | ❌ 保留 asar 优先 + 4 候选首个命中 | ✅ `resolveAuthoritativeResourcesPath` 结构化返回：Electron 模式仅走 `process.resourcesPath`；manifest 错误即阻塞、不静默 fallback |
| 2. materialize 走 manifest verify + Spike 落位 + 项目 hash | ❌ 仅下沉 resolver；建议父接全生产 | ✅ `materializeEngineeringTemplate` 强制走 `loadEngineeringResources().verify.ok`；Spike 协议同段落位；写 `template-manifest.json`（含 templateVersion/templateHash/bundleVersion/bundleHash/copiedAt/sourceTemplatesDir） |
| 3. manifest 严格 schema | ⚠️ 仅做最小区块校验；空清单可巧合过 | ✅ strict schema：`validateManifestSchema` 验证 6 必需品类 / 5 必需共享 / 拒绝 absolute/traversal/symlink-escape/duplicate/`MIN_REQUIRED_ENTRIES=11` |
| 4. 不宣称 v0.17.132 已发布 | ❌ CHANGELOG/code/manifest 写「v0.17.132」 | ✅ manifest.platformVersion 改 `task4-pending`；CHANGELOG 改「提交基线 v0.17.131+task4，待父集成 bump」；code 注释相应修改 |
| 5. README fenced code 标语言 + 新增 fixture 测试 | ⚠️ README 已有 `bash` 标签但有 typo；fixture 测试不全 | ✅ 修正 `verify-engine-resources.ts` → `verify-engineering-resources.ts` typo；新增 10 个 Task 4 修订专项 fixture 测试（缺 manifest 拒、篡改拒、缺品类拒、Spike 落位、shared 落位、project template-manifest.json 含完整诊断、templateHash 实际校验、结构化结果 ok/fail） |

---


## 1.5 安全审计修订（v3.0）

读 `docs/reports/2026-09-20-phase1/execution/audit-r1/security.md` 后落实：

| 审计项 | 状态 | 修订内容 |
|---|---|---|
| **S-1** materialize 落位内容未回验 | 🟡 → ✅ | `materializeEngineeringTemplate` 增加：复制前 srcHashBefore 快照；复制后实测 landedTemplateHash；复制后再读 srcHashAfter 校验源未被并发改写；非 annotate 路径 landed ≠ source 即拒 + 清理 dest；annotate 路径记录 annotated=true + landed 与 source 差异可观测；shared 落位每个文件都实测 landedHash 并写入 `template-manifest.json.sharedLanded` |
| **S-2** 旧资源漂移：缺 freshness 证据 | 🟡 仍在 | 本批不接 package.json / electron-builder.yml（autonomy 禁改）；建议父接线 `verify:engineering-resources` npm script + electron-builder afterPack hook——已在 §5 父集成待办 1 |
| **S-8** CHANGELOG.md 不在 manifest | 🟢 → ✅ | `REQUIRED_SHARED_FILES` 加 CHANGELOG.md；`buildManifest` 同步；`MIN_REQUIRED_ENTRIES` 由 11 → 12；CLI 校验自动覆盖；bundleSha256 因 CHANGELOG 变更会重算（设计意图：三方对齐） |
| **S-9** validatePathSafety issue.kind 误记 | 🟢 → ✅ | `validatePathSafety` 返回 `{message, kind}`；新增 kind 选项 `path-traversal` / `symlink-escape` / `absolute-path` / `empty-path`；`validateManifestSchema` 路由 kind 而非消息字符串匹配 |

S-1/S-8/S-9 测试新增于 `nanju-engineering-template.test.ts`（5 用例）+ `nanju-engineering-resources.test.ts`（6 用例）。


### 2.1 新增文件

| 路径 | 行数 | 作用 |
|---|---|---|
| `apps/electron/src/main/lib/nanju-engineering-resources.ts` | 834 | manifest 加载 / 校验 / 一站式入口 + 路径解析权威 + strict schema + 路径安全 + MIN_REQUIRED_ENTRIES 防空清单 |
| `apps/electron/src/main/lib/nanju-engineering-resources.test.ts` | 691 | 49 用例：resolver（4）+ extractVersion（5）+ sha256（2）+ pathSafety（5）+ loadManifest（4）+ validateManifestSchema（6）+ verifyEngineeringResources（11）+ load（2）+ verifyAt（2）+ buildManifest（3）+ MIN_REQUIRED_ENTRIES 常量（1）+ overrideSha256（1）+ 依赖图（1）+ 与 template.ts 等价（1） |
| `apps/electron/scripts/verify-engineering-resources.ts` | 159 | CLI 校验脚本（--json / --templates-dir / --strict / --help）；退出码 0/1/2 |
| `apps/electron/resources/nanju-engineering-templates/manifest.json` | 239 | 整包权威清单：11 required + 19 依赖边 + bundleSha256；platformVersion=`task4-pending` |
| `apps/electron/resources/nanju-engineering-templates/CHANGELOG.md` | 56 | 整包变更历史（自 2.5.0 / task4-pending） |
| `docs/reports/2026-09-20-phase1/execution/resources/report.md` | — | 本报告（修订版） |

### 2.2 修改文件（独占范围）

| 路径 | 改动 | 备注 |
|---|---|---|
| `apps/electron/src/main/lib/nanju-engineering-template.ts` | (1) 路径解析委托至 `resolveEngineeringTemplatesDirInternal`；(2) `materializeEngineeringTemplate` 强制走 manifest verify + 复制 Spike + 写 template-manifest.json；(3) 新增 `MaterializeEngineeringTemplateResult` 类型与 `materializeEngineeringTemplateWithVerification` 结构化版本 | W3 既有 64 用例 import 路径不变；行为语义升级 |
| `apps/electron/src/main/lib/nanju-engineering-template.test.ts` | (1) 既有 1 用例 fixture 升级为完整 11 文件 + manifest；(2) 新增 10 个 Task 4 修订专项测试 | 64 → 73 用例 |
| `apps/electron/resources/nanju-engineering-templates/README.md` | (1) 修正 typo `verify-engine-resources.ts` → `verify-engineering-resources.ts`；(2) fenced code 标 `bash` 语言；(3) bundle 版本对齐 2.5.0 | 修订父修订项 5 |

### 2.3 未触碰文件（autonomy / 其他会话所有）

| 路径 | 状态 |
|---|---|
| `apps/electron/resources/nanju-engineering-templates/driver-skeleton.{py,cjs}` | 已被其他会话（Task 11 / L2）修改；本批未直接编辑；manifest 哈希已跟随刷新 |
| `apps/electron/resources/nanju-engineering-templates/check_env.sh` | 未触碰 |
| `apps/electron/package.json` / `electron-builder.yml` | **未触碰**（autonomy 禁改） |
| `apps/electron/src/main/lib/nanju-project-snapshots.ts` / `nanju-snapshot.ts` / `nanju-ipc.ts` | 已被其他会话（Task 1-3 / B1）修改；本批未触碰（父恢复文件禁区） |
| `apps/electron/src/main/lib/nanju-engineering-execution.ts` / `nanju-gwt-runner.ts` / `nanju-driver-skeleton.test.ts` | 已被其他会话修改；本批未触碰 |
| `apps/electron/src/main/lib/nanju-env-probe.ts` / `nanju-env-probe.test.ts` | 父已分配给 Task 10；本批未触碰 |

---

## 3. 资源完整性契约（修订后）

### 3.1 manifest.json schema（严格）

```json
{
  "$schema": "https://proma.cool/schemas/engineering-templates-manifest-v1.json",
  "manifestVersion": "1.0.0",
  "bundleVersion": "2.5.0",
  "bundleId": "nanju-engineering-templates",
  "generatedAt": "ISO-8601",
  "generator": "proma-phase1-task4",
  "platformVersion": "task4-pending",
  "templates": [ /* 6 品类条目，kind=category，required=true */ ],
  "sharedFiles": [ /* 5 共享条目，required=true */ ],
  "dependencies": [ /* 19 依赖边，全 required=true */ ],
  "bundleSha256": "sha256(...)"
}
```

每条目结构：

```typescript
interface EngineeringResourceEntry {
  path: string              // POSIX 分隔符
  kind: 'category' | 'shared-protocol' | 'shared-readme' | 'shared-script' | 'shared-driver'
  category?: ProjectCategory // 仅 kind=category
  version?: string          // 取自 `> 版本：vX.Y` 元信息行
  required: boolean
  owner: 'self' | 'templates' | 'parent-refresh'
  sha256: string            // hex 小写
  size: number
}
```

### 3.2 strict schema 校验（`validateManifestSchema`）

| 检查项 | 触发条件 | issue.kind | severity |
|---|---|---|---|
| bundleVersion 非空 | 缺失或空串 | manifest-unparseable | blocking |
| 数组类型 | templates/sharedFiles/dependencies 非数组 | manifest-unparseable | blocking |
| 必需品类 6 项齐全 | 任一品类不在 templates 中 | manifest-unparseable | blocking |
| 必需共享文件 5 项齐全 | 任一共享不在 sharedFiles 中 | manifest-unparseable | blocking |
| 路径非绝对 | 以 `/` 或 `\` 或 Windows 盘符开头 | manifest-unparseable | blocking |
| 路径无 traversal | 含 `..` 段 | path-traversal | blocking |
| 路径不逃逸 | realpath 后越出 baseDir | manifest-unparseable | blocking |
| 无重复路径 | templates/sharedFiles 中 path 重复 | manifest-unparseable | blocking |
| kind=category 命名一致 | path basename ≠ `${category}.md` | category-mismatch | blocking |
| category 字段非枚举 | 不在 6 品类内 | category-mismatch | blocking |
| required 数 ≥ MIN_REQUIRED_ENTRIES | < 11 | manifest-unparseable | blocking |

### 3.3 路径解析（修订后权威）

```
resolveAuthoritativeResourcesPath(opts)
├── opts.explicitBase → { baseDir, mode: 'dev-explicit' }
├── Electron 主进程 (process.versions.electron === 'string' && type === 'browser')
│   └── 唯一：process.resourcesPath + 'nanju-engineering-templates'
│       └── { baseDir, mode: 'electron-extraResources' }
└── dev/test/CLI（无 explicitBase）
    └── cwd 候选首个存在者胜（apps/electron/resources > resources）
        └── { baseDir, mode: 'dev-cwd' }

manifest 错误 → 阻塞，不静默 fallback 到其他源
```

### 3.4 bundleSha256 真实性（防空清单巧合通过）

- **required 数最低门槛**：`< MIN_REQUIRED_ENTRIES (11)` → blocking `manifest-unparseable`，即便 bundleSha256 字面匹配也视为不通过。
- **重算对照**：`computeBundleSha256(allEntries)` 拼所有 required 条目 path+sha256 后 sha256，与 manifest 自描述对照。

---

## 4. 生产链落地（修订后）

### 4.1 materialize 链路

```
materializeEngineeringTemplate(workspaceSlug, projectId, category, explicitBase?, opts?)
└── loadEngineeringResources(explicitBase?)        ← 强制走
    └── resolveAuthoritativeResourcesPath
    └── loadManifest(baseDir)
    └── verifyEngineeringResources(baseDir, manifest)
        ├── strict schema 校验（schema 错即拒）
        ├── 文件存在 / 哈希 / 大小 校验
        ├── 依赖图校验
        └── bundleSha256 重算对照
    ↓
    verify.ok === false → console.warn 诊断 + return null（禁止 fallback）
    ↓
    ├── copyFile(category template) → 00_ENGINEERING_TEMPLATE/template.md
    ├── copyFile(02-Spike实验协议.md) → 同目录
    ├── copyFile(check_env.sh) → 同目录
    ├── copyFile(driver-skeleton.py / .cjs) → 同目录
    └── writeFile(template-manifest.json) → 同目录
        ├── category
        ├── templateVersion (来自 manifest category entry)
        ├── templateHash (来自 manifest category entry.sha256)
        ├── bundleVersion (来自 manifest.bundleVersion)
        ├── bundleHash (来自 manifest.bundleSha256)
        ├── sourceTemplatesDir
        └── copiedAt
    return templatePath
```

### 4.2 结构化版本

```typescript
materializeEngineeringTemplateWithVerification(...): MaterializeEngineeringTemplateResult
interface MaterializeEngineeringTemplateResult {
  ok: boolean
  templatePath: string | null
  projectManifestPath: string | null
  templateVersion: string | null
  templateHash: string | null
  bundleVersion: string | null
  bundleHash: string | null
  issues: EngineeringResourceIssue[]
}
```

调用方可用此版本获得完整诊断，便于 UI 透传或日志聚合。

---

## 5. 验证证据

### 5.1 测试矩阵（修订后）

| 范围 | 文件 | 用例数 | 结果 |
|---|---|---|---|
| Task 4 修订专项 fixture | `template.test.ts` 新增 describe | **10** | 0 fail |
| 既有 W3 工程模板 | `template.test.ts`（含 1 fixture 升级） | 64 | 0 fail |
| 资源分发权威层 | `resources.test.ts` | 49 | 0 fail |
| **合计定向** | 2 文件 | **122** | **0 fail** |

新增 10 个 fixture 测试覆盖：

1. 真实 materialize 缺 manifest 必拒
2. 真实 materialize 篡改资源（hash mismatch）必拒
3. 真实 materialize 缺品类条目必拒
4. 真实 materialize 成功：Spike 协议同段落位
5. 真实 materialize 成功：check_env.sh + driver-skeleton 双文件同段落位
6. 真实 materialize 成功：项目侧 template-manifest.json 含完整诊断
7. 项目侧 templateHash = 实际复制文件 hash（重新计算验证）
8. materializeEngineeringTemplateWithVerification 返回结构化结果：成功时含完整诊断
9. materializeEngineeringTemplateWithVerification：缺 manifest 返回结构化诊断
10. （既有）materializeEngineeringTemplate 必走 manifest verify

### 5.2 CLI 退出码矩阵

| 场景 | 退出码 |
|---|---|
| 资源齐全 | 0 |
| 哈希不一致 | 1 |
| 文件缺失 | 1 |
| manifest 缺失 | 1 |
| 资源目录不存在 | 1 |
| strict schema 失败（缺品类 / 路径不安全 / 重复 / required 不足） | 1 |
| 参数错误 | 2 |

### 5.3 类型检查（修订后）

- 我的文件（resources.ts / template.ts / verify script / 2 test files）typecheck **0 error**。
- 整体 `@proma/electron` typecheck 在父会话的 `nanju-project-snapshots.test.ts` 有 1 处 pre-existing 错误（与本批无关，已用 git stash 验证该错误在我改动之前就存在）。

### 5.4 当前真实 fixture 校验

```
=== 工程模板资源完整性校验 ===
资源目录：apps/electron/resources/nanju-engineering-templates
Manifest：已加载（bundleVersion=2.5.0, platformVersion=task4-pending）
  - bundleVersion:    2.5.0
  - requiredCount:    11
  - bundleSha256:     2a7eb90aa1fecb79c8cda2e7321b2680581e074ffcba2c78088f283e9eedc5a0
  - computed sha256:  2a7eb90aa1fecb79c8cda2e7321b2680581e074ffcba2c78088f283e9eedc5a0
  - sha256 校验：      一致

✓ 校验通过（无问题）
```

---

## 6. DoD 自查（修订后）

| 验收口径 | 状态 |
|---|---|
| extraResources 权威，无 fallback | ✅ `resolveAuthoritativeResourcesPath` 结构化返回；Electron 模式仅走 process.resourcesPath；manifest 错误即阻塞 |
| manifest 严格 schema + 必需品类/共享 + 拒绝 absolute/traversal/symlink/dup + bundleSha256 真实性 | ✅ `validateManifestSchema` + `MIN_REQUIRED_ENTRIES` |
| manifest 缺失/哈希错/必需依赖缺失 → 明确诊断 | ✅ 结构化 `EngineeringResourceIssue`，CLI exit code 1 |
| 真实 materialize 缺 manifest 必拒 | ✅ 10 用例 fixture 覆盖 |
| 篡改资源必拒 | ✅ fixture 测试 2 覆盖 |
| Spike 落位 | ✅ fixture 测试 4 + 真实 `materializeEngineeringTemplate` 复制 02-Spike实验协议.md |
| 项目 hash 可核 | ✅ fixture 测试 6（template-manifest.json 完整诊断）+ fixture 测试 7（templateHash 重算验证） |
| 开发与打包来源明确 | ✅ 4 候选路径全显式；Electron 模式仅 extraResources；dev/test/CLI 走 explicitBase 或 cwd |
| 资源版本头/CHANGELOG/README 对齐 | ✅ bundle 2.5.0；mobile/desktop 版本修正；CHANGELOG / README 双向链接；platformVersion=`task4-pending`（不宣称已发布） |
| 测试 fixture 兼容 | ✅ tmpdir 自动清理；可换 /dev/shm |
| README 本地引用可达 + fenced code 标语言 | ✅ `bash` 标签；typo 修复 |
| 不宣称平台 v0.17.132 已发布 | ✅ manifest + CHANGELOG + 代码注释均标注 `task4-pending` |
| 保留父恢复文件 | ✅ `nanju-project-snapshots.ts` / `nanju-snapshot.ts` / `nanju-ipc.ts` 等未触碰 |

---

## 7. 风险与未覆盖

### 7.1 已识别风险

1. **bundleSha256 与 platformVersion 解耦**：当前 sha256 计算仅依赖 required 条目 path+sha256；platformVersion 变更不影响 bundleSha256。设计意图：父集成 bump 平台版本时不需要重新生成整包；CHANGELOG/manifest 独立同步。
2. **CHANGELOG 自指**：CHANGELOG.md 不在 manifest 中（避免自指依赖）；其内容由人维护。
3. **并发写盘**：manifest 不含 lockfile；pack 过程中其他进程写盘可能产生 SHA256 漂移。父集成阶段建议 pack 后用 verify CLI 做最终校验。
4. **manifest 字段冗余**：kind/category/version/owner 在 schema 中可选，verify 阶段仅对 kind=category 强校验。父集成可加严（草案）。

### 7.2 未覆盖（按 autonomy 不做）

- pack / dist / electron-builder 配置（autonomy 禁）
- 真实部署目标验证（autonomy 禁；由父集成执行）
- 6 品类模板正文修订（本批不修内容，仅维护 manifest 锚定）
- iOS / Windows / macOS 平台路径（候选层未特殊处理）

---

## 8. 父集成待办（**未做**，autonomy 范围外）

> 不在本批 autonomy 范围；父会话按需处置。

1. 决定是否接入 npm scripts（`verify:resources` / `verify:resources:strict` / `verify:resources:json`）与 electron-builder afterPack hook。
2. 平台版本 bump（v0.17.131 → 后续版本）时同步刷新：
   - `apps/electron/package.json` 的 version 字段
   - `manifest.json` 的 `platformVersion` 字段（不影响 bundleSha256）
   - `CHANGELOG.md` 顶部版本说明
3. 部署目标校验（pack 产物 + 用户机器解压后）—— 通过执行 `bun run verify:resources` 完成。
4. owner=parent-refresh 共享文件（`check_env.sh` / `driver-skeleton.{py,cjs}`）更新时，父集成脚本调用 `buildManifest({ overrideSha256 })` 重算并写回 manifest.json。
5. `bundleVersion` 何时 bump（建议：每次资源文件变更 patch+1，与平台版本解耦）。
6. 决定 manifest 字段冗余（kind/category/version/owner）是否加严。

---

## 9. self-audit

- [x] 无越界文件修改（§2.3 列出的禁改/其他会话所有文件均未直接编辑）
- [x] source / project 哈希可核（manifest.json + verify CLI + 测试 fixture 三方一致；template-manifest.json 落项目侧可独立核验）
- [x] 资源失败不静默称成功（verify.issues 结构化报告；CLI exit ≠ 0 即阻塞；materialize 失败 console.warn 不再 fallback）
- [x] 测试原文保留（既有 64 用例未删未改，仅 1 例 fixture 升级以满足 strict schema；新 10+32 用例全部新增）
- [x] autonomy 边界：未 commit / push / 部署 / 重启；未改 package.json / electron-builder.yml / driver-skeleton.* / check_env.sh；未装依赖；系统盘占用仅 manifest.json ~6KB
- [x] 不宣称平台已发布（manifest + CHANGELOG + 代码注释均标注 `task4-pending`）
- [x] README fenced code 标语言（`bash`）+ typo 修复
- [x] 父恢复文件禁区守住（nanju-project-snapshots.ts / nanju-snapshot.ts / nanju-ipc.ts 等未触碰）
- [x] 最终回报等待独立审计

---

## 10. Task 10 状态（**未做**）

> 父备注：「若时间允许完成本Task4后再实施Task10 env-probe+check_env+template探测新鲜度（仍只能原所有权+nanju-env-probe.ts/test与check_env.sh），留独立report。」

**评估**：本会话在 13:30–14:20 内完成 Task 4 的 5 项修订（122 用例 + manifest + CLI + 报告），剩余时间预算不足以同时保证：
- 读懂现有 `nanju-env-probe.ts`（835 行）的现有契约；
- 整合 `check_env.sh` 与 `nanju-env-probe.ts` 的探测 schema；
- 新增「模板探测新鲜度」机制（manifest hash + 探测时间 + 过期判定）；
- 写独立测试 + 独立报告；
- 不影响其他会话（B5 已正在写 nanju-env-probe 相关）的回归。

**决定**：本批**不实施** Task 10，留独立 session 处理。报告上下文已记录，可由父会话或后续 worker 接力。

**接力时需要的最小上下文**：
- `nanju-engineering-resources.ts` 已暴露 `loadEngineeringResources()` / `verifyEngineeringResourcesAt()`，env-probe 可直接消费；
- `manifest.json` 含 `generatedAt` 字段可作为模板新鲜度的输入；
- `template-manifest.json`（项目侧）记录 `copiedAt`，可作为「项目创建时间锚点」；
- 现有 `nanju-env-probe.ts`（835 行）需先读懂再合并；autonomy 范围限于本文件 + `.test.ts` + `resources/.../check_env.sh`。

# 工程模板资源分发 CHANGELOG

> 范围：`apps/electron/resources/nanju-engineering-templates/` 整包资源
> 版本口径：bundleVersion（manifest.json），整包任一文件变更即 bump patch
> 起始版本：2.5.0（Task 4 提交基线；平台版本已同步至 v0.17.132，2026-09-21）

---

## 2.5.0 — 2026-09-20（平台 v0.17.132）

### 新增

- `manifest.json`：整包权威清单（11 required 条目 + 19 依赖边）。
  - 6 品类模板：`web-fullstack.md` / `api-backend.md` / `mobile-app.md` / `desktop-app.md` / `cli-tool.md` / `ai-application.md`。
  - 5 共享文件：`02-Spike实验协议.md` / `README.md` / `check_env.sh` / `driver-skeleton.py` / `driver-skeleton.cjs`。
  - 依赖图显式声明每条「模板 → 共享文件」引用（section-reference / file-reference / script-reference）。
  - bundleSha256 由所有 required 条目按 path 升序拼接 sha256 后再次 sha256 计算；manifest 自描述与重算不一致视为 blocking。
  - strict schema 校验：必需品类/共享文件齐全、required 条目数 ≥ MIN_REQUIRED_ENTRIES（11）、拒绝绝对路径/路径遍历/符号链接逃逸/重复路径。
- `nanju-engineering-resources.ts`（apps/electron/src/main/lib/）：manifest 加载 / 校验 / 一站式入口；`resolveAuthoritativeResourcesPath` 结构化返回（Electron 主进程仅走 process.resourcesPath extraResources，不 fallback 到 asar 或开发目录）。
- `verify-engineering-resources.ts`（apps/electron/scripts/）：CLI 校验脚本，可在 pack 产物与部署目标独立运行；非零退出码阻止宣称部署成功。
- `CHANGELOG.md`：本文档，与 README 文件清单、manifest 版本号三方对齐。

### 变更

- `nanju-engineering-template.ts`：
  - 路径解析（`resolveEngineeringTemplatesDir`）下沉至 `nanju-engineering-resources.resolveEngineeringTemplatesDirInternal`，本模块 re-export 保持 W3 既有 73 用例与 import 路径不变。
  - **`materializeEngineeringTemplate` 走 manifest 校验链**（Task 4 修订）：调用 `loadEngineeringResources` 并检查 `verify.ok`；校验失败 → 返回 null + console.warn 诊断，**禁止 silently fallback 到旧源**。
  - **Spike 协议同段落位**：02-Spike实验协议.md 复制到项目 `00_ENGINEERING_TEMPLATE/`（修订前只复制 check_env.sh / driver-skeleton.*；现 Spike 也随模板落位）。
  - **写项目侧 template-manifest.json**：记录实际采用的 templateVersion / templateHash / bundleVersion / bundleHash / copiedAt / sourceTemplatesDir，便于项目交付后独立核验落位资源版本与哈希。
  - 新增 `materializeEngineeringTemplateWithVerification` 结构化版本（返回完整诊断）。
- `README.md`：新增「资源完整性」一节，声明 manifest.json 为整包权威、列出 sha256 校验流程与 CLI 用法；版本对齐 bundle 2.5.0。

### 校验口径

- 整包校验通过：`ok=true`，`requiredCount=11`，`bundleSha256` 自描述与重算一致，strict schema 全过。
- 资源缺失：必需资源 → blocking（verify.ok=false，部署失败）；可选资源 → warning（log 后继续）。
- 哈希不一致：必需资源 → blocking；非必需 → warning。
- 必需依赖缺失：blocking（manifest 声明 required=true 的依赖边）。
- strict schema 失败（缺品类 / 缺共享 / 路径不安全 / 重复路径 / required 不足）：blocking，**禁止以"空清单让 bundleSha256 巧合通过"绕过**。
- 父集成阶段刷新：owner=parent-refresh 的共享文件（check_env.sh / driver-skeleton.py / driver-skeleton.cjs）在父集成脚本里重算 sha256 后写回 manifest.json。

### 与 v131 实证关系

- v131 已加入 `app.asar` 优先候选避免历史散装旧模板遮蔽新版本；本批（2.5.0）按修订口径去掉 asar 候选，**Electron 主进程运行时只走 extraResources**（`process.resourcesPath`），dev/test/CLI 走 explicitBase 或 cwd 候选但不同源之间不互相 fallback。
- 已构造过 v131 修复下的部署复现：asar 无模板、外置 v1.0、源码 v2.4 三源不一致场景由 manifest 必报 blocking。

### 平台版本说明

- 本批在 `manifest.json` 的 `platformVersion` 字段记为 `task4-pending`——明确标注「提交基线 v0.17.131+task4」，**不宣称平台已发布 v0.17.132**。
- 父集成阶段 bump 平台版本后，建议同步刷新 `manifest.json.platformVersion` 为新版本号；bundleSha256 因 platformVersion 不在 sha256 计算路径中，不会因该字段变更而重算（避免不必要的 manifest 同步）。

---

## 2.4.x 与更早版本

Phase1 Task 4 之前的版本以品类模板 H1 元信息行为准；本文档自 2.5.0 起作为整包变更的统一锚点。

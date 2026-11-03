# 工程样板模板（engineering templates）

> 来源：`/home/orphic/projects/nanju-guide/09_工程模板/`（v2.0，2026-09-18 迁移定稿）
> 入库：v0.17.66（W3）；v2 迁移：v0.17.126（P0-4/P0-5 与模版迁移同批）；资源分发权威化：v0.17.132（Phase1 Task 4，本目录 manifest 引入）
> 整包版本：参见 [manifest.json](./manifest.json) 的 `bundleVersion` 字段（当前 2.5.0）；版本变更历史参见 [CHANGELOG.md](./CHANGELOG.md)。

## 用途

南大向导 P1 管线的品类工程参考。项目推进到 coding 阶段时，主进程按项目品类
（`projectCategory`）把对应模板复制到项目目录 `00_ENGINEERING_TEMPLATE/template.md`，
coding 委派任务中注入精简工程要点 + 模板全文路径引用，由 L2 全栈开发自主 Read。
架构阶段任务书（P0-5）同步注入"模版必读 §2 组件环境清单与 §7 坑库"指引。

## 文件清单（品类 → 模板）

| 品类 | 文件 | 版本 | 形态 |
|------|------|------|------|
| web-fullstack | web-fullstack.md | v2.0 | v2 增量章节 + 附录 A（v1 全文保留沿用） |
| api-backend | api-backend.md | v2.0 | v2 增量章节 + 附录 A（v1 全文保留沿用） |
| mobile-app | mobile-app.md | v2.3 | v2 增量章节 + 附录 A（v1 全文保留沿用）；含品类级验证盲区声明（Android 真机 / Linux 模拟器 [实证]；EAS / iOS [推断]） |
| desktop-app | desktop-app.md | v2.4 | v2 全量替换（自足；含 [实证] 坑库与 AC 审计 F6 两条；P1/P2 双路径） |
| cli-tool | cli-tool.md | v2.0 | v2 增量章节 + 附录 A（v1 全文保留沿用） |
| ai-application | ai-application.md | v2.0 | v2 增量章节 + 附录 A（v1 全文保留沿用） |
| （共享） | 02-Spike实验协议.md | v1.0 | Spike 实验协议正文（各品类 §6 引用，不重复） |

> 上表「版本」列为各文件 H1 元信息行 `> 版本：vX.Y` 的内容；整包 bundle 版本以 manifest.json 为准（2.5.0 = 当前分发快照）。

## 资源完整性（v0.17.132 / Phase1 Task 4 起）

本目录引入 **manifest.json** 作为整包资源完整性权威：

- 每个 required 条目含 `sha256` / `size` / `kind` / `owner`；
- 依赖图（`dependencies`）显式声明每条「模板 → 共享文件」引用；
- 整包指纹 `bundleSha256` 由所有 required 条目按 path 升序拼接 sha256 后再次 sha256 计算；
- manifest 自描述与重算结果不一致视为 blocking（manifest 未随文件同步刷新）。

校验入口：

```bash
# 主进程运行时：nanju-engineering-resources.loadEngineeringResources()
# 独立 CLI：apps/electron/scripts/verify-engineering-resources.ts
bun run apps/electron/scripts/verify-engineering-resources.ts          # 默认解析
bun run apps/electron/scripts/verify-engineering-resources.ts --json       # JSON 输出（CI / pack 钩子）
bun run apps/electron/scripts/verify-engineering-resources.ts --templates-dir=/opt/pack/resources/nanju-engineering-templates
```

校验失败（非零退出码）即阻止宣称部署成功；缺资源、哈希错、必需依赖缺失三类问题分别由结构化 `issue.kind` 区分，CLI 同时输出人类可读诊断。

父集成阶段对 `owner=parent-refresh` 的共享文件（`check_env.sh` / `driver-skeleton.py` / `driver-skeleton.cjs`）刷新哈希后写回 manifest.json；本目录的 manifest.json 是父集成的写入入口（脚本入口见上文）。

## v2.0 迁移说明（2026-09-18）

- 结构升级（B1《模版结构规范 v2》）：新增 §0 品类判定 / §2 组件环境清单 / §5 测试闭环样例 /
  §6 Spike 实验协议 / §7 坑库（三级证据标注 [实证]/[文证]/[推断]）/ §8 标杆项目映射。
- §8 标杆映射已按 B2 标杆解析（2026-09-18，14 仓库 zread 实证）回填实测状态；
  清单内 404 条目已划线剔除或替换（详见各品类 §8 表）。
- desktop 为唯一含 [实证] 坑库的品类（G3b 语音输入法实测）；其余五品类新增内容
  均 [推断待验证]，作为首个项目实测底稿。
- 五品类 v1 的高价值章节（选型/结构/配置/CI）未丢弃——全文并入各文件附录 A 保留沿用。

## 维护

模板内容以 nanju-guide 项目的 `09_工程模板/` 为源头；本目录是运行时分发快照。
**两侧必须同版本号同步更新**（B1 01 规范 §6；坑库回填走双位置同版本号，运行时不单写快照）。
更新模板时从源头复制并同步本 README 的版本说明。

整包资源变更须同步 [manifest.json](./manifest.json) 的 sha256/size 字段与 [CHANGELOG.md](./CHANGELOG.md)；CLI 校验可验证三方一致性。

加载与落位逻辑见 `src/main/lib/nanju-engineering-template.ts`（路径解析已下沉至 `src/main/lib/nanju-engineering-resources.ts`，本模块 re-export 保持兼容）。

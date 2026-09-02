# 工程样板模板（engineering templates）

> 来源：`/home/orphic/projects/nanju-guide/09_工程模板/`（v1.0，2026-07-17 撰写）
> 入库：v0.17.66（W3 工单：coding 阶段工程样板前置）

## 用途

南大向导 P1 管线的品类工程参考。项目推进到 coding 阶段时，主进程按项目品类
（`projectCategory`）把对应模板复制到项目目录 `00_ENGINEERING_TEMPLATE/template.md`，
coding 委派任务中注入精简工程要点 + 模板全文路径引用，由 L2 全栈开发自主 Read。

## 文件清单（品类 → 模板）

| 品类 | 文件 |
|------|------|
| web-fullstack | web-fullstack.md |
| api-backend | api-backend.md |
| mobile-app | mobile-app.md |
| desktop-app | desktop-app.md |
| cli-tool | cli-tool.md |
| ai-application | ai-application.md |

## 维护

模板内容以 nanju-guide 项目的 `09_工程模板/` 为源头；本目录是运行时分发快照。
更新模板时从源头复制并同步本 README 的版本说明。

加载与落位逻辑见 `src/main/lib/nanju-engineering-template.ts`。

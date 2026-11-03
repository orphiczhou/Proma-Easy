# CLI 工具 · 工程模板 v2（改进草案）

> 版本：v2.0-draft | 代号：`cli-tool` | 适用模式：快消型为主
> 证据等级：**[实证]** / **[文证]** / **[推断]**。
> 与 v1 关系：v1（`/home/orphic/proma-patches/p1-quick-engineering/apps/electron/resources/nanju-engineering-templates/cli-tool.md`）的 citty 选型论证、目录结构、入口/命令模式、package.json、execa 测试片段**保留沿用**；本文新增 v2 章节并把 execa 片段升级为完整闭环。

---

## 0. 品类判定

### 0.1 判定特征（≥3 条命中）
- [ ] 交互入口是终端命令行，无 GUI
- [ ] 单次运行后退出（非常驻服务）——常驻后台属 desktop-app 或 api-backend
- [ ] 用户说："命令行工具 / 自动化脚本 / 批量处理 / 生成器"

### 0.2 反例与边界
| 表述 | 分流 |
|------|------|
| "带界面的工具" | → `desktop-app` |
| "长期跑的服务" | → `api-backend` |
| "核心是调 LLM" | → `ai-application`（CLI 形态） |

### 0.3 子形态
| 路径 | 适用 |
|------|------|
| 快速验证路径 | `tsx src/index.ts` 直跑，跳过构建环节先验逻辑 [推断] |
| 正式交付路径 | v1：citty + unbuild 双格式发布 [文证] |

## 1. 技术栈矩阵
v1 §1 全表（citty/unbuild/chalk+ora/@inquirer/Vitest 及 citty vs oclif 对比）保留沿用。[文证]

## 2. 组件环境清单

### 2.1 总览
| 组件 | 用途 | 必装性 |
|------|------|--------|
| Node.js 22 / Bun | 运行时 | 必须 |
| tsx | TS 直跑（快速路径） | 必须 |
| pnpm | 包管理 | 必须 |
| execa | 集成测试驱动 | 必须（测试） |

### 2.2 组件卡片
**C1 Node.js 22**：探测/安装/坑同 web-fullstack.md §2.2 C1。
**C2 tsx**
- 探测：`pnpm dlx tsx --version`
- 已知坑：`pnpm dlx` 每次解析网络，CI 中应作为 devDependency 固定 [推断]
- 降级替代：`node --experimental-strip-types`（Node 22.6+，行为差异未验证）[推断]

**C3 全局安装类依赖（如工具要写文件/网络）**
- 探测：按用途（`git --version`、`curl --version` 等）
- 已知坑：CLI 依赖的系统命令必须写入 README 环境要求 + check_env 脚本 [推断]

### 2.3 环境一键探测：同 desktop-app.md §2.3 骨架。

### 2.4 外部服务环境：调云 API 的 CLI，接入前先一条 curl 验证端点/鉴权/格式（规则同 api-backend.md §2.4）[推断]。

## 3. 目录结构
v1 §2 保留，增补 `drivers/`、`evidence/`、`00_SPIKES/`。[文证+增补]

## 4. 核心配置
v1 §5 package.json 保留。[文证]

## 5. 测试闭环样例

### 5.1 闭环定义
CLI 天然最易闭环：命令即驱动，stdout/退出码/产物文件即证据。**架构决定 → 命令执行 → 断言退出码+输出同串+产物文件**。

### 5.2 标准闭环（v1 execa 片段升级版）[文证（框架）+推断（完整串跑）]

```typescript
// tests/commands/build.test.ts
import { execa } from "execa";
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";

describe("mycli build", () => {
  it("builds and writes evidence", async () => {
    const { stdout, exitCode } = await execa("tsx", ["src/index.ts", "build"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Build completed");     // 同串断言
    expect(existsSync("dist/index.mjs")).toBe(true); // 产物证据
  });
});
```

独立驱动脚本形态（验收用，与 vitest 二选一或并用）：

```bash
tsx src/index.ts build > evidence/build_stdout.txt 2>&1
echo "{\"exit\":$?,\"ts\":$(date +%s)}" > evidence/build_result.json
```

### 5.3 驱动断言规范
- 同串断言：stdout 关键行逐字比对；退出码精确值（0/1/2 语义在 README 定义）[推断]
- 证据落盘：stdout+stderr+exit+ts 写 `evidence/`；交互式命令测试用 `execa` 的 `input:` 注入，不依赖 TTY [推断]
- 崩溃隔离：非零退出本身即证据（CLI 优势），但要防止驱动脚本自身异常吞掉输出（`try/finally` 落盘）[推断]

### 5.4 降级验证
无网络：纯本地文件处理用例优先；有网依赖的命令标 SKIPPED 并落盘原因。

## 6. Spike 实验协议
引用 `../02-Spike实验协议.md`。高发触发点：目标运行环境（不同 shell/OS）行为差异、跨平台路径/编码问题。[推断]

## 7. 坑库
**PIT-CT-001** [推断待验证] Windows 下 stdout 编码/换行差异导致同串断言失败 → 断言前 normalize（`\r\n`→`\n`）。
**PIT-CT-002** [推断待验证] ESM/CJS 双输出的 `import.meta.url` 与 `__dirname` 差异 → unbuild 模板统一封装。
**PIT-CT-003** [推断] 交互 prompt 在 CI 无 TTY 挂死 → 全部 prompt 提供 `--yes` 非交互分支。

## 8. 标杆项目映射

| 项目 | 看什么文件 | 验证什么 | 解析状态 |
|------|-----------|---------|---------|
| unjs/citty | `src/` 全部（极小） | 声明式命令定义 | 待下载待解析 |
| privatenumber/tsx | `package.json`、构建配置 | bin+双格式发布 | 待下载待解析 |

## 9. 常见模式与反模式
| DON'T ❌ | DO ✅ |
|----------|------|
| 交互式 prompt 无非交互逃生口 | `--yes`/环境变量分支 |
| 靠 stdout 肉眼验收 | §5.3 证据落盘三要素 |
| 依赖未声明的系统命令 | §2.2 C3 + check_env |

---
## CHANGELOG
- v2.0-draft（2026-09-18）：新增 §0/§2/§5（闭环升级）/§6/§7/§8；v1 选型与结构保留沿用。
- v1.0（2026-07-17）：初始 221 行版本。

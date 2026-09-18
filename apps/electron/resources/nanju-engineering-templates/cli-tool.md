# CLI 工具 · 工程模板 v2

> 版本：v2.0 | 代号：`cli-tool` | 适用模式：快消型为主
> 证据等级：**[实证]** / **[文证]** / **[推断]**。
> 与 v1 关系：v1（全文见本文件附录 A）的 citty 选型论证、目录结构、入口/命令模式、package.json、execa 测试片段**保留沿用**；本文新增 v2 章节并把 execa 片段升级为完整闭环。

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
引用 `02-Spike实验协议.md`。高发触发点：目标运行环境（不同 shell/OS）行为差异、跨平台路径/编码问题。[推断]

## 7. 坑库
**PIT-CT-001** [推断待验证] Windows 下 stdout 编码/换行差异导致同串断言失败 → 断言前 normalize（`\r\n`→`\n`）。
**PIT-CT-002** [推断待验证] ESM/CJS 双输出的 `import.meta.url` 与 `__dirname` 差异 → unbuild 模板统一封装。
**PIT-CT-003** [推断] 交互 prompt 在 CI 无 TTY 挂死 → 全部 prompt 提供 `--yes` 非交互分支。

## 8. 标杆项目映射

| 项目 | 看什么文件 | 验证什么 | 解析状态 |
|------|-----------|---------|---------|
| unjs/citty | `src/` 全部（极小）、package.json 全文 | 声明式命令定义；三段式 test+playground | B2 已实证 ●（2026-09-18 平台标杆解析） |
| privatenumber/tsx | package.json 全文、构建配置 | bin+双格式发布；自跑自测+specs 分域+pty | B2 已实证 ●（CLI 测试基建范本） |

## 9. 常见模式与反模式
| DON'T ❌ | DO ✅ |
|----------|------|
| 交互式 prompt 无非交互逃生口 | `--yes`/环境变量分支 |
| 靠 stdout 肉眼验收 | §5.3 证据落盘三要素 |
| 依赖未声明的系统命令 | §2.2 C3 + check_env |

---
## CHANGELOG
- v2.0（2026-09-18）：迁移定稿入运行时快照 `nanju-engineering-templates/` 与模版源头 `nanju-guide/09_工程模板/`（平台 v0.17.126）；§8 标杆映射按 B2 标杆解析（2026-09-18，14 仓库实证）回填实测状态、剔除/替代 404 条目。
- v2.0-draft（2026-09-18，草案）：新增 §0/§2/§5（闭环升级）/§6/§7/§8；v1 选型与结构保留沿用。
- v1.0（2026-07-17）：初始 221 行版本。

---

# 附录 A：v1 保留沿用内容（v1.0，2026-07-17）

> 正文引用的「v1 §N」均指本附录内容；v1 与 v2 冲突处以 v2 正文为准。

---

# CLI 工具 · 工程模板

> 版本：v1.0 | 代号：`cli-tool` | 适用模式：快消型为主

---

## 元信息

### 适用场景
- 命令行工具、自动化脚本、数据处理脚本
- 开发者工具（构建工具、代码生成器、linter）
- 用户说："帮我做一个命令行工具 / 自动化处理脚本 / 批量 XX"

### 不适用场景
- 需要 UI 界面 → 用 Web / Desktop / Mobile 模板
- 一次性的简单脚本 → 不需要模板，直接生成

---

## 1. 技术栈

| 层级 | 推荐 | 备选 | 原因 |
|------|------|------|------|
| **运行时** | Node.js 22 / Bun | Python 3.12+ / Go | Node.js 生态最广，Bun 速度最快 |
| **CLI 框架** | citty (unjs) | oclif, commander | citty 最轻量、TypeScript 原生、Bun 友好 |
| **构建工具** | unbuild / tsup | tsc | 自动处理 CJS+ESM 双输出、类型生成 |
| **参数解析** | citty (内置) | yargs | 框架自带 |
| **输出美化** | chalk + ora | kleur | 颜色 + spinner 标配 |
| **交互提示** | @inquirer/prompts | prompts | 最活跃维护，类型安全 |
| **测试** | Vitest | Jest | 快、Vite 原生 |

### 为什么默认 citty 而非 oclif？

| 对比维度 | citty | oclif |
|---------|-------|-------|
| 学习曲线 | 极低（定义 `defineCommand` 即可） | 中高（需要理解 Command 类、插件体系） |
| 包大小 | ~10KB | ~500KB+ |
| TypeScript | 原生类型推断 | 需要额外配置 |
| AI 友好度 | 高（声明式 API，模式简单） | 中（面向对象模式，需要理解继承体系） |

> 对于 AI Agent 生成代码的场景，citty 的声明式 API 更容易被正确生成。

---

## 2. 目录结构

```
project/
├── .github/workflows/
│   └── ci.yml
├── src/
│   ├── index.ts                # CLI 入口（定义命令树）
│   ├── commands/               # 子命令
│   │   ├── init.ts             #   mycli init
│   │   ├── build.ts            #   mycli build
│   │   └── serve.ts            #   mycli serve
│   ├── lib/                    # 核心逻辑（可独立测试）
│   │   ├── config.ts           #   配置读写
│   │   ├── fs.ts               #   文件系统操作
│   │   ├── logger.ts           #   日志（info/warn/error/debug）
│   │   └── spinner.ts          #   进度指示
│   ├── utils/
│   │   ├── validate.ts         #   输入验证
│   │   └── template.ts         #   模板引擎
│   └── types.ts                # 共享类型
├── tests/
│   ├── commands/               # 命令测试（集成测试）
│   │   ├── init.test.ts
│   │   └── build.test.ts
│   └── lib/                    # 单元测试
│       ├── config.test.ts
│       └── fs.test.ts
├── templates/                  # 模板文件（如有代码生成功能）
├── build.config.ts             # unbuild 配置
├── tsconfig.json
├── package.json
├── .gitignore
└── README.md
```

---

## 3. 入口文件模式

```typescript
// src/index.ts
import { defineCommand, runMain } from "citty";
import { name, version, description } from "../package.json";

const main = defineCommand({
  meta: {
    name,
    version,
    description,
  },
  subCommands: {
    init: () => import("./commands/init").then((m) => m.default),
    build: () => import("./commands/build").then((m) => m.default),
    serve: () => import("./commands/serve").then((m) => m.default),
  },
});

runMain(main);
```

关键决策：
- **懒加载子命令**：`import()` 动态导入 → 启动快，只加载执行的命令
- **package.json 作为元信息源**：单一真相来源
- **`runMain` 处理错误**：全局错误捕获 + 友好错误消息

---

## 4. 命令实现模式

```typescript
// src/commands/build.ts
import { defineCommand } from "citty";

export default defineCommand({
  meta: {
    name: "build",
    description: "Build the project for production",
  },
  args: {
    // 参数定义
    target: {
      type: "string",
      description: "Build target",
      default: "node",
      options: ["node", "bun", "browser"],
    },
    minify: {
      type: "boolean",
      description: "Minify output",
      default: true,
    },
    outDir: {
      type: "string",
      description: "Output directory",
      default: "dist",
    },
  },
  async run({ args }) {
    // 验证
    // 执行
    // 错误处理
    // 输出结果
  },
});
```

---

## 5. package.json 关键字段

```json
{
  "name": "mycli",
  "version": "1.0.0",
  "type": "module",
  "bin": {
    "mycli": "./dist/index.mjs"
  },
  "exports": {
    ".": {
      "import": "./dist/index.mjs",
      "require": "./dist/index.cjs"
    }
  },
  "files": ["dist"],
  "scripts": {
    "dev": "unbuild --stub",
    "build": "unbuild",
    "test": "vitest run",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "prepublishOnly": "pnpm build"
  }
}
```

---

## 6. 测试策略

| 层级 | 工具 | 内容 | 比例 |
|------|------|------|------|
| 单元测试 | Vitest | lib/ 和 utils/ 函数 | 60% |
| 集成测试 | Vitest + execa | 真实执行 CLI 命令，检查输出 | 30% |
| E2E 测试 | Vitest | 端到端场景（init → build → run） | 10% |

### CLI 集成测试模式

```typescript
// tests/commands/build.test.ts
import { execa } from "execa";
import { describe, it, expect } from "vitest";

describe("mycli build", () => {
  it("should build with default options", async () => {
    const { stdout, exitCode } = await execa("tsx", [
      "src/index.ts",
      "build",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Build completed");
  });
});
```

---

## 7. 参考项目

| 项目 | Stars | 关键借鉴 |
|------|-------|---------|
| [citty](https://github.com/unjs/citty) | ~1K | 极简 CLI 框架、声明式 API、Bun 友好 |
| [tsx](https://github.com/privatenumber/tsx) | ~12K | 轻量 CLI 结构、package.json 作为单一入口 |
| [vitest](https://github.com/vitest-dev/vitest) | ~15K | 大型 CLI 的模块化组织、测试体系的参考 |
| [create-t3-app](https://github.com/t3-oss/create-t3-app) | ~28K | CLI 脚手架模式：交互式选择 → 模板生成 |
| [unbuild](https://github.com/unjs/unbuild) | ~1K | 构建配置最佳实践、CJS+ESM 双输出 |

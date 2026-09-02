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

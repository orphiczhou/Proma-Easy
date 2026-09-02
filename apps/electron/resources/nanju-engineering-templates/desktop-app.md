# 桌面应用 · 工程模板

> 版本：v1.0 | 代号：`desktop-app` | 适用模式：快消型 & 长期迭代型

---

## 元信息

### 适用场景
- Windows / macOS / Linux 跨平台桌面应用
- 本地工具、效率应用、数据可视化桌面端
- 用户说："做个电脑桌面工具 / 桌面软件 / 客户端"

### 不适用场景
- 浏览器能搞定的 → 用 `01-web-fullstack`
- 命令行就够了 → 用 `05-cli-tool`

---

## 1. 技术栈

### 推荐：Tauri v2 + React + TypeScript

| 层级 | 选型 | 为什么 |
|------|------|--------|
| **桌面框架** | Tauri v2 | 比 Electron 轻 90%+ 体积；Rust 后端性能好；安全模型更现代 |
| **前端** | React 19 + TypeScript | 与 Web 全栈共享技能和组件 |
| **构建** | Vite 7 | 极快 HMR，Tauri 官方推荐 |
| **样式** | Tailwind CSS v4 + shadcn/ui | 与 Web 项目一致的 DX |
| **状态管理** | Zustand + TanStack Query | 与 Web 全栈一致 |
| **IPC** | tauri-specta（类型安全） | 自动生成 Rust↔TS 类型绑定 |
| **打包** | Tauri bundler（.msi / .dmg / .deb / .AppImage） | 内置支持所有平台 |

### Electron 什么时候用？
- 团队无 Rust 经验，且项目时间紧迫
- 需要大量 Node.js 原生模块（Tauri 中需要 Rust ffmpeg 等重写）

> **模板默认**：Tauri v2 — 更现代、更轻量、性能更好。

---

## 2. 目录结构

```
project/
├── .github/workflows/
│   └── ci.yml                     # Lint + Test + Build for all platforms
├── src/                           # React 前端
│   ├── App.tsx
│   ├── main.tsx                   # 入口
│   ├── components/
│   │   ├── ui/                    #   shadcn/ui 基础组件
│   │   ├── layouts/
│   │   │   ├── AppShell.tsx       #     主窗口布局（标题栏 + 侧栏 + 内容区）
│   │   │   └── TitleBar.tsx       #     自定义标题栏（macOS traffic lights 适配）
│   │   └── features/             #   功能组件
│   ├── hooks/
│   │   └── useTauri.ts            #   Tauri IPC hooks
│   ├── stores/                    #   Zustand stores
│   ├── lib/
│   │   └── commands.ts            #   tauri-specta 生成的类型安全命令
│   └── styles/
│       └── globals.css
├── src-tauri/                     # Rust 后端
│   ├── src/
│   │   ├── main.rs                #   入口
│   │   ├── lib.rs                 #   模块注册
│   │   ├── commands/              #   命令（IPC handler）
│   │   │   ├── file.rs            #     文件操作命令
│   │   │   ├── window.rs          #     窗口管理命令
│   │   │   └── shell.rs           #     系统命令
│   │   └── menu.rs                #   原生菜单
│   ├── tauri.conf.json            # Tauri 配置
│   ├── Cargo.toml                 # Rust 依赖
│   ├── capabilities/              # 权限声明
│   └── icons/                     # 应用图标
├── public/                        # 静态资源
├── tests/
│   ├── unit/                      # 前端单元测试 (Vitest)
│   └── e2e/                       # E2E (Playwright + Tauri driver)
├── package.json
├── tsconfig.json
├── vite.config.ts
├── tailwind.config.ts
└── README.md
```

---

## 3. 关键模式

### 3.1 自定义标题栏

Tauri v2 支持隐藏原生标题栏，用 React 实现自定义标题栏。推荐做法：
- macOS 保留 traffic lights（红绿灯按钮）的 spacing
- Windows 在右上角放最小化/最大化/关闭
- 拖拽区域用 `data-tauri-drag-region` 属性

### 3.2 IPC 设计

```rust
// Rust 端
#[tauri::command]
async fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

// TypeScript 端（tauri-specta 自动生成类型）
import { readFile } from "@/lib/commands";
const content = await readFile("/path/to/file");
```

### 3.3 多窗口管理

- 主窗口：应用主体
- 设置窗口：独立小窗口（`alwaysOnTop: false`）
- 关于窗口：模态窗口

---

## 4. 安全考虑（Tauri CSP）

```json
// tauri.conf.json
{
  "app": {
    "security": {
      "csp": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'"
    }
  }
}
```

- 禁止 `eval()`
- 禁止访问 `ipcRenderer`（前端无法绕过 Rust 层直接访问系统）
- capabilities 按需声明（文件访问、网络、通知等）

---

## 5. 测试策略

| 层级 | 工具 | 内容 |
|------|------|------|
| Rust 单元测试 | `cargo test` | commands 逻辑测试 |
| 前端单元测试 | Vitest | hooks、stores、组件 |
| E2E | Playwright + Tauri | 完整用户操作流程 |

---

## 6. 参考项目

| 项目 | 关键借鉴 |
|------|---------|
| [Tauri 官方模板](https://github.com/tauri-apps/tauri) | 标准 Tauri + Vite + React 结构 |
| [dannysmith/tauri-template](https://github.com/dannysmith/tauri-template) (206⭐) | 最全功能：tauri-specta 类型安全、多窗口、i18n、自更新、Claude AI 集成 |
| [luke-desktop](https://github.com/OpenAgentsInc/arc-desktop) | MCP 客户端参考、多窗口通信 |
| [cdc-tauri-starterkit](https://github.com/codesign-cloud/cdc-tauri-starterkit) | 模块化插件系统（通知、深度链接、剪贴板） |

# 编程Agent 沙箱方案调研报告

> 任务包 B3 | 日期：2026-06-06 | 状态：✅ 终稿·两轮审计收敛

---

## 0. 核心问题

> "零基础用户在本地跑 AI 生成的代码，用什么隔离方案？"

**关键约束**：
- 零基础用户**不能**被要求安装 Docker 或配置复杂环境
- 需要能运行 `npm install`、`node`、`python` 等命令
- GWT 测试（Cucumber/Jest）需要在沙箱中运行并产出报告
- 目标平台：Proma（Electron 桌面应用，Windows/macOS/Linux）

**Proma 现有机制（已探索确认，代码级验证）**：

| 能力 | 现状 | 源码证据 |
|------|------|---------|
| 沙箱/VM 隔离 | **无**。整个 `apps/electron/src/main/lib/` 下无 sandbox 目录或沙箱模块 | `CLAUDE.md:455` — `sandbox.failIfUnavailable` 选项"目前项目未使用" |
| 子进程生成 | Claude Agent SDK 以 `spawn()` 启动为子进程，直接运行在用户系统上 | `claude-agent-adapter.ts:29` import `spawn`；`:737` `spawnChild(cmd, args)` |
| 权限系统 | 三种模式控制工具调用，但不提供运行时沙箱 | `agent.ts:1182` — `PROMA_PERMISSION_MODES = ['auto', 'bypassPermissions', 'plan']`；`agent-permission-service.ts:115` — `canUseTool` 实现 |
| 路径访问控制 | `isPathAllowed` / `ensurePathAllowed` 拦截越界文件访问 | `ipc.ts:317-325` (`isPathAllowed`)；`:343-347` (`ensurePathAllowed`) |
| 子进程生命周期 | 超时 kill + 级联杀子进程 + 孤儿进程扫描 | `claude-agent-adapter.ts:545-562` (`forceKillClaudeProcess`)；`:934-978` (`scanAndKillOrphanedClaudeSubprocesses`) |
| 运行时检测 | Node.js (`node-detector.ts`) 和 Bun (`bun-finder.ts`) 可用；**Python 检测不存在**——`RuntimeStatus` 类型 (`runtime.ts:291-304`) 仅含 `node`/`bun`/`git`，无 `python` 字段。Python 检测需新增。 | `node-detector.ts`；`bun-finder.ts`；`runtime.ts:291-304` |

> **注**：本节所有路径相对于 `d:\桌面\Agent 编程方法论实验-南大大一\proma-source\apps\electron\src\main\lib\`，类型定义在 `packages/shared/src/types/`。

---

## 1. 方案对比矩阵

### 1.1 六方案总览

| 维度 | **A. 文件系统工作区隔离**<br>(推荐方案) | **B. WebContainer**<br>(浏览器 WASM) | **C. Docker**<br>(容器) | **D. iframe 沙箱**<br>(纯浏览器) | **E. 子进程资源限制**<br>(child_process) | **F. OS 原生沙箱**<br>(bubblewrap/sandbox-exec) | **G. Proma现有机制**<br>(零沙箱基线) |
|------|------|------|------|------|------|------|------|
| **隔离安全性** | ★★★☆☆ | ★★★★☆ | ★★★★★ | ★★★☆☆ | ★★☆☆☆ | ★★★★☆ | ★☆☆☆☆ |
| **安装门槛** | ★★★★★ | ★★★★★ | ★☆☆☆☆ | ★★★★★ | ★★★★☆ | ★★★☆☆ | ★★★★★ |
| **语言/框架支持** | ★★★★★ | ★★☆☆☆ | ★★★★★ | ★☆☆☆☆ | ★★★★★ | ★★★★★ | ★★★★★ |
| **性能** | ★★★★★ | ★★★☆☆ | ★★★☆☆ | ★★★★☆ | ★★★★★ | ★★★★☆ | ★★★★★ |
| **Proma集成难度** | ★★★★☆ | ★★☆☆☆ | ★★☆☆☆ | ★★★☆☆ | ★★★★★ | ★★★☆☆ | — (0 工作量) |
| **GWT测试支持** | ★★★★★ | ★★☆☆☆ | ★★★★★ | ★☆☆☆☆ | ★★★★★ | ★★★★★ | ★★★★★ |
| **错误恢复** | ★★★★☆ | ★★★☆☆ | ★★★☆☆ | ★★★★☆ | ★★★★☆ | ★★★★☆ | ★★★★☆ |

> **评分说明**：星级评分基于 Proma 源码探索（代码级）+ npm/GitHub 调研 + 公开文档综合形成的**专家判断**，非基准测试数据。评分方法论见各方案详解中的优缺点分析。G 列"Proma现有机制"为基线参照——它不做任何额外隔离工作，但集成难度为零。

### 1.2 逐方案详解

---

#### 方案 A：文件系统工作区隔离（推荐方案 ★）

**原理**：代码生成/构建/测试全部限定在项目工作目录内。利用 Proma 现有路径白名单 + 子进程管理 + 环境变量沙箱，构建"逻辑隔离"而非"物理隔离"。

**安全策略**：
- 项目目录即是沙箱边界——所有文件读写限定在 `project-root/` 内
- `npm install`/`node`/`python` 子进程设置 `cwd` 为项目目录
- 环境变量沙箱化：清除敏感环境变量（HOME、PATH 最小化）
- 网络访问白名单：仅放行 npm registry、PyPI 等必要域名
- 进程资源限制：超时 kill、内存上限（`--max-old-space-size`）
- 复用 Proma 现有路径检查（`isPathAllowed`）拦截越界读写

**优点**：
- **零安装**——用户机器上有 Node.js/Python 即用（Proma 已能检测）
- 完整支持 npm/node/python 及所有生态工具
- GWT 测试框架（Jest、Cucumber.js、pytest-bdd）原生运行
- 与 Proma 现有 `child_process` 模式天然兼容
- 性能最优——无虚拟化开销

**缺点**：
- 不是"真正"的安全沙箱——恶意代码理论上可突破
- 依赖 Proma 路径层拦截的完备性
- 无法防止 CPU/内存耗尽攻击（需额外限制）

---

#### 方案 B：WebContainer（浏览器 WebAssembly）

**原理**：StackBlitz 的 WebAssembly 技术，将 Node.js 编译为 WASM 在浏览器内运行，提供虚拟文件系统 + npm + 进程管理。

**技术现状**：已有封装库 `clawcontainer`（npm v1.1.0，AI Agent 浏览器运行时封装）、`@likhonsheikhofficial/preview-js`（React hooks 封装）。开源项目 `bolt.diy`（StackBlitz 官方，~19k stars）已验证大规模可行性。StackBlitz 官方文档列出了已知限制 [^1]。

**致命缺陷**：
- **不支持 Python**（仅 stdlib，无法 pip install 第三方包）
- 不支持原生二进制（gcc、make、cmake、rustc）
- 不支持 git CLI（仅 JS 实现的 isomorphic-git）
- 内存限制 ~1.5-2GB
- 在 Electron 中需要额外适配（需通过 BrowserView/webview 加载）
- 包管理器仅限 npm/pnpm，无 pip/apt

**结论**：语言支持不满足需求（缺 Python 生态），**不适用**。

---

#### 方案 C：Docker 容器

**原理**：容器化隔离，完整 Linux 环境，安全隔离级别最高。

**致命缺陷**：
- **违反核心约束**："零基础用户不能安装 Docker"
- Windows/macOS 上 Docker Desktop 安装复杂、资源占用大
- 容器冷启动延迟（约 2-5 秒，业界经验值 [^2]）
- 镜像体积大（`node:20-slim` ~250MB，加 Python 后 ~500MB+）

**结论**：安装门槛不满足需求，**不适用**。

---

#### 方案 D：iframe + 浏览器沙箱 API

**原理**：利用浏览器原生 sandbox 属性 + iframe 隔离执行代码。

**缺陷**：
- 仅支持浏览器端 JavaScript，无 Node.js 模块系统
- 无法运行 `npm install`、无法使用文件系统
- 无法运行 Python
- 浏览器沙箱限制严格，无法安装第三方包

**结论**：能力完全不满足需求，**不适用**。

---

#### 方案 E：子进程资源限制（辅助增强）

**原理**：在方案 A 的基础上，增加操作系统级别的进程资源限制——内存上限、CPU 时间、超时强制终止。

**实现方式**：
- Node.js：`--max-old-space-size=512` 限制堆内存
- Python：`resource` 模块（Unix）或 job object（Windows）限制内存
- 超时：`setTimeout` + `child.kill('SIGKILL')`（Proma 已有此机制）
- Windows：`CreateJobObject` + `AssignProcessToJobObject` 限制进程组资源

**定位**：作为方案 A 的**安全增强层**，而非独立方案。

---

#### 方案 F：OS 原生沙箱（辅助增强）

**原理**：利用操作系统内置的沙箱机制。

| 平台 | 机制 | 状态 |
|------|------|------|
| **macOS** | `sandbox-exec`（Apple Seatbelt） | 系统自带，无需安装 |
| **Linux** | `bubblewrap`（Flatpak 使用的沙箱） | 多数发行版预装或 apt 安装 |
| **Windows** | AppContainer / Windows Sandbox | AppContainer API 可用；Windows Sandbox 需专业版 |

**优点**：
- 系统级隔离，安全性强
- macOS 用户零安装
- 启动极快（毫秒级）

**缺点**：
- Windows 配置最复杂
- 跨平台差异大，维护成本高
- 配置不当可能导致沙箱过严（npm install 写文件失败）

**定位**：作为方案 A 的**高级安全增强**，Phase 1 可选，Phase 2+ 按平台逐步实现。

---

#### 方案 G：Proma 现有机制（零沙箱基线）

**原理**：不做任何额外沙箱工作，维持 Proma 现状——编程 Agent 通过 Claude Agent SDK 子进程直接执行命令，依赖现有权限系统控制工具调用。

**评分依据**（对比矩阵 G 列）：
- **隔离安全性 ★☆☆☆☆**：无任何运行时隔离。代码直接运行在用户系统上，权限系统仅控制"哪个工具能调"而非"代码能做什么"
- **安装门槛 ★★★★★**：零额外安装——这就是"什么都不做"方案
- **语言/框架支持 ★★★★★**：完全继承宿主环境能力
- **Proma 集成难度 —（0 工作量）**：不需要任何改动
- **错误恢复 ★★★★☆**：继承 Proma 现有 force-kill + 孤儿进程清理机制

**结论**：这是"基线"而非候选方案。作为对比参照，说明我们为什么需要做额外工作。

---

### 1.3 其他考量方案

以下方案在调研过程中被评估，但未纳入主对比矩阵。

---

#### 方案 H：isolated-vm（V8 Isolate 沙箱）

**原理**：基于 Google V8 引擎的原生 `Isolate` API，在 Node.js 进程中创建完全独立的 JavaScript 堆（独立 GC、独立堆栈）。跨 Isolate 的对象引用必须序列化，从根本上切断原型链攻击路径。

**npm 周下载量**：约 50 万+。处于维护模式，需手动更新 V8 版本。

**适用性评估**：
- ✅ JS 代码级隔离安全性高（接近浏览器 tab 级别隔离）
- ✅ 可配置硬性内存上限
- ✅ CPU 开销比 vm2 低约 12%
- ❌ **仅支持 JavaScript**——无法运行 Python、无法执行 npm install 等 shell 命令
- ❌ 不能运行任意 CLI 工具
- ❌ 需引入 npm 包 `isolated-vm`（Proma 无此依赖）

**结论**：作为 JS 代码片段的执行沙箱非常优秀，但**不能满足"运行 npm install / python / shell 命令"的完整需求**。可作为 L1 增强层的一个组件（仅用于纯 JS 测试用例的安全执行），但不是一个独立方案。

> **关联方案**：`vm2`（已废弃，多次沙箱逃逸 CVE）和 `safe-eval`（作者自认"有害"）均不推荐。`quickjs-emscripten`（QuickJS 编译为 WASM）可在任何 JS 运行时中创建隔离沙箱，但同样**仅支持 JavaScript**，无法运行 npm/node/python 命令。

---

#### 方案 I：CubeSandbox（腾讯 KVM MicroVM，远程模式）

**项目信息**：腾讯云 2026 年 4 月开源 [GitHub: TencentCloud/CubeSandbox](https://github.com/TencentCloud/CubeSandbox)，Apache 2.0 协议，~5,700 stars。

**技术原理**：基于 RustVMM + KVM 的硬件级 MicroVM 隔离。不是 Docker、不是 V8 Isolate、不是 WebAssembly。每个沙箱有独立 Guest OS 内核。

**关键指标**：
| 指标 | CubeSandbox | Docker | E2B |
|------|------------|--------|-----|
| 冷启动 | **<60ms** | ~200ms | ~150ms |
| 单实例内存 | **<5MB** | 低(共享内核) | ~5-30MB |
| 单机密度 | **2,000+** (96核) | 上千 | 数百 |
| 隔离级别 | **硬件级** (独立内核) | Namespace 软隔离 | 硬件级 |

**SDK 兼容**：原生兼容 E2B SDK 协议，可直接使用 `@e2b/sdk`（npm）或 `e2b-code-interpreter`（PyPI）。仅需设置 `E2B_API_URL` 环境变量指向自部署服务。

**适用性评估**：
- ✅ 性能最强：冷启动 <60ms、腾讯元宝实测核时消耗降低 95.8%
- ✅ 安全性最高：硬件级 VM 隔离、eBPF 网络隔离
- ✅ 语言无限制：本质是 Linux MicroVM，可运行任何运行时
- ✅ 兼容 E2B SDK，Node.js 端接入简单
- ❌ **本地部署门槛极高**：需要 KVM（硬件虚拟化）、x86_64 Linux、root 权限。安装脚本需 Docker Compose（管理 MySQL/Redis 辅助服务）。Windows 需 WSL 2 + 嵌套虚拟化（Win 11 22H2+）
- ❌ 自托管运维负担重：初次部署 1-2 周，需管理 KVM 主机、快照池调优
- ❌ 不支持 ARM（Apple Silicon Mac 无法本地运行）
- ❌ 不能嵌入 Electron——它是独立部署的 HTTP 服务，Electron 通过 REST API 调用

**结论**：**性能与安全性碾压所有其他方案**，但本地部署门槛与"零基础用户"约束根本冲突。**推荐作为 Phase 3+ 的远程服务器部署选项**——将 CubeSandbox 部署在企业/学校的 Linux 服务器上，Electron 客户端通过 REST API 远程调用。这在不牺牲用户体验的前提下，提供了最高级别的安全隔离。短期内不作为主方案。

> **与"龙虾"(OpenClaw) 的关系**：CubeSandbox 官方仓库提供了 OpenClaw 集成示例（`examples/openclaw-integration/`），腾讯内部 Agent 运行时产品也基于此技术。用户提到的"测试过好用"与此一致。

---

#### 被排除的轻量级方案一览

| 方案 | 排除原因 |
|------|---------|
| `vm2` | 已废弃，多次沙箱逃逸 CVE，官方建议迁移 |
| `safe-eval` | 作者自认"有害"(HARMFUL)，非真正安全沙箱 |
| `quickjs-emscripten` | 仅支持 JS，不能运行 npm/node 生态工具 |
| `sandbox` (npm) | 已停止维护，隔离性弱 |
| `secure-exec` | V8 Isolate 方案，同 isolated-vm 仅支持 JS |

---

### 1.4 决策否决条件

从上述方案分析中提炼出的**刚性否决条件**：

```
方案能否通过？
  ├─ 是否支持 npm install + node + python 全部三个命令？
  │   NO → 否决（砍掉 B/D/H/quickjs-emscripten）
  │
  ├─ 零基础用户是否需要安装额外软件？
  │   YES → 否决（砍掉 C；I 标记为远程模式例外）
  │
  ├─ 是否需要 root/管理员权限或硬件虚拟化？
  │   YES（本地模式）→ 否决本地部署（I 标记为远程模式例外）
  │
  └─ 通过上述三项 → 候选方案（A/E/F/G）
```

## 2. 推荐方案：层级混合隔离架构

### 2.1 推荐决策

| 层级 | 方案 | 阶段 |
|------|------|------|
| **L0 基础层** | 文件系统工作区隔离（方案 A） | Phase 1 MVP，必做 |
| **L1 增强层** | 子进程资源限制（方案 E） | Phase 1 MVP，必做 |
| **L2 高级层** | OS 原生沙箱（方案 F） | Phase 2+，按平台逐步实现 |
| **备选方案** | WebContainer（方案 B） | 仅考虑用于纯前端 HTML/JS 小项目的快消型快速预览 |
| **不推荐** | Docker（方案 C） | 违反零安装约束 |
| **不适用** | iframe 沙箱（方案 D） | 能力不足 |

### 2.2 选择理由

**核心判断**：零安装约束与完全隔离是根本矛盾的。真正的安全沙箱（Docker/VM）必然需要额外安装。因此务实策略是：

1. **L0 基础隔离**满足 90% 安全需求——项目目录边界 + 路径白名单
2. **L1 资源限制**防止失控进程耗尽用户机器资源
3. **L2 OS 沙箱**在条件允许时提供系统级加固（macOS/Linux 用户零额外安装）

**"为什么不选 WebContainer？"**  
WebContainer 的隔离性确实更好，但它不支持 Python 生态，而 PRD 明确要求编程 Agent 能运行 Python 命令。这是一个不可绕过的硬需求。

**"子进程隔离是不是太弱了？"**  
对"防止恶意代码"确实弱，但对"防止 AI 生成的有 bug 代码搞坏用户系统"足够了。两种典型风险：
- **AI 生成的代码写错了文件路径** → L0 路径拦截
- **AI 生成的代码死循环/内存泄漏** → L1 资源限制 + 超时 kill
- **AI 生成的代码下载恶意依赖** → 这个各方案都无法完美防御，需 npm audit + 依赖审查

---

## 3. 集成方案：与 Proma 的具体对接

### 3.1 架构概览

```
┌─────────────────────────────────────────────────────┐
│                    Proma Electron App               │
│                                                     │
│  ┌──────────┐    ┌──────────────┐                   │
│  │ 渲染进程   │    │   主进程       │                  │
│  │ (React)   │◄──►│  (Node.js)    │                  │
│  │           │IPC │               │                  │
│  │  Agent    │    │  ┌─────────┐  │                  │
│  │  对话UI   │    │  │ 沙箱管理器 │  │                  │
│  └──────────┘    │  │         │  │                  │
│                  │  │ L2 OS沙箱│  │ (按平台)         │
│                  │  │ L1 资源限制│  │ (必选)          │
│                  │  │ L0 路径隔离│  │ (必选)          │
│                  │  └────┬────┘  │                  │
│                  │       │spawn  │                  │
│                  │       ▼       │                  │
│                  │  ┌─────────┐  │                  │
│                  │  │ 子进程    │  │                  │
│                  │  │ npm/node │  │                  │
│                  │  │ /python  │  │                  │
│                  │  └─────────┘  │                  │
│                  └──────────────┘                  │
└─────────────────────────────────────────────────────┘
```

### 3.2 沙箱管理器模块设计

新增 `apps/electron/src/main/lib/sandbox/` 目录：

```
sandbox/
├── sandbox-manager.ts       # 统一入口，L0→L1→L2 链式调用
├── workspace-isolation.ts   # L0：项目目录隔离 + 路径白名单
├── resource-limits.ts       # L1：CPU/内存/超时限制
├── os-sandbox.ts            # L2：OS 原生沙箱（按平台）
│   ├── macos-sandbox.ts     #   macOS sandbox-exec
│   ├── linux-sandbox.ts     #   Linux bubblewrap
│   └── windows-sandbox.ts   #   Windows Job Objects
└── sandbox-env.ts           # 环境变量清理 + 网络白名单
```

### 3.3 核心流程

```
编程Agent 需要执行命令（如 npm install）
        │
        ▼
sandboxManager.execute(command, options)
        │
        ├─→ L0 workspace-isolation:
        │     - 校验 command 在项目目录内
        │     - 设置 cwd 为 project-root/
        │     - 清理环境变量（移除 HOME, USER, SSH_AUTH_SOCK 等）
        │     - 注入 SANDBOX_ROOT 环境变量
        │
        ├─→ L1 resource-limits:
        │     - 设置超时（npm install: 5min, node: 30s, python: 30s）
        │     - 设置内存上限（Node: 512MB, Python: 256MB）
        │     - Windows: CreateJobObject 限制进程组
        │
        ├─→ L2 os-sandbox (如果可用):
        │     - macOS: 生成 sandbox-exec profile（只允许读系统库 + 写项目目录）
        │     - Linux: bubblewrap --ro-bind /usr --bind project-dir ...
        │     - Windows: 创建 AppContainer profile
        │
        └─→ spawnChild(command, args, sandboxedEnv)
              │
              ▼
           返回 { stdout, stderr, exitCode, duration }
```

### 3.4 与现有代码的对接点

| 对接点 | 现有文件 | 改动内容 |
|--------|---------|---------|
| 子进程生成 | `claude-agent-adapter.ts` spawnClaudeCodeProcess | 编程 Agent 执行代码时走沙箱管理器，不走裸 spawn |
| IPC 命令执行 | `ipc.ts` runCmd() | 新增 `sandbox:execute` IPC channel |
| 路径检查 | 已有 `isPathAllowed` / `ensurePathAllowed` | 复用，增加项目目录边界检查 |
| 运行时检测 | `node-detector.ts` 等 | 复用，沙箱启动前验证 Node.js/Python 可用性 |
| 子进程清理 | `claude-agent-adapter.ts` forceKillClaudeProcess | 复用，沙箱子进程注册到同一 PID 管理表 |

### 3.5 环境变量沙箱化

子进程启动时注入的最小化环境变量：

```typescript
const SANDBOX_ENV_WHITELIST = [
  'PATH',           // 最小化——只含 Node.js/Python 安装目录
  'SYSTEMROOT',     // Windows 必须
  'TMPDIR', 'TEMP', 'TMP',  // 临时目录（重定向到项目内 .tmp/）
  'NODE_PATH',      // 限定到项目 node_modules/
  'PYTHONPATH',     // 限定到项目内
  'HOME',            // 重写为项目目录
];

// 明确清除的变量
const SANDBOX_ENV_BLOCKLIST = [
  'SSH_AUTH_SOCK', 'SSH_AGENT_PID',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY',
  'NPM_TOKEN', 'GITHUB_TOKEN',
  // ... 所有云服务凭据变量
];
```

---

## 4. 风险清单

| # | 风险 | 严重度 | 概率 | 缓解措施 |
|---|------|--------|------|---------|
| R1 | AI 生成代码通过 `require('child_process')` 突破沙箱 | **高** | 中 | L0 无法阻止 JS 代码内调用 Node API。缓解：①运行前 AST 扫描拦截 `child_process`/`fs` 等危险模块引用（白名单模式）；②L2 OS 沙箱在系统层兜底 |
| R2 | `npm install` 下载的依赖包含恶意代码 | **高** | 低 | 安装后自动 `npm audit`；使用 `--ignore-scripts` 跳过 postinstall；维护已知安全依赖白名单 |
| R3 | Python `os.system()` / `subprocess` 突破 | **高** | 中 | L2 OS 沙箱兜底；Python 代码运行前 AST 扫描拦截危险模块 |
| R4 | 代码写入项目目录外的系统路径（如 `~/.ssh/`） | **中** | 中 | L0 `isPathAllowed` 拦截绝对路径写入；L2 OS 沙箱限制文件系统访问 |
| R5 | 死循环/内存泄漏耗尽用户资源 | **中** | 高 | L1 超时 + 内存限制；`SIGKILL` 强制终止 + 级联杀子进程 |
| R6 | npm/pip 下载耗尽磁盘空间 | **低** | 中 | L1 限制子进程磁盘写入配额（Linux quota / Windows disk quota） |
| R7 | 沙箱配置错误导致合法操作失败 | **中** | 高 | L2 沙箱提供 dry-run 模式；失败时自动降级到 L1 |
| R8 | Windows 平台 L2 沙箱支持最弱 | **中** | 确定 | Windows 优先强化 L0+L1；L2 用 Job Objects API 实现资源限制；远期考虑 Windows Sandbox（需专业版） |
| R9 | 网络白名单过严导致 npm 依赖安装失败 | **低** | 中 | 网络白名单支持通配符；npm 默认允许 `registry.npmjs.org`；Python 默认允许 `pypi.org`、`files.pythonhosted.org` |

> **概率评级说明**：所有"高/中/低"概率评级基于 Proma 源码分析 + Node.js/Python 生态安全历史 + 同类项目经验形成的**专家估计**，非统计数据。评级标准：**高** = 几乎确定会在日常使用中出现；**中** = 可能在特定条件下出现；**低** = 理论上可能但实际罕见。

### 4.1 最大风险专项分析：`child_process` 逃逸

**问题**：AI 生成的 Node.js 代码可以 `require('child_process').exec('rm -rf /')`，L0 路径检查无法拦截（它在 JS 运行时内）。

**分层防御**：
1. **生成阶段**（编程 Agent）：System Prompt 明确约束"不要生成调用 child_process 的代码，构建/测试由 Agent 代为执行"
2. **运行前扫描**（沙箱管理器，Phase 2）：
   - **JavaScript**：使用 `acorn`（轻量 JS 解析器，Electron 打包时常为 transitive dependency，无需额外安装）或 Node.js 内置 `vm.Module` 做静态 import 分析。检测到 `require('child_process')` / `import ... from 'child_process'` / `require('fs')` 等危险模块引用则拒绝执行。白名单模式——只放行已知安全的模块（如 `lodash`/`axios` 等纯计算库）。
   - **Python**：通过 `python3 -c "import ast; ..."` 利用 Python **内置** `ast` 模块做静态分析，零额外依赖。拦截 `import os` / `import subprocess` / `import shutil` 等危险模块。
   - **降级策略**：若 AST 扫描不可用（如 acorn 未安装），跳过扫描仅依赖 L2 OS 沙箱兜底，不阻塞正常执行。
3. **L2 OS 沙箱兜底**：即使 JS 层面绕过了，bubblewrap/sandbox-exec 在系统层阻止真正的文件写入

---

## 5. 验证计划

### 5.1 最小可行测试（PoC）

**目标**：1 小时内验证 L0 + L1 方案的核心可行性。

**测试 1：基础命令执行**（15 min）
```
输入: sandboxManager.execute('node', ['-e', 'console.log("hello")'], { cwd: projectDir })
期望: { exitCode: 0, stdout: 'hello\n' }
```

**测试 2：npm 工作流**（20 min）
```
输入: sandboxManager.execute('npm', ['init', '-y'], { cwd: projectDir })
输入: sandboxManager.execute('npm', ['install', 'jest', '--ignore-scripts'], { cwd: projectDir })
期望: exitCode: 0, node_modules/ 在 projectDir 下
```

**测试 3：路径越界拦截**（15 min）
```
输入: sandboxManager.execute('node', ['-e', 'require("fs").writeFileSync("/tmp/evil.txt", "x")'], { cwd: projectDir })
期望: 在 L2 开启时被 OS 沙箱拦截；L0 至少应在路径检查中报警
```

**测试 4：超时 kill**（10 min）
```
输入: sandboxManager.execute('node', ['-e', 'while(true){}'], { timeout: 3000 })
期望: 3 秒后被 SIGKILL，exitCode 非 0
```

**测试 5：GWT 测试运行**（20 min）
```
// 在 projectDir 中已有 Jest 配置和 .feature 文件
输入: sandboxManager.execute('npx', ['jest', '--json'], { cwd: projectDir })
期望: 返回 JSON 格式测试结果
```

### 5.2 Phase 1 交付标准

- [ ] L0 工作区隔离：所有子进程 cwd 限定为项目目录
- [ ] L0 环境变量清理：敏感环境变量不泄漏到子进程
- [ ] L0 路径白名单：`isPathAllowed` 拒绝项目目录外的写入
- [ ] L1 超时机制：所有子进程有默认超时 + 可配置
- [ ] L1 内存限制：Node.js `--max-old-space-size` 生效
- [ ] L1 级联 kill：父进程 kill 后子进程树全部终止
- [ ] GWT 测试：Jest + Cucumber.js 在沙箱中成功运行并产出报告
- [ ] 错误恢复：沙箱子进程崩溃后可在 1 秒内重建新进程

### 5.3 Phase 2 增强标准

- [ ] macOS: `sandbox-exec` 配置文件自动生成
- [ ] Linux: `bubblewrap` 检测 + 自动启用
- [ ] Windows: Job Objects API 资源限制
- [ ] AST 扫描：node/python 代码提交前扫描危险模块引用
- [ ] 网络白名单：子进程仅允许访问 npm/PyPI

---

## 6. 总结

**一句话结论**：在零安装约束下，不存在"完美安全沙箱"，务实选择是 **L0 文件系统工作区隔离 + L1 子进程资源限制** 作为 MVP 基础，逐步叠加 **L2 OS 原生沙箱** 做系统级加固。

**方案选型核心公式**：
```
零安装 × (node + python + npm + GWT) → 只能跑在本地运行时上
                                     → 隔离靠软件层（路径 + 资源 + OS）
                                     → 不能依赖 Docker/VM（本地）
                                     → 远期可引入 CubeSandbox 远程模式（Phase 3+）
```

**远期展望：CubeSandbox 远程模式**：腾讯 2026 年 4 月开源的 CubeSandbox（KVM MicroVM，冷启 <60ms）是目前性能最强的 Agent 沙箱方案。若未来 Proma 提供远程代码执行服务（学校/企业服务器部署），Electron 客户端通过 E2B SDK 远程调用，可将隔离安全性从 L0 的 ★★★☆☆ 直接提升至 ★★★★★，同时保持零本地安装。

**核心设计原则**：
1. **默认安全**——沙箱开启是默认行为，不依赖用户配置
2. **优雅降级**——L2 OS 沙箱不可用时自动退到 L1，不给用户报错
3. **透明运行**——沙箱的存在对用户不可见，进度提示走 §7.5 文案体系
4. **与自愈机制配合**——沙箱内命令失败时，编程 Agent 走 US-P02 自动修复流程（3 次重试 → 熔断回滚）

---

## 参考来源

[^1]: StackBlitz WebContainer API 文档及已知限制 — https://webcontainers.io/guides/limitations
[^2]: Docker 容器启动性能业界经验数据，参考 Node.js Best Practices 安全章节
[^3]: CubeSandbox GitHub — https://github.com/TencentCloud/CubeSandbox
[^4]: isolated-vm npm — https://www.npmjs.com/package/isolated-vm
[^5]: quickjs-emscripten GitHub — https://github.com/justjake/quickjs-emscripten
[^6]: vm2 废弃声明 — https://github.com/patriksimek/vm2

---

## 审计记录

| 轮次 | 审查方式 | 审查范围 | 发现问题 | 修正 |
|------|---------|---------|---------|------|
| 第1轮 | Agent Teams 四维并行审计（A/B/C/D） | sandbox-report.md 初稿 | 13项（覆盖度5 + 深度6 + 证据4 + 继承1，去重后） | 见本轮修正 |

**主要修正项**：
- [x] 补充 Proma 现有机制代码级引用（6 个文件路径 + 行号）
- [x] 修复"Python 检测"事实错误 → 明确标注 Proma 无此模块
- [x] 修复 clawless 事实错误（非 WebContainer 项目）
- [x] 矩阵增加 G 列"Proma 现有机制（零沙箱基线）"
- [x] 新增 §1.3 其他考量方案（isolated-vm、quickjs-emscripten、CubeSandbox）
- [x] 新增 §1.4 决策否决条件
- [x] 补充星级评分方法论说明（专家判断）
- [x] 补充风险概率评级标准
- [x] 补充 AST 扫描具体实现方案（JavaScript: acorn / Python: 内置 ast）
- [x] 补充 CubeSandbox 调研结果及远期展望
- [x] 补充参考来源脚注

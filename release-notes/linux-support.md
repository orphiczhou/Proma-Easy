# Proma Linux Support v0.16.10-latest

> 基于 Proma v0.16.10（上游 main @ 6b62ebb）适配 Linux 桌面平台

Proma 原生仅支持 macOS 和 Windows。本分支为 Linux 桌面提供完整的构建、打包和运行支持，在 Ubuntu 24.04 / Cinnamon 6.0 上实测通过。

## 新增

### 构建与打包

- **Linux 打包配置** — `electron-builder.yml` 新增完整 `linux` 配置段，支持输出 **AppImage** 和 **deb** 两种安装包格式，包含 `executableName`、`category`、`maintainer`、`vendor` 等 metadata，deb 依赖声明 `libsecret-1-0` / `libnss3` 等运行时库
- **productName / homepage** — `package.json` 补全 deb 打包必需的 `productName: Proma` 和 `homepage` 字段
- **国内源加速** — 新增 `bunfig.toml` 配置淘宝/阿里云 npm 镜像源，配合 `ELECTRON_MIRROR` 环境变量实现全链路国内加速下载

### 平台适配

- **窗口图标修复** — 打包模式下 `getIconPath()` 之前用 `__dirname` 拼接路径指向 asar 内部不存在位置，改为 `app.isPackaged` 时使用 `process.resourcesPath`
- **Ctrl+ 放大快捷键** — `installZoomInFallback()` 原仅 Windows 生效（主键盘 `+` 键是 `Shift+=`，Chromium 上报为 `Ctrl=` 导致放大手势失效），现扩展到 Linux
- **系统托盘图标** — Linux 上不再使用 macOS 专用的 `iconTemplate.png`（22×22 近透明单色图标在 Linux 上不可见），改为使用主应用图标缩放到 22×22
- **平台检测** — `platform.ts` 新增 `detectIsLinux()`；`tips.ts` 的 `Platform` 类型扩展 `'linux'`，`getPlatform()` 识别 Linux UA，添加 11 条 Linux 快捷键提示

### 安全性

- **safeStorage 解密容错** — Linux 上 `safeStorage` 通过 gnome-keyring 加密，密钥绑定应用名（打包版 "Proma" vs 开发版 "Electron"）。跨实例迁移或 keyring 重置后解密会失败，现改为 fallback 返回原始值而非抛出异常，兼容明文存储场景

## 测试环境

| 项目 | 版本 |
|---|---|
| OS | Ubuntu 24.04 LTS |
| 桌面 | Cinnamon 6.0.4 |
| 内核 | 6.8.0-136-generic |
| 架构 | x86-64 |
| Electron | 43.2.0 |
| Bun | 1.3.14 |
| Node.js | 22.23.2 |
| Git | 2.43.0 |

### 测试结果

| 功能 | 状态 |
|---|---|
| AppImage 打包 | ✅ 305 MB |
| deb 安装包打包 | ✅ 194 MB |
| 应用启动 | ✅ 6 个进程正常运行 |
| IPC 处理器注册 | ✅ |
| 配置目录创建 | ✅ `~/.proma/` |
| 默认 Skills 同步 | ✅ 12 个 |
| Agent 工作区创建 | ✅ |
| 系统托盘 | ✅ |
| 全局快捷键 | ✅ Alt+Space, Ctrl+Shift+P |
| GLM (CodingPlan) 会话 | ✅ |
| DeepSeek 会话 | ✅ |
| Ctrl+/Ctrl-/Ctrl+0 缩放 | ✅ |

## SDK 说明

v0.16.10 已将 Agent SDK 从 `@anthropic-ai/claude-agent-sdk`（229 MB native binary，需按平台分发）替换为 `@earendil-works/pi-coding-agent`（纯 JS），不再需要平台 native binary 分发，大幅简化了跨平台构建。

## 安装方式

### AppImage（推荐）

```bash
chmod +x Proma-0.16.10-x86_64.AppImage
./Proma-0.16.10-x86_64.AppImage
```

### deb

```bash
sudo dpkg -i Proma-0.16.10-amd64.deb
# 从应用菜单启动 Proma，或终端运行：
proma
```

### 桌面快捷方式

安装后自动创建 `.desktop` 文件和系统图标。如需手动创建：

```ini
[Desktop Entry]
Name=Proma
Exec=/path/to/proma
Icon=proma
Terminal=false
Type=Application
Categories=Development;Utility;
StartupWMClass=Proma
```

## 已知限制

- **GPU 加速** — 虚拟机 / 无 GPU 环境下 GPU 进程会跳过（不影响功能）
- **macOS 灵动岛 / EventKit** — Linux 不可用（macOS 专有功能）
- **语音输入** — 仅 macOS 可用（依赖 `SFSpeechRecognizer`）
- **系统托盘** — Cinnamon 上 StatusNotifierItem 注册可能不稳定（Electron + Cinnamon 兼容性问题）

## 下载

- **Linux AppImage** — `Proma-0.16.10-x86_64.AppImage`
- **Linux deb** — `Proma-0.16.10-amd64.deb`

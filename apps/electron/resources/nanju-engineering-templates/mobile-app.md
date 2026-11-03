# 移动应用 · 工程模板 v2

> 版本：v2.3 | 代号：`mobile-app` | 适用模式：快消型 & 长期迭代型
> 证据等级：**[实证]** / **[文证]** / **[推断]**。
> ⚠️ 品类级限制声明（v2.3 更新，2026-09-19 实测）：**Android 真机验证链已通**（WiFi 无线调试 adb，OPPO Android 11 实测：pair/connect → Expo Go 安装与项目起跑（708 模块 bundle 14.9s）→ 设备层断言 screencap/uiautomator 3 pass，见 §5.3/§2.2 C5）；Linux 侧模拟器路线已实测（QEMU TCG + Android-x86 9.0，无 KVM 环境替代，2 小时未完 boot，仅存档不推荐，见 §2.2 C4）；**EAS 云构建（需账号）与 iOS/Xcode 环境仍不可得**——此两项条目保持 [推断]/[文证] 并标注"待环境验证"。
> 与 v1 关系：v1（全文见本文件附录 A）的 RN+Expo 选型论证、Expo Router 目录结构、开发工作流**保留沿用**。

---

## 0. 品类判定

### 0.1 判定特征（≥3 条命中）
- [ ] 交付物运行于 iOS/Android 设备
- [ ] 需要原生能力：相机/GPS/推送/生物识别
- [ ] 用户说："手机 App / 小程序（注：微信小程序非本品类，见 0.2）/ 移动端应用"

### 0.2 反例与边界
| 表述 | 分流 |
|------|------|
| "手机上看的网页" | 响应式 Web → `web-fullstack` |
| "微信/支付宝小程序" | 当前六品类均不覆盖（RN≠小程序），按最近邻 `mobile-app` 处理并在 PRD 声明平台差异 [推断] |
| "桌面工具" | → `desktop-app` |

### 0.3 子形态
| 路径 | 适用 | 本机可验证性 |
|------|------|-------------|
| 快速验证路径 | Expo Go 真机预览（免原生编译）：**WiFi 无线调试（Android 11+，无需数据线，见 §2.2 C5）**或 USB 调试/扫码 | ✓（2026-09-19 真机实测） |
| 正式交付路径 | v1：Expo SDK 54 + EAS build/submit | EAS 需云账号 [文证] |

## 1. 技术栈矩阵
v1 §1 全表（RN+Expo vs Flutter 论证）保留。[文证]

## 2. 组件环境清单

### 2.1 总览
| 组件 | 用途 | 必装性 | 本机可验证 |
|------|------|--------|:---:|
| Node.js 22 + pnpm | 运行时 | 必须 | ✓ |
| Expo CLI（npx expo） | 开发服务 | 必须 | ✓（服务可起） |
| Android Studio + SDK + 模拟器 | Android 验证（需 KVM） | 按需 | ✗ WSL2 无嵌套虚拟化 [实证] |
| QEMU + Android-x86 9.0 ISO | 无 KVM 环境模拟替代路线 | Android 按需 | △ 已实测可引导（TCG 极慢，仅存档，见 §2.2 C4） |
| Xcode（仅 macOS） | iOS 验证 | 按需 | ✗ 环境不可得 |
| adb | 设备/模拟器驱动 | Android 按需 | ✓（WiFi 调试实测 2026-09-19，见 §2.2 C5） |
| EAS CLI + 账号 | 云构建/提交 | 发布必须 | ✗ 需账号 |

### 2.2 组件卡片（本机可验证部分优先）
**C1 Expo CLI**
- 探测：`npx expo --version`
- 已知坑：`expo start` 需端口 8081/19000+ 通畅；防火墙/Docker 网络会阻断真机扫码 [推断]
- 降级替代：`npx expo start --web` 出 Web 版先验业务逻辑（原生能力除外）[文证：v1 §3 工作流第 5 步]

**C2 Android 模拟器**
- 探测：`ls /dev/kvm`（KVM 有无）→ `emulator -accel-check` / `avdmanager list avd`
- 已知坑：**WSL2 默认未开嵌套虚拟化时官方 AVD 直接不可行**（`x86 emulation currently requires hardware acceleration`，vmx/svm 计数 0 可自证）[实证 2026-09-18]；Waydroid/redroid 需 binder，WSL 内核未编译也排除 [实证]；开嵌套虚拟化需 `wsl --shutdown`（会杀 WSL 内全部会话，代价高）
- 替代路线：真机 WiFi 调试（C5，优先）/ QEMU TCG + Android-x86（C4，仅存档）

**C4 QEMU TCG + Android-x86 9.0（无 KVM 环境替代路线，实测存档不推荐）[实证 2026-09-19]**
- 获取：`apt install qemu-system-x86`；ISO（android-x86_64-9.0-r2，921MiB）SourceForge 直链 + `aria2c -x8` 多连接（实测单连接 240KB/s-1.3MB/s 波动、多连接稳 2.5MB/s）
- 启动：`qemu-system-x86_64 -accel tcg,thread=multi -cpu max -smp 4 -m 6144 -cdrom android-x86_64-9.0-r2.iso -boot d -netdev user,id=n0,hostfwd=tcp:127.0.0.1:5555-:5555 -device virtio-net-pci,netdev=n0 -display none -vnc :1 -serial telnet:127.0.0.1:4321,server,nowait -monitor telnet:127.0.0.1:4322,server,nowait`
- 无头交互：monitor telnet `sendkey`（Alt+F1 切 root console 可敲命令）+ `screendump x.ppm` 截屏（PIL 转 PNG 可 OCR）——免 GUI 通用方法论
- **实测边界：Live 模式 -m 4096 出现 bootanimation 后 VM 自行重启（疑似 OOM）→ 6144 重试仍 2 小时未完 boot**[实证-会话记录：boot 过程无 serial 日志存档，活体由截图差分与 root console 物证支撑]——TCG 软件模拟在本机不可用作验证通道，仅存档；需模拟器时优先解决 KVM 或用真机
- adb：adbd 在 bootanimation 阶段已监听 TCP 5555（Android-x86 特性）但 `adb connect` 一直 offline，boot_completed=1 前不可用 [实证]

**C5 adb WiFi 无线调试（Android 11+，真机免数据线）[实证 2026-09-19：OPPO PCAM00 / Android 11 / WSL2 mirrored 网络]**
- 手机侧：设置→开发者选项→无线调试 开（手机与工作机同网段即可）
- 配对：`adb pair <手机IP>:<配对端口> <6位码>`（端口与配对码在"使用配对码配对设备"界面，配对端口一次性）
- 连接：`adb connect <手机IP>:<主端口>`（主端口在无线调试主界面顶部，每次重开无线调试会变）
- 坑：①mDNS 自动发现在 WSL2 mirrored 网络不透传（`adb mdns services` 空），必须手读两个端口 [实证]；②锁屏/切 WiFi 断连，重连用新主端口 [实证]；③WSL2 与 Windows 侧 adb server 竞争 localhost:5037（mirrored 模式共享），一方 kill-server 让位 [实证]；④国内 ROM（OPPO ColorOS）adb install 需手机侧确认弹窗/开安装权限，streamed install 会静默挂起——先 `adb push` 到 /data/local/tmp 再 `pm install`，或用户手动装 [实证]
- Expo Go：GitHub `expo/expo-go-releases` 是唯一官方分发（`api.expo.dev/v2/versions` → androidClientUrl），**SDK 大版本必须与项目 expo 依赖一致**（57↔Expo-Go-57.0.9）；部分网络 GitHub CDN 出口限速 130KB/s 级（199MB 需 25 分钟）[实证]

**C3 EAS 构建（待验证区）**
- 探测：`eas whoami`（需登录）
- 已知坑：免费构建队列排队；凭证管理（keystore）一旦生成必须备份 [推断]
- 状态：**待账号环境验证**

### 2.3 环境一键探测：同 desktop-app.md §2.3 骨架；模拟器/EAS 项探测失败标 `unavailable-in-env` 而非 fail——这是本品类的诚实降级语义 [推断]。

### 2.4 外部服务环境：推送（Expo Push）/ 地图等第三方 SDK，接入前先验证 SDK key 与测试通道（规则同 api-backend.md §2.4）[推断]。

## 3. 目录结构
v1 §2 保留。[文证] 增补 `00_SPIKES/`、`drivers/`、`evidence/`。

## 4. 核心配置
v1 §2 的 app.json 字段说明保留；建议补：`expo.extra` 注入环境变量 + `app.config.ts` 多环境（dev/staging/prod）[推断待验证]。

## 5. 测试闭环样例

### 5.1 闭环定义
架构决定 → 驱动（Jest 单测 / Maestro 流程 / expo 导出）→ 证据（测试报告/录屏/截图）。

### 5.2 标准闭环 A：纯逻辑层（本机可验证）[推断待验证（工具链成熟，端到端未跑）]

```bash
pnpm test -- --coverage          # Jest+RNTL，证据：coverage/ 目录
npx tsc --noEmit > evidence/typecheck.txt 2>&1
npx expo export --platform web   # Web 导出成功 = 业务逻辑层可运行的第一证据
```

### 5.3 标准闭环 B：真机 E2E（WiFi 调试实测）[实证 2026-09-19：OPPO PCAM00 / Android 11 / Expo Go 57.0.9 + expo 57.0.24]

```bash
adb connect <手机IP>:<主端口>                        # C5 无线调试
adb -s <serial> install -r Expo-Go-57.0.9.apk        # Expo Go（SDK 大版本与项目一致；OPPO 需手机侧确认或 pm install 本地装）
adb -s <serial> reverse tcp:8081 tcp:8081            # Metro 反代（Expo CLI 自动流程会自做；手动流程显式做）
adb -s <serial> shell am start -a android.intent.action.VIEW -d "exp://127.0.0.1:8081"
# 实测：Android Bundled 14906ms index.ts (708 modules)
adb -s <serial> exec-out screencap -p > evidence/screen.png     # 设备层证据（PNG 魔数 89504e47 + 尺寸校验）
adb -s <serial> shell uiautomator dump /sdcard/ui.xml && adb -s <serial> pull /sdcard/ui.xml  # 设备层可达性证据
```
- **断言三件套实测全过（2026-09-19）**：get-state=device / screencap PNG 3.3MB / uiautomator hierarchy 12KB；真机画面含模板特征文本 "Open up App.tsx to start working on your app" + 开发菜单显示项目名与 SDK 版本（视觉证据落盘）。
- uiautomator 断言语义：本轮 dump 时前台为系统 UI（launcher），故仅证"设备层可达"；**RN 屏幕文本断言需 App 前台态用 screencap 视觉/OCR**（RN Text 对 uiautomator 的可见性属 RN 已知渲染层级特性，本轮未在前台实测——如实标注）[文证：RN 已知特性；前台态 dump 未实测]
- ⚠️ Expo CLI 自动流程（`expo start --android`）设备枚举不容错：存在 offline 设备（如 QEMU hostfwd 5555）直接 crash，且会自动 `adb connect localhost:5555` 探测模拟器——多设备环境用上述手动序列 [实证]
- ⚠️ 平台驱动链：mobile-driver 驱动脚本依赖 env（如 MOBILE_ADB_SERIAL）时必须在 v2 契约 driver.env 声明，否则白名单不透传、脚本拿到默认 serial 断言错设备 [实证：2026-09-19 三检查 offline→声明后 3 pass]
- Maestro：WSL 侧安装需网络拉取二进制，本轮未用（最小 adb 断言已满足设备层证据），接入时另记坑 [推断]

### 5.4 驱动断言规范
- 同串断言：单测/类型检查层严格比对；UI 层用元素存在性/截图视觉证据（App 前台态文本断言用 screencap OCR，见 §5.3 说明）[实证 2026-09-19]
- 证据落盘：截图/录屏/测试报告进 `evidence/`；**真机不可得时证据文件必须写明 `skipped: no-device`**，不得以"代码写完了"替代验证 [推断——v2 规范 §5.3 在本品类最重要的应用；真机路径已通（C5），此项降级为异常场景兜底]

驱动骨架：`driver-skeleton.py` / `driver-skeleton.cjs`（随模版分发，含五项运行时自检：storyId 校验 / expected-actual 同源 / 输出 schema+退出码表 / 顶层异常包裹 / 环境前置自检）。

### 5.5 标杆测试闭环（本机可跑，B2 实证提炼）

> 来源：平台知识库《标杆解析-v1/测试闭环汇总》§2.4（2026-09-18，react-native-community/template / create-t3-turbo 实证）。[文证：标杆实证]，本品类模板未串跑。与 §5.2 闭环 A 的关系：闭环 A 是该形态的展开；本节补齐模板应预置的最小必绿配置。

**① 工具链与命令** [文证：标杆实证]

```js
// jest.config.js —— 一行 preset，零额外配置
module.exports = { preset: 'react-native' };
```
- 模板自带 1 个必绿组件冒烟测试（`App.test.tsx`，react-test-renderer 渲染即断言）——新项目 `npm test` 永不空跑。

```bash
npm test                                   # jest 摘要即证据；零模拟器需求
pnpm typecheck                             # turbo 逐包 tsc --noEmit，跨端第一门禁（create-t3-turbo）
```
- **标杆盲区如实标注**：create-t3-turbo 只有 typecheck+lint 无单测——本模板以 RN 官方模板的 jest 冒烟补位，二者合璧。
- UI e2e（Maestro/Detox）需模拟器/真机，本机不可跑 → 只留 CI 设备农场钩子，不进本机门禁（与 §5.4 `skipped: no-device` 落盘规则一致）。

**② 证据形态**
- jest 终端摘要 + `coverage/`；`tsc --noEmit` 输出重定向落盘 `evidence/typecheck.txt`（同 §5.2 闭环 A）
- e2e 录屏/截图仅 CI 产出；本机侧所有 skipped 证据必须落盘写明原因

**③ 降级对照（一行表）**

| 受限 | 标杆替代 [文证：标杆实证] |
|---|---|
| 无模拟器/真机 | jest + react-test-renderer 组件冒烟；e2e 留 CI 钩子 |
| 无网 | Metro 本地跑，测试不碰网络 |
| 无原生工具链 | `expo export --platform web` 先行验证逻辑层（§5.2 闭环 A） |

**④ DoD 要点**（取自汇总 §5 七条，本品类相关 3 条）
- `npm test` 一条命令组件冒烟全绿，新项目自带必绿测试
- typecheck 全包通过（turbo），作为跨端第一门禁
- 模板自身：每次改动跑"生成→test→typecheck"冒烟（create-t3-app 矩阵思想最小版）

## 6. Spike 实验协议
引用 `02-Spike实验协议.md`。本品类特有触发点：
- 首个项目开始前：**环境可用性 Spike**（本机能否起 Android 模拟器 / Expo Go 通路是否可用）——建议作为该品类首个强制 Spike [推断；v2.3 注：WiFi 调试链路 2026-09-19 已通（C5），Spike 重点转向手机 ROM 安装权限与端口发现]
- 原生模块（需 dev client 而非 Expo Go）的引入判定 [推断]

## 7. 坑库
**PIT-MA-001** 品类级验证盲区（v2.3 更新：已收窄）：真机 WiFi 调试链路已通（§2.2 C5 实测）；**EAS 云构建与 iOS/Xcode 仍不可得**——此两项交付时区分"逻辑层已验证"与"云构建/iOS 层未验证"。状态：已确认的环境事实（当前 Linux 工作机）[实证——2026-09-18 探测 + 2026-09-19 真机实测]。
**PIT-MA-002** [推断待验证] Expo Go 与 dev client 的原生模块差异 → 引入原生模块前查 SDK 兼容表。
**PIT-MA-003** [推断待验证] 8081 端口占用导致 Metro 起不来 → `--port` 显式指定。
**PIT-MA-004** [实证 2026-09-18/19] WSL2 无嵌套虚拟化 → 官方 AVD 报硬件加速错；Waydroid/redroid 需 binder 也排除 → 替代：真机 WiFi 调试（优先，C5）/ QEMU TCG + Android-x86（C4，极慢仅存档）。
**PIT-MA-005** [实证] SourceForge/GitHub 大文件下载限速（单连接 240KB/s 波动 / GitHub CDN 出口级 130KB/s）→ `aria2c -c -x8` 多连接（SF 提速 10 倍）；⚠️ aria2 sparse 预填会骗过 `ls` 表观长度，看 `du` 实际块；curl `-C -` 续传 aria2 稀疏文件会错位（空洞段与续写段交叠），必须全新下载。
**PIT-MA-006** [实证-会话记录] Android-x86 Live 模式 -m 4096 疑似 OOM（bootanimation 后段 VM 自行重启，无 serial 日志存档）→ 6144 仍 2 小时未完 boot（活体由截图差分/root console 物证支撑）：TCG 软件模拟不可用作验证通道，需要模拟器时优先解决 KVM 或用真机。
**PIT-MA-007** [实证] `adb connect` 显示 offline ≠ 失败：Android-x86 的 adbd 在 boot 未完成时就监听 5555，boot_completed=1 前一直 offline——先 `getprop sys.boot_completed` 再判定。
**PIT-MA-008** [实证] Expo Go SDK 大版本必须与项目 expo 依赖一致（57↔57）；Expo CLI 自动装 Expo Go 需 ANDROID_HOME（无 Android SDK 环境用手动 install，C5 序列）；GitHub releases 是唯一官方分发点。
**PIT-MA-009** [实证] 国内 ROM（OPPO ColorOS）adb install 需手机侧确认弹窗/安装权限，streamed install 静默挂起 → 先 push 到 /data/local/tmp 再 pm install，或用户手动装；App 后台/回桌面后 uiautomator dump 拿到的是 launcher 层级——设备层断言前先确认前台态（RN Text 对 uiautomator 可见性未实测，属 [文证：RN 已知特性]）。

## 8. 标杆项目映射

| 项目 | 看什么文件 | 验证什么 | 解析状态 |
|------|-----------|---------|---------|
| t3-oss/create-t3-turbo | `apps/expo/`、`packages/api` | Expo 接 tRPC 类型共享；typecheck 门禁（无单测，如实记录） | B2 已实证 ●（2026-09-18 平台标杆解析） |
| ~~nhonn/react-native-template~~ | — | 已实测 404（REFERENCE_PROJECTS #9） | ✖ 已淘汰，勿解析 |
| react-native-community/template | template.config.js、template package.json、jest.config | RN 官方最小模板；jest 冒烟随模板必绿 | B2 已实证 ●（官方替代） |
| create-expo-app（Expo 官方模板） | package.json、app.json、tsconfig.json | blank-typescript 起跑→真机 Expo Go 预览→设备层断言（§5.3 序列） | **本机实测 ●（2026-09-19：expo 57.0.24 + bun install 444 包 + tsc 0 错 + 真机 708 模块 bundle 14.9s + 断言 3 pass）** |

> 另 `hassaanjamil/rn-expo-posts-app`（REFERENCE_PROJECTS #10）已实测 404，不在映射表；测试闭环真机验证已通（2026-09-19，见头部声明），EAS/iOS 仍盲。

## 9. 常见模式与反模式
| DON'T ❌ | DO ✅ |
|----------|------|
| 无设备环境却宣称"真机已验证" | §5.4 `skipped: no-device` 诚实落盘 |
| 首个移动项目直接上原生模块 | 先 Expo Go 纯 JS 路径，必要时原生模块 Spike |
| 一开始就配 EAS 发布流水线 | 逻辑层闭环（§5.2）先行，发布链路后置 |

---
## CHANGELOG

- v2.3（2026-09-19）：mobile 真机闭环实测回填——WiFi 无线调试组件卡 C5（pair/connect 双端口/mDNS 不透传/OPPO 安装确认坑）、QEMU TCG+Android-x86 无 KVM 替代路线 C4（实测定界：2 小时未完 boot，仅存档）、§2.1/§0.3/头部声明按实测改写（盲区收窄为 EAS/iOS）、§5.3 闭环 B 真机实测序列（Expo Go/reverse/am start/screencap 断言 3 pass + Expo CLI 多设备不容错坑 + 契约 env 透传坑）、坑库 PIT-MA-004~009、§8 增 create-expo-app 实测行；来源：mobile 闭环验证批（平台 v0.17.129）。
- v2.2（2026-09-18）：§5.5 标杆测试闭环并入——jest 冒烟+turbo typecheck 本机门禁（含 create-t3-turbo 无单测盲区标注），证据等级 [文证：标杆实证]；来源：平台知识库《标杆解析-v1/测试闭环汇总》。
- v2.1（2026-09-18）：L2-5 驱动自检骨架——`driver-skeleton.py`/`driver-skeleton.cjs` 随模版分发（五项运行时自检：storyId 非空 / expected-actual 同源 / 输出 schema 校验+退出码表 / 顶层异常包裹 / 环境前置自检）；§5 增骨架引用（desktop-app §5.3 骨架代码段升级为骨架文件引用，三条硬规则保留并标注由骨架承载）。
- v2.0（2026-09-18）：迁移定稿入运行时快照 `nanju-engineering-templates/` 与模版源头 `nanju-guide/09_工程模板/`（平台 v0.17.126）；§8 标杆映射按 B2 标杆解析（2026-09-18，14 仓库实证）回填实测状态、剔除/替代 404 条目。
- v2.0-draft（2026-09-18，草案）：新增 §0/§2（标注本机可验证性列）/§5（双闭环）/§6（环境可用性强制 Spike）/§7（品类级盲区声明）；v1 选型与结构保留沿用。
- v1.0（2026-07-17）：初始 137 行版本。

---

# 附录 A：v1 保留沿用内容（v1.0，2026-07-17）

> 正文引用的「v1 §N」均指本附录内容；v1 与 v2 冲突处以 v2 正文为准。

---

# 移动应用 · 工程模板

> 版本：v1.0 | 代号：`mobile-app` | 适用模式：快消型 & 长期迭代型

---

## 元信息

### 适用场景
- iOS + Android 跨平台移动应用
- 用户说："做个手机 App / 小程序 / 移动端应用"
- 需要相机、GPS、推送等原生能力

### 不适用场景
- 纯 Web 端（响应式网站即可） → 用 `01-web-fullstack`
- 桌面端 → 用 `04-desktop-app`

---

## 1. 技术栈

### 推荐选型

| 层级 | 推荐 | 备选 | 版本 |
|------|------|------|------|
| **框架** | React Native + Expo | Flutter | Expo SDK 54+ |
| **路由** | Expo Router (文件系统路由) | React Navigation | v4+ |
| **样式** | NativeWind (Tailwind CSS for RN) | StyleSheet | v4+ |
| **状态管理** | Zustand + TanStack Query | Redux Toolkit | v5+ |
| **表单** | React Hook Form + Zod | Formik | latest |
| **存储** | MMKV (快速 KV) + expo-sqlite (关系) | AsyncStorage | latest |
| **HTTP** | Axios 或 fetch | — | latest |
| **认证** | expo-auth-session + JWT | Clerk | latest |
| **测试** | Jest + React Native Testing Library | — | latest |
| **E2E** | Detox 或 Maestro | — | latest |

### 为什么 React Native + Expo 而非 Flutter？

对于 AI Agent 生成代码的场景，React Native + Expo 有明显的优势：
- **语言统一**：TypeScript 贯穿前后端，Agent 不需要切换语言
- **Expo 托管**：免配置原生项目，开发体验接近 Web
- **文件系统路由**：Expo Router → 类似 Next.js App Router，Agent 推理更自然
- **生态成熟**：npm 生态直接可用

---

## 2. 目录结构

```
project/
├── .github/workflows/
│   ├── ci.yml                   # lint → typecheck → test
│   └── preview.yml              # EAS Update preview
├── app/                         # Expo Router（文件系统路由）
│   ├── (tabs)/                  # 底部 Tab 导航组
│   │   ├── _layout.tsx          #   Tab 布局
│   │   ├── index.tsx            #   首页 Tab
│   │   ├── discover.tsx         #   发现 Tab
│   │   └── profile.tsx          #   个人 Tab
│   ├── (auth)/                  # 认证相关页面（无 Tab）
│   │   ├── _layout.tsx          #   Auth 布局
│   │   ├── sign-in.tsx
│   │   └── sign-up.tsx
│   ├── post/
│   │   ├── [id].tsx             # 文章详情 /post/123
│   │   └── create.tsx           # 创建文章 /post/create
│   ├── _layout.tsx              # 根布局（providers + auth gate）
│   └── +not-found.tsx           # 404 页面
├── src/
│   ├── components/              # 可复用 UI 组件
│   │   ├── ui/                  #   基础组件（Button, Input, Card, Modal...）
│   │   ├── PostCard.tsx
│   │   └── UserAvatar.tsx
│   ├── hooks/                   # 自定义 hooks
│   │   ├── useAuth.ts
│   │   └── usePosts.ts
│   ├── stores/                  # Zustand stores（客户端状态）
│   │   ├── auth-store.ts
│   │   └── settings-store.ts
│   ├── services/                # API 服务层
│   │   ├── api.ts               #   Axios 实例 + interceptor
│   │   ├── auth.service.ts
│   │   └── post.service.ts
│   ├── lib/                     # 工具函数
│   │   ├── constants.ts
│   │   └── utils.ts
│   └── types/                   # 共享类型定义
│       ├── user.ts
│       └── post.ts
├── assets/                      # 静态资源
│   ├── images/
│   └── fonts/
├── __tests__/                   # 测试
├── app.json                     # Expo 配置
├── tailwind.config.ts           # NativeWind 配置
├── tsconfig.json
├── package.json
├── .env.example
├── .gitignore
└── README.md
```

---

## 3. 开发工作流

```text
1. npx create-expo-app@latest → 选择 TypeScript + Expo Router
2. 安装 NativeWind v4 + Zustand + TanStack Query
3. 配置 app.json（name, slug, scheme, plugins）
4. npx expo start → QR 码扫描在真机测试
5. npx expo start --web → 浏览器快速预览
6. eas build → 生产构建
7. eas submit → 发布到 App Store / Google Play
```

---

## 4. 测试策略

| 层级 | 工具 | 内容 |
|------|------|------|
| 单元测试 | Jest + RNTL | hooks、stores、工具函数 |
| 组件测试 | RNTL | 组件渲染 + 交互 |
| E2E | Detox / Maestro | 关键用户流程 |

---

## 5. 参考项目

| 项目 | 关键借鉴 |
|------|---------|
| [react-native-template (nhonn)](https://github.com/nhonn/react-native-template) | 最全生产模板：NativeWind + Zustand + React Query + i18n + Biome + Lefthook |
| [rn-expo-posts-app](https://github.com/hassaanjamil/rn-expo-posts-app) | Clean Architecture 分层：Domain/Data/Presentation/Main |
| [masterfabric-expo](https://github.com/masterfabric-mobile/masterfabric-expo) | Material Design 3 设计系统 + RTL + 离线支持 |
| [safarnak.app](https://github.com/mohetios/safarnak.app) | 全栈 Expo + Cloudflare Workers + Drizzle + GraphQL |
| [create-t3-turbo](https://github.com/t3-oss/create-t3-turbo) | Web + Mobile 共享 tRPC types 的 monorepo 模式 |

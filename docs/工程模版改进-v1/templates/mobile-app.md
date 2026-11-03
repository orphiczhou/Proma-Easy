# 移动应用 · 工程模板 v2（改进草案）

> 版本：v2.0-draft | 代号：`mobile-app` | 适用模式：快消型 & 长期迭代型
> 证据等级：**[实证]** / **[文证]** / **[推断]**。
> ⚠️ 品类级限制声明：**本品类在当前 Linux 工作机上无法完成真机/模拟器/EAS 云构建的端到端验证**，相关条目全部为 [推断] 或 [文证]，并显式标注"待真机环境验证"。这是六品类中唯一存在**品类级验证盲区**的模版（诚实标注本身是 v2 证据等级规范的要求）。
> 与 v1 关系：v1（`/home/orphic/proma-patches/p1-quick-engineering/apps/electron/resources/nanju-engineering-templates/mobile-app.md`）的 RN+Expo 选型论证、Expo Router 目录结构、开发工作流**保留沿用**。

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
| 快速验证路径 | Expo Go 扫码真机预览（免原生编译） | 需真机+同网段 [推断] |
| 正式交付路径 | v1：Expo SDK 54 + EAS build/submit | EAS 需云账号 [文证] |

## 1. 技术栈矩阵
v1 §1 全表（RN+Expo vs Flutter 论证）保留。[文证]

## 2. 组件环境清单

### 2.1 总览
| 组件 | 用途 | 必装性 | 本机可验证 |
|------|------|--------|:---:|
| Node.js 22 + pnpm | 运行时 | 必须 | ✓ |
| Expo CLI（npx expo） | 开发服务 | 必须 | ✓（服务可起） |
| Android Studio + SDK + 模拟器 | Android 验证 | 按需 | ✗ 待验证 |
| Xcode（仅 macOS） | iOS 验证 | 按需 | ✗ 环境不可得 |
| adb | 设备/模拟器驱动 | Android 按需 | ✗ 待验证 |
| EAS CLI + 账号 | 云构建/提交 | 发布必须 | ✗ 需账号 |

### 2.2 组件卡片（本机可验证部分优先）
**C1 Expo CLI**
- 探测：`npx expo --version`
- 已知坑：`expo start` 需端口 8081/19000+ 通畅；防火墙/Docker 网络会阻断真机扫码 [推断]
- 降级替代：`npx expo start --web` 出 Web 版先验业务逻辑（原生能力除外）[文证：v1 §3 工作流第 5 步]

**C2 Android 模拟器（待验证区）**
- 探测：`avdmanager list avd` / `adb devices`
- 已知坑：Linux 无 KVM 时模拟器极慢；`sdkmanager` 许可证未接受导致装不上 [推断]
- 状态：**待真机/模拟器环境验证**

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

### 5.3 标准闭环 B：真机/模拟器 E2E（待环境验证）[推断]

```bash
# Maestro 流程驱动（需模拟器或真机）
maestro test .maestro/login_flow.yaml           # 证据：Maestro 输出 + 截图
adb exec-out screencap -p > evidence/screen.png  # 补充证据
```

### 5.4 驱动断言规范
- 同串断言：单测/类型检查层严格比对；UI 层用元素存在性断言（Maestro `assertVisible`）而非像素比对 [推断]
- 证据落盘：截图/录屏/测试报告进 `evidence/`；**真机不可得时证据文件必须写明 `skipped: no-device`**，不得以"代码写完了"替代验证 [推断——v2 规范 §5.3 在本品类最重要的应用]

## 6. Spike 实验协议
引用 `../02-Spike实验协议.md`。本品类特有触发点：
- 首个项目开始前：**环境可用性 Spike**（本机能否起 Android 模拟器 / Expo Go 通路是否可用）——建议作为该品类首个强制 Spike [推断]
- 原生模块（需 dev client 而非 Expo Go）的引入判定 [推断]

## 7. 坑库
**PIT-MA-001** 品类级验证盲区：真机/模拟器/EAS 在当前工作环境不可得 → 环境可用性 Spike 前置；交付时区分"逻辑层已验证"与"原生层未验证"。状态：**已确认的环境事实**（当前 Linux 工作机）[实证——环境探测结论]。
**PIT-MA-002** [推断待验证] Expo Go 与 dev client 的原生模块差异 → 引入原生模块前查 SDK 兼容表。
**PIT-MA-003** [推断待验证] 8081 端口占用导致 Metro 起不来 → `--port` 显式指定。

## 8. 标杆项目映射

| 项目 | 看什么文件 | 验证什么 | 解析状态 |
|------|-----------|---------|---------|
| t3-oss/create-t3-turbo | `apps/expo/`、`packages/api` | Expo 接 tRPC 类型共享 | 待下载待解析 |
| nhonn/react-native-template | 组件库 variant 系统、lefthook 配置 | 生产模板基准 | 待下载待解析 |

## 9. 常见模式与反模式
| DON'T ❌ | DO ✅ |
|----------|------|
| 无设备环境却宣称"真机已验证" | §5.4 `skipped: no-device` 诚实落盘 |
| 首个移动项目直接上原生模块 | 先 Expo Go 纯 JS 路径，必要时原生模块 Spike |
| 一开始就配 EAS 发布流水线 | 逻辑层闭环（§5.2）先行，发布链路后置 |

---
## CHANGELOG
- v2.0-draft（2026-09-18）：新增 §0/§2（标注本机可验证性列）/§5（双闭环）/§6（环境可用性强制 Spike）/§7（品类级盲区声明）；v1 选型与结构保留沿用。
- v1.0（2026-07-17）：初始 137 行版本。

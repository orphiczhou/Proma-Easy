# 移动应用 · 工程模板 v2

> 版本：v2.0 | 代号：`mobile-app` | 适用模式：快消型 & 长期迭代型
> 证据等级：**[实证]** / **[文证]** / **[推断]**。
> ⚠️ 品类级限制声明：**本品类在当前 Linux 工作机上无法完成真机/模拟器/EAS 云构建的端到端验证**，相关条目全部为 [推断] 或 [文证]，并显式标注"待真机环境验证"。这是六品类中唯一存在**品类级验证盲区**的模版（诚实标注本身是 v2 证据等级规范的要求）。
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
引用 `02-Spike实验协议.md`。本品类特有触发点：
- 首个项目开始前：**环境可用性 Spike**（本机能否起 Android 模拟器 / Expo Go 通路是否可用）——建议作为该品类首个强制 Spike [推断]
- 原生模块（需 dev client 而非 Expo Go）的引入判定 [推断]

## 7. 坑库
**PIT-MA-001** 品类级验证盲区：真机/模拟器/EAS 在当前工作环境不可得 → 环境可用性 Spike 前置；交付时区分"逻辑层已验证"与"原生层未验证"。状态：**已确认的环境事实**（当前 Linux 工作机）[实证——环境探测结论]。
**PIT-MA-002** [推断待验证] Expo Go 与 dev client 的原生模块差异 → 引入原生模块前查 SDK 兼容表。
**PIT-MA-003** [推断待验证] 8081 端口占用导致 Metro 起不来 → `--port` 显式指定。

## 8. 标杆项目映射

| 项目 | 看什么文件 | 验证什么 | 解析状态 |
|------|-----------|---------|---------|
| t3-oss/create-t3-turbo | `apps/expo/`、`packages/api` | Expo 接 tRPC 类型共享；typecheck 门禁（无单测，如实记录） | B2 已实证 ●（2026-09-18 平台标杆解析） |
| ~~nhonn/react-native-template~~ | — | 已实测 404（REFERENCE_PROJECTS #9） | ✖ 已淘汰，勿解析 |
| react-native-community/template | template.config.js、template package.json、jest.config | RN 官方最小模板；jest 冒烟随模板必绿 | B2 已实证 ●（官方替代） |

> 另 `hassaanjamil/rn-expo-posts-app`（REFERENCE_PROJECTS #10）已实测 404，不在映射表；测试闭环本机验证仍是品类级盲区（见头部声明）。

## 9. 常见模式与反模式
| DON'T ❌ | DO ✅ |
|----------|------|
| 无设备环境却宣称"真机已验证" | §5.4 `skipped: no-device` 诚实落盘 |
| 首个移动项目直接上原生模块 | 先 Expo Go 纯 JS 路径，必要时原生模块 Spike |
| 一开始就配 EAS 发布流水线 | 逻辑层闭环（§5.2）先行，发布链路后置 |

---
## CHANGELOG
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

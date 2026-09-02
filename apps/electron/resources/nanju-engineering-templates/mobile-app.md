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

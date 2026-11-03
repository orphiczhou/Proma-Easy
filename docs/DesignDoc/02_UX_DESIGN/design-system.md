# 平台设计系统

> 项目：向导Agent与编程Agent多智能体协同开发平台
> 文档ID：DOC-2.4
> 版本：v0.3 | 日期：2026-06-05 | 状态：审计收敛
> 依赖：6个HTML原型已全部完成（模式选择页、快消型工作区、长期迭代型工作区、我的项目、设置、分析看板）
> 方法：从全部6个已验证原型中提炼Token，跨页面交叉验证，多数页面一致的值纳入标准，单页面特例标注为"变体"

---

## 1. 色彩系统

### 1.1 品牌色

| Token | 值 | 色块 | 作用域 | 验证来源 |
|-------|-----|------|--------|---------|
| `--color-primary` | `#4F46E5` | ■ | 主色：卡片hover边框、主按钮背景、badge、spinner高亮、选中态、侧栏激活项 | 全部6页 |
| `--color-primary-hover` | `#4338CA` | ■ | 主按钮hover/active背景 | 全部6页 |
| `--color-primary-shadow` | `rgba(79, 70, 229, 0.35)` | — | 主按钮/badge投影色、filter-select聚焦阴影 | 模式选择、我的项目、设置、分析看板 |
| `--color-primary-subtle` | `rgba(79, 70, 229, 0.06)` | — | 文字按钮hover背景、卡片标签背景、工具栏按钮hover、sidebar tab hover | 全部6页 |
| `--color-primary-subtle-active` | `rgba(79, 70, 229, 0.12)` | — | 文字按钮active背景、researcher标签背景 | 分析看板、模式选择（原推断→已验真） |
| `--color-primary-shadow-focus` | `rgba(79, 70, 229, 0.12)` | — | 输入框focus glow、textarea focus glow [新增·验证于设置页/分析看板] | 设置、分析看板 |

### 1.2 语义色

| Token | 值 | 色块 | 作用域 | 验证来源 |
|-------|-----|------|--------|---------|
| `--color-success` | `#059669` | ■ | 成功图标描边、完成状态、GWT通过标记、状态圆点 | 全部6页 |
| `--color-success-bg` | `#ECFDF5` | ■ | 成功图标圆形背景、success Toast背景、长期项目badge背景 | 全部6页 |
| `--color-warning` | `#D97706` | ■ | 警告图标/边框（语义复用同`--color-error-amber`） | 快消/长期工作区、分析看板 |
| `--color-warning-bg` | `#FEF3C7` | ■ | warning Toast背景 | 快消工作区 |
| `--color-danger` | `#DC2626` | ■ | 危险操作按钮、删除确认、异常标记 | 我的项目、设置、分析看板 |
| `--color-danger-bg` | `#FEE2E2` | ■ | 危险操作按钮背景、danger-zone边框 | 我的项目、设置 |
| `--color-danger-hover` | `#B91C1C` | ■ | 危险按钮hover背景 [新增] | 我的项目、设置 |
| `--color-error-amber` | `#D97706` | ■ | 错误/回滚/超时Toast图标与边框、测试失败计数 | 快消/长期工作区、分析看板 |
| `--color-error-amber-bg` | `#FEF3C7` | ■ | 错误/回滚/超时Toast背景、横幅背景 | 快消/长期工作区 |
| `--color-info` | `#3B82F6` | ■ | 信息通知图标 | 快消/长期工作区、我的项目、设置 |
| `--color-info-bg` | `#DBEAFE` | ■ | 信息Toast背景、实验完成badge | 快消/长期工作区、我的项目、设置、分析看板 |

### 1.3 中性色——背景与表面

| Token | 值 | 色块 | 作用域 | 验证来源 |
|-------|-----|------|--------|---------|
| `--color-bg` | `#1E1E2E` | ■ | 页面深色背景（模式选择页、分析看板侧栏全局底） | 模式选择、分析看板 |
| `--color-bg-workspace` | `#F9FAFB` | ■ | 工作区浅色背景、我的项目页背景、设置页内容区背景 | 快消/长期工作区、我的项目、设置、分析看板 |
| `--color-surface` | `#FFFFFF` | ■ | 卡片/对话框/消息气泡（我方）/工具栏/设置区块 | 全部6页 |
| `--color-surface-alt` | `#F3F4F6` | ■ | 消息气泡（Agent方）、状态栏背景、预览区mock背景、dialog取消按钮 | 快消/长期工作区、我的项目、设置 |
| `--color-overlay` | `rgba(0, 0, 0, 0.55)` | — | 遮罩层（对话框/时间轴面板/确认弹窗背后） | 全部6页 |
| `--color-popup-bg` | `#2A2A3E` | ■ | 帮助弹窗/深色弹出面板背景（原型保留未使用） | 模式选择、我的项目、设置 |
| `--color-bg-secondary` | `#F3F4F6` | ■ | 次要按钮背景、filter-tabs背景、搜索框背景、禁用输入框背景 | 全部6页 |
| `--color-bg-secondary-hover` | `#E5E7EB` | ■ | 次要按钮hover背景、filter-tab hover | 全部6页 |

### 1.4 中性色——文字

| Token | 值 | 色块 | 作用域 | 验证来源 |
|-------|-----|------|--------|---------|
| `--color-text` | `#111827` | ■ | 主要文字 | 全部6页 |
| `--color-text-secondary` | `#6B7280` | ■ | 次要文字（示例说明、辅助信息、时间戳、状态栏文案） | 全部6页 |
| `--color-text-tertiary` | `#9CA3AF` | ■ | 三级文字（占位符、禁用态、未生成文档、图表轴线标签） | 全部6页 |
| `--color-text-on-dark-heading` | `#FFFFFF` | — | 深色背景上的标题 | 模式选择、分析看板 |
| `--color-text-on-dark` | `rgba(255, 255, 255, 0.88)` | — | 深色背景上的正文 | 模式选择、分析看板 |
| `--color-text-on-dark-subtle` | `rgba(255, 255, 255, 0.55)` | — | 深色背景上的副标题、sidebar tab默认文字 | 模式选择、分析看板 |
| `--color-text-on-dark-muted` | `rgba(255, 255, 255, 0.40)` | — | 深色背景上的引导提示/禁用文字/版本号、sidebar标签/页脚 | 模式选择、分析看板 |
| `--color-text-on-dark-loading` | `rgba(255, 255, 255, 0.65)` | — | 加载状态文字 | 模式选择（推断→原型保留） |

### 1.5 中性色——边框

| Token | 值 | 色块 | 作用域 | 验证来源 |
|-------|-----|------|--------|---------|
| `--color-border` | `#E5E7EB` | ■ | 通用边框、分割线、spinner底色、时间轴连线、图表网格线 | 全部6页 |
| `--color-border-light` | `rgba(255, 255, 255, 0.25)` | — | 深色背景上帮助按钮默认边框 | 模式选择 |
| `--color-border-light-hover` | `rgba(255, 255, 255, 0.55)` | — | 深色背景上帮助按钮hover边框 | 模式选择 |
| `--color-border-focus` | `#4F46E5` | ■ | 输入框聚焦边框（同`--color-primary`） | 快消/长期工作区、我的项目、设置、分析看板 |

### 1.6 图表色板（分析看板专用）[新增]

| Token | 值 | 色块 | 作用域 |
|-------|-----|------|--------|
| `--chart-1` | `#4F46E5` | ■ | 主色柱/线图（同品牌色） |
| `--chart-2` | `#059669` | ■ | 绿色段/编码阶段饼图（同成功色） |
| `--chart-3` | `#D97706` | ■ | 琥珀色段/测试阶段饼图（同warning色） |
| `--chart-4` | `#3B82F6` | ■ | 蓝色段/UX设计饼图（同info色） |
| `--chart-5` | `#DC2626` | ■ | 红色/放弃率/异常标记（同danger色） |
| `--chart-6` | `#8B5CF6` | ■ | 紫色/混合型数据项 |
| `--chart-7` | `#EC4899` | ■ | 粉色（备用） |
| `--chart-8` | `#14B8A6` | ■ | 青色（备用） |
| `--chart-9` | `#F59E0B` | ■ | 琥珀黄（备用） |
| `--chart-10` | `#6366F1` | ■ | 靛蓝（备用） |

---

## 2. 字体系统

### 2.1 字体栈

系统原生字体栈，无外部Web字体加载：

```
font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
             "PingFang SC", "Microsoft YaHei",
             "Helvetica Neue", sans-serif;
```

**特殊字体**：帮助按钮`?`字符使用 `"Times New Roman", serif`；代码路径使用等宽栈 `"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace`。

### 2.2 字号层级——主平台

| Token | 值 | 用途 | 响应式降级 | 验证来源 |
|-------|-----|------|-----------|---------|
| `--font-size-hero` | `36px` | 页面主标题H1 | ≤860px: `28px` | 模式选择 |
| `--font-size-loading-title` | `32px` | 加载页标题 | — | 原型保留[推断] |
| `--font-size-section-title` | `24px` | 区块标题、对话框标题 | ≤860px: `22px`(项目页) | 我的项目、设置 |
| `--font-size-card-title` | `22px` | 卡片标题H2 | ≤480px: `19px` | 模式选择、设置 |
| `--font-size-body` | `16px` | 正文、消息气泡内容、聊天输入 | — | 全部6页 |
| `--font-size-subtitle` | `15px` | 卡片描述、按钮文字、加载文字 | ≤480px: `14px` | 全部6页 |
| `--font-size-caption` | `14px` | 引导提示、状态栏文案、时间轴描述 | — | 全部6页 |
| `--font-size-small` | `13.5px` | 卡片示例说明、文档树节点、预览header | — | 全部6页 |
| `--font-size-badge` | `12px` | Badge、标签、timeline-time | — | 全部6页 |
| `--font-size-confirm-msg` | `17px` | 确认对话框消息 | ≤480px: `15px` | 模式选择、设置 |

### 2.3 字号层级——后台分析看板（变体）

分析看板使用更紧凑的字号以容纳密集数据。该变体通过独立`:root`覆盖实现，不影响主平台。

| Token | 后台看板值 | 主平台值 | 差异 |
|-------|-----------|---------|------|
| `--font-size-hero` | `28px` | `36px` | -8px |
| `--font-size-section-title` | `22px` | `24px` | -2px |
| `--font-size-card-title` | `20px` | `22px` | -2px |
| `--font-size-body` | `15px` | `16px` | -1px |
| `--font-size-subtitle` | `14px` | `15px` | -1px |
| `--font-size-caption` | `13px` | `14px` | -1px |
| `--font-size-small` | `12px` | `13.5px` | -1.5px |
| `--font-size-badge` | `11px` | `12px` | -1px |

### 2.4 字重

| Token | 值 | 作用域 | 验证来源 |
|-------|-----|--------|---------|
| `--font-weight-bold` | `700` | H1、H2标题、section标题、stat-value | 全部6页 |
| `--font-weight-semibold` | `600` | 按钮文字、Badge、帮助按钮`?`、工具栏品牌名、卡片名称 | 全部6页 |
| `--font-weight-medium` | `500` | 确认消息、完成状态描述、消息发送者名、filter-tab、context-menu项 | 全部6页 |
| `--font-weight-regular` | `400` | 副标题、卡片描述、引导提示、正文、示例文字 | 全部6页 |

### 2.5 字间距

| Token | 值 | 作用域 | 验证来源 |
|-------|-----|--------|---------|
| `--letter-spacing-title` | `2px` | 页面标题（模式选择页Header、分析看板top-bar h1） | 模式选择、分析看板 |
| `--letter-spacing-loading` | `1px` | 加载页标题 | 原型保留[推断] |
| `--letter-spacing-normal` | `0` | 正文/默认 | 设置 |
| `--letter-spacing-badge` | `0.5px` | Badge文字、表格表头 [新增] | 模式选择、分析看板 |
| `--letter-spacing-section` | `1px` | 侧栏分区标签、范式rank标签 [新增] | 分析看板 |

---

## 3. 间距与尺寸

### 3.1 圆角

| Token | 值 | 作用域 | 验证来源 |
|-------|-----|--------|---------|
| `--radius-sm` | `6px` | 按钮、输入框、Toast、工具栏按钮、filter-tab | 全部6页 |
| `--radius-md` | `8px` | 卡片、消息气泡、帮助弹窗、时间轴面板、内嵌卡片、预览mock | 全部6页 |
| `--radius-lg` | `12px` | 对话框、Badge（胶囊形）、下拉面板、特色卡片、stat-card、chart-card | 全部6页 |
| `--radius-bar` | `4px` | 柱状图柱子、水平进度条 [新增] | 分析看板 |
| `--radius-full` | `50%` | 帮助按钮、spinner、图标圆形背景、头像、色块选择器 | 全部6页 |

### 3.2 阴影

| Token | 值 | 作用域 | 验证来源 |
|-------|-----|--------|---------|
| `--shadow-card` | `0 4px 20px rgba(0, 0, 0, 0.08)` | 卡片默认（主平台） | 模式选择、快消工作区、设置 |
| `--shadow-card-hover` | `0 12px 36px rgba(0, 0, 0, 0.18)` | 卡片hover | 全部6页 |
| `--shadow-card-analytics` | `0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06)` | 分析看板stat-card/chart-card [新增·变体] | 分析看板 |
| `--shadow-dialog` | `0 24px 64px rgba(0, 0, 0, 0.35)` | 对话框/模态面板/quick-options | 全部6页 |
| `--shadow-popup` | `0 8px 28px rgba(0, 0, 0, 0.40)` | 帮助弹窗/下拉菜单/context-menu | 我的项目、设置、模式选择 |
| `--shadow-toast` | `0 4px 16px rgba(0, 0, 0, 0.12)` | Toast通知 | 快消/长期工作区、我的项目、设置 |
| `--shadow-badge` | `0 2px 8px rgba(79, 70, 229, 0.35)` | Badge | 模式选择 |
| `--shadow-btn-primary` | `0 4px 14px rgba(79, 70, 229, 0.35)` | 主按钮hover | 全部6页 |
| `--shadow-btn-danger` | `0 4px 14px rgba(220, 38, 38, 0.30)` | 危险按钮hover [新增] | 设置 |
| `--shadow-help-btn-hover` | `0 0 0 3px rgba(255, 255, 255, 0.12)` | 帮助按钮hover扩散光晕 | 模式选择 |
| `--shadow-timeline-panel` | `-4px 0 24px rgba(0, 0, 0, 0.15)` | 时间轴滑出面板 | 快消/长期工作区 |
| `--shadow-banner` | `0 2px 12px rgba(0, 0, 0, 0.10)` | 横幅 | 快消/长期工作区 |
| `--shadow-input-focus` | `0 0 0 3px rgba(79, 70, 229, 0.12)` | 输入框/textarea聚焦外发光 [新增] | 设置、分析看板 |
| `--shadow-filter-tab` | `0 1px 3px rgba(0, 0, 0, 0.08)` | filter-tab.active阴影 [新增] | 我的项目 |
| `--shadow-sidebar-tab-active` | `0 2px 8px rgba(79,70,229,0.3)` | 侧栏激活tab投影 [新增] | 分析看板 |

### 3.3 内间距

| Token | 值 | 作用域 | 响应式 |
|-------|-----|--------|--------|
| `--padding-page` | `40px 24px` | 页面级内间距 | ≤480px: `24px 16px` |
| `--padding-card` | `36px 32px 32px` | 卡片内边距（标准） | ≤860px: `28px 24px 24px`, ≤480px: `24px 20px 20px` |
| `--padding-card-compact` | `28px 28px 28px` | 项目卡片内边距 [新增·变体] | ≤600px: `20px` |
| `--padding-card-analytics` | `20px 24px 24px` | 分析看板卡片内边距 [新增·变体] | — |
| `--padding-dialog` | `36px 40px 32px` | 对话框内边距 | ≤860px: `28px 24px` |
| `--padding-btn` | `10px 32px` | 按钮内边距 | ≤480px: `9px 24px` |
| `--padding-btn-sm` | `6px 16px` | 小按钮内边距（横幅按钮、chart-card按钮） | — |
| `--padding-btn-analytics` | `8px 20px` | 分析看板按钮内边距 [新增·变体] | — |
| `--padding-btn-sm-analytics` | `5px 12px` | 分析看板小按钮内边距 [新增·变体] | — |
| `--padding-popup` | `14px 20px` | 帮助弹窗内边距 | — |
| `--padding-badge` | `3px 12px` | Badge内边距 | — |
| `--padding-input` | `10px 14px` | 输入框内边距 | — |
| `--padding-input-analytics` | `8px 12px` | 分析看板输入框内边距 [新增·变体] | — |
| `--padding-msg-bubble` | `12px 16px` | 消息气泡内边距 | — |
| `--padding-toast` | `12px 20px` | Toast内边距 | — |
| `--padding-dialog-state` | `8px 0` | 对话框内部状态间距 | — |
| `--padding-context-menu` | `6px` | context-menu内边距 [新增] | — |
| `--padding-content-section` | `var(--padding-card)` | 设置页内容区块内边距 [新增·复用] | — |
| `--padding-chart-card-body` | `20px` | chart-card内容区内边距 [新增] | ≤480px: `14px` |

### 3.4 外边距与间距

| Token | 值 | 作用域 | 响应式 |
|-------|-----|--------|--------|
| `--margin-header-bottom` | `48px` | Header下方间距（模式选择页） | ≤860px: `32px` |
| `--margin-header-bottom-compact` | `32px` | Header下方间距（项目页/设置页变体） | — |
| `--margin-card-title-bottom` | `10px` | 卡片标题与描述间距 | — |
| `--margin-card-desc-bottom` | `16px` | 卡片描述与示例间距 | — |
| `--margin-guidance-top` | `44px` | 引导提示上方间距 | ≤860px: `32px` |
| `--margin-confirm-msg-bottom` | `28px` | 确认消息下方间距 | — |
| `--margin-loading-title-bottom` | `16px` | 加载页标题下方间距 | — |
| `--margin-section-bottom` | `20px` | 内容区块之间间距 [新增] | — |
| `--gap-cards` | `28px` | 卡片之间间距（标准） | ≤860px: `20px` |
| `--gap-cards-compact` | `24px` | 项目网格卡片间距 [新增·变体] | ≤600px: `16px` |
| `--gap-cards-analytics` | `20px` | 分析看板卡片间距 [新增·变体] | — |
| `--gap-btn-group` | `14px` | 按钮组间距 | — |
| `--gap-btn-group-analytics` | `10px` | 分析看板按钮组间距 [新增·变体] | — |
| `--gap-loading-text` | `12px` | 加载文字与spinner间距 | — |
| `--gap-dialog-states` | `14px` | 对话框内部状态间距 | — |
| `--gap-chat-msg` | `16px` | 聊天消息间距 | — |
| `--gap-option-cards` | `12px` | 卡片选项组间距 | — |
| `--gap-form` | `16px` | 表单字段间距 | — |
| `--gap-form-analytics` | `14px` | 分析看板表单项间距 [新增·变体] | — |
| `--gap-filter-tab-group` | `3px` | filter-tabs内部padding [新增] | — |
| `--gap-toolbar-items` | `16px` | 工具栏元素间距 [新增] | 快消/长期工作区 |
| `--gap-table-header` | `12px` | 项目卡片底部元信息间距 [新增] | 我的项目 |

### 3.5 尺寸

| Token | 值 | 作用域 | 验证来源 |
|-------|-----|--------|---------|
| `--width-card` | `380px` | 卡片宽度 | ≤860px: `420px` (max 85vw) | 模式选择 |
| `--width-dialog` | `460px` | 对话框宽度 | max 90vw | 全部6页 |
| `--width-timeline-panel` | `360px` | 时间轴面板宽度 | — | 快消/长期工作区 |
| `--width-sidebar` | `220px` | 分析看板侧栏宽度 [新增] | ≤860px: `60px`(折叠) | 分析看板 |
| `--width-sidebar-collapsed` | `60px` | 分析看板侧栏折叠宽度 [新增] | — | 分析看板 |
| `--width-content-max` | `1200px` | 内容区最大宽度（项目页/设置页居中） [新增] | — | 我的项目 |
| `--width-chat-input` | `100%` | 聊天输入区宽度 | — | 快消/长期工作区(推断) |
| `--width-popup-max` | `260px` | 帮助弹窗最大宽度 | — | 模式选择 |
| `--width-quick-options` | `240px` | 快速选项面板宽度 [新增] | min `240px`, max `300px` | 快消/长期工作区 |
| `--width-context-menu-min` | `160px` | 右键菜单最小宽度 [新增] | — | 我的项目 |
| `--width-chat-panel` | `38%` | 长期工作区聊天面板宽度 [新增] | min `320px` | 长期工作区 |
| `--width-doc-panel` | `22%` | 文档面板宽度 [新增] | min `220px` | 长期工作区 |
| `--size-help-btn` | `38px` | 帮助按钮宽高 | — | 模式选择 |
| `--size-check-icon` | `48px` | 完成图标容器 | — | 模式选择、设置 |
| `--size-check-svg` | `24px` | 完成勾SVG | — | 模式选择、设置 |
| `--size-spinner-loading` | `22px` | 加载页spinner | — | 原型保留(推断) |
| `--size-spinner-dialog` | `32px` | 对话框spinner | — | 设置 |
| `--size-spinner-sm` | `16px` | 行内小spinner、Toast spinner | — | 快消工作区 |
| `--size-avatar` | `32px` | 消息气泡头像 | — | (推断) |
| `--size-icon-btn` | `36px` | 图标按钮（工具栏、返回按钮） | — | 快消工作区、我的项目 |
| `--size-color-swatch` | `32px` | 颜色选择色块 [新增] | — | 快消工作区 |
| `--size-empty-state-icon` | `72px` | 空状态图标容器 [新增] | — | 我的项目 |
| `--size-dialog-icon-wrap` | `56px` | 对话框警示图标容器 [新增] | — | 我的项目、设置 |
| `--size-svg-icon` | `18px` | 标准SVG图标（按钮内联） [新增] | — | 我的项目、设置、分析看板 |
| `--size-svg-icon-sm` | `14px` | 小SVG图标（badge内、mode-badge） [新增] | — | 我的项目 |
| `--size-svg-icon-lg` | `26px` | 大SVG图标（空状态、dialog icon） [新增] | — | 我的项目 |
| `--size-tab-indicator` | `3px` | tab-btn.active左侧指示条宽度 [新增] | — | 设置 |
| `--size-timeline-node` | `12px` | 时间轴节点圆点直径 [新增] | — | 长期工作区 |
| `--size-dot` | `6px` | 状态圆点直径 [新增] | — | 快消/长期工作区 |
| `--size-donut-chart` | `180px` | 环形图直径 [新增] | — | 分析看板 |
| `--height-header` | `56px` | 工具栏高度 | — | 快消/长期工作区、我的项目、设置 |
| `--height-input-min` | `44px` | 聊天输入区最小高度 | — | 快消/长期工作区 |
| `--height-status-bar` | `32px` | 状态栏高度 [新增] | — | 快消/长期工作区 |
| `--height-preview-header` | `36px` | 预览区标题栏高度 [新增] | — | 快消/长期工作区 |

---

## 4. 动效系统

### 4.1 持续时间

| Token | 值 | 作用域 | 验证来源 |
|-------|-----|--------|---------|
| `--duration-instant` | `50ms` | 卡片active压缩态 | 模式选择 |
| `--duration-fast` | `150ms` | 卡片点击回弹、Toast滑入、高亮框出现、popIn动画、sidebar hover | 全部6页 |
| `--duration-normal` | `180ms` | 按钮状态切换、消息气泡出现、hover过渡、tab切换 | 全部6页 |
| `--duration-slow` | `200ms` | 卡片hover、帮助弹窗显隐、面板切换、fadeIn | 模式选择、快消工作区、设置 |
| `--duration-overlay` | `250ms` | 遮罩/对话框/时间轴面板显隐、文档面板滑出 | 快消/长期工作区、设置 |
| `--duration-loading` | `600ms` | 加载页渐隐消失 | —(原型保留) |
| `--duration-bar-chart` | `400ms` | 柱状图高度过渡 [新增] | 分析看板 |

### 4.2 缓动函数

| Token | 值 | 作用域 |
|-------|-----|--------|
| `--ease-default` | `ease` | 通用 |
| `--ease-bounce` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | 卡片点击回弹、Toast弹入、popIn、消息入场 |
| `--ease-smooth` | `cubic-bezier(0.4, 0, 0.2, 1)` | 面板滑出/滑入、对话框缩放、文档面板过渡 |

### 4.3 过渡属性模板

| 组件 | 过渡 | 说明 |
|------|-------|------|
| `.card` (主平台) | `border-color --duration-slow --ease-default, box-shadow --duration-slow --ease-default, transform --duration-slow --ease-default` | 三属性并行 |
| `.project-card` | `同.card`，但hover `translateY(-3px)` | 项目页卡片变体 |
| `.btn` | `all --duration-normal --ease-default` | 全属性 |
| `.overlay` | `opacity --duration-overlay --ease-default, visibility --duration-overlay --ease-default` | 显隐 |
| `.dialog` | `transform --duration-overlay --ease-default` + `opacity` | 入场缩放 |
| `.popup` / `.quick-options` | `opacity --duration-slow --ease-default, visibility --duration-slow --ease-default, transform --duration-slow --ease-default` | 显隐+位移/缩放 |
| `.timeline-panel` | `transform --duration-overlay --ease-smooth` | 右侧滑入/滑出 |
| `.toast` | `opacity --duration-fast --ease-bounce, transform --duration-fast --ease-bounce` | 底部弹入+自动消失 |
| `.loading-screen` | `opacity --duration-loading --ease-default, visibility --duration-loading --ease-default` | 渐隐 |
| `.doc-panel` | `width --duration-overlay --ease-smooth, opacity --duration-overlay --ease-smooth` | 左侧展开/收起 |
| `.bar` (chart) | `height --duration-bar-chart --ease-smooth` | 柱状图高度动画 [新增] |
| `.context-menu` | `opacity --duration-fast --ease-default, transform --duration-fast --ease-default` | 下拉出现 [新增] |
| `.tab-panel` | `opacity --duration-slow --ease-default, transform --duration-slow --ease-default` | Tab内容区切换淡入 [新增] |

---

## 5. 组件样式

### 5.1 卡片（.card）——模式选择页

| 状态 | 边框 | 背景 | 阴影 | 变换 | 过渡 |
|------|------|------|------|------|------|
| **default** | `2px solid transparent` | `--color-surface` | `--shadow-card` | 无 | — |
| **hover** | `2px solid --color-primary` | `--color-surface` | `--shadow-card-hover` | `translateY(-5px)` | 200ms ease |
| **active**（按下） | 继承hover | 继承hover | 继承hover | `scale(0.97)`→`scale(1)` 回弹 | 50ms+150ms bounce |
| **selected** | `2px solid --color-primary` | `rgba(79,70,229,0.05)` | `0 4px 12px rgba(79,70,229,0.15)` | 无 | 200ms ease |

### 5.2 项目卡片（.project-card）——我的项目页变体 [新增]

| 状态 | 边框 | 阴影 | 变换 |
|------|------|------|------|
| **default** | `1.5px solid transparent` | `--shadow-card` | 无 |
| **hover** | `1.5px solid --color-primary` | `--shadow-card-hover` | `translateY(-3px)` |
| **active** | 继承hover | 继承hover | `scale(0.98)` |

内结构：
```
┌─────────────────────────────────┐
│  [mode-badge]    [⋯ menu-btn]   │ ← top row
│  项目名称 (--font-size-body,    │
│    --font-weight-semibold)       │
│  项目摘要 (--font-size-small,   │
│    --color-text-secondary)       │
│  📅 日期  🕐 最近活动  [状态]   │ ← meta row
└─────────────────────────────────┘
```

### 5.3 按钮

#### 主按钮（.btn-primary）

| 状态 | 背景 | 文字色 | 阴影 |
|------|------|--------|------|
| **default** | `--color-primary` | `#FFFFFF` | 无 |
| **hover** | `--color-primary-hover` | `#FFFFFF` | `--shadow-btn-primary` |
| **active** | 压暗5%（等效`#3730A3`） | `#FFFFFF` | 无 |
| **disabled** | `--color-primary` (opacity 0.5) | `rgba(255,255,255,0.5)` | 无 |

#### 次要按钮（.btn-secondary）

| 状态 | 背景 | 文字色 |
|------|------|--------|
| **default** | `--color-bg-secondary` | `--color-text` |
| **hover** | `--color-bg-secondary-hover` | `--color-text` |
| **active** | `#D1D5DB` | `--color-text` |
| **disabled** | `#F9FAFB` | `rgba(17,24,39,0.35)` |

#### 文字按钮（.btn-text）

| 状态 | 背景 | 文字色 |
|------|------|--------|
| **default** | 透明 | `--color-text-on-dark-subtle`(深色背景) / `--color-primary`(浅色背景) |
| **hover** | `rgba(255,255,255,0.08)`(深色) / `--color-primary-subtle`(浅色) | `--color-text-on-dark`(深色) / `--color-primary-hover`(浅色) |
| **active** | `--color-primary-subtle-active` | `--color-primary-hover` |
| **disabled** | 透明 | `rgba(79,70,229,0.35)` |

#### 虚线按钮（.btn-dashed）/"你帮我决定"

| 状态 | 边框 | 背景 | 文字色 |
|------|------|------|--------|
| **default** | `2px dashed --color-border`（option-card为`1.5px dashed`） | 透明 | `--color-text-secondary` |
| **hover** | `2px dashed --color-primary` | `--color-primary-subtle` | `--color-primary` |

#### 幽灵按钮（.btn-ghost）[新增·我的项目页]

| 状态 | 边框 | 背景 | 文字色 |
|------|------|------|--------|
| **default** | `1.5px dashed --color-border` | 透明 | `--color-primary` |
| **hover** | `1.5px dashed --color-primary` | `--color-primary-subtle` | `--color-primary-hover` |

#### 危险按钮（.btn-danger）[新增·我的项目页/设置页]

| 状态 | 背景 | 文字色 | 阴影 |
|------|------|--------|------|
| **default** | `--color-danger` | `#FFFFFF` | 无 |
| **hover** | `--color-danger-hover` | `#FFFFFF` | `--shadow-btn-danger` |
| **active** | `--color-danger-hover`（压暗） | `#FFFFFF` | 无 |

#### 轮廓按钮（.btn-outline）[新增·分析看板]

| 状态 | 边框 | 背景 | 文字色 |
|------|------|------|--------|
| **default** | `1px solid --color-border` | 透明 | `--color-text-secondary` |
| **hover** | `1px solid --color-text-secondary` | 透明 | `--color-text` |

#### 成功按钮（.btn-success）[新增·分析看板]

| 状态 | 背景 | 文字色 |
|------|------|--------|
| **default** | `--color-success` | `#FFFFFF` |
| **hover** | `#047857` | `#FFFFFF` |

按钮通用属性：`border-radius: --radius-sm`, `font-size: --font-size-subtitle`（主平台，分析看板用 `--font-size-small`）, `font-weight: --font-weight-semibold`, `transition: all 180ms ease`.

### 5.4 输入框（.input / .chat-input）

| 状态 | 边框 | 背景 | 文字色 | 占位符色 |
|------|------|------|--------|---------|
| **default** | `1px solid --color-border` | `--color-surface` | `--color-text` | `--color-text-tertiary` |
| **hover** | `1px solid --color-text-secondary` | `--color-surface` | — | — |
| **focus** | `1px solid --color-border-focus` | `--color-surface` | — | — |
| **focus glow** | — | — | — | `box-shadow: --shadow-input-focus` [新增·设置/分析看板] |
| **disabled** | `1px solid --color-border` | `--color-bg-secondary` | `--color-text-tertiary` | — |

通用属性：`border-radius: --radius-sm`, `padding: --padding-input`, `font-size: --font-size-body`.

#### 搜索框（.search-box）[新增·我的项目页]

```
┌─────────────────────────────────┐
│ 🔍 输入文字...                    │
└─────────────────────────────────┘
  padding: 9px 14px 9px 36px (含图标位)
  搜索图标: absolute, left 12px, --color-text-tertiary
  max-width: 300px
```

#### 筛选下拉框（.filter-select）[新增·分析看板]

```
┌───────────────────────────▼──┐
│ 近30天                       │
└──────────────────────────────┘
  appearance: none
  自定义下拉箭头SVG (base64编码, color #6B7280)
  padding: 7px 30px 7px 12px
  focus: border-color + --shadow-input-focus
```

### 5.5 对话框（.dialog）

```
.overlay (fixed, inset:0)
  background: --color-overlay
  backdrop-filter: blur(4px)  (设置页对话框)
  z-index: 500

  ┌─── .dialog ────────────────────────────┐
  │  width: --width-dialog (max 90vw)       │
  │  background: --color-surface            │
  │  border-radius: --radius-lg             │
  │  padding: --padding-dialog              │
  │  box-shadow: --shadow-dialog            │
  │  text-align: center                     │
  │  入场: scale(0.92) translateY(12px)     │
  │        → scale(1) translateY(0)         │
  │                                          │
  │  dialog-box h4: 18px(快消)/16px(常规)    │
  │                                          │
  │  三种内部状态（通过display切换）：        │
  │  1. 确认态：icon(56px/danger) + 标题+消息 + 按钮组  │
  │  2. 加载态：spinner 32px + 文案          │
  │  3. 完成态：勾号48px + 完成文案          │
  └──────────────────────────────────────────┘
```

#### 确认弹窗变体（.confirm-dialog）[新增·长期工作区]

```
┌─── .confirm-dialog ───────────────────┐
│  padding: 28px 32px                   │
│  max-width: 400px                     │
│  h4: --font-size-subtitle semibold    │
│  p: --font-size-body, secondary       │
│  动画: popIn (fast, bounce)           │
└───────────────────────────────────────┘
```

### 5.6 Toast通知（.toast）

| 变体 | 对应PRD场景 | 背景 | 边框/图标色 | 图标 | 自动消失 | 原型验证 |
|------|------------|------|------------|------|---------|---------|
| progress(等待中) | PRD §7.5 等待中 | `--color-info-bg` | `--color-info` | inline spinner 16px(`--size-spinner-sm`) | 否 | 快消/长期工作区 |
| success(修改成功) | PRD §7.5 修改成功 | `--color-success-bg` | `--color-success` | SVG `CheckCircle2` / ✅emoji | 是(3-3.5s) | 快消/长期工作区、我的项目 |
| amber(修改失败) | PRD §7.5 修改失败 | `--color-error-amber-bg` | `--color-warning` | ⚠ | 否(横幅升级) | 快消/长期工作区 |
| rollback(回滚完成) | PRD §7.5 回滚完成 | `--color-error-amber-bg` | `--color-warning` | ↩ | 是(4s) | 快消/长期工作区 |
| timeout(操作超时) | PRD §7.5 操作超时 | `--color-error-amber-bg` | `--color-warning` | ⏳ | 否(横幅升级) | 长期工作区 |
| error(删除错误) | 通用删除/异常 | `--color-danger-bg`(我的项目) | `--color-danger`(我的项目) | ❌SVG | 是(3s) | 我的项目 |
| info(通用信息) | 通用通知 | `--color-info-bg` | `--color-info` | ℹSVG | 是(3s) | 全部6页 |

**注意**：我的项目页的`toast.error`使用`--color-danger`(红色)体系，与工作区的`toast.amber`(amber)体系不同。这是有意的区分——项目删除是确定性危险操作(需要红色警示)，而工作区修改失败是过程性异常(需柔和处理)。

通用属性：`border-radius: --radius-sm`, `padding: --padding-toast`, `font-size: --font-size-caption`, `box-shadow: --shadow-toast`/`--shadow-dialog`, 底部居中fixed定位（z-index: 300-600，Toast高于overlay需注意层级）。

### 5.7 消息气泡（.chat-msg）

| 位置 | 背景 | 文字色 | 圆角 | 对齐 | max-width |
|------|------|--------|------|------|---------|
| 用户消息（右） | `--color-primary` | `#FFFFFF` | `--radius-md`右上0 | 右对齐 | 75%(快消)/85%(长期) |
| Agent消息（左） | `--color-surface-alt` | `--color-text` | `--radius-md`左上0 | 左对齐 | 75%/85% |
| 系统提示（中） | 透明 | `--color-text-secondary` | — | 居中 | 100% |
| 截图消息（右） | `--color-primary`(用户)/`--color-surface-alt`(agent) | 继承 | `--radius-md` | 右/左 | 按角色 |
| 测试结果（中） | 透明 | — | — | 居中 | 100% |

通用属性：`padding: --padding-msg-bubble`, `font-size: --font-size-body`, `line-height: 1.5`, `animation: msgIn (fast, bounce)`.

### 5.8 选项卡片组（.option-cards）[新增·验证]

```
.option-card:
  内边距: 10px 16px
  边框: 1.5px solid --color-border
  圆角: --radius-md
  背景: --color-surface
  文字: --font-size-caption
  
  hover: border-color → --color-primary, background → --color-primary-subtle
  selected: border-color → --color-primary, background → --color-primary-subtle, color → --color-primary
  dashed(你帮我决定): border-style: dashed
```

### 5.9 时间轴面板（.timeline-panel）

```
右侧滑出抽屉（快消/长期通用）：
  width: --width-timeline-panel
  background: --color-surface
  box-shadow: --shadow-timeline-panel
  z-index: 400/401

版本列表项样式变体对照：

| 属性 | 快消型 | 长期迭代型 |
|------|--------|-----------|
| 节点样式 | 圆点 10px (dot) | 圆点 12px (node) |
| 卡片样式 | 无包裹(纯列表) | 包裹.card + 边框 + hover |
| 当前版本节点 | `background: --color-primary`, border: --color-primary | 同上 |
| 历史版本节点 | 空心 `--color-border` | 空心 `background: --color-surface` |
| 当前版本卡片 | 无卡片 | `border-color: --color-primary`, `background: --color-primary-subtle` |
| 回滚按钮 | `.timeline-rollback`: bordered | `.timeline-rollback-btn`: text-only |
| 版本badge | `timeline-current-badge` | `timeline-badge` |

时间轴空状态（sitemap v0.3 A1）：
  ┌──────────────────────────────┐
  │  ○ (28px, opacity 0.4)      │
  │  "暂无历史版本"               │
  │  (--font-size-body,          │
  │   --color-text-secondary)    │
  │  "当你确认方案或进行重要修改   │
  │   时，系统会自动保存版本。"    │
  │  (--font-size-small,          │
  │   --color-text-tertiary)     │
  └──────────────────────────────┘
```

### 5.10 文档面板（.doc-panel）

> 作用域：**长期迭代型**（快消型不显示文档面板）

```
中栏固定面板：
  background: --color-bg-workspace
  border-right: 1px solid --color-border
  width: --width-doc-panel (22%), min-width: 220px
  默认隐藏(width:0, opacity:0)，用户点击后active展开

  ┌── 文档目录树 ──────────────────┐
  │  📄 项目文档 (header)           │
  │  ▶ 需求文档/                   │
  │    📝 需求说明  [草稿中] ✅     │
  │    📝 用户故事  [待生成]        │
  │  ▶ 界面设计/                   │
  │  ▶ 技术方案/                   │
  └────────────────────────────────┘
  
  文件夹: padding 4px 16px, font-size --font-size-small, font-weight --font-weight-medium
  文件:   padding 3px 16px 3px 32px, font-size --font-size-small
  激活项: color --color-primary, background --color-primary-subtle
  箭头:   font-size 10px, rotate(90deg)展开
```

### 5.11 聊天区横幅（.banner）

```
┌──────────────────────────────────────┐
│  ┃  <AlertTriangle/Clock> 标题        │
│  ┃  描述文字                          │
│  ┃                                    │
│  ┃  [操作按钮]  [跳过按钮]            │
│  └──────────────────────────────────────┘

样式规范：
  背景:     --color-error-amber-bg
  左边框:   4px solid --color-error-amber (用 ┃ 表示)
  内边距:   16px 20px
  圆角:     --radius-md
  阴影:     --shadow-banner
  字体:     --font-size-body
  z-index:  200（低于遮罩）
  消失行为: 永不自动消失（用户点击按钮后移除）
  定位:     插入对话消息流中，position: relative（随对话流滚动）
```

### 5.12 内嵌确认卡片（.card-in-chat）

```
┌─── .card-in-chat ──────────────────────┐
│  ┃  标题 (--font-size-subtitle, bold)   │
│  ┃  正文 (--font-size-body, secondary)  │
│  ┃                                      │
│  ┃  ─────────────────────────           │
│  ┃  底部操作栏:                         │
│  ┃  [确认方案]  [调整方案]              │
└────────────────────────────────────────┘

样式规范：
  背景:     --color-surface-alt
  左边框:   4px solid --color-primary（用 ┃ 表示）
  内边距:   16px 20px
  圆角:     --radius-md
  底部操作栏: border-top, gap --gap-btn-group, justify-content flex-end
```

### 5.13 点选纠错快速选项面板（.quick-options）

```
┌─── .quick-options ────────────────────┐
│  ✕  (关闭按钮)                        │
│                                        │
│  对此[元素类型]的操作：                │
│                                        │
│  [🖊  改文字]                          │
│  [🎨  换个颜色]                        │
│  [📐  换个位置]                        │
│  [🗑  删掉它]                          │
│  [💬  其他]                            │
└────────────────────────────────────────┘

样式规范（统一后）:
  定位:     position: absolute/fixed（相对于预览区或页面）
  背景:     --color-surface
  边框:     1px solid --color-border
  圆角:     --radius-lg
  阴影:     --shadow-dialog（浮于上层）
  内边距:   quick-workspace: 16px 20px / long-workspace: 12px 16px
  z-index:  450（高于Toast 300，低于遮罩 500）
  宽度:     240px - 300px
  选项行:   padding: 8px 12px, hover: --color-primary-subtle, border-radius: --radius-sm
  scope: 快消/长期通用
```

### 5.14 测试结果摘要卡片（.card-test-result / .test-result-card）[验证]

```
┌─── .test-result-card ─────────────────┐
│  测试完成 ✓ / h3 title                │
│  ✅ 通过: 5  ⚠ 失败: 0  ⏸ 跳过: 0    │
│  [展开详情 ▾]                         │
│  ────────────────────────────────     │
│  │ ✅ 能正常添加笔记                    │
│  │  (测试描述文字, small, secondary)    │
│  │ ✅ 空书名时有提示                    │
│  └────────────────────────────────    │
└────────────────────────────────────────┘

样式规范：
  背景:     --color-surface
  边框:     1px solid --color-border
  圆角:     --radius-lg(快消)/--radius-md(长期)
  阴影:     --shadow-card
  统计栏:   font-size --font-size-subtitle, gap 16px
  通过:     --color-success
  失败:     --color-error-amber (amber色，非红色)
  跳过:     --color-text-secondary
```

### 5.15 筛选标签组（.filter-tabs）[新增·我的项目页]

```
┌────────────────────────────────┐
│ [全部] [快速工具] [长期项目]   │
└────────────────────────────────┘

容器: background --color-bg-secondary, padding 3px, border-radius --radius-sm
标签: padding 6px 14px, font-size --font-size-small, font-weight --font-weight-medium
  default: transparent bg, --color-text-secondary
  hover: --color-text
  active: --color-surface bg, --color-text, box-shadow --shadow-filter-tab
```

### 5.16 上下文菜单（.context-menu）[新增·我的项目页]

```
┌─── .card-context-menu ──────────────┐
│  ▶ 打开继续                         │
│  ─────────────────                  │  ← divider
│  🗑 删除                            │  ← .danger: --color-danger
└──────────────────────────────────────┘

定位: absolute, right:0, top:40px
背景: --color-surface
边框: 1px solid --color-border
圆角: --radius-md
阴影: --shadow-popup
内边距: 6px
最小宽度: 160px
动画: menuIn (fast, ease) —— opacity + translateY(-4px)
列表项: padding 9px 12px, border-radius --radius-sm
  .danger: color --color-danger, hover bg --color-danger-bg
```

### 5.17 统计卡片（.stat-card）[新增·分析看板]

```
┌─── .stat-card ───────────────────────┐
│  总项目数                (label)      │
│  847                     (value)      │
│  ↑ 12.3% 较上期         (change)     │
└────────────────────────────────────────┘

样式:
  背景:     --color-surface
  圆角:     --radius-lg
  阴影:     --shadow-card-analytics
  内边距:   18px 20px
  label:    --font-size-small, --color-text-secondary, --font-weight-medium
  value:    28px, --font-weight-bold, --color-text
  change:   --font-size-small, .up(--color-success)/.down(--color-danger)/.neutral(--color-text-tertiary)
```

### 5.18 图表卡片（.chart-card）[新增·分析看板]

```
┌─── .chart-card ──────────────────────┐
│  ┌─ header ────────────────────────┐ │
│  │  标题    (--font-size-card-title)│ │
│  │  副标题  (--font-size-small)     │ │
│  └─────────────────────────────────┘ │
│  ┌─ body ──────────────────────────┐ │
│  │  图表内容                         │ │
│  └─────────────────────────────────┘ │
│  ┌─ footer ────────────────────────┐ │
│  │  脚注说明（含insight-tag）       │ │
│  └─────────────────────────────────┘ │
└────────────────────────────────────────┘

样式:
  背景:     --color-surface
  圆角:     --radius-lg
  阴影:     --shadow-card-analytics
  header:   padding 16px 20px 12px, border-bottom
  body:     padding 20px
  footer:   padding 10px 20px, border-top, font-size --font-size-small, color --color-text-tertiary
```

### 5.19 设置页内容区块（.content-section）[新增·设置页]

```
┌─── .content-section ─────────────────┐
│  [icon]  标题 (--font-size-card-title)│
│  描述文字 (--font-size-body)          │
│  ...内容...                          │
└────────────────────────────────────────┘

样式:
  背景:     --color-surface
  边框:     1px solid --color-border
  圆角:     --radius-md
  阴影:     --shadow-card
  内边距:   var(--padding-card)
  margin-bottom: 20px
```

#### 危险区域变体（.danger-zone）

```
  边框色:   #FEE2E2 (--color-danger-bg)
  背景色:   #FFFBFB (硬编码)
  标题色:   --color-danger
```

### 5.20 设置页Tab导航（.settings-nav / .tab-btn）[新增·设置页]

```
左侧垂直Tab导航:
  宽度: 200px (≤860px: 160px)
  背景: --color-surface
  border-right: 1px solid --color-border
  padding: 16px 8px

.tab-btn:
  padding: 10px 14px
  font-size: --font-size-subtitle
  font-weight: --font-weight-medium
  color: --color-text-secondary
  border-radius: --radius-sm
  
  hover:   background --color-bg-secondary, color --color-text
  active:  background --color-primary-subtle, color --color-primary, 
           font-weight --font-weight-semibold
           左侧 3px 指示条 (--color-primary, border-radius 0 2px 2px 0)
```

### 5.21 分析看板侧栏（.sidebar / .sidebar-tab）[新增·分析看板]

```
左侧深色侧栏:
  宽度: --width-sidebar (220px)
  背景: --color-bg (#1E1E2E)
  布局: flex column, 满高

.sidebar-tab:
  padding: 10px 12px
  font-size: --font-size-subtitle
  font-weight: --font-weight-medium
  color: --color-text-on-dark-subtle
  border-radius: --radius-md
  gap: 10px (icon + text)
  
  hover:   background rgba(255,255,255,0.06), color --color-text-on-dark
  active:  background --color-primary, color #fff,
           box-shadow --shadow-sidebar-tab-active
  
  .tab-badge: background rgba(255,255,255,0.12), font-size --font-size-badge
  active .tab-badge: background rgba(255,255,255,0.2), color #fff
```

### 5.22 模式标签（.mode-badge）[新增·我的项目页]

```
┌────────────────────┐
│ ⚡ 快速工具         │  ← .mode-badge.quick
│                    │     bg: --color-primary-subtle
│ 🏢 长期项目         │     color: --color-primary
└────────────────────┘  ← .mode-badge.long
                           bg: --color-success-bg
                           color: --color-success

通用: padding --padding-badge, border-radius --radius-lg, 
      font-size --font-size-badge, font-weight --font-weight-semibold
      内联inline-flex, gap 4px
```

### 5.23 表单组件（.form-group / .form-input）[新增·设置页/分析看板]

```
.form-group:
  margin-bottom: --gap-form

  label:   display block, --font-size-subtitle, --font-weight-medium, margin-bottom 4px
  .form-hint: --font-size-small, --color-text-tertiary, margin-top 2px

.form-input / textarea.feedback-textarea:
  width: 100%
  padding: --padding-input
  border: 1px solid --color-border, border-radius --radius-sm
  font-size: --font-size-body (主平台) / --font-size-subtitle (分析看板)
  transition: border-color
  
  focus: border-color --color-border-focus, box-shadow --shadow-input-focus
  placeholder: --color-text-tertiary
```

### 5.24 指南步骤（.guide-step）[新增·设置页]

```
┌──────────────────────────────────────┐
│  ①  步骤标题                         │
│      步骤描述文字                     │
├──────────────────────────────────────┤
│  ②  步骤标题                         │
│      步骤描述文字                     │
└──────────────────────────────────────┘

样式:
  display: flex, gap 16px
  padding: 16px 0
  border-bottom: 1px solid --color-border

  .step-number: 
    width 32px, height 32px, border-radius --radius-full
    background --color-primary-subtle, color --color-primary
    font-size --font-size-caption, font-weight --font-weight-bold
  
  .step-content h3: --font-size-body, --font-weight-semibold
  .step-content p:  --font-size-small, --color-text-secondary
```

### 5.25 范式卡片（.pattern-card）[新增·分析看板]

```
┌─── .pattern-card ────────────────────┐
│  ┃  PARADIGM #1 · 采纳率 91.5%      │ ← rank: badge style, --color-primary
│  ┃  范式标题文字                      │ ← title: --font-size-body, semibold
│  ┃  范式详细描述...                   │ ← desc: --font-size-subtitle, secondary
│  ┃  [Token节省 34%] [成功率提升 22%] │ ← meta tags
└────────────────────────────────────────┘

样式:
  背景:     --color-surface
  左边框:   4px solid --color-primary
  圆角:     --radius-md
  内边距:   16px 18px
  阴影:     --shadow-card
  margin-bottom: 14px
```

### 5.26 实验卡片（.exp-card）[新增·分析看板]

```
┌─── .exp-card ────────────────────────┐
│  实验名称      [已完成/进行中]       │ ← header
├──────────────────────────────────────┤
│  ┌─ 组A ──┐ ┌─ 组B ──┐ ┌─ 统计 ─┐ │
│  │ 成功率  │ │ 成功率  │ │ p=0.003│ │ ← metrics grid
│  │ MVP时间 │ │ MVP时间 │ │ d=0.87 │ │
│  │ 样本量  │ │ 样本量  │ │ 功效%  │ │
│  └────────┘ └────────┘ └────────┘ │
│  ┌─ p值判定 ──────────────────────┐ │
│  │ p = 0.003 ✅ 统计显著           │ │
│  └────────────────────────────────┘ │
└──────────────────────────────────────┘
```

### 5.27 聚类可视化（.cluster-viz）[新增·分析看板]

```
散点图区域:
  width: 100%, height: 280px
  background: --color-bg-secondary
  border-radius: --radius-md
  overflow: hidden

  .cluster-dot: 
    position absolute, 14px, border-radius 50%
    border 2px solid rgba(255,255,255,0.8)
    box-shadow 0 1px 4px rgba(0,0,0,0.2)
    hover: scale(1.5), z-index 2

  .cluster-center:
    position absolute, 24px, border-radius 50%
    border 3px solid, opacity 0.5
    transform translate(-50%, -50%)
```

### 5.28 空状态（.empty-state）[验证·我的项目页/分析看板]

```
┌─── .empty-state ─────────────────────┐
│                                      │
│        ┌───────┐                     │
│        │  icon  │  w:72px, h:72px    │
│        │  📄   │  rounded-full       │
│        └───────┘  bg: --color-bg-sec │
│                                      │
│     还没有项目                        │
│                                      │
│  创建一个项目，让AI帮你...            │
│                                      │
│      [创建第一个项目]                 │
│                                      │
└────────────────────────────────────────┘
```

### 5.29 其他组件

| 组件 | 关键样式 | 原型验证 |
|------|---------|---------|
| **工具栏** | `height: --height-header`, `background: --color-surface`, 下边框 `1px solid --color-border`, `padding: 0 20px`, `gap: 16px` | 快消/长期工作区、我的项目、设置 |
| **工具栏按钮** | `height: 36px`, `padding: 0 14px`, `border: 1px solid --color-border`, `border-radius: --radius-sm`, `font-size: --font-size-small` | 快消/长期工作区 |
| **工具栏badge** | `background: --color-primary-subtle`, `color: --color-primary`, `font-size: 11px`, `padding: 2px 8px`, `border-radius: --radius-sm` | 快消/长期工作区 |
| **状态栏** | `height: 32px`, `background: --color-surface-alt`, `border-bottom: 1px solid --color-border`, `font-size: --font-size-small`, `color: --color-text-secondary`, `padding: 0 20px` | 快消/长期工作区 |
| **状态圆点** | `width: 6px`, `height: 6px`, `border-radius: 50%`, `animation: pulse 2s infinite` | 快消/长期工作区、分析看板 |
| **预览区** | `flex: 1`, `background: --color-surface` | 快消/长期工作区 |
| **预览header** | `height: 36px`, `border-bottom: 1px solid --color-border`, `font-size: --font-size-small`, `color: --color-text-secondary` | 快消/长期工作区 |
| **截图上传按钮** | `height: var(--height-input-min)`, `width: 44px`, `border: 1px dashed --color-border`, `border-radius: --radius-sm`, `background: --color-bg` | 快消工作区 |
| **返回按钮** | `width: 36px`, `height: 36px`, `border: 1px solid --color-border`, `border-radius: --radius-sm` | 我的项目 |
| **图表柱状图** | `.bar`: `border-radius: 4px 4px 0 0`, `transition: height 400ms --ease-smooth` | 分析看板 |
| **图表环图** | `width: 180px`, `height: 180px`, `border-radius: 50%`, `background: conic-gradient(...)` | 分析看板 |
| **图表水平条** | `.h-bar-track`: `height: 22px`, `background: --color-bg-secondary`, `border-radius: 4px` | 分析看板 |
| **insight标签** | `.insight-tag`: `padding: 2px 8px`, `border-radius: 4px`, `font-size: --font-size-small`, `font-weight: --font-weight-semibold` | 分析看板 |
| **显著性badge** | `.sig-badge`: `padding: 2px 8px`, `border-radius: 4px`, `font-size: --font-size-small` | 分析看板 |
| **实验创建面板** | `.creation-panel`: `border: 1px dashed --color-border`, `border-radius: --radius-lg`, `padding: 20px 24px` | 分析看板 |

---

## 6. 分析看板专用变量（变体汇总）

分析看板作为独立的后台页面，对主平台设计系统做以下系统性覆盖。这些值不在全局`:root`中设置，而是局限在分析看板的`<style>`作用域内。

| 类别 | 变量 | 后台看板值 | 与主平台差异 |
|------|------|-----------|-------------|
| 字号 | `--font-size-hero` | `28px` | -8px |
| | `--font-size-section-title` | `22px` | -2px |
| | `--font-size-card-title` | `20px` | -2px |
| | `--font-size-body` | `15px` | -1px |
| | `--font-size-subtitle` | `14px` | -1px |
| | `--font-size-caption` | `13px` | -1px |
| | `--font-size-small` | `12px` | -1.5px |
| | `--font-size-badge` | `11px` | -1px |
| 阴影 | `--shadow-card` | `0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06)` | 更薄、两层 |
| 卡片内边距 | `--padding-card` | `20px 24px 24px` | 更紧凑 |
| 按钮内边距 | `--padding-btn` | `8px 20px` | 更紧凑 |
| 小按钮内边距 | `--padding-btn-sm` | `5px 12px` | 更紧凑 |
| 输入框内边距 | `--padding-input` | `8px 12px` | 更紧凑 |
| 卡片间距 | `--gap-cards` | `20px` | -8px |
| 表单项间距 | `--gap-form` | `14px` | -2px |
| 按钮组间距 | `--gap-btn-group` | `10px` | -4px |
| 字间距 | `--letter-spacing-title` | `1px` | -1px |

---

## 7. 图标规范

### 7.1 图标库

使用 **lucide-react**（技术基座已验证）。平台自身UI中的图标从lucide-react选取。

| 图标名 | 用途 |
|--------|------|
| `Zap` | 快消型模式标识 |
| `Building2` / `Clock` | 长期迭代型模式标识 |
| `History` | 时间轴/历史版本入口 |
| `FolderOpen` / `Folder` | 我的项目入口 |
| `Settings` | 设置入口 |
| `ChevronRight` | 文档树展开/折叠箭头 |
| `CheckCircle2` | 成功/完成 |
| `AlertTriangle` | 警告 |
| `XCircle` | 错误/删除 |
| `Loader2` | 加载spinner（animate-spin） |
| `ArrowLeft` | 返回（工具栏、设置页） |
| `HelpCircle` | 帮助/关于 |
| `Clock` | 操作超时横幅 |
| `ImageUp` | 截图上传按钮 |
| `AlertCircle` | 修改失败横幅（amber色替代XCircle红色） |
| `Plus` | 新建/添加 |
| `Search` | 搜索 |
| `MoreHorizontal` / `MoreVertical` | 更多操作(⋯) |
| `Trash2` | 删除 |
| `Play` | 继续/打开 |
| `Download` | 导出CSV |
| `Shield` | 数据隐私(设置页) |
| `Lock` | 隐私政策(设置页) |
| `MessageSquare` | 反馈(设置页) |
| `BarChart3` | 分析看板图表 |
| `Grid` | 范式挖掘 |
| `SplitSquareHorizontal` | A/B实验 |
| `FileText` | 文档管理 |

### 7.2 SVG图标尺寸标准 [新增]

| 尺寸Token | 值 | 用途 |
|-----------|-----|------|
| `--size-svg-icon` | `18px` | 按钮内联图标、菜单项图标、表格操作 |
| `--size-svg-icon-sm` | `14px` | mode-badge内联、小标签内联 |
| `--size-svg-icon-lg` | `26px` | 空状态图标、对话框警示图标 |
| 工具栏tab图标 | `18px` | 设置页tab-btn svg |
| 侧栏tab图标 | `18px` | 分析看板sidebar tab |
| 图表footer图标 | `16px` | 导出按钮图表 |

### 7.3 SVG图标属性

| 属性 | 值 | 作用域 |
|------|-----|--------|
| `stroke-width` | `2` (默认), `2.5` (完成勾/新建加号), `1.8`(设置页tab/内容区icon), `1.5`(空状态/警示) | 轮廓图标描边宽 |
| `stroke-linecap` | `round` | 线条端点 |
| `stroke-linejoin` | `round` | 线条连接 |

---

## 8. 响应式断点

| 断点 | 介质 | 关键变化 |
|------|------|---------|
| **桌面**（默认） | >860px | 完整布局：2栏/3栏、卡片并排、正常字号 |
| `≤860px` | 平板/小屏 | 卡片纵向排列；工作区叠为单栏；标题 28px(hero)/22px(section)；页头间距 32px；卡片宽度 420px or 85vw；侧栏折叠为图标 |
| `≤640px` | 中屏 | cards-row纵向堆叠（模式选择页） |
| `≤600px` | 小屏 | 我的项目页：页面header纵向堆叠；filter-bar纵向堆叠；网格1列；卡片padding 20px |
| `≤480px` | 手机 | 页面padding 24px 16px；卡片padding压缩；标题 19px；按钮padding收窄；消息字号 15px；工作区纯聊天视图；侧栏隐藏(分析看板) |

### 分析看板专属响应式 [新增]

| 断点 | 变化 |
|------|------|
| `≤860px` | 侧栏折叠(60px, 仅图标)；统计网格2列；bar-chart高度160px；表单行纵向 |
| `≤480px` | 侧栏隐藏(top-bar hamburger或collapse)；统计网格1列；top-bar padding 10px 12px；bar-chart高度140px |

---

## 9. 完整 `:root` CSS变量块

```css
:root {
  /* ===== 品牌色 ===== */
  --color-primary: #4F46E5;
  --color-primary-hover: #4338CA;
  --color-primary-shadow: rgba(79, 70, 229, 0.35);
  --color-primary-subtle: rgba(79, 70, 229, 0.06);
  --color-primary-subtle-active: rgba(79, 70, 229, 0.12);
  --color-primary-shadow-focus: rgba(79, 70, 229, 0.12);

  /* ===== 语义色 ===== */
  --color-success: #059669;
  --color-success-bg: #ECFDF5;
  --color-warning: #D97706;
  --color-warning-bg: #FEF3C7;
  --color-danger: #DC2626;
  --color-danger-bg: #FEE2E2;
  --color-danger-hover: #B91C1C;
  --color-info: #3B82F6;
  --color-info-bg: #DBEAFE;
  --color-error-amber: #D97706;
  --color-error-amber-bg: #FEF3C7;

  /* ===== 图表色板 ===== */
  --chart-1: #4F46E5;
  --chart-2: #059669;
  --chart-3: #D97706;
  --chart-4: #3B82F6;
  --chart-5: #DC2626;
  --chart-6: #8B5CF6;
  --chart-7: #EC4899;
  --chart-8: #14B8A6;
  --chart-9: #F59E0B;
  --chart-10: #6366F1;

  /* ===== 中性色 - 背景与表面 ===== */
  --color-bg: #1E1E2E;
  --color-bg-workspace: #F9FAFB;
  --color-surface: #FFFFFF;
  --color-surface-alt: #F3F4F6;
  --color-overlay: rgba(0, 0, 0, 0.55);
  --color-popup-bg: #2A2A3E;
  --color-bg-secondary: #F3F4F6;
  --color-bg-secondary-hover: #E5E7EB;

  /* ===== 中性色 - 文字 ===== */
  --color-text: #111827;
  --color-text-secondary: #6B7280;
  --color-text-tertiary: #9CA3AF;
  --color-text-on-dark-heading: #FFFFFF;
  --color-text-on-dark: rgba(255, 255, 255, 0.88);
  --color-text-on-dark-subtle: rgba(255, 255, 255, 0.55);
  --color-text-on-dark-muted: rgba(255, 255, 255, 0.40);
  --color-text-on-dark-loading: rgba(255, 255, 255, 0.65);

  /* ===== 中性色 - 边框 ===== */
  --color-border: #E5E7EB;
  --color-border-light: rgba(255, 255, 255, 0.25);
  --color-border-light-hover: rgba(255, 255, 255, 0.55);
  --color-border-focus: #4F46E5;

  /* ===== 字体 ===== */
  --font-family-sans: -apple-system, BlinkMacSystemFont, "Segoe UI",
    "PingFang SC", "Microsoft YaHei", "Helvetica Neue", sans-serif;
  --font-family-help-btn: "Times New Roman", serif;
  --font-family-mono: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
  --font-size-hero: 36px;
  --font-size-loading-title: 32px;
  --font-size-section-title: 24px;
  --font-size-card-title: 22px;
  --font-size-body: 16px;
  --font-size-subtitle: 15px;
  --font-size-caption: 14px;
  --font-size-small: 13.5px;
  --font-size-badge: 12px;
  --font-size-confirm-msg: 17px;
  --font-weight-bold: 700;
  --font-weight-semibold: 600;
  --font-weight-medium: 500;
  --font-weight-regular: 400;
  --letter-spacing-title: 2px;
  --letter-spacing-loading: 1px;
  --letter-spacing-normal: 0;
  --letter-spacing-badge: 0.5px;

  /* ===== 圆角 ===== */
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --radius-bar: 4px;
  --radius-full: 50%;

  /* ===== 阴影 ===== */
  --shadow-card: 0 4px 20px rgba(0, 0, 0, 0.08);
  --shadow-card-hover: 0 12px 36px rgba(0, 0, 0, 0.18);
  --shadow-dialog: 0 24px 64px rgba(0, 0, 0, 0.35);
  --shadow-popup: 0 8px 28px rgba(0, 0, 0, 0.40);
  --shadow-toast: 0 4px 16px rgba(0, 0, 0, 0.12);
  --shadow-badge: 0 2px 8px rgba(79, 70, 229, 0.35);
  --shadow-btn-primary: 0 4px 14px rgba(79, 70, 229, 0.35);
  --shadow-btn-danger: 0 4px 14px rgba(220, 38, 38, 0.30);
  --shadow-help-btn-hover: 0 0 0 3px rgba(255, 255, 255, 0.12);
  --shadow-timeline-panel: -4px 0 24px rgba(0, 0, 0, 0.15);
  --shadow-banner: 0 2px 12px rgba(0, 0, 0, 0.10);
  --shadow-input-focus: 0 0 0 3px rgba(79, 70, 229, 0.12);
  --shadow-filter-tab: 0 1px 3px rgba(0, 0, 0, 0.08);
  --shadow-sidebar-tab-active: 0 2px 8px rgba(79, 70, 229, 0.3);

  /* ===== 间距 ===== */
  --padding-page: 40px 24px;
  --padding-card: 36px 32px 32px;
  --padding-card-compact: 28px 28px 28px;
  --padding-dialog: 36px 40px 32px;
  --padding-btn: 10px 32px;
  --padding-btn-sm: 6px 16px;
  --padding-popup: 14px 20px;
  --padding-badge: 3px 12px;
  --padding-input: 10px 14px;
  --padding-msg-bubble: 12px 16px;
  --padding-toast: 12px 20px;
  --padding-dialog-state: 8px 0;
  --padding-context-menu: 6px;
  --margin-header-bottom: 48px;
  --margin-card-title-bottom: 10px;
  --margin-card-desc-bottom: 16px;
  --margin-guidance-top: 44px;
  --margin-confirm-msg-bottom: 28px;
  --margin-loading-title-bottom: 16px;
  --gap-cards: 28px;
  --gap-cards-compact: 24px;
  --gap-btn-group: 14px;
  --gap-loading-text: 12px;
  --gap-dialog-states: 14px;
  --gap-chat-msg: 16px;
  --gap-option-cards: 12px;
  --gap-form: 16px;
  --gap-filter-tab-group: 3px;
  --gap-toolbar-items: 16px;
  --gap-table-header: 12px;

  /* ===== 尺寸 ===== */
  --width-card: 380px;
  --width-dialog: 460px;
  --width-dialog-max: 90vw;
  --width-timeline-panel: 360px;
  --width-sidebar: 220px;
  --width-sidebar-collapsed: 60px;
  --width-content-max: 1200px;
  --width-chat-input: 100%;
  --width-popup-max: 260px;
  --width-quick-options: 240px;
  --width-context-menu-min: 160px;
  --width-chat-panel: 38%;
  --width-doc-panel: 22%;
  --size-help-btn: 38px;
  --size-check-icon: 48px;
  --size-check-svg: 24px;
  --size-spinner-loading: 22px;
  --size-spinner-dialog: 32px;
  --size-spinner-sm: 16px;
  --size-avatar: 32px;
  --size-icon-btn: 36px;
  --size-color-swatch: 32px;
  --size-empty-state-icon: 72px;
  --size-dialog-icon-wrap: 56px;
  --size-svg-icon: 18px;
  --size-svg-icon-sm: 14px;
  --size-svg-icon-lg: 26px;
  --size-tab-indicator: 3px;
  --size-timeline-node: 12px;
  --size-dot: 6px;
  --size-donut-chart: 180px;
  --height-header: 56px;
  --height-input-min: 44px;
  --height-status-bar: 32px;
  --height-preview-header: 36px;

  /* ===== 动效 ===== */
  --duration-instant: 50ms;
  --duration-fast: 150ms;
  --duration-normal: 180ms;
  --duration-slow: 200ms;
  --duration-overlay: 250ms;
  --duration-loading: 600ms;
  --duration-bar-chart: 400ms;
  --ease-default: ease;
  --ease-bounce: cubic-bezier(0.34, 1.56, 0.64, 1);
  --ease-smooth: cubic-bezier(0.4, 0, 0.2, 1);
}

/* ===== 响应式媒体查询 ===== */
@media (max-width: 860px) {
  :root {
    --padding-card: 28px 24px 24px;
    --padding-dialog: 28px 24px;
    --padding-btn: 10px 32px;
    --margin-header-bottom: 32px;
    --margin-guidance-top: 32px;
    --gap-cards: 20px;
    --width-card: 420px;
    --font-size-hero: 28px;
  }
}

@media (max-width: 640px) {
  :root {
    --font-size-hero: 22px;
    --font-size-card-title: 19px;
  }
}

@media (max-width: 480px) {
  :root {
    --padding-card: 24px 20px 20px;
    --padding-dialog: 28px 24px;
    --padding-btn: 9px 24px;
    --padding-page: 24px 16px;
    --font-size-card-title: 19px;
    --font-size-subtitle: 14px;
    --font-size-confirm-msg: 15px;
  }
}
```

---

## 10. 推断项更新

以下Token/组件在原型的6个页面范围内未出现，仍基于原型视觉语言做最小推断扩展。每个标注`[推断]`。

因v0.3已覆盖全部6个原型（4个用户页+2个系统页），推断项大幅缩减：

| # | 推断内容 | 依据 | 状态 |
|---|---------|------|------|
| 1 | `--font-size-loading-title: 32px` | 原型中加载页尚未实现，从模式选择页hero 36px合理降级 | 保留推断 |
| 2 | `--size-avatar: 32px` | 所有原型中无头像组件，从工具栏按钮高度36px合理推断 | 保留推断 |
| 3 | 加载页整体样式（spinner 22px、标题32px、渐隐动画） | 模式选择页确认对话框的loading态提供了spinner和文案样式参考 | 保留推断 |

---

## 11. 更新审计报告（v0.2 → v0.3）

> 版本：v0.2 → v0.3 | 日期：2026-06-05 | 审计类型：收敛审计——从全部6个原型交叉验证

### 11.1 变更概要

| # | 变更内容 | 类型 | 相关章节 |
|---|---------|------|---------|
| C1 | 新增图表色板 `--chart-1` ~ `--chart-10` | 新增 | §1.6, §9 |
| C2 | 新增 `--color-danger-hover: #B91C1C` | 新增 | §1.2, §5.3, §9 |
| C3 | 新增 `--color-primary-shadow-focus: rgba(79,70,229,0.12)` | 新增 | §1.1, §5.4, §9 |
| C4 | 新增 `--shadow-input-focus` / `--shadow-btn-danger` / `--shadow-filter-tab` / `--shadow-sidebar-tab-active` | 新增 | §3.2, §9 |
| C5 | 新增分析看板字体变体（独立`:root`覆盖） | 新增 | §2.3, §6 |
| C6 | 新增后台专用尺寸Token（侧栏、图表、svg-icon系列） | 新增 | §3.5, §9 |
| C7 | 新增16个组件样式定义 | 新增 | §5.3-5.28 |
| C8 | 新增`--radius-bar: 4px` / `--letter-spacing-badge: 0.5px`等粒度Token | 新增 | §3.1, §2.5 |
| C9 | `--color-primary-subtle-active`状态从"推断"升级为"已验证" | 状态变更 | §1.1 |
| C10 | 推断项从21项缩减为3项 | 缩减 | §10 |
| C11 | 新增"待统一项"清单（硬编码值跟踪） | 新增 | §12 |
| C12 | 新增响应式断点≤640px/≤600px级别 | 新增 | §8 |
| C13 | 新增卡片变体（project-card：1.5px border, -3px hover, compact padding） | 新增 | §5.2, §3.3 |
| C14 | 图标规范扩展：尺寸标准、stroke-width变体 | 扩展 | §7 |

### 11.2 新增Token一览（v0.3新增）

| Token | 值 | 用途 |
|-------|-----|------|
| `--color-danger-hover` | `#B91C1C` | 危险按钮hover背景 |
| `--color-primary-shadow-focus` | `rgba(79,70,229,0.12)` | 输入框focus外发光 |
| `--chart-1` ~ `--chart-10` | 详见§1.6 | 图表/可视化色板 |
| `--shadow-input-focus` | `0 0 0 3px rgba(79,70,229,0.12)` | 输入框/textarea聚焦glow |
| `--shadow-btn-danger` | `0 4px 14px rgba(220,38,38,0.30)` | 危险按钮hover投影 |
| `--shadow-filter-tab` | `0 1px 3px rgba(0,0,0,0.08)` | filter-tab.active投影 |
| `--shadow-sidebar-tab-active` | `0 2px 8px rgba(79,70,229,0.3)` | 侧栏激活tab投影 |
| `--shadow-card-analytics` | `0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.06)` | 分析看板卡片阴影 |
| `--radius-bar` | `4px` | 柱状图圆角 |
| `--letter-spacing-badge` | `0.5px` | Badge/表格表头 |
| `--letter-spacing-section` | `1px` | 侧栏分区/rank标签 |
| `--padding-card-compact` | `28px 28px 28px` | 项目卡片变体 |
| `--padding-card-analytics` | `20px 24px 24px` | 分析看板卡片变体 |
| `--padding-btn-analytics` | `8px 20px` | 分析看板按钮变体 |
| `--padding-input-analytics` | `8px 12px` | 分析看板输入框变体 |
| `--padding-context-menu` | `6px` | context-menu内边距 |
| `--gap-cards-compact` | `24px` | 项目页卡片间距 |
| `--gap-filter-tab-group` | `3px` | filter-tabs内部padding |
| `--width-sidebar` | `220px` | 分析看板侧栏宽 |
| `--width-sidebar-collapsed` | `60px` | 分析看板侧栏折叠宽 |
| `--width-content-max` | `1200px` | 内容区最大宽度 |
| `--size-color-swatch` | `32px` | 颜色选择色块 |
| `--size-empty-state-icon` | `72px` | 空状态图标容器 |
| `--size-dialog-icon-wrap` | `56px` | 对话框警示图标容器 |
| `--size-svg-icon` | `18px` | 标准SVG图标 |
| `--size-svg-icon-sm` | `14px` | 小SVG图标 |
| `--size-svg-icon-lg` | `26px` | 大SVG图标 |
| `--font-family-mono` | `"SFMono-Regular", Consolas, ...` | 代码路径等宽字体 |

### 11.3 推断→已验证的Token

| Token | 原状态 | 依据 |
|-------|--------|------|
| `--color-primary-subtle-active` | 推断 | 分析看板`.researcher-tag`使用`background: --color-primary-subtle-active` |

### 11.4 依赖更新

| 依赖项 | 旧版本 | 新版本 |
|--------|--------|--------|
| sitemap.md | v0.3 | v0.3（不变） |
| 原型文件 | run4(单页) | 全部6个原型完成 |

---

## 12. 待统一项——原型中发现的硬编码值

以下值在原型中直接硬编码，未使用CSS变量。建议在工程化阶段统一替换为Token。

### 12.1 硬编码色彩

| 值 | 出现位置 | 出现页面数 | 建议Token |
|-----|---------|-----------|----------|
| `#C7D2FE` | 卡片hover标签边框色 | 1(模式选择) | --color-primary(30%透明度)或新增`--color-primary-border-light` |
| `rgba(79,70,229,0.05)` | 卡片选中态背景 | 1(模式选择) | 接近`--color-primary-subtle`，或新增中间值 |
| `rgba(255,255,255,0.06)` | inline-confirm背景、sidebar tab hover | 2(模式选择+分析看板) | 深色背景通用高亮值 |
| `rgba(255,255,255,0.08)` | 侧栏header/页脚border、文字按钮hover背景 | 2(分析看板+模式选择) | 建议新增`--color-border-on-dark-subtle` |
| `rgba(255,255,255,0.12)` | 侧栏tab badge背景、帮助按钮光晕 | 2(分析看板+模式选择) | 建议新增`--color-badge-on-dark` |
| `rgba(255,255,255,0.2)` | 侧栏active tab badge背景 | 1(分析看板) | — |
| `rgba(255,255,255,0.8)` | 聚类散点边框 | 1(分析看板) | — |
| `#FAFBFC` | preview-mock-card背景 | 1(快消工作区) | 接近`--color-bg-workspace` |
| `#EEF2FF` | 点选纠错颜色调整临时背景 | 1(长期工作区) | — |
| `#FFFBFB` | danger-zone背景 | 1(设置页) | `--color-danger-bg`加白 |
| `#B91C1C` | 危险按钮hover背景（已在§1.2新增） | 2(我的项目+设置) | `--color-danger-hover`(已新增) |
| `#047857` | btn-success hover背景 | 1(分析看板) | 建议新增`--color-success-hover` |
| `rgba(220,38,38,0.30)` | 危险按钮hover阴影（已在§3.2新增） | 1(设置页) | `--shadow-btn-danger`(已新增) |

### 12.2 硬编码字体/字号

| 值 | 出现位置 | 出现页面数 | 建议 |
|-----|---------|-----------|------|
| `11px` | version-tag、toolbar-badge、timeline-current-badge、bar-chart y轴标签 | 3(模式选择+快消+分析看板) | 新增`--font-size-micro: 11px` |
| `10px` | 文件夹箭头、file-status、折线图y轴标签 | 2(长期工作区+分析看板) | 新增`--font-size-tiny: 10px` |
| `13px` | 预览区mock元素、quick-options标题 | 2(快消+长期工作区) | `--font-size-small`(13.5px)已接近 |

### 12.3 硬编码间距/尺寸

| 值 | 出现位置 | 出现页面数 | 建议 |
|-----|---------|-----------|------|
| `1.5px` | option-card边框、project-card边框 | 3(快消+长期+我的项目) | 新增`--border-width-card: 1.5px`或统一为2px |
| `9px 14px 9px 36px` | 搜索框内边距 | 1(我的项目) | 建议新增搜索框padding变体 |
| `20px 24px`(分析看板padding-card) | 分析看板 | 1(分析看板) | 已记录为`--padding-card-analytics` |
| `28px`(stat-value) | 统计卡片数值字号 | 1(分析看板) | 比hero小，建议独立Token |
| `22px`(bar-chart track height) | 水平条高度 | 1(分析看板) | 建议新增`--size-bar-track` |

### 12.4 硬编码阴影

| 值 | 出现位置 | 出现页面数 | 建议 |
|-----|---------|-----------|------|
| `0 4px 12px rgba(79,70,229,0.15)` | 卡片选中态阴影 | 1(模式选择) | 建议新增`--shadow-card-selected` |
| `text-shadow: 0 1px 2px rgba(0,0,0,0.2)` | 水平条数值文字阴影 | 1(分析看板) | — |
| `0 1px 3px rgba(0,0,0,0.08)` | filter-tab.active阴影 | 1(我的项目) | 已记录为`--shadow-filter-tab` |

### 12.5 硬编码SVG属性

| 值 | 出现位置 | 建议 |
|-----|---------|------|
| `stroke-width: 1.8` | 设置页tab图标、内容区section图标 | 建议新增`--svg-stroke-width-tab: 1.8` |
| `stroke-width: 2.5` | 完成勾、新建加号 | 建议新增`--svg-stroke-width-bold: 2.5` |
| `stroke-width: 1.5` | 空状态图标、警示图标 | 建议新增`--svg-stroke-width-light: 1.5` |

### 12.6 优先级建议

- **高优先级**（跨页面出现）：`11px`字号、`1.5px`边框、`#B91C1C`(已解决)
- **中优先级**（单页面但影响视觉一致性）：`#C7D2FE`、`rgba(255,255,255,0.06/0.08/0.12)`系列
- **低优先级**（单页面一次性使用）：`#EEF2FF`、`#047857`

---

> 下一步：工程化阶段——将§12待统一项替换为CSS变量；将`:root`块输出为独立CSS文件；组件样式对接前端框架(React/Tailwind)。

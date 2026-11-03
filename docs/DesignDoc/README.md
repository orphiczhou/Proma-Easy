# 向导Agent多智能体协同开发平台

> 南京大学"Agent 编程方法论实验"——基于 Proma 源码构建的多智能体协同开发平台。
> 项目代号：nanju

---

## 项目简介

构建一个"向导Agent + 编程Agent"双脑协同平台，让零编程基础的用户通过自然语言对话驱动完整的软件项目开发。平台基于 Proma（Electron+React+TypeScript）源码扩展，实现向导Agent串行角色切换（需求分析师→UI/UX顾问→架构设计师→工程经理），编程Agent代码生成与自修复，以及裁判Agent质量门禁。

## 文档导航

| 目录 | 内容 | 状态 |
|------|------|------|
| `01_PRD/` | 产品需求文档 + 用户故事 | ✅ 已确认 |
| `02_UX_DESIGN/` | 信息架构、用户流程、HTML原型、设计系统、交互规范 | ✅ 已确认 |
| `03_ARCHITECTURE/` | 架构总览、类图、时序图、数据模型、技术探索报告 | ✅ 已确认 |
| `04_API_SPEC/` | Agent间/前后端接口规范 | ⬜ 待推进 |
| `05_PROJECT_PLAN/` | Sprint计划、团队配置、工作流 | ⬜ 待推进 |
| `.context/` | 质量标准、进度快照、规划文档 | 📋 持续更新 |
| `proma-source/` | Proma 源码（扩展基座） | 📦 参考 |

## 快速开始

### 环境要求

- Node.js 20+
- Bun (Proma 包管理器)
- Git

### Proma 源码

项目 `proma-source/` 目录包含 Proma 最新源码（不含 node_modules/.git）。
原始仓库：[ErlichLiu/Proma](https://github.com/ErlichLiu/Proma)

安装依赖（在 proma-source/ 目录）：
```bash
cd proma-source
bun install
```

### 项目结构

本平台通过代码级集成扩展 Proma，关键扩展点参见 `03_ARCHITECTURE/architecture.md` §4.2。

## 贡献指南

- 文档遵循 `设计阶段-文档产出清单与质量标准.md` 规范
- 使用 nanju 树形会话执行体系进行多 Agent 协同开发
- 所有文档产出需经过两阶段评审（Agent洁净室 + 人机交互）

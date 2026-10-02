# 架构前置探索 · 总览

> 日期：2026-06-06 | 状态：**三通道全部完成** ✅ → 可启动架构设计

---

## 快速入口

→ **技术架构探索总报告**：`技术架构探索总报告.md`（汇总全部发现和决策）

## 目录结构

```
03_ARCHITECTURE/exploration/
├── README.md                          ← 本文件
├── model-capability-matrix.md         ← 模型能力测试结果（通道A产出）
├── task-pkg-a1-proma-source/          ← 通道A：Proma源码全面分析
│   ├── README.md
│   └── proma-source-analysis.md       ← 产出
├── task-pkg-a2-agent-mechanism/       ← 通道A：Agent核心机制验证
│   ├── README.md
│   └── agent-mechanism-report.md      ← 产出
├── task-pkg-a3-tech-feasibility/      ← 通道A：技术组件可行性
│   ├── README.md
│   └── tech-feasibility-report.md     ← 产出
├── task-pkg-b1-frontend-arch/         ← 通道B：前端架构与扩展点
│   └── README.md
├── task-pkg-b2-session-context/       ← 通道B：会话管理与上下文
│   └── README.md
├── task-pkg-b3-sandbox/               ← 通道B：沙箱方案
│   └── README.md
├── task-pkg-b4-click-to-fix/          ← 通道B：点选纠错实现路径
│   └── README.md
├── task-pkg-c1-glm-verification/      ← 通道C：GLM 5.1 编程能力验证
│   └── README.md
└── task-pkg-c2-minimax-verification/  ← 通道C：MiniMax 2.7 多模态验证
    └── README.md
```

## 执行状态

| 任务 | 通道 | 状态 |
|------|------|------|
| 通道A 全部14个子任务 | A | ✅ 已完成，四维审计收敛 |
| PKG-B1 前端架构与扩展点 | B | ⬜ README就绪，待你开Pro会话 |
| PKG-B2 会话管理与上下文 | B | ⬜ README就绪，待你开Pro会话 |
| PKG-B3 沙箱方案 | B | ⬜ README就绪，待你开Pro会话 |
| PKG-B4 点选纠错实现路径 | B | ⬜ README就绪，待你开Pro会话 |
| PKG-C1 GLM 5.1 编程验证 | C | ⬜ README就绪，待你手动（GLM原生API） |
| PKG-C2 MiniMax 2.7 多模态验证 | C | ⬜ README就绪，待你手动（MiniMax原生API） |

## 使用方法

**通道A**：已完成，产出文件在各 task-pkg-a*/ 文件夹内。

**通道B**：你在 Proma 中新建会话（deepseek-v4-pro主导），打开对应任务包的 README.md 即开始。完成后将产出文件放入对应文件夹。

**通道C**：你用 GLM 5.1 / MiniMax 2.7 原生 API 独立调用，READMEx 包含完整的测试 Prompt 模板和输出要求。完成后将产出文件放入对应文件夹。

## 通道C任务包概要

| 包号 | 模型 | 子任务 | 核心问题 |
|------|------|--------|---------|
| PKG-C1 | GLM 5.1 | T1.3 基础编程 + T3.9 端到端全栈项目 | GLM能当编程Agent主力吗？ |
| PKG-C2 | MiniMax 2.7 | T1.4 多模态基础 + T3.10 6原型完整审查 | MiniMax能当UI/UX顾问吗？ |

每个 README 包含完整 Prompt 模板、输入输出说明、评估维度、不需要理解项目背景即可独立操作。

## 关键路径

Proma源码位于：`d:\桌面\Agent 编程方法论实验-南大大一\proma-source`

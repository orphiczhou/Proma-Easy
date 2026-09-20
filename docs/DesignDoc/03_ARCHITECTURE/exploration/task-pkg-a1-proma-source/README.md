# 任务包 A1：Proma 源码结构全面分析

> 通道：A（SubAgent 由本会话调度） | 依赖：无 | 预计耗时：并行4个SubAgent约15分钟

---

## 任务目标

全面分析 Proma 源码，输出项目结构、核心模块、扩展机制的系统化理解。

## 输入资源

| 资源 | 路径 |
|------|------|
| Proma 源码 | `d:\桌面\Agent 编程方法论实验-南大大一\proma-source` |

## 子任务（4个SubAgent并行）

### A1.1 项目目录结构与模块概览
- 递归列出完整目录树（排除 node_modules、.git、dist）
- 给每个一级/二级目录标注职责（一句话）
- 识别 monorepo 结构（apps/packages 等）

### A1.2 核心入口与启动流程
- 找到 main 入口文件
- 梳理应用初始化流程（配置加载 → Agent注册 → 服务启动）
- 画出启动流程图

### A1.3 Agent 定义与调度机制
- Agent 如何定义和注册（代码或配置？）
- System Prompt 的加载方式（文件/模板/代码内嵌？）
- Tool 工具的注册机制
- Skill 的加载机制
- 是否支持运行时切换 Prompt？

### A1.4 文件系统与项目管理
- Proma 如何管理用户项目目录？
- 文件的读/写/创建/删除机制
- 是否有项目模板或脚手架机制？

## 输出要求

每个子任务产出各自的报告放在本文件夹内，最终汇总为一份 `proma-source-analysis.md`。

## 方法

本会话用 Agent 工具并行启动4个 SubAgent，每个负责一个子任务。SubAgent 可以 Read/Grep/Glob 等工具直接操作 Proma 源码。结果由主会话汇总。

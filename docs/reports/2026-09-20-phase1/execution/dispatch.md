# Phase1 执行调度记录

> 2026-09-20 13:34 GMT+8 用户授权使用remote-session国内模型完成整个改进计划，父会话cfce785b负责架构、分工、难点、集成与审计迭代。文档版本1.0.0。

## 编制与文件所有权

实际使用remote-session实例release(19876)仅作会话运行，禁止改其部署/配置。默认工作区ID 8a18a730-6424-4d23-9c65-69446fdca837。

| 会话 | 模型 | ID | 独占范围 |
|---|---|---|---|
| B0基线 | deepseek/deepseek-flash | be6f919e-f3a3-43f3-96ba-d818cb4f032b | execution/baseline，只读产品源码，/dev/shm固定HEAD副本 |
| GWT | OpenCode Go/glm-5.3-flash | 73226aaf-0ec0-4db8-b77a-6031e3e06556 | nanju-gwt-runner.ts/.test.ts |
| 资源 | MiniMax/MiniMax-M3 | 0b02c21c-0c25-4f48-89a8-e97b9cc4c270 | nanju-engineering-template.ts/.test.ts、新resources模块和校验脚本；六模板md/README/manifest/Spike协议，禁止改skeleton/check_env |
| driver | deepseek/deepseek-v4-pro | 945b6093-1dd0-4450-bd9d-08d000e32d1c | engineering-execution/process-driver/suite及测试、driver-skeleton测试与py/cjs骨架 |
| 父指挥官 | gpt-6-astra-1 | cfce785b-3470-46fc-859e-572df78e7b11 | 恢复架构、snapshot/IPC/preload/shared/Guide UI；后续结构化拒因及公共大文件集成 |

四份首条任务书已发，工具返回Main runtime request timed out: agent.capability.customTool，但消息已持久化且13:46实际存在baseline输出/GWT测试进程，**不应重复下发任务**。remote_list_messages目前仅返回用户消息，可能不能及时读取Pi输出；用产物文件与session状态交叉核实。

## 执行策略

- 基线HEAD34f72fbc v0.17.131，既有AGENTS/Agent/报告计划文档未提交保留。
- 系统盘只有94MB（13:46降79MB）。曾建两个33MB worktree，第三个失败；已撤销只包含本轮临时内容的两个worktree。没有清理用户历史/备份。
- 改用单工作树严格文件所有权；共享node_modules禁止安装/变动。临时测试可/dev/shm(3.8GB可用)，最终证据归项目。
- 子会话不得再委派，不commit/push、不改package版本、不pack/build/部署或重启。父统一版本、构建、集成。
- 首轮B0/B1/B2及提前驱动协议片；其后必须继续B3–B6并组织独立国内多模型审计迭代。未实施部分不得宣称完成。
- 磁盘限制打包，需在进入构建部署前解决；不要未经确认删旧部署备份。

## 任务状态

13:46：四执行会话已创建且收到任务，B0产生full-tests/junit/test-baseline，GWT正在跑测试。尚未审阅最终结果。父正开始恢复设计。

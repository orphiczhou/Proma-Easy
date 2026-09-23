# 当前未验证门（2026-09-23）

| 门 | 状态 | 原因 | 不得外推 |
|---|---|---|---|
| Electron build/pack | BLOCKED | 根盘约115MB；pack需至少约1GB，且本轮未获清理旧产物授权 | 源码/CLI绿不等包内绿 |
| afterPack 真实运行 | NOT-RUN | 新增脚本已做 node --check，未实际pack | 不宣称部署资源正确 |
| dev隔离GUI | BLOCKED | dev未运行，9224未监听；当前边界不启动/不部署 | 不宣称真流程通过 |
| 旧工程恢复产品入口 | BLOCKED | 需要运行中dev与用户可达恢复入口 | 旧工程静态事实不等恢复完成 |
| 干净工程平台quick全链 | BLOCKED | 无dev实例；release编排样本不等平台流程 | 不宣称US覆盖 |
| 六品类产品验收 | NOT-ESTABLISHED | 仅模板/契约/驱动定向验证，缺代表工程真实从头到交付 | 不宣称六品类验收完成 |

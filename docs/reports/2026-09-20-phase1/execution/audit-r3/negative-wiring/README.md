# R3 negative-wiring · 脚本与日志（只读审计，不修改产品代码）

## repro-env-probe-category-reuse（审计重点反例：env_probe.json 幂等不比对品类）

- 可运行脚本：`__r3-audit-repro-envprobe.test.ts`
  - 因 bun mock.module 的 specifier 解析限制（仓库既有模式），运行时需临时拷入
    `apps/electron/src/main/lib/`（mock './config-paths' 才与被测模块同源），跑完即移回本目录。
  - 运行记录（2026-09-23 21:23 GMT+8，bun 1.3.14，夹具=隔离 mktemp）：
    `repro-env-probe-category-reuse.log`
  - 结果：**反例成立** —— 第一次 universal 探测落盘后，第二次以 category=desktop-app
    调用 runEnvProbe，fresh 命中直接复用旧结果（written.category 仍为 'universal'，
    desktop 专用组件 webkit2gtk-4.1 缺失），未触发重跑。
- `repro-env-probe-category-reuse.test.ts`：独立路径变体（在 LIB 目录外 mock 不生效，
  保留作记录；结论以可运行版为准）。

## 复跑日志

- `w-i-b-e-wiring-rerun.log`：w-i-b-e-wiring.test.ts 复跑 = **24 pass / 0 fail / 104 expect**
  （product-acceptance.md 与 findings.json 所称 "46/46" 与此不符，见 wiring-semantics.md W-05）。

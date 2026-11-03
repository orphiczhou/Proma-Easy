# Gate 审计反例测试（2026-09-23，只读审计产出）

本目录是独立审计员为 8 类主动反例编写的 negative 测试（基于 sha256 快照
`file-hashes-20260923.md`，HEAD `34f72fbc`）。**审计只读：这些文件未合入产品测试套件，
也未改动任何产品代码。**

## 运行方式

测试 import 路径按「与 `apps/electron/src/main/lib/` 同级」编写（`./nanju-*`）。
将本目录下 `neg-*.test.ts` 复制（或软链）到
`apps/electron/src/main/lib/__tests__/gate-audit-negative/` 后运行：

```bash
cd apps/electron && bun test src/main/lib/__tests__/gate-audit-negative
```

## 断言语义标记

- `// AUDIT-RED（现状）`：断言当前真实行为，即该反例**当前能通过/被放行**——作为缺陷证据固化。
- `// AUDIT-EXPECT`：审计期望的正确行为。带 `xfail`/`todo` 的用例表示期望行为尚未实现
  （先记录，不要求本次修复；是否修复由工程侧裁决）。

## 文件 ↔ 反例类目对照

| 文件 | 反例类目 |
| --- | --- |
| neg-01-us-coverage-not-applicable.test.ts | US 编号归一 / 三类覆盖 / notApplicable 弱理由绕过 |
| neg-02-frozen-baseline-change.test.ts | 冻结基线后需求变更（含基线文件可被重写自证） |
| neg-03-contract-id-steps.test.ts | contract.test id 冒充 steps 绑定 |
| neg-04-click-to-fix-cross-stage.test.ts | testing 点选跨阶段写 / 失效声明无程序化兑底 |
| neg-05-gatecheck-consistency.test.ts | 结构化 GateCheck 一致性（fail-open 静默通过） |
| neg-06-pending-cancel-idempotent.test.ts | 旧 schema pending / 取消 / 幂等续接 |
| neg-07-skip-error-wash.test.ts | skip/error/blocked 不能洗通过（必测语义回归钉） |
| neg-08-delegate-guard-adversarial.test.ts | 门禁误拦与暗语分词（零宽字符 / 邻近窗口拉距） |

# 点选纠错（Click-to-Fix）E2E 验证脚本

南大项目「点选纠错」交互（interaction-spec 交互1）的真实 Chromium 端到端验证。
覆盖 v0.17.58（P1 改文字原地编辑 / P2a 拖拽持续模式 / P2b 绝对偏移 / P3 语音链路）
与 v0.17.59（matrix3d 终态串 / finalTransform 一等字段上报链路）。

## ⚠️ 必须真实 Chromium

这些脚本通过 CDP（Chrome DevTools Protocol）驱动**真实渲染进程**的合成鼠标/键盘事件，
不能在 Node/JSDOM 里跑：拖拽链路依赖 pointerdown preventDefault + setPointerCapture +
computed transform 级联等浏览器真实行为（CDP 合成事件首轮有 mouse 抑制 quirk，脚本内已用
warmup 微拖处理）。

## 前置条件

| 依赖 | 说明 |
|------|------|
| Proma dev 实例 | `bun run dev`（仓库根），南大项目会话打开且预览 iframe 可见 |
| CDP 9224 | dev 实例需带 `--remote-debugging-port=9224`（脚本固定连 `127.0.0.1:9224`） |
| DISPLAY | Linux 需 X11 会话；无头环境用 `xvfb-run` 包装（**CI 可选**，见下） |
| bridge 19877 | 仅语音链路（e2e-v58-final-rerun.py 的 P3 段）依赖 ASR bridge；跑不动可跳过该段 |
| python3 + websocket-client | `pip install websocket-client`（另需 `curl`） |

## 脚本清单

| 脚本 | 验证内容 | 判定输出 |
|------|---------|---------|
| `e2e-v58-final-rerun.py` | P3 语音（targetInputId 路由/角标/清单）、P1 改文字原地编辑（contentEditable/Enter/清单）、P2a 拖拽持续模式（多轮累积/点自身不弹面板）、P2b 绝对偏移（样式表基线 51,-5 精确串） | `P3/P1/P2a/P2b: PASS/FAIL` + `EVIDENCE:` JSON |
| `e2e-v58-p2b-final.py` | P2b 专项：样式表 `translate(31px,-9px)` 基线 + 合成事件拖拽 → `translate(51px, -5px)` 精确串 + 清单条目 | `P2b: PASS/FAIL` |
| `e2e-v59-matrix3d.py` | WO7：`translateZ(40px)` 夹具 → matrix3d 完整解析；真实拖拽后 inline=含 `[12]/[13]/[14]` 的 16 值 matrix3d 精确串；`agent:report-click-to-fix`（接受本轮改动）载荷含 `finalTransform` 终值文本（hook 收集并阻断真实注入，零副作用） | `M3D E2E: PASS/FAIL` + `EVIDENCE:` JSON |

## 运行

```bash
cd apps/electron/e2e
python3 e2e-v59-matrix3d.py          # v0.17.59 matrix3d 终态链路
python3 e2e-v58-final-rerun.py       # v0.17.58 四段回归
python3 e2e-v58-p2b-final.py         # P2b 专项
```

每个脚本自带夹具注入与清理（style[data-p2b]/[data-m3d] + 临时元素 + 角标清扫），
跑完原型恢复原状；`e2e-v59-matrix3d.py` 的「接受」按钮点击被 hook 阻断
（返回 `{ok:false}`），不会向调度员会话真实注入消息。

## CI（xvfb 可选）

- 有 X11 的自托管 runner：直接跑。
- 无头 CI：`xvfb-run -a python3 e2e-*.py`（CDP 合成事件经 xvfb 虚拟显示仍可派发；
  若 runner 无 xvfb，跳过本目录（它们是人工验收级回归，不作为 CI 硬门禁）。
- CDP 9224 与南大预览 iframe 属运行时前置，CI 中需先起 dev 实例并打开项目会话，
  成本较高——建议保留人工/自托管场景执行。

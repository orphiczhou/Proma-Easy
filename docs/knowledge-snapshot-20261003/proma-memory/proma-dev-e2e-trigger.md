# dev 实例真流程 E2E 触发方法（2026-09-19 实战验证）

> 场景：测试 PromaEasy 平台 quick 工程全流程（requirements→prototype→architecture→coding→testing）必须驱动 dev 实例的真流程引擎，而非手动编排 Agent 会话（编排版测不出平台机制，2026-09-19 编排版教训）。以下方法全链实战验证通过。

## 1. dev 实例部署新代码（构建→配套替换）

- 构建：`cd /home/orphic/proma-patches/p1-quick-engineering/apps/electron && ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" CSC_IDENTITY_AUTO_DISCOVERY=no bun run pack`（产物 out/linux-unpacked/，二进制名 `proma`）
- **asar 与 app.asar.unpacked 必须同一次 pack 配套部署**（22:43 asar 配 22:40 unpacked → 启动即崩循环；二进制 electron 版本一致时无需替换，只换 resources/ 即可）
- dev 部署位：`/home/orphic/proma-easy/dev/app/resources/`（替换前备份 `app.asar.bak-v<版本>-<日期>`，历史 bak 链保留）
- 版本号必须每批 bump `apps/electron/package.json`（v129/v130 曾漏 bump，补丁 0605b0a5）

## 2. dev 正确启动（隔离参数是关键）

```bash
cd /home/orphic/proma-easy/dev
PROMA_INSTANCE=dev PROMA_DEV=1 DBUS_SESSION_BUS_ADDRESS=<当前桌面dbus> DISPLAY=<当前X> XDG_RUNTIME_DIR=/run/user/1000 \
  setsid ./app/proma-dev --remote-debugging-port=9224 --remote-allow-origins="*" > /tmp/dev-run.log 2>&1 < /dev/null &
```
- **run-proma-dev.sh 无隔离参数（会挂到 release 配置 ~ ~/.proma，单实例锁冲突）——勿用**
- start-dev.sh 是用户桌面启动器（含锁清理+隔离，但无 DBUS 环境时从终端跑不起）
- 启动后验证：log 首行"配置目录: ~/.proma-dev/（开发模式）"+ 端口 19877（MCP）+ 9224（CDP）
- pkill 后要清 `~/.config/Proma-dev/Singleton*` 锁

## 3. CDP 驱动 UI（方法库在 e2e-w24，W24/W25 时代沉淀）

- 库：`/home/orphic/proma-easy/dev/e2e-w24/cdp-lib.ts`（pickMainPage 选 >1000px 主窗/connect 的 ev+click/send），bun 直接跑 ts
- 本轮脚本：`/home/orphic/proma-easy/dev/e2e-v130/`（create-quick.ts 全链：点"南大向导"→快消卡"快速做一个工具"→ input[placeholder*="起个名字"]填名→**勾"自动补完需求"（autoClarify）**→"开始创建"→切会话→编辑器 .tiptap.ProseMirror 点击+Input.insertText+发送按钮）
- **发送按钮定位**：编辑器（getBoundingClientRect 约 x356 y737 w734）右侧邻域图标按钮（本窗 2200x905 时坐标 1066,862——按"编辑器右侧 x>1000 y>700 邻域"动态找，勿用固定坐标）
- **发消息前必须先切到目标会话**（点会话列表同名条目）——UI 激活会话≠你想发的会话（踩过：推进消息发给 AC 攻击会话）

## 4. 阶段机特性（重要）

- quick 主控会话（channel=null，**remote_send_message 不可用**，只能 CDP 输入框）
- **每阶段收口后 turn 结束等外部消息点火**——autoClarify 只覆盖需求补充确认，不自动跨阶段。指挥官用 advance 脚本逐段推进（e2e-v130/advance.sh "消息"）
- 主控会输出 `<!-- PHASE_ADVANCE: coding -->` 标记（平台解析）
- 平台门禁矩阵实战：stage-gate 关键词（"技术"等跨阶段词拦委派，主控用拼接/空格化自适应）、收口一致性校验（"缺失"vs projectEnv:ready 矛盾拦）、archEvidenceGate（[实证] 须 URL+检索日期，倒逼真实浏览器检索）、PENDING token 扫描（连"声明无未决"句都拦）——**门禁严→架构阶段反复打磨（实测 3.5h vs 编排版 30min），效率权衡待平台改进**

## 5. 观察员配发参照样本（用户 2026-09-19 指令）

派观察员必须同时配发参照物（否则只能看热闹）：原始设计（/home/orphic/proma-projDoc/DesignDoc/ + PRD §5.3 目录规范）+ 平台改动点清单（v126-130 逐项观察表）+ 对照基线。样本文件模式见 e2e-v130/observer-ref.md。

## 6. 已知坑

- CDP 9224 需 --remote-debugging-port 启动参数且实例独占；桌面图标启动（start-dev.sh）也带 9224
- e2e 工程 01_PRD 等目录由流程引擎自动生成（编排版需手动补档——平台 project 结构三件套：project-<id> 目录 + _project-info.json + workspace 的 _nanju-projects.json 注册）
- DISPLAY 时效：桌面会话重启后 :11.0→:12.0（探测类机制要带时间戳，观察员 O3 发现）

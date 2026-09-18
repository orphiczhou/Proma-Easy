# 桌面应用 · 工程模板 v2

> 版本：v2.0 | 代号：`desktop-app` | 适用模式：快消型 & 长期迭代型
> 证据等级图例：**[实证]**=本机真实跑通并留证据（来源：2026-09-17 夜间语音输入法实测，下称"昨晚实测"）；**[文证]**=有外部来源；**[推断]**=待验证（挂接建议 Spike）。
> v1→v2 主要变化：新增 §2 组件环境清单、§5 测试闭环样例、§6 Spike 协议、§7 坑库；§1 改为双路径矩阵；v1 全文（157 行）见模版源头 `nanju-guide/09_工程模板/04-desktop-app/template-v1.md`（本文件为全量替换，v1 已归档为独立文件；运行时快照侧 v1 原文见平台 git 历史 v0.17.125）。

---

## 0. 品类判定

### 0.1 判定特征（≥3 条命中即归入）

- [ ] 交付物是运行于用户桌面 OS（Windows/macOS/Linux）的窗口程序或常驻进程
- [ ] 需要 GUI 窗口、系统托盘、全局热键、通知等桌面集成能力中至少一项
- [ ] 需要访问桌面特有资源：剪贴板、屏幕、音频设备、全局输入注入
- [ ] 用户说："做个电脑桌面工具 / 桌面软件 / 客户端 / 输入法 / 截屏工具 / 录音工具"

### 0.2 反例与边界

| 用户表述 | 实际需求 | 分流 |
|---------|---------|------|
| "做个电脑上的记账工具" | 若数据要云同步+浏览器可访问 | → `web-fullstack` |
| "帮我批量改文件名" | 无 GUI、命令行即可 | → `cli-tool` |
| "做个手机上的xx" | 移动端 | → `mobile-app` |
| "桌面工具但要 AI 对话为核心" | AI 逻辑为主、桌面为壳 | 仍归 desktop-app，AI 对接参考 `ai-application` §2.4 |

### 0.3 子形态：双路径

| 路径 | 适用 | 判据 |
|------|------|------|
| **P1 快速验证路径（Python）** | 系统集成类工具（注入/音频/热键/托盘），需要最快跑通闭环、验证可行性 | 项目核心风险在"环境能不能跑通"而非"分发好不好看" |
| **P2 正式交付路径（Tauri v2）** | 有 UI 密度要求、要跨平台分发安装包 | 环境风险已被 Spike 排除后转入 |

> **昨晚实证**：语音输入法（注入+音频+热键+托盘）实际走 P1 [实证]。P1 优先不是放弃质量，而是先消灭环境不确定性（本模版 §7 坑库的大部分条目只有 Python 路径有实证）。

---

## 1. 技术栈矩阵

### 1.1 P1 快速验证路径（Python，本机可验证优先）

| 层级 | 选型 | 为什么 | 证据等级 |
|------|------|--------|---------|
| 语言 | Python 3.10+ | 系统集成库（X11/PulseAudio/DBus）绑定最全，无编译链负担 | [实证] |
| 输入注入/监听 | pynput | 纯 Python 封装 X11/XCTest，监听+注入一体 | [实证]（ASCII 注入与全局监听） |
| 音频采集 | sounddevice（依赖 portaudio） | 录音最短路径；numpy 数组直出，便于接 ASR | [实证] |
| 托盘 | pystray | 三平台托盘，配合 PIL 生成图标 | [实证] |
| 通知 | notify-send / dbus（Linux）、osascript（macOS） | 不引入 GUI 框架依赖 | [文证] |
| 剪贴板 | xclip（Linux 子进程） / pyperclip | 注入兜底方案载体 | [实证]（剪贴板兜底可行） |
| 云端 ASR | DashScope HTTP API（见 §2.4） | 无本地模型依赖，一条 HTTP 即可闭环 | [实证] |

### 1.2 P2 正式交付路径（Tauri v2）

沿 v1 模版结论保留：Tauri v2 + React 19 + TypeScript + Vite 7 + Tailwind v4 + shadcn/ui + tauri-specta + Zustand/TanStack Query；打包 Tauri bundler（.msi/.dmg/.deb/.AppImage）。何时用 Electron：团队无 Rust 经验且时间紧迫、需要大量 Node 原生模块。[文证：v1 模版 §1，本轮未重新验证]

### 1.3 选型决策表

| 条件 | 路径 |
|------|------|
| 核心功能涉及 X11/Wayland 注入、音频设备、全局热键且方案未经验证 | P1 先行（或直接 Spike） |
| 已有被验证的 Python 原型，要转正式产品 | 评估 P2 重写，或 Python+pyinstaller 打包交付 [推断待验证] |
| UI 密集（设置面板、列表、可视化） | P2 |
| 单次性内用工具、无分发需求 | P1 + venv 交付 |

### 1.4 不建议方案

| 方案 | 原因 |
|------|------|
| 全新项目直接上 Wayland-only API | 当前实测环境为 X11/xrdp [实证]；Wayland 注入需另行 Spike |
| P1 项目用 tkinter 做复杂 UI | 阻塞事件循环与 pynput/pystray 线程模型易冲突 [推断] |
| Windows 专属 API（SendInput 等）写入主路径 | 与实测环境（Linux/X11）不匹配，仅作平台分支 |

---

## 2. 组件环境清单

### 2.1 组件总览

| 组件 | 用途 | 必装性 | 功能域 |
|------|------|--------|--------|
| python3 + venv | 运行时 | 必须 | 基础 |
| portaudio（系统库） | 音频底层 | 音频类必须 | 音频 |
| sounddevice | 录音/播放 API | 音频类必须 | 音频 |
| pynput | 输入监听+注入 | 注入/热键类必须 | 注入/热键 |
| xclip | 剪贴板注入兜底 | 注入类按需 | 注入 |
| pystray + Pillow | 托盘图标与菜单 | 托盘类按需 | 托盘 |
| xdotool | 窗口/键事件诊断与备选注入 | 诊断按需 | 注入 |
| libnotify (notify-send) | 桌面通知 | 通知按需 | 通知 |
| requests 或 httpx | 云端 ASR 调用 | ASR 类必须 | 云服务 |

### 2.2 组件卡片

**C1 portaudio（系统库）**
- 探测：`ldconfig -p | grep portaudio` 或 `python -c "import sounddevice"`（ImportError 提示缺 libportaudio2 即本组件缺失）
- 安装：Debian/Ubuntu `sudo apt install libportaudio2`；macOS `brew install portaudio`
- 已知坑：**只 pip 装 sounddevice 不装系统库，import 即崩** [实证]；conda 环境可能自带 portaudio 导致路径混淆 [推断]
- 降级替代：无（音频采集的底层依赖）；纯播放提示音可用 `paplay`

**C2 sounddevice**
- 探测：`python -c "import sounddevice as sd; print(sd.query_devices())"`
- 安装：`pip install sounddevice numpy`
- 已知坑：xrdp/远程桌面会话常无真实麦克风设备，`query_devices()` 可能为空或只有虚拟设备 [实证]；此时用 §5.2 回环方案
- 降级替代：`pyaudio`（同样依赖 portaudio，无本质优势）；从 WAV 文件读音频先打通后续链路 [实证]（可先行开发）

**C3 pynput**
- 探测：`python -c "from pynput.keyboard import Controller, Listener; print('ok')"`（无 X DISPLAY 时报错）
- 安装：`pip install pynput`
- 已知坑：① **CJK 字符经 core keymap 注入对 XKB/GTK 应用无效（ASCII 可达）** [实证]——见 §7 PIT-DA-001；② 全局监听需 X 会话权限，Wayland 下基本不可用 [文证]；③ 需要 `$DISPLAY` 环境变量，cron/ssh 无头环境不可用 [实证]
- 降级替代：`xdotool key/type`（同为 XTEST，同等限制）；CJK 见 §7 PIT-DA-002/003 兜底链

**C4 xclip**
- 探测：`which xclip && echo ok`
- 安装：`sudo apt install xclip`
- 已知坑：写剪贴板后子进程退出可能丢失内容，需 `xclip -selection clipboard -l 1` 或保持进程 [推断]；`-selection primary` 与中键粘贴语义不同 [文证]
- 降级替代：`xsel`；GUI 内用 Tk clipboard（需 display）

**C5 pystray + Pillow**
- 探测：`python -c "import pystray, PIL; print('ok')"`
- 安装：`pip install pystray Pillow`
- 已知坑：托盘菜单回调在独立线程，直接操作 GUI/主状态需线程间通信（queue/调度回主线程）[推断]；图标需 Image 对象，别用文件路径热更后不刷新 [推断]
- 降级替代：无托盘，主窗口最小化 + 全局热键唤起 [实证]（昨晚方案即为"热键+通知"无托盘交互，可行）

**C6 xdotool**
- 探测：`xdotool help >/dev/null && echo ok`
- 安装：`sudo apt install xdotool`
- 用途：诊断用（`xdotool getactivewindow getwindowname`、`search --name`、`key`）；也是 XTEST 注入的命令行对照物
- 已知坑：与 pynput 同受 core keymap 限制 [实证]（同一注入路径）

**C7 libnotify / notify-send**
- 探测：`which notify-send && notify-send "probe" "ok"`
- 安装：`sudo apt install libnotify-bin`
- 已知坑：无通知守护进程时静默失败（返回 0 但无显示）[推断]；脚本中通知用于"驱动结果可见性"时要同时落盘证据，不能只靠通知 [实证]（教训见 §5.3）
- 降级替代：无头环境用日志文件 + 托盘 tooltip

### 2.3 环境一键探测脚本（照抄即用）

```bash
#!/usr/bin/env bash
# scripts/check_env.sh —— 输出 JSON 证据，供架构阶段与 Spike 使用
set -u
probe() { local name="$1" cmd="$2"; local out; out=$(eval "$cmd" 2>&1) && r=ok || r=fail; printf '{"component":"%s","status":"%s","detail":"%s"}\n' "$name" "$r" "${out//\"/\'}"; }
{
  probe "python3"      "python3 --version"
  probe "display"      "test -n \"${DISPLAY:-}\" && echo DISPLAY=${DISPLAY}"
  probe "portaudio"    "python3 -c 'import sounddevice'"
  probe "pynput"       "python3 -c 'from pynput.keyboard import Controller'"
  probe "xclip"        "which xclip"
  probe "xdotool"      "which xdotool"
  probe "pystray"      "python3 -c 'import pystray, PIL'"
  probe "notify-send"  "which notify-send"
  probe "audio-devices" "python3 -c 'import sounddevice as sd; print(len(sd.query_devices()))'"
} | jq -s '.' > env_probe.json 2>/dev/null || true
cat env_probe.json
```

### 2.4 外部服务环境：云端 ASR（以 DashScope 为例）

> 本节为昨晚实测核心踩坑点 [实证]，端点/模型/格式三项均已验证。

| 项 | 正确值 [实证] | 说明 |
|----|--------------|------|
| 端点 | `https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation` | 多模态生成端点 |
| 模型名 | `qwen3-asr-flash` | **`fun-asr` 系列模型名在该端点不存在**，报模型不存在错误 [实证] |
| 音频格式 | base64 data URI：`data:audio/wav;base64,<...>` | 放入 messages 的 audio 内容块 |
| 鉴权 | Header `Authorization: Bearer $DASHSCOPE_API_KEY` | key 走环境变量，不得写入代码 |
| HTTP 方法/体 | POST，JSON：`{model, input:{messages:[{role:user, content:[{audio:...},{text:...}]}]}}` | 与多模态对话接口同构 [实证] |

最小可跑样例（P1 路径，录音→识别闭环）：

```python
# probe_asr.py —— 录音 3 秒并调用 DashScope ASR，证据落盘
import base64, json, os, time, wave, requests

DUR = 3
wav = "evidence/sample.wav"
import sounddevice as sd
rec = sd.rec(int(DUR * 16000), samplerate=16000, channels=1, dtype="int16")
sd.wait()
with wave.open(wav, "wb") as f:
    f.setnchannels(1); f.setsampwidth(2); f.setframerate(16000)
    f.writeframes(rec.tobytes())

b64 = base64.b64encode(open(wav, "rb").read()).decode()
r = requests.post(
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
    headers={"Authorization": f"Bearer {os.environ['DASHSCOPE_API_KEY']}"},
    json={"model": "qwen3-asr-flash",
          "input": {"messages": [{"role": "user", "content": [
              {"audio": f"data:audio/wav;base64,{b64}"},
              {"text": "转写这段音频"}]}]}},
    timeout=60,
)
evidence = {"status_code": r.status_code, "resp": r.json() if r.ok else r.text[:500],
            "wav": wav, "ts": time.time()}
json.dump(evidence, open("evidence/asr_result.json", "w"), ensure_ascii=False, indent=2)
print(json.dumps(evidence, ensure_ascii=False))
```

- 已知坑：无 key / key 无权限时返回 401；模型名错时返回模型不存在——**这两种错误都要在驱动脚本里断言区分**，不得笼统当作"网络失败" [实证]。
- 降级替代：无网/key 时用本地 WAV 文件 + mock 响应先打通驱动与断言链路 [推断待验证]。
- 托盘验收边界：无 SNI（StatusNotifierItem）守护进程的会话（部分 xrdp/远程桌面）托盘图标不显示；架构的验收计划必须含"人工清单核查"项（列出托盘应有的菜单/行为清单由人工确认或环境证据替代），不得因托盘不可见直接计 fail [实证：G3b #83]。
- 存量配置迁移：产品迭代更换模型名/端点/密钥来源时，已落盘的用户级配置（如 config.toml）若无迁移策略会残留旧值、新代码按旧配置调用失败（G3b R7 根因）；凡引入持久化配置必须同时设计存量配置迁移/失效策略（配置版本字段或启动时重写）[实证：G3b R7]。

---

## 3. 目录结构

### 3.1 P1 快速验证路径（Python）

```
project/
├── 00_SPIKES/                      # Spike 实验产物（见 02-Spike实验协议.md §4）
├── scripts/
│   └── check_env.sh                # 环境一键探测（§2.3）
├── src/
│   ├── main.py                     # 入口：托盘/热键/引擎装配
│   ├── audio/                      # 采集（sounddevice 封装）
│   ├── injection/                  # 注入策略（core/xkb/atspi/clipboard 四策略类）
│   ├── hotkey.py                   # pynput 全局热键
│   ├── asr/                        # 云端 ASR 客户端（§2.4）
│   └── notify.py                   # 通知封装（notify-send 兜底日志）
├── drivers/                        # 驱动脚本（验收用，与 src 分离）
│   ├── drv_inject_text.py          # 注入驱动：expected/actual 落盘
│   └── drv_audio_asr.py            # 音频→ASR 驱动
├── evidence/                       # 运行证据（*.json / *.wav / 日志）
├── tests/                          # 单元测试（pytest）
├── requirements.txt
└── README.md
```

### 3.2 P2 正式交付路径（Tauri v2）

沿 v1 模版 §2 目录结构整体保留（src/ React + src-tauri/ Rust + tests/）。[文证：v1 模版] 增加 `00_SPIKES/` 与 `drivers/` 两个顶层目录，语义同上。

---

## 4. 核心配置

- P1：`requirements.txt` 固定小版本（`pynput==1.8.x` 样式）；系统依赖清单写进 `setup.sh`（apt/brew 分支），禁止只写 pip 依赖 [实证：portaudio 坑]。
- P2：tauri.conf.json CSP、capabilities 按需声明——沿 v1 §4 保留。[文证]

---

## 5. 测试闭环样例

### 5.1 闭环定义

**架构决定 → 驱动脚本 → 证据文件**，三者缺一不闭环。验收方不信任口头描述，只看 evidence/ 里带时间戳的文件。

### 5.2 标准闭环一：音频采集（无麦克风环境的回环自测）[实证]

场景：xrdp/远程桌面无真实麦克风。方案：PulseAudio 回环——把 `xrdp-sink.monitor` 作为录制源，同时在 sink 侧播放已知音频，即可自证"采集链路"畅通。

```bash
# 1. 列出可用 source，找到 *.monitor
pactl list sources short | grep -i monitor
# 2. 用 .monitor 作为录音源录 5 秒
parecord --device=xrdp-sink.monitor --format=s16le --rate=16000 --channels=1 evidence/loopback.wav &
REC=$!
# 3. 同期播放一段已知音频（paplay 任意 wav）
paplay /usr/share/sounds/alsa/Front_Center.wav
sleep 5 && kill $REC
# 4. 证据判读：loopback.wav 非全零、与播放时长匹配 → 采集链路通
python3 - <<'PY'
import wave, json
w = wave.open("evidence/loopback.wav")
frames = w.getnframes()
peak = max(abs(a) for a in __import__("array").array("h", w.readframes(frames)))
json.dump({"frames": frames, "peak": peak,
           "verdict": "captured" if peak > 100 else "silent"},
          open("evidence/audio_loopback.json", "w"), indent=2)
PY
```

判读规则 [实证]：`verdict == "captured"` 才算链路通；`silent` 时检查 pactl 模块与默认 sink。

### 5.3 驱动断言规范（三条硬规则，全部源于昨晚教训 [实证]；三条均由驱动骨架的运行时自检机制承载）

1. **expected/actual 严格同串**：断言目标字符串必须逐字节一致，禁止意译比对（例：期望"语音输入已开启"就不能拿"语音输入打开"当通过）。驱动脚本里 expected 作为常量写在文件头，actual 来自真实探测。——由骨架自检② 同源生成承载：`make_check`/`makeCheck` 的 actual 参数传 probe 函数、`assert_same_source`/`assertSameSource` 断言 actual 只能由探测产生。
2. **结果可见性：证据必须落盘**：驱动结果写 `evidence/*.json`（含 ts、expected、actual、verdict），**不得**只 print 到 stdout、不得只依赖通知气泡或进程存活来"证明成功"。——由骨架自检③ 输出 schema 校验承载：evidence 必须是非空字符串数组、stdout 只输出单个宿主协议 JSON；落盘文件仍按本条规则写 `evidence/`。
3. **被测进程崩溃隔离**：被测 engine 崩溃时，驱动脚本必须仍能产出证据（捕获退出码、tail 日志文件、`subprocess` + `timeout` 包裹），verdict 记 `engine_crashed` 而非静默无输出。**昨晚"engine 崩溃驱动结果不可见"即违反本条 [实证]**。——由骨架自检④ 顶层异常包裹承载：崩溃也产出结构化 error JSON（含 type、exit code、traceback 摘要）并以非零码退出，不再静默。

完整自检骨架随模版分发：**`driver-skeleton.py` / `driver-skeleton.cjs`**（与本文件同目录）——照抄到 `08_APP/drivers/` 后填充 `run_probes` / `runProbes` 中的探测逻辑即可使用。骨架内置五项运行时自检（非静态文本检查，运行时真实拦截）：

- ① **storyId 非空校验**（R2 类）：acceptance 驱动（covers 非空）的检查 storyId 空串/缺失 → 拦截为结构化 error（消息含 R2 指引），不产出无 storyId 的 checks；辅助测试 storyId 必须为 null。
- ② **expected/actual 同源生成**（A3 类）：actual 必须由 probe 探测函数产生，`assert_same_source` 断言同源——禁止手写同义文案（本节规则 1 的机制化）。
- ③ **输出 JSON schema 校验 + 退出码表**：序列化前自校验宿主协议形态；退出码 0=全部 pass / 1=存在 fail 或驱动异常 / 2=自检拦截（环境缺失/结构违规）。
- ④ **顶层异常包裹**（R3 类）：`except BaseException`（含 `SystemExit`，覆盖 `sys.exit` 路径；Node 侧为同步/异步异常 + `uncaughtException` 兜底）→ 结构化 error JSON（含 exit code 与 traceback 摘要）后按原退出码非零退出——崩溃也产出可判读输出，而非静默无输出。
- ⑤ **环境前置自检**：DISPLAY / 密钥类变量缺失 → 输出"环境前置自检"检查项并 exit 2（blocked），环境问题不伪装成产品 error。

### 5.4 无头/受限环境降级验证

| 受限 | 降级方案 | 证据等级 |
|------|---------|---------|
| 无麦克风 | §5.2 回环（.monitor）或 WAV 样例文件直读 | [实证] |
| 无 GUI 会话（ssh/cron） | pynput 不可用 [实证]；改测非 X 逻辑层（ASR/状态机），X 相关标 SKIPPED 并落盘原因 | [实证]+[推断] |
| 无 key/断网 | mock ASR 响应打通驱动链路，真实调用标 PENDING | [推断待验证] |

### 5.5 标杆测试闭环（本机可跑，B2 实证提炼）

> 来源：平台知识库《标杆解析-v1/测试闭环汇总》§2.5（2026-09-18，tauri 官方 examples 实证）。[文证：标杆实证]，本品类模板未串跑。与 §5.2-5.4 的关系：§5.2 是本品类 [实证] 的音频回环驱动闭环；本节补代码级门禁（cargo/vitest/打包），二者互补不重叠。

**① 工具链与命令** [文证：标杆实证]

```bash
cargo check && cargo test        # Rust 门禁：装了 rust 工具链即可跑，无需容器/GUI
pnpm test                        # 前端层 vitest，同 web-fullstack 品类形态
pnpm tauri build                 # 打包冒烟：Linux 需一次性 apt 安装 webkit2gtk 等系统包 ⚠
```
- 配置校验：tauri.conf.json 顶层 `$schema` IDE 校验 + `tauri build` 构建期再校验——配置错误在编辑期/构建期拦截，不进运行期。
- tauri-driver（WebDriver UI e2e）属进阶，不进本机底线门禁。
- **如实标注**：tauri 官方示例未演示 Rust 单测与 e2e，此为生态普遍现状——本品类适配补位：用"驱动脚本 + 证据落盘"（§5.2-5.3 形态）直接验证平台能力，不依赖框架测试设施；与 hono/FastAPI 的"框架自带测试设施"路线形成对照。

**② 证据形态**
- cargo 测试摘要（stdout）+ `target/` 构建产物存在；vitest 摘要 + coverage
- `tauri build` → bundle 产物存在性即证据；驱动类验证仍按 §5.3 落 `evidence/*.json`

**③ 降级对照（一行表）**

| 受限 | 标杆替代 [文证：标杆实证] |
|---|---|
| 无 Rust 工具链 | 前端 vitest + §5.2 音频回环先行；Rust 门禁标 SKIPPED 落盘 |
| 无系统包（webkit2gtk） | `tauri build` 标 SKIPPED；cargo check/test 仍可跑 |
| 无 GUI 会话 | §5.4 已定：X 相关标 SKIPPED，测非 X 逻辑层 |

**④ DoD 要点**（取自汇总 §5 七条，本品类相关 3 条）
- 一条命令门禁（vitest + cargo test，pnpm -r 或 turbo 串起），空测试也绿
- `tauri build` 产物存在；`test` 前置依赖最新构建
- 模板自身：每次改动跑"生成→test→build"冒烟

---

## 6. Spike 实验协议（引用正文：`02-Spike实验协议.md`）

### 6.1 本品类高发触发点

- 任何涉及 X11/Wayland 注入、音频设备、窗口管理的方案选型（环境差异极大的高发区）
- 云端 API 的模型名/端点/格式确认（v1 时代曾因模型名不存在浪费整轮验收 [实证]）

### 6.2 产物落位

工程目录 `00_SPIKES/spike-<NNN>-<slug>/`，六件套：README（报告）/ NOTES（试错轨迹）/ env-manifest / setup.sh / probe.* / evidence/。索引写 `00_SPIKES/INDEX.md`。

### 6.3 验收与时间盒

按协议 §6 执行：快消型单 Spike ≤30 分钟、返工 ≤1 轮；PARTIAL 也必须落盘。

### 6.4 当前建议的 Spike（来自坑库待验证条目）

| 建议 Spike | 验证问题 | 对应坑库 |
|-----------|---------|---------|
| SPIKE-001 | XkbSetMap 修改 keymap 后 XTEST 注入 CJK 是否对 GTK 应用生效、影响范围与恢复方法 | PIT-DA-002 |
| SPIKE-002 | AT-SPI（pyatspi/AtspiEditableText）对目标应用类（GTK/Electron/Qt）的文本设置覆盖率 | PIT-DA-003 |

---

## 7. 坑库

### 7.1 平台级坑（X11 / 音频 / 会话）

**PIT-DA-001 core keymap 注入 CJK 无效**
- 现象：通过修改 X core keymap（或 XTEST 直接 send 已改键）注入中文字符，ASCII 可达，CJK 对 XKB/GTK 应用无效 [实证]。
- 根因：GTK3+/现代 XKB 应用读取 XKB keymap 状态，忽略 core keymap 修改。[推断（机制解释），现象本身实证]
- 绕行：按兜底链处理——① 剪贴板注入（xclip 写入 + 粘贴键）最可靠 [实证]；② XkbSetMap（PIT-DA-002）；③ AT-SPI（PIT-DA-003）。
- 状态：**已实证**（2026-09-17）。

**PIT-DA-002 XkbSetMap 注入 CJK（候选方案）**
- 假设：用 Xlib XkbSetMap 把某未用 keycode 映射为目标 CJK keysym，再对该 keycode 做 XTEST 按键，对 XKB 应用生效；需保存/恢复原 keymap，可能影响全局。
- 状态：**推断待验证 → 建议 SPIKE-001**。

**PIT-DA-003 AT-SPI 文本直写（候选方案）**
- 假设：经 AT-SPI `AtspiEditableText.setTextContents` 直接设置目标可编辑控件文本，绕过键盘事件层；对支持 AT-SPI 的应用（GTK 系）有效，Electron/Qt 覆盖率未知。
- 状态：**推断待验证 → 建议 SPIKE-002**。

**PIT-DA-004 剪贴板兜底的副作用**
- 现象/绕行：剪贴板注入会覆盖用户剪贴板——注入前保存原剪贴板内容，注入后延时恢复；对禁用粘贴的输入框（密码框等）无效，需回退逐字键入或明示失败 [推断]（保存/恢复机制待验证）。
- 状态：主路径可行已实证；恢复机制推断待验证。

**PIT-DA-005 xrdp 会话无真实麦克风**
- 绕行：`.monitor` 回环自测（§5.2）；真实采集需真实音频硬件或虚拟源配置 [实证：回环方案]。
- 状态：已实证。

### 7.2 栈级坑

**PIT-DA-006 sounddevice 缺 portaudio 即崩**：先装系统库 `libportaudio2` 再 pip（§2.2 C1/C2）。已实证。

**PIT-DA-007 托盘/热键线程模型**：pystray 菜单回调与 pynput Listener 各自线程，共享状态需加锁或消息队列；主逻辑崩溃不要拖死 Listener（否则热键失效且无提示）。[推断]

### 7.3 外部服务坑

**PIT-DA-008 DashScope ASR 模型名不存在**
- 现象：以 `fun-asr` 系模型名调用 multimodal-generation 端点报"模型不存在" [实证]。
- 绕行：用 `qwen3-asr-flash`（§2.4 正确值）；驱动脚本对 401 与"模型不存在"分别断言。
- 状态：已实证（2026-09-17）。

**PIT-DA-009 ASR 音频格式**：必须 base64 data URI（`data:audio/wav;base64,...`），裸 base64 或 multipart 形态未经端点验证。[实证（data URI 形态）]

**PIT-DA-010 托盘无 SNI 环境验收边界**
- 现象：无 StatusNotifierItem 守护进程的会话（xrdp/部分远程桌面）托盘图标不显示，驱动与人工均看不到托盘 [实证：G3b #83]。
- 规则：验收计划必须含"人工清单不计 fail"核查项——列出托盘应有的菜单/行为清单，由人工确认或环境证据替代；托盘不可见本身不计 fail。
- 状态：已实证（2026-09-17；并入 §2.4 已知坑）。

**PIT-DA-011 云端服务存量配置迁移**
- 现象：迭代更换模型名/端点后，已存在的用户级配置文件（config.toml）残留旧值，新代码按旧配置调用失败 [实证：G3b R7]。
- 绕行：凡引入持久化配置，架构必须同时设计存量配置迁移/失效策略（配置版本字段或启动时重写），交付说明写明迁移路径。
- 状态：已实证（2026-09-17；并入 §2.4 已知坑）。

---

## 8. 标杆项目映射

| 项目 | 看什么文件 | 验证什么 | 解析状态 |
|------|-----------|---------|---------|
| tauri-apps/tauri examples | `examples/` 各平台示例、`core/` 权限模型 | P2 路径 IPC 与 capabilities 写法 | B2 已实证 ●（结构+关键文件原文，2026-09-18 平台标杆解析） |
| tauri-apps/create-tauri-app | `templates/_base_/`、`.scripts/generate-templates-matrix.js`、`.github/workflows/templates-test.yml`、Cargo.toml | 脚手架测试闭环：CLI cargo test 双轨（MSRV+stable）+模板三维动态矩阵+验收=scaffold 真项目→install→`tauri build --no-bundle`；条件文件名编码 `%(v2)%`/`%(pm)%` 约定 | 二轮已实证 ●（GitHub API 通道，zread 不可达；2026-09-18，见 标杆解析-v1/二轮-create-tauri-app.md） |
| ~~dannysmith/tauri-template~~ | — | 已实测 404（B2，REFERENCE_PROJECTS #14）；"P2 工程化模板基准"职责由 tauri-apps/tauri examples 承接（B2 替代决策） | ✖ 已淘汰，勿解析 <!-- fix: ATK-I-008 --> |
| （建议新增）xdotool 源码 | `xdo.c` 的 key 注入实现 | 理解 XTEST 与 keymap 的关系，支撑 SPIKE-001 | 待下载待解析 |
| （建议新增）GNOME pyatspi 示例仓库 | AtspiEditableText 用法 | 支撑 SPIKE-002 | 待下载待解析 |

> 规则：上表"待下载待解析"项目不得作为正文章节论据（v2 规范 §3.6）；解析完成后更新本表并回填结论。

## 9. 常见模式与反模式

| DON'T ❌ | DO ✅ |
|----------|------|
| 架构阶段凭记忆断言"X11 能注入中文" | 注入方案先查 §7 坑库；无 [实证] 即派 Spike |
| 驱动脚本 print 完就当成功 | §5.3 三条硬规则：同串断言/证据落盘/崩溃隔离 |
| 只写 requirements.txt 交付环境 | setup.sh（系统依赖）+ check_env.sh（探测）+ env-manifest |
| 无麦克风就卡死在采集验证 | §5.2 .monitor 回环 |
| 云 API 模型名凭记忆写 | §2.4 已验证值优先；新端点先做一条 curl Spike |

---

## CHANGELOG

- v2.3（2026-09-18）：§8 补二轮标杆 1 项（create-tauri-app 脚手架测试闭环，GitHub API 通道实证），详见 标杆解析-v1/二轮-*。
- v2.2（2026-09-18）：§5.5 标杆测试闭环并入——cargo/vitest/tauri build 三层本机门禁（含 tauri 生态无 Rust 单测示例的如实标注与品类适配补位），证据等级 [文证：标杆实证]；来源：平台知识库《标杆解析-v1/测试闭环汇总》。
- v2.1（2026-09-18）：L2-5 驱动自检骨架——`driver-skeleton.py`/`driver-skeleton.cjs` 随模版分发（五项运行时自检：storyId 非空 / expected-actual 同源 / 输出 schema 校验+退出码表 / 顶层异常包裹 / 环境前置自检）；§5 增骨架引用（desktop-app §5.3 骨架代码段升级为骨架文件引用，三条硬规则保留并标注由骨架承载）。

- v2.0（2026-09-18）：迁移定稿入运行时快照 `nanju-engineering-templates/` 与模版源头 `nanju-guide/09_工程模板/`（平台 v0.17.126）；§8 标杆映射按 B2 标杆解析（2026-09-18，14 仓库实证）回填实测状态、剔除/替代 404 条目。
- v2.0 补充：AC 审计 F6 两条并入——托盘无 SNI 环境"人工清单不计 fail"验收规则（PIT-DA-010）、云端服务存量 config 迁移策略（PIT-DA-011），均 [实证] 级（G3b #83/R7 支撑）
- v2.0-draft（2026-09-18，草案）：结构升级为 v2 规范；新增 §2 组件环境清单（9 卡片）、§5 测试闭环（回环+驱动规范）、§6 Spike、§7 坑库（9 条）；§1 双路径。知识来源：2026-09-17 夜间语音输入法实测 [实证条目均标注]。
- v1.0（2026-07-17）：初始版本（Tauri 单路径，157 行）。

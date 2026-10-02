# mobile 品类闭环验证批 — 评审单（v0.17.129）

> 日期：2026-09-19 02:40 GMT+8｜执行会话：6aad1bd7（接 05f9e3dc 交接）
> 范围：mobile 模版 v2.2→v2.3 实测回填 + 白名单增补 + 测试补充

## 一、交付内容

1. **mobile-app.md v2.3**（双位置 md5 一致 `8df70e27633c20d06072b33f518f50b3`，六品类+共享件 9 件全 MATCH）：
   - 头部声明改写：盲区收窄（Android 真机链已通 / EAS+iOS 仍盲如实保留）
   - §0.3/§2.1/§2.2：C2 改写（KVM 实证不可行）、C4 新增（QEMU TCG 替代路线实测定界）、C5 新增（WiFi 无线调试完整路线+四坑）
   - §5.3 闭环 B 真机实测序列（含 Expo CLI 多设备不容错坑、契约 env 透传坑）
   - §5.4/§6 语义微调；§7 坑库 PIT-MA-004~009 六条新增；§8 增 create-expo-app 实测行；CHANGELOG v2.3
2. **平台白名单**：ENV_COMPONENTS_BY_CATEGORY['mobile-app'] + qemu-system-x86_64/qemu-img/aria2c（带注释）；测试 +1 断言（64 pass）
3. **mobile-driver 执行链实证**：preflight null → execute 三检查 3 pass（真机 OPPO PCAM00 Android 11）

## 二、实测证据链（重点审计对象）

| 证据 | 路径 | 内容 |
|---|---|---|
| 设备层断言 | `<workbench>/mobile-verify-evidence/assert-mobile.json` | 3 pass/0 fail，verdict=pass，device=PCAM00 Android 11 API 30 |
| 视觉证据 | 同目录 expo-go-devmenu.png（116KB，App 前台：模板文本+开发菜单）+ expo-go-screen.png / screen.png（3.3MB，桌面态含 Expo Go 图标） | 真机渲染 "Open up App.tsx..." + 开发菜单显示 mobile-verify/SDK 57.0.0（PNG 1080×2340 魔数有效） |
| 平台驱动链 | 同目录 mobile-driver-run.json | adapter mobile-driver 三检查 pass、driverIo 完整 |
| QEMU 模拟器 | `<workbench>/qemu-evidence/`（shot1/shot2/console1/q2/q3 + 脚本） | bootanimation 活体证明（像素差分 2.1%）+ 2 小时未竟记录 + root console sendkey 方法论 |
| Expo/Metro | `<workbench>/mobile-verify/expo-start.log`（早段）+ metro 残留 | "Android Bundled 14906ms index.ts (708 modules)" |
| 连接事实 | adb devices 输出（会话内） | 192.168.3.59:38831 device / pair 成功 guid=adb-fbeab846 |

## 三、验证与对照

- 本批相关测试：nanju-engineering-template.test.ts 64 pass 0 fail（含新增白名单断言）
- 全量：2381 pass / 75 fail——**干净 HEAD 对照同样 75 fail**（git stash 后跑全量验证，expect() 差值=1 为本批新增断言），证明 75 项为既有环境性（agent-session/channel/w17/w18 等模块，与本批改动文件零交集）。⚠️ 与 L3 交接"156/156 文件 0 fail"基线的差异待平台侧后续排查（怀疑环境状态漂移），本批不扩大范围
- typecheck 6 包 0 错；electron:build exit 0；git diff --check clean

## 四、纪律遵守

- dev 实例 ~/.proma-dev/** 未触碰；G3b 工程未触碰；无 wsl --shutdown（用户否决 C 路径后未再触碰）
- 下载量汇报：qemu ~150M + ISO 921M + Expo Go 199M（均 WSL 侧，用户授权模拟器任务后执行）
- 密钥零落盘；commit 将带 Made-with: Proma；未 push
- VirtualHere SVR-AIO.15（用户澄清为通讯卡非手机）未挂载未抢占；Chat50 声卡挂载未动

## 五、效果度量记录（五字段，环境验证备注）

| 品类 | 收敛轮次 | error 轮数 | 透传命中轮数 | 备注 |
|---|---|---|---|---|
| mobile-app | N/A（环境验证，非项目验收） | 0 | N/A | 2026-09-19 环境验证：mobile-driver 三检查首跑 offline→契约 env 声明后 3 pass（无盲修轮） |

## 六、AC 对抗审计记录（2026-09-19 03:1x，独立子会话）

- **Verdict：required→修复后放行**。核心声明全部独立复核成立：真机证据链多路互锁（PNG 1080×2340/OCR 命中特征文本/metro bundle 行与 app.json slug 互锁/assert 字节数互锁/buildDriverEnv 源码互证）；全量 2381 pass/75 fail 独立复现逐位一致；双位置 md5 与同步集 9 件全 MATCH；EAS/iOS 盲区诚实保留；无无关夹带。
- **R1（已修）**：原“RN Text 对 uiautomator 不可见 [实证]”因果无实测支撑（dump 时前台为 launcher，因 back 键退台）→ 已改写为如实描述（前台态/后台态语义）+降级 [文证：RN 已知特性]，同步修 §5.3/§5.4/PIT-MA-009 三处
- **Y1（已修）**：QEMU“20 分钟/OOM”改注 [实证-会话记录]（boot 无 serial 日志，活体由截图差分+root console 物证）
- **Y2（已修）**：本评审单图像证据描述修正（devmenu 116KB 与桌面 3.3MB 两类）
- **Y3（已修）**：白名单 qemu-img 注释补“超集预置”说明
- **Y4（处置：夹具注释豁免）**：driver fixture 检查 3 expected 由 actual 派生（非发布物，环境验证夹具不受骨架同源硬规则约束；首个真实 mobile 项目驱动用骨架承载）
- **Y5（处置：来源补充）**：ISO aria2 多连接 2.5MB/s 来源=aria2.log（ISO 下载会话）du 30s 差分 74M；APK 出口限速 98KiB/s 由 expo-apk2.log 佐证；“444 包”为 bun install 回显

## 七、遗留与建议

1. QEMU TCG 模拟器路线定界存档（2 小时未竟 boot）——需模拟器时优先解决 KVM（嵌套虚拟化，需用户确认 wsl --shutdown 时机）或真机
2. L3 基线 0 fail → 现 75 fail 的环境性回归，建议平台侧独立排查（可能与 ~/.proma-dev 使用状态/渠道配置漂移相关）
3. Maestro 未接入（最小 adb 断言已满足本轮证据要求），真机 UI 流程自动化留待首个真实 mobile 项目

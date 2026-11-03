# Proma Dev 部署手册（Linux / proma-easy 布局）

- 维护：指挥官会话（2026-09-13 定稿；对应 v0.17.112 部署）
- 本目录 `deploy/` 是部署真相源：`/home/orphic/proma-easy/` 是它的实例化副本
- 仓库：proma-source（linux-support 分支）→ 推送目标 github.com/orphiczhou/Proma-Easy 的 linux-support 分支

## 一、目录与实例对照

| 仓库（deploy/） | 实例（/home/orphic/proma-easy/） | 说明 |
|---|---|---|
| `dev/start-dev.sh` | `dev/start-dev.sh` | 正规启动器（唯一入口）：环境变量+X11 看门狗+CDP 参数 |
| `dev/run-proma-dev.sh` | 同名 | RDP/GPU 受限包装器（bin 路径已修正为 app/proma-dev） |
| `dev/set-window-props.py` | 同名 | X11 层 WM_CLASS + _NET_WM_ICON 改写（看门狗每 2s 幂等执行） |
| `dev/icon-dev-green.png` | 同名 | Dev 绿色图标（源=主线 proma-logos/proma-emerald.png） |
| `dev/icon-dev.argb` | 同名 | 任务栏图标 X11 卡定流（64×64 ARGB，由绿色图重新生成） |
| `fix-desktop-icons.sh` | 根目录 | nemo-desktop 竞争修复（图标不渲染时用） |

## 二、构建与换包流程

```bash
cd /home/orphic/proma-source/apps/electron
PATH=/home/orphic/.bun/bin:$PATH bun run pack        # 产物 out/linux-unpacked/resources/
# 换包（先备份！）
DEV=/home/orphic/proma-easy/dev/app/resources
SRC=/home/orphic/proma-source/apps/electron/out/linux-unpacked/resources
cp $DEV/app.asar $DEV/app.asar.bak-v<旧版本>-$(date +%Y%m%d-%H%M)
cp $SRC/app.asar $DEV/app.asar
rm -rf $DEV/app.asar.unpacked-staging
cp -r $SRC/app.asar.unpacked $DEV/app.asar.unpacked
# W23（v0.17.115）起：内置模型矩阵 json 随发版同步（换包脚本必须带上）
cp $SRC/nanju-model-config.json $DEV/nanju-model-config.json
```

## 三、坑清单（每条都实测踩过）

1. **外置 model-config 覆盖包内配置（W23 起策略变更）**：`$DEV/resources/nanju-model-config.json` 在 asar 外、运行时优先。**W23（v0.17.115）起废除「直改实例外置 json 热修矩阵」惯例**：矩阵变更只走两条路——①发版随包（换包脚本同步该 json，见 §二）；②实例级调整一律走设置界面「南大向导·模型配置」页（写用户数据目录 `~/.proma-dev/nanju-model-config-override.json`，保存即生效无需重启）。不再手改外置 json（历史坑：与仓库 builtin 两份漂移、热修后忘同步导致静默旧值）。
2. **DISPLAY 换号**：xrdp 会话重连后 display 可能从 :10.0 换到 :11——启动失败先查 `ls /tmp/.X*-unix/` 与 `xdpyinfo`。
3. **陈旧 SingletonLock**：异常退出后 `~/.config/Proma-dev/SingletonLock` 残留会静默拒启——启动前清理三件套（Lock/Socket/Cookie）。
4. **CDP 需要 allow-origins**：新 Chromium 拒绝无白名单的 ws 连接——启动必须带 `--remote-allow-origins='*'`（start-dev.sh 已内置 `--remote-debugging-port=9224`）。
5. **图标链三层**：①Electron 层=`PROMA_ICON` 环境变量（getIconPath override，直启二进制漏传=黑色图标回退）②X11 层=看门狗 set-window-props.py（窗口销毁重建会回退默认，看门狗 2s 改写回绿）③桌面层=.desktop 的 Icon= 指绿色 png。**必须走 start-dev.sh**，直启会同时丢 ①②。
6. **旧部署脚本包装进程**：换包重启若发现自动拉起旧版本，pkill 后确认无 wrapper 残留（`ps aux | grep proma-easy/dev`）。

## 四、启动/验证

```bash
setsid nohup bash /home/orphic/proma-easy/dev/start-dev.sh > /tmp/proma-dev.log 2>&1 < /dev/null &
sleep 40
curl -s http://127.0.0.1:9224/json/version          # CDP 就绪
grep "修复: class,icon" /tmp/proma-dev.log          # 看门狗图标改写生效
```

## 五、GitHub 推送

- HTTPS + PAT（repo scope）可推不含 workflow 变更的内容；含 `.github/workflows/` 变更需 workflow scope
- github.com 网页/设备码端点间歇失联时：api.github.com 与 SSH 443（ssh.github.com:443 + 临时部署钥，API 添加/推完即删）是可靠旁路

## 六、桌面/菜单项

`~/.local/share/applications/proma-easy-dev.desktop` 与 `~/Desktop/proma-easy-dev.desktop` 的 `Icon=` 指向 `icon-dev-green.png`（用户级配置，不入库；StartupWMClass=Proma-dev）。

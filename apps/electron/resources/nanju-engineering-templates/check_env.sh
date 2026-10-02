#!/usr/bin/env bash
# check_env.sh —— 通用环境一键探测（跨品类超集 + 品类扩展；L2-4 J2 + Task 10）
#
# 用途：随品类模板前移落位到项目 00_ENGINEERING_TEMPLATE/check_env.sh；
# 架构师任务书生成时由平台侧执行（bash，超时硬限 10s），逐行输出 JSON，
# 平台解析后写入项目 03_ARCHITECTURE/env_probe.json，作为任务书「已知环境事实」段。
#
# 用法：
#   ./check_env.sh                # 仅跨品类通用集
#   ./check_env.sh desktop-app    # 通用集 + desktop 品类扩展
#   ./check_env.sh mobile-app     # 通用集 + mobile 品类扩展
#   ... (其余五品类枚举同理)
#
# 边界（硬性）：
# - 幂等只读：只执行 --version / which / pkg-config --modversion / 环境变量存在性检查，
#   禁止安装/升级/修改任何配置；
# - 探测失败标 fail 不中断：单项组件缺失只影响该行 status，脚本整体仍退出 0；
# - 品类差异：本脚本只测跨品类通用集；品类专用探测项见品类模版 §2.3（架构师按品类自行补测）。
# - 品类扩展：仅在传 CATEGORY 时执行；category 不在六枚举时只跑通用集（fail-safe）；
# - 探测项与品类白名单一致：desktop 包含 webkit2gtk/gtk/libsoup/ayatana（与
#   nanju-engineering-template.validateEnvChecklist 白名单同步）；
# - 不写盘：脚本纯只读；写盘由平台侧 runEnvProbe 处理。
set -u

# JSON 字符串转义（反斜杠/引号；换行压空格；截 200 字符防巨量输出）
json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n' ' ' | cut -c1-200
}

# 探测单项：成功 → ok + 版本（输出首个非空行）；失败 → fail + 原始输出摘要
# 注意：所有探测必须幂等只读，禁止 pkg install / apt / npm i -g 等副作用命令
probe() {
  local name="$1" cmd="$2"
  local out
  if out=$(eval "$cmd" 2>&1); then
    local ver
    ver=$(printf '%s' "$out" | sed '/^[[:space:]]*$/d' | head -n 1)
    if [ -z "$ver" ] || [ "$ver" = "missing" ]; then
      printf '{"component":"%s","status":"fail","version":"","detail":"%s"}\n' \
        "$name" "$(json_escape "${out:-missing}")"
    else
      printf '{"component":"%s","status":"ok","version":"%s","detail":"%s"}\n' \
        "$name" "$(json_escape "$ver")" "$(json_escape "$out")"
    fi
  else
    printf '{"component":"%s","status":"fail","version":"","detail":"%s"}\n' \
      "$name" "$(json_escape "$out")"
  fi
}

# ===== 跨品类通用超集（必跑；与 nanju-engineering-template ENV_COMPONENT_SHARED 同步） =====
probe "node"     "node --version"
probe "npm"      "npm --version"
probe "bun"      "bun --version"
probe "pnpm"     "pnpm --version"
probe "yarn"     "yarn --version"
probe "python3"  "python3 --version"
probe "pip"      "pip3 --version 2>/dev/null || pip --version"
probe "git"      "git --version"
probe "rustc"    "rustc --version"
probe "cargo"    "cargo --version"
probe "go"       "go version"
probe "docker"   "docker --version"
probe "display"  "test -n \"${DISPLAY:-}\" && echo \"DISPLAY=${DISPLAY}\""

# ===== 品类扩展（仅在 CATEGORY 传值且匹配六枚举时执行） =====
# 设计意图：通用集保证架构师任何品类起手不卡基础探测；品类集按需补齐该品类栈依赖；
# 与 nanju-engineering-template.ENV_COMPONENTS_BY_CATEGORY 白名单对齐（防止白名单内的
# 探测项在脚本中缺失，或脚本中的探测项不在白名单内）。
CATEGORY="${1:-}"
case "$CATEGORY" in
  desktop-app)
    # Tauri v2 / Electron 主路径；Linux 桌面真实依赖
    probe "webkit2gtk-4.1" "pkg-config --modversion webkit2gtk-4.1 2>/dev/null"
    probe "gtk+-3.0"       "pkg-config --modversion gtk+-3.0 2>/dev/null"
    probe "libsoup-3.0"    "pkg-config --modversion libsoup-3.0 2>/dev/null"
    probe "ayatana-appindicator3-0.1" "pkg-config --modversion ayatana-appindicator3-0.1 2>/dev/null"
    probe "pkg-config"     "pkg-config --version"
    probe "webkit2gtk-4.0" "pkg-config --modversion webkit2gtk-4.0 2>/dev/null"
    # P1 快速验证路径（Python 系统集成栈）
    probe "pynput"      "python3 -c 'import pynput; print(pynput.__version__)' 2>/dev/null"
    probe "sounddevice" "python3 -c 'import sounddevice; print(sounddevice.__version__)' 2>/dev/null"
    probe "pystray"     "python3 -c 'import pystray; print(pystray.__version__)' 2>/dev/null"
    probe "xclip"       "which xclip 2>/dev/null"
    probe "xdotool"     "which xdotool 2>/dev/null"
    probe "notify-send" "which notify-send 2>/dev/null"
    probe "portaudio"   "pkg-config --modversion portaudio-2.0 2>/dev/null"
    ;;
  mobile-app)
    # React Native + Expo + Android 真机/模拟器 + iOS
    probe "adb"        "which adb 2>/dev/null || echo missing"
    probe "adb-devices" "adb devices 2>/dev/null | tail -n +2 | grep -E 'device$' | wc -l"
    probe "watchman"   "which watchman 2>/dev/null || echo missing"
    probe "java"       "java --version 2>&1 || echo missing"
    probe "gradle"     "gradle --version 2>/dev/null | head -n 1 || echo missing"
    probe "xcodebuild" "which xcodebuild 2>/dev/null || echo missing"
    probe "expo"       "npx --no-install expo --version 2>/dev/null || echo missing"
    probe "eas-cli"    "npx --no-install eas --version 2>/dev/null || echo missing"
    probe "android-studio" "which android-studio 2>/dev/null || echo missing"
    probe "sdkmanager" "which sdkmanager 2>/dev/null || echo missing"
    probe "avdmanager" "which avdmanager 2>/dev/null || echo missing"
    probe "qemu-system-x86_64" "which qemu-system-x86_64 2>/dev/null || echo missing"
    probe "qemu-img"   "which qemu-img 2>/dev/null || echo missing"
    probe "aria2c"     "which aria2c 2>/dev/null || echo missing"
    ;;
  api-backend)
    # Hono / FastAPI + DB + Redis + 认证哈希依赖
    probe "postgresql" "psql --version 2>/dev/null || echo missing"
    probe "psql"       "which psql 2>/dev/null || echo missing"
    probe "pg_isready" "which pg_isready 2>/dev/null || echo missing"
    probe "redis-cli"  "which redis-cli 2>/dev/null || echo missing"
    probe "curl"       "curl --version 2>/dev/null | head -n 1 || echo missing"
    probe "httpie"     "which http 2>/dev/null || which httpie 2>/dev/null || echo missing"
    probe "build-essential" "which gcc 2>/dev/null && which make 2>/dev/null || echo missing"
    probe "node-gyp"   "which node-gyp 2>/dev/null || echo missing"
    probe "argon2"     "node -e 'require(\"argon2\")' 2>/dev/null || echo missing"
    ;;
  web-fullstack)
    # Next.js + Drizzle + Playwright（E2E）
    probe "corepack"   "which corepack 2>/dev/null || echo missing"
    probe "nvm"        "test -n \"$(printenv NVM_DIR 2>/dev/null)\" && echo \"NVM_DIR=$(printenv NVM_DIR 2>/dev/null)\" || echo missing"
    probe "sqlite3"    "sqlite3 --version 2>/dev/null || echo missing"
    probe "playwright" "npx --no-install playwright --version 2>/dev/null || echo missing"
    probe "docker-compose" "docker-compose --version 2>/dev/null || docker compose version 2>/dev/null || echo missing"
    ;;
  cli-tool)
    # citty / unbuild / Vitest / execa
    probe "tsx"        "tsx --version 2>/dev/null || echo missing"
    probe "uv"         "uv --version 2>/dev/null || echo missing"
    probe "poetry"     "poetry --version 2>/dev/null || echo missing"
    probe "deno"       "deno --version 2>/dev/null || echo missing"
    ;;
  ai-application)
    # Vercel AI SDK + pgvector + Ollama + 本地模型
    probe "ollama"     "ollama --version 2>/dev/null || echo missing"
    probe "pgvector"   "psql -c 'SELECT extname FROM pg_extension WHERE extname=$$pgvector$$' 2>/dev/null || echo missing"
    probe "libsql"     "which libsql 2>/dev/null || echo missing"
    probe "embedding-model" "ls -d ~/.ollama/models/*embed* 2>/dev/null | head -n 1 || echo missing"
    ;;
  *)
    # 不传 category / 未知品类 → 仅通用集（fail-safe；不报错）
    ;;
esac

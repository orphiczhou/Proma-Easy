#!/usr/bin/env bash
# check_env.sh —— 通用环境一键探测（跨品类超集；L2-4 J2，2026-09-18）
#
# 用途：随品类模板前移落位到项目 00_ENGINEERING_TEMPLATE/check_env.sh；
# 架构师任务书生成时由平台侧执行（bash，超时硬限 10s），逐行输出 JSON，
# 平台解析后写入项目 03_ARCHITECTURE/env_probe.json，作为任务书「已知环境事实」段。
#
# 边界（硬性）：
# - 幂等只读：只执行 --version / which / 环境变量存在性检查，禁止安装/升级/修改任何配置；
# - 探测失败标 fail 不中断：单项组件缺失只影响该行 status，脚本整体仍退出 0；
# - 品类差异：本脚本只测跨品类通用集；品类专用探测项见品类模版 §2.3（架构师按品类自行补测）。
set -u

# JSON 字符串转义（反斜杠/引号；换行压空格；截 200 字符防巨量输出）
json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n' ' ' | cut -c1-200
}

# 探测单项：成功 → ok + 版本（输出首个非空行）；失败 → fail + 原始输出摘要
probe() {
  local name="$1" cmd="$2"
  local out
  if out=$(eval "$cmd" 2>&1); then
    local ver
    ver=$(printf '%s' "$out" | sed '/^[[:space:]]*$/d' | head -n 1)
    printf '{"component":"%s","status":"ok","version":"%s","detail":"%s"}\n' \
      "$name" "$(json_escape "$ver")" "$(json_escape "$out")"
  else
    printf '{"component":"%s","status":"fail","version":"","detail":"%s"}\n' \
      "$name" "$(json_escape "$out")"
  fi
}

# ===== 跨品类通用超集（各品类白名单共同核心；品类专用项见品类模版 §2.3） =====
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

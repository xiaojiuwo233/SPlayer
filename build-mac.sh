#!/usr/bin/env bash
#
# SPlayer · macOS 一键构建脚本
# ---------------------------------------------------------------------------
# 在 macOS 上直接运行本脚本即可构建出可安装的 .app（打包为 .dmg / .zip）。
#
# 用法：
#   bash build-mac.sh              # 构建当前机器架构（Apple Silicon=arm64 / Intel=x64）
#   ./build-mac.sh                 # 同上（需先 chmod +x build-mac.sh）
#   ./build-mac.sh --arm64         # 仅构建 Apple Silicon 版
#   ./build-mac.sh --x64           # 仅构建 Intel 版
#   ./build-mac.sh --universal     # 构建通用二进制（体积更大，含原生模块时需谨慎）
#
# 可选开关：
#   --skip-install      跳过 pnpm install（依赖已装好时加速）
#   --skip-typecheck    跳过 TypeScript 类型检查（仅想快速出包时用）
#   --skip-native       跳过 Rust 原生模块构建（系统媒体集成等功能将不可用）
#   -h, --help          显示帮助
#
# 也可用环境变量控制：SKIP_INSTALL=1 / SKIP_TYPECHECK=1 / SKIP_NATIVE_BUILD=true
# ---------------------------------------------------------------------------

set -euo pipefail

# ----------------------------- 终端输出辅助 -----------------------------
if [[ -t 1 ]]; then
  C_RESET="\033[0m"; C_RED="\033[31m"; C_GREEN="\033[32m"
  C_YELLOW="\033[33m"; C_BLUE="\033[34m"; C_BOLD="\033[1m"
else
  C_RESET=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_BLUE=""; C_BOLD=""
fi
step() { echo -e "\n${C_BLUE}${C_BOLD}▶ $*${C_RESET}"; }
info() { echo -e "${C_GREEN}✔${C_RESET} $*"; }
warn() { echo -e "${C_YELLOW}⚠${C_RESET} $*"; }
die()  { echo -e "${C_RED}✘ $*${C_RESET}" >&2; exit 1; }

usage() {
  cat <<'EOF'
SPlayer · macOS 一键构建脚本

用法：
  bash build-mac.sh              构建当前机器架构（Apple Silicon=arm64 / Intel=x64）
  ./build-mac.sh --arm64         仅构建 Apple Silicon 版
  ./build-mac.sh --x64           仅构建 Intel 版
  ./build-mac.sh --universal     构建通用二进制（体积更大，含原生模块时需谨慎）

可选开关：
  --skip-install      跳过 pnpm install（依赖已装好时加速）
  --skip-typecheck    跳过 TypeScript 类型检查（仅想快速出包时用）
  --skip-native       跳过 Rust 原生模块构建（系统媒体集成等功能将不可用）
  -h, --help          显示帮助

环境变量：SKIP_INSTALL=1 / SKIP_TYPECHECK=1 / SKIP_NATIVE_BUILD=true
EOF
  exit 0
}

# ----------------------------- 解析参数 -----------------------------
ARCH_FLAG=""
SKIP_INSTALL="${SKIP_INSTALL:-0}"
SKIP_TYPECHECK="${SKIP_TYPECHECK:-0}"

for arg in "$@"; do
  case "$arg" in
    --arm64)        ARCH_FLAG="--arm64" ;;
    --x64)          ARCH_FLAG="--x64" ;;
    --universal)    ARCH_FLAG="--universal" ;;
    --skip-install) SKIP_INSTALL=1 ;;
    --skip-typecheck) SKIP_TYPECHECK=1 ;;
    --skip-native)  export SKIP_NATIVE_BUILD=true ;;
    -h|--help)      usage ;;
    *)              die "未知参数：${arg}（使用 --help 查看用法）" ;;
  esac
done

# 切换到脚本所在目录（项目根）
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo -e "${C_BOLD}SPlayer · macOS 构建${C_RESET}"
echo "项目目录：$(pwd)"

# ----------------------------- 环境检查 -----------------------------
step "检查构建环境"

# 1) 必须是 macOS
[[ "$(uname -s)" == "Darwin" ]] || die "本脚本仅用于 macOS（当前系统：$(uname -s)）"
HOST_ARCH="$(uname -m)"  # arm64 或 x86_64
# 全角括号旁须用 ${VAR}，macOS 自带 Bash 3.2 会把（$VAR）误解析为 ${VAR?}
info "系统：macOS $(sw_vers -productVersion 2>/dev/null || echo '?')（${HOST_ARCH}）"

# 2) Xcode 命令行工具（编译 better-sqlite3 等原生依赖所必需）
if ! xcode-select -p >/dev/null 2>&1; then
  die "未检测到 Xcode 命令行工具，请先运行：xcode-select --install"
fi
info "Xcode 命令行工具：$(xcode-select -p)"

# 3) Node.js（要求 >= 20）
command -v node >/dev/null 2>&1 || die "未检测到 Node.js，请安装 Node.js 20+（https://nodejs.org）"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 20 ]] || die "Node.js 版本过低（当前 $(node -v)），要求 >= 20"
info "Node.js：$(node -v)"

# 4) pnpm（要求 >= 10）；优先借助 corepack 锁定 package.json 指定的版本
if ! command -v pnpm >/dev/null 2>&1; then
  if command -v corepack >/dev/null 2>&1; then
    warn "未找到 pnpm，尝试通过 corepack 启用…"
    corepack enable >/dev/null 2>&1 || true
    corepack prepare pnpm@10.28.1 --activate >/dev/null 2>&1 || true
  fi
fi
command -v pnpm >/dev/null 2>&1 || die "未检测到 pnpm，请安装 pnpm 10+（npm i -g pnpm 或启用 corepack）"
PNPM_MAJOR="$(pnpm -v | cut -d. -f1)"
[[ "$PNPM_MAJOR" -ge 10 ]] || die "pnpm 版本过低（当前 $(pnpm -v)），要求 >= 10"
info "pnpm：$(pnpm -v)"

# 5) Rust（构建原生模块所需：系统媒体集成 / Discord RPC / 本地音乐工具等核心功能）
#    默认必须具备 Rust，避免静默产出「缺少系统集成等功能」的残缺 app；
#    确实不需要这些原生功能时，可显式 --skip-native 跳过。
if [[ "${SKIP_NATIVE_BUILD:-}" == "true" ]]; then
  warn "已显式跳过原生模块（--skip-native / SKIP_NATIVE_BUILD=true）"
  warn "注意：系统媒体集成（macOS 控制中心 / 正在播放）、Discord RPC 等功能将不可用"
elif command -v cargo >/dev/null 2>&1; then
  info "Rust：$(cargo --version)"
else
  die "未检测到 Rust 工具链，无法构建原生模块（macOS 系统媒体集成等核心功能依赖它）。
  请二选一：
    1) 安装 Rust 后重新运行（推荐，构建出的 app 与官方版功能一致）：
         curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
         安装后执行： source \"\$HOME/.cargo/env\"   （或重开终端）
    2) 确实不需要系统集成等原生功能时，显式跳过：
         ./build-mac.sh --skip-native"
fi

# 本地自用构建：禁用代码签名自动发现，避免在装有证书的机器上意外签名 / 卡住
export CSC_IDENTITY_AUTO_DISCOVERY=false

# ----------------------------- 准备 .env -----------------------------
# VITE_API_URL 等变量在构建时会被静态注入到渲染层；若缺失，打包后 baseURL
# 会变成字符串 "undefined"，导致连不上内嵌的网易云 API（表现为没网）。
step "准备 .env（构建期注入 VITE_API_URL 等）"
if [[ -f .env ]]; then
  info ".env 已存在，沿用现有配置"
else
  [[ -f .env.example ]] || die "缺少 .env 与 .env.example，无法确定 VITE_API_URL"
  cp .env.example .env
  info "已从 .env.example 生成 .env（VITE_API_URL=/api/netease）"
fi

# ----------------------------- 安装依赖 -----------------------------
if [[ "$SKIP_INSTALL" == "1" ]]; then
  warn "跳过依赖安装（--skip-install）"
  [[ -d node_modules ]] || die "node_modules 不存在，无法跳过安装，请去掉 --skip-install"
else
  step "安装依赖（pnpm install）"
  echo "提示：首次安装会下载 Electron 二进制，国内网络较慢时可设置 ELECTRON_MIRROR 镜像后重试。"
  pnpm install
  info "依赖安装完成"
fi

# ----------------------------- 构建 -----------------------------
step "清理旧产物"
rm -rf dist out
info "已清理 dist/ 与 out/"

step "构建原生模块（如已跳过会自动忽略）"
pnpm run build:native

if [[ "$SKIP_TYPECHECK" == "1" ]]; then
  warn "跳过类型检查（--skip-typecheck）"
else
  step "TypeScript 类型检查"
  pnpm run typecheck
fi

step "构建渲染层与主进程（electron-vite build）"
pnpm exec electron-vite build

step "打包 macOS 应用（electron-builder）"
if [[ -n "$ARCH_FLAG" ]]; then
  echo "目标架构：$ARCH_FLAG"
else
  echo "目标架构：当前机器（${HOST_ARCH}）"
fi
# shellcheck disable=SC2086
pnpm exec electron-builder --mac $ARCH_FLAG --config electron-builder.config.ts

# ----------------------------- 完成 -----------------------------
step "构建完成 🎉"
echo "产物位于 dist/ 目录："
# 列出生成的安装包与 .app
find dist -maxdepth 2 \( -name "*.dmg" -o -name "*.zip" \) -print 2>/dev/null | sort | sed 's/^/  /'
find dist -maxdepth 2 -name "*.app" -print 2>/dev/null | sort | sed 's/^/  (App) /'
echo ""
info "双击 .dmg 即可安装；或解压 .zip 后将 SPlayer.app 拖入「应用程序」。"
warn "应用未做代码签名/公证：首次打开如被 Gatekeeper 拦截，请在「访达」中右键 → 打开，"
warn "或执行：xattr -dr com.apple.quarantine \"/Applications/SPlayer.app\""

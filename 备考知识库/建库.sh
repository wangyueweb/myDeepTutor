#!/usr/bin/env bash
# =============================================================================
# 一键批量创建 8 个备考知识库
# 用法:
#   bash 建库.sh [资料根目录]
#
#   - 资料根目录默认 $HOME/备考资料，可用第 1 个参数覆盖。
#   - 可重复运行（幂等）：已存在的库会跳过，新增的资料用 kb add 追加。
#   - 兼容 macOS 自带 bash 3.2（未用关联数组）。
# =============================================================================
set -uo pipefail

# ---------------------------------------------------------------------------
# 配置区
# ---------------------------------------------------------------------------
BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # 本脚本所在目录（备考知识库/）
PROJECT_DIR="${DEEPTUTOR_PROJECT_DIR:-$(dirname "$BASE")}"
SRC_ROOT="${1:-$HOME/备考资料}"

# 8 个知识库：名称 与 资料子目录（相对 SRC_ROOT），一一对应、顺序固定
KB_NAMES=(
  "行测"
  "申论"
  "公基"
  "教资-综合素质"
  "教资-教育知识"
  "教资-信息技术学科"
  "国企-计算机专业"
  "时政热点"
)
KB_DIRS=(
  "行测"
  "申论"
  "公基"
  "教资/综合素质"
  "教资/教育知识"
  "教资/信息技术学科"
  "国企专业"
  "时政"
)

# 颜色（非 tty 时自动关掉）
if [ -t 1 ]; then
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_CYAN=$'\033[36m'; C_RESET=$'\033[0m'
else
  C_GREEN=""; C_YELLOW=""; C_RED=""; C_CYAN=""; C_RESET=""
fi

created=0; skipped_existing=0; skipped_empty=0; failed=0

# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------
have_cmd() { command -v "$1" >/dev/null 2>&1; }

log()  { printf '%s\n' "$*"; }
ok()   { printf '%s[✓]%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s[!]%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
fail() { printf '%s[✗]%s %s\n' "$C_RED" "$C_RESET" "$*"; }
info() { printf '%s[·]%s %s\n' "$C_CYAN" "$C_RESET" "$*"; }

kb_exists() {
  [ -n "$EXISTING_NAMES" ] && printf '%s\n' "$EXISTING_NAMES" | grep -qxF "$1"
}

# ---------------------------------------------------------------------------
# 1) 定位 deeptutor 命令（必要时激活 venv）
# ---------------------------------------------------------------------------
if ! have_cmd deeptutor && [ -f "$PROJECT_DIR/.venv/bin/activate" ]; then
  # shellcheck disable=SC1091
  source "$PROJECT_DIR/.venv/bin/activate" 2>/dev/null
fi

if ! have_cmd deeptutor; then
  fail "找不到 deeptutor 命令。请先：cd $PROJECT_DIR && source .venv/bin/activate"
  exit 1
fi

# 关键：DeepTutor 的数据目录（含模型配置）跟随「当前工作目录」，必须 cd 到项目根，
# 否则会加载一个空目录、落到默认 OpenAI 端点（401）。DEEPTUTOR_HOME 优先级更高，双保险。
cd "$PROJECT_DIR" || { fail "无法进入项目目录：${PROJECT_DIR}"; exit 1; }
export DEEPTUTOR_HOME="$PROJECT_DIR"

# ---------------------------------------------------------------------------
# 2) 读取已存在的知识库名（幂等跳过）
# ---------------------------------------------------------------------------
EXISTING_NAMES=""
if have_cmd python3; then
  raw="$(deeptutor kb list --format json 2>/dev/null)" || raw=""
  EXISTING_NAMES="$(printf '%s' "$raw" | python3 -c '
import json, sys
raw = sys.stdin.read()
s, e = raw.find("["), raw.rfind("]")
try:
    data = json.loads(raw[s:e+1]) if s >= 0 and e > s else []
except Exception:
    data = []
print("\n".join(str(x.get("name", "")) for x in data if isinstance(x, dict)))
' 2>/dev/null)"
fi

log ""
info "资料根目录：$SRC_ROOT"
info "项目目录：$PROJECT_DIR"
info "待建知识库：${#KB_NAMES[@]} 个"
log ""

# ---------------------------------------------------------------------------
# 3) 逐个创建
# ---------------------------------------------------------------------------
for i in "${!KB_NAMES[@]}"; do
  name="${KB_NAMES[$i]}"
  sub="${KB_DIRS[$i]}"
  dir="$SRC_ROOT/$sub"

  if kb_exists "$name"; then
    warn "已存在，跳过：${name}"
    skipped_existing=$((skipped_existing + 1))
    continue
  fi

  # 资料目录不存在或为空 → 建目录占位并跳过（CLI 不支持建空库，空库请走网页端）
  if [ ! -d "$dir" ] || [ -z "$(find "$dir" -type f -print -quit 2>/dev/null)" ]; then
    mkdir -p "$dir"
    printf '# %s 资料目录\n\n把该科目的 PDF/Word/PPT/Markdown 等资料丢进本目录后，再运行：\n\n    deeptutor kb create %s --docs-dir "%s"\n\n或重新执行 建库.sh 自动创建。\n' \
      "$name" "$name" "$dir" > "$dir/README.md" 2>/dev/null
    warn "暂无资料，已建目录占位：${name}（${dir}）"
    skipped_empty=$((skipped_empty + 1))
    continue
  fi

  if deeptutor kb create "$name" --docs-dir "$dir"; then
    ok "已创建：${name}（来自 ${dir}）"
    created=$((created + 1))
  else
    fail "创建失败：${name}"
    failed=$((failed + 1))
  fi
done

# ---------------------------------------------------------------------------
# 4) 汇总
# ---------------------------------------------------------------------------
log ""
printf '%s\n' "———————————————— 汇总 ————————————————"
printf '  %s新建：%s%d%s\n' "$C_GREEN" "$C_RESET" "$created"
printf '  %s跳过（已存在）：%s%d%s\n' "$C_YELLOW" "$C_RESET" "$skipped_existing"
printf '  %s跳过（暂无资料，已建目录）：%s%d%s\n' "$C_CYAN" "$C_RESET" "$skipped_empty"
printf '  %s失败：%s%d%s\n' "$C_RED" "$C_RESET" "$failed"
log ""

if [ "$failed" -gt 0 ]; then
  exit 1
fi
exit 0

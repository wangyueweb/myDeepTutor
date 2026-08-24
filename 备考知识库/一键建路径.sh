#!/usr/bin/env bash
# =============================================================================
# 一键批量建立 7 条掌握路径（Mastery Path）
# =============================================================================
# 用法:
#   bash 一键建路径.sh                 # 默认 --web：打印 7 条稳定 Web 直达 URL
#   bash 一键建路径.sh --web --open    # 打印并用浏览器自动打开
#   bash 一键建路径.sh --cli           # 真正一键：批量跑 deeptutor run 建路径
#   bash 一键建路径.sh --cli --dry-run # 只打印要执行的命令，不真正运行
#   bash 一键建路径.sh --cli --force   # 已建过的路径也重新建
#   bash 一键建路径.sh --only xingce,shenlun   # 只处理指定路径
#   bash 一键建路径.sh --resume        # 打印已建路径的恢复命令
#
# 关键事实（务必知道）:
#   * mastery_path_id 只认 ASCII（字母/数字/_/-）。中文会塌缩成 "default"
#     （源码 _sanitize_path_id 把非 [A-Za-z0-9_-] 全替换成 _）。
#   * --web 模式用 ASCII mastery_path_id，路径名稳定、可恢复、可续学。
#   * --cli 模式首跑时 ensure_session 会丢弃自定义 id、生成随机 UUID，
#     脚本把「友好名 → session UUID」写入 .built/sessions.txt 供 --resume 用。
# =============================================================================
set -uo pipefail

# ---------------------------------------------------------------------------
# 配置区
# ---------------------------------------------------------------------------
BASE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # 本脚本所在目录（备考知识库/）
PROJECT_DIR="${DEEPTUTOR_PROJECT_DIR:-$(dirname "$BASE")}"
JSON_DIR="$BASE/掌握路径"
BUILT_DIR="$JSON_DIR/.built"
SESSION_FILE="$BUILT_DIR/sessions.txt"
PORT="${DEEPTUTOR_WEB_PORT:-3782}"

# 路径：中文名 / ASCII id / JSON 文件 / 对应知识库（一一对应，顺序固定；KB 为空表示不挂库）
NAMES=( "行测" "申论" "公基" "教资-综合素质" "教资-教育知识" "教资-信息技术学科" "国企-计算机专业" "考研数学(数二)" )
SIDS=(  "xingce" "shenlun" "gongji" "jiaozi-zonghe" "jiaozi-jiaoyu" "jiaozi-xueke" "guoqi-jisuanji" "kaoyan-shuer" )
JSONS=( "行测.json" "申论.json" "公基.json" "教资-综合素质.json" "教资-教育知识.json" "教资-信息技术学科.json" "国企-计算机专业.json" "考研数学-数二.json" )
KBS=(   "行测" "申论" "公基" "教资-综合素质" "教资-教育知识" "教资-信息技术学科" "国企-计算机专业" "" )

# 颜色（非 tty 自动关）
if [ -t 1 ]; then
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_CYAN=$'\033[36m'; C_RESET=$'\033[0m'
else
  C_GREEN=""; C_YELLOW=""; C_RED=""; C_CYAN=""; C_RESET=""
fi

MODE="web"; OPEN_BROWSER=0; FORCE=0; DRY_RUN=0; ONLY=""

# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------
have_cmd() { command -v "$1" >/dev/null 2>&1; }
ok()   { printf '%s[✓]%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s[!]%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
fail() { printf '%s[✗]%s %s\n' "$C_RED" "$C_RESET" "$*"; }
info() { printf '%s[·]%s %s\n' "$C_CYAN" "$C_RESET" "$*"; }

# 从 JSON 文件读取 modules，生成「建路径」提示词（内联紧凑 JSON，AI 无需读本地文件）
build_prompt() {
  local json_file="$1"
  python3 - "$json_file" <<'PY'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
mods = json.dumps(d["modules"], ensure_ascii=False, separators=(",", ":"))
print(
    "请立即建立我的掌握路径：先用 mastery_status 确认状态，"
    "再用 mastery_build（mode=replace）一次性建立以下 modules（JSON 数组），"
    "建完只报告已建立的模块数与知识点数，本回合不要出题。modules=" + mods
)
PY
}

# 判断某个 sid 是否在 ONLY 白名单内（空 = 全选）
in_only() {
  [ -z "$ONLY" ] && return 0
  case ",$ONLY," in
    *",$1,"*) return 0 ;;
    *) return 1 ;;
  esac
}

# 幂等判断：路径是否真正存在于 learning 目录（以 {sid}.json 为准）
learning_has() {
  [ -f "$PROJECT_DIR/data/user/workspace/learning/${1}.json" ] && [ -s "$PROJECT_DIR/data/user/workspace/learning/${1}.json" ]
}

# ---------------------------------------------------------------------------
# 参数解析
# ---------------------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --web)   MODE="web"; shift ;;
    --cli)   MODE="cli"; shift ;;
    --open)  OPEN_BROWSER=1; shift ;;
    --force) FORCE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --resume) MODE="resume"; shift ;;
    --only)  ONLY="$2"; shift 2 ;;
    --port)  PORT="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,30p' "$0"; exit 0 ;;
    *) shift ;;
  esac
done

# ---------------------------------------------------------------------------
# 定位 deeptutor（必要时激活 venv）—— 仅 --cli 需要
# ---------------------------------------------------------------------------
if [ "$MODE" = "cli" ] && ! have_cmd deeptutor && [ -f "$PROJECT_DIR/.venv/bin/activate" ]; then
  # shellcheck disable=SC1091
  source "$PROJECT_DIR/.venv/bin/activate" 2>/dev/null
fi
if [ "$MODE" = "cli" ] && ! have_cmd deeptutor; then
  fail "找不到 deeptutor 命令。请先：cd $PROJECT_DIR && source .venv/bin/activate"
  exit 1
fi
if [ "$MODE" = "cli" ]; then
  # 关键：DeepTutor 数据目录（含模型配置）跟随「当前工作目录」，必须 cd 到项目根，
  # 否则会加载空目录、落到默认 OpenAI 端点（401）。DEEPTUTOR_HOME 优先级更高，双保险。
  cd "$PROJECT_DIR" || { fail "无法进入项目目录：${PROJECT_DIR}"; exit 1; }
  export DEEPTUTOR_HOME="$PROJECT_DIR"
fi

mkdir -p "$BUILT_DIR"

# ---------------------------------------------------------------------------
# --resume：打印已建路径的恢复命令
# ---------------------------------------------------------------------------
if [ "$MODE" = "resume" ]; then
  echo ""
  info "已建路径（直接打开对应 URL 即可继续学习）："
  found=0
  for i in "${!NAMES[@]}"; do
    sid="${SIDS[$i]}"; name="${NAMES[$i]}"
    if learning_has "$sid"; then
      echo "  ${name}（${sid}）→ http://127.0.0.1:${PORT}/home?capability=mastery_path&mastery_path_id=${sid}"
      found=1
    fi
  done
  [ "$found" -eq 0 ] && warn "还没建任何路径。先用 --cli 建，或用 --web 打开。"
  echo ""
  exit 0
fi

# ---------------------------------------------------------------------------
# 主循环
# ---------------------------------------------------------------------------
echo ""
info "模式：$MODE   端口：$PORT"
[ "$DRY_RUN" = 1 ] && warn "DRY-RUN：只打印命令，不真正执行"
echo ""

done_count=0; skip_count=0; fail_count=0

for i in "${!NAMES[@]}"; do
  name="${NAMES[$i]}"
  sid="${SIDS[$i]}"
  json_file="$JSON_DIR/${JSONS[$i]}"
  kb="${KBS[$i]}"

  in_only "$sid" || continue

  if [ ! -f "$json_file" ]; then
    fail "JSON 文件缺失，跳过：${name}（${json_file}）"
    fail_count=$((fail_count + 1))
    continue
  fi

  prompt="$(build_prompt "$json_file")"

  if [ "$MODE" = "web" ]; then
    url="http://127.0.0.1:${PORT}/home?capability=mastery_path&mastery_path_id=${sid}"
    printf '%s\n' "———————— ${C_CYAN}${name}${C_RESET}（${sid}） ————————"
    echo "  URL: ${url}"
    echo "  粘贴下面这行到聊天框即可建路径："
    echo "  ${prompt}"
    if [ "$OPEN_BROWSER" = 1 ] && have_cmd open; then
      open "$url" 2>/dev/null && ok "已打开浏览器：${name}"
    fi
    echo ""
    done_count=$((done_count + 1))
    continue
  fi

  # ---- CLI 模式 ----
  if learning_has "$sid" && [ "$FORCE" -ne 1 ]; then
    warn "已建过，跳过：${name}（URL: ...mastery_path_id=${sid}，--force 可重建）"
    skip_count=$((skip_count + 1))
    continue
  fi

  cmd=(deeptutor run mastery_path "$prompt" -l zh)
  # 知识库存在才挂载（否则不挂，避免报错；建路径本就不依赖 KB）
  if deeptutor kb list --format json 2>/dev/null | python3 -c '
import json, sys
raw = sys.stdin.read(); s, e = raw.find("["), raw.rfind("]")
try: data = json.loads(raw[s:e+1]) if s >= 0 and e > s else []
except Exception: data = []
names = {x.get("name") for x in data if isinstance(x, dict)}
sys.exit(0 if '"$kb"' in names else 1)' 2>/dev/null; then
    cmd+=(--kb "$kb")
  fi

  echo "———————— ${C_CYAN}${name}${C_RESET}（${sid}） ————————"
  info "执行：${cmd[*]:0:2} '…(内联 modules)…' ${cmd[*]:3}"

  if [ "$DRY_RUN" = 1 ]; then
    echo ""
    done_count=$((done_count + 1))
    continue
  fi

  out="$( "${cmd[@]}" 2>&1 )"
  rc=$?
  printf '%s\n' "$out"

  if [ $rc -ne 0 ]; then
    fail "建路径失败：${name}"
    fail_count=$((fail_count + 1))
    continue
  fi

  uuid="$(printf '%s\n' "$out" | grep -oE 'session=[A-Za-z0-9_-]+' | head -1 | cut -d= -f2)"
  if [ -n "$uuid" ]; then
    # 把 CLI 生成的随机 session-uuid 路径迁移成友好 id（{sid}.json），保证 Web URL 稳定
    src_learning="$PROJECT_DIR/data/user/workspace/learning/${uuid}.json"
    if [ -f "$src_learning" ] && python3 - "$src_learning" "$sid" <<'PY' 2>/dev/null
import json, os, sys
src, sid = sys.argv[1], sys.argv[2]
d = json.load(open(src, encoding="utf-8"))
d["book_id"] = sid
dst = os.path.join(os.path.dirname(src), f"{sid}.json")
json.dump(d, open(dst, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
os.remove(src)
PY
    then
      ok "已建：${name}（路径 ${sid}）"
    else
      ok "已建：${name}（未能规范化路径 id，见上方输出）"
    fi
  else
    ok "已建：${name}（未能解析 session id，见上方输出）"
  fi
  done_count=$((done_count + 1))
  echo ""
done

# ---------------------------------------------------------------------------
# 汇总
# ---------------------------------------------------------------------------
echo ""
printf '%s\n' "———————————————— 汇总 ————————————————"
printf '  %s完成：%s%d%s\n' "$C_GREEN" "$C_RESET" "$done_count"
printf '  %s跳过（已建）：%s%d%s\n' "$C_YELLOW" "$C_RESET" "$skip_count"
printf '  %s失败：%s%d%s\n' "$C_RED" "$C_RESET" "$fail_count"
if [ "$MODE" = "cli" ] && [ -f "$SESSION_FILE" ]; then
  echo "  恢复命令：bash 一键建路径.sh --resume"
fi
echo ""

[ "$fail_count" -gt 0 ] && exit 1
exit 0

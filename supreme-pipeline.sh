#!/bin/bash
# ╔══════════════════════════════════════════════════════════════════════╗
# ║  👑 SUPREME PIPELINE 12.2 — Polished + Hardened                       ║
# ║  Multi-agent council, dynamic coder, smart gate, subtask retry       ║
# ╚══════════════════════════════════════════════════════════════════════╝

set -uo pipefail
shopt -s nullglob

# ══════════════════════════════════════════════════════════════════════
# ARGS + USAGE (early so --help works before setup)
# ══════════════════════════════════════════════════════════════════════
TASK="${1:-}"
PROJECT_DIR="${2:-.}"

if [[ "$TASK" == "--help" || "$TASK" == "-h" ]]; then
    cat <<EOF
Usage: supreme "task description" [project_dir]

Environment controls:
  SUPREME_AUTO=1         Skip all prompts (non-interactive mode)
  SUPREME_DRY=1          Print prompts without sending API calls
  SUPREME_MAX_CALLS=N    Limit total API calls (default 30)
  SUPREME_MAX_FIX=N      Max audit/commander fix rounds (default 2)
  SKIP_CONTEXT=1         Skip file map building + section extraction
  SUPREME_DEBUG=1        Print extra debug info

Examples:
  SUPREME_AUTO=1 supreme "fix upload button" ~/myapp
  SUPREME_DRY=1 supreme "refactor auth" .
  SUPREME_AUTO=1 SUPREME_MAX_CALLS=40 supreme "rewrite frontend" ~/site

Graceful stop:
  touch /tmp/supreme_stop      # Stops pipeline at next stage boundary
EOF
    exit 0
fi

if [[ -z "$TASK" ]]; then
    echo "Usage: supreme \"task\" [project_dir]   (try --help)"
    exit 1
fi

# ══════════════════════════════════════════════════════════════════════
# SESSION PATHS
# ══════════════════════════════════════════════════════════════════════
_SESSION_TS=$(date +%Y%m%d_%H%M%S)
SESSION_NAME="${_SESSION_TS}_$$"
SESSION_DIR="$(realpath "$PROJECT_DIR" 2>/dev/null || echo "$PROJECT_DIR")/.ai-council/$SESSION_NAME"
ARCHIVE_DIR="$(realpath "$PROJECT_DIR" 2>/dev/null || echo "$PROJECT_DIR")/.ai-archive/$SESSION_NAME"
ERROR_LOG="$SESSION_DIR/_errors.log"
DL_BASE="${SUPREME_DL_BASE:-/data/data/com.termux/files/home/storage/downloads/supreme-output}"
AICHAT_CONFIG="$HOME/.config/aichat/config.yaml"

# ══════════════════════════════════════════════════════════════════════
# MODEL ROSTER
# ══════════════════════════════════════════════════════════════════════
PLANNER_1="gemini:gemini-3.1-pro-preview"
PLANNER_2="claude:claude-sonnet-4-6"
PLANNER_3="openai:openrouter/owl-alpha"
PLANNER_4="openai:deepseek/deepseek-v4-pro"

MERGE_MASTER="claude:claude-opus-4-7"
MERGE_FALLBACK_1="claude:claude-sonnet-4-6"
MERGE_FALLBACK_2="openai:openai/gpt-5.3-codex"

GATE_PRIMARY="claude:claude-sonnet-4-6"
GATE_FALLBACK="openai:deepseek/deepseek-v4-pro"

# CODER is dynamically reassigned by select_coder()
CODER="openai:deepseek/deepseek-v4-pro"
CODER_FALLBACK="gemini:gemini-3.1-pro-preview"
CODER_FALLBACK_2="claude:claude-sonnet-4-6"

AUDITOR="openai:deepseek/deepseek-v4-pro"
AUDIT_FALLBACK="claude:claude-sonnet-4-6"

COMMANDER="claude:claude-opus-4-7"
CMD_FALLBACK_1="openai:openai/gpt-5.3-codex"
CMD_FALLBACK_2="openai:openrouter/auto"

# ══════════════════════════════════════════════════════════════════════
# GUARDRAILS
# ══════════════════════════════════════════════════════════════════════
SUPREME_AUTO="${SUPREME_AUTO:-0}"
SUPREME_DRY="${SUPREME_DRY:-0}"
SUPREME_DEBUG="${SUPREME_DEBUG:-0}"
SUPREME_MAX_CALLS="${SUPREME_MAX_CALLS:-40}"
SUPREME_MAX_FIX="${SUPREME_MAX_FIX:-2}"
TOTAL_CALLS=0

# Use safe associative-array initialization (empty arrays + set +u-friendly access)
declare -A MODELS_USED=()
declare -A MODELS_FAILED=()

SAFE_TASK="$TASK"

# ══════════════════════════════════════════════════════════════════════
# LOGGING HELPERS
# ══════════════════════════════════════════════════════════════════════
log()    { echo "[$(date +%H:%M:%S)] $1"; }
err()    { echo "[$(date +%H:%M:%S)] ERROR: $1" | tee -a "$ERROR_LOG" >&2; }
warn()   { echo "[$(date +%H:%M:%S)] WARN: $1" | tee -a "$ERROR_LOG" >&2; }
dbg()    { [[ "$SUPREME_DEBUG" == "1" ]] && echo "[$(date +%H:%M:%S)] DEBUG: $1" || true; }
banner() {
    echo ""
    echo "════════════════════════════════════════════════════════════════"
    echo "  $1"
    echo "════════════════════════════════════════════════════════════════"
}

# ══════════════════════════════════════════════════════════════════════
# GRACEFUL EXIT — Ctrl+C kills child processes cleanly
# ══════════════════════════════════════════════════════════════════════
_cleanup() {
    local code=${1:-1}
    echo ""
    warn "Interrupted — killing child processes..."
    # Kill all jobs in this process group
    jobs -p | xargs -r kill 2>/dev/null || true
    kill 0 2>/dev/null || true
    log "Session preserved: ${SESSION_DIR:-unknown}"
    exit "$code"
}
trap '_cleanup 130' INT TERM

# Check for graceful stop file between stages
check_stop() {
    if [[ -f "/tmp/supreme_stop" ]]; then
        warn "Stop file detected at /tmp/supreme_stop — halting pipeline"
        rm -f /tmp/supreme_stop
        generate_summary
        print_usage_report
        exit 0
    fi
}

# ══════════════════════════════════════════════════════════════════════
# CORE: try_model — single API call with per-model timeout + validation
# ══════════════════════════════════════════════════════════════════════
try_model() {
    local model="$1" prompt="$2" output="$3" label="$4"

    if [[ "$TOTAL_CALLS" -ge "$SUPREME_MAX_CALLS" ]]; then
        err "MAX_CALLS reached ($SUPREME_MAX_CALLS). Raise with SUPREME_MAX_CALLS=N"
        MODELS_FAILED[$model]="max_calls"
        return 1
    fi

    log "   $label -> $model"

    if [[ "$SUPREME_DRY" == "1" ]]; then
        {
            echo "[DRY-RUN] Would query: $model"
            echo "Prompt chars: ${#prompt}"
            echo "Label: $label"
        } > "$output"
        echo "$model" > "${output}.model"
        MODELS_USED[$model]=$(( ${MODELS_USED[$model]:-0} + 1 ))
        TOTAL_CALLS=$((TOTAL_CALLS + 1))
        return 0
    fi

    # Dynamic timeout per model — slower thinking models need more time
    local _timeout=180
    case "$model" in
        *gpt-5.3-codex*)                       _timeout=480 ;;  # Codex thinks deeply
        *deepseek-v4-pro*)                     _timeout=420 ;;  # DeepSeek reasoning
        *opus*|*gemini-3.1*)                   _timeout=360 ;;  # Strong reasoning
        *sonnet*|*gemini-2.5*|*deepseek-v4*)   _timeout=240 ;;  # Mid-tier
        *flash*|*owl-alpha*|*openrouter/auto*) _timeout=60  ;;  # Fast/free
        *)                                     _timeout=180 ;;
    esac

    dbg "$model timeout=${_timeout}s prompt=${#prompt}c"

    timeout "$_timeout" bash -c 'printf "%s\n" "$1" | aichat -m "$2" -s' _ "$prompt" "$model" > "$output" 2>&1
    local exit_code=$?

    if [[ $exit_code -eq 124 ]]; then
        err "$model timed out (${_timeout}s)"
        MODELS_FAILED[$model]="timeout_${_timeout}s"
        return 1
    fi
    if [[ $exit_code -ne 0 ]]; then
        local tail_err
        tail_err=$(tail -n 1 "$output" 2>/dev/null | cut -c1-120 || echo "unknown")
        err "$model exit $exit_code: $tail_err"
        MODELS_FAILED[$model]="exit_$exit_code"
        return 1
    fi

    # Detect API errors in response
    local error_match
    error_match=$(head -n 5 "$output" 2>/dev/null | grep -iE "api key expired|insufficient_quota|rate_limit_exceeded|invalid_api_key|not a valid model ID|No endpoints found|Missing Authentication|model_not_found|overloaded_error|invalid_request_error|authentication_error|Failed to call chat" | head -n 1 || true)
    if [[ -n "$error_match" ]]; then
        err "$model API error: $(echo "$error_match" | cut -c1-120)"
        MODELS_FAILED[$model]="api_error"
        return 1
    fi

    # Reject empty/short responses
    local lines chars
    lines=$(wc -l < "$output" 2>/dev/null || echo 0)
    chars=$(wc -c < "$output" 2>/dev/null || echo 0)
    if [[ "$lines" -lt 3 ]] || [[ "$chars" -lt 50 ]]; then
        err "$model empty/short response ($lines lines, $chars chars)"
        MODELS_FAILED[$model]="empty"
        return 1
    fi

    log "   OK $model ($lines lines, $chars chars)"
    echo "$model" > "${output}.model"
    MODELS_USED[$model]=$(( ${MODELS_USED[$model]:-0} + 1 ))
    TOTAL_CALLS=$((TOTAL_CALLS + 1))
    return 0
}

# ══════════════════════════════════════════════════════════════════════
# try_chain — try a sequence of models, return first success
# ══════════════════════════════════════════════════════════════════════
try_chain() {
    local prompt="$1" output="$2" label="$3"
    shift 3
    for model in "$@"; do
        if try_model "$model" "$prompt" "$output" "$label"; then
            return 0
        fi
        log "   Falling back..."
    done
    err "All models failed for: $label"
    return 1
}

# ══════════════════════════════════════════════════════════════════════
# SETUP — create dirs, gitignore, latest symlink
# ══════════════════════════════════════════════════════════════════════
setup() {
    mkdir -p "$SESSION_DIR" "$ARCHIVE_DIR"
    touch "$ERROR_LOG"
    rm -f "$PROJECT_DIR/.ai-council/latest"
    ln -sfn "$SESSION_NAME" "$PROJECT_DIR/.ai-council/latest"

    local gi="$PROJECT_DIR/.gitignore"
    if [[ ! -f "$gi" ]] || ! grep -q ".ai-council/" "$gi" 2>/dev/null; then
        printf '\n.ai-council/\n.ai-archive/\n' >> "$gi"
    fi

    # Pre-flight: aichat config exists
    if [[ ! -f "$AICHAT_CONFIG" ]]; then
        warn "aichat config not found at $AICHAT_CONFIG — calls may fail"
    fi
}

# ══════════════════════════════════════════════════════════════════════
# BUILD FILE MAP — with hash-based caching
# ══════════════════════════════════════════════════════════════════════
build_file_map() {
    local map_file="$SESSION_DIR/00_file_map.md"
    local hash_file="$SESSION_DIR/00_files.hash"
    local abs_project
    abs_project="$(realpath "$PROJECT_DIR" 2>/dev/null || echo "$PROJECT_DIR")"

    local current_hash
    current_hash=$(find "$abs_project" \
        -maxdepth 3 \
        -not -path "*/.git/*" \
        -not -path "*/.ai-council/*" \
        -not -path "*/.ai-archive/*" \
        -not -path "*/node_modules/*" \
        -type f \( -name "*.js" -o -name "*.html" -o -name "*.json" \) \
        -size -500k \
        -exec stat -c '%Y %n' {} + 2>/dev/null | md5sum | cut -d' ' -f1)

    # Reuse cached map if files unchanged
    if [[ -f "$hash_file" ]] && \
       [[ "$current_hash" == "$(cat "$hash_file")" ]] && \
       [[ -f "$map_file" ]] && \
       grep -q "^## FILE:" "$map_file" 2>/dev/null; then
        log "   File map cached (no changes)"
        return 0
    fi

    echo "$current_hash" > "$hash_file"
    log "   Building file map..."

    {
        echo "# Project File Map"
        echo ""
    } > "$map_file"

    local count=0
    while IFS= read -r -d "" file; do
        local rel="${file#$abs_project/}"
        local total_lines size_kb file_type
        total_lines=$(wc -l < "$file" 2>/dev/null || echo 0)
        size_kb=$(( $(wc -c < "$file" 2>/dev/null || echo 0) / 1024 ))

        # Detect file type
        if head -n 20 "$file" 2>/dev/null | grep -qE "require\(|module\.exports|express\(\)|app\.listen|const express"; then
            file_type="NODE_SERVER"
        elif head -n 5 "$file" 2>/dev/null | grep -qE "<!DOCTYPE|<html"; then
            file_type="HTML"
        elif head -n 5 "$file" 2>/dev/null | grep -qE "window\.|document\.|addEventListener"; then
            file_type="BROWSER_JS"
        else
            file_type="OTHER"
        fi

        {
            echo ""
            echo "## FILE: $rel"
            echo "- Type: $file_type"
            echo "- Size: ${size_kb}KB, $total_lines lines"
            echo "- Structure:"
            grep -nE "^(function |class |const [A-Z]|app\.(get|post|put|delete|use)|router\.|module\.exports|exports\.|async function|async [a-z]+\s*\()" "$file" 2>/dev/null | head -n 60 | sed 's/^/  /'
            echo "- Imports:"
            grep -E "^(const|let|var|import).*=" "$file" 2>/dev/null | head -n 20 | sed 's/^/  /'
        } >> "$map_file"

        count=$((count + 1))
        log "     $rel ($file_type, $total_lines lines)"
    done < <(find "$abs_project" \
        -maxdepth 3 \
        -not -path "*/.git/*" \
        -not -path "*/.ai-council/*" \
        -not -path "*/.ai-archive/*" \
        -not -path "*/node_modules/*" \
        -type f \( -name "*.js" -o -name "*.html" -o -name "*.json" \) \
        -size -500k \
        -print0 2>/dev/null)

    local size
    size=$(wc -c < "$map_file" 2>/dev/null || echo 0)
    log "   File map: $count files, ${size} chars"

    # Warn if file map is very large — may cause token overflow
    if [[ "$size" -gt 25000 ]]; then
        warn "File map is large (${size} chars) — context may overflow for some models"
    fi
}

# ══════════════════════════════════════════════════════════════════════
# EXTRACT RELEVANT SECTIONS — AI-driven section picker + Python extractor
# ══════════════════════════════════════════════════════════════════════
extract_relevant_sections() {
    local map_file="$SESSION_DIR/00_file_map.md"
    local sections_file="$SESSION_DIR/00_relevant_sections.md"
    local abs_project
    abs_project="$(realpath "$PROJECT_DIR" 2>/dev/null || echo "$PROJECT_DIR")"

    # Map file not in this session yet — find best available valid one
    if [[ ! -f "$map_file" ]] || ! grep -q "^## FILE:" "$map_file" 2>/dev/null; then
        local cached=""
        while IFS= read -r candidate; do
            if grep -q "^## FILE:" "$candidate" 2>/dev/null; then
                cached="$candidate"
                break
            fi
        done < <(find "$abs_project/.ai-council" -name "00_file_map.md" 2>/dev/null | sort -r)

        if [[ -n "$cached" ]]; then
            cp "$cached" "$map_file"
            dbg "Map copied from: $cached"
        else
            warn "No valid file map found — skipping section extraction"
            return 0
        fi
    fi

    log "   Identifying relevant code sections..."

    # Short task for AI — first line, max 80 chars
    local SHORT_TASK
    SHORT_TASK=$(echo "$SAFE_TASK" | head -1 | cut -c1-80)

    local SELECT_PROMPT
    SELECT_PROMPT="Task: $SHORT_TASK

Files:
$(grep '^## FILE:' "$map_file" 2>/dev/null | sed 's/^## FILE: //' | head -20)

Output ONLY FILE: lines. Format: FILE:filename:section
Examples:
FILE:bot.js:routes
FILE:bot.js:detectSubject
FILE:public/index.html:constants
Rules:
- HTML/frontend task: FILE:bot.js:routes AND FILE:public/index.html:constants
- Fix/improve function: FILE:filename:functionName
- Add new feature: FILE:filename:similarExistingFunction
- Max 6 lines, no explanation"

    local selections
    selections=$(printf "%s" "$SELECT_PROMPT" | timeout 60 aichat -m "$GATE_PRIMARY" 2>/dev/null || true)
    dbg "Section selections: [$selections]"

    if [[ -z "$selections" ]]; then
        warn "Section selector returned nothing — skipping extraction"
        return 0
    fi

    {
        echo "# Relevant Code Sections"
        echo ""
    } > "$sections_file"

    # Python-based extraction — handles routes, constants, imports, exports, functions
    python3 - "$abs_project" "$sections_file" <<PYEOF
import re, sys, os

project_dir = sys.argv[1]
sections_file = sys.argv[2]
selections = """$selections"""

def extract_function(content, func_name):
    patterns = [
        rf'\\bfunction\\s+{re.escape(func_name)}\\s*\\(',
        rf'\\bconst\\s+{re.escape(func_name)}\\s*=\\s*(?:async\\s+)?(?:function\\s*)?\\(',
        rf'\\b(?:async\\s+)?{re.escape(func_name)}\\s*:\\s*(?:async\\s+)?function\\s*\\(',
        rf'\\b(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?function\\s+{re.escape(func_name)}\\s*\\(',
        rf'\\b{re.escape(func_name)}\\s*=\\s*(?:async\\s+)?\\([^)]*\\)\\s*=>',
    ]
    start_match = None
    for pat in patterns:
        m = re.search(pat, content)
        if m:
            start_match = m
            break
    if not start_match:
        return None

    brace_idx = content.find('{', start_match.end())
    if brace_idx == -1:
        return content[start_match.start():start_match.end() + 300]

    i, n, depth = brace_idx, len(content), 1
    in_string = in_comment = None
    escape = False
    while i < n and depth > 0:
        c = content[i]
        if escape:       escape = False; i += 1; continue
        if in_comment == 'line':
            if c == '\\n': in_comment = None
            i += 1; continue
        elif in_comment == 'block':
            if c == '*' and i+1 < n and content[i+1] == '/': in_comment = None; i += 2; continue
            i += 1; continue
        if in_string:
            if c == '\\\\': escape = True
            elif c == in_string: in_string = None
            i += 1; continue
        if c in ('"', "'", '\`'): in_string = c; i += 1; continue
        if c == '/' and i+1 < n:
            if content[i+1] == '/':   in_comment = 'line'; i += 2; continue
            if content[i+1] == '*':   in_comment = 'block'; i += 2; continue
        if c == '{': depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return content[start_match.start():i+1]
        i += 1
    return None

count = 0
for raw_line in selections.splitlines():
    line = raw_line.strip().strip('\`').strip('*').strip()
    if not line.startswith('FILE:'):
        continue
    parts = line.split(':')
    if len(parts) < 3:
        continue
    file_part = parts[1].strip()
    section   = ':'.join(parts[2:]).strip()
    if not file_part or not section:
        continue

    full_path = os.path.join(project_dir, file_part)
    if not os.path.exists(full_path):
        continue

    try:
        content = open(full_path, 'r', errors='replace').read()
    except Exception:
        continue

    extracted = None
    if section == 'routes':
        ms = re.findall(r'^.*(?:app\.(?:get|post|put|delete|use)|socket\.on|io\.emit|router\.).*$', content, re.MULTILINE)
        extracted = '\\n'.join(ms[:80]) if ms else None
    elif section == 'constants':
        ms = re.findall(r'^(?:const|let|var)\\s+[A-Z_][A-Z0-9_]*\\s*=.*$', content, re.MULTILINE)
        extracted = '\\n'.join(ms[:50]) if ms else None
    elif section == 'imports':
        ms = re.findall(r"^(?:const|let|var|import)\\s+.*(?:require\\(|from\\s+['\"]).*$", content, re.MULTILINE)
        extracted = '\\n'.join(ms[:30]) if ms else None
    elif section == 'exports':
        ms = re.findall(r'^(?:module\.exports|exports\.).*$', content, re.MULTILINE)
        extracted = '\\n'.join(ms[:30]) if ms else None
    else:
        extracted = extract_function(content, section)

    if extracted:
        with open(sections_file, 'a') as out:
            out.write(f"\\n=== SECTION: {file_part} :: {section} ===\\n")
            out.write(extracted)
            out.write("\\n")
        count += 1

with open(sections_file, 'a') as out:
    out.write(f"\\n# Extracted {count} sections\\n")
PYEOF

    local count size
    count=$(grep -c "^=== SECTION:" "$sections_file" 2>/dev/null || echo 0)
    size=$(wc -c < "$sections_file" 2>/dev/null || echo 0)
    log "   Extracted $count sections, ${size} chars"
}

# ══════════════════════════════════════════════════════════════════════
# STAGE 0a — PREPROCESSOR: Rewrite task with concrete file facts
# ══════════════════════════════════════════════════════════════════════
stage0_preprocessor() {
    banner "STAGE 0a - PREPROCESSOR (concrete task rewrite)"
    local html_file="$PROJECT_DIR/public/index.html"
    local bot_file="$PROJECT_DIR/bot.js"
    local rewrite_file="$SESSION_DIR/00_task_rewrite.md"
    local facts_file="$SESSION_DIR/00_facts.md"

    # Extract facts from HTML
    {
        echo "# Concrete Facts from public/index.html"
        echo ""
        echo "## JavaScript Functions Found"
        grep -oE 'function\s+\w+\s*\(|const\s+\w+\s*=\s*(?:async\s+)?function\s*\(|\w+\s*:\s*(?:async\s+)?function\s*\(' "$html_file" 2>/dev/null | sed 's/function //g; s/const //g; s/://g; s/(//g' | sort -u | head -30 || echo "  (none found)"
        echo ""
        echo "## fetch() Calls and Endpoints"
        grep -nE "fetch\(|axios|\.post\(|\.get\(" "$html_file" 2>/dev/null | head -20 || echo "  (none found)"
        echo ""
        echo "## Socket Event Listeners"
        grep -nE "socket\.on\(|socket\.emit\(|io\(" "$html_file" 2>/dev/null | head -20 || echo "  (none found)"
        echo ""
        echo "## DOM Element IDs"
        grep -oE 'id="[^"]+"' "$html_file" 2>/dev/null | sort -u | head -40 || echo "  (none found)"
        echo ""
        echo "## WhatsApp References"
        grep -inE "whatsapp|baileys|qrcode|qr-code|wa[-_]|jid|msisdn|pairing" "$html_file" 2>/dev/null | head -20 || echo "  (none found)"
        echo ""
    } > "$facts_file" 2>/dev/null || true

    # Extract facts from bot.js
    {
        echo "## bot.js Routes (HTTP)"
        grep -nE "app\.(get|post|put|delete|use)\s*\(" "$bot_file" 2>/dev/null | head -30 || echo "  (none found)"
        echo ""
        echo "## bot.js Socket Emits"
        grep -nE "io\.emit|socket\.emit|io\.to\(.*\)\.emit" "$bot_file" 2>/dev/null | head -20 || echo "  (none found)"
        echo ""
        echo "## bot.js Multer Fields"
        grep -nE "upload\.(single|fields|array)" "$bot_file" 2>/dev/null | head -10 || echo "  (none found)"
        echo ""
        echo "## bot.js Auth Middleware"
        grep -nE "requireAuth|checkDownloadQuota" "$bot_file" 2>/dev/null | head -10 || echo "  (none found)"
        echo ""
    } >> "$facts_file" 2>/dev/null || true

    # Rewrite task into concrete execution plan
    local concrete_task
    concrete_task="CONCRETE EXECUTION PLAN (derived from actual file contents)

ORIGINAL TASK: $SAFE_TASK

FACTS DISCOVERED:
$(cat "$facts_file" 2>/dev/null || echo "(no facts)")

REWRITE FOR PLANNERS/CODERS:
1. DO NOT invent function names. ONLY modify functions listed in 'JavaScript Functions Found' above.
2. DO NOT invent endpoint names. ONLY use routes listed in 'bot.js Routes' above.
3. DO NOT invent socket event names. ONLY use events from 'bot.js Socket Emits'.
4. WhatsApp removal: ONLY delete DOM elements and JS references listed in 'WhatsApp References'.
5. For each endpoint mismatch, use EXACT function name from 'JavaScript Functions Found' in PATCH blocks.
6. If a function in HTML calls a route NOT in 'bot.js Routes', mark it // TODO: verify route.
7. Output format: === PATCH: public/index.html :: EXACT_FUNCTION_NAME === only.
8. NEVER output === FILE: === for this task. Surgical edits only."

    echo "$concrete_task" > "$rewrite_file"
    local rsize
    rsize=$(wc -c < "$rewrite_file" 2>/dev/null || echo 0)
    log "   Preprocessor: ${rsize} chars → $rewrite_file"
}

# ══════════════════════════════════════════════════════════════════════
# STAGE 0b — DISCOVERY: Local grep (no API) — guaranteed accurate facts
# ══════════════════════════════════════════════════════════════════════
stage0_discovery() {
    banner "STAGE 0b - DISCOVERY (local grep — no API)"
    local discovery_file="$SESSION_DIR/00_discovery.md"
    local bot_file="$PROJECT_DIR/bot.js"
    local html_file="$PROJECT_DIR/public/index.html"

    {
        echo "# Canonical Route & Event Discovery"
        echo "Generated: $(date)"
        echo ""
    } > "$discovery_file"

    # bot.js routes
    if [[ -f "$bot_file" ]]; then
        echo "## bot.js HTTP Routes" >> "$discovery_file"
        grep -nE "app\.(get|post|put|delete|use)\s*\(" "$bot_file" 2>/dev/null | head -40 >> "$discovery_file" || echo "  (no routes found)" >> "$discovery_file"
        echo "" >> "$discovery_file"

        echo "## bot.js Socket Events" >> "$discovery_file"
        grep -nE "io\.emit|socket\.emit|io\.to\(.*\)\.emit|socket\.on\(|broadcast" "$bot_file" 2>/dev/null | head -30 >> "$discovery_file" || echo "  (no socket events found)" >> "$discovery_file"
        echo "" >> "$discovery_file"

        echo "## bot.js Multer / Upload Fields" >> "$discovery_file"
        grep -nE "upload\.(single|fields|array)|multer" "$bot_file" 2>/dev/null | head -20 >> "$discovery_file" || echo "  (no upload config found)" >> "$discovery_file"
        echo "" >> "$discovery_file"

        echo "## bot.js Auth Middleware" >> "$discovery_file"
        grep -nE "requireAuth|checkDownloadQuota|ADMIN_KEY|auth.*middleware" "$bot_file" 2>/dev/null | head -20 >> "$discovery_file" || echo "  (no auth middleware found)" >> "$discovery_file"
        echo "" >> "$discovery_file"
    else
        echo "## bot.js: FILE NOT FOUND at $bot_file" >> "$discovery_file"
        echo "" >> "$discovery_file"
    fi

    # index.html current API calls
    if [[ -f "$html_file" ]]; then
        echo "## public/index.html Current API Calls" >> "$discovery_file"
        grep -nE "fetch\(|axios|xhr|\.post\(|\.get\(|url\s*:|endpoint|/api/|/download|/generate|/detect|/status|/job" "$html_file" 2>/dev/null | head -40 >> "$discovery_file" || echo "  (no API calls found)" >> "$discovery_file"
        echo "" >> "$discovery_file"

        echo "## public/index.html Socket.IO Usage" >> "$discovery_file"
        grep -nE "socket\.|io\(|\.emit\(|\.on\(|subscribe|progress|complete|cancel" "$html_file" 2>/dev/null | head -30 >> "$discovery_file" || echo "  (no socket usage found)" >> "$discovery_file"
        echo "" >> "$discovery_file"

        echo "## public/index.html WhatsApp References" >> "$discovery_file"
        grep -inE "whatsapp|baileys|qrcode|qr-code|wa[-_]|jid|msisdn|pairing" "$html_file" 2>/dev/null | head -30 >> "$discovery_file" || echo "  (no WhatsApp references found)" >> "$discovery_file"
        echo "" >> "$discovery_file"

        echo "## public/index.html DOM IDs (for PATCH targeting)" >> "$discovery_file"
        grep -oE 'id="[^"]+"' "$html_file" 2>/dev/null | sort -u | head -40 >> "$discovery_file" || true
        echo "" >> "$discovery_file"
    else
        echo "## public/index.html: FILE NOT FOUND at $html_file" >> "$discovery_file"
        echo "" >> "$discovery_file"
    fi

    local dsize
    dsize=$(wc -c < "$discovery_file" 2>/dev/null || echo 0)
    log "   Discovery: ${dsize} chars → $discovery_file"
}

# ══════════════════════════════════════════════════════════════════════
# SELECT CODER — score complexity 1-10, pick optimal model tier
# ══════════════════════════════════════════════════════════════════════
select_coder() {
    log "   Scoring task complexity..."
    local COMPLEXITY_PROMPT="Complexity analyst. Score 1-10:
TASK: $(echo "$SAFE_TASK" | head -1 | cut -c1-120)
PLAN: $(head -5 "$SESSION_DIR/20_master_plan.md" 2>/dev/null | tr '\n' ' ')

Scoring:
1-2: trivial (typo fix, rename, one-liner)
3-5: moderate (new route, CRUD, simple function)
6-8: complex (algorithm, NLP, state machine, refactor)
9-10: very complex (ML, architecture redesign)

Output ONLY one integer 1-10."

    local score=""
    for cheap_model in "gemini:gemini-3.5-flash" "claude:claude-sonnet-4-6"; do
        score=$(printf "%s" "$COMPLEXITY_PROMPT" | timeout 30 aichat -m "$cheap_model" -s 2>/dev/null | grep -o "[0-9][0-9]*" | head -1)
        if [[ -n "$score" ]] && [[ "$score" -ge 1 ]] && [[ "$score" -le 10 ]]; then
            log "   Complexity: $score/10 (by $cheap_model)"
            break
        fi
        score=""
    done
    [[ -z "$score" ]] && score=5 && log "   Complexity: 5/10 (default)"

    if [[ "$score" -le 2 ]]; then
        log "   LOW (1-2) → Free/cheap tier"
        CODER="openai:deepseek/deepseek-v4-flash:free"
        CODER_FALLBACK="openai:openrouter/owl-alpha"
        CODER_FALLBACK_2="gemini:gemini-3.5-flash"
    elif [[ "$score" -le 5 ]]; then
        log "   MEDIUM (3-5) → DeepSeek V4 Pro"
        CODER="openai:deepseek/deepseek-v4-pro"
        CODER_FALLBACK="gemini:gemini-3.1-pro-preview"
        CODER_FALLBACK_2="claude:claude-sonnet-4-6"
    else
        log "   HIGH (6-10) → GPT-5.3 Codex (85% SWE-bench)"
        CODER="openai:openai/gpt-5.3-codex"
        CODER_FALLBACK="gemini:gemini-3.1-pro-preview"
        CODER_FALLBACK_2="claude:claude-sonnet-4-6"
    fi
}

# ══════════════════════════════════════════════════════════════════════
# STAGE 1 — Planning Council (4 parallel planners)
# ══════════════════════════════════════════════════════════════════════
stage1_plan() {
    banner "STAGE 1/6 - PLANNING COUNCIL (4 planners)"
    local map_ctx=""
    [[ -f "$SESSION_DIR/00_file_map.md" ]] && map_ctx="
PROJECT FILE MAP:
$(cat "$SESSION_DIR/00_file_map.md")
"

    local task_ctx=""
    if [[ -f "$SESSION_DIR/00_task_rewrite.md" ]]; then
        task_ctx="
CONCRETE TASK (preprocessor-verified against actual files):
$(cat "$SESSION_DIR/00_task_rewrite.md")
"
    fi

    local PROMPT="You are a senior software architect.
TASK: $SAFE_TASK
${task_ctx}
${map_ctx}
Output a STRATEGIC PLAN only — NO code:
1. APPROACH: High-level strategy (2-3 sentences)
2. STEPS: Numbered implementation steps (specific, actionable)
3. RISKS: What could go wrong + mitigations
4. FILES TO MODIFY: Exact paths from file map
5. VALIDATION: How to verify success"

    log "Launching 4 planners in parallel..."
    local P1 P2 P3 P4
    (try_model "$PLANNER_1" "$PROMPT" "$SESSION_DIR/10_plan_gemini.md"   "Planner1") & P1=$!
    (try_model "$PLANNER_2" "$PROMPT" "$SESSION_DIR/11_plan_claude.md"   "Planner2") & P2=$!
    (try_model "$PLANNER_3" "$PROMPT" "$SESSION_DIR/12_plan_free.md"     "Planner3") & P3=$!
    (try_model "$PLANNER_4" "$PROMPT" "$SESSION_DIR/13_plan_deepseek.md" "Planner4") & P4=$!

    wait $P1; local s1=$?
    wait $P2; local s2=$?
    wait $P3; local s3=$?
    wait $P4; local s4=$?

    local count=0
    [[ $s1 -eq 0 ]] && count=$((count+1)) || true
    [[ $s2 -eq 0 ]] && count=$((count+1)) || true
    [[ $s3 -eq 0 ]] && count=$((count+1)) || true
    [[ $s4 -eq 0 ]] && count=$((count+1)) || true
    log "Planners: $count/4 succeeded"
    [[ "$count" -eq 0 ]] && { err "All planners failed — cannot continue"; exit 1; }
}

# ══════════════════════════════════════════════════════════════════════
# STAGE 2 — Merge Master (actively improves, not just summarizes)
# ══════════════════════════════════════════════════════════════════════
stage2_merge() {
    banner "STAGE 2/6 - MERGE MASTER"
    local MERGE_PROMPT="TASK: $SAFE_TASK
"
    local f
    for f in "$SESSION_DIR"/1?_plan_*.md; do
        [[ -f "$f" ]] && [[ "$(wc -l < "$f")" -gt 5 ]] && \
            MERGE_PROMPT="${MERGE_PROMPT}=== $(basename "$f" .md) ===
$(cat "$f")
"
    done

    MERGE_PROMPT="${MERGE_PROMPT}
You are the Chief Architect reviewing the plans above. Do NOT just summarize — actively IMPROVE them.

YOUR JOB:
1. MERGE: Combine the best ideas from all plans
2. RESOLVE: When plans contradict, pick the better approach and explain why
3. IMPROVE: Add what planners missed (edge cases, security, performance, error handling, backward compatibility)
4. CHALLENGE: If all planners made the same mistake, correct it
5. FINALIZE: Output a battle-ready plan a senior engineer would be proud of

OUTPUT FORMAT (use these exact headers):
## Executive Summary
## Architecture Decision
## Step-by-Step Implementation
## Edge Cases to Handle
## Files to Modify
## Validation Criteria

Be opinionated. Be specific. Do NOT write code. Make the coder's job easy."

    try_chain "$MERGE_PROMPT" "$SESSION_DIR/20_master_plan.md" "Merge" \
        "$MERGE_MASTER" "$MERGE_FALLBACK_1" "$MERGE_FALLBACK_2" || { err "Merge failed"; exit 1; }
}

# ══════════════════════════════════════════════════════════════════════
# STAGE 3 — Smart Gate (skips API if plan is detailed enough)
# ══════════════════════════════════════════════════════════════════════
stage3_gate() {
    banner "STAGE 3/6 - DECISION GATE"

    # If plan is detailed (>30 lines), coding is obviously needed — skip API
    local plan_lines
    plan_lines=$(wc -l < "$SESSION_DIR/20_master_plan.md" 2>/dev/null || echo 0)
    if [[ "$plan_lines" -gt 30 ]]; then
        log "   Plan is $plan_lines lines (>30) — auto YES, skipping gate API"
        echo "DECISION: YES" > "$SESSION_DIR/30_gate_decision.md"
        log "Gate: DECISION: YES (auto)"
        return 0
    fi

    log "   Plan is $plan_lines lines — consulting gate model..."
    local GATE_PROMPT="Engineering Manager. Is coding needed?
TASK: $SAFE_TASK
PLAN SUMMARY:
$(head -15 "$SESSION_DIR/20_master_plan.md")

Output ONLY:
DECISION: YES
REASON: one sentence"

    try_chain "$GATE_PROMPT" "$SESSION_DIR/30_gate_decision.md" "Gate" \
        "$GATE_PRIMARY" "$GATE_FALLBACK" || printf "DECISION: YES\n" > "$SESSION_DIR/30_gate_decision.md"

    # Parse decision — handle YES/NO with or without DECISION: prefix, strip <think> blocks
    local decision=""
    decision=$(grep -v "^<think\|^</think" "$SESSION_DIR/30_gate_decision.md" 2>/dev/null | \
        grep -ioE "DECISION:\s*(YES|NO)|^(YES|NO)$" | \
        grep -ioE "YES|NO" | head -1)
    [[ -z "$decision" ]] && decision="YES" && log "   Could not parse gate decision — defaulting YES"
    log "Gate: DECISION: $decision"

    if [[ "$decision" == "NO" ]]; then
        banner "NO CODING NEEDED"
        cat "$SESSION_DIR/20_master_plan.md"
        generate_summary
        print_usage_report
        exit 0
    fi
}

# ══════════════════════════════════════════════════════════════════════
# STAGE 4 — Code Generation (3 strategies: SURGICAL / PATCH / FULL)
# ══════════════════════════════════════════════════════════════════════
stage4_code() {
    local extra="${1:-}"
    local round="${2:-0}"
    banner "STAGE 4/6 - CODE GENERATION (round $round)"

    local sections_ctx=""
    [[ -f "$SESSION_DIR/00_relevant_sections.md" ]] && sections_ctx="
EXISTING CODE SECTIONS (reference — modify carefully):
$(cat "$SESSION_DIR/00_relevant_sections.md")
"
    local discovery_ctx=""
    [[ -f "$SESSION_DIR/00_discovery.md" ]] && discovery_ctx="
CANONICAL DISCOVERY (verified by local grep — use these exact names):
$(cat "$SESSION_DIR/00_discovery.md")
"
    local task_ctx=""
    [[ -f "$SESSION_DIR/00_task_rewrite.md" ]] && task_ctx="
CONCRETE TASK (preprocessor-verified):
$(cat "$SESSION_DIR/00_task_rewrite.md")
"
    local map_ctx=""
    [[ -f "$SESSION_DIR/00_file_map.md" ]] && map_ctx="
FILE MAP (find EXACT function names here before choosing output format):
$(cat "$SESSION_DIR/00_file_map.md")
"

    # ── Strategy classification: auto-detect best approach ────────────
    local task_lower
    task_lower=$(echo "$SAFE_TASK" | tr '[:upper:]' '[:lower:]')
    local strategy="${SUPREME_FORCE_STRATEGY:-auto}"
    local target_file=""
    local target_lines=0

    if [[ "$strategy" != "auto" ]]; then
        log "   Strategy: ${strategy^^} (forced)"
    else
        # Detect primary target file
        if echo "$task_lower" | grep -qE "public/index\.html|index\.html"; then
            target_file="$PROJECT_DIR/public/index.html"
        elif echo "$task_lower" | grep -qE "bot\.js|server\.js|app\.js"; then
            target_file="$PROJECT_DIR/bot.js"
        fi

        if [[ -n "$target_file" && -f "$target_file" ]]; then
            target_lines=$(wc -l < "$target_file" 2>/dev/null || echo 0)
        fi

        # Pick strategy based on file size and task keywords
        if [[ "$target_lines" -gt 0 && "$target_lines" -lt 400 ]]; then
            strategy="surgical"
            log "   Strategy: SURGICAL ($target_lines lines) — text edits"
        elif echo "$task_lower" | grep -qE "surgical|fix.*url|fix.*endpoint|align.*route|match.*route|remove.*whatsapp|typo|rename|change.*url"; then
            strategy="surgical"
            log "   Strategy: SURGICAL (explicit keyword) — text edits"
        elif [[ "$target_lines" -gt 0 && "$target_lines" -lt 1000 ]]; then
            strategy="patch"
            log "   Strategy: PATCH ($target_lines lines) — function blocks"
        else
            strategy="full"
            log "   Strategy: FULL FILE — complete rewrite or new file"
        fi
    fi

    # ── STRATEGY 1: SURGICAL — Structured text edits (ACTION|OLD|NEW) ──
    if [[ "$strategy" == "surgical" && -n "$target_file" ]]; then
        local file_content
        file_content=$(cat "$target_file" 2>/dev/null || echo "")
        local file_name="${target_file#$PROJECT_DIR/}"

        local SURGICAL_PROMPT="You are a precise surgical editor.
TASK: $SAFE_TASK

Edit ONLY the existing file below. Do NOT rewrite the entire file. Make minimal targeted changes.

=== CURRENT FILE: $file_name ===
$file_content
=== END FILE ===

$(cat "$SESSION_DIR/20_master_plan.md" 2>/dev/null || echo "")
$task_ctx
$discovery_ctx
$extra

OUTPUT FORMAT — use EXACTLY this:
=== EDITS ===
ACTION | UNIQUE_OLD_TEXT | NEW_TEXT
=== END EDITS ===

RULES:
- ACTION: REPLACE, DELETE, or INSERT_AFTER
- UNIQUE_OLD_TEXT: a unique 20-60 char string that appears EXACTLY ONCE in the file
- NEW_TEXT: replacement (empty for DELETE)
- One edit per line, max 50 lines
- Prioritize: endpoint fixes first, then removals, then additions
- If unsafe: # SKIP: [reason]
- No code outside the EDITS block"

        try_chain "$SURGICAL_PROMPT" "$SESSION_DIR/40_surgical_raw.md" "SurgicalCoder" \
            "$CODER" "$CODER_FALLBACK" "$CODER_FALLBACK_2" || { err "Surgical coder failed"; return 1; }

        log "   Applying surgical edits..."
        python3 - "$target_file" "$SESSION_DIR/40_surgical_raw.md" "$SESSION_DIR" << 'PYAPPLY'
import sys, re, os, shutil

target_file = sys.argv[1]
edits_file  = sys.argv[2]
session_dir = sys.argv[3]

text    = open(edits_file,  errors='replace').read()
content = open(target_file, errors='replace').read()

match = re.search(r'=== EDITS ===(.*?)=== END EDITS ===', text, re.DOTALL)
if not match:
    print("No EDITS block found in surgical output")
    sys.exit(1)

applied = skipped = 0
details = []

for line in match.group(1).strip().splitlines():
    line = line.strip()
    if not line or line.startswith('#'):
        continue
    parts = line.split(' | ')
    if len(parts) < 3:
        continue
    action = parts[0].strip().upper()
    old    = parts[1].strip()
    new    = parts[2].strip() if len(parts) > 2 else ''

    if old not in content:
        skipped += 1
        details.append(f"SKIP {action} (not found): {old[:50]}")
        continue

    if action == 'REPLACE':
        content = content.replace(old, new, 1)
        applied += 1
        details.append(f"REPLACE: {old[:50]}")
    elif action == 'DELETE':
        content = content.replace(old, '', 1)
        applied += 1
        details.append(f"DELETE: {old[:50]}")
    elif action == 'INSERT_AFTER':
        content = content.replace(old, old + new, 1)
        applied += 1
        details.append(f"INSERT_AFTER: {old[:50]}")

if applied > 0:
    open(target_file, 'w').write(content)
    print(f"APPLIED {applied} edits, skipped {skipped}")
else:
    print(f"NO EDITS APPLIED (skipped {skipped})")

for d in details:
    print(f"  {d}")

# Save for audit
open(f"{session_dir}/40_code_raw.md", 'w').write(text)
PYAPPLY
        return 0
    fi

    # ── STRATEGY 2: PATCH — Function-by-function replacement ──────────
    if [[ "$strategy" == "patch" ]]; then
        local CODE_PROMPT="You are the Lead Developer. Follow the master plan EXACTLY:
$(cat "$SESSION_DIR/20_master_plan.md")
${extra}
${map_ctx}
${sections_ctx}
${discovery_ctx}
${task_ctx}

CRITICAL: Output ONLY modified functions using:
=== PATCH: path/to/file :: EXACT_FUNCTION_NAME ===
[new function body]
=== END PATCH ===

Use ONLY exact function names from the FILE MAP. NEVER invent names.
If a function does not exist, use its intended name — placer will auto-append.
Do NOT explain. Only PATCH blocks."

        try_chain "$CODE_PROMPT" "$SESSION_DIR/40_code_raw.md" "PatchCoder" \
            "$CODER" "$CODER_FALLBACK" "$CODER_FALLBACK_2" || { err "Patch coder failed"; return 1; }
        return 0
    fi

    # ── STRATEGY 3: FULL FILE — Complete rewrite (large files/new files) ──
    local CODE_PROMPT="You are the Lead Developer. Follow the master plan EXACTLY:
$(cat "$SESSION_DIR/20_master_plan.md")
${extra}
${map_ctx}
${sections_ctx}
${discovery_ctx}
${task_ctx}

CRITICAL FILE-TYPE RULES:
- NODE_SERVER files: never add browser code (document, window, localStorage)
- BROWSER_JS / HTML files: never add Node.js code (require, module.exports)

For new or complete-rewrite files:
=== FILE: path/to/file ===
[complete file content]
=== END FILE ===

For single function changes:
=== PATCH: path/to/file :: exact_function_name ===
[complete function body]
=== END PATCH ===

Do NOT explain. Only blocks."

    try_chain "$CODE_PROMPT" "$SESSION_DIR/40_code_raw.md" "FullCoder" \
        "$CODER" "$CODER_FALLBACK" "$CODER_FALLBACK_2" || { err "Full coder failed"; return 1; }
}


# ══════════════════════════════════════════════════════════════════════
# STAGE 5 — Audit (max SUPREME_MAX_FIX rounds)
# ══════════════════════════════════════════════════════════════════════
stage5_audit() {
    local round="${1:-0}"
    banner "STAGE 5/6 - AUDIT (round $round)"
    local AUDIT_PROMPT="Senior code reviewer. Be precise and fair.
TASK: $SAFE_TASK
PLAN (first 50 lines):
$(head -n 50 "$SESSION_DIR/20_master_plan.md")

CODE (first 400 lines):
$(head -n 400 "$SESSION_DIR/40_code_raw.md")

Review for: bugs, security issues, missing error handling, truncation, broken braces.
Output EXACTLY this format:
CRITICAL: <comma-separated list of blockers, or NONE>
WARNINGS: <comma-separated list of warnings, or NONE>
APPROVE: YES or NO
REASON: one line"

    try_chain "$AUDIT_PROMPT" "$SESSION_DIR/50_audit.md" "Auditor" \
        "$AUDITOR" "$AUDIT_FALLBACK" || printf "APPROVE: YES\nREASON: audit model unavailable\n" > "$SESSION_DIR/50_audit.md"

    local critical approve
    critical=$(grep -i "^CRITICAL:" "$SESSION_DIR/50_audit.md" | head -n 1 || true)
    approve=$(grep -i "^APPROVE:" "$SESSION_DIR/50_audit.md" | head -n 1 || true)
    log "Audit: $approve"

    # Pass if no CRITICAL issues or explicitly approved
    if echo "$critical" | grep -qi "NONE" || echo "$approve" | grep -qi "YES"; then
        return 0
    fi

    echo ""
    cat "$SESSION_DIR/50_audit.md"
    echo ""

    if [[ "$round" -ge "$SUPREME_MAX_FIX" ]]; then
        log "Max audit rounds ($SUPREME_MAX_FIX) reached"
        return 0
    fi

    if [[ "$SUPREME_AUTO" == "1" ]]; then
        log "SUPREME_AUTO=1: auto-recoding with audit fixes"
        local fixes
        fixes=$(cat "$SESSION_DIR/50_audit.md")
        stage4_code "
AUDIT FIXES REQUIRED:
$fixes" $((round + 1))
        stage5_audit $((round + 1))
        return 0
    fi

    local r=""
    read -r -p "Critical issues found. Recode? [y/N]: " r || true
    if [[ "$r" == "y" || "$r" == "Y" ]]; then
        local fixes
        fixes=$(cat "$SESSION_DIR/50_audit.md")
        stage4_code "
AUDIT FIXES REQUIRED:
$fixes" $((round + 1))
        stage5_audit $((round + 1))
    fi
}

# ══════════════════════════════════════════════════════════════════════
# STAGE 6 — Final Decision + Smart Fix/Split Loop
# ══════════════════════════════════════════════════════════════════════
stage6_decide() {
    local round="${1:-0}"
    banner "STAGE 6/6 - FINAL DECISION (round $round)"

    # FAST PATH: if auditor approved, skip Commander and ship immediately
    local audit_approve
    audit_approve=$(grep -i "^APPROVE:" "$SESSION_DIR/50_audit.md" 2>/dev/null | head -n 1 || true)
    if echo "$audit_approve" | grep -qi "YES"; then
        log "   Auditor approved — auto-SHIP (skipping Commander)"
        {
            echo "1. DECISION: SHIP"
            echo "2. CONFIDENCE: High"
            echo "3. REASON: Auditor approved — no Commander review needed"
        } > "$SESSION_DIR/60_final_decision.md"
        place_files
        return 0
    fi

    local FINAL_PROMPT="Engineering Manager — final code review.
TASK: $SAFE_TASK
PLAN (first 50 lines):
$(head -n 50 "$SESSION_DIR/20_master_plan.md")
CODE (first 300 lines):
$(head -n 300 "$SESSION_DIR/40_code_raw.md")
AUDIT:
$(cat "$SESSION_DIR/50_audit.md")

Output:
1. DECISION: SHIP / FIX / REJECT
2. CONFIDENCE: High/Medium/Low
3. REASON: one clear paragraph
4. If FIX: prioritised fix list (P0=blocker, P1=important, P2=nice-to-have)"

    local file="$SESSION_DIR/60_final_decision.md"
    [[ "$round" -gt 0 ]] && file="$SESSION_DIR/60_final_decision_r${round}.md"

    try_chain "$FINAL_PROMPT" "$file" "Commander" \
        "$COMMANDER" "$CMD_FALLBACK_1" "$CMD_FALLBACK_2" || printf "1. DECISION: FIX\n" > "$file"

    [[ "$file" != "$SESSION_DIR/60_final_decision.md" ]] && cp "$file" "$SESSION_DIR/60_final_decision.md"

    # Robust decision parsing — strip markdown bold, whitespace, think blocks
    local decision
    decision=$(grep -v "^<think\|^</think" "$file" 2>/dev/null | \
        grep -i "DECISION:" | head -n 1 | \
        sed 's/\*\*//g; s/[[:space:]]//g' || true)
    log "Final: $decision"

    if echo "$decision" | grep -qi "SHIP"; then
        place_files
        return 0
    fi

    echo ""
    cat "$file"
    echo ""

    if echo "$decision" | grep -qi "REJECT"; then
        log "Code REJECTED by Commander"
        log "Draft saved: $SESSION_DIR/40_code_raw.md"
        return 0
    fi

    # FIX path
    if [[ "$round" -ge "$SUPREME_MAX_FIX" ]]; then
        log "Max fix rounds ($SUPREME_MAX_FIX) reached — manual review required"
        log "To force-place the draft: supreme-place $SESSION_DIR $PROJECT_DIR"
        return 0
    fi

    if [[ "$SUPREME_AUTO" == "1" ]]; then
        log "SUPREME_AUTO=1: asking Commander to split work into subtasks..."

        # Dynamic line limit based on current coder model
        local _max_lines=400
        case "$CODER" in
            *gpt-5.3-codex*)      _max_lines=700 ;;
            *deepseek-v4-pro*)    _max_lines=600 ;;
            *opus*|*gemini-3.1*)  _max_lines=450 ;;
            *sonnet*)             _max_lines=350 ;;
            *flash*|*owl*)        _max_lines=180 ;;
        esac
        log "   Subtask line limit: $_max_lines (coder: $CODER)"

        local SPLIT_PROMPT="Engineering Manager. Split the remaining work into 2-4 subtasks.

ORIGINAL TASK: $SAFE_TASK
WHAT WAS DELIVERED (first 150 lines):
$(head -n 150 "$SESSION_DIR/40_code_raw.md")
FIX DECISION:
$(cat "$file")

SPLIT RULES:
1. Max $_max_lines lines per subtask
2. Each subtask = ONE complete self-contained function or file section
3. Write critical logic FIRST (return statement, core algorithm, then constants)
4. Every subtask MUST end with a closing brace } and valid return
5. NEVER split one function across multiple subtasks
6. For ENTIRE FILE rewrites (full HTML, removing sections) → instruct FILE block
7. For single function changes → instruct PATCH block with EXACT function name

Output ONLY numbered subtasks, one per line:
SUBTASK_1: [specific instruction]
SUBTASK_2: [specific instruction]"

        local subtasks
        subtasks=$(printf "%s" "$SPLIT_PROMPT" | timeout 120 aichat -m "$COMMANDER" -s 2>/dev/null || true)

        if [[ -z "$subtasks" ]] || ! echo "$subtasks" | grep -q "SUBTASK_"; then
            err "Commander failed to produce subtasks — falling back to simple retry"
            stage4_code "
FIX LIST:
$(cat "$file")" $((round + 1))
            stage5_audit 0
            stage6_decide $((round + 1))
            return 0
        fi

        log "Commander split plan:"
        echo "$subtasks" | grep "SUBTASK_" | while IFS= read -r line; do log "  $line"; done

        local subtask_num=1
        local merged_output="$SESSION_DIR/40_code_merged.md"
        > "$merged_output"

        while IFS= read -r subtask_line; do
            [[ "$subtask_line" != SUBTASK_* ]] && continue
            local subtask_instruction="${subtask_line#*: }"
            [[ -z "$subtask_instruction" ]] && { log "   Empty subtask $subtask_num — skipping"; continue; }

            log "Executing subtask $subtask_num (max $_max_lines lines)..."

            local subtask_file="$SESSION_DIR/40_subtask_${subtask_num}.md"
            local max_retries=3 retry=0 success=0 prev_output=""

            while [[ $retry -lt $max_retries ]]; do
                local subtask_prompt
                if [[ $retry -eq 0 ]]; then
                    subtask_prompt="SUBTASK $subtask_num — Complete this as ONE output block, max $_max_lines lines:
$subtask_instruction

NON-NEGOTIABLE:
- Output complete code — never truncate
- End with === END PATCH === (PATCH) or === END FILE === (FILE)
- Every opening { must have a matching closing }
- For full-file rewrites: use === FILE: path === with COMPLETE file content
- For single functions: use === PATCH: file :: exactFunctionName ==="
                else
                    subtask_prompt="CONTINUATION — previous attempt was incomplete.
Previous output (continue from where it stopped — do NOT rewrite from scratch):
$prev_output

Complete the code. Close all open braces. End with === END PATCH === or === END FILE ===.
If continuation is messy, output the COMPLETE block instead."
                fi

                SUPREME_FORCE_STRATEGY=patch stage4_code "$subtask_prompt" $((round + subtask_num))

                cp "$SESSION_DIR/40_code_raw.md" "$subtask_file" 2>/dev/null
                prev_output=$(cat "$subtask_file" 2>/dev/null)

                # Require END marker — accept PATCH, FILE, or EDITS blocks
                if ! grep -qE "=== END (PATCH|FILE|EDITS) ===" "$subtask_file" 2>/dev/null; then
                    log "   Subtask $subtask_num missing END marker — retry $((retry+1))/$max_retries"
                    retry=$((retry + 1))
                    continue
                fi

                # Structural validation: brace balance
                local validation_issues
                validation_issues=$(python3 - <<PYVALEOF
import re, sys
text = open("$subtask_file", errors="replace").read()
issues = []
patches = re.findall(r'=== PATCH:.*?===\n(.*?)=== END PATCH ===', text, re.DOTALL)
for body in patches:
    depth = 0
    in_str = escape = False
    str_char = ""
    for c in body:
        if escape: escape = False; continue
        if c == "\\\\": escape = True; continue
        if in_str:
            if c == str_char: in_str = False
            continue
        if c in '"\\'"'"'\`':
            in_str = True; str_char = c; continue
        if c == "{": depth += 1
        elif c == "}": depth -= 1
    if depth != 0:
        issues.append(f"brace imbalance: depth={depth}")
    stripped = body.rstrip()
    if stripped and not stripped.endswith("}"):
        issues.append("truncated: missing closing brace")
print("|".join(issues) if issues else "OK")
PYVALEOF
)
                if [[ "$validation_issues" != "OK" ]]; then
                    log "   Subtask $subtask_num brace check FAILED ($validation_issues) — retry $((retry+1))/$max_retries"
                    retry=$((retry + 1))
                    continue
                fi

                log "   Subtask $subtask_num complete ✓"
                success=1
                break
            done

            [[ $success -eq 0 ]] && warn "Subtask $subtask_num incomplete after $max_retries retries"

            cat "$subtask_file" >> "$merged_output"
            echo "" >> "$merged_output"
            subtask_num=$((subtask_num + 1))
        done <<< "$subtasks"

        cp "$merged_output" "$SESSION_DIR/40_code_raw.md"
        log "Merged $((subtask_num - 1)) subtasks → 40_code_raw.md"

        log "Running final audit on merged output..."
        stage5_audit 0
        stage6_decide $((round + 1))
        return 0
    fi

    local r=""
    read -r -p "Retry with fixes? [y/N]: " r || true
    if [[ "$r" == "y" || "$r" == "Y" ]]; then
        stage4_code "
FIX LIST FROM COMMANDER:
$(cat "$file")" $((round + 1))
        stage5_audit 0
        stage6_decide $((round + 1))
    else
        log "Files held — no changes made"
    fi
}

# ══════════════════════════════════════════════════════════════════════
# FILE PLACEMENT — Robust Python patcher with JS syntax validation
# ══════════════════════════════════════════════════════════════════════
place_files() {
    log "Placing files and patches..."
    python3 << 'PYEOF'
import re, os, shutil, sys, subprocess
from datetime import datetime

project_dir = os.environ.get('_SP_PROJECT_DIR', '.')
session_dir = os.environ.get('_SP_SESSION_DIR', '.')
archive_dir = os.environ.get('_SP_ARCHIVE_DIR', '.')
dl_base     = os.environ.get('_SP_DL_BASE', '/tmp')
task        = os.environ.get('_SP_TASK', 'task')

code_file = f'{session_dir}/40_code_raw.md'
if not os.path.exists(code_file):
    print(f'Code file missing: {code_file}')
    sys.exit(1)
text = open(code_file, errors='replace').read()

date_folder = datetime.now().strftime('%Y-%m-%d_%H-%M')
task_slug   = re.sub(r'[^a-zA-Z0-9_]', '_', task[:30])
dl_dir      = f'{dl_base}/{date_folder}_{task_slug}'
os.makedirs(dl_dir, exist_ok=True)

placed = patched = archived = skipped = 0
patch_errors = []

# ── Syntax validation ─────────────────────────────────────────────────
def validate_js(filepath):
    try:
        r = subprocess.run(['node', '--check', filepath],
                           capture_output=True, text=True, timeout=10)
        return r.returncode == 0, r.stderr.strip()
    except Exception:
        return True, ''   # node not available — assume OK

# ── Archive helper ────────────────────────────────────────────────────
def archive_file(target, file_path):
    global archived
    arc = os.path.join(archive_dir, file_path)
    os.makedirs(os.path.dirname(arc) or archive_dir, exist_ok=True)
    shutil.copy2(target, arc)
    archived += 1

# ── Copy to downloads ─────────────────────────────────────────────────
def copy_to_downloads(target, file_path):
    try:
        dl = os.path.join(dl_dir, file_path)
        os.makedirs(os.path.dirname(dl) or dl_dir, exist_ok=True)
        shutil.copy2(target, dl)
    except Exception:
        pass

# ── Robust function finder ────────────────────────────────────────────
def find_function_bounds(content, func_name):
    patterns = [
        rf'\bfunction\s+{re.escape(func_name)}\s*\(',
        rf'\bconst\s+{re.escape(func_name)}\s*=\s*(?:async\s+)?(?:function\s*)?\(',
        rf'\b(?:async\s+)?{re.escape(func_name)}\s*:\s*(?:async\s+)?function\s*\(',
        rf'\b(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+{re.escape(func_name)}\s*\(',
        rf'\b{re.escape(func_name)}\s*=\s*(?:async\s+)?\([^)]*\)\s*=>',
    ]
    start_match = None
    for pat in patterns:
        m = re.search(pat, content)
        if m:
            start_match = m
            break
    if not start_match:
        return None

    brace_idx = content.find('{', start_match.end())
    if brace_idx == -1:
        return (start_match.start(), start_match.end() + 300)

    i, n, depth = brace_idx, len(content), 1
    in_string = in_comment = None
    escape = False
    while i < n and depth > 0:
        c = content[i]
        if escape:              escape = False; i += 1; continue
        if in_comment == 'line':
            if c == '\n':       in_comment = None
            i += 1; continue
        elif in_comment == 'block':
            if c == '*' and i+1 < n and content[i+1] == '/':
                in_comment = None; i += 2; continue
            i += 1; continue
        if in_string:
            if c == '\\':       escape = True
            elif c == in_string: in_string = None
            elif in_string == '`' and c == '$' and i+1 < n and content[i+1] == '{':
                # Template literal interpolation — skip nested braces
                sub_i, sub_d = i+2, 1
                while sub_i < n and sub_d > 0:
                    sc = content[sub_i]
                    if sc == '{': sub_d += 1
                    elif sc == '}': sub_d -= 1
                    sub_i += 1
                i = sub_i; continue
            i += 1; continue
        if c in ('"', "'", '`'): in_string = c; i += 1; continue
        if c == '/' and i+1 < n:
            if content[i+1] == '/':  in_comment = 'line';  i += 2; continue
            if content[i+1] == '*':  in_comment = 'block'; i += 2; continue
        if c == '{': depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return (start_match.start(), i+1)
        i += 1
    return None

# ── PATCH blocks ──────────────────────────────────────────────────────
patch_blocks = re.findall(
    r'=== PATCH:\s*(.*?)\s*::\s*(.*?)\s*===\n(.*?)=== END PATCH ===',
    text, re.DOTALL)

for file_path, func_name, new_body in patch_blocks:
    file_path = file_path.strip()
    # Clean function name — stop at === or quotes or newlines (coder sometimes leaks reasoning)
    func_name = func_name.strip()
    func_name = func_name.split('===')[0].strip()
    func_name = func_name.split('"')[0].strip()
    func_name = func_name.split("'")[0].strip()
    func_name = func_name.split('//')[0].strip()
    func_name = func_name.split('.')[0].strip() if '.' in func_name and len(func_name) > 30 else func_name
    # Reject clearly invalid function names (too long or contains spaces after cleaning)
    if len(func_name) > 60 or ' ' in func_name[:20]:
        skipped += 1
        print(f'Skip bad PATCH name: {func_name[:50]}')
        continue
    target    = os.path.join(project_dir, file_path)

    if not os.path.exists(target):
        patch_errors.append(f'File not found: {file_path}')
        skipped += 1
        continue

    archive_file(target, file_path)
    content = open(target, errors='replace').read()
    bounds  = find_function_bounds(content, func_name)

    if bounds is None:
        # Function not found — auto-append before module.exports (or at end)
        print(f'Function {func_name!r} not found — appending to {file_path}')
        insert_pt = content.rfind('module.exports')
        if insert_pt == -1:
            new_content = content.rstrip() + f'\n\n// Added by supreme: {func_name}\n' + new_body.strip() + '\n'
        else:
            new_content = content[:insert_pt] + f'// Added by supreme: {func_name}\n' + new_body.strip() + '\n\n' + content[insert_pt:]
    else:
        start_idx, end_idx = bounds
        new_content = content[:start_idx] + new_body.strip() + '\n' + content[end_idx:]

    temp_path = target + '.supreme_tmp'
    open(temp_path, 'w').write(new_content)

    if file_path.endswith('.js'):
        ok, msg = validate_js(temp_path)
        if not ok:
            os.remove(temp_path)
            patch_errors.append(f'Syntax error after patch: {file_path} :: {func_name} — {msg[:100]}')
            skipped += 1
            continue

    shutil.move(temp_path, target)
    patched += 1
    print(f'Patched: {file_path} :: {func_name}')
    copy_to_downloads(target, file_path)

# ── FILE blocks ───────────────────────────────────────────────────────
file_blocks = re.findall(r'=== FILE:\s*(.*?)\s*===\n(.*?)=== END FILE ===', text, re.DOTALL)
if not file_blocks:
    # Fallback: greedy match to end of text
    file_blocks = re.findall(r'=== FILE:\s*(.*?)\s*===\n(.*?)(?=\n=== FILE:|\n=== PATCH:|\Z)', text, re.DOTALL)

for path, content in file_blocks:
    path = path.strip().strip('`').strip('*').strip()
    if not path or not content.strip() or '\n' in path or '..' in path or path.startswith('/'):
        skipped += 1
        continue

    target = os.path.join(project_dir, path)
    if os.path.exists(target):
        archive_file(target, path)

    os.makedirs(os.path.dirname(target) or project_dir, exist_ok=True)
    temp_path = target + '.supreme_tmp'
    open(temp_path, 'w').write(content.strip() + '\n')

    if path.endswith('.js'):
        ok, msg = validate_js(temp_path)
        if not ok:
            os.remove(temp_path)
            patch_errors.append(f'Syntax error in new file: {path} — {msg[:100]}')
            skipped += 1
            continue

    shutil.move(temp_path, target)
    placed += 1
    print(f'Placed: {path}')
    copy_to_downloads(target, path)

# ── Report ─────────────────────────────────────────────────────────────
print(f'{placed} placed, {patched} patched, {archived} archived, {skipped} skipped')
if patch_errors:
    print('ERRORS:')
    for e in patch_errors:
        print(f'  {e}')
print(f'Downloads: {dl_dir}')
PYEOF
}

# ══════════════════════════════════════════════════════════════════════
# supreme-place — manual re-placement from a saved session
# ══════════════════════════════════════════════════════════════════════
supreme_place() {
    SESSION_DIR="$1"
    PROJECT_DIR="${2:-.}"
    ARCHIVE_DIR="$PROJECT_DIR/.ai-archive/manual_$(date +%H%M%S)"
    SAFE_TASK="${SAFE_TASK:-manual}"
    export _SP_PROJECT_DIR="$PROJECT_DIR"
    export _SP_SESSION_DIR="$SESSION_DIR"
    export _SP_ARCHIVE_DIR="$ARCHIVE_DIR"
    export _SP_DL_BASE="$DL_BASE"
    export _SP_TASK="$SAFE_TASK"
    place_files
}

# ══════════════════════════════════════════════════════════════════════
# GIT — auto-commit + push (or interactive)
# ══════════════════════════════════════════════════════════════════════
stage_git() {
    cd "$PROJECT_DIR" || return 0
    [[ ! -d ".git" ]] && return 0

    local changes
    changes=$(git status --short 2>/dev/null || true)
    [[ -z "$changes" ]] && { log "No changes to commit"; return 0; }

    echo "$changes" | head -n 20

    if [[ "$SUPREME_AUTO" == "1" ]]; then
        git add . && git commit -m "AI: $(echo "$SAFE_TASK" | cut -c1-70)" || true
        git push || true
        return 0
    fi

    local c=""
    read -r -p "Commit changes? [y/N]: " c || true
    [[ "$c" != "y" && "$c" != "Y" ]] && return 0
    git add . && git commit -m "AI: $(echo "$SAFE_TASK" | cut -c1-70)"

    local p=""
    read -r -p "Push? [y/N]: " p || true
    [[ "$p" != "y" && "$p" != "Y" ]] && return 0
    git checkout main 2>/dev/null || git checkout master 2>/dev/null || true
    git pull --rebase || git pull || true
    git push && log "Pushed to remote" || err "Push failed — try manually"
}

# ══════════════════════════════════════════════════════════════════════
# REPORTING
# ══════════════════════════════════════════════════════════════════════
print_usage_report() {
    banner "MODEL USAGE REPORT"
    echo "Total API calls: $TOTAL_CALLS / $SUPREME_MAX_CALLS"
    echo "Successful:"
    if [[ ${#MODELS_USED[@]} -eq 0 ]]; then
        echo "  none"
    else
        for m in "${!MODELS_USED[@]}"; do
            echo "  $m: ${MODELS_USED[$m]}x"
        done
    fi
    echo "Failed:"
    # Safe expansion — avoid unbound variable when MODELS_FAILED is empty
    set +u
    local mf_keys="${!MODELS_FAILED[@]}"
    set -u
    if [[ -z "$mf_keys" ]]; then
        echo "  none"
    else
        for m in $mf_keys; do
            echo "  $m: ${MODELS_FAILED[$m]}"
        done
    fi
}

generate_summary() {
    local s="$SESSION_DIR/SUMMARY.md"
    {
        echo "# Session $SESSION_NAME"
        echo "Task: $SAFE_TASK"
        echo "Total calls: $TOTAL_CALLS"
        echo "Decision: $(grep -i "DECISION:" "$SESSION_DIR/60_final_decision.md" 2>/dev/null | head -n 1 || echo "Plan only")"
        echo "Models used:"
        for m in "${!MODELS_USED[@]}"; do echo "  $m: ${MODELS_USED[$m]}x"; done
    } > "$s"
}

# ══════════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════════

# Check for supreme-place direct call
if [[ "${1:-}" == "place" ]]; then
    supreme_place "${2:-}" "${3:-.}"
    exit 0
fi

setup
command -v aichat >/dev/null 2>&1 || { err "aichat not found in PATH. Install: pip install aichat"; exit 1; }

echo "TASK: $SAFE_TASK" > "$SESSION_DIR/00_task.txt"
banner "SUPREME PIPELINE 12.2"
log "Task: $SAFE_TASK"
log "Session: $SESSION_DIR"
log "Max calls: $SUPREME_MAX_CALLS  |  Max fix rounds: $SUPREME_MAX_FIX"
[[ "$SUPREME_AUTO" == "1" ]] && log "Mode: NON-INTERACTIVE"
[[ "$SUPREME_DRY"  == "1" ]] && log "Mode: DRY-RUN"

# Export for Python subprocesses
export _SP_PROJECT_DIR="$PROJECT_DIR"
export _SP_SESSION_DIR="$SESSION_DIR"
export _SP_ARCHIVE_DIR="$ARCHIVE_DIR"
export _SP_DL_BASE="$DL_BASE"
export _SP_TASK="$SAFE_TASK"

# Context build
if [[ "${SKIP_CONTEXT:-0}" != "1" ]]; then
    banner "CONTEXT BUILD"
    build_file_map
    extract_relevant_sections
    stage0_preprocessor
    stage0_discovery
fi

check_stop

stage1_plan
check_stop

stage2_merge
check_stop

stage3_gate
select_coder
check_stop

stage4_code "" 0
stage5_audit 0
stage6_decide 0

generate_summary
print_usage_report
stage_git

banner "PIPELINE COMPLETE"
echo "Council: $SESSION_DIR"
echo "Archive: $ARCHIVE_DIR"
echo "Latest:  $PROJECT_DIR/.ai-council/latest"
[[ -s "$ERROR_LOG" ]] && echo "Errors:  $ERROR_LOG"


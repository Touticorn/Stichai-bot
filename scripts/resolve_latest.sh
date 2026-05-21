#!/usr/bin/env bash
set -euo pipefail

# Resiliently resolves the path to the latest valid manifest.json.
# Implements the consumer contract: symlink -> fallback scan.
# On success, prints the absolute path to manifest.json and exits 0.
# On failure, prints an error to stderr and exits 1.
# Usage: LATEST_MANIFEST=$(./resolve_latest.sh)

# --- Configuration ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
COUNCIL_DIR=$(realpath "${SCRIPT_DIR}/../../.ai-council")
LATEST_LINK="${COUNCIL_DIR}/latest"
SESSIONS_DIR="${COUNCIL_DIR}/sessions"
VALIDATE_SCRIPT="${SCRIPT_DIR}/validate_manifest.sh"

# --- Function to check a potential session directory ---
check_session() {
    local session_dir=$1
    local manifest_path="${session_dir}/manifest.json"

    if [[ -f "$manifest_path" ]] && [[ -r "$manifest_path" ]]; then
        if "$VALIDATE_SCRIPT" "$manifest_path" &>/dev/null; then
            echo "$manifest_path"
            return 0
        fi
    fi
    return 1
}

# --- Main Logic ---

# 1. Attempt to resolve via symlink
if [[ -L "$LATEST_LINK" ]]; then
    # `readlink -f` resolves the entire path, making it absolute
    TARGET_DIR=$(readlink -f "$LATEST_LINK")
    if [[ -d "$TARGET_DIR" ]]; then
        if manifest=$(check_session "$TARGET_DIR"); then
            # echo "Resolver: Found valid manifest via symlink." >&2
            echo "$manifest"
            exit 0
        fi
    fi
fi
# echo "Resolver: Symlink is broken or target is invalid. Falling back to scan." >&2

# 2. Fallback: Scan sessions directory for newest valid entry
if [[ -d "$SESSIONS_DIR" ]]; then
    # List directories, sort reverse-chronologically (newest first)
    CANDIDATES=($(ls -1r "$SESSIONS_DIR"))
    for session_ts in "${CANDIDATES[@]}"; do
        SESSION_PATH="${SESSIONS_DIR}/${session_ts}"
        if [[ -d "$SESSION_PATH" ]]; then
            if manifest=$(check_session "$SESSION_PATH"); then
                # echo "Resolver: Found valid manifest via fallback scan: ${session_ts}" >&2
                echo "$manifest"
                exit 0
            fi
        fi
    done
fi

# 3. If we get here, no valid session was found
echo "Error: Resolver could not find any valid session." >&2
exit 1

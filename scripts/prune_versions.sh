#!/usr/bin/env bash
set -euo pipefail

# Prunes old session directories based on the retention policy in config.yml.
# Never deletes the currently active 'latest' session.
# Usage: ./prune_versions.sh

# --- Configuration ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
COUNCIL_DIR="${SCRIPT_DIR}/../../.ai-council"
LOCK_FILE="${COUNCIL_DIR}/lock"
SESSIONS_DIR="${COUNCIL_DIR}/sessions"
LATEST_LINK="${COUNCIL_DIR}/latest"
CONFIG_FILE="${COUNCIL_DIR}/config.yml"
INDEX_FILE="${COUNCIL_DIR}/INDEX"
HISTORY_FILE="${COUNCIL_DIR}/history"

# --- Pre-flight Checks ---
if [[ ! -d "$SESSIONS_DIR" ]]; then
    echo "Info: Sessions directory '$SESSIONS_DIR' not found. Nothing to prune."
    exit 0
fi

if [[ ! -f "$CONFIG_FILE" ]]; then
    echo "Error: Config file '$CONFIG_FILE' not found." >&2
    exit 1
fi

# --- Main Logic ---
(
    flock -w 120 200

    # 1. Read retention policy from config.yml
    RETENTION_COUNT=$(grep 'count:' "$CONFIG_FILE" | sed 's/.*count: //')
    if ! [[ "$RETENTION_COUNT" =~ ^[0-9]+$ ]]; then
        echo "Error: Invalid retention count '$RETENTION_COUNT' in config." >&2
        exit 1
    fi

    # 2. Get the currently-linked session to protect it
    CURRENTLY_LINKED=""
    if [[ -L "$LATEST_LINK" ]]; then
        CURRENTLY_LINKED=$(basename "$(readlink "$LATEST_LINK")")
    fi

    echo "Pruning sessions. Retention count: ${RETENTION_COUNT}. Protecting: ${CURRENTLY_LINKED}"

    # 3. Find all sessions and identify which to keep vs delete
    # `ls -1r` lists one per line, in reverse (newest first)
    ALL_SESSIONS=($(ls -1r "$SESSIONS_DIR"))
    SESSIONS_TO_KEEP=()
    SESSIONS_TO_DELETE=()
    DELETED_COUNT=0

    # Keep the N most recent
    for (( i=0; i<${RETENTION_COUNT} && i<${#ALL_SESSIONS[@]}; i++ )); do
        SESSIONS_TO_KEEP+=("${ALL_SESSIONS[i]}")
    done
    
    # Always keep the currently linked one
    if [[ -n "$CURRENTLY_LINKED" && ! " ${SESSIONS_TO_KEEP[*]} " =~ " ${CURRENTLY_LINKED} " ]]; then
        SESSIONS_TO_KEEP+=("$CURRENTLY_LINKED")
    fi
    
    # Identify sessions for deletion
    for session in "${ALL_SESSIONS[@]}"; do
        if ! [[ " ${SESSIONS_TO_KEEP[*]} " =~ " ${session} " ]]; then
            SESSIONS_TO_DELETE+=("$session")
        fi
    done

    # 4. Delete old sessions
    if [[ ${#SESSIONS_TO_DELETE[@]} -eq 0 ]]; then
        echo "No old sessions to prune."
    else
        for session in "${SESSIONS_TO_DELETE[@]}"; do
            echo "Deleting old session: $session"
            rm -rf "${SESSIONS_DIR}/${session}"
            ((DELETED_COUNT++))
        done
        
        # 5. Update INDEX to reflect reality
        TEMP_INDEX=$(mktemp)
        (
            cd "$SESSIONS_DIR" || exit 1
            ls -1d * | sort > "$TEMP_INDEX"
        )
        mv "$TEMP_INDEX" "$INDEX_FILE"

        echo "Pruning complete. Deleted ${DELETED_COUNT} session(s)."
        echo "$(date -u --iso-8601=seconds) [PRUNE] SUCCESS: Pruned ${DELETED_COUNT} session(s) with retention=${RETENTION_COUNT}" >> "$HISTORY_FILE"
    fi

) 200>"$LOCK_FILE"

#!/usr/bin/env bash
set -euo pipefail

# Rolls back the 'latest' symlink to the previous known-good version from the INDEX.
# Usage: ./rollback.sh

# --- Configuration ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
COUNCIL_DIR="${SCRIPT_DIR}/../../.ai-council"
LOCK_FILE="${COUNCIL_DIR}/lock"
SESSIONS_DIR="${COUNCIL_DIR}/sessions"
LATEST_LINK="${COUNCIL_DIR}/latest"
INDEX_FILE="${COUNCIL_DIR}/INDEX"
HISTORY_FILE="${COUNCIL_DIR}/history"

# --- Pre-flight Checks ---
if [[ ! -f "$INDEX_FILE" ]]; then
    echo "Error: INDEX file '$INDEX_FILE' not found. Cannot determine previous version." >&2
    exit 1
fi

# --- Main Logic ---
(
    flock -w 60 200

    CURRENT_TARGET_NAME=$(basename "$(readlink "$LATEST_LINK")" || echo "none")
    echo "Current version: $CURRENT_TARGET_NAME"

    # Get the last two lines from the index. tail -n2 might be empty or have 1 line.
    mapfile -t PREVIOUS_VERSIONS < <(tail -n 2 "$INDEX_FILE")

    if [[ ${#PREVIOUS_VERSIONS[@]} -lt 2 ]]; then
        echo "Error: Not enough history in INDEX to roll back." >&2
        exit 1
    fi

    ROLLBACK_TO_VERSION="${PREVIOUS_VERSIONS[0]}"
    
    if [[ ! -d "${SESSIONS_DIR}/${ROLLBACK_TO_VERSION}" ]]; then
        echo "Error: Rollback target directory '${SESSIONS_DIR}/${ROLLBACK_TO_VERSION}' does not exist." >&2
        exit 1
    fi
    
    echo "Rolling back from ${CURRENT_TARGET_NAME} to ${ROLLBACK_TO_VERSION}..."

    # Atomic symlink swap
    ln -sfn "sessions/${ROLLBACK_TO_VERSION}" "$LATEST_LINK"

    # Log to history
    echo "$(date -u --iso-8601=seconds) [ROLLBACK] SUCCESS: Rolled back from ${CURRENT_TARGET_NAME} to ${ROLLBACK_TO_VERSION}" >> "$HISTORY_FILE"

    echo "Rollback successful. '${LATEST_LINK}' now points to '${ROLLBACK_TO_VERSION}'."

) 200>"$LOCK_FILE"

#!/usr/bin/env bash
set -euo pipefail

# Atomically promotes a new version to be the 'latest' session.
# Reads new manifest content from stdin.
# Usage: cat new_manifest.json | ./promote_version.sh

# --- Configuration ---
# Assuming scripts are run from the bot's root directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
COUNCIL_DIR="${SCRIPT_DIR}/../../.ai-council"
LOCK_FILE="${COUNCIL_DIR}/lock"
SESSIONS_DIR="${COUNCIL_DIR}/sessions"
LATEST_LINK="${COUNCIL_DIR}/latest"
INDEX_FILE="${COUNCIL_DIR}/INDEX"
HISTORY_FILE="${COUNCIL_DIR}/history"
VALIDATE_SCRIPT="${SCRIPT_DIR}/validate_manifest.sh"

# --- Pre-flight Checks ---
if [[ ! -d "$COUNCIL_DIR" ]]; then
    echo "Error: Council directory '$COUNCIL_DIR' not found." >&2
    exit 1
fi

if [[ ! -x "$VALIDATE_SCRIPT" ]]; then
    echo "Error: Validation script '$VALIDATE_SCRIPT' not found or not executable." >&2
    exit 1
fi

# Read manifest from stdin
MANIFEST_CONTENT=$(cat)
if [[ -z "$MANIFEST_CONTENT" ]]; then
    echo "Error: Manifest content from stdin is empty." >&2
    exit 1
fi

# --- Main Logic ---
(
    # Acquire exclusive lock, wait up to 60 seconds
    flock -w 60 200

    TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
    NEW_SESSION_DIR="${SESSIONS_DIR}/${TIMESTAMP}"
    NEW_MANIFEST_FILE="${NEW_SESSION_DIR}/manifest.json"

    echo "Promoting new session: ${TIMESTAMP}"

    # 1. Create new session directory
    mkdir -p "$NEW_SESSION_DIR"

    # 2. Write manifest
    echo "$MANIFEST_CONTENT" > "$NEW_MANIFEST_FILE"

    # 3. Pre-flight validation
    if ! "$VALIDATE_SCRIPT" "$NEW_MANIFEST_FILE"; then
        echo "Error: New manifest failed validation. Rolling back promotion." >&2
        rm -rf "$NEW_SESSION_DIR" # Clean up failed attempt
        exit 1
    fi

    # 4. Atomic symlink swap
    # ln -sfn <target> <link_name>
    # -s: create symbolic link
    # -f: force (remove existing destination)
    # -n: if link_name is a symlink to a directory, treat it as a file
    ln -sfn "sessions/${TIMESTAMP}" "$LATEST_LINK"

    # 5. Append to INDEX
    echo "${TIMESTAMP}" >> "$INDEX_FILE"

    # 6. Log to history
    SESSION_ID=$(jq -r .session_id "$NEW_MANIFEST_FILE")
    echo "$(date -u --iso-8601=seconds) [PROMOTE] SUCCESS: Promoted session ${TIMESTAMP} (ID: ${SESSION_ID})" >> "$HISTORY_FILE"

    echo "Successfully promoted ${TIMESTAMP} to latest."

) 200>"$LOCK_FILE" # The file descriptor 200 is associated with the lock file

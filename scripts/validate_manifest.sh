#!/usr/bin/env bash
set -euo pipefail

# Validates that a manifest.json file conforms to the required schema.
# Usage: ./validate_manifest.sh /path/to/manifest.json

if ! command -v jq &> /dev/null; then
    echo "Error: jq is not installed. Please install it to validate manifests." >&2
    exit 1
fi

if [[ $# -ne 1 ]]; then
    echo "Usage: $0 <path_to_manifest.json>" >&2
    exit 1
fi

MANIFEST_FILE="$1"

if [[ ! -f "$MANIFEST_FILE" ]]; then
    echo "Error: Manifest file not found at '$MANIFEST_FILE'" >&2
    exit 2
fi

# List of required top-level keys
REQUIRED_KEYS=(
    "version"
    "timestamp_utc"
    "session_id"
    "participants"
    "decision"
    "confidence"
    "dissents"
    "config_refs"
)

# Build a jq filter to check for all keys
# Example: .version != null and .timestamp_utc != null ...
JQ_FILTER=""
for key in "${REQUIRED_KEYS[@]}"; do
    if [[ -z "$JQ_FILTER" ]]; then
        JQ_FILTER=".$key != null"
    else
        JQ_FILTER="$JQ_FILTER and .$key != null"
    fi
done

# Add type checks
JQ_FILTER="$JQ_FILTER and (.participants | type) == \"array\""
JQ_FILTER="$JQ_FILTER and (.decision | type) == \"object\""
JQ_FILTER="$JQ_FILTER and (.confidence | type) == \"number\""
JQ_FILTER="$JQ_FILTER and (.dissents | type) == \"array\""
JQ_FILTER="$JQ_FILTER and (.config_refs | type) == \"object\""


if jq -e "$JQ_FILTER" "$MANIFEST_FILE" > /dev/null; then
    # echo "Validation successful for '$MANIFEST_FILE'" >&2
    exit 0
else
    echo "Error: Manifest validation failed for '$MANIFEST_FILE'." >&2
    echo "Please ensure all required keys and types are present:" >&2
    echo "${REQUIRED_KEYS[*]}" >&2
    exit 3
fi

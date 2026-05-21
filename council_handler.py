import subprocess
import json
import uuid
from datetime import datetime, timezone
import sys
import os

# This is a mockup of a component that generates and promotes new decisions.

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROMOTE_SCRIPT = os.path.join(BASE_DIR, "scripts/promote_version.sh")

def create_new_decision(action: str, params: dict):
    """
    Creates a new decision manifest as a JSON string.
    """
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    
    manifest = {
        "version": "2.0",
        "timestamp_utc": timestamp,
        "session_id": str(uuid.uuid4()),
        "participants": [
            "council-handler-v3.1",
            "safety-monitor-v1.9"
        ],
        "decision": {
            "action": action,
            "params": params
        },
        "confidence": 0.99,
        "dissents": [],
        "config_refs": {
            "source_git_commit": os.getenv("GIT_COMMIT_SHA", "unknown")
        }
    }
    return json.dumps(manifest, indent=2)


def promote_decision(manifest_json: str):
    """
    Uses the promote_version.sh script to atomically publish a new decision.
    """
    print("Promoting new decision...")
    try:
        result = subprocess.run(
            [PROMOTE_SCRIPT],
            input=manifest_json,
            text=True,
            capture_output=True,
            check=True
        )
        print("Promotion successful.")
        print(result.stdout)
    except subprocess.CalledProcessError as e:
        print("ERROR: Promotion script failed.", file=sys.stderr)
        print(f"Return code: {e.returncode}", file=sys.stderr)
        print(f"Stdout: {e.stdout}", file=sys.stderr)
        print(f"Stderr: {e.stderr}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    # Example usage:
    # python council_handler.py SWITCH_TARGET_MODEL '{"name": "model-C-v3.0"}'
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <ACTION_NAME> '<PARAMS_JSON>'")
        sys.exit(1)
        
    action_name = sys.argv[1]
    try:
        action_params = json.loads(sys.argv[2])
    except json.JSONDecodeError:
        print(f"Error: Invalid JSON for params: {sys.argv[2]}", file=sys.stderr)
        sys.exit(1)

    new_manifest = create_new_decision(action=action_name, params=action_params)
    print("--- New Manifest ---")
    print(new_manifest)
    print("--------------------")
    
    promote_decision(new_manifest)

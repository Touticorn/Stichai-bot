import subprocess
import json
import sys
import os

# This is a mockup of a bot component that needs to read the current decision.

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
RESOLVER_SCRIPT = os.path.join(BASE_DIR, "scripts/resolve_latest.sh")

def get_current_decision():
    """
    Reads the latest decision by calling the resolver script.
    Demonstrates the consumer contract.
    """
    try:
        result = subprocess.run(
            [RESOLVER_SCRIPT],
            capture_output=True,
            text=True,
            check=True,
            # Add a timeout to handle potential filesystem hangs
            timeout=10 
        )
        manifest_path = result.stdout.strip()
        with open(manifest_path, 'r') as f:
            return json.load(f)
    except subprocess.TimeoutExpired:
        print(f"FATAL: Resolver script timed out.", file=sys.stderr)
        sys.exit(1)
    except (subprocess.CalledProcessError, FileNotFoundError, json.JSONDecodeError) as e:
        print(f"FATAL: Could not get current decision: {e}", file=sys.stderr)
        # In a real bot, this might trigger a fallback to a safe state
        # rather than exiting.
        sys.exit(1)


def main():
    """
    Example of a component performing its work based on the resolved decision.
    """
    print("[TaskRouter] Resolving current decision...")
    decision_data = get_current_decision()
    session_id = decision_data.get("session_id")
    action = decision_data.get("decision", {}).get("action", "NO_ACTION")

    print(f"[TaskRouter] Operating under session {session_id}.")
    print(f"[TaskRouter] Routing tasks for action: {action}")

    # ... logic to route tasks based on the action ...
    if action == "DEPLOY_TO_PROD":
        print("[TaskRouter] INFO: Initiating production deployment workflow.")
    elif action == "SAFE_MODE":
        print("[TaskRouter] WARN: Entering safe mode. Halting outbound actions.")
    else:
        print(f"[TaskRouter] INFO: Executing standard task schedule for action '{action}'.")


if __name__ == "__main__":
    main()

import subprocess
import sys
import json
import time
import os

# This is a mockup of the main bot entrypoint.

# Configuration
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
RESOLVER_SCRIPT = os.path.join(BASE_DIR, "scripts/resolve_latest.sh")
TASK_ROUTER_SCRIPT = os.path.join(BASE_DIR, "task_router.py")


class Bot:
    def __init__(self, manifest_path):
        self.manifest_path = manifest_path
        self.config = self._load_config(manifest_path)
        self.session_id = self.config.get("session_id")
        print(f"Bot initialized with session: {self.session_id}")

    def _load_config(self, path):
        """Loads the decision manifest."""
        try:
            with open(path, 'r') as f:
                return json.load(f)
        except (IOError, json.JSONDecodeError) as e:
            print(f"FATAL: Could not read or parse manifest at {path}: {e}", file=sys.stderr)
            sys.exit(1)

    def run(self):
        """Main bot loop."""
        print("Bot running...")
        while True:
            # In a real bot, this would dispatch tasks based on the decision
            print(f"[{self.session_id}] Processing tasks based on decision: {self.config['decision']['action']}")
            
            # Example of using another component that also resolves the latest config
            subprocess.run([sys.executable, TASK_ROUTER_SCRIPT], check=True)

            time.sleep(10)
            # In a real scenario, you might periodically re-resolve to pick up changes
            # without a restart, but that adds complexity (e.g., state migration).
            # For now, we assume restart on new decision.


def startup():
    """
    Implements the resilient consumer contract at startup.
    """
    print("Bot starting up...")
    try:
        # Use the resolver script to find the current valid manifest
        result = subprocess.run(
            [RESOLVER_SCRIPT],
            capture_output=True,
            text=True,
            check=True
        )
        latest_manifest_path = result.stdout.strip()
        print(f"Found latest manifest: {latest_manifest_path}")
        return Bot(latest_manifest_path)

    except subprocess.CalledProcessError as e:
        # This happens if resolve_latest.sh exits with a non-zero status
        print("FATAL: resolve_latest.sh failed. No valid session found.", file=sys.stderr)
        print(f"Stderr: {e.stderr}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    bot_instance = startup()
    bot_instance.run()

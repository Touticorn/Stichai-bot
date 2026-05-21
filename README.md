# Hello World

A minimal Python 3 program that outputs the canonical greeting to stdout.

---

## Prerequisites

- **Python 3** (any release ≥ 3.6)

Verify availability:

```bash
python3 --version
```

If Python 3 is not present, fall back to an alternative runtime:

| Runtime | Command |
|---------|---------|
| Node.js | `node -e "console.log('Hello, World!')"` |
| Bash    | `echo 'Hello, World!'` |

---

## Running the Program

```bash
python3 hello.py
```

Expected output (exactly):

```
Hello, World!
```

---

## Validation

Run the automated diff check to confirm exact output:

```bash
python3 hello.py | diff - <(printf "Hello, World!\n")
```

No output from the diff command indicates a passing result.

Confirm the process exits cleanly:

```bash
python3 hello.py; echo "Exit code: $?"
```

Expected: `Exit code: 0`

Confirm no stderr output:

```bash
python3 hello.py 2>/tmp/stderr_check.txt; cat /tmp/stderr_check.txt
```

Expected: empty file.

Confirm UTF-8 encoding with no BOM:

```bash
file hello.py
# Expected: hello.py: Python script, UTF-8 Unicode text executable
```

---

## Rollback

If the change must be reverted:

```bash
# Revert the single atomic commit
git revert <commit-sha>

# Confirm clean state
git status
git log --oneline -5
```

Recovery time objective: **< 1 minute**.
No downstream services, consumers, or data migrations are affected.

---

## File Inventory

| File        | Purpose                                      |
|-------------|----------------------------------------------|
| `hello.py`  | Single source file containing the print statement |
| `README.md` | Purpose, prerequisites, run command, and validation steps |

# Hello World

A minimal Python program that prints `Hello World` to standard output.

## Requirements

- Python 3.6 or higher

## Usage

```bash
python3 hello.py
```

## Expected Output

```
Hello World
```

## Verification

To verify the output programmatically:

```bash
output=$(python3 hello.py)
if [ "$output" = "Hello World" ]; then
    echo "PASS: Output matches expected 'Hello World'"
else
    echo "FAIL: Output was '$output'"
    exit 1
fi
```

## Exit Codes

| Code | Meaning |
|------|---------|
| `0`  | Success — `Hello World` printed to stdout |
| `1`  | Failure — I/O error writing to stdout |

## Rollback

```bash
git revert <commit-sha>
```

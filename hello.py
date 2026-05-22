#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import sys


def main() -> int:
    """Print 'Hello World' to stdout and return exit code 0."""
    try:
        print("Hello World")
        return 0
    except IOError as e:
        sys.stderr.write(f"Error writing to stdout: {e}\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())

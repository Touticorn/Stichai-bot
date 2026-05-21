#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Hello World entry point.
Outputs the canonical greeting to stdout and exits with code 0.
"""

import sys


def main() -> int:
    """Print the greeting and return exit code."""
    try:
        print("Hello, World!")
        return 0
    except IOError as exc:
        sys.stderr.write(f"Error writing to stdout: {exc}\n")
        return 1


if __name__ == "__main__":
    sys.exit(main())

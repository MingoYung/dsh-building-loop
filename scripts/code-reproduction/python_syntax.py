"""Trusted recipe helper. Compile exact snapshot bytes without importing them."""

import json
from pathlib import Path
import sys


def main():
    if len(sys.argv) != 2:
        return 2
    root = Path("/submission").resolve()
    source = (root / sys.argv[1]).resolve()
    if not source.is_relative_to(root) or not source.is_file():
        return 2
    try:
        compile(source.read_bytes(), sys.argv[1], "exec", dont_inherit=True)
    except SyntaxError as error:
        print(json.dumps({"status": "syntax-error", "line": error.lineno or 1}))
        return 1
    print('{"status":"parsed"}')
    return 0


if __name__ == "__main__":
    sys.exit(main())

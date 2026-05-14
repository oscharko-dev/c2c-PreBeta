#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

python3 scripts/scan-secrets.py --staged
python3 scripts/scan-secrets.py --worktree

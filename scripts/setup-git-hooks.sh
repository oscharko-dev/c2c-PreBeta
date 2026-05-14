#!/usr/bin/env bash
set -euo pipefail

git config core.hooksPath "$(pwd)/.githooks"
echo "Git hooks path configured to $(pwd)/.githooks"
echo "Pre-commit hook enabled for local credential scans."

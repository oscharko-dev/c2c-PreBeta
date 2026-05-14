#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "Scanning for common secret patterns..."

patterns=(
  "AKIA[0-9A-Z]{16}"
  "(?i)password\s*[:=]\s*['\"]?[^'\"\s]{8,}"
  "(?i)api[_-]?key\s*[:=]\s*['\"]?[A-Za-z0-9._-]{16,}['\"]?"
  "BEGIN (RSA|OPENSSH) PRIVATE KEY"
)

for pattern in "${patterns[@]}"; do
  if rg -n -P "$pattern" . \
    --glob '!.git' \
    --glob '!**/node_modules/**' \
    --glob '!**/artifacts/**' \
    --glob '!**/dist/**' >/tmp/secret_scan.txt; then
    echo "Possible secret found for pattern: $pattern"
    cat /tmp/secret_scan.txt
    rm -f /tmp/secret_scan.txt
    exit 1
  fi
done

echo "Secret scan passed."

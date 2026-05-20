#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not installed; skipping typescript service checks."
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

mapfile -t TS_PACKAGES < <(
  cd "$REPO_ROOT" &&
    python3 scripts/validate-service-catalog.py \
      --worktree \
      --list-field path \
      --language typescript \
      --release-gate ci
)

for pkg in "${TS_PACKAGES[@]}"; do
  pkg_dir="$REPO_ROOT/$pkg"
  if [ ! -f "$pkg_dir/package.json" ]; then
    echo "skipping $pkg (no package.json)"
    continue
  fi
  echo "==> typescript checks for $pkg"
  (
    cd "$pkg_dir"
    npm install --no-audit --no-fund
    npm run lint
    npm run test
    if npm run 2>/dev/null | awk '/^Lifecycle scripts/{flag=0} /^available via/{flag=1; next} flag' | grep -qE '^\s*build'; then
      npm run build
    elif node -e "process.exit(Object.keys(require('./package.json').scripts||{}).includes('build')?0:1)"; then
      npm run build
    fi
  )
done

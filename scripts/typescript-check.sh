#!/usr/bin/env bash
set -euo pipefail

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not installed; skipping typescript service checks."
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Every TypeScript package that owns a package.json with build/lint/test
# scripts. Order matters: the c2c-bff serves the c2c-ui static bundle, so
# build the UI before the BFF so the BFF dist references the latest UI.
TS_PACKAGES=(
  "apps/c2c-ui"
  "services/c2c-bff"
  "services/typescript/w0-service"
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

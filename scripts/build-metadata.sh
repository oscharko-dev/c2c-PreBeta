#!/usr/bin/env bash
set -euo pipefail

VERSION="${C2C_VERSION:-0.1.0}"
SERVICE="${1:-w0-service}"
LANG="${2:-generic}"

git_sha="$(git rev-parse --short HEAD)"
ts="$(date -u +%Y%m%dT%H%M%SZ)"
artifact="${SERVICE}-${LANG}-v${VERSION}-${git_sha}-${ts}"

echo "$artifact"

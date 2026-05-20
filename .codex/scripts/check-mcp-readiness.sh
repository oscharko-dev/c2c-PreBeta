#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"

echo "Checking Codex project readiness..."

python3 - <<'PY'
from __future__ import annotations

import shutil
import sys
import tomllib
from pathlib import Path

root = Path.cwd()
config_path = root / ".codex" / "config.toml"
config = tomllib.loads(config_path.read_text(encoding="utf-8"))
servers = config.get("mcp_servers", {})

errors: list[str] = []
warnings: list[str] = []

if "GITHUB_PERSONAL_ACCESS_TOKEN" in config_path.read_text(encoding="utf-8"):
    errors.append("Do not store GitHub tokens in .codex/config.toml")

filesystem = servers.get("filesystem", {})
fs_args = filesystem.get("args", [])
if filesystem.get("enabled"):
    if str(root) not in fs_args:
        errors.append("filesystem MCP must be scoped to this repository root")

for name, server in sorted(servers.items()):
    if not isinstance(server, dict) or not server.get("enabled"):
        continue
    command = server.get("command")
    url = server.get("url")
    if command and not shutil.which(command):
        errors.append(f"enabled MCP server {name!r} command not found: {command}")
    if not command and not url:
        warnings.append(f"enabled MCP server {name!r} has neither command nor url")

for rel in [
    ".codex/agent-memory/coordinator/MEMORY.md",
    ".codex/agents/coordinator.toml",
    ".codex/codex-task-prompt.md",
    ".codex/codex-audit-prompt.md",
    ".codex/RUNBOOK.md",
]:
    if not (root / rel).exists():
        errors.append(f"missing required Codex file: {rel}")

if warnings:
    print("Warnings:")
    for warning in warnings:
        print(f"- {warning}")

if errors:
    print("Errors:", file=sys.stderr)
    for error in errors:
        print(f"- {error}", file=sys.stderr)
    raise SystemExit(1)

print("Codex config and MCP readiness checks passed.")
PY

if command -v gh >/dev/null 2>&1; then
  if gh auth status >/dev/null 2>&1; then
    echo "GitHub CLI authentication: ok"
  else
    echo "GitHub CLI authentication: not ready" >&2
    exit 1
  fi
else
  echo "GitHub CLI not found" >&2
  exit 1
fi

echo "Codex readiness complete."

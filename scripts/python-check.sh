#!/usr/bin/env bash
set -euo pipefail

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python3 not installed; skipping python service checks."
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export C2C_REPO_ROOT="$ROOT_DIR"

python3 - <<'PY'
import os
import pathlib
import subprocess

root_dir = pathlib.Path(os.environ["C2C_REPO_ROOT"])

print("Running repository script tests")
subprocess.run(
    ["python3", "-m", "unittest", "discover", "-s", "scripts", "-p", "*test*.py"],
    check=True,
    cwd=root_dir,
)

services_output = subprocess.check_output(
    [
        "python3",
        "scripts/validate-service-catalog.py",
        "--worktree",
        "--list-field",
        "path",
        "--language",
        "python",
        "--release-gate",
        "ci",
    ],
    cwd=root_dir,
    text=True,
)
services = [line.strip() for line in services_output.splitlines() if line.strip()]

for service in services:
    service_path = root_dir / service
    if not (service_path / "tests").is_dir():
        continue
    print(f"Running python tests for {service}")
    env = os.environ.copy()
    src_path = (service_path / "src").resolve()
    env["PYTHONPATH"] = f"{src_path}:{env.get('PYTHONPATH', '')}"
    result = subprocess.run(
        ["python3", "-m", "unittest", "discover", "-s", "tests", "-p", "*test*.py"],
        cwd=service_path,
        env=env,
        check=False,
    )
    if result.returncode != 0:
        raise SystemExit(result.returncode)
PY

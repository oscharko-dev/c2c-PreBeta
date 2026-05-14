#!/usr/bin/env bash
set -euo pipefail

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python3 not installed; skipping python service checks."
  exit 0
fi

python3 - <<'PY'
import os
import pathlib
import subprocess

print("Running repository script tests")
subprocess.run(
    ["python3", "-m", "unittest", "discover", "-s", "scripts", "-p", "*test*.py"],
    check=True,
)

services = [
  "services/python/w0-service",
  "services/orchestrator-service",
]

for service in services:
    service_path = pathlib.Path(service)
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

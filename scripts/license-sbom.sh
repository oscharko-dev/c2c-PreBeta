#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

root = Path(__file__).resolve().parents[1]
out_dir = root / "artifacts"
out_dir.mkdir(exist_ok=True)

services = {
    "go": root / "services" / "go" / "w0-service",
    "python": root / "services" / "python" / "w0-service",
    "typescript": root / "services" / "typescript" / "w0-service",
    "typescript-bff": root / "services" / "c2c-bff",
    "typescript-ui": root / "apps" / "c2c-ui",
    "java": root / "services" / "java" / "w0-service",
    "java-cobol-parser": root / "services" / "cobol-parser-service",
    "java-semantic-ir": root / "services" / "semantic-ir-service",
}

manifest = {
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "schema_version": "w0-sbom-1",
    "artifacts": [],
}

dependencies: dict[str, dict[str, object]] = {}
licenses: dict[str, str] = {}


for language, service_dir in services.items():
    files = []
    for pattern in ["Dockerfile", "README.md", "pom.xml", "go.mod", "requirements.txt", "package.json", "tsconfig.json"]:
        path = service_dir / pattern
        if path.exists():
            with open(path, "rb") as fh:
                digest = hashlib.sha256(fh.read()).hexdigest()
            files.append({
                "path": str(path.relative_to(root)),
                "sha256": digest,
            })

    manifest["artifacts"].append({
        "service": service_dir.name,
        "language": language,
        "files": files,
    })

out_file = out_dir / "platform-sbom.json"
with open(out_file, "w", encoding="utf-8") as fh:
    json.dump(manifest, fh, indent=2, sort_keys=True)

print(f"Wrote {out_file}")

# Go dependencies and checksums from go.mod/go.sum
go_service = services["go"]
go_modules = subprocess.check_output(["go", "list", "-m", "all"], cwd=go_service, text=True)
dependencies["go"] = {"modules": [line.strip() for line in go_modules.splitlines() if line.strip()]}
go_sum = go_service / "go.sum"
if go_sum.exists():
    licenses["go"] = f"module checksums captured in {go_sum.relative_to(root)}"

# Node dependencies from npm lockfile (covers all TypeScript packages).
for ts_key in ("typescript", "typescript-bff", "typescript-ui"):
    ts_service = services.get(ts_key)
    if ts_service is None:
        continue
    pkg_lock = ts_service / "package-lock.json"
    if pkg_lock.exists():
        with open(pkg_lock, "r", encoding="utf-8") as fh:
            lock = json.load(fh)
        packages = lock.get("packages", {})
        dependencies[ts_key] = {
            "packages": sorted([name for name in packages.keys() if name and name.startswith("node_modules/")])
        }
        licenses[ts_key] = f"dependency lock captured in {pkg_lock.relative_to(root)}"

# Python dependencies (requirements baseline)
py_service = services["python"]
req_file = py_service / "requirements.txt"
if req_file.exists():
    requirements = [line.strip() for line in req_file.read_text(encoding="utf-8").splitlines() if line.strip() and not line.strip().startswith("#")]
    dependencies["python"] = {"requirements": requirements}
    licenses["python"] = f"dependency baseline captured in {req_file.relative_to(root)}"

# Java dependencies (Maven dependency tree)
java_services = [services["java"], services["java-cobol-parser"], services["java-semantic-ir"]]
java_deps: dict[str, list[str]] = {}
for svc in java_services:
    output = subprocess.check_output(
        ["mvn", "-q", "-DforceStdout", "dependency:list", "-DincludeScope=runtime"],
        cwd=svc,
        text=True,
        stderr=subprocess.STDOUT,
    )
    coords = []
    for line in output.splitlines():
        line = line.strip()
        if ":" in line and not line.startswith("["):
            coords.append(line)
    java_deps[svc.name] = sorted(set(coords))
dependencies["java"] = java_deps
licenses["java"] = "runtime dependency coordinates captured from Maven dependency:list"

dep_file = out_dir / "dependency-manifest.json"
with open(dep_file, "w", encoding="utf-8") as fh:
    json.dump(
        {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "schema_version": "w0-dependency-manifest-1",
            "dependencies": dependencies,
        },
        fh,
        indent=2,
        sort_keys=True,
    )
print(f"Wrote {dep_file}")

license_file = out_dir / "license-visibility.json"
with open(license_file, "w", encoding="utf-8") as fh:
    json.dump(
        {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "schema_version": "w0-license-visibility-1",
            "evidence": licenses,
        },
        fh,
        indent=2,
        sort_keys=True,
    )
print(f"Wrote {license_file}")

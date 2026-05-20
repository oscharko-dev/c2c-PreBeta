#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
export C2C_SBOM_ROOT="$ROOT_DIR"
exec python3 - "$@" <<'PY'
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

root = Path(os.environ["C2C_SBOM_ROOT"])
catalog_path = root / "config" / "service-catalog.json"
out_dir = root / "artifacts"
out_dir.mkdir(exist_ok=True)


def run_checked(command: list[str], *, cwd: Path | None = None) -> str:
    result = subprocess.run(
        command,
        cwd=cwd or root,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        if result.stdout:
            sys.stderr.write(result.stdout)
        if result.stderr:
            sys.stderr.write(result.stderr)
        raise SystemExit(result.returncode)
    return result.stdout


run_checked(["python3", "scripts/validate-service-catalog.py", "--worktree"])

with catalog_path.open("r", encoding="utf-8") as handle:
    catalog = json.load(handle)

components = sorted(
    (
        component
        for component in catalog["components"]
        if "sbom" in component["supplyChainParticipation"]
        or "license" in component["supplyChainParticipation"]
    ),
    key=lambda component: component["id"],
)


def component_file(component: dict[str, object], field: str) -> Path:
    raw_path = component.get(field)
    if not isinstance(raw_path, str) or not raw_path:
        raise RuntimeError(f"{component['id']}: missing expected {field}")
    return root / component["path"] / raw_path


def sha256(path: Path) -> str:
    with path.open("rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


manifest = {
    "generated_at": datetime.now(timezone.utc).isoformat(),
    "schema_version": "w0-sbom-2",
    "artifacts": [],
}
dependencies: dict[str, dict[str, object]] = {}
licenses: dict[str, dict[str, object]] = {}

for component in components:
    component_root = root / component["path"]
    files: list[dict[str, str]] = []
    seen_paths: set[str] = set()

    for field in ("packageManifest", "dependencyManifest", "dockerfile", "openapi"):
        if field not in component:
            continue
        file_path = component_file(component, field)
        relative = str(file_path.relative_to(root))
        if relative in seen_paths:
            continue
        seen_paths.add(relative)
        files.append({"field": field, "path": relative, "sha256": sha256(file_path)})

    for schema_path in component.get("schemas", []):
        file_path = root / schema_path
        relative = str(file_path.relative_to(root))
        if relative in seen_paths:
            continue
        seen_paths.add(relative)
        files.append({"field": "schemas", "path": relative, "sha256": sha256(file_path)})

    readme_path = component_root / "README.md"
    if readme_path.is_file():
        relative = str(readme_path.relative_to(root))
        if relative not in seen_paths:
            files.append({"field": "README", "path": relative, "sha256": sha256(readme_path)})

    manifest["artifacts"].append(
        {
            "componentId": component["id"],
            "path": component["path"],
            "language": component["language"],
            "packageManager": component["packageManager"],
            "supplyChainParticipation": component["supplyChainParticipation"],
            "files": files,
        }
    )

    package_manager = component["packageManager"]
    dependency_manifest = component_file(component, "dependencyManifest")
    dependency_record: dict[str, object] = {
        "packageManager": package_manager,
        "packageManifest": str(component_file(component, "packageManifest").relative_to(root)),
        "dependencyManifest": str(dependency_manifest.relative_to(root)),
    }
    license_record: dict[str, object] = {
        "packageManager": package_manager,
        "dependencyManifest": str(dependency_manifest.relative_to(root)),
    }

    if package_manager == "go":
        modules = run_checked(["go", "list", "-m", "all"], cwd=component_root)
        dependency_record["modules"] = [line.strip() for line in modules.splitlines() if line.strip()]
        go_sum = component_root / "go.sum"
        if go_sum.is_file():
            license_record["checksumManifest"] = str(go_sum.relative_to(root))
        license_record["note"] = "dependency inventory captured from go list -m all"
    elif package_manager == "npm":
        with dependency_manifest.open("r", encoding="utf-8") as handle:
            lock = json.load(handle)
        packages = lock.get("packages", {})
        dependency_record["packages"] = sorted(
            name for name in packages.keys() if name and name.startswith("node_modules/")
        )
        license_record["note"] = "dependency lock captured from npm lockfile"
    elif package_manager == "pip":
        dependency_record["requirements"] = [
            line.strip()
            for line in dependency_manifest.read_text(encoding="utf-8").splitlines()
            if line.strip() and not line.strip().startswith("#")
        ]
        license_record["note"] = "dependency baseline captured from Python requirements manifest"
    elif package_manager == "maven":
        output = run_checked(
            ["mvn", "-q", "-DforceStdout", "dependency:list", "-DincludeScope=runtime"],
            cwd=component_root,
        )
        dependency_record["coordinates"] = sorted(
            {
                line.strip()
                for line in output.splitlines()
                if ":" in line and not line.strip().startswith("[")
            }
        )
        license_record["note"] = "runtime dependency coordinates captured from Maven dependency:list"
    else:
        raise RuntimeError(f"{component['id']}: unsupported package manager {package_manager!r}")

    dependencies[component["id"]] = dependency_record
    licenses[component["id"]] = license_record

platform_sbom = out_dir / "platform-sbom.json"
with platform_sbom.open("w", encoding="utf-8") as handle:
    json.dump(manifest, handle, indent=2, sort_keys=True)
print(f"Wrote {platform_sbom}")

dependency_manifest = out_dir / "dependency-manifest.json"
with dependency_manifest.open("w", encoding="utf-8") as handle:
    json.dump(
        {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "schema_version": "w0-dependency-manifest-2",
            "dependencies": dependencies,
        },
        handle,
        indent=2,
        sort_keys=True,
    )
print(f"Wrote {dependency_manifest}")

license_visibility = out_dir / "license-visibility.json"
with license_visibility.open("w", encoding="utf-8") as handle:
    json.dump(
        {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "schema_version": "w0-license-visibility-2",
            "evidence": licenses,
        },
        handle,
        indent=2,
        sort_keys=True,
    )
print(f"Wrote {license_visibility}")
PY

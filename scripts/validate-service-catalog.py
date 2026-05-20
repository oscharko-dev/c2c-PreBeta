#!/usr/bin/env python3
"""Validate the repository service catalog for Issue #323."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


ALLOWED_KINDS = {"app", "service", "library"}
ALLOWED_CLASSIFICATIONS = {"product", "reference"}
ALLOWED_PACKAGE_MANAGERS = {"go", "maven", "npm", "pip"}
REQUIRED_COMPONENT_IDS = {
    "agentic-harness-core",
    "build-test-runner-service",
    "c2c-bff",
    "c2c-studio",
    "c2c-target-java-runtime",
    "cobol-parser-service",
    "evidence-service",
    "experience-learning-service",
    "model-gateway-service",
    "orchestrator-service",
    "semantic-ir-service",
    "target-java-generation-service",
    "w0-service-go",
    "w0-service-java",
    "w0-service-python",
    "w0-service-typescript",
}
REFERENCE_COMPONENT_IDS = {
    "w0-service-go",
    "w0-service-java",
    "w0-service-python",
    "w0-service-typescript",
}
ID_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
LANGUAGE_TO_PACKAGE_MANAGERS = {
    "go": {"go"},
    "java": {"maven"},
    "python": {"pip"},
    "typescript": {"npm"},
}
COMMAND_FIELDS = ("checkCommand", "buildCommand", "testCommand")
LOCAL_FILE_FIELDS = ("packageManifest", "dockerfile", "openapi")


def _default_repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError("catalog root must be a JSON object")
    return data


def _require_string(value: Any, field: str, component_id: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{component_id}: {field} must be a non-empty string")
    return value.strip()


def _resolve_repo_relative(repo_root: Path, raw_path: str, field: str, component_id: str) -> Path:
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise ValueError(f"{component_id}: {field} must be a non-empty string")
    if raw_path.startswith("/"):
        raise ValueError(f"{component_id}: {field} must be repo-relative")
    candidate = (repo_root / raw_path).resolve()
    try:
        candidate.relative_to(repo_root)
    except ValueError as exc:
        raise ValueError(f"{component_id}: {field} escapes the repository root") from exc
    return candidate


def _resolve_component_relative(
    repo_root: Path, component_root: Path, raw_path: str, field: str, component_id: str
) -> Path:
    _require_string(raw_path, field, component_id)
    if "/" in raw_path:
        raise ValueError(
            f"{component_id}: {field} must be relative to the component root, not a repo path"
        )
    candidate = (component_root / raw_path).resolve()
    try:
        candidate.relative_to(repo_root)
    except ValueError as exc:
        raise ValueError(f"{component_id}: {field} escapes the repository root") from exc
    return candidate


def _validate_string_array(value: Any, field: str, component_id: str) -> list[str]:
    if not isinstance(value, list) or not value:
        raise ValueError(f"{component_id}: {field} must be a non-empty array")
    normalized: list[str] = []
    for index, item in enumerate(value):
        normalized.append(_require_string(item, f"{field}[{index}]", component_id))
    return normalized


def _validate_component(
    repo_root: Path, component: dict[str, Any], seen_ids: set[str], seen_paths: set[str]
) -> str:
    component_id = _require_string(component.get("id"), "id", "<unknown>")
    if not ID_PATTERN.fullmatch(component_id):
        raise ValueError(f"{component_id}: id must be lowercase kebab-case")
    if component_id in seen_ids:
        raise ValueError(f"{component_id}: duplicate id")
    seen_ids.add(component_id)

    kind = _require_string(component.get("kind"), "kind", component_id)
    if kind not in ALLOWED_KINDS:
        raise ValueError(f"{component_id}: kind must be one of {sorted(ALLOWED_KINDS)}")

    classification = _require_string(component.get("classification"), "classification", component_id)
    if classification not in ALLOWED_CLASSIFICATIONS:
        raise ValueError(
            f"{component_id}: classification must be one of {sorted(ALLOWED_CLASSIFICATIONS)}"
        )

    language = _require_string(component.get("language"), "language", component_id)
    if language not in LANGUAGE_TO_PACKAGE_MANAGERS:
        raise ValueError(f"{component_id}: unsupported language {language!r}")

    package_manager = _require_string(component.get("packageManager"), "packageManager", component_id)
    if package_manager not in ALLOWED_PACKAGE_MANAGERS:
        raise ValueError(
            f"{component_id}: packageManager must be one of {sorted(ALLOWED_PACKAGE_MANAGERS)}"
        )
    if package_manager not in LANGUAGE_TO_PACKAGE_MANAGERS[language]:
        raise ValueError(
            f"{component_id}: packageManager {package_manager!r} is not valid for language {language!r}"
        )

    path_value = _require_string(component.get("path"), "path", component_id)
    if path_value in seen_paths:
        raise ValueError(f"{component_id}: duplicate path")
    seen_paths.add(path_value)
    component_root = _resolve_repo_relative(repo_root, path_value, "path", component_id)
    if not component_root.is_dir():
        raise ValueError(f"{component_id}: path does not exist or is not a directory: {path_value}")

    for field in ("runtimeRole", "ownerArea"):
        _require_string(component.get(field), field, component_id)

    for field in LOCAL_FILE_FIELDS:
        if field not in component:
            if field == "packageManifest":
                raise ValueError(f"{component_id}: packageManifest is required")
            continue
        file_path = _resolve_component_relative(
            repo_root, component_root, component[field], field, component_id
        )
        if not file_path.is_file():
            raise ValueError(f"{component_id}: {field} does not exist: {component[field]}")

    if "schemas" in component:
        for schema_path in _validate_string_array(component["schemas"], "schemas", component_id):
            resolved = _resolve_repo_relative(repo_root, schema_path, "schemas", component_id)
            if not resolved.is_file():
                raise ValueError(f"{component_id}: schema does not exist: {schema_path}")

    if kind == "library":
        if "defaultPort" in component:
            raise ValueError(f"{component_id}: libraries must not declare defaultPort")
    elif "defaultPort" in component:
        default_port = component["defaultPort"]
        if not isinstance(default_port, int) or isinstance(default_port, bool):
            raise ValueError(f"{component_id}: defaultPort must be an integer")
        if default_port < 1 or default_port > 65535:
            raise ValueError(f"{component_id}: defaultPort must be between 1 and 65535")

    _validate_string_array(component.get("releaseGateParticipation"), "releaseGateParticipation", component_id)

    for field in COMMAND_FIELDS:
        if field in component:
            _require_string(component[field], field, component_id)

    return classification


def validate_catalog(catalog_path: Path, repo_root: Path) -> None:
    catalog = _load_json(catalog_path)
    schema_version = catalog.get("schemaVersion")
    if schema_version != 1:
        raise ValueError(f"schemaVersion must be 1, got {schema_version!r}")

    components = catalog.get("components")
    if not isinstance(components, list) or not components:
        raise ValueError("components must be a non-empty array")

    seen_ids: set[str] = set()
    seen_paths: set[str] = set()
    for index, component in enumerate(components):
        if not isinstance(component, dict):
            raise ValueError(f"components[{index}] must be an object")
        _validate_component(repo_root, component, seen_ids, seen_paths)

    if seen_ids != REQUIRED_COMPONENT_IDS:
        missing = sorted(REQUIRED_COMPONENT_IDS - seen_ids)
        unexpected = sorted(seen_ids - REQUIRED_COMPONENT_IDS)
        details: list[str] = []
        if missing:
            details.append(f"missing ids: {', '.join(missing)}")
        if unexpected:
            details.append(f"unexpected ids: {', '.join(unexpected)}")
        raise ValueError("catalog coverage mismatch; " + "; ".join(details))

    for component in components:
        component_id = component["id"]
        expected_classification = "reference" if component_id in REFERENCE_COMPONENT_IDS else "product"
        if component["classification"] != expected_classification:
            raise ValueError(
                f"{component_id}: classification must be {expected_classification!r} for Issue #323 coverage"
            )


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--catalog",
        default=str(_default_repo_root() / "config" / "service-catalog.json"),
        help="Path to the catalog JSON file.",
    )
    parser.add_argument(
        "--repo-root",
        default=str(_default_repo_root()),
        help="Repository root used for path validation.",
    )
    parser.add_argument(
        "--worktree",
        action="store_true",
        help="Compatibility flag for repository validation scripts.",
    )
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    catalog_path = Path(args.catalog).resolve()
    repo_root = Path(args.repo_root).resolve()
    try:
        validate_catalog(catalog_path, repo_root)
    except Exception as exc:  # pragma: no cover - exercised via CLI
        print(f"service catalog validation failed: {exc}", file=sys.stderr)
        return 1
    try:
        display_path = str(catalog_path.relative_to(repo_root))
    except ValueError:
        display_path = str(catalog_path)
    print(f"service catalog ok: {display_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

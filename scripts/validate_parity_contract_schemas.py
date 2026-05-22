#!/usr/bin/env python3
"""Validate the parity contract schema files added for Issue #351.

This gate is intentionally stdlib-only so it can run anywhere the repository
already runs Python checks. It validates both the schema documents themselves
and representative positive fixtures with a constrained JSON Schema subset plus
schema-specific semantic rules.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any


SCHEMA_FILES = {
    "parity-run-v0": "schemas/parity-run-v0.json",
    "parity-execution-result-v0": "schemas/parity-execution-result-v0.json",
    "parity-build-result-v0": "schemas/parity-build-result-v0.json",
    "parity-comparison-result-v0": "schemas/parity-comparison-result-v0.json",
    "repair-diagnosis-v0": "schemas/repair-diagnosis-v0.json",
    "patch-proposal-v0": "schemas/patch-proposal-v0.json",
}

_SUPPORTED_TYPES = {
    "string": (str,),
    "integer": (int,),
    "number": (int, float),
    "boolean": (bool,),
    "object": (dict,),
    "array": (list, tuple),
    "null": (type(None),),
}

_KNOWN_KEYWORDS = frozenset(
    {
        "$schema",
        "$id",
        "title",
        "description",
        "type",
        "required",
        "properties",
        "additionalProperties",
        "items",
        "enum",
        "const",
        "minLength",
        "maxLength",
        "minItems",
        "minimum",
        "maximum",
        "pattern",
        "format",
        "$ref",
        "$defs",
        "allOf",
        "if",
        "then",
    }
)

_DATE_TIME_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)


class ContractValidationError(Exception):
    """Raised when a payload or schema violates the contract rules."""

    def __init__(self, schema_name: str, errors: list[str]) -> None:
        self.schema_name = schema_name
        self.errors = errors
        super().__init__(f"{schema_name}: {'; '.join(errors)}")


class UnsupportedSchemaFeatureError(Exception):
    """Raised when a schema uses unsupported JSON Schema features."""


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _load_schema(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ContractValidationError(path.name, ["top-level schema value must be an object"])
    return data


def load_schemas() -> dict[str, dict[str, Any]]:
    root = _repo_root()
    return {name: _load_schema(root / rel) for name, rel in SCHEMA_FILES.items()}


def _validate_schema_metadata(path: Path, schema: dict[str, Any]) -> None:
    errors: list[str] = []
    expected_id = f"https://oscharko.dev/c2c/schemas/{path.name}"
    if schema.get("$schema") != "https://json-schema.org/draft/2020-12/schema":
        errors.append("unexpected $schema value")
    if schema.get("$id") != expected_id:
        errors.append(f"unexpected $id value: {schema.get('$id')!r}")
    if schema.get("type") != "object":
        errors.append("top-level type must be object")
    if schema.get("additionalProperties") is not False:
        errors.append("top-level additionalProperties must be false")

    properties = schema.get("properties")
    required = schema.get("required")
    if not isinstance(properties, dict) or not properties:
        errors.append("top-level properties must be a non-empty object")
    if not isinstance(required, list) or "schemaVersion" not in required:
        errors.append("schemaVersion must be required")

    version = properties.get("schemaVersion") if isinstance(properties, dict) else None
    if not isinstance(version, dict) or version.get("const") != "v0":
        errors.append("schemaVersion must be pinned to v0")

    if errors:
        raise ContractValidationError(path.name, errors)


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value: Any) -> bool:
    return (isinstance(value, int) or isinstance(value, float)) and not isinstance(value, bool)


def _pytype(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, dict):
        return "object"
    if isinstance(value, (list, tuple)):
        return "array"
    return type(value).__name__


def _check_keywords(node: dict[str, Any], where: str) -> None:
    unknown = set(node.keys()) - _KNOWN_KEYWORDS
    if unknown:
        raise UnsupportedSchemaFeatureError(
            f"schema at {where} uses unsupported keyword(s): {sorted(unknown)}"
        )


def _resolve_ref(ref: str, schema_doc: dict[str, Any]) -> dict[str, Any]:
    if not ref.startswith("#/$defs/"):
        raise UnsupportedSchemaFeatureError(f"unsupported $ref form: {ref!r}")
    key = ref[len("#/$defs/") :]
    defs = schema_doc.get("$defs") or {}
    value = defs.get(key)
    if not isinstance(value, dict):
        raise UnsupportedSchemaFeatureError(f"unresolved $ref: {ref!r}")
    return value


def _matches_expected_type(payload: Any, type_name: str) -> bool:
    if type_name == "integer":
        return _is_int(payload)
    if type_name == "number":
        return _is_number(payload)
    if type_name == "boolean":
        return isinstance(payload, bool)
    return isinstance(payload, _SUPPORTED_TYPES[type_name])


def _validate_node(
    payload: Any,
    node: dict[str, Any],
    schema_doc: dict[str, Any],
    path: str,
    errors: list[str],
) -> None:
    if "$ref" in node:
        _validate_node(payload, _resolve_ref(node["$ref"], schema_doc), schema_doc, path, errors)
        return

    _check_keywords(node, path or "$")

    type_value = node.get("type")
    if type_value is not None:
        type_names = [type_value] if isinstance(type_value, str) else list(type_value)
        if not type_names or not all(isinstance(name, str) for name in type_names):
            raise UnsupportedSchemaFeatureError(f"schema at {path or '$'} uses invalid type form")
        if any(name not in _SUPPORTED_TYPES for name in type_names):
            raise UnsupportedSchemaFeatureError(
                f"schema at {path or '$'} uses unsupported type(s): {type_names!r}"
            )
        if not any(_matches_expected_type(payload, name) for name in type_names):
            errors.append(f"{path or '$'}: expected {type_names!r}, got {_pytype(payload)}")
            return

    if "const" in node and payload != node["const"]:
        errors.append(f"{path or '$'}: must equal {node['const']!r}, got {payload!r}")
        return

    if "enum" in node and payload not in node["enum"]:
        errors.append(f"{path or '$'}: must be one of {node['enum']!r}, got {payload!r}")
        return

    if isinstance(payload, str):
        if "minLength" in node and len(payload) < node["minLength"]:
            errors.append(f"{path or '$'}: minLength {node['minLength']} not met")
        if "maxLength" in node and len(payload) > node["maxLength"]:
            errors.append(f"{path or '$'}: maxLength {node['maxLength']} exceeded")
        if "pattern" in node and not re.search(node["pattern"], payload):
            errors.append(f"{path or '$'}: does not match pattern {node['pattern']!r}")
        if node.get("format") == "date-time" and not _DATE_TIME_RE.match(payload):
            errors.append(f"{path or '$'}: not a valid RFC 3339 date-time")

    if _is_number(payload):
        if "minimum" in node and payload < node["minimum"]:
            errors.append(f"{path or '$'}: minimum {node['minimum']} not met")
        if "maximum" in node and payload > node["maximum"]:
            errors.append(f"{path or '$'}: maximum {node['maximum']} exceeded")

    if isinstance(payload, dict):
        required = node.get("required") or []
        for key in required:
            if key not in payload:
                errors.append(f"{path or '$'}: missing required field {key!r}")
        properties = node.get("properties") or {}
        for key, value in payload.items():
            child_path = f"{path}.{key}" if path else key
            if key in properties:
                _validate_node(value, properties[key], schema_doc, child_path, errors)
            elif node.get("additionalProperties") is False:
                errors.append(f"{path or '$'}: unexpected field {key!r}")

    if isinstance(payload, (list, tuple)):
        if "minItems" in node and len(payload) < node["minItems"]:
            errors.append(f"{path or '$'}: minItems {node['minItems']} not met")
        item_schema = node.get("items")
        if item_schema is not None:
            for idx, item in enumerate(payload):
                _validate_node(item, item_schema, schema_doc, f"{path}[{idx}]", errors)

    if "allOf" in node:
        for entry in node["allOf"]:
            _apply_conditional(payload, entry, schema_doc, path, errors)


def _apply_conditional(
    payload: Any,
    entry: dict[str, Any],
    schema_doc: dict[str, Any],
    path: str,
    errors: list[str],
) -> None:
    if "if" not in entry:
        _validate_node(payload, entry, schema_doc, path, errors)
        return
    branch_errors: list[str] = []
    _validate_node(payload, entry["if"], schema_doc, path, branch_errors)
    if not branch_errors and "then" in entry:
        _validate_node(payload, entry["then"], schema_doc, path, errors)


def validate_payload(schema_name: str, payload: Any, schemas: dict[str, dict[str, Any]] | None = None) -> None:
    all_schemas = load_schemas() if schemas is None else schemas
    schema_doc = all_schemas[schema_name]
    errors: list[str] = []
    _validate_node(payload, schema_doc, schema_doc, "", errors)
    errors.extend(_validate_semantics(schema_name, payload))
    errors.extend(_find_secret_like_values(payload))
    if errors:
        raise ContractValidationError(schema_name, errors)


def _validate_semantics(schema_name: str, payload: Any) -> list[str]:
    errors: list[str] = []

    if schema_name == "parity-run-v0":
        status = payload.get("status")
        terminal_statuses = {"passed", "failed", "blocked", "cancelled"}
        if status in terminal_statuses and "completedAt" not in payload:
            errors.append("terminal parity runs must include completedAt")
        if status == "failed" and not any(
            key in payload
            for key in ("buildResultRef", "executionResultRef", "comparisonResultRef", "repairDiagnosisRef")
        ):
            errors.append("failed parity runs must include proof of failure via result or diagnosis references")

    if schema_name == "parity-execution-result-v0":
        status = payload.get("status")
        timed_out = payload.get("timedOut")
        if status == "timed_out" and timed_out is not True:
            errors.append("timed_out executions must set timedOut=true")
        if timed_out is True and status != "timed_out":
            errors.append("timedOut=true requires status='timed_out'")

    if schema_name == "parity-comparison-result-v0":
        status = payload.get("status")
        mismatch = payload.get("mismatchClassification")
        if status == "passed" and mismatch != "none":
            errors.append("passed comparisons must use mismatchClassification='none'")
        if status == "failed" and mismatch == "none":
            errors.append("failed comparisons must classify the mismatch")

    if schema_name == "patch-proposal-v0":
        approval_state = payload.get("approvalState")
        application_state = payload.get("applicationState")
        approval = payload.get("developerApproval") or {}
        approved_patch = approval.get("approvedPatchSha256")
        patch_sha = payload.get("patchSha256")
        files = payload.get("files") or []

        if approval_state == "approved" and approved_patch != patch_sha:
            errors.append("approved proposals must bind developerApproval.approvedPatchSha256 to patchSha256")
        if application_state == "applied":
            if approval_state != "approved":
                errors.append("applied proposals require approvalState='approved'")
            if approved_patch != patch_sha:
                errors.append("applied proposals must bind the approved patch hash to patchSha256")

        content_hash = _canonical_patch_hash(files)
        if content_hash is not None and patch_sha != content_hash:
            errors.append("patchSha256 must match the canonical hash of the reviewable patch content")

        for index, file_change in enumerate(files):
            path = file_change.get("path")
            if isinstance(path, str):
                if path.startswith("/") or "\\" in path or "/../" in f"/{path}/" or path.startswith("../"):
                    errors.append(f"files[{index}].path must stay relative to the generated candidate root")
            if "diff" not in file_change and "diffRef" not in file_change:
                errors.append(f"files[{index}] must include either diff or diffRef")
    return errors


_SECRET_VALUE_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("bearer token", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{16,}")),
    ("provider secret token", re.compile(r"\bsk[-_](?:live|test)?[-_A-Za-z0-9]{16,}\b")),
    ("aws access key id", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("github token", re.compile(r"\b(?:gh[pous]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b")),
    (
        "credential assignment",
        re.compile(
            r"(?i)\b(?:api[_-]?key|secret[_-]?access[_-]?key|access[_-]?token|"
            r"refresh[_-]?token|password|authorization)\s*[:=]\s*['\"]?[A-Za-z0-9._~+/=-]{12,}"
        ),
    ),
)


def _find_secret_like_values(payload: Any, path: str = "") -> list[str]:
    errors: list[str] = []
    if isinstance(payload, dict):
        for key, value in payload.items():
            child_path = f"{path}.{key}" if path else key
            errors.extend(_find_secret_like_values(value, child_path))
        return errors
    if isinstance(payload, (list, tuple)):
        for index, value in enumerate(payload):
            errors.extend(_find_secret_like_values(value, f"{path}[{index}]"))
        return errors
    if isinstance(payload, str):
        for label, pattern in _SECRET_VALUE_PATTERNS:
            if pattern.search(payload):
                errors.append(f"{path or '$'} contains secret-like {label} content")
    return errors


def _canonical_patch_hash(files: list[dict[str, Any]]) -> str | None:
    if not files:
        return None
    canonical_files: list[dict[str, Any]] = []
    for file_change in files:
        canonical_entry: dict[str, Any] = {
            "path": file_change.get("path"),
            "changeType": file_change.get("changeType"),
            "beforeSha256": file_change.get("beforeSha256"),
            "afterSha256": file_change.get("afterSha256"),
        }
        if "diff" in file_change:
            canonical_entry["diff"] = file_change["diff"]
        elif "diffRef" in file_change:
            diff_ref = file_change["diffRef"]
            if isinstance(diff_ref, dict):
                canonical_entry["diffRef"] = {
                    "uri": diff_ref.get("uri"),
                    "sha256": diff_ref.get("sha256"),
                    "byteSize": diff_ref.get("byteSize"),
                }
        canonical_files.append(canonical_entry)
    encoded = json.dumps(canonical_files, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _artifact_ref(uri: str, kind: str) -> dict[str, Any]:
    return {
        "uri": uri,
        "sha256": "a" * 64,
        "byteSize": 128,
        "mimeType": "application/json",
        "kind": kind,
    }


def sample_payloads() -> dict[str, dict[str, Any]]:
    now = "2026-05-20T12:00:00Z"
    earlier = "2026-05-20T11:55:00Z"
    samples = {
        "parity-run-v0": {
            "schemaVersion": "v0",
            "runId": "parity-run-1",
            "workflowId": "w0-4-parity",
            "trustCaseId": "trust-case-hello-world",
            "executionMode": "parity",
            "status": "passed",
            "sourceArtifactRef": _artifact_ref("urn:source", "source-cobol"),
            "generatedArtifactRef": _artifact_ref("urn:generated", "generated-java"),
            "referenceArtifactRef": _artifact_ref("urn:reference", "reference-output"),
            "sourceRevisionRef": _artifact_ref("urn:source-rev", "source-revision"),
            "currentHeadRef": _artifact_ref("urn:head", "git-head"),
            "buildResultRef": _artifact_ref("urn:build", "parity-build-result"),
            "executionResultRef": _artifact_ref("urn:execution", "parity-execution-result"),
            "comparisonResultRef": _artifact_ref("urn:comparison", "parity-comparison-result"),
            "evidenceRefs": [_artifact_ref("urn:evidence", "evidence-pack")],
            "createdAt": earlier,
            "updatedAt": now,
            "completedAt": now,
        },
        "parity-execution-result-v0": {
            "schemaVersion": "v0",
            "executionId": "exec-1",
            "runId": "parity-run-1",
            "workflowId": "w0-4-parity",
            "executionSurface": "generated-java",
            "command": "java -jar generated.jar",
            "status": "passed",
            "exitCode": 0,
            "timedOut": False,
            "stdoutRef": _artifact_ref("urn:stdout", "stdout"),
            "stderrRef": _artifact_ref("urn:stderr", "stderr"),
            "normalizedOutputRef": _artifact_ref("urn:normalized", "normalized-output"),
            "diagnostics": [],
            "createdAt": now,
        },
        "parity-build-result-v0": {
            "schemaVersion": "v0",
            "buildId": "build-1",
            "runId": "parity-run-1",
            "workflowId": "w0-4-parity",
            "buildMode": "generated-java",
            "command": "mvn -q test",
            "status": "failed",
            "inputArtifactRef": _artifact_ref("urn:generated", "generated-java"),
            "buildOutputRef": _artifact_ref("urn:build-output", "build-output"),
            "logRef": _artifact_ref("urn:build-log", "build-log"),
            "diagnostics": [
                {
                    "filePath": "src/main/java/com/example/App.java",
                    "line": 12,
                    "column": 8,
                    "severity": "error",
                    "message": "cannot find symbol",
                    "rawLogRef": _artifact_ref("urn:build-log-line", "build-log"),
                }
            ],
            "createdAt": now,
        },
        "parity-comparison-result-v0": {
            "schemaVersion": "v0",
            "comparisonId": "comparison-1",
            "runId": "parity-run-1",
            "workflowId": "w0-4-parity",
            "status": "failed",
            "comparisonPolicyVersion": "v0",
            "sourceNormalizedRef": _artifact_ref("urn:source-normalized", "normalized-output"),
            "targetNormalizedRef": _artifact_ref("urn:target-normalized", "normalized-output"),
            "diffSummary": "Target output diverged on one normalized line.",
            "mismatchClassification": "content",
            "createdAt": now,
        },
        "repair-diagnosis-v0": {
            "schemaVersion": "v0",
            "diagnosisId": "diagnosis-1",
            "runId": "parity-run-1",
            "workflowId": "w0-4-parity",
            "comparisonResultRef": _artifact_ref("urn:comparison", "parity-comparison-result"),
            "sourceRevisionRef": _artifact_ref("urn:source-rev", "source-revision"),
            "currentHeadRef": _artifact_ref("urn:head", "git-head"),
            "failureClass": "comparison_mismatch",
            "scopeClass": "generated_code",
            "likelyRootCause": "The generated DISPLAY formatting omitted a trailing sign.",
            "confidence": {"level": "high", "basis": "Deterministic comparison and build logs agree."},
            "recommendedNextAction": "repair_generated_code",
            "evidenceRefs": [_artifact_ref("urn:evidence", "evidence-pack")],
            "createdAt": now,
        },
        "patch-proposal-v0": {
            "schemaVersion": "v0",
            "proposalId": "proposal-1",
            "runId": "parity-run-1",
            "workflowId": "w0-4-parity",
            "diagnosisId": "diagnosis-1",
            "proposedBy": "verification-repair-agent",
            "patchSha256": "f" * 64,
            "applicationState": "sandbox_applied",
            "approvalState": "pending",
            "files": [
                {
                    "path": "src/main/java/com/example/App.java",
                    "changeType": "modify",
                    "beforeSha256": "c" * 64,
                    "afterSha256": "d" * 64,
                    "diff": "@@ -1,1 +1,1 @@\n-return old;\n+return updated;",
                }
            ],
            "sourceRevisionRef": _artifact_ref("urn:source-rev", "source-revision"),
            "currentHeadRef": _artifact_ref("urn:head", "git-head"),
            "reviewedContextRef": _artifact_ref("urn:reviewed-context", "repair-context-package"),
            "sandboxCandidateRef": _artifact_ref(
                "urn:sandbox-candidate",
                "manual-compile-repair-sandbox-project-manifest",
            ),
            "sandboxBuildTestResultRef": _artifact_ref(
                "urn:sandbox-build-test-result",
                "manual-compile-repair-sandbox-build-test",
            ),
            "evidenceRefs": [_artifact_ref("urn:evidence", "evidence-pack")],
            "createdAt": earlier,
            "sandboxAppliedAt": now,
        },
    }
    samples["patch-proposal-v0"] = _with_computed_patch_hash(samples["patch-proposal-v0"])
    return samples


def _with_computed_patch_hash(payload: dict[str, Any]) -> dict[str, Any]:
    patched = json.loads(json.dumps(payload))
    patch_sha = _canonical_patch_hash(patched["files"])
    patched["patchSha256"] = patch_sha
    approval = patched.get("developerApproval")
    if isinstance(approval, dict):
        approval["approvedPatchSha256"] = patch_sha
    return patched


def validate_contract_schemas() -> None:
    schemas = load_schemas()
    root = _repo_root()
    for name, rel in SCHEMA_FILES.items():
        _validate_schema_metadata(root / rel, schemas[name])
    for name, payload in sample_payloads().items():
        validate_payload(name, payload, schemas)


def main() -> int:
    try:
        validate_contract_schemas()
    except (ContractValidationError, UnsupportedSchemaFeatureError, FileNotFoundError, json.JSONDecodeError) as exc:
        print(f"validate_parity_contract_schemas.py: {exc}", file=sys.stderr)
        return 1
    print("Validated parity contract schemas.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

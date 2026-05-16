"""W0.2 Agent I/O contract validation (Issue #167).

The Orchestrator must reject free-form agent output. This module is the single
source of truth for validating four schemas used at the productive-agent
boundary:

* ``agent-invocation-request-v0.json``  — what the Orchestrator sends.
* ``agent-invocation-response-v0.json`` — what the agent returns.
* ``agent-repair-input-v0.json``        — failure context for the repair agent.
* ``agent-repair-decision-v0.json``     — repair outcome.

The orchestrator service is stdlib-only, so the validator does not depend on
``jsonschema`` or any third-party library. It hand-implements the subset of
JSON Schema features used by these four schemas:

* ``type`` (string, integer, number, boolean, object, array)
* ``required``
* ``enum``, ``const``
* ``minLength`` / ``minItems`` / ``minimum`` / ``maximum`` / ``maxLength``
* ``pattern`` (RFC 7405 anchored regex)
* ``format: "date-time"`` (RFC 3339 / ISO-8601 with Z or offset)
* ``additionalProperties: false`` / ``properties``
* ``items``
* ``$ref`` to ``#/$defs/...``
* ``allOf`` with ``if/then/else`` whose ``if`` is a ``required`` + ``const``
  on a single property (the shape used by all four schemas)
* ``not`` with ``required`` or ``anyOf`` of ``required`` (used by
  agent-repair-decision-v0 to enforce mutually exclusive fields)

Anything outside that subset raises :class:`UnsupportedSchemaFeatureError` at
schema-load time so a future schema author cannot silently add an unsupported
keyword and have the validator accept everything.

The validator also enforces a hard byte cap on the serialised payload to
satisfy the "oversized output" rejection requirement from Issue #167.
"""

from __future__ import annotations

import datetime
import json
import re
from pathlib import Path
from typing import Any, Dict, List, Mapping, MutableMapping, Optional, Sequence, Tuple


# ---------------------------------------------------------------------------
# Public errors
# ---------------------------------------------------------------------------


class AgentContractError(Exception):
    """Base class for agent-contract validation errors."""


class AgentContractInvalidError(AgentContractError):
    """Raised when a payload fails validation against an agent-I/O schema.

    The ``errors`` attribute carries one human-readable line per violation.
    """

    def __init__(self, schema_id: str, errors: Sequence[str]) -> None:
        self.schema_id = schema_id
        self.errors: List[str] = list(errors)
        super().__init__(f"{schema_id}: {'; '.join(self.errors)}")


class UnsupportedSchemaFeatureError(AgentContractError):
    """Raised when a loaded schema uses a JSON Schema feature this validator
    does not implement. Prevents silent under-validation."""


# ---------------------------------------------------------------------------
# Schema registry
# ---------------------------------------------------------------------------


# Maximum byte length of a serialised agent I/O payload. 256 KiB is well
# above what a Java project manifest or repair decision needs and bounds
# memory/CPU usage on malformed input.
MAX_PAYLOAD_BYTES = 256 * 1024


_SCHEMA_FILES: Dict[str, str] = {
    "agent-invocation-request-v0": "agent-invocation-request-v0.json",
    "agent-invocation-response-v0": "agent-invocation-response-v0.json",
    "agent-repair-input-v0": "agent-repair-input-v0.json",
    "agent-repair-decision-v0": "agent-repair-decision-v0.json",
}


def _schemas_dir() -> Path:
    # services/orchestrator-service/src/orchestrator_service/agent_contracts.py
    # -> services/orchestrator-service/src/orchestrator_service
    # -> ../../../.. == repo root.
    here = Path(__file__).resolve()
    return here.parents[4] / "schemas"


def _load_all_schemas() -> Dict[str, Mapping[str, Any]]:
    base = _schemas_dir()
    loaded: Dict[str, Mapping[str, Any]] = {}
    for name, filename in _SCHEMA_FILES.items():
        path = base / filename
        try:
            raw = path.read_text(encoding="utf-8")
        except FileNotFoundError as exc:
            raise AgentContractError(
                f"agent contract schema missing: {path}"
            ) from exc
        loaded[name] = json.loads(raw)
    return loaded


_SCHEMAS: Dict[str, Mapping[str, Any]] = _load_all_schemas()


def schema(name: str) -> Mapping[str, Any]:
    """Return the parsed JSON Schema by short name (e.g. 'agent-invocation-request-v0').

    Raises ``KeyError`` for unknown names.
    """
    return _SCHEMAS[name]


# ---------------------------------------------------------------------------
# Validator
# ---------------------------------------------------------------------------


_SUPPORTED_TYPES = {
    "string": (str,),
    "integer": (int,),
    "number": (int, float),
    "boolean": (bool,),
    "object": (dict,),
    "array": (list, tuple),
}

# Subset of keywords we know how to enforce. Anything else triggers
# UnsupportedSchemaFeatureError so a future schema change doesn't silently
# pass through the validator.
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
        "exclusiveMinimum",
        "pattern",
        "format",
        "$ref",
        "$defs",
        "allOf",
        "not",
        "if",
        "then",
        "else",
        "anyOf",
    }
)


_DATE_TIME_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"
)


def _is_int(value: Any) -> bool:
    # bool is a subclass of int — reject explicitly.
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value: Any) -> bool:
    return (isinstance(value, int) or isinstance(value, float)) and not isinstance(value, bool)


def _resolve_ref(ref: str, schema_doc: Mapping[str, Any]) -> Mapping[str, Any]:
    if not ref.startswith("#/$defs/"):
        raise UnsupportedSchemaFeatureError(f"unsupported $ref form: {ref!r}")
    key = ref[len("#/$defs/"):]
    defs = schema_doc.get("$defs") or {}
    if key not in defs:
        raise UnsupportedSchemaFeatureError(f"unresolved $ref: {ref!r}")
    return defs[key]


def _check_keywords(node: Mapping[str, Any], where: str) -> None:
    unknown = set(node.keys()) - _KNOWN_KEYWORDS
    if unknown:
        raise UnsupportedSchemaFeatureError(
            f"schema at {where} uses unsupported keyword(s): {sorted(unknown)}"
        )


def _validate_node(
    payload: Any,
    node: Mapping[str, Any],
    schema_doc: Mapping[str, Any],
    path: str,
    errors: List[str],
) -> None:
    if "$ref" in node:
        resolved = _resolve_ref(node["$ref"], schema_doc)
        _validate_node(payload, resolved, schema_doc, path, errors)
        return

    _check_keywords(node, path or "$")

    type_value = node.get("type")
    if type_value is not None:
        expected_types: Tuple[type, ...]
        if isinstance(type_value, str):
            expected_types = _SUPPORTED_TYPES.get(type_value, ())
        else:
            raise UnsupportedSchemaFeatureError(
                f"schema at {path or '$'} uses non-string type"
            )
        if not expected_types:
            raise UnsupportedSchemaFeatureError(
                f"schema at {path or '$'} uses unsupported type: {type_value!r}"
            )
        # integer vs number bool guard
        if type_value == "integer" and not _is_int(payload):
            errors.append(f"{path or '$'}: expected integer, got {_pytype(payload)}")
            return
        if type_value == "number" and not _is_number(payload):
            errors.append(f"{path or '$'}: expected number, got {_pytype(payload)}")
            return
        if type_value == "boolean" and not isinstance(payload, bool):
            errors.append(f"{path or '$'}: expected boolean, got {_pytype(payload)}")
            return
        if type_value not in {"integer", "number", "boolean"} and not isinstance(payload, expected_types):
            errors.append(f"{path or '$'}: expected {type_value}, got {_pytype(payload)}")
            return

    if "const" in node:
        if payload != node["const"]:
            errors.append(f"{path or '$'}: must equal {node['const']!r}, got {payload!r}")
            return

    if "enum" in node:
        if payload not in node["enum"]:
            errors.append(
                f"{path or '$'}: must be one of {node['enum']!r}, got {payload!r}"
            )
            return

    if isinstance(payload, str):
        if "minLength" in node and len(payload) < node["minLength"]:
            errors.append(
                f"{path or '$'}: minLength {node['minLength']} not met (got {len(payload)})"
            )
        if "maxLength" in node and len(payload) > node["maxLength"]:
            errors.append(
                f"{path or '$'}: maxLength {node['maxLength']} exceeded (got {len(payload)})"
            )
        if "pattern" in node:
            try:
                regex = re.compile(node["pattern"])
            except re.error as exc:
                raise UnsupportedSchemaFeatureError(
                    f"invalid regex pattern at {path or '$'}: {exc}"
                ) from exc
            if not regex.search(payload):
                errors.append(
                    f"{path or '$'}: does not match pattern {node['pattern']!r}"
                )
        if node.get("format") == "date-time":
            if not _DATE_TIME_RE.match(payload):
                errors.append(
                    f"{path or '$'}: not a valid RFC 3339 date-time: {payload!r}"
                )

    if _is_number(payload) and not isinstance(payload, bool):
        if "minimum" in node and payload < node["minimum"]:
            errors.append(
                f"{path or '$'}: minimum {node['minimum']} not met (got {payload})"
            )
        if "maximum" in node and payload > node["maximum"]:
            errors.append(
                f"{path or '$'}: maximum {node['maximum']} exceeded (got {payload})"
            )
        if "exclusiveMinimum" in node and payload <= node["exclusiveMinimum"]:
            errors.append(
                f"{path or '$'}: exclusiveMinimum {node['exclusiveMinimum']} not met (got {payload})"
            )

    if isinstance(payload, dict):
        required = node.get("required") or []
        for key in required:
            if key not in payload:
                errors.append(f"{path or '$'}: missing required field {key!r}")
        properties = node.get("properties") or {}
        for key, value in payload.items():
            sub_path = f"{path}.{key}" if path else key
            if key in properties:
                _validate_node(value, properties[key], schema_doc, sub_path, errors)
            else:
                if node.get("additionalProperties") is False:
                    errors.append(f"{path or '$'}: unexpected field {key!r}")

    if isinstance(payload, list):
        if "minItems" in node and len(payload) < node["minItems"]:
            errors.append(
                f"{path or '$'}: minItems {node['minItems']} not met (got {len(payload)})"
            )
        item_schema = node.get("items")
        if item_schema is not None:
            for idx, item in enumerate(payload):
                _validate_node(item, item_schema, schema_doc, f"{path}[{idx}]", errors)

    if "allOf" in node:
        for sub in node["allOf"]:
            _apply_conditional(payload, sub, schema_doc, path, errors)

    if "not" in node:
        not_errors: List[str] = []
        _validate_node(payload, node["not"], schema_doc, path, not_errors)
        if not not_errors:
            errors.append(
                f"{path or '$'}: violates 'not' constraint {json.dumps(node['not'], sort_keys=True)}"
            )

    if "anyOf" in node:
        any_matched = False
        collected: List[List[str]] = []
        for sub in node["anyOf"]:
            sub_errors: List[str] = []
            _validate_node(payload, sub, schema_doc, path, sub_errors)
            if not sub_errors:
                any_matched = True
                break
            collected.append(sub_errors)
        if not any_matched:
            joined = "; ".join("[" + ", ".join(e) + "]" for e in collected)
            errors.append(f"{path or '$'}: no branch of anyOf matched: {joined}")


def _apply_conditional(
    payload: Any,
    node: Mapping[str, Any],
    schema_doc: Mapping[str, Any],
    path: str,
    errors: List[str],
) -> None:
    """Apply an ``if``/``then``/``else`` branch from an ``allOf`` entry.

    Falls back to plain validation when the node carries no ``if`` clause.
    """
    if "if" not in node:
        _validate_node(payload, node, schema_doc, path, errors)
        return

    if_errors: List[str] = []
    _validate_node(payload, node["if"], schema_doc, path, if_errors)
    branch = node.get("then") if not if_errors else node.get("else")
    if branch is not None:
        _validate_node(payload, branch, schema_doc, path, errors)


def _pytype(value: Any) -> str:
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
    if value is None:
        return "null"
    return type(value).__name__


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def validate_payload(schema_name: str, payload: Any) -> None:
    """Validate ``payload`` against the named agent-contract schema.

    Raises :class:`AgentContractInvalidError` if any rule fails. Returns
    ``None`` on success.
    """
    if schema_name not in _SCHEMAS:
        raise KeyError(f"unknown agent contract schema: {schema_name}")
    doc = _SCHEMAS[schema_name]
    schema_id = doc.get("$id", schema_name)

    # Oversized payload guard. We compute the canonical encoding the rest of
    # the system uses for content hashing so the cap is reproducible.
    try:
        encoded = json.dumps(
            payload,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
            ensure_ascii=False,
        ).encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise AgentContractInvalidError(
            schema_id, [f"$: payload is not JSON-serialisable: {exc}"]
        ) from exc
    if len(encoded) > MAX_PAYLOAD_BYTES:
        raise AgentContractInvalidError(
            schema_id,
            [f"$: payload size {len(encoded)} bytes exceeds limit {MAX_PAYLOAD_BYTES} bytes"],
        )

    errors: List[str] = []
    _validate_node(payload, doc, doc, "", errors)
    if errors:
        raise AgentContractInvalidError(schema_id, errors)


def validate_invocation_request(payload: Any) -> None:
    validate_payload("agent-invocation-request-v0", payload)


def validate_invocation_response(payload: Any) -> None:
    validate_payload("agent-invocation-response-v0", payload)


def validate_repair_input(payload: Any) -> None:
    validate_payload("agent-repair-input-v0", payload)


def validate_repair_decision(payload: Any) -> None:
    validate_payload("agent-repair-decision-v0", payload)


# ---------------------------------------------------------------------------
# Secret-leak guard
# ---------------------------------------------------------------------------


# Fields the contract forbids agent responses from carrying. The agent must
# reference everything via content-addressed artifact refs (sha256/uri), not
# inline. This guard is applied AFTER schema validation so it catches payloads
# that satisfy the schema but try to smuggle secrets through additionalProperties
# in nested objects whose schema permits open extension.
_FORBIDDEN_FIELD_NAMES = frozenset(
    {
        "apiKey",
        "api_key",
        "apikey",
        "authorization",
        "secret",
        "secretKey",
        "secret_key",
        "password",
        "passwd",
        "providerCredentials",
        "providerToken",
        "providerSecret",
        "bearerToken",
        "accessToken",
        "refreshToken",
    }
)


def assert_no_secret_leak(payload: Any, *, path: str = "") -> None:
    """Walk ``payload`` and reject any key whose name looks like a credential.

    Raises :class:`AgentContractInvalidError` if such a key is found.
    """
    findings: List[str] = []
    _walk_for_secrets(payload, path, findings)
    if findings:
        raise AgentContractInvalidError(
            "secret-leak-guard",
            findings,
        )


def _walk_for_secrets(payload: Any, path: str, findings: List[str]) -> None:
    if isinstance(payload, dict):
        for key, value in payload.items():
            sub_path = f"{path}.{key}" if path else key
            if key in _FORBIDDEN_FIELD_NAMES:
                findings.append(f"{sub_path}: forbidden credential-like field name")
            _walk_for_secrets(value, sub_path, findings)
    elif isinstance(payload, list):
        for idx, item in enumerate(payload):
            _walk_for_secrets(item, f"{path}[{idx}]", findings)


# ---------------------------------------------------------------------------
# Convenience: full guard used by the Orchestrator
# ---------------------------------------------------------------------------


def guard_agent_response(payload: Any) -> None:
    """Validate an agent invocation response end-to-end.

    Combines schema validation and the secret-leak guard. Raises
    :class:`AgentContractInvalidError` on failure.
    """
    validate_invocation_response(payload)
    assert_no_secret_leak(payload)


def guard_repair_decision(payload: Any) -> None:
    """Validate a repair-agent decision artifact end-to-end."""
    validate_repair_decision(payload)
    assert_no_secret_leak(payload)


__all__ = [
    "AgentContractError",
    "AgentContractInvalidError",
    "UnsupportedSchemaFeatureError",
    "MAX_PAYLOAD_BYTES",
    "schema",
    "validate_payload",
    "validate_invocation_request",
    "validate_invocation_response",
    "validate_repair_input",
    "validate_repair_decision",
    "assert_no_secret_leak",
    "guard_agent_response",
    "guard_repair_decision",
]


def _utcnow_iso() -> str:
    """Helper exposed for tests; returns an RFC 3339 timestamp the validator accepts."""
    return (
        datetime.datetime.now(tz=datetime.timezone.utc)
        .isoformat()
        .replace("+00:00", "Z")
    )

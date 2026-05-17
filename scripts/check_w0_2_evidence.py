#!/usr/bin/env python3
"""W0.2 Evidence Pack completeness validator (Issue #175).

Strict validator that re-derives the W0.2 release-gate completeness contract
from a single Evidence Pack manifest file. Used by the W0.2 release gate
script and CI to fail closed when a run is marked successful without the
artifacts the W0.2 contract requires.

This validator is intentionally narrow:

* It does *not* re-validate every field of every referenced artifact. The
  evidence-service is responsible for that. The validator only confirms that
  the manifest declares the artifacts the W0.2 release-gate contract demands
  and that the declarations are mutually consistent.
* It does *not* download or open remote URIs. If the run materialises
  artifacts on a local filesystem path (``file://`` or a relative path
  rooted at the manifest's directory) the validator may open them for
  integrity checks (e.g., that the model-invocation ledger does not embed a
  raw provider key). Other URI schemes are accepted by reference only.
* It does *not* try to repair manifests. A failing check returns a non-zero
  exit code so callers can stop the gate.

Exit codes:
  0 — all checks passed for the requested expectation.
  2 — manifest cannot be opened or parsed.
  3 — one or more required checks failed. Failures are printed to stderr.

Usage:
  scripts/check_w0_2_evidence.py --manifest <path> [--success | --blocked]
                                 [--expect-foundry-invocation]
                                 [--expect-policy-skipped]
                                 [--allow-skipped-model]
                                 [--root <artifact-root>]

  --success                Require completenessStatus=complete and every
                           W0.2 successful-run artifact reference.
  --blocked                Require completenessStatus=blocked or
                           classification=blocked with a failureCode.
                           No Java artifacts may be claimed as final.
  --expect-foundry-invocation
                           Require at least one modelInvocations entry whose
                           status is ``completed`` (i.e., the Model Gateway
                           actually invoked Foundry). Implies --success.
  --expect-policy-skipped  Require the (single) modelInvocations entry to
                           have ``status=skipped`` and policyDecision text
                           that documents the no-model deterministic path.
  --allow-skipped-model    Accept either ``completed`` or ``skipped`` model
                           invocations (the default for --success).
  --root <dir>             Resolve relative artifact URIs / paths under
                           this directory. Defaults to the directory of the
                           manifest.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from collections.abc import Mapping
from typing import Any, Iterable, Sequence


# Closed set of W0.2 failure codes the orchestrator may surface.
W02_FAILURE_CODES = frozenset(
    {
        "unsupported_cobol",
        "parse_failed",
        "semantic_ir_failed",
        "model_gateway_unavailable",
        "model_policy_denied",
        "agent_timeout",
        "agent_contract_invalid",
        "java_generation_failed",
        "java_compile_failed",
        "java_runtime_failed",
        "oracle_mismatch",
        "evidence_incomplete",
        "cancelled",
    }
)

# Secret-shaped substrings that must never appear in any referenced ledger or
# trajectory artifact. The list is intentionally narrow: provider API keys,
# bearer tokens, and the verbatim env-var names the launcher accepts. The
# launcher reads these from the environment but they MUST NOT be written to
# any evidence artifact.
SECRET_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"AZURE_FOUNDRY_API_KEY\s*[:=]\s*[A-Za-z0-9_\-]{8,}"),
    re.compile(r"(?i)bearer\s+[A-Za-z0-9_\-]{16,}"),
    re.compile(r"sk-[A-Za-z0-9]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
)


class CheckFailed(Exception):
    """Raised when a single check fails. Collected by the validator."""


def _emit_failure(failures: list[str], message: str) -> None:
    failures.append(message)


def _is_mapping(value: Any) -> bool:
    return isinstance(value, Mapping)


def _is_seq(value: Any) -> bool:
    return isinstance(value, (list, tuple)) and not isinstance(value, (str, bytes))


def _require(condition: bool, message: str, failures: list[str]) -> bool:
    if not condition:
        _emit_failure(failures, message)
    return condition


def _resolve_uri_to_path(uri: str, root: Path) -> Path | None:
    """Map a manifest URI/path to a local filesystem path under ``root``.

    The W0.2 manifest emits ``file://...``, run-scoped relative paths, or
    absolute paths. Anything that resolves outside ``root`` is treated as
    non-local and skipped.
    """

    candidate: Path | None
    if uri.startswith("file://"):
        candidate = Path(uri[len("file://") :])
    elif uri.startswith(("http://", "https://", "s3://", "gs://", "fixture://")):
        return None
    else:
        candidate = Path(uri)

    if not candidate.is_absolute():
        candidate = (root / candidate).resolve()
    else:
        candidate = candidate.resolve()

    try:
        candidate.relative_to(root.resolve())
    except ValueError:
        # Outside the root — not a local artifact we can open.
        return None
    if not candidate.exists() or not candidate.is_file():
        return None
    return candidate


def _check_artifact_for_secrets(path: Path, failures: list[str]) -> None:
    try:
        with path.open("rb") as handle:
            head = handle.read(1 * 1024 * 1024)  # 1 MiB cap is enough for ledgers
    except OSError as exc:  # pragma: no cover - defensive
        _emit_failure(failures, f"secret-scan: could not read {path}: {exc}")
        return
    try:
        text = head.decode("utf-8")
    except UnicodeDecodeError:
        # Binary artifact — skip.
        return
    for pattern in SECRET_PATTERNS:
        match = pattern.search(text)
        if match:
            _emit_failure(
                failures,
                f"secret-scan: forbidden token shape matched in {path}: {pattern.pattern}",
            )
            return


def _load_manifest(path: Path) -> Mapping[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError as exc:
        raise SystemExit(f"manifest not found: {path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise SystemExit(f"manifest is not valid JSON: {path}: {exc}") from exc
    if not _is_mapping(data):
        raise SystemExit(f"manifest is not a JSON object: {path}")
    return data


def _check_top_level(manifest: Mapping[str, Any], failures: list[str]) -> None:
    _require(
        manifest.get("schemaVersion") == "v0",
        f"schemaVersion must be 'v0', got {manifest.get('schemaVersion')!r}",
        failures,
    )
    _require(
        manifest.get("capability") == "evidence.pack",
        f"capability must be 'evidence.pack', got {manifest.get('capability')!r}",
        failures,
    )
    _require(
        manifest.get("wave") in {"w0", "w0.2"},
        f"wave must be 'w0' or 'w0.2', got {manifest.get('wave')!r}",
        failures,
    )
    pack_id = manifest.get("packId")
    _require(
        isinstance(pack_id, str) and pack_id.startswith("epk-"),
        f"packId must match ^epk-..., got {pack_id!r}",
        failures,
    )
    _require(
        isinstance(manifest.get("runId"), str) and manifest.get("runId"),
        "runId must be a non-empty string",
        failures,
    )


def _check_validation_block(manifest: Mapping[str, Any], expect_ok: bool, failures: list[str]) -> None:
    validation = manifest.get("validation")
    if not _require(_is_mapping(validation), "validation block missing", failures):
        return
    if not isinstance(validation, Mapping):
        return
    if expect_ok:
        _require(
            validation.get("ok") is True,
            f"validation.ok must be true for a successful run, got {validation.get('ok')!r}",
            failures,
        )
        missing = validation.get("missingArtifacts") or []
        _require(
            _is_seq(missing) and len(list(missing)) == 0,
            f"validation.missingArtifacts must be empty for success, got {missing!r}",
            failures,
        )
    # required artifacts list must always be present
    required = validation.get("requiredArtifacts")
    _require(
        _is_seq(required) and len(list(required or [])) > 0,
        f"validation.requiredArtifacts must be a non-empty list, got {required!r}",
        failures,
    )


def _model_invocation_status(entry: Mapping[str, Any]) -> str | None:
    status = entry.get("status")
    return status if isinstance(status, str) else None


def _check_model_invocations(
    invocations: Sequence[Mapping[str, Any]],
    *,
    expect_foundry: bool,
    expect_skipped: bool,
    allow_skipped: bool,
    failures: list[str],
) -> None:
    _require(
        len(invocations) >= 1,
        "artifacts.modelInvocations must declare at least one entry",
        failures,
    )
    statuses = [_model_invocation_status(entry) for entry in invocations if _is_mapping(entry)]
    has_completed = any(status == "completed" for status in statuses)
    has_skipped = any(status == "skipped" for status in statuses)

    if expect_foundry:
        _require(
            has_completed,
            "at least one modelInvocations entry must have status='completed' "
            "for a Foundry-backed run (got statuses: " + ", ".join(map(repr, statuses)) + ")",
            failures,
        )
    if expect_skipped:
        _require(
            has_skipped and not has_completed,
            "modelInvocations must report status='skipped' only for the "
            "deterministic no-model path (got: " + ", ".join(map(repr, statuses)) + ")",
            failures,
        )
    if not expect_foundry and not expect_skipped and not allow_skipped:
        _require(
            has_completed or has_skipped,
            "modelInvocations must report at least one status='completed' or "
            "status='skipped' entry",
            failures,
        )
    # Every entry must reference a ledger.
    for index, entry in enumerate(invocations):
        if not _is_mapping(entry):
            _emit_failure(failures, f"modelInvocations[{index}] is not an object")
            continue
        ledger = entry.get("ledgerRef")
        ok = (
            _is_mapping(ledger)
            and isinstance(ledger.get("uri"), str)
            and isinstance(ledger.get("sha256"), str)
            and len(ledger.get("sha256") or "") == 64
        )
        _require(
            ok,
            f"modelInvocations[{index}].ledgerRef must include uri and sha256",
            failures,
        )


def _check_agent_trajectories(
    trajectories: Sequence[Mapping[str, Any]],
    failures: list[str],
) -> None:
    _require(
        len(trajectories) >= 1,
        "artifacts.agentTrajectories must include at least one entry "
        "(the orchestrator trajectory)",
        failures,
    )
    roles = set()
    for index, entry in enumerate(trajectories):
        if not _is_mapping(entry):
            _emit_failure(failures, f"agentTrajectories[{index}] is not an object")
            continue
        role = entry.get("agentRole")
        if role in {"orchestrator", "transformation", "verification-repair"}:
            roles.add(role)
        else:
            _emit_failure(
                failures,
                f"agentTrajectories[{index}].agentRole must be one of "
                "'orchestrator', 'transformation', 'verification-repair'; "
                f"got {role!r}",
            )
        ledger = entry.get("ledgerRef")
        ok = (
            _is_mapping(ledger)
            and isinstance(ledger.get("uri"), str)
            and isinstance(ledger.get("sha256"), str)
            and len(ledger.get("sha256") or "") == 64
        )
        _require(
            ok,
            f"agentTrajectories[{index}].ledgerRef must include uri and sha256",
            failures,
        )
    _require(
        "orchestrator" in roles,
        "agentTrajectories must include an 'orchestrator' role entry; "
        f"got roles={sorted(roles)!r}",
        failures,
    )


def _check_java_candidates(
    candidates: Sequence[Mapping[str, Any]],
    final_java: Mapping[str, Any] | None,
    failures: list[str],
) -> None:
    _require(
        len(candidates) >= 1,
        "artifacts.generatedJavaArtifacts must include at least one candidate",
        failures,
    )
    selected = None
    for index, entry in enumerate(candidates):
        if not _is_mapping(entry):
            _emit_failure(failures, f"generatedJavaArtifacts[{index}] is not an object")
            continue
        origin = entry.get("origin")
        if origin not in {
            "deterministic-baseline",
            "transformation-agent",
            "verification-repair-agent",
        }:
            _emit_failure(
                failures,
                f"generatedJavaArtifacts[{index}].origin must be one of the W0.2 origins; "
                f"got {origin!r}",
            )
        if entry.get("selected") is True:
            selected = entry
        sha = entry.get("sha256")
        _require(
            isinstance(sha, str) and len(sha) == 64,
            f"generatedJavaArtifacts[{index}].sha256 must be a 64-char hex digest",
            failures,
        )
    if final_java is None:
        _emit_failure(
            failures,
            "artifacts.finalJavaArtifact must be set for a completed W0.2 success run",
        )
        return
    _require(
        _is_mapping(final_java) and isinstance(final_java.get("sha256"), str),
        "artifacts.finalJavaArtifact must be a javaCandidateRef with sha256",
        failures,
    )
    if selected is not None and isinstance(final_java, Mapping):
        _require(
            selected.get("sha256") == final_java.get("sha256"),
            "the selected=true candidate must match finalJavaArtifact by sha256",
            failures,
        )


def _check_oracle(oracle: Mapping[str, Any], failures: list[str]) -> None:
    _require(
        oracle.get("matched") is True,
        f"oracleComparison.matched must be true for a success run, got {oracle.get('matched')!r}",
        failures,
    )
    kind = oracle.get("oracleKind")
    _require(
        kind in {"cobol-runtime", "synthetic", "true-golden-master", "user-provided"},
        f"oracleComparison.oracleKind must identify a real oracle, got {kind!r}",
        failures,
    )
    actual_sha = oracle.get("actualSha256")
    expected_sha = oracle.get("expectedSha256")
    if isinstance(actual_sha, str) and isinstance(expected_sha, str):
        _require(
            actual_sha == expected_sha,
            "oracleComparison: actualSha256 must equal expectedSha256 when matched=true",
            failures,
        )


# Issue #217 (W0.3-6): closed enum sets for the assist-decision lineage. Kept
# in sync with run_contract.ASSIST_* and the BFF AssistDecisionSummary schema.
_ASSIST_DECISION_OUTCOMES = {"assist_required", "assist_not_required"}
_ASSIST_DECISION_REASON_CODES = {
    "semantic_ir_bounded_ambiguity",
    "translation_unsupported_repairable",
    "baseline_open_assumptions",
    "deterministic_candidate_low_confidence",
    "caller_explicit_opt_in",
    "caller_did_not_opt_in",
    "assist_budget_exhausted",
}
_ASSIST_DECISION_AGENT_ROLES = {"transformation_agent"}


def _check_budget_snapshot(
    snapshot: Any,
    *,
    path: str,
    failures: list[str],
) -> None:
    if not _is_mapping(snapshot):
        _emit_failure(failures, f"{path} must be an object with limit/used/remaining")
        return
    limit = snapshot.get("limit")
    used = snapshot.get("used")
    remaining = snapshot.get("remaining")
    for label, value in (("limit", limit), ("used", used), ("remaining", remaining)):
        if not isinstance(value, int) or isinstance(value, bool) or value < 0:
            _emit_failure(failures, f"{path}.{label} must be a non-negative integer, got {value!r}")
            return
    expected_remaining = max(0, int(limit) - int(used))
    _require(
        int(remaining) == expected_remaining,
        f"{path}.remaining must equal max(0, limit - used)",
        failures,
    )


def _check_assist_decision_lineage(decision: Any, failures: list[str]) -> None:
    if not _is_mapping(decision):
        _emit_failure(
            failures,
            "artifacts.assistDecision must be set for a W0.2 success run (Issue #217)",
        )
        return
    outcome = decision.get("outcome")
    _require(
        outcome in _ASSIST_DECISION_OUTCOMES,
        f"artifacts.assistDecision.outcome must be one of {sorted(_ASSIST_DECISION_OUTCOMES)!r}; got {outcome!r}",
        failures,
    )
    reason_code = decision.get("reasonCode")
    _require(
        reason_code in _ASSIST_DECISION_REASON_CODES,
        f"artifacts.assistDecision.reasonCode must be one of the closed W0.3 reason codes; got {reason_code!r}",
        failures,
    )
    decided_at = decision.get("decidedAt")
    _require(
        isinstance(decided_at, str) and decided_at != "",
        f"artifacts.assistDecision.decidedAt must be a non-empty ISO-8601 string; got {decided_at!r}",
        failures,
    )
    selected_role = decision.get("selectedAgentRole")
    if outcome == "assist_required":
        _require(
            selected_role in _ASSIST_DECISION_AGENT_ROLES,
            f"artifacts.assistDecision.selectedAgentRole must be transformation_agent when assist_required; got {selected_role!r}",
            failures,
        )
    else:
        _require(
            selected_role in (None, ""),
            f"artifacts.assistDecision.selectedAgentRole must be absent when assist_not_required; got {selected_role!r}",
            failures,
        )
    if reason_code == "assist_budget_exhausted":
        _require(
            outcome == "assist_not_required",
            "artifacts.assistDecision: assist_budget_exhausted reason requires outcome=assist_not_required",
            failures,
        )


def _check_budget_summary(summary: Any, failures: list[str]) -> None:
    if not _is_mapping(summary):
        _emit_failure(
            failures,
            "artifacts.budgetSummary must be set for a W0.2 success run (Issue #217)",
        )
        return
    for key in ("repair", "assist", "modelInvocation"):
        _check_budget_snapshot(summary.get(key), path=f"artifacts.budgetSummary.{key}", failures=failures)


def _check_success_artifacts(
    manifest: Mapping[str, Any],
    *,
    expect_foundry: bool,
    expect_skipped: bool,
    allow_skipped: bool,
    failures: list[str],
) -> None:
    completeness = manifest.get("completenessStatus")
    _require(
        completeness == "complete",
        f"completenessStatus must be 'complete' for a success run, got {completeness!r}",
        failures,
    )
    classification = manifest.get("classification")
    _require(
        classification in {"success", None},
        f"classification must be 'success' (or absent) for a success run, got {classification!r}",
        failures,
    )
    status = manifest.get("status")
    _require(
        status == "complete",
        f"status must be 'complete' for a success run, got {status!r}",
        failures,
    )
    artifacts = manifest.get("artifacts")
    if not _require(_is_mapping(artifacts), "artifacts block missing", failures):
        return
    if not isinstance(artifacts, Mapping):
        return

    # Required artifact slots per the W0.2 success contract.
    for key in (
        "sourceCobol",
        "sourceMetadata",
        "parseOutput",
        "semanticIr",
        "generatedJava",
        "buildTestResults",
        "harnessEvents",
        "modelInvocations",
    ):
        if key in {"sourceCobol", "buildTestResults", "modelInvocations"}:
            value = artifacts.get(key)
            _require(
                _is_seq(value) and len(list(value or [])) > 0,
                f"artifacts.{key} must be a non-empty list for a success run",
                failures,
            )
        else:
            _require(
                key in artifacts and _is_mapping(artifacts.get(key)),
                f"artifacts.{key} must reference a single artifact for a success run",
                failures,
            )

    runtime_version = artifacts.get("runtimeVersion")
    _require(
        _is_mapping(runtime_version)
        and isinstance(runtime_version.get("id") if isinstance(runtime_version, Mapping) else None, str)
        and bool((runtime_version.get("id") if isinstance(runtime_version, Mapping) else "").strip()),
        f"artifacts.runtimeVersion must declare the Target-Java runtime/version for a success run, got {runtime_version!r}",
        failures,
    )

    invocations = artifacts.get("modelInvocations") or []
    if _is_seq(invocations):
        _check_model_invocations(
            [entry for entry in invocations if _is_mapping(entry)],
            expect_foundry=expect_foundry,
            expect_skipped=expect_skipped,
            allow_skipped=allow_skipped,
            failures=failures,
        )

    trajectories = artifacts.get("agentTrajectories")
    if trajectories is None and _is_mapping(artifacts.get("trajectoryLedger")):
        # The pre-W0.2 manifests use the singular trajectoryLedger. The W0.2
        # release gate requires the plural list; flag missing W0.2 fields.
        _emit_failure(
            failures,
            "artifacts.agentTrajectories must be set for a W0.2 success run; "
            "only the legacy singular trajectoryLedger was found",
        )
    elif _is_seq(trajectories):
        _check_agent_trajectories(
            [entry for entry in trajectories if _is_mapping(entry)],
            failures,
        )
    else:
        _emit_failure(failures, "artifacts.agentTrajectories must be a list for a W0.2 success run")

    candidates = artifacts.get("generatedJavaArtifacts")
    final_java = artifacts.get("finalJavaArtifact")
    if _is_seq(candidates):
        _check_java_candidates(
            [entry for entry in candidates if _is_mapping(entry)],
            final_java if _is_mapping(final_java) else None,
            failures,
        )
    else:
        _emit_failure(
            failures,
            "artifacts.generatedJavaArtifacts must be a list for a W0.2 success run",
        )
    legacy_generated = artifacts.get("generatedJava")
    if _is_mapping(legacy_generated) and _is_mapping(final_java):
        _require(
            legacy_generated.get("sha256") == final_java.get("sha256")
            and legacy_generated.get("uri") == final_java.get("uri"),
            "artifacts.generatedJava must match finalJavaArtifact by uri and sha256",
            failures,
        )

    oracle = artifacts.get("oracleComparison")
    if _is_mapping(oracle):
        _check_oracle(oracle, failures)
    else:
        _emit_failure(failures, "artifacts.oracleComparison must be set for a W0.2 success run")

    # Issue #217 (W0.3-6): the release gate enforces the assist-decision and
    # budget-summary lineage so a green W0.2 run always answers "was AI
    # required?" and "what budget was used?" from the evidence pack alone.
    _check_assist_decision_lineage(artifacts.get("assistDecision"), failures)
    _check_budget_summary(artifacts.get("budgetSummary"), failures)


def _check_blocked_artifacts(manifest: Mapping[str, Any], failures: list[str]) -> None:
    completeness = manifest.get("completenessStatus")
    classification = manifest.get("classification")
    accepted_completeness = {"blocked", "evidence_incomplete"}
    # The Evidence Pack manifest classification enum is
    # ["success", "evidence_incomplete", "blocked", "failed"]. The blocked-path
    # validator accepts any non-success classification: a run that ended in
    # `failed` (e.g., parse_failed) is also a non-success outcome that must
    # not be confused with the success contract.
    accepted_classification = {"blocked", "evidence_incomplete", "failed"}
    accepted = (
        completeness in accepted_completeness
        or classification in accepted_classification
    )
    _require(
        accepted,
        f"a blocked-path run must report completenessStatus in "
        f"{sorted(accepted_completeness)!r} or classification in "
        f"{sorted(accepted_classification)!r}; got completenessStatus="
        f"{completeness!r}, classification={classification!r}",
        failures,
    )
    artifacts = manifest.get("artifacts")
    if _is_mapping(artifacts) and isinstance(artifacts, Mapping):
        legacy_generated = artifacts.get("generatedJava")
        _require(
            legacy_generated in (None, {}),
            "a blocked-path run must not declare artifacts.generatedJava "
            f"(got {legacy_generated!r})",
            failures,
        )
        final_java = artifacts.get("finalJavaArtifact")
        _require(
            final_java in (None, {}),
            "a blocked-path run must not declare a finalJavaArtifact "
            f"(got {final_java!r})",
            failures,
        )
        candidates = artifacts.get("generatedJavaArtifacts") or []
        if _is_seq(candidates):
            selected = [
                entry
                for entry in candidates
                if _is_mapping(entry) and bool(entry.get("selected"))
            ]
            _require(
                not selected,
                "a blocked-path run must not mark any generatedJavaArtifacts entry as selected",
                failures,
            )

        # Issue #217 (W0.3-6): budgetSummary stays mandatory on every W0.2
        # pack — including blocked runs — because the bounded budgets always
        # exist on the contract. assistDecision is conditional: blocked
        # packs that legitimately terminated before the gate fired
        # (no transformation/verification-repair trajectory and no repair
        # attempts) may omit it; once any post-gate signal is present, the
        # decision must be recorded.
        _check_budget_summary(artifacts.get("budgetSummary"), failures)
        decision = artifacts.get("assistDecision")
        gate_fired = _blocked_run_reached_assist_gate(artifacts)
        if decision is None:
            _require(
                not gate_fired,
                "blocked W0.2 pack shows post-gate signals (agentTrajectories or "
                "repairAttempts) but does not record artifacts.assistDecision (Issue #217)",
                failures,
            )
        else:
            _check_assist_decision_lineage(decision, failures)


def _blocked_run_reached_assist_gate(artifacts: Mapping[str, Any]) -> bool:
    """Infer from the pack whether the assist-decision gate fired before the run was blocked."""
    trajectories = artifacts.get("agentTrajectories") or []
    if _is_seq(trajectories):
        for entry in trajectories:
            if not _is_mapping(entry):
                continue
            role = entry.get("agentRole")
            if role in ("transformation", "verification-repair"):
                return True
    repair_attempts = artifacts.get("repairAttempts") or []
    if _is_seq(repair_attempts) and len(list(repair_attempts)) > 0:
        return True
    invocations = artifacts.get("modelInvocations") or []
    if _is_seq(invocations):
        for entry in invocations:
            if not _is_mapping(entry):
                continue
            role = entry.get("agentRole")
            if role in ("transformation", "verification-repair"):
                return True
    return False


def _scan_referenced_artifacts(
    manifest: Mapping[str, Any],
    root: Path,
    failures: list[str],
) -> None:
    artifacts = manifest.get("artifacts") or {}
    if not _is_mapping(artifacts):
        return

    def _refs(node: Any) -> Iterable[Mapping[str, Any]]:
        if _is_mapping(node):
            if isinstance(node.get("uri"), str) and isinstance(node.get("sha256"), str):
                yield node
            for value in node.values():
                yield from _refs(value)
        elif _is_seq(node):
            for value in node:
                yield from _refs(value)

    seen: set = set()
    for ref in _refs(artifacts):
        uri = ref.get("uri")
        if not isinstance(uri, str) or uri in seen:
            continue
        seen.add(uri)
        path = _resolve_uri_to_path(uri, root)
        if path is None:
            continue
        _check_artifact_for_secrets(path, failures)


def validate(
    manifest_path: Path,
    *,
    mode: str,
    expect_foundry: bool,
    expect_skipped: bool,
    allow_skipped: bool,
    root: Path | None,
) -> list[str]:
    manifest = _load_manifest(manifest_path)
    failures: list[str] = []
    resolved_root = (root or manifest_path.parent).resolve()

    _check_top_level(manifest, failures)
    if mode == "success":
        _check_validation_block(manifest, expect_ok=True, failures=failures)
        _check_success_artifacts(
            manifest,
            expect_foundry=expect_foundry,
            expect_skipped=expect_skipped,
            allow_skipped=allow_skipped,
            failures=failures,
        )
    elif mode == "blocked":
        _check_validation_block(manifest, expect_ok=False, failures=failures)
        _check_blocked_artifacts(manifest, failures)
    else:  # pragma: no cover - argparse enforces choices
        raise SystemExit(f"unknown mode: {mode}")

    _scan_referenced_artifacts(manifest, resolved_root, failures)
    return failures


def _parse_args(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--manifest", required=True, type=Path, help="path to the Evidence Pack manifest JSON")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--success", dest="mode", action="store_const", const="success")
    mode.add_argument("--blocked", dest="mode", action="store_const", const="blocked")
    parser.add_argument("--expect-foundry-invocation", action="store_true")
    parser.add_argument("--expect-policy-skipped", action="store_true")
    parser.add_argument("--allow-skipped-model", action="store_true")
    parser.add_argument("--root", type=Path, default=None)
    args = parser.parse_args(argv)
    if args.expect_foundry_invocation and args.expect_policy_skipped:
        parser.error("--expect-foundry-invocation and --expect-policy-skipped are mutually exclusive")
    if args.expect_foundry_invocation and args.mode != "success":
        parser.error("--expect-foundry-invocation implies --success")
    return args


def main(argv: Sequence[str]) -> int:
    args = _parse_args(argv)
    if not args.manifest.exists():
        print(f"manifest does not exist: {args.manifest}", file=sys.stderr)
        return 2
    failures = validate(
        args.manifest,
        mode=args.mode,
        expect_foundry=args.expect_foundry_invocation,
        expect_skipped=args.expect_policy_skipped,
        allow_skipped=args.allow_skipped_model or args.mode == "success",
        root=args.root,
    )
    if failures:
        print(f"W0.2 evidence check FAILED for {args.manifest}", file=sys.stderr)
        for entry in failures:
            print(f"  - {entry}", file=sys.stderr)
        return 3
    print(f"W0.2 evidence check OK for {args.manifest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

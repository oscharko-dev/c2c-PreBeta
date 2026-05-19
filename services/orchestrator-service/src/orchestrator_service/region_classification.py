"""Studio-IDE-6 (#248): Java region classification + traceability view.

This module owns two cohesive surfaces:

1. The pure helpers that turn a generated Java file's text plus the W0.2
   run-contract evidence (assist decision, repair attempts, final
   classification) into the per-region trust-pillar overlay consumed by
   Studio for trust-pillar gutter / lens decorations.
2. The ``build_traceability_view`` aggregator that combines the generated
   project's ``c2c-trace.json``, the semantic-IR symbol map, and the
   per-file region classification into the payload served by
   ``GET /v0/runs/{runId}/traceability``.

The closed enums (``originClass`` / ``verificationOutcome`` / ``mappingClass``)
are governed by ADR 0007 / ADR 0006. Consumers MUST treat any string outside
those enums as opaque; the helpers raise ``ValueError`` rather than emit an
unknown value so an orchestrator bug never reaches the wire.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .run_contract import (
    ASSIST_OUTCOME_REQUIRED,
    JAVA_REGION_ORIGIN_AGENT_PROPOSED,
    JAVA_REGION_ORIGIN_CLASSES,
    JAVA_REGION_ORIGIN_DETERMINISTIC,
    JAVA_REGION_ORIGIN_MANUAL_EDIT,
    JAVA_REGION_ORIGIN_MANUAL_CLASSES,
    JAVA_REGION_ORIGIN_MANUAL_MODIFIED,
    JAVA_REGION_ORIGIN_REPAIR_ATTEMPTED,
    AssistDecision,
)

SCHEMA_VERSION = "v0"

# ``originClass`` values that imply the region was authored or rewritten by
# an agent. The mapping-class derivation treats a missing IR anchor on an
# agent-authored region as ``agent_originated`` rather than ``synthesized``
# (see Issue #248 derivation rules).
_AGENT_ORIGIN_CLASSES: frozenset[str] = frozenset(
    {
        JAVA_REGION_ORIGIN_AGENT_PROPOSED,
        JAVA_REGION_ORIGIN_REPAIR_ATTEMPTED,
    }
)

# Closed enums for the two new dimensions introduced by Studio-IDE-6.
VERIFICATION_OUTCOME_PASSED = "oracle_passed"
VERIFICATION_OUTCOME_FAILED = "oracle_failed"
VERIFICATION_OUTCOME_NONE = "no_oracle"

MAPPING_CLASS_DIRECT = "direct"
MAPPING_CLASS_AGGREGATED = "aggregated"
MAPPING_CLASS_SYNTHESIZED = "synthesized"
MAPPING_CLASS_AGENT_ORIGINATED = "agent_originated"


# ---------------------------------------------------------------------------
# Region structures
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class IrComment:
    """One parsed inline-IR-comment marker (``// <op> [<id> line <n>] ...``)."""

    stmt_id: str
    cobol_line: int


@dataclass(frozen=True)
class Region:
    """One contiguous line range in a generated Java file.

    ``ir_node_ids`` is the tuple of statement/paragraph IDs anchored by the
    inline IR comment(s) that opened the region. Empty for synthesized
    header/footer or for regions that no longer carry an IR anchor.
    """

    line_range: tuple[int, int]
    ir_node_ids: tuple[str, ...]


# Inline IR comment grammar emitted by ``JavaProjectGenerator``:
#   // display [stmt-7 line 42] DISPLAY 'HI'
#   // paragraph MAIN-LOGIC [para-3 line 12]
# The shape is stable across all opcodes; the bracket is the load-bearing
# part. We accept any whitespace-separated prefix before the ``[``-bracket
# (operation name, optional ``paragraph <label>`` qualifier, etc.) and
# capture the stmt id + cobol line from the bracket itself, which is what
# the overlay needs.
_IR_COMMENT_RE = re.compile(
    r"^\s*//\s*[^\[\n]*\[(?P<stmt_id>[^\s\]]+)\s+line\s+(?P<line>\d+)\]"
)


def parse_ir_comment(line: str) -> IrComment | None:
    """Return the parsed inline-IR-comment marker for ``line`` or ``None``.

    The function is total: any string is accepted and ``None`` is returned
    when the line is not an inline IR comment.
    """
    if not line:
        return None
    match = _IR_COMMENT_RE.match(line)
    if match is None:
        return None
    try:
        cobol_line = int(match.group("line"))
    except ValueError:  # pragma: no cover — regex guarantees \d+
        return None
    stmt_id = match.group("stmt_id")
    if not stmt_id:
        return None
    return IrComment(stmt_id=stmt_id, cobol_line=cobol_line)


def _is_block_closer(line: str) -> bool:
    """Return True when ``line`` is a synthesized closing-brace / footer line.

    Issue #248: the trailing footer of a generated Java file (closing
    braces of ``run()`` and the enclosing class, plus any blank padding)
    is ``synthesized``. We detect the footer boundary heuristically: a
    line whose only non-whitespace content is ``}`` (optionally followed
    by ``;`` / ``)``) ends the preceding IR-anchored region.
    """
    stripped = line.strip()
    if not stripped:
        return False
    return all(ch in "})" for ch in stripped)


def derive_regions(java_text: str) -> list[Region]:
    """Split a generated Java file into contiguous regions.

    A region starts at an inline IR comment and runs until the line just
    before the next inline IR comment, or just before the first
    closing-brace-only line that follows (whichever comes first). Lines
    before the first IR comment form a single synthesized header region;
    lines after the last IR-anchored region's end form a single
    synthesized footer region. When the file has no IR comments the
    whole file is one synthesized region.

    Empty input yields no regions.
    """
    if not java_text:
        return []
    lines = java_text.splitlines()
    if not lines:
        return []

    # Find each line index (1-based) that opens a new region.
    ir_indices: list[tuple[int, str]] = []
    for one_based_index, raw in enumerate(lines, start=1):
        marker = parse_ir_comment(raw)
        if marker is not None:
            ir_indices.append((one_based_index, marker.stmt_id))

    regions: list[Region] = []

    if not ir_indices:
        # Whole file is synthesized.
        regions.append(Region(line_range=(1, len(lines)), ir_node_ids=()))
        return regions

    # Header before the first IR comment.
    first_ir_line = ir_indices[0][0]
    if first_ir_line > 1:
        regions.append(Region(line_range=(1, first_ir_line - 1), ir_node_ids=()))

    total_lines = len(lines)
    # IR-anchored regions: stop at the next IR comment or at the first
    # closing-brace-only line — whichever comes first.
    for position, (start_line, stmt_id) in enumerate(ir_indices):
        next_ir_line = (
            ir_indices[position + 1][0]
            if position + 1 < len(ir_indices)
            else total_lines + 1
        )
        end_line = next_ir_line - 1
        for probe in range(start_line + 1, next_ir_line):
            if _is_block_closer(lines[probe - 1]):
                end_line = probe - 1
                break
        if end_line < start_line:
            # Defensive: an IR comment immediately followed by a closing
            # brace still owns at least its own line.
            end_line = start_line
        regions.append(
            Region(line_range=(start_line, end_line), ir_node_ids=(stmt_id,))
        )

    # Footer: any lines after the last IR-anchored region's end.
    last_end = regions[-1].line_range[1]
    if last_end < total_lines:
        regions.append(Region(line_range=(last_end + 1, total_lines), ir_node_ids=()))

    return regions


# ---------------------------------------------------------------------------
# Origin class
# ---------------------------------------------------------------------------


def _normalise_manual_overlay(
    overlay: Mapping[tuple[int, int], str] | None,
) -> dict[tuple[int, int], str]:
    """Validate a manual-overlay mapping and return a defensive copy."""
    if overlay is None:
        return {}
    normalised: dict[tuple[int, int], str] = {}
    for key, value in overlay.items():
        if value not in JAVA_REGION_ORIGIN_CLASSES:
            raise ValueError(
                f"manual overlay value must be one of "
                f"{sorted(JAVA_REGION_ORIGIN_CLASSES)}, got {value!r}"
            )
        if value not in JAVA_REGION_ORIGIN_MANUAL_CLASSES:
            # The hook is reserved for manual-edit provenance. Letting an
            # IDE pass ``deterministic`` would let it overwrite orchestrator
            # decisions silently, which is not the contract.
            raise ValueError(
                f"manual overlay value must be a manual class "
                f"{sorted(JAVA_REGION_ORIGIN_MANUAL_CLASSES)}, got {value!r}"
            )
        start_line = int(key[0])
        end_line = int(key[1])
        if start_line < 1 or end_line < start_line:
            raise ValueError(
                f"manual overlay range must be valid, got {(start_line, end_line)!r}"
            )
        normalised[(start_line, end_line)] = value
    return normalised


def _ranges_overlap(left: tuple[int, int], right: tuple[int, int]) -> bool:
    return left[0] <= right[1] and right[0] <= left[1]


def _manual_origin_for_overlap(
    line_range: tuple[int, int],
    overlay: Mapping[tuple[int, int], str],
) -> str | None:
    overlapping = [
        origin_class
        for overlay_range, origin_class in overlay.items()
        if _ranges_overlap(line_range, overlay_range)
    ]
    if JAVA_REGION_ORIGIN_MANUAL_MODIFIED in overlapping:
        return JAVA_REGION_ORIGIN_MANUAL_MODIFIED
    if JAVA_REGION_ORIGIN_MANUAL_EDIT in overlapping:
        return JAVA_REGION_ORIGIN_MANUAL_EDIT
    return None


def derive_origin_class(
    *,
    line_range: tuple[int, int],
    assist_decision: AssistDecision | None,
    repair_attempts: Sequence[Mapping[str, Any]],
    manual_overlay: Mapping[tuple[int, int], str] | None,
) -> str:
    """Return the ``originClass`` for a region.

    Priority (issue #248):
      1. Manual overlay wins if it overlaps this line range. Studio tracks
         changed-line subranges, while the orchestrator can classify broader
         IR-anchored regions.
      2. Else assist_required + at least one repair attempt with
         ``repairDecision == 'propose_candidate'`` → ``repair_attempted``.
      3. Else assist_required → ``agent_proposed``.
      4. Else → ``deterministic``.
    """
    overlay = _normalise_manual_overlay(manual_overlay)
    manual_origin = _manual_origin_for_overlap(line_range, overlay)
    if manual_origin is not None:
        return manual_origin
    if assist_decision is not None and assist_decision.outcome == ASSIST_OUTCOME_REQUIRED:
        has_propose_candidate = any(
            (entry.get("repairDecision") == "propose_candidate")
            for entry in repair_attempts
        )
        if has_propose_candidate:
            return JAVA_REGION_ORIGIN_REPAIR_ATTEMPTED
        return JAVA_REGION_ORIGIN_AGENT_PROPOSED
    return JAVA_REGION_ORIGIN_DETERMINISTIC


# ---------------------------------------------------------------------------
# Verification outcome
# ---------------------------------------------------------------------------


def derive_verification_outcome(
    *,
    final_classification: str | None,
    failure_code: str | None,
) -> str:
    """Map the run's final classification + failure code to an oracle outcome.

    Issue #248 / ADR 0007 §4: oracle outcome applies to the whole final
    buffer, so the same value flows into every non-manual region.
    """
    if final_classification == "success":
        return VERIFICATION_OUTCOME_PASSED
    if failure_code == "oracle_mismatch":
        return VERIFICATION_OUTCOME_FAILED
    return VERIFICATION_OUTCOME_NONE


# ---------------------------------------------------------------------------
# Mapping class
# ---------------------------------------------------------------------------


def derive_mapping_class(
    *,
    ir_node_ids: Sequence[str],
    origin_class: str,
) -> str:
    """Return the ``mappingClass`` for a region.

    ``direct`` = exactly one IR node; ``aggregated`` = two or more; without
    an IR anchor the class is ``agent_originated`` when the region was
    authored or rewritten by an agent, ``synthesized`` otherwise.
    """
    node_count = len(ir_node_ids)
    if node_count == 1:
        return MAPPING_CLASS_DIRECT
    if node_count > 1:
        return MAPPING_CLASS_AGGREGATED
    if origin_class in _AGENT_ORIGIN_CLASSES:
        return MAPPING_CLASS_AGENT_ORIGINATED
    return MAPPING_CLASS_SYNTHESIZED


# ---------------------------------------------------------------------------
# IR symbol map
# ---------------------------------------------------------------------------


def _resolve_cobol_filename(
    *,
    ir: Mapping[str, Any] | None,
    source_filename_hint: str | None,
) -> str:
    """Resolve the COBOL filename for the IR symbol map.

    Preference order: explicit hint > ``<programId>.cbl``. The fallback
    convention matches what the deterministic generator records on the
    run-state's source ref.
    """
    if source_filename_hint:
        return source_filename_hint
    program_id = ""
    if ir is not None:
        raw = ir.get("programId")
        if isinstance(raw, str):
            program_id = raw
    return f"{program_id}.cbl" if program_id else ""


def build_ir_symbol_map(
    ir: Mapping[str, Any] | None,
    *,
    source_filename_hint: str | None,
) -> dict[str, dict[str, Any]]:
    """Build the ``{irNodeId -> {cobolFile, cobolLine}}`` symbol map.

    Walks statements, fieldLayouts, and any ``symbols`` entry that carries
    a ``line`` integer. Returns an empty dict when ``ir`` is ``None`` so
    the traceability view can be served even before the IR has materialised.
    """
    if ir is None:
        return {}
    cobol_file = _resolve_cobol_filename(ir=ir, source_filename_hint=source_filename_hint)
    symbol_map: dict[str, dict[str, Any]] = {}

    def _add(entries: Iterable[Mapping[str, Any]], line_key: str) -> None:
        for entry in entries:
            entry_id = entry.get("id")
            if not isinstance(entry_id, str) or not entry_id:
                continue
            line_value = entry.get(line_key)
            if not isinstance(line_value, int):
                continue
            symbol_map[entry_id] = {"cobolFile": cobol_file, "cobolLine": line_value}

    statements = ir.get("statements")
    if isinstance(statements, list):
        _add((s for s in statements if isinstance(s, Mapping)), "sourceLine")

    field_layouts = ir.get("fieldLayouts")
    if isinstance(field_layouts, list):
        _add((f for f in field_layouts if isinstance(f, Mapping)), "sourceLine")

    symbols = ir.get("symbols")
    if isinstance(symbols, Mapping):
        for symbol_id, value in symbols.items():
            if not isinstance(symbol_id, str) or not isinstance(value, Mapping):
                continue
            line_value = value.get("line")
            if not isinstance(line_value, int):
                continue
            # Don't clobber an entry that came from statements/fieldLayouts.
            symbol_map.setdefault(
                symbol_id, {"cobolFile": cobol_file, "cobolLine": line_value}
            )

    return symbol_map


# ---------------------------------------------------------------------------
# End-to-end classification
# ---------------------------------------------------------------------------


def _region_to_payload(
    region: Region,
    *,
    origin_class: str,
    verification_outcome: str,
) -> dict[str, Any]:
    mapping_class = derive_mapping_class(
        ir_node_ids=region.ir_node_ids, origin_class=origin_class
    )
    return {
        "lineRange": {
            "startLine": region.line_range[0],
            "endLine": region.line_range[1],
        },
        "originClass": origin_class,
        "verificationOutcome": verification_outcome,
        "mappingClass": mapping_class,
        "schemaVersion": SCHEMA_VERSION,
    }


def compute_java_region_classification(
    *,
    java_files: Mapping[str, str],
    assist_decision: AssistDecision | None,
    repair_attempts: Sequence[Mapping[str, Any]],
    final_classification: str | None,
    failure_code: str | None,
    manual_overlay: Mapping[str, Mapping[tuple[int, int], str]] | None = None,
) -> dict[str, list[dict[str, Any]]]:
    """Compute the per-file region overlay for a generated Java project.

    ``java_files`` is keyed by the file's path relative to the generated
    project root. ``manual_overlay`` is the IDE-13 hook; it stays ``None``
    until Studio writes ``ManualEditOverlay`` artifacts and the orchestrator
    is wired to load them.
    """
    verification_outcome = derive_verification_outcome(
        final_classification=final_classification, failure_code=failure_code
    )
    overlay_by_file = manual_overlay or {}
    result: dict[str, list[dict[str, Any]]] = {}
    for file_path, java_text in java_files.items():
        per_file_overlay = overlay_by_file.get(file_path)
        regions = derive_regions(java_text)
        payload: list[dict[str, Any]] = []
        for region in regions:
            origin_class = derive_origin_class(
                line_range=region.line_range,
                assist_decision=assist_decision,
                repair_attempts=repair_attempts,
                manual_overlay=per_file_overlay,
            )
            payload.append(
                _region_to_payload(
                    region,
                    origin_class=origin_class,
                    verification_outcome=verification_outcome,
                )
            )
        result[file_path] = payload
    return result


# ---------------------------------------------------------------------------
# Traceability view (route payload)
# ---------------------------------------------------------------------------


def build_traceability_view(
    *,
    run_id: str,
    program_id: str,
    trace: Mapping[str, Any] | None,
    ir: Mapping[str, Any] | None,
    classification: Mapping[str, list[dict[str, Any]]] | None,
    source_filename_hint: str | None,
) -> dict[str, Any]:
    """Assemble the ``GET /v0/runs/{runId}/traceability`` payload.

    ``trace`` is ``c2c-trace.json`` (passed through verbatim). ``ir`` is the
    semantic-IR document (used to build the symbol map). ``classification``
    is the per-file overlay computed by :func:`compute_java_region_classification`
    — pass ``None`` when the run has not produced generated Java yet; the
    field surfaces as an empty object.
    """
    return {
        "schemaVersion": SCHEMA_VERSION,
        "runId": run_id,
        "programId": program_id,
        "trace": dict(trace) if isinstance(trace, Mapping) else None,
        "irSymbolMap": build_ir_symbol_map(ir, source_filename_hint=source_filename_hint),
        "javaRegionClassification": dict(classification) if classification else {},
    }

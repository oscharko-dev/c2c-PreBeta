"""Studio-IDE-6 (#248): Java region classification + traceability view tests.

The module under test (``orchestrator_service.region_classification``) owns
two surfaces:

1. The pure derivation helpers that turn a generated Java file's text +
   the W0.2 run contract evidence into the per-region trust-pillar overlay
   used by Studio. The five-class taxonomy is ADR 0007 / Issue #257; the
   mapping-class enum and verification-outcome enum are introduced by
   Studio-IDE-6 (#248).
2. The ``build_traceability_view`` aggregator that combines the generated
   project's ``c2c-trace.json``, the semantic IR symbol map, and the
   per-file region classification into the payload served by
   ``GET /v0/runs/{runId}/traceability``.

The tests below pin the derivation rules verbatim from the issue. They do
not boot the HTTP server; the server-side route is integration-tested via
``services/c2c-bff`` which exercises the same orchestrator-facing payload
through the BFF.
"""

from __future__ import annotations

import unittest

from orchestrator_service import region_classification as rc
from orchestrator_service.run_contract import (
    ASSIST_AGENT_ROLE_TRANSFORMATION,
    ASSIST_OUTCOME_NOT_REQUIRED,
    ASSIST_OUTCOME_REQUIRED,
    ASSIST_REASON_CALLER_EXPLICIT_OPT_IN,
    ASSIST_REASON_CALLER_DID_NOT_OPT_IN,
    AssistDecision,
)


def _assist_required() -> AssistDecision:
    return AssistDecision(
        outcome=ASSIST_OUTCOME_REQUIRED,
        reason_code=ASSIST_REASON_CALLER_EXPLICIT_OPT_IN,
        decided_at="2026-05-18T12:00:00Z",
        selected_agent_role=ASSIST_AGENT_ROLE_TRANSFORMATION,
    )


def _assist_not_required() -> AssistDecision:
    return AssistDecision(
        outcome=ASSIST_OUTCOME_NOT_REQUIRED,
        reason_code=ASSIST_REASON_CALLER_DID_NOT_OPT_IN,
        decided_at="2026-05-18T12:00:00Z",
    )


# ---------------------------------------------------------------------------
# parse_ir_comment
# ---------------------------------------------------------------------------


class ParseIrCommentTests(unittest.TestCase):
    def test_parses_statement_comment(self) -> None:
        parsed = rc.parse_ir_comment("        // display [stmt-7 line 42] DISPLAY 'HI'")
        self.assertIsNotNone(parsed)
        assert parsed is not None  # narrow for mypy
        self.assertEqual(parsed.stmt_id, "stmt-7")
        self.assertEqual(parsed.cobol_line, 42)

    def test_parses_paragraph_comment(self) -> None:
        parsed = rc.parse_ir_comment("// paragraph MAIN-LOGIC [para-3 line 12]")
        self.assertIsNotNone(parsed)
        assert parsed is not None
        self.assertEqual(parsed.stmt_id, "para-3")
        self.assertEqual(parsed.cobol_line, 12)

    def test_returns_none_for_plain_comment(self) -> None:
        self.assertIsNone(rc.parse_ir_comment("// regular comment"))

    def test_returns_none_for_code_line(self) -> None:
        self.assertIsNone(rc.parse_ir_comment("System.out.println(\"x\");"))

    def test_returns_none_for_blank(self) -> None:
        self.assertIsNone(rc.parse_ir_comment("   "))


# ---------------------------------------------------------------------------
# derive_regions
# ---------------------------------------------------------------------------


class DeriveRegionsTests(unittest.TestCase):
    def test_file_header_before_first_ir_comment_is_synthesized(self) -> None:
        text = "\n".join(
            [
                "package com.example;",  # 1
                "public class Foo {",  # 2
                "    void run() {",  # 3
                "        // display [s1 line 10] DISPLAY 'A'",  # 4
                "        System.out.println(\"A\");",  # 5
                "    }",  # 6
                "}",  # 7
            ]
        )
        regions = rc.derive_regions(text)
        # Header (lines 1-3) is one synthesized region with no IR node.
        self.assertEqual(regions[0].line_range, (1, 3))
        self.assertEqual(regions[0].ir_node_ids, ())
        # Statement region spans the IR comment + its code body until the
        # next IR comment or end-of-block.
        self.assertEqual(regions[1].line_range, (4, 5))
        self.assertEqual(regions[1].ir_node_ids, ("s1",))
        # Footer (closing braces) is synthesized.
        self.assertEqual(regions[-1].line_range, (6, 7))
        self.assertEqual(regions[-1].ir_node_ids, ())

    def test_consecutive_ir_comments_each_open_a_new_region(self) -> None:
        text = "\n".join(
            [
                "// display [s1 line 1] DISPLAY 'A'",  # 1
                "System.out.println(\"A\");",  # 2
                "// move [s2 line 2] MOVE A TO B",  # 3
                "b.moveFrom(a);",  # 4
            ]
        )
        regions = rc.derive_regions(text)
        self.assertEqual(len(regions), 2)
        self.assertEqual(regions[0].line_range, (1, 2))
        self.assertEqual(regions[0].ir_node_ids, ("s1",))
        self.assertEqual(regions[1].line_range, (3, 4))
        self.assertEqual(regions[1].ir_node_ids, ("s2",))

    def test_empty_file_returns_no_regions(self) -> None:
        self.assertEqual(rc.derive_regions(""), [])


# ---------------------------------------------------------------------------
# derive_origin_class
# ---------------------------------------------------------------------------


class DeriveOriginClassTests(unittest.TestCase):
    def test_deterministic_when_no_assist_no_repair(self) -> None:
        cls = rc.derive_origin_class(
            line_range=(1, 3),
            assist_decision=_assist_not_required(),
            repair_attempts=[],
            manual_overlay=None,
        )
        self.assertEqual(cls, "deterministic")

    def test_agent_proposed_when_assist_required(self) -> None:
        cls = rc.derive_origin_class(
            line_range=(1, 3),
            assist_decision=_assist_required(),
            repair_attempts=[],
            manual_overlay=None,
        )
        self.assertEqual(cls, "agent_proposed")

    def test_repair_attempted_when_assist_and_propose_candidate(self) -> None:
        cls = rc.derive_origin_class(
            line_range=(1, 3),
            assist_decision=_assist_required(),
            repair_attempts=[
                {"attemptNumber": 1, "repairDecision": "propose_candidate"},
            ],
            manual_overlay=None,
        )
        self.assertEqual(cls, "repair_attempted")

    def test_no_repair_class_when_only_refuse_no_change(self) -> None:
        # Per the issue spec: ``repair_attempted`` only applies when there is
        # at least one ``propose_candidate`` repair attempt.
        cls = rc.derive_origin_class(
            line_range=(1, 3),
            assist_decision=_assist_required(),
            repair_attempts=[
                {"attemptNumber": 1, "repairDecision": "refuse"},
                {"attemptNumber": 2, "repairDecision": "no_change"},
            ],
            manual_overlay=None,
        )
        self.assertEqual(cls, "agent_proposed")

    def test_manual_modified_from_overlay_wins_over_assist(self) -> None:
        cls = rc.derive_origin_class(
            line_range=(4, 6),
            assist_decision=_assist_required(),
            repair_attempts=[
                {"attemptNumber": 1, "repairDecision": "propose_candidate"},
            ],
            manual_overlay={(4, 6): "manual_modified"},
        )
        self.assertEqual(cls, "manual_modified")

    def test_manual_overlay_subrange_overlap_wins(self) -> None:
        cls = rc.derive_origin_class(
            line_range=(1, 3),
            assist_decision=_assist_required(),
            repair_attempts=[
                {"attemptNumber": 1, "repairDecision": "propose_candidate"},
            ],
            manual_overlay={(2, 2): "manual_modified"},
        )
        self.assertEqual(cls, "manual_modified")

    def test_manual_modified_wins_when_multiple_manual_overlaps(self) -> None:
        cls = rc.derive_origin_class(
            line_range=(1, 4),
            assist_decision=_assist_not_required(),
            repair_attempts=[],
            manual_overlay={(1, 1): "manual_edit", (3, 3): "manual_modified"},
        )
        self.assertEqual(cls, "manual_modified")

    def test_manual_edit_from_overlay(self) -> None:
        cls = rc.derive_origin_class(
            line_range=(1, 3),
            assist_decision=_assist_not_required(),
            repair_attempts=[],
            manual_overlay={(1, 3): "manual_edit"},
        )
        self.assertEqual(cls, "manual_edit")

    def test_unknown_manual_overlay_value_rejected(self) -> None:
        # An overlay supplied by IDE-13 must use a class from the closed
        # five-class taxonomy. Anything else is a programmer error.
        with self.assertRaises(ValueError):
            rc.derive_origin_class(
                line_range=(1, 3),
                assist_decision=_assist_not_required(),
                repair_attempts=[],
                manual_overlay={(1, 3): "rewritten"},
            )


# ---------------------------------------------------------------------------
# derive_verification_outcome
# ---------------------------------------------------------------------------


class DeriveVerificationOutcomeTests(unittest.TestCase):
    def test_passed_when_classification_success(self) -> None:
        self.assertEqual(
            rc.derive_verification_outcome(
                final_classification="success", failure_code=None
            ),
            "oracle_passed",
        )

    def test_failed_when_oracle_mismatch(self) -> None:
        self.assertEqual(
            rc.derive_verification_outcome(
                final_classification="failed", failure_code="oracle_mismatch"
            ),
            "oracle_failed",
        )

    def test_no_oracle_when_other_failure(self) -> None:
        self.assertEqual(
            rc.derive_verification_outcome(
                final_classification="failed",
                failure_code="java_compile_failed",
            ),
            "no_oracle",
        )

    def test_no_oracle_when_run_unfinalised(self) -> None:
        self.assertEqual(
            rc.derive_verification_outcome(
                final_classification=None, failure_code=None
            ),
            "no_oracle",
        )


# ---------------------------------------------------------------------------
# derive_mapping_class
# ---------------------------------------------------------------------------


class DeriveMappingClassTests(unittest.TestCase):
    def test_direct_when_single_ir_node(self) -> None:
        self.assertEqual(
            rc.derive_mapping_class(
                ir_node_ids=("stmt-1",), origin_class="deterministic"
            ),
            "direct",
        )

    def test_aggregated_when_multiple_ir_nodes(self) -> None:
        self.assertEqual(
            rc.derive_mapping_class(
                ir_node_ids=("para-1", "stmt-2", "stmt-3"),
                origin_class="deterministic",
            ),
            "aggregated",
        )

    def test_synthesized_when_no_ir_node_and_deterministic(self) -> None:
        self.assertEqual(
            rc.derive_mapping_class(
                ir_node_ids=(), origin_class="deterministic"
            ),
            "synthesized",
        )

    def test_agent_originated_when_no_ir_node_and_assist(self) -> None:
        self.assertEqual(
            rc.derive_mapping_class(
                ir_node_ids=(), origin_class="agent_proposed"
            ),
            "agent_originated",
        )
        self.assertEqual(
            rc.derive_mapping_class(
                ir_node_ids=(), origin_class="repair_attempted"
            ),
            "agent_originated",
        )

    def test_synthesized_when_no_ir_and_manual(self) -> None:
        # Manual edits without an anchor are still "synthesized" mapping —
        # the agent_originated bucket is specifically for agent rewrites
        # that landed without an IR anchor.
        self.assertEqual(
            rc.derive_mapping_class(
                ir_node_ids=(), origin_class="manual_edit"
            ),
            "synthesized",
        )


# ---------------------------------------------------------------------------
# build_ir_symbol_map
# ---------------------------------------------------------------------------


class BuildIrSymbolMapTests(unittest.TestCase):
    def test_resolves_statements_field_layouts_and_paragraph_symbols(self) -> None:
        ir_doc = {
            "programId": "BRNCH01",
            "statements": [
                {"id": "stmt-1", "sourceLine": 10, "operation": "display", "raw": "x"},
                {"id": "stmt-2", "sourceLine": 11, "operation": "move", "raw": "y"},
            ],
            "fieldLayouts": [
                {"id": "field-1", "sourceLine": 4},
            ],
            "symbols": {
                "para-MAIN": {"id": "para-MAIN", "kind": "paragraph", "line": 8},
                "ws-A": {"id": "ws-A", "kind": "data-item", "line": 4},
            },
        }
        symbol_map = rc.build_ir_symbol_map(ir_doc, source_filename_hint="BRNCH01.cbl")
        self.assertEqual(
            symbol_map["stmt-1"], {"cobolFile": "BRNCH01.cbl", "cobolLine": 10}
        )
        self.assertEqual(
            symbol_map["stmt-2"], {"cobolFile": "BRNCH01.cbl", "cobolLine": 11}
        )
        self.assertEqual(
            symbol_map["field-1"], {"cobolFile": "BRNCH01.cbl", "cobolLine": 4}
        )
        self.assertEqual(
            symbol_map["para-MAIN"], {"cobolFile": "BRNCH01.cbl", "cobolLine": 8}
        )

    def test_falls_back_to_program_id_when_no_filename_hint(self) -> None:
        ir_doc = {
            "programId": "PROG1",
            "statements": [{"id": "s1", "sourceLine": 5, "operation": "x", "raw": "r"}],
            "fieldLayouts": [],
            "symbols": {},
        }
        symbol_map = rc.build_ir_symbol_map(ir_doc, source_filename_hint=None)
        self.assertEqual(symbol_map["s1"], {"cobolFile": "PROG1.cbl", "cobolLine": 5})

    def test_returns_empty_dict_when_ir_is_none(self) -> None:
        self.assertEqual(rc.build_ir_symbol_map(None, source_filename_hint="x.cbl"), {})


# ---------------------------------------------------------------------------
# compute_java_region_classification
# ---------------------------------------------------------------------------


class ComputeJavaRegionClassificationTests(unittest.TestCase):
    def test_overlay_produces_manual_classes_alongside_repair_attempted(self) -> None:
        # Multi-class smoke test: one file with three IR-anchored regions and
        # a synthesized header/footer, exercised under assist+repair so the
        # non-overlay regions resolve to ``repair_attempted``. The manual
        # overlay hook stamps two of the three IR regions with the manual
        # classes. This proves the overlay hook composes correctly with the
        # repair path — the all-five round-trip is proven separately by
        # :meth:`test_all_five_origin_classes_are_producible` below.
        java_text = "\n".join(
            [
                "package com.example;",  # 1
                "public class F {",  # 2
                "  void run() {",  # 3
                "    // display [s1 line 1] D 'A'",  # 4
                "    System.out.println(\"A\");",  # 5
                "    // move [s2 line 2] MOVE A TO B",  # 6
                "    b.moveFrom(a);",  # 7
                "    // compute [s3 line 3] COMPUTE X = X + 1",  # 8
                "    x.setNumericValue(x.numericValue().add(1));",  # 9
                "  }",  # 10
                "}",  # 11
            ]
        )
        overlay = {(4, 5): "manual_modified", (8, 9): "manual_edit"}
        classification = rc.compute_java_region_classification(
            java_files={"src/main/java/com/example/F.java": java_text},
            assist_decision=_assist_required(),
            repair_attempts=[
                {"attemptNumber": 1, "repairDecision": "propose_candidate"},
            ],
            final_classification="success",
            failure_code=None,
            manual_overlay={"src/main/java/com/example/F.java": overlay},
        )
        regions = classification["src/main/java/com/example/F.java"]
        origin_classes = [r["originClass"] for r in regions]
        # Header / footer + s2 (no overlay) → repair_attempted; s1 →
        # manual_modified; s3 → manual_edit. ``synthesized`` is a
        # ``mappingClass`` value (no IR anchor + non-agent origin), not an
        # ``originClass`` — so we assert it on the mapping-class dimension
        # instead, where the header/footer regions surface it.
        self.assertIn("repair_attempted", origin_classes)
        self.assertIn("manual_modified", origin_classes)
        self.assertIn("manual_edit", origin_classes)
        # Mapping-class distinction: the header (no IR anchor) is mapped as
        # ``agent_originated`` here because the run is assist+repair (so any
        # non-IR region attributes to the agent path). ``synthesized`` would
        # require a deterministic baseline — covered by other tests.
        mapping_classes = {r["mappingClass"] for r in regions}
        self.assertIn("agent_originated", mapping_classes)
        # Every region must carry the four required keys + schemaVersion v0.
        for region in regions:
            self.assertEqual(region["schemaVersion"], "v0")
            self.assertEqual(
                set(region.keys()),
                {
                    "lineRange",
                    "originClass",
                    "verificationOutcome",
                    "mappingClass",
                    "schemaVersion",
                },
            )

    def test_manual_overlay_subrange_marks_derived_region_manual(self) -> None:
        java_text = "\n".join(
            [
                "// display [s1 line 1] D 'A'",  # 1
                "System.out.println(\"A\");",  # 2
            ]
        )
        classification = rc.compute_java_region_classification(
            java_files={"F.java": java_text},
            assist_decision=None,
            repair_attempts=[],
            final_classification="success",
            failure_code=None,
            manual_overlay={"F.java": {(2, 2): "manual_modified"}},
        )
        regions = classification["F.java"]
        self.assertEqual(regions[0]["lineRange"], {"startLine": 1, "endLine": 2})
        self.assertEqual(regions[0]["originClass"], "manual_modified")

    def test_all_five_origin_classes_are_producible(self) -> None:
        # Acceptance criterion (issue #248 AC2): the helper must be able to
        # produce every member of the closed ``originClass`` set. We run the
        # helper four times against minimal fixtures and union the observed
        # classes; the assertion is "every value in the contract appears
        # somewhere in the round-trip output". A single run cannot produce
        # all five at once because the deterministic / agent_proposed /
        # repair_attempted dimension is run-level, not region-level.
        observed: set[str] = set()

        # 1. Deterministic — no assist, no repair.
        det_text = "// display [s1 line 1] D 'A'\nSystem.out.println(\"A\");"
        det_out = rc.compute_java_region_classification(
            java_files={"F.java": det_text},
            assist_decision=None,
            repair_attempts=[],
            final_classification="success",
            failure_code=None,
            manual_overlay=None,
        )
        observed.update(r["originClass"] for r in det_out["F.java"])

        # 2. agent_proposed — assist required, no propose_candidate repair.
        ap_out = rc.compute_java_region_classification(
            java_files={"F.java": det_text},
            assist_decision=_assist_required(),
            repair_attempts=[],
            final_classification="success",
            failure_code=None,
            manual_overlay=None,
        )
        observed.update(r["originClass"] for r in ap_out["F.java"])

        # 3. repair_attempted — assist required + propose_candidate.
        ra_out = rc.compute_java_region_classification(
            java_files={"F.java": det_text},
            assist_decision=_assist_required(),
            repair_attempts=[
                {"attemptNumber": 1, "repairDecision": "propose_candidate"},
            ],
            final_classification="success",
            failure_code=None,
            manual_overlay=None,
        )
        observed.update(r["originClass"] for r in ra_out["F.java"])

        # 4. manual_modified + manual_edit — via overlay on a deterministic
        # baseline run so the non-overlay regions stay deterministic.
        manual_text = "\n".join(
            [
                "// display [s1 line 1] D 'A'",  # 1
                "System.out.println(\"A\");",  # 2
                "// move [s2 line 2] MOVE A TO B",  # 3
                "b.moveFrom(a);",  # 4
            ]
        )
        manual_out = rc.compute_java_region_classification(
            java_files={"F.java": manual_text},
            assist_decision=None,
            repair_attempts=[],
            final_classification="success",
            failure_code=None,
            manual_overlay={
                "F.java": {(1, 2): "manual_modified", (3, 4): "manual_edit"}
            },
        )
        observed.update(r["originClass"] for r in manual_out["F.java"])

        self.assertEqual(
            observed
            & {
                "deterministic",
                "agent_proposed",
                "repair_attempted",
                "manual_modified",
                "manual_edit",
            },
            {
                "deterministic",
                "agent_proposed",
                "repair_attempted",
                "manual_modified",
                "manual_edit",
            },
        )

    def test_no_manual_classes_when_overlay_absent(self) -> None:
        # Acceptance criterion: until IDE-13 lands, the orchestrator-derived
        # output never contains ``manual_modified`` or ``manual_edit``.
        java_text = "\n".join(
            [
                "// display [s1 line 1] D 'A'",
                "System.out.println(\"A\");",
            ]
        )
        classification = rc.compute_java_region_classification(
            java_files={"F.java": java_text},
            assist_decision=_assist_required(),
            repair_attempts=[],
            final_classification="success",
            failure_code=None,
            manual_overlay=None,
        )
        classes = {r["originClass"] for r in classification["F.java"]}
        self.assertNotIn("manual_modified", classes)
        self.assertNotIn("manual_edit", classes)

    def test_synthesized_regions_get_synthesized_mapping_class(self) -> None:
        java_text = "\n".join(
            [
                "package x;",  # 1 — header
                "public class F {",  # 2
                "// display [s1 line 1] D 'A'",  # 3
                "System.out.println(\"A\");",  # 4
                "}",  # 5 — footer
            ]
        )
        classification = rc.compute_java_region_classification(
            java_files={"F.java": java_text},
            assist_decision=_assist_not_required(),
            repair_attempts=[],
            final_classification=None,
            failure_code=None,
            manual_overlay=None,
        )
        regions = classification["F.java"]
        # First region (header) and last (footer) must be synthesized +
        # deterministic.
        self.assertEqual(regions[0]["mappingClass"], "synthesized")
        self.assertEqual(regions[0]["originClass"], "deterministic")
        self.assertEqual(regions[-1]["mappingClass"], "synthesized")

    def test_verification_outcome_flows_into_every_non_manual_region(self) -> None:
        java_text = "\n".join(
            [
                "// display [s1 line 1] D 'A'",
                "System.out.println(\"A\");",
            ]
        )
        classification = rc.compute_java_region_classification(
            java_files={"F.java": java_text},
            assist_decision=_assist_not_required(),
            repair_attempts=[],
            final_classification="failed",
            failure_code="oracle_mismatch",
            manual_overlay=None,
        )
        for region in classification["F.java"]:
            self.assertEqual(region["verificationOutcome"], "oracle_failed")


# ---------------------------------------------------------------------------
# build_traceability_view
# ---------------------------------------------------------------------------


class BuildTraceabilityViewTests(unittest.TestCase):
    def test_returns_trace_and_symbol_map_and_classification_when_present(self) -> None:
        trace_doc = {"programId": "BRNCH01", "files": {"F.java": ["s1"]}}
        ir_doc = {
            "programId": "BRNCH01",
            "statements": [
                {"id": "s1", "sourceLine": 1, "operation": "display", "raw": "r"}
            ],
            "fieldLayouts": [],
            "symbols": {},
        }
        view = rc.build_traceability_view(
            run_id="run-1",
            program_id="BRNCH01",
            trace=trace_doc,
            ir=ir_doc,
            classification={
                "F.java": [
                    {
                        "lineRange": {"startLine": 1, "endLine": 2},
                        "originClass": "deterministic",
                        "verificationOutcome": "no_oracle",
                        "mappingClass": "direct",
                        "schemaVersion": "v0",
                    }
                ]
            },
            source_filename_hint="BRNCH01.cbl",
        )
        self.assertEqual(view["schemaVersion"], "v0")
        self.assertEqual(view["runId"], "run-1")
        self.assertEqual(view["programId"], "BRNCH01")
        self.assertEqual(view["trace"], trace_doc)
        self.assertEqual(
            view["irSymbolMap"]["s1"], {"cobolFile": "BRNCH01.cbl", "cobolLine": 1}
        )
        self.assertIn("F.java", view["javaRegionClassification"])

    def test_returns_null_trace_when_artifact_absent(self) -> None:
        view = rc.build_traceability_view(
            run_id="run-2",
            program_id="",
            trace=None,
            ir=None,
            classification=None,
            source_filename_hint=None,
        )
        self.assertEqual(view["schemaVersion"], "v0")
        self.assertEqual(view["runId"], "run-2")
        self.assertEqual(view["programId"], "")
        self.assertIsNone(view["trace"])
        self.assertEqual(view["irSymbolMap"], {})
        self.assertEqual(view["javaRegionClassification"], {})


class TraceabilityRouteTests(unittest.TestCase):
    """End-to-end smoke for ``OrchestratorService._traceability_view``.

    These tests bypass the HTTP transport and exercise the route handler
    directly so they stay fast while still proving the wiring between
    the artifact store, the workflow runner's in-memory contract, and
    the pure derivation in :mod:`region_classification`.
    """

    def _service(self) -> tuple[Any, Any]:
        import tempfile
        from orchestrator_service.artifacts import RunArtifactStore
        from orchestrator_service.config import OrchestratorConfig
        from orchestrator_service.server import OrchestratorService

        tmp = tempfile.mkdtemp()
        store = RunArtifactStore(tmp, created_by="test")
        config = OrchestratorConfig(
            listen_addr="127.0.0.1:0",
            harness_base_url="http://127.0.0.1:1",
            workflow_id="w0-migration-v0",
            max_retries=0,
            retry_delay_ms=1,
            request_timeout_seconds=2,
            parse_capability_id="cobol.parse",
            ir_capability_id="cobol.ir",
            generator_capability_id="java.generator",
            build_test_capability_id="java.build-test",
            evidence_capability_id="evidence.writer",
            model_gateway_capability_id="model-gateway",
            control_token="t",
            capability_control_token="t",
            run_artifact_root=tmp,
            w0_capabilities=(),
        )

        class _Runner:
            def __init__(self) -> None:
                self.artifact_store = store
                self._contracts: dict[str, Any] = {}

            def workflow_contract_payload(self, run_id: str) -> Any:
                return self._contracts.get(run_id)

        runner = _Runner()
        service = OrchestratorService(config, runner, artifact_store=store)
        return service, runner

    def _seed_run(self, store: Any, run_id: str) -> None:
        store.write_json(
            run_id,
            "w0-migration-v0",
            "summary.json",
            {"runId": run_id, "programId": "BRNCH01", "status": "complete"},
            kind="run-summary",
        )

    def test_returns_trace_and_classification_when_present(self) -> None:
        from orchestrator_service.artifacts import (
            KIND_GENERATED_PROJECT_FILE,
            MIME_JAVA,
        )

        service, runner = self._service()
        run_id = "run-trace-1"
        self._seed_run(service.artifact_store, run_id)
        service.artifact_store.write_json(
            run_id,
            "w0-migration-v0",
            "semantic-ir.json",
            {
                "schemaVersion": "v0",
                "programId": "BRNCH01",
                "statements": [
                    {"id": "s1", "sourceLine": 7, "operation": "display", "raw": "x"}
                ],
                "fieldLayouts": [],
                "symbols": {},
            },
            kind="semantic-ir",
        )
        service.artifact_store.write_json(
            run_id,
            "w0-migration-v0",
            "generated-project/src/main/resources/c2c-trace.json",
            {"programId": "BRNCH01", "files": {"Foo.java": ["s1"]}},
            kind=KIND_GENERATED_PROJECT_FILE,
        )
        # Plant the contract payload (in-memory snapshot) carrying the
        # already-computed overlay.
        runner._contracts[run_id] = {
            "javaRegionClassification": {
                "Foo.java": [
                    {
                        "lineRange": {"startLine": 1, "endLine": 2},
                        "originClass": "deterministic",
                        "verificationOutcome": "no_oracle",
                        "mappingClass": "direct",
                        "schemaVersion": "v0",
                    }
                ]
            },
            "sourceRef": {"cobolSourcePath": "samples/BRNCH01.cbl"},
        }
        status, payload = service._artifact_endpoint(run_id, "traceability")
        self.assertEqual(status, 200)
        self.assertEqual(payload["schemaVersion"], "v0")
        self.assertEqual(payload["runId"], run_id)
        self.assertEqual(payload["trace"]["programId"], "BRNCH01")
        self.assertEqual(
            payload["irSymbolMap"]["s1"],
            {"cobolFile": "BRNCH01.cbl", "cobolLine": 7},
        )
        self.assertIn("Foo.java", payload["javaRegionClassification"])

    def test_returns_null_trace_when_artifact_absent(self) -> None:
        service, runner = self._service()
        run_id = "run-trace-2"
        self._seed_run(service.artifact_store, run_id)
        # No semantic-ir or c2c-trace artifacts persisted.
        status, payload = service._artifact_endpoint(run_id, "traceability")
        self.assertEqual(status, 200)
        self.assertIsNone(payload["trace"])
        self.assertEqual(payload["irSymbolMap"], {})
        self.assertEqual(payload["javaRegionClassification"], {})

    def test_returns_404_when_run_unknown(self) -> None:
        service, runner = self._service()
        status, payload = service._artifact_endpoint("run-missing", "traceability")
        self.assertEqual(status, 404)
        self.assertEqual(payload["error"], "run not found")


if __name__ == "__main__":
    unittest.main()

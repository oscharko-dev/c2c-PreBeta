"""ADR 0007 §5 / Issue #280 — server-side ``manualOverlay`` extraction.

The orchestrator HTTP API accepts the manual-edit overlay as part of the
``POST /api/v0/transform`` payload so Studio re-runs after manual edits
flow the per-region provenance through to the Verification/Repair Agent.
``_extract_manual_overlay_regions`` is the pure validator that normalises
the wire shape before the orchestrator commits to a run.
"""

from __future__ import annotations

import unittest

from orchestrator_service.server import _extract_manual_overlay_regions


def _manual_region(**overrides):
    region = {
        "filePath": "src/main/java/com/c2c/generated/Hello.java",
        "originClass": "manual_modified",
        "startLine": 3,
        "endLine": 5,
        "generatorBaselineRunId": "run-0",
        "generatorBaselineRegionHash": "a" * 64,
        "lastModifiedAt": "2026-05-18T09:14:33Z",
        "lastModifiedBy": {"userId": "user-1", "tenantId": "tenant-A"},
        "manualEditCount": 1,
    }
    region.update(overrides)
    return region


class ExtractManualOverlayRegionsTests(unittest.TestCase):
    def test_none_returns_empty_tuple(self) -> None:
        self.assertEqual(_extract_manual_overlay_regions(None), ())

    def test_empty_envelope_returns_empty_tuple(self) -> None:
        self.assertEqual(
            _extract_manual_overlay_regions({"schemaVersion": "v0", "regions": []}),
            (),
        )

    def test_bare_regions_array_accepted(self) -> None:
        # Bare-array form is convenient for ad-hoc callers; the
        # envelope form mirrors the evidence-pack artifact shape.
        regions = _extract_manual_overlay_regions(
            [
                _manual_region(),
            ]
        )
        self.assertEqual(len(regions), 1)
        self.assertEqual(regions[0]["originClass"], "manual_modified")
        self.assertEqual(regions[0]["startLine"], 3)
        self.assertEqual(regions[0]["endLine"], 5)

    def test_envelope_with_regions_accepted(self) -> None:
        regions = _extract_manual_overlay_regions(
            {
                "schemaVersion": "v0",
                "regions": [
                    {
                        "filePath": "Util.java",
                        "originClass": "manual_edit",
                        "startLine": 10,
                        "endLine": 12,
                        "generatorBaselineRunId": "run-0",
                        "lastModifiedAt": "2026-05-18T09:14:33Z",
                        "lastModifiedBy": {
                            "userId": "user-1",
                            "tenantId": "tenant-A",
                        },
                        "manualEditCount": 1,
                    }
                ],
            }
        )
        self.assertEqual(len(regions), 1)
        self.assertEqual(regions[0]["originClass"], "manual_edit")

    def test_studio_overlay_shape_accepted(self) -> None:
        regions = _extract_manual_overlay_regions(
            {
                "schemaVersion": "v0",
                "runId": "run-1",
                "javaFile": "src/main/java/com/example/App.java",
                "regions": [
                    {
                        "lineRange": {"startLine": 4, "endLine": 6},
                        "originClass": "manual_modified",
                        "generatorBaselineRunId": "run-0",
                        "generatorBaselineRegionHash": "a" * 64,
                        "lastModifiedAt": "2026-05-18T09:14:33Z",
                        "lastModifiedBy": {
                            "userId": "user-1",
                            "tenantId": "tenant-A",
                        },
                        "manualEditCount": 2,
                    }
                ],
            }
        )
        self.assertEqual(len(regions), 1)
        self.assertEqual(
            regions[0]["filePath"], "src/main/java/com/example/App.java"
        )
        self.assertEqual(regions[0]["startLine"], 4)
        self.assertEqual(regions[0]["endLine"], 6)
        self.assertEqual(regions[0]["generatorBaselineRunId"], "run-0")
        self.assertEqual(regions[0]["manualEditCount"], 2)

    def test_manual_edit_region_does_not_require_baseline_hash(self) -> None:
        regions = _extract_manual_overlay_regions(
            [
                _manual_region(
                    originClass="manual_edit",
                    generatorBaselineRegionHash=None,
                ),
            ]
        )
        self.assertEqual(len(regions), 1)
        self.assertEqual(regions[0]["originClass"], "manual_edit")
        self.assertNotIn("generatorBaselineRegionHash", regions[0])

    def test_unknown_origin_class_rejected(self) -> None:
        # ADR 0007 §"Rationale" pins the closed enum; non-manual
        # classes MUST NOT silently pass through the manual-overlay
        # surface.
        with self.assertRaises(ValueError) as ctx:
            _extract_manual_overlay_regions(
                [
                    _manual_region(originClass="deterministic"),
                ]
            )
        self.assertIn("originClass", str(ctx.exception))

    def test_missing_file_path_rejected(self) -> None:
        with self.assertRaises(ValueError):
            _extract_manual_overlay_regions(
                [
                    _manual_region(filePath=""),
                ]
            )

    def test_unsafe_file_path_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "safe relative Java path"):
            _extract_manual_overlay_regions(
                [
                    _manual_region(filePath="../secrets.txt"),
                ]
            )

    def test_non_java_file_path_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, r"\.java"):
            _extract_manual_overlay_regions(
                [
                    _manual_region(filePath="src/main/resources/config.yaml"),
                ]
            )

    def test_missing_common_provenance_rejected(self) -> None:
        region = _manual_region()
        del region["lastModifiedBy"]
        with self.assertRaisesRegex(ValueError, "lastModifiedBy"):
            _extract_manual_overlay_regions([region])

    def test_email_like_actor_ids_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "userId"):
            _extract_manual_overlay_regions(
                [
                    _manual_region(
                        lastModifiedBy={
                            "userId": "alice@example.com",
                            "tenantId": "tenant-A",
                        }
                    ),
                ]
            )

    def test_manual_modified_missing_region_hash_rejected(self) -> None:
        region = _manual_region()
        del region["generatorBaselineRegionHash"]
        with self.assertRaisesRegex(ValueError, "generatorBaselineRegionHash"):
            _extract_manual_overlay_regions([region])

    def test_manual_edit_region_hash_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "must be omitted"):
            _extract_manual_overlay_regions(
                [
                    _manual_region(
                        originClass="manual_edit",
                        generatorBaselineRegionHash="b" * 64,
                    )
                ]
            )

    def test_invalid_line_range_rejected(self) -> None:
        # startLine must be >= 1 and endLine must be >= startLine.
        with self.assertRaises(ValueError):
            _extract_manual_overlay_regions(
                [
                    _manual_region(startLine=0),
                ]
            )
        with self.assertRaises(ValueError):
            _extract_manual_overlay_regions(
                [
                    _manual_region(startLine=5, endLine=3),
                ]
            )

    def test_non_integer_line_rejected(self) -> None:
        with self.assertRaises(ValueError):
            _extract_manual_overlay_regions(
                [
                    _manual_region(startLine="first"),
                ]
            )

    def test_non_object_payload_rejected(self) -> None:
        with self.assertRaises(ValueError):
            _extract_manual_overlay_regions("not a payload")

    def test_non_array_regions_rejected(self) -> None:
        with self.assertRaises(ValueError):
            _extract_manual_overlay_regions(
                {"schemaVersion": "v0", "regions": "not a list"}
            )

    def test_non_object_region_entry_rejected(self) -> None:
        with self.assertRaises(ValueError):
            _extract_manual_overlay_regions(["not an object"])

    def test_generator_baseline_run_id_over_length_rejected(self) -> None:
        # #359 finding-4: generatorBaselineRunId must be bounded by the safe-id
        # pattern (^[A-Za-z0-9._-]{1,128}$). A value exceeding 128 characters
        # must be rejected.
        with self.assertRaises(ValueError):
            _extract_manual_overlay_regions(
                [
                    _manual_region(generatorBaselineRunId="run-" + "a" * 130),
                ]
            )

    def test_generator_baseline_run_id_out_of_charset_rejected(self) -> None:
        # #359 finding-4: a generatorBaselineRunId containing characters outside
        # the safe-id charset (e.g. '@') must be rejected.
        with self.assertRaises(ValueError):
            _extract_manual_overlay_regions(
                [
                    _manual_region(generatorBaselineRunId="run@bad"),
                ]
            )


if __name__ == "__main__":
    unittest.main()

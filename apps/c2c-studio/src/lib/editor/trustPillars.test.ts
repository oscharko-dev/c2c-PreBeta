import { describe, expect, it } from "vitest";
import type * as MonacoNs from "monaco-editor";

import {
  buildTrustPillarDecorations,
  lineageCoveragePct,
  mergeRegionsForTrustPillars,
  pillarFor,
  TRUST_PILLAR_VISUALS,
  trustPillarAriaSummary,
  type TrustPillarKey,
} from "./trustPillars";
import type {
  JavaOriginClass,
  JavaOriginOverlay,
  JavaRegionClassification,
  JavaVerificationOutcome,
} from "@/types/api";

function region(
  originClass: JavaOriginClass,
  verificationOutcome: JavaVerificationOutcome,
  startLine = 1,
  endLine = 5,
): JavaRegionClassification {
  return {
    schemaVersion: "v0",
    lineRange: { startLine, endLine },
    originClass,
    verificationOutcome,
    mappingClass: "direct",
  };
}

// Tiny stub mirroring the slice contract — the function only uses
// MarkerSeverity-style enums and the IModelDeltaDecoration shape, so an
// empty object cast is enough for these unit tests.
const monacoStub = {} as typeof MonacoNs;

describe("pillarFor", () => {
  const cases: Array<{
    originClass: JavaOriginClass;
    verificationOutcome: JavaVerificationOutcome;
    expected: TrustPillarKey;
  }> = [
    {
      originClass: "deterministic",
      verificationOutcome: "oracle_passed",
      expected: "deterministic-passed",
    },
    {
      originClass: "deterministic",
      verificationOutcome: "oracle_failed",
      expected: "deterministic-warn",
    },
    {
      originClass: "deterministic",
      verificationOutcome: "no_oracle",
      expected: "deterministic-warn",
    },
    {
      originClass: "agent_proposed",
      verificationOutcome: "oracle_passed",
      expected: "agent-passed",
    },
    {
      originClass: "agent_proposed",
      verificationOutcome: "oracle_failed",
      expected: "agent-warn",
    },
    {
      originClass: "agent_proposed",
      verificationOutcome: "no_oracle",
      expected: "agent-warn",
    },
    {
      originClass: "repair_attempted",
      verificationOutcome: "oracle_passed",
      expected: "repair",
    },
    {
      originClass: "repair_attempted",
      verificationOutcome: "oracle_failed",
      expected: "repair",
    },
    {
      originClass: "repair_attempted",
      verificationOutcome: "no_oracle",
      expected: "repair",
    },
    {
      originClass: "manual_modified",
      verificationOutcome: "oracle_passed",
      expected: "manual-modified",
    },
    {
      originClass: "manual_modified",
      verificationOutcome: "oracle_failed",
      expected: "manual-modified",
    },
    {
      originClass: "manual_modified",
      verificationOutcome: "no_oracle",
      expected: "manual-modified",
    },
    {
      originClass: "manual_edit",
      verificationOutcome: "oracle_passed",
      expected: "manual-edit",
    },
    {
      originClass: "manual_edit",
      verificationOutcome: "oracle_failed",
      expected: "manual-edit",
    },
    {
      originClass: "manual_edit",
      verificationOutcome: "no_oracle",
      expected: "manual-edit",
    },
  ];

  for (const { originClass, verificationOutcome, expected } of cases) {
    it(`maps (${originClass}, ${verificationOutcome}) → ${expected}`, () => {
      expect(pillarFor(region(originClass, verificationOutcome))).toBe(
        expected,
      );
    });
  }
});

describe("TRUST_PILLAR_VISUALS", () => {
  it("declares a visual for every pillar key referenced by pillarFor", () => {
    const keys: TrustPillarKey[] = [
      "deterministic-passed",
      "deterministic-warn",
      "agent-passed",
      "agent-warn",
      "repair",
      "manual-modified",
      "manual-edit",
    ];
    for (const key of keys) {
      const visual = TRUST_PILLAR_VISUALS[key];
      expect(visual.key).toBe(key);
      expect(visual.marginBarClass).toMatch(/c2c-trust-margin/);
      expect(visual.gutterIconClass).toMatch(/c2c-trust-glyph/);
      expect(visual.ariaLabel.length).toBeGreaterThan(0);
      expect(visual.hoverTooltip.length).toBeGreaterThan(0);
      expect(visual.glyphTitle.length).toBeGreaterThan(0);
    }
  });
});

describe("buildTrustPillarDecorations", () => {
  it("emits one decoration per region with the expected classNames", () => {
    const regions: JavaRegionClassification[] = [
      region("deterministic", "oracle_passed", 1, 3),
      region("agent_proposed", "oracle_failed", 4, 6),
      region("manual_modified", "no_oracle", 7, 9),
    ];
    const decorations = buildTrustPillarDecorations({
      monaco: monacoStub,
      regions,
    });
    expect(decorations).toHaveLength(3);
    expect(decorations[0].range).toMatchObject({
      startLineNumber: 1,
      endLineNumber: 3,
    });
    expect(decorations[0].options.linesDecorationsClassName).toBe(
      TRUST_PILLAR_VISUALS["deterministic-passed"].marginBarClass,
    );
    expect(decorations[0].options.glyphMarginClassName).toBe(
      TRUST_PILLAR_VISUALS["deterministic-passed"].gutterIconClass,
    );
    expect(decorations[1].options.linesDecorationsClassName).toBe(
      TRUST_PILLAR_VISUALS["agent-warn"].marginBarClass,
    );
    expect(decorations[2].options.linesDecorationsClassName).toBe(
      TRUST_PILLAR_VISUALS["manual-modified"].marginBarClass,
    );
  });

  it("returns an empty array when no regions are supplied", () => {
    expect(
      buildTrustPillarDecorations({ monaco: monacoStub, regions: [] }),
    ).toEqual([]);
  });

  it("skips unknown future origin classes instead of crashing", () => {
    const decorations = buildTrustPillarDecorations({
      monaco: monacoStub,
      regions: [
        {
          schemaVersion: "v1",
          lineRange: { startLine: 1, endLine: 3 },
          originClass: "future_origin" as JavaRegionClassification["originClass"],
          verificationOutcome: "oracle_passed",
          mappingClass: "direct",
        },
      ],
    });

    expect(decorations).toEqual([]);
  });

  it("includes the region's classification facts in the hover content", () => {
    const regions: JavaRegionClassification[] = [
      {
        schemaVersion: "v0",
        lineRange: { startLine: 1, endLine: 3 },
        originClass: "agent_proposed",
        verificationOutcome: "oracle_failed",
        mappingClass: "agent_originated",
      },
    ];
    const decorations = buildTrustPillarDecorations({
      monaco: monacoStub,
      regions,
      repairCount: 2,
      manualEditCount: 0,
    });
    const hover = decorations[0].options.hoverMessage;
    const flatHover = Array.isArray(hover)
      ? hover.map((m) => m.value).join("\n")
      : hover && "value" in hover
        ? hover.value
        : "";
    expect(flatHover).toContain("agent_proposed");
    expect(flatHover).toContain("oracle_failed");
    expect(flatHover).toContain("agent_originated");
    expect(flatHover).toContain("Repair attempts: 2");
  });
});

describe("trustPillarAriaSummary", () => {
  it("uses the pillar aria labels to summarize provenance for screen readers", () => {
    const summary = trustPillarAriaSummary([
      region("deterministic", "oracle_passed", 1, 3),
      region("manual_edit", "no_oracle", 4, 5),
      region("manual_edit", "no_oracle", 6, 7),
    ]);

    expect(summary).toBe(
      "Trust provenance summary. 1 region: Deterministic region, oracle verified. 2 regions: Manual addition, no COBOL lineage.",
    );
  });

  it("returns null when no known provenance regions are present", () => {
    expect(trustPillarAriaSummary([])).toBeNull();
  });
});

describe("lineageCoveragePct", () => {
  it("returns 0 for empty input", () => {
    expect(lineageCoveragePct(100, [])).toBe(0);
  });

  it("returns 0 when totalLines is 0", () => {
    expect(
      lineageCoveragePct(0, [region("deterministic", "oracle_passed")]),
    ).toBe(0);
  });

  it("returns 100 when every line is covered by a non-manual region", () => {
    const regions: JavaRegionClassification[] = [
      region("deterministic", "oracle_passed", 1, 10),
    ];
    expect(lineageCoveragePct(10, regions)).toBe(100);
  });

  it("counts manual_modified regions as non-covered", () => {
    const regions: JavaRegionClassification[] = [
      region("deterministic", "oracle_passed", 1, 5),
      region("manual_modified", "no_oracle", 6, 10),
    ];
    expect(lineageCoveragePct(10, regions)).toBe(50);
  });

  it("counts manual_edit regions as non-covered", () => {
    const regions: JavaRegionClassification[] = [
      region("deterministic", "oracle_passed", 1, 8),
      region("manual_edit", "no_oracle", 9, 10),
    ];
    expect(lineageCoveragePct(10, regions)).toBe(80);
  });

  it("clamps to an integer 0..100 even when regions overlap", () => {
    const regions: JavaRegionClassification[] = [
      region("deterministic", "oracle_passed", 1, 10),
      region("agent_proposed", "oracle_passed", 5, 15),
    ];
    // Lines 1..15 covered by some non-manual region; totalLines 12 ⇒ clamp to 100.
    expect(lineageCoveragePct(12, regions)).toBe(100);
  });

  it("returns 0 when no region covers any line", () => {
    const regions: JavaRegionClassification[] = [
      region("deterministic", "oracle_passed", 50, 60),
    ];
    expect(lineageCoveragePct(10, regions)).toBe(0);
  });
});

// Studio-IDE-13 (#255) AC8: ``mergeRegionsForTrustPillars`` unions the
// IDE-6 traceability overlay with the IDE-13 manual-edit overlay so the
// editor pane paints both kinds of regions in a single decoration pass.
// Manual regions synthesise the verificationOutcome / mappingClass
// fields they cannot carry — per ADR-0007 §6 their lineage is stale or
// unavailable — so the painter accepts them through its type filter.
describe("mergeRegionsForTrustPillars (IDE-13 AC8)", () => {
  function overlay(
    regions: JavaOriginOverlay["regions"],
    runId = "run-1",
  ): JavaOriginOverlay {
    return {
      schemaVersion: "v0",
      runId,
      javaFile: "App.java",
      regions,
    };
  }

  it("returns [] when both overlays are null", () => {
    expect(
      mergeRegionsForTrustPillars({
        traceabilityOverlay: null,
        manualOverlay: null,
      }),
    ).toEqual([]);
  });

  it("passes through traceability regions with verificationOutcome + mappingClass", () => {
    const trace = overlay([
      {
        lineRange: { startLine: 1, endLine: 5 },
        originClass: "deterministic",
        verificationOutcome: "oracle_passed",
        mappingClass: "direct",
      },
      {
        lineRange: { startLine: 6, endLine: 10 },
        originClass: "agent_proposed",
        verificationOutcome: "no_oracle",
        mappingClass: "aggregated",
      },
    ]);
    const merged = mergeRegionsForTrustPillars({
      traceabilityOverlay: trace,
      manualOverlay: null,
    });
    expect(merged).toHaveLength(2);
    expect(merged[0]?.originClass).toBe("deterministic");
    expect(merged[1]?.originClass).toBe("agent_proposed");
  });

  it("drops traceability regions that lack verificationOutcome OR mappingClass", () => {
    const trace = overlay([
      // Missing both fields — must be dropped.
      {
        lineRange: { startLine: 1, endLine: 5 },
        originClass: "deterministic",
      },
      // Missing only mappingClass — must also be dropped.
      {
        lineRange: { startLine: 6, endLine: 10 },
        originClass: "agent_proposed",
        verificationOutcome: "oracle_passed",
      },
    ]);
    expect(
      mergeRegionsForTrustPillars({
        traceabilityOverlay: trace,
        manualOverlay: null,
      }),
    ).toEqual([]);
  });

  it("paints manual_modified regions in the union with synthesised defaults", () => {
    const manual = overlay([
      {
        lineRange: { startLine: 20, endLine: 22 },
        originClass: "manual_modified",
      },
    ]);
    const merged = mergeRegionsForTrustPillars({
      traceabilityOverlay: null,
      manualOverlay: manual,
    });
    expect(merged).toHaveLength(1);
    const region = merged[0]!;
    expect(region.originClass).toBe("manual_modified");
    // Per ADR-0007 §6 manual lineage is stale; the painter sees
    // ``no_oracle`` + ``synthesized`` so the purple trust pillar is
    // applied (per AC8).
    expect(region.verificationOutcome).toBe("no_oracle");
    expect(region.mappingClass).toBe("synthesized");
  });

  it("paints manual_edit regions in the union with synthesised defaults", () => {
    const manual = overlay([
      {
        lineRange: { startLine: 30, endLine: 35 },
        originClass: "manual_edit",
      },
    ]);
    const merged = mergeRegionsForTrustPillars({
      traceabilityOverlay: null,
      manualOverlay: manual,
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]?.originClass).toBe("manual_edit");
    expect(merged[0]?.verificationOutcome).toBe("no_oracle");
    expect(merged[0]?.mappingClass).toBe("synthesized");
  });

  it("preserves explicit verificationOutcome/mappingClass on manual regions when present", () => {
    // Some persistence round-trips may carry the fields on manual
    // regions — the helper must NOT clobber them with defaults.
    const manual = overlay([
      {
        lineRange: { startLine: 40, endLine: 42 },
        originClass: "manual_modified",
        verificationOutcome: "oracle_failed",
        mappingClass: "agent_originated",
      },
    ]);
    const merged = mergeRegionsForTrustPillars({
      traceabilityOverlay: null,
      manualOverlay: manual,
    });
    expect(merged[0]?.verificationOutcome).toBe("oracle_failed");
    expect(merged[0]?.mappingClass).toBe("agent_originated");
  });

  it("unions trace + manual regions in a single output (AC8 happy path)", () => {
    const trace = overlay([
      {
        lineRange: { startLine: 1, endLine: 5 },
        originClass: "deterministic",
        verificationOutcome: "oracle_passed",
        mappingClass: "direct",
      },
    ]);
    const manual = overlay([
      {
        lineRange: { startLine: 7, endLine: 9 },
        originClass: "manual_modified",
      },
      {
        lineRange: { startLine: 11, endLine: 13 },
        originClass: "manual_edit",
      },
    ]);
    const merged = mergeRegionsForTrustPillars({
      traceabilityOverlay: trace,
      manualOverlay: manual,
    });
    // 1 trace + 2 manual = 3 regions total; trace first, manual after.
    expect(merged).toHaveLength(3);
    expect(merged.map((r) => r.originClass)).toEqual([
      "deterministic",
      "manual_modified",
      "manual_edit",
    ]);
  });

  it("ignores trace regions whose originClass is a manual class (defensive)", () => {
    // A future overlay-merger bug could route a manual region into the
    // trace slot. The helper filters by originClass first so this
    // never produces ghost regions painted twice.
    const trace = overlay([
      {
        lineRange: { startLine: 1, endLine: 3 },
        originClass: "manual_edit",
        verificationOutcome: "no_oracle",
        mappingClass: "synthesized",
      },
    ]);
    const merged = mergeRegionsForTrustPillars({
      traceabilityOverlay: trace,
      manualOverlay: null,
    });
    expect(merged).toEqual([]);
  });
});

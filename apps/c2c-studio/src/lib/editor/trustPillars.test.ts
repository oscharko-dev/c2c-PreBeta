import { describe, expect, it } from "vitest";
import type * as MonacoNs from "monaco-editor";

import {
  buildTrustPillarDecorations,
  lineageCoveragePct,
  pillarFor,
  TRUST_PILLAR_VISUALS,
  type TrustPillarKey,
} from "./trustPillars";
import type {
  JavaOriginClass,
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

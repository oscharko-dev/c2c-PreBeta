import { describe, it, expect } from "vitest";

import {
  DEFAULT_MARKER_LIMIT,
  DIAGNOSTIC_OWNERS,
  diagnosticsToMarkers,
  partitionByOwner,
  sourceKindToOwner,
} from "./diagnosticMarkers";
import type { Diagnostic } from "../../types/api";

// Minimal Monaco stub. The map mirrors Monaco's enum-as-namespace
// shape — we only need numeric values that are stable across calls,
// not the real Monaco implementation.
const monacoStub = {
  MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
} as unknown as Parameters<typeof diagnosticsToMarkers>[1]["monaco"];

// Stub Monaco text model exposing only what the marker builder reads.
function makeModel(
  lineLengths: number[],
): Parameters<typeof diagnosticsToMarkers>[1]["model"] {
  return {
    getLineCount() {
      return lineLengths.length;
    },
    getLineLength(lineNumber: number) {
      const idx = lineNumber - 1;
      return lineLengths[idx] ?? 0;
    },
  } as unknown as Parameters<typeof diagnosticsToMarkers>[1]["model"];
}

function makeDiagnostic(overrides: Partial<Diagnostic> = {}): Diagnostic {
  return {
    schemaVersion: "v0",
    severity: "error",
    code: "X",
    message: "x",
    // Default filePath so tests that exercise editor-surface
    // rendering pass the ADR 0006 Decision 4 gate. Tests that
    // exercise the "no filePath → no marker" rule override this.
    filePath: "fixture.cbl",
    ...overrides,
  };
}

describe("diagnosticsToMarkers", () => {
  it("maps severity to Monaco's MarkerSeverity enum", () => {
    const diagnostics: Diagnostic[] = [
      makeDiagnostic({ severity: "error", line: 1, code: "E1", message: "e" }),
      makeDiagnostic({
        severity: "warning",
        line: 2,
        code: "W1",
        message: "w",
      }),
      makeDiagnostic({ severity: "info", line: 3, code: "I1", message: "i" }),
      makeDiagnostic({ severity: "hint", line: 4, code: "H1", message: "h" }),
    ];
    const { markers } = diagnosticsToMarkers(diagnostics, {
      monaco: monacoStub,
      model: makeModel([10, 10, 10, 10]),
    });
    expect(markers.map((m) => m.severity)).toEqual([8, 4, 2, 1]);
  });

  it("falls back to Info for unknown severity values", () => {
    const diagnostics: Diagnostic[] = [
      makeDiagnostic({
        severity: "info-rich" as Diagnostic["severity"],
        line: 1,
        message: "future",
      }),
    ];
    const { markers } = diagnosticsToMarkers(diagnostics, {
      monaco: monacoStub,
      model: makeModel([10]),
    });
    expect(markers[0]?.severity).toBe(2);
  });

  it("renders a whole-line marker when column is absent", () => {
    const diagnostics: Diagnostic[] = [
      makeDiagnostic({ severity: "error", line: 1, message: "no col" }),
    ];
    const { markers } = diagnosticsToMarkers(diagnostics, {
      monaco: monacoStub,
      model: makeModel([42]),
    });
    expect(markers[0]?.startLineNumber).toBe(1);
    expect(markers[0]?.startColumn).toBe(1);
    expect(markers[0]?.endLineNumber).toBe(1);
    expect(markers[0]?.endColumn).toBe(43);
  });

  it("treats endLine/endColumn absent as point marker at (line, column)", () => {
    const diagnostics: Diagnostic[] = [
      makeDiagnostic({
        severity: "error",
        line: 5,
        column: 12,
        message: "point",
      }),
    ];
    const { markers } = diagnosticsToMarkers(diagnostics, {
      monaco: monacoStub,
      model: makeModel([0, 0, 0, 0, 30]),
    });
    expect(markers[0]?.startLineNumber).toBe(5);
    expect(markers[0]?.startColumn).toBe(12);
    expect(markers[0]?.endLineNumber).toBe(5);
    expect(markers[0]?.endColumn).toBe(13);
  });

  it("preserves explicit endLine/endColumn range", () => {
    const diagnostics: Diagnostic[] = [
      makeDiagnostic({
        severity: "warning",
        line: 3,
        column: 8,
        endLine: 4,
        endColumn: 16,
        message: "range",
      }),
    ];
    const { markers } = diagnosticsToMarkers(diagnostics, {
      monaco: monacoStub,
      model: makeModel([0, 0, 50, 50]),
    });
    expect(markers[0]?.startLineNumber).toBe(3);
    expect(markers[0]?.startColumn).toBe(8);
    expect(markers[0]?.endLineNumber).toBe(4);
    expect(markers[0]?.endColumn).toBe(16);
  });

  it("skips diagnostics without a line and counts them as file-level", () => {
    const diagnostics: Diagnostic[] = [
      makeDiagnostic({ severity: "error", message: "no line", code: "F" }),
      makeDiagnostic({ severity: "error", line: 1, message: "yes line" }),
    ];
    const { markers, fileLevelCount } = diagnosticsToMarkers(diagnostics, {
      monaco: monacoStub,
      model: makeModel([10]),
    });
    expect(markers.length).toBe(1);
    expect(fileLevelCount).toBe(1);
  });

  it("clamps the marker line to the model's line count", () => {
    const diagnostics: Diagnostic[] = [
      makeDiagnostic({
        severity: "error",
        line: 100,
        message: "out of range",
      }),
    ];
    const { markers } = diagnosticsToMarkers(diagnostics, {
      monaco: monacoStub,
      model: makeModel([10, 10]),
    });
    expect(markers[0]?.startLineNumber).toBe(2);
  });

  it("operates without a model — endColumn becomes column + 1", () => {
    const diagnostics: Diagnostic[] = [
      makeDiagnostic({
        severity: "warning",
        line: 5,
        column: 2,
        message: "no model",
      }),
    ];
    const { markers } = diagnosticsToMarkers(diagnostics, {
      monaco: monacoStub,
      model: null,
    });
    expect(markers[0]?.startColumn).toBe(2);
    expect(markers[0]?.endColumn).toBe(3);
  });

  it("respects the limit option and reports truncatedCount", () => {
    const diagnostics: Diagnostic[] = Array.from(
      { length: 2500 },
      (_value, index) =>
        makeDiagnostic({
          severity: "info",
          line: (index % 9) + 1,
          message: `m${index}`,
        }),
    );
    const { markers, truncatedCount } = diagnosticsToMarkers(diagnostics, {
      monaco: monacoStub,
      model: makeModel(Array.from({ length: 10 }, () => 80)),
      limit: 2000,
    });
    expect(markers.length).toBe(2000);
    expect(truncatedCount).toBe(500);
  });

  it("uses the default limit of 2000 when none provided", () => {
    expect(DEFAULT_MARKER_LIMIT).toBe(2000);
  });

  it("preserves the diagnostic code on the marker for hover tooltips", () => {
    const diagnostics: Diagnostic[] = [
      makeDiagnostic({
        severity: "error",
        line: 1,
        code: "PARSE-ERR",
        message: "syntax",
      }),
    ];
    const { markers } = diagnosticsToMarkers(diagnostics, {
      monaco: monacoStub,
      model: makeModel([10]),
    });
    expect(markers[0]?.code).toBe("PARSE-ERR");
  });

  it("emits markers in the input order (callers can pre-sort)", () => {
    const diagnostics: Diagnostic[] = [
      makeDiagnostic({ severity: "info", line: 5, message: "fifth" }),
      makeDiagnostic({ severity: "info", line: 1, message: "first" }),
      makeDiagnostic({ severity: "info", line: 3, message: "third" }),
    ];
    const { markers } = diagnosticsToMarkers(diagnostics, {
      monaco: monacoStub,
      model: makeModel(Array.from({ length: 5 }, () => 10)),
    });
    expect(markers.map((m) => m.message)).toEqual(["fifth", "first", "third"]);
  });
});

describe("partitionByOwner", () => {
  it("buckets diagnostics by sourceKind", () => {
    const diagnostics: Diagnostic[] = [
      makeDiagnostic({ sourceKind: "cobol", message: "c", line: 1 }),
      makeDiagnostic({ sourceKind: "ir", message: "i", line: 2 }),
      makeDiagnostic({
        sourceKind: "generated_java",
        message: "j",
        line: 3,
      }),
      makeDiagnostic({ sourceKind: "build", message: "b", line: 4 }),
      makeDiagnostic({ sourceKind: "test", message: "t", line: 5 }),
      makeDiagnostic({ message: "u" }),
    ];
    const buckets = partitionByOwner(diagnostics);
    expect(buckets["c2c-cobol"].length).toBe(1);
    expect(buckets["c2c-ir"].length).toBe(1);
    expect(buckets["c2c-generated-java"].length).toBe(1);
    expect(buckets["c2c-build"].length).toBe(1);
    expect(buckets["c2c-test"].length).toBe(1);
    expect(buckets["c2c-unknown"].length).toBe(1);
  });

  it("returns empty buckets for every owner even when input is empty", () => {
    const buckets = partitionByOwner([]);
    for (const owner of DIAGNOSTIC_OWNERS) {
      expect(buckets[owner]).toEqual([]);
    }
  });
});

describe("sourceKindToOwner", () => {
  it.each([
    ["cobol", "c2c-cobol"],
    ["ir", "c2c-ir"],
    ["generated_java", "c2c-generated-java"],
    ["build", "c2c-build"],
    ["test", "c2c-test"],
  ] as const)("maps %s -> %s", (kind, owner) => {
    expect(sourceKindToOwner(kind)).toBe(owner);
  });

  it("falls back to c2c-unknown for undefined or unknown sourceKind", () => {
    expect(sourceKindToOwner(undefined)).toBe("c2c-unknown");
    expect(sourceKindToOwner("something-new" as Diagnostic["sourceKind"])).toBe(
      "c2c-unknown",
    );
  });
});

describe("diagnosticsToMarkers — multi-line ranges (review #244)", () => {
  it("preserves an endColumn that is lower than startColumn when the range spans multiple lines", () => {
    const diagnostics: Diagnostic[] = [
      makeDiagnostic({
        severity: "error",
        line: 10,
        column: 40,
        endLine: 11,
        endColumn: 5,
        message: "multi-line block",
      }),
    ];
    const { markers } = diagnosticsToMarkers(diagnostics, {
      monaco: monacoStub,
      model: makeModel(Array.from({ length: 12 }, () => 80)),
    });
    expect(markers[0]?.startLineNumber).toBe(10);
    expect(markers[0]?.startColumn).toBe(40);
    expect(markers[0]?.endLineNumber).toBe(11);
    expect(markers[0]?.endColumn).toBe(5);
  });

  it("still clamps endColumn for single-line markers when it equals startColumn", () => {
    const diagnostics: Diagnostic[] = [
      makeDiagnostic({
        severity: "warning",
        line: 4,
        column: 7,
        endLine: 4,
        endColumn: 7,
        message: "zero-width same-line",
      }),
    ];
    const { markers } = diagnosticsToMarkers(diagnostics, {
      monaco: monacoStub,
      model: makeModel([0, 0, 0, 30]),
    });
    expect(markers[0]?.startColumn).toBe(7);
    expect(markers[0]?.endColumn).toBe(8);
  });
});

describe("diagnosticsToMarkers — filePath rule (review #244)", () => {
  it("drops diagnostics without filePath (ADR 0006 Decision 4)", () => {
    const diagnostics: Diagnostic[] = [
      {
        schemaVersion: "v0",
        severity: "error",
        code: "RUN",
        message: "run-level diagnostic",
        line: 12,
      },
      makeDiagnostic({
        severity: "error",
        line: 12,
        message: "file-attached",
      }),
    ];
    const { markers, fileLevelCount } = diagnosticsToMarkers(diagnostics, {
      monaco: monacoStub,
      model: makeModel([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 40]),
    });
    expect(markers).toHaveLength(1);
    expect(markers[0]?.message).toBe("file-attached");
    expect(fileLevelCount).toBe(1);
  });
});

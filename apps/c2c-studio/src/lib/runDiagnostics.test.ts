import { describe, expect, it } from "vitest";

import {
  countEditorMarkerOverflow,
  type DiagnosticEntry,
} from "@/lib/runDiagnostics";
import type { Diagnostic } from "@/types/api";

function diagnostic(overrides: Partial<Diagnostic> = {}): Diagnostic {
  return {
    schemaVersion: "v0",
    severity: "error",
    code: "X",
    message: "diagnostic",
    line: 1,
    filePath: "src/App.java",
    ...overrides,
  };
}

function entry(diagnostic: Diagnostic): DiagnosticEntry {
  return { scope: "generated", diagnostic };
}

describe("countEditorMarkerOverflow", () => {
  it("shares the generated editor budget across generated, build, and test owners for the same file", () => {
    const diagnostics = [
      ...Array.from({ length: 1500 }, (_, index) =>
        entry(
          diagnostic({
            sourceKind: "generated_java",
            message: `generated-${index}`,
          }),
        ),
      ),
      ...Array.from({ length: 1500 }, (_, index) =>
        entry(
          diagnostic({
            sourceKind: "build",
            message: `build-${index}`,
          }),
        ),
      ),
    ];

    expect(countEditorMarkerOverflow(diagnostics)).toBe(1000);
  });

  it("does not aggregate unrelated generated files into one overflow bucket", () => {
    const diagnostics = Array.from({ length: 2500 }, (_, index) =>
      entry(
        diagnostic({
          sourceKind: "build",
          filePath: `src/generated/File${index}.java`,
          message: `build-${index}`,
        }),
      ),
    );

    expect(countEditorMarkerOverflow(diagnostics)).toBe(0);
  });

  it("shares the COBOL editor budget across COBOL and IR owners for the same file", () => {
    const diagnostics = [
      ...Array.from({ length: 1500 }, (_, index) =>
        entry(
          diagnostic({
            sourceKind: "cobol",
            filePath: "src/main.cbl",
            message: `cobol-${index}`,
          }),
        ),
      ),
      ...Array.from({ length: 1500 }, (_, index) =>
        entry(
          diagnostic({
            sourceKind: "ir",
            filePath: "src/main.cbl",
            message: `ir-${index}`,
          }),
        ),
      ),
    ];

    expect(countEditorMarkerOverflow(diagnostics)).toBe(1000);
  });

  it("ignores diagnostics that cannot render as editor markers", () => {
    const diagnostics = [
      entry(diagnostic({ sourceKind: "build", line: undefined })),
      entry(diagnostic({ sourceKind: "build", filePath: undefined })),
      entry(
        diagnostic({
          sourceKind: "future" as Diagnostic["sourceKind"],
        }),
      ),
    ];

    expect(countEditorMarkerOverflow(diagnostics, 1)).toBe(0);
  });
});

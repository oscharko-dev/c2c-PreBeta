import { describe, expect, it } from "vitest";

import { deriveDraftProgramId } from "./sourceAnalysis";

describe("deriveDraftProgramId", () => {
  it("prefers the parser/IR program id", async () => {
    await expect(
      deriveDraftProgramId({
        parserProgramId: "PAYROLL01",
        detectedProgramId: "LOCAL01",
        sourceName: "payroll.cbl",
        normalizedPath: "src/payroll.cbl",
      }),
    ).resolves.toBe("PAYROLL01");
  });

  it("uses source identity path before a locally detected PROGRAM-ID", async () => {
    const first = await deriveDraftProgramId({
      parserProgramId: null,
      detectedProgramId: "LOCAL01",
      sourceName: "payroll.cbl",
      normalizedPath: "src/payroll.cbl",
    });
    const second = await deriveDraftProgramId({
      parserProgramId: null,
      detectedProgramId: "RENAMED01",
      sourceName: "payroll.cbl",
      normalizedPath: "src/payroll.cbl",
    });

    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(second).toBe(first);
  });

  it("uses the locally detected PROGRAM-ID when no stable path exists", async () => {
    await expect(
      deriveDraftProgramId({
        parserProgramId: null,
        detectedProgramId: "LOCAL01",
        sourceName: "payroll.cbl",
        normalizedPath: null,
      }),
    ).resolves.toBe("LOCAL01");
  });

  it("derives a 32-hex-character hash from sourceName and normalizedPath", async () => {
    const first = await deriveDraftProgramId({
      parserProgramId: null,
      detectedProgramId: null,
      sourceName: "payroll.cbl",
      normalizedPath: "src/a/payroll.cbl",
    });
    const second = await deriveDraftProgramId({
      parserProgramId: null,
      detectedProgramId: null,
      sourceName: "payroll.cbl",
      normalizedPath: "src/b/payroll.cbl",
    });

    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(second).toMatch(/^[0-9a-f]{32}$/);
    expect(first).not.toBe(second);
  });

  it("does not fall back to sourceName alone", async () => {
    await expect(
      deriveDraftProgramId({
        parserProgramId: null,
        detectedProgramId: null,
        sourceName: "payroll.cbl",
        normalizedPath: null,
      }),
    ).resolves.toBeNull();
  });
});

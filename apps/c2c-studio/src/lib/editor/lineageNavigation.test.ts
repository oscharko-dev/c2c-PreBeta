import { describe, expect, it, vi } from "vitest";

import { clearTraceCache } from "./traceParser";
import { resolveCobolToJava, resolveJavaToCobol } from "./lineageNavigation";
import type { TraceabilityEnvelope } from "@/types/api";

type FetchFn = typeof fetch;

function makeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(body);
    },
    async json() {
      return body;
    },
  } as unknown as Response;
}

function envelopeWith(
  regionsByFile: Record<
    string,
    Array<{
      startLine: number;
      endLine: number;
      originClass:
        | "deterministic"
        | "agent_proposed"
        | "repair_attempted"
        | "manual_modified"
        | "manual_edit";
    }>
  >,
  irSymbolMap: Record<string, { cobolFile: string; cobolLine: number }> = {},
): TraceabilityEnvelope {
  const javaRegionClassification: TraceabilityEnvelope["javaRegionClassification"] =
    {};
  for (const [file, regions] of Object.entries(regionsByFile)) {
    javaRegionClassification[file] = regions.map((r) => ({
      schemaVersion: "v0",
      lineRange: { startLine: r.startLine, endLine: r.endLine },
      originClass: r.originClass,
      verificationOutcome: "oracle_passed",
      mappingClass: "direct",
    }));
  }
  return {
    schemaVersion: "v0",
    runId: "run-1",
    programId: "PROG1",
    trace: null,
    irSymbolMap,
    javaRegionClassification,
  };
}

function fetcherFor(envelope: TraceabilityEnvelope): FetchFn {
  return vi.fn(async () => makeResponse(200, envelope)) as unknown as FetchFn;
}

const SAMPLE_JAVA = [
  "public class Prog1 {", // 1
  "  // move [s-move-x line 15]", // 2
  "  int x = 1;", // 3
  "  // paragraph PARA-A [s-paragraph-y line 22]", // 4
  "  void paraA() {", // 5
  "    // move [s-move-z line 30]", // 6
  "    int z = 2;", // 7
  "  }", // 8
  "}", // 9
].join("\n");

describe("resolveJavaToCobol", () => {
  it("resolves a deterministic region via the nearest inline IR anchor", async () => {
    clearTraceCache();
    const env = envelopeWith(
      {
        "Prog1.java": [
          { startLine: 1, endLine: 9, originClass: "deterministic" },
        ],
      },
      {
        "s-move-x": { cobolFile: "PROG1.cbl", cobolLine: 15 },
        "s-paragraph-y": { cobolFile: "PROG1.cbl", cobolLine: 22 },
        "s-move-z": { cobolFile: "PROG1.cbl", cobolLine: 30 },
      },
    );
    const result = await resolveJavaToCobol(
      "run-1",
      "Prog1.java",
      3,
      SAMPLE_JAVA,
      fetcherFor(env),
    );
    expect(result).toEqual({
      ok: true,
      target: { cobolFile: "PROG1.cbl", cobolLine: 15 },
    });
  });

  it("resolves an agent_proposed region", async () => {
    clearTraceCache();
    const env = envelopeWith(
      {
        "Prog1.java": [
          { startLine: 1, endLine: 9, originClass: "agent_proposed" },
        ],
      },
      { "s-move-z": { cobolFile: "PROG1.cbl", cobolLine: 30 } },
    );
    const result = await resolveJavaToCobol(
      "run-1",
      "Prog1.java",
      7,
      SAMPLE_JAVA,
      fetcherFor(env),
    );
    expect(result).toEqual({
      ok: true,
      target: { cobolFile: "PROG1.cbl", cobolLine: 30 },
    });
  });

  it("resolves a repair_attempted region", async () => {
    clearTraceCache();
    const env = envelopeWith(
      {
        "Prog1.java": [
          { startLine: 1, endLine: 9, originClass: "repair_attempted" },
        ],
      },
      { "s-move-x": { cobolFile: "PROG1.cbl", cobolLine: 15 } },
    );
    const result = await resolveJavaToCobol(
      "run-1",
      "Prog1.java",
      3,
      SAMPLE_JAVA,
      fetcherFor(env),
    );
    expect(result).toEqual({
      ok: true,
      target: { cobolFile: "PROG1.cbl", cobolLine: 15 },
    });
  });

  it("returns stale_manual_edit for a manual_modified region", async () => {
    clearTraceCache();
    const env = envelopeWith({
      "Prog1.java": [
        { startLine: 1, endLine: 9, originClass: "manual_modified" },
      ],
    });
    const result = await resolveJavaToCobol(
      "run-1",
      "Prog1.java",
      3,
      SAMPLE_JAVA,
      fetcherFor(env),
    );
    expect(result).toEqual({ ok: false, reason: "stale_manual_edit" });
  });

  it("returns manual_only for a manual_edit region", async () => {
    clearTraceCache();
    const env = envelopeWith({
      "Prog1.java": [{ startLine: 1, endLine: 9, originClass: "manual_edit" }],
    });
    const result = await resolveJavaToCobol(
      "run-1",
      "Prog1.java",
      3,
      SAMPLE_JAVA,
      fetcherFor(env),
    );
    expect(result).toEqual({ ok: false, reason: "manual_only" });
  });

  it("returns no_mapping when no region covers the line", async () => {
    clearTraceCache();
    const env = envelopeWith(
      {
        "Prog1.java": [
          { startLine: 1, endLine: 2, originClass: "deterministic" },
        ],
      },
      { "s-move-x": { cobolFile: "PROG1.cbl", cobolLine: 15 } },
    );
    const result = await resolveJavaToCobol(
      "run-1",
      "Prog1.java",
      5,
      SAMPLE_JAVA,
      fetcherFor(env),
    );
    expect(result).toEqual({ ok: false, reason: "no_mapping" });
  });

  it("returns no_mapping when the region has no inline IR anchor before the line", async () => {
    clearTraceCache();
    const env = envelopeWith(
      {
        "Prog1.java": [
          { startLine: 5, endLine: 8, originClass: "deterministic" },
        ],
      },
      { "s-move-z": { cobolFile: "PROG1.cbl", cobolLine: 30 } },
    );
    // Cursor is on line 5 (the region start) but the inline anchor for
    // s-move-z is on line 6 — i.e. there is NO anchor at or before line 5
    // within this region, so we cannot pinpoint a COBOL line.
    const result = await resolveJavaToCobol(
      "run-1",
      "Prog1.java",
      5,
      SAMPLE_JAVA,
      fetcherFor(env),
    );
    expect(result).toEqual({ ok: false, reason: "no_mapping" });
  });

  it("returns no_mapping when the matched anchor's IR symbol is missing from the map", async () => {
    clearTraceCache();
    const env = envelopeWith(
      {
        "Prog1.java": [
          { startLine: 1, endLine: 9, originClass: "deterministic" },
        ],
      },
      // intentionally empty irSymbolMap
    );
    const result = await resolveJavaToCobol(
      "run-1",
      "Prog1.java",
      3,
      SAMPLE_JAVA,
      fetcherFor(env),
    );
    expect(result).toEqual({ ok: false, reason: "no_mapping" });
  });

  it("uses the nearest preceding anchor (not the first) within the region", async () => {
    clearTraceCache();
    const env = envelopeWith(
      {
        "Prog1.java": [
          { startLine: 1, endLine: 9, originClass: "deterministic" },
        ],
      },
      {
        "s-move-x": { cobolFile: "PROG1.cbl", cobolLine: 15 },
        "s-paragraph-y": { cobolFile: "PROG1.cbl", cobolLine: 22 },
        "s-move-z": { cobolFile: "PROG1.cbl", cobolLine: 30 },
      },
    );
    // Cursor on line 7 — should pick s-move-z (anchor on line 6), NOT
    // s-move-x (line 2) or s-paragraph-y (line 4).
    const result = await resolveJavaToCobol(
      "run-1",
      "Prog1.java",
      7,
      SAMPLE_JAVA,
      fetcherFor(env),
    );
    expect(result).toEqual({
      ok: true,
      target: { cobolFile: "PROG1.cbl", cobolLine: 30 },
    });
  });
});

describe("resolveCobolToJava", () => {
  it("collects every Java region whose inline anchor points back at the COBOL line", async () => {
    clearTraceCache();
    const env = envelopeWith(
      {
        "Prog1.java": [
          { startLine: 1, endLine: 9, originClass: "deterministic" },
        ],
        "Other.java": [
          { startLine: 1, endLine: 9, originClass: "agent_proposed" },
        ],
      },
      { "s-move-x": { cobolFile: "PROG1.cbl", cobolLine: 15 } },
    );
    // We need to provide source for the other file too — the resolver
    // fetches via traceParser but parses inline anchors from the source it
    // is handed. Since the lineage layer cannot read files, the resolver
    // signature only takes (runId, cobolFile, cobolLine) and we instead
    // pull anchors from the regions themselves. We will instead test the
    // contract via patching: pass a custom javaSourceProvider when shipped.
    // Production wiring will read from the editor models or refetch each
    // file's content. For now, the resolver uses the inline anchors mined
    // out of the SAME envelope's sources, so this test verifies a single
    // file's anchor matches.
    const result = await resolveCobolToJava(
      "run-1",
      "PROG1.cbl",
      15,
      fetcherFor(env),
      // Hand-rolled source provider so tests don't need real fetches.
      (javaFile) =>
        javaFile === "Prog1.java"
          ? SAMPLE_JAVA
          : javaFile === "Other.java"
            ? "  // move [s-move-x line 15]"
            : null,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const sortedKeys = result.target.map((t) => t.javaFile);
      expect(sortedKeys).toEqual(["Other.java", "Prog1.java"]);
    }
  });

  it("accepts the program-id COBOL filename fallback for pasted or uploaded sources", async () => {
    clearTraceCache();
    const env = envelopeWith(
      {
        "Prog1.java": [
          { startLine: 1, endLine: 9, originClass: "deterministic" },
        ],
      },
      { "s-move-x": { cobolFile: "PROG1.cbl", cobolLine: 15 } },
    );

    const result = await resolveCobolToJava(
      "run-1",
      "workspace/uploaded-source.cbl",
      15,
      fetcherFor(env),
      () => SAMPLE_JAVA,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.target[0]).toMatchObject({
        javaFile: "Prog1.java",
        javaStartLine: 1,
        javaEndLine: 9,
      });
    }
  });

  it("returns no_mapping when no Java region anchors back at the COBOL line", async () => {
    clearTraceCache();
    const env = envelopeWith(
      {
        "Prog1.java": [
          { startLine: 1, endLine: 9, originClass: "deterministic" },
        ],
      },
      { "s-move-x": { cobolFile: "PROG1.cbl", cobolLine: 15 } },
    );
    const result = await resolveCobolToJava(
      "run-1",
      "PROG1.cbl",
      999,
      fetcherFor(env),
      () => SAMPLE_JAVA,
    );
    expect(result).toEqual({ ok: false, reason: "no_mapping" });
  });

  it("ignores anchors whose IR id maps to a different cobol file", async () => {
    clearTraceCache();
    const env = envelopeWith(
      {
        "Prog1.java": [
          { startLine: 1, endLine: 9, originClass: "deterministic" },
        ],
      },
      // s-move-x points at a DIFFERENT cobol file
      { "s-move-x": { cobolFile: "OTHER.cbl", cobolLine: 15 } },
    );
    const result = await resolveCobolToJava(
      "run-1",
      "PROG1.cbl",
      15,
      fetcherFor(env),
      () => SAMPLE_JAVA,
    );
    expect(result).toEqual({ ok: false, reason: "no_mapping" });
  });

  it("dedupes when multiple anchors in the same Java region point at the same cobol line", async () => {
    clearTraceCache();
    const env = envelopeWith(
      {
        "Prog1.java": [
          { startLine: 1, endLine: 9, originClass: "deterministic" },
        ],
      },
      {
        "s-a": { cobolFile: "PROG1.cbl", cobolLine: 15 },
        "s-b": { cobolFile: "PROG1.cbl", cobolLine: 15 },
      },
    );
    const dupSrc = [
      "public class Prog1 {",
      "  // move [s-a line 15]",
      "  // move [s-b line 15]",
      "}",
    ].join("\n");
    const result = await resolveCobolToJava(
      "run-1",
      "PROG1.cbl",
      15,
      fetcherFor(env),
      () => dupSrc,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // One JavaTarget for the single region (deduped).
      expect(result.target).toHaveLength(1);
      expect(result.target[0]).toMatchObject({
        javaFile: "Prog1.java",
        javaStartLine: 1,
        javaEndLine: 9,
      });
    }
  });
});

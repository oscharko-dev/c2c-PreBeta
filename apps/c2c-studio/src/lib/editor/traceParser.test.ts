import { describe, expect, it, vi } from "vitest";

import {
  clearTraceCache,
  clearTraceCacheFor,
  fetchTraceability,
  parseInlineIrAnchors,
  TraceabilityNotFoundError,
} from "./traceParser";
import type { TraceabilityEnvelope } from "@/types/api";

type FetchFn = typeof fetch;

function makeResponse(
  status: number,
  body: unknown,
  init: { ok?: boolean } = {},
): Response {
  return {
    ok: init.ok ?? (status >= 200 && status < 300),
    status,
    async text() {
      return JSON.stringify(body);
    },
    async json() {
      return body;
    },
  } as unknown as Response;
}

function envelope(): TraceabilityEnvelope {
  return {
    schemaVersion: "v0",
    runId: "run-1",
    programId: "PROG1",
    trace: null,
    irSymbolMap: {
      "s-move-x": { cobolFile: "PROG1.cbl", cobolLine: 15 },
      "s-paragraph-y": { cobolFile: "PROG1.cbl", cobolLine: 22 },
      "s-stop-z": { cobolFile: "PROG1.cbl", cobolLine: 99 },
    },
    javaRegionClassification: {
      "src/main/java/Prog1.java": [
        {
          schemaVersion: "v0",
          lineRange: { startLine: 1, endLine: 10 },
          originClass: "deterministic",
          verificationOutcome: "oracle_passed",
          mappingClass: "direct",
        },
      ],
    },
  };
}

describe("parseInlineIrAnchors", () => {
  it("matches a `move` style inline comment", () => {
    const src = [
      "public class A {",
      "  // move [s-move-x line 15]",
      "  int x = 1;",
      "}",
    ].join("\n");
    const result = parseInlineIrAnchors(src);
    expect(result).toEqual([
      { javaLine: 2, irNodeId: "s-move-x", cobolLine: 15 },
    ]);
  });

  it("matches the `paragraph <label> [<id> line <n>]` shape", () => {
    const src = [
      "  // paragraph PARA-A [s-paragraph-y line 22]",
      "  doWork();",
    ].join("\n");
    const result = parseInlineIrAnchors(src);
    expect(result).toEqual([
      { javaLine: 1, irNodeId: "s-paragraph-y", cobolLine: 22 },
    ]);
  });

  it("matches a `stop` style inline comment with trailing tokens", () => {
    const src = "  // stop [s-stop-z line 99] terminating program";
    const result = parseInlineIrAnchors(src);
    expect(result).toEqual([
      { javaLine: 1, irNodeId: "s-stop-z", cobolLine: 99 },
    ]);
  });

  it("silently skips malformed comments and lines without anchors", () => {
    const src = [
      "// not an anchor",
      "// move [no brackets",
      "// move [s-move-x line abc]", // non-numeric line
      "int x = 1;",
      "// move [s-move-x line 7]", // legitimate anchor on line 5
    ].join("\n");
    const result = parseInlineIrAnchors(src);
    expect(result).toEqual([
      { javaLine: 5, irNodeId: "s-move-x", cobolLine: 7 },
    ]);
  });

  it("returns 1-based javaLine numbers for multi-line input", () => {
    const src = [
      "// line 1 (no anchor)",
      "// move [s-a line 1]", // javaLine 2
      "// line 3 (no anchor)",
      "// move [s-b line 2]", // javaLine 4
    ].join("\n");
    const result = parseInlineIrAnchors(src);
    expect(result).toEqual([
      { javaLine: 2, irNodeId: "s-a", cobolLine: 1 },
      { javaLine: 4, irNodeId: "s-b", cobolLine: 2 },
    ]);
  });

  it("returns an empty array for an empty buffer", () => {
    expect(parseInlineIrAnchors("")).toEqual([]);
  });
});

describe("fetchTraceability", () => {
  it("fetches and parses an envelope into Map structures", async () => {
    clearTraceCache();
    const fetchImpl = vi.fn(async () =>
      makeResponse(200, envelope()),
    ) as unknown as FetchFn;
    const parsed = await fetchTraceability("run-1", fetchImpl);
    expect(parsed.runId).toBe("run-1");
    expect(parsed.programId).toBe("PROG1");
    expect(parsed.irSymbolMap.get("s-move-x")).toEqual({
      cobolFile: "PROG1.cbl",
      cobolLine: 15,
    });
    expect(
      parsed.javaRegionClassification.get("src/main/java/Prog1.java"),
    ).toHaveLength(1);
  });

  it("filters unknown future region classifications from traceability maps", async () => {
    clearTraceCache();
    const body = envelope();
    body.schemaVersion = "v1";
    body.javaRegionClassification = {
      "src/main/java/Prog1.java": [
        ...(body.javaRegionClassification?.["src/main/java/Prog1.java"] ?? []),
        {
          schemaVersion: "v1",
          lineRange: { startLine: 11, endLine: 12 },
          originClass: "future_origin" as never,
          verificationOutcome: "oracle_passed",
          mappingClass: "direct",
        },
      ],
    };
    const fetchImpl = vi.fn(async () =>
      makeResponse(200, body),
    ) as unknown as FetchFn;

    const parsed = await fetchTraceability("run-1", fetchImpl);

    expect(
      parsed.javaRegionClassification.get("src/main/java/Prog1.java"),
    ).toHaveLength(1);
  });

  it("caches results per runId", async () => {
    clearTraceCache();
    const fetchImpl = vi.fn(async () =>
      makeResponse(200, envelope()),
    ) as unknown as FetchFn;
    await fetchTraceability("run-1", fetchImpl);
    await fetchTraceability("run-1", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent fetches for the same runId", async () => {
    clearTraceCache();
    const fetchImpl = vi.fn(async () =>
      makeResponse(200, envelope()),
    ) as unknown as FetchFn;
    const [a, b] = await Promise.all([
      fetchTraceability("run-1", fetchImpl),
      fetchTraceability("run-1", fetchImpl),
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it("throws TraceabilityNotFoundError on 404", async () => {
    clearTraceCache();
    const fetchImpl = vi.fn(async () =>
      makeResponse(404, { message: "not found" }, { ok: false }),
    ) as unknown as FetchFn;
    await expect(
      fetchTraceability("missing-run", fetchImpl),
    ).rejects.toBeInstanceOf(TraceabilityNotFoundError);
  });

  it("evicts the cache on failure so a retry can succeed", async () => {
    clearTraceCache();
    const failing = vi.fn(async () =>
      makeResponse(500, "boom", { ok: false }),
    ) as unknown as FetchFn;
    await expect(fetchTraceability("run-1", failing)).rejects.toBeInstanceOf(
      Error,
    );
    const succeeding = vi.fn(async () =>
      makeResponse(200, envelope()),
    ) as unknown as FetchFn;
    const parsed = await fetchTraceability("run-1", succeeding);
    expect(parsed.runId).toBe("run-1");
    expect(succeeding).toHaveBeenCalledTimes(1);
  });

  it("URL-encodes the runId path segment", async () => {
    clearTraceCache();
    let capturedUrl = "";
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      capturedUrl = String(input);
      return makeResponse(200, envelope());
    }) as unknown as FetchFn;
    await fetchTraceability("run id/with slashes", fetchImpl);
    expect(capturedUrl).toContain(
      "/api/v0/runs/run%20id%2Fwith%20slashes/traceability",
    );
  });

  it("clearTraceCacheFor evicts a single runId only", async () => {
    clearTraceCache();
    const fetchImpl = vi.fn(async () =>
      makeResponse(200, envelope()),
    ) as unknown as FetchFn;
    await fetchTraceability("run-1", fetchImpl);
    await fetchTraceability("run-2", fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    clearTraceCacheFor("run-1");
    await fetchTraceability("run-1", fetchImpl);
    await fetchTraceability("run-2", fetchImpl);
    // run-1 re-fetched (+1), run-2 still cached (+0).
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

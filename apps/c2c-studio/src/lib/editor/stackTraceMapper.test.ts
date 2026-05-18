import { describe, expect, it, vi } from "vitest";

import { clearTraceCache } from "./traceParser";
import {
  mapStackFrames,
  parseStackTrace,
  type JavaSourceProvider,
} from "./stackTraceMapper";
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

function fetcherFor(envelope: TraceabilityEnvelope): FetchFn {
  return vi.fn(async () => makeResponse(200, envelope)) as unknown as FetchFn;
}

function envelope(
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

const SAMPLE_JAVA = [
  "package com.example;", //  1
  "public class Foo {", //  2
  "  // move [s-move-a line 10]", //  3
  "  int a = 1;", //  4
  "  // paragraph PARA-MAIN [s-paragraph-main line 22]", //  5
  "  public void bar() {", //  6
  "    // move [s-move-b line 30]", //  7
  "    int b = 2;", //  8
  "  }", //  9
  "  static class Inner {", // 10
  "    // move [s-move-c line 50]", // 11
  "    void inner() {}", // 12
  "  }", // 13
  "}", // 14
].join("\n");

describe("parseStackTrace", () => {
  it("parses a standard `at` frame", () => {
    const trace = "    at com.example.Foo.bar(Foo.java:8)";
    expect(parseStackTrace(trace)).toEqual([
      {
        frameRaw: "    at com.example.Foo.bar(Foo.java:8)",
        className: "com.example.Foo",
        methodName: "bar",
        javaFile: "Foo.java",
        javaLine: 8,
      },
    ]);
  });

  it("parses lambda frames (`lambda$method$0`)", () => {
    const trace = "  at com.example.Foo.lambda$bar$0(Foo.java:42)";
    const frames = parseStackTrace(trace);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      className: "com.example.Foo",
      methodName: "lambda$bar$0",
      javaFile: "Foo.java",
      javaLine: 42,
    });
  });

  it("parses inner-class frames (`Foo$Inner.method`)", () => {
    const trace = "  at com.example.Foo$Inner.inner(Foo.java:12)";
    const frames = parseStackTrace(trace);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      className: "com.example.Foo$Inner",
      methodName: "inner",
      javaFile: "Foo.java",
      javaLine: 12,
    });
  });

  it("parses constructor frames (`<init>`) and static-initializer (`<clinit>`)", () => {
    const trace = [
      "  at com.example.Foo.<init>(Foo.java:6)",
      "  at com.example.Foo.<clinit>(Foo.java:2)",
    ].join("\n");
    const frames = parseStackTrace(trace);
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({
      methodName: "<init>",
      javaLine: 6,
    });
    expect(frames[1]).toMatchObject({
      methodName: "<clinit>",
      javaLine: 2,
    });
  });

  it("skips native-method frames with no file:line info", () => {
    const trace = [
      "java.lang.NullPointerException",
      "  at sun.reflect.NativeMethodAccessorImpl.invoke0(Native Method)",
      "  at com.example.Foo.bar(Foo.java:8)",
      "  at jdk.internal.Unknown.unknown(Unknown Source)",
    ].join("\n");
    const frames = parseStackTrace(trace);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      className: "com.example.Foo",
      methodName: "bar",
      javaFile: "Foo.java",
      javaLine: 8,
    });
  });

  it("skips the exception-header line and the `... N more` summary", () => {
    const trace = [
      "java.lang.RuntimeException: boom",
      "  at com.example.Foo.bar(Foo.java:8)",
      "  ... 5 more",
      "Caused by: java.lang.IllegalStateException: nested",
      "  at com.example.Foo.baz(Foo.java:11)",
    ].join("\n");
    const frames = parseStackTrace(trace);
    expect(frames).toHaveLength(2);
    expect(frames.map((f) => f.javaLine)).toEqual([8, 11]);
  });

  it("handles mixed traces with resolvable and non-resolvable lines", () => {
    const trace = [
      "java.lang.NullPointerException",
      "  at sun.reflect.GeneratedMethodAccessor.invoke(Unknown Source)",
      "  at com.example.Foo.bar(Foo.java:8)",
      "  at sun.reflect.NativeMethodAccessorImpl.invoke0(Native Method)",
      "  at com.example.Foo$Inner.inner(Foo.java:12)",
    ].join("\n");
    const frames = parseStackTrace(trace);
    expect(frames).toHaveLength(2);
    expect(frames.map((f) => f.javaLine)).toEqual([8, 12]);
  });

  it("returns an empty list for empty / non-string input", () => {
    expect(parseStackTrace("")).toEqual([]);
    expect(parseStackTrace(undefined as unknown as string)).toEqual([]);
    expect(parseStackTrace(null as unknown as string)).toEqual([]);
  });

  it("ignores frames with a non-finite line number", () => {
    // Crafted to look like a frame but with an invalid digit pattern;
    // the regex requires 1+ digits so non-numeric values fail to match.
    const trace = "  at com.example.Foo.bar(Foo.java:abc)";
    expect(parseStackTrace(trace)).toEqual([]);
  });
});

describe("mapStackFrames", () => {
  it("returns frames with `cobol` set for resolvable lines", async () => {
    clearTraceCache();
    const env = envelope(
      {
        "src/main/java/com/example/Foo.java": [
          { startLine: 1, endLine: 14, originClass: "deterministic" },
        ],
      },
      {
        "s-move-a": { cobolFile: "PROG1.cbl", cobolLine: 10 },
        "s-paragraph-main": { cobolFile: "PROG1.cbl", cobolLine: 22 },
        "s-move-b": { cobolFile: "PROG1.cbl", cobolLine: 30 },
      },
    );
    const frames = parseStackTrace(
      "  at com.example.Foo.bar(Foo.java:8)\n  at com.example.Foo.bar(Foo.java:4)",
    );
    const provider: JavaSourceProvider = vi.fn(async (path) =>
      path === "src/main/java/com/example/Foo.java" ? SAMPLE_JAVA : null,
    );
    const resolved = await mapStackFrames(
      "run-1",
      frames,
      provider,
      fetcherFor(env),
    );
    expect(resolved).toHaveLength(2);
    expect(resolved[0]).toMatchObject({
      javaLine: 8,
      javaFilePath: "src/main/java/com/example/Foo.java",
      cobol: { file: "PROG1.cbl", line: 30 },
    });
    expect(resolved[1]).toMatchObject({
      javaLine: 4,
      javaFilePath: "src/main/java/com/example/Foo.java",
      cobol: { file: "PROG1.cbl", line: 10 },
    });
    // Source fetched once even though two frames target the same file.
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("matches short file names against full paths via path-segment suffix", async () => {
    clearTraceCache();
    const env = envelope(
      {
        "src/main/java/com/example/Foo.java": [
          { startLine: 1, endLine: 14, originClass: "deterministic" },
        ],
      },
      { "s-move-a": { cobolFile: "PROG1.cbl", cobolLine: 10 } },
    );
    const frames = parseStackTrace("  at com.example.Foo.bar(Foo.java:4)");
    const provider: JavaSourceProvider = async () => SAMPLE_JAVA;
    const resolved = await mapStackFrames(
      "run-1",
      frames,
      provider,
      fetcherFor(env),
    );
    expect(resolved[0].cobol).toEqual({ file: "PROG1.cbl", line: 10 });
  });

  it("returns frames without `cobol` when lineage classifies the region as manual_only", async () => {
    clearTraceCache();
    const env = envelope({
      "src/main/java/com/example/Foo.java": [
        { startLine: 1, endLine: 14, originClass: "manual_edit" },
      ],
    });
    const frames = parseStackTrace("  at com.example.Foo.bar(Foo.java:4)");
    const provider: JavaSourceProvider = async () => SAMPLE_JAVA;
    const resolved = await mapStackFrames(
      "run-1",
      frames,
      provider,
      fetcherFor(env),
    );
    expect(resolved[0].cobol).toBeUndefined();
    expect(resolved[0].javaFilePath).toBe("src/main/java/com/example/Foo.java");
  });

  it("returns frames without `cobol` when lineage classifies the region as stale_manual_edit", async () => {
    clearTraceCache();
    const env = envelope({
      "src/main/java/com/example/Foo.java": [
        { startLine: 1, endLine: 14, originClass: "manual_modified" },
      ],
    });
    const frames = parseStackTrace("  at com.example.Foo.bar(Foo.java:4)");
    const provider: JavaSourceProvider = async () => SAMPLE_JAVA;
    const resolved = await mapStackFrames(
      "run-1",
      frames,
      provider,
      fetcherFor(env),
    );
    expect(resolved[0].cobol).toBeUndefined();
  });

  it("returns frames without `cobol` when no envelope region matches the frame's file", async () => {
    clearTraceCache();
    const env = envelope({
      "src/main/java/com/example/Other.java": [
        { startLine: 1, endLine: 10, originClass: "deterministic" },
      ],
    });
    const frames = parseStackTrace("  at com.example.Foo.bar(Foo.java:8)");
    const provider: JavaSourceProvider = async () => SAMPLE_JAVA;
    const resolved = await mapStackFrames(
      "run-1",
      frames,
      provider,
      fetcherFor(env),
    );
    expect(resolved[0].cobol).toBeUndefined();
    expect(resolved[0].javaFilePath).toBeUndefined();
  });

  it("returns frames without `cobol` when the source provider yields null", async () => {
    clearTraceCache();
    const env = envelope({
      "src/main/java/com/example/Foo.java": [
        { startLine: 1, endLine: 14, originClass: "deterministic" },
      ],
    });
    const frames = parseStackTrace("  at com.example.Foo.bar(Foo.java:4)");
    const provider: JavaSourceProvider = async () => null;
    const resolved = await mapStackFrames(
      "run-1",
      frames,
      provider,
      fetcherFor(env),
    );
    expect(resolved[0].cobol).toBeUndefined();
    expect(resolved[0].javaFilePath).toBe("src/main/java/com/example/Foo.java");
  });

  it("falls back to non-resolved frames when the envelope fetch fails", async () => {
    clearTraceCache();
    const frames = parseStackTrace("  at com.example.Foo.bar(Foo.java:4)");
    const provider: JavaSourceProvider = vi.fn(async () => SAMPLE_JAVA);
    const failingFetcher: FetchFn = vi.fn(async () =>
      makeResponse(500, { error: "boom" }),
    ) as unknown as FetchFn;
    const resolved = await mapStackFrames(
      "run-1",
      frames,
      provider,
      failingFetcher,
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0].cobol).toBeUndefined();
    expect(resolved[0].javaFilePath).toBeUndefined();
    // No source fetched — we never reached the resolution step.
    expect(provider).not.toHaveBeenCalled();
  });

  it("handles a mixed trace: some frames resolve, others do not", async () => {
    clearTraceCache();
    const env = envelope(
      {
        "src/main/java/com/example/Foo.java": [
          { startLine: 1, endLine: 14, originClass: "deterministic" },
        ],
        "src/main/java/com/example/Other.java": [
          { startLine: 1, endLine: 5, originClass: "manual_edit" },
        ],
      },
      { "s-move-a": { cobolFile: "PROG1.cbl", cobolLine: 10 } },
    );
    const frames = parseStackTrace(
      [
        "  at com.example.Foo.bar(Foo.java:4)", // resolves
        "  at com.example.Other.x(Other.java:3)", // manual_edit → no cobol
        "  at com.example.Missing.y(Missing.java:1)", // no envelope path → no cobol, no javaFilePath
      ].join("\n"),
    );
    const provider: JavaSourceProvider = async (path) => {
      if (path === "src/main/java/com/example/Foo.java") return SAMPLE_JAVA;
      if (path === "src/main/java/com/example/Other.java") return "// stub";
      return null;
    };
    const resolved = await mapStackFrames(
      "run-1",
      frames,
      provider,
      fetcherFor(env),
    );
    expect(resolved).toHaveLength(3);
    expect(resolved[0].cobol).toEqual({ file: "PROG1.cbl", line: 10 });
    expect(resolved[1].cobol).toBeUndefined();
    expect(resolved[1].javaFilePath).toBe(
      "src/main/java/com/example/Other.java",
    );
    expect(resolved[2].cobol).toBeUndefined();
    expect(resolved[2].javaFilePath).toBeUndefined();
  });

  it("returns an empty list when given no frames", async () => {
    clearTraceCache();
    const resolved = await mapStackFrames(
      "run-1",
      [],
      async () => SAMPLE_JAVA,
      fetcherFor(envelope({})),
    );
    expect(resolved).toEqual([]);
  });
});

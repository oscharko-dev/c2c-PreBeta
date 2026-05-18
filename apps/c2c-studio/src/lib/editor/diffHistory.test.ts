// Studio-IDE-7 (#252): unit tests for the pure diff-history accumulator.

import { describe, expect, it } from "vitest";

import {
  appendJavaSnapshot,
  hasPreviousJava,
  recordCobolByRun,
  type CobolSnapshot,
  type JavaFileHistoryEntry,
  type JavaFileSnapshot,
} from "@/lib/editor/diffHistory";

const javaA: JavaFileSnapshot = {
  content: "class A {}\n",
  sourceHash: "aaaa1111",
  runId: "run-1",
};
const javaB: JavaFileSnapshot = {
  content: "class B {}\n",
  sourceHash: "bbbb2222",
  runId: "run-2",
};
const javaC: JavaFileSnapshot = {
  content: "class C {}\n",
  sourceHash: "cccc3333",
  runId: "run-3",
};

const cobolA: CobolSnapshot = {
  content: "       IDENTIFICATION DIVISION.\n",
  sourceHash: "aaaa1111",
  runId: "run-1",
};
const cobolB: CobolSnapshot = {
  content: "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. EDITED.\n",
  sourceHash: "bbbb2222",
  runId: "run-2",
};
const cobolC: CobolSnapshot = {
  content: "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. THIRD.\n",
  sourceHash: "cccc3333",
  runId: "run-3",
};

describe("appendJavaSnapshot", () => {
  it("seeds the entry on first snapshot with previous=null", () => {
    const next = appendJavaSnapshot(undefined, javaA);
    expect(next).toEqual({ previous: null, current: javaA });
  });

  it("shifts current into previous on a new runId", () => {
    const initial = appendJavaSnapshot(undefined, javaA);
    const next = appendJavaSnapshot(initial, javaB);
    expect(next.previous).toEqual(javaA);
    expect(next.current).toEqual(javaB);
  });

  it("is a no-op when the incoming snapshot has the same runId as current", () => {
    const initial = appendJavaSnapshot(undefined, javaA);
    const shifted = appendJavaSnapshot(initial, javaB);
    // Re-poll the same run — must not clobber `previous`.
    const repolled = appendJavaSnapshot(shifted, {
      ...javaB,
      content: "// re-polled content\n",
      sourceHash: "deadbeef",
    });
    expect(repolled).toBe(shifted);
  });

  it("rolls history across three consecutive runs (only two retained)", () => {
    const r1 = appendJavaSnapshot(undefined, javaA);
    const r2 = appendJavaSnapshot(r1, javaB);
    const r3 = appendJavaSnapshot(r2, javaC);
    expect(r3.previous).toEqual(javaB);
    expect(r3.current).toEqual(javaC);
  });

  it("does not mutate the input entry", () => {
    const initial: JavaFileHistoryEntry = { previous: null, current: javaA };
    const snapshotBefore = JSON.parse(JSON.stringify(initial));
    appendJavaSnapshot(initial, javaB);
    expect(initial).toEqual(snapshotBefore);
  });
});

describe("recordCobolByRun", () => {
  it("creates the map on first insert", () => {
    const next = recordCobolByRun(undefined, cobolA);
    expect(next).toEqual({ "run-1": cobolA });
  });

  it("inserts additional entries without disturbing previous runIds", () => {
    const r1 = recordCobolByRun(undefined, cobolA);
    const r2 = recordCobolByRun(r1, cobolB);
    expect(r2["run-1"]).toEqual(cobolA);
    expect(r2["run-2"]).toEqual(cobolB);
  });

  it("retains all run-keyed entries (so consumers can look up by either Java runId)", () => {
    // Studio-IDE-7 review-finding (Copilot, PR #282): the COBOL pane must
    // remain consistent with the Java pane even when a failed run sits
    // between two successful runs. Keying by runId guarantees the
    // selectors stay aligned.
    const acc = recordCobolByRun(
      recordCobolByRun(recordCobolByRun(undefined, cobolA), cobolB),
      cobolC,
    );
    expect(Object.keys(acc).sort()).toEqual(["run-1", "run-2", "run-3"]);
    expect(acc["run-1"]).toEqual(cobolA);
    expect(acc["run-3"]).toEqual(cobolC);
  });

  it("is idempotent on repeat writes for the same runId with same content", () => {
    const initial = recordCobolByRun(undefined, cobolA);
    const same = recordCobolByRun(initial, { ...cobolA });
    expect(same).toBe(initial);
  });

  it("overwrites when the same runId is written with different content", () => {
    const initial = recordCobolByRun(undefined, cobolA);
    const overwritten = recordCobolByRun(initial, {
      ...cobolA,
      content: "different content",
      sourceHash: "deadbeef",
    });
    expect(overwritten["run-1"]?.content).toBe("different content");
    expect(overwritten["run-1"]?.sourceHash).toBe("deadbeef");
  });

  it("does not mutate the input map", () => {
    const initial = recordCobolByRun(undefined, cobolA);
    const before = { ...initial };
    recordCobolByRun(initial, cobolB);
    expect(initial).toEqual(before);
  });
});

describe("hasPreviousJava type guard", () => {
  it("returns false for undefined and seeded entries", () => {
    expect(hasPreviousJava(undefined)).toBe(false);
    expect(hasPreviousJava({ previous: null, current: javaA })).toBe(false);
  });

  it("returns true once a previous snapshot is recorded", () => {
    const javaTwo = appendJavaSnapshot(
      appendJavaSnapshot(undefined, javaA),
      javaB,
    );
    expect(hasPreviousJava(javaTwo)).toBe(true);
  });
});

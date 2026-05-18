// Studio-IDE-7 (#252): unit tests for the pure diff-history accumulator.

import { describe, expect, it } from "vitest";

import {
  appendCobolSnapshot,
  appendJavaSnapshot,
  hasPreviousCobol,
  hasPreviousJava,
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

describe("appendCobolSnapshot", () => {
  it("seeds the entry on first snapshot with previous=null", () => {
    const next = appendCobolSnapshot(undefined, cobolA);
    expect(next).toEqual({ previous: null, current: cobolA });
  });

  it("shifts current into previous on a new runId", () => {
    const initial = appendCobolSnapshot(undefined, cobolA);
    const next = appendCobolSnapshot(initial, cobolB);
    expect(next.previous).toEqual(cobolA);
    expect(next.current).toEqual(cobolB);
  });

  it("is a no-op when the incoming snapshot has the same runId as current", () => {
    const initial = appendCobolSnapshot(undefined, cobolA);
    const same = appendCobolSnapshot(initial, {
      ...cobolA,
      content: "re-polled",
    });
    expect(same).toBe(initial);
  });
});

describe("hasPreviousJava / hasPreviousCobol type guards", () => {
  it("returns false for undefined and seeded entries", () => {
    expect(hasPreviousJava(undefined)).toBe(false);
    expect(hasPreviousJava({ previous: null, current: javaA })).toBe(false);
    expect(hasPreviousCobol(undefined)).toBe(false);
    expect(hasPreviousCobol({ previous: null, current: cobolA })).toBe(false);
  });

  it("returns true once a previous snapshot is recorded", () => {
    const javaTwo = appendJavaSnapshot(
      appendJavaSnapshot(undefined, javaA),
      javaB,
    );
    expect(hasPreviousJava(javaTwo)).toBe(true);
    const cobolTwo = appendCobolSnapshot(
      appendCobolSnapshot(undefined, cobolA),
      cobolB,
    );
    expect(hasPreviousCobol(cobolTwo)).toBe(true);
  });
});

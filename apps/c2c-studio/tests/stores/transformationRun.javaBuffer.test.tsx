import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import React, { type ReactNode } from "react";

import {
  TransformationRunProvider,
  useTransformationRun,
} from "@/stores/transformationRun";

// Studio-IDE-3 (#247) + Studio-IDE-4 (#245): pin the cross-cutting Java
// buffer semantics for the file-level "Stale" badge. These tests document
// the behavior IDE-4 relies on when rendering the run-mode badge and
// chip — if a future slice changes the lifecycle, the regression here
// fires and the badge derivation in `GeneratedJavaEditorPane.tsx` needs
// to be revisited alongside the spec.

function wrapper({ children }: { children: ReactNode }) {
  return <TransformationRunProvider>{children}</TransformationRunProvider>;
}

describe("transformationRun: Java buffer lifecycle (current behavior)", () => {
  it("hydrates a clean buffer with displayed === lastRunInput so the file is not stale", async () => {
    const { result } = renderHook(() => useTransformationRun(), { wrapper });

    await act(async () => {
      await result.current.ensureJavaBaseline(
        "src/App.java",
        "public class App {}",
        "run-1",
      );
    });

    const entry = result.current.javaBuffers["src/App.java"];
    expect(entry).toBeDefined();
    expect(entry.isDirty).toBe(false);
    expect(entry.lastRunInputHash).toBe(entry.displayedArtifactSourceHash);
    expect(entry.generatorBaselineRunId).toBe("run-1");

    const flags = result.current.javaStatusFlags("src/App.java");
    expect(flags.clean).toBe(true);
    expect(flags.staleJava).toBe(false);
    expect(flags.pendingReRun).toBe(false);
  });

  it("on a subsequent run with different BFF content, displayedArtifactSourceHash advances while lastRunInputHash is preserved — file becomes stale", async () => {
    const { result } = renderHook(() => useTransformationRun(), { wrapper });

    await act(async () => {
      await result.current.ensureJavaBaseline(
        "src/App.java",
        "public class App {}",
        "run-1",
      );
    });
    const firstLastRunInput =
      result.current.javaBuffers["src/App.java"].lastRunInputHash;
    const firstDisplayed =
      result.current.javaBuffers["src/App.java"].displayedArtifactSourceHash;

    // Different BFF response for the same file (e.g., the user re-fetched a
    // run that delivered a refined Java sample).
    await act(async () => {
      await result.current.ensureJavaBaseline(
        "src/App.java",
        "public class App { int x; }",
        "run-2",
      );
    });
    const entry = result.current.javaBuffers["src/App.java"];

    // Regression invariant — lastRunInputHash sticks to the first hydration;
    // displayedArtifactSourceHash tracks the latest BFF payload.
    expect(entry.lastRunInputHash).toBe(firstLastRunInput);
    expect(entry.displayedArtifactSourceHash).not.toBe(firstDisplayed);
    expect(entry.generatorBaselineRunId).toBe("run-2");

    const flags = result.current.javaStatusFlags("src/App.java");
    expect(flags.staleJava).toBe(true);
    expect(flags.clean).toBe(false);
  });

  it("keeps a dirty user-edit buffer when a new run lands; refreshes only the baseline metadata", async () => {
    const { result } = renderHook(() => useTransformationRun(), { wrapper });

    await act(async () => {
      await result.current.ensureJavaBaseline(
        "src/App.java",
        "public class App {}",
        "run-1",
      );
    });

    act(() => {
      result.current.setJavaBufferContent(
        "src/App.java",
        "public class App { /* user edit */ }",
      );
    });
    expect(result.current.javaBuffers["src/App.java"].isDirty).toBe(true);

    await act(async () => {
      await result.current.ensureJavaBaseline(
        "src/App.java",
        "public class App { int regenerated; }",
        "run-2",
      );
    });

    const entry = result.current.javaBuffers["src/App.java"];
    // User content is preserved.
    expect(entry.content).toContain("/* user edit */");
    expect(entry.isDirty).toBe(true);
    // Baseline metadata is rotated to the new run.
    expect(entry.generatorBaselineRunId).toBe("run-2");
    expect(entry.generatorBaselineContent).toContain("int regenerated");
  });

  it("manualEditsPresent flips on when the buffer hash diverges from the Generator Baseline (#247 V2 chip)", async () => {
    const { result } = renderHook(() => useTransformationRun(), { wrapper });

    await act(async () => {
      await result.current.ensureJavaBaseline(
        "src/App.java",
        "public class App {}",
        "run-1",
      );
    });
    // Fresh baseline: buffer matches the generator output exactly, so the
    // V2 chip stays off.
    expect(
      result.current.javaStatusFlags("src/App.java").manualEditsPresent,
    ).toBe(false);

    // User edits the Java buffer locally. setJavaBufferContent schedules
    // an async crypto.subtle.digest to recompute the buffer hash; on a
    // slow CI runner two microtask flushes are not always enough.
    // waitFor polls until the chip derivation reflects the new hash.
    act(() => {
      result.current.setJavaBufferContent(
        "src/App.java",
        "public class App { /* user edit */ }",
      );
    });
    await waitFor(() => {
      expect(
        result.current.javaStatusFlags("src/App.java").manualEditsPresent,
      ).toBe(true);
    });

    // Revert to the exact baseline → the chip clears even though isDirty
    // tracked the round-trip.
    act(() => {
      result.current.setJavaBufferContent(
        "src/App.java",
        "public class App {}",
      );
    });
    await waitFor(() => {
      expect(
        result.current.javaStatusFlags("src/App.java").manualEditsPresent,
      ).toBe(false);
    });
  });

  it("javaStatusFlags returns false for all flags when the file path has no entry", () => {
    const { result } = renderHook(() => useTransformationRun(), { wrapper });
    const flags = result.current.javaStatusFlags("unknown.java");
    expect(flags).toEqual({
      clean: false,
      pendingReRun: false,
      staleJava: false,
      manualEditsPresent: false,
    });
  });
});

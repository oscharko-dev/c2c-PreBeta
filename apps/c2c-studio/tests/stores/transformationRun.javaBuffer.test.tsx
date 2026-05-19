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

  it("on a subsequent clean run, lastRunInputHash advances with the displayed artifact so the file is not stale", async () => {
    const { result } = renderHook(() => useTransformationRun(), { wrapper });

    await act(async () => {
      await result.current.ensureJavaBaseline(
        "src/App.java",
        "public class App {}",
        "run-1",
      );
    });
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

    // Expanded Issue #245 invariant — a clean buffer accepts the latest
    // generated artifact as the current run input. Preserving the old hash
    // would leave the badge stuck on "Stale" after a successful follow-up run.
    expect(entry.lastRunInputHash).toBe(entry.displayedArtifactSourceHash);
    expect(entry.displayedArtifactSourceHash).not.toBe(firstDisplayed);
    expect(entry.generatorBaselineRunId).toBe("run-2");

    const flags = result.current.javaStatusFlags("src/App.java");
    expect(flags.staleJava).toBe(false);
    expect(flags.clean).toBe(true);
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

// Studio-IDE-13 (#255) AC3 / AC5 / AC6: 3-Way Merge state lifecycle in
// the store. These tests pin the contract between
// ``requestJavaMergeReview``, ``applyJavaMergeSelections``, and
// ``cancelJavaMergeReview`` so the GeneratedJavaEditorPane's auto-open
// path and the ThreeWayMergeDialog's Apply/Cancel paths stay aligned
// with the buffer model.
describe("transformationRun: 3-Way Merge state (IDE-13)", () => {
  it("requestJavaMergeReview computes conflict regions and exposes them on the store", () => {
    const { result } = renderHook(() => useTransformationRun(), { wrapper });
    act(() => {
      result.current.requestJavaMergeReview({
        filePath: "src/App.java",
        baselineContent: "a\nb\nc\n",
        manualContent: "a\nMAN\nc\n",
        newGeneratorContent: "a\nGEN\nc\n",
        newGeneratorRunId: "run-2",
      });
    });
    const review = result.current.javaMergeReview;
    expect(review).not.toBeNull();
    expect(review?.filePath).toBe("src/App.java");
    expect(review?.regions.length).toBeGreaterThan(0);
    // The middle line is a true conflict — both diverged differently.
    const conflict = review?.regions.find((r) => r.conflictKind === "conflict");
    expect(conflict).toBeDefined();
    expect(conflict?.needsUserPick).toBe(true);
  });

  it("applyJavaMergeSelections writes merged content + advances the generator baseline (AC5)", async () => {
    const { result } = renderHook(() => useTransformationRun(), { wrapper });
    await act(async () => {
      await result.current.ensureJavaBaseline(
        "src/App.java",
        "a\nb\nc\n",
        "run-1",
      );
    });
    act(() => {
      result.current.setJavaBufferContent("src/App.java", "a\nMAN\nc\n");
    });
    act(() => {
      result.current.requestJavaMergeReview({
        filePath: "src/App.java",
        baselineContent: "a\nb\nc\n",
        manualContent: "a\nMAN\nc\n",
        newGeneratorContent: "a\nGEN\nc\n",
        newGeneratorRunId: "run-2",
      });
    });
    const review = result.current.javaMergeReview;
    expect(review).not.toBeNull();
    const conflict = review!.regions.find(
      (r) => r.conflictKind === "conflict",
    )!;
    const conflictKey = `${conflict.conflictKind}:${conflict.lineRange.startLine}-${conflict.lineRange.endLine}`;
    await act(async () => {
      await result.current.applyJavaMergeSelections({
        [conflictKey]: "newGenerator",
      });
    });
    // Dialog cleared.
    expect(result.current.javaMergeReview).toBeNull();
    // Buffer now matches the new generator output; baseline metadata
    // advanced to the run that produced it.
    const entry = result.current.javaBuffers["src/App.java"]!;
    expect(entry.content).toBe("a\nGEN\nc\n");
    expect(entry.generatorBaselineContent).toBe("a\nGEN\nc\n");
    expect(entry.generatorBaselineRunId).toBe("run-2");
    expect(entry.lastRunInputHash).toBe(entry.displayedArtifactSourceHash);
    expect(entry.isDirty).toBe(false);
  });

  it("cancelJavaMergeReview clears the review without touching the buffer (AC6)", async () => {
    const { result } = renderHook(() => useTransformationRun(), { wrapper });
    await act(async () => {
      await result.current.ensureJavaBaseline(
        "src/App.java",
        "a\nb\nc\n",
        "run-1",
      );
    });
    act(() => {
      result.current.setJavaBufferContent("src/App.java", "a\nMAN\nc\n");
    });
    act(() => {
      result.current.requestJavaMergeReview({
        filePath: "src/App.java",
        baselineContent: "a\nb\nc\n",
        manualContent: "a\nMAN\nc\n",
        newGeneratorContent: "a\nGEN\nc\n",
        newGeneratorRunId: "run-2",
      });
    });
    const beforeCancel = result.current.javaBuffers["src/App.java"]!.content;
    act(() => {
      result.current.cancelJavaMergeReview();
    });
    expect(result.current.javaMergeReview).toBeNull();
    expect(result.current.javaBuffers["src/App.java"]!.content).toBe(
      beforeCancel,
    );
  });
});

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import React, { type ReactNode } from "react";

import {
  TransformationRunProvider,
  useTransformationRun,
} from "@/stores/transformationRun";
import type { JavaOriginOverlay } from "@/types/api";

const { getCurrentDraftScopeMock, loadDraftMock, saveDraftMock } = vi.hoisted(
  () => ({
    getCurrentDraftScopeMock: vi.fn(),
    loadDraftMock: vi.fn(),
    saveDraftMock: vi.fn(),
  }),
);

vi.mock("@/lib/editor/editorPersistence", () => ({
  getCurrentDraftScope: getCurrentDraftScopeMock,
  subscribeToDraftPersistenceEvents: vi.fn(() => () => {}),
  editorPersistence: {
    loadDraft: loadDraftMock,
    saveDraft: saveDraftMock,
  },
}));

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
  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentDraftScopeMock.mockResolvedValue({
      tenantId: "tenant-A",
      userId: "user-1",
    });
    loadDraftMock.mockResolvedValue(null);
    saveDraftMock.mockResolvedValue({
      encryptedSize: 1,
      ttlExpiresAt: "2026-06-02T00:00:00.000Z",
    });
  });

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

  it("keeps a dirty user-edit buffer and baseline when a divergent new run lands", async () => {
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
    // Baseline metadata stays anchored to the pre-merge generator run; the
    // 3-Way Merge apply path is the only place that can advance it.
    expect(entry.generatorBaselineRunId).toBe("run-1");
    expect(entry.generatorBaselineContent).toBe("public class App {}");
  });

  it("advances a dirty buffer baseline when the new generator output already matches the buffer", async () => {
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

    await act(async () => {
      await result.current.ensureJavaBaseline(
        "src/App.java",
        "public class App { /* user edit */ }",
        "run-2",
      );
    });

    const entry = result.current.javaBuffers["src/App.java"];
    expect(entry.content).toBe("public class App { /* user edit */ }");
    expect(entry.generatorBaselineRunId).toBe("run-2");
    expect(entry.generatorBaselineContent).toBe(
      "public class App { /* user edit */ }",
    );
    expect(entry.bufferHash).toBe(entry.generatorBaselineHash);
    expect(entry.isDirty).toBe(false);
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

  it("tracks manual edits independently across multiple Java buffers and clears only the reverted file", async () => {
    const { result } = renderHook(() => useTransformationRun(), { wrapper });

    await act(async () => {
      await result.current.ensureJavaBaseline(
        "src/App.java",
        "public class App {}",
        "run-1",
      );
      await result.current.ensureJavaBaseline(
        "src/Helper.java",
        "public class Helper {}",
        "run-1",
      );
    });

    act(() => {
      result.current.setJavaBufferContent(
        "src/App.java",
        "public class App { int appEdit; }",
      );
      result.current.setJavaBufferContent(
        "src/Helper.java",
        "public class Helper { int helperEdit; }",
      );
    });

    await waitFor(() => {
      expect(
        result.current.javaStatusFlags("src/App.java").manualEditsPresent,
      ).toBe(true);
      expect(
        result.current.javaStatusFlags("src/Helper.java").manualEditsPresent,
      ).toBe(true);
    });

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
      expect(
        result.current.javaStatusFlags("src/Helper.java").manualEditsPresent,
      ).toBe(true);
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

  it("saveJavaDraft persists manualEditOverlay and lastRunInputContent", async () => {
    const overlay: JavaOriginOverlay = {
      schemaVersion: "v0",
      runId: "run-1",
      javaFile: "src/App.java",
      regions: [
        {
          lineRange: { startLine: 1, endLine: 1 },
          originClass: "manual_modified",
        },
      ],
    };
    const { result } = renderHook(() => useTransformationRun(), { wrapper });

    act(() => {
      result.current.setState((prev) => ({
        ...prev,
        runId: "run-1",
        programId: "APP",
      }));
    });
    await act(async () => {
      await result.current.ensureJavaBaseline(
        "src/App.java",
        "public class App {}",
        "run-1",
      );
    });
    act(() => {
      result.current.setJavaManualOverlay("src/App.java", overlay);
    });

    await act(async () => {
      await result.current.saveJavaDraft("src/App.java");
    });

    expect(saveDraftMock).toHaveBeenCalledWith(
      { tenantId: "tenant-A", userId: "user-1" },
      {
        kind: "java",
        programId: "APP",
        sourceName: "App.java",
        javaFilePath: "src/App.java",
      },
      expect.objectContaining({
        kind: "java",
        content: "public class App {}",
        lastRunInputContent: "public class App {}",
        manualEditOverlay: overlay,
      }),
    );
  });

  it("persists Java conflict resolution and skips the same conflict on reopen", async () => {
    const { result } = renderHook(() => useTransformationRun(), { wrapper });
    act(() => {
      result.current.setState((prev) => ({
        ...prev,
        runId: "run-1",
        programId: "APP",
      }));
    });
    await act(async () => {
      await result.current.ensureJavaBaseline(
        "src/App.java",
        "backend version",
        "run-1",
      );
    });

    const savedPayloads: unknown[] = [];
    loadDraftMock.mockResolvedValueOnce({
      payload: {
        schemaVersion: "v0",
        kind: "java",
        content: "local version",
        bufferHash: "local-hash",
        lastRunInputHash: "last-hash",
        lastRunInputContent: "last run version",
        generatorBaselineHash:
          result.current.javaBuffers["src/App.java"].generatorBaselineHash,
        generatorBaselineRunId: "run-1",
        savedAt: "2026-05-19T00:00:00.000Z",
      },
      isExpired: false,
      savedAt: "2026-05-19T00:00:00.000Z",
      ttlExpiresAt: "2026-06-02T00:00:00.000Z",
    });
    saveDraftMock.mockImplementation(async (...args: unknown[]) => {
      savedPayloads.push(args[2]);
      return {
        encryptedSize: 1,
        ttlExpiresAt: "2026-06-02T00:00:00.000Z",
      };
    });

    await act(async () => {
      await result.current.loadJavaDraftFor("src/App.java", "backend version");
    });
    expect(result.current.javaConflict).toEqual(
      expect.objectContaining({
        localDraft: "local version",
        lastRunInput: "last run version",
      }),
    );

    act(() => {
      result.current.resolveJavaConflict("localDraft");
    });
    await waitFor(() => expect(saveDraftMock).toHaveBeenCalledTimes(1));
    expect(savedPayloads[0]).toEqual(
      expect.objectContaining({
        content: "local version",
        lastRunInputContent: "last run version",
        resolvedBackendHash: expect.any(String),
      }),
    );
    expect(result.current.javaConflict).toBeNull();

    loadDraftMock.mockResolvedValueOnce({
      payload: savedPayloads[0],
      isExpired: false,
      savedAt: "2026-05-19T00:00:00.000Z",
      ttlExpiresAt: "2026-06-02T00:00:00.000Z",
    });
    await act(async () => {
      await result.current.loadJavaDraftFor("src/App.java", "backend version");
    });

    expect(result.current.javaConflict).toBeNull();
    expect(result.current.javaBuffers["src/App.java"].content).toBe(
      "local version",
    );
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

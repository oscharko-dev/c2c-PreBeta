/**
 * Studio-IDE-7 (#252): component tests for DiffWorkspace.
 *
 * Mocks the CodeEditor surface (Monaco) and the traceability fetch so we
 * can exercise the empty-state, lineage-unavailable, and linked-scroll
 * toggle behavior without spinning up Monaco in jsdom.
 */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { DiffWorkspace } from "@/components/diff/DiffWorkspace";
import type {
  CobolSnapshot,
  JavaFileHistoryEntry,
} from "@/lib/editor/diffHistory";

type DiffEditorMockProps = {
  language: string;
  original: string;
  value: string;
  modelUri?: string;
  originalModelUri?: string;
  ariaLabel?: string;
  className?: string;
};

interface CapturedMount {
  language: string;
  original: string;
  value: string;
  modelUri: string | undefined;
  originalModelUri: string | undefined;
  ariaLabel: string | undefined;
}

const diffMounts: CapturedMount[] = [];

vi.mock("@/components/editor/CodeEditor", async () => {
  const reactNs = await import("react");
  const CodeEditor = (props: DiffEditorMockProps) => {
    reactNs.useEffect(() => {
      diffMounts.push({
        language: props.language,
        original: props.original,
        value: props.value,
        modelUri: props.modelUri,
        originalModelUri: props.originalModelUri,
        ariaLabel: props.ariaLabel,
      });
    }, []);
    return reactNs.createElement(
      "div",
      {
        "data-testid": "diff-editor-mock",
        "data-language": props.language,
        "data-model-uri": props.modelUri,
        "data-original-uri": props.originalModelUri,
        "aria-label": props.ariaLabel,
        className: props.className,
      },
      reactNs.createElement("pre", { "data-side": "original" }, props.original),
      reactNs.createElement("pre", { "data-side": "modified" }, props.value),
    );
  };
  return { CodeEditor };
});

const fetchTraceabilityMock = vi.fn();
const TraceabilityNotFoundErrorRef = vi.hoisted(
  () =>
    class TraceabilityNotFoundError extends Error {
      readonly runId: string;
      constructor(runId: string) {
        super(`Traceability not found for runId=${runId}`);
        this.name = "TraceabilityNotFoundError";
        this.runId = runId;
      }
    },
);

vi.mock("@/lib/editor/traceParser", () => ({
  fetchTraceability: (...args: unknown[]) => fetchTraceabilityMock(...args),
  TraceabilityNotFoundError: TraceabilityNotFoundErrorRef,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const javaWithPrevious: JavaFileHistoryEntry = {
  previous: {
    content: "class A {}\n",
    sourceHash: "aaaa1111",
    runId: "run-1-deadbeef",
  },
  current: {
    content: "class A { int x; }\n",
    sourceHash: "bbbb2222",
    runId: "run-2-cafefeed",
  },
};

const javaNoPrevious: JavaFileHistoryEntry = {
  previous: null,
  current: {
    content: "class A {}\n",
    sourceHash: "aaaa1111",
    runId: "run-1-deadbeef",
  },
};

const cobolSnapshotPrev: CobolSnapshot = {
  content: "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. A.\n",
  sourceHash: "aaaa1111",
  runId: "run-1-deadbeef",
};
const cobolSnapshotCurrent: CobolSnapshot = {
  content: "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. EDITED.\n",
  sourceHash: "bbbb2222",
  runId: "run-2-cafefeed",
};
const cobolSnapshotsByRun: Record<string, CobolSnapshot> = {
  "run-1-deadbeef": cobolSnapshotPrev,
  "run-2-cafefeed": cobolSnapshotCurrent,
};

const parsedTraceWithLineage = {
  runId: "run-2-cafefeed",
  programId: "PRG",
  trace: null,
  irSymbolMap: new Map([
    [
      "s-move-1",
      { cobolFile: "main.cob", cobolLine: 12, irNodeId: "s-move-1" },
    ],
  ]),
  javaRegionClassification: new Map([
    [
      "src/Foo.java",
      [
        {
          lineRange: { startLine: 1, endLine: 50 },
          originClass: "deterministic" as const,
          verificationOutcome: "exact_match" as const,
          mappingClass: "direct" as const,
        },
      ],
    ],
  ]),
};

const parsedTraceWithoutLineage = {
  runId: "run-2-cafefeed",
  programId: "PRG",
  trace: null,
  irSymbolMap: new Map(),
  javaRegionClassification: new Map(),
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DiffWorkspace", () => {
  beforeEach(() => {
    diffMounts.length = 0;
    fetchTraceabilityMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("empty state", () => {
    it("renders the no-previous-run notice when javaHistory is undefined", () => {
      const onClose = vi.fn();
      render(
        <DiffWorkspace
          filePath="src/Foo.java"
          sourceKey="PRG"
          runId="run-2-cafefeed"
          javaHistory={undefined}
          cobolSnapshotsByRun={cobolSnapshotsByRun}
          onClose={onClose}
        />,
      );

      expect(screen.getByTestId("diff-workspace-empty")).toBeInTheDocument();
      expect(
        screen.getByText("No previous run for this file to compare."),
      ).toBeInTheDocument();
      // No Monaco diff editor must mount in the empty state.
      expect(diffMounts).toHaveLength(0);
    });

    it("renders the no-previous-run notice when javaHistory.previous is null", () => {
      render(
        <DiffWorkspace
          filePath="src/Foo.java"
          sourceKey="PRG"
          runId="run-1-deadbeef"
          javaHistory={javaNoPrevious}
          cobolSnapshotsByRun={undefined}
          onClose={vi.fn()}
        />,
      );

      expect(screen.getByTestId("diff-workspace-empty")).toBeInTheDocument();
      expect(diffMounts).toHaveLength(0);
    });

    it("invokes onClose when the close button is pressed in the empty shell", () => {
      const onClose = vi.fn();
      render(
        <DiffWorkspace
          filePath="src/Foo.java"
          sourceKey="PRG"
          runId="run-2-cafefeed"
          javaHistory={undefined}
          cobolSnapshotsByRun={undefined}
          onClose={onClose}
        />,
      );

      fireEvent.click(screen.getByLabelText("Close compare runs"));
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("invokes onClose when Escape is pressed in the empty shell", () => {
      const onClose = vi.fn();
      render(
        <DiffWorkspace
          filePath="src/Foo.java"
          sourceKey="PRG"
          runId="run-2-cafefeed"
          javaHistory={undefined}
          cobolSnapshotsByRun={undefined}
          onClose={onClose}
        />,
      );

      fireEvent.keyDown(screen.getByTestId("diff-workspace-empty"), {
        key: "Escape",
      });
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("populated state with lineage", () => {
    beforeEach(() => {
      fetchTraceabilityMock.mockResolvedValue(parsedTraceWithLineage);
    });

    it("renders Java and COBOL diff editors with the expected sides", async () => {
      render(
        <DiffWorkspace
          filePath="src/Foo.java"
          sourceKey="PRG"
          runId="run-2-cafefeed"
          javaHistory={javaWithPrevious}
          cobolSnapshotsByRun={cobolSnapshotsByRun}
          onClose={vi.fn()}
        />,
      );

      await waitFor(() => {
        expect(diffMounts.length).toBeGreaterThanOrEqual(2);
      });

      const java = diffMounts.find((m) => m.language === "java");
      const cobol = diffMounts.find((m) => m.language === "cobol");
      expect(java).toBeDefined();
      expect(java?.original).toBe(javaWithPrevious.previous!.content);
      expect(java?.value).toBe(javaWithPrevious.current.content);
      expect(cobol).toBeDefined();
      expect(cobol?.original).toBe(cobolSnapshotPrev.content);
      expect(cobol?.value).toBe(cobolSnapshotCurrent.content);
    });

    it("enables the Linked scroll toggle and starts on", async () => {
      render(
        <DiffWorkspace
          filePath="src/Foo.java"
          sourceKey="PRG"
          runId="run-2-cafefeed"
          javaHistory={javaWithPrevious}
          cobolSnapshotsByRun={cobolSnapshotsByRun}
          onClose={vi.fn()}
        />,
      );

      const toggle = await screen.findByLabelText("Linked scroll");
      expect(toggle).not.toBeDisabled();
      expect((toggle as HTMLInputElement).checked).toBe(true);

      const root = screen.getByTestId("diff-workspace");
      await waitFor(() =>
        expect(root.getAttribute("data-linked-scroll")).toBe("true"),
      );

      fireEvent.click(toggle);
      await waitFor(() =>
        expect(root.getAttribute("data-linked-scroll")).toBe("false"),
      );
    });

    it("uses stable, scoped model URIs for view-state preservation", async () => {
      render(
        <DiffWorkspace
          filePath="src/Foo.java"
          sourceKey="PRG"
          runId="run-2-cafefeed"
          javaHistory={javaWithPrevious}
          cobolSnapshotsByRun={cobolSnapshotsByRun}
          onClose={vi.fn()}
        />,
      );

      await waitFor(() => expect(diffMounts.length).toBeGreaterThanOrEqual(2));
      const java = diffMounts.find((m) => m.language === "java");
      const cobol = diffMounts.find((m) => m.language === "cobol");
      expect(java?.modelUri).toBe(
        "inmemory://c2c-studio/diff/java/PRG/run-2-cafefeed/src/Foo.java~modified",
      );
      expect(java?.originalModelUri).toBe(
        "inmemory://c2c-studio/diff/java/PRG/run-1-deadbeef/src/Foo.java~original",
      );
      expect(cobol?.modelUri).toBe(
        "inmemory://c2c-studio/diff/cobol/PRG/run-2-cafefeed~modified",
      );
      expect(cobol?.originalModelUri).toBe(
        "inmemory://c2c-studio/diff/cobol/PRG/run-1-deadbeef~original",
      );
    });

    it("invokes onClose when Escape is pressed in the populated workspace", async () => {
      const onClose = vi.fn();
      render(
        <DiffWorkspace
          filePath="src/Foo.java"
          sourceKey="PRG"
          runId="run-2-cafefeed"
          javaHistory={javaWithPrevious}
          cobolSnapshotsByRun={cobolSnapshotsByRun}
          onClose={onClose}
        />,
      );

      fireEvent.keyDown(await screen.findByTestId("diff-workspace"), {
        key: "Escape",
      });
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("lineage unavailable", () => {
    beforeEach(() => {
      fetchTraceabilityMock.mockResolvedValue(parsedTraceWithoutLineage);
    });

    it("renders both diffs and shows the un-coupled notice", async () => {
      render(
        <DiffWorkspace
          filePath="src/Foo.java"
          sourceKey="PRG"
          runId="run-2-cafefeed"
          javaHistory={javaWithPrevious}
          cobolSnapshotsByRun={cobolSnapshotsByRun}
          onClose={vi.fn()}
        />,
      );

      await waitFor(() => expect(diffMounts.length).toBeGreaterThanOrEqual(2));
      const notice = await screen.findByTestId(
        "diff-workspace-uncoupled-notice",
      );
      expect(notice).toHaveTextContent(
        "Lineage unavailable — scrolls are independent.",
      );
      // Toggle is forced off and disabled.
      const toggle = screen.getByLabelText("Linked scroll") as HTMLInputElement;
      await waitFor(() => expect(toggle.checked).toBe(false));
      expect(toggle).toBeDisabled();
    });
  });

  describe("traceability fetch failure", () => {
    it("treats 404 lineage as un-coupled and still renders diffs", async () => {
      fetchTraceabilityMock.mockRejectedValue(
        new TraceabilityNotFoundErrorRef("run-2-cafefeed"),
      );
      render(
        <DiffWorkspace
          filePath="src/Foo.java"
          sourceKey="PRG"
          runId="run-2-cafefeed"
          javaHistory={javaWithPrevious}
          cobolSnapshotsByRun={cobolSnapshotsByRun}
          onClose={vi.fn()}
        />,
      );

      await waitFor(() => expect(diffMounts.length).toBeGreaterThanOrEqual(2));
      const notice = await screen.findByTestId(
        "diff-workspace-uncoupled-notice",
      );
      expect(notice).toBeInTheDocument();
    });
  });

  describe("missing COBOL history", () => {
    beforeEach(() => {
      fetchTraceabilityMock.mockResolvedValue(parsedTraceWithLineage);
    });

    it("renders Java diff and shows the no-COBOL notice; coupling disabled", async () => {
      render(
        <DiffWorkspace
          filePath="src/Foo.java"
          sourceKey="PRG"
          runId="run-2-cafefeed"
          javaHistory={javaWithPrevious}
          cobolSnapshotsByRun={undefined}
          onClose={vi.fn()}
        />,
      );

      await waitFor(() => {
        const java = diffMounts.find((m) => m.language === "java");
        expect(java).toBeDefined();
      });
      expect(
        screen.getByTestId("diff-workspace-cobol-empty"),
      ).toBeInTheDocument();
      const toggle = screen.getByLabelText("Linked scroll") as HTMLInputElement;
      await waitFor(() => expect(toggle).toBeDisabled());
    });
  });

  describe("desync resilience (Copilot review #282)", () => {
    beforeEach(() => {
      fetchTraceabilityMock.mockResolvedValue(parsedTraceWithLineage);
    });

    it("pairs COBOL by Java runIds — failed runs between successes do not desync the panes", async () => {
      // Scenario: run-1 succeeded, run-failed completed without Java, then
      // run-3 succeeded. The COBOL map carries snapshots for all three
      // runIds. Java history points at run-1 → run-3 (run-failed is
      // skipped because it produced no Java content). The workspace must
      // pair COBOL[run-1] with COBOL[run-3], NOT COBOL[run-failed] with
      // COBOL[run-3].
      const javaSkippingFailed: JavaFileHistoryEntry = {
        previous: {
          content: "class A {}\n",
          sourceHash: "aaaa1111",
          runId: "run-1-deadbeef",
        },
        current: {
          content: "class A { int z; }\n",
          sourceHash: "cccc3333",
          runId: "run-3-feedbeef",
        },
      };
      const cobolWithFailedBetween: Record<string, CobolSnapshot> = {
        "run-1-deadbeef": cobolSnapshotPrev,
        // The failed run's COBOL was still recorded — keying by runId
        // means it sits inert in the map without shifting anything.
        "run-failed-cafe": {
          content: "       FAILED RUN\n",
          sourceHash: "feeefeee",
          runId: "run-failed-cafe",
        },
        "run-3-feedbeef": cobolSnapshotCurrent,
      };

      render(
        <DiffWorkspace
          filePath="src/Foo.java"
          sourceKey="PRG"
          runId="run-3-feedbeef"
          javaHistory={javaSkippingFailed}
          cobolSnapshotsByRun={cobolWithFailedBetween}
          onClose={vi.fn()}
        />,
      );

      await waitFor(() => expect(diffMounts.length).toBeGreaterThanOrEqual(2));
      const cobol = diffMounts.find((m) => m.language === "cobol");
      expect(cobol).toBeDefined();
      // The COBOL pane reflects run-1 → run-3 (skipping the failed run),
      // matching the Java pane exactly.
      expect(cobol?.original).toBe(cobolSnapshotPrev.content);
      expect(cobol?.value).toBe(cobolSnapshotCurrent.content);
      expect(cobol?.original).not.toContain("FAILED RUN");
      expect(cobol?.value).not.toContain("FAILED RUN");
    });
  });
});

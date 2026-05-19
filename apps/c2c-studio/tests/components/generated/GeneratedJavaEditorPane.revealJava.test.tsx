// Studio-IDE-8 (#253): the Java pane listens for `c2c:reveal-java`
// window events emitted by the COBOL pane (Alt+J) and the
// stack-trace view. This test verifies the listener registers on
// mount, picks the right generated file via path-suffix matching,
// and calls `revealLineInCenterIfOutsideViewport` on the editor
// instance with the requested line.

import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { GeneratedJavaEditorPane } from "@/components/generated/GeneratedJavaEditorPane";
import { GeneratedArtifactsProvider } from "@/hooks/useGeneratedArtifacts";
import { OriginOverlayProvider } from "@/lib/editor/originOverlay";
import { LineageCoverageProvider } from "@/stores/lineageCoverage";
import { apiClient } from "@/lib/apiClient";
import type { ApiResult, GeneratedFileContent } from "@/types/api";

// Capture editor mount args + reveal calls. The mock's onMount fires a
// fake editor object whose methods record their arguments so the test
// can assert against them. Unlike the broad pane test file we do not
// rely on the textarea fallback — the pane reads
// `editorInstanceRef.current?.revealLineInCenterIfOutsideViewport`, so
// the mock must hand the pane something that exposes that method.
interface FakeJavaEditor {
  revealLineInCenterIfOutsideViewport: (line: number) => void;
  setPosition: (pos: { lineNumber: number; column: number }) => void;
  focus: () => void;
  addCommand: (binding: number, callback: () => void) => void;
  addAction: (descriptor: {
    id: string;
    run: (ed: unknown) => unknown;
  }) => void;
  updateOptions: (options: unknown) => void;
  onDidFocusEditorText?: (cb: () => void) => void;
  getModel: () => null;
  getPosition: () => { lineNumber: number; column: number };
}

const revealCalls: number[] = [];
const revealCallDetails: Array<{
  line: number;
  modelUri: string | undefined;
}> = [];
const setPositionCalls: Array<{ lineNumber: number; column: number }> = [];
const focusCalls: number[] = [];
let currentModelUri: string | undefined;

const fakeJavaEditor: FakeJavaEditor = {
  revealLineInCenterIfOutsideViewport: (line) => {
    revealCalls.push(line);
    revealCallDetails.push({ line, modelUri: currentModelUri });
  },
  setPosition: (pos) => {
    setPositionCalls.push(pos);
  },
  focus: () => {
    focusCalls.push(1);
  },
  addCommand: () => undefined,
  addAction: () => undefined,
  updateOptions: () => undefined,
  onDidFocusEditorText: () => undefined,
  getModel: () => null,
  getPosition: () => ({ lineNumber: 1, column: 1 }),
};

type EditorMockProps = {
  value: string;
  onChange?: (next: string) => void;
  onMount?: (args: { editor: FakeJavaEditor; monaco: unknown }) => void;
  ariaLabel?: string;
  language: string;
  mode: string;
  modelUri?: string;
  className?: string;
};

vi.mock("@/components/editor/CodeEditor", async () => {
  const reactNs = await import("react");
  const CodeEditor = (props: EditorMockProps) => {
    currentModelUri = props.modelUri;
    reactNs.useEffect(() => {
      props.onMount?.({
        editor: fakeJavaEditor,
        monaco: {
          KeyMod: { CtrlCmd: 1 << 11, Alt: 1 << 9, Shift: 1 << 10 },
          KeyCode: { KeyS: 49, KeyJ: 41, F8: 67 },
          MarkerSeverity: { Info: 2 },
          editor: { setModelMarkers: () => undefined },
        },
      });
      // Mount-time only.
    }, []);
    return reactNs.createElement("textarea", {
      "aria-label": props.ariaLabel,
      "data-language": props.language,
      "data-mode": props.mode,
      "data-model-uri": props.modelUri,
      "data-testid": "code-editor-mock",
      className: props.className,
      readOnly: props.mode === "readonly",
      value: props.value,
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
        props.onChange?.(event.currentTarget.value),
      spellCheck: false,
    });
  };
  return { CodeEditor };
});

vi.mock("@/lib/apiClient", () => ({
  apiClient: {
    getGeneratedFile: vi.fn(),
  },
}));

// Stub Monaco / language registrations so the pane mounts cheaply.
vi.mock("@/lib/editor/lazyMonaco", () => ({
  getMonaco: () => new Promise(() => undefined),
  useMonacoReady: () => null,
}));

// Stub the lineage-overlay fetches — the listener test does not depend
// on them but the pane unconditionally schedules them on mount.
vi.mock("@/lib/editor/traceParser", () => ({
  fetchTraceability: () => Promise.reject(new Error("not used in this test")),
  TraceabilityNotFoundError: class TraceabilityNotFoundError extends Error {},
}));

vi.mock("@/lib/editor/lineageNavigation", () => ({
  resolveJavaToCobol: () =>
    Promise.resolve({ ok: false, reason: "no_mapping" }),
}));

const mockTransformationState = vi.fn();

vi.mock("@/stores/transformationRun", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/stores/transformationRun")>();
  const { deriveProductState } = await import("@/types/state");
  return {
    ...actual,
    useTransformationRun: () => {
      const state = mockTransformationState();
      return {
        state,
        productState: deriveProductState(state),
        javaBuffers: {},
        javaConflict: null,
        saveNoticeAt: null,
        ensureJavaBaseline: vi.fn(),
        setJavaBufferContent: vi.fn(),
        setJavaManualOverlay: vi.fn(),
        saveJavaDraft: vi.fn(),
        loadJavaDraftFor: vi.fn(),
        resolveJavaConflict: vi.fn(),
        dismissJavaConflict: vi.fn(),
        javaStatusFlags: () => ({
          clean: false,
          pendingReRun: false,
          staleJava: false,
          manualEditsPresent: false,
        }),
        javaMergeReview: null,
        requestJavaMergeReview: vi.fn(),
        applyJavaMergeSelections: vi.fn(),
        cancelJavaMergeReview: vi.fn(),
        javaDiffHistory: {},
        cobolDiffHistory: {},
        recordJavaDiffSnapshot: vi.fn(),
      };
    },
  };
});

function okResult<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

function mockGeneratedFileContents(files: Record<string, string>) {
  vi.mocked(apiClient.getGeneratedFile).mockImplementation(
    async (runId, path) => {
      const content = files[path];
      if (content === undefined) {
        return {
          ok: false,
          status: 404,
          message: "HTTP error 404",
          details: { kind: "http", body: { error: "HTTP error 404" } },
        };
      }
      return okResult<GeneratedFileContent>({
        runId,
        mode: "live",
        productMode: "live",
        path,
        content,
        sha256: "a".repeat(64),
        byteSize: content.length,
        mimeType: "text/x-java-source",
      });
    },
  );
}

const completedRun = (files: string[], entry?: string) => ({
  phase: "completed",
  runId: "run-123",
  generated: { status: "generated", artifactRef: { sha256: "aaaa" } },
  generatedFiles: {
    status: "complete",
    entryFilePath: entry ?? files[0],
    files: files.map((path) => ({ path, sha256: "b".repeat(64) })),
  },
  workflow: null,
});

function renderPane() {
  return render(
    <OriginOverlayProvider>
      <LineageCoverageProvider>
        <GeneratedArtifactsProvider>
          <GeneratedJavaEditorPane />
        </GeneratedArtifactsProvider>
      </LineageCoverageProvider>
    </OriginOverlayProvider>,
  );
}

describe("GeneratedJavaEditorPane c2c:reveal-java listener (Studio-IDE-8 #253)", () => {
  beforeEach(() => {
    revealCalls.length = 0;
    revealCallDetails.length = 0;
    setPositionCalls.length = 0;
    focusCalls.length = 0;
    currentModelUri = undefined;
    vi.mocked(apiClient.getGeneratedFile).mockReset();
  });

  it("reveals the requested line when the event names the currently open file", async () => {
    mockTransformationState.mockReturnValue(
      completedRun(["src/main/java/com/example/Foo.java"]),
    );
    mockGeneratedFileContents({
      "src/main/java/com/example/Foo.java": "// stub",
    });
    renderPane();
    // Wait for the editor mount and initial file content load so the
    // editorInstanceRef is populated.
    await waitFor(() => {
      expect(screen.getByTestId("code-editor-mock")).toBeInTheDocument();
    });
    act(() => {
      window.dispatchEvent(
        new CustomEvent("c2c:reveal-java", {
          detail: {
            javaFile: "src/main/java/com/example/Foo.java",
            javaLine: 42,
          },
        }),
      );
    });
    await waitFor(() => {
      expect(revealCalls).toContain(42);
    });
    expect(setPositionCalls).toContainEqual({ lineNumber: 42, column: 1 });
  });

  it("matches a short file name against the generated full path via suffix match", async () => {
    mockTransformationState.mockReturnValue(
      completedRun(["src/main/java/com/example/Foo.java"]),
    );
    mockGeneratedFileContents({
      "src/main/java/com/example/Foo.java": "// stub",
    });
    renderPane();
    await waitFor(() => {
      expect(screen.getByTestId("code-editor-mock")).toBeInTheDocument();
    });
    act(() => {
      window.dispatchEvent(
        new CustomEvent("c2c:reveal-java", {
          detail: {
            // Short file name; the listener should resolve it to the
            // full generated path before revealing the line.
            javaFile: "Foo.java",
            javaLine: 7,
          },
        }),
      );
    });
    await waitFor(() => {
      expect(revealCalls).toContain(7);
    });
  });

  it("waits for a cross-file selection switch before revealing the Java line", async () => {
    mockTransformationState.mockReturnValue(
      completedRun(
        [
          "src/main/java/com/example/Initial.java",
          "src/main/java/com/example/Foo.java",
        ],
        "src/main/java/com/example/Initial.java",
      ),
    );
    mockGeneratedFileContents({
      "src/main/java/com/example/Initial.java": "// initial",
      "src/main/java/com/example/Foo.java": "// foo",
    });
    renderPane();
    await waitFor(() => {
      expect(screen.getByTestId("code-editor-mock")).toHaveAttribute(
        "data-model-uri",
        "inmemory://c2c-studio/generated/run-123/src/main/java/com/example/Initial.java",
      );
    });
    act(() => {
      window.dispatchEvent(
        new CustomEvent("c2c:reveal-java", {
          detail: {
            javaFile: "Foo.java",
            javaLine: 13,
          },
        }),
      );
    });
    await waitFor(() => {
      expect(screen.getByTestId("code-editor-mock")).toHaveAttribute(
        "data-model-uri",
        "inmemory://c2c-studio/generated/run-123/src/main/java/com/example/Foo.java",
      );
      expect(revealCalls).toContain(13);
    });
    expect(revealCallDetails).toContainEqual({
      line: 13,
      modelUri:
        "inmemory://c2c-studio/generated/run-123/src/main/java/com/example/Foo.java",
    });
  });

  it("is a no-op when no generated file matches the requested path", async () => {
    mockTransformationState.mockReturnValue(
      completedRun(["src/main/java/com/example/Foo.java"]),
    );
    mockGeneratedFileContents({
      "src/main/java/com/example/Foo.java": "// stub",
    });
    renderPane();
    await waitFor(() => {
      expect(screen.getByTestId("code-editor-mock")).toBeInTheDocument();
    });
    // Capture the reveal-call count after the initial mount completes
    // so we can assert no NEW reveal happened for an unknown file.
    const beforeCount = revealCalls.length;
    act(() => {
      window.dispatchEvent(
        new CustomEvent("c2c:reveal-java", {
          detail: {
            javaFile: "Unknown.java",
            javaLine: 99,
          },
        }),
      );
    });
    // Give pending microtasks a chance to flush; the listener must not
    // call revealLineInCenterIfOutsideViewport for an unresolved file.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(revealCalls.length).toBe(beforeCount);
  });
});

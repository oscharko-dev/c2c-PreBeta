import React from "react";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { GeneratedJavaEditorPane } from "@/components/generated/GeneratedJavaEditorPane";
import {
  GeneratedArtifactsProvider,
  useGeneratedArtifacts,
} from "@/hooks/useGeneratedArtifacts";
import {
  MarkerNavigationProvider,
  useMarkerNavigation,
} from "@/lib/editor/markerNavigation";
// Studio-IDE-6 (#248): the Java pane now consumes the OriginOverlay and
// LineageCoverage providers (for trust-pillar overlays and the status-bar
// coverage chip). Both providers are pure context wrappers — the test
// renders them as no-op shells so the existing pane assertions continue
// to exercise the same surface without provider-missing crashes.
import { OriginOverlayProvider } from "@/lib/editor/originOverlay";
import {
  LineageCoverageProvider,
  useLineageCoverage,
} from "@/stores/lineageCoverage";
import {
  JavaEditorActionsProvider,
  useJavaEditorActions,
} from "@/stores/javaEditorActions";
import { apiClient } from "@/lib/apiClient";
import { JAVA_FORMAT_ON_SAVE_STORAGE_KEY } from "@/lib/editor/javaFormatOnSave";
import type { ApiResult, Diagnostic, GeneratedFileContent } from "@/types/api";

vi.mock("@/stores/sourceWorkspace", () => ({
  useSourceWorkspace: () => ({
    statusFlags: {
      clean: true,
      pendingReRun: false,
    },
  }),
}));

const formatJavaSpy = vi.hoisted(() => vi.fn());
const lintJavaSpy = vi.hoisted(() => vi.fn(() => []));
const fetchTraceabilitySpy = vi.hoisted(() => vi.fn());
const resolveJavaToCobolSpy = vi.hoisted(() => vi.fn());

// Studio-IDE-4 (#245): exercise the editor surface (language, mode, model
// URI, onChange) through a textarea-backed CodeEditor mock — Monaco itself
// is covered by tests/components/editor/. The mock captures every mount and
// onChange so the tests can assert the debounced buffer-model wiring.
type EditorMockProps = {
  value: string;
  original?: string;
  onChange?: (next: string) => void;
  onMount?: (args: { editor: FakeEditor | FakeDiffEditor; monaco: typeof fakeMonaco }) => void;
  ariaLabel?: string;
  language: string;
  mode: string;
  modelUri?: string;
  originalModelUri?: string;
  markerGroups?: Array<{ owner: string; markers: unknown[] }>;
  className?: string;
};

type FakeEditor = {
  addCommand: (keybinding: number, callback: () => void) => string;
  addAction: (descriptor: {
    id: string;
    run: (editor: FakeEditor) => unknown;
  }) => { dispose: () => void };
  getModel: () => FakeModel;
  executeEdits: (
    source: string,
    edits: Array<{ text: string }>,
  ) => boolean;
  getPosition: () => { lineNumber: number; column: number };
  getSelection: () => { isEmpty: () => boolean } | null;
  onDidFocusEditorText: (callback: () => void) => { dispose: () => void };
  onDidFocusEditorWidget: (callback: () => void) => { dispose: () => void };
  createDecorationsCollection: (decorations: unknown[]) => {
    set: (decorations: unknown[]) => void;
    clear: () => void;
  };
  revealLineInCenter: (line: number) => void;
  revealLineInCenterIfOutsideViewport: () => void;
  setPosition: () => void;
  focus: () => void;
};

type FakeDiffEditor = {
  getOriginalEditor: () => FakeEditor;
  getModifiedEditor: () => FakeEditor;
  getLineChanges: () => Array<{
    modifiedStartLineNumber: number;
    modifiedEndLineNumber: number;
  }>;
};

type FakeModel = {
  uri: string | undefined;
  getValue: () => string;
  getLineCount: () => number;
  getLineContent: (line: number) => string;
  getLineLength: (line: number) => number;
  getLineMaxColumn: (line: number) => number;
  getValueInRange: () => string;
  getFullModelRange: () => {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
};

const editorMounts: Array<{
  language: string;
  mode: string;
  modelUri: string | undefined;
  ariaLabel: string | undefined;
  value: string;
}> = [];

const editorCommands: Array<{ keybinding: number; callback: () => void }> = [];
const editorActions: Array<{
  id: string;
  run: (editor: FakeEditor) => unknown;
}> = [];
const decorationSetCalls: unknown[][] = [];
const decorationClearCalls: unknown[] = [];
let latestEditorValue = "";
const fakeModelsByUri = new Map<string, FakeModel>();
let currentFakeModel: FakeModel;

function fakeModelFor(modelUri: string | undefined): FakeModel {
  const key = modelUri ?? "__default__";
  const existing = fakeModelsByUri.get(key);
  if (existing) return existing;
  const model: FakeModel = {
    uri: modelUri,
    getValue: () => latestEditorValue,
    getLineCount: () => Math.max(1, latestEditorValue.split("\n").length),
    getLineContent: (line) => latestEditorValue.split("\n")[line - 1] ?? "",
    getLineLength: (line) =>
      (latestEditorValue.split("\n")[line - 1] ?? "").length,
    getLineMaxColumn: (line) =>
      (latestEditorValue.split("\n")[line - 1] ?? "").length + 1,
    getValueInRange: () => latestEditorValue,
    getFullModelRange: () => ({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: Math.max(1, latestEditorValue.split("\n").length),
      endColumn: latestEditorValue.length + 1,
    }),
  };
  fakeModelsByUri.set(key, model);
  return model;
}

currentFakeModel = fakeModelFor(undefined);

const fakeMonaco = vi.hoisted(() => ({
  KeyMod: { CtrlCmd: 1 << 11, Shift: 1 << 10, Alt: 1 << 9 },
  KeyCode: { KeyS: 49, KeyF: 36, KeyJ: 41, KeyE: 35, F5: 66, F7: 67 },
  MarkerSeverity: { Info: 2 },
  editor: { setModelMarkers: vi.fn() },
}));

const fakeEditor: FakeEditor = {
  addCommand: (keybinding, callback) => {
    editorCommands.push({ keybinding, callback });
    return `command-${editorCommands.length}`;
  },
  addAction: (descriptor) => {
    editorActions.push(descriptor);
    return { dispose: vi.fn() };
  },
  getModel: () => currentFakeModel,
  executeEdits: vi.fn((_source, edits) => {
    latestEditorValue = edits[0]?.text ?? latestEditorValue;
    return true;
  }),
  getPosition: () => ({ lineNumber: 1, column: 1 }),
  getSelection: () => null,
  onDidFocusEditorText: () => ({ dispose: vi.fn() }),
  onDidFocusEditorWidget: () => ({ dispose: vi.fn() }),
  createDecorationsCollection: (decorations) => {
    decorationSetCalls.push(decorations);
    return {
      set: (nextDecorations) => {
        decorationSetCalls.push(nextDecorations);
      },
      clear: () => {
        decorationClearCalls.push(true);
      },
    };
  },
  revealLineInCenter: vi.fn(),
  revealLineInCenterIfOutsideViewport: vi.fn(),
  setPosition: vi.fn(),
  focus: vi.fn(),
};

const fakeOriginalEditor: FakeEditor = {
  ...fakeEditor,
  getModel: () => fakeModelFor("__manual-drift-original__"),
};

const fakeDiffEditor: FakeDiffEditor = {
  getOriginalEditor: () => fakeOriginalEditor,
  getModifiedEditor: () => fakeEditor,
  getLineChanges: () => [
    {
      modifiedStartLineNumber: 1,
      modifiedEndLineNumber: 1,
    },
  ],
};

vi.mock("@/components/editor/CodeEditor", async () => {
  const reactNs = await import("react");
  const CodeEditor = (props: EditorMockProps) => {
    latestEditorValue = props.value;
    currentFakeModel = fakeModelFor(props.modelUri);
    reactNs.useEffect(() => {
      editorMounts.push({
        language: props.language,
        mode: props.mode,
        modelUri: props.modelUri,
        ariaLabel: props.ariaLabel,
        value: props.value,
      });
      props.onMount?.({
        editor: props.mode === "diff" ? fakeDiffEditor : fakeEditor,
        monaco: fakeMonaco,
      });
      // Mount-time only — re-firing on every prop change would inflate the
      // mount count and break assertions.
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
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => {
        latestEditorValue = event.currentTarget.value;
        props.onChange?.(event.currentTarget.value);
      },
      spellCheck: false,
    });
  };
  return { CodeEditor };
});

vi.mock("@/lib/editor/lazyMonaco", () => ({
  useMonacoReady: () => fakeMonaco,
}));

vi.mock("@/lib/apiClient", () => ({
  apiClient: {
    getGeneratedFile: vi.fn(),
  },
}));

vi.mock("@/lib/editor/javaFormatClient", () => ({
  formatJava: formatJavaSpy,
}));

vi.mock("@/lib/editor/javaLint", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/editor/javaLint")>();
  return {
    ...actual,
    lintJava: lintJavaSpy,
  };
});

vi.mock("@/lib/editor/traceParser", () => ({
  fetchTraceability: (...args: unknown[]) => fetchTraceabilitySpy(...args),
  TraceabilityNotFoundError: class TraceabilityNotFoundError extends Error {},
}));

vi.mock("@/lib/editor/lineageNavigation", () => ({
  resolveJavaToCobol: (...args: unknown[]) => resolveJavaToCobolSpy(...args),
}));

const mockTransformationState = vi.fn();
const setJavaBufferContentSpy = vi.fn();
const ensureJavaBaselineSpy = vi.fn();
const loadJavaDraftForSpy = vi.fn();
const saveJavaDraftSpy = vi.fn();
const setJavaManualOverlaySpy = vi.fn();
const recordJavaDiffSnapshotSpy = vi.fn();
const requestJavaMergeReviewSpy = vi.fn();
const javaStatusFlagsSpy = vi.fn().mockReturnValue({
  clean: false,
  pendingReRun: false,
  staleJava: false,
  manualEditsPresent: false,
});
const javaBuffersSpy = vi.fn().mockReturnValue({});
const javaDiffHistorySpy = vi.fn().mockReturnValue({});
const cobolDiffHistorySpy = vi.fn().mockReturnValue({});

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
        javaBuffers: javaBuffersSpy(),
        javaConflict: null,
        saveNoticeAt: null,
        ensureJavaBaseline: ensureJavaBaselineSpy,
        setJavaBufferContent: setJavaBufferContentSpy,
        setJavaManualOverlay: setJavaManualOverlaySpy,
        saveJavaDraft: saveJavaDraftSpy,
        loadJavaDraftFor: loadJavaDraftForSpy,
        resolveJavaConflict: vi.fn(),
        dismissJavaConflict: vi.fn(),
        javaStatusFlags: javaStatusFlagsSpy,
        javaMergeReview: null,
        requestJavaMergeReview: requestJavaMergeReviewSpy,
        applyJavaMergeSelections: vi.fn(),
        cancelJavaMergeReview: vi.fn(),
        javaDiffHistory: javaDiffHistorySpy(),
        cobolDiffHistory: cobolDiffHistorySpy(),
        recordJavaDiffSnapshot: recordJavaDiffSnapshotSpy,
      };
    },
  };
});

function okResult<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

function mockGeneratedFileContents(
  files: Record<string, string>,
  shaByPath?: Record<string, string>,
) {
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
        sha256: shaByPath?.[path] ?? "a".repeat(64),
        byteSize: content.length,
        mimeType: "text/x-java-source",
      });
    },
  );
}

function paneTree() {
  return (
    <OriginOverlayProvider>
      <LineageCoverageProvider>
        <GeneratedArtifactsProvider>
          <GeneratedJavaEditorPane />
        </GeneratedArtifactsProvider>
      </LineageCoverageProvider>
    </OriginOverlayProvider>
  );
}

function renderPane() {
  return render(paneTree());
}

function SelectGeneratedFileButton({ path }: { path: string }) {
  const { selectFile } = useGeneratedArtifacts();
  return (
    <button type="button" onClick={() => selectFile(path)}>
      Select {path}
    </button>
  );
}

function renderPaneWithSelector(path: string) {
  return render(
    <OriginOverlayProvider>
      <LineageCoverageProvider>
        <GeneratedArtifactsProvider>
          <SelectGeneratedFileButton path={path} />
          <GeneratedJavaEditorPane />
        </GeneratedArtifactsProvider>
      </LineageCoverageProvider>
    </OriginOverlayProvider>,
  );
}

function CompileCheckStateProbe() {
  const actions = useJavaEditorActions();
  return (
    <span data-testid="compile-check-state">
      {actions.canCompileCheck ? "enabled" : "disabled"}
    </span>
  );
}

function LineageCoverageProbe() {
  const coverage = useLineageCoverage();
  return (
    <span data-testid="lineage-coverage">
      {coverage ? `${coverage.filePath}:${coverage.pct}` : "none"}
    </span>
  );
}

function renderPaneWithLineageProbe() {
  return render(
    <OriginOverlayProvider>
      <LineageCoverageProvider>
        <GeneratedArtifactsProvider>
          <LineageCoverageProbe />
          <GeneratedJavaEditorPane />
        </GeneratedArtifactsProvider>
      </LineageCoverageProvider>
    </OriginOverlayProvider>,
  );
}

function renderPaneWithActionsAndSelector(path: string) {
  return render(
    <JavaEditorActionsProvider>
      <OriginOverlayProvider>
        <LineageCoverageProvider>
          <GeneratedArtifactsProvider>
            <CompileCheckStateProbe />
            <SelectGeneratedFileButton path={path} />
            <GeneratedJavaEditorPane />
          </GeneratedArtifactsProvider>
        </LineageCoverageProvider>
      </OriginOverlayProvider>
    </JavaEditorActionsProvider>,
  );
}

function NavigateDiagnosticButton({
  diagnostic,
}: {
  diagnostic: Diagnostic;
}) {
  const { navigateToDiagnostic } = useMarkerNavigation();
  return (
    <button type="button" onClick={() => navigateToDiagnostic(diagnostic)}>
      Navigate diagnostic
    </button>
  );
}

function renderPaneWithMarkerNavigation(diagnostic: Diagnostic) {
  return render(
    <OriginOverlayProvider>
      <LineageCoverageProvider>
        <GeneratedArtifactsProvider>
          <MarkerNavigationProvider>
            <NavigateDiagnosticButton diagnostic={diagnostic} />
            <GeneratedJavaEditorPane />
          </MarkerNavigationProvider>
        </GeneratedArtifactsProvider>
      </LineageCoverageProvider>
    </OriginOverlayProvider>,
  );
}

const FILE_SHA = "1122334455667788aabbccddeeff0011" + "00".repeat(16);

const completedRunWith = (files: string[], entry?: string) => ({
  phase: "completed",
  runId: "run-123",
  generated: {
    status: "generated",
    artifactRef: { sha256: "aaaa" },
  },
  generatedFiles: {
    status: "complete",
    entryFilePath: entry ?? files[0],
    files: files.map((path) => ({ path, sha256: FILE_SHA })),
  },
  workflow: null,
});

describe("GeneratedJavaEditorPane (Studio-IDE-4 #245)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    editorMounts.length = 0;
    editorCommands.length = 0;
    editorActions.length = 0;
    decorationSetCalls.length = 0;
    decorationClearCalls.length = 0;
    latestEditorValue = "";
    fakeModelsByUri.clear();
    currentFakeModel = fakeModelFor(undefined);
    globalThis.localStorage?.removeItem(JAVA_FORMAT_ON_SAVE_STORAGE_KEY);
    lintJavaSpy.mockReset();
    lintJavaSpy.mockReturnValue([]);
    setJavaBufferContentSpy.mockClear();
    ensureJavaBaselineSpy.mockClear();
    loadJavaDraftForSpy.mockClear();
    saveJavaDraftSpy.mockClear();
    setJavaManualOverlaySpy.mockClear();
    recordJavaDiffSnapshotSpy.mockClear();
    requestJavaMergeReviewSpy.mockClear();
    javaBuffersSpy.mockReset();
    javaBuffersSpy.mockReturnValue({});
    javaDiffHistorySpy.mockReset();
    javaDiffHistorySpy.mockReturnValue({});
    cobolDiffHistorySpy.mockReset();
    cobolDiffHistorySpy.mockReturnValue({});
    fetchTraceabilitySpy.mockReset();
    fetchTraceabilitySpy.mockRejectedValue(
      new Error("traceability fixture not configured"),
    );
    resolveJavaToCobolSpy.mockReset();
    resolveJavaToCobolSpy.mockResolvedValue({
      ok: false,
      reason: "no_mapping",
    });
    javaStatusFlagsSpy.mockReturnValue({
      clean: false,
      pendingReRun: false,
      staleJava: false,
      manualEditsPresent: false,
    });
    vi.mocked(apiClient.getGeneratedFile).mockReset();
  });

  it("mounts an editable Monaco editor for .java with the java language id and a stable per-file URI", async () => {
    mockTransformationState.mockReturnValue(completedRunWith(["src/App.java"]));
    mockGeneratedFileContents({ "src/App.java": "public class App {}" });

    renderPane();

    const editor = (await screen.findByTestId(
      "code-editor-mock",
    )) as HTMLTextAreaElement;
    expect(editor).toHaveAttribute("data-language", "java");
    expect(editor).toHaveAttribute("data-mode", "editable");
    expect(editor).toHaveAttribute(
      "data-model-uri",
      "inmemory://c2c-studio/generated/run-123/src/App.java",
    );
    expect(editor.readOnly).toBe(false);
  });

  it("renders generated Java for generator-only runs awaiting explicit Verify", async () => {
    mockTransformationState.mockReturnValue({
      ...completedRunWith(["src/App.java"]),
      workflow: {
        finalClassification: "incomplete",
        failureCode: "generate_only_complete",
        failureMessage:
          "generator-only run completed; verification was not requested",
      },
    });
    mockGeneratedFileContents({ "src/App.java": "public class App {}" });

    renderPane();

    const editor = await screen.findByTestId("code-editor-mock");
    expect(editor).toHaveAttribute("data-language", "java");
    expect(editor).toHaveAttribute("data-mode", "editable");
    expect(screen.queryByTestId("generated-pane-progress")).toBeNull();
  });

  it("publishes fetched traceability into trust-pillar decorations and lineage coverage", async () => {
    mockTransformationState.mockReturnValue(completedRunWith(["src/App.java"]));
    mockGeneratedFileContents({
      "src/App.java": ["line 1", "line 2", "line 3", "line 4"].join("\n"),
    });
    fetchTraceabilitySpy.mockResolvedValue({
      runId: "run-123",
      programId: "APP",
      trace: { ready: true },
      irSymbolMap: new Map(),
      javaRegionClassification: new Map([
        [
          "src/App.java",
          [
            {
              schemaVersion: "v0",
              lineRange: { startLine: 1, endLine: 2 },
              originClass: "deterministic",
              verificationOutcome: "oracle_passed",
              mappingClass: "direct",
            },
          ],
        ],
      ]),
    });

    renderPaneWithLineageProbe();

    await screen.findByTestId("code-editor-mock");
    await waitFor(() => {
      expect(decorationSetCalls.length).toBeGreaterThan(0);
    });
    const latestDecorations = decorationSetCalls.at(-1) as Array<{
      options: { linesDecorationsClassName: string };
    }>;
    expect(latestDecorations[0]?.options.linesDecorationsClassName).toContain(
      "deterministic-passed",
    );
    await waitFor(() => {
      expect(screen.getByTestId("lineage-coverage").textContent).toBe(
        "src/App.java:50",
      );
    });
  });

  it("Alt+J dispatches c2c:reveal-cobol and clears lineage markers on success", async () => {
    mockTransformationState.mockReturnValue(completedRunWith(["src/App.java"]));
    mockGeneratedFileContents({ "src/App.java": "public class App {}" });
    resolveJavaToCobolSpy.mockResolvedValue({
      ok: true,
      target: { cobolFile: "PROG1.cbl", cobolLine: 7 },
    });

    renderPane();

    await screen.findByTestId("code-editor-mock");
    const action = editorActions.find(
      (entry) => entry.id === "c2c.lineage.javaToCobol",
    );
    expect(action).toBeDefined();
    const events: CustomEvent[] = [];
    const listener = (ev: Event) => events.push(ev as CustomEvent);
    window.addEventListener("c2c:reveal-cobol", listener);
    try {
      await act(async () => {
        await action!.run(fakeEditor);
      });
    } finally {
      window.removeEventListener("c2c:reveal-cobol", listener);
    }

    expect(events).toHaveLength(1);
    expect(events[0].detail).toEqual({
      cobolFile: "PROG1.cbl",
      cobolLine: 7,
    });
    expect(fakeMonaco.editor.setModelMarkers).toHaveBeenCalledWith(
      currentFakeModel,
      "c2c-lineage-feedback",
      [],
    );
  });

  it.each([
    ["no_mapping", "No source mapping available for this line"],
    ["stale_manual_edit", "Lineage stale due to manual edit"],
    [
      "manual_only",
      "Region did not exist in Generator Baseline; no COBOL lineage",
    ],
  ])("Alt+J paints the %s lineage marker", async (reason, message) => {
    mockTransformationState.mockReturnValue(completedRunWith(["src/App.java"]));
    mockGeneratedFileContents({ "src/App.java": "public class App {}" });
    resolveJavaToCobolSpy.mockResolvedValue({ ok: false, reason });

    renderPane();

    await screen.findByTestId("code-editor-mock");
    const action = editorActions.find(
      (entry) => entry.id === "c2c.lineage.javaToCobol",
    );
    expect(action).toBeDefined();
    await act(async () => {
      await action!.run(fakeEditor);
    });

    const markers = fakeMonaco.editor.setModelMarkers.mock.calls.at(-1)?.[2] as
      | Array<{ message: string }>
      | undefined;
    expect(markers?.[0]?.message).toBe(message);
  });

  it("Alt+J treats resolver failures as no_mapping feedback", async () => {
    mockTransformationState.mockReturnValue(completedRunWith(["src/App.java"]));
    mockGeneratedFileContents({ "src/App.java": "public class App {}" });
    resolveJavaToCobolSpy.mockRejectedValue(new Error("traceability failed"));

    renderPane();

    await screen.findByTestId("code-editor-mock");
    const action = editorActions.find(
      (entry) => entry.id === "c2c.lineage.javaToCobol",
    );
    expect(action).toBeDefined();
    await act(async () => {
      await action!.run(fakeEditor);
    });

    const markers = fakeMonaco.editor.setModelMarkers.mock.calls.at(-1)?.[2] as
      | Array<{ message: string }>
      | undefined;
    expect(markers?.[0]?.message).toBe(
      "No source mapping available for this line",
    );
  });

  it.each([
    ["src/manifest.json", "json"],
    ["src/pom.xml", "xml"],
    ["src/README.md", "markdown"],
  ])(
    "renders %s in read-only mode with language %s",
    async (path, language) => {
      mockTransformationState.mockReturnValue(completedRunWith([path]));
      mockGeneratedFileContents({ [path]: "non-java content" });

      renderPane();

      const editor = (await screen.findByTestId(
        "code-editor-mock",
      )) as HTMLTextAreaElement;
      expect(editor).toHaveAttribute("data-language", language);
      expect(editor).toHaveAttribute("data-mode", "readonly");
      expect(editor.readOnly).toBe(true);
    },
  );

  it("debounces editor onChange to setJavaBufferContent within 250ms", async () => {
    vi.useFakeTimers();
    try {
      mockTransformationState.mockReturnValue(
        completedRunWith(["src/App.java"]),
      );
      mockGeneratedFileContents({ "src/App.java": "public class App {}" });

      renderPane();

      const editor = (await vi.waitFor(() =>
        screen.getByTestId("code-editor-mock"),
      )) as HTMLTextAreaElement;

      // Three keystrokes within 250ms — only the last one should land.
      fireEvent.change(editor, {
        target: { value: "public class App { void a(){} }" },
      });
      act(() => {
        vi.advanceTimersByTime(100);
      });
      fireEvent.change(editor, {
        target: { value: "public class App { void ab(){} }" },
      });
      act(() => {
        vi.advanceTimersByTime(100);
      });
      fireEvent.change(editor, {
        target: { value: "public class App { void abc(){} }" },
      });

      // Before the debounce window elapses, no buffer write happens.
      expect(setJavaBufferContentSpy).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(250);
      });

      expect(setJavaBufferContentSpy).toHaveBeenCalledTimes(1);
      expect(setJavaBufferContentSpy).toHaveBeenCalledWith(
        "src/App.java",
        "public class App { void abc(){} }",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs Java lint 300ms after live editor changes without waiting for buffer persistence", async () => {
    vi.useFakeTimers();
    try {
      mockTransformationState.mockReturnValue(
        completedRunWith(["src/App.java"]),
      );
      mockGeneratedFileContents({
        "src/App.java": "public class App { void m(int x, int y) {} }",
      });

      renderPane();

      const editor = (await vi.waitFor(() =>
        screen.getByTestId("code-editor-mock"),
      )) as HTMLTextAreaElement;
      lintJavaSpy.mockClear();

      fireEvent.change(editor, {
        target: {
          value:
            "public class App { void m(int x, int y) { if (x = y) return; } }",
        },
      });

      act(() => {
        vi.advanceTimersByTime(299);
      });
      expect(lintJavaSpy).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(1);
        await Promise.resolve();
      });

      expect(lintJavaSpy).toHaveBeenCalledWith(
        "public class App { void m(int x, int y) { if (x = y) return; } }",
        { filePath: "src/App.java" },
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps Cmd/Ctrl+S registered after mounting on a read-only artifact and saves the live Java model", async () => {
    mockTransformationState.mockReturnValue(
      completedRunWith(["pom.xml", "src/App.java"], "pom.xml"),
    );
    mockGeneratedFileContents({
      "pom.xml": "<project />",
      "src/App.java": "public class App {}",
    });

    renderPaneWithSelector("src/App.java");

    const readonlyEditor = (await screen.findByTestId(
      "code-editor-mock",
    )) as HTMLTextAreaElement;
    expect(readonlyEditor).toHaveAttribute("data-mode", "readonly");

    const saveKeybinding = fakeMonaco.KeyMod.CtrlCmd | fakeMonaco.KeyCode.KeyS;
    const saveCommand = editorCommands.find(
      (command) => command.keybinding === saveKeybinding,
    );
    expect(saveCommand).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /select src\/app\.java/i }));

    const editor = (await screen.findByTestId(
      "code-editor-mock",
    )) as HTMLTextAreaElement;
    await waitFor(() => {
      expect(editor).toHaveAttribute("data-mode", "editable");
      expect(editor).toHaveDisplayValue("public class App {}");
    });

    fireEvent.change(editor, {
      target: { value: "public class App { int saved; }" },
    });

    act(() => {
      saveCommand!.callback();
    });

    expect(setJavaBufferContentSpy).toHaveBeenCalledWith(
      "src/App.java",
      "public class App { int saved; }",
    );
    await waitFor(() => {
      expect(saveJavaDraftSpy).toHaveBeenCalledWith("src/App.java", {
        content: "public class App { int saved; }",
      });
    });
  });

  it("formats the live model before saving when format-on-save is enabled", async () => {
    globalThis.localStorage?.setItem(JAVA_FORMAT_ON_SAVE_STORAGE_KEY, "true");
    formatJavaSpy.mockResolvedValue({
      ok: true,
      formattedContent: "public class App {}\n",
    });
    mockTransformationState.mockReturnValue(completedRunWith(["src/App.java"]));
    mockGeneratedFileContents({ "src/App.java": "public class App{}" });

    renderPane();

    await waitFor(() => {
      expect(screen.getByLabelText("Format Java on Save")).toBeChecked();
    });
    const saveKeybinding = fakeMonaco.KeyMod.CtrlCmd | fakeMonaco.KeyCode.KeyS;
    const saveCommand = editorCommands.find(
      (command) => command.keybinding === saveKeybinding,
    );
    expect(saveCommand).toBeDefined();

    act(() => {
      saveCommand!.callback();
    });

    await waitFor(() => {
      expect(formatJavaSpy).toHaveBeenCalledWith(
        {
          content: "public class App{}",
          filePath: "src/App.java",
        },
        { telemetryTrigger: "on_save" },
      );
      expect(setJavaBufferContentSpy).toHaveBeenCalledWith(
        "src/App.java",
        "public class App {}\n",
      );
      expect(saveJavaDraftSpy).toHaveBeenCalledWith("src/App.java", {
        content: "public class App {}\n",
      });
    });
  });

  it("does not apply a stale format result after switching editor models", async () => {
    const formattedApp = "public class App { int formatted; }\n";
    let resolveFormat!: (value: { ok: true; formattedContent: string }) => void;
    formatJavaSpy.mockReturnValue(
      new Promise((resolve) => {
        resolveFormat = resolve;
      }),
    );
    mockTransformationState.mockReturnValue(
      completedRunWith(["src/App.java", "src/Other.java"], "src/App.java"),
    );
    mockGeneratedFileContents({
      "src/App.java": "public class App{}",
      "src/Other.java": "public class Other {}",
    });

    renderPaneWithSelector("src/Other.java");

    await screen.findByTestId("java-format-button");
    fireEvent.click(screen.getByTestId("java-format-button"));
    expect(formatJavaSpy).toHaveBeenCalledWith(
      {
        content: "public class App{}",
        filePath: "src/App.java",
      },
      { telemetryTrigger: "shortcut" },
    );

    fireEvent.click(screen.getByRole("button", { name: /select src\/other\.java/i }));
    await waitFor(() => {
      expect(screen.getByTestId("code-editor-mock")).toHaveDisplayValue(
        "public class Other {}",
      );
    });

    await act(async () => {
      resolveFormat({ ok: true, formattedContent: formattedApp });
      await Promise.resolve();
    });

    expect(fakeEditor.executeEdits).not.toHaveBeenCalled();
    expect(setJavaBufferContentSpy).not.toHaveBeenCalledWith(
      "src/App.java",
      formattedApp,
    );
    expect(latestEditorValue).toBe("public class Other {}");
  });

  it("exposes Compile Check only while the selected artifact is editable Java", async () => {
    mockTransformationState.mockReturnValue(
      completedRunWith(["pom.xml", "src/App.java"], "pom.xml"),
    );
    mockGeneratedFileContents({
      "pom.xml": "<project />",
      "src/App.java": "public class App {}",
    });

    renderPaneWithActionsAndSelector("src/App.java");

    await waitFor(() => {
      expect(screen.getByTestId("compile-check-state").textContent).toBe(
        "disabled",
      );
    });

    fireEvent.click(screen.getByRole("button", { name: /select src\/app\.java/i }));

    await waitFor(() => {
      expect(screen.getByTestId("compile-check-state").textContent).toBe(
        "enabled",
      );
    });
  });

  it("does not call setJavaBufferContent for read-only artifacts", async () => {
    vi.useFakeTimers();
    try {
      mockTransformationState.mockReturnValue(
        completedRunWith(["src/manifest.json"]),
      );
      mockGeneratedFileContents({ "src/manifest.json": "{}" });

      renderPane();

      const editor = (await vi.waitFor(() =>
        screen.getByTestId("code-editor-mock"),
      )) as HTMLTextAreaElement;
      // Mock textarea ignores readOnly on programmatic change events,
      // but the pane should not call setJavaBufferContent because the
      // detected language is JSON (not editable).
      fireEvent.change(editor, { target: { value: '{ "x": 1 }' } });
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(setJavaBufferContentSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders the Deterministic Run badge when no assist or repair was needed", async () => {
    mockTransformationState.mockReturnValue({
      ...completedRunWith(["src/App.java"]),
      workflow: {
        assistDecision: { outcome: "assist_not_required" },
        repairAttempts: [],
      },
    });
    mockGeneratedFileContents({ "src/App.java": "public class App {}" });

    renderPane();

    const badge = await screen.findByTestId("java-run-mode-badge");
    expect(badge).toHaveAttribute("data-run-mode", "deterministic");
    expect(badge.textContent).toMatch(/Deterministic Run/);
  });

  it("renders the AI-Assisted Run badge when assist_required", async () => {
    mockTransformationState.mockReturnValue({
      ...completedRunWith(["src/App.java"]),
      workflow: {
        assistDecision: { outcome: "assist_required" },
        repairAttempts: [],
      },
    });
    mockGeneratedFileContents({ "src/App.java": "public class App {}" });

    renderPane();

    const badge = await screen.findByTestId("java-run-mode-badge");
    expect(badge).toHaveAttribute("data-run-mode", "ai-assisted");
    expect(badge.textContent).toMatch(/AI-Assisted Run/);
  });

  it("renders AI-Assisted Run when there were repair attempts even without assist_required", async () => {
    mockTransformationState.mockReturnValue({
      ...completedRunWith(["src/App.java"]),
      workflow: {
        assistDecision: { outcome: "assist_not_required" },
        repairAttempts: [{ attemptId: "1" }],
      },
    });
    mockGeneratedFileContents({ "src/App.java": "public class App {}" });

    renderPane();

    const badge = await screen.findByTestId("java-run-mode-badge");
    expect(badge).toHaveAttribute("data-run-mode", "ai-assisted");
  });

  it("renders the Stale badge when the displayed artifact diverges from the last run input", async () => {
    javaStatusFlagsSpy.mockReturnValue({
      clean: false,
      pendingReRun: false,
      staleJava: true,
      manualEditsPresent: false,
    });
    mockTransformationState.mockReturnValue({
      ...completedRunWith(["src/App.java"]),
      workflow: {
        assistDecision: { outcome: "assist_required" },
        repairAttempts: [],
      },
    });
    mockGeneratedFileContents({ "src/App.java": "public class App {}" });

    renderPane();

    const badge = await screen.findByTestId("java-run-mode-badge");
    // Stale wins over AI-Assisted even when both signals are present.
    expect(badge).toHaveAttribute("data-run-mode", "stale");
    expect(badge.textContent).toMatch(/Stale/);
  });

  it("renders a short SHA-256 chip from the selected file ref", async () => {
    mockTransformationState.mockReturnValue(completedRunWith(["src/App.java"]));
    mockGeneratedFileContents({ "src/App.java": "public class App {}" });

    renderPane();

    const chip = await screen.findByTestId("java-file-sha-chip");
    expect(chip.textContent).toMatch(/sha [0-9a-f]{12}/);
    expect(chip).toHaveAttribute("title", expect.stringContaining(FILE_SHA));
  });

  it("hydrates the buffer baseline and loads any persisted draft once the BFF content lands", async () => {
    mockTransformationState.mockReturnValue(completedRunWith(["src/App.java"]));
    mockGeneratedFileContents({ "src/App.java": "public class App {}" });

    renderPane();

    await waitFor(() => {
      expect(ensureJavaBaselineSpy).toHaveBeenCalledWith(
        "src/App.java",
        "public class App {}",
        "run-123",
      );
      expect(loadJavaDraftForSpy).toHaveBeenCalledWith(
        "src/App.java",
        "public class App {}",
      );
    });
  });

  it("does not baseline or diff-snapshot stale file content after a runId change", async () => {
    let currentState = {
      ...completedRunWith(["src/App.java"]),
      programId: "APP",
    } as ReturnType<typeof completedRunWith> & {
      programId: string;
      generated: ReturnType<typeof completedRunWith>["generated"] | null;
      generatedFiles:
        | ReturnType<typeof completedRunWith>["generatedFiles"]
        | null;
    };
    mockTransformationState.mockImplementation(() => currentState);
    mockGeneratedFileContents({ "src/App.java": "public class First {}" });

    const view = renderPane();

    await waitFor(() => {
      expect(ensureJavaBaselineSpy).toHaveBeenCalledWith(
        "src/App.java",
        "public class First {}",
        "run-123",
      );
    });
    await waitFor(() => {
      expect(recordJavaDiffSnapshotSpy).toHaveBeenCalledWith(
        "APP",
        "src/App.java",
        expect.objectContaining({
          content: "public class First {}",
          runId: "run-123",
        }),
      );
    });

    ensureJavaBaselineSpy.mockClear();
    loadJavaDraftForSpy.mockClear();
    recordJavaDiffSnapshotSpy.mockClear();
    vi.mocked(apiClient.getGeneratedFile).mockImplementation(
      () => new Promise<ApiResult<GeneratedFileContent>>(() => undefined),
    );

    currentState = {
      ...currentState,
      phase: "failed",
      runId: "run-456",
      generated: null,
      generatedFiles: null,
    };
    view.rerender(paneTree());

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(ensureJavaBaselineSpy).not.toHaveBeenCalled();
    expect(loadJavaDraftForSpy).not.toHaveBeenCalled();
    expect(recordJavaDiffSnapshotSpy).not.toHaveBeenCalled();
  });

  it("opens the Manual Drift empty state from the Java View menu", async () => {
    mockTransformationState.mockReturnValue({
      ...completedRunWith(["src/App.java"]),
      programId: "APP",
    });
    mockGeneratedFileContents({ "src/App.java": "public class App {}" });

    renderPane();

    await screen.findByTestId("code-editor-mock");
    fireEvent.click(screen.getByTestId("java-view-menu-button"));
    fireEvent.click(screen.getByTestId("java-view-manual-drift-menuitem"));

    expect(
      await screen.findByTestId("manual-drift-workspace-empty"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("No Generator Baseline exists for this file yet."),
    ).toBeInTheDocument();
  });

  it("opens Manual Drift from the manual-edits chip and focuses the first changed region", async () => {
    const manualOverlay = {
      schemaVersion: "v0" as const,
      runId: "run-123",
      javaFile: "src/App.java",
      regions: [
        {
          lineRange: { startLine: 2, endLine: 2 },
          originClass: "manual_modified" as const,
        },
      ],
    };
    const bufferEntry = {
      content: "class App {\n  int b;\n}\n",
      bufferHash: "current-hash",
      lastRunInputHash: "baseline-hash",
      lastRunInputContent: "class App {\n  int a;\n}\n",
      displayedArtifactSourceHash: "baseline-hash",
      generatorBaselineContent: "class App {\n  int a;\n}\n",
      generatorBaselineHash: "baseline-hash",
      generatorBaselineRunId: "run-123",
      manualEditOverlay: manualOverlay,
      isDirty: true,
      lastSavedAt: null,
    };
    javaBuffersSpy.mockReturnValue({ "src/App.java": bufferEntry });
    javaStatusFlagsSpy.mockReturnValue({
      clean: false,
      pendingReRun: false,
      staleJava: false,
      manualEditsPresent: true,
    });
    mockTransformationState.mockReturnValue({
      ...completedRunWith(["src/App.java"]),
      programId: "APP",
    });
    mockGeneratedFileContents({ "src/App.java": "class App {\n  int a;\n}\n" });

    renderPane();

    const chip = await screen.findByTestId("java-status-chip-manual-edits");
    expect(chip.tagName).toBe("BUTTON");
    fireEvent.click(chip);

    expect(
      await screen.findByTestId("manual-drift-workspace"),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(editorMounts.some((mount) => mount.mode === "diff")).toBe(true);
    });
    const diffMount = editorMounts.find((mount) => mount.mode === "diff");
    expect(diffMount).toMatchObject({
      language: "java",
      value: bufferEntry.content,
      modelUri:
        "inmemory://c2c-studio/diff/manual-drift/run-123/src/App.java~modified",
      ariaLabel: "Manual drift diff for src/App.java",
    });
    expect(fakeEditor.revealLineInCenter).toHaveBeenCalledWith(2);
    expect(fakeEditor.setPosition).toHaveBeenCalledWith({
      lineNumber: 2,
      column: 1,
    });
    expect(fakeEditor.focus).toHaveBeenCalled();
  });

  it("completes a Problems-panel jump after resolving a suffix-matched generated file", async () => {
    const diagnostic: Diagnostic = {
      schemaVersion: "v0",
      severity: "error",
      code: "JAVAC",
      message: "syntax error",
      line: 13,
      column: 5,
      filePath: "/tmp/work/src/main/java/com/example/Foo.java",
      sourceKind: "build",
    };
    mockTransformationState.mockReturnValue(
      completedRunWith(
        ["src/main/java/com/example/Initial.java", "src/main/java/com/example/Foo.java"],
        "src/main/java/com/example/Initial.java",
      ),
    );
    mockGeneratedFileContents({
      "src/main/java/com/example/Initial.java": "public class Initial {}",
      "src/main/java/com/example/Foo.java": "public class Foo {}",
    });

    renderPaneWithMarkerNavigation(diagnostic);

    await waitFor(() => {
      expect(screen.getByTestId("code-editor-mock")).toHaveAttribute(
        "data-model-uri",
        "inmemory://c2c-studio/generated/run-123/src/main/java/com/example/Initial.java",
      );
    });

    fireEvent.click(
      screen.getByRole("button", { name: /navigate diagnostic/i }),
    );

    await waitFor(() => {
      expect(fakeEditor.revealLineInCenterIfOutsideViewport).toHaveBeenCalledWith(
        13,
      );
      expect(fakeEditor.setPosition).toHaveBeenCalledWith({
        lineNumber: 13,
        column: 5,
      });
      expect(fakeEditor.focus).toHaveBeenCalled();
    });
  });
});

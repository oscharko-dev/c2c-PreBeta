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
// Studio-IDE-6 (#248): the Java pane now consumes the OriginOverlay and
// LineageCoverage providers (for trust-pillar overlays and the status-bar
// coverage chip). Both providers are pure context wrappers — the test
// renders them as no-op shells so the existing pane assertions continue
// to exercise the same surface without provider-missing crashes.
import { OriginOverlayProvider } from "@/lib/editor/originOverlay";
import { LineageCoverageProvider } from "@/stores/lineageCoverage";
import { apiClient } from "@/lib/apiClient";
import type { ApiResult, GeneratedFileContent } from "@/types/api";

// Studio-IDE-4 (#245): exercise the editor surface (language, mode, model
// URI, onChange) through a textarea-backed CodeEditor mock — Monaco itself
// is covered by tests/components/editor/. The mock captures every mount and
// onChange so the tests can assert the debounced buffer-model wiring.
type EditorMockProps = {
  value: string;
  onChange?: (next: string) => void;
  onMount?: (args: { editor: FakeEditor; monaco: typeof fakeMonaco }) => void;
  ariaLabel?: string;
  language: string;
  mode: string;
  modelUri?: string;
  className?: string;
};

type FakeEditor = {
  addCommand: (keybinding: number, callback: () => void) => string;
  addAction: (descriptor: {
    id: string;
    run: (editor: FakeEditor) => unknown;
  }) => { dispose: () => void };
  getModel: () => {
    getValue: () => string;
    getLineCount: () => number;
    getLineContent: (line: number) => string;
    getValueInRange: () => string;
  };
  getPosition: () => { lineNumber: number; column: number };
  getSelection: () => { isEmpty: () => boolean } | null;
  onDidFocusEditorText: (callback: () => void) => { dispose: () => void };
  revealLineInCenterIfOutsideViewport: () => void;
  setPosition: () => void;
  focus: () => void;
};

const editorMounts: Array<{
  language: string;
  mode: string;
  modelUri: string | undefined;
  ariaLabel: string | undefined;
  value: string;
}> = [];

const editorCommands: Array<{ keybinding: number; callback: () => void }> = [];
const editorActions: string[] = [];
let latestEditorValue = "";

const fakeMonaco = {
  KeyMod: { CtrlCmd: 1 << 11, Shift: 1 << 10, Alt: 1 << 9 },
  KeyCode: { KeyS: 49, KeyF: 36, KeyJ: 41, KeyE: 35, F5: 66 },
  MarkerSeverity: { Info: 2 },
  editor: { setModelMarkers: vi.fn() },
};

const fakeEditor: FakeEditor = {
  addCommand: (keybinding, callback) => {
    editorCommands.push({ keybinding, callback });
    return `command-${editorCommands.length}`;
  },
  addAction: (descriptor) => {
    editorActions.push(descriptor.id);
    return { dispose: vi.fn() };
  },
  getModel: () => ({
    getValue: () => latestEditorValue,
    getLineCount: () => Math.max(1, latestEditorValue.split("\n").length),
    getLineContent: (line) => latestEditorValue.split("\n")[line - 1] ?? "",
    getValueInRange: () => latestEditorValue,
  }),
  getPosition: () => ({ lineNumber: 1, column: 1 }),
  getSelection: () => null,
  onDidFocusEditorText: () => ({ dispose: vi.fn() }),
  revealLineInCenterIfOutsideViewport: vi.fn(),
  setPosition: vi.fn(),
  focus: vi.fn(),
};

vi.mock("@/components/editor/CodeEditor", async () => {
  const reactNs = await import("react");
  const CodeEditor = (props: EditorMockProps) => {
    latestEditorValue = props.value;
    reactNs.useEffect(() => {
      editorMounts.push({
        language: props.language,
        mode: props.mode,
        modelUri: props.modelUri,
        ariaLabel: props.ariaLabel,
        value: props.value,
      });
      props.onMount?.({ editor: fakeEditor, monaco: fakeMonaco });
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

vi.mock("@/lib/apiClient", () => ({
  apiClient: {
    getGeneratedFile: vi.fn(),
  },
}));

const mockTransformationState = vi.fn();
const setJavaBufferContentSpy = vi.fn();
const ensureJavaBaselineSpy = vi.fn();
const loadJavaDraftForSpy = vi.fn();
const saveJavaDraftSpy = vi.fn();
const javaStatusFlagsSpy = vi.fn().mockReturnValue({
  clean: false,
  pendingReRun: false,
  staleJava: false,
});

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
        ensureJavaBaseline: ensureJavaBaselineSpy,
        setJavaBufferContent: setJavaBufferContentSpy,
        setJavaManualOverlay: vi.fn(),
        saveJavaDraft: saveJavaDraftSpy,
        loadJavaDraftFor: loadJavaDraftForSpy,
        resolveJavaConflict: vi.fn(),
        dismissJavaConflict: vi.fn(),
        javaStatusFlags: javaStatusFlagsSpy,
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
    latestEditorValue = "";
    setJavaBufferContentSpy.mockClear();
    ensureJavaBaselineSpy.mockClear();
    loadJavaDraftForSpy.mockClear();
    saveJavaDraftSpy.mockClear();
    javaStatusFlagsSpy.mockReturnValue({
      clean: false,
      pendingReRun: false,
      staleJava: false,
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
});

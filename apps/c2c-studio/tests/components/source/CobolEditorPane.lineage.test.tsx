// Studio-IDE-6 (#248) follow-up: integration test for the Alt+C action
// registered by `CobolEditorPane`. The verifier flagged that the existing
// CobolEditorPane test only proves the action is *registered* (does not
// throw on mount) — it does not exercise the dispatch path. This test
// captures the registered action descriptor, stubs `resolveCobolToJava`,
// invokes the `run` callback, and asserts that the matching
// `c2c:reveal-java` window event fires with the expected detail shape.

import { render, screen, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";

import { CobolEditorPane } from "@/components/source/CobolEditorPane";
import {
  SourceWorkspaceProvider,
  useSourceWorkspace,
} from "@/stores/sourceWorkspace";
import {
  TransformationRunProvider,
  useTransformationRun,
} from "@/stores/transformationRun";
import { WorkbenchProvider } from "@/stores/workbench";

// Capture the Alt+C action descriptor + the Monaco editor stub passed to
// `onMount`. The harness exposes the captured callable so the test can
// drive it directly without bouncing through real keyboard events.
interface CapturedAction {
  id: string;
  run: (ed: unknown) => void | Promise<void>;
}
const capturedActions: CapturedAction[] = [];
const setMarkersCalls: Array<{ owner: string; markers: unknown[] }> = [];
const COBOL_SOURCE = [
  "       IDENTIFICATION DIVISION.",
  "       PROGRAM-ID. PROG1.",
  "       PROCEDURE DIVISION.",
  "           DISPLAY 'A'.",
  "           STOP RUN.",
].join("\n");
const JAVA_FILE = "src/main/java/com/example/F.java";
const JAVA_SOURCE = [
  "public final class F {",
  "  // display [s-display-a line 4]",
  "  void run() {}",
  "}",
].join("\n");

interface FakeEditor {
  updateOptions: (options: unknown) => void;
  addCommand: () => void;
  addAction: (descriptor: CapturedAction) => void;
  getModel: () => {
    getLineMaxColumn: () => number;
    getLineCount: () => number;
    getValue: () => string;
  } | null;
  getPosition: () => { lineNumber: number; column: number };
  revealLineInCenter: () => void;
  setPosition: () => void;
  focus: () => void;
}

const fakeEditor: FakeEditor = {
  updateOptions: () => undefined,
  addCommand: () => undefined,
  addAction: (descriptor) => {
    capturedActions.push(descriptor);
  },
  getModel: () => ({
    getLineMaxColumn: () => 80,
    getLineCount: () => 10,
    getValue: () => "DUMMY",
  }),
  getPosition: () => ({ lineNumber: 5, column: 1 }),
  revealLineInCenter: () => undefined,
  setPosition: () => undefined,
  focus: () => undefined,
};

vi.mock("@/components/editor/CodeEditor", async () => {
  const reactNs = await import("react");
  const CodeEditor = (props: {
    value: string;
    ariaLabel?: string;
    language: string;
    mode: string;
    modelUri?: string;
    onMount?: (args: { editor: FakeEditor; monaco: unknown }) => void;
  }) => {
    reactNs.useEffect(() => {
      props.onMount?.({
        editor: fakeEditor,
        monaco: {
          KeyMod: { CtrlCmd: 1 << 11, Alt: 1 << 9 },
          KeyCode: { KeyS: 49, KeyC: 33 },
          MarkerSeverity: { Info: 2 },
          editor: {
            setModelMarkers: (
              _model: unknown,
              owner: string,
              markers: unknown[],
            ) => {
              setMarkersCalls.push({ owner, markers });
            },
          },
        },
      });
    }, []);
    return reactNs.createElement("textarea", {
      "data-testid": "code-editor-mock",
      "aria-label": props.ariaLabel,
      readOnly: true,
      value: props.value,
    });
  };
  return { CodeEditor };
});

vi.mock("@/lib/editor/cobolMonarch", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/editor/cobolMonarch")
  >("@/lib/editor/cobolMonarch");
  return {
    ...actual,
    registerCobolLanguage: () => undefined,
  };
});

vi.mock("@/lib/editor/cobolHoverProvider", () => ({
  registerCobolHoverProvider: () => undefined,
}));

vi.mock("@/lib/editor/lazyMonaco", () => ({
  // The COBOL pane awaits `getMonaco()` to register the cobol language
  // before the editor mounts; returning a never-resolving promise is the
  // simplest way to keep the lazy path quiet in tests without booting real
  // Monaco. The mount mock above already provides a Monaco facade through
  // the onMount args, so we never need the real `getMonaco()` return.
  getMonaco: () => new Promise(() => undefined),
  useMonacoReady: () => null,
}));

const resolveCobolToJavaMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/editor/lineageNavigation", () => ({
  resolveCobolToJava: (...args: unknown[]) => resolveCobolToJavaMock(...args),
}));

vi.mock("@/lib/apiClient", () => ({
  apiClient: {
    getModelGatewayHealth: vi.fn(() =>
      Promise.resolve({ ok: true, data: { status: "ok" } }),
    ),
    getHarnessReady: vi.fn(() =>
      Promise.resolve({ ok: true, data: { status: "ok" } }),
    ),
    getTrustCases: vi.fn((programId?: string) =>
      Promise.resolve({
        ok: true,
        data: {
          schemaVersion: "v0",
          catalogVersion: "2026-05-21",
          catalogHash: "0".repeat(64),
          programId: programId ?? null,
          defaultTrustCaseId: programId ? `${programId}-DEFAULT` : null,
          savedTrustCaseId: null,
          trustCases: programId
            ? [
                {
                  trustCaseId: `${programId}-DEFAULT`,
                  version: "2026-05-21",
                  catalogVersion: "2026-05-21",
                  catalogHash: "0".repeat(64),
                  configurationDigest: "1".repeat(64),
                  programId,
                  title: `${programId} default`,
                  description: "Default trust case",
                  defaultForProgram: true,
                  sourceReferenceFixtureId: "HELLOW02",
                  sourceReferenceMode: "reference-fixture",
                  environmentProfileId: "generated-java-sandbox-v1",
                  comparisonStrategy: "deterministic-output",
                  comparisonPolicyVersion: "deterministic-output-v1",
                  supportedSubset: ["DISPLAY"],
                },
              ]
            : [],
        },
      }),
    ),
  },
}));

vi.mock("@/hooks/useC2cApi", () => ({
  useC2cApi: () => ({
    health: null,
    mode: null,
    error: null,
    errorKind: null,
    loading: true,
  }),
}));

function SeedPaneState() {
  const { setSourceFile } = useSourceWorkspace();
  const { setState, ensureJavaBaseline, javaBuffers } = useTransformationRun();
  const seededRef = React.useRef(false);
  React.useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    setSourceFile(COBOL_SOURCE, "pasted-source.cbl", null);
    setState((current) => ({
      ...current,
      phase: "completed",
      runId: "run-248",
      programId: "PROG1",
      generated: {
        runId: "run-248",
        programId: "PROG1",
        mode: "live",
        productMode: "live",
        status: "generated",
        artifactRef: null,
        diagnostics: [],
      },
      generatedFiles: {
        status: "complete",
        entryFilePath: JAVA_FILE,
        files: [{ path: JAVA_FILE, sha256: "a".repeat(64) }],
        missingArtifacts: [],
      },
    }));
    void ensureJavaBaseline(JAVA_FILE, JAVA_SOURCE, "run-248");
  }, [ensureJavaBaseline, setSourceFile, setState]);
  return (
    <span data-testid="java-buffer-ready">
      {javaBuffers[JAVA_FILE]?.content === JAVA_SOURCE ? "ready" : "pending"}
    </span>
  );
}

function renderPane() {
  return render(
    <WorkbenchProvider>
      <TransformationRunProvider>
        <SourceWorkspaceProvider>
          <SeedPaneState />
          <CobolEditorPane />
        </SourceWorkspaceProvider>
      </TransformationRunProvider>
    </WorkbenchProvider>,
  );
}

describe("CobolEditorPane Alt+C lineage dispatch (Studio-IDE-6 #248)", () => {
  beforeEach(() => {
    capturedActions.length = 0;
    setMarkersCalls.length = 0;
    resolveCobolToJavaMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function altCAction(): CapturedAction {
    const action = capturedActions.find(
      (a) => a.id === "c2c.lineage.cobolToJava",
    );
    expect(action).toBeDefined();
    return action!;
  }

  it("registers an Alt+C action with id c2c.lineage.cobolToJava on mount", async () => {
    renderPane();
    await screen.findByTestId("code-editor-mock");
    expect(
      capturedActions.some((a) => a.id === "c2c.lineage.cobolToJava"),
    ).toBe(true);
  });

  it("dispatches c2c:reveal-java when resolveCobolToJava returns a target", async () => {
    renderPane();
    await screen.findByTestId("code-editor-mock");
    await waitFor(() =>
      expect(screen.getByTestId("java-buffer-ready").textContent).toBe("ready"),
    );

    const action = altCAction();
    resolveCobolToJavaMock.mockResolvedValue({
      ok: true,
      target: [
        {
          javaFile: "src/main/java/com/example/F.java",
          javaStartLine: 42,
          javaEndLine: 44,
        },
      ],
    });
    const events: CustomEvent[] = [];
    const listener = (ev: Event) => events.push(ev as CustomEvent);
    window.addEventListener("c2c:reveal-java", listener);
    try {
      await action.run(fakeEditor);
    } finally {
      window.removeEventListener("c2c:reveal-java", listener);
    }
    expect(resolveCobolToJavaMock).toHaveBeenCalledWith(
      "run-248",
      "pasted-source.cbl",
      5,
      undefined,
      expect.any(Function),
    );
    const provider = resolveCobolToJavaMock.mock.calls[0][4] as (
      javaFile: string,
    ) => string | null;
    expect(provider(JAVA_FILE)).toBe(JAVA_SOURCE);
    expect(events).toHaveLength(1);
    expect(events[0].detail).toEqual({
      javaFile: "src/main/java/com/example/F.java",
      javaLine: 42,
    });
    // Success path clears the lineage-feedback marker bucket.
    expect(setMarkersCalls.at(-1)).toEqual({
      owner: "c2c-lineage-feedback",
      markers: [],
    });
  });

  it("paints a Monaco info marker when resolveCobolToJava returns no target", async () => {
    renderPane();
    await screen.findByTestId("code-editor-mock");
    const action = altCAction();
    resolveCobolToJavaMock.mockResolvedValue({
      ok: false,
      reason: "no_mapping",
    });
    const events: CustomEvent[] = [];
    const listener = (ev: Event) => events.push(ev as CustomEvent);
    window.addEventListener("c2c:reveal-java", listener);
    try {
      await action.run(fakeEditor);
    } finally {
      window.removeEventListener("c2c:reveal-java", listener);
    }
    // Failure path: NO event dispatched, marker added under the lineage
    // owner with the spec-mandated message.
    expect(events).toHaveLength(0);
    const last = setMarkersCalls.at(-1);
    expect(last?.owner).toBe("c2c-lineage-feedback");
    expect(last?.markers).toHaveLength(1);
    expect((last?.markers[0] as { message: string }).message).toBe(
      "No Java target mapped for this COBOL line",
    );
  });

  it("paints the same marker when resolveCobolToJava rejects", async () => {
    renderPane();
    await screen.findByTestId("code-editor-mock");
    const action = altCAction();
    resolveCobolToJavaMock.mockRejectedValue(new Error("traceability failed"));
    await action.run(fakeEditor);
    const last = setMarkersCalls.at(-1);
    expect(last?.owner).toBe("c2c-lineage-feedback");
    expect((last?.markers[0] as { message: string }).message).toBe(
      "No Java target mapped for this COBOL line",
    );
  });
});

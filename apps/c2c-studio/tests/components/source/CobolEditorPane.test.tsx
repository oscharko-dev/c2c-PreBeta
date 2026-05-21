import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";

import { CobolEditorPane } from "@/components/source/CobolEditorPane";
import { SourceWorkspaceProvider } from "@/stores/sourceWorkspace";
import {
  TransformationRunProvider,
  useTransformationRun,
} from "@/stores/transformationRun";
import { WorkbenchProvider } from "@/stores/workbench";
import type { Diagnostic } from "@/types/api";
import type { EditorMarkerGroup } from "@/components/editor/codeEditorTypes";

// Capture mount/options calls so the tests can assert that CobolEditorPane
// drives Monaco through the documented CodeEditor surface (language id,
// model URI scheme, aria-label) without actually mounting Monaco. The Monaco
// runtime does not boot under vitest's jsdom environment — Studio-IDE-1's
// CodeEditor wiring is tested separately in tests/components/editor/.
type EditorMockProps = {
  value: string;
  onChange?: (next: string) => void;
  ariaLabel?: string;
  language: string;
  mode: string;
  modelUri?: string;
  beforeMount?: (args: { monaco: unknown }) => void;
  onMount?: (args: {
    editor: {
      getModel: () => null;
      updateOptions: (options: unknown) => void;
      addCommand: (
        keybinding: number,
        callback: () => void,
      ) => { dispose: () => void };
      // Studio-IDE-6 (#248): the COBOL pane now registers an Alt+C action
      // via `addAction`; the test mock satisfies the type so the keybinding
      // path executes without crashing the render.
      addAction: (descriptor: unknown) => { dispose: () => void };
    };
    monaco: unknown;
  }) => void;
  markerGroups?: EditorMarkerGroup[];
  className?: string;
};

const mountCalls: Array<{
  language: string;
  mode: string;
  modelUri?: string;
  ariaLabel?: string;
}> = [];
const updateOptionsCalls: Array<Record<string, unknown>> = [];
const commandRegistrations: Array<{ keybinding: number }> = [];
const actionRegistrations: Array<{
  id?: string;
  keybindings?: number[];
}> = [];
let latestMarkerGroups: EditorMarkerGroup[] | undefined;

const fakeMonaco = {
  KeyMod: { CtrlCmd: 1 << 11, Alt: 1 << 9, Shift: 1 << 10 },
  KeyCode: { KeyS: 49, KeyC: 33, KeyE: 35 },
  MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
};

vi.mock("@/components/editor/CodeEditor", async () => {
  const reactNs = await import("react");
  const CodeEditor = (props: EditorMockProps) => {
    latestMarkerGroups = props.markerGroups;
    reactNs.useEffect(() => {
      mountCalls.push({
        language: props.language,
        mode: props.mode,
        modelUri: props.modelUri,
        ariaLabel: props.ariaLabel,
      });
      props.beforeMount?.({ monaco: fakeMonaco });
      props.onMount?.({
        editor: {
          getModel: () => null,
          updateOptions: (options) => {
            updateOptionsCalls.push(options as Record<string, unknown>);
          },
          addCommand: (keybinding) => {
            commandRegistrations.push({ keybinding });
            return { dispose: () => undefined };
          },
          // Studio-IDE-6 (#248): no-op so the Alt+C action registration
          // path runs without throwing under the jsdom mock harness. The
          // action behaviour itself is covered by lineageNavigation.test.ts.
          addAction: (descriptor) => {
            actionRegistrations.push(
              descriptor as {
                id?: string;
                keybindings?: number[];
              },
            );
            return { dispose: () => undefined };
          },
        },
        monaco: fakeMonaco,
      });
      // Effect intentionally runs only on mount — matching Monaco's real
      // onMount lifecycle. Including `props` in deps would re-fire on every
      // re-render and break the mount-count assertion.
    }, []);
    return reactNs.createElement("textarea", {
      "aria-label": props.ariaLabel,
      "data-language": props.language,
      "data-mode": props.mode,
      "data-model-uri": props.modelUri,
      "data-testid": "code-editor-mock",
      className: props.className,
      value: props.value,
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
        props.onChange?.(event.currentTarget.value),
      spellCheck: false,
    });
  };
  return { CodeEditor };
});

// Capture registerCobolLanguage calls and short-circuit the lazy loader so
// the registration path runs without resolving Monaco.
const registerCalls: unknown[] = [];
vi.mock("@/lib/editor/cobolMonarch", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/editor/cobolMonarch")
  >("@/lib/editor/cobolMonarch");
  return {
    ...actual,
    registerCobolLanguage: (monaco: unknown) => {
      registerCalls.push(monaco);
    },
  };
});

vi.mock("@/lib/editor/lazyMonaco", () => ({
  getMonaco: () => Promise.resolve({ languages: { getLanguages: () => [] } }),
  getMonacoSync: () => null,
  useMonacoReady: () => fakeMonaco,
  __resetMonacoForTests: () => undefined,
}));

// Studio-IDE-9 (#254): the COBOL hover provider is registered alongside
// the language. The unit tests for the provider live next to its
// module; here we only need to confirm the editor pane wires the
// registration into both the early effect path and the onMount
// fallback, so we stub the export and capture the calls.
const hoverRegistrationCalls: unknown[] = [];
vi.mock("@/lib/editor/cobolHoverProvider", () => ({
  registerCobolHoverProvider: (monaco: unknown) => {
    hoverRegistrationCalls.push(monaco);
    return { dispose: () => undefined };
  },
}));

vi.mock("@/lib/apiClient", () => ({
  apiClient: {
    transform: vi.fn(),
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
    saveTrustCasePreference: vi.fn(),
    getRun: vi.fn(),
    getRunProgress: vi.fn(),
    getRunExperience: vi.fn(),
    getRunArtifacts: vi.fn(),
    getModelGatewayHealth: vi.fn(() =>
      Promise.resolve({ ok: true, data: { status: "ok" } }),
    ),
    getHarnessReady: vi.fn(() =>
      Promise.resolve({ ok: true, data: { status: "ok" } }),
    ),
  },
}));

vi.mock("@/hooks/useC2cApi", () => ({
  useC2cApi: () => ({
    health: { status: "ok" },
    mode: { orchestrator: "live", evidence: "live" },
    error: null,
    errorKind: null,
    loading: false,
  }),
}));

function renderPane() {
  return render(
    <WorkbenchProvider>
      <TransformationRunProvider>
        <SourceWorkspaceProvider>
          <CobolEditorPane />
        </SourceWorkspaceProvider>
      </TransformationRunProvider>
    </WorkbenchProvider>,
  );
}

function SeedRunState({ diagnostics }: { diagnostics: Diagnostic[] }) {
  const { setState } = useTransformationRun();
  React.useEffect(() => {
    setState((current) => ({
      ...current,
      phase: "completed",
      runId: "run-244",
      generated: {
        runId: "run-244",
        programId: "ISSUE244",
        mode: "live",
        productMode: "live",
        status: "generated",
        artifactRef: null,
        diagnostics,
      },
      buildTest: null,
    }));
  }, [diagnostics, setState]);
  return null;
}

function renderPaneWithDiagnostics(diagnostics: Diagnostic[]) {
  return render(
    <WorkbenchProvider>
      <TransformationRunProvider>
        <SourceWorkspaceProvider>
          <SeedRunState diagnostics={diagnostics} />
          <CobolEditorPane />
        </SourceWorkspaceProvider>
      </TransformationRunProvider>
    </WorkbenchProvider>,
  );
}

describe("CobolEditorPane — Monaco-backed COBOL editor (Issue #246)", () => {
  beforeEach(() => {
    mountCalls.length = 0;
    updateOptionsCalls.length = 0;
    commandRegistrations.length = 0;
    actionRegistrations.length = 0;
    registerCalls.length = 0;
    hoverRegistrationCalls.length = 0;
    latestMarkerGroups = undefined;
  });

  it("renders the empty state until the user starts typing", () => {
    renderPane();
    expect(screen.getByText("No source file selected")).toBeInTheDocument();
    expect(screen.queryByTestId("code-editor-mock")).not.toBeInTheDocument();
    expect(registerCalls).toHaveLength(0);
    expect(hoverRegistrationCalls).toHaveLength(0);
  });

  it("mounts CodeEditor in editable mode with the cobol language and a stable in-memory model URI", () => {
    renderPane();
    fireEvent.click(screen.getByText("Start Typing"));
    expect(mountCalls).toHaveLength(1);
    const [mount] = mountCalls;
    expect(mount.mode).toBe("editable");
    expect(mount.language).toBe("cobol");
    expect(mount.modelUri).toBe("inmemory://cobol-editor/pasted-source.cbl");
    expect(mount.ariaLabel).toBe("pasted-source.cbl COBOL source editor");
  });

  it("registers the COBOL language at mount so Monaco can tokenize without a flash of plaintext", () => {
    renderPane();
    fireEvent.click(screen.getByText("Start Typing"));
    // registerCobolLanguage must be invoked from CodeEditor's onMount
    // callback (the test mock fires onMount synchronously). The early-
    // resolve effect path also runs via the mocked getMonaco; whichever
    // path wins, registration MUST have happened at least once.
    expect(registerCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("registers the COBOL hover provider alongside the language (Studio-IDE-9 #254)", () => {
    renderPane();
    fireEvent.click(screen.getByText("Start Typing"));
    // Both the early effect path and the onMount fallback call
    // registerCobolHoverProvider — module-level idempotency in the
    // provider itself prevents double-attach against a real Monaco
    // instance, so we only require at least one invocation here.
    expect(hoverRegistrationCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("registers editor-scoped save, lineage, and explain keybindings", () => {
    renderPane();
    fireEvent.click(screen.getByText("Start Typing"));

    expect(commandRegistrations).toContainEqual({
      keybinding: (1 << 11) | 49,
    });
    expect(actionRegistrations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "c2c.lineage.cobolToJava",
          keybindings: [(1 << 9) | 33],
        }),
        expect.objectContaining({
          id: "c2c.editorAssist.explain",
          keybindings: [(1 << 11) | (1 << 10) | 35],
        }),
      ]),
    );
  });

  it("forwards the editor content to the source workspace on edit (dirty flag, character-accurate value)", () => {
    renderPane();
    fireEvent.click(screen.getByText("Start Typing"));
    const editor = screen.getByTestId("code-editor-mock");
    const next =
      "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. ISSUE246.\n";
    fireEvent.change(editor, { target: { value: next } });
    expect((editor as HTMLTextAreaElement).value).toBe(next);
    // Dirty marker rendered next to the source name.
    expect(screen.getByText(/pasted-source\.cbl \*/)).toBeInTheDocument();
    // Detected program id is derived from the source content (sourceAnalysis).
    expect(screen.getByText("ID: ISSUE246")).toBeInTheDocument();
  });

  it("preserves the AI Assist checkbox, source name, source hash chip, and line-ending indicator", () => {
    renderPane();
    fireEvent.click(screen.getByText("Start Typing"));
    // AI Assist checkbox — checked by default per the W0.3 contract.
    const assistToggle = screen.getByRole("checkbox", {
      name: /allow ai assist after deterministic baseline/i,
    });
    expect(assistToggle).toBeChecked();
    // Source name displayed in the header.
    expect(
      screen.getAllByText(/pasted-source\.cbl/).length,
    ).toBeGreaterThanOrEqual(1);
    // Source hash chip — initial empty source hashes to '00000000'.
    expect(screen.getByTitle("Source Hash")).toHaveTextContent("#00000000");
    // Line-ending indicator visible (LF for the empty default).
    expect(screen.getByText("LF")).toBeInTheDocument();
  });

  it("toggles the fixed-format ruler legend and pushes ruler columns into Monaco editor options", () => {
    renderPane();
    fireEvent.click(screen.getByText("Start Typing"));
    expect(screen.queryByTestId("fixed-format-ruler")).not.toBeInTheDocument();

    const toggle = screen.getByRole("switch", {
      name: /toggle cobol fixed-format ruler/i,
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    // Enable ruler.
    fireEvent.click(toggle);
    expect(screen.getByTestId("fixed-format-ruler")).toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-checked", "true");
    const enableCall = updateOptionsCalls.find(
      (call) =>
        Array.isArray((call as { rulers?: unknown[] }).rulers) &&
        ((call as { rulers: number[] }).rulers.length ?? 0) > 0,
    );
    expect(enableCall).toBeDefined();
    expect((enableCall as { rulers: number[] }).rulers).toEqual([
      6, 7, 11, 72, 80,
    ]);

    // Disable ruler — Monaco should be told to clear its column guides.
    fireEvent.click(toggle);
    expect(screen.queryByTestId("fixed-format-ruler")).not.toBeInTheDocument();
    const lastCall = updateOptionsCalls[updateOptionsCalls.length - 1] as {
      rulers: number[];
    };
    expect(lastCall.rulers).toEqual([]);
  });

  it("shares the 2000-marker editor budget across COBOL and IR owners", async () => {
    const diagnostics: Diagnostic[] = [
      ...Array.from({ length: 1500 }, (_, index) => ({
        schemaVersion: "v0" as const,
        severity: "error" as const,
        code: "COBOL",
        message: `cobol-${index}`,
        line: 1,
        filePath: "pasted-source.cbl",
        sourceKind: "cobol" as const,
      })),
      ...Array.from({ length: 1500 }, (_, index) => ({
        schemaVersion: "v0" as const,
        severity: "warning" as const,
        code: "IR",
        message: `ir-${index}`,
        line: 1,
        filePath: "pasted-source.cbl",
        sourceKind: "ir" as const,
      })),
    ];

    renderPaneWithDiagnostics(diagnostics);
    fireEvent.click(screen.getByText("Start Typing"));

    await vi.waitFor(() => {
      const cobolGroup = latestMarkerGroups?.find(
        (group) => group.owner === "c2c-cobol",
      );
      const irGroup = latestMarkerGroups?.find(
        (group) => group.owner === "c2c-ir",
      );
      expect(cobolGroup?.markers).toHaveLength(1500);
      expect(irGroup?.markers).toHaveLength(500);
    });
  });

  // The full submit-path contract (verb body forwarding, AI-assist gating,
  // 503 handling) is already exercised in tests/components/source/
  // SourceWorkspace.test.tsx. Repeating it here would also pull in the run
  // polling effect which expects a fully-shaped apiClient mock; keep this
  // file focused on the COBOL-editor surface (language registration, ruler,
  // model URI) and rely on SourceWorkspace.test.tsx for the workspace
  // submission contract.
});

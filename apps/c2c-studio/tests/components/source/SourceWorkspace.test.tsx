import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CobolEditorPane } from "@/components/source/CobolEditorPane";
import { SecondaryStripe } from "@/components/workbench/SecondaryStripe";
import { WorkbenchProvider } from "@/stores/workbench";
import {
  SourceWorkspaceProvider,
  useSourceWorkspace,
} from "@/stores/sourceWorkspace";
import {
  TransformationRunProvider,
  useTransformationRun,
} from "@/stores/transformationRun";
import { apiClient } from "@/lib/apiClient";
import { AppTopBar } from "@/components/workbench/AppTopBar";
import {
  ApiResult,
  TransformResponse,
  RunSummary,
  RunProgressView,
} from "@/types/api";
import {
  RunExperienceView,
  ModelGatewayHealth,
  HarnessReady,
} from "@/types/observability";
import { useEffect } from "react";

function okResult<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

vi.mock("@/lib/apiClient", () => ({
  apiClient: {
    transform: vi.fn(),
    getRun: vi.fn(),
    getGenerated: vi.fn(),
    getGeneratedFiles: vi.fn(),
    getBuildTest: vi.fn(),
    getEvidence: vi.fn(),
    getRunEvents: vi.fn(),
    getRunProgress: vi.fn(),
    getRunArtifacts: vi.fn(),
    getRunExperience: vi.fn(),
    getRunWorkflow: vi.fn(),
    getModelGatewayHealth: vi.fn(),
    getModelGatewayModels: vi.fn(),
    getHarnessReady: vi.fn(),
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

const { getCurrentDraftScopeMock, loadDraftMock, saveDraftMock } = vi.hoisted(
  () => ({
    getCurrentDraftScopeMock: vi.fn(),
    loadDraftMock: vi.fn(),
    saveDraftMock: vi.fn(),
  }),
);

const { emitTelemetryMock } = vi.hoisted(() => ({
  emitTelemetryMock: vi.fn(),
}));

vi.mock("@/lib/editor/editorPersistence", () => ({
  getCurrentDraftScope: getCurrentDraftScopeMock,
  subscribeToDraftPersistenceEvents: vi.fn(() => () => {}),
  editorPersistence: {
    loadDraft: loadDraftMock,
    saveDraft: saveDraftMock,
  },
}));

vi.mock("@/lib/editor/editorTelemetry", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/editor/editorTelemetry")
  >("@/lib/editor/editorTelemetry");
  return {
    ...actual,
    emit: emitTelemetryMock,
  };
});

// Monaco does not boot under vitest's jsdom environment (the lazy loader
// itself is exercised in tests/lib/editor/lazyMonaco.test.ts via mocks).
// For component tests that mount CobolEditorPane, we mock the CodeEditor
// surface with a faithful-enough <textarea> stand-in so the existing
// behavior assertions (aria-label, value mirroring, onChange, dirty flag)
// continue to verify the source-workspace wiring without depending on
// the full Monaco runtime.
vi.mock("@/components/editor/CodeEditor", async () => {
  const React = await import("react");
  type CodeEditorMockProps = {
    value: string;
    onChange?: (next: string) => void;
    ariaLabel?: string;
    language: string;
    mode: string;
    modelUri?: string;
    className?: string;
  };
  const CodeEditor = ({
    value,
    onChange,
    ariaLabel,
    language,
    mode,
    modelUri,
    className,
  }: CodeEditorMockProps) =>
    React.createElement("textarea", {
      "aria-label": ariaLabel,
      "data-language": language,
      "data-mode": mode,
      "data-model-uri": modelUri,
      "data-testid": "code-editor-mock",
      className,
      value,
      onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
        onChange?.(event.currentTarget.value),
      spellCheck: false,
    });
  return { CodeEditor };
});

// CobolEditorPane registers the COBOL language by calling getMonaco(); under
// jsdom Monaco never resolves, so we stub the loader to a no-op promise.
vi.mock("@/lib/editor/lazyMonaco", () => ({
  getMonaco: () => new Promise(() => {}),
  getMonacoSync: () => null,
  useMonacoReady: () => null,
  __resetMonacoForTests: () => undefined,
}));

function renderSourceWorkbench(children: React.ReactNode) {
  return render(
    <WorkbenchProvider>
      <TransformationRunProvider>
        <SourceWorkspaceProvider>{children}</SourceWorkspaceProvider>
      </TransformationRunProvider>
    </WorkbenchProvider>,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function FileOpenRaceHarness() {
  const { setSourceFile, sourceText } = useSourceWorkspace();
  return (
    <>
      <button
        type="button"
        onClick={() => setSourceFile("A backend", "a.cbl", "a.cbl")}
      >
        Open A
      </button>
      <button
        type="button"
        onClick={() => setSourceFile("B backend", "b.cbl", "b.cbl")}
      >
        Open B
      </button>
      <output data-testid="source-text">{sourceText}</output>
    </>
  );
}

function SameBasenameHarness() {
  const { setSourceFile } = useSourceWorkspace();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          setSourceFile("A source", "DUPLICATE.cbl", "src/a/DUPLICATE.cbl")
        }
      >
        Open Duplicate A
      </button>
      <button
        type="button"
        onClick={() =>
          setSourceFile("B source", "DUPLICATE.cbl", "src/b/DUPLICATE.cbl")
        }
      >
        Open Duplicate B
      </button>
    </>
  );
}

function DraftKeyHarness() {
  const { setSourceFile, setSourceText, saveDraftNow } = useSourceWorkspace();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          setSourceFile(
            "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. OLDID.\n",
            "PAYROLL.cbl",
            "src/PAYROLL.cbl",
          )
        }
      >
        Open Payroll
      </button>
      <button
        type="button"
        onClick={() =>
          setSourceText(
            "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. NEWID.\n",
          )
        }
      >
        Rename Program
      </button>
      <button
        type="button"
        onClick={() => {
          void saveDraftNow();
        }}
      >
        Save Draft
      </button>
    </>
  );
}

function findPayrollDraftKey(calls: unknown[][]) {
  return calls
    .map((call) => call[1])
    .find(
      (
        key,
      ): key is {
        programId: string;
        sourceName: string;
      } =>
        typeof key === "object" &&
        key !== null &&
        "programId" in key &&
        "sourceName" in key &&
        key.sourceName === "PAYROLL.cbl",
    );
}

function ConflictStoreHarness() {
  const { setSourceFile, sourceText, conflict, resolveConflict } =
    useSourceWorkspace();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          setSourceFile("backend version", "PAYROLL.cbl", "src/PAYROLL.cbl")
        }
      >
        Open Backend
      </button>
      <button
        type="button"
        onClick={() => resolveConflict("localDraft")}
        disabled={!conflict}
      >
        Keep Local
      </button>
      <output data-testid="source-text">{sourceText}</output>
      <output data-testid="conflict-local">{conflict?.localDraft ?? ""}</output>
      <output data-testid="conflict-last-run">
        {conflict?.lastRunInput ?? ""}
      </output>
    </>
  );
}

describe("COBOL source input", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getCurrentDraftScopeMock.mockResolvedValue({
      tenantId: "tenant-A",
      userId: "user-1",
    });
    loadDraftMock.mockResolvedValue(null);
    saveDraftMock.mockResolvedValue({
      encryptedSize: 1,
      ttlExpiresAt: "2026-06-01T00:00:00.000Z",
    });
    vi.mocked(apiClient.getRun).mockResolvedValue(
      okResult<RunSummary>({
        runId: "run-1",
        programId: "P1",
        status: "updating",
        mode: "live",
        productMode: "live",
        createdAt: "2026-05-15T10:00:00Z",
        updatedAt: "2026-05-15T10:00:01Z",
      }),
    );
    vi.mocked(apiClient.getRunProgress).mockResolvedValue(
      okResult<RunProgressView>({
        runId: "run-1",
        programId: "P1",
        mode: "live",
        productMode: "live",
        status: "complete",
        currentStep: null,
        failedStep: null,
        completedSteps: [],
        stepCount: 0,
        steps: [],
      }),
    );
    vi.mocked(apiClient.getRunExperience).mockResolvedValue(
      okResult<RunExperienceView>({
        runId: "run-1",
        programId: "P1",
        mode: "live",
        productMode: "live",
        summary: undefined,
      }),
    );
    vi.mocked(apiClient.getModelGatewayHealth).mockResolvedValue(
      okResult<ModelGatewayHealth>({ status: "ok" }),
    );
    vi.mocked(apiClient.getHarnessReady).mockResolvedValue(
      okResult<HarnessReady>({ status: "ok" }),
    );
  });

  function SetUnsupportedRunState() {
    const { setState } = useTransformationRun();

    useEffect(() => {
      setState((prev) => ({
        ...prev,
        phase: "completed",
        runId: "run-unsupported",
        generated: {
          runId: "run-unsupported",
          programId: "P-UNSUPPORTED",
          mode: "live",
          productMode: "live",
          status: "unsupported",
          unsupportedFeatures: ["COPY REPLACING"],
          artifactRef: null,
        },
      }));
    }, [setState]);

    return null;
  }

  function DirtyJavaBufferHarness() {
    const { ensureJavaBaseline, javaBuffers, setJavaBufferContent } =
      useTransformationRun();

    useEffect(() => {
      void ensureJavaBaseline("src/App.java", "class App {}", "run-java").then(
        () => {
          setJavaBufferContent("src/App.java", "class App { int edited; }");
        },
      );
    }, [ensureJavaBaseline, setJavaBufferContent]);

    return (
      <span data-testid="java-dirty-state">
        {javaBuffers["src/App.java"]?.isDirty ? "dirty" : "clean"}
      </span>
    );
  }

  it("renders a COBOL explorer without preloaded program loading", () => {
    renderSourceWorkbench(
      <>
        <SecondaryStripe />
        <CobolEditorPane />
      </>,
    );

    expect(screen.getByText("COBOL Explorer")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /open cobol file/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tree", { name: "COBOL source files" }),
    ).toBeInTheDocument();
    expect(screen.getByText("No COBOL file loaded")).toBeInTheDocument();
    expect(screen.queryByText(/reference/i)).not.toBeInTheDocument();
  });

  it("loads a user-selected COBOL file into the editor and explorer", async () => {
    renderSourceWorkbench(
      <>
        <SecondaryStripe />
        <CobolEditorPane />
      </>,
    );

    const source =
      "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. PAY01.\n";
    const file = new File([source], "payroll.cbl", { type: "text/plain" });
    fireEvent.change(screen.getByLabelText("Open COBOL source file"), {
      target: { files: [file] },
    });

    expect(
      await screen.findByRole("textbox", { name: /COBOL source editor/i }),
    ).toHaveValue(source);
    expect(screen.getAllByText("payroll.cbl").length).toBeGreaterThan(0);
    expect(screen.getByText("ID: PAY01")).toBeInTheDocument();
  });

  it("ignores stale async draft restore results after a newer file opens", async () => {
    const staleDraft = deferred<{
      payload: {
        schemaVersion: "v0";
        kind: "cobol";
        content: string;
        bufferHash: string;
        savedAt: string;
      };
      isExpired: boolean;
      savedAt: string;
      ttlExpiresAt: string;
    } | null>();
    loadDraftMock.mockImplementation(
      async (_scope: unknown, key: { sourceName: string }) => {
        if (key.sourceName === "a.cbl") {
          return staleDraft.promise;
        }
        return null;
      },
    );
    renderSourceWorkbench(<FileOpenRaceHarness />);

    fireEvent.click(screen.getByRole("button", { name: "Open A" }));
    fireEvent.click(screen.getByRole("button", { name: "Open B" }));
    expect(screen.getByTestId("source-text")).toHaveTextContent("B backend");

    await act(async () => {
      staleDraft.resolve({
        payload: {
          schemaVersion: "v0",
          kind: "cobol",
          content: "A local draft",
          bufferHash: "hash-a",
          savedAt: "2026-05-19T00:00:00.000Z",
        },
        isExpired: false,
        savedAt: "2026-05-19T00:00:00.000Z",
        ttlExpiresAt: "2026-06-02T00:00:00.000Z",
      });
      await staleDraft.promise;
    });

    expect(screen.getByTestId("source-text")).toHaveTextContent("B backend");
  });

  it("editing source marks the buffer dirty and submits only the user source", async () => {
    vi.mocked(apiClient.transform).mockResolvedValue({
      ok: true,
      data: {
        runId: "r1",
        programId: "SRC-1",
        status: "starting",
      } as unknown as TransformResponse,
    });

    renderSourceWorkbench(<CobolEditorPane />);

    fireEvent.click(screen.getByText("Start Typing"));
    const textarea = screen.getByRole("textbox", {
      name: /COBOL source editor/i,
    });
    fireEvent.change(textarea, {
      target: {
        value: "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. OWN01.\n",
      },
    });
    fireEvent.click(screen.getByText("Start Transformation"));

    await waitFor(() => {
      expect(apiClient.transform).toHaveBeenCalledWith({
        sourceText:
          "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. OWN01.\n",
        programId: undefined,
        sourceName: "pasted-source.cbl",
        targetLanguage: "java",
        expectedOutput: undefined,
        oracleInput: undefined,
        useTransformationAgent: true,
      });
    });
  });

  it("passes synchronous Java dirty state into Start Transformation telemetry", async () => {
    vi.mocked(apiClient.transform).mockResolvedValue({
      ok: true,
      data: {
        runId: "r1",
        programId: "SRC-1",
        status: "starting",
      } as unknown as TransformResponse,
    });

    renderSourceWorkbench(
      <>
        <DirtyJavaBufferHarness />
        <CobolEditorPane />
      </>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("java-dirty-state")).toHaveTextContent("dirty");
    });

    fireEvent.click(screen.getByText("Start Typing"));
    const textarea = screen.getByRole("textbox", {
      name: /COBOL source editor/i,
    });
    fireEvent.change(textarea, {
      target: {
        value: "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. OWN01.\n",
      },
    });
    fireEvent.click(screen.getByText("Start Transformation"));

    await waitFor(() => {
      expect(emitTelemetryMock).toHaveBeenCalledWith({
        eventType: "generate.invoked",
        payload: {
          trigger: "generate_and_verify",
          hadManualEdits: true,
        },
      });
    });
  });

  it("uses source identity path, not basename alone, for the COBOL Monaco model URI", async () => {
    renderSourceWorkbench(
      <>
        <SameBasenameHarness />
        <CobolEditorPane />
      </>,
    );

    fireEvent.click(screen.getByText("Open Duplicate A"));
    const editor = await screen.findByTestId("code-editor-mock");
    expect(editor).toHaveAttribute(
      "data-model-uri",
      `inmemory://cobol-editor/${encodeURIComponent("src/a/DUPLICATE.cbl")}`,
    );

    fireEvent.click(screen.getByText("Open Duplicate B"));
    await waitFor(() => {
      expect(screen.getByTestId("code-editor-mock")).toHaveAttribute(
        "data-model-uri",
        `inmemory://cobol-editor/${encodeURIComponent("src/b/DUPLICATE.cbl")}`,
      );
    });
  });

  it("uses a stable path-backed draft key even when PROGRAM-ID changes before save", async () => {
    renderSourceWorkbench(<DraftKeyHarness />);

    fireEvent.click(screen.getByText("Open Payroll"));
    await waitFor(() =>
      expect(findPayrollDraftKey(loadDraftMock.mock.calls)).toBeDefined(),
    );
    const openedKey = findPayrollDraftKey(loadDraftMock.mock.calls);
    if (!openedKey) {
      throw new Error("PAYROLL.cbl draft load key was not captured.");
    }

    fireEvent.click(screen.getByText("Rename Program"));
    fireEvent.click(screen.getByText("Save Draft"));

    await waitFor(() =>
      expect(findPayrollDraftKey(saveDraftMock.mock.calls)).toBeDefined(),
    );
    const savedKey = findPayrollDraftKey(saveDraftMock.mock.calls);
    if (!savedKey) {
      throw new Error("PAYROLL.cbl draft save key was not captured.");
    }
    expect(savedKey.programId).toBe(openedKey.programId);
    expect(savedKey.programId).not.toBe("NEWID");
    expect(savedKey.programId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("persists a COBOL conflict resolution and suppresses the same conflict on reopen", async () => {
    const savedPayloads: unknown[] = [];
    loadDraftMock.mockResolvedValueOnce({
      payload: {
        schemaVersion: "v0",
        kind: "cobol",
        content: "local version",
        bufferHash: "local-hash",
        lastRunInputHash: "last-hash",
        lastRunInputContent: "last run version",
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

    renderSourceWorkbench(<ConflictStoreHarness />);

    fireEvent.click(screen.getByText("Open Backend"));
    await waitFor(() => {
      expect(screen.getByTestId("conflict-local")).toHaveTextContent(
        "local version",
      );
    });
    expect(screen.getByTestId("conflict-last-run")).toHaveTextContent(
      "last run version",
    );

    fireEvent.click(screen.getByText("Keep Local"));
    await waitFor(() => expect(saveDraftMock).toHaveBeenCalledTimes(1));
    expect(savedPayloads[0]).toEqual(
      expect.objectContaining({
        content: "local version",
        lastRunInputContent: "last run version",
        resolvedBackendHash: expect.any(String),
      }),
    );

    loadDraftMock.mockResolvedValueOnce({
      payload: savedPayloads[0],
      isExpired: false,
      savedAt: "2026-05-19T00:00:00.000Z",
      ttlExpiresAt: "2026-06-02T00:00:00.000Z",
    });
    fireEvent.click(screen.getByText("Open Backend"));

    await waitFor(() => {
      expect(screen.getByTestId("source-text")).toHaveTextContent(
        "local version",
      );
    });
    expect(screen.getByTestId("conflict-local")).toHaveTextContent("");
  });

  it("submits optional expected output and oracle input when provided", async () => {
    vi.mocked(apiClient.transform).mockResolvedValue({
      ok: true,
      data: {
        runId: "r-oracle",
        programId: "SRC-1",
        status: "starting",
      } as unknown as TransformResponse,
    });

    renderSourceWorkbench(<CobolEditorPane />);

    fireEvent.click(screen.getByText("Start Typing"));
    fireEvent.change(
      screen.getByRole("textbox", { name: /COBOL source editor/i }),
      {
        target: {
          value: "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. OWN02.\n",
        },
      },
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: /optional expected output/i }),
      {
        target: { value: "DONE\n" },
      },
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: /optional oracle input/i }),
      {
        target: { value: "stdin line\n" },
      },
    );
    fireEvent.click(
      screen.getByRole("button", { name: /start transformation/i }),
    );

    await waitFor(() => {
      expect(apiClient.transform).toHaveBeenCalledWith({
        sourceText:
          "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. OWN02.\n",
        programId: undefined,
        sourceName: "pasted-source.cbl",
        targetLanguage: "java",
        expectedOutput: "DONE\n",
        oracleInput: "stdin line\n",
        useTransformationAgent: true,
      });
    });
  });

  it("keeps AI assist enabled by default and lets the user explicitly disable it", async () => {
    vi.mocked(apiClient.transform).mockResolvedValue({
      ok: true,
      data: {
        runId: "r-assist",
        programId: "SRC-1",
        status: "starting",
      } as unknown as TransformResponse,
    });

    renderSourceWorkbench(<CobolEditorPane />);

    fireEvent.click(screen.getByText("Start Typing"));
    const assistToggle = screen.getByRole("checkbox", {
      name: /allow ai assist after deterministic baseline/i,
    });
    expect(assistToggle).toBeChecked();
    fireEvent.change(
      screen.getByRole("textbox", { name: /COBOL source editor/i }),
      {
        target: {
          value: "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. OWN05.\n",
        },
      },
    );
    fireEvent.click(assistToggle);
    fireEvent.click(
      screen.getByRole("button", { name: /start transformation/i }),
    );

    await waitFor(() => {
      expect(apiClient.transform).toHaveBeenCalledWith({
        sourceText:
          "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. OWN05.\n",
        programId: undefined,
        sourceName: "pasted-source.cbl",
        targetLanguage: "java",
        expectedOutput: undefined,
        oracleInput: undefined,
        useTransformationAgent: false,
      });
    });
  });

  it("keeps oracle text fields as internally scrollable controls instead of resizing the IDE shell", () => {
    renderSourceWorkbench(<CobolEditorPane />);

    fireEvent.click(screen.getByText("Start Typing"));

    expect(
      screen.getByRole("textbox", { name: /optional expected output/i }),
    ).toHaveClass("h-20");
    expect(
      screen.getByRole("textbox", { name: /optional expected output/i }),
    ).toHaveClass("resize-none");
    expect(
      screen.getByRole("textbox", { name: /optional expected output/i }),
    ).toHaveClass("overflow-auto");
    expect(
      screen.getByRole("textbox", { name: /optional oracle input/i }),
    ).toHaveClass("h-20");
    expect(
      screen.getByRole("textbox", { name: /optional oracle input/i }),
    ).toHaveClass("resize-none");
    expect(
      screen.getByRole("textbox", { name: /optional oracle input/i }),
    ).toHaveClass("overflow-auto");
  });

  it("top bar start action submits the current editor buffer", async () => {
    vi.mocked(apiClient.transform).mockResolvedValue({
      ok: true,
      data: {
        runId: "r3",
        programId: "OWN03",
        status: "starting",
      } as unknown as TransformResponse,
    });

    renderSourceWorkbench(
      <>
        <AppTopBar
          apiState={{
            health: { status: "ok" },
            mode: { orchestrator: "live", evidence: "live" },
            error: null,
            errorKind: null,
            loading: false,
          }}
        />
        <CobolEditorPane />
      </>,
    );

    fireEvent.click(screen.getByText("Start Typing"));
    fireEvent.change(
      screen.getByRole("textbox", { name: /COBOL source editor/i }),
      {
        target: {
          value: "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. OWN03.\n",
        },
      },
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: /start transformation/i })[0],
    );

    await waitFor(() => {
      expect(apiClient.transform).toHaveBeenCalledWith({
        sourceText:
          "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. OWN03.\n",
        programId: undefined,
        sourceName: "pasted-source.cbl",
        targetLanguage: "java",
        expectedOutput: undefined,
        oracleInput: undefined,
        useTransformationAgent: true,
      });
    });
  });

  it("disabled states prevent blank submission", () => {
    renderSourceWorkbench(<CobolEditorPane />);

    expect(screen.queryByText("Start Transformation")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Start Typing"));
    expect(
      screen.getByRole("button", { name: /Start Transformation/i }),
    ).toBeDisabled();
  });

  it("blocks default AI-assisted submission when the Model Gateway is unavailable until AI assist is disabled", async () => {
    vi.mocked(apiClient.getModelGatewayHealth).mockResolvedValue(
      okResult<ModelGatewayHealth>({
        status: "unavailable",
        error: "No model is currently available",
      }),
    );

    renderSourceWorkbench(<CobolEditorPane />);

    fireEvent.click(screen.getByText("Start Typing"));
    fireEvent.change(
      screen.getByRole("textbox", { name: /COBOL source editor/i }),
      {
        target: {
          value: "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. OWN06.\n",
        },
      },
    );

    expect(
      await screen.findByText(/No model is currently available/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /start transformation/i }),
    ).toBeDisabled();

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: /allow ai assist after deterministic baseline/i,
      }),
    );
    expect(
      screen.getByRole("button", { name: /start transformation/i }),
    ).not.toBeDisabled();
  });

  it("keeps a large source buffer addressable through the Monaco-backed editor surface", async () => {
    // Issue #246: gutter virtualization is no longer a React responsibility —
    // Monaco draws and virtualizes the line-number gutter natively. This
    // test now verifies the contract the source workspace must hold up
    // regardless of buffer size: the editor mounts with the canonical
    // aria-label, the dirty flag is set on edit, and the workspace store
    // mirrors the value supplied to the editor character-for-character.
    renderSourceWorkbench(<CobolEditorPane />);

    fireEvent.click(screen.getByText("Start Typing"));

    const largeSource = Array.from(
      { length: 1200 },
      (_, index) => `LINE_${String(index + 1).padStart(4, "0")}`,
    ).join("\n");
    const editor = screen.getByRole("textbox", {
      name: /COBOL source editor/i,
    });
    fireEvent.change(editor, { target: { value: largeSource } });

    expect(editor).toHaveAttribute(
      "aria-label",
      "pasted-source.cbl COBOL source editor",
    );
    expect(editor).toHaveAttribute("data-language", "cobol");
    expect((editor as HTMLTextAreaElement).value).toBe(largeSource);
    // The dirty asterisk should now follow the source name in the header.
    expect(screen.getByText(/pasted-source\.cbl \*/)).toBeInTheDocument();
  });

  it("preserves the editor buffer and shows backend-unavailable errors", async () => {
    vi.mocked(apiClient.transform).mockResolvedValue({
      ok: false,
      status: 503,
      message: "orchestrator unavailable",
      details: { kind: "http", body: { error: "orchestrator unavailable" } },
    });

    renderSourceWorkbench(<CobolEditorPane />);

    fireEvent.click(screen.getByText("Start Typing"));
    fireEvent.change(
      screen.getByRole("textbox", { name: /COBOL source editor/i }),
      {
        target: {
          value: "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. OWN04.\n",
        },
      },
    );
    fireEvent.click(
      screen.getByRole("button", { name: /start transformation/i }),
    );

    expect(
      await screen.findByText("Backend unavailable. Try again shortly."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: /COBOL source editor/i }),
    ).toHaveValue(
      "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. OWN04.\n",
    );
  });

  it("shows unsupported constructs next to the source editor when the run is blocked by W0 scope", async () => {
    renderSourceWorkbench(
      <>
        <SetUnsupportedRunState />
        <CobolEditorPane />
      </>,
    );

    fireEvent.click(screen.getByText("Start Typing"));

    expect(
      await screen.findByText("Unsupported COBOL constructs block this run."),
    ).toBeInTheDocument();
    expect(screen.getByText("COPY REPLACING")).toBeInTheDocument();
  });
});

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { CobolEditorPane } from "@/components/source/CobolEditorPane";
import { SecondaryStripe } from "@/components/workbench/SecondaryStripe";
import { WorkbenchProvider } from "@/stores/workbench";
import { SourceWorkspaceProvider } from "@/stores/sourceWorkspace";
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

describe("COBOL source input", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

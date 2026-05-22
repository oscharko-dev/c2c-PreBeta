import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiClient } from "@/lib/apiClient";
import {
  TransformationRunProvider,
  useTransformationRun,
} from "@/stores/transformationRun";
import {
  ApiResult,
  TransformResponse,
  GeneratedView,
  GeneratedFilesIndex,
  BuildTestView,
  EvidenceView,
  RunEventsView,
  RunArtifactsView,
  RunSummary,
  RunProgressView,
} from "@/types/api";
import {
  RunExperienceView,
  ModelGatewayHealth,
  HarnessReady,
} from "@/types/observability";

vi.mock("@/lib/apiClient", () => ({
  apiClient: {
    transform: vi.fn(),
    exportParityEvidenceScaffold: vi.fn(),
    upsertIntentionalDivergenceDecision: vi.fn(),
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

function okResult<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

function makeTerminalResponse(
  runId: string,
  programId: string,
  status: "completed" | "failed",
): ApiResult<TransformResponse> {
  return okResult<TransformResponse>({
    runId,
    orchestratorRunId: `${runId}-orch`,
    programId,
    status,
    mode: "live",
    productMode: "live",
    createdAt: "2026-05-15T10:00:00Z",
    updatedAt: "2026-05-15T10:00:01Z",
    activeStep: null,
    agentAttemptCount: 0,
    repairBudget: null,
    finalClassification: null,
    failureCode: null,
    failureMessage: null,
    links: {
      self: `/runs/${runId}`,
      generated: `/runs/${runId}/generated`,
      generatedFiles: `/runs/${runId}/generated/files`,
      buildTest: `/runs/${runId}/build-test`,
      evidence: `/runs/${runId}/evidence`,
      progress: `/runs/${runId}/progress`,
      events: `/runs/${runId}/events`,
      artifacts: `/runs/${runId}/artifacts`,
      learning: `/runs/${runId}/learning`,
      workflow: `/runs/${runId}/workflow`,
    },
  });
}

function makeProgressFixture(
  runId: string,
  programId: string,
): ApiResult<RunProgressView> {
  return okResult<RunProgressView>({
    runId,
    programId,
    mode: "live",
    productMode: "live",
    status: "complete",
    runStatus: "completed",
    currentStep: null,
    failedStep: null,
    completedSteps: [
      "accepted",
      "parse-cobol",
      "generate-ir",
      "generate-java",
      "compile-test-java",
      "write-evidence",
      "completed",
    ],
    stepCount: 8,
    steps: [
      {
        stepId: 1,
        name: "accepted",
        capabilityId: "orchestrator-service",
        service: "orchestrator-service",
        actor: "orchestrator-service",
        status: "ok",
      },
      {
        stepId: 2,
        name: "parse-cobol",
        capabilityId: "parse-cobol-service",
        service: "orchestrator-service",
        actor: "parse-cobol-service",
        status: "ok",
        latencyMs: 12,
      },
      {
        stepId: 3,
        name: "model-policy-skipped",
        capabilityId: "orchestrator-service",
        service: "orchestrator-service",
        actor: "orchestrator-service",
        status: "skipped",
        diagnostic: "no modelPrompt provided by requester",
      },
    ],
  });
}

interface ArtifactFixtures {
  generated: ApiResult<GeneratedView>;
  generatedFiles: ApiResult<GeneratedFilesIndex>;
  buildTest: ApiResult<BuildTestView>;
  evidence: ApiResult<EvidenceView>;
  events: ApiResult<RunEventsView>;
  artifacts: ApiResult<RunArtifactsView>;
}

function makeArtifactFixtures(
  runId: string,
  programId: string,
  sha256: string,
  eventStatus: "completed" | "failed" = "completed",
): ArtifactFixtures {
  return {
    generated: okResult<GeneratedView>({
      runId,
      programId,
      mode: "live",
      productMode: "live",
      status: "generated",
      artifactRef: { sha256 },
    }),
    generatedFiles: okResult<GeneratedFilesIndex>({
      runId,
      programId,
      mode: "live",
      productMode: "live",
      status: "complete",
      files: [],
      fileCount: 0,
      artifactRef: { sha256 },
    }),
    buildTest: okResult<BuildTestView>({
      runId,
      programId,
      mode: "live",
      productMode: "live",
      status: "ok",
      classification: "match",
      generatedArtifactRef: { sha256 },
    }),
    evidence: okResult<EvidenceView>({
      runId,
      programId,
      mode: "live",
      productMode: "live",
      status: "complete",
      generatedArtifactRef: { sha256 },
    }),
    events: okResult<RunEventsView>({
      runId,
      programId,
      mode: "live",
      productMode: "live",
      events: [
        {
          type: "run.completed",
          status: eventStatus,
          message: "done",
          createdAt: "2026-05-15T10:00:02Z",
        },
      ],
    }),
    artifacts: okResult<RunArtifactsView>({
      runId,
      programId,
      mode: "live",
      productMode: "live",
      artifacts: [
        {
          sha256,
          kind: "generated",
          createdBy: "orchestrator",
          createdAt: "2026-05-15T10:00:02Z",
          path: "artifact.json",
          name: "artifact.json",
        },
      ],
    }),
  };
}

function makeRunSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "run-test",
    programId: "P-A",
    status: "updating",
    mode: "live",
    productMode: "live",
    createdAt: "2026-05-15T10:00:00Z",
    updatedAt: "2026-05-15T10:00:01Z",
    activeStep: null,
    agentAttemptCount: 0,
    repairBudget: null,
    finalClassification: null,
    failureCode: null,
    failureMessage: null,
    ...overrides,
  };
}

function makeExperienceResult(
  runId: string,
  programId: string,
): ApiResult<RunExperienceView> {
  return okResult<RunExperienceView>({
    runId,
    programId,
    mode: "live",
    productMode: "live",
    summary: undefined,
  });
}

function RunHarness() {
  const {
    state,
    startTransform,
    exportParityEvidenceScaffold,
    submitIntentionalDivergenceDecision,
    intentionalDivergenceDecision,
    intentionalDivergenceDecisionStatus,
    intentionalDivergenceDecisionError,
  } = useTransformationRun();

  return (
    <div>
      <div data-testid="phase">{state.phase}</div>
      <div data-testid="run-id">{state.runId ?? "none"}</div>
      <div data-testid="summary-status">{state.summary?.status ?? "none"}</div>
      <div data-testid="generated-status">
        {state.generated?.status ?? "none"}
      </div>
      <div data-testid="generated-files-status">
        {state.generatedFiles?.status ?? "none"}
      </div>
      <div data-testid="build-test-status">
        {state.buildTest?.status ?? "none"}
      </div>
      <div data-testid="evidence-status">
        {state.evidence?.status ?? "none"}
      </div>
      <div data-testid="progress-count">
        {state.progress?.steps.length ?? 0}
      </div>
      <div data-testid="artifacts-count">
        {state.artifacts?.artifacts.length ?? 0}
      </div>
      <div data-testid="generated-sha">
        {state.generated?.artifactRef?.sha256 ?? "none"}
      </div>
      <div data-testid="evidence-sha">
        {state.evidence?.generatedArtifactRef?.sha256 ?? "none"}
      </div>
      <div data-testid="evidence-export-sha">
        {state.evidence?.exportRef?.sha256 ?? "none"}
      </div>
      <div data-testid="trust-summary-state">
        {state.summary?.trustSummary?.trustState ?? "none"}
      </div>
      <div data-testid="intentional-decision-status">
        {intentionalDivergenceDecisionStatus}
      </div>
      <div data-testid="intentional-decision-error">
        {intentionalDivergenceDecisionError ?? "none"}
      </div>
      <div data-testid="intentional-decision-ref">
        {intentionalDivergenceDecision?.decision.decisionRef.sha256 ?? "none"}
      </div>
      <div data-testid="events-count">{state.events?.events.length ?? 0}</div>
      <div data-testid="previous-run-id">
        {state.previousRun?.runId ?? "none"}
      </div>
      <div data-testid="previous-generated-sha">
        {state.previousRun?.generated?.artifactRef?.sha256 ?? "none"}
      </div>
      <div data-testid="previous-evidence-sha">
        {state.previousRun?.evidence?.generatedArtifactRef?.sha256 ?? "none"}
      </div>
      <div data-testid="experience-summary">
        {state.experience?.summary ?? "none"}
      </div>
      <div data-testid="model-gateway-status">
        {state.modelGatewayHealth?.status ?? "none"}
      </div>
      <div data-testid="harness-status">
        {state.harnessReady?.status ?? "none"}
      </div>
      <div data-testid="error">{state.error ?? "none"}</div>
      <button
        onClick={() =>
          void startTransform({
            sourceText: "       IDENTIFICATION DIVISION.",
            programId: "P-A",
            sourceName: "a.cbl",
          })
        }
      >
        start-a
      </button>
      <button
        onClick={() =>
          void startTransform({
            sourceText: "       IDENTIFICATION DIVISION.",
            programId: "P-B",
            sourceName: "b.cbl",
          })
        }
      >
        start-b
      </button>
      <button
        onClick={() =>
          void startTransform({
            sourceText: "       IDENTIFICATION DIVISION.",
            programId: "P-C",
            sourceName: "c.cbl",
          })
        }
      >
        start-c
      </button>
      <button onClick={() => void exportParityEvidenceScaffold()}>
        export
      </button>
      <button
        onClick={() =>
          void submitIntentionalDivergenceDecision({
            decisionId: null,
            rationale: {
              summary:
                "The Java intentionally diverges for a governed business-rule exception.",
              technicalBasis:
                "COBOL packed-decimal rounding is preserved instead of Java half-up rounding.",
              businessImpact:
                "Statement balances stay aligned with the legacy ledger of record.",
            },
            linkedEvidenceRefs: ["pack-123"],
            affectedOutputs: ["src/main/java/com/demo/LoanProcessor.java"],
            supersedesPreviousDecision: true,
            invalidationNote: "Supersedes prior review.",
            expiresAt: "2026-05-21T13:00:00.000Z",
          })
        }
      >
        mark-divergent
      </button>
    </div>
  );
}

describe("transformation run state machine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiClient.getRun).mockResolvedValue(
      okResult<RunSummary>(makeRunSummary({ status: "updating" })),
    );
    vi.mocked(apiClient.getRunProgress).mockImplementation((runId: string) =>
      Promise.resolve(makeProgressFixture(runId, "P-A")),
    );
  });

  it("hydrates summary and artifacts for a completed terminal start response", async () => {
    const runId = "run-completed";
    const fixtures = makeArtifactFixtures(runId, "P-A", "a".repeat(64));

    vi.mocked(apiClient.transform).mockResolvedValueOnce(
      makeTerminalResponse(runId, "P-A", "completed"),
    );
    vi.mocked(apiClient.getGenerated).mockResolvedValueOnce(fixtures.generated);
    vi.mocked(apiClient.getGeneratedFiles).mockResolvedValueOnce(
      fixtures.generatedFiles,
    );
    vi.mocked(apiClient.getBuildTest).mockResolvedValueOnce(fixtures.buildTest);
    vi.mocked(apiClient.getEvidence).mockResolvedValueOnce(fixtures.evidence);
    vi.mocked(apiClient.getRunEvents).mockResolvedValueOnce(fixtures.events);
    vi.mocked(apiClient.getRunArtifacts).mockResolvedValueOnce(
      fixtures.artifacts,
    );
    vi.mocked(apiClient.getRunExperience).mockResolvedValueOnce(
      makeExperienceResult(runId, "P-A"),
    );
    vi.mocked(apiClient.getModelGatewayHealth).mockResolvedValueOnce(
      okResult<ModelGatewayHealth>({ status: "ok" }),
    );
    vi.mocked(apiClient.getHarnessReady).mockResolvedValueOnce(
      okResult<HarnessReady>({ status: "ok" }),
    );

    vi.mocked(apiClient.getRunExperience).mockImplementation((runId: string) =>
      Promise.resolve(makeExperienceResult(runId, "P-A")),
    );
    vi.mocked(apiClient.getModelGatewayHealth).mockImplementation(() =>
      Promise.resolve(okResult<ModelGatewayHealth>({ status: "ok" })),
    );
    vi.mocked(apiClient.getHarnessReady).mockImplementation(() =>
      Promise.resolve(okResult<HarnessReady>({ status: "ok" })),
    );

    render(
      <TransformationRunProvider>
        <RunHarness />
      </TransformationRunProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByText("start-a"));
    });

    await waitFor(() =>
      expect(screen.getByTestId("phase")).toHaveTextContent("completed"),
    );
    expect(screen.getByTestId("summary-status")).toHaveTextContent("completed");
    expect(screen.getByTestId("generated-status")).toHaveTextContent(
      "generated",
    );
    expect(screen.getByTestId("artifacts-count")).toHaveTextContent("1");
  });

  it("hydrates artifacts for a failed terminal start response without promoting it to completed", async () => {
    const runId = "run-failed";
    const fixtures = makeArtifactFixtures(runId, "P-A", "b".repeat(64));

    vi.mocked(apiClient.transform).mockResolvedValueOnce(
      makeTerminalResponse(runId, "P-A", "failed"),
    );
    vi.mocked(apiClient.getGenerated).mockResolvedValueOnce(fixtures.generated);
    vi.mocked(apiClient.getGeneratedFiles).mockResolvedValueOnce(
      fixtures.generatedFiles,
    );
    vi.mocked(apiClient.getBuildTest).mockResolvedValueOnce(fixtures.buildTest);
    vi.mocked(apiClient.getEvidence).mockResolvedValueOnce(fixtures.evidence);
    vi.mocked(apiClient.getRunEvents).mockResolvedValueOnce(fixtures.events);
    vi.mocked(apiClient.getRunArtifacts).mockResolvedValueOnce(
      fixtures.artifacts,
    );
    vi.mocked(apiClient.getRunExperience).mockResolvedValueOnce(
      makeExperienceResult(runId, "P-A"),
    );
    vi.mocked(apiClient.getModelGatewayHealth).mockResolvedValueOnce(
      okResult<ModelGatewayHealth>({ status: "ok" }),
    );
    vi.mocked(apiClient.getHarnessReady).mockResolvedValueOnce(
      okResult<HarnessReady>({ status: "ok" }),
    );

    vi.mocked(apiClient.getRunExperience).mockImplementation((runId: string) =>
      Promise.resolve(makeExperienceResult(runId, "P-A")),
    );
    vi.mocked(apiClient.getModelGatewayHealth).mockImplementation(() =>
      Promise.resolve(okResult<ModelGatewayHealth>({ status: "ok" })),
    );
    vi.mocked(apiClient.getHarnessReady).mockImplementation(() =>
      Promise.resolve(okResult<HarnessReady>({ status: "ok" })),
    );

    render(
      <TransformationRunProvider>
        <RunHarness />
      </TransformationRunProvider>,
    );

    fireEvent.click(screen.getByText("start-a"));

    await waitFor(() =>
      expect(screen.getByTestId("phase")).toHaveTextContent("failed"),
    );
    expect(screen.getByTestId("summary-status")).toHaveTextContent("failed");
    expect(screen.getByTestId("generated-status")).toHaveTextContent(
      "generated",
    );
    expect(screen.getByTestId("artifacts-count")).toHaveTextContent("1");
  });

  it("updates the in-memory evidence export ref after a successful parity export", async () => {
    const runId = "run-export";
    const fixtures = makeArtifactFixtures(runId, "P-A", "c".repeat(64));

    vi.mocked(apiClient.transform).mockResolvedValueOnce(
      makeTerminalResponse(runId, "P-A", "completed"),
    );
    vi.mocked(apiClient.getGenerated).mockResolvedValueOnce(fixtures.generated);
    vi.mocked(apiClient.getGeneratedFiles).mockResolvedValueOnce(
      fixtures.generatedFiles,
    );
    vi.mocked(apiClient.getBuildTest).mockResolvedValueOnce(fixtures.buildTest);
    vi.mocked(apiClient.getEvidence).mockResolvedValueOnce(fixtures.evidence);
    vi.mocked(apiClient.getRunEvents).mockResolvedValueOnce(fixtures.events);
    vi.mocked(apiClient.getRunArtifacts).mockResolvedValueOnce(
      fixtures.artifacts,
    );
    vi.mocked(apiClient.getRunExperience).mockResolvedValueOnce(
      makeExperienceResult(runId, "P-A"),
    );
    vi.mocked(apiClient.getRunExperience).mockImplementation(
      (currentRunId: string) =>
        Promise.resolve(makeExperienceResult(currentRunId, "P-A")),
    );
    vi.mocked(apiClient.getModelGatewayHealth).mockImplementation(() =>
      Promise.resolve(okResult<ModelGatewayHealth>({ status: "ok" })),
    );
    vi.mocked(apiClient.getHarnessReady).mockImplementation(() =>
      Promise.resolve(okResult<HarnessReady>({ status: "ok" })),
    );
    vi.mocked(apiClient.exportParityEvidenceScaffold).mockResolvedValueOnce(
      okResult({
        runId,
        programId: "P-A",
        status: "created",
        export: {
          exportId: "export-1",
          projectRoot: "runs/run-export/exports/java-regression/case01",
          scaffoldTestPath:
            "runs/run-export/exports/java-regression/case01/src/test/java/com/demo/CASE01ParityRegressionTest.java",
          scaffoldRef: {
            sha256: "9".repeat(64),
            path: "runs/run-export/exports/java-regression/case01/src/test/java/com/demo/CASE01ParityRegressionTest.java",
          },
          projectManifestRef: null,
          manifestRef: null,
          expectedOutputRef: null,
          createdAt: "2026-05-21T13:00:00.000Z",
          qualification: "clean" as const,
        },
      }),
    );

    render(
      <TransformationRunProvider>
        <RunHarness />
      </TransformationRunProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByText("start-a"));
    });

    await waitFor(() =>
      expect(screen.getByTestId("phase")).toHaveTextContent("completed"),
    );

    await act(async () => {
      fireEvent.click(screen.getByText("export"));
    });

    await waitFor(() =>
      expect(apiClient.exportParityEvidenceScaffold).toHaveBeenCalledWith(
        runId,
        {},
      ),
    );
    expect(screen.getByTestId("evidence-export-sha")).toHaveTextContent(
      "9".repeat(64),
    );
  });

  it("submits an intentional divergence decision and updates the live trust summary", async () => {
    const runId = "run-divergence-decision";
    const fixtures = makeArtifactFixtures(runId, "P-A", "d".repeat(64));

    vi.mocked(apiClient.transform).mockResolvedValueOnce(
      makeTerminalResponse(runId, "P-A", "completed"),
    );
    vi.mocked(apiClient.getGenerated).mockResolvedValueOnce(fixtures.generated);
    vi.mocked(apiClient.getGeneratedFiles).mockResolvedValueOnce(
      fixtures.generatedFiles,
    );
    vi.mocked(apiClient.getBuildTest).mockResolvedValueOnce(
      okResult<BuildTestView>({
        ...fixtures.buildTest.data,
        classification: "divergence-unknown",
        status: "output-divergence",
      }),
    );
    vi.mocked(apiClient.getEvidence).mockResolvedValueOnce(fixtures.evidence);
    vi.mocked(apiClient.getRunEvents).mockResolvedValueOnce(fixtures.events);
    vi.mocked(apiClient.getRunArtifacts).mockResolvedValueOnce(
      fixtures.artifacts,
    );
    vi.mocked(apiClient.getRunExperience).mockResolvedValueOnce(
      makeExperienceResult(runId, "P-A"),
    );
    vi.mocked(apiClient.getRunExperience).mockImplementation(
      (currentRunId: string) =>
        Promise.resolve(makeExperienceResult(currentRunId, "P-A")),
    );
    vi.mocked(apiClient.getModelGatewayHealth).mockImplementation(() =>
      Promise.resolve(okResult<ModelGatewayHealth>({ status: "ok" })),
    );
    vi.mocked(apiClient.getHarnessReady).mockImplementation(() =>
      Promise.resolve(okResult<HarnessReady>({ status: "ok" })),
    );
    vi.mocked(
      apiClient.upsertIntentionalDivergenceDecision,
    ).mockResolvedValueOnce(
      okResult({
        runId,
        programId: "P-A",
        status: "created" as const,
        decision: {
          decisionId: "decision-1",
          decisionRef: {
            sha256: "f".repeat(64),
            byteSize: 11,
            kind: "intentional-divergence-decision",
          },
          runId,
          programId: "P-A",
          reviewer: "studio:tenant-a:user-a",
          rationale:
            "The Java intentionally diverges for a governed business-rule exception.",
          linkedEvidenceRefs: ["pack-123"],
          affectedOutputs: ["src/main/java/com/demo/LoanProcessor.java"],
          supersedesPreviousDecision: true,
          invalidationNote: "Supersedes prior review.",
          expiresAt: "2026-05-21T13:00:00.000Z",
          invalidatedAt: null,
          createdAt: "2026-05-21T12:00:00.000Z",
          updatedAt: "2026-05-21T12:10:00.000Z",
        },
        trustSummary: {
          schemaVersion: "v0",
          trustState: "intentional_divergence",
          repairStatus: "repair_verified",
          coverageStatus: "full",
          divergenceDisposition: "intentional",
          intentionalDivergenceDecisionRef: {
            sha256: "f".repeat(64),
            byteSize: 11,
            kind: "intentional-divergence-decision",
          },
          warningCodes: [],
          trustCase: {
            trustCaseId: "TC-A",
            version: "v1",
            catalogVersion: "2026.05",
            catalogHash: "c".repeat(64),
            configurationDigest: "cfg",
          },
          cobolResult: { status: "completed" },
          javaResult: { status: "completed" },
          comparisonResult: {
            status: "mismatched",
            mismatchClassification: "intentional-divergence",
            decisionRecordRef: null,
          },
          repair: { status: "repair_verified" },
          evidence: { status: "current" },
          summaryDerivedAt: "2026-05-21T12:10:00.000Z",
        },
      }),
    );

    render(
      <TransformationRunProvider>
        <RunHarness />
      </TransformationRunProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByText("start-a"));
    });

    await waitFor(() =>
      expect(screen.getByTestId("phase")).toHaveTextContent("completed"),
    );
    expect(screen.getByTestId("trust-summary-state")).toHaveTextContent("none");

    await act(async () => {
      fireEvent.click(screen.getByText("mark-divergent"));
    });

    await waitFor(() =>
      expect(
        apiClient.upsertIntentionalDivergenceDecision,
      ).toHaveBeenCalledWith(
        runId,
        expect.objectContaining({
          rationale: expect.objectContaining({
            summary:
              "The Java intentionally diverges for a governed business-rule exception.",
          }),
          supersedesPreviousDecision: true,
        }),
      ),
    );
    expect(screen.getByTestId("intentional-decision-ref")).toHaveTextContent(
      "f".repeat(64),
    );
    expect(screen.getByTestId("trust-summary-state")).toHaveTextContent(
      "intentional_divergence",
    );
  });

  it("keeps a completed run incomplete when required artifact views are missing", async () => {
    const runId = "run-incomplete";
    const generatedFilesError: ApiResult<GeneratedFilesIndex> = {
      ok: false,
      status: 404,
      message: "missing generated files",
    };

    vi.mocked(apiClient.transform).mockResolvedValueOnce(
      makeTerminalResponse(runId, "P-A", "completed"),
    );
    vi.mocked(apiClient.getGenerated).mockResolvedValueOnce(
      makeArtifactFixtures(runId, "P-A", "c".repeat(64)).generated,
    );
    vi.mocked(apiClient.getGeneratedFiles).mockResolvedValueOnce(
      generatedFilesError,
    );
    vi.mocked(apiClient.getBuildTest).mockResolvedValueOnce(
      makeArtifactFixtures(runId, "P-A", "c".repeat(64)).buildTest,
    );
    vi.mocked(apiClient.getEvidence).mockResolvedValueOnce(
      makeArtifactFixtures(runId, "P-A", "c".repeat(64)).evidence,
    );
    vi.mocked(apiClient.getRunEvents).mockResolvedValueOnce(
      makeArtifactFixtures(runId, "P-A", "c".repeat(64)).events,
    );
    vi.mocked(apiClient.getRunArtifacts).mockResolvedValueOnce(
      makeArtifactFixtures(runId, "P-A", "c".repeat(64)).artifacts,
    );
    vi.mocked(apiClient.getRunExperience).mockResolvedValueOnce(
      makeExperienceResult(runId, "P-A"),
    );
    vi.mocked(apiClient.getModelGatewayHealth).mockResolvedValueOnce(
      okResult<ModelGatewayHealth>({ status: "ok" }),
    );
    vi.mocked(apiClient.getHarnessReady).mockResolvedValueOnce(
      okResult<HarnessReady>({ status: "ok" }),
    );

    vi.mocked(apiClient.getRunExperience).mockImplementation((runId: string) =>
      Promise.resolve(makeExperienceResult(runId, "P-A")),
    );
    vi.mocked(apiClient.getModelGatewayHealth).mockImplementation(() =>
      Promise.resolve(okResult<ModelGatewayHealth>({ status: "ok" })),
    );
    vi.mocked(apiClient.getHarnessReady).mockImplementation(() =>
      Promise.resolve(okResult<HarnessReady>({ status: "ok" })),
    );

    render(
      <TransformationRunProvider>
        <RunHarness />
      </TransformationRunProvider>,
    );

    fireEvent.click(screen.getByText("start-a"));

    await waitFor(() =>
      expect(screen.getByTestId("phase")).toHaveTextContent("incomplete"),
    );
    expect(screen.getByTestId("summary-status")).toHaveTextContent("completed");
    expect(screen.getByTestId("generated-files-status")).toHaveTextContent(
      "none",
    );
  });

  it("finishes polling at phase=completed when terminal artifact statuses diverge; verdict comes from derivation", async () => {
    const runId = "run-divergence";
    const fixtures = makeArtifactFixtures(runId, "P-A", "e".repeat(64));

    vi.mocked(apiClient.transform).mockResolvedValueOnce(
      makeTerminalResponse(runId, "P-A", "completed"),
    );
    vi.mocked(apiClient.getGenerated).mockResolvedValueOnce(fixtures.generated);
    vi.mocked(apiClient.getGeneratedFiles).mockResolvedValueOnce(
      fixtures.generatedFiles,
    );
    // Narrow `ApiResult<BuildTestView>` to the success branch — the fixture
    // builder always returns `okResult(...)` so this branch is always taken
    // at runtime, but the typechecker cannot infer that on its own.
    if (!fixtures.buildTest.ok) {
      throw new Error(
        "fixture invariant: buildTest must be a successful ApiResult",
      );
    }
    vi.mocked(apiClient.getBuildTest).mockResolvedValueOnce(
      okResult<BuildTestView>({
        ...fixtures.buildTest.data,
        status: "output-divergence",
      }),
    );
    vi.mocked(apiClient.getEvidence).mockResolvedValueOnce(fixtures.evidence);
    vi.mocked(apiClient.getRunEvents).mockResolvedValueOnce(fixtures.events);
    vi.mocked(apiClient.getRunArtifacts).mockResolvedValueOnce(
      fixtures.artifacts,
    );
    vi.mocked(apiClient.getRunExperience).mockResolvedValueOnce(
      makeExperienceResult(runId, "P-A"),
    );
    vi.mocked(apiClient.getModelGatewayHealth).mockResolvedValueOnce(
      okResult<ModelGatewayHealth>({ status: "ok" }),
    );
    vi.mocked(apiClient.getHarnessReady).mockResolvedValueOnce(
      okResult<HarnessReady>({ status: "ok" }),
    );

    vi.mocked(apiClient.getRunExperience).mockImplementation((runId: string) =>
      Promise.resolve(makeExperienceResult(runId, "P-A")),
    );
    vi.mocked(apiClient.getModelGatewayHealth).mockImplementation(() =>
      Promise.resolve(okResult<ModelGatewayHealth>({ status: "ok" })),
    );
    vi.mocked(apiClient.getHarnessReady).mockImplementation(() =>
      Promise.resolve(okResult<HarnessReady>({ status: "ok" })),
    );

    render(
      <TransformationRunProvider>
        <RunHarness />
      </TransformationRunProvider>,
    );

    fireEvent.click(screen.getByText("start-a"));

    await waitFor(() =>
      expect(screen.getByTestId("phase")).toHaveTextContent("completed"),
    );
    expect(screen.getByTestId("build-test-status")).toHaveTextContent(
      "output-divergence",
    );
  });

  it("retains the previous run snapshot when a rerun completes with new artifact identities", async () => {
    const firstRunId = "run-first";
    const secondRunId = "run-second";
    const firstSha = "1".repeat(64);
    const secondSha = "2".repeat(64);
    const firstFixtures = makeArtifactFixtures(firstRunId, "P-A", firstSha);
    const secondFixtures = makeArtifactFixtures(secondRunId, "P-B", secondSha);

    vi.mocked(apiClient.transform)
      .mockResolvedValueOnce(
        makeTerminalResponse(firstRunId, "P-A", "completed"),
      )
      .mockResolvedValueOnce(
        makeTerminalResponse(secondRunId, "P-B", "completed"),
      );
    vi.mocked(apiClient.getGenerated)
      .mockResolvedValueOnce(firstFixtures.generated)
      .mockResolvedValueOnce(secondFixtures.generated);
    vi.mocked(apiClient.getGeneratedFiles)
      .mockResolvedValueOnce(firstFixtures.generatedFiles)
      .mockResolvedValueOnce(secondFixtures.generatedFiles);
    vi.mocked(apiClient.getBuildTest)
      .mockResolvedValueOnce(firstFixtures.buildTest)
      .mockResolvedValueOnce(secondFixtures.buildTest);
    vi.mocked(apiClient.getEvidence)
      .mockResolvedValueOnce(firstFixtures.evidence)
      .mockResolvedValueOnce(secondFixtures.evidence);
    vi.mocked(apiClient.getRunEvents)
      .mockResolvedValueOnce(firstFixtures.events)
      .mockResolvedValueOnce(secondFixtures.events);
    vi.mocked(apiClient.getRunArtifacts)
      .mockResolvedValueOnce(firstFixtures.artifacts)
      .mockResolvedValueOnce(secondFixtures.artifacts);
    vi.mocked(apiClient.getRunExperience)
      .mockResolvedValueOnce(makeExperienceResult(firstRunId, "P-A"))
      .mockResolvedValueOnce(makeExperienceResult(secondRunId, "P-B"));
    vi.mocked(apiClient.getModelGatewayHealth).mockImplementation(() =>
      Promise.resolve(okResult<ModelGatewayHealth>({ status: "ok" })),
    );
    vi.mocked(apiClient.getHarnessReady).mockImplementation(() =>
      Promise.resolve(okResult<HarnessReady>({ status: "ok" })),
    );

    render(
      <TransformationRunProvider>
        <RunHarness />
      </TransformationRunProvider>,
    );

    fireEvent.click(screen.getByText("start-a"));
    await waitFor(() =>
      expect(screen.getByTestId("run-id")).toHaveTextContent(firstRunId),
    );
    expect(screen.getByTestId("generated-sha")).toHaveTextContent(firstSha);
    expect(screen.getByTestId("previous-run-id")).toHaveTextContent("none");

    fireEvent.click(screen.getByText("start-b"));
    await waitFor(() =>
      expect(screen.getByTestId("run-id")).toHaveTextContent(secondRunId),
    );

    expect(screen.getByTestId("generated-sha")).toHaveTextContent(secondSha);
    expect(screen.getByTestId("evidence-sha")).toHaveTextContent(secondSha);
    expect(screen.getByTestId("previous-run-id")).toHaveTextContent(firstRunId);
    expect(screen.getByTestId("previous-generated-sha")).toHaveTextContent(
      firstSha,
    );
    expect(screen.getByTestId("previous-evidence-sha")).toHaveTextContent(
      firstSha,
    );
  });

  it("keeps the previous run snapshot accessible when the latest rerun fails", async () => {
    const firstRunId = "run-stable";
    const failedRunId = "run-rerun-failed";
    const firstSha = "3".repeat(64);
    const firstFixtures = makeArtifactFixtures(firstRunId, "P-A", firstSha);
    const failedGenerated: ApiResult<GeneratedView> = {
      ok: false,
      status: 404,
      message: "missing generated output",
    };
    const failedFiles: ApiResult<GeneratedFilesIndex> = {
      ok: false,
      status: 404,
      message: "missing generated files",
    };
    const failedBuild: ApiResult<BuildTestView> = {
      ok: false,
      status: 404,
      message: "missing build/test output",
    };
    const failedEvidence: ApiResult<EvidenceView> = {
      ok: false,
      status: 404,
      message: "missing evidence output",
    };

    vi.mocked(apiClient.transform)
      .mockResolvedValueOnce(
        makeTerminalResponse(firstRunId, "P-A", "completed"),
      )
      .mockResolvedValueOnce(
        makeTerminalResponse(failedRunId, "P-B", "failed"),
      );
    vi.mocked(apiClient.getGenerated)
      .mockResolvedValueOnce(firstFixtures.generated)
      .mockResolvedValueOnce(failedGenerated);
    vi.mocked(apiClient.getGeneratedFiles)
      .mockResolvedValueOnce(firstFixtures.generatedFiles)
      .mockResolvedValueOnce(failedFiles);
    vi.mocked(apiClient.getBuildTest)
      .mockResolvedValueOnce(firstFixtures.buildTest)
      .mockResolvedValueOnce(failedBuild);
    vi.mocked(apiClient.getEvidence)
      .mockResolvedValueOnce(firstFixtures.evidence)
      .mockResolvedValueOnce(failedEvidence);
    vi.mocked(apiClient.getRunEvents)
      .mockResolvedValueOnce(firstFixtures.events)
      .mockResolvedValueOnce(
        okResult<RunEventsView>({
          runId: failedRunId,
          programId: "P-B",
          mode: "live",
          productMode: "live",
          events: [],
        }),
      );
    vi.mocked(apiClient.getRunArtifacts)
      .mockResolvedValueOnce(firstFixtures.artifacts)
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        message: "missing artifacts",
      });
    vi.mocked(apiClient.getRunExperience)
      .mockResolvedValueOnce(makeExperienceResult(firstRunId, "P-A"))
      .mockResolvedValueOnce(makeExperienceResult(failedRunId, "P-B"));
    vi.mocked(apiClient.getModelGatewayHealth).mockImplementation(() =>
      Promise.resolve(okResult<ModelGatewayHealth>({ status: "ok" })),
    );
    vi.mocked(apiClient.getHarnessReady).mockImplementation(() =>
      Promise.resolve(okResult<HarnessReady>({ status: "ok" })),
    );

    render(
      <TransformationRunProvider>
        <RunHarness />
      </TransformationRunProvider>,
    );

    fireEvent.click(screen.getByText("start-a"));
    await waitFor(() =>
      expect(screen.getByTestId("run-id")).toHaveTextContent(firstRunId),
    );

    fireEvent.click(screen.getByText("start-b"));
    await waitFor(() =>
      expect(screen.getByTestId("phase")).toHaveTextContent("failed"),
    );

    expect(screen.getByTestId("run-id")).toHaveTextContent(failedRunId);
    expect(screen.getByTestId("generated-sha")).toHaveTextContent("none");
    expect(screen.getByTestId("evidence-sha")).toHaveTextContent("none");
    expect(screen.getByTestId("previous-run-id")).toHaveTextContent(firstRunId);
    expect(screen.getByTestId("previous-generated-sha")).toHaveTextContent(
      firstSha,
    );
    expect(screen.getByTestId("previous-evidence-sha")).toHaveTextContent(
      firstSha,
    );
  });

  it("marks a polling run unavailable on backend 503 responses", async () => {
    vi.mocked(apiClient.transform).mockResolvedValueOnce(
      okResult<TransformResponse>({
        runId: "run-unavailable",
        orchestratorRunId: "run-unavailable-orch",
        programId: "P-A",
        status: "starting",
        mode: "live",
        productMode: "live",
        createdAt: "2026-05-15T10:00:00Z",
        updatedAt: "2026-05-15T10:00:01Z",
        activeStep: null,
        agentAttemptCount: 0,
        repairBudget: null,
        finalClassification: null,
        failureCode: null,
        failureMessage: null,
        links: {
          self: "/runs/run-unavailable",
          generated: "/runs/run-unavailable/generated",
          generatedFiles: "/runs/run-unavailable/generated/files",
          buildTest: "/runs/run-unavailable/build-test",
          evidence: "/runs/run-unavailable/evidence",
          events: "/runs/run-unavailable/events",
          artifacts: "/runs/run-unavailable/artifacts",
        },
      }),
    );
    const runUnavailableError: ApiResult<RunSummary> = {
      ok: false,
      status: 503,
      message: "orchestrator unavailable",
      details: { kind: "http", body: { error: "orchestrator unavailable" } },
    };
    vi.mocked(apiClient.getRun).mockResolvedValueOnce(runUnavailableError);

    vi.mocked(apiClient.getRunExperience).mockImplementation((runId: string) =>
      Promise.resolve(makeExperienceResult(runId, "P-A")),
    );
    vi.mocked(apiClient.getModelGatewayHealth).mockImplementation(() =>
      Promise.resolve(okResult<ModelGatewayHealth>({ status: "ok" })),
    );
    vi.mocked(apiClient.getHarnessReady).mockImplementation(() =>
      Promise.resolve(okResult<HarnessReady>({ status: "ok" })),
    );

    render(
      <TransformationRunProvider>
        <RunHarness />
      </TransformationRunProvider>,
    );

    fireEvent.click(screen.getByText("start-a"));

    await waitFor(() =>
      expect(screen.getByTestId("phase")).toHaveTextContent("unavailable"),
    );
    expect(screen.getByTestId("error")).toHaveTextContent(
      "Backend unavailable",
    );
  });

  it("hydrates live observability while a run is still active and preserves global service state on restart", async () => {
    vi.mocked(apiClient.getModelGatewayHealth).mockResolvedValue(
      okResult<ModelGatewayHealth>({ status: "ok" }),
    );
    vi.mocked(apiClient.getHarnessReady).mockResolvedValue(
      okResult<HarnessReady>({ status: "ok" }),
    );
    vi.mocked(apiClient.transform)
      .mockResolvedValueOnce(
        okResult<TransformResponse>({
          runId: "run-live-a",
          orchestratorRunId: "run-live-a-orch",
          programId: "P-A",
          status: "starting",
          mode: "live",
          productMode: "live",
          createdAt: "2026-05-15T10:00:00Z",
          updatedAt: "2026-05-15T10:00:01Z",
          activeStep: null,
          agentAttemptCount: 0,
          repairBudget: null,
          finalClassification: null,
          failureCode: null,
          failureMessage: null,
          links: {
            self: "/runs/run-live-a",
            generated: "/runs/run-live-a/generated",
            generatedFiles: "/runs/run-live-a/generated/files",
            buildTest: "/runs/run-live-a/build-test",
            evidence: "/runs/run-live-a/evidence",
            events: "/runs/run-live-a/events",
            artifacts: "/runs/run-live-a/artifacts",
          },
        }),
      )
      .mockResolvedValueOnce(
        okResult<TransformResponse>({
          runId: "run-live-b",
          orchestratorRunId: "run-live-b-orch",
          programId: "P-B",
          status: "starting",
          mode: "live",
          productMode: "live",
          createdAt: "2026-05-15T10:00:02Z",
          updatedAt: "2026-05-15T10:00:03Z",
          activeStep: null,
          agentAttemptCount: 0,
          repairBudget: null,
          finalClassification: null,
          failureCode: null,
          failureMessage: null,
          links: {
            self: "/runs/run-live-b",
            generated: "/runs/run-live-b/generated",
            generatedFiles: "/runs/run-live-b/generated/files",
            buildTest: "/runs/run-live-b/build-test",
            evidence: "/runs/run-live-b/evidence",
            events: "/runs/run-live-b/events",
            artifacts: "/runs/run-live-b/artifacts",
          },
        }),
      );
    vi.mocked(apiClient.getRun).mockImplementation(async (runId: string) =>
      okResult<RunSummary>(
        makeRunSummary({
          status: "updating",
          runId,
          programId: runId === "run-live-a" ? "P-A" : "P-B",
        }),
      ),
    );
    vi.mocked(apiClient.getRunEvents).mockImplementation(
      async (runId: string) =>
        okResult<RunEventsView>({
          runId,
          programId: runId === "run-live-a" ? "P-A" : "P-B",
          mode: "live",
          productMode: "live",
          events: [
            {
              type: "run.accepted",
              status: "ok",
              message: "accepted",
              createdAt: "2026-05-15T10:00:04Z",
            },
          ],
        }),
    );
    vi.mocked(apiClient.getRunProgress).mockImplementation(
      async (runId: string) =>
        makeProgressFixture(runId, runId === "run-live-a" ? "P-A" : "P-B"),
    );
    vi.mocked(apiClient.getRunExperience).mockImplementation(
      async (runId: string) =>
        okResult<RunExperienceView>({
          runId,
          programId: runId === "run-live-a" ? "P-A" : "P-B",
          mode: "live",
          productMode: "live",
          summary: "1 learning candidate observed",
        }),
    );

    render(
      <TransformationRunProvider>
        <RunHarness />
      </TransformationRunProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("model-gateway-status")).toHaveTextContent(
        "ok",
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("harness-status")).toHaveTextContent("ok"),
    );

    fireEvent.click(screen.getByText("start-a"));

    await waitFor(() =>
      expect(screen.getByTestId("events-count")).toHaveTextContent("1"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("progress-count")).toHaveTextContent("3"),
    );
    expect(screen.getByTestId("experience-summary")).toHaveTextContent(
      "1 learning candidate observed",
    );

    await act(async () => {
      fireEvent.click(screen.getByText("start-b"));
    });

    expect(screen.getByTestId("model-gateway-status")).toHaveTextContent("ok");
    expect(screen.getByTestId("harness-status")).toHaveTextContent("ok");
  });

  it("ignores stale artifact hydration from an earlier run after a newer run starts", async () => {
    const aArtifacts = {
      generated: deferred<ApiResult<GeneratedView>>(),
      generatedFiles: deferred<ApiResult<GeneratedFilesIndex>>(),
      buildTest: deferred<ApiResult<BuildTestView>>(),
      evidence: deferred<ApiResult<EvidenceView>>(),
      events: deferred<ApiResult<RunEventsView>>(),
      artifacts: deferred<ApiResult<RunArtifactsView>>(),
    };

    vi.mocked(apiClient.transform).mockImplementation(async (request) => {
      if (request.programId === "P-A") {
        return makeTerminalResponse("run-a", "P-A", "completed");
      }

      return makeTerminalResponse("run-b", "P-B", "completed");
    });

    vi.mocked(apiClient.getGenerated).mockImplementation((runId) =>
      runId === "run-a"
        ? aArtifacts.generated.promise
        : Promise.resolve(
            makeArtifactFixtures("run-b", "P-B", "d".repeat(64)).generated,
          ),
    );
    vi.mocked(apiClient.getGeneratedFiles).mockImplementation((runId) =>
      runId === "run-a"
        ? aArtifacts.generatedFiles.promise
        : Promise.resolve(
            makeArtifactFixtures("run-b", "P-B", "d".repeat(64)).generatedFiles,
          ),
    );
    vi.mocked(apiClient.getBuildTest).mockImplementation((runId) =>
      runId === "run-a"
        ? aArtifacts.buildTest.promise
        : Promise.resolve(
            makeArtifactFixtures("run-b", "P-B", "d".repeat(64)).buildTest,
          ),
    );
    vi.mocked(apiClient.getEvidence).mockImplementation((runId) =>
      runId === "run-a"
        ? aArtifacts.evidence.promise
        : Promise.resolve(
            makeArtifactFixtures("run-b", "P-B", "d".repeat(64)).evidence,
          ),
    );
    vi.mocked(apiClient.getRunEvents).mockImplementation((runId) =>
      runId === "run-a"
        ? aArtifacts.events.promise
        : Promise.resolve(
            makeArtifactFixtures("run-b", "P-B", "d".repeat(64)).events,
          ),
    );
    vi.mocked(apiClient.getRunArtifacts).mockImplementation((runId) =>
      runId === "run-a"
        ? aArtifacts.artifacts.promise
        : Promise.resolve(
            makeArtifactFixtures("run-b", "P-B", "d".repeat(64)).artifacts,
          ),
    );

    vi.mocked(apiClient.getRunExperience).mockImplementation((runId: string) =>
      Promise.resolve(makeExperienceResult(runId, "P-A")),
    );
    vi.mocked(apiClient.getModelGatewayHealth).mockImplementation(() =>
      Promise.resolve(okResult<ModelGatewayHealth>({ status: "ok" })),
    );
    vi.mocked(apiClient.getHarnessReady).mockImplementation(() =>
      Promise.resolve(okResult<HarnessReady>({ status: "ok" })),
    );

    render(
      <TransformationRunProvider>
        <RunHarness />
      </TransformationRunProvider>,
    );

    fireEvent.click(screen.getByText("start-a"));
    fireEvent.click(screen.getByText("start-b"));

    await waitFor(() =>
      expect(screen.getByTestId("run-id")).toHaveTextContent("run-b"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("phase")).toHaveTextContent("completed"),
    );

    await act(async () => {
      aArtifacts.generated.resolve(
        makeArtifactFixtures("run-a", "P-A", "a".repeat(64)).generated,
      );
      aArtifacts.generatedFiles.resolve(
        makeArtifactFixtures("run-a", "P-A", "a".repeat(64)).generatedFiles,
      );
      aArtifacts.buildTest.resolve(
        makeArtifactFixtures("run-a", "P-A", "a".repeat(64)).buildTest,
      );
      aArtifacts.evidence.resolve(
        makeArtifactFixtures("run-a", "P-A", "a".repeat(64)).evidence,
      );
      aArtifacts.events.resolve(
        makeArtifactFixtures("run-a", "P-A", "a".repeat(64)).events,
      );
      aArtifacts.artifacts.resolve(
        makeArtifactFixtures("run-a", "P-A", "a".repeat(64)).artifacts,
      );
    });

    expect(screen.getByTestId("run-id")).toHaveTextContent("run-b");
    expect(screen.getByTestId("summary-status")).toHaveTextContent("completed");
  });

  it("keeps the prior artifact-bearing snapshot when a rerun starts during the next run's summary-only hydration window (#358)", async () => {
    const firstRunId = "run-a-artifact-bearing";
    const firstSha = "a".repeat(64);
    const firstFixtures = makeArtifactFixtures(firstRunId, "P-A", firstSha);

    // run-b's artifact hydration is deferred so we can start run-c while
    // run-b is summary-only (runId + summary set, every artifact view null).
    const bArtifacts = {
      generated: deferred<ApiResult<GeneratedView>>(),
      generatedFiles: deferred<ApiResult<GeneratedFilesIndex>>(),
      buildTest: deferred<ApiResult<BuildTestView>>(),
      evidence: deferred<ApiResult<EvidenceView>>(),
      events: deferred<ApiResult<RunEventsView>>(),
      artifacts: deferred<ApiResult<RunArtifactsView>>(),
    };

    vi.mocked(apiClient.transform).mockImplementation(async (request) => {
      if (request.programId === "P-A") {
        return makeTerminalResponse(firstRunId, "P-A", "completed");
      }
      if (request.programId === "P-B") {
        return makeTerminalResponse("run-b", "P-B", "completed");
      }
      return makeTerminalResponse("run-c", "P-C", "completed");
    });

    vi.mocked(apiClient.getGenerated).mockImplementation((runId) =>
      runId === firstRunId
        ? Promise.resolve(firstFixtures.generated)
        : bArtifacts.generated.promise,
    );
    vi.mocked(apiClient.getGeneratedFiles).mockImplementation((runId) =>
      runId === firstRunId
        ? Promise.resolve(firstFixtures.generatedFiles)
        : bArtifacts.generatedFiles.promise,
    );
    vi.mocked(apiClient.getBuildTest).mockImplementation((runId) =>
      runId === firstRunId
        ? Promise.resolve(firstFixtures.buildTest)
        : bArtifacts.buildTest.promise,
    );
    vi.mocked(apiClient.getEvidence).mockImplementation((runId) =>
      runId === firstRunId
        ? Promise.resolve(firstFixtures.evidence)
        : bArtifacts.evidence.promise,
    );
    vi.mocked(apiClient.getRunEvents).mockImplementation((runId) =>
      runId === firstRunId
        ? Promise.resolve(firstFixtures.events)
        : bArtifacts.events.promise,
    );
    vi.mocked(apiClient.getRunArtifacts).mockImplementation((runId) =>
      runId === firstRunId
        ? Promise.resolve(firstFixtures.artifacts)
        : bArtifacts.artifacts.promise,
    );
    vi.mocked(apiClient.getRunExperience).mockImplementation((runId: string) =>
      Promise.resolve(makeExperienceResult(runId, "P-A")),
    );
    vi.mocked(apiClient.getModelGatewayHealth).mockImplementation(() =>
      Promise.resolve(okResult<ModelGatewayHealth>({ status: "ok" })),
    );
    vi.mocked(apiClient.getHarnessReady).mockImplementation(() =>
      Promise.resolve(okResult<HarnessReady>({ status: "ok" })),
    );

    render(
      <TransformationRunProvider>
        <RunHarness />
      </TransformationRunProvider>,
    );

    // run-a hydrates fully and becomes the artifact-bearing baseline.
    fireEvent.click(screen.getByText("start-a"));
    await waitFor(() =>
      expect(screen.getByTestId("generated-sha")).toHaveTextContent(firstSha),
    );

    // run-b starts: snapshots the artifact-bearing run-a into previousRun.
    fireEvent.click(screen.getByText("start-b"));
    await waitFor(() =>
      expect(screen.getByTestId("run-id")).toHaveTextContent("run-b"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("summary-status")).toHaveTextContent(
        "completed",
      ),
    );
    expect(screen.getByTestId("previous-run-id")).toHaveTextContent(firstRunId);

    // run-b is now summary-only: runId + summary set, all artifact views null
    // because bArtifacts is still deferred.
    expect(screen.getByTestId("generated-sha")).toHaveTextContent("none");
    expect(screen.getByTestId("evidence-sha")).toHaveTextContent("none");

    // Start run-c inside that window. snapshotHistoricalRun must keep the
    // artifact-bearing run-a snapshot, not overwrite it with run-b's
    // useless summary-only state.
    await act(async () => {
      fireEvent.click(screen.getByText("start-c"));
    });

    expect(screen.getByTestId("previous-run-id")).toHaveTextContent(firstRunId);
    expect(screen.getByTestId("previous-generated-sha")).toHaveTextContent(
      firstSha,
    );
    expect(screen.getByTestId("previous-evidence-sha")).toHaveTextContent(
      firstSha,
    );
  });
});

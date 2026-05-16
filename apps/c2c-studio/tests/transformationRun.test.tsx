import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '@/lib/apiClient';
import { TransformationRunProvider, useTransformationRun } from '@/stores/transformationRun';
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
} from '@/types/api';
import { RunExperienceView, ModelGatewayHealth, HarnessReady } from '@/types/observability';

vi.mock('@/lib/apiClient', () => ({
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

function okResult<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });

  return { promise, resolve };
}

function makeTerminalResponse(runId: string, programId: string, status: 'completed' | 'failed'): ApiResult<TransformResponse> {
  return okResult<TransformResponse>({
    runId,
    orchestratorRunId: `${runId}-orch`,
    programId,
    status,
    mode: 'live',
    productMode: 'live',
    createdAt: '2026-05-15T10:00:00Z',
    updatedAt: '2026-05-15T10:00:01Z',
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

function makeProgressFixture(runId: string, programId: string): ApiResult<RunProgressView> {
  return okResult<RunProgressView>({
    runId,
    programId,
    mode: 'live',
    productMode: 'live',
    status: 'complete',
    runStatus: 'completed',
    currentStep: null,
    failedStep: null,
    completedSteps: ['accepted', 'parse-cobol', 'generate-ir', 'generate-java', 'compile-test-java', 'write-evidence', 'completed'],
    stepCount: 8,
    steps: [
      {
        stepId: 1,
        name: 'accepted',
        capabilityId: 'orchestrator-service',
        service: 'orchestrator-service',
        actor: 'orchestrator-service',
        status: 'ok',
      },
      {
        stepId: 2,
        name: 'parse-cobol',
        capabilityId: 'parse-cobol-service',
        service: 'orchestrator-service',
        actor: 'parse-cobol-service',
        status: 'ok',
        latencyMs: 12,
      },
      {
        stepId: 3,
        name: 'model-policy-skipped',
        capabilityId: 'orchestrator-service',
        service: 'orchestrator-service',
        actor: 'orchestrator-service',
        status: 'skipped',
        diagnostic: 'no modelPrompt provided by requester',
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
  eventStatus: 'completed' | 'failed' = 'completed'
): ArtifactFixtures {
  return {
    generated: okResult<GeneratedView>({
      runId,
      programId,
      mode: 'live',
      productMode: 'live',
      status: 'generated',
      artifactRef: { sha256 },
    }),
    generatedFiles: okResult<GeneratedFilesIndex>({
      runId,
      programId,
      mode: 'live',
      productMode: 'live',
      status: 'complete',
      files: [],
      fileCount: 0,
      artifactRef: { sha256 },
    }),
    buildTest: okResult<BuildTestView>({
      runId,
      programId,
      mode: 'live',
      productMode: 'live',
      status: 'ok',
      classification: 'match',
      generatedArtifactRef: { sha256 },
    }),
    evidence: okResult<EvidenceView>({
      runId,
      programId,
      mode: 'live',
      productMode: 'live',
      status: 'complete',
      generatedArtifactRef: { sha256 },
    }),
    events: okResult<RunEventsView>({
      runId,
      programId,
      mode: 'live',
      productMode: 'live',
      events: [{ type: 'run.completed', status: eventStatus, message: 'done', createdAt: '2026-05-15T10:00:02Z' }],
    }),
    artifacts: okResult<RunArtifactsView>({
      runId,
      programId,
      mode: 'live',
      productMode: 'live',
      artifacts: [
        {
          sha256,
          kind: 'generated',
          createdBy: 'orchestrator',
          createdAt: '2026-05-15T10:00:02Z',
          path: 'artifact.json',
          name: 'artifact.json',
        },
      ],
    }),
  };
}

function makeRunSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: 'run-test',
    programId: 'P-A',
    status: 'updating',
    mode: 'live',
    productMode: 'live',
    createdAt: '2026-05-15T10:00:00Z',
    updatedAt: '2026-05-15T10:00:01Z',
    activeStep: null,
    agentAttemptCount: 0,
    repairBudget: null,
    finalClassification: null,
    failureCode: null,
    failureMessage: null,
    ...overrides,
  };
}

function makeExperienceResult(runId: string, programId: string): ApiResult<RunExperienceView> {
  return okResult<RunExperienceView>({ runId, programId, mode: 'live', productMode: 'live', summary: undefined });
}

function RunHarness() {
  const { state, startTransform } = useTransformationRun();

  return (
    <div>
      <div data-testid="phase">{state.phase}</div>
      <div data-testid="run-id">{state.runId ?? 'none'}</div>
      <div data-testid="summary-status">{state.summary?.status ?? 'none'}</div>
      <div data-testid="generated-status">{state.generated?.status ?? 'none'}</div>
      <div data-testid="generated-files-status">{state.generatedFiles?.status ?? 'none'}</div>
      <div data-testid="build-test-status">{state.buildTest?.status ?? 'none'}</div>
      <div data-testid="evidence-status">{state.evidence?.status ?? 'none'}</div>
      <div data-testid="progress-count">{state.progress?.steps.length ?? 0}</div>
      <div data-testid="artifacts-count">{state.artifacts?.artifacts.length ?? 0}</div>
      <div data-testid="events-count">{state.events?.events.length ?? 0}</div>
      <div data-testid="experience-summary">{state.experience?.summary ?? 'none'}</div>
      <div data-testid="model-gateway-status">{state.modelGatewayHealth?.status ?? 'none'}</div>
      <div data-testid="harness-status">{state.harnessReady?.status ?? 'none'}</div>
      <div data-testid="error">{state.error ?? 'none'}</div>
      <button onClick={() => void startTransform({ sourceText: '       IDENTIFICATION DIVISION.', programId: 'P-A', sourceName: 'a.cbl' })}>
        start-a
      </button>
      <button onClick={() => void startTransform({ sourceText: '       IDENTIFICATION DIVISION.', programId: 'P-B', sourceName: 'b.cbl' })}>
        start-b
      </button>
    </div>
  );
}

describe('transformation run state machine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiClient.getRun).mockResolvedValue(okResult<RunSummary>(makeRunSummary({ status: 'updating' })));
    vi.mocked(apiClient.getRunProgress).mockImplementation((runId: string) =>
      Promise.resolve(makeProgressFixture(runId, 'P-A'))
    );
  });

  it('hydrates summary and artifacts for a completed terminal start response', async () => {
    const runId = 'run-completed';
    const fixtures = makeArtifactFixtures(runId, 'P-A', 'a'.repeat(64));

    vi.mocked(apiClient.transform).mockResolvedValueOnce(makeTerminalResponse(runId, 'P-A', 'completed'));
    vi.mocked(apiClient.getGenerated).mockResolvedValueOnce(fixtures.generated);
    vi.mocked(apiClient.getGeneratedFiles).mockResolvedValueOnce(fixtures.generatedFiles);
    vi.mocked(apiClient.getBuildTest).mockResolvedValueOnce(fixtures.buildTest);
    vi.mocked(apiClient.getEvidence).mockResolvedValueOnce(fixtures.evidence);
    vi.mocked(apiClient.getRunEvents).mockResolvedValueOnce(fixtures.events);
    vi.mocked(apiClient.getRunArtifacts).mockResolvedValueOnce(fixtures.artifacts);
    vi.mocked(apiClient.getRunExperience).mockResolvedValueOnce(makeExperienceResult(runId, 'P-A'));
    vi.mocked(apiClient.getModelGatewayHealth).mockResolvedValueOnce(okResult<ModelGatewayHealth>({ status: 'ok' }));
    vi.mocked(apiClient.getHarnessReady).mockResolvedValueOnce(okResult<HarnessReady>({ status: 'ok' }));

    vi.mocked(apiClient.getRunExperience).mockImplementation((runId: string) => Promise.resolve(makeExperienceResult(runId, 'P-A')));
    vi.mocked(apiClient.getModelGatewayHealth).mockImplementation(() => Promise.resolve(okResult<ModelGatewayHealth>({ status: 'ok' })));
    vi.mocked(apiClient.getHarnessReady).mockImplementation(() => Promise.resolve(okResult<HarnessReady>({ status: 'ok' })));

    render(
      <TransformationRunProvider>
        <RunHarness />
      </TransformationRunProvider>
    );

    await act(async () => {
      fireEvent.click(screen.getByText('start-a'));
    });

    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('completed'));
    expect(screen.getByTestId('summary-status')).toHaveTextContent('completed');
    expect(screen.getByTestId('generated-status')).toHaveTextContent('generated');
    expect(screen.getByTestId('artifacts-count')).toHaveTextContent('1');
  });

  it('hydrates artifacts for a failed terminal start response without promoting it to completed', async () => {
    const runId = 'run-failed';
    const fixtures = makeArtifactFixtures(runId, 'P-A', 'b'.repeat(64));

    vi.mocked(apiClient.transform).mockResolvedValueOnce(makeTerminalResponse(runId, 'P-A', 'failed'));
    vi.mocked(apiClient.getGenerated).mockResolvedValueOnce(fixtures.generated);
    vi.mocked(apiClient.getGeneratedFiles).mockResolvedValueOnce(fixtures.generatedFiles);
    vi.mocked(apiClient.getBuildTest).mockResolvedValueOnce(fixtures.buildTest);
    vi.mocked(apiClient.getEvidence).mockResolvedValueOnce(fixtures.evidence);
    vi.mocked(apiClient.getRunEvents).mockResolvedValueOnce(fixtures.events);
    vi.mocked(apiClient.getRunArtifacts).mockResolvedValueOnce(fixtures.artifacts);
    vi.mocked(apiClient.getRunExperience).mockResolvedValueOnce(makeExperienceResult(runId, 'P-A'));
    vi.mocked(apiClient.getModelGatewayHealth).mockResolvedValueOnce(okResult<ModelGatewayHealth>({ status: 'ok' }));
    vi.mocked(apiClient.getHarnessReady).mockResolvedValueOnce(okResult<HarnessReady>({ status: 'ok' }));

    vi.mocked(apiClient.getRunExperience).mockImplementation((runId: string) => Promise.resolve(makeExperienceResult(runId, 'P-A')));
    vi.mocked(apiClient.getModelGatewayHealth).mockImplementation(() => Promise.resolve(okResult<ModelGatewayHealth>({ status: 'ok' })));
    vi.mocked(apiClient.getHarnessReady).mockImplementation(() => Promise.resolve(okResult<HarnessReady>({ status: 'ok' })));

    render(
      <TransformationRunProvider>
        <RunHarness />
      </TransformationRunProvider>
    );

    fireEvent.click(screen.getByText('start-a'));

    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('failed'));
    expect(screen.getByTestId('summary-status')).toHaveTextContent('failed');
    expect(screen.getByTestId('generated-status')).toHaveTextContent('generated');
    expect(screen.getByTestId('artifacts-count')).toHaveTextContent('1');
  });

  it('keeps a completed run incomplete when required artifact views are missing', async () => {
    const runId = 'run-incomplete';
    const generatedFilesError: ApiResult<GeneratedFilesIndex> = {
      ok: false,
      status: 404,
      message: 'missing generated files',
    };

    vi.mocked(apiClient.transform).mockResolvedValueOnce(makeTerminalResponse(runId, 'P-A', 'completed'));
    vi.mocked(apiClient.getGenerated).mockResolvedValueOnce(makeArtifactFixtures(runId, 'P-A', 'c'.repeat(64)).generated);
    vi.mocked(apiClient.getGeneratedFiles).mockResolvedValueOnce(generatedFilesError);
    vi.mocked(apiClient.getBuildTest).mockResolvedValueOnce(makeArtifactFixtures(runId, 'P-A', 'c'.repeat(64)).buildTest);
    vi.mocked(apiClient.getEvidence).mockResolvedValueOnce(makeArtifactFixtures(runId, 'P-A', 'c'.repeat(64)).evidence);
    vi.mocked(apiClient.getRunEvents).mockResolvedValueOnce(makeArtifactFixtures(runId, 'P-A', 'c'.repeat(64)).events);
    vi.mocked(apiClient.getRunArtifacts).mockResolvedValueOnce(makeArtifactFixtures(runId, 'P-A', 'c'.repeat(64)).artifacts);
    vi.mocked(apiClient.getRunExperience).mockResolvedValueOnce(makeExperienceResult(runId, 'P-A'));
    vi.mocked(apiClient.getModelGatewayHealth).mockResolvedValueOnce(okResult<ModelGatewayHealth>({ status: 'ok' }));
    vi.mocked(apiClient.getHarnessReady).mockResolvedValueOnce(okResult<HarnessReady>({ status: 'ok' }));

    vi.mocked(apiClient.getRunExperience).mockImplementation((runId: string) => Promise.resolve(makeExperienceResult(runId, 'P-A')));
    vi.mocked(apiClient.getModelGatewayHealth).mockImplementation(() => Promise.resolve(okResult<ModelGatewayHealth>({ status: 'ok' })));
    vi.mocked(apiClient.getHarnessReady).mockImplementation(() => Promise.resolve(okResult<HarnessReady>({ status: 'ok' })));

    render(
      <TransformationRunProvider>
        <RunHarness />
      </TransformationRunProvider>
    );

    fireEvent.click(screen.getByText('start-a'));

    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('incomplete'));
    expect(screen.getByTestId('summary-status')).toHaveTextContent('completed');
    expect(screen.getByTestId('generated-files-status')).toHaveTextContent('none');
  });

  it('finishes polling at phase=completed when terminal artifact statuses diverge; verdict comes from derivation', async () => {
    const runId = 'run-divergence';
    const fixtures = makeArtifactFixtures(runId, 'P-A', 'e'.repeat(64));

    vi.mocked(apiClient.transform).mockResolvedValueOnce(makeTerminalResponse(runId, 'P-A', 'completed'));
    vi.mocked(apiClient.getGenerated).mockResolvedValueOnce(fixtures.generated);
    vi.mocked(apiClient.getGeneratedFiles).mockResolvedValueOnce(fixtures.generatedFiles);
    vi.mocked(apiClient.getBuildTest).mockResolvedValueOnce(
      okResult<BuildTestView>({
        ...fixtures.buildTest.data,
        status: 'output-divergence',
      })
    );
    vi.mocked(apiClient.getEvidence).mockResolvedValueOnce(fixtures.evidence);
    vi.mocked(apiClient.getRunEvents).mockResolvedValueOnce(fixtures.events);
    vi.mocked(apiClient.getRunArtifacts).mockResolvedValueOnce(fixtures.artifacts);
    vi.mocked(apiClient.getRunExperience).mockResolvedValueOnce(makeExperienceResult(runId, 'P-A'));
    vi.mocked(apiClient.getModelGatewayHealth).mockResolvedValueOnce(okResult<ModelGatewayHealth>({ status: 'ok' }));
    vi.mocked(apiClient.getHarnessReady).mockResolvedValueOnce(okResult<HarnessReady>({ status: 'ok' }));

    vi.mocked(apiClient.getRunExperience).mockImplementation((runId: string) => Promise.resolve(makeExperienceResult(runId, 'P-A')));
    vi.mocked(apiClient.getModelGatewayHealth).mockImplementation(() => Promise.resolve(okResult<ModelGatewayHealth>({ status: 'ok' })));
    vi.mocked(apiClient.getHarnessReady).mockImplementation(() => Promise.resolve(okResult<HarnessReady>({ status: 'ok' })));

    render(
      <TransformationRunProvider>
        <RunHarness />
      </TransformationRunProvider>
    );

    fireEvent.click(screen.getByText('start-a'));

    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('completed'));
    expect(screen.getByTestId('build-test-status')).toHaveTextContent('output-divergence');
  });

  it('marks a polling run unavailable on backend 503 responses', async () => {
    vi.mocked(apiClient.transform).mockResolvedValueOnce(
      okResult<TransformResponse>({
        runId: 'run-unavailable',
        orchestratorRunId: 'run-unavailable-orch',
        programId: 'P-A',
        status: 'starting',
        mode: 'live',
        productMode: 'live',
        createdAt: '2026-05-15T10:00:00Z',
        updatedAt: '2026-05-15T10:00:01Z',
        activeStep: null,
        agentAttemptCount: 0,
        repairBudget: null,
        finalClassification: null,
        failureCode: null,
        failureMessage: null,
        links: {
          self: '/runs/run-unavailable',
          generated: '/runs/run-unavailable/generated',
          generatedFiles: '/runs/run-unavailable/generated/files',
          buildTest: '/runs/run-unavailable/build-test',
          evidence: '/runs/run-unavailable/evidence',
          events: '/runs/run-unavailable/events',
          artifacts: '/runs/run-unavailable/artifacts',
        },
      })
    );
    const runUnavailableError: ApiResult<RunSummary> = {
      ok: false,
      status: 503,
      message: 'orchestrator unavailable',
      details: { kind: 'http', body: { error: 'orchestrator unavailable' } },
    };
    vi.mocked(apiClient.getRun).mockResolvedValueOnce(runUnavailableError);

    vi.mocked(apiClient.getRunExperience).mockImplementation((runId: string) => Promise.resolve(makeExperienceResult(runId, 'P-A')));
    vi.mocked(apiClient.getModelGatewayHealth).mockImplementation(() => Promise.resolve(okResult<ModelGatewayHealth>({ status: 'ok' })));
    vi.mocked(apiClient.getHarnessReady).mockImplementation(() => Promise.resolve(okResult<HarnessReady>({ status: 'ok' })));

    render(
      <TransformationRunProvider>
        <RunHarness />
      </TransformationRunProvider>
    );

    fireEvent.click(screen.getByText('start-a'));

    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('unavailable'));
    expect(screen.getByTestId('error')).toHaveTextContent('Backend unavailable');
  });

  it('hydrates live observability while a run is still active and preserves global service state on restart', async () => {
    vi.mocked(apiClient.getModelGatewayHealth).mockResolvedValue(okResult<ModelGatewayHealth>({ status: 'ok' }));
    vi.mocked(apiClient.getHarnessReady).mockResolvedValue(okResult<HarnessReady>({ status: 'ok' }));
    vi.mocked(apiClient.transform)
      .mockResolvedValueOnce(
        okResult<TransformResponse>({
          runId: 'run-live-a',
          orchestratorRunId: 'run-live-a-orch',
          programId: 'P-A',
          status: 'starting',
          mode: 'live',
          productMode: 'live',
          createdAt: '2026-05-15T10:00:00Z',
          updatedAt: '2026-05-15T10:00:01Z',
          activeStep: null,
          agentAttemptCount: 0,
          repairBudget: null,
          finalClassification: null,
          failureCode: null,
          failureMessage: null,
          links: {
            self: '/runs/run-live-a',
            generated: '/runs/run-live-a/generated',
            generatedFiles: '/runs/run-live-a/generated/files',
            buildTest: '/runs/run-live-a/build-test',
            evidence: '/runs/run-live-a/evidence',
            events: '/runs/run-live-a/events',
            artifacts: '/runs/run-live-a/artifacts',
          },
        })
      )
      .mockResolvedValueOnce(
        okResult<TransformResponse>({
          runId: 'run-live-b',
          orchestratorRunId: 'run-live-b-orch',
          programId: 'P-B',
          status: 'starting',
          mode: 'live',
          productMode: 'live',
          createdAt: '2026-05-15T10:00:02Z',
          updatedAt: '2026-05-15T10:00:03Z',
          activeStep: null,
          agentAttemptCount: 0,
          repairBudget: null,
          finalClassification: null,
          failureCode: null,
          failureMessage: null,
          links: {
            self: '/runs/run-live-b',
            generated: '/runs/run-live-b/generated',
            generatedFiles: '/runs/run-live-b/generated/files',
            buildTest: '/runs/run-live-b/build-test',
            evidence: '/runs/run-live-b/evidence',
            events: '/runs/run-live-b/events',
            artifacts: '/runs/run-live-b/artifacts',
          },
        })
      );
    vi.mocked(apiClient.getRun).mockImplementation(async (runId: string) =>
      okResult<RunSummary>(makeRunSummary({
        status: 'updating',
        runId,
        programId: runId === 'run-live-a' ? 'P-A' : 'P-B',
      }))
    );
    vi.mocked(apiClient.getRunEvents).mockImplementation(async (runId: string) =>
      okResult<RunEventsView>({
        runId,
        programId: runId === 'run-live-a' ? 'P-A' : 'P-B',
        mode: 'live',
        productMode: 'live',
        events: [{ type: 'run.accepted', status: 'ok', message: 'accepted', createdAt: '2026-05-15T10:00:04Z' }],
      })
    );
    vi.mocked(apiClient.getRunProgress).mockImplementation(async (runId: string) =>
      makeProgressFixture(runId, runId === 'run-live-a' ? 'P-A' : 'P-B')
    );
    vi.mocked(apiClient.getRunExperience).mockImplementation(async (runId: string) =>
      okResult<RunExperienceView>({
        runId,
        programId: runId === 'run-live-a' ? 'P-A' : 'P-B',
        mode: 'live',
        productMode: 'live',
        summary: '1 learning candidate observed',
      })
    );

    render(
      <TransformationRunProvider>
        <RunHarness />
      </TransformationRunProvider>
    );

    await waitFor(() => expect(screen.getByTestId('model-gateway-status')).toHaveTextContent('ok'));
    await waitFor(() => expect(screen.getByTestId('harness-status')).toHaveTextContent('ok'));

    fireEvent.click(screen.getByText('start-a'));

    await waitFor(() => expect(screen.getByTestId('events-count')).toHaveTextContent('1'));
    await waitFor(() => expect(screen.getByTestId('progress-count')).toHaveTextContent('3'));
    expect(screen.getByTestId('experience-summary')).toHaveTextContent('1 learning candidate observed');

    await act(async () => {
      fireEvent.click(screen.getByText('start-b'));
    });

    expect(screen.getByTestId('model-gateway-status')).toHaveTextContent('ok');
    expect(screen.getByTestId('harness-status')).toHaveTextContent('ok');
  });

  it('ignores stale artifact hydration from an earlier run after a newer run starts', async () => {
    const aArtifacts = {
      generated: deferred<ApiResult<GeneratedView>>(),
      generatedFiles: deferred<ApiResult<GeneratedFilesIndex>>(),
      buildTest: deferred<ApiResult<BuildTestView>>(),
      evidence: deferred<ApiResult<EvidenceView>>(),
      events: deferred<ApiResult<RunEventsView>>(),
      artifacts: deferred<ApiResult<RunArtifactsView>>(),
    };

    vi.mocked(apiClient.transform).mockImplementation(async request => {
      if (request.programId === 'P-A') {
        return makeTerminalResponse('run-a', 'P-A', 'completed');
      }

      return makeTerminalResponse('run-b', 'P-B', 'completed');
    });

    vi.mocked(apiClient.getGenerated).mockImplementation(runId =>
      runId === 'run-a'
        ? aArtifacts.generated.promise
        : Promise.resolve(makeArtifactFixtures('run-b', 'P-B', 'd'.repeat(64)).generated)
    );
    vi.mocked(apiClient.getGeneratedFiles).mockImplementation(runId =>
      runId === 'run-a'
        ? aArtifacts.generatedFiles.promise
        : Promise.resolve(makeArtifactFixtures('run-b', 'P-B', 'd'.repeat(64)).generatedFiles)
    );
    vi.mocked(apiClient.getBuildTest).mockImplementation(runId =>
      runId === 'run-a'
        ? aArtifacts.buildTest.promise
        : Promise.resolve(makeArtifactFixtures('run-b', 'P-B', 'd'.repeat(64)).buildTest)
    );
    vi.mocked(apiClient.getEvidence).mockImplementation(runId =>
      runId === 'run-a'
        ? aArtifacts.evidence.promise
        : Promise.resolve(makeArtifactFixtures('run-b', 'P-B', 'd'.repeat(64)).evidence)
    );
    vi.mocked(apiClient.getRunEvents).mockImplementation(runId =>
      runId === 'run-a'
        ? aArtifacts.events.promise
        : Promise.resolve(makeArtifactFixtures('run-b', 'P-B', 'd'.repeat(64)).events)
    );
    vi.mocked(apiClient.getRunArtifacts).mockImplementation(runId =>
      runId === 'run-a'
        ? aArtifacts.artifacts.promise
        : Promise.resolve(makeArtifactFixtures('run-b', 'P-B', 'd'.repeat(64)).artifacts)
    );

    vi.mocked(apiClient.getRunExperience).mockImplementation((runId: string) => Promise.resolve(makeExperienceResult(runId, 'P-A')));
    vi.mocked(apiClient.getModelGatewayHealth).mockImplementation(() => Promise.resolve(okResult<ModelGatewayHealth>({ status: 'ok' })));
    vi.mocked(apiClient.getHarnessReady).mockImplementation(() => Promise.resolve(okResult<HarnessReady>({ status: 'ok' })));

    render(
      <TransformationRunProvider>
        <RunHarness />
      </TransformationRunProvider>
    );

    fireEvent.click(screen.getByText('start-a'));
    fireEvent.click(screen.getByText('start-b'));

    await waitFor(() => expect(screen.getByTestId('run-id')).toHaveTextContent('run-b'));
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('completed'));

    await act(async () => {
      aArtifacts.generated.resolve(makeArtifactFixtures('run-a', 'P-A', 'a'.repeat(64)).generated);
      aArtifacts.generatedFiles.resolve(makeArtifactFixtures('run-a', 'P-A', 'a'.repeat(64)).generatedFiles);
      aArtifacts.buildTest.resolve(makeArtifactFixtures('run-a', 'P-A', 'a'.repeat(64)).buildTest);
      aArtifacts.evidence.resolve(makeArtifactFixtures('run-a', 'P-A', 'a'.repeat(64)).evidence);
      aArtifacts.events.resolve(makeArtifactFixtures('run-a', 'P-A', 'a'.repeat(64)).events);
      aArtifacts.artifacts.resolve(makeArtifactFixtures('run-a', 'P-A', 'a'.repeat(64)).artifacts);
    });

    expect(screen.getByTestId('run-id')).toHaveTextContent('run-b');
    expect(screen.getByTestId('summary-status')).toHaveTextContent('completed');
  });
});

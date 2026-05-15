import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from '@/lib/apiClient';
import { TransformationRunProvider, useTransformationRun } from '@/stores/transformationRun';

vi.mock('@/lib/apiClient', () => ({
  apiClient: {
    transform: vi.fn(),
    getRun: vi.fn(),
    getGenerated: vi.fn(),
    getGeneratedFiles: vi.fn(),
    getBuildTest: vi.fn(),
    getEvidence: vi.fn(),
    getRunEvents: vi.fn(),
    getRunArtifacts: vi.fn(),
    getRunExperience: vi.fn(),
    getModelGatewayHealth: vi.fn(),
    getModelGatewayModels: vi.fn(),
    getHarnessReady: vi.fn(),
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });

  return { promise, resolve };
}

function makeTerminalResponse(runId: string, programId: string, status: 'completed' | 'failed') {
  return {
    ok: true,
    data: {
      runId,
      orchestratorRunId: `${runId}-orch`,
      programId,
      status,
      mode: 'live',
      productMode: 'live',
      createdAt: '2026-05-15T10:00:00Z',
      updatedAt: '2026-05-15T10:00:01Z',
      links: {
        self: `/runs/${runId}`,
        generated: `/runs/${runId}/generated`,
        generatedFiles: `/runs/${runId}/generated/files`,
        buildTest: `/runs/${runId}/build-test`,
        evidence: `/runs/${runId}/evidence`,
        events: `/runs/${runId}/events`,
        artifacts: `/runs/${runId}/artifacts`,
      },
    },
  } as const;
}

function makeArtifactFixtures(
  runId: string,
  programId: string,
  sha256: string,
  eventStatus: 'completed' | 'failed' = 'completed'
) {
  return {
    generated: {
      ok: true,
      data: {
        runId,
        programId,
        mode: 'live',
        productMode: 'live',
        status: 'generated',
        artifactRef: { uri: `file:///runs/${runId}/generated.json`, sha256 },
      },
    },
    generatedFiles: {
      ok: true,
      data: {
        runId,
        programId,
        mode: 'live',
        productMode: 'live',
        status: 'complete',
        files: [],
        fileCount: 0,
        artifactRef: { uri: `file:///runs/${runId}/generated-files.json`, sha256 },
      },
    },
    buildTest: {
      ok: true,
      data: {
        runId,
        programId,
        mode: 'live',
        productMode: 'live',
        status: 'ok',
        classification: 'match',
        generatedArtifactRef: { uri: `file:///runs/${runId}/build-test.json`, sha256 },
      },
    },
    evidence: {
      ok: true,
      data: {
        runId,
        programId,
        mode: 'live',
        productMode: 'live',
        status: 'complete',
        generatedArtifactRef: { uri: `file:///runs/${runId}/evidence.json`, sha256 },
      },
    },
    events: {
      ok: true,
      data: {
        runId,
        programId,
        mode: 'live',
        productMode: 'live',
        events: [{ type: 'run.completed', status: eventStatus, message: 'done', createdAt: '2026-05-15T10:00:02Z' }],
      },
    },
    artifacts: {
      ok: true,
      data: {
        runId,
        programId,
        mode: 'live',
        productMode: 'live',
        artifacts: [
          {
            uri: `file:///runs/${runId}/artifact.json`,
            sha256,
            kind: 'generated',
            createdBy: 'orchestrator',
            createdAt: '2026-05-15T10:00:02Z',
            runId,
            workflowId: `${runId}-workflow`,
            path: 'artifact.json',
            name: 'artifact.json',
          },
        ],
      },
    },
  } as const;
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
    vi.mocked(apiClient.getRun).mockResolvedValue({ ok: true, data: { status: 'running' } } as any);
  });

  it('hydrates summary and artifacts for a completed terminal start response', async () => {
    const runId = 'run-completed';
    const fixtures = makeArtifactFixtures(runId, 'P-A', 'a'.repeat(64));

    vi.mocked(apiClient.transform).mockResolvedValueOnce(makeTerminalResponse(runId, 'P-A', 'completed') as any);
    vi.mocked(apiClient.getGenerated).mockResolvedValueOnce(fixtures.generated as any);
    vi.mocked(apiClient.getGeneratedFiles).mockResolvedValueOnce(fixtures.generatedFiles as any);
    vi.mocked(apiClient.getBuildTest).mockResolvedValueOnce(fixtures.buildTest as any);
    vi.mocked(apiClient.getEvidence).mockResolvedValueOnce(fixtures.evidence as any);
    vi.mocked(apiClient.getRunEvents).mockResolvedValueOnce(fixtures.events as any);
    vi.mocked(apiClient.getRunArtifacts).mockResolvedValueOnce(fixtures.artifacts as any);
    vi.mocked(apiClient.getRunExperience).mockResolvedValueOnce({ ok: true, data: { status: 'complete', summary: null } } as any);
    vi.mocked(apiClient.getModelGatewayHealth).mockResolvedValueOnce({ ok: true, data: { status: 'ok' } } as any);
    vi.mocked(apiClient.getHarnessReady).mockResolvedValueOnce({ ok: true, data: { status: 'ok' } } as any);

    vi.mocked(apiClient.getRunExperience).mockImplementation(runId => Promise.resolve({ ok: true, data: { status: 'complete', summary: null } }) as any);
    vi.mocked(apiClient.getModelGatewayHealth).mockImplementation(() => Promise.resolve({ ok: true, data: { status: 'ok' } }) as any);
    vi.mocked(apiClient.getHarnessReady).mockImplementation(() => Promise.resolve({ ok: true, data: { status: 'ok' } }) as any);

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

    vi.mocked(apiClient.transform).mockResolvedValueOnce(makeTerminalResponse(runId, 'P-A', 'failed') as any);
    vi.mocked(apiClient.getGenerated).mockResolvedValueOnce(fixtures.generated as any);
    vi.mocked(apiClient.getGeneratedFiles).mockResolvedValueOnce(fixtures.generatedFiles as any);
    vi.mocked(apiClient.getBuildTest).mockResolvedValueOnce(fixtures.buildTest as any);
    vi.mocked(apiClient.getEvidence).mockResolvedValueOnce(fixtures.evidence as any);
    vi.mocked(apiClient.getRunEvents).mockResolvedValueOnce(fixtures.events as any);
    vi.mocked(apiClient.getRunArtifacts).mockResolvedValueOnce(fixtures.artifacts as any);
    vi.mocked(apiClient.getRunExperience).mockResolvedValueOnce({ ok: true, data: { status: 'complete', summary: null } } as any);
    vi.mocked(apiClient.getModelGatewayHealth).mockResolvedValueOnce({ ok: true, data: { status: 'ok' } } as any);
    vi.mocked(apiClient.getHarnessReady).mockResolvedValueOnce({ ok: true, data: { status: 'ok' } } as any);

    vi.mocked(apiClient.getRunExperience).mockImplementation(runId => Promise.resolve({ ok: true, data: { status: 'complete', summary: null } }) as any);
    vi.mocked(apiClient.getModelGatewayHealth).mockImplementation(() => Promise.resolve({ ok: true, data: { status: 'ok' } }) as any);
    vi.mocked(apiClient.getHarnessReady).mockImplementation(() => Promise.resolve({ ok: true, data: { status: 'ok' } }) as any);

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

    vi.mocked(apiClient.transform).mockResolvedValueOnce(makeTerminalResponse(runId, 'P-A', 'completed') as any);
    vi.mocked(apiClient.getGenerated).mockResolvedValueOnce(makeArtifactFixtures(runId, 'P-A', 'c'.repeat(64)).generated as any);
    vi.mocked(apiClient.getGeneratedFiles).mockResolvedValueOnce({
      ok: false,
      status: 404,
      message: 'missing generated files',
    } as any);
    vi.mocked(apiClient.getBuildTest).mockResolvedValueOnce(makeArtifactFixtures(runId, 'P-A', 'c'.repeat(64)).buildTest as any);
    vi.mocked(apiClient.getEvidence).mockResolvedValueOnce(makeArtifactFixtures(runId, 'P-A', 'c'.repeat(64)).evidence as any);
    vi.mocked(apiClient.getRunEvents).mockResolvedValueOnce(makeArtifactFixtures(runId, 'P-A', 'c'.repeat(64)).events as any);
    vi.mocked(apiClient.getRunArtifacts).mockResolvedValueOnce(makeArtifactFixtures(runId, 'P-A', 'c'.repeat(64)).artifacts as any);
    vi.mocked(apiClient.getRunExperience).mockResolvedValueOnce({ ok: true, data: { status: 'complete', summary: null } } as any);
    vi.mocked(apiClient.getModelGatewayHealth).mockResolvedValueOnce({ ok: true, data: { status: 'ok' } } as any);
    vi.mocked(apiClient.getHarnessReady).mockResolvedValueOnce({ ok: true, data: { status: 'ok' } } as any);

    vi.mocked(apiClient.getRunExperience).mockImplementation(runId => Promise.resolve({ ok: true, data: { status: 'complete', summary: null } }) as any);
    vi.mocked(apiClient.getModelGatewayHealth).mockImplementation(() => Promise.resolve({ ok: true, data: { status: 'ok' } }) as any);
    vi.mocked(apiClient.getHarnessReady).mockImplementation(() => Promise.resolve({ ok: true, data: { status: 'ok' } }) as any);

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

  it('blocks verification when terminal artifact statuses are not all successful', async () => {
    const runId = 'run-verification-blocked';
    const fixtures = makeArtifactFixtures(runId, 'P-A', 'e'.repeat(64));

    vi.mocked(apiClient.transform).mockResolvedValueOnce(makeTerminalResponse(runId, 'P-A', 'completed') as any);
    vi.mocked(apiClient.getGenerated).mockResolvedValueOnce(fixtures.generated as any);
    vi.mocked(apiClient.getGeneratedFiles).mockResolvedValueOnce(fixtures.generatedFiles as any);
    vi.mocked(apiClient.getBuildTest).mockResolvedValueOnce({
      ...fixtures.buildTest,
      data: {
        ...fixtures.buildTest.data,
        status: 'output-divergence',
      },
    } as any);
    vi.mocked(apiClient.getEvidence).mockResolvedValueOnce(fixtures.evidence as any);
    vi.mocked(apiClient.getRunEvents).mockResolvedValueOnce(fixtures.events as any);
    vi.mocked(apiClient.getRunArtifacts).mockResolvedValueOnce(fixtures.artifacts as any);
    vi.mocked(apiClient.getRunExperience).mockResolvedValueOnce({ ok: true, data: { status: 'complete', summary: null } } as any);
    vi.mocked(apiClient.getModelGatewayHealth).mockResolvedValueOnce({ ok: true, data: { status: 'ok' } } as any);
    vi.mocked(apiClient.getHarnessReady).mockResolvedValueOnce({ ok: true, data: { status: 'ok' } } as any);

    vi.mocked(apiClient.getRunExperience).mockImplementation(runId => Promise.resolve({ ok: true, data: { status: 'complete', summary: null } }) as any);
    vi.mocked(apiClient.getModelGatewayHealth).mockImplementation(() => Promise.resolve({ ok: true, data: { status: 'ok' } }) as any);
    vi.mocked(apiClient.getHarnessReady).mockImplementation(() => Promise.resolve({ ok: true, data: { status: 'ok' } }) as any);

    render(
      <TransformationRunProvider>
        <RunHarness />
      </TransformationRunProvider>
    );

    fireEvent.click(screen.getByText('start-a'));

    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('verification-blocked'));
    expect(screen.getByTestId('build-test-status')).toHaveTextContent('output-divergence');
  });

  it('marks a polling run unavailable on backend 503 responses', async () => {
    vi.mocked(apiClient.transform).mockResolvedValueOnce({
      ok: true,
      data: {
        runId: 'run-unavailable',
        orchestratorRunId: 'run-unavailable-orch',
        programId: 'P-A',
        status: 'starting',
        mode: 'live',
        productMode: 'live',
        createdAt: '2026-05-15T10:00:00Z',
        updatedAt: '2026-05-15T10:00:01Z',
        links: {
          self: '/runs/run-unavailable',
          generated: '/runs/run-unavailable/generated',
          generatedFiles: '/runs/run-unavailable/generated/files',
          buildTest: '/runs/run-unavailable/build-test',
          evidence: '/runs/run-unavailable/evidence',
          events: '/runs/run-unavailable/events',
          artifacts: '/runs/run-unavailable/artifacts',
        },
      },
    } as any);
    vi.mocked(apiClient.getRun).mockResolvedValueOnce({
      ok: false,
      status: 503,
      message: 'orchestrator unavailable',
      details: { kind: 'http', body: { error: 'orchestrator unavailable' } },
    } as any);

    vi.mocked(apiClient.getRunExperience).mockImplementation(runId => Promise.resolve({ ok: true, data: { status: 'complete', summary: null } }) as any);
    vi.mocked(apiClient.getModelGatewayHealth).mockImplementation(() => Promise.resolve({ ok: true, data: { status: 'ok' } }) as any);
    vi.mocked(apiClient.getHarnessReady).mockImplementation(() => Promise.resolve({ ok: true, data: { status: 'ok' } }) as any);

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
    vi.mocked(apiClient.getModelGatewayHealth).mockResolvedValue({ ok: true, data: { status: 'ok' } } as any);
    vi.mocked(apiClient.getHarnessReady).mockResolvedValue({ ok: true, data: { status: 'ok' } } as any);
    vi.mocked(apiClient.transform)
      .mockResolvedValueOnce({
        ok: true,
        data: {
          runId: 'run-live-a',
          orchestratorRunId: 'run-live-a-orch',
          programId: 'P-A',
          status: 'starting',
          mode: 'live',
          productMode: 'live',
          createdAt: '2026-05-15T10:00:00Z',
          updatedAt: '2026-05-15T10:00:01Z',
          links: {
            self: '/runs/run-live-a',
            generated: '/runs/run-live-a/generated',
            generatedFiles: '/runs/run-live-a/generated/files',
            buildTest: '/runs/run-live-a/build-test',
            evidence: '/runs/run-live-a/evidence',
            events: '/runs/run-live-a/events',
            artifacts: '/runs/run-live-a/artifacts',
          },
        },
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        data: {
          runId: 'run-live-b',
          orchestratorRunId: 'run-live-b-orch',
          programId: 'P-B',
          status: 'starting',
          mode: 'live',
          productMode: 'live',
          createdAt: '2026-05-15T10:00:02Z',
          updatedAt: '2026-05-15T10:00:03Z',
          links: {
            self: '/runs/run-live-b',
            generated: '/runs/run-live-b/generated',
            generatedFiles: '/runs/run-live-b/generated/files',
            buildTest: '/runs/run-live-b/build-test',
            evidence: '/runs/run-live-b/evidence',
            events: '/runs/run-live-b/events',
            artifacts: '/runs/run-live-b/artifacts',
          },
        },
      } as any);
    vi.mocked(apiClient.getRun).mockImplementation(async (runId: string) => ({
      ok: true,
      data: {
        status: 'updating',
        runId,
        programId: runId === 'run-live-a' ? 'P-A' : 'P-B',
      },
    }) as any);
    vi.mocked(apiClient.getRunEvents).mockImplementation(async (runId: string) => ({
      ok: true,
      data: {
        runId,
        programId: runId === 'run-live-a' ? 'P-A' : 'P-B',
        mode: 'live',
        productMode: 'live',
        events: [{ type: 'run.accepted', status: 'ok', message: 'accepted', createdAt: '2026-05-15T10:00:04Z' }],
      },
    }) as any);
    vi.mocked(apiClient.getRunExperience).mockImplementation(async (runId: string) => ({
      ok: true,
      data: {
        runId,
        programId: runId === 'run-live-a' ? 'P-A' : 'P-B',
        mode: 'live',
        productMode: 'live',
        summary: '1 learning candidate observed',
      },
    }) as any);

    render(
      <TransformationRunProvider>
        <RunHarness />
      </TransformationRunProvider>
    );

    await waitFor(() => expect(screen.getByTestId('model-gateway-status')).toHaveTextContent('ok'));
    await waitFor(() => expect(screen.getByTestId('harness-status')).toHaveTextContent('ok'));

    fireEvent.click(screen.getByText('start-a'));

    await waitFor(() => expect(screen.getByTestId('events-count')).toHaveTextContent('1'));
    expect(screen.getByTestId('experience-summary')).toHaveTextContent('1 learning candidate observed');

    await act(async () => {
      fireEvent.click(screen.getByText('start-b'));
    });

    expect(screen.getByTestId('model-gateway-status')).toHaveTextContent('ok');
    expect(screen.getByTestId('harness-status')).toHaveTextContent('ok');
  });

  it('ignores stale artifact hydration from an earlier run after a newer run starts', async () => {
    const aArtifacts = {
      generated: deferred<any>(),
      generatedFiles: deferred<any>(),
      buildTest: deferred<any>(),
      evidence: deferred<any>(),
      events: deferred<any>(),
      artifacts: deferred<any>(),
    };

    vi.mocked(apiClient.transform).mockImplementation(async request => {
      if (request.programId === 'P-A') {
        return makeTerminalResponse('run-a', 'P-A', 'completed') as any;
      }

      return makeTerminalResponse('run-b', 'P-B', 'completed') as any;
    });

    vi.mocked(apiClient.getGenerated).mockImplementation(runId =>
      runId === 'run-a'
        ? aArtifacts.generated.promise
        : Promise.resolve(makeArtifactFixtures('run-b', 'P-B', 'd'.repeat(64)).generated as any)
    );
    vi.mocked(apiClient.getGeneratedFiles).mockImplementation(runId =>
      runId === 'run-a'
        ? aArtifacts.generatedFiles.promise
        : Promise.resolve(makeArtifactFixtures('run-b', 'P-B', 'd'.repeat(64)).generatedFiles as any)
    );
    vi.mocked(apiClient.getBuildTest).mockImplementation(runId =>
      runId === 'run-a'
        ? aArtifacts.buildTest.promise
        : Promise.resolve(makeArtifactFixtures('run-b', 'P-B', 'd'.repeat(64)).buildTest as any)
    );
    vi.mocked(apiClient.getEvidence).mockImplementation(runId =>
      runId === 'run-a'
        ? aArtifacts.evidence.promise
        : Promise.resolve(makeArtifactFixtures('run-b', 'P-B', 'd'.repeat(64)).evidence as any)
    );
    vi.mocked(apiClient.getRunEvents).mockImplementation(runId =>
      runId === 'run-a'
        ? aArtifacts.events.promise
        : Promise.resolve(makeArtifactFixtures('run-b', 'P-B', 'd'.repeat(64)).events as any)
    );
    vi.mocked(apiClient.getRunArtifacts).mockImplementation(runId =>
      runId === 'run-a'
        ? aArtifacts.artifacts.promise
        : Promise.resolve(makeArtifactFixtures('run-b', 'P-B', 'd'.repeat(64)).artifacts as any)
    );

    vi.mocked(apiClient.getRunExperience).mockImplementation(runId => Promise.resolve({ ok: true, data: { status: 'complete', summary: null } }) as any);
    vi.mocked(apiClient.getModelGatewayHealth).mockImplementation(() => Promise.resolve({ ok: true, data: { status: 'ok' } }) as any);
    vi.mocked(apiClient.getHarnessReady).mockImplementation(() => Promise.resolve({ ok: true, data: { status: 'ok' } }) as any);

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
      aArtifacts.generated.resolve(makeArtifactFixtures('run-a', 'P-A', 'a'.repeat(64)).generated as any);
      aArtifacts.generatedFiles.resolve(makeArtifactFixtures('run-a', 'P-A', 'a'.repeat(64)).generatedFiles as any);
      aArtifacts.buildTest.resolve(makeArtifactFixtures('run-a', 'P-A', 'a'.repeat(64)).buildTest as any);
      aArtifacts.evidence.resolve(makeArtifactFixtures('run-a', 'P-A', 'a'.repeat(64)).evidence as any);
      aArtifacts.events.resolve(makeArtifactFixtures('run-a', 'P-A', 'a'.repeat(64)).events as any);
      aArtifacts.artifacts.resolve(makeArtifactFixtures('run-a', 'P-A', 'a'.repeat(64)).artifacts as any);
    });

    expect(screen.getByTestId('run-id')).toHaveTextContent('run-b');
    expect(screen.getByTestId('summary-status')).toHaveTextContent('completed');
  });
});

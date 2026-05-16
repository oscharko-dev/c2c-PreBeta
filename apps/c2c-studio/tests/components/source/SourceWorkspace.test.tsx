import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SourceWorkspaceTree } from '@/components/source/SourceWorkspaceTree';
import { CobolEditorPane } from '@/components/source/CobolEditorPane';
import { SourceWorkspaceProvider } from '@/stores/sourceWorkspace';
import { TransformationRunProvider, useTransformationRun } from '@/stores/transformationRun';
import { apiClient } from '@/lib/apiClient';
import { AppTopBar } from '@/components/workbench/AppTopBar';
import { ApiResult, TransformResponse, RunSummary, RunProgressView } from '@/types/api';
import { RunExperienceView, ModelGatewayHealth, HarnessReady } from '@/types/observability';
import { useEffect } from 'react';

function okResult<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

vi.mock('@/lib/apiClient', () => ({
  apiClient: {
    getSamples: vi.fn(),
    getSampleDetail: vi.fn(),
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

vi.mock('@/hooks/useC2cApi', () => ({
  useC2cApi: () => ({ health: { status: 'ok' }, mode: { orchestrator: 'live', evidence: 'live' }, error: null, errorKind: null, loading: false })
}));

describe('Source Workspace', () => {
  beforeEach(() => {
    vi.mocked(apiClient.getRunProgress).mockResolvedValue(okResult<RunProgressView>({ runId: 'run-1', programId: 'P1', mode: 'live', productMode: 'live', status: 'complete', currentStep: null, failedStep: null, completedSteps: [], stepCount: 0, steps: [] }));
    vi.mocked(apiClient.getRunExperience).mockResolvedValue(okResult<RunExperienceView>({ runId: 'run-1', programId: 'P1', mode: 'live', productMode: 'live', summary: undefined }));
    vi.mocked(apiClient.getModelGatewayHealth).mockResolvedValue(okResult<ModelGatewayHealth>({ status: 'ok' }));
    vi.mocked(apiClient.getHarnessReady).mockResolvedValue(okResult<HarnessReady>({ status: 'ok' }));
    vi.clearAllMocks();
    vi.mocked(apiClient.getRun).mockResolvedValue(okResult<RunSummary>({
      runId: 'run-1',
      programId: 'P1',
      status: 'updating',
      mode: 'live',
      productMode: 'live',
      createdAt: '2026-05-15T10:00:00Z',
      updatedAt: '2026-05-15T10:00:01Z',
    }));
  });

  function SetUnsupportedRunState() {
    const { setState } = useTransformationRun();

    useEffect(() => {
      setState((prev) => ({
        ...prev,
        phase: 'completed',
        runId: 'run-unsupported',
        generated: {
          runId: 'run-unsupported',
          programId: 'P-UNSUPPORTED',
          mode: 'live',
          productMode: 'live',
          status: 'unsupported',
          unsupportedFeatures: ['COPY REPLACING'],
          artifactRef: null,
        },
      }));
    }, [setState]);

    return null;
  }

  it('renders reference programs including supported and unsupported entries', async () => {
    vi.mocked(apiClient.getSamples).mockResolvedValue({
      ok: true,
      data: [
        { programId: 'P1', title: 'Prog 1', description: 'D1', knownDivergenceAtW0: false, supportedInProductMode: true, w0Subset: ['CALL'], oracleMode: 'synthetic-fixture', knownLimitations: [] },
        { programId: 'P2', title: 'Prog 2', description: 'D2', knownDivergenceAtW0: true, supportedInProductMode: false, w0Subset: [], oracleMode: null, knownLimitations: ['Uses unsupported EXEC CICS blocks.'] },
      ],
    });

    render(
      <TransformationRunProvider><SourceWorkspaceProvider>
        <SourceWorkspaceTree />
      </SourceWorkspaceProvider></TransformationRunProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Prog 1')).toBeInTheDocument();
      expect(screen.getByText('Prog 2')).toBeInTheDocument();
      expect(screen.getByText(/Unavailable in product mode/i)).toBeInTheDocument();
    });
  });

  it('loads a reference program inserting exact cobolSource into the editor', async () => {
    vi.mocked(apiClient.getSamples).mockResolvedValue({
      ok: true,
      data: [
        { programId: 'P1', title: 'Prog 1', description: 'D1', knownDivergenceAtW0: false, supportedInProductMode: true, w0Subset: ['MOVE'], oracleMode: 'synthetic-fixture', knownLimitations: [] },
      ],
    });

    vi.mocked(apiClient.getSampleDetail).mockResolvedValue({
      ok: true,
      data: {
        programId: 'P1',
        title: 'Prog 1',
        description: 'D1',
        knownDivergenceAtW0: false,
        supportedInProductMode: true,
        w0Subset: ['MOVE'],
        oracleMode: 'synthetic-fixture',
        knownLimitations: [],
        cobolSource: '      * THIS IS COBOL',
        expectedOutput: '',
        cobolSourcePath: '/path/to/P1.cbl',
        expectedOutputPath: '',
      },
    });

    render(
      <TransformationRunProvider><SourceWorkspaceProvider>
        <SourceWorkspaceTree />
        <CobolEditorPane />
      </SourceWorkspaceProvider></TransformationRunProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Prog 1')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Prog 1'));

    await waitFor(() => {
      expect(screen.getByRole('textbox')).toHaveValue('      * THIS IS COBOL');
      expect(screen.getByText('ID: P1')).toBeInTheDocument();
      expect(screen.getByText('P1.cbl')).toBeInTheDocument();
    });
  });

  it('editing source marks the buffer dirty and changes submitted text', async () => {
    render(
      <TransformationRunProvider><SourceWorkspaceProvider>
        <CobolEditorPane />
      </SourceWorkspaceProvider></TransformationRunProvider>
    );

    fireEvent.click(screen.getByText('Start Typing'));

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: '      * NEW TEXT' } });

    expect(screen.getByRole('textbox')).toHaveValue('      * NEW TEXT');
    expect(screen.getByText(/pasted-source\.cbl \*/i)).toBeInTheDocument();

    vi.mocked(apiClient.transform).mockResolvedValue({ ok: true, data: { runId: 'r1', programId: 'SRC-1', status: 'starting' } as unknown as TransformResponse });
    
    fireEvent.click(screen.getByText('Start Transformation'));

    await waitFor(() => {
      expect(apiClient.transform).toHaveBeenCalledWith({
        sourceText: '      * NEW TEXT',
        programId: undefined,
        sourceName: 'pasted-source.cbl',
      });
    });
  });

  it('drops the loaded reference programId once the editor buffer becomes dirty', async () => {
    vi.mocked(apiClient.getSamples).mockResolvedValue({
      ok: true,
      data: [
        { programId: 'P1', title: 'Prog 1', description: 'D1', knownDivergenceAtW0: false, supportedInProductMode: true, w0Subset: ['MOVE'], oracleMode: 'synthetic-fixture', knownLimitations: [] },
      ],
    });
    vi.mocked(apiClient.getSampleDetail).mockResolvedValue({
      ok: true,
      data: {
        programId: 'P1',
        title: 'Prog 1',
        description: 'D1',
        knownDivergenceAtW0: false,
        supportedInProductMode: true,
        w0Subset: ['MOVE'],
        oracleMode: 'synthetic-fixture',
        knownLimitations: [],
        cobolSource: '       IDENTIFICATION DIVISION.\n       PROGRAM-ID. P1.\n',
        cobolSourcePath: '/path/to/P1.cbl',
        expectedOutput: '',
        expectedOutputPath: '',
      },
    });
    vi.mocked(apiClient.transform).mockResolvedValue({ ok: true, data: { runId: 'r2', programId: 'P1A', status: 'starting' } as unknown as TransformResponse });

    render(
      <TransformationRunProvider><SourceWorkspaceProvider>
        <SourceWorkspaceTree />
        <CobolEditorPane />
      </SourceWorkspaceProvider></TransformationRunProvider>
    );

    fireEvent.click(await screen.findByText('Prog 1'));
    const textbox = await screen.findByRole('textbox');
    fireEvent.change(textbox, {
      target: { value: '       IDENTIFICATION DIVISION.\n       PROGRAM-ID. P1A.\n' },
    });
    fireEvent.click(screen.getByRole('button', { name: /start transformation/i }));

    await waitFor(() => {
      expect(apiClient.transform).toHaveBeenCalledWith({
        sourceText: '       IDENTIFICATION DIVISION.\n       PROGRAM-ID. P1A.\n',
        programId: undefined,
        sourceName: 'P1.cbl',
      });
    });
  });

  it('top bar start action submits the same current editor buffer', async () => {
    vi.mocked(apiClient.transform).mockResolvedValue({ ok: true, data: { runId: 'r3', programId: 'DEMO01', status: 'starting' } as unknown as TransformResponse });

    render(
      <TransformationRunProvider><SourceWorkspaceProvider>
        <AppTopBar apiState={{ health: { status: 'ok' }, mode: { orchestrator: 'live', evidence: 'live' }, error: null, errorKind: null, loading: false }} />
        <CobolEditorPane />
      </SourceWorkspaceProvider></TransformationRunProvider>
    );

    fireEvent.click(screen.getByText('Start Typing'));
    fireEvent.click(screen.getAllByRole('button', { name: /start transformation/i })[0]);

    await waitFor(() => {
      expect(apiClient.transform).toHaveBeenCalledWith({
        sourceText: '       IDENTIFICATION DIVISION.\n       PROGRAM-ID. PROG01.\n',
        programId: undefined,
        sourceName: 'pasted-source.cbl',
      });
    });
  });

  it('keyboard shortcuts respect blocked state and support Alt+R once ready', async () => {
    vi.mocked(apiClient.transform).mockResolvedValue({ ok: true, data: { runId: 'r4', programId: 'DEMO01', status: 'starting' } as unknown as TransformResponse });

    render(
      <TransformationRunProvider><SourceWorkspaceProvider>
        <AppTopBar apiState={{ health: { status: 'ok' }, mode: { orchestrator: 'live', evidence: 'live' }, error: null, errorKind: null, loading: false }} />
        <CobolEditorPane />
      </SourceWorkspaceProvider></TransformationRunProvider>
    );

    fireEvent.keyDown(window, { key: 'r', altKey: true });
    expect(apiClient.transform).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Start Typing'));
    fireEvent.keyDown(window, { key: 'r', altKey: true });

    await waitFor(() => {
      expect(apiClient.transform).toHaveBeenCalledWith({
        sourceText: '       IDENTIFICATION DIVISION.\n       PROGRAM-ID. PROG01.\n',
        programId: undefined,
        sourceName: 'pasted-source.cbl',
      });
    });
  });

  it('disabled states prevent submission', async () => {
    render(
      <TransformationRunProvider><SourceWorkspaceProvider>
        <CobolEditorPane />
      </SourceWorkspaceProvider></TransformationRunProvider>
    );

    const transformButton = screen.queryByText('Start Transformation');
    expect(transformButton).not.toBeInTheDocument(); // It doesn't show because empty state is showing

    fireEvent.click(screen.getByText('Start Typing'));
    
    // Now text is there, so we clear it
    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: '   ' } });

    const btn = screen.getByRole('button', { name: /Start Transformation/i });
    expect(btn).toBeDisabled();
  });

  it('keeps large source buffers accessible without rendering every gutter row at once', async () => {
    render(
      <TransformationRunProvider><SourceWorkspaceProvider>
        <CobolEditorPane />
      </SourceWorkspaceProvider></TransformationRunProvider>
    );

    fireEvent.click(screen.getByText('Start Typing'));

    const largeSource = Array.from({ length: 1200 }, (_, index) => `LINE_${String(index + 1).padStart(4, '0')}`).join('\n');
    const textarea = screen.getByRole('textbox', { name: /COBOL source editor/i });
    fireEvent.change(textarea, { target: { value: largeSource } });

    expect(textarea).toHaveAttribute('aria-label', 'pasted-source.cbl COBOL source editor');
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.queryByText('1200')).not.toBeInTheDocument();
  });

  it('preserves the editor buffer and shows backend-unavailable errors', async () => {
    vi.mocked(apiClient.transform).mockResolvedValue({
      ok: false,
      status: 503,
      message: 'orchestrator unavailable',
      details: { kind: 'http', body: { error: 'orchestrator unavailable' } },
    });

    render(
      <TransformationRunProvider><SourceWorkspaceProvider>
        <CobolEditorPane />
      </SourceWorkspaceProvider></TransformationRunProvider>
    );

    fireEvent.click(screen.getByText('Start Typing'));
    fireEvent.click(screen.getByRole('button', { name: /start transformation/i }));

    expect(await screen.findByText('Backend unavailable. Try again shortly.')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue(
      '       IDENTIFICATION DIVISION.\n       PROGRAM-ID. PROG01.\n',
    );
  });

  it('preserves the editor buffer and shows validation errors for 400 responses', async () => {
    vi.mocked(apiClient.transform).mockResolvedValue({
      ok: false,
      status: 400,
      message: 'Transformation validation failed',
      details: { kind: 'http', body: { error: 'Transformation validation failed' } },
    });

    render(
      <TransformationRunProvider><SourceWorkspaceProvider>
        <CobolEditorPane />
      </SourceWorkspaceProvider></TransformationRunProvider>
    );

    fireEvent.click(screen.getByText('Start Typing'));
    fireEvent.click(screen.getByRole('button', { name: /start transformation/i }));

    expect(await screen.findByText('Transformation validation failed')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue(
      '       IDENTIFICATION DIVISION.\n       PROGRAM-ID. PROG01.\n',
    );
  });

  it('shows unsupported constructs next to the source editor when the run is blocked by W0 scope', async () => {
    render(
      <TransformationRunProvider><SourceWorkspaceProvider>
        <SetUnsupportedRunState />
        <CobolEditorPane />
      </SourceWorkspaceProvider></TransformationRunProvider>
    );

    fireEvent.click(screen.getByText('Start Typing'));

    expect(await screen.findByText('Unsupported COBOL constructs block this run.')).toBeInTheDocument();
    expect(screen.getByText('COPY REPLACING')).toBeInTheDocument();
  });

  it('does not load unsupported references from the BFF', async () => {
    vi.mocked(apiClient.getSamples).mockResolvedValue({
      ok: true,
      data: [
        { programId: 'P2', title: 'Prog 2', description: 'D2', knownDivergenceAtW0: true, supportedInProductMode: false, w0Subset: [], oracleMode: null, knownLimitations: ['Not supported in W0.'] },
      ],
    });

    render(
      <TransformationRunProvider><SourceWorkspaceProvider>
        <SourceWorkspaceTree />
      </SourceWorkspaceProvider></TransformationRunProvider>
    );

    fireEvent.click(await screen.findByText('Prog 2'));

    expect(apiClient.getSampleDetail).not.toHaveBeenCalled();
  });

});

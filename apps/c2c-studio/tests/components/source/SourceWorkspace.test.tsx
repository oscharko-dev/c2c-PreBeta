import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SourceWorkspaceTree } from '@/components/source/SourceWorkspaceTree';
import { CobolEditorPane } from '@/components/source/CobolEditorPane';
import { SourceWorkspaceProvider } from '@/stores/sourceWorkspace';
import { apiClient } from '@/lib/apiClient';

vi.mock('@/lib/apiClient', () => ({
  apiClient: {
    getSamples: vi.fn(),
    getSampleDetail: vi.fn(),
    transform: vi.fn(),
  },
}));

describe('Source Workspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders reference programs including supported and unsupported entries', async () => {
    vi.mocked(apiClient.getSamples).mockResolvedValue({
      ok: true,
      data: [
        { programId: 'P1', title: 'Prog 1', description: 'D1', supportedInProductMode: true, w0Subset: true, oracleMode: false, knownLimitations: [] },
        { programId: 'P2', title: 'Prog 2', description: 'D2', supportedInProductMode: false, w0Subset: true, oracleMode: false, knownLimitations: [] },
      ],
    });

    render(
      <SourceWorkspaceProvider>
        <SourceWorkspaceTree />
      </SourceWorkspaceProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Prog 1')).toBeInTheDocument();
      expect(screen.getByText('Prog 2')).toBeInTheDocument();
    });
  });

  it('loads a reference program inserting exact cobolSource into the editor', async () => {
    vi.mocked(apiClient.getSamples).mockResolvedValue({
      ok: true,
      data: [
        { programId: 'P1', title: 'Prog 1', description: 'D1', supportedInProductMode: true, w0Subset: true, oracleMode: false, knownLimitations: [] },
      ],
    });

    vi.mocked(apiClient.getSampleDetail).mockResolvedValue({
      ok: true,
      data: {
        programId: 'P1',
        cobolSource: '      * THIS IS COBOL',
        expectedOutput: '',
        sourcePath: '/path/to/P1.cbl',
        expectedOutputPath: '',
      },
    });

    render(
      <SourceWorkspaceProvider>
        <SourceWorkspaceTree />
        <CobolEditorPane />
      </SourceWorkspaceProvider>
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
      <SourceWorkspaceProvider>
        <CobolEditorPane />
      </SourceWorkspaceProvider>
    );

    fireEvent.click(screen.getByText('Start Typing'));

    const textarea = screen.getByRole('textbox');
    fireEvent.change(textarea, { target: { value: '      * NEW TEXT' } });

    expect(screen.getByRole('textbox')).toHaveValue('      * NEW TEXT');
    expect(screen.getByText(/Unsaved Buffer \*/)).toBeInTheDocument();

    vi.mocked(apiClient.transform).mockResolvedValue({ ok: true, data: { runId: 'r1', status: 'pending' } });
    
    fireEvent.click(screen.getByText('Start Transformation'));

    await waitFor(() => {
      expect(apiClient.transform).toHaveBeenCalledWith({
        sourceText: '      * NEW TEXT',
        programId: undefined,
        sourceName: 'pasted-source.cbl',
      });
    });
  });

  it('disabled states prevent submission', async () => {
    render(
      <SourceWorkspaceProvider>
        <CobolEditorPane />
      </SourceWorkspaceProvider>
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
});

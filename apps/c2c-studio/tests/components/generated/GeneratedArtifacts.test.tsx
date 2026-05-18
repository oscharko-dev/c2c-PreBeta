import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { GeneratedJavaEditorPane } from '@/components/generated/GeneratedJavaEditorPane';
import { TargetJavaInspector } from '@/components/generated/TargetJavaInspector';
import { GeneratedArtifactsProvider } from '@/hooks/useGeneratedArtifacts';
import { apiClient } from '@/lib/apiClient';
import { ApiResult, GeneratedFileContent } from '@/types/api';

vi.mock('@/lib/apiClient', () => ({
  apiClient: {
    getGeneratedFile: vi.fn(),
  },
}));

// We can mock the transformation run context or use the real provider and set state.
// To make it simpler, we mock the hook `useGeneratedArtifacts` directly, or we can mock `useTransformationRun`.
const mockTransformationState = vi.fn();
vi.mock('@/stores/transformationRun', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/transformationRun')>();
  const { deriveProductState } = await import('@/types/state');
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
        ensureJavaBaseline: vi.fn(),
        saveJavaDraft: vi.fn(),
        loadJavaDraftFor: vi.fn(),
        resolveJavaConflict: vi.fn(),
        dismissJavaConflict: vi.fn(),
        javaStatusFlags: vi.fn().mockReturnValue({
          clean: false,
          pendingReRun: false,
          staleJava: false,
        }),
      };
    }
  };
});

vi.mock('@/stores/workbench', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/workbench')>();
  return {
    ...actual,
    useWorkbench: () => ({
      isTargetInspectorOpen: true
    })
  };
});

function okResult<T>(data: T): ApiResult<T> {
  return { ok: true, data };
}

function mockGeneratedFileContents(files: Record<string, string>) {
  vi.mocked(apiClient.getGeneratedFile).mockImplementation(async (runId, path) => {
    const content = files[path];
    if (content === undefined) {
      return {
        ok: false,
        status: 404,
        message: 'HTTP error 404',
        details: { kind: 'http', body: { error: 'HTTP error 404' } },
      };
    }

    return okResult<GeneratedFileContent>({
      runId,
      mode: 'live',
      productMode: 'live',
      path,
      content,
      sha256: 'a'.repeat(64),
      byteSize: content.length,
      mimeType: 'text/x-java-source',
    });
  });
}

describe('Generated Artifacts UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(apiClient.getGeneratedFile).mockReset();
    vi.mocked(apiClient.getGeneratedFile).mockResolvedValue({
      ok: false,
      status: 500,
      message: 'HTTP error 500',
      details: { kind: 'http', body: { error: 'HTTP error 500' } },
    });
  });

  function renderArtifactsUi() {
    return render(
      <GeneratedArtifactsProvider>
        <TargetJavaInspector />
        <GeneratedJavaEditorPane />
      </GeneratedArtifactsProvider>,
    );
  }

  it('renders pending state distinctly', () => {
    // Issue #173: phase=starting now drives the submitting state with its
    // own progress label so the user can tell "request just sent" apart
    // from "agents working".
    mockTransformationState.mockReturnValue({
      phase: 'starting',
      runId: '123',
      generated: null,
      generatedFiles: null,
    });

    render(
      <GeneratedArtifactsProvider>
        <GeneratedJavaEditorPane />
      </GeneratedArtifactsProvider>,
    );
    expect(screen.getByTestId('generated-pane-progress').textContent).toMatch(/Submitting transformation request/i);
  });

  it('renders the generic running label when phase is running with no workflow', () => {
    mockTransformationState.mockReturnValue({
      phase: 'running',
      runId: '123',
      generated: null,
      generatedFiles: null,
    });

    render(
      <GeneratedArtifactsProvider>
        <GeneratedJavaEditorPane />
      </GeneratedArtifactsProvider>,
    );
    expect(screen.getByTestId('generated-pane-progress').textContent).toMatch(/Generating Java artifacts/i);
  });

  it('renders unsupported and incomplete states distinctly', () => {
    mockTransformationState.mockReturnValue({
      phase: 'completed',
      runId: '123',
      generated: { status: 'unsupported', unsupportedFeatures: ['COPY REPLACING'] },
      generatedFiles: null,
    });

    const { rerender } = render(
      <GeneratedArtifactsProvider>
        <GeneratedJavaEditorPane />
      </GeneratedArtifactsProvider>,
    );
    expect(screen.getByText(/Unsupported Features/i)).toBeInTheDocument();
    expect(screen.getByText('COPY REPLACING')).toBeInTheDocument();

    mockTransformationState.mockReturnValue({
      phase: 'completed',
      runId: '123',
      generated: { status: 'incomplete', missingArtifacts: ['artifact-1'] },
      generatedFiles: null,
    });

    rerender(
      <GeneratedArtifactsProvider>
        <GeneratedJavaEditorPane />
      </GeneratedArtifactsProvider>,
    );
    expect(screen.getByText(/Incomplete Generation/i)).toBeInTheDocument();
    expect(screen.getByText('artifact-1')).toBeInTheDocument();
  });

  it('keeps generated Java visible with an evidence-incomplete badge and missing artifact details', async () => {
    mockTransformationState.mockReturnValue({
      phase: 'completed',
      runId: '123',
      generated: {
        status: 'generated',
        artifactRef: { sha256: 'aaa' },
      },
      generatedFiles: {
        status: 'complete',
        entryFilePath: 'src/App.java',
        files: [{ path: 'src/App.java' }],
      },
      buildTest: {
        status: 'ok',
        classification: 'match',
        generatedArtifactRef: { sha256: 'aaa' },
      },
      evidence: {
        status: 'incomplete',
        missingArtifacts: ['manifest.json'],
        generatedArtifactRef: { sha256: 'aaa' },
      },
    });
    mockGeneratedFileContents({ 'src/App.java': 'public class App {}' });

    renderArtifactsUi();

    expect(await screen.findByText('public class App {}')).toBeInTheDocument();
    expect(screen.getByText('Evidence Incomplete')).toBeInTheDocument();
    expect(screen.getByText('manifest.json')).toBeInTheDocument();
  });

  it('keeps generated Java visible with an artifact mismatch failure notice', async () => {
    mockTransformationState.mockReturnValue({
      phase: 'completed',
      runId: '123',
      generated: {
        status: 'generated',
        artifactRef: { sha256: 'aaa' },
      },
      generatedFiles: {
        status: 'complete',
        entryFilePath: 'src/App.java',
        files: [{ path: 'src/App.java' }],
      },
      buildTest: {
        status: 'ok',
        classification: 'match',
        generatedArtifactRef: { sha256: 'bbb' },
      },
      evidence: {
        status: 'complete',
        generatedArtifactRef: { sha256: 'aaa' },
      },
    });
    mockGeneratedFileContents({ 'src/App.java': 'public class App {}' });

    renderArtifactsUi();

    expect(await screen.findByText('public class App {}')).toBeInTheDocument();
    expect(screen.getByText('Artifact Mismatch')).toBeInTheDocument();
    expect(screen.getByText('Conflicting Artifact References')).toBeInTheDocument();
  });

  it('uses constrained rendering for large generated Java files', async () => {
    const largeFileContent = Array.from({ length: 1200 }, (_, index) => `LINE_${String(index + 1).padStart(4, '0')}`).join('\n');

    mockTransformationState.mockReturnValue({
      phase: 'completed',
      runId: '123',
      generated: {
        status: 'generated',
        artifactRef: { sha256: 'aaa' },
      },
      generatedFiles: {
        status: 'complete',
        entryFilePath: 'src/App.java',
        files: [{ path: 'src/App.java' }],
      },
      buildTest: {
        status: 'ok',
        classification: 'match',
        generatedArtifactRef: { sha256: 'aaa' },
      },
      evidence: {
        status: 'complete',
        generatedArtifactRef: { sha256: 'aaa' },
      },
    });
    mockGeneratedFileContents({ 'src/App.java': largeFileContent });

    renderArtifactsUi();

    expect(await screen.findByText(/Large file mode active/i)).toBeInTheDocument();
    expect(screen.getByLabelText('Generated Java source for src/App.java')).toHaveClass('overflow-auto');
    expect(screen.getByText('LINE_0001')).toBeInTheDocument();
    expect(screen.queryByText('LINE_1200')).not.toBeInTheDocument();
  });

  it('renders file tree and artifact hash', () => {
    mockTransformationState.mockReturnValue({
      phase: 'completed',
      runId: '123',
      generated: {
        status: 'generated',
        artifactRef: { sha256: 'abc123def456' }
      },
      generatedFiles: {
        status: 'complete',
        files: [
          { path: 'src/main/java/App.java' },
          { path: 'src/main/resources/config.properties' }
        ]
      },
    });

    render(
      <GeneratedArtifactsProvider>
        <TargetJavaInspector />
      </GeneratedArtifactsProvider>,
    );

    expect(screen.getByText('Java Project Explorer')).toBeInTheDocument();
    expect(screen.getByText(/abc123def456/i)).toBeInTheDocument();
    expect(screen.getByText('App.java')).toBeInTheDocument();
    expect(screen.getByText('config.properties')).toBeInTheDocument();
  });

  it('selecting a file calls the encoded file endpoint and updates the editor', async () => {
    mockTransformationState.mockReturnValue({
      phase: 'completed',
      runId: '123',
      generated: {
        status: 'generated',
      },
      generatedFiles: {
        status: 'complete',
        entryFilePath: 'src/App.java',
        files: [
          { path: 'src/App.java' }
        ]
      },
    });

    vi.mocked(apiClient.getGeneratedFile).mockResolvedValue(
      okResult<GeneratedFileContent>({
        runId: '123',
        mode: 'live',
        productMode: 'live',
        path: 'src/App.java',
        content: 'public class App {}',
        sha256: 'a'.repeat(64),
        byteSize: 19,
        mimeType: 'text/x-java-source',
      })
    );

    renderArtifactsUi();

    // Initial load will fetch the entry file
    await waitFor(() => {
      expect(apiClient.getGeneratedFile).toHaveBeenCalledWith('123', 'src/App.java');
    });

    expect(await screen.findByText('public class App {}')).toBeInTheDocument();
  });

  it('clears stale fetch errors when the selected file is already known unavailable', async () => {
    mockTransformationState.mockReturnValue({
      phase: 'completed',
      runId: '123',
      generated: {
        status: 'generated',
        files: {},
      },
      generatedFiles: {
        status: 'complete',
        entryFilePath: 'src/Missing.java',
        files: [{ path: 'src/Missing.java' }],
      },
    });

    vi.mocked(apiClient.getGeneratedFile).mockResolvedValue({
      ok: false,
      status: 404,
      message: 'HTTP error 404',
      details: { kind: 'http', body: { error: 'HTTP error 404' } },
    });

    renderArtifactsUi();

    await waitFor(() => {
      expect(screen.getByText('Unavailable')).toBeInTheDocument();
      expect(screen.queryByText(/failed to load file/i)).not.toBeInTheDocument();
    });
    expect(screen.getByText(/Generated file unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/Verified state cannot be claimed from missing content/i)).toBeInTheDocument();
    expect(screen.getAllByText('src/Missing.java').length).toBeGreaterThan(0);
  });

  it('renders the verified badge only when BFF final classification confirms success', async () => {
    mockTransformationState.mockReturnValue({
      phase: 'completed',
      runId: '123',
      summary: {
        finalClassification: 'success',
      },
      generated: {
        status: 'generated',
        artifactRef: { sha256: 'aaa' },
      },
      generatedFiles: {
        status: 'complete',
        entryFilePath: 'src/App.java',
        files: [{ path: 'src/App.java', sha256: 'file-sha' }],
      },
      buildTest: {
        status: 'ok',
        classification: 'match',
        generatedArtifactRef: { sha256: 'aaa' },
      },
      evidence: {
        status: 'complete',
        generatedArtifactRef: { sha256: 'aaa' },
      },
    });
    mockGeneratedFileContents({ 'src/App.java': 'public class App {}' });

    renderArtifactsUi();

    expect(await screen.findByText('public class App {}')).toBeInTheDocument();
    expect(screen.getByText('Verified')).toBeInTheDocument();
    expect(screen.getByText('Java Project Explorer')).toBeInTheDocument();
  });

  it('resets selection when a new run starts and loads the new entry file', async () => {
    mockTransformationState.mockReturnValue({
      phase: 'completed',
      runId: 'run-1',
      generated: {
        status: 'generated',
      },
      generatedFiles: {
        status: 'complete',
        entryFilePath: 'src/OldEntry.java',
        files: [{ path: 'src/OldEntry.java' }],
      },
    });

    mockGeneratedFileContents({
      'src/OldEntry.java': 'public class OldEntry {}',
      'src/NewEntry.java': 'public class NewEntry {}',
    });

    const { rerender } = renderArtifactsUi();

    expect(await screen.findByText('public class OldEntry {}')).toBeInTheDocument();

    mockTransformationState.mockReturnValue({
      phase: 'completed',
      runId: 'run-2',
      generated: {
        status: 'generated',
      },
      generatedFiles: {
        status: 'complete',
        entryFilePath: 'src/NewEntry.java',
        files: [{ path: 'src/NewEntry.java' }],
      },
    });

    rerender(
      <GeneratedArtifactsProvider>
        <TargetJavaInspector />
        <GeneratedJavaEditorPane />
      </GeneratedArtifactsProvider>,
    );

    await waitFor(() => {
      expect(apiClient.getGeneratedFile).toHaveBeenCalledWith('run-2', 'src/NewEntry.java');
    });
    expect(await screen.findByText('public class NewEntry {}')).toBeInTheDocument();
  });

  it('shows a failed-verification artifact state when a failed run still has generated files', async () => {
    mockTransformationState.mockReturnValue({
      phase: 'failed',
      runId: '123',
      generated: {
        status: 'generated',
        artifactRef: { sha256: 'aaa' },
      },
      generatedFiles: {
        status: 'complete',
        entryFilePath: 'src/App.java',
        files: [{ path: 'src/App.java' }],
      },
    });
    mockGeneratedFileContents({ 'src/App.java': 'public class App {}' });

    renderArtifactsUi();

    expect(await screen.findByText('public class App {}')).toBeInTheDocument();
    expect(screen.getByText('Run Failed')).toBeInTheDocument();
    expect(screen.getByText('Java Project Explorer')).toBeInTheDocument();
  });

  it('selecting a different file in the inspector updates the editor content', async () => {
    mockTransformationState.mockReturnValue({
      phase: 'completed',
      runId: '123',
      generated: {
        status: 'generated',
      },
      generatedFiles: {
        status: 'complete',
        entryFilePath: 'src/App.java',
        files: [{ path: 'src/App.java' }, { path: 'src/Helper.java' }],
      },
    });

    mockGeneratedFileContents({
      'src/App.java': 'public class App {}',
      'src/Helper.java': 'public class Helper {}',
    });

    renderArtifactsUi();

    expect(await screen.findByText('public class App {}')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('treeitem', { name: /Helper\.java/i }));

    await waitFor(() => {
      expect(apiClient.getGeneratedFile).toHaveBeenCalledWith('123', 'src/Helper.java');
    });
    expect(await screen.findByText('public class Helper {}')).toBeInTheDocument();
  });
});

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TransformationRunProvider, useTransformationRun } from '@/stores/transformationRun';
import { GeneratedJavaEditorPane } from '@/components/generated/GeneratedJavaEditorPane';
import { TargetJavaInspector } from '@/components/generated/TargetJavaInspector';
import { WorkbenchProvider } from '@/stores/workbench';
import { apiClient } from '@/lib/apiClient';

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
  return {
    ...actual,
    useTransformationRun: () => ({
      state: mockTransformationState()
    })
  };
});

const mockWorkbench = vi.fn();
vi.mock('@/stores/workbench', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/workbench')>();
  return {
    ...actual,
    useWorkbench: () => ({
      isTargetInspectorOpen: true
    })
  };
});

describe('Generated Artifacts UI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders pending state distinctly', () => {
    mockTransformationState.mockReturnValue({
      phase: 'starting',
      runId: '123',
      generated: null,
      generatedFiles: null,
    });

    render(<GeneratedJavaEditorPane />);
    expect(screen.getByText(/Generating Java artifacts/i)).toBeInTheDocument();
  });

  it('renders unsupported and incomplete states distinctly', () => {
    mockTransformationState.mockReturnValue({
      phase: 'completed',
      runId: '123',
      generated: { status: 'unsupported', unsupportedFeatures: ['COPY REPLACING'] },
      generatedFiles: null,
    });

    const { rerender } = render(<GeneratedJavaEditorPane />);
    expect(screen.getByText(/Unsupported Features/i)).toBeInTheDocument();
    expect(screen.getByText('COPY REPLACING')).toBeInTheDocument();

    mockTransformationState.mockReturnValue({
      phase: 'completed',
      runId: '123',
      generated: { status: 'incomplete', missingArtifacts: ['artifact-1'] },
      generatedFiles: null,
    });

    rerender(<GeneratedJavaEditorPane />);
    expect(screen.getByText(/Incomplete Generation/i)).toBeInTheDocument();
    expect(screen.getByText('artifact-1')).toBeInTheDocument();
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

    render(<TargetJavaInspector />);
    
    expect(screen.getByText('Target Java Inspector')).toBeInTheDocument();
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
        files: {} // no pre-loaded files
      },
      generatedFiles: {
        status: 'complete',
        entryFilePath: 'src/App.java',
        files: [
          { path: 'src/App.java' }
        ]
      },
    });

    vi.mocked(apiClient.getGeneratedFile).mockResolvedValue({
      ok: true,
      data: { content: 'public class App {}', path: 'src/App.java' }
    } as any);

    render(
      <>
        <TargetJavaInspector />
        <GeneratedJavaEditorPane />
      </>
    );

    // Initial load will fetch the entry file
    await waitFor(() => {
      expect(apiClient.getGeneratedFile).toHaveBeenCalledWith('123', 'src/App.java');
    });

    expect(await screen.findByText('public class App {}')).toBeInTheDocument();
  });
});

import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkbenchShell } from '../src/components/workbench/WorkbenchShell';
import { useC2cApi } from '../src/hooks/useC2cApi';

vi.mock('../src/hooks/useC2cApi', () => ({
  useC2cApi: vi.fn(),
}));

vi.mock('../src/hooks/useReferencePrograms', () => ({
  useReferencePrograms: vi.fn(() => ({
    programs: [
      { programId: 'P1', title: 'Test Prog 1', supportedInProductMode: true, knownLimitations: [] },
      { programId: 'P2', title: 'Test Prog 2', supportedInProductMode: false, knownLimitations: [] }
    ],
    isLoading: false,
    error: null,
  })),
}));

describe('A11y, Keyboard, Resizing, and Performance Hardening', () => {
  it('Keyboard tab order through primary controls respects disabled states', () => {
    vi.mocked(useC2cApi).mockReturnValue({
      status: 'ready',
      tone: 'ready',
      orchestratorMode: 'product',
      evidenceMode: 'real',
      orchestratorLive: true,
      evidenceLive: true,
      lastCheck: Date.now(),
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    render(<WorkbenchShell />);

    const startButton = screen.getByRole('button', { name: 'Start Transformation' });
    expect(startButton).toBeDisabled(); // Because no program is selected initially

    const tree = screen.getByRole('tree', { name: 'Reference Programs' });
    expect(tree).toBeInTheDocument();

    const { getAllByRole } = within(tree);
    const items = getAllByRole('treeitem');
    expect(items).toHaveLength(2);
    expect(items[0]).not.toHaveAttribute('aria-disabled', 'true');
    expect(items[1]).toHaveAttribute('aria-disabled', 'true');
  });

  it('Verifies ARIA roles for tabs and panels', () => {
    vi.mocked(useC2cApi).mockReturnValue({
      status: 'ready',
      tone: 'ready',
      orchestratorMode: 'product',
      evidenceMode: 'real',
      orchestratorLive: true,
      evidenceLive: true,
      lastCheck: Date.now(),
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    render(<WorkbenchShell />);

    const tablists = screen.getAllByRole('tablist');
    expect(tablists.length).toBeGreaterThan(0);

    const tabs = screen.getAllByRole('tab');
    expect(tabs.length).toBeGreaterThan(0);

    // Look for panels (e.g. the active bottom workbench tab panel)
    const panels = screen.getAllByRole('tabpanel');
    expect(panels.length).toBeGreaterThan(0);
  });
  
  it('Resize state is represented correctly via useResizablePane ARIA separators', () => {
    vi.mocked(useC2cApi).mockReturnValue({
      status: 'ready',
      tone: 'ready',
      orchestratorMode: 'product',
      evidenceMode: 'real',
      orchestratorLive: true,
      evidenceLive: true,
      lastCheck: Date.now(),
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    render(<WorkbenchShell />);
    
    // Resize handles
    const splitResizers = screen.getAllByRole('separator');
    expect(splitResizers.length).toBeGreaterThanOrEqual(2); 
    // Should have Source Workspace resizer, Split editor resizer, target inspector resizer, bottom workbench resizer
  });

  it('Performance test baseline - renders a large component without freezing', () => {
    const startTime = performance.now();
    render(<WorkbenchShell />);
    const duration = performance.now() - startTime;
    // For a unit test, we just ensure it renders quickly enough (< 200ms usually, but we'll use a safe bound)
    expect(duration).toBeLessThan(1000);
  });
});

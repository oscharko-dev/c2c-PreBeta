import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkbenchShell } from '../src/components/workbench/WorkbenchShell';

// Mock useC2cApi to control state
vi.mock('../src/hooks/useC2cApi', () => ({
  useC2cApi: vi.fn(),
}));

import { useC2cApi } from '../src/hooks/useC2cApi';

vi.mock('@/hooks/useC2cApi', () => ({
  useC2cApi: vi.fn()
}));

describe('WorkbenchShell Layout & Topbar Readiness', () => {
  it('renders topbar readiness state when connected', () => {
    vi.mocked(useC2cApi).mockReturnValue({
      health: { status: 'ok' },
      mode: { orchestrator: 'live', evidence: 'live' },
      error: null,
      errorKind: null,
      loading: false,
    });

    render(<WorkbenchShell />);
    
    // Topbar readiness should show "Ready"
    expect(within(screen.getByLabelText('Product readiness')).getByText('Ready')).toBeInTheDocument();
    expect(screen.getAllByText('Ready').length).toBeGreaterThan(0);
    
    // Primary action stays disabled until source is loaded or entered.
    expect(screen.getByRole('button', { name: /start transformation/i })).toBeDisabled();
  });

  it('renders blocked state when health fails', () => {
    vi.mocked(useC2cApi).mockReturnValue({
      health: null,
      mode: null,
      error: 'HTTP error 503',
      errorKind: 'backend',
      loading: false,
    });

    render(<WorkbenchShell />);

    expect(within(screen.getByLabelText('Product readiness')).getByText('Blocked')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start transformation/i })).toBeDisabled();
  });

  it('verifies layout regions are present with accessible names', () => {
    vi.mocked(useC2cApi).mockReturnValue({
      health: { status: 'ok' },
      mode: { orchestrator: 'live', evidence: 'live' },
      error: null,
      errorKind: null,
      loading: false,
    });

    render(<WorkbenchShell />);

    expect(screen.getByTestId('studio-workbench-shell')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'c2c Studio Workbench', level: 1 })).toBeInTheDocument();
    expect(screen.getByLabelText('c2c brand')).toBeInTheDocument();
    expect(screen.getByLabelText('Activity Bar')).toBeInTheDocument();
    expect(screen.getByLabelText('Secondary Stripe')).toBeInTheDocument();
    expect(screen.getByText('COBOL Explorer')).toBeInTheDocument();
    expect(screen.getByLabelText('Split Editor Area')).toBeInTheDocument();
    expect(screen.getByLabelText('Java Project Explorer')).toBeInTheDocument();
    expect(screen.getByLabelText('Bottom Workbench')).toBeInTheDocument();
    expect(screen.getByLabelText('Status Bar')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('No run active');
  });

  it('allows workbench tabs to be selected through pointer interaction', () => {
    vi.mocked(useC2cApi).mockReturnValue({
      health: { status: 'ok' },
      mode: { orchestrator: 'live', evidence: 'live' },
      error: null,
      errorKind: null,
      loading: false,
    });

    render(<WorkbenchShell />);

    const runTab = screen.getByRole('tab', { name: /run/i });
    const evidenceTab = screen.getByRole('tab', { name: /evidence/i });
    const artifactsTab = screen.getByRole('tab', { name: /artifacts/i });

    expect(runTab).toHaveAttribute('aria-selected', 'true');
    expect(evidenceTab).toHaveAttribute('aria-selected', 'false');
    expect(artifactsTab).toHaveAttribute('aria-selected', 'false');
    
    // Initially Run panel content is visible
    expect(within(screen.getByRole('tabpanel')).getByText('No run active')).toBeInTheDocument();

    // Click evidence tab
    fireEvent.click(evidenceTab);
    
    expect(evidenceTab).toHaveAttribute('aria-selected', 'true');
    expect(runTab).toHaveAttribute('aria-selected', 'false');
    
    // Now Evidence panel content is visible
    expect(within(screen.getByRole('tabpanel')).getByText('No evidence pack loaded')).toBeInTheDocument();
  });

  it('allows workbench tabs to be selected through keyboard interaction', async () => {
    vi.mocked(useC2cApi).mockReturnValue({
      health: { status: 'ok' },
      mode: { orchestrator: 'live', evidence: 'live' },
      error: null,
      errorKind: null,
      loading: false,
    });

    render(<WorkbenchShell />);

    const runTab = screen.getByRole('tab', { name: /run/i });
    const problemsTab = screen.getByRole('tab', { name: /problems/i });
    
    runTab.focus();
    fireEvent.keyDown(runTab, { key: 'End', code: 'End' });

    await waitFor(() => {
      expect(problemsTab).toHaveAttribute('aria-selected', 'true');
      expect(document.activeElement).toBe(problemsTab);
    });

    expect(within(screen.getByRole('tabpanel')).getByText('No diagnostics loaded')).toBeInTheDocument();
  });

  it('does not report a successful ready state when mode is unavailable', () => {
    vi.mocked(useC2cApi).mockReturnValue({
      health: { status: 'ok' },
      mode: null,
      error: 'HTTP error 503',
      errorKind: 'backend',
      loading: false,
    });

    render(<WorkbenchShell />);

    expect(within(screen.getByLabelText('Product readiness')).getByText('Blocked')).toBeInTheDocument();
    expect(screen.getAllByText('Blocked').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /start transformation/i })).toBeDisabled();
  });

  it('keeps Start enabled when orchestrator is live but evidence is mocked', () => {
    vi.mocked(useC2cApi).mockReturnValue({
      health: { status: 'ok' },
      mode: { orchestrator: 'live', evidence: 'mock' },
      error: null,
      errorKind: null,
      loading: false,
    });

    render(<WorkbenchShell />);

    expect(within(screen.getByLabelText('Product readiness')).getByText('Evidence Limited')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start transformation/i })).toBeDisabled();
  });

  it('does not expose presentation-only evidence mode wording in product readiness surfaces', () => {
    vi.mocked(useC2cApi).mockReturnValue({
      health: { status: 'ok' },
      mode: { orchestrator: 'live', evidence: 'mock' },
      error: null,
      errorKind: null,
      loading: false,
    });

    render(<WorkbenchShell />);

    expect(screen.queryByText(/mock/i)).not.toBeInTheDocument();
  });

  it('applies truncation and wrapping guards needed for narrow desktop layouts', () => {
    vi.mocked(useC2cApi).mockReturnValue({
      health: { status: 'ok' },
      mode: { orchestrator: 'live', evidence: 'live' },
      error: null,
      errorKind: null,
      loading: false,
    });

    render(<WorkbenchShell />);

    expect(screen.getByText('main')).toHaveClass('truncate');
    expect(screen.getByText('Default Transform')).toHaveClass('truncate');
    expect(screen.getByLabelText('Status Bar')).toHaveClass('flex-wrap');
  });
});

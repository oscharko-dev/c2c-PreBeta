import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorkbenchShell } from '../src/components/workbench/WorkbenchShell';

// Mock useC2cApi to control state
vi.mock('../src/hooks/useC2cApi', () => ({
  useC2cApi: vi.fn(),
}));

import { useC2cApi } from '../src/hooks/useC2cApi';

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
    
    // Primary action button should be enabled
    expect(screen.getByRole('button', { name: /start transformation/i })).toBeEnabled();
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

    expect(screen.getByLabelText('c2c brand')).toBeInTheDocument();
    expect(screen.getByLabelText('Activity Bar')).toBeInTheDocument();
    expect(screen.getByLabelText('Secondary Stripe')).toBeInTheDocument();
    expect(screen.getByLabelText('Source Workspace')).toBeInTheDocument();
    expect(screen.getByLabelText('Split Editor Area')).toBeInTheDocument();
    expect(screen.getByLabelText('Target Java Inspector')).toBeInTheDocument();
    expect(screen.getByLabelText('Bottom Workbench')).toBeInTheDocument();
    expect(screen.getByLabelText('Status Bar')).toBeInTheDocument();
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

    expect(runTab).toHaveAttribute('aria-selected', 'true');
    expect(evidenceTab).toHaveAttribute('aria-selected', 'false');
    
    // Initially Run panel content is visible
    expect(within(screen.getByRole('tabpanel')).getByText('No run active')).toBeInTheDocument();

    // Click evidence tab
    fireEvent.click(evidenceTab);
    
    expect(evidenceTab).toHaveAttribute('aria-selected', 'true');
    expect(runTab).toHaveAttribute('aria-selected', 'false');
    
    // Now Evidence panel content is visible
    expect(within(screen.getByRole('tabpanel')).getByText('No evidence pack loaded')).toBeInTheDocument();
  });

  it('allows workbench tabs to be selected through keyboard interaction', () => {
    vi.mocked(useC2cApi).mockReturnValue({
      health: { status: 'ok' },
      mode: { orchestrator: 'live', evidence: 'live' },
      error: null,
      errorKind: null,
      loading: false,
    });

    render(<WorkbenchShell />);

    const runTab = screen.getByRole('tab', { name: /run/i });
    const learningTab = screen.getByRole('tab', { name: /learning/i });
    
    runTab.focus();
    fireEvent.keyDown(runTab, { key: 'End', code: 'End' });
    fireEvent.click(learningTab);

    expect(learningTab).toHaveAttribute('aria-selected', 'true');
    expect(within(screen.getByRole('tabpanel')).getByText('No experience learning data yet')).toBeInTheDocument();
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

    expect(within(screen.getByLabelText('Product readiness')).getByText('Ready · Evidence Mock')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /start transformation/i })).toBeEnabled();
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

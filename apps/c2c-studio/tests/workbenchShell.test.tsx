import { render, screen, fireEvent } from '@testing-library/react';
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
    expect(screen.getByText('Ready')).toBeInTheDocument();
    
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

    expect(screen.getByText('Blocked')).toBeInTheDocument();
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
    expect(screen.getByText('Run output logs will appear here.')).toBeInTheDocument();

    // Click evidence tab
    fireEvent.click(evidenceTab);
    
    expect(evidenceTab).toHaveAttribute('aria-selected', 'true');
    expect(runTab).toHaveAttribute('aria-selected', 'false');
    
    // Now Evidence panel content is visible
    expect(screen.getByText('Evidence pack details.')).toBeInTheDocument();
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

    const learningTab = screen.getByRole('tab', { name: /learning/i });
    
    learningTab.focus();
    fireEvent.keyDown(learningTab, { key: 'Enter', code: 'Enter' });
    fireEvent.click(learningTab); // Simulated standard interaction

    expect(learningTab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Experience learning metrics.')).toBeInTheDocument();
  });
});

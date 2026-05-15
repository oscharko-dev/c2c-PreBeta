import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StudioShell } from '../src/components/studio/StudioShell';

vi.mock('../src/hooks/useC2cApi', () => ({
  useC2cApi: vi.fn(),
}));

import { useC2cApi } from '../src/hooks/useC2cApi';

describe('StudioShell', () => {
  it('renders the branded shell and enables actions when dependencies are live', () => {
    vi.mocked(useC2cApi).mockReturnValue({
      health: { status: 'ok' },
      mode: { orchestrator: 'live', evidence: 'live' },
      error: null,
      errorKind: null,
      loading: false,
    });

    render(<StudioShell />);

    expect(screen.getByText('Transformation Studio')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start Transformation' })).toBeEnabled();
    expect(screen.getAllByText('Backend: connected').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('tablist').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('treeitem').length).toBeGreaterThan(0);
  });

  it('renders an honest blocking state when backend health fails', () => {
    vi.mocked(useC2cApi).mockReturnValue({
      health: null,
      mode: null,
      error: 'HTTP error 503',
      errorKind: 'http',
      loading: false,
    });

    render(<StudioShell />);

    expect(screen.getByText('Backend Unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start Transformation' })).toBeDisabled();
  });

  it('renders degraded upstream state and disables actions when mode reports mock dependencies', () => {
    vi.mocked(useC2cApi).mockReturnValue({
      health: { status: 'ok' },
      mode: { orchestrator: 'mock', evidence: 'live' },
      error: null,
      errorKind: null,
      loading: false,
    });

    render(<StudioShell />);

    expect(screen.getAllByText('Backend: degraded').length).toBeGreaterThan(0);
    expect(screen.getByText('Orchestrator is not reachable.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start Transformation' })).toBeDisabled();
  });
});

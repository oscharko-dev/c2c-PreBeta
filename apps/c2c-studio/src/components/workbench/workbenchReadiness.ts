import type { StudioApiState } from '../../hooks/useC2cApi';

export interface WorkbenchReadiness {
  startEnabled: boolean;
  topBarLabel: string;
  statusBarLabel: string;
  tone: 'loading' | 'ready' | 'warning' | 'blocked';
}

export function getWorkbenchReadiness(apiState: StudioApiState): WorkbenchReadiness {
  const { health, mode, error, loading } = apiState;

  if (loading) {
    return {
      startEnabled: false,
      topBarLabel: 'Loading...',
      statusBarLabel: 'Loading backend state...',
      tone: 'loading',
    };
  }

  if (error || health?.status !== 'ok' || !mode || mode.orchestrator !== 'live') {
    return {
      startEnabled: false,
      topBarLabel: 'Blocked',
      statusBarLabel: 'Blocked',
      tone: 'blocked',
    };
  }

  if (mode.evidence !== 'live') {
    return {
      startEnabled: true,
      topBarLabel: 'Ready · Evidence Mock',
      statusBarLabel: 'Ready · Evidence Mock',
      tone: 'warning',
    };
  }

  return {
    startEnabled: true,
    topBarLabel: 'Ready',
    statusBarLabel: 'Ready',
    tone: 'ready',
  };
}

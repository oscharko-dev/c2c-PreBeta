'use client';

import { type StudioApiState } from '../../hooks/useC2cApi';
import { useTransformationRun } from '../../stores/transformationRun';
import { getWorkbenchReadiness } from './workbenchReadiness';

interface StatusBarProps {
  apiState: StudioApiState;
}

export function StatusBar({ apiState }: StatusBarProps) {
  const { error, loading } = apiState;
  const readiness = getWorkbenchReadiness(apiState);
  const { state } = useTransformationRun();

  const runLabel =
    state.phase === 'idle'
      ? 'No run active'
      : state.phase === 'starting'
        ? 'Transformation requested'
        : state.phase === 'running'
          ? `Run active${state.programId ? ` · ${state.programId}` : ''}`
          : state.phase === 'completed'
            ? 'Run verified'
            : state.phase === 'verification-blocked'
              ? 'Verification blocked'
              : state.phase === 'incomplete'
                ? 'Run incomplete'
                : state.phase === 'failed'
                  ? 'Run failed'
                  : 'Backend unavailable';

  return (
    <div className="flex min-h-6 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-line bg-accent-dim px-3 py-1 text-xs text-text-bright shrink-0" aria-label="Status Bar">
      <div className="flex min-w-0 items-center gap-4">
        <span>c2c Studio</span>
        <span className="opacity-75">{runLabel}</span>
      </div>
      <div className="flex min-w-0 items-center gap-4">
        <span className="opacity-75">Ln 1, Col 1</span>
        <span>UTF-8</span>
        {readiness.tone === 'loading' ? (
          <span className="opacity-75">{readiness.statusBarLabel}</span>
        ) : readiness.tone === 'ready' ? (
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-success"></span> Ready</span>
        ) : readiness.tone === 'warning' ? (
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-warn"></span> {readiness.statusBarLabel}</span>
        ) : (
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-error"></span> Blocked</span>
        )}
        {!loading && error ? (
          <span className="truncate opacity-75">{error}</span>
        ) : null}
      </div>
    </div>
  );
}

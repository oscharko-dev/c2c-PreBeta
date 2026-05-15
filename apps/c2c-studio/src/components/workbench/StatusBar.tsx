'use client';

import { type StudioApiState } from '../../hooks/useC2cApi';
import { getWorkbenchReadiness } from './workbenchReadiness';

interface StatusBarProps {
  apiState: StudioApiState;
}

export function StatusBar({ apiState }: StatusBarProps) {
  const { error, loading } = apiState;
  const readiness = getWorkbenchReadiness(apiState);

  return (
    <div className="flex min-h-6 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-line bg-accent-dim px-3 py-1 text-xs text-text-bright shrink-0" aria-label="Status Bar">
      <div className="flex min-w-0 items-center gap-4">
        <span>c2c Studio</span>
        <span className="opacity-75">No run active</span>
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

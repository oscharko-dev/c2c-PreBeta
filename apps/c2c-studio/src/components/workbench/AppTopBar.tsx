'use client';

import { Play, Settings, Search, CheckCircle2, AlertCircle } from 'lucide-react';
import { useC2cApi } from '../../hooks/useC2cApi';

export function AppTopBar() {
  const { health, mode, error, loading } = useC2cApi();

  const isReady = health?.status === 'ok' && mode?.orchestrator === 'live' && mode?.evidence === 'live' && !error;

  return (
    <div className="flex h-12 w-full items-center justify-between border-b border-line bg-bg-1 px-4 py-2 shrink-0">
      <div className="flex items-center gap-4">
        <span className="text-sm font-bold text-accent uppercase tracking-wider" aria-label="c2c brand">c2c</span>
        <div className="h-4 w-px bg-line-2"></div>
        <div className="flex items-center gap-2 text-sm text-text-dim">
          <span className="font-medium text-text">Workspace</span>
          <span className="text-text-faint">/</span>
          <span>main</span>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1 rounded bg-bg-2 px-2 py-1 border border-line-2">
          <span className="text-xs text-text-dim">Run Config:</span>
          <span className="text-xs font-medium text-text">Default Transform</span>
        </div>
        <button
          disabled={!isReady || loading}
          className="flex items-center justify-center rounded bg-teal hover:bg-teal-soft active:bg-teal disabled:opacity-50 disabled:cursor-not-allowed p-1.5"
          aria-label="Start Transformation"
        >
          <Play className="h-4 w-4 text-bg-0 fill-current" />
        </button>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 text-xs" aria-label="Product readiness">
          {loading ? (
             <span className="text-text-dim">Loading...</span>
          ) : isReady ? (
            <div className="flex items-center gap-1 text-success">
              <CheckCircle2 className="h-4 w-4" />
              <span>Ready</span>
            </div>
          ) : (
            <div className="flex items-center gap-1 text-error">
              <AlertCircle className="h-4 w-4" />
              <span>Blocked</span>
            </div>
          )}
        </div>
        <div className="h-4 w-px bg-line-2"></div>
        <button className="text-text-dim hover:text-text p-1"><Search className="h-4 w-4" /></button>
        <button className="text-text-dim hover:text-text p-1"><Settings className="h-4 w-4" /></button>
      </div>
    </div>
  );
}

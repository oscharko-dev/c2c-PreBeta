'use client';

import { Play, Settings, Search, CheckCircle2, AlertCircle } from 'lucide-react';
import { type StudioApiState } from '../../hooks/useC2cApi';
import { getWorkbenchReadiness } from './workbenchReadiness';
import { useSourceWorkspace } from '../../stores/sourceWorkspace';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';

interface AppTopBarProps {
  apiState: StudioApiState;
}

export function AppTopBar({ apiState }: AppTopBarProps) {
  const { loading } = apiState;
  const readiness = getWorkbenchReadiness(apiState);
  const { canSubmitTransform, submitTransform } = useSourceWorkspace();
  const canStart = readiness.startEnabled && !loading && canSubmitTransform;

  useKeyboardShortcuts({
    onStartTransform: () => {
      void submitTransform();
    },
    canStartTransform: canStart,
  });

  return (
    <header className="flex min-h-12 w-full flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line bg-bg-1 px-4 py-2 shrink-0" aria-label="Workbench Top Bar">
      <div className="flex min-w-0 items-center gap-4">
        <span className="text-sm font-bold text-accent uppercase tracking-wider" aria-label="c2c brand">c2c</span>
        <div className="h-4 w-px bg-line-2"></div>
        <div className="flex min-w-0 items-center gap-2 text-sm text-text-dim">
          <span className="font-medium text-text">Workspace</span>
          <span className="text-text-faint">/</span>
          <span className="truncate">main</span>
        </div>
      </div>

      <div className="flex min-w-0 items-center gap-2">
        <div className="flex min-w-0 items-center gap-1 rounded border border-line-2 bg-bg-2 px-2 py-1">
          <span className="text-xs text-text-dim">Run Config:</span>
          <span className="truncate text-xs font-medium text-text">Default Transform</span>
        </div>
        <button
          type="button"
          disabled={!canStart}
          className="flex items-center justify-center rounded bg-teal hover:bg-teal-soft active:bg-teal disabled:opacity-50 disabled:cursor-not-allowed p-1.5 focus-visible:ring-1 focus-visible:ring-accent outline-none"
          aria-label="Start Transformation"
          title="Start Transformation (Cmd/Ctrl + Enter)"
          onClick={() => {
            void submitTransform();
          }}
        >
          <Play className="h-4 w-4 text-bg-0 fill-current" />
        </button>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 text-xs" aria-label="Product readiness">
          {readiness.tone === 'loading' ? (
             <span className="text-text-dim">{readiness.topBarLabel}</span>
          ) : readiness.tone === 'ready' ? (
            <div className="flex items-center gap-1 text-success">
              <CheckCircle2 className="h-4 w-4" />
              <span>{readiness.topBarLabel}</span>
            </div>
          ) : readiness.tone === 'warning' ? (
            <div className="flex items-center gap-1 text-warn">
              <AlertCircle className="h-4 w-4" />
              <span>{readiness.topBarLabel}</span>
            </div>
          ) : (
            <div className="flex items-center gap-1 text-error">
              <AlertCircle className="h-4 w-4" />
              <span>{readiness.topBarLabel}</span>
            </div>
          )}
        </div>
        <div className="h-4 w-px bg-line-2"></div>
        <button type="button" className="p-1 text-text-dim hover:text-text focus-visible:ring-1 focus-visible:ring-accent outline-none rounded" aria-label="Search workspace">
          <Search className="h-4 w-4" />
        </button>
        <button type="button" className="p-1 text-text-dim hover:text-text focus-visible:ring-1 focus-visible:ring-accent outline-none rounded" aria-label="Open studio settings">
          <Settings className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}

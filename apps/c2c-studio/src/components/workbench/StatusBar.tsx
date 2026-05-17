'use client';

import { type StudioApiState } from '../../hooks/useC2cApi';
import { useTransformationRun } from '../../stores/transformationRun';
import { getWorkbenchReadiness } from './workbenchReadiness';
import { ProductState } from '../../types/state';
import { ACTIVE_AGENT_LABELS, W02_ERROR_LABELS } from '../run/agentActivity';

interface StatusBarProps {
  apiState: StudioApiState;
}

// Issue #173: status-bar label is derived from the BFF-classified product
// state so the user sees "Awaiting transformation agent" / "Repairing" /
// "Run verified" rather than only "Run active".
function runLabelFromProductState(productState: ProductState, programId: string | null): string {
  switch (productState) {
    case 'empty':
      return 'No run active';
    case 'submitting':
      return 'Transformation requested';
    case 'running':
      return `Run active${programId ? ` · ${programId}` : ''}`;
    case 'awaiting-agent':
      return `Awaiting ${ACTIVE_AGENT_LABELS.transformation_agent}`;
    case 'repairing':
      return 'Repair attempt in progress';
    case 'verifying':
      return 'Verifying generated Java';
    case 'success':
      return 'Run verified';
    case 'blocked':
      return 'Run blocked';
    case 'cancelled':
      return 'Run cancelled';
    case 'generated-pending':
      return 'Generated Java pending';
    case 'generated-incomplete':
      return 'Generated artifacts incomplete';
    case 'build-failed':
      return 'Build / test failed';
    case 'equivalence-mismatch':
      return 'Equivalence mismatch';
    case 'evidence-incomplete':
      return 'Evidence incomplete';
    case 'hash-mismatch':
      return 'Artifact hash mismatch';
    case 'unsupported':
      return 'Unsupported COBOL';
    case 'validation-error':
      return 'Request rejected';
    case 'failed':
      return 'Run failed';
    case 'backend-unavailable':
    case 'upstream-unavailable':
      return 'Backend unavailable';
    case 'stale-ignored':
      return 'Stale result ignored';
  }
}

export function StatusBar({ apiState }: StatusBarProps) {
  const { error, loading } = apiState;
  const readiness = getWorkbenchReadiness(apiState);
  const { state, productState } = useTransformationRun();

  const runLabel = runLabelFromProductState(productState.state, state.programId);
  const isSuccess = productState.state === 'success';
  const failureCode = productState.failureCode;

  return (
    <footer className="flex min-h-6 flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-line bg-accent-dim px-3 py-1 text-xs text-text-bright shrink-0" aria-label="Status Bar">
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {runLabel}
        {failureCode ? `. Failure code: ${W02_ERROR_LABELS[failureCode]}.` : ''}
        {readiness.statusBarLabel ? ` ${readiness.statusBarLabel}.` : ''}
      </span>
      <div className="flex min-w-0 items-center gap-4">
        <span>c2c Studio</span>
        <span data-testid="status-bar-run-label">
          {runLabel}
        </span>
        {isSuccess ? (
          <span
            className="inline-flex items-center gap-1 rounded bg-success px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-bright"
            data-testid="status-bar-success-badge"
          >
            ✓ Verified
          </span>
        ) : null}
        {failureCode ? (
          <span
            className="inline-flex items-center gap-1 rounded bg-error px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-text-bright"
            data-testid="status-bar-failure-code"
            title={W02_ERROR_LABELS[failureCode]}
          >
            {failureCode}
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 items-center gap-4">
        <span>Ln 1, Col 1</span>
        <span>UTF-8</span>
        {readiness.tone === 'loading' ? (
          <span>{readiness.statusBarLabel}</span>
        ) : readiness.tone === 'ready' ? (
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-success"></span> Ready</span>
        ) : readiness.tone === 'warning' ? (
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-warn"></span> {readiness.statusBarLabel}</span>
        ) : (
          <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-error"></span> Blocked</span>
        )}
        {!loading && error ? (
          <span className="truncate">{error}</span>
        ) : null}
      </div>
    </footer>
  );
}

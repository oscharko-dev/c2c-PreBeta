'use client';
import { useTransformationRun } from '../../stores/transformationRun';
import { StatusChip } from '../ui/StatusChip';
import { deriveRunProblems } from './runPanelUtils';

export function ProblemsPanel({ emptyState }: { emptyState: { title: string; message: string } }) {
  const { state } = useTransformationRun();

  if (state.phase === 'idle') {
    return (
      <div className="p-4 space-y-2 text-sm">
        <p className="font-medium text-text">{emptyState.title}</p>
        <p className="text-text-dim">{emptyState.message}</p>
      </div>
    );
  }

  const problems = deriveRunProblems(state);

  return (
    <div className="p-4 h-full overflow-auto bg-bg-0 text-sm">
      <h3 className="font-medium text-text mb-4">Diagnostics & Issues</h3>
      {problems.length === 0 ? (
        <div className="text-success flex items-center gap-2">
          <StatusChip variant="success" /> No problems detected.
        </div>
      ) : (
        <ul className="space-y-3">
          {problems.map((p, idx) => (
            <li key={idx} className="bg-bg-1 border border-line-2 rounded p-3 flex flex-col gap-1">
              <span className="text-xs font-semibold text-error uppercase">{p.type}</span>
              <span className="text-text font-mono text-xs">{p.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

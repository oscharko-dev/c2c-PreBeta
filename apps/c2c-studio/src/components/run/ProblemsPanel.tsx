'use client';
import { useTransformationRun } from '../../stores/transformationRun';
import { StatusChip } from '../ui/StatusChip';

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

  const problems: { type: string; message: string }[] = [];

  if (state.generated?.unsupportedFeatures && state.generated.unsupportedFeatures.length > 0) {
    state.generated.unsupportedFeatures.forEach(f => problems.push({ type: 'Unsupported Feature', message: f }));
  }
  if (state.generated?.missingArtifacts && state.generated.missingArtifacts.length > 0) {
    state.generated.missingArtifacts.forEach(m => problems.push({ type: 'Missing Artifact (Generated)', message: m }));
  }
  if (state.buildTest?.status !== 'ok' && state.buildTest?.status) {
    problems.push({ type: 'Build/Test Failure', message: state.buildTest.status });
  }
  if (state.buildTest?.classification && state.buildTest.classification !== 'match') {
    problems.push({ type: 'Equivalence Mismatch', message: state.buildTest.classification });
  }
  if (state.evidence?.status === 'incomplete') {
    problems.push({ type: 'Evidence Incomplete', message: 'The evidence pack is missing required artifacts' });
  }

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

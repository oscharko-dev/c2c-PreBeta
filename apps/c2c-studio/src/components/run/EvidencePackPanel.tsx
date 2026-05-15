'use client';
import { useTransformationRun } from '../../stores/transformationRun';
import { StatusChip } from '../ui/StatusChip';
import { buildArtifactAlignment } from './runPanelUtils';

export function EvidencePackPanel({ emptyState }: { emptyState: { title: string; message: string } }) {
  const { state } = useTransformationRun();

  if (state.phase === 'idle' || state.phase === 'starting' || state.phase === 'running') {
    if (state.phase === 'idle') {
      return (
        <div className="p-4 space-y-2 text-sm">
          <p className="font-medium text-text">{emptyState.title}</p>
          <p className="text-text-dim">{emptyState.message}</p>
        </div>
      );
    }
  }

  const ev = state.evidence;
  if (!ev) {
    return (
      <div className="p-4 space-y-2 text-sm">
        <p className="text-text-dim">Waiting for evidence pack...</p>
      </div>
    );
  }

  const isComplete = ev.status === 'complete';
  const isInvalid = ev.status === 'invalid';
  const alignment = buildArtifactAlignment(state);
  
  return (
    <div className="p-4 h-full flex flex-col text-sm bg-bg-0">
      <div className="flex items-center gap-4 mb-6">
        <StatusChip variant={isComplete ? 'success' : isInvalid ? 'blocked' : 'error'} />
        <h2 className="text-lg font-medium text-text">
          Evidence Pack {isComplete ? 'Complete' : isInvalid ? 'Invalid' : 'Incomplete'}
        </h2>
      </div>
      
      <div className="grid grid-cols-2 gap-8">
        <div className="space-y-4">
          <div className="bg-bg-1 border border-line-2 rounded p-4">
            <h3 className="font-medium text-text mb-3">Manifest Reference</h3>
            <div className="grid grid-cols-1 gap-2 font-mono text-xs">
              <div className="flex flex-col">
                <span className="text-text-dim font-sans mb-1">Pack ID</span>
                <span className="text-text">{ev.packId || 'N/A'}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-text-dim font-sans mb-1">Manifest URI</span>
                <span className="text-text break-all">{ev.manifestUri || 'N/A'}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-text-dim font-sans mb-1">Generated Artifact Reference</span>
                <span className="text-text break-all">{ev.generatedArtifactRef?.uri || 'N/A'}</span>
              </div>
            </div>
          </div>

          <div className="bg-bg-1 border border-line-2 rounded p-4">
            <h3 className="font-medium text-text mb-3">Artifact Lineage</h3>
            <div className={`mb-3 text-xs ${alignment.aligned ? 'text-success' : 'text-error'}`}>
              {alignment.aligned
                ? 'Displayed Java, build/test, and evidence all reference the same generated artifact.'
                : 'Artifact references are not aligned across generated Java, build/test, and evidence.'}
            </div>
            <div className="space-y-3 font-mono text-xs">
              {alignment.entries.map((entry) => (
                <div key={entry.label} className="rounded border border-line-2 p-3">
                  <div className="mb-1 font-sans text-text-dim">{entry.label}</div>
                  <div className="break-all text-text">{entry.ref?.uri || 'N/A'}</div>
                  <div className="mt-1 break-all text-text-faint">{entry.ref?.sha256 || 'No hash available'}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <h3 className="font-medium text-text">Missing Artifacts</h3>
          {ev.missingArtifacts && ev.missingArtifacts.length > 0 ? (
            <ul className="list-disc pl-4 space-y-1 text-error text-xs font-mono">
              {ev.missingArtifacts.map((miss, idx) => (
                <li key={idx}>{miss}</li>
              ))}
            </ul>
          ) : (
            <div className="text-success text-sm">All required artifacts are present.</div>
          )}
          {ev.note && (
            <div className="rounded border border-line-2 bg-bg-1 p-3 text-xs text-text-dim">
              {ev.note}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

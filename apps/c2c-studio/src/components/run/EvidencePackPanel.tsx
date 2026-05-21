'use client';
import { useTransformationRun } from '../../stores/transformationRun';
import { useSourceWorkspace } from '../../stores/sourceWorkspace';
import { StatusChip } from '../ui/StatusChip';
import {
  buildArtifactAlignment,
  describeManualDriftSummary,
  isIntentionalDivergenceTrustSummary,
} from './runPanelUtils';

export function EvidencePackPanel({ emptyState }: { emptyState: { title: string; message: string } }) {
  const {
    state,
    manualDriftSummary = () => ({
      hasManualEdits: false,
      fileCount: 0,
      regionCount: 0,
      baselineRunIds: [],
    }),
  } = useTransformationRun();
  const { statusFlags, selectedTrustCase } = useSourceWorkspace();
  const manualDrift = manualDriftSummary();
  const manualDriftMessage = describeManualDriftSummary(manualDrift);

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

  const showingHistoricalEvidence = Boolean(
    state.previousRun?.evidence &&
      !state.evidence &&
      (state.phase === 'starting' ||
        state.phase === 'running' ||
        state.phase === 'failed' ||
        state.phase === 'unavailable')
  );
  const ev = state.evidence ?? (showingHistoricalEvidence ? state.previousRun?.evidence ?? null : null);
  if (!ev) {
    return (
      <div className="p-4 space-y-2 text-sm">
        <p className="text-text-dim">Waiting for evidence pack...</p>
      </div>
    );
  }

  const isComplete = ev.status === 'complete';
  const isInvalid = ev.status === 'invalid';
  const displayedSummary =
    showingHistoricalEvidence && state.previousRun
      ? state.previousRun.summary
      : state.summary;
  const displayedTrustSummary =
    displayedSummary?.trustSummary ?? state.workflow?.trustSummary ?? null;
  const intentionalDivergence = isIntentionalDivergenceTrustSummary(
    displayedTrustSummary,
  );
  const trustCaseEvidenceMismatch = Boolean(
    selectedTrustCase &&
      displayedSummary?.trustCaseConfigurationDigest &&
      displayedSummary.trustCaseConfigurationDigest !==
        selectedTrustCase.configurationDigest,
  );
  const alignment = buildArtifactAlignment(
    showingHistoricalEvidence && state.previousRun
      ? {
          ...state,
          generated: state.previousRun.generated,
          buildTest: state.previousRun.buildTest,
          evidence: state.previousRun.evidence,
        }
      : state,
  );
  const hasAlignedEvidence = isComplete && alignment.aligned;
  const previousEvidence =
    state.evidence && state.previousRun?.evidence ? state.previousRun.evidence : null;
  
  return (
    <div className="p-4 h-full flex flex-col text-sm bg-bg-0">
      {intentionalDivergence ? (
        <div className="mb-4 rounded border border-warn/20 bg-warn-soft px-4 py-3 text-xs text-warn">
          This evidence pack supports an intentional divergence decision. The
          run is governed as not equivalent, so do not treat the evidence as a
          parity pass.
        </div>
      ) : null}
      {trustCaseEvidenceMismatch ? (
        <div className="mb-4 rounded border border-orange/20 bg-orange-soft px-4 py-3 text-xs text-orange">
          Existing evidence was produced from{' '}
          {displayedSummary?.trustCaseId || 'another trust case'} or a different
          catalog version. Rerun to use{' '}
          {selectedTrustCase?.trustCaseId ?? 'the selected trust case'}.
        </div>
      ) : null}
      {statusFlags.pendingReRun || showingHistoricalEvidence || manualDriftMessage ? (
        <div className="mb-4 rounded border border-orange/20 bg-orange-soft px-4 py-3 text-xs text-orange">
          {showingHistoricalEvidence
            ? state.phase === 'failed'
              ? 'Latest rerun failed. Showing the previous evidence pack as stale so the last completed evidence remains accessible.'
              : 'Showing the previous evidence pack while the latest rerun is in progress. This evidence is stale until the rerun completes.'
            : manualDriftMessage
              ? manualDriftMessage
            : 'COBOL source changed after the last completed parity run. The current evidence pack is stale until you rerun.'}
        </div>
      ) : null}
      <div className="flex items-center gap-4 mb-6">
        <StatusChip
          variant={
            intentionalDivergence
              ? 'warning'
              : hasAlignedEvidence
                ? 'success'
                : isInvalid
                  ? 'blocked'
                  : 'error'
          }
        />
        <h2 className="text-lg font-medium text-text">
          {showingHistoricalEvidence ? 'Previous Evidence Pack' : 'Evidence Pack'} {intentionalDivergence ? 'Intentionally Diverged' : hasAlignedEvidence ? 'Complete' : isInvalid ? 'Invalid' : isComplete ? 'Mismatch Detected' : 'Incomplete'}
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
                <span className="text-text-dim font-sans mb-1">Manifest SHA256</span>
                <span className="text-text break-all">{ev.manifestHash || ev.artifactRef?.sha256 || 'N/A'}</span>
              </div>
              <div className="flex flex-col">
                <span className="text-text-dim font-sans mb-1">Generated Artifact SHA256</span>
                <span className="text-text break-all">{ev.generatedArtifactRef?.sha256 || 'N/A'}</span>
              </div>
            </div>
          </div>

          <div className="bg-bg-1 border border-line-2 rounded p-4">
            <h3 className="font-medium text-text mb-3">Artifact Lineage</h3>
            <div className={`mb-3 text-xs ${intentionalDivergence ? 'text-warn' : alignment.aligned ? 'text-success' : 'text-error'}`}>
              {intentionalDivergence
                ? 'Displayed Java, build/test, and evidence are intentionally governed as not equivalent.'
                : alignment.aligned
                  ? 'Displayed Java, build/test, and evidence all reference the same generated artifact.'
                  : 'Artifact references are not aligned across generated Java, build/test, and evidence.'}
            </div>
            {manualDriftMessage ? (
              <div className="mb-3 rounded border border-orange/20 bg-orange-soft px-3 py-2 text-xs text-orange">
                {manualDriftMessage}
              </div>
            ) : null}
            <div className="space-y-3 font-mono text-xs">
              {alignment.entries.map((entry) => (
                <div key={entry.label} className="rounded border border-line-2 p-3">
                  <div className="mb-1 font-sans text-text-dim">{entry.label}</div>
                  <div className="break-all text-text">{entry.ref?.sha256 || 'No hash available'}</div>
                  <div className="mt-1 text-text-faint">{entry.ref?.kind || 'Content-addressed reference'}</div>
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
          {previousEvidence ? (
            <div className="rounded border border-line-2 bg-bg-1 p-4">
              <h3 className="font-medium text-text mb-2">Previous Run Evidence</h3>
              <div className="space-y-2 font-mono text-xs text-text">
                <div>{previousEvidence.packId || 'N/A'}</div>
                <div className="break-all">
                  {previousEvidence.manifestHash || previousEvidence.artifactRef?.sha256 || 'N/A'}
                </div>
                <div className="break-all">
                  {previousEvidence.generatedArtifactRef?.sha256 || 'N/A'}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

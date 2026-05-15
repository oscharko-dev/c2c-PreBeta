import { useEffect, useRef } from 'react';
import { apiClient } from '../lib/apiClient';
import { TransformationRunState } from '../types/run';
import { BuildTestView, EvidenceView, GeneratedFilesIndex, GeneratedView } from '../types/api';

type SetTransformationRunState = React.Dispatch<React.SetStateAction<TransformationRunState>>;

function isVerifiedArtifactState(
  generated: GeneratedView,
  generatedFiles: GeneratedFilesIndex,
  buildTest: BuildTestView,
  evidence: EvidenceView
) {
  if (
    generated.status !== 'generated' ||
    generatedFiles.status !== 'complete' ||
    buildTest.status !== 'ok' ||
    evidence.status !== 'complete'
  ) {
    return false;
  }

  const genHash = generated.artifactRef?.sha256;
  const buildHash = buildTest.generatedArtifactRef?.sha256;
  const evidenceHash = evidence.generatedArtifactRef?.sha256;

  return Boolean(genHash && genHash === buildHash && genHash === evidenceHash);
}

export async function hydrateRunArtifacts(
  runId: string,
  setState: SetTransformationRunState,
  terminalStatus?: 'completed' | 'failed',
  isActive?: () => boolean
) {
  const [gen, genFiles, bt, ev, evts, arts] = await Promise.all([
    apiClient.getGenerated(runId),
    apiClient.getGeneratedFiles(runId),
    apiClient.getBuildTest(runId),
    apiClient.getEvidence(runId),
    apiClient.getRunEvents(runId),
    apiClient.getRunArtifacts(runId),
  ]);

  if (isActive && !isActive()) return;

  setState(prev => {
    if (prev.runId !== runId) return prev; // stale

    const newState = {
      ...prev,
      generated: gen.ok ? gen.data : null,
      generatedFiles: genFiles.ok ? genFiles.data : null,
      buildTest: bt.ok ? bt.data : null,
      evidence: ev.ok ? ev.data : null,
      events: evts.ok ? evts.data : null,
      artifacts: arts.ok ? arts.data : null,
      artifactsError: arts.ok ? null : arts.message,
    };

    if (terminalStatus === 'failed' || prev.summary?.status === 'failed') {
      newState.phase = 'failed';
    } else if (!gen.ok || !genFiles.ok || !bt.ok || !ev.ok) {
      newState.phase = 'incomplete';
    } else if (isVerifiedArtifactState(gen.data, genFiles.data, bt.data, ev.data)) {
      newState.phase = 'completed';
    } else {
      newState.phase = 'verification-blocked';
    }

    return newState;
  });
}

export function useRunPolling(
  state: TransformationRunState,
  setState: SetTransformationRunState
) {
  const runId = state.runId;
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!runId) return;

    if (
      state.phase === 'completed' ||
      state.phase === 'failed' ||
      state.phase === 'incomplete' ||
      state.phase === 'verification-blocked' ||
      state.phase === 'unavailable' ||
      state.phase === 'idle'
    ) {
      return;
    }

    let active = true;
    let errorCount = 0;
    const MAX_ERRORS = 5;

    const poll = async () => {
      const result = await apiClient.getRun(runId);
      if (!active) return;

      if (!result.ok) {
        errorCount++;
        if (result.status === 503) {
          setState(prev => prev.runId === runId ? { ...prev, phase: 'unavailable', error: 'Backend unavailable' } : prev);
          return;
        }
        if (errorCount > MAX_ERRORS) {
          setState(prev => prev.runId === runId ? { ...prev, phase: 'failed', error: result.message } : prev);
          return;
        }
      } else {
        errorCount = 0;
        const summary = result.data;
        
        setState(prev => {
          if (prev.runId !== runId) return prev; // stale
          return { ...prev, summary };
        });

        if (summary.status === 'completed' || summary.status === 'failed') {
          await hydrateRunArtifacts(runId, setState, summary.status, () => active);
          return; // done polling
        }
      }

      if (active) {
        timerRef.current = setTimeout(poll, 2000);
      }
    };

    poll();

    return () => {
      active = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [runId, state.phase, setState]);
}

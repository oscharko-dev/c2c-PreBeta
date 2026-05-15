import { useEffect, useRef } from 'react';
import { apiClient } from '../lib/apiClient';
import { TransformationRunState } from '../types/run';

export function useRunPolling(
  state: TransformationRunState,
  setState: React.Dispatch<React.SetStateAction<TransformationRunState>>
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
          // fetch artifacts
          await fetchArtifacts(runId);
          return; // done polling
        }
      }

      if (active) {
        timerRef.current = setTimeout(poll, 2000);
      }
    };

    const fetchArtifacts = async (id: string) => {
      const [gen, genFiles, bt, ev, evts, arts] = await Promise.all([
        apiClient.getGenerated(id),
        apiClient.getGeneratedFiles(id),
        apiClient.getBuildTest(id),
        apiClient.getEvidence(id),
        apiClient.getRunEvents(id),
        apiClient.getRunArtifacts(id)
      ]);

      if (!active) return;

      setState(prev => {
        if (prev.runId !== id) return prev; // stale

        const newState = {
          ...prev,
          generated: gen.ok ? gen.data : null,
          generatedFiles: genFiles.ok ? genFiles.data : null,
          buildTest: bt.ok ? bt.data : null,
          evidence: ev.ok ? ev.data : null,
          events: evts.ok ? evts.data : null,
          artifacts: arts.ok ? arts.data : null,
        };

        if (
          !gen.ok ||
          !genFiles.ok ||
          !bt.ok ||
          !ev.ok
        ) {
          newState.phase = 'incomplete';
        } else {
          const genHash = gen.data?.artifactRef?.sha256;
          const btHash = bt.data?.generatedArtifactRef?.sha256;
          const evHash = ev.data?.generatedArtifactRef?.sha256;

          if (genHash && genHash === btHash && genHash === evHash) {
            newState.phase = 'completed';
          } else {
            newState.phase = 'verification-blocked';
          }
        }
        
        return newState;
      });
    };

    poll();

    return () => {
      active = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [runId, state.phase, setState]);
}

import { useEffect, useRef } from 'react';
import { apiClient } from '../lib/apiClient';
import { TransformationRunState } from '../types/run';

type SetTransformationRunState = React.Dispatch<React.SetStateAction<TransformationRunState>>;

async function hydrateRunObservability(
  runId: string,
  setState: SetTransformationRunState,
  isActive?: () => boolean
) {
  // Issue #173: workflow contract is polled alongside progress/events so the
  // Studio always reflects the orchestrator-side agentic state (activeAgent,
  // repairBudget, repairAttempts, failureCode) without waiting for the
  // terminal hydrate.
  const [progress, evts, exp, workflow] = await Promise.all([
    apiClient.getRunProgress(runId),
    apiClient.getRunEvents(runId),
    apiClient.getRunExperience(runId),
    apiClient.getRunWorkflow(runId),
  ]);

  if (isActive && !isActive()) return;

  setState(prev => {
    if (prev.runId !== runId) return prev;

    return {
      ...prev,
      progress: progress?.ok ? progress.data : prev.progress,
      events: evts?.ok ? evts.data : prev.events,
      experience: exp?.ok ? exp.data : prev.experience,
      workflow: workflow?.ok ? workflow.data : prev.workflow,
    };
  });
}

export async function hydrateRunArtifacts(
  runId: string,
  setState: SetTransformationRunState,
  terminalStatus?: 'completed' | 'failed',
  isActive?: () => boolean
) {
  const [gen, genFiles, bt, ev, progress, evts, arts, exp, workflow] = await Promise.all([
    apiClient.getGenerated(runId),
    apiClient.getGeneratedFiles(runId),
    apiClient.getBuildTest(runId),
    apiClient.getEvidence(runId),
    apiClient.getRunProgress(runId),
    apiClient.getRunEvents(runId),
    apiClient.getRunArtifacts(runId),
    apiClient.getRunExperience(runId),
    apiClient.getRunWorkflow(runId)
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
      progress: progress.ok ? progress.data : prev.progress,
      events: evts.ok ? evts.data : null,
      artifacts: arts.ok ? arts.data : null,
      artifactsError: arts.ok ? null : arts.message,
      experience: exp.ok ? exp.data : null,
      workflow: workflow?.ok ? workflow.data : prev.workflow,
    };

    // Issue #173: polling is a transport concern. We stop polling on every
    // terminal outcome by setting phase='completed' (run is over) or
    // phase='failed' (run errored before producing artifacts). The
    // user-facing verdict (success / blocked / hash-mismatch /
    // equivalence-mismatch / evidence-incomplete) is derived from the BFF
    // finalClassification + artifact contents in `deriveProductState`; the
    // polling layer never invents a "verification-blocked" sub-state.
    if (terminalStatus === 'failed' || prev.summary?.status === 'failed') {
      newState.phase = 'failed';
    } else if (!gen.ok || !genFiles.ok || !bt.ok || !ev.ok) {
      newState.phase = 'incomplete';
    } else {
      newState.phase = 'completed';
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

        await hydrateRunObservability(runId, setState, () => active);
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

export function useGlobalObservabilityPolling(
  setState: SetTransformationRunState
) {
  useEffect(() => {
    let active = true;
    const fetchGlobals = async () => {
      const [mgHealth, hReady] = await Promise.all([
        apiClient.getModelGatewayHealth(),
        apiClient.getHarnessReady()
      ]);
      if (!active) return;
      setState(prev => ({
        ...prev,
        modelGatewayHealth: mgHealth?.ok ? mgHealth.data : { status: 'unavailable', error: mgHealth?.message ?? 'Model Gateway unavailable' },
        harnessReady: hReady?.ok ? hReady.data : { status: 'unavailable', error: hReady?.message ?? 'Harness unavailable' },
      }));
    };
    
    fetchGlobals();
    
    // Refresh every 30 seconds
    const interval = setInterval(fetchGlobals, 30000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [setState]);
}

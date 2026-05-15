'use client';

import { createContext, useContext, useRef, useState, ReactNode, useMemo } from 'react';
import { TransformationRunState, RunPhase } from '../types/run';
import { deriveProductState, StateContext } from '../types/state';
import { apiClient } from '../lib/apiClient';
import { TransformRequest } from '../types/reference-program';
import { hydrateRunArtifacts, useRunPolling, useGlobalObservabilityPolling } from '../hooks/useRunPolling';
import { ApiResult, TransformResponse } from '../types/api';

export interface TransformationRunContextValue {
  state: TransformationRunState;
  productState: StateContext;
  startTransform: (request: TransformRequest) => Promise<ApiResult<TransformResponse>>;
  setState: React.Dispatch<React.SetStateAction<TransformationRunState>>;
}

const TransformationRunContext = createContext<TransformationRunContextValue | null>(null);

export function TransformationRunProvider({ children }: { children: ReactNode }) {
  const activeTransformRequestRef = useRef(0);
  const [state, setState] = useState<TransformationRunState>({
    phase: 'idle',
    runId: null,
    orchestratorRunId: null,
    programId: null,
    error: null,
    artifactsError: null,
    summary: null,
    generated: null,
    generatedFiles: null,
    buildTest: null,
    evidence: null,
    events: null,
    artifacts: null,
    experience: null,
    modelGatewayHealth: null,
    harnessReady: null,
  });

  const productState = useMemo(() => deriveProductState(state), [state]);

  useRunPolling(state, setState);
  useGlobalObservabilityPolling(setState);

  const startTransform = async (request: TransformRequest): Promise<ApiResult<TransformResponse>> => {
    const requestId = ++activeTransformRequestRef.current;

    setState({
      phase: 'starting',
      runId: null,
      orchestratorRunId: null,
      programId: request.programId || null,
      error: null,
      artifactsError: null,
      summary: null,
      generated: null,
      generatedFiles: null,
      buildTest: null,
      evidence: null,
      events: null,
      artifacts: null,
      experience: null,
      modelGatewayHealth: state.modelGatewayHealth,
      harnessReady: state.harnessReady,
    });

    const result = await apiClient.transform(request);

    if (requestId !== activeTransformRequestRef.current) {
      return result;
    }

    if (!result.ok) {
      setState(prev => ({
        ...prev,
        phase: 'failed',
        error: result.status === 503 ? 'Backend unavailable. Try again shortly.' : result.message,
      }));
      return result;
    }

    setState(prev => ({
      ...prev,
      phase: result.data.status === 'completed' || result.data.status === 'failed' ? result.data.status as RunPhase : 'running',
      runId: result.data.runId,
      orchestratorRunId: result.data.orchestratorRunId,
      programId: result.data.programId,
      error: null,
      summary: result.data,
    }));

    if (result.data.status === 'completed' || result.data.status === 'failed') {
      void hydrateRunArtifacts(result.data.runId, setState, result.data.status);
    }

    return result;
  };

  return (
    <TransformationRunContext.Provider value={{ state, productState, startTransform, setState }}>
      {children}
    </TransformationRunContext.Provider>
  );
}

export function useTransformationRun() {
  const context = useContext(TransformationRunContext);
  if (!context) {
    throw new Error('useTransformationRun must be used within a TransformationRunProvider');
  }
  return context;
}

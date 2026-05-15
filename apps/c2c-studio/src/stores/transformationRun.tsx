'use client';

import { createContext, useContext, useState, ReactNode } from 'react';
import { TransformationRunState, RunPhase } from '../types/run';
import { apiClient } from '../lib/apiClient';
import { TransformRequest } from '../types/reference-program';
import { useRunPolling } from '../hooks/useRunPolling';
import { ApiResult, TransformResponse } from '../types/api';

export interface TransformationRunContextValue {
  state: TransformationRunState;
  startTransform: (request: TransformRequest) => Promise<ApiResult<TransformResponse>>;
  setState: React.Dispatch<React.SetStateAction<TransformationRunState>>;
}

const TransformationRunContext = createContext<TransformationRunContextValue | null>(null);

export function TransformationRunProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<TransformationRunState>({
    phase: 'idle',
    runId: null,
    orchestratorRunId: null,
    programId: null,
    error: null,
    summary: null,
    generated: null,
    generatedFiles: null,
    buildTest: null,
    evidence: null,
    events: null,
    artifacts: null,
  });

  useRunPolling(state, setState);

  const startTransform = async (request: TransformRequest): Promise<ApiResult<TransformResponse>> => {
    setState({
      phase: 'starting',
      runId: null,
      orchestratorRunId: null,
      programId: request.programId || null,
      error: null,
      summary: null,
      generated: null,
      generatedFiles: null,
      buildTest: null,
      evidence: null,
      events: null,
      artifacts: null,
    });

    const result = await apiClient.transform(request);

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
    }));

    return result;
  };

  return (
    <TransformationRunContext.Provider value={{ state, startTransform, setState }}>
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

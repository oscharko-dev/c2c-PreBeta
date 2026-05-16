'use client';

import { createContext, useContext, useState, ReactNode } from 'react';
import { DEFAULT_SOURCE_NAME, MAX_SOURCE_BYTES, getSourceByteSize } from '../lib/sourceAnalysis';
import { ApiResult, TransformResponse } from '../types/api';
import { useTransformationRun } from './transformationRun';

export interface SourceWorkspaceState {
  sourceText: string;
  isDirty: boolean;
  loadedProgramId: string | null;
  sourceName: string | null;
  transformError: string | null;
  isTransforming: boolean;
  canSubmitTransform: boolean;
  setSourceText: (text: string) => void;
  loadProgram: (programId: string, sourceText: string, sourceName: string) => void;
  clearWorkspace: () => void;
  submitTransform: () => Promise<ApiResult<TransformResponse>>;
}

const SourceWorkspaceContext = createContext<SourceWorkspaceState | null>(null);

export function SourceWorkspaceProvider({ children }: { children: ReactNode }) {
  const [sourceText, setSourceTextInternal] = useState('');
  const [isDirty, setIsDirty] = useState(false);
  const [loadedProgramId, setLoadedProgramId] = useState<string | null>(null);
  const [sourceName, setSourceName] = useState<string | null>(null);
  const [transformError, setTransformError] = useState<string | null>(null);
  
  const { state: runState, startTransform } = useTransformationRun();
  const isTransforming = runState.phase === 'starting' || runState.phase === 'running';

  const setSourceText = (text: string) => {
    setSourceTextInternal(text);
    setIsDirty(true);
    setTransformError(null);
    if (!sourceName) {
      setSourceName(DEFAULT_SOURCE_NAME);
    }
  };

  const loadProgram = (newProgramId: string, newSourceText: string, newSourceName: string) => {
    setSourceTextInternal(newSourceText);
    setLoadedProgramId(newProgramId);
    setSourceName(newSourceName);
    setIsDirty(false);
    setTransformError(null);
  };

  const clearWorkspace = () => {
    setSourceTextInternal('');
    setLoadedProgramId(null);
    setSourceName(null);
    setIsDirty(false);
    setTransformError(null);
  };

  const canSubmitTransform = sourceText.trim().length > 0 && !isTransforming;

  const submitTransform = async (): Promise<ApiResult<TransformResponse>> => {
    const trimmed = sourceText.trim();
    if (trimmed.length === 0) {
      const result = { ok: false, message: 'Source text is required.' } as const;
      setTransformError(result.message);
      return result;
    }

    if (getSourceByteSize(sourceText) > MAX_SOURCE_BYTES) {
      const result = { ok: false, message: 'Source text exceeds the 1 MB product-mode limit.' } as const;
      setTransformError(result.message);
      return result;
    }

    setTransformError(null);

    const result = await startTransform({
      sourceText,
      programId: isDirty ? undefined : loadedProgramId ?? undefined,
      sourceName: sourceName || DEFAULT_SOURCE_NAME,
    });

    if (!result.ok) {
      setTransformError(result.status === 503 ? 'Backend unavailable. Try again shortly.' : result.message);
    }

    return result;
  };

  return (
    <SourceWorkspaceContext.Provider
      value={{
        sourceText,
        isDirty,
        loadedProgramId,
        sourceName,
        transformError,
        isTransforming,
        canSubmitTransform,
        setSourceText,
        loadProgram,
        clearWorkspace,
        submitTransform,
      }}
    >
      {children}
    </SourceWorkspaceContext.Provider>
  );
}

export function useSourceWorkspace() {
  const context = useContext(SourceWorkspaceContext);
  if (!context) {
    throw new Error('useSourceWorkspace must be used within a SourceWorkspaceProvider');
  }
  return context;
}

'use client';

import { createContext, useContext, useState, ReactNode } from 'react';
import { DEFAULT_SOURCE_NAME, MAX_SOURCE_BYTES, getSourceByteSize } from '../lib/sourceAnalysis';
import { ApiResult, TransformResponse } from '../types/api';
import { useTransformationRun } from './transformationRun';

export interface SourceWorkspaceState {
  sourceText: string;
  isDirty: boolean;
  sourceName: string | null;
  expectedOutput: string;
  oracleInput: string;
  transformError: string | null;
  isTransforming: boolean;
  canSubmitTransform: boolean;
  setSourceText: (text: string) => void;
  setSourceFile: (text: string, sourceName: string) => void;
  setExpectedOutput: (text: string) => void;
  setOracleInput: (text: string) => void;
  clearWorkspace: () => void;
  submitTransform: () => Promise<ApiResult<TransformResponse>>;
}

const SourceWorkspaceContext = createContext<SourceWorkspaceState | null>(null);

export function SourceWorkspaceProvider({ children }: { children: ReactNode }) {
  const [sourceText, setSourceTextInternal] = useState('');
  const [isDirty, setIsDirty] = useState(false);
  const [sourceName, setSourceName] = useState<string | null>(null);
  const [expectedOutput, setExpectedOutputInternal] = useState('');
  const [oracleInput, setOracleInputInternal] = useState('');
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

  const setSourceFile = (text: string, newSourceName: string) => {
    setSourceTextInternal(text);
    setSourceName(newSourceName || DEFAULT_SOURCE_NAME);
    setExpectedOutputInternal('');
    setOracleInputInternal('');
    setIsDirty(false);
    setTransformError(null);
  };

  const setExpectedOutput = (text: string) => {
    setExpectedOutputInternal(text);
    setTransformError(null);
  };

  const setOracleInput = (text: string) => {
    setOracleInputInternal(text);
    setTransformError(null);
  };

  const clearWorkspace = () => {
    setSourceTextInternal('');
    setSourceName(null);
    setExpectedOutputInternal('');
    setOracleInputInternal('');
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
      programId: undefined,
      sourceName: sourceName || DEFAULT_SOURCE_NAME,
      targetLanguage: 'java',
      expectedOutput: expectedOutput.length > 0 ? expectedOutput : undefined,
      oracleInput: oracleInput.length > 0 ? oracleInput : undefined,
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
        sourceName,
        expectedOutput,
        oracleInput,
        transformError,
        isTransforming,
        canSubmitTransform,
        setSourceText,
        setSourceFile,
        setExpectedOutput,
        setOracleInput,
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

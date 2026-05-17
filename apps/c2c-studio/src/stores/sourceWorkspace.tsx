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
  allowAiAssist: boolean;
  transformError: string | null;
  isTransforming: boolean;
  canSubmitTransform: boolean;
  setSourceText: (text: string) => void;
  setSourceFile: (text: string, sourceName: string) => void;
  setExpectedOutput: (text: string) => void;
  setOracleInput: (text: string) => void;
  setAllowAiAssist: (enabled: boolean) => void;
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
  const [allowAiAssist, setAllowAiAssistInternal] = useState(true);
  const [transformError, setTransformError] = useState<string | null>(null);
  
  const { state: runState, startTransform } = useTransformationRun();
  const isTransforming = runState.phase === 'starting' || runState.phase === 'running';
  const modelGatewayUnavailable =
    allowAiAssist && runState.modelGatewayHealth?.status === 'unavailable';

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

  const setAllowAiAssist = (enabled: boolean) => {
    setAllowAiAssistInternal(enabled);
    setTransformError(null);
  };

  const clearWorkspace = () => {
    setSourceTextInternal('');
    setSourceName(null);
    setExpectedOutputInternal('');
    setOracleInputInternal('');
    setAllowAiAssistInternal(true);
    setIsDirty(false);
    setTransformError(null);
  };

  const canSubmitTransform =
    sourceText.trim().length > 0 && !isTransforming && !modelGatewayUnavailable;

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

    if (modelGatewayUnavailable) {
      const result = { ok: false, message: 'AI Assist is enabled, but the Model Gateway is unavailable. Disable AI Assist to run deterministic-only.' } as const;
      setTransformError(result.message);
      return result;
    }

    setTransformError(null);

    const request = {
      sourceText,
      programId: undefined,
      sourceName: sourceName || DEFAULT_SOURCE_NAME,
      targetLanguage: 'java',
      expectedOutput: expectedOutput.length > 0 ? expectedOutput : undefined,
      oracleInput: oracleInput.length > 0 ? oracleInput : undefined,
    } as const;

    const result = await startTransform(
      { ...request, useTransformationAgent: allowAiAssist }
    );

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
        allowAiAssist,
        transformError,
        isTransforming,
        canSubmitTransform,
        setSourceText,
        setSourceFile,
        setExpectedOutput,
        setOracleInput,
        setAllowAiAssist,
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

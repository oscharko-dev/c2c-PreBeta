'use client';

import { createContext, useContext, useState, ReactNode } from 'react';

export interface SourceWorkspaceState {
  sourceText: string;
  isDirty: boolean;
  programId: string | null;
  sourceName: string | null;
  setSourceText: (text: string) => void;
  loadProgram: (programId: string, sourceText: string, sourceName: string) => void;
  clearWorkspace: () => void;
}

const SourceWorkspaceContext = createContext<SourceWorkspaceState | null>(null);

export function SourceWorkspaceProvider({ children }: { children: ReactNode }) {
  const [sourceText, setSourceTextInternal] = useState('');
  const [isDirty, setIsDirty] = useState(false);
  const [programId, setProgramId] = useState<string | null>(null);
  const [sourceName, setSourceName] = useState<string | null>(null);

  const setSourceText = (text: string) => {
    setSourceTextInternal(text);
    setIsDirty(true);
  };

  const loadProgram = (newProgramId: string, newSourceText: string, newSourceName: string) => {
    setSourceTextInternal(newSourceText);
    setProgramId(newProgramId);
    setSourceName(newSourceName);
    setIsDirty(false);
  };

  const clearWorkspace = () => {
    setSourceTextInternal('');
    setProgramId(null);
    setSourceName(null);
    setIsDirty(false);
  };

  return (
    <SourceWorkspaceContext.Provider
      value={{
        sourceText,
        isDirty,
        programId,
        sourceName,
        setSourceText,
        loadProgram,
        clearWorkspace,
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

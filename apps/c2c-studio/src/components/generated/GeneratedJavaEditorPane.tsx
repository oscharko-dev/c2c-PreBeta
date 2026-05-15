import React from 'react';
import { useGeneratedArtifacts } from '../../hooks/useGeneratedArtifacts';
import { Loader2 } from 'lucide-react';

export function GeneratedJavaEditorPane() {
  const { 
    artifactState, 
    selectedFilePath, 
    fileContent, 
    isFetchingFile, 
    fileFetchError,
    artifactDetails
  } = useGeneratedArtifacts();

  if (artifactState === 'idle') {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-text-dim">
        <p>No active run. Start a transformation to see generated Java.</p>
      </div>
    );
  }

  if (artifactState === 'pending') {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-text-dim flex-col gap-4">
        <Loader2 className="animate-spin text-accent" size={32} />
        <p>Generating Java artifacts...</p>
      </div>
    );
  }

  if (artifactState === 'unsupported') {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-warning flex-col gap-4">
        <p className="font-medium text-lg">Unsupported Features</p>
        <p className="max-w-md">The source program uses COBOL features not currently supported by the generator.</p>
        {artifactDetails?.unsupportedFeatures && (
          <ul className="text-left text-sm list-disc pl-4 mt-2">
            {artifactDetails.unsupportedFeatures.map(f => <li key={f}>{f}</li>)}
          </ul>
        )}
      </div>
    );
  }

  if (artifactState === 'incomplete') {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-error flex-col gap-4">
        <p className="font-medium text-lg">Incomplete Generation</p>
        <p className="max-w-md">The generation process did not complete successfully or some artifacts are missing.</p>
        {artifactDetails?.missingArtifacts && (
          <ul className="text-left text-sm list-disc pl-4 mt-2">
            {artifactDetails.missingArtifacts.map(f => <li key={f}>{f}</li>)}
          </ul>
        )}
      </div>
    );
  }

  // Displaying actual content
  return (
    <div className="flex flex-col h-full overflow-hidden relative bg-bg-0" aria-label="Generated Java Editor">
      <div className="flex items-center justify-between border-b border-line px-4 py-2 shrink-0 bg-bg-1">
        <div className="flex items-center gap-2 overflow-hidden">
          <h2 className="text-sm font-medium text-text truncate">
            {selectedFilePath ? selectedFilePath.split('/').pop() : 'Generated Java'}
          </h2>
          {selectedFilePath && (
            <span className="text-xs text-text-dim truncate">{selectedFilePath}</span>
          )}
        </div>
        <div className="flex gap-2">
          {artifactState === 'failed-verification' && (
            <span className="rounded bg-error/20 text-error px-2 py-1 text-[11px] uppercase tracking-wider">
              Verification Failed
            </span>
          )}
          {artifactState === 'verified' && (
            <span className="rounded bg-success/20 text-success px-2 py-1 text-[11px] uppercase tracking-wider">
              Verified
            </span>
          )}
        </div>
      </div>
      
      <div className="flex-1 overflow-auto bg-bg-0">
        {isFetchingFile ? (
          <div className="flex h-full items-center justify-center text-text-dim">
            <Loader2 className="animate-spin text-accent mr-2" size={16} />
            <span>Loading file content...</span>
          </div>
        ) : fileFetchError ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-error">
            <p>Failed to load file: {fileFetchError.message}</p>
          </div>
        ) : !selectedFilePath ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-text-dim">
            <p>Select a file from the Target Java Inspector to view its content.</p>
          </div>
        ) : fileContent === null ? (
          <div className="flex h-full items-center justify-center p-6 text-center text-text-dim">
            <p>File content is empty or unavailable.</p>
          </div>
        ) : (
          <pre className="p-4 text-sm font-mono text-text overflow-auto">
            <code>{fileContent}</code>
          </pre>
        )}
      </div>
    </div>
  );
}

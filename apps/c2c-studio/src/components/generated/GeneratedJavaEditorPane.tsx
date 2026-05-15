import React from 'react';
import { useGeneratedArtifacts } from '../../hooks/useGeneratedArtifacts';
import { Loader2 } from 'lucide-react';
import { UnsupportedConstructsPanel } from '../state/UnsupportedConstructsPanel';
import { MissingArtifactsPanel } from '../state/MissingArtifactsPanel';
import { BlockedState } from '../state/BlockedState';
import { Badge } from '../ui/Badge';
import { useTransformationRun } from '../../stores/transformationRun';

export function GeneratedJavaEditorPane() {
  const { 
    artifactState, 
    selectedFilePath, 
    fileContent, 
    isFetchingFile, 
    fileFetchError,
    artifactDetails
  } = useGeneratedArtifacts();
  
  const { productState } = useTransformationRun();

  if (productState.state === 'empty') {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-text-dim">
        <p>No active run. Start a transformation to see generated Java.</p>
      </div>
    );
  }

  if (productState.state === 'running' || productState.state === 'generated-pending') {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-text-dim flex-col gap-4">
        <Loader2 className="animate-spin text-accent" size={32} />
        <p>Generating Java artifacts...</p>
      </div>
    );
  }

  if (productState.state === 'unsupported') {
    return (
      <div className="flex flex-col h-full items-center justify-center p-6">
         <BlockedState reason="Unsupported COBOL Constructs" details={productState.message} />
         <UnsupportedConstructsPanel constructs={productState.unsupportedFeatures || []} />
      </div>
    );
  }

  if (productState.state === 'generated-incomplete') {
    return (
      <div className="flex flex-col h-full items-center justify-center p-6">
        <BlockedState reason="Incomplete Generation" details={productState.message || 'Generation did not complete normally.'} />
        <MissingArtifactsPanel artifacts={productState.missingArtifacts || []} />
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
          {productState.state === 'build-failed' && (
            <Badge variant="error" icon={true}>
              Verification Failed
            </Badge>
          )}
          {productState.state === 'equivalence-mismatch' && (
             <Badge variant="error" icon={true}>
              Equivalence Mismatch
            </Badge>
          )}
          {productState.state === 'ready' && (
            <Badge variant="success" icon={true}>
              Verified
            </Badge>
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

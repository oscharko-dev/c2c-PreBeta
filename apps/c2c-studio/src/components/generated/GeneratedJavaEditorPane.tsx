import React from 'react';
import { useGeneratedArtifacts } from '../../hooks/useGeneratedArtifacts';
import { Loader2 } from 'lucide-react';
import { UnsupportedConstructsPanel } from '../state/UnsupportedConstructsPanel';
import { MissingArtifactsPanel } from '../state/MissingArtifactsPanel';
import { BlockedState } from '../state/BlockedState';
import { ErrorNotice } from '../state/ErrorNotice';
import { Badge } from '../ui/Badge';
import { useTransformationRun } from '../../stores/transformationRun';
import { VirtualizedCodeBlock } from '../ui/VirtualizedCodeBlock';

export function GeneratedJavaEditorPane() {
  const { 
    artifactState, 
    selectedFilePath, 
    fileContent, 
    isFetchingFile, 
    fileFetchError,
    artifactDetails
  } = useGeneratedArtifacts();
  
  const { state, productState } = useTransformationRun();

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

  if (
    (productState.state === 'backend-unavailable' ||
      productState.state === 'upstream-unavailable' ||
      productState.state === 'validation-error') &&
    !state.generated
  ) {
    return (
      <div className="flex flex-col h-full items-center justify-center p-6">
        <BlockedState
          reason={
            productState.state === 'backend-unavailable'
              ? 'Backend Unavailable'
              : productState.state === 'upstream-unavailable'
                ? 'Upstream Service Unavailable'
                : 'Transformation Validation Error'
          }
          details={productState.message}
        />
      </div>
    );
  }

  const showVerificationNotice =
    productState.state === 'failed' ||
    productState.state === 'build-failed' ||
    productState.state === 'equivalence-mismatch' ||
    productState.state === 'evidence-incomplete' ||
    productState.state === 'hash-mismatch' ||
    productState.state === 'backend-unavailable' ||
    productState.state === 'upstream-unavailable';

  const verificationNoticeMessage =
    productState.state === 'hash-mismatch'
      ? 'Artifact hashes do not align across generated Java, build/test, and evidence. Verified state is blocked.'
      : productState.state === 'evidence-incomplete'
        ? productState.message || 'Evidence is incomplete. Generated Java remains visible, but verification is blocked.'
        : productState.state === 'equivalence-mismatch'
          ? productState.message || 'Java output diverges from the COBOL oracle.'
          : productState.state === 'build-failed'
            ? productState.message || 'Build or test execution failed.'
            : productState.state === 'failed'
              ? productState.message || 'The transformation run failed before verification completed.'
              : productState.message;

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
          {productState.state === 'failed' && (
            <Badge variant="error" icon={true}>
              Run Failed
            </Badge>
          )}
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
          {productState.state === 'evidence-incomplete' && (
            <Badge variant="incomplete" icon={true}>
              Evidence Incomplete
            </Badge>
          )}
          {productState.state === 'hash-mismatch' && (
            <Badge variant="error" icon={true}>
              Artifact Mismatch
            </Badge>
          )}
          {productState.state === 'ready' && (
            <Badge variant="success" icon={true}>
              Verified
            </Badge>
          )}
        </div>
      </div>

      {showVerificationNotice && verificationNoticeMessage ? (
        <div className="shrink-0 px-4 py-3 border-b border-line bg-bg-1/40 space-y-3">
          <ErrorNotice message={verificationNoticeMessage} />
          {productState.state === 'evidence-incomplete' ? (
            <MissingArtifactsPanel artifacts={productState.missingArtifacts || []} />
          ) : null}
          {productState.state === 'hash-mismatch' && productState.mismatchedHashes?.length ? (
            <div className="rounded border border-error/20 bg-error/5 px-4 py-3 text-xs text-text-dim">
              <div className="font-semibold text-error mb-2">Conflicting Artifact References</div>
              <ul className="space-y-2 font-mono">
                {productState.mismatchedHashes.map((mismatch) => (
                  <li key={`${mismatch.context}-${mismatch.actual}`}>
                    <div className="text-text">{mismatch.context}</div>
                    <div>expected: {mismatch.expected}</div>
                    <div>actual: {mismatch.actual}</div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

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
          <VirtualizedCodeBlock
            code={fileContent}
            label={`Generated Java source for ${selectedFilePath}`}
          />
        )}
      </div>
    </div>
  );
}

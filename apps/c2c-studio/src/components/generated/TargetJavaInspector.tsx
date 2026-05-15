import React from 'react';
import { useWorkbench } from '../../stores/workbench';
import { useGeneratedArtifacts } from '../../hooks/useGeneratedArtifacts';
import { ArtifactMetadataPanel } from './ArtifactMetadataPanel';
import { GeneratedProjectTree } from './GeneratedProjectTree';
import { Loader2 } from 'lucide-react';

export function TargetJavaInspector() {
  const { isTargetInspectorOpen } = useWorkbench();
  const { 
    artifactState, 
    fileTree, 
    artifactDetails, 
    selectedFilePath, 
    selectFile,
    unavailableFiles
  } = useGeneratedArtifacts();

  if (!isTargetInspectorOpen) return null;

  return (
    <div className="flex h-full w-72 shrink-0 flex-col overflow-hidden border-l border-line bg-bg-2 max-lg:w-64" aria-label="Target Java Inspector">
      <div className="flex items-center px-4 h-10 border-b border-line-2 font-medium text-xs text-text uppercase tracking-wider shrink-0">
        Target Java Inspector
      </div>
      
      {artifactState === 'idle' && (
        <div className="flex-1 p-4 text-sm text-text-dim">
          <p>No active run.</p>
        </div>
      )}

      {artifactState === 'pending' && (
        <div className="flex-1 p-4 text-sm text-text-dim flex flex-col items-center justify-center gap-2">
          <Loader2 className="animate-spin text-accent" size={24} />
          <p>Generating...</p>
        </div>
      )}

      {artifactState === 'unsupported' && (
        <div className="flex-1 p-4 text-sm text-warning">
          <p>Unsupported features present.</p>
        </div>
      )}

      {artifactState === 'incomplete' && (
        <div className="flex-1 p-4 text-sm text-error">
          <p>Generation incomplete.</p>
        </div>
      )}

      {(artifactState === 'generated' || artifactState === 'verified' || artifactState === 'failed-verification') && (
        <div className="flex flex-col flex-1 overflow-hidden">
          {artifactDetails && <ArtifactMetadataPanel details={artifactDetails} />}
          <div className="flex-1 overflow-auto py-2">
            <GeneratedProjectTree 
              tree={fileTree} 
              selectedPath={selectedFilePath} 
              onSelectFile={selectFile}
              unavailableFiles={unavailableFiles}
            />
          </div>
        </div>
      )}
    </div>
  );
}

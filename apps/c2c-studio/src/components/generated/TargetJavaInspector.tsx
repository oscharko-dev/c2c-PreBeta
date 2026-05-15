import React from 'react';
import { useWorkbench } from '../../stores/workbench';
import { useGeneratedArtifacts } from '../../hooks/useGeneratedArtifacts';
import { ArtifactMetadataPanel } from './ArtifactMetadataPanel';
import { GeneratedProjectTree } from './GeneratedProjectTree';
import { Loader2 } from 'lucide-react';
import { useResizablePane } from '../../hooks/useResizablePane';
import { cn } from '@/lib/utils';

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

  const { size, isResizing, startResize } = useResizablePane({
    id: 'target-inspector',
    initialSize: 288, // w-72 is 288px
    minSize: 200,
    maxSize: 600,
    direction: 'horizontal',
    reverse: true,
  });

  if (!isTargetInspectorOpen) return null;

  return (
    <div 
      className="flex h-full shrink-0 flex-col overflow-hidden bg-bg-2 relative group max-lg:!w-64" 
      aria-label="Target Java Inspector"
      style={{ width: size }}
    >
      {/* Resize Handle */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Target Inspector"
        tabIndex={0}
        onMouseDown={(e) => {
          // Invert horizontal direction logic by a slight trick or just rely on mouse coords.
          // Wait, the hook uses absolute mouse position vs startPos. 
          // If handle is on the left, dragging left (negative delta) should INCREASE size.
          // We might need a "reverse" flag in the hook, or just let the hook handle standard right-handle logic and we adjust it here... 
          // Let's modify the hook to support handle placement or reverse later, or just do the simple startResize if it's fine.
          startResize(e);
        }}
        onTouchStart={startResize}
        onKeyDown={startResize}
        className={cn(
          "absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-accent hover:w-1 focus-visible:w-1 focus-visible:bg-accent outline-none z-10 transition-colors delay-100",
          isResizing ? "bg-accent w-1" : "bg-line"
        )}
      />

      <div className="flex items-center px-4 h-10 border-b border-line-2 font-medium text-xs text-text uppercase tracking-wider shrink-0 ml-1">
        Target Java Inspector
      </div>
      
      {artifactState === 'idle' && (
        <div className="flex-1 p-4 text-sm text-text-dim ml-1">
          <p>No active run.</p>
        </div>
      )}

      {artifactState === 'pending' && (
        <div className="flex-1 p-4 text-sm text-text-dim flex flex-col items-center justify-center gap-2 ml-1">
          <Loader2 className="animate-spin text-accent" size={24} />
          <p>Generating...</p>
        </div>
      )}

      {artifactState === 'unsupported' && (
        <div className="flex-1 p-4 text-sm text-warning ml-1">
          <p>Unsupported features present.</p>
        </div>
      )}

      {artifactState === 'incomplete' && (
        <div className="flex-1 p-4 text-sm text-error ml-1">
          <p>Generation incomplete.</p>
        </div>
      )}

      {(artifactState === 'generated' || artifactState === 'verified' || artifactState === 'failed-verification') && (
        <div className="flex flex-col flex-1 overflow-hidden ml-1">
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

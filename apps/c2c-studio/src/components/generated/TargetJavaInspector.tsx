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

  const { size, minSize, maxSize, isResizing, startResize } = useResizablePane({
    id: 'target-inspector',
    initialSize: 288, // w-72 is 288px
    minSize: 200,
    maxSize: 600,
    direction: 'horizontal',
    reverse: true,
  });

  if (!isTargetInspectorOpen) return null;

  return (
    <aside
      id="target-java-inspector-panel"
      className="absolute bottom-0 right-0 top-0 z-20 flex h-full w-64 shrink-0 flex-col overflow-hidden bg-bg-2 shadow-lg lg:relative lg:z-auto lg:w-[var(--target-inspector-width)] lg:shadow-none group"
      aria-label="Target Java Inspector"
      style={{ '--target-inspector-width': `${size}px` } as React.CSSProperties}
    >
      {/* Resize Handle */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Target Inspector"
        aria-controls="target-java-inspector-panel"
        aria-valuemin={minSize}
        aria-valuemax={maxSize}
        aria-valuenow={size}
        tabIndex={0}
        onMouseDown={startResize}
        onTouchStart={startResize}
        onKeyDown={startResize}
        className={cn(
          "absolute -left-3 top-0 bottom-0 hidden w-6 cursor-col-resize outline-none z-10 lg:block before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:transition-colors hover:before:bg-accent focus-visible:before:bg-accent",
          isResizing ? "before:bg-accent" : "before:bg-line"
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
        <div className="flex-1 p-4 text-sm text-warn ml-1">
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
    </aside>
  );
}

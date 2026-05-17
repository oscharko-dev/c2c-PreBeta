'use client';

import type { CSSProperties } from 'react';
import { useWorkbench } from '../../stores/workbench';
import { SourceWorkspaceTree } from '../source/SourceWorkspaceTree';
import { useResizablePane } from '../../hooks/useResizablePane';
import { cn } from '@/lib/utils';

export function SourceWorkspacePanel() {
  const { isSourceWorkspaceOpen } = useWorkbench();
  const { size, minSize, maxSize, isResizing, startResize } = useResizablePane({
    id: 'source-workspace',
    initialSize: 256, // w-64 is 256px
    minSize: 150,
    maxSize: 600,
    direction: 'horizontal',
  });

  if (!isSourceWorkspaceOpen) return null;

  return (
    <aside
      id="source-workspace-panel"
      className="absolute bottom-0 left-0 top-0 z-20 flex h-full w-56 shrink-0 flex-col overflow-hidden bg-bg-2 shadow-lg lg:relative lg:z-auto lg:w-[var(--source-workspace-width)] lg:shadow-none group"
      aria-label="Source Workspace"
      style={{ '--source-workspace-width': `${size}px` } as CSSProperties}
    >
      <div className="flex items-center px-4 h-10 border-b border-line-2 font-medium text-xs text-text uppercase tracking-wider">
        Source Workspace
      </div>
      <SourceWorkspaceTree />
      
      {/* Resize Handle */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize Source Workspace"
        aria-controls="source-workspace-panel"
        aria-valuemin={minSize}
        aria-valuemax={maxSize}
        aria-valuenow={size}
        tabIndex={0}
        onMouseDown={startResize}
        onTouchStart={startResize}
        onKeyDown={startResize}
        className={cn(
          "absolute -right-3 top-0 bottom-0 hidden w-6 cursor-col-resize outline-none z-10 lg:block before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:transition-colors hover:before:bg-accent focus-visible:before:bg-accent",
          isResizing ? "before:bg-accent" : "before:bg-line"
        )}
      />
    </aside>
  );
}

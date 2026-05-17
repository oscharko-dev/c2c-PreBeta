'use client';

import { editorPanes } from './workbenchModels';
import { CobolEditorPane } from '../source/CobolEditorPane';
import { GeneratedJavaEditorPane } from '../generated/GeneratedJavaEditorPane';
import { useResizablePane } from '../../hooks/useResizablePane';
import { cn } from '@/lib/utils';

export function SplitEditorArea() {
  const { size, minSize, maxSize, isResizing, startResize } = useResizablePane({
    id: 'editor-split',
    initialSize: 600, // Reasonable default split
    minSize: 300,
    maxSize: 1200,
    direction: 'horizontal',
  });

  return (
    <main id="studio-main-workbench" className="flex flex-1 flex-col overflow-hidden bg-bg-0" aria-label="Split Editor Area" tabIndex={-1}>
      <div className="flex min-h-10 items-center gap-3 border-b border-line px-3 py-2 shrink-0 bg-bg-1 text-sm">
        {editorPanes.map((pane, index) => (
          <div
            key={pane.id}
            className={`flex min-w-0 items-center gap-2 px-1 ${index === 0 ? 'text-text' : 'text-text-dim'}`}
          >
            <span className={`h-2 w-2 rounded-full ${index === 0 ? 'bg-accent' : 'bg-bg-3'}`} aria-hidden="true"></span>
            <span className="truncate">{pane.label}</span>
          </div>
        ))}
      </div>
      <div className="flex flex-1 overflow-hidden bg-line-2 relative group flex-col lg:flex-row">
        {/* Left Pane */}
        <section
          id="source-editor-pane"
          className="flex min-h-0 flex-col bg-bg-0 max-lg:!w-full shrink-0" 
          aria-label={editorPanes[0].label}
          style={{ width: size }}
        >
          <CobolEditorPane />
        </section>

        {/* Resize Handle (only visible on large screens) */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize Editor Split"
          aria-controls="source-editor-pane"
          aria-valuemin={minSize}
          aria-valuemax={maxSize}
          aria-valuenow={size}
          tabIndex={0}
          onMouseDown={startResize}
          onTouchStart={startResize}
          onKeyDown={startResize}
          className={cn(
            "relative hidden w-6 cursor-col-resize outline-none z-10 shrink-0 before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:transition-colors hover:before:bg-accent focus-visible:before:bg-accent lg:block",
            isResizing ? "before:bg-accent" : "before:bg-line-2"
          )}
        />

        {/* Right Pane */}
        <section className="flex min-h-0 flex-col bg-bg-0 flex-1 min-w-0" aria-label={editorPanes[1].label}>
          <GeneratedJavaEditorPane />
        </section>
      </div>
    </main>
  );
}

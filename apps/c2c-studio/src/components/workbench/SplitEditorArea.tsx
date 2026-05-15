'use client';

import { editorPanes } from './workbenchModels';
import { CobolEditorPane } from '../source/CobolEditorPane';
import { GeneratedJavaEditorPane } from '../generated/GeneratedJavaEditorPane';
import { useResizablePane } from '../../hooks/useResizablePane';
import { cn } from '@/lib/utils';

export function SplitEditorArea() {
  const { size, isResizing, startResize } = useResizablePane({
    id: 'editor-split',
    initialSize: 600, // Reasonable default split
    minSize: 300,
    maxSize: 1200,
    direction: 'horizontal',
  });

  return (
    <main className="flex flex-1 flex-col overflow-hidden bg-bg-0" aria-label="Split Editor Area">
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
          tabIndex={0}
          onMouseDown={startResize}
          onTouchStart={startResize}
          onKeyDown={startResize}
          className={cn(
            "hidden lg:block w-1 cursor-col-resize hover:bg-accent hover:w-1 focus-visible:w-1 focus-visible:bg-accent outline-none z-10 transition-colors delay-100 shrink-0",
            isResizing ? "bg-accent" : "bg-line-2"
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

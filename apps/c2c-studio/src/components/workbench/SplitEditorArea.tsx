'use client';

import { editorPanes } from './workbenchModels';
import { CobolEditorPane } from '../source/CobolEditorPane';

export function SplitEditorArea() {
  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-bg-0" aria-label="Split Editor Area">
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
      <div className="grid flex-1 gap-px overflow-auto bg-line-2 lg:grid-cols-2">
        {editorPanes.map((pane) => (
          <section key={pane.id} className="flex min-h-0 flex-col bg-bg-0" aria-label={pane.label}>
            {pane.id === 'source' ? (
              <CobolEditorPane />
            ) : (
              <>
                <div className="flex items-center justify-between border-b border-line px-4 py-2">
                  <h2 className="text-sm font-medium text-text">{pane.label}</h2>
                  <span className="rounded bg-bg-2 px-2 py-1 text-[11px] uppercase tracking-wider text-text-dim">
                    {pane.badge}
                  </span>
                </div>
                <div className="flex flex-1 items-center justify-center p-6 text-center">
                  <div className="max-w-sm space-y-2">
                    <p className="text-sm font-medium text-text">{pane.emptyState.title}</p>
                    <p className="text-sm text-text-dim">{pane.emptyState.message}</p>
                  </div>
                </div>
              </>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

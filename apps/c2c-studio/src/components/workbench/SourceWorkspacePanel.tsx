'use client';

import { useWorkbench } from '../../stores/workbench';

export function SourceWorkspacePanel() {
  const { isSourceWorkspaceOpen } = useWorkbench();

  if (!isSourceWorkspaceOpen) return null;

  return (
    <div className="hidden h-full w-64 shrink-0 flex-col overflow-hidden border-r border-line bg-bg-2 lg:flex" aria-label="Source Workspace">
      <div className="flex items-center px-4 h-10 border-b border-line-2 font-medium text-xs text-text uppercase tracking-wider">
        Source Workspace
      </div>
      <div className="flex-1 overflow-auto p-4 text-sm text-text-dim">
        <p>Source COBOL structures and metadata will appear here.</p>
      </div>
    </div>
  );
}

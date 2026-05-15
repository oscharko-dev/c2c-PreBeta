'use client';

import { useWorkbench } from '../../stores/workbench';

export function SourceWorkspacePanel() {
  const { isSourceWorkspaceOpen } = useWorkbench();

  if (!isSourceWorkspaceOpen) return null;

  return (
    <div className="flex w-64 flex-col border-r border-line bg-bg-2 shrink-0 h-full overflow-hidden" aria-label="Source Workspace">
      <div className="flex items-center px-4 h-10 border-b border-line-2 font-medium text-xs text-text uppercase tracking-wider">
        Source Workspace
      </div>
      <div className="flex-1 overflow-auto p-4 text-sm text-text-dim">
        <p>Source COBOL structures and metadata will appear here.</p>
      </div>
    </div>
  );
}

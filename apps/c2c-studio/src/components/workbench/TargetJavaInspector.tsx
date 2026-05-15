'use client';

import { useWorkbench } from '../../stores/workbench';

export function TargetJavaInspector() {
  const { isTargetInspectorOpen } = useWorkbench();

  if (!isTargetInspectorOpen) return null;

  return (
    <div className="flex w-72 flex-col border-l border-line bg-bg-2 shrink-0 h-full overflow-hidden" aria-label="Target Java Inspector">
      <div className="flex items-center px-4 h-10 border-b border-line-2 font-medium text-xs text-text uppercase tracking-wider">
        Target Java Inspector
      </div>
      <div className="flex-1 overflow-auto p-4 text-sm text-text-dim">
        <p>Java AST and transformation evidence properties will appear here.</p>
      </div>
    </div>
  );
}

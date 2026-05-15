'use client';

import { useWorkbench } from '../../stores/workbench';
import { TreeRow } from '../ui/TreeRow';

export function SecondaryStripe() {
  const { isSecondaryStripeOpen } = useWorkbench();

  if (!isSecondaryStripeOpen) return null;

  return (
    <div className="flex w-64 flex-col border-r border-line bg-bg-1 shrink-0 h-full overflow-hidden" aria-label="Secondary Stripe">
      <div className="flex items-center px-4 h-10 border-b border-line-2 font-medium text-xs uppercase tracking-wider text-text-dim">
        Explorer
      </div>
      <div className="flex-1 overflow-auto p-2">
        <TreeRow label="src" type="folder" isOpen={true} />
        <div className="pl-4">
          <TreeRow label="main" type="folder" isOpen={true} />
          <div className="pl-4">
            <TreeRow label="App.tsx" type="file" />
            <TreeRow label="utils.ts" type="file" />
          </div>
        </div>
        <TreeRow label="tests" type="folder" isOpen={false} />
        <TreeRow label="package.json" type="file" />
      </div>
    </div>
  );
}

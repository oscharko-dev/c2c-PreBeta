'use client';

import { useWorkbench } from '../../stores/workbench';
import { TreeRow } from '../ui/TreeRow';

export function SecondaryStripe() {
  const { isSecondaryStripeOpen } = useWorkbench();

  if (!isSecondaryStripeOpen) return null;

  return (
    <div className="hidden h-full w-64 shrink-0 flex-col overflow-hidden border-r border-line bg-bg-1 md:flex" aria-label="Secondary Stripe">
      <div className="flex items-center px-4 h-10 border-b border-line-2 font-medium text-xs uppercase tracking-wider text-text-dim">
        Explorer
      </div>
      <div className="flex flex-1 items-center justify-center overflow-auto p-4 text-center">
        <div className="max-w-xs space-y-2">
          <TreeRow label="Workspace tree pending" type="folder" isOpen={false} />
          <p className="text-sm font-medium text-text">No workspace tree loaded</p>
          <p className="text-sm text-text-dim">
            The source explorer will populate when the Studio session is connected to project files.
          </p>
        </div>
      </div>
    </div>
  );
}

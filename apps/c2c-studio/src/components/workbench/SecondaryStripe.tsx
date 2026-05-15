'use client';

import { useWorkbench } from '../../stores/workbench';
import { TreeRow } from '../ui/TreeRow';
import { HarnessTimeline } from '../observability/HarnessTimeline';
import { ModelGatewayPanel } from '../observability/ModelGatewayPanel';
import { ExperienceLearningPanel } from '../observability/ExperienceLearningPanel';

export function SecondaryStripe() {
  const { isSecondaryStripeOpen, activeActivityTab } = useWorkbench();

  if (!isSecondaryStripeOpen) return null;

  return (
    <aside
      id="secondary-stripe"
      className="absolute bottom-0 left-12 top-0 z-30 flex h-full w-52 shrink-0 flex-col overflow-hidden border-r border-line bg-bg-1 shadow-lg md:static md:z-auto md:w-64 md:shadow-none"
      aria-label="Secondary Stripe"
    >
      <div className="flex items-center px-4 h-10 border-b border-line-2 font-medium text-xs uppercase tracking-wider text-text-dim">
        {activeActivityTab === 'harness' ? 'Harness' : 
         activeActivityTab === 'model-gateway' ? 'Model Gateway' : 
         activeActivityTab === 'experience' ? 'Experience Learning' : 
         'Explorer'}
      </div>
      <div className="flex flex-1 flex-col overflow-auto">
        {activeActivityTab === 'explorer' && (
          <div className="flex flex-1 items-center justify-center p-4 text-center">
            <div className="max-w-xs space-y-2">
              <TreeRow label="Workspace tree pending" type="folder" isOpen={false} />
              <p className="text-sm font-medium text-text">No workspace tree loaded</p>
              <p className="text-sm text-text-dim">
                The source explorer will populate when the Studio session is connected to project files.
              </p>
            </div>
          </div>
        )}
        {activeActivityTab === 'harness' && <HarnessTimeline />}
        {activeActivityTab === 'model-gateway' && <ModelGatewayPanel />}
        {activeActivityTab === 'experience' && <ExperienceLearningPanel />}
      </div>
    </aside>
  );
}

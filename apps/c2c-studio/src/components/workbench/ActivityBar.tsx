'use client';

import { Files, Search, GitBranch, PlayCircle, Settings, Layers } from 'lucide-react';
import { useWorkbench } from '../../stores/workbench';

export function ActivityBar() {
  const { isSecondaryStripeOpen, setSecondaryStripeOpen } = useWorkbench();

  return (
    <div className="flex w-12 flex-col items-center justify-between border-r border-line bg-bg-0 py-4 shrink-0 h-full" aria-label="Activity Bar">
      <div className="flex flex-col items-center gap-4">
        <button 
          type="button"
          onClick={() => setSecondaryStripeOpen(!isSecondaryStripeOpen)}
          className={`p-2 rounded ${isSecondaryStripeOpen ? 'text-accent' : 'text-text-dim hover:text-text'}`}
          aria-label="Toggle Explorer"
        >
          <Files className="h-6 w-6" />
        </button>
        <button type="button" className="p-2 rounded text-text-dim hover:text-text" aria-label="Search workspace">
          <Search className="h-6 w-6" />
        </button>
        <button type="button" className="p-2 rounded text-text-dim hover:text-text" aria-label="Open branch activity">
          <GitBranch className="h-6 w-6" />
        </button>
        <button type="button" className="p-2 rounded text-text-dim hover:text-text" aria-label="Open run activity">
          <PlayCircle className="h-6 w-6" />
        </button>
        <button type="button" className="p-2 rounded text-text-dim hover:text-text" aria-label="Open artifact layers">
          <Layers className="h-6 w-6" />
        </button>
      </div>
      <div className="flex flex-col items-center gap-4">
        <button type="button" className="p-2 rounded text-text-dim hover:text-text" aria-label="Open activity settings">
          <Settings className="h-6 w-6" />
        </button>
      </div>
    </div>
  );
}

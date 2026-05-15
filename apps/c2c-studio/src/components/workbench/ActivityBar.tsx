'use client';

import { Files, Search, GitBranch, PlayCircle, Settings, Layers, Activity, Server, GraduationCap } from 'lucide-react';
import { useWorkbench } from '../../stores/workbench';

export function ActivityBar() {
  const { isSecondaryStripeOpen, setSecondaryStripeOpen, activeActivityTab, setActiveActivityTab } = useWorkbench();

  const toggleTab = (tab: string) => {
    if (isSecondaryStripeOpen && activeActivityTab === tab) {
      setSecondaryStripeOpen(false);
    } else {
      setActiveActivityTab(tab);
      setSecondaryStripeOpen(true);
    }
  };

  return (
    <div className="flex w-12 flex-col items-center justify-between border-r border-line bg-bg-0 py-4 shrink-0 h-full" aria-label="Activity Bar">
      <div className="flex flex-col items-center gap-4">
        <button 
          type="button"
          onClick={() => toggleTab('explorer')}
          className={`p-2 rounded ${isSecondaryStripeOpen && activeActivityTab === 'explorer' ? 'text-accent' : 'text-text-dim hover:text-text'}`}
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
        <button type="button" onClick={() => toggleTab('harness')} className={`p-2 rounded ${isSecondaryStripeOpen && activeActivityTab === 'harness' ? 'text-accent' : 'text-text-dim hover:text-text'}`} aria-label="Open Harness observability">
          <Activity className="h-6 w-6" />
        </button>
        <button type="button" onClick={() => toggleTab('model-gateway')} className={`p-2 rounded ${isSecondaryStripeOpen && activeActivityTab === 'model-gateway' ? 'text-accent' : 'text-text-dim hover:text-text'}`} aria-label="Open Model Gateway observability">
          <Server className="h-6 w-6" />
        </button>
        <button type="button" onClick={() => toggleTab('experience')} className={`p-2 rounded ${isSecondaryStripeOpen && activeActivityTab === 'experience' ? 'text-accent' : 'text-text-dim hover:text-text'}`} aria-label="Open Experience Learning observability">
          <GraduationCap className="h-6 w-6" />
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

'use client';

import { Files, Search, GitBranch, PlayCircle, Settings, Layers, Activity, Server, GraduationCap } from 'lucide-react';
import { useWorkbench } from '../../stores/workbench';

const inactiveButtonClass = 'p-2 rounded border-l-2 border-transparent text-text-dim hover:text-text hover:bg-bg-hover';
const activeButtonClass = 'p-2 rounded border-l-2 border-accent bg-bg-active text-accent';
const disabledButtonClass = `${inactiveButtonClass} cursor-not-allowed opacity-50 hover:bg-transparent hover:text-text-dim`;

export function ActivityBar() {
  const { isSecondaryStripeOpen, setSecondaryStripeOpen, activeActivityTab, setActiveActivityTab } = useWorkbench();
  const secondaryStripeControls = isSecondaryStripeOpen ? 'secondary-stripe' : undefined;

  const toggleTab = (tab: string) => {
    if (isSecondaryStripeOpen && activeActivityTab === tab) {
      setSecondaryStripeOpen(false);
    } else {
      setActiveActivityTab(tab);
      setSecondaryStripeOpen(true);
    }
  };

  return (
    <nav className="flex w-12 flex-col items-center justify-between border-r border-line bg-bg-0 py-4 shrink-0 h-full" aria-label="Activity Bar">
      <div className="flex flex-col items-center gap-4">
        <button 
          type="button"
          onClick={() => toggleTab('explorer')}
          className={isSecondaryStripeOpen && activeActivityTab === 'explorer' ? activeButtonClass : inactiveButtonClass}
          aria-label="Toggle Explorer"
          aria-controls={secondaryStripeControls}
          aria-expanded={isSecondaryStripeOpen && activeActivityTab === 'explorer'}
        >
          <Files className="h-6 w-6" />
        </button>
        <button type="button" className={disabledButtonClass} aria-label="Search workspace unavailable" disabled>
          <Search className="h-6 w-6" />
        </button>
        <button type="button" className={disabledButtonClass} aria-label="Branch activity unavailable" disabled>
          <GitBranch className="h-6 w-6" />
        </button>
        <button type="button" className={disabledButtonClass} aria-label="Run activity unavailable" disabled>
          <PlayCircle className="h-6 w-6" />
        </button>
        <button type="button" className={disabledButtonClass} aria-label="Artifact layers unavailable" disabled>
          <Layers className="h-6 w-6" />
        </button>
        <button type="button" onClick={() => toggleTab('harness')} className={isSecondaryStripeOpen && activeActivityTab === 'harness' ? activeButtonClass : inactiveButtonClass} aria-label="Open Harness observability" aria-controls={secondaryStripeControls} aria-expanded={isSecondaryStripeOpen && activeActivityTab === 'harness'}>
          <Activity className="h-6 w-6" />
        </button>
        <button type="button" onClick={() => toggleTab('model-gateway')} className={isSecondaryStripeOpen && activeActivityTab === 'model-gateway' ? activeButtonClass : inactiveButtonClass} aria-label="Open Model Gateway observability" aria-controls={secondaryStripeControls} aria-expanded={isSecondaryStripeOpen && activeActivityTab === 'model-gateway'}>
          <Server className="h-6 w-6" />
        </button>
        <button type="button" onClick={() => toggleTab('experience')} className={isSecondaryStripeOpen && activeActivityTab === 'experience' ? activeButtonClass : inactiveButtonClass} aria-label="Open Experience Learning observability" aria-controls={secondaryStripeControls} aria-expanded={isSecondaryStripeOpen && activeActivityTab === 'experience'}>
          <GraduationCap className="h-6 w-6" />
        </button>
      </div>
      <div className="flex flex-col items-center gap-4">
        <button type="button" className={disabledButtonClass} aria-label="Activity settings unavailable" disabled>
          <Settings className="h-6 w-6" />
        </button>
      </div>
    </nav>
  );
}

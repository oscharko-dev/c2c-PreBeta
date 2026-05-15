'use client';

import { useWorkbench } from '../../stores/workbench';

export function BottomWorkbench() {
  const { isBottomPanelOpen, activeBottomTab, setActiveBottomTab, setBottomPanelOpen } = useWorkbench();

  if (!isBottomPanelOpen) return null;

  const tabs = [
    { id: 'run', label: 'Run' },
    { id: 'build-test', label: 'Build & Test' },
    { id: 'evidence', label: 'Evidence Pack' },
    { id: 'learning', label: 'Experience Learning' },
    { id: 'problems', label: 'Problems' },
  ];

  return (
    <div className="flex h-64 flex-col border-t border-line bg-bg-1 shrink-0 w-full" aria-label="Bottom Workbench">
      <div className="flex h-10 items-center justify-between border-b border-line-2 px-2 shrink-0 bg-bg-2">
        <div className="flex h-full" role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={activeBottomTab === tab.id}
              onClick={() => setActiveBottomTab(tab.id)}
              className={`flex h-full items-center px-4 text-xs font-medium uppercase tracking-wider transition-colors ${
                activeBottomTab === tab.id
                  ? 'border-b-2 border-accent text-text'
                  : 'text-text-dim hover:text-text'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => setBottomPanelOpen(false)}
          className="p-1.5 text-text-dim hover:text-text rounded hover:bg-bg-3"
          aria-label="Close Bottom Panel"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      </div>
      <div className="flex-1 overflow-auto p-4 text-sm text-text-dim">
        {activeBottomTab === 'run' && <p>Run output logs will appear here.</p>}
        {activeBottomTab === 'build-test' && <p>Build and test results will appear here.</p>}
        {activeBottomTab === 'evidence' && <p>Evidence pack details.</p>}
        {activeBottomTab === 'learning' && <p>Experience learning metrics.</p>}
        {activeBottomTab === 'problems' && <p>No problems found.</p>}
      </div>
    </div>
  );
}

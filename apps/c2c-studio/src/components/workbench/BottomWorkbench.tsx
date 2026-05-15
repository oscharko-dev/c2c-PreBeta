'use client';

import { useTransformationRun } from '../../stores/transformationRun';
import { useWorkbench } from '../../stores/workbench';
import { Tabs } from '../ui/Tabs';
import { bottomWorkbenchTabs } from './workbenchModels';
import { RunLifecyclePanel } from '../run/RunLifecyclePanel';
import { BuildTestPanel } from '../run/BuildTestPanel';
import { EvidencePackPanel } from '../run/EvidencePackPanel';
import { ProblemsPanel } from '../run/ProblemsPanel';
import { RunArtifactsPanel } from '../run/RunArtifactsPanel';
import { ExperienceLearningPanel } from '../observability/ExperienceLearningPanel';

export function BottomWorkbench() {
  const { isBottomPanelOpen, activeBottomTab, setActiveBottomTab, setBottomPanelOpen } = useWorkbench();
  const { state } = useTransformationRun();

  if (!isBottomPanelOpen) return null;
  const activeTab = bottomWorkbenchTabs.find((tab) => tab.id === activeBottomTab) ?? bottomWorkbenchTabs[0];

  return (
    <div className="flex h-64 flex-col border-t border-line bg-bg-1 shrink-0 w-full" aria-label="Bottom Workbench">
      <div className="flex min-h-10 items-center justify-between gap-2 border-b border-line-2 px-2 py-1 shrink-0 bg-bg-2">
        <Tabs
          value={activeTab.id}
          onValueChange={(value) => setActiveBottomTab(value)}
          tabs={bottomWorkbenchTabs.map((tab) => ({ value: tab.id, label: tab.label }))}
          idBase="bottom-workbench"
          className="min-w-0 flex-1 overflow-x-auto border-0 bg-transparent p-0"
        />
        <button
          type="button"
          onClick={() => setBottomPanelOpen(false)}
          className="p-1.5 text-text-dim hover:text-text rounded hover:bg-bg-3"
          aria-label="Close Bottom Panel"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      </div>
      <div
        id={`bottom-workbench-panel-${activeTab.id}`}
        role="tabpanel"
        aria-labelledby={`bottom-workbench-tab-${activeTab.id}`}
        className="flex-1 overflow-auto bg-bg-1"
      >
        {activeTab.id === 'run' && <RunLifecyclePanel emptyState={activeTab.emptyState} />}
        {activeTab.id === 'build-test' && <BuildTestPanel emptyState={activeTab.emptyState} />}
        {activeTab.id === 'artifacts' && (
          state.phase === 'idle' ? (
            <div className="p-4 space-y-2 text-sm">
              <p className="font-medium text-text">{activeTab.emptyState.title}</p>
              <p className="text-text-dim">{activeTab.emptyState.message}</p>
            </div>
          ) : (
            <RunArtifactsPanel
              artifacts={state.artifacts?.artifacts}
              missingArtifacts={state.artifacts?.missingArtifacts}
              errorMessage={state.artifactsError}
            />
          )
        )}
        {activeTab.id === 'evidence' && <EvidencePackPanel emptyState={activeTab.emptyState} />}
        {activeTab.id === 'problems' && <ProblemsPanel emptyState={activeTab.emptyState} />}
        {activeTab.id === 'learning' && (
          state.phase === 'idle' ? (
            <div className="p-4 space-y-2 text-sm">
              <p className="font-medium text-text">{activeTab.emptyState.title}</p>
              <p className="text-text-dim">{activeTab.emptyState.message}</p>
            </div>
          ) : (
            <ExperienceLearningPanel />
          )
        )}
      </div>
    </div>
  );
}

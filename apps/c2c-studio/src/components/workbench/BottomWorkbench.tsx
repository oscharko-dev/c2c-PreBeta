'use client';

import { useTransformationRun } from '../../stores/transformationRun';
import { useWorkbench } from '../../stores/workbench';
import { Tabs } from '../ui/Tabs';
import { bottomWorkbenchTabs } from './workbenchModels';
import { RunLifecyclePanel } from '../run/RunLifecyclePanel';
import { AgentActivityPanel } from '../run/AgentActivityPanel';
import { BuildTestPanel } from '../run/BuildTestPanel';
import { EvidencePackPanel } from '../run/EvidencePackPanel';
import { ProblemsPanel } from '../run/ProblemsPanel';
import { RunArtifactsPanel } from '../run/RunArtifactsPanel';
import { ExperienceLearningPanel } from '../observability/ExperienceLearningPanel';
import { useResizablePane } from '../../hooks/useResizablePane';
import { cn } from '@/lib/utils';

export function BottomWorkbench() {
  const { isBottomPanelOpen, activeBottomTab, setActiveBottomTab, setBottomPanelOpen } = useWorkbench();
  const { state } = useTransformationRun();

  const { size, minSize, maxSize, isResizing, startResize } = useResizablePane({
    id: 'bottom-workbench',
    initialSize: 256, // h-64 is 256px
    minSize: 100,
    maxSize: 600,
    direction: 'vertical',
    reverse: true,
  });

  if (!isBottomPanelOpen) return null;
  const activeTab = bottomWorkbenchTabs.find((tab) => tab.id === activeBottomTab) ?? bottomWorkbenchTabs[0];

  return (
    <section
      id="bottom-workbench-region"
      className="flex flex-col border-t border-line bg-bg-1 shrink-0 w-full relative group" 
      aria-label="Bottom Workbench"
      style={{ height: size }}
    >
      {/* Resize Handle */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize Bottom Workbench"
        aria-controls="bottom-workbench-region"
        aria-valuemin={minSize}
        aria-valuemax={maxSize}
        aria-valuenow={size}
        tabIndex={0}
        onMouseDown={startResize}
        onTouchStart={startResize}
        onKeyDown={startResize}
        className={cn(
          "absolute -top-3 left-0 right-0 h-6 cursor-row-resize outline-none z-10 before:absolute before:left-0 before:right-0 before:top-1/2 before:h-px before:-translate-y-1/2 before:transition-colors hover:before:bg-accent focus-visible:before:bg-accent",
          isResizing ? "before:bg-accent" : "before:bg-line"
        )}
      />

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
        {activeTab.id === 'agent' && <AgentActivityPanel emptyState={activeTab.emptyState} />}
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
    </section>
  );
}

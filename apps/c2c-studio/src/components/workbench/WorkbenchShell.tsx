'use client';

import { WorkbenchProvider } from '../../stores/workbench';
import { SourceWorkspaceProvider } from '../../stores/sourceWorkspace';
import { TransformationRunProvider } from '../../stores/transformationRun';
import { useC2cApi } from '../../hooks/useC2cApi';
import { GeneratedArtifactsProvider } from '../../hooks/useGeneratedArtifacts';
import { AppTopBar } from './AppTopBar';
import { ActivityBar } from './ActivityBar';
import { SecondaryStripe } from './SecondaryStripe';
import { SourceWorkspacePanel } from './SourceWorkspacePanel';
import { SplitEditorArea } from './SplitEditorArea';
import { TargetJavaInspector } from '../generated/TargetJavaInspector';
import { BottomWorkbench } from './BottomWorkbench';
import { StatusBar } from './StatusBar';
import { RightObservabilityStripe } from '../observability/RightObservabilityStripe';

export function WorkbenchShell() {
  const apiState = useC2cApi();

  return (
    <WorkbenchProvider>
      <TransformationRunProvider>
        <SourceWorkspaceProvider>
          <GeneratedArtifactsProvider>
            <div className="flex min-h-screen w-full flex-col overflow-hidden bg-bg-0 text-text font-ui" role="application" aria-label="c2c Studio Workbench">
              <a
                href="#studio-main-workbench"
                className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded focus:border focus:border-accent focus:bg-bg-1 focus:px-3 focus:py-2 focus:text-sm focus:text-text-bright"
              >
                Skip to transformation workbench
              </a>
              <AppTopBar apiState={apiState} />
              <div className="relative flex flex-1 overflow-hidden">
                <ActivityBar />
                <SecondaryStripe />
                <div className="flex flex-1 flex-col min-w-0">
                  <div className="relative flex flex-1 overflow-hidden">
                    <SourceWorkspacePanel />
                    <SplitEditorArea />
                    <TargetJavaInspector />
                  </div>
                  <BottomWorkbench />
                </div>
                <RightObservabilityStripe />
              </div>
              <StatusBar apiState={apiState} />
            </div>
          </GeneratedArtifactsProvider>
        </SourceWorkspaceProvider>
      </TransformationRunProvider>
    </WorkbenchProvider>
  );
}

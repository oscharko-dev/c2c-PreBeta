'use client';

import { WorkbenchProvider } from '../../stores/workbench';
import { SourceWorkspaceProvider } from '../../stores/sourceWorkspace';
import { useC2cApi } from '../../hooks/useC2cApi';
import { AppTopBar } from './AppTopBar';
import { ActivityBar } from './ActivityBar';
import { SecondaryStripe } from './SecondaryStripe';
import { SourceWorkspacePanel } from './SourceWorkspacePanel';
import { SplitEditorArea } from './SplitEditorArea';
import { TargetJavaInspector } from './TargetJavaInspector';
import { BottomWorkbench } from './BottomWorkbench';
import { StatusBar } from './StatusBar';

export function WorkbenchShell() {
  const apiState = useC2cApi();

  return (
    <WorkbenchProvider>
      <SourceWorkspaceProvider>
        <div className="flex min-h-screen w-full flex-col overflow-hidden bg-bg-0 text-text font-ui">
          <AppTopBar apiState={apiState} />
          <div className="flex flex-1 overflow-hidden">
            <ActivityBar />
            <SecondaryStripe />
            <div className="flex flex-1 flex-col min-w-0">
              <div className="flex flex-1 overflow-hidden">
                <SourceWorkspacePanel />
                <SplitEditorArea />
                <TargetJavaInspector />
              </div>
              <BottomWorkbench />
            </div>
          </div>
          <StatusBar apiState={apiState} />
        </div>
      </SourceWorkspaceProvider>
    </WorkbenchProvider>
  );
}

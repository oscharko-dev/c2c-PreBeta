'use client';

import { WorkbenchProvider } from '../../stores/workbench';
import { AppTopBar } from './AppTopBar';
import { ActivityBar } from './ActivityBar';
import { SecondaryStripe } from './SecondaryStripe';
import { SourceWorkspacePanel } from './SourceWorkspacePanel';
import { SplitEditorArea } from './SplitEditorArea';
import { TargetJavaInspector } from './TargetJavaInspector';
import { BottomWorkbench } from './BottomWorkbench';
import { StatusBar } from './StatusBar';

export function WorkbenchShell() {
  return (
    <WorkbenchProvider>
      <div className="flex flex-col h-screen w-screen overflow-hidden bg-bg-0 text-text font-ui">
        <AppTopBar />
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
        <StatusBar />
      </div>
    </WorkbenchProvider>
  );
}

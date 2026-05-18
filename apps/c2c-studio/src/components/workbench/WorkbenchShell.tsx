"use client";

import { useEffect } from "react";
import { WorkbenchProvider } from "@/stores/workbench";
import { SourceWorkspaceProvider } from "@/stores/sourceWorkspace";
import { TransformationRunProvider } from "@/stores/transformationRun";
import { useC2cApi } from "@/hooks/useC2cApi";
import { GeneratedArtifactsProvider } from "@/hooks/useGeneratedArtifacts";
import { AppTopBar } from "@/components/workbench/AppTopBar";
import { ActivityBar } from "@/components/workbench/ActivityBar";
import { SecondaryStripe } from "@/components/workbench/SecondaryStripe";
import { SplitEditorArea } from "@/components/workbench/SplitEditorArea";
import { TargetJavaInspector } from "@/components/generated/TargetJavaInspector";
import { BottomWorkbench } from "@/components/workbench/BottomWorkbench";
import { StatusBar } from "@/components/workbench/StatusBar";
import { RightObservabilityStripe } from "@/components/observability/RightObservabilityStripe";
import { editorPersistence } from "@/lib/editor/editorPersistence";
import { OriginOverlayProvider } from "@/lib/editor/originOverlay";
import { MarkerNavigationProvider } from "@/lib/editor/markerNavigation";
import { JavaEditorActionsProvider } from "@/stores/javaEditorActions";
import { LineageCoverageProvider } from "@/stores/lineageCoverage";
import { useMarkerNavigationShortcuts } from "@/hooks/useMarkerNavigationShortcuts";
import { EditorAssistProvider, useEditorAssist } from "@/stores/editorAssist";
import { EditorAssistSidePanel } from "@/components/observability/EditorAssistSidePanel";

export function WorkbenchShell() {
  const apiState = useC2cApi();

  // Studio-IDE-3 (#247) / ADR-2 §1: purge expired drafts on Studio start.
  // Fire-and-forget; IndexedDB is unavailable in some test environments
  // and the rest of the workbench should keep functioning if the purge
  // fails.
  useEffect(() => {
    void editorPersistence.purgeExpired().catch(() => {
      // Ignored — see comment above.
    });
  }, []);

  return (
    <WorkbenchProvider>
      <TransformationRunProvider>
        <SourceWorkspaceProvider>
          <GeneratedArtifactsProvider>
            <OriginOverlayProvider>
              <LineageCoverageProvider>
                <MarkerNavigationProvider>
                  <JavaEditorActionsProvider>
                    {/* Studio-IDE-10 (#249): the Editor-Assist store is
                        scoped at the WorkbenchShell level so both editor
                        panes (COBOL + Java) and the side panel host
                        share a single `(request, result, budget)`
                        slot. */}
                    <EditorAssistProvider>
                      <WorkbenchShellBody apiState={apiState} />
                    </EditorAssistProvider>
                  </JavaEditorActionsProvider>
                </MarkerNavigationProvider>
              </LineageCoverageProvider>
            </OriginOverlayProvider>
          </GeneratedArtifactsProvider>
        </SourceWorkspaceProvider>
      </TransformationRunProvider>
    </WorkbenchProvider>
  );
}

// Studio-IDE-10 (#249): the side-panel host bridges the editorAssist
// store to the `EditorAssistSidePanel` component. Hoisting this into a
// small wrapper lets us read the context inside the WorkbenchShell tree
// without prop drilling.
function EditorAssistPanelHost() {
  const { panelOpen, request, result, closePanel, retry } = useEditorAssist();
  return (
    <EditorAssistSidePanel
      open={panelOpen}
      request={request}
      result={result}
      onClose={closePanel}
      onRetry={() => {
        void retry();
      }}
    />
  );
}

function WorkbenchShellBody({
  apiState,
}: {
  apiState: ReturnType<typeof useC2cApi>;
}) {
  // Studio-IDE-5 (#244): install global F8 / Shift+F8 shortcuts inside
  // the MarkerNavigationProvider so the handler can dispatch to the
  // active editor without prop drilling.
  useMarkerNavigationShortcuts();

  return (
    <div
      className="flex h-[100dvh] max-h-[100dvh] min-h-0 w-full flex-col overflow-hidden bg-bg-0 text-text font-ui"
      data-testid="studio-workbench-shell"
    >
      <a
        href="#studio-main-workbench"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded focus:border focus:border-accent focus:bg-bg-1 focus:px-3 focus:py-2 focus:text-sm focus:text-text-bright"
      >
        Skip to transformation workbench
      </a>
      <AppTopBar apiState={apiState} />
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <ActivityBar />
        <SecondaryStripe />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="relative flex min-h-0 flex-1 overflow-hidden">
            <SplitEditorArea />
          </div>
          <BottomWorkbench />
        </div>
        <TargetJavaInspector />
        <EditorAssistPanelHost />
        <RightObservabilityStripe />
      </div>
      <StatusBar apiState={apiState} />
    </div>
  );
}

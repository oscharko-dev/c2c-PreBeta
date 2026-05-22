export type BottomWorkbenchTabId =
  | "run"
  | "agent"
  | "build-test"
  | "artifacts"
  | "evidence"
  | "learning"
  | "problems";

export interface BottomWorkbenchTabModel {
  id: BottomWorkbenchTabId;
  label: string;
  emptyState: {
    title: string;
    message: string;
  };
}

export interface EditorPaneModel {
  id: "source" | "target";
  label: string;
  badge: string;
  emptyState: {
    title: string;
    message: string;
  };
}

export const bottomWorkbenchTabs: BottomWorkbenchTabModel[] = [
  {
    id: "run",
    label: "Run",
    emptyState: {
      title: "No run active",
      message:
        "Run output will appear here after the backend reports an active transformation.",
    },
  },
  {
    id: "agent",
    label: "Agent",
    emptyState: {
      title: "No agent activity yet",
      message:
        "Active agent, repair attempts, and model invocation metadata will appear here once a W0.2 run is in progress.",
    },
  },
  {
    id: "build-test",
    label: "Build & Test",
    emptyState: {
      title: "No build results yet",
      message:
        "Build and test results will appear here after a transformation completes.",
    },
  },
  {
    id: "artifacts",
    label: "Artifacts",
    emptyState: {
      title: "No artifacts available",
      message:
        "Run artifacts will appear here when the active run publishes them.",
    },
  },
  {
    id: "evidence",
    label: "Evidence Pack",
    emptyState: {
      title: "No evidence pack loaded",
      message:
        "Evidence pack metadata will appear here when the active run publishes artifacts.",
    },
  },
  {
    id: "learning",
    label: "Experience Learning",
    emptyState: {
      title: "No experience learning data yet",
      message:
        "Experience learning metrics will appear here when the backend returns them.",
    },
  },
  {
    id: "problems",
    label: "Problems",
    emptyState: {
      title: "No diagnostics loaded",
      message:
        "Compiler, validation, and runtime diagnostics will appear here when the backend returns them.",
    },
  },
];

export const editorPanes: EditorPaneModel[] = [
  {
    id: "source",
    label: "COBOL Source",
    badge: "Awaiting Source",
    emptyState: {
      title: "No source file selected",
      message:
        "Source COBOL content will appear here when an active run exposes source files.",
    },
  },
  {
    id: "target",
    label: "Generated Java",
    badge: "Awaiting Target",
    emptyState: {
      title: "No generated target file available",
      message:
        "Generated Java output will appear here when the backend returns transformed files.",
    },
  },
];

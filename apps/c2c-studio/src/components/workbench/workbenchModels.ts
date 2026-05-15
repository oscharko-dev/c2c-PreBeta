export type BottomWorkbenchTabId = 'run' | 'build-test' | 'evidence' | 'learning' | 'problems';

export interface BottomWorkbenchTabModel {
  id: BottomWorkbenchTabId;
  label: string;
  emptyState: {
    title: string;
    message: string;
  };
}

export interface EditorPaneModel {
  id: 'source' | 'target';
  label: string;
  badge: string;
  emptyState: {
    title: string;
    message: string;
  };
}

export const bottomWorkbenchTabs: BottomWorkbenchTabModel[] = [
  {
    id: 'run',
    label: 'Run',
    emptyState: {
      title: 'No run active',
      message: 'Run output will appear here after the backend reports an active transformation.',
    },
  },
  {
    id: 'build-test',
    label: 'Build & Test',
    emptyState: {
      title: 'No build results yet',
      message: 'Build and test results will appear here after a transformation completes.',
    },
  },
  {
    id: 'evidence',
    label: 'Evidence Pack',
    emptyState: {
      title: 'No evidence pack loaded',
      message: 'Evidence pack metadata will appear here when the active run publishes artifacts.',
    },
  },
  {
    id: 'learning',
    label: 'Experience Learning',
    emptyState: {
      title: 'No experience learning data yet',
      message: 'Experience learning metrics will appear here when the backend returns them.',
    },
  },
  {
    id: 'problems',
    label: 'Problems',
    emptyState: {
      title: 'No diagnostics loaded',
      message: 'Compiler, validation, and runtime diagnostics will appear here when the backend returns them.',
    },
  },
];

export const editorPanes: EditorPaneModel[] = [
  {
    id: 'source',
    label: 'COBOL Source',
    badge: 'Awaiting Source',
    emptyState: {
      title: 'No source file selected',
      message: 'Source COBOL content will appear here when an active run exposes source files.',
    },
  },
  {
    id: 'target',
    label: 'Generated Java',
    badge: 'Awaiting Target',
    emptyState: {
      title: 'No generated target file available',
      message: 'Generated Java output will appear here when the backend returns transformed files.',
    },
  },
];

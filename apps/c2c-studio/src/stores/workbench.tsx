import { createContext, useContext, useState, ReactNode } from 'react';

interface WorkbenchState {
  isSecondaryStripeOpen: boolean;
  isSourceWorkspaceOpen: boolean;
  isTargetInspectorOpen: boolean;
  isBottomPanelOpen: boolean;
  activeBottomTab: string;
  setSecondaryStripeOpen: (open: boolean) => void;
  setSourceWorkspaceOpen: (open: boolean) => void;
  setTargetInspectorOpen: (open: boolean) => void;
  setBottomPanelOpen: (open: boolean) => void;
  setActiveBottomTab: (tab: string) => void;
}

const WorkbenchContext = createContext<WorkbenchState | null>(null);

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const [isSecondaryStripeOpen, setSecondaryStripeOpen] = useState(true);
  const [isSourceWorkspaceOpen, setSourceWorkspaceOpen] = useState(true);
  const [isTargetInspectorOpen, setTargetInspectorOpen] = useState(true);
  const [isBottomPanelOpen, setBottomPanelOpen] = useState(true);
  const [activeBottomTab, setActiveBottomTab] = useState('run');

  return (
    <WorkbenchContext.Provider
      value={{
        isSecondaryStripeOpen,
        isSourceWorkspaceOpen,
        isTargetInspectorOpen,
        isBottomPanelOpen,
        activeBottomTab,
        setSecondaryStripeOpen,
        setSourceWorkspaceOpen,
        setTargetInspectorOpen,
        setBottomPanelOpen,
        setActiveBottomTab,
      }}
    >
      {children}
    </WorkbenchContext.Provider>
  );
}

export function useWorkbench() {
  const context = useContext(WorkbenchContext);
  if (!context) {
    throw new Error('useWorkbench must be used within a WorkbenchProvider');
  }
  return context;
}

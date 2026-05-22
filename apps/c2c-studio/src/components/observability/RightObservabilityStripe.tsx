import {
  FileText,
  Search,
  PlayCircle,
  Shield,
  Database,
  GraduationCap,
  Box,
  Bell,
} from "lucide-react";
import { useWorkbench } from "../../stores/workbench";

const bottomTabMapping: Record<string, string> = {
  evidence: "evidence",
  build: "build-test",
  artifacts: "artifacts",
  "experience-learning": "learning",
};

export function RightObservabilityStripe() {
  const {
    activeBottomTab,
    isBottomPanelOpen,
    setActiveBottomTab,
    setBottomPanelOpen,
  } = useWorkbench();

  const handleShortcutClick = (id: string) => {
    const mappedTab = bottomTabMapping[id];
    if (mappedTab) {
      setActiveBottomTab(mappedTab);
      setBottomPanelOpen(true);
    }
  };
  const items = [
    { id: "evidence", icon: FileText, label: "Evidence" },
    { id: "traceability", icon: Search, label: "Traceability" },
    { id: "build", icon: PlayCircle, label: "Build" },
    { id: "compliance", icon: Shield, label: "Compliance" },
    { id: "model-ledger", icon: Database, label: "Model Ledger" },
    {
      id: "experience-learning",
      icon: GraduationCap,
      label: "Experience Learning",
    },
    { id: "artifacts", icon: Box, label: "Artifacts" },
    { id: "notifications", icon: Bell, label: "Notifications" },
  ];

  return (
    <aside
      className="flex w-12 shrink-0 self-stretch flex-col items-center border-l border-line bg-bg-0 py-4"
      aria-label="Observability Shortcuts"
    >
      <div className="flex flex-col items-center gap-4">
        {items.map((item) => {
          const Icon = item.icon;
          const mappedTab = bottomTabMapping[item.id];
          const isActive = Boolean(
            mappedTab && isBottomPanelOpen && activeBottomTab === mappedTab,
          );
          const canOpen = Boolean(mappedTab);
          return (
            <button
              key={item.id}
              type="button"
              onClick={canOpen ? () => handleShortcutClick(item.id) : undefined}
              className={
                isActive
                  ? "p-2 rounded border-l-2 border-accent bg-bg-active text-accent"
                  : `p-2 rounded border-l-2 border-transparent text-text-dim ${canOpen ? "hover:text-text hover:bg-bg-hover" : "cursor-not-allowed opacity-50"}`
              }
              aria-label={
                canOpen ? `Open ${item.label}` : `${item.label} unavailable`
              }
              aria-controls={
                canOpen && isBottomPanelOpen
                  ? "bottom-workbench-region"
                  : undefined
              }
              aria-current={isActive ? "page" : undefined}
              aria-expanded={canOpen ? isActive : undefined}
              disabled={!canOpen}
              title={item.label}
            >
              <Icon className="h-5 w-5" />
            </button>
          );
        })}
      </div>
    </aside>
  );
}

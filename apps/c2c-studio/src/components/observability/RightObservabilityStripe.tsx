import { FileText, Search, PlayCircle, Shield, Database, GraduationCap, Box, Bell } from 'lucide-react';
import { useWorkbench } from '../../stores/workbench';

export function RightObservabilityStripe() {
  const { setActiveBottomTab, setBottomPanelOpen } = useWorkbench();
  
  const handleShortcutClick = (id: string) => {
    const bottomTabMapping: Record<string, string> = {
      'evidence': 'evidence',
      'build': 'build-test',
      'artifacts': 'artifacts',
      'experience-learning': 'learning',
    };
    if (bottomTabMapping[id]) {
      setActiveBottomTab(bottomTabMapping[id]);
      setBottomPanelOpen(true);
    }
  };
  const items = [
    { id: 'evidence', icon: FileText, label: 'Evidence' },
    { id: 'traceability', icon: Search, label: 'Traceability' },
    { id: 'build', icon: PlayCircle, label: 'Build' },
    { id: 'compliance', icon: Shield, label: 'Compliance' },
    { id: 'model-ledger', icon: Database, label: 'Model Ledger' },
    { id: 'experience-learning', icon: GraduationCap, label: 'Experience Learning' },
    { id: 'artifacts', icon: Box, label: 'Artifacts' },
    { id: 'notifications', icon: Bell, label: 'Notifications' },
  ];

  return (
    <div className="flex w-12 flex-col items-center border-l border-line bg-bg-0 py-4 shrink-0 h-full" aria-label="Observability Shortcuts">
      <div className="flex flex-col items-center gap-4">
        {items.map(item => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => handleShortcutClick(item.id)}
              className="p-2 rounded text-text-dim hover:text-text"
              aria-label={`Open ${item.label}`}
              title={item.label}
            >
              <Icon className="h-5 w-5" />
            </button>
          );
        })}
      </div>
    </div>
  );
}
import React from "react";
import { Panel } from "../ui/Panel";

interface UnsupportedConstructsPanelProps {
  constructs: string[];
}

export function UnsupportedConstructsPanel({
  constructs,
}: UnsupportedConstructsPanelProps) {
  if (!constructs || constructs.length === 0) return null;

  return (
    <Panel className="p-4 bg-orange-50 border border-orange-200 text-orange-900 mt-4">
      <h3 className="font-semibold mb-2 text-sm">
        Unsupported Features (W0 Scope)
      </h3>
      <ul className="list-disc pl-5 text-sm space-y-1">
        {constructs.map((construct, index) => (
          <li key={index}>{construct}</li>
        ))}
      </ul>
      <div className="mt-3 text-xs opacity-80">
        These features are not supported in the current target runtime scope.
      </div>
    </Panel>
  );
}

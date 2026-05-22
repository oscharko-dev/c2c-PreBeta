import React from "react";
import { Panel } from "../ui/Panel";

interface MissingArtifactsPanelProps {
  artifacts: string[];
}

export function MissingArtifactsPanel({
  artifacts,
}: MissingArtifactsPanelProps) {
  if (!artifacts || artifacts.length === 0) return null;

  return (
    <Panel className="p-4 bg-yellow-50 border border-yellow-200 text-yellow-900 mt-4">
      <h3 className="font-semibold mb-2 text-sm">Missing Expected Artifacts</h3>
      <ul className="list-disc pl-5 text-sm space-y-1">
        {artifacts.map((artifact, index) => (
          <li key={index}>{artifact}</li>
        ))}
      </ul>
      <div className="mt-3 text-xs opacity-80">
        The response was incomplete. Expected artifacts were not found.
      </div>
    </Panel>
  );
}

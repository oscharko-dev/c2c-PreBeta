import React from "react";
import { Panel } from "../ui/Panel";

export function EmptyState({
  message = "No source selected",
}: {
  message?: string;
}) {
  return (
    <Panel className="flex items-center justify-center p-8 text-neutral-500 italic">
      {message}
    </Panel>
  );
}

import React from 'react';
import { Panel } from '../ui/Panel';

interface BlockedStateProps {
  reason: string;
  details?: string;
}

export function BlockedState({ reason, details }: BlockedStateProps) {
  return (
    <Panel className="flex flex-col items-center justify-center p-8 bg-red-50 text-red-900 border border-red-200">
      <div className="font-semibold text-lg mb-2">Blocked: {reason}</div>
      {details && <div className="text-sm opacity-80">{details}</div>}
    </Panel>
  );
}

'use client';

import { useC2cApi } from '../../hooks/useC2cApi';

export function StatusBar() {
  const { health, loading } = useC2cApi();

  const isHealthy = health?.status === 'ok';

  return (
    <div className="flex h-6 items-center justify-between border-t border-line bg-accent-dim px-3 text-xs text-text-bright shrink-0" aria-label="Status Bar">
      <div className="flex items-center gap-4">
        <span>c2c Studio</span>
        <span className="opacity-75">No run active</span>
      </div>
      <div className="flex items-center gap-4">
        <span className="opacity-75">Ln 1, Col 1</span>
        <span>UTF-8</span>
        {loading ? (
          <span className="opacity-75">Loading backend state...</span>
        ) : isHealthy ? (
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-success"></span> Connected</span>
        ) : (
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-error"></span> Disconnected</span>
        )}
      </div>
    </div>
  );
}

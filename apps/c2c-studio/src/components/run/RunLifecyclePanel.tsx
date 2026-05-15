'use client';
import { useTransformationRun } from '../../stores/transformationRun';

export function RunLifecyclePanel({ emptyState }: { emptyState: { title: string; message: string } }) {
  const { state } = useTransformationRun();

  if (state.phase === 'idle' || !state.events) {
    return (
      <div className="p-4 space-y-2 text-sm">
        <p className="font-medium text-text">{emptyState.title}</p>
        <p className="text-text-dim">{emptyState.message}</p>
      </div>
    );
  }

  return (
    <div className="p-4 font-mono text-xs overflow-auto h-full text-text-dim">
      {state.events.events.map((evt, idx) => (
        <div key={idx} className="flex gap-4 border-b border-line-2 py-1">
          <span className="w-48 shrink-0">{evt.createdAt}</span>
          <span className="w-24 shrink-0 font-medium text-text">{evt.type}</span>
          <span className="w-24 shrink-0 text-text">{evt.status}</span>
          <span>{evt.message}</span>
        </div>
      ))}
    </div>
  );
}

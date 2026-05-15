'use client';
import { useTransformationRun } from '../../stores/transformationRun';
import { EquivalencePanel } from './EquivalencePanel';
import { RunArtifactsPanel } from './RunArtifactsPanel';
import { StatusChip } from '../ui/StatusChip';
import { cn } from '../../lib/utils';
import { BuildTestView } from '../../types/build-test';
import { RunPhase } from '../../types/run';

export function BuildTestPanel({ emptyState }: { emptyState: { title: string; message: string } }) {
  const { state } = useTransformationRun();

  if (state.phase === 'idle' || state.phase === 'starting' || state.phase === 'running') {
     if (state.phase === 'idle') {
       return (
         <div className="p-4 space-y-2 text-sm">
           <p className="font-medium text-text">{emptyState.title}</p>
           <p className="text-text-dim">{emptyState.message}</p>
         </div>
       );
     }
  }

  const bt = state.buildTest;
  const isPending = !bt || state.phase === 'running' || state.phase === 'starting';

  return (
    <div className="flex flex-col h-full bg-bg-0 text-sm">
      <div className="flex-1 p-4 flex gap-8 min-h-0">
        <div className="w-64 shrink-0 space-y-4">
           <h3 className="font-medium text-text mb-4">Pipeline Stages</h3>
           <div className="space-y-3">
              <StageItem label="COBOL Oracle" status={bt?.status === 'missing-golden-master' ? 'error' : bt?.status === 'golden-master-reproduction-failed' ? 'error' : bt ? 'success' : 'pending'} />
              <StageItem label="Java Compilation" status={bt?.status === 'compile-failed' ? 'error' : bt ? 'success' : 'pending'} />
              <StageItem label="Java Execution" status={bt?.status === 'run-failed' ? 'error' : bt ? 'success' : 'pending'} />
              <StageItem label="Equivalence Check" status={bt?.classification === 'match' ? 'success' : bt?.classification?.startsWith('divergence') ? 'warning' : bt ? 'error' : 'pending'} />
           </div>
           
           {bt && bt.status !== 'ok' && bt.note && (
             <div className="mt-4 p-3 bg-bg-2 border border-line-2 rounded text-error text-xs font-mono whitespace-pre-wrap break-words">
               {bt.note}
             </div>
           )}
        </div>
        <div className="flex-1 flex flex-col min-w-0 border-l border-line-2 pl-8">
           <h3 className="font-medium text-text mb-4">Equivalence Analysis</h3>
           <EquivalencePanel buildTest={bt} isPending={isPending} />
        </div>
      </div>
      {state.artifacts && (
        <div className="border-t border-line-2 h-48 shrink-0 bg-bg-1">
          <RunArtifactsPanel artifacts={state.artifacts.artifacts} />
        </div>
      )}
    </div>
  );
}

function StageItem({ label, status }: { label: string, status: 'success' | 'error' | 'pending' | 'warning' }) {
  return (
    <div className="flex items-center gap-3">
      <StatusChip variant={status === 'success' ? 'success' : status === 'error' ? 'error' : status === 'warning' ? 'warning' : 'pending'} />
      <span className={cn(
        "text-sm font-medium",
        status === 'success' ? 'text-text' : status === 'error' ? 'text-error' : status === 'warning' ? 'text-warn' : 'text-text-dim'
      )}>
        {label}
      </span>
    </div>
  );
}

import { useTransformationRun } from '../../stores/transformationRun';

export function ModelGatewayPanel() {
  const { state } = useTransformationRun();

  if (!state.modelGatewayHealth || state.modelGatewayHealth.status === 'unavailable') {
    return (
      <div className="p-4 text-sm text-neutral-400">
        <p className="mb-2">Model Gateway governance summary unavailable.</p>
        <p className="text-xs italic text-neutral-500">
          Note: Deterministic W0 COBOL-to-Java runs do not require model invocations.
          No Foundry or LLM participation was required or performed for this run.
        </p>
      </div>
    );
  }

  const {
    providerMode,
    activeModelCount,
    dataPolicy,
    ledgerEnabled,
    eventEmission
  } = state.modelGatewayHealth || {};

  return (
    <div className="flex flex-col p-4 space-y-4 text-sm text-neutral-300">
      <h3 className="text-sm font-semibold text-neutral-200">Model Governance Summary</h3>
      
      <div className="grid grid-cols-2 gap-4">
        <div>
          <span className="block text-xs text-neutral-500 uppercase tracking-wider mb-1">Provider Mode</span>
          <span className="font-medium text-neutral-300">{providerMode || 'Unknown'}</span>
        </div>
        <div>
          <span className="block text-xs text-neutral-500 uppercase tracking-wider mb-1">Active Models</span>
          <span className="font-medium text-neutral-300">{activeModelCount ?? 0}</span>
        </div>
        <div>
          <span className="block text-xs text-neutral-500 uppercase tracking-wider mb-1">Data Policy</span>
          <span className="font-medium text-neutral-300">{dataPolicy || 'None'}</span>
        </div>
        <div>
          <span className="block text-xs text-neutral-500 uppercase tracking-wider mb-1">Invocation Ledger</span>
          <span className="font-medium text-neutral-300">{ledgerEnabled ? 'Enabled' : 'Disabled'}</span>
        </div>
        <div>
          <span className="block text-xs text-neutral-500 uppercase tracking-wider mb-1">Event Emission</span>
          <span className="font-medium text-neutral-300">{eventEmission ? 'Enabled' : 'Disabled'}</span>
        </div>
      </div>
    </div>
  );
}
import { useTransformationRun } from '../../stores/transformationRun';

export function ModelGatewayPanel() {
  const { state } = useTransformationRun();
  const deterministicNoModel = state.modelGatewayHealth?.error?.includes('deterministic W0 mode');

  if (!state.modelGatewayHealth || state.modelGatewayHealth.status === 'unavailable') {
    return (
      <div className="p-4 text-sm text-text-dim">
        <p className="mb-2">Model Gateway governance summary unavailable.</p>
        {deterministicNoModel ? (
          <p className="text-xs italic text-text-dim">
            Note: Deterministic W0 COBOL-to-Java runs do not require model invocations.
            No Foundry or LLM participation was required or performed for this run.
          </p>
        ) : (
          <p className="text-xs italic text-text-dim">
            The current Model Gateway state could not be verified from the BFF.
          </p>
        )}
      </div>
    );
  }

  const {
    providerMode,
    activeModelCount,
    dataPolicy,
    ledgerEnabled,
    eventEmission,
    policyId,
    roleAvailability = [],
  } = state.modelGatewayHealth || {};

  return (
    <div className="flex flex-col p-4 space-y-4 text-sm text-text">
      <h3 className="text-sm font-semibold text-text-bright">Model Governance Summary</h3>
      
      <div className="grid grid-cols-2 gap-4">
        <div>
          <span className="block text-xs text-text-dim uppercase tracking-wider mb-1">Provider Mode</span>
          <span className="font-medium text-text">{providerMode || 'Unknown'}</span>
        </div>
        <div>
          <span className="block text-xs text-text-dim uppercase tracking-wider mb-1">Active Models</span>
          <span className="font-medium text-text">{activeModelCount ?? 0}</span>
        </div>
        <div>
          <span className="block text-xs text-text-dim uppercase tracking-wider mb-1">Data Policy</span>
          <span className="font-medium text-text">{dataPolicy || 'None'}</span>
        </div>
        <div>
          <span className="block text-xs text-text-dim uppercase tracking-wider mb-1">Invocation Ledger</span>
          <span className="font-medium text-text">{ledgerEnabled ? 'Enabled' : 'Disabled'}</span>
        </div>
        <div>
          <span className="block text-xs text-text-dim uppercase tracking-wider mb-1">Event Emission</span>
          <span className="font-medium text-text">{eventEmission ? 'Enabled' : 'Disabled'}</span>
        </div>
        <div>
          <span className="block text-xs text-text-dim uppercase tracking-wider mb-1">Policy</span>
          <span className="font-medium text-text">{policyId || 'Unknown'}</span>
        </div>
      </div>

      {roleAvailability.length > 0 && (
        <div>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-text-dim">Role Availability</h4>
          <div className="space-y-2">
            {roleAvailability.map((role) => {
              const isAvailable = role.status === 'ok' && role.availableModels.length > 0;
              return (
                <div key={role.role} className="rounded border border-line-2 bg-bg-2 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium text-text">{role.role}</span>
                    <span className={isAvailable ? 'text-success' : 'text-warn'}>
                      {isAvailable ? 'Available' : 'Blocked'}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-text-dim">
                    {isAvailable
                      ? `Approved models: ${role.availableModels.join(', ')}`
                      : role.reason || 'No approved active model is available for this role.'}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

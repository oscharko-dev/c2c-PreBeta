import { useTransformationRun } from '../../stores/transformationRun';

export function ExperienceLearningPanel() {
  const { state } = useTransformationRun();

  if (state.phase === 'idle' || state.phase === 'starting' || !state.runId) {
    return null;
  }

  if (state.experience?.productMode === 'unavailable' || !state.experience) {
    return (
      <div className="p-4 text-sm text-neutral-400">
        Experience Learning unavailable for this run.
      </div>
    );
  }

  const { summary, observationPolicy, detectedPatterns, artifactRefs } = state.experience;

  return (
    <div className="flex flex-col h-full overflow-y-auto p-4 space-y-6 text-sm text-neutral-300">
      <div>
        <h3 className="text-sm font-semibold text-neutral-200 mb-2">Experience Learning Summary</h3>
        <p className="text-neutral-400">{summary || 'No summary available.'}</p>
      </div>

      <div>
        <h4 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-2">Observation Policy</h4>
        <div className="bg-neutral-800 rounded p-3 font-mono text-xs">
          {observationPolicy || 'default'}
        </div>
      </div>

      <div>
        <h4 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-2">Detected Patterns</h4>
        {detectedPatterns && detectedPatterns.length > 0 ? (
          <ul className="list-disc list-inside space-y-1 ml-1 pl-3 text-neutral-400">
            {detectedPatterns.map((p, idx) => (
              <li key={idx}>{p}</li>
            ))}
          </ul>
        ) : (
          <p className="text-neutral-500 italic">No patterns detected.</p>
        )}
      </div>

      <div>
        <h4 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-2">Observation-only Artifacts</h4>
        {artifactRefs && artifactRefs.length > 0 ? (
          <ul className="list-disc list-inside space-y-1 ml-1 pl-3 text-neutral-400 break-all">
            {artifactRefs.map((ref, idx) => (
              <li key={idx} className="font-mono text-xs">{ref}</li>
            ))}
          </ul>
        ) : (
          <p className="text-neutral-500 italic">No artifact references.</p>
        )}
      </div>
    </div>
  );
}
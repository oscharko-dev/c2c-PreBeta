'use client';

import { useReferencePrograms } from '../../hooks/useReferencePrograms';
import { useSourceWorkspace } from '../../stores/sourceWorkspace';
import { TreeRow } from '../ui/TreeRow';
import { apiClient } from '../../lib/apiClient';

export function SourceWorkspaceTree() {
  const { programs, isLoading, error } = useReferencePrograms();
  const { loadedProgramId, loadProgram } = useSourceWorkspace();

  const handleProgramClick = async (programId: string, supported: boolean) => {
    if (!supported) return;

    const result = await apiClient.getSampleDetail(programId);
    if (result.ok) {
      loadProgram(
        result.data.programId,
        result.data.cobolSource,
        result.data.cobolSourcePath.split('/').pop() || programId,
      );
    } else {
      console.error(result.message);
    }
  };

  if (isLoading) {
    return <div className="p-4 text-sm text-text-dim">Loading programs...</div>;
  }

  if (error) {
    return <div className="p-4 text-sm text-error">Error loading programs: {error}</div>;
  }

  if (programs.length === 0) {
    return <div className="p-4 text-sm text-text-dim">No reference programs found.</div>;
  }

  return (
    <div className="flex-1 overflow-auto" role="tree" aria-label="Reference Programs">
      <div className="py-2">
        {programs.map((program) => (
          <div
            key={program.programId}
            className={!program.supportedInProductMode ? 'opacity-60' : ''}
          >
            <TreeRow
              label={program.title || program.programId}
              type="file"
              active={loadedProgramId === program.programId}
              disabled={!program.supportedInProductMode}
              statusVariant={program.supportedInProductMode ? 'success' : 'blocked'}
              onActivate={
                program.supportedInProductMode
                  ? () => {
                      void handleProgramClick(program.programId, true);
                    }
                  : undefined
              }
            />
            {!program.supportedInProductMode ? (
              <p className="px-4 pb-2 text-xs text-text-dim">
                Unavailable in product mode.
                {program.knownLimitations.length > 0 ? ` ${program.knownLimitations[0]}` : ''}
              </p>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

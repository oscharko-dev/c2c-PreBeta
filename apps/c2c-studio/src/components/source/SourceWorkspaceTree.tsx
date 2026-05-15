'use client';

import { useReferencePrograms } from '../../hooks/useReferencePrograms';
import { useSourceWorkspace } from '../../stores/sourceWorkspace';
import { TreeRow } from '../ui/TreeRow';
import { apiClient } from '../../lib/apiClient';

export function SourceWorkspaceTree() {
  const { programs, isLoading, error } = useReferencePrograms();
  const { programId: selectedProgramId, loadProgram } = useSourceWorkspace();

  const handleProgramClick = async (programId: string, supported: boolean) => {
    if (!supported) return;

    const result = await apiClient.getSampleDetail(programId);
    if (result.ok) {
      loadProgram(result.data.programId, result.data.cobolSource, result.data.sourcePath.split('/').pop() || programId);
    } else {
      // Handle error visually if possible, or log it
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
    <div className="flex-1 overflow-auto">
      <div className="py-2">
        {programs.map((program) => (
          <div
            key={program.programId}
            className={!program.supportedInProductMode ? 'opacity-50 cursor-not-allowed' : ''}
            title={!program.supportedInProductMode ? 'Unsupported in product mode' : program.description}
          >
            <TreeRow
              label={program.title || program.programId}
              type="file"
              active={selectedProgramId === program.programId}
              onClick={() => handleProgramClick(program.programId, program.supportedInProductMode)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

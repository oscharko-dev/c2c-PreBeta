'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useReferencePrograms } from '../../hooks/useReferencePrograms';
import { useSourceWorkspace } from '../../stores/sourceWorkspace';
import { TreeRow } from '../ui/TreeRow';
import { apiClient } from '../../lib/apiClient';

export function SourceWorkspaceTree() {
  const { programs, isLoading, error } = useReferencePrograms();
  const { loadedProgramId, loadProgram } = useSourceWorkspace();
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const [focusedProgramId, setFocusedProgramId] = useState<string | null>(null);
  const visiblePrograms = programs;

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

  useEffect(() => {
    if (visiblePrograms.length === 0) {
      setFocusedProgramId(null);
      return;
    }

    const hasFocusedProgram = visiblePrograms.some((program) => program.programId === focusedProgramId);
    if (!hasFocusedProgram) {
      setFocusedProgramId(loadedProgramId ?? visiblePrograms[0].programId);
    }
  }, [focusedProgramId, loadedProgramId, visiblePrograms]);

  useEffect(() => {
    if (focusedProgramId) {
      rowRefs.current.get(focusedProgramId)?.focus();
    }
  }, [focusedProgramId]);

  const focusProgramById = (programId: string | null) => {
    if (!programId) {
      return;
    }

    setFocusedProgramId(programId);
    rowRefs.current.get(programId)?.focus();
  };

  const handleTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>, programIndex: number) => {
    if (visiblePrograms.length === 0) {
      return;
    }

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusProgramById(visiblePrograms[Math.min(programIndex + 1, visiblePrograms.length - 1)]?.programId ?? null);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusProgramById(visiblePrograms[Math.max(programIndex - 1, 0)]?.programId ?? null);
        break;
      case 'Home':
        event.preventDefault();
        focusProgramById(visiblePrograms[0].programId);
        break;
      case 'End':
        event.preventDefault();
        focusProgramById(visiblePrograms[visiblePrograms.length - 1].programId);
        break;
      case 'ArrowLeft':
      case 'ArrowRight':
      case 'Enter':
      case ' ':
        event.preventDefault();
        break;
      default:
        break;
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
    <div className="flex-1 overflow-auto py-2" role="tree" aria-label="Reference Programs">
      {visiblePrograms.map((program, index) => {
        const label = program.title || program.programId;
        const unavailableReason = !program.supportedInProductMode
          ? `Unavailable in product mode.${program.knownLimitations.length > 0 ? ` ${program.knownLimitations[0]}` : ''}`
          : undefined;

        return (
          <TreeRow
            key={program.programId}
            ref={(node) => {
              if (node) {
                rowRefs.current.set(program.programId, node);
              } else {
                rowRefs.current.delete(program.programId);
              }
            }}
            label={label}
            description={unavailableReason}
            type="file"
            active={loadedProgramId === program.programId}
            disabled={!program.supportedInProductMode}
            statusVariant={program.supportedInProductMode ? 'success' : 'blocked'}
            tabIndex={focusedProgramId === program.programId || (!focusedProgramId && index === 0) ? 0 : -1}
            className={!program.supportedInProductMode ? 'opacity-60' : undefined}
            aria-label={unavailableReason ? `${label}. ${unavailableReason}` : label}
            title={unavailableReason}
            onFocus={() => setFocusedProgramId(program.programId)}
            onKeyDown={(event) => handleTreeKeyDown(event, index)}
            onActivate={
              program.supportedInProductMode
                ? () => {
                    void handleProgramClick(program.programId, true);
                  }
                : undefined
            }
          />
        );
      })}
    </div>
  );
}

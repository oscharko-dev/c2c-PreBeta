import { randomUUID } from 'node:crypto';
import { mockOutcomeFor, type MockRunOutcome } from './mock-data';
import type { SampleDetail } from './samples';

export type RunStatus = 'starting' | 'updating' | 'completed' | 'failed';
export type RunMode = 'live' | 'mock';

export interface StoredRun {
  runId: string;
  programId: string;
  status: RunStatus;
  mode: RunMode;
  message: string;
  policyDecision: string;
  evidenceRefs: string[];
  createdAt: string;
  updatedAt: string;
  sample: SampleDetail;
  mock?: MockRunOutcome;
  liveRunId?: string;
}

export interface RunStore {
  create(sample: SampleDetail, mode: RunMode, liveRunId?: string, initial?: Partial<StoredRun>): StoredRun;
  get(runId: string): StoredRun | undefined;
  update(runId: string, patch: Partial<StoredRun>): StoredRun | undefined;
  list(): StoredRun[];
}

export function createRunStore(now: () => Date = () => new Date(), idFactory: () => string = randomUUID): RunStore {
  const runs = new Map<string, StoredRun>();
  return {
    create(sample, mode, liveRunId, initial) {
      const runId = `run-${idFactory()}`;
      const createdAt = now().toISOString();
      const stored: StoredRun = {
        runId,
        programId: sample.programId,
        status: initial?.status ?? 'starting',
        mode,
        message: initial?.message ?? (mode === 'mock' ? 'orchestrator not configured; serving mock run' : 'run accepted by orchestrator'),
        policyDecision: initial?.policyDecision ?? '',
        evidenceRefs: initial?.evidenceRefs ?? [],
        createdAt,
        updatedAt: createdAt,
        sample,
        mock: mode === 'mock' ? mockOutcomeFor(sample, runId) : undefined,
        liveRunId,
      };
      runs.set(runId, stored);
      return stored;
    },
    get(runId) {
      return runs.get(runId);
    },
    update(runId, patch) {
      const existing = runs.get(runId);
      if (!existing) return undefined;
      const updated: StoredRun = {
        ...existing,
        ...patch,
        updatedAt: now().toISOString(),
      };
      runs.set(runId, updated);
      return updated;
    },
    list() {
      return Array.from(runs.values());
    },
  };
}

function isAllowedStatus(value: unknown): value is RunStatus {
  return value === 'starting' || value === 'updating' || value === 'completed' || value === 'failed';
}

export function coerceLiveStatus(value: unknown): RunStatus {
  return isAllowedStatus(value) ? value : 'updating';
}

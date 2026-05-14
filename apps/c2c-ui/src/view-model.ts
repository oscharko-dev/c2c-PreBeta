import type {
  BuildTestView,
  EvidenceView,
  GeneratedView,
  RunSummary,
} from './types.js';

export interface ModeBadgeState {
  text: string;
  mode: 'live' | 'mock' | 'error' | 'loading';
}

export function modeBadgeFromResponse(orchestrator: 'live' | 'mock', evidence: 'live' | 'mock'): ModeBadgeState {
  if (orchestrator === 'live' && evidence === 'live') {
    return { mode: 'live', text: 'live · orchestrator + evidence' };
  }
  if (orchestrator === 'mock' && evidence === 'mock') {
    return { mode: 'mock', text: 'mock · no upstream configured' };
  }
  return {
    mode: 'mock',
    text: `mixed · orchestrator=${orchestrator} · evidence=${evidence}`,
  };
}

export interface RunStatusLine {
  state: 'idle' | 'starting' | 'updating' | 'completed' | 'failed';
  primary: string;
  secondary: string;
}

export function runStatusLine(run: RunSummary | undefined): RunStatusLine {
  if (!run) {
    return {
      state: 'idle',
      primary: 'No run yet. Pick a sample and start a run.',
      secondary: '',
    };
  }
  const labels: Record<RunSummary['status'], string> = {
    starting: 'starting',
    updating: 'updating',
    completed: 'completed',
    failed: 'failed',
  };
  const primary = `[${run.mode}] ${labels[run.status]} · ${run.runId} · program=${run.programId}`;
  const secondary = [
    run.message,
    run.policyDecision ? `policy=${run.policyDecision}` : '',
    run.updatedAt ? `updated=${run.updatedAt}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return { state: run.status, primary, secondary };
}

export function pickEntryFile(generated: GeneratedView): { path: string; content: string } | undefined {
  if (generated.entryFilePath && generated.files[generated.entryFilePath]) {
    return { path: generated.entryFilePath, content: generated.files[generated.entryFilePath] ?? '' };
  }
  const entries = Object.entries(generated.files);
  if (entries.length === 0) return undefined;
  const first = entries[0];
  if (!first) return undefined;
  const [path, content] = first;
  return { path, content };
}

export function generatedSummary(generated: GeneratedView | undefined): { headline: string; note: string } {
  if (!generated) {
    return { headline: 'No run yet.', note: '' };
  }
  if (generated.status === 'generated') {
    return { headline: `Generated [${generated.mode}] · ${generated.entryClass}`, note: generated.note };
  }
  if (generated.status === 'unsupported') {
    return {
      headline: `Unsupported features in W0 [${generated.mode}] · ${generated.entryClass || 'no entry class'}`,
      note: generated.note,
    };
  }
  return {
    headline: `Skipped [${generated.mode}]`,
    note: generated.note,
  };
}

export function buildTestSummary(view: BuildTestView | undefined): {
  status: BuildTestView['status'] | 'idle';
  headline: string;
  classification: string;
  note: string;
} {
  if (!view) {
    return { status: 'idle', headline: 'No run yet.', classification: '', note: '' };
  }
  const headline = `[${view.mode}] status=${view.status}`;
  return {
    status: view.status,
    headline,
    classification: view.classification,
    note: view.note,
  };
}

export function evidenceSummary(view: EvidenceView | undefined): {
  status: EvidenceView['status'] | 'idle';
  headline: string;
  manifestUri: string;
  missing: string[];
  note: string;
} {
  if (!view) {
    return { status: 'idle', headline: 'No run yet.', manifestUri: '', missing: [], note: '' };
  }
  const headline = `[${view.mode}] status=${view.status}${view.packId ? ` · packId=${view.packId}` : ''}`;
  return {
    status: view.status,
    headline,
    manifestUri: view.manifestUri,
    missing: view.missingArtifacts,
    note: view.note,
  };
}

import type {
  BuildTestView,
  EvidenceView,
  GeneratedView,
  ModeResponse,
  RunSummary,
  TransformResponse,
} from './types.js';

export interface ProductReadiness {
  ready: boolean;
  label: string;
  tone: 'ready' | 'not-ready' | 'unknown' | 'error';
}

export function productReadiness(mode: ModeResponse | undefined, error?: string): ProductReadiness {
  if (error) {
    return { ready: false, label: `not ready · ${error}`, tone: 'error' };
  }
  if (!mode) {
    return { ready: false, label: 'checking…', tone: 'unknown' };
  }
  if (mode.orchestrator !== 'live') {
    return {
      ready: false,
      label: 'orchestrator not configured',
      tone: 'not-ready',
    };
  }
  if (mode.evidence !== 'live') {
    return {
      ready: true,
      label: 'ready · evidence service mock',
      tone: 'ready',
    };
  }
  return { ready: true, label: 'ready', tone: 'ready' };
}

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

export interface StartButtonState {
  enabled: boolean;
  busy: boolean;
  label: string;
  help: string;
  helpTone: 'neutral' | 'not-ready' | 'error';
}

export interface StartButtonInput {
  sourceText: string;
  productReady: boolean;
  productLabel: string;
  busy: boolean;
  lastError?: string;
}

export function startButtonState(input: StartButtonInput): StartButtonState {
  if (input.busy) {
    return {
      enabled: false,
      busy: true,
      label: 'Starting…',
      help: 'Transformation run is starting. The COBOL editor remains editable for the next run.',
      helpTone: 'neutral',
    };
  }
  if (input.lastError) {
    const errorHelp = `Last attempt failed: ${input.lastError}`;
    if (!input.productReady) {
      return { enabled: false, busy: false, label: 'Start', help: errorHelp, helpTone: 'error' };
    }
    if (input.sourceText.trim().length === 0) {
      return { enabled: false, busy: false, label: 'Start', help: errorHelp, helpTone: 'error' };
    }
    return { enabled: true, busy: false, label: 'Start', help: errorHelp, helpTone: 'error' };
  }
  if (!input.productReady) {
    return {
      enabled: false,
      busy: false,
      label: 'Start',
      help: `Product mode ${input.productLabel}. Start is disabled until the BFF reports product mode ready.`,
      helpTone: 'not-ready',
    };
  }
  if (input.sourceText.trim().length === 0) {
    return {
      enabled: false,
      busy: false,
      label: 'Start',
      help: 'Paste or load COBOL source to enable Start.',
      helpTone: 'neutral',
    };
  }
  return {
    enabled: true,
    busy: false,
    label: 'Start',
    help: 'Pressing Start sends the editor content to the transform API.',
    helpTone: 'neutral',
  };
}

export interface SourceMetadata {
  programId: string | null;
  bytes: number;
  lines: number;
  isEmpty: boolean;
}

export function sourceMetadata(text: string): SourceMetadata {
  if (text.length === 0) {
    return { programId: null, bytes: 0, lines: 0, isEmpty: true };
  }
  const match = /\bPROGRAM-ID\.\s*([A-Za-z][A-Za-z0-9-]*)/.exec(text);
  const programId = match?.[1] ? match[1].toUpperCase() : null;
  const bytes = utf8ByteLength(text);
  const lines = text.split(/\r\n|\r|\n/).length;
  return { programId, bytes, lines, isEmpty: false };
}

export function formatSourceMetadata(meta: SourceMetadata): string {
  if (meta.isEmpty) return 'No source yet.';
  const parts: string[] = [];
  parts.push(meta.programId ? `program-id=${meta.programId}` : 'program-id=(not detected)');
  parts.push(`bytes=${meta.bytes}`);
  parts.push(`lines=${meta.lines}`);
  return parts.join(' · ');
}

export function formatPostStartMetadata(transform: TransformResponse, sourceHashHex: string | undefined): string {
  const parts: string[] = [];
  parts.push(`run=${transform.runId}`);
  if (transform.orchestratorRunId) parts.push(`orchestrator=${transform.orchestratorRunId}`);
  if (sourceHashHex) parts.push(`sha256=${sourceHashHex.slice(0, 16)}…`);
  return parts.join(' · ');
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
      primary: 'No run started.',
      secondary: '',
    };
  }
  const labels: Record<RunSummary['status'], string> = {
    starting: 'starting',
    updating: 'updating',
    completed: 'completed',
    failed: 'failed',
  };
  const productMode = run.productMode ?? run.mode;
  const primary = `[${productMode}] ${labels[run.status]} · ${run.runId} · program=${run.programId}`;
  const secondary = [
    run.message,
    run.policyDecision ? `policy=${run.policyDecision}` : '',
    run.updatedAt ? `updated=${run.updatedAt}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return { state: run.status, primary, secondary };
}

export interface RunStatusChip {
  state: 'idle' | 'starting' | 'updating' | 'completed' | 'failed';
  label: string;
}

export function runStatusChip(run: RunSummary | undefined): RunStatusChip {
  if (!run) return { state: 'idle', label: 'idle' };
  return { state: run.status, label: run.status };
}

export interface PipelineLine {
  state: 'idle' | 'starting' | 'updating' | 'completed' | 'failed';
  headline: string;
  detail: string;
  diagnostic?: string;
}

export function pipelineLine(run: RunSummary | undefined): PipelineLine {
  if (!run) {
    return { state: 'idle', headline: 'No run started.', detail: '' };
  }
  const stateLabels: Record<RunSummary['status'], string> = {
    starting: 'Starting',
    updating: 'In progress',
    completed: 'Completed',
    failed: 'Failed',
  };
  const headline = `${stateLabels[run.status]} · run ${run.runId}`;
  const detailParts: string[] = [];
  if (run.programId) detailParts.push(`program=${run.programId}`);
  if (run.policyDecision) detailParts.push(`policy=${run.policyDecision}`);
  if (run.updatedAt) detailParts.push(`updated=${run.updatedAt}`);
  if (run.orchestratorRunId) detailParts.push(`orchestrator=${run.orchestratorRunId}`);
  const detail = detailParts.join(' · ');
  const diagnostic = run.status === 'failed' ? run.message || 'Run failed without a message.' : undefined;
  return { state: run.status, headline, detail, ...(diagnostic ? { diagnostic } : {}) };
}

export interface GeneratedFilePick {
  path: string;
  content: string;
}

export function pickEntryFile(generated: GeneratedView, preferredPath?: string): GeneratedFilePick | undefined {
  if (preferredPath && generated.files[preferredPath]) {
    return { path: preferredPath, content: generated.files[preferredPath] ?? '' };
  }
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

export const PLACEHOLDER_JAVA_MARKERS: readonly string[] = [
  'W0-STUB',
  'Synthetic W0 generated-Java stub',
  '// TODO: implement',
  'PLACEHOLDER',
];

export function containsPlaceholderMarker(files: Record<string, string>): string | null {
  for (const content of Object.values(files)) {
    for (const marker of PLACEHOLDER_JAVA_MARKERS) {
      if (content.includes(marker)) return marker;
    }
  }
  return null;
}

export interface GeneratedSummary {
  headline: string;
  note: string;
  isProductOutput: boolean;
  viewerState: 'pending' | 'empty' | 'shown' | 'error';
  paneText: string;
  placeholderMarker?: string;
}

export function generatedSummary(
  generated: GeneratedView | undefined,
  run: RunSummary | undefined,
  error: string | undefined,
): GeneratedSummary {
  if (error) {
    return {
      headline: `Failed to load generated output: ${error}`,
      note: '',
      isProductOutput: false,
      viewerState: 'error',
      paneText: `Failed to load generated output: ${error}`,
    };
  }
  if (!generated) {
    if (!run) {
      return {
        headline: '',
        note: '',
        isProductOutput: false,
        viewerState: 'empty',
        paneText: 'No run started.',
      };
    }
    if (run.status === 'failed') {
      return {
        headline: 'No generated output.',
        note: 'Run failed before generating Java.',
        isProductOutput: false,
        viewerState: 'empty',
        paneText: 'No generated output. Run failed.',
      };
    }
    return {
      headline: 'Generation pending…',
      note: '',
      isProductOutput: false,
      viewerState: 'pending',
      paneText: 'Generation pending…',
    };
  }
  if (generated.mode !== 'live') {
    return {
      headline: 'Mock placeholder · not product output',
      note: generated.note || 'BFF returned mock data because no live orchestrator is configured.',
      isProductOutput: false,
      viewerState: 'empty',
      paneText: 'No product output. Mock placeholder suppressed because orchestrator is not live.',
    };
  }
  if (generated.status !== 'generated') {
    if (generated.status === 'unsupported') {
      return {
        headline: `Unsupported in this run · ${generated.entryClass || 'no entry class'}`,
        note: generated.note,
        isProductOutput: false,
        viewerState: 'empty',
        paneText: 'No generator output produced for this run (unsupported features).',
      };
    }
    if (generated.status === 'incomplete') {
      return {
        headline: 'Generated Java unavailable for this run.',
        note: generated.note,
        isProductOutput: false,
        viewerState: 'empty',
        paneText: 'No product output. Orchestrator has not yet persisted the generation response.',
      };
    }
    return {
      headline: 'No generator output produced.',
      note: generated.note,
      isProductOutput: false,
      viewerState: 'empty',
      paneText: 'No generator output produced for this run.',
    };
  }
  if (Object.keys(generated.files).length === 0) {
    return {
      headline: 'No generator files emitted.',
      note: generated.note,
      isProductOutput: false,
      viewerState: 'empty',
      paneText: 'No generator files emitted for this run.',
    };
  }
  const placeholder = containsPlaceholderMarker(generated.files);
  if (placeholder) {
    return {
      headline: 'Refusing to display placeholder Java as a successful run.',
      note: `Generated Java contains placeholder marker "${placeholder}". The BFF must return real generator output for successful runs.`,
      isProductOutput: false,
      viewerState: 'error',
      paneText: `Refusing to display placeholder Java. Marker "${placeholder}" detected.`,
      placeholderMarker: placeholder,
    };
  }
  const headlineParts: string[] = [];
  if (generated.entryClass) headlineParts.push(`entry class · ${generated.entryClass}`);
  if (generated.entryFilePath) headlineParts.push(`path · ${generated.entryFilePath}`);
  return {
    headline: headlineParts.join(' · ') || 'Generated',
    note: generated.note,
    isProductOutput: true,
    viewerState: 'shown',
    paneText: '',
  };
}

export interface BuildTestSummary {
  status: BuildTestView['status'] | 'idle' | 'mock';
  classification: BuildTestView['classification'] | 'mock' | '';
  headline: string;
  note: string;
  isProductResult: boolean;
  compileStatus?: BuildTestView['compileStatus'];
  executionStatus?: BuildTestView['executionStatus'];
  diagnostics: NonNullable<BuildTestView['diagnostics']>;
}

export function buildTestSummary(
  view: BuildTestView | undefined,
  run: RunSummary | undefined,
  error: string | undefined,
): BuildTestSummary {
  if (error) {
    return { status: 'idle', classification: '', headline: `Failed to load build/test: ${error}`, note: '', isProductResult: false, diagnostics: [] };
  }
  if (!view) {
    if (!run) {
      return { status: 'idle', classification: '', headline: 'No run started.', note: '', isProductResult: false, diagnostics: [] };
    }
    return { status: 'idle', classification: '', headline: 'Build/test pending…', note: '', isProductResult: false, diagnostics: [] };
  }
  if (view.mode !== 'live') {
    return {
      status: 'mock',
      classification: 'mock',
      headline: 'Mock placeholder · not product result',
      note: view.note || 'BFF returned mock data because no live orchestrator is configured.',
      isProductResult: false,
      diagnostics: [],
    };
  }
  if (view.status === 'incomplete') {
    return {
      status: 'incomplete',
      classification: view.classification,
      headline: 'Build/test result unavailable for this run.',
      note: view.note,
      isProductResult: false,
      ...(view.compileStatus ? { compileStatus: view.compileStatus } : {}),
      ...(view.executionStatus ? { executionStatus: view.executionStatus } : {}),
      diagnostics: view.diagnostics ?? [],
    };
  }
  return {
    status: view.status,
    classification: view.classification,
    headline: `status=${view.status} · classification=${view.classification}`,
    note: view.note,
    isProductResult: true,
    ...(view.compileStatus ? { compileStatus: view.compileStatus } : {}),
    ...(view.executionStatus ? { executionStatus: view.executionStatus } : {}),
    diagnostics: view.diagnostics ?? [],
  };
}

export interface EvidenceSummary {
  status: EvidenceView['status'] | 'idle' | 'mock';
  headline: string;
  manifestUri: string;
  exportUri: string;
  missing: string[];
  note: string;
  isProductResult: boolean;
  manifestHash?: string;
  validationStatus?: EvidenceView['validationStatus'];
  exportRef?: EvidenceView['exportRef'];
}

export function evidenceSummary(
  view: EvidenceView | undefined,
  run: RunSummary | undefined,
  error: string | undefined,
): EvidenceSummary {
  if (error) {
    return {
      status: 'idle',
      headline: `Failed to load evidence: ${error}`,
      manifestUri: '',
      exportUri: '',
      missing: [],
      note: '',
      isProductResult: false,
    };
  }
  if (!view) {
    if (!run) {
      return { status: 'idle', headline: 'No run started.', manifestUri: '', exportUri: '', missing: [], note: '', isProductResult: false };
    }
    return { status: 'idle', headline: 'Evidence Pack pending…', manifestUri: '', exportUri: '', missing: [], note: '', isProductResult: false };
  }
  if (view.mode !== 'live') {
    return {
      status: 'mock',
      headline: 'Mock placeholder · not product result',
      manifestUri: '',
      exportUri: '',
      missing: view.missingArtifacts,
      note: view.note || 'BFF returned mock data because no live orchestrator is configured.',
      isProductResult: false,
    };
  }
  const exportUri = view.exportRef?.uri ?? view.exportUri ?? '';
  return {
    status: view.status,
    headline: `status=${view.status}${view.packId ? ` · packId=${view.packId}` : ''}`,
    manifestUri: view.manifestUri,
    exportUri,
    missing: view.missingArtifacts,
    note: view.note,
    isProductResult: view.status === 'complete',
    ...(view.manifestHash ? { manifestHash: view.manifestHash } : {}),
    ...(view.validationStatus ? { validationStatus: view.validationStatus } : {}),
    ...(view.exportRef ? { exportRef: view.exportRef } : {}),
  };
}

export interface LimitationsSummary {
  state: 'idle' | 'empty' | 'has-items';
  unsupportedFeatures: string[];
  openAssumptions: string[];
  headline: string;
}

export function limitationsSummary(
  generated: GeneratedView | undefined,
  run: RunSummary | undefined,
): LimitationsSummary {
  if (!run) {
    return { state: 'idle', unsupportedFeatures: [], openAssumptions: [], headline: 'No run started.' };
  }
  if (!generated) {
    return { state: 'idle', unsupportedFeatures: [], openAssumptions: [], headline: 'Awaiting generator output…' };
  }
  if (generated.mode !== 'live') {
    return {
      state: 'idle',
      unsupportedFeatures: [],
      openAssumptions: [],
      headline: 'Mock placeholder · not product result.',
    };
  }
  const unsupported = generated.unsupportedFeatures ?? [];
  const open = generated.openAssumptions ?? [];
  if (unsupported.length === 0 && open.length === 0) {
    return { state: 'empty', unsupportedFeatures: [], openAssumptions: [], headline: 'No limitations or open assumptions reported for this run.' };
  }
  return {
    state: 'has-items',
    unsupportedFeatures: unsupported,
    openAssumptions: open,
    headline: 'Reported by generator for this run:',
  };
}

function utf8ByteLength(text: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(text).length;
  }
  return Buffer.byteLength(text, 'utf8');
}

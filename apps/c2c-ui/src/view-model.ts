import type {
  BuildTestView,
  EvidenceView,
  GeneratedView,
  LearningView,
  ModeResponse,
  PipelineProgressView,
  PipelineStep,
  PipelineStepStatus,
  RunSummary,
  SampleSummary,
  TransformResponse,
} from './types.js';
import {
  PLACEHOLDER_JAVA_MARKERS as SHARED_PLACEHOLDER_MARKERS,
  findPlaceholderInFiles,
  type PlaceholderJavaMarker,
} from './placeholder-markers.js';

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
  const productMode = run.productMode ?? (run.mode === 'live' ? 'live' : 'unavailable');
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

export const PLACEHOLDER_JAVA_MARKERS: readonly PlaceholderJavaMarker[] = SHARED_PLACEHOLDER_MARKERS;

export function containsPlaceholderMarker(files: Record<string, string>): PlaceholderJavaMarker | null {
  const hit = findPlaceholderInFiles(files);
  return hit ? hit.marker : null;
}

export interface GeneratedSummary {
  headline: string;
  note: string;
  isProductOutput: boolean;
  viewerState: 'pending' | 'empty' | 'shown' | 'error';
  paneText: string;
  placeholderMarker?: PlaceholderJavaMarker;
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
      headline: 'Diagnostic fixture · not product output',
      note: generated.note || 'BFF returned a diagnostic fixture; product mode requires a live orchestrator.',
      isProductOutput: false,
      viewerState: 'empty',
      paneText: 'No product output. Diagnostic fixture suppressed because product mode is not ready.',
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
  status: BuildTestView['status'] | 'idle' | 'diagnostic-fixture';
  classification: BuildTestView['classification'] | 'diagnostic-fixture' | '';
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
      status: 'diagnostic-fixture',
      classification: 'diagnostic-fixture',
      headline: 'Diagnostic fixture · not product result',
      note: view.note || 'BFF returned a diagnostic fixture; product mode requires a live orchestrator.',
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
  status: EvidenceView['status'] | 'idle' | 'diagnostic-fixture';
  headline: string;
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
      missing: [],
      note: '',
      isProductResult: false,
    };
  }
  if (!view) {
    if (!run) {
      return { status: 'idle', headline: 'No run started.', missing: [], note: '', isProductResult: false };
    }
    return { status: 'idle', headline: 'Evidence Pack pending…', missing: [], note: '', isProductResult: false };
  }
  if (view.mode !== 'live') {
    return {
      status: 'diagnostic-fixture',
      headline: 'Diagnostic fixture · not product result',
      missing: view.missingArtifacts,
      note: view.note || 'BFF returned a diagnostic fixture; product mode requires a live orchestrator.',
      isProductResult: false,
    };
  }
  return {
    status: view.status,
    headline: `status=${view.status}${view.packId ? ` · packId=${view.packId}` : ''}`,
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
      headline: 'Diagnostic fixture · not product result.',
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

export interface ReferenceLoaderOption {
  programId: string;
  label: string;
  disabled: boolean;
  reason: string;
}

export interface ReferenceLoaderOptions {
  supported: ReferenceLoaderOption[];
  unsupported: ReferenceLoaderOption[];
}

export function referenceLoaderOptions(samples: readonly SampleSummary[]): ReferenceLoaderOptions {
  const supported: ReferenceLoaderOption[] = [];
  const unsupported: ReferenceLoaderOption[] = [];
  for (const sample of samples) {
    const tag = sample.knownDivergenceAtW0 ? ' (known W0 divergence)' : '';
    const label = `${sample.programId} · ${sample.title}${tag}`;
    if (sample.supportedInProductMode) {
      supported.push({ programId: sample.programId, label, disabled: false, reason: '' });
      continue;
    }
    const limitations = sample.knownLimitations.length > 0
      ? sample.knownLimitations.join('; ')
      : 'not supported in product mode';
    unsupported.push({
      programId: sample.programId,
      label: `${label} — unavailable`,
      disabled: true,
      reason: limitations,
    });
  }
  return { supported, unsupported };
}

export function isReferenceProgramRunnable(sample: SampleSummary | undefined): boolean {
  if (!sample) return false;
  return sample.supportedInProductMode === true;
}

function utf8ByteLength(text: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(text).length;
  }
  return Buffer.byteLength(text, 'utf8');
}

// Issue #96: pipeline-progress + experience-learning view-model helpers.

const REQUIRED_RUN_STEP_NAMES: ReadonlyArray<string> = [
  'parse-cobol',
  'generate-ir',
  'generate-java',
  'compile-test-java',
  'write-evidence',
];

const PIPELINE_STEP_LABELS: Readonly<Record<string, string>> = {
  'accepted': 'Accepted',
  'parse-cobol': 'Parse COBOL',
  'generate-ir': 'Generate IR',
  'generate-java': 'Generate Java',
  'compile-test-java': 'Compile & test Java',
  'write-evidence': 'Write evidence',
  'model-guidance': 'Model guidance',
  'model-policy-skipped': 'Model policy skipped',
  'completed': 'Completed',
  'failed': 'Failed',
};

export function pipelineStepLabel(name: string): string {
  return PIPELINE_STEP_LABELS[name] ?? name;
}

export interface PipelineStepLine {
  step: PipelineStep;
  label: string;
  status: PipelineStepStatus;
  detail: string;
  diagnostic?: string;
}

function formatStepDetail(step: PipelineStep): string {
  const parts: string[] = [];
  if (step.capabilityId) parts.push(`capability=${step.capabilityId}`);
  if (step.actor && step.actor !== step.capabilityId) parts.push(`actor=${step.actor}`);
  if (step.startedAt) parts.push(`started=${step.startedAt}`);
  if (step.finishedAt) parts.push(`finished=${step.finishedAt}`);
  if (typeof step.latencyMs === 'number') parts.push(`latency=${step.latencyMs}ms`);
  return parts.join(' · ');
}

export function pipelineStepLines(progress: PipelineProgressView | undefined): PipelineStepLine[] {
  if (!progress) return [];
  return progress.steps.map((step) => {
    const line: PipelineStepLine = {
      step,
      label: pipelineStepLabel(step.name),
      status: step.status,
      detail: formatStepDetail(step),
    };
    if (step.diagnostic) line.diagnostic = step.diagnostic;
    return line;
  });
}

export interface PipelineProgressSummary {
  state: 'idle' | 'starting' | 'in-progress' | 'completed' | 'failed' | 'unavailable';
  headline: string;
  detail: string;
  currentStepLabel: string;
  failedStepLabel: string;
  diagnostic?: string;
  steps: PipelineStepLine[];
  hiddenFailedStep: boolean;
}

export function pipelineProgressSummary(
  progress: PipelineProgressView | undefined,
  run: RunSummary | undefined,
  error: string | undefined,
): PipelineProgressSummary {
  if (error) {
    return {
      state: 'unavailable',
      headline: `Failed to load pipeline progress: ${error}`,
      detail: '',
      currentStepLabel: '',
      failedStepLabel: '',
      steps: [],
      hiddenFailedStep: false,
    };
  }
  if (!progress) {
    return {
      state: run?.status === 'failed' ? 'failed' : 'idle',
      headline: run ? 'Pipeline progress pending…' : 'No run started.',
      detail: '',
      currentStepLabel: '',
      failedStepLabel: '',
      steps: [],
      hiddenFailedStep: false,
    };
  }
  const lines = pipelineStepLines(progress);
  const currentStepLabel = progress.currentStep ? pipelineStepLabel(progress.currentStep) : '';
  const failedStepLabel = progress.failedStep ? pipelineStepLabel(progress.failedStep) : '';
  const failedLine = progress.failedStep
    ? lines.find((entry) => entry.step.name === progress.failedStep)
    : undefined;
  let state: PipelineProgressSummary['state'];
  let headline: string;
  if (progress.failedStep) {
    state = 'failed';
    headline = `Failed at ${failedStepLabel || progress.failedStep}`;
  } else if (progress.runStatus === 'completed') {
    state = 'completed';
    headline = 'Pipeline complete';
  } else if (progress.runStatus === 'starting' || progress.completedSteps.length === 0) {
    state = 'starting';
    headline = currentStepLabel ? `Starting · ${currentStepLabel}` : 'Starting…';
  } else {
    state = 'in-progress';
    headline = currentStepLabel ? `In progress · ${currentStepLabel}` : 'In progress';
  }
  const detailParts: string[] = [];
  detailParts.push(`step ${progress.completedSteps.length}/${progress.stepCount || REQUIRED_RUN_STEP_NAMES.length}`);
  if (progress.orchestratorRunId) detailParts.push(`orchestrator=${progress.orchestratorRunId}`);
  // Issue #96: never collapse a failed step into a generic success panel.
  // If the run is reported as completed but a failed step exists, surface it.
  const hiddenFailedStep = progress.runStatus === 'completed' && Boolean(progress.failedStep);
  return {
    state,
    headline,
    detail: detailParts.join(' · '),
    currentStepLabel,
    failedStepLabel,
    ...(failedLine?.diagnostic ? { diagnostic: failedLine.diagnostic } : {}),
    steps: lines,
    hiddenFailedStep,
  };
}

export interface LearningSummaryView {
  status: 'idle' | 'live' | 'cached' | 'unavailable';
  headline: string;
  detail: string;
  endpoint: string;
  patterns: string[];
  candidateCount: number;
  observationOnly?: boolean;
  policyVersion?: string;
}

export function learningSummaryView(
  view: LearningView | undefined,
  run: RunSummary | undefined,
  error: string | undefined,
): LearningSummaryView {
  if (error) {
    return {
      status: 'unavailable',
      headline: `Failed to load learning summary: ${error}`,
      detail: '',
      endpoint: '',
      patterns: [],
      candidateCount: 0,
    };
  }
  if (!view) {
    if (!run) {
      return {
        status: 'idle',
        headline: 'No run started.',
        detail: '',
        endpoint: '',
        patterns: [],
        candidateCount: 0,
      };
    }
    return {
      status: 'idle',
      headline: 'Experience learning summary pending…',
      detail: '',
      endpoint: '',
      patterns: [],
      candidateCount: 0,
    };
  }
  if (!view.summary) {
    return {
      status: view.source === 'unavailable' ? 'unavailable' : 'idle',
      headline:
        view.source === 'unavailable'
          ? 'Experience learning unavailable for this run.'
          : 'Experience learning summary pending…',
      detail: view.note ?? '',
      endpoint: view.endpoint,
      patterns: [],
      candidateCount: 0,
    };
  }
  const summary = view.summary;
  const headline =
    view.source === 'live'
      ? 'Experience learning summary'
      : 'Experience learning summary (cached)';
  const detailParts: string[] = [];
  detailParts.push(`events=${summary.sourceEventCount ?? 0}`);
  detailParts.push(`ledgers=${summary.sourceLedgerCount ?? 0}`);
  if (summary.policyVersion) detailParts.push(`policy=${summary.policyVersion}`);
  const result: LearningSummaryView = {
    status: view.source,
    headline,
    detail: detailParts.join(' · '),
    endpoint: view.endpoint,
    patterns: summary.observedPatterns ?? [],
    candidateCount: summary.candidateCount ?? 0,
  };
  if (typeof summary.observationOnly === 'boolean') {
    result.observationOnly = summary.observationOnly;
  }
  if (summary.policyVersion) {
    result.policyVersion = summary.policyVersion;
  }
  return result;
}

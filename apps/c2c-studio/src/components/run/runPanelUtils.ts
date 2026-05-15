import { BuildTestView, OutputRef, RunProgressStep, RunProgressView } from '../../types/api';
import { TransformationRunState } from '../../types/run';
import { StatusVariant, mapBuildTestClassificationToVariant } from '../../types/design';

export interface PipelineStageState {
  label: string;
  status: StatusVariant;
  detail: string;
}

export interface ArtifactReferenceEntry {
  label: string;
  ref: OutputRef | null | undefined;
}

export interface ArtifactAlignment {
  entries: ArtifactReferenceEntry[];
  aligned: boolean;
  expectedSha: string | null;
  distinctShas: string[];
}

export interface RunProblem {
  type: string;
  message: string;
}

export function splitOutputLines(value?: string): string[] {
  if (!value) {
    return [''];
  }

  return value.replace(/\r\n/g, '\n').split('\n');
}

export function buildArtifactAlignment(state: TransformationRunState): ArtifactAlignment {
  const entries: ArtifactReferenceEntry[] = [
    { label: 'Generated Java', ref: state.generated?.artifactRef },
    { label: 'Build & Test', ref: state.buildTest?.generatedArtifactRef },
    { label: 'Evidence Pack', ref: state.evidence?.generatedArtifactRef },
  ];

  const distinctShas = Array.from(
    new Set(entries.map((entry) => entry.ref?.sha256).filter((sha): sha is string => Boolean(sha)))
  );
  const aligned = entries.every((entry) => entry.ref?.sha256) && distinctShas.length === 1;

  return {
    entries,
    aligned,
    expectedSha: aligned ? distinctShas[0] : null,
    distinctShas,
  };
}

export function describeClassification(classification?: BuildTestView['classification']): string {
  switch (classification) {
    case 'match':
      return 'Equivalent';
    case 'divergence-known-w0-coverage-gap':
      return 'Known W0 coverage gap';
    case 'divergence-unknown':
      return 'Unexpected output divergence';
    case 'true-golden-master-reproduction-error':
      return 'Golden-master reproduction error';
    case 'true-golden-master-mismatch':
      return 'Golden-master mismatch';
    case 'compile-error':
      return 'Blocked by compilation failure';
    case 'run-error':
      return 'Blocked by runtime failure';
    case 'skipped-no-execution':
      return 'Blocked before equivalence could run';
    default:
      return classification ?? 'Waiting for equivalence results';
  }
}

const PROGRESS_STEP_LABELS: Record<string, string> = {
  accepted: 'Accepted',
  'parse-cobol': 'Parse COBOL',
  'generate-ir': 'Generate IR',
  'generate-java': 'Generate Java',
  'compile-test-java': 'Compile & Test Java',
  'model-guidance': 'Model Guidance',
  'model-policy-skipped': 'Model Policy Skipped',
  'write-evidence': 'Write Evidence',
  completed: 'Completed',
  failed: 'Failed',
};

function formatProgressStepLabel(stepName: string): string {
  const known = PROGRESS_STEP_LABELS[stepName];
  if (known) {
    return known;
  }

  return stepName
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function mapProgressStepStatus(status: RunProgressStep['status']): StatusVariant {
  switch (status) {
    case 'ok':
      return 'success';
    case 'failed':
      return 'error';
    case 'skipped':
      return 'neutral';
    case 'running':
      return 'pending';
    case 'pending':
    default:
      return 'pending';
  }
}

function describeProgressStep(step: RunProgressStep): string {
  const owner = step.actor || step.service || step.capabilityId || 'pipeline';

  switch (step.status) {
    case 'ok':
      return step.latencyMs !== undefined
        ? `${owner} completed in ${step.latencyMs} ms`
        : `${owner} completed`;
    case 'failed':
      return step.diagnostic ? `Failed: ${step.diagnostic}` : `${owner} failed`;
    case 'skipped':
      return step.diagnostic ? `Skipped: ${step.diagnostic}` : `${owner} skipped`;
    case 'running':
      return `${owner} is running`;
    case 'pending':
    default:
      return `Waiting for ${owner}`;
  }
}

function getProgressPipelineStages(progress?: RunProgressView | null): PipelineStageState[] | null {
  if (!progress || progress.steps.length === 0) {
    return null;
  }

  return [...progress.steps]
    .sort((left, right) => left.stepId - right.stepId)
    .map((step) => ({
      label: formatProgressStepLabel(step.name),
      status: mapProgressStepStatus(step.status),
      detail: describeProgressStep(step),
    }));
}

export function getPipelineStages(
  buildTest: BuildTestView | null,
  isPending: boolean,
  progress?: RunProgressView | null
): PipelineStageState[] {
  const progressStages = getProgressPipelineStages(progress);
  if (progressStages) {
    return progressStages;
  }

  if (isPending || !buildTest) {
    return [
      { label: 'COBOL Oracle', status: 'pending', detail: 'Waiting for oracle output' },
      { label: 'Java Compilation', status: 'pending', detail: 'Waiting for compilation' },
      { label: 'Java Execution', status: 'pending', detail: 'Waiting for program execution' },
      { label: 'Equivalence Check', status: 'pending', detail: 'Waiting for comparison results' },
    ];
  }

  const { status, classification } = buildTest;
  const oracleBlocked = status === 'missing-golden-master';
  const oracleFailed = status === 'golden-master-reproduction-failed';
  const compileFailed = status === 'compile-failed' || classification === 'compile-error';
  const runFailed = status === 'run-failed' || classification === 'run-error';

  const oracleStage: PipelineStageState = oracleBlocked
    ? { label: 'COBOL Oracle', status: 'blocked', detail: 'Golden master unavailable' }
    : oracleFailed
      ? { label: 'COBOL Oracle', status: 'error', detail: 'Oracle reproduction failed' }
      : { label: 'COBOL Oracle', status: 'success', detail: 'Oracle output available' };

  const compilationStage: PipelineStageState = oracleBlocked || oracleFailed || status === 'skipped'
    ? { label: 'Java Compilation', status: 'blocked', detail: 'Blocked before compilation started' }
    : compileFailed
      ? { label: 'Java Compilation', status: 'error', detail: 'Compilation failed' }
      : { label: 'Java Compilation', status: 'success', detail: 'Compilation succeeded' };

  const executionStage: PipelineStageState =
    oracleBlocked || oracleFailed || status === 'skipped'
      ? { label: 'Java Execution', status: 'blocked', detail: 'Blocked before execution started' }
      : compileFailed
        ? { label: 'Java Execution', status: 'blocked', detail: 'Blocked by compilation failure' }
        : runFailed
          ? { label: 'Java Execution', status: 'error', detail: 'Execution failed' }
          : { label: 'Java Execution', status: 'success', detail: 'Execution completed' };

  let equivalenceStatus: StatusVariant = mapBuildTestClassificationToVariant(classification);
  if (classification === 'compile-error' || classification === 'run-error') {
    equivalenceStatus = 'blocked';
  }

  const equivalenceStage: PipelineStageState = {
    label: 'Equivalence Check',
    status: equivalenceStatus,
    detail: describeClassification(classification),
  };

  return [oracleStage, compilationStage, executionStage, equivalenceStage];
}

export function deriveRunProblems(state: TransformationRunState): RunProblem[] {
  const problems: RunProblem[] = [];

  state.generated?.unsupportedFeatures?.forEach((feature) => {
    problems.push({ type: 'Unsupported Feature', message: feature });
  });

  state.generated?.missingArtifacts?.forEach((artifact) => {
    problems.push({ type: 'Missing Artifact (Generated)', message: artifact });
  });

  state.generatedFiles?.missingArtifacts?.forEach((artifact) => {
    problems.push({ type: 'Missing Artifact (Generated Files)', message: artifact });
  });

  state.evidence?.missingArtifacts?.forEach((artifact) => {
    problems.push({ type: 'Missing Artifact (Evidence)', message: artifact });
  });

  state.artifacts?.missingArtifacts?.forEach((artifact) => {
    problems.push({ type: 'Missing Artifact (Run Artifacts)', message: artifact });
  });

  if (state.buildTest?.status && state.buildTest.status !== 'ok') {
    problems.push({ type: 'Build/Test Failure', message: state.buildTest.note ?? state.buildTest.status });
  }

  switch (state.buildTest?.classification) {
    case 'divergence-known-w0-coverage-gap':
      problems.push({ type: 'Known Coverage Gap', message: 'Output diverges for a known W0 coverage gap' });
      break;
    case 'divergence-unknown':
      problems.push({ type: 'Equivalence Mismatch', message: 'Java output diverges from the COBOL oracle' });
      break;
    case 'true-golden-master-reproduction-error':
      problems.push({ type: 'Golden Master Regression', message: 'Golden-master reproduction failed unexpectedly' });
      break;
    case 'true-golden-master-mismatch':
      problems.push({ type: 'Golden Master Regression', message: 'Golden-master output mismatched unexpectedly' });
      break;
  }

  if (state.evidence?.status === 'incomplete') {
    problems.push({ type: 'Evidence Incomplete', message: state.evidence.note ?? 'The evidence pack is missing required artifacts' });
  }

  if (state.evidence?.status === 'invalid') {
    problems.push({ type: 'Evidence Invalid', message: state.evidence.note ?? 'The evidence pack is invalid and cannot be trusted' });
  }

  if (state.artifactsError) {
    problems.push({ type: 'Artifacts Fetch Error', message: state.artifactsError });
  }

  const alignment = buildArtifactAlignment(state);
  if (alignment.distinctShas.length > 1) {
    problems.push({
      type: 'Artifact Reference Mismatch',
      message: 'Generated Java, build/test, and evidence do not reference the same artifact hash',
    });
  }

  if (
    state.phase === 'verification-blocked' &&
    alignment.distinctShas.length <= 1 &&
    !state.artifactsError
  ) {
    problems.push({
      type: 'Verification Blocked',
      message: 'The run completed, but verification could not be completed from the available artifact views',
    });
  }

  return problems;
}

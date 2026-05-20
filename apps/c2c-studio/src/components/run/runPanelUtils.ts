import {
  BuildTestView,
  OutputRef,
  RunProgressStep,
  RunProgressView,
} from '@/types/api';
import type { ManualDriftSummary } from '@/stores/transformationRun';
import { TransformationRunState } from '@/types/run';
import { StatusVariant, mapBuildTestClassificationToVariant } from '@/types/design';

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

export interface BuildTestResultPresentation {
  label: string;
  tone: StatusVariant;
  detail: string;
}

export interface BuildTestMetadataItem {
  label: string;
  value: string;
  copyValue?: string;
  ref?: OutputRef | null;
}

export interface OutputDiffLine {
  kind: "equal" | "added" | "removed";
  content: string;
  expectedLineNumber?: number;
  actualLineNumber?: number;
}

export function splitOutputLines(value?: string): string[] {
  if (!value) {
    return [''];
  }

  return value.replace(/\r\n/g, '\n').split('\n');
}

function humanizeToken(value: string): string {
  if (!value) {
    return 'Unavailable';
  }

  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function describeOutputRef(ref?: OutputRef | null): string {
  if (!ref) {
    return 'Unavailable';
  }

  const kind = ref.kind ? humanizeToken(ref.kind) : 'Content-addressed reference';
  const shortHash = ref.sha256.slice(0, 12);
  const size = typeof ref.byteSize === 'number' ? ` · ${ref.byteSize} bytes` : '';
  return `${kind} · ${shortHash}${size}`;
}

function getComparisonPolicyLabel(buildTest: BuildTestView): string | null {
  if (typeof buildTest.comparisonPolicy === 'string' && buildTest.comparisonPolicy.trim().length > 0) {
    return humanizeToken(buildTest.comparisonPolicy);
  }

  const comparison = buildTest.comparison;
  if (!comparison || Array.isArray(comparison)) {
    return null;
  }

  const candidateKeys = ['comparisonPolicy', 'policy', 'strategy', 'mode', 'type'];
  const comparisonRecord = comparison as Record<string, unknown>;
  for (const key of candidateKeys) {
    const candidate = comparisonRecord[key];
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return humanizeToken(candidate);
    }
  }

  return null;
}

export function describeBuildTestResult(
  buildTest: BuildTestView | null,
): BuildTestResultPresentation {
  if (!buildTest) {
    return {
      label: 'Waiting for build/test results',
      tone: 'pending',
      detail: 'The equivalence check has not completed yet.',
    };
  }

  switch (buildTest.classification) {
    case 'match':
      return {
        label: 'Pass',
        tone: 'success',
        detail: 'Expected and actual outputs are equivalent.',
      };
    case 'divergence-known-w0-coverage-gap':
      return {
        label: 'Known divergence',
        tone: 'warning',
        detail: 'The output mismatch is expected for a known W0 coverage gap.',
      };
    case 'divergence-unknown':
      return {
        label: 'Mismatch detected',
        tone: 'error',
        detail: 'The Java execution diverged from the COBOL oracle.',
      };
    case 'true-golden-master-reproduction-error':
      return {
        label: 'Golden-master reproduction failed',
        tone: 'error',
        detail: 'The oracle reproduction path did not complete successfully.',
      };
    case 'true-golden-master-mismatch':
      return {
        label: 'Golden-master mismatch',
        tone: 'error',
        detail: 'The reproduced golden master did not match the expected output.',
      };
    case 'compile-error':
      return {
        label: 'Blocked by compilation failure',
        tone: 'warning',
        detail: 'Java compilation failed before equivalence could run.',
      };
    case 'run-error':
      return {
        label: 'Blocked by runtime failure',
        tone: 'warning',
        detail: 'Java execution failed before equivalence could run.',
      };
    case 'skipped-no-execution':
      return {
        label: 'Not executed',
        tone: 'neutral',
        detail: 'The run was skipped before execution reached the comparison step.',
      };
    default:
      return {
        label: describeClassification(buildTest.classification),
        tone: mapBuildTestClassificationToVariant(buildTest.classification),
        detail: buildTest.note ?? 'Comparison result available.',
      };
  }
}

export function describeBuildTestMode(buildTest: BuildTestView | null): string {
  if (!buildTest) {
    return 'Unavailable';
  }

  return buildTest.executionMode ? humanizeToken(buildTest.executionMode) : humanizeToken(buildTest.mode);
}

export function describeBuildTestProductMode(buildTest: BuildTestView | null): string {
  if (!buildTest) {
    return 'Unavailable';
  }

  return buildTest.productMode === 'live' ? 'Live product' : 'Product unavailable';
}

export function getBuildTestMetadataItems(
  buildTest: BuildTestView | null,
): BuildTestMetadataItem[] {
  if (!buildTest) {
    return [];
  }

  const items: BuildTestMetadataItem[] = [
    {
      label: 'Run ID',
      value: buildTest.runId || 'Unavailable',
      copyValue: buildTest.runId || undefined,
    },
    {
      label: 'Execution mode',
      value: describeBuildTestMode(buildTest),
      copyValue: buildTest.executionMode ?? buildTest.mode ?? undefined,
    },
    {
      label: 'Product mode',
      value: describeBuildTestProductMode(buildTest),
      copyValue: buildTest.productMode || undefined,
    },
  ];

  const policyLabel = getComparisonPolicyLabel(buildTest);
  if (policyLabel) {
    items.push({
      label: 'Comparison policy',
      value: policyLabel,
      copyValue: buildTest.comparisonPolicy ?? policyLabel,
    });
  }

  return items;
}

export function getBuildTestArtifactRefs(
  buildTest: BuildTestView | null,
): ArtifactReferenceEntry[] {
  if (!buildTest) {
    return [];
  }

  return [
    { label: 'Expected output', ref: buildTest.expectedOutputRef },
    { label: 'Actual output', ref: buildTest.actualOutputRef },
    { label: 'Output ref', ref: buildTest.outputRef },
    { label: 'Generated artifact', ref: buildTest.generatedArtifactRef },
  ].filter((entry, index, entries) => {
    const sha = entry.ref?.sha256;
    if (!sha) {
      return false;
    }

    return entries.findIndex((candidate) => candidate.ref?.sha256 === sha) === index;
  });
}

export function getBuildTestReferenceSummary(ref?: OutputRef | null): string {
  return describeOutputRef(ref);
}

const DIFF_MATRIX_LIMIT = 250_000;

function buildFallbackDiff(
  expectedLines: string[],
  actualLines: string[],
): OutputDiffLine[] {
  const lines: OutputDiffLine[] = [];
  const maxLength = Math.max(expectedLines.length, actualLines.length);

  for (let index = 0; index < maxLength; index += 1) {
    const expected = expectedLines[index];
    const actual = actualLines[index];

    if (expected === actual) {
      lines.push({
        kind: 'equal',
        content: expected ?? '',
        expectedLineNumber: index + 1,
        actualLineNumber: index + 1,
      });
      continue;
    }

    if (expected !== undefined) {
      lines.push({
        kind: 'removed',
        content: expected,
        expectedLineNumber: index + 1,
      });
    }

    if (actual !== undefined) {
      lines.push({
        kind: 'added',
        content: actual,
        actualLineNumber: index + 1,
      });
    }
  }

  return lines;
}

export function buildOutputDiff(
  expected?: string,
  actual?: string,
): OutputDiffLine[] {
  const expectedLines = splitOutputLines(expected);
  const actualLines = splitOutputLines(actual);

  if (
    expectedLines.length === actualLines.length &&
    expectedLines.every((line, index) => line === actualLines[index])
  ) {
    return expectedLines.map((line, index) => ({
      kind: 'equal',
      content: line,
      expectedLineNumber: index + 1,
      actualLineNumber: index + 1,
    }));
  }

  let start = 0;
  const maxStart = Math.min(expectedLines.length, actualLines.length);
  while (start < maxStart && expectedLines[start] === actualLines[start]) {
    start += 1;
  }

  let expectedEnd = expectedLines.length - 1;
  let actualEnd = actualLines.length - 1;
  while (
    expectedEnd >= start &&
    actualEnd >= start &&
    expectedLines[expectedEnd] === actualLines[actualEnd]
  ) {
    expectedEnd -= 1;
    actualEnd -= 1;
  }

  const prefix = expectedLines.slice(0, start).map((line, index) => ({
    kind: 'equal' as const,
    content: line,
    expectedLineNumber: index + 1,
    actualLineNumber: index + 1,
  }));
  const suffix = expectedLines.slice(expectedEnd + 1).map((line, index) => {
    const lineNumber = expectedEnd + 2 + index;
    return {
      kind: 'equal' as const,
      content: line,
      expectedLineNumber: lineNumber,
      actualLineNumber: lineNumber,
    };
  });

  const middleExpected = expectedLines.slice(start, expectedEnd + 1);
  const middleActual = actualLines.slice(start, actualEnd + 1);

  if (middleExpected.length * middleActual.length > DIFF_MATRIX_LIMIT) {
    return [
      ...prefix,
      ...buildFallbackDiff(middleExpected, middleActual),
      ...suffix,
    ];
  }

  const rows = middleExpected.length;
  const cols = middleActual.length;
  const matrix: number[][] = Array.from({ length: rows + 1 }, () =>
    Array<number>(cols + 1).fill(0),
  );

  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let col = cols - 1; col >= 0; col -= 1) {
      matrix[row][col] =
        middleExpected[row] === middleActual[col]
          ? matrix[row + 1][col + 1] + 1
          : Math.max(matrix[row + 1][col], matrix[row][col + 1]);
    }
  }

  const diff: OutputDiffLine[] = [...prefix];
  let row = 0;
  let col = 0;
  while (row < rows && col < cols) {
    if (middleExpected[row] === middleActual[col]) {
      diff.push({
        kind: 'equal',
        content: middleExpected[row],
        expectedLineNumber: start + row + 1,
        actualLineNumber: start + col + 1,
      });
      row += 1;
      col += 1;
      continue;
    }

    if (matrix[row + 1][col] >= matrix[row][col + 1]) {
      diff.push({
        kind: 'removed',
        content: middleExpected[row],
        expectedLineNumber: start + row + 1,
      });
      row += 1;
    } else {
      diff.push({
        kind: 'added',
        content: middleActual[col],
        actualLineNumber: start + col + 1,
      });
      col += 1;
    }
  }

  while (row < rows) {
    diff.push({
      kind: 'removed',
      content: middleExpected[row],
      expectedLineNumber: start + row + 1,
    });
    row += 1;
  }

  while (col < cols) {
    diff.push({
      kind: 'added',
      content: middleActual[col],
      actualLineNumber: start + col + 1,
    });
    col += 1;
  }

  diff.push(...suffix);
  return diff;
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

export function describeManualDriftSummary(summary: ManualDriftSummary | null): string | null {
  if (!summary || !summary.hasManualEdits) {
    return null;
  }

  const baselineRunIds = summary.baselineRunIds.slice(0, 3);
  const hasMoreBaselineRuns = summary.baselineRunIds.length > baselineRunIds.length;
  const runLabel =
    baselineRunIds.length === 1
      ? `run ${baselineRunIds[0]}`
      : baselineRunIds.length > 1
        ? `runs ${baselineRunIds.join(', ')}${hasMoreBaselineRuns ? ', …' : ''}`
        : 'the Generator Baseline';
  const fileLabel = summary.fileCount === 1 ? 'file' : 'files';
  const regionLabel = summary.regionCount === 1 ? 'region' : 'regions';

  return `Current Java diverges from ${runLabel}. ${summary.fileCount} ${fileLabel} and ${summary.regionCount} ${regionLabel} carry manual edit provenance, so build/test and evidence are stale until you rerun.`;
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

  return problems;
}

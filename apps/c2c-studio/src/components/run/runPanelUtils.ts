import {
  BuildTestView,
  OutputRef,
  RunArtifactMetadata,
  RunProgressStep,
  RunProgressView,
  RunWorkflowView,
  TrustSummaryView,
} from "@/types/api";
import type { ManualDriftSummary } from "@/stores/transformationRun";
import { TransformationRunState } from "@/types/run";
import {
  StatusVariant,
  mapBuildTestClassificationToVariant,
} from "@/types/design";

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

export interface WorkflowMetadataItem {
  label: string;
  value: string;
  copyValue?: string;
}

export interface OutputDiffLine {
  kind: "equal" | "added" | "removed";
  content: string;
  expectedLineNumber?: number;
  actualLineNumber?: number;
}

export interface EvidenceArtifactCandidate {
  key: string;
  label: string;
  path: string;
  kind: string;
  sha256: string;
  byteSize?: number;
  mimeType?: string;
  stageId: TimelineStageId;
  fetchKind: "artifact" | "generated";
  summary: string;
}

export type TimelineStageId =
  | "transform"
  | "source-reference"
  | "java-build"
  | "java-execution"
  | "output-normalization"
  | "parity-comparison"
  | "verification-repair"
  | "evidence-capture";

export interface TimelineStageDetail {
  id: TimelineStageId;
  label: string;
  status: StatusVariant;
  detail: string;
  actor: string;
  durationText: string;
  evidenceCount: number;
  actionLabel: string | null;
  diagnostic: string | null;
}

export function splitOutputLines(value?: string): string[] {
  if (!value) {
    return [""];
  }

  return value.replace(/\r\n/g, "\n").split("\n");
}

function humanizeToken(value: string): string {
  if (!value) {
    return "Unavailable";
  }

  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatDurationMs(value?: number): string {
  if (value === undefined || value < 0) {
    return "Pending";
  }
  if (value < 1000) {
    return `${value} ms`;
  }
  const seconds = value / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(seconds >= 10 ? 0 : 1)} s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = Math.round(seconds % 60);
  return `${minutes}m ${remainderSeconds}s`;
}

function describeOutputRef(ref?: OutputRef | null): string {
  if (!ref) {
    return "Unavailable";
  }

  const kind = ref.kind
    ? humanizeToken(ref.kind)
    : "Content-addressed reference";
  const shortHash = ref.sha256.slice(0, 12);
  const size =
    typeof ref.byteSize === "number" ? ` · ${ref.byteSize} bytes` : "";
  return `${kind} · ${shortHash}${size}`;
}

function getComparisonPolicyLabel(buildTest: BuildTestView): string | null {
  if (
    typeof buildTest.comparisonPolicy === "string" &&
    buildTest.comparisonPolicy.trim().length > 0
  ) {
    return humanizeToken(buildTest.comparisonPolicy);
  }

  const comparison = buildTest.comparison;
  if (!comparison || Array.isArray(comparison)) {
    return null;
  }

  const candidateKeys = [
    "comparisonPolicy",
    "policy",
    "strategy",
    "mode",
    "type",
  ];
  const comparisonRecord = comparison as Record<string, unknown>;
  for (const key of candidateKeys) {
    const candidate = comparisonRecord[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return humanizeToken(candidate);
    }
  }

  return null;
}

export function describeBuildTestResult(
  buildTest: BuildTestView | null,
  intentionalDivergence = false,
): BuildTestResultPresentation {
  if (!buildTest) {
    return {
      label: "Waiting for build/test results",
      tone: "pending",
      detail: "The equivalence check has not completed yet.",
    };
  }

  if (intentionalDivergence) {
    return {
      label: "Intentionally diverged",
      tone: "warning",
      detail:
        "The outputs were governed as intentionally not equivalent. Review the documented rationale and evidence.",
    };
  }

  switch (buildTest.classification) {
    case "match":
      return {
        label: "Pass",
        tone: "success",
        detail: "Expected and actual outputs are equivalent.",
      };
    case "divergence-known-w0-coverage-gap":
      return {
        label: "Known divergence",
        tone: "warning",
        detail: "The output mismatch is expected for a known W0 coverage gap.",
      };
    case "divergence-unknown":
      return {
        label: "Mismatch detected",
        tone: "error",
        detail: "The Java execution diverged from the COBOL oracle.",
      };
    case "true-golden-master-reproduction-error":
      return {
        label: "Golden-master reproduction failed",
        tone: "error",
        detail: "The oracle reproduction path did not complete successfully.",
      };
    case "true-golden-master-mismatch":
      return {
        label: "Golden-master mismatch",
        tone: "error",
        detail:
          "The reproduced golden master did not match the expected output.",
      };
    case "compile-error":
      return {
        label: "Blocked by compilation failure",
        tone: "warning",
        detail: "Java compilation failed before equivalence could run.",
      };
    case "run-error":
      return {
        label: "Blocked by runtime failure",
        tone: "warning",
        detail: "Java execution failed before equivalence could run.",
      };
    case "skipped-no-execution":
      return {
        label: "Not executed",
        tone: "neutral",
        detail:
          "The run was skipped before execution reached the comparison step.",
      };
    default:
      return {
        label: describeClassification(buildTest.classification),
        tone: mapBuildTestClassificationToVariant(buildTest.classification),
        detail: buildTest.note ?? "Comparison result available.",
      };
  }
}

export function describeBuildTestMode(buildTest: BuildTestView | null): string {
  if (!buildTest) {
    return "Unavailable";
  }

  return buildTest.executionMode
    ? humanizeToken(buildTest.executionMode)
    : humanizeToken(buildTest.mode);
}

export function describeBuildTestProductMode(
  buildTest: BuildTestView | null,
): string {
  if (!buildTest) {
    return "Unavailable";
  }

  return buildTest.productMode === "live"
    ? "Live product"
    : "Product unavailable";
}

export function getBuildTestMetadataItems(
  buildTest: BuildTestView | null,
): BuildTestMetadataItem[] {
  if (!buildTest) {
    return [];
  }

  const items: BuildTestMetadataItem[] = [
    {
      label: "Run ID",
      value: buildTest.runId || "Unavailable",
      copyValue: buildTest.runId || undefined,
    },
    {
      label: "Execution mode",
      value: describeBuildTestMode(buildTest),
      copyValue: buildTest.executionMode ?? buildTest.mode ?? undefined,
    },
    {
      label: "Product mode",
      value: describeBuildTestProductMode(buildTest),
      copyValue: buildTest.productMode || undefined,
    },
  ];

  const policyLabel = getComparisonPolicyLabel(buildTest);
  if (policyLabel) {
    items.push({
      label: "Comparison policy",
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
    { label: "Expected output", ref: buildTest.expectedOutputRef },
    { label: "Actual output", ref: buildTest.actualOutputRef },
    { label: "Output ref", ref: buildTest.outputRef },
    { label: "Generated artifact", ref: buildTest.generatedArtifactRef },
  ].filter((entry, index, entries) => {
    const sha = entry.ref?.sha256;
    if (!sha) {
      return false;
    }

    return (
      entries.findIndex((candidate) => candidate.ref?.sha256 === sha) === index
    );
  });
}

export function getBuildTestReferenceSummary(ref?: OutputRef | null): string {
  return describeOutputRef(ref);
}

function describeBudget(
  label: string,
  budget: { used: number; limit: number } | null | undefined,
): string {
  if (!budget) {
    return `${label} unavailable`;
  }

  return `${budget.used}/${budget.limit} used`;
}

function describeWorkflowOutcome(workflow: RunWorkflowView | null): string {
  if (!workflow) {
    return "Unavailable";
  }

  if (workflow.finalClassification) {
    return humanizeToken(workflow.finalClassification);
  }

  if (workflow.state) {
    return humanizeToken(workflow.state);
  }

  return "In progress";
}

export function getWorkflowMetadataItems(
  workflow: RunWorkflowView | null,
): WorkflowMetadataItem[] {
  if (!workflow) {
    return [];
  }

  const items: WorkflowMetadataItem[] = [
    {
      label: "Workflow state",
      value: describeWorkflowOutcome(workflow),
      copyValue: workflow.state ?? workflow.finalClassification ?? undefined,
    },
    {
      label: "Active step",
      value: workflow.activeStep
        ? humanizeToken(workflow.activeStep)
        : "Unavailable",
      copyValue: workflow.activeStep ?? undefined,
    },
    {
      label: "Active agent",
      value: workflow.activeAgent
        ? humanizeToken(workflow.activeAgent)
        : "Unavailable",
      copyValue: workflow.activeAgent ?? undefined,
    },
    {
      label: "Failure code",
      value: workflow.failureCode
        ? humanizeToken(workflow.failureCode)
        : "None",
      copyValue: workflow.failureCode ?? undefined,
    },
    {
      label: "Failure message",
      value: workflow.failureMessage ?? "None",
      copyValue: workflow.failureMessage ?? undefined,
    },
    {
      label: "Repair budget",
      value: describeBudget("Repair budget", workflow.repairBudget),
    },
    {
      label: "Assist budget",
      value: describeBudget("Assist budget", workflow.assistBudget),
    },
    {
      label: "Model budget",
      value: describeBudget("Model budget", workflow.modelInvocationBudget),
    },
    {
      label: "Agent attempts",
      value: String(workflow.agentAttemptCount),
      copyValue: String(workflow.agentAttemptCount),
    },
  ];

  return items;
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
        kind: "equal",
        content: expected ?? "",
        expectedLineNumber: index + 1,
        actualLineNumber: index + 1,
      });
      continue;
    }

    if (expected !== undefined) {
      lines.push({
        kind: "removed",
        content: expected,
        expectedLineNumber: index + 1,
      });
    }

    if (actual !== undefined) {
      lines.push({
        kind: "added",
        content: actual,
        actualLineNumber: index + 1,
      });
    }
  }

  return lines;
}

// Diff-local splitter: an undefined/empty side has zero lines, so the diff
// never emits a phantom removed/added empty line. splitOutputLines keeps its
// ['']-for-empty behavior for split-view rendering.
function splitDiffLines(value?: string): string[] {
  if (!value) {
    return [];
  }
  return splitOutputLines(value);
}

export function buildOutputDiff(
  expected?: string,
  actual?: string,
): OutputDiffLine[] {
  const expectedLines = splitDiffLines(expected);
  const actualLines = splitDiffLines(actual);

  if (
    expectedLines.length === actualLines.length &&
    expectedLines.every((line, index) => line === actualLines[index])
  ) {
    return expectedLines.map((line, index) => ({
      kind: "equal",
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
    kind: "equal" as const,
    content: line,
    expectedLineNumber: index + 1,
    actualLineNumber: index + 1,
  }));
  const suffix = expectedLines.slice(expectedEnd + 1).map((line, index) => ({
    kind: "equal" as const,
    content: line,
    expectedLineNumber: expectedEnd + 2 + index,
    actualLineNumber: actualEnd + 2 + index,
  }));

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
        kind: "equal",
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
        kind: "removed",
        content: middleExpected[row],
        expectedLineNumber: start + row + 1,
      });
      row += 1;
    } else {
      diff.push({
        kind: "added",
        content: middleActual[col],
        actualLineNumber: start + col + 1,
      });
      col += 1;
    }
  }

  while (row < rows) {
    diff.push({
      kind: "removed",
      content: middleExpected[row],
      expectedLineNumber: start + row + 1,
    });
    row += 1;
  }

  while (col < cols) {
    diff.push({
      kind: "added",
      content: middleActual[col],
      actualLineNumber: start + col + 1,
    });
    col += 1;
  }

  diff.push(...suffix);
  return diff;
}

export function buildArtifactAlignment(
  state: TransformationRunState,
): ArtifactAlignment {
  const entries: ArtifactReferenceEntry[] = [
    { label: "Generated Java", ref: state.generated?.artifactRef },
    { label: "Build & Test", ref: state.buildTest?.generatedArtifactRef },
    { label: "Evidence Pack", ref: state.evidence?.generatedArtifactRef },
  ];

  const distinctShas = Array.from(
    new Set(
      entries
        .map((entry) => entry.ref?.sha256)
        .filter((sha): sha is string => Boolean(sha)),
    ),
  );
  const aligned =
    entries.every((entry) => entry.ref?.sha256) && distinctShas.length === 1;

  return {
    entries,
    aligned,
    expectedSha: aligned ? distinctShas[0] : null,
    distinctShas,
  };
}

export function isIntentionalDivergenceTrustSummary(
  trust: TrustSummaryView | null | undefined,
): boolean {
  return Boolean(
    trust &&
    (trust.trustState === "intentional_divergence" ||
      trust.divergenceDisposition === "intentional"),
  );
}

export function describeManualDriftSummary(
  summary: ManualDriftSummary | null,
): string | null {
  if (!summary || !summary.hasManualEdits) {
    return null;
  }

  const baselineRunIds = summary.baselineRunIds.slice(0, 3);
  const hasMoreBaselineRuns =
    summary.baselineRunIds.length > baselineRunIds.length;
  const runLabel =
    baselineRunIds.length === 1
      ? `run ${baselineRunIds[0]}`
      : baselineRunIds.length > 1
        ? `runs ${baselineRunIds.join(", ")}${hasMoreBaselineRuns ? ", …" : ""}`
        : "the Generator Baseline";
  const fileLabel = summary.fileCount === 1 ? "file" : "files";
  const regionLabel = summary.regionCount === 1 ? "region" : "regions";
  const provenanceClause =
    summary.regionCount === 0
      ? `${summary.fileCount} ${fileLabel}`
      : `${summary.fileCount} ${fileLabel} and ${summary.regionCount} ${regionLabel}`;

  return `Current Java diverges from ${runLabel}. ${provenanceClause} carry manual edit provenance, so build/test and evidence are stale until you rerun.`;
}

export function describeClassification(
  classification?: BuildTestView["classification"],
): string {
  switch (classification) {
    case "match":
      return "Equivalent";
    case "divergence-known-w0-coverage-gap":
      return "Known W0 coverage gap";
    case "divergence-unknown":
      return "Unexpected output divergence";
    case "true-golden-master-reproduction-error":
      return "Golden-master reproduction error";
    case "true-golden-master-mismatch":
      return "Golden-master mismatch";
    case "compile-error":
      return "Blocked by compilation failure";
    case "run-error":
      return "Blocked by runtime failure";
    case "skipped-no-execution":
      return "Blocked before equivalence could run";
    default:
      return classification ?? "Waiting for equivalence results";
  }
}

const PROGRESS_STEP_LABELS: Record<string, string> = {
  accepted: "Accepted",
  "parse-cobol": "Parse COBOL",
  "generate-ir": "Generate IR",
  "generate-java": "Generate Java",
  "compile-test-java": "Compile & Test Java",
  "model-guidance": "Model Guidance",
  "model-policy-skipped": "Model Policy Skipped",
  "write-evidence": "Write Evidence",
  completed: "Completed",
  failed: "Failed",
};

function formatProgressStepLabel(stepName: string): string {
  const known = PROGRESS_STEP_LABELS[stepName];
  if (known) {
    return known;
  }

  return stepName
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function mapProgressStepStatus(
  status: RunProgressStep["status"],
): StatusVariant {
  switch (status) {
    case "ok":
      return "success";
    case "failed":
      return "error";
    case "skipped":
      return "neutral";
    case "running":
      return "pending";
    case "pending":
    default:
      return "pending";
  }
}

function describeProgressStep(step: RunProgressStep): string {
  const owner = step.actor || step.service || step.capabilityId || "pipeline";

  switch (step.status) {
    case "ok":
      return step.latencyMs !== undefined
        ? `${owner} completed in ${step.latencyMs} ms`
        : `${owner} completed`;
    case "failed":
      return step.diagnostic ? `Failed: ${step.diagnostic}` : `${owner} failed`;
    case "skipped":
      return step.diagnostic
        ? `Skipped: ${step.diagnostic}`
        : `${owner} skipped`;
    case "running":
      return `${owner} is running`;
    case "pending":
    default:
      return `Waiting for ${owner}`;
  }
}

function artifactSummary(artifact: {
  kind?: string;
  sha256?: string;
  byteSize?: number;
}): string {
  const shortHash = artifact.sha256 ? artifact.sha256.slice(0, 12) : "unknown";
  const size =
    artifact.byteSize !== undefined ? ` · ${artifact.byteSize} bytes` : "";
  return `${humanizeToken(artifact.kind ?? "artifact")} · ${shortHash}${size}`;
}

function getProgressPipelineStages(
  progress?: RunProgressView | null,
): PipelineStageState[] | null {
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
  progress?: RunProgressView | null,
): PipelineStageState[] {
  const progressStages = getProgressPipelineStages(progress);
  if (progressStages) {
    return progressStages;
  }

  if (isPending || !buildTest) {
    return [
      {
        label: "COBOL Oracle",
        status: "pending",
        detail: "Waiting for oracle output",
      },
      {
        label: "Java Compilation",
        status: "pending",
        detail: "Waiting for compilation",
      },
      {
        label: "Java Execution",
        status: "pending",
        detail: "Waiting for program execution",
      },
      {
        label: "Equivalence Check",
        status: "pending",
        detail: "Waiting for comparison results",
      },
    ];
  }

  const { status, classification } = buildTest;
  const oracleBlocked = status === "missing-golden-master";
  const oracleFailed = status === "golden-master-reproduction-failed";
  const compileFailed =
    status === "compile-failed" || classification === "compile-error";
  const runFailed = status === "run-failed" || classification === "run-error";

  const oracleStage: PipelineStageState = oracleBlocked
    ? {
        label: "COBOL Oracle",
        status: "blocked",
        detail: "Golden master unavailable",
      }
    : oracleFailed
      ? {
          label: "COBOL Oracle",
          status: "error",
          detail: "Oracle reproduction failed",
        }
      : {
          label: "COBOL Oracle",
          status: "success",
          detail: "Oracle output available",
        };

  const compilationStage: PipelineStageState =
    oracleBlocked || oracleFailed || status === "skipped"
      ? {
          label: "Java Compilation",
          status: "blocked",
          detail: "Blocked before compilation started",
        }
      : compileFailed
        ? {
            label: "Java Compilation",
            status: "error",
            detail: "Compilation failed",
          }
        : {
            label: "Java Compilation",
            status: "success",
            detail: "Compilation succeeded",
          };

  const executionStage: PipelineStageState =
    oracleBlocked || oracleFailed || status === "skipped"
      ? {
          label: "Java Execution",
          status: "blocked",
          detail: "Blocked before execution started",
        }
      : compileFailed
        ? {
            label: "Java Execution",
            status: "blocked",
            detail: "Blocked by compilation failure",
          }
        : runFailed
          ? {
              label: "Java Execution",
              status: "error",
              detail: "Execution failed",
            }
          : {
              label: "Java Execution",
              status: "success",
              detail: "Execution completed",
            };

  let equivalenceStatus: StatusVariant =
    mapBuildTestClassificationToVariant(classification);
  if (classification === "compile-error" || classification === "run-error") {
    equivalenceStatus = "blocked";
  }

  const equivalenceStage: PipelineStageState = {
    label: "Equivalence Check",
    status: equivalenceStatus,
    detail: describeClassification(classification),
  };

  return [oracleStage, compilationStage, executionStage, equivalenceStage];
}

const TIMELINE_STAGE_LABELS: Record<TimelineStageId, string> = {
  transform: "Transform",
  "source-reference": "COBOL Reference Execution",
  "java-build": "Java Build",
  "java-execution": "Java Execution",
  "output-normalization": "Output Normalization",
  "parity-comparison": "Parity Comparison",
  "verification-repair": "Repair Review",
  "evidence-capture": "Evidence Capture",
};

function mapProgressStepToTimelineStage(
  stepName: string,
): TimelineStageId | null {
  if (
    stepName === "accepted" ||
    stepName === "parse-cobol" ||
    stepName === "generate-ir" ||
    stepName === "generate-java" ||
    stepName === "model-guidance" ||
    stepName === "model-policy-skipped"
  ) {
    return "transform";
  }
  if (
    stepName.includes("source-reference") ||
    stepName.includes("golden-master") ||
    stepName.includes("oracle")
  ) {
    return "source-reference";
  }
  if (stepName === "compile-test-java" || stepName.includes("compile")) {
    return "java-build";
  }
  if (stepName.includes("execution") || stepName.includes("runtime")) {
    return "java-execution";
  }
  if (stepName.includes("normalized")) {
    return "output-normalization";
  }
  if (stepName.includes("comparison")) {
    return "parity-comparison";
  }
  if (stepName.includes("repair")) {
    return "verification-repair";
  }
  if (stepName === "write-evidence" || stepName.includes("evidence")) {
    return "evidence-capture";
  }
  return null;
}

function inferArtifactStage(
  artifact: Pick<RunArtifactMetadata, "kind" | "path">,
): TimelineStageId {
  const haystack = `${artifact.kind} ${artifact.path}`.toLowerCase();
  if (haystack.includes("repair")) return "verification-repair";
  if (haystack.includes("evidence")) return "evidence-capture";
  if (haystack.includes("comparison") || haystack.includes("diff"))
    return "parity-comparison";
  if (haystack.includes("normalized")) return "output-normalization";
  if (
    haystack.includes("runtime") ||
    haystack.includes("stdout") ||
    haystack.includes("stderr")
  ) {
    return "java-execution";
  }
  if (
    haystack.includes("build") ||
    haystack.includes("compile") ||
    haystack.includes("javac")
  ) {
    return "java-build";
  }
  if (
    haystack.includes("oracle") ||
    haystack.includes("golden-master") ||
    haystack.includes("source-ref")
  ) {
    return "source-reference";
  }
  return "transform";
}

export function getEvidenceArtifactCandidates(
  state: TransformationRunState,
): EvidenceArtifactCandidate[] {
  const artifactRows = (state.artifacts?.artifacts ?? []).map((artifact) => ({
    key: `artifact:${artifact.path}`,
    label: artifact.name || artifact.path,
    path: artifact.path,
    kind: artifact.kind,
    sha256: artifact.sha256,
    byteSize: artifact.byteSize,
    mimeType: artifact.mimeType,
    stageId: inferArtifactStage(artifact),
    fetchKind: "artifact" as const,
    summary: artifactSummary(artifact),
  }));
  const generatedRows = (state.generatedFiles?.files ?? []).map((file) => ({
    key: `generated:${file.path}`,
    label: file.path,
    path: file.path,
    kind: "generated-project-file",
    sha256: file.sha256 ?? "unknown",
    byteSize: file.byteSize,
    mimeType: file.mimeType,
    stageId: "transform" as const,
    fetchKind: "generated" as const,
    summary: artifactSummary({
      kind: "generated-project-file",
      sha256: file.sha256,
      byteSize: file.byteSize,
    }),
  }));
  return [...artifactRows, ...generatedRows];
}

function timelineActionLabel(
  stageId: TimelineStageId,
  status: StatusVariant,
): string | null {
  if (status === "success") {
    return "Review evidence";
  }
  if (status === "blocked") {
    return "Resolve the upstream failure to unblock this stage";
  }
  switch (stageId) {
    case "java-build":
      return "Inspect compile diagnostics";
    case "java-execution":
      return "Inspect runtime output";
    case "parity-comparison":
      return "Inspect diff and normalized outputs";
    case "verification-repair":
      return "Review repair diagnostics";
    case "evidence-capture":
      return "Inspect evidence manifest";
    default:
      return status === "pending"
        ? "Wait for the stage to complete"
        : "Review stage details";
  }
}

export function buildTimelineStages(
  state: TransformationRunState,
): TimelineStageDetail[] {
  const artifacts = getEvidenceArtifactCandidates(state);
  const progressSteps = [...(state.progress?.steps ?? [])].sort(
    (left, right) => left.stepId - right.stepId,
  );
  const buildTest = state.buildTest;
  const workflow = state.workflow;
  const evidence = state.evidence;

  const stageMap = new Map<TimelineStageId, TimelineStageDetail>();
  (Object.keys(TIMELINE_STAGE_LABELS) as TimelineStageId[]).forEach((id) => {
    stageMap.set(id, {
      id,
      label: TIMELINE_STAGE_LABELS[id],
      status: "pending",
      detail: "Waiting for backend evidence",
      actor: "orchestrator",
      durationText: "Pending",
      evidenceCount: artifacts.filter((artifact) => artifact.stageId === id)
        .length,
      actionLabel: null,
      diagnostic: null,
    });
  });

  for (const step of progressSteps) {
    const stageId = mapProgressStepToTimelineStage(step.name);
    if (!stageId) {
      continue;
    }
    const current = stageMap.get(stageId);
    if (!current) {
      continue;
    }
    const status = mapProgressStepStatus(step.status);
    stageMap.set(stageId, {
      ...current,
      status,
      detail: describeProgressStep(step),
      actor: step.actor || step.service || step.capabilityId || current.actor,
      durationText: formatDurationMs(step.latencyMs),
      diagnostic: step.diagnostic ?? null,
      actionLabel: timelineActionLabel(stageId, status),
    });
  }

  if (buildTest) {
    const buildStage = stageMap.get("java-build");
    if (buildStage && buildTest.compileStatus) {
      const status =
        buildTest.compileStatus === "ok"
          ? "success"
          : buildTest.compileStatus === "failed"
            ? "error"
            : buildTest.compileStatus === "skipped"
              ? "blocked"
              : buildStage.status;
      stageMap.set("java-build", {
        ...buildStage,
        status,
        detail:
          buildTest.compileStatus === "ok"
            ? "The generated Java project compiled successfully."
            : buildTest.compileStatus === "failed"
              ? "Compilation failed before the parity verdict could be completed."
              : buildStage.detail,
        actor: "build-test-runner",
        actionLabel: timelineActionLabel("java-build", status),
      });
    }
    const executionStage = stageMap.get("java-execution");
    if (executionStage && buildTest.executionStatus) {
      const status =
        buildTest.executionStatus === "ok"
          ? "success"
          : buildTest.executionStatus === "failed"
            ? "error"
            : buildTest.executionStatus === "skipped" ||
                buildTest.executionStatus === "not-run"
              ? "blocked"
              : executionStage.status;
      stageMap.set("java-execution", {
        ...executionStage,
        status,
        detail:
          buildTest.executionStatus === "ok"
            ? "The generated Java finished execution."
            : buildTest.executionStatus === "failed"
              ? "Execution failed before the parity verdict could be completed."
              : executionStage.detail,
        actor: "build-test-runner",
        actionLabel: timelineActionLabel("java-execution", status),
      });
    }
    const normalizationStage = stageMap.get("output-normalization");
    if (normalizationStage) {
      const hasNormalizationEvidence = Boolean(
        buildTest.comparison?.expectedRef ||
        buildTest.comparison?.actualRef ||
        buildTest.expectedOutputRef ||
        buildTest.actualOutputRef,
      );
      const status = hasNormalizationEvidence
        ? "success"
        : buildTest.classification === "compile-error" ||
            buildTest.classification === "run-error"
          ? "blocked"
          : normalizationStage.status;
      stageMap.set("output-normalization", {
        ...normalizationStage,
        status,
        detail: hasNormalizationEvidence
          ? "Normalized oracle and Java outputs are available for inspection."
          : normalizationStage.detail,
        actor: "build-test-runner",
        actionLabel: timelineActionLabel("output-normalization", status),
      });
    }
    const comparisonStage = stageMap.get("parity-comparison");
    if (comparisonStage) {
      const status: StatusVariant =
        buildTest.classification === "compile-error" ||
        buildTest.classification === "run-error"
          ? "blocked"
          : mapBuildTestClassificationToVariant(buildTest.classification);
      stageMap.set("parity-comparison", {
        ...comparisonStage,
        status,
        detail: describeBuildTestResult(buildTest).detail,
        actor: "build-test-runner",
        diagnostic: buildTest.note ?? null,
        actionLabel: timelineActionLabel("parity-comparison", status),
      });
    }
    const sourceReferenceStage = stageMap.get("source-reference");
    if (sourceReferenceStage && buildTest.status !== "missing-golden-master") {
      const status =
        buildTest.status === "golden-master-reproduction-failed"
          ? "error"
          : "success";
      stageMap.set("source-reference", {
        ...sourceReferenceStage,
        status,
        detail:
          status === "error"
            ? "The COBOL reference execution did not complete successfully."
            : "The COBOL reference output is available for parity comparison.",
        actor: "build-test-runner",
        actionLabel: timelineActionLabel("source-reference", status),
      });
    }
  }

  const repairStage = stageMap.get("verification-repair");
  if (repairStage && workflow) {
    const repairAttemptCount = workflow.repairAttempts.length;
    const status =
      workflow.activeAgent === "verification_repair_agent"
        ? "pending"
        : repairAttemptCount > 0
          ? workflow.finalClassification === "success"
            ? "success"
            : "warning"
          : workflow.finalClassification === "cancelled"
            ? "neutral"
            : repairStage.status;
    stageMap.set("verification-repair", {
      ...repairStage,
      status,
      detail:
        repairAttemptCount > 0
          ? `${repairAttemptCount} governed repair attempt${repairAttemptCount === 1 ? "" : "s"} recorded for this run.`
          : workflow.failureCode
            ? "No governed repair attempt was recorded for the current run."
            : "Repair has not been invoked for this run.",
      actor: workflow.activeAgent ?? "orchestrator",
      diagnostic: workflow.failureMessage ?? null,
      actionLabel: timelineActionLabel("verification-repair", status),
    });
  }

  const evidenceStage = stageMap.get("evidence-capture");
  if (evidenceStage && evidence) {
    const status =
      evidence.status === "complete"
        ? "success"
        : evidence.status === "invalid"
          ? "blocked"
          : "warning";
    stageMap.set("evidence-capture", {
      ...evidenceStage,
      status,
      detail:
        evidence.status === "complete"
          ? "The evidence manifest is complete and linked to the run artifacts."
          : (evidence.note ?? "The evidence bundle is partial or invalid."),
      actor: "evidence-service",
      actionLabel: timelineActionLabel("evidence-capture", status),
    });
  }

  if (workflow?.finalClassification === "cancelled") {
    for (const stage of stageMap.values()) {
      if (stage.status === "pending") {
        stage.status = "neutral";
        stage.detail = "The run was cancelled before this stage completed.";
        stage.actionLabel = "Rerun the parity workflow";
      }
    }
  }

  return (Object.keys(TIMELINE_STAGE_LABELS) as TimelineStageId[]).map(
    (id) => stageMap.get(id)!,
  );
}

export function deriveRunProblems(state: TransformationRunState): RunProblem[] {
  const problems: RunProblem[] = [];

  state.generated?.unsupportedFeatures?.forEach((feature) => {
    problems.push({ type: "Unsupported Feature", message: feature });
  });

  state.generated?.missingArtifacts?.forEach((artifact) => {
    problems.push({ type: "Missing Artifact (Generated)", message: artifact });
  });

  state.generatedFiles?.missingArtifacts?.forEach((artifact) => {
    problems.push({
      type: "Missing Artifact (Generated Files)",
      message: artifact,
    });
  });

  state.evidence?.missingArtifacts?.forEach((artifact) => {
    problems.push({ type: "Missing Artifact (Evidence)", message: artifact });
  });

  state.artifacts?.missingArtifacts?.forEach((artifact) => {
    problems.push({
      type: "Missing Artifact (Run Artifacts)",
      message: artifact,
    });
  });

  if (state.buildTest?.status && state.buildTest.status !== "ok") {
    problems.push({
      type: "Build/Test Failure",
      message: state.buildTest.note ?? state.buildTest.status,
    });
  }

  switch (state.buildTest?.classification) {
    case "divergence-known-w0-coverage-gap":
      problems.push({
        type: "Known Coverage Gap",
        message: "Output diverges for a known W0 coverage gap",
      });
      break;
    case "divergence-unknown":
      problems.push({
        type: "Equivalence Mismatch",
        message: "Java output diverges from the COBOL oracle",
      });
      break;
    case "true-golden-master-reproduction-error":
      problems.push({
        type: "Golden Master Regression",
        message: "Golden-master reproduction failed unexpectedly",
      });
      break;
    case "true-golden-master-mismatch":
      problems.push({
        type: "Golden Master Regression",
        message: "Golden-master output mismatched unexpectedly",
      });
      break;
  }

  if (state.evidence?.status === "incomplete") {
    problems.push({
      type: "Evidence Incomplete",
      message:
        state.evidence.note ??
        "The evidence pack is missing required artifacts",
    });
  }

  if (state.evidence?.status === "invalid") {
    problems.push({
      type: "Evidence Invalid",
      message:
        state.evidence.note ??
        "The evidence pack is invalid and cannot be trusted",
    });
  }

  if (state.artifactsError) {
    problems.push({
      type: "Artifacts Fetch Error",
      message: state.artifactsError,
    });
  }

  const alignment = buildArtifactAlignment(state);
  if (alignment.distinctShas.length > 1) {
    problems.push({
      type: "Artifact Reference Mismatch",
      message:
        "Generated Java, build/test, and evidence do not reference the same artifact hash",
    });
  }

  return problems;
}

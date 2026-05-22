import type { OutputRef, TrustSummary } from "./runViews";

export type OutputChangeCategory =
  | "cobol_edit"
  | "generated_java_refresh"
  | "manual_java_edit"
  | "repair_patch"
  | "trust_case_change"
  | "runtime_configuration_change"
  | "normalization_rule_change"
  | "cause_not_determinable";

export type OutputChangeUnavailableReason =
  | "previous_run_missing"
  | "same_run_not_allowed"
  | "run_not_completed"
  | "non_parity_run"
  | "missing_trust_summary"
  | "missing_normalized_output"
  | "missing_observed_output"
  | "evidence_incomplete";

export interface OutputChangeEvidenceLink {
  label: string;
  currentRef?: OutputRef | null;
  previousRef?: OutputRef | null;
}

export interface OutputChangeCategoryEntry {
  category: OutputChangeCategory;
  changed: boolean;
  title: string;
  detail: string;
  evidenceLinks: OutputChangeEvidenceLink[];
}

export interface OutputDeltaLine {
  kind: "context" | "added" | "removed";
  content: string;
}

export interface OutputChangeDeltaSummary {
  changed: boolean;
  addedLineCount: number;
  removedLineCount: number;
  excerpt: OutputDeltaLine[];
  currentNormalizedOutputRef: OutputRef | null;
  previousNormalizedOutputRef: OutputRef | null;
  currentComparisonDiffRef: OutputRef | null;
  previousComparisonDiffRef: OutputRef | null;
}

export interface OutputChangeAiSummary {
  status: "available" | "unavailable";
  label: string;
  groundingLabel: string;
  explanation?: string;
  modelInvocationRef?: string | null;
  ledgerRef?: string | null;
  unavailableReason?: "model_gateway_unavailable" | "insufficient_evidence";
}

export interface OutputChangeExplanationResult {
  schemaVersion: "v0";
  status: "available" | "unavailable";
  unavailableReason?: OutputChangeUnavailableReason;
  currentRunId: string;
  previousRunId: string;
  programId: string;
  currentTrustCaseId: string | null;
  previousTrustCaseId: string | null;
  determination: "single_change" | "multiple_changes" | "not_determinable";
  primaryCategory: OutputChangeCategory | null;
  summary: string;
  categories: OutputChangeCategoryEntry[];
  outputDelta: OutputChangeDeltaSummary | null;
  evidenceLinks: OutputChangeEvidenceLink[];
  aiSummary: OutputChangeAiSummary;
}

export interface OutputChangeRunArtifacts {
  runId: string;
  programId: string;
  status: string;
  executionMode?: string;
  trustCaseId?: string;
  trustCaseConfigurationDigest?: string;
  trustCaseEnvironmentProfileId?: string;
  trustCaseComparisonPolicyVersion?: string;
  sourceReferenceFixtureId?: string;
  sourceReferenceMode?: string;
  trustSummary?: TrustSummary | null;
  generatedArtifactRef: OutputRef | null;
  sourceHash: string | null;
  actualOutput: string | null;
  actualOutputRef: OutputRef | null;
  comparisonDiffRef: OutputRef | null;
  evidenceStatus: string | null;
  manualEditsCarriedOver: boolean;
  manualDriftRegionCount: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function artifactAt(value: unknown): OutputRef | null {
  const record = asRecord(value);
  if (!record) return null;
  const sha256 = asString(record.sha256);
  if (sha256.length === 0) return null;
  return {
    sha256,
    byteSize:
      typeof record.byteSize === "number" && Number.isFinite(record.byteSize)
        ? record.byteSize
        : undefined,
    kind: asString(record.kind) || undefined,
    path: asString(record.path) || undefined,
    name: asString(record.name) || undefined,
    mimeType: asString(record.mimeType) || undefined,
    createdBy: asString(record.createdBy) || undefined,
    createdAt: asString(record.createdAt) || undefined,
  };
}

function textOrNull(value: string | null | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function trustCaseId(summary: TrustSummary | null | undefined): string | null {
  const trustCase = asRecord(summary?.trustCase);
  return textOrNull(asString(trustCase?.trustCaseId));
}

function normalizedRef(
  summary: TrustSummary | null | undefined,
  key: "cobolResult" | "javaResult",
): OutputRef | null {
  const section = asRecord(summary?.[key]);
  return artifactAt(section?.normalizedOutputRef);
}

function comparisonDiffRef(
  summary: TrustSummary | null | undefined,
): OutputRef | null {
  const comparison = asRecord(summary?.comparisonResult);
  return artifactAt(comparison?.diffRef);
}

function repairDecisionRef(
  summary: TrustSummary | null | undefined,
): OutputRef | null {
  const repair = asRecord(summary?.repair);
  return artifactAt(repair?.repairDecisionRef);
}

function comparisonPolicyRef(
  summary: TrustSummary | null | undefined,
): OutputRef | null {
  const comparison = asRecord(summary?.comparisonResult);
  return artifactAt(comparison?.comparisonPolicyRef);
}

function sourceLines(value: string | null): string[] {
  if (!value) return [];
  return value.replace(/\r\n/g, "\n").split("\n");
}

function buildExcerpt(
  previousValue: string | null,
  currentValue: string | null,
): OutputDeltaLine[] {
  const previousLines = sourceLines(previousValue);
  const currentLines = sourceLines(currentValue);
  const prefix: OutputDeltaLine[] = [];
  const suffix: OutputDeltaLine[] = [];
  let start = 0;
  while (
    start < previousLines.length &&
    start < currentLines.length &&
    previousLines[start] === currentLines[start]
  ) {
    start += 1;
  }
  let endPrevious = previousLines.length - 1;
  let endCurrent = currentLines.length - 1;
  while (
    endPrevious >= start &&
    endCurrent >= start &&
    previousLines[endPrevious] === currentLines[endCurrent]
  ) {
    endPrevious -= 1;
    endCurrent -= 1;
  }
  if (start > 0) {
    prefix.push({
      kind: "context",
      content: previousLines[Math.max(0, start - 1)] ?? "",
    });
  }
  const removed = previousLines
    .slice(start, endPrevious + 1)
    .slice(0, 4)
    .map((content) => ({ kind: "removed" as const, content }));
  const added = currentLines
    .slice(start, endCurrent + 1)
    .slice(0, 4)
    .map((content) => ({ kind: "added" as const, content }));
  if (endPrevious + 1 < previousLines.length) {
    suffix.push({
      kind: "context",
      content: previousLines[endPrevious + 1] ?? "",
    });
  }
  return [...prefix, ...removed, ...added, ...suffix];
}

function buildOutputDelta(
  currentRun: OutputChangeRunArtifacts,
  previousRun: OutputChangeRunArtifacts,
): OutputChangeDeltaSummary {
  const previousLines = sourceLines(previousRun.actualOutput);
  const currentLines = sourceLines(currentRun.actualOutput);
  let addedLineCount = 0;
  let removedLineCount = 0;
  const max = Math.max(previousLines.length, currentLines.length);
  for (let index = 0; index < max; index += 1) {
    const previousValue = previousLines[index];
    const currentValue = currentLines[index];
    if (previousValue === currentValue) continue;
    if (previousValue !== undefined) removedLineCount += 1;
    if (currentValue !== undefined) addedLineCount += 1;
  }
  return {
    changed:
      (currentRun.actualOutput ?? "") !== (previousRun.actualOutput ?? ""),
    addedLineCount,
    removedLineCount,
    excerpt: buildExcerpt(previousRun.actualOutput, currentRun.actualOutput),
    currentNormalizedOutputRef: normalizedRef(
      currentRun.trustSummary,
      "javaResult",
    ),
    previousNormalizedOutputRef: normalizedRef(
      previousRun.trustSummary,
      "javaResult",
    ),
    currentComparisonDiffRef:
      currentRun.comparisonDiffRef ??
      comparisonDiffRef(currentRun.trustSummary),
    previousComparisonDiffRef:
      previousRun.comparisonDiffRef ??
      comparisonDiffRef(previousRun.trustSummary),
  };
}

function categoryEntry(
  category: OutputChangeCategory,
  changed: boolean,
  title: string,
  detail: string,
  evidenceLinks: OutputChangeEvidenceLink[],
): OutputChangeCategoryEntry {
  return {
    category,
    changed,
    title,
    detail,
    evidenceLinks,
  };
}

export function buildUnavailableOutputChangeExplanation(
  currentRun: Pick<OutputChangeRunArtifacts, "runId" | "programId">,
  previousRunId: string,
  reason: OutputChangeUnavailableReason,
  currentTrustCaseId: string | null = null,
  previousTrustCaseId: string | null = null,
): OutputChangeExplanationResult {
  return {
    schemaVersion: "v0",
    status: "unavailable",
    unavailableReason: reason,
    currentRunId: currentRun.runId,
    previousRunId,
    programId: currentRun.programId,
    currentTrustCaseId,
    previousTrustCaseId,
    determination: "not_determinable",
    primaryCategory: null,
    summary:
      reason === "previous_run_missing"
        ? "A previous parity run is required before output changes can be explained."
        : reason === "same_run_not_allowed"
          ? "Select a different baseline run before requesting an explanation."
          : reason === "run_not_completed"
            ? "Both runs must be completed before output changes can be explained."
            : reason === "non_parity_run"
              ? "Only completed parity runs can be compared for output-change analysis."
              : reason === "missing_trust_summary"
                ? "Deterministic trust evidence is incomplete for one of the selected runs."
                : reason === "missing_normalized_output"
                  ? "Normalized output evidence is missing for one of the selected runs."
                  : reason === "missing_observed_output"
                    ? "Observed output is unavailable for one of the selected runs."
                    : "Evidence is incomplete for one of the selected runs.",
    categories: [],
    outputDelta: null,
    evidenceLinks: [],
    aiSummary: {
      status: "unavailable",
      label: "AI-assisted explanation",
      groundingLabel: "Grounded in deterministic evidence",
      unavailableReason: "insufficient_evidence",
    },
  };
}

export function buildOutputChangeExplanation(
  currentRun: OutputChangeRunArtifacts,
  previousRun: OutputChangeRunArtifacts,
): OutputChangeExplanationResult {
  if (!previousRun.runId) {
    return buildUnavailableOutputChangeExplanation(
      currentRun,
      "",
      "previous_run_missing",
      trustCaseId(currentRun.trustSummary),
      null,
    );
  }
  if (currentRun.runId === previousRun.runId) {
    return buildUnavailableOutputChangeExplanation(
      currentRun,
      previousRun.runId,
      "same_run_not_allowed",
      trustCaseId(currentRun.trustSummary),
      trustCaseId(previousRun.trustSummary),
    );
  }
  if (currentRun.status !== "completed" || previousRun.status !== "completed") {
    return buildUnavailableOutputChangeExplanation(
      currentRun,
      previousRun.runId,
      "run_not_completed",
      trustCaseId(currentRun.trustSummary),
      trustCaseId(previousRun.trustSummary),
    );
  }
  if (
    currentRun.executionMode !== "parity" ||
    previousRun.executionMode !== "parity"
  ) {
    return buildUnavailableOutputChangeExplanation(
      currentRun,
      previousRun.runId,
      "non_parity_run",
      trustCaseId(currentRun.trustSummary),
      trustCaseId(previousRun.trustSummary),
    );
  }
  if (!currentRun.trustSummary || !previousRun.trustSummary) {
    return buildUnavailableOutputChangeExplanation(
      currentRun,
      previousRun.runId,
      "missing_trust_summary",
      trustCaseId(currentRun.trustSummary),
      trustCaseId(previousRun.trustSummary),
    );
  }
  if (currentRun.actualOutput === null || previousRun.actualOutput === null) {
    return buildUnavailableOutputChangeExplanation(
      currentRun,
      previousRun.runId,
      "missing_observed_output",
      trustCaseId(currentRun.trustSummary),
      trustCaseId(previousRun.trustSummary),
    );
  }
  const currentNormalized = normalizedRef(
    currentRun.trustSummary,
    "javaResult",
  );
  const previousNormalized = normalizedRef(
    previousRun.trustSummary,
    "javaResult",
  );
  if (!currentNormalized || !previousNormalized) {
    return buildUnavailableOutputChangeExplanation(
      currentRun,
      previousRun.runId,
      "missing_normalized_output",
      trustCaseId(currentRun.trustSummary),
      trustCaseId(previousRun.trustSummary),
    );
  }
  if (
    currentRun.evidenceStatus === "incomplete" ||
    previousRun.evidenceStatus === "incomplete"
  ) {
    return buildUnavailableOutputChangeExplanation(
      currentRun,
      previousRun.runId,
      "evidence_incomplete",
      trustCaseId(currentRun.trustSummary),
      trustCaseId(previousRun.trustSummary),
    );
  }

  const outputDelta = buildOutputDelta(currentRun, previousRun);
  const categories: OutputChangeCategoryEntry[] = [];
  const changedCategories: OutputChangeCategory[] = [];

  const cobolChanged =
    textOrNull(currentRun.sourceHash) !== textOrNull(previousRun.sourceHash);
  categories.push(
    categoryEntry(
      "cobol_edit",
      cobolChanged,
      "COBOL source changed",
      cobolChanged
        ? "The generated-run source hash differs between the selected runs."
        : "The generated-run source hash is unchanged across the selected runs.",
      [
        {
          label: "Current normalized COBOL output",
          currentRef: normalizedRef(currentRun.trustSummary, "cobolResult"),
        },
        {
          label: "Previous normalized COBOL output",
          previousRef: normalizedRef(previousRun.trustSummary, "cobolResult"),
        },
      ],
    ),
  );
  if (cobolChanged) changedCategories.push("cobol_edit");

  const trustCaseChanged =
    textOrNull(currentRun.trustCaseId) !==
      textOrNull(previousRun.trustCaseId) ||
    textOrNull(currentRun.trustCaseConfigurationDigest) !==
      textOrNull(previousRun.trustCaseConfigurationDigest);
  categories.push(
    categoryEntry(
      "trust_case_change",
      trustCaseChanged,
      "Trust case changed",
      trustCaseChanged
        ? "The trust-case identity or configuration digest differs between the selected runs."
        : "The same trust-case identity and configuration digest were used in both runs.",
      [
        {
          label: "Comparison policy reference",
          currentRef: comparisonPolicyRef(currentRun.trustSummary),
          previousRef: comparisonPolicyRef(previousRun.trustSummary),
        },
      ],
    ),
  );
  if (trustCaseChanged) changedCategories.push("trust_case_change");

  const runtimeConfigChanged =
    !trustCaseChanged &&
    (textOrNull(currentRun.trustCaseEnvironmentProfileId) !==
      textOrNull(previousRun.trustCaseEnvironmentProfileId) ||
      textOrNull(currentRun.sourceReferenceFixtureId) !==
        textOrNull(previousRun.sourceReferenceFixtureId) ||
      textOrNull(currentRun.sourceReferenceMode) !==
        textOrNull(previousRun.sourceReferenceMode));
  categories.push(
    categoryEntry(
      "runtime_configuration_change",
      runtimeConfigChanged,
      "Runtime configuration changed",
      runtimeConfigChanged
        ? "A controlled runtime or source-reference setting changed between the selected runs."
        : "The controlled runtime and source-reference settings are unchanged.",
      [],
    ),
  );
  if (runtimeConfigChanged)
    changedCategories.push("runtime_configuration_change");

  const normalizationChanged =
    textOrNull(currentRun.trustCaseComparisonPolicyVersion) !==
    textOrNull(previousRun.trustCaseComparisonPolicyVersion);
  categories.push(
    categoryEntry(
      "normalization_rule_change",
      normalizationChanged,
      "Normalization rule changed",
      normalizationChanged
        ? "The comparison policy version differs between the selected runs."
        : "The comparison policy version is unchanged across the selected runs.",
      [
        {
          label: "Comparison policy reference",
          currentRef: comparisonPolicyRef(currentRun.trustSummary),
          previousRef: comparisonPolicyRef(previousRun.trustSummary),
        },
      ],
    ),
  );
  if (normalizationChanged) changedCategories.push("normalization_rule_change");

  const manualJavaChanged =
    currentRun.manualEditsCarriedOver !== previousRun.manualEditsCarriedOver ||
    currentRun.manualDriftRegionCount !== previousRun.manualDriftRegionCount;
  categories.push(
    categoryEntry(
      "manual_java_edit",
      manualJavaChanged,
      "Manual Java edit changed",
      manualJavaChanged
        ? "Manual-edit provenance changed between the selected runs."
        : "Manual-edit provenance is unchanged across the selected runs.",
      [],
    ),
  );
  if (manualJavaChanged) changedCategories.push("manual_java_edit");

  const currentRepairRef = repairDecisionRef(currentRun.trustSummary);
  const previousRepairRef = repairDecisionRef(previousRun.trustSummary);
  const repairChanged =
    (currentRepairRef?.sha256 ?? "") !== (previousRepairRef?.sha256 ?? "");
  categories.push(
    categoryEntry(
      "repair_patch",
      repairChanged,
      "Repair patch changed",
      repairChanged
        ? "Repair-decision lineage differs between the selected runs."
        : "Repair-decision lineage is unchanged across the selected runs.",
      [
        {
          label: "Repair decision reference",
          currentRef: currentRepairRef,
          previousRef: previousRepairRef,
        },
      ],
    ),
  );
  if (repairChanged) changedCategories.push("repair_patch");

  const generatedRefreshChanged =
    (currentRun.generatedArtifactRef?.sha256 ?? "") !==
      (previousRun.generatedArtifactRef?.sha256 ?? "") &&
    !cobolChanged &&
    !manualJavaChanged &&
    !repairChanged &&
    !trustCaseChanged &&
    !runtimeConfigChanged &&
    !normalizationChanged;
  categories.push(
    categoryEntry(
      "generated_java_refresh",
      generatedRefreshChanged,
      "Generated Java candidate changed",
      generatedRefreshChanged
        ? "The final generated Java artifact changed without a stronger evidence-backed cause."
        : "The final generated Java artifact did not change independently of stronger categories.",
      [
        {
          label: "Generated Java artifact",
          currentRef: currentRun.generatedArtifactRef,
          previousRef: previousRun.generatedArtifactRef,
        },
      ],
    ),
  );
  if (generatedRefreshChanged) changedCategories.push("generated_java_refresh");

  const determination =
    changedCategories.length === 1
      ? "single_change"
      : changedCategories.length > 1
        ? "multiple_changes"
        : "not_determinable";
  const primaryCategory: OutputChangeCategory | null =
    changedCategories.length === 1 ? (changedCategories[0] ?? null) : null;
  const summary =
    determination === "single_change"
      ? `The output change is most directly explained by ${changedCategories[0]?.replaceAll("_", " ")}.`
      : determination === "multiple_changes"
        ? "Multiple evidence-backed changes occurred between the selected runs, so the output change cannot be reduced to one deterministic cause."
        : outputDelta.changed
          ? "The selected runs show an output difference, but the available evidence does not support one deterministic cause."
          : "No output change was detected between the selected runs.";

  const evidenceLinks: OutputChangeEvidenceLink[] = [
    {
      label: "Normalized Java output",
      currentRef: currentNormalized,
      previousRef: previousNormalized,
    },
    {
      label: "Parity diff artifact",
      currentRef: outputDelta.currentComparisonDiffRef,
      previousRef: outputDelta.previousComparisonDiffRef,
    },
    {
      label: "Generated Java artifact",
      currentRef: currentRun.generatedArtifactRef,
      previousRef: previousRun.generatedArtifactRef,
    },
  ];

  if (determination === "not_determinable") {
    categories.push(
      categoryEntry(
        "cause_not_determinable",
        true,
        "Cause not determinable",
        "No single evidence-backed change category fully explains the output delta.",
        evidenceLinks,
      ),
    );
  }

  return {
    schemaVersion: "v0",
    status: "available",
    currentRunId: currentRun.runId,
    previousRunId: previousRun.runId,
    programId: currentRun.programId,
    currentTrustCaseId: trustCaseId(currentRun.trustSummary),
    previousTrustCaseId: trustCaseId(previousRun.trustSummary),
    determination,
    primaryCategory,
    summary,
    categories,
    outputDelta,
    evidenceLinks,
    aiSummary: {
      status: "unavailable",
      label: "AI-assisted explanation",
      groundingLabel: "Grounded in deterministic evidence",
      unavailableReason: "insufficient_evidence",
    },
  };
}

export function withAiSummary(
  result: OutputChangeExplanationResult,
  aiSummary: OutputChangeAiSummary,
): OutputChangeExplanationResult {
  return {
    ...result,
    aiSummary,
  };
}

export type RunStatus = "starting" | "updating" | "completed" | "failed";
export type GeneratedStatus =
  | "generated"
  | "unsupported"
  | "skipped"
  | "incomplete";
export type EvidenceStatus = "complete" | "incomplete" | "invalid";
export type ProductMode = "live" | "unavailable";
export type BuildTestStatus =
  | "ok"
  | "compile-failed"
  | "run-failed"
  | "skipped"
  | "missing-golden-master"
  | "output-divergence"
  | "golden-master-reproduction-failed"
  | "oracle-unavailable"
  | "oracle-compile-failed"
  | "oracle-run-failed"
  | "oracle-invalid";
export type BuildTestClassification =
  | "match"
  | "compile-error"
  | "run-error"
  | "skipped-no-execution"
  | "missing-golden-master"
  | "divergence-known-w0-coverage-gap"
  | "divergence-unknown"
  | "true-golden-master-reproduction-error"
  | "true-golden-master-mismatch"
  | "oracle-unavailable"
  | "oracle-cobol-compile-error"
  | "oracle-run-error"
  | "oracle-invalid-request";

export type StatusVariant =
  | "error"
  | "warning"
  | "blocked"
  | "pending"
  | "success"
  | "neutral"
  | "incomplete";

export const mapRunStatusToVariant = (status: RunStatus): StatusVariant => {
  switch (status) {
    case "starting":
    case "updating":
      return "pending";
    case "completed":
      return "success";
    case "failed":
      return "error";
    default:
      return "neutral";
  }
};

export const mapGeneratedStatusToVariant = (
  status: GeneratedStatus,
): StatusVariant => {
  switch (status) {
    case "generated":
      return "success";
    case "skipped":
      return "neutral";
    case "unsupported":
      return "warning";
    case "incomplete":
      return "incomplete";
    default:
      return "neutral";
  }
};

export const mapEvidenceStatusToVariant = (
  status: EvidenceStatus,
): StatusVariant => {
  switch (status) {
    case "complete":
      return "success";
    case "incomplete":
      return "incomplete";
    case "invalid":
      return "blocked";
    default:
      return "neutral";
  }
};

export const mapProductModeToVariant = (mode: ProductMode): StatusVariant => {
  switch (mode) {
    case "live":
      return "success";
    case "unavailable":
      return "blocked";
    default:
      return "neutral";
  }
};

export const mapBuildTestStatusToVariant = (
  status: BuildTestStatus,
): StatusVariant => {
  switch (status) {
    case "ok":
      return "success";
    case "skipped":
      return "neutral";
    case "output-divergence":
    case "golden-master-reproduction-failed":
      return "warning";
    case "missing-golden-master":
    case "oracle-unavailable":
      return "blocked";
    case "compile-failed":
    case "run-failed":
    case "oracle-compile-failed":
    case "oracle-run-failed":
    case "oracle-invalid":
      return "error";
    default:
      return "neutral";
  }
};

export const mapBuildTestClassificationToVariant = (
  classification: BuildTestClassification,
): StatusVariant => {
  switch (classification) {
    case "match":
      return "success";
    case "skipped-no-execution":
      return "neutral";
    case "divergence-known-w0-coverage-gap":
    case "true-golden-master-reproduction-error":
    case "true-golden-master-mismatch":
      return "warning";
    case "missing-golden-master":
    case "oracle-unavailable":
      return "blocked";
    case "compile-error":
    case "run-error":
    case "divergence-unknown":
    case "oracle-cobol-compile-error":
    case "oracle-run-error":
    case "oracle-invalid-request":
      return "error";
    default:
      return "neutral";
  }
};

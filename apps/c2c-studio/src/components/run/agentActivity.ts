import {
  AssistDecisionAgentRole,
  AssistDecisionOutcome,
  AssistDecisionReasonCode,
  W02ActiveAgent,
  W02RepairDecision,
  W02UiErrorCode,
} from "../../types/api";

// Issue #173: human-readable labels for the W0.2 workflow contract enums.
// Centralized here so all panels render consistent copy when the UI surfaces
// active agent, repair decision, or BFF failure code.

export const ACTIVE_AGENT_LABELS: Record<W02ActiveAgent, string> = {
  transformation_agent: "Transformation Agent",
  verification_repair_agent: "Verification & Repair Agent",
  cobol_parser: "COBOL Parser",
  semantic_ir: "Semantic IR",
  java_generator: "Java Generator",
  build_test_runner: "Build & Test Runner",
  evidence_service: "Evidence Service",
};

export const ACTIVE_AGENT_DESCRIPTIONS: Record<W02ActiveAgent, string> = {
  transformation_agent:
    "Producing the candidate Java translation from semantic IR.",
  verification_repair_agent:
    "Reviewing the latest build/test outcome and proposing a repair.",
  cobol_parser: "Parsing COBOL source into the W0 IR.",
  semantic_ir: "Resolving and normalizing the COBOL program semantics.",
  java_generator: "Materializing the Java project from semantic IR.",
  build_test_runner:
    "Compiling and executing the generated Java against the oracle.",
  evidence_service: "Assembling the run evidence pack.",
};

export const REPAIR_DECISION_LABELS: Record<W02RepairDecision, string> = {
  propose_candidate: "Proposed candidate",
  refuse: "Refused",
  escalate: "Escalated",
  no_change: "No change",
};

// Issue #173: every W0.2 failure code must have a UI-safe message that
// explains the situation in product terms (no upstream URLs, no stack
// fragments). Used by W02ErrorNotice and any state-derived banner.
export const W02_ERROR_LABELS: Record<W02UiErrorCode, string> = {
  unsupported_cobol: "Unsupported COBOL",
  parse_failed: "COBOL parsing failed",
  semantic_ir_failed: "Semantic IR could not be built",
  model_gateway_unavailable: "Model Gateway unavailable",
  model_policy_denied: "Model invocation denied by policy",
  agent_timeout: "Agent step timed out",
  agent_contract_invalid: "Agent returned an invalid contract",
  java_generation_failed: "Java generation failed",
  java_compile_failed: "Generated Java did not compile",
  java_runtime_failed: "Generated Java failed at runtime",
  oracle_mismatch: "Output differs from the COBOL oracle",
  evidence_incomplete: "Evidence pack incomplete",
  cancelled: "Run cancelled",
  // Studio-IDE-13 (#255): user-facing label for a generator-only run.
  // Phrased as a positive outcome — the user got the Java artifacts they
  // asked for; verification was deliberately not requested.
  generate_only_complete: "Generator-only run complete",
  service_unavailable: "Backend service unavailable",
  internal_error: "Internal error",
};

export const W02_ERROR_DESCRIPTIONS: Record<W02UiErrorCode, string> = {
  unsupported_cobol:
    "The submitted program uses COBOL constructs outside the W0 subset. Generation was not attempted.",
  parse_failed:
    "The COBOL parser could not produce a syntax tree from the supplied source. Fix the source text and retry.",
  semantic_ir_failed:
    "The parser produced a tree, but semantic resolution failed. The program may rely on unsupported features.",
  model_gateway_unavailable:
    "The Model Gateway is not reachable. The transformation cannot proceed until it is restored.",
  model_policy_denied:
    "A model invocation was blocked by policy. The run is blocked until the policy is updated or another model is selected.",
  agent_timeout:
    "An agent step did not complete within its time budget. The run was aborted.",
  agent_contract_invalid:
    "An agent returned a response that violates the W0.2 contract. The run was aborted to avoid acting on unsafe output.",
  java_generation_failed:
    "The Java generator could not produce a project from the semantic IR. Inspect missing artifacts for context.",
  java_compile_failed:
    "The generated Java project did not compile. See the Build & Test panel for the compiler output.",
  java_runtime_failed:
    "The generated Java compiled but threw or exited non-zero at runtime. See the Build & Test panel.",
  oracle_mismatch:
    "The generated Java ran, but its output diverges from the COBOL oracle for at least one fixture.",
  evidence_incomplete:
    "The evidence pack is missing artifacts required to vouch for the run. Success cannot be claimed.",
  cancelled: "The run was cancelled before completion.",
  // Studio-IDE-13 (#255): description for the generator-only outcome.
  // Note this is *not* a failure — it signals "Java artifacts are ready;
  // verification was not requested." Invoke Verify from the toolbar to
  // run the full build/test/oracle pipeline on the current Java buffer.
  generate_only_complete:
    "Java artifacts are ready. Verification was not requested for this generator-only run — use the Verify toolbar action to certify the current Java buffer.",
  service_unavailable:
    "A backend service is unavailable. Retry once the platform health indicators return to OK.",
  internal_error:
    "The backend reported an internal error. No user-actionable details are available.",
};

export function repairBudgetText(used: number, limit: number): string {
  return `${used} / ${limit} attempts used`;
}

// Issue #218 (W0.3-7): UI-safe labels for the closed-set assist-decision
// gate result. Used by the AgentActivityPanel to render "Deterministic-only"
// vs "AI-assisted" causally — never decoratively. The reason descriptions
// stay in product language; they do not leak internal service identifiers.

export const ASSIST_DECISION_OUTCOME_LABELS: Record<
  AssistDecisionOutcome,
  string
> = {
  assist_required: "AI-assisted run",
  assist_not_required: "Deterministic-only run",
};

export const ASSIST_DECISION_OUTCOME_DESCRIPTIONS: Record<
  AssistDecisionOutcome,
  string
> = {
  assist_required:
    "The orchestrator activated a productive AI assist step for this run. Deterministic verification gates still decide the final classification.",
  assist_not_required:
    "The orchestrator completed this run without activating any productive AI assist step. The deterministic baseline was sufficient.",
};

export const ASSIST_DECISION_REASON_LABELS: Record<
  AssistDecisionReasonCode,
  string
> = {
  semantic_ir_bounded_ambiguity: "Semantic IR bounded ambiguity",
  translation_unsupported_repairable: "Translation unsupported but repairable",
  baseline_open_assumptions: "Baseline left open assumptions",
  deterministic_candidate_low_confidence:
    "Deterministic candidate low confidence",
  caller_explicit_opt_in: "AI assist enabled",
  caller_did_not_opt_in: "AI assist disabled",
  assist_budget_exhausted: "Assist budget exhausted",
};

export const ASSIST_DECISION_REASON_DESCRIPTIONS: Record<
  AssistDecisionReasonCode,
  string
> = {
  semantic_ir_bounded_ambiguity:
    "The deterministic semantic IR step finished but flagged bounded ambiguity that warrants a productive assist attempt.",
  translation_unsupported_repairable:
    "The deterministic translator could not complete on its own, but the gap is repairable by a productive assist step.",
  baseline_open_assumptions:
    "The deterministic baseline produced open assumptions that the assist step is expected to resolve.",
  deterministic_candidate_low_confidence:
    "A deterministic candidate exists, but uncertainty markers were strong enough to justify an assist attempt.",
  caller_explicit_opt_in: "Productive AI assist was enabled for this run.",
  caller_did_not_opt_in:
    "The caller explicitly disabled productive AI assist, so the run remained on the deterministic baseline.",
  assist_budget_exhausted:
    "The caller opted in but the per-run assist budget had no units left, so the deterministic baseline is the final candidate.",
};

export const ASSIST_DECISION_AGENT_ROLE_LABELS: Record<
  AssistDecisionAgentRole,
  string
> = {
  transformation_agent: "Transformation Agent",
};

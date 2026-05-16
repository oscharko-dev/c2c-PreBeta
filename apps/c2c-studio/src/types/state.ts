import { TransformationRunState } from './run';
import { W02UiErrorCode } from './api';

// Issue #173: W0.2 Studio state machine. Lifecycle states (submitting,
// awaiting-agent, repairing, verifying, cancelled) drive in-progress UI;
// terminal states (success, blocked, failed, ...) drive verdict UI.
// Artifact-level states (generated-*, build-failed, ...) remain so the
// existing artifact-driven panels keep their semantics for runs that
// predate the W0.2 workflow contract.
export type ProductState =
  | 'empty'
  | 'submitting'
  | 'running'
  | 'awaiting-agent'
  | 'repairing'
  | 'verifying'
  | 'success'
  | 'blocked'
  | 'cancelled'
  | 'backend-unavailable'
  | 'upstream-unavailable'
  | 'unsupported'
  | 'validation-error'
  | 'failed'
  | 'generated-pending'
  | 'generated-incomplete'
  | 'build-failed'
  | 'equivalence-mismatch'
  | 'evidence-incomplete'
  | 'hash-mismatch'
  | 'stale-ignored';

export interface StateContext {
  state: ProductState;
  message?: string;
  missingArtifacts?: string[];
  unsupportedFeatures?: string[];
  mismatchedHashes?: { expected: string; actual: string; context: string }[];
  // Issue #173: W0.2 failure code surfaced to the UI when the BFF/orchestrator
  // classifies the run failure. Present on blocked/failed verdict states only.
  failureCode?: W02UiErrorCode;
}

function hasUnavailableProductMode(runState: TransformationRunState): boolean {
  return [
    runState.summary?.productMode,
    runState.generated?.productMode,
    runState.generatedFiles?.productMode,
    runState.buildTest?.productMode,
    runState.evidence?.productMode,
  ].includes('unavailable');
}

function collectHashMismatches(
  runState: TransformationRunState
): NonNullable<StateContext['mismatchedHashes']> {
  const mismatches: NonNullable<StateContext['mismatchedHashes']> = [];
  const generatedHash = runState.generated?.artifactRef?.sha256;

  if (generatedHash && runState.buildTest?.generatedArtifactRef?.sha256 && generatedHash !== runState.buildTest.generatedArtifactRef.sha256) {
    mismatches.push({
      expected: generatedHash,
      actual: runState.buildTest.generatedArtifactRef.sha256,
      context: 'Generated vs Build/Test',
    });
  }

  if (generatedHash && runState.evidence?.generatedArtifactRef?.sha256 && generatedHash !== runState.evidence.generatedArtifactRef.sha256) {
    mismatches.push({
      expected: generatedHash,
      actual: runState.evidence.generatedArtifactRef.sha256,
      context: 'Generated vs Evidence',
    });
  }

  return mismatches;
}

function failureCodeToState(code: W02UiErrorCode): ProductState {
  switch (code) {
    case 'unsupported_cobol':
      return 'unsupported';
    case 'parse_failed':
    case 'semantic_ir_failed':
    case 'agent_timeout':
    case 'agent_contract_invalid':
    case 'java_generation_failed':
    case 'internal_error':
      return 'failed';
    case 'model_gateway_unavailable':
    case 'model_policy_denied':
      return 'blocked';
    case 'java_compile_failed':
    case 'java_runtime_failed':
      return 'build-failed';
    case 'oracle_mismatch':
      return 'equivalence-mismatch';
    case 'evidence_incomplete':
      return 'evidence-incomplete';
    case 'cancelled':
      return 'cancelled';
    case 'service_unavailable':
      return 'backend-unavailable';
  }
}

// Issue #173: map BFF active agent identifier to the in-progress product
// state the UI shows during that step.
function activeAgentToState(activeAgent: string | null | undefined): ProductState | null {
  switch (activeAgent) {
    case 'transformation_agent':
      return 'awaiting-agent';
    case 'verification_repair_agent':
      return 'repairing';
    case 'build_test_runner':
    case 'evidence_service':
      return 'verifying';
    default:
      return null;
  }
}

export function deriveProductState(runState: TransformationRunState): StateContext {
  if (runState.error === 'Backend unavailable. Try again shortly.' || runState.error?.includes('503')) {
    return { state: 'backend-unavailable', message: runState.error };
  }
  if (runState.error?.includes('400') || runState.error?.includes('Validation')) {
    return { state: 'validation-error', message: runState.error };
  }
  if (runState.phase === 'idle') {
    return { state: 'empty' };
  }
  if (runState.phase === 'unavailable') {
    return { state: 'backend-unavailable', message: runState.error ?? 'Backend unavailable. Try again shortly.' };
  }
  if (hasUnavailableProductMode(runState)) {
    return {
      state: 'upstream-unavailable',
      message: runState.summary?.message ?? runState.generated?.note ?? runState.evidence?.note,
    };
  }

  // Issue #173: terminal verdicts driven by the W0.2 finalClassification.
  // The orchestrator-side classification is authoritative — if BFF says
  // "blocked" / "cancelled" we render that verdict even when artifact
  // views look complete.
  const workflow = runState.workflow;
  const finalClassification =
    workflow?.finalClassification ?? runState.summary?.finalClassification ?? null;
  const failureCode = workflow?.failureCode ?? runState.summary?.failureCode ?? null;
  const failureMessage =
    workflow?.failureMessage ?? runState.summary?.failureMessage ?? null;

  if (finalClassification === 'cancelled' || failureCode === 'cancelled') {
    return { state: 'cancelled', message: failureMessage ?? 'Run was cancelled.' };
  }

  // Issue #173: BFF-classified blocked verdict (e.g. model_policy_denied,
  // model_gateway_unavailable) is authoritative even when generated/
  // build-test/evidence views look incomplete — they are downstream of
  // the block, not the cause. We surface the closed-set failure code so
  // the StatusBar chip and ErrorNotice can render the actionable label.
  if (finalClassification === 'blocked' && failureCode) {
    return {
      state: failureCodeToState(failureCode),
      message: failureMessage ?? runState.summary?.message ?? undefined,
      failureCode,
    };
  }

  if (runState.phase === 'starting' || runState.phase === 'running') {
    // Issue #173: when workflow contract is available, refine the running
    // phase into awaiting-agent / repairing / verifying based on the active
    // agent. Otherwise: 'starting' phase = submitting (request acknowledged,
    // no orchestrator state yet); 'running' phase = generic running.
    const fromAgent = activeAgentToState(workflow?.activeAgent);
    if (fromAgent) {
      return { state: fromAgent };
    }
    return { state: runState.phase === 'starting' ? 'submitting' : 'running' };
  }

  const generated = runState.generated;
  if (generated) {
    if (generated.status === 'unsupported') {
      return {
        state: 'unsupported',
        unsupportedFeatures: generated.unsupportedFeatures || [],
        message: generated.note,
      };
    }
    const generatedMissingArtifacts = [
      ...(generated.missingArtifacts || []),
      ...(runState.generatedFiles?.missingArtifacts || []),
    ];
    if (
      generated.status === 'incomplete' ||
      runState.generatedFiles?.status === 'incomplete' ||
      generatedMissingArtifacts.length > 0
    ) {
      return {
        state: 'generated-incomplete',
        missingArtifacts: generatedMissingArtifacts,
        message: generated.note ?? runState.generatedFiles?.note,
      };
    }
  } else if (runState.phase === 'completed') {
    return { state: 'generated-pending' };
  }

  if (runState.phase === 'incomplete') {
    return {
      state: 'generated-incomplete',
      missingArtifacts: runState.generatedFiles?.missingArtifacts || generated?.missingArtifacts || [],
      message:
        runState.generatedFiles?.note ||
        generated?.note ||
        'Required generated artifacts are unavailable for this run.',
    };
  }

  const buildTest = runState.buildTest;
  if (buildTest) {
    if (buildTest.status === 'compile-failed' || buildTest.status === 'run-failed' || buildTest.classification === 'compile-error' || buildTest.classification === 'run-error') {
      return { state: 'build-failed', message: buildTest.note };
    }
    if (buildTest.classification?.startsWith('divergence')) {
      return { state: 'equivalence-mismatch', message: buildTest.note };
    }
    if (buildTest.status === 'incomplete') {
      return { state: 'build-failed', message: buildTest.note ?? 'Build/test results are incomplete.' };
    }
  }

  const evidence = runState.evidence;
  if (evidence) {
    if (evidence.status === 'incomplete' || (evidence.missingArtifacts && evidence.missingArtifacts.length > 0)) {
      return {
        state: 'evidence-incomplete',
        missingArtifacts: evidence.missingArtifacts || [],
        message: evidence.note,
      };
    }
  }

  const mismatches = collectHashMismatches(runState);
  if (mismatches.length > 0) {
    return { state: 'hash-mismatch', mismatchedHashes: mismatches };
  }

  // Issue #173: BFF-classified failures take precedence over the generic
  // "failed" phase, and the code becomes the user-facing failure code.
  if (finalClassification === 'failed' || finalClassification === 'blocked') {
    const code = failureCode ?? undefined;
    const derived = code ? failureCodeToState(code) : finalClassification === 'blocked' ? 'blocked' : 'failed';
    return {
      state: derived,
      message: failureMessage ?? runState.error ?? runState.summary?.message ?? undefined,
      failureCode: code,
    };
  }

  if (runState.phase === 'failed' || runState.summary?.status === 'failed') {
    const code = failureCode ?? undefined;
    return {
      state: code ? failureCodeToState(code) : 'failed',
      message: failureMessage ?? runState.error ?? runState.summary?.message ?? undefined,
      failureCode: code,
    };
  }

  if (runState.phase === 'completed') {
    // Issue #173: the Studio claims "success" only when the BFF classifies
    // the run as success AND build/test and evidence agree. For runs that
    // predate the workflow contract (e.g. diagnostic-fixture runs without
    // finalClassification) we accept the artifact-level agreement as the
    // same gate — both routes converge on the same verdict so we do not
    // need a separate legacy state.
    const buildTestOk = buildTest?.status === 'ok';
    const evidenceOk = evidence?.status === 'complete';
    const bffConfirmedSuccess = finalClassification === 'success';
    const artifactConfirmedSuccess = finalClassification === null && buildTestOk && evidenceOk;
    if ((bffConfirmedSuccess && buildTestOk && evidenceOk) || artifactConfirmedSuccess) {
      return { state: 'success' };
    }
    // Completed without success agreement: surface the most specific
    // artifact-level reason if any, else fall back to a generic failed
    // verdict. The earlier artifact-level branches (build-failed,
    // equivalence-mismatch, evidence-incomplete, hash-mismatch) take
    // precedence over this fallback.
    return { state: 'failed', message: failureMessage ?? runState.summary?.message ?? undefined };
  }

  return { state: 'empty' };
}

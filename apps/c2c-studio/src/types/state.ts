import { TransformationRunState } from './run';

export type ProductState =
  | 'empty'
  | 'ready'
  | 'backend-unavailable'
  | 'upstream-unavailable'
  | 'unsupported'
  | 'validation-error'
  | 'running'
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
  if (runState.phase === 'starting' || runState.phase === 'running') {
    return { state: 'running' };
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
  } else if (
    runState.phase === 'completed' ||
    runState.phase === 'verification-blocked'
  ) {
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

  if (runState.phase === 'failed' || runState.summary?.status === 'failed') {
    return { state: 'failed', message: runState.error || runState.summary?.message };
  }

  if (runState.phase === 'completed') {
    return { state: 'ready' };
  }

  return { state: 'empty' };
}

import { describe, expect, it } from 'vitest';
import { deriveProductState } from '../src/types/state';
import { TransformationRunState } from '../src/types/run';

describe('Product State Derivation', () => {
  function makeState(overrides: Partial<TransformationRunState> = {}): TransformationRunState {
    return {
      phase: 'idle',
      runId: null,
      orchestratorRunId: null,
      programId: null,
      error: null,
      artifactsError: null,
      summary: null,
      generated: null,
      generatedFiles: null,
      buildTest: null,
      evidence: null,
      events: null,
      artifacts: null,
      experience: null,
      modelGatewayHealth: null,
      harnessReady: null,
      ...overrides
    };
  }

  it('BFF unavailable disables start (backend-unavailable)', () => {
    const state = makeState({ error: 'Backend unavailable. Try again shortly.' });
    expect(deriveProductState(state).state).toBe('backend-unavailable');
  });

  it('Transform returns 400 (validation-error)', () => {
    const state = makeState({ error: 'HTTP 400 Bad Request' });
    expect(deriveProductState(state).state).toBe('validation-error');
  });

  it('Transform returns 503 and product readiness is blocked (backend-unavailable)', () => {
    const state = makeState({ error: 'HTTP 503 Service Unavailable' });
    expect(deriveProductState(state).state).toBe('backend-unavailable');
  });

  it('surfaces upstream-unavailable from product mode metadata', () => {
    const state = makeState({
      phase: 'running',
      summary: {
        runId: '123',
        programId: 'ABC',
        status: 'updating',
        mode: 'live',
        productMode: 'unavailable',
        createdAt: '2026-05-15T10:00:00Z',
        updatedAt: '2026-05-15T10:00:01Z',
        message: 'Evidence service unavailable',
      },
    } as any);

    expect(deriveProductState(state).state).toBe('upstream-unavailable');
  });

  it('exposes the running state while transformation is active', () => {
    expect(deriveProductState(makeState({ phase: 'running' })).state).toBe('running');
  });

  it('Generated endpoint returns incomplete with missing artifacts', () => {
    const state = makeState({
      phase: 'completed',
      generated: {
        runId: '123',
        programId: 'ABC',
        mode: 'live',
        productMode: 'live',
        status: 'incomplete',
        missingArtifacts: ['Foo.java'],
        artifactRef: null
      }
    });
    const result = deriveProductState(state);
    expect(result.state).toBe('generated-incomplete');
    expect(result.missingArtifacts).toEqual(['Foo.java']);
  });

  it('Generated files incomplete keeps Java in an incomplete state', () => {
    const state = makeState({
      phase: 'incomplete',
      generated: {
        runId: '123',
        programId: 'ABC',
        mode: 'live',
        productMode: 'live',
        status: 'generated',
        artifactRef: { uri: 'file:///runs/123/generated.json', sha256: 'a' },
      },
      generatedFiles: {
        runId: '123',
        programId: 'ABC',
        mode: 'live',
        productMode: 'live',
        status: 'incomplete',
        files: [],
        fileCount: 0,
        artifactRef: null,
        missingArtifacts: ['src/Main.java'],
      },
    });
    const result = deriveProductState(state);
    expect(result.state).toBe('generated-incomplete');
    expect(result.missingArtifacts).toEqual(['src/Main.java']);
  });

  it('Terminal incomplete runs without a generated files index stay incomplete', () => {
    const state = makeState({
      phase: 'incomplete',
      generated: {
        runId: '123',
        programId: 'ABC',
        mode: 'live',
        productMode: 'live',
        status: 'generated',
        artifactRef: { uri: 'file:///runs/123/generated.json', sha256: 'a' },
      },
    });

    const result = deriveProductState(state);
    expect(result.state).toBe('generated-incomplete');
    expect(result.message).toContain('Required generated artifacts are unavailable');
  });

  it('Build/test classification is divergence-known W0 coverage gap', () => {
    const state = makeState({
      phase: 'completed',
      generated: { status: 'generated', artifactRef: { uri: '', sha256: 'a' } } as any,
      buildTest: {
        runId: '123',
        programId: 'ABC',
        mode: 'live',
        productMode: 'live',
        status: 'output-divergence',
        classification: 'divergence-known-w0-coverage-gap',
        generatedArtifactRef: { uri: '', sha256: 'a' }
      }
    });
    const result = deriveProductState(state);
    expect(result.state).toBe('equivalence-mismatch');
  });

  it('Build/test classification is divergence-unknown', () => {
    const state = makeState({
      phase: 'completed',
      generated: { status: 'generated', artifactRef: { uri: '', sha256: 'a' } } as any,
      buildTest: {
        runId: '123',
        programId: 'ABC',
        mode: 'live',
        productMode: 'live',
        status: 'output-divergence',
        classification: 'divergence-unknown',
        generatedArtifactRef: { uri: '', sha256: 'a' }
      }
    });
    const result = deriveProductState(state);
    expect(result.state).toBe('equivalence-mismatch');
  });

  it('Evidence incomplete with missing artifacts', () => {
    const state = makeState({
      phase: 'completed',
      generated: { status: 'generated', artifactRef: { uri: '', sha256: 'a' } } as any,
      buildTest: { status: 'ok', classification: 'match', generatedArtifactRef: { uri: '', sha256: 'a' } } as any,
      evidence: {
        runId: '123',
        programId: 'ABC',
        mode: 'live',
        productMode: 'live',
        status: 'incomplete',
        missingArtifacts: ['manifest.json'],
        generatedArtifactRef: { uri: '', sha256: 'a' }
      }
    });
    const result = deriveProductState(state);
    expect(result.state).toBe('evidence-incomplete');
    expect(result.missingArtifacts).toEqual(['manifest.json']);
  });

  it('Artifact hash mismatch blocks verified state', () => {
    const state = makeState({
      phase: 'completed',
      generated: {
        runId: '123',
        programId: 'ABC',
        mode: 'live',
        productMode: 'live',
        status: 'generated',
        artifactRef: { uri: 'abc', sha256: 'hash1' }
      },
      buildTest: {
        runId: '123',
        programId: 'ABC',
        mode: 'live',
        productMode: 'live',
        status: 'ok',
        classification: 'match',
        generatedArtifactRef: { uri: 'def', sha256: 'hash2' }
      }
    });
    const result = deriveProductState(state);
    expect(result.state).toBe('hash-mismatch');
    expect(result.mismatchedHashes).toBeDefined();
    expect(result.mismatchedHashes?.[0].expected).toBe('hash1');
    expect(result.mismatchedHashes?.[0].actual).toBe('hash2');
  });

  it('prefers artifact-backed verification failures over a generic failed phase', () => {
    const state = makeState({
      phase: 'failed',
      error: 'run failed',
      generated: {
        runId: '123',
        programId: 'ABC',
        mode: 'live',
        productMode: 'live',
        status: 'generated',
        artifactRef: { uri: 'abc', sha256: 'hash1' },
      },
      buildTest: {
        runId: '123',
        programId: 'ABC',
        mode: 'live',
        productMode: 'live',
        status: 'output-divergence',
        classification: 'divergence-unknown',
        generatedArtifactRef: { uri: 'abc', sha256: 'hash1' },
      },
    });

    expect(deriveProductState(state).state).toBe('equivalence-mismatch');
  });

  it('surfaces unsupported generated output explicitly', () => {
    const state = makeState({
      phase: 'completed',
      generated: {
        runId: '123',
        programId: 'ABC',
        mode: 'live',
        productMode: 'live',
        status: 'unsupported',
        unsupportedFeatures: ['COPY REPLACING'],
        artifactRef: null,
      },
    });

    expect(deriveProductState(state).state).toBe('unsupported');
  });

  it('treats missing generated artifacts after terminal completion as pending', () => {
    expect(deriveProductState(makeState({ phase: 'completed' })).state).toBe('generated-pending');
  });

  it('surfaces build failures before ready state', () => {
    const state = makeState({
      phase: 'completed',
      generated: { status: 'generated', artifactRef: { uri: '', sha256: 'a' } } as any,
      buildTest: {
        runId: '123',
        programId: 'ABC',
        mode: 'live',
        productMode: 'live',
        status: 'compile-failed',
        classification: 'compile-error',
        generatedArtifactRef: { uri: '', sha256: 'a' },
        note: 'javac failed',
      },
    });

    expect(deriveProductState(state).state).toBe('build-failed');
  });

  it('surfaces an otherwise generic failed run when no more specific artifact state exists', () => {
    expect(deriveProductState(makeState({ phase: 'failed', error: 'run failed' })).state).toBe('failed');
  });
});

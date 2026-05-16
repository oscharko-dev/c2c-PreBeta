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
      progress: null,
      artifacts: null,
      experience: null,
      modelGatewayHealth: null,
      harnessReady: null,
      workflow: null,
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

  // Issue #173: W0.2 lifecycle states derived from the workflow contract.
  describe('W0.2 workflow-driven states', () => {
    it('phase=starting without workflow maps to submitting', () => {
      expect(deriveProductState(makeState({ phase: 'starting' })).state).toBe('submitting');
    });

    it('phase=running with no workflow keeps generic running state', () => {
      expect(deriveProductState(makeState({ phase: 'running' })).state).toBe('running');
    });

    it('refines running to awaiting-agent when transformation_agent is active', () => {
      const state = makeState({
        phase: 'running',
        workflow: {
          runId: '1',
          programId: 'P',
          mode: 'live',
          productMode: 'live',
          source: 'live',
          state: 'agent_running',
          activeStep: 'generate-java',
          activeAgent: 'transformation_agent',
          agentAttemptCount: 1,
          repairBudget: { limit: 3, used: 0, remaining: 3 },
          repairAttempts: [],
          finalClassification: null,
          failureCode: null,
          failureMessage: null,
          generatedJavaRef: null,
          buildTestResultRef: null,
          evidencePackRef: null,
        },
      });
      expect(deriveProductState(state).state).toBe('awaiting-agent');
    });

    it('refines running to repairing when verification_repair_agent is active', () => {
      const state = makeState({
        phase: 'running',
        workflow: {
          runId: '1',
          programId: 'P',
          mode: 'live',
          productMode: 'live',
          source: 'live',
          state: 'repairing',
          activeStep: 'repair',
          activeAgent: 'verification_repair_agent',
          agentAttemptCount: 2,
          repairBudget: { limit: 3, used: 1, remaining: 2 },
          repairAttempts: [],
          finalClassification: null,
          failureCode: null,
          failureMessage: null,
          generatedJavaRef: null,
          buildTestResultRef: null,
          evidencePackRef: null,
        },
      });
      expect(deriveProductState(state).state).toBe('repairing');
    });

    it('refines running to verifying when build-test runner is active', () => {
      const state = makeState({
        phase: 'running',
        workflow: {
          runId: '1',
          programId: 'P',
          mode: 'live',
          productMode: 'live',
          source: 'live',
          state: 'verifying',
          activeStep: 'compile-test-java',
          activeAgent: 'build_test_runner',
          agentAttemptCount: 1,
          repairBudget: null,
          repairAttempts: [],
          finalClassification: null,
          failureCode: null,
          failureMessage: null,
          generatedJavaRef: null,
          buildTestResultRef: null,
          evidencePackRef: null,
        },
      });
      expect(deriveProductState(state).state).toBe('verifying');
    });

    it('returns success only when BFF classification + build/test + evidence agree', () => {
      const state = makeState({
        phase: 'completed',
        generated: { status: 'generated', artifactRef: { uri: '', sha256: 'a' } } as any,
        buildTest: { status: 'ok', classification: 'match', generatedArtifactRef: { uri: '', sha256: 'a' } } as any,
        evidence: { status: 'complete', generatedArtifactRef: { uri: '', sha256: 'a' } } as any,
        summary: {
          runId: '1',
          programId: 'P',
          status: 'completed',
          mode: 'live',
          productMode: 'live',
          createdAt: '2026-05-16T00:00:00Z',
          updatedAt: '2026-05-16T00:00:01Z',
          activeStep: null,
          agentAttemptCount: 1,
          repairBudget: null,
          finalClassification: 'success',
          failureCode: null,
          failureMessage: null,
        },
      });
      expect(deriveProductState(state).state).toBe('success');
    });

    it('falls back to legacy ready state when finalClassification missing', () => {
      const state = makeState({
        phase: 'completed',
        generated: { status: 'generated', artifactRef: { uri: '', sha256: 'a' } } as any,
        buildTest: { status: 'ok', classification: 'match', generatedArtifactRef: { uri: '', sha256: 'a' } } as any,
        evidence: { status: 'complete', generatedArtifactRef: { uri: '', sha256: 'a' } } as any,
      });
      expect(deriveProductState(state).state).toBe('ready');
    });

    it('maps model_gateway_unavailable failure code to blocked state', () => {
      const state = makeState({
        phase: 'failed',
        summary: {
          runId: '1',
          programId: 'P',
          status: 'failed',
          mode: 'live',
          productMode: 'live',
          createdAt: '2026-05-16T00:00:00Z',
          updatedAt: '2026-05-16T00:00:01Z',
          activeStep: null,
          agentAttemptCount: 0,
          repairBudget: null,
          finalClassification: 'blocked',
          failureCode: 'model_gateway_unavailable',
          failureMessage: 'gateway 502',
        },
      });
      const result = deriveProductState(state);
      expect(result.state).toBe('blocked');
      expect(result.failureCode).toBe('model_gateway_unavailable');
      expect(result.message).toBe('gateway 502');
    });

    it('maps agent_timeout failure code to failed state', () => {
      const state = makeState({
        phase: 'failed',
        summary: {
          runId: '1',
          programId: 'P',
          status: 'failed',
          mode: 'live',
          productMode: 'live',
          createdAt: '2026-05-16T00:00:00Z',
          updatedAt: '2026-05-16T00:00:01Z',
          activeStep: null,
          agentAttemptCount: 0,
          repairBudget: null,
          finalClassification: 'failed',
          failureCode: 'agent_timeout',
          failureMessage: null,
        },
      });
      const result = deriveProductState(state);
      expect(result.state).toBe('failed');
      expect(result.failureCode).toBe('agent_timeout');
    });

    it('maps cancelled classification to cancelled state', () => {
      const state = makeState({
        phase: 'failed',
        summary: {
          runId: '1',
          programId: 'P',
          status: 'failed',
          mode: 'live',
          productMode: 'live',
          createdAt: '2026-05-16T00:00:00Z',
          updatedAt: '2026-05-16T00:00:01Z',
          activeStep: null,
          agentAttemptCount: 0,
          repairBudget: null,
          finalClassification: 'cancelled',
          failureCode: 'cancelled',
          failureMessage: 'user cancelled',
        },
      });
      const result = deriveProductState(state);
      expect(result.state).toBe('cancelled');
    });
  });
});

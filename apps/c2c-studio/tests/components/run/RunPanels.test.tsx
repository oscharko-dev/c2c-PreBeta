import { fireEvent, render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BuildTestPanel } from '../../../src/components/run/BuildTestPanel';
import { EvidencePackPanel } from '../../../src/components/run/EvidencePackPanel';
import { ProblemsPanel } from '../../../src/components/run/ProblemsPanel';
import { EquivalencePanel } from '../../../src/components/run/EquivalencePanel';
import { RunArtifactsPanel } from '../../../src/components/run/RunArtifactsPanel';

const mockState = {
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
  previousRun: null,
};

const navigateToDiagnosticMock = vi.hoisted(() => vi.fn());

vi.mock('../../../src/stores/transformationRun', () => ({
  useTransformationRun: vi.fn(() => ({ state: mockState })),
}));

vi.mock('../../../src/stores/sourceWorkspace', () => ({
  useSourceWorkspace: vi.fn(() => ({
    statusFlags: {
      clean: true,
      pendingReRun: false,
    },
  })),
}));

vi.mock('@/lib/editor/markerNavigation', () => ({
  useMarkerNavigation: () => ({
    navigateToDiagnostic: navigateToDiagnosticMock,
  }),
}));

describe('Run Panels', () => {
  let useTransformationRunMock: any;
  let useSourceWorkspaceMock: any;
  
  beforeEach(async () => {
    vi.resetAllMocks();
    const mod = await import('../../../src/stores/transformationRun');
    useTransformationRunMock = mod.useTransformationRun;
    const sourceMod = await import('../../../src/stores/sourceWorkspace');
    useSourceWorkspaceMock = sourceMod.useSourceWorkspace;
    useSourceWorkspaceMock.mockReturnValue({
      statusFlags: {
        clean: true,
        pendingReRun: false,
      },
      selectedTrustCase: null,
    });
  });

  describe('BuildTestPanel', () => {
    it('renders build/test status and classification correctly', () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: 'completed',
          buildTest: {
            status: 'ok',
            classification: 'match',
            expectedOutput: 'FOO',
            actualOutput: 'FOO'
          }
        }
      });
      render(<BuildTestPanel emptyState={{ title: 'Empty', message: 'Message' }} />);
      expect(screen.getAllByText('COBOL Oracle').length).toBeGreaterThan(0);
      expect(screen.getByText('Java Compilation')).toBeDefined();
      expect(screen.getByText('Java Execution')).toBeDefined();
      expect(screen.getByText('Equivalence Check')).toBeDefined();
      expect(screen.getByText('Equivalent')).toBeDefined();
    });

    it('renders build/test missing golden master', () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: 'completed',
          buildTest: {
            status: 'missing-golden-master',
            classification: 'skipped-no-execution'
          }
        }
      });
      render(<BuildTestPanel emptyState={{ title: 'Empty', message: 'Message' }} />);
      expect(screen.getByText('COBOL Oracle')).toBeDefined();
      expect(screen.getByText('Golden master unavailable')).toBeDefined();
      expect(screen.getByText('Blocked before compilation started')).toBeDefined();
    });

    it('renders live orchestrator progress steps when available', () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: 'running',
          progress: {
            runId: 'run-progress',
            programId: 'BRNCH01',
            mode: 'live',
            productMode: 'live',
            status: 'complete',
            currentStep: 'compile-test-java',
            failedStep: null,
            completedSteps: ['accepted', 'parse-cobol', 'generate-ir', 'generate-java'],
            stepCount: 3,
            steps: [
              {
                stepId: 1,
                name: 'accepted',
                capabilityId: 'orchestrator-service',
                service: 'orchestrator-service',
                actor: 'orchestrator-service',
                status: 'ok'
              },
              {
                stepId: 2,
                name: 'generate-java',
                capabilityId: 'java-generator-service',
                service: 'orchestrator-service',
                actor: 'java-generator-service',
                status: 'ok',
                latencyMs: 31
              },
              {
                stepId: 3,
                name: 'compile-test-java',
                capabilityId: 'build-test-runner',
                service: 'orchestrator-service',
                actor: 'build-test-runner',
                status: 'running'
              }
            ]
          }
        }
      });

      render(<BuildTestPanel emptyState={{ title: 'Empty', message: 'Message' }} />);
      expect(screen.getByText('Accepted')).toBeDefined();
      expect(screen.getByText('Generate Java')).toBeDefined();
      expect(screen.getByText('Compile & Test Java')).toBeDefined();
      expect(screen.getByText('build-test-runner is running')).toBeDefined();
    });

    it('renders model policy skipped progress without raw diagnostic leakage', () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: 'running',
          progress: {
            runId: 'run-progress',
            programId: 'BRNCH01',
            mode: 'live',
            productMode: 'live',
            status: 'complete',
            currentStep: null,
            failedStep: null,
            completedSteps: ['accepted', 'model-policy-skipped'],
            stepCount: 2,
            steps: [
              {
                stepId: 1,
                name: 'accepted',
                capabilityId: 'orchestrator-service',
                service: 'orchestrator-service',
                actor: 'orchestrator-service',
                status: 'ok'
              },
              {
                stepId: 2,
                name: 'model-policy-skipped',
                capabilityId: 'orchestrator-service',
                service: 'orchestrator-service',
                actor: 'orchestrator-service',
                status: 'skipped',
                diagnostic: 'Step skipped by workflow policy.'
              }
            ]
          }
        }
      });

      render(<BuildTestPanel emptyState={{ title: 'Empty', message: 'Message' }} />);
      expect(screen.getByText('Model Policy Skipped')).toBeDefined();
      expect(screen.getByText('Skipped: Step skipped by workflow policy.')).toBeDefined();
    });

    it('marks parity results stale when the source workspace has pending re-run state', () => {
      useSourceWorkspaceMock.mockReturnValue({
        statusFlags: {
          clean: false,
          pendingReRun: true,
        },
        selectedTrustCase: null,
      });
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: 'completed',
          buildTest: {
            status: 'ok',
            classification: 'match',
            expectedOutput: 'OK',
            actualOutput: 'OK',
          },
        },
      });

      render(<BuildTestPanel emptyState={{ title: 'Empty', message: 'Message' }} />);
      expect(
        screen.getByText(
          'COBOL source changed after the last completed parity run. These parity results are stale until you rerun.',
        ),
      ).toBeDefined();
    });

    it('renders compile failure stages and failure note', () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: 'completed',
          buildTest: {
            status: 'compile-failed',
            classification: 'compile-error',
            note: 'javac failed with type mismatch'
          }
        }
      });
      render(<BuildTestPanel emptyState={{ title: 'Empty', message: 'Message' }} />);
      expect(screen.getByText('Compilation failed')).toBeDefined();
      expect(screen.getAllByText('Blocked by compilation failure').length).toBeGreaterThan(0);
      expect(screen.getByText('javac failed with type mismatch')).toBeDefined();
    });
  });

  describe('EquivalencePanel', () => {
    it('renders expected vs actual output correctly', () => {
      render(
        <EquivalencePanel 
          isPending={false}
          buildTest={{
            runId: '123',
            programId: '456',
            mode: 'live',
            productMode: 'live',
            status: 'ok',
            classification: 'divergence-unknown',
            expectedOutput: 'Line 1\nLine 2',
            actualOutput: 'Line A\nLine B',
            expectedOutputRef: { sha256: 'e'.repeat(64), byteSize: 13, kind: 'cobol-oracle-stdout' },
            actualOutputRef: { sha256: 'a'.repeat(64), byteSize: 14, kind: 'java-stdout' },
            generatedArtifactRef: null
          }} 
        />
      );
      expect(screen.getByText('Mismatch detected')).toBeDefined();
      expect(screen.getAllByText('Expected output').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Actual output').length).toBeGreaterThan(0);
      expect(screen.getAllByText(/Cobol Oracle Stdout/).length).toBeGreaterThan(1);
      expect(screen.getAllByText(/Java Stdout/).length).toBeGreaterThan(0);
      expect(screen.getByText('Line 1')).toBeDefined();
      expect(screen.getByText('Line 2')).toBeDefined();
      expect(screen.getByText('Line A')).toBeDefined();
      expect(screen.getByText('Line B')).toBeDefined();
    });

    it('distinguishes known W0 coverage gaps from unknown divergence', () => {
      render(
        <EquivalencePanel
          isPending={false}
          buildTest={{
            runId: '123',
            programId: '456',
            mode: 'live',
            productMode: 'live',
            status: 'output-divergence',
            classification: 'divergence-known-w0-coverage-gap',
            expectedOutput: 'COBOL',
            actualOutput: 'JAVA',
            generatedArtifactRef: null
          }}
        />
      );

      expect(screen.getByText('Known divergence')).toBeDefined();
      expect(screen.queryByText('Mismatch detected')).not.toBeInTheDocument();
    });

    it('renders a blocked parity label for compile failures', () => {
      render(
        <EquivalencePanel
          isPending={false}
          buildTest={{
            runId: '123',
            programId: '456',
            mode: 'live',
            productMode: 'live',
            status: 'compile-failed',
            classification: 'compile-error',
            generatedArtifactRef: null
          }}
        />
      );

      expect(screen.getAllByText('Blocked by compilation failure').length).toBeGreaterThan(0);
      expect(screen.queryByText('Mismatch detected')).not.toBeInTheDocument();
    });
  });

  describe('EvidencePackPanel', () => {
    it('renders evidence complete correctly', () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: 'completed',
          generated: {
            artifactRef: {
              sha256: 'abc123'
            }
          },
          buildTest: {
            generatedArtifactRef: {
              sha256: 'abc123'
            }
          },
          evidence: {
            status: 'complete',
            packId: 'pack-123',
            manifestHash: 'manifest-sha-123',
            generatedArtifactRef: {
              sha256: 'abc123'
            }
          }
        }
      });
      render(<EvidencePackPanel emptyState={{ title: 'Empty', message: 'Message' }} />);
      expect(screen.getByText('Evidence Pack Complete')).toBeDefined();
      expect(screen.getByText('pack-123')).toBeDefined();
      expect(screen.getByText('manifest-sha-123')).toBeDefined();
      expect(screen.getByText('All required artifacts are present.')).toBeDefined();
      expect(screen.getByText('Displayed Java, build/test, and evidence all reference the same generated artifact.')).toBeDefined();
    });

    it('renders evidence incomplete with missing artifacts correctly', () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: 'completed',
          evidence: {
            status: 'incomplete',
            missingArtifacts: ['Missing1', 'Missing2']
          }
        }
      });
      render(<EvidencePackPanel emptyState={{ title: 'Empty', message: 'Message' }} />);
      expect(screen.getByText('Evidence Pack Incomplete')).toBeDefined();
      expect(screen.getByText('Missing1')).toBeDefined();
      expect(screen.getByText('Missing2')).toBeDefined();
    });

    it('marks current evidence stale after a COBOL edit', () => {
      useSourceWorkspaceMock.mockReturnValue({
        statusFlags: {
          clean: false,
          pendingReRun: true,
        },
        selectedTrustCase: null,
      });
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: 'completed',
          evidence: {
            status: 'complete',
            packId: 'pack-stale',
            manifestHash: 'manifest-stale',
            generatedArtifactRef: {
              sha256: 'abc123',
            },
          },
        },
      });

      render(<EvidencePackPanel emptyState={{ title: 'Empty', message: 'Message' }} />);
      expect(
        screen.getByText('COBOL source changed after the last completed parity run. The current evidence pack is stale until you rerun.'),
      ).toBeDefined();
    });

    it('marks current evidence stale when Java buffers diverge from the generator baseline', () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: 'completed',
          evidence: {
            status: 'complete',
            packId: 'pack-drift',
            manifestHash: 'manifest-drift',
            generatedArtifactRef: {
              sha256: 'abc123',
            },
          },
        },
        manualDriftSummary: () => ({
          hasManualEdits: true,
          fileCount: 2,
          regionCount: 3,
          baselineRunIds: ['run-123'],
        }),
      });

      render(<EvidencePackPanel emptyState={{ title: 'Empty', message: 'Message' }} />);
      expect(
        screen.getAllByText(
          'Current Java diverges from run run-123. 2 files and 3 regions carry manual edit provenance, so build/test and evidence are stale until you rerun.',
        ).length,
      ).toBeGreaterThan(0);
    });

    it('marks evidence produced by another trust case or catalog version', () => {
      useSourceWorkspaceMock.mockReturnValue({
        statusFlags: {
          clean: true,
          pendingReRun: false,
        },
        selectedTrustCase: {
          trustCaseId: 'CURRENT-CASE',
          configurationDigest: 'current-digest',
        },
      });
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: 'completed',
          summary: {
            trustCaseId: 'OLD-CASE',
            trustCaseConfigurationDigest: 'old-digest',
          },
          generated: {
            artifactRef: {
              sha256: 'abc123',
            },
          },
          buildTest: {
            generatedArtifactRef: {
              sha256: 'abc123',
            },
          },
          evidence: {
            status: 'complete',
            packId: 'pack-trust-case',
            manifestHash: 'manifest-trust-case',
            generatedArtifactRef: {
              sha256: 'abc123',
            },
          },
        },
      });

      render(<EvidencePackPanel emptyState={{ title: 'Empty', message: 'Message' }} />);
      expect(
        screen.getByText(/Existing evidence was produced from\s+OLD-CASE or a different catalog version\. Rerun to use\s+CURRENT-CASE\./),
      ).toBeDefined();
    });

    it('keeps previous evidence accessible when the latest rerun fails', () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: 'failed',
          evidence: null,
          previousRun: {
            runId: 'run-prev',
            orchestratorRunId: 'run-prev-orch',
            programId: 'P-1',
            phase: 'completed',
            summary: null,
            generated: {
              artifactRef: {
                sha256: 'abc123',
              },
            },
            generatedFiles: null,
            buildTest: {
              generatedArtifactRef: {
                sha256: 'abc123',
              },
            },
            evidence: {
              status: 'complete',
              packId: 'pack-prev',
              manifestHash: 'manifest-prev',
              generatedArtifactRef: {
                sha256: 'abc123',
              },
            },
            events: null,
            progress: null,
            artifacts: null,
            experience: null,
            workflow: null,
          },
        },
      });

      render(<EvidencePackPanel emptyState={{ title: 'Empty', message: 'Message' }} />);
      expect(screen.getByText('Previous Evidence Pack Complete')).toBeDefined();
      expect(
        screen.getByText('Latest rerun failed. Showing the previous evidence pack as stale so the last completed evidence remains accessible.'),
      ).toBeDefined();
      expect(screen.getByText('pack-prev')).toBeDefined();
    });

    it('does not render a success headline when artifact references are mismatched', () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: 'completed',
          generated: {
            artifactRef: {
              sha256: 'abc123',
              path: 'artifacts/generated.json'
            }
          },
          buildTest: {
            generatedArtifactRef: {
              sha256: 'def456',
              path: 'artifacts/build-test.json'
            }
          },
          evidence: {
            status: 'complete',
            generatedArtifactRef: {
              sha256: 'abc123',
              path: 'artifacts/evidence.json'
            }
          }
        }
      });

      render(<EvidencePackPanel emptyState={{ title: 'Empty', message: 'Message' }} />);
      expect(screen.getByText('Evidence Pack Mismatch Detected')).toBeDefined();
      expect(screen.queryByText('Evidence Pack Complete')).not.toBeInTheDocument();
    });
  });

  describe('RunArtifactsPanel', () => {
    it('renders artifact list hash/path correctly', () => {
      const artifacts = [
        {
          path: 'artifacts/source.cbl',
          name: 'art1',
          kind: 'source',
          byteSize: 1234,
          sha256: 'hash123',
          createdBy: 'system',
          createdAt: '2026-05-15T12:00:00Z',
        }
      ];
      render(<RunArtifactsPanel artifacts={artifacts} />);
      expect(screen.getByText('artifacts/source.cbl')).toBeDefined();
      expect(screen.getByText('source')).toBeDefined();
      expect(screen.getByText('1234')).toBeDefined();
      expect(screen.getByText('hash123')).toBeDefined();
    });

    it('renders artifact fetch errors separately from the artifact list', () => {
      render(<RunArtifactsPanel artifacts={[]} errorMessage="artifacts endpoint returned 503" />);
      expect(screen.getByText('Artifacts fetch failed')).toBeDefined();
      expect(screen.getByText('artifacts endpoint returned 503')).toBeDefined();
    });

    it('renders missing artifact records even when no artifact rows exist', () => {
      render(<RunArtifactsPanel artifacts={[]} missingArtifacts={['generatedJava']} />);
      expect(screen.getByText('Missing artifact records')).toBeDefined();
      expect(screen.getByText('generatedJava')).toBeDefined();
      expect(screen.getByText('No run artifacts available.')).toBeDefined();
    });
  });

  describe('ProblemsPanel', () => {
    it('derives issues from features, missing artifacts, failed statuses, and hash mismatches', () => {
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: 'completed',
          generated: {
            unsupportedFeatures: ['GOTO', 'ALTER'],
            missingArtifacts: ['GenMiss'],
            diagnostics: [
              {
                severity: 'warning',
                code: 'gen-open-assumption',
                message: 'fallback path used',
                line: 4,
                originStep: 'generate-java'
              }
            ],
            artifactRef: {
              sha256: 'aaa',
              path: 'artifacts/generated.json'
            }
          },
          generatedFiles: {
            missingArtifacts: ['FilesMiss']
          },
          buildTest: {
            status: 'compile-failed',
            classification: 'compile-error',
            diagnostics: [
              {
                severity: 'error',
                code: 'javac-syntax',
                message: 'missing semicolon',
                line: 12,
                column: 7,
                filePath: 'src/main/java/P1.java',
                sourceKind: 'generated_java'
              }
            ],
            generatedArtifactRef: {
              sha256: 'bbb',
              path: 'artifacts/build-test.json'
            }
          },
          evidence: {
            status: 'incomplete',
            generatedArtifactRef: {
              sha256: 'ccc',
              path: 'artifacts/evidence.json'
            }
          },
          artifactsError: 'artifact endpoint failed'
        }
      });
      render(<ProblemsPanel emptyState={{ title: 'Empty', message: 'Message' }} />);
      expect(screen.getByText('GOTO')).toBeDefined();
      expect(screen.getByText('ALTER')).toBeDefined();
      expect(screen.getByText('GenMiss')).toBeDefined();
      expect(screen.getByText('FilesMiss')).toBeDefined();
      expect(screen.getByText('compile-failed')).toBeDefined();
      // Studio-IDE-5 (#244): typed diagnostics now render in a table.
      // Severity/file/line/code/message appear in their own cells.
      expect(screen.getByText('gen-open-assumption')).toBeDefined();
      expect(screen.getByText('fallback path used')).toBeDefined();
      expect(screen.getByText('javac-syntax')).toBeDefined();
      expect(screen.getByText('missing semicolon')).toBeDefined();
      expect(screen.getByText('src/main/java/P1.java')).toBeDefined();
      // The line column shows the bare integer.
      expect(screen.getAllByText('12').length).toBeGreaterThan(0);
      expect(screen.getAllByText('4').length).toBeGreaterThan(0);
      expect(screen.getByText('The evidence pack is missing required artifacts')).toBeDefined();
      expect(screen.getByText('artifact endpoint failed')).toBeDefined();
      expect(screen.getByText('Generated Java, build/test, and evidence do not reference the same artifact hash')).toBeDefined();
    });

    it('navigates only diagnostics with a concrete editor target', () => {
      const jumpableDiagnostic = {
        severity: 'error',
        code: 'JUMP',
        message: 'jumpable diagnostic',
        line: 9,
        column: 3,
        filePath: 'src/main/java/App.java',
        sourceKind: 'generated_java',
      };
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: 'completed',
          generated: {
            status: 'generated',
            diagnostics: [
              jumpableDiagnostic,
              {
                severity: 'warning',
                code: 'RUN',
                message: 'run-level diagnostic',
                line: 3,
                sourceKind: 'build',
              },
            ],
          },
          buildTest: null,
        },
      });

      render(<ProblemsPanel emptyState={{ title: 'Empty', message: 'Message' }} />);

      const jumpableRow = screen.getByLabelText(
        'error JUMP at src/main/java/App.java:9',
      );
      const runLevelRow = screen.getByLabelText('warning RUN at —:3');

      expect(jumpableRow).toHaveAttribute('tabindex', '0');
      expect(runLevelRow).toHaveAttribute('tabindex', '-1');

      fireEvent.click(jumpableRow);
      fireEvent.keyDown(jumpableRow, { key: 'Enter' });
      fireEvent.keyDown(jumpableRow, { key: ' ' });
      expect(navigateToDiagnosticMock).toHaveBeenCalledTimes(3);
      expect(navigateToDiagnosticMock).toHaveBeenCalledWith(jumpableDiagnostic);

      fireEvent.click(runLevelRow);
      fireEvent.keyDown(runLevelRow, { key: 'Enter' });
      fireEvent.keyDown(runLevelRow, { key: ' ' });
      expect(navigateToDiagnosticMock).toHaveBeenCalledTimes(3);
    });
  });

  describe('RunLifecyclePanel', () => {
    it('renders lifecycle events when available', async () => {
      const { RunLifecyclePanel } = await import('../../../src/components/run/RunLifecyclePanel');
      useTransformationRunMock.mockReturnValue({
        state: {
          ...mockState,
          phase: 'completed',
          events: {
            events: [
              {
                createdAt: '2026-05-15T12:00:00Z',
                type: 'run.completed',
                status: 'completed',
                message: 'Transformation finished'
              }
            ]
          }
        }
      });
      render(<RunLifecyclePanel emptyState={{ title: 'Empty', message: 'Message' }} />);
      expect(screen.getByText('run.completed')).toBeDefined();
      expect(screen.getByText('Transformation finished')).toBeDefined();
    });
  });
});

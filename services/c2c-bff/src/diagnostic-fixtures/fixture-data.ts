// Diagnostic fixtures for developer-only runs. This module is quarantined
// inside `diagnostic-fixtures/` and may only be imported by code paths that
// have already verified `C2C_ENABLE_DIAGNOSTIC_FIXTURES`. Product-mode code
// must never reach this file.
import type { SampleDetail } from '../samples';

export interface DiagnosticFixtureOutcome {
  generated: {
    status: 'generated' | 'unsupported' | 'skipped';
    entryClass: string;
    entryFilePath: string;
    files: Record<string, string>;
    unsupportedFeatures: string[];
    openAssumptions: string[];
    note: string;
  };
  buildTest: {
    status:
      | 'ok'
      | 'compile-failed'
      | 'run-failed'
      | 'output-divergence'
      | 'golden-master-reproduction-failed'
      | 'missing-golden-master'
      | 'skipped';
    classification:
      | 'match'
      | 'divergence-known-w0-coverage-gap'
      | 'divergence-unknown'
      | 'true-golden-master-reproduction-error'
      | 'true-golden-master-mismatch'
      | 'compile-error'
      | 'run-error'
      | 'skipped-no-execution';
    actualOutput: string;
    outputRef: string;
    note: string;
  };
  evidence: {
    status: 'complete' | 'incomplete';
    packId: string;
    missingArtifacts: string[];
    note: string;
  };
}

function classNameFor(programId: string): string {
  const sanitized = programId.replace(/[^A-Za-z0-9]/g, '');
  if (sanitized.length === 0) return 'Program';
  const head = sanitized.charAt(0).toUpperCase();
  const tail = sanitized.slice(1).toLowerCase();
  return `Program${head}${tail}`;
}

function generatedJavaStub(programId: string, className: string): string {
  return [
    `// Synthetic W0 generated-Java stub for programId=${programId}.`,
    '// Diagnostic fixture only; the product path produces this content from target-java-generation-service.',
    'package c2c.w0.generated;',
    '',
    `public final class ${className} {`,
    `    private ${className}() {}`,
    '',
    '    public static void main(String[] args) {',
    `        System.out.println("W0-STUB ${programId}");`,
    '    }',
    '}',
    '',
  ].join('\n');
}

function unsupportedFeaturesFor(programId: string): string[] {
  switch (programId) {
    case 'BRNCH01':
      return ['PERFORM VARYING', 'EVALUATE', 'IF/ELSE', 'OCCURS table access'];
    case 'CTRLDEC01':
      return ['COMPUTE on decimal', 'DISPLAY of computed value'];
    case 'BATCH01':
      return ['PERFORM UNTIL', 'COMPUTE', 'ADD on packed decimal'];
    default:
      return ['unspecified W0 coverage gap'];
  }
}

export function diagnosticFixtureOutcomeFor(sample: SampleDetail, runId: string): DiagnosticFixtureOutcome {
  const className = classNameFor(sample.programId);
  const entryFilePath = `src/main/java/c2c/w0/generated/${className}.java`;
  const unsupported = unsupportedFeaturesFor(sample.programId);
  const knownDivergence = sample.knownDivergenceAtW0;

  const generated: DiagnosticFixtureOutcome['generated'] = {
    status: knownDivergence ? 'unsupported' : 'generated',
    entryClass: `c2c.w0.generated.${className}`,
    entryFilePath,
    files: {
      [entryFilePath]: generatedJavaStub(sample.programId, className),
    },
    unsupportedFeatures: knownDivergence ? unsupported : [],
    openAssumptions: [
      'IO is limited to stdout DISPLAY at W0.',
      'No file or database access is wired in W0.',
    ],
    note: knownDivergence
      ? 'Diagnostic fixture: W0 generator coverage does not include the constructs used by this program. The generated-Java view is a labelled stub.'
      : 'Diagnostic fixture: deterministic Java skeleton for developer inspection only; not a product result.',
  };

  const buildTest: DiagnosticFixtureOutcome['buildTest'] = {
    status: knownDivergence ? 'output-divergence' : 'ok',
    classification: knownDivergence ? 'divergence-known-w0-coverage-gap' : 'match',
    actualOutput: `W0-STUB ${sample.programId}\n`,
    outputRef: `sha256:diagnostic-fixture/${sample.programId.toLowerCase()}`,
    note: knownDivergence
      ? 'Diagnostic fixture: divergence is declared by the fixture registry; not a product build/test result.'
      : 'Diagnostic fixture: matches the Golden Master fixture; not a product build/test result.',
  };

  const evidence: DiagnosticFixtureOutcome['evidence'] = {
    status: 'incomplete',
    packId: `epk-${runId}-1`,
    missingArtifacts: ['sourceCobol', 'semanticIr', 'harnessEvents', 'modelInvocations'],
    note: 'Diagnostic fixture Evidence Pack reference; not a product Evidence Pack. Product exports come from evidence-service /v0/packs.',
  };

  return { generated, buildTest, evidence };
}

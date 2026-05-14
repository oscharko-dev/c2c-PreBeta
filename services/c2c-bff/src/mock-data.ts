import type { SampleDetail } from './samples';

export interface MockRunOutcome {
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
      | 'missing-golden-master'
      | 'skipped';
    classification:
      | 'match'
      | 'divergence-known-w0-coverage-gap'
      | 'divergence-unknown'
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
    manifestUri: string;
    exportUri: string;
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
    '// In live mode this content comes from target-java-generation-service.',
    '// At W0 the generator does not yet translate PERFORM/EVALUATE/COMPUTE,',
    '// so the live output for this fixture is documented as a known divergence.',
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

export function mockOutcomeFor(sample: SampleDetail, runId: string): MockRunOutcome {
  const className = classNameFor(sample.programId);
  const entryFilePath = `src/main/java/c2c/w0/generated/${className}.java`;
  const unsupported = unsupportedFeaturesFor(sample.programId);
  const knownDivergence = sample.knownDivergenceAtW0;

  const generated: MockRunOutcome['generated'] = {
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
      ? 'W0 generator coverage does not yet include the constructs used by this program. The generated-Java view is a labelled stub.'
      : 'W0 generator emitted a deterministic Java skeleton for this program.',
  };

  const buildTest: MockRunOutcome['buildTest'] = {
    status: knownDivergence ? 'output-divergence' : 'ok',
    classification: knownDivergence ? 'divergence-known-w0-coverage-gap' : 'match',
    actualOutput: `W0-STUB ${sample.programId}\n`,
    outputRef: `sha256:mock/${sample.programId.toLowerCase()}`,
    note: knownDivergence
      ? 'Build/test diverges from the Golden Master by design at W0. The Evidence Pack records this as a known coverage gap, not an unknown regression.'
      : 'Build/test matched the Golden Master fixture.',
  };

  const evidence: MockRunOutcome['evidence'] = {
    status: 'incomplete',
    packId: `epk-${runId}-1`,
    manifestUri: `urn:c2c-bff/mock-evidence-pack/${runId}`,
    exportUri: `file://evidence/mock/${runId}/evidence-pack-v0.zip`,
    missingArtifacts: ['sourceCobol', 'semanticIr', 'harnessEvents', 'modelInvocations'],
    note: 'Mock Evidence Pack manifest reference. Live exports come from evidence-service /v0/packs.',
  };

  return { generated, buildTest, evidence };
}

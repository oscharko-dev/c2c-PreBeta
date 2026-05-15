'use client';
import { BuildTestView } from '../../types/build-test';
import { CodeSurface } from '../ui/CodeSurface';
import { describeClassification, splitOutputLines } from './runPanelUtils';

export function EquivalencePanel({ buildTest, isPending }: { buildTest: BuildTestView | null; isPending: boolean }) {
  if (isPending || !buildTest) {
    return <div className="text-text-dim text-sm">Waiting for equivalence check...</div>;
  }

  const { classification, expectedOutput, actualOutput } = buildTest;

  let classificationLabel: string = describeClassification(classification);
  let labelColor = 'text-text-dim';
  if (classification === 'match') {
    classificationLabel = 'Match (Equivalent)';
    labelColor = 'text-success';
  } else if (classification === 'divergence-known-w0-coverage-gap') {
    classificationLabel = 'Divergence (Known W0 Gap)';
    labelColor = 'text-warn';
  } else if (classification === 'divergence-unknown') {
    classificationLabel = 'Divergence (Unknown)';
    labelColor = 'text-error';
  } else if (classification === 'compile-error' || classification === 'run-error' || classification === 'skipped-no-execution') {
    labelColor = 'text-warn';
  } else {
    labelColor = 'text-error';
  }

  return (
    <div className="flex flex-col h-full">
      <div className={`mb-4 font-mono font-bold ${labelColor}`}>
        {classificationLabel}
      </div>
      <div className="flex-1 grid grid-cols-2 gap-4 min-h-0">
        <div className="flex flex-col">
          <div className="text-xs font-semibold mb-2 text-text-dim">COBOL Oracle (Expected)</div>
          <CodeSurface
            className="flex-1 border border-line-2 rounded"
            label="Expected Output"
            lines={splitOutputLines(expectedOutput).map((line) => ({ content: line }))}
          />
        </div>
        <div className="flex flex-col">
          <div className="text-xs font-semibold mb-2 text-text-dim">Java Execution (Actual)</div>
          <CodeSurface
            className="flex-1 border border-line-2 rounded"
            label="Actual Output"
            lines={splitOutputLines(actualOutput).map((line) => ({ content: line }))}
          />
        </div>
      </div>
    </div>
  );
}

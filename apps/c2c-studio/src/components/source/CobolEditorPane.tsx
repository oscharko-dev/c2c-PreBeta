'use client';

import React, { useEffect, useRef, useState } from 'react';
import { useSourceWorkspace } from '../../stores/sourceWorkspace';
import { Play } from 'lucide-react';
import { DEFAULT_SOURCE_NAME, deriveDetectedProgramId, deriveDisplayedLineEnding, deriveSourceHash } from '../../lib/sourceAnalysis';
import { useC2cApi } from '../../hooks/useC2cApi';
import { useTransformationRun } from '../../stores/transformationRun';
import { UnsupportedConstructsPanel } from '../state/UnsupportedConstructsPanel';
import { getWorkbenchReadiness } from '../workbench/workbenchReadiness';

export function CobolEditorPane() {
  const {
    sourceText,
    setSourceText,
    isDirty,
    sourceName,
    loadedProgramId,
    transformError,
    isTransforming,
    canSubmitTransform,
    submitTransform,
  } = useSourceWorkspace();
  const [sourceHash, setSourceHash] = useState('00000000');

  const apiState = useC2cApi();
  const { productState } = useTransformationRun();
  const readiness = getWorkbenchReadiness(apiState);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lineCount = sourceText.split('\n').length || 1;
  const lines = Array.from({ length: lineCount }, (_, i) => i + 1);
  const detectedProgramId = deriveDetectedProgramId(sourceText) ?? loadedProgramId;
  const lineEnding = deriveDisplayedLineEnding(sourceText);

  useEffect(() => {
    let cancelled = false;

    deriveSourceHash(sourceText).then((nextHash) => {
      if (!cancelled) {
        setSourceHash(nextHash);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [sourceText]);

  if (!sourceText && !isDirty) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center">
        <div className="max-w-sm space-y-4">
          <p className="text-sm font-medium text-text">No source file selected</p>
          <p className="text-sm text-text-dim">
            Load a reference program from the Source Workspace or paste COBOL code here.
          </p>
          <button
            type="button"
            onClick={() => setSourceText('       IDENTIFICATION DIVISION.\n       PROGRAM-ID. PROG01.\n')}
            className="rounded bg-bg-2 px-4 py-2 text-sm text-text hover:bg-bg-3"
          >
            Start Typing
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-bg-0">
      <div className="flex items-center justify-between border-b border-line px-4 py-2 shrink-0">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium text-text">
            {sourceName || DEFAULT_SOURCE_NAME} {isDirty && '*'}
          </h2>
          {detectedProgramId && (
            <span className="rounded bg-bg-2 px-2 py-1 text-[10px] text-text-dim">
              ID: {detectedProgramId}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <div className="text-[10px] text-text-faint uppercase tracking-wider flex gap-3">
            <span>UTF-8</span>
            <span>{lineEnding}</span>
            <span title="Source Hash">#{sourceHash}</span>
          </div>
          <button
            type="button"
            onClick={() => {
              void submitTransform();
            }}
            disabled={!canSubmitTransform || !readiness.startEnabled}
            className="flex items-center gap-1 rounded bg-accent px-3 py-1.5 text-xs font-medium text-bg-0 hover:bg-accent-dim disabled:opacity-50"
          >
            <Play className="w-3.5 h-3.5" />
            {isTransforming ? 'Transforming...' : 'Start Transformation'}
          </button>
        </div>
      </div>
      
      {transformError && (
        <div className="bg-error/10 text-error px-4 py-2 text-sm border-b border-error/20">
          {transformError}
        </div>
      )}

      {productState.state === 'unsupported' ? (
        <div className="border-b border-line bg-bg-1 px-4 py-3">
          <div className="text-sm font-medium text-warn">Unsupported COBOL constructs block this run.</div>
          <div className="mt-1 text-xs text-text-dim">
            Review the unsupported features before attempting another transformation.
          </div>
          <UnsupportedConstructsPanel constructs={productState.unsupportedFeatures || []} />
        </div>
      ) : null}

      <div className="flex flex-1 min-h-0 overflow-hidden font-mono text-[12px]">
        <div 
          className="border-r border-line bg-bg-1 px-2 py-2 text-right text-text-faint overflow-hidden select-none"
          aria-hidden="true"
        >
          {lines.map((num) => (
            <div key={num} className="h-[21px] min-w-8 pr-2 leading-[21px]">
              {num}
            </div>
          ))}
        </div>
        <textarea
          ref={textareaRef}
          value={sourceText}
          onChange={(e) => setSourceText(e.target.value)}
          spellCheck={false}
          className="flex-1 w-full m-0 p-2 leading-[21px] bg-transparent text-text resize-none outline-none overflow-auto whitespace-pre"
          style={{ tabSize: 4 }}
        />
      </div>
    </div>
  );
}

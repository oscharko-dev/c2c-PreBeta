'use client';

import React, { useRef, useState, useEffect } from 'react';
import { useSourceWorkspace } from '../../stores/sourceWorkspace';
import { cn } from '@/lib/utils';
import { Play } from 'lucide-react';
import { apiClient } from '../../lib/apiClient';

export function CobolEditorPane() {
  const { sourceText, setSourceText, isDirty, sourceName, programId } = useSourceWorkspace();
  const [isTransforming, setIsTransforming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lineCount = sourceText.split('\\n').length || 1;
  const lines = Array.from({ length: lineCount }, (_, i) => i + 1);

  const handleTransform = async () => {
    if (!sourceText.trim()) return;

    setIsTransforming(true);
    setError(null);
    const result = await apiClient.transform({
      sourceText,
      programId: programId || undefined,
      sourceName: sourceName || 'pasted-source.cbl',
    });

    if (!result.ok) {
      setError(result.message);
    }
    setIsTransforming(false);
  };

  const calculateHash = (text: string) => {
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = (hash << 5) - hash + text.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(16);
  };

  if (!sourceText && !isDirty) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-center">
        <div className="max-w-sm space-y-4">
          <p className="text-sm font-medium text-text">No source file selected</p>
          <p className="text-sm text-text-dim">
            Load a reference program from the Source Workspace or paste COBOL code here.
          </p>
          <button
            onClick={() => setSourceText('      * PASTE COBOL HERE')}
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
            {sourceName || 'Unsaved Buffer'} {isDirty && '*'}
          </h2>
          {programId && (
            <span className="rounded bg-bg-2 px-2 py-1 text-[10px] text-text-dim">
              ID: {programId}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <div className="text-[10px] text-text-faint uppercase tracking-wider flex gap-3">
            <span>UTF-8</span>
            <span>CRLF</span>
            <span title="Source Hash">#{calculateHash(sourceText).padStart(8, '0')}</span>
          </div>
          <button
            onClick={handleTransform}
            disabled={isTransforming || !sourceText.trim()}
            className="flex items-center gap-1 rounded bg-accent px-3 py-1.5 text-xs font-medium text-bg-0 hover:bg-accent-dim disabled:opacity-50"
          >
            <Play className="w-3.5 h-3.5" />
            {isTransforming ? 'Transforming...' : 'Start Transformation'}
          </button>
        </div>
      </div>
      
      {error && (
        <div className="bg-error/10 text-error px-4 py-2 text-sm border-b border-error/20">
          {error}
        </div>
      )}

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

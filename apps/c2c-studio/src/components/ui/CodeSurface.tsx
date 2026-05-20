"use client";

import React, { useCallback } from 'react';
import { cn } from '@/lib/utils';
import { copyToClipboard, useCopyFeedback } from './copyFeedback';

export interface CodeSurfaceLine {
  content: React.ReactNode;
  active?: boolean;
  tone?: 'neutral' | 'success' | 'warning' | 'error';
}

interface CodeSurfaceProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string;
  lines: CodeSurfaceLine[];
  copyValue?: string | null;
  copyLabel?: string;
  emptyMessage?: string;
}

export const CodeSurface = React.forwardRef<HTMLDivElement, CodeSurfaceProps>(
  ({ className, label, lines, copyValue, copyLabel, emptyMessage, ...props }, ref) => {
    const { copied, showCopied } = useCopyFeedback();
    const canCopy = typeof copyValue === 'string' && copyValue.length > 0;
    const handleCopy = useCallback(() => {
      if (!canCopy) {
        return;
      }

      const text = copyValue ?? '';
      void copyToClipboard(text).then((ok) => {
        if (!ok) {
          return;
        }
        showCopied();
      });
    }, [canCopy, copyValue, showCopied]);

    return (
      <div
        ref={ref}
        aria-label={label}
        className={cn('flex min-h-0 flex-col overflow-hidden bg-bg-0 font-mono text-[12px]', className)}
        {...props}
      >
        <div className="flex items-center justify-between gap-2 border-b border-line bg-bg-1 px-3 py-2">
          <div className="truncate text-xs font-semibold uppercase tracking-wider text-text-dim">
            {label}
          </div>
          {canCopy ? (
            <button
              type="button"
              onClick={handleCopy}
              className="inline-flex min-h-6 items-center rounded border border-line bg-bg-0 px-2 py-1 text-[11px] font-medium text-text-dim transition-colors hover:border-accent hover:text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              {copied ? 'Copied' : copyLabel ?? 'Copy'}
            </button>
          ) : null}
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-[auto_minmax(0,1fr)]">
          <div
            className="border-r border-line bg-bg-1 px-2 py-2 text-right text-text-faint"
            aria-hidden="true"
          >
            {lines.length > 0 ? (
              lines.map((_, index) => (
                <div
                  key={`line-number-${index + 1}`}
                  className={cn('h-[18px] min-w-8 pr-2 leading-[18px]', {
                    'text-text': lines[index].active,
                    'text-success': lines[index].tone === 'success',
                    'text-warn': lines[index].tone === 'warning',
                    'text-error': lines[index].tone === 'error',
                  })}
                >
                  {index + 1}
                </div>
              ))
            ) : (
              <div className="px-2 py-2 text-text-faint">1</div>
            )}
          </div>

          <pre className="m-0 min-h-0 overflow-auto whitespace-pre px-3 py-2 text-text">
            {lines.length > 0 ? (
              lines.map((line, index) => (
                <div
                  key={`code-line-${index + 1}`}
                  className={cn('h-[18px] rounded-none pl-1 leading-[18px]', {
                    'bg-white/[0.025] shadow-[inset_2px_0_0_var(--accent-dim)]': line.active,
                    'bg-success/10 text-success': line.tone === 'success',
                    'bg-warn-soft text-warn': line.tone === 'warning',
                    'bg-error/10 text-error': line.tone === 'error',
                  })}
                >
                  {line.content}
                </div>
              ))
            ) : (
              <div className="text-text-faint">{emptyMessage ?? 'No output available.'}</div>
            )}
          </pre>
        </div>
        <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {copied ? 'Copied' : ''}
        </span>
      </div>
    );
  }
);

CodeSurface.displayName = 'CodeSurface';

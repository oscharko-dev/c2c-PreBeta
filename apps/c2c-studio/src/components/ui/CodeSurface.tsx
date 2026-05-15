import React from 'react';
import { cn } from '@/lib/utils';

export interface CodeSurfaceLine {
  content: React.ReactNode;
  active?: boolean;
}

interface CodeSurfaceProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string;
  lines: CodeSurfaceLine[];
}

export const CodeSurface = React.forwardRef<HTMLDivElement, CodeSurfaceProps>(
  ({ className, label, lines, ...props }, ref) => {
    return (
      <div
        ref={ref}
        aria-label={label}
        className={cn('grid min-h-0 grid-cols-[auto_minmax(0,1fr)] overflow-hidden bg-bg-0 font-mono text-[12px]', className)}
        {...props}
      >
        <div className="border-r border-line bg-bg-1 px-2 py-2 text-right text-text-faint" aria-hidden="true">
          {lines.map((_, index) => (
            <div
              key={`line-number-${index + 1}`}
              className={cn('h-[18px] min-w-8 pr-2 leading-[18px]', { 'text-text': lines[index].active })}
            >
              {index + 1}
            </div>
          ))}
        </div>

        <pre className="m-0 overflow-auto px-3 py-2 text-text">
          {lines.map((line, index) => (
            <div
              key={`code-line-${index + 1}`}
              className={cn('h-[18px] rounded-none pl-1 leading-[18px]', {
                'bg-white/[0.025] shadow-[inset_2px_0_0_var(--accent-dim)]': line.active,
              })}
            >
              {line.content}
            </div>
          ))}
        </pre>
      </div>
    );
  }
);

CodeSurface.displayName = 'CodeSurface';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

const DEFAULT_LINE_HEIGHT = 20;
const DEFAULT_OVERSCAN = 8;
const DEFAULT_VIEWPORT_HEIGHT = 480;
const LARGE_FILE_THRESHOLD = 600;

interface VirtualizedCodeBlockProps extends React.HTMLAttributes<HTMLDivElement> {
  code: string;
  label: string;
  lineHeight?: number;
  overscan?: number;
}

export function VirtualizedCodeBlock({
  code,
  label,
  className,
  lineHeight = DEFAULT_LINE_HEIGHT,
  overscan = DEFAULT_OVERSCAN,
  ...props
}: VirtualizedCodeBlockProps) {
  const lines = useMemo(() => code.split('\n'), [code]);
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(DEFAULT_VIEWPORT_HEIGHT);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    const measure = () => {
      setViewportHeight(element.clientHeight || DEFAULT_VIEWPORT_HEIGHT);
    };

    measure();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }

    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const totalHeight = Math.max(lines.length, 1) * lineHeight;
  const startIndex = Math.max(0, Math.floor(scrollTop / lineHeight) - overscan);
  const visibleCount = Math.ceil(viewportHeight / lineHeight) + overscan * 2;
  const endIndex = Math.min(lines.length, startIndex + visibleCount);
  const visibleLines = lines.slice(startIndex, endIndex);
  const isLargeFile = lines.length > LARGE_FILE_THRESHOLD;

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-0">
      {isLargeFile ? (
        <div className="shrink-0 border-b border-line bg-bg-1 px-4 py-2 text-xs text-text-dim">
          Large file mode active. Rendering is constrained to the visible window to keep the workbench responsive.
        </div>
      ) : null}
      <div
        ref={containerRef}
        aria-label={label}
        className={cn('min-h-0 flex-1 overflow-auto bg-bg-0 font-mono text-sm', className)}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        {...props}
      >
        <div
          className="relative grid grid-cols-[auto_minmax(0,1fr)]"
          style={{ height: totalHeight }}
        >
          <div className="border-r border-line bg-bg-1 text-right text-text-faint" aria-hidden="true">
            {visibleLines.map((_, index) => {
              const lineNumber = startIndex + index + 1;
              return (
                <div
                  key={`line-number-${lineNumber}`}
                  className="absolute left-0 right-0 px-2"
                  style={{
                    top: (lineNumber - 1) * lineHeight,
                    height: lineHeight,
                    lineHeight: `${lineHeight}px`,
                  }}
                >
                  {lineNumber}
                </div>
              );
            })}
          </div>
          <pre className="m-0 text-text">
            {visibleLines.map((line, index) => {
              const lineNumber = startIndex + index + 1;
              return (
                <div
                  key={`code-line-${lineNumber}`}
                  className="absolute left-0 right-0 overflow-hidden whitespace-pre px-4"
                  style={{
                    top: (lineNumber - 1) * lineHeight,
                    height: lineHeight,
                    lineHeight: `${lineHeight}px`,
                    left: '3.75rem',
                  }}
                >
                  {line || ' '}
                </div>
              );
            })}
          </pre>
        </div>
      </div>
    </div>
  );
}

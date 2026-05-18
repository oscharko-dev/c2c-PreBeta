import { cn } from "@/lib/utils";

interface EditorSkeletonProps {
  className?: string;
  label?: string;
}

export function EditorSkeleton({
  className,
  label = "Loading editor",
}: EditorSkeletonProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label}
      data-testid="code-editor-skeleton"
      className={cn(
        "flex h-full min-h-0 w-full overflow-hidden bg-bg-0 font-mono text-sm text-text-faint",
        className,
      )}
    >
      <div
        aria-hidden="true"
        className="w-12 shrink-0 border-r border-line bg-bg-1 py-2 text-right"
      >
        {Array.from({ length: 12 }).map((_, index) => (
          <div
            key={`skeleton-line-${index + 1}`}
            className="h-[18px] pr-2 leading-[18px]"
          >
            {index + 1}
          </div>
        ))}
      </div>
      <div className="flex-1 px-4 py-2">
        <span className="sr-only">{label}</span>
      </div>
    </div>
  );
}

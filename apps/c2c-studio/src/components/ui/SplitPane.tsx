import React from "react";
import { cn } from "@/lib/utils";

interface SplitPaneProps extends React.HTMLAttributes<HTMLDivElement> {
  left: React.ReactNode;
  right: React.ReactNode;
  leftLabel?: string;
  rightLabel?: string;
}

export const SplitPane = React.forwardRef<HTMLDivElement, SplitPaneProps>(
  (
    {
      className,
      left,
      right,
      leftLabel = "Left pane",
      rightLabel = "Right pane",
      ...props
    },
    ref,
  ) => {
    return (
      <div
        ref={ref}
        className={cn(
          "grid min-h-0 gap-px overflow-hidden rounded-md border border-line bg-line lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]",
          className,
        )}
        {...props}
      >
        <section aria-label={leftLabel} className="min-h-0 bg-bg-0">
          {left}
        </section>
        <section aria-label={rightLabel} className="min-h-0 bg-bg-0">
          {right}
        </section>
      </div>
    );
  },
);

SplitPane.displayName = "SplitPane";

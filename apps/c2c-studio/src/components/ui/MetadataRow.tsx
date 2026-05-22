import React from "react";
import { cn } from "@/lib/utils";
import { Truncate } from "./Truncate";

export interface MetadataItem {
  label: string;
  value: string;
  tone?: "default" | "success" | "warning" | "error";
  truncate?: "end" | "middle";
}

interface MetadataRowProps extends React.HTMLAttributes<HTMLDivElement> {
  items: MetadataItem[];
}

const toneClassName: Record<NonNullable<MetadataItem["tone"]>, string> = {
  default: "text-text-dim",
  success: "text-success",
  warning: "text-warn",
  error: "text-error",
};

export const MetadataRow = React.forwardRef<HTMLDivElement, MetadataRowProps>(
  ({ className, items, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          "flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-bg-1 px-3 py-1.5 text-[10.5px] font-mono text-text-dim",
          className,
        )}
        {...props}
      >
        {items.map((item) => (
          <div
            key={`${item.label}:${item.value}`}
            className="flex min-w-0 items-center gap-1.5"
          >
            <span className="shrink-0 text-text-dim">{item.label}</span>
            <Truncate
              text={item.value}
              maxLength={32}
              position={item.truncate ?? "end"}
              className={cn(
                "min-w-0 max-w-[24rem]",
                toneClassName[item.tone ?? "default"],
              )}
            />
          </div>
        ))}
      </div>
    );
  },
);

MetadataRow.displayName = "MetadataRow";

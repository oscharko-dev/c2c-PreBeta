import React from "react";
import { cn } from "@/lib/utils";
import { Badge } from "./Badge";
import { Truncate } from "./Truncate";
import { StatusVariant } from "@/types/design";

export interface StatusBarItem {
  label: string;
  value?: string;
  valueVariant?: StatusVariant | "default";
  truncate?: boolean;
}

interface StatusBarProps extends React.HTMLAttributes<HTMLDivElement> {
  breadcrumbs?: string[];
  items: StatusBarItem[];
}

export const StatusBar = React.forwardRef<HTMLDivElement, StatusBarProps>(
  ({ className, breadcrumbs = [], items, ...props }, ref) => {
    return (
      <footer
        ref={ref}
        className={cn(
          "flex flex-col gap-2 border-t border-line bg-bg-1 px-3 py-2 text-[10.5px] text-text-dim sm:flex-row sm:items-center sm:justify-between",
          className,
        )}
        {...props}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {breadcrumbs.map((crumb, index) => (
            <React.Fragment key={`${crumb}-${index}`}>
              {index > 0 && <span className="text-text-faint">/</span>}
              <Truncate
                text={crumb}
                maxLength={index === breadcrumbs.length - 1 ? 36 : 18}
                className="max-w-[14rem]"
              />
            </React.Fragment>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {items.map((item) => (
            <div
              key={`${item.label}:${item.value ?? ""}`}
              className="flex items-center gap-1.5"
            >
              <span className="text-text-faint">{item.label}</span>
              {item.value ? (
                item.valueVariant ? (
                  <Badge
                    variant={item.valueVariant}
                    icon={item.valueVariant !== "default"}
                  >
                    {item.value}
                  </Badge>
                ) : item.truncate ? (
                  <Truncate
                    text={item.value}
                    maxLength={20}
                    position="middle"
                  />
                ) : (
                  <span className="font-mono text-text">{item.value}</span>
                )
              ) : null}
            </div>
          ))}
        </div>
      </footer>
    );
  },
);

StatusBar.displayName = "StatusBar";

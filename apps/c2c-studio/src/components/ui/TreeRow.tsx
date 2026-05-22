import React from "react";
import { cn } from "@/lib/utils";
import { ChevronRight, ChevronDown, File, Folder } from "lucide-react";
import { StatusChip } from "./StatusChip";
import { StatusVariant } from "@/types/design";

export interface TreeRowProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string;
  type?: "file" | "folder";
  depth?: number;
  isOpen?: boolean;
  onToggle?: () => void;
  onActivate?: () => void;
  statusVariant?: StatusVariant;
  active?: boolean;
  disabled?: boolean;
  description?: string;
}

export const TreeRow = React.forwardRef<HTMLDivElement, TreeRowProps>(
  (
    {
      className,
      label,
      type = "file",
      depth = 0,
      isOpen,
      onToggle,
      onActivate,
      statusVariant,
      active,
      disabled = false,
      description,
      onClick,
      onKeyDown,
      ...props
    },
    ref,
  ) => {
    const isFolder = type === "folder";
    const isInteractive =
      !disabled &&
      (isFolder ||
        typeof onActivate === "function" ||
        typeof onClick === "function");

    return (
      <div
        ref={ref}
        role="treeitem"
        tabIndex={disabled ? -1 : 0}
        aria-expanded={isFolder ? isOpen : undefined}
        aria-selected={active ?? false}
        aria-disabled={disabled}
        className={cn(
          "group flex items-center h-7 px-2 transition-colors text-sm outline-none focus-visible:ring-1 focus-visible:ring-accent",
          {
            "bg-bg-active text-text hover:bg-bg-active-strong": active,
            "text-text-dim hover:bg-bg-2 hover:text-text": !active,
            "cursor-pointer": isInteractive,
            "cursor-not-allowed opacity-60": disabled,
          },
          className,
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={(event) => {
          if (disabled) {
            event.preventDefault();
            return;
          }
          if (isFolder) {
            onToggle?.();
          }
          onActivate?.();
          onClick?.(event);
        }}
        onKeyDown={(event) => {
          if (disabled) {
            return;
          }

          if (isInteractive && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            if (isFolder) {
              onToggle?.();
            }
            onActivate?.();
          }

          onKeyDown?.(event);
        }}
        {...props}
      >
        <div className="w-4 h-4 flex items-center justify-center shrink-0 mr-1 opacity-80 group-hover:opacity-100">
          {isFolder ? (
            isOpen ? (
              <ChevronDown className="w-3.5 h-3.5" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5" />
            )
          ) : null}
        </div>

        <div className="w-4 h-4 flex items-center justify-center shrink-0 mr-1.5 opacity-80 group-hover:opacity-100">
          {isFolder ? (
            <Folder className="w-3.5 h-3.5" />
          ) : (
            <File className="w-3.5 h-3.5" />
          )}
        </div>

        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate" title={label}>
            {label}
          </span>
          {description ? (
            <span
              className="truncate text-xs text-text-dim"
              title={description}
            >
              {description}
            </span>
          ) : null}
        </span>

        {statusVariant && (
          <div className="ml-2 shrink-0">
            <StatusChip variant={statusVariant} />
          </div>
        )}
      </div>
    );
  },
);

TreeRow.displayName = "TreeRow";

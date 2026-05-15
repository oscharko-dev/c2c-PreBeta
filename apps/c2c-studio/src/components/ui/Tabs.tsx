import React from 'react';
import { cn } from '@/lib/utils';

export interface TabsProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
  onValueChange: (value: string) => void;
  tabs: { value: string; label: React.ReactNode }[];
}

export const Tabs = React.forwardRef<HTMLDivElement, TabsProps>(
  ({ className, value, onValueChange, tabs, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          "flex items-center space-x-1 bg-bg-2 p-1 rounded-md border border-line",
          className
        )}
        {...props}
      >
        {tabs.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => onValueChange(tab.value)}
            className={cn(
              "px-3 py-1 rounded text-sm font-medium transition-colors outline-none focus-visible:ring-1 focus-visible:ring-accent",
              {
                'bg-bg-0 text-text shadow-sm': value === tab.value,
                'text-text-dim hover:text-text hover:bg-bg-3': value !== tab.value,
              }
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
    );
  }
);

Tabs.displayName = 'Tabs';

import React from 'react';
import { cn } from '@/lib/utils';

export interface TabsProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
  onValueChange: (value: string) => void;
  tabs: { value: string; label: React.ReactNode }[];
}

export const Tabs = React.forwardRef<HTMLDivElement, TabsProps>(
  ({ className, value, onValueChange, tabs, ...props }, ref) => {
    const currentIndex = tabs.findIndex((tab) => tab.value === value);

    const move = (delta: number) => {
      if (tabs.length === 0) {
        return;
      }

      const nextIndex = currentIndex === -1 ? 0 : (currentIndex + delta + tabs.length) % tabs.length;
      onValueChange(tabs[nextIndex].value);
    };

    return (
      <div
        ref={ref}
        role="tablist"
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
            role="tab"
            aria-selected={value === tab.value}
            tabIndex={value === tab.value ? 0 : -1}
            onClick={() => onValueChange(tab.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight') {
                event.preventDefault();
                move(1);
              }

              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                move(-1);
              }

              if (event.key === 'Home') {
                event.preventDefault();
                onValueChange(tabs[0].value);
              }

              if (event.key === 'End') {
                event.preventDefault();
                onValueChange(tabs[tabs.length - 1].value);
              }
            }}
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

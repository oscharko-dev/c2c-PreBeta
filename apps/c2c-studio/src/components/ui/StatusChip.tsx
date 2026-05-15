import React from 'react';
import { cn } from '@/lib/utils';
import { StatusVariant } from '@/types/design';

export interface StatusChipProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: StatusVariant | 'default';
  pulse?: boolean;
}

export const StatusChip = React.forwardRef<HTMLDivElement, StatusChipProps>(
  ({ className, variant = 'default', pulse, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          "w-2.5 h-2.5 rounded-full border shadow-sm shrink-0",
          {
            'bg-success border-success/20 shadow-success/20': variant === 'success',
            'bg-warn border-warn/20 shadow-warn/20': variant === 'warning',
            'bg-error border-error/20 shadow-error/20': variant === 'error',
            'bg-teal border-teal/20 shadow-teal/20': variant === 'pending',
            'bg-orange border-orange/20 shadow-orange/20': variant === 'blocked',
            'bg-violet border-violet/20 shadow-violet/20': variant === 'incomplete',
            'bg-bg-3 border-line-2 shadow-black/20': variant === 'neutral' || variant === 'default',
            'animate-pulse': pulse || variant === 'pending',
          },
          className
        )}
        {...props}
      />
    );
  }
);

StatusChip.displayName = 'StatusChip';

import React from 'react';
import { cn } from '@/lib/utils';
import { LucideIcon } from 'lucide-react';

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  active?: boolean;
  variant?: 'default' | 'primary' | 'danger';
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, icon: Icon, active, variant = 'default', ...props }, ref) => {
    return (
      <button
        ref={ref}
        type="button"
        className={cn(
          "w-6 h-6 flex items-center justify-center rounded transition-colors shrink-0 outline-none focus-visible:ring-1 focus-visible:ring-accent",
          {
            'text-text-dim hover:text-text hover:bg-bg-3': variant === 'default' && !active,
            'text-text bg-bg-3': variant === 'default' && active,
            'text-success border border-success/40 bg-bg-2 hover:bg-success-soft': variant === 'primary',
            'text-error border border-error/40 bg-bg-2 hover:bg-error-soft': variant === 'danger',
          },
          className
        )}
        {...props}
      >
        <Icon className="w-4 h-4" />
      </button>
    );
  }
);

IconButton.displayName = 'IconButton';

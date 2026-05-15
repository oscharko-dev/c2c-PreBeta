import React from 'react';
import { cn } from '@/lib/utils';

interface AppLogoProps extends React.HTMLAttributes<HTMLDivElement> {
  compact?: boolean;
}

export function AppLogo({ className, compact = false, ...props }: AppLogoProps) {
  return (
    <div
      className={cn(
        'inline-flex items-center justify-center rounded-md border border-white/10 bg-[linear-gradient(140deg,#2a3454_0%,#5a7af5_70%,#7fc7c1_130%)] font-mono font-semibold text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]',
        compact ? 'h-8 min-w-8 px-2 text-sm' : 'h-9 min-w-9 px-2.5 text-[15px]',
        className
      )}
      aria-hidden="true"
      {...props}
    >
      c2c
    </div>
  );
}

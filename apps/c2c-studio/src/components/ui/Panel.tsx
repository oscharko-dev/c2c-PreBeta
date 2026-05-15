import React from 'react';
import { cn } from '@/lib/utils';

export interface PanelProps extends React.HTMLAttributes<HTMLDivElement> {
  header?: React.ReactNode;
  footer?: React.ReactNode;
  bodyClassName?: string;
}

export const Panel = React.forwardRef<HTMLDivElement, PanelProps>(
  ({ className, header, footer, bodyClassName, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          "flex flex-col bg-bg-1 border border-line rounded-md overflow-hidden",
          className
        )}
        {...props}
      >
        {header && (
          <div className="flex items-center px-3 py-2 border-b border-line bg-bg-2 shrink-0 min-h-[36px]">
            {header}
          </div>
        )}
        <div className={cn('flex-1 overflow-auto bg-bg-0 p-3', bodyClassName)}>
          {children}
        </div>
        {footer && (
          <div className="flex items-center px-3 py-1.5 border-t border-line bg-bg-2 shrink-0">
            {footer}
          </div>
        )}
      </div>
    );
  }
);

Panel.displayName = 'Panel';

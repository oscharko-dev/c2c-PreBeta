import React from 'react';
import { cn } from '@/lib/utils';
import { StatusVariant } from '@/types/design';
import { 
  CheckCircle2, 
  AlertCircle, 
  XCircle, 
  Clock, 
  MinusCircle, 
  HelpCircle,
  Loader2
} from 'lucide-react';

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement> {
  variant?: StatusVariant | 'default';
  icon?: boolean;
}

export const getVariantIcon = (variant: StatusVariant | 'default', className?: string) => {
  const props = { className: cn("w-3.5 h-3.5", className) };
  switch (variant) {
    case 'success': return <CheckCircle2 {...props} />;
    case 'warning': return <AlertCircle {...props} />;
    case 'error': return <XCircle {...props} />;
    case 'pending': return <Loader2 {...props} className={cn(props.className, "animate-spin")} />;
    case 'blocked': return <MinusCircle {...props} />;
    case 'incomplete': return <Clock {...props} />;
    case 'neutral': 
    case 'default':
    default:
      return <HelpCircle {...props} />;
  }
};

export const Badge = React.forwardRef<HTMLDivElement, BadgeProps>(
  ({ className, variant = 'default', icon = true, children, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={cn(
          "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs font-medium border transition-colors",
          {
            'bg-success-soft text-success border-success/20': variant === 'success',
            'bg-warn-soft text-warn border-warn/20': variant === 'warning',
            'bg-error-soft text-error border-error/20': variant === 'error',
            'bg-teal-soft text-teal border-teal/20': variant === 'pending',
            'bg-orange-soft text-orange border-orange/20': variant === 'blocked',
            'bg-violet-soft text-violet border-violet/20': variant === 'incomplete',
            'bg-bg-2 text-text-dim border-line': variant === 'neutral' || variant === 'default',
          },
          className
        )}
        {...props}
      >
        {icon && getVariantIcon(variant)}
        <span>{children}</span>
      </div>
    );
  }
);

Badge.displayName = 'Badge';

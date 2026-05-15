import React from 'react';
import { cn } from '@/lib/utils';

interface TruncateProps extends React.HTMLAttributes<HTMLSpanElement> {
  text: string;
  position?: 'end' | 'middle';
  maxLength?: number;
}

export const Truncate = React.forwardRef<HTMLSpanElement, TruncateProps>(
  ({ text, position = 'end', maxLength, className, ...props }, ref) => {
    let displayText = text;

    if (maxLength && text.length > maxLength) {
      if (position === 'middle') {
        const startChars = Math.ceil(maxLength / 2);
        const endChars = Math.floor(maxLength / 2);
        displayText = `${text.substring(0, startChars)}...${text.substring(text.length - endChars)}`;
      } else {
        displayText = `${text.substring(0, maxLength)}...`;
      }
    }

    return (
      <span
        ref={ref}
        title={text}
        className={cn(
          "inline-block max-w-full overflow-hidden text-ellipsis whitespace-nowrap align-bottom",
          className
        )}
        {...props}
      >
        {displayText}
      </span>
    );
  }
);

Truncate.displayName = 'Truncate';

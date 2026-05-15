import React from 'react';
import { cn } from '@/lib/utils';
import { ChevronRight, ChevronDown, File, Folder } from 'lucide-react';
import { StatusChip } from './StatusChip';
import { StatusVariant } from '@/types/design';

export interface TreeRowProps extends React.HTMLAttributes<HTMLDivElement> {
  label: string;
  type?: 'file' | 'folder';
  depth?: number;
  isOpen?: boolean;
  onToggle?: () => void;
  statusVariant?: StatusVariant;
  active?: boolean;
}

export const TreeRow = React.forwardRef<HTMLDivElement, TreeRowProps>(
  (
    { 
      className, 
      label, 
      type = 'file', 
      depth = 0, 
      isOpen, 
      onToggle, 
      statusVariant,
      active,
      ...props 
    }, 
    ref
  ) => {
    return (
      <div
        ref={ref}
        className={cn(
          "group flex items-center h-7 px-2 cursor-pointer transition-colors text-sm",
          {
            'bg-bg-active text-text hover:bg-bg-active-strong': active,
            'text-text-dim hover:bg-bg-2 hover:text-text': !active,
          },
          className
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={type === 'folder' ? onToggle : undefined}
        {...props}
      >
        <div className="w-4 h-4 flex items-center justify-center shrink-0 mr-1 opacity-80 group-hover:opacity-100">
          {type === 'folder' ? (
            isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />
          ) : null}
        </div>
        
        <div className="w-4 h-4 flex items-center justify-center shrink-0 mr-1.5 opacity-80 group-hover:opacity-100">
          {type === 'folder' ? (
            <Folder className="w-3.5 h-3.5" />
          ) : (
            <File className="w-3.5 h-3.5" />
          )}
        </div>
        
        <span className="truncate flex-1">{label}</span>
        
        {statusVariant && (
          <div className="ml-2 shrink-0">
            <StatusChip variant={statusVariant} />
          </div>
        )}
      </div>
    );
  }
);

TreeRow.displayName = 'TreeRow';

import React, { useState } from 'react';
import { FileTreeNode } from '../../types/generated';
import { ChevronRight, ChevronDown, File, Folder } from 'lucide-react';

interface GeneratedProjectTreeProps {
  tree: FileTreeNode[];
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  unavailableFiles: Set<string>;
}

export function GeneratedProjectTree({ tree, selectedPath, onSelectFile, unavailableFiles }: GeneratedProjectTreeProps) {
  if (!tree || tree.length === 0) {
    return <div className="p-4 text-sm text-text-dim">No files available</div>;
  }

  return (
    <div className="w-full overflow-y-auto">
      {tree.map(node => (
        <TreeNode 
          key={node.path} 
          node={node} 
          selectedPath={selectedPath} 
          onSelectFile={onSelectFile} 
          unavailableFiles={unavailableFiles}
        />
      ))}
    </div>
  );
}

function TreeNode({ node, selectedPath, onSelectFile, unavailableFiles }: { 
  node: FileTreeNode, 
  selectedPath: string | null, 
  onSelectFile: (path: string) => void,
  unavailableFiles: Set<string>
}) {
  const [isOpen, setIsOpen] = useState(true);
  const isFile = node.type === 'file';
  const isSelected = selectedPath === node.path;
  const isUnavailable = isFile && unavailableFiles.has(node.path);

  const toggleOpen = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isFile) setIsOpen(!isOpen);
  };

  const handleSelect = () => {
    if (isFile && !isUnavailable) {
      onSelectFile(node.path);
    } else if (!isFile) {
      setIsOpen(!isOpen);
    }
  };

  return (
    <div className="text-sm">
      <div 
        className={`flex items-center gap-1.5 py-1 px-2 cursor-pointer hover:bg-bg-3 ${isSelected ? 'bg-accent/10 text-accent' : 'text-text'} ${isUnavailable ? 'opacity-50 cursor-not-allowed' : ''}`}
        onClick={handleSelect}
        style={{ paddingLeft: `${node.path.split('/').length * 0.75}rem` }}
      >
        {!isFile ? (
          <span onClick={toggleOpen} className="text-text-dim">
            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        ) : (
          <span className="w-[14px]"></span>
        )}
        {isFile ? <File size={14} className="text-text-dim" /> : <Folder size={14} className="text-text-dim" />}
        <span className="truncate">{node.name}</span>
        {isUnavailable && <span className="ml-2 text-[10px] text-error">Unavailable</span>}
      </div>
      
      {!isFile && isOpen && node.children && (
        <div>
          {node.children.map(child => (
            <TreeNode 
              key={child.path} 
              node={child} 
              selectedPath={selectedPath} 
              onSelectFile={onSelectFile} 
              unavailableFiles={unavailableFiles}
            />
          ))}
        </div>
      )}
    </div>
  );
}

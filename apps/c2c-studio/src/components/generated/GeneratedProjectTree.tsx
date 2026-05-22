import React, { useEffect, useRef, useState } from "react";
import { FileTreeNode } from "../../types/generated";
import { ChevronRight, ChevronDown, File, Folder } from "lucide-react";

interface GeneratedProjectTreeProps {
  tree: FileTreeNode[];
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  unavailableFiles: Set<string>;
}

type TreeNodeProps = {
  node: FileTreeNode;
  selectedPath: string | null;
  onSelectFile: (path: string) => void;
  unavailableFiles: Set<string>;
  treeRef: React.RefObject<HTMLDivElement | null>;
  focusedPath: string | null;
  setFocusedPath: (path: string) => void;
};

export function GeneratedProjectTree({
  tree,
  selectedPath,
  onSelectFile,
  unavailableFiles,
}: GeneratedProjectTreeProps) {
  const treeRef = useRef<HTMLDivElement>(null);
  const [focusedPath, setFocusedPath] = useState<string | null>(
    selectedPath ?? tree[0]?.path ?? null,
  );

  useEffect(() => {
    const hasVisibleTreeItem = (path: string | null) => {
      if (!path) {
        return false;
      }

      return Boolean(treeRef.current?.querySelector(`[data-path="${path}"]`));
    };

    if (hasVisibleTreeItem(focusedPath)) {
      return;
    }

    if (hasVisibleTreeItem(selectedPath)) {
      setFocusedPath(selectedPath);
      return;
    }

    if (tree[0]?.path) {
      setFocusedPath(tree[0].path);
    }
  }, [focusedPath, selectedPath, tree]);

  if (!tree || tree.length === 0) {
    return <div className="p-4 text-sm text-text-dim">No files available</div>;
  }

  return (
    <div
      ref={treeRef}
      className="w-full overflow-y-auto"
      role="tree"
      aria-label="Generated project files"
    >
      {tree.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          selectedPath={selectedPath}
          onSelectFile={onSelectFile}
          unavailableFiles={unavailableFiles}
          treeRef={treeRef}
          focusedPath={focusedPath}
          setFocusedPath={setFocusedPath}
        />
      ))}
    </div>
  );
}

function TreeNode({
  node,
  selectedPath,
  onSelectFile,
  unavailableFiles,
  treeRef,
  focusedPath,
  setFocusedPath,
}: TreeNodeProps) {
  const [isOpen, setIsOpen] = useState(true);
  const isFile = node.type === "file";
  const isSelected = selectedPath === node.path;
  const isUnavailable = isFile && unavailableFiles.has(node.path);
  const isTabbable = focusedPath === node.path;

  const focusTreeItem = (treeItem: HTMLElement | null) => {
    if (!treeItem) {
      return;
    }

    const path = treeItem.getAttribute("data-path");
    if (path) {
      setFocusedPath(path);
    }
    treeItem.focus();
  };

  const getVisibleTreeItems = () =>
    Array.from(
      treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [],
    );

  const getParentTreeItem = (treeItem: HTMLElement) => {
    const group = treeItem.closest('[role="group"]');
    const parentWrapper = group?.parentElement;
    const parentTreeItem = parentWrapper?.firstElementChild;

    return parentTreeItem instanceof HTMLElement &&
      parentTreeItem.getAttribute("role") === "treeitem"
      ? parentTreeItem
      : null;
  };

  const getFirstChildTreeItem = (treeItem: HTMLElement) => {
    const group = treeItem.nextElementSibling;
    if (!group) {
      return null;
    }

    return group.querySelector<HTMLElement>('[role="treeitem"]');
  };

  const handleSelect = () => {
    setFocusedPath(node.path);

    if (isFile && !isUnavailable) {
      onSelectFile(node.path);
    } else if (!isFile) {
      setIsOpen((open) => !open);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    switch (event.key) {
      case "Enter":
      case " ": {
        event.preventDefault();
        handleSelect();
        return;
      }
      case "ArrowDown":
      case "ArrowUp":
      case "Home":
      case "End": {
        event.preventDefault();
        const treeItems = getVisibleTreeItems();
        const currentIndex = treeItems.indexOf(event.currentTarget);

        if (currentIndex === -1) {
          return;
        }

        const nextItem =
          event.key === "ArrowDown"
            ? treeItems[Math.min(currentIndex + 1, treeItems.length - 1)]
            : event.key === "ArrowUp"
              ? treeItems[Math.max(currentIndex - 1, 0)]
              : event.key === "Home"
                ? treeItems[0]
                : treeItems[treeItems.length - 1];

        focusTreeItem(nextItem ?? null);
        return;
      }
      case "ArrowRight": {
        event.preventDefault();
        if (isFile) {
          return;
        }

        if (!isOpen) {
          setIsOpen(true);
          return;
        }

        focusTreeItem(getFirstChildTreeItem(event.currentTarget));
        return;
      }
      case "ArrowLeft": {
        event.preventDefault();
        if (!isFile && isOpen) {
          setIsOpen(false);
          setFocusedPath(node.path);
          return;
        }

        focusTreeItem(getParentTreeItem(event.currentTarget));
        return;
      }
      default:
        return;
    }
  };

  const toggleOpen = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!isFile) {
      setFocusedPath(node.path);
      setIsOpen((open) => !open);
    }
  };

  return (
    <div className="text-sm" role="none">
      <button
        type="button"
        className={`flex w-full items-center gap-1.5 py-1 px-2 text-left hover:bg-bg-3 ${isSelected ? "bg-accent/10 text-accent" : "text-text"} ${isUnavailable ? "opacity-50 cursor-not-allowed" : ""}`}
        onClick={handleSelect}
        onFocus={() => setFocusedPath(node.path)}
        onKeyDown={handleKeyDown}
        aria-disabled={isUnavailable || undefined}
        aria-expanded={!isFile ? isOpen : undefined}
        aria-selected={isSelected}
        data-path={node.path}
        role="treeitem"
        tabIndex={isTabbable ? 0 : -1}
        style={{ paddingLeft: `${node.path.split("/").length * 0.75}rem` }}
      >
        {!isFile ? (
          <span
            onClick={toggleOpen}
            className="text-text-dim"
            aria-hidden="true"
          >
            {isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </span>
        ) : (
          <span className="w-[14px]"></span>
        )}
        {isFile ? (
          <File size={14} className="text-text-dim" />
        ) : (
          <Folder size={14} className="text-text-dim" />
        )}
        <span className="truncate">{node.name}</span>
        {isUnavailable && (
          <span className="ml-2 text-[10px] text-error">Unavailable</span>
        )}
      </button>

      {!isFile && isOpen && node.children && (
        <div role="group">
          {node.children.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              selectedPath={selectedPath}
              onSelectFile={onSelectFile}
              unavailableFiles={unavailableFiles}
              treeRef={treeRef}
              focusedPath={focusedPath}
              setFocusedPath={setFocusedPath}
            />
          ))}
        </div>
      )}
    </div>
  );
}

import { useEffect } from "react";

interface UseKeyboardShortcutsOptions {
  onStartTransform?: () => void;
  canStartTransform?: boolean;
}

export function useKeyboardShortcuts({
  onStartTransform,
  canStartTransform,
}: UseKeyboardShortcutsOptions) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore keydowns if user is typing in an input or textarea
      if (
        document.activeElement?.tagName === "INPUT" ||
        document.activeElement?.tagName === "TEXTAREA" ||
        (document.activeElement as HTMLElement)?.isContentEditable
      ) {
        return;
      }

      // Start Transformation shortcut: Cmd/Ctrl + Enter or Alt + R
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        if (canStartTransform && onStartTransform) {
          onStartTransform();
        }
        return;
      }

      if (e.altKey && e.key.toLowerCase() === "r") {
        e.preventDefault();
        if (canStartTransform && onStartTransform) {
          onStartTransform();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onStartTransform, canStartTransform]);
}

"use client";

import { useEffect } from "react";

import { useMarkerNavigation } from "../lib/editor/markerNavigation";
import { useWorkbench } from "../stores/workbench";

// Studio-IDE-5 (#244): wire F8 / Shift+F8 to next/previous marker on
// the active editor. The hook lives at the workbench level so the
// shortcut is consistent across the COBOL and generated-Java panes.
//
// When the Problems panel is collapsed the user expects F8 to still
// work — so we don't gate the shortcut on the panel being open. We do
// gate it on focus targets that consume the key themselves (inputs,
// textareas, and elements with `contenteditable`) so users typing
// don't lose keystrokes to navigation.
export function useMarkerNavigationShortcuts(): void {
  const { cycleMarker } = useMarkerNavigation();
  const { setActiveBottomTab, setBottomPanelOpen } = useWorkbench();

  useEffect(() => {
    function shouldSkip(event: KeyboardEvent): boolean {
      const target = event.target as HTMLElement | null;
      if (!target) return false;
      if (target.isContentEditable) {
        // Monaco editors are contenteditable. We DO want F8 to work
        // there, but we want to skip plain <textarea> and <input>.
        // Heuristic: Monaco wraps its editable area in `.monaco-editor`.
        return !target.closest(".monaco-editor");
      }
      const tag = target.tagName;
      return tag === "INPUT" || tag === "TEXTAREA";
    }

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key !== "F8") return;
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      if (shouldSkip(event)) return;
      event.preventDefault();
      cycleMarker(event.shiftKey ? "previous" : "next");
      // Surface the Problems panel so the user can see the marker
      // they jumped to — but only if it is currently collapsed.
      setBottomPanelOpen(true);
      setActiveBottomTab("problems");
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [cycleMarker, setActiveBottomTab, setBottomPanelOpen]);
}

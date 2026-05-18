"use client";

/**
 * Studio-IDE-3 (#247): three-way conflict resolver used for both COBOL and
 * Java drafts. The dialog opens when the user opens a sample (COBOL) or a
 * generated file (Java) where a non-expired local draft disagrees with the
 * backend content. The user picks one of three sources to keep.
 *
 * The component is presentation-only: state lives in the consuming store
 * (sourceWorkspace for COBOL, transformationRun for Java) and the caller
 * passes the three candidate panels and a callback.
 */

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export type ConflictChoice = "backendSample" | "localDraft" | "lastRunInput";

export interface ConflictPanel {
  id: ConflictChoice;
  title: string;
  description: string;
  content: string;
}

export interface ConflictResolverDialogProps {
  kind: "cobol" | "java";
  filePath?: string;
  panels: ConflictPanel[];
  onChoose: (choice: ConflictChoice) => void;
  onDismiss: () => void;
}

export function ConflictResolverDialog({
  kind,
  filePath,
  panels,
  onChoose,
  onDismiss,
}: ConflictResolverDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onDismiss();
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onDismiss]);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const title =
    kind === "cobol"
      ? "COBOL draft conflict"
      : `Java draft conflict${filePath ? ` — ${filePath}` : ""}`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="conflict-resolver-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg-0/80 p-6"
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="flex max-h-[90vh] w-full max-w-6xl flex-col gap-4 rounded-lg border border-line-2 bg-bg-1 p-6 outline-none focus:ring-2 focus:ring-accent"
      >
        <header className="flex items-start justify-between gap-4">
          <div>
            <h2
              id="conflict-resolver-title"
              className="text-base font-semibold text-text"
            >
              {title}
            </h2>
            <p className="mt-1 text-xs text-text-dim">
              A local draft was found for this file, and the version supplied by
              the backend differs. Choose which content to keep. Your decision
              applies immediately; the other versions are discarded.
            </p>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded border border-line-2 px-3 py-1 text-xs text-text-dim hover:text-text"
          >
            Cancel
          </button>
        </header>

        <div className="grid flex-1 grid-cols-1 gap-3 overflow-hidden lg:grid-cols-3">
          {panels.map((panel) => (
            <ConflictPanelCard
              key={panel.id}
              panel={panel}
              onChoose={onChoose}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function ConflictPanelCard({
  panel,
  onChoose,
}: {
  panel: ConflictPanel;
  onChoose: (choice: ConflictChoice) => void;
}) {
  return (
    <div className="flex min-h-0 flex-col gap-2 rounded border border-line-2 bg-bg-0 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-text">{panel.title}</div>
          <div className="text-[11px] text-text-dim">{panel.description}</div>
        </div>
        <button
          type="button"
          onClick={() => onChoose(panel.id)}
          className={cn(
            "rounded bg-accent px-3 py-1 text-xs font-medium text-bg-0",
            "hover:bg-accent-dim",
          )}
          aria-label={`Keep ${panel.title}`}
        >
          Keep this
        </button>
      </div>
      <pre className="flex-1 min-h-0 overflow-auto whitespace-pre-wrap break-words rounded bg-bg-2 p-2 font-mono text-xs text-text">
        {panel.content || "(empty)"}
      </pre>
    </div>
  );
}

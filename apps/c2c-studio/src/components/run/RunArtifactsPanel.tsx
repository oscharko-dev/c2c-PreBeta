"use client";

import { useEffect, useId, useState } from "react";
import type { KeyboardEvent } from "react";

import { RunArtifactMetadata } from "../../types/artifacts";
import { cn } from "../../lib/utils";
import { copyToClipboard, useCopyFeedback } from "../ui/copyFeedback";

export function RunArtifactsPanel({
  artifacts,
  errorMessage,
  missingArtifacts,
}: {
  artifacts: RunArtifactMetadata[] | null | undefined;
  errorMessage?: string | null;
  missingArtifacts?: string[];
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const artifactIdBase = useId();
  const hasMissingArtifacts = Boolean(missingArtifacts && missingArtifacts.length > 0);

  useEffect(() => {
    if (!artifacts || artifacts.length === 0) {
      setSelectedIndex(0);
      return;
    }

    setSelectedIndex((current) => Math.min(current, artifacts.length - 1));
  }, [artifacts]);

  if (!artifacts || artifacts.length === 0) {
    return (
      <div className="p-4 space-y-3 text-sm">
        {errorMessage ? (
          <div className="rounded border border-line-2 bg-bg-1 p-3">
            <p className="text-xs font-medium text-error">Artifacts fetch failed</p>
            <p className="mt-1 text-xs text-text-dim">{errorMessage}</p>
          </div>
        ) : null}
        {hasMissingArtifacts ? (
          <MissingArtifactRecords artifacts={missingArtifacts!} />
        ) : null}
        <div className="text-text-dim">No run artifacts available.</div>
      </div>
    );
  }

  const selectedArtifact = artifacts[selectedIndex] ?? artifacts[0];

  const moveSelection = (nextIndex: number) => {
    const normalizedIndex = (nextIndex + artifacts.length) % artifacts.length;
    setSelectedIndex(normalizedIndex);
    queueMicrotask(() => {
      document
        .getElementById(`${artifactIdBase}-option-${normalizedIndex}`)
        ?.focus();
    });
  };

  const handleItemKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      event.preventDefault();
      moveSelection(index + 1);
    }

    if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      event.preventDefault();
      moveSelection(index - 1);
    }

    if (event.key === "Home") {
      event.preventDefault();
      moveSelection(0);
    }

    if (event.key === "End") {
      event.preventDefault();
      moveSelection(artifacts.length - 1);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="sticky top-0 border-b border-line-2 bg-bg-2 px-4 py-2 font-medium text-text">
        Run Artifacts
      </div>

      <div className="flex-1 overflow-hidden p-4">
        {errorMessage ? (
          <div className="mb-4 rounded border border-line-2 bg-bg-1 p-3">
            <p className="text-xs font-medium text-error">Artifacts fetch failed</p>
            <p className="mt-1 text-xs text-text-dim">{errorMessage}</p>
          </div>
        ) : null}

        {hasMissingArtifacts ? (
          <MissingArtifactRecords
            artifacts={missingArtifacts!}
            className="mb-4"
          />
        ) : null}

        <div className="grid min-h-0 gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="min-h-0 rounded border border-line-2 bg-bg-0">
            <div className="border-b border-line-2 px-3 py-2 text-xs font-semibold uppercase tracking-wider text-text-dim">
              Artifact List
            </div>
            <div
              role="listbox"
              aria-label="Run artifacts"
              className="max-h-[14rem] overflow-auto p-2"
            >
              {artifacts.map((artifact, index) => {
                const isSelected = selectedIndex === index;
                return (
                  <button
                    key={`${artifact.sha256}-${artifact.path}-${index}`}
                    id={`${artifactIdBase}-option-${index}`}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    tabIndex={isSelected ? 0 : -1}
                    onClick={() => setSelectedIndex(index)}
                    onKeyDown={(event) => handleItemKeyDown(event, index)}
                    className={cn(
                      "mb-2 w-full rounded border px-3 py-3 text-left transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent",
                      isSelected
                        ? "border-accent bg-bg-1"
                        : "border-line bg-bg-0 hover:border-line-2 hover:bg-bg-1",
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate font-medium text-text">
                          {artifact.path || artifact.name}
                        </p>
                        <p className="mt-1 truncate font-mono text-[11px] text-text-dim">
                          {artifact.kind} · {artifact.byteSize} bytes
                        </p>
                      </div>
                      <span className="shrink-0 rounded bg-bg-2 px-2 py-0.5 font-mono text-[10px] text-text-dim">
                        {artifact.sha256.slice(0, 12)}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="min-h-0 rounded border border-line-2 bg-bg-0 p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-text-dim">
                  Selected artifact
                </p>
                <h3 className="mt-1 truncate text-base font-medium text-text">
                  {selectedArtifact.path || selectedArtifact.name}
                </h3>
                <p className="mt-1 text-xs text-text-dim">
                  {selectedArtifact.kind} · {selectedArtifact.byteSize} bytes ·{" "}
                  {selectedArtifact.mimeType ?? "Unknown MIME type"}
                </p>
              </div>
              <ArtifactStatusPill label={selectedArtifact.createdBy} />
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <ArtifactValueRow label="SHA256" value={selectedArtifact.sha256} />
              <ArtifactValueRow label="Path" value={selectedArtifact.path} />
              <ArtifactValueRow label="Name" value={selectedArtifact.name} />
              <ArtifactValueRow label="Kind" value={selectedArtifact.kind} />
              <ArtifactValueRow
                label="Created at"
                value={selectedArtifact.createdAt}
              />
              <ArtifactValueRow
                label="Created by"
                value={selectedArtifact.createdBy}
              />
              {selectedArtifact.mimeType ? (
                <ArtifactValueRow
                  label="MIME type"
                  value={selectedArtifact.mimeType}
                />
              ) : null}
            </div>

            <div className="mt-4 rounded border border-line bg-bg-1 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-text-dim">
                Inspection summary
              </p>
              <p className="mt-2 text-sm text-text-dim">
                Use the artifact list to move between run evidence records. The
                selected row is fully keyboard navigable and exposes the raw
                content-addressed fields for copy or comparison.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ArtifactValueRow({
  label,
  value,
}: {
  label: string;
  value: string | undefined;
}) {
  const { copied, showCopied } = useCopyFeedback();

  if (!value) {
    return (
      <div className="rounded border border-line bg-bg-1 p-3">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-text-dim">
          {label}
        </p>
        <p className="mt-1 text-xs text-text-dim">Unavailable</p>
      </div>
    );
  }

  return (
    <div className="rounded border border-line bg-bg-1 p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-text-dim">
          {label}
        </p>
        <button
          type="button"
          onClick={() => {
            void copyToClipboard(value).then((ok) => {
              if (ok) {
                showCopied();
              }
            });
          }}
          className="rounded border border-line bg-bg-0 px-2 py-1 text-[10px] font-medium text-text-dim hover:border-accent hover:text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="mt-2 break-all font-mono text-xs text-text">{value}</p>
    </div>
  );
}

function ArtifactStatusPill({ label }: { label: string }) {
  return (
    <span className="rounded-full border border-line bg-bg-1 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-text-dim">
      {label || "Unknown creator"}
    </span>
  );
}

function MissingArtifactRecords({
  artifacts,
  className,
}: {
  artifacts: string[];
  className?: string;
}) {
  return (
    <div className={`rounded border border-line-2 bg-bg-1 p-3 ${className ?? ""}`.trim()}>
      <p className="text-xs font-medium text-warn">Missing artifact records</p>
      <ul className="mt-2 list-disc space-y-1 pl-4 text-xs font-mono text-text">
        {artifacts.map((artifact) => (
          <li key={artifact}>{artifact}</li>
        ))}
      </ul>
    </div>
  );
}

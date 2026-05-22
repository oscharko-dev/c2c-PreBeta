"use client";

import { useId, useMemo, useState } from "react";

import { BuildTestView } from "../../types/build-test";
import { CodeSurface } from "../ui/CodeSurface";
import { copyToClipboard, useCopyFeedback } from "../ui/copyFeedback";
import { StatusChip } from "../ui/StatusChip";
import { Tabs } from "../ui/Tabs";
import type { BuildTestMetadataItem } from "./runPanelUtils";
import {
  buildOutputDiff,
  describeBuildTestMode,
  describeBuildTestProductMode,
  describeBuildTestResult,
  getBuildTestArtifactRefs,
  getBuildTestMetadataItems,
  getBuildTestReferenceSummary,
  splitOutputLines,
} from "./runPanelUtils";

type OutputTab = "split" | "diff";

export function EquivalencePanel({
  buildTest,
  isPending,
  view,
  intentionalDivergence = false,
}: {
  buildTest: BuildTestView | null;
  isPending: boolean;
  view?: OutputTab | "outputs";
  intentionalDivergence?: boolean;
}) {
  const tabIdBase = useId();
  const [activeTab, setActiveTab] = useState<OutputTab>("split");
  const result = useMemo(
    () => describeBuildTestResult(buildTest, intentionalDivergence),
    [buildTest, intentionalDivergence],
  );
  const isControlled = view !== undefined;
  const resolvedTab: OutputTab =
    view === "diff" ? "diff" : view === "outputs" ? "split" : activeTab;

  if (isPending || !buildTest) {
    return (
      <div className="text-sm text-text-dim">
        Waiting for build/test equivalence results...
      </div>
    );
  }

  const expectedOutputDefined = buildTest.expectedOutput !== undefined;
  const actualOutputDefined = buildTest.actualOutput !== undefined;
  const hasOutputs = expectedOutputDefined || actualOutputDefined;
  const expectedLines = splitOutputLines(buildTest.expectedOutput);
  const actualLines = splitOutputLines(buildTest.actualOutput);
  const diffLines = buildOutputDiff(
    buildTest.expectedOutput,
    buildTest.actualOutput,
  );
  const metadataItems = getBuildTestMetadataItems(buildTest);
  const artifactRefs = getBuildTestArtifactRefs(buildTest);

  if (isControlled) {
    return (
      <div className="h-full min-h-0">
        {renderOutputBody({
          activeTab: resolvedTab,
          showTabs: false,
          tabIdBase,
          setActiveTab,
          buildTest,
          expectedLines,
          actualLines,
          diffLines,
          hasOutputs,
        })}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <section className="rounded border border-line-2 bg-bg-1 p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="inline-flex items-center gap-2 rounded-full border border-line bg-bg-0 px-3 py-1 text-xs font-semibold text-text">
              <StatusChip variant={result.tone} />
              <span>{result.label}</span>
            </div>
            <p className="mt-2 max-w-3xl text-sm text-text-dim">
              {result.detail}
            </p>
          </div>
          <div className="grid gap-2 text-xs text-text-dim sm:grid-cols-2">
            <MetaPair label="Classification" value={buildTest.classification} />
            <MetaPair label="Pipeline status" value={buildTest.status} />
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-3">
          {metadataItems.map((item) => (
            <MetadataCard key={item.label} item={item} />
          ))}
        </div>

        <div className="mt-4 rounded border border-line bg-bg-0 p-3">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-text-dim">
            Artifact refs
          </div>
          {artifactRefs.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {artifactRefs.map((entry) => (
                <ArtifactRefPill
                  key={`${entry.label}:${entry.ref?.sha256}`}
                  label={entry.label}
                  refValue={entry.ref}
                />
              ))}
            </div>
          ) : (
            <div className="text-sm text-text-dim">
              No artifact references available.
            </div>
          )}
        </div>

        <div className="mt-4 grid gap-3 text-xs text-text-dim sm:grid-cols-2">
          <MetaPair
            label="Execution mode"
            value={describeBuildTestMode(buildTest)}
          />
          <MetaPair
            label="Product mode"
            value={describeBuildTestProductMode(buildTest)}
          />
        </div>
      </section>

      {intentionalDivergence ? (
        <section className="rounded border border-warn/20 bg-warn-soft px-4 py-3 text-xs text-warn">
          This comparison was intentionally documented as not equivalent. Review
          the governed divergence decision before treating the result as a
          product regression.
        </section>
      ) : null}

      <section className="flex min-h-0 flex-1 flex-col rounded border border-line-2 bg-bg-0">
        {renderOutputBody({
          activeTab,
          showTabs: true,
          tabIdBase,
          setActiveTab,
          buildTest,
          expectedLines,
          actualLines,
          diffLines,
          hasOutputs,
        })}
      </section>
    </div>
  );
}

function renderOutputBody({
  activeTab,
  showTabs,
  tabIdBase,
  setActiveTab,
  buildTest,
  expectedLines,
  actualLines,
  diffLines,
  hasOutputs,
}: {
  activeTab: OutputTab;
  showTabs: boolean;
  tabIdBase: string;
  setActiveTab: (value: OutputTab) => void;
  buildTest: BuildTestView;
  expectedLines: string[];
  actualLines: string[];
  diffLines: ReturnType<typeof buildOutputDiff>;
  hasOutputs: boolean;
}) {
  return (
    <>
      {showTabs ? (
        <div className="border-b border-line-2 px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h4 className="text-sm font-medium text-text">
                Expected vs actual output
              </h4>
              <p className="text-xs text-text-dim">
                Compare the oracle output against the Java execution output.
              </p>
            </div>
            <Tabs
              idBase={tabIdBase}
              value={activeTab}
              onValueChange={(value) => setActiveTab(value as OutputTab)}
              tabs={[
                { value: "split", label: "Split view" },
                { value: "diff", label: "Diff view" },
              ]}
            />
          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 p-4">
        {activeTab === "split" ? (
          hasOutputs ? (
            <div className="grid min-h-0 gap-4 xl:grid-cols-2">
              <div className="flex min-h-0 flex-col">
                <SurfaceHeading
                  title="COBOL Oracle"
                  subtitle="Expected output"
                  refSummary={buildTest.expectedOutputRef}
                />
                <CodeSurface
                  className="min-h-0 flex-1 rounded border border-line-2"
                  label="Expected output"
                  copyValue={buildTest.expectedOutput ?? ""}
                  copyLabel="Copy expected"
                  emptyMessage="No expected output captured."
                  lines={expectedLines.map((line) => ({ content: line }))}
                />
              </div>
              <div className="flex min-h-0 flex-col">
                <SurfaceHeading
                  title="Java execution"
                  subtitle="Actual output"
                  refSummary={buildTest.actualOutputRef}
                />
                <CodeSurface
                  className="min-h-0 flex-1 rounded border border-line-2"
                  label="Actual output"
                  copyValue={buildTest.actualOutput ?? ""}
                  copyLabel="Copy actual"
                  emptyMessage="No actual output captured."
                  lines={actualLines.map((line) => ({ content: line }))}
                />
              </div>
            </div>
          ) : (
            <div className="rounded border border-dashed border-line-2 bg-bg-1 p-4 text-sm text-text-dim">
              Output values are not available for this run.
            </div>
          )
        ) : hasOutputs ? (
          <CodeSurface
            className="h-full min-h-0 rounded border border-line-2"
            label="Unified diff"
            emptyMessage="No diff available."
            lines={diffLines.map((line) => ({
              content: (
                <DiffLineRow
                  kind={line.kind}
                  content={line.content}
                  expectedLineNumber={line.expectedLineNumber}
                  actualLineNumber={line.actualLineNumber}
                />
              ),
              tone:
                line.kind === "added"
                  ? "success"
                  : line.kind === "removed"
                    ? "error"
                    : "neutral",
            }))}
          />
        ) : (
          <div className="rounded border border-dashed border-line-2 bg-bg-1 p-4 text-sm text-text-dim">
            No output values are available to diff.
          </div>
        )}
      </div>
    </>
  );
}

function MetaPair({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-line bg-bg-0 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-text-faint">
        {label}
      </div>
      <div className="mt-1 break-words font-mono text-[11px] text-text">
        {value}
      </div>
    </div>
  );
}

function MetadataCard({ item }: { item: BuildTestMetadataItem }) {
  return (
    <div className="rounded border border-line bg-bg-0 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-text-faint">
        {item.label}
      </div>
      <div className="mt-1 flex items-start gap-2">
        <div className="min-w-0 break-words font-mono text-[11px] text-text">
          {item.value}
        </div>
        {item.copyValue ? (
          <CopyButton
            label={`Copy ${item.label.toLowerCase()}`}
            value={item.copyValue}
          />
        ) : null}
      </div>
    </div>
  );
}

function SurfaceHeading({
  title,
  subtitle,
  refSummary,
}: {
  title: string;
  subtitle: string;
  refSummary?: BuildTestView["expectedOutputRef"];
}) {
  return (
    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
      <div>
        <div className="text-xs font-semibold uppercase tracking-wider text-text-dim">
          {title}
        </div>
        <div className="text-[11px] text-text-dim">{subtitle}</div>
      </div>
      {refSummary ? (
        <div className="rounded border border-line bg-bg-1 px-2 py-1 font-mono text-[10px] text-text-dim">
          {getBuildTestReferenceSummary(refSummary)}
        </div>
      ) : null}
    </div>
  );
}

function ArtifactRefPill({
  label,
  refValue,
}: {
  label: string;
  refValue: BuildTestView["expectedOutputRef"];
}) {
  if (!refValue) {
    return null;
  }

  return (
    <div className="inline-flex max-w-full items-center gap-2 rounded border border-line-2 bg-bg-1 px-2 py-1 text-xs">
      <span className="font-semibold text-text-dim">{label}</span>
      <span className="max-w-[20rem] truncate font-mono text-text">
        {getBuildTestReferenceSummary(refValue)}
      </span>
      <CopyButton
        label={`Copy ${label.toLowerCase()}`}
        value={refValue.sha256}
        compact
      />
    </div>
  );
}

function DiffLineRow({
  kind,
  content,
  expectedLineNumber,
  actualLineNumber,
}: {
  kind: "equal" | "added" | "removed";
  content: string;
  expectedLineNumber?: number;
  actualLineNumber?: number;
}) {
  const marker = kind === "added" ? "+" : kind === "removed" ? "-" : " ";
  const toneClass =
    kind === "added"
      ? "border-success/30 bg-success/10 text-success"
      : kind === "removed"
        ? "border-error/30 bg-error/10 text-error"
        : "border-transparent text-text";

  return (
    <div className="flex min-w-0 items-start gap-2 whitespace-pre">
      <span className="w-14 shrink-0 text-right text-text-faint">
        {expectedLineNumber ?? actualLineNumber ?? ""}
      </span>
      <span
        className={`inline-flex w-4 shrink-0 justify-center rounded border ${toneClass}`}
      >
        {marker}
      </span>
      <span className="min-w-0 flex-1 break-words">{content || " "}</span>
      <span className="w-14 shrink-0 text-right text-text-faint">
        {actualLineNumber ?? expectedLineNumber ?? ""}
      </span>
    </div>
  );
}

function CopyButton({
  label,
  value,
  compact,
}: {
  label: string;
  value: string;
  compact?: boolean;
}) {
  const { copied, showCopied } = useCopyFeedback();

  return (
    <button
      type="button"
      onClick={() => {
        void copyToClipboard(value).then((ok) => {
          if (!ok) {
            return;
          }
          showCopied();
        });
      }}
      aria-label={label}
      className={`inline-flex items-center rounded border border-line bg-bg-0 px-2 py-1 font-mono text-[10px] text-text-dim transition-colors hover:border-accent hover:text-text focus:outline-none focus-visible:ring-1 focus-visible:ring-accent ${compact ? "min-h-6" : "min-h-7"}`}
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

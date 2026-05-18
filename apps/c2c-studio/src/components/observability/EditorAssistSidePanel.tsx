"use client";

// Studio-IDE-10 (#249): non-modal side panel that renders the result of
// an Editor-Assist `POST /api/v0/editor/explain` call.
//
// Why a side panel (and not a hover or modal):
//   - The explanation can be paragraphs long. A Monaco hover is not the
//     right surface; a modal would block the editor for the duration.
//   - We keep the panel attached so the user can compare the
//     explanation against the highlighted region without losing focus.
//
// Render contract (binding):
//   - The `result.data.explanation` field is UNTRUSTED markdown. It
//     MUST flow through `renderSanitizedHtml` (stage 2 of the ADR 0005
//     §5 sanitiser). Raw `dangerouslySetInnerHTML` on the explanation
//     field is forbidden — even the sanitised result is the only thing
//     that crosses into React's HTML pipeline.
//   - The five error codes from the closed-set enum each get a
//     distinct, named branch. There is no fallback "unknown" branch
//     because the client downgrades unknown codes to
//     `gateway_unavailable` at the wire boundary.
//   - The footer renders three reference handles
//     (`ledgerRef`, `modelInvocationRef`, `editorAssistRef`) each with
//     a copy-to-clipboard affordance so the user can paste them into
//     an evidence packet or bug report.
//   - Redaction visibility: the user can expand a section that lists
//     the `studioRedactionMetadata.matchedPatternIds` from the request.
//     This is the "Preview redaction" affordance — it shows what the
//     client redacted before sending, so the user has full insight
//     into what left their machine.

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { renderSanitizedHtml } from "@/lib/editor/hoverMarkdownSanitizer";
import type {
  EditorAssistBudgetSnapshot,
  EditorAssistErrorCode,
  EditorAssistRequest,
  EditorAssistResult,
} from "@/types/editor-assist";

export interface EditorAssistSidePanelProps {
  open: boolean;
  request: EditorAssistRequest | null;
  result: EditorAssistResult | null;
  onClose: () => void;
  onRetry: () => void;
}

const SHORT_HASH_LENGTH = 12;

function shortHash(value: string): string {
  if (value.length <= SHORT_HASH_LENGTH) {
    return value;
  }
  return `${value.slice(0, SHORT_HASH_LENGTH)}…`;
}

// Wrap navigator.clipboard so the panel keeps rendering when the API
// is unavailable (jsdom, locked-down browsers). The "copied" flash
// fires regardless because the user already attempted the copy.
async function copyToClipboard(value: string): Promise<boolean> {
  if (
    typeof navigator === "undefined" ||
    typeof navigator.clipboard === "undefined" ||
    typeof navigator.clipboard.writeText !== "function"
  ) {
    return false;
  }
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface CopyChipProps {
  label: string;
  value: string;
  displayValue?: string;
  ariaLabel?: string;
}

function CopyChip({ label, value, displayValue, ariaLabel }: CopyChipProps) {
  const [copied, setCopied] = useState(false);
  const display = displayValue ?? value;
  const onClick = useCallback(() => {
    void copyToClipboard(value).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [value]);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel ?? `Copy ${label} to clipboard`}
      className="inline-flex min-h-6 min-w-6 items-center gap-1 rounded border border-line bg-bg-1 px-2.5 py-1.5 text-xs font-mono text-text hover:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-accent"
    >
      <span className="font-semibold uppercase tracking-wider text-text-faint">
        {label}
      </span>
      <span className="max-w-[12rem] truncate">{display}</span>
      <span className="text-text-faint" aria-hidden="true">
        {copied ? "copied" : "copy"}
      </span>
      {/* Live region announces copy success to screen readers (WCAG 4.1.3). */}
      <span
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}

interface BudgetBadgeProps {
  snapshot: EditorAssistBudgetSnapshot | null;
}

function BudgetBadge({ snapshot }: BudgetBadgeProps) {
  if (snapshot === null) {
    return (
      <span className="inline-flex items-center rounded border border-line bg-bg-1 px-2 py-0.5 text-[10px] uppercase tracking-wider text-text-faint">
        budget: unknown
      </span>
    );
  }
  const tone =
    snapshot.remaining === 0
      ? "border-error/30 bg-error/10 text-error"
      : "border-line bg-bg-1 text-text";
  return (
    <span
      className={`inline-flex items-center rounded border px-2 py-0.5 text-[10px] uppercase tracking-wider ${tone}`}
      aria-label={`Editor-Assist budget: ${snapshot.remaining} of ${snapshot.limit} remaining`}
    >
      budget {snapshot.used}/{snapshot.limit}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Error body branches — one per closed-set error code.
// ---------------------------------------------------------------------------

interface ErrorBodyProps {
  errorCode: EditorAssistErrorCode;
  message: string;
  onRetry: () => void;
}

function BudgetExhaustedBody({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded border border-warn/30 bg-warn-soft p-3 text-sm text-warn"
      data-testid="editor-assist-error-budget"
    >
      <p className="font-medium">
        No more Explain calls available for this session.
      </p>
      <p className="mt-1 text-text-dim">{message}</p>
      <p className="mt-2 text-xs text-text-dim">
        Need more? See the{" "}
        <a
          href="./docs/editor-assist-budget.md"
          className="underline hover:text-text"
        >
          Editor-Assist budget guide
        </a>
        .
      </p>
    </div>
  );
}

function PolicyDeniedBody({ message }: { message: string }) {
  // The BFF places the policy id at the start of `message` when the
  // call is denied by an explicit rule (see ADR 0005 §6). We expose
  // it as a copy chip so the user can paste it into a support ticket
  // without rummaging through the panel text.
  return (
    <div
      role="alert"
      className="rounded border border-error/30 bg-error/10 p-3 text-sm text-error"
      data-testid="editor-assist-error-policy"
    >
      <p className="font-medium">Policy declined this call.</p>
      <p className="mt-1 text-text">{message}</p>
      <div className="mt-2">
        <CopyChip label="policy" value={message} ariaLabel="Copy policy id" />
      </div>
    </div>
  );
}

function GatewayUnavailableBody({ message, onRetry }: ErrorBodyProps) {
  return (
    <div
      role="alert"
      className="rounded border border-error/30 bg-error/10 p-3 text-sm text-error"
      data-testid="editor-assist-error-gateway"
    >
      <p className="font-medium">Editor-Assist gateway unavailable.</p>
      <p className="mt-1 text-text">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 inline-flex min-h-[24px] min-w-[24px] items-center justify-center rounded bg-accent px-3 py-1 text-xs font-medium text-bg-0 hover:bg-accent-dim focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-accent"
      >
        Retry
      </button>
    </div>
  );
}

function TimeoutBody({ message, onRetry }: ErrorBodyProps) {
  return (
    <div
      role="alert"
      className="rounded border border-warn/30 bg-warn-soft p-3 text-sm text-warn"
      data-testid="editor-assist-error-timeout"
    >
      <p className="font-medium">Editor-Assist request timed out.</p>
      <p className="mt-1 text-text">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 inline-flex min-h-[24px] min-w-[24px] items-center justify-center rounded bg-accent px-3 py-1 text-xs font-medium text-bg-0 hover:bg-accent-dim focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-accent"
      >
        Retry
      </button>
    </div>
  );
}

function InvalidRegionBody({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded border border-warn/30 bg-warn-soft p-3 text-sm text-warn"
      data-testid="editor-assist-error-region"
    >
      <p className="font-medium">Selection could not be explained.</p>
      <p className="mt-1 text-text">{message}</p>
      <p className="mt-2 text-xs text-text-dim">
        The region was either empty or too large. Select a smaller block of code
        and retry the action from the editor.
      </p>
    </div>
  );
}

function ErrorBody(props: ErrorBodyProps) {
  switch (props.errorCode) {
    case "budget_exhausted":
      return <BudgetExhaustedBody message={props.message} />;
    case "policy_denied":
      return <PolicyDeniedBody message={props.message} />;
    case "gateway_unavailable":
      return <GatewayUnavailableBody {...props} />;
    case "timeout":
      return <TimeoutBody {...props} />;
    case "invalid_region":
      return <InvalidRegionBody message={props.message} />;
  }
}

// ---------------------------------------------------------------------------
// Sanitised explanation block.
// ---------------------------------------------------------------------------

interface ExplanationBodyProps {
  explanation: string;
}

function ExplanationBody({ explanation }: ExplanationBodyProps) {
  // `renderSanitizedHtml` runs the marked → DOMPurify pipeline with the
  // ADR 0005 §5 allow-list. Once the HTML has crossed that gate it is
  // safe to inject; before it crosses the gate it absolutely is not.
  const html = useMemo(() => renderSanitizedHtml(explanation), [explanation]);
  return (
    <div
      data-testid="editor-assist-explanation"
      className="prose prose-invert max-w-none text-sm leading-relaxed text-text"
      // eslint-disable-next-line react/no-danger -- html is the output
      // of renderSanitizedHtml (DOMPurify with closed allow-list).
      // The whole point of this slice is that we DO render the
      // sanitised string here; routing the markdown around DOMPurify
      // would defeat the boundary.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// ---------------------------------------------------------------------------
// Preview-redaction expander.
// ---------------------------------------------------------------------------

interface RedactionPreviewProps {
  request: EditorAssistRequest;
}

function RedactionPreview({ request }: RedactionPreviewProps) {
  const sectionId = useId();
  const [expanded, setExpanded] = useState(false);
  const { studioRedactionMetadata } = request;
  const patterns = studioRedactionMetadata.matchedPatternIds;
  return (
    <details
      open={expanded}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      className="rounded border border-line bg-bg-1 p-2 text-xs text-text"
      data-testid="editor-assist-preview-redaction"
    >
      {/* aria-controls removed: native <details>/<summary> semantics suffice (WCAG 1.3.1, redundant ARIA). */}
      <summary className="cursor-pointer select-none font-medium text-text">
        Preview redaction ({patterns.length} pattern
        {patterns.length === 1 ? "" : "s"})
      </summary>
      <div id={sectionId} className="mt-2 space-y-1">
        <p className="text-text-dim">
          Studio applied these redaction patterns to the selection before
          sending it to the BFF (profile{" "}
          <code className="rounded bg-bg-2 px-1">
            {studioRedactionMetadata.studioRedactionProfileVersion}
          </code>
          ).
        </p>
        {patterns.length === 0 ? (
          <p className="text-text-faint">
            No patterns matched — the selection was sent verbatim.
          </p>
        ) : (
          <ul className="list-disc pl-5">
            {patterns.map((id) => (
              <li key={id} className="font-mono">
                {id}
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Main panel.
// ---------------------------------------------------------------------------

export function EditorAssistSidePanel(props: EditorAssistSidePanelProps) {
  const { open, request, result, onClose, onRetry } = props;

  // Refs and effects MUST be declared before any early return (Rules of Hooks).
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  // Capture the element that had focus before the panel opened so we can
  // restore it when the panel closes (WCAG 2.4.3 focus order).
  const priorFocusRef = useRef<Element | null>(null);

  useEffect(() => {
    if (open) {
      // Capture current focus before the panel steals it.
      priorFocusRef.current = document.activeElement;
      // Move focus to the close button so keyboard users are oriented
      // immediately (WCAG 2.4.3).
      closeButtonRef.current?.focus();
    } else {
      // Restore focus to the element that triggered the panel open.
      if (
        priorFocusRef.current instanceof HTMLElement ||
        priorFocusRef.current instanceof SVGElement
      ) {
        priorFocusRef.current.focus();
      }
      priorFocusRef.current = null;
    }
  }, [open]);

  if (!open || request === null) {
    return null;
  }
  const { region, sourceHash } = request;

  const budgetSnapshot: EditorAssistBudgetSnapshot | null =
    result && result.ok
      ? result.data.budgetSnapshot
      : result && !result.ok
        ? result.budgetSnapshot
        : null;

  return (
    <aside
      role="complementary"
      aria-label="Editor-Assist explanation"
      data-testid="editor-assist-side-panel"
      // `motion-safe:` honours `prefers-reduced-motion` — the slide-in
      // is suppressed when the user has asked for reduced motion.
      className="flex h-full w-full max-w-md flex-col border-l border-line bg-bg-0 text-sm text-text shadow-lg motion-safe:transition-transform"
      onKeyDown={(e) => {
        // Escape closes the panel (WCAG 2.1.2 — no keyboard trap).
        if (e.key === "Escape") {
          onClose();
        }
      }}
    >
      <header
        className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-line bg-bg-1 px-4 py-3"
        data-testid="editor-assist-side-panel-header"
      >
        <div className="min-w-0 space-y-1">
          <h2 className="truncate text-sm font-medium text-text">
            Explain region — {region.filePath}
          </h2>
          <p className="text-xs text-text-dim">
            Lines {region.startLine}–{region.endLine} ·{" "}
            {region.sourceKind === "cobol" ? "COBOL" : "Java"}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <CopyChip
              label="source-hash"
              value={sourceHash}
              displayValue={shortHash(sourceHash)}
              ariaLabel="Copy full source hash"
            />
            <BudgetBadge snapshot={budgetSnapshot} />
          </div>
        </div>
        <button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          aria-label="Close Editor-Assist panel"
          className="inline-flex min-h-[24px] min-w-[24px] items-center justify-center rounded border border-line bg-bg-0 px-2 py-1 text-xs text-text hover:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-accent"
        >
          Close
        </button>
      </header>

      <div className="flex-1 overflow-auto px-4 py-3">
        {result === null ? (
          <div
            role="status"
            aria-live="polite"
            className="rounded border border-line bg-bg-1 p-3 text-text-dim"
          >
            Requesting explanation…
          </div>
        ) : result.ok ? (
          <ExplanationBody explanation={result.data.explanation} />
        ) : (
          <ErrorBody
            errorCode={result.errorCode}
            message={result.message}
            onRetry={onRetry}
          />
        )}

        <div className="mt-4">
          <RedactionPreview request={request} />
        </div>
      </div>

      {result && result.ok ? (
        <footer
          className="border-t border-line bg-bg-1 px-4 py-3 text-xs"
          data-testid="editor-assist-side-panel-footer"
        >
          {result.data.redactionApplied.length > 0 ? (
            <div className="mb-2">
              <span className="mr-2 text-text-faint uppercase tracking-wider">
                Redaction applied
              </span>
              {result.data.redactionApplied.map((id) => (
                <span
                  key={id}
                  className="mr-1 inline-flex items-center rounded border border-line bg-bg-0 px-1.5 py-0.5 font-mono text-[10px] text-text-dim"
                >
                  {id}
                </span>
              ))}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <CopyChip
              label="ledger"
              value={result.data.ledgerRef}
              displayValue={shortHash(result.data.ledgerRef)}
              ariaLabel="Copy ledger reference"
            />
            <CopyChip
              label="model"
              value={result.data.modelInvocationRef}
              displayValue={shortHash(result.data.modelInvocationRef)}
              ariaLabel="Copy model invocation reference"
            />
            <CopyChip
              label="assist"
              value={result.data.editorAssistRef}
              displayValue={shortHash(result.data.editorAssistRef)}
              ariaLabel="Copy editor-assist reference"
            />
          </div>
        </footer>
      ) : null}
    </aside>
  );
}

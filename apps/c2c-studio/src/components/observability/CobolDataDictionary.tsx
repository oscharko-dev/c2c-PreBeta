"use client";

// Studio-IDE-9 (#254): COBOL Data Dictionary side-panel view.
//
// Lists every declared data item in the currently-open COBOL source
// with the same explanation strings the Monaco hover provider emits.
// The two surfaces share the cobolKnowledge.ts module so a list entry
// can never disagree with the hover content for the same construct.

import { useMemo } from "react";

import { useSourceWorkspace } from "@/stores/sourceWorkspace";
import {
  extractDataItems,
  hoverEntryToMarkdownString,
  summariseDataItem,
  type DataItem,
} from "@/lib/editor/cobolKnowledge";
import { renderSanitizedHtml } from "@/lib/editor/hoverMarkdownSanitizer";

export interface CobolDataDictionaryProps {
  // Optional override used by tests and stories. Production callers
  // omit this so the panel reads from the source workspace store.
  sourceTextOverride?: string;
}

export function CobolDataDictionary({
  sourceTextOverride,
}: CobolDataDictionaryProps = {}) {
  const workspace = useSourceWorkspace();
  const source = sourceTextOverride ?? workspace.sourceText;
  const items = useMemo(() => extractDataItems(source ?? ""), [source]);

  if (!source || source.trim().length === 0) {
    return (
      <div
        className="p-4 text-sm text-text-dim"
        data-testid="cobol-data-dictionary-empty"
      >
        <p className="mb-2 font-medium text-text">No COBOL source loaded.</p>
        <p>
          Open a COBOL file from the Explorer or paste source into the editor to
          populate the dictionary.
        </p>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div
        className="p-4 text-sm text-text-dim"
        data-testid="cobol-data-dictionary-no-items"
      >
        <p className="mb-2 font-medium text-text">No data items detected.</p>
        <p>
          The source contains no recognised DATA DIVISION declarations. Add a
          WORKING-STORAGE entry to see it appear here.
        </p>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col p-4 space-y-3 text-sm text-text overflow-y-auto"
      data-testid="cobol-data-dictionary"
    >
      <header>
        <h3 className="text-sm font-semibold text-text">Data Dictionary</h3>
        <p className="mt-1 text-xs text-text-dim">
          {items.length} item{items.length === 1 ? "" : "s"} from the current
          source.
        </p>
      </header>
      <ul className="space-y-2" aria-label="COBOL data items">
        {items.map((item) => (
          <DataItemRow key={`${item.line}-${item.name}`} item={item} />
        ))}
      </ul>
    </div>
  );
}

function DataItemRow({ item }: { item: DataItem }) {
  // `summariseDataItem` is a pure string operation over already-parsed
  // fields; the parent memoises the items array so each `item` here is
  // stable across renders. Computing inline keeps the data flow clear
  // without a no-op `useMemo` (the reviewer correctly flagged the
  // earlier wrapping as ineffective since `item` is recreated by the
  // parent map call on every parent render).
  const summary = summariseDataItem(item);
  const summaryHtml = renderSanitizedHtml(hoverEntryToMarkdownString(summary));
  return (
    <li
      className="rounded border border-line-2 bg-bg-2 p-3"
      data-testid="cobol-data-dictionary-item"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-xs font-semibold text-text">
          {item.level} {item.name}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-text-faint">
          line {item.line}
        </span>
      </div>
      {item.picture ? (
        <p className="mt-1 font-mono text-[11px] text-accent">
          PIC {item.picture}
          {item.usage ? (
            <span className="ml-2 text-text-dim">{item.usage}</span>
          ) : null}
          {item.occurs ? (
            <span className="ml-2 text-text-dim">{item.occurs}</span>
          ) : null}
        </p>
      ) : item.redefines ? (
        <p className="mt-1 font-mono text-[11px] text-accent">
          REDEFINES {item.redefines}
        </p>
      ) : null}
      <div
        className="prose prose-invert mt-1 max-w-none text-xs text-text-dim [&_code]:text-text [&_p]:my-1"
        data-testid="cobol-data-dictionary-summary"
        // `summaryHtml` has crossed the shared marked -> DOMPurify
        // allow-list used by the hover/assist surfaces.
        dangerouslySetInnerHTML={{ __html: summaryHtml }}
      />
    </li>
  );
}

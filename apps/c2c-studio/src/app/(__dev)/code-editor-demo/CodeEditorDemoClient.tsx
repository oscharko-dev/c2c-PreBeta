"use client";

import { useState } from "react";

import { CodeEditor } from "@/components/editor/CodeEditor";

const JAVA_SAMPLE = `package com.example;

public class Greeting {
  public String hello(String name) {
    return "Hello, " + name + "!";
  }
}
`;

const JSON_SAMPLE = `{
  "name": "c2c-studio",
  "version": "0.1.0",
  "monaco": true
}
`;

const JAVA_SAMPLE_ORIGINAL = `package com.example;

public class Greeting {
  public String hello() {
    return "Hello, world";
  }
}
`;

export function CodeEditorDemoClient() {
  const [editableValue, setEditableValue] = useState(JAVA_SAMPLE);

  return (
    <main className="flex h-[100dvh] min-h-0 w-full flex-col gap-4 bg-bg-0 p-4 text-text">
      <header className="shrink-0 border-b border-line pb-2">
        <h1 className="font-ui text-lg text-text-bright">
          CodeEditor demo (dev only)
        </h1>
        <p className="text-xs text-text-faint">
          Mounts the Studio CodeEditor in editable, readonly, and diff modes for
          visual verification. Not registered in production builds.
        </p>
      </header>

      <section
        aria-label="Editable Java editor"
        className="flex min-h-0 flex-1 flex-col rounded border border-line bg-bg-1"
      >
        <div className="shrink-0 border-b border-line bg-bg-2 px-3 py-2 text-xs text-text-dim">
          Mode: editable / language: java
        </div>
        <div className="min-h-0 flex-1">
          <CodeEditor
            mode="editable"
            language="java"
            value={editableValue}
            onChange={setEditableValue}
            modelUri="inmemory://demo/editable.java"
            ariaLabel="Editable Java sample"
          />
        </div>
      </section>

      <section
        aria-label="Read-only JSON editor"
        className="flex min-h-0 flex-1 flex-col rounded border border-line bg-bg-1"
      >
        <div className="shrink-0 border-b border-line bg-bg-2 px-3 py-2 text-xs text-text-dim">
          Mode: readonly / language: json
        </div>
        <div className="min-h-0 flex-1">
          <CodeEditor
            mode="readonly"
            language="json"
            value={JSON_SAMPLE}
            modelUri="inmemory://demo/readonly.json"
            ariaLabel="Read-only JSON sample"
          />
        </div>
      </section>

      <section
        aria-label="Diff editor"
        className="flex min-h-0 flex-1 flex-col rounded border border-line bg-bg-1"
      >
        <div className="shrink-0 border-b border-line bg-bg-2 px-3 py-2 text-xs text-text-dim">
          Mode: diff / language: java
        </div>
        <div className="min-h-0 flex-1">
          <CodeEditor
            mode="diff"
            language="java"
            original={JAVA_SAMPLE_ORIGINAL}
            value={editableValue}
            modelUri="inmemory://demo/diff.java"
            ariaLabel="Diff view of the editable Java sample"
          />
        </div>
      </section>
    </main>
  );
}

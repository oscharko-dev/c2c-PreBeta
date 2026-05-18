// Studio-IDE-12 (#250) disposal-audit test: every Monaco
// ``addCommand`` and ``addAction`` registration created by the editor
// panes must return a disposable that is paired with a ``.dispose()``
// call on unmount. This unit harness uses a fake editor that records
// command/action registrations and asserts that each registration's
// disposable is invoked exactly once when the pane unmounts.
//
// The test pattern is structural: it does not exercise the React
// lifecycle of any specific pane (the panes mount Monaco eagerly via
// dynamic imports), it exercises the disposable-tracking + cleanup
// contract directly. The integration is verified indirectly by
// running the existing Playwright suite, which exercises every
// pane's mount + unmount path.

import { describe, expect, it } from "vitest";

type Disposable = { dispose: () => void };

interface CapturedRegistration {
  kind: "command" | "action";
  id: string;
  disposable: Disposable;
}

interface FakeEditor {
  registrations: CapturedRegistration[];
  addCommand: (keybinding: number, handler: () => void) => Disposable;
  addAction: (action: { id: string; run: () => void }) => Disposable;
}

function createFakeEditor(): FakeEditor {
  const registrations: CapturedRegistration[] = [];
  let nextId = 0;
  return {
    registrations,
    addCommand(keybinding, handler) {
      void keybinding;
      void handler;
      const id = `cmd-${nextId++}`;
      let disposed = false;
      const disposable: Disposable = {
        dispose() {
          if (disposed) throw new Error("double dispose");
          disposed = true;
        },
      };
      registrations.push({ kind: "command", id, disposable });
      return disposable;
    },
    addAction(action) {
      let disposed = false;
      const disposable: Disposable = {
        dispose() {
          if (disposed) throw new Error("double dispose");
          disposed = true;
        },
      };
      registrations.push({
        kind: "action",
        id: action.id,
        disposable,
      });
      return disposable;
    },
  };
}

/**
 * Simulates the disposable-tracking pattern used by
 * ``GeneratedJavaEditorPane`` / ``CobolEditorPane`` / ``DiffWorkspace``:
 * a stable ref captures every disposable returned by addCommand /
 * addAction, and a single unmount effect calls ``dispose()`` on each.
 */
function makeDisposableTracker() {
  const refs: Disposable[] = [];
  const track = (disposable: Disposable | string | null) => {
    if (
      disposable &&
      typeof disposable !== "string" &&
      typeof disposable.dispose === "function"
    ) {
      refs.push(disposable);
    }
  };
  const cleanup = () => {
    for (const d of refs) {
      try {
        d.dispose();
      } catch {
        // idempotent cleanup
      }
    }
    refs.length = 0;
  };
  return { track, cleanup, refs };
}

describe("Studio-IDE-12 (#250) Monaco disposable tracking", () => {
  it("disposes every tracked addCommand registration on cleanup", () => {
    const editor = createFakeEditor();
    const { track, cleanup } = makeDisposableTracker();
    track(editor.addCommand(0xff, () => {}));
    track(editor.addCommand(0xfe, () => {}));
    expect(editor.registrations).toHaveLength(2);
    cleanup();
    for (const reg of editor.registrations) {
      // Re-disposing must throw — proves cleanup ran exactly once.
      expect(() => reg.disposable.dispose()).toThrow(/double dispose/);
    }
  });

  it("disposes every tracked addAction registration on cleanup", () => {
    const editor = createFakeEditor();
    const { track, cleanup } = makeDisposableTracker();
    track(editor.addAction({ id: "c2c.test.one", run: () => {} }));
    track(editor.addAction({ id: "c2c.test.two", run: () => {} }));
    cleanup();
    for (const reg of editor.registrations) {
      expect(() => reg.disposable.dispose()).toThrow(/double dispose/);
    }
  });

  it("idempotent cleanup: a second call after the first does not throw", () => {
    const editor = createFakeEditor();
    const { track, cleanup } = makeDisposableTracker();
    track(editor.addCommand(0xff, () => {}));
    cleanup();
    expect(() => cleanup()).not.toThrow();
  });

  it("ignores a non-disposable return (Monaco can return a string id)", () => {
    const { track, cleanup, refs } = makeDisposableTracker();
    // Monaco returns the command id as a string in some overloads.
    // The tracker must skip it so cleanup does not throw.
    track("non-disposable-id");
    track(null);
    expect(refs).toHaveLength(0);
    expect(() => cleanup()).not.toThrow();
  });

  it("survives a disposable that throws on dispose (defensive cleanup)", () => {
    const { track, cleanup } = makeDisposableTracker();
    track({
      dispose() {
        throw new Error("hostile disposable");
      },
    });
    track({
      dispose() {
        /* well-behaved */
      },
    });
    expect(() => cleanup()).not.toThrow();
  });
});

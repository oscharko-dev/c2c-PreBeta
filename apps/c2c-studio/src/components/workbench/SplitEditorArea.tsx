'use client';

export function SplitEditorArea() {
  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-bg-0" aria-label="Split Editor Area">
      <div className="flex h-10 items-center border-b border-line px-2 shrink-0 bg-bg-1">
        <div className="flex h-full items-center border-b-2 border-accent px-4 text-sm text-text">
          Program.cbl
        </div>
        <div className="flex h-full items-center px-4 text-sm text-text-dim hover:text-text cursor-pointer">
          Program.java
        </div>
      </div>
      <div className="flex flex-1 p-4 text-sm font-mono text-text-dim overflow-auto">
        <div className="flex-1 border-r border-line-2 pr-4">
          <pre>
{`       IDENTIFICATION DIVISION.
       PROGRAM-ID. HELLO-WORLD.
       PROCEDURE DIVISION.
           DISPLAY "Hello, world!".
           STOP RUN.`}
          </pre>
        </div>
        <div className="flex-1 pl-4">
          <pre>
{`public class HelloWorld {
    public static void main(String[] args) {
        System.out.println("Hello, world!");
    }
}`}
          </pre>
        </div>
      </div>
    </div>
  );
}

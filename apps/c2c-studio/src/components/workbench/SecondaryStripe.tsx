'use client';

import { useRef, type ChangeEvent } from 'react';
import { useWorkbench } from '../../stores/workbench';
import { useSourceWorkspace } from '../../stores/sourceWorkspace';
import { TreeRow } from '../ui/TreeRow';
import { HarnessTimeline } from '../observability/HarnessTimeline';
import { ModelGatewayPanel } from '../observability/ModelGatewayPanel';
import { ExperienceLearningPanel } from '../observability/ExperienceLearningPanel';
import { FileCode2, FolderOpen } from 'lucide-react';

function readTextFile(file: File): Promise<string> {
  if (typeof file.text === 'function') {
    return file.text();
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read COBOL file.'));
    reader.readAsText(file);
  });
}

export function SecondaryStripe() {
  const { isSecondaryStripeOpen, activeActivityTab } = useWorkbench();
  const { sourceName, sourceText, setSourceFile, clearWorkspace } = useSourceWorkspace();
  const fileInputRef = useRef<HTMLInputElement>(null);

  if (!isSecondaryStripeOpen) return null;

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;

    const text = await readTextFile(file);
    setSourceFile(text, file.name);
  };

  return (
    <aside
      id="secondary-stripe"
      className="absolute bottom-0 left-12 top-0 z-30 flex w-52 shrink-0 flex-col overflow-hidden border-r border-line bg-bg-1 shadow-lg md:static md:z-auto md:w-64 md:self-stretch md:shadow-none"
      aria-label="Secondary Stripe"
    >
      <div className="flex items-center px-4 h-10 border-b border-line-2 font-medium text-xs uppercase tracking-wider text-text-dim">
        {activeActivityTab === 'harness' ? 'Harness' : 
         activeActivityTab === 'model-gateway' ? 'Model Gateway' : 
         activeActivityTab === 'experience' ? 'Experience Learning' : 
         'COBOL Explorer'}
      </div>
      <div className="flex flex-1 flex-col overflow-auto">
        {activeActivityTab === 'explorer' && (
          <div className="flex flex-1 flex-col gap-4 p-4">
            <input
              ref={fileInputRef}
              type="file"
              accept=".cbl,.cob,.cobol,.cpy,.txt"
              className="hidden"
              onChange={handleFileChange}
              aria-label="Open COBOL source file"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center justify-center gap-2 rounded border border-line-2 bg-bg-2 px-3 py-2 text-sm font-medium text-text hover:bg-bg-3 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              <FolderOpen className="h-4 w-4 text-accent" />
              Open COBOL File
            </button>

            <div className="min-h-0 flex-1 overflow-auto">
              <div role="tree" aria-label="COBOL source files">
                {sourceName && sourceText.length > 0 ? (
                  <TreeRow label={sourceName} type="file" active statusVariant="success" />
                ) : (
                  <TreeRow label="No COBOL file loaded" type="folder" isOpen={false} disabled />
                )}
              </div>
            </div>

            <div className="space-y-2 border-t border-line-2 pt-3 text-xs text-text-dim">
              <div className="flex items-center gap-2 text-text">
                <FileCode2 className="h-4 w-4 text-accent" />
                <span className="font-medium">Own COBOL source only</span>
              </div>
              <p>Open a local COBOL file or paste code directly in the editor.</p>
              {sourceName && (
                <button
                  type="button"
                  onClick={clearWorkspace}
                  className="text-text-dim underline-offset-2 hover:text-text hover:underline"
                >
                  Clear source
                </button>
              )}
            </div>
          </div>
        )}
        {activeActivityTab === 'harness' && <HarnessTimeline />}
        {activeActivityTab === 'model-gateway' && <ModelGatewayPanel />}
        {activeActivityTab === 'experience' && <ExperienceLearningPanel />}
      </div>
    </aside>
  );
}

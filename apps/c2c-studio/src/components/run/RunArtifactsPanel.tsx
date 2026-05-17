'use client';
import { RunArtifactMetadata } from '../../types/artifacts';

export function RunArtifactsPanel({
  artifacts,
  errorMessage,
  missingArtifacts,
}: {
  artifacts: RunArtifactMetadata[] | null | undefined;
  errorMessage?: string | null;
  missingArtifacts?: string[];
}) {
  const hasMissingArtifacts = Boolean(missingArtifacts && missingArtifacts.length > 0);

  if (!artifacts || artifacts.length === 0) {
    return (
      <div className="p-4 space-y-3 text-sm">
        {errorMessage && (
          <div className="rounded border border-line-2 bg-bg-1 p-3">
            <p className="text-xs font-medium text-error">Artifacts fetch failed</p>
            <p className="mt-1 text-xs text-text-dim">{errorMessage}</p>
          </div>
        )}
        {hasMissingArtifacts && <MissingArtifactRecords artifacts={missingArtifacts!} />}
        <div className="text-text-dim">No run artifacts available.</div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-2 border-b border-line-2 font-medium text-text bg-bg-2 sticky top-0">
        Run Artifacts
      </div>
      <div className="flex-1 overflow-auto p-4">
        {errorMessage && (
          <div className="mb-4 rounded border border-line-2 bg-bg-1 p-3">
            <p className="text-xs font-medium text-error">Artifacts fetch failed</p>
            <p className="mt-1 text-xs text-text-dim">{errorMessage}</p>
          </div>
        )}
        {hasMissingArtifacts && <MissingArtifactRecords artifacts={missingArtifacts!} className="mb-4" />}
        <table className="w-full text-left text-xs font-mono text-text">
          <thead>
            <tr className="text-text-dim border-b border-line-2">
              <th className="font-normal pb-2 font-sans">Name / Path</th>
              <th className="font-normal pb-2 font-sans">Kind</th>
              <th className="font-normal pb-2 font-sans">Size (Bytes)</th>
              <th className="font-normal pb-2 font-sans">SHA256</th>
              <th className="font-normal pb-2 font-sans">Produced By</th>
              <th className="font-normal pb-2 font-sans">Timestamp</th>
            </tr>
          </thead>
          <tbody>
            {artifacts.map((art, idx) => (
              <tr key={idx} className="border-b border-line-2 hover:bg-bg-2">
                <td className="py-2 pr-4">{art.path || art.name}</td>
                <td className="py-2 pr-4 text-text-dim">{art.kind}</td>
                <td className="py-2 pr-4">{art.byteSize}</td>
                <td className="py-2 pr-4 text-text-faint truncate max-w-[150px]" title={art.sha256}>{art.sha256}</td>
                <td className="py-2 pr-4 text-text-dim">{art.createdBy}</td>
                <td className="py-2 pr-4 text-text-dim">{art.createdAt}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
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
    <div className={`rounded border border-line-2 bg-bg-1 p-3 ${className ?? ''}`.trim()}>
      <p className="text-xs font-medium text-warn">Missing artifact records</p>
      <ul className="mt-2 list-disc space-y-1 pl-4 text-xs font-mono text-text">
        {artifacts.map((artifact) => (
          <li key={artifact}>{artifact}</li>
        ))}
      </ul>
    </div>
  );
}

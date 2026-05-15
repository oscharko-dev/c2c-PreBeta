'use client';
import { RunArtifactMetadata } from '../../types/artifacts';

export function RunArtifactsPanel({ artifacts }: { artifacts: RunArtifactMetadata[] }) {
  if (!artifacts || artifacts.length === 0) {
    return <div className="p-4 text-text-dim text-sm">No run artifacts available.</div>;
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-2 border-b border-line-2 font-medium text-text bg-bg-2 sticky top-0">
        Run Artifacts
      </div>
      <div className="flex-1 overflow-auto p-4">
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

import React from 'react';
import { ArtifactDetails } from '../../types/generated';

interface ArtifactMetadataPanelProps {
  details: ArtifactDetails;
}

export function ArtifactMetadataPanel({ details }: ArtifactMetadataPanelProps) {
  return (
    <div className="flex flex-col gap-2 p-4 text-sm text-text border-b border-line-2 bg-bg-1">
      <div className="font-medium mb-1">Artifact Details</div>
      
      {details.entryClass && (
        <div className="flex justify-between gap-4">
          <span className="text-text-dim">Entry Class:</span>
          <span className="truncate" title={details.entryClass}>{details.entryClass}</span>
        </div>
      )}
      
      {details.sha256 && (
        <div className="flex justify-between gap-4">
          <span className="text-text-dim">SHA-256:</span>
          <span className="font-mono text-xs truncate" title={details.sha256}>{details.sha256.substring(0, 16)}...</span>
        </div>
      )}
      
      {details.buildState && (
        <div className="flex justify-between gap-4">
          <span className="text-text-dim">Build State:</span>
          <span>{details.buildState}</span>
        </div>
      )}
      
      {details.oracleParity && (
        <div className="flex justify-between gap-4">
          <span className="text-text-dim">Oracle Parity:</span>
          <span>{details.oracleParity}</span>
        </div>
      )}
      
      {details.evidenceStatus && (
        <div className="flex justify-between gap-4">
          <span className="text-text-dim">Evidence Status:</span>
          <span>{details.evidenceStatus}</span>
        </div>
      )}
      
      {details.traceability && (
        <div className="flex justify-between gap-4">
          <span className="text-text-dim">Traceability:</span>
          <span className="truncate">IR {details.traceability.irId}</span>
        </div>
      )}
      
      {details.missingArtifacts && details.missingArtifacts.length > 0 && (
        <div className="mt-2 text-error">
          <div className="text-xs font-medium uppercase tracking-wider mb-1">Missing Artifacts</div>
          <ul className="list-disc list-inside text-xs pl-4">
            {details.missingArtifacts.map(ma => <li key={ma}>{ma}</li>)}
          </ul>
        </div>
      )}

      {details.unsupportedFeatures && details.unsupportedFeatures.length > 0 && (
        <div className="mt-2 text-warn">
          <div className="text-xs font-medium uppercase tracking-wider mb-1">Unsupported Features</div>
          <ul className="list-disc list-inside text-xs pl-4">
            {details.unsupportedFeatures.map(uf => <li key={uf}>{uf}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

import { useState, useMemo, useEffect, useCallback } from 'react';
import { useTransformationRun } from '../stores/transformationRun';
import { apiClient } from '../lib/apiClient';
import { GeneratedArtifactState, FileTreeNode, ArtifactDetails } from '../types/generated';
import { GeneratedFileRef } from '../types/api';

function buildFileTree(files: GeneratedFileRef[] | undefined): FileTreeNode[] {
  if (!files || files.length === 0) return [];

  const root: FileTreeNode = { name: '', path: '', type: 'directory', children: [] };

  for (const file of files) {
    const segments = file.path.split('/');
    let current = root;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const isFile = i === segments.length - 1;
      const currentPath = segments.slice(0, i + 1).join('/');

      let child = current.children.find(c => c.name === segment);
      if (!child) {
        child = {
          name: segment,
          path: currentPath,
          type: isFile ? 'file' : 'directory',
          children: [],
          ...(isFile ? { ref: file } : {})
        };
        current.children.push(child);
      }
      current = child;
    }
  }

  const sortNodes = (node: FileTreeNode) => {
    node.children.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sortNodes);
  };
  sortNodes(root);

  return root.children;
}

export function useGeneratedArtifacts() {
  const { state } = useTransformationRun();
  
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [isFetchingFile, setIsFetchingFile] = useState(false);
  const [fileFetchError, setFileFetchError] = useState<{ path: string, status: number, message: string } | null>(null);
  const [unavailableFiles, setUnavailableFiles] = useState<Set<string>>(new Set());

  const { generated, generatedFiles, buildTest, evidence } = state;

  const artifactState: GeneratedArtifactState = useMemo(() => {
    if (state.phase === 'idle' || !state.runId) return 'idle';
    if (!generated) return 'pending';
    if (generated.status === 'unsupported') return 'unsupported';
    if (generated.status === 'incomplete') return 'incomplete';
    if (!generatedFiles) return 'pending';
    if (generatedFiles.status === 'incomplete') return 'incomplete';
    
    if (buildTest && evidence) {
      if (buildTest.status === 'ok' && evidence.status === 'complete' && 
          generated.artifactRef?.sha256 === buildTest.generatedArtifactRef?.sha256 &&
          generated.artifactRef?.sha256 === evidence.generatedArtifactRef?.sha256) {
        return 'verified';
      }
      return 'failed-verification';
    }
    
    return 'generated';
  }, [state.phase, state.runId, generated, generatedFiles, buildTest, evidence]);

  const fileTree = useMemo(() => {
    return buildFileTree(generatedFiles?.files);
  }, [generatedFiles?.files]);

  const artifactDetails: ArtifactDetails | null = useMemo(() => {
    if (!generated) return null;
    return {
      entryClass: generated.entryClass,
      sha256: generated.artifactRef?.sha256,
      buildState: buildTest?.status,
      oracleParity: buildTest?.classification,
      evidenceStatus: evidence?.status,
      traceability: generated.traceability,
      missingArtifacts: generated.missingArtifacts || generatedFiles?.missingArtifacts,
      unsupportedFeatures: generated.unsupportedFeatures,
    };
  }, [generated, generatedFiles, buildTest, evidence]);

  // Set default selected file when generating files is done
  useEffect(() => {
    if (artifactState !== 'pending' && artifactState !== 'idle' && generatedFiles?.entryFilePath && !selectedFilePath) {
      setSelectedFilePath(generatedFiles.entryFilePath);
    }
  }, [artifactState, generatedFiles?.entryFilePath, selectedFilePath]);

  // Fetch file content
  useEffect(() => {
    let active = true;

    async function fetchFile() {
      if (!selectedFilePath || !state.runId || unavailableFiles.has(selectedFilePath)) {
        setFileContent(null);
        return;
      }

      // Check if it's already in the generated view (entry file)
      if (generated?.files && generated.files[selectedFilePath]) {
        setFileContent(generated.files[selectedFilePath]);
        setFileFetchError(null);
        return;
      }

      setIsFetchingFile(true);
      setFileFetchError(null);

      // The apiClient will url-encode the entire filePath (meaning src/App.java becomes src%2FApp.java)
      const result = await apiClient.getGeneratedFile(state.runId, selectedFilePath);

      if (!active) return;

      setIsFetchingFile(false);

      if (result.ok) {
        setFileContent(result.data.content);
      } else {
        setFileContent(null);
        setFileFetchError({ path: selectedFilePath, status: result.status || 500, message: result.message });
        if (result.status === 404) {
          setUnavailableFiles(prev => new Set(prev).add(selectedFilePath));
        }
        // 400 is invalid path error, we do not retry
      }
    }

    fetchFile();

    return () => { active = false; };
  }, [selectedFilePath, state.runId, generated?.files, unavailableFiles]);

  const selectFile = useCallback((path: string) => {
    if (path !== selectedFilePath) {
      setSelectedFilePath(path);
    }
  }, [selectedFilePath]);

  return {
    artifactState,
    fileTree,
    artifactDetails,
    selectedFilePath,
    selectFile,
    fileContent,
    isFetchingFile,
    fileFetchError,
    unavailableFiles,
  };
}

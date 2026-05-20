import { createContext, createElement, useState, useMemo, useEffect, useCallback, useContext, ReactNode } from 'react';
import { useTransformationRun } from '../stores/transformationRun';
import { apiClient } from '../lib/apiClient';
import { GeneratedArtifactState, FileTreeNode, ArtifactDetails } from '../types/generated';
import { GeneratedFileRef } from '../types/api';

function buildFileTree(files: GeneratedFileRef[] | undefined): FileTreeNode[] {
  if (!files || files.length === 0) return [];

  const root: FileTreeNode = { name: '', path: '', type: 'directory', children: [] };
  const childIndexes = new WeakMap<FileTreeNode, Map<string, FileTreeNode>>();

  const childIndexFor = (node: FileTreeNode): Map<string, FileTreeNode> => {
    let index = childIndexes.get(node);
    if (!index) {
      index = new Map(node.children.map((child) => [child.name, child]));
      childIndexes.set(node, index);
    }
    return index;
  };

  for (const file of files) {
    const segments = file.path.split('/');
    let current = root;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const isFile = i === segments.length - 1;
      const currentPath = segments.slice(0, i + 1).join('/');
      const childrenByName = childIndexFor(current);

      let child = childrenByName.get(segment);
      if (!child) {
        child = {
          name: segment,
          path: currentPath,
          type: isFile ? 'file' : 'directory',
          children: [],
          ...(isFile ? { ref: file } : {})
        };
        current.children.push(child);
        childrenByName.set(segment, child);
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
  const context = useContext(GeneratedArtifactsContext);
  if (!context) {
    throw new Error('useGeneratedArtifacts must be used within a GeneratedArtifactsProvider');
  }
  return context;
}

interface GeneratedArtifactsValue {
  artifactState: GeneratedArtifactState;
  fileTree: FileTreeNode[];
  artifactDetails: ArtifactDetails | null;
  selectedFilePath: string | null;
  selectedFileRef: GeneratedFileRef | null;
  selectFile: (path: string) => void;
  fileContent: string | null;
  fileContentRunId: string | null;
  isFetchingFile: boolean;
  fileFetchError: { path: string, status: number, message: string } | null;
  unavailableFiles: Set<string>;
  displayedRunId: string | null;
  showingHistoricalArtifacts: boolean;
}

const GeneratedArtifactsContext = createContext<GeneratedArtifactsValue | null>(null);

function useGeneratedArtifactsState(): GeneratedArtifactsValue {
  const { state } = useTransformationRun();
  
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileContentRunId, setFileContentRunId] = useState<string | null>(null);
  const [isFetchingFile, setIsFetchingFile] = useState(false);
  const [fileFetchError, setFileFetchError] = useState<{ path: string, status: number, message: string } | null>(null);
  const [unavailableFiles, setUnavailableFiles] = useState<Set<string>>(new Set());

  const showingHistoricalArtifacts = Boolean(
    state.previousRun &&
      !state.generated &&
      !state.generatedFiles &&
      (state.phase === 'starting' ||
        state.phase === 'running' ||
        state.phase === 'failed' ||
        state.phase === 'unavailable')
  );
  const artifactSource = showingHistoricalArtifacts && state.previousRun
    ? state.previousRun
    : state;
  const displayedRunId = artifactSource.runId;
  const { generated, generatedFiles, buildTest, evidence } = artifactSource;
  const finalClassification =
    artifactSource.workflow?.finalClassification ??
    artifactSource.summary?.finalClassification ??
    null;

  useEffect(() => {
    setSelectedFilePath(null);
    setFileContent(null);
    setFileContentRunId(null);
    setIsFetchingFile(false);
    setFileFetchError(null);
    setUnavailableFiles(new Set());
  }, [displayedRunId]);

  const artifactState: GeneratedArtifactState = useMemo(() => {
    if (state.phase === 'idle' || !displayedRunId) return 'idle';
    if (!showingHistoricalArtifacts && (state.phase === 'starting' || state.phase === 'running')) {
      return 'pending';
    }
    if (!generated) return 'pending';
    if (generated.status === 'unsupported') return 'unsupported';
    if (generated.status === 'incomplete') return 'incomplete';
    if (!generatedFiles) return 'pending';
    if (generatedFiles.status === 'incomplete') return 'incomplete';
    if (!showingHistoricalArtifacts && state.phase === 'incomplete') return 'incomplete';
    if (!showingHistoricalArtifacts && (state.phase === 'failed' || state.phase === 'unavailable')) {
      return 'failed-verification';
    }
    
    if (buildTest && evidence) {
      if (buildTest.status === 'ok' && evidence.status === 'complete' && 
          generated.artifactRef?.sha256 === buildTest.generatedArtifactRef?.sha256 &&
          generated.artifactRef?.sha256 === evidence.generatedArtifactRef?.sha256) {
        return finalClassification === 'success' ? 'verified' : 'generated';
      }
      return 'failed-verification';
    }
    
    return 'generated';
  }, [
    state.phase,
    displayedRunId,
    showingHistoricalArtifacts,
    generated,
    generatedFiles,
    buildTest,
    evidence,
    finalClassification,
  ]);

  const fileTree = useMemo(() => {
    return buildFileTree(generatedFiles?.files);
  }, [generatedFiles?.files]);

  const selectedFileRef = useMemo(() => {
    if (!selectedFilePath) return null;
    return generatedFiles?.files.find((file) => file.path === selectedFilePath) ?? null;
  }, [generatedFiles?.files, selectedFilePath]);

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
      if (!selectedFilePath || !displayedRunId || unavailableFiles.has(selectedFilePath)) {
        setFileContent(null);
        setFileContentRunId(null);
        setIsFetchingFile(false);
        setFileFetchError(null);
        return;
      }

      const requestedRunId = displayedRunId;
      setIsFetchingFile(true);
      setFileFetchError(null);

      // Generated source content must pass through the capped file-content endpoint.
      const result = await apiClient.getGeneratedFile(requestedRunId, selectedFilePath);

      if (!active) return;

      setIsFetchingFile(false);

      if (result.ok) {
        setFileContent(result.data.content);
        setFileContentRunId(result.data.runId);
      } else {
        setFileContent(null);
        setFileContentRunId(null);
        setFileFetchError({ path: selectedFilePath, status: result.status || 500, message: result.message });
        if (result.status === 404) {
          setUnavailableFiles(prev => new Set(prev).add(selectedFilePath));
        }
        // 400 is invalid path error, we do not retry
      }
    }

    fetchFile();

    return () => { active = false; };
  }, [selectedFilePath, displayedRunId, unavailableFiles]);

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
    selectedFileRef,
    selectFile,
    fileContent,
    fileContentRunId,
    isFetchingFile,
    fileFetchError,
    unavailableFiles,
    displayedRunId,
    showingHistoricalArtifacts,
  };
}

export function GeneratedArtifactsProvider({ children }: { children: ReactNode }) {
  const value = useGeneratedArtifactsState();
  return createElement(GeneratedArtifactsContext.Provider, { value }, children);
}

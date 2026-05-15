'use client';

import { useMemo, useState } from 'react';
import {
  CircleDotDashed,
  FileCode2,
  FolderTree,
  GitBranch,
  PackageSearch,
  Pin,
  Play,
  ScrollText,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  TerminalSquare,
  TestTube2,
  Workflow,
} from 'lucide-react';
import { useC2cApi } from '../../hooks/useC2cApi';
import { AppLogo } from '../icons/AppLogo';
import { Badge } from '../ui/Badge';
import { CodeSurface, type CodeSurfaceLine } from '../ui/CodeSurface';
import { IconButton } from '../ui/IconButton';
import { MetadataRow } from '../ui/MetadataRow';
import { Panel } from '../ui/Panel';
import { SplitPane } from '../ui/SplitPane';
import { StatusBar } from '../ui/StatusBar';
import { StatusChip } from '../ui/StatusChip';
import { Tabs } from '../ui/Tabs';
import { TreeRow } from '../ui/TreeRow';
import { Truncate } from '../ui/Truncate';
import {
  mapBuildTestClassificationToVariant,
  mapBuildTestStatusToVariant,
  mapEvidenceStatusToVariant,
  mapGeneratedStatusToVariant,
  mapProductModeToVariant,
  type BuildTestClassification,
  type BuildTestStatus,
  type EvidenceStatus,
  type GeneratedStatus,
  type ProductMode,
  type StatusVariant,
} from '@/types/design';

const cobolLines: CodeSurfaceLine[] = [
  { content: 'IDENTIFICATION DIVISION.' },
  { content: 'PROGRAM-ID. BRNCH01.' },
  { content: '' },
  { content: 'DATA DIVISION.' },
  { content: 'WORKING-STORAGE SECTION.' },
  { content: '01 WS-ACCOUNTS.' },
  { content: '   05 WS-ACCOUNT OCCURS 4 TIMES.' },
  { content: '      10 WS-STATUS PIC X(1) VALUE SPACE.' },
  { content: '      10 WS-AMOUNT PIC S9(5)V99 VALUE 0.' },
  { content: 'PROCEDURE DIVISION.' },
  { content: '   MOVE "A" TO WS-STATUS (3).', active: true },
  { content: '   MOVE 200.00 TO WS-AMOUNT (3).' },
  { content: '   DISPLAY "APPROVED-COUNT=" WS-APPROVED.' },
];

const javaLines: CodeSurfaceLine[] = [
  { content: 'package com.c2c.w0.targetJava;' },
  { content: '' },
  { content: 'public final class BranchAccountGuard {' },
  { content: '    private static final int ACCOUNT_COUNT = 4;' },
  { content: '' },
  { content: '    public void run() {' },
  { content: '        accounts[2].status = \'A\';', active: true },
  { content: '        accounts[2].amount = new BigDecimal("200.00");' },
  { content: '        System.out.println("APPROVED-COUNT=" + approved);' },
  { content: '    }' },
  { content: '}' },
];

const buildStages = [
  { label: 'Resolve reference program', detail: 'corpus/synthetic/branch-account-guard.cbl', status: 'sealed' },
  { label: 'Generate target Java', detail: 'target/java/com/c2c/w0/targetJava/ServiceApp.java', status: 'generated' },
  { label: 'Package evidence bundle', detail: 'artifacts/transformation-metadata.json', status: 'complete' },
];

export function StudioShell() {
  const { health, mode, error, errorKind, loading } = useC2cApi();
  const [editorTab, setEditorTab] = useState('current-source');
  const [bottomTab, setBottomTab] = useState('build-test');

  const upstreamIssues = mode
    ? [
        mode.orchestrator !== 'live' ? 'Orchestrator is not reachable.' : null,
        mode.evidence !== 'live' ? 'Evidence service is not reachable.' : null,
      ].filter((issue): issue is string => issue !== null)
    : [];

  const canTransform =
    health?.status === 'ok' && !error && upstreamIssues.length === 0 && errorKind === null;

  const backendStateLabel = loading
    ? 'checking'
    : health?.status !== 'ok' || error
      ? 'blocked'
      : upstreamIssues.length > 0
        ? 'degraded'
        : 'connected';

  const blockingTitle =
    errorKind === 'config'
      ? 'Configuration Error'
      : errorKind === 'parse' || errorKind === 'contract'
        ? 'Contract Error'
        : 'Backend Unavailable';

  const blockingMessage =
    errorKind === 'config'
      ? 'Studio runtime configuration is invalid. Fix the BFF base URL override before using the product.'
      : errorKind === 'parse' || errorKind === 'contract'
        ? 'The BFF returned data that does not match the expected frontend contract.'
        : 'Studio cannot reach the backend right now. Transformation actions remain disabled.';

  const productMode: ProductMode = canTransform ? 'live' : 'unavailable';
  const generatedStatus: GeneratedStatus = canTransform ? 'generated' : error ? 'incomplete' : 'unsupported';
  const evidenceStatus: EvidenceStatus = canTransform ? 'complete' : 'incomplete';
  const buildStatus: BuildTestStatus = canTransform ? 'ok' : error ? 'run-failed' : 'skipped';
  const buildClassification: BuildTestClassification = canTransform
    ? 'match'
    : error
      ? 'run-error'
      : 'skipped-no-execution';

  const readinessBadges = useMemo(
    () => [
      {
        label: 'Product mode',
        value: canTransform ? 'ready' : 'blocked',
        variant: mapProductModeToVariant(productMode),
      },
      {
        label: 'Generated',
        value: generatedStatus,
        variant: mapGeneratedStatusToVariant(generatedStatus),
      },
      {
        label: 'Evidence',
        value: evidenceStatus,
        variant: mapEvidenceStatusToVariant(evidenceStatus),
      },
      {
        label: 'Build/test',
        value: buildClassification,
        variant: mapBuildTestClassificationToVariant(buildClassification),
      },
    ],
    [buildClassification, canTransform, evidenceStatus, generatedStatus, productMode]
  );

  const healthVariant: StatusVariant = loading ? 'pending' : health?.status === 'ok' ? 'success' : 'error';
  const orchestratorVariant: StatusVariant = mode?.orchestrator === 'live' ? 'success' : 'blocked';
  const evidenceVariant: StatusVariant = mode?.evidence === 'live' ? 'success' : 'blocked';

  return (
    <div className="min-h-screen bg-bg-0 text-text">
      <div className="grid min-h-screen grid-rows-[36px_minmax(0,1fr)_auto]">
        <header className="grid grid-cols-[auto_1fr_auto] items-center border-b border-line bg-bg-1">
          <div className="flex min-w-0 items-center gap-3 px-3">
            <AppLogo compact />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-semibold text-text-bright">c2c-PreBeta</span>
                <span className="rounded border border-line bg-bg-2 px-2 py-0.5 text-[11px] text-text-dim">
                  /Projects/c2c-PreBeta
                </span>
              </div>
            </div>
            <Badge variant="neutral" icon={false}>
              <span className="inline-flex items-center gap-1">
                <GitBranch className="h-3.5 w-3.5" />
                dev
              </span>
            </Badge>
          </div>

          <div className="flex items-center justify-end gap-2 px-3">
            <div className="hidden min-w-0 items-center gap-2 rounded border border-line bg-bg-2 px-3 py-1 text-[11px] text-text-dim md:flex">
              <Workflow className="h-3.5 w-3.5 text-text-faint" />
              <span>Run</span>
              <span className="text-text">COBOL to Java</span>
              <span className="text-text-faint">·</span>
              <Truncate
                text="corpus/synthetic/branch-account-guard.cbl"
                maxLength={30}
                position="middle"
                className="max-w-[18rem]"
              />
            </div>
            <IconButton icon={Search} aria-label="Search workspace" />
            <IconButton icon={Settings2} aria-label="Open studio settings" />
            <button
              type="button"
              disabled={!canTransform}
              className="inline-flex h-6 items-center gap-1 rounded border border-success/40 bg-bg-2 px-2 text-xs font-medium text-success transition-colors hover:bg-success-soft disabled:cursor-not-allowed disabled:border-line disabled:text-text-faint disabled:hover:bg-bg-2"
            >
              <Play className="h-3.5 w-3.5" />
              Start Transformation
            </button>
            <IconButton icon={Square} aria-label="Stop transformation" disabled variant="danger" />
          </div>

          <div className="flex items-center gap-3 px-3">
            <div className="hidden items-center gap-2 rounded-full border border-line bg-bg-2 px-2.5 py-1 text-[11px] text-text-dim lg:flex">
              <StatusChip variant={mapProductModeToVariant(productMode)} />
              <span>Product mode:</span>
              <span className="text-text">{canTransform ? 'ready' : 'fail-closed'}</span>
            </div>
            <div className="text-xs text-text-dim">Backend: {backendStateLabel}</div>
          </div>
        </header>

        <main className="grid min-h-0 lg:grid-cols-[260px_minmax(0,1fr)_320px]">
          <aside className="min-h-0 border-r border-line">
            <Panel
              className="h-full rounded-none border-0"
              bodyClassName="p-0"
              header={
                <div className="flex w-full items-center justify-between gap-3">
                  <span className="text-sm font-medium text-text-bright">Project</span>
                  <div className="flex items-center gap-1">
                    <IconButton icon={FolderTree} aria-label="Project outline" />
                    <IconButton icon={Search} aria-label="Find in project" />
                  </div>
                </div>
              }
              footer={
                <button
                  type="button"
                  className="inline-flex w-full items-center justify-center gap-2 rounded border border-line bg-bg-1 px-3 py-1.5 text-xs text-text-dim transition-colors hover:bg-bg-3 hover:text-text"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  Load Reference Program
                </button>
              }
            >
              <div className="space-y-1 py-2" role="tree" aria-label="Project files">
                <TreeRow label="c2c-PreBeta" type="folder" depth={0} isOpen />
                <TreeRow label="apps" type="folder" depth={1} isOpen />
                <TreeRow label="c2c-studio" type="folder" depth={2} isOpen />
                <TreeRow label="src" type="folder" depth={3} isOpen />
                <TreeRow label="components" type="folder" depth={4} isOpen />
                <TreeRow label="studio" type="folder" depth={5} isOpen />
                <TreeRow
                  label="StudioShell.tsx"
                  type="file"
                  depth={6}
                  active
                  statusVariant={mapGeneratedStatusToVariant(generatedStatus)}
                />
                <TreeRow
                  label="corpus/synthetic/branch-account-guard.cbl"
                  type="file"
                  depth={2}
                  statusVariant="neutral"
                />
                <TreeRow
                  label="target/java/com/c2c/w0/targetJava/transformation-metadata.json"
                  type="file"
                  depth={2}
                  statusVariant={mapEvidenceStatusToVariant(evidenceStatus)}
                />
              </div>
            </Panel>
          </aside>

          <section className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_260px]">
            <div className="border-b border-line bg-bg-0 px-4 py-3">
              <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.24em] text-text-faint">Transformation Studio</p>
                  <h1 className="mt-1 text-xl font-semibold text-text-bright">Fail-closed workbench for W0.1 product mode</h1>
                  <p className="mt-1 max-w-3xl text-sm text-text-dim">
                    Next.js Studio shell backed only by the c2c BFF. Product actions stay fail-closed
                    until health, mode, and contract checks all pass.
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {readinessBadges.map((badge) => (
                    <Badge key={badge.label} variant={badge.variant}>
                      {badge.label}: {badge.value}
                    </Badge>
                  ))}
                </div>
              </div>
            </div>

            <div className="min-h-0">
              <SplitPane
                className="h-full rounded-none border-0 border-b border-line bg-line"
                leftLabel="Source editor"
                rightLabel="Target editor"
                left={
                  <Panel
                    className="h-full rounded-none border-0"
                    bodyClassName="p-0"
                    header={
                      <div className="flex w-full min-w-0 items-center gap-2">
                        <Tabs
                          value={editorTab}
                          onValueChange={setEditorTab}
                          tabs={[
                            { value: 'current-source', label: 'branch-account-guard.cbl' },
                            { value: 'fixture-log', label: 'build.log' },
                          ]}
                          className="min-w-0 flex-1"
                        />
                        <Badge variant="neutral">sealed</Badge>
                      </div>
                    }
                  >
                    <MetadataRow
                      items={[
                        { label: 'source', value: 'corpus/synthetic/branch-account-guard.cbl', truncate: 'middle' },
                        { label: 'program-id', value: 'BRNCH01' },
                        { label: 'status', value: 'current source', tone: 'default' },
                      ]}
                    />
                    <CodeSurface label="COBOL source preview" lines={cobolLines} />
                  </Panel>
                }
                right={
                  <Panel
                    className="h-full rounded-none border-0"
                    bodyClassName="p-0"
                    header={
                      <div className="flex w-full min-w-0 items-center gap-2">
                        <Tabs
                          value="service-app"
                          onValueChange={() => undefined}
                          tabs={[{ value: 'service-app', label: 'ServiceApp.java' }]}
                          className="min-w-0 flex-1"
                        />
                        <Badge variant={mapGeneratedStatusToVariant(generatedStatus)}>{generatedStatus}</Badge>
                      </div>
                    }
                  >
                    <MetadataRow
                      items={[
                        {
                          label: 'target',
                          value: 'target/java/com/c2c/w0/targetJava/ServiceApp.java',
                          truncate: 'middle',
                        },
                        {
                          label: 'hash',
                          value: 'cb4ddf023b0f57e79d63de91205f4fe31f6d6bf0',
                          truncate: 'middle',
                          tone: 'success',
                        },
                        { label: 'status', value: generatedStatus, tone: generatedStatus === 'generated' ? 'success' : 'warning' },
                      ]}
                    />
                    <CodeSurface label="Generated Java preview" lines={javaLines} />
                  </Panel>
                }
              />
            </div>

            <Panel
              className="rounded-none border-0 border-t border-line"
              bodyClassName="p-0"
              header={
                <div className="flex w-full min-w-0 items-center gap-3">
                  <Tabs
                    value={bottomTab}
                    onValueChange={setBottomTab}
                    tabs={[
                      { value: 'build-test', label: 'Build & Test' },
                      { value: 'evidence', label: 'Evidence' },
                      { value: 'diagnostics', label: 'Diagnostics' },
                    ]}
                    className="min-w-0 flex-1"
                  />
                  <Badge variant={mapBuildTestStatusToVariant(buildStatus)}>{buildStatus}</Badge>
                </div>
              }
            >
              <MetadataRow
                items={[
                  { label: 'run-id', value: 'run-2026-05-14-1822-7af3', truncate: 'middle' },
                  { label: 'classification', value: buildClassification, tone: canTransform ? 'success' : 'warning' },
                  { label: 'timestamp', value: '2026-05-14 18:22:11 UTC' },
                ]}
              />
              <div className="grid min-h-0 gap-px bg-line lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_280px]">
                <div className="bg-bg-0 p-3">
                  <div className="mb-3 flex items-center justify-between text-xs uppercase tracking-[0.2em] text-text-faint">
                    <span>Pipeline</span>
                    <span className="font-mono text-text-dim">3 stages</span>
                  </div>
                  <div className="space-y-2">
                    {buildStages.map((stage) => (
                      <div key={stage.label} className="rounded border border-line bg-bg-1 px-3 py-2">
                        <div className="flex items-center gap-2">
                          <StatusChip variant={stage.status === 'complete' ? 'success' : 'pending'} />
                          <span className="text-sm text-text">{stage.label}</span>
                          <span className="ml-auto">
                            <Badge variant={stage.status === 'complete' ? 'success' : 'pending'}>{stage.status}</Badge>
                          </span>
                        </div>
                        <p className="mt-1 font-mono text-[11px] text-text-faint">{stage.detail}</p>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="bg-bg-0 p-3">
                  <div className="mb-3 flex items-center justify-between text-xs uppercase tracking-[0.2em] text-text-faint">
                    <span>Artifacts</span>
                    <span className="font-mono text-text-dim">2 sealed</span>
                  </div>
                  <div className="space-y-2 text-sm">
                    <div className="rounded border border-line bg-bg-1 px-3 py-2">
                      <div className="flex items-center gap-2">
                        <FileCode2 className="h-4 w-4 text-text-dim" />
                        <Truncate
                          text="target/java/com/c2c/w0/targetJava/ServiceApp.java"
                          maxLength={38}
                          position="middle"
                          className="max-w-full"
                        />
                      </div>
                    </div>
                    <div className="rounded border border-line bg-bg-1 px-3 py-2">
                      <div className="flex items-center gap-2">
                        <ScrollText className="h-4 w-4 text-text-dim" />
                        <Truncate
                          text="transformation-metadata.json#sha256:cb4ddf023b0f57e79d63de91205f4fe31f6d6bf0"
                          maxLength={38}
                          position="middle"
                          className="max-w-full"
                        />
                      </div>
                    </div>
                  </div>
                </div>

                <div className="bg-bg-0 p-3">
                  <div className="mb-3 flex items-center justify-between text-xs uppercase tracking-[0.2em] text-text-faint">
                    <span>Runtime</span>
                    <span className="font-mono text-text-dim">{backendStateLabel}</span>
                  </div>
                  <div className="space-y-2">
                    <div className="rounded border border-line bg-bg-1 px-3 py-2">
                      <div className="flex items-center gap-2">
                        <ShieldCheck className="h-4 w-4 text-text-dim" />
                        <span className="text-sm text-text">BFF health</span>
                        <span className="ml-auto">
                          <Badge variant={healthVariant}>{health?.status === 'ok' ? 'ok' : loading ? 'checking' : 'down'}</Badge>
                        </span>
                      </div>
                    </div>
                    <div className="rounded border border-line bg-bg-1 px-3 py-2">
                      <div className="flex items-center gap-2">
                        <Workflow className="h-4 w-4 text-text-dim" />
                        <span className="text-sm text-text">Orchestrator reachability</span>
                        <span className="ml-auto">
                          <Badge variant={orchestratorVariant}>{mode?.orchestrator ?? 'unknown'}</Badge>
                        </span>
                      </div>
                    </div>
                    <div className="rounded border border-line bg-bg-1 px-3 py-2">
                      <div className="flex items-center gap-2">
                        <PackageSearch className="h-4 w-4 text-text-dim" />
                        <span className="text-sm text-text">Evidence reachability</span>
                        <span className="ml-auto">
                          <Badge variant={evidenceVariant}>{mode?.evidence ?? 'unknown'}</Badge>
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </Panel>
          </section>

          <aside className="min-h-0 border-l border-line">
            <Panel
              className="h-full rounded-none border-0"
              bodyClassName="space-y-4"
              header={
                <div className="flex w-full items-center gap-2">
                  <span className="text-sm font-semibold text-text-bright">Target Java</span>
                  <Badge variant={mapGeneratedStatusToVariant(generatedStatus)}>verified</Badge>
                  <span className="ml-auto flex items-center gap-1">
                    <IconButton icon={Search} aria-label="Reveal in source" />
                    <IconButton icon={Pin} aria-label="Pin inspector" />
                  </span>
                </div>
              }
            >
              <div className="rounded border border-line bg-bg-1 p-3">
                <div className="flex items-start gap-3">
                  <div className="rounded-full border border-success/20 bg-success-soft p-2 text-success">
                    <Sparkles className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h2 className="text-sm font-semibold text-text-bright">Backend Status</h2>
                      <span className="text-xs text-text-dim">Backend: {backendStateLabel}</span>
                    </div>
                    <p className="mt-1 text-sm text-text-dim">
                      Honest startup state for BFF health, upstream mode, and runtime contract validation.
                    </p>
                  </div>
                </div>
              </div>

              <div className="rounded border border-line bg-bg-1 p-3">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-xs uppercase tracking-[0.2em] text-text-faint">Evidence tree</h3>
                  <Badge variant={mapEvidenceStatusToVariant(evidenceStatus)}>{evidenceStatus}</Badge>
                </div>
                <div className="space-y-1" role="tree" aria-label="Target Java artifacts">
                  <TreeRow label="target/java" type="folder" isOpen statusVariant="success" />
                  <TreeRow label="com" type="folder" depth={1} isOpen />
                  <TreeRow label="c2c" type="folder" depth={2} isOpen />
                  <TreeRow label="w0" type="folder" depth={3} isOpen />
                  <TreeRow label="targetJava" type="folder" depth={4} isOpen />
                  <TreeRow label="ServiceApp.java" type="file" depth={5} statusVariant="success" />
                  <TreeRow
                    label="transformation-metadata.json"
                    type="file"
                    depth={1}
                    statusVariant={mapEvidenceStatusToVariant(evidenceStatus)}
                  />
                </div>
              </div>

              <div className="rounded border border-line bg-bg-1 p-3">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-xs uppercase tracking-[0.2em] text-text-faint">Contract inspection</h3>
                  <CircleDotDashed className="h-4 w-4 text-text-faint" />
                </div>
                <MetadataRow
                  className="rounded border border-line bg-bg-0"
                  items={[
                    { label: 'mode.orchestrator', value: mode?.orchestrator ?? 'unknown', tone: mode?.orchestrator === 'live' ? 'success' : 'warning' },
                    { label: 'mode.evidence', value: mode?.evidence ?? 'unknown', tone: mode?.evidence === 'live' ? 'success' : 'warning' },
                    { label: 'health.status', value: String(health?.status ?? 'missing'), tone: health?.status === 'ok' ? 'success' : 'error' },
                  ]}
                />
                <pre className="mt-3 overflow-auto rounded border border-line bg-bg-0 p-3 text-xs text-text-dim">
                  {JSON.stringify(mode ?? { orchestrator: 'unknown', evidence: 'unknown' }, null, 2)}
                </pre>
              </div>

              {(error || upstreamIssues.length > 0) && (
                <div
                  className={`rounded border p-3 ${
                    error ? 'border-error/30 bg-error-soft/40 text-error' : 'border-warn/30 bg-warn-soft/40 text-warn'
                  }`}
                >
                  <h3 className="text-sm font-semibold text-current">{error ? blockingTitle : 'Upstream Constraints'}</h3>
                  {error ? (
                    <>
                      <p className="mt-2 text-sm text-text">{blockingMessage}</p>
                      <p className="mt-3 rounded border border-white/5 bg-bg-0 px-3 py-2 font-mono text-xs text-text">
                        {error}
                      </p>
                    </>
                  ) : (
                    <ul className="mt-2 space-y-2 text-sm text-text">
                      {upstreamIssues.map((issue) => (
                        <li key={issue}>{issue}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </Panel>
          </aside>
        </main>

        <StatusBar
          breadcrumbs={['c2c-PreBeta', 'corpus', 'synthetic', 'branch-account-guard.cbl']}
          items={[
            { label: 'build', value: buildStatus, valueVariant: mapBuildTestStatusToVariant(buildStatus) },
            { label: 'tests', value: buildClassification, valueVariant: mapBuildTestClassificationToVariant(buildClassification) },
            { label: 'branch', value: 'dev' },
            { label: 'cursor', value: '1:1' },
            { label: 'hash', value: 'cb4ddf023b0f57e79d63de91205f4fe31f6d6bf0', truncate: true },
          ]}
        />
      </div>
    </div>
  );
}

import { BffError, createBffApi, type BffApi } from './api.js';
import {
  buildTestSummary,
  evidenceSummary,
  generatedSummary,
  modeBadgeFromResponse,
  pickEntryFile,
  runStatusLine,
} from './view-model.js';
import type {
  BuildTestView,
  EvidenceView,
  GeneratedView,
  RunSummary,
  SampleDetail,
  SampleSummary,
} from './types.js';

interface UiState {
  samples: SampleSummary[];
  selectedSample?: SampleDetail;
  run?: RunSummary;
  generated?: GeneratedView;
  buildTest?: BuildTestView;
  evidence?: EvidenceView;
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing DOM node #${id}`);
  return node as T;
}

function setText(node: HTMLElement, text: string): void {
  node.textContent = text;
}

function clearChildren(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function renderModeBadge(state: ReturnType<typeof modeBadgeFromResponse>): void {
  const node = el<HTMLDivElement>('mode-badge');
  node.dataset['mode'] = state.mode;
  setText(node, state.text);
}

function renderSamples(state: UiState, onSelect: (programId: string) => void): void {
  const container = el<HTMLDivElement>('sample-picker');
  clearChildren(container);
  if (state.samples.length === 0) {
    setText(container, 'No samples available.');
    return;
  }
  for (const sample of state.samples) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sample-card';
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', String(state.selectedSample?.programId === sample.programId));
    button.dataset['programId'] = sample.programId;

    const pid = document.createElement('div');
    pid.className = 'program-id';
    pid.textContent = sample.programId;
    button.appendChild(pid);

    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = sample.title;
    button.appendChild(title);

    const desc = document.createElement('div');
    desc.className = 'description';
    desc.textContent = sample.description;
    button.appendChild(desc);

    if (sample.knownDivergenceAtW0) {
      const tag = document.createElement('div');
      tag.className = 'known-divergence';
      tag.textContent = 'known W0 divergence';
      button.appendChild(tag);
    }

    button.addEventListener('click', () => onSelect(sample.programId));
    container.appendChild(button);
  }
}

function renderCobolPane(state: UiState): void {
  const pane = el<HTMLPreElement>('cobol-source');
  if (!state.selectedSample) {
    setText(pane, 'No sample loaded.');
    return;
  }
  setText(pane, state.selectedSample.cobolSource);
}

function renderRunStatus(state: UiState): void {
  const node = el<HTMLDivElement>('run-status');
  const line = runStatusLine(state.run);
  node.dataset['state'] = line.state;
  clearChildren(node);
  const primary = document.createElement('div');
  primary.textContent = line.primary;
  node.appendChild(primary);
  if (line.secondary) {
    const secondary = document.createElement('div');
    secondary.style.color = 'var(--text-dim)';
    secondary.style.marginTop = '4px';
    secondary.textContent = line.secondary;
    node.appendChild(secondary);
  }
}

function renderGenerated(state: UiState): void {
  const pane = el<HTMLPreElement>('generated-java');
  const unsupportedBlock = el<HTMLDivElement>('unsupported-features');
  const summary = generatedSummary(state.generated);
  if (!state.generated) {
    setText(pane, summary.headline);
    unsupportedBlock.className = 'unsupported empty';
    clearChildren(unsupportedBlock);
    return;
  }
  const entry = pickEntryFile(state.generated);
  const body = entry ? `// ${entry.path}\n\n${entry.content}` : `// ${summary.headline}\n\n${summary.note}`;
  setText(pane, body);

  if (state.generated.unsupportedFeatures.length === 0 && state.generated.openAssumptions.length === 0) {
    unsupportedBlock.className = 'unsupported empty';
    clearChildren(unsupportedBlock);
    return;
  }
  unsupportedBlock.className = 'unsupported';
  clearChildren(unsupportedBlock);
  if (state.generated.unsupportedFeatures.length > 0) {
    const label = document.createElement('div');
    label.textContent = 'Unsupported W0 features:';
    unsupportedBlock.appendChild(label);
    const list = document.createElement('ul');
    for (const feature of state.generated.unsupportedFeatures) {
      const li = document.createElement('li');
      li.textContent = feature;
      list.appendChild(li);
    }
    unsupportedBlock.appendChild(list);
  }
  if (state.generated.openAssumptions.length > 0) {
    const label = document.createElement('div');
    label.style.marginTop = '6px';
    label.textContent = 'Open assumptions:';
    unsupportedBlock.appendChild(label);
    const list = document.createElement('ul');
    for (const note of state.generated.openAssumptions) {
      const li = document.createElement('li');
      li.textContent = note;
      list.appendChild(li);
    }
    unsupportedBlock.appendChild(list);
  }
}

function renderBuildTest(state: UiState): void {
  const node = el<HTMLDivElement>('build-test');
  const summary = buildTestSummary(state.buildTest);
  node.dataset['status'] = summary.status;
  clearChildren(node);

  if (!state.buildTest) {
    setText(node, summary.headline);
    return;
  }

  const headlineRow = document.createElement('div');
  headlineRow.className = 'row';
  headlineRow.textContent = summary.headline;
  node.appendChild(headlineRow);

  const classRow = document.createElement('div');
  classRow.className = 'row';
  const classLabel = document.createElement('span');
  classLabel.className = 'label';
  classLabel.textContent = 'classification:';
  classRow.appendChild(classLabel);
  classRow.appendChild(document.createTextNode(summary.classification));
  node.appendChild(classRow);

  if (summary.note) {
    const noteRow = document.createElement('div');
    noteRow.className = 'row';
    noteRow.style.color = 'var(--text-dim)';
    noteRow.textContent = summary.note;
    node.appendChild(noteRow);
  }

  const compare = document.createElement('div');
  compare.className = 'compare';
  const expected = document.createElement('pre');
  expected.textContent = `// expected (Golden Master)\n${state.buildTest.expectedOutput || '(none)'}`;
  const actual = document.createElement('pre');
  actual.textContent = `// actual\n${state.buildTest.actualOutput || '(none)'}`;
  compare.appendChild(expected);
  compare.appendChild(actual);
  node.appendChild(compare);
}

function renderEvidence(state: UiState): void {
  const node = el<HTMLDivElement>('evidence');
  const summary = evidenceSummary(state.evidence);
  node.dataset['status'] = summary.status;
  clearChildren(node);

  if (!state.evidence) {
    setText(node, summary.headline);
    return;
  }

  const headline = document.createElement('div');
  headline.textContent = summary.headline;
  node.appendChild(headline);

  if (summary.manifestUri) {
    const ref = document.createElement('div');
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = 'manifest:';
    ref.appendChild(label);
    ref.appendChild(document.createTextNode(' ' + summary.manifestUri));
    node.appendChild(ref);
  }

  if (summary.missing.length > 0) {
    const missing = document.createElement('div');
    missing.className = 'missing';
    missing.textContent = 'Missing artifacts:';
    const list = document.createElement('ul');
    for (const entry of summary.missing) {
      const li = document.createElement('li');
      li.textContent = entry;
      list.appendChild(li);
    }
    missing.appendChild(list);
    node.appendChild(missing);
  }

  if (summary.note) {
    const noteRow = document.createElement('div');
    noteRow.style.color = 'var(--text-dim)';
    noteRow.style.marginTop = '6px';
    noteRow.textContent = summary.note;
    node.appendChild(noteRow);
  }
}

function setStartButtonEnabled(enabled: boolean, helpText: string): void {
  const button = el<HTMLButtonElement>('start-run');
  const help = el<HTMLSpanElement>('start-help');
  button.disabled = !enabled;
  setText(help, helpText);
}

async function refreshRunDetails(api: BffApi, state: UiState, runId: string): Promise<void> {
  const [generated, buildTest, evidence] = await Promise.all([
    api.getGenerated(runId).catch(() => undefined),
    api.getBuildTest(runId).catch(() => undefined),
    api.getEvidence(runId).catch(() => undefined),
  ]);
  state.generated = generated;
  state.buildTest = buildTest;
  state.evidence = evidence;
  renderGenerated(state);
  renderBuildTest(state);
  renderEvidence(state);
}

async function pollRunUntilTerminal(
  api: BffApi,
  state: UiState,
  runId: string,
  options: { maxAttempts?: number; intervalMs?: number } = {},
): Promise<void> {
  const max = options.maxAttempts ?? 10;
  const interval = options.intervalMs ?? 800;
  for (let attempt = 0; attempt < max; attempt += 1) {
    const run = await api.getRun(runId).catch(() => undefined);
    if (run) {
      state.run = run;
      renderRunStatus(state);
      if (run.status === 'completed' || run.status === 'failed') return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

async function bootstrap(api: BffApi): Promise<void> {
  const state: UiState = { samples: [] };

  try {
    const mode = await api.getMode();
    renderModeBadge(modeBadgeFromResponse(mode.orchestrator, mode.evidence));
  } catch (err) {
    renderModeBadge({ mode: 'error', text: err instanceof Error ? err.message : 'mode check failed' });
  }

  try {
    state.samples = await api.listSamples();
  } catch (err) {
    state.samples = [];
    const picker = el<HTMLDivElement>('sample-picker');
    clearChildren(picker);
    const failure = document.createElement('div');
    failure.className = 'error-message';
    failure.textContent = `Failed to load samples: ${err instanceof Error ? err.message : 'unknown error'}`;
    picker.appendChild(failure);
  }

  const onSelect = async (programId: string): Promise<void> => {
    try {
      const detail = await api.getSample(programId);
      state.selectedSample = detail;
      renderSamples(state, onSelect);
      renderCobolPane(state);
      setStartButtonEnabled(true, `Ready to run ${programId}.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'failed to load sample';
      setStartButtonEnabled(false, message);
    }
  };

  renderSamples(state, onSelect);
  renderCobolPane(state);
  renderRunStatus(state);
  renderGenerated(state);
  renderBuildTest(state);
  renderEvidence(state);

  el<HTMLButtonElement>('start-run').addEventListener('click', async () => {
    if (!state.selectedSample) return;
    const programId = state.selectedSample.programId;
    setStartButtonEnabled(false, 'Starting run…');
    try {
      const run = await api.startRun(programId);
      state.run = run;
      renderRunStatus(state);
      await refreshRunDetails(api, state, run.runId);
      if (run.status !== 'completed' && run.status !== 'failed') {
        await pollRunUntilTerminal(api, state, run.runId);
        await refreshRunDetails(api, state, run.runId);
      }
      setStartButtonEnabled(true, `Last run: ${state.run?.status ?? 'unknown'}`);
    } catch (err) {
      const message =
        err instanceof BffError ? `BFF error (${err.status}): ${err.message}` : err instanceof Error ? err.message : 'unknown error';
      setStartButtonEnabled(true, message);
    }
  });
}

const api = createBffApi();
bootstrap(api).catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[c2c-ui] bootstrap failed', err);
  const badge = document.getElementById('mode-badge');
  if (badge) {
    badge.dataset['mode'] = 'error';
    badge.textContent = err instanceof Error ? `error · ${err.message}` : 'error · bootstrap failed';
  }
});

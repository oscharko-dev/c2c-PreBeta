import { BffError, createBffApi, type BffApi } from './api.js';
import {
  buildTestSummary,
  evidenceSummary,
  formatPostStartMetadata,
  formatSourceMetadata,
  generatedSummary,
  isReferenceProgramRunnable,
  learningSummaryView,
  limitationsSummary,
  pickEntryFile,
  pipelineLine,
  pipelineProgressSummary,
  productReadiness,
  referenceLoaderOptions,
  runStatusChip,
  sourceMetadata,
  startButtonState,
} from './view-model.js';
import type {
  BuildTestView,
  EvidenceView,
  GeneratedView,
  LearningView,
  ModeResponse,
  PipelineProgressView,
  RunSummary,
  SampleSummary,
  TransformRequest,
  TransformResponse,
} from './types.js';

interface UiState {
  mode?: ModeResponse;
  modeError?: string;
  samples: SampleSummary[];
  samplesError?: string;
  selectedGeneratedFile?: string;
  run?: RunSummary;
  runError?: string;
  generated?: GeneratedView;
  buildTest?: BuildTestView;
  evidence?: EvidenceView;
  progress?: PipelineProgressView;
  learning?: LearningView;
  generatedError?: string;
  buildTestError?: string;
  evidenceError?: string;
  progressError?: string;
  learningError?: string;
  busy: boolean;
  lastError?: string;
  lastTransform?: TransformResponse;
  lastSourceHashHex?: string;
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

function setHidden(node: HTMLElement, hidden: boolean): void {
  if (hidden) {
    node.setAttribute('hidden', '');
  } else {
    node.removeAttribute('hidden');
  }
}

function renderProductMode(state: UiState): void {
  const chip = el<HTMLDivElement>('product-mode-status');
  const valueNode = chip.querySelector<HTMLElement>('.status-chip-value');
  const readiness = productReadiness(state.mode, state.modeError);
  chip.dataset['tone'] = readiness.tone;
  if (valueNode) setText(valueNode, readiness.label);
}

function renderRunStatusChip(state: UiState): void {
  const chip = el<HTMLDivElement>('run-status-chip');
  const valueNode = chip.querySelector<HTMLElement>('.status-chip-value');
  const summary = runStatusChip(state.run);
  chip.dataset['state'] = summary.state;
  if (valueNode) setText(valueNode, summary.label);
}

function renderStartButton(state: UiState): void {
  const editor = el<HTMLTextAreaElement>('cobol-editor');
  const button = el<HTMLButtonElement>('start-run');
  const help = el<HTMLParagraphElement>('start-help');
  const readiness = productReadiness(state.mode, state.modeError);
  const buttonState = startButtonState({
    sourceText: editor.value,
    productReady: readiness.ready,
    productLabel: readiness.label,
    busy: state.busy,
    ...(state.lastError ? { lastError: state.lastError } : {}),
  });
  button.disabled = !buttonState.enabled;
  button.dataset['busy'] = buttonState.busy ? 'true' : 'false';
  setText(button, buttonState.label);
  setText(help, buttonState.help);
  help.dataset['tone'] = buttonState.helpTone;
  button.setAttribute('aria-busy', buttonState.busy ? 'true' : 'false');
}

function renderSourceMetadata(state: UiState): void {
  const editor = el<HTMLTextAreaElement>('cobol-editor');
  const meta = el<HTMLSpanElement>('source-meta');
  const post = el<HTMLSpanElement>('source-post-start');
  const text = editor.value;
  setText(meta, formatSourceMetadata(sourceMetadata(text)));
  if (state.lastTransform) {
    setText(post, formatPostStartMetadata(state.lastTransform, state.lastSourceHashHex));
    setHidden(post, false);
  } else {
    setText(post, '');
    setHidden(post, true);
  }
}

function renderReferenceLoader(state: UiState): void {
  const select = el<HTMLSelectElement>('reference-loader');
  const previous = select.value;
  clearChildren(select);
  const options = referenceLoaderOptions(state.samples);
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = state.samples.length === 0
    ? state.samplesError
      ? `failed to load: ${state.samplesError}`
      : 'No reference programs available'
    : options.supported.length === 0
      ? 'No runnable reference programs'
      : 'Load reference program…';
  select.appendChild(placeholder);
  if (state.samplesError) {
    placeholder.disabled = true;
  }
  for (const option of options.supported) {
    const node = document.createElement('option');
    node.value = option.programId;
    node.textContent = option.label;
    select.appendChild(node);
  }
  if (options.unsupported.length > 0) {
    const group = document.createElement('optgroup');
    group.label = 'Unavailable (not supported in product mode)';
    for (const option of options.unsupported) {
      const node = document.createElement('option');
      node.value = option.programId;
      node.textContent = option.label;
      node.disabled = true;
      node.title = option.reason;
      group.appendChild(node);
    }
    select.appendChild(group);
  }
  if (previous && options.supported.some((s) => s.programId === previous)) {
    select.value = previous;
  } else {
    select.value = '';
  }
}

function renderPipeline(state: UiState): void {
  const node = el<HTMLDivElement>('pipeline-status');
  clearChildren(node);
  if (state.runError) {
    node.dataset['state'] = 'failed';
    const diag = document.createElement('div');
    diag.className = 'diagnostic';
    diag.textContent = `Failed to refresh run: ${state.runError}`;
    node.appendChild(diag);
    return;
  }
  // Issue #96: prefer the structured progress envelope from the orchestrator
  // when available so the user sees a per-step timeline. Fall back to the
  // run-summary-only line when progress hasn't been fetched yet.
  const summary = pipelineProgressSummary(state.progress, state.run, state.progressError);
  if (state.progress) {
    node.dataset['state'] = summary.state;
    const headline = document.createElement('div');
    headline.className = 'pipeline-headline';
    headline.textContent = summary.headline;
    node.appendChild(headline);
    if (summary.detail) {
      const detail = document.createElement('div');
      detail.style.color = 'var(--text-muted)';
      detail.style.marginTop = '4px';
      detail.textContent = summary.detail;
      node.appendChild(detail);
    }
    if (summary.diagnostic) {
      const diag = document.createElement('div');
      diag.className = 'diagnostic';
      diag.textContent = summary.diagnostic;
      node.appendChild(diag);
    }
    if (summary.hiddenFailedStep) {
      // Issue #96: never collapse a failed step into a generic success panel.
      const warn = document.createElement('div');
      warn.className = 'diagnostic';
      warn.style.marginTop = '4px';
      warn.textContent =
        `Run reported as completed but step ${summary.failedStepLabel} is marked failed; surface this as a failure.`;
      node.appendChild(warn);
    }
    if (summary.steps.length > 0) {
      const list = document.createElement('ol');
      list.className = 'pipeline-steps';
      for (const line of summary.steps) {
        const item = document.createElement('li');
        item.dataset['status'] = line.status;
        const label = document.createElement('span');
        label.className = 'pipeline-step-label';
        label.textContent = line.label;
        item.appendChild(label);
        const status = document.createElement('span');
        status.className = 'pipeline-step-status';
        status.textContent = `· ${line.status}`;
        item.appendChild(status);
        if (line.detail) {
          const detail = document.createElement('div');
          detail.className = 'pipeline-step-detail';
          detail.textContent = line.detail;
          item.appendChild(detail);
        }
        if (line.diagnostic) {
          const diag = document.createElement('div');
          diag.className = 'diagnostic pipeline-step-diagnostic';
          diag.textContent = line.diagnostic;
          item.appendChild(diag);
        }
        list.appendChild(item);
      }
      node.appendChild(list);
    }
    return;
  }
  // Fallback path before progress arrives: render the run-summary line so the
  // user sees something, but never claim success when the run failed.
  const fallback = pipelineLine(state.run);
  node.dataset['state'] = fallback.state;
  const headline = document.createElement('div');
  headline.textContent = fallback.headline;
  node.appendChild(headline);
  if (fallback.detail) {
    const detail = document.createElement('div');
    detail.style.color = 'var(--text-muted)';
    detail.style.marginTop = '4px';
    detail.textContent = fallback.detail;
    node.appendChild(detail);
  }
  if (fallback.diagnostic) {
    const diag = document.createElement('div');
    diag.className = 'diagnostic';
    diag.textContent = fallback.diagnostic;
    node.appendChild(diag);
  }
}

function renderLearning(state: UiState): void {
  const node = el<HTMLDivElement>('learning-summary');
  const view = learningSummaryView(state.learning, state.run, state.learningError);
  node.dataset['status'] = view.status;
  clearChildren(node);
  const headline = document.createElement('div');
  headline.textContent = view.headline;
  node.appendChild(headline);
  if (view.detail) {
    const detail = document.createElement('div');
    detail.style.color = 'var(--text-muted)';
    detail.style.marginTop = '4px';
    detail.textContent = view.detail;
    node.appendChild(detail);
  }
  if (view.patterns.length > 0) {
    const label = document.createElement('div');
    label.style.marginTop = '6px';
    label.textContent = `Observed patterns (${view.patterns.length}):`;
    node.appendChild(label);
    const list = document.createElement('ul');
    list.className = 'bare';
    for (const pattern of view.patterns) {
      const li = document.createElement('li');
      li.textContent = pattern;
      list.appendChild(li);
    }
    node.appendChild(list);
  }
  if (view.endpoint) {
    const endpoint = document.createElement('div');
    endpoint.style.marginTop = '6px';
    endpoint.style.color = 'var(--text-muted)';
    endpoint.textContent = `endpoint: ${view.endpoint}`;
    node.appendChild(endpoint);
  }
}

function renderGenerated(state: UiState): void {
  const viewer = el<HTMLPreElement>('generated-output');
  const noteNode = el<HTMLSpanElement>('generated-note');
  const entryNode = el<HTMLSpanElement>('generated-entry');
  const fileLabel = el<HTMLLabelElement>('generated-file-picker').parentElement as HTMLLabelElement;
  const filePicker = el<HTMLSelectElement>('generated-file-picker');

  const summary = generatedSummary(state.generated, state.run, state.generatedError);
  viewer.dataset['state'] = summary.viewerState;
  setText(entryNode, summary.headline);
  setText(noteNode, summary.note);

  if (summary.viewerState !== 'shown' || !state.generated) {
    setText(viewer, summary.paneText);
    setHidden(fileLabel, true);
    clearChildren(filePicker);
    return;
  }

  // Real product output is available — render file picker and content.
  const filePaths = Object.keys(state.generated.files);
  const pick = pickEntryFile(state.generated, state.selectedGeneratedFile);
  if (!pick) {
    viewer.dataset['state'] = 'empty';
    setText(viewer, 'No generator files emitted for this run.');
    setHidden(fileLabel, true);
    clearChildren(filePicker);
    return;
  }
  setText(viewer, `// ${pick.path}\n\n${pick.content}`);
  if (filePaths.length > 1) {
    setHidden(fileLabel, false);
    const currentValue = filePicker.value;
    clearChildren(filePicker);
    for (const file of filePaths) {
      const option = document.createElement('option');
      option.value = file;
      option.textContent = file;
      filePicker.appendChild(option);
    }
    filePicker.value = pick.path;
    if (currentValue && filePaths.includes(currentValue)) {
      filePicker.value = currentValue;
    }
  } else {
    setHidden(fileLabel, true);
    clearChildren(filePicker);
  }
}

function renderBuildTest(state: UiState): void {
  const node = el<HTMLDivElement>('build-test');
  const summary = buildTestSummary(state.buildTest, state.run, state.buildTestError);
  node.dataset['status'] = summary.status;
  clearChildren(node);
  const headlineRow = document.createElement('div');
  headlineRow.textContent = summary.headline;
  node.appendChild(headlineRow);
  if (summary.note) {
    const noteRow = document.createElement('div');
    noteRow.style.color = 'var(--text-muted)';
    noteRow.style.marginTop = '4px';
    noteRow.textContent = summary.note;
    node.appendChild(noteRow);
  }
  if (summary.isProductResult && state.buildTest) {
    const compare = document.createElement('div');
    compare.className = 'compare';
    const expectedWrap = document.createElement('div');
    const expectedLabel = document.createElement('div');
    expectedLabel.className = 'compare-label';
    expectedLabel.textContent = 'expected (oracle)';
    const expected = document.createElement('pre');
    expected.textContent = state.buildTest.expectedOutput || '(none)';
    expectedWrap.appendChild(expectedLabel);
    expectedWrap.appendChild(expected);

    const actualWrap = document.createElement('div');
    const actualLabel = document.createElement('div');
    actualLabel.className = 'compare-label';
    actualLabel.textContent = 'actual (generated Java)';
    const actual = document.createElement('pre');
    actual.textContent = state.buildTest.actualOutput || '(none)';
    actualWrap.appendChild(actualLabel);
    actualWrap.appendChild(actual);

    compare.appendChild(expectedWrap);
    compare.appendChild(actualWrap);
    node.appendChild(compare);

    const meta: string[] = [];
    if (summary.compileStatus) meta.push(`compile=${summary.compileStatus}`);
    if (summary.executionStatus) meta.push(`execution=${summary.executionStatus}`);
    if (meta.length > 0) {
      const metaRow = document.createElement('div');
      metaRow.style.marginTop = '6px';
      metaRow.style.color = 'var(--text-muted)';
      metaRow.textContent = meta.join(' · ');
      node.appendChild(metaRow);
    }
  }
  if (summary.diagnostics.length > 0) {
    const diagWrap = document.createElement('div');
    diagWrap.style.marginTop = '6px';
    const label = document.createElement('div');
    label.style.fontWeight = '600';
    label.textContent = `Diagnostics (${summary.diagnostics.length}):`;
    diagWrap.appendChild(label);
    const list = document.createElement('ul');
    list.className = 'bare';
    for (const entry of summary.diagnostics) {
      const li = document.createElement('li');
      const level = entry.level || 'info';
      const code = entry.code || '';
      const message = entry.message || '';
      li.textContent = `[${level}] ${code ? `${code}: ` : ''}${message}`;
      list.appendChild(li);
    }
    diagWrap.appendChild(list);
    node.appendChild(diagWrap);
  }
}

function renderEvidence(state: UiState): void {
  const node = el<HTMLDivElement>('evidence');
  const summary = evidenceSummary(state.evidence, state.run, state.evidenceError);
  node.dataset['status'] = summary.status;
  clearChildren(node);
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
  if (summary.manifestHash) {
    const ref = document.createElement('div');
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = 'manifest sha256:';
    ref.appendChild(label);
    ref.appendChild(document.createTextNode(' ' + summary.manifestHash));
    node.appendChild(ref);
  }
  if (summary.validationStatus) {
    const ref = document.createElement('div');
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = 'validation:';
    ref.appendChild(label);
    ref.appendChild(document.createTextNode(' ' + summary.validationStatus));
    node.appendChild(ref);
  }
  if (summary.exportUri) {
    const ref = document.createElement('div');
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = 'export:';
    ref.appendChild(label);
    ref.appendChild(document.createTextNode(' ' + summary.exportUri));
    node.appendChild(ref);
  }
  if (summary.missing.length > 0) {
    const missing = document.createElement('div');
    missing.style.marginTop = '6px';
    missing.style.color = 'var(--warn)';
    missing.textContent = 'Missing artifacts:';
    const list = document.createElement('ul');
    list.className = 'bare';
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
    noteRow.style.color = 'var(--text-muted)';
    noteRow.style.marginTop = '4px';
    noteRow.textContent = summary.note;
    node.appendChild(noteRow);
  }
}

function renderLimitations(state: UiState): void {
  const node = el<HTMLDivElement>('limitations');
  const summary = limitationsSummary(state.generated, state.run);
  node.dataset['state'] = summary.state;
  clearChildren(node);
  const headline = document.createElement('div');
  headline.textContent = summary.headline;
  node.appendChild(headline);
  if (summary.unsupportedFeatures.length > 0) {
    const label = document.createElement('div');
    label.style.marginTop = '6px';
    label.textContent = 'Unsupported features:';
    node.appendChild(label);
    const list = document.createElement('ul');
    list.className = 'bare';
    for (const feature of summary.unsupportedFeatures) {
      const li = document.createElement('li');
      li.textContent = feature;
      list.appendChild(li);
    }
    node.appendChild(list);
  }
  if (summary.openAssumptions.length > 0) {
    const label = document.createElement('div');
    label.style.marginTop = '6px';
    label.textContent = 'Open assumptions:';
    node.appendChild(label);
    const list = document.createElement('ul');
    list.className = 'bare';
    for (const note of summary.openAssumptions) {
      const li = document.createElement('li');
      li.textContent = note;
      list.appendChild(li);
    }
    node.appendChild(list);
  }
}

function renderAll(state: UiState): void {
  renderProductMode(state);
  renderRunStatusChip(state);
  renderStartButton(state);
  renderSourceMetadata(state);
  renderPipeline(state);
  renderGenerated(state);
  renderBuildTest(state);
  renderEvidence(state);
  renderLearning(state);
  renderLimitations(state);
}

async function refreshRunDetails(api: BffApi, state: UiState, runId: string): Promise<void> {
  const [generated, buildTest, evidence, progress, learning] = await Promise.all([
    api.getGenerated(runId).then((value) => ({ value, error: undefined as string | undefined })).catch((err: unknown) => ({
      value: undefined as GeneratedView | undefined,
      error: err instanceof Error ? err.message : 'unknown error',
    })),
    api.getBuildTest(runId).then((value) => ({ value, error: undefined as string | undefined })).catch((err: unknown) => ({
      value: undefined as BuildTestView | undefined,
      error: err instanceof Error ? err.message : 'unknown error',
    })),
    api.getEvidence(runId).then((value) => ({ value, error: undefined as string | undefined })).catch((err: unknown) => ({
      value: undefined as EvidenceView | undefined,
      error: err instanceof Error ? err.message : 'unknown error',
    })),
    api.getProgress(runId).then((value) => ({ value, error: undefined as string | undefined })).catch((err: unknown) => ({
      value: undefined as PipelineProgressView | undefined,
      error: err instanceof Error ? err.message : 'unknown error',
    })),
    api.getLearning(runId).then((value) => ({ value, error: undefined as string | undefined })).catch((err: unknown) => ({
      value: undefined as LearningView | undefined,
      error: err instanceof Error ? err.message : 'unknown error',
    })),
  ]);
  state.generated = generated.value;
  state.generatedError = generated.error;
  state.buildTest = buildTest.value;
  state.buildTestError = buildTest.error;
  state.evidence = evidence.value;
  state.evidenceError = evidence.error;
  state.progress = progress.value;
  state.progressError = progress.error;
  state.learning = learning.value;
  state.learningError = learning.error;
}

async function pollRunUntilTerminal(
  api: BffApi,
  state: UiState,
  runId: string,
  options: { maxAttempts?: number; intervalMs?: number } = {},
): Promise<void> {
  const max = options.maxAttempts ?? 30;
  const interval = options.intervalMs ?? 1000;
  for (let attempt = 0; attempt < max; attempt += 1) {
    try {
      const run = await api.getRun(runId);
      state.run = run;
      state.runError = undefined;
      // Issue #96: refresh per-step progress on each tick so the UI shows
      // the current step + completed step list while the run is in flight.
      try {
        state.progress = await api.getProgress(runId);
        state.progressError = undefined;
      } catch (err) {
        state.progressError = err instanceof Error ? err.message : 'unknown error';
      }
      renderRunStatusChip(state);
      renderPipeline(state);
      if (run.status === 'completed' || run.status === 'failed') return;
    } catch (err) {
      state.runError = err instanceof Error ? err.message : 'unknown error';
      renderPipeline(state);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, interval));
  }
}

async function computeSha256Hex(text: string): Promise<string | undefined> {
  try {
    if (typeof globalThis.crypto?.subtle?.digest === 'function' && typeof TextEncoder !== 'undefined') {
      const encoded = new TextEncoder().encode(text);
      const digest = await globalThis.crypto.subtle.digest('SHA-256', encoded);
      return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof BffError) return `BFF error (${err.status}): ${err.message}`;
  if (err instanceof Error) return err.message;
  return 'unknown error';
}

async function bootstrap(api: BffApi): Promise<void> {
  const state: UiState = { samples: [], busy: false };
  const editor = el<HTMLTextAreaElement>('cobol-editor');
  const referenceLoader = el<HTMLSelectElement>('reference-loader');
  const startButton = el<HTMLButtonElement>('start-run');
  const filePicker = el<HTMLSelectElement>('generated-file-picker');

  try {
    state.mode = await api.getMode();
  } catch (err) {
    state.modeError = errorMessage(err);
  }

  try {
    state.samples = await api.listSamples();
  } catch (err) {
    state.samples = [];
    state.samplesError = errorMessage(err);
  }

  renderReferenceLoader(state);
  renderAll(state);

  editor.addEventListener('input', () => {
    state.lastError = undefined;
    renderStartButton(state);
    renderSourceMetadata(state);
  });

  referenceLoader.addEventListener('change', async () => {
    const programId = referenceLoader.value;
    if (!programId) return;
    const summary = state.samples.find((s) => s.programId === programId);
    if (!isReferenceProgramRunnable(summary)) {
      state.lastError = `reference program ${programId} is not supported in product mode`;
      referenceLoader.value = '';
      renderStartButton(state);
      return;
    }
    try {
      const sample = await api.getSample(programId);
      editor.value = sample.cobolSource;
      state.lastTransform = undefined;
      state.lastSourceHashHex = undefined;
      state.lastError = undefined;
      renderSourceMetadata(state);
      renderStartButton(state);
      editor.focus();
    } catch (err) {
      state.lastError = errorMessage(err);
      renderStartButton(state);
    }
  });

  filePicker.addEventListener('change', () => {
    state.selectedGeneratedFile = filePicker.value || undefined;
    renderGenerated(state);
  });

  startButton.addEventListener('click', async () => {
    const sourceText = editor.value;
    if (sourceText.trim().length === 0) return;
    const readiness = productReadiness(state.mode, state.modeError);
    if (!readiness.ready) return;

    state.busy = true;
    state.lastError = undefined;
    state.run = undefined;
    state.runError = undefined;
    state.generated = undefined;
    state.generatedError = undefined;
    state.buildTest = undefined;
    state.buildTestError = undefined;
    state.evidence = undefined;
    state.evidenceError = undefined;
    state.progress = undefined;
    state.progressError = undefined;
    state.learning = undefined;
    state.learningError = undefined;
    state.selectedGeneratedFile = undefined;
    state.lastTransform = undefined;
    state.lastSourceHashHex = undefined;
    renderAll(state);

    try {
      const sourceHashHex = await computeSha256Hex(sourceText);
      state.lastSourceHashHex = sourceHashHex;
      const request: TransformRequest = { sourceText };
      const detected = sourceMetadata(sourceText).programId;
      if (detected) request.programId = detected;
      const transform = await api.transform(request);
      state.lastTransform = transform;
      renderSourceMetadata(state);
      try {
        state.run = await api.getRun(transform.runId);
      } catch (err) {
        state.runError = errorMessage(err);
      }
      renderRunStatusChip(state);
      renderPipeline(state);
      await refreshRunDetails(api, state, transform.runId);
      renderGenerated(state);
      renderBuildTest(state);
      renderEvidence(state);
      renderPipeline(state);
      renderLearning(state);
      renderLimitations(state);
      if (state.run && state.run.status !== 'completed' && state.run.status !== 'failed') {
        await pollRunUntilTerminal(api, state, transform.runId);
        await refreshRunDetails(api, state, transform.runId);
      } else if (!state.run && transform.status !== 'completed' && transform.status !== 'failed') {
        await pollRunUntilTerminal(api, state, transform.runId);
        await refreshRunDetails(api, state, transform.runId);
      }
    } catch (err) {
      state.lastError = errorMessage(err);
    } finally {
      state.busy = false;
      renderAll(state);
    }
  });
}

const api = createBffApi();
bootstrap(api).catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('[c2c-ui] bootstrap failed', err);
  const productChip = document.getElementById('product-mode-status');
  if (productChip) {
    productChip.dataset['tone'] = 'error';
    const value = productChip.querySelector<HTMLElement>('.status-chip-value');
    if (value) value.textContent = err instanceof Error ? err.message : 'bootstrap failed';
  }
});

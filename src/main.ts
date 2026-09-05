import './style.css';
import { Pane } from 'tweakpane';
import { InkEngine } from './ink-engine';
import { defaults, googleFonts, presets } from './settings';
import type { Settings, SourceMode } from './settings';

function element<T extends HTMLElement>(selector: string): T {
  const result = document.querySelector<T>(selector);
  if (!result) throw new Error(`Missing UI element: ${selector}`);
  return result;
}

const settings: Settings = { ...defaults };
const engine = new InkEngine(settings);
const root = element<HTMLDivElement>('#app');
root.innerHTML = `
  <main id="studio" data-mode="text" data-paused="false" data-phase="wet">
    <div id="scene-host" aria-busy="true"></div>
    <div id="brush-cursor" aria-hidden="true"></div>
    <aside id="controls" aria-label="Ink controls"><div id="tweakpane"></div></aside>
    <button id="restore-controls" aria-label="Controls" hidden>Controls</button>
    <div id="status" role="status" aria-live="polite" hidden></div>
    <div id="loading" role="status">Loading…</div>
    <div id="fatal-error" role="alert" hidden></div>
    <input id="image-input" aria-label="Image file" type="file" accept="image/png,image/jpeg,image/webp,image/avif" hidden />
  </main>
`;

const studio = element('#studio');
const scene = element('#scene-host');
const controls = element('#controls');
const restoreControls = element('#restore-controls');
const imageInput = element<HTMLInputElement>('#image-input');
const abort = new AbortController();
const listenerOptions = { signal: abort.signal };
const smallScreen = window.matchMedia('(max-width: 600px)');
const folderState = new Map<string, boolean>();
let pane: Pane | undefined;
let pauseButton: ReturnType<Pane['addButton']> | undefined;
let paneExpanded = !smallScreen.matches;
let rebuildPending = false;
let initialized = false;
let disposed = false;
let statusTimeout: ReturnType<typeof setTimeout> | undefined;
let lastUpdate = 0;

function notify(message: string) {
  if (disposed) return;
  const status = element('#status');
  status.textContent = message;
  status.hidden = false;
  clearTimeout(statusTimeout);
  statusTimeout = setTimeout(() => { status.hidden = true; }, 4200);
}

function fail(error: unknown) {
  if (disposed) return;
  console.error(error);
  element('#loading').hidden = true;
  const message = error instanceof Error ? error.message : String(error);
  element('#fatal-error').textContent = `${message} Check WebGL support and reload.`;
  element('#fatal-error').hidden = false;
  scene.setAttribute('aria-busy', 'false');
}

function queuePane() {
  if (rebuildPending || disposed) return;
  rebuildPending = true;
  // Finish the Tweakpane event before disposing any of its controls.
  queueMicrotask(() => {
    rebuildPending = false;
    if (!disposed) makePane();
  });
}

function labelFolder(folder: ReturnType<Pane['addFolder']>) {
  const button = folder.element.querySelector<HTMLButtonElement>(':scope > button');
  button?.setAttribute('aria-expanded', String(folder.expanded));
  folder.on('fold', () => button?.setAttribute('aria-expanded', String(folder.expanded)));
}

function makePane() {
  pane?.dispose();
  pane = new Pane({ container: element('#tweakpane'), title: 'Controls', expanded: paneExpanded });
  labelFolder(pane);
  pane.on('fold', () => { paneExpanded = pane!.expanded; });
  const folder = (title: string, parent: ReturnType<Pane['addFolder']> = pane!) => {
    const child = parent.addFolder({ title, expanded: folderState.get(title) ?? false });
    child.on('fold', () => folderState.set(title, child.expanded));
    labelFolder(child);
    return child;
  };
  const sourceChanged = () => engine.applySettings(true);
  const inkChanged = () => {
    settings.preset = 'Custom';
    engine.applySettings();
    presetBinding.refresh();
  };

  pane.addBinding(settings, 'mode', { label: 'Source', options: { Text: 'text', Draw: 'draw', Image: 'image' } })
    .on('change', () => setMode(settings.mode));
  if (settings.mode === 'text') {
    pane.addBinding(settings, 'text', { label: 'Text' })
      .on('change', (event) => { if (event.last) sourceChanged(); });
  } else if (settings.mode === 'draw') {
    pane.addBinding(settings, 'brushSize', { label: 'Brush size', min: 2, max: 100, step: 1 })
      .on('change', () => { engine.applySettings(); updateCursorSize(); });
  } else {
    pane.addButton({ title: 'Choose image' }).on('click', () => imageInput.click());
  }
  if (settings.mode !== 'draw') {
    pane.addBinding(settings, 'reveal', { label: 'Reveal', options: { 'Write-on': 'write-on', 'Ink drops': 'drops' } })
      .on('change', () => { sourceChanged(); queuePane(); });
  }
  pane.addBinding(settings, 'color', { label: 'Ink color', view: 'color' }).on('change', inkChanged);
  pane.addBinding(settings, 'density', { label: 'Pigment', min: 0.15, max: 1.4, step: 0.01 }).on('change', inkChanged);
  if (settings.model === 'tutorial') {
    pane.addBinding(settings, 'displacement', { label: 'Displace / 4K', min: 0, max: 30, step: 0.5 })
      .on('change', (event) => { if (event.last) sourceChanged(); });
  } else {
    pane.addBinding(settings, 'spread', { label: 'Bleed', min: 0, max: 1.5, step: 0.01 })
      .on('change', (event) => { inkChanged(); if (event.last) sourceChanged(); });
  }

  const source = folder('Source settings');
  if (settings.mode === 'text') {
    source.addBinding(settings, 'font', {
      label: 'Typeface', options: {
        'Editorial serif': 'Georgia', 'Classic serif': 'Times New Roman',
        'Clean sans': 'Arial', 'Typewriter': 'Courier New',
        ...Object.fromEntries(googleFonts.map((font) => [font, font])),
      },
    });
    source.addBinding(settings, 'fontSize', { label: 'Size', min: 40, max: 280, step: 1 });
    source.addBinding(settings, 'italic', { label: 'Italic' });
    source.addBinding(settings, 'bold', { label: 'Bold' });
  } else if (settings.mode === 'draw') {
    source.addBinding(settings, 'fadeDelay', { label: 'Hold / sec', min: 0, max: 10, step: 0.1 });
    source.addBinding(settings, 'fadeDuration', { label: 'Fade / sec', min: 0.5, max: 15, step: 0.1 });
  } else {
    source.addBinding(settings, 'imageChannel', { label: 'Mask from', options: { Darkness: 'luminance', Transparency: 'alpha' } });
    source.addBinding(settings, 'imageScale', { label: 'Scale', min: 0.15, max: 1, step: 0.01 });
    source.addBinding(settings, 'imageThreshold', { label: 'Threshold', min: 0, max: 1, step: 0.01 });
    source.addBinding(settings, 'imageContrast', { label: 'Contrast', min: 0.5, max: 5, step: 0.05 });
    source.addBinding(settings, 'invertImage', { label: 'Invert' });
  }
  if (settings.model === 'tutorial') {
    if (settings.mode !== 'draw' && settings.reveal === 'drops') {
      source.addBinding(settings, 'dropSize', { label: 'Drop size', min: 4, max: 80, step: 1 });
      source.addBinding(settings, 'dropSpacing', { label: 'Drop spacing', min: 40, max: 400, step: 10 });
    } else {
      source.addBinding(settings, 'seedWidth', { label: 'Pen / 4K px', min: 1, max: 12, step: 0.5 })
        .on('change', (event) => { if (event.last && settings.mode === 'draw') sourceChanged(); });
    }
  }
  if (settings.mode !== 'draw' && settings.reveal === 'drops') {
    source.addBinding(settings, 'dropStagger', { label: 'Drop stagger / sec', min: 0, max: 10, step: 0.1 });
  }
  source.on('change', (event) => {
    if (event.last) engine.applySettings(settings.mode !== 'draw');
  });

  const appearance = folder('Appearance');
  const presetBinding = appearance.addBinding(settings, 'preset', {
    label: 'Preset', options: Object.fromEntries([...Object.keys(presets), 'Custom'].map((name) => [name, name])),
  }).on('change', () => {
    if (settings.preset === 'Custom') return;
    Object.assign(settings, presets[settings.preset]);
    sourceChanged();
    queuePane();
  });
  appearance.addBinding(settings, 'grain', { label: 'Paper grain', min: 0, max: 1, step: 0.01 }).on('change', inkChanged);
  appearance.addBinding(settings, 'edge', { label: 'Edge pooling', min: 0, max: 1, step: 0.01 }).on('change', inkChanged);
  appearance.addBinding(settings, 'paperStrength', { label: 'Texture', min: 0, max: 1, step: 0.01 })
    .on('change', () => engine.applySettings());

  const advanced = folder('Advanced');
  advanced.addBinding(settings, 'model', { label: 'Model', options: { 'Tutorial / Time Blend': 'tutorial', 'Capillary study': 'capillary' } })
    .on('change', () => {
      settings.diagnostic = 'ink';
      sourceChanged();
      queuePane();
    });
  advanced.addBinding(settings, 'diagnostic', {
    label: 'View',
    options: settings.model === 'tutorial'
      ? { 'Finished ink': 'ink', 'Ink source': 'source', 'Target shape': 'target', 'Displacement map': 'displacement' }
      : { 'Finished ink': 'ink', 'Ink source': 'source', 'Target shape': 'target' },
  }).on('change', () => engine.applySettings());
  if (settings.model === 'tutorial') {
    advanced.addBinding(settings, 'accumulation', { label: 'Accumulation', min: 0.8, max: 1, step: 0.005 })
      .on('change', (event) => { if (event.last) sourceChanged(); });
    advanced.addBinding(settings, 'medianRadius', { label: 'Median / 4K', min: 0, max: 8, step: 0.5 })
      .on('change', (event) => { if (event.last) sourceChanged(); });
  } else {
    advanced.addBinding(settings, 'turbulence', { label: 'Irregularity', min: 0, max: 1, step: 0.01 })
      .on('change', (event) => { inkChanged(); if (event.last) sourceChanged(); });
  }
  advanced.addBinding(settings, 'dryTime', { label: settings.model === 'tutorial' ? 'Settle / sec' : 'Dry / sec', min: 1, max: 15, step: 0.1 })
    .on('change', (event) => { if (event.last) sourceChanged(); });
  advanced.addBinding(settings, 'revealDuration', { label: 'Reveal / sec', min: 0.5, max: 10, step: 0.1 })
    .on('change', (event) => { if (event.last) sourceChanged(); });
  advanced.addBinding(settings, 'speed', { label: 'Speed', min: 0.25, max: 2, step: 0.05 })
    .on('change', () => engine.applySettings());
  advanced.addBinding(settings, 'seed', { label: 'Paper seed', min: 1, max: 999, step: 1 })
    .on('change', (event) => { if (event.last) engine.applySettings(true, true); });
  if (settings.model === 'tutorial') {
    const map = folder('Displacement map', advanced);
    map.addBinding(settings, 'targetFeather', { label: 'Blur / 4K px', min: 0, max: 60, step: 1 });
    map.addBinding(settings, 'edgeSoftness', { label: 'Edge / 4K px', min: 0, max: 10, step: 0.5 });
    map.addBinding(settings, 'complexity', { label: 'Complexity', min: 1, max: 10, step: 1 });
    map.addBinding(settings, 'subInfluence', { label: 'Sub-influence', min: 0.1, max: 0.95, step: 0.01 });
    map.addBinding(settings, 'exteriorNoise', { label: 'Outside noise', min: 0, max: 0.3, step: 0.01 });
    map.on('change', (event) => { if (event.last) sourceChanged(); });
  }
  folder('Quality', advanced).addBinding(settings, 'quality', {
    label: 'Resolution', options: { 'Draft / 900': 900, 'Balanced / 1400': 1400, 'Fine / 2000': 2000 },
  }).on('change', () => engine.setQuality());

  pane.addButton({ title: 'Replay' }).on('click', replay);
  const actions = folder('Actions');
  pauseButton = actions.addButton({ title: engine.paused ? 'Resume' : 'Pause' }).on('click', togglePause);
  actions.addButton({ title: 'Clear' }).on('click', clear);
  actions.addButton({ title: 'Save PNG' }).on('click', () => {
    void engine.exportPng().catch((error: unknown) => notify(error instanceof Error ? error.message : 'Could not save PNG.'));
  });
  actions.addButton({ title: 'Reset controls' }).on('click', () => {
    Object.assign(settings, defaults);
    engine.paused = false;
    engine.setMode('text');
    engine.setQuality();
    engine.applySettings(true, true);
    updateModeUi();
  });

  element('#tweakpane').querySelectorAll<HTMLElement>('.tp-lblv').forEach((row) => {
    const label = row.querySelector('.tp-lblv_l')?.textContent;
    if (!label) return;
    row.querySelectorAll('input, select, button').forEach((input) => {
      if (!input.hasAttribute('aria-label')) input.setAttribute('aria-label', label);
    });
  });
  if (settings.mode === 'text') element<HTMLInputElement>('#tweakpane input[aria-label="Text"]').maxLength = 500;
}

function setMode(mode: SourceMode) {
  engine.setMode(mode);
  updateModeUi();
}

function updateModeUi() {
  studio.dataset.mode = settings.mode;
  queuePane();
  updateCursorSize();
  updateUi(true);
}

function updateUi(force = false) {
  if (disposed || (!force && performance.now() - lastUpdate < 100)) return;
  lastUpdate = performance.now();
  const dry = engine.settled;
  if (pauseButton) pauseButton.title = engine.paused ? 'Resume' : 'Pause';
  studio.dataset.paused = String(engine.paused);
  studio.dataset.phase = engine.paused ? 'paused' : dry ? 'dry' : 'wet';
}

function updateCursorSize() {
  element('#brush-cursor').style.width = `${settings.brushSize}px`;
  element('#brush-cursor').style.height = `${settings.brushSize}px`;
}

function toggleControls() {
  controls.hidden = !controls.hidden;
  restoreControls.hidden = !controls.hidden;
  if (!controls.hidden) pane?.element.querySelector<HTMLButtonElement>(':scope > button')?.focus();
}

function replay() {
  engine.paused = false;
  engine.replay();
  updateUi(true);
}

function togglePause() {
  engine.togglePause();
  updateUi(true);
}

function clear() {
  engine.clear();
  updateUi(true);
}

async function upload(file: File) {
  try {
    if (!await engine.loadImage(file) || disposed) return;
    element('#status').hidden = true;
    updateModeUi();
  } catch (error) {
    notify(error instanceof Error ? error.message : 'Could not decode image.');
  }
}

imageInput.addEventListener('change', () => {
  const file = imageInput.files?.[0];
  if (file) void upload(file);
  imageInput.value = '';
}, listenerOptions);
studio.addEventListener('dragover', (event) => {
  if (event.dataTransfer?.types.includes('Files')) {
    event.preventDefault();
    studio.classList.add('dragging');
  }
}, listenerOptions);
studio.addEventListener('dragleave', (event) => {
  if (!studio.contains(event.relatedTarget as Node | null)) studio.classList.remove('dragging');
}, listenerOptions);
studio.addEventListener('drop', (event) => {
  event.preventDefault();
  studio.classList.remove('dragging');
  const file = event.dataTransfer?.files[0];
  if (file && initialized) void upload(file);
}, listenerOptions);
restoreControls.addEventListener('click', toggleControls, listenerOptions);
scene.addEventListener('ink-error', (event) => fail((event as CustomEvent<string>).detail), listenerOptions);
scene.addEventListener('pointermove', (event) => {
  const cursor = element('#brush-cursor');
  cursor.style.left = `${event.clientX}px`;
  cursor.style.top = `${event.clientY}px`;
  cursor.classList.add('visible');
}, listenerOptions);
scene.addEventListener('pointerleave', () => element('#brush-cursor').classList.remove('visible'), listenerOptions);
smallScreen.addEventListener('change', () => {
  if (smallScreen.matches) {
    paneExpanded = false;
    if (pane) pane.expanded = false;
  }
}, listenerOptions);
window.addEventListener('keydown', (event) => {
  if (!initialized) return;
  const target = event.target;
  if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]')) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.code === 'Space') {
    if (target instanceof HTMLElement && target.closest('button')) return;
    event.preventDefault();
    togglePause();
  } else if (event.key.toLowerCase() === 'r') replay();
  else if (event.key.toLowerCase() === 'c') clear();
  else if (event.key.toLowerCase() === 'h') toggleControls();
}, listenerOptions);

engine.onUpdate = () => updateUi();
engine.onError = notify;
engine.init(scene).then(() => {
  if (disposed) { engine.destroy(); return; }
  initialized = true;
  engine.app.canvas.id = 'scene';
  makePane();
  updateCursorSize();
  updateUi(true);
  element('#loading').hidden = true;
  scene.setAttribute('aria-busy', 'false');
  studio.dataset.ready = 'true';
  if (import.meta.env.DEV) window.__inkStudio = { engine, settings, setMode };
}).catch(fail);

declare global {
  interface Window {
    __inkStudio?: { engine: InkEngine; settings: Settings; setMode: (mode: SourceMode) => void };
  }
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    disposed = true;
    abort.abort();
    pane?.dispose();
    if (initialized) engine.destroy();
    if (window.__inkStudio?.engine === engine) delete window.__inkStudio;
    clearTimeout(statusTimeout);
  });
}

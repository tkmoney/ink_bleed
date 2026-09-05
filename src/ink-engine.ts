import {
  Application, Assets, Container, Texture, UniformGroup,
} from 'pixi.js';
import type { RenderTexture } from 'pixi.js';
import type { Settings, SourceMode } from './settings';
import { googleFonts, hexToRgb } from './settings';
import { mediumFragment, simulationFragment, compositeFragment } from './shaders';
import { createPass, createTarget, destroyPass, resizePass } from './gpu-pass';
import type { GpuPass } from './gpu-pass';
import { TutorialPipeline } from './tutorial-pipeline';
import { createInkSeeds } from './source-seeds';
import type { InkDrop } from './source-seeds';

interface Point { x: number; y: number; pressure: number }
interface Stroke { points: Point[]; size: number; born: number }

function context2d(canvas: HTMLCanvasElement, read = false): CanvasRenderingContext2D {
  const context = canvas.getContext('2d', { willReadFrequently: read });
  if (!context) throw new Error('This browser could not create a 2D source canvas.');
  return context;
}

export class InkEngine {
  readonly app = new Application();
  readonly settings: Settings;
  elapsed = 0;
  paused = false;
  frame = 0;
  imageName = '';
  onUpdate: (() => void) | undefined;
  onError: ((message: string) => void) | undefined;
  private fontGeneration = 0;
  private size = { width: 1, height: 1 };
  private screen = { width: 1, height: 1 };
  private sourceCanvas = document.createElement('canvas');
  private sourceContext = context2d(this.sourceCanvas);
  private sourceTexture = Texture.from(this.sourceCanvas);
  private targetCanvas = document.createElement('canvas');
  private targetContext = context2d(this.targetCanvas, true);
  private targetTexture = Texture.from(this.targetCanvas);
  private targetDirty = false;
  private imageCanvas = document.createElement('canvas');
  private imageContext = context2d(this.imageCanvas, true);
  private hasImage = false;
  private strokes: Stroke[] = [];
  private scheduledDrops: InkDrop[] = [];
  private nextDrop = 0;
  private activeStroke: Stroke | undefined;
  private sourceDirty = false;
  private clearSource = false;
  private pointerId: number | undefined;
  private accumulator = 0;
  private renderDirty = true;
  private current!: RenderTexture;
  private next!: RenderTexture;
  private medium!: RenderTexture;
  private paper!: Texture;
  private simulation!: GpuPass;
  private mediumMesh!: GpuPass;
  private composite!: GpuPass;
  private tutorial!: TutorialPipeline;
  private empty = new Container();
  private simUniforms = new UniformGroup({
    uSize: { value: new Float32Array([1, 1]), type: 'vec2<f32>' },
    uBounds: { value: new Float32Array([0, 0, 1, 1]), type: 'vec4<f32>' },
    uStep: { value: 1 / 60, type: 'f32' },
    uTime: { value: 0, type: 'f32' },
    uFrame: { value: 0, type: 'f32' },
    uSpread: { value: 0.65, type: 'f32' },
    uTurbulence: { value: 0.65, type: 'f32' },
    uDryTime: { value: 6, type: 'f32' },
    uLifetime: { value: 7.5, type: 'f32' },
    uFadeDuration: { value: 5, type: 'f32' },
    uDrawing: { value: 0, type: 'f32' },
    uRevealDuration: { value: 3.8, type: 'f32' },
    uDrops: { value: 0, type: 'f32' },
    uDropStagger: { value: 0, type: 'f32' },
    uSeed: { value: 12, type: 'f32' },
  });
  private mediumUniforms = new UniformGroup({
    uSize: { value: new Float32Array([1, 1]), type: 'vec2<f32>' },
    uPaperScale: { value: new Float32Array([1, 1]), type: 'vec2<f32>' },
    uSeed: { value: 12, type: 'f32' },
  });
  private displayUniforms = new UniformGroup({
    uSize: { value: new Float32Array([1, 1]), type: 'vec2<f32>' },
    uPaperScale: { value: new Float32Array([1, 1]), type: 'vec2<f32>' },
    uInkColor: { value: hexToRgb('#252833'), type: 'vec3<f32>' },
    uDensity: { value: 0.86, type: 'f32' },
    uGrain: { value: 0.42, type: 'f32' },
    uEdge: { value: 0.48, type: 'f32' },
    uPaperStrength: { value: 1, type: 'f32' },
    uTurbulence: { value: 0.65, type: 'f32' },
    uTutorial: { value: 1, type: 'f32' },
    uDiagnostic: { value: 0, type: 'f32' },
    uLiveSource: { value: 0, type: 'f32' },
  });
  private abort = new AbortController();
  private resizeObserver: ResizeObserver | undefined;
  private uploadGeneration = 0;

  constructor(settings: Settings) {
    this.settings = settings;
  }

  async init(host: HTMLElement) {
    await this.app.init({
      preference: 'webgl',
      resizeTo: host,
      resolution: Math.min(window.devicePixelRatio || 1, 1.5),
      autoDensity: true,
      antialias: false,
      backgroundAlpha: 1,
      preserveDrawingBuffer: true,
      autoStart: false,
    });
    this.app.ticker.remove(this.app.render, this.app);
    this.paper = await Assets.load<Texture>(`${import.meta.env.BASE_URL}textures/paper-308l.jpg`);
    host.appendChild(this.app.canvas);
    this.app.canvas.setAttribute('aria-label', 'Interactive ink on paper canvas');
    this.app.canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.app.stop();
      host.dispatchEvent(new CustomEvent('ink-error', {
        detail: 'The graphics context was lost. Reload the page to restart the ink simulation.',
      }));
    }, { signal: this.abort.signal });
    this.current = createTarget();
    this.next = createTarget();
    this.medium = createTarget();
    this.tutorial = new TutorialPipeline(this.app, this.settings, this.sourceTexture, this.targetTexture, this.simUniforms);
    this.simulation = createPass(simulationFragment, {
      inkUniforms: this.simUniforms,
      uState: this.current.source,
      uSource: this.sourceTexture.source,
      uMedium: this.medium.source,
    });
    this.mediumMesh = createPass(mediumFragment, {
      mediumUniforms: this.mediumUniforms,
      uPaper: this.paper.source,
    });
    this.composite = createPass(compositeFragment, {
      displayUniforms: this.displayUniforms,
      uState: this.current.source,
      uMedium: this.medium.source,
      uPaper: this.paper.source,
      uSource: this.sourceTexture.source,
      uTarget: this.targetTexture.source,
      uDisplacement: this.tutorial.field.source,
    });
    this.app.stage.addChild(this.composite);
    this.resize(host.clientWidth, host.clientHeight);
    this.resizeObserver = new ResizeObserver(() => this.resize(host.clientWidth, host.clientHeight));
    this.resizeObserver.observe(host);
    this.bindPointer();
    this.app.ticker.maxFPS = 60;
    this.app.ticker.add((ticker) => this.tick(ticker.deltaMS / 1000));
    this.app.start();
  }

  private resize(width: number, height: number) {
    if (width < 1 || height < 1) return;
    const scale = Math.min(1, this.settings.quality / Math.max(width, height));
    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    if (this.size.width === w && this.size.height === h &&
      this.screen.width === width && this.screen.height === height) return;
    this.screen = { width, height };
    this.size = { width: w, height: h };
    this.app.renderer.resize(width, height);
    this.current.resize(w, h);
    this.next.resize(w, h);
    this.medium.resize(w, h);
    this.sourceCanvas.width = w;
    this.sourceCanvas.height = h;
    this.sourceTexture.source.resize(w, h);
    this.targetCanvas.width = w;
    this.targetCanvas.height = h;
    this.targetTexture.source.resize(w, h);
    this.tutorial.resize(w, h);
    resizePass(this.simulation, w, h);
    resizePass(this.mediumMesh, w, h);
    resizePass(this.composite, width, height);
    const paperAspect = this.paper.width / this.paper.height;
    const aspect = width / height;
    const paperScale = aspect > paperAspect ? [1, paperAspect / aspect] : [aspect / paperAspect, 1];
    this.mediumUniforms.uniforms.uSize.set([w, h]);
    this.mediumUniforms.uniforms.uPaperScale.set(paperScale);
    this.displayUniforms.uniforms.uSize.set([w, h]);
    this.displayUniforms.uniforms.uPaperScale.set(paperScale);
    this.simUniforms.uniforms.uSize.set([w, h]);
    this.regenerateMedium();
    this.replay();
  }

  private regenerateMedium() {
    this.mediumUniforms.uniforms.uSeed = this.settings.seed;
    this.app.renderer.render({ container: this.mediumMesh, target: this.medium, clear: true });
  }

  applySettings(resetSource = false, regenerate = false) {
    this.renderDirty = true;
    const s = this.settings;
    Object.assign(this.simUniforms.uniforms, {
      uSpread: s.spread * this.size.width / this.screen.width,
      uTurbulence: s.turbulence,
      uDryTime: s.dryTime,
      uLifetime: s.fadeDelay + s.fadeDuration,
      uFadeDuration: s.fadeDuration,
      uDrawing: s.mode === 'draw' ? 1 : 0,
      uRevealDuration: s.revealDuration,
      uDrops: s.reveal === 'drops' ? 1 : 0,
      uDropStagger: s.dropStagger,
      uSeed: s.seed,
      uStep: s.model === 'tutorial' ? 1 / 24 : 1 / 60,
    });
    Object.assign(this.displayUniforms.uniforms, {
      uInkColor: hexToRgb(s.color), uDensity: s.density, uGrain: s.grain,
      uEdge: s.edge, uPaperStrength: s.paperStrength, uTurbulence: s.turbulence,
      uTutorial: s.model === 'tutorial' ? 1 : 0,
      uDiagnostic: ['ink', 'source', 'target', 'displacement'].indexOf(s.diagnostic),
      uLiveSource: s.mode === 'draw' || (s.model === 'tutorial' && this.staggerDuration > 0) ? 1 : 0,
    });
    this.tutorial.applySettings();
    if (regenerate) this.regenerateMedium();
    if (resetSource) this.replay();
  }

  setQuality() {
    this.resize(this.screen.width, this.screen.height);
  }

  setMode(mode: SourceMode) {
    this.finishStroke();
    this.settings.mode = mode;
    this.replay();
  }

  private get staggerDuration() {
    return this.settings.mode !== 'draw' && this.settings.reveal === 'drops' ? this.settings.dropStagger : 0;
  }

  private get settleAt() {
    return this.settings.revealDuration + this.staggerDuration + this.settings.dryTime
      + (this.settings.model === 'capillary' ? 0.5 : 0);
  }

  get settled() {
    return this.settings.mode !== 'draw' && this.elapsed >= this.settleAt;
  }

  private clearState() {
    this.fontGeneration++;
    this.renderDirty = true;
    for (const target of [this.current, this.next]) {
      this.app.renderer.render({ container: this.empty, target, clear: true, clearColor: [0, 0, 0, 1] });
    }
    this.elapsed = 0;
    this.frame = 0;
    this.accumulator = 0;
    this.scheduledDrops = [];
    this.nextDrop = 0;
    this.composite.shader!.resources.uState = this.current.source;
  }

  replay() {
    this.applySettings();
    this.clearState();
    this.paintSource();
    this.onUpdate?.();
  }

  clear() {
    this.finishStroke();
    this.strokes = [];
    this.clearState();
    this.sourceContext.clearRect(0, 0, this.size.width, this.size.height);
    this.sourceTexture.source.update();
    this.targetContext.clearRect(0, 0, this.size.width, this.size.height);
    this.updateTarget();
    this.clearSource = false;
    this.sourceDirty = false;
    // A cleared static source stays blank until replay or a source change.
    this.elapsed = this.settleAt + 1;
    this.onUpdate?.();
  }

  private contentRect() {
    return {
      x: this.size.width * 0.5,
      y: this.size.height * 0.5,
      maxWidth: this.size.width * 0.8,
      maxHeight: this.size.height * 0.6,
    };
  }

  private textFontReady() {
    const family = this.settings.font;
    if (!googleFonts.includes(family)) return true;
    const font = `16px "${family}"`;
    const text = this.settings.text.slice(0, 500) || ' ';
    const registered = [...document.fonts].some((face) => face.family.replace(/^["']|["']$/g, '') === family);
    if (registered && document.fonts.check(font, text)) return true;

    const generation = this.fontGeneration;
    void document.fonts.load(font, text).then((faces) => {
      if (this.abort.signal.aborted || generation !== this.fontGeneration) return;
      if (!faces.length) throw new Error(`No font face found for ${family}.`);
      this.replay();
    }).catch((error: unknown) => {
      if (this.abort.signal.aborted || generation !== this.fontGeneration) return;
      console.error(error);
      this.onError?.(`Could not load ${family}. Check your connection, then Replay or choose another typeface.`);
    });
    return false;
  }

  private paintSource() {
    const ctx = this.sourceContext;
    const { width, height } = this.size;
    ctx.clearRect(0, 0, width, height);
    this.targetContext.clearRect(0, 0, width, height);
    this.clearSource = false;
    const rect = this.contentRect();
    // Canvas text does not redraw itself when a web font finishes loading.
    if (this.settings.mode === 'text' && this.textFontReady()) {
      const scale = width / this.screen.width;
      let fontSize = this.settings.fontSize * scale;
      const text = this.settings.text.slice(0, 500);
      const lines = text.split('\n').slice(0, 8);
      const font = () => `${this.settings.italic ? 'italic ' : ''}${this.settings.bold ? 'bold ' : ''}${fontSize}px "${this.settings.font}"`;
      ctx.font = font();
      const measured = Math.max(1, ...lines.map((line) => ctx.measureText(line).width));
      fontSize *= Math.min(1, rect.maxWidth / measured, rect.maxHeight / (fontSize * lines.length * 1.15));
      ctx.font = font();
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      lines.forEach((line, index) => ctx.fillText(line, rect.x,
        rect.y + (index - (lines.length - 1) / 2) * fontSize * 1.15));
      this.simUniforms.uniforms.uBounds.set([
        (rect.x - rect.maxWidth / 2) / width, (rect.y - rect.maxHeight / 2) / height,
        rect.maxWidth / width, rect.maxHeight / height,
      ]);
    } else if (this.settings.mode === 'image' && this.hasImage) {
      this.paintImage(rect);
    } else if (this.settings.mode === 'draw') {
      this.strokes.forEach((stroke) => {
        stroke.born = this.elapsed;
        this.drawStroke(stroke);
      });
      this.clearSource = true;
    }
    if (this.settings.mode !== 'draw') {
      this.targetContext.drawImage(this.sourceCanvas, 0, 0);
      if (this.settings.model === 'tutorial') {
        const seeds = createInkSeeds(this.targetCanvas, {
          mode: this.settings.reveal,
          width: this.settings.reveal === 'drops'
            ? Math.max(2.5, this.settings.dropSize * width / 3840)
            : Math.max(0.85, this.settings.seedWidth * width / 3840),
          seed: this.settings.seed,
          dropSpacing: Math.max(6, this.settings.dropSpacing * width / 3840),
          onDrop: this.staggerDuration > 0 ? (drop) => this.scheduledDrops.push(drop) : undefined,
        });
        ctx.clearRect(0, 0, width, height);
        if (this.staggerDuration > 0) this.scheduledDrops.sort((a, b) => a.delay - b.delay);
        else ctx.drawImage(seeds, 0, 0);
      }
    }
    this.updateTarget();
    this.sourceTexture.source.update();
    this.sourceDirty = false;
  }

  private updateTarget() {
    this.targetTexture.source.update();
    if (this.settings.model === 'tutorial') this.tutorial.rebuildField();
    this.targetDirty = false;
    this.renderDirty = true;
  }

  private emitScheduledDrops() {
    let drop = this.scheduledDrops[this.nextDrop];
    if (!drop || drop.delay * this.staggerDuration > this.elapsed) return;
    const ctx = this.sourceContext;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    while (drop && drop.delay * this.staggerDuration <= this.elapsed) {
      ctx.moveTo(drop.x + drop.radius, drop.y);
      ctx.arc(drop.x, drop.y, drop.radius, 0, Math.PI * 2);
      drop = this.scheduledDrops[++this.nextDrop];
    }
    ctx.fill();
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(this.targetCanvas, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    // Inject each batch once; the feedback's original-deposit channel retains it.
    this.sourceDirty = true;
  }

  private paintImage(rect: ReturnType<InkEngine['contentRect']>) {
    const { width, height } = this.imageCanvas;
    const pixels = this.imageContext.getImageData(0, 0, width, height);
    const s = this.settings;
    for (let i = 0; i < pixels.data.length; i += 4) {
      const luminance = (pixels.data[i] * 0.2126 + pixels.data[i + 1] * 0.7152 + pixels.data[i + 2] * 0.0722) / 255;
      let value = s.imageChannel === 'alpha' ? 1 : (s.invertImage ? luminance : 1 - luminance);
      value = Math.min(1, Math.max(0, (value - (1 - s.imageThreshold)) * s.imageContrast + 0.5));
      pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = 255;
      pixels.data[i + 3] *= value;
    }
    const mask = document.createElement('canvas');
    mask.width = width;
    mask.height = height;
    context2d(mask).putImageData(pixels, 0, 0);
    const scale = Math.min(rect.maxWidth / width, rect.maxHeight / height) * s.imageScale / 0.68;
    const w = width * scale, h = height * scale;
    this.sourceContext.drawImage(mask, rect.x - w / 2, rect.y - h / 2, w, h);
    this.simUniforms.uniforms.uBounds.set([
      (rect.x - w / 2) / this.size.width, (rect.y - h / 2) / this.size.height,
      w / this.size.width, h / this.size.height,
    ]);
  }

  async loadImage(file: File) {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/avif'].includes(file.type)) {
      throw new Error('Choose a PNG, JPEG, WebP, or AVIF image.');
    }
    if (file.size > 15 * 1024 * 1024) throw new Error('Please use an image smaller than 15 MB.');
    const generation = ++this.uploadGeneration;
    const bitmap = await createImageBitmap(file);
    if (generation !== this.uploadGeneration) { bitmap.close(); return false; }
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    this.imageCanvas.width = Math.max(1, Math.round(bitmap.width * scale));
    this.imageCanvas.height = Math.max(1, Math.round(bitmap.height * scale));
    this.imageContext.drawImage(bitmap, 0, 0, this.imageCanvas.width, this.imageCanvas.height);
    bitmap.close();
    this.hasImage = true;
    this.imageName = file.name;
    this.setMode('image');
    return true;
  }

  private point(event: PointerEvent): Point {
    const bounds = this.app.canvas.getBoundingClientRect();
    return {
      x: (event.clientX - bounds.left) / bounds.width,
      y: (event.clientY - bounds.top) / bounds.height,
      pressure: event.pointerType === 'pen' ? Math.max(0.15, event.pressure) : 0.65,
    };
  }

  private bindPointer() {
    const canvas = this.app.canvas;
    const signal = this.abort.signal;
    canvas.addEventListener('pointerdown', (event) => {
      if (this.settings.mode !== 'draw' || event.button !== 0 || this.pointerId !== undefined || this.paused) return;
      this.pointerId = event.pointerId;
      canvas.setPointerCapture(event.pointerId);
      this.activeStroke = { points: [this.point(event)], size: this.settings.brushSize, born: this.elapsed };
      this.strokes.push(this.activeStroke);
      this.drawStroke(this.activeStroke);
      this.sourceDirty = true;
    }, { signal });
    canvas.addEventListener('pointermove', (event) => {
      if (!this.activeStroke || this.pointerId !== event.pointerId) return;
      const events = event.getCoalescedEvents?.() || [];
      for (const sample of events.length ? events : [event]) {
        const previous = this.activeStroke.points.at(-1)!;
        const next = this.point(sample);
        this.activeStroke.points.push(next);
        this.activeStroke.born = this.elapsed;
        this.drawSegment(previous, next, this.activeStroke.size);
      }
      this.sourceDirty = true;
    }, { signal });
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      canvas.addEventListener(name, (event) => {
        if (event instanceof PointerEvent && event.pointerId === this.pointerId) this.finishStroke();
      }, { signal });
    }
    window.addEventListener('blur', () => this.finishStroke(), { signal });
  }

  private finishStroke() {
    if (this.pointerId !== undefined && this.app.canvas.hasPointerCapture(this.pointerId)) {
      this.app.canvas.releasePointerCapture(this.pointerId);
    }
    this.pointerId = undefined;
    this.activeStroke = undefined;
  }

  private drawSegment(a: Point, b: Point, size: number) {
    this.stampSegment(this.targetContext, a, b, size);
    const seedSize = this.settings.model === 'tutorial'
      ? Math.min(size, Math.max(0.85 * this.screen.width / this.size.width, this.settings.seedWidth * this.screen.width / 3840))
      : size;
    this.stampSegment(this.sourceContext, a, b, seedSize);
    this.targetDirty = true;
  }

  private stampSegment(ctx: CanvasRenderingContext2D, a: Point, b: Point, size: number) {
    ctx.strokeStyle = '#ffffff';
    ctx.fillStyle = '#ffffff';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = size * (0.45 + b.pressure * 0.85) * this.size.width / this.screen.width;
    ctx.beginPath();
    ctx.moveTo(a.x * this.size.width, a.y * this.size.height);
    ctx.lineTo(b.x * this.size.width, b.y * this.size.height);
    ctx.stroke();
    if (a.x === b.x && a.y === b.y) {
      ctx.beginPath();
      ctx.arc(b.x * this.size.width, b.y * this.size.height, ctx.lineWidth / 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private drawStroke(stroke: Stroke) {
    stroke.points.forEach((point, index) => this.drawSegment(stroke.points[Math.max(0, index - 1)], point, stroke.size));
  }

  private tick(delta: number) {
    if (document.hidden) return;
    if (this.paused) {
      this.renderFrame();
      return;
    }
    this.accumulator += Math.min(delta, 0.0667) * this.settings.speed;
    const step = this.settings.model === 'tutorial' ? 1 / 24 : 1 / 60;
    let iterations = 0;
    while (this.accumulator >= step && iterations++ < 8) {
      this.accumulator -= step;
      this.elapsed += step;
      this.frame++;
      if (!this.settled) {
        this.emitScheduledDrops();
        if (this.targetDirty) this.updateTarget();
        if (this.sourceDirty) {
          this.sourceTexture.source.update();
          this.sourceDirty = false;
          this.clearSource = true;
        }
        this.simUniforms.uniforms.uTime = this.elapsed;
        this.simUniforms.uniforms.uFrame = this.frame;
        if (this.settings.model === 'tutorial') {
          [this.current, this.next] = this.tutorial.step(this.current, this.next);
        } else {
          this.simulation.shader!.resources.uState = this.current.source;
          this.app.renderer.render({ container: this.simulation, target: this.next, clear: true });
          [this.current, this.next] = [this.next, this.current];
        }
        this.composite.shader!.resources.uState = this.current.source;
        this.renderDirty = true;
        if (this.clearSource) {
          this.sourceContext.clearRect(0, 0, this.size.width, this.size.height);
          this.sourceTexture.source.update();
          this.clearSource = false;
        }
      }
    }
    if (this.frame % 30 === 0 && this.settings.mode === 'draw') {
      const oldLength = this.strokes.length;
      this.strokes = this.strokes.filter((stroke) => stroke === this.activeStroke ||
        this.elapsed - stroke.born < this.settings.fadeDelay + this.settings.fadeDuration);
      if (this.strokes.length !== oldLength) {
        this.targetContext.clearRect(0, 0, this.size.width, this.size.height);
        for (const stroke of this.strokes) {
          stroke.points.forEach((point, index) =>
            this.stampSegment(this.targetContext, stroke.points[Math.max(0, index - 1)], point, stroke.size));
        }
        this.targetDirty = true;
      }
    }
    this.renderFrame();
    this.onUpdate?.();
  }

  private renderFrame() {
    // Paused and fully dried scenes need no GPU work until something changes.
    if (!this.renderDirty) return;
    this.app.render();
    this.renderDirty = false;
  }

  togglePause() {
    this.finishStroke();
    this.paused = !this.paused;
    this.onUpdate?.();
  }

  async exportPng() {
    this.app.render();
    const blob = await new Promise<Blob>((resolve, reject) => {
      this.app.canvas.toBlob((result) => result ? resolve(result) : reject(new Error('Could not export this canvas.')), 'image/png');
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'ink-bleed.png';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  metrics(includeMasks = false) {
    const { pixels } = this.app.renderer.extract.pixels({ target: this.current });
    const mask = includeMasks ? this.targetContext.getImageData(0, 0, this.size.width, this.size.height).data : undefined;
    let pigment = 0, occupied = 0, core = 0, coreOccupied = 0;
    let targetPixels = 0, filledPixels = 0, outsidePixels = 0;
    let solidTargetPixels = 0, solidFilledPixels = 0;
    let minX = this.size.width, minY = this.size.height, maxX = 0, maxY = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      pigment += pixels[i];
      core += pixels[i + 1];
      if (pixels[i + 1] > 35) coreOccupied++;
      if (mask) {
        if (mask[i + 3] >= 192) {
          solidTargetPixels++;
          if (pixels[i] >= 128) solidFilledPixels++;
        }
        if (mask[i + 3] > 35) {
          targetPixels++;
          if (pixels[i] > 35) filledPixels++;
        } else if (mask[i + 3] === 0 && pixels[i] > 35) outsidePixels++;
      }
      if (pixels[i] > 35) {
        occupied++;
        const x = (i / 4) % this.size.width;
        const y = Math.floor(i / 4 / this.size.width);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    return {
      pigment, core, occupied, coreOccupied, elapsed: this.elapsed, frame: this.frame,
      bounds: { minX, minY, maxX, maxY },
      width: this.size.width, height: this.size.height, mode: this.settings.mode,
      paused: this.paused, strokes: this.strokes.length,
      model: this.settings.model,
      targetPixels, filledPixels, outsidePixels,
      solidTargetPixels, solidFilledPixels,
      pendingDrops: this.scheduledDrops.length - this.nextDrop,
      settled: this.settled,
    };
  }

  destroy() {
    this.uploadGeneration++;
    this.abort.abort();
    this.resizeObserver?.disconnect();
    this.app.stop();
    this.current.destroy(true);
    this.next.destroy(true);
    this.medium.destroy(true);
    this.sourceTexture.destroy(true);
    this.targetTexture.destroy(true);
    this.tutorial.destroy();
    for (const mesh of [this.simulation, this.mediumMesh, this.composite]) {
      destroyPass(mesh);
    }
    this.empty.destroy();
    this.app.destroy(true);
  }
}

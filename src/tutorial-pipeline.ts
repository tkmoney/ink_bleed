import { UniformGroup } from 'pixi.js';
import type { Application, RenderTexture, Texture } from 'pixi.js';
import type { Settings } from './settings';
import { createPass, createTarget, destroyPass, resizePass } from './gpu-pass';
import type { GpuPass } from './gpu-pass';
import {
  boxBlurFragment, directionalFragment, displacementMapFragment,
  fractalFragment, medianFragment, pasteFragment,
} from './tutorial-shaders';

export class TutorialPipeline {
  readonly field = createTarget();
  private noise = createTarget();
  private maskA = createTarget();
  private maskB = createTarget();
  private fractal: GpuPass;
  private blur: GpuPass;
  private map: GpuPass;
  private paste: GpuPass;
  private displace: GpuPass;
  private median: GpuPass;
  private referenceScale = 1;
  private noiseKey = '';
  private settings: Settings;
  private app: Application;
  private target: Texture;
  private uniforms = new UniformGroup({
    uSize: { value: new Float32Array([1, 1]), type: 'vec2<f32>' },
    uReferenceScale: { value: 1, type: 'f32' },
    uSeed: { value: 12, type: 'f32' },
    uComplexity: { value: 10, type: 'f32' },
    uSubInfluence: { value: 0.9, type: 'f32' },
    uExteriorNoise: { value: 0.08, type: 'f32' },
    uDropFill: { value: 0, type: 'f32' },
    uAccumulation: { value: 0.95, type: 'f32' },
    uDisplacementAmount: { value: 10, type: 'f32' },
    uMedianRadius: { value: 1, type: 'f32' },
    uDirection: { value: new Float32Array([0, 1]), type: 'vec2<f32>' },
    uRadius: { value: 20, type: 'f32' },
    uRematte: { value: 0, type: 'f32' },
    uReadAlpha: { value: 0, type: 'f32' },
  });

  constructor(app: Application, settings: Settings, source: Texture, target: Texture, shared: UniformGroup) {
    this.app = app;
    this.settings = settings;
    this.target = target;
    this.fractal = createPass(fractalFragment, { mapUniforms: this.uniforms });
    this.blur = createPass(boxBlurFragment, {
      mapUniforms: this.uniforms, uInput: target.source, uTarget: target.source,
    });
    this.map = createPass(displacementMapFragment, {
      mapUniforms: this.uniforms, uNoise: this.noise.source, uMask: this.maskB.source,
    });
    this.paste = createPass(pasteFragment, {
      sharedUniforms: shared,
      accumulationUniforms: new UniformGroup({ uAccumulation: { value: settings.accumulation, type: 'f32' } }),
      uState: source.source, uSource: source.source, uTarget: target.source,
    });
    this.displace = createPass(directionalFragment, {
      mapUniforms: this.uniforms, uState: source.source, uDisplacement: this.field.source,
    });
    this.median = createPass(medianFragment, {
      mapUniforms: this.uniforms, uState: source.source,
    });
  }

  resize(width: number, height: number) {
    this.referenceScale = width / 3840;
    for (const texture of [this.noise, this.maskA, this.maskB, this.field]) texture.resize(width, height);
    for (const pass of this.passes()) resizePass(pass, width, height);
    this.uniforms.uniforms.uSize.set([width, height]);
    this.uniforms.uniforms.uReferenceScale = this.referenceScale;
    this.noiseKey = '';
    this.applySettings();
  }

  applySettings() {
    const s = this.settings;
    Object.assign(this.uniforms.uniforms, {
      uSeed: s.seed, uComplexity: s.complexity, uSubInfluence: s.subInfluence,
      uExteriorNoise: s.exteriorNoise,
      uDisplacementAmount: s.displacement * this.referenceScale,
      uMedianRadius: s.medianRadius * this.referenceScale,
      uDropFill: s.reveal === 'drops' && s.mode !== 'draw' ? 1 : 0,
      uAccumulation: s.accumulation,
    });
    this.paste.shader!.resources.accumulationUniforms.uniforms.uAccumulation = s.accumulation;
  }

  rebuildField() {
    const s = this.settings;
    const key = `${s.seed}:${s.complexity}:${s.subInfluence}`;
    if (key !== this.noiseKey) {
      this.app.renderer.render({ container: this.fractal, target: this.noise, clear: true });
      this.noiseKey = key;
    }
    const uniforms = this.uniforms.uniforms;
    const blur = (input: Texture, output: RenderTexture, radius: number, x: number, y: number, alpha = 0, matte = 0) => {
      uniforms.uDirection.set([x, y]);
      uniforms.uRadius = radius * this.referenceScale;
      uniforms.uReadAlpha = alpha;
      uniforms.uRematte = matte;
      this.blur.shader!.resources.uInput = input.source;
      this.app.renderer.render({ container: this.blur, target: output, clear: true });
    };
    blur(this.target, this.maskA, s.targetFeather, 1, 0, 1);
    blur(this.maskA, this.maskB, s.targetFeather, 0, 1, 0, 1);
    blur(this.maskB, this.maskA, s.edgeSoftness, 1, 0);
    blur(this.maskA, this.maskB, s.edgeSoftness, 0, 1);
    this.app.renderer.render({ container: this.map, target: this.field, clear: true });
  }

  step(current: RenderTexture, next: RenderTexture): [RenderTexture, RenderTexture] {
    const render = (pass: GpuPass) => {
      pass.shader!.resources.uState = current.source;
      this.app.renderer.render({ container: pass, target: next, clear: true });
      [current, next] = [next, current];
    };
    render(this.paste);
    // These are sequential adjustment layers, not four samples of one input.
    for (const direction of [[0, -1], [0, 1], [1, 0], [-1, 0]]) {
      this.uniforms.uniforms.uDirection.set(direction);
      render(this.displace);
    }
    if (this.settings.medianRadius > 0) render(this.median);
    return [current, next];
  }

  private passes() {
    return [this.fractal, this.blur, this.map, this.paste, this.displace, this.median];
  }

  destroy() {
    for (const texture of [this.noise, this.maskA, this.maskB, this.field]) texture.destroy(true);
    for (const pass of this.passes()) destroyPass(pass);
  }
}

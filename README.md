# Ink Bleed Studio

A full-screen ink-on-paper experiment built with **Vite, TypeScript, PixiJS v8, custom GLSL shaders, and Tweakpane v4**. The background is the supplied Texturelabs Paper 308L image.

## Run

Requires Node.js 22.12+ (or a current supported Node release).

```powershell
npm install
npm run dev
```

Open **http://127.0.0.1:5174**. Port 5174 avoids another local application already using 5173. The dev server binds only to localhost.

```powershell
npm run build
npm run preview
```

The production site is generated in `dist`. No backend, API keys, or remote image uploads are involved.

## Use

The ink is centered on the full-screen paper. A single compact **Controls** pane contains the interface; click its title to collapse it. It starts collapsed on phones. Source settings, Appearance, Advanced, and Actions are folded until needed, and their state survives source/model changes.

| Control | Behavior |
| --- | --- |
| Model | Tutorial / Time Blend is the default, based on the supplied transcript. Capillary study preserves the earlier artistic diffusion model. |
| View | Inspect finished ink, the thin ink source, or the target silhouette. Tutorial mode also exposes the grayscale displacement map. |
| Text | Edit the default "Ink Bleed" in Tweakpane; choose write-on or drop reveal. Source settings contains font, size, italic/bold, and separate drop size/spacing or pen width. Long text scales to fit. |
| Drop stagger / sec | In Source settings when Ink drops is selected. Randomly spread drop starts across 0-10 seconds: zero starts all drops together; 3 starts them at random times within three seconds. Works with text/image sources in both models. |
| Draw | Drag on the paper with a mouse, touch, or pen. Pressure affects pen width. Every part of a stroke bleeds and fades locally; new strokes do not reset older strokes. |
| Image | Choose or drop a PNG, JPEG, WebP, or AVIF, up to 15 MB. Images are converted into a monochrome ink mask, not composited in their original colors. |
| Mask from | Darkness is best for dark artwork on light paper. Transparency is best for transparent logos or silhouettes, including white ones. |
| Appearance | India ink, fountain pen, wine wash, and sepia presets, plus paper grain, edge pooling, and texture strength. |
| Advanced | Model/view, accumulation, settling, reveal duration, playback speed, repeatable noise seed, displacement-map settings, and render quality. |
| Replay / R | Restart the source and feedback. In Draw mode, re-stamp currently retained strokes. Expired strokes are discarded. |
| Actions: Pause / Space | Freeze simulation, fading, and brush input. Appearance controls still work. |
| Actions: Clear / C | Clear all ink. Text and image sources can be restored with Replay; drawn paths are removed. |
| Actions: Save PNG | Download the paper and ink as PNG, without the interface. Reset controls restores the defaults. |
| H | Hide/show the pane completely. A small Controls button restores it when hidden. |

Source and feedback/map changes restart the effect; color, grain, density, pooling, and diagnostic view change the current image in place. Resizing or changing render quality recreates the simulation and re-inks the current source; retained brush paths are normalized to the new canvas. Hidden browser tabs suspend the simulation rather than aging strokes off-screen. Tutorial mode labels the original drying control "Settle": after the reveal plus this interval, the result freezes instead of running feedback forever. Drop stagger extends this timing by the full stagger window, so the last drop still has time to fill.

Drop timing is repeatable on Replay; change Advanced > Paper seed to get another arrangement and timing pattern. Stagger uses simulation seconds, so Speed and Pause affect it together with the bleed. In the tutorial model each actual seed drop is injected only when its start time arrives, then expands through the same feedback. The source diagnostic shows deposits that have arrived, not future drops. The capillary model delays its procedural drop cells instead. Write-on and drawing are unaffected by the stagger setting.

**Google Fonts:** Source settings > Typeface also offers **Bonheur Royale** and **Eagle Lake**. They load from Google Fonts and require a network connection on first use. The ink mask waits for the selected face to load, then restarts the reveal; a late font response cannot undo Clear or a newer source choice. Both supplied faces are regular-weight fonts; the existing Bold/Italic controls use browser synthesis.

Ink drops start from sparse, fixed deposits and fill the lettering by transport, not a full-mask fade-in. Opaque interior seed placement and retained deposits prevent faint dots from stalling before filling the target. Very low displacement, unusually wide drop spacing, or short settling times can still intentionally leave an incomplete reveal; increase Settle or reduce spacing for those combinations.

## Tutorial mapping

Reference: Texturelabs, [Unlock the Secret to Ultra-Realistic Bleeding Ink! || Advanced After Effects](https://www.youtube.com/watch?v=mbJRSpzGUIs).

The supplied transcript now establishes the effect chain and settings below. The [official tutorial page](https://texturelabs.org/tutorials/advanced-animated-ink-bleed-in-after-effects/) and [project instructions](https://texturelabs.org/tools/ink-bleed-ae-project-file/) provide additional context.

| Tutorial step and timestamp | PixiJS / WebGL mapping |
| --- | --- |
| Separate a thin stroke source from the final lettering (6:27-7:08) | The full text/image is a target alpha texture. Bounded, per-component Zhang-Suen thinning generates approximate centerline seeds; the write-on reveal advances across those seeds. Drawing uses the actual pointer path as a thin source, with the chosen brush width as its target. |
| Blobs can also start the effect (5:56-6:04) | Ink drops mode generates reproducible, stationary seed drops inside each connected target component. Optional random stagger schedules each drop independently. Only feedback expands them; circles no longer expand procedurally to reveal the target. |
| Fast Box Blur 20, Set Matte, Fast Box Blur 2 (7:33-8:04) | Separable box-blur passes soften the target. Multiplying by the original alpha restores its outer boundary; the second, small blur softens that boundary. This creates strong interior displacement with weaker edges. |
| Fractal Noise: complexity 10, sub-influence 90%, blending None (8:07-8:34) | A cached ten-octave fractal field, with 0.9 octave influence, is applied to the softened/rematted coverage. It is not compounded by blending against the target's RGB color. |
| Neutral 50% gray plus a second noise at 8% opacity (8:49-9:30) | Outside the target, the field is neutral except for a separate faint fractal field. A specifically encoded neutral byte avoids a systematic 8-bit displacement bias. Set Outside noise and Edge softness to zero to isolate the target boundary. |
| Four directional displacement layers, all Darken: vertical +/-10, horizontal +/-10 (9:32-10:29) | Four **sequential** GPU passes sample the shared map and combine original/displaced coverage with `max`. Positive pigment is the inverse of AE's black-on-white luminance, so `max` implements Darken. This is not a parallel eight-neighbor dilation. |
| Time Blend FX Paste/Darken below the displacement stack, accumulation 95%, Copy above (10:35-11:34) | For write-on/drawing, the paste pass retains 95% of previous pigment and darkens it against the current source. Static drops retain deposited pigment inside the target and use accumulation as the gain for newly transported ink; exterior pigment still attenuates. Each directional pass reads the preceding pass's output. Ping-pong textures preserve the completed result for the next frame. |
| Median radius 1 removes isolated bright pixels and crunchy edges (11:37-12:12) | A real 3x3 median shader, not an average blur, cleans pigment after displacement. Radius zero bypasses it. |
| 4K composition at 24 fps (6:21-6:25) | The tutorial model runs at a fixed 24 Hz. Distance controls are expressed in the tutorial's 4K pixels and scaled by render width / 3840. |

**Port-specific choices:** AE's proprietary noise and blur kernels are approximated with GLSL; the box blur uses 17 samples per axis. Pen widths have a 0.85-render-pixel floor; drops have a separate 16-at-4K-pixel diameter with a 2.5-render-pixel floor. Drop candidates favor opaque interiors over antialiased edges. Automatic centerlines and their left-to-right reveal are not manually authored handwriting paths. The transcript does not pin down the median layer's exact position relative to Copy; this port stores the cleaned result inside the feedback loop and preserves original static-drop deposits during cleanup. Accumulation means retained intensity for write-on/drawing, but deposition gain for static drops: multiplying all pigment by 0.95 every frame otherwise imposes a finite travel distance and leaves sparsely seeded text unfilled. Target alpha only controls retention, never injects ink. These choices mean this is a transcript-aligned reconstruction, not a bit-identical AE renderer.

**Additional requested/artistic behavior:** local hold/fade for drawing, freeze-after-settling for text/images, ink tint, paper granulation, edge pooling, and optical absorption into the supplied paper. A drawing's original deposit persists as a local seed during its hold/fade, so new marks do not refresh the entire canvas. These finishing layers are separate from the tutorial's displacement map.

The state is **RGBA8**: R = pigment, G = original deposit, B = remaining local lifetime, A = 1. Stochastic rounding in the paste/fade pass prevents slow changes getting stuck at 8-bit precision. It does not require floating-point render-target extensions.

**Capillary study** retains the previous 60 Hz, eight-neighbor, wetness-controlled spread and paper-noise model. It is intentionally different from the tutorial and remains available for comparison.

Custom PixiJS mesh shaders make the pass order, neutral map, feedback, and median explicit. A stack of stateless built-in filters alone cannot remember the previous frame; `pixi-filters` is not needed.

## Files

| File | Responsibility |
| --- | --- |
| `src/ink-engine.ts` | Pixi lifecycle, ping-pong rendering, source masks, brush input, local fading, image decoding, resizing, PNG export |
| `src/shaders.ts` | Stationary paper-field pass, feedback pass, final paper/ink composite |
| `src/tutorial-shaders.ts` | Fractal noise, target blur/matte, neutral displacement map, paste, directional Darken, median |
| `src/tutorial-pipeline.ts` | Tutorial map construction and ordered GPU feedback passes |
| `src/source-seeds.ts` | Bounded centerline extraction and deterministic drops with per-drop timing metadata inside target components |
| `src/gpu-pass.ts` | Shared fullscreen mesh and render-target lifecycle |
| `src/settings.ts` | Typed settings, defaults, pigment presets |
| `src/main.ts` | Tweakpane and studio interaction |
| `src/style.css` | Responsive interface and light/dark UI themes |
| `public/textures/paper-308l.jpg` | User-supplied Texturelabs Paper 308L background |

## Browser checks

```powershell
npx playwright install chromium
npm test
```

Playwright exercises the compact controls, tutorial seed-to-target growth, accumulation, neutral exteriors, median hole cleanup, local drawing fades, image drop filling, and diagnostic/model controls. Drop regressions require over 99% target coverage and over 98% dark interior coverage across default, bold, multiline, image, and staggered sources, while checking retained cutouts, bounded exterior spread, separate drop sizing, and no mask reveal when displacement is disabled. Stagger checks cover independent starts, repeatable replay, pause/clear, source diagnostics, extended settling, controls, and both models. Seed-helper tests cover disconnected components, holes, tiny shapes, opaque seed placement, deterministic output and bounded large-image work. Software-WebGL tests use a reduced grid while running the same shaders. Development-only diagnostics are available as `window.__inkStudio`; they are excluded from the production build.

Modern WebGL is required. The renderer deliberately selects Pixi's WebGL backend; no WGSL/WebGPU version is included. Large simulations are GPU-bound. Choose Draft resolution on low-power devices. Catch-up work is bounded, so playback can slow under heavy load rather than destabilizing the feedback. Graphics context loss is surfaced with a reload message.

Tutorial and paper credit: [Texturelabs](https://texturelabs.org/). Review the original asset's terms before redistributing the supplied texture.

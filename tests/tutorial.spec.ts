import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function ready(page: Page) {
  await page.goto('http://127.0.0.1:5174/?scoutTheme=light');
  await expect(page.locator('#studio')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue('Tutorial / Time Blend');
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  await page.evaluate(() => {
    const { settings, engine } = window.__inkStudio!;
    engine.app.stop();
    settings.quality = 700;
    settings.revealDuration = 0.5;
    engine.setQuality();
  });
}

async function advance(page: Page, seconds: number) {
  return page.evaluate((target) => {
    const { engine } = window.__inkStudio!;
    engine.app.stop();
    const ticker = engine.app.ticker;
    ticker.maxFPS = 0;
    let now = ticker.lastTime;
    for (let i = 0; engine.elapsed < target && i < 1000; i++) {
      ticker.update(now += 1000 / 60 + 0.01);
    }
    return engine.metrics(true);
  }, seconds);
}

test('tutorial uses thin seeds, four-way feedback and a neutral exterior', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await ready(page);
  await page.evaluate(() => {
    const { settings, engine } = window.__inkStudio!;
    settings.displacement = 0;
    settings.medianRadius = 0;
    settings.exteriorNoise = 0;
    settings.edgeSoftness = 0;
    engine.applySettings(true);
  });
  const source = await advance(page, 1);
  expect(source.targetPixels).toBeGreaterThan(3000);
  expect(source.coreOccupied).toBeLessThan(source.targetPixels * 0.45);
  expect(source.occupied).toBe(source.coreOccupied);
  await page.evaluate(() => {
    const { settings, engine } = window.__inkStudio!;
    settings.displacement = 10;
    engine.applySettings(true);
  });
  const filled = await advance(page, 6);
  expect(filled.occupied).toBeGreaterThan(source.occupied * 1.8);
  expect(filled.filledPixels / filled.targetPixels).toBeGreaterThan(0.45);
  expect(filled.outsidePixels).toBeLessThan(5);
  expect(filled.frame).toBeCloseTo(filled.elapsed * 24, 5);
  await page.screenshot({ path: 'test-results\\tutorial-text.png' });
  expect(errors).toEqual([]);
});

test('tutorial accumulation changes feedback, and median fills an isolated hole', async ({ page }) => {
  await ready(page);
  const strong = await advance(page, 4);
  await page.evaluate(() => {
    const { settings, engine } = window.__inkStudio!;
    settings.accumulation = 0.8;
    engine.applySettings(true);
  });
  const weak = await advance(page, 4);
  expect(weak.pigment).toBeLessThan(strong.pigment * 0.9);
  const repaired = await page.evaluate(async () => {
    const pixiModule = performance.getEntriesByType('resource')
      .map((entry) => entry.name).find((name) => new URL(name).pathname.endsWith('/pixi__js.js'));
    if (!pixiModule) throw new Error('Could not locate the already-loaded Pixi module.');
    const shaderModule = '/src/tutorial-shaders.ts';
    const utilityModule = '/src/gpu-pass.ts';
    const { Texture, UniformGroup } = await import(pixiModule);
    const { medianFragment } = await import(shaderModule);
    const { createPass, createTarget, resizePass, destroyPass } = await import(utilityModule);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 9;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, 9, 9);
    ctx.fillStyle = '#000000';
    ctx.fillRect(4, 4, 1, 1);
    const source = Texture.from(canvas);
    const target = createTarget();
    target.resize(9, 9);
    const pass = createPass(medianFragment, {
      mapUniforms: new UniformGroup({
        uSize: { value: new Float32Array([9, 9]), type: 'vec2<f32>' },
        uMedianRadius: { value: 1, type: 'f32' },
        uDropFill: { value: 0, type: 'f32' },
      }),
      uState: source.source,
    });
    resizePass(pass, 9, 9);
    const renderer = window.__inkStudio!.engine.app.renderer;
    renderer.render({ container: pass, target, clear: true });
    const pixel = renderer.extract.pixels({ target }).pixels[(4 * 9 + 4) * 4];
    destroyPass(pass);
    source.destroy(true);
    target.destroy(true);
    return pixel;
  });
  expect(repaired).toBe(255);
});

test('tutorial drawing expands from a thin pen and fully fades locally', async ({ page }) => {
  await ready(page);
  await page.getByLabel('Source', { exact: true }).selectOption({ label: 'Draw' });
  await page.evaluate(() => {
    const { settings, engine } = window.__inkStudio!;
    settings.fadeDelay = 0.8;
    settings.fadeDuration = 1.2;
    engine.applySettings();
  });
  await page.mouse.move(250, 400);
  await page.mouse.down();
  await page.mouse.move(540, 450, { steps: 20 });
  await page.mouse.up();
  const initial = await advance(page, 0.1);
  const spread = await advance(page, 0.7);
  expect(initial.coreOccupied).toBeGreaterThan(70);
  expect(spread.occupied).toBeGreaterThan(initial.coreOccupied * 1.5);
  expect(spread.outsidePixels).toBeLessThan(spread.occupied * 0.25);
  await page.mouse.click(750, 400);
  const newStroke = await advance(page, 1);
  expect(newStroke.pigment).toBeGreaterThan(0);
  const faded = await advance(page, 4.5);
  expect(faded.occupied).toBe(0);
  expect(faded.coreOccupied).toBe(0);
});

test('tutorial image drops fill a target; diagnostic views and model switch work', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await ready(page);
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 220;
    canvas.height = 140;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#000';
    ctx.fillRect(20, 20, 180, 100);
    ctx.clearRect(90, 55, 40, 30);
    return canvas.toDataURL().split(',')[1];
  });
  await page.getByLabel('Source', { exact: true }).selectOption({ label: 'Image' });
  const chooserEvent = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Choose image', exact: true }).click();
  await (await chooserEvent).setFiles({ name: 'hollow-mark.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect.poll(() => page.evaluate(() => window.__inkStudio!.engine.imageName)).toBe('hollow-mark.png');
  await page.getByLabel('Reveal', { exact: true }).selectOption({ label: 'Ink drops' });
  await page.getByRole('button', { name: 'Source settings', exact: true }).click();
  await expect(page.getByLabel('Drop size', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Drop spacing', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Pen / 4K px', { exact: true })).toHaveCount(0);
  const initial = await advance(page, 0.1);
  const filled = await advance(page, 5);
  expect(filled.occupied).toBeGreaterThan(initial.coreOccupied * 2);
  expect(filled.coreOccupied).toBeLessThan(filled.targetPixels * 0.25);
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  for (const [view, label] of [['source', 'Ink source'], ['target', 'Target shape'], ['displacement', 'Displacement map'], ['ink', 'Finished ink']]) {
    await page.getByLabel('View', { exact: true }).selectOption({ label });
    await advance(page, 5.1 + ['source', 'target', 'displacement', 'ink'].indexOf(view) * 0.1);
    expect(await page.evaluate(() => window.__inkStudio!.settings.diagnostic)).toBe(view);
  }
  await page.getByLabel('Model', { exact: true }).selectOption({ label: 'Capillary study' });
  expect(await page.evaluate(() => window.__inkStudio!.settings.model)).toBe('capillary');
  await page.getByLabel('Model', { exact: true }).selectOption({ label: 'Tutorial / Time Blend' });
  expect(await page.evaluate(() => window.__inkStudio!.engine.metrics().model)).toBe('tutorial');
  expect(errors).toEqual([]);
});

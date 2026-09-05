import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

test.use({ viewport: { width: 1200, height: 800 } });

async function ready(page: Page) {
  await page.goto('http://127.0.0.1:5174/');
  await expect(page.locator('#studio')).toHaveAttribute('data-ready', 'true');
  await page.evaluate(() => {
    const { engine, settings } = window.__inkStudio!;
    engine.app.stop();
    settings.quality = 700;
    settings.reveal = 'drops';
    engine.setQuality();
    engine.applySettings(true);
  });
}

async function advance(page: Page, seconds: number) {
  return page.evaluate((target) => {
    const { engine } = window.__inkStudio!;
    const ticker = engine.app.ticker;
    ticker.maxFPS = 0;
    let now = ticker.lastTime;
    for (let i = 0; engine.elapsed < target && i < 1000; i++) {
      ticker.update(now += 1000 / 24 + 0.01);
    }
    return engine.metrics(true);
  }, seconds);
}

for (const example of [
  { name: 'default lettering', text: 'Ink Bleed', font: 'Georgia', bold: false, seed: 12, dropStagger: 0 },
  { name: 'bold disconnected shapes', text: 'Oi. B8', font: 'Arial', bold: true, seed: 37, dropStagger: 0 },
  { name: 'multiline serif lettering', text: 'Ink\nBleed!', font: 'Times New Roman', bold: false, seed: 84, dropStagger: 0 },
  { name: 'staggered lettering', text: 'Ink Bleed', font: 'Georgia', bold: false, seed: 12, dropStagger: 8 },
]) {
  test(`ink drops completely fill ${example.name} before settling`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await ready(page);
    await page.evaluate(({ text, font, bold, seed, dropStagger }) => {
      const { engine, settings } = window.__inkStudio!;
      Object.assign(settings, { text, font, bold, seed, dropStagger });
      engine.applySettings(true);
    }, example);
    const start = await advance(page, 0.15);
    const growing = await advance(page, 3);
    if (example.dropStagger > 0) expect((await advance(page, 10)).settled).toBe(false);
    const filled = await advance(page, 10 + example.dropStagger);
    expect(filled.pendingDrops).toBe(0);
    expect(start.filledPixels / start.targetPixels).toBeLessThan(0.2);
    expect(growing.filledPixels).toBeGreaterThan(start.filledPixels * 3);
    expect(filled.filledPixels / filled.targetPixels).toBeGreaterThan(0.99);
    expect(filled.solidFilledPixels / filled.solidTargetPixels).toBeGreaterThan(0.98);
    expect(filled.outsidePixels / filled.targetPixels).toBeLessThan(0.6);
    expect(filled.coreOccupied / filled.targetPixels).toBeLessThan(0.1);
    expect(Math.abs((filled.bounds.minX + filled.bounds.maxX) / 2 - filled.width / 2))
      .toBeLessThan(filled.width * 0.05);
    const settled = await advance(page, 14 + example.dropStagger);
    expect(settled.pigment).toBe(filled.pigment);
    expect(errors).toEqual([]);
  });
}

test('drop size is independent of pen width and cannot bypass displacement', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    const { engine, settings } = window.__inkStudio!;
    settings.displacement = 0;
    settings.medianRadius = 0;
    engine.applySettings(true);
  });
  const small = await advance(page, 0.2);
  const stopped = await advance(page, 10);
  expect(stopped.occupied).toBe(stopped.coreOccupied);
  expect(stopped.filledPixels / stopped.targetPixels).toBeLessThan(0.1);
  expect(stopped.coreOccupied).toBe(small.coreOccupied);
  await page.evaluate(() => {
    const { engine, settings } = window.__inkStudio!;
    settings.seedWidth = 30;
    engine.applySettings(true);
  });
  const widerPen = await advance(page, 0.2);
  expect(widerPen.coreOccupied).toBe(small.coreOccupied);
  await page.evaluate(() => {
    const { engine, settings } = window.__inkStudio!;
    settings.dropSize = 64;
    engine.applySettings(true);
  });
  const larger = await advance(page, 0.2);
  expect(larger.coreOccupied).toBeGreaterThan(small.coreOccupied * 3);
});

for (const stagger of [0, 8]) {
  test(`drop feedback fills an uploaded silhouette without flooding its cutout (stagger ${stagger}s)`, async ({ page }) => {
    await ready(page);
    await page.evaluate(async (dropStagger) => {
      const { engine, settings } = window.__inkStudio!;
      const canvas = document.createElement('canvas');
      canvas.width = 240;
      canvas.height = 160;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#000000';
      ctx.fillRect(20, 20, 140, 120);
      ctx.clearRect(60, 55, 60, 50);
      ctx.beginPath();
      ctx.arc(205, 80, 20, 0, Math.PI * 2);
      ctx.fill();
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => value ? resolve(value) : reject(new Error('Image fixture failed')), 'image/png');
      });
      settings.mode = 'image';
      settings.dropStagger = dropStagger;
      settings.imageChannel = 'alpha';
      await engine.loadImage(new File([blob], 'silhouette.png', { type: 'image/png' }));
      engine.applySettings(true);
    }, stagger);
    const start = await advance(page, 0.15);
    const filled = await advance(page, 10 + stagger);
    expect(filled.pendingDrops).toBe(0);
    expect(start.filledPixels / start.targetPixels).toBeLessThan(0.15);
    expect(filled.filledPixels / filled.targetPixels).toBeGreaterThan(0.99);
    expect(filled.solidFilledPixels / filled.solidTargetPixels).toBeGreaterThan(0.98);
    expect(filled.outsidePixels / filled.targetPixels).toBeLessThan(0.25);
    const hole = await page.evaluate(() => {
      const { engine } = window.__inkStudio!;
      // The centered 240x160 source occupies 60% of the canvas height.
      const sample = () => {
        const { pixels, width, height } = engine.app.renderer.extract.pixels({ target: engine.app.stage });
        const x = Math.round(width / 2 - 30 * height * 0.6 / 160);
        const y = Math.round(height / 2);
        return Array.from(pixels.slice((y * width + x) * 4, (y * width + x) * 4 + 4));
      };
      const filled = sample();
      engine.clear();
      return { filled, paper: sample() };
    });
    expect(hole.filled).toEqual(hole.paper);
  });
}

test('drop stagger controls individual arrivals, replay, pause and clear', async ({ page }) => {
  await ready(page);
  await page.getByLabel('Reveal', { exact: true }).selectOption({ label: 'Ink drops' });
  await page.getByRole('button', { name: 'Source settings', exact: true }).click();
  const control = page.getByLabel('Drop stagger / sec', { exact: true });
  await expect(control).toHaveValue('0.0');
  await control.fill('4');
  await control.press('Enter');
  expect(await page.evaluate(() => window.__inkStudio!.settings.dropStagger)).toBe(4);
  await page.evaluate(() => {
    const { settings, engine } = window.__inkStudio!;
    settings.displacement = 0;
    settings.medianRadius = 0;
    engine.applySettings(true);
  });
  const early = await advance(page, 0.5);
  const middle = await advance(page, 2);
  expect(early.pendingDrops).toBeGreaterThan(middle.pendingDrops);
  expect(middle.pendingDrops).toBeGreaterThan(0);
  expect(middle.coreOccupied).toBeGreaterThan(early.coreOccupied);
  const visibleSources = await page.evaluate(() => {
    const { settings, engine } = window.__inkStudio!;
    settings.diagnostic = 'source';
    engine.applySettings();
    const { pixels } = engine.app.renderer.extract.pixels({ target: engine.app.stage });
    settings.diagnostic = 'ink';
    engine.applySettings();
    return pixels.some((value, index) => index % 4 === 0 && value < 100);
  });
  expect(visibleSources).toBe(true);
  await page.evaluate(() => {
    const { engine } = window.__inkStudio!;
    engine.togglePause();
    const ticker = engine.app.ticker;
    let now = ticker.lastTime;
    for (let i = 0; i < 120; i++) ticker.update(now += 1000 / 24 + 0.01);
  });
  const paused = await page.evaluate(() => window.__inkStudio!.engine.metrics(true));
  expect(paused.elapsed).toBe(middle.elapsed);
  expect(paused.pendingDrops).toBe(middle.pendingDrops);
  expect(paused.core).toBe(middle.core);
  await page.evaluate(() => window.__inkStudio!.engine.togglePause());
  const all = await advance(page, 4.1);
  expect(all.pendingDrops).toBe(0);
  expect(all.coreOccupied).toBeGreaterThan(middle.coreOccupied);
  expect(all.occupied).toBe(all.coreOccupied);
  await page.getByRole('button', { name: 'Replay', exact: true }).click();
  const repeated = await advance(page, 0.5);
  expect(repeated.pendingDrops).toBe(early.pendingDrops);
  expect(repeated.core).toBe(early.core);
  await page.evaluate(() => window.__inkStudio!.engine.clear());
  const cleared = await advance(page, 20);
  expect(cleared.pendingDrops).toBe(0);
  expect(cleared.pigment).toBe(0);
  await page.getByLabel('Source', { exact: true }).selectOption({ label: 'Draw' });
  await expect(control).toHaveCount(0);
  expect(await page.evaluate(() => window.__inkStudio!.engine.metrics().pendingDrops)).toBe(0);
  await page.getByLabel('Source', { exact: true }).selectOption({ label: 'Image' });
  await expect(control).toHaveValue('4.0');
  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name: 'Reset controls', exact: true }).click();
  expect(await page.evaluate(() => window.__inkStudio!.settings.dropStagger)).toBe(0);
});

test('capillary drop cells also stagger without changing write-on timing', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    const { settings, engine } = window.__inkStudio!;
    settings.model = 'capillary';
    engine.applySettings(true);
  });
  const simultaneous = await advance(page, 2);
  await page.evaluate(() => {
    const { settings, engine } = window.__inkStudio!;
    settings.dropStagger = 8;
    engine.applySettings(true);
  });
  const staggered = await advance(page, 2);
  expect(staggered.coreOccupied).toBeLessThan(simultaneous.coreOccupied * 0.7);
  const later = await advance(page, 10.5);
  expect(later.settled).toBe(false);
  expect(later.coreOccupied).toBeGreaterThan(staggered.coreOccupied * 2);
  await page.evaluate(() => {
    const { settings, engine } = window.__inkStudio!;
    settings.reveal = 'write-on';
    engine.applySettings(true);
  });
  const writing = await advance(page, 10.5);
  expect(writing.settled).toBe(true);
  expect(writing.coreOccupied).toBeGreaterThan(0);
});

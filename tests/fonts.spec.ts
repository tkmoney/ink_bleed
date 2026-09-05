import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function ready(page: Page) {
  // Keep loading/lifecycle checks independent of Google's network availability.
  await page.route('https://fonts.googleapis.com/**', (route) => route.fulfill({
    contentType: 'text/css',
    body: ['Bonheur Royale', 'Eagle Lake'].map((family) =>
      `@font-face { font-family: "${family}"; src: local("Arial"), local("Liberation Sans"), local("DejaVu Sans"); }`).join('\n'),
  }));
  await page.addInitScript(() => {
    const load = document.fonts.load.bind(document.fonts);
    document.fonts.load = async (font, text) => {
      await new Promise<void>((resolve) => window.addEventListener('release-test-font', () => resolve(), { once: true }));
      return load(font, text);
    };
  });
  await page.goto('http://127.0.0.1:5174/');
  await expect(page.locator('#studio')).toHaveAttribute('data-ready', 'true');
  await page.evaluate(() => {
    const { engine, settings } = window.__inkStudio!;
    engine.app.stop();
    settings.quality = 700;
    engine.setQuality();
  });
  await page.getByRole('button', { name: 'Source settings', exact: true }).click();
}

async function releaseFont(page: Page, family: string) {
  await page.evaluate(() => window.dispatchEvent(new Event('release-test-font')));
  await expect.poll(() => page.evaluate((name) =>
    [...document.fonts].some((face) => face.family.includes(name) && face.status === 'loaded'), family)).toBe(true);
}

test('both Google Font options wait for loading before rasterizing ink', async ({ page }) => {
  await ready(page);
  for (const family of ['Bonheur Royale', 'Eagle Lake']) {
    await page.getByLabel('Typeface', { exact: true }).selectOption({ label: family });
    expect(await page.evaluate(() => window.__inkStudio!.engine.metrics(true).targetPixels)).toBe(0);
    await releaseFont(page, family);
    await expect.poll(() => page.evaluate(() => window.__inkStudio!.engine.metrics(true).targetPixels)).toBeGreaterThan(1000);
    expect(await page.evaluate(() => window.__inkStudio!.settings.font)).toBe(family);
    expect(await page.evaluate(() => window.__inkStudio!.engine.elapsed)).toBe(0);
  }
});

test('late font loads cannot undo Clear or a newer source selection', async ({ page }) => {
  await ready(page);
  await page.getByLabel('Typeface', { exact: true }).selectOption({ label: 'Bonheur Royale' });
  await page.evaluate(() => window.__inkStudio!.engine.clear());
  const clearedTime = await page.evaluate(() => window.__inkStudio!.engine.elapsed);
  await releaseFont(page, 'Bonheur Royale');
  expect(await page.evaluate(() => window.__inkStudio!.engine.metrics(true).targetPixels)).toBe(0);
  expect(await page.evaluate(() => window.__inkStudio!.engine.elapsed)).toBe(clearedTime);

  await page.getByLabel('Typeface', { exact: true }).selectOption({ label: 'Eagle Lake' });
  await page.getByLabel('Typeface', { exact: true }).selectOption({ label: 'Editorial serif' });
  const before = await page.evaluate(() => {
    const { engine } = window.__inkStudio!;
    const ticker = engine.app.ticker;
    ticker.maxFPS = 0;
    let now = ticker.lastTime;
    for (let i = 0; i < 4; i++) ticker.update(now += 1000 / 24 + 0.01);
    return engine.metrics(true);
  });
  await releaseFont(page, 'Eagle Lake');
  const after = await page.evaluate(() => window.__inkStudio!.engine.metrics(true));
  expect(after.elapsed).toBe(before.elapsed);
  expect(after.pigment).toBe(before.pigment);
  expect(after.targetPixels).toBe(before.targetPixels);
  expect(await page.evaluate(() => window.__inkStudio!.settings.font)).toBe('Georgia');
});

test('font loading failures are visible and another typeface remains usable', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    document.fonts.load = () => Promise.reject(new Error('Simulated font download failure'));
  });
  await page.getByLabel('Typeface', { exact: true }).selectOption({ label: 'Bonheur Royale' });
  await expect(page.locator('#status')).toContainText('Could not load Bonheur Royale');
  await expect(page.locator('#fatal-error')).toBeHidden();
  expect(await page.evaluate(() => window.__inkStudio!.engine.metrics(true).targetPixels)).toBe(0);
  await page.getByLabel('Typeface', { exact: true }).selectOption({ label: 'Editorial serif' });
  expect(await page.evaluate(() => window.__inkStudio!.engine.metrics(true).targetPixels)).toBeGreaterThan(1000);
});

import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function ready(page: Page) {
  await page.goto('http://127.0.0.1:5174/?scoutTheme=light');
  await expect(page.locator('#studio')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  await page.getByLabel('Model', { exact: true }).selectOption({ label: 'Capillary study' });
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  // Software WebGL in CI: keep the real shaders, but reduce the simulation grid.
  await page.evaluate(() => {
    window.__inkStudio!.settings.quality = 700;
    window.__inkStudio!.engine.setQuality();
  });
}

async function metrics(page: Page) {
  return page.evaluate(() => window.__inkStudio!.engine.metrics());
}

async function advanceTo(page: Page, seconds: number) {
  return page.evaluate((target) => {
    const { engine } = window.__inkStudio!;
    engine.app.stop();
    const ticker = engine.app.ticker;
    ticker.maxFPS = 0;
    let timestamp = ticker.lastTime;
    for (let frame = 0; engine.elapsed < target && frame < 1000; frame++) {
      timestamp += 1000 / 60 + 0.01;
      ticker.update(timestamp);
    }
    return engine.metrics();
  }, seconds);
}

test('renders real ink, grows it through feedback, and exports the paper', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await ready(page);
  await expect.poll(async () => (await metrics(page)).occupied).toBeGreaterThan(1500);
  const early = await metrics(page);
  await expect.poll(() => page.evaluate(() => window.__inkStudio!.engine.elapsed), { timeout: 45_000 }).toBeGreaterThan(6);
  const later = await metrics(page);
  expect(later.pigment).toBeGreaterThan(early.pigment);
  expect(later.occupied).toBeGreaterThan(early.occupied);
  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.screenshot({ path: 'test-results\\studio-desktop.png' });
  const paused = await metrics(page);
  await page.waitForTimeout(400);
  expect((await metrics(page)).frame).toBe(paused.frame);
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Save PNG', exact: true }).click();
  const download = await downloadEvent;
  expect(download.suggestedFilename()).toBe('ink-bleed.png');
  expect(await download.failure()).toBeNull();
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  expect((await metrics(page)).pigment).toBe(0);
  await page.getByRole('button', { name: 'Replay', exact: true }).click();
  await expect.poll(async () => (await metrics(page)).occupied).toBeGreaterThan(1000);
  await page.locator('canvas#scene').click({ position: { x: 50, y: 400 } });
  await page.keyboard.press('Space');
  await expect(page.locator('#studio')).toHaveAttribute('data-paused', 'true');
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await page.keyboard.press('c');
  expect((await metrics(page)).pigment).toBe(0);
  await page.keyboard.press('r');
  await expect(page.locator('#studio')).toHaveAttribute('data-paused', 'false');
  await expect.poll(async () => (await metrics(page)).occupied).toBeGreaterThan(1000);
  expect(errors).toEqual([]);
});

test('Tweakpane edits text and presets; shortcuts do not hijack typing', async ({ page }) => {
  await ready(page);
  await expect.poll(async () => (await page.locator('#controls').boundingBox())!.height).toBeLessThanOrEqual(300);
  await expect(page.getByRole('button', { name: 'Actions', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'Quality', exact: true })).toBeHidden();
  const text = page.getByLabel('Text', { exact: true });
  await text.fill('Paper & Ink');
  await text.press('Enter');
  expect(await page.evaluate(() => window.__inkStudio!.settings.text)).toBe('Paper & Ink');
  await text.fill('r c h');
  await text.press('Space');
  expect(await page.evaluate(() => window.__inkStudio!.engine.paused)).toBe(false);
  await page.getByRole('button', { name: 'Appearance', exact: true }).click();
  await page.getByLabel('Preset', { exact: true }).selectOption({ label: 'Wine wash' });
  expect(await page.evaluate(() => window.__inkStudio!.settings.color)).toBe('#692d43');
  await expect(page.getByLabel('Preset', { exact: true })).toHaveValue('Wine wash');
  await page.getByLabel('Pigment', { exact: true }).fill('0.5');
  await page.getByLabel('Pigment', { exact: true }).press('Enter');
  await expect(page.getByLabel('Preset', { exact: true })).toHaveValue('Custom');
  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name: 'Reset controls', exact: true }).click();
  await expect(text).toHaveValue('Ink Bleed');
  await expect(page.getByRole('button', { name: 'Appearance', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await page.locator('#scene').click({ position: { x: 50, y: 400 } });
  await page.keyboard.press('h');
  await expect(page.locator('#controls')).toBeHidden();
  await expect(page.locator('#restore-controls')).toBeVisible();
  await page.getByRole('button', { name: 'Controls', exact: true }).click();
  await expect(page.locator('#controls')).toBeVisible();
  await expect(page.locator('#restore-controls')).toBeHidden();
  await page.keyboard.press('h');
  await expect(page.locator('#controls')).toBeHidden();
  await page.keyboard.press('h');
  await expect(page.locator('#controls')).toBeVisible();
  await page.getByRole('button', { name: 'Controls', exact: true }).click();
  await expect(text).toBeHidden();
  // A rebuild while collapsed must not reopen the panel.
  await page.evaluate(() => window.__inkStudio!.setMode('draw'));
  await expect(page.getByRole('button', { name: 'Controls', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByLabel('Source', { exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Controls', exact: true }).click();
  await expect(page.getByLabel('Source', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading')).toHaveCount(0);
  await expect(page.locator('header, footer, dialog, .transport, .source-tabs, .presets, .composition-note, .source-hint, .empty-image')).toHaveCount(0);
  await expect(page.locator('#studio > button:visible')).toHaveCount(0);
  await expect(page.locator('#controls')).toHaveCSS('width', '260px');
});

test('drawing follows the pointer, spreads beyond the source, then fades fully', async ({ page }) => {
  await ready(page);
  await page.getByLabel('Source', { exact: true }).selectOption({ label: 'Draw' });
  await page.evaluate(() => {
    const { engine, settings } = window.__inkStudio!;
    settings.fadeDelay = 0.4;
    settings.fadeDuration = 1.2;
    settings.dryTime = 1;
    engine.applySettings();
  });
  await page.mouse.move(240, 410);
  await expect(page.locator('#brush-cursor')).toBeVisible();
  await page.mouse.down();
  await page.mouse.move(550, 450, { steps: 20 });
  await page.mouse.up();
  await expect.poll(async () => (await metrics(page)).occupied).toBeGreaterThan(800);
  const fresh = await metrics(page);
  expect(fresh.mode).toBe('draw');
  expect(fresh.core).toBeGreaterThan(10000);
  expect(fresh.bounds.minX / fresh.width).toBeGreaterThan(200 / 1440);
  expect(fresh.bounds.maxX / fresh.width).toBeLessThan(590 / 1440);
  expect(fresh.bounds.minY / fresh.height).toBeGreaterThan(370 / 1000);
  expect(fresh.bounds.maxY / fresh.height).toBeLessThan(490 / 1000);
  await expect.poll(async () => (await metrics(page)).pigment, { timeout: 25_000 }).toBeLessThan(fresh.pigment * 0.02);
  await expect.poll(async () => (await metrics(page)).occupied).toBe(0);
  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  await page.mouse.click(300, 350);
  await expect.poll(async () => (await metrics(page)).occupied).toBeGreaterThan(35);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const paused = await metrics(page);
  await page.mouse.click(600, 450);
  expect((await metrics(page)).pigment).toBe(paused.pigment);
});

test('uploads an image mask, supports alpha and rejects invalid files', async ({ page }) => {
  await ready(page);
  await page.getByLabel('Source', { exact: true }).selectOption({ label: 'Image' });
  await expect(page.getByRole('button', { name: 'Choose image', exact: true })).toBeVisible();
  await expect(page.locator('#empty-image')).toHaveCount(0);
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 160;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, 240, 160);
    context.fillStyle = '#000';
    context.fillRect(45, 40, 150, 80);
    return canvas.toDataURL().split(',')[1];
  });
  const chooserEvent = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Choose image', exact: true }).click();
  await (await chooserEvent).setFiles({ name: 'mark.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
  await expect.poll(() => page.evaluate(() => window.__inkStudio!.engine.imageName)).toBe('mark.png');
  await expect(page.locator('#status')).toBeHidden();
  await expect.poll(async () => (await metrics(page)).occupied).toBeGreaterThan(3000);
  await page.getByRole('button', { name: 'Source settings', exact: true }).click();
  await page.getByLabel('Mask from', { exact: true }).selectOption({ label: 'Transparency' });
  await page.getByLabel('Reveal', { exact: true }).selectOption({ label: 'Ink drops' });
  await expect.poll(async () => (await metrics(page)).occupied).toBeGreaterThan(5000);
  await page.locator('#image-input').setInputFiles({ name: 'bad.txt', mimeType: 'text/plain', buffer: Buffer.from('no image') });
  await expect(page.locator('#status')).toContainText('Choose a PNG');
  expect(await page.evaluate(() => window.__inkStudio!.engine.imageName)).toBe('mark.png');
  await page.getByLabel('Source', { exact: true }).selectOption({ label: 'Text' });
  const dataTransfer = await page.evaluateHandle((data) => {
    const transfer = new DataTransfer();
    const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
    transfer.items.add(new File([bytes], 'dropped.png', { type: 'image/png' }));
    return transfer;
  }, png);
  await page.locator('canvas#scene').dispatchEvent('dragover', { dataTransfer });
  await expect(page.locator('#studio')).toHaveClass('dragging');
  await page.locator('canvas#scene').dispatchEvent('drop', { dataTransfer });
  await dataTransfer.dispose();
  await expect.poll(() => page.evaluate(() => window.__inkStudio!.engine.imageName)).toBe('dropped.png');
  await expect(page.locator('#studio')).toHaveAttribute('data-mode', 'image');
  await expect(page.locator('#studio')).not.toHaveClass('dragging');
  await expect(page.locator('#status')).toBeHidden();
});

test('responsive canvas, mobile controls, resize and quality changes', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await ready(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('canvas#scene')).toHaveCSS('width', '390px');
  await expect(page.getByLabel('Source', { exact: true })).toBeHidden();
  await expect(page.locator('#controls')).toBeVisible();
  await page.getByRole('button', { name: 'Controls', exact: true }).click();
  await page.getByLabel('Source', { exact: true }).selectOption({ label: 'Draw' });
  await page.getByRole('button', { name: 'Controls', exact: true }).click();
  await expect(page.getByLabel('Source', { exact: true })).toBeHidden();
  await page.mouse.move(80, 340);
  await page.mouse.down();
  await page.mouse.move(260, 410, { steps: 15 });
  await page.mouse.up();
  await expect.poll(async () => (await metrics(page)).occupied).toBeGreaterThan(1000);
  await page.setViewportSize({ width: 1200, height: 800 });
  await page.getByRole('button', { name: 'Controls', exact: true }).click();
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  await page.getByRole('button', { name: 'Quality', exact: true }).click();
  await page.getByLabel('Resolution', { exact: true }).selectOption({ label: 'Draft / 900' });
  await expect.poll(async () => (await metrics(page)).width).toBe(900);
  await expect.poll(async () => (await metrics(page)).occupied).toBeGreaterThan(500);
  expect(errors).toEqual([]);
});

test('small screens start with only the collapsed Controls panel', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto('http://127.0.0.1:5174/?scoutTheme=light');
  await expect(page.locator('#studio')).toHaveAttribute('data-ready', 'true');
  await expect(page.getByRole('button', { name: 'Controls', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByLabel('Source', { exact: true })).toBeHidden();
  await expect(page.locator('canvas#scene')).toHaveCSS('width', '320px');
  await expect(page.locator('canvas#scene')).toHaveCSS('height', '568px');
  await page.getByRole('button', { name: 'Controls', exact: true }).click();
  await expect(page.getByLabel('Source', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  await page.getByRole('button', { name: 'Actions', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save PNG', exact: true })).toBeEnabled();
  const bounds = await page.locator('#controls').boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(568);
});

test('feedback continues spreading after injection ends, and dry ink stays fixed', async ({ page }) => {
  await ready(page);
  await page.evaluate(() => {
    const { engine, settings } = window.__inkStudio!;
    settings.revealDuration = 0.5;
    settings.dryTime = 2.5;
    settings.spread = 1.5;
    engine.applySettings(true);
  });
  const deposited = await advanceTo(page, 0.8);
  const spread = await advanceTo(page, 2);
  expect(spread.occupied).toBeGreaterThan(deposited.occupied * 1.02);
  expect(spread.core).toBeCloseTo(deposited.core, -3);
  expect(spread.occupied).toBeGreaterThan(spread.coreOccupied * 1.1);
  const dry = await advanceTo(page, 3.7);
  const later = await advanceTo(page, 4.2);
  expect(later.pigment).toBe(dry.pigment);
});

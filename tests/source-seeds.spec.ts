import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('http://127.0.0.1:5174/source-seeds-test', (route) => route.fulfill({
    contentType: 'text/html',
    body: '<!doctype html><title>Source mask tests</title>',
  }));
  await page.goto('http://127.0.0.1:5174/source-seeds-test');
});

test('blank and zero-sized targets produce transparent canvases of the same dimensions', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const moduleUrl = '/src/source-seeds.ts';
    const { createInkSeeds } = await import(moduleUrl) as typeof import('../src/source-seeds');
    const target = document.createElement('canvas');
    target.width = 320;
    target.height = 180;
    const blank = (['write-on', 'drops'] as const).map((mode) => {
      const seeds = createInkSeeds(target, { mode, width: 2, seed: 4, dropSpacing: 30 });
      return {
        width: seeds.width,
        height: seeds.height,
        empty: seeds.getContext('2d')!.getImageData(0, 0, 320, 180).data.every((value) => value === 0),
      };
    });
    target.width = 0;
    const zero = createInkSeeds(target, { mode: 'write-on', width: 2, seed: 4, dropSpacing: 30 });
    return { blank, zero: [zero.width, zero.height] };
  });
  expect(result.blank).toEqual([
    { width: 320, height: 180, empty: true },
    { width: 320, height: 180, empty: true },
  ]);
  expect(result.zero).toEqual([0, 180]);
});

for (const mode of ['write-on', 'drops'] as const) {
  test(`${mode} retains disconnected components, dots, tiny islands, and a thin diagonal`, async ({ page }) => {
    const result = await page.evaluate(async (mode) => {
      const moduleUrl = '/src/source-seeds.ts';
      const { createInkSeeds } = await import(moduleUrl) as typeof import('../src/source-seeds');
      const target = document.createElement('canvas');
      target.width = 2000;
      target.height = 300;
      const context = target.getContext('2d')!;
      context.fillStyle = '#fff';
      const regions = [
        [20, 90, 180, 100],
        [240, 80, 60, 140],
        [262, 45, 12, 12],
        [900, 30, 1, 1],
        [940, 30, 2, 2],
        [1000, 30, 1, 180],
      ];
      for (const [x, y, width, height] of regions) context.fillRect(x, y, width, height);
      for (let index = 0; index < 160; index++) context.fillRect(1500 + index, 50 + index, 1, 1);
      regions.push([1500, 50, 160, 160]);
      const before = target.toDataURL();
      const seeds = createInkSeeds(target, { mode, width: 1, seed: 91, dropSpacing: 35 });
      const seeded = regions.map(([x, y, width, height]) => {
        const data = seeds.getContext('2d')!.getImageData(x, y, width, height).data;
        return data.some((alpha, index) => index % 4 === 3 && alpha > 0);
      });
      return { seeded, unchanged: before === target.toDataURL() };
    }, mode);
    expect(result.seeded).toEqual(Array(7).fill(true));
    expect(result.unchanged).toBe(true);
  });

  test(`${mode} is white, clipped to antialiased alpha, and never seeds a hole or background`, async ({ page }) => {
    const result = await page.evaluate(async (mode) => {
      const moduleUrl = '/src/source-seeds.ts';
      const { createInkSeeds } = await import(moduleUrl) as typeof import('../src/source-seeds');
      const target = document.createElement('canvas');
      target.width = 340;
      target.height = 250;
      const context = target.getContext('2d')!;
      context.fillStyle = '#fff';
      context.beginPath();
      context.arc(130.25, 125.75, 105.5, 0, Math.PI * 2);
      context.arc(130.25, 125.75, 57.5, 0, Math.PI * 2, true);
      context.fill();
      context.fillStyle = 'rgba(255, 255, 255, 0.4)';
      context.fillRect(300, 40, 1, 1);
      const targetData = context.getImageData(0, 0, target.width, target.height).data;
      const seeds = createInkSeeds(target, { mode, width: 2, seed: 31, dropSpacing: 32 });
      const output = seeds.getContext('2d')!.getImageData(0, 0, target.width, target.height).data;
      let ink = 0;
      let outside = 0;
      let alphaExceeded = 0;
      let nonwhite = 0;
      for (let index = 0; index < output.length; index += 4) {
        if (!output[index + 3]) continue;
        ink++;
        if (!targetData[index + 3]) outside++;
        if (output[index + 3] > targetData[index + 3]) alphaExceeded++;
        if (output[index] !== 255 || output[index + 1] !== 255 || output[index + 2] !== 255) nonwhite++;
      }
      const translucent = (40 * target.width + 300) * 4 + 3;
      return {
        ink,
        outside,
        alphaExceeded,
        nonwhite,
        translucent: [output[translucent], targetData[translucent]],
      };
    }, mode);
    expect(result.ink).toBeGreaterThan(40);
    expect(result.outside).toBe(0);
    expect(result.alphaExceeded).toBe(0);
    expect(result.nonwhite).toBe(0);
    expect(result.translucent[0]).toBe(result.translucent[1]);
  });
}

test('drop placement is reproducible, varies with seed, and distributes sources across large components', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const moduleUrl = '/src/source-seeds.ts';
    const { createInkSeeds } = await import(moduleUrl) as typeof import('../src/source-seeds');
    const target = document.createElement('canvas');
    target.width = 420;
    target.height = 220;
    target.getContext('2d')!.fillRect(10, 10, 400, 200);
    const options = { mode: 'drops', width: 2, seed: 1024, dropSpacing: 40 } as const;
    const first = createInkSeeds(target, options);
    const repeat = createInkSeeds(target, options);
    const other = createInkSeeds(target, { ...options, seed: 2048 });
    const sparse = createInkSeeds(target, { ...options, dropSpacing: 90 });
    const count = (canvas: HTMLCanvasElement) => {
      const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      return data.reduce((total, alpha, index) => total + Number(index % 4 === 3 && alpha > 0), 0);
    };
    const sections = Array.from({ length: 4 }, (_, index) => {
      const data = first.getContext('2d')!.getImageData(10 + index * 100, 10, 100, 200).data;
      return data.some((alpha, offset) => offset % 4 === 3 && alpha > 0);
    });
    return {
      identical: first.toDataURL() === repeat.toDataURL(),
      different: first.toDataURL() !== other.toDataURL(),
      sections,
      dense: count(first),
      sparse: count(sparse),
    };
  });
  expect(result.identical).toBe(true);
  expect(result.different).toBe(true);
  expect(result.sections).toEqual([true, true, true, true]);
  expect(result.dense).toBeGreaterThan(result.sparse * 2);
});

test('drops favor opaque interiors over connected faint antialiased edges', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const moduleUrl = '/src/source-seeds.ts';
    const { createInkSeeds } = await import(moduleUrl) as typeof import('../src/source-seeds');
    const target = document.createElement('canvas');
    target.width = 160;
    target.height = 60;
    const ctx = target.getContext('2d')!;
    ctx.globalAlpha = 0.08;
    ctx.fillRect(10, 10, 120, 40);
    ctx.globalAlpha = 1;
    ctx.fillRect(10, 44, 120, 6);
    return [12, 37, 84].map((seed) => {
      const source = createInkSeeds(target, { mode: 'drops', width: 3, seed, dropSpacing: 40 });
      const data = source.getContext('2d')!.getImageData(0, 0, 160, 60).data;
      return data.some((alpha, index) => index % 4 === 3 && alpha === 255);
    });
  });
  expect(result).toEqual([true, true, true]);
});

test('each drop has an independent seeded delay without changing the source mask', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const moduleUrl = '/src/source-seeds.ts';
    const { createInkSeeds } = await import(moduleUrl) as typeof import('../src/source-seeds');
    const target = document.createElement('canvas');
    target.width = 300;
    target.height = 100;
    target.getContext('2d')!.fillRect(10, 10, 280, 80);
    const options = { mode: 'drops', width: 4, seed: 12, dropSpacing: 40 } as const;
    const collect = (seed: number) => {
      const drops: import('../src/source-seeds').InkDrop[] = [];
      const canvas = createInkSeeds(target, { ...options, seed, onDrop: (drop) => drops.push(drop) });
      return { drops, mask: canvas.toDataURL() };
    };
    return {
      first: collect(12), repeat: collect(12), other: collect(37),
      original: createInkSeeds(target, options).toDataURL(),
    };
  });
  expect(result.first).toEqual(result.repeat);
  expect(result.first.mask).toBe(result.original);
  const delays = result.first.drops.map((drop) => drop.delay);
  expect(delays.length).toBeGreaterThan(5);
  expect(new Set(delays).size).toBe(delays.length);
  expect(delays.every((value) => value >= 0 && value < 1)).toBe(true);
  expect(Math.max(...delays) - Math.min(...delays)).toBeGreaterThan(0.5);
  expect(result.other.drops.map((drop) => drop.delay)).not.toEqual(delays);
});

test('source width stays independent of the thick silhouette and offers subpixel control', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const moduleUrl = '/src/source-seeds.ts';
    const { createInkSeeds } = await import(moduleUrl) as typeof import('../src/source-seeds');
    const target = document.createElement('canvas');
    target.width = 500;
    target.height = 200;
    target.getContext('2d')!.fillRect(20, 20, 460, 160);
    const mass = (canvas: HTMLCanvasElement) => {
      const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      return data.reduce((total, alpha, index) => total + (index % 4 === 3 ? alpha / 255 : 0), 0);
    };
    return (['write-on', 'drops'] as const).map((mode) => {
      const options = { mode, width: 0.5, seed: 48, dropSpacing: 45 };
      const thin = mass(createInkSeeds(target, options));
      const thick = mass(createInkSeeds(target, { ...options, width: 3 }));
      return { mode, thin, thick, target: mass(target) };
    });
  });
  for (const { thin, thick, target } of result) {
    expect(thin).toBeGreaterThan(0);
    expect(thick).toBeGreaterThan(thin * 2);
    expect(thick).toBeLessThan(target * 0.08);
  }
  expect(result[0].thin).toBeGreaterThan(100);
});

test('ordinary 1400x900 and solid 2000x2000 masks complete with bounded work', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const moduleUrl = '/src/source-seeds.ts';
    const { createInkSeeds } = await import(moduleUrl) as typeof import('../src/source-seeds');
    const target = document.createElement('canvas');
    target.width = 1400;
    target.height = 900;
    const context = target.getContext('2d')!;
    context.font = 'bold 330px serif';
    context.fillText('Ink 8i', 80, 400);
    context.fillRect(120, 550, 1100, 230);
    const results = (['write-on', 'drops'] as const).map((mode) => {
      const start = performance.now();
      const seeds = createInkSeeds(target, { mode, width: 2, seed: 71, dropSpacing: 60 });
      return { milliseconds: performance.now() - start, valid: seeds.width === 1400 && seeds.height === 900 };
    });
    target.width = target.height = 2000;
    target.getContext('2d')!.fillRect(0, 0, 2000, 2000);
    const start = performance.now();
    const seeds = createInkSeeds(target, { mode: 'write-on', width: 2, seed: 71, dropSpacing: 60 });
    const pixels = seeds.getContext('2d')!.getImageData(0, 0, 2000, 2000).data;
    results.push({
      milliseconds: performance.now() - start,
      valid: pixels.some((alpha, index) => index % 4 === 3 && alpha > 0),
    });
    return results;
  });
  for (const { milliseconds, valid } of result) {
    expect(valid).toBe(true);
    expect(milliseconds).toBeLessThan(5000);
  }
});

export interface InkDrop {
  x: number;
  y: number;
  radius: number;
  /** Repeatable start offset in [0, 1), scaled by the chosen stagger duration. */
  delay: number;
}

export interface InkSeedOptions {
  mode: 'write-on' | 'drops';
  /** Source diameter in render pixels, independent of the target's thickness. */
  width: number;
  /** Finite number, normalized to a 32-bit integer for reproducible drops. */
  seed: number;
  /** Approximate distance between drop centers in render pixels. */
  dropSpacing: number;
  /** Optional schedule metadata; does not change the white source mask. */
  onDrop?: (drop: InkDrop) => void;
}

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MAX_SKELETON_SIDE = 256;

function context2D(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  // CPU rasterization retains subpixel dots that some GPU canvas paths discard.
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Ink seed masks require a 2D canvas.');
  return context;
}

function thinningRules(secondPass: boolean): Uint8Array {
  const rules = new Uint8Array(256);
  for (let bits = 0; bits < rules.length; bits++) {
    const neighbors = Array.from({ length: 8 }, (_, index) => (bits >> index) & 1);
    const count = neighbors.reduce((total, value) => total + value, 0);
    let transitions = 0;
    for (let index = 0; index < 8; index++) {
      if (!neighbors[index] && neighbors[(index + 1) % 8]) transitions++;
    }
    const [north, , east, , south, , west] = neighbors;
    const blocked = secondPass
      ? north * east * west || north * south * west
      : north * east * south || east * south * west;
    rules[bits] = Number(count >= 2 && count <= 6 && transitions === 1 && !blocked);
  }
  return rules;
}

const THINNING_RULES = [thinningRules(false), thinningRules(true)];

function skeletonize(mask: Uint8Array, columns: number, rows: number): void {
  const removals = new Uint32Array(mask.length);
  let remaining = mask.reduce((sum, pixel) => sum + pixel, 0);
  // The padded, bounded grid makes even a solid 2000px image a small thinning job.
  for (let iteration = 0; iteration < Math.max(columns, rows); iteration++) {
    let changed = false;
    for (const rules of THINNING_RULES) {
      let count = 0;
      for (let y = 1; y < rows - 1; y++) {
        for (let x = 1; x < columns - 1; x++) {
          const index = y * columns + x;
          if (!mask[index]) continue;
          const bits = mask[index - columns]
            | (mask[index - columns + 1] << 1)
            | (mask[index + 1] << 2)
            | (mask[index + columns + 1] << 3)
            | (mask[index + columns] << 4)
            | (mask[index + columns - 1] << 5)
            | (mask[index - 1] << 6)
            | (mask[index - columns - 1] << 7);
          if (rules[bits]) removals[count++] = index;
        }
      }
      // Simultaneous thinning can erase a tiny 2x2 island. Keep its last pixel.
      if (count === remaining) count--;
      for (let index = 0; index < count; index++) mask[removals[index]] = 0;
      remaining -= count;
      changed ||= count > 0;
    }
    if (!changed) break;
  }
}

function drawCenterlines(
  context: CanvasRenderingContext2D,
  pixels: Uint32Array,
  bounds: Bounds,
  crop: Bounds,
): void {
  // The area bound also limits allocations for long, sparse, winding components.
  const scale = Math.max(
    1,
    Math.ceil(Math.max(bounds.width, bounds.height) / MAX_SKELETON_SIDE),
    Math.ceil(Math.sqrt(bounds.width * bounds.height / (pixels.length * 4))),
  );
  const columns = Math.ceil(bounds.width / scale) + 2;
  const rows = Math.ceil(bounds.height / scale) + 2;
  const mask = new Uint8Array(columns * rows);
  const representatives = new Int32Array(mask.length).fill(-1);
  const distances = new Float64Array(mask.length).fill(Infinity);
  for (const pixel of pixels) {
    const x = pixel % crop.width - bounds.x;
    const y = Math.floor(pixel / crop.width) - bounds.y;
    const cellX = Math.floor(x / scale);
    const cellY = Math.floor(y / scale);
    const index = (cellY + 1) * columns + cellX + 1;
    const dx = x + 0.5 - Math.min((cellX + 0.5) * scale, bounds.width - 0.5);
    const dy = y + 0.5 - Math.min((cellY + 0.5) * scale, bounds.height - 0.5);
    const distance = dx * dx + dy * dy;
    mask[index] = 1;
    if (distance < distances[index]) {
      distances[index] = distance;
      representatives[index] = pixel;
    }
  }

  skeletonize(mask, columns, rows);
  context.beginPath();
  const isolated = new Path2D();
  const neighbors = [-columns - 1, -columns, -columns + 1, -1, 1, columns - 1, columns, columns + 1];
  for (let index = 0; index < mask.length; index++) {
    if (!mask[index]) continue;
    const pixel = representatives[index];
    const x = crop.x + pixel % crop.width + 0.5;
    const y = crop.y + Math.floor(pixel / crop.width) + 0.5;
    let connected = false;
    for (const offset of neighbors) {
      if (!mask[index + offset]) continue;
      connected = true;
      if (offset < 0) continue;
      const neighbor = representatives[index + offset];
      context.moveTo(x, y);
      context.lineTo(
        crop.x + neighbor % crop.width + 0.5,
        crop.y + Math.floor(neighbor / crop.width) + 0.5,
      );
    }
    if (!connected) {
      const radius = context.lineWidth / 2;
      isolated.moveTo(x + radius, y);
      isolated.arc(x, y, radius, 0, Math.PI * 2);
    }
  }
  context.stroke();
  context.fill(isolated);
}

function randomUnit(value: number): number {
  let hash = value | 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x21f0aaad);
  hash = Math.imul(hash ^ (hash >>> 15), 0x735a2d97);
  return ((hash ^ (hash >>> 15)) >>> 0) / 4294967296;
}

function drawDrops(
  context: CanvasRenderingContext2D,
  pixels: Uint32Array,
  bounds: Bounds,
  crop: Bounds,
  options: InkSeedOptions,
  targetAlpha: Uint8ClampedArray,
): void {
  const spacing = Math.max(1, options.dropSpacing, options.width * 2);
  const columns = Math.ceil(bounds.width / spacing);
  const rows = Math.ceil(bounds.height / spacing);
  const candidates = new Int32Array(columns * rows).fill(-1);
  const distances = new Float64Array(candidates.length).fill(Infinity);
  const seed = (options.seed | 0) ^ Math.imul(pixels[0] + 1, 0x9e3779b1);
  for (const pixel of pixels) {
    const x = pixel % crop.width - bounds.x;
    const y = Math.floor(pixel / crop.width) - bounds.y;
    const cellX = Math.floor(x / spacing);
    const cellY = Math.floor(y / spacing);
    const index = cellY * columns + cellX;
    const key = seed ^ Math.imul(index + 1, 0x9e3779b1);
    const dx = x + 0.5 - (cellX + 0.25 + randomUnit(key) * 0.5) * spacing;
    const dy = y + 0.5 - (cellY + 0.25 + randomUnit(key ^ 0x68bc21eb) * 0.5) * spacing;
    const alpha = targetAlpha[((crop.y + bounds.y + y) * context.canvas.width
      + crop.x + bounds.x + x) * 4 + 3] / 255;
    // Prefer opaque interiors so a faint antialiased edge cannot seed a whole letter.
    const distance = dx * dx + dy * dy + (1 - alpha) * spacing * spacing;
    if (distance < distances[index]) {
      distances[index] = distance;
      candidates[index] = pixel;
    }
  }

  const minimumDistanceSquared = (spacing * 0.65) ** 2;
  const radius = options.width / 2;
  context.beginPath();
  for (let index = 0; index < candidates.length; index++) {
    const pixel = candidates[index];
    if (pixel < 0) continue;
    const x = pixel % crop.width;
    const y = Math.floor(pixel / crop.width);
    const cellX = index % columns;
    const cellY = Math.floor(index / columns);
    let tooClose = false;
    for (let row = Math.max(0, cellY - 1); row <= cellY; row++) {
      for (let column = Math.max(0, cellX - 1); column <= Math.min(columns - 1, cellX + 1); column++) {
        const neighborIndex = row * columns + column;
        if (neighborIndex >= index || candidates[neighborIndex] < 0) continue;
        const neighbor = candidates[neighborIndex];
        const dx = x - neighbor % crop.width;
        const dy = y - Math.floor(neighbor / crop.width);
        if (dx * dx + dy * dy < minimumDistanceSquared) tooClose = true;
      }
    }
    if (tooClose) {
      candidates[index] = -1;
      continue;
    }
    context.moveTo(crop.x + x + 0.5 + radius, crop.y + y + 0.5);
    context.arc(crop.x + x + 0.5, crop.y + y + 0.5, radius, 0, Math.PI * 2);
    options.onDrop?.({
      x: crop.x + x + 0.5, y: crop.y + y + 0.5, radius,
      delay: randomUnit(seed ^ Math.imul(index + 1, 0x9e3779b1) ^ 0x4f1bbcdc),
    });
  }
  context.fill();
}

/**
 * Extract thin white sources from alpha coverage without changing the target.
 * Components use 8-connectivity, so diagonal strokes stay connected. Only the
 * centerline calculation is downsampled; tiny disconnected components survive.
 * Readback errors (including cross-origin canvas taint) propagate to the caller.
 */
export function createInkSeeds(target: HTMLCanvasElement, options: InkSeedOptions): HTMLCanvasElement {
  if (!Number.isFinite(options.width) || options.width <= 0
    || !Number.isFinite(options.dropSpacing) || options.dropSpacing <= 0
    || !Number.isFinite(options.seed)) {
    throw new RangeError('Ink seed width and spacing must be positive and seed must be finite.');
  }
  const output = document.createElement('canvas');
  output.width = target.width;
  output.height = target.height;
  if (!target.width || !target.height) return output;

  const data = context2D(target).getImageData(0, 0, target.width, target.height).data;
  let minX = target.width;
  let minY = target.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < target.height; y++) {
    for (let x = 0; x < target.width; x++) {
      if (!data[(y * target.width + x) * 4 + 3]) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) return output;

  const crop: Bounds = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  const occupied = new Uint8Array(crop.width * crop.height);
  for (let y = 0; y < crop.height; y++) {
    for (let x = 0; x < crop.width; x++) {
      occupied[y * crop.width + x] = Number(data[((y + crop.y) * target.width + x + crop.x) * 4 + 3] > 0);
    }
  }
  const queue = new Uint32Array(occupied.length);
  const context = context2D(output);
  context.strokeStyle = '#fff';
  context.fillStyle = '#fff';
  context.lineWidth = options.width;
  context.lineCap = 'round';
  context.lineJoin = 'round';

  for (let start = 0; start < occupied.length; start++) {
    if (!occupied[start]) continue;
    let head = 0;
    let tail = 1;
    queue[0] = start;
    occupied[start] = 0;
    minX = maxX = start % crop.width;
    minY = maxY = Math.floor(start / crop.width);
    while (head < tail) {
      const pixel = queue[head++];
      const x = pixel % crop.width;
      const y = Math.floor(pixel / crop.width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      for (let row = Math.max(0, y - 1); row <= Math.min(crop.height - 1, y + 1); row++) {
        for (let column = Math.max(0, x - 1); column <= Math.min(crop.width - 1, x + 1); column++) {
          const neighbor = row * crop.width + column;
          if (!occupied[neighbor]) continue;
          occupied[neighbor] = 0;
          queue[tail++] = neighbor;
        }
      }
    }
    const bounds = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
    const pixels = queue.subarray(0, tail);
    if (options.mode === 'write-on') drawCenterlines(context, pixels, bounds, crop);
    else drawDrops(context, pixels, bounds, crop, options, data);
  }

  context.globalCompositeOperation = 'destination-in';
  context.drawImage(target, 0, 0);
  context.globalCompositeOperation = 'source-over';
  return output;
}

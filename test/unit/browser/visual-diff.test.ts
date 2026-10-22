import { describe, expect, it } from 'vitest';
import { decodePng, encodePng, pixelAt, type RgbaImage } from '../../../src/browser/png.js';
import {
  DEFAULT_CHANGE_THRESHOLD,
  DEFAULT_PIXEL_TOLERANCE,
  diffImages,
  diffPng,
  formatDiff,
  summarizeDiff,
} from '../../../src/browser/visual-diff.js';

type Pixel = readonly [number, number, number, number?];

const image = (
  width: number,
  height: number,
  pixel: (x: number, y: number) => Pixel,
): RgbaImage => {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a = 255] = pixel(x, y);
      data.set([r, g, b, a], (y * width + x) * 4);
    }
  }
  return { width, height, data };
};

const solid = (width: number, height: number, pixel: Pixel): RgbaImage =>
  image(width, height, () => pixel);

const png = (width: number, height: number, pixel: (x: number, y: number) => Pixel): Buffer =>
  encodePng(image(width, height, pixel));

describe('visual diff', () => {
  it('passes identical images with no changed area', () => {
    const a = png(4, 4, () => [10, 20, 30]);
    const r = diffPng(a, a);
    expect(r.pass).toBe(true);
    expect(r.changedPixels).toBe(0);
    expect(r.changedRatio).toBe(0);
    expect(r.totalPixels).toBe(16);
    expect(r.meanDelta).toBe(0);
    expect(r.maxDelta).toBe(0);
    expect(r.bounds).toBeNull();
    expect(r.dimensionsMatch).toBe(true);
    expect(r.diffPng).toBeUndefined();
  });

  it('reports the changed pixel and its bounding box', () => {
    const a = png(10, 10, () => [255, 255, 255]);
    const b = png(10, 10, (x, y) => (x === 4 && y === 6 ? [0, 0, 0] : [255, 255, 255]));
    const r = diffPng(a, b, { changeThreshold: 0 });
    expect(r.pass).toBe(false);
    expect(r.changedPixels).toBe(1);
    expect(r.changedRatio).toBe(0.01);
    expect(r.bounds).toEqual({ x: 4, y: 6, width: 1, height: 1 });
    expect(r.maxDelta).toBe(1);
    expect(r.meanDelta).toBeCloseTo(1 / 100, 5);
  });

  it('ignores anti-aliasing noise and honours the change threshold', () => {
    const base = png(1, 1, () => [100, 100, 100]);
    expect(
      diffPng(
        base,
        png(1, 1, () => [100 + DEFAULT_PIXEL_TOLERANCE, 100, 100]),
      ).changedPixels,
    ).toBe(0);
    const above = png(1, 1, () => [100 + DEFAULT_PIXEL_TOLERANCE + 1, 100, 100]);
    expect(diffPng(base, above).changedPixels).toBe(1);

    const oneOfTen = png(10, 1, (x) => (x === 0 ? [0, 0, 0] : [255, 255, 255]));
    const white = png(10, 1, () => [255, 255, 255]);
    expect(diffPng(white, oneOfTen).pass).toBe(false);
    expect(diffPng(white, oneOfTen, { changeThreshold: 0.1 }).pass).toBe(true);
    expect(DEFAULT_CHANGE_THRESHOLD).toBe(0.001);
  });

  it('fails when the image size changes and compares on the union canvas', () => {
    const a = png(2, 1, () => [255, 0, 0]);
    const b = png(1, 2, () => [255, 0, 0]);
    const r = diffPng(a, b);
    expect(r.pass).toBe(false);
    expect(r.dimensionsMatch).toBe(false);
    expect(r.width).toBe(2);
    expect(r.height).toBe(2);
    expect(r.baselineWidth).toBe(2);
    expect(r.currentHeight).toBe(2);
    // The area one image does not cover is composited over white.
    expect(r.changedPixels).toBe(2);
    expect(r.bounds).toEqual({ x: 0, y: 0, width: 2, height: 2 });
  });

  it('writes a red/gray diff image when asked', () => {
    const baseline = png(2, 1, () => [0, 0, 255]);
    const current = png(2, 1, (x) => (x === 0 ? [0, 0, 255] : [0, 255, 0]));
    const r = diffPng(baseline, current, { includeDiff: true });
    expect(r.diffPng).toBeDefined();
    const diff = decodePng(r.diffPng ?? Buffer.alloc(0));
    expect(diff.width).toBe(2);
    expect(diff.height).toBe(1);
    // Unchanged: the current pixel faded to gray.
    expect(pixelAt(diff, 0, 0)).toEqual([157, 157, 157]);
    // Changed: red.
    expect(pixelAt(diff, 1, 0)).toEqual([235, 64, 72]);
  });

  it('clamps out-of-range options', () => {
    const white = png(1, 1, () => [255, 255, 255]);
    const black = png(1, 1, () => [0, 0, 0]);
    expect(diffPng(white, black, { pixelTolerance: -10 }).changedPixels).toBe(1);
    expect(diffPng(white, black, { pixelTolerance: 999 }).changedPixels).toBe(0);
    expect(diffPng(white, black, { changeThreshold: 2 }).pass).toBe(true);
    expect(diffPng(white, black, { changeThreshold: -1 }).pass).toBe(false);
    expect(diffPng(white, black, { changeThreshold: Number.NaN }).pass).toBe(false);
  });

  it('composites transparent pixels over white before comparing', () => {
    const transparent = encodePng(image(1, 1, () => [0, 0, 0, 0]));
    const white = encodePng(solid(1, 1, [255, 255, 255]));
    expect(diffPng(transparent, white).pass).toBe(true);
  });

  it('compares already-decoded images', () => {
    const r = diffImages(solid(2, 2, [1, 2, 3]), solid(2, 2, [1, 2, 3]));
    expect(r.pass).toBe(true);
    expect(r.totalPixels).toBe(4);
  });

  it('summarizes without carrying pixels, and formats a verdict', () => {
    const baseline = png(3, 2, () => [255, 255, 255]);
    const current = png(3, 2, (x, y) => (x === 1 && y === 1 ? [0, 0, 0] : [255, 255, 255]));
    const r = diffPng(baseline, current, { includeDiff: true });
    const summary = summarizeDiff(r);
    expect(summary).not.toHaveProperty('diffPng');
    expect(summary.pass).toBe(false);
    expect(summary.bounds).toEqual({ x: 1, y: 1, width: 1, height: 1 });

    expect(formatDiff('home', r, 0.001)).toBe(
      'home: 16.67% of 6 pixels changed (limit 0.10%); mean delta 16.67%, changed area 1x1 at 1,1',
    );
    expect(formatDiff('home', diffPng(baseline, baseline), 0.001)).toBe(
      'home: 0.00% of 6 pixels changed (limit 0.10%); mean delta 0.00%',
    );

    const resized = diffPng(
      png(2, 2, () => [0, 0, 0]),
      png(3, 2, () => [0, 0, 0]),
    );
    expect(formatDiff('home', resized, 0.001)).toBe(
      'home: size changed 2x2 → 3x2 (expected the same viewport or element)',
    );
  });
});

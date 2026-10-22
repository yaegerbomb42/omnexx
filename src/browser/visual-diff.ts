import { decodePng, encodePng, pixelAt, type RgbaImage } from './png.js';

/** Per-channel difference ignored as anti-aliasing/compression noise. */
export const DEFAULT_PIXEL_TOLERANCE = 16;
/** Fraction of pixels allowed to differ before a comparison fails (0.1%). */
export const DEFAULT_CHANGE_THRESHOLD = 0.001;

export interface VisualDiffOptions {
  /** 0-255: a channel change at or below this is noise. */
  pixelTolerance?: number;
  /** 0-1: the largest fraction of changed pixels that still passes. */
  changeThreshold?: number;
  /** Whether to build a red/gray diff PNG (off when only metrics are needed). */
  includeDiff?: boolean;
}

export interface VisualDiffBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisualDiffResult {
  /** Size of the union canvas the comparison ran on. */
  width: number;
  height: number;
  baselineWidth: number;
  baselineHeight: number;
  currentWidth: number;
  currentHeight: number;
  dimensionsMatch: boolean;
  changedPixels: number;
  totalPixels: number;
  /** 0-1. */
  changedRatio: number;
  /** Mean per-pixel channel delta over the union canvas, 0-1. */
  meanDelta: number;
  /** Largest single-pixel channel delta seen, 0-1. */
  maxDelta: number;
  bounds: VisualDiffBounds | null;
  pass: boolean;
  /** Present with `includeDiff`; unchanged areas are light gray, changes red. */
  diffPng?: Buffer;
}

/**
 * Compare two PNG screenshots. A size change is always a failure: responsive layout regressions
 * usually show up as a shifted element or a different viewport, and both are meaningful.
 */
export function diffPng(
  baseline: Buffer,
  current: Buffer,
  opts: VisualDiffOptions = {},
): VisualDiffResult {
  const a = decodePng(baseline);
  const b = decodePng(current);
  const tolerance = clamp(opts.pixelTolerance ?? DEFAULT_PIXEL_TOLERANCE, 0, 255);
  const threshold = clamp(opts.changeThreshold ?? DEFAULT_CHANGE_THRESHOLD, 0, 1);
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);
  const totalPixels = width * height;

  let changedPixels = 0;
  let deltaSum = 0;
  let maxDelta = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  const diff = opts.includeDiff ? new Uint8Array(totalPixels * 4) : undefined;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [ar, ag, ab] = pixelAt(a, x, y);
      const [br, bg, bb] = pixelAt(b, x, y);
      const delta = Math.max(Math.abs(ar - br), Math.abs(ag - bg), Math.abs(ab - bb));
      deltaSum += delta;
      if (delta > maxDelta) maxDelta = delta;
      const changed = delta > tolerance;
      if (changed) {
        changedPixels++;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      if (diff) {
        const i = (y * width + x) * 4;
        if (changed) {
          diff[i] = 235;
          diff[i + 1] = 64;
          diff[i + 2] = 72;
          diff[i + 3] = 255;
        } else {
          const gray = Math.round((br + bg + bb) / 3);
          const faded = 120 + Math.round((gray * 110) / 255);
          diff[i] = faded;
          diff[i + 1] = faded;
          diff[i + 2] = faded;
          diff[i + 3] = 255;
        }
      }
    }
  }

  const dimensionsMatch = a.width === b.width && a.height === b.height;
  const changedRatio = totalPixels ? changedPixels / totalPixels : 0;
  const bounds =
    changedPixels > 0
      ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 }
      : null;
  return {
    width,
    height,
    baselineWidth: a.width,
    baselineHeight: a.height,
    currentWidth: b.width,
    currentHeight: b.height,
    dimensionsMatch,
    changedPixels,
    totalPixels,
    changedRatio,
    meanDelta: totalPixels ? deltaSum / totalPixels / 255 : 0,
    maxDelta: maxDelta / 255,
    bounds,
    pass: dimensionsMatch && changedRatio <= threshold,
    ...(diff ? { diffPng: encodePng({ width, height, data: diff }) } : {}),
  };
}

export interface VisualDiffSummary {
  pass: boolean;
  changedPixels: number;
  totalPixels: number;
  changedRatio: number;
  width: number;
  height: number;
  dimensionsMatch: boolean;
  baselineWidth: number;
  baselineHeight: number;
  currentWidth: number;
  currentHeight: number;
  meanDelta: number;
  bounds: VisualDiffBounds | null;
}

/** The serializable part of a diff (no pixels), for events and the editor cockpit. */
export function summarizeDiff(r: VisualDiffResult): VisualDiffSummary {
  return {
    pass: r.pass,
    changedPixels: r.changedPixels,
    totalPixels: r.totalPixels,
    changedRatio: r.changedRatio,
    width: r.width,
    height: r.height,
    dimensionsMatch: r.dimensionsMatch,
    baselineWidth: r.baselineWidth,
    baselineHeight: r.baselineHeight,
    currentWidth: r.currentWidth,
    currentHeight: r.currentHeight,
    meanDelta: r.meanDelta,
    bounds: r.bounds,
  };
}

/** One-line verdict plus the numbers a person or model needs to judge it. */
export function formatDiff(name: string, r: VisualDiffResult, threshold: number): string {
  const pct = (n: number): string => `${(n * 100).toFixed(2)}%`;
  if (!r.dimensionsMatch) {
    return `${name}: size changed ${String(r.baselineWidth)}x${String(r.baselineHeight)} → ${String(r.currentWidth)}x${String(r.currentHeight)} (expected the same viewport or element)`;
  }
  const area = r.bounds
    ? `, changed area ${String(r.bounds.width)}x${String(r.bounds.height)} at ${String(r.bounds.x)},${String(r.bounds.y)}`
    : '';
  return `${name}: ${pct(r.changedRatio)} of ${String(r.totalPixels)} pixels changed (limit ${pct(threshold)}); mean delta ${pct(r.meanDelta)}${area}`;
}

function clamp(n: number, min: number, max: number): number {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

/** Exposed for tests and callers that already have decoded images. */
export function diffImages(
  baseline: RgbaImage,
  current: RgbaImage,
  opts: VisualDiffOptions = {},
): VisualDiffResult {
  return diffPng(encodePng(baseline), encodePng(current), opts);
}

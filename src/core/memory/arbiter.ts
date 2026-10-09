import { createHash } from 'node:crypto';
import type { BankType } from './blocks.js';

export interface ArbiterOptions {
  /** Latent dimension of the embedding space. */
  latentDim?: number;
  /** EMA momentum for the per-bank target representation, in (0, 1). */
  emaMomentum?: number;
  /** Half-life of the recency prior, in seconds. */
  recencyHalfLifeS?: number;
  /** Blend weights; need not sum to 1 but should be non-negative. */
  surpriseWeight?: number;
  recencyWeight?: number;
}

/**
 * Lightweight JEPA latent salience arbiter.
 *
 * An online encoder maps block text into a fixed-dimension latent vector. A target
 * predictor keeps an exponential moving average of each bank's observed latents and
 * predicts the next one. Salience is the prediction error (latent surprise) blended
 * with a recency prior: surprising or fresh blocks score high, predictable and stale
 * blocks score low and are evicted first. No external model, no LLM calls.
 */
export class JEPASalienceArbiter {
  readonly latentDim: number;
  private readonly emaMomentum: number;
  private readonly recencyHalfLifeS: number;
  private readonly surpriseWeight: number;
  private readonly recencyWeight: number;
  private readonly targetEma = new Map<BankType, Float64Array>();
  private readonly observationCounts = new Map<BankType, number>();

  constructor(opts: ArbiterOptions = {}) {
    this.latentDim = opts.latentDim ?? 128;
    this.emaMomentum = opts.emaMomentum ?? 0.9;
    this.recencyHalfLifeS = opts.recencyHalfLifeS ?? 600;
    this.surpriseWeight = opts.surpriseWeight ?? 0.7;
    this.recencyWeight = opts.recencyWeight ?? 0.3;
  }

  /** Deterministic feature-hashing encoder: text -> unit latent vector. */
  encode(text: string): Float64Array {
    const vec = new Float64Array(this.latentDim);
    for (const token of text.toLowerCase().split(/\s+/)) {
      if (!token) continue;
      const digest = createHash('sha256').update(token).digest();
      const h = digest.readBigUInt64LE(0);
      const idx = Number(h % BigInt(this.latentDim));
      vec[idx] = (vec[idx] ?? 0) + (h >> 63n === 0n ? 1 : -1);
    }
    const norm = Math.hypot(...vec);
    if (norm > 0) for (const [i, v] of vec.entries()) vec[i] = v / norm;
    return vec;
  }

  /** Predict the next latent for a bank from its running target EMA. */
  predictNext(bankType: BankType): Float64Array {
    return this.targetEma.get(bankType) ?? new Float64Array(this.latentDim);
  }

  /** JEPA loss: bounded cosine-style distance between predicted and observed latents. */
  predictionError(bankType: BankType, latent: Float64Array): number {
    const predicted = this.predictNext(bankType);
    let dot = 0;
    let normP = 0;
    let normL = 0;
    for (const [i, p] of predicted.entries()) {
      const l = latent[i] ?? 0;
      dot += p * l;
      normP += p * p;
      normL += l * l;
    }
    if (normP === 0 || normL === 0) return 1;
    const cosine = dot / (Math.sqrt(normP) * Math.sqrt(normL));
    return Math.min(1, Math.max(0, (1 - cosine) / 2));
  }

  /** Blend latent surprise with a recency prior into a salience score in [0, 1]. */
  score(bankType: BankType, latent: Float64Array, timestamp: number, nowS?: number): number {
    const surprise = this.predictionError(bankType, latent);
    const now = nowS ?? Date.now() / 1000;
    const age = Math.max(0, now - timestamp);
    const recency = Math.exp((-Math.LN2 * age) / this.recencyHalfLifeS);
    return this.surpriseWeight * surprise + this.recencyWeight * recency;
  }

  /** Fold an observed latent into the bank's target representation. */
  observe(bankType: BankType, latent: Float64Array): void {
    const ema = this.targetEma.get(bankType);
    if (!ema) {
      this.targetEma.set(bankType, Float64Array.from(latent));
      this.observationCounts.set(bankType, 1);
      return;
    }
    const m = this.emaMomentum;
    for (const [i, e] of ema.entries()) ema[i] = m * e + (1 - m) * (latent[i] ?? 0);
    this.observationCounts.set(bankType, (this.observationCounts.get(bankType) ?? 0) + 1);
  }

  observationCount(bankType: BankType): number {
    return this.observationCounts.get(bankType) ?? 0;
  }

  stats(): { latentDim: number; banksTracked: BankType[]; observations: Record<string, number> } {
    return {
      latentDim: this.latentDim,
      banksTracked: [...this.targetEma.keys()],
      observations: Object.fromEntries(this.observationCounts),
    };
  }
}

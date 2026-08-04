/**
 * Parameter model for Loop Collage. Pure data + sanitization, no host imports,
 * so it can be unit-tested offline.
 */

export type SliceLength = "1/4" | "1/8" | "1/16" | "random";
export type CrossfadeSetting = "off" | "short" | "medium" | "long";
export type BitcrushAmount = "light" | "medium" | "hard" | "random";
export type LoopBars = 1 | 2 | 4 | 8;

export interface CollageParams {
  sliceLength: SliceLength;
  loopBars: LoopBars;
  crossfade: CrossfadeSetting;
  /** 0..1 probability that a slice plays reversed (stacks with any glitch FX). */
  reverseChance: number;
  /** 0..1 probability that a slice gets bitcrushed. */
  bitcrushChance: number;
  bitcrushAmount: BitcrushAmount;
  /** 0..1 probability of a retrigger/stutter (repeat the slice's first chunk). */
  retriggerChance: number;
  /** 0..1 probability of a tape stop (slice decelerates to standstill). */
  tapestopChance: number;
  /** 0..1 probability of a rhythmic gate within the slice. */
  gaterChance: number;
  /** 0..1 probability of a repitch (octave up or down, varispeed). */
  repitchChance: number;
  /** 1..8 loop variations generated per run. */
  variations: number;
  /** uint32 RNG seed; same seed + settings -> same loops. */
  seed: number;
}

export const DEFAULT_PARAMS: CollageParams = {
  sliceLength: "1/16",
  loopBars: 1,
  crossfade: "off",
  reverseChance: 0.25,
  bitcrushChance: 0.3,
  bitcrushAmount: "medium",
  retriggerChance: 0.1,
  tapestopChance: 0.1,
  gaterChance: 0.1,
  repitchChance: 0.1,
  variations: 4,
  seed: 252644670,
};

const SLICE_LENGTHS: readonly SliceLength[] = ["1/4", "1/8", "1/16", "random"];
const CROSSFADES: readonly CrossfadeSetting[] = ["off", "short", "medium", "long"];
const CRUSH_AMOUNTS: readonly BitcrushAmount[] = ["light", "medium", "hard", "random"];
const LOOP_BARS: readonly LoopBars[] = [1, 2, 4, 8];

function clamp01(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

/** Coerce untrusted input (dialog JSON, stored settings) into valid params. */
export function sanitizeParams(raw: unknown): CollageParams {
  const r = (raw ?? {}) as Record<string, unknown>;
  const d = DEFAULT_PARAMS;

  const loopBars = LOOP_BARS.includes(r.loopBars as LoopBars)
    ? (r.loopBars as LoopBars)
    : d.loopBars;

  const variationsNum = Math.round(Number(r.variations));
  const variations = Number.isFinite(variationsNum)
    ? Math.min(8, Math.max(1, variationsNum))
    : d.variations;

  const seedNum = Math.floor(Number(r.seed));
  const seed = Number.isFinite(seedNum) && seedNum >= 0 ? seedNum >>> 0 : d.seed;

  return {
    sliceLength: SLICE_LENGTHS.includes(r.sliceLength as SliceLength)
      ? (r.sliceLength as SliceLength)
      : d.sliceLength,
    loopBars,
    crossfade: CROSSFADES.includes(r.crossfade as CrossfadeSetting)
      ? (r.crossfade as CrossfadeSetting)
      : d.crossfade,
    reverseChance: clamp01(r.reverseChance, d.reverseChance),
    bitcrushChance: clamp01(r.bitcrushChance, d.bitcrushChance),
    retriggerChance: clamp01(r.retriggerChance, d.retriggerChance),
    tapestopChance: clamp01(r.tapestopChance, d.tapestopChance),
    gaterChance: clamp01(r.gaterChance, d.gaterChance),
    repitchChance: clamp01(r.repitchChance, d.repitchChance),
    bitcrushAmount: CRUSH_AMOUNTS.includes(r.bitcrushAmount as BitcrushAmount)
      ? (r.bitcrushAmount as BitcrushAmount)
      : d.bitcrushAmount,
    variations,
    seed,
  };
}

/**
 * Loop Collage DSP — pure functions, no host imports.
 *
 * Grid-locked collage: the source selection is divided into N equal,
 * grid-aligned slices (N = 4, 8 or 16 — "slice length" is 1/4, 1/8 or 1/16 of
 * the sample being sliced). The output loop is walked slot-by-slot on that
 * same grid, and every slot is filled with a randomly chosen WHOLE slice of a
 * source — never a random sample offset — so the chops keep the source's
 * rhythmic feel. Per slot the RNG decides reverse and bitcrush; adjacent slots
 * are joined with equal-power crossfades that wrap around the loop end, so the
 * result loops seamlessly. Everything is driven by one seeded RNG: same
 * sources + params + variation index -> bit-identical output.
 */

import type { BitcrushAmount, CollageParams } from "./params.js";

export interface AudioBuffers {
  channels: Float32Array[];
  sampleRate: number;
}

export const OUTPUT_SAMPLE_RATE = 48000;
const OUTPUT_CHANNELS = 2;
/** Peak-normalization target: -1 dBFS. */
const NORM_TARGET = Math.pow(10, -1 / 20);
/** Minimal declick fade (frames) when crossfade is "off". */
const DECLICK_FRAMES = 16;

/** How many slices the source sample is divided into, per slice-length setting. */
const SLICE_DIVISIONS: Record<"1/4" | "1/8" | "1/16", number> = {
  "1/4": 4,
  "1/8": 8,
  "1/16": 16,
};
const RANDOM_DIVISION_POOL = [4, 8, 16] as const;

const CROSSFADE_MS: Record<"off" | "short" | "medium" | "long", number> = {
  off: 0,
  short: 5,
  medium: 15,
  long: 40,
};

/** Bit depth + sample-and-hold factor per crush amount. */
const CRUSH_CONFIGS: Record<"light" | "medium" | "hard", { bits: number; hold: number }> = {
  light: { bits: 12, hold: 2 },
  medium: { bits: 8, hold: 4 },
  hard: { bits: 5, hold: 8 },
};

/** Deterministic uint32 -> float [0,1) RNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function resolveCrush(
  amount: BitcrushAmount,
  rng: () => number,
): { bits: number; hold: number } {
  if (amount === "random") {
    const keys = ["light", "medium", "hard"] as const;
    return CRUSH_CONFIGS[keys[Math.floor(rng() * keys.length)]!];
  }
  return CRUSH_CONFIGS[amount];
}

export interface CollageOptions extends CollageParams {
  /** Live's current tempo in BPM. */
  tempo: number;
  /** Length of the source selection in beats (all sources span the same range). */
  sourceBeats: number;
  /** Which variation to generate (offsets the seed deterministically). */
  variationIndex: number;
}

/**
 * Assemble one collage-loop variation from the given sources.
 * Output is stereo at 48 kHz, exactly `loopBars` bars long at `tempo`,
 * peak-normalized to -1 dBFS.
 */
export function buildCollageLoop(
  sources: AudioBuffers[],
  opts: CollageOptions,
): AudioBuffers {
  const usable = sources.filter((s) => s.channels.length > 0 && s.channels[0]!.length > 1);
  if (!usable.length) throw new Error("no source audio");
  if (!(opts.sourceBeats > 0)) throw new Error("sourceBeats must be positive");

  const rng = mulberry32((opts.seed + opts.variationIndex * 0x9e3779b9) >>> 0);
  const secPerBeat = 60 / opts.tempo;
  const loopBeats = opts.loopBars * 4;
  const totalFrames = Math.round(loopBeats * secPerBeat * OUTPUT_SAMPLE_RATE);
  const out = Array.from({ length: OUTPUT_CHANNELS }, () => new Float32Array(totalFrames));

  const xfMs = CROSSFADE_MS[opts.crossfade];
  const requestedXf = Math.round((xfMs / 1000) * OUTPUT_SAMPLE_RATE);

  let posBeats = 0;
  while (posBeats < loopBeats - 1e-9) {
    // Slice length = an exact fraction of the source sample, so chops stay on
    // the source's own grid. All options are multiples of sourceBeats/16, so
    // output positions stay grid-locked too.
    const divisions =
      opts.sliceLength === "random"
        ? RANDOM_DIVISION_POOL[Math.floor(rng() * RANDOM_DIVISION_POOL.length)]!
        : SLICE_DIVISIONS[opts.sliceLength];
    const sliceBeats = Math.min(opts.sourceBeats / divisions, loopBeats - posBeats);

    const startFrame = Math.round(posBeats * secPerBeat * OUTPUT_SAMPLE_RATE);
    const endFrame = Math.round((posBeats + sliceBeats) * secPerBeat * OUTPUT_SAMPLE_RATE);
    const nFrames = endFrame - startFrame;
    if (nFrames <= 0) break;
    // Crossfade tail extends past the slot; cap so fades never overlap themselves.
    const xf = Math.max(Math.min(requestedXf, Math.floor(nFrames / 2)), 0);
    const fadeLen = xf > 0 ? xf : Math.min(DECLICK_FRAMES, Math.floor(nFrames / 2));
    const extFrames = nFrames + xf; // slot + fade-out tail (overlaps next slot's fade-in)

    // Pick a random source and a random WHOLE slice index on its grid.
    const src = usable[Math.floor(rng() * usable.length)]!;
    const ratio = src.sampleRate / OUTPUT_SAMPLE_RATE;
    const srcLen = src.channels[0]!.length;
    const srcSliceFrames = (opts.sourceBeats / divisions) * secPerBeat * src.sampleRate;
    const availSlices = Math.max(1, Math.min(divisions, Math.floor(srcLen / srcSliceFrames)));
    const sliceIndex = Math.floor(rng() * availSlices);
    const srcStart = Math.round(sliceIndex * srcSliceFrames);

    // Glitch FX selection — Glitch2-style: at most ONE effect per slice (the
    // chances compete; if several hit, one of the hits is picked at random).
    // Reverse is the exception: it stacks on top of anything. All chances use
    // a quadratic curve: with many slots per loop even 10% linear would hit
    // almost every loop, squaring keeps the low end genuinely rare
    // (10% -> 1%, 50% -> 25%) while 100% still always fires.
    const sq = (p: number) => p * p;
    const candidates: ("retrigger" | "tapestop" | "gater" | "repitch" | "bitcrush")[] = [];
    if (rng() < sq(opts.retriggerChance)) candidates.push("retrigger");
    if (rng() < sq(opts.tapestopChance)) candidates.push("tapestop");
    if (rng() < sq(opts.gaterChance)) candidates.push("gater");
    if (rng() < sq(opts.repitchChance)) candidates.push("repitch");
    if (rng() < opts.bitcrushChance) candidates.push("bitcrush");
    const fx = candidates.length
      ? candidates[Math.floor(rng() * candidates.length)]!
      : null;
    const reversed = rng() < sq(opts.reverseChance);

    // Per-effect parameters, rolled deterministically from the same RNG.
    const crush = fx === "bitcrush" ? resolveCrush(opts.bitcrushAmount, rng) : null;
    const levels = crush ? Math.pow(2, crush.bits - 1) : 0;
    // Retrigger: repeat the first 1/2, 1/4 or 1/8 of the slice.
    const retrigChunk =
      fx === "retrigger"
        ? Math.max(1, Math.round(nFrames / [2, 4, 8][Math.floor(rng() * 3)]!))
        : 0;
    // Gater: 4 or 8 gates per slice, 50% duty, with short declick ramps.
    const gatePeriod =
      fx === "gater" ? Math.max(2, Math.floor(nFrames / (rng() < 0.5 ? 4 : 8))) : 0;
    const gateEdge = gatePeriod ? Math.min(64, gatePeriod * 0.1) : 0;
    // Repitch: octave down (half speed) or up (double speed, plays twice).
    const repitchRate = fx === "repitch" ? (rng() < 0.5 ? 0.5 : 2) : 1;
    const invExt = 1 / extFrames;

    for (let c = 0; c < OUTPUT_CHANNELS; c++) {
      const srcCh = src.channels[Math.min(c, src.channels.length - 1)]!;
      const outCh = out[c]!;

      for (let k = 0; k < extFrames; k++) {
        // Sample-and-hold for the rate-crush half of the bitcrusher.
        const kRead = crush ? Math.floor(k / crush.hold) * crush.hold : k;

        // Map the output frame to a slice-local read position per effect.
        let u: number;
        if (fx === "retrigger") {
          u = kRead % retrigChunk;
        } else if (fx === "tapestop") {
          // Playback rate falls linearly 1 -> 0 over the slice; the read
          // position is its integral, freezing at the end (pitch drops away).
          u = kRead - kRead * kRead * 0.5 * invExt;
        } else if (fx === "repitch") {
          u = (kRead * repitchRate) % nFrames;
        } else {
          u = kRead;
        }
        // Reverse flips within the slot (reads past either end are clamped).
        const kDir = reversed ? nFrames - 1 - u : u;
        const srcPos = srcStart + kDir * ratio;
        const i0 = Math.max(0, Math.min(Math.floor(srcPos), srcLen - 2));
        const frac = Math.max(0, Math.min(srcPos - i0, 1));
        let v = srcCh[i0]! * (1 - frac) + srcCh[i0 + 1]! * frac;

        if (crush) v = Math.round(v * levels) / levels;

        // Equal-power fade-in over [0, fadeLen) and fade-out over the last fadeLen
        // of the extended region. With xf > 0 the fades of adjacent slots
        // overlap-add to unity power.
        let gain = 1;
        if (k < fadeLen) gain *= Math.sin(((k + 1) / fadeLen) * (Math.PI / 2));
        const fromEnd = extFrames - k;
        if (fromEnd <= fadeLen) gain *= Math.sin((fromEnd / fadeLen) * (Math.PI / 2));

        // Gater: 50%-duty square with short ramps at the segment edges.
        if (gatePeriod) {
          const ph = (k % gatePeriod) / gatePeriod;
          if (ph < 0.5) {
            const dEdge = Math.min(ph, 0.5 - ph) * gatePeriod;
            gain *= Math.min(1, dEdge / gateEdge);
          } else {
            gain = 0;
          }
        }

        const idx = (startFrame + k) % totalFrames;
        outCh[idx] = outCh[idx]! + v * gain;
      }
    }

    posBeats += sliceBeats;
  }

  // Peak-normalize to -1 dBFS.
  let peak = 0;
  for (const ch of out) {
    for (let i = 0; i < ch.length; i++) {
      const a = Math.abs(ch[i]!);
      if (a > peak) peak = a;
    }
  }
  if (peak > 0) {
    const g = NORM_TARGET / peak;
    for (const ch of out) {
      for (let i = 0; i < ch.length; i++) ch[i]! *= g;
    }
  }

  return { channels: out, sampleRate: OUTPUT_SAMPLE_RATE };
}

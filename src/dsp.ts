/**
 * Loooprr DSP — pure functions, no host imports.
 *
 * Grid-locked collage: the source selection is divided into N equal,
 * grid-aligned slices (N = 4, 8 or 16). The output loop is walked
 * slot-by-slot on that grid; every slot gets a randomly chosen WHOLE source
 * slice, so chops keep the source's rhythmic feel.
 *
 * Slice FX (at most ONE per slot — the chances compete; reverse stacks on
 * top): retrigger, stutter sweep, tape stop, scratch/spinback, gater,
 * repitch, bitcrush, filter sweep, tonal delay, dropout.
 * Groove & space (applied on top): auto-pan, end fill.
 *
 * Everything is driven by one seeded mulberry32 RNG: same sources + params +
 * variation index -> bit-identical output.
 */

import { DENSITY_VALUES, type ChanceFx, type CollageParams } from "./params.js";

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

export interface CollageOptions extends CollageParams {
  /** Live's current tempo in BPM. */
  tempo: number;
  /** Length of the source selection in beats (all sources span the same range). */
  sourceBeats: number;
  /** Which variation to generate (offsets the seed deterministically). */
  variationIndex: number;
}

export type SliceFx =
  | "reverse" | "retrigger" | "sweep" | "tapestop" | "scratch" | "gater"
  | "repitch" | "bitcrush" | "filter" | "tonaldelay" | "dropout";

/** What happened in one output slot — for per-chop clip placement/coloring. */
export interface SlotInfo {
  /** Slot region in output frames (nominal, without the crossfade tail). */
  startFrame: number;
  endFrame: number;
  fx: SliceFx | "endfill" | null;
}

export interface CollageResult extends AudioBuffers {
  slots: SlotInfo[];
}


/**
 * Assemble one collage-loop variation from the given sources.
 * Output is stereo at 48 kHz, exactly `loopBars` bars long at `tempo`,
 * peak-normalized to -1 dBFS.
 */
export function buildCollageLoop(
  sources: AudioBuffers[],
  opts: CollageOptions,
): CollageResult {
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

  const slots: SlotInfo[] = [];
  let posBeats = 0;
  let slotIdx = 0;
  while (posBeats < loopBeats - 1e-9) {
    const divisions =
      opts.sliceLength === "random"
        ? RANDOM_DIVISION_POOL[Math.floor(rng() * RANDOM_DIVISION_POOL.length)]!
        : SLICE_DIVISIONS[opts.sliceLength];
    const sliceBeats = Math.min(opts.sourceBeats / divisions, loopBeats - posBeats);

    const baseStart = Math.round(posBeats * secPerBeat * OUTPUT_SAMPLE_RATE);
    const endFrame = Math.round((posBeats + sliceBeats) * secPerBeat * OUTPUT_SAMPLE_RATE);
    const startFrame = baseStart;
    const nFrames = endFrame - startFrame;
    if (nFrames <= 1) { posBeats += sliceBeats; slotIdx++; continue; }
    const xf = Math.max(Math.min(requestedXf, Math.floor(nFrames / 2)), 0);
    const fadeLen = xf > 0 ? xf : Math.min(DECLICK_FRAMES, Math.floor(nFrames / 2));
    const extFrames = nFrames + xf;

    // Random source fragment: a WHOLE slice on the source's own grid.
    const src = usable[Math.floor(rng() * usable.length)]!;
    const ratio = src.sampleRate / OUTPUT_SAMPLE_RATE;
    const srcLen = src.channels[0]!.length;
    const srcSliceFrames = (opts.sourceBeats / divisions) * secPerBeat * src.sampleRate;
    const availSlices = Math.max(1, Math.min(divisions, Math.floor(srcLen / srcSliceFrames)));
    const srcStart = Math.round(Math.floor(rng() * availSlices) * srcSliceFrames);

    // FX budget: ONE roll against the density decides whether this chop gets
    // an effect at all; the enabled effects' weights then divide the budget.
    // The total effected fraction can therefore never exceed the density.
    const enabled: { fx: SliceFx; w: number }[] = [];
    const add = (key: SliceFx, f: ChanceFx) => {
      if (f.on && f.weight > 0) enabled.push({ fx: key, w: f.weight });
    };
    add("reverse", opts.reverse);
    add("retrigger", opts.retrigger);
    add("sweep", opts.sweep);
    add("tapestop", opts.tapestop);
    add("scratch", opts.scratch);
    add("gater", opts.gater);
    add("repitch", opts.repitch);
    add("bitcrush", opts.bitcrush);
    add("filter", opts.filter);
    add("tonaldelay", opts.tonaldelay);
    add("dropout", opts.dropout);
    let fx: SliceFx | null = null;
    if (opts.fxOn && enabled.length && rng() < DENSITY_VALUES[opts.density]) {
      const total = enabled.reduce((s, e) => s + e.w, 0);
      let r = rng() * total;
      for (const e of enabled) {
        r -= e.w;
        if (r <= 0) { fx = e.fx; break; }
      }
      if (!fx) fx = enabled[enabled.length - 1]!.fx;
    }

    slots.push({ startFrame, endFrame, fx });
    // Dropout: how the hole is shaped. FULL skips the slot entirely; HALF and
    // FADE still render (partially/decaying), handled in the gain stage.
    let dropoutMode = "";
    if (fx === "dropout") {
      dropoutMode = opts.dropout.mode === "random"
        ? (["full", "half", "fade"] as const)[Math.floor(rng() * 3)]!
        : opts.dropout.mode;
      if (dropoutMode === "full") {
        // The previous slice's crossfade tail decays into the hole.
        posBeats += sliceBeats; slotIdx++; continue;
      }
    }

    // ---- Per-effect parameters, rolled deterministically. ----
    let crush: { bits: number; hold: number } | null = null;
    let levels = 0;
    if (fx === "bitcrush") {
      const amount = opts.bitcrush.amount === "random"
        ? (["light", "medium", "hard"] as const)[Math.floor(rng() * 3)]!
        : opts.bitcrush.amount;
      crush = CRUSH_CONFIGS[amount];
      levels = Math.pow(2, crush.bits - 1);
    }
    let retrigChunk = 0;
    if (fx === "retrigger") {
      const chunk = opts.retrigger.chunk === "random"
        ? (["half", "quarter", "eighth"] as const)[Math.floor(rng() * 3)]!
        : opts.retrigger.chunk;
      const div = chunk === "half" ? 2 : chunk === "quarter" ? 4 : 8;
      retrigChunk = Math.max(1, Math.round(nFrames / div));
    }
    // Reverse: full flip, only the 2nd half mirrored, or there-and-back.
    let reverseMode = "";
    if (fx === "reverse") {
      reverseMode = opts.reverse.mode === "random"
        ? (["full", "half", "pingpong"] as const)[Math.floor(rng() * 3)]!
        : opts.reverse.mode;
    }
    // Stutter sweep: repeats on BINARY grid divisions of the slot (halves ->
    // quarters -> eighths, like a fill), so the stutter stays on the grid;
    // pitch glides up or down across the repeats.
    let sweepBounds: number[] = [];
    let sweepRates: number[] = [];
    if (fx === "sweep") {
      const dir = opts.sweep.dir === "random" ? (rng() < 0.5 ? "up" : "down") : opts.sweep.dir;
      const fracs = [0.25, 0.25, 0.125, 0.125, 0.0625, 0.0625, 0.0625, 0.0625];
      let acc = 0;
      for (let i = 0; i < fracs.length; i++) {
        sweepBounds.push(Math.round(acc * nFrames));
        acc += fracs[i]!;
        const t = i / (fracs.length - 1);
        sweepRates.push(dir === "up" ? Math.pow(2, t) : Math.pow(2, -0.85 * t));
      }
      sweepBounds.push(extFrames); // the crossfade tail rides the last repeat
    }
    let gatePeriod = 0, gateEdge = 0;
    if (fx === "gater") {
      // 3 and 6 give triplet feels; 2 keeps it slow enough for high tempos.
      const gates = opts.gater.gates ||
        ([2, 3, 4, 6, 8] as const)[Math.floor(rng() * 5)]!;
      gatePeriod = Math.max(2, Math.floor(nFrames / gates));
      gateEdge = Math.min(64, gatePeriod * 0.1);
    }
    let repitchRate = 1;
    if (fx === "repitch") {
      repitchRate = opts.repitch.dir === "up" ? 2
        : opts.repitch.dir === "down" ? 0.5
        : rng() < 0.5 ? 0.5 : 2;
    }
    let scrubCycles = 0, spinK0 = 0;
    if (fx === "scratch") {
      const mode = opts.scratch.mode === "random"
        ? (rng() < 0.5 ? "scrub" : "spinback")
        : opts.scratch.mode;
      if (mode === "scrub") scrubCycles = 2 + Math.floor(rng() * 2);
      else spinK0 = Math.floor(extFrames * 0.45);
    }
    let filterLp = true, filterF0 = 0, filterF1 = 0;
    if (fx === "filter") {
      filterLp = opts.filter.type === "random" ? rng() < 0.5 : opts.filter.type === "lp";
      // Depth widens the cutoff playground: gentle mid-range sweeps at 0,
      // dramatic 120 Hz .. 9 kHz dives at 1.
      const depth = opts.filter.depth;
      const minHz = 800 - 680 * depth; // 800 -> 120
      const maxHz = 3000 + 6000 * depth; // 3000 -> 9000
      filterF0 = minHz * Math.pow(maxHz / minHz, rng());
      filterF1 = minHz * Math.pow(maxHz / minHz, rng());
    }
    // Tonal delay: a pitched comb tuned to a note between ~110 and ~440 Hz.
    // "Motion" glides the delay length across the slice, bending the tone:
    // rise = octave up, fall = octave down, wobble = an LFO around the note.
    let combD0 = 0;
    let combMotion = "static";
    let combWobbleHz = 0;
    const COMB_FB = 0.72;
    if (fx === "tonaldelay") {
      const f = 110 * Math.pow(2, Math.floor(rng() * 25) / 12);
      combD0 = Math.max(8, Math.round(OUTPUT_SAMPLE_RATE / f));
      combMotion = opts.tonaldelay.motion === "random"
        ? (["static", "rise", "fall", "wobble"] as const)[Math.floor(rng() * 4)]!
        : opts.tonaldelay.motion;
      if (combMotion === "wobble") combWobbleHz = 2 + rng() * 4; // 2..6 Hz vibrato
    }
    // Tape stop: where in the slice the tape reaches standstill.
    let tapestopT = extFrames;
    if (fx === "tapestop") {
      const speed = opts.tapestop.speed === "random"
        ? (["fast", "medium", "slow"] as const)[Math.floor(rng() * 3)]!
        : opts.tapestop.speed;
      const frac = speed === "fast" ? 0.4 : speed === "medium" ? 0.7 : 1;
      tapestopT = Math.max(1, Math.floor(extFrames * frac));
    }
    // Auto-pan: alternate slots left/right by the pan amount (equal-power).
    let gainL = 1, gainR = 1;
    if (opts.autopan.on && opts.autopan.amount > 0) {
      const pan = (slotIdx % 2 === 0 ? -1 : 1) * opts.autopan.amount; // -1..1
      const t = (pan + 1) / 2;
      gainL = Math.cos((t * Math.PI) / 2) * 1.32;
      gainR = Math.sin((t * Math.PI) / 2) * 1.32;
    }
    const invExt = 1 / extFrames;

    for (let c = 0; c < OUTPUT_CHANNELS; c++) {
      const srcCh = src.channels[Math.min(c, src.channels.length - 1)]!;
      const outCh = out[c]!;
      const panGain = c === 0 ? gainL : gainR;
      let lpState = 0; // one-pole filter state (per channel, per slice)
      const comb = combD0 ? new Float32Array(extFrames) : null;

      for (let k = 0; k < extFrames; k++) {
        // Sample-and-hold for the rate-crush half of the bitcrusher.
        const kRead = crush ? Math.floor(k / crush.hold) * crush.hold : k;

        // Map the output frame to a slice-local read position per effect.
        let u: number;
        if (fx === "retrigger") {
          u = kRead % retrigChunk;
        } else if (fx === "sweep") {
          // Find the repeat this frame belongs to (few repeats; linear scan).
          let j = 0;
          while (j < sweepRates.length - 1 && kRead >= sweepBounds[j + 1]!) j++;
          u = (kRead - sweepBounds[j]!) * sweepRates[j]!;
        } else if (fx === "tapestop") {
          // Rate falls linearly 1 -> 0 by frame tapestopT; the read position
          // is its integral, frozen (and silenced) once the tape stands still.
          const kk = Math.min(kRead, tapestopT);
          u = kk - (kk * kk * 0.5) / tapestopT;
        } else if (fx === "scratch") {
          if (scrubCycles) {
            // Triangle scrub: forward/backward sweeps across the slice.
            const ph = (kRead * scrubCycles) / extFrames;
            u = 2 * Math.abs(ph - Math.floor(ph + 0.5)) * (nFrames - 1);
          } else {
            // Spinback: play normally, then rewind with accelerating speed.
            u = kRead < spinK0
              ? kRead
              : spinK0 - (kRead - spinK0) * (1 + (2.5 * (kRead - spinK0)) / (extFrames - spinK0));
          }
        } else if (fx === "repitch") {
          u = (kRead * repitchRate) % nFrames;
        } else {
          u = kRead;
        }
        // Reverse (reads past either end are clamped):
        // full = whole slot backwards; half = only the 2nd half mirrored;
        // pingpong = forward to the midpoint, then rewind to the start.
        if (fx === "reverse") {
          const h = nFrames >> 1;
          if (reverseMode === "half") {
            u = u < h ? u : nFrames - 1 - (u - h);
          } else if (reverseMode === "pingpong") {
            u = u < h ? u : Math.max(0, 2 * h - u);
          } else {
            u = nFrames - 1 - u;
          }
        }

        const srcPos = srcStart + u * ratio;
        const i0 = Math.max(0, Math.min(Math.floor(srcPos), srcLen - 2));
        const frac = Math.max(0, Math.min(srcPos - i0, 1));
        let v = srcCh[i0]! * (1 - frac) + srcCh[i0 + 1]! * frac;

        if (crush) v = Math.round(v * levels) / levels;

        if (fx === "filter") {
          // One-pole with the cutoff gliding f0 -> f1 across the slice.
          const fc = filterF0 * Math.pow(filterF1 / filterF0, k * invExt);
          const a = 1 - Math.exp((-2 * Math.PI * fc) / OUTPUT_SAMPLE_RATE);
          lpState += a * (v - lpState);
          v = filterLp ? lpState : v - lpState;
        }
        if (comb) {
          // Variable delay length = pitch motion (fractional read, interpolated).
          let D = combD0;
          if (combMotion === "rise") D = combD0 * Math.pow(2, -k * invExt);
          else if (combMotion === "fall") D = combD0 * Math.pow(2, k * invExt);
          else if (combMotion === "wobble") {
            D = combD0 * Math.pow(2,
              0.25 * Math.sin((2 * Math.PI * combWobbleHz * k) / OUTPUT_SAMPLE_RATE));
          }
          const idx = k - D;
          let fbIn = 0;
          if (idx >= 0) {
            const i1 = Math.floor(idx);
            const fr = idx - i1;
            const a = comb[i1]!;
            const b = i1 + 1 < k ? comb[i1 + 1]! : a;
            fbIn = a * (1 - fr) + b * fr;
          }
          const y = v + COMB_FB * fbIn;
          comb[k] = y;
          v = 0.35 * v + 0.65 * y;
        }

        // Equal-power fade-in/out over the extended region (overlap-add with
        // the neighbouring slots when crossfading).
        let gain = panGain;
        if (fx === "tapestop" && kRead >= tapestopT) gain = 0; // tape stands still
        if (fx === "dropout") {
          if (dropoutMode === "half") {
            // Second half cut away, with a short declick ramp at the cut.
            const h = nFrames >> 1;
            if (k >= h) gain = 0;
            else if (h - k < 32) gain *= (h - k) / 32;
          } else {
            // fade: dies out over the slot.
            gain *= Math.pow(Math.max(0, 1 - k / nFrames), 1.5);
          }
        }
        if (k < fadeLen) gain *= Math.sin(((k + 1) / fadeLen) * (Math.PI / 2));
        const fromEnd = extFrames - k;
        if (fromEnd <= fadeLen) gain *= Math.sin((fromEnd / fadeLen) * (Math.PI / 2));
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
    slotIdx++;
  }

  // ---- End fill: replace the loop's final beat with an accelerating roll. ----
  if (opts.endfill.on && rng() < opts.endfill.chance) {
    const fillBeats = Math.min(1, loopBeats / 4);
    const fillFrames = Math.round(fillBeats * secPerBeat * OUTPUT_SAMPLE_RATE);
    const fillStart = totalFrames - fillFrames;
    applyEndFill(out, usable, rng, opts, secPerBeat, fillStart, fillFrames, totalFrames);
    // The fill replaces whatever slots it overlaps.
    for (let i = slots.length - 1; i >= 0; i--) {
      const s = slots[i]!;
      if (s.startFrame >= fillStart) slots.splice(i, 1);
      else if (s.endFrame > fillStart) s.endFrame = fillStart;
    }
    slots.push({ startFrame: fillStart, endFrame: totalFrames, fx: "endfill" });
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

  return { channels: out, sampleRate: OUTPUT_SAMPLE_RATE, slots };
}

/** Snare-roll style fill: subdivisions double toward the loop end. */
function applyEndFill(
  out: Float32Array[],
  usable: AudioBuffers[],
  rng: () => number,
  opts: CollageOptions,
  secPerBeat: number,
  fillStart: number,
  fillFrames: number,
  totalFrames: number,
): void {
  // One grid slice (a 1/16 of the source) is the roll's ammunition.
  const src = usable[Math.floor(rng() * usable.length)]!;
  const ratio = src.sampleRate / OUTPUT_SAMPLE_RATE;
  const srcLen = src.channels[0]!.length;
  const srcSliceFrames = (opts.sourceBeats / 16) * secPerBeat * src.sampleRate;
  const avail = Math.max(1, Math.min(16, Math.floor(srcLen / srcSliceFrames)));
  const srcStart = Math.round(Math.floor(rng() * avail) * srcSliceFrames);
  const risePitch = rng() < 0.5; // half the fills also climb in pitch

  // Chunk pattern: halves shrink toward the end (1/4 1/4 1/8 1/8 1/16 x4).
  const fracs = [0.25, 0.25, 0.125, 0.125, 0.0625, 0.0625, 0.0625, 0.0625];
  const fade = 24;

  for (let c = 0; c < out.length; c++) {
    const srcCh = src.channels[Math.min(c, src.channels.length - 1)]!;
    const outCh = out[c]!;
    for (let i = fillStart; i < totalFrames; i++) outCh[i] = 0;

    let chunkStart = 0;
    fracs.forEach((frac, fi) => {
      const chunkFrames = Math.round(frac * fillFrames);
      const rate = risePitch ? 1 + 0.4 * (fi / (fracs.length - 1)) : 1;
      const gain = 0.7 + 0.3 * (fi / (fracs.length - 1));
      for (let k = 0; k < chunkFrames; k++) {
        const srcPos = srcStart + k * rate * ratio;
        const i0 = Math.max(0, Math.min(Math.floor(srcPos), srcLen - 2));
        const frac2 = Math.max(0, Math.min(srcPos - i0, 1));
        let v = srcCh[i0]! * (1 - frac2) + srcCh[i0 + 1]! * frac2;
        let g = gain;
        if (k < fade) g *= k / fade;
        if (chunkFrames - k < fade) g *= (chunkFrames - k) / fade;
        const idx = fillStart + chunkStart + k;
        if (idx < totalFrames) outCh[idx] = v * g;
      }
      chunkStart += chunkFrames;
    });
  }
}

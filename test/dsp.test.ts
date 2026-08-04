import { test } from "node:test";
import assert from "node:assert/strict";

import { buildCollageLoop, OUTPUT_SAMPLE_RATE, type AudioBuffers } from "../src/dsp.js";
import { encodeWav24 } from "../src/wav.js";
import { DEFAULT_PARAMS, sanitizeFavorites, sanitizeParams } from "../src/params.js";

/** Deterministic pseudo-noise source, long enough for any slice. */
function noiseSource(seconds = 4, sampleRate = 48000, channels = 2): AudioBuffers {
  const n = seconds * sampleRate;
  const chans = Array.from({ length: channels }, (_, c) => {
    const buf = new Float32Array(n);
    let x = 123456789 + c;
    for (let i = 0; i < n; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      buf[i] = (x / 0x7fffffff) * 2 - 1;
    }
    return buf;
  });
  return { channels: chans, sampleRate };
}

/** Every effect off — a pure grid shuffle. */
function allFxOff() {
  return {
    reverse: { on: false, chance: 0 },
    retrigger: { on: false, chance: 0 },
    sweep: { on: false, chance: 0, dir: "random" as const },
    tapestop: { on: false, chance: 0, speed: "random" as const },
    scratch: { on: false, chance: 0, mode: "random" as const },
    gater: { on: false, chance: 0, gates: 0 as const },
    repitch: { on: false, chance: 0, dir: "both" as const },
    bitcrush: { on: false, chance: 0, amount: "medium" as const },
    filter: { on: false, chance: 0, type: "random" as const },
    tonaldelay: { on: false, chance: 0, motion: "random" as const },
    dropout: { on: false, chance: 0 },
    autopan: { on: false, amount: 0 },
    swing: { on: false, amount: 0 },
    endfill: { on: false, chance: 0 },
    colorclips: { on: false },
  };
}

/** Every effect on at 100%, groove maxed — the crash-test dummy. */
function allFxMax() {
  return {
    reverse: { on: true, chance: 1 },
    retrigger: { on: true, chance: 1 },
    sweep: { on: true, chance: 1, dir: "random" as const },
    tapestop: { on: true, chance: 1, speed: "random" as const },
    scratch: { on: true, chance: 1, mode: "random" as const },
    gater: { on: true, chance: 1, gates: 0 as const },
    repitch: { on: true, chance: 1, dir: "both" as const },
    bitcrush: { on: true, chance: 1, amount: "random" as const },
    filter: { on: true, chance: 1, type: "random" as const },
    tonaldelay: { on: true, chance: 1, motion: "random" as const },
    dropout: { on: true, chance: 0.3 },
    autopan: { on: true, amount: 1 },
    swing: { on: true, amount: 0.6 },
    endfill: { on: true, chance: 1 },
    colorclips: { on: true },
  };
}

// Sources below span 4 beats at 120 BPM (2 s), matching sourceBeats: 4.
const BASE = {
  ...DEFAULT_PARAMS,
  tempo: 120,
  sourceBeats: 4,
  variationIndex: 0,
};

test("output is stereo 48 kHz and exactly loopBars long", () => {
  const out = buildCollageLoop([noiseSource(2)], { ...BASE, loopBars: 1 });
  // 1 bar = 4 beats at 120 BPM = 2 s.
  assert.equal(out.sampleRate, OUTPUT_SAMPLE_RATE);
  assert.equal(out.channels.length, 2);
  assert.equal(out.channels[0]!.length, 2 * OUTPUT_SAMPLE_RATE);
  assert.equal(out.channels[1]!.length, 2 * OUTPUT_SAMPLE_RATE);
});

test("same seed + params -> bit-identical output", () => {
  const a = buildCollageLoop([noiseSource(2)], BASE);
  const b = buildCollageLoop([noiseSource(2)], BASE);
  assert.deepEqual(a.channels[0], b.channels[0]);
  assert.deepEqual(a.channels[1], b.channels[1]);
});

test("different variation index -> different output", () => {
  const a = buildCollageLoop([noiseSource(2)], { ...BASE, variationIndex: 0 });
  const b = buildCollageLoop([noiseSource(2)], { ...BASE, variationIndex: 1 });
  assert.notDeepEqual(a.channels[0], b.channels[0]);
});

test("different seed -> different output", () => {
  const a = buildCollageLoop([noiseSource(2)], BASE);
  const b = buildCollageLoop([noiseSource(2)], { ...BASE, seed: BASE.seed + 1 });
  assert.notDeepEqual(a.channels[0], b.channels[0]);
});

test("every slot is a whole grid slice of the source (chops on the grid)", () => {
  // Source: 2 s (4 beats at 120) divided into 4 slices, each a DISTINCT
  // constant value. Slice length 1/4 -> 24000-frame slots. Any chop that does
  // not start exactly on the source grid must span a boundary between two
  // constant regions, producing a step INSIDE an output slot — so "each slot
  // is constant" proves grid alignment.
  const n = 2 * OUTPUT_SAMPLE_RATE;
  const slotFrames = n / 4;
  const step = new Float32Array(n);
  for (let i = 0; i < n; i++) step[i] = (Math.floor(i / slotFrames) + 1) / 4;
  const src: AudioBuffers = { channels: [step, step], sampleRate: OUTPUT_SAMPLE_RATE };

  const out = buildCollageLoop([src], {
    ...BASE,
    ...allFxOff(),
    sliceLength: "1/4",
    loopBars: 1,
    crossfade: "off",
  });

  const ch = out.channels[0]!;
  assert.equal(ch.length % slotFrames, 0);
  const margin = 64; // clear of the declick fades
  const values: number[] = [];
  for (let slot = 0; slot < ch.length / slotFrames; slot++) {
    let min = Infinity;
    let max = -Infinity;
    for (let i = slot * slotFrames + margin; i < (slot + 1) * slotFrames - margin; i++) {
      min = Math.min(min, ch[i]!);
      max = Math.max(max, ch[i]!);
    }
    assert.ok(max - min < 1e-4, `slot ${slot} is not constant (${min}..${max}) -> chop off-grid`);
    values.push((min + max) / 2);
  }
  // Each slot value is normalization-gain * (k+1)/4 for a whole slice k, so
  // any pair of slot values must relate as p/q with p, q in 1..4.
  const allowed = [1 / 4, 1 / 3, 1 / 2, 2 / 3, 3 / 4, 1];
  const vmax = Math.max(...values);
  for (const [slot, v] of values.entries()) {
    const ratio = v / vmax;
    assert.ok(
      allowed.some((a) => Math.abs(ratio - a) < 1e-3),
      `slot ${slot}: value ratio ${ratio} is not a whole-slice ratio`,
    );
  }
});

test("peak is normalized to -1 dBFS", () => {
  const out = buildCollageLoop([noiseSource(2)], BASE);
  let peak = 0;
  for (const ch of out.channels) {
    for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]!));
  }
  const target = Math.pow(10, -1 / 20);
  assert.ok(Math.abs(peak - target) < 1e-4, `peak ${peak} != ${target}`);
});

test("mono and 44.1 kHz sources are accepted", () => {
  const out = buildCollageLoop([noiseSource(2, 44100, 1)], BASE);
  assert.equal(out.sampleRate, OUTPUT_SAMPLE_RATE);
  assert.equal(out.channels.length, 2);
});

test("shuffle-only fx fill the loop without gaps of silence", () => {
  for (const sliceLength of ["1/4", "1/8", "1/16", "random"] as const) {
    const out = buildCollageLoop([noiseSource(2)], {
      ...BASE,
      ...allFxOff(),
      sliceLength,
      loopBars: 2,
      crossfade: "long",
      reverse: { on: true, chance: 0.5 },
      retrigger: { on: true, chance: 0.5 },
      repitch: { on: true, chance: 0.5, dir: "both" },
      bitcrush: { on: true, chance: 0.5, amount: "random" },
    });
    // Any full slot of pure silence would make the RMS of some window ~0.
    const ch = out.channels[0]!;
    const win = Math.floor((4 / 16) * (60 / 120) * OUTPUT_SAMPLE_RATE); // one 1/16 slice
    for (let i = 0; i + win <= ch.length; i += win) {
      let sum = 0;
      for (let j = i; j < i + win; j++) sum += ch[j]! * ch[j]!;
      assert.ok(Math.sqrt(sum / win) > 1e-4, `silent window at ${i} (${sliceLength})`);
    }
  }
});

test("all fx at 100% stay deterministic, full-length and normalized", () => {
  const params = {
    ...BASE,
    ...allFxMax(),
    crossfade: "medium" as const,
    loopBars: 2 as const,
  };
  const a = buildCollageLoop([noiseSource(2)], params);
  const b = buildCollageLoop([noiseSource(2)], params);
  assert.deepEqual(a.channels[0], b.channels[0]);
  assert.equal(a.channels[0]!.length, 4 * OUTPUT_SAMPLE_RATE); // 2 bars at 120
  let peak = 0;
  let finite = true;
  for (const ch of a.channels) {
    for (let i = 0; i < ch.length; i++) {
      if (!Number.isFinite(ch[i]!)) finite = false;
      peak = Math.max(peak, Math.abs(ch[i]!));
    }
  }
  assert.ok(finite, "output contains NaN/Infinity");
  assert.ok(Math.abs(peak - Math.pow(10, -1 / 20)) < 1e-4);
});

test("gater at 100% actually punches silence into the output", () => {
  const out = buildCollageLoop([noiseSource(2)], {
    ...BASE,
    ...allFxOff(),
    gater: { on: true, chance: 1, gates: 8 },
    crossfade: "off",
  });
  const ch = out.channels[0]!;
  let silent = 0;
  for (let i = 0; i < ch.length; i++) if (Math.abs(ch[i]!) < 1e-6) silent++;
  // 50% duty gates -> a large chunk of the loop must be silent.
  assert.ok(silent > ch.length * 0.25, `only ${silent}/${ch.length} silent frames`);
});

test("dropout at 100% produces an empty loop; autopan pans odd/even slots", () => {
  const out = buildCollageLoop([noiseSource(2)], {
    ...BASE,
    ...allFxOff(),
    dropout: { on: true, chance: 1 },
  });
  let sum = 0;
  for (const ch of out.channels) for (let i = 0; i < ch.length; i++) sum += Math.abs(ch[i]!);
  assert.equal(sum, 0);

  const panned = buildCollageLoop([noiseSource(2)], {
    ...BASE,
    ...allFxOff(),
    autopan: { on: true, amount: 1 },
    crossfade: "off",
  });
  // With amount=1 alternating slots are hard L / hard R: channels must differ
  // strongly in energy per slot but the loop still has audio in both channels.
  const energy = panned.channels.map((ch) => {
    let e = 0;
    for (let i = 0; i < ch.length; i++) e += ch[i]! * ch[i]!;
    return e;
  });
  assert.ok(energy[0]! > 0 && energy[1]! > 0);
});

test("end fill at 100% replaces the final beat deterministically", () => {
  const params = {
    ...BASE,
    ...allFxOff(),
    endfill: { on: true, chance: 1 },
    loopBars: 1 as const,
  };
  const a = buildCollageLoop([noiseSource(2)], params);
  const b = buildCollageLoop([noiseSource(2)], params);
  assert.deepEqual(a.channels[0], b.channels[0]);
  // The fill region (last beat = last quarter of a 1-bar loop) has audio.
  const ch = a.channels[0]!;
  const fillStart = ch.length - Math.round(0.5 * OUTPUT_SAMPLE_RATE);
  let sum = 0;
  for (let i = fillStart; i < ch.length; i++) sum += Math.abs(ch[i]!);
  assert.ok(sum > 0, "fill region is silent");
});

test("slots metadata covers the loop and reports fx per chop", () => {
  // FX off: slots tile the loop contiguously, all plain.
  const plain = buildCollageLoop([noiseSource(2)], { ...BASE, ...allFxOff(), loopBars: 1 });
  assert.ok(plain.slots.length > 0);
  assert.equal(plain.slots[0]!.startFrame, 0);
  assert.equal(plain.slots[plain.slots.length - 1]!.endFrame, plain.channels[0]!.length);
  for (let i = 1; i < plain.slots.length; i++) {
    assert.equal(plain.slots[i]!.startFrame, plain.slots[i - 1]!.endFrame);
  }
  assert.ok(plain.slots.every((s) => s.fx === null && !s.reversed));

  // Gater at 100%: every slot reports the gater.
  const gated = buildCollageLoop([noiseSource(2)], {
    ...BASE, ...allFxOff(), gater: { on: true, chance: 1, gates: 8 },
  });
  assert.ok(gated.slots.every((s) => s.fx === "gater"));

  // End fill at 100%: the final slot is the fill, ending exactly at the loop end.
  const filled = buildCollageLoop([noiseSource(2)], {
    ...BASE, ...allFxOff(), endfill: { on: true, chance: 1 }, loopBars: 1,
  });
  const last = filled.slots[filled.slots.length - 1]!;
  assert.equal(last.fx, "endfill");
  assert.equal(last.endFrame, filled.channels[0]!.length);
  // Slots never overlap the fill region.
  assert.ok(filled.slots.slice(0, -1).every((s) => s.endFrame <= last.startFrame));
});

test("encodeWav24 writes a valid 24-bit PCM header", () => {
  const out = buildCollageLoop([noiseSource(2)], BASE);
  const bytes = encodeWav24(out);
  const text = (o: number, n: number) => String.fromCharCode(...bytes.slice(o, o + n));
  const view = new DataView(bytes.buffer);
  assert.equal(text(0, 4), "RIFF");
  assert.equal(text(8, 4), "WAVE");
  assert.equal(text(12, 4), "fmt ");
  assert.equal(view.getUint16(20, true), 1); // PCM
  assert.equal(view.getUint16(22, true), 2); // stereo
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint16(34, true), 24); // bits
  assert.equal(text(36, 4), "data");
  assert.equal(view.getUint32(40, true), out.channels[0]!.length * 2 * 3);
  assert.equal(bytes.length, 44 + out.channels[0]!.length * 2 * 3);
});

test("sanitizeParams migrates legacy 1.x flat keys", () => {
  const p = sanitizeParams({
    sliceLength: "1/8",
    loopBars: 2,
    reverseChance: 0.4,
    bitcrushChance: 0.3,
    bitcrushAmount: "hard",
    retriggerChance: 0,
    tapestopChance: 0.2,
    gaterChance: 0.1,
    repitchChance: 0.15,
    variations: 4,
    seed: 999,
  });
  assert.equal(p.sliceLength, "1/8");
  assert.equal(p.reverse.on, true);
  assert.equal(p.reverse.chance, 0.4);
  assert.equal(p.bitcrush.on, true);
  assert.equal(p.bitcrush.chance, 0.3);
  assert.equal(p.bitcrush.amount, "hard");
  assert.equal(p.retrigger.on, false); // legacy 0 -> off
  assert.equal(p.tapestop.chance, 0.2);
  assert.equal(p.gater.chance, 0.1);
  assert.equal(p.repitch.chance, 0.15);
  assert.equal(p.seed, 999);
  // New effects fall back to their defaults.
  assert.deepEqual(p.sweep, DEFAULT_PARAMS.sweep);
  assert.deepEqual(p.autopan, DEFAULT_PARAMS.autopan);
});

test("sanitizeParams clamps and defaults bad nested input", () => {
  const p = sanitizeParams({
    sliceLength: "1/32",
    loopBars: 3,
    crossfade: "verylong",
    reverse: { on: "yes", chance: 7 },
    gater: { on: true, chance: 0.5, gates: 5 },
    repitch: { on: true, chance: 0.5, dir: "sideways" },
    variations: 99,
    seed: "notanumber",
    uiScale: 3,
    swing: { amount: -2 },
  });
  assert.equal(p.sliceLength, DEFAULT_PARAMS.sliceLength);
  assert.equal(p.loopBars, DEFAULT_PARAMS.loopBars);
  assert.equal(p.crossfade, DEFAULT_PARAMS.crossfade);
  assert.equal(p.reverse.on, DEFAULT_PARAMS.reverse.on); // "yes" is not a bool
  assert.equal(p.reverse.chance, 1);
  assert.equal(p.gater.gates, DEFAULT_PARAMS.gater.gates); // 5 invalid
  assert.equal(p.repitch.dir, DEFAULT_PARAMS.repitch.dir);
  assert.equal(p.variations, 8);
  assert.equal(p.seed, DEFAULT_PARAMS.seed);
  assert.equal(p.uiScale, 1);
  assert.equal(p.swing.amount, 0);
  assert.equal(p.swing.on, false); // clamped-to-0 legacy amount cannot mean on
  // Pre-1.4.3 migration: an amount without a toggle means on when > 0.
  assert.equal(sanitizeParams({ swing: { amount: 0.4 } }).swing.on, true);
  assert.equal(sanitizeParams({ swing: { amount: 0 } }).swing.on, false);
  assert.equal(sanitizeParams({}).colorclips.on, false);
  assert.equal(sanitizeParams({ colorclips: { on: true } }).colorclips.on, true);
  // New per-effect options default and validate.
  assert.equal(sanitizeParams({}).tapestop.speed, DEFAULT_PARAMS.tapestop.speed);
  assert.equal(sanitizeParams({ tapestop: { on: true, chance: 0.5, speed: "fast" } }).tapestop.speed, "fast");
  assert.equal(sanitizeParams({ tapestop: { on: true, chance: 0.5, speed: "warp9" } }).tapestop.speed, DEFAULT_PARAMS.tapestop.speed);
  assert.equal(sanitizeParams({ tonaldelay: { on: true, chance: 0.5, motion: "wobble" } }).tonaldelay.motion, "wobble");
  assert.equal(sanitizeParams({ tonaldelay: { on: true, chance: 0.5, motion: "spin" } }).tonaldelay.motion, DEFAULT_PARAMS.tonaldelay.motion);
  const round = sanitizeParams(p);
  assert.deepEqual(round, p);
});

test("sanitizeFavorites keeps valid recipes and drops junk", () => {
  const favs = sanitizeFavorites([
    { name: "  DISCO WALRUS  ", created: 1754300000000, color: "teal", params: { ...DEFAULT_PARAMS, seed: 42 } },
    { name: "", params: DEFAULT_PARAMS }, // empty name -> dropped
    "not an object", // dropped
    { name: "X".repeat(99), color: "mauve", params: { seed: 7 } }, // name clamped, bad color -> ""
  ]);
  assert.equal(favs.length, 2);
  assert.equal(favs[0]!.name, "DISCO WALRUS");
  assert.equal(favs[0]!.created, 1754300000000);
  assert.equal(favs[0]!.color, "teal");
  assert.equal(favs[1]!.color, "");
  assert.equal(favs[0]!.params.seed, 42);
  assert.equal(favs[1]!.name.length, 40);
  assert.equal(favs[1]!.created, 0);
  assert.equal(favs[1]!.params.seed, 7);
  assert.equal(favs[1]!.params.loopBars, DEFAULT_PARAMS.loopBars);
  assert.deepEqual(sanitizeFavorites({ evil: true }), []);
  const many = sanitizeFavorites(
    Array.from({ length: 99 }, (_, i) => ({ name: `F${i}`, params: DEFAULT_PARAMS })),
  );
  assert.equal(many.length, 64);
});

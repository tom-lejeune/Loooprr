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
    sliceLength: "1/4",
    loopBars: 1,
    crossfade: "off",
    reverseChance: 0,
    bitcrushChance: 0,
    retriggerChance: 0,
    tapestopChance: 0,
    gaterChance: 0,
    repitchChance: 0,
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

test("longer loops and all slice lengths fill without gaps of silence", () => {
  for (const sliceLength of ["1/4", "1/8", "1/16", "random"] as const) {
    const out = buildCollageLoop([noiseSource(2)], {
      ...BASE,
      sliceLength,
      loopBars: 2,
      crossfade: "long",
      reverseChance: 0.5,
      bitcrushChance: 0.5,
      bitcrushAmount: "random",
      retriggerChance: 0.5,
      repitchChance: 0.5,
      // gater and tapestop create intentional silence/freeze — excluded here.
      gaterChance: 0,
      tapestopChance: 0,
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

test("all glitch FX at 100% stay deterministic, full-length and normalized", () => {
  const params = {
    ...BASE,
    reverseChance: 1,
    bitcrushChance: 1,
    retriggerChance: 1,
    tapestopChance: 1,
    gaterChance: 1,
    repitchChance: 1,
    crossfade: "medium" as const,
    loopBars: 2 as const,
  };
  const a = buildCollageLoop([noiseSource(2)], params);
  const b = buildCollageLoop([noiseSource(2)], params);
  assert.deepEqual(a.channels[0], b.channels[0]);
  assert.equal(a.channels[0]!.length, 4 * OUTPUT_SAMPLE_RATE); // 2 bars at 120
  let peak = 0;
  for (const ch of a.channels) {
    for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i]!));
  }
  assert.ok(Math.abs(peak - Math.pow(10, -1 / 20)) < 1e-4);
});

test("gater at 100% actually punches silence into the output", () => {
  const out = buildCollageLoop([noiseSource(2)], {
    ...BASE,
    gaterChance: 1,
    retriggerChance: 0,
    tapestopChance: 0,
    repitchChance: 0,
    bitcrushChance: 0,
    reverseChance: 0,
    crossfade: "off",
  });
  const ch = out.channels[0]!;
  let silent = 0;
  for (let i = 0; i < ch.length; i++) if (Math.abs(ch[i]!) < 1e-6) silent++;
  // 50% duty gates -> a large chunk of the loop must be silent.
  assert.ok(silent > ch.length * 0.25, `only ${silent}/${ch.length} silent frames`);
});

test("selection shorter than the loop still fills the whole loop", () => {
  // 1-beat selection (0.5 s), 1-bar loop: slices of 1/4 beat repeat-fill 4 beats.
  const out = buildCollageLoop([noiseSource(0.5)], { ...BASE, sourceBeats: 1, loopBars: 1 });
  const ch = out.channels[0]!;
  const win = 4800;
  for (let i = 0; i + win <= ch.length; i += win) {
    let sum = 0;
    for (let j = i; j < i + win; j++) sum += ch[j]! * ch[j]!;
    assert.ok(Math.sqrt(sum / win) > 1e-4, `silent window at ${i}`);
  }
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

test("sanitizeParams clamps and defaults bad input", () => {
  const p = sanitizeParams({
    sliceLength: "1/32",
    loopBars: 3,
    crossfade: "verylong",
    reverseChance: 7,
    bitcrushChance: -2,
    bitcrushAmount: "extreme",
    retriggerChance: 2,
    tapestopChance: -1,
    gaterChance: "x",
    repitchChance: 0.4,
    variations: 99,
    seed: "notanumber",
  });
  assert.equal(p.retriggerChance, 1);
  assert.equal(p.tapestopChance, 0);
  assert.equal(p.gaterChance, DEFAULT_PARAMS.gaterChance);
  assert.equal(p.repitchChance, 0.4);
  assert.equal(p.uiScale, DEFAULT_PARAMS.uiScale); // missing -> default
  assert.equal(sanitizeParams({ uiScale: 0.05 }).uiScale, 0.5); // clamped low
  assert.equal(sanitizeParams({ uiScale: 3 }).uiScale, 1); // clamped high
  assert.equal(sanitizeParams({ uiScale: 0.777 }).uiScale, 0.78); // rounded
  assert.equal(p.sliceLength, DEFAULT_PARAMS.sliceLength);
  assert.equal(p.loopBars, DEFAULT_PARAMS.loopBars);
  assert.equal(p.crossfade, DEFAULT_PARAMS.crossfade);
  assert.equal(p.reverseChance, 1);
  assert.equal(p.bitcrushChance, 0);
  assert.equal(p.bitcrushAmount, DEFAULT_PARAMS.bitcrushAmount);
  assert.equal(p.variations, 8);
  assert.equal(p.seed, DEFAULT_PARAMS.seed);
  const round = sanitizeParams(p);
  assert.deepEqual(round, p);
});

test("sanitizeFavorites keeps valid recipes and drops junk", () => {
  const favs = sanitizeFavorites([
    { name: "  DISCO WALRUS  ", params: { ...DEFAULT_PARAMS, seed: 42 } },
    { name: "", params: DEFAULT_PARAMS }, // empty name -> dropped
    "not an object", // dropped
    { name: "X".repeat(99), params: { seed: 7 } }, // name clamped, params defaulted
  ]);
  assert.equal(favs.length, 2);
  assert.equal(favs[0]!.name, "DISCO WALRUS");
  assert.equal(favs[0]!.params.seed, 42);
  assert.equal(favs[1]!.name.length, 40);
  assert.equal(favs[1]!.params.seed, 7);
  assert.equal(favs[1]!.params.loopBars, DEFAULT_PARAMS.loopBars);
  // Not an array -> empty.
  assert.deepEqual(sanitizeFavorites({ evil: true }), []);
  // Capped at 24.
  const many = sanitizeFavorites(
    Array.from({ length: 40 }, (_, i) => ({ name: `F${i}`, params: DEFAULT_PARAMS })),
  );
  assert.equal(many.length, 24);
});

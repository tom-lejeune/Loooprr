/**
 * Parameter model for Loooprr. Pure data + sanitization, no host imports,
 * so it can be unit-tested offline.
 *
 * Since 1.4.0 every effect is a nested object with an `on` toggle and its own
 * options; sanitizeParams also migrates the old flat 1.x keys
 * (reverseChance, bitcrushAmount, ...) so stored settings and favorites keep
 * working.
 */

export type SliceLength = "1/4" | "1/8" | "1/16" | "random";
export type CrossfadeSetting = "off" | "short" | "medium" | "long";
export type BitcrushAmount = "light" | "medium" | "hard" | "random";
export type LoopBars = 1 | 2 | 4 | 8;

export interface ChanceFx {
  on: boolean;
  /** 0..1 per-slice probability (quadratic curve applied in the DSP). */
  chance: number;
}
export interface BitcrushFx extends ChanceFx { amount: BitcrushAmount }
/** gates: gates per slice; 0 = random (4 or 8). */
export interface GaterFx extends ChanceFx { gates: 4 | 8 | 0 }
export interface RepitchFx extends ChanceFx { dir: "up" | "down" | "both" }
export interface SweepFx extends ChanceFx { dir: "up" | "down" | "random" }
export interface ScratchFx extends ChanceFx { mode: "scrub" | "spinback" | "random" }
export interface FilterFx extends ChanceFx { type: "lp" | "hp" | "random" }

export interface CollageParams {
  sliceLength: SliceLength;
  loopBars: LoopBars;
  crossfade: CrossfadeSetting;
  /** 1..8 loop variations generated per run. */
  variations: number;
  /** uint32 RNG seed; same seed + settings -> same loops. */
  seed: number;
  /** Dialog scale 0.5..1 — auto-fitted to the screen, user-adjustable, persisted. */
  uiScale: number;

  // Slice FX — at most one glitch per slice (chances compete); reverse stacks.
  reverse: ChanceFx;
  retrigger: ChanceFx;
  sweep: SweepFx;
  tapestop: ChanceFx;
  scratch: ScratchFx;
  gater: GaterFx;
  repitch: RepitchFx;
  bitcrush: BitcrushFx;
  filter: FilterFx;
  tonaldelay: ChanceFx;
  dropout: ChanceFx;

  // Groove & space — applied on top of everything.
  autopan: { on: boolean; amount: number };
  swing: { on: boolean; amount: number };
  endfill: { on: boolean; chance: number };
  /** Place one clip per chop, colored by the effect that hit it. */
  colorclips: { on: boolean };
}

export const DEFAULT_PARAMS: CollageParams = {
  sliceLength: "1/16",
  loopBars: 1,
  crossfade: "off",
  variations: 4,
  seed: 252644670,
  uiScale: 1,
  reverse: { on: true, chance: 0.25 },
  retrigger: { on: true, chance: 0.1 },
  sweep: { on: false, chance: 0.2, dir: "random" },
  tapestop: { on: true, chance: 0.1 },
  scratch: { on: false, chance: 0.15, mode: "random" },
  gater: { on: true, chance: 0.1, gates: 0 },
  repitch: { on: true, chance: 0.1, dir: "both" },
  bitcrush: { on: true, chance: 0.3, amount: "medium" },
  filter: { on: false, chance: 0.25, type: "random" },
  tonaldelay: { on: false, chance: 0.15 },
  dropout: { on: false, chance: 0.15 },
  autopan: { on: false, amount: 0.6 },
  swing: { on: false, amount: 0.3 },
  endfill: { on: false, chance: 0.5 },
  colorclips: { on: false },
};

const SLICE_LENGTHS: readonly SliceLength[] = ["1/4", "1/8", "1/16", "random"];
const CROSSFADES: readonly CrossfadeSetting[] = ["off", "short", "medium", "long"];
const CRUSH_AMOUNTS: readonly BitcrushAmount[] = ["light", "medium", "hard", "random"];
const LOOP_BARS: readonly LoopBars[] = [1, 2, 4, 8];

function clamp01(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function pick<T>(v: unknown, options: readonly T[], fallback: T): T {
  return options.includes(v as T) ? (v as T) : fallback;
}

/**
 * Read a nested fx object, falling back to the legacy flat 1.x key
 * (`<legacy>Chance`): a legacy chance of 0 maps to on=false.
 */
function chanceFx(
  r: Record<string, unknown>,
  key: string,
  legacyKey: string,
  def: ChanceFx,
): ChanceFx {
  const nested = r[key];
  if (nested && typeof nested === "object") {
    const n = nested as Record<string, unknown>;
    return { on: bool(n.on, def.on), chance: clamp01(n.chance, def.chance) };
  }
  const legacy = r[legacyKey];
  if (legacy !== undefined) {
    const chance = clamp01(legacy, def.chance);
    return { on: chance > 0, chance: chance > 0 ? chance : def.chance };
  }
  return { ...def };
}

function nestedOption<T>(
  r: Record<string, unknown>,
  key: string,
  optKey: string,
  options: readonly T[],
  fallback: T,
): T {
  const nested = r[key];
  if (nested && typeof nested === "object") {
    return pick((nested as Record<string, unknown>)[optKey], options, fallback);
  }
  return fallback;
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

  const scaleNum = Number(r.uiScale);
  const uiScale = Number.isFinite(scaleNum)
    ? Math.round(Math.min(1, Math.max(0.5, scaleNum)) * 100) / 100
    : d.uiScale;

  // Legacy bitcrushAmount lived at the top level in 1.x.
  const legacyAmount = pick(r.bitcrushAmount, CRUSH_AMOUNTS, d.bitcrush.amount);

  const autopanRaw = (r.autopan ?? {}) as Record<string, unknown>;
  const swingRaw = (r.swing ?? {}) as Record<string, unknown>;
  const endfillRaw = (r.endfill ?? {}) as Record<string, unknown>;

  return {
    sliceLength: pick(r.sliceLength, SLICE_LENGTHS, d.sliceLength),
    loopBars,
    crossfade: pick(r.crossfade, CROSSFADES, d.crossfade),
    variations,
    seed,
    uiScale,
    reverse: chanceFx(r, "reverse", "reverseChance", d.reverse),
    retrigger: chanceFx(r, "retrigger", "retriggerChance", d.retrigger),
    sweep: {
      ...chanceFx(r, "sweep", "__none", d.sweep),
      dir: nestedOption(r, "sweep", "dir", ["up", "down", "random"] as const, d.sweep.dir),
    },
    tapestop: chanceFx(r, "tapestop", "tapestopChance", d.tapestop),
    scratch: {
      ...chanceFx(r, "scratch", "__none", d.scratch),
      mode: nestedOption(r, "scratch", "mode", ["scrub", "spinback", "random"] as const, d.scratch.mode),
    },
    gater: {
      ...chanceFx(r, "gater", "gaterChance", d.gater),
      gates: nestedOption(r, "gater", "gates", [4, 8, 0] as const, d.gater.gates),
    },
    repitch: {
      ...chanceFx(r, "repitch", "repitchChance", d.repitch),
      dir: nestedOption(r, "repitch", "dir", ["up", "down", "both"] as const, d.repitch.dir),
    },
    bitcrush: {
      ...chanceFx(r, "bitcrush", "bitcrushChance", d.bitcrush),
      amount: nestedOption(r, "bitcrush", "amount", CRUSH_AMOUNTS, legacyAmount),
    },
    filter: {
      ...chanceFx(r, "filter", "__none", d.filter),
      type: nestedOption(r, "filter", "type", ["lp", "hp", "random"] as const, d.filter.type),
    },
    tonaldelay: chanceFx(r, "tonaldelay", "__none", d.tonaldelay),
    dropout: chanceFx(r, "dropout", "__none", d.dropout),
    autopan: {
      on: bool(autopanRaw.on, d.autopan.on),
      amount: clamp01(autopanRaw.amount, d.autopan.amount),
    },
    swing: (() => {
      const amount = clamp01(swingRaw.amount, d.swing.amount);
      // Pre-1.4.3 swing had no toggle: amount > 0 meant on.
      return { on: bool(swingRaw.on, amount > 0 && swingRaw.amount !== undefined), amount };
    })(),
    endfill: {
      on: bool(endfillRaw.on, d.endfill.on),
      chance: clamp01(endfillRaw.chance, d.endfill.chance),
    },
    colorclips: {
      on: bool(((r.colorclips ?? {}) as Record<string, unknown>).on, d.colorclips.on),
    },
  };
}

/** Color tags for grouping favorites; "" = untagged. */
export const FAVORITE_COLORS = ["", "yellow", "pink", "teal", "orange", "purple", "blue"] as const;
export type FavoriteColor = (typeof FAVORITE_COLORS)[number];

export interface Favorite {
  name: string;
  /** Creation time, epoch ms; 0 for favorites saved before this field existed. */
  created: number;
  /** Color tag for visual grouping ("" = none). */
  color: FavoriteColor;
  params: CollageParams;
}

export const MAX_FAVORITES = 64;

/** Coerce untrusted input (dialog JSON, stored file) into a valid favorites list. */
export function sanitizeFavorites(raw: unknown): Favorite[] {
  if (!Array.isArray(raw)) return [];
  const out: Favorite[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const name = String(r.name ?? "").trim().slice(0, 40);
    if (!name) continue;
    const createdNum = Number(r.created);
    const created = Number.isFinite(createdNum) && createdNum > 0 ? createdNum : 0;
    const color = FAVORITE_COLORS.includes(r.color as FavoriteColor)
      ? (r.color as FavoriteColor)
      : "";
    out.push({ name, created, color, params: sanitizeParams(r.params) });
    if (out.length >= MAX_FAVORITES) break;
  }
  return out;
}

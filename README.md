# Loooprr

An **Ableton Live 12 Extension** that generates new tempo-synced loops by
slicing and shuffling audio already in your Live Set — with a Memphis-design
dialog and a seed you can *see*.

Select a time range across one or more audio tracks in the Arrangement,
right-click → **Create Random Loop…**, tweak the settings, hit **CREATE**:
Loooprr renders the selection pre-FX, chops it into grid-locked slices,
shuffles them into brand-new loops (with optional glitch effects per slice),
and drops them as warped, looping clips on a new audio track. The source
audio is never touched.

## Features

- **Grid-locked chops** — slices are exact 1/4, 1/8 or 1/16 fractions of the
  selected sample, cut and placed on the grid, so the groove survives the
  shuffle. "RND" mixes all three sizes.
- **Loop length** — 1, 2, 4 or 8 bars; up to 8 variations per run, placed
  back-to-back.
- **Glitch FX per slice** (Glitch2-style: chances compete, max one effect per
  slice, reverse stacks on top). Each effect has an on/off toggle, a chance
  slider, and a dropdown with its own options:
  - **Reverse** — slice plays backwards
  - **Retrigger** — stutter-repeat of the slice's first chunk
  - **Stutter sweep** — accelerating repeats gliding up or down in pitch
  - **Tape stop** — slice decelerates to standstill
  - **Scratch** — vinyl scrub (back-and-forth) or spinback (accelerating rewind)
  - **Gater** — rhythmic gate pattern inside the slice (4/8/random gates)
  - **Repitch** — octave up (plays twice) or down (varispeed)
  - **Bitcrush** — bit-depth + rate crush (light / medium / hard / random)
  - **Filter sweep** — one-pole low- or high-pass gliding across the slice
  - **Tonal delay** — pitched comb delay ringing at a random note
  - **Dropout** — the slot stays silent (sparse, choppy grooves)
- **Groove & space** (applied on top of everything):
  - **Auto-pan** — alternating slots pan left/right by an adjustable width
  - **Swing** — odd slots drag behind the grid
  - **End fill** — the loop's final beat becomes an accelerating snare-roll
    fill (half the time also rising in pitch)
- **Crossfades** — equal-power slice joins (off/short/medium/long) that wrap
  around the loop end, so every loop is seamless.
- **Visual seed** — the seed is drawn as generative Memphis shapes; same
  shapes = same loops, bit-identical. Roll the 🎲 for a new one.
- **Favorites** — save the current recipe (seed + ALL settings) under a
  generated name like "DISCO WALRUS", then find it back in a preset-browser
  overlay sortable by date or name, with creation timestamps. Double-click to
  rename, × to delete. Load a favorite in any later session, on any other
  track, and get the exact same chops on the new material.
- Output: 48 kHz / 24-bit WAV, peak-normalized to −1 dBFS, imported into the
  project and placed as warped looping clips.

All chance sliders use a quadratic curve, so low percentages are genuinely
rare even on loops with many slices.

## Requirements

- **Ableton Live 12 Suite Beta, v12.4.5+** (Extensions do not exist in the
  stable release).
- To build from source: **Node.js ≥ 24.14.1** and the Ableton Extensions
  **SDK + CLI tarballs** placed in `./sdk/`. They are **not included in this
  repo** — Ableton's SDK license forbids redistributing the SDK itself. If you
  have access to the Extensions beta, download them and drop them in:

```
sdk/ableton-extensions-sdk-1.0.0-beta.0.tgz
sdk/ableton-extensions-cli-1.0.0-beta.0.tgz
```

## Install

Grab `Loooprr-<version>.ablx` (from the Releases page, or build it yourself),
then drag it into **Live → Settings → Extensions** and restart Live.

## Build from source

```bash
npm install        # resolves the SDK/CLI from ./sdk/*.tgz
npm test           # offline DSP unit tests (no Live needed)
npm run package    # type-check + production bundle + .ablx
```

For development, `npm start` builds and launches Live's Extension Host with
the extension loaded (requires Developer Mode and an `.env` with
`EXTENSION_HOST_PATH`).

## Usage

1. In the **Arrangement**, click-drag a time selection across one or more
   **audio tracks** (this is the material to collage).
2. Right-click → **Create Random Loop…**
3. Pick slice length, loop length, crossfade, FX chances, variations — and a
   seed you like the look of.
4. **CREATE**. A new "Loooprr" track appears with your variations as looping
   clips, starting at the selection start. Undo removes everything.

Settings are remembered as the defaults for next time
(`settings.json` in the extension's storage directory).

## How it works

```
renderPreFxAudio(track, selStart, selEnd)      → dry buffers per track
  → divide the sample into N grid slices (N = 4/8/16)
  → walk the output loop slot by slot:
      pick a random track + random WHOLE slice (seeded RNG)
      maybe reverse; maybe ONE glitch FX (retrigger/tapestop/gater/repitch/crush)
      equal-power crossfade into the neighbours, wrapping at the loop edges
  → peak-normalize to −1 dBFS, encode 48 kHz / 24-bit WAV
  → importIntoProject + createAudioClip (warped, looping) on a new track
```

The DSP is pure TypeScript (no native deps), fully offline and deterministic:
the seed drives one mulberry32 RNG for slice picks, FX rolls *and* the seed
artwork in the dialog.

## License

[MIT](LICENSE). The Ableton Extensions SDK itself is proprietary and not part
of this repository.

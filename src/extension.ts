/**
 * Loop Collage — generate new tempo-synced loops from audio already in the Set.
 *
 * Select a time range across one or more audio tracks in the Arrangement,
 * right-click -> "Create Random Loop…". A dialog offers slice length, loop
 * length, crossfade, reverse/bitcrush chances, variations and a seed; Create
 * renders each selected track pre-FX, slices and shuffles the audio into
 * 48 kHz / 24-bit WAV loops, and places them as warped, looping clips on a new
 * audio track at the selection start.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import decodeAudio from "audio-decode";

import {
  initialize,
  type ActivationContext,
  type ArrangementSelection,
  type ExtensionContext,
  AudioTrack,
  DataModelObject,
} from "@ableton-extensions/sdk";

import { buildCollageLoop, type AudioBuffers } from "./dsp.js";
import { encodeWav24 } from "./wav.js";
import {
  DEFAULT_PARAMS,
  sanitizeFavorites,
  sanitizeParams,
  type CollageParams,
  type Favorite,
} from "./params.js";
import interfaceHtml from "./interface.html";

type V = "1.0.0";
type Ctx = ExtensionContext<V>;

const SETTINGS_FILE = "settings.json";

/** Design size of the settings dialog; the real window is this times uiScale. */
const DIALOG_W = 960;
const DIALOG_H = 760;

/**
 * Tiny splash dialog that reports the screen's available size and closes
 * itself immediately. The extension process cannot see the screen, so this
 * probe is the only way to size the real dialog window to fit BEFORE opening
 * it (the window frame cannot be resized from inside a dialog).
 */
const MEASURE_HTML = `<!DOCTYPE html><html><head><style>
  body{margin:0;display:flex;align-items:center;justify-content:center;height:100vh;
  background:#faf5ec;font-family:"Arial Black","Segoe UI",sans-serif;user-select:none}
  div{font-size:20px;letter-spacing:.02em;color:#111}
</style></head><body><div>LOOOPRR&nbsp;&#127922;</div><script>
  function send(m){
    if(window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.live){
      window.webkit.messageHandlers.live.postMessage(m);
    }else if(window.chrome&&window.chrome.webview){window.chrome.webview.postMessage(m);}
  }
  function report(){send({method:"close_and_send",params:[JSON.stringify(
    {w:screen.availWidth,h:screen.availHeight})]});}
  addEventListener("load",report);
  addEventListener("click",report); // fallback if auto-close is blocked
</script></body></html>`;

/** Probe the screen and return the dialog scale that fits it (0.5..1). */
async function measureFitScale(context: Ctx): Promise<number> {
  try {
    const probe = await context.ui.showModalDialog(
      `data:text/html,${encodeURIComponent(MEASURE_HTML)}`,
      220,
      90,
    );
    const dims = JSON.parse(probe) as { w?: number; h?: number };
    if (typeof dims.w === "number" && typeof dims.h === "number" && dims.w > 0 && dims.h > 0) {
      return Math.max(
        0.5,
        Math.min(1, (dims.h * 0.9) / DIALOG_H, (dims.w * 0.95) / DIALOG_W),
      );
    }
  } catch (e) {
    console.warn("Loooprr: screen measure failed, using saved scale.", e);
  }
  return 1;
}

/**
 * Storage lives at USER level (~/.loooprr), not in Live's storageDirectory:
 * that directory turned out to be per-Live-set, so favorites saved in one set
 * were invisible in the next. The per-set dir is kept as a read-fallback to
 * migrate old saves, and as a write-fallback should the home dir be blocked.
 */
function globalDir(): string {
  return path.join(os.homedir(), ".loooprr");
}

function legacyDir(context: Ctx): string | undefined {
  return context.environment.storageDirectory;
}

/** Read+parse JSON from the global dir, falling back to the legacy per-set dir. */
async function readStored(context: Ctx, file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(path.join(globalDir(), file), "utf8"));
  } catch {
    const legacy = legacyDir(context);
    if (!legacy) return undefined;
    try {
      return JSON.parse(await fs.readFile(path.join(legacy, file), "utf8"));
    } catch {
      return undefined;
    }
  }
}

/** Write JSON to the global dir; fall back to the legacy per-set dir. */
async function writeStored(context: Ctx, file: string, data: unknown): Promise<void> {
  const json = JSON.stringify(data, null, 2);
  try {
    await fs.mkdir(globalDir(), { recursive: true });
    await fs.writeFile(path.join(globalDir(), file), json);
  } catch (e) {
    const legacy = legacyDir(context);
    if (!legacy) {
      console.error(`Loooprr: failed to save ${file}:`, e);
      return;
    }
    try {
      await fs.mkdir(legacy, { recursive: true });
      await fs.writeFile(path.join(legacy, file), json);
    } catch (e2) {
      console.error(`Loooprr: failed to save ${file}:`, e2);
    }
  }
}

async function loadParams(context: Ctx): Promise<CollageParams> {
  const raw = await readStored(context, SETTINGS_FILE);
  return raw === undefined ? DEFAULT_PARAMS : sanitizeParams(raw);
}

async function saveParams(context: Ctx, params: CollageParams): Promise<void> {
  await writeStored(context, SETTINGS_FILE, params);
}

const FAVORITES_FILE = "favorites.json";

async function loadFavorites(context: Ctx): Promise<Favorite[]> {
  const raw = await readStored(context, FAVORITES_FILE);
  const favorites = sanitizeFavorites(raw);
  // Migrate legacy per-set saves to the global dir so they appear everywhere.
  if (favorites.length) await writeStored(context, FAVORITES_FILE, favorites);
  return favorites;
}

async function saveFavorites(context: Ctx, favorites: Favorite[]): Promise<void> {
  await writeStored(context, FAVORITES_FILE, favorites);
}

/** Render a track's pre-FX audio over a beat range and decode it. */
async function renderTrack(
  context: Ctx,
  track: AudioTrack<V>,
  startBeat: number,
  endBeat: number,
): Promise<AudioBuffers> {
  const wavPath = await context.resources.renderPreFxAudio(track, startBeat, endBeat);
  const decoded = await decodeAudio(await fs.readFile(wavPath));
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) =>
    decoded.getChannelData(i),
  );
  return { channels, sampleRate: decoded.sampleRate };
}

async function runCollage(context: Ctx, selection: ArrangementSelection): Promise<void> {
  const song = context.application.song;
  if (!song) {
    console.error("Loooprr: no song available.");
    return;
  }

  const tracks = selection.selected_lanes
    .map((handle) => context.getObjectFromHandle(handle, DataModelObject))
    .filter((obj): obj is AudioTrack<V> => obj instanceof AudioTrack);
  if (!tracks.length) {
    console.error("Loooprr: select a time range on one or more audio tracks.");
    return;
  }

  const selStart = selection.time_selection_start;
  const selEnd = selection.time_selection_end;
  if (!(selEnd > selStart)) {
    console.error("Loooprr: select a time range first (click-drag in the Arrangement).");
    return;
  }

  // Dialog: current saved settings as starting point. A quick probe dialog
  // measures the screen first, so the real WINDOW opens at a size that fits
  // (it cannot be resized afterwards); the page zooms its content to match.
  // uiScale is the user's preference (A-/A+), capped by what fits.
  const current = await loadParams(context);
  const favorites = await loadFavorites(context);
  const fitScale = await measureFitScale(context);
  const scale = Math.max(0.5, Math.min(current.uiScale, fitScale));
  const html = interfaceHtml
    .replace("__PARAMS__", JSON.stringify({ ...current, uiScale: scale }))
    .replace("__FAVORITES__", JSON.stringify(favorites));
  const result = await context.ui.showModalDialog(
    `data:text/html,${encodeURIComponent(html)}`,
    Math.round(DIALOG_W * scale),
    Math.round(DIALOG_H * scale),
  );
  const parsed = JSON.parse(result) as {
    cancelled?: boolean;
    uiScale?: number;
    favorites?: unknown;
  };
  // Favorites edits (save/rename/delete) persist even on cancel.
  if (parsed.favorites !== undefined) {
    await saveFavorites(context, sanitizeFavorites(parsed.favorites));
  }
  if (parsed.cancelled) {
    // Still remember a scale change, so Cancel doesn't undo the resize.
    const scale = sanitizeParams({ ...current, uiScale: parsed.uiScale }).uiScale;
    if (scale !== current.uiScale) await saveParams(context, { ...current, uiScale: scale });
    return;
  }
  const params = sanitizeParams(parsed);
  await saveParams(context, params);

  await context.ui.withinProgressDialog(
    "Loooprr",
    { progress: 0 },
    async (update, signal) => {
      // Phase 1: render all selected tracks over the selection.
      const sources: AudioBuffers[] = [];
      for (let i = 0; i < tracks.length; i++) {
        if (signal.aborted) return;
        const track = tracks[i]!;
        await update(`Rendering ${track.name}…`, (i / tracks.length) * 40);
        const buffers = await renderTrack(context, track, selStart, selEnd);
        if (buffers.channels.length && buffers.channels[0]!.length > 1) {
          sources.push(buffers);
        }
      }
      if (signal.aborted) return;
      if (!sources.length) {
        console.error("Loooprr: the selection rendered no audio.");
        return;
      }

      // Phase 2: generate the variations and import their WAVs.
      const tempo = song.tempo;
      const tempDir = context.environment.tempDirectory ?? os.tmpdir();
      const stamp = Date.now();
      const importedPaths: string[] = [];
      for (let v = 0; v < params.variations; v++) {
        if (signal.aborted) return;
        await update(
          `Generating variation ${v + 1}/${params.variations}…`,
          40 + (v / params.variations) * 45,
        );
        const loop = buildCollageLoop(sources, {
          ...params,
          tempo,
          sourceBeats: selEnd - selStart,
          variationIndex: v,
        });
        const outPath = path.join(tempDir, `loooprr-${stamp}-v${v + 1}.wav`);
        await fs.writeFile(outPath, encodeWav24(loop));
        importedPaths.push(await context.resources.importIntoProject(outPath));
      }
      if (signal.aborted) return;

      // Phase 3: place the variations back-to-back on a new audio track.
      await update("Creating clips…", 90);
      const loopBeats = params.loopBars * 4;
      const outTrack = await song.createAudioTrack();
      const clips = await Promise.all(
        context.withinTransaction(() =>
          importedPaths.map((filePath, v) =>
            outTrack.createAudioClip({
              filePath,
              startTime: selStart + v * loopBeats,
              isWarped: true,
              duration: loopBeats,
              loopSettings: {
                looping: true,
                startMarker: 0,
                endMarker: loopBeats,
                loopStart: 0,
                loopEnd: loopBeats,
              },
            }),
          ),
        ),
      );
      outTrack.name = "Loooprr";
      clips.forEach((clip, v) => {
        clip.name = `Loooprr v${v + 1} (seed ${params.seed})`;
      });

      await update("Done", 100);
    },
  );
}

export function activate(activation: ActivationContext) {
  const context = initialize(activation, "1.0.0");

  context.commands.registerCommand("loooprr.create", (arg: unknown) => {
    void runCollage(context, arg as ArrangementSelection).catch((e) =>
      console.error("Loooprr:", e),
    );
  });

  void context.ui.registerContextMenuAction(
    "AudioTrack.ArrangementSelection",
    "Create Random Loop…",
    "loooprr.create",
  );
}

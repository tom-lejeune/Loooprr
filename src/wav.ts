/**
 * Minimal 24-bit PCM WAV encoder (RIFF / WAVE, format code 1).
 * Pure — returns bytes; the caller writes them to disk.
 */

import type { AudioBuffers } from "./dsp.js";

/** Encode channels (one Float32Array each, equal length) as a 24-bit PCM WAV. */
export function encodeWav24(buffers: AudioBuffers): Uint8Array {
  const { channels, sampleRate } = buffers;
  const numChannels = channels.length;
  const numFrames = channels[0]?.length ?? 0;
  const bytesPerSample = 3;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataBytes = numFrames * blockAlign;

  // RIFF(4)+size(4) + "WAVE"(4) + fmt chunk(8+16) + data chunk(8+dataBytes)
  const headerBytes = 12 + 24 + 8;
  const buffer = new ArrayBuffer(headerBytes + dataBytes);
  const view = new DataView(buffer);
  let p = 0;

  const writeStr = (s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(p++, s.charCodeAt(i));
  };
  const u32 = (v: number) => { view.setUint32(p, v, true); p += 4; };
  const u16 = (v: number) => { view.setUint16(p, v, true); p += 2; };

  writeStr("RIFF");
  u32(headerBytes - 8 + dataBytes);
  writeStr("WAVE");

  writeStr("fmt ");
  u32(16);
  u16(1); // PCM
  u16(numChannels);
  u32(sampleRate);
  u32(byteRate);
  u16(blockAlign);
  u16(24);

  writeStr("data");
  u32(dataBytes);
  const MAX = 8388607; // 2^23 - 1
  for (let i = 0; i < numFrames; i++) {
    for (let c = 0; c < numChannels; c++) {
      const clamped = Math.max(-1, Math.min(1, channels[c]![i]!));
      const s = Math.round(clamped * MAX) | 0;
      view.setUint8(p++, s & 0xff);
      view.setUint8(p++, (s >> 8) & 0xff);
      view.setUint8(p++, (s >> 16) & 0xff);
    }
  }

  return new Uint8Array(buffer);
}

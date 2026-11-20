/**
 * src/speech/benchmarkClip.js — the reference clip the benchmark measures.
 *
 * The engine's benchmark harness needs BOTH audio and a hand-verified
 * transcript. The panel used to call `speech.benchmark({ modelId })` with no
 * clip, so every run correctly answered "no reference clip" and no model could
 * ever be compared. This module loads the committed 6.3 s John 10:10 clip,
 * strips its WAV header, and returns base64 PCM for the IPC boundary.
 *
 * Base64, not an ArrayBuffer: Electron's structured clone would carry a
 * Uint8Array, but JSON.stringify turns it into an object with numeric keys.
 * A string survives both hops and the engine's pcmBuffer() accepts it.
 */

export const BENCHMARK_CLIP_URL = '/benchmark/voice-smoke-16k.wav';
export const BENCHMARK_TRANSCRIPT =
  'The thief comes only to steal and kill and destroy. I came that they may have life, and have it abundantly.';
export const BENCHMARK_SAMPLE_RATE = 16000;

/** Parse a canonical PCM WAV and return the data chunk only. */
export function pcmFromWav(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.length < 44 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF' ||
      String.fromCharCode(...bytes.subarray(8, 12)) !== 'WAVE') {
    throw new Error('benchmark clip is not a RIFF/WAVE file');
  }
  const view = new DataView(arrayBuffer);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (id === 'fmt ') {
      const format = view.getUint16(start, true);
      const channels = view.getUint16(start + 2, true);
      const rate = view.getUint32(start + 4, true);
      const bits = view.getUint16(start + 14, true);
      if (format !== 1 || channels !== 1 || rate !== BENCHMARK_SAMPLE_RATE || bits !== 16) {
        throw new Error('benchmark clip must be 16 kHz mono 16-bit PCM');
      }
    }
    if (id === 'data') return bytes.subarray(start, Math.min(start + size, bytes.length));
    offset = start + size + (size % 2);
  }
  throw new Error('benchmark clip has no data chunk');
}

/** Browser-safe base64 for a Uint8Array, in chunks small enough for apply(). */
export function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

let cached = null;

/** Fetch and decode the committed benchmark clip once per renderer. */
export async function loadBenchmarkClip(fetchImpl = fetch) {
  if (cached) return cached;
  const response = await fetchImpl(BENCHMARK_CLIP_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error(`benchmark clip HTTP ${response.status}`);
  const pcm = pcmFromWav(await response.arrayBuffer());
  cached = {
    pcm: bytesToBase64(pcm),
    transcript: BENCHMARK_TRANSCRIPT,
    sampleRate: BENCHMARK_SAMPLE_RATE,
  };
  return cached;
}

/** Test/teardown reset; production never needs this. */
export function resetBenchmarkClipCache() {
  cached = null;
}

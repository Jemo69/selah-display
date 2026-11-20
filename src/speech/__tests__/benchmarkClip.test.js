import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  BENCHMARK_TRANSCRIPT,
  pcmFromWav,
  bytesToBase64,
  loadBenchmarkClip,
  resetBenchmarkClipCache,
} from '../benchmarkClip.js';

const WAV = readFileSync(path.join(process.cwd(), 'speech-engine/test/fixtures/voice-smoke-16k.wav'));
const arrayBuffer = () => WAV.buffer.slice(WAV.byteOffset, WAV.byteOffset + WAV.byteLength);

describe('benchmark reference clip', () => {
  beforeEach(() => resetBenchmarkClipCache());

  it('strips the WAV header and keeps 16 kHz mono PCM', () => {
    const pcm = pcmFromWav(arrayBuffer());
    expect(pcm.length).toBeGreaterThan(100_000);
    expect(WAV.length - pcm.length).toBeGreaterThanOrEqual(44);
    expect(pcm.length % 2).toBe(0);
  });

  it('round-trips the PCM through base64', () => {
    const pcm = pcmFromWav(arrayBuffer());
    const decoded = Uint8Array.from(atob(bytesToBase64(pcm)), (c) => c.charCodeAt(0));
    expect(decoded).toEqual(pcm);
  });

  it('loads the clip with the hand-verified transcript', async () => {
    const clip = await loadBenchmarkClip(async () => ({
      ok: true,
      arrayBuffer: async () => arrayBuffer(),
    }));
    expect(clip.sampleRate).toBe(16000);
    expect(clip.transcript).toBe(BENCHMARK_TRANSCRIPT);
    expect(typeof clip.pcm).toBe('string');
    expect(clip.pcm.length).toBeGreaterThan(1000);
  });
});

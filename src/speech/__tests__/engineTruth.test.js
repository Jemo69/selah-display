// src/speech/__tests__/engineTruth.test.js
//
// The engine that ships in this PR is `speech-engine/fakeEngine.js`: a
// contract-conformant stand-in that IGNORES the audio bytes and replays a
// canned sentence, because the native whisper.cpp binding does not exist yet.
//
// These tests exist because that fact was previously invisible in the UI. The
// `backend: 'fake'` field travelled all the way from the engine to the
// renderer (`speech:health`) and was read nowhere, so the app showed a green
// ON badge, "Local · large-v3" and a "Listening" chip next to output the engine
// had written itself — and `large-v3` advertises `wordTimestamps` and
// `biasSupport`, which enables all three suggestion lanes, so a stray tap could
// have put canned text on the sanctuary screens.
//
// The rule being pinned: canned output may never look like transcription.

import { describe, it, expect } from 'vitest';
import {
  FAKE_BACKEND,
  CANNED_BACKENDS,
  isCannedEngine,
  isRealEngine,
  cannedEngineLabel,
  engineModeLabel,
} from '../engineTruth.js';

describe('engineTruth: telling a fake engine from a real one', () => {
  describe('isCannedEngine', () => {
    it('is TRUE for the backend the shipped fake engine reports', () => {
      // Exactly what fakeEngine.js health() returns.
      expect(isCannedEngine({ backend: FAKE_BACKEND })).toBe(true);
    });

    it('is TRUE for a fuller health payload, since the field rides along', () => {
      expect(
        isCannedEngine({
          apiVersion: 1,
          model: 'large-v3',
          backend: 'fake',
          rtf: 0.42,
          memoryMb: 512,
          pid: 4242,
          uptime: 3.5,
        })
      ).toBe(true);
    });

    it('is FALSE for a real backend', () => {
      expect(isCannedEngine({ backend: 'whispercpp' })).toBe(false);
      expect(isCannedEngine({ backend: 'whisper.cpp' })).toBe(false);
    });

    it('is FALSE — not TRUE — for absent, unknown, or malformed health', () => {
      // Failing closed on `backend === 'unknown'` would disable a future real
      // engine the moment it reported a name this file has not heard of. The
      // only canned engine this codebase ships is named `fake`.
      expect(isCannedEngine(null)).toBe(false);
      expect(isCannedEngine(undefined)).toBe(false);
      expect(isCannedEngine({})).toBe(false);
      expect(isCannedEngine({ backend: null })).toBe(false);
      expect(isCannedEngine({ backend: '' })).toBe(false);
      expect(isCannedEngine({ backend: 'unknown' })).toBe(false);
      expect(isCannedEngine('fake')).toBe(false);
      expect(isCannedEngine(42)).toBe(false);
    });

    it('matches the backend name exactly, not by substring', () => {
      // A substring test would be defeated by a backend called "fake-v2"...
      // but more importantly this pins that we are NOT doing substring matching:
      // only the known enum values count, so an unexpected name cannot be
      // silently classified either way by accident.
      expect(isCannedEngine({ backend: 'fake-v2' })).toBe(false);
      expect(isCannedEngine({ backend: 'Faker' })).toBe(false);
      expect(isCannedEngine({ backend: 'notfake' })).toBe(false);
      // ...while the real thing still matches.
      expect(isCannedEngine({ backend: 'fake' })).toBe(true);
    });

    it('reads CANNED_BACKENDS as an immutable list of the known values', () => {
      expect(CANNED_BACKENDS).toEqual(['fake']);
      expect(Object.isFrozen(CANNED_BACKENDS)).toBe(true);
      // Widening the list must not be possible from a consumer. This is a real
      // hazard, not a hypothetical: CANNED_BACKENDS was originally a Set, and
      // Object.freeze does NOT stop Set.prototype.add — a `.add('whispercpp')`
      // succeeded and silently relabelled the real engine as canned for every
      // later caller in the process.
      expect(() => {
        CANNED_BACKENDS.push('whispercpp');
      }).toThrow();
      // And the classification must be unaffected after the attempt.
      expect(isCannedEngine({ backend: 'whispercpp' })).toBe(false);
      expect(isCannedEngine({ backend: 'fake' })).toBe(true);
    });
  });

  describe('isRealEngine', () => {
    it('is the exact inverse of isCannedEngine', () => {
      const samples = [
        null,
        undefined,
        {},
        { backend: 'fake' },
        { backend: 'whispercpp' },
        { backend: 'unknown' },
        { backend: null },
      ];
      for (const sample of samples) {
        expect(isRealEngine(sample)).toBe(!isCannedEngine(sample));
      }
    });

    it('is TRUE for a real engine and FALSE for the fake one', () => {
      expect(isRealEngine({ backend: 'whispercpp' })).toBe(true);
      expect(isRealEngine({ backend: 'fake' })).toBe(false);
    });
  });

  describe('cannedEngineLabel', () => {
    it('says plainly that the text is canned and not a transcription', () => {
      const label = cannedEngineLabel();
      expect(label).toMatch(/canned/i);
      expect(label).toMatch(/not real transcription/i);
      expect(label).toMatch(/TEST/i);
    });
  });

  describe('engineModeLabel', () => {
    it('reports the configured mode when no engine has reported yet', () => {
      expect(engineModeLabel({ where: 'local', modelId: 'large-v3' })).toBe('Local · large-v3');
      expect(engineModeLabel({ where: 'local', modelId: 'large-v3', health: null })).toBe(
        'Local · large-v3'
      );
    });

    it('never shows a bare model id while a canned engine is behind it', () => {
      const label = engineModeLabel({
        where: 'local',
        modelId: 'large-v3',
        health: { backend: 'fake' },
      });
      // The caveat must LEAD, so the operator reads the truth first.
      expect(label.startsWith('TEST')).toBe(true);
      expect(label).toMatch(/canned/i);
      // The configured mode is still reported — it is just no longer alone.
      expect(label).toContain('Local · large-v3');
    });

    it('leaves a real engine label untouched', () => {
      expect(
        engineModeLabel({
          where: 'local',
          modelId: 'large-v3',
          health: { backend: 'whispercpp' },
        })
      ).toBe('Local · large-v3');
    });

    it('reports the model the real engine actually loaded, not the one configured', () => {
      expect(
        engineModeLabel({
          where: 'local',
          modelId: 'large-v3',
          health: { backend: 'whispercpp', model: 'tiny.en' },
        })
      ).toBe('Local · tiny.en');
    });

    it('applies the same rule to every mode, not just local', () => {
      // where is a configuration choice, not proof of a remote engine.
      expect(engineModeLabel({ where: 'network' })).toBe('Network · not connected');
      expect(engineModeLabel({ where: 'network', health: { backend: 'fake' } })).toMatch(/canned/i);
      expect(
        engineModeLabel({
          where: 'network',
          health: { remote: true, status: 'ok', backend: 'whispercpp', model: 'tiny.en' },
        })
      ).toBe('Remote engine · tiny.en');
      // A stale local health payload must never make network mode look remote.
      expect(
        engineModeLabel({ where: 'network', health: { status: 'ok', backend: 'whispercpp' } })
      ).toBe('Network · not connected');

      expect(engineModeLabel({ where: 'cloud' })).toBe('Cloud · not configured');
      expect(
        engineModeLabel({
          where: 'cloud',
          cloudProviderId: 'deepgram',
          health: { backend: 'fake' },
        })
      ).toMatch(/canned/i);
      expect(
        engineModeLabel({ where: 'cloud', cloudProviderId: 'deepgram', health: { backend: 'whispercpp' } })
      ).toBe('Cloud · deepgram');
    });

    it('does not throw on an empty call', () => {
      expect(() => engineModeLabel()).not.toThrow();
      expect(engineModeLabel({})).toBe('Cloud · not configured');
    });
  });
});
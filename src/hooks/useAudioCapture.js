/**
 * useAudioCapture.js — arm / mute / stop / teardown for Live Sermon Assist.
 *
 * INVARIANT: nothing in this file opens a microphone until arm() (or the
 * explicit runSelfTest()) is called by a user action. Auto-arm on mount is
 * FORBIDDEN: no effect here ever touches getUserMedia, AudioContext, or the
 * AudioWorklet. And arm() refuses to run while the store's master switch is
 * off — capture must never arm while the feature is disabled.
 *
 * Teardown is the load-bearing part: a stuck mic after the window closes is
 * the kind of bug that loses a church's trust permanently. pagehide,
 * beforeunload and visibilitychange all tear down, unmount tears down, and
 * turning the feature off tears down — every listener registered here is
 * removed in cleanup.
 *
 * Nothing captured here leaves the renderer over any channel but
 * ONE: the engine transport (src/speech/engineTransport.js) —
 * the raw ws://127.0.0.1 PCM stream to the engine (plan
 * section 3). The optional onFrame callback sees every frame
 * too, but nothing else does.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import useSpeechStore from '../context/SpeechStore';
import { useAudioDevices } from './useAudioDevices';
import { loadPcmWorklet, createCaptureGraph } from '../workers/pcmCapture';
import { getEngineTransport } from '../speech/engineTransport';
import { diagInfo } from '../utils/diagnosticsLog';

/** The app-wide engine transport: one engine session, one socket. */
const engineTransport = getEngineTransport();

/** Smoothing for the VU meter: fast attack, slow release. */
const LEVEL_ATTACK = 0.4;
const LEVEL_RELEASE = 0.15;

/** How long stop() waits for the flushed tail frame to round-trip back. */
const FLUSH_SETTLE_MS = 25;

const describeError = (err, fallback) => {
  if (!err) return fallback;
  if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
    return 'Microphone access was denied. Enable it in your system settings, then retry.';
  }
  if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
    return 'No microphone was found on this computer. Connect an input, then retry.';
  }
  // The device was in the list a moment ago and is not now — unplugged, or
  // claimed by another application between enumeration and open. Without this
  // case the operator gets Chromium's internal string
  // (`deviceId "…" is not a known device`) instead of something actionable.
  if (err.name === 'OverconstrainedError' || err.name === 'ConstraintNotSatisfiedError') {
    return 'That audio input is no longer available. Pick another source, then test again.';
  }
  return err.message || fallback;
};

/**
 * Resolve a stored (or requested) deviceId against a LIVE enumeration.
 *
 * Returns the id only when that device is actually present, and null
 * otherwise. Null means "let Chromium choose", and three different situations
 * collapse to it on purpose:
 *   1. no source has ever been chosen,
 *   2. the operator explicitly chose the system default,
 *   3. the remembered device is no longer connected.
 *
 * Case 3 is the one that bites, and it bites SILENTLY in the other direction:
 * `deviceId: { exact: '<gone-id>' }` does NOT fall back in Chromium. It throws
 * OverconstrainedError and the whole session fails — so every path that opens
 * a device must ask this question instead of trusting the id sitting in the
 * store. The store deliberately keeps that id when a device disappears, so
 * that replugging it restores the choice without the operator re-picking.
 *
 * Keeping this in ONE function is the point. `arm()` asked the question and
 * the self-test did not, so "Test this source" failed on exactly the case the
 * picker had just described in plain English.
 *
 * @param {Array<{deviceId: string}>|undefined} enumerated list from a fresh enumeration
 * @param {string|null|undefined} wantedId id from the store or a caller
 * @returns {string|null} the id to constrain to, or null for the default
 */
const resolveDeviceId = (enumerated, wantedId) => {
  if (!wantedId) return null;
  const list = Array.isArray(enumerated) ? enumerated : [];
  return list.some((device) => device && device.deviceId === wantedId) ? wantedId : null;
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{onFrame?: Function, onMeter?: Function,
 *          devices?: ReturnType<typeof useAudioDevices>}} [options]
 *   onFrame — receives { pcm, samples, rms, peak, clipped } per 100 ms frame.
 *             Never forwarded anywhere else (Phase 2 wires the transport).
 *   devices — optional shared useAudioDevices instance (the picker passes
 *             its own so arming does not re-run the permission probe).
 */
export function useAudioCapture(options = {}) {
  const { onFrame, onMeter, devices: externalDevices } = options;

  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;
  const onMeterRef = useRef(onMeter);
  onMeterRef.current = onMeter;

  // Always call the hook (rules of hooks); when an external instance is
  // provided this internal one simply stays cold at 'idle' forever.
  const internalDevices = useAudioDevices();
  const devicesApi = externalDevices || internalDevices;
  const devicesRef = useRef(devicesApi);
  devicesRef.current = devicesApi;

  const [level, setLevel] = useState(0);
  const [clipped, setClipped] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [muted, setMuted] = useState(false);

  // Exactly one capture session at a time: arming stops any self-test, and
  // a self-test is refused while armed. One stream/context/graph triple
  // means one teardown path to get right.
  const streamRef = useRef(null);
  const contextRef = useRef(null);
  const graphRef = useRef(null);
  const busyRef = useRef(false);
  const capturingRef = useRef(false);
  const testingRef = useRef(false);
  const testTimerRef = useRef(null);
  const teardownRef = useRef(() => {});

  // -----------------------------------------------------------------
  // The engine transport (plan section 3): ONE bridge
  // (src/speech/engineTransport.js) owns the whole engine
  // session — it invokes speech:start with the store's model
  // context, dials the renderer's own WebSocket from the
  // reply, and invokes speech:stop on teardown, guarded so it
  // never fires while the engine is already off. Without a
  // preload bridge (a test, a browser build) it reports the
  // non-fatal 'no-speech-bridge' reason and capture simply
  // runs engine-less, exactly as before.
  // -----------------------------------------------------------------

  /**
   * The ONE engine start path. Never throws: every failure
   * mode is an { ok:false } the caller fails the arm with.
   */
  const startEngine = async () => {
    const { modelId, providerId, where, engineMode, cloudProviderId, cloudModelId } = useSpeechStore.getState();
    const result = await engineTransport.start({
      enabled: true,
      modelId,
      providerId,
      where,
      engineMode,
      // Main validates this BEFORE forking: an unwired cloud provider must
      // never quietly become a local whisper run under a cloud label.
      cloudProviderId,
      // A provider-specific model id; main validates it before the fork.
      cloudModelId,
    });
    if (result.ok) return { ok: true };
    if (result.reason === 'no-speech-bridge') {
      // No preload bridge: capture runs engine-less. Not a
      // failure — a browser build or a unit test.
      return { ok: true, reason: 'no-bridge' };
    }
    // Prefer main's error detail: a refused probe already broadcast the
    // actionable remedy on speech:error (e.g. the VC++ download link), and
    // the transport forwards it as result.error. Rebuilding a generic
    // sentence here would clobber it in arm() below.
    const detail =
      result?.error && typeof result.error.message === 'string' && result.error.message
        ? result.error.message
        : null;
    return {
      ok: false,
      reason: 'engine-start-failed',
      error: result?.error,
      message:
        detail ??
        ('The speech engine did not start, so Sermon Assist cannot listen. ' +
          `Reason: ${result.reason ?? 'unknown'}.`),
    };
  };

  /**
   * The ONE engine stop path. The transport closes the socket
   * synchronously and invokes speech:stop exactly once per
   * start (its own guard), so whichever teardown path lands
   * last — unmount, pagehide, the feature switch — never
   * fires it twice. Never throws.
   */
  const stopEngine = () => {
    void engineTransport.stop();
  };

  const clearTestTimer = useCallback(() => {
    if (testTimerRef.current !== null) {
      clearTimeout(testTimerRef.current);
      testTimerRef.current = null;
    }
  }, []);

  /** Idempotent release of every audio resource. Synchronous on purpose so
   *  pagehide teardown does not depend on a promise resolving. Setters are
   *  unconditional (React bails out on identical values) so every historical
   *  closure of this function behaves identically. */
  const releaseAll = useCallback(() => {
    clearTestTimer();

    if (graphRef.current) {
      try {
        graphRef.current.destroy();
      } catch {
        /* already gone */
      }
      graphRef.current = null;
    }

    const stream = streamRef.current;
    streamRef.current = null;
    if (stream && typeof stream.getTracks === 'function') {
      for (const track of stream.getTracks()) {
        try {
          track.stop();
        } catch {
          /* track already ended */
        }
      }
    }

    const context = contextRef.current;
    contextRef.current = null;
    if (context && context.state !== 'closed' && typeof context.close === 'function') {
      try {
        const closing = context.close();
        if (closing && typeof closing.catch === 'function') closing.catch(() => {});
      } catch {
        /* context already closed */
      }
    }

    capturingRef.current = false;
    testingRef.current = false;
    setCapturing(false);
    setTesting(false);
    setMuted(false);
    setLevel(0);
    setClipped(false);
  }, [clearTestTimer]);

  /** Meters arrive from the worklet (~32 ms cadence); smooth for the VU. */
  const handleMeter = useCallback((meter) => {
    const rms = Math.min(1, Math.max(0, Number(meter?.rms) || 0));
    setLevel((prev) => (rms > prev ? prev + (rms - prev) * LEVEL_ATTACK : prev + (rms - prev) * LEVEL_RELEASE));
    setClipped(meter?.clipped === true);
  }, []);

  /** Stop the capture session (or self-test) without touching `enabled`. */
  const teardown = useCallback(() => {
    releaseAll();
    const store = useSpeechStore.getState();
    store.setStatus('idle');
    // The engine stops with the mic — guarded, so teardown
    // never fires speech:stop while the engine is already off.
    stopEngine();
  }, [releaseAll]);
  teardownRef.current = teardown;

  /**
   * Open the mic and start producing frames.
   * Returns {ok:true} or {ok:false, reason} — never throws.
   */
  const arm = useCallback(async () => {
    const store = useSpeechStore.getState();
    // THE GUARANTEE: no microphone access while the feature is off. Checked
    // before anything else — not even a permission prompt may fire.
    if (store.enabled !== true) return { ok: false, reason: 'disabled' };
    if (busyRef.current) return { ok: false, reason: 'busy' };
    if (capturingRef.current) return { ok: true, reason: 'already-armed' };

    busyRef.current = true;
    const armStartedAt = Date.now();
    let armOutcome = 'unknown';
    store.setStatus('starting');
    try {
      // Self-test holds the single session slot; give it up first.
      releaseAll();

      const permission = await devicesRef.current.requestPermission();
      if (!permission.ok) {
        const current = useSpeechStore.getState();
        current.setLastError(
          permission.reason === 'denied'
            ? 'Microphone access was denied. Enable it in your system settings, then retry.'
            : 'Microphone permission could not be granted, so Sermon Assist cannot listen.'
        );
        current.setStatus('error');
        armOutcome = `permission:${permission.reason || 'unknown'}`;
        diagInfo('sermon-assist', 'microphone permission refused', {
          reason: permission.reason || 'unknown',
          durationMs: Date.now() - armStartedAt,
        });
        return { ok: false, reason: permission.reason || 'permission' };
      }

      // Open the remembered source by stable id; when it is missing we
      // intentionally omit deviceId so Chromium opens the system default —
      // the picker's fallbackNote tells the operator we did that.
      //
      // WHY permission.devices AND NOT devicesRef.current.devices.
      //
      // The obvious read is `devicesRef.current.devices`. It is wrong, and the
      // failure is silent: `requestPermission()` enumerates the devices, but
      // enumeration lands in React STATE, and state only reaches the ref on the
      // next render. This line runs immediately after the await, before React
      // has re-rendered, so the ref still holds the pre-enumeration array —
      // which is `[]` on a fresh mount, every time.
      //
      // The `find` therefore returns undefined, `remembered` is falsy, the
      // deviceId constraint is never applied, and the stream opens on Chromium's
      // system default. The operator picked a USB interface because the laptop's
      // built-in mic is the wrong one; the picker still shows the correct
      // remembered label (the STORE is right), so the UI and the microphone
      // disagree and the only symptom is transcription that sounds like a bad
      // model.
      //
      // So the enumerated list comes back FROM the call that enumerated it. One
      // source of truth, and it cannot be stale by a render tick.
      const rememberedId = useSpeechStore.getState().audio.sourceId;
      const resolvedDeviceId = resolveDeviceId(permission.devices, rememberedId);

      const constraints = {
        audio: {
          // This is a speech feed going to an ASR model: browser-side echo
          // cancellation, noise suppression and auto gain all reshape the
          // signal and make transcription worse. The sanctuary's real mic
          // chain already did the mixing; the model gets the raw feed.
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      };
      if (resolvedDeviceId) constraints.audio.deviceId = { exact: resolvedDeviceId };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;

      const AudioContextCtor =
        typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;
      if (!AudioContextCtor) {
        throw new Error('Web Audio is not available in this window, so the sermon microphone cannot be opened.');
      }
      // Ask for 16 kHz so no conversion is needed; if the browser refuses,
      // the worklet decimates down from whatever rate we get.
      const context = new AudioContextCtor({ sampleRate: 16000 });
      contextRef.current = context;

      await loadPcmWorklet(context);
      const sourceNode = context.createMediaStreamSource(stream);
      const graph = createCaptureGraph({
        audioContext: context,
        sourceNode,
        onFrame: (frame) => {
          // The same frame, to the engine first: raw PCM, back to
          // back, no envelope (the transport queues while the
          // socket opens and drops beyond its bound — hand it
          // over before anything else can hold the tick).
          if (frame && frame.pcm) engineTransport.send(frame.pcm);
          if (typeof onFrameRef.current === 'function') onFrameRef.current(frame);
        },
        onMeter: (meter) => {
          handleMeter(meter);
          if (typeof onMeterRef.current === 'function') onMeterRef.current(meter);
        },
      });
      graphRef.current = graph;

      capturingRef.current = true;
      setCapturing(true);

      // The engine: the ONE start path (speech:start), then
      // the renderer's own WebSocket dial-in (plan section 3).
      // A failed start is a fail-soft boundary — the microphone
      // is released, the engine (if it came up) is stopped,
      // ONE clear error surfaces, nothing throws.
      const engine = await startEngine();
      if (!engine.ok) {
        releaseAll();
        // The transport owes a speech:stop only when its own
        // start succeeded; otherwise this is a no-op.
        stopEngine();
        const current = useSpeechStore.getState();
        current.setLastError(engine.message);
        current.setStatus('error');
        armOutcome = `engine-failed:${engine.reason}`;
        return { ok: false, reason: engine.reason };
      }

      useSpeechStore.getState().setStatus('listening');
      armOutcome = 'listening';
      return { ok: true, sampleRate: context.sampleRate };
    } catch (err) {
      releaseAll();
      const message = describeError(err, 'Could not open the microphone.');
      const current = useSpeechStore.getState();
      current.setLastError(message);
      current.setStatus('error');
      armOutcome = 'threw';
      return { ok: false, reason: 'error', error: message };
    } finally {
      busyRef.current = false;
      diagInfo('sermon-assist', 'capture arm settled', {
        outcome: armOutcome,
        durationMs: Date.now() - armStartedAt,
      });
    }
  }, [handleMeter, releaseAll]);

  /** Suspend the context: no process() calls, so no frames — mic stays open. */
  const mute = useCallback(async () => {
    const context = contextRef.current;
    if (!context || context.state === 'closed') return { ok: false, reason: 'not-capturing' };
    try {
      if (context.state === 'running') await context.suspend();
      setMuted(true);
      setLevel(0);
      setClipped(false);
      return { ok: true };
    } catch (err) {
      const message = describeError(err, 'Could not mute the microphone.');
      useSpeechStore.getState().setLastError(message);
      useSpeechStore.getState().setStatus('error');
      return { ok: false, reason: 'error', error: message };
    }
  }, []);

  const unmute = useCallback(async () => {
    const context = contextRef.current;
    if (!context || context.state === 'closed') return { ok: false, reason: 'not-capturing' };
    try {
      if (context.state === 'suspended') await context.resume();
      setMuted(false);
      return { ok: true };
    } catch (err) {
      const message = describeError(err, 'Could not resume the microphone.');
      useSpeechStore.getState().setLastError(message);
      useSpeechStore.getState().setStatus('error');
      return { ok: false, reason: 'error', error: message };
    }
  }, []);

  /**
   * Stop capturing: flush the pending partial frame first (so stopping
   * mid-sentence does not truncate the last word), then release everything.
   */
  const stop = useCallback(async () => {
    const wasActive = !!(graphRef.current || streamRef.current);
    if (graphRef.current) {
      try {
        graphRef.current.flush();
        await delay(FLUSH_SETTLE_MS);
      } catch {
        /* worklet already gone */
      }
    }
    teardownRef.current();
    return { ok: true, wasActive };
  }, []);

  /**
   * Three seconds of level metering WITHOUT arming transcription: opens the
   * device, reports meters to the VU state, and auto-releases at 3000 ms —
   * so the operator can find a working input before the service rather than
   * during it. Store status is untouched (nothing is listening); only the
   * device is briefly open.
   */
  const runSelfTest = useCallback(
    async (deviceId, opts = {}) => {
      const durationMs = Number.isFinite(opts.durationMs) ? opts.durationMs : 3000;
      const store = useSpeechStore.getState();
      if (store.enabled !== true) return { ok: false, reason: 'disabled' };
      if (busyRef.current) return { ok: false, reason: 'busy' };
      if (capturingRef.current) return { ok: false, reason: 'capturing' };
      if (testingRef.current) return { ok: true, reason: 'already-testing' };

      busyRef.current = true;
      try {
        releaseAll();

        // Re-enumerate before opening, and resolve the requested id against
        // THAT list — the same question arm() asks, through the same helper.
        //
        // This is the half of the microphone bug that was still open. The
        // operator unplugs the interface; the picker correctly says "Remembered
        // input … is no longer connected — using the system default"; they press
        // Test this source to check what they now have. Constraining to the
        // absent id threw OverconstrainedError, left the meter dead, and flipped
        // the engine to 'error' — so a stale selection read as a broken feature.
        //
        // `refresh()` is the enumerate-only-while-permitted path, and it is a
        // no-op until permission has been granted, which matches when this
        // button is actually reachable. It also re-runs the missing-device
        // resolution, so the sentence above the meter and the device under it
        // cannot disagree.
        const fresh = await devicesRef.current.refresh();
        const resolvedDeviceId = resolveDeviceId(fresh.ok ? fresh.devices : [], deviceId);
        const constraints = {
          audio: {
            // Same rationale as arm(): raw feed, no browser processing.
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          },
        };
        if (resolvedDeviceId) constraints.audio.deviceId = { exact: resolvedDeviceId };

        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        streamRef.current = stream;

        const AudioContextCtor =
          typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;
        if (!AudioContextCtor) {
          throw new Error('Web Audio is not available in this window, so the input cannot be tested.');
        }
        const context = new AudioContextCtor({ sampleRate: 16000 });
        contextRef.current = context;
        await loadPcmWorklet(context);
        const sourceNode = context.createMediaStreamSource(stream);
        const graph = createCaptureGraph({
          audioContext: context,
          sourceNode,
          onMeter: handleMeter,
        });
        graphRef.current = graph;

        testingRef.current = true;
        setTesting(true);
        testTimerRef.current = setTimeout(() => {
          testTimerRef.current = null;
          // Auto-stop: release synchronously so fake-timer tests (and the
          // real 3-second deadline) never leave the device open.
          releaseAll();
        }, durationMs);
        return { ok: true, durationMs };
      } catch (err) {
        releaseAll();
        const message = describeError(err, 'Could not test this input.');
        const current = useSpeechStore.getState();
        current.setLastError(message);
        current.setStatus('error');
        return { ok: false, reason: 'error', error: message };
      } finally {
        busyRef.current = false;
      }
    },
    [handleMeter, releaseAll]
  );

  const stopSelfTest = useCallback(() => {
    if (!testingRef.current && !graphRef.current) return { ok: false, reason: 'not-testing' };
    releaseAll();
    return { ok: true };
  }, [releaseAll]);

  /** Live MediaStreamTracks under our control right now (0 = mic is free). */
  const getLiveTrackCount = useCallback(() => {
    const stream = streamRef.current;
    if (!stream || typeof stream.getTracks !== 'function') return 0;
    return stream.getTracks().filter((track) => track.readyState === 'live').length;
  }, []);

  // Window-lifecycle teardown. Registered once per mount, removed in
  // cleanup, and unmount itself tears down — a hidden or closing window
  // must never keep a hot mic.
  useEffect(() => {
    const onPageHide = () => teardownRef.current();
    const onBeforeUnload = () => teardownRef.current();
    const onVisibilityChange = () => {
      if (typeof document !== 'undefined' && document.hidden) teardownRef.current();
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      // Unmount must never leave a hot mic behind.
      teardownRef.current();
    };
  }, []);

  // Master switch turned off while a session was open → release it. We only
  // ever read `enabled`; capture code must never flip it.
  const enabled = useSpeechStore((state) => state.enabled);
  useEffect(() => {
    if (enabled === false && (capturingRef.current || testingRef.current || streamRef.current)) {
      teardownRef.current();
    }
  }, [enabled]);

  return {
    arm,
    mute,
    unmute,
    stop,
    teardown,
    runSelfTest,
    stopSelfTest,
    getLiveTrackCount,
    level,
    clipped,
    capturing,
    testing,
    muted,
    devices: devicesApi,
  };
}

export default useAudioCapture;

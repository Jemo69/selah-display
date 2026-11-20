// src/hooks/__tests__/useSpeechRuntime.subscriptions.test.jsx
//
// The engine can refuse a segment without ending the service: a
// low-confidence OS recognition is a non-fatal error, and the next confident
// final should clear it. This pins both halves of that cycle through the real
// subscription hook, not a mocked store.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useSpeechRuntime } from '../useSpeechRuntime';
import useSpeechStore from '../../context/SpeechStore';
import useSpeechRuntimeStore from '../../context/SpeechRuntimeStore';

let transcriptListener = null;
let errorListener = null;
let originalBridge;

beforeEach(() => {
  originalBridge = window.electronAPI;
  transcriptListener = null;
  errorListener = null;
  window.electronAPI = {
    speech: {
      onTranscript: (listener) => {
        transcriptListener = listener;
        return () => { transcriptListener = null; };
      },
      onError: (listener) => {
        errorListener = listener;
        return () => { errorListener = null; };
      },
    },
  };
  useSpeechStore.setState({ lastError: null, status: 'listening' });
  useSpeechRuntimeStore.getState().reset();
});

afterEach(() => {
  window.electronAPI = originalBridge;
  useSpeechRuntimeStore.getState().reset();
});

describe('useSpeechRuntime engine-error lifecycle', () => {
  it('surfaces a low-confidence error, then a later final clears it', () => {
    const { unmount } = renderHook(() => useSpeechRuntime(true));
    expect(transcriptListener).toBeTypeOf('function');
    expect(errorListener).toBeTypeOf('function');

    act(() => {
      errorListener({
        code: 'low-confidence',
        message: 'The OS recognizer was not confident enough to offer a transcript.',
        fatal: false,
      });
    });
    expect(useSpeechStore.getState().lastError).toMatch(/not confident/i);
    expect(useSpeechStore.getState().status).toBe('listening');

    act(() => {
      transcriptListener({
        t: 'final',
        sessionId: 's',
        text: 'amen',
        tStartMs: 0,
        tEndMs: 1000,
      });
    });
    expect(useSpeechStore.getState().lastError).toBeNull();
    expect(useSpeechRuntimeStore.getState().segments.at(-1)?.text).toBe('amen');

    unmount();
    expect(transcriptListener).toBeNull();
    expect(errorListener).toBeNull();
  });
});

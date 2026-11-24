import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

function createFakeSocket(id, clientType) {
  const handlers = new Map();
  return {
    id,
    userData: {
      clientType,
      deviceId: `device-${id}`,
      sessionId: 'test-session',
      permissions: [],
      connectedAt: Date.now(),
    },
    connected: true,
    emit: vi.fn(),
    on(event, callback) {
      const list = handlers.get(event) || [];
      list.push(callback);
      handlers.set(event, list);
    },
    trigger(event, payload) {
      (handlers.get(event) || []).forEach((handler) => handler(payload));
    },
  };
}

describe('stream output server state', () => {
  let connect;
  let events;
  let io;

  beforeEach(async () => {
    vi.resetModules();
    events = await import('../../server/events.js');
    io = new EventEmitter();
    io.emit = vi.fn();
    events.default(io, { hasPermission: () => true });
    connect = io.listeners('connection')[0];
  });

  it('round-trips stream band settings through styleUpdate and currentState', () => {
    const desktop = createFakeSocket('desktop', 'desktop');
    connect(desktop);

    desktop.trigger('styleUpdate', {
      output: 'stream',
      settings: {
        streamBandEnabled: true,
        streamBandHeightPercent: 50,
        streamBandBackdrop: 'solid',
        streamBandAutoFit: true,
      },
    });

    const styleBroadcast = io.emit.mock.calls.find(([event]) => event === 'styleUpdate');
    expect(styleBroadcast?.[1]).toMatchObject({ output: 'stream' });

    const state = events.buildCurrentState({ type: 'output1' });
    expect(state.streamSettings).toMatchObject({
      streamBandEnabled: true,
      streamBandHeightPercent: 50,
      streamBandBackdrop: 'solid',
    });
    expect(state).toHaveProperty('streamEnabled', true);
  });

  it('persists the stream toggle and settings in the session snapshot', async () => {
    const desktop = createFakeSocket('desktop', 'desktop');
    connect(desktop);

    desktop.trigger('individualOutputToggle', { output: 'stream', enabled: false });
    desktop.trigger('styleUpdate', {
      output: 'stream',
      settings: { streamBandHeightPercent: 75 },
    });

    const { createSessionSnapshot } = await import('../../server/sessionPersistence.js');
    const snapshot = createSessionSnapshot();
    expect(snapshot.streamEnabled).toBe(false);
    expect(snapshot.streamSettings).toMatchObject({ streamBandHeightPercent: 75 });
  });
});

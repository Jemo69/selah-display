/**
 * speech-engine/drivers/cloudOpenAI.js — the real OpenAI cloud driver.
 *
 * Same v1 engine contract as drivers/whispercpp.js:
 *   kind / backend / health() / models() / createSession() /
 *   closeSession() / hasSession() / transcribe() / close()
 *
 * The only difference is where the audio goes. `transcribe()` wraps the
 * session's PCM frames in a canonical 44-byte WAV, POSTs it as multipart
 * `file` to OpenAI's Audio Transcriptions endpoint with the model in the
 * form, and returns the JSON `text` as a contract `final` segment.
 *
 * Model choice: `whisper-1` is the default. It is the long-standing model on
 * this endpoint, with a stable `{ "text": "..." }` response and no
 * model-specific decorations to misparse. `gpt-4o-transcribe` is accepted as
 * an explicit opt-in (same endpoint, same JSON field) because it is the newer
 * accuracy option for accented speech. Unknown models are refused here —
 * guessing a model name in a sanctuary is how a silent failure looks like
 * success.
 *
 * SECURITY:
 *   - the API key is passed only in the Authorization header; it is never
 *     logged, emitted on the bus, or returned in health/session payloads;
 *   - audio is sent only to `endpoint` (the OpenAI URL by default), only when
 *     this driver was explicitly selected;
 *   - no error message contains the key, the WAV bytes, or the transcript;
 *   - `fetchImpl` is injectable so unit tests never touch the network.
 */
import { randomUUID } from 'node:crypto';
import { framesToWav } from './whispercpp.js';

export const CLOUD_PROVIDER = 'openai';
export const CLOUD_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';
export const CLOUD_MODELS = Object.freeze(['whisper-1', 'gpt-4o-transcribe']);
export const DEFAULT_CLOUD_MODEL = 'whisper-1';
const SAMPLE_RATE = 16000;
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Validate the cloud launch configuration. No silent fallback to a local
 * engine and no default provider: cloud without an explicit provider and key
 * is a configuration error.
 *
 * @returns {{provider:'openai', apiKey:string, model:string}}
 */
export function resolveCloudConfig({ provider, apiKey, model } = {}) {
  if (provider !== CLOUD_PROVIDER) {
    throw Object.assign(
      new Error('Only OpenAI cloud transcription is supported. Choose OpenAI in Settings.'),
      { code: 'cloud-provider-not-supported' }
    );
  }
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw Object.assign(
      new Error('An OpenAI API key is required for cloud transcription. Save one in Settings.'),
      { code: 'cloud-key-missing' }
    );
  }
  const resolvedModel = typeof model === 'string' && model.trim() ? model.trim() : DEFAULT_CLOUD_MODEL;
  if (!CLOUD_MODELS.includes(resolvedModel)) {
    throw Object.assign(new Error(`Unknown OpenAI transcription model "${resolvedModel}".`), {
      code: 'cloud-model-not-supported',
    });
  }
  return { provider: CLOUD_PROVIDER, apiKey: apiKey.trim(), model: resolvedModel };
}

/** HTTP status -> stable code + operator-facing sentence. Never a raw body. */
function mapProviderError(status) {
  if (status === 401 || status === 403) {
    return {
      code: 'cloud-auth-invalid',
      message: 'OpenAI rejected the API key. Save a valid key in Settings → Speech & AI → Cloud.',
    };
  }
  if (status === 429) {
    return {
      code: 'cloud-rate-limited',
      message: 'OpenAI is rate limiting transcription requests. Try again shortly.',
    };
  }
  if (status >= 500 || status === 408) {
    return {
      code: 'cloud-provider-unavailable',
      message: 'OpenAI transcription is temporarily unavailable.',
    };
  }
  return {
    code: 'cloud-request-failed',
    message: `OpenAI rejected the transcription request (HTTP ${status}).`,
  };
}

/** Contract `error` messages double as thrown error objects internally. */
const driverError = (code, message, extra = {}) => ({
  t: 'error',
  code,
  message,
  fatal: false,
  ...extra,
});

/**
 * @param {Object} options
 * @param {object} [options.bus] message bus (accepted for contract parity; the
 *   server/WS transport emits the returned messages, so this driver does not
 *   emit them a second time)
 * @param {string} options.apiKey
 * @param {string} [options.model]
 * @param {string|null} [options.language]
 * @param {Function} [options.fetchImpl] injectable fetch for tests
 * @param {string} [options.endpoint] override only for tests / enterprise proxies
 * @param {number} [options.timeoutMs]
 */
export function createCloudOpenAiEngine({
  bus,
  apiKey,
  model = DEFAULT_CLOUD_MODEL,
  language = null,
  fetchImpl,
  endpoint = CLOUD_ENDPOINT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const config = resolveCloudConfig({ provider: CLOUD_PROVIDER, apiKey, model });
  const sessions = new Map();
  const elapsed = new Map();
  let queue = Promise.resolve();
  let isClosed = false;
  // Resolved at call time so a test can stub globalThis.fetch without having
  // to pass fetchImpl everywhere.
  const doFetch = (...args) => (fetchImpl ?? globalThis.fetch)(...args);

  function createSessionInternal(options = {}) {
    const sessionId = randomUUID();
    const session = {
      sessionId,
      model: config.model,
      provider: CLOUD_PROVIDER,
      sampleRate: SAMPLE_RATE,
      language: options.language || language || 'auto',
    };
    sessions.set(sessionId, session);
    elapsed.set(sessionId, 0);
    return {
      session,
      messages: [{
        t: 'ready',
        sessionId,
        model: config.model,
        sampleRate: SAMPLE_RATE,
        provider: CLOUD_PROVIDER,
        wordTimestamps: false,
      }],
    };
  }

  /** POST one WAV, return only the string text. No logging on any path. */
  async function requestText(wav, sessionLanguage) {
    const form = new FormData();
    form.append('model', config.model);
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'segment.wav');
    if (typeof sessionLanguage === 'string' && sessionLanguage && sessionLanguage !== 'auto') {
      form.append('language', sessionLanguage);
    }

    let response;
    try {
      response = await doFetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw driverError(
        'cloud-network-error',
        'The transcription request could not reach OpenAI.'
      );
    }

    if (!response?.ok) {
      const { code, message } = mapProviderError(response?.status);
      throw driverError(code, message, { status: response?.status ?? null });
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw driverError(
        'cloud-bad-response',
        'OpenAI returned a response that could not be read as transcript JSON.'
      );
    }

    const text = payload?.text;
    if (typeof text !== 'string' || !text.trim()) {
      throw driverError(
        'cloud-bad-response',
        'OpenAI returned no transcript text for this segment.'
      );
    }
    return text.trim();
  }

  return {
    kind: 'cloud',
    backend: 'cloud-openai',
    model: config.model,

    health() {
      return {
        model: config.model,
        backend: 'cloud-openai',
        provider: CLOUD_PROVIDER,
        wordTimestamps: false,
        biasSupport: false,
        keyReady: true,
        // Cloud has no local binary or weights. These fields exist so the
        // health payload stays shape-compatible with the local drivers.
        binaryReady: true,
        weightsReady: true,
      };
    },

    models() {
      return [{
        id: config.model,
        name: config.model,
        provider: CLOUD_PROVIDER,
        installed: true,
      }];
    },

    createSession: createSessionInternal,

    closeSession(sessionId) {
      elapsed.delete(sessionId);
      return sessions.delete(sessionId);
    },

    hasSession(sessionId) {
      return sessions.has(sessionId);
    },

    close() {
      isClosed = true;
      sessions.clear();
      elapsed.clear();
    },

    /**
     * Transcribe one buffered segment. Requests are queued FIFO so cloud
     * billing and ordering stay predictable even if the WS transport hands
     * over two segments quickly.
     *
     * @param {{sessionId?: string, frames?: Array<Buffer|Uint8Array|string>}} body
     * @returns {Promise<{sessionId: string, messages: Array<object>}>}
     */
    transcribe(body = {}) {
      if (isClosed) {
        return Promise.resolve({
          sessionId: body?.sessionId || '',
          messages: [driverError('engine-closed', 'Speech engine has closed.', { sessionId: body?.sessionId || '' })],
        });
      }

      const task = async () => {
        if (isClosed) {
          return {
            sessionId: body?.sessionId || '',
            messages: [driverError('engine-closed', 'Speech engine has closed.', { sessionId: body?.sessionId || '' })],
          };
        }
        const frames = Array.isArray(body.frames) ? body.frames : [];
        if (frames.length === 0) {
          return { sessionId: body.sessionId || '', messages: [] };
        }

        let sessionId = body.sessionId;
        const created = [];
        if (!sessionId || !sessions.has(sessionId)) {
          const opened = createSessionInternal({});
          sessionId = opened.session.sessionId;
          created.push(...opened.messages);
        }
        const session = sessions.get(sessionId);
        const offsetMs = elapsed.get(sessionId) || 0;

        const wav = framesToWav(frames);
        // Same 16 kHz mono Int16 arithmetic whispercpp.js uses. A tiny frame
        // must still produce a valid tStartMs <= tEndMs relation.
        const audioDurationMs = Math.max(
          1,
          Math.round(((wav.length - 44) / (SAMPLE_RATE * 2)) * 1000)
        );

        try {
          const text = await requestText(wav, session?.language);
          if (sessions.has(sessionId)) {
            elapsed.set(sessionId, offsetMs + audioDurationMs);
          }
          return {
            sessionId,
            messages: [
              ...created,
              {
                t: 'final',
                sessionId,
                text,
                tStartMs: offsetMs,
                tEndMs: offsetMs + audioDurationMs,
                startMs: offsetMs,
                endMs: offsetMs + audioDurationMs,
              },
            ],
          };
        } catch (error) {
          if (sessions.has(sessionId)) {
            elapsed.set(sessionId, offsetMs + audioDurationMs);
          }
          return {
            sessionId,
            messages: [
              ...created,
              driverError(error?.code || 'cloud-transcribe-failed', error?.message || 'Cloud transcription failed.', { sessionId }),
            ],
          };
        }
      };

      const chained = queue.then(task, task);
      queue = chained.catch(() => {});
      return chained;
    },
  };
}

export default createCloudOpenAiEngine;

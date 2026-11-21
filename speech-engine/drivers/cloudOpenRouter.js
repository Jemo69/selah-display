/**
 * speech-engine/drivers/cloudOpenRouter.js — OpenRouter + Google Gemini audio.
 *
 * OpenRouter is OpenAI-compatible in auth, but audio INPUT is not the
 * /v1/audio/transcriptions endpoint. Its documented route is the Responses
 * API: POST https://openrouter.ai/api/v1/responses with a JSON `input` array
 * containing `input_text` and `input_audio` parts. The audio is base64 WAV,
 * not multipart, and the transcript is read from
 * `output[].content[]` entries of type `output_text`.
 *
 * Documentation fetched while implementing:
 *   https://openrouter.ai/docs/guides/overview/multimodal/audio.md
 *   https://openrouter.ai/docs/api_reference/responses/overview.md
 *
 * Model ids are taken from OpenRouter's live models catalog and its audio
 * guide, not invented: `google/gemini-2.5-flash` is the guide's example and
 * `google/gemini-3.8-flash` is a current catalog Flash row that advertises
 * `audio` in `architecture.input_modalities`. Both are passed through as-is.
 *
 * SECURITY: same rules as the OpenAI driver — key only in the Authorization
 * header, no audio/key/transcript in logs or emitted errors, injectable fetch
 * so tests never touch the network. No local fallback.
 */
import { randomUUID } from 'node:crypto';
import { framesToWav } from './whispercpp.js';

export const CLOUD_PROVIDER = 'openrouter';
export const CLOUD_ENDPOINT = 'https://openrouter.ai/api/v1/responses';
export const CLOUD_MODELS = Object.freeze([
  'google/gemini-2.5-flash',
  'google/gemini-3.8-flash',
]);
export const DEFAULT_CLOUD_MODEL = 'google/gemini-2.5-flash';
const SAMPLE_RATE = 16000;
const DEFAULT_TIMEOUT_MS = 120_000;
const TRANSCRIBE_PROMPT =
  'Transcribe this audio segment exactly. Return only the spoken words, with no preface or commentary.';

/** Validate provider/model/key before anything is forked or sent. */
export function resolveCloudConfig({ provider, apiKey, model } = {}) {
  if (provider !== CLOUD_PROVIDER) {
    throw Object.assign(
      new Error('Only OpenRouter is supported by this driver.'),
      { code: 'cloud-provider-not-supported' }
    );
  }
  if (typeof apiKey !== 'string' || !apiKey.trim()) {
    throw Object.assign(
      new Error('An OpenRouter API key is required. Save one in Settings.'),
      { code: 'cloud-key-missing' }
    );
  }
  const resolvedModel = typeof model === 'string' && model.trim() ? model.trim() : DEFAULT_CLOUD_MODEL;
  if (!CLOUD_MODELS.includes(resolvedModel)) {
    throw Object.assign(new Error(`Unknown OpenRouter model "${resolvedModel}".`), {
      code: 'cloud-model-not-supported',
    });
  }
  return { provider: CLOUD_PROVIDER, apiKey: apiKey.trim(), model: resolvedModel };
}

function mapProviderError(status) {
  if (status === 401 || status === 403) {
    return {
      code: 'cloud-auth-invalid',
      message: 'OpenRouter rejected the API key. Save a valid key in Settings → Speech & AI → Cloud.',
    };
  }
  if (status === 429) {
    return {
      code: 'cloud-rate-limited',
      message: 'OpenRouter is rate limiting transcription requests. Try again shortly.',
    };
  }
  if (status >= 500 || status === 408) {
    return {
      code: 'cloud-provider-unavailable',
      message: 'OpenRouter transcription is temporarily unavailable.',
    };
  }
  return {
    code: 'cloud-request-failed',
    message: `OpenRouter rejected the transcription request (HTTP ${status}).`,
  };
}

const driverError = (code, message, extra = {}) => ({
  t: 'error',
  code,
  message,
  fatal: false,
  ...extra,
});

/** Read the documented Responses API text content, never the raw JSON body. */
function extractText(payload) {
  const outputs = Array.isArray(payload?.output) ? payload.output : [];
  const parts = [];
  for (const item of outputs) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (part?.type === 'output_text' && typeof part.text === 'string' && part.text.trim()) {
        parts.push(part.text.trim());
      }
    }
  }
  return parts.join('\n');
}

/**
 * @param {object} options
 * @param {string} options.apiKey
 * @param {string} [options.model]
 * @param {Function} [options.fetchImpl] injectable fetch for tests
 * @param {string} [options.endpoint] override for tests / proxies
 * @param {number} [options.timeoutMs]
 */
export function createCloudOpenRouterEngine({
  bus,
  apiKey,
  model = DEFAULT_CLOUD_MODEL,
  fetchImpl,
  endpoint = CLOUD_ENDPOINT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const config = resolveCloudConfig({ provider: CLOUD_PROVIDER, apiKey, model });
  const sessions = new Map();
  const elapsed = new Map();
  let queue = Promise.resolve();
  let isClosed = false;
  const doFetch = (...args) => (fetchImpl ?? globalThis.fetch)(...args);

  function createSessionInternal(options = {}) {
    const sessionId = randomUUID();
    const session = {
      sessionId,
      model: config.model,
      provider: CLOUD_PROVIDER,
      sampleRate: SAMPLE_RATE,
      language: options.language || 'auto',
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

  async function requestText(wav) {
    const body = {
      model: config.model,
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: TRANSCRIBE_PROMPT },
          { type: 'input_audio', input_audio: { data: wav.toString('base64'), format: 'wav' } },
        ],
      }],
      stream: false,
    };

    let response;
    try {
      response = await doFetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw driverError('cloud-network-error', 'The transcription request could not reach OpenRouter.');
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
        'OpenRouter returned a response that could not be read as transcript JSON.'
      );
    }

    const text = extractText(payload);
    if (!text) {
      throw driverError('cloud-bad-response', 'OpenRouter returned no transcript text for this segment.');
    }
    return text;
  }

  return {
    kind: 'cloud',
    backend: 'cloud-openrouter',
    model: config.model,

    health() {
      return {
        model: config.model,
        backend: 'cloud-openrouter',
        provider: CLOUD_PROVIDER,
        wordTimestamps: false,
        biasSupport: false,
        keyReady: true,
        binaryReady: true,
        weightsReady: true,
      };
    },

    models() {
      return CLOUD_MODELS.map((id) => ({ id, name: id, provider: CLOUD_PROVIDER, installed: true }));
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

    /** Same session/frames contract as every other driver. */
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
        if (frames.length === 0) return { sessionId: body.sessionId || '', messages: [] };

        let sessionId = body.sessionId;
        const created = [];
        if (!sessionId || !sessions.has(sessionId)) {
          const opened = createSessionInternal({});
          sessionId = opened.session.sessionId;
          created.push(...opened.messages);
        }
        const offsetMs = elapsed.get(sessionId) || 0;
        const wav = framesToWav(frames);
        const audioDurationMs = Math.max(1, Math.round(((wav.length - 44) / (SAMPLE_RATE * 2)) * 1000));

        try {
          const text = await requestText(wav);
          if (sessions.has(sessionId)) elapsed.set(sessionId, offsetMs + audioDurationMs);
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
          if (sessions.has(sessionId)) elapsed.set(sessionId, offsetMs + audioDurationMs);
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

export default createCloudOpenRouterEngine;

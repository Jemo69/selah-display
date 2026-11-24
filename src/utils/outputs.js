import { defaultOutput1Settings, defaultOutput2Settings, defaultStreamSettings, defaultStageSettings } from '../context/LyricsStore';
import { createLogger } from './logger.js';

const log = createLogger('Outputs');

export const BUILT_IN_OUTPUTS = [
  { id: 'output1', key: 'output1', name: 'Output 1', slug: 'output1', type: 'regular', builtIn: true },
  { id: 'output2', key: 'output2', name: 'Output 2', slug: 'output2', type: 'regular', builtIn: true },
  { id: 'stream', key: 'stream', name: 'Stream', slug: 'stream', type: 'stream', builtIn: true },
  { id: 'stage', key: 'stage', name: 'Stage', slug: 'stage', type: 'stage', builtIn: true },
];

const RESERVED_OUTPUT_SLUGS = new Set(['', 'new-song', 'preview', 'lite']);

export function slugifyOutputName(name = '') {
  return String(name)
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function isReservedOutputSlug(slug) {
  const safeSlug = String(slug || '').replace(/^\/+/, '').toLowerCase();
  return RESERVED_OUTPUT_SLUGS.has(safeSlug) || BUILT_IN_OUTPUTS.some((output) => output.slug === safeSlug);
}

export function getBuiltInOutputs() {
  return BUILT_IN_OUTPUTS;
}

export function normalizeCustomOutput(output) {
  if (!output?.id || !output?.slug) return null;
  return {
    ...output,
    key: output.id,
    type: output.type === 'stage' ? 'stage' : 'regular',
    builtIn: false,
  };
}

export function getAllOutputs(state = {}) {
  const customOutputs = Array.isArray(state.customOutputs)
    ? state.customOutputs.map(normalizeCustomOutput).filter(Boolean)
    : [];
  const all = [...BUILT_IN_OUTPUTS, ...customOutputs];
  log.debug('getAllOutputs', { total: all.length, customCount: customOutputs.length });
  return all;
}

export function findOutputBySlug(state, slug) {
  const safeSlug = String(slug || '').replace(/^\/+/, '').toLowerCase();
  return getAllOutputs(state).find((output) => output.slug === safeSlug) || null;
}

export function findOutputByKey(state, outputKey) {
  return getAllOutputs(state).find((output) => output.key === outputKey || output.id === outputKey) || null;
}

export function getOutputSettings(state = {}, outputKey) {
  if (outputKey === 'output1') return state.output1Settings || defaultOutput1Settings;
  if (outputKey === 'output2') return state.output2Settings || defaultOutput2Settings;
  if (outputKey === 'stream') return state.streamSettings || defaultStreamSettings;
  if (outputKey === 'stage') return state.stageSettings || defaultStageSettings;
  if (state.customOutputSettings?.[outputKey]) return state.customOutputSettings[outputKey];
  const output = findOutputByKey(state, outputKey);
  const settings = output?.type === 'stage' ? defaultStageSettings : defaultOutput1Settings;
  log.debug('getOutputSettings (fallback)', { outputKey });
  return settings;
}

export function getOutputEnabled(state = {}, outputKey) {
  if (outputKey === 'output1') return state.output1Enabled !== false;
  if (outputKey === 'output2') return state.output2Enabled !== false;
  if (outputKey === 'stream') return state.streamEnabled !== false;
  if (outputKey === 'stage') return state.stageEnabled !== false;
  return state.customOutputEnabled?.[outputKey] !== false;
}

export function cloneSettingsForType(type, sourceOutputKey, state = {}) {
  const fallback = type === 'stage' ? defaultStageSettings : defaultOutput1Settings;
  const source = getOutputSettings(state, sourceOutputKey) || fallback;
  return JSON.parse(JSON.stringify(source));
}

/**
 * Merge an incoming (server) custom output registry into local persisted state.
 *
 * The backend registry is an in-memory mirror that resets on every app restart,
 * so an empty incoming registry must never clobber locally persisted custom
 * outputs. Returns the local state unchanged (merged: false) in that case.
 */
export function mergeCustomOutputRegistry(local, incoming) {
  const localHasData = Array.isArray(local?.customOutputs) && local.customOutputs.length > 0;
  const incomingHasData = Array.isArray(incoming?.customOutputs) && incoming.customOutputs.length > 0;

  if (!incomingHasData && localHasData) {
    return { merged: false, state: local };
  }

  return {
    merged: true,
    state: {
      customOutputs: Array.isArray(incoming?.customOutputs) ? incoming.customOutputs : [],
      customOutputSettings: incoming?.customOutputSettings || {},
      customOutputEnabled: incoming?.customOutputEnabled || {},
    },
  };
}

/**
 * Shared application configuration schema, defaults, and sanitizers.
 *
 * Used by both the Express/MCP server (`server/`) and the desktop renderer
 * (`src/`) so MCP config reads/writes and UI preference controls share one
 * validated contract without duplicating rules.
 */

export const VALID_DEFAULT_LAYOUTS = ['songs', 'bible', 'bible-sidebar'];
export const VALID_BIBLE_SPLIT_METHODS = [
  'nearest-punctuation',
  'hybrid-legacy-punctuation',
  'geometry-punctuation',
  'legacy',
];
export const VALID_SPEECH_WHERE = ['local', 'network', 'cloud'];
export const VALID_SPEECH_ENGINE_MODES = ['prod', 'test'];
export const VALID_ONBOARD_ROLES = ['all', 'operator', 'preacher', 'streamer', 'musician'];
export const VALID_CLICK_SOUNDS = ['metal', 'wood', 'custom'];

export const APP_CONFIG_SECTIONS = [
  'interface',
  'lyrics',
  'bible',
  'speech',
  'performance',
  'experimental',
  'autoplay',
  'metronome',
  'onboard',
  'database',
  'mcp',
];

const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const clampNumber = (value, min, max, fallback) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
};

const clampInt = (value, min, max, fallback) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
};

const optionalStringOrNull = (value, maxLen = 256) => {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLen) : null;
};

/**
 * Factory returning a fresh default configuration tree.
 * Invariant: `speech.enabled` and experimental switches default to `false`;
 * `mcp.enabled` defaults to `true` (localhost-only until `mcp.allowRemote` is enabled).
 */
export function createDefaultAppConfig() {
  return {
    interface: {
      darkMode: false,
      defaultLayout: 'bible-sidebar',
      uiScale: 100,
      fHintEnabled: true,
      sidebarCollapsed: false,
      settingsCollapsed: false,
      sidebarWidth: 430,
      headerCompact: false,
      vimMode: false,
      showControlDockExpanded: true,
    },
    lyrics: {
      autoGroupLines: true,
      enableLyricSplitting: true,
      showSelectedLineHighlight: true,
      lyricContentSearchEnabled: true,
      hotReloadEnabled: true,
      autoTurnOnOutput: true,
    },
    bible: {
      defaultBibleId: null,
      linkedBibleId: null,
      parallelHidden: false,
      settings: {
        referenceDivider: ':',
        showVerseNumbers: true,
        splitLongVerses: false,
        longVersesChars: 100,
        longVersesTolerance: 0,
        splitMethod: 'nearest-punctuation',
        switchInPlace: false,
        truncateVersionPreviews: true,
        logBibleSearches: true,
      },
    },
    speech: {
      enabled: false,
      where: 'local',
      engineMode: 'prod',
      providerId: 'whispercpp',
      modelId: 'large-v3',
      cloudProviderId: null,
      speechLocale: null,
      networkEndpoint: null,
      historyEnabled: true,
      ui: {
        railCollapsed: true,
        railWidth: 340,
        cloudBadgeVisible: true,
        showEngineErrors: true,
      },
    },
    performance: {
      lowPowerMode: false,
      disableVideoPreloading: false,
      reducedGraphics: false,
      gpuEffects: true,
      disableHardwareAcceleration: false,
    },
    experimental: {
      freeNotesEnabled: false,
      schedulerEnabled: false,
      bibleVerseEditorEnabled: false,
      bibleTextScopeEnabled: false,
    },
    autoplay: {
      interval: 5,
      loop: true,
      startFromFirst: true,
      skipBlankLines: true,
    },
    metronome: {
      tempo: 120,
      beats: 4,
      volume: 1,
      clickSound: 'metal',
      clickSoundHi: '',
      clickSoundLo: '',
      audioOutput: '',
      audioChannel: '',
    },
    onboard: {
      role: 'all',
      explainMode: false,
    },
    database: {
      baseUrl: '',
    },
    mcp: {
      enabled: true,
      allowRemote: false,
    },
  };
}

/**
 * Validate and normalize a partial patch for a single config section.
 * Unknown keys are ignored; invalid values fall back to `base` or throw when `strict` is true.
 */
export function sanitizeAppConfigSection(section, rawPatch, baseSection = null, { strict = false } = {}) {
  if (!APP_CONFIG_SECTIONS.includes(section)) {
    throw new Error(`Unknown config section: ${section}`);
  }
  if (!isPlainObject(rawPatch)) {
    if (strict) throw new Error(`Config section "${section}" must be an object`);
    return {};
  }

  const defaults = createDefaultAppConfig()[section];
  const base = isPlainObject(baseSection) ? baseSection : defaults;
  const out = {};

  const assignBool = (key, target = out) => {
    if (!(key in rawPatch)) return;
    if (typeof rawPatch[key] === 'boolean') {
      target[key] = rawPatch[key];
    } else if (strict) {
      throw new Error(`${section}.${key} must be a boolean`);
    }
  };

  switch (section) {
    case 'interface': {
      assignBool('darkMode');
      assignBool('fHintEnabled');
      assignBool('sidebarCollapsed');
      assignBool('settingsCollapsed');
      assignBool('headerCompact');
      assignBool('vimMode');
      assignBool('showControlDockExpanded');
      if ('defaultLayout' in rawPatch) {
        if (VALID_DEFAULT_LAYOUTS.includes(rawPatch.defaultLayout)) {
          out.defaultLayout = rawPatch.defaultLayout;
        } else if (strict) {
          throw new Error(`interface.defaultLayout must be one of: ${VALID_DEFAULT_LAYOUTS.join(', ')}`);
        }
      }
      if ('uiScale' in rawPatch) {
        const val = Number(rawPatch.uiScale);
        if (Number.isFinite(val)) out.uiScale = clampInt(val, 75, 150, base.uiScale ?? 100);
        else if (strict) throw new Error('interface.uiScale must be a number between 75 and 150');
      }
      if ('sidebarWidth' in rawPatch) {
        const val = Number(rawPatch.sidebarWidth);
        if (Number.isFinite(val)) out.sidebarWidth = clampInt(val, 260, 800, base.sidebarWidth ?? 430);
        else if (strict) throw new Error('interface.sidebarWidth must be a number');
      }
      break;
    }

    case 'lyrics': {
      assignBool('autoGroupLines');
      assignBool('enableLyricSplitting');
      assignBool('showSelectedLineHighlight');
      assignBool('lyricContentSearchEnabled');
      assignBool('hotReloadEnabled');
      assignBool('autoTurnOnOutput');
      break;
    }

    case 'bible': {
      if ('defaultBibleId' in rawPatch) {
        const val = optionalStringOrNull(rawPatch.defaultBibleId, 128);
        if (val !== undefined) out.defaultBibleId = val;
        else if (strict) throw new Error('bible.defaultBibleId must be a string or null');
      }
      if ('linkedBibleId' in rawPatch) {
        const val = optionalStringOrNull(rawPatch.linkedBibleId, 128);
        if (val !== undefined) out.linkedBibleId = val;
        else if (strict) throw new Error('bible.linkedBibleId must be a string or null');
      }
      assignBool('parallelHidden');
      if ('settings' in rawPatch) {
        if (!isPlainObject(rawPatch.settings)) {
          if (strict) throw new Error('bible.settings must be an object');
        } else {
          const s = rawPatch.settings;
          const nextSettings = {};
          if ('referenceDivider' in s) {
            if (typeof s.referenceDivider === 'string' && s.referenceDivider.length <= 4) {
              nextSettings.referenceDivider = s.referenceDivider || ':';
            } else if (strict) {
              throw new Error('bible.settings.referenceDivider must be a short string');
            }
          }
          if ('showVerseNumbers' in s) {
            if (typeof s.showVerseNumbers === 'boolean') nextSettings.showVerseNumbers = s.showVerseNumbers;
            else if (strict) throw new Error('bible.settings.showVerseNumbers must be a boolean');
          }
          if ('splitLongVerses' in s) {
            if (typeof s.splitLongVerses === 'boolean') nextSettings.splitLongVerses = s.splitLongVerses;
            else if (strict) throw new Error('bible.settings.splitLongVerses must be a boolean');
          }
          if ('longVersesChars' in s) {
            const val = Number(s.longVersesChars);
            if (Number.isFinite(val)) nextSettings.longVersesChars = clampInt(val, 20, 1000, 100);
            else if (strict) throw new Error('bible.settings.longVersesChars must be a number');
          }
          if ('longVersesTolerance' in s) {
            const val = Number(s.longVersesTolerance);
            if (Number.isFinite(val)) nextSettings.longVersesTolerance = clampInt(val, 0, 200, 0);
            else if (strict) throw new Error('bible.settings.longVersesTolerance must be a number');
          }
          if ('splitMethod' in s) {
            if (VALID_BIBLE_SPLIT_METHODS.includes(s.splitMethod)) {
              nextSettings.splitMethod = s.splitMethod;
            } else if (strict) {
              throw new Error(`bible.settings.splitMethod must be one of: ${VALID_BIBLE_SPLIT_METHODS.join(', ')}`);
            }
          }
          if ('switchInPlace' in s) {
            if (typeof s.switchInPlace === 'boolean') nextSettings.switchInPlace = s.switchInPlace;
            else if (strict) throw new Error('bible.settings.switchInPlace must be a boolean');
          }
          if ('truncateVersionPreviews' in s) {
            if (typeof s.truncateVersionPreviews === 'boolean') nextSettings.truncateVersionPreviews = s.truncateVersionPreviews;
            else if (strict) throw new Error('bible.settings.truncateVersionPreviews must be a boolean');
          }
          if ('logBibleSearches' in s) {
            if (typeof s.logBibleSearches === 'boolean') nextSettings.logBibleSearches = s.logBibleSearches;
            else if (strict) throw new Error('bible.settings.logBibleSearches must be a boolean');
          }
          if (Object.keys(nextSettings).length > 0) {
            out.settings = nextSettings;
          }
        }
      }
      break;
    }

    case 'speech': {
      // Master switch only accepts a literal boolean (invariant 4).
      assignBool('enabled');
      assignBool('historyEnabled');
      if ('where' in rawPatch) {
        if (VALID_SPEECH_WHERE.includes(rawPatch.where)) out.where = rawPatch.where;
        else if (strict) throw new Error(`speech.where must be one of: ${VALID_SPEECH_WHERE.join(', ')}`);
      }
      if ('engineMode' in rawPatch) {
        if (VALID_SPEECH_ENGINE_MODES.includes(rawPatch.engineMode)) out.engineMode = rawPatch.engineMode;
        else if (strict) throw new Error(`speech.engineMode must be one of: ${VALID_SPEECH_ENGINE_MODES.join(', ')}`);
      }
      if ('providerId' in rawPatch) {
        if (typeof rawPatch.providerId === 'string' && rawPatch.providerId.trim()) {
          out.providerId = rawPatch.providerId.trim().slice(0, 64);
        } else if (strict) {
          throw new Error('speech.providerId must be a non-empty string');
        }
      }
      if ('modelId' in rawPatch) {
        if (typeof rawPatch.modelId === 'string' && rawPatch.modelId.trim()) {
          out.modelId = rawPatch.modelId.trim().slice(0, 64);
        } else if (strict) {
          throw new Error('speech.modelId must be a non-empty string');
        }
      }
      if ('cloudProviderId' in rawPatch) {
        const val = optionalStringOrNull(rawPatch.cloudProviderId, 64);
        if (val !== undefined) out.cloudProviderId = val;
        else if (strict) throw new Error('speech.cloudProviderId must be a string or null');
      }
      if ('speechLocale' in rawPatch) {
        const val = optionalStringOrNull(rawPatch.speechLocale, 32);
        if (val !== undefined) out.speechLocale = val;
        else if (strict) throw new Error('speech.speechLocale must be a string or null');
      }
      if ('networkEndpoint' in rawPatch) {
        const val = optionalStringOrNull(rawPatch.networkEndpoint, 256);
        if (val !== undefined) out.networkEndpoint = val;
        else if (strict) throw new Error('speech.networkEndpoint must be a string or null');
      }
      if ('ui' in rawPatch) {
        if (!isPlainObject(rawPatch.ui)) {
          if (strict) throw new Error('speech.ui must be an object');
        } else {
          const uiPatch = {};
          if ('railCollapsed' in rawPatch.ui) {
            if (typeof rawPatch.ui.railCollapsed === 'boolean') uiPatch.railCollapsed = rawPatch.ui.railCollapsed;
            else if (strict) throw new Error('speech.ui.railCollapsed must be a boolean');
          }
          if ('cloudBadgeVisible' in rawPatch.ui) {
            if (typeof rawPatch.ui.cloudBadgeVisible === 'boolean') uiPatch.cloudBadgeVisible = rawPatch.ui.cloudBadgeVisible;
            else if (strict) throw new Error('speech.ui.cloudBadgeVisible must be a boolean');
          }
          if ('showEngineErrors' in rawPatch.ui) {
            if (typeof rawPatch.ui.showEngineErrors === 'boolean') uiPatch.showEngineErrors = rawPatch.ui.showEngineErrors;
            else if (strict) throw new Error('speech.ui.showEngineErrors must be a boolean');
          }
          if ('railWidth' in rawPatch.ui) {
            const val = Number(rawPatch.ui.railWidth);
            if (Number.isFinite(val)) uiPatch.railWidth = clampInt(val, 240, 700, 340);
            else if (strict) throw new Error('speech.ui.railWidth must be a number');
          }
          if (Object.keys(uiPatch).length > 0) out.ui = uiPatch;
        }
      }
      break;
    }

    case 'performance': {
      assignBool('lowPowerMode');
      assignBool('disableVideoPreloading');
      assignBool('reducedGraphics');
      assignBool('gpuEffects');
      assignBool('disableHardwareAcceleration');
      break;
    }

    case 'experimental': {
      assignBool('freeNotesEnabled');
      assignBool('schedulerEnabled');
      assignBool('bibleVerseEditorEnabled');
      assignBool('bibleTextScopeEnabled');
      break;
    }

    case 'autoplay': {
      if ('interval' in rawPatch) {
        const val = Number(rawPatch.interval);
        if (Number.isFinite(val)) out.interval = clampNumber(val, 0.5, 300, base.interval ?? 5);
        else if (strict) throw new Error('autoplay.interval must be a number');
      }
      assignBool('loop');
      assignBool('startFromFirst');
      assignBool('skipBlankLines');
      break;
    }

    case 'metronome': {
      if ('tempo' in rawPatch) {
        const val = Number(rawPatch.tempo);
        if (Number.isFinite(val)) out.tempo = clampInt(val, 20, 300, base.tempo ?? 120);
        else if (strict) throw new Error('metronome.tempo must be a number (20-300)');
      }
      if ('beats' in rawPatch) {
        const val = Number(rawPatch.beats);
        if (Number.isFinite(val)) out.beats = clampInt(val, 1, 16, base.beats ?? 4);
        else if (strict) throw new Error('metronome.beats must be an integer (1-16)');
      }
      if ('volume' in rawPatch) {
        const val = Number(rawPatch.volume);
        if (Number.isFinite(val)) out.volume = clampNumber(val, 0, 1, base.volume ?? 1);
        else if (strict) throw new Error('metronome.volume must be a number (0-1)');
      }
      if ('clickSound' in rawPatch) {
        if (VALID_CLICK_SOUNDS.includes(rawPatch.clickSound)) out.clickSound = rawPatch.clickSound;
        else if (strict) throw new Error(`metronome.clickSound must be one of: ${VALID_CLICK_SOUNDS.join(', ')}`);
      }
      for (const strKey of ['clickSoundHi', 'clickSoundLo', 'audioOutput', 'audioChannel']) {
        if (strKey in rawPatch) {
          if (typeof rawPatch[strKey] === 'string') out[strKey] = rawPatch[strKey].slice(0, 256);
          else if (rawPatch[strKey] === null) out[strKey] = '';
          else if (strict) throw new Error(`metronome.${strKey} must be a string`);
        }
      }
      break;
    }

    case 'onboard': {
      if ('role' in rawPatch) {
        if (VALID_ONBOARD_ROLES.includes(rawPatch.role)) out.role = rawPatch.role;
        else if (strict) throw new Error(`onboard.role must be one of: ${VALID_ONBOARD_ROLES.join(', ')}`);
      }
      assignBool('explainMode');
      break;
    }

    case 'database': {
      if ('baseUrl' in rawPatch) {
        if (typeof rawPatch.baseUrl === 'string') {
          out.baseUrl = rawPatch.baseUrl.trim().replace(/\/+$/, '').slice(0, 256);
        } else if (rawPatch.baseUrl === null) {
          out.baseUrl = '';
        } else if (strict) {
          throw new Error('database.baseUrl must be a string');
        }
      }
      break;
    }

    case 'mcp': {
      assignBool('enabled');
      assignBool('allowRemote');
      break;
    }
  }

  return out;
}

/**
 * Validate and sanitize a multi-section config patch `{ [section]: { ... } }`.
 */
export function sanitizeAppConfigPatch(rawPatch, currentConfig = null, { strict = false } = {}) {
  if (!isPlainObject(rawPatch)) {
    if (strict) throw new Error('Config patch must be an object keyed by section name');
    return {};
  }
  const base = currentConfig && isPlainObject(currentConfig) ? currentConfig : createDefaultAppConfig();
  const sanitized = {};

  for (const [section, value] of Object.entries(rawPatch)) {
    if (!APP_CONFIG_SECTIONS.includes(section)) {
      if (strict) throw new Error(`Unknown config section "${section}". Valid sections: ${APP_CONFIG_SECTIONS.join(', ')}`);
      continue;
    }
    const cleanSection = sanitizeAppConfigSection(section, value, base[section], { strict });
    if (Object.keys(cleanSection).length > 0) {
      sanitized[section] = cleanSection;
    }
  }

  return sanitized;
}

/**
 * Deep-merge a sanitized config patch onto an existing config object.
 */
export function mergeAppConfig(baseConfig, patch) {
  const defaults = createDefaultAppConfig();
  const base = isPlainObject(baseConfig) ? baseConfig : defaults;
  const next = {};

  for (const section of APP_CONFIG_SECTIONS) {
    const baseSec = isPlainObject(base[section]) ? base[section] : defaults[section];
    const patchSec = isPlainObject(patch?.[section]) ? patch[section] : null;
    if (!patchSec) {
      next[section] = structuredCloneSafe(baseSec);
      continue;
    }
    const merged = { ...structuredCloneSafe(defaults[section]), ...structuredCloneSafe(baseSec), ...structuredCloneSafe(patchSec) };
    if (section === 'bible') {
      merged.settings = {
        ...defaults.bible.settings,
        ...(isPlainObject(baseSec?.settings) ? baseSec.settings : {}),
        ...(isPlainObject(patchSec?.settings) ? patchSec.settings : {}),
      };
    } else if (section === 'speech') {
      merged.ui = {
        ...defaults.speech.ui,
        ...(isPlainObject(baseSec?.ui) ? baseSec.ui : {}),
        ...(isPlainObject(patchSec?.ui) ? patchSec.ui : {}),
      };
    }
    next[section] = merged;
  }

  return next;
}

function structuredCloneSafe(obj) {
  return JSON.parse(JSON.stringify(obj));
}

export function isValidOutputKey(outputKey) {
  if (typeof outputKey !== 'string') return false;
  return outputKey === 'output1'
    || outputKey === 'output2'
    || outputKey === 'stream'
    || outputKey === 'stage'
    || /^custom_[A-Za-z0-9_-]+$/.test(outputKey);
}

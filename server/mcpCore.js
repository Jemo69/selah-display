import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  APP_CONFIG_SECTIONS,
  VALID_BIBLE_SPLIT_METHODS,
  VALID_CLICK_SOUNDS,
  VALID_DEFAULT_LAYOUTS,
  VALID_ONBOARD_ROLES,
  VALID_SPEECH_ENGINE_MODES,
  VALID_SPEECH_WHERE,
  isValidOutputKey,
} from '../shared/appConfig.js';
import {
  getAppConfigSnapshot,
  updateAppConfigInternal,
  resetAppConfigSectionInternal,
  getOutputSettingsSnapshot,
  updateOutputSettingsInternal,
  toggleIndividualOutputInternal,
  setShowStateInternal,
  updateModeTemplatesConfigInternal,
  getModeTemplatesSnapshot,
  getStatus,
  getCurrentLyricsState,
  getConnectedClients,
  getOutputPresenceSnapshot,
} from './events.js';
import { getActiveBible, getAllBibles, getActiveBibleId } from './bibleManager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const SUPPORTED_MCP_PROTOCOL_VERSIONS = ['2025-03-26', '2024-11-05'];

function readAppVersion() {
  if (process.env.npm_package_version) return process.env.npm_package_version;
  try {
    const pkgPath = path.resolve(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    if (pkg?.version) return String(pkg.version);
  } catch {
    // In packaged asar-unpacked builds, package.json may sit inside app.asar.
  }
  return '6.21.0';
}

export const MCP_SERVER_INFO = {
  name: 'selah-display-mcp',
  title: 'Selah Config & Control MCP Server',
  version: readAppVersion(),
};

export const MCP_SERVER_INSTRUCTIONS =
  'Selah worship display MCP server for reading and configuring application preferences, ' +
  'output styles (output1, output2, stream, stage, custom_*), show state (LIVE/CLEAR/BLACKOUT/LOGO), ' +
  'mode templates, Bible/lyrics/performance/Sermon Assist settings, and live status.';

export const MCP_TOOLS = [
  {
    name: 'get_app_config',
    title: 'Get Selah Configuration',
    description:
      'Read Selah settings and configuration. Pass section="all" (default) for everything, ' +
      'or one specific section (interface, lyrics, bible, speech, performance, experimental, ' +
      'autoplay, metronome, onboard, database, mcp, outputs, modeTemplates).',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: ['all', ...APP_CONFIG_SECTIONS, 'outputs', 'modeTemplates'],
          description: 'Config section to return (default: all).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'update_app_config',
    title: 'Update Selah Configuration',
    description:
      'Update one or more Selah preference sections and sync immediately to the live desktop app. ' +
      'Provide either { config: { interface: { darkMode: true }, ... } } or { section: "interface", settings: { darkMode: true } }.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        config: {
          type: 'object',
          description: 'Object keyed by section name (interface, lyrics, bible, speech, performance, experimental, autoplay, metronome, onboard, database, mcp).',
          additionalProperties: { type: 'object' },
        },
        section: {
          type: 'string',
          enum: APP_CONFIG_SECTIONS,
          description: 'Optional single section name when using { section, settings }.',
        },
        settings: {
          type: 'object',
          description: 'Partial settings object for `section`.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'reset_config_section',
    title: 'Reset Configuration Section',
    description: 'Reset one configuration section (or "all") back to safe factory defaults.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: ['all', ...APP_CONFIG_SECTIONS],
          description: 'Section to reset (or "all").',
        },
      },
      required: ['section'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_output_settings',
    title: 'Get Output Display Settings',
    description: 'Read typography, layout, background, stream lower-third band, and enabled state for an output or all outputs.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        output: {
          type: 'string',
          description: 'Output key: all (default), output1, output2, stream, stage, or custom_<slug>.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'update_output_settings',
    title: 'Update Output Display Settings',
    description:
      'Update styling/layout settings for output1, output2, stream, stage, or a custom_* output and broadcast live. ' +
      'Includes fontStyle, fontSize, fontColor, backgroundColor, backgroundOpacity, lyricsPosition, fullScreenMode, ' +
      'streamBandEnabled, streamBandHeightPercent, streamBandBackdrop, streamBandAutoFit, transitionAnimation, transitionSpeed, etc.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        output: {
          type: 'string',
          description: 'Target output key (output1, output2, stream, stage, or custom_<slug>).',
        },
        settings: {
          type: 'object',
          description: 'Partial output settings object to merge and broadcast.',
        },
      },
      required: ['output', 'settings'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_output_enabled',
    title: 'Enable or Disable Output',
    description: 'Turn a built-in or custom output window/stream on or off.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        output: {
          type: 'string',
          description: 'Target output key (output1, output2, stream, stage, or custom_<slug>).',
        },
        enabled: {
          type: 'boolean',
          description: 'Whether the output should be enabled.',
        },
      },
      required: ['output', 'enabled'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_show_state',
    title: 'Set Live Show State',
    description: 'Switch the master show-control state between LIVE, CLEAR, BLACKOUT, and LOGO.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        state: {
          type: 'string',
          enum: ['LIVE', 'CLEAR', 'BLACKOUT', 'LOGO'],
          description: 'Show-control state.',
        },
      },
      required: ['state'],
      additionalProperties: false,
    },
  },
  {
    name: 'set_mode_templates',
    title: 'Configure Mode Templates',
    description: 'Configure per-output Song / Bible / Free Notes mode template assignments.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        outputKey: {
          type: 'string',
          description: 'Target output key (output1, output2, stream, stage, or custom_<slug>).',
        },
        enabled: { type: 'boolean', description: 'Enable automatic mode template tracking for this output.' },
        song: { type: ['string', 'null'], description: 'Template ID for Song mode (or null).' },
        bible: { type: ['string', 'null'], description: 'Template ID for Bible mode (or null).' },
        freenote: { type: ['string', 'null'], description: 'Template ID for Free Notes mode (or null).' },
        modeTemplates: {
          type: 'object',
          description: 'Full modeTemplates map keyed by outputKey (alternative to outputKey).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_status',
    title: 'Get Live Selah Status',
    description: 'Inspect current live lyrics/verse, showState, active outputs, connected clients, and loaded Bibles.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'list_outputs',
    title: 'List All Outputs & Presence',
    description: 'List built-in and custom outputs, their routes, enabled state, and currently connected output windows.',
    annotations: { readOnlyHint: true, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
];

export const MCP_RESOURCES = [
  {
    uri: 'selah://config',
    name: 'Selah App Config',
    description: 'Current validated configuration across all Selah preference sections.',
    mimeType: 'application/json',
  },
  {
    uri: 'selah://outputs',
    name: 'Selah Outputs & Styles',
    description: 'All built-in and custom output configurations, enabled flags, and presence.',
    mimeType: 'application/json',
  },
  {
    uri: 'selah://status',
    name: 'Selah Live Status',
    description: 'Live display status, active lyrics/verse, connected clients, and Bibles.',
    mimeType: 'application/json',
  },
  {
    uri: 'selah://schema',
    name: 'Selah Config Schema Reference',
    description: 'Valid sections, enums, and value constraints for Selah configuration.',
    mimeType: 'application/json',
  },
];

export const MCP_PROMPTS = [
  {
    name: 'configure-preferences',
    title: 'Configure Selah Preferences',
    description: 'Inspect current Selah settings and help the user configure them safely.',
    arguments: [
      { name: 'goal', description: 'What the user wants to configure.', required: false },
    ],
  },
  {
    name: 'configure-sermon-assist',
    title: 'Configure Live Sermon Assist',
    description: 'Inspect and configure Live Sermon Assist (local, LAN, or cloud speech recognition).',
    arguments: [
      { name: 'mode', description: 'Preferred mode: local, network, or cloud.', required: false },
    ],
  },
  {
    name: 'configure-stream-overlay',
    title: 'Configure Livestream Lower-Third',
    description: 'Inspect and tune the /stream lower-third band height, backdrop, and typography.',
    arguments: [],
  },
];

function getSchemaReference() {
  return {
    sections: APP_CONFIG_SECTIONS,
    enums: {
      'interface.defaultLayout': VALID_DEFAULT_LAYOUTS,
      'bible.settings.splitMethod': VALID_BIBLE_SPLIT_METHODS,
      'speech.where': VALID_SPEECH_WHERE,
      'speech.engineMode': VALID_SPEECH_ENGINE_MODES,
      'metronome.clickSound': VALID_CLICK_SOUNDS,
      'onboard.role': VALID_ONBOARD_ROLES,
      'showState': ['LIVE', 'CLEAR', 'BLACKOUT', 'LOGO'],
    },
    ranges: {
      'interface.uiScale': [75, 150],
      'interface.sidebarWidth': [260, 800],
      'autoplay.interval': [0.5, 300],
      'metronome.tempo': [20, 300],
      'metronome.beats': [1, 16],
      'metronome.volume': [0, 1],
    },
  };
}

function buildStatusSnapshot() {
  const status = getStatus();
  const lyricsState = getCurrentLyricsState();
  const activeBible = getActiveBible();
  return {
    ...status,
    currentLyrics: lyricsState.lyrics?.slice(0, 10) || [],
    sectionsCount: lyricsState.sections?.length || 0,
    connectedClients: getConnectedClients(),
    outputPresence: getOutputPresenceSnapshot().presence || [],
    activeBible: activeBible ? { id: getActiveBibleId(), name: activeBible.name } : null,
    bibles: getAllBibles(),
  };
}

function resolveUpdatePayload(args = {}) {
  if (args.config && typeof args.config === 'object' && !Array.isArray(args.config)) {
    return args.config;
  }
  if (args.section && args.settings && typeof args.settings === 'object') {
    return { [args.section]: args.settings };
  }
  // Also tolerate flat `{ interface: {...} }` passed directly if someone skipped `config` wrapper.
  const directSections = {};
  for (const key of Object.keys(args)) {
    if (APP_CONFIG_SECTIONS.includes(key)) {
      directSections[key] = args[key];
    }
  }
  if (Object.keys(directSections).length > 0) {
    return directSections;
  }
  throw new Error('Provide either { config: { <section>: { ... } } } or { section, settings }.');
}

export function executeMcpTool(name, args = {}) {
  switch (name) {
    case 'get_app_config': {
      const section = args?.section || 'all';
      const config = getAppConfigSnapshot();
      if (section === 'all') {
        return {
          config,
          outputs: getOutputSettingsSnapshot('all'),
          modeTemplates: getModeTemplatesSnapshot(),
        };
      }
      if (section === 'outputs') {
        return getOutputSettingsSnapshot('all');
      }
      if (section === 'modeTemplates') {
        return { modeTemplates: getModeTemplatesSnapshot() };
      }
      if (!APP_CONFIG_SECTIONS.includes(section)) {
        throw new Error(`Unknown config section "${section}".`);
      }
      return { section, settings: config[section] };
    }

    case 'update_app_config': {
      const patch = resolveUpdatePayload(args);
      const result = updateAppConfigInternal(patch, { source: 'mcp', strict: true });
      return {
        updated: result.updatedSections.length > 0,
        updatedSections: result.updatedSections,
        patch: result.patch,
        config: result.config,
      };
    }

    case 'reset_config_section': {
      const section = args?.section;
      if (!section) throw new Error('section is required');
      const result = resetAppConfigSectionInternal(String(section), { source: 'mcp' });
      return {
        reset: section,
        updatedSections: result.updatedSections,
        config: result.config,
      };
    }

    case 'get_output_settings': {
      return getOutputSettingsSnapshot(args?.output || 'all');
    }

    case 'update_output_settings': {
      if (!args?.output) throw new Error('output is required');
      if (!args?.settings || typeof args.settings !== 'object' || Array.isArray(args.settings)) {
        throw new Error('settings object is required');
      }
      return updateOutputSettingsInternal(String(args.output), args.settings);
    }

    case 'set_output_enabled': {
      if (!args?.output) throw new Error('output is required');
      if (typeof args?.enabled !== 'boolean') throw new Error('enabled boolean is required');
      return toggleIndividualOutputInternal(String(args.output), args.enabled);
    }

    case 'set_show_state': {
      if (!args?.state) throw new Error('state is required (LIVE, CLEAR, BLACKOUT, LOGO)');
      const normalized = String(args.state).trim().toUpperCase();
      if (!['LIVE', 'CLEAR', 'BLACKOUT', 'LOGO'].includes(normalized)) {
        throw new Error('state must be one of LIVE, CLEAR, BLACKOUT, LOGO');
      }
      const next = setShowStateInternal(normalized);
      return { showState: next, isOutputOn: next === 'LIVE' };
    }

    case 'set_mode_templates': {
      const modeTemplates = updateModeTemplatesConfigInternal(args || {});
      return { modeTemplates };
    }

    case 'get_status': {
      return buildStatusSnapshot();
    }

    case 'list_outputs': {
      const snapshot = getOutputSettingsSnapshot('all');
      const presence = getOutputPresenceSnapshot();
      return {
        showState: snapshot.showState,
        isOutputOn: snapshot.isOutputOn,
        outputs: snapshot.outputs.map((o) => ({
          key: o.key,
          name: o.name,
          slug: o.slug,
          route: `/${o.slug}`,
          type: o.type,
          builtIn: o.builtIn,
          enabled: o.enabled,
        })),
        presence: presence.presence || [],
      };
    }

    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { jsonRpcCode: -32601 });
  }
}

export function readMcpResource(uri) {
  switch (uri) {
    case 'selah://config':
      return getAppConfigSnapshot();
    case 'selah://outputs':
      return {
        ...getOutputSettingsSnapshot('all'),
        modeTemplates: getModeTemplatesSnapshot(),
        presence: getOutputPresenceSnapshot().presence || [],
      };
    case 'selah://status':
      return buildStatusSnapshot();
    case 'selah://schema':
      return getSchemaReference();
    default:
      throw Object.assign(new Error(`Resource not found: ${uri}`), { jsonRpcCode: -32002 });
  }
}

function getMcpPrompt(name, args = {}) {
  if (name === 'configure-preferences') {
    const goal = args?.goal ? `Goal: ${args.goal}\n\n` : '';
    return {
      description: 'Inspect current Selah preferences and update configuration safely.',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `${goal}First call get_app_config to inspect Selah's current settings, then explain ` +
              'and apply any changes with update_app_config or update_output_settings.',
          },
        },
      ],
    };
  }
  if (name === 'configure-sermon-assist') {
    const modeNote = args?.mode ? `Preferred mode: ${args.mode}. ` : '';
    return {
      description: 'Configure Live Sermon Assist safely (local, LAN network, or cloud).',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              `${modeNote}Read the current speech settings via get_app_config(section="speech"). ` +
              'Remember that cloud mode sends audio off-machine and requires saving an API key ' +
              'in the Selah desktop Preferences > Experimental > Live Sermon Assist panel.',
          },
        },
      ],
    };
  }
  if (name === 'configure-stream-overlay') {
    return {
      description: 'Configure Selah /stream transparent lower-third scripture band.',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text:
              'Call get_output_settings(output="stream") to inspect the /stream lower-third band ' +
              '(streamBandEnabled, streamBandHeightPercent, streamBandBackdrop, streamBandAutoFit) ' +
              'and adjust with update_output_settings.',
          },
        },
      ],
    };
  }
  throw Object.assign(new Error(`Prompt not found: ${name}`), { jsonRpcCode: -32602 });
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

/**
 * Handle a single JSON-RPC 2.0 MCP message.
 * Returns `null` for notifications (no `id`) per JSON-RPC 2.0 spec.
 */
export function handleMcpMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return jsonRpcError(null, -32600, 'Invalid Request: expected JSON-RPC object');
  }

  const { jsonrpc, id, method, params } = message;
  const isNotification = id === undefined || id === null && method?.startsWith('notifications/');

  if (jsonrpc !== '2.0' || typeof method !== 'string' || !method) {
    return isNotification ? null : jsonRpcError(id ?? null, -32600, 'Invalid JSON-RPC 2.0 request');
  }

  // Notifications never return a JSON-RPC response.
  if (id === undefined) {
    return null;
  }

  try {
    switch (method) {
      case 'initialize': {
        const requestedVersion = params?.protocolVersion;
        const protocolVersion = SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(requestedVersion)
          ? requestedVersion
          : SUPPORTED_MCP_PROTOCOL_VERSIONS[0];
        return jsonRpcResult(id, {
          protocolVersion,
          capabilities: {
            tools: { listChanged: false },
            resources: { subscribe: false, listChanged: false },
            prompts: { listChanged: false },
          },
          serverInfo: MCP_SERVER_INFO,
          instructions: MCP_SERVER_INSTRUCTIONS,
        });
      }

      case 'ping':
        return jsonRpcResult(id, {});

      case 'tools/list':
        return jsonRpcResult(id, { tools: MCP_TOOLS });

      case 'tools/call': {
        const toolName = params?.name;
        const toolArgs = params?.arguments ?? {};
        if (typeof toolName !== 'string' || !toolName) {
          return jsonRpcError(id, -32602, 'Invalid params: tool name is required');
        }
        try {
          const output = executeMcpTool(toolName, toolArgs);
          return jsonRpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
            structuredContent: output,
            isError: false,
          });
        } catch (err) {
          if (err?.jsonRpcCode === -32601) {
            return jsonRpcError(id, -32601, err.message);
          }
          return jsonRpcResult(id, {
            content: [{ type: 'text', text: err?.message || 'Tool execution failed' }],
            isError: true,
          });
        }
      }

      case 'resources/list':
        return jsonRpcResult(id, { resources: MCP_RESOURCES });

      case 'resources/read': {
        const uri = params?.uri;
        if (typeof uri !== 'string' || !uri) {
          return jsonRpcError(id, -32602, 'Invalid params: uri is required');
        }
        const data = readMcpResource(uri);
        return jsonRpcResult(id, {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(data, null, 2),
            },
          ],
        });
      }

      case 'prompts/list':
        return jsonRpcResult(id, { prompts: MCP_PROMPTS });

      case 'prompts/get': {
        const promptName = params?.name;
        if (typeof promptName !== 'string' || !promptName) {
          return jsonRpcError(id, -32602, 'Invalid params: prompt name is required');
        }
        const prompt = getMcpPrompt(promptName, params?.arguments || {});
        return jsonRpcResult(id, prompt);
      }

      default:
        return jsonRpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (error) {
    const code = Number.isInteger(error?.jsonRpcCode) ? error.jsonRpcCode : -32603;
    return jsonRpcError(id, code, error?.message || 'Internal error');
  }
}

export function isLoopbackRemoteAddress(req) {
  const candidates = [
    req?.socket?.remoteAddress,
    req?.connection?.remoteAddress,
    req?.ip,
  ].filter(Boolean).map((v) => String(v));
  if (candidates.length === 0) return false;
  return candidates.every((raw) => {
    const normalized = raw.replace(/^::ffff:/i, '');
    return normalized === '127.0.0.1' || normalized === '::1' || normalized.startsWith('127.');
  });
}

export { isValidOutputKey };

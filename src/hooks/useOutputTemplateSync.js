import { useCallback, useRef } from 'react';
import useLyricsStore from '../context/LyricsStore';
import { useControlSocket } from '../context/ControlSocketProvider';
import { getAllOutputs, getOutputSettings } from '../utils/outputs';
import { resolveTemplateForOutput, resolveTemplateById, getTemplateSettings } from '../utils/outputTemplates';
import useToast from './useToast';
import { createLogger } from '../utils/logger.js';
import { CONTENT_MODE_BIBLE, CONTENT_MODE_SONG, CONTENT_MODE_FREENOTE } from '../utils/contentMode.js';
import { getContentModeFromStore } from '../utils/modeTemplates.js';

const log = createLogger('OutputTemplateSync');

const RUNTIME_SETTING_KEYS = new Set([
  'autosizerActive',
  'primaryViewportWidth',
  'primaryViewportHeight',
  'allInstances',
  'instanceCount',
]);

// Keys that must be explicitly cleared when a template doesn't define them.
// Without this, a song template's backgroundImage/media bleeds into Bible verses
// (and vice versa) because both server and store do shallow merges.
const CLEARABLE_KEYS = [
  'backgroundImage',
  'fullScreenBackgroundMedia',
  'fullScreenBackgroundType',
  'fullScreenBackgroundMotionPreset',
  'fullScreenBackgroundMotionDim',
  'overlayOpacity',
  // backgroundColor is intentionally NOT cleared — Bible templates often
  // want to keep a subtle tint while still clearing media
];

function stripRuntimeSettings(settings) {
  if (!settings || typeof settings !== 'object') return {};
  const clean = {};
  for (const [key, val] of Object.entries(settings)) {
    if (!RUNTIME_SETTING_KEYS.has(key)) {
      clean[key] = val;
    }
  }
  return clean;
}

export function useOutputTemplateSync() {
  const contentMode = useLyricsStore((s) => s.contentMode);
  const bibleVersion = useLyricsStore((s) => s.bibleVersion);
  const lyricsFileName = useLyricsStore((s) => s.lyricsFileName);
  const mode = getContentModeFromStore(lyricsFileName, bibleVersion, contentMode);
  const { emitStyleUpdate } = useControlSocket() || {};
  const { showToast } = useToast();
  const generationRef = useRef(0);

  // Manual-only: no auto-apply. Templates change outputs only through
  // explicit user action (control-panel Showing switch, Apply buttons).
  // The mode watcher was removed — see git history to restore auto.

  const applyForMode = useCallback(async (targetMode, options = {}) => {
    // Manual-only applier: runs only on explicit user action (Showing
    // switch, Apply buttons). No auto-apply anywhere in the call chain.
    // Server covers mobile/offline-control; client covers user-templates + immediate feedback.
    const generation = ++generationRef.current;
    const tMode = targetMode === CONTENT_MODE_FREENOTE
      ? CONTENT_MODE_FREENOTE
      : targetMode === CONTENT_MODE_BIBLE
        ? CONTENT_MODE_BIBLE
        : CONTENT_MODE_SONG;
    const stateAtStart = useLyricsStore.getState();
    const currentModeTemplates = stateAtStart.modeTemplates || {};
    const outputs = getAllOutputs(stateAtStart);
    const applied = [];
    const appliedKeys = [];
    const skipped = [];
    let userTemplatesCache = null;
    let userTemplatesLoadSucceeded = false;

    const loadUserTemplates = async () => {
      if (userTemplatesCache !== null) return userTemplatesCache;
      if (!window.electronAPI?.templates?.load) {
        userTemplatesCache = [];
        userTemplatesLoadSucceeded = false;
        return userTemplatesCache;
      }
      try {
        const [outRes, stageRes] = await Promise.all([
          window.electronAPI.templates.load('output').catch(() => ({ success: false, templates: [] })),
          window.electronAPI.templates.load('stage').catch(() => ({ success: false, templates: [] })),
        ]);
        const out = outRes?.success ? (outRes.templates || []) : [];
        const stg = stageRes?.success ? (stageRes.templates || []) : [];
        userTemplatesCache = [...out, ...stg];
        userTemplatesLoadSucceeded = Boolean(outRes?.success || stageRes?.success);
        if (!outRes?.success && !stageRes?.success) {
          // both failed -> treat as transient, don't clear prefs later
          userTemplatesLoadSucceeded = false;
        } else {
          userTemplatesLoadSucceeded = true;
        }
      } catch {
        userTemplatesCache = [];
        userTemplatesLoadSucceeded = false;
      }
      return userTemplatesCache;
    };

    // Pre-load user templates once if any enabled output might need them (avoids per-output sequential await)
    const willNeedUserTemplates = outputs.some((o) => {
      const cfg = currentModeTemplates[o.key];
      return cfg?.enabled && cfg[tMode] && !resolveTemplateForOutput(cfg[tMode], o, []);
    });
    if (willNeedUserTemplates) {
      await loadUserTemplates();
      if (generation !== generationRef.current) {
        log.debug('applyForMode superseded before loop', { generation, current: generationRef.current });
        return;
      }
    }

    for (const out of outputs) {
      if (generation !== generationRef.current) {
        log.debug('applyForMode superseded mid-loop', { generation, current: generationRef.current });
        break;
      }
      const key = out.key;
      const cfg = currentModeTemplates[key];
      if (!cfg) {
        skipped.push(`${out.name} (no template)`);
        continue;
      }
      if (!cfg.enabled && !options?.manual) {
        skipped.push(`${out.name} (OFF)`);
        continue;
      }
      const templateId = cfg[tMode];
      if (templateId == null || templateId === '__none__') {
        skipped.push(`${out.name} (None)`);
        continue;
      }
      let tpl = resolveTemplateForOutput(templateId, out, []);
      if (!tpl) {
        const userTemplates = await loadUserTemplates();
        if (generation !== generationRef.current) break;
        tpl = resolveTemplateForOutput(templateId, out, userTemplates);
      }
      if (!tpl) tpl = resolveTemplateById(templateId, key, (await loadUserTemplates()));
      if (generation !== generationRef.current) break;
      if (!tpl) {
        log.warn('Template not found', { templateId, outputKey: key });
        // P0-2: only clear pref if we positively confirmed load succeeded; transient IPC failure keeps pref
        const isTransient = !userTemplatesLoadSucceeded && !window.electronAPI?.templates?.load;
        // Also if load returned empty due to failure, don't clear
        if (userTemplatesLoadSucceeded) {
          showToast({ title: 'Template not found', message: `${out.name} ${tMode} preference cleared — template not found.`, variant: 'warning' });
          useLyricsStore.getState().setModeTemplate(key, tMode, null);
        } else {
          log.warn('Skipping clear on transient load failure', { templateId, outputKey: key });
          showToast({ title: 'Template not found', message: `${out.name} ${tMode} template not found — will retry when storage is available.`, variant: 'warning' });
        }
        skipped.push(`${out.name} (missing)`);
        continue;
      }
      let rawSettings;
      try {
        rawSettings = getTemplateSettings(tpl, out);
      } catch (e) {
        log.error('getTemplateSettings threw', { templateId, outputKey: key, error: e?.message });
        skipped.push(`${out.name} (error)`);
        continue;
      }
      if (!rawSettings) {
        skipped.push(`${out.name} (no settings)`);
        continue;
      }
      // Type guards — both directions
      const isStageTemplate = 'liveFontSize' in rawSettings || 'liveColor' in rawSettings;
      const isStageOutput = out.type === 'stage';
      if (isStageOutput && !isStageTemplate) {
        log.warn('Skipping regular template for stage', { templateId, outputKey: key });
        skipped.push(`${out.name} (wrong type — pick a Stage template)`);
        continue;
      }
      if (!isStageOutput && isStageTemplate) {
        log.warn('Skipping stage template for regular output', { templateId, outputKey: key });
        skipped.push(`${out.name} (wrong type — pick a regular template)`);
        continue;
      }

      const freshState = useLyricsStore.getState();
      const settings = stripRuntimeSettings(rawSettings);
      const current = stripRuntimeSettings(getOutputSettings(freshState, key));
      const last = freshState._lastAppliedModeTemplate?.[key];
      const isSameAsCurrent = Object.keys(settings).length > 0 && Object.keys(settings).every((k) => current?.[k] === settings[k]);

      if (!options?.force && isSameAsCurrent && last?.mode === tMode && last?.templateId === templateId) {
        skipped.push(`${out.name} (already applied)`);
        continue;
      }

      // Keep original snapshot if isSame but no prior record — don't overwrite with null
      const snapshotRaw = getOutputSettings(freshState, key);
      const snapshot = JSON.parse(JSON.stringify(stripRuntimeSettings(snapshotRaw)));
      // If isSame and we have no history, don't pollute _lastApplied with null snapshot; just skip
      if (isSameAsCurrent && !options?.force && !last) {
        skipped.push(`${out.name} (already applied)`);
        continue;
      }

      // --- P1-A FIX: explicitly clear stale media keys that the new template doesn't define ---
      // Server + store both do shallow merges, so keys like backgroundImage survive
      // unless we send null. This is what caused "Bible still shows song's image".
      const payload = { ...settings };
      for (const k of CLEARABLE_KEYS) {
        if (!(k in settings) && k in current) payload[k] = null;
      }

      useLyricsStore.getState().setLastAppliedModeTemplate(key, { mode: tMode, templateId, prevSnapshot: snapshot });
      useLyricsStore.getState().updateOutputSettings(key, payload);
      try {
        emitStyleUpdate(key, payload);
      } catch (e) {
        log.error('emitStyleUpdate failed', { key, error: e?.message });
      }
      applied.push(`${out.name}: ${tpl.title || tpl.name || templateId}`);
      appliedKeys.push(key);
    }

    if (generation !== generationRef.current) return;

    if (applied.length > 0 && !options?.silent) {
      const appliedLabel = applied.join(', ');
      const skippedLabel = skipped.length ? ` · Skipped: ${skipped.join(', ')}` : '';
      const capturedKeys = [...appliedKeys];
      const capturedApplied = [...applied];
      const modeLabel = tMode === CONTENT_MODE_FREENOTE ? 'Free Notes' : tMode === CONTENT_MODE_BIBLE ? 'Bible' : 'Song';
      showToast({
        title: `${modeLabel} template applied`,
        message: `Applied to: ${appliedLabel}${skippedLabel}`,
        variant: 'success',
        duration: 4000,
        actions: [
          {
            label: 'Undo',
            onClick: () => {
              const cur = useLyricsStore.getState();
              for (const k of capturedKeys) {
                const last = cur._lastAppliedModeTemplate?.[k];
                if (last?.prevSnapshot) {
                  cur.updateOutputSettings(k, last.prevSnapshot);
                  try { emitStyleUpdate(k, last.prevSnapshot); } catch {}
                  cur.clearLastAppliedModeTemplate(k);
                }
              }
              // fallback if no prevSnapshot — still clear and notify
              showToast({ title: 'Undone', message: capturedKeys.length ? 'Restored previous styles.' : 'Nothing to undo.', variant: 'info' });
            },
          },
        ],
      });
    } else if (applied.length === 0 && skipped.length > 0 && !options?.silent) {
      // No silent failure: if all OFF/None, don't toast; if all skipped due to wrong-type/missing, give feedback
      const hasMeaningfulSkip = skipped.some((s) => s.includes('wrong type') || s.includes('missing') || s.includes('error'));
      if (hasMeaningfulSkip) {
        showToast({ title: 'No template applied', message: `Skipped: ${skipped.join(', ')}`, variant: 'warning' });
      }
    }
  }, [emitStyleUpdate, showToast]);

  const applyForSingleOutput = useCallback(async (outputKey, targetMode, options = {}) => {
    // Manual-only applier (explicit user action). No auto gating left.
    const generation = ++generationRef.current;
    const tMode = targetMode === CONTENT_MODE_FREENOTE
      ? CONTENT_MODE_FREENOTE
      : targetMode === CONTENT_MODE_BIBLE
        ? CONTENT_MODE_BIBLE
        : CONTENT_MODE_SONG;
    const freshState = useLyricsStore.getState();
    const outputs = getAllOutputs(freshState);
    const out = outputs.find((o) => o.key === outputKey);
    if (!out) {
      log.warn('reapply: output not found', { outputKey });
      return;
    }
    const cfg = freshState.modeTemplates?.[outputKey];
    if (!cfg?.enabled && !options?.manual) {
      skippedToast: showToast({ title: 'Auto-apply is off', message: `${out.name} has auto-apply disabled.`, variant: 'info' });
      return;
    }
    const templateId = cfg[tMode];
    if (!templateId || templateId === '__none__') {
      showToast({ title: 'Nothing to re-apply', message: `${out.name} has — None — for ${tMode}.`, variant: 'info' });
      return;
    }
    let userTemplatesCache = [];
    let loadSucceeded = false;
    if (window.electronAPI?.templates?.load) {
      try {
        const [outRes, stageRes] = await Promise.all([
          window.electronAPI.templates.load('output').catch(() => ({ success: false, templates: [] })),
          window.electronAPI.templates.load('stage').catch(() => ({ success: false, templates: [] })),
        ]);
        const outTpls = outRes?.success ? (outRes.templates || []) : [];
        const stgTpls = stageRes?.success ? (stageRes.templates || []) : [];
        userTemplatesCache = [...outTpls, ...stgTpls];
        loadSucceeded = Boolean(outRes?.success || stageRes?.success);
      } catch {
        userTemplatesCache = [];
      }
    }
    if (generation !== generationRef.current) return;
    let tpl = resolveTemplateForOutput(templateId, out, []);
    if (!tpl) tpl = resolveTemplateForOutput(templateId, out, userTemplatesCache);
    if (!tpl) tpl = resolveTemplateById(templateId, outputKey, userTemplatesCache);
    if (!tpl) {
      if (loadSucceeded) {
        showToast({ title: 'Template not found', message: `${out.name} ${tMode} preference cleared — template not found.`, variant: 'warning' });
        useLyricsStore.getState().setModeTemplate(outputKey, tMode, null);
      } else {
        showToast({ title: 'Template not found', message: `${out.name} template not found — will retry later.`, variant: 'warning' });
      }
      return;
    }
    let rawSettings;
    try { rawSettings = getTemplateSettings(tpl, out); } catch { showToast({ title: 'Template error', message: `${out.name} template failed to load.`, variant: 'error' }); return; }
    if (!rawSettings) return;
    const isStageTemplate = 'liveFontSize' in rawSettings || 'liveColor' in rawSettings;
    const isStageOutput = out.type === 'stage';
    if (isStageOutput && !isStageTemplate) { showToast({ title: 'Wrong type', message: `${out.name} needs a Stage template.`, variant: 'warning' }); return; }
    if (!isStageOutput && isStageTemplate) { showToast({ title: 'Wrong type', message: `${out.name} needs a regular template.`, variant: 'warning' }); return; }
    const snap = stripRuntimeSettings(getOutputSettings(freshState, outputKey));
    const settings = stripRuntimeSettings(rawSettings);
    const snapshot = JSON.parse(JSON.stringify(snap));
    const isSame = Object.keys(settings).every((k) => snap?.[k] === settings[k]);
    if (isSame && !options?.force) {
      showToast({ title: 'Already applied', message: `${out.name} already has ${tpl.title || templateId}.`, variant: 'info' });
      return;
    }
    // --- P1-A FIX (single-output path): same stale-key clearing as loop ---
    const payload = { ...settings };
    for (const k of CLEARABLE_KEYS) {
      if (!(k in settings) && k in snap) payload[k] = null;
    }
    useLyricsStore.getState().setLastAppliedModeTemplate(outputKey, { mode: tMode, templateId, prevSnapshot: snapshot });
    useLyricsStore.getState().updateOutputSettings(outputKey, payload);
    try { emitStyleUpdate(outputKey, payload); } catch {}
    if (!options?.silent) {
      const cur = useLyricsStore.getState();
      const modeLabel = tMode === CONTENT_MODE_FREENOTE ? 'Free Notes' : tMode === CONTENT_MODE_BIBLE ? 'Bible' : 'Song';
      showToast({
        title: `${modeLabel} template applied`,
        message: `Applied to: ${out.name}: ${tpl.title || templateId}`,
        variant: 'success',
        duration: 4000,
        actions: [
          {
            label: 'Undo',
            onClick: () => {
              const last = cur._lastAppliedModeTemplate?.[outputKey] || useLyricsStore.getState()._lastAppliedModeTemplate?.[outputKey];
              // use captured snapshot if available
              const toRestore = last?.prevSnapshot || snapshot;
              if (toRestore) {
                useLyricsStore.getState().updateOutputSettings(outputKey, toRestore);
                try { emitStyleUpdate(outputKey, toRestore); } catch {}
                useLyricsStore.getState().clearLastAppliedModeTemplate(outputKey);
              }
              showToast({ title: 'Undone', message: 'Restored previous styles.', variant: 'info' });
            },
          },
        ],
      });
    }
  }, [emitStyleUpdate, showToast]);

  const reapply = useCallback((outputKey, targetMode, options = {}) => {
    const m = targetMode || mode;
    // Key-scoped: only that output, not all. manual:true bypasses the
    // auto-apply OFF gate for explicit user action.
    applyForSingleOutput(outputKey, m, { force: true, ...options });
  }, [mode, applyForSingleOutput]);

  return { reapply, applyForMode, applyForSingleOutput, mode };
}

export default useOutputTemplateSync;

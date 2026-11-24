import { defaultOutput1Settings, defaultOutput2Settings, defaultStreamSettings, defaultStageSettings } from '../context/LyricsStore';
import { createLogger } from './logger.js';

const log = createLogger('OutputTemplates');

const baseOutputSettings = { ...defaultOutput1Settings };

// Stream keeps its band geometry when any template is applied to it.
const getBaseSettings = (outputKeyOrOutput) => {
  const key = typeof outputKeyOrOutput === 'object' && outputKeyOrOutput !== null
    ? (outputKeyOrOutput.key || outputKeyOrOutput.id)
    : outputKeyOrOutput;
  if (key === 'output2') return { ...defaultOutput2Settings };
  if (key === 'stream') return { ...defaultStreamSettings };
  return { ...defaultOutput1Settings };
};

export const outputTemplates = [
  {
    id: 'default',
    title: 'Default',
    description: 'Reset to default application settings with standard configuration',
    getSettings: (outputKey) => {
      return getBaseSettings(outputKey);
    }
  },
  {
    id: 'lyric-lower-third-wide',
    title: 'Lyric — Lower Third Wide',
    description: 'Wide lower-third layout for lyrics with large Bebas Neue and adaptive background band',
    getSettings: (outputKey) => {
      const base = getBaseSettings(outputKey);
      return {
        ...base,
        fontStyle: 'Bebas Neue',
        fontSize: 72,
        textAlign: 'center',
        lyricsPosition: 'lower',
        backgroundBandVerticalPadding: 30,
        backgroundBandHeightMode: 'adaptive',
        translationFontSizeMode: 'bound',
        translationFontSize: 48,
        translationLineColor: '#FBBF24',
        xMargin: 5,
        yMargin: 3,
      };
    }
  },
  {
    id: 'stream-scripture-band',
    title: 'Stream — Scripture Band',
    description: 'Transparent bottom band that auto-fits verses for OBS/vMix without covering the preacher',
    getSettings: (outputKey) => {
      const base = getBaseSettings(outputKey);
      return {
        ...base,
        fontStyle: 'Inter',
        bold: true,
        textAlign: 'center',
        fontSize: 88,
        fontColor: '#FFFFFF',
        backgroundColor: '#000000',
        backgroundOpacity: 6,
        backgroundBandVerticalPadding: 26,
        xMargin: 4,
        yMargin: 0,
        minFontSize: 20,
        maxFontSize: 220,
        fitWidthPercent: 94,
        fitHeightPercent: 94,
        bibleReferenceSize: 32,
        dropShadowOpacity: 5,
        dropShadowOffsetY: 4,
        dropShadowBlur: 12,
        lyricsPosition: 'center',
        transitionAnimation: 'fade',
        transitionSpeed: 200,
        streamBandEnabled: true,
        streamBandHeightPercent: 33,
        streamBandBackdrop: 'gradient',
        streamBandAutoFit: true,
      };
    }
  },
];

export const bibleTemplates = [
  {
    id: 'bible-reverent-serif',
    title: 'Bible — Reverent Serif',
    description: 'Elegant serif for scripture with centered layout and reference pill',
    audience: 'bible',
    getSettings: (outputKey) => {
      const base = getBaseSettings(outputKey);
      return {
        ...base,
        fontStyle: 'Cormorant Garamond',
        fontSize: 56,
        textAlign: 'center',
        lyricsPosition: 'center',
        fontColor: '#FFFFFF',
        translationLineColor: '#93C5FD',
        backgroundOpacity: 4,
        backgroundBandVerticalPadding: 24,
        bibleReferencePosition: 'bottom-center',
        bibleReferenceSize: 28,
        showBibleVersion: true,
        dropShadowOpacity: 6,
        dropShadowBlur: 12,
        dropShadowOffsetY: 6,
        lineHeight: 1.5,
      };
    },
  },
  {
    id: 'bible-scripture-bold',
    title: 'Bible — Scripture Bold',
    description: 'Bold Inter for high-contrast scripture, upper-center with amber translation',
    audience: 'bible',
    getSettings: (outputKey) => {
      const base = getBaseSettings(outputKey);
      return {
        ...base,
        fontStyle: 'Inter',
        bold: true,
        fontSize: 64,
        textAlign: 'center',
        lyricsPosition: 'upper',
        fontColor: '#FFFFFF',
        translationLineColor: '#F59E0B',
        backgroundOpacity: 2,
        bibleReferencePosition: 'bottom-center',
        bibleReferenceSize: 30,
        showBibleVersion: true,
        dropShadowOpacity: 5,
        dropShadowBlur: 8,
      };
    },
  },
  {
    id: 'bible-minimal-verse',
    title: 'Bible — Minimal Verse',
    description: 'Clean Lato for bright projectors, centered with subtle background',
    audience: 'bible',
    getSettings: (outputKey) => {
      const base = getBaseSettings(outputKey);
      return {
        ...base,
        fontStyle: 'Lato',
        fontSize: 52,
        textAlign: 'center',
        lyricsPosition: 'center',
        fontColor: '#FFFFFF',
        translationLineColor: '#A7F3D0',
        backgroundOpacity: 2,
        borderSize: 0,
        backgroundBandVerticalPadding: 20,
        bibleReferencePosition: 'bottom-center',
        bibleReferenceSize: 26,
        showBibleVersion: true,
        dropShadowOpacity: 3,
        dropShadowBlur: 6,
      };
    },
  },
  {
    id: 'bible-parallel-bilingual',
    title: 'Bible — Parallel Bilingual',
    description: 'Dual-translation parallel display with per-translation labels: side-by-side on wide screens, stacked on narrow ones',
    audience: 'bible',
    getSettings: (outputKey) => {
      const base = getBaseSettings(outputKey);
      return {
        ...base,
        fontStyle: 'Inter',
        fontSize: 54,
        textAlign: 'center',
        lyricsPosition: 'center',
        fontColor: '#FFFFFF',
        translationLineColor: '#93C5FD',
        backgroundOpacity: 4,
        backgroundBandVerticalPadding: 20,
        bibleReferencePosition: 'bottom-center',
        bibleReferenceSize: 26,
        showBibleVersion: true,
        parallelLayout: 'side-by-side',
        dropShadowOpacity: 5,
        dropShadowBlur: 8,
        lineHeight: 1.4,
      };
    },
  },
  {
    id: 'bible-stage-verse-focus',
    title: 'Stage — Verse Focus',
    description: 'Stage-optimized scripture with large reference, upcoming hidden',
    audience: 'bible',
    getSettings: (outputKeyOrOutput) => {
      const key = typeof outputKeyOrOutput === 'object' ? (outputKeyOrOutput?.key || outputKeyOrOutput?.id) : outputKeyOrOutput;
      const isStage = (() => {
        if (typeof outputKeyOrOutput === 'object' && outputKeyOrOutput !== null) {
          return outputKeyOrOutput.type === 'stage' || outputKeyOrOutput.key === 'stage' || outputKeyOrOutput.id === 'stage';
        }
        return key === 'stage';
      })();
      if (isStage) {
        return {
          ...defaultStageSettings,
          fontStyle: 'Inter',
          liveFontSize: 96,
          liveAlign: 'center',
          liveColor: '#FFFFFF',
          liveBold: true,
          nextFontSize: 48,
          nextColor: '#808080',
          prevFontSize: 36,
          showNextArrow: false,
          showUpcomingSong: false,
          bibleReferencePosition: 'bottom-center',
          bibleReferenceSize: 32,
          showBibleVersion: true,
          transitionAnimation: 'fade',
          transitionSpeed: 200,
        };
      }
      const base = getBaseSettings(key);
      return {
        ...base,
        fontStyle: 'Inter',
        fontSize: 60,
        textAlign: 'center',
        lyricsPosition: 'center',
        bibleReferenceSize: 32,
        showBibleVersion: true,
      };
    },
  },
];

export const freeNoteTemplates = [
  {
    id: 'freenote-standard',
    title: 'Free Note — Standard',
    description: 'Clean, highly readable centered text for general announcements, speaker notes, and messages',
    audience: 'freenote',
    getSettings: (outputKey) => {
      const base = getBaseSettings(outputKey);
      return {
        ...base,
        fontStyle: 'Inter',
        fontSize: 56,
        textAlign: 'center',
        lyricsPosition: 'center',
        fontColor: '#FFFFFF',
        backgroundColor: '#000000',
        backgroundOpacity: 4,
        backgroundBandVerticalPadding: 24,
        dropShadowOpacity: 5,
        dropShadowBlur: 8,
        lineHeight: 1.4,
      };
    },
  },
  {
    id: 'freenote-lower-third',
    title: 'Free Note — Lower Third',
    description: 'Lower-third banner for speaker names, sermon points, or stream overlays',
    audience: 'freenote',
    getSettings: (outputKey) => {
      const base = getBaseSettings(outputKey);
      return {
        ...base,
        fontStyle: 'Bebas Neue',
        fontSize: 64,
        textAlign: 'center',
        lyricsPosition: 'lower',
        fontColor: '#FFFFFF',
        backgroundColor: '#000000',
        backgroundOpacity: 6,
        backgroundBandVerticalPadding: 28,
        backgroundBandHeightMode: 'adaptive',
        xMargin: 5,
        yMargin: 3,
      };
    },
  },
  {
    id: 'freenote-emergency-alert',
    title: 'Free Note — Emergency Alert',
    description: 'Vibrant amber/red high-visibility emergency banner for urgent announcements',
    audience: 'freenote',
    getSettings: (outputKey) => {
      const base = getBaseSettings(outputKey);
      return {
        ...base,
        fontStyle: 'Inter',
        bold: true,
        fontSize: 68,
        textAlign: 'center',
        lyricsPosition: 'center',
        fontColor: '#FFFFFF',
        backgroundColor: '#B91C1C',
        backgroundOpacity: 10,
        backgroundBandVerticalPadding: 32,
        dropShadowOpacity: 8,
        dropShadowBlur: 14,
      };
    },
  },
  {
    id: 'freenote-quote',
    title: 'Free Note — Quote / Sermon Point',
    description: 'Serif quote layout with elegant emphasis and citation styling',
    audience: 'freenote',
    getSettings: (outputKey) => {
      const base = getBaseSettings(outputKey);
      return {
        ...base,
        fontStyle: 'Cormorant Garamond',
        italic: true,
        fontSize: 60,
        textAlign: 'center',
        lyricsPosition: 'center',
        fontColor: '#FDFBF7',
        backgroundColor: '#0A0A0A',
        backgroundOpacity: 5,
        backgroundBandVerticalPadding: 26,
        dropShadowOpacity: 4,
        dropShadowBlur: 10,
        lineHeight: 1.5,
      };
    },
  },
  {
    id: 'freenote-stage-focus',
    title: 'Stage — Note Focus',
    description: 'Confidence monitor view for speaker notes and announcements with high visibility',
    audience: 'freenote',
    getSettings: (outputKeyOrOutput) => {
      const key = typeof outputKeyOrOutput === 'object' ? (outputKeyOrOutput?.key || outputKeyOrOutput?.id) : outputKeyOrOutput;
      const isStage = (() => {
        if (typeof outputKeyOrOutput === 'object' && outputKeyOrOutput !== null) {
          return outputKeyOrOutput.type === 'stage' || outputKeyOrOutput.key === 'stage' || outputKeyOrOutput.id === 'stage';
        }
        return key === 'stage';
      })();
      if (isStage) {
        return {
          ...defaultStageSettings,
          fontStyle: 'Inter',
          liveFontSize: 96,
          liveAlign: 'center',
          liveColor: '#FBBF24',
          liveBold: true,
          nextFontSize: 40,
          nextColor: '#808080',
          prevFontSize: 32,
          showNextArrow: false,
          showUpcomingSong: false,
          transitionAnimation: 'fade',
          transitionSpeed: 200,
        };
      }
      const base = getBaseSettings(key);
      return {
        ...base,
        fontStyle: 'Inter',
        fontSize: 60,
        textAlign: 'center',
        lyricsPosition: 'center',
      };
    },
  },
  {
    id: 'freenote-stage-alert',
    title: 'Stage — Alert Banner',
    description: 'Stage confidence monitor urgent cue or alert banner',
    audience: 'freenote',
    getSettings: (outputKeyOrOutput) => {
      const key = typeof outputKeyOrOutput === 'object' ? (outputKeyOrOutput?.key || outputKeyOrOutput?.id) : outputKeyOrOutput;
      const isStage = (() => {
        if (typeof outputKeyOrOutput === 'object' && outputKeyOrOutput !== null) {
          return outputKeyOrOutput.type === 'stage' || outputKeyOrOutput.key === 'stage' || outputKeyOrOutput.id === 'stage';
        }
        return key === 'stage';
      })();
      if (isStage) {
        return {
          ...defaultStageSettings,
          fontStyle: 'Inter',
          backgroundColor: '#450A0A',
          liveFontSize: 104,
          liveAlign: 'center',
          liveColor: '#FEF2F2',
          liveBold: true,
          nextFontSize: 0,
          prevFontSize: 0,
          showNextArrow: false,
          showUpcomingSong: false,
          transitionAnimation: 'none',
        };
      }
      const base = getBaseSettings(key);
      return {
        ...base,
        fontStyle: 'Inter',
        bold: true,
        fontSize: 68,
        textAlign: 'center',
        lyricsPosition: 'center',
        backgroundColor: '#B91C1C',
      };
    },
  },
];

const baseStageSettings = { ...defaultStageSettings };

export const stageTemplates = [
  {
    id: 'default',
    title: 'Default',
    description: 'Reset to default stage display settings with standard configuration',
    settings: { ...defaultStageSettings }
  },
  {
    id: 'stage-chord-chart',
    title: 'Chord Chart (Music Stand)',
    description: 'Mono-friendly stage view with chord charts, key badge, and transpose controls for the band. Lyric-only songs are unaffected.',
    settings: {
      ...baseStageSettings,
      fontStyle: 'Inter',
      liveFontSize: 72,
      liveAlign: 'left',
      nextFontSize: 44,
      nextAlign: 'left',
      prevFontSize: 32,
      prevAlign: 'left',
      showChordChart: true,
      chordTranspose: 0,
      chordNotation: 'letters',
      showTopBar: true,
      showUpcomingSong: true,
      transitionAnimation: 'fade',
      transitionSpeed: 200,
    }
  },
  {
    id: 'stage-classic',
    title: 'Classic Stage',
    description: 'Traditional three-line display with clear current/next/previous distinction',
    settings: {
      ...baseStageSettings,
      fontStyle: 'Inter',
      liveFontSize: 72,
      liveAlign: 'center',
      nextFontSize: 48,
      nextColor: '#A0A0A0',
      nextAlign: 'center',
      nextArrowColor: '#4ADE80',
      prevFontSize: 36,
      prevColor: '#606060',
      prevAlign: 'center',
      upcomingSongSize: 20,
      upcomingSongColor: '#A0A0A0',
      bottomBarSize: 18,
      transitionAnimation: 'fade',
      transitionSpeed: 200,
    }
  },
  {
    id: 'stage-minimal',
    title: 'Minimal Focus',
    description: 'Emphasizes current line with minimal distractions, subtle next line preview',
    settings: {
      ...baseStageSettings,
      fontStyle: 'Lato',
      backgroundColor: '#0A0A0A',
      liveFontSize: 84,
      liveAlign: 'center',
      nextFontSize: 40,
      nextColor: '#707070',
      nextItalic: true,
      nextAlign: 'center',
      showNextArrow: false,
      prevFontSize: 32,
      prevColor: '#404040',
      prevAlign: 'center',
      currentSongSize: 20,
      currentSongColor: '#E0E0E0',
      upcomingSongSize: 18,
      upcomingSongColor: '#808080',
      showTime: false,
      bottomBarSize: 16,
      bottomBarColor: '#C0C0C0',
      transitionAnimation: 'slide',
      transitionSpeed: 300,
      messageScrollSpeed: 4000,
    }
  },
  {
    id: 'stage-colorful',
    title: 'Colorful Guide',
    description: 'Color-coded lines for easy tracking with vibrant next-line indicator',
    settings: {
      ...baseStageSettings,
      fontStyle: 'Poppins',
      backgroundColor: '#1A1A2E',
      liveFontSize: 68,
      liveColor: '#60A5FA',
      liveAlign: 'center',
      nextFontSize: 52,
      nextColor: '#34D399',
      nextAlign: 'center',
      nextArrowColor: '#10B981',
      prevFontSize: 38,
      prevColor: '#9CA3AF',
      prevAlign: 'center',
      currentSongSize: 22,
      currentSongColor: '#F3F4F6',
      upcomingSongSize: 20,
      upcomingSongColor: '#D1D5DB',
      bottomBarSize: 18,
      bottomBarColor: '#E5E7EB',
      transitionAnimation: 'fade',
      transitionSpeed: 250,
      messageScrollSpeed: 3500,
    }
  },
  {
    id: 'stage-large-text',
    title: 'Large Text',
    description: 'Extra large fonts for visibility from distance, ideal for large stages',
    settings: {
      ...baseStageSettings,
      fontStyle: 'Roboto',
      liveFontSize: 96,
      liveAllCaps: true,
      liveAlign: 'center',
      nextFontSize: 56,
      nextColor: '#B0B0B0',
      nextAlign: 'center',
      nextArrowColor: '#22C55E',
      prevFontSize: 40,
      prevColor: '#707070',
      prevAlign: 'center',
      currentSongSize: 28,
      upcomingSongSize: 24,
      upcomingSongColor: '#B0B0B0',
      bottomBarSize: 20,
      transitionAnimation: 'fade',
      transitionSpeed: 150,
      messageScrollSpeed: 2500,
    }
  },
  {
    id: 'stage-compact',
    title: 'Compact View',
    description: 'Balanced sizing for smaller stages or confidence monitors',
    settings: {
      ...baseStageSettings,
      fontStyle: 'Open Sans',
      backgroundColor: '#121212',
      liveFontSize: 60,
      liveAlign: 'center',
      nextFontSize: 44,
      nextColor: '#9CA3AF',
      nextAlign: 'center',
      nextArrowColor: '#3B82F6',
      prevFontSize: 36,
      prevColor: '#6B7280',
      prevAlign: 'center',
      currentSongSize: 20,
      currentSongColor: '#F9FAFB',
      upcomingSongSize: 18,
      upcomingSongColor: '#9CA3AF',
      bottomBarSize: 16,
      bottomBarColor: '#D1D5DB',
      transitionAnimation: 'slide',
      transitionSpeed: 200,
    }
  },
];

export function resolveTemplateById(templateId, outputKey, userTemplates = []) {
  if (!templateId) return null;
  if (templateId === 'default') {
    return {
      id: 'default',
      title: 'Default',
      getSettings: (k) => {
        if (k === 'stage') return { ...defaultStageSettings };
        // custom outputs: caller should pass the correct base via getTemplateSettings fallback.
        return getBaseSettings(k);
      },
      settings: outputKey === 'stage' ? { ...defaultStageSettings } : getBaseSettings(outputKey),
    };
  }
  const allBuiltIns = [...outputTemplates, ...bibleTemplates, ...freeNoteTemplates, ...stageTemplates];
  const found = allBuiltIns.find((t) => t.id === templateId);
  if (found) return found;
  const user = (userTemplates || []).find((t) => t.id === templateId);
  if (user) return user;
  return null;
}

export function resolveTemplateForOutput(templateId, output, userTemplates = []) {
  if (!templateId) return null;
  if (templateId === 'default') {
    const key = output?.key || output?.id || 'output1';
    const isStage = output?.type === 'stage' || key === 'stage';
    return {
      id: 'default',
      title: 'Default',
      getSettings: () => isStage ? { ...defaultStageSettings } : getBaseSettings(key),
      settings: isStage ? { ...defaultStageSettings } : getBaseSettings(key),
    };
  }
  const allBuiltIns = [...outputTemplates, ...bibleTemplates, ...freeNoteTemplates, ...stageTemplates];
  const found = allBuiltIns.find((t) => t.id === templateId);
  if (found) return found;
  const user = (userTemplates || []).find((t) => t.id === templateId);
  if (user) return user;
  return null;
}

export function getTemplateSettings(template, outputKeyOrOutput) {
  if (!template) return null;
  const key = typeof outputKeyOrOutput === 'object' ? (outputKeyOrOutput?.key || outputKeyOrOutput?.id) : outputKeyOrOutput;
  if (typeof template.getSettings === 'function') {
    try {
      const primary = template.getSettings(outputKeyOrOutput);
      if (primary) return primary;
    } catch {}
    try {
      return template.getSettings(key) || null;
    } catch {
      return null;
    }
  }
  return template.settings || null;
}

export function allOutputTemplatesForOutput(outputKeyOrOutput, userTemplates = []) {
  const isStage = (() => {
    if (typeof outputKeyOrOutput === 'object' && outputKeyOrOutput !== null) return outputKeyOrOutput.type === 'stage';
    return outputKeyOrOutput === 'stage' || String(outputKeyOrOutput).startsWith('custom_') && false;
  })();
  // When caller passes custom_ string without type, we cannot know — fall back to key-based check via stageTemplates length probe.
  // Best-effort: if string starts with custom_, treat as unknown and return both pools filtered; caller should pass object.
  const keyStr = typeof outputKeyOrOutput === 'string' ? outputKeyOrOutput : outputKeyOrOutput?.key || '';
  const isCustomStageByKey = keyStr.startsWith('custom_') && (typeof outputKeyOrOutput === 'object' ? outputKeyOrOutput.type === 'stage' : false);
  const effectiveIsStage = isStage || isCustomStageByKey;

  // Filter user templates by shape to avoid type-leak
  const userStage = (userTemplates || []).filter((t) => {
    const s = t.settings || (typeof t.getSettings === 'function' ? (() => { try { return t.getSettings({ type: 'stage', key: 'stage' }); } catch { return null; } })() : null);
    return s && ('liveFontSize' in s || 'liveColor' in s);
  });
  const userRegular = (userTemplates || []).filter((t) => {
    const s = t.settings || (typeof t.getSettings === 'function' ? (() => { try { return t.getSettings('output1'); } catch { return null; } })() : null);
    return !s || !('liveFontSize' in s);
  });

  if (effectiveIsStage) {
    return [
      ...stageTemplates,
      ...bibleTemplates.filter((t) => t.id.includes('stage')),
      ...freeNoteTemplates.filter((t) => t.id.includes('stage')),
      ...userStage,
    ];
  }
  // For custom_ with unknown type, include only regular pool (safe) — stage caller must pass object with type
  if (keyStr.startsWith('custom_') && !effectiveIsStage) {
    // unknown custom — include regular filtered
    return [
      ...outputTemplates,
      ...bibleTemplates.filter((t) => !t.id.includes('stage')),
      ...freeNoteTemplates.filter((t) => !t.id.includes('stage')),
      ...userRegular,
    ];
  }
  return [
    ...outputTemplates,
    ...bibleTemplates.filter((t) => !t.id.includes('stage')),
    ...freeNoteTemplates.filter((t) => !t.id.includes('stage')),
    ...userRegular,
  ];
}

export function getAllKnownTemplateIds(userTemplates = []) {
  const builtIns = [...outputTemplates, ...bibleTemplates, ...freeNoteTemplates, ...stageTemplates].map((t) => t.id);
  const userIds = (userTemplates || []).map((t) => t.id);
  return [...builtIns, ...userIds];
}

log.debug('Loaded output templates', { outputCount: outputTemplates.length, bibleCount: bibleTemplates.length, freeNoteCount: freeNoteTemplates.length, stageCount: stageTemplates.length });
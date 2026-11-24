import { describe, expect, it } from 'vitest';
import {
  outputTemplates,
  bibleTemplates,
  freeNoteTemplates,
  getTemplateSettings,
  resolveTemplateById,
  resolveTemplateForOutput,
} from '../outputTemplates.js';

const STREAM_OUTPUT = { key: 'stream', id: 'stream', slug: 'stream', type: 'stream' };

describe('stream band template preservation', () => {
  it('keeps the band on when a built-in template is applied to the stream object', () => {
    for (const template of [...outputTemplates, ...bibleTemplates, ...freeNoteTemplates]) {
      const settings = getTemplateSettings(template, STREAM_OUTPUT);
      expect(settings, template.id).toBeTruthy();
      expect(settings.streamBandEnabled, template.id).toBe(true);
      expect(settings.streamBandHeightPercent, template.id).toBe(33);
    }
  });

  it('keeps the band on when a built-in template is applied by stream key', () => {
    for (const template of [...outputTemplates, ...bibleTemplates, ...freeNoteTemplates]) {
      const settings = getTemplateSettings(template, 'stream');
      expect(settings?.streamBandEnabled, template.id).toBe(true);
    }
  });

  it('resolves the default fallback to stream band geometry in both template helpers', () => {
    const byId = resolveTemplateById('default', 'stream');
    const byOutput = resolveTemplateForOutput('default', STREAM_OUTPUT);

    expect(getTemplateSettings(byId, STREAM_OUTPUT).streamBandEnabled).toBe(true);
    expect(getTemplateSettings(byOutput, STREAM_OUTPUT).streamBandEnabled).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import {
  outputTemplates,
  bibleTemplates,
  freeNoteTemplates,
  getTemplateSettings,
  resolveTemplateForOutput,
} from '../../server/utils/modeTemplates.js';

const STREAM_OUTPUT = { key: 'stream', id: 'stream', slug: 'stream', type: 'stream' };

describe('server stream band template preservation', () => {
  it('keeps band geometry when any server template resolves for stream', () => {
    for (const template of [...outputTemplates, ...bibleTemplates, ...freeNoteTemplates]) {
      const settings = getTemplateSettings(template, STREAM_OUTPUT);
      expect(settings, template.id).toBeTruthy();
      expect(settings.streamBandEnabled, template.id).toBe(true);
    }
  });

  it('resolves the server default fallback to stream band geometry', () => {
    const template = resolveTemplateForOutput('default', STREAM_OUTPUT);
    expect(getTemplateSettings(template, STREAM_OUTPUT).streamBandEnabled).toBe(true);
  });
});

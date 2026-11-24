import { describe, expect, it } from 'vitest';
import {
  STREAM_BAND_DEFAULT_PERCENT,
  STREAM_BAND_MAX_PERCENT,
  STREAM_BAND_MIN_PERCENT,
  getStreamBandBackdropStyle,
  getStreamBandReferenceFontSize,
  getStreamBandReferenceReserve,
  normalizeStreamBandBackdrop,
  normalizeStreamBandHeightPercent,
} from '../streamBand.js';

describe('stream band geometry', () => {
  it('keeps the band height inside the safe range', () => {
    expect(normalizeStreamBandHeightPercent(50)).toBe(50);
    expect(normalizeStreamBandHeightPercent('33')).toBe(33);
    expect(normalizeStreamBandHeightPercent(5)).toBe(STREAM_BAND_MIN_PERCENT);
    expect(normalizeStreamBandHeightPercent(95)).toBe(STREAM_BAND_MAX_PERCENT);
    expect(normalizeStreamBandHeightPercent('garbage')).toBe(STREAM_BAND_DEFAULT_PERCENT);
  });

  it('normalizes unknown backdrops to the gradient default', () => {
    expect(normalizeStreamBandBackdrop('solid')).toBe('solid');
    expect(normalizeStreamBandBackdrop('none')).toBe('none');
    expect(normalizeStreamBandBackdrop('neon')).toBe('gradient');
  });

  it('builds a soft gradient that fades to fully transparent at the top', () => {
    const style = getStreamBandBackdropStyle({
      backdrop: 'gradient',
      backgroundColor: '#102030',
      backgroundOpacity: 6,
    });

    expect(style.background).toContain('linear-gradient(to top, #10203099');
    expect(style.background).toContain('#10203000');
  });

  it('builds solid and none backdrops from the configured colour and strength', () => {
    expect(getStreamBandBackdropStyle({
      backdrop: 'solid',
      backgroundColor: '#ABCDEF',
      backgroundOpacity: 10,
    }).background).toBe('#ABCDEFff');

    expect(getStreamBandBackdropStyle({
      backdrop: 'none',
      backgroundColor: '#000000',
      backgroundOpacity: 10,
    }).background).toBe('transparent');

    expect(getStreamBandBackdropStyle({
      backdrop: 'solid',
      backgroundColor: '#000000',
      backgroundOpacity: 0,
    }).background).toBe('transparent');
  });

  it('reserves height for the verse reference but never for songs', () => {
    expect(getStreamBandReferenceReserve(300, false)).toBe(0);
    expect(getStreamBandReferenceReserve(0, true)).toBe(0);
    expect(getStreamBandReferenceReserve(300, true)).toBe(54);
    expect(getStreamBandReferenceReserve(100, true)).toBe(26);
  });

  it('keeps the reference comfortably below the fitted body font', () => {
    const small = getStreamBandReferenceFontSize({
      bodyFontSize: 24,
      contentHeight: 300,
      preferredSize: 32,
      hasReference: true,
    });
    const large = getStreamBandReferenceFontSize({
      bodyFontSize: 200,
      contentHeight: 300,
      preferredSize: 32,
      hasReference: true,
    });

    expect(small).toBeGreaterThanOrEqual(16);
    expect(large).toBeLessThanOrEqual(32);
    expect(getStreamBandReferenceFontSize({ hasReference: false })).toBe(0);
  });
});

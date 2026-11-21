import { describe, it, expect } from 'vitest';
import {
  SERVICE_LOG_DIR,
  serviceDayStamp,
  serviceLogFileName,
  normalizeServiceVerseReference,
  serviceClockLabel,
  formatServiceLogLine,
} from '../shared/serviceVerseLog.js';

describe('service verse log naming (shared)', () => {
  it('stamps the local calendar day, not UTC', () => {
    // Noon local on a Sunday stays that Sunday whatever the timezone.
    const sunday = new Date(2026, 10, 22, 12, 0, 0);
    expect(serviceDayStamp(sunday)).toBe('2026-11-22');
    expect(serviceDayStamp(new Date('invalid'))).toBe('');
  });

  it('names one file per service day', () => {
    expect(serviceLogFileName(new Date(2026, 10, 22, 12, 0, 0))).toBe('service-2026-11-22.txt');
  });

  it('uses the service-logs directory under the app data root', () => {
    expect(SERVICE_LOG_DIR).toBe('service-logs');
  });

  it('normalizes references to trimmed strings', () => {
    expect(normalizeServiceVerseReference('  John 3:16 ')).toBe('John 3:16');
    expect(normalizeServiceVerseReference(null)).toBe('');
    expect(normalizeServiceVerseReference(42)).toBe('');
  });

  it('formats a human-readable line with clock, reference, and translation', () => {
    const line = formatServiceLogLine({
      at: new Date(2026, 10, 22, 9, 42, 15),
      reference: 'John 3:16',
      bible: 'KJV',
    });
    expect(line).toBe('[09:42:15] John 3:16 (KJV)');
  });

  it('omits the translation when unknown', () => {
    const line = formatServiceLogLine({ at: new Date(2026, 10, 22, 9, 42, 15), reference: 'John 3:16' });
    expect(line).toBe('[09:42:15] John 3:16');
  });

  it('labels the clock locally', () => {
    expect(serviceClockLabel(new Date(2026, 10, 22, 9, 5, 7))).toBe('09:05:07');
    expect(serviceClockLabel('nope')).toBe('--:--:--');
  });
});

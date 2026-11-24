/**
 * Live-stream lower-third geometry.
 *
 * A stream band is not a smaller full-screen output: it is a transparent
 * browser source where only the bottom slice paints. The camera keeps every
 * pixel above it, and the verse auto-fits inside the slice instead of
 * covering the preacher.
 */

export const STREAM_BAND_MIN_PERCENT = 15;
export const STREAM_BAND_MAX_PERCENT = 80;
export const STREAM_BAND_DEFAULT_PERCENT = 33;

export const STREAM_BAND_BACKDROPS = ['gradient', 'solid', 'none'];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function normalizeStreamBandHeightPercent(value, fallback = STREAM_BAND_DEFAULT_PERCENT) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.round(clamp(parsed, STREAM_BAND_MIN_PERCENT, STREAM_BAND_MAX_PERCENT));
}

export function normalizeStreamBandBackdrop(value, fallback = 'gradient') {
  const normalized = String(value || '').toLowerCase();
  if (STREAM_BAND_BACKDROPS.includes(normalized)) return normalized;
  return fallback;
}

function normalizeHexColor(color) {
  const value = String(color || '');
  return /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000';
}

function opacityHex(value) {
  const strength = clamp(Number(value) || 0, 0, 10);
  return Math.round((strength / 10) * 255).toString(16).padStart(2, '0');
}

/**
 * The band's visible backing. A soft gradient keeps the camera readable at
 * the top edge while guaranteeing contrast for white verse text at the
 * bottom. Solid and none exist for churches with their own broadcast frame.
 */
export function getStreamBandBackdropStyle({
  backdrop = 'gradient',
  backgroundColor = '#000000',
  backgroundOpacity = 0,
} = {}) {
  const mode = normalizeStreamBandBackdrop(backdrop);
  const hex = normalizeHexColor(backgroundColor);
  const alpha = opacityHex(backgroundOpacity);

  if (mode === 'none' || alpha === '00') {
    return { background: 'transparent' };
  }

  if (mode === 'solid') {
    return { background: `${hex}${alpha}` };
  }

  const middle = Math.round((parseInt(alpha, 16) * 0.55)).toString(16).padStart(2, '0');
  return {
    background: `linear-gradient(to top, ${hex}${alpha} 0%, ${hex}${middle} 62%, ${hex}00 100%)`,
  };
}

/**
 * Height reserved inside the band for the verse reference. The reference is
 * laid out after the fitted body text, so the auto-sizer must not spend the
 * whole band on the verse and push the reference into the camera.
 */
export function getStreamBandReferenceReserve(contentHeight, hasReference) {
  const height = Number(contentHeight);
  if (!hasReference || !Number.isFinite(height) || height <= 0) return 0;

  const preferred = height * 0.18;
  return Math.round(Math.min(height * 0.34, Math.max(26, Math.min(84, preferred))));
}

export function getStreamBandReferenceFontSize({
  bodyFontSize,
  contentHeight,
  preferredSize = 32,
  hasReference = true,
} = {}) {
  if (!hasReference) return 0;

  const reserve = getStreamBandReferenceReserve(contentHeight, true);
  const cap = Math.max(14, Math.min(Number(preferredSize) || 32, reserve * 0.7));
  const scaled = Math.max(16, (Number(bodyFontSize) || 0) * 0.32);
  return Math.round(Math.min(cap, scaled));
}

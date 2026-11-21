import React, { useMemo, useState } from 'react';
import { CheckCircle2, ChevronDown, Cpu } from 'lucide-react';
import { SPEECH_PROVIDERS } from 'shared/speech';
import useSpeechStore from '../../context/SpeechStore';
import useToast from '../../hooks/useToast';

// ---------------------------------------------------------------------------
// ProviderPicker — the local "who" axis.
//
// The plan: a short recommended list for the detected platform plus a
// "Show all providers" disclosure. Six providers in a flat list reads as a
// warning label; a recommended two plus a disclosure reads as a choice.
//
// `osondevice` (needsNoInstall) is always surfaced in the recommended pair
// because for a user who just wants local, "nothing to install" is the answer.
// Capability gaps are stated inline, never silently dropped (plan 8.2).
// ---------------------------------------------------------------------------

const detectPlatform = () => {
  if (typeof navigator === 'undefined') return null;
  try {
    const haystack = `${navigator.userAgent || ''} ${navigator.platform || ''}`.toLowerCase();
    if (haystack.includes('mac') || haystack.includes('iphone') || haystack.includes('ipad')) {
      return 'mac';
    }
    if (haystack.includes('win')) return 'win';
    if (haystack.includes('linux') || haystack.includes('x11') || haystack.includes('android')) {
      return 'linux';
    }
  } catch {
    return null;
  }
  return null;
};

const PLATFORM_LABELS = { mac: 'macOS', win: 'Windows', linux: 'Linux' };

// true | false | null -> "yes" | "no" | "unknown". null is NEVER rendered as
// "no": an unreported capability is not a missing one.
const capabilityLabel = (value) => {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  return 'unknown';
};

const CapabilityChip = ({ darkMode, label, value }) => (
  <span
    className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
      value === true
        ? darkMode
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
          : 'border-emerald-200 bg-emerald-50 text-emerald-700'
        : value === false
          ? darkMode
            ? 'border-gray-700 bg-gray-900 text-gray-400'
            : 'border-gray-200 bg-gray-100 text-gray-500'
          : darkMode
            ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
            : 'border-amber-200 bg-amber-50 text-amber-700'
    }`}
    title={value === null ? 'Not reported until the engine connects' : undefined}
  >
    {label}: {capabilityLabel(value)}
  </span>
);

const ProviderPicker = ({ darkMode = false }) => {
  const providerId = useSpeechStore((state) => state.providerId);
  const setProviderId = useSpeechStore((state) => state.setProviderId);
  const status = useSpeechStore((state) => state.status);
  const health = useSpeechStore((state) => state.health);
  const isLive = status === 'starting' || status === 'listening' || status === 'transcribing' || Boolean(health);
  const { showToast } = useToast();
  const [showAll, setShowAll] = useState(false);

  const chooseProvider = (id) => {
    if (id === providerId) return;
    if (isLive) {
      showToast({
        title: 'Stop the microphone first',
        message: 'Changing the speech engine while listening would leave audio on the old engine under a new label.',
        variant: 'warning',
      });
      return;
    }
    setProviderId(id);
  };

  const platform = useMemo(() => detectPlatform(), []);

  const recommended = useMemo(
    () => SPEECH_PROVIDERS.filter((provider) => provider.isDefault || provider.needsNoInstall),
    []
  );
  const recommendedIds = useMemo(
    () => recommended.map((provider) => provider.id),
    [recommended]
  );
  const rest = useMemo(
    () => SPEECH_PROVIDERS.filter((provider) => !recommendedIds.includes(provider.id)),
    [recommendedIds]
  );

  const selectedProvider =
    SPEECH_PROVIDERS.find((provider) => provider.id === providerId) ?? null;

  const cardClass = `rounded-xl border p-5 space-y-4 transition-all ${
    darkMode ? 'border-gray-800 bg-gray-900/50' : 'border-gray-200 bg-white'
  }`;
  const labelClass = `text-sm font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`;
  const mutedClass = `text-xs leading-relaxed ${darkMode ? 'text-gray-400' : 'text-gray-600'}`;
  const badgeBase = 'text-[10px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded-full';

  // Capability gating (plan 8.2): every gap is stated with its consequence.
  const gatingReasons = [];
  if (selectedProvider) {
    if (selectedProvider.wordTimestamps === false) {
      gatingReasons.push(
        "This provider can't align words to audio, so next-lyric suggestions are disabled."
      );
    }
    if (selectedProvider.biasSupport === false) {
      gatingReasons.push(
        'Sermon profile biasing (hymn titles, proper nouns) is unavailable, so accuracy will be lower on church audio.'
      );
    }
    if (
      selectedProvider.wordTimestamps === null ||
      selectedProvider.biasSupport === null ||
      selectedProvider.streaming === null
    ) {
      gatingReasons.push(
        'Capabilities are reported by the engine when it connects — unknown until then.'
      );
    }
  }

  const renderProvider = (provider, isSelected) => {
    const unavailableHere =
      platform !== null && Array.isArray(provider.platforms) && !provider.platforms.includes(platform);

    return (
      <div
        key={provider.id}
        className={`rounded-lg border transition-colors ${
          isSelected
            ? darkMode
              ? 'border-[#7DDBD3] bg-[#7DDBD3]/10'
              : 'border-[#1a5c54] bg-[#7DDBD3]/10'
            : darkMode
              ? 'border-gray-800 bg-gray-900/40'
              : 'border-gray-200 bg-white'
        }`}
      >
        <button
          type="button"
          role="radio"
          aria-checked={isSelected}
          data-testid={`speech-provider-${provider.id}`}
          onClick={() => chooseProvider(provider.id)}
          className="w-full text-left p-3 space-y-2"
        >
          <span className="flex items-center gap-2 flex-wrap">
            <span className={`text-sm font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              {provider.name}
            </span>
            {provider.needsNoInstall && (
              <span
                className={`${badgeBase} ${
                  darkMode
                    ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                    : 'bg-emerald-100 text-emerald-800 border border-emerald-200'
                }`}
              >
                No install needed
              </span>
            )}
            {provider.isDefault && (
              <span
                className={`${badgeBase} ${
                  darkMode
                    ? 'bg-blue-500/15 text-blue-300 border border-blue-500/30'
                    : 'bg-blue-100 text-blue-800 border border-blue-200'
                }`}
              >
                Default
              </span>
            )}
            {isSelected && (
              <CheckCircle2 className="w-4 h-4 shrink-0 text-[#7DDBD3]" aria-hidden="true" />
            )}
          </span>
          <span className={`block text-xs leading-relaxed ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
            {provider.description}
          </span>
          <span className={`block text-[11px] ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>
            Requires: {provider.requires ?? 'nothing extra'} · Reads:{' '}
            {(provider.reads ?? []).length ? provider.reads.join(', ') : 'no downloadable format'}
            {' · '}Licence: {provider.license}
            {unavailableHere
              ? ` · Not available on ${PLATFORM_LABELS[platform] ?? platform}`
              : ''}
          </span>
          <span className="flex items-center gap-1.5 flex-wrap">
            <CapabilityChip darkMode={darkMode} label="Word timestamps" value={provider.wordTimestamps} />
            <CapabilityChip darkMode={darkMode} label="Prompt bias" value={provider.biasSupport} />
            <CapabilityChip darkMode={darkMode} label="Streaming" value={provider.streaming} />
          </span>
        </button>

        {isSelected && gatingReasons.length > 0 && (
          <div
            className={`mx-3 mb-3 rounded-md border p-2.5 text-[11px] leading-relaxed space-y-1 ${
              darkMode
                ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                : 'border-amber-200 bg-amber-50 text-amber-800'
            }`}
          >
            {gatingReasons.map((reason) => (
              <p key={reason}>{reason}</p>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={cardClass}>
      <div className="space-y-1.5">
        <span className={labelClass}>Engine (provider)</span>
        <p className={mutedClass}>
          Which speech engine runs the transcription
          {platform ? ` on ${PLATFORM_LABELS[platform] ?? platform}` : ''}. Recommended first —
          the rest are behind the disclosure.
        </p>
      </div>

      <div role="radiogroup" aria-label="Recommended providers" className="space-y-2">
        {recommended.map((provider) => renderProvider(provider, provider.id === providerId))}
      </div>

      <div>
        <button
          type="button"
          aria-expanded={showAll}
          onClick={() => setShowAll((previous) => !previous)}
          className={`inline-flex items-center gap-1.5 text-xs font-semibold transition-colors ${
            darkMode ? 'text-[#7DDBD3] hover:text-white' : 'text-[#1a5c54] hover:text-black'
          }`}
        >
          <ChevronDown
            className={`w-3.5 h-3.5 transition-transform ${showAll ? 'rotate-180' : ''}`}
            aria-hidden="true"
          />
          Show all providers
        </button>
      </div>

      {showAll && (
        <div role="radiogroup" aria-label="All other providers" className="space-y-2">
          {rest.map((provider) => renderProvider(provider, provider.id === providerId))}
        </div>
      )}

      {selectedProvider && (
        <p className={`flex items-start gap-1.5 text-[11px] ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>
          <Cpu className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
          Selected engine: {selectedProvider.name}. Model choices below are filtered to what this
          engine can read.
        </p>
      )}
    </div>
  );
};

export default ProviderPicker;

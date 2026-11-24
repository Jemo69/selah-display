export const ONBOARDING_SEEN_KEY = 'selah-onboarding-seen-v1';

export const TOUR_STEPS = [
  {
    id: 'library',
    icon: '📚',
    title: 'Songs, Bible & Notes library',
    body: 'Left sidebar tabs switch what you browse: Songs (lyrics files), Bible (translations, passages, verse slides), and Notes (free notes for announcements). Loading anything here stages it — it does not go live until you fire a line.',
    tip: 'Try: Bible tab → pick a translation → click a verse.',
  },
  {
    id: 'live',
    icon: '🔴',
    title: 'The Live declarer pill',
    body: 'The amber Song / Bible pill next to the tabs declares what is actually on display and applies that mode\'s output templates. The app never guesses — you declare it. Clicking a library tab also declares that mode.',
    tip: 'Try: switch the pill and watch output styling change.',
  },
  {
    id: 'lyrics',
    icon: '🎵',
    title: 'Lyrics list = your clicker',
    body: 'Each row is a slide. Click (or arrow keys / Space) to fire it to all live outputs. The highlighted row is what the congregation sees. Right side shows preview vs live.',
    tip: 'Try: load a song, press ↓ to step through slides.',
  },
  {
    id: 'outputs',
    icon: '🖥️',
    title: 'Outputs 1, 2, Stage & custom',
    body: 'Right panel tabs configure each output: fonts, colors, backgrounds, ticker, templates. /stream is a ready-made transparent lower-third band; create custom outputs under their own URL when you need another surface for OBS browser sources. Stage shows the next line for musicians.',
    tip: 'Try: Output Settings → duplicate styling via templates.',
  },
  {
    id: 'show',
    icon: '🎬',
    title: 'Show control: LIVE / CLEAR / BLACKOUT / LOGO',
    body: 'The show dock (bottom bar) cuts between states without losing your place. CLEAR blanks lyrics but keeps background; BLACKOUT kills everything; LOGO parks on your logo. The master toggle maps to ON/OFF on the same machine.',
    tip: 'Try: press C to clear, L to go live again.',
  },
  {
    id: 'setlist',
    icon: '📋',
    title: 'Setlists & schedules',
    body: 'Setlist modal (ListMusic icon) orders your service: songs, Bible refs, notes. Prev/Next buttons walk the plan hands-free. The Schedule panel adds timed run-sheets with auto-advance.',
    tip: 'Try: add the loaded song with the + button, then open the setlist.',
  },
  {
    id: 'stream',
    icon: '📡',
    title: 'Streaming & remote control',
    body: 'Every output is a URL (/output1, /stage…) — paste into OBS as a browser source. Phones/tablets open the remote control page to fire slides over the network. Connection status lives in the header.',
    tip: 'Try: User Preferences → Outputs to find URLs.',
  },
  {
    id: 'extras',
    icon: '✨',
    title: 'Power tools',
    body: 'Autoplay & intelligent autoplay advance slides on timers or audio. HTTP actions fire companion apps (lighting, ATEM) per slide. MIDI/OSC hardware triggers slides. Sermon Assist transcribes speech into live captions.',
    tip: 'Try: Metronome bar, Autoplay settings, HTTP actions.',
  },
];

const APP_CONTEXT = `Selah is a free, local-first worship & live-event display app (Electron + web). Core model:
- A control panel (this screen) stages content; outputs are separate browser-source URLs (/output1, /output2, /stream, /stage, plus custom outputs) consumed by OBS/vMix/projectors.
- Three content modes: SONGS (lyric slides, .txt/.lrc/.pro/.sng with timestamps, sections, chords), BIBLE (imported translations .xml/.json, passage picker, verse slides, parallel dual-translation, versification offsets), FREE NOTES (announcements/sermon points).
- Explicit live declaration: an amber Song/Bible pill applies per-mode output templates; the app never auto-switches styling.
- Show states: LIVE / CLEAR / BLACKOUT / LOGO dock; master output toggle; announcement ticker queue.
- Planning: setlists (.ldset), timed run-sheets (.ldsch) with auto-advance, setlist prev/next navigation.
- Automation: autoplay (timed), intelligent autoplay (audio-follow), HTTP actions per slide (lighting/ATEM), MIDI/OSC triggers, metronome, sermon-assist speech captions.
- Styling: per-output fonts/colors/backgrounds, saved templates, stage return with next-line preview.`;

export const AI_USE_CASES = [
  {
    id: 'sunday',
    label: 'Full Sunday service',
    prompt:
      'Plan a full Sunday service in Selah. Give me: (1) a setlist order mixing 4 worship songs, 2 Bible readings, and 1 announcement note, (2) which output template style to use for songs vs Scripture (fonts, colors, backgrounds that keep text readable on a projector), (3) where to place CLEAR vs BLACKOUT transitions (prayer, sermon, communion), and (4) a timed run-sheet with who does what and when.',
  },
  {
    id: 'stream',
    label: 'Streaming setup',
    prompt:
      'Set up Selah for a livestream. Tell me: (1) which URLs to add as OBS browser sources (main lyrics, lower-third custom output, stage monitor), (2) recommended output styling for a 1080p stream (font sizes, safe margins, ticker for announcements), and (3) how a remote volunteer fires slides from a phone.',
  },
  {
    id: 'sermon',
    label: 'Sermon series',
    prompt:
      'I am preaching a 4-week sermon series. Show me a Selah workflow: (1) how to stage each week\'s key verses as Bible slides with a consistent template, (2) how to use Free Notes for sermon points alongside verses, (3) how to build a reusable run-sheet I duplicate weekly, and (4) how Sermon Assist captions fit in.',
  },
  {
    id: 'youth',
    label: 'Youth night / special event',
    prompt:
      'Plan a high-energy youth night with Selah. Include: (1) fast setlist switching between games, worship, and testimony slides, (2) autoplay or timed slides for a countdown opener, (3) HTTP-action ideas to sync lighting with song sections, and (4) announcement ticker messages to rotate.',
  },
  {
    id: 'choir',
    label: 'Choir / musicians',
    prompt:
      'Configure Selah\'s Stage output for my band. Cover: (1) what the stage screen shows (current + next line, chords, metronome), (2) how chord charts attach to songs, (3) metronome + MIDI click ideas, and (4) how the MD advances slides hands-free.',
  },
  {
    id: 'bible-study',
    label: 'Bible study',
    prompt:
      'Run a midweek Bible study with Selah. Give me: (1) how to import and pick a translation, (2) a flow for walking verse-by-verse with discussion pauses (which show states to use), (3) how parallel dual-translation display helps comparison, and (4) how to save the passage list as a setlist for next week.',
  },
];

export function buildAgentPrompt(useCasePrompt) {
  return `I use Selah, a worship/live-event display app. Here is how it works:\n${APP_CONTEXT}\n\nMy goal:\n${useCasePrompt}\n\nGive me a concrete step-by-step plan inside Selah: exact tabs/buttons/modes to use, a suggested setlist order, output styling choices, and transitions (LIVE/CLEAR/BLACKOUT/LOGO). Keep it practical for a volunteer operator, and suggest one creative idea I probably haven't tried.`;
}

export function hasSeenOnboarding() {
  try {
    return localStorage.getItem(ONBOARDING_SEEN_KEY) === '1';
  } catch {
    return true;
  }
}

export function markOnboardingSeen() {
  try {
    localStorage.setItem(ONBOARDING_SEEN_KEY, '1');
  } catch {
    /* ignore */
  }
}

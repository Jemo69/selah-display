# Selah

> Worship display software — real-time lyrics, Scripture, and sermon assist for live church services, concerts, and broadcasts.

**Version:** 6.17.0
**Maintainer:** [Jemo](https://github.com/Jemo69)
**Based on [LyricDisplay](https://github.com/PeterAlaks/lyric-display-app)** by Peter Alakembi and David Okaliwe

## Origins

Selah started as an open-source fork of [LyricDisplay](https://github.com/PeterAlaks/lyric-display-app), created by **Peter Alakembi** (lead designer and developer) and **David Okaliwe** (co-developer). Their application is the foundation this project stands on — the multi-output display engine, the lyric workflow, and the production polish all come from their work. Since the fork the app has grown several steps beyond lyrics: Bible projection and search, sermon assist, announcements, scheduling, NDI output, and mobile control. None of that would exist without their base. Full credit for the original application is theirs.

## Overview

Selah is a comprehensive Electron-based application designed for use in professional live production environments alongside streaming/recording software. It provides real-time synchronization of lyrics and Scripture across multiple transparent output displays, making it ideal for church services, concerts, and live streaming setups where lyrics need to be displayed in distinct display points.

## Key Features

### Multi-Output Display System
- **Dual Independent Outputs**: Two separate output pages plus stage output page with individual styling controls
- **Transparent Backgrounds**: Perfect for OBS/VMIX browser source capture
- **Real-time Synchronization**: Instant updates across all connected displays
- **Browser Source Compatible**: Works seamlessly with popular streaming software

### Advanced Lyric Management
- **Smart Text Processing**: Automatic formatting for cleaning up lyric files
- **Translation Support**: Displays translation lines where available (lines wrapped in brackets below main lyric line) 
- **Live Editing Canvas**: Built-in editor with formatting tools and auto-cleanup
- **Search & Navigation**: Advanced search with match highlighting and keyboard navigation

### Comprehensive Styling Engine
- **10 Professional Featured Fonts**: 10 pro fonts from Google Fonts in addition to locally installed fonts
- **Typography Controls**: Bold, italic, underline, and all-caps options
- **Color Customization**: Independent font and drop shadow colors
- **Background Controls**: Adjustable opacity and color settings
- **Padding Adjustments**: X/Y margin controls for proper padding control
- **Full Screen Mode**:    Fill colour/media background options for full screen lyrics display

### Professional Features
- **Auto-Updates**: Seamless background updates via GitHub releases
- **Dark Mode**: System-integrated dark/light theme switching
- **Keyboard Shortcuts**: Full menu-driven workflow
- **Secondary Controllers**: Authorize mobile/web devices with a 6-digit join code so remote operators can trigger lines and submit lyric drafts (desktop approval required)
- **Cross-Platform**: Windows, macOS, and Linux support
- **Socket.io Backend**: Secure and reliable real-time communication

## Live Sermon Assist (optional — off by default)

Selah can transcribe the sermon live and offer the operator things to tap: the **next lyric line**, the **Bible verse just quoted**, a **running sermon note**, and — if you turn it on — a **quotable takeaway**. It is an assist rail for the person running the service. It is not a caption system and it is not on by default.

**Nothing happens until someone turns it on.** The feature ships disabled and is marked **Experimental**. While it is off, Selah opens no microphone, sends nothing over the network, and starts no extra process. An operator enables it in *User Preferences → Experimental*, then picks an audio source and a model. It stays under Experimental until the recognition engine actually works, at which point it gets its own settings section.

### What this means for a church

**What gets captured.** The audio being fed to Selah — the sermon feed. Be aware that a live feed usually contains more than the published recording does: anything picked up off-mic, and any part of the service that is not streamed. That is the one real difference between the live feed and the recording, and it is the reason local is the default here.

**Where it goes.** **Locally, by default.** The transcript is produced on the same computer and the model files never leave it. Cloud transcription is a separate, deliberate choice; when it is selected, a mode indicator names the active provider on screen at all times so nobody has to guess where the audio is going.

**What is stored on the computer.** Transcripts are saved on the machine by default, one file per service, in Selah's data folder. The sermon is usually public content, so this is a convenience rather than a risk — but on a **shared church laptop, anyone who can use that account can read them**. There is a one-click erase in the same settings section that deletes every stored transcript at once.

**What the congregation sees.** Nothing, unless a person presses the button. A suggestion fills a staging area in the operator's rail; a second deliberate press is what moves it to the sanctuary screens. This is deliberate: a wrong verse on the wall during a service is a far worse outcome than the operator typing it.

**The optional quote lane.** Off by default, and consent is asked **per service** rather than remembered. This is the only feature here that would send the pastor's actual words — not audio, and not the transcript of the published recording, but the live feed — to an LLM, so it says out loud what leaves the machine and which provider receives it. Choosing Ollama keeps everything on the computer. A suggestion can only be **added to your sermon note**, **copied**, or **dismissed**: it has no send-to-screen action, because it is a model's opinion about what the preacher meant to say rather than a fact the app can check.

### The speech engines

Two real local engines are supported, and the app measures both on your own machine rather than recommending one:

- **whisper.cpp** — the widest model menu and the best English accuracy at the top end. Large v3 is 2.88 GiB. **Not** available for Intel Macs (darwin-x64); use Nemotron there.
- **sherpa-onnx / Nemotron 3.5** — 651 MiB, roughly 40 languages, Silero VAD included. The better choice for a non-English congregation. Reports `wordTimestamps: false`, so the next-lyric lane is switched off **with a stated reason** rather than quietly producing worse suggestions.

Both are downloaded separately and **never bundled** — no weights, no binary, and no new dependency in the app. **Audio processing stays on this computer** either way. Both are checksum-verified against pinned digests before loading, so a partial download refuses to start rather than producing confident nonsense.

**Status.** The engines are real and installable now, and Bible detection reads like a human across eight languages. It is still early, and it is still an assist rail rather than a caption system: silence is always an acceptable outcome, and a wrong suggestion never is.

## Installation

### Pre-built Releases (Recommended)
1. Download the latest release [from the releases page](https://github.com/Jemo69/selah-display/releases/latest)
2. Run the installer for your platform
3. Launch Selah

> **macOS Users:** Because the app is not code-signed, macOS will show a "damaged" error. Before opening, run `xattr -cr /Applications/Selah.app` in Terminal. See the [Installation Guide](INSTALLATION.md) for detailed instructions.

### Development Setup
```bash
# Clone the repository
git clone https://github.com/Jemo69/selah-display.git
cd selah-display

# Install client dependencies
npm install

# Install server dependencies
cd server
npm install

# Development mode
npm run electron-dev

# Build for production
npm run electron-pack
```

## Quick Start Guide

### 1. Loading Lyrics
- **File Menu → Load Lyrics File** (Ctrl/Cmd+O)
- **Drag & Drop**: Drop .txt files directly into the main panel
- **New Song Canvas**: Create and format lyrics from scratch (Ctrl/Cmd+N)
- **Online Lyrics Search**: Quickly search for and load lyrics from featured online providers (Icon in top bar)

### 2. Setting Up Outputs
1. Configure **Output 1** and **Output 2** settings independently
2. Use **File Menu → Preview Output 1/2** (Ctrl/Cmd+1/2) to open and preview display outputs in windows
3. Toggle **Display Output** switch to control visibility

### 3. Live Operation
- Click lyric lines to select and display them
- Use search bar to quickly find specific lyrics
- Navigate matches with Shift+Up/Down arrows
- Toggle output on/off with the main switch

### 4. Secondary Controllers (Optional)
- In the desktop app, open `File > Connect Mobile Controller` or tap the shield icon to view the QR code and current 6-digit join code (the code refreshes when the app restarts)
- On a phone or tablet on the same network, scan the QR code or visit `http://<control-pc-ip>:4000/?client=mobile`, then enter the join code to pair
- Paired controllers load the mobile layout where they can trigger lyric lines, toggle outputs, run manual sync, and submit lyric drafts for approval

## File Format

Selah accepts plain text (.txt) and lyrics (.lrc) files

**Formatting Rules:**

- Bracketed lines `[like this]`, `(this)` or `{this}` are treated as translation lines
- Two consecutive lines where the second is bracketed will be grouped
- Auto cleanup removes periods and other special characters, capitalizes first letter of words like God, Jesus, etc.

## Why This Project Exists

This project is called **Selah** — a pause, a breath — because honestly, I didn't think it was possible.

I'm Jeremy — a Computer Science student at Morgan State, from a small church. I'm no developer by trade. When I first imagined what this app could become — real-time lyric sync, Scripture projection, sermon assist, mobile control — it felt too big, too technical, too far out of reach. I told myself it couldn't be done.

AI proved me wrong.

Working side-by-side with AI, line by line, bug by bug, what felt impossible slowly became real. Selah is proof that an idea doesn't die just because you don't yet have the skills — you just need the willingness to keep pausing, learning, and building.

If you're reading this and holding an idea you think is "not possible" — this project is for you too.

## Technical Architecture

### Frontend Stack
- **React** with Hash Router for SPA navigation
- **Tailwind CSS** for responsive styling
- **Radix/ShadCN UI** components for accessibility
- **Zustand** for state management with persistence
- **Lucide React** for modern iconography

### Backend Infrastructure
- **Express.js** server for static file serving
- **Socket.io** for real-time WebSocket communication
- **Node.js** child processes for backend management

### Desktop Integration
- **Electron** for cross-platform desktop application
- **Auto-updater** with GitHub releases integration
- **Native menus** with keyboard shortcuts
- **System theme** synchronization

### Storage & Persistence
- Settings automatically saved using Zustand persistence
- Cross-session state restoration
- Electron-store integration for native preferences

## Use Cases

### Church Services
- Display hymns and worship songs simultaneously in-house and online
- Support for multiple languages with translation grouping
- Quick song switching during live services

### Live Streaming
- OBS/VMIX browser source integration
- Transparent overlays for professional broadcasts
- Real-time lyric synchronization for worship leaders

### Concerts & Events
- Multi-screen lyric coordination
- Custom styling to match event branding
- Reliable real-time performance

## Browser Source Setup

### OBS Studio Integration
1. Add **Browser Source** to your scene
2. Set URL to: `http://localhost:4000/#/output1` or `http://localhost:4000/#/output2`
3. Replace `localhost` with the control panel PC's local IP if capturing display from another system across a network
4. Set dimensions of browser source to match your canvas (for example, 1920 x 1080 pixels)
5. Enable **Shutdown source when not visible** for performance
6. **Refresh browser when scene becomes active** for reliability

### vMix Integration
- Add **Web Browser** input
- Use same URL format as OBS
- Configure as overlay for professional broadcast mixing

## Development

### Project Structure
```
selah-display/
├── main/                                   # Electron main script modules
│   ├── lyricsProviders/
|   |   ├── providers/
|   |   |   ├── chartlyrics.js              # ChartLyrics lyrics provider definitions
|   |   |   ├── hymnary.js                  # Hymnary.org lyrics provider definitions
|   |   |   ├── lrclib.js                   # LRCLIB lyrics provider definitions
|   |   |   ├── lyricsOvh.js                # Lyrics.ovh lyrics provider definitions
|   |   |   ├── openHymnal.js               # Open Hymnal lyrics provider definitions
|   |   |   └── vagalume.js                 # Vagalume lyrics provider definitions
|   |   ├── cache.js                        # Online lyrics search data cache
|   |   ├── fetchWithTimeout.js             # Fetch lyric data timeout moderator for providers
|   |   ├── index.js                        # Main online lyrics search initializer and aggregator
|   |   └── searchAlgorithm.js              # Online lyrics search algorithm
|   ├── adminKey.js                         # Admin access key module
|   ├── backend.js                          # Backend server starter
|   ├── cleanup.js                          # Cleanup utility for windows and other processes upon exit
|   ├── displayDetection.js                 # External display detection in main process
|   ├── displayManager.js                   # External assignment and management module
|   ├── easyWorship.js                      # EasyWorship song lyric files conversion module
|   ├── fileHandler.js                      # Main process file processing handler
|   ├── inAppBrowser.js                     # In-App browser window configuration and styling
|   ├── ipc.js                              # IPC handlers
|   ├── loadingWindow.js                    # Loading process window
|   ├── menuBridge.js                       # Renderer/menu bridge (dark mode, undo/redo state)
|   ├── modalBridge.js                      # Global modal bridge for electron main process
|   ├── paths.js                            # Production paths resolver
|   ├── progressWindow.js                   # App updater dialog window configuration and styling
|   ├── providerCredentials.js              # secure storage utility for online lyrics provider credentials
|   ├── recents.js                          # Module for token storage
|   ├── secureTokenStore.js                 # Main token storage for desktop 
|   ├── setlistExport.js                    # Backend process for setlist export operations
|   ├── singleInstance.js                   # Single app instance lock process
|   ├── startup.js                          # Main app startup processes
|   ├── systemFonts.js                      # Helper module for loading system installed fonts
|   ├── themePreferences.js                 # Theme manager for main process dark mode sync
|   ├── userTemplates.js                    # Backend manager for user-stored output settings template system
|   ├── updater.js                          # Module to manage app updates
|   ├── utils.js                            # Utility file to get local IP address
|   └── windows.js                          # Main window builder
├── public/                                 # Static assets
├── scripts/                                # Custom npm scripts
|   ├── release.js                          # Release assistant main script
|   └── update-version.js                   # Helper script for updating current version in readme and install guide
├── server/                                 # Express.js backend
|   ├── events.js                           # Backend communication events
|   ├── index.js                            # Main backend server
|   ├── joinCodeGuard.js                    # Guard/limiter for join code attempts by secondary controllers
|   ├── package.json                        # Backend dependencies
|   └── secretManager.js                    # Module handling the secure management of app secrets
├── shared/
│   ├── data/
|   |   ├── knownArtists.json               # Popular artists name database for enhanced lyric search logic
|   |   ├── openhymnal-bundle.json          # Open Hymnal hymn lyrics bundle from public website
|   |   └── openhymnal-sample.json          # Open Hymnal hymn lyrics sample format for search discoverability
|   ├── lineSplitting.js                    # Intelligent line splitting utility for smarter lyrics parsing 
|   └── lyricsParsing.js                    # Shared TXT/LRC parsing helpers.
├── src/                                    # React frontend source
│   ├── assets/                             # Fonts, etc.
│   ├── components/
|   |   ├── modal/
|   |   |   └── ModalProvider.jsx           # Global modal component
|   |   ├── toast/
|   |   |   └── ToastProvider.jsx           # Toast notifications component
|   |   ├── ui/                             # Reusable UI components
|   |   ├── WindowChrome/
|   |   |   ├── DesktopShell.jsx            # Desktop app wrapper component
|   |   |   └── TopMenuBar.jsx              # Custom renderer-based native top menu bar
|   |   ├── AboutAppModal.jsx               # About the app modal
|   |   ├── AuthStatusIndicator.jsx         # Authentication status component
|   |   ├── AutoplaySettings.jsx            # Autoplay settings modal
|   |   ├── ConnectionBackoffBanner.jsx     # Global connection backoff modal component
|   |   ├── ConnectionDiagnosticsModal.jsx  # Connection diagnostics modal component
|   |   ├── DisplayDetectionModal.jsx       # Display detection modal component
|   |   ├── DraftApprovalModal.jsx          # Approval modal component for lyric drafts submitted from secondary controllers
|   |   ├── EasyWorshipImportModal.jsx      # Song import from local EasyWorship store wizard
|   |   ├── ElectronModalBridge.jsx         # In-app listener for global modal usage in Electron
|   |   ├── FontSelect.jsx                  # Custom font selection overlay
|   |   ├── HelpContent.jsx                 # Help and operation tips modal
|   |   ├── IntegrationInstructions.jsx     # Integration help modal for OBS, VMix and Wirecast
|   |   ├── IntelligentAutoplayInfo.jsx     # Intelligent Autoplay info modal
|   |   ├── JoinCodePromptBridge.jsx        # Bridge and component for join code user flow
|   |   ├── LyricDisplayApp.jsx             # Main control panel UI
|   |   ├── LyricsList.jsx                  # Control panel lyrics list UI
|   |   ├── MobileLayout.jsx                # Minified control panel UI for secondary connected clients
|   |   ├── NewSongCanvas.jsx               # New/edit song text editor
|   |   ├── OnlineLyricsSearchModal.jsx     # Online Lyrics Search modal
|   |   ├── OnlineLyricsWelcomeSplash.jsx   # Online Lyrics Search welcome and help modal component
|   |   ├── OutputSettingsPanel.jsx         # Settings panel interface
|   |   ├── OutputSettingsShared.jsx        # Shared UI components for output and stage settings panel
|   |   ├── OutputTemplatesModal.jsx        # Output settings templates modal
|   |   ├── PreviewOutputsModal.jsx         # Display outputs preview modal
|   |   ├── QRCodeDialog.jsx                # QR Code Dialog UI for mobile controller connection
|   |   ├── QRCodeDialogBridge.jsx          # Bridge component for QR Code Dialog
|   |   ├── SaveTemplateModal.jsx           # Save settings combo as template modal
|   |   ├── SearchBar.jsx                   # Search bar component for control panel
|   |   ├── SetlistExportModal.jsx          # Setlist export modal
|   |   ├── SetlistModal.jsx                # Setlist modal
|   |   ├── ShortcutsHelpBridge.jsx         # Shortcuts help modal and bridge
|   |   ├── SongInfoModal.jsx               # Info modal for loaded lyrics
|   |   ├── StageSettingsPanel.jsx          # Stage settings interface
|   |   ├── StageTemplatesModal.jsx         # Stage settings templates modal
|   |   ├── SupportDevelopmentBridge.jsx    # Support development modal bridge
|   |   ├── SupportDevelopmentModal.jsx     # Support development modal
|   |   └── WelcomeSplash.jsx               # Welcome splash modal for first time install
│   ├── constants/
|   |   ├── easyWorship.js                  # Some EasyWorship constants
|   |   ├── fonts.js                        # Featured fonts dropdown store
|   |   ├── lyricsFormat.js                 # Constants used in lyrics formatting/cleanup utility
|   |   ├── shortcuts.js                    # Keyboard shortcut definitions used for shortcuts help modal
|   |   └── songCanvas.js                   # Some constants used in canvas editor
│   ├── context/
|   |   ├── ControlSocketProvider.jsx       # Control socket provider
|   |   └── LyricsStore.js                  # Zustand store definitions
│   ├── hooks/
|   |   ├── LyricDisplayApp/
|   |   |   ├── useDragAndDrop.js           # Drag and drop operations for control panel
|   |   |   ├── useElectronListeners.js     # Hook for listening to main process events and broadcasts for control panel
|   |   |   ├── useKeyboardShortcuts.js     # Keyboard entry listener for control panel
|   |   |   ├── useLyricsLoader.js          # Multi-source lyrics load processor for control panel 
|   |   |   ├── useMenuShortcuts.js         # Hook for handling menu navigation/shortcuts
|   |   |   ├── useOutputSettings.js        # Hook for output settings tab switcher
|   |   |   ├── useResponsiveWidth.js       # Window resize observer hook for control panel button responsiveness
|   |   |   ├── useSetlistActions.js        # Hook for setlist action functionality
|   |   |   └── useSupportDevModal.js       # Hook for processing show time and parameters for support development modal
|   |   ├── LyricsList/
|   |   |   └── useElectronListeners.js     # Hook for listening to main process events and broadcasts for lyrics list
|   |   ├── NewSongCanvas/
|   |   |   ├── useCanvasSearch.js          # Content search hook for editing area/canvas
|   |   |   ├── useEditorClipboard.js       # Hook for cut, copy and paste handlers
|   |   |   ├── useEditorHistory.js         # Hook for history state management of lyrics editor canvas
|   |   |   ├── useElectronListeners.js     # Hook for listening to main process events and broadcasts for new song canvas
|   |   |   ├── useFileSave.js              # Canvas file operations hook
|   |   |   ├── useKeyboardShortcuts.js     # Keyboard entry listener for canvas
|   |   |   ├── useLineMeasurements.js      # Hook for measuring and calculating line dimensions in canvas
|   |   |   ├── useLineOperations.js        # Hook for line manipulation operations in canvas
|   |   |   ├── useLrcEligibility.js        # Hook for determining LRC format eligibility
|   |   |   ├── useTimestampOperations.js   # Hook for timestamp handling and operations
|   |   |   └── useTitlePrefill.js          # Hook for auto-prefilling song title in canvas
|   |   ├── OnlineLyricsSearchModal/
|   |   |   ├── useKeyboardShortcuts.js     # Keyboard entry listener for online lyrics search modal
|   |   |   └── useNetworkStatus.js         # Internet connection status hook
|   |   ├── OutputSettingsPanel/
|   |   |   ├── useAdvancedSectio....js     # Hook for advanced sections visibility states
|   |   |   ├── useFullscreenBackground.js  # Hook for handling fullscreen background controls
|   |   |   ├── useFullscreenModeState.js   # Fullscreen mode and settings visibility state hook
|   |   |   ├── useOutputToggle.js          # Individual output switch manager
|   |   |   ├── useStageDisplayControls.js  # Hook for stage display controls
|   |   |   └── useTypographyAndBands.js    # Background band and related logic hook
|   |   ├── SetlistModal/
|   |   |   └── useSetlistLoader.js         # Hook for setlist file loading functionality
|   |   ├── WindowChrome/
|   |   |   ├── useMenuHandlers.js          # Menu operations hook for top menu bar
|   |   |   ├── useSubMenuListNav.js        # Hook for handling top menu bar sub-menu navigation
|   |   |   └── useTopMenuState.js          # Top menu bar state definitions
|   |   ├── useAuth.js                      # Authenticator hook for socket connections
|   |   ├── useAutoplayManager.js           # Autoplay engine and logic
|   |   ├── useContextMenuPosition.js       # Hook for space-aware context menu positioning
|   |   ├── useContextSubmenus.js           # Context submenus definitions and logic
|   |   ├── useDarkModeSync.js              # Hook for global dark mode sync
|   |   ├── useFileUpload.js                # Custom React hook for file uploads
|   |   ├── useModal.js                     # Global modal hook
|   |   ├── useMultipleFileUpload.js        # Multiple file upload handler
|   |   ├── useSearch.js                    # Hook for search bar functionality
|   |   ├── useSocket.js                    # Main React hook for Socket.IO client
|   |   ├── useSocketEvents.js              # Socket events hook
|   |   ├── useStoreSelectors.js            # Centralized collection of Zustand selectors
|   |   ├── useSyncOutputs.js               # Outputs sync manager for control panel
|   |   ├── useSyncTimer.js                 # Last synced timer hook
|   |   └── useToast.js                     # Toast notifications hook
│   ├── lib/
|   |   └── utils.js                        # UI library utility functions
│   ├── pages/                              # Route-based page components
|   |   ├── ControlPanel.jsx                # Control panel page wrapper
|   |   ├── Output1.jsx                     # Output 1 display
|   |   ├── Output2.jsx                     # Output 2 display
|   |   └── Stage.jsx                       # Stage output display
│   ├── styles/
|   |   └── fonts.css                       # Display font styles import and definitions
│   ├── utils/
|   |   ├── artistDetection.js              # Scans Known Artists database for various uses around the app
|   |   ├── asyncLyricsParser.js            # Picks worker/IPC/sync parsing strategy
|   |   ├── connectionManager.js            # Socket connection management utility
|   |   ├── errorClassification.js          # Network error detection and description utility
|   |   ├── logger.js                       # Simple event and error logger utility
|   |   ├── lyricsFormat.js                 # Format lyrics utility for new/edit song canvas
|   |   ├── markdownParser.js               # Helper utility for converting markdown to HTML
|   |   ├── maxLinesCalculator.js           # Calculator for maximum lines feature in outputs display
|   |   ├── network.js                      # Network utility for backend URL resolution
|   |   ├── numberInput.js                  # Integer value sanitization utility for settings panel
|   |   ├── outputTemplates.js              # Output templates for settings panel
|   |   ├── parseLrc.js                     # LRC file parser
|   |   ├── parseLyrics.js                  # Text file parser
|   |   ├── secureTokenStore.js             # Secure token storage utility
|   |   ├── timestampHelpers.js             # Timestamp helper utility for intelligent autoplay feature
|   |   ├── titlePrefill.js                 # Title prefill utility for song canvas
|   |   └── toastSounds.js                  # Toast notifications tones utility
│   ├── workers/
|   |   └── lyricsParser.worker.js          # Web worker that parses lyrics off the UI thread.
|   ├── App.jsx                             # React app main component
|   ├── index.css                           # Global CSS and custom style definitions
|   └── main.jsx                            # App entry point
├── components.json                         # Shadcn UI config
├── CONTRIBUTING.md                         # Contribution guides for project
├── index.html                              # Web app entry point
├── jsconfig.json                           # Path and settings configurations for JS
├── main.js                                 # Electron main process
├── package.json                            # Dependencies and scripts
├── postcss.config.js                       # PostCSS configurations
├── preload.js                              # Electron preload script
├── README.md                               # App documentation
├── tailwind.config.js                      # Tailwind configurations
└── vite.config.js                          # Vite configurations
```

### Available Scripts
```bash
npm run dev              # Vite development server
npm run server           # Backend server only
npm run electron-dev     # Full Electron development
npm run build            # Production build
npm run electron-pack    # Package Electron app
```

### Contributing
1. Fork the repository
2. Create a feature branch
3. Implement changes with proper testing
4. Submit pull request with detailed description

## Mobile Controller (`mobile/`)

A Flutter phone/tablet app drives lyrics over the church LAN — no cloud, no pairing server.

- **Discovery:** mDNS (`_lyricdisplay._tcp`) with automatic subnet-sweep fallback, manual IP, or desktop QR code
- **Pairing:** 6-digit join code → JWT stored in secure storage; silent re-pair on 401
- **Control:** prev/next/goto lines, setlist load & reorder, Bible quick-load, output toggle/blackout, live Socket.IO sync with offline queue + heartbeat

Run the server, then: `cd mobile && flutter run`. Release APKs build automatically on `mobile-v*` tags (`.github/workflows/mobile-release.yml`). Set `ENABLE_MDNS=false` on the server to disable multicast advertising (WSL/CI).

## Troubleshooting

### Common Issues

**Output windows not displaying:**
- Verify backend server is running (Port 4000 active)
- Ensure Socket.io connection is established (Connected status in top bar)
- Try refreshing browser sources in OBS/vMix/Wirecast

## License & Credits

Selah is free software, licensed under the [GNU General Public License v3.0 or later](LICENSE).

### Based on LyricDisplay

Selah is a derivative work of [LyricDisplay](https://github.com/PeterAlaks/lyric-display-app), created by **Peter Alakembi** (lead designer and developer) and **David Okaliwe** (co-developer). Their project is the foundation this one stands on — display engine, lyric workflow, and production polish all come from their work, used under its open-source license. The metronome and its click sounds are additionally ported from [FreeShow](https://github.com/freeshow/freeshow) (GPL-3.0); file-level attribution lives in [NOTICE](NOTICE).

## Lyrics Provider Credits & Copyright Disclaimer

Selah integrates optional online lyrics search features powered by free and publicly available lyrics providers.  
All lyrics, metadata, and related content displayed through these services remain the property of their respective copyright holders.

### Integrated Providers
- **LRCLIB** — Free synced lyrics database with nearly 3 million lyrics. No API key required. Provides both plain and timestamped (LRC format) lyrics.
- **ChartLyrics** — Free public lyrics API with good coverage of popular songs. No API key required.
- **Lyrics.ovh** — Free lyrics API (public domain and licensed material) provided for educational and non-commercial use.  
- **Vagalume** — © Vagalume Media Group. Lyrics and artist data are provided through the official Vagalume API.  
- **Hymnary.org** — © Hymnary.org / Christian Classics Ethereal Library (CCEL). Content is provided for educational and liturgical purposes.  
- **Open Hymnal Project** — Public domain hymn texts and music as compiled by the Open Hymnal Project.

### Logos & Trademarks
Logos and brand marks of the above providers are displayed in Selah **for identification and attribution purposes only**.  
All trademarks, service marks, and logos are the property of their respective owners.  
Their inclusion does **not imply endorsement, partnership, or affiliation** with Selah or its developers.

### Usage Notice
- Selah does **not store**, redistribute, or claim ownership of any lyrics obtained through these sources.  
- Lyrics are fetched on demand from publicly accessible APIs and displayed **solely for personal, church, and non-commercial use**.  
- If you are a copyright holder and wish to request content removal or modification, please contact the original provider directly.

> **Disclaimer:** Selah and its developers are not affiliated with or endorsed by any of the above content providers.  
> This feature is offered “as is” for convenience and educational purposes only.

**Copyright © 2026 Selah contributors. Licensed under GPL-3.0.** Original LyricDisplay © Peter Alakembi and David Okaliwe.

**Original creators (LyricDisplay):**
- Peter Alakembi (Lead Designer and Developer)
- David Okaliwe (Co-Developer)

**Maintainer (Selah):**
- [Jemo](https://github.com/Jemo69)

**Links:**
- [This repository](https://github.com/Jemo69/selah-display)
- [LyricDisplay website (original project)](https://lyricdisplay.app)
- [Original developer portfolio](https://linktr.ee/peteralaks)
- [Support the original developers](https://paystack.shop/pay/lyricdisplay-support)

## Support

For technical support, feature requests, or bug reports:
- Open an issue on the issues tab
- Check existing documentation
- Review troubleshooting section

---

*Selah - Powering worship experiences worldwide*
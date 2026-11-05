const { contextBridge, ipcRenderer } = require('electron');

/**
 * Subscribe to one Sermon Assist event channel from the main process.
 * Same idiom as the ndi:/lyrics: namespaces: an unsubscribe function the
 * renderer can keep. The exact channel set is pinned by
 * tests/speech/invariants.test.js (invariant 4), so a rename or an addition
 * shows up there as a reviewed diff.
 *
 * Every subscriber gets its OWN listener. There is deliberately no
 * `removeAllListeners` here: `useModelInstallState` is instantiated twice on
 * the same screen (InstallEngineWizard and ModelCatalogList both render under
 * SpeechSettingsSection), and evicting the first subscriber's listeners would
 * silently freeze the install wizard's progress bar and — because
 * ModelCatalogList renders no error surface of its own — swallow download
 * failures entirely. Multiple subscribers per channel is the supported case.
 */
const onSpeechEvent = (channel, callback) => {
  const listener = (_event, payload) => callback?.(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('electronAPI', {
  tokenStore: {
    get: (payload) => ipcRenderer.invoke('token-store:get', payload),
    set: (payload) => ipcRenderer.invoke('token-store:set', payload),
    clear: (payload) => ipcRenderer.invoke('token-store:clear', payload)
  },
  toggleDarkMode: () => ipcRenderer.invoke('toggle-dark-mode'),
  getDarkMode: () => ipcRenderer.invoke('get-dark-mode'),
  setDarkMode: (isDark) => ipcRenderer.invoke('set-dark-mode', isDark),
  syncNativeDarkMode: (isDark) => ipcRenderer.invoke('sync-native-dark-mode', isDark),
  loadLyricsFile: () => ipcRenderer.invoke('load-lyrics-file'),
  parseLyricsFile: (payload) => ipcRenderer.invoke('parse-lyrics-file', payload),
  getAdminKey: () => ipcRenderer.invoke('get-admin-key'),
  getJoinCode: () => ipcRenderer.invoke('get-join-code'),
  getDesktopJWT: (payload) => ipcRenderer.invoke('get-desktop-jwt', payload),
  getConnectionDiagnostics: () => ipcRenderer.invoke('get-connection-diagnostics'),
  newLyricsFile: () => ipcRenderer.invoke('new-lyrics-file'),
  getLocalIP: () => ipcRenderer.invoke('get-local-ip'),
  getLocalIPs: () => ipcRenderer.invoke('get-local-ips'),
  getSystemFonts: () => ipcRenderer.invoke('fonts:list'),
  getPlatform: () => process.platform,
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  windowControls: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    toggleFullscreen: () => ipcRenderer.invoke('window:toggle-fullscreen'),
    close: () => ipcRenderer.invoke('window:close'),
    reload: () => ipcRenderer.invoke('window:reload'),
    toggleDevTools: () => ipcRenderer.invoke('window:devtools'),
    setZoom: (direction) => ipcRenderer.invoke('window:zoom', direction),
    getState: () => ipcRenderer.invoke('window:get-state'),
  },
  onWindowState: (callback) => {
    const channel = 'window-state';
    ipcRenderer.removeAllListeners(channel);
    ipcRenderer.on(channel, (_event, state) => callback?.(state));
    return () => ipcRenderer.removeAllListeners(channel);
  },
  onTriggerFileLoad: (callback) => {
    ipcRenderer.removeAllListeners('trigger-file-load');
    ipcRenderer.on('trigger-file-load', callback);
  },

  onNavigateToNewSong: (callback) => {
    ipcRenderer.removeAllListeners('navigate-to-new-song');
    ipcRenderer.on('navigate-to-new-song', callback);
  },

  onDarkModeToggle: (callback) => ipcRenderer.on('toggle-dark-mode', callback),

  showSaveDialog: (options) => ipcRenderer.invoke('show-save-dialog', options),
  writeFile: (filePath, content) => ipcRenderer.invoke('write-file', filePath, content),

  onProgressUpdate: (callback) => {
    ipcRenderer.removeAllListeners('progress-update');
    ipcRenderer.on('progress-update', (event, progress) => callback(progress));
  },

  onLoadingStatus: (callback) => {
    ipcRenderer.removeAllListeners('loading-status');
    ipcRenderer.on('loading-status', (event, status) => callback(status));
  },


  onAdminKeyAvailable: (callback) => {
    const channel = 'admin-key:available';
    const handler = (_event, payload) => callback?.(payload);
    ipcRenderer.removeAllListeners(channel);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },

  openInAppBrowser: (url) => ipcRenderer.invoke('open-in-app-browser', url),
  addRecentFile: (filePath) => ipcRenderer.invoke('add-recent-file', filePath),
  recents: {
    list: () => ipcRenderer.invoke('recents:list'),
    clear: () => ipcRenderer.invoke('recents:clear'),
    open: (filePath) => ipcRenderer.invoke('recents:open', filePath),
    onChange: (callback) => {
      const channel = 'recents:update';
      ipcRenderer.removeAllListeners(channel);
      ipcRenderer.on(channel, (_event, list) => callback?.(list));
      return () => ipcRenderer.removeAllListeners(channel);
    }
  },
  openOutputWindow: (outputNumber) => ipcRenderer.invoke('open-output-window', outputNumber),
  outputAutomation: {
    fire: (payload) => ipcRenderer.invoke('output-automation:fire', payload),
  },
  httpAction: {
    fire: (payload) => ipcRenderer.invoke('http-action:fire', payload),
  },
  onOpenLyricsFromPath: (callback) => {
    const channel = 'open-lyrics-from-path';
    ipcRenderer.removeAllListeners(channel);
    ipcRenderer.on(channel, (_e, payload) => callback(payload));
    return () => ipcRenderer.removeAllListeners(channel);
  },

  checkForUpdates: (showNoUpdateDialog) => ipcRenderer.invoke('updater:check', showNoUpdateDialog),
  onUpdateAvailable: (callback) => {
    const channel = 'updater:update-available';
    ipcRenderer.removeAllListeners(channel);
    ipcRenderer.on(channel, (_e, info) => callback(info));
    return () => ipcRenderer.removeAllListeners(channel);
  },
  onUpdateDownloaded: (callback) => {
    const channel = 'updater:update-downloaded';
    ipcRenderer.removeAllListeners(channel);
    ipcRenderer.on(channel, (_e) => callback());
    return () => ipcRenderer.removeAllListeners(channel);
  },
  onUpdateError: (callback) => {
    const channel = 'updater:update-error';
    ipcRenderer.removeAllListeners(channel);
    ipcRenderer.on(channel, (_e, msg) => callback(msg));
    return () => ipcRenderer.removeAllListeners(channel);
  },
  requestUpdateDownload: () => ipcRenderer.invoke('updater:download'),
  requestInstallAndRestart: () => ipcRenderer.invoke('updater:install'),
  displaySettings: {
    openModal: () => ipcRenderer.invoke('display:open-settings-modal')
  },

  onOpenShortcutsHelp: (callback) => {
    const channel = 'open-shortcuts-help';
    ipcRenderer.removeAllListeners(channel);
    ipcRenderer.on(channel, callback);
    return () => ipcRenderer.removeAllListeners(channel);
  },
  onOpenQRCodeDialog: (callback) => {
    const channel = 'open-qr-dialog';
    ipcRenderer.removeAllListeners(channel);
    ipcRenderer.on(channel, callback);
    return () => ipcRenderer.removeAllListeners(channel);
  },
  onOpenEasyWorshipImport: (callback) => {
    const channel = 'open-easyworship-import';
    ipcRenderer.removeAllListeners(channel);
    ipcRenderer.on(channel, callback);
    return () => ipcRenderer.removeAllListeners(channel);
  },
  onOpenSupportDevModal: (callback) => {
    const channel = 'open-support-dev-modal';
    ipcRenderer.removeAllListeners(channel);
    ipcRenderer.on(channel, callback);
    return () => ipcRenderer.removeAllListeners(channel);
  },
  // NDI video-over-IP output (desktop only; absent elsewhere).
  ndi: {
    getStatus: () => ipcRenderer.invoke('ndi:get-status'),
    setEnabled: (outputKey, enabled, sourceName) =>
      ipcRenderer.invoke('ndi:set-enabled', { outputKey, enabled, sourceName }),
    onStatus: (callback) => {
      const channel = 'ndi:status';
      ipcRenderer.removeAllListeners(channel);
      const handler = (_event, payload) => callback?.(payload);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
  },
  onMenuUndo: (callback) => {
    const channel = 'menu-undo';
    ipcRenderer.removeAllListeners(channel);
    ipcRenderer.on(channel, callback);
    return () => ipcRenderer.removeAllListeners(channel);
  },
  onMenuRedo: (callback) => {
    const channel = 'menu-redo';
    ipcRenderer.removeAllListeners(channel);
    ipcRenderer.on(channel, callback);
    return () => ipcRenderer.removeAllListeners(channel);
  },
  notifyUndoRedoState: (canUndo, canRedo) => ipcRenderer.send('undo-redo-state', { canUndo, canRedo }),
  onOpenLyricsFromPathError: (callback) => {
    const channel = 'open-lyrics-from-path-error';
    ipcRenderer.removeAllListeners(channel);
    ipcRenderer.on(channel, (_e, payload) => callback(payload));
    return () => ipcRenderer.removeAllListeners(channel);
  },
  onOpenSetlistFromPath: (callback) => {
    const channel = 'open-setlist-from-path';
    ipcRenderer.removeAllListeners(channel);
    ipcRenderer.on(channel, (_e, payload) => callback(payload));
    return () => ipcRenderer.removeAllListeners(channel);
  },

  // Hardware MIDI + OSC automation (desktop only; no-ops elsewhere).
  hardware: {
    onCommand: (callback) => {
      const channel = 'hardware:command';
      ipcRenderer.removeAllListeners(channel);
      const handler = (_e, payload) => callback?.(payload);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    getStatus: () => ipcRenderer.invoke('hardware:get-status'),
    onMidiStatus: (callback) => {
      const channel = 'hardware:midi-status';
      ipcRenderer.removeAllListeners(channel);
      const handler = (_e, payload) => callback?.(payload);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    onOscStatus: (callback) => {
      const channel = 'hardware:osc-status';
      ipcRenderer.removeAllListeners(channel);
      const handler = (_e, payload) => callback?.(payload);
      ipcRenderer.on(channel, handler);
      return () => ipcRenderer.removeListener(channel, handler);
    },
    midi: {
      getStatus: () => ipcRenderer.invoke('midi:get-status'),
      listDevices: () => ipcRenderer.invoke('midi:list-devices'),
      setEnabled: (enabled) => ipcRenderer.invoke('midi:set-enabled', enabled),
      setDevice: (deviceName) => ipcRenderer.invoke('midi:set-device', deviceName),
      setMapping: (key, command) => ipcRenderer.invoke('midi:set-mapping', { key, command }),
      clearMapping: (command) => ipcRenderer.invoke('midi:clear-mapping', command),
      resetMappings: () => ipcRenderer.invoke('midi:reset-mappings'),
      startLearn: (command) => ipcRenderer.invoke('midi:start-learn', command),
      cancelLearn: () => ipcRenderer.invoke('midi:cancel-learn'),
    },
    osc: {
      getStatus: () => ipcRenderer.invoke('osc:get-status'),
      setEnabled: (enabled) => ipcRenderer.invoke('osc:set-enabled', enabled),
      setPort: (port) => ipcRenderer.invoke('osc:set-port', port),
      regenerateToken: () => ipcRenderer.invoke('osc:regenerate-token'),
      getToken: () => ipcRenderer.invoke('osc:get-token'),
    },
  },

  browserBack: () => ipcRenderer.send('browser-nav', 'back'),
  browserForward: () => ipcRenderer.send('browser-nav', 'forward'),
  browserReload: () => ipcRenderer.send('browser-nav', 'reload'),
  browserNavigate: (url) => ipcRenderer.send('browser-nav', 'navigate', url),
  browserOpenExternal: () => ipcRenderer.send('browser-open-external'),
  onBrowserLocation: (callback) => {
    ipcRenderer.removeAllListeners('browser-location');
    ipcRenderer.on('browser-location', (_e, url) => callback(url));
  },

  removeAllListeners: (channel) => {
    ipcRenderer.removeAllListeners(channel);
  },

  onModalRequest: (callback) => {
    const channel = 'modal-bridge:request';
    ipcRenderer.removeAllListeners(channel);
    const handler = (_event, payload) => callback?.(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  resolveModalRequest: (id, result) => ipcRenderer.invoke('modal-bridge:resolve', { id, result }),
  rejectModalRequest: (id, error) => ipcRenderer.invoke('modal-bridge:reject', { id, error: error?.message || error || 'cancelled' }),
  lyrics: {
    listProviders: () => ipcRenderer.invoke('lyrics:providers:list'),
    getProviderKey: (providerId) => ipcRenderer.invoke('lyrics:providers:key:get', { providerId }),
    saveProviderKey: (providerId, key) => ipcRenderer.invoke('lyrics:providers:key:set', { providerId, key }),
    deleteProviderKey: (providerId) => ipcRenderer.invoke('lyrics:providers:key:delete', { providerId }),
    search: (payload) => ipcRenderer.invoke('lyrics:search', payload),
    fetch: (payload) => ipcRenderer.invoke('lyrics:fetch', payload),
    watchFile: (filePath) => ipcRenderer.invoke('lyrics:watch-file', filePath),
    unwatchFile: (filePath) => ipcRenderer.invoke('lyrics:unwatch-file', filePath),
    readFile: (filePath) => ipcRenderer.invoke('lyrics:read-file', filePath),
    onFileChanged: (callback) => {
      const channel = 'lyrics:file-changed';
      const listener = (_event, payload) => callback?.(payload);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
    onFileRemoved: (callback) => {
      const channel = 'lyrics:file-removed';
      const listener = (_event, payload) => callback?.(payload);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    },
    onPartialResults: (callback) => {
      ipcRenderer.removeAllListeners('lyrics:search:partial');
      ipcRenderer.on('lyrics:search:partial', (_event, payload) => callback(payload));
      return () => ipcRenderer.removeAllListeners('lyrics:search:partial');
    }
  },
  presentation: {
    browseFiles: () => ipcRenderer.invoke('presentation:browse-files'),
    importFile: (filePath) => ipcRenderer.invoke('presentation:import-file', { filePath }),
    browseEw: (version) => ipcRenderer.invoke('presentation:browse-ew', { version }),
    importEw: (path, version) => ipcRenderer.invoke('presentation:import-ew', { path, version }),
    toText: (song) => ipcRenderer.invoke('presentation:to-text', { song })
  },
  easyWorship: {
    validatePath: (path) => ipcRenderer.invoke('easyworship:validate-path', { path }),
    browseForPath: () => ipcRenderer.invoke('easyworship:browse-path'),
    browseForDestination: () => ipcRenderer.invoke('easyworship:browse-destination'),
    importSong: (params) => ipcRenderer.invoke('easyworship:import-song', params),
    openFolder: (path) => ipcRenderer.invoke('easyworship:open-folder', { path }),
    getUserHome: () => ipcRenderer.invoke('easyworship:get-user-home')
  },
  display: {
    getAll: () => ipcRenderer.invoke('display:get-all'),
    getPrimary: () => ipcRenderer.invoke('display:get-primary'),
    getById: (displayId) => ipcRenderer.invoke('display:get-by-id', { displayId }),
    saveAssignment: (displayId, outputKey) => ipcRenderer.invoke('display:save-assignment', { displayId, outputKey }),
    getAssignment: (displayId) => ipcRenderer.invoke('display:get-assignment', { displayId }),
    getAllAssignments: () => ipcRenderer.invoke('display:get-all-assignments'),
    removeAssignment: (displayId) => ipcRenderer.invoke('display:remove-assignment', { displayId }),
    openOutputOnDisplay: (outputKey, displayId) => ipcRenderer.invoke('display:open-output-on-display', { outputKey, displayId }),
    closeOutputWindow: (outputKey) => ipcRenderer.invoke('display:close-output-window', { outputKey })
  },
  setlist: {
    save: (setlistData, defaultName) => ipcRenderer.invoke('setlist:save', { setlistData, defaultName }),
    load: () => ipcRenderer.invoke('setlist:load'),
    loadFromPath: (filePath) => ipcRenderer.invoke('setlist:load-from-path', { filePath }),
    getUserHome: () => ipcRenderer.invoke('setlist:get-user-home'),
    browseFiles: () => ipcRenderer.invoke('setlist:browse-files'),
    export: (setlistData, options) => ipcRenderer.invoke('setlist:export', { setlistData, options })
  },
  templates: {
    load: (type) => ipcRenderer.invoke('templates:load', { type }),
    save: (type, template) => ipcRenderer.invoke('templates:save', { type, template }),
    delete: (type, templateId) => ipcRenderer.invoke('templates:delete', { type, templateId }),
    update: (type, templateId, updates) => ipcRenderer.invoke('templates:update', { type, templateId, updates }),
    nameExists: (type, name, excludeId) => ipcRenderer.invoke('templates:name-exists', { type, name, excludeId })
  },
  bible: {
    loadFile: () => ipcRenderer.invoke('bible:load-file'),
    loadAll: () => ipcRenderer.invoke('bible:load-all'),
    save: (id, data) => ipcRenderer.invoke('bible:save', { id, data }),
    delete: (id) => ipcRenderer.invoke('bible:delete', { id }),
    parseString: (content, fileName) => ipcRenderer.invoke('bible:parse-string', { content, fileName })
  },
  // Live Sermon Assist (Phase 2): the engine-control surface.
  //   live  start / stop / get-state, plus install and select-model — the
  //         resumable model downloader (progress on speech:progress,
  //         republished state on speech:install-state) and digest-verified
  //         model selection. install accepts { modelId } to start/join a
  //         download and { modelId, cancel:true } to cancel it.
  //   stub  uninstall (Phase 6 erase) and benchmark (Phase 3) — real
  //         argument shapes, documented { ok:false, code:'not-implemented' }
  //         replies until those phases land.
  //   history (Decision D9 / Phase 4): browse / search / export / erase the
  //         local transcript history, plus `append` — the write path the
  //         supervisor will call directly once its module may be edited.
  //         `list` replies with summaries only (no segment text); only
  //         `get` and the bounded excerpts of `search` return content.
  diagnostics: {
    // The detailed journal: renderer entries (timings, counts, outcomes —
    // never transcript/audio/token text; the diagnostics module redacts
    // those before sending) appended to selah-diagnostics.log.
    // `read` returns the tail for the Copy-logs button (capped server-side).
    append: (entry) => ipcRenderer.invoke('diagnostics:append', entry),
    info: () => ipcRenderer.invoke('diagnostics:info'),
    read: (options) => ipcRenderer.invoke('diagnostics:read', options),
  },
  speech: {
    start: (payload) => ipcRenderer.invoke('speech:start', payload),
    stop: () => ipcRenderer.invoke('speech:stop'),
    getState: () => ipcRenderer.invoke('speech:get-state'),
    install: (payload) => ipcRenderer.invoke('speech:install', payload),
    // The real engine binary (whisper.cpp). Production mode refuses to run
    // without it, so this is the control that makes the mode toggle honest.
    installEngine: () => ipcRenderer.invoke('speech:install-engine'),
    // Actually spawn the installed binary once. A file that exists is not a
    // binary the OS can load (the Windows build needs the VC++ runtime), and
    // this is the only check that tells those apart.
    testEngine: () => ipcRenderer.invoke('speech:engine-selftest'),
    // Phase 6: `{ confirm:false }` previews (touches nothing), `{ confirm:true }`
    // erases. The payload must be forwarded — the handler cannot distinguish a
    // preview from an erase without it, and that distinction is the whole
    // reason this needs a human decision first.
    uninstall: (payload) => ipcRenderer.invoke('speech:uninstall', payload),
    selectModel: (payload) => ipcRenderer.invoke('speech:select-model', payload),
    benchmark: (payload) => ipcRenderer.invoke('speech:benchmark', payload),
    history: {
      list: () => ipcRenderer.invoke('speech:history:list'),
      get: (sessionId) => ipcRenderer.invoke('speech:history:get', { sessionId }),
      search: (query) => ipcRenderer.invoke('speech:history:search', { query }),
      export: (payload) => ipcRenderer.invoke('speech:history:export', payload),
      erase: () => ipcRenderer.invoke('speech:history:erase'),
      append: (payload) => ipcRenderer.invoke('speech:history:append', payload),
    },
    onHealth: (callback) => onSpeechEvent('speech:health', callback),
    onTranscript: (callback) => onSpeechEvent('speech:transcript', callback),
    onVad: (callback) => onSpeechEvent('speech:vad', callback),
    onStatus: (callback) => onSpeechEvent('speech:status', callback),
    onError: (callback) => onSpeechEvent('speech:error', callback),
    onProgress: (callback) => onSpeechEvent('speech:progress', callback),
    onInstallState: (callback) => onSpeechEvent('speech:install-state', callback),
  },
  updateHardwareAcceleration: (disabled) => ipcRenderer.invoke('performance:update-hda', disabled),
  fileNavigator: {
    getState: () => ipcRenderer.invoke('file-navigator:get-state'),
    getSaveDestinations: (preferredDirectory) => ipcRenderer.invoke('file-navigator:save-destinations', preferredDirectory),
    addRoot: () => ipcRenderer.invoke('file-navigator:add-root'),
    createLyricsFolder: () => ipcRenderer.invoke('file-navigator:create-lyrics-folder'),
    removeRoot: (rootPath) => ipcRenderer.invoke('file-navigator:remove-root', rootPath),
    reindex: () => ipcRenderer.invoke('file-navigator:reindex'),
    search: (payload) => ipcRenderer.invoke('file-navigator:search', payload),
    browse: (directoryPath) => ipcRenderer.invoke('file-navigator:browse', directoryPath),
    prepareSave: (payload) => ipcRenderer.invoke('file-navigator:prepare-save', payload),
    preview: (filePath) => ipcRenderer.invoke('file-navigator:preview', filePath),
    open: (filePath) => ipcRenderer.invoke('file-navigator:open', filePath),
    openMany: (filePaths) => ipcRenderer.invoke('file-navigator:open-many', filePaths),
    reveal: (filePath) => ipcRenderer.invoke('file-navigator:reveal', filePath),
    onChange: (callback) => {
      const channel = 'file-navigator:update';
      const listener = (_event, payload) => callback?.(payload);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    }
  }
});

contextBridge.exposeInMainWorld('electronStore', {
  getDarkMode: () => {
    try {
      const store = JSON.parse(localStorage.getItem('lyrics-store'));
      return store?.state?.darkMode || false;
    } catch {
      return false;
    }
  }
});
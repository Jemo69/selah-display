/// Shared data models for the Selah mobile controller.
library;

/// Explicit show-control states (feature #18). Mirrors
/// `shared/showControl.js` on the server.
enum ShowControlState {
  live('LIVE', 'Live'),
  clear('CLEAR', 'Clear'),
  blackout('BLACKOUT', 'Blackout'),
  logo('LOGO', 'Logo');

  const ShowControlState(this.wire, this.label);

  final String wire;
  final String label;

  /// Only LIVE reads as master output ON; everything else is dark.
  bool get isMasterOn => this == ShowControlState.live;

  static ShowControlState fromWire(Object? value) {
    final upper = value?.toString().trim().toUpperCase();
    return ShowControlState.values.firstWhere(
      (state) => state.wire == upper,
      // The legacy boolean is the only other thing the server sends.
      orElse: () =>
          value == false ? ShowControlState.blackout : ShowControlState.live,
    );
  }
}

/// One queued announcement (feature #18).
class TickerItem {
  const TickerItem({
    required this.id,
    required this.text,
    this.targetOutput,
    this.targetName,
  });

  final String id;
  final String text;
  final String? targetOutput;
  final String? targetName;

  static TickerItem fromJson(Map<String, dynamic> json) => TickerItem(
        id: (json['id'] ?? '').toString(),
        text: (json['text'] ?? '').toString(),
        targetOutput: json['targetOutput']?.toString(),
        targetName: json['targetName']?.toString(),
      );
}

class DiscoveredServer {
  const DiscoveredServer({
    required this.name,
    required this.host,
    required this.port,
  });

  final String name;
  final String host;
  final int port;

  String get baseUrl => 'http://$host:$port';

  @override
  bool operator ==(Object other) =>
      other is DiscoveredServer && other.host == host && other.port == port;

  @override
  int get hashCode => Object.hash(host, port);
}

class SavedConnection {
  const SavedConnection({
    required this.serverName,
    required this.host,
    required this.port,
    required this.token,
    required this.deviceId,
  });

  final String serverName;
  final String host;
  final int port;
  final String token;
  final String deviceId;

  String get baseUrl => 'http://$host:$port';

  Map<String, dynamic> toJson() => {
        'serverName': serverName,
        'host': host,
        'port': port,
        'token': token,
        'deviceId': deviceId,
      };

  static SavedConnection fromJson(Map<String, dynamic> json) => SavedConnection(
        serverName: json['serverName'] as String? ?? 'Selah',
        host: json['host'] as String,
        port: json['port'] as int? ?? 4000,
        token: json['token'] as String,
        deviceId: json['deviceId'] as String,
      );
}

class SetlistItem {
  const SetlistItem({
    required this.id,
    required this.displayName,
    this.fileType = 'txt',
  });

  final String id;
  final String displayName;
  final String fileType;

  static SetlistItem fromJson(Map<String, dynamic> json) => SetlistItem(
        id: json['id']?.toString() ?? '',
        displayName: (json['displayName'] ?? json['name'] ?? json['originalName'] ?? '')
            .toString()
            .replaceFirst(RegExp(r'\.(txt|lrc)$', caseSensitive: false), ''),
        fileType: json['fileType'] as String? ?? 'txt',
      );
}

class BibleResult {
  const BibleResult({required this.reference, required this.text});

  final String reference;
  final String text;

  static BibleResult fromJson(Map<String, dynamic> json) => BibleResult(
        reference: (json['reference'] ?? '').toString(),
        text: (json['text'] ?? '').toString(),
      );
}

/// Extracts printable text from a lyric entry, which may be a plain string
/// or a grouped object carrying `displayText`.
String lyricEntryText(Object? entry) {
  if (entry is String) return entry;
  if (entry is Map) {
    return (entry['displayText'] ??
            entry['mainLine'] ??
            entry['text'] ??
            entry['line1'] ??
            '')
        .toString();
  }
  return '';
}

/// Full live state mirrored from the desktop over Socket.IO.
class ShowState {
  const ShowState({
    this.lyrics = const [],
    this.selectedLine,
    this.fileName = '',
    this.isOutputOn = false,
    this.showControl = ShowControlState.live,
    this.tickerQueue = const [],
    this.tickerActiveId,
    this.announcementTargetOutputKey = 'all',
    this.output1Enabled = true,
    this.output2Enabled = true,
    this.stageEnabled = true,
    this.setlist = const [],
    this.scheduleLoaded = false,
    this.scheduleStatus = 'idle',
    this.scheduleName = '',
    this.fingerprint = '',
  });

  final List<String> lyrics;
  final int? selectedLine;
  final String fileName;

  /// Legacy master flag. Prefer [showControl]; only LIVE is master ON.
  final bool isOutputOn;
  final ShowControlState showControl;
  final List<TickerItem> tickerQueue;
  final String? tickerActiveId;
  final String announcementTargetOutputKey;
  final bool output1Enabled;
  final bool output2Enabled;
  final bool stageEnabled;
  final List<SetlistItem> setlist;

  /// Run-sheet clock (scheduler) summary — mirrors the authoritative
  /// server snapshot without the full segment plan.
  final bool scheduleLoaded;
  final String scheduleStatus;
  final String scheduleName;

  /// Last-seen light-sync fingerprint for delta polling.
  final String fingerprint;

  bool get hasLyrics => lyrics.isNotEmpty;

  String? get currentLine =>
      selectedLine != null && selectedLine! >= 0 && selectedLine! < lyrics.length
          ? lyrics[selectedLine!]
          : null;

  String? get upcomingLine {
    final idx = selectedLine;
    if (idx == null || !hasLyrics) return null;
    final next = idx + 1;
    return next < lyrics.length ? lyrics[next] : null;
  }

  ShowState copyWith({
    List<String>? lyrics,
    int? selectedLine,
    bool clearSelectedLine = false,
    String? fileName,
    bool? isOutputOn,
    ShowControlState? showControl,
    List<TickerItem>? tickerQueue,
    String? tickerActiveId,
    bool clearTickerActiveId = false,
    String? announcementTargetOutputKey,
    bool? output1Enabled,
    bool? output2Enabled,
    bool? stageEnabled,
    List<SetlistItem>? setlist,
    bool? scheduleLoaded,
    String? scheduleStatus,
    String? scheduleName,
    String? fingerprint,
  }) =>
      ShowState(
        lyrics: lyrics ?? this.lyrics,
        selectedLine:
            clearSelectedLine ? null : (selectedLine ?? this.selectedLine),
        fileName: fileName ?? this.fileName,
        isOutputOn: isOutputOn ?? this.isOutputOn,
        showControl: showControl ?? this.showControl,
        tickerQueue: tickerQueue ?? this.tickerQueue,
        tickerActiveId: clearTickerActiveId
            ? null
            : (tickerActiveId ?? this.tickerActiveId),
        announcementTargetOutputKey:
            announcementTargetOutputKey ?? this.announcementTargetOutputKey,
        output1Enabled: output1Enabled ?? this.output1Enabled,
        output2Enabled: output2Enabled ?? this.output2Enabled,
        stageEnabled: stageEnabled ?? this.stageEnabled,
        setlist: setlist ?? this.setlist,
        scheduleLoaded: scheduleLoaded ?? this.scheduleLoaded,
        scheduleStatus: scheduleStatus ?? this.scheduleStatus,
        scheduleName: scheduleName ?? this.scheduleName,
        fingerprint: fingerprint ?? this.fingerprint,
      );

  /// Applies a light/sync snapshot (no file contents) onto the state.
  /// Keeps lyrics + selection live without re-downloading the setlist.
  ShowState applyLight(Map<String, dynamic> data) {
    final rawLyrics = data['lyrics'];
    final rawSetlist = (data['setlist'] as List?) ??
        (data['setlistSummary'] as List?) ??
        (data['setlistFiles'] as List?);
    final sel = data.containsKey('selectedLine') ? data['selectedLine'] : selectedLine;
    final masterOn = data.containsKey('isOutputOn') ? data['isOutputOn'] == true : isOutputOn;
    return copyWith(
      lyrics: rawLyrics is List ? rawLyrics.map(lyricEntryText).toList(growable: false) : lyrics,
      selectedLine: sel is num ? sel.toInt() : (data.containsKey('selectedLine') ? selectedLine : selectedLine),
      clearSelectedLine: data.containsKey('selectedLine') && sel == null,
      fileName: data['lyricsFileName']?.toString() ?? fileName,
      isOutputOn: masterOn,
      showControl: data['showState'] != null ? ShowControlState.fromWire(data['showState']) : showControl,
      tickerQueue: data.containsKey('ticker') || data.containsKey('tickerQueue') ? tickerQueueFrom(data['ticker'] is Map ? Map<String, dynamic>.from(data['ticker'] as Map) : data) : tickerQueue,
      tickerActiveId: data['tickerActiveId']?.toString() ?? tickerActiveId,
      output1Enabled: data['output1Enabled'] is bool ? data['output1Enabled'] as bool : output1Enabled,
      output2Enabled: data['output2Enabled'] is bool ? data['output2Enabled'] as bool : output2Enabled,
      stageEnabled: data['stageEnabled'] is bool ? data['stageEnabled'] as bool : stageEnabled,
      setlist: rawSetlist != null
          ? rawSetlist.whereType<Map>().map((e) => SetlistItem.fromJson(Map<String, dynamic>.from(e))).toList(growable: false)
          : setlist,
      scheduleLoaded: data['scheduleLoaded'] is bool ? data['scheduleLoaded'] as bool : scheduleLoaded,
      scheduleStatus: data['scheduleStatus']?.toString() ?? scheduleStatus,
      scheduleName: data['scheduleName']?.toString() ?? scheduleName,
      fingerprint: data['fingerprint']?.toString() ?? fingerprint,
      clearTickerActiveId: data.containsKey('tickerActiveId') && data['tickerActiveId'] == null,
    );
  }

  static ShowState fromCurrentState(Map<String, dynamic> data) {
    final rawLyrics = (data['lyrics'] as List?) ?? const [];
    // Full state (`currentState`) carries `setlistFiles`; the periodic
    // summary (`periodicStateSync`) and the mobile light state carry
    // `setlistSummary` / `setlist` instead. Accept all three so the
    // setlist survives background syncs and fast-path snapshots.
    final rawSetlist = (data['setlistFiles'] as List?) ??
        (data['setlistSummary'] as List?) ??
        (data['setlist'] as List?) ??
        const [];
    final sel = data['selectedLine'];
    final masterOn = data['isOutputOn'] == true;
    return ShowState(
      lyrics: rawLyrics.map(lyricEntryText).toList(growable: false),
      selectedLine: sel is num ? sel.toInt() : null,
      fileName: (data['lyricsFileName'] ?? '').toString(),
      isOutputOn: masterOn,
      // Fall back to the legacy boolean when the server sends no explicit
      // state, so an older server still drives the mobile dock correctly.
      showControl: data['showState'] != null
          ? ShowControlState.fromWire(data['showState'])
          : (masterOn ? ShowControlState.live : ShowControlState.blackout),
      tickerQueue: tickerQueueFrom(data),
      tickerActiveId: data['tickerActiveId']?.toString(),
      announcementTargetOutputKey:
          (data['announcementTargetOutputKey'] ?? 'all').toString(),
      output1Enabled: data['output1Enabled'] != false,
      output2Enabled: data['output2Enabled'] != false,
      stageEnabled: data['stageEnabled'] != false,
      setlist: rawSetlist
          .whereType<Map>()
          .map((e) => SetlistItem.fromJson(Map<String, dynamic>.from(e)))
          .toList(growable: false),
      scheduleLoaded: data['scheduleLoaded'] == true ||
          (data['schedule'] is Map && (data['schedule'] as Map)['loaded'] == true),
      scheduleStatus: (data['scheduleStatus'] ??
              (data['schedule'] is Map ? (data['schedule'] as Map)['status'] : null) ??
              'idle')
          .toString(),
      scheduleName: (data['scheduleName'] ??
              (data['schedule'] is Map && (data['schedule'] as Map)['schedule'] is Map
                  ? ((data['schedule'] as Map)['schedule'] as Map)['name']
                  : null) ??
              '')
          .toString(),
      fingerprint: (data['fingerprint'] ?? '').toString(),
    );
  }

  /// Reads the queue from either the full state or a `tickerUpdate` event.
  static List<TickerItem> tickerQueueFrom(Map<String, dynamic> data) {
    final raw = (data['tickerQueue'] as List?) ??
        (data['tickerItems'] as List?) ??
        const [];
    return raw
        .whereType<Map>()
        .map((e) => TickerItem.fromJson(Map<String, dynamic>.from(e)))
        .toList(growable: false);
  }
}

/// Light snapshot from GET /api/v1/state/light — no file contents.
class LightState {
  const LightState({
    this.lyrics = const [],
    this.selectedLine,
    this.lyricsFileName = '',
    this.isOutputOn = false,
    this.showState = 'LIVE',
    this.setlist = const [],
    this.scheduleLoaded = false,
    this.scheduleStatus = 'idle',
    this.scheduleName = '',
    this.fingerprint = '',
    this.output1Enabled = true,
    this.output2Enabled = true,
    this.stageEnabled = true,
  });

  final List<String> lyrics;
  final int? selectedLine;
  final String lyricsFileName;
  final bool isOutputOn;
  final String showState;
  final List<SetlistItem> setlist;
  final bool scheduleLoaded;
  final String scheduleStatus;
  final String scheduleName;
  final String fingerprint;
  final bool output1Enabled;
  final bool output2Enabled;
  final bool stageEnabled;

  Map<String, dynamic> toSyncMap() => {
        'lyrics': lyrics,
        'selectedLine': selectedLine,
        'lyricsFileName': lyricsFileName,
        'isOutputOn': isOutputOn,
        'showState': showState,
        'setlist': setlist.map((s) => {'id': s.id, 'displayName': s.displayName, 'fileType': s.fileType}).toList(),
        'scheduleLoaded': scheduleLoaded,
        'scheduleStatus': scheduleStatus,
        'scheduleName': scheduleName,
        'fingerprint': fingerprint,
        'output1Enabled': output1Enabled,
        'output2Enabled': output2Enabled,
        'stageEnabled': stageEnabled,
      };

  static LightState fromJson(Map<String, dynamic> json) {
    final rawLyrics = (json['lyrics'] as List?) ?? const [];
    final rawSetlist = (json['setlist'] as List?) ?? const [];
    final sel = json['selectedLine'];
    return LightState(
      lyrics: rawLyrics.map(lyricEntryText).toList(growable: false),
      selectedLine: sel is num ? sel.toInt() : null,
      lyricsFileName: (json['lyricsFileName'] ?? '').toString(),
      isOutputOn: json['isOutputOn'] == true,
      showState: (json['showState'] ?? 'LIVE').toString(),
      setlist: rawSetlist
          .whereType<Map>()
          .map((e) => SetlistItem.fromJson(Map<String, dynamic>.from(e)))
          .toList(growable: false),
      scheduleLoaded: json['scheduleLoaded'] == true,
      scheduleStatus: (json['scheduleStatus'] ?? 'idle').toString(),
      scheduleName: (json['scheduleName'] ?? '').toString(),
      fingerprint: (json['fingerprint'] ?? '').toString(),
      output1Enabled: json['output1Enabled'] != false,
      output2Enabled: json['output2Enabled'] != false,
      stageEnabled: json['stageEnabled'] != false,
    );
  }
}

/// Delta-sync reply from GET /api/v1/sync.
class SyncResult {
  const SyncResult({required this.changed, this.fingerprint = '', this.state});
  final bool changed;
  final String fingerprint;
  final LightState? state;

  static SyncResult fromJson(Map<String, dynamic> json) {
    final st = json['state'];
    return SyncResult(
      changed: json['changed'] == true,
      fingerprint: (json['fingerprint'] ?? '').toString(),
      state: st is Map ? LightState.fromJson(Map<String, dynamic>.from(st)) : null,
    );
  }
}

class BibleSearchResponse {
  const BibleSearchResponse({required this.results, this.experimental = false, this.activeBibleName});
  final List<BibleResult> results;
  final bool experimental;
  final String? activeBibleName;
}

class BibleInfo {
  const BibleInfo({required this.id, required this.name, this.bookCount});
  final String id;
  final String name;
  final int? bookCount;

  static BibleInfo fromJson(Map<String, dynamic> json) => BibleInfo(
        id: (json['id'] ?? '').toString(),
        name: (json['name'] ?? '').toString(),
        bookCount: (json['bookCount'] as num?)?.toInt(),
      );
}

class BibleListResponse {
  const BibleListResponse({required this.bibles, this.activeBibleId, this.activeBible});
  final List<BibleInfo> bibles;
  final String? activeBibleId;
  final BibleInfo? activeBible;

  static BibleListResponse fromJson(Map<String, dynamic> json) {
    final raw = (json['bibles'] as List?) ?? const [];
    return BibleListResponse(
      bibles: raw.whereType<Map>().map((e) => BibleInfo.fromJson(Map<String, dynamic>.from(e))).toList(growable: false),
      activeBibleId: json['activeBibleId']?.toString(),
      activeBible: json['activeBible'] is Map ? BibleInfo.fromJson(Map<String, dynamic>.from(json['activeBible'] as Map)) : null,
    );
  }
}

class SetlistSearchHit {
  const SetlistSearchHit({required this.item, required this.score, this.matchedField, this.sentence = false});
  final SetlistItem item;
  final num score;
  final String? matchedField;
  final bool sentence;
}

class SetlistSearchResult {
  const SetlistSearchResult({required this.results, this.experimental = false, this.totalSetlist = 0});
  final List<SetlistSearchHit> results;
  final bool experimental;
  final int totalSetlist;

  static SetlistSearchResult fromJson(Map<String, dynamic> json) {
    final raw = (json['results'] as List?) ?? const [];
    return SetlistSearchResult(
      results: raw.whereType<Map>().map((e) {
        final m = Map<String, dynamic>.from(e);
        final file = m['file'];
        return SetlistSearchHit(
          item: file is Map ? SetlistItem.fromJson(Map<String, dynamic>.from(file)) : const SetlistItem(id: '', displayName: ''),
          score: (m['score'] as num?) ?? 0,
          matchedField: m['matchedField']?.toString(),
          sentence: m['sentence'] == true,
        );
      }).toList(growable: false),
      experimental: json['experimental'] == true,
      totalSetlist: (json['totalSetlist'] as num?)?.toInt() ?? 0,
    );
  }
}

/// Run-sheet clock snapshot (authoritative server state).
class ScheduleSnapshot {
  const ScheduleSnapshot({
    this.loaded = false,
    this.status = 'idle',
    this.name = '',
    this.itemIndex = 0,
    this.itemCount = 0,
    this.currentItemName = '',
    this.remainingMs,
    this.endEpochMs,
    this.raw = const {},
  });

  final bool loaded;
  final String status;
  final String name;
  final int itemIndex;
  final int itemCount;
  final String currentItemName;
  final int? remainingMs;
  final int? endEpochMs;
  final Map<String, dynamic> raw;

  static ScheduleSnapshot fromJson(Map<String, dynamic> json) {
    final sched = json['schedule'];
    final schedMap = sched is Map ? Map<String, dynamic>.from(sched) : null;
    final items = schedMap?['items'];
    final idx = (json['itemIndex'] as num?)?.toInt() ?? 0;
    String currentName = '';
    if (items is List && idx >= 0 && idx < items.length && items[idx] is Map) {
      currentName = ((items[idx] as Map)['name'] ?? '').toString();
    }
    return ScheduleSnapshot(
      loaded: json['loaded'] == true,
      status: (json['status'] ?? 'idle').toString(),
      name: (schedMap?['name'] ?? '').toString(),
      itemIndex: idx,
      itemCount: items is List ? items.length : 0,
      currentItemName: currentName,
      remainingMs: (json['remainingMs'] as num?)?.toInt(),
      endEpochMs: (json['endEpochMs'] as num?)?.toInt(),
      raw: Map<String, dynamic>.from(json),
    );
  }
}

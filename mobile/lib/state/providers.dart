/// Central Riverpod wiring: saved pairing, live show state, and commands.
library;

import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/config.dart';
import '../core/discovery_service.dart';
import '../core/models.dart';
import '../core/pairing_store.dart';
import '../core/server_api.dart';
import '../core/socket_service.dart';

final pairingStoreProvider = Provider<PairingStore>((ref) => PairingStore());

final socketServiceProvider = Provider<SocketService>((ref) {
  final service = SocketService();
  ref.onDispose(service.dispose);
  return service;
});

final discoveryServiceProvider = Provider<DiscoveryService>((ref) {
  return DiscoveryService();
});

/// The saved pairing, if any. Null means the app starts at discovery.
class SessionState {
  const SessionState({
    this.connection,
    this.loading = true,
    this.connectError,
    this.authFailure = false,
  });
  final SavedConnection? connection;
  final bool loading;

  /// Set when the last connect attempt failed; drives the shell's error UI.
  final String? connectError;

  /// True when [connectError] is a token rejection — re-pairing is required.
  final bool authFailure;

  bool get isPaired => connection != null;

  SessionState copyWith({
    SavedConnection? connection,
    bool? loading,
    String? connectError,
    bool clearConnectError = false,
    bool? authFailure,
  }) =>
      SessionState(
        connection: connection ?? this.connection,
        loading: loading ?? this.loading,
        connectError:
            clearConnectError ? null : (connectError ?? this.connectError),
        authFailure: authFailure ?? this.authFailure,
      );
}

class SessionNotifier extends AsyncNotifier<SessionState> {
  @override
  Future<SessionState> build() async {
    final connection = await ref.read(pairingStoreProvider).load();
    // Auto-connect on launch when we have a saved pairing.
    if (connection != null) _startRealtime();
    return SessionState(connection: connection, loading: false);
  }

  Future<void> pair(SavedConnection connection) async {
    await ref.read(pairingStoreProvider).save(connection);
    state = AsyncData(SessionState(connection: connection));
    await _startRealtime();
  }

  Future<void> forget() async {
    ref.read(socketServiceProvider).disconnect();
    ref.read(syncPollProvider.notifier).stop();
    await ref.read(pairingStoreProvider).clear();
    state = const AsyncData(SessionState());
  }

  Future<void> reconnect() => _startRealtime();

  /// Persists a refreshed JWT without forcing a re-pair.
  Future<void> persistRefreshedToken(String newToken) async {
    final current = state.value?.connection;
    if (current == null) return;
    final updated = SavedConnection(
      serverName: current.serverName,
      host: current.host,
      port: current.port,
      token: newToken,
      deviceId: current.deviceId,
    );
    await ref.read(pairingStoreProvider).save(updated);
    state = AsyncData(state.value!.copyWith(connection: updated));
  }

  Future<void> _startRealtime() async {
    final connection = state.value?.connection;
    if (connection == null) return;
    state = AsyncData(state.value!.copyWith(clearConnectError: true));
    try {
      await ref.read(showStateProvider.notifier).attach(connection);
      ref.read(syncPollProvider.notifier).start();
    } on SocketConnectFailure catch (e) {
      if (e.cancelled) return; // superseded by another connect/forget
      state = AsyncData(state.value!.copyWith(
        connectError: e.isAuthError
            ? 'Pairing expired — enter the code again'
            : 'Could not reach ${connection.host}:${connection.port}',
        authFailure: e.isAuthError,
      ));
    }
  }
}

final sessionProvider =
    AsyncNotifierProvider<SessionNotifier, SessionState>(SessionNotifier.new);

/// Live mirror of the desktop show state, fed by the Socket.IO stream.
/// The light fast-path (`requestLightState` / `syncState`) merges without
/// wiping locally-held lyrics, so a 1KB song never blanks on a slow link.
class ShowStateNotifier extends Notifier<ShowState> {
  StreamSubscription<SocketEvent>? _events;

  @override
  ShowState build() => const ShowState();

  ConnectionPhase get connectionPhase =>
      ref.read(socketServiceProvider).status.phase;

  /// Starts the socket connection and completes once the socket is connected
  /// (or throws [SocketConnectFailure] on the first failed attempt).
  Future<void> attach(SavedConnection connection) async {
    final socket = ref.read(socketServiceProvider);
    _events?.cancel();

    final connected = socket.connect(
      host: connection.host,
      port: connection.port,
      token: connection.token,
    );

    _events = socket.events.listen(_handleEvent);

    await connected;
  }

  void _handleEvent(SocketEvent event) {
    switch (event.name) {
      case 'currentState':
      case 'periodicStateSync':
        if (event.data is Map) {
          final data = Map<String, dynamic>.from(event.data as Map);
          // Light snapshots (light:true) merge; full snapshots replace.
          if (data['light'] == true) {
            state = state.applyLight(data);
          } else {
            state = ShowState.fromCurrentState(data);
          }
        }
        break;
      case 'syncState':
        if (event.data is Map) {
          final data = Map<String, dynamic>.from(event.data as Map);
          if (data['changed'] == true && data['state'] is Map) {
            state = state.applyLight(
                Map<String, dynamic>.from(data['state'] as Map));
          } else if (data['fingerprint'] != null) {
            state = state.copyWith(
                fingerprint: data['fingerprint'].toString());
          }
        }
        break;
      case 'lineUpdate':
        if (event.data is Map) {
          final data = Map<String, dynamic>.from(event.data as Map);
          if (data['index'] is num) {
            state = state.copyWith(selectedLine: (data['index'] as num).toInt());
          }
        } else if (event.data is num) {
          state = state.copyWith(selectedLine: (event.data as num).toInt());
        }
        break;
      case 'lyricsLoad':
        if (event.data is List) {
          state = state.copyWith(
            lyrics: (event.data as List).map(lyricEntryText).toList(),
            clearSelectedLine: true,
          );
        } else if (event.data is Map) {
          final data = Map<String, dynamic>.from(event.data as Map);
          final lines = data['lyrics'];
          if (lines is List) {
            state = state.copyWith(
              lyrics: lines.map(lyricEntryText).toList(),
              clearSelectedLine: true,
            );
          }
        }
        break;
      case 'fileNameUpdate':
        state = state.copyWith(fileName: event.data?.toString() ?? '');
        break;
      case 'setlistLoadSuccess':
        // The server does not emit fileNameUpdate for setlist loads, so the
        // title arrives here. Applied after lyricsLoad in stream order.
        if (event.data is Map) {
          final data = Map<String, dynamic>.from(event.data as Map);
          final name = (data['fileName'] ?? '').toString();
          if (name.isNotEmpty) {
            state = state.copyWith(
              fileName: name,
              clearSelectedLine: true,
            );
          }
        }
        break;
      case 'bibleVerseLoaded':
        if (event.data is Map) {
          final data = Map<String, dynamic>.from(event.data as Map);
          final reference = (data['reference'] ?? '').toString();
          if (reference.isNotEmpty) {
            state = state.copyWith(fileName: reference);
          }
        }
        break;
      case 'freeNoteLoaded':
        if (event.data is Map) {
          final data = Map<String, dynamic>.from(event.data as Map);
          final title = (data['title'] ?? '').toString();
          if (title.isNotEmpty) {
            state = state.copyWith(fileName: title);
          }
        }
        break;
      case 'contentModeUpdate':
      case 'contentLoaded':
        if (event.data is Map) {
          final data = Map<String, dynamic>.from(event.data as Map);
          final file = data['fileName']?.toString();
          if (file != null && file.isNotEmpty) {
            state = state.copyWith(fileName: file);
          }
        }
        break;
      case 'setlistUpdate':
        if (event.data is List) {
          state = state.copyWith(
            setlist: (event.data as List)
                .whereType<Map>()
                .map((e) =>
                    SetlistItem.fromJson(Map<String, dynamic>.from(e)))
                .toList(),
          );
        } else if (event.data is Map) {
          // Server sometimes wraps the list; accept both shapes.
          final data = Map<String, dynamic>.from(event.data as Map);
          final list = data['setlist'] ?? data['setlistFiles'];
          if (list is List) {
            state = state.copyWith(
              setlist: list
                  .whereType<Map>()
                  .map((e) =>
                      SetlistItem.fromJson(Map<String, dynamic>.from(e)))
                  .toList(),
            );
          }
        }
        break;
      case 'outputToggle':
        if (event.data is bool) {
          state = state.copyWith(
              isOutputOn: event.data == true,
              showControl: (event.data == true)
                  ? ShowControlState.live
                  : ShowControlState.blackout);
        } else if (event.data is Map) {
          final data = Map<String, dynamic>.from(event.data as Map);
          if (data['state'] != null) {
            final next = ShowControlState.fromWire(data['state']);
            state = state.copyWith(showControl: next, isOutputOn: next.isMasterOn);
          } else if (data['isOutputOn'] is bool) {
            state = state.copyWith(isOutputOn: data['isOutputOn'] as bool);
          }
        }
        break;
      case 'showStateUpdate':
        if (event.data is Map) {
          final next =
              ShowControlState.fromWire((event.data as Map)['state']);
          state = state.copyWith(showControl: next, isOutputOn: next.isMasterOn);
        } else if (event.data is String) {
          final next = ShowControlState.fromWire(event.data);
          state = state.copyWith(showControl: next, isOutputOn: next.isMasterOn);
        }
        break;
      case 'tickerUpdate':
        if (event.data is Map) {
          final data = Map<String, dynamic>.from(event.data as Map);
          final queueData = data['queue'] ?? data['tickerQueue'] ?? data;
          final queue = queueData is Map
              ? ShowState.tickerQueueFrom(Map<String, dynamic>.from(queueData))
              : ShowState.tickerQueueFrom(data);
          state = state.copyWith(
            tickerQueue: queue,
            tickerActiveId: (data['activeId'] ?? data['tickerActiveId'])?.toString(),
            clearTickerActiveId: (data['activeId'] ?? data['tickerActiveId']) == null,
          );
        }
        break;
      case 'individualOutputToggle':
        if (event.data is Map) {
          final map = Map<String, dynamic>.from(event.data as Map);
          final enabled = map['enabled'] == true;
          switch (map['output']) {
            case 'output1':
              state = state.copyWith(output1Enabled: enabled);
              break;
            case 'output2':
              state = state.copyWith(output2Enabled: enabled);
              break;
            case 'stage':
              state = state.copyWith(stageEnabled: enabled);
              break;
          }
        }
        break;
      case 'scheduleState':
        if (event.data is Map) {
          final snap = ScheduleSnapshot.fromJson(
              Map<String, dynamic>.from(event.data as Map));
          state = state.copyWith(
            scheduleLoaded: snap.loaded,
            scheduleStatus: snap.status,
            scheduleName: snap.name,
          );
          ref.read(scheduleProvider.notifier).ingest(snap);
        }
        break;
      case 'setlistError':
      case 'tickerError':
      case 'scheduleError':
      case 'permissionError':
      case 'authError':
      case 'draftError':
        ref.read(lastServerErrorProvider.notifier).state =
            event.data?.toString() ?? event.name;
        break;
      case 'draftApproved':
      case 'draftSubmitted':
      case 'setlistAddSuccess':
      case 'tickerAddSuccess':
        ref.read(lastServerNoticeProvider.notifier).state =
            event.name == 'draftApproved' ? 'Draft approved' : null;
        break;
    }
  }

  void detach() {
    _events?.cancel();
    _events = null;
    ref.read(socketServiceProvider).disconnect();
    state = const ShowState();
  }
}

final showStateProvider =
    NotifierProvider<ShowStateNotifier, ShowState>(ShowStateNotifier.new);

/// Latest async server error for snackbars (permission / validation).
final lastServerErrorProvider = StateProvider<String?>((ref) => null);
final lastServerNoticeProvider = StateProvider<String?>((ref) => null);

/// Authoritative scheduler snapshot (full detail for the Schedule tab).
class ScheduleNotifier extends Notifier<ScheduleSnapshot> {
  @override
  ScheduleSnapshot build() => const ScheduleSnapshot();

  void ingest(ScheduleSnapshot snap) => state = snap;

  Future<String?> control(String action, {Map<String, dynamic>? extra}) async {
    final api = ref.read(serverApiProvider);
    if (api == null) return 'Not paired to a server';
    try {
      state = await api.scheduleControl(action, extra: extra);
      return null;
    } on ApiException catch (e) {
      return e.message;
    } catch (_) {
      return 'Could not reach the server';
    }
  }

  Future<String?> refresh() async {
    final api = ref.read(serverApiProvider);
    if (api == null) return 'Not paired';
    try {
      state = await api.scheduleGet();
      return null;
    } on ApiException catch (e) {
      return e.message;
    } catch (_) {
      return 'Could not reach the server';
    }
  }
}

final scheduleProvider =
    NotifierProvider<ScheduleNotifier, ScheduleSnapshot>(ScheduleNotifier.new);

/// REST fallback poll: when the socket drops, poll /api/v1/sync every few
/// seconds so NEXT/PREV and line highlights keep working on Tailscale.
class SyncPollNotifier extends Notifier<bool> {
  Timer? _timer;

  @override
  bool build() {
    ref.onDispose(() => _timer?.cancel());
    return false;
  }

  void start() {
    stop();
    state = true;
    _timer = Timer.periodic(AppConfig.syncPollInterval, (_) => _tick());
  }

  void stop() {
    _timer?.cancel();
    _timer = null;
    state = false;
  }

  Future<void> _tick() async {
    final socket = ref.read(socketServiceProvider);
    if (socket.status.isConnected) return; // socket is live — no polling
    final api = ref.read(serverApiProvider);
    if (api == null) return;
    try {
      final fingerprint = ref.read(showStateProvider).fingerprint;
      final res = await api.sync(since: fingerprint.isEmpty ? null : fingerprint);
      if (res.changed && res.state != null) {
        ref.read(showStateProvider.notifier).state =
            ref.read(showStateProvider).applyLight(res.state!.toSyncMap());
      } else if (res.fingerprint.isNotEmpty) {
        ref.read(showStateProvider.notifier).state =
            ref.read(showStateProvider).copyWith(fingerprint: res.fingerprint);
      }
    } catch (_) {
      // Best-effort background sync — the shell banner owns the error UI.
    }
  }
}

final syncPollProvider = NotifierProvider<SyncPollNotifier, bool>(SyncPollNotifier.new);

/// Push-based connection status. The SocketService listener pattern means a
/// subscriber added at any moment immediately receives the current status,
/// so the banner never shows stale or missed states.
final connectionStatusProvider =
    NotifierProvider<ConnectionStatusNotifier, ConnectionStatus>(
        ConnectionStatusNotifier.new);

class ConnectionStatusNotifier extends Notifier<ConnectionStatus> {
  @override
  ConnectionStatus build() {
    final socket = ref.watch(socketServiceProvider);
    late final void Function(ConnectionStatus) listener;
    listener = (status) => state = status;
    ref.onDispose(() => socket.removeListener(listener));
    socket.addListener(listener);
    return socket.status;
  }
}

/// REST command helper built from the current pairing. Persists refreshed
/// JWTs so a 24h expiry or a desktop restart never forces a re-pair.
final serverApiProvider = Provider<ServerApi?>((ref) {
  final connection =
      ref.watch(sessionProvider).valueOrNull?.connection;
  if (connection == null) return null;
  return ServerApi(
    baseUrl: connection.baseUrl,
    token: connection.token,
    onTokenRefresh: (fresh) {
      ref.read(sessionProvider.notifier).persistRefreshedToken(fresh);
    },
  );
});

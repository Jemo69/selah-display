/// Socket.IO connection: authenticates with the pairing JWT and exposes
/// connection status + server events for Riverpod providers.
///
/// Status is delivered two ways so late subscribers never miss state:
///  - `status` getter: always-current snapshot.
///  - `addListener`: pushed on every change (used by ConnectionStatusNotifier).
library;

import 'dart:async';
import 'dart:collection';

import 'package:socket_io_client/socket_io_client.dart' as io;

import 'config.dart';

enum ConnectionPhase { disconnected, connecting, connected, reconnecting, failed }

class ConnectionStatus {
  const ConnectionStatus({
    this.phase = ConnectionPhase.disconnected,
    this.error,
    this.authFailure = false,
  });

  final ConnectionPhase phase;
  final String? error;

  /// True when the server rejected our token; retrying cannot help,
  /// the user must re-pair.
  final bool authFailure;

  bool get isConnected => phase == ConnectionPhase.connected;
  bool get isWaiting => phase == ConnectionPhase.connecting || phase == ConnectionPhase.reconnecting;
  bool get isTerminalFailure => phase == ConnectionPhase.failed;

  ConnectionStatus copyWith({
    ConnectionPhase? phase,
    String? error,
    bool clearError = false,
    bool? authFailure,
  }) =>
      ConnectionStatus(
        phase: phase ?? this.phase,
        error: clearError ? null : (error ?? this.error),
        authFailure: authFailure ?? this.authFailure,
      );
}

/// Thrown by [SocketService.connect] when the first connection attempt fails.
class SocketConnectFailure implements Exception {
  SocketConnectFailure(this.message,
      {required this.isAuthError, this.cancelled = false});
  final String message;
  final bool isAuthError;

  /// True when the attempt was aborted by an explicit disconnect()
  /// (e.g. switching servers), not an actual network failure.
  final bool cancelled;

  @override
  String toString() => message;
}

class SocketEvent {
  const SocketEvent(this.name, this.data);
  final String name;
  final Object? data;
}

/// Classifies a socket connect error so the UI can tell "wrong token"
/// (terminal) apart from "network trouble" (retryable). Exposed for tests.
bool isAuthConnectError(Object? data) {
  final text = data.toString().toLowerCase();
  return text.contains('token') || text.contains('auth');
}

class SocketService {
  io.Socket? _socket;
  StreamController<SocketEvent>? _events;
  final Queue<(String, Object?)> _sendQueue = Queue();
  Timer? _heartbeat;
  Completer<void>? _firstConnect;
  bool _everConnected = false;

  ConnectionStatus _status = const ConnectionStatus();
  final Set<void Function(ConnectionStatus)> _listeners = {};

  ConnectionStatus get status => _status;

  /// Push-based status delivery. Listeners added after a change still see
  /// the latest state via the [status] snapshot, so nothing is ever missed.
  void addListener(void Function(ConnectionStatus) listener) {
    _listeners.add(listener);
    listener(_status);
  }

  void removeListener(void Function(ConnectionStatus) listener) {
    _listeners.remove(listener);
  }

  Stream<SocketEvent> get events =>
      (_events ??= StreamController.broadcast()).stream;

  /// Connects and completes when the socket is first connected, or throws
  /// [SocketConnectFailure] on the first failed attempt (so callers can give
  /// fast feedback). Background reconnection continues independently.
  Future<void> connect({
    required String host,
    required int port,
    required String token,
  }) {
    disconnect();
    _everConnected = false;
    final completer = _firstConnect = Completer<void>();
    _publish(const ConnectionStatus(phase: ConnectionPhase.connecting));

    // Plain http works on LAN and Tailscale alike (100.x / MagicDNS).
    // Polling first (passes tailnet relays), websocket upgrade when fast.
    final socket = _socket = io.io(
      'http://$host:$port',
      io.OptionBuilder()
          .setTransports(['polling', 'websocket'])
          .setAuth({'token': token})
          .enableReconnection()
          .setReconnectionDelay(800)
          .setReconnectionDelayMax(4000)
          .setTimeout(AppConfig.socketTimeout.inMilliseconds)
          .build(),
    );

    socket.onConnect((_) {
      _everConnected = true;
      socket.emit('clientConnect', {'type': 'mobile'});
      // Light first: <4KB snapshot so a 1KB lyric appears instantly on
      // slow church Wi-Fi / Tailscale; full setlist content is lazy.
      socket.emit('requestLightState');
      socket.emit('requestSchedule');
      _publish(ConnectionStatus(phase: ConnectionPhase.connected));
      _flushQueue();
      _startHeartbeat();
      _completeFirstConnect(null);
    });

    socket.onDisconnect((_) {
      _stopHeartbeat();
      if (_everConnected) {
        // Real drop mid-session; socket.io keeps retrying underneath.
        _publish(const ConnectionStatus(
          phase: ConnectionPhase.reconnecting,
          error: 'Connection lost',
        ));
      } else {
        _publish(const ConnectionStatus(phase: ConnectionPhase.disconnected));
      }
    });

    socket.onConnectError((data) {
      final auth = isAuthConnectError(data);
      if (_everConnected) {
        _publish(ConnectionStatus(
          phase: ConnectionPhase.reconnecting,
          error: data.toString(),
          authFailure: auth,
        ));
      } else {
        _publish(ConnectionStatus(
          phase: auth ? ConnectionPhase.failed : ConnectionPhase.connecting,
          error: data.toString(),
          authFailure: auth,
        ));
        if (auth) {
          // Wrong/expired token: retrying is pointless, stop the churn.
          socket.dispose();
          _completeFirstConnect(SocketConnectFailure(
            data.toString(),
            isAuthError: true,
          ));
        } else {
          _completeFirstConnect(SocketConnectFailure(
            data.toString(),
            isAuthError: false,
          ));
        }
      }
    });

    for (final name in [
      'currentState',
      'periodicStateSync',
      'syncState',
      'lineUpdate',
      'lyricsLoad',
      'lyricsTimestampsUpdate',
      'lyricsSectionsUpdate',
      'fileNameUpdate',
      'setlistUpdate',
      'setlistAddSuccess',
      'setlistRemoveSuccess',
      'setlistReorderSuccess',
      'setlistError',
      'outputToggle',
      'showStateUpdate',
      'tickerUpdate',
      'tickerAddSuccess',
      'tickerError',
      'individualOutputToggle',
      'setlistLoadSuccess',
      'bibleVerseLoaded',
      'freeNoteLoaded',
      'contentModeUpdate',
      'contentLoaded',
      'scheduleState',
      'scheduleError',
      'draftSubmitted',
      'draftApproved',
      'draftRejected',
      'draftError',
      'permissionError',
      'authError',
      'lyricsSplitSuccess',
      'heartbeat_ack',
    ]) {
      socket.on(name, (data) => _emit(SocketEvent(name, data)));
    }

    return completer.future;
  }

  void _completeFirstConnect([Object? error]) {
    final completer = _firstConnect;
    if (completer == null || completer.isCompleted) return;
    if (error == null) {
      completer.complete();
    } else {
      completer.completeError(error);
    }
  }

  void emit(String event, [Object? data]) {
    final socket = _socket;
    if (socket != null && socket.connected) {
      socket.emit(event, data);
    } else if (_sendQueue.length < AppConfig.maxQueuedSocketEvents) {
      _sendQueue.add((event, data));
    }
  }

  void disconnect() {
    _stopHeartbeat();
    _sendQueue.clear();
    _completeFirstConnect(SocketConnectFailure(
      'Disconnected before connecting',
      isAuthError: false,
      cancelled: true,
    ));
    _socket?.dispose();
    _socket = null;
    _publish(const ConnectionStatus(phase: ConnectionPhase.disconnected));
  }

  void dispose() {
    disconnect();
    _events?.close();
    _events = null;
    _listeners.clear();
  }

  void _publish(ConnectionStatus value) {
    _status = value;
    for (final listener in Set.of(_listeners)) {
      listener(value);
    }
  }

  void _emit(SocketEvent event) {
    if (!(_events?.isClosed ?? true)) _events!.add(event);
  }

  void _flushQueue() {
    final socket = _socket;
    while (_sendQueue.isNotEmpty && socket != null && socket.connected) {
      final (event, data) = _sendQueue.removeFirst();
      socket.emit(event, data);
    }
  }

  void _startHeartbeat() {
    _stopHeartbeat();
    _heartbeat = Timer.periodic(AppConfig.heartbeatInterval, (_) {
      final socket = _socket;
      if (socket != null && socket.connected) socket.emit('heartbeat');
    });
  }

  void _stopHeartbeat() {
    _heartbeat?.cancel();
    _heartbeat = null;
  }
}

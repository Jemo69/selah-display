/// Typed REST client for the Selah `/api/v1` endpoints used by mobile.
///
/// Fast path: every control call has a short timeout and surfaces the real
/// server error (no more silent `catch (_) {}` dead buttons). Token refresh
/// is automatic — an expired JWT (24h) or a rotated join code re-mints via
/// POST /api/auth/refresh instead of forcing a full re-pair.
library;

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'config.dart';
import 'models.dart';

class ApiException implements Exception {
  ApiException(this.message, {this.statusCode, this.authFailure = false});
  final String message;
  final int? statusCode;

  /// True when the server rejected our token — the UI should prompt
  /// re-pairing instead of retrying the same call.
  final bool authFailure;

  @override
  String toString() => message;
}

class ServerApi {
  ServerApi({required this.baseUrl, required this.token, this.onTokenRefresh});

  final String baseUrl;
  String token;

  /// Called with the fresh JWT after an automatic refresh so the pairing
  /// store can persist it.
  final void Function(String newToken)? onTokenRefresh;

  Map<String, String> get _headers => {
        'Authorization': 'Bearer $token',
        'Content-Type': 'application/json',
      };

  Uri _uri(String path, [Map<String, String>? query]) =>
      Uri.parse('$baseUrl/api/v1$path').replace(queryParameters: query);

  Future<dynamic> _send(Future<http.Response> Function() request,
      {bool retried = false}) async {
    http.Response res;
    try {
      res = await request().timeout(AppConfig.apiTimeout);
    } on TimeoutException {
      throw ApiException('Server is slow — check Wi-Fi or Tailscale');
    } catch (_) {
      throw ApiException('Could not reach the server');
    }
    if ((res.statusCode == 401 || res.statusCode == 403) && !retried) {
      if (await _tryRefresh()) {
        return _send(request, retried: true);
      }
      throw ApiException('Pairing expired — enter the code again',
          statusCode: res.statusCode, authFailure: true);
    }
    dynamic body;
    try {
      body = jsonDecode(utf8.decode(res.bodyBytes));
    } catch (_) {
      throw ApiException('Bad server reply (${res.statusCode})',
          statusCode: res.statusCode);
    }
    if (res.statusCode >= 400) {
      throw ApiException(
        (body is Map ? body['error'] : null)?.toString() ??
            'Request failed (${res.statusCode})',
        statusCode: res.statusCode,
        authFailure: res.statusCode == 401,
      );
    }
    return body;
  }

  /// Best-effort JWT refresh. Returns true when [token] was replaced.
  Future<bool> _tryRefresh() async {
    try {
      final res = await http
          .post(
            Uri.parse('$baseUrl/api/auth/refresh'),
            headers: const {'Content-Type': 'application/json'},
            body: jsonEncode({'token': token}),
          )
          .timeout(AppConfig.apiTimeout);
      if (res.statusCode != 200) return false;
      final body = jsonDecode(utf8.decode(res.bodyBytes));
      final fresh = body is Map ? body['token']?.toString() : null;
      if (fresh == null || fresh.isEmpty) return false;
      token = fresh;
      onTokenRefresh?.call(fresh);
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<Map<String, dynamic>> status() async {
    final body = await _send(() => http.get(_uri('/status'), headers: _headers));
    return Map<String, dynamic>.from(body['status'] as Map);
  }

  /// Tiny snapshot for phones: no setlist file contents (~2-4KB).
  Future<LightState> lightState() async {
    final body =
        await _send(() => http.get(_uri('/state/light'), headers: _headers));
    return LightState.fromJson(Map<String, dynamic>.from(body));
  }

  /// Delta sync: { changed, fingerprint, state? }. When nothing changed
  /// the reply is ~100 bytes — cheap enough to poll on Tailscale.
  Future<SyncResult> sync({String? since}) async {
    final body = await _send(
        () => http.get(_uri('/sync', since == null ? null : {'since': since}), headers: _headers));
    return SyncResult.fromJson(Map<String, dynamic>.from(body));
  }

  Future<int> lyricsNext() async {
    final body = await _send(
      () => http.post(_uri('/lyrics/next'), headers: _headers),
    );
    return (body['selectedLine'] as num).toInt();
  }

  Future<int> lyricsPrev() async {
    final body = await _send(
      () => http.post(_uri('/lyrics/prev'), headers: _headers),
    );
    return (body['selectedLine'] as num).toInt();
  }

  Future<void> lyricsGoto(int lineIndex) => _send(
        () => http.post(
          _uri('/lyrics/goto'),
          headers: _headers,
          body: jsonEncode({'lineIndex': lineIndex}),
        ),
      ).then((_) {});

  Future<bool> outputToggle({bool? on}) async {
    final body = await _send(
      () => http.post(
        _uri('/output/toggle'),
        headers: _headers,
        body: jsonEncode(on == null ? {} : {'on': on}),
      ),
    );
    return body['isOutputOn'] == true;
  }

  /// Sets the explicit show state (LIVE, CLEAR, BLACKOUT, LOGO).
  Future<String> setShowState(String state) async {
    final body = await _send(
      () => http.post(
        _uri('/output/show-state'),
        headers: _headers,
        body: jsonEncode({'state': state}),
      ),
    );
    return (body['showState'] ?? state).toString();
  }

  Future<String> showState() async {
    final body = await _send(
      () => http.get(_uri('/output/show-state'), headers: _headers),
    );
    return (body['showState'] ?? 'LIVE').toString();
  }

  /// Queues an announcement for the given output. Omit [targetOutput] to
  /// broadcast to every output.
  Future<void> addTickerItem(String text, {String? targetOutput}) => _send(
        () => http.post(
          _uri('/ticker'),
          headers: _headers,
          body: jsonEncode({
            'text': text,
            'targetOutput': ?targetOutput,
          }),
        ),
      ).then((_) {});

  Future<void> showTickerItem(String? id) => _send(
        () => http.post(
          _uri('/ticker/show'),
          headers: _headers,
          body: jsonEncode({'id': ?id}),
        ),
      ).then((_) {});

  Future<void> removeTickerItem(String id) => _send(
        () => http.delete(_uri('/ticker/$id'), headers: _headers),
      ).then((_) {});

  Future<void> clearTicker() => _send(
        () => http.post(_uri('/ticker/clear'), headers: _headers),
      ).then((_) {});

  Future<List<SetlistItem>> setlist() async {
    final body = await _send(() => http.get(_uri('/setlist'), headers: _headers));
    final items = (body['setlist'] as List?) ?? const [];
    return items
        .whereType<Map>()
        .map((e) => SetlistItem.fromJson(Map<String, dynamic>.from(e)))
        .toList(growable: false);
  }

  Future<void> setlistLoad(String fileId) => _send(
        () => http.post(
          _uri('/setlist/load'),
          headers: _headers,
          body: jsonEncode({'fileId': fileId}),
        ),
      ).then((_) {});

  Future<void> setlistAddText(String name, String content) => _send(
        () => http.post(
          _uri('/setlist/add'),
          headers: _headers,
          body: jsonEncode({
            'name': '$name.txt',
            'content': content,
            'fileType': 'txt',
          }),
        ),
      ).then((_) {});

  Future<void> setlistReorder(List<String> orderedIds) => _send(
        () => http.post(
          _uri('/setlist/reorder'),
          headers: _headers,
          body: jsonEncode({'orderedIds': orderedIds}),
        ),
      ).then((_) {});

  Future<void> setlistRemove(String fileId) => _send(
        () => http.delete(_uri('/setlist/$fileId'), headers: _headers),
      ).then((_) {});

  /// Setlist search with the desktop's sentence-first wins.
  /// experimental=true ranks whole sentences first ("for god so love the
  /// world" puts the right song first instead of OR-matching words).
  Future<SetlistSearchResult> setlistSearch(String query,
      {bool experimental = true, int limit = 20}) => _send(
        () => http.get(
          _uri('/setlist/search', {
            'q': query,
            'limit': '$limit',
            if (experimental) 'experimental': 'true',
          }),
          headers: _headers,
        ),
      ).then((body) =>
          SetlistSearchResult.fromJson(Map<String, dynamic>.from(body as Map)));

  Future<void> bibleReference(String reference) => _send(
        () => http.post(
          _uri('/bible/reference'),
          headers: _headers,
          body: jsonEncode({'reference': reference}),
        ),
      ).then((_) {});

  Future<BibleSearchResponse> bibleSearchFull(String query,
      {int limit = 20, bool searchAll = false, bool experimental = true}) async {
    final body = await _send(
      () => http.get(
        _uri('/bible/search', {
          'q': query,
          'limit': '$limit',
          if (searchAll) 'searchAll': 'true',
          if (experimental) 'experimental': 'true',
        }),
        headers: _headers,
      ),
    );
    final map = Map<String, dynamic>.from(body as Map);
    final results = (map['results'] as List?) ?? const [];
    return BibleSearchResponse(
      results: results
          .whereType<Map>()
          .map((e) => BibleResult.fromJson(Map<String, dynamic>.from(e)))
          .toList(growable: false),
      experimental: map['experimental'] == true,
      activeBibleName: (map['activeBible'] is Map)
          ? (map['activeBible'] as Map)['name']?.toString()
          : null,
    );
  }

  Future<List<BibleResult>> bibleSearch(String query,
      {int limit = 20, bool searchAll = false, bool experimental = true}) async {
    final res = await bibleSearchFull(query,
        limit: limit, searchAll: searchAll, experimental: experimental);
    return res.results;
  }

  Future<BibleListResponse> bibleList() async {
    final body =
        await _send(() => http.get(_uri('/bible/list'), headers: _headers));
    return BibleListResponse.fromJson(Map<String, dynamic>.from(body as Map));
  }

  // ---- Scheduler (run-sheet clock) ----

  Future<ScheduleSnapshot> scheduleGet() async {
    final body =
        await _send(() => http.get(_uri('/schedule'), headers: _headers));
    return ScheduleSnapshot.fromJson(Map<String, dynamic>.from(body as Map));
  }

  Future<ScheduleSnapshot> scheduleControl(String action,
      {Map<String, dynamic>? extra}) async {
    final body = await _send(
      () => http.post(
        _uri('/schedule/control'),
        headers: _headers,
        body: jsonEncode({'action': action, ...?extra}),
      ),
    );
    return ScheduleSnapshot.fromJson(Map<String, dynamic>.from(body as Map));
  }

  /// Exchanges a join code for a JWT. Static because it runs before pairing.
  static Future<SavedConnection> pairWithJoinCode({
    required DiscoveredServer server,
    required String joinCode,
    required String deviceId,
  }) async {
    http.Response res;
    try {
      res = await http
          .post(
            Uri.parse('${server.baseUrl}/api/auth/token'),
            headers: const {'Content-Type': 'application/json'},
            body: jsonEncode({
              'clientType': 'mobile',
              'deviceId': deviceId,
              'joinCode': joinCode,
            }),
          )
          .timeout(AppConfig.apiTimeout);
    } on TimeoutException {
      throw ApiException('Desktop is slow to answer — try again');
    } catch (_) {
      throw ApiException('Could not reach ${server.host}:${server.port}');
    }

    dynamic body;
    try {
      body = jsonDecode(utf8.decode(res.bodyBytes));
    } catch (_) {
      body = null;
    }
    if (res.statusCode >= 400 || body is! Map || body['token'] == null) {
      throw ApiException(
        (body is Map ? body['error'] : null)?.toString() ??
            'Pairing failed (${res.statusCode})',
        statusCode: res.statusCode,
      );
    }
    return SavedConnection(
      serverName: server.name,
      host: server.host,
      port: server.port,
      token: body['token'].toString(),
      deviceId: deviceId,
    );
  }
}

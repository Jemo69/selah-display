import 'dart:convert';

class NetworkUtils {
  static final RegExp _urlHost = RegExp(r'^(?:[a-zA-Z][a-zA-Z0-9+.-]*:)?//([^/:?#]+)');

  /// Tailscale CGNAT 100.64.0.0/10 — the tailnet range phones use off-site.
  static bool isTailscaleIp(String host) {
    final parts = host.split('.');
    if (parts.length != 4) return false;
    final nums = parts.map(int.tryParse).toList();
    if (nums.any((n) => n == null)) return false;
    final vals = nums.cast<int>();
    if (vals.any((n) => n < 0 || n > 255)) return false;
    return vals[0] == 100 && vals[1] >= 64 && vals[1] <= 127;
  }

  static bool isTailnetHostname(String host) {
    final h = host.toLowerCase();
    return h.endsWith('.ts.net') || h.contains('.tailscale');
  }

  static bool isLocalHostname(String hostname) {
    final normalized = hostname.toLowerCase();
    if (normalized.isEmpty) return false;
    return normalized == 'localhost' ||
        normalized == '::1' ||
        normalized == '[::1]' ||
        normalized == '0.0.0.0' ||
        normalized.startsWith('127.') ||
        isTailscaleIp(normalized) ||
        isTailnetHostname(normalized);
  }

  /// Extracts the host portion of a user-entered value. Accepts bare IPs,
  /// Tailscale MagicDNS names (my-pc.tail123.ts.net), hostnames, ports,
  /// and full URLs like `http://192.168.1.50:4000`.
  static String parseHost(String value, {int? port}) {
    var input = value.trim();
    if (input.isEmpty) return '';
    final match = _urlHost.firstMatch(input);
    if (match != null) {
      input = match.group(1)!;
    }
    input = input.replaceAll(RegExp(r'^\[|\]$'), '');
    if (input.contains('/')) {
      input = input.split('/').first;
    }
    // Strip a trailing :port for parse — the caller keeps the port itself.
    final colon = input.lastIndexOf(':');
    if (colon > 0 && !input.substring(colon + 1).contains(':')) {
      final maybePort = input.substring(colon + 1);
      if (int.tryParse(maybePort) != null && !input.startsWith('[')) {
        input = input.substring(0, colon);
      }
    }
    return input.trim();
  }

  /// Parses a QR payload of the form `http://ip:port?joinCode=123456`
  /// or JSON `{host, port, joinCode}`. Host may be an IP, a Tailscale
  /// 100.x address, or a MagicDNS name.
  static ({String host, int port, String joinCode})? parseQrPayload(String payload) {
    final trimmed = payload.trim();
    if (trimmed.startsWith('{')) {
      try {
        final decoded = jsonDecode(trimmed);
        if (decoded is Map<String, dynamic>) {
          return (
            host: decoded['host']?.toString() ?? '',
            port: int.tryParse(decoded['port']?.toString() ?? '') ?? 4000,
            joinCode: decoded['joinCode']?.toString() ?? '',
          );
        }
      } catch (_) {
        return null;
      }
    }
    final uri = Uri.tryParse(trimmed);
    if (uri != null && uri.host.isNotEmpty) {
      final code = uri.queryParameters['joinCode'] ?? '';
      return (
        host: uri.host,
        port: uri.port > 0 ? uri.port : 4000,
        joinCode: code,
      );
    }
    return null;
  }

  /// /24 host list for subnet sweeps. Tailscale IPs share 100.64/10, not a
  /// /24 with the phone, so sweeping there rarely finds peers — the caller
  /// still tries (cheap) but manual IP + QR is the primary tailnet path.
  static List<String> subnetHosts(String deviceIp, {int port = 4000}) {
    final parts = deviceIp.split('.');
    if (parts.length != 4) return const [];
    if (isTailscaleIp(deviceIp)) {
      // Only probe the same /24 slice — a full 4M sweep is pointless.
      final prefix = parts.sublist(0, 3).join('.');
      return [for (var i = 1; i <= 254; i++) '$prefix.$i'];
    }
    final prefix = parts.sublist(0, 3).join('.');
    return [for (var i = 1; i <= 254; i++) '$prefix.$i'];
  }
}

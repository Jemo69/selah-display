/// Network constants shared by discovery, socket, and API layers.
library;

class AppConfig {
  static const int defaultPort = 4000;
  static const String mdnsService = '_lyricdisplay._tcp';
  static const String healthPath = '/api/health';

  /// Subnet sweep tuning — sized for flaky church Wi-Fi + Tailscale.
  /// Bigger batches + shorter timeouts: a /24 finishes in ~2s on Wi-Fi
  /// instead of ~8s. Tailscale 100.x peers rarely share a /24, so the
  /// sweep is best-effort there — manual IP / QR / MagicDNS is primary.
  static const Duration sweepConnectTimeout = Duration(milliseconds: 250);
  static const Duration sweepReceiveTimeout = Duration(milliseconds: 400);
  static const int sweepBatchSize = 40;
  static const Duration discoveryTimeout = Duration(seconds: 4);
  static const Duration mdnsLookupTimeout = Duration(seconds: 1);

  /// REST: fast enough to feel instant on a 1KB lyric, patient enough
  /// for a Tailscale DERP relay on a bad hotspot.
  static const Duration apiTimeout = Duration(seconds: 6);
  static const Duration apiProbeTimeout = Duration(seconds: 3);

  /// Socket: reconnect fast (church Wi-Fi drops), heartbeat often enough
  /// to notice a dead tailnet path within ~15s.
  static const Duration heartbeatInterval = Duration(seconds: 15);
  static const Duration socketTimeout = Duration(seconds: 8);

  /// Light-sync fallback: when the socket drops, poll /api/v1/sync
  /// every few seconds (~100 bytes when unchanged).
  static const Duration syncPollInterval = Duration(seconds: 3);

  static const int maxQueuedSocketEvents = 100;
}

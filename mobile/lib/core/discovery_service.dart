import 'dart:async';

import 'package:dio/dio.dart';
import 'package:multicast_dns/multicast_dns.dart';
import 'package:network_info_plus/network_info_plus.dart';

import 'config.dart';
import 'models.dart';
import 'network_utils.dart';

class DiscoveryService {
  final Dio _dio;
  final NetworkInfo _networkInfo;

  DiscoveryService({Dio? dio, NetworkInfo? networkInfo})
      : _dio = dio ??
            Dio(BaseOptions(
              connectTimeout: AppConfig.sweepConnectTimeout,
              receiveTimeout: AppConfig.sweepReceiveTimeout,
            )),
        _networkInfo = networkInfo ?? NetworkInfo();

  Future<List<DiscoveredServer>> discover() async {
    final results = await Future.wait([
      discoverMdns(),
      sweepSubnet(),
    ]);
    final merged = <DiscoveredServer>{...results[0], ...results[1]}.toList();
    // Tailscale peers sort first — off-site they are the only reachable ones.
    merged.sort((a, b) {
      final at = NetworkUtils.isTailscaleIp(a.host) ? 0 : 1;
      final bt = NetworkUtils.isTailscaleIp(b.host) ? 0 : 1;
      return at.compareTo(bt);
    });
    return merged;
  }

  Future<List<DiscoveredServer>> discoverMdns({
    Duration timeout = AppConfig.mdnsLookupTimeout,
  }) async {
    final hosts = <DiscoveredServer>[];
    final client = MDnsClient();
    try {
      await client.start();
      final ptrName = '${AppConfig.mdnsService}.local';
      await for (final ptr in client
          .lookup<PtrResourceRecord>(
            ResourceRecordQuery.serverPointer(ptrName),
            timeout: timeout,
          )
          .timeout(timeout + const Duration(milliseconds: 500),
              onTimeout: (sink) => sink.close())) {
        await for (final srv in client.lookup<SrvResourceRecord>(
          ResourceRecordQuery.service(ptr.domainName),
          timeout: timeout,
        )) {
          await for (final ip in client.lookup<IPAddressResourceRecord>(
            ResourceRecordQuery.addressIPv4(srv.target),
            timeout: timeout,
          )) {
            hosts.add(DiscoveredServer(
              name: ptr.domainName,
              host: ip.address.address,
              port: srv.port,
            ));
          }
        }
      }
    } catch (_) {
      // mDNS is best-effort; sweep and manual entry cover the rest.
      // NOTE: mDNS does not cross a Tailscale tailnet — manual 100.x /
      // MagicDNS entry is the tailnet path.
    } finally {
      client.stop();
    }
    return hosts;
  }

  Future<List<DiscoveredServer>> sweepSubnet({
    int port = AppConfig.defaultPort,
    Duration totalTimeout = AppConfig.discoveryTimeout,
  }) async {
    final deviceIp = await _networkInfo.getWifiIP();
    if (deviceIp == null || deviceIp.isEmpty) return const [];

    final candidates = NetworkUtils.subnetHosts(deviceIp);
    final found = <DiscoveredServer>[];
    final deadline = DateTime.now().add(totalTimeout);

    for (var i = 0; i < candidates.length; i += AppConfig.sweepBatchSize) {
      if (DateTime.now().isAfter(deadline)) break;
      final batch = candidates.sublist(
        i,
        (i + AppConfig.sweepBatchSize).clamp(0, candidates.length),
      );
      final results = await Future.wait(
        batch.map((host) => _probe(host, port)),
      );
      found.addAll(results.whereType<DiscoveredServer>());
      // Early exit: one solid hit on church Wi-Fi is enough; the rest of
      // the /24 can keep scanning in the background next time.
      if (found.isNotEmpty && DateTime.now().isAfter(deadline)) break;
    }
    return found;
  }

  /// Verifies a specific host runs Selah. Used by manual/QR entry.
  /// Accepts IPs, Tailscale 100.x, and MagicDNS names (foo.tail*.ts.net).
  Future<DiscoveredServer?> verifyHost(String host, int port) => _probe(host, port);

  Future<DiscoveredServer?> _probe(String host, int port) async {
    final clean = NetworkUtils.parseHost(host);
    final target = clean.isEmpty ? host.trim() : clean;
    if (target.isEmpty) return null;
    try {
      final response = await _dio
          .get<dynamic>(
            'http://$target:$port${AppConfig.healthPath}',
          )
          .timeout(AppConfig.apiProbeTimeout);
      final data = response.data;
      if (data is! Map || data['status'] != 'healthy') return null;
      return DiscoveredServer(
        name: data['name']?.toString() ?? 'Selah',
        host: target,
        port: port,
      );
    } catch (_) {
      return null;
    }
  }
}

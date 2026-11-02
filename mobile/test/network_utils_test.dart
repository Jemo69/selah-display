import 'package:flutter_test/flutter_test.dart';
import 'package:lyricdisplay_mobile/core/network_utils.dart';

void main() {
  group('NetworkUtils.parseHost', () {
    test('parses bare IP', () {
      expect(NetworkUtils.parseHost('192.168.1.50'), '192.168.1.50');
    });

    test('parses URL with port', () {
      expect(NetworkUtils.parseHost('http://192.168.1.50:4000'), '192.168.1.50');
    });

    test('strips path', () {
      expect(NetworkUtils.parseHost('http://10.0.0.2:4000/api/health'), '10.0.0.2');
    });

    test('returns empty for empty input', () {
      expect(NetworkUtils.parseHost('   '), '');
    });
  });

  group('NetworkUtils.parseQrPayload', () {
    test('parses URL form with join code', () {
      final result =
          NetworkUtils.parseQrPayload('http://192.168.1.50:4000?joinCode=123456');
      expect(result, isNotNull);
      expect(result!.host, '192.168.1.50');
      expect(result.port, 4000);
      expect(result.joinCode, '123456');
    });

    test('parses JSON form', () {
      final result = NetworkUtils.parseQrPayload(
          '{"host":"192.168.1.50","port":4000,"joinCode":"654321"}');
      expect(result, isNotNull);
      expect(result!.host, '192.168.1.50');
      expect(result.joinCode, '654321');
    });

    test('returns null for garbage', () {
      expect(NetworkUtils.parseQrPayload('not a qr code'), isNull);
    });
  });

  group('NetworkUtils.subnetHosts', () {
    test('builds /24 host list', () {
      final hosts = NetworkUtils.subnetHosts('192.168.1.42');
      expect(hosts.length, 254);
      expect(hosts.first, '192.168.1.1');
      expect(hosts.last, '192.168.1.254');
    });

    test('returns empty for invalid IP', () {
      expect(NetworkUtils.subnetHosts('not-an-ip'), isEmpty);
    });
  });
  group('NetworkUtils Tailscale', () {
    test('detects 100.64/10 as Tailscale', () {
      expect(NetworkUtils.isTailscaleIp('100.90.1.2'), isTrue);
      expect(NetworkUtils.isTailscaleIp('100.127.255.255'), isTrue);
      expect(NetworkUtils.isTailscaleIp('192.168.1.50'), isFalse);
      expect(NetworkUtils.isTailscaleIp('100.63.1.1'), isFalse);
      expect(NetworkUtils.isTailscaleIp('100.128.0.1'), isFalse);
    });

    test('detects MagicDNS hostnames', () {
      expect(NetworkUtils.isTailnetHostname('mypc.tail123.ts.net'), isTrue);
      expect(NetworkUtils.isTailnetHostname('server.tail-scale.ts.net'), isTrue);
      expect(NetworkUtils.isTailnetHostname('192.168.1.50'), isFalse);
    });

    test('parseHost keeps Tailscale hostnames', () {
      expect(NetworkUtils.parseHost('mypc.tail123.ts.net:4000'),
          'mypc.tail123.ts.net');
      expect(
          NetworkUtils.parseHost('http://100.90.1.2:4000/api/health'),
          '100.90.1.2');
    });

    test('parseQrPayload accepts 100.x and MagicDNS', () {
      final tailscale = NetworkUtils.parseQrPayload(
          'http://100.90.1.2:4000?joinCode=123456');
      expect(tailscale?.host, '100.90.1.2');
      expect(tailscale?.joinCode, '123456');
      final magic = NetworkUtils.parseQrPayload(
          'http://mypc.tail123.ts.net:4000?joinCode=654321');
      expect(magic?.host, 'mypc.tail123.ts.net');
      expect(magic?.joinCode, '654321');
    });

    test('subnetHosts still returns a /24 for tailnet IPs', () {
      final hosts = NetworkUtils.subnetHosts('100.90.1.2');
      expect(hosts.length, 254);
      expect(hosts.first, '100.90.1.1');
    });
  });}

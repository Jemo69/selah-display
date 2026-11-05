/// Discovery screen: hybrid mDNS + subnet sweep, QR join, and manual IP
/// fallback, plus resume of an already-saved pairing.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../../app/theme.dart';
import '../../core/models.dart';
import '../../state/providers.dart';
import 'discovery_controller.dart';

class DiscoveryScreen extends ConsumerStatefulWidget {
  const DiscoveryScreen({super.key});

  @override
  ConsumerState<DiscoveryScreen> createState() => _DiscoveryScreenState();
}

class _DiscoveryScreenState extends ConsumerState<DiscoveryScreen> {
  final _manualController = TextEditingController();
  bool _resuming = false;
  bool _verifyingManual = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      ref.read(discoveryProvider.notifier).scan();
    });
  }

  @override
  void dispose() {
    _manualController.dispose();
    super.dispose();
  }

  Future<void> _resumeSaved(SavedConnection saved) async {
    setState(() => _resuming = true);
    // Resume goes straight to the control screen; SessionNotifier.build
    // auto-connects from the saved pairing. If the token is dead, the shell
    // shows the re-pair banner instead of a silent failure.
    await ref.read(sessionProvider.notifier).reconnect();
    if (!mounted) return;
    setState(() => _resuming = false);
    if (mounted) context.go('/control');
  }

  Future<void> _submitManual() async {
    final raw = _manualController.text.trim();
    if (raw.isEmpty || _verifyingManual) return;
    setState(() => _verifyingManual = true);
    final ok =
        await ref.read(discoveryProvider.notifier).addManualServer(raw);
    if (!mounted) return;
    setState(() => _verifyingManual = false);
    if (ok) {
      final discovery = ref.read(discoveryProvider);
      final server = discovery.servers.last;
      final joinCode = discovery.joinCode;
      final qs = joinCode == null ? '' : '?joinCode=$joinCode';
      context.go('/pair$qs', extra: server);
      _manualController.clear();
    }
  }

  void _openQrSheet() {
    showModalBottomSheet<void>(
      context: context,
      builder: (sheetContext) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Icon(Icons.qr_code_scanner,
                  size: 48, color: AppTheme.accent),
              const SizedBox(height: 16),
              Text(
                'Scan the QR code shown on the desktop app to connect instantly.',
                textAlign: TextAlign.center,
                style: Theme.of(sheetContext).textTheme.bodyLarge,
              ),
              const SizedBox(height: 20),
              FilledButton.icon(
                icon: const Icon(Icons.photo_camera),
                label: const Text('Open camera'),
                onPressed: () async {
                  Navigator.of(sheetContext).pop();
                  final raw = await Navigator.of(context).push<String>(
                    MaterialPageRoute(builder: (_) => const _QrScanScreen()),
                  );
                  if (!mounted) return;
                  if (raw == null) return;
                  if (raw.isEmpty) {
                    ScaffoldMessenger.of(context).showSnackBar(
                      const SnackBar(content: Text('Empty QR code')),
                    );
                    return;
                  }
                  final ok = await ref
                      .read(discoveryProvider.notifier)
                      .addQrPayload(raw);
                  if (!mounted) return;
                  if (ok) {
                    // Same landing as manual entry: straight to pairing with
                    // the captured join code prefilled.
                    final discovery = ref.read(discoveryProvider);
                    final server = discovery.servers.last;
                    final joinCode = discovery.joinCode;
                    final qs =
                        joinCode == null || joinCode.isEmpty ? '' : '?joinCode=$joinCode';
                    context.go('/pair$qs', extra: server);
                  } else {
                    ScaffoldMessenger.of(context).showSnackBar(
                      SnackBar(
                        content: Text(
                          ref.read(discoveryProvider).error ??
                              'Invalid QR code',
                        ),
                      ),
                    );
                  }
                },
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final discovery = ref.watch(discoveryProvider);
    final session = ref.watch(sessionProvider);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Find Selah'),
        actions: [
          IconButton(
            icon: const Icon(Icons.qr_code_scanner),
            tooltip: 'Scan QR code',
            onPressed: _openQrSheet,
          ),
          IconButton(
            icon: const Icon(Icons.refresh),
            onPressed: () => ref.read(discoveryProvider.notifier).scan(),
          ),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            if (discovery.joinCode != null)
              const Padding(
                padding: EdgeInsets.fromLTRB(16, 8, 16, 0),
                child: Card(
                  color: AppTheme.surfaceAlt,
                  child: ListTile(
                    dense: true,
                    leading: Icon(Icons.key, color: AppTheme.accent),
                    title: Text('Join code captured from QR'),
                  ),
                ),
              ),
            if (session.valueOrNull?.connection case final saved?)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                child: Card(
                  color: AppTheme.surfaceAlt,
                  child: ListTile(
                    leading: Icon(
                      Icons.history,
                      color: _resuming ? null : AppTheme.accent,
                    ),
                    title: Text(saved.serverName),
                    subtitle:
                        Text('${saved.host}:${saved.port} — resume last connection'),
                    trailing: _resuming
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Icon(Icons.chevron_right),
                    onTap: () => _resumeSaved(saved),
                  ),
                ),
              ),
            const Padding(
              padding: EdgeInsets.fromLTRB(16, 8, 16, 0),
              child: Card(
                color: AppTheme.surfaceAlt,
                child: ListTile(
                  dense: true,
                  leading: Icon(Icons.vpn_key, color: AppTheme.accent),
                  title: Text('Off-site? Use Tailscale'),
                  subtitle: Text('Type the desktop\u2019s 100.x IP or name.ts.net below — no port change needed.'),
                ),
              ),
            ),
            Expanded(
              child: discovery.scanning && discovery.servers.isEmpty
                  ? const Center(child: CircularProgressIndicator())
                  : discovery.servers.isEmpty
                      ? _EmptyDiscovery(error: discovery.error)
                      : ListView.separated(
                          padding: const EdgeInsets.all(16),
                          itemCount: discovery.servers.length,
                          separatorBuilder: (_, _) => const SizedBox(height: 8),
                          itemBuilder: (context, index) {
                            final server = discovery.servers[index];
                            return Card(
                              color: AppTheme.surface,
                              child: ListTile(
                                leading: const Icon(Icons.dns, size: 32),
                                title: Text(server.name),
                                subtitle: Text('${server.host}:${server.port}'),
                                trailing: const Icon(Icons.chevron_right),
                                onTap: () => context.push(
                                  discovery.joinCode == null
                                      ? '/pair'
                                      : '/pair?joinCode=${discovery.joinCode}',
                                  extra: server,
                                ),
                              ),
                            );
                          },
                        ),
            ),
            Padding(
              padding: const EdgeInsets.all(16),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: _manualController,
                      keyboardType: TextInputType.url,
                      onSubmitted: (_) => _submitManual(),
                      decoration: const InputDecoration(
                        hintText: 'IP, Tailscale 100.x, or name.ts.net',
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  FilledButton(
                    onPressed: _verifyingManual ? null : _submitManual,
                    child: _verifyingManual
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2),
                          )
                        : const Text('Connect'),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Minimal full-screen QR capture. Returns the raw payload string via pop;
/// empty string means a barcode was seen but had no readable value.
class _QrScanScreen extends ConsumerStatefulWidget {
  const _QrScanScreen();

  @override
  ConsumerState<_QrScanScreen> createState() => _QrScanScreenState();
}

class _QrScanScreenState extends ConsumerState<_QrScanScreen> {
  late final MobileScannerController _controller;
  bool _handled = false;

  @override
  void initState() {
    super.initState();
    _controller = MobileScannerController();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _onDetect(BarcodeCapture capture) {
    if (_handled) return;
    _handled = true;
    final raw = capture.barcodes.firstOrNull?.rawValue ?? '';
    _controller.dispose();
    Navigator.of(context).pop(raw.isEmpty ? '' : raw);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Scan QR code')),
      body: MobileScanner(
        controller: _controller,
        onDetect: _onDetect,
      ),
    );
  }
}

class _EmptyDiscovery extends StatelessWidget {
  const _EmptyDiscovery({this.error});
  final String? error;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              Icons.wifi_find,
              size: 72,
              color: error == null ? AppTheme.textSecondary : AppTheme.danger,
            ),
            const SizedBox(height: 16),
            Text(
              error ??
                  'No Selah found yet.\nMake sure this phone is on the same Wi-Fi as the desktop.',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodyLarge,
            ),
          ],
        ),
      ),
    );
  }
}

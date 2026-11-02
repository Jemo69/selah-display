/// App shell: bottom navigation on phones, navigation rail + two-pane
/// control layout on tablets (≥600dp).
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../core/models.dart';
import '../../core/socket_service.dart' show ConnectionPhase, ConnectionStatus;
import '../../state/providers.dart';

class _Dest {
  const _Dest(this.route, this.icon, this.label);
  final String route;
  final IconData icon;
  final String label;
}

const _destinations = [
  _Dest('/control', Icons.slideshow, 'Control'),
  _Dest('/setlist', Icons.list, 'Setlist'),
  _Dest('/bible', Icons.menu_book, 'Bible'),
  _Dest('/schedule', Icons.schedule, 'Schedule'),
  _Dest('/settings', Icons.settings, 'Settings'),
];

class AppShell extends ConsumerWidget {
  const AppShell({required this.child, super.key});
  final Widget child;

  int _indexOf(String path) {
    for (var i = 0; i < _destinations.length; i++) {
      if (_destinations[i].route == path) return i;
    }
    return 0;
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final status = ref.watch(connectionStatusProvider);
    final show = ref.watch(showStateProvider);
    final wide = MediaQuery.sizeOf(context).width >= 600;
    final index = _indexOf(GoRouterState.of(context).uri.path);

    return Scaffold(
      body: Column(
        children: [
          if (!status.isConnected) ...[
            if (status.isTerminalFailure)
              const PairingExpiredBanner()
            else
              ConnectingBanner(status: status),
          ],
          if (show.scheduleLoaded && show.scheduleStatus == 'running')
            _ScheduleStrip(name: show.scheduleName),
          Expanded(
            child: wide
                ? Row(
                    children: [
                      NavigationRail(
                        selectedIndex: index,
                        onDestinationSelected: (i) =>
                            context.go(_destinations[i].route),
                        labelType: NavigationRailLabelType.all,
                        destinations: [
                          for (final d in _destinations)
                            NavigationRailDestination(
                              icon: Icon(d.icon),
                              label: Text(d.label),
                            ),
                        ],
                      ),
                      const VerticalDivider(width: 1),
                      Expanded(child: child),
                    ],
                  )
                : child,
          ),
        ],
      ),
      bottomNavigationBar: wide
          ? null
          : NavigationBar(
              selectedIndex: index,
              destinations: [
                for (final d in _destinations)
                  NavigationDestination(icon: Icon(d.icon), label: d.label),
              ],
              onDestinationSelected: (i) => context.go(_destinations[i].route),
            ),
    );
  }
}

class _ScheduleStrip extends StatelessWidget {
  const _ScheduleStrip({required this.name});
  final String name;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: AppTheme.accentDim.withValues(alpha: 0.25),
      child: SafeArea(
        top: false,
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 16),
          child: Row(
            children: [
              const Icon(Icons.schedule, size: 14),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  name.isEmpty ? 'Schedule running' : 'Running: $name',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 12),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Shown while the socket is dialing or auto-reconnecting. Distinguishes
/// "first connect" from "lost connection" so users see progress, not failure.
class ConnectingBanner extends StatelessWidget {
  const ConnectingBanner({super.key, required this.status});
  final ConnectionStatus status;

  @override
  Widget build(BuildContext context) {
    final reconnecting = status.phase == ConnectionPhase.reconnecting;
    return Material(
      color: AppTheme.surfaceAlt,
      child: SafeArea(
        top: false,
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 16),
          child: Row(
            children: [
              const SizedBox(
                width: 16,
                height: 16,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Text(
                  reconnecting
                      ? 'Connection lost — reconnecting…'
                      : 'Connecting to Selah…',
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Terminal state: the server rejected our token, so retrying is pointless.
/// Sends the user back to pairing with one tap.
class PairingExpiredBanner extends ConsumerWidget {
  const PairingExpiredBanner({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Material(
      color: AppTheme.danger,
      child: SafeArea(
        top: false,
        bottom: false,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 8, horizontal: 16),
          child: Row(
            children: [
              const Icon(Icons.key_off, size: 18),
              const SizedBox(width: 8),
              const Expanded(
                child: Text('Pairing expired — connect again'),
              ),
              TextButton(
                onPressed: () {
                  final session = ref.read(sessionProvider).valueOrNull;
                  final connection = session?.connection;
                  if (connection != null) {
                    context.go(
                      '/pair',
                      extra: DiscoveredServer(
                        name: connection.serverName,
                        host: connection.host,
                        port: connection.port,
                      ),
                    );
                  } else {
                    context.go('/connect');
                  }
                },
                child: const Text('Reconnect'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

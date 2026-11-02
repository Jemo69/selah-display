/// Settings screen: connection info, re-pair, forget pairing.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../app/theme.dart';
import '../../state/providers.dart';

class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final connection =
        ref.watch(sessionProvider).valueOrNull?.connection;

    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Card(
              color: AppTheme.surface,
              child: ListTile(
                leading: const Icon(Icons.dns, size: 32),
                title: Text(connection?.serverName ?? 'Not connected'),
                subtitle: connection == null
                    ? null
                    : Text('${connection.host}:${connection.port}'),
              ),
            ),
            const SizedBox(height: 12),
            FilledButton.tonalIcon(
              onPressed: () => context.go('/connect'),
              icon: const Icon(Icons.swap_horiz),
              label: const Text('Switch server'),
            ),
            Card(
              color: AppTheme.surface,
              child: const ListTile(
                leading: Icon(Icons.bolt, size: 32),
                title: Text('Fast sync + Tailscale ready'),
                subtitle: Text('Light snapshots, delta sync, sentence-first search, scheduler'),
              ),
            ),
            const SizedBox(height: 12),
            OutlinedButton.icon(
              style: OutlinedButton.styleFrom(
                foregroundColor: AppTheme.danger,
                side: BorderSide(color: AppTheme.danger.withValues(alpha: 0.5)),
              ),
              onPressed: () async {
                await ref.read(sessionProvider.notifier).forget();
                if (context.mounted) context.go('/connect');
              },
              icon: const Icon(Icons.link_off),
              label: const Text('Forget pairing'),
            ),
            const SizedBox(height: 32),
            Center(
              child: Column(
                children: [
                  const Text(
                    'Selah Controller',
                    style: TextStyle(color: AppTheme.textSecondary),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    'v1.1.0',
                    style:
                        TextStyle(fontSize: 12, color: AppTheme.textSecondary),
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

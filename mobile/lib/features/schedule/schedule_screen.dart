/// Service run-sheet clock (scheduler): view the loaded plan, start /
/// pause / resume / stop, step next / prev, and see the live countdown.
///
/// Mirrors the desktop scheduler — same authoritative server state over
/// REST (works even when the socket is reconnecting on Tailscale).
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/models.dart';
import '../../state/providers.dart';

class ScheduleScreen extends ConsumerStatefulWidget {
  const ScheduleScreen({super.key});

  @override
  ConsumerState<ScheduleScreen> createState() => _ScheduleScreenState();
}

class _ScheduleScreenState extends ConsumerState<ScheduleScreen> {
  Timer? _countdown;
  bool _busy = false;
  String? _loadError;

  @override
  void initState() {
    super.initState();
    Future.microtask(() async {
      // Best-effort warm load; failures surface inline (never silent).
      final err = await ref.read(scheduleProvider.notifier).refresh();
      if (!mounted) return;
      setState(() => _loadError = err);
    });
    _countdown = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _countdown?.cancel();
    super.dispose();
  }

  Future<void> _control(String action, {Map<String, dynamic>? extra}) async {
    setState(() => _busy = true);
    final err = await ref.read(scheduleProvider.notifier).control(action, extra: extra);
    if (!mounted) return;
    setState(() => _busy = false);
    if (err != null) {
      ScaffoldMessenger.of(context).clearSnackBars();
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(err), behavior: SnackBarBehavior.floating),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    final snap = ref.watch(scheduleProvider);
    final show = ref.watch(showStateProvider);
    final loaded = snap.loaded || show.scheduleLoaded;
    final status = snap.loaded ? snap.status : show.scheduleStatus;
    final name = snap.name.isNotEmpty ? snap.name : show.scheduleName;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Schedule'),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            tooltip: 'Refresh',
            onPressed: _busy
                ? null
                : () => ref.read(scheduleProvider.notifier).refresh(),
          ),
        ],
      ),
      body: SafeArea(
        child: !loaded
            ? Center(
                child: Padding(
                  padding: const EdgeInsets.all(32),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(Icons.schedule,
                          size: 64, color: AppTheme.textSecondary),
                      const SizedBox(height: 12),
                      Text(
                        _loadError != null
                            ? 'Could not load the schedule.\n$_loadError'
                            : 'No schedule loaded.\nLoad one on the desktop to drive it from here.',
                        textAlign: TextAlign.center,
                        style: TextStyle(color: AppTheme.textSecondary),
                      ),
                    ],
                  ),
                ),
              )
            : ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  _StatusCard(
                    name: name.isEmpty ? 'Service run-sheet' : name,
                    status: status,
                    snapshot: snap,
                  ),
                  const SizedBox(height: 12),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      _CtlButton(
                        icon: Icons.play_arrow,
                        label: 'Start',
                        enabled: !_busy && (status == 'idle' || status == 'finished'),
                        onPressed: () => _control('start'),
                      ),
                      _CtlButton(
                        icon: Icons.pause,
                        label: 'Pause',
                        enabled: !_busy && status == 'running',
                        onPressed: () => _control('pause'),
                      ),
                      _CtlButton(
                        icon: Icons.play_circle,
                        label: 'Resume',
                        enabled: !_busy && status == 'paused',
                        onPressed: () => _control('resume'),
                      ),
                      _CtlButton(
                        icon: Icons.stop,
                        label: 'Stop',
                        enabled: !_busy && (status == 'running' || status == 'paused'),
                        onPressed: () => _control('stop'),
                      ),
                      _CtlButton(
                        icon: Icons.skip_previous,
                        label: 'Prev',
                        enabled: !_busy && snap.itemCount > 0,
                        onPressed: () => _control('prev'),
                      ),
                      _CtlButton(
                        icon: Icons.skip_next,
                        label: 'Next',
                        enabled: !_busy && snap.itemCount > 0,
                        onPressed: () => _control('next'),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  if (snap.itemCount > 0) ...[
                    Text('ITEM ${snap.itemIndex + 1} OF ${snap.itemCount}',
                        style: const TextStyle(
                            fontSize: 11,
                            letterSpacing: 1.4,
                            fontWeight: FontWeight.w700,
                            color: AppTheme.textSecondary)),
                    const SizedBox(height: 6),
                    if (snap.currentItemName.isNotEmpty)
                      Card(
                        color: AppTheme.surface,
                        child: ListTile(
                          leading: const Icon(Icons.radio_button_checked,
                              color: AppTheme.accent),
                          title: Text(snap.currentItemName,
                              style:
                                  const TextStyle(fontWeight: FontWeight.w600)),
                        ),
                      ),
                  ],
                ],
              ),
      ),
    );
  }
}

class _StatusCard extends StatelessWidget {
  const _StatusCard(
      {required this.name, required this.status, required this.snapshot});
  final String name;
  final String status;
  final ScheduleSnapshot snapshot;

  @override
  Widget build(BuildContext context) {
    final isRunning = status == 'running';
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: AppTheme.surface,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(name,
              style:
                  const TextStyle(fontSize: 20, fontWeight: FontWeight.w700)),
          const SizedBox(height: 8),
          Row(
            children: [
              Container(
                padding:
                    const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
                decoration: BoxDecoration(
                  color: isRunning
                      ? AppTheme.accentDim.withValues(alpha: 0.45)
                      : AppTheme.surfaceAlt,
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Text(status.toUpperCase(),
                    style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w700,
                        color: isRunning
                            ? AppTheme.accent
                            : AppTheme.textSecondary)),
              ),
              const SizedBox(width: 12),
              if (snapshot.remainingMs != null)
                Text(_formatRemaining(snapshot.remainingMs!),
                    style: const TextStyle(
                        fontSize: 28, fontWeight: FontWeight.w700)),
            ],
          ),
        ],
      ),
    );
  }

  static String _formatRemaining(int ms) {
    final s = (ms / 1000).ceil();
    final m = s ~/ 60;
    final r = s % 60;
    return '${m.toString().padLeft(2, '0')}:${r.toString().padLeft(2, '0')}';
  }
}

class _CtlButton extends StatelessWidget {
  const _CtlButton(
      {required this.icon,
      required this.label,
      required this.enabled,
      required this.onPressed});
  final IconData icon;
  final String label;
  final bool enabled;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return FilledButton.icon(
      onPressed: enabled ? onPressed : null,
      icon: Icon(icon, size: 20),
      label: Text(label),
    );
  }
}

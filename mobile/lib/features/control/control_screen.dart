/// Control screen: live lyric preview, oversized prev/next pad, output
/// toggles and blackout. On tablets it renders as a two-pane layout with
/// the setlist sidebar on the left.
///
/// Every command surfaces failures as a snackbar (no more silent dead
/// buttons) and disables while in flight so double-taps can't race.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/models.dart';
import '../../core/server_api.dart';
import '../../state/providers.dart';
import '../setlist/setlist_screen.dart';
import 'show_control_dock.dart';

class ControlScreen extends ConsumerStatefulWidget {
  const ControlScreen({super.key});

  @override
  ConsumerState<ControlScreen> createState() => _ControlScreenState();
}

class _ControlScreenState extends ConsumerState<ControlScreen> {
  bool _navBusy = false;

  void _fail(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).clearSnackBars();
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), behavior: SnackBarBehavior.floating),
    );
  }

  Future<void> _sendNext() async {
    final api = ref.read(serverApiProvider);
    if (api == null || _navBusy) return;
    setState(() => _navBusy = true);
    try {
      await api.lyricsNext();
    } on ApiException catch (e) {
      _fail(e.authFailure ? 'Pairing expired — reconnect' : 'Next failed: ${e.message}');
    } catch (_) {
      _fail('Next failed — check connection');
    } finally {
      if (mounted) setState(() => _navBusy = false);
    }
  }

  Future<void> _sendPrev() async {
    final api = ref.read(serverApiProvider);
    if (api == null || _navBusy) return;
    setState(() => _navBusy = true);
    try {
      await api.lyricsPrev();
    } on ApiException catch (e) {
      _fail(e.authFailure ? 'Pairing expired — reconnect' : 'Previous failed: ${e.message}');
    } catch (_) {
      _fail('Previous failed — check connection');
    } finally {
      if (mounted) setState(() => _navBusy = false);
    }
  }

  void _showJumpSheet() {
    final state = ref.read(showStateProvider);
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: AppTheme.surface,
      builder: (context) => _LineJumpSheet(
        lyrics: state.lyrics,
        selectedLine: state.selectedLine,
        onPick: (index) async {
          Navigator.of(context).pop();
          try {
            await ref.read(serverApiProvider)?.lyricsGoto(index);
          } on ApiException catch (e) {
            _fail('Jump failed: ${e.message}');
          } catch (_) {
            _fail('Jump failed — check connection');
          }
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final show = ref.watch(showStateProvider);
    final status = ref.watch(connectionStatusProvider);
    final wide = MediaQuery.sizeOf(context).width >= 600;
    final hasLyrics = show.hasLyrics;

    // Surface async socket errors (permission / validation) once.
    ref.listen<String?>(lastServerErrorProvider, (_, next) {
      if (next != null && next.isNotEmpty) {
        _fail(next);
        Future.microtask(
            () => ref.read(lastServerErrorProvider.notifier).state = null);
      }
    });

    final controlPad = _ControlPad(
      show: show,
      navBusy: _navBusy,
      offline: !status.isConnected,
      onPrev: hasLyrics && !_navBusy ? _sendPrev : null,
      onNext: hasLyrics && !_navBusy ? _sendNext : null,
      onJump: hasLyrics && !_navBusy ? _showJumpSheet : null,
    );

    return Scaffold(
      appBar: AppBar(
        title: Text(
          show.fileName.isEmpty ? 'No song loaded' : show.fileName,
          overflow: TextOverflow.ellipsis,
        ),
        actions: [
          if (!status.isConnected)
            const Padding(
              padding: EdgeInsets.only(right: 12),
              child: SizedBox(
                width: 20,
                height: 20,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
            ),
        ],
      ),
      body: SafeArea(
        child: wide
            ? Row(
                children: [
                  SizedBox(width: 300, child: const SetlistSidebar()),
                  const VerticalDivider(width: 1),
                  Expanded(child: controlPad),
                ],
              )
            : controlPad,
      ),
    );
  }
}

class _ControlPad extends StatelessWidget {
  const _ControlPad({
    required this.show,
    this.onPrev,
    this.onNext,
    this.onJump,
    this.navBusy = false,
    this.offline = false,
  });

  final ShowState show;
  final VoidCallback? onPrev;
  final VoidCallback? onNext;
  final VoidCallback? onJump;
  final bool navBusy;
  final bool offline;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        children: [
          if (offline)
            Container(
              width: double.infinity,
              margin: const EdgeInsets.only(bottom: 8),
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              decoration: BoxDecoration(
                color: AppTheme.surfaceAlt,
                borderRadius: BorderRadius.circular(10),
              ),
              child: const Text(
                'Reconnecting — commands queue and send on reconnect',
                style: TextStyle(fontSize: 12, color: AppTheme.textSecondary),
              ),
            ),
          Expanded(
            flex: 3,
            child: _LivePreview(show: show),
          ),
          Expanded(
            flex: 2,
            child: Row(
              children: [
                Expanded(
                  child: _NavButton(
                    icon: Icons.skip_previous,
                    label: navBusy ? '…' : 'PREV',
                    onPressed: onPrev,
                  ),
                ),
                Expanded(
                  child: _NavButton(
                    icon: Icons.format_list_numbered,
                    label: 'JUMP',
                    onPressed: onJump,
                    secondary: true,
                  ),
                ),
                Expanded(
                  child: _NavButton(
                    icon: Icons.skip_next,
                    label: navBusy ? '…' : 'NEXT',
                    onPressed: onNext,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          _OutputRow(show: show),
          const SizedBox(height: 12),
          // Collapsible show controls + announcements (feature #18). Flexible
          // so a short screen scrolls it rather than overflowing.
          Flexible(
            child: SingleChildScrollView(
              child: const ShowControlDock(),
            ),
          ),
          const SizedBox(height: 12),
          // Kept as a separate full-width control: this is the button an
          // operator hits mid-song with gloves on, so it stays large and
          // reachable even when the dock is collapsed.
          _BlackoutButton(show: show),
        ],
      ),
    );
  }
}

class _LivePreview extends StatelessWidget {
  const _LivePreview({required this.show});
  final ShowState show;

  @override
  Widget build(BuildContext context) {
    final current = show.currentLine ?? (show.hasLyrics ? '' : null);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: AppTheme.surface,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'ON SCREEN',
            style: TextStyle(
              fontSize: 12,
              letterSpacing: 2,
              color: AppTheme.textSecondary,
              fontWeight: FontWeight.w700,
            ),
          ),
          const Spacer(),
          Text(
            current ?? '—',
            style: TextStyle(
              fontSize: 30,
              height: 1.25,
              fontWeight: FontWeight.w600,
              color: current == null
                  ? AppTheme.textSecondary
                  : AppTheme.textPrimary,
            ),
          ),
          const Spacer(),
          Text(
            'NEXT',
            style: TextStyle(
              fontSize: 12,
              letterSpacing: 2,
              color: AppTheme.accentDim,
              fontWeight: FontWeight.w700,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            show.upcomingLine ?? '',
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(
              fontSize: 18,
              color: AppTheme.textSecondary,
            ),
          ),
        ],
      ),
    );
  }
}

class _NavButton extends StatelessWidget {
  const _NavButton({
    required this.icon,
    required this.label,
    required this.onPressed,
    this.secondary = false,
  });

  final IconData icon;
  final String label;
  final VoidCallback? onPressed;
  final bool secondary;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(4),
      child: FilledButton.icon(
        style: FilledButton.styleFrom(
          backgroundColor:
              secondary ? AppTheme.surfaceAlt : AppTheme.accent,
          foregroundColor:
              secondary ? AppTheme.textPrimary : const Color(0xFF10140C),
          shape:
              RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
        ),
        onPressed: onPressed,
        icon: Icon(icon, size: 34),
        label: Text(label),
      ),
    );
  }
}

class _OutputRow extends ConsumerWidget {
  const _OutputRow({required this.show});
  final ShowState show;

  Future<void> _toggle(WidgetRef ref, BuildContext context, String output, bool enabled) async {
    ref.read(socketServiceProvider).emit(
        'individualOutputToggle', {'output': output, 'enabled': enabled});
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      decoration: BoxDecoration(
        color: AppTheme.surface,
        borderRadius: BorderRadius.circular(12),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceAround,
        children: [
          _OutputSwitch(
            label: 'Output 1',
            value: show.output1Enabled && show.isOutputOn,
            onChanged: show.isOutputOn
                ? (v) => _toggle(ref, context, 'output1', v)
                : null,
          ),
          _OutputSwitch(
            label: 'Output 2',
            value: show.output2Enabled && show.isOutputOn,
            onChanged: show.isOutputOn
                ? (v) => _toggle(ref, context, 'output2', v)
                : null,
          ),
          _OutputSwitch(
            label: 'Stage',
            value: show.stageEnabled && show.isOutputOn,
            onChanged: show.isOutputOn
                ? (v) => _toggle(ref, context, 'stage', v)
                : null,
          ),
        ],
      ),
    );
  }
}

class _OutputSwitch extends StatelessWidget {
  const _OutputSwitch({
    required this.label,
    required this.value,
    required this.onChanged,
  });
  final String label;
  final bool value;
  final ValueChanged<bool>? onChanged;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Switch(value: value, onChanged: onChanged),
        Text(label),
      ],
    );
  }
}

class _BlackoutButton extends ConsumerWidget {
  const _BlackoutButton({required this.show});
  final ShowState show;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final isOn = show.isOutputOn;
    return SizedBox(
      width: double.infinity,
      child: FilledButton.icon(
        style: FilledButton.styleFrom(
          backgroundColor: isOn ? AppTheme.danger : AppTheme.accent,
          foregroundColor:
              isOn ? Colors.white : const Color(0xFF10140C),
        ),
        onPressed: () {
          final socket = ref.read(socketServiceProvider);
          socket.emit('outputToggle', !isOn);
        },
        icon: Icon(isOn ? Icons.visibility_off : Icons.visibility, size: 28),
        label: Text(isOn ? 'BLACKOUT' : 'SHOW OUTPUT'),
      ),
    );
  }
}

class _LineJumpSheet extends StatelessWidget {
  const _LineJumpSheet({
    required this.lyrics,
    required this.selectedLine,
    required this.onPick,
  });

  final List<String> lyrics;
  final int? selectedLine;
  final ValueChanged<int> onPick;

  @override
  Widget build(BuildContext context) {
    final controller = ScrollController(
      initialScrollOffset: selectedLine == null || selectedLine == 0
          ? 0
          : (selectedLine! * 56.0 - 200).clamp(0.0, double.maxFinite),
    );

    return SizedBox(
      height: MediaQuery.sizeOf(context).height * 0.6,
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: Text(
              'Jump to line',
              style: Theme.of(context).textTheme.titleMedium,
            ),
          ),
          Expanded(
            child: ListView.builder(
              controller: controller,
              itemCount: lyrics.length,
              itemBuilder: (context, index) {
                final selected = index == selectedLine;
                return ListTile(
                  selected: selected,
                  leading: Text('$index',
                      style: const TextStyle(color: AppTheme.textSecondary)),
                  title: Text(lyrics[index], maxLines: 2),
                  onTap: () => onPick(index),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

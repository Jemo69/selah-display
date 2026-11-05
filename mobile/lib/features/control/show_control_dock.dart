/// Collapsible show-control dock for the mobile controller.
///
/// Wraps the same show-control machine the desktop uses (feature #18): the
/// four explicit states plus the announcement ticker. The whole block folds
/// away so the lyric preview keeps the screen, but the header keeps reporting
/// the live state and the queue depth so an operator never has to reopen it
/// just to look.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/models.dart';
import '../../core/server_api.dart';
import '../../state/providers.dart';

/// Open/closed state for the dock. Device-local: two operators should each
/// have their own view of the panel.
class ShowControlDockState {
  const ShowControlDockState({this.expanded = true, this.busy = false});

  final bool expanded;
  final bool busy;

  ShowControlDockState copyWith({bool? expanded, bool? busy}) =>
      ShowControlDockState(
        expanded: expanded ?? this.expanded,
        busy: busy ?? this.busy,
      );
}

class ShowControlDockNotifier extends Notifier<ShowControlDockState> {
  @override
  ShowControlDockState build() => const ShowControlDockState();

  void toggleExpanded() =>
      state = state.copyWith(expanded: !state.expanded);

  void setExpanded(bool expanded) => state = state.copyWith(expanded: expanded);

  void setBusy(bool busy) => state = state.copyWith(busy: busy);
}

final showControlDockProvider =
    NotifierProvider<ShowControlDockNotifier, ShowControlDockState>(
        ShowControlDockNotifier.new);

/// Show-control commands. Each returns the resulting state so the caller can
/// surface failures; the socket echo is what actually updates the UI.
class ShowControlCommands {
  const ShowControlCommands(this._ref);

  final Ref _ref;

  ServerApi? get _api => _ref.read(serverApiProvider);

  void _emit(String event, Object? payload) =>
      _ref.read(socketServiceProvider).emit(event, payload);

  Future<void> select(ShowControlState next) async {
    final api = _api;
    if (api == null) throw ApiException('Not paired to a server');
    // Echo locally too: the phone is usually the only surface in front of the
    // operator, so waiting for a round trip would make the button feel dead.
    _emit('showStateUpdate', {'state': next.wire});
    await api.setShowState(next.wire);
  }

  Future<void> showTicker(String? id) async {
    final api = _api;
    if (api == null) throw ApiException('Not paired to a server');
    await api.showTickerItem(id);
  }

  Future<void> removeTicker(String id) async {
    final api = _api;
    if (api == null) throw ApiException('Not paired to a server');
    await api.removeTickerItem(id);
  }

  Future<void> clearTicker() async {
    final api = _api;
    if (api == null) throw ApiException('Not paired to a server');
    await api.clearTicker();
  }
}

final showControlCommandsProvider = Provider<ShowControlCommands>(
  ShowControlCommands.new,
);

/// One announcement composer plus the queue. Shared by the dock so the
/// composer can also be shown collapsed-but-wanted elsewhere later.
class TickerComposer extends ConsumerStatefulWidget {
  const TickerComposer({super.key});

  @override
  ConsumerState<TickerComposer> createState() => _TickerComposerState();
}

class _TickerComposerState extends ConsumerState<TickerComposer> {
  final _controller = TextEditingController();
  final _targetController = TextEditingController(text: 'all');
  String? _error;

  static const _outputs = <String, String>{
    'all': 'All outputs',
    'output1': 'Output 1',
    'output2': 'Output 2',
    'stage': 'Stage',
  };

  @override
  void dispose() {
    _controller.dispose();
    _targetController.dispose();
    super.dispose();
  }

  Future<void> _run(Future<void> Function() action) async {
    setState(() => _error = null);
    try {
      await action();
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) setState(() => _error = 'Could not reach the server');
    }
  }

  void _add() {
    final text = _controller.text.trim();
    if (text.isEmpty) {
      setState(() => _error = 'Type an announcement first.');
      return;
    }
    if (text.length > 280) {
      setState(() => _error = 'Keep announcements under 280 characters.');
      return;
    }
    final target = _targetController.text;
    _controller.clear();
    _run(() => _addRemote(text, target));
  }

  Future<void> _addRemote(String text, String target) async {
    final api = ref.read(serverApiProvider);
    if (api == null) throw ApiException('Not paired to a server');
    await api.addTickerItem(
      text,
      targetOutput: target == 'all' ? null : target,
    );
  }

  @override
  Widget build(BuildContext context) {
    final show = ref.watch(showStateProvider);
    final commands = ref.read(showControlCommandsProvider);
    final queue = show.tickerQueue;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(
                'ANNOUNCEMENTS',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontSize: 11,
                  letterSpacing: 1.4,
                  fontWeight: FontWeight.w700,
                  color: Color(0xFFE8B45C),
                ),
              ),
            ),
            const SizedBox(width: 8),
            Text('Send to:', style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(width: 6),
            Flexible(
              child: SizedBox(
                height: 36,
                child: DropdownButton<String>(
                  value: _targetController.text,
                  isDense: true,
                  isExpanded: true,
                  underline: const SizedBox.shrink(),
                  borderRadius: BorderRadius.circular(10),
                  style: const TextStyle(fontSize: 13),
                  items: [
                    for (final entry in _outputs.entries)
                      DropdownMenuItem(
                        value: entry.key,
                        child: Text(
                          entry.value,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                  ],
                  onChanged: (value) {
                    if (value != null) _targetController.text = value;
                  },
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        Row(
          children: [
            Expanded(
              child: TextField(
                controller: _controller,
                maxLength: 280,
                textInputAction: TextInputAction.done,
                onSubmitted: (_) => _add(),
                style: const TextStyle(fontSize: 14),
                decoration: const InputDecoration(
                  isDense: true,
                  counterText: '',
                  hintText: 'e.g. Welcome — kids check-in at 10:30',
                ),
              ),
            ),
            const SizedBox(width: 8),
            SizedBox(
              height: 44,
              child: FilledButton.icon(
                onPressed: _add,
                style: FilledButton.styleFrom(
                  backgroundColor: const Color(0xFFE8B45C),
                  foregroundColor: const Color(0xFF10140C),
                  padding: const EdgeInsets.symmetric(horizontal: 14),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(10),
                  ),
                ),
                icon: const Icon(Icons.add, size: 18),
                label: const Text('Add', style: TextStyle(fontSize: 14)),
              ),
            ),
          ],
        ),
        if (_error != null) ...[
          const SizedBox(height: 6),
          Text(
            _error!,
            style: const TextStyle(color: AppTheme.danger, fontSize: 12),
          ),
        ],
        if (queue.isNotEmpty) ...[
          const SizedBox(height: 10),
          for (final item in queue)
            _TickerRow(
              item: item,
              isActive: show.tickerActiveId == item.id,
              onShow: () => _run(() => commands.showTicker(item.id)),
              onRemove: () => _run(() => commands.removeTicker(item.id)),
            ),
          const SizedBox(height: 6),
          OutlinedButton.icon(
            onPressed: () => _run(commands.clearTicker),
            icon: const Icon(Icons.delete_sweep_outlined, size: 16),
            label: const Text('Clear all announcements', style: TextStyle(fontSize: 12)),
          ),
        ],
      ],
    );
  }
}

class _TickerRow extends StatelessWidget {
  const _TickerRow({
    required this.item,
    required this.isActive,
    required this.onShow,
    required this.onRemove,
  });

  final TickerItem item;
  final bool isActive;
  final VoidCallback onShow;
  final VoidCallback onRemove;

  @override
  Widget build(BuildContext context) {
    final target = item.targetName ?? item.targetOutput ?? 'All outputs';

    return Container(
      margin: const EdgeInsets.only(bottom: 6),
      padding: const EdgeInsets.fromLTRB(10, 8, 4, 8),
      decoration: BoxDecoration(
        color: AppTheme.surfaceAlt,
        borderRadius: BorderRadius.circular(10),
        border: isActive ? Border.all(color: AppTheme.accent) : null,
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  item.text,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 13),
                ),
                Text(
                  '→ $target${isActive ? ' · on air' : ''}',
                  style: const TextStyle(
                    fontSize: 11,
                    color: AppTheme.textSecondary,
                  ),
                ),
              ],
            ),
          ),
          IconButton(
            onPressed: onShow,
            tooltip: isActive ? 'Hide from screen' : 'Show on screen',
            icon: Icon(
              isActive ? Icons.visibility_off : Icons.visibility,
              size: 18,
            ),
            color: AppTheme.accent,
          ),
          IconButton(
            onPressed: onRemove,
            tooltip: 'Remove announcement',
            icon: const Icon(Icons.close, size: 18),
            color: AppTheme.textSecondary,
          ),
        ],
      ),
    );
  }
}

class ShowControlDock extends ConsumerWidget {
  const ShowControlDock({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final dock = ref.watch(showControlDockProvider);
    final notifier = ref.read(showControlDockProvider.notifier);
    final show = ref.watch(showStateProvider);
    final commands = ref.read(showControlCommandsProvider);
    final active = show.showControl;
    final queued = show.tickerQueue.length;

    return Container(
      decoration: BoxDecoration(
        color: AppTheme.surface,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          _DockHeader(
            expanded: dock.expanded,
            state: active,
            queued: queued,
            onToggle: notifier.toggleExpanded,
          ),
          if (dock.expanded) ...[
            const Divider(height: 1, color: AppTheme.surfaceAlt),
            Padding(
              key: const Key('dock-body'),
              padding: const EdgeInsets.all(10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _StateGrid(
                    active: active,
                    disabled: dock.busy,
                    onSelect: (next) {
                      notifier.setBusy(true);
                      commands.select(next).then((_) {}).catchError((Object e) {
                        final msg = e is ApiException ? e.message : 'Could not reach the server';
                        if (!context.mounted) return;
                        ScaffoldMessenger.of(context).clearSnackBars();
                        ScaffoldMessenger.of(context).showSnackBar(
                          SnackBar(content: Text(msg), behavior: SnackBarBehavior.floating),
                        );
                      }).whenComplete(() => notifier.setBusy(false));
                    },
                  ),
                  const SizedBox(height: 12),
                  const TickerComposer(),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _DockHeader extends StatelessWidget {
  const _DockHeader({
    required this.expanded,
    required this.state,
    required this.queued,
    required this.onToggle,
  });

  final bool expanded;
  final ShowControlState state;
  final int queued;
  final VoidCallback onToggle;

  @override
  Widget build(BuildContext context) {
    final isLive = state == ShowControlState.live;
    return InkWell(
      onTap: onToggle,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
        child: Row(
          children: [
            AnimatedRotation(
              turns: expanded ? 0.5 : 0,
              duration: const Duration(milliseconds: 180),
              child: const Icon(Icons.expand_more, size: 20),
            ),
            const SizedBox(width: 8),
            const Expanded(
              child: Text(
                'Show Control',
                style: TextStyle(
                  fontSize: 11,
                  letterSpacing: 1.2,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
            if (queued > 0)
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
                decoration: BoxDecoration(
                  color: const Color(0x33E8B45C),
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Text(
                  '$queued queued',
                  style: const TextStyle(
                    fontSize: 10,
                    fontWeight: FontWeight.w700,
                    color: Color(0xFFE8B45C),
                  ),
                ),
              ),
            const SizedBox(width: 8),
            // State stays legible while collapsed.
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
              decoration: BoxDecoration(
                color: isLive
                    ? AppTheme.accentDim.withValues(alpha: 0.45)
                    : AppTheme.surfaceAlt,
                borderRadius: BorderRadius.circular(999),
              ),
              child: Text(
                state.label,
                style: TextStyle(
                  fontSize: 10,
                  fontWeight: FontWeight.w700,
                  color: isLive ? AppTheme.accent : AppTheme.textSecondary,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _StateGrid extends StatelessWidget {
  const _StateGrid({
    required this.active,
    required this.onSelect,
    this.disabled = false,
  });

  final ShowControlState active;
  final ValueChanged<ShowControlState> onSelect;
  final bool disabled;

  static const _defs = <(ShowControlState, IconData)>[
    (ShowControlState.live, Icons.ondemand_video),
    (ShowControlState.clear, Icons.cleaning_services_outlined),
    (ShowControlState.blackout, Icons.visibility_off_outlined),
    (ShowControlState.logo, Icons.image_outlined),
  ];

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        for (final row in [0, 1]) ...[
          if (row > 0) const SizedBox(height: 8),
          Row(
            children: [
              for (final (state, icon) in _defs.skip(row * 2).take(2)) ...[
                Expanded(
                  child: _StateButton(
                    state: state,
                    icon: icon,
                    selected: state == active,
                    disabled: disabled,
                    onPressed: () => onSelect(state),
                  ),
                ),
                if (state != _defs[(row + 1) * 2 - 1].$1)
                  const SizedBox(width: 8),
              ],
            ],
          ),
        ],
      ],
    );
  }
}

class _StateButton extends StatelessWidget {
  const _StateButton({
    required this.state,
    required this.icon,
    required this.selected,
    required this.onPressed,
    this.disabled = false,
  });

  final ShowControlState state;
  final IconData icon;
  final bool selected;
  final bool disabled;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return OutlinedButton.icon(
      onPressed: disabled ? null : onPressed,
      style: OutlinedButton.styleFrom(
        backgroundColor: selected
            ? AppTheme.accentDim.withValues(alpha: 0.45)
            : AppTheme.surfaceAlt,
        foregroundColor:
            disabled ? AppTheme.textSecondary.withValues(alpha: 0.5) : AppTheme.textPrimary,
        side: BorderSide(
          color: selected ? AppTheme.accent : Colors.transparent,
          width: selected ? 1.5 : 0,
        ),
        padding: const EdgeInsets.symmetric(vertical: 14),
        minimumSize: const Size(0, 48),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
      ),
      icon: Icon(icon, size: 18),
      label: Text(state.label, style: const TextStyle(fontSize: 14)),
    );
  }
}

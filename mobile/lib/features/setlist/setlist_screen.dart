/// Setlist: search (sentence-first), load-on-tap, swipe delete, drag
/// reorder, add-text-song. Failures surface as snackbars — nothing silent.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/models.dart';
import '../../core/server_api.dart';
import '../../state/providers.dart';

class SetlistScreen extends ConsumerStatefulWidget {
  const SetlistScreen({super.key});

  @override
  ConsumerState<SetlistScreen> createState() => _SetlistScreenState();
}

class _SetlistScreenState extends ConsumerState<SetlistScreen> {
  final _searchController = TextEditingController();
  SetlistSearchResult? _searchResult;
  bool _searching = false;
  bool _busy = false;

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  void _fail(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context).clearSnackBars();
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message), behavior: SnackBarBehavior.floating),
    );
  }

  Future<void> _run(Future<void> Function(ServerApi api) action) async {
    final api = ref.read(serverApiProvider);
    if (api == null) {
      _fail('Not paired to a server');
      return;
    }
    setState(() => _busy = true);
    try {
      await action(api);
    } on ApiException catch (e) {
      _fail(e.authFailure ? 'Pairing expired — reconnect' : e.message);
    } catch (_) {
      _fail('Could not reach the server');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _search() async {
    final q = _searchController.text.trim();
    if (q.isEmpty) {
      setState(() => _searchResult = null);
      return;
    }
    final api = ref.read(serverApiProvider);
    if (api == null) {
      _fail('Not paired');
      return;
    }
    setState(() => _searching = true);
    try {
      final res = await api.setlistSearch(q, experimental: true);
      if (mounted) setState(() => _searchResult = res);
    } on ApiException catch (e) {
      _fail('Search failed: ${e.message}');
    } catch (_) {
      _fail('Search failed — check connection');
    } finally {
      if (mounted) setState(() => _searching = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final show = ref.watch(showStateProvider);
    final api = ref.read(serverApiProvider);
    final searching = _searchResult != null;

    final items = searching
        ? _searchResult!.results.map((h) => h.item).toList()
        : show.setlist;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Setlist'),
        actions: [
          IconButton(
            icon: const Icon(Icons.add),
            tooltip: 'Add text song',
            onPressed: api == null || _busy
                ? null
                : () => _showAddDialog(context, ref),
          ),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 0),
              child: TextField(
                controller: _searchController,
                textInputAction: TextInputAction.search,
                onSubmitted: (_) => _search(),
                onChanged: (v) {
                  if (v.isEmpty) setState(() => _searchResult = null);
                },
                decoration: InputDecoration(
                  hintText: 'Search songs — whole sentences first',
                  prefixIcon: const Icon(Icons.search),
                  suffixIcon: _searching
                      ? IconButton(
                          icon: const Icon(Icons.clear),
                          onPressed: () {
                            _searchController.clear();
                            setState(() => _searchResult = null);
                          },
                        )
                      : IconButton(
                          icon: _searching
                              ? const SizedBox(
                                  width: 16,
                                  height: 16,
                                  child: CircularProgressIndicator(strokeWidth: 2))
                              : const Icon(Icons.arrow_forward),
                          onPressed: _search,
                        ),
                ),
              ),
            ),
            if (_searchResult != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 6, 16, 0),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        '${_searchResult!.results.length} of ${_searchResult!.totalSetlist} songs',
                        style: const TextStyle(
                            fontSize: 12, color: AppTheme.textSecondary),
                      ),
                    ),
                    if (_searchResult!.experimental)
                      const Text('sentence-first',
                          style: TextStyle(
                              fontSize: 11, color: AppTheme.accent)),
                  ],
                ),
              ),
            Expanded(
              child: _busy && items.isEmpty
                  ? const Center(child: CircularProgressIndicator())
                  : items.isEmpty
                      ? Center(
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(Icons.playlist_add,
                                  size: 64, color: AppTheme.textSecondary),
                              const SizedBox(height: 12),
                              Text(
                                searching
                                    ? 'No songs match.\nTry fewer words.'
                                    : 'Setlist is empty.\nAdd songs on the desktop or with +.',
                                textAlign: TextAlign.center,
                                style:
                                    TextStyle(color: AppTheme.textSecondary),
                              ),
                            ],
                          ),
                        )
                      : searching
                          ? ListView.builder(
                              padding: const EdgeInsets.all(12),
                              itemCount: items.length,
                              itemBuilder: (context, index) {
                                final item = items[index];
                                return Card(
                                  key: ValueKey(item.id),
                                  color: AppTheme.surface,
                                  child: ListTile(
                                    leading: Text('${index + 1}',
                                        style: const TextStyle(
                                            color: AppTheme.textSecondary)),
                                    title: Text(item.displayName),
                                    trailing: const Icon(
                                        Icons.chevron_right,
                                        color: AppTheme.textSecondary),
                                    onTap: () =>
                                        _run((a) => a.setlistLoad(item.id)),
                                  ),
                                );
                              },
                            )
                          : ReorderableListView.builder(
                              padding: const EdgeInsets.all(12),
                              itemCount: items.length,
                              onReorderItem: (oldIndex, newIndex) =>
                                  _reorder(ref, oldIndex, newIndex),
                              itemBuilder: (context, index) {
                                final item = items[index];
                                return Dismissible(
                                  key: ValueKey('del-${item.id}'),
                                  direction: DismissDirection.endToStart,
                                  background: Container(
                                    alignment: Alignment.centerRight,
                                    padding: const EdgeInsets.only(right: 20),
                                    decoration: BoxDecoration(
                                      color: AppTheme.danger,
                                      borderRadius: BorderRadius.circular(12),
                                    ),
                                    child: const Icon(Icons.delete,
                                        color: Colors.white),
                                  ),
                                  confirmDismiss: (_) async =>
                                      await _confirmDelete(item.displayName),
                                  onDismissed: (_) =>
                                      _run((a) => a.setlistRemove(item.id)),
                                  child: Card(
                                    key: ValueKey(item.id),
                                    color: AppTheme.surface,
                                    child: ListTile(
                                      leading: Text('${index + 1}',
                                          style: const TextStyle(
                                              color:
                                                  AppTheme.textSecondary)),
                                      title: Text(item.displayName),
                                      subtitle: item.fileType == 'lrc'
                                          ? const Text('LRC',
                                              style: TextStyle(fontSize: 11))
                                          : null,
                                      trailing: Icon(Icons.drag_handle,
                                          color: AppTheme.textSecondary),
                                      onTap: () => _run(
                                          (a) => a.setlistLoad(item.id)),
                                    ),
                                  ),
                                );
                              },
                            ),
            ),
          ],
        ),
      ),
    );
  }

  Future<bool> _confirmDelete(String name) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: AppTheme.surface,
        title: const Text('Remove song?'),
        content: Text('Remove "$name" from the setlist?'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Keep')),
          FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Remove')),
        ],
      ),
    );
    return ok == true;
  }

  void _reorder(WidgetRef ref, int oldIndex, int newIndex) async {
    final ids = ref.read(showStateProvider).setlist.map((e) => e.id).toList();
    final id = ids.removeAt(oldIndex);
    ids.insert(newIndex, id);
    await _run((a) => a.setlistReorder(ids));
  }

  Future<void> _showAddDialog(BuildContext context, WidgetRef ref) async {
    final nameController = TextEditingController();
    final contentController = TextEditingController();

    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        backgroundColor: AppTheme.surface,
        title: const Text('Add text song'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: nameController,
              decoration: const InputDecoration(hintText: 'Song title'),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: contentController,
              maxLines: 8,
              decoration: const InputDecoration(
                  hintText: 'Lyrics (blank line = slide break)'),
            ),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Add'),
          ),
        ],
      ),
    );

    if (ok != true || !context.mounted) return;
    final name = nameController.text.trim();
    final content = contentController.text;
    if (name.isEmpty || content.isEmpty) {
      _fail('Title and lyrics are required');
      return;
    }
    await _run((a) => a.setlistAddText(name, content));
  }
}

/// Compact list used as the tablet control-screen sidebar.
class SetlistSidebar extends ConsumerWidget {
  const SetlistSidebar({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final show = ref.watch(showStateProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Setlist')),
      body: ListView.builder(
        itemCount: show.setlist.length,
        itemBuilder: (context, index) {
          final item = show.setlist[index];
          return ListTile(
            dense: true,
            leading: Text('${index + 1}',
                style: const TextStyle(color: AppTheme.textSecondary)),
            title: Text(
              item.displayName,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            onTap: () => ref
                .read(serverApiProvider)
                ?.setlistLoad(item.id)
                .catchError((_) {}),
          );
        },
      ),
    );
  }
}

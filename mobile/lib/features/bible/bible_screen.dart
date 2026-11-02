/// Bible screen: reference quick-load ("John 3:16"), full-text search
/// with sentence-first ranking, search-all toggle, and translation list.
///
/// Sentence-first (Experimental on desktop) is ON by default here: a typed
/// sentence puts the verse containing the whole sentence first instead of
/// OR-matching single words.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../core/models.dart';
import '../../core/server_api.dart';
import '../../state/providers.dart';

class BibleScreen extends ConsumerStatefulWidget {
  const BibleScreen({super.key});

  @override
  ConsumerState<BibleScreen> createState() => _BibleScreenState();
}

class _BibleScreenState extends ConsumerState<BibleScreen> {
  final _referenceController = TextEditingController();
  final _searchController = TextEditingController();
  bool _busy = false;
  bool _searchAll = false;
  bool _sentenceFirst = true;
  String? _message;
  String? _activeBible;
  List<BibleResult> _results = [];
  List<BibleInfo> _bibles = [];

  @override
  void initState() {
    super.initState();
    Future.microtask(_loadBibles);
  }

  @override
  void dispose() {
    _referenceController.dispose();
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

  Future<void> _loadBibles() async {
    final api = ref.read(serverApiProvider);
    if (api == null) return;
    try {
      final res = await api.bibleList();
      if (mounted) {
        setState(() {
          _bibles = res.bibles;
          _activeBible = res.activeBible?.name ?? res.bibles.firstOrNull?.name;
        });
      }
    } catch (_) {
      // Bible list is nice-to-have; search/reference still work.
    }
  }

  Future<void> _loadReference() async {
    final reference = _referenceController.text.trim();
    if (reference.isEmpty || _busy) return;
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      await ref.read(serverApiProvider)?.bibleReference(reference);
      if (mounted) {
        setState(() => _message = 'Loaded $reference');
      }
    } on ApiException catch (e) {
      if (mounted) {
        setState(() => _message = e.message);
        _fail(e.authFailure ? 'Pairing expired — reconnect' : e.message);
      }
    } catch (_) {
      if (mounted) {
        setState(() => _message = 'Could not reach the server');
        _fail('Could not reach the server');
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _search() async {
    final query = _searchController.text.trim();
    if (query.isEmpty || _busy) return;
    final api = ref.read(serverApiProvider);
    if (api == null) {
      _fail('Not paired');
      return;
    }
    setState(() {
      _busy = true;
      _message = null;
    });
    try {
      final res = await api.bibleSearchFull(query,
          searchAll: _searchAll, experimental: _sentenceFirst);
      if (mounted) {
        setState(() {
          _results = res.results;
          _activeBible = res.activeBibleName ?? _activeBible;
          if (res.results.isEmpty) _message = 'No verses found';
        });
      }
    } on ApiException catch (e) {
      if (mounted) _fail('Search failed: ${e.message}');
    } catch (_) {
      if (mounted) _fail('Search failed — check connection');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _loadVerse(BibleResult result) async {
    if (_busy || result.text.isEmpty) return;
    setState(() => _busy = true);
    try {
      await ref
          .read(serverApiProvider)
          ?.bibleReference(result.reference.isEmpty ? result.text : result.reference);
      if (mounted) setState(() => _message = 'Loaded ${result.reference}');
    } on ApiException catch (e) {
      if (mounted) _fail(e.message);
    } catch (_) {
      if (mounted) _fail('Could not reach the server');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Bible'),
        actions: [
          if (_activeBible != null)
            Padding(
              padding: const EdgeInsets.only(right: 12),
              child: Center(
                child: Text(_activeBible!,
                    style: const TextStyle(
                        fontSize: 12, color: AppTheme.textSecondary)),
              ),
            ),
        ],
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _referenceController,
                    textInputAction: TextInputAction.go,
                    onSubmitted: (_) => _loadReference(),
                    decoration: const InputDecoration(
                        hintText: 'Reference — John 3:16'),
                  ),
                ),
                const SizedBox(width: 12),
                FilledButton(
                  onPressed: _busy ? null : _loadReference,
                  child: _busy
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2))
                      : const Text('LOAD'),
                ),
              ],
            ),
            if (_bibles.length > 1) ...[
              const SizedBox(height: 8),
              Wrap(
                spacing: 8,
                children: [
                  for (final b in _bibles)
                    ChoiceChip(
                      label: Text(b.name),
                      selected: b.name == _activeBible,
                      onSelected: (_) {},
                    ),
                ],
              ),
            ],
            if (_message != null) ...[
              const SizedBox(height: 8),
              Text(_message!, style: TextStyle(color: AppTheme.textSecondary)),
            ],
            const SizedBox(height: 24),
            TextField(
              controller: _searchController,
              textInputAction: TextInputAction.search,
              onSubmitted: (_) => _search(),
              decoration: InputDecoration(
                hintText: 'Search verses — try a whole sentence',
                suffixIcon: IconButton(
                  icon: _busy
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(strokeWidth: 2))
                      : const Icon(Icons.search),
                  onPressed: _busy ? null : _search,
                ),
              ),
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                FilterChip(
                  label: const Text('Sentence-first'),
                  selected: _sentenceFirst,
                  onSelected: (v) => setState(() => _sentenceFirst = v),
                ),
                const SizedBox(width: 8),
                FilterChip(
                  label: const Text('All translations'),
                  selected: _searchAll,
                  onSelected: (v) => setState(() => _searchAll = v),
                ),
              ],
            ),
            const SizedBox(height: 12),
            for (final result in _results)
              Card(
                color: AppTheme.surface,
                child: ListTile(
                  title: Text(
                    result.reference.isEmpty ? 'Result' : result.reference,
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                  subtitle: Text(result.text, maxLines: 3),
                  isThreeLine: result.text.length > 80,
                  onTap: () => _loadVerse(result),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

extension<T> on List<T> {
  T? get firstOrNull => isEmpty ? null : first;
}

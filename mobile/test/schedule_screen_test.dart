import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lyricdisplay_mobile/app/theme.dart';
import 'package:lyricdisplay_mobile/core/models.dart';
import 'package:lyricdisplay_mobile/features/schedule/schedule_screen.dart';
import 'package:lyricdisplay_mobile/state/providers.dart';

class _FixedSchedule extends ScheduleNotifier {
  _FixedSchedule(this.fixed);
  final ScheduleSnapshot fixed;

  @override
  ScheduleSnapshot build() => fixed;
}

class _FixedShow extends ShowStateNotifier {
  _FixedShow(this.fixed);
  final ShowState fixed;

  @override
  ShowState build() => fixed;
}

Widget _wrap(ProviderContainer c) => UncontrolledProviderScope(
      container: c,
      child: MaterialApp(
        theme: AppTheme.dark,
        home: const ScheduleScreen(),
      ),
    );

ProviderContainer _container({ScheduleSnapshot? schedule, ShowState? show}) {
  final c = ProviderContainer(
    overrides: [
      if (schedule != null)
        scheduleProvider.overrideWith(() => _FixedSchedule(schedule)),
      showStateProvider.overrideWith(() => _FixedShow(show ?? const ShowState())),
      // Offline: no pairing, so refresh() short-circuits to 'Not paired'
      // and the empty state renders deterministically.
    ],
  );
  addTearDown(c.dispose);
  return c;
}

void main() {
  group('ScheduleScreen', () {
    testWidgets('unpaired shows the load error, not a silent empty',
        (tester) async {
      await tester.pumpWidget(_wrap(_container()));
      await tester.pump();
      expect(find.text('Schedule'), findsOneWidget);
      // No pairing -> refresh() reports 'Not paired' inline.
      expect(find.textContaining('Could not load the schedule'),
          findsOneWidget);
    });

    testWidgets('running schedule shows name, status, and controls',
        (tester) async {
      const snap = ScheduleSnapshot(
        loaded: true,
        status: 'running',
        name: 'Sunday Service',
        itemIndex: 1,
        itemCount: 3,
        currentItemName: 'Sermon',
      );
      await tester.pumpWidget(_wrap(_container(schedule: snap)));
      await tester.pump();
      expect(find.text('Sunday Service'), findsOneWidget);
      expect(find.text('RUNNING'), findsOneWidget);
      expect(find.text('Start'), findsOneWidget);
      expect(find.text('Pause'), findsOneWidget);
      expect(find.text('Stop'), findsOneWidget);
    });

    testWidgets('scrolls on a short phone screen', (tester) async {
      tester.view.physicalSize = const Size(360, 640);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });
      const snap = ScheduleSnapshot(
        loaded: true,
        status: 'idle',
        name: 'Long Night',
        itemIndex: 0,
        itemCount: 3,
        currentItemName: 'Opener',
      );
      await tester.pumpWidget(_wrap(_container(schedule: snap)));
      await tester.pump();
      expect(tester.takeException(), isNull);
    });
  });
}

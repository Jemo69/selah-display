/// App navigation: /connect → /pair → shell (control, setlist, bible, schedule, settings).
library;

import 'package:go_router/go_router.dart';

import '../core/models.dart';
import '../features/bible/bible_screen.dart';
import '../features/control/control_screen.dart';
import '../features/discovery/discovery_screen.dart';
import '../features/pairing/pairing_screen.dart';
import '../features/schedule/schedule_screen.dart';
import '../features/setlist/setlist_screen.dart';
import '../features/settings/settings_screen.dart';
import '../features/shell/app_shell.dart';

final appRouter = GoRouter(
  initialLocation: '/connect',
  routes: [
    GoRoute(path: '/connect', builder: (_, _) => const DiscoveryScreen()),
    GoRoute(
      path: '/pair',
      builder: (_, state) {
        final extra = state.extra;
        final joinCode = state.uri.queryParameters['joinCode'];
        return PairingScreen(
          server: extra is DiscoveredServer ? extra : null,
          initialJoinCode: (joinCode?.isNotEmpty ?? false) ? joinCode : null,
        );
      },
    ),
    ShellRoute(
      builder: (context, state, child) => AppShell(child: child),
      routes: [
        GoRoute(
          path: '/control',
          pageBuilder: (_, _) => const NoTransitionPage(child: ControlScreen()),
        ),
        GoRoute(
          path: '/setlist',
          pageBuilder: (_, _) => const NoTransitionPage(child: SetlistScreen()),
        ),
        GoRoute(
          path: '/bible',
          pageBuilder: (_, _) => const NoTransitionPage(child: BibleScreen()),
        ),
        GoRoute(
          path: '/schedule',
          pageBuilder: (_, _) => const NoTransitionPage(child: ScheduleScreen()),
        ),
        GoRoute(
          path: '/settings',
          pageBuilder: (_, _) => const NoTransitionPage(child: SettingsScreen()),
        ),
      ],
    ),
  ],
);

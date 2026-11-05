# Selah Mobile — Flutter Controller

Native Android-first (iOS-ready) controller for Selah. Finds the desktop
on the church Wi-Fi via mDNS, pairs with the on-screen 6-digit join code, and
drives the show: live lyric preview, line navigation, output toggles, setlist,
and Bible quick-load.

## Download

Release builds are attached to GitHub Releases as versioned artifacts:
`selah-mobile-<version>.apk` (sideload) and `selah-mobile-<version>.aab`
(Google Play upload). They build automatically from `mobile-v*` tags via
`.github/workflows/mobile-release.yml`.

### Cutting a release

```sh
npm run release:mobile   # bump pubspec, commit, tag mobile-vX.Y.Z, push — CI builds APK + AAB
```

Or tag manually: `git tag -a mobile-v1.2.0 -m "..." && git push origin mobile-v1.2.0`.
`workflow_dispatch` also works (builds without attaching).

Android-only for now — iOS stays untested until Apple hardware and a
developer account exist.

## Pairing

1. On the desktop app, open **File > Connect Mobile Controller** to see the 6-digit join code.
2. Open this app on a phone/tablet on the same Wi-Fi — Selah appears under "Find Selah".
3. Tap the server, type the on-screen code, done. (No server found? Use the manual IP field.)

### Off-site over Tailscale
1. Put the church PC and your phone on the same tailnet.
2. In the desktop QR dialog, tap the **Tailscale `100.x`** address so the QR encodes the tailnet route.
3. On the phone, enter the `100.x` IP or `<name>.tail*.ts.net` MagicDNS name manually if auto-discovery finds nothing (mDNS does not cross a tailnet).
4. Pair with the join code as usual. The app uses light snapshots + delta sync, so even a slow relay feels instant.

## Screens
- **Control** — live lyric preview, PREV/NEXT/JUMP, outputs, show states (LIVE/CLEAR/BLACKOUT/LOGO), announcements.
- **Setlist** — sentence-first search, load, reorder, swipe-to-delete, add-text-song.
- **Bible** — reference quick-load, full-text search (sentence-first ON), all-translations toggle, translation list.
- **Schedule** — run-sheet clock: start/pause/resume/stop/next/prev with live countdown (REST-backed, works while the socket reconnects).
- **Settings** — switch server, forget pairing.

The pairing is remembered; next launch offers "resume last connection".

## Development

```sh
cd mobile
flutter pub get
flutter run            # debug on a connected device/emulator
flutter test           # unit tests
flutter analyze        # lint
```

### Permissions

- **Camera** — QR-code join (declared on Android + iOS; requested when the scanner opens).
- **Location (Android only)** — the subnet-sweep leg of auto-discovery reads the
  Wi-Fi IP, which needs location permission on Android 10+. Requested on the
  first scan; without it discovery falls back to mDNS + manual IP + QR.

### Release signing

Keystore material lives **outside** the repo. Create `mobile/android/keystore.properties`:

```
storeFile=/absolute/path/to/release-key.jks
storePassword=...
keyAlias=lyricdisplay
keyPassword=...
```

CI signs using `KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`,
`KEY_PASSWORD` repository secrets (see the workflow). Without them, builds
fall back to debug signing.

### iOS

Code stays platform-clean but iOS is untested until Apple hardware and an
Apple developer account exist.

## Architecture

- `lib/core/` — REST client (`server_api.dart`), Socket.IO service, mDNS discovery, secure pairing store, models.
- `lib/state/providers.dart` — Riverpod wiring: session, live show state mirror, commands.
- `lib/features/` — discovery, pairing, control, setlist, bible, settings screens.
- Tablets (≥600dp): navigation rail + two-pane control screen with setlist sidebar.

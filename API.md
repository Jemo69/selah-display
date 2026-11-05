# REST API — Local Network Access

The Express server (`server/index.js`) listens on port 4000 (bound to `0.0.0.0`) so external programs on the local network can control the lyric display app.

- All `/api/v1/*` endpoints require JWT Bearer authentication.
- Some `/api/*` endpoints are **localhost-only** (noted below) and return `403 Local access only` from remote machines.
- Unmatched `/api/*` paths return `404 { "error": "API endpoint not found" }`.
- Full OpenAPI spec: `docs/openapi.yaml`. Socket.IO event catalog: `docs/asyncapi.yaml`.

## Authentication

Generate a token via the auth endpoint:

```bash
curl -X POST http://192.168.1.100:4000/api/auth/token \
  -H "Content-Type: application/json" \
  -d '{
    "clientType": "api",
    "deviceId": "my-script-001",
    "adminKey": "your-admin-key"
  }'
```

Response:

```json
{
  "token": "<jwt>",
  "expiresIn": "24h",
  "clientType": "api",
  "deviceId": "my-script-001",
  "sessionId": "session_...",
  "permissions": ["lyrics:read", "..."]
}
```

- In development (`NODE_ENV != production`), adminKey is optional.
- In production, adminKey must match server's ADMIN_ACCESS_KEY.
- Use token in subsequent calls:

```bash
curl -H "Authorization: Bearer <token>" http://192.168.1.100:4000/api/v1/status
```

Valid `clientType` values: `desktop`, `web`, `output1`, `output2`, `stage`, `mobile`, `api`.

### Tailscale (off-site controllers)
The server binds `0.0.0.0` and allows the Tailscale CGNAT range (`100.64.0.0/10`)
plus `*.ts.net` origins through REST and Socket.IO CORS. To drive the show
from outside the church Wi-Fi:
1. Put the desktop and the phone on the same tailnet.
2. On the desktop: **File > Connect Mobile Controller** — the QR dialog lists
   LAN and Tailscale (`100.x`) addresses; pick the Tailscale one for off-site.
3. On the phone: type the `100.x` IP or `<name>.tail*.ts.net` MagicDNS name in
   the manual field (mDNS does not cross a tailnet, and the `/24` sweep only
   finds same-subnet LAN peers). Pair with the 6-digit join code as usual.

Permissions by client type (`server/index.js`):

| clientType | permissions |
|---|---|
| `desktop` | lyrics read/write/delete, setlist read/write/delete, output:control, settings:write, admin:full |
| `web` | lyrics read/write/draft, setlist:read, output:control, settings read/write |
| `output1`, `output2`, `stage` | lyrics:read, settings:read |
| `mobile` | lyrics read/write/draft, setlist:read, output:control, settings read/write |
| `api` | lyrics read/write/delete, setlist read/write/delete, output:control, settings:write, admin:full |

Token requests to `/api/auth/token` are rate limited (default 50 requests per 15 min window).

### Controller join codes

`web` and `mobile` clients must supply a valid `joinCode` (6-digit code shown by the desktop app) when requesting a token. Invalid attempts are tracked; after too many failures the request returns **HTTP 423** with `retryAfterMs`. Tokens issued to controllers embed the current join code and are rejected if the code rotates.

### POST /api/auth/token
Issue a JWT. Body: `clientType` (required), `deviceId` (required), `sessionId` (optional), `adminKey` (desktop/api), `joinCode` (web/mobile). See above.

### GET /api/auth/join-code
Returns the current controller join code. **Localhost-only** (used by the desktop UI to show/QR the code).

```json
{ "joinCode": "123456" }
```

### OBS dock pairing (PIN)

Lightweight controllers running inside an OBS Custom Browser Dock (`/#/obs-dock`) pair with a single-use 6-digit PIN instead of the shared join code. PIN attempts reuse the join-code guard (5 failures per 10 min → 15 min lockout, HTTP 423).

- `POST /api/auth/obs-dock/pin` — **Localhost-only.** Issues a PIN (`{ success, pinId, pin, expiresAt, expiresInMs }`, 10 min TTL). Body: `{ "deviceLabel": "optional" }`.
- `POST /api/auth/obs-dock/token` — Exchange a PIN for a controller JWT. Body: `{ "pin": "123456", "deviceId": "obs-dock-abc" }`. Rate-limited with the other `/api/auth/*` routes. Consumes the PIN (single use).

Point the OBS dock at `http://127.0.0.1:4000/#/obs-dock`. For automatic lyric browser-source creation over OBS-WebSocket v5 (default `ws://127.0.0.1:4455`), see `src/integrations/obs/obsWebSocketClient.js` (`ensureLyricBrowserSource`).

### POST /api/auth/refresh
Re-issue a token from an existing (still-valid) one. Body: `{ "token": "<jwt>" }`. Returns same shape as `/api/auth/token`.

### POST /api/auth/validate
Check a token. Body: `{ "token": "<jwt>" }`.

Response (valid):

```json
{
  "valid": true,
  "clientType": "api",
  "deviceId": "...",
  "sessionId": "...",
  "permissions": ["..."],
  "expiresAt": 1730000000000
}
```

Invalid/expired returns HTTP 401 with `{ "valid": false, "error": "..." }`.

## Status & Connection

### GET /api/v1/status
Current app status. **Auth:** Bearer token required.

Response:

```json
{
  "success": true,
  "status": {
    "lyricsFile": "Amazing Grace",
    "selectedLine": 2,
    "isOutputOn": true,
    "output1Enabled": true,
    "output2Enabled": true,
    "stageEnabled": true,
    "setlistCount": 5,
    "lyricsCount": 12,
    "activeLyrics": ["... first 5 lines ..."],
    "totalLyrics": 12,
    "fileName": "Amazing Grace",
    "hasLyrics": true,
    "currentLyrics": ["... first 10 lines ..."],
    "lyricsFileName": "Amazing Grace",
    "sectionsCount": 4
  },
  "timestamp": 1730000000000
}
```

### GET /api/connection/clients
List connected Socket.IO clients. Requires permission `lyrics:read`.

```json
{
  "success": true,
  "clients": [
    { "clientType": "mobile", "sessionId": "...", "deviceId": "...", "connectedAt": 1730000000000, "permissions": ["..."], "socketCount": 1 }
  ],
  "totalCount": 1,
  "timestamp": 1730000000000
}
```

### GET /api/outputs/resolve/:slug
Resolve an output slug (`output1`, `output2`, `stage`, or a custom output slug) to its registry entry. No auth required (used by output page routing).

```json
{ "id": "stage", "key": "stage", "name": "Stage", "slug": "stage", "type": "stage", "builtIn": true }
```

Unknown slug → 404 `{ "error": "Output not found" }`.

### GET /api/v1/outputs/presence
Live heartbeat registry of connected output instances (built-in `output1`, `output2`, `stage` plus custom outputs). Requires permission `lyrics:read`. Output pages register on socket connect with their `clientType`/`purpose`; entries expire on disconnect.

```json
{
  "success": true,
  "presence": [
    { "id": "socket_...", "outputKey": "output1", "clientType": "output1", "deviceId": "...", "connectedAt": 1730000000000, "lastSeenAt": 1730000001000 }
  ],
  "timestamp": 1730000001000
}
```

## Setlist

### GET /api/v1/setlist
All setlist items (metadata only, no file content).

```json
{
  "success": true,
  "count": 3,
  "setlist": [
    {
      "id": "setlist_...",
      "name": "Amazing Grace",
      "displayName": "Amazing Grace",
      "originalName": "Amazing Grace.txt",
      "fileType": "txt",
      "addedAt": 1730000000000,
      "lastModified": 1730000000000,
      "metadata": null
    }
  ]
}
```

### POST /api/v1/setlist/load
Load a setlist item to display. Body:

```json
{ "fileId": "setlist_123", "enableNormalGrouping": true }
```

- `fileId` (required)
- `enableNormalGrouping` (optional boolean): controls auto 2-line grouping during parsing (see [Lyric grouping](#lyric-grouping)). Defaults to server setting (enabled).

Response: `{ "success": true, "fileId": "...", "fileName": "...", "linesCount": 24, "rawContent": "..." }`.

### POST /api/v1/setlist/add
Add txt/lrc file(s) to setlist. Body:

```json
{
  "name": "song.txt",
  "content": "Verse line 1\nVerse line 2\n..."
}
```

- `content` required, max 2 MB UTF-8.
- Optional: `fileType` (`txt`/`lrc`), `metadata`, `originalName` (fallback for `name`).
- Duplicate names are rejected; max 50 files.

Response: `{ "success": true, "added": [{ "id": "...", "displayName": "...", "originalName": "...", "fileType": "txt" }], "totalCount": 6 }`.

### POST /api/v1/setlist/reorder
Reorder setlist. Body:

```json
{ "orderedIds": ["id2", "id1", "id3"] }
```

Must contain every current id exactly once.

### DELETE /api/v1/setlist/:fileId
Remove item from setlist. 404 if id unknown.

### POST /api/v1/setlist/clear
Clear entire setlist. Body empty.

## Lyrics Control

### POST /api/v1/lyrics/next
Advance to next line. Returns `{ "success": true, "selectedLine": 3 }`. Clamps at last line.

### POST /api/v1/lyrics/prev
Go to previous line. Clamps at 0.

### POST /api/v1/lyrics/goto
Jump to specific line. Body:

```json
{ "lineIndex": 5 }
```

`lineIndex` must be an integer.

### POST /api/v1/lyrics/load-text
Load raw text directly as lyrics (no setlist add). Body:

```json
{
  "title": "My Song",
  "content": "Line 1\nLine 2\n...",
  "enableNormalGrouping": false
}
```

- `content` required; `title` defaults to `"Untitled"`.
- `enableNormalGrouping` optional boolean (see [Lyric grouping](#lyric-grouping)).

Response: `{ "success": true, "fileName": "...", "linesCount": 12, "lines": [...], "title": "..." }`.

### Lyric grouping
`enableNormalGrouping` toggles automatic pairing of consecutive short plain-text lines (≤45 chars) into combined 2-line slides, including across blank lines. Omit (or pass `true`) for default behavior; pass `false` for strict line-per-slide output. Applies to both TXT and LRC parsing (`shared/lyricsParsing.js`).

## Output

### POST /api/v1/output/toggle
Toggle master output on/off. Body:

```json
{ "on": true }
```

If `on` omitted, toggles current state. Also coerces `"true"`/`1`. Response: `{ "success": true, "isOutputOn": true, "showState": "LIVE" }` (`showState` is additive; legacy clients ignore it).

### GET /api/v1/output/show-state
Explicit show-control state. Response: `{ "success": true, "showState": "LIVE", "isOutputOn": true }`.

### POST /api/v1/output/show-state
Set explicit show-control state. Body:

```json
{ "state": "CLEAR" }
```

`state` must be one of `LIVE` (normal lyrics), `CLEAR` (background only), `BLACKOUT` (full black), `LOGO` (house slide). The legacy master flag derives from it (only `LIVE` reads as ON), so `POST /api/v1/output/toggle` keeps working: `ON` → `LIVE`, `OFF` → `BLACKOUT`. Response: `{ "success": true, "showState": "CLEAR", "isOutputOn": false }`.

### Announcement ticker
Queued announcements overlay a lower-third on the selected output without disturbing the current lyric line. Omit `targetOutput` (or use `"all"`) to keep the legacy all-outputs behavior.

- `GET /api/v1/ticker` → `{ "success": true, "queue": [...], "activeId": "...", "active": {...} }`
- `POST /api/v1/ticker` — Body `{ "text": "Welcome — ...", "targetOutput": "output2" }` (max 280 chars, max 20 queued). `targetOutput` may be `output1`, `output2`, `stage`, or a custom output key. The first item auto-activates the overlay.
- `POST /api/v1/ticker/show` — Body `{ "id": "<item-id>" }` (`null` hides the overlay).
- `POST /api/v1/ticker/clear` — Clear the whole queue.
- `DELETE /api/v1/ticker/:id` — Remove one announcement (404 if unknown).

## Bible

### POST /api/v1/bible/reference
Load Bible reference into display. Body:

```json
{ "reference": "John 3:16" }
```

Optional:
- `text`: override verse text
- `slides`: array of strings for multi-slide verses
- `bible`: bible name label

If a bible is loaded on server (`uploads/bibles/` directory), the reference is resolved via `server/bibleManager.js` (`shared/bible/index.js` `searchBible`). Each slide becomes `${verseText}\n\n${reference}`.

Response:

```json
{
  "success": true,
  "reference": "John 3:16",
  "resolved": true,
  "bible": "KJV",
  "activeBibleId": "bible_kjv",
  "slides": 1,
  "fileName": "John 3:16",
  "linesCount": 3
}
```

If no bible is loaded, `resolved` is `false` and the reference string itself is used as lyric content.

### GET /api/v1/bible/search?q=...&limit=20
Search active Bible.

Query params:
- `q` (required; alias `query`): search query or reference (e.g., "John 3:16" or "love")
- `limit` (optional): max results, default 20, max 100
- `searchAll=true` (optional): search all loaded bibles
- `experimental=true` (optional): sentence-first ranking (same wins as the
  desktop Experimental flag — a sentence query ranks the verse containing the
  whole sentence first instead of OR-matching words)

Response example:

```json
{
  "success": true,
  "query": "John 3:16",
  "count": 1,
  "results": [
    { "bookName": "John", "chapter": 3, "verse": 16, "text": "For God so loved...", "reference": "John 3:16", "bibleId": "...", "bibleName": "KJV" }
  ],
  "activeBible": { "id": "...", "name": "KJV" },
  "bibles": [{ "id": "...", "name": "KJV", "bookCount": 66 }]
}
```

If no bible loaded:

```json
{
  "success": true,
  "query": "John 3:16",
  "results": [],
  "count": 0,
  "message": "No bible loaded on server. Place bible files in uploads/bibles directory.",
  "bibles": []
}
```

### GET /api/v1/bible/list
List loaded bibles.

```json
{
  "success": true,
  "bibles": [{ "id": "bible_kjv", "name": "KJV", "bookCount": 66 }],
  "activeBibleId": "bible_kjv",
  "activeBible": { "id": "bible_kjv", "name": "KJV", "bookCount": 66 }
}
```

## Mobile fast path (light state + delta sync)
Phones on church Wi-Fi or a Tailscale relay use these instead of the full
`currentState` (which ships every setlist file's *content* and can be 100KB+
for a 1KB lyric).

### GET /api/v1/state/light
Tiny snapshot for phones (no file contents, ~2-4KB): `lyrics`,
`selectedLine`, `lyricsFileName`, `isOutputOn`, `showState`, `ticker`,
per-output enables, `setlist` (metadata only), schedule summary
(`scheduleLoaded`, `scheduleStatus`, `scheduleName`), and `fingerprint`.

### GET /api/v1/sync?since=<fingerprint>
Delta sync. `{ "changed": false, "fingerprint" }` (~100 bytes) when nothing
changed; otherwise `{ "changed": true, "fingerprint", "state": { …light… } }`.
The Flutter app polls this every 3s only while the socket is down.

Socket equivalents: emit `requestLightState` (replies `currentState` with
`light: true`) or `requestSync` `{ since }` (replies `syncState`).

## Setlist search (sentence-first)

### GET /api/v1/setlist/search?q=...&experimental=true&limit=20
Ports the desktop file-navigator ranking to mobile. `experimental=true`
(default on in the app) ranks whole-sentence matches first. Response:
`{ "success": true, "query", "count", "results": [{ "file": { "id",
"displayName", "originalName", "fileType" }, "score", "matchedField",
"sentence" }], "experimental", "totalSetlist" }`.

## Scheduler (run-sheet clock)

### GET /api/v1/schedule
Authoritative snapshot: `{ "success": true, "loaded", "status",
"schedule": { "name", "items": […] }, "itemIndex", … }`.

### POST /api/v1/schedule/control
Body: `{ "action": "start" | "pause" | "resume" | "stop" | "next" | "prev" |
"replan" | "reconcile", …extra }`. `replan` takes `startEpochMs`;
`reconcile` takes `actualStartEpochMs` + `strategy` (`shift`|`compress`).
`POST /api/v1/schedule/load` accepts a full schedule document. The Flutter
Schedule tab uses these over REST so it works even while the socket is
reconnecting. Socket equivalents (`scheduleLoad`, `scheduleControl`,
`requestSchedule` → `scheduleState`) are unchanged.

## Background Media

### POST /api/media/backgrounds
Upload a background image/video for an output window. Requires permission `settings:write`.

- Multipart form-data, file field: `background`
- Form field `outputKey`: `output1`, `output2`, `stage`, or `custom_*` (enables cleanup of older files for that output)
- Allowed types: jpeg, png, gif, webp, avif, mp4, webm, ogg, mov
- Max size: 200 MB

```bash
curl -X POST http://192.168.1.100:4000/api/media/backgrounds \
  -H "Authorization: Bearer $TOKEN" \
  -F "background=@wallpaper.jpg" \
  -F "outputKey=output1"
```

Response:

```json
{
  "url": "/media/backgrounds/bg-output1-1730000000000-uuid.jpg",
  "originalName": "wallpaper.jpg",
  "mimeType": "image/jpeg",
  "size": 102400,
  "uploadedAt": 1730000000000
}
```

### DELETE /api/media/backgrounds/:outputKey
Delete all stored background media for an output key. Requires `settings:write`. Response: `{ "success": true, "outputKey": "output1" }`.

### Static media
Uploaded files are served unauthenticated from `/media/**` (e.g., `/media/backgrounds/<file>`) with 1-day cache headers.

## Health

### GET /api/health
Health check. No auth required. Mobile discovery probes this endpoint to verify a Selah server during subnet sweep / manual IP entry.

```json
{
  "status": "healthy",
  "name": "Selah",
  "mdns": "_lyricdisplay._tcp",
  "timestamp": "...",
  "environment": "production"
}
```

### GET /api/health/ready
Readiness probe with individual check results. Returns 503 with `failedChecks` list when not ready.

```json
{
  "status": "ready",
  "serverListening": true,
  "timestamp": "...",
  "checks": {
    "serverListening": true,
    "secretsLoaded": true,
    "joinCodeGenerated": true,
    "socketIOReady": true,
    "rateLimiterActive": true
  },
  "uptime": 123.45,
  "port": 4000,
  "secretsStatus": {}
}
```

The Electron main process gates startup on this endpoint.

### GET /api/admin/health
Detailed health info including secret rotation age and join-code guard metrics. **Localhost-only**.

```json
{
  "status": "healthy",
  "timestamp": "...",
  "environment": "production",
  "security": {
    "secretsLoaded": true,
    "daysSinceRotation": 12,
    "needsRotation": false,
    "joinCodeGuard": {}
  }
}
```

## Admin (localhost-only)

### GET /api/admin/secrets/status
Secret manager status (whether secrets exist, config path, rotation age).

### POST /api/admin/secrets/rotate
Rotate the JWT signing secret. Existing tokens remain valid during the grace period via the previous secret.

```json
{
  "success": true,
  "message": "JWT secret rotated successfully. Server restart required.",
  "lastRotated": "..."
}
```

## Server Binding

Server listens on `0.0.0.0` to allow local network access:

```js
server.listen(PORT, '0.0.0.0', ...)
```

Access via `http://<local-ip>:4000`. Port override via `PORT` env var; data directory override via `SELAH_DATA_DIR` (`LYRICDISPLAY_DATA_DIR` is still accepted as a legacy alias).

## Session Persistence

Live state (loaded lyrics, selected line, outputs, styles, custom outputs, stage timer/messages, setlist) is periodically persisted to `backend/realtime-session-state.json` (`SELAH_DATA_DIR` aware) and restored automatically on server restart. State is flushed on SIGINT/SIGTERM. See `server/sessionPersistence.js`.

## mDNS Discovery

On startup the server advertises the `_lyricdisplay._tcp` Bonjour service (TXT: `version=1 path=/ api=v1`) so mobile controllers can find it automatically. Set `ENABLE_MDNS=false` to disable multicast advertising (useful on WSL/CI). Instance name override via `SELAH_MDNS_NAME` (legacy alias `LYRICDISPLAY_MDNS_NAME`).

## Bible Integration

- Server-side bible manager: `server/bibleManager.js`
- Uses `shared/bible/index.js` `searchBible` for reference resolution
- Loads bible files from `uploads/bibles/` on startup (supports Zefania, OSIS, Beblia, OpenSong formats via `parseBible`)
- Place `.xml` bible files into that folder and restart server, or API will load them automatically

## Error Handling

All endpoints return JSON. Failures use `{ "success": false, "error": "..." }` (or `{ "error": "..." }` on non-v1 routes) with appropriate HTTP status:
- 400: bad request / validation error
- 401: missing/invalid auth
- 403: insufficient permissions or localhost-only endpoint accessed remotely
- 404: not found (including unmatched `/api/*` paths)
- 423: locked out (too many invalid join-code attempts; body includes `retryAfterMs`)
- 429: rate limit exceeded on auth endpoints
- 500: server error
- 503: readiness checks failed (`/api/health/ready`)

## Example Usage

Get token and navigate lyrics via JS:

```js
const res = await fetch('http://192.168.1.100:4000/api/auth/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ clientType: 'api', deviceId: 'my-script' })
});
const { token } = await res.json();

await fetch('http://192.168.1.100:4000/api/v1/lyrics/next', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}` }
});
```

Upload TXT file:

```bash
curl -X POST http://192.168.1.100:4000/api/v1/setlist/add \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Amazing Grace.txt","content":"Amazing grace how sweet the sound\nThat saved a wretch like me"}'
```

Load without 2-line grouping:

```bash
curl -X POST http://192.168.1.100:4000/api/v1/lyrics/load-text \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title":"Psalm 23","content":"The LORD is my shepherd","enableNormalGrouping":false}'
```

Bible reference:

```bash
curl -X POST http://192.168.1.100:4000/api/v1/bible/reference \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reference":"John 3:16"}'
```

Background upload:

```bash
curl -X POST http://192.168.1.100:4000/api/media/backgrounds \
  -H "Authorization: Bearer $TOKEN" \
  -F "background=@image.jpg" \
  -F "outputKey=output1"
```

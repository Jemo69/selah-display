// tools/mobile-api-smoke.mjs — live proof for the mobile fast-path PR.
//
// Boots the REAL server (child process, test port, isolated data dir),
// then drives every endpoint the phone uses via TWO channels (REST +
// socket.io, the way the Flutter app actually talks). Fails non-zero on
// the first broken claim. Reuse: tools/dogfood-harness.sh smoke
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = 4123;
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
const check = (name, cond, detail = '') => {
  results.push({ name, ok: Boolean(cond), detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) throw new Error(`smoke failed: ${name} ${detail}`);
};

const jfetch = async (url, opts = {}) => {
  const res = await fetch(url, opts);
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, headers: res.headers, body };
};

async function main() {
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'dogfood-sel-'));
  const logPath = path.join(dataDir, 'server.log');
  const logFd = await fs.promises.open(logPath, 'w');
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production', SELAH_DATA_DIR: dataDir },
    stdio: ['ignore', logFd.fd, logFd.fd],
  });
  const kill = () => { try { child.kill('SIGTERM'); } catch {} };
  process.on('exit', kill);

  // Wait for health (fresh build, real boot).
  let healthy = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) { healthy = true; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  check('server boots fresh (production, isolated data dir)', healthy, `log: ${logPath}`);

  try {
    // 1. Join code (localhost-only, the QR dialog's source).
    const jc = await jfetch(`${BASE}/api/auth/join-code`);
    check('join code is 6 digits', jc.status === 200 && /^\d{6}$/.test(jc.body?.joinCode ?? ''), JSON.stringify(jc.body));

    // 2. Wrong code rejected.
    const bad = await jfetch(`${BASE}/api/auth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientType: 'mobile', deviceId: 'dogfood-phone', joinCode: '000000' }),
    });
    check('wrong join code -> 403', bad.status === 403, JSON.stringify(bad.body));

    // 3. Correct pairing + mobile now carries setlist:write.
    const pair = await jfetch(`${BASE}/api/auth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientType: 'mobile', deviceId: 'dogfood-phone', joinCode: jc.body.joinCode }),
    });
    check('pair with join code -> token', pair.status === 200 && typeof pair.body?.token === 'string');
    const perms = pair.body.permissions || [];
    check('mobile grants setlist:write (was read-only)', perms.includes('setlist:write'), perms.join(','));
    const token = pair.body.token;
    const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

    // 4. Authed status.
    const st = await jfetch(`${BASE}/api/v1/status`, { headers: H });
    check('authed /status 200', st.status === 200 && st.body?.success === true);

    // 5. Tailscale CORS (production path, real Origin headers).
    const tails = [
      'http://100.90.1.2:4000',
      'https://mypc.tail123.ts.net:4000',
    ];
    for (const origin of tails) {
      const r = await fetch(`${BASE}/api/v1/status`, { headers: { ...H, Origin: origin } });
      check(`CORS allows tailnet origin ${origin}`, r.headers.get('access-control-allow-origin') === origin);
    }
    const evil = await fetch(`${BASE}/api/v1/status`, { headers: { ...H, Origin: 'http://evil.example.com' } });
    check('CORS still blocks evil origin', evil.headers.get('access-control-allow-origin') == null);

    // 6. Seed setlist: sentence song vs scattered-words song vs tiny song.
    const filler = Array.from({ length: 60 }, (_, i) => `filler line ${i} nothing to see`).join('\n');
    const seed = [
      { name: 'Water Song', content: 'water turned into wine\n\nthe jars were full\n\namen' },
      { name: 'Scattered Words', content: `water\n${filler}\ninto\n${filler}\nwine` },
      { name: 'Tiny', content: 'line one\n\nline two' },
    ];
    for (const s of seed) {
      const r = await jfetch(`${BASE}/api/v1/setlist/add`, {
        method: 'POST', headers: H, body: JSON.stringify({ name: s.name, content: s.content, fileType: 'txt' }),
      });
      check(`seed setlist add "${s.name}"`, r.status === 200, `status=${r.status}`);
    }

    // 7. Light state is small and content-free.
    const light = await jfetch(`${BASE}/api/v1/state/light`, { headers: H });
    const lightBytes = JSON.stringify(light.body).length;
    check('light state < 4KB with 3 songs', light.status === 200 && lightBytes < 4096, `${lightBytes}B`);
    check('light setlist is metadata only', (light.body.setlist || []).every((e) => !('content' in e)));
    check('light carries fingerprint', typeof light.body.fingerprint === 'string' && light.body.fingerprint.length > 0);
    const fp = light.body.fingerprint;

    // 8. Delta sync: full on miss, ~100B on hit.
    const miss = await jfetch(`${BASE}/api/v1/sync`, { headers: H });
    check('sync without since -> changed', miss.body?.changed === true && miss.body?.state);
    const hit = await jfetch(`${BASE}/api/v1/sync?since=${encodeURIComponent(fp)}`, { headers: H });
    const hitBytes = JSON.stringify(hit.body).length;
    check('sync with same fingerprint -> unchanged + tiny', hit.body?.changed === false && hitBytes < 300, `${hitBytes}B`);

    // 9. Setlist search: sentence-first tops the sentence song.
    const sExp = await jfetch(`${BASE}/api/v1/setlist/search?q=${encodeURIComponent('water into wine')}&experimental=true`, { headers: H });
    const top = sExp.body?.results?.[0];
    check('sentence-first tops the sentence song', sExp.status === 200 && /Water Song/.test(top?.file?.displayName ?? '') && top?.sentence === true, JSON.stringify(top));
    const sPlain = await jfetch(`${BASE}/api/v1/setlist/search?q=${encodeURIComponent('water')}`, { headers: H });
    check('plain setlist search 200', sPlain.status === 200 && sPlain.body?.count >= 1);

    // 10. Bible graceful path (no bibles shipped in this env).
    const bq = await jfetch(`${BASE}/api/v1/bible/search?q=${encodeURIComponent('for God so love the world')}&experimental=true`, { headers: H });
    check('bible search degrades gracefully without bibles', bq.status === 200 && Array.isArray(bq.body?.results), JSON.stringify(bq.body).slice(0, 120));

    // 11. Socket as the phone (socket.io, auth + light + sync + schedule).
    const { io } = await import('socket.io-client');
    const sock = io(BASE, { auth: { token }, transports: ['polling', 'websocket'], reconnection: false, timeout: 8000 });
    const once = (ev) => new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout waiting ${ev}`)), 10000);
      sock.once(ev, (d) => { clearTimeout(t); res(d); });
    });
    await once('connect');
    check('phone socket connects with JWT', true);
    sock.emit('clientConnect', { type: 'mobile' });
    // The server also emits summary currentState on clientConnect and a
    // 100ms catch-up; wait for the explicitly-requested light snapshot.
    const cur = await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timeout waiting light currentState')), 10000);
      const h = (d) => { if (d && d.light === true) { clearTimeout(t); sock.off('currentState', h); res(d); } };
      sock.on('currentState', h);
      sock.emit('requestLightState');
    });
    check('requestLightState -> currentState light:true', cur?.light === true, `keys=${Object.keys(cur || {}).length}`);
    const syncP = once('syncState');
    sock.emit('requestSync', { since: fp });
    const synced = await syncP;
    check('requestSync same fp -> unchanged', synced?.changed === false, JSON.stringify(synced).slice(0, 100));

    // Mobile socket setlistAdd now permitted (was permissionError).
    const addP = once('setlistAddSuccess');
    sock.emit('setlistAdd', [{ name: 'sock.txt', content: 'from phone' }]);
    const added = await addP;
    check('mobile socket setlistAdd succeeds', added?.addedCount === 1, JSON.stringify(added));

    // Scheduler: REST load -> socket broadcast; REST control -> socket broadcast.
    const schedP = once('scheduleState');
    const load = await jfetch(`${BASE}/api/v1/schedule/load`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ name: 'Dogfood', items: [{ name: 'Opener', minutes: 2 }, { name: 'Sermon', minutes: 30 }] }),
    });
    check('REST schedule load', load.status === 200 && load.body?.loaded === true, JSON.stringify(load.body).slice(0, 120));
    const schedEv = await schedP;
    check('scheduleState broadcast on load', schedEv?.loaded === true && schedEv?.schedule?.name === 'Dogfood');
    const reqP = once('scheduleState');
    sock.emit('requestSchedule');
    const reqEv = await reqP;
    check('requestSchedule -> snapshot', reqEv?.loaded === true);
    const ctlP = once('scheduleState');
    const ctl = await jfetch(`${BASE}/api/v1/schedule/control`, {
      method: 'POST', headers: H, body: JSON.stringify({ action: 'start' }),
    });
    check('REST schedule start', ctl.status === 200 && ctl.body?.status === 'running', ctl.body?.status);
    const ctlEv = await ctlP;
    check('scheduleState broadcast running', ctlEv?.status === 'running');
    const stopCtl = await jfetch(`${BASE}/api/v1/schedule/control`, {
      method: 'POST', headers: H, body: JSON.stringify({ action: 'stop' }),
    });
    check('REST schedule stop', stopCtl.body?.status === 'idle' || stopCtl.body?.status === 'stopped', stopCtl.body?.status);

    // 12. Lyric race: 10 concurrent NEXT, no 500, clamps.
    const tiny = (await jfetch(`${BASE}/api/v1/setlist`, { headers: H })).body?.setlist?.find((f) => /Tiny/.test(f.displayName || f.name || ''));
    check('seeded Tiny song listed', Boolean(tiny?.id));
    const ld = await jfetch(`${BASE}/api/v1/setlist/load`, { method: 'POST', headers: H, body: JSON.stringify({ fileId: tiny.id }) });
    check('load Tiny for race', ld.status === 200);
    const races = await Promise.all(Array.from({ length: 10 }, () =>
      jfetch(`${BASE}/api/v1/lyrics/next`, { method: 'POST', headers: H })));
    check('10x concurrent NEXT all 200', races.every((r) => r.status === 200));
    const fin = await jfetch(`${BASE}/api/v1/status`, { headers: H });
    const lines = fin.body?.status?.totalLyrics ?? 0;
    check('NEXT clamps at last line', (fin.body?.status?.selectedLine ?? -1) <= Math.max(0, lines - 1), `sel=${fin.body?.status?.selectedLine} total=${lines}`);

    // 13. Oversize + garbage + expired paths the phone must surface.
    const big = await jfetch(`${BASE}/api/v1/setlist/add`, {
      // 2.5MB content passes the 3MB body ceiling but trips the 2MB route cap.
      method: 'POST', headers: H, body: JSON.stringify({ name: 'big', content: 'x'.repeat(Math.floor(2.5 * 1024 * 1024)) }),
    });
    check('oversize add -> 400 with error text', big.status === 400 && /content size/i.test(big.body?.error ?? ''), `status=${big.status} ${JSON.stringify(big.body)}`);
    const huge = await jfetch(`${BASE}/api/v1/setlist/add`, {
      // 10MB never reaches the route: clear 413, not an opaque 500.
      method: 'POST', headers: H, body: JSON.stringify({ name: 'huge', content: 'x'.repeat(10 * 1024 * 1024) }),
    });
    check('way-oversize add -> 413 with error text', huge.status === 413 && typeof huge.body?.error === 'string', `status=${huge.status}`);
    const noAuth = await jfetch(`${BASE}/api/v1/status`, { headers: { 'Content-Type': 'application/json', Authorization: 'Bearer garbage' } });
    check('garbage token -> 401 (phone re-pairs)', noAuth.status === 401);
    const badSock = io(BASE, { auth: { token: 'garbage' }, transports: ['polling'], reconnection: false, timeout: 8000 });
    const authErr = await new Promise((res) => {
      badSock.on('connect_error', (e) => res(String(e?.message ?? e)));
      setTimeout(() => res('TIMEOUT'), 10000);
    });
    check('socket with bad token rejected (auth)', /token|auth/i.test(authErr), authErr);
    badSock.close();

    // Refresh rotation: fresh token works.
    const ref = await jfetch(`${BASE}/api/auth/refresh`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }),
    });
    check('token refresh mints JWT', ref.status === 200 && typeof ref.body?.token === 'string');
    const refUse = await jfetch(`${BASE}/api/v1/status`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ref.body.token}` },
    });
    check('refreshed token works', refUse.status === 200);

    sock.close();
    console.log(`\nSMOKE ${results.length}/${results.length} PASS`);
  } finally {
    kill();
    await new Promise((r) => setTimeout(r, 1500));
  }
}

try {
  await main();
} catch (e) {
  console.error(`\nSMOKE FAILED: ${e.message}`);
  process.exitCode = 1;
}

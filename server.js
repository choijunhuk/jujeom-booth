'use strict';
// HTTP API + SSE + static files. Node built-ins only. See API.md for the contract.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createStore, HttpError } = require('./db');

const env = process.env;
let BASE = (env.BASE_PATH || '').trim().replace(/\/+$/, '');
if (BASE && !BASE.startsWith('/')) BASE = '/' + BASE;
const PORT = env.PORT === undefined || env.PORT === '' ? 8787 : Number(env.PORT);
const HOST = env.HOST || '127.0.0.1';
const CONFIG_DIR = env.CONFIG_DIR || __dirname;
const PUBLIC = path.resolve(env.PUBLIC_DIR || path.join(__dirname, 'public'));
const DATA_DIR = path.resolve(env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_ORIGIN = (env.PUBLIC_ORIGIN || '').replace(/\/+$/, '');
const COOKIE_PATH = BASE || '/';
const COOKIE_FLAGS = `Path=${COOKIE_PATH}; HttpOnly; SameSite=Lax${env.COOKIE_SECURE === '1' ? '; Secure' : ''}`;
const PAY = { bank: env.PAY_BANK || '', account: env.PAY_ACCOUNT || '', holder: env.PAY_HOLDER || '' };
const BACKUP_MS = Number(env.BACKUP_INTERVAL_MS) || 10 * 60 * 1000;
const BODY_LIMIT = 16 * 1024;
const SESSION_MS = (Number(env.SESSION_HOURS) || 72) * 3600 * 1000;
const KEY_MAX_AGE_S = 30 * 86400;
// stream caps are sized for a booth of a few dozen guests, not for the internet
const SSE_PUBLIC_MAX = Number(env.SSE_PUBLIC_MAX) || 300; // guest + board + wait streams
const SSE_STAFF_MAX = 100; // staff + kitchen streams have their own pool
const SSE_PER_DEVICE = 5;
const SSE_PER_TABLE = 12;
const SSE_BOARD_MAX = 20;
const SSE_WAIT_MAX = 60;
const SSE_BACKLOG_MAX = 64 * 1024; // public streams whose unsent backlog exceeds this are dropped
const LOCKOUT_MS = Number(env.LOCKOUT_MS) || 60000;

let STAFF_PIN = env.STAFF_PIN;
if (!STAFF_PIN) {
  if (env.NODE_ENV === 'development') { STAFF_PIN = '0000'; console.warn('WARNING: STAFF_PIN not set, using 0000 (development only)'); } else {
    console.error('STAFF_PIN is required (set NODE_ENV=development to use 0000 locally). Refusing to start.');
    process.exit(1);
  }
} else if (env.NODE_ENV !== 'development' && STAFF_PIN.length < 6) {
  console.error('STAFF_PIN must be at least 6 characters outside development. Refusing to start.');
  process.exit(1);
}

const readJson = (f) => JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, f), 'utf8'));
const menu = readJson('menu.json');
const rewards = readJson('rewards.json');
const tablesCfg = readJson('tables.json');
(function validateConfig() {
  const ids = new Set();
  for (const i of menu.items) {
    if (!i.id || ids.has(i.id) || !Number.isInteger(i.price) || i.price < 0) throw new Error('menu.json: bad item ' + JSON.stringify(i));
    ids.add(i.id);
  }
  for (const r of rewards.rewards) {
    if (!rewards.games[r.game] || !['discount', 'item'].includes(r.type)) throw new Error('rewards.json: bad reward ' + r.id);
  }
  if (!Number.isInteger(tablesCfg.count) || tablesCfg.count < 1 || tablesCfg.count > 500) throw new Error('tables.json: bad count');
}());

const limits = {};
if (env.SEAT_PLAY_GAP_MS !== undefined) limits.seatPlayGapMs = Number(env.SEAT_PLAY_GAP_MS);
if (env.SEAT_PLAY_MAX) limits.seatPlayMax = Number(env.SEAT_PLAY_MAX);
if (env.SEAT_OPEN_MAX) limits.seatOpenMax = Number(env.SEAT_OPEN_MAX);
const storeOpts = {};
if (env.DB_MAX_BYTES) storeOpts.maxDbBytes = Number(env.DB_MAX_BYTES);
if (env.BACKUP_SKIP_BYTES) storeOpts.backupSkipBytes = Number(env.BACKUP_SKIP_BYTES);
const store = createStore({ dataDir: DATA_DIR, menu, rewards, tableCount: tablesCfg.count, limits, ...storeOpts });
const tokenToTable = new Map(store.tokens().map((t) => [t.token, t.id]));

// ---------- small helpers ----------
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const pinOk = (pin) => typeof pin === 'string' && crypto.timingSafeEqual(sha(pin), sha(STAFF_PIN));
// Cookie header -> { name: [values...] }: duplicate names (e.g. same cookie set for Path=/ and Path=/booth) are all kept.
const parseCookies = (req) => {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) (out[part.slice(0, i).trim()] ||= []).push(part.slice(i + 1).trim());
  }
  return out;
};
const DEVICE_RE = /^[a-f0-9]{32}$/;
const cookieDevice = (req) => (parseCookies(req).booth_d || []).find((v) => DEVICE_RE.test(v));
const addCookie = (res, c) => {
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, c) : [c]);
};
function ensureDevice(c) {
  const have = cookieDevice(c.req);
  if (have) return have;
  const id = crypto.randomBytes(16).toString('hex');
  addCookie(c.res, `booth_d=${id}; ${COOKIE_FLAGS}; Max-Age=${3 * 86400}`);
  return id;
}
const staffSession = (req) => (parseCookies(req).booth_s || []).find((id) => store.validSession(id)) || null;
function sameOrigin(req) {
  const sfs = req.headers['sec-fetch-site'];
  if (sfs) return sfs === 'same-origin' || sfs === 'none';
  const o = req.headers.origin;
  if (!o) return true; // non-browser client
  if (PUBLIC_ORIGIN && o === PUBLIC_ORIGIN) return true;
  try { return new URL(o).host === req.headers.host; } catch { return false; }
}

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function sendText(res, status, type, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), ...extra });
  res.end(body);
}
const htmlShell = (title, body) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:24px;line-height:1.6}</style></head><body><div>${body}</div></body></html>`;
const notFoundPage = (res, msg = '페이지를 찾을 수 없습니다.') => sendText(res, 404, 'text/html; charset=utf-8', htmlShell('404', `<h2>${msg}</h2><p>테이블에 붙은 QR 코드를 다시 찍어 주세요.</p>`), { 'Cache-Control': 'no-store' });

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.webmanifest': 'application/manifest+json',
};
const SUBST = new Set(['.html', '.js', '.css']);

// ponytail: reads the file on every request (no cache/gzip); nginx can gzip, and files are small.
function serveFile(c, full, cacheControl) {
  const ext = path.extname(full).toLowerCase();
  let buf;
  try { if (!fs.statSync(full).isFile()) throw new Error('not file'); buf = fs.readFileSync(full); } catch { return notFoundPage(c.res); }
  if (SUBST.has(ext)) buf = Buffer.from(buf.toString('utf8').replaceAll('__BASE__', BASE));
  c.res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': buf.length, 'Cache-Control': cacheControl });
  c.res.end(buf);
}
const servePage = (c, file) => serveFile(c, path.join(PUBLIC, file), 'no-cache');

function serveStatic(c) {
  let rel;
  try { rel = decodeURIComponent(c.m[1]); } catch { return notFoundPage(c.res); }
  if (rel.includes('\0') || rel.split(/[\\/]/).some((s) => s === '..' || s.startsWith('.'))) return notFoundPage(c.res);
  const ext = path.extname(rel).toLowerCase();
  const full = path.join(PUBLIC, rel);
  if (!full.startsWith(PUBLIC + path.sep) || !MIME[ext]) return notFoundPage(c.res);
  return serveFile(c, full, 'public, max-age=60');
}

// ---------- SSE ----------
const conns = new Set();
const dirty = new Set();
let flushTimer = null;
// State events are full snapshots, so a slow reader only ever needs the latest one: while the socket needs a drain
// the state is marked pending and skipped, and the 'drain' handler sends the then-current snapshot.
function sseWrite(c, event, data) {
  if (c.res.writableNeedDrain) { if (event === 'state') c.pending = true; return; }
  c.res.write(`event: ${event}\ndata: ${data}\n\n`);
  if (!c.priv && c.res.writableLength > SSE_BACKLOG_MAX) { conns.delete(c); c.res.destroy(); }
}
function touch(...keys) {
  for (const k of keys) dirty.add(k);
  flushTimer ||= setTimeout(flush, 120);
}
const touchTable = (id) => touch('staff', 'kitchen', 'board', 'g:' + id);
const touchAll = () => touch('staff', 'kitchen', 'board', 'g:*', 'w:*');
function flush() {
  flushTimer = null;
  const keys = [...dirty];
  dirty.clear();
  const shared = new Map();
  for (const c of conns) {
    if (!keys.some((k) => k === c.chan || (k === 'g:*' && c.chan[0] === 'g') || (k === 'w:*' && c.chan[0] === 'w'))) continue;
    try {
      let s;
      if (c.shared) { if (!shared.has(c.chan)) shared.set(c.chan, JSON.stringify(c.snap())); s = shared.get(c.chan); } else s = JSON.stringify(c.snap());
      if (s !== c.last) { c.last = s; sseWrite(c, 'state', s); }
    } catch (e) { console.error('sse snapshot failed', e.message); }
  }
}
function hint(chan, event, obj) {
  const s = JSON.stringify(obj);
  for (const c of conns) if (c.chan === chan) sseWrite(c, event, s);
}
// Limits close the OLDEST stream instead of rejecting: EventSource gives up for good on a non-200, but silently reconnects after a close.
function evictOldest(pred, max) {
  const m = [...conns].filter(pred);
  while (m.length >= max) { const o = m.shift(); conns.delete(o); o.res.end(); }
}
function sse(c, chan, snap, shared = false) {
  const cls = chan[0] === 'g' || chan[0] === 'w' ? chan[0] : chan; // g, w, board, staff, kitchen
  const priv = cls === 'staff' || cls === 'kitchen';
  if (!priv && [...conns].filter((x) => !x.priv).length >= SSE_PUBLIC_MAX) throw new HttpError(503, 'busy', '접속자가 많습니다. 잠시 후 다시 시도해 주세요.');
  const first = JSON.stringify(snap());
  let bucket = null;
  if (priv) evictOldest((x) => x.priv, SSE_STAFF_MAX);
  else {
    const bd = c.device || cookieDevice(c.req);
    bucket = bd ? 'd:' + bd : 'anon:' + cls;
    evictOldest((x) => x.bucket === bucket, SSE_PER_DEVICE);
    if (cls === 'g') evictOldest((x) => x.chan === chan, SSE_PER_TABLE);
    else evictOldest((x) => x.cls === cls, cls === 'board' ? SSE_BOARD_MAX : SSE_WAIT_MAX);
  }
  c.req.socket.setTimeout(0);
  c.req.socket.setNoDelay(true);
  c.res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  c.res.write('retry: 3000\n\n');
  const conn = { res: c.res, chan, cls, priv, bucket, snap, shared, last: first };
  conns.add(conn);
  c.req.on('close', () => conns.delete(conn));
  c.res.on('drain', () => {
    if (!conn.pending || !conns.has(conn)) return;
    conn.pending = false;
    try { const cur = JSON.stringify(conn.snap()); conn.last = cur; sseWrite(conn, 'state', cur); } catch (e) { console.error('sse drain snapshot failed', e.message); }
  });
  sseWrite(conn, 'state', first);
}
const heartbeat = setInterval(() => {
  for (const c of conns) if (!c.res.writableNeedDrain) c.res.write(': hb\n\n');
  touch('staff', 'board'); // refresh minutesSeated / hour rollover
}, 20000);
heartbeat.unref();

// ---------- routing ----------
const routes = [];
const route = (method, re, fn, opts = {}) => routes.push({ method, re: new RegExp(`^${re}$`), fn, staff: !!opts.staff });
const int = (s) => Number(s);
const need = (cond, code, msg) => { if (!cond) throw new HttpError(400, code, msg); };
function guestCtx(c) {
  const id = tokenToTable.get(c.m[1]);
  if (!id) throw new HttpError(404, 'no_table', '알 수 없는 테이블입니다. QR 코드를 다시 찍어 주세요.');
  c.tableId = id;
  c.device = ensureDevice(c);
  return c;
}
const G = '/api/t/([A-Za-z0-9_-]{8,64})';

// pages
const landing = (c) => sendText(c.res, 200, 'text/html; charset=utf-8', htmlShell('주점 부스', '<h2>주점 부스</h2><p>테이블에 붙어 있는 QR 코드를 찍어 주세요.</p><p>입구에서 대기 중이라면 대기 QR을 찍어 주세요.</p>'), { 'Cache-Control': 'no-cache' });
route('GET', '/', landing);
route('GET', '/t/([A-Za-z0-9_-]{8,64})', (c) => {
  if (!tokenToTable.has(c.m[1])) return notFoundPage(c.res, '알 수 없는 테이블 QR입니다.');
  ensureDevice(c);
  return servePage(c, 'guest.html');
});
route('GET', '/wait', (c) => { ensureDevice(c); return servePage(c, 'wait.html'); });
route('GET', '/staff', (c) => servePage(c, 'staff.html'));
route('GET', '/staff/qr', (c) => servePage(c, 'qr.html'));
route('GET', '/kitchen', (c) => servePage(c, 'kitchen.html'));
route('GET', '/board', (c) => servePage(c, 'board.html'));
route('GET', '/static/(.+)', serveStatic);

// public api
route('GET', '/api/health', () => ({ ok: true, time: Date.now() }));
route('GET', '/api/menu', () => ({ ...store.menuView(), orderingOpen: store.orderingOpen() }));
route('GET', '/api/board', () => store.boardState());
route('GET', '/api/board/events', (c) => sse(c, 'board', () => store.boardState(), true));

// guest api
const guestSnap = (c) => ({ ...store.guestState(c.tableId, c.device), pay: PAY });
route('GET', G, (c) => guestSnap(guestCtx(c)));
route('GET', G + '/events', (c) => { guestCtx(c); sse(c, 'g:' + c.tableId, () => guestSnap(c)); });
route('POST', G + '/orders', (c) => {
  guestCtx(c);
  const r = store.createOrder(c.tableId, c.body);
  if (!r.duplicate) {
    c.status = 201;
    touchTable(c.tableId);
    hint('staff', 'new_order', { id: r.order.id, table: c.tableId });
  }
  return r;
});
route('POST', G + '/orders/(\\d{1,9})/cancel', (c) => {
  guestCtx(c);
  const order = store.guestCancel(c.tableId, int(c.m[2]));
  touchTable(c.tableId);
  return { order };
});
route('POST', G + '/nick', (c) => {
  guestCtx(c);
  // a device cookie minted by this very request does not count: the page loads the snapshot first (which sets it)
  if (!cookieDevice(c.req)) throw new HttpError(400, 'no_device', '페이지를 새로고침한 뒤 다시 시도해 주세요.');
  const nick = store.setNick(c.device, c.tableId, c.body.nick); touchTable(c.tableId); return { nick };
});
route('POST', G + '/plays/start', (c) => store.startPlay(guestCtx(c).tableId, c.device, c.body.game));
route('POST', G + '/plays/finish', (c) => { const r = store.finishPlay(guestCtx(c).tableId, c.device, c.body.playId, c.body.score); touchTable(c.tableId); return r; });
route('POST', G + '/calls', (c) => {
  const r = store.addCall(guestCtx(c).tableId, c.body.type);
  if (!r.duplicate) { touchTable(c.tableId); hint('staff', 'new_call', { id: r.call.id, table: c.tableId, type: r.call.type }); }
  return r;
});

// waitlist (public)
route('GET', '/api/wait/info', () => store.waitInfo());
route('POST', '/api/wait', (c) => {
  const r = store.addWait(ensureDevice(c), c.body.nick, c.body.size);
  c.status = 201;
  touch('staff', 'w:*');
  hint('staff', 'new_wait', { id: r.id });
  return r;
});
const waitSecret = (c) => c.url.searchParams.get('secret') || '';
route('GET', '/api/wait/(\\d{1,9})', (c) => store.waitStatus(int(c.m[1]), waitSecret(c)));
route('GET', '/api/wait/(\\d{1,9})/events', (c) => { const id = int(c.m[1]); const secret = waitSecret(c); sse(c, 'w:' + id, () => store.waitStatus(id, secret)); });
route('POST', '/api/wait/(\\d{1,9})/cancel', (c) => { store.waitCancel(int(c.m[1]), c.body.secret); touch('staff', 'w:*'); return { ok: true }; });

// staff auth (global brute-force lockout; the client IP is not trustworthy behind the proxy)
const lock = { fails: 0, until: 0 };
const locked = (ms) => new HttpError(429, 'locked', '로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.', { retryAfterSec: Math.ceil(ms / 1000) });
route('POST', '/api/staff/login', (c) => {
  // booth_k = long-lived key set after a successful login: that device is exempt from the global lock but still must know the PIN,
  // and 5 consecutive wrong PINs from the same key revoke it
  const key = (parseCookies(c.req).booth_k || []).find((k) => store.validLoginKey(k));
  if (lock.until) {
    const wait = lock.until - Date.now();
    if (wait > 0 && !key) { c.res.setHeader('Retry-After', Math.ceil(wait / 1000)); throw locked(wait); }
    if (wait <= 0) { lock.until = 0; lock.fails = 0; } // lock expired: start counting again
  }
  if (pinOk(c.body.pin)) {
    if (!key) lock.fails = 0;
    else store.loginKeyOk(key);
    addCookie(c.res, `booth_s=${store.newSession(SESSION_MS)}; ${COOKIE_FLAGS}; Max-Age=${SESSION_MS / 1000}`);
    if (!key) addCookie(c.res, `booth_k=${store.newLoginKey()}; ${COOKIE_FLAGS}; Max-Age=${KEY_MAX_AGE_S}`);
    return { ok: true };
  }
  if (key) {
    const fails = store.loginKeyFail(key);
    if (fails >= 5) addCookie(c.res, `booth_k=; ${COOKIE_FLAGS}; Max-Age=0`);
    throw new HttpError(401, 'bad_pin', 'PIN이 올바르지 않습니다.', { attemptsLeft: Math.max(0, 5 - fails) });
  }
  lock.fails++;
  if (lock.fails >= 5) { // flat lock, no escalation: a guest hammering the form can only deny new (key-less) logins one lock at a time
    lock.until = Date.now() + LOCKOUT_MS;
    c.res.setHeader('Retry-After', Math.ceil(LOCKOUT_MS / 1000));
    throw locked(LOCKOUT_MS);
  }
  throw new HttpError(401, 'bad_pin', 'PIN이 올바르지 않습니다.', { attemptsLeft: 5 - lock.fails });
});
route('POST', '/api/staff/logout', (c) => {
  for (const id of parseCookies(c.req).booth_s || []) store.endSession(id);
  addCookie(c.res, `booth_s=; ${COOKIE_FLAGS}; Max-Age=0`); // expires at the configured Path
  return { ok: true };
});
route('GET', '/api/staff/me', () => ({ ok: true }), { staff: true });

// staff api
const S = { staff: true };
route('GET', '/api/staff/state', () => store.staffState(), S);
route('GET', '/api/staff/events', (c) => sse(c, 'staff', () => store.staffState(), true), S);
route('GET', '/api/staff/tables', () => ({
  tables: store.tokens().map((t) => ({ number: t.id, token: t.token, url: `${PUBLIC_ORIGIN}${BASE}/t/${t.token}` })),
  waitUrl: `${PUBLIC_ORIGIN}${BASE}/wait`,
  origin: PUBLIC_ORIGIN, base: BASE,
}), S);
route('POST', '/api/staff/orders/(\\d{1,9})/status', (c) => {
  const order = store.setStatus(int(c.m[1]), c.body.status);
  touchTable(order.table);
  hint('g:' + order.table, 'order_status', { id: order.id, status: order.status });
  if (order.status === 'cooking') hint('kitchen', 'new_cooking', { id: order.id, table: order.table });
  return { order };
}, S);
route('POST', '/api/staff/orders/(\\d{1,9})/paid', (c) => { const order = store.setPaid(int(c.m[1]), c.body.paid); touchTable(order.table); return { order }; }, S);
route('POST', '/api/staff/menu/([A-Za-z0-9_-]{1,40})/soldout', (c) => {
  need(typeof c.body.soldOut === 'boolean', 'bad_soldout', 'soldOut은 true/false여야 합니다.');
  store.setSoldOut(c.m[1], c.body.soldOut);
  touchAll();
  return { ok: true, menu: store.menuView() };
}, S);
route('POST', '/api/staff/ordering', (c) => { need(typeof c.body.open === 'boolean', 'bad_open', 'open은 true/false여야 합니다.'); store.setOrdering(c.body.open); touchAll(); return { ok: true, orderingOpen: c.body.open }; }, S);
route('POST', '/api/staff/coupons/redeem', (c) => { const coupon = store.redeem(c.body.code); touchTable(coupon.table); return { coupon }; }, S);
route('POST', '/api/staff/tables/move', (c) => {
  const r = store.moveTable(c.body.from, c.body.to);
  touchAll();
  hint('g:' + c.body.from, 'cleared', { seat: r.fromSeat });
  return r;
}, S);
route('POST', '/api/staff/waitlist/open', (c) => {
  need(typeof c.body.open === 'boolean', 'bad_open', 'open은 true/false여야 합니다.');
  store.setWaitOpen(c.body.open);
  touch('staff', 'w:*');
  return { ok: true, waitOpen: c.body.open };
}, S);
route('POST', '/api/staff/waitlist/clear', () => { const cancelled = store.clearWait(); touch('staff', 'w:*'); return { ok: true, cancelled }; }, S);
route('POST', '/api/staff/tables/(\\d{1,4})/clear', (c) => {
  const n = int(c.m[1]);
  const seat = store.clearTable(n, c.body.force === true);
  touchTable(n);
  hint('g:' + n, 'cleared', { seat });
  return { ok: true, table: n, seat };
}, S);
route('POST', '/api/staff/calls/(\\d{1,9})/resolve', (c) => { store.resolveCall(int(c.m[1])); touch('staff', 'g:*'); return { ok: true }; }, S);
route('POST', '/api/staff/wait/(\\d{1,9})/(call|seat|cancel)', (c) => { store.waitAction(int(c.m[1]), c.m[2]); touch('staff', 'w:*'); return { ok: true }; }, S);
route('POST', '/api/staff/award-hour', (c) => { const r = store.awardHour(c.body.hourStart); touchTable(r.table); return r; }, S);
route('POST', '/api/staff/rewards/([A-Za-z0-9_-]{1,40})/stock', (c) => { store.setStock(c.m[1], c.body.stock); touch('staff', 'g:*'); return { ok: true }; }, S);
route('GET', '/api/staff/sales', () => store.sales(), S);
route('GET', '/api/staff/sales\\.csv', (c) => sendText(c.res, 200, 'text/csv; charset=utf-8', store.salesCsv(), { 'Content-Disposition': 'attachment; filename="booth-sales.csv"', 'Cache-Control': 'no-store' }), S);
route('POST', '/api/staff/reset', async (c) => {
  if (c.body.confirm !== '초기화') throw new HttpError(400, 'confirm_required', '확인 문구 "초기화"를 입력해 주세요.');
  await backupNow(); // wait for any in-flight copy, then take our own safety copy of the data about to be wiped
  store.reset();
  touchAll();
  return { ok: true };
}, S);
route('GET', '/api/kitchen', () => store.kitchenState(), S);
route('GET', '/api/kitchen/events', (c) => sse(c, 'kitchen', () => store.kitchenState(), true), S);

// ---------- request handling ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length'] || 0);
    if (len > BODY_LIMIT) return reject(new HttpError(413, 'too_large', '요청이 너무 큽니다.'));
    const chunks = [];
    let n = 0;
    req.on('data', (d) => {
      n += d.length;
      if (n > BODY_LIMIT) { chunks.length = 0; reject(new HttpError(413, 'too_large', '요청이 너무 큽니다.')); req.removeAllListeners('data'); req.resume(); } else chunks.push(d);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handle(req, res) {
  for (const [k, v] of Object.entries(SEC_HEADERS)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://localhost');
  let p = url.pathname;
  if (BASE) {
    if (p !== BASE && !p.startsWith(BASE + '/')) return notFoundPage(res);
    p = p.slice(BASE.length) || '/';
  }
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  let r; let m;
  for (const x of routes) if (x.method === method && (m = x.re.exec(p))) { r = x; break; }
  if (!r) return p.startsWith('/api/') ? sendJson(res, 404, { error: 'not_found', message: '없는 API입니다.' }) : notFoundPage(res);
  const c = { req, res, url, m, status: 200, body: {} };
  if (r.staff && !staffSession(req)) throw new HttpError(401, 'unauthorized', '직원 로그인이 필요합니다.');
  if (method === 'POST') {
    if (p.startsWith('/api/staff') && !sameOrigin(req)) throw new HttpError(403, 'bad_origin', '허용되지 않은 요청 출처입니다.');
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'unsupported_media_type', 'Content-Type은 application/json이어야 합니다.');
    const raw = await readBody(req);
    if (raw.length) {
      try { c.body = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'bad_json', 'JSON 형식이 올바르지 않습니다.'); }
      if (!c.body || typeof c.body !== 'object' || Array.isArray(c.body)) throw new HttpError(400, 'bad_json', 'JSON 객체여야 합니다.');
    }
  }
  const out = await r.fn(c);
  if (!res.headersSent) sendJson(res, c.status, out ?? { ok: true });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (res.headersSent) { res.destroy(); return; }
    if (e instanceof HttpError) {
      if (e.status === 413) { res.setHeader('Connection', 'close'); res.on('finish', () => req.destroy()); }
      return sendJson(res, e.status, { error: e.code, message: e.message, ...e.extra });
    }
    if (/database or disk is full/i.test(e.message || '') || e.errcode === 13) return sendJson(res, 503, { error: 'storage_full', message: '저장 공간이 가득 찼습니다. 직원에게 문의해 주세요.' });
    console.error(e);
    sendJson(res, 500, { error: 'internal', message: '서버 오류가 발생했습니다.' });
  });
});
server.keepAliveTimeout = 65000;

// ---------- backup + shutdown ----------
let backupP = null;
function runBackup(periodic = false) {
  backupP ||= (async () => {
    try { await store.backup(path.join(DATA_DIR, 'backup'), 12, { periodic }); } catch (e) { console.error('backup failed', e.message); } finally { backupP = null; }
  })();
  return backupP;
}
async function backupNow() { if (backupP) await backupP; return runBackup(); }
const backupTimer = setInterval(() => runBackup(true), BACKUP_MS);
backupTimer.unref();

let closing = false;
async function shutdown(sig) {
  if (closing) return;
  closing = true;
  console.log(`${sig} received, shutting down`);
  setTimeout(() => process.exit(1), 8000).unref();
  server.close();
  for (const c of conns) c.res.end();
  server.closeIdleConnections();
  await backupNow();
  server.closeAllConnections();
  store.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));

server.listen(PORT, HOST, () => {
  const a = server.address();
  console.log(`booth listening on ${a.address}:${a.port} base="${BASE}" data=${DATA_DIR}`);
});

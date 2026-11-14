'use strict';
// HTTP API + SSE + static files. Node built-ins only. See API.md for the contract.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createStore, HttpError } = require('./db');

const env = process.env;
// numeric env vars: unset/empty = default; anything else must be a plain non-negative integer >= min or the server refuses to start
function envInt(name, def, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const n = /^\d{1,15}$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) {
    console.error(`${name} must be an integer between ${min} and ${max} (got "${raw}"). Refusing to start.`);
    process.exit(1);
  }
  return n;
}
let BASE = (env.BASE_PATH || '').trim().replace(/\/+$/, '');
if (BASE && !BASE.startsWith('/')) BASE = '/' + BASE;
const PORT = envInt('PORT', 8787, 0, 65535);
const HOST = env.HOST || '127.0.0.1';
const CONFIG_DIR = env.CONFIG_DIR || __dirname;
const PUBLIC = path.resolve(env.PUBLIC_DIR || path.join(__dirname, 'public'));
const DATA_DIR = path.resolve(env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_ORIGIN = (env.PUBLIC_ORIGIN || '').replace(/\/+$/, '');
const COOKIE_PATH = BASE || '/';
const COOKIE_FLAGS = `Path=${COOKIE_PATH}; HttpOnly; SameSite=Lax${env.COOKIE_SECURE === '1' ? '; Secure' : ''}`;
const PAY = { bank: env.PAY_BANK || '', account: env.PAY_ACCOUNT || '', holder: env.PAY_HOLDER || '' };
const BACKUP_MS = envInt('BACKUP_INTERVAL_MS', 10 * 60 * 1000);
const BODY_LIMIT = 16 * 1024;
const SESSION_MS = envInt('SESSION_HOURS', 72, 1, 24 * 365) * 3600 * 1000;
const KEY_MAX_AGE_S = 30 * 86400;
// stream caps are sized for a booth of a few dozen guests, not for the internet
const SSE_PUBLIC_MAX = envInt('SSE_PUBLIC_MAX', 300); // guest + board + wait streams
const SSE_STAFF_MAX = 100; // staff + kitchen streams have their own pool
const SSE_PER_DEVICE = 5;
const SSE_PER_TABLE = 12;
const SSE_BOARD_MAX = 20;
const SSE_WAIT_MAX = 60;
const SSE_BACKLOG_MAX = 64 * 1024; // public streams whose unsent backlog exceeds this are dropped
const LOCKOUT_MS = envInt('LOCKOUT_MS', 60000);
const COMS_ME_URL = (env.COMS_ME_URL || '').trim(); // unset = member discount feature off (no outbound requests at all)

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
let menu = null;
try { menu = readJson('menu.json'); } catch (e) { console.error(`menu.json could not be read (${e.message}); an empty menu will not be seeded from it`); }
const rewards = readJson('rewards.json');
const tablesCfg = readJson('tables.json');
(function validateConfig() {
  if (!rewards.games || typeof rewards.games !== 'object') throw new Error('rewards.json: "games" is required');
  for (const [name, g] of Object.entries(rewards.games)) {
    if (!Number.isInteger(g.maxScore) || g.maxScore < 1 || !Number.isInteger(g.minDurationMs) || g.minDurationMs < 0) throw new Error('rewards.json: bad game ' + name);
  }
  if (!Number.isInteger(tablesCfg.count) || tablesCfg.count < 1 || tablesCfg.count > 50) throw new Error('tables.json: bad count');
}());

const limits = {
  seatPlayGapMs: envInt('SEAT_PLAY_GAP_MS', 1000, 0),
  seatPlayMax: envInt('SEAT_PLAY_MAX', 300),
  seatOpenMax: envInt('SEAT_OPEN_MAX', 20),
  memberOrderMax: envInt('MEMBER_ORDER_MAX', 20),
};
const PHOTO_MAX = 400 * 1024;
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const storeOpts = { waitCallTimeoutMin: envInt('WAIT_CALL_TIMEOUT_MIN', 5, 1, 30), photoMaxBytes: envInt('PHOTO_STORAGE_MAX', 40 * 1024 * 1024), maxDbBytes: envInt('DB_MAX_BYTES', 256 * 1024 * 1024), backupSkipBytes: envInt('BACKUP_SKIP_BYTES', 128 * 1024 * 1024) };
const store = createStore({ dataDir: DATA_DIR, menu, rewards, tableCount: tablesCfg.count, payEnv: { bank: PAY.bank, account: PAY.account, holder: PAY.holder }, limits, memberEnabled: !!COMS_ME_URL, ...storeOpts });
const DEVICE_KEY = store.deviceSecret();
let tokenToTable = new Map(store.tokens().map((t) => [t.token, t.id]));
const refreshTokens = () => { tokenToTable = new Map(store.tokens().map((t) => [t.token, t.id])); };

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
// booth_d = <32 hex id>.<first 32 hex of HMAC-SHA256(secret, id)>: only ids this server issued are ever counted as devices
const deviceMac = (id) => crypto.createHmac('sha256', DEVICE_KEY).update(id).digest('hex').slice(0, 32);
function cookieDevice(req) {
  for (const v of parseCookies(req).booth_d || []) {
    const m = /^([a-f0-9]{32})\.([a-f0-9]{32})$/.exec(v);
    if (m && crypto.timingSafeEqual(Buffer.from(m[2]), Buffer.from(deviceMac(m[1])))) return m[1];
  }
  return undefined;
}
const addCookie = (res, c) => {
  const prev = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', prev ? [].concat(prev, c) : [c]);
};
function ensureDevice(c) {
  const have = cookieDevice(c.req);
  if (have) return have;
  const id = crypto.randomBytes(16).toString('hex');
  addCookie(c.res, `booth_d=${id}.${deviceMac(id)}; ${COOKIE_FLAGS}; Max-Age=${3 * 86400}`);
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
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
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
const closeGuestStreams = (keep) => { for (const c of [...conns]) if (c.chan[0] === 'g' && !keep(Number(c.chan.slice(2)))) { conns.delete(c); c.res.end(); } };
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

// ---------- COMS member verification ----------
// The booth shares the club site's origin, so the browser sends its HttpOnly `token` cookie. We forward ONLY that cookie to COMS_ME_URL
// (GET, 2 s, no redirects, 16 KB cap). Member = 200 + integer id > 0 + known role. Everything else (and every failure) = not a member.
// The token is never logged or stored; results are cached by sha256(token) for 60 s.
const TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const ROLES = new Set(['ASSOCIATE', 'USER', 'OFFICER', 'VICE_PRESIDENT', 'ADMIN']);
const MEMBER_CACHE_MS = 60000;
const MEMBER_CACHE_MAX = envInt('MEMBER_CACHE_MAX', 500); // per map: members and non-members are cached separately so a token spray cannot evict members
const MEMBER_MAX_INFLIGHT = 20;
const MEMBER_MAX_PER_SEC = 60; // global outbound cap; a single device can use at most MEMBER_PER_DEVICE_MIN per minute, so it cannot exhaust this
const MEMBER_PER_DEVICE_MIN = 6; // uncached lookups per booth_d per minute
const MEMBER_DEVICES_MAX = 5000;
const memberPos = new Map(); // sha256(token) -> { at, id }   (definitive: 200 member)
const memberNeg = new Map(); // sha256(token) -> { at }       (definitive: 401 / 403 only)
const memberPending = new Map(); // same key -> Promise (identical concurrent lookups share one request)
const memberDevices = new Map(); // booth_d -> [timestamps of uncached lookups]
const memberCalls = [];
let memberInflight = 0;
const putCache = (map, key, val) => {
  map.delete(key);
  map.set(key, val);
  while (map.size > MEMBER_CACHE_MAX) map.delete(map.keys().next().value);
};

// -> { id, cache }. cache=true only for definitive answers (200 member, 401, 403); everything else is "not a member for this request only".
async function fetchComsMember(token) {
  const res = await fetch(COMS_ME_URL, { method: 'GET', headers: { cookie: `token=${token}` }, redirect: 'manual', signal: AbortSignal.timeout(2000) });
  if (res.status === 401 || res.status === 403) { await res.body?.cancel().catch(() => {}); return { id: null, cache: true }; }
  if (res.status !== 200 || Number(res.headers.get('content-length') || 0) > 16384) { await res.body?.cancel().catch(() => {}); return { id: null, cache: false }; }
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > 16384) { await reader.cancel().catch(() => {}); return { id: null, cache: false }; }
    chunks.push(value);
  }
  let j;
  try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return { id: null, cache: false }; }
  if (j && Number.isInteger(j.id) && j.id > 0 && ROLES.has(j.role)) return { id: j.id, role: j.role, cache: true };
  return { id: null, cache: false };
}
// resolves to { id, role } (club member id and role; neither is ever sent to a client) or null. Never throws.
// Requires an existing valid booth_d (a cookie minted by this very request does not count): no device, no lookup.
async function verifyMember(req) {
  if (!COMS_ME_URL) return null;
  const token = (parseCookies(req).token || []).find((v) => v.length <= 4096 && TOKEN_RE.test(v));
  if (!token) return null;
  const dev = cookieDevice(req);
  if (!dev) return null;
  const key = crypto.createHash('sha256').update(token).digest('hex');
  const t = Date.now();
  const pos = memberPos.get(key);
  if (pos && t - pos.at < MEMBER_CACHE_MS) return pos.m;
  const neg = memberNeg.get(key);
  if (neg && t - neg.at < MEMBER_CACHE_MS) return null;
  if (memberPending.has(key)) return memberPending.get(key);
  // per-device cap first, so one browser spraying tokens only burns its own budget
  const mine = (memberDevices.get(dev) || []).filter((x) => x > t - 60000);
  if (mine.length >= MEMBER_PER_DEVICE_MIN) return null;
  while (memberCalls.length && memberCalls[0] < t - 1000) memberCalls.shift();
  if (memberInflight >= MEMBER_MAX_INFLIGHT || memberCalls.length >= MEMBER_MAX_PER_SEC) return null; // not cached
  mine.push(t);
  memberDevices.delete(dev);
  memberDevices.set(dev, mine);
  while (memberDevices.size > MEMBER_DEVICES_MAX) memberDevices.delete(memberDevices.keys().next().value);
  memberInflight++;
  memberCalls.push(t);
  const p = fetchComsMember(token).catch(() => ({ id: null, cache: false })).then((r) => {
    const m = r.id != null ? { id: r.id, role: r.role } : null;
    if (r.cache) { if (m) putCache(memberPos, key, { at: Date.now(), m }); else putCache(memberNeg, key, { at: Date.now() }); }
    return m;
  }).finally(() => { memberInflight--; memberPending.delete(key); });
  memberPending.set(key, p);
  return p;
}

// ---------- routing ----------
const routes = [];
const route = (method, re, fn, opts = {}) => routes.push({ method, re: new RegExp(`^${re}$`), fn, staff: !!opts.staff, raw: !!opts.raw });
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
const builtinLanding = (c) => sendText(c.res, 200, 'text/html; charset=utf-8', htmlShell('COMHERE', '<h2>COMHERE</h2><p>테이블에 붙어 있는 QR 코드를 찍어 주세요.</p><p>입구에서 대기 중이라면 대기 QR을 찍어 주세요.</p>'), { 'Cache-Control': 'no-cache' });
const landing = (c) => (fs.existsSync(path.join(PUBLIC, 'landing.html')) ? servePage(c, 'landing.html') : builtinLanding(c)); // public/landing.html overrides the built-in page
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
// the booth service worker: scope is BASE/ (the worker itself does no caching)
route('GET', '/sw.js', (c) => {
  let buf;
  try { buf = Buffer.from(fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8').replaceAll('__BASE__', BASE)); } catch { return notFoundPage(c.res); }
  c.res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': `${BASE}/`, 'Content-Length': buf.length });
  c.res.end(buf);
});

// public api
route('GET', '/api/health', () => ({ ok: true, time: Date.now() }));
route('GET', '/api/menu', () => ({ ...store.menuView(), orderingOpen: store.orderingOpen() }));
route('GET', '/api/board', () => store.boardState());
route('GET', '/api/board/events', (c) => sse(c, 'board', () => store.boardState(), true));

// guest api
const guestSnap = (c) => store.guestState(c.tableId, c.device);
route('GET', G, (c) => guestSnap(guestCtx(c)));
route('GET', G + '/events', (c) => { guestCtx(c); sse(c, 'g:' + c.tableId, () => guestSnap(c)); });
route('GET', G + '/member', async (c) => {
  guestCtx(c);
  const ms = store.memberSettings();
  const m = ms.enabled ? await verifyMember(c.req) : null; // staff switch off = no lookup at all
  const eligible = !!m && (ms.includeAssociate || m.role !== 'ASSOCIATE'); // only booleans / rule values leave the server
  return { enabled: !!COMS_ME_URL && ms.enabled, member: eligible, mode: ms.mode, pct: ms.pct, amount: ms.amount, minOrder: ms.minOrder, maxDiscount: ms.maxDiscount, stackWithCoupon: ms.stackWithCoupon };
});
route('POST', G + '/orders', async (c) => {
  guestCtx(c);
  const m = store.memberSettings().enabled ? await verifyMember(c.req) : null; // a client-sent "member" field is never read
  const r = store.createOrder(c.tableId, c.body, { memberId: m ? m.id : null, memberRole: m ? m.role : null });
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
route('POST', G + '/orders/(\\d{1,9})/depositor', (c) => {
  guestCtx(c);
  const order = store.setDepositor(c.tableId, int(c.m[2]), c.body.depositor);
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
    store.audit('login', 'staff', key ? 'trusted device' : 'pin', `직원 로그인${key ? ' (저장된 기기)' : ''}`);
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
    store.audit('lockout', 'staff', `login locked for ${Math.ceil(LOCKOUT_MS / 1000)} s after repeated wrong PINs`, `로그인 잠금 · PIN을 여러 번 틀려 ${Math.ceil(LOCKOUT_MS / 1000)}초 동안 막힘`);
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
// Korean sentence for the generic audit rows (field NAMES / booleans only, never values that could be secrets)
const actionKo = (p, b) => {
  const rules = [
    [/^\/api\/staff\/menu\/[^/]+\/soldout$/, () => `메뉴 품절 ${b.soldOut ? '표시' : '해제'}`], [/^\/api\/staff\/menu\/items\/[^/]+\/delete$/, () => '메뉴 삭제'],
    [/^\/api\/staff\/menu\/items\/[^/]+\/photo\/delete$/, () => '메뉴 사진 삭제'], [/^\/api\/staff\/menu\/items\/[^/]+\/photo$/, () => '메뉴 사진 올리기'],
    [/^\/api\/staff\/menu\/reorder$/, () => '메뉴 순서 변경'], [/^\/api\/staff\/menu\/categories$/, () => '카테고리 추가'],
    [/^\/api\/staff\/menu\/categories\/#\/delete$/, () => '카테고리 삭제'], [/^\/api\/staff\/menu\/categories\/#$/, () => '카테고리 이름 변경'],
    [/^\/api\/staff\/rewards$/, () => '보상 추가'], [/^\/api\/staff\/rewards\/[^/]+\/delete$/, () => '보상 삭제'], [/^\/api\/staff\/rewards\/[^/]+\/stock$/, () => '보상 재고 변경'],
    [/^\/api\/staff\/rewards\/[^/]+$/, () => '보상 수정'], [/^\/api\/staff\/hourly-reward$/, () => '시간대 보상 설정 변경'], [/^\/api\/staff\/award-hour$/, () => '시간대 보상 지급'],
    [/^\/api\/staff\/waitlist\/open$/, () => `대기 접수 ${b.open ? '열기' : '닫기'}`], [/^\/api\/staff\/waitlist\/clear$/, () => '대기 명단 비우기'],
    [/^\/api\/staff\/calls\/#\/resolve$/, () => '직원 호출 처리'],
    [/^\/api\/staff\/wait\/#\/call$/, () => '대기 손님 호출'], [/^\/api\/staff\/wait\/#\/seat$/, () => '대기 손님 입장 처리'], [/^\/api\/staff\/wait\/#\/cancel$/, () => '대기 취소'], [/^\/api\/staff\/wait\/#\/recall$/, () => '미입장 손님 다시 호출'],
  ];
  for (const [re, f] of rules) if (re.test(p)) return f();
  return `직원 작업 · ${p}`;
};
const DB_AUDITED = /^\/api\/staff\/(orders\/\d+\/(status|paid|items|service|move)|tables\/(\d+\/(clear|unclear|orders|coupons)|move)|refunds\/\d+\/done|coupons\/(redeem|[A-Za-z0-9]+\/void)|deposits\/(\d+\/(assign|dismiss|attach)|autoconfirm)|deposit-hook\/test|pay|member-discount|notice|reset|day\/close|ordering|tables\/count|tables\/\d+\/rotate|deposit-hook\/rotate|waitlist\/timeout|menu\/items(\/[A-Za-z0-9_-]+)?)$/; // routes whose store method writes its own (richer) audit row
route('GET', '/api/staff/state', () => staffSnap(), S);
route('GET', '/api/staff/events', (c) => sse(c, 'staff', () => staffSnap(), true), S);
route('GET', '/api/staff/tables', () => ({
  tables: store.tokens().map((t) => ({ number: t.id, token: t.token, url: `${PUBLIC_ORIGIN}${BASE}/t/${t.token}` })),
  waitUrl: `${PUBLIC_ORIGIN}${BASE}/wait`,
  origin: PUBLIC_ORIGIN, base: BASE,
}), S);
route('POST', '/api/staff/orders/(\\d{1,9})/status', (c) => {
  const order = store.setStatus(int(c.m[1]), c.body.status, c.body.expectedUpdatedAt);
  touchTable(order.table);
  hint('g:' + order.table, 'order_status', { id: order.id, status: order.status });
  if (order.status === 'cooking') hint('kitchen', 'new_cooking', { id: order.id, table: order.table });
  return { order };
}, S);
route('POST', '/api/staff/orders/(\\d{1,9})/paid', (c) => {
  const go = () => store.setPaid(int(c.m[1]), c.body.paid, { method: c.body.method, amount: c.body.amount, expectedUpdatedAt: c.body.expectedUpdatedAt });
  if (c.body.dryRun === true) return { dryRun: true, order: store.dry(go) }; // preview: runs the real code in a rolled-back transaction
  const order = go(); touchTable(order.table); return { order };
}, S);
route('POST', '/api/staff/menu/([A-Za-z0-9_-]{1,40})/soldout', (c) => {
  need(typeof c.body.soldOut === 'boolean', 'bad_soldout', 'soldOut은 true/false여야 합니다.');
  store.setSoldOut(c.m[1], c.body.soldOut);
  touchAll();
  return { ok: true, menu: store.menuView(true) };
}, S);
// ---- payment settings, deposit notices ----
const hookUrl = () => {
  const secret = store.depositSecret();
  return { secret, path: `${BASE}/api/deposit-hook/${secret}`, url: `${PUBLIC_ORIGIN}${BASE}/api/deposit-hook/${secret}`, header: 'X-Booth-Hook', headerUrl: `${PUBLIC_ORIGIN}${BASE}/api/deposit-hook` };
};
let hookLimitedAt = 0; // staff learn for 5 minutes that the hook hit its rate cap
const staffSnap = () => ({ ...store.staffState(), hookRateLimited: Date.now() - hookLimitedAt < 5 * 60000 });
route('POST', '/api/staff/pay', (c) => { const pay = store.setPay(c.body); touchAll(); return { ok: true, pay }; }, S);
route('GET', '/api/staff/deposits', (c) => {
  const q = (k) => { const v = c.url.searchParams.get(k); return v == null ? null : /^\d{1,12}$/.test(v) ? Number(v) : NaN; };
  const before = q('before'); const limit = q('limit');
  if (Number.isNaN(before) || Number.isNaN(limit)) throw new HttpError(400, 'bad_query', 'before와 limit은 정수여야 합니다.');
  return { ...store.listDeposits({ before, limit: limit ?? undefined }), ...store.depositCounts() };
}, S);
route('POST', '/api/staff/deposits/(\\d{1,9})/assign', (c) => { const r = store.assignDeposit(int(c.m[1]), c.body.orderId, c.body.force, c.body.note); touchTable(r.order.table); return { ok: true, ...r }; }, S);
route('POST', '/api/staff/deposits/(\\d{1,9})/dismiss', (c) => { const notice = store.dismissDeposit(int(c.m[1])); touch('staff'); return { ok: true, notice }; }, S);
route('POST', '/api/staff/deposits/autoconfirm', (c) => { const r = store.setAutoConfirm(c.body); touch('staff'); return { ok: true, ...r }; }, S);
route('POST', '/api/staff/deposits/(\\d{1,9})/attach', (c) => { const r = store.attachDeposit(int(c.m[1]), c.body.orderId, c.body.force, c.body.note); touchTable(r.order.table); return { ok: true, ...r }; }, S);
// "테스트 보내기": the real parser and matcher, but nothing is stored and nothing changes
route('POST', '/api/staff/deposit-hook/test', (c) => {
  if (typeof c.body.text !== 'string' || c.body.text.length > 2048) throw new HttpError(400, 'bad_body', '{ "text": "..." } (최대 2KB) 형식이어야 합니다.');
  return store.previewDeposit(c.body.text);
}, S);
route('GET', '/api/staff/deposit-hook', () => hookUrl(), S);
route('POST', '/api/staff/deposit-hook/rotate', () => { store.rotateDepositSecret(); return { ok: true, ...hookUrl() }; }, S);
// the phone automation posts bank SMS text here: no session, no same-origin check; the secret in the path is the credential
const hookTimes = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const badTimes = []; // attempts with a wrong secret have their own small budget, separate from the real forwarder's
let badWaiting = 0;
const TEST_STATS_FILE = process.env.BOOTH_TEST_STATS_FILE || '';
const badStats = { badDelayed: 0, badImmediate: 0 };
async function depositHook(c, secret) {
  if (!store.checkDepositSecret(secret)) {
    const now = Date.now();
    while (badTimes.length && badTimes[0] < now - 60000) badTimes.shift();
    badTimes.push(now);
    const delayed = badWaiting < 20 && badTimes.length <= 20;
    if (TEST_STATS_FILE) { // test hook only (never served over HTTP): counts delayed vs immediate answers so tests need no wall-clock thresholds
      badStats[delayed ? 'badDelayed' : 'badImmediate']++;
      try { fs.writeFileSync(TEST_STATS_FILE, JSON.stringify(badStats)); } catch { /* test hook is best-effort */ }
    }
    if (delayed) { badWaiting++; try { await sleep(300); } finally { badWaiting--; } } // over the budget: answered at once, no idle socket
    throw new HttpError(404, 'not_found', '없는 API입니다.');
  }
  const t = Date.now();
  while (hookTimes.length && hookTimes[0] < t - 60000) hookTimes.shift();
  if (hookTimes.length >= 60) { hookLimitedAt = t; touch('staff'); throw new HttpError(429, 'rate_limited', '알림이 너무 많습니다.'); }
  const type = (c.req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json' && type !== 'text/plain') throw new HttpError(415, 'unsupported_media_type', 'Content-Type은 application/json 또는 text/plain 이어야 합니다.');
  const raw = (await readBody(c.req, 2048)).toString('utf8');
  let text = raw;
  if (type === 'application/json') {
    let j;
    try { j = JSON.parse(raw); } catch { throw new HttpError(400, 'bad_json', 'JSON 형식이 올바르지 않습니다.'); }
    if (!j || typeof j.text !== 'string') throw new HttpError(400, 'bad_body', '{ "text": "..." } 형식이어야 합니다.');
    text = j.text;
  }
  hookTimes.push(Date.now()); // counted once the request is well-formed
  const r = store.ingestDeposit(text);
  if (r.status === 'queue_full') { hookLimitedAt = Date.now(); touch('staff'); throw new HttpError(429, 'queue_full', '확인 대기 중인 입금 알림이 너무 많습니다.'); }
  if (r.status === 'matched') touchTable(r.table); else touch('staff');
  if (r.status !== 'ignored' && r.status !== 'duplicate') hint('staff', r.status === 'matched' ? 'deposit_matched' : 'new_deposit', { id: r.id, status: r.status, ...(r.status === 'matched' ? { orderId: r.orderId, table: r.table } : {}), ...(r.repeat ? { repeatCount: r.repeatCount } : {}) });
  return { ok: true, status: r.status, ...(r.id ? { id: r.id } : {}) }; // never reveals the matched order
}
route('POST', '/api/deposit-hook/([^/]{1,200})', (c) => depositHook(c, c.m[1]), { raw: true }); // secret in the path
route('POST', '/api/deposit-hook', (c) => depositHook(c, c.req.headers['x-booth-hook']), { raw: true }); // or in the X-Booth-Hook header (keeps it out of access logs)
const menuDone = (extra = {}) => { touchAll(); return { ok: true, ...extra, menu: store.menuView(true) }; };
route('POST', '/api/staff/menu/items', (c) => menuDone({ item: store.createItem(c.body) }), { staff: true });
route('POST', '/api/staff/menu/items/([A-Za-z0-9_-]{1,40})', (c) => menuDone({ item: store.updateItem(c.m[1], c.body) }), { staff: true });
route('POST', '/api/staff/menu/items/([A-Za-z0-9_-]{1,40})/delete', (c) => { store.deleteItem(c.m[1]); return menuDone(); }, { staff: true });
route('POST', '/api/staff/menu/reorder', (c) => { store.reorderMenu(c.body); return menuDone(); }, { staff: true });
route('POST', '/api/staff/menu/categories', (c) => menuDone({ category: store.createCategory(c.body) }), { staff: true });
route('POST', '/api/staff/menu/categories/(\\d{1,9})', (c) => menuDone({ category: store.renameCategory(int(c.m[1]), c.body) }), { staff: true });
route('POST', '/api/staff/menu/categories/(\\d{1,9})/delete', (c) => { store.deleteCategory(int(c.m[1])); return menuDone(); }, { staff: true });
route('POST', '/api/staff/member-discount', (c) => { const next = store.setMemberSettings(c.body); touchAll(); return { ok: true, ...next }; }, { staff: true });
route('GET', '/api/staff/rewards', () => ({ rewards: store.listRewards(), hourly: store.hourlyReward(), games: rewards.games }), { staff: true });
const rewardsDone = (extra = {}) => { touchAll(); return { ok: true, ...extra, rewards: store.listRewards() }; };
route('POST', '/api/staff/rewards', (c) => rewardsDone({ reward: store.createReward(c.body) }), { staff: true });
route('POST', '/api/staff/rewards/([A-Za-z0-9_-]{1,40})', (c) => rewardsDone({ reward: store.updateReward(c.m[1], c.body) }), { staff: true });
route('POST', '/api/staff/rewards/([A-Za-z0-9_-]{1,40})/delete', (c) => { store.deleteReward(c.m[1]); return rewardsDone(); }, { staff: true });
route('POST', '/api/staff/hourly-reward', (c) => { const hourly = store.setHourlyReward(c.body); touchAll(); return { ok: true, hourly }; }, { staff: true });
// photo upload: the body is the raw image (not JSON), max 400 KB
route('POST', '/api/staff/menu/items/([A-Za-z0-9_-]{1,40})/photo', async (c) => {
  const type = (c.req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!PHOTO_TYPES.has(type)) throw new HttpError(415, 'unsupported_media_type', 'Content-Type은 image/jpeg, image/png, image/webp 중 하나여야 합니다.');
  const buf = await readBody(c.req, PHOTO_MAX);
  return menuDone({ item: store.setPhoto(c.m[1], buf, type) });
}, { staff: true, raw: true });
route('POST', '/api/staff/menu/items/([A-Za-z0-9_-]{1,40})/photo/delete', (c) => menuDone({ item: store.deletePhoto(c.m[1]) }), { staff: true });
// public photo files (names are <rowid>-<8 hex>.<ext>; the random suffix changes on every replace, hence "immutable")
const PHOTO_MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };
route('GET', '/photos/(\\d+-[a-f0-9]{8}\\.(?:jpg|png|webp))', (c) => {
  let buf;
  try { buf = fs.readFileSync(path.join(store.photosDir, c.m[1])); } catch { return sendText(c.res, 404, 'text/plain; charset=utf-8', 'not found', { 'Cache-Control': 'no-store' }); }
  c.res.setHeader('Content-Security-Policy', "default-src 'none'");
  c.res.writeHead(200, { 'Content-Type': PHOTO_MIME[c.m[1].split('.').pop()], 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
  c.res.end(buf);
});
route('POST', '/api/staff/ordering', (c) => { need(typeof c.body.open === 'boolean', 'bad_open', 'open은 true/false여야 합니다.'); store.setOrdering(c.body.open); touchAll(); return { ok: true, orderingOpen: c.body.open }; }, S);
route('POST', '/api/staff/coupons/redeem', (c) => { const coupon = store.redeem(c.body.code); touchTable(coupon.table); return { coupon }; }, S);
route('POST', '/api/staff/tables/count', (c) => {
  const n = store.setTableCount(c.body.count, c.body.force === true);
  refreshTokens();
  closeGuestStreams((t) => t <= n); // guests of tables above the new count lose their live stream
  touchAll();
  return { ok: true, tableCount: n };
}, S);
route('POST', '/api/staff/tables/(\\d{1,4})/rotate', (c) => {
  const n = int(c.m[1]);
  const token = store.rotateToken(n);
  refreshTokens();
  closeGuestStreams((t) => t !== n); // streams opened with the old QR code end; the table's orders / seat are untouched
  touchTable(n);
  return { ok: true, table: n, token, url: `${PUBLIC_ORIGIN}${BASE}/t/${token}` };
}, S);
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
  const r = store.clearTable(n, c.body.force === true);
  touchTable(n);
  hint('g:' + n, 'cleared', { seat: r.seat });
  return { ok: true, table: n, seat: r.seat, writtenOff: r.writtenOff };
}, S);
route('POST', '/api/staff/tables/(\\d{1,4})/unclear', (c) => {
  const n = int(c.m[1]);
  const seat = store.unclearTable(n);
  touchTable(n);
  hint('g:' + n, 'cleared', { seat }); // guests reload their (restored) state
  return { ok: true, table: n, seat };
}, S);
route('POST', '/api/staff/tables/(\\d{1,4})/orders', (c) => {
  const n = int(c.m[1]);
  const go = () => store.createOrder(n, c.body, { staff: { allowHidden: c.body.allowHidden === true, accept: c.body.accept === true } });
  if (c.body.dryRun === true) return { dryRun: true, ...store.dry(go) };
  const r = go();
  if (!r.duplicate) {
    c.status = 201;
    touchTable(n);
    hint('g:' + n, 'order_status', { id: r.order.id, status: r.order.status });
    if (r.order.status === 'cooking') hint('kitchen', 'new_cooking', { id: r.order.id, table: n });
  }
  return r;
}, S);
route('POST', '/api/staff/tables/(\\d{1,4})/coupons', (c) => { const coupon = store.createManualCoupon(int(c.m[1]), c.body); touchTable(int(c.m[1])); return { ok: true, coupon }; }, S);
route('POST', '/api/staff/coupons/([A-Za-z0-9]{1,12})/void', (c) => { const coupon = store.voidCoupon(c.m[1]); touchTable(coupon.table); return { ok: true, coupon }; }, S);
const orderEdited = (order) => { touchTable(order.table); hint('g:' + order.table, 'order_status', { id: order.id, status: order.status }); return order; };
route('POST', '/api/staff/orders/(\\d{1,9})/items', (c) => {
  const go = () => store.editItems(int(c.m[1]), c.body.items, { expectedUpdatedAt: c.body.expectedUpdatedAt });
  return c.body.dryRun === true ? { dryRun: true, order: store.dry(go) } : { order: orderEdited(go()) };
}, S);
route('POST', '/api/staff/orders/(\\d{1,9})/service', (c) => {
  const go = () => store.addService(int(c.m[1]), c.body.itemId, c.body.qty, { expectedUpdatedAt: c.body.expectedUpdatedAt });
  return c.body.dryRun === true ? { dryRun: true, order: store.dry(go) } : { order: orderEdited(go()) };
}, S);
route('POST', '/api/staff/orders/(\\d{1,9})/move', (c) => {
  const r = store.moveOrder(int(c.m[1]), c.body.to, { expectedUpdatedAt: c.body.expectedUpdatedAt });
  touchTable(r.from);
  orderEdited(r.order);
  return { order: r.order, from: r.from };
}, S);
route('POST', '/api/staff/refunds/(\\d{1,9})/done', (c) => { const refund = store.refundDone(int(c.m[1]), c.body); touchTable(refund.table); return { ok: true, refund }; }, S);
route('POST', '/api/staff/notice', (c) => { const notice = store.setNotice(c.body); touchAll(); return { ok: true, notice }; }, S);
route('GET', '/api/staff/audit', (c) => {
  const before = c.url.searchParams.get('before'); const limit = c.url.searchParams.get('limit');
  const int0 = (v) => (v == null ? null : /^\d{1,12}$/.test(v) ? Number(v) : NaN);
  const b = int0(before); const l = int0(limit);
  if (Number.isNaN(b) || Number.isNaN(l)) throw new HttpError(400, 'bad_query', 'before와 limit은 정수여야 합니다.');
  return store.listAudit(b, l ?? undefined);
}, S);
route('POST', '/api/staff/day/close', async (c) => {
  if (c.body.confirm !== '마감') throw new HttpError(400, 'confirm_required', '확인 문구 "마감"을 입력해 주세요.');
  const force = c.body.force === true;
  store.closeCheck(force); // refuse before the (slow) backup when open items / nothing to close
  await backupNow(); // a safety copy first, then the frozen report + wipe in one transaction
  const report = store.closeDay(force);
  touchAll();
  return { ok: true, report };
}, S);
route('GET', '/api/staff/day/reports', () => ({ reports: store.listDayReports() }), S);
route('GET', '/api/staff/day/reports/(\\d{1,9})', (c) => store.dayReport(int(c.m[1])), S);
route('GET', '/api/staff/day/reports/(\\d{1,9})\\.csv', (c) => sendText(c.res, 200, 'text/csv; charset=utf-8', store.dayReportCsv(int(c.m[1])), { 'Content-Disposition': `attachment; filename="booth-day-${int(c.m[1])}.csv"`, 'Cache-Control': 'no-store' }), S);
route('POST', '/api/staff/waitlist/timeout', (c) => { const minutes = store.setWaitTimeout(c.body.minutes); touch('staff', 'w:*'); return { ok: true, minutes }; }, S);
route('POST', '/api/staff/calls/(\\d{1,9})/resolve', (c) => { store.resolveCall(int(c.m[1])); touch('staff', 'g:*'); return { ok: true }; }, S);
route('POST', '/api/staff/wait/(\\d{1,9})/(call|seat|cancel|recall)', (c) => { store.waitAction(int(c.m[1]), c.m[2]); touch('staff', 'w:*'); return { ok: true }; }, S);
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
function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length'] || 0);
    if (len > limit) return reject(new HttpError(413, 'too_large', '요청이 너무 큽니다.'));
    const chunks = [];
    let n = 0;
    req.on('data', (d) => {
      n += d.length;
      if (n > limit) { chunks.length = 0; reject(new HttpError(413, 'too_large', '요청이 너무 큽니다.')); req.removeAllListeners('data'); req.resume(); } else chunks.push(d);
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
    if (!r.raw && !/^application\/json\b/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'unsupported_media_type', 'Content-Type은 application/json이어야 합니다.');
    const raw = r.raw ? Buffer.alloc(0) : await readBody(req);
    if (raw.length) {
      try { c.body = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'bad_json', 'JSON 형식이 올바르지 않습니다.'); }
      if (!c.body || typeof c.body !== 'object' || Array.isArray(c.body)) throw new HttpError(400, 'bad_json', 'JSON 객체여야 합니다.');
    }
  }
  const out = await r.fn(c);
  if (method === 'POST' && r.staff && !DB_AUDITED.test(p)) { const norm = p.replace(/\/\d+(?=\/|$)/g, '/#'); store.audit('staff_action', norm, Object.keys(c.body || {}).join(','), actionKo(norm, c.body || {})); } // route + field NAMES only: never values (no PINs, tokens or secrets)
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
const waitSweepTimer = setInterval(() => { try { if (store.sweepWait()) touch('staff', 'w:*'); } catch (e) { console.error('wait sweep failed:', e.message); } }, 30000); // calls nobody answered become no-shows
waitSweepTimer.unref();

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

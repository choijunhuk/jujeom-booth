'use strict';
// node --test  (spawns real server processes on random ports with temp dirs)
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DatabaseSync } = require('node:sqlite');
const { createStore } = require('./db');

const SERVER = path.join(__dirname, 'server.js');
const PIN = '654321';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const MENU = {
  categories: ['안주', '음료'],
  items: [
    { id: 'tteokbokki', name: '떡볶이', price: 8000, cat: '안주' },
    { id: 'odeng', name: '어묵탕', price: 9000, cat: '안주' },
    { id: 'fries', name: '감자튀김', price: 6000, cat: '안주' },
    { id: 'cola', name: '콜라', price: 2000, cat: '음료' },
  ],
};
const REWARDS = {
  games: {
    pour: { label: 'pour', maxScore: 500, minDurationMs: 200 },
    cheers: { label: 'cheers', maxScore: 1000, minDurationMs: 200 },
  },
  rewards: [
    { id: 'drink', game: 'pour', threshold: 400, type: 'item', item: '콜라', label: '음료 1잔', stock: 3 },
    { id: 'd1000', game: 'cheers', threshold: 700, type: 'discount', amount: 1000, label: '1000원 할인', stock: 50 },
    { id: 'dbig', game: 'cheers', threshold: 900, type: 'discount', amount: 100000, label: '큰 할인', stock: 50 },
  ],
  hourly: { label: '안주 1개 서비스', item: '안주' },
};

async function boot({ base = '', env = {}, dir, menu, menuRaw, rewards, tablesCount, noSw } = {}) {
  dir ||= fs.mkdtempSync(path.join(os.tmpdir(), 'booth-test-'));
  const cfg = path.join(dir, 'cfg');
  const pub = path.join(dir, 'pub');
  const data = path.join(dir, 'data');
  if (!fs.existsSync(cfg)) {
    fs.mkdirSync(cfg); fs.mkdirSync(pub);
    fs.writeFileSync(path.join(cfg, 'menu.json'), menuRaw ?? JSON.stringify(menu || MENU));
    fs.writeFileSync(path.join(cfg, 'rewards.json'), JSON.stringify(rewards || REWARDS));
    fs.writeFileSync(path.join(cfg, 'tables.json'), JSON.stringify({ count: tablesCount ?? 40 }));
    if (!noSw) fs.writeFileSync(path.join(pub, 'sw.js'), 'const BASE="__BASE__";');
    for (const f of ['guest', 'staff', 'kitchen', 'board', 'wait', 'qr']) {
      fs.writeFileSync(path.join(pub, `${f}.html`), `<!doctype html><title>${f}</title><script src="__BASE__/static/base.js"></script><script src="__BASE__/static/x.js"></script>`);
    }
    fs.writeFileSync(path.join(pub, 'x.js'), 'var base="__BASE__";');
    fs.writeFileSync(path.join(pub, 'base.js'), 'window.BASE="__BASE__";');
  }
  const child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH, PORT: '0', HOST: '127.0.0.1', STAFF_PIN: PIN, BASE_PATH: base, DATA_DIR: data, CONFIG_DIR: cfg, PUBLIC_DIR: pub, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const port = await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { log += d; const m = /listening on [^:]+:(\d+)/.exec(log); if (m) resolve(Number(m[1])); });
    child.stderr.on('data', (d) => { log += d; });
    child.on('exit', (code) => reject(new Error(`server exited ${code}: ${log}`)));
  });
  return {
    origin: `http://127.0.0.1:${port}`, base, port, dir, data, child, log: () => log,
    async stop({ keep = false } = {}) {
      if (child.exitCode === null) { child.kill('SIGTERM'); await new Promise((r) => child.once('exit', r)); }
      if (!keep) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

class Client {
  constructor(srv) { this.srv = srv; this.jar = {}; this.setCookies = []; }
  cookieHeader() { return Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; '); }
  async req(method, p, body, headers = {}) {
    const h = { ...headers };
    if (this.cookieHeader()) h.cookie = this.cookieHeader();
    let payload;
    if (body !== undefined) { payload = typeof body === 'string' ? body : JSON.stringify(body); h['content-type'] ||= 'application/json'; }
    const res = await fetch(this.srv.origin + this.srv.base + p, { method, headers: h, body: payload });
    for (const sc of res.headers.getSetCookie()) {
      this.setCookies.push(sc);
      const [kv] = sc.split(';');
      const i = kv.indexOf('=');
      const k = kv.slice(0, i); const v = kv.slice(i + 1);
      if (v === '') delete this.jar[k]; else this.jar[k] = v;
    }
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  get(p, h) { return this.req('GET', p, undefined, h); }
  post(p, b = {}, h) { return this.req('POST', p, b, h); }
}

const raw = (srv, method, p, headers = {}, body) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: srv.port, method, path: p, headers, agent: false }, (res) => { // no keep-alive reuse: the server may close after a 404 with an unread body
    let t = ''; res.on('data', (d) => { t += d; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: t }));
  });
  req.on('error', reject);
  req.end(body);
});

async function openSse(srv, p, headers = {}) {
  const ac = new AbortController();
  const res = await fetch(srv.origin + srv.base + p, { headers, signal: ac.signal });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = ''; let pending = null;
  return {
    res,
    close: () => ac.abort(),
    async until(pred, ms = 3000) {
      const end = Date.now() + ms;
      for (;;) {
        if (pred(buf)) return buf;
        const left = end - Date.now();
        if (left <= 0) throw new Error('sse timeout; got: ' + buf);
        pending ||= reader.read();
        pending.catch(() => {});
        const r = await Promise.race([pending, delay(left).then(() => null)]);
        if (r === null) continue;
        pending = null;
        if (r.done) throw new Error('sse closed; got: ' + buf);
        buf += dec.decode(r.value, { stream: true });
      }
    },
  };
}

async function staffLogin(srv) {
  const c = new Client(srv);
  const r = await c.post('/api/staff/login', { pin: PIN });
  assert.equal(r.status, 200, r.text);
  return c;
}
const newKey = () => crypto.randomUUID();
// plays at one table are also spaced per seat (1 s default): wait it out like a real client would
async function startPlay(g, token, game) {
  for (let i = 0; i < 8; i++) {
    const r = await g.post(`/api/t/${token}/plays/start`, { game });
    if (r.status !== 429 || r.json.error !== 'rate_limited') return r;
    await delay(r.json.retryAfterMs + 30);
  }
  throw new Error('start kept being rate limited');
}
const order = (g, token, items, extra = {}) => g.post(`/api/t/${token}/orders`, { key: newKey(), items, ...extra });
async function playOnce(g, token, game, score) {
  const s = await startPlay(g, token, game);
  assert.equal(s.status, 200, s.text);
  await delay(260);
  return g.post(`/api/t/${token}/plays/finish`, { playId: s.json.playId, score });
}


// schema written by the code before member discounts / DB-backed menu (git HEAD db.js at the time): used to prove in-place upgrades
const OLD_SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS tables(id INTEGER PRIMARY KEY, token TEXT NOT NULL UNIQUE, seat INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT, table_id INTEGER NOT NULL, seat INTEGER NOT NULL, key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', paid INTEGER NOT NULL DEFAULT 0,
  subtotal INTEGER NOT NULL, discount INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL,
  coupon_code TEXT, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  cooking_at INTEGER, UNIQUE(table_id, seat, key));
CREATE INDEX IF NOT EXISTS orders_ts ON orders(table_id, seat);
CREATE TABLE IF NOT EXISTS order_items(order_id INTEGER NOT NULL, item_id TEXT NOT NULL, name TEXT NOT NULL, unit_price INTEGER NOT NULL, qty INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS order_items_o ON order_items(order_id);
CREATE TABLE IF NOT EXISTS sold_out(item_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reward_stock(id TEXT PRIMARY KEY, stock INTEGER NOT NULL, issued INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS coupons(
  code TEXT PRIMARY KEY, reward_id TEXT NOT NULL, source TEXT NOT NULL, type TEXT NOT NULL, amount INTEGER, label TEXT NOT NULL, item TEXT,
  table_id INTEGER NOT NULL, seat INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'issued', order_id INTEGER, used_at INTEGER, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS coupons_ts ON coupons(table_id, seat);
CREATE TABLE IF NOT EXISTS plays(
  id INTEGER PRIMARY KEY AUTOINCREMENT, table_id INTEGER NOT NULL, seat INTEGER NOT NULL, game TEXT NOT NULL, device TEXT NOT NULL,
  nick TEXT, started_at INTEGER NOT NULL, finished_at INTEGER, score INTEGER, rejected INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS plays_dev ON plays(device);
CREATE INDEX IF NOT EXISTS plays_ts ON plays(table_id, seat);
CREATE TABLE IF NOT EXISTS nicks(device TEXT NOT NULL, table_id INTEGER NOT NULL, seat INTEGER NOT NULL, nick TEXT NOT NULL, PRIMARY KEY(device, table_id, seat));
CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY AUTOINCREMENT, table_id INTEGER NOT NULL, seat INTEGER NOT NULL, type TEXT NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER);
CREATE TABLE IF NOT EXISTS waitlist(
  id INTEGER PRIMARY KEY AUTOINCREMENT, nick TEXT NOT NULL, size INTEGER NOT NULL, secret TEXT NOT NULL, device TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting', created_at INTEGER NOT NULL, called_at INTEGER);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS login_keys(hash TEXT PRIMARY KEY, fails INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS nicks_ts ON nicks(table_id, seat);
CREATE INDEX IF NOT EXISTS plays_fin ON plays(finished_at);
`;

// schema written by the previous release (git 3ba4c20): used to prove the upgrade of a production booth.db
const HEAD_SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS tables(id INTEGER PRIMARY KEY, token TEXT NOT NULL UNIQUE, seat INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT, table_id INTEGER NOT NULL, seat INTEGER NOT NULL, key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', paid INTEGER NOT NULL DEFAULT 0,
  subtotal INTEGER NOT NULL, discount INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL,
  member_discount INTEGER NOT NULL DEFAULT 0, member_id INTEGER,
  coupon_code TEXT, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  cooking_at INTEGER, UNIQUE(table_id, seat, key));
CREATE INDEX IF NOT EXISTS orders_ts ON orders(table_id, seat);
CREATE TABLE IF NOT EXISTS order_items(order_id INTEGER NOT NULL, item_id TEXT NOT NULL, name TEXT NOT NULL, unit_price INTEGER NOT NULL, qty INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS order_items_o ON order_items(order_id);
CREATE TABLE IF NOT EXISTS menu_categories(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS menu_items(
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, price INTEGER NOT NULL, category_id INTEGER NOT NULL, descr TEXT NOT NULL DEFAULT '',
  hidden INTEGER NOT NULL DEFAULT 0, sold_out INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS order_items_item ON order_items(item_id);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reward_stock(id TEXT PRIMARY KEY, stock INTEGER NOT NULL, issued INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS coupons(
  code TEXT PRIMARY KEY, reward_id TEXT NOT NULL, source TEXT NOT NULL, type TEXT NOT NULL, amount INTEGER, label TEXT NOT NULL, item TEXT,
  table_id INTEGER NOT NULL, seat INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'issued', order_id INTEGER, used_at INTEGER, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS coupons_ts ON coupons(table_id, seat);
CREATE TABLE IF NOT EXISTS plays(
  id INTEGER PRIMARY KEY AUTOINCREMENT, table_id INTEGER NOT NULL, seat INTEGER NOT NULL, game TEXT NOT NULL, device TEXT NOT NULL,
  nick TEXT, started_at INTEGER NOT NULL, finished_at INTEGER, score INTEGER, rejected INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS plays_dev ON plays(device);
CREATE INDEX IF NOT EXISTS plays_ts ON plays(table_id, seat);
CREATE TABLE IF NOT EXISTS nicks(device TEXT NOT NULL, table_id INTEGER NOT NULL, seat INTEGER NOT NULL, nick TEXT NOT NULL, PRIMARY KEY(device, table_id, seat));
CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY AUTOINCREMENT, table_id INTEGER NOT NULL, seat INTEGER NOT NULL, type TEXT NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER);
CREATE TABLE IF NOT EXISTS waitlist(
  id INTEGER PRIMARY KEY AUTOINCREMENT, nick TEXT NOT NULL, size INTEGER NOT NULL, secret TEXT NOT NULL, device TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting', created_at INTEGER NOT NULL, called_at INTEGER);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS login_keys(hash TEXT PRIMARY KEY, fails INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS nicks_ts ON nicks(table_id, seat);
CREATE INDEX IF NOT EXISTS plays_fin ON plays(finished_at);
`;

// schema written by Release 1 (git cf5d032, the version running in production): the Release 2 migration test boots on a database created with it
const R1_SCHEMA = `
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS tables(id INTEGER PRIMARY KEY, token TEXT NOT NULL UNIQUE, seat INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT, table_id INTEGER NOT NULL, seat INTEGER NOT NULL, key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', paid INTEGER NOT NULL DEFAULT 0,
  subtotal INTEGER NOT NULL, discount INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL,
  member_discount INTEGER NOT NULL DEFAULT 0, member_id INTEGER, depositor TEXT, paid_by TEXT, notice_id INTEGER,
  coupon_code TEXT, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  cooking_at INTEGER, UNIQUE(table_id, seat, key));
CREATE INDEX IF NOT EXISTS orders_ts ON orders(table_id, seat);
CREATE TABLE IF NOT EXISTS order_items(order_id INTEGER NOT NULL, item_id TEXT NOT NULL, name TEXT NOT NULL, unit_price INTEGER NOT NULL, qty INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS order_items_o ON order_items(order_id);
CREATE TABLE IF NOT EXISTS menu_categories(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS menu_items(
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, price INTEGER NOT NULL, category_id INTEGER NOT NULL, descr TEXT NOT NULL DEFAULT '',
  hidden INTEGER NOT NULL DEFAULT 0, sold_out INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0, photo TEXT);
CREATE INDEX IF NOT EXISTS order_items_item ON order_items(item_id);
CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rewards(
  id TEXT PRIMARY KEY, label TEXT NOT NULL, game TEXT NOT NULL, threshold INTEGER NOT NULL, type TEXT NOT NULL, amount INTEGER, item TEXT,
  stock INTEGER NOT NULL, issued INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS coupons(
  code TEXT PRIMARY KEY, reward_id TEXT NOT NULL, source TEXT NOT NULL, type TEXT NOT NULL, amount INTEGER, label TEXT NOT NULL, item TEXT,
  table_id INTEGER NOT NULL, seat INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'issued', order_id INTEGER, used_at INTEGER, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS coupons_ts ON coupons(table_id, seat);
CREATE TABLE IF NOT EXISTS plays(
  id INTEGER PRIMARY KEY AUTOINCREMENT, table_id INTEGER NOT NULL, seat INTEGER NOT NULL, game TEXT NOT NULL, device TEXT NOT NULL,
  nick TEXT, started_at INTEGER NOT NULL, finished_at INTEGER, score INTEGER, rejected INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS plays_dev ON plays(device);
CREATE INDEX IF NOT EXISTS plays_ts ON plays(table_id, seat);
CREATE TABLE IF NOT EXISTS nicks(device TEXT NOT NULL, table_id INTEGER NOT NULL, seat INTEGER NOT NULL, nick TEXT NOT NULL, PRIMARY KEY(device, table_id, seat));
CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY AUTOINCREMENT, table_id INTEGER NOT NULL, seat INTEGER NOT NULL, type TEXT NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER);
CREATE TABLE IF NOT EXISTS waitlist(
  id INTEGER PRIMARY KEY AUTOINCREMENT, nick TEXT NOT NULL, size INTEGER NOT NULL, secret TEXT NOT NULL, device TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'waiting', created_at INTEGER NOT NULL, called_at INTEGER);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS login_keys(hash TEXT PRIMARY KEY, fails INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS deposit_notices(
  id INTEGER PRIMARY KEY AUTOINCREMENT, received_at INTEGER NOT NULL, raw TEXT NOT NULL, norm TEXT NOT NULL, amount INTEGER, depositor TEXT,
  status TEXT NOT NULL, order_id INTEGER, matched_at INTEGER, matched_by TEXT, duplicate_of INTEGER, reasons TEXT, amount_guessed INTEGER NOT NULL DEFAULT 0, repeat_count INTEGER NOT NULL DEFAULT 1, last_at INTEGER);
CREATE INDEX IF NOT EXISTS deposit_norm ON deposit_notices(norm, received_at);
CREATE INDEX IF NOT EXISTS nicks_ts ON nicks(table_id, seat);
CREATE INDEX IF NOT EXISTS plays_fin ON plays(finished_at);
`;

// stands in for the club site's GET /api/auth/me
async function startFakeClub() {
  const specs = new Map();
  const hits = [];
  const other = { n: 0 };
  let seq = 0;
  const srv = http.createServer((req, res) => {
    if (req.url === '/other') { other.n++; res.end('{}'); return; }
    const m = /(?:^|;\s*)token=([^;]*)/.exec(req.headers.cookie || '');
    const tok = m ? m[1] : '';
    const hit = { method: req.method, url: req.url, headers: req.headers, tok, sentAt: 0 };
    hits.push(hit);
    const spec = specs.get(tok) || { status: 401 };
    const send = () => {
      hit.sentAt = Date.now();
      if (spec.location) { res.writeHead(spec.status || 302, { location: spec.location }); res.end(); return; }
      res.writeHead(spec.status, { 'content-type': 'application/json' });
      res.end(spec.raw !== undefined ? spec.raw : spec.json === undefined ? '' : JSON.stringify(spec.json));
    };
    if (spec.delay) setTimeout(() => { try { send(); } catch { /* client gave up */ } }, spec.delay); else send();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const fake = {
    url: `http://127.0.0.1:${srv.address().port}`, hits, other,
    token(spec) { const t = `t${++seq}x.${crypto.randomBytes(6).toString('hex')}.sig`; specs.set(t, spec); return t; },
    set(t, spec) { specs.set(t, spec); },
    member(id, role = 'USER') { return this.token({ status: 200, json: { id, name: '홍길동', role } }); },
    hitsFor(t) { return hits.filter((h) => h.tok === t); },
    close() { srv.closeAllConnections(); srv.close(); },
  };
  return fake;
}
let fake;

let main; let staff; let tokens;
const tok = (n) => tokens[n - 1].token;
const guest = () => new Client(main);
before(async () => {
  fake = await startFakeClub();
  main = await boot({ env: { COMS_ME_URL: fake.url + '/api/auth/me' } });
  staff = await staffLogin(main);
  tokens = (await staff.get('/api/staff/tables')).json.tables;
});
after(async () => { await main.stop(); fake.close(); });

test('price is computed by the server and client prices are ignored', async () => {
  const g = guest();
  const r = await order(g, tok(1), [{ id: 'tteokbokki', qty: 2, price: 1, total: 1 }, { id: 'cola', qty: 1, unitPrice: 5 }], { total: 1, price: 1 });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.order.total, 18000);
  assert.equal(r.json.order.subtotal, 18000);
  assert.deepEqual(r.json.order.items.map((i) => i.unitPrice), [8000, 2000]);
  assert.equal(r.json.order.status, 'pending');
  assert.equal(r.json.order.paid, false);
});

test('same idempotency key returns the original order, never a duplicate', async () => {
  const g = guest();
  const key = newKey();
  const a = await g.post(`/api/t/${tok(2)}/orders`, { key, items: [{ id: 'fries', qty: 1 }] });
  const b = await g.post(`/api/t/${tok(2)}/orders`, { key, items: [{ id: 'fries', qty: 1 }] });
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.json.duplicate, true);
  assert.equal(b.json.order.id, a.json.order.id);
  const s = await staff.get('/api/staff/state');
  assert.equal(s.json.orders.filter((o) => o.table === 2).length, 1);
});

test('order validation: unknown, sold-out, qty, lines, note, closed', async () => {
  const g = guest();
  const T = tok(3);
  assert.equal((await staff.post('/api/staff/menu/odeng/soldout', { soldOut: true })).status, 200);
  try {
    const r = await order(g, T, [{ id: 'fries', qty: 1 }, { id: 'odeng', qty: 1 }]);
    assert.equal(r.status, 409);
    assert.equal(r.json.error, 'sold_out');
    assert.deepEqual(r.json.ids, ['odeng']);
    assert.equal((await g.get(`/api/t/${T}`)).json.menu.items.find((i) => i.id === 'odeng').soldOut, true);
  } finally { await staff.post('/api/staff/menu/odeng/soldout', { soldOut: false }); }
  assert.equal((await order(g, T, [{ id: 'odeng', qty: 1 }])).status, 201);
  const bad = async (items, extra, status, code) => {
    const r = await order(g, T, items, extra);
    assert.equal(r.status, status, r.text);
    assert.equal(r.json.error, code);
  };
  await bad([{ id: 'nope', qty: 1 }], {}, 400, 'unknown_item');
  await bad([{ id: 'cola', qty: 0 }], {}, 400, 'bad_qty');
  await bad([{ id: 'cola', qty: 21 }], {}, 400, 'bad_qty');
  await bad([{ id: 'cola', qty: 1.5 }], {}, 400, 'bad_qty');
  await bad([{ id: 'cola', qty: '2' }], {}, 400, 'bad_qty');
  await bad([], {}, 400, 'bad_items');
  await bad(Array.from({ length: 31 }, (_, i) => ({ id: 'x' + i, qty: 1 })), {}, 400, 'too_many_lines');
  await bad([{ id: 'cola', qty: 1 }], { note: 'a'.repeat(101) }, 400, 'bad_note');
  assert.equal((await order(g, T, [{ id: 'cola', qty: 1 }], { note: 'a'.repeat(100) })).status, 201);
  // closed
  assert.equal((await staff.post('/api/staff/ordering', { open: false })).status, 200);
  try {
    await bad([{ id: 'cola', qty: 1 }], {}, 409, 'closed');
    assert.equal((await g.get(`/api/t/${T}`)).json.orderingOpen, false);
  } finally { await staff.post('/api/staff/ordering', { open: true }); }
  assert.equal((await order(g, T, [{ id: 'cola', qty: 1 }])).status, 201);
});

test('discount coupon: applied, floors at 0, single use, restored on cancel, table-bound', async () => {
  const g = guest();
  const T = tok(4);
  const f = await playOnce(g, T, 'cheers', 950);
  assert.equal(f.status, 200, f.text);
  assert.deepEqual(f.json.rewards.map((r) => r.result), ['issued', 'issued']);
  const big = f.json.coupons.find((c) => c.rewardId === 'dbig');
  const small = f.json.coupons.find((c) => c.rewardId === 'd1000');
  assert.match(big.code, /^[A-HJ-NP-Z2-9]{6}$/);

  const o1 = await order(g, T, [{ id: 'cola', qty: 1 }], { couponCode: big.code.toLowerCase() });
  assert.equal(o1.status, 201, o1.text);
  assert.equal(o1.json.order.subtotal, 2000);
  assert.equal(o1.json.order.discount, 2000);
  assert.equal(o1.json.order.total, 0);
  const again = await order(g, T, [{ id: 'cola', qty: 1 }], { couponCode: big.code });
  assert.equal(again.status, 409);
  assert.equal(again.json.error, 'coupon_used');
  assert.equal((await g.get(`/api/t/${T}`)).json.coupons.find((c) => c.code === big.code).status, 'used');

  // other table cannot use it
  const other = await order(guest(), tok(5), [{ id: 'cola', qty: 1 }], { couponCode: small.code });
  assert.equal(other.status, 400);
  assert.equal(other.json.error, 'bad_coupon');

  // normal discount
  const o2 = await order(g, T, [{ id: 'tteokbokki', qty: 1 }], { couponCode: small.code });
  assert.equal(o2.json.order.total, 7000);

  // cancel restores both
  assert.equal((await staff.post(`/api/staff/orders/${o1.json.order.id}/status`, { status: 'cancelled' })).status, 200);
  assert.equal((await staff.post(`/api/staff/orders/${o2.json.order.id}/status`, { status: 'cancelled' })).status, 200);
  const snap = (await g.get(`/api/t/${T}`)).json;
  assert.deepEqual(snap.coupons.map((c) => c.status), ['issued', 'issued']);
  const o3 = await order(g, T, [{ id: 'cola', qty: 1 }], { couponCode: big.code });
  assert.equal(o3.status, 201);
  assert.equal(o3.json.order.total, 0);
  // cancelled orders are terminal
  const t = await staff.post(`/api/staff/orders/${o1.json.order.id}/status`, { status: 'cooking' });
  assert.equal(t.status, 409);
});

test('device rate limit: one play start per 3s', async () => {
  const g = guest();
  assert.equal((await g.post(`/api/t/${tok(5)}/plays/start`, { game: 'pour' })).status, 200);
  const r = await g.post(`/api/t/${tok(5)}/plays/start`, { game: 'pour' });
  assert.equal(r.status, 429);
  assert.equal(r.json.error, 'rate_limited');
  assert.equal((await guest().post(`/api/t/${tok(5)}/plays/start`, { game: 'nope' })).json.error, 'bad_game');
});

test('one reward per table-seat; low score gets nothing', async () => {
  const T = tok(6);
  const a = await playOnce(guest(), T, 'cheers', 750);
  assert.deepEqual(a.json.rewards.map((r) => r.result), ['issued', 'low_score']);
  const b = await playOnce(guest(), T, 'cheers', 760);
  assert.deepEqual(b.json.rewards.map((r) => r.result), ['already_got', 'low_score']);
  const snap = (await guest().get(`/api/t/${T}`)).json;
  assert.equal(snap.coupons.filter((c) => c.rewardId === 'd1000').length, 1);
  assert.equal(snap.rewards.find((r) => r.id === 'd1000').got, true);
});

test('impossible score / duration rejected; finish accepted only once', async () => {
  const T = tok(7);
  const g = guest();
  const s = await startPlay(g, T, 'pour');
  await delay(260);
  for (const bad of ['12', 12.5, null]) {
    const r = await g.post(`/api/t/${T}/plays/finish`, { playId: s.json.playId, score: bad });
    assert.equal(r.status, 400); assert.equal(r.json.error, 'bad_score');
  }
  const over = await g.post(`/api/t/${T}/plays/finish`, { playId: s.json.playId, score: 501 });
  assert.equal(over.status, 400); assert.equal(over.json.error, 'bad_score');
  const retry = await g.post(`/api/t/${T}/plays/finish`, { playId: s.json.playId, score: 100 });
  assert.equal(retry.status, 409); assert.equal(retry.json.error, 'already_finished');

  const g2 = guest();
  const s2 = await startPlay(g2, T, 'pour');
  const fast = await g2.post(`/api/t/${T}/plays/finish`, { playId: s2.json.playId, score: 100 });
  assert.equal(fast.status, 400); assert.equal(fast.json.error, 'too_fast');
  assert.equal((await g2.post(`/api/t/${T}/plays/finish`, { playId: s2.json.playId, score: 100 })).status, 409);

  const g3 = guest();
  const s3 = await startPlay(g3, T, 'pour');
  await delay(260);
  assert.equal((await g3.post(`/api/t/${T}/plays/finish`, { playId: s3.json.playId, score: 100 })).status, 200);
  assert.equal((await g3.post(`/api/t/${T}/plays/finish`, { playId: s3.json.playId, score: 100 })).status, 409);
  // another device cannot finish someone else's play
  const s4 = await startPlay(guest(), T, 'pour');
  await delay(260);
  assert.equal((await guest().post(`/api/t/${T}/plays/finish`, { playId: s4.json.playId, score: 100 })).status, 404);
});

test('reward stock never exceeded when 20 plays race for stock 3', async () => {
  const devices = Array.from({ length: 20 }, (_, i) => ({ g: guest(), t: tok(21 + i) }));
  const starts = await Promise.all(devices.map((d) => d.g.post(`/api/t/${d.t}/plays/start`, { game: 'pour' })));
  starts.forEach((s) => assert.equal(s.status, 200, s.text));
  await delay(260);
  const fins = await Promise.all(devices.map((d, i) => d.g.post(`/api/t/${d.t}/plays/finish`, { playId: starts[i].json.playId, score: 450 })));
  const results = fins.map((f) => { assert.equal(f.status, 200, f.text); return f.json.rewards[0].result; });
  assert.equal(results.filter((r) => r === 'issued').length, 3);
  assert.equal(results.filter((r) => r === 'sold_out').length, 17);
  const st = (await staff.get('/api/staff/state')).json.rewards.find((r) => r.id === 'drink');
  assert.equal(st.issued, 3);
  assert.equal(st.remaining, 0);
  const below = await staff.post('/api/staff/rewards/drink/stock', { stock: 2 });
  assert.equal(below.status, 400); assert.equal(below.json.error, 'stock_below_issued'); assert.equal(below.json.issued, 3);
  assert.equal((await staff.post('/api/staff/rewards/drink/stock', { stock: 3 })).status, 200); // exactly issued is fine
  // staff can add stock
  assert.equal((await staff.post('/api/staff/rewards/drink/stock', { stock: 4 })).status, 200);
  assert.equal((await staff.post('/api/staff/rewards/drink/stock', { stock: -1 })).status, 400);
});

test('staff endpoints require a session', async () => {
  const anon = guest();
  const checks = [
    ['GET', '/api/staff/state'], ['GET', '/api/staff/me'], ['GET', '/api/staff/sales'], ['GET', '/api/staff/sales.csv'],
    ['GET', '/api/staff/tables'], ['GET', '/api/staff/events'], ['GET', '/api/kitchen'], ['GET', '/api/kitchen/events'],
    ['POST', '/api/staff/orders/1/status', { status: 'cooking' }], ['POST', '/api/staff/orders/1/paid', { paid: true }],
    ['POST', '/api/staff/ordering', { open: false }], ['POST', '/api/staff/reset', { confirm: '초기화' }],
    ['POST', '/api/staff/coupons/redeem', { code: 'ABCDEF' }], ['POST', '/api/staff/tables/1/clear', {}],
    ['POST', '/api/staff/tables/move', { from: 1, to: 2 }], ['POST', '/api/staff/award-hour', {}],
    ['POST', '/api/staff/menu/cola/soldout', { soldOut: true }], ['POST', '/api/staff/calls/1/resolve', {}],
    ['POST', '/api/staff/wait/1/call', {}], ['POST', '/api/staff/rewards/drink/stock', { stock: 9 }],
  ];
  for (const [m, p, b] of checks) {
    const r = await anon.req(m, p, b);
    assert.equal(r.status, 401, `${m} ${p} -> ${r.status}`);
  }
  anon.jar.booth_s = 'forged-session';
  assert.equal((await anon.get('/api/staff/state')).status, 401);
  assert.equal((await anon.get('/api/board')).status, 200); // board is public
  assert.equal((await anon.get('/api/menu')).status, 200);
  assert.equal((await staff.get('/api/staff/me')).status, 200);
});

test('login lockout: flat lock after 5 failures, counter resets when it expires (spec: no escalation)', async () => {
  const srv = await boot({ env: { LOCKOUT_MS: '500' } });
  try {
    const c = new Client(srv);
    for (let i = 0; i < 4; i++) {
      const r = await c.post('/api/staff/login', { pin: 'wrong' + i });
      assert.equal(r.status, 401);
      assert.equal(r.json.attemptsLeft, 4 - i);
    }
    const lockedNow = await c.post('/api/staff/login', { pin: 'wrong5' });
    assert.equal(lockedNow.status, 429);
    assert.equal(lockedNow.json.error, 'locked');
    assert.ok(lockedNow.json.retryAfterSec >= 1);
    // even the right PIN, even from a "different client", is refused while locked
    assert.equal((await new Client(srv).post('/api/staff/login', { pin: PIN })).status, 429);
    assert.equal((await c.get('/api/staff/state')).status, 401);
    await delay(600);
    // expired: counting starts over (old code kept the failure count and escalated)
    const first = await c.post('/api/staff/login', { pin: 'typo' });
    assert.equal(first.status, 401);
    assert.equal(first.json.attemptsLeft, 4);
    assert.equal((await c.post('/api/staff/login', { pin: PIN })).status, 200);
    // success resets the counter too
    for (let i = 0; i < 4; i++) assert.equal((await c.post('/api/staff/login', { pin: 'bad' })).status, 401);
    assert.equal((await c.post('/api/staff/login', { pin: PIN })).status, 200);
    assert.equal((await c.post('/api/staff/login', { pin: 'bad' })).json.attemptsLeft, 4);
  } finally { await srv.stop(); }
  // default lock is a flat 60 s
  const d = await boot();
  try {
    const c = new Client(d);
    let r;
    for (let i = 0; i < 5; i++) r = await c.post('/api/staff/login', { pin: 'wrong' + i });
    assert.equal(r.status, 429);
    assert.ok(r.json.retryAfterSec > 55 && r.json.retryAfterSec <= 60, String(r.json.retryAfterSec));
    assert.equal(r.headers.get('retry-after'), '60');
  } finally { await d.stop(); }
  const s2 = await boot({ env: { COOKIE_SECURE: '1' } });
  try {
    const c = new Client(s2);
    const ok = await c.post('/api/staff/login', { pin: PIN });
    assert.equal(ok.status, 200);
    const sc = c.setCookies[0];
    assert.match(sc, /^booth_s=/); assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Lax/); assert.match(sc, /Path=\//); assert.match(sc, /Secure/);
    assert.equal((await c.get('/api/staff/state')).status, 200);
    await c.post('/api/staff/logout');
    assert.equal((await c.get('/api/staff/state')).status, 401);
  } finally { await s2.stop(); }
});

test('guests cannot read other tables; unknown tokens 404', async () => {
  const a = guest(); const b = guest();
  const o = await order(a, tok(9), [{ id: 'fries', qty: 1 }]);
  assert.equal(o.status, 201);
  const sb = await b.get(`/api/t/${tok(10)}`);
  assert.equal(sb.status, 200);
  assert.deepEqual(sb.json.orders, []);
  assert.ok(!sb.text.includes(tok(9)));
  for (const t of tokens) if (t.number !== 10) assert.ok(!sb.text.includes(t.token));
  assert.equal((await b.get('/api/t/' + 'x'.repeat(16))).status, 404);
  const cancelOther = await b.post(`/api/t/${tok(10)}/orders/${o.json.order.id}/cancel`);
  assert.equal(cancelOther.status, 404);
  assert.equal((await b.get('/api/staff/tables')).status, 401);
});

test('guest cancel only while pending and unpaid', async () => {
  const g = guest(); const T = tok(18);
  const o = await order(g, T, [{ id: 'fries', qty: 1 }]);
  const c = await g.post(`/api/t/${T}/orders/${o.json.order.id}/cancel`);
  assert.equal(c.status, 200);
  assert.equal(c.json.order.status, 'cancelled');
  const o2 = await order(g, T, [{ id: 'fries', qty: 1 }]);
  await staff.post(`/api/staff/orders/${o2.json.order.id}/status`, { status: 'cooking' });
  const c2 = await g.post(`/api/t/${T}/orders/${o2.json.order.id}/cancel`);
  assert.equal(c2.status, 409);
});

test('clear table hides old orders/coupons from guests and staff board, keeps sales', async () => {
  const g = guest(); const T = tok(13);
  await playOnce(g, T, 'cheers', 800);
  const o = await order(g, T, [{ id: 'tteokbokki', qty: 1 }]);
  const before = (await g.get(`/api/t/${T}`)).json;
  assert.equal(before.orders.length, 1);
  assert.equal(before.coupons.length, 1);
  assert.equal(before.table.seat, 1);
  const refused = await staff.post('/api/staff/tables/13/clear');
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error, 'unsettled');
  assert.deepEqual([refused.json.unpaid, refused.json.unserved, refused.json.unpaidTotal], [1, 1, 8000]);
  assert.equal((await g.get(`/api/t/${T}`)).json.table.seat, 1);
  assert.equal((await staff.post('/api/staff/tables/13/clear', { force: 'yes' })).status, 409); // only literal true forces
  const c = await staff.post('/api/staff/tables/13/clear', { force: true });
  assert.equal(c.json.seat, 2);
  const after = (await g.get(`/api/t/${T}`)).json;
  assert.equal(after.table.seat, 2);
  assert.deepEqual(after.orders, []);
  assert.deepEqual(after.coupons, []);
  const st = (await staff.get('/api/staff/state')).json;
  assert.ok(!st.orders.some((x) => x.id === o.json.order.id));
  assert.equal(st.tables.find((t) => t.number === 13).status, 'empty');
  assert.ok((await staff.get('/api/staff/sales')).json.byItem.some((i) => i.id === 'tteokbokki' && i.qty >= 1));
  const o2 = await order(g, T, [{ id: 'cola', qty: 1 }]);
  assert.equal(o2.json.order.seat, 2);
  assert.equal((await g.get(`/api/t/${T}`)).json.orders.length, 1);
});

test('move table carries orders, coupons and plays', async () => {
  const g = guest(); const h = guest();
  await playOnce(g, tok(14), 'cheers', 950);
  await order(g, tok(14), [{ id: 'fries', qty: 1 }]);
  await order(h, tok(15), [{ id: 'cola', qty: 1 }]);
  const r = await staff.post('/api/staff/tables/move', { from: 14, to: 15 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.orders, 1);
  assert.equal(r.json.coupons, 2);
  assert.equal(r.json.plays, 1);
  const a = (await g.get(`/api/t/${tok(14)}`)).json;
  const b = (await h.get(`/api/t/${tok(15)}`)).json;
  assert.equal(a.orders.length, 0); assert.equal(a.coupons.length, 0);
  assert.equal(b.orders.length, 2); assert.equal(b.coupons.length, 2);
  assert.equal(b.orders[0].table, 15);
  assert.equal((await staff.post('/api/staff/tables/move', { from: 15, to: 15 })).status, 400);
  assert.equal((await staff.post('/api/staff/tables/move', { from: 15, to: 99 })).status, 404);
});

test('static path traversal is blocked; assets are served with __BASE__ replaced', async () => {
  for (const p of ['/static/..%2f..%2fserver.js', '/static/..%2fserver.js', '/static/%2e%2e/server.js', '/static/../server.js', '/static/..%5cserver.js', '/static/%00x.js', '/static/.hidden', '/static/sub/../../db.js']) {
    const r = await raw(main, 'GET', p);
    assert.equal(r.status, 404, p);
    assert.ok(!r.text.includes('createStore'), p);
  }
  const ok = await guest().get('/static/x.js');
  assert.equal(ok.status, 200);
  assert.equal(ok.text, 'var base="";');
  assert.match(ok.headers.get('content-type'), /javascript/);
});

test('pages, security headers, device cookie', async () => {
  const g = guest();
  const r = await g.get(`/t/${tok(1)}`);
  assert.equal(r.status, 200);
  assert.deepEqual((await g.get(`/api/t/${tok(1)}`)).json.pay, { bank: '', account: '', holder: '', tossEnabled: false, kakaoPayUrl: '', requireDepositor: false }); // spec change: pay grew toss / kakao / requireDepositor
  assert.ok(r.text.includes('src="/static/base.js"'));
  assert.equal((await g.get('/static/base.js')).text, 'window.BASE="";');
  assert.ok(r.text.includes('src="/static/x.js"'));
  assert.ok(!/<script(?![^>]*\ssrc=)/.test(r.text), 'fixture has no inline script');
  assert.ok(!r.text.includes('__BASE__'));
  assert.match(g.setCookies[0], /^booth_d=[a-f0-9]{32}\.[a-f0-9]{32}; Path=\/; HttpOnly; SameSite=Lax/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'same-origin');
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'; /); // no 'unsafe-inline' for scripts
  assert.match(csp, /style-src 'self' 'unsafe-inline'/);
  for (const p of ['/', '/t/' + 'y'.repeat(16)]) assert.ok(!/<script/i.test((await g.get(p)).text), `built-in page ${p} has no script`);
  for (const p of ['/wait', '/staff', '/staff/qr', '/kitchen', '/board']) assert.equal((await g.get(p)).status, 200, p);
  assert.equal((await g.get('/t/' + 'y'.repeat(16))).status, 404);
  const land = await g.get('/');
  assert.equal(land.status, 200);
  assert.match(land.text, /QR/);
});

test('BASE_PATH=/booth routing, __BASE__ replacement and cookie path', async () => {
  const srv = await boot({ base: '/booth' });
  try {
    const c = new Client(srv);
    assert.equal((await c.get('/api/health')).status, 200);
    assert.equal((await raw(srv, 'GET', '/api/health')).status, 404);
    assert.equal((await raw(srv, 'GET', '/boothx/api/health')).status, 404);
    for (const p of ['', '/']) {
      const l = await c.get(p);
      assert.equal(l.status, 200, `landing '${p}'`);
      assert.match(l.text, /QR/);
    }
    assert.equal((await c.post('/api/staff/login', { pin: PIN })).status, 200);
    assert.match(c.setCookies[0], /Path=\/booth(;|$)/);
    const t = (await c.get('/api/staff/tables')).json;
    assert.match(t.tables[0].url, /^\/booth\/t\//);
    const page = await c.get(`/t/${t.tables[0].token}`);
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('src="/booth/static/base.js"'));
    assert.equal((await c.get('/static/base.js')).text, 'window.BASE="/booth";');
    assert.ok(page.text.includes('src="/booth/static/x.js"'));
    assert.ok(!page.text.includes('__BASE__'));
    assert.equal((await c.get('/static/x.js')).text, 'var base="/booth";');
    assert.equal((await c.get('/wait')).status, 200);
    assert.equal((await c.get('/api/staff/state')).status, 200);
    assert.equal((await raw(srv, 'GET', '/booth/static/..%2f..%2fserver.js')).status, 404);
  } finally { await srv.stop(); }
});

test('request hygiene: content-type, bad json, size limit, csrf', async () => {
  const g = guest();
  const T = tok(1);
  assert.equal((await g.post(`/api/t/${T}/calls`, 'type=물', { 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
  assert.equal((await g.post(`/api/t/${T}/calls`, '{"type":"물"}', { 'content-type': 'text/plain' })).status, 415);
  const bj = await g.post(`/api/t/${T}/calls`, '{nope');
  assert.equal(bj.status, 400); assert.equal(bj.json.error, 'bad_json');
  assert.equal((await g.post(`/api/t/${T}/calls`, '[1]')).status, 400);
  const big = await raw(main, 'POST', `/api/t/${T}/orders`, { 'content-type': 'application/json' }, JSON.stringify({ note: 'x'.repeat(20000) }));
  assert.equal(big.status, 413);
  // CSRF on staff endpoints
  const cookie = staff.cookieHeader();
  const post = (headers) => raw(main, 'POST', '/api/staff/ordering', { 'content-type': 'application/json', cookie, ...headers }, '{"open":true}');
  assert.equal((await post({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await post({ 'sec-fetch-site': 'same-site' })).status, 403);
  assert.equal((await post({ 'sec-fetch-site': 'same-origin', origin: 'https://evil.example' })).status, 200); // proxy-safe: Sec-Fetch-Site wins
  assert.equal((await post({ origin: main.origin })).status, 200);
  assert.equal((await post({})).status, 200);
});

test('SSE: guest sees own order updates; staff gets new_order; headers and retry', async () => {
  const g = guest();
  const T = tok(11);
  await g.get(`/api/t/${T}`); // get a device cookie
  const s = await openSse(main, `/api/t/${T}/events`, { cookie: g.cookieHeader() });
  const st = await openSse(main, '/api/staff/events', { cookie: staff.cookieHeader() });
  try {
    assert.match(s.res.headers.get('content-type'), /text\/event-stream/);
    assert.match(s.res.headers.get('cache-control'), /no-cache/);
    assert.equal(s.res.headers.get('x-accel-buffering'), 'no');
    await s.until((b) => b.includes('retry:') && b.includes('event: state'));
    await st.until((b) => b.includes('event: state'));
    const o = await order(g, T, [{ id: 'cola', qty: 1 }]);
    await s.until((b) => b.includes(`"id":${o.json.order.id}`) && b.includes('"status":"pending"'));
    await st.until((b) => b.includes('event: new_order'));
    await staff.post(`/api/staff/orders/${o.json.order.id}/status`, { status: 'cooking' });
    await s.until((b) => b.includes('event: order_status') && b.includes('"status":"cooking"'));
  } finally { s.close(); st.close(); }
});

test('staff flow: cooking -> kitchen aggregation -> served, paid, calls', async () => {
  const g1 = guest(); const g2 = guest();
  const o1 = await order(g1, tok(16), [{ id: 'tteokbokki', qty: 2 }], { note: '덜 맵게' });
  const o2 = await order(g2, tok(17), [{ id: 'tteokbokki', qty: 1 }, { id: 'odeng', qty: 1 }]);
  const qtys = (k) => Object.fromEntries(k.items.map((i) => [i.id, i.qty]));
  const base = qtys((await staff.get('/api/kitchen')).json); // earlier tests may leave cooking orders
  let k;
  for (const o of [o1, o2]) assert.equal((await staff.post(`/api/staff/orders/${o.json.order.id}/status`, { status: 'cooking' })).status, 200);
  k = (await staff.get('/api/kitchen')).json;
  assert.equal(qtys(k).tteokbokki, (base.tteokbokki || 0) + 3);
  assert.equal(qtys(k).odeng, (base.odeng || 0) + 1);
  assert.equal(k.orders.find((o) => o.id === o1.json.order.id).note, '덜 맵게');
  assert.equal((await staff.post(`/api/staff/orders/${o1.json.order.id}/paid`, { paid: true })).json.order.paid, true);
  assert.equal((await staff.post(`/api/staff/orders/${o1.json.order.id}/paid`, { paid: 'yes' })).status, 400);
  const tv = (await staff.get('/api/staff/state')).json.tables;
  assert.equal(tv.find((t) => t.number === 16).unpaidTotal, 0);
  assert.equal(tv.find((t) => t.number === 17).unpaidTotal, 17000);
  assert.equal(tv.find((t) => t.number === 17).status, 'occupied');
  for (const o of [o1, o2]) await staff.post(`/api/staff/orders/${o.json.order.id}/status`, { status: 'served' });
  assert.deepEqual(qtys((await staff.get('/api/kitchen')).json), base);
  assert.equal((await g1.get(`/api/t/${tok(16)}`)).json.orders[0].status, 'served');
  // calls
  const c = await g1.post(`/api/t/${tok(16)}/calls`, { type: '물' });
  assert.equal(c.status, 200);
  assert.equal((await g1.post(`/api/t/${tok(16)}/calls`, { type: '물' })).json.duplicate, true);
  assert.equal((await g1.post(`/api/t/${tok(16)}/calls`, { type: '술' })).status, 400);
  assert.equal((await staff.get('/api/staff/state')).json.calls.filter((x) => x.table === 16).length, 1);
  assert.equal((await staff.post(`/api/staff/calls/${c.json.call.id}/resolve`)).status, 200);
  assert.equal((await staff.get('/api/staff/state')).json.calls.filter((x) => x.table === 16).length, 0);
});

test('nicknames: sanitized, length-limited, profanity rejected, shown on the board', async () => {
  const g = guest(); const T = tok(19);
  await g.get(`/api/t/${T}`); // the page loads the snapshot first, which sets the device cookie
  const nick = (n) => g.post(`/api/t/${T}/nick`, { nick: n });
  assert.equal((await nick('a\u0000b​c')).json.nick, 'abc');
  for (const bad of ['시발', '씨 발', 'F.U.C.K', 'x'.repeat(11), '', '   ', '​', 5]) {
    const r = await nick(bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.json.error, 'bad_nick');
  }
  assert.equal((await nick('맥주왕')).json.nick, '맥주왕');
  assert.equal((await g.get(`/api/t/${T}`)).json.nick, '맥주왕');
  await playOnce(g, T, 'cheers', 880);
  const board = (await guest().get('/api/board')).json;
  assert.ok(board.games.cheers.some((r) => r.table === 19 && r.nick === '맥주왕' && r.score === 880));
  assert.ok(board.hour.ranking.some((r) => r.table === 19));
  assert.equal(board.rewards.find((r) => r.id === 'drink').remaining, 1); // race issued 3, then staff raised stock to 4
  assert.ok(board.rewards.length > 0);
  for (const r of board.rewards) {
    assert.deepEqual(Object.keys(r).sort(), ['id', 'label', 'remaining', 'stock']);
    assert.ok(r.remaining >= 0 && r.remaining <= r.stock);
  }
});

test('waitlist: register, position, call, seat, cancel', async () => {
  const a = guest(); const b = guest();
  const w1 = await a.post('/api/wait', { nick: '손님A', size: 3 });
  assert.equal(w1.status, 201);
  const w2 = await b.post('/api/wait', { nick: '손님B', size: 2 });
  const s1 = (await a.get(`/api/wait/${w1.json.id}?secret=${w1.json.secret}`)).json;
  const s2 = (await b.get(`/api/wait/${w2.json.id}?secret=${w2.json.secret}`)).json;
  assert.equal(s1.position, 1); assert.equal(s1.ahead, 0);
  assert.equal(s2.position, 2); assert.equal(s2.ahead, 1);
  assert.equal((await a.get(`/api/wait/${w1.json.id}?secret=nope`)).status, 404);
  assert.equal((await a.post('/api/wait', { nick: '손님', size: 11 })).status, 400);
  assert.equal((await a.post('/api/wait', { nick: '씨발', size: 2 })).status, 400);
  const ev = await openSse(main, `/api/wait/${w2.json.id}/events?secret=${w2.json.secret}`);
  try {
    await ev.until((x) => x.includes('"position":2'));
    assert.equal((await staff.post(`/api/staff/wait/${w1.json.id}/call`)).status, 200);
    await ev.until((x) => x.includes('"position":1'));
    assert.equal((await a.get(`/api/wait/${w1.json.id}?secret=${w1.json.secret}`)).json.status, 'called');
    assert.equal((await staff.post(`/api/staff/wait/${w1.json.id}/seat`)).status, 200);
    assert.equal((await staff.post(`/api/staff/wait/${w1.json.id}/cancel`)).status, 409);
    assert.equal((await staff.get('/api/staff/state')).json.waitlist.length, 1);
    assert.equal((await b.post(`/api/wait/${w2.json.id}/cancel`, { secret: w2.json.secret })).status, 200);
    await ev.until((x) => x.includes('"status":"cancelled"'));
  } finally { ev.close(); }
});

test('hourly ranking award issues one item coupon; staff redeem is single-use', async () => {
  const st = (await staff.get('/api/staff/state')).json;
  const top = st.hour.top;
  assert.ok(top, 'some plays exist in this hour from earlier tests');
  assert.equal((await guest().get('/api/board')).json.hour.awarded, false); // fills the 1.5 s board memo
  const r = await staff.post('/api/staff/award-hour');
  assert.equal(r.status, 200, r.text);
  assert.equal((await guest().get('/api/board')).json.hour.awarded, true); // ...which the award must invalidate
  assert.equal(r.json.table, top.table);
  assert.equal(r.json.coupon.type, 'item');
  assert.equal((await staff.post('/api/staff/award-hour')).status, 409);
  const snap = (await guest().get(`/api/t/${tok(top.table)}`)).json;
  assert.ok(snap.coupons.some((c) => c.code === r.json.coupon.code));
  const code = r.json.coupon.code;
  const red = await staff.post('/api/staff/coupons/redeem', { code: code.toLowerCase() });
  assert.equal(red.status, 200, red.text);
  assert.equal(red.json.coupon.status, 'used');
  assert.equal(red.json.coupon.stale, false);
  const again = await staff.post('/api/staff/coupons/redeem', { code });
  assert.equal(again.status, 409);
  assert.equal(again.json.error, 'already_used');
  assert.equal((await staff.post('/api/staff/coupons/redeem', { code: 'ZZZZZZ' })).status, 404);
  assert.equal((await staff.post('/api/staff/award-hour', { hourStart: 12345 })).status, 400);
});

test('sales summary and CSV export (UTF-8 BOM)', async () => {
  const s = (await staff.get('/api/staff/sales')).json;
  assert.ok(s.totals.orders > 0);
  assert.ok(s.byHour.length >= 1);
  assert.match(s.byHour[0].label, /^\d{4}-\d\d-\d\d \d\d:00$/);
  assert.ok(s.byItem.length > 0);
  assert.ok(s.coupons.length > 0);
  const res = await fetch(main.origin + '/api/staff/sales.csv', { headers: { cookie: staff.cookieHeader() } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = new TextDecoder().decode(bytes);
  assert.ok(text.includes('메뉴별 판매') && text.includes('시간대별 매출') && text.includes('쿠폰'));
});

test('reset needs confirmation, keeps tokens; tokens stable across restarts; backups written', async () => {
  const srv = await boot({ env: { BACKUP_INTERVAL_MS: '200' } });
  let srv2;
  try {
    const s = await staffLogin(srv);
    const t1 = (await s.get('/api/staff/tables')).json.tables;
    const g = new Client(srv);
    await order(g, t1[0].token, [{ id: 'cola', qty: 1 }]);
    await s.post('/api/staff/menu/cola/soldout', { soldOut: true });
    await s.post('/api/staff/tables/3/clear');
    assert.equal((await s.post('/api/staff/reset', {})).status, 400);
    assert.equal((await s.post('/api/staff/reset', { confirm: 'reset' })).status, 400);
    assert.equal((await s.get('/api/staff/state')).json.orders.length, 1);
    assert.equal((await s.post('/api/staff/reset', { confirm: '초기화' })).status, 200);
    const st = (await s.get('/api/staff/state')).json;
    assert.equal(st.orders.length, 0);
    assert.ok(st.tables.every((t) => t.seat === 1));
    assert.ok(st.menu.items.every((i) => !i.soldOut));
    assert.deepEqual((await s.get('/api/staff/tables')).json.tables, t1);
    assert.equal((await g.get(`/api/t/${t1[0].token}`)).status, 200);
    await delay(700);
    assert.ok(fs.readdirSync(path.join(srv.data, 'backup')).some((f) => /^booth-.*\.db$/.test(f)));
    await srv.stop({ keep: true });
    srv2 = await boot({ dir: srv.dir });
    const s2 = await staffLogin(srv2);
    assert.deepEqual((await s2.get('/api/staff/tables')).json.tables, t1);
  } finally { await srv.stop({ keep: true }); if (srv2) await srv2.stop(); else fs.rmSync(srv.dir, { recursive: true, force: true }); }
});

test('production refuses a STAFF_PIN shorter than 6 characters', async () => {
  const short = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, PORT: '0', STAFF_PIN: '12345', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'booth-short-')) }, stdio: 'ignore' });
  assert.equal(await new Promise((r) => short.once('exit', r)), 1);
  const dev = await boot({ env: { STAFF_PIN: '1234', NODE_ENV: 'development' } });
  await dev.stop();
});

test('server refuses to start without STAFF_PIN unless NODE_ENV=development', async () => {
  const noPin = spawn(process.execPath, [SERVER], { env: { PATH: process.env.PATH, PORT: '0', STAFF_PIN: '', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'booth-nopin-')) }, stdio: 'ignore' });
  const code = await new Promise((r) => noPin.once('exit', r));
  assert.equal(code, 1);
  const dev = await boot({ env: { STAFF_PIN: '', NODE_ENV: 'development' } });
  try {
    assert.equal((await new Client(dev).post('/api/staff/login', { pin: '0000' })).status, 200);
  } finally { await dev.stop(); }
});

test('order flood: total orders per seat (incl. cancelled) capped at 40; lists keep only recent cancelled', async () => {
  const g = guest(); const T = tok(20);
  for (let i = 0; i < 40; i++) {
    const o = await order(g, T, [{ id: 'cola', qty: 1 }]);
    assert.equal(o.status, 201, `order ${i}: ${o.text}`);
    assert.equal((await g.post(`/api/t/${T}/orders/${o.json.order.id}/cancel`)).status, 200);
  }
  const over = await order(g, T, [{ id: 'cola', qty: 1 }]);
  assert.equal(over.status, 429); assert.equal(over.json.error, 'too_many_orders');
  const snap = (await g.get(`/api/t/${T}`)).json;
  assert.equal(snap.orders.length, 5);
  assert.ok(snap.orders.every((o) => o.status === 'cancelled'));
  const mine = async () => (await staff.get('/api/staff/state')).json.orders.filter((o) => o.table === 20);
  assert.equal((await mine()).length, 40); // just cancelled: still on the board
  const raw = new DatabaseSync(path.join(main.data, 'booth.db'));
  raw.exec('PRAGMA busy_timeout=3000');
  raw.prepare('UPDATE orders SET updated_at=updated_at-3600000 WHERE table_id=20').run();
  raw.close();
  assert.equal((await mine()).length, 0); // cancelled > 10 min ago are dropped from the staff list
  assert.equal((await staff.post('/api/staff/tables/20/clear')).status, 200); // only cancelled orders: nothing unsettled
  assert.equal((await order(g, T, [{ id: 'cola', qty: 1 }])).status, 201); // new seat, counter starts over
});

test('idempotency key is scoped to the seat: reuse after clear creates a new order', async () => {
  const g = guest(); const T = tok(12);
  const key = newKey();
  const a = await g.post(`/api/t/${T}/orders`, { key, items: [{ id: 'cola', qty: 1 }], note: 'first seating' });
  assert.equal(a.status, 201);
  assert.equal((await staff.post('/api/staff/tables/12/clear', { force: true })).status, 200);
  const b = await g.post(`/api/t/${T}/orders`, { key, items: [{ id: 'fries', qty: 1 }] });
  assert.equal(b.status, 201, b.text);
  assert.equal(b.json.duplicate, false);
  assert.equal(b.json.order.seat, 2);
  assert.notEqual(b.json.order.id, a.json.order.id);
  assert.equal(b.json.order.note, '');
  const c = await g.post(`/api/t/${T}/orders`, { key, items: [{ id: 'fries', qty: 1 }] });
  assert.equal(c.json.duplicate, true);
  assert.equal(c.json.order.id, b.json.order.id);
});

test('move table starts a new seating at the source: old plays cannot earn, calls resolved', async () => {
  const g = guest();
  const A = tok(30); const B = tok(31);
  const s = await startPlay(g, A, 'cheers');
  assert.equal(s.status, 200);
  assert.equal((await g.post(`/api/t/${A}/calls`, { type: '물' })).status, 200);
  await delay(260);
  assert.equal((await staff.post('/api/staff/tables/move', { from: 30, to: 31 })).status, 200);
  const snap = (await g.get(`/api/t/${A}`)).json;
  assert.equal(snap.table.seat, 2);
  assert.deepEqual(snap.calls, []);
  const fin = await g.post(`/api/t/${A}/plays/finish`, { playId: s.json.playId, score: 800 });
  assert.equal(fin.status, 404); // cannot earn a reward into the old seating
  assert.equal((await guest().get(`/api/t/${B}`)).json.coupons.length, 0);
  assert.equal((await staff.get('/api/staff/state')).json.calls.filter((c) => c.table === 30).length, 0);
});

test('plays are also rate limited per table seat', async () => {
  const T = tok(33);
  assert.equal((await guest().post(`/api/t/${T}/plays/start`, { game: 'pour' })).status, 200);
  const r = await guest().post(`/api/t/${T}/plays/start`, { game: 'pour' }); // different device, same seat, immediately
  assert.equal(r.status, 429);
  assert.equal(r.json.error, 'rate_limited');
  assert.ok(r.json.retryAfterMs > 0 && r.json.retryAfterMs <= 1000);
});

test('same-table concurrent finishes for one reward issue exactly one coupon; seat play caps', async () => {
  const srv = await boot({ env: { SEAT_PLAY_GAP_MS: '0', SEAT_OPEN_MAX: '12', SEAT_PLAY_MAX: '14' } });
  try {
    const s = await staffLogin(srv);
    const tk = (await s.get('/api/staff/tables')).json.tables.map((t) => t.token);
    const T = tk[0];
    const devs = Array.from({ length: 12 }, () => new Client(srv));
    const starts = await Promise.all(devs.map((d) => d.post(`/api/t/${T}/plays/start`, { game: 'cheers' })));
    starts.forEach((x) => assert.equal(x.status, 200, x.text));
    // 13th open play on this seat is refused
    const extra = await new Client(srv).post(`/api/t/${T}/plays/start`, { game: 'cheers' });
    assert.equal(extra.status, 429); assert.equal(extra.json.error, 'too_many_open');
    await delay(260);
    const fins = await Promise.all(devs.map((d, i) => d.post(`/api/t/${T}/plays/finish`, { playId: starts[i].json.playId, score: 750 })));
    const res = fins.map((f) => { assert.equal(f.status, 200, f.text); return f.json.rewards.find((r) => r.rewardId === 'd1000').result; });
    assert.equal(res.filter((r) => r === 'issued').length, 1);
    assert.equal(res.filter((r) => r === 'already_got').length, 11);
    assert.equal((await new Client(srv).get(`/api/t/${T}`)).json.coupons.filter((c) => c.rewardId === 'd1000').length, 1);
    // total cap per seat (14): 12 used, 2 more allowed, then seat_limit
    for (let i = 0; i < 2; i++) assert.equal((await new Client(srv).post(`/api/t/${T}/plays/start`, { game: 'pour' })).status, 200);
    const cap = await new Client(srv).post(`/api/t/${T}/plays/start`, { game: 'pour' });
    assert.equal(cap.status, 429); assert.equal(cap.json.error, 'seat_limit');
    // other seats are unaffected
    assert.equal((await new Client(srv).post(`/api/t/${tk[1]}/plays/start`, { game: 'pour' })).status, 200);
  } finally { await srv.stop(); }
});

test('wait list: global insert rate cap per minute', async () => {
  const srv = await boot();
  try {
    for (let i = 0; i < 30; i++) {
      const r = await new Client(srv).post('/api/wait', { nick: 'w' + i, size: 2 });
      assert.equal(r.status, 201, `${i}: ${r.text}`);
    }
    const r = await new Client(srv).post('/api/wait', { nick: 'late', size: 2 });
    assert.equal(r.status, 429); assert.equal(r.json.error, 'wait_rate');
  } finally { await srv.stop(); }
});

test('store: old cancelled/seated wait rows are pruned; backups keep hourly copies for 48h', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-store-'));
  const store = createStore({ dataDir: dir, menu: MENU, rewards: REWARDS, tableCount: 2 });
  try {
    const w = store.addWait('dev1', 'a', 2);
    store.waitCancel(w.id, w.secret);
    const raw = new DatabaseSync(path.join(dir, 'booth.db'));
    raw.exec('PRAGMA busy_timeout=3000');
    raw.prepare('UPDATE waitlist SET created_at=? WHERE id=?').run(Date.now() - 4 * 3600e3, w.id);
    const w2 = store.addWait('dev1', 'b', 2);
    assert.equal(raw.prepare('SELECT COUNT(*) n FROM waitlist WHERE id=?').get(w.id).n, 0);
    assert.equal(raw.prepare('SELECT COUNT(*) n FROM waitlist WHERE id=?').get(w2.id).n, 1);
    raw.close();

    const bdir = path.join(dir, 'backup');
    fs.mkdirSync(bdir);
    const name = (ms) => `booth-${new Date(ms).toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '-').slice(0, 19)}.db`;
    const now = Date.now();
    const made = [];
    for (let m = 60 * 5; m >= 60; m -= 10) { made.push(name(now - m * 60000)); } // every 10 min, 5h .. 1h ago
    const ancient = name(now - 60 * 3600e3);
    for (const f of [...made, ancient]) fs.writeFileSync(path.join(bdir, f), 'x');
    await store.backup(bdir, 12);
    const left = fs.readdirSync(bdir).sort();
    assert.ok(!left.includes(ancient), 'older than 48h is dropped');
    assert.ok(left.length < made.length, 'ten-minute copies are thinned');
    assert.deepEqual(left.slice(-12).filter((f) => made.includes(f)).length, 11); // the 11 newest 10-min copies survive (+ the fresh one)
    const hours = (arr) => new Set(arr.map((f) => f.slice(6, 17)));
    assert.deepEqual([...hours(left.filter((f) => made.includes(f)))].sort(), [...hours(made)].sort(), 'every hour still has a copy');
    // 30 hourly copies: only the newest 12 + the oldest copy of each of the 8 most recent older hours stay
    const dir2 = path.join(dir, 'backup2');
    fs.mkdirSync(dir2);
    const many = Array.from({ length: 30 }, (_, i) => name(now - (i + 2) * 3600e3 - 5000));
    for (const f of many) fs.writeFileSync(path.join(dir2, f), 'x');
    await store.backup(dir2, 12);
    assert.equal(fs.readdirSync(dir2).length, 12 + 8 - 0, 'newest 12 (incl. the fresh one) + 8 hourly');
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('SSE limits: oldest stream is closed per device and per table; staff pool is separate', async () => {
  const g = guest(); const T = tok(34);
  await g.get(`/api/t/${T}`);
  const streams = [];
  try {
    for (let i = 0; i < 6; i++) streams.push(await openSse(main, `/api/t/${T}/events`, { cookie: g.cookieHeader() }));
    await assert.rejects(streams[0].until(() => false, 2000), /closed/); // 6th stream evicted the oldest of this device
    await streams[5].until((b) => b.includes('event: state'));
    streams.splice(0, 6).forEach((x) => x.close());
    // per table: 12
    const T2 = tok(35);
    for (let i = 0; i < 13; i++) streams.push(await openSse(main, `/api/t/${T2}/events`, { cookie: `booth_d=${await realDevice(main)}` }));
    await assert.rejects(streams[0].until(() => false, 2000), /closed/);
    await streams[12].until((b) => b.includes('event: state'));
  } finally { streams.forEach((x) => x.close()); }
  const srv = await boot({ env: { SSE_PUBLIC_MAX: '6' } });
  const open = [];
  try {
    const s = await staffLogin(srv);
    const tk = (await s.get('/api/staff/tables')).json.tables;
    for (let i = 0; i < 6; i++) open.push(await openSse(srv, `/api/t/${tk[i].token}/events`, { cookie: `booth_d=${await realDevice(srv)}` }));
    const r = await fetch(srv.origin + `/api/t/${tk[7].token}/events`, { headers: { cookie: `booth_d=${await realDevice(srv)}` } });
    assert.equal(r.status, 503);
    await r.body.cancel();
    const board = await fetch(srv.origin + '/api/board/events');
    assert.equal(board.status, 503);
    await board.body.cancel();
    open.push(await openSse(srv, '/api/staff/events', { cookie: s.cookieHeader() })); // staff still gets in
    await open[6].until((b) => b.includes('event: state'));
  } finally { open.forEach((x) => x.close()); await srv.stop(); }
});

test('nicknames: invisible/filler characters and lone surrogates are not accepted as a name', async () => {
  const g = guest(); const T = tok(12);
  await g.get(`/api/t/${T}`);
  const nick = (n) => g.post(`/api/t/${T}/nick`, { nick: n });
  for (const bad of ['\u3164', '\u3164\u3164\u3164', '\u115F\u1160', '\uFFA0', '\u200b\u202e', '\u2800', '\ud800', '\u2800\u3164 ', 'ㅅㅂ', 'ｓｅｘ']) {
    const r = await nick(bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  assert.equal((await nick('ab\u3164')).json.nick, 'ab');
  assert.equal((await nick('\u202eㅋㅋ\ud800')).json.nick, 'ㅋㅋ'); // typed form kept (not NFKC-rewritten)
  assert.equal((await nick('😀')).json.nick, '😀');
});

test('reset takes a safety backup first', async () => {
  const srv = await boot();
  try {
    const s = await staffLogin(srv);
    const T = (await s.get('/api/staff/tables')).json.tables[0].token;
    assert.equal((await order(new Client(srv), T, [{ id: 'cola', qty: 1 }])).status, 201);
    assert.equal(fs.existsSync(path.join(srv.data, 'backup')), false);
    assert.equal((await s.post('/api/staff/reset', { confirm: '초기화' })).status, 200);
    const files = fs.readdirSync(path.join(srv.data, 'backup')).filter((f) => f.endsWith('.db'));
    assert.ok(files.length >= 1);
    const bk = new DatabaseSync(path.join(srv.data, 'backup', files[0]), { readOnly: true });
    assert.equal(bk.prepare('SELECT COUNT(*) n FROM orders').get().n, 1); // pre-reset state
    bk.close();
    assert.equal((await s.get('/api/staff/state')).json.orders.length, 0);
  } finally { await srv.stop(); }
});

test('sessions, stock, sold-out, tokens and idempotency keys survive a restart', async () => {
  const srv = await boot();
  let srv2;
  try {
    const s = await staffLogin(srv);
    const tables = (await s.get('/api/staff/tables')).json.tables;
    assert.equal((await s.post('/api/staff/rewards/drink/stock', { stock: 9 })).status, 200);
    assert.equal((await s.post('/api/staff/menu/cola/soldout', { soldOut: true })).status, 200);
    const key = newKey();
    const o = await new Client(srv).post(`/api/t/${tables[0].token}/orders`, { key, items: [{ id: 'fries', qty: 1 }] });
    assert.equal(o.status, 201);
    await srv.stop({ keep: true });
    srv2 = await boot({ dir: srv.dir });
    const s2 = new Client(srv2);
    s2.jar = { ...s.jar }; // the old session cookie, no new login
    const st = await s2.get('/api/staff/state');
    assert.equal(st.status, 200);
    assert.equal(st.json.rewards.find((r) => r.id === 'drink').stock, 9); // not reset to rewards.json (3)
    assert.equal(st.json.menu.items.find((i) => i.id === 'cola').soldOut, true);
    assert.deepEqual((await s2.get('/api/staff/tables')).json.tables, tables);
    const again = await new Client(srv2).post(`/api/t/${tables[0].token}/orders`, { key, items: [{ id: 'fries', qty: 1 }] });
    assert.equal(again.json.duplicate, true);
    assert.equal(again.json.order.id, o.json.order.id);
  } finally { await srv.stop({ keep: true }); if (srv2) await srv2.stop(); else fs.rmSync(srv.dir, { recursive: true, force: true }); }
});

test('duplicate cookie names: staff session and device id are found whichever value comes first', async () => {
  const valid = staff.jar.booth_s;
  const dev = await realDevice(main);
  const get = (cookie) => raw(main, 'GET', '/api/staff/me', { cookie });
  assert.equal((await get(`booth_s=stale; booth_s=${valid}`)).status, 200);
  assert.equal((await get(`booth_s=${valid}; booth_s=stale`)).status, 200);
  assert.equal((await get('booth_s=stale; booth_s=also-stale')).status, 401);
  // device id: first well-formed value wins, malformed ones are skipped
  const g = await raw(main, 'GET', `/api/t/${tok(36)}`, { cookie: `booth_d=junk; booth_d=${dev}` });
  assert.equal(g.status, 200);
  assert.equal(g.headers['set-cookie'], undefined); // no new device cookie was issued
  assert.equal((await raw(main, 'GET', `/api/t/${tok(36)}`, { cookie: 'booth_d=junk' })).headers['set-cookie'].length, 1);
  // a well-formed but unsigned / wrongly signed id is treated as absent: a fresh SIGNED cookie is issued
  for (const forged of [hex(), `${hex()}.${hex()}`, `${dev.split('.')[0]}.${'f'.repeat(32)}`, dev.split('.')[0]]) {
    const r = await raw(main, 'GET', `/api/t/${tok(36)}`, { cookie: `booth_d=${forged}` });
    assert.match(String(r.headers['set-cookie']), /booth_d=[a-f0-9]{32}\.[a-f0-9]{32};/, forged);
    assert.notEqual(String(r.headers['set-cookie']).split(';')[0], `booth_d=${forged}`);
  }
  // logout expires the cookie at the configured path and ends every valid session it carried
  const srv = await boot({ base: '/booth' });
  try {
    const c = new Client(srv);
    await c.post('/api/staff/login', { pin: PIN });
    const out = await c.post('/api/staff/logout');
    assert.match(c.setCookies.at(-1), /^booth_s=; Path=\/booth; .*Max-Age=0/);
    assert.equal(out.status, 200);
  } finally { await srv.stop(); }
});

test('nicknames need an existing device cookie and are capped per seat', async () => {
  const T = tok(39);
  const fresh = guest();
  const first = await fresh.post(`/api/t/${T}/nick`, { nick: 'ab' }); // no cookie yet: minted by this very request, does not count
  assert.equal(first.status, 400); assert.equal(first.json.error, 'no_device');
  assert.equal((await fresh.post(`/api/t/${T}/nick`, { nick: 'ab' })).status, 200); // cookie now exists
  assert.equal((await raw(main, 'POST', `/api/t/${T}/nick`, { 'content-type': 'application/json', cookie: 'booth_d=bogus' }, '{"nick":"x"}')).status, 400); // malformed cookie = no cookie
  for (let i = 1; i < 30; i++) {
    const g = guest();
    await g.get(`/api/t/${T}`);
    assert.equal((await g.post(`/api/t/${T}/nick`, { nick: 'n' + i })).status, 200, `nick ${i}`);
  }
  const over = guest();
  await over.get(`/api/t/${T}`);
  const r = await over.post(`/api/t/${T}/nick`, { nick: 'late' });
  assert.equal(r.status, 429); assert.equal(r.json.error, 'too_many_nicks');
  assert.equal((await fresh.post(`/api/t/${T}/nick`, { nick: 'renamed' })).status, 200); // existing rows can still change
  const raw2 = new DatabaseSync(path.join(main.data, 'booth.db'));
  raw2.exec('PRAGMA busy_timeout=3000');
  assert.equal(raw2.prepare('SELECT COUNT(*) n FROM nicks WHERE table_id=39').get().n, 30);
  raw2.close();
});

test('calls per seat are capped at 50 rows including resolved ones', async () => {
  const g = guest(); const T = tok(38);
  for (let i = 0; i < 50; i++) {
    const c = await g.post(`/api/t/${T}/calls`, { type: '물' });
    assert.equal(c.status, 200, `call ${i}: ${c.text}`);
    assert.equal((await staff.post(`/api/staff/calls/${c.json.call.id}/resolve`)).status, 200);
  }
  const over = await g.post(`/api/t/${T}/calls`, { type: '물' });
  assert.equal(over.status, 429); assert.equal(over.json.error, 'too_many_calls');
});

test('database size ceiling: writes fail with 503 storage_full, reads and the server survive', async () => {
  const srv = await boot({ env: { DB_MAX_BYTES: String(256 * 1024) } });
  try {
    const s = await staffLogin(srv);
    const tk = (await s.get('/api/staff/tables')).json.tables;
    let full = null;
    outer: for (let round = 0; round < 40; round++) {
      for (const t of tk) {
        const r = await new Client(srv).post(`/api/t/${t.token}/orders`, { key: newKey(), items: [{ id: 'tteokbokki', qty: 1 }, { id: 'odeng', qty: 1 }, { id: 'fries', qty: 1 }, { id: 'cola', qty: 1 }], note: 'n'.repeat(100) });
        if (r.status === 503) { full = r; break outer; }
        assert.equal(r.status, r.status === 429 ? 429 : 201, r.text);
      }
    }
    assert.ok(full, 'ceiling reached');
    assert.equal(full.json.error, 'storage_full');
    assert.equal((await new Client(srv).get('/api/health')).status, 200);
    assert.equal((await new Client(srv).get(`/api/t/${tk[0].token}`)).status, 200);
    assert.equal((await s.get('/api/staff/state')).status, 200);
  } finally { await srv.stop(); }
});

test('periodic backups are skipped above the size threshold; manual (reset) backups are not', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-skip-'));
  const store = createStore({ dataDir: dir, menu: MENU, rewards: REWARDS, tableCount: 1, backupSkipBytes: 1 });
  const orig = console.error; let logged = 0;
  console.error = () => { logged++; };
  try {
    const bdir = path.join(dir, 'backup');
    assert.equal(await store.backup(bdir, 12, { periodic: true }), false);
    assert.equal(await store.backup(bdir, 12, { periodic: true }), false);
    assert.equal(logged, 1, 'logged once');
    assert.equal(fs.existsSync(bdir), false);
    assert.equal(await store.backup(bdir, 12), true);
    assert.equal(fs.readdirSync(bdir).length, 1);
  } finally { console.error = orig; store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('staff login key (booth_k): exempt from the global lock, revoked after 5 wrong PINs; only hashes are stored', async () => {
  const srv = await boot({ env: { LOCKOUT_MS: '60000' } });
  try {
    const staffDev = new Client(srv);
    assert.equal((await staffDev.post('/api/staff/login', { pin: PIN })).status, 200);
    const k = staffDev.setCookies.find((c) => c.startsWith('booth_k='));
    assert.ok(k, 'booth_k issued on first login');
    assert.match(k, /HttpOnly/); assert.match(k, /SameSite=Lax/); assert.match(k, /Path=\//); assert.match(k, /Max-Age=2592000/);
    assert.match(staffDev.setCookies.find((c) => c.startsWith('booth_s=')), /Max-Age=259200/); // default 72 h
    // credentials are stored hashed
    const db = new DatabaseSync(path.join(srv.data, 'booth.db'), { readOnly: true });
    const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');
    assert.deepEqual(db.prepare('SELECT id FROM sessions').all().map((r) => r.id), [sha(staffDev.jar.booth_s)]);
    assert.deepEqual(db.prepare('SELECT hash FROM login_keys').all().map((r) => r.hash), [sha(staffDev.jar.booth_k)]);
    db.close();
    // an attacker locks the global login
    const bad = new Client(srv);
    for (let i = 0; i < 5; i++) await bad.post('/api/staff/login', { pin: 'nope' + i });
    assert.equal((await new Client(srv).post('/api/staff/login', { pin: PIN })).status, 429);
    // the keyed device still gets in (and keeps its key)
    const again = await staffDev.post('/api/staff/login', { pin: PIN });
    assert.equal(again.status, 200);
    assert.equal(staffDev.setCookies.filter((c) => c.startsWith('booth_k=')).length, 1, 'key is not re-issued');
    // wrong PIN with the key still fails, and 5 in a row revoke the key
    const results = [];
    for (let i = 0; i < 5; i++) results.push((await staffDev.post('/api/staff/login', { pin: 'wrong' + i })).json);
    assert.deepEqual(results.map((r) => r.attemptsLeft), [4, 3, 2, 1, 0]);
    assert.ok(!('booth_k' in staffDev.jar), 'revoked key cookie is cleared');
    assert.equal((await staffDev.post('/api/staff/login', { pin: PIN })).status, 429); // locked again, no key left
  } finally { await srv.stop(); }
  const short = await boot({ env: { SESSION_HOURS: '1' } });
  try {
    const c = new Client(short);
    await c.post('/api/staff/login', { pin: PIN });
    assert.match(c.setCookies.find((x) => x.startsWith('booth_s=')), /Max-Age=3600/);
  } finally { await short.stop(); }
});

test('waitlist switch: closing refuses registrations, clear cancels everyone', async () => {
  const srv = await boot();
  try {
    const s = await staffLogin(srv);
    const a = new Client(srv); const b = new Client(srv);
    const w1 = await a.post('/api/wait', { nick: '가', size: 2 });
    const w2 = await b.post('/api/wait', { nick: '나', size: 2 });
    assert.equal(w1.status, 201);
    assert.deepEqual((await a.get('/api/wait/info')).json, { open: true, waitingTotal: 2, notice: null });
    assert.equal((await s.get('/api/staff/state')).json.waitOpen, true);
    assert.equal((await s.post('/api/staff/waitlist/open', { open: 'no' })).status, 400);
    assert.equal((await s.post('/api/staff/waitlist/open', { open: false })).json.waitOpen, false);
    const closed = await new Client(srv).post('/api/wait', { nick: '다', size: 2 });
    assert.equal(closed.status, 403); assert.equal(closed.json.error, 'wait_closed');
    assert.equal((await a.get('/api/wait/info')).json.open, false);
    assert.equal((await s.get('/api/staff/state')).json.waitOpen, false);
    assert.equal((await a.get(`/api/wait/${w1.json.id}?secret=${w1.json.secret}`)).json.open, false);
    await s.post(`/api/staff/wait/${w1.json.id}/call`);
    const cl = await s.post('/api/staff/waitlist/clear');
    assert.equal(cl.status, 200); assert.equal(cl.json.cancelled, 2);
    assert.equal((await a.get(`/api/wait/${w1.json.id}?secret=${w1.json.secret}`)).json.status, 'cancelled');
    assert.equal((await b.get(`/api/wait/${w2.json.id}?secret=${w2.json.secret}`)).json.status, 'cancelled');
    assert.deepEqual((await s.get('/api/staff/state')).json.waitlist, []);
    assert.equal((await new Client(srv).post('/api/staff/waitlist/clear')).status, 401);
    assert.equal((await s.post('/api/staff/waitlist/open', { open: true })).status, 200);
    assert.equal((await new Client(srv).post('/api/wait', { nick: '라', size: 2 })).status, 201);
    // reset re-opens
    await s.post('/api/staff/waitlist/open', { open: false });
    await s.post('/api/staff/reset', { confirm: '초기화' });
    assert.equal((await a.get('/api/wait/info')).json.open, true);
  } finally { await srv.stop(); }
});

test('move table: equal idempotency keys in both seats do not break it; source guests get `cleared`', async () => {
  const gA = guest(); const gB = guest();
  const A = tok(27); const B = tok(28);
  await gA.get(`/api/t/${A}`);
  const key = newKey();
  assert.equal((await gA.post(`/api/t/${A}/orders`, { key, items: [{ id: 'cola', qty: 1 }] })).status, 201);
  assert.equal((await gB.post(`/api/t/${B}/orders`, { key, items: [{ id: 'fries', qty: 1 }] })).status, 201);
  const ev = await openSse(main, `/api/t/${A}/events`, { cookie: gA.cookieHeader() });
  try {
    await ev.until((b) => b.includes('event: state'));
    const mv = await staff.post('/api/staff/tables/move', { from: 27, to: 28 });
    assert.equal(mv.status, 200, mv.text);
    assert.equal(mv.json.orders, 1);
    assert.equal(mv.json.fromSeat, 2);
    await ev.until((b) => b.includes('event: cleared') && b.includes('"seat":2'));
    const snap = (await gB.get(`/api/t/${B}`)).json;
    assert.equal(snap.orders.length, 2);
    assert.equal(new Set(snap.orders.map((o) => o.id)).size, 2);
  } finally { ev.close(); }
});

test('board memo is invalidated by a table move', async () => {
  const g = guest();
  assert.equal((await playOnce(g, tok(25), 'cheers', 600)).status, 200);
  const rows = async () => (await guest().get('/api/board')).json.games.cheers.map((r) => r.table);
  assert.ok((await rows()).includes(25));
  assert.equal((await staff.post('/api/staff/tables/move', { from: 25, to: 26 })).status, 200);
  const after = await rows(); // read right after the move, inside the memo window
  assert.ok(after.includes(26) && !after.includes(25), JSON.stringify(after));
});

// ======================= member discount (fake club server) =======================
const ME_PATH = '/api/auth/me';
async function mkItem(s, name, price, category = '테스트') {
  const r = await s.post('/api/staff/menu/items', { name, price, category });
  assert.equal(r.status, 200, r.text);
  return r.json.item.id;
}
const hex = () => crypto.randomBytes(16).toString('hex');
// a server-issued (signed) booth_d value: any guest page sets one; /wait needs no table token
async function realDevice(srv) {
  const r = await fetch(srv.origin + srv.base + '/wait');
  await r.text();
  const sc = r.headers.getSetCookie().find((c) => c.startsWith('booth_d='));
  assert.ok(sc, 'server issued a device cookie');
  return sc.split(';')[0].slice('booth_d='.length);
}
const withToken = async (tk, extra = {}) => { const g = guest(); g.jar.token = tk; g.jar.booth_d = await realDevice(main); Object.assign(g.jar, extra); return g; };
// GET /member now also returns the staff-defined rule (spec change: it used to be { enabled, member, pct })
const memberBody = (over = {}) => ({ enabled: true, member: false, mode: 'percent', pct: 10, amount: 1000, minOrder: 0, maxDiscount: 0, stackWithCoupon: true, ...over });
let P500; let P900;

test('member discount: rounds DOWN to 100 won, member first then coupon, total floors at 0', async () => {
  P500 = await mkItem(staff, 'p500', 500);
  P900 = await mkItem(staff, 'p900', 900);
  const tk = fake.member(1001);
  const g = await withToken(tk);
  const T = tok(21);
  const lines = [{ id: 'tteokbokki', qty: 1 }, { id: P500, qty: 1 }]; // 8,500
  assert.equal((await staff.post('/api/staff/member-discount', { pct: 10 })).status, 200);
  const a = await order(g, T, lines);
  assert.equal(a.status, 201, a.text);
  assert.deepEqual([a.json.order.subtotal, a.json.order.memberDiscount, a.json.order.couponDiscount, a.json.order.discount, a.json.order.total, a.json.order.member], [8500, 800, 0, 800, 7700, true]);
  assert.equal((await staff.post('/api/staff/member-discount', { pct: 15 })).json.pct, 15);
  const b = await order(g, T, lines);
  assert.deepEqual([b.json.order.memberDiscount, b.json.order.total], [1200, 7300]); // 8500*15% = 1275 -> 1200
  await staff.post('/api/staff/member-discount', { pct: 10 });
  const c = await order(g, T, [{ id: P900, qty: 1 }]); // 900*10% = 90 -> 0
  assert.deepEqual([c.json.order.memberDiscount, c.json.order.total, c.json.order.member], [0, 900, true]);
  assert.equal(c.json.memberDiscountSkipped, undefined);
  // stacking: member first, then the coupon on what is left, never below 0
  const T2 = tok(22);
  const fin = await playOnce(g, T2, 'cheers', 950);
  const small = fin.json.coupons.find((x) => x.rewardId === 'd1000');
  const big = fin.json.coupons.find((x) => x.rewardId === 'dbig');
  const s1 = await order(g, T2, lines, { couponCode: small.code });
  assert.deepEqual([s1.json.order.memberDiscount, s1.json.order.couponDiscount, s1.json.order.discount, s1.json.order.total], [800, 1000, 1800, 6700]);
  const s2 = await order(g, T2, [{ id: 'tteokbokki', qty: 1 }, { id: 'fries', qty: 1 }], { couponCode: big.code }); // 14,000
  assert.deepEqual([s2.json.order.subtotal, s2.json.order.memberDiscount, s2.json.order.couponDiscount, s2.json.order.total], [14000, 1400, 12600, 0]);
  // cancel restores the coupon
  await staff.post(`/api/staff/orders/${s2.json.order.id}/status`, { status: 'cancelled' });
  assert.equal((await g.get(`/api/t/${T2}`)).json.coupons.find((x) => x.code === big.code).status, 'issued');
  // staff + guest views carry the numbers; the club id never leaks
  const st = (await staff.get('/api/staff/state')).json;
  const so = st.orders.find((o) => o.id === a.json.order.id);
  assert.deepEqual([so.memberDiscount, so.member, so.subtotal, so.total], [800, true, 8500, 7700]);
  assert.ok(!/memberId|member_id/i.test(JSON.stringify(st)));
  assert.ok(!/memberId|member_id/i.test((await g.get(`/api/t/${T}`)).text));
  assert.equal(st.memberDiscountPct, 10);
  assert.equal((await g.get(`/api/t/${T}`)).json.memberDiscountPct, 10);
});

test('member discount: staff setting is validated, pct 0 disables it', async () => {
  for (const bad of [-1, 51, 1.5, '10', null]) assert.equal((await staff.post('/api/staff/member-discount', { pct: bad })).status, 400, String(bad));
  assert.equal((await new Client(main).post('/api/staff/member-discount', { pct: 5 })).status, 401);
  const g = await withToken(fake.member(1002));
  await staff.post('/api/staff/member-discount', { pct: 0 });
  try {
    const r = await order(g, tok(23), [{ id: 'tteokbokki', qty: 1 }]);
    assert.deepEqual([r.json.order.memberDiscount, r.json.order.total, r.json.order.member], [0, 8000, true]);
    assert.equal(r.json.memberDiscountSkipped, undefined);
    assert.deepEqual((await g.get(`/api/t/${tok(23)}/member`)).json, memberBody({ member: true, pct: 0 }));
  } finally { await staff.post('/api/staff/member-discount', { pct: 10 }); }
});

test('member discount: anything but 200 + valid JSON means not a member, and the order still succeeds', async () => {
  const bigBody = JSON.stringify({ id: 5, role: 'USER', pad: 'x'.repeat(20000) });
  const cases = {
    unauthorized: { status: 401 },
    banned: { status: 403 },
    garbage: { status: 200, raw: 'not json at all' },
    emptyOk: { status: 200, raw: '' },
    stringId: { status: 200, json: { id: '5', role: 'USER' } },
    zeroId: { status: 200, json: { id: 0, role: 'USER' } },
    fractionalId: { status: 200, json: { id: 1.5, role: 'USER' } },
    badRole: { status: 200, json: { id: 5, role: 'HACKER' } },
    noRole: { status: 200, json: { id: 5 } },
    redirect: { status: 302, location: `${fake.url}/other` },
    tooBig: { status: 200, raw: bigBody },
    serverError: { status: 500, json: { id: 5, role: 'USER' } },
  };
  const T = tok(24);
  const otherBefore = fake.other.n;
  for (const [name, spec] of Object.entries(cases)) {
    const g = await withToken(fake.token(spec));
    const r = await order(g, T, [{ id: 'cola', qty: 1 }]);
    assert.equal(r.status, 201, `${name}: ${r.text}`);
    assert.deepEqual([r.json.order.memberDiscount, r.json.order.member, r.json.order.total], [0, false, 2000], name);
    assert.deepEqual((await g.get(`/api/t/${T}/member`)).json, memberBody({ member: false }), name);
    await staff.post(`/api/staff/orders/${r.json.order.id}/status`, { status: 'cancelled' }); // keep the seat under its pending cap
  }
  assert.equal(fake.other.n, otherBefore, 'redirect was not followed');
  // network failure: club server unreachable
  const dead = await boot({ env: { COMS_ME_URL: 'http://127.0.0.1:9/api/auth/me' } });
  try {
    const s = await staffLogin(dead);
    const T2 = (await s.get('/api/staff/tables')).json.tables[0].token;
    const g = new Client(dead); g.jar.token = fake.member(5); g.jar.booth_d = await realDevice(dead);
    const r = await order(g, T2, [{ id: 'cola', qty: 1 }]);
    assert.equal(r.status, 201); assert.equal(r.json.order.memberDiscount, 0);
  } finally { await dead.stop(); }
});

test('member discount: a slow club server (timeout 2 s) means not a member', async () => {
  const g = await withToken(fake.token({ status: 200, json: { id: 77, role: 'USER' }, delay: 3500 }));
  const t0 = Date.now();
  const r = await order(g, tok(24), [{ id: 'cola', qty: 1 }]);
  const took = Date.now() - t0;
  assert.equal(r.status, 201);
  assert.equal(r.json.order.memberDiscount, 0);
  assert.ok(took >= 1800, `waited for the club server before giving up: ${took} ms`);
  assert.equal(fake.hitsFor(g.jar.token)[0].sentAt, 0, 'the server gave up before the club server answered (ordering, not a wall-clock bound)');
  await staff.post(`/api/staff/orders/${r.json.order.id}/status`, { status: 'cancelled' });
});

test('member discount: malformed token cookies make no outbound request', async () => {
  const before = fake.hits.length;
  const T = tok(25);
  const dev0 = await realDevice(main);
  const bad = ['abc', 'a.b', 'a.b.c.d', 'a$.b.c', '.b.c', 'a..c', `${'a'.repeat(4100)}.b.c`, 'a b.c.d'];
  for (const tk of bad) {
    const r = await raw(main, 'GET', `/api/t/${T}/member`, { cookie: `token=${tk}; booth_d=${dev0}` });
    assert.equal(r.status, 200, tk.slice(0, 20));
    assert.equal(JSON.parse(r.text).member, false);
  }
  const r = await raw(main, 'GET', `/api/t/${T}/member`, { cookie: `booth_d=${dev0}` }); // no token at all
  assert.equal(JSON.parse(r.text).member, false);
  assert.equal(fake.hits.length, before, 'no request reached the club server');
});

test('member discount: only the token cookie is forwarded; results are cached for 60 s', async () => {
  const tk = fake.member(2001);
  const g = await withToken(tk, { other: '1', booth_s: 'staff-secret', booth_k: 'key-secret', session: 'abc' });
  const T = tok(26);
  await g.get(`/api/t/${T}`); // mints booth_d into the jar
  assert.ok(g.jar.booth_d);
  const r1 = await order(g, T, [{ id: 'cola', qty: 1 }]);
  assert.equal(r1.json.order.member, true);
  const mine = fake.hitsFor(tk);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].method, 'GET');
  assert.equal(mine[0].url, ME_PATH);
  assert.equal(mine[0].headers.cookie, `token=${tk}`, 'only the token cookie');
  assert.equal(mine[0].headers.authorization, undefined);
  for (let i = 0; i < 3; i++) assert.equal((await g.get(`/api/t/${T}/member`)).json.member, true);
  const r2 = await order(g, T, [{ id: 'cola', qty: 1 }]);
  assert.equal(r2.json.order.member, true);
  assert.equal(fake.hitsFor(tk).length, 1, 'cache hit: no second request within 60 s');
  // negative results are cached too
  const neg = fake.token({ status: 401 });
  const gn = await withToken(neg);
  for (let i = 0; i < 3; i++) await gn.get(`/api/t/${T}/member`);
  assert.equal(fake.hitsFor(neg).length, 1);
  // the token value itself is never in any response or log line the guest can see
  assert.ok(!r1.text.includes(tk));
});

test('member discount: client-sent member flags are ignored', async () => {
  const g = guest();
  const r = await order(g, tok(27), [{ id: 'tteokbokki', qty: 1 }], { member: true, isMember: true, memberDiscount: 5000, memberId: 1, pct: 50, couponDiscount: 100, discount: 100, total: 1 });
  assert.equal(r.status, 201);
  assert.deepEqual([r.json.order.memberDiscount, r.json.order.member, r.json.order.total], [0, false, 8000]);
  const h = await withToken(fake.token({ status: 401 }));
  const r2 = await order(h, tok(27), [{ id: 'tteokbokki', qty: 1 }], { member: true });
  assert.equal(r2.json.order.memberDiscount, 0);
});

test('member discount: replays return the original amounts even if pct, price or membership changed', async () => {
  const tk = fake.member(3001);
  const g = await withToken(tk);
  const T = tok(28);
  const key = newKey();
  const body = { key, items: [{ id: 'tteokbokki', qty: 1 }, { id: P500, qty: 1 }] };
  const a = await g.post(`/api/t/${T}/orders`, body);
  assert.deepEqual([a.json.order.memberDiscount, a.json.order.total], [800, 7700]);
  await staff.post('/api/staff/member-discount', { pct: 25 });
  await staff.post(`/api/staff/menu/items/tteokbokki`, { price: 9000 });
  fake.set(tk, { status: 401 }); // membership "lost"
  g.jar.token = tk; // same cookie; cached anyway, but also force a different identity below
  try {
    const b = await g.post(`/api/t/${T}/orders`, body);
    assert.equal(b.status, 200);
    assert.equal(b.json.duplicate, true);
    assert.deepEqual([b.json.order.id, b.json.order.memberDiscount, b.json.order.subtotal, b.json.order.total], [a.json.order.id, 800, 8500, 7700]);
    const nonMember = guest();
    const c = await nonMember.post(`/api/t/${T}/orders`, body); // same table+seat+key from a non-member browser: still the original
    assert.equal(c.json.order.id, a.json.order.id);
  } finally {
    await staff.post('/api/staff/member-discount', { pct: 10 });
    await staff.post(`/api/staff/menu/items/tteokbokki`, { price: 8000 });
  }
});

test('member discount: at most MEMBER_ORDER_MAX discounted orders per club member id (concurrent)', async () => {
  const srv = await boot({ env: { COMS_ME_URL: fake.url + ME_PATH, MEMBER_ORDER_MAX: '3' } });
  try {
    const s = await staffLogin(srv);
    const tk = (await s.get('/api/staff/tables')).json.tables;
    const p900 = (await s.post('/api/staff/menu/items', { name: 'p900', price: 900, category: '테스트' })).json.item.id;
    const id = 4001;
    const t1 = fake.member(id); const t2 = fake.member(id); // two sessions of the same club member
    const mk = async (t) => { const c = new Client(srv); c.jar.token = t; c.jar.booth_d = await realDevice(srv); return c; };
    const place = async (c, T = tk[0].token, items = [{ id: 'tteokbokki', qty: 1 }]) => order(await c, T, items); // c may be a pending mk(...)
    // 8 simultaneous orders across the cap boundary (cap 3): exactly 3 get the discount
    const burst = await Promise.all(Array.from({ length: 8 }, (_, i) => place(mk(i % 2 ? t1 : t2), tk[i % 3].token)));
    burst.forEach((r) => assert.equal(r.status, 201, r.text));
    const discounted = burst.filter((r) => r.json.order.memberDiscount === 800);
    const skipped = burst.filter((r) => r.json.memberDiscountSkipped === 'limit');
    assert.equal(discounted.length, 3, 'exactly the cap');
    assert.equal(skipped.length, 5);
    assert.ok(skipped.every((r) => r.json.order.memberDiscount === 0 && r.json.order.total === 8000 && r.json.order.member === true));
    // zero-discount orders (900 won) do not count toward the cap and are not "skipped"
    const tiny = await place(mk(t1), tk[3].token, [{ id: p900, qty: 1 }]);
    assert.equal(tiny.json.memberDiscountSkipped, undefined);
    // the cap is per member id, not per token or table; another member is unaffected
    assert.equal((await place(mk(t2), tk[4].token)).json.memberDiscountSkipped, 'limit');
    assert.equal((await place(mk(fake.member(4002)), tk[4].token)).json.order.memberDiscount, 800);
    // cancelling one frees exactly one slot, also under concurrency
    assert.equal((await s.post(`/api/staff/orders/${discounted[0].json.order.id}/status`, { status: 'cancelled' })).status, 200);
    const again = await Promise.all([place(mk(t1), tk[5].token), place(mk(t2), tk[6].token)]);
    assert.equal(again.filter((r) => r.json.order.memberDiscount === 800).length, 1);
    assert.equal(again.filter((r) => r.json.memberDiscountSkipped === 'limit').length, 1);
  } finally { await srv.stop(); }
});

test('member discount: feature off (no COMS_ME_URL) makes no outbound requests and never discounts', async () => {
  const srv = await boot();
  try {
    const before = fake.hits.length;
    const s = await staffLogin(srv);
    const T = (await s.get('/api/staff/tables')).json.tables[0].token;
    const g = new Client(srv); g.jar.token = fake.member(5001); g.jar.booth_d = await realDevice(srv);
    assert.deepEqual((await g.get(`/api/t/${T}/member`)).json, memberBody({ enabled: false, member: false }));
    const r = await order(g, T, [{ id: 'tteokbokki', qty: 1 }]);
    assert.deepEqual([r.json.order.memberDiscount, r.json.order.member, r.json.order.total], [0, false, 8000]);
    assert.equal(fake.hitsFor(g.jar.token).length, 0);
    assert.equal(fake.hits.length, before);
  } finally { await srv.stop(); }
});

test('member verification is bounded: 20 concurrent lookups at most, identical tokens share one request', async () => {
  const srv = await boot({ env: { COMS_ME_URL: fake.url + ME_PATH } });
  try {
    const s = await staffLogin(srv);
    const T = (await s.get('/api/staff/tables')).json.tables[0].token;
    const slow = () => fake.token({ status: 200, json: { id: 6000 + Math.floor(Math.random() * 1e6), role: 'USER' }, delay: 400 });
    const toks = Array.from({ length: 40 }, slow);
    const before = fake.hits.length;
    const res = await Promise.all(toks.map(async (t) => { const c = new Client(srv); c.jar.token = t; c.jar.booth_d = await realDevice(srv); return c.get(`/api/t/${T}/member`); }));
    const members = res.filter((r) => r.json.member).length;
    const calls = fake.hits.length - before;
    assert.ok(members >= 1 && members <= 20, `members ${members}`);
    assert.ok(calls <= 20, `outbound ${calls}`);
    // 10 concurrent requests with the very same token -> one outbound call
    await delay(1100); // let the per-second outbound window drain
    const one = slow();
    const b2 = fake.hits.length;
    const same = await Promise.all(Array.from({ length: 10 }, async () => { const c = new Client(srv); c.jar.token = one; c.jar.booth_d = await realDevice(srv); return c.get(`/api/t/${T}/member`); }));
    assert.ok(same.every((r) => r.json.member === true));
    assert.equal(fake.hits.length - b2, 1, 'one shared outbound request');
  } finally { await srv.stop(); }
});

// ======================= menu management =======================
test('menu: staff can create, update, hide and delete items; guests never see hidden ones', async () => {
  const s = staff;
  assert.equal((await new Client(main).post('/api/staff/menu/items', { name: 'x', price: 100, category: 'c' })).status, 401);
  const created = await s.post('/api/staff/menu/items', { name: '  새\u0000 메뉴  ', price: 7500 + 500, category: '신메뉴류', desc: '설명' });
  assert.equal(created.status, 200, created.text);
  const it = created.json.item;
  assert.match(it.id, /^m[0-9a-f]{10}$/);
  assert.deepEqual([it.name, it.price, it.cat, it.desc, it.hidden, it.soldOut, it.inUse], ['새 메뉴', 8000, '신메뉴류', '설명', false, false, false]);
  assert.ok(created.json.menu.categoryList.some((c) => c.name === '신메뉴류' && c.itemCount === 1));
  const guestMenu = async () => (await guest().get('/api/menu')).json;
  assert.ok((await guestMenu()).items.some((i) => i.id === it.id));
  // duplicate name
  assert.equal((await s.post('/api/staff/menu/items', { name: '새 메뉴', price: 100, category: '신메뉴류' })).json.error, 'name_taken');
  // update
  const up = await s.post(`/api/staff/menu/items/${it.id}`, { name: '새 메뉴2', price: 9000, desc: '', category: '안주', sortOrder: 3 });
  assert.deepEqual([up.json.item.name, up.json.item.price, up.json.item.cat, up.json.item.desc, up.json.item.sortOrder], ['새 메뉴2', 9000, '안주', '', 3]);
  assert.ok(!(await guestMenu()).categories.includes('신메뉴류'), 'a category without visible items is not shown');
  assert.equal((await s.post(`/api/staff/menu/items/${it.id}`, {})).json.error, 'nothing_to_update');
  assert.equal((await s.post(`/api/staff/menu/items/${it.id}`, { name: '떡볶이' })).json.error, 'name_taken');
  assert.equal((await s.post('/api/staff/menu/items/nope', { price: 100 })).status, 404);
  // hide: gone for guests (menu, snapshot, ordering) but visible for staff
  assert.equal((await s.post(`/api/staff/menu/items/${it.id}`, { hidden: 'yes' })).status, 400);
  const hid = await s.post(`/api/staff/menu/items/${it.id}`, { hidden: true });
  assert.equal(hid.json.item.hidden, true);
  const T = tok(29);
  const g = guest();
  assert.ok(!(await guestMenu()).items.some((i) => i.id === it.id));
  assert.ok(!(await g.get(`/api/t/${T}`)).json.menu.items.some((i) => i.id === it.id));
  const hiddenOrder = await order(g, T, [{ id: it.id, qty: 1 }]);
  assert.equal(hiddenOrder.status, 400);
  assert.equal(hiddenOrder.json.error, 'unknown_item');
  assert.deepEqual(hiddenOrder.json.ids, [it.id]);
  const st = (await s.get('/api/staff/state')).json.menu;
  assert.equal(st.items.find((i) => i.id === it.id).hidden, true);
  // sold-out: still listed, cannot be ordered
  await s.post(`/api/staff/menu/items/${it.id}`, { hidden: false });
  await s.post(`/api/staff/menu/${it.id}/soldout`, { soldOut: true });
  assert.equal((await guestMenu()).items.find((i) => i.id === it.id).soldOut, true);
  assert.equal((await order(g, T, [{ id: it.id, qty: 1 }])).json.error, 'sold_out');
  await s.post(`/api/staff/menu/${it.id}/soldout`, { soldOut: false });
  // an ordered item cannot be deleted, an unused one can
  const o = await order(g, T, [{ id: it.id, qty: 1 }]);
  assert.equal(o.status, 201);
  const del = await s.post(`/api/staff/menu/items/${it.id}/delete`);
  assert.equal(del.status, 409); assert.equal(del.json.error, 'in_use');
  assert.equal((await s.get('/api/staff/state')).json.menu.items.find((i) => i.id === it.id).inUse, true);
  const fresh = await mkItem(s, '지울 메뉴', 100, '안주');
  assert.equal((await s.post(`/api/staff/menu/items/${fresh}/delete`)).status, 200);
  assert.ok(!(await s.get('/api/staff/state')).json.menu.items.some((i) => i.id === fresh));
  assert.equal((await s.post(`/api/staff/menu/items/${fresh}/delete`)).status, 404);
  await s.post(`/api/staff/orders/${o.json.order.id}/status`, { status: 'cancelled' });
});

test('menu: validation limits', async () => {
  const s = staff;
  const bad = async (body, code, status = 400) => {
    const r = await s.post('/api/staff/menu/items', { name: 'v' + crypto.randomBytes(3).toString('hex'), price: 1000, category: '안주', ...body });
    assert.equal(r.status, status, JSON.stringify(body) + r.text);
    assert.equal(r.json.error, code, JSON.stringify(body));
  };
  await bad({ name: '' }, 'bad_name');
  await bad({ name: '   ' }, 'bad_name');
  await bad({ name: '\u0000​' }, 'bad_name');
  await bad({ name: 'a'.repeat(31) }, 'bad_name');
  await bad({ name: 5 }, 'bad_name');
  await bad({ price: 250 }, 'bad_price');
  await bad({ price: -100 }, 'bad_price');
  await bad({ price: 1000100 }, 'bad_price');
  await bad({ price: 1.5 }, 'bad_price');
  await bad({ price: '1000' }, 'bad_price');
  await bad({ price: null }, 'bad_price');
  await bad({ desc: 'd'.repeat(61) }, 'bad_desc');
  await bad({ category: '' }, 'bad_category');
  await bad({ category: 'c'.repeat(13) }, 'bad_category');
  const ok = await s.post('/api/staff/menu/items', { name: 'a'.repeat(30), price: 1000000, category: 'c'.repeat(12), desc: 'd'.repeat(60) });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((await s.post(`/api/staff/menu/items/${ok.json.item.id}`, { price: 0 })).json.item.price, 0);
  await s.post(`/api/staff/menu/items/${ok.json.item.id}/delete`);
  assert.equal((await s.post(`/api/staff/menu/items/${ok.json.item.id}`, { price: 150 })).status, 404);
});

test('menu: at most 100 items and 12 categories', async () => {
  const srv = await boot();
  try {
    const s = await staffLogin(srv);
    const have = (await s.get('/api/staff/state')).json.menu;
    for (let i = have.items.length; i < 100; i++) assert.equal((await s.post('/api/staff/menu/items', { name: 'item' + i, price: 100, category: '안주' })).status, 200);
    const r = await s.post('/api/staff/menu/items', { name: 'one too many', price: 100, category: '안주' });
    assert.equal(r.status, 409); assert.equal(r.json.error, 'too_many_items');
    const cats = have.categoryList.length;
    for (let i = cats; i < 12; i++) assert.equal((await s.post('/api/staff/menu/categories', { name: 'cat' + i })).status, 200);
    const c = await s.post('/api/staff/menu/categories', { name: 'cat-13' });
    assert.equal(c.status, 409); assert.equal(c.json.error, 'too_many_categories');
    // creating an item in a NEW category is blocked by the same limit
    assert.equal((await s.post(`/api/staff/menu/items/${have.items[0].id}`, { category: 'brand new' })).json.error, 'too_many_categories');
  } finally { await srv.stop(); }
});

test('menu: categories can be created, renamed, reordered and deleted only when empty', async () => {
  const srv = await boot();
  try {
    const s = await staffLogin(srv);
    const cat = await s.post('/api/staff/menu/categories', { name: '디저트' });
    assert.equal(cat.status, 200, cat.text);
    const id = cat.json.category.id;
    assert.equal((await s.post('/api/staff/menu/categories', { name: '디저트' })).json.error, 'name_taken');
    assert.equal((await s.post('/api/staff/menu/categories', { name: '' })).json.error, 'bad_category');
    assert.equal((await s.post(`/api/staff/menu/categories/${id}`, { name: '후식' })).json.category.name, '후식');
    assert.equal((await s.post(`/api/staff/menu/categories/${id}`, { name: '안주' })).json.error, 'name_taken');
    assert.equal((await s.post('/api/staff/menu/categories/999', { name: 'x' })).status, 404);
    // an empty category is not shown to guests
    assert.ok(!(await new Client(srv).get('/api/menu')).json.categories.includes('후식'));
    const item = await mkItem(s, '푸딩', 3000, '후식');
    assert.ok((await new Client(srv).get('/api/menu')).json.categories.includes('후식'));
    const notEmpty = await s.post(`/api/staff/menu/categories/${id}/delete`);
    assert.equal(notEmpty.status, 409); assert.equal(notEmpty.json.error, 'category_not_empty');
    // move the item away, then the category can go
    await s.post(`/api/staff/menu/items/${item}`, { category: '음료' });
    assert.equal((await s.post(`/api/staff/menu/categories/${id}/delete`)).status, 200);
    assert.ok(!(await s.get('/api/staff/state')).json.menu.categoryList.some((c) => c.id === id));
    assert.equal((await s.post(`/api/staff/menu/categories/${id}/delete`)).status, 404);
    // reorder
    const m0 = (await s.get('/api/staff/state')).json.menu;
    const catIds = m0.categoryList.map((c) => c.id).reverse();
    const itemIds = m0.items.map((i) => i.id).reverse();
    const re = await s.post('/api/staff/menu/reorder', { categories: catIds, items: itemIds });
    assert.equal(re.status, 200, re.text);
    assert.deepEqual(re.json.menu.categoryList.map((c) => c.id), catIds);
    const guestItems = (await new Client(srv).get('/api/menu')).json;
    assert.deepEqual(guestItems.categories, re.json.menu.categoryList.map((c) => c.name));
    const byCat = (cat) => guestItems.items.filter((i) => i.cat === cat).map((i) => i.id);
    for (const c of guestItems.categories) assert.deepEqual(byCat(c), itemIds.filter((x) => byCat(c).includes(x)), c);
    for (const bad of [{}, { items: 'x' }, { items: ['nope'] }, { items: [itemIds[0], itemIds[0]] }, { categories: ['1'] }]) {
      assert.ok([400, 404].includes((await s.post('/api/staff/menu/reorder', bad)).status), JSON.stringify(bad));
    }
  } finally { await srv.stop(); }
});

test('menu: price changes and renames never touch existing orders; expectedTotal guards stale carts', async () => {
  const g = guest(); const T = tok(32);
  const id = await mkItem(staff, '한정 메뉴', 3000, '안주');
  const o = await order(g, T, [{ id, qty: 2 }]);
  assert.equal(o.status, 201);
  assert.deepEqual([o.json.order.total, o.json.order.items[0].unitPrice, o.json.order.items[0].name], [6000, 3000, '한정 메뉴']);
  await staff.post(`/api/staff/orders/${o.json.order.id}/status`, { status: 'cooking' });
  await staff.post(`/api/staff/menu/items/${id}`, { price: 4500 + 500, name: '한정 메뉴 개명' });
  const snap = (await g.get(`/api/t/${T}`)).json;
  const mine = snap.orders.find((x) => x.id === o.json.order.id);
  assert.deepEqual([mine.total, mine.subtotal, mine.items[0].unitPrice, mine.items[0].name], [6000, 6000, 3000, '한정 메뉴']);
  const sorder = (await staff.get('/api/staff/state')).json.orders.find((x) => x.id === o.json.order.id);
  assert.deepEqual([sorder.total, sorder.items[0].unitPrice, sorder.items[0].name], [6000, 3000, '한정 메뉴']);
  assert.equal((await staff.get('/api/kitchen')).json.orders.find((x) => x.id === o.json.order.id).items[0].name, '한정 메뉴');
  // a cart priced at the old price is refused when it states its expected total
  const countOrders = async () => (await staff.get('/api/staff/state')).json.orders.filter((x) => x.table === 32).length;
  const before = await countOrders();
  const key = newKey();
  const stale = await g.post(`/api/t/${T}/orders`, { key, items: [{ id, qty: 2 }], expectedTotal: 6000 });
  assert.equal(stale.status, 409, stale.text);
  assert.equal(stale.json.error, 'price_changed');
  assert.deepEqual([stale.json.expectedTotal, stale.json.total, stale.json.subtotal, stale.json.memberDiscount, stale.json.couponDiscount], [6000, 10000, 10000, 0, 0]);
  assert.deepEqual(stale.json.items, [{ id, name: '한정 메뉴 개명', qty: 2, unitPrice: 5000 }]);
  assert.equal(await countOrders(), before, 'no order was created');
  // confirming with the fresh total works (same key, since nothing was created)
  const ok = await g.post(`/api/t/${T}/orders`, { key, items: [{ id, qty: 2 }], expectedTotal: 10000 });
  assert.equal(ok.status, 201, ok.text);
  assert.deepEqual([ok.json.order.total, ok.json.order.items[0].unitPrice, ok.json.order.items[0].name], [10000, 5000, '한정 메뉴 개명']);
  // without expectedTotal the current price is simply charged; a non-integer is rejected
  assert.equal((await order(g, T, [{ id, qty: 1 }])).json.order.total, 5000);
  assert.equal((await g.post(`/api/t/${T}/orders`, { key: newKey(), items: [{ id, qty: 1 }], expectedTotal: '5000' })).json.error, 'bad_expected_total');
  // expectedTotal is compared against the total AFTER discounts
  const m = await withToken(fake.member(8001));
  const r = await m.post(`/api/t/${T}/orders`, { key: newKey(), items: [{ id, qty: 2 }], expectedTotal: 10000 }); // would be 9000 for a member
  assert.equal(r.status, 409);
  assert.deepEqual([r.json.subtotal, r.json.memberDiscount, r.json.total], [10000, 1000, 9000]);
  assert.equal((await m.post(`/api/t/${T}/orders`, { key: newKey(), items: [{ id, qty: 2 }], expectedTotal: 9000 })).status, 201);
  // duplicates are answered from the stored order before any total check
  const dupe = await g.post(`/api/t/${T}/orders`, { key, items: [{ id, qty: 2 }], expectedTotal: 1 });
  assert.equal(dupe.status, 200); assert.equal(dupe.json.duplicate, true);
  // sales use the stored (order-time) names
  const sales = (await staff.get('/api/staff/sales')).json.byItem.filter((i) => i.id === id);
  assert.equal(sales.length, 1);
  assert.equal(sales[0].name, '한정 메뉴 개명'); // latest name for the id; old rows keep their own names in the orders themselves
});

test('menu + settings survive a reset; sold-out flags do not', async () => {
  const srv = await boot();
  try {
    const s = await staffLogin(srv);
    const c = (p, b) => s.post(p, b);
    await c('/api/staff/menu/items/cola', { price: 2500, name: '콜라 제로', hidden: true });
    await c('/api/staff/menu/cola/soldout', { soldOut: true });
    await c('/api/staff/menu/odeng/soldout', { soldOut: true });
    const nid = await mkItem(s, '리셋 후에도', 1000, '신규');
    await c('/api/staff/member-discount', { pct: 25 });
    await c('/api/staff/waitlist/open', { open: false });
    await c('/api/staff/ordering', { open: false });
    assert.equal((await c('/api/staff/reset', { confirm: '초기화' })).status, 200);
    const st = (await s.get('/api/staff/state')).json;
    const cola = st.menu.items.find((i) => i.id === 'cola');
    assert.deepEqual([cola.price, cola.name, cola.hidden, cola.soldOut], [2500, '콜라 제로', true, false]);
    assert.equal(st.menu.items.find((i) => i.id === 'odeng').soldOut, false);
    assert.ok(st.menu.items.some((i) => i.id === nid));
    assert.equal(st.memberDiscountPct, 25);
    assert.equal(st.waitOpen, true); // as before: the waitlist switch resets
    assert.equal(st.orderingOpen, true); // as before
  } finally { await srv.stop(); }
});

test('menu.json only seeds an empty menu; later edits survive restarts', async () => {
  const srv = await boot();
  let srv2;
  try {
    const s = await staffLogin(srv);
    assert.equal((await s.post('/api/staff/menu/items/cola', { price: 2500 })).status, 200);
    const added = await mkItem(s, '손님이 만든 메뉴', 1200, '음료');
    await s.post('/api/staff/menu/odeng/soldout', { soldOut: true });
    await srv.stop({ keep: true });
    // the file changes on disk: it must NOT be applied again
    const cfg = path.join(srv.dir, 'cfg', 'menu.json');
    const changed = { categories: ['딴것'], items: [{ id: 'cola', name: '콜라', price: 9900, cat: '딴것' }, { id: 'brandnew', name: '새 파일 메뉴', price: 100, cat: '딴것' }] };
    fs.writeFileSync(cfg, JSON.stringify(changed));
    srv2 = await boot({ dir: srv.dir });
    const s2 = await staffLogin(srv2);
    const menu = (await s2.get('/api/staff/state')).json.menu;
    assert.equal(menu.items.find((i) => i.id === 'cola').price, 2500);
    assert.ok(menu.items.some((i) => i.id === added));
    assert.ok(!menu.items.some((i) => i.id === 'brandnew'));
    assert.ok(!menu.categoryList.some((c) => c.name === '딴것'));
    assert.equal(menu.items.find((i) => i.id === 'odeng').soldOut, true, 'sold-out lives on the item and persists');
    assert.equal(menu.items.length, MENU.items.length + 1);
  } finally { await srv.stop({ keep: true }); if (srv2) await srv2.stop(); else fs.rmSync(srv.dir, { recursive: true, force: true }); }
});

test('menu edits are pushed over SSE to guests, staff and the kitchen channel', async () => {
  const T = tok(36);
  const g = guest();
  await g.get(`/api/t/${T}`);
  const gs = await openSse(main, `/api/t/${T}/events`, { cookie: g.cookieHeader() });
  const ss = await openSse(main, '/api/staff/events', { cookie: staff.cookieHeader() });
  const ks = await openSse(main, '/api/kitchen/events', { cookie: staff.cookieHeader() });
  try {
    await gs.until((b) => b.includes('event: state'));
    await ss.until((b) => b.includes('event: state'));
    await ks.until((b) => b.includes('event: state'));
    assert.equal((await staff.post('/api/staff/menu/items/fries', { price: 6500 })).status, 200);
    await gs.until((b) => b.includes('"id":"fries"') && b.includes('"price":6500'));
    await ss.until((b) => b.includes('"price":6500'));
    assert.equal((await staff.post('/api/staff/menu/items/fries', { price: 6000 })).status, 200);
    await gs.until((b) => b.lastIndexOf('"price":6000') > b.lastIndexOf('"price":6500'));
  } finally { gs.close(); ss.close(); ks.close(); }
});

// ======================= upgrade of an existing booth.db =======================
test('an existing booth.db created by the previous schema is upgraded in place on boot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-legacy-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const old = new DatabaseSync(path.join(dir, 'data', 'booth.db'));
  old.exec(OLD_SCHEMA);
  const legacyTokens = [];
  for (let i = 1; i <= 40; i++) {
    const t = crypto.randomBytes(12).toString('base64url');
    legacyTokens.push(t);
    old.prepare('INSERT INTO tables(id, token) VALUES(?,?)').run(i, t);
  }
  old.prepare("INSERT INTO sold_out(item_id) VALUES('cola')").run();
  old.prepare("INSERT INTO sessions(id, expires_at) VALUES('plaintext-old-session', ?)").run(Date.now() + 3600e3);
  const ts = Date.now();
  const oid = Number(old.prepare("INSERT INTO orders(table_id,seat,key,status,paid,subtotal,discount,total,note,created_at,updated_at) VALUES(1,1,'legacy-key-0001','pending',0,10000,1000,9000,'옛 주문',?,?)").run(ts, ts).lastInsertRowid);
  old.prepare("INSERT INTO order_items(order_id,item_id,name,unit_price,qty) VALUES(?,?,?,?,?)").run(oid, 'tteokbokki', '옛 떡볶이', 5000, 2);
  assert.ok(!old.prepare('PRAGMA table_info(orders)').all().some((c) => c.name === 'member_discount'), 'fixture really has the old schema');
  assert.equal(old.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='menu_items'").get().n, 0);
  old.close();
  let srv; let srv2;
  try {
    srv = await boot({ dir, env: { COMS_ME_URL: fake.url + ME_PATH } });
    const s = await staffLogin(srv);
    const st = (await s.get('/api/staff/state')).json;
    assert.deepEqual(st.menu.items.map((i) => i.id), MENU.items.map((i) => i.id), 'menu seeded from menu.json');
    assert.equal(st.menu.items.find((i) => i.id === 'cola').soldOut, true, 'legacy sold_out flag carried over');
    assert.deepEqual(st.menu.categories, MENU.categories);
    assert.equal(st.memberDiscountPct, 10);
    assert.deepEqual((await s.get('/api/staff/tables')).json.tables.map((t) => t.token), legacyTokens, 'table tokens (printed QR codes) unchanged');
    const legacy = st.orders.find((o) => o.id === oid);
    assert.deepEqual([legacy.subtotal, legacy.couponDiscount, legacy.memberDiscount, legacy.discount, legacy.total, legacy.member, legacy.items[0].name, legacy.items[0].unitPrice],
      [10000, 1000, 0, 1000, 9000, false, '옛 떡볶이', 5000]);
    assert.equal((await new Client(srv).get('/api/staff/state')).status, 401);
    const stale = new Client(srv); stale.jar.booth_s = 'plaintext-old-session';
    assert.equal((await stale.get('/api/staff/state')).status, 401, 'old plaintext sessions are not valid (staff log in again)');
    // new orders (with a member) work on the upgraded DB
    const g = new Client(srv); g.jar.token = fake.member(9001); g.jar.booth_d = await realDevice(srv);
    const r = await order(g, legacyTokens[1], [{ id: 'tteokbokki', qty: 1 }]);
    assert.equal(r.status, 201, r.text);
    assert.deepEqual([r.json.order.memberDiscount, r.json.order.total], [800, 7200]);
    await srv.stop({ keep: true });
    // booting again is a no-op: no duplicate menu rows, no failing ALTERs
    srv2 = await boot({ dir });
    const s2 = await staffLogin(srv2);
    const st2 = (await s2.get('/api/staff/state')).json;
    assert.equal(st2.menu.items.length, MENU.items.length);
    assert.equal(st2.orders.length, 2);
    const chk = new DatabaseSync(path.join(dir, 'data', 'booth.db'), { readOnly: true });
    const cols = chk.prepare('PRAGMA table_info(orders)').all().map((c) => c.name);
    assert.ok(cols.includes('member_discount') && cols.includes('member_id'));
    assert.equal(chk.prepare("SELECT member_id FROM orders WHERE id=?").get(oid).member_id, null);
    chk.close();
  } finally { if (srv) await srv.stop({ keep: true }); if (srv2) await srv2.stop({ keep: true }); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('member cache: only definitive answers (200 member, 401, 403) are cached; errors, 5xx, 429, redirects, bad 200s are not', async () => {
  const good = { status: 200, json: { id: 31, role: 'USER' } };
  // not cached -> a later success is honoured at once
  for (const [name, bad] of Object.entries({
    server500: { status: 500 }, tooMany: { status: 429 }, unavailable: { status: 503 },
    redirect: { status: 302, location: `${fake.url}/other` }, garbage: { status: 200, raw: '<html>maintenance</html>' },
    wrongShape: { status: 200, json: { id: 'x', role: 'USER' } },
  })) {
    const tk = fake.token(bad);
    const g = await withToken(tk);
    const T = tok(24);
    assert.equal((await g.get(`/api/t/${T}/member`)).json.member, false, name);
    fake.set(tk, good); // the club backend recovered
    assert.equal((await g.get(`/api/t/${T}/member`)).json.member, true, `${name}: recovered member is recognised immediately`);
    assert.equal(fake.hitsFor(tk).length, 2, name);
  }
  // definitive negatives stay cached for the TTL
  for (const status of [401, 403]) {
    const tk = fake.token({ status });
    const g = await withToken(tk);
    assert.equal((await g.get(`/api/t/${tok(24)}/member`)).json.member, false);
    fake.set(tk, good);
    assert.equal((await g.get(`/api/t/${tok(24)}/member`)).json.member, false, `${status} cached`);
    assert.equal(fake.hitsFor(tk).length, 1);
  }
  // timeouts are not cached either
  const slow = fake.token({ status: 200, json: { id: 31, role: 'USER' }, delay: 2600 });
  const gs = await withToken(slow);
  assert.equal((await gs.get(`/api/t/${tok(24)}/member`)).json.member, false);
  fake.set(slow, good);
  assert.equal((await gs.get(`/api/t/${tok(24)}/member`)).json.member, true);
  assert.equal(fake.hitsFor(slow).length, 2);
});

test('member lookups are capped per device (booth_d); no device cookie means no lookup; other devices are unaffected', async () => {
  const T = tok(25);
  const dev = await realDevice(main);
  const toks = Array.from({ length: 8 }, (_, i) => fake.member(7000 + i));
  const g = guest(); g.jar.booth_d = dev;
  const results = [];
  for (const tk of toks) { g.jar.token = tk; results.push((await g.get(`/api/t/${T}/member`)).json.member); }
  assert.deepEqual(results, [true, true, true, true, true, true, false, false], 'a device gets 6 uncached lookups per minute');
  assert.equal(fake.hitsFor(toks[6]).length + fake.hitsFor(toks[7]).length, 0, 'no outbound request beyond the device cap');
  g.jar.token = toks[0]; // cache hits do not use up the budget
  assert.equal((await g.get(`/api/t/${T}/member`)).json.member, true);
  // a real member on another device is not locked out by the sprayer
  const real = await withToken(fake.member(7100));
  assert.equal((await real.get(`/api/t/${T}/member`)).json.member, true);
  // no existing valid booth_d: not a member and no outbound request, even with a valid token
  const before = fake.hits.length;
  const t2 = fake.member(7200);
  assert.equal(JSON.parse((await raw(main, 'GET', `/api/t/${T}/member`, { cookie: `token=${t2}` })).text).member, false);
  assert.equal(JSON.parse((await raw(main, 'GET', `/api/t/${T}/member`, { cookie: `token=${t2}; booth_d=junk` })).text).member, false);
  // forged but well-formed ids (unsigned, or signed with the wrong key) are not devices: no lookup either
  const realId = dev.split('.')[0];
  for (const forged of [hex(), `${hex()}.${hex()}`, `${realId}.${'0'.repeat(32)}`, realId]) {
    assert.equal(JSON.parse((await raw(main, 'GET', `/api/t/${T}/member`, { cookie: `token=${t2}; booth_d=${forged}` })).text).member, false, forged);
  }
  assert.equal(fake.hits.length, before);
  // ordering behaves the same way: without a device cookie there is no discount
  const noDev = guest(); noDev.jar.token = t2;
  const r = await order(noDev, tok(25), [{ id: 'tteokbokki', qty: 1 }]);
  assert.equal(r.json.order.memberDiscount, 0);
  await staff.post(`/api/staff/orders/${r.json.order.id}/status`, { status: 'cancelled' });
});

test('member cache: non-member results can never evict cached members', async () => {
  const srv = await boot({ env: { COMS_ME_URL: fake.url + ME_PATH, MEMBER_CACHE_MAX: '3' } });
  try {
    const s = await staffLogin(srv);
    const T = (await s.get('/api/staff/tables')).json.tables[0].token;
    const probe = async (tk) => { const c = new Client(srv); c.jar.token = tk; c.jar.booth_d = await realDevice(srv); return (await c.get(`/api/t/${T}/member`)).json.member; };
    const m = fake.member(7300);
    assert.equal(await probe(m), true);
    for (let i = 0; i < 8; i++) assert.equal(await probe(fake.token({ status: 401 })), false);
    assert.equal(await probe(m), true);
    assert.equal(fake.hitsFor(m).length, 1, 'still cached after 8 negatives (cache size 3)');
  } finally { await srv.stop(); }
});

test('menu is seeded exactly once, even if staff later delete every item and category', async () => {
  const srv = await boot();
  let srv2;
  try {
    const s = await staffLogin(srv);
    const m = (await s.get('/api/staff/state')).json.menu;
    for (const i of m.items) assert.equal((await s.post(`/api/staff/menu/items/${i.id}/delete`)).status, 200);
    for (const c of m.categoryList) assert.equal((await s.post(`/api/staff/menu/categories/${c.id}/delete`)).status, 200);
    assert.deepEqual((await s.get('/api/staff/state')).json.menu.items, []);
    await srv.stop({ keep: true });
    srv2 = await boot({ dir: srv.dir }); // menu.json still has 4 items on disk
    const s2 = await staffLogin(srv2);
    const m2 = (await s2.get('/api/staff/state')).json.menu;
    assert.deepEqual([m2.items.length, m2.categoryList.length], [0, 0], 'not re-seeded');
    assert.equal((await s2.post('/api/staff/menu/items', { name: '처음부터', price: 1000, category: '새' })).status, 200);
    // a reset does not re-seed either
    await s2.post('/api/staff/reset', { confirm: '초기화' });
    assert.equal((await s2.get('/api/staff/state')).json.menu.items.length, 1);
  } finally { await srv.stop({ keep: true }); if (srv2) await srv2.stop(); else fs.rmSync(srv.dir, { recursive: true, force: true }); }
});

test('menu and category names: unique on a normalised key, must contain a visible character, stored as typed', async () => {
  const srv = await boot();
  try {
    const s = await staffLogin(srv);
    const mk = (name, extra = {}) => s.post('/api/staff/menu/items', { name, price: 1000, category: '안주', ...extra });
    const first = await mk('  Beer  ');
    assert.equal(first.status, 200, first.text);
    assert.equal(first.json.item.name, 'Beer', 'stored trimmed, as typed');
    for (const dup of ['beer', 'BEER', 'Ｂｅｅｒ', ' beer ', 'b\u200beer']) {
      const r = await mk(dup);
      assert.equal(r.status, 409, JSON.stringify(dup));
      assert.equal(r.json.error, 'name_taken');
    }
    const spaced = await mk('Pale   Ale');
    assert.equal(spaced.json.item.name, 'Pale Ale');
    assert.equal((await mk('pale ale')).status, 409);
    for (const bad of ['\u3164', '\u115F\u1160', '\u2800', '\u200b', '   ']) assert.equal((await mk(bad)).json.error, 'bad_name', JSON.stringify(bad));
    assert.equal((await mk('ab\u3164')).json.item.name, 'ab');
    // rename: its own name in another case is fine, someone else's is not
    assert.equal((await s.post(`/api/staff/menu/items/${first.json.item.id}`, { name: 'BEER' })).json.item.name, 'BEER');
    assert.equal((await s.post(`/api/staff/menu/items/${first.json.item.id}`, { name: 'pale ale' })).json.error, 'name_taken');
    // categories
    const cat = await s.post('/api/staff/menu/categories', { name: 'Dessert' });
    assert.equal(cat.status, 200);
    for (const dup of ['dessert', 'ＤＥＳＳＥＲＴ', ' DESSERT ']) assert.equal((await s.post('/api/staff/menu/categories', { name: dup })).json.error, 'name_taken', dup);
    assert.equal((await s.post('/api/staff/menu/categories', { name: '\u3164' })).json.error, 'bad_category');
    const other = await s.post('/api/staff/menu/categories', { name: 'Drinks' });
    assert.equal((await s.post(`/api/staff/menu/categories/${other.json.category.id}`, { name: 'dessert' })).json.error, 'name_taken');
    assert.equal((await s.post(`/api/staff/menu/categories/${cat.json.category.id}`, { name: 'DESSERT' })).json.category.name, 'DESSERT');
    // an item in "dessert" lands in the existing (normalised-equal) category instead of creating a twin
    const before = (await s.get('/api/staff/state')).json.menu.categoryList.length;
    const it = await mk('Cake', { category: 'dessert' });
    assert.equal(it.json.item.cat, 'DESSERT');
    assert.equal((await s.get('/api/staff/state')).json.menu.categoryList.length, before);
  } finally { await srv.stop(); }
});

test('staff state exposes memberEnabled; kitchen orders carry the member boolean (never the id)', async () => {
  assert.equal((await staff.get('/api/staff/state')).json.memberEnabled, true); // main runs with COMS_ME_URL
  const off = await boot();
  try {
    assert.equal((await (await staffLogin(off)).get('/api/staff/state')).json.memberEnabled, false);
  } finally { await off.stop(); }
  const T = tok(37);
  const mem = await withToken(fake.member(8800)); const non = guest();
  const a = await order(mem, T, [{ id: 'cola', qty: 1 }]);
  const b = await order(non, T, [{ id: 'cola', qty: 1 }]);
  for (const o of [a, b]) await staff.post(`/api/staff/orders/${o.json.order.id}/status`, { status: 'cooking' });
  const k = await staff.get('/api/kitchen');
  const find = (id) => k.json.orders.find((x) => x.id === id);
  assert.equal(find(a.json.order.id).member, true);
  assert.equal(find(b.json.order.id).member, false);
  assert.ok(!/memberId|member_id|8800/.test(k.text));
  const ev = await openSse(main, '/api/kitchen/events', { cookie: staff.cookieHeader() });
  try { await ev.until((x) => x.includes('"member":true') && x.includes('"member":false')); } finally { ev.close(); }
  for (const o of [a, b]) await staff.post(`/api/staff/orders/${o.json.order.id}/status`, { status: 'served' });
});

test('booth_d is signed: forged well-formed ids do not count as an existing device for /nick', async () => {
  const T = tok(40);
  const real = await realDevice(main);
  const post = (cookie) => raw(main, 'POST', `/api/t/${T}/nick`, { 'content-type': 'application/json', cookie }, '{"nick":"ab"}');
  for (const forged of [`booth_d=${hex()}`, `booth_d=${hex()}.${hex()}`, `booth_d=${real.split('.')[0]}.${'0'.repeat(32)}`, `booth_d=${real.split('.')[0]}`]) {
    const r = await post(forged);
    assert.equal(r.status, 400, forged);
    assert.equal(JSON.parse(r.text).error, 'no_device');
    assert.match(String(r.headers['set-cookie']), /booth_d=[a-f0-9]{32}\.[a-f0-9]{32};/, 'a fresh signed cookie is issued instead');
  }
  assert.equal((await post(`booth_d=${real}`)).status, 200);
  // the signature key is per server: a cookie from another instance is just as foreign
  const other = await boot();
  try {
    const foreign = await realDevice(other);
    assert.equal((await post(`booth_d=${foreign}`)).status, 400);
  } finally { await other.stop(); }
  // all server-issued ids count: same signed id keeps being the same device
  assert.equal((await post(`booth_d=${real}`)).status, 200);
});

test('a coupon that would discount 0 won is ignored and not consumed', async () => {
  const g = guest(); const T = tok(40);
  const fin = await playOnce(g, T, 'cheers', 800);
  const coupon = fin.json.coupons.find((x) => x.rewardId === 'd1000');
  const free = await mkItem(staff, 'free sample', 0);
  const r = await g.post(`/api/t/${T}/orders`, { key: newKey(), items: [{ id: free, qty: 1 }], couponCode: coupon.code });
  assert.equal(r.status, 201, r.text);
  assert.equal(r.json.couponIgnored, true);
  assert.deepEqual([r.json.order.subtotal, r.json.order.total, r.json.order.couponDiscount, r.json.order.couponCode], [0, 0, 0, null]);
  assert.equal((await g.get(`/api/t/${T}`)).json.coupons.find((x) => x.code === coupon.code).status, 'issued', 'coupon not burned');
  // it still works on a real order, and then no flag is reported
  const real = await g.post(`/api/t/${T}/orders`, { key: newKey(), items: [{ id: 'tteokbokki', qty: 1 }], couponCode: coupon.code });
  assert.equal(real.json.couponIgnored, undefined);
  assert.deepEqual([real.json.order.couponDiscount, real.json.order.total], [1000, 7000]);
  assert.equal((await g.get(`/api/t/${T}`)).json.coupons.find((x) => x.code === coupon.code).status, 'used');
  // the member discount rounds down first (100 won at 50% = 0), so the coupon still applies to the whole price
  const m = await withToken(fake.member(8123));
  await staff.post('/api/staff/member-discount', { pct: 50 });
  try {
    const f2 = await playOnce(m, tok(39), 'cheers', 800);
    const c2 = f2.json.coupons.find((x) => x.rewardId === 'd1000');
    const only = await mkItem(staff, 'zero after member', 100); // 100 won: member 50% rounds down to 0, so the coupon still applies
    const o = await m.post(`/api/t/${tok(39)}/orders`, { key: newKey(), items: [{ id: only, qty: 1 }], couponCode: c2.code });
    assert.deepEqual([o.json.order.memberDiscount, o.json.order.couponDiscount, o.json.order.total], [0, 100, 0]);
    assert.equal(o.json.couponIgnored, undefined);
  } finally { await staff.post('/api/staff/member-discount', { pct: 10 }); }
});

test('createItem accepts hidden so a new hidden item is never visible', async () => {
  const r = await staff.post('/api/staff/menu/items', { name: 'secret special', price: 5000, category: '안주', hidden: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.item.hidden, true);
  const g = guest();
  assert.ok(!(await g.get('/api/menu')).json.items.some((i) => i.id === r.json.item.id));
  assert.equal((await order(g, tok(40), [{ id: r.json.item.id, qty: 1 }])).json.error, 'unknown_item');
  const bad = await staff.post('/api/staff/menu/items', { name: 'x hidden bad', price: 100, category: '안주', hidden: 'yes' });
  assert.equal(bad.status, 400); assert.equal(bad.json.error, 'bad_hidden');
  assert.equal((await staff.post('/api/staff/menu/items', { name: 'visible by default', price: 100, category: '안주' })).json.item.hidden, false);
});

test('numeric env vars are validated: the server refuses to start on garbage', async () => {
  const bad = { MEMBER_ORDER_MAX: ['abc', '0', '-1', '2.5', '1e3', ' x '], SESSION_HOURS: ['x', '0'], LOCKOUT_MS: ['0', 'soon'], SEAT_PLAY_MAX: ['0', 'many'], SEAT_OPEN_MAX: ['-3'],
    SEAT_PLAY_GAP_MS: ['-1', 'fast'], DB_MAX_BYTES: ['-5', 'big'], BACKUP_SKIP_BYTES: ['0'], BACKUP_INTERVAL_MS: ['soon', '0'], SSE_PUBLIC_MAX: ['0'], MEMBER_CACHE_MAX: ['x'], PORT: ['abc', '70000'] };
  for (const [name, values] of Object.entries(bad)) {
    for (const v of values) await assert.rejects(boot({ env: { [name]: v } }), new RegExp(`${name} must be an integer`), `${name}=${v}`);
  }
  const ok = await boot({ env: { MEMBER_ORDER_MAX: '5', SEAT_PLAY_GAP_MS: '0', SESSION_HOURS: '2', MEMBER_CACHE_MAX: '', LOCKOUT_MS: '30000' } });
  await ok.stop();
});

test('invalid menu.json is not seeded: the server starts with an empty menu and says why; a fixed file seeds later', async () => {
  const variants = {
    'duplicate names': { menu: { categories: ['안주'], items: [{ id: 'a', name: 'Beer', price: 1000, cat: '안주' }, { id: 'b', name: 'ＢＥＥＲ', price: 1000, cat: '안주' }] }, why: /duplicate item name/ },
    'bad price': { menu: { categories: ['안주'], items: [{ id: 'a', name: 'A', price: 150, cat: '안주' }] }, why: /bad price/ },
    'price too high': { menu: { categories: ['안주'], items: [{ id: 'a', name: 'A', price: 2000000, cat: '안주' }] }, why: /bad price/ },
    'unknown category': { menu: { categories: ['안주'], items: [{ id: 'a', name: 'A', price: 1000, cat: '없는' }] }, why: /category that is not in/ },
    'duplicate ids': { menu: { categories: ['안주'], items: [{ id: 'a', name: 'A', price: 1000, cat: '안주' }, { id: 'a', name: 'B', price: 1000, cat: '안주' }] }, why: /duplicate item id/ },
    'no items array': { menu: { categories: ['안주'] }, why: /must have/ },
    'not json': { menuRaw: '{ this is not json', why: /could not be read/ },
  };
  for (const [name, v] of Object.entries(variants)) {
    const srv = await boot({ menu: v.menu, menuRaw: v.menuRaw });
    let srv2;
    try {
      assert.equal((await new Client(srv).get('/api/health')).status, 200, name);
      const s = await staffLogin(srv);
      const m = (await s.get('/api/staff/state')).json.menu;
      assert.deepEqual([m.items.length, m.categoryList.length], [0, 0], name);
      assert.match(srv.log(), v.why, name);
      assert.equal((await s.post('/api/staff/menu/items', { name: '직접 추가', price: 1000, category: '안주' })).status, 200);
      await srv.stop({ keep: true });
      // fix the file: because nothing was seeded, it is picked up now
      // (the item added above makes the menu non-empty, so remove it first by starting from a fresh DB)
      fs.rmSync(path.join(srv.dir, 'data'), { recursive: true, force: true });
      fs.writeFileSync(path.join(srv.dir, 'cfg', 'menu.json'), JSON.stringify(MENU));
      srv2 = await boot({ dir: srv.dir });
      const s2 = await staffLogin(srv2);
      assert.equal((await s2.get('/api/staff/state')).json.menu.items.length, MENU.items.length, name);
    } finally { await srv.stop({ keep: true }); if (srv2) await srv2.stop(); fs.rmSync(srv.dir, { recursive: true, force: true }); }
  }
  // an invalid file does not set the "seeded" flag: fixing it and restarting the SAME db seeds it
  const srv = await boot({ menu: { categories: ['안주'], items: [{ id: 'a', name: 'A', price: 150, cat: '안주' }] } });
  let again;
  try {
    await srv.stop({ keep: true });
    fs.writeFileSync(path.join(srv.dir, 'cfg', 'menu.json'), JSON.stringify(MENU));
    again = await boot({ dir: srv.dir });
    assert.equal((await (await staffLogin(again)).get('/api/staff/state')).json.menu.items.length, MENU.items.length);
  } finally { await srv.stop({ keep: true }); if (again) await again.stop(); fs.rmSync(srv.dir, { recursive: true, force: true }); }
});

// ======================= C. member discount settings =======================
const MEMBER_DEFAULTS = { enabled: true, mode: 'percent', pct: 10, amount: 1000, minOrder: 0, maxDiscount: 0, includeAssociate: true, perMemberLimit: 20, stackWithCoupon: true };
async function setMember(over, s = staff) {
  const r = await s.post('/api/staff/member-discount', over);
  assert.equal(r.status, 200, r.text);
  return r.json;
}
const restoreMember = () => setMember(MEMBER_DEFAULTS);

test('member settings: every field is validated, bad updates change nothing, state exposes the rule', async () => {
  assert.equal((await new Client(main).post('/api/staff/member-discount', { pct: 5 })).status, 401);
  assert.equal((await staff.post('/api/staff/member-discount', {})).json.error, 'nothing_to_update');
  assert.equal((await staff.post('/api/staff/member-discount', { unknownField: 1 })).json.error, 'nothing_to_update');
  const bad = {
    bad_enabled: [{ enabled: 'yes' }, { enabled: 1 }, { enabled: null }],
    bad_mode: [{ mode: 'fixedd' }, { mode: 1 }, { mode: null }],
    bad_pct: [{ pct: -1 }, { pct: 51 }, { pct: 1.5 }, { pct: '10' }, { pct: null }],
    bad_amount: [{ amount: 150 }, { amount: -100 }, { amount: 50100 }, { amount: '100' }, { amount: 1.5 }],
    bad_min_order: [{ minOrder: 150 }, { minOrder: -100 }, { minOrder: 1000100 }, { minOrder: '0' }],
    bad_max_discount: [{ maxDiscount: 150 }, { maxDiscount: -100 }, { maxDiscount: 1000100 }, { maxDiscount: null }],
    bad_include_associate: [{ includeAssociate: 'true' }, { includeAssociate: 0 }],
    bad_per_member_limit: [{ perMemberLimit: 0 }, { perMemberLimit: 101 }, { perMemberLimit: 1.5 }, { perMemberLimit: '5' }],
    bad_stack_with_coupon: [{ stackWithCoupon: 'no' }, { stackWithCoupon: 0 }],
  };
  for (const [code, bodies] of Object.entries(bad)) {
    for (const b of bodies) {
      const r = await staff.post('/api/staff/member-discount', b);
      assert.equal(r.status, 400, JSON.stringify(b));
      assert.equal(r.json.error, code, JSON.stringify(b));
    }
  }
  // atomic: a valid field next to an invalid one is not applied
  assert.equal((await staff.post('/api/staff/member-discount', { pct: 22, amount: 150 })).status, 400);
  assert.equal((await staff.get('/api/staff/state')).json.memberDiscount.pct, 10);
  try {
    // boundaries are accepted
    for (const ok of [{ pct: 0 }, { pct: 50 }, { amount: 0 }, { amount: 50000 }, { minOrder: 1000000 }, { minOrder: 0 }, { maxDiscount: 1000000 }, { maxDiscount: 0 }, { perMemberLimit: 1 }, { perMemberLimit: 100 }]) await setMember(ok);
    const full = await setMember({ enabled: true, mode: 'fixed', pct: 12, amount: 1500, minOrder: 3000, maxDiscount: 2000, includeAssociate: false, perMemberLimit: 7, stackWithCoupon: false });
    assert.deepEqual({ ...full, ok: undefined }, { ok: undefined, ...{ enabled: true, mode: 'fixed', pct: 12, amount: 1500, minOrder: 3000, maxDiscount: 2000, includeAssociate: false, perMemberLimit: 7, stackWithCoupon: false } });
    const st = (await staff.get('/api/staff/state')).json;
    assert.deepEqual(st.memberDiscount, { enabled: true, mode: 'fixed', pct: 12, amount: 1500, minOrder: 3000, maxDiscount: 2000, includeAssociate: false, perMemberLimit: 7, stackWithCoupon: false });
    assert.equal(st.memberDiscountPct, 12); // older field kept
    // the guest snapshot only carries what the page needs (never includeAssociate / perMemberLimit)
    const gs = (await guest().get(`/api/t/${tok(13)}`)).json;
    assert.deepEqual(gs.memberDiscount, { enabled: true, mode: 'fixed', pct: 12, amount: 1500, minOrder: 3000, maxDiscount: 2000, stackWithCoupon: false });
    assert.equal(gs.memberDiscountPct, 12);
    const g = await withToken(fake.member(5001, 'USER'));
    assert.deepEqual((await g.get(`/api/t/${tok(13)}/member`)).json, { enabled: true, member: true, mode: 'fixed', pct: 12, amount: 1500, minOrder: 3000, maxDiscount: 2000, stackWithCoupon: false });
  } finally { await restoreMember(); }
});

test('member discount arithmetic: percent with cap, fixed amount larger than the subtotal, minOrder boundary', async () => {
  const T = tok(6);
  const g = await withToken(fake.member(5201));
  const place = async (items) => { // each order is cancelled again so the table stays under its pending cap
    const r = (await order(g, T, items)).json.order;
    await staff.post(`/api/staff/orders/${r.id}/status`, { status: 'cancelled' });
    return r;
  };
  const o = async (over, items) => { await setMember(over); return place(items); };
  try {
    const big = [{ id: 'tteokbokki', qty: 1 }, { id: 'fries', qty: 1 }]; // 14,000
    let r = await o({ mode: 'percent', pct: 50, maxDiscount: 3000 }, big);
    assert.deepEqual([r.memberDiscount, r.total], [3000, 11000], 'percent capped by maxDiscount');
    r = await o({ maxDiscount: 0 }, big);
    assert.deepEqual([r.memberDiscount, r.total], [7000, 7000], 'maxDiscount 0 = no cap');
    r = await o({ maxDiscount: 10000 }, big);
    assert.equal(r.memberDiscount, 7000, 'a cap above the discount changes nothing');
    // fixed
    r = await o({ mode: 'fixed', amount: 1000, maxDiscount: 0 }, [{ id: 'tteokbokki', qty: 1 }]);
    assert.deepEqual([r.memberDiscount, r.total, r.discount], [1000, 7000, 1000]);
    r = await o({ amount: 5000 }, [{ id: 'cola', qty: 1 }]); // 2,000 subtotal: never more than the subtotal
    assert.deepEqual([r.subtotal, r.memberDiscount, r.total, r.member], [2000, 2000, 0, true]);
    r = await o({ amount: 5000, maxDiscount: 2500 }, [{ id: 'tteokbokki', qty: 1 }]);
    assert.equal(r.memberDiscount, 2500, 'maxDiscount also caps a fixed amount');
    r = await o({ amount: 0, maxDiscount: 0 }, [{ id: 'tteokbokki', qty: 1 }]);
    assert.deepEqual([r.memberDiscount, r.member], [0, true]);
    // minOrder: subtotal == minOrder applies, one step below does not
    await setMember({ mode: 'fixed', amount: 500, minOrder: 6900 });
    assert.equal((await place([{ id: 'fries', qty: 1 }, { id: P900, qty: 1 }])).memberDiscount, 500, 'subtotal 6,900 == minOrder');
    const below = await place([{ id: 'fries', qty: 1 }, { id: P500, qty: 1 }]);
    assert.deepEqual([below.subtotal, below.memberDiscount, below.member], [6500, 0, true]);
    assert.equal((await place([{ id: 'tteokbokki', qty: 1 }])).memberDiscount, 500);
    // percent mode with minOrder
    await setMember({ mode: 'percent', pct: 10, minOrder: 8000 });
    assert.equal((await place([{ id: 'tteokbokki', qty: 1 }])).memberDiscount, 800);
    assert.equal((await place([{ id: 'fries', qty: 1 }])).memberDiscount, 0);
  } finally { await restoreMember(); }
});

test('member discount: includeAssociate=false excludes ASSOCIATE only; the cached role is applied without another lookup', async () => {
  const T = tok(9);
  const assoc = fake.member(5301, 'ASSOCIATE');
  const a = await withToken(assoc);
  try {
    await setMember({ includeAssociate: false });
    assert.equal((await a.get(`/api/t/${T}/member`)).json.member, false);
    const r = await order(a, T, [{ id: 'tteokbokki', qty: 1 }]);
    assert.deepEqual([r.json.order.memberDiscount, r.json.order.member, r.json.order.total], [0, false, 8000]);
    for (const role of ['USER', 'OFFICER', 'VICE_PRESIDENT', 'ADMIN']) {
      const g = await withToken(fake.member(5310, role));
      assert.equal((await g.get(`/api/t/${T}/member`)).json.member, true, role);
      assert.equal((await order(g, T, [{ id: 'tteokbokki', qty: 1 }])).json.order.memberDiscount, 800, role);
    }
    await setMember({ includeAssociate: true });
    assert.equal((await a.get(`/api/t/${T}/member`)).json.member, true);
    assert.equal((await order(a, T, [{ id: 'tteokbokki', qty: 1 }])).json.order.memberDiscount, 800);
    assert.equal(fake.hitsFor(assoc).length, 1, 'toggling the rule needs no new club lookup (role is cached)');
    // the role never reaches the page
    assert.ok(!/ASSOCIATE|role/i.test(JSON.stringify((await a.get(`/api/t/${T}/member`)).json)));
  } finally { await restoreMember(); }
});

test('member discount: stackWithCoupon=false lets the coupon win; true stacks both', async () => {
  const T = tok(10);
  const g = await withToken(fake.member(5401));
  try {
    const fin = await playOnce(g, T, 'cheers', 800);
    const code = fin.json.coupons.find((x) => x.rewardId === 'd1000').code;
    await setMember({ stackWithCoupon: false });
    const a = await order(g, T, [{ id: 'tteokbokki', qty: 1 }], { couponCode: code });
    assert.equal(a.json.memberDiscountSkipped, 'coupon');
    assert.deepEqual([a.json.order.memberDiscount, a.json.order.couponDiscount, a.json.order.total, a.json.order.member], [0, 1000, 7000, true]);
    const none = await order(g, T, [{ id: 'tteokbokki', qty: 1 }]); // no coupon selected: the member discount applies
    assert.deepEqual([none.json.order.memberDiscount, none.json.memberDiscountSkipped], [800, undefined]);
    await staff.post(`/api/staff/orders/${a.json.order.id}/status`, { status: 'cancelled' }); // coupon comes back
    await setMember({ stackWithCoupon: true });
    const b = await order(g, T, [{ id: 'tteokbokki', qty: 1 }], { couponCode: code });
    assert.deepEqual([b.json.order.memberDiscount, b.json.order.couponDiscount, b.json.order.total, b.json.memberDiscountSkipped], [800, 1000, 6200, undefined]);
  } finally { await restoreMember(); }
});

test('member discount: perMemberLimit is live; enabled=false stops lookups and discounts', async () => {
  const T = tok(11);
  const g = await withToken(fake.member(5501));
  const mk = async () => (await order(g, T, [{ id: 'tteokbokki', qty: 1 }])).json;
  try {
    await setMember({ perMemberLimit: 1 });
    assert.equal((await mk()).order.memberDiscount, 800);
    const second = await mk();
    assert.deepEqual([second.order.memberDiscount, second.memberDiscountSkipped], [0, 'limit']);
    await setMember({ perMemberLimit: 2 }); // takes effect immediately
    assert.equal((await mk()).order.memberDiscount, 800);
    assert.equal((await mk()).memberDiscountSkipped, 'limit');
    await setMember({ perMemberLimit: 1 });
    assert.equal((await mk()).memberDiscountSkipped, 'limit');
    await restoreMember();
    // staff switch off: no club lookup, no discount, page told so
    await setMember({ enabled: false });
    const tk = fake.member(5502);
    const off = await withToken(tk);
    assert.deepEqual((await off.get(`/api/t/${T}/member`)).json, memberBody({ enabled: false, member: false }));
    const r = await order(off, T, [{ id: 'tteokbokki', qty: 1 }]);
    assert.deepEqual([r.json.order.memberDiscount, r.json.order.member], [0, false]);
    assert.equal(fake.hitsFor(tk).length, 0, 'switch off = no outbound request');
    assert.equal((await staff.get('/api/staff/state')).json.memberEnabled, true, 'memberEnabled still says the feature is configured');
    assert.equal((await off.get(`/api/t/${T}`)).json.memberDiscount.enabled, false);
    await setMember({ enabled: true });
    assert.equal((await off.get(`/api/t/${T}/member`)).json.member, true);
  } finally { await restoreMember(); }
});

test('member settings persist across restarts; MEMBER_ORDER_MAX only seeds a fresh database', async () => {
  const srv = await boot({ env: { COMS_ME_URL: fake.url + ME_PATH, MEMBER_ORDER_MAX: '3' } });
  let srv2;
  try {
    const s = await staffLogin(srv);
    assert.equal((await s.get('/api/staff/state')).json.memberDiscount.perMemberLimit, 3);
    await setMember({ mode: 'fixed', amount: 2000, pct: 22, includeAssociate: false }, s);
    await srv.stop({ keep: true });
    srv2 = await boot({ dir: srv.dir, env: { COMS_ME_URL: fake.url + ME_PATH, MEMBER_ORDER_MAX: '7' } });
    const m = (await (await staffLogin(srv2)).get('/api/staff/state')).json.memberDiscount;
    assert.deepEqual([m.mode, m.amount, m.pct, m.includeAssociate, m.perMemberLimit], ['fixed', 2000, 22, false, 3]);
  } finally { await srv.stop({ keep: true }); if (srv2) await srv2.stop(); else fs.rmSync(srv.dir, { recursive: true, force: true }); }
});

// ======================= B. reward management =======================
const REWARD_KEYS = ['active', 'amount', 'game', 'id', 'issued', 'item', 'label', 'remaining', 'stock', 'threshold', 'type', 'used'];
async function rewardSetup(env = {}) {
  const srv = await boot({ env: { SEAT_PLAY_GAP_MS: '0', ...env } });
  const s = await staffLogin(srv);
  const tk = (await s.get('/api/staff/tables')).json.tables.map((t) => t.token);
  return { srv, s, tk, list: async () => (await s.get('/api/staff/rewards')).json.rewards };
}

test('rewards: staff list has live counts; games are read-only constants; unauthenticated is refused', async () => {
  const { srv, s, tk } = await rewardSetup();
  try {
    assert.equal((await new Client(srv).get('/api/staff/rewards')).status, 401);
    assert.equal((await new Client(srv).post('/api/staff/rewards', { label: 'x' })).status, 401);
    const r = (await s.get('/api/staff/rewards')).json;
    assert.deepEqual(r.rewards.map((x) => x.id), ['drink', 'd1000', 'dbig']);
    for (const x of r.rewards) assert.deepEqual(Object.keys(x).sort(), REWARD_KEYS);
    assert.deepEqual(r.rewards[0], { id: 'drink', label: '음료 1잔', game: 'pour', threshold: 400, type: 'item', amount: null, item: '콜라', stock: 3, issued: 0, remaining: 3, used: 0, active: true });
    assert.equal(r.games.pour.maxScore, 500);
    assert.equal(r.games.cheers.minDurationMs, 200);
    assert.deepEqual(r.hourly, { enabled: true, label: '안주 1개 서비스', type: 'item', amount: null, item: '안주' });
    // live counts: issued, remaining and used follow plays and redemptions
    const g = new Client(srv);
    const fin = await playOnce(g, tk[0], 'pour', 450);
    assert.equal(fin.json.coupons.length, 1);
    let drink = (await s.get('/api/staff/rewards')).json.rewards[0];
    assert.deepEqual([drink.issued, drink.remaining, drink.used], [1, 2, 0]);
    await s.post('/api/staff/coupons/redeem', { code: fin.json.coupons[0].code });
    drink = (await s.get('/api/staff/rewards')).json.rewards[0];
    assert.deepEqual([drink.issued, drink.remaining, drink.used], [1, 2, 1]);
    assert.deepEqual((await s.get('/api/staff/state')).json.rewards[0], drink);
    assert.deepEqual((await s.get('/api/staff/state')).json.games, r.games);
    // there is no way to edit the games
    assert.equal((await s.post('/api/staff/games', { pour: { maxScore: 9999 } })).status, 404);
  } finally { await srv.stop(); }
});

test('rewards: create validation, limits and boundaries', async () => {
  const { srv, s } = await rewardSetup();
  try {
    const base = { label: '새 보상', game: 'pour', threshold: 100, type: 'item', stock: 5, active: true };
    const bad = async (over, code) => {
      const r = await s.post('/api/staff/rewards', { ...base, ...over });
      assert.equal(r.status, 400, JSON.stringify(over) + r.text);
      assert.equal(r.json.error, code, JSON.stringify(over));
    };
    for (const label of ['', '   ', 'a'.repeat(21), 'ㅤ', '​', 5, null]) await bad({ label }, 'bad_label');
    for (const game of ['x', 5, null, 'toString']) await bad({ game }, 'bad_game');
    for (const threshold of [-1, 501, 1.5, '100', null]) await bad({ threshold }, 'bad_threshold'); // pour: 0..500
    await bad({ game: 'cheers', threshold: 1001 }, 'bad_threshold');
    for (const type of ['x', null, 5]) await bad({ type }, 'bad_type');
    for (const amount of [undefined, 0, 50, 150, 100100, '500', null, 1.5]) await bad({ type: 'discount', amount }, 'bad_amount');
    for (const stock of [-1, 10001, 1.5, '5', null, undefined]) await bad({ stock }, 'bad_stock');
    for (const active of ['yes', 1, null]) await bad({ active }, 'bad_active');
    // boundaries
    const lo = await s.post('/api/staff/rewards', { label: 'a'.repeat(20), game: 'pour', threshold: 0, type: 'discount', amount: 100, stock: 0, active: false });
    assert.equal(lo.status, 200, lo.text);
    assert.deepEqual([lo.json.reward.threshold, lo.json.reward.amount, lo.json.reward.stock, lo.json.reward.active, lo.json.reward.type], [0, 100, 0, false, 'discount']);
    const hi = await s.post('/api/staff/rewards', { label: '최대', game: 'cheers', threshold: 1000, type: 'discount', amount: 100000, stock: 10000 });
    assert.equal(hi.status, 200, hi.text);
    assert.equal(hi.json.reward.active, true, 'active defaults to true');
    // an item reward ignores a sent amount
    const it = await s.post('/api/staff/rewards', { ...base, label: '음료', amount: 5000 });
    assert.deepEqual([it.json.reward.amount, it.json.reward.item], [null, '음료']);
    assert.match(it.json.reward.id, /^r[0-9a-f]{8}$/);
    assert.deepEqual(it.json.rewards.map((x) => x.id).slice(0, 3), ['drink', 'd1000', 'dbig']);
    // at most 12 rewards (3 seeded + 3 created so far)
    for (let i = 6; i < 12; i++) assert.equal((await s.post('/api/staff/rewards', { ...base, label: 'r' + i })).status, 200);
    const over = await s.post('/api/staff/rewards', { ...base, label: '열세번째' });
    assert.equal(over.status, 409); assert.equal(over.json.error, 'too_many_rewards');
  } finally { await srv.stop(); }
});

test('rewards: edits reach guests live; coupons keep the label/type/amount they were issued with; deactivate keeps old coupons valid', async () => {
  const { srv, s, tk } = await rewardSetup();
  try {
    const A = new Client(srv); const B = new Client(srv); const C = new Client(srv); const D = new Client(srv); const E = new Client(srv);
    const created = await s.post('/api/staff/rewards', { label: '테스트 할인', game: 'pour', threshold: 100, type: 'discount', amount: 500, stock: 3, active: true });
    const id = created.json.reward.id;
    assert.deepEqual([created.json.reward.issued, created.json.reward.remaining, created.json.reward.used], [0, 3, 0]);
    // guest snapshot + board reflect it (and an SSE stream gets the edit)
    const gs = await openSse(srv, `/api/t/${tk[4]}/events`, { cookie: `booth_d=${await realDevice(srv)}` });
    try {
      await gs.until((b) => b.includes('event: state'));
      const snap = (await E.get(`/api/t/${tk[4]}`)).json;
      assert.deepEqual(snap.rewards.find((r) => r.id === id), { id, game: 'pour', label: '테스트 할인', type: 'discount', amount: 500, item: null, threshold: 100, soldOut: false, got: false });
      assert.ok((await E.get('/api/board')).json.rewards.some((r) => r.id === id && r.remaining === 3 && r.stock === 3));
      assert.equal((await s.post(`/api/staff/rewards/${id}`, { label: '실시간 이름' })).status, 200);
      await gs.until((b) => b.includes('실시간 이름'));
    } finally { gs.close(); }
    await s.post(`/api/staff/rewards/${id}`, { label: '테스트 할인' });
    // A earns it with the original definition
    const fa = await playOnce(A, tk[0], 'pour', 450);
    const ca = fa.json.coupons.find((x) => x.rewardId === id);
    assert.deepEqual([ca.label, ca.type, ca.amount], ['테스트 할인', 'discount', 500]);
    // staff edits label + amount: A's coupon is unchanged, B gets the new values
    assert.equal((await s.post(`/api/staff/rewards/${id}`, { label: '바뀐 이름', amount: 700 })).json.reward.amount, 700);
    const cA = (await A.get(`/api/t/${tk[0]}`)).json.coupons.find((x) => x.code === ca.code);
    assert.deepEqual([cA.label, cA.amount], ['테스트 할인', 500]);
    const oA = await order(A, tk[0], [{ id: 'tteokbokki', qty: 1 }], { couponCode: ca.code });
    assert.equal(oA.json.order.couponDiscount, 500, 'applying uses the stored amount');
    const fb = await playOnce(B, tk[1], 'pour', 450);
    const cb = fb.json.coupons.find((x) => x.rewardId === id);
    assert.deepEqual([cb.label, cb.amount], ['바뀐 이름', 700]);
    // threshold edits apply to later plays only
    await s.post(`/api/staff/rewards/${id}`, { threshold: 500 });
    const fc = await playOnce(C, tk[2], 'pour', 450);
    assert.equal(fc.json.rewards.find((r) => r.rewardId === id).result, 'low_score');
    await s.post(`/api/staff/rewards/${id}`, { threshold: 100 });
    // type change to item: later coupons are item coupons, B's discount coupon still applies
    const asItem = await s.post(`/api/staff/rewards/${id}`, { type: 'item' });
    assert.deepEqual([asItem.json.reward.type, asItem.json.reward.amount, asItem.json.reward.item], ['item', null, '바뀐 이름']);
    const fcc = await playOnce(new Client(srv), tk[2], 'pour', 450); // another device at the same seat (avoids the per-device gap)
    const cc = fcc.json.coupons.find((x) => x.rewardId === id);
    assert.deepEqual([cc.type, cc.amount, cc.item], ['item', null, '바뀐 이름']);
    assert.equal((await order(C, tk[2], [{ id: 'tteokbokki', qty: 1 }], { couponCode: cc.code })).json.error, 'coupon_not_discount');
    assert.equal((await order(B, tk[1], [{ id: 'tteokbokki', qty: 1 }], { couponCode: cb.code })).json.order.couponDiscount, 700);
    // type back to discount needs an amount
    assert.equal((await s.post(`/api/staff/rewards/${id}`, { type: 'discount' })).json.error, 'bad_amount');
    assert.equal((await s.post(`/api/staff/rewards/${id}`, { type: 'discount', amount: 900 })).json.reward.amount, 900);
    // deactivate: hidden from guests/board, nothing is issued, existing coupons stay valid
    await s.post(`/api/staff/rewards/${id}`, { active: false });
    assert.ok(!(await D.get(`/api/t/${tk[3]}`)).json.rewards.some((r) => r.id === id));
    assert.ok(!(await D.get('/api/board')).json.rewards.some((r) => r.id === id));
    const fd = await playOnce(D, tk[3], 'pour', 450);
    assert.ok(!fd.json.rewards.some((r) => r.rewardId === id), 'inactive reward is not offered');
    assert.ok(!fd.json.coupons.some((x) => x.rewardId === id));
    assert.equal((await s.post('/api/staff/coupons/redeem', { code: cc.code })).status, 200, 'a coupon of a deactivated reward can still be redeemed');
    await s.post(`/api/staff/rewards/${id}`, { active: true });
    assert.ok((await D.get(`/api/t/${tk[3]}`)).json.rewards.some((r) => r.id === id));
    // issued so far: A, B, C = 3 of stock 3: sold out
    const sold = (await s.get('/api/staff/rewards')).json.rewards.find((r) => r.id === id);
    assert.deepEqual([sold.issued, sold.remaining], [3, 0]);
    const fd2 = await playOnce(new Client(srv), tk[3], 'pour', 450);
    assert.equal(fd2.json.rewards.find((r) => r.rewardId === id).result, 'sold_out');
    // stock can never go below issued, but equal is fine, and the old stock endpoint obeys the same rule
    const below = await s.post(`/api/staff/rewards/${id}`, { stock: 2 });
    assert.equal(below.status, 400); assert.equal(below.json.error, 'stock_below_issued'); assert.equal(below.json.issued, 3);
    assert.equal((await s.post(`/api/staff/rewards/${id}`, { stock: 3 })).json.reward.remaining, 0);
    assert.equal((await s.post(`/api/staff/rewards/${id}/stock`, { stock: 2 })).json.error, 'stock_below_issued');
    assert.equal((await s.post(`/api/staff/rewards/${id}/stock`, { stock: 6 })).status, 200);
    assert.equal((await s.post(`/api/staff/rewards/${id}`, {})).json.error, 'nothing_to_update');
    assert.equal((await s.post('/api/staff/rewards/nope', { stock: 1 })).status, 404);
    // several rewards of one game each pay at most once per seat
    assert.equal((await s.post('/api/staff/rewards', { label: '두번째', game: 'pour', threshold: 100, type: 'item', stock: 5 })).status, 200);
    const again = await playOnce(new Client(srv), tk[0], 'pour', 450);
    assert.deepEqual(again.json.rewards.filter((r) => r.result === 'already_got').map((r) => r.rewardId).sort(), ['drink', id].sort());
    assert.equal(again.json.rewards.filter((r) => r.result === 'issued').length, 1, 'only the new reward');
  } finally { await srv.stop(); }
});

test('rewards: delete only when never issued; reset keeps definitions and configured stock', async () => {
  const { srv, s, tk } = await rewardSetup();
  try {
    const g = new Client(srv);
    const fresh = (await s.post('/api/staff/rewards', { label: '지울 보상', game: 'cheers', threshold: 10, type: 'item', stock: 5 })).json.reward.id;
    const del = await s.post(`/api/staff/rewards/${fresh}/delete`);
    assert.equal(del.status, 200);
    assert.ok(!del.json.rewards.some((x) => x.id === fresh));
    assert.equal((await s.post(`/api/staff/rewards/${fresh}/delete`)).status, 404);
    // issued -> 409 in_use
    const keep = (await s.post('/api/staff/rewards', { label: '발급될 보상', game: 'pour', threshold: 1, type: 'item', stock: 5 })).json.reward.id;
    await playOnce(g, tk[0], 'pour', 450);
    const busy = await s.post(`/api/staff/rewards/${keep}/delete`);
    assert.equal(busy.status, 409); assert.equal(busy.json.error, 'in_use');
    // reset: issued counts and coupons go, definitions / active flags / configured stock stay
    await s.post('/api/staff/rewards/drink', { stock: 7 });
    await s.post('/api/staff/rewards/d1000', { active: false });
    await s.post('/api/staff/hourly-reward', { label: '시간 보상', enabled: false });
    const before = (await s.get('/api/staff/rewards')).json.rewards;
    assert.ok(before.find((x) => x.id === 'drink').issued > 0);
    assert.equal((await s.post('/api/staff/reset', { confirm: '초기화' })).status, 200);
    const after = (await s.get('/api/staff/rewards')).json;
    assert.deepEqual(after.rewards.map((x) => [x.id, x.label, x.stock, x.active, x.threshold]), before.map((x) => [x.id, x.label, x.stock, x.active, x.threshold]));
    assert.ok(after.rewards.every((x) => x.issued === 0 && x.used === 0 && x.remaining === x.stock));
    assert.equal(after.rewards.find((x) => x.id === 'drink').stock, 7, 'configured stock is kept, remaining returns to it');
    assert.equal(after.rewards.find((x) => x.id === 'd1000').active, false);
    assert.deepEqual([after.hourly.label, after.hourly.enabled], ['시간 보상', false], 'the hourly reward setting is kept too');
    assert.deepEqual((await g.get(`/api/t/${tk[0]}`)).json.coupons, []);
    // nothing was issued any more: now it can be deleted
    assert.equal((await s.post(`/api/staff/rewards/${keep}/delete`)).status, 200);
  } finally { await srv.stop(); }
});

test('hourly ranking reward: label, type/amount and on/off are staff-editable', async () => {
  const { srv, s, tk } = await rewardSetup();
  try {
    assert.equal((await s.post('/api/staff/hourly-reward', {})).json.error, 'nothing_to_update');
    for (const [body, code] of [[{ label: '' }, 'bad_label'], [{ label: 'a'.repeat(21) }, 'bad_label'], [{ type: 'x' }, 'bad_type'], [{ type: 'discount' }, 'bad_amount'],
      [{ type: 'discount', amount: 150 }, 'bad_amount'], [{ type: 'discount', amount: 100100 }, 'bad_amount'], [{ enabled: 'x' }, 'bad_enabled']]) {
      const r = await s.post('/api/staff/hourly-reward', body);
      assert.equal(r.status, 400, JSON.stringify(body)); assert.equal(r.json.error, code, JSON.stringify(body));
    }
    assert.equal((await new Client(srv).post('/api/staff/hourly-reward', { enabled: false })).status, 401);
    const upd = await s.post('/api/staff/hourly-reward', { label: '시간대 1등 할인', type: 'discount', amount: 2000 });
    assert.deepEqual(upd.json.hourly, { enabled: true, label: '시간대 1등 할인', type: 'discount', amount: 2000, item: '시간대 1등 할인' });
    assert.deepEqual((await s.get('/api/staff/state')).json.hourly, upd.json.hourly);
    assert.deepEqual((await new Client(srv).get('/api/board')).json.hourly, upd.json.hourly);
    const g = new Client(srv);
    await playOnce(g, tk[0], 'pour', 300);
    // switched off: no award
    await s.post('/api/staff/hourly-reward', { enabled: false });
    const off = await s.post('/api/staff/award-hour');
    assert.equal(off.status, 409); assert.equal(off.json.error, 'hourly_disabled');
    await s.post('/api/staff/hourly-reward', { enabled: true });
    const won = await s.post('/api/staff/award-hour');
    assert.equal(won.status, 200, won.text);
    assert.deepEqual([won.json.coupon.type, won.json.coupon.amount, won.json.coupon.label], ['discount', 2000, '시간대 1등 할인']);
    // it is a normal discount coupon: usable on an order
    const o = await order(g, tk[0], [{ id: 'tteokbokki', qty: 1 }], { couponCode: won.json.coupon.code });
    assert.deepEqual([o.json.order.couponDiscount, o.json.order.total], [2000, 6000]);
    // back to an item reward
    const item = await s.post('/api/staff/hourly-reward', { type: 'item' });
    assert.deepEqual([item.json.hourly.type, item.json.hourly.amount], ['item', null]);
  } finally { await srv.stop(); }
});

test('rewards.json seeds once; an invalid file starts with no rewards and a clear log line', async () => {
  const mk = (over) => ({ ...REWARDS, rewards: over });
  const r1 = { id: 'a1', game: 'pour', threshold: 100, type: 'item', label: 'A', stock: 3 };
  const variants = {
    'duplicate id': mk([r1, { ...r1 }]), 'bad threshold': mk([{ ...r1, threshold: 501 }]), 'unknown game': mk([{ ...r1, game: 'darts' }]),
    'bad type': mk([{ ...r1, type: 'gift' }]), 'negative stock': mk([{ ...r1, stock: -1 }]), 'discount without amount': mk([{ ...r1, type: 'discount' }]),
    'bad amount': mk([{ ...r1, type: 'discount', amount: 150 }]), 'long label': mk([{ ...r1, label: 'x'.repeat(21) }]),
    'bad id': mk([{ ...r1, id: 'has space' }]), 'not an array': { ...REWARDS, rewards: 'nope' },
    'too many': mk(Array.from({ length: 13 }, (_, i) => ({ ...r1, id: 'r' + i, label: 'L' + i }))),
  };
  for (const [name, rw] of Object.entries(variants)) {
    const srv = await boot({ rewards: rw });
    let again;
    try {
      assert.equal((await new Client(srv).get('/api/health')).status, 200, name);
      const s = await staffLogin(srv);
      assert.deepEqual((await s.get('/api/staff/rewards')).json.rewards, [], name);
      assert.match(srv.log(), /rewards\.json is invalid/, name);
      await srv.stop({ keep: true });
      fs.writeFileSync(path.join(srv.dir, 'cfg', 'rewards.json'), JSON.stringify(REWARDS)); // fixed: nothing was seeded, so it is picked up now
      again = await boot({ dir: srv.dir });
      assert.equal((await (await staffLogin(again)).get('/api/staff/rewards')).json.rewards.length, 3, name);
    } finally { await srv.stop({ keep: true }); if (again) await again.stop(); fs.rmSync(srv.dir, { recursive: true, force: true }); }
  }
  // once seeded the file is never read again, even after staff delete every reward
  const srv = await boot();
  let srv2; let srv3;
  try {
    const s = await staffLogin(srv);
    await s.post('/api/staff/rewards/drink', { stock: 11 });
    await srv.stop({ keep: true });
    fs.writeFileSync(path.join(srv.dir, 'cfg', 'rewards.json'), JSON.stringify({ ...REWARDS, rewards: [{ ...r1, id: 'drink', stock: 99, label: '파일에서' }] }));
    srv2 = await boot({ dir: srv.dir });
    const s2 = await staffLogin(srv2);
    const l = (await s2.get('/api/staff/rewards')).json.rewards;
    assert.deepEqual([l.length, l[0].stock, l[0].label], [3, 11, '음료 1잔'], 'edits persist, the file is not re-applied');
    for (const x of l) assert.equal((await s2.post(`/api/staff/rewards/${x.id}/delete`)).status, 200);
    await srv2.stop({ keep: true });
    srv3 = await boot({ dir: srv.dir });
    assert.deepEqual((await (await staffLogin(srv3)).get('/api/staff/rewards')).json.rewards, [], 'not re-seeded after deleting everything');
  } finally { await srv.stop({ keep: true }); if (srv2) await srv2.stop({ keep: true }); if (srv3) await srv3.stop(); fs.rmSync(srv.dir, { recursive: true, force: true }); }
});

// ======================= A. menu photos =======================
const jpg = (n = 200) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(Math.max(0, n - 4), 1)]);
const png = (n = 200) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(Math.max(0, n - 8), 2)]);
const webp = (n = 200) => { const b = Buffer.alloc(Math.max(12, n), 3); b.write('RIFF', 0, 'latin1'); b.write('WEBP', 8, 'latin1'); return b; };
const PHOTO_URL_RE = /^\/photos\/\d+-[a-f0-9]{8}\.(jpg|png|webp)$/;
const upload = (srv, s, id, type, body, extra = {}) => raw(srv, 'POST', `${srv.base}/api/staff/menu/items/${id}/photo`, { ...(type ? { 'content-type': type } : {}), cookie: s.cookieHeader(), ...extra }, body);
const photoFiles = (srv) => fs.readdirSync(path.join(srv.data, 'photos')).sort();
const body = (r) => JSON.parse(r.text);
// a request that is streamed (chunked, no Content-Length) or announces a huge length, answered as soon as the server decides
function rawStream(srv, p, headers, chunks) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: srv.port, method: 'POST', path: p, headers }, (res) => {
      let t = ''; res.on('data', (d) => { t += d; });
      res.on('end', () => resolve({ status: res.statusCode, text: t, headers: res.headers }));
    });
    req.on('error', (e) => { if (e.code === 'ECONNRESET' || e.code === 'EPIPE') return; reject(e); });
    (async () => { for (const c of chunks) { if (req.destroyed) return; req.write(c); await delay(5); } req.end(); })();
  });
}

test('photos: staff upload, public serving with fixed headers, menu JSON carries a BASE-relative url', async () => {
  const srv = await boot();
  try {
    const s = await staffLogin(srv);
    const id = (await s.get('/api/staff/state')).json.menu.items[0].id;
    assert.equal((await new Client(srv).get('/api/menu')).json.items.find((i) => i.id === id).photo, null);
    for (const [type, make, ext] of [['image/jpeg', jpg, 'jpg'], ['image/png', png, 'png'], ['image/webp', webp, 'webp']]) {
      const bytes = make(500);
      const r = await upload(srv, s, id, type, bytes, { 'content-disposition': 'attachment; filename="../../evil.php"' });
      assert.equal(r.status, 200, r.text);
      const item = body(r).item;
      assert.match(item.photo, PHOTO_URL_RE);
      assert.ok(item.photo.endsWith('.' + ext));
      assert.ok(!item.photo.includes('evil'), 'client file names are never used');
      assert.equal(body(r).menu.items.find((i) => i.id === id).photo, item.photo);
      // guests and staff both see it
      assert.equal((await new Client(srv).get('/api/menu')).json.items.find((i) => i.id === id).photo, item.photo);
      assert.equal((await new Client(srv).get(`/api/t/${(await s.get('/api/staff/tables')).json.tables[0].token}`)).json.menu.items.find((i) => i.id === id).photo, item.photo);
      // public file with fixed headers
      const f = await fetch(srv.origin + item.photo);
      assert.equal(f.status, 200);
      assert.equal(f.headers.get('content-type'), type);
      assert.equal(f.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(f.headers.get('cache-control'), 'public, max-age=31536000, immutable');
      assert.equal(f.headers.get('content-security-policy'), "default-src 'none'");
      assert.ok(Buffer.from(await f.arrayBuffer()).equals(bytes));
      assert.equal(photoFiles(srv).length, 1, 'a replace leaves exactly one file');
    }
    const url = (await new Client(srv).get('/api/menu')).json.items.find((i) => i.id === id).photo;
    const head = await raw(srv, 'HEAD', url);
    assert.equal(head.status, 200); assert.equal(head.text, '');
    for (const m of ['POST', 'PUT', 'DELETE']) assert.equal((await raw(srv, m, url, { 'content-type': 'application/json' }, '{}')).status, 404, m);
  } finally { await srv.stop(); }
});

test('photos: auth, same-origin, content-type and magic-byte validation, size limits', async () => {
  const srv = await boot();
  try {
    const s = await staffLogin(srv);
    const id = 'cola';
    assert.equal((await raw(srv, 'POST', `/api/staff/menu/items/${id}/photo`, { 'content-type': 'image/png' }, png())).status, 401);
    assert.equal((await raw(srv, 'POST', `/api/staff/menu/items/${id}/photo`, { 'content-type': 'image/png', cookie: 'booth_s=forged' }, png())).status, 401);
    assert.equal((await upload(srv, s, id, 'image/png', png(), { origin: 'https://evil.example' })).status, 403);
    assert.equal((await upload(srv, s, id, 'image/png', png(), { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await upload(srv, s, id, 'image/png', png(), { 'sec-fetch-site': 'same-origin' })).status, 200);
    // declared type
    for (const t of ['application/json', 'text/plain', 'image/gif', 'image/svg+xml', 'application/octet-stream', 'multipart/form-data']) {
      const r = await upload(srv, s, id, t, png());
      assert.equal(r.status, 415, t); assert.equal(body(r).error, 'unsupported_media_type', t);
    }
    assert.equal((await upload(srv, s, id, null, png())).status, 415, 'no content-type');
    // content must match the declared type
    const cases = [
      ['empty', 'image/png', Buffer.alloc(0), 400, 'bad_image'], ['text as png', 'image/png', Buffer.from('<svg onload=alert(1)>'), 400, 'bad_image'],
      ['png bytes as jpeg', 'image/jpeg', png(), 415, 'type_mismatch'], ['jpeg bytes as png', 'image/png', jpg(), 415, 'type_mismatch'],
      ['webp bytes as png', 'image/png', webp(), 415, 'type_mismatch'], ['truncated png signature', 'image/png', png().subarray(0, 7), 400, 'bad_image'],
      ['riff without webp', 'image/webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(8, 1)]), 400, 'bad_image'], ['two jpeg bytes', 'image/jpeg', Buffer.from([0xff, 0xd8]), 400, 'bad_image'],
      ['gif bytes as png', 'image/png', Buffer.from('GIF89a......'), 400, 'bad_image'],
    ];
    for (const [name, type, bytes, status, code] of cases) {
      const r = await upload(srv, s, id, type, bytes);
      assert.equal(r.status, status, name); assert.equal(body(r).error, code, name);
    }
    assert.equal((await upload(srv, s, 'nope-item', 'image/png', png())).status, 404);
    // size: exactly 400 KB passes, one byte more is refused
    assert.equal((await upload(srv, s, id, 'image/jpeg', jpg(400 * 1024))).status, 200);
    const tooBig = await upload(srv, s, id, 'image/jpeg', jpg(400 * 1024 + 1));
    assert.equal(tooBig.status, 413); assert.equal(body(tooBig).error, 'too_large');
    // a huge announced length is refused before the body is read; a streamed (chunked) body is cut off at the limit
    const announced = await rawStream(srv, `/api/staff/menu/items/${id}/photo`, { 'content-type': 'image/jpeg', cookie: s.cookieHeader(), 'content-length': String(50 * 1024 * 1024) }, [jpg(1000)]);
    assert.equal(announced.status, 413);
    const chunks = Array.from({ length: 12 }, () => jpg(50 * 1024));
    const streamed = await rawStream(srv, `/api/staff/menu/items/${id}/photo`, { 'content-type': 'image/jpeg', cookie: s.cookieHeader(), 'transfer-encoding': 'chunked' }, chunks);
    assert.equal(streamed.status, 413);
    assert.equal(photoFiles(srv).length, 1, 'refused uploads stored nothing (and no temp files are left)');
    assert.ok(photoFiles(srv).every((f) => /^\d+-[a-f0-9]{8}\.(jpg|png|webp)$/.test(f)));
    // the JSON limit (16 KB) still applies to JSON routes
    const bigJson = await raw(srv, 'POST', '/api/staff/ordering', { 'content-type': 'application/json', cookie: s.cookieHeader() }, JSON.stringify({ open: true, pad: 'x'.repeat(20000) }));
    assert.equal(bigJson.status, 413);
  } finally { await srv.stop(); }
});

test('photos: replace removes the old file, delete / item delete remove files, orphans are cleaned at boot, reset keeps photos', async () => {
  const srv = await boot();
  let srv2;
  try {
    const s = await staffLogin(srv);
    const a = await mkItem(s, '사진 메뉴 A', 1000, '안주');
    const b = await mkItem(s, '사진 메뉴 B', 1000, '안주');
    const first = body(await upload(srv, s, a, 'image/png', png(300))).item.photo;
    const second = body(await upload(srv, s, a, 'image/jpeg', jpg(300))).item.photo;
    assert.notEqual(first, second);
    assert.equal((await fetch(srv.origin + first)).status, 404, 'the old URL is gone');
    assert.equal((await fetch(srv.origin + second)).status, 200);
    assert.equal(photoFiles(srv).length, 1);
    const photoB = body(await upload(srv, s, b, 'image/webp', webp(300))).item.photo;
    assert.equal(photoFiles(srv).length, 2);
    // explicit delete (idempotent)
    const del = await s.post(`/api/staff/menu/items/${b}/photo/delete`);
    assert.equal(del.status, 200); assert.equal(del.json.item.photo, null);
    assert.equal((await fetch(srv.origin + photoB)).status, 404);
    assert.equal((await s.post(`/api/staff/menu/items/${b}/photo/delete`)).status, 200);
    assert.equal((await s.post('/api/staff/menu/items/nope/photo/delete')).status, 404);
    assert.equal((await new Client(srv).post(`/api/staff/menu/items/${b}/photo/delete`)).status, 401);
    // deleting the item deletes its photo; an item that was ordered cannot be deleted and keeps its photo
    const c = await mkItem(s, '사진 메뉴 C', 1000, '안주');
    await upload(srv, s, c, 'image/png', png());
    assert.equal(photoFiles(srv).length, 2);
    assert.equal((await s.post(`/api/staff/menu/items/${c}/delete`)).status, 200);
    assert.equal(photoFiles(srv).length, 1);
    const tk = (await s.get('/api/staff/tables')).json.tables[0].token;
    assert.equal((await order(new Client(srv), tk, [{ id: a, qty: 1 }])).status, 201);
    assert.equal((await s.post(`/api/staff/menu/items/${a}/delete`)).json.error, 'in_use');
    assert.equal(photoFiles(srv).length, 1);
    // reset keeps the menu and its photos
    await s.post('/api/staff/reset', { confirm: '초기화' });
    assert.equal((await fetch(srv.origin + second)).status, 200);
    assert.equal((await s.get('/api/staff/state')).json.menu.items.find((i) => i.id === a).photo, second);
    // orphans (crash leftovers, unreferenced files) are removed on boot; referenced files stay
    await srv.stop({ keep: true });
    const dir = path.join(srv.data, 'photos');
    fs.writeFileSync(path.join(dir, '99-deadbeef.png'), png());
    fs.writeFileSync(path.join(dir, '.abc123.tmp'), 'partial');
    fs.writeFileSync(path.join(dir, 'random.txt'), 'x');
    srv2 = await boot({ dir: srv.dir });
    const s2 = await staffLogin(srv2);
    assert.deepEqual(photoFiles(srv2), [second.slice('/photos/'.length)]);
    assert.equal((await fetch(srv2.origin + second)).status, 200, 'photo survives a restart');
    assert.equal((await s2.get('/api/staff/state')).json.menu.items.find((i) => i.id === a).photo, second);
    // photos are not part of the SQLite backup
    await s2.post('/api/staff/reset', { confirm: '초기화' }); // takes a safety backup
    assert.ok(fs.readdirSync(path.join(srv2.data, 'backup')).every((f) => f.endsWith('.db')));
  } finally { await srv.stop({ keep: true }); if (srv2) await srv2.stop(); else fs.rmSync(srv.dir, { recursive: true, force: true }); }
});

test('photos: total storage cap (409 photo_storage_full); replacing and deleting free space', async () => {
  const srv = await boot({ env: { PHOTO_STORAGE_MAX: String(1000 * 1000) } });
  try {
    const s = await staffLogin(srv);
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await mkItem(s, '캡 메뉴 ' + i, 1000, '안주'));
    for (let i = 0; i < 3; i++) assert.equal((await upload(srv, s, ids[i], 'image/jpeg', jpg(300 * 1000))).status, 200, `photo ${i}`);
    const full = await upload(srv, s, ids[3], 'image/jpeg', jpg(300 * 1000));
    assert.equal(full.status, 409); assert.equal(body(full).error, 'photo_storage_full');
    assert.equal((await upload(srv, s, ids[3], 'image/jpeg', jpg(90 * 1000))).status, 200, 'a smaller one still fits');
    // replacing counts only the difference
    assert.equal((await upload(srv, s, ids[0], 'image/png', png(300 * 1000))).status, 200);
    assert.equal(body(await upload(srv, s, ids[0], 'image/png', png(400 * 1000))).error, 'photo_storage_full');
    await s.post(`/api/staff/menu/items/${ids[1]}/photo/delete`);
    assert.equal((await upload(srv, s, ids[4], 'image/jpeg', jpg(300 * 1000))).status, 200);
  } finally { await srv.stop(); }
});

test('photos: only well-formed names are served; nothing outside the photos directory; works under BASE_PATH', async () => {
  const srv = await boot({ base: '/booth' });
  try {
    const s = await staffLogin(srv);
    const item = body(await upload(srv, s, 'cola', 'image/png', png())).item;
    assert.match(item.photo, PHOTO_URL_RE);
    assert.equal((await raw(srv, 'GET', '/booth' + item.photo)).status, 200, 'served under BASE');
    assert.equal((await raw(srv, 'GET', item.photo)).status, 404, 'not at the root');
    const name = item.photo.slice('/photos/'.length);
    for (const p of ['/photos/..%2fdata%2fbooth.db', '/photos/..%2f..%2fserver.js', '/photos/x.jpg', '/photos/1-abcdef12.exe',
      '/photos/1-ABCDEF12.jpg', '/photos/1-abcdef1.jpg', '/photos/1-abcdef123.jpg', `/photos/${name}%00.png`, '/photos/', '/photos/.' + name, '/photos/12-abcdef12.png', '/photos/booth.db']) {
      const r = await raw(srv, 'GET', '/booth' + p);
      assert.ok([404, 400].includes(r.status), `${p} -> ${r.status}`);
      assert.ok(!r.text.includes('SQLite format') && !r.text.includes('createStore'), p);
    }
  } finally { await srv.stop(); }
});

// ======================= upgrade of a booth.db created by the previous release (HEAD 3ba4c20) =======================
test('a database created by the previous release is upgraded in place: rewards, member settings and photo column', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-head-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const old = new DatabaseSync(path.join(dir, 'data', 'booth.db'));
  old.exec(HEAD_SCHEMA);
  const tokensOld = [];
  for (let i = 1; i <= 10; i++) { const t = crypto.randomBytes(12).toString('base64url'); tokensOld.push(t); old.prepare('INSERT INTO tables(id, token) VALUES(?,?)').run(i, t); } // production: 10 rows
  old.prepare("INSERT INTO menu_categories(id, name, sort) VALUES(1, '안주', 0)").run();
  old.prepare("INSERT INTO menu_items(id, name, price, category_id, descr, sort) VALUES('legacy-item', '레거시 메뉴', 5000, 1, '', 0)").run();
  old.prepare("INSERT INTO settings(k, v) VALUES('menu_seeded', '1')").run();
  old.prepare("INSERT INTO settings(k, v) VALUES('member_discount_pct', '15')").run();
  old.prepare("INSERT INTO reward_stock(id, stock, issued) VALUES('drink', 9, 3)").run();
  old.prepare("INSERT INTO reward_stock(id, stock, issued) VALUES('d1000', 40, 2)").run();
  const mkCoupon = old.prepare("INSERT INTO coupons(code, reward_id, source, type, amount, label, item, table_id, seat, status, created_at) VALUES(?,?,?,?,?,?,?,?,?,'issued',?)");
  mkCoupon.run('LEGACY', 'drink', 'score', 'item', null, '옛 음료', '옛 음료', 1, 1, Date.now());
  mkCoupon.run('LEGDSC', 'd1000', 'score', 'discount', 1000, '옛 할인', null, 2, 1, Date.now());
  assert.ok(!old.prepare('PRAGMA table_info(menu_items)').all().some((c) => c.name === 'photo'), 'fixture has the previous schema');
  assert.equal(old.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='rewards'").get().n, 0);
  old.close();
  let srv; let srv2;
  try {
    srv = await boot({ dir, tablesCount: 8, env: { COMS_ME_URL: fake.url + ME_PATH, PAY_BANK: '신한', PAY_ACCOUNT: '110-123-456789', PAY_HOLDER: '동아리' } }); // production tables.json now says 8
    const s = await staffLogin(srv);
    const st = (await s.get('/api/staff/state')).json;
    const byId = Object.fromEntries(st.rewards.map((r) => [r.id, r]));
    assert.deepEqual([byId.drink.stock, byId.drink.issued, byId.drink.remaining], [9, 3, 6], 'live stock and issued counts carried over');
    assert.deepEqual([byId.d1000.stock, byId.d1000.issued], [40, 2]);
    assert.deepEqual([byId.dbig.stock, byId.dbig.issued], [50, 0], 'rewards without a legacy row start from rewards.json');
    assert.ok(st.rewards.every((r) => r.active === true));
    assert.deepEqual(st.menu.items.map((i) => [i.id, i.photo]), [['legacy-item', null]], 'menu comes from the DB, not menu.json');
    assert.deepEqual(st.memberDiscount, { enabled: true, mode: 'percent', pct: 15, amount: 1000, minOrder: 0, maxDiscount: 0, includeAssociate: true, perMemberLimit: 20, stackWithCoupon: true });
    assert.equal(st.memberDiscountPct, 15);
    assert.deepEqual((await s.get('/api/staff/tables')).json.tables.map((t) => t.token), tokensOld.slice(0, 8), 'effective count is 8 (tables.json seeds the new setting); tokens 1..8 unchanged');
    assert.equal(st.tableCount, 8);
    assert.deepEqual(st.tables.map((t) => t.number), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.equal(await guestOk(srv, tokensOld[8]), 404, 'table 9 stays hidden');
    // payment settings were seeded from the environment; deposit notices and the hook secret exist
    assert.deepEqual(st.pay, { bank: '신한', account: '110-123-456789', holder: '동아리', tossEnabled: false, kakaoPayUrl: '', requireDepositor: false, changedAt: null });
    assert.deepEqual(st.deposit, { pending: 0, unparsed: 0, ignored: 0, review: 0, autoConfirm: false, autoConfirmMaxAmount: 30000 }, 'auto-confirm ships OFF');
    assert.match((await s.get('/api/staff/deposit-hook')).json.secret, /^[a-f0-9]{64}$/);
    assert.deepEqual((await s.get('/api/staff/deposits')).json.notices, []);
    assert.deepEqual((await new Client(srv).get(`/api/t/${tokensOld[0]}`)).json.pay, { bank: '신한', account: '110-123-456789', holder: '동아리', tossEnabled: false, kakaoPayUrl: '', requireDepositor: false });
    // old coupons keep their own stored label/type/amount and still work
    const g = new Client(srv);
    const snap1 = (await g.get(`/api/t/${tokensOld[0]}`)).json;
    assert.deepEqual(snap1.coupons.map((c) => [c.code, c.label, c.type]), [['LEGACY', '옛 음료', 'item']]);
    assert.equal((await s.post('/api/staff/coupons/redeem', { code: 'LEGACY' })).status, 200);
    const m = new Client(srv); m.jar.token = fake.member(9901); m.jar.booth_d = await realDevice(srv);
    const o = await order(m, tokensOld[1], [{ id: 'legacy-item', qty: 1 }], { couponCode: 'LEGDSC' });
    assert.equal(o.status, 201, o.text);
    assert.deepEqual([o.json.order.memberDiscount, o.json.order.couponDiscount, o.json.order.total], [700, 1000, 3300], '15% of 5,000 = 750 -> 700, then the stored 1,000 coupon');
    // the migrated menu accepts photos and the new reward API works
    assert.match(body(await upload(srv, s, 'legacy-item', 'image/png', png())).item.photo, PHOTO_URL_RE);
    assert.equal((await s.post('/api/staff/rewards', { label: '새 보상', game: 'pour', threshold: 10, type: 'item', stock: 1 })).status, 200);
    assert.equal((await s.post('/api/staff/rewards/drink', { stock: 2 })).json.error, 'stock_below_issued');
    // the old orders table gets the new columns: an order with a depositor, paid by an automatic deposit notice
    const dep = await order(new Client(srv), tokensOld[2], [{ id: 'legacy-item', qty: 1 }], { depositor: '홍길동' });
    assert.equal(dep.json.order.depositor, '홍길동');
    assert.equal((await s.post('/api/staff/deposits/autoconfirm', { autoConfirm: true })).status, 200);
    const hook = (await s.get('/api/staff/deposit-hook')).json.secret;
    assert.equal(JSON.parse((await hookPost(srv, hook, { text: smsText(5000, '홍길동', 3) })).text).status, 'matched');
    assert.equal((await s.get('/api/staff/state')).json.orders.find((x) => x.id === dep.json.order.id).paidBy, 'auto');
    // raising the count brings the hidden tables (and their printed QR codes) back; the old rows were kept
    assert.equal((await s.post('/api/staff/tables/count', { count: 10 })).status, 200);
    assert.equal(await guestOk(srv, tokensOld[8]), 200);
    assert.deepEqual((await s.get('/api/staff/tables')).json.tables.map((t) => t.token), tokensOld);
    assert.equal((await s.post('/api/staff/tables/count', { count: 12 })).status, 200);
    assert.equal((await s.get('/api/staff/tables')).json.tables.length, 12);
    assert.equal((await s.post('/api/staff/tables/count', { count: 8 })).status, 200);
    await srv.stop({ keep: true });
    // booting again changes nothing (no duplicate rewards, no failing ALTERs, nothing re-seeded)
    srv2 = await boot({ dir, tablesCount: 40, env: { PAY_BANK: '우리' } });
    const s2 = await staffLogin(srv2);
    const st2 = (await s2.get('/api/staff/state')).json;
    assert.equal(st2.tableCount, 8, 'the setting wins over tables.json after the first boot');
    assert.equal(st2.pay.bank, '신한', 'and the DB wins over env for payment settings');
    assert.equal(st2.rewards.length, 4);
    assert.deepEqual(st2.rewards.find((r) => r.id === 'drink').stock, 9);
    assert.equal(st2.menu.items.length, 1);
    assert.equal(st2.memberDiscount.pct, 15);
    const chk = new DatabaseSync(path.join(dir, 'data', 'booth.db'), { readOnly: true });
    assert.ok(chk.prepare('PRAGMA table_info(menu_items)').all().some((c) => c.name === 'photo'));
    assert.equal(chk.prepare("SELECT v FROM settings WHERE k='rewards_seeded'").get().v, '1');
    chk.close();
  } finally { if (srv) await srv.stop({ keep: true }); if (srv2) await srv2.stop({ keep: true }); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ======================= D. table count / E. QR rotation =======================
const tablesOf = async (s) => (await s.get('/api/staff/tables')).json.tables;
const guestOk = async (srv, token) => (await new Client(srv).get(`/api/t/${token}`)).status;
const pageOk = async (srv, token) => (await new Client(srv).get(`/t/${token}`)).status;

test('table count: live setting; raising adds tokens, lowering hides tables but keeps their rows and QR codes', async () => {
  const srv = await boot({ tablesCount: 3 });
  let srv2;
  try {
    const s = await staffLogin(srv);
    assert.equal((await s.get('/api/staff/state')).json.tableCount, 3);
    assert.equal((await new Client(srv).post('/api/staff/tables/count', { count: 4 })).status, 401);
    for (const bad of [0, 51, -1, 1.5, '3', null, undefined, 100]) {
      const r = await s.post('/api/staff/tables/count', { count: bad });
      assert.equal(r.status, 400, String(bad)); assert.equal(r.json.error, 'bad_count', String(bad));
    }
    const before = await tablesOf(s);
    const up = await s.post('/api/staff/tables/count', { count: 5 });
    assert.deepEqual([up.status, up.json.ok, up.json.tableCount], [200, true, 5]);
    const t5 = await tablesOf(s);
    assert.deepEqual(t5.map((t) => t.number), [1, 2, 3, 4, 5]);
    assert.deepEqual(t5.slice(0, 3), before, 'existing tokens unchanged');
    assert.equal(new Set(t5.map((t) => t.token)).size, 5);
    for (const t of t5) { assert.equal(await guestOk(srv, t.token), 200); assert.equal(await pageOk(srv, t.token), 200); }
    assert.equal((await s.get('/api/staff/state')).json.tables.length, 5);
    assert.equal((await s.post('/api/staff/tables/count', { count: 50 })).json.tableCount, 50);
    assert.equal((await tablesOf(s)).length, 50);
    assert.equal((await s.post('/api/staff/tables/count', { count: 1 })).json.tableCount, 1);
    assert.equal((await s.post('/api/staff/tables/count', { count: 5 })).json.tableCount, 5);
    // a game at table 5 shows on the board; a guest stream is open at table 3
    const g = new Client(srv);
    await playOnce(g, t5[4].token, 'cheers', 700);
    assert.ok((await g.get('/api/board')).json.games.cheers.some((r) => r.table === 5));
    const g3 = new Client(srv); await g3.get(`/api/t/${t5[2].token}`);
    const ev = await openSse(srv, `/api/t/${t5[2].token}/events`, { cookie: g3.cookieHeader() });
    try {
      await ev.until((b) => b.includes('event: state'));
      assert.equal((await s.post('/api/staff/tables/count', { count: 2 })).json.tableCount, 2);
      await assert.rejects(ev.until(() => false, 2000), /closed/, 'streams of removed tables are closed');
    } finally { ev.close(); }
    // lowered: tables 3..5 stop working exactly like a lowered tables.json
    for (const t of t5.slice(2)) {
      assert.equal(await guestOk(srv, t.token), 404);
      assert.equal(await pageOk(srv, t.token), 404);
      assert.equal((await order(new Client(srv), t.token, [{ id: 'cola', qty: 1 }])).status, 404);
    }
    assert.equal(await guestOk(srv, t5[0].token), 200);
    assert.deepEqual((await s.get('/api/staff/state')).json.tables.map((t) => t.number), [1, 2]);
    assert.deepEqual((await tablesOf(s)).map((t) => t.number), [1, 2]);
    assert.ok(!(await g.get('/api/board')).json.games.cheers.some((r) => r.table === 5), 'hidden from the board');
    // raising again brings the old QR codes back
    await s.post('/api/staff/tables/count', { count: 5 });
    assert.deepEqual((await tablesOf(s)), t5);
    assert.equal(await guestOk(srv, t5[4].token), 200);
    // persisted: tables.json (3) is only the first-boot seed
    await srv.stop({ keep: true });
    srv2 = await boot({ dir: srv.dir });
    assert.equal((await (await staffLogin(srv2)).get('/api/staff/state')).json.tableCount, 5);
  } finally { await srv.stop({ keep: true }); if (srv2) await srv2.stop(); else fs.rmSync(srv.dir, { recursive: true, force: true }); }
});

test('table count: lowering refuses tables with unpaid or unserved orders unless force', async () => {
  const srv = await boot({ tablesCount: 5 });
  try {
    const s = await staffLogin(srv);
    const t = await tablesOf(s);
    const g = new Client(srv);
    const place = async (n) => (await order(g, t[n - 1].token, [{ id: 'tteokbokki', qty: 1 }])).json.order;
    const o3 = await place(3); const o4 = await place(4); const o5 = await place(5);
    await s.post(`/api/staff/orders/${o3.id}/status`, { status: 'served' }); await s.post(`/api/staff/orders/${o3.id}/paid`, { paid: true }); // settled
    await s.post(`/api/staff/orders/${o4.id}/status`, { status: 'served' }); // served but unpaid
    await s.post(`/api/staff/orders/${o5.id}/paid`, { paid: true }); // paid but still pending (unserved)
    const refused = await s.post('/api/staff/tables/count', { count: 2 });
    assert.equal(refused.status, 409); assert.equal(refused.json.error, 'unsettled');
    assert.deepEqual(refused.json.tables, [4, 5]);
    assert.equal((await s.get('/api/staff/state')).json.tableCount, 5, 'nothing changed');
    assert.equal((await s.post('/api/staff/tables/count', { count: 2, force: 'true' })).status, 409, 'only literal true forces');
    assert.deepEqual((await s.post('/api/staff/tables/count', { count: 4 })).json.tables, [5]);
    // a cancelled order never blocks
    await s.post(`/api/staff/orders/${o5.id}/status`, { status: 'cancelled' });
    assert.equal((await s.post('/api/staff/tables/count', { count: 4 })).status, 200);
    assert.deepEqual((await s.post('/api/staff/tables/count', { count: 3 })).json.tables, [4]);
    // raising is never refused; force overrides
    assert.equal((await s.post('/api/staff/tables/count', { count: 6 })).status, 200);
    assert.equal((await s.post('/api/staff/tables/count', { count: 2, force: true })).json.tableCount, 2);
    // the orders of the hidden tables are kept: raising shows them again
    await s.post('/api/staff/tables/count', { count: 5 });
    assert.ok((await s.get('/api/staff/state')).json.orders.some((o) => o.id === o4.id));
  } finally { await srv.stop(); }
});

test('tables.json above 50 is refused', async () => {
  await assert.rejects(boot({ tablesCount: 51 }), /bad count/);
});

test('QR rotation: new token, old one dead at once, streams closed, orders and seat untouched', async () => {
  const srv = await boot({ tablesCount: 3, env: { PUBLIC_ORIGIN: 'https://coms.kw.ac.kr' } });
  let srv2;
  try {
    const s = await staffLogin(srv);
    const before = await tablesOf(s);
    const g = new Client(srv);
    const o = await order(g, before[0].token, [{ id: 'cola', qty: 1 }]);
    assert.equal(o.status, 201);
    let rotated;
    const open = await openSse(srv, `/api/t/${before[0].token}/events`, { cookie: `booth_d=${await realDevice(srv)}` });
    const other = await openSse(srv, `/api/t/${before[1].token}/events`, { cookie: `booth_d=${await realDevice(srv)}` });
    try {
      await open.until((b) => b.includes('event: state'));
      await other.until((b) => b.includes('event: state'));
      assert.equal((await new Client(srv).post('/api/staff/tables/1/rotate')).status, 401);
      const r = await s.post('/api/staff/tables/1/rotate');
      rotated = r.json.token;
      assert.equal(r.status, 200, r.text);
      assert.deepEqual([r.json.ok, r.json.table], [true, 1]);
      assert.match(r.json.token, /^[A-Za-z0-9_-]{16}$/);
      assert.notEqual(r.json.token, before[0].token);
      assert.equal(r.json.url, `https://coms.kw.ac.kr/t/${r.json.token}`);
      await assert.rejects(open.until(() => false, 2000), /closed/, 'stream opened with the old QR code is closed');
      // the neighbour's stream stays open
      assert.equal((await s.post('/api/staff/tables/3/rotate')).status, 200);
      await assert.rejects(other.until(() => false, 600), /timeout/, 'a neighbouring table keeps its stream');
    } finally { open.close(); other.close(); }
    // old token: dead everywhere, immediately
    assert.equal(await guestOk(srv, before[0].token), 404);
    assert.equal(await pageOk(srv, before[0].token), 404);
    assert.equal((await order(new Client(srv), before[0].token, [{ id: 'cola', qty: 1 }])).status, 404);
    // new token: same table, same seat, same orders
    const after = await tablesOf(s);
    assert.equal(after[0].token, rotated);
    assert.equal(after[1].token, before[1].token, 'other tables untouched');
    assert.notEqual(after[2].token, before[2].token);
    const snap = (await new Client(srv).get(`/api/t/${after[0].token}`)).json;
    assert.deepEqual([snap.table.number, snap.table.seat, snap.orders.map((x) => x.id)], [1, 1, [o.json.order.id]]);
    assert.equal(await pageOk(srv, after[0].token), 200);
    assert.equal((await s.get('/api/staff/state')).json.orders.filter((x) => x.table === 1).length, 1);
    // rotating twice gives yet another token; unknown / hidden tables are 404
    const again = (await s.post('/api/staff/tables/1/rotate')).json.token;
    assert.notEqual(again, after[0].token);
    assert.equal(await guestOk(srv, after[0].token), 404);
    assert.equal((await s.post('/api/staff/tables/99/rotate')).status, 404);
    await s.post('/api/staff/tables/count', { count: 2 });
    assert.equal((await s.post('/api/staff/tables/3/rotate')).status, 404, 'a table above the count cannot be rotated');
    // survives a restart
    await srv.stop({ keep: true });
    srv2 = await boot({ dir: srv.dir });
    const s2 = await staffLogin(srv2);
    assert.equal((await tablesOf(s2))[0].token, again);
    assert.equal(await guestOk(srv2, again), 200);
    assert.equal(await guestOk(srv2, before[0].token), 404);
  } finally { await srv.stop({ keep: true }); if (srv2) await srv2.stop(); else fs.rmSync(srv.dir, { recursive: true, force: true }); }
});

// ======================= F. service worker file =======================
test('sw.js is served at BASE/sw.js with a BASE-wide scope, no-cache and __BASE__ substituted', async () => {
  const r = await raw(main, 'GET', '/sw.js');
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /^text\/javascript/);
  assert.equal(r.headers['cache-control'], 'no-cache');
  assert.equal(r.headers['service-worker-allowed'], '/');
  assert.equal(r.text, 'const BASE="";');
  assert.match(r.headers['content-security-policy'], /worker-src 'self'/);
  const head = await raw(main, 'HEAD', '/sw.js');
  assert.deepEqual([head.status, head.text, head.headers['service-worker-allowed']], [200, '', '/']);
  for (const m of ['POST', 'PUT', 'DELETE']) assert.equal((await raw(main, m, '/sw.js', { 'content-type': 'application/json' }, '{}')).status, 404, m);
  assert.equal((await raw(main, 'GET', '/sw.js/')).status, 200, 'trailing slash is normalised like every route');
  const srv = await boot({ base: '/booth' });
  try {
    const b = await raw(srv, 'GET', '/booth/sw.js');
    assert.equal(b.status, 200);
    assert.equal(b.headers['service-worker-allowed'], '/booth/');
    assert.equal(b.text, 'const BASE="/booth";');
    assert.equal((await raw(srv, 'GET', '/sw.js')).status, 404, 'not at the root when BASE is set');
  } finally { await srv.stop(); }
  const none = await boot({ noSw: true });
  try { assert.equal((await raw(none, 'GET', '/sw.js')).status, 404); } finally { await none.stop(); }
});

// ======================= G1/G2. payment settings =======================
test('pay settings: validation, typed-twice guard, kakao url rules, env seeds once', async () => {
  const srv = await boot({ env: { PAY_BANK: '신한', PAY_ACCOUNT: '110-123-456789', PAY_HOLDER: '동아리' } });
  let srv2;
  try {
    const s = await staffLogin(srv);
    const T = (await tablesOf(s))[0].token;
    const guestPay = async () => (await new Client(srv).get(`/api/t/${T}`)).json.pay;
    const seeded = { bank: '신한', account: '110-123-456789', holder: '동아리', tossEnabled: false, kakaoPayUrl: '', requireDepositor: false };
    assert.deepEqual(await guestPay(), seeded);
    assert.deepEqual((await s.get('/api/staff/state')).json.pay, { ...seeded, changedAt: null });
    assert.equal((await new Client(srv).post('/api/staff/pay', { tossEnabled: true })).status, 401);
    assert.equal((await s.post('/api/staff/pay', {})).json.error, 'nothing_to_update');
    const bad = async (body, code) => { const r = await s.post('/api/staff/pay', body); assert.equal(r.status, 400, JSON.stringify(body)); assert.equal(r.json.error, code, JSON.stringify(body)); };
    for (const bank of ['', '   ', 'a'.repeat(21), '\u3164', 5, null]) await bad({ bank }, 'bad_bank');
    for (const holder of ['', 'x'.repeat(21), '\u200b', null]) await bad({ holder }, 'bad_holder');
    for (const account of ['1234567', '12345678901234567890123', 'abcd1234567', '1234 5678 9012', '-12345678', '12345678-', '1234--56789', '1234-5678-9012-', 12345678901, null, '']) await bad({ account }, 'bad_account');
    for (const tossEnabled of ['yes', 1, null]) await bad({ tossEnabled }, 'bad_toss_enabled');
    for (const requireDepositor of ['yes', 0, null]) await bad({ requireDepositor }, 'bad_require_depositor');
    for (const kakaoPayUrl of ['http://qr.kakaopay.com/abc', 'https://qr.kakaopay.com', 'https://qr.kakaopay.com/', 'https://qr.kakaopay.com.evil.com/abc', 'https://evil.com/qr.kakaopay.com/abc',
      'https://qr.kakaopay.com@evil.com/abc', 'https://user:pw@qr.kakaopay.com/abc', 'https://qr.kakaopay.com:444/abc', 'https://QR.KAKAOPAY.COM.evil.io/x', 'javascript:alert(1)', 'qr.kakaopay.com/abc',
      'https://kakaopay.com/abc', 'https://www.qr.kakaopay.com/abc', 5, null, 'https://qr.kakaopay.com/' + 'a'.repeat(200)]) await bad({ kakaoPayUrl }, 'bad_kakao_url');
    assert.deepEqual(await guestPay(), seeded, 'failed updates change nothing');
    // toggles and a kakao url need no account confirmation
    const ok1 = await s.post('/api/staff/pay', { tossEnabled: true, requireDepositor: true, kakaoPayUrl: 'https://qr.kakaopay.com/Ab12Cd34' });
    assert.equal(ok1.status, 200, ok1.text);
    assert.deepEqual(ok1.json.pay, { ...seeded, tossEnabled: true, requireDepositor: true, kakaoPayUrl: 'https://qr.kakaopay.com/Ab12Cd34', changedAt: null });
    assert.deepEqual(await guestPay(), { ...seeded, tossEnabled: true, requireDepositor: true, kakaoPayUrl: 'https://qr.kakaopay.com/Ab12Cd34' });
    assert.equal((await s.post('/api/staff/pay', { kakaoPayUrl: '' })).json.pay.kakaoPayUrl, '', 'empty clears it');
    // the money destination needs the account typed twice
    for (const body of [{ account: '110-999-888777' }, { bank: '국민' }, { holder: '다른 사람' }, { account: '110-999-888777', confirmAccount: '110-999-888778' }, { account: '110-999-888777', confirmAccount: 1109998887770 },
      { bank: '국민', confirmAccount: '110-123-45678' }]) {
      const r = await s.post('/api/staff/pay', body);
      assert.equal(r.status, 400, JSON.stringify(body)); assert.equal(r.json.error, 'account_mismatch', JSON.stringify(body));
    }
    assert.deepEqual(await guestPay(), { ...seeded, tossEnabled: true, requireDepositor: true, kakaoPayUrl: '' }, 'still the old destination');
    const t0 = Date.now();
    const ch = await s.post('/api/staff/pay', { bank: '국민', account: '110-999-888777', holder: '새 예금주', confirmAccount: '110999888777' });
    assert.equal(ch.status, 200, ch.text);
    assert.deepEqual([ch.json.pay.bank, ch.json.pay.account, ch.json.pay.holder], ['국민', '110-999-888777', '새 예금주']);
    assert.ok(ch.json.pay.changedAt >= t0 && ch.json.pay.changedAt <= Date.now());
    assert.equal((await guestPay()).account, '110-999-888777');
    assert.ok(!('changedAt' in (await guestPay())), 'guests do not see changedAt');
    assert.equal((await s.get('/api/staff/state')).json.pay.changedAt, ch.json.pay.changedAt);
    // unchanged destination values need no confirmation and keep changedAt
    const same = await s.post('/api/staff/pay', { bank: '국민', account: '110-999-888777', holder: '새 예금주', tossEnabled: false });
    assert.equal(same.status, 200); assert.equal(same.json.pay.changedAt, ch.json.pay.changedAt);
    // reset keeps pay settings
    await s.post('/api/staff/reset', { confirm: '초기화' });
    assert.equal((await guestPay()).bank, '국민');
    // after the first boot the DB wins over env
    await srv.stop({ keep: true });
    srv2 = await boot({ dir: srv.dir, env: { PAY_BANK: '우리', PAY_ACCOUNT: '999-9999-9999', PAY_HOLDER: '환경변수' } });
    const T2 = (await tablesOf(await staffLogin(srv2)))[0].token;
    assert.equal((await new Client(srv2).get(`/api/t/${T2}`)).json.pay.bank, '국민');
  } finally { await srv.stop({ keep: true }); if (srv2) await srv2.stop(); else fs.rmSync(srv.dir, { recursive: true, force: true }); }
});

// ======================= G3. depositor on orders =======================
test('depositor: optional unless required, cleaned, stored with the order, replays unchanged, guest may fix it while unpaid', async () => {
  const srv = await boot();
  try {
    const s = await staffLogin(srv);
    const tk = (await tablesOf(s)).map((t) => t.token);
    const g = new Client(srv);
    const place = (body = {}, T = tk[0]) => g.post(`/api/t/${T}/orders`, { key: newKey(), items: [{ id: 'cola', qty: 1 }], ...body });
    // not required: absent, empty and valid values
    let r = await place();
    assert.deepEqual([r.status, r.json.order.depositor, r.json.order.paidBy], [201, null, null]);
    r = await place({ depositor: '' });
    assert.equal(r.json.order.depositor, null);
    r = await place({ depositor: '  홍 길   동  ' });
    assert.equal(r.json.order.depositor, '홍 길 동');
    for (const bad of ['x'.repeat(11), '\u3164', '\u200b\u200b', 5, {}, ['a']]) {
      const b = await place({ depositor: bad });
      assert.equal(b.status, 400, JSON.stringify(bad)); assert.equal(b.json.error, 'bad_depositor', JSON.stringify(bad));
    }
    assert.equal((await place({ depositor: 'ab\u3164' })).json.order.depositor, 'ab');
    assert.equal((await place({ depositor: 'x'.repeat(10) })).status, 201);
    // required
    assert.equal((await s.post('/api/staff/pay', { requireDepositor: true })).status, 200);
    for (const missing of [{}, { depositor: '' }, { depositor: null }]) {
      const m = await place(missing, tk[1]);
      assert.equal(m.status, 400, JSON.stringify(missing)); assert.equal(m.json.error, 'depositor_required');
    }
    const key = newKey();
    const a = await g.post(`/api/t/${tk[1]}/orders`, { key, items: [{ id: 'cola', qty: 1 }], depositor: '김철수' });
    assert.equal(a.status, 201); assert.equal(a.json.order.depositor, '김철수');
    // replays return the stored order, even without or with another depositor name (and after the setting changed)
    await s.post('/api/staff/pay', { requireDepositor: false });
    const rep = await g.post(`/api/t/${tk[1]}/orders`, { key, items: [{ id: 'cola', qty: 1 }], depositor: '다른이름' });
    assert.deepEqual([rep.status, rep.json.duplicate, rep.json.order.depositor], [200, true, '김철수']);
    // staff and guest views carry it
    assert.equal((await s.get('/api/staff/state')).json.orders.find((o) => o.id === a.json.order.id).depositor, '김철수');
    assert.equal((await g.get(`/api/t/${tk[1]}`)).json.orders.find((o) => o.id === a.json.order.id).depositor, '김철수');
    // change it while unpaid
    const url = (T, id) => `/api/t/${T}/orders/${id}/depositor`;
    const ch = await g.post(url(tk[1], a.json.order.id), { depositor: ' 이영희 ' });
    assert.deepEqual([ch.status, ch.json.order.depositor], [200, '이영희']);
    for (const bad of ['', 'x'.repeat(11), '\u3164', null, 5]) assert.equal((await g.post(url(tk[1], a.json.order.id), { depositor: bad })).json.error, 'bad_depositor', JSON.stringify(bad));
    assert.equal((await g.post(url(tk[0], a.json.order.id), { depositor: '남의 주문' })).status, 404, 'another table cannot touch it');
    assert.equal((await g.post(url(tk[1], 99999), { depositor: 'x' })).status, 404);
    await s.post(`/api/staff/orders/${a.json.order.id}/paid`, { paid: true });
    const paid = await g.post(url(tk[1], a.json.order.id), { depositor: '늦은변경' });
    assert.equal(paid.status, 409); assert.equal(paid.json.error, 'already_paid');
    const c = (await place({ depositor: '취소될사람' }, tk[1])).json.order;
    await s.post(`/api/staff/orders/${c.id}/status`, { status: 'cancelled' });
    assert.equal((await g.post(url(tk[1], c.id), { depositor: '무효' })).json.error, 'order_cancelled');
    assert.equal((await s.get('/api/staff/state')).json.orders.find((o) => o.id === a.json.order.id).paidBy, 'staff');
  } finally { await srv.stop(); }
});

// ======================= G4. deposit notices =======================
const smsText = (amount, name, n = 0, bank = '신한') => `[Web발신]\n${bank} 11/13 22:${String(n % 60).padStart(2, '0')}\n110-639-***394\n입금 ${amount.toLocaleString('en-US')}\n잔액 123,456\n${name}`;
const hookPost = (srv, secret, body, type = 'application/json', extra = {}) => raw(srv, 'POST', `${srv.base}/api/deposit-hook/${secret}`, { 'content-type': type, ...extra }, typeof body === 'string' ? body : JSON.stringify(body));
async function depositSetup(env = {}, opts = {}) {
  const srv = await boot({ env: { PUBLIC_ORIGIN: 'https://coms.kw.ac.kr', ...env }, ...opts });
  const s = await staffLogin(srv);
  await s.post('/api/staff/deposits/autoconfirm', { autoConfirm: true }); // ships OFF: these tests exercise the automatic path, so staff switch it on
  const tk = (await tablesOf(s)).map((t) => t.token);
  const secret = (await s.get('/api/staff/deposit-hook')).json.secret;
  let n = 0;
  return {
    srv, s, tk, secret,
    notice: async (text) => JSON.parse((await hookPost(srv, secret, { text: text ?? smsText(8000, 'x', ++n) })).text),
    sms: async (amount, name) => JSON.parse((await hookPost(srv, secret, { text: smsText(amount, name, ++n) })).text),
    place: async (T, depositor, item = 'tteokbokki', qty = 1) => (await order(new Client(srv), T, [{ id: item, qty }], depositor === undefined ? {} : { depositor })).json.order,
    notices: async () => (await s.get('/api/staff/deposits')).json.notices,
    order: async (id) => (await s.get('/api/staff/state')).json.orders.find((o) => o.id === id),
  };
}

test('deposit parsing: the common bank SMS shapes, hardened for automatic confirmation', () => {
  const { parseDeposit, sameDepositor } = require('./db');
  const pick = (t) => { const p = parseDeposit(t); return { kind: p.kind, amount: p.amount ?? null, depositor: p.depositor ?? null, auto: !!p.autoEligible }; };
  const reasons = (t) => parseDeposit(t).reasons ?? [];
  const want = { kind: 'deposit', amount: 16000, depositor: '홍길동', auto: true };
  // auto-eligible: exactly one amount, exactly one name, name and amount on different lines or separated by the word 입금
  assert.deepEqual(pick('[Web발신]\n신한 11/13 22:31\n110-639-***394\n입금 16,000\n잔액 123,456\n홍길동'), want);
  assert.deepEqual(pick('입금 16,000원\n홍길동 → 내 입출금통장'), want, 'KakaoBank: 입출금통장 is a template word, not a withdrawal');
  assert.deepEqual(pick('[KB국민]\n11/13 22:31\n123456-**-***789\n홍길동\n입금 16,000원\n잔액 1,000,000원'), want);
  assert.deepEqual(pick('홍길동 입금 16,000원'), want, 'name, then the literal word 입금, then the amount');
  assert.deepEqual(pick('입금 5,000원\n잔액 999,999원\n김철수'), { kind: 'deposit', amount: 5000, depositor: '김철수', auto: true });
  assert.deepEqual(pick('잔액 999,999원\n입금 5,000원\n김철수'), { kind: 'deposit', amount: 5000, depositor: '김철수', auto: true });
  assert.deepEqual(pick('2026-11-13 22:31:05\n입금 16,000원\n홍길동\n스마트폰뱅킹'), want, 'template words are not names');
  assert.deepEqual(pick('입금 １６，０００원\n홍길동'), want, 'full-width digits are normalised');
  assert.deepEqual(pick('입금 100원\n홍길동'), { kind: 'deposit', amount: 100, depositor: '홍길동', auto: true });
  assert.equal(pick('입금 10,000,000원\n홍길동').amount, 10000000);
  // single-line shapes are display-only: the sender's text touches the amount, or a mid-line "잔액" is a second number
  assert.deepEqual(pick('신한은행 입금 16,000원 홍길동 잔액123,456원'), { ...want, auto: false });
  assert.ok(reasons('신한은행 입금 16,000원 홍길동 잔액123,456원').includes('multiple_amounts'));
  assert.deepEqual(reasons('[신한은행] 홍길동님이 16,000원을 입금했습니다'), ['amount_adjacent_to_name']);
  assert.deepEqual(pick('[신한은행] 홍길동님이 16,000원을 입금했습니다'), { ...want, auto: false });
  assert.deepEqual(reasons('입금 16000원 Hong'), ['amount_adjacent_to_name']);
  assert.deepEqual(reasons('입금 16,000원 홍길동'), ['amount_adjacent_to_name']);
  // no usable amount
  assert.deepEqual(pick('입금되었습니다'), { kind: 'deposit', amount: null, depositor: null, auto: false });
  assert.ok(reasons('입금되었습니다').includes('no_amount'));
  assert.equal(pick('입금 50원\n홍길동').amount, null, 'below 100 won'); assert.ok(reasons('입금 50원\n홍길동').includes('amount_range'));
  assert.equal(pick('입금 10,000,001원\n홍길동').amount, null, 'above 10,000,000 won');
  // withdrawals and anything that is not a deposit: ignored
  for (const t of ['신한 출금 5,000원 잔액 100,000원', '[Web발신] 출금 2,000원', '안녕하세요 광고 메시지 12345', '']) assert.deepEqual(parseDeposit(t), { kind: 'ignore' }, t);
  // a deposit text that also contains a reversal / correction / withdrawal word: manual review, never auto
  for (const t of ['출금 3,000원 입금 3,000원 이체', '[Web발신] 신한 출금 16,000원 홍길동 입금계좌 110-123-4567 잔액 5,000원', '입금취소 16,000원 홍길동', '입금 취소 16,000원 홍길동', '입금정정 16,000원 홍길동',
    '입금오류 16,000원', '입금 반환 16,000원 홍길동', '입금실패 16,000원', '입금 계좌 110-123-4567 16,000원', '입금예정 16,000원 홍길동', '입금한도 초과 16,000원', '입금은행 신한 16,000원 홍길동',
    '[Web발신]\n신한11/13 21:03\n110-***-123456\n입금 16,000\n잔액 1,234,567\n 정정훈', '입금 16,000원\n오류동상회']) {
    const p = parseDeposit(t);
    assert.equal(p.kind, 'review', t); assert.equal(p.autoEligible, false, t); assert.ok(p.reasons.includes('ignore_word'), t);
  }
  assert.deepEqual(pick('[Web발신]\n신한11/13 21:03\n110-***-123456\n입금 16,000\n잔액 1,234,567\n 정정훈'), { kind: 'review', amount: 16000, depositor: '정정훈', auto: false });
  const long = parseDeposit(`입금 16,000원\n홍길동\n${'x'.repeat(300)}`);
  assert.deepEqual([long.kind, long.autoEligible, long.reasons.includes('text_too_long')], ['review', false, true]);
  // injections: the sender controls the name printed in the SMS
  const injections = [
    '[Web발신]\n신한 11/13 22:31\n110-639-***394\n입금 100\n잔액 123,456\n9000원김철',
    '[KB국민] 11/13 22:31\n801302**364\n9000원김철\n입금\n100\n잔액 123,456',
    '[Web발신]\n신한 11/13 22:31\n입금 100\n잔액 123,456\n김철입금9000원', '입금 100원 52000원홍길동', '입금 16,000원\n김철９０００', '입금 16,000원\n김철9',
    // the review's blocker: a sender-typed "잔액" in the middle of a line must not hide the real amount
    '[Web발신]\n신한 11/13 22:31 김철16000잔액 1원 입금', '[Web발신]\n신한 11/13 22:31 김철 16000 잔액 1원 입금', '[Web발신]\n신한 11/13 22:31\n김철16000잔액 1원\n입금',
    '입금 1원\u2028잔액 16000\n김철', '입금 1원\u2029잔액 16000\n김철',
  ];
  for (const t of injections) {
    const p = parseDeposit(t);
    assert.equal(p.autoEligible, false, JSON.stringify(t));
    assert.ok(p.reasons.includes('multiple_amounts'), JSON.stringify(t) + ' ' + p.reasons);
  }
  // shape of the name
  assert.ok(reasons('입금 16,000원\n홍길동 김철수').includes('several_names'));
  assert.ok(reasons('From: 홍길동\n입금 16,000원\n김철수').includes('several_names'));
  assert.ok(reasons('입금 16,000원\nИван').includes('name_shape'));
  assert.ok(reasons('입금 16,000원\n홍길동홍길동홍길동홍길').includes('name_shape'), '11+ characters');
  assert.ok(reasons('입금 16,000원\n김철٣').includes('name_has_digit'), 'other Unicode digits');
  assert.ok(reasons('입금 16,000원').includes('no_name'));
  assert.ok(reasons('입금 16,000원\n홍.길동').includes('name_shape'));
  assert.ok(reasons('입금 16,000원\n김 → 내 통장').includes('no_name'), 'a template word never becomes the name');
  // balance, dates, times and masked accounts never count as amounts
  assert.equal(parseDeposit('[Web발신]\n신한 2026-11-13 22:31:05\n110-***-123456\n입금 16,000\n잔액 123,456\n홍길동').autoEligible, true);
  assert.equal(parseDeposit('입금 16,000원\n잔액 16,000원\n홍길동').autoEligible, true, 'a line-start balance equal to the amount is not a second amount');
  // names: sameDepositor(noticeName, orderName): equal after normalisation, nothing else (no prefix rule)
  assert.ok(sameDepositor('홍길동', ' 홍 길동 ') && sameDepositor('Hong', 'HONG') && sameDepositor('ＡＬＩＣＥ', 'alice'));
  assert.ok(!sameDepositor('가나다라마바', '가나다라마바사아') && !sameDepositor('가나다라마바사아', '가나다라마바') && !sameDepositor('홍길', '홍길동') && !sameDepositor('홍길동동', '홍길동'));
  assert.ok(!sameDepositor('홍', '홍길동') && !sameDepositor('홍길동', '김길동') && !sameDepositor('', '홍길동') && !sameDepositor('길동', '홍길동'));
});

test('deposit hook: secret in the URL, content types, size, rate cap, no session and no origin check', async () => {
  const d = await depositSetup({}, { base: '/booth' });
  try {
    const { srv, s, secret } = d;
    // exact URL text staff copy
    const info = (await s.get('/api/staff/deposit-hook')).json;
    assert.match(secret, /^[a-f0-9]{64}$/);
    assert.equal(info.url, `https://coms.kw.ac.kr/booth/api/deposit-hook/${secret}`);
    assert.equal(info.path, `/booth/api/deposit-hook/${secret}`);
    assert.equal((await new Client(srv).get('/api/staff/deposit-hook')).status, 401);
    // wrong secrets: 404 after a small fixed delay
    for (const bad of ['0'.repeat(64), secret.slice(0, 63) + (secret.endsWith('0') ? '1' : '0'), 'short', secret + 'a', secret.toUpperCase()]) {
      const t0 = Date.now();
      const r = await hookPost(srv, bad, { text: smsText(1000, 'x') });
      assert.equal(r.status, 404, bad);
      assert.ok(Date.now() - t0 >= 250, 'fixed delay');
    }
    assert.equal((await d.notices()).length, 0);
    assert.equal((await raw(srv, 'GET', `/booth/api/deposit-hook/${secret}`)).status, 404, 'GET is not a route');
    // both content types, no session, no same-origin check (automation apps send odd headers)
    const a = await hookPost(srv, secret, { text: smsText(8000, '김철수', 1) }, 'application/json', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' });
    assert.deepEqual([a.status, JSON.parse(a.text).ok, JSON.parse(a.text).status], [200, true, 'pending']);
    const b = await hookPost(srv, secret, smsText(9000, '이영희', 2), 'text/plain; charset=utf-8');
    assert.equal(JSON.parse(b.text).status, 'pending');
    for (const type of ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/html', 'application/xml']) assert.equal((await hookPost(srv, secret, 'text=x', type)).status, 415, type);
    assert.equal((await raw(srv, 'POST', `/booth/api/deposit-hook/${secret}`, {}, 'x')).status, 415, 'no content type');
    assert.equal(JSON.parse((await hookPost(srv, secret, '{nope')).text).error, 'bad_json');
    for (const body of [{ text: 5 }, {}, [], 'null', { message: 'x' }]) assert.equal(JSON.parse((await hookPost(srv, secret, body)).text).error, 'bad_body', JSON.stringify(body));
    const big = await hookPost(srv, secret, 'x'.repeat(2049), 'text/plain');
    assert.equal(big.status, 413);
    assert.equal((await hookPost(srv, secret, 'x'.repeat(2048), 'text/plain')).status, 200, 'exactly 2 KB is fine');
    // raw text is kept to 300 chars
    const long = await hookPost(srv, secret, `입금 7,000원 길동 ${'a'.repeat(600)}`, 'text/plain');
    assert.equal(JSON.parse(long.text).status, 'review', 'texts over 300 characters are reviewed by hand');
    assert.ok((await d.notices()).every((n) => n.text.length <= 300));
    assert.ok((await d.notices())[0].reasons.includes('text_too_long'));
    // 출금 is `ignored` (stored for staff, never matchable), garbage is stored as unparsed
    const before = (await d.notices()).length;
    assert.equal(JSON.parse((await hookPost(srv, secret, { text: '신한 출금 5,000원 잔액 1,000원' })).text).status, 'ignored');
    assert.equal((await d.notices()).length, before + 1);
    assert.equal((await d.notices())[0].status, 'ignored');
    assert.equal((await s.get('/api/staff/state')).json.hookRateLimited, false);
    assert.equal(JSON.parse((await hookPost(srv, secret, { text: '광고 메시지입니다' })).text).status, 'ignored', 'no 입금: ignored');
    assert.equal(JSON.parse((await hookPost(srv, secret, { text: '입금되었습니다' })).text).status, 'unparsed', '입금 without an amount: unparsed');
    assert.equal((await d.notices()).filter((n) => n.status === 'unparsed').length, 1);
    // the rate cap (60 notices per minute) counts accepted notices
    let capped = null;
    for (let i = 0; i < 70; i++) { const r = await hookPost(srv, secret, { text: smsText(1000 + i, '이름', 100 + i) }); if (r.status === 429) { capped = i; break; } }
    assert.ok(capped !== null && capped >= 35 && capped <= 62, `cap hit after ${capped}`);
    assert.equal(JSON.parse((await hookPost(srv, secret, { text: '입금 1,000원 홍' })).text).error, 'rate_limited');
    assert.equal((await s.get('/api/staff/state')).json.hookRateLimited, true, 'staff learn that the hook is being flooded');
    // wrong secrets are not rate limited into the real forwarder's budget
    assert.equal((await hookPost(srv, 'f'.repeat(64), { text: 'x' })).status, 404);
  } finally { await d.srv.stop(); }
});

test('deposit matching: auto-confirm only when exactly one unpaid order has both the amount and the name', async () => {
  const d = await depositSetup();
  try {
    const { s, tk } = d;
    // unique amount + equal name -> auto paid
    const o1 = await d.place(tk[0], '홍길동');
    const gs = await openSse(d.srv, '/api/staff/events', { cookie: s.cookieHeader() });
    try {
      await gs.until((b) => b.includes('event: state'));
      const m = await d.sms(8000, '홍길동');
      assert.deepEqual([m.status, m.orderId === undefined], ['matched', true]); // the hook answer never reveals the order
      await gs.until((b) => b.includes('event: deposit_matched'));
      const p = await d.sms(6000, '아무개');
      assert.equal(p.status, 'pending');
      await gs.until((b) => b.includes('event: new_deposit'));
    } finally { gs.close(); }
    const paid = await d.order(o1.id);
    assert.deepEqual([paid.paid, paid.paidBy], [true, 'auto']);
    assert.equal((await new Client(d.srv).get(`/api/t/${tk[0]}`)).json.orders[0].paid, true, 'guest gets the normal paid update');
    const list = await d.notices();
    const matched = list.find((n) => n.status === 'matched');
    assert.deepEqual([matched.amount, matched.depositor, matched.orderId, matched.matchedBy], [8000, '홍길동', o1.id, 'auto']);
    // amount matches but the name differs -> pending, with the candidate listed
    const o2 = await d.place(tk[1], '김철수');
    const diff = await d.sms(8000, '박다른');
    assert.equal(diff.status, 'pending');
    const pend = (await d.notices()).find((n) => n.id === diff.id);
    assert.deepEqual(pend.candidates.map((c) => [c.id, c.table, c.total, c.depositor]), [[o2.id, 2, 8000, '김철수']]);
    assert.equal((await d.order(o2.id)).paid, false);
    // order without a depositor name -> pending, never auto
    const o3 = await d.place(tk[2]);
    assert.equal((await d.sms(8000, '이영희')).status, 'pending');
    assert.equal((await d.order(o3.id)).paid, false);
    // a notice without a readable name never auto-confirms
    assert.equal(JSON.parse((await hookPost(d.srv, d.secret, { text: '입금 8,000원 잔액 1,000원' })).text).status, 'pending');
    assert.equal((await d.order(o2.id)).paid, false);
    // wrong amount: pending without candidates
    const none = await d.sms(12345, '김철수');
    assert.equal((await d.notices()).find((n) => n.id === none.id).candidates.length, 0);
  } finally { await d.srv.stop(); }
});

test('deposit matching (strict): exactly ONE unpaid order with that amount, equal name; prefix only for long names, never the reverse', async () => {
  const d = await depositSetup();
  try {
    const { tk } = d;
    const paid = async (o) => (await d.order(o.id)).paid;
    // review case: payer A left the name empty and pays as 김철수; guest B guessed "김철" on a same-amount order -> pending, both listed
    const A = await d.place(tk[0]); const B = await d.place(tk[1], '김철');
    const steal = await d.sms(8000, '김철수');
    assert.equal(steal.status, 'pending');
    const n = (await d.notices()).find((x) => x.id === steal.id);
    assert.deepEqual(n.candidates.map((c) => c.id).sort(), [A.id, B.id].sort());
    assert.deepEqual([await paid(A), await paid(B)], [false, false]);
    // even an exactly matching name is not enough while another order has the same amount
    assert.equal((await d.sms(8000, '김철')).status, 'pending');
    assert.deepEqual([await paid(A), await paid(B)], [false, false]);
    const C = await d.place(tk[2], '홍길동', 'odeng'); const E = await d.place(tk[3], '박철수', 'odeng'); // 9,000 each
    assert.equal((await d.sms(9000, '홍길동')).status, 'pending');
    assert.deepEqual([await paid(C), await paid(E)], [false, false]);
    // exactly one order at the amount and an equal name -> confirmed (case / width / spaces normalised)
    const F = await d.place(tk[4], '이 영희', 'fries'); // 6,000 (the order's name has a space)
    assert.equal((await d.sms(6000, '이영희')).status, 'matched');
    assert.equal(await paid(F), true);
    const K = await d.place(tk[5], 'Alice', 'cola', 6); // 12,000
    assert.equal((await d.sms(12000, 'ＡＬＩＣＥ')).status, 'matched');
    assert.equal(await paid(K), true);
    // reverse direction: the order has the short name, the notice is longer -> pending
    const G = await d.place(tk[6], '김철', 'cola'); // 2,000
    assert.equal((await d.sms(2000, '김철수')).status, 'pending');
    assert.equal(await paid(G), false);
    // short notice names are never prefixes: 2 characters of a 4-character name
    const H = await d.place(tk[7], '남궁민수', 'cola', 2); // 4,000
    assert.equal((await d.sms(4000, '남궁')).status, 'pending');
    assert.equal(await paid(H), false);
    // no prefix rule: a truncated long name is NOT enough, however long the prefix (a guest could guess the first characters of someone's name)
    const I = await d.place(tk[8], '가나다라마바사아', 'cola', 3); // 6,000 (F is paid, so this is the only unpaid 6,000)
    assert.equal((await d.sms(6000, '가나다라마')).status, 'pending');
    assert.equal((await d.sms(6000, '가나다라마바')).status, 'pending');
    assert.equal((await d.sms(6000, '가나다라마바사')).status, 'pending');
    assert.equal(await paid(I), false);
    assert.equal((await d.sms(6000, '가나다라마바사아')).status, 'matched', 'the full name matches');
    assert.equal(await paid(I), true);
    // an order without a depositor never auto-confirms, whatever the notice says
    const J = await d.place(tk[9], undefined, 'cola', 5); // 10,000
    assert.equal((await d.sms(10000, '아무개')).status, 'pending');
    assert.equal(await paid(J), false);
    // a paid order cannot be paid again by another notice
    assert.equal((await d.sms(12000, 'ＡＬＩＣＥ')).status, 'pending');
  } finally { await d.srv.stop(); }
});

test('deposit notices: reversal / withdrawal texts never pay an order: reviewable (入金 present) or ignored (withdrawal only)', async () => {
  const d = await depositSetup();
  try {
    const o = await d.place(d.tk[0], '홍길동', 'tteokbokki', 2); // 16,000
    const t1 = '[Web발신] 신한 출금 16,000원 홍길동 입금계좌 110-123-4567 잔액 5,000원';
    const t2 = '입금취소 16,000원 홍길동';
    const t3 = '신한 11/13 22:31 출금 16,000원 홍길동';
    const t4 = '[Web발신]\n신한11/13 21:03\n110-***-123456\n입금 16,000\n잔액 1,234,567\n 정정훈'; // a real deposit from a person named 정정훈
    for (const [text, status] of [[t1, 'review'], [t2, 'review'], [t3, 'ignored'], [t4, 'review']]) {
      assert.equal((await d.notice(text)).status, status, text);
      assert.equal((await d.order(o.id)).paid, false, text);
    }
    const list = await d.notices();
    assert.deepEqual(list.map((n) => n.status), ['review', 'ignored', 'review', 'review']);
    const rev = list.filter((n) => n.status === 'review');
    assert.ok(rev.every((n) => n.reasons.includes('ignore_word') && n.amountGuessed === true && n.amount === 16000 && n.candidates.length === 0));
    assert.deepEqual((await d.s.get('/api/staff/state')).json.deposit, { pending: 3, unparsed: 0, ignored: 1, review: 3, autoConfirm: true, autoConfirmMaxAmount: 30000 }, 'review notices are counted in the pending badge');
    // review notices are manual: assignable only with force, dismissable; ignored ones are final
    const asg = (id, body) => d.s.post(`/api/staff/deposits/${id}/assign`, { orderId: o.id, ...body });
    assert.equal((await asg(rev[0].id, {})).json.error, 'review_needs_force');
    assert.equal((await asg(list[1].id, { force: true })).json.error, 'notice_closed');
    assert.equal((await d.s.post(`/api/staff/deposits/${list[1].id}/dismiss`)).json.error, 'notice_closed');
    const done = await asg(rev[0].id, { force: true }); // t4 (the 정정훈 deposit) newest first
    assert.equal(done.status, 200, done.text);
    assert.deepEqual([done.json.order.paid, done.json.order.paidBy], [true, 'staff']);
    assert.equal((await d.s.post(`/api/staff/deposits/${rev[1].id}/dismiss`)).json.notice.status, 'dismissed');
  } finally { await d.srv.stop(); }
});

test('deposit notices: an identical text collapses into one row (repeatCount / lastAt), never auto-confirmed; only a retry within 5 seconds is dropped', async () => {
  const d = await depositSetup();
  try {
    const { s, tk } = d;
    const text = '입금 8,000원\n홍길동'; // a forwarder that sends no time or balance: identical texts for identical deposits
    const o1 = await d.place(tk[0], '홍길동');
    const first = await d.notice(text);
    assert.equal(first.status, 'matched');
    assert.equal((await d.order(o1.id)).paid, true);
    assert.equal((await d.notice(text)).status, 'duplicate', 'a retry within seconds is the only silent drop');
    assert.equal((await d.notices()).length, 1);
    // the same payer pays a SECOND order later: same text, 20 s afterwards. The matched row is final, so this is a new pending row (never auto).
    const o2 = await d.place(tk[1], '홍길동');
    const db = new DatabaseSync(path.join(d.srv.data, 'booth.db'));
    db.exec('PRAGMA busy_timeout=3000');
    const back = (ms) => db.prepare('UPDATE deposit_notices SET received_at=received_at-?1, last_at=COALESCE(last_at, received_at)-?1').run(ms);
    back(20000);
    const second = await d.notice(text);
    assert.equal(second.status, 'pending', 'not dropped, not auto-confirmed');
    assert.equal((await d.order(o2.id)).paid, false);
    const row = (await d.notices()).find((n) => n.id === second.id);
    assert.deepEqual([row.repeatCount, row.status, row.reasons.includes('duplicate'), row.candidates.map((c) => c.id)], [1, 'pending', true, [o2.id]]);
    // ... and every further identical text collapses into THAT row instead of creating rows
    back(20000);
    const again = await d.notice(text);
    assert.deepEqual([again.status, again.id], ['pending', second.id]);
    back(20000);
    assert.equal((await d.notice(text)).id, second.id);
    const list = await d.notices();
    assert.equal(list.length, 2, 'no new rows');
    const collapsed = list.find((n) => n.id === second.id);
    assert.equal(collapsed.repeatCount, 3);
    assert.ok(collapsed.lastAt >= collapsed.receivedAt);
    assert.equal((await d.order(o2.id)).paid, false, 'still not auto-confirmed');
    // staff can assign it
    assert.equal((await s.post(`/api/staff/deposits/${second.id}/assign`, { orderId: o2.id })).status, 200);
    // after the 6-hour window the same text is an ordinary notice again (and may auto-confirm)
    const o3 = await d.place(tk[2], '홍길동');
    back(7 * 3600e3);
    const fresh = await d.notice(text);
    assert.equal(fresh.status, 'matched');
    assert.equal((await d.notices()).find((n) => n.id === fresh.id).repeatCount, 1);
    assert.equal((await d.order(o3.id)).paid, true);
    db.close();
  } finally { await d.srv.stop(); }
});

test('deposit hook: the secret may also come in an X-Booth-Hook header', async () => {
  const d = await depositSetup({}, { base: '/booth' });
  try {
    const { srv, s, secret } = d;
    const info = (await s.get('/api/staff/deposit-hook')).json;
    assert.deepEqual([info.header, info.headerUrl, info.url, info.path], ['X-Booth-Hook', 'https://coms.kw.ac.kr/booth/api/deposit-hook', `https://coms.kw.ac.kr/booth/api/deposit-hook/${secret}`, `/booth/api/deposit-hook/${secret}`]);
    const viaHeader = (body, h, type = 'application/json') => raw(srv, 'POST', '/booth/api/deposit-hook', { 'content-type': type, ...h }, typeof body === 'string' ? body : JSON.stringify(body));
    const ok = await viaHeader({ text: smsText(1000, '헤더', 1) }, { 'x-booth-hook': secret });
    assert.deepEqual([ok.status, JSON.parse(ok.text).status], [200, 'pending']);
    assert.equal((await viaHeader(smsText(1100, '헤더', 2), { 'x-booth-hook': secret }, 'text/plain')).status, 200);
    for (const h of [{}, { 'x-booth-hook': '' }, { 'x-booth-hook': '0'.repeat(64) }, { 'x-booth-hook': secret.toUpperCase() }, { 'x-booth-hook': secret + 'x' }, { authorization: secret }]) {
      const t0 = Date.now();
      assert.equal((await viaHeader({ text: smsText(1200, 'x', 3) }, h)).status, 404, JSON.stringify(h));
      assert.ok(Date.now() - t0 >= 250);
    }
    assert.equal((await hookPost(srv, secret, { text: smsText(1300, '경로', 4) })).status, 200, 'the path form still works');
    assert.equal((await new Client(srv).get('/api/staff/deposit-hook')).status, 401);
    const rot = (await s.post('/api/staff/deposit-hook/rotate')).json;
    assert.equal((await viaHeader({ text: smsText(1400, 'x', 5) }, { 'x-booth-hook': secret })).status, 404, 'rotation invalidates both forms');
    assert.equal((await viaHeader({ text: smsText(1400, 'y', 6) }, { 'x-booth-hook': rot.secret })).status, 200);
    assert.equal((await hookPost(srv, secret, { text: smsText(1500, 'z', 7) })).status, 404);
  } finally { await d.srv.stop(); }
});

test('open orders on tables above the table count are reported (boot warning + staff state)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-hidden-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const old = new DatabaseSync(path.join(dir, 'data', 'booth.db'));
  old.exec(HEAD_SCHEMA);
  const toks = [];
  for (let i = 1; i <= 10; i++) { const t = crypto.randomBytes(12).toString('base64url'); toks.push(t); old.prepare('INSERT INTO tables(id, token) VALUES(?,?)').run(i, t); }
  const ins = old.prepare("INSERT INTO orders(table_id,seat,key,status,paid,subtotal,discount,total,note,created_at,updated_at) VALUES(?,1,?,?,?,5000,0,5000,'',?,?)");
  const ts = Date.now();
  ins.run(8, 'key-table-08', 'pending', 0, ts, ts); // visible table: not reported
  ins.run(9, 'key-table-09', 'served', 0, ts, ts); // served but unpaid
  ins.run(10, 'key-table-10', 'served', 1, ts, ts); // settled: not reported
  ins.run(10, 'key-table-10b', 'cooking', 1, ts, ts); // paid but not served
  old.close();
  const srv = await boot({ dir, tablesCount: 8 });
  try {
    assert.match(srv.log(), /WARNING: tables above the table count \(8\) have open orders.*: 9, 10/);
    const s = await staffLogin(srv);
    const st = (await s.get('/api/staff/state')).json;
    assert.deepEqual([st.tableCount, st.hiddenTablesWithOpenOrders], [8, [9, 10]]);
    assert.equal((await s.post('/api/staff/tables/count', { count: 10 })).status, 200);
    assert.deepEqual((await s.get('/api/staff/state')).json.hiddenTablesWithOpenOrders, []);
    await s.post('/api/staff/tables/count', { count: 9, force: true });
    assert.deepEqual((await s.get('/api/staff/state')).json.hiddenTablesWithOpenOrders, [10]);
    await s.post('/api/staff/tables/count', { count: 10 });
    for (const o of (await s.get('/api/staff/state')).json.orders.filter((x) => x.table === 9 || x.table === 10)) {
      await s.post(`/api/staff/orders/${o.id}/status`, { status: 'served' });
      await s.post(`/api/staff/orders/${o.id}/paid`, { paid: true });
    }
    await s.post('/api/staff/tables/count', { count: 8 }); // nothing open any more: no force needed
    assert.deepEqual((await s.get('/api/staff/state')).json.hiddenTablesWithOpenOrders, []);
  } finally { await srv.stop(); }
  // a clean database logs no warning
  const clean = await boot({ tablesCount: 3 });
  try { assert.ok(!/WARNING: tables above/.test(clean.log())); } finally { await clean.stop(); }
});

test('deposit notices: the manual queue never refuses while something can be evicted (unparsed first, then ignored); matched / pending / review are kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-prune-'));
  const store = createStore({ dataDir: dir, menu: MENU, rewards: REWARDS, tableCount: 2 });
  try {
    store.setAutoConfirm({ autoConfirm: true });
    const tk = store.tokens();
    const o = store.createOrder(tk[0].id, { key: 'prune-key-0001', items: [{ id: 'cola', qty: 1 }], depositor: '홍길동' }).order;
    assert.equal(store.ingestDeposit('입금 2,000원\n홍길동').status, 'matched');
    const rows = () => { const db = new DatabaseSync(path.join(dir, 'booth.db'), { readOnly: true }); const r = db.prepare('SELECT status, COUNT(*) n FROM deposit_notices GROUP BY status').all(); db.close(); return Object.fromEntries(r.map((x) => [x.status, x.n])); };
    // ignored rows are capped at 2000 by pruning; with the queue cap (1500) they are also evicted when room is needed
    for (let i = 0; i < 2010; i++) assert.equal(store.ingestDeposit(`광고 메시지 #${i}`).status, 'ignored');
    assert.ok(rows().ignored <= 1500, JSON.stringify(rows()));
    assert.equal(rows().matched, 1, 'the matched notice survived');
    // a fresh store for the eviction order: 1 unparsed + 1 ignored + 1498 pending = full
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-prune2-'));
    const st2 = createStore({ dataDir: dir2, menu: MENU, rewards: REWARDS, tableCount: 2 });
    try {
      assert.equal(st2.ingestDeposit('입금되었습니다 xqz').status, 'unparsed');
      assert.equal(st2.ingestDeposit('광고 gggg').status, 'ignored');
      const pend = (i) => st2.ingestDeposit(`입금 ${1000 + (i % 300)}원 누구 #${i}`);
      for (let i = 0; i < 1498; i++) assert.equal(pend(i).status, 'pending');
      const db2 = () => new DatabaseSync(path.join(dir2, 'booth.db'), { readOnly: true });
      const counts = () => { const d = db2(); const r = Object.fromEntries(d.prepare('SELECT status, COUNT(*) n FROM deposit_notices GROUP BY status').all().map((x) => [x.status, x.n])); d.close(); return r; };
      assert.deepEqual(counts(), { pending: 1498, unparsed: 1, ignored: 1 });
      assert.equal(pend(1498).status, 'pending'); // evicts the unparsed row first
      assert.deepEqual(counts(), { pending: 1499, ignored: 1 });
      assert.equal(pend(1499).status, 'pending'); // then the ignored one
      assert.deepEqual(counts(), { pending: 1500 });
      assert.equal(pend(1500).status, 'queue_full', 'only when nothing is evictable');
      assert.equal(st2.depositCounts().pending, 1500);
    } finally { st2.close(); fs.rmSync(dir2, { recursive: true, force: true }); }
    void o;
  } finally { try { store.close(); } catch { /* already closed */ } fs.rmSync(dir, { recursive: true, force: true }); }
});

test('deposit matching: candidate rules (age, cancelled, paid, table count, past seats) and duplicates', async () => {
  const d = await depositSetup();
  try {
    const { s, tk } = d;
    // too old (> 6 h): not a candidate
    const old = await d.place(tk[0], '홍길동');
    const raw2 = new DatabaseSync(path.join(d.srv.data, 'booth.db'));
    raw2.exec('PRAGMA busy_timeout=3000');
    raw2.prepare('UPDATE orders SET created_at=created_at-? WHERE id=?').run(6 * 3600e3 + 60000, old.id);
    assert.equal((await d.sms(8000, '홍길동')).status, 'pending');
    assert.equal((await d.order(old.id)).paid, false);
    raw2.prepare('UPDATE orders SET created_at=created_at+? WHERE id=?').run(60 * 60000, old.id); // 5 h old: eligible again
    assert.equal((await d.sms(8000, '홍길동')).status, 'matched');
    raw2.close();
    // cancelled and already-paid orders are not candidates
    const canc = await d.place(tk[1], '김철수'); await s.post(`/api/staff/orders/${canc.id}/status`, { status: 'cancelled' });
    assert.equal((await d.sms(8000, '김철수')).status, 'pending');
    const manual = await d.place(tk[2], '이영희'); await s.post(`/api/staff/orders/${manual.id}/paid`, { paid: true });
    assert.equal((await d.sms(8000, '이영희')).status, 'pending');
    // an order of a previous seating (table force-cleared) is invisible to staff and must never be paid automatically
    const past = await d.place(tk[3], '박과거', 'fries'); await s.post(`/api/staff/orders/${past.id}/status`, { status: 'served' });
    assert.equal((await s.post('/api/staff/tables/4/clear', { force: true })).status, 200);
    const pastN = await d.sms(6000, '박과거');
    assert.equal(pastN.status, 'pending');
    assert.ok((await d.notices()).find((n) => n.id === pastN.id).reasons.includes('no_candidate'));
    assert.equal((await d.order(past.id)), undefined, 'the order is not even in the staff state any more');
    // ... and the current order of that table is the one that can be matched
    const current = await d.place(tk[3], '박과거', 'fries');
    assert.equal((await d.sms(6000, '박과거')).status, 'matched');
    assert.equal((await d.order(current.id)).paid, true);
    // tables above the table count are out
    const hidden = await d.place(tk[7], '최숨김', 'odeng');
    await s.post('/api/staff/tables/count', { count: 7, force: true });
    assert.equal((await d.sms(9000, '최숨김')).status, 'pending');
    await s.post('/api/staff/tables/count', { count: 8 });
    assert.equal((await d.sms(9000, '최숨김')).status, 'matched');
    assert.equal((await d.order(hidden.id)).paid, true);
    // duplicates: same normalised text within 10 minutes is ignored (forwarders retry)
    const t = smsText(2000, '정중복', 7);
    const before = (await d.notices()).length;
    assert.equal(JSON.parse((await hookPost(d.srv, d.secret, { text: t })).text).status, 'pending');
    for (const variant of [t, t.replace(/\n/g, ' '), `  ${t.toUpperCase()}  `, t.replace('입금 ', '입금  ')]) {
      assert.equal(JSON.parse((await hookPost(d.srv, d.secret, { text: variant })).text).status, 'duplicate', variant);
    }
    assert.equal((await d.notices()).length, before + 1);
    // ... but not after 10 minutes (stored as pending for staff)
    const raw3 = new DatabaseSync(path.join(d.srv.data, 'booth.db'));
    raw3.exec('PRAGMA busy_timeout=3000');
    raw3.prepare('UPDATE deposit_notices SET received_at=received_at-?1, last_at=COALESCE(last_at, received_at)-?1').run(11 * 60000);
    raw3.close();
    assert.equal(JSON.parse((await hookPost(d.srv, d.secret, { text: t })).text).status, 'pending');
  } finally { await d.srv.stop(); }
});

test('deposit notices: undo, assign, dismiss, auto-confirm switch, unparsed, secret rotation, reset, never visible to guests', async () => {
  const d = await depositSetup();
  try {
    const { s, tk, srv } = d;
    // ---- undo of an automatic confirmation frees the notice ----
    const o1 = await d.place(tk[0], '홍길동');
    const auto = await d.sms(8000, '홍길동');
    assert.equal(auto.status, 'matched');
    const un = await s.post(`/api/staff/orders/${o1.id}/paid`, { paid: false });
    assert.deepEqual([un.json.order.paid, un.json.order.paidBy], [false, null]);
    let n1 = (await d.notices()).find((n) => n.id === auto.id);
    assert.deepEqual([n1.status, n1.orderId, n1.matchedBy, n1.candidates.map((c) => c.id)], ['pending', null, null, [o1.id]]);
    // staff marks paid manually: paid_by staff, the notice stays pending (not linked)
    assert.equal((await s.post(`/api/staff/orders/${o1.id}/paid`, { paid: true })).json.order.paidBy, 'staff');
    assert.equal((await d.notices()).find((n) => n.id === auto.id).status, 'pending');
    await s.post(`/api/staff/orders/${o1.id}/paid`, { paid: false });
    // ---- assign ----
    const asg = async (nid, body) => s.post(`/api/staff/deposits/${nid}/assign`, body);
    assert.equal((await new Client(srv).post(`/api/staff/deposits/${auto.id}/assign`, { orderId: o1.id })).status, 401);
    assert.equal((await asg(auto.id, {})).json.error, 'bad_order');
    assert.equal((await asg(9999, { orderId: o1.id })).status, 404);
    assert.equal((await asg(auto.id, { orderId: 9999 })).json.error, 'no_order');
    const ok = await asg(auto.id, { orderId: o1.id });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual([ok.json.order.paid, ok.json.order.paidBy, ok.json.notice.status, ok.json.notice.matchedBy, ok.json.notice.orderId], [true, 'staff', 'matched', 'staff', o1.id]);
    assert.equal((await asg(auto.id, { orderId: o1.id })).json.error, 'notice_closed', 'a notice matches at most one order');
    // an order is paid by at most one notice
    const second = await d.sms(8000, '아무개');
    assert.equal((await asg(second.id, { orderId: o1.id })).json.error, 'order_paid');
    // amount mismatch needs force
    const o2 = await d.place(tk[1], '김철수', 'odeng'); // 9,000
    const mm = await asg(second.id, { orderId: o2.id });
    assert.equal(mm.status, 409); assert.deepEqual([mm.json.error, mm.json.noticeAmount, mm.json.orderTotal], ['amount_mismatch', 8000, 9000]);
    assert.equal((await asg(second.id, { orderId: o2.id, force: 'true' })).json.error, 'amount_mismatch', 'only literal true forces');
    assert.equal((await asg(second.id, { orderId: o2.id, force: true })).json.error, 'note_required', 'forcing a mismatch needs a reason');
    assert.equal((await asg(second.id, { orderId: o2.id, force: true, note: 'x'.repeat(61) })).json.error, 'note_required', 'note is at most 60 characters');
    assert.equal((await asg(second.id, { orderId: o2.id, force: true, note: '차액은 현금으로 받음' })).status, 200);
    // cancelled orders cannot be assigned
    const o3 = await d.place(tk[2], '이영희'); await s.post(`/api/staff/orders/${o3.id}/status`, { status: 'cancelled' });
    const third = await d.sms(8000, '이영희');
    assert.equal((await asg(third.id, { orderId: o3.id })).json.error, 'order_cancelled');
    // ---- dismiss ----
    const dis = await s.post(`/api/staff/deposits/${third.id}/dismiss`);
    assert.deepEqual([dis.status, dis.json.notice.status], [200, 'dismissed']);
    assert.equal((await s.post(`/api/staff/deposits/${third.id}/dismiss`)).json.error, 'notice_closed');
    assert.equal((await s.post(`/api/staff/deposits/${auto.id}/dismiss`)).json.error, 'notice_closed', 'matched notices cannot be dismissed');
    assert.equal((await s.post('/api/staff/deposits/9999/dismiss')).status, 404);
    assert.equal((await asg(third.id, { orderId: o1.id })).json.error, 'notice_closed');
    // ---- unparsed ----
    const garbage = JSON.parse((await hookPost(srv, d.secret, { text: '입금되었습니다 (금액 미표시)' })).text);
    assert.equal(garbage.status, 'unparsed');
    const st = (await s.get('/api/staff/state')).json.deposit;
    assert.deepEqual([st.pending, st.unparsed, st.autoConfirm], [0, 1, true]);
    const o4 = await d.place(tk[3], '박넷째');
    assert.equal((await asg(garbage.id, { orderId: o4.id })).json.error, 'amount_mismatch', 'no amount known: staff has to force it');
    assert.equal((await asg(garbage.id, { orderId: o4.id, force: true })).json.error, 'note_required');
    assert.equal((await asg(garbage.id, { orderId: o4.id, force: true, note: '문자 형식이 달라 직접 확인' })).status, 200);
    assert.equal((await s.post(`/api/staff/deposits/${garbage.id}/dismiss`)).json.error, 'notice_closed');
    // ---- the auto-confirm switch ----
    for (const bad of ['yes', 1, null, undefined]) assert.equal((await s.post('/api/staff/deposits/autoconfirm', { autoConfirm: bad })).json.error, 'bad_auto_confirm', String(bad));
    assert.equal((await new Client(srv).post('/api/staff/deposits/autoconfirm', { autoConfirm: false })).status, 401);
    assert.equal((await s.post('/api/staff/deposits/autoconfirm', { autoConfirm: false })).json.autoConfirm, false);
    assert.equal((await s.get('/api/staff/state')).json.deposit.autoConfirm, false);
    const o5 = await d.place(tk[4], '최다섯');
    assert.equal((await d.sms(8000, '최다섯')).status, 'pending', 'everything stays pending when auto-confirm is off');
    assert.equal((await d.order(o5.id)).paid, false);
    const pend = (await d.notices()).find((n) => n.status === 'pending' && n.depositor === '최다섯');
    assert.deepEqual(pend.candidates.map((c) => c.id), [o5.id]);
    assert.equal((await asg(pend.id, { orderId: o5.id })).status, 200, 'one-tap assignment');
    await s.post('/api/staff/deposits/autoconfirm', { autoConfirm: true });
    const o6 = await d.place(tk[5], '정여섯');
    assert.equal((await d.sms(8000, '정여섯')).status, 'matched');
    // ---- the secret ----
    const oldSecret = d.secret;
    const rot = await s.post('/api/staff/deposit-hook/rotate');
    assert.equal(rot.status, 200);
    assert.notEqual(rot.json.secret, oldSecret);
    assert.match(rot.json.secret, /^[a-f0-9]{64}$/);
    assert.equal(rot.json.url, `https://coms.kw.ac.kr/api/deposit-hook/${rot.json.secret}`);
    assert.equal((await s.get('/api/staff/deposit-hook')).json.secret, rot.json.secret);
    assert.equal((await hookPost(srv, oldSecret, { text: smsText(1000, 'x', 33) })).status, 404, 'the old secret stops working at once');
    assert.equal((await hookPost(srv, rot.json.secret, { text: smsText(1000, '새비밀', 34) })).status, 200);
    assert.equal((await new Client(srv).post('/api/staff/deposit-hook/rotate')).status, 401);
    // ---- guests never see notices or the secret ----
    const g = new Client(srv);
    const everything = [(await g.get(`/api/t/${tk[0]}`)).text, (await g.get('/api/board')).text, (await g.get('/api/menu')).text];
    for (const text of everything) assert.ok(!text.includes(rot.json.secret) && !/notices|noticeId|receivedAt/i.test(text) && !text.includes('Web발신'), 'no notice data for guests');
    for (const p of ['/api/staff/deposits', '/api/staff/deposit-hook']) assert.equal((await g.get(p)).status, 401, p);
    assert.equal((await g.get(`/api/deposit-hook/${rot.json.secret}`)).status, 404);
    // ---- reset clears notices, keeps the secret and the pay settings ----
    await s.post('/api/staff/pay', { requireDepositor: true });
    assert.ok((await d.notices()).length > 0);
    assert.equal((await s.post('/api/staff/reset', { confirm: '초기화' })).status, 200);
    assert.deepEqual(await d.notices(), []);
    assert.deepEqual([(await s.get('/api/staff/state')).json.deposit.pending, (await s.get('/api/staff/state')).json.deposit.unparsed], [0, 0]);
    assert.equal((await s.get('/api/staff/deposit-hook')).json.secret, rot.json.secret);
    assert.equal((await s.get('/api/staff/state')).json.pay.requireDepositor, true);
    assert.equal((await hookPost(srv, rot.json.secret, { text: smsText(1000, '리셋후', 35) })).status, 200);
    void o6;
  } finally { await d.srv.stop(); }
});

test('deposit notices: the staff list is capped at the newest 200', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-dep-'));
  const store = createStore({ dataDir: dir, menu: MENU, rewards: REWARDS, tableCount: 2 });
  try {
    for (let i = 0; i < 205; i++) store.ingestDeposit(`입금 ${1000 + i}원 홍길동 #${i}`);
    const { notices: list, next } = store.listDeposits();
    assert.equal(list.length, 200);
    assert.equal(next, list[199].id, 'a full page tells where the next one starts');
    assert.equal(store.listDeposits({ before: next, limit: 50 }).notices.length, 5);
    assert.equal(list[0].amount, 1204);
    assert.deepEqual(store.depositCounts(), { pending: 205, unparsed: 0, ignored: 0, review: 0, autoConfirm: false, autoConfirmMaxAmount: 30000 });
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ======================= deposit notices: second-model review fixes =======================
test('deposit injection: the sender-controlled name can never make a 100 won transfer pay a 9,000 won order', async () => {
  const d = await depositSetup();
  try {
    const { tk, s } = d;
    const o = await d.place(tk[0], '김철', 'odeng'); // 9,000
    const shinhan = '[Web발신]\n신한 11/13 22:31\n110-639-***394\n입금 100\n잔액 123,456\n9000원김철';
    const kb = '[KB국민] 11/13 22:31\n801302**364\n9000원김철\n입금\n100\n잔액 123,456';
    const mixed = '[Web발신]\n신한 11/13 22:31\n입금 100\n잔액 123,456\n김철입금9000원';
    const big = '입금 100원 52000원홍길동';
    for (const text of [shinhan, kb, mixed, big]) {
      const r = await d.notice(text);
      assert.equal(r.status, 'pending', text);
      assert.equal((await d.order(o.id)).paid, false, text);
      const n = (await d.notices()).find((x) => x.id === r.id);
      assert.ok(n.reasons.includes('multiple_amounts'), text);
      assert.equal(n.amountGuessed, true, 'shown as an estimated amount');
    }
    // the same texts through the staff preview: eligible = false, nothing matched
    const pv = (await s.post('/api/staff/deposit-hook/test', { text: shinhan })).json;
    assert.deepEqual([pv.parsed.autoEligible, pv.wouldMatch.status], [false, 'pending']);
    // staff can still assign it by hand; a guessed amount that differs from the order total needs force
    const stray = (await d.notices()).find((n) => n.status === 'pending');
    const noForce = await s.post(`/api/staff/deposits/${stray.id}/assign`, { orderId: (await d.place(tk[1], '박다른', 'cola')).id });
    assert.equal(noForce.json.error, 'amount_mismatch');
  } finally { await d.srv.stop(); }
});

test('deposit matching: a hand-paid order with the same amount blocks auto-confirm; attach links the notice without touching payment', async () => {
  const d = await depositSetup();
  try {
    const { s, tk } = d;
    const X = await d.place(tk[0], '홍길동', 'fries'); const Y = await d.place(tk[0], '홍길동', 'fries'); // 6,000 each, same name
    await s.post(`/api/staff/orders/${X.id}/paid`, { paid: true }); // staff marked X by hand (guest showed the transfer screen)
    const late = await d.sms(6000, '홍길동'); // the SMS of that very transfer arrives afterwards
    assert.equal(late.status, 'pending', 'Y must not be paid for the transfer that belongs to X');
    assert.equal((await d.order(Y.id)).paid, false);
    const n = (await d.notices()).find((x) => x.id === late.id);
    assert.ok(n.reasons.includes('maybe_already_handled'));
    assert.deepEqual([n.candidates.map((c) => c.id), n.handledOrders.map((c) => c.id)], [[Y.id], [X.id]]);
    // attach errors
    const attach = (id, body) => s.post(`/api/staff/deposits/${id}/attach`, body);
    assert.equal((await new Client(d.srv).post(`/api/staff/deposits/${late.id}/attach`, { orderId: X.id })).status, 401);
    assert.equal((await attach(late.id, {})).json.error, 'bad_order');
    assert.equal((await attach(late.id, { orderId: Y.id })).json.error, 'order_unpaid');
    assert.equal((await attach(late.id, { orderId: 99999 })).status, 404);
    assert.equal((await attach(99999, { orderId: X.id })).status, 404);
    const ok = await attach(late.id, { orderId: X.id });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual([ok.json.notice.status, ok.json.notice.matchedBy, ok.json.notice.orderId, ok.json.order.paid, ok.json.order.paidBy], ['matched', 'staff', X.id, true, 'staff']);
    assert.equal((await d.order(Y.id)).paid, false, 'the other order is untouched');
    assert.equal((await attach(late.id, { orderId: X.id })).json.error, 'notice_closed');
    // an order linked to a notice does not count as hand-paid any more: a second real transfer for Y confirms normally
    const second = await d.sms(6000, '홍길동');
    assert.equal(second.status, 'matched');
    assert.equal((await d.order(Y.id)).paidBy, 'auto');
    const another = await d.sms(6000, '홍길동');
    assert.equal(another.status, 'pending');
    assert.ok((await d.notices()).find((x) => x.id === another.id).reasons.includes('no_candidate'));
    // amount mismatch needs force on attach, and undoing the payment releases the notice
    const Z = await d.place(tk[1], '김철수', 'odeng'); await s.post(`/api/staff/orders/${Z.id}/paid`, { paid: true });
    assert.equal((await attach(another.id, { orderId: Z.id })).json.error, 'amount_mismatch');
    assert.equal((await attach(another.id, { orderId: Z.id, force: true })).json.error, 'note_required');
    assert.equal((await attach(another.id, { orderId: Z.id, force: true, note: '현금 일부' })).status, 200);
    assert.equal((await s.post(`/api/staff/orders/${Z.id}/paid`, { paid: false })).status, 200);
    assert.equal((await d.notices()).find((x) => x.id === another.id).status, 'pending');
    assert.equal((await attach(another.id, { orderId: X.id, force: true })).json.error, 'order_has_notice');
    // auto-confirmed order undone, identical text replayed later: not re-paid automatically
    const Q = await d.place(tk[2], '정재생', 'cola');
    const text = '입금 2,000원\n정재생';
    assert.equal((await d.notice(text)).status, 'matched');
    await s.post(`/api/staff/orders/${Q.id}/paid`, { paid: false });
    const raw5 = new DatabaseSync(path.join(d.srv.data, 'booth.db'));
    raw5.exec('PRAGMA busy_timeout=3000');
    raw5.prepare('UPDATE deposit_notices SET received_at=received_at-?1, last_at=COALESCE(last_at, received_at)-?1').run(11 * 60000);
    raw5.close();
    assert.equal((await d.notice(text)).status, 'pending');
    assert.equal((await d.order(Q.id)).paid, false);
  } finally { await d.srv.stop(); }
});

test('deposit test endpoint: real parser and matcher, stores and changes nothing', async () => {
  const d = await depositSetup();
  try {
    const { s, tk } = d;
    const o = await d.place(tk[0], '홍길동', 'tteokbokki', 2); // 18,000 would need 9,000 x2
    const o18 = await d.place(tk[1], '홍길동', 'odeng', 2); // 18,000
    void o;
    const sample = '입금 18,000원\n홍길동';
    const call = (body) => s.post('/api/staff/deposit-hook/test', body);
    const r = await call({ text: sample });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.parsed, { kind: 'deposit', amount: 18000, name: '홍길동', autoEligible: true, reasons: [] });
    assert.deepEqual([r.json.wouldMatch.status, r.json.wouldMatch.orderId, r.json.wouldMatch.reasons], ['matched', o18.id, []]);
    // nothing happened
    assert.equal((await d.order(o18.id)).paid, false);
    assert.deepEqual(await d.notices(), []);
    assert.deepEqual((await s.get('/api/staff/state')).json.deposit, { pending: 0, unparsed: 0, ignored: 0, review: 0, autoConfirm: true, autoConfirmMaxAmount: 30000 });
    // the real hook with the same text DOES pay it (and the preview afterwards reports the duplicate)
    assert.equal((await d.notice(sample)).status, 'matched');
    assert.equal((await d.order(o18.id)).paidBy, 'auto');
    const again = (await call({ text: sample })).json;
    assert.ok(again.wouldMatch.reasons.includes('duplicate'));
    assert.equal((await d.notices()).length, 1, 'previews never store');
    // other outcomes
    assert.equal((await call({ text: '신한 출금 5,000원' })).json.wouldMatch.status, 'ignored');
    assert.equal((await call({ text: '입금취소 5,000원 홍길동' })).json.wouldMatch.status, 'review');
    assert.deepEqual((await call({ text: '입금되었습니다' })).json.wouldMatch.status, 'unparsed');
    const ambiguous = (await call({ text: shinhanLike() })).json;
    assert.deepEqual([ambiguous.parsed.autoEligible, ambiguous.wouldMatch.status], [false, 'pending']);
    // guards
    assert.equal((await new Client(d.srv).post('/api/staff/deposit-hook/test', { text: sample })).status, 401);
    assert.equal((await raw(d.srv, 'POST', '/api/staff/deposit-hook/test', { 'content-type': 'application/json', cookie: s.cookieHeader(), origin: 'https://evil.example' }, JSON.stringify({ text: sample }))).status, 403);
    for (const bad of [{}, { text: 5 }, { text: 'x'.repeat(2049) }]) assert.equal((await call(bad)).json.error, 'bad_body', JSON.stringify(bad).slice(0, 30));
    assert.equal((await d.notices()).length, 1);
  } finally { await d.srv.stop(); }
  function shinhanLike() { return '[Web발신]\n신한 11/13 22:31\n입금 100\n잔액 123,456\n9000원김철'; }
});

test('deposit notices carry reason codes and obey the auto-confirm ceiling', async () => {
  const d = await depositSetup();
  try {
    const { s, tk } = d;
    const reasonsOf = async (r) => (await d.notices()).find((n) => n.id === r.id).reasons;
    // no candidate
    assert.deepEqual(await reasonsOf(await d.sms(2000, '아무개')), ['no_candidate']);
    // no depositor on the order / name mismatch / several candidates
    await d.place(tk[0], undefined, 'cola');
    assert.deepEqual(await reasonsOf(await d.sms(2000, '아무개')), ['no_depositor_on_order']);
    await d.place(tk[1], '김철수', 'fries');
    assert.deepEqual(await reasonsOf(await d.sms(6000, '박다른')), ['name_mismatch']);
    await d.place(tk[2], '김철수', 'fries');
    assert.deepEqual(await reasonsOf(await d.sms(6000, '김철수')), ['several_candidates']);
    // parse reasons are carried over; auto off; duplicate
    assert.deepEqual(await reasonsOf(await d.notice('입금 6,000원 김철수 박다른')), ['several_names', 'several_candidates']);
    await s.post('/api/staff/deposits/autoconfirm', { autoConfirm: false });
    const o = await d.place(tk[3], '최단독', 'odeng');
    assert.deepEqual(await reasonsOf(await d.sms(9000, '최단독')), ['auto_off']);
    await s.post('/api/staff/deposits/autoconfirm', { autoConfirm: true });
    const dupText = '입금 9,000원\n최단독';
    const first = await d.notice(dupText);
    assert.equal(first.status, 'matched');
    await s.post(`/api/staff/orders/${o.id}/paid`, { paid: false });
    const raw6 = new DatabaseSync(path.join(d.srv.data, 'booth.db'));
    raw6.exec('PRAGMA busy_timeout=3000');
    raw6.prepare('UPDATE deposit_notices SET received_at=received_at-?1, last_at=COALESCE(last_at, received_at)-?1').run(30 * 1000);
    raw6.close();
    const dup = await d.notice(dupText);
    // the undone notice is pending again, so the repeat collapses into it (repeatCount) and nothing is paid
    assert.equal(dup.id, first.id);
    assert.equal((await d.notices()).find((n) => n.id === first.id).repeatCount, 2);
    assert.equal((await d.order(o.id)).paid, false);
    // ceiling
    const base = { autoConfirm: true };
    for (const bad of [-1, 1000001, 1.5, '5000', null]) { const r = await s.post('/api/staff/deposits/autoconfirm', { ...base, autoConfirmMaxAmount: bad }); assert.equal(r.json.error, 'bad_auto_max', String(bad)); }
    assert.equal((await s.post('/api/staff/deposits/autoconfirm', {})).json.error, 'bad_auto_confirm');
    assert.equal((await new Client(d.srv).post('/api/staff/deposits/autoconfirm', { autoConfirmMaxAmount: 5 })).status, 401);
    assert.equal((await s.get('/api/staff/state')).json.deposit.autoConfirmMaxAmount, 30000, 'default ceiling');
    const huge = await d.place(tk[4], '최고액', 'tteokbokki', 15); // 120,000
    assert.deepEqual(await reasonsOf(await d.sms(120000, '최고액')), ['over_max_amount']);
    assert.equal((await d.order(huge.id)).paid, false);
    const set = await s.post('/api/staff/deposits/autoconfirm', { autoConfirmMaxAmount: 120000 });
    assert.deepEqual([set.json.autoConfirm, set.json.autoConfirmMaxAmount], [true, 120000]);
    assert.equal((await d.sms(120000, '최고액')).status, 'matched', 'exactly at the ceiling is allowed');
    assert.equal((await d.order(huge.id)).paidBy, 'auto');
    // 0 = never automatic; the maximum value is accepted
    assert.equal((await s.post('/api/staff/deposits/autoconfirm', { autoConfirmMaxAmount: 0 })).json.autoConfirmMaxAmount, 0);
    await d.place(tk[5], '이영영', 'cola');
    assert.ok((await reasonsOf(await d.sms(2000, '이영영'))).includes('over_max_amount'));
    assert.equal((await s.post('/api/staff/deposits/autoconfirm', { autoConfirmMaxAmount: 1000000 })).json.autoConfirmMaxAmount, 1000000);
    // the ignore-word reason
    const rv = await d.notice('입금취소 2,000원 이영영');
    assert.ok((await reasonsOf(rv)).includes('ignore_word'));
  } finally { await d.srv.stop(); }
});

// ======================= deposit notices: third review =======================
test('auto-confirm ships OFF: fresh databases, and existing ones are forced off once (then staff may switch it on)', async () => {
  const srv = await boot();
  let a; let b; let c;
  try {
    const s = await staffLogin(srv);
    assert.deepEqual((await s.get('/api/staff/state')).json.deposit, { pending: 0, unparsed: 0, ignored: 0, review: 0, autoConfirm: false, autoConfirmMaxAmount: 30000 });
    assert.equal((await s.get('/api/staff/deposits')).json.autoConfirm, false);
    // with it off a perfect notice stays pending (reason auto_off) and nothing is paid
    const T = (await tablesOf(s))[0].token;
    const o = (await order(new Client(srv), T, [{ id: 'tteokbokki', qty: 1 }], { depositor: '홍길동' })).json.order;
    const secret = (await s.get('/api/staff/deposit-hook')).json.secret;
    const r = JSON.parse((await hookPost(srv, secret, { text: '입금 8,000원\n홍길동' })).text);
    assert.equal(r.status, 'pending');
    assert.deepEqual((await s.get('/api/staff/deposits')).json.notices[0].reasons, ['auto_off']);
    assert.equal((await s.get('/api/staff/state')).json.orders.find((x) => x.id === o.id).paid, false);
    // staff switches it on: survives restarts
    assert.equal((await s.post('/api/staff/deposits/autoconfirm', { autoConfirm: true })).json.autoConfirm, true);
    await srv.stop({ keep: true });
    a = await boot({ dir: srv.dir });
    const sa = await staffLogin(a);
    assert.equal((await sa.get('/api/staff/state')).json.deposit.autoConfirm, true, 'a restart does not switch it off again');
    // an older database (released with auto-confirm ON, no migration flag yet): forced off exactly once
    await a.stop({ keep: true });
    const db = new DatabaseSync(path.join(srv.dir, 'data', 'booth.db'));
    db.exec('PRAGMA busy_timeout=3000');
    db.prepare("DELETE FROM settings WHERE k='auto_confirm_default_v2'").run();
    db.prepare("INSERT INTO settings(k,v) VALUES('deposit_auto_confirm','1') ON CONFLICT(k) DO UPDATE SET v='1'").run();
    db.prepare("INSERT INTO settings(k,v) VALUES('deposit_auto_max','80000') ON CONFLICT(k) DO UPDATE SET v='80000'").run();
    db.close();
    b = await boot({ dir: srv.dir });
    const sb = await staffLogin(b);
    const dep = (await sb.get('/api/staff/state')).json.deposit;
    assert.deepEqual([dep.autoConfirm, dep.autoConfirmMaxAmount], [false, 80000], 'forced off; an explicit ceiling chosen by staff is kept');
    await sb.post('/api/staff/deposits/autoconfirm', { autoConfirm: true });
    await b.stop({ keep: true });
    c = await boot({ dir: srv.dir });
    assert.equal((await (await staffLogin(c)).get('/api/staff/state')).json.deposit.autoConfirm, true, 'the migration runs only once');
  } finally { await srv.stop({ keep: true }); for (const x of [a, b]) if (x) await x.stop({ keep: true }); if (c) await c.stop(); else fs.rmSync(srv.dir, { recursive: true, force: true }); }
});

test('review blocker: a sender-typed 잔액 in the middle of a line cannot make a 1 won transfer pay a 16,000 won order', async () => {
  const d = await depositSetup();
  try {
    const o = await d.place(d.tk[0], '김철', 'tteokbokki', 2); // 16,000
    const attacks = ['[Web발신]\n신한 11/13 22:31 김철16000잔액 1원 입금', '[Web발신]\n신한 11/13 22:31 김철 16000 잔액 1원 입금', '입금 1원\u2028잔액 16000\n김철', '입금 2원\u2029잔액 16000\n김철'];
    for (const text of attacks) {
      const r = await d.notice(text);
      assert.equal(r.status, 'pending', JSON.stringify(text));
      assert.equal((await d.order(o.id)).paid, false, JSON.stringify(text));
      assert.ok((await d.notices()).find((n) => n.id === r.id).reasons.includes('multiple_amounts'));
    }
    // the same transfer after an undo cannot re-pay it either
    assert.equal((await d.s.post('/api/staff/deposit-hook/test', { text: attacks[0] })).json.parsed.autoEligible, false);
  } finally { await d.srv.stop(); }
});

test('deposit matching only considers the CURRENT seat of visible tables; manual assign is limited to orders staff can see', async () => {
  const d = await depositSetup();
  try {
    const { s, tk } = d;
    const old = await d.place(tk[4], '최하늘', 'odeng'); // 9,000, then the table is force-cleared: invisible to staff
    assert.equal((await s.post('/api/staff/tables/5/clear', { force: true })).status, 200);
    const n = await d.notice('입금 9,000원\n최하늘');
    assert.equal(n.status, 'pending');
    assert.deepEqual((await d.notices()).find((x) => x.id === n.id).reasons, ['no_candidate']);
    const real = await d.place(tk[4], '최하늘', 'odeng'); // the guest's current order at that table
    // a hand-paid order of the OLD seat is not a competitor either
    const handOld = await d.place(tk[5], '정옛날', 'fries'); await s.post(`/api/staff/orders/${handOld.id}/paid`, { paid: true });
    await s.post('/api/staff/tables/6/clear', { force: true });
    const cur = await d.place(tk[5], '정옛날', 'fries');
    assert.equal((await d.sms(6000, '정옛날')).status, 'matched', 'only the visible order counts');
    assert.equal((await d.order(cur.id)).paid, true);
    // manual assign / attach of an order that is not the current seat of a visible table: refused
    const other = await d.sms(9000, '아무개');
    assert.equal((await s.post(`/api/staff/deposits/${other.id}/assign`, { orderId: old.id, force: true })).status, 404);
    assert.equal((await s.post(`/api/staff/deposits/${other.id}/attach`, { orderId: handOld.id, force: true })).status, 404);
    assert.equal((await s.post(`/api/staff/deposits/${other.id}/assign`, { orderId: real.id })).status, 200, 'the visible order can be assigned');
    // hidden tables are out too
    const hid = await d.place(tk[7], '최숨김', 'cola');
    await s.post('/api/staff/tables/count', { count: 7, force: true });
    const nn = await d.sms(2000, '최숨김');
    assert.equal(nn.status, 'pending');
    assert.equal((await s.post(`/api/staff/deposits/${nn.id}/assign`, { orderId: hid.id })).status, 404);
  } finally { await d.srv.stop(); }
});

test('KakaoBank shape: 입출금통장 is a template word, not a withdrawal; the ceiling default is 30,000', async () => {
  const d = await depositSetup();
  try {
    const o = await d.place(d.tk[0], '홍길동', 'tteokbokki', 2);
    const r = await d.notice('입금 16,000원\n홍길동 → 내 입출금통장');
    assert.equal(r.status, 'matched');
    assert.equal((await d.order(o.id)).paidBy, 'auto');
    const big = await d.place(d.tk[1], '최고액', 'tteokbokki', 5); // 40,000 > 30,000
    const n = await d.notice('입금 40,000원\n최고액');
    assert.equal(n.status, 'pending');
    assert.deepEqual((await d.notices()).find((x) => x.id === n.id).reasons, ['over_max_amount']);
    assert.equal((await d.order(big.id)).paid, false);
  } finally { await d.srv.stop(); }
});

test('deposit hook: wrong-secret attempts have their own small budget; malformed requests with the right secret cost nothing', async () => {
  const statsFile = path.join(os.tmpdir(), `booth-stats-${process.pid}-${Date.now()}.json`);
  const d = await depositSetup({ BOOTH_TEST_STATS_FILE: statsFile });
  const stats = () => JSON.parse(fs.readFileSync(statsFile, 'utf8'));
  try {
    const { srv, secret } = d;
    // 30 concurrent wrong secrets: the server counts how many it delayed (an idle socket) and how many it answered at once; no wall-clock thresholds
    const res = await Promise.all(Array.from({ length: 30 }, async (_, i) => (await hookPost(srv, 'e'.repeat(63) + (i % 10), { text: 'x' })).status));
    assert.ok(res.every((st) => st === 404));
    assert.deepEqual(stats(), { badDelayed: 20, badImmediate: 10 }, 'at most 20 idle sockets, the rest answered at once');
    // after more than 20 bad attempts in a minute no more delays at all
    assert.equal((await hookPost(srv, 'f'.repeat(64), { text: 'x' })).status, 404);
    assert.deepEqual(stats(), { badDelayed: 20, badImmediate: 11 });
    // the real forwarder is unaffected, and malformed requests with the right secret do not use up its 60/min
    for (let i = 0; i < 70; i++) assert.equal((await hookPost(srv, secret, 'x', 'application/xml')).status, 415);
    for (let i = 0; i < 5; i++) assert.equal((await hookPost(srv, secret, { text: smsText(2000 + i, '이름', i + 1) })).status, 200);
    assert.equal((await d.s.get('/api/staff/state')).json.hookRateLimited, false);
    assert.deepEqual(stats(), { badDelayed: 20, badImmediate: 11 }, 'right-secret requests are not counted as bad attempts');
  } finally { await d.srv.stop(); fs.rmSync(statsFile, { force: true }); }
});

// =====================================================================================================
// Release 2 (addendum H): staff order tools, payments, refunds, write-offs, notice banner, stock, audit, day close
// =====================================================================================================
async function withBooth(fn, { env = {}, ...opts } = {}) {
  const srv = await boot({ env, ...opts });
  try {
    const s = await staffLogin(srv);
    const tk = (await tablesOf(s)).map((t) => t.token);
    return await fn({ srv, s, tk });
  } finally { await srv.stop(); }
}
const orderOf = async (s, id) => (await s.get('/api/staff/state')).json.orders.find((o) => o.id === id);
const staffOrder = (s, n, items, extra = {}) => s.post(`/api/staff/tables/${n}/orders`, { key: newKey(), items, ...extra });
const stTables = async (s) => (await s.get('/api/staff/state')).json.tables; // number, seat, unclearUntil, ...
async function csvOf(srv, s, p) { // fetch strips a BOM from text(), so read the bytes
  const res = await fetch(srv.origin + srv.base + p, { headers: { cookie: s.cookieHeader() } });
  const bytes = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, bom: bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, text: new TextDecoder().decode(bytes).replace(/^\uFEFF/, '') };
}
const dbOf = (srv) => new DatabaseSync(path.join(srv.data, 'booth.db'));
const auditOf = async (s, limit = 200) => (await s.get(`/api/staff/audit?limit=${limit}`)).json.entries;

test('H1 staff creates an order: no discount or coupon, allowed while ordering is closed, accept starts cooking, idempotent, hidden items need allowHidden', async () => {
  await withBooth(async ({ srv, s, tk }) => {
    assert.equal((await s.post('/api/staff/ordering', { open: false })).status, 200);
    const g = new Client(srv);
    assert.equal((await order(g, tk[0], [{ id: 'cola', qty: 1 }])).json.error, 'closed');
    const key = newKey();
    const r = await s.post('/api/staff/tables/1/orders', { key, items: [{ id: 'tteokbokki', qty: 2 }, { id: 'cola', qty: 1 }], note: '빨리', depositor: '김철수' });
    assert.equal(r.status, 201, r.text);
    assert.deepEqual([r.json.order.createdBy, r.json.order.status, r.json.order.total, r.json.order.memberDiscount, r.json.order.depositor, r.json.order.note], ['staff', 'pending', 18000, 0, '김철수', '빨리']);
    const again = await s.post('/api/staff/tables/1/orders', { key, items: [{ id: 'tteokbokki', qty: 2 }] });
    assert.equal(again.status, 200);
    assert.deepEqual([again.json.duplicate, again.json.order.id], [true, r.json.order.id], 'same key = same order, never a duplicate');
    const acc = await staffOrder(s, 1, [{ id: 'odeng', qty: 1 }], { accept: true });
    assert.equal(acc.json.order.status, 'cooking');
    assert.deepEqual((await s.get('/api/kitchen')).json.orders.map((o) => o.id), [acc.json.order.id]);
    assert.deepEqual((await g.get(`/api/t/${tk[0]}`)).json.orders.map((o) => o.createdBy).sort(), ['staff', 'staff']);
    // validation shares the guest rules
    assert.equal((await staffOrder(s, 1, [])).json.error, 'bad_items');
    assert.equal((await staffOrder(s, 1, [{ id: 'nope', qty: 1 }])).json.error, 'unknown_item');
    assert.equal((await staffOrder(s, 1, [{ id: 'cola', qty: 21 }])).json.error, 'bad_qty');
    assert.equal((await s.post('/api/staff/tables/1/orders', { key: 'x', items: [{ id: 'cola', qty: 1 }] })).json.error, 'bad_key');
    assert.equal((await s.post('/api/staff/tables/99/orders', { key: newKey(), items: [{ id: 'cola', qty: 1 }] })).status, 404);
    // no coupon on staff orders
    const cp = (await s.post('/api/staff/tables/1/coupons', { type: 'discount', amount: 1000, label: '직원 쿠폰' })).json.coupon;
    assert.equal((await staffOrder(s, 1, [{ id: 'cola', qty: 1 }], { couponCode: cp.code })).json.error, 'coupon_not_allowed');
    // sold-out visible items are refused; hidden items need allowHidden (and are not sold-out checked)
    await s.post('/api/staff/menu/cola/soldout', { soldOut: true });
    assert.equal((await staffOrder(s, 1, [{ id: 'cola', qty: 1 }])).json.error, 'sold_out');
    const hid = await mkItem(s, '비밀 메뉴', 3000);
    await s.post(`/api/staff/menu/items/${hid}`, { hidden: true });
    assert.equal((await staffOrder(s, 1, [{ id: hid, qty: 1 }])).json.error, 'unknown_item');
    const hr = await staffOrder(s, 1, [{ id: hid, qty: 1 }], { allowHidden: true });
    assert.equal(hr.status, 201, hr.text);
    assert.equal(hr.json.order.total, 3000);
  });
});

test('H1 staff may create up to twice the per-seat order cap; guests cannot', async () => {
  await withBooth(async ({ srv, s, tk }) => {
    const g = new Client(srv);
    for (let i = 0; i < 40; i++) assert.equal((await staffOrder(s, 2, [{ id: 'cola', qty: 1 }])).status, 201);
    assert.equal((await order(g, tk[1], [{ id: 'cola', qty: 1 }])).json.error, 'too_many_orders', 'guest cap is 40 per seat');
    for (let i = 0; i < 40; i++) assert.equal((await staffOrder(s, 2, [{ id: 'cola', qty: 1 }])).status, 201);
    assert.equal((await staffOrder(s, 2, [{ id: 'cola', qty: 1 }])).json.error, 'too_many_orders', 'staff cap is 80');
  });
});

test('H2 edit lines: original prices stay, new lines use today\'s price, qty 0 removes, at least one line, member rule is re-applied, coupon is capped', async () => {
  const fk = fake;
  await withBooth(async ({ srv, s, tk }) => {
    const g = new Client(srv); g.jar.token = fk.member(7001); g.jar.booth_d = await realDevice(srv);
    const o = (await order(g, tk[0], [{ id: 'tteokbokki', qty: 2 }, { id: 'cola', qty: 1 }])).json.order; // 18,000 -> member 10% = 1,800
    assert.deepEqual([o.subtotal, o.memberDiscount, o.total], [18000, 1800, 16200]);
    assert.deepEqual(o.memberRule, { mode: 'percent', pct: 10, amount: 1000, maxDiscount: 0, minOrder: 0 });
    // the menu price changes: existing lines keep the old unit price, the new line gets the current one
    const item = await mkItem(s, '신메뉴', 4000);
    await s.post('/api/staff/menu/items/tteokbokki', { price: 9000 });
    const e1 = await s.post(`/api/staff/orders/${o.id}/items`, { items: [{ id: 'tteokbokki', qty: 3 }, { id: 'cola', qty: 1 }, { id: item, qty: 1 }] });
    assert.equal(e1.status, 200, e1.text);
    assert.deepEqual(e1.json.order.items.map((i) => [i.id, i.qty, i.unitPrice]), [['tteokbokki', 3, 8000], ['cola', 1, 2000], [item, 1, 4000]]);
    assert.deepEqual([e1.json.order.subtotal, e1.json.order.memberDiscount, e1.json.order.total], [30000, 3000, 27000], 'member discount follows the rule stored on the order');
    // qty 0 removes a line, an order must keep one line
    const e2 = await s.post(`/api/staff/orders/${o.id}/items`, { items: [{ id: 'tteokbokki', qty: 0 }, { id: 'cola', qty: 0 }, { id: item, qty: 1 }] });
    assert.deepEqual(e2.json.order.items.map((i) => i.id), [item]);
    assert.equal(e2.json.order.total, 3600);
    assert.equal((await s.post(`/api/staff/orders/${o.id}/items`, { items: [{ id: item, qty: 0 }] })).json.error, 'no_lines');
    assert.equal((await s.post(`/api/staff/orders/${o.id}/items`, { items: [] })).json.error, 'no_lines', 'lines not listed are removed (replace semantics)');
    assert.equal((await s.post(`/api/staff/orders/${o.id}/items`, { items: [{ id: 'nope', qty: 1 }] })).json.error, 'unknown_item');
    assert.equal((await s.post(`/api/staff/orders/${o.id}/items`, { items: [{ id: item, qty: -1 }] })).json.error, 'bad_qty');
    assert.equal((await s.post(`/api/staff/orders/${o.id}/items`, { items: [{ id: item, qty: 1 }, { id: item, qty: 2 }] })).json.error, 'dup_item');
    assert.equal((await s.post(`/api/staff/orders/${o.id}/items`, { items: 'x' })).json.error, 'bad_items');
    assert.equal((await s.post('/api/staff/orders/99999/items', { items: [{ id: item, qty: 1 }] })).status, 404);
    // a coupon on the order is re-capped at what is left to pay
    const c = (await s.post('/api/staff/tables/2/coupons', { type: 'discount', amount: 5000, label: '5천원' })).json.coupon;
    const g2 = new Client(srv);
    const o2 = (await order(g2, tk[1], [{ id: 'fries', qty: 2 }], { couponCode: c.code })).json.order; // 12,000 - 5,000
    assert.deepEqual([o2.couponDiscount, o2.total], [5000, 7000]);
    const e3 = await s.post(`/api/staff/orders/${o2.id}/items`, { items: [{ id: 'fries', qty: 0 }, { id: 'cola', qty: 1 }] });
    assert.deepEqual([e3.json.order.subtotal, e3.json.order.couponDiscount, e3.json.order.total], [2000, 2000, 0], 'coupon = min(amount, remaining); total never below 0');
    // cancelled orders cannot be edited
    await s.post(`/api/staff/orders/${o2.id}/status`, { status: 'cancelled' });
    assert.equal((await s.post(`/api/staff/orders/${o2.id}/items`, { items: [{ id: 'cola', qty: 2 }] })).json.error, 'order_cancelled');
  }, { env: { COMS_ME_URL: fk.url + '/api/auth/me' } });
});

test('H2 editing a paid order: lower total makes a refund due, higher total makes it unpaid with a balance', async () => {
  await withBooth(async ({ s }) => {
    const o = (await staffOrder(s, 1, [{ id: 'tteokbokki', qty: 2 }])).json.order; // 16,000
    assert.equal((await s.post(`/api/staff/orders/${o.id}/paid`, { paid: true })).json.order.paidAmount, 16000);
    const lower = (await s.post(`/api/staff/orders/${o.id}/items`, { items: [{ id: 'tteokbokki', qty: 1 }] })).json.order; // 8,000
    assert.deepEqual([lower.paid, lower.total, lower.paidAmount, lower.overpaid, lower.refundDue, lower.balanceDue], [true, 8000, 16000, 8000, 8000, 0]);
    const st = (await s.get('/api/staff/state')).json;
    assert.deepEqual(st.refunds.map((r) => [r.orderId, r.amount, r.doneAt, r.reason]), [[o.id, 8000, null, 'edit_lower_total']]);
    const higher = (await s.post(`/api/staff/orders/${o.id}/items`, { items: [{ id: 'tteokbokki', qty: 3 }] })).json.order; // 24,000
    assert.deepEqual([higher.paid, higher.total, higher.paidAmount, higher.balanceDue, higher.refundDue, higher.overpaid], [false, 24000, 16000, 8000, 0, 0]);
    assert.deepEqual((await s.get('/api/staff/state')).json.refunds, [], 'the refund entry goes away when the order grows again');
    const back = (await s.post(`/api/staff/orders/${o.id}/paid`, { paid: true })).json.order; // pays the balance
    assert.deepEqual([back.paid, back.paidAmount, back.balanceDue], [true, 24000, 0]);
  });
});

test('H3 service lines cost nothing, show in the kitchen and in sales, and use stock', async () => {
  await withBooth(async ({ s }) => {
    const it = await mkItem(s, '서비스감', 3000);
    await s.post(`/api/staff/menu/items/${it}`, { stockLeft: 5 });
    const o = (await staffOrder(s, 1, [{ id: 'tteokbokki', qty: 1 }], { accept: true })).json.order;
    const r = await s.post(`/api/staff/orders/${o.id}/service`, { itemId: it, qty: 2 });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.order.items.find((i) => i.id === it), { id: it, name: '서비스감', qty: 2, unitPrice: 0, service: true });
    assert.deepEqual([r.json.order.subtotal, r.json.order.total], [8000, 8000]);
    assert.equal((await s.post(`/api/staff/orders/${o.id}/service`, { itemId: it, qty: 1 })).json.order.items.find((i) => i.id === it).qty, 3, 'same service line accumulates');
    assert.deepEqual((await s.get('/api/kitchen')).json.orders[0].items.find((i) => i.id === it).service, true);
    assert.equal((await s.get('/api/staff/state')).json.menu.items.find((i) => i.id === it).stockLeft, 2);
    const sale = (await s.get('/api/staff/sales')).json;
    assert.deepEqual(sale.byItem.find((i) => i.id === it), { id: it, name: '서비스감', qty: 0, serviceQty: 3, gross: 0 });
    assert.equal(sale.totals.billed, 8000);
    // validation
    assert.equal((await s.post(`/api/staff/orders/${o.id}/service`, { itemId: it, qty: 0 })).json.error, 'bad_qty');
    assert.equal((await s.post(`/api/staff/orders/${o.id}/service`, { itemId: 'nope', qty: 1 })).json.error, 'unknown_item');
    assert.equal((await s.post(`/api/staff/orders/${o.id}/service`, { itemId: it, qty: 3 })).json.error, 'insufficient_stock');
    // an edit keeps service lines unless they are listed
    const ed = (await s.post(`/api/staff/orders/${o.id}/items`, { items: [{ id: 'tteokbokki', qty: 2 }] })).json.order;
    assert.deepEqual(ed.items.map((i) => [i.id, i.qty, i.service]), [['tteokbokki', 2, false], [it, 3, true]]);
    await s.post(`/api/staff/orders/${o.id}/status`, { status: 'cancelled' });
    assert.equal((await s.get('/api/staff/state')).json.menu.items.find((i) => i.id === it).stockLeft, 5, 'cancelling gives the service stock back');
    assert.equal((await s.post(`/api/staff/orders/${o.id}/service`, { itemId: it, qty: 1 })).json.error, 'order_cancelled');
  });
});

test('H4 move one order to another table: coupon stays with its original seat, cancelled and same-table refused, guests see it at the new table', async () => {
  await withBooth(async ({ srv, s, tk }) => {
    const gA = new Client(srv); const gB = new Client(srv);
    const cp = (await s.post('/api/staff/tables/1/coupons', { type: 'discount', amount: 1000, label: '천원' })).json.coupon;
    const o = (await order(gA, tk[0], [{ id: 'tteokbokki', qty: 1 }], { couponCode: cp.code })).json.order;
    const keep = (await order(gA, tk[0], [{ id: 'cola', qty: 1 }])).json.order;
    const mv = await s.post(`/api/staff/orders/${o.id}/move`, { to: 3 });
    assert.equal(mv.status, 200, mv.text);
    assert.deepEqual([mv.json.order.table, mv.json.from, mv.json.order.couponCode], [3, 1, cp.code]);
    assert.deepEqual((await gB.get(`/api/t/${tk[2]}`)).json.orders.map((x) => x.id), [o.id]);
    assert.deepEqual((await gA.get(`/api/t/${tk[0]}`)).json.orders.map((x) => x.id), [keep.id], 'only the moved order left table 1');
    const db = dbOf(srv); assert.deepEqual({ ...db.prepare('SELECT table_id, order_id FROM coupons WHERE code=?').get(cp.code) }, { table_id: 1, order_id: o.id }, 'the coupon stays recorded for the seat that earned it and stays tied to the order'); db.close();
    assert.equal((await s.post(`/api/staff/orders/${o.id}/move`, { to: 3 })).json.error, 'same_table');
    assert.equal((await s.post(`/api/staff/orders/${o.id}/move`, { to: 99 })).status, 404);
    assert.equal((await s.post(`/api/staff/orders/${o.id}/move`, { to: 'x' })).json.error, 'bad_tables');
    await s.post(`/api/staff/orders/${keep.id}/status`, { status: 'cancelled' });
    assert.equal((await s.post(`/api/staff/orders/${keep.id}/move`, { to: 2 })).json.error, 'order_cancelled');
    // an order moved onto a table where the same idempotency key already exists does not collide
    const key = newKey();
    const a = (await gA.post(`/api/t/${tk[0]}/orders`, { key, items: [{ id: 'cola', qty: 1 }] })).json.order;
    const b = (await gB.post(`/api/t/${tk[2]}/orders`, { key, items: [{ id: 'cola', qty: 1 }] })).json.order;
    assert.equal((await s.post(`/api/staff/orders/${a.id}/move`, { to: 3 })).status, 200);
    assert.ok((await orderOf(s, b.id)) && (await orderOf(s, a.id)));
  });
});

test('H5 payments: method and amount are recorded, partial leaves a balance, overpayment owes a refund, a second paid:true is refused', async () => {
  await withBooth(async ({ s }) => {
    const o = (await staffOrder(s, 1, [{ id: 'tteokbokki', qty: 1 }])).json.order; // 8,000
    assert.equal((await s.post(`/api/staff/orders/${o.id}/paid`, { paid: true, method: 'bitcoin' })).json.error, 'bad_method');
    assert.equal((await s.post(`/api/staff/orders/${o.id}/paid`, { paid: true, amount: -1 })).json.error, 'bad_amount');
    assert.equal((await s.post(`/api/staff/orders/${o.id}/paid`, { paid: true, amount: 1.5 })).json.error, 'bad_amount');
    assert.equal((await s.post(`/api/staff/orders/${o.id}/paid`, { paid: 'yes' })).json.error, 'bad_paid');
    const part = (await s.post(`/api/staff/orders/${o.id}/paid`, { paid: true, method: 'cash', amount: 5000 })).json.order;
    assert.deepEqual([part.paid, part.paidAmount, part.paidMethod, part.balanceDue, part.paidBy], [false, 5000, 'cash', 3000, 'staff']);
    const rest = (await s.post(`/api/staff/orders/${o.id}/paid`, { paid: true, method: 'transfer' })).json.order; // default amount = balance
    assert.deepEqual([rest.paid, rest.paidAmount, rest.paidMethod, rest.balanceDue, typeof rest.paidAt], [true, 8000, 'transfer', 0, 'number']);
    const dup = await s.post(`/api/staff/orders/${o.id}/paid`, { paid: true });
    assert.equal(dup.status, 409); assert.equal(dup.json.error, 'stale', 'a second tap on another phone must not double-apply');
    assert.equal((await orderOf(s, o.id)).paidAmount, 8000);
    // overpayment
    const over = (await s.post(`/api/staff/orders/${o.id}/paid`, { paid: true, method: 'cash', amount: 2000 })).json.order;
    assert.deepEqual([over.paid, over.paidAmount, over.overpaid, over.refundDue], [true, 10000, 2000, 2000]);
    // undo clears every payment and the refund entry; the default method is transfer
    const un = (await s.post(`/api/staff/orders/${o.id}/paid`, { paid: false })).json.order;
    assert.deepEqual([un.paid, un.paidAmount, un.paidMethod, un.paidAt, un.refundDue, un.balanceDue], [false, 0, null, null, 0, 8000]);
    assert.deepEqual((await s.get('/api/staff/state')).json.refunds, []);
    const dflt = (await s.post(`/api/staff/orders/${o.id}/paid`, { paid: true })).json.order;
    assert.deepEqual([dflt.paidMethod, dflt.paidAmount], ['transfer', 8000]);
    // cancelled orders cannot be paid
    const c = (await staffOrder(s, 3, [{ id: 'cola', qty: 1 }])).json.order;
    await s.post(`/api/staff/orders/${c.id}/status`, { status: 'cancelled' });
    assert.equal((await s.post(`/api/staff/orders/${c.id}/paid`, { paid: true })).json.error, 'order_cancelled');
  });
});

test('H5 deposit assign: a forced mismatch needs a note (<= 60 chars); a partial deposit leaves a balance, an excess owes a refund', async () => {
  const d = await depositSetup();
  try {
    const { s, tk } = d;
    const o = await d.place(tk[0], '김철수', 'odeng'); // 9,000
    const under = await d.sms(5000, '김철수');
    assert.equal(under.status, 'pending');
    const asg = (nid, body) => s.post(`/api/staff/deposits/${nid}/assign`, body);
    assert.equal((await asg(under.id, { orderId: o.id, force: true })).json.error, 'note_required');
    assert.equal((await asg(under.id, { orderId: o.id, force: true, note: '   ' })).json.error, 'note_required');
    const ok = await asg(under.id, { orderId: o.id, force: true, note: '나머지는 현금' });
    assert.equal(ok.status, 200, ok.text);
    assert.deepEqual([ok.json.order.paid, ok.json.order.paidAmount, ok.json.order.balanceDue, ok.json.order.paidMethod], [false, 5000, 4000, 'transfer']);
    const more = await d.sms(6000, '김철수');
    const ok2 = await asg(more.id, { orderId: o.id, force: true, note: '잘못 많이 보냄' });
    assert.deepEqual([ok2.json.order.paid, ok2.json.order.paidAmount, ok2.json.order.overpaid, ok2.json.order.refundDue], [true, 11000, 2000, 2000]);
    // the audit log keeps the note, not the notice text
    const log = JSON.stringify(await auditOf(s));
    assert.ok(log.includes('나머지는 현금') && log.includes('deposit_assign'));
    assert.ok(!log.includes('Web발신'));
  } finally { await d.srv.stop(); }
});

test('H6 refunds: cancelling a paid order owes the money back; marking it done moves it from refund-due to refunded; revenue = received - refunded', async () => {
  await withBooth(async ({ s }) => {
    const a = (await staffOrder(s, 1, [{ id: 'tteokbokki', qty: 1 }])).json.order; // 8,000
    const b = (await staffOrder(s, 2, [{ id: 'odeng', qty: 1 }])).json.order; // 9,000
    await s.post(`/api/staff/orders/${a.id}/paid`, { paid: true, method: 'cash' });
    await s.post(`/api/staff/orders/${b.id}/paid`, { paid: true });
    let sale = (await s.get('/api/staff/sales')).json.totals;
    assert.deepEqual([sale.revenue, sale.refundDue, sale.refundsDone, sale.billed], [17000, 0, 0, 17000]);
    const cx = (await s.post(`/api/staff/orders/${a.id}/status`, { status: 'cancelled' })).json.order;
    assert.deepEqual([cx.status, cx.refundDue, cx.paidAmount, cx.balanceDue], ['cancelled', 8000, 8000, 0]);
    const refunds = (await s.get('/api/staff/state')).json.refunds;
    assert.deepEqual(refunds.map((r) => [r.orderId, r.amount, r.reason, r.doneAt, r.table]), [[a.id, 8000, 'cancelled', null, 1]]);
    sale = (await s.get('/api/staff/sales')).json.totals;
    assert.deepEqual([sale.revenue, sale.refundDue, sale.refundsDone, sale.billed, sale.orders], [17000, 8000, 0, 9000, 1], 'until the cash is handed back the money still counts as received');
    const done = await s.post(`/api/staff/refunds/${refunds[0].id}/done`, { method: 'cash', note: '현금 반환', amount: refunds[0].amount });
    assert.equal(done.status, 200, done.text);
    assert.deepEqual([done.json.refund.method, done.json.refund.note, typeof done.json.refund.doneAt], ['cash', '현금 반환', 'number']);
    sale = (await s.get('/api/staff/sales')).json.totals;
    assert.deepEqual([sale.revenue, sale.refundDue, sale.refundsDone], [9000, 0, 8000]);
    assert.equal((await orderOf(s, a.id)).refundDue, 0);
    assert.equal((await orderOf(s, a.id)).refundedAmount, 8000);
    assert.equal((await s.post(`/api/staff/refunds/${refunds[0].id}/done`, { amount: refunds[0].amount })).json.error, 'refund_done');
    assert.equal((await s.post('/api/staff/refunds/99999/done', { amount: 1 })).status, 404);
    assert.equal((await s.post(`/api/staff/refunds/${refunds[0].id}/done`, { method: 'gold', amount: refunds[0].amount })).json.error, 'bad_method');
    assert.equal((await s.post(`/api/staff/orders/${a.id}/paid`, { paid: false })).json.error, 'order_cancelled');
    // an overpayment on a live order: refund done, then undoing the payment is refused
    const over = (await staffOrder(s, 3, [{ id: 'cola', qty: 1 }])).json.order; // 2,000
    await s.post(`/api/staff/orders/${over.id}/paid`, { paid: true, amount: 5000, method: 'cash' });
    const r2 = (await s.get('/api/staff/state')).json.refunds.find((r) => r.orderId === over.id);
    assert.equal(r2.amount, 3000);
    await s.post(`/api/staff/refunds/${r2.id}/done`, { amount: r2.amount }); // default method cash
    assert.equal((await s.post(`/api/staff/orders/${over.id}/paid`, { paid: false })).json.error, 'has_refunds');
    const o2 = await orderOf(s, over.id);
    assert.deepEqual([o2.paid, o2.paidAmount, o2.refundedAmount, o2.refundDue, o2.overpaid], [true, 5000, 3000, 0, 0]);
    // editing the order UP after a refund must not count the refunded cash as still held
    const up = (await s.post(`/api/staff/orders/${over.id}/items`, { items: [{ id: 'cola', qty: 2 }] })).json.order; // 4,000, held 2,000
    assert.deepEqual([up.paid, up.balanceDue, up.total], [false, 2000, 4000]);
    sale = (await s.get('/api/staff/sales')).json.totals;
    assert.deepEqual([sale.paidAmount, sale.refundsDone, sale.revenue], [22000, 11000, 11000], 'revenue is Σ received - Σ refunded');
  });
});

test('H7 force-clear writes unpaid orders off (미수금): out of revenue, listed in sales and the CSV, gone from the list once paid; unclear removes the write-off', async () => {
  await withBooth(async ({ srv, s, tk }) => {
    const a = (await staffOrder(s, 1, [{ id: 'tteokbokki', qty: 1 }])).json.order; // 8,000 unpaid
    const b = (await staffOrder(s, 1, [{ id: 'odeng', qty: 1 }])).json.order; // 9,000, paid partly
    const c = (await staffOrder(s, 1, [{ id: 'cola', qty: 1 }])).json.order; // 2,000 paid
    await s.post(`/api/staff/orders/${b.id}/paid`, { paid: true, amount: 4000, method: 'cash' });
    await s.post(`/api/staff/orders/${c.id}/paid`, { paid: true });
    const refused = await s.post('/api/staff/tables/1/clear', {});
    assert.equal(refused.status, 409); assert.equal(refused.json.error, 'unsettled');
    assert.equal(refused.json.unpaidTotal, 13000, 'balance still owed: 8,000 + (9,000 - 4,000)');
    const r = await s.post('/api/staff/tables/1/clear', { force: true });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.writtenOff, { orders: 2, amount: 13000 });
    assert.equal(r.json.seat, 2);
    const sale = (await s.get('/api/staff/sales')).json;
    assert.deepEqual([sale.totals.writtenOff, sale.totals.revenue, sale.totals.unpaidRevenue], [13000, 6000, 0], 'revenue is only the money actually received (4,000 + 2,000)');
    assert.deepEqual(sale.writtenOff.map((w) => [w.orderId, w.table, w.total, w.paidAmount, w.balance]).sort((x, y) => x[0] - y[0]), [[a.id, 1, 8000, 0, 8000], [b.id, 1, 9000, 4000, 5000]]);
    const csv = await csvOf(srv, s, '/api/staff/sales.csv');
    assert.ok(csv.bom && csv.text.includes('[미수금]') && csv.text.includes('[환불]') && csv.text.includes(`${a.id},1,8000,0,8000`), csv.text);
    // an order cleared WITHOUT force (everything settled) writes nothing off
    const g = new Client(srv);
    const ok = (await order(g, tk[1], [{ id: 'cola', qty: 1 }])).json.order;
    await s.post(`/api/staff/orders/${ok.id}/paid`, { paid: true });
    await s.post(`/api/staff/orders/${ok.id}/status`, { status: 'served' });
    assert.deepEqual((await s.post('/api/staff/tables/2/clear', {})).json.writtenOff, { orders: 0, amount: 0 });
    // the cleared seat's old orders are no longer on the board; a late payment still works and leaves the 미수금 list
    assert.equal((await orderOf(s, a.id)), undefined);
    const late = await s.post(`/api/staff/orders/${a.id}/paid`, { paid: true, method: 'cash' });
    assert.equal(late.status, 200, late.text);
    const sale2 = (await s.get('/api/staff/sales')).json;
    assert.deepEqual([sale2.totals.writtenOff, sale2.totals.revenue], [5000, 16000], 'received: 4,000 + 2,000 + 2,000 + the late 8,000');
    assert.deepEqual(sale2.writtenOff.map((w) => w.orderId), [b.id]);
  });
});

test('H8 unclear: only while the new seat is completely empty and within 10 minutes', async () => {
  await withBooth(async ({ srv, s, tk }) => {
    const g = new Client(srv);
    assert.equal((await s.post('/api/staff/tables/1/unclear', {})).json.reason, 'no_clear', 'nothing to undo');
    const o = (await order(g, tk[0], [{ id: 'cola', qty: 1 }])).json.order;
    await s.post(`/api/staff/orders/${o.id}/paid`, { paid: true });
    await s.post(`/api/staff/orders/${o.id}/status`, { status: 'served' });
    assert.equal((await stTables(s))[0].unclearUntil, null);
    assert.equal((await s.post('/api/staff/tables/1/clear', {})).json.seat, 2);
    const until = (await stTables(s))[0].unclearUntil;
    assert.ok(until > Date.now() && until <= Date.now() + 10 * 60000, 'staff are told how long the undo is possible');
    assert.equal((await g.get(`/api/t/${tk[0]}`)).json.orders.length, 0);
    const un = await s.post('/api/staff/tables/1/unclear', {});
    assert.equal(un.status, 200, un.text);
    assert.deepEqual([un.json.seat, un.json.table], [1, 1]);
    assert.deepEqual((await g.get(`/api/t/${tk[0]}`)).json.orders.map((x) => x.id), [o.id], 'the old seat (orders, coupons) is back');
    assert.equal((await stTables(s))[0].unclearUntil, null);
    // new guests already used the new seat -> refused with the reason
    await s.post('/api/staff/tables/1/clear', {});
    const o2 = (await order(new Client(srv), tk[0], [{ id: 'cola', qty: 1 }])).json.order;
    const used = await s.post('/api/staff/tables/1/unclear', {});
    assert.deepEqual([used.status, used.json.error, used.json.reason, used.json.used], [409, 'cannot_undo', 'seat_in_use', { orders: 1 }]);
    assert.equal((await orderOf(s, o2.id)).seat, 2);
    // too old
    const db = dbOf(srv);
    await s.post('/api/staff/tables/3/clear', {});
    db.prepare('UPDATE table_clears SET at=at-? WHERE table_id=3').run(11 * 60000);
    db.close();
    const old = await s.post('/api/staff/tables/3/unclear', {});
    assert.deepEqual([old.status, old.json.error, old.json.reason], [409, 'cannot_undo', 'too_old']);
    // a table move after the clear
    await s.post('/api/staff/tables/4/clear', {});
    await s.post('/api/staff/tables/move', { from: 4, to: 5 });
    assert.equal((await s.post('/api/staff/tables/4/unclear', {})).json.reason, 'seat_changed');
  });
});

test('H8 unclear restores written-off orders as unpaid again', async () => {
  await withBooth(async ({ s }) => {
    const a = (await staffOrder(s, 1, [{ id: 'cola', qty: 1 }])).json.order;
    assert.equal((await s.post('/api/staff/tables/1/clear', { force: true })).json.writtenOff.orders, 1);
    assert.equal((await s.get('/api/staff/sales')).json.totals.writtenOff, 2000);
    assert.equal((await s.post('/api/staff/tables/1/unclear', {})).status, 200);
    assert.equal((await s.get('/api/staff/sales')).json.totals.writtenOff, 0);
    const back = await orderOf(s, a.id);
    assert.deepEqual([back.writtenOff, back.balanceDue, back.paid], [false, 2000, false]);
    assert.equal((await s.get('/api/staff/sales')).json.totals.unpaidRevenue, 2000);
  });
});

test('H9 notice banner: shown in guest, wait and board state, validated, cleared by reset', async () => {
  await withBooth(async ({ srv, s, tk }) => {
    const g = new Client(srv);
    const guestN = async () => (await g.get(`/api/t/${tk[0]}`)).json.notice;
    assert.equal(await guestN(), null);
    const set = await s.post('/api/staff/notice', { text: '  주문이 밀려 20분 걸려요  ', level: 'warn' });
    assert.equal(set.status, 200, set.text);
    assert.deepEqual(set.json.notice, { text: '주문이 밀려 20분 걸려요', level: 'warn' });
    assert.deepEqual(await guestN(), { text: '주문이 밀려 20분 걸려요', level: 'warn' });
    assert.deepEqual((await g.get('/api/wait/info')).json.notice, { text: '주문이 밀려 20분 걸려요', level: 'warn' });
    assert.deepEqual((await g.get('/api/board')).json.notice, { text: '주문이 밀려 20분 걸려요', level: 'warn' });
    assert.deepEqual((await s.get('/api/staff/state')).json.notice, { text: '주문이 밀려 20분 걸려요', level: 'warn' });
    const w = (await g.post('/api/wait', { nick: '대기', size: 2 })).json;
    assert.deepEqual((await g.get(`/api/wait/${w.id}?secret=${w.secret}`)).json.notice, { text: '주문이 밀려 20분 걸려요', level: 'warn' });
    assert.deepEqual((await s.post('/api/staff/notice', { text: '곧 마감' })).json.notice, { text: '곧 마감', level: 'info' }, 'level defaults to info');
    assert.equal((await s.post('/api/staff/notice', { text: 'x'.repeat(81) })).json.error, 'bad_text');
    assert.equal((await s.post('/api/staff/notice', { text: 'ok', level: 'red' })).json.error, 'bad_level');
    assert.equal((await s.post('/api/staff/notice', { text: 42 })).json.error, 'bad_text');
    assert.equal((await s.post('/api/staff/notice', { text: 'x'.repeat(80) })).status, 200, '80 characters are fine');
    assert.equal((await new Client(srv).post('/api/staff/notice', { text: 'hack' })).status, 401);
    assert.deepEqual((await s.post('/api/staff/notice', { text: '' })).json.notice, null, 'empty text clears');
    assert.equal(await guestN(), null);
    await s.post('/api/staff/notice', { text: '다시' });
    assert.equal((await s.post('/api/staff/reset', { confirm: '초기화' })).status, 200);
    assert.equal(await guestN(), null, 'reset clears the banner');
  });
});

test('H10 stock counters: decrement in the order transaction, insufficient_stock, automatic sold-out at 0, restore on cancel/reduce, guests see small counts', async () => {
  await withBooth(async ({ srv, s, tk }) => {
    const it = await mkItem(s, '한정 안주', 5000);
    const setStock = (v) => s.post(`/api/staff/menu/items/${it}`, { stockLeft: v });
    assert.equal((await setStock(-1)).json.error, 'bad_stock_left');
    assert.equal((await setStock(10000)).json.error, 'bad_stock_left');
    assert.equal((await setStock(1.5)).json.error, 'bad_stock_left');
    assert.equal((await setStock('3')).json.error, 'bad_stock_left');
    assert.equal((await setStock(10)).json.item.stockLeft, 10);
    const guestItem = async () => (await new Client(srv).get(`/api/t/${tk[0]}`)).json.menu.items.find((i) => i.id === it);
    assert.equal((await guestItem()).stockLeft, null, 'guests only see the count once it is 5 or less');
    const g = new Client(srv);
    const o1 = (await order(g, tk[0], [{ id: it, qty: 6 }])).json.order;
    assert.equal((await guestItem()).stockLeft, 4);
    const st = async () => (await s.get('/api/staff/state')).json.menu.items.find((i) => i.id === it);
    assert.deepEqual([(await st()).stockLeft, (await st()).soldOut], [4, false]);
    const short = await order(g, tk[0], [{ id: it, qty: 5 }]);
    assert.equal(short.status, 409);
    assert.deepEqual([short.json.error, short.json.id, short.json.left], ['insufficient_stock', it, 4]);
    assert.equal((await st()).stockLeft, 4, 'a refused order takes nothing');
    const o2 = (await order(g, tk[0], [{ id: it, qty: 4 }])).json.order;
    assert.deepEqual([(await st()).stockLeft, (await st()).soldOut, (await st()).stockAuto], [0, true, true], 'automatic sold-out at 0');
    assert.equal((await order(g, tk[0], [{ id: it, qty: 1 }])).json.error, 'sold_out');
    assert.equal((await guestItem()).soldOut, true);
    // cancelling restores the stock and lifts the AUTOMATIC sold-out
    await s.post(`/api/staff/orders/${o2.id}/status`, { status: 'cancelled' });
    assert.deepEqual([(await st()).stockLeft, (await st()).soldOut, (await st()).stockAuto], [4, false, false]);
    // reducing a line restores the difference
    await s.post(`/api/staff/orders/${o1.id}/items`, { items: [{ id: it, qty: 2 }] });
    assert.equal((await st()).stockLeft, 8);
    await s.post(`/api/staff/orders/${o1.id}/items`, { items: [{ id: it, qty: 4 }] });
    assert.equal((await st()).stockLeft, 6);
    assert.equal((await s.post(`/api/staff/orders/${o1.id}/items`, { items: [{ id: it, qty: 21 }] })).json.error, 'bad_qty');
    assert.equal((await s.post(`/api/staff/orders/${o1.id}/items`, { items: [{ id: it, qty: 11 }] })).json.error, 'insufficient_stock');
    assert.equal((await st()).stockLeft, 6);
    // a MANUAL sold-out is never lifted by stock changes
    await s.post(`/api/staff/menu/${it}/soldout`, { soldOut: true });
    await s.post(`/api/staff/orders/${o1.id}/status`, { status: 'cancelled' });
    assert.deepEqual([(await st()).stockLeft, (await st()).soldOut, (await st()).stockAuto], [10, true, false]);
    await setStock(null);
    assert.deepEqual([(await st()).stockLeft, (await st()).soldOut], [null, true], 'clearing the limit keeps a manual sold-out');
    // setting 0 by hand = automatic sold-out; raising it lifts it again
    await s.post(`/api/staff/menu/${it}/soldout`, { soldOut: false });
    await setStock(0);
    assert.deepEqual([(await st()).soldOut, (await st()).stockAuto], [true, true]);
    await setStock(3);
    assert.deepEqual([(await st()).soldOut, (await st()).stockLeft], [false, 3]);
    // created with a stock
    const nid = (await s.post('/api/staff/menu/items', { name: '재고품', price: 1000, category: '테스트', stockLeft: 2 })).json.item;
    assert.equal(nid.stockLeft, 2);
    // two guests race for the last pieces: stock never goes negative
    await setStock(3);
    const res = await Promise.all(Array.from({ length: 6 }, (_, i) => order(new Client(srv), tk[2 + (i % 4)], [{ id: it, qty: 1 }])));
    assert.equal(res.filter((r) => r.status === 201).length, 3);
    assert.equal((await st()).stockLeft, 0);
  });
});

test('H11 manual coupons: discount or item, at most 20 per hour, void blocks use, used coupons cannot be voided', async () => {
  await withBooth(async ({ srv, s, tk }) => {
    const mk = (n, body) => s.post(`/api/staff/tables/${n}/coupons`, body);
    assert.equal((await mk(1, { type: 'gift', label: 'x' })).json.error, 'bad_type');
    assert.equal((await mk(1, { type: 'discount', label: 'x' })).json.error, 'bad_amount');
    assert.equal((await mk(1, { type: 'discount', amount: 150, label: 'x' })).json.error, 'bad_amount');
    assert.equal((await mk(1, { type: 'discount', amount: 1000, label: '' })).json.error, 'bad_label');
    assert.equal((await mk(99, { type: 'item', label: '서비스' })).status, 404);
    const item = (await mk(1, { type: 'item', label: '서비스 음료' })).json.coupon;
    assert.deepEqual([item.type, item.label, item.source, item.table, item.amount], ['item', '서비스 음료', 'staff', 1, null]);
    const disc = (await mk(1, { type: 'discount', amount: 2000, label: '직원 할인' })).json.coupon;
    assert.match(disc.code, /^[A-Z0-9]{6}$/, 'same code format as reward coupons');
    const g = new Client(srv);
    assert.deepEqual((await g.get(`/api/t/${tk[0]}`)).json.coupons.map((c) => c.code).sort(), [disc.code, item.code].sort(), 'guests see manual coupons');
    // the discount works on an order; the item coupon is redeemed by staff
    const o = (await order(g, tk[0], [{ id: 'tteokbokki', qty: 1 }], { couponCode: disc.code })).json.order;
    assert.equal(o.total, 6000);
    assert.equal((await s.post(`/api/staff/coupons/${disc.code}/void`, {})).json.error, 'coupon_used');
    assert.equal((await s.post(`/api/staff/coupons/${item.code}/void`, {})).status, 200);
    assert.equal((await s.post(`/api/staff/coupons/${item.code}/void`, {})).json.error, 'coupon_void');
    assert.equal((await s.post('/api/staff/coupons/ZZZZZZ/void', {})).status, 404);
    assert.equal((await s.post('/api/staff/coupons/redeem', { code: item.code })).json.error, 'coupon_void');
    assert.ok(!(await g.get(`/api/t/${tk[0]}`)).json.coupons.some((c) => c.code === item.code), 'voided coupons disappear for guests');
    const d2 = (await mk(2, { type: 'discount', amount: 1000, label: '무효 예정' })).json.coupon;
    await s.post(`/api/staff/coupons/${d2.code}/void`, {});
    assert.equal((await order(new Client(srv), tk[1], [{ id: 'tteokbokki', qty: 1 }], { couponCode: d2.code })).json.error, 'coupon_void');
    // 20 per hour (the three above count)
    let made = 3;
    for (; made < 20; made++) assert.equal((await mk(3, { type: 'item', label: `쿠폰${made}` })).status, 200);
    const over = await mk(3, { type: 'item', label: '넘침' });
    assert.deepEqual([over.status, over.json.error], [409, 'manual_coupon_limit']);
    // the hour window: older coupons stop counting
    const db = dbOf(srv);
    db.prepare("UPDATE coupons SET created_at=created_at-? WHERE source='staff'").run(61 * 60000);
    db.close();
    assert.equal((await mk(3, { type: 'item', label: '다시 가능' })).status, 200);
  });
});

test('H12 wait no-show: called parties become no-show after the timeout (setting), staff may recall once', async () => {
  await withBooth(async ({ srv, s }) => {
    const st0 = (await s.get('/api/staff/state')).json;
    assert.equal(st0.waitCallTimeoutMin, 5, 'default 5 minutes');
    assert.equal((await s.post('/api/staff/waitlist/timeout', { minutes: 0 })).json.error, 'bad_minutes');
    assert.equal((await s.post('/api/staff/waitlist/timeout', { minutes: 31 })).json.error, 'bad_minutes');
    assert.equal((await s.post('/api/staff/waitlist/timeout', { minutes: 2.5 })).json.error, 'bad_minutes');
    assert.equal((await new Client(srv).post('/api/staff/waitlist/timeout', { minutes: 3 })).status, 401);
    assert.equal((await s.post('/api/staff/waitlist/timeout', { minutes: 3 })).json.minutes, 3);
    assert.equal((await s.get('/api/staff/state')).json.waitCallTimeoutMin, 3);
    const g = new Client(srv);
    const w = (await g.post('/api/wait', { nick: '손님', size: 2 })).json;
    const wid = w.id;
    assert.equal((await s.post(`/api/staff/wait/${wid}/recall`, {})).json.error, 'not_noshow');
    assert.equal((await s.post(`/api/staff/wait/${wid}/call`, {})).status, 200);
    const status = async () => (await g.get(`/api/wait/${wid}?secret=${w.secret}`)).json.status;
    assert.equal(await status(), 'called');
    const db = dbOf(srv);
    db.prepare('UPDATE waitlist SET called_at=called_at-? WHERE id=?').run(2 * 60000, wid);
    assert.equal(await status(), 'called', 'still inside the 3 minutes');
    db.prepare('UPDATE waitlist SET called_at=called_at-? WHERE id=?').run(2 * 60000, wid);
    assert.equal(await status(), 'noshow', 'lazily evaluated on read');
    assert.equal((await s.get('/api/staff/state')).json.waitlist.find((x) => x.id === wid).status, 'noshow');
    assert.equal((await s.post(`/api/staff/wait/${wid}/call`, {})).json.error, 'wait_noshow');
    const rc = await s.post(`/api/staff/wait/${wid}/recall`, {});
    assert.equal(rc.status, 200, rc.text);
    assert.equal(await status(), 'called');
    assert.equal((await s.get('/api/staff/state')).json.waitlist.find((x) => x.id === wid).recalled, true);
    db.prepare('UPDATE waitlist SET called_at=called_at-? WHERE id=?').run(10 * 60000, wid);
    assert.equal(await status(), 'noshow');
    assert.equal((await s.post(`/api/staff/wait/${wid}/recall`, {})).json.error, 'already_recalled', 'only once');
    // a no-show can be cancelled by the guest or by staff, and is not counted in the queue
    assert.equal((await g.get('/api/wait/info')).json.waitingTotal, 0);
    assert.equal((await s.post(`/api/staff/wait/${wid}/cancel`, {})).status, 200);
    assert.equal(await status(), 'cancelled');
    // seating a called party before the timeout is unaffected
    const w2 = (await g.post('/api/wait', { nick: '둘째', size: 1 })).json;
    await s.post(`/api/staff/wait/${w2.id}/call`, {});
    assert.equal((await s.post(`/api/staff/wait/${w2.id}/seat`, {})).status, 200);
    db.prepare('UPDATE waitlist SET called_at=called_at-? WHERE id=?').run(60 * 60000, w2.id);
    assert.equal((await g.get(`/api/wait/${w2.id}?secret=${w2.secret}`)).json.status, 'seated');
    db.close();
  });
});

test('H12 the no-show timeout default comes from WAIT_CALL_TIMEOUT_MIN (1..30, anything else refuses to start)', async () => {
  await withBooth(async ({ s }) => assert.equal((await s.get('/api/staff/state')).json.waitCallTimeoutMin, 9), { env: { WAIT_CALL_TIMEOUT_MIN: '9' } });
  await assert.rejects(boot({ env: { WAIT_CALL_TIMEOUT_MIN: '999' } }), /WAIT_CALL_TIMEOUT_MIN must be an integer between 1 and 30/);
});

test('H12 a timer marks no-shows without anyone reading the queue', async () => {
  // the server sweeps every 30 s; here the sweep is proven through the staff snapshot on the SSE-free path
  await withBooth(async ({ srv, s }) => {
    const g = new Client(srv);
    const w = (await g.post('/api/wait', { nick: '손님', size: 1 })).json;
    await s.post(`/api/staff/wait/${w.id}/call`, {});
    const db = dbOf(srv);
    db.prepare('UPDATE waitlist SET called_at=called_at-? WHERE id=?').run(6 * 60000, w.id);
    db.close();
    assert.equal((await s.get('/api/staff/state')).json.waitlist[0].status, 'noshow');
  });
});

test('H13 audit log: money and setting changes are recorded without PINs, tokens, secrets or account numbers; pagination; login and lockout recorded', async () => {
  const d = await depositSetup({ LOCKOUT_MS: '60000', PAY_BANK: '신한', PAY_ACCOUNT: '110-123-456789', PAY_HOLDER: '동아리' });
  try {
    const { srv, s, tk, secret } = d;
    const o = (await staffOrder(s, 1, [{ id: 'tteokbokki', qty: 2 }])).json.order;
    await s.post(`/api/staff/orders/${o.id}/paid`, { paid: true, method: 'cash', amount: 10000 });
    await s.post(`/api/staff/orders/${o.id}/paid`, { paid: false });
    await s.post(`/api/staff/orders/${o.id}/items`, { items: [{ id: 'tteokbokki', qty: 1 }] });
    await s.post(`/api/staff/orders/${o.id}/service`, { itemId: 'cola', qty: 1 });
    await s.post(`/api/staff/orders/${o.id}/move`, { to: 2 });
    const cx = (await staffOrder(s, 3, [{ id: 'cola', qty: 1 }])).json.order;
    await s.post(`/api/staff/orders/${cx.id}/paid`, { paid: true });
    await s.post(`/api/staff/orders/${cx.id}/status`, { status: 'cancelled' });
    const rf = (await s.get('/api/staff/state')).json.refunds[0];
    await s.post(`/api/staff/refunds/${rf.id}/done`, { method: 'cash', amount: rf.amount });
    const cp = (await s.post('/api/staff/tables/1/coupons', { type: 'item', label: '서비스' })).json.coupon;
    await s.post(`/api/staff/coupons/${cp.code}/void`, {});
    const cp2 = (await s.post('/api/staff/tables/1/coupons', { type: 'item', label: '서비스2' })).json.coupon;
    await s.post('/api/staff/coupons/redeem', { code: cp2.code });
    await s.post('/api/staff/menu/cola/soldout', { soldOut: true });
    await s.post('/api/staff/menu/items/cola', { price: 2500 });
    await s.post('/api/staff/menu/items/cola/photo/delete', {});
    await s.post('/api/staff/rewards/drink', { stock: 5 });
    await s.post('/api/staff/hourly-reward', { enabled: false });
    await s.post('/api/staff/member-discount', { pct: 20 });
    await s.post('/api/staff/pay', { holder: '새예금주', confirmAccount: '110-123-456789' });
    await s.post('/api/staff/ordering', { open: false });
    await s.post('/api/staff/tables/count', { count: 30 });
    await s.post('/api/staff/tables/5/rotate', {});
    await s.post('/api/staff/deposit-hook/rotate', {});
    const sms = JSON.parse((await hookPost(srv, (await s.get('/api/staff/deposit-hook')).json.secret, { text: smsText(5000, '아무개', 777) })).text);
    await s.post(`/api/staff/deposits/${sms.id}/dismiss`, {});
    await s.post('/api/staff/tables/6/clear', {});
    await s.post('/api/staff/tables/move', { from: 7, to: 8 });
    await s.post('/api/staff/notice', { text: '공지' });
    // wrong PINs -> lockout, correct login
    const bad = new Client(srv);
    for (let i = 0; i < 5; i++) await bad.post('/api/staff/login', { pin: '000000' });
    const entries = await auditOf(s);
    const actions = new Set(entries.map((e) => e.action));
    for (const a of ['order_create_staff', 'order_paid', 'order_unpaid', 'order_edit', 'order_service', 'order_move', 'order_cancel', 'refund_done', 'coupon_manual', 'coupon_void', 'coupon_redeem',
      'menu_update', 'pay_settings', 'member_discount', 'table_clear', 'table_move', 'notice', 'deposit_dismiss', 'login', 'lockout', 'staff_action']) assert.ok(actions.has(a), `missing audit action ${a}: ${[...actions].join(',')}`);
    const staffActions = entries.filter((e) => e.action === 'staff_action').map((e) => e.target);
    for (const a of ['ordering', 'table_count', 'table_rotate', 'deposit_secret_rotate', 'member_discount', 'notice']) assert.ok(actions.has(a), `store-level audit ${a}`);
    for (const t of ['/api/staff/menu/cola/soldout', '/api/staff/hourly-reward', '/api/staff/rewards/drink', '/api/staff/menu/items/cola/photo/delete']) {
      assert.ok(staffActions.includes(t), `generic audit row for ${t}: ${staffActions.join(' | ')}`);
    }
    // newest first, ids strictly decreasing, no PIN / token / secret / account number anywhere
    assert.ok(entries.every((e, i) => i === 0 || e.id < entries[i - 1].id));
    const text = JSON.stringify(entries);
    const pay = (await s.get('/api/staff/state')).json.pay;
    for (const secretText of [PIN, '000000', secret, (await s.get('/api/staff/deposit-hook')).json.secret, ...tk.slice(0, 3), pay.account, 'Web발신']) assert.ok(secretText && !text.includes(secretText), `audit leaks ${String(secretText).slice(0, 4)}…`);
    assert.ok(text.includes('cash 10000'), 'amounts and methods are recorded');
    // pagination
    const p1 = (await s.get('/api/staff/audit?limit=5')).json;
    assert.equal(p1.entries.length, 5);
    assert.equal(p1.next, p1.entries[4].id);
    const p2 = (await s.get(`/api/staff/audit?limit=5&before=${p1.next}`)).json;
    assert.ok(p2.entries.every((e) => e.id < p1.next) && p2.entries.length === 5);
    assert.equal((await s.get('/api/staff/audit?limit=1000')).json.entries.length <= 200, true, 'limit is capped');
    assert.equal((await new Client(srv).get('/api/staff/audit')).status, 401);
    assert.ok(entries[0].at <= Date.now() && entries[0].summary !== undefined && entries[0].target !== undefined);
  } finally { await d.srv.stop(); }
});

test('H13 the audit log keeps only the newest 5000 rows and survives reset', async () => {
  await withBooth(async ({ srv, s }) => {
    const db = dbOf(srv);
    const ins = db.prepare("INSERT INTO audit_log(at, action, target, summary) VALUES(1, 'x', 'y', 'z')");
    db.exec('BEGIN'); for (let i = 0; i < 5100; i++) ins.run(); db.exec('COMMIT');
    db.close();
    await s.post('/api/staff/notice', { text: '한 줄' }); // any audited write trims
    const db2 = dbOf(srv);
    assert.equal(db2.prepare('SELECT COUNT(*) n FROM audit_log').get().n, 5000);
    db2.close();
    await s.post('/api/staff/reset', { confirm: '초기화' });
    const db3 = dbOf(srv);
    assert.ok(db3.prepare('SELECT COUNT(*) n FROM audit_log').get().n >= 5000, 'reset does not erase the audit log');
    assert.ok(db3.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='reset'").get().n >= 1);
    db3.close();
  });
});

test('H14 day close: needs the confirm word, freezes a report, wipes the day, keeps menu / rewards / settings / tokens / audit; reset makes no report', async () => {
  await withBooth(async ({ srv, s, tk }) => {
    const g = new Client(srv);
    const a = (await order(g, tk[0], [{ id: 'tteokbokki', qty: 2 }])).json.order; // 16,000
    await s.post(`/api/staff/orders/${a.id}/paid`, { paid: true, method: 'cash' });
    const b = (await staffOrder(s, 2, [{ id: 'odeng', qty: 1 }])).json.order; // 9,000, 3,000 received
    await s.post(`/api/staff/orders/${b.id}/paid`, { paid: true, amount: 3000, method: 'cash' });
    const c = (await staffOrder(s, 3, [{ id: 'cola', qty: 1 }])).json.order;
    await s.post(`/api/staff/orders/${c.id}/paid`, { paid: true });
    await s.post(`/api/staff/orders/${c.id}/status`, { status: 'cancelled' }); // refund due 2,000
    await s.post('/api/staff/tables/2/clear', { force: true }); // writes off b's 6,000 balance
    await s.post('/api/staff/notice', { text: '공지' });
    await s.post('/api/staff/menu/cola/soldout', { soldOut: true });
    await s.post('/api/staff/pay', { holder: '마감예금주', confirmAccount: (await s.get('/api/staff/state')).json.pay.account });
    const before = (await s.get('/api/staff/sales')).json;
    const tokensBefore = tk.slice();
    assert.equal((await s.post('/api/staff/day/close', {})).status, 400);
    assert.equal((await s.post('/api/staff/day/close', { confirm: '초기화' })).status, 400, 'reset word does not close the day');
    assert.equal((await new Client(srv).post('/api/staff/day/close', { confirm: '마감' })).status, 401);
    assert.deepEqual((await s.get('/api/staff/day/reports')).json.reports, []);
    const refused = await s.post('/api/staff/day/close', { confirm: '마감' });
    assert.deepEqual([refused.status, refused.json.error], [409, 'open_items']);
    assert.equal((await s.get('/api/staff/day/reports')).json.reports.length, 0, 'nothing happened');
    assert.equal((await orderOf(s, a.id)).id, a.id, 'nothing was wiped');
    const r = await s.post('/api/staff/day/close', { confirm: '마감', force: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.report.id, 1);
    assert.match(r.json.report.label, /^\d{4}-\d\d-\d\d$/);
    assert.deepEqual([r.json.report.totals.revenue, r.json.report.totals.refundDue, r.json.report.totals.writtenOff], [before.totals.revenue, 2000, 6000]);
    assert.deepEqual([before.totals.revenue, before.totals.paidAmount], [16000 + 3000 + 2000, 21000]);
    // the day is wiped
    const st = (await s.get('/api/staff/state')).json;
    assert.deepEqual([st.orders.length, st.refunds.length, st.coupons.length, st.notice], [0, 0, 0, null]);
    assert.deepEqual((await s.get('/api/staff/sales')).json.totals, { orders: 0, billed: 0, discount: 0, memberDiscount: 0, memberOrders: 0, paidAmount: 0, refundsDone: 0, paidRevenue: 0, revenue: 0, refundDue: 0, writtenOff: 0, unpaidRevenue: 0 });
    // ...but menu, rewards, settings, tokens and the audit log stay
    assert.equal(st.pay.holder, '마감예금주');
    assert.deepEqual((await tablesOf(s)).map((t) => t.token), tokensBefore);
    assert.ok(st.rewards.length === 3 && st.menu.items.length >= 4);
    assert.equal(st.menu.items.find((i) => i.id === 'cola').soldOut, false, 'sold-out flags reset like reset does');
    assert.ok((await auditOf(s)).some((e) => e.action === 'day_close'));
    assert.deepEqual((await stTables(s)).map((t) => t.seat), Array(tk.length).fill(1));
    // the report is frozen and readable
    const list = (await s.get('/api/staff/day/reports')).json.reports;
    assert.deepEqual(list.map((x) => x.id), [1]);
    assert.equal(list[0].totals.revenue, 21000);
    const rep = (await s.get('/api/staff/day/reports/1')).json;
    assert.deepEqual([rep.id, rep.totals.revenue, rep.writtenOff.length, rep.refunds.length, rep.byItem.length > 0], [1, 21000, 1, 1, true]);
    assert.equal((await s.get('/api/staff/day/reports/99')).status, 404);
    const csv = await csvOf(srv, s, '/api/staff/day/reports/1.csv');
    assert.equal(csv.status, 200);
    assert.ok(csv.bom && csv.text.includes('[미수금]') && csv.text.includes('[환불]') && csv.text.includes('21000'), csv.text.slice(0, 200));
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.headers.get('content-disposition'), /attachment/);
    assert.equal((await new Client(srv).get('/api/staff/day/reports')).status, 401);
    assert.equal((await new Client(srv).get('/api/staff/day/reports/1.csv')).status, 401);
    // a second day gets its own report; reset creates none
    const d2 = (await order(new Client(srv), tk[0], [{ id: 'cola', qty: 1 }])).json.order;
    assert.equal(d2.id, 1, 'order numbering restarts like reset');
    assert.equal((await s.post('/api/staff/reset', { confirm: '초기화' })).status, 200);
    assert.equal((await s.get('/api/staff/day/reports')).json.reports.length, 1, 'reset creates no report');
    assert.equal((await s.post('/api/staff/day/close', { confirm: '마감' })).json.error, 'nothing_to_close', 'the day was just emptied by reset');
    await s.post('/api/staff/day/close', { confirm: '마감', force: true });
    assert.deepEqual((await s.get('/api/staff/day/reports')).json.reports.map((x) => x.id), [2, 1]);
    assert.equal((await s.get('/api/staff/day/reports/1')).json.totals.revenue, 21000, 'earlier reports never change');
  });
});

test('H14 closing the day takes a backup first', async () => {
  await withBooth(async ({ srv, s, tk }) => {
    await order(new Client(srv), tk[0], [{ id: 'cola', qty: 1 }]);
    const dir = path.join(srv.data, 'backup');
    const count = () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.db')).length : 0);
    const before = count();
    assert.equal((await s.post('/api/staff/day/close', { confirm: '마감', force: true })).status, 200);
    assert.ok(count() > before, 'a copy of the data about to be wiped was written');
  });
});

test('H15 stale writes: expectedUpdatedAt on status / paid / items / service / move / refund; a stale view gets 409 stale with the current order', async () => {
  await withBooth(async ({ s }) => {
    const o = (await staffOrder(s, 1, [{ id: 'tteokbokki', qty: 1 }])).json.order;
    const t0 = o.updatedAt;
    // a first staff member advances the order
    const r1 = await s.post(`/api/staff/orders/${o.id}/status`, { status: 'cooking', expectedUpdatedAt: t0 });
    assert.equal(r1.status, 200, r1.text);
    assert.ok(r1.json.order.updatedAt > t0, 'updatedAt strictly increases');
    // a second one still holds the old view
    for (const [p, body] of [
      [`/api/staff/orders/${o.id}/status`, { status: 'cancelled' }], [`/api/staff/orders/${o.id}/paid`, { paid: true }],
      [`/api/staff/orders/${o.id}/items`, { items: [{ id: 'cola', qty: 1 }] }], [`/api/staff/orders/${o.id}/service`, { itemId: 'cola', qty: 1 }], [`/api/staff/orders/${o.id}/move`, { to: 2 }],
    ]) {
      const r = await s.post(p, { ...body, expectedUpdatedAt: t0 });
      assert.equal(r.status, 409, `${p}: ${r.text}`);
      assert.equal(r.json.error, 'stale', p);
      assert.equal(r.json.order.id, o.id); assert.equal(r.json.order.status, 'cooking'); assert.equal(r.json.order.updatedAt, r1.json.order.updatedAt, 'the current order is returned');
    }
    assert.equal((await orderOf(s, o.id)).status, 'cooking', 'nothing was applied');
    assert.equal((await orderOf(s, o.id)).paid, false);
    assert.equal((await s.post(`/api/staff/orders/${o.id}/status`, { status: 'served', expectedUpdatedAt: 'x' })).json.error, 'bad_expected');
    // without expectedUpdatedAt the call still works (backward compatible)
    assert.equal((await s.post(`/api/staff/orders/${o.id}/status`, { status: 'served' })).status, 200);
    // matching timestamp passes for every kind of write, each advancing updatedAt
    let cur = await orderOf(s, o.id);
    for (const [p, body] of [[`/api/staff/orders/${o.id}/paid`, { paid: true }], [`/api/staff/orders/${o.id}/service`, { itemId: 'cola', qty: 1 }], [`/api/staff/orders/${o.id}/items`, { items: [{ id: 'tteokbokki', qty: 2 }] }]]) {
      const r = await s.post(p, { ...body, expectedUpdatedAt: cur.updatedAt });
      assert.equal(r.status, 200, `${p}: ${r.text}`);
      assert.ok(r.json.order.updatedAt > cur.updatedAt, p);
      cur = r.json.order;
    }
    const mv = await s.post(`/api/staff/orders/${o.id}/move`, { to: 2, expectedUpdatedAt: cur.updatedAt });
    assert.equal(mv.status, 200, mv.text);
    // refund done honours it too
    const c = (await staffOrder(s, 3, [{ id: 'cola', qty: 1 }])).json.order;
    await s.post(`/api/staff/orders/${c.id}/paid`, { paid: true });
    const cx = (await s.post(`/api/staff/orders/${c.id}/status`, { status: 'cancelled' })).json.order;
    const rid = (await s.get('/api/staff/state')).json.refunds.find((x) => x.orderId === c.id).id;
    assert.equal((await s.post(`/api/staff/refunds/${rid}/done`, { amount: 2000, expectedUpdatedAt: cx.updatedAt - 1 })).json.error, 'stale');
    assert.equal((await s.post(`/api/staff/refunds/${rid}/done`, { amount: 2000, expectedUpdatedAt: cx.updatedAt })).status, 200);
  });
});

test('H15 two phones tap paid at once: only one payment is applied', async () => {
  await withBooth(async ({ srv, s }) => {
    const s2 = await staffLogin(srv);
    const o = (await staffOrder(s, 1, [{ id: 'tteokbokki', qty: 1 }])).json.order;
    const res = await Promise.all([s.post(`/api/staff/orders/${o.id}/paid`, { paid: true }), s2.post(`/api/staff/orders/${o.id}/paid`, { paid: true })]);
    assert.deepEqual(res.map((r) => r.status).sort(), [200, 409]);
    assert.equal((await orderOf(s, o.id)).paidAmount, 8000, 'never double-counted');
    assert.equal((await s.get('/api/staff/sales')).json.totals.revenue, 8000);
  });
});

test('every new staff endpoint requires a session', async () => {
  const anon = guest();
  const checks = [
    ['POST', '/api/staff/tables/1/orders', { key: 'abcdefgh', items: [{ id: 'cola', qty: 1 }] }], ['POST', '/api/staff/orders/1/items', { items: [] }], ['POST', '/api/staff/orders/1/service', { itemId: 'cola', qty: 1 }],
    ['POST', '/api/staff/orders/1/move', { to: 2 }], ['POST', '/api/staff/refunds/1/done', {}], ['POST', '/api/staff/tables/1/unclear', {}], ['POST', '/api/staff/notice', { text: 'x' }],
    ['POST', '/api/staff/tables/1/coupons', { type: 'item', label: 'x' }], ['POST', '/api/staff/coupons/ABCDEF/void', {}], ['POST', '/api/staff/waitlist/timeout', { minutes: 3 }],
    ['POST', '/api/staff/wait/1/recall', {}], ['GET', '/api/staff/audit'], ['POST', '/api/staff/day/close', { confirm: '마감' }], ['GET', '/api/staff/day/reports'], ['GET', '/api/staff/day/reports/1'], ['GET', '/api/staff/day/reports/1.csv'],
  ];
  for (const [m, p, b] of checks) {
    const r = await anon.req(m, p, b);
    assert.equal(r.status, 401, `${m} ${p} -> ${r.status}`);
  }
});

// ---- property-style test: random staff sequences never break the money invariants ----
function lcg(seed) { let x = seed >>> 0; return () => ((x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 2 ** 32); }
for (const seed of [11, 4242, 90210]) {
  test(`money invariants hold after every step of a random staff sequence (seed ${seed})`, async () => {
    const rnd = lcg(seed);
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    await withBooth(async ({ srv, s }) => {
      const ids = ['tteokbokki', 'odeng', 'fries', 'cola'];
      let refundsDoneByMe = 0;
      const check = async (step) => {
        const st = (await s.get('/api/staff/state')).json;
        const sale = (await s.get('/api/staff/sales')).json;
        let doneSum = 0;
        for (const o of st.orders) {
          const where = `${step}, order #${o.id} ${JSON.stringify({ t: o.total, p: o.paidAmount, st: o.status, paid: o.paid })}`;
          assert.equal(o.subtotal - o.memberDiscount - o.couponDiscount, o.total, `total = subtotal - member - coupon: ${where}`);
          assert.ok(o.total >= 0, `total >= 0: ${where}`);
          assert.ok(o.paidAmount >= 0 && o.balanceDue >= 0 && o.overpaid >= 0 && o.refundDue >= 0 && o.refundedAmount >= 0, `nothing negative: ${where}`);
          const expectedDue = o.status === 'cancelled' ? o.paidAmount - o.refundedAmount : Math.max(0, o.paidAmount - o.total - o.refundedAmount);
          assert.equal(o.refundDue, Math.max(0, expectedDue), `refundDue: ${where}`);
          if (o.status !== 'cancelled') assert.equal(o.paid, o.paidAmount - o.refundedAmount >= o.total && (o.paidAmount > 0 || o.total === 0) ? true : false, `paid flag follows the money held: ${where}`);
          doneSum += o.refundedAmount;
        }
        // orders cleared away still count: the sales figure is global
        assert.equal(sale.totals.revenue, sale.totals.paidAmount - sale.totals.refundsDone, `revenue = received - refunded: ${step}`);
        assert.equal(Object.values(sale.byMethod).reduce((n, m) => n + m.net, 0), sale.totals.revenue, `Σ net by method = revenue: ${step}`);
        assert.equal(Object.values(sale.byMethod).reduce((n, m) => n + m.received, 0), sale.totals.paidAmount, `Σ received by method = paidAmount: ${step}`);
        assert.ok(sale.totals.revenue >= 0 && sale.totals.refundDue >= 0 && sale.totals.writtenOff >= 0 && sale.totals.unpaidRevenue >= 0 && sale.totals.billed >= 0, `no negative totals: ${step}`);
        assert.equal(sale.totals.refundsDone, refundsDoneByMe, `refunds done = those staff confirmed: ${step}`);
        assert.ok(doneSum <= sale.totals.refundsDone);
      };
      for (let step = 0; step < 70; step++) {
        const kind = pick(['order', 'order', 'edit', 'pay', 'pay', 'overpay', 'cancel', 'refund', 'clear', 'unclear', 'service', 'unpay']);
        const live = (await s.get('/api/staff/state')).json.orders;
        const o = live.length ? pick(live) : null;
        const label = `${kind}#${step}`;
        if (kind === 'order' || !o) {
          const n = 1 + Math.floor(rnd() * 3);
          const items = [...new Set(Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(ids)))].map((id) => ({ id, qty: 1 + Math.floor(rnd() * 3) }));
          const r = await staffOrder(s, n, items);
          assert.ok(r.status === 201, r.text);
        } else if (kind === 'edit') {
          const items = [...new Set(Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => pick(ids)))].map((id) => ({ id, qty: Math.floor(rnd() * 4) }));
          await s.post(`/api/staff/orders/${o.id}/items`, { items });
        } else if (kind === 'pay') {
          await s.post(`/api/staff/orders/${o.id}/paid`, { paid: true, method: pick(['cash', 'transfer', 'other']), ...(rnd() < 0.5 ? { amount: 1000 * (1 + Math.floor(rnd() * 12)) } : {}) });
        } else if (kind === 'overpay') {
          await s.post(`/api/staff/orders/${o.id}/paid`, { paid: true, method: 'cash', amount: o.total + 1000 * (1 + Math.floor(rnd() * 5)) });
        } else if (kind === 'unpay') {
          await s.post(`/api/staff/orders/${o.id}/paid`, { paid: false });
        } else if (kind === 'cancel') {
          await s.post(`/api/staff/orders/${o.id}/status`, { status: 'cancelled' });
        } else if (kind === 'service') {
          await s.post(`/api/staff/orders/${o.id}/service`, { itemId: pick(ids), qty: 1 });
        } else if (kind === 'refund') {
          const open = (await s.get('/api/staff/state')).json.refunds.filter((x) => !x.doneAt);
          if (open.length) { const r = pick(open); const res = await s.post(`/api/staff/refunds/${r.id}/done`, { amount: r.amount }); if (res.status === 200) refundsDoneByMe += r.amount; }
        } else if (kind === 'clear') {
          await s.post(`/api/staff/tables/${o.table}/clear`, { force: true });
        } else if (kind === 'unclear') {
          await s.post(`/api/staff/tables/${1 + Math.floor(rnd() * 3)}/unclear`, {});
        }
        await check(label);
      }
      const fin = (await s.get('/api/staff/sales')).json; // the sequence really moved money in every way
      assert.ok(fin.totals.paidAmount > 0 && fin.totals.refundsDone > 0 && fin.refunds.length > 0 && fin.totals.writtenOff > 0, JSON.stringify(fin.totals));
    });
  });
}

test('upgrade from Release 1: a booth.db created by the production schema (cf5d032) boots, keeps its data and gains payments, refunds, audit and stock', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-r1-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const old = new DatabaseSync(path.join(dir, 'data', 'booth.db'));
  old.exec(R1_SCHEMA);
  assert.ok(!old.prepare('PRAGMA table_info(orders)').all().some((c) => c.name === 'paid_amount'), 'fixture is the Release 1 schema');
  assert.equal(old.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('refunds','audit_log','day_reports','table_clears')").get().n, 0);
  const tokensOld = [];
  for (let i = 1; i <= 8; i++) { const t = crypto.randomBytes(12).toString('base64url'); tokensOld.push(t); old.prepare('INSERT INTO tables(id, token) VALUES(?,?)').run(i, t); }
  old.prepare("INSERT INTO menu_categories(id, name, sort) VALUES(1, '안주', 0)").run();
  old.prepare("INSERT INTO menu_items(id, name, price, category_id, descr, sort) VALUES('legacy-item', '레거시 메뉴', 5000, 1, '', 0)").run();
  old.prepare("INSERT INTO settings(k, v) VALUES('menu_seeded', '1')").run();
  const ts = Date.now() - 60000;
  const mk = old.prepare('INSERT INTO orders(table_id, seat, key, status, paid, subtotal, discount, total, created_at, updated_at, paid_by, depositor) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
  const item = old.prepare("INSERT INTO order_items(order_id, item_id, name, unit_price, qty) VALUES(?, 'legacy-item', '레거시 메뉴', 5000, ?)");
  const ids = [
    ['paid by staff', mk.run(1, 1, 'key-staff-paid', 'served', 1, 10000, 0, 10000, ts, ts, 'staff', null).lastInsertRowid, 2],
    ['paid by auto', mk.run(1, 1, 'key-auto-paid', 'cooking', 1, 5000, 0, 5000, ts, ts, 'auto', '김철수').lastInsertRowid, 1],
    ['unpaid', mk.run(2, 1, 'key-unpaid', 'pending', 0, 15000, 0, 15000, ts, ts, null, null).lastInsertRowid, 3],
    ['cancelled but paid', mk.run(3, 1, 'key-cancelled', 'cancelled', 1, 5000, 0, 5000, ts, ts, 'staff', null).lastInsertRowid, 1],
    ['cancelled unpaid', mk.run(3, 1, 'key-cancelled2', 'cancelled', 0, 5000, 0, 5000, ts, ts, null, null).lastInsertRowid, 1],
  ];
  for (const [, id, q] of ids) item.run(id, q);
  old.prepare("INSERT INTO deposit_notices(received_at, raw, norm, amount, depositor, status, order_id, matched_at, matched_by) VALUES(?, '원문', '원문', 5000, '김철수', 'matched', ?, ?, 'auto')").run(ts, ids[1][1], ts);
  old.close();
  let srv; let srv2;
  try {
    srv = await boot({ dir, tablesCount: 8 });
    const s = await staffLogin(srv);
    const st = (await s.get('/api/staff/state')).json;
    const byId = Object.fromEntries(st.orders.map((o) => [o.id, o]));
    const [staffPaid, autoPaid, unpaid, cxPaid] = ids.map((x) => byId[x[1]]);
    assert.deepEqual([staffPaid.paid, staffPaid.paidAmount, staffPaid.paidMethod, staffPaid.balanceDue, staffPaid.createdBy], [true, 10000, 'other', 0, 'guest'], 'hand-marked paid orders count as received in full');
    assert.deepEqual([autoPaid.paid, autoPaid.paidAmount, autoPaid.paidMethod, autoPaid.paidBy], [true, 5000, 'transfer', 'auto']);
    assert.deepEqual([unpaid.paid, unpaid.paidAmount, unpaid.paidMethod, unpaid.balanceDue], [false, 0, null, 15000]);
    assert.deepEqual([cxPaid.status, cxPaid.paidAmount, cxPaid.refundDue], ['cancelled', 5000, 5000], 'money received on a cancelled order is owed back');
    assert.deepEqual(st.refunds.map((r) => [r.orderId, r.amount, r.doneAt]), [[ids[3][1], 5000, null]], 'one open refund; the unpaid cancelled order owes nothing');
    const sale = (await s.get('/api/staff/sales')).json;
    assert.deepEqual([sale.totals.paidAmount, sale.totals.revenue, sale.totals.refundDue, sale.totals.billed, sale.totals.unpaidRevenue, sale.totals.writtenOff], [20000, 20000, 5000, 30000, 15000, 0]);
    assert.deepEqual([sale.byMethod.other.received, sale.byMethod.transfer.received, sale.byMethod.cash.received], [15000, 5000, 0], 'the payment ledger is backfilled from the old paid orders (hand-marked = other, automatic = transfer)');
    assert.equal(Object.values(sale.byMethod).reduce((n, m) => n + m.net, 0), sale.totals.revenue);
    assert.deepEqual(st.refunds.map((r) => r.reason), ['legacy_cancelled'], 'dated with the cancellation (updatedAt of the order), not with the boot');
    assert.ok(st.refunds[0].createdAt < Date.now() - 30000, 'not stamped with the boot time');
    assert.deepEqual(st.menu.items.map((i) => [i.id, i.stockLeft, i.stockAuto]), [['legacy-item', null, false]]);
    assert.equal(st.waitCallTimeoutMin, 5);
    assert.deepEqual([st.notice, (await s.get('/api/staff/day/reports')).json.reports, (await s.get('/api/staff/audit')).json.entries.map((e) => e.action)], [null, [], ['login', 'migrated']], 'empty new tables; the audit log has this login and the migration note');
    assert.equal((await stTables(s))[0].unclearUntil, null);
    // everything new works on the migrated rows
    assert.equal((await s.post(`/api/staff/orders/${unpaid.id}/paid`, { paid: true, method: 'cash', amount: 5000 })).json.order.balanceDue, 10000);
    assert.equal((await s.post(`/api/staff/orders/${staffPaid.id}/items`, { items: [{ id: 'legacy-item', qty: 1 }] })).json.order.refundDue, 5000);
    assert.equal((await s.post(`/api/staff/refunds/${st.refunds[0].id}/done`, { method: 'cash', amount: st.refunds[0].amount })).status, 200);
    assert.equal((await staffOrder(s, 1, [{ id: 'legacy-item', qty: 1 }])).status, 201);
    assert.equal((await s.post('/api/staff/menu/items/legacy-item', { stockLeft: 3 })).json.item.stockLeft, 3);
    assert.equal((await s.post('/api/staff/notice', { text: '업그레이드 확인' })).status, 200);
    assert.ok((await auditOf(s)).length >= 4);
    assert.deepEqual((await tablesOf(s)).map((t) => t.token), tokensOld, 'QR tokens unchanged');
    await srv.stop({ keep: true });
    // a second boot on the upgraded file changes nothing (migration is idempotent; refunds are not duplicated)
    srv2 = await boot({ dir, tablesCount: 8 });
    const s2 = await staffLogin(srv2);
    const st2 = (await s2.get('/api/staff/state')).json;
    assert.equal(st2.refunds.filter((r) => r.orderId === ids[3][1]).length, 1);
    assert.equal(st2.orders.find((o) => o.id === unpaid.id).paidAmount, 5000);
  } finally { if (srv2) await srv2.stop(); else if (srv && srv.child.exitCode === null) await srv.stop(); else fs.rmSync(dir, { recursive: true, force: true }); }
});

const FOUR_GAMES = {
  ...REWARDS,
  games: {
    ...REWARDS.games,
    bug: { label: '버그 잡기', maxScore: 500, minDurationMs: 200 },
    typing: { label: '타자 배틀', maxScore: 1000, minDurationMs: 200 },
  },
};
test('four games: nothing assumes pour/cheers; bug plays, rewards and the board work', async () => {
  await withBooth(async ({ srv, s, tk }) => {
    const g = new Client(srv); g.jar.booth_d = await realDevice(srv);
    const r = await s.post('/api/staff/rewards', { label: '버그 음료', game: 'bug', threshold: 300, type: 'item', stock: 2 });
    assert.equal(r.status, 200, r.text);
    assert.equal((await s.post('/api/staff/rewards', { label: 'x', game: 'nope', threshold: 1, type: 'item', stock: 1 })).json.error, 'bad_game');
    assert.match((await s.post('/api/staff/rewards', { label: 'x', game: 'nope', threshold: 1, type: 'item', stock: 1 })).json.message, /bug.*typing/);
    assert.equal((await s.post('/api/staff/rewards', { label: '타자', game: 'typing', threshold: 1001, type: 'item', stock: 1 })).json.error, 'bad_threshold', 'threshold is capped by the typing maxScore (1000)');
    const fin = await playOnce(g, tk[0], 'bug', 450);
    assert.equal(fin.status, 200, fin.text);
    assert.deepEqual(fin.json.rewards.map((x) => x.result), ['issued']);
    assert.equal((await playOnce(g, tk[0], 'bug', 600)).json.error, 'bad_score', 'bug maxScore is 500');
    assert.equal((await playOnce(g, tk[1], 'typing', 900)).status, 200);
    const b = (await g.get('/api/board')).json;
    assert.deepEqual(Object.keys(b.games).sort(), ['bug', 'cheers', 'pour', 'typing']);
    assert.deepEqual(Object.keys(b.gameInfo).sort(), ['bug', 'cheers', 'pour', 'typing']);
    assert.deepEqual([b.games.bug[0].score, b.games.typing[0].score], [450, 900]);
    assert.ok(b.hour.ranking.some((x) => x.games.bug === 450), 'the hourly ranking sums every game');
    assert.deepEqual(Object.keys((await s.get('/api/staff/state')).json.games).sort(), ['bug', 'cheers', 'pour', 'typing']);
    assert.deepEqual(Object.keys((await g.get(`/api/t/${tk[0]}`)).json.games).sort(), ['bug', 'cheers', 'pour', 'typing']);
  }, { rewards: FOUR_GAMES });
});

test('landing page says COMHERE and public/landing.html overrides it (with __BASE__)', async () => {
  await withBooth(async ({ srv }) => {
    const g = new Client(srv);
    const a = await g.get('/');
    assert.ok(a.status === 200 && a.text.includes('COMHERE') && a.text.includes('<title>COMHERE</title>') && !a.text.includes('주점 부스'));
    fs.writeFileSync(path.join(srv.dir, 'pub', 'landing.html'), '<!doctype html><title>내 랜딩</title><a href="__BASE__/wait">대기</a>');
    const b = await g.get('/');
    assert.equal(b.status, 200);
    assert.ok(b.text.includes('내 랜딩') && b.text.includes('href="/booth/wait"') && !b.text.includes('__BASE__'), b.text);
    assert.match(b.headers.get('content-type'), /text\/html/);
    assert.equal(b.headers.get('x-content-type-options'), 'nosniff');
  }, { base: '/booth' });
});


// ---------------- Release 2 review fixes ----------------
test('R2-1 pay default amount is the balance AFTER refunds paid back (reviewer sequence settles in one call)', async () => {
  await withBooth(async ({ s }) => {
    const o = (await staffOrder(s, 1, [{ id: 'tteokbokki', qty: 1 }, { id: 'cola', qty: 1 }])).json.order; // 10,000
    await s.post(`/api/staff/orders/${o.id}/paid`, { paid: true });
    await s.post(`/api/staff/orders/${o.id}/items`, { items: [{ id: 'tteokbokki', qty: 1 }] }); // 8,000 -> 2,000 refund
    const rid = (await s.get('/api/staff/state')).json.refunds[0].id;
    assert.equal((await s.post(`/api/staff/refunds/${rid}/done`, { amount: 2000 })).status, 200);
    const up = (await s.post(`/api/staff/orders/${o.id}/items`, { items: [{ id: 'tteokbokki', qty: 1 }, { id: 'odeng', qty: 1 }] })).json.order; // 17,000, held 8,000
    assert.deepEqual([up.paid, up.balanceDue, up.paidAmount, up.refundedAmount], [false, 9000, 10000, 2000]);
    const done = (await s.post(`/api/staff/orders/${o.id}/paid`, { paid: true })).json.order;
    assert.deepEqual([done.paid, done.balanceDue, done.paidAmount, done.overpaid, done.refundDue], [true, 0, 19000, 2000 - 2000, 0]);
    const sale = (await s.get('/api/staff/sales')).json.totals;
    assert.deepEqual([sale.paidAmount, sale.refundsDone, sale.revenue], [19000, 2000, 17000]);
  });
});

test('R2-2 editing an order that has a member discount but no stored rule keeps the discount', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-r2m-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const old = new DatabaseSync(path.join(dir, 'data', 'booth.db'));
  old.exec(R1_SCHEMA);
  for (let i = 1; i <= 4; i++) old.prepare('INSERT INTO tables(id, token) VALUES(?,?)').run(i, crypto.randomBytes(12).toString('base64url'));
  old.prepare("INSERT INTO menu_categories(id, name, sort) VALUES(1, '안주', 0)").run();
  old.prepare("INSERT INTO menu_items(id, name, price, category_id, descr, sort) VALUES('legacy-item', '레거시', 8000, 1, '', 0)").run();
  old.prepare("INSERT INTO menu_items(id, name, price, category_id, descr, sort) VALUES('extra', '추가', 7000, 1, '', 1)").run();
  old.prepare("INSERT INTO settings(k, v) VALUES('menu_seeded', '1')").run();
  const ts = Date.now() - 60000;
  const id = old.prepare("INSERT INTO orders(table_id, seat, key, status, paid, subtotal, discount, member_discount, member_id, total, created_at, updated_at) VALUES(1,1,'key-member1','cooking',0,16000,0,1600,77,14400,?,?)").run(ts, ts).lastInsertRowid;
  old.prepare("INSERT INTO order_items(order_id, item_id, name, unit_price, qty) VALUES(?, 'legacy-item', '레거시', 8000, 2)").run(id);
  old.close();
  let srv;
  try {
    srv = await boot({ dir, tablesCount: 4 });
    const s = await staffLogin(srv);
    const before = await orderOf(s, Number(id));
    assert.deepEqual([before.memberDiscount, before.total, before.memberRule && before.memberRule.mode], [1600, 14400, 'fixed']);
    const e = (await s.post(`/api/staff/orders/${id}/items`, { items: [{ id: 'legacy-item', qty: 2 }, { id: 'extra', qty: 1 }] })).json.order;
    assert.deepEqual([e.subtotal, e.memberDiscount, e.total], [23000, 1600, 21400], 'the discount it got is kept');
    const small = (await s.post(`/api/staff/orders/${id}/items`, { items: [{ id: 'extra', qty: 0 }, { id: 'legacy-item', qty: 0 }, { id: 'legacy-item', qty: 1, service: true }] }));
    assert.equal(small.json.error, 'no_lines');
  } finally { if (srv) await srv.stop(); else fs.rmSync(dir, { recursive: true, force: true }); }
});

test('R2-3 moving an order keeps its coupon with the seat that earned it: that seat cannot earn it again, cancel still restores it', async () => {
  await withBooth(async ({ srv, s, tk }) => {
    const g = new Client(srv); g.jar.booth_d = await realDevice(srv);
    const fin = await playOnce(g, tk[3], 'cheers', 750); // table 4 earns d1000
    const cp = fin.json.coupons.find((c) => c.rewardId === 'd1000');
    assert.ok(cp, fin.text);
    const o = (await order(g, tk[3], [{ id: 'tteokbokki', qty: 1 }], { couponCode: cp.code })).json.order;
    assert.equal((await s.post(`/api/staff/orders/${o.id}/move`, { to: 5 })).status, 200);
    const again = await playOnce(g, tk[3], 'cheers', 750);
    assert.deepEqual(again.json.rewards.find((r) => r.rewardId === 'd1000').result, 'already_got', 'table 4 must not re-earn');
    const g5 = new Client(srv); g5.jar.booth_d = await realDevice(srv);
    const view5 = (await g5.get(`/api/t/${tk[4]}`)).json;
    assert.equal(view5.rewards.find((r) => r.id === 'd1000').got, false, 'table 5 did not earn it');
    await s.post(`/api/staff/orders/${o.id}/status`, { status: 'cancelled' });
    const db = dbOf(srv);
    assert.deepEqual({ ...db.prepare('SELECT status, order_id, table_id FROM coupons WHERE code=?').get(cp.code) }, { status: 'issued', order_id: null, table_id: 4 }, 'a restored coupon goes back to the seat that earned it');
    db.close();
  });
});

test('R2-4 unpay releases EVERY notice linked to the order', async () => {
  const d = await depositSetup();
  try {
    const { s, tk } = d;
    const o = await d.place(tk[0], '김철수'); // 8,000
    const n1 = await d.sms(3000, '김철수'); const n2 = await d.sms(5000, '김철수');
    const asg = (nid, body) => s.post(`/api/staff/deposits/${nid}/assign`, body);
    assert.equal((await asg(n1.id, { orderId: o.id, force: true, note: '일부' })).status, 200);
    assert.equal((await asg(n2.id, { orderId: o.id })).json.order.paid, true, 'the remaining 5,000 equals the balance: no force needed');
    assert.equal((await s.post(`/api/staff/orders/${o.id}/paid`, { paid: false })).status, 200);
    const ns = await d.notices();
    assert.deepEqual([n1.id, n2.id].map((id) => ns.find((x) => x.id === id).status), ['pending', 'pending']);
    assert.deepEqual([n1.id, n2.id].map((id) => ns.find((x) => x.id === id).orderId), [null, null]);
  } finally { await d.srv.stop(); }
});

test('R2-5 deposit matching compares the notice with the BALANCE: cash part + transfer of the rest', async () => {
  const d = await depositSetup();
  try {
    const { s, tk } = d;
    const o = await d.place(tk[0], '김철수'); // 8,000
    await s.post(`/api/staff/orders/${o.id}/paid`, { paid: true, method: 'cash', amount: 3000 });
    const eight = await d.sms(8000, '김철수');
    assert.notEqual(eight.status, 'matched', 'an 8,000 notice is NOT the balance (5,000) of this order');
    const five = await d.sms(5000, '김철수');
    assert.equal(five.status, 'matched', JSON.stringify(five));
    const done = await d.order(o.id);
    assert.deepEqual([done.paid, done.paidAmount, done.overpaid], [true, 8000, 0]);
    // manual assign: the 8,000 notice against a partly paid order is a mismatch (needs force + note) and then owes the excess back
    const o2 = await d.place(tk[1], '이영희'); // 8,000
    await s.post(`/api/staff/orders/${o2.id}/paid`, { paid: true, method: 'cash', amount: 3000 });
    const asg = (body) => s.post(`/api/staff/deposits/${eight.id}/assign`, { orderId: o2.id, ...body });
    const mm = await asg({});
    assert.deepEqual([mm.status, mm.json.error, mm.json.orderTotal, mm.json.orderBalance, mm.json.noticeAmount], [409, 'amount_mismatch', 8000, 5000, 8000]);
    assert.equal((await asg({ force: true })).json.error, 'note_required');
    const ok = await asg({ force: true, note: '전액을 계좌로 보냄' });
    assert.deepEqual([ok.json.order.paid, ok.json.order.paidAmount, ok.json.order.overpaid, ok.json.order.refundDue], [true, 11000, 3000, 3000]);
    const c = (await s.get('/api/staff/deposits')).json;
    assert.ok(c.notices.every((n) => n.candidates.every((x) => typeof x.balance === 'number')));
  } finally { await d.srv.stop(); }
});

test('R2-6 day close: open_items / nothing_to_close unless forced; the forced report itemises everything and the CSV has the sections', async () => {
  await withBooth(async ({ srv, s }) => {
    const empty = await s.post('/api/staff/day/close', { confirm: '마감' });
    assert.deepEqual([empty.status, empty.json.error], [409, 'nothing_to_close']);
    const a = (await staffOrder(s, 1, [{ id: 'tteokbokki', qty: 1 }])).json.order; // unpaid, unserved
    const b = (await staffOrder(s, 2, [{ id: 'odeng', qty: 1 }])).json.order; // cancelled after payment -> refund
    await s.post(`/api/staff/orders/${b.id}/paid`, { paid: true });
    await s.post(`/api/staff/orders/${b.id}/status`, { status: 'cancelled' });
    const c = (await staffOrder(s, 3, [{ id: 'cola', qty: 1 }])).json.order; // written off
    await s.post('/api/staff/tables/3/clear', { force: true });
    const r = await s.post('/api/staff/day/close', { confirm: '마감' });
    assert.equal(r.status, 409);
    assert.deepEqual([r.json.error, r.json.refundDue, r.json.unpaid, r.json.unserved, r.json.writtenOff], ['open_items', { entries: 1, amount: 9000 }, { orders: 1, amount: 8000 }, { orders: 2 }, { orders: 1, amount: 2000 }]);
    assert.equal((await s.get('/api/staff/day/reports')).json.reports.length, 0);
    assert.equal((await orderOf(s, a.id)).id, a.id);
    assert.equal((await s.post('/api/staff/day/close', { confirm: '마감', force: 'true' })).json.error, 'open_items', 'only literal true forces');
    const ok = await s.post('/api/staff/day/close', { confirm: '마감', force: true });
    assert.equal(ok.status, 200, ok.text);
    const rep = (await s.get('/api/staff/day/reports/1')).json;
    assert.deepEqual(rep.refunds.map((x) => [x.orderId, x.amount, x.doneAt]), [[b.id, 9000, null]]);
    assert.deepEqual(rep.unpaid.map((x) => [x.orderId, x.balance]), [[a.id, 8000]]);
    assert.deepEqual(rep.writtenOff.map((x) => [x.orderId, x.balance]), [[c.id, 2000]]);
    assert.equal(rep.forced, true);
    const csv = await csvOf(srv, s, '/api/staff/day/reports/1.csv');
    assert.ok(csv.text.includes('[미결제(진행중)]') && csv.text.includes(`${a.id},1,8000,0,8000`) && csv.text.includes('[미수금]') && csv.text.includes('[환불]'), csv.text);
    assert.equal((await s.post('/api/staff/day/close', { confirm: '마감' })).json.error, 'nothing_to_close', 'a second close right after is refused');
  });
});

test('R2-7 every staff POST route in server.js writes an audit row (or is read-only); settings rows carry before→after and never secrets', async () => {
  const src = fs.readFileSync(SERVER, 'utf8');
  const routes = [...src.matchAll(/route\('POST', '(\/api\/staff\/[^']*)'/g)].map((m) => m[1]);
  assert.ok(routes.length > 30, `found ${routes.length} routes`);
  await withBooth(async ({ srv, s, tk }) => {
    const o = (await staffOrder(s, 1, [{ id: 'tteokbokki', qty: 1 }, { id: 'cola', qty: 1 }])).json.order;
    await s.post(`/api/staff/orders/${o.id}/paid`, { paid: true });
    const it = await mkItem(s, '감사용', 1000);
    const cx = (await staffOrder(s, 2, [{ id: 'cola', qty: 1 }])).json.order;
    await s.post(`/api/staff/orders/${cx.id}/paid`, { paid: true });
    await s.post(`/api/staff/orders/${cx.id}/status`, { status: 'cancelled' });
    const refundId = (await s.get('/api/staff/state')).json.refunds[0].id;
    const cp = (await s.post('/api/staff/tables/1/coupons', { type: 'item', label: '감사' })).json.coupon;
    const cp2 = (await s.post('/api/staff/tables/1/coupons', { type: 'item', label: '감사2' })).json.coupon;
    const w = (await new Client(srv).post('/api/wait', { nick: '대기', size: 1 })).json;
    const g = new Client(srv); await g.post(`/api/t/${tk[3]}/calls`, { type: '물' });
    const call = (await s.get('/api/staff/state')).json.calls[0];
    const sms = JSON.parse((await hookPost(srv, (await s.get('/api/staff/deposit-hook')).json.secret, { text: smsText(5000, '아무개', 31) })).text);
    const pay = (await s.get('/api/staff/state')).json.pay;
    // path -> [body]; routes with no entry make the test fail, so a new route must be added here
    const calls = {
      '/api/staff/logout': null, // session handling, not a state change (login/lockout are audited separately)
      '/api/staff/orders/(\\d{1,9})/status': [`/api/staff/orders/${o.id}/status`, { status: 'cooking' }],
      '/api/staff/orders/(\\d{1,9})/paid': [`/api/staff/orders/${o.id}/paid`, { paid: false }],
      '/api/staff/orders/(\\d{1,9})/items': [`/api/staff/orders/${o.id}/items`, { items: [{ id: 'tteokbokki', qty: 2 }] }],
      '/api/staff/orders/(\\d{1,9})/service': [`/api/staff/orders/${o.id}/service`, { itemId: 'cola', qty: 1 }],
      '/api/staff/orders/(\\d{1,9})/move': [`/api/staff/orders/${o.id}/move`, { to: 4 }],
      '/api/staff/refunds/(\\d{1,9})/done': [`/api/staff/refunds/${refundId}/done`, { amount: 2000 }],
      '/api/staff/menu/([A-Za-z0-9_-]{1,40})/soldout': ['/api/staff/menu/cola/soldout', { soldOut: true }],
      '/api/staff/pay': ['/api/staff/pay', { tossEnabled: true }],
      '/api/staff/deposits/(\\d{1,9})/assign': [`/api/staff/deposits/${sms.id}/assign`, { orderId: o.id, force: true, note: '감사' }],
      '/api/staff/deposits/(\\d{1,9})/dismiss': 'dismiss',
      '/api/staff/deposits/autoconfirm': ['/api/staff/deposits/autoconfirm', { autoConfirm: true, autoConfirmMaxAmount: 20000 }],
      '/api/staff/deposits/(\\d{1,9})/attach': 'attach',
      '/api/staff/deposit-hook/test': null, // dry run, stores nothing
      '/api/staff/deposit-hook/rotate': ['/api/staff/deposit-hook/rotate', {}],
      '/api/staff/menu/items': ['/api/staff/menu/items', { name: '새 메뉴', price: 1000, category: '테스트' }],
      '/api/staff/menu/items/([A-Za-z0-9_-]{1,40})': [`/api/staff/menu/items/${it}`, { price: 1500 }],
      '/api/staff/menu/items/([A-Za-z0-9_-]{1,40})/delete': 'delete-item',
      '/api/staff/menu/reorder': ['/api/staff/menu/reorder', { items: ['cola', 'odeng'] }],
      '/api/staff/menu/categories': ['/api/staff/menu/categories', { name: '새분류' }],
      '/api/staff/menu/categories/(\\d{1,9})': 'rename-cat',
      '/api/staff/menu/categories/(\\d{1,9})/delete': 'delete-cat',
      '/api/staff/member-discount': ['/api/staff/member-discount', { pct: 15 }],
      '/api/staff/rewards': ['/api/staff/rewards', { label: '감사보상', game: 'pour', threshold: 10, type: 'item', stock: 1 }],
      '/api/staff/rewards/([A-Za-z0-9_-]{1,40})': ['/api/staff/rewards/drink', { stock: 5 }],
      '/api/staff/rewards/([A-Za-z0-9_-]{1,40})/delete': 'delete-reward',
      '/api/staff/hourly-reward': ['/api/staff/hourly-reward', { enabled: false }],
      '/api/staff/menu/items/([A-Za-z0-9_-]{1,40})/photo': null, // raw upload, covered by the generic row in its own test below
      '/api/staff/menu/items/([A-Za-z0-9_-]{1,40})/photo/delete': [`/api/staff/menu/items/${it}/photo/delete`, {}],
      '/api/staff/ordering': ['/api/staff/ordering', { open: false }],
      '/api/staff/coupons/redeem': ['/api/staff/coupons/redeem', { code: cp.code }],
      '/api/staff/tables/count': ['/api/staff/tables/count', { count: 30 }],
      '/api/staff/tables/(\\d{1,4})/rotate': ['/api/staff/tables/5/rotate', {}],
      '/api/staff/tables/move': ['/api/staff/tables/move', { from: 6, to: 7 }],
      '/api/staff/waitlist/open': ['/api/staff/waitlist/open', { open: false }],
      '/api/staff/wait/(\\d{1,9})/(call|seat|cancel|recall)': [`/api/staff/wait/${w.id}/call`, {}],
      '/api/staff/waitlist/clear': ['/api/staff/waitlist/clear', {}],
      '/api/staff/tables/(\\d{1,4})/clear': ['/api/staff/tables/8/clear', {}],
      '/api/staff/calls/(\\d{1,9})/resolve': [`/api/staff/calls/${call.id}/resolve`, {}],
      '/api/staff/award-hour': null, // needs a finished play; covered by the generic row in the award test
      '/api/staff/rewards/([A-Za-z0-9_-]{1,40})/stock': ['/api/staff/rewards/drink/stock', { stock: 6 }],
      '/api/staff/tables/(\\d{1,4})/unclear': ['/api/staff/tables/8/unclear', {}],
      '/api/staff/tables/(\\d{1,4})/orders': ['/api/staff/tables/9/orders', { key: newKey(), items: [{ id: 'fries', qty: 1 }] }],
      '/api/staff/tables/(\\d{1,4})/coupons': ['/api/staff/tables/9/coupons', { type: 'item', label: '감사3' }],
      '/api/staff/coupons/([A-Za-z0-9]{1,12})/void': [`/api/staff/coupons/${cp2.code}/void`, {}],
      '/api/staff/notice': ['/api/staff/notice', { text: '감사 공지', level: 'warn' }],
      '/api/staff/waitlist/timeout': ['/api/staff/waitlist/timeout', { minutes: 7 }],
      '/api/staff/reset': 'reset',
      '/api/staff/day/close': 'day-close',
      '/api/staff/login': null,
    };
    for (const r of routes) if (r !== '/api/staff/login') assert.ok(Object.hasOwn(calls, r.replace(/\\\\/g, '\\')) || Object.hasOwn(calls, r), `new staff POST route without an audit test entry: ${r}`);
    const count = async () => (await s.get('/api/staff/audit?limit=1')).json.entries[0]?.id ?? 0;
    const stateful = async (key, spec) => {
      if (spec === 'dismiss') { const n = JSON.parse((await hookPost(srv, (await s.get('/api/staff/deposit-hook')).json.secret, { text: smsText(7000, '다른이', 32) })).text); return [`/api/staff/deposits/${n.id}/dismiss`, {}]; }
      if (spec === 'attach') { const o2 = (await staffOrder(s, 10, [{ id: 'fries', qty: 1 }])).json.order; await s.post(`/api/staff/orders/${o2.id}/paid`, { paid: true }); const n = JSON.parse((await hookPost(srv, (await s.get('/api/staff/deposit-hook')).json.secret, { text: smsText(6000, '또다른', 33) })).text); return [`/api/staff/deposits/${n.id}/attach`, { orderId: o2.id }]; }
      if (spec === 'delete-item') { const id2 = await mkItem(s, '지울 메뉴', 1000); return [`/api/staff/menu/items/${id2}/delete`, {}]; }
      if (spec === 'rename-cat') { const cat = (await s.get('/api/staff/state')).json.menu.categoryList.find((c) => c.name === '새분류'); return [`/api/staff/menu/categories/${cat.id}`, { name: '이름바꿈' }]; }
      if (spec === 'delete-cat') { const cat = (await s.post('/api/staff/menu/categories', { name: '빈분류' })).json.category; return [`/api/staff/menu/categories/${cat.id}/delete`, {}]; }
      if (spec === 'delete-reward') { const rw = (await s.post('/api/staff/rewards', { label: '지울보상', game: 'pour', threshold: 10, type: 'item', stock: 1 })).json.reward; return [`/api/staff/rewards/${rw.id}/delete`, {}]; }
      if (spec === 'reset') return ['/api/staff/reset', { confirm: '초기화' }];
      if (spec === 'day-close') return ['/api/staff/day/close', { confirm: '마감', force: true }];
      throw new Error(key);
    };
    const missing = [];
    for (const [key, spec] of Object.entries(calls)) {
      if (spec === null) continue;
      const [p, body] = typeof spec === 'string' ? await stateful(key, spec) : spec;
      const before = await count();
      const res = await s.post(p, body);
      if (res.status !== 200 && res.status !== 201) { missing.push(`${p} -> ${res.status} ${res.text.slice(0, 80)}`); continue; }
      if ((await count()) <= before) missing.push(`${p}: no audit row`);
    }
    assert.deepEqual(missing, []);
    // before -> after values, no secrets
    const entries = (await s.get('/api/staff/audit?limit=200')).json.entries;
    const text = JSON.stringify(entries);
    const find = (a) => entries.find((e) => e.action === a);
    assert.match(find('deposit_auto_setting').summary, /autoConfirm true→true.*max 30000→20000|max 30000→20000/);
    assert.match(find('ordering').summary, /true→false/);
    assert.match(find('table_count').summary, /→30/);
    assert.match(find('wait_timeout').summary, /5→7 min/);
    assert.match(find('notice').summary, /\(none\) → warn: 감사 공지/);
    assert.ok(!text.includes((await s.get('/api/staff/deposit-hook')).json.secret) && !text.includes(pay.account || 'no-account') && !text.includes(PIN));
    for (const token of tk.slice(0, 5)) assert.ok(!text.includes(token));
  });
});

test('R2-12 CSV cells that start with = + - @ are neutralised', async () => {
  await withBooth(async ({ srv, s }) => {
    const id = await mkItem(s, '=1+1', 1000);
    const o = (await staffOrder(s, 1, [{ id, qty: 1 }])).json.order;
    assert.ok(o.id);
    const csv = await csvOf(srv, s, '/api/staff/sales.csv');
    assert.ok(csv.text.includes("'=1+1,1,0,1000") && !/^=1\+1/m.test(csv.text), csv.text);
  });
});

test('R2-14 self-heal: a paid order with nothing received (older code wrote it) gets paid_amount = total on boot', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-r2h-'));
  const srv = await boot({ dir });
  let srv2;
  try {
    const s = await staffLogin(srv);
    const o = (await staffOrder(s, 1, [{ id: 'tteokbokki', qty: 1 }])).json.order;
    await srv.stop({ keep: true });
    const db = dbOf(srv); db.prepare('UPDATE orders SET paid=1, paid_amount=0, paid_method=NULL, paid_at=NULL WHERE id=?').run(o.id); db.close();
    srv2 = await boot({ dir });
    const s2 = await staffLogin(srv2);
    const h = await orderOf(s2, o.id);
    assert.deepEqual([h.paid, h.paidAmount, h.balanceDue], [true, 8000, 0]);
    assert.equal((await s2.get('/api/staff/sales')).json.totals.revenue, 8000);
  } finally { if (srv2) await srv2.stop(); else fs.rmSync(dir, { recursive: true, force: true }); }
});

test('R2-18 a guest depositor change moves updatedAt forward', async () => {
  await withBooth(async ({ srv, s, tk }) => {
    const g = new Client(srv);
    const o = (await order(g, tk[0], [{ id: 'cola', qty: 1 }])).json.order;
    let last = o.updatedAt;
    for (const name of ['가나', '다라', '마바']) {
      const r = await g.post(`/api/t/${tk[0]}/orders/${o.id}/depositor`, { depositor: name });
      assert.equal(r.status, 200, r.text);
      assert.ok(r.json.order.updatedAt > last, 'strictly increasing');
      last = r.json.order.updatedAt;
    }
  });
});

test('R2-19 an item that ran out by count stays sold out after reset / day close', async () => {
  await withBooth(async ({ srv, s, tk }) => {
    await s.post('/api/staff/menu/items/cola', { stockLeft: 1 });
    await order(new Client(srv), tk[0], [{ id: 'cola', qty: 1 }]);
    assert.equal((await s.get('/api/staff/state')).json.menu.items.find((i) => i.id === 'cola').soldOut, true);
    await s.post('/api/staff/reset', { confirm: '초기화' });
    const it = (await s.get('/api/staff/state')).json.menu.items.find((i) => i.id === 'cola');
    assert.deepEqual([it.stockLeft, it.soldOut, it.stockAuto], [0, true, true], 'orderable-with-0 state is avoided; raising the stock lifts it');
    await s.post('/api/staff/menu/items/cola', { stockLeft: 5 });
    assert.equal((await s.get('/api/staff/state')).json.menu.items.find((i) => i.id === 'cola').soldOut, false);
  });
});

test('R2-20 audit query parameters are validated', async () => {
  await withBooth(async ({ s }) => {
    for (const q of ['before=abc', 'limit=1.5', 'limit=', 'before=-1', 'limit=x']) assert.equal((await s.get(`/api/staff/audit?${q}`)).json.error, 'bad_query', q);
    assert.equal((await s.get('/api/staff/audit?before=5&limit=3')).status, 200);
  });
});


// ---------------- Release 2, second review ----------------
test('R3-1 refund done is bound to the amount staff saw: a concurrent edit that changed it gives 409 refund_changed', async () => {
  await withBooth(async ({ s }) => {
    const o = (await staffOrder(s, 1, [{ id: 'tteokbokki', qty: 1 }, { id: 'cola', qty: 1 }])).json.order; // 10,000
    await s.post(`/api/staff/orders/${o.id}/paid`, { paid: true });
    await s.post(`/api/staff/orders/${o.id}/items`, { items: [{ id: 'tteokbokki', qty: 1 }] }); // refund entry 2,000: staff A hands 2,000 back
    const seen = (await s.get('/api/staff/state')).json.refunds[0];
    assert.equal(seen.amount, 2000);
    assert.equal((await s.post(`/api/staff/refunds/${seen.id}/done`, {})).json.error, 'bad_amount', 'amount is required');
    assert.equal((await s.post(`/api/staff/refunds/${seen.id}/done`, { amount: 2000.5 })).json.error, 'bad_amount');
    const cheap = await mkItem(s, '오백원', 500);
    await s.post(`/api/staff/orders/${o.id}/items`, { items: [{ id: 'tteokbokki', qty: 1 }, { id: cheap, qty: 3 }] }); // staff B makes it 9,500: the entry is trimmed to 500
    assert.equal((await s.get('/api/staff/state')).json.refunds.find((r) => r.id === seen.id).amount, 500);
    const r = await s.post(`/api/staff/refunds/${seen.id}/done`, { amount: 2000 }); // A confirms what A saw
    assert.deepEqual([r.status, r.json.error, r.json.refund.amount, r.json.refund.id], [409, 'refund_changed', 500, seen.id]);
    assert.equal((await s.get('/api/staff/sales')).json.totals.refundsDone, 0, 'nothing was recorded');
    assert.equal((await s.post(`/api/staff/refunds/${seen.id}/done`, { amount: 500 })).status, 200);
    const d = (await s.get('/api/staff/sales')).json.totals;
    assert.deepEqual([d.refundsDone, d.refundDue], [500, 0]);
  });
});

async function healCase(mutate, { items = [{ id: 'tteokbokki', qty: 1 }], setup } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-heal-'));
  const servers = [];
  const cleanup = async () => { for (const x of servers) if (x.child.exitCode === null) await x.stop({ keep: true }); fs.rmSync(dir, { recursive: true, force: true }); };
  try {
    const srv = await boot({ dir }); servers.push(srv);
    const s = await staffLogin(srv);
    const o = (await staffOrder(s, 1, items)).json.order;
    if (setup) await setup(s, o);
    await srv.stop({ keep: true });
    const db = dbOf(srv); mutate(db, o.id); db.close(); // what Release 1 code writes: flags only
    const srv2 = await boot({ dir }); servers.push(srv2);
    const s2 = await staffLogin(srv2);
    const again = async () => { await srv2.stop({ keep: true }); const srv3 = await boot({ dir }); servers.push(srv3); const s3 = await staffLogin(srv3); return { s: s3, state: (await s3.get('/api/staff/state')).json, audit: await auditOf(s3) }; };
    return { s: s2, o, order: await orderOf(s2, o.id), state: (await s2.get('/api/staff/state')).json, audit: await auditOf(s2), again, cleanup };
  } catch (e) { await cleanup(); throw e; }
}

test('R3-2a self-heal: Release 1 marks a partly paid order paid -> the missing money is recorded (flag trusted), ledger adds up', async () => {
  const result = await healCase((db, id) => db.prepare('UPDATE orders SET paid=1 WHERE id=?').run(id), {
    items: [{ id: 'tteokbokki', qty: 1 }], setup: async (s, o) => { await s.post(`/api/staff/orders/${o.id}/paid`, { paid: true, method: 'cash', amount: 3000 }); } });
  try {
    const { order, s } = result;
    assert.deepEqual([order.paid, order.paidAmount, order.balanceDue, order.refundDue], [true, 8000, 0, 0], 'the 5,000 R1 marked as paid is now recorded');
    const sale = (await s.get('/api/staff/sales')).json;
    assert.deepEqual([sale.totals.revenue, sale.byMethod.cash.received, sale.byMethod.other.received], [8000, 3000, 5000]);
    assert.ok(result.audit.some((e) => e.action === 'migrated' && /1차 버전/.test(e.summaryKo)));
    const second = await result.again();
    assert.equal(second.audit.filter((e) => e.action === 'migrated').length, 1, 'idempotent: no second migration row');
    assert.equal((await orderOf(second.s, result.o.id)).paidAmount, 8000);
  } finally { await result.cleanup(); }
});

test('R3-2b self-heal: Release 1 unpays a fully paid order -> paid_amount reset, the order can be settled again', async () => {
  const result = await healCase((db, id) => db.prepare('UPDATE orders SET paid=0 WHERE id=?').run(id), {
    items: [{ id: 'tteokbokki', qty: 1 }, { id: 'cola', qty: 1 }], setup: async (s, o) => { await s.post(`/api/staff/orders/${o.id}/paid`, { paid: true }); } }); // 10,000
  try {
    const { order, s, o } = result;
    assert.deepEqual([order.paid, order.paidAmount, order.balanceDue, order.paidMethod], [false, 0, 10000, null]);
    assert.equal((await s.get('/api/staff/sales')).json.totals.revenue, 0);
    const done = (await s.post(`/api/staff/orders/${o.id}/paid`, { paid: true })).json.order; // bare call settles the full amount
    assert.deepEqual([done.paid, done.paidAmount], [true, 10000]);
  } finally { await result.cleanup(); }
});

test('R3-2c self-heal: Release 1 pays then cancels -> the money is owed back (refund entry dated with the cancellation)', async () => {
  const result = await healCase((db, id) => db.prepare("UPDATE orders SET paid=1, status='cancelled', paid_amount=0, paid_method=NULL, updated_at=updated_at-120000 WHERE id=?").run(id), {
    items: [{ id: 'tteokbokki', qty: 1 }] });
  try {
    const { order, state } = result;
    assert.deepEqual([order.status, order.paidAmount, order.refundDue], ['cancelled', 8000, 8000]);
    assert.deepEqual(state.refunds.map((r) => [r.orderId, r.amount, r.reason]), [[order.id, 8000, 'legacy_cancelled']]);
    assert.ok(state.refunds[0].createdAt <= order.updatedAt && state.refunds[0].createdAt < Date.now() - 60000, 'dated with the order, not with the boot');
    const sale = (await result.s.get('/api/staff/sales')).json;
    assert.deepEqual([sale.totals.revenue, sale.totals.refundDue, sale.byMethod.other.net], [8000, 8000, 8000]);
    const second = await result.again();
    assert.equal(second.state.refunds.length, 1, 'idempotent: no second entry');
    assert.equal(second.audit.filter((e) => e.action === 'migrated').length, 1);
  } finally { await result.cleanup(); }
});

test('R3-3 board and wait payloads carry the staff notice; wait status exposes noshow and whether a recall is still possible', async () => {
  await withBooth(async ({ srv, s }) => {
    await s.post('/api/staff/notice', { text: '전광판 공지', level: 'warn' });
    const g = new Client(srv);
    assert.deepEqual((await g.get('/api/board')).json.notice, { text: '전광판 공지', level: 'warn' });
    const sse = await openSse(srv, '/api/board/events');
    try { const buf = await sse.until((b) => b.includes('event: state')); assert.ok(buf.includes('"notice":{"text":"전광판 공지","level":"warn"}'), buf); } finally { sse.close(); }
    await s.post('/api/staff/notice', { text: '' });
    assert.equal((await g.get('/api/board')).json.notice, null);
    const w = (await g.post('/api/wait', { nick: '손님', size: 1 })).json;
    const st = async () => (await g.get(`/api/wait/${w.id}?secret=${w.secret}`)).json;
    assert.equal((await st()).canRecall, false);
    await s.post(`/api/staff/wait/${w.id}/call`, {});
    const db = dbOf(srv);
    db.prepare('UPDATE waitlist SET called_at=called_at-?').run(10 * 60000);
    let x = await st();
    assert.deepEqual([x.status, x.canRecall], ['noshow', true]);
    await s.post(`/api/staff/wait/${w.id}/recall`, {});
    x = await st();
    assert.deepEqual([x.status, x.canRecall], ['called', false]);
    db.prepare('UPDATE waitlist SET called_at=called_at-?').run(10 * 60000);
    x = await st();
    assert.deepEqual([x.status, x.canRecall], ['noshow', false], 'recalled once already');
    db.close();
  });
});

test('R3-4 sales by method: received / refunded / net / count per method, in the summary, the day report and the CSV; net sums to revenue', async () => {
  await withBooth(async ({ srv, s }) => {
    const o = (await staffOrder(s, 1, [{ id: 'tteokbokki', qty: 1 }])).json.order; // 8,000
    await s.post(`/api/staff/orders/${o.id}/paid`, { paid: true, method: 'cash', amount: 3000 });
    await s.post(`/api/staff/orders/${o.id}/paid`, { paid: true, method: 'transfer' }); // 5,000
    const c = (await staffOrder(s, 2, [{ id: 'cola', qty: 1 }])).json.order; // 2,000 paid 5,000 cash -> 3,000 refund
    await s.post(`/api/staff/orders/${c.id}/paid`, { paid: true, method: 'cash', amount: 5000 });
    const rf = (await s.get('/api/staff/state')).json.refunds[0];
    const done = await s.post(`/api/staff/refunds/${rf.id}/done`, { amount: rf.amount, method: 'transfer' }); // refunded by bank transfer
    assert.equal(done.json.refund.method, 'transfer');
    const sale = (await s.get('/api/staff/sales')).json;
    assert.deepEqual(sale.byMethod, { transfer: { received: 5000, refunded: 3000, net: 2000, count: 1 }, cash: { received: 8000, refunded: 0, net: 8000, count: 2 }, other: { received: 0, refunded: 0, net: 0, count: 0 } });
    assert.equal(Object.values(sale.byMethod).reduce((n, m) => n + m.net, 0), sale.totals.revenue);
    const csv = await csvOf(srv, s, '/api/staff/sales.csv');
    assert.ok(csv.text.includes('[결제수단별]') && csv.text.includes('현금,8000,0,8000,2') && csv.text.includes('계좌이체,5000,3000,2000,1'), csv.text);
    await s.post('/api/staff/orders/' + o.id + '/status', { status: 'served' });
    assert.equal((await s.post('/api/staff/day/close', { confirm: '마감', force: true })).status, 200);
    const rep = (await s.get('/api/staff/day/reports/1')).json;
    assert.deepEqual(rep.byMethod, sale.byMethod);
    assert.ok((await csvOf(srv, s, '/api/staff/day/reports/1.csv')).text.includes('[결제수단별]'));
    assert.equal((await s.get('/api/staff/sales')).json.byMethod.cash.received, 0, 'the new day starts empty');
    // undoing a payment removes it from the ledger
    const d = (await staffOrder(s, 1, [{ id: 'cola', qty: 1 }])).json.order;
    await s.post(`/api/staff/orders/${d.id}/paid`, { paid: true, method: 'other' });
    await s.post(`/api/staff/orders/${d.id}/paid`, { paid: false });
    assert.deepEqual((await s.get('/api/staff/sales')).json.byMethod.other, { received: 0, refunded: 0, net: 0, count: 0 });
  });
});

test('R3-5 dryRun previews exactly what the real call returns and writes nothing (state, audit and stock byte-identical)', async () => {
  await withBooth(async ({ s }) => {
    const it = await mkItem(s, '한정', 3000);
    await s.post(`/api/staff/menu/items/${it}`, { stockLeft: 5 });
    const o = (await staffOrder(s, 1, [{ id: 'tteokbokki', qty: 2 }])).json.order; // 16,000
    await s.post(`/api/staff/orders/${o.id}/paid`, { paid: true });
    const snap = async () => JSON.stringify([(await s.get('/api/staff/state')).json, (await s.get('/api/staff/audit?limit=200')).json.entries.map((e) => e.id), (await s.get('/api/staff/sales')).json]);
    const strip = (x) => JSON.parse(JSON.stringify(x, (k, v) => (['updatedAt', 'createdAt', 'paidAt', 'cookingAt'].includes(k) ? undefined : v)));
    const cases = [
      [`/api/staff/orders/${o.id}/items`, { items: [{ id: 'tteokbokki', qty: 1 }, { id: it, qty: 2 }] }], // lower total? 8,000 + 6,000 = 14,000 -> refund 2,000
      [`/api/staff/orders/${o.id}/service`, { itemId: it, qty: 1 }],
      [`/api/staff/orders/${o.id}/paid`, { paid: true, method: 'cash', amount: 1000 }],
      [`/api/staff/orders/${o.id}/paid`, { paid: false }],
      ['/api/staff/tables/2/orders', { key: newKey(), items: [{ id: it, qty: 2 }], accept: true }],
    ];
    for (const [p, body] of cases) {
      const before = await snap();
      const pre = await s.post(p, { ...body, dryRun: true });
      assert.ok(pre.status < 300, pre.text);
      assert.equal(pre.json.dryRun, true, p);
      assert.equal(await snap(), before, `${p}: nothing changed (state, audit, stock, sales)`);
      const real = await s.post(p, body);
      assert.ok(real.status < 300, real.text);
      assert.deepEqual(strip(pre.json.order), strip(real.json.order), `${p}: the preview is what the real call returned`);
    }
    // stock problems show up in the preview like in the real call, and still write nothing
    await s.post(`/api/staff/menu/items/${it}`, { stockLeft: 2 });
    const before = await snap();
    const bad = await s.post(`/api/staff/orders/${o.id}/service`, { itemId: it, qty: 5, dryRun: true });
    assert.deepEqual([bad.status, bad.json.error], [409, 'insufficient_stock']);
    assert.equal(await snap(), before);
    // a dry run honours the same validation and staleness rules
    assert.equal((await s.post(`/api/staff/orders/${o.id}/items`, { items: [], dryRun: true })).json.error, 'no_lines');
    assert.equal((await s.post(`/api/staff/orders/${o.id}/items`, { items: [{ id: 'cola', qty: 1 }], dryRun: true, expectedUpdatedAt: 1 })).json.error, 'stale');
    assert.equal(await snap(), before);
    // only a literal true is a dry run
    const real = await s.post(`/api/staff/orders/${o.id}/service`, { itemId: 'cola', qty: 1, dryRun: 'true' });
    assert.equal(real.json.dryRun, undefined);
  });
});

test('R3-6 every audit row has a Korean sentence (summaryKo), never a secret; examples', async () => {
  await withBooth(async ({ srv, s }) => {
    const o = (await staffOrder(s, 3, [{ id: 'tteokbokki', qty: 1 }])).json.order;
    await s.post(`/api/staff/orders/${o.id}/paid`, { paid: true, method: 'cash', amount: 5000 });
    await s.post('/api/staff/tables/3/clear', { force: true });
    await s.post('/api/staff/menu/cola/soldout', { soldOut: true });
    await s.post('/api/staff/notice', { text: '곧 마감' });
    const entries = await auditOf(s);
    assert.ok(entries.length >= 5);
    for (const e of entries) assert.ok(typeof e.summaryKo === 'string' && /[가-힣]/.test(e.summaryKo), `${e.action}: ${e.summaryKo}`);
    const ko = Object.fromEntries(entries.map((e) => [e.action + (e.action === 'staff_action' ? ':' + e.target : ''), e.summaryKo]));
    assert.equal(ko.order_paid, `주문 #${o.id} 입금 확인 · 현금 5,000원 · 잔액 3,000원`);
    assert.equal(ko.table_clear, '3번 테이블 강제 정리 · 미수금 1건 3,000원');
    assert.equal(ko['staff_action:/api/staff/menu/cola/soldout'], '메뉴 품절 표시');
    assert.match(ko.notice, /공지 변경 · “곧 마감”/);
    assert.ok(entries.every((e) => e.summary !== undefined && e.target !== undefined && e.at), 'machine fields are still there');
    const text = JSON.stringify(entries);
    assert.ok(!text.includes((await s.get('/api/staff/deposit-hook')).json.secret) && !text.includes(PIN));
    void srv;
  });
});

test('R3-7 sales unpaid / written-off rows and refund rows carry the order updatedAt (for expectedUpdatedAt)', async () => {
  await withBooth(async ({ s }) => {
    const a = (await staffOrder(s, 1, [{ id: 'tteokbokki', qty: 1 }])).json.order; // unpaid, stays open
    const b = (await staffOrder(s, 2, [{ id: 'odeng', qty: 1 }])).json.order; // written off
    const c = (await staffOrder(s, 3, [{ id: 'cola', qty: 1 }])).json.order; // cancelled after payment
    await s.post(`/api/staff/orders/${c.id}/paid`, { paid: true });
    await s.post('/api/staff/tables/2/clear', { force: true });
    const cx = (await s.post(`/api/staff/orders/${c.id}/status`, { status: 'cancelled' })).json.order;
    const sale = (await s.get('/api/staff/sales')).json;
    assert.equal(sale.unpaid.find((x) => x.orderId === a.id).updatedAt, (await orderOf(s, a.id)).updatedAt);
    assert.equal(typeof sale.writtenOff.find((x) => x.orderId === b.id).updatedAt, 'number');
    assert.equal(sale.refunds.find((x) => x.orderId === c.id).updatedAt, cx.updatedAt);
    const st = (await s.get('/api/staff/state')).json.refunds.find((x) => x.orderId === c.id);
    assert.equal(st.updatedAt, cx.updatedAt);
    // a stale-guarded late payment of the written-off order works with that value
    const late = await s.post(`/api/staff/orders/${b.id}/paid`, { paid: true, expectedUpdatedAt: sale.writtenOff[0].updatedAt });
    assert.equal(late.status, 200, late.text);
    assert.equal((await s.post(`/api/staff/orders/${b.id}/paid`, { paid: true, amount: 100, expectedUpdatedAt: sale.writtenOff[0].updatedAt })).json.error, 'stale');
  });
});

test('R3-8 deposits payload is bounded: state has counts + the newest 50 open notices, candidates capped at 10, /deposits paginates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-dep-big-'));
  const store = createStore({ dataDir: dir, menu: MENU, rewards: REWARDS, tableCount: 4 });
  try {
    for (let i = 0; i < 190; i++) store.createOrder(1 + (i % 4), { key: `big-order-${i}`.padEnd(12, 'x'), items: [{ id: 'tteokbokki', qty: 1 }], depositor: `이름${i % 90}` }, { staff: {} }); // 190 unpaid orders, all 8,000
    for (let i = 0; i < 200; i++) store.ingestDeposit(`[Web발신]\n신한11/13 21:03\n110-***-123456\n입금 8,000\n잔액 1,234,${String(i).padStart(3, '0')}\n 가나${String.fromCharCode(0xac00 + i)}`);
    const state = store.staffState();
    assert.ok(state.depositNotices.length <= 50);
    assert.equal(state.deposit.pending, 200);
    const worst = store.listDeposits({ limit: 200 });
    for (const n of [...state.depositNotices, ...worst.notices]) assert.ok(n.candidates.length <= 10 && n.handledOrders.length <= 10);
    assert.equal(worst.notices[0].candidateCount, 190);
    assert.ok(state.depositNotices.every((n) => n.candidateCount === 190));
    const stateBytes = JSON.stringify(state).length; const listBytes = JSON.stringify(worst).length;
    assert.ok(stateBytes < 700000 && listBytes < 700000, `state ${stateBytes} B, list ${listBytes} B`);
    assert.equal(store.listDeposits({ before: worst.notices[199].id }).notices.length, 0, 'nothing after the last page');
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('R3-8b GET /api/staff/deposits paginates with before/limit and validates them', async () => {
  const d = await depositSetup();
  try {
    for (let i = 0; i < 7; i++) await d.sms(1000 + i * 100, `이름${i}`);
    const p1 = (await d.s.get('/api/staff/deposits?limit=3')).json;
    assert.equal(p1.notices.length, 3); assert.equal(p1.next, p1.notices[2].id);
    const p2 = (await d.s.get(`/api/staff/deposits?limit=3&before=${p1.next}`)).json;
    assert.ok(p2.notices.every((n) => n.id < p1.next) && p2.notices.length === 3);
    const p3 = (await d.s.get(`/api/staff/deposits?limit=3&before=${p2.next}`)).json;
    assert.deepEqual([p3.notices.length, p3.next], [1, null]);
    for (const q of ['before=x', 'limit=1.5', 'limit=', 'before=-1']) assert.equal((await d.s.get(`/api/staff/deposits?${q}`)).json.error, 'bad_query', q);
    assert.equal((await d.s.get('/api/staff/state')).json.depositNotices.length, 7);
  } finally { await d.srv.stop(); }
});

test('R3-9 a guest cannot cancel an order that is partly paid', async () => {
  await withBooth(async ({ srv, s, tk }) => {
    const g = new Client(srv);
    const o = (await order(g, tk[0], [{ id: 'tteokbokki', qty: 1 }])).json.order;
    await s.post(`/api/staff/orders/${o.id}/paid`, { paid: true, method: 'cash', amount: 3000 });
    const r = await g.post(`/api/t/${tk[0]}/orders/${o.id}/cancel`, {});
    assert.deepEqual([r.status, r.json.error], [409, 'not_cancellable']);
    assert.equal((await orderOf(s, o.id)).status, 'pending');
    assert.deepEqual((await s.get('/api/staff/state')).json.refunds, [], 'no refund was invented');
  });
});

test('R3-10 day close: unconfirmed deposit notices count as open items and are kept in the report', async () => {
  const d = await depositSetup();
  try {
    const { s, tk } = d;
    const o = await d.place(tk[0], '김철수');
    await s.post(`/api/staff/orders/${o.id}/paid`, { paid: true });
    await s.post(`/api/staff/orders/${o.id}/status`, { status: 'served' });
    await d.sms(12345, '아무개');
    const r = await s.post('/api/staff/day/close', { confirm: '마감' });
    assert.deepEqual([r.status, r.json.error, r.json.pendingNotices], [409, 'open_items', { count: 1, amount: 12345 }]);
    assert.equal((await s.post('/api/staff/day/close', { confirm: '마감', force: true })).status, 200);
    const rep = (await s.get('/api/staff/day/reports/1')).json;
    assert.deepEqual(rep.pendingNotices.map((n) => [n.amount, n.status]), [[12345, 'pending']]);
    assert.ok(!JSON.stringify(rep.pendingNotices).includes('Web발신'), 'no SMS text in the report');
    assert.ok((await csvOf(d.srv, s, '/api/staff/day/reports/1.csv')).text.includes('[미확인 입금 알림]'));
  } finally { await d.srv.stop(); }
});

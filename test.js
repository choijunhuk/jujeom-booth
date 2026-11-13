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

async function boot({ base = '', env = {}, dir, menu, menuRaw } = {}) {
  dir ||= fs.mkdtempSync(path.join(os.tmpdir(), 'booth-test-'));
  const cfg = path.join(dir, 'cfg');
  const pub = path.join(dir, 'pub');
  const data = path.join(dir, 'data');
  if (!fs.existsSync(cfg)) {
    fs.mkdirSync(cfg); fs.mkdirSync(pub);
    fs.writeFileSync(path.join(cfg, 'menu.json'), menuRaw ?? JSON.stringify(menu || MENU));
    fs.writeFileSync(path.join(cfg, 'rewards.json'), JSON.stringify(REWARDS));
    fs.writeFileSync(path.join(cfg, 'tables.json'), JSON.stringify({ count: 40 }));
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
  const req = http.request({ host: '127.0.0.1', port: srv.port, method, path: p, headers }, (res) => {
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
    hits.push({ method: req.method, url: req.url, headers: req.headers, tok });
    const spec = specs.get(tok) || { status: 401 };
    const send = () => {
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
  assert.deepEqual((await g.get(`/api/t/${tok(1)}`)).json.pay, { bank: '', account: '', holder: '' });
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
    assert.deepEqual((await a.get('/api/wait/info')).json, { open: true, waitingTotal: 2 });
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
    assert.deepEqual((await g.get(`/api/t/${tok(23)}/member`)).json, { enabled: true, member: true, pct: 0 });
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
    assert.deepEqual((await g.get(`/api/t/${T}/member`)).json, { enabled: true, member: false, pct: 10 }, name);
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
  assert.ok(took >= 1800 && took < 3300, `took ${took} ms`);
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
    assert.deepEqual((await g.get(`/api/t/${T}/member`)).json, { enabled: false, member: false, pct: 10 });
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

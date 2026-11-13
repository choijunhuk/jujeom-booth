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

async function boot({ base = '', env = {}, dir } = {}) {
  dir ||= fs.mkdtempSync(path.join(os.tmpdir(), 'booth-test-'));
  const cfg = path.join(dir, 'cfg');
  const pub = path.join(dir, 'pub');
  const data = path.join(dir, 'data');
  if (!fs.existsSync(cfg)) {
    fs.mkdirSync(cfg); fs.mkdirSync(pub);
    fs.writeFileSync(path.join(cfg, 'menu.json'), JSON.stringify(MENU));
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
    origin: `http://127.0.0.1:${port}`, base, port, dir, data, child,
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

let main; let staff; let tokens;
const tok = (n) => tokens[n - 1].token;
const guest = () => new Client(main);
before(async () => {
  main = await boot();
  staff = await staffLogin(main);
  tokens = (await staff.get('/api/staff/tables')).json.tables;
});
after(() => main.stop());

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
  assert.match(g.setCookies[0], /^booth_d=[a-f0-9]{32}; Path=\/; HttpOnly; SameSite=Lax/);
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
    for (let i = 0; i < 13; i++) streams.push(await openSse(main, `/api/t/${T2}/events`, { cookie: `booth_d=${crypto.randomBytes(16).toString('hex')}` }));
    await assert.rejects(streams[0].until(() => false, 2000), /closed/);
    await streams[12].until((b) => b.includes('event: state'));
  } finally { streams.forEach((x) => x.close()); }
  const srv = await boot({ env: { SSE_PUBLIC_MAX: '6' } });
  const open = [];
  try {
    const s = await staffLogin(srv);
    const tk = (await s.get('/api/staff/tables')).json.tables;
    for (let i = 0; i < 6; i++) open.push(await openSse(srv, `/api/t/${tk[i].token}/events`, { cookie: `booth_d=${crypto.randomBytes(16).toString('hex')}` }));
    const r = await fetch(srv.origin + `/api/t/${tk[7].token}/events`, { headers: { cookie: `booth_d=${crypto.randomBytes(16).toString('hex')}` } });
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
  const dev = crypto.randomBytes(16).toString('hex');
  const get = (cookie) => raw(main, 'GET', '/api/staff/me', { cookie });
  assert.equal((await get(`booth_s=stale; booth_s=${valid}`)).status, 200);
  assert.equal((await get(`booth_s=${valid}; booth_s=stale`)).status, 200);
  assert.equal((await get('booth_s=stale; booth_s=also-stale')).status, 401);
  // device id: first well-formed value wins, malformed ones are skipped
  const g = await raw(main, 'GET', `/api/t/${tok(36)}`, { cookie: `booth_d=junk; booth_d=${dev}` });
  assert.equal(g.status, 200);
  assert.equal(g.headers['set-cookie'], undefined); // no new device cookie was issued
  assert.equal((await raw(main, 'GET', `/api/t/${tok(36)}`, { cookie: 'booth_d=junk' })).headers['set-cookie'].length, 1);
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

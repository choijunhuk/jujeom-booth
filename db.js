'use strict';
// Schema + all domain logic. Everything is synchronous (node:sqlite) in a single process,
// so check-then-write sequences inside one function cannot interleave with other requests.
// ponytail: correctness of "stock never negative" additionally uses a guarded UPDATE, so it
// would still hold if this ever ran multi-process; the other check-then-insert rules would not.
const { DatabaseSync, backup: sqliteBackup } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}
const fail = (status, code, message, extra) => { throw new HttpError(status, code, message, extra); };

const HOUR = 3600000;
const MAX_PLAY_MS = 10 * 60 * 1000;
const PLAY_GAP_MS = 3000;
const MAX_PLAYS_PER_DEVICE = 200;
const MAX_PENDING_PER_TABLE = 10;
const MAX_ORDERS_PER_SEAT = 40; // including cancelled
const MAX_WAIT_PER_MIN = 30;
const MAX_NICKS_PER_SEAT = 30;
const MAX_CALLS_PER_SEAT = 50; // including resolved
const MEMO_MS = 1500;
const MENU_MAX_ITEMS = 100;
const MENU_MAX_CATEGORIES = 12;
const WAIT_KEEP_MS = 3 * HOUR;
const CALL_TYPES = ['물', '수저', '치워주세요', '기타'];
const ORDER_STATUSES = ['pending', 'cooking', 'served', 'cancelled'];
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I, O, 0, 1
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\u115F\u1160\u3164\uFFA0\u2800\u17B4\u17B5\u180E]/gu;
const NICK_BLOCK_RAW = [
  '시발', '씨발', '씨팔', '시팔', 'ㅅㅂ', 'ㅆㅂ', '병신', 'ㅂㅅ', '좆', '존나', '지랄', '개새끼', '새끼', '미친놈', '미친년',
  '썅', '섹스', '자지', '보지', '창녀', '느금', '니애미', '걸레',
  'fuck', 'shit', 'bitch', 'asshole', 'dick', 'cunt', 'nigg', 'porn', 'sex', 'whore', 'slut', 'faggot',
]; // ponytail: substring match on a tiny list; extend the list (or use a real filter) if abused

const NICK_BLOCK = NICK_BLOCK_RAW.map((w) => w.normalize('NFKC'));

const SCHEMA = `
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

function createStore({ dataDir, menu, rewards, tableCount, limits = {}, maxDbBytes = 256 * 1024 * 1024, backupSkipBytes = 128 * 1024 * 1024, memberEnabled = false }) {
  const L = { seatPlayGapMs: 1000, seatPlayMax: 300, seatOpenMax: 20, memberOrderMax: 20, ...limits };
  const waitTimes = []; // ponytail: in-memory insert times for the global wait-list rate cap (resets on restart)
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'booth.db'));
  db.exec(SCHEMA);
  // migrations for databases created by older code (CREATE TABLE IF NOT EXISTS does not touch existing tables)
  const colsOf = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  if (!colsOf('orders').includes('member_discount')) db.exec('ALTER TABLE orders ADD COLUMN member_discount INTEGER NOT NULL DEFAULT 0');
  if (!colsOf('orders').includes('member_id')) db.exec('ALTER TABLE orders ADD COLUMN member_id INTEGER');
  db.exec('CREATE INDEX IF NOT EXISTS orders_member ON orders(member_id)');
  // hard ceiling on the file size: writes beyond it fail with SQLITE_FULL (server maps that to 503 storage_full)
  db.exec(`PRAGMA max_page_count=${Math.max(1, Math.floor(maxDbBytes / db.prepare('PRAGMA page_size').get().page_size))}`);
  const dbFile = path.join(dataDir, 'booth.db');
  let skipLogged = false;
  const memo = { board: null, boardAt: 0, hours: new Map() }; // short-lived read cache; every write path that changes it calls invalidate()
  const invalidate = () => { memo.board = null; memo.hours.clear(); };
  const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
  const cache = new Map();
  const st = (sql) => { let s = cache.get(sql); if (!s) cache.set(sql, s = db.prepare(sql)); return s; };
  const get = (sql, ...p) => st(sql).get(...p);
  const all = (sql, ...p) => st(sql).all(...p);
  const run = (sql, ...p) => st(sql).run(...p);
  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
  };
  const now = () => Date.now();
  const ph = (n) => Array.from({ length: n }, () => '?').join(',');

  // The menu lives in the DB. menu.json only seeds an empty menu (first boot, or an older DB without menu tables) and is never re-read.
  // "seeded" is remembered in settings: once set, the menu is never re-seeded, even if staff later delete every item and category.
  // (A DB whose menu tables are already filled but has no flag yet just gets the flag.)
  const menuEmpty = !get('SELECT 1 FROM menu_categories LIMIT 1') && !get('SELECT 1 FROM menu_items LIMIT 1');
  const seedProblem = () => {
    if (!menu || !Array.isArray(menu.items) || !Array.isArray(menu.categories || [])) return 'menu.json must have "items" (array) and "categories" (array)';
    if (menu.items.length > MENU_MAX_ITEMS) return `more than ${MENU_MAX_ITEMS} items`;
    if ((menu.categories || []).length > MENU_MAX_CATEGORIES) return `more than ${MENU_MAX_CATEGORIES} categories`;
    const key = (x) => String(x).normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
    const cats = new Set();
    for (const c of menu.categories || []) {
      if (typeof c !== 'string' || !c.trim() || [...c.trim()].length > 12) return `bad category ${JSON.stringify(c)}`;
      if (cats.has(key(c))) return `duplicate category ${JSON.stringify(c)}`;
      cats.add(key(c));
    }
    const ids = new Set(); const names = new Set();
    for (const i of menu.items) {
      if (!i || typeof i.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(i.id) || ids.has(i.id)) return `bad or duplicate item id ${JSON.stringify(i && i.id)}`;
      ids.add(i.id);
      if (typeof i.name !== 'string' || !i.name.trim() || [...i.name.trim()].length > 30 || names.has(key(i.name))) return `bad or duplicate item name ${JSON.stringify(i.name)}`;
      names.add(key(i.name));
      if (!Number.isInteger(i.price) || i.price < 0 || i.price > 1000000 || i.price % 100 !== 0) return `bad price for ${JSON.stringify(i.name)} (integer, multiple of 100, 0..1000000)`;
      if (typeof i.cat !== 'string' || !cats.has(key(i.cat))) return `item ${JSON.stringify(i.name)} uses a category that is not in "categories"`;
      if (i.desc != null && (typeof i.desc !== 'string' || [...i.desc].length > 60)) return `bad desc for ${JSON.stringify(i.name)}`;
    }
    return null;
  };
  const problem = !get("SELECT 1 FROM settings WHERE k='menu_seeded'") && menuEmpty ? seedProblem() : null;
  if (problem) console.error(`menu.json is invalid: ${problem}. Starting with an EMPTY menu (add items as staff, or fix menu.json and restart: it will be seeded then).`);
  if (!get("SELECT 1 FROM settings WHERE k='menu_seeded'") && menuEmpty && !problem) {
    const legacySoldOut = get("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='sold_out'")
      ? new Set(all('SELECT item_id FROM sold_out').map((r) => r.item_id)) : new Set();
    tx(() => {
      const catId = new Map();
      const ensureCat = (name) => {
        if (!catId.has(name)) catId.set(name, Number(run('INSERT INTO menu_categories(name, sort) VALUES(?,?)', name, catId.size).lastInsertRowid));
        return catId.get(name);
      };
      for (const c of menu.categories || []) ensureCat(c);
      menu.items.forEach((i, idx) => {
        run('INSERT INTO menu_items(id,name,price,category_id,descr,sold_out,sort) VALUES(?,?,?,?,?,?,?)',
          i.id, i.name, i.price, ensureCat(i.cat), i.desc || '', legacySoldOut.has(i.id) ? 1 : 0, idx);
      });
    });
  }
  if (!get("SELECT 1 FROM settings WHERE k='menu_seeded'") && !problem) run("INSERT INTO settings(k,v) VALUES('menu_seeded','1')");
  const games = rewards.games;
  for (let i = 1; i <= tableCount; i++) {
    if (!get('SELECT 1 FROM tables WHERE id=?', i)) run('INSERT INTO tables(id, token) VALUES(?,?)', i, crypto.randomBytes(12).toString('base64url'));
  }
  for (const r of rewards.rewards) run('INSERT OR IGNORE INTO reward_stock(id, stock) VALUES(?,?)', r.id, r.stock);

  // ---------- helpers ----------
  const tableRow = (id) => get('SELECT * FROM tables WHERE id=? AND id<=?', id, tableCount) || fail(404, 'no_table', '알 수 없는 테이블입니다.');
  const setting = (k, def) => get('SELECT v FROM settings WHERE k=?', k)?.v ?? def;
  const orderingOpen = () => setting('ordering_open', '1') === '1';
  const kst = (ms) => new Date(ms + 9 * HOUR).toISOString().slice(0, 16).replace('T', ' '); // ponytail: fixed UTC+9

  function cleanNick(s) {
    if (typeof s !== 'string') fail(400, 'bad_nick', '닉네임을 입력해 주세요.');
    const t = s.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
    const norm = t.normalize('NFKC').replace(INVISIBLE, ''); // NFKC only for the checks; the stored nick keeps the typed form
    const len = [...t].length;
    if (len < 1 || len > 10 || !/[\p{L}\p{N}\p{S}\p{P}]/u.test(norm)) fail(400, 'bad_nick', '닉네임은 보이는 글자 1~10자로 입력해 주세요.');
    const flat = norm.toLowerCase().replace(/[^\p{L}]/gu, '');
    if (NICK_BLOCK.some((w) => flat.includes(w))) fail(400, 'bad_nick', '사용할 수 없는 닉네임입니다.');
    return t;
  }

  const couponOut = (c) => ({
    code: c.code, rewardId: c.reward_id, source: c.source, type: c.type, amount: c.amount, item: c.item, label: c.label,
    status: c.status, table: c.table_id, seat: c.seat, orderId: c.order_id, usedAt: c.used_at, createdAt: c.created_at,
  });

  function insertCoupon({ rewardId, source, type, amount = null, label, item = null, tableId, seat }) {
    for (let tries = 0; tries < 50; tries++) {
      let code = '';
      for (let i = 0; i < 6; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
      try {
        run('INSERT INTO coupons(code,reward_id,source,type,amount,label,item,table_id,seat,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
          code, rewardId, source, type, amount, label, item, tableId, seat, now());
        return couponOut(get('SELECT * FROM coupons WHERE code=?', code));
      } catch (e) { if (!/constraint/i.test(e.message)) throw e; }
    }
    throw new Error('coupon code space exhausted');
  }

  // ---------- menu / ordering ----------
  const itemRow = (id) => get('SELECT i.*, c.name cat FROM menu_items i JOIN menu_categories c ON c.id=i.category_id WHERE i.id=?', id);
  // guests get visible items only; admin=true (staff) also gets hidden ones plus ids/sort/usage
  function menuView(admin = false) {
    const cats = all('SELECT id, name, sort FROM menu_categories ORDER BY sort, id');
    const rows = all(`SELECT i.*, c.name cat${admin ? ', (SELECT COUNT(*) FROM order_items oi WHERE oi.item_id=i.id) used' : ''} FROM menu_items i JOIN menu_categories c ON c.id=i.category_id ORDER BY c.sort, c.id, i.sort, i.rowid`);
    const vis = admin ? rows : rows.filter((r) => !r.hidden);
    const out = {
      categories: (admin ? cats : cats.filter((c) => vis.some((r) => r.category_id === c.id))).map((c) => c.name),
      items: vis.map((r) => ({
        id: r.id, name: r.name, price: r.price, cat: r.cat, desc: r.descr, soldOut: !!r.sold_out,
        ...(admin ? { hidden: !!r.hidden, sortOrder: r.sort, categoryId: r.category_id, inUse: r.used > 0 } : {}),
      })),
    };
    if (admin) out.categoryList = cats.map((c) => ({ id: c.id, name: c.name, sortOrder: c.sort, itemCount: rows.filter((r) => r.category_id === c.id).length }));
    return out;
  }
  function setSoldOut(itemId, soldOut) {
    if (run('UPDATE menu_items SET sold_out=? WHERE id=?', soldOut ? 1 : 0, itemId).changes !== 1) fail(404, 'no_item', '없는 메뉴입니다.');
  }
  // names: control/invisible/filler characters stripped, at least one visible character required (same rule as nicknames)
  function cleanLabel(v, min, max, code, what) {
    if (typeof v !== 'string') fail(400, code, `${what}을(를) 입력해 주세요.`);
    const t = v.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
    const n = [...t].length;
    if (n < min || n > max || (min > 0 && !/[\p{L}\p{N}\p{S}\p{P}]/u.test(t.normalize('NFKC').replace(INVISIBLE, '')))) {
      fail(400, code, `${what}은(는) ${min === 0 ? '' : '보이는 글자 '}${min === 0 ? '' : min + '~'}${max}자로 입력해 주세요.`);
    }
    return t;
  }
  // uniqueness is decided on a normalised key: NFKC, collapsed whitespace, lower case ("Beer" = "beer" = fullwidth "Ｂｅｅｒ")
  const nameKey = (s) => s.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  const checkPrice = (p) => { if (!Number.isInteger(p) || p < 0 || p > 1000000 || p % 100 !== 0) fail(400, 'bad_price', '가격은 0~1,000,000원 사이 100원 단위여야 합니다.'); return p; };
  function categoryByName(name) {
    const key = nameKey(name);
    const hit = all('SELECT id, name FROM menu_categories').find((c) => nameKey(c.name) === key);
    if (hit) return hit.id;
    if (get('SELECT COUNT(*) n FROM menu_categories').n >= MENU_MAX_CATEGORIES) fail(409, 'too_many_categories', `카테고리는 ${MENU_MAX_CATEGORIES}개까지 만들 수 있습니다.`);
    return Number(run('INSERT INTO menu_categories(name, sort) VALUES(?, (SELECT COALESCE(MAX(sort), -1) + 1 FROM menu_categories))', name).lastInsertRowid);
  }
  const nameTaken = (name, exceptId = '') => { const k = nameKey(name); return all('SELECT id, name FROM menu_items').some((i) => i.id !== exceptId && nameKey(i.name) === k); };
  const categoryNameTaken = (name, exceptId = 0) => { const k = nameKey(name); return all('SELECT id, name FROM menu_categories').some((c) => c.id !== exceptId && nameKey(c.name) === k); };
  const adminItem = (id) => menuView(true).items.find((i) => i.id === id);

  function createItem(body) {
    const name = cleanLabel(body.name, 1, 30, 'bad_name', '메뉴 이름');
    const price = checkPrice(body.price);
    const descr = body.desc == null ? '' : cleanLabel(body.desc, 0, 60, 'bad_desc', '설명');
    const cat = cleanLabel(body.category, 1, 12, 'bad_category', '카테고리 이름');
    if (body.hidden != null && typeof body.hidden !== 'boolean') fail(400, 'bad_hidden', 'hidden은 true/false여야 합니다.');
    if (nameTaken(name)) fail(409, 'name_taken', '같은 이름의 메뉴가 이미 있습니다.');
    if (get('SELECT COUNT(*) n FROM menu_items').n >= MENU_MAX_ITEMS) fail(409, 'too_many_items', `메뉴는 ${MENU_MAX_ITEMS}개까지 만들 수 있습니다.`);
    const id = tx(() => {
      const nid = 'm' + crypto.randomBytes(5).toString('hex');
      run('INSERT INTO menu_items(id,name,price,category_id,descr,hidden,sort) VALUES(?,?,?,?,?,?,(SELECT COALESCE(MAX(sort), -1) + 1 FROM menu_items))', nid, name, price, categoryByName(cat), descr, body.hidden ? 1 : 0);
      return nid;
    });
    return adminItem(id);
  }
  function updateItem(id, body) {
    const cur = get('SELECT * FROM menu_items WHERE id=?', id) || fail(404, 'no_item', '없는 메뉴입니다.');
    const has = (k) => Object.hasOwn(body, k);
    if (!['name', 'price', 'category', 'desc', 'hidden', 'sortOrder'].some(has)) fail(400, 'nothing_to_update', '바꿀 항목이 없습니다.');
    const name = has('name') ? cleanLabel(body.name, 1, 30, 'bad_name', '메뉴 이름') : cur.name;
    const price = has('price') ? checkPrice(body.price) : cur.price;
    const descr = has('desc') ? cleanLabel(body.desc, 0, 60, 'bad_desc', '설명') : cur.descr;
    const cat = has('category') ? cleanLabel(body.category, 1, 12, 'bad_category', '카테고리 이름') : null;
    if (has('hidden') && typeof body.hidden !== 'boolean') fail(400, 'bad_hidden', 'hidden은 true/false여야 합니다.');
    if (has('sortOrder') && (!Number.isInteger(body.sortOrder) || body.sortOrder < 0 || body.sortOrder > 100000)) fail(400, 'bad_sort', 'sortOrder가 올바르지 않습니다.');
    if (nameTaken(name, id)) fail(409, 'name_taken', '같은 이름의 메뉴가 이미 있습니다.');
    tx(() => {
      run('UPDATE menu_items SET name=?, price=?, descr=?, category_id=?, hidden=?, sort=? WHERE id=?', name, price, descr, cat ? categoryByName(cat) : cur.category_id,
        has('hidden') ? (body.hidden ? 1 : 0) : cur.hidden, has('sortOrder') ? body.sortOrder : cur.sort, id);
    });
    return adminItem(id);
  }
  function deleteItem(id) {
    if (!get('SELECT 1 FROM menu_items WHERE id=?', id)) fail(404, 'no_item', '없는 메뉴입니다.');
    if (get('SELECT 1 FROM order_items WHERE item_id=? LIMIT 1', id)) fail(409, 'in_use', '주문 내역이 있는 메뉴는 삭제할 수 없습니다. 숨김 처리해 주세요.');
    run('DELETE FROM menu_items WHERE id=?', id);
  }
  function createCategory(body) {
    const name = cleanLabel(body.name, 1, 12, 'bad_category', '카테고리 이름');
    if (categoryNameTaken(name)) fail(409, 'name_taken', '같은 이름의 카테고리가 이미 있습니다.');
    const id = categoryByName(name);
    return { id, name };
  }
  function renameCategory(id, body) {
    const cur = get('SELECT * FROM menu_categories WHERE id=?', id) || fail(404, 'no_category', '없는 카테고리입니다.');
    const name = cleanLabel(body.name, 1, 12, 'bad_category', '카테고리 이름');
    if (categoryNameTaken(name, id)) fail(409, 'name_taken', '같은 이름의 카테고리가 이미 있습니다.');
    run('UPDATE menu_categories SET name=? WHERE id=?', name, id);
    return { id, name };
  }
  function deleteCategory(id) {
    if (!get('SELECT 1 FROM menu_categories WHERE id=?', id)) fail(404, 'no_category', '없는 카테고리입니다.');
    if (get('SELECT 1 FROM menu_items WHERE category_id=? LIMIT 1', id)) fail(409, 'category_not_empty', '메뉴가 남아 있는 카테고리는 삭제할 수 없습니다.');
    run('DELETE FROM menu_categories WHERE id=?', id);
  }
  // body: { items?: [itemId...], categories?: [categoryId...] } — each listed id's sort becomes its index in the list
  function reorderMenu(body) {
    const check = (list, existsSql, isId) => {
      if (!Array.isArray(list) || list.length > 200 || list.some((x) => !isId(x)) || new Set(list).size !== list.length) fail(400, 'bad_reorder', '순서 목록이 올바르지 않습니다.');
      if (list.some((x) => !get(existsSql, x))) fail(404, 'no_item', '없는 항목이 포함되어 있습니다.');
    };
    if (body.items == null && body.categories == null) fail(400, 'bad_reorder', '순서 목록이 올바르지 않습니다.');
    if (body.items != null) check(body.items, 'SELECT 1 FROM menu_items WHERE id=?', (x) => typeof x === 'string');
    if (body.categories != null) check(body.categories, 'SELECT 1 FROM menu_categories WHERE id=?', Number.isInteger);
    tx(() => {
      (body.items || []).forEach((id, i) => run('UPDATE menu_items SET sort=? WHERE id=?', i, id));
      (body.categories || []).forEach((id, i) => run('UPDATE menu_categories SET sort=? WHERE id=?', i, id));
    });
  }
  // secret for signing the booth_d device cookie (never exposed); generated once
  function deviceSecret() {
    let v = setting('device_secret', null);
    if (!v) { v = crypto.randomBytes(32).toString('hex'); run("INSERT INTO settings(k,v) VALUES('device_secret',?)", v); }
    return Buffer.from(v, 'hex');
  }
  const memberPct = () => Number(setting('member_discount_pct', '10'));
  function setMemberPct(p) {
    if (!Number.isInteger(p) || p < 0 || p > 50) fail(400, 'bad_pct', '할인율은 0~50 사이 정수여야 합니다.');
    run('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', 'member_discount_pct', String(p));
  }
  function setOrdering(open) { run('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', 'ordering_open', open ? '1' : '0'); }

  const ITEMS_SQL = 'SELECT item_id, name, unit_price, qty FROM order_items WHERE order_id=? ORDER BY rowid';
  // fixed-shape statement (one per order) so the prepared-statement cache cannot grow with N; N is bounded by the per-seat order cap
  const loadOrders = (rows) => rows.map((o) => ({
    id: o.id, table: o.table_id, seat: o.seat, status: o.status, paid: !!o.paid,
    items: all(ITEMS_SQL, o.id).map((it) => ({ id: it.item_id, name: it.name, qty: it.qty, unitPrice: it.unit_price })),
    subtotal: o.subtotal, discount: o.discount + o.member_discount, memberDiscount: o.member_discount, couponDiscount: o.discount,
    member: o.member_id != null, total: o.total, couponCode: o.coupon_code, note: o.note,
    createdAt: o.created_at, updatedAt: o.updated_at, cookingAt: o.cooking_at,
  }));
  const orderById = (id) => loadOrders([get('SELECT * FROM orders WHERE id=?', id)])[0];

  function createOrder(tableId, body, { memberId = null } = {}) {
    const t = tableRow(tableId);
    const key = body.key;
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(key)) fail(400, 'bad_key', '주문 키가 올바르지 않습니다. (8~64자 영숫자)');
    const dup = get('SELECT id FROM orders WHERE table_id=? AND seat=? AND key=?', tableId, t.seat, key);
    if (dup) return { order: orderById(dup.id), duplicate: true };
    if (!orderingOpen()) fail(409, 'closed', '지금은 주문을 받지 않습니다.');
    const lines = body.items;
    if (!Array.isArray(lines) || lines.length < 1) fail(400, 'bad_items', '주문할 메뉴를 담아 주세요.');
    if (lines.length > 30) fail(400, 'too_many_lines', '한 번에 30종류까지 주문할 수 있습니다.');
    const seen = new Set();
    const unknown = [];
    const rows = new Map();
    for (const l of lines) {
      if (!l || typeof l !== 'object' || typeof l.id !== 'string') fail(400, 'bad_items', '주문 항목이 올바르지 않습니다.');
      if (!Number.isInteger(l.qty) || l.qty < 1 || l.qty > 20) fail(400, 'bad_qty', '수량은 1~20 사이 정수여야 합니다.', { id: l.id });
      if (seen.has(l.id)) fail(400, 'dup_item', '같은 메뉴가 중복되었습니다.', { id: l.id });
      seen.add(l.id);
      const m = itemRow(l.id);
      if (!m || m.hidden) unknown.push(l.id); else rows.set(l.id, m);
    }
    if (unknown.length) fail(400, 'unknown_item', '없는 메뉴가 있습니다.', { ids: unknown });
    const gone = lines.filter((l) => rows.get(l.id).sold_out).map((l) => l.id);
    if (gone.length) fail(409, 'sold_out', '품절된 메뉴가 있습니다.', { ids: gone, names: gone.map((id) => rows.get(id).name) });
    if (body.expectedTotal != null && !Number.isInteger(body.expectedTotal)) fail(400, 'bad_expected_total', 'expectedTotal은 정수여야 합니다.');
    let note = '';
    if (body.note != null) {
      if (typeof body.note !== 'string') fail(400, 'bad_note', '요청 사항이 올바르지 않습니다.');
      note = body.note.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').trim();
      if ([...note].length > 100) fail(400, 'bad_note', '요청 사항은 100자 이내로 적어 주세요.');
    }
    if (get('SELECT COUNT(*) n FROM orders WHERE table_id=? AND seat=?', tableId, t.seat).n >= MAX_ORDERS_PER_SEAT) {
      fail(429, 'too_many_orders', '이 테이블에서 받을 수 있는 주문 수를 넘었습니다. 직원에게 문의해 주세요.');
    }
    if (get("SELECT COUNT(*) n FROM orders WHERE table_id=? AND seat=? AND status='pending'", tableId, t.seat).n >= MAX_PENDING_PER_TABLE) {
      fail(429, 'too_many_pending', '접수 대기 중인 주문이 너무 많습니다. 직원에게 문의해 주세요.');
    }
    const subtotal = lines.reduce((s, l) => s + rows.get(l.id).price * l.qty, 0);
    // member discount first (rounded DOWN to 100 won), then the coupon on what is left; the total never goes below 0
    let memberDiscount = 0;
    let memberDiscountSkipped = null;
    const pct = memberPct();
    if (memberId != null && pct > 0) {
      const want = Math.floor(subtotal * pct / 10000) * 100;
      if (want > 0) {
        const used = get("SELECT COUNT(*) n FROM orders WHERE member_id=? AND member_discount>0 AND status!='cancelled'", memberId).n;
        if (used >= L.memberOrderMax) memberDiscountSkipped = 'limit'; else memberDiscount = want;
      }
    }
    let discount = 0;
    let coupon = null;
    let couponIgnored = false;
    if (body.couponCode != null && body.couponCode !== '') {
      coupon = get('SELECT * FROM coupons WHERE code=?', String(body.couponCode).trim().toUpperCase());
      if (!coupon || coupon.table_id !== tableId || coupon.seat !== t.seat) fail(400, 'bad_coupon', '쿠폰을 찾을 수 없습니다.');
      if (coupon.status !== 'issued') fail(409, 'coupon_used', '이미 사용된 쿠폰입니다.');
      if (coupon.type !== 'discount') fail(400, 'coupon_not_discount', '할인 쿠폰만 주문에 적용할 수 있습니다. 이 쿠폰은 직원에게 보여 주세요.');
      discount = Math.min(coupon.amount, subtotal - memberDiscount);
      if (discount <= 0) { coupon = null; discount = 0; couponIgnored = true; } // nothing to discount: do not burn the coupon
    }
    const total = subtotal - memberDiscount - discount;
    if (body.expectedTotal != null && body.expectedTotal !== total) {
      fail(409, 'price_changed', '가격이 바뀌었습니다. 금액을 다시 확인해 주세요.', {
        expectedTotal: body.expectedTotal, total, subtotal, memberDiscount, couponDiscount: discount,
        items: lines.map((l) => ({ id: l.id, name: rows.get(l.id).name, qty: l.qty, unitPrice: rows.get(l.id).price })),
      });
    }
    const id = tx(() => {
      const ts = now();
      const oid = run('INSERT INTO orders(table_id,seat,key,subtotal,discount,member_discount,member_id,total,coupon_code,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        tableId, t.seat, key, subtotal, discount, memberDiscount, memberId, total, coupon ? coupon.code : null, note, ts, ts).lastInsertRowid;
      for (const l of lines) {
        const m = rows.get(l.id); // name and unit price are frozen into the order here
        run('INSERT INTO order_items(order_id,item_id,name,unit_price,qty) VALUES(?,?,?,?,?)', oid, m.id, m.name, m.price, l.qty);
      }
      if (coupon && run("UPDATE coupons SET status='used', order_id=?, used_at=? WHERE code=? AND status='issued'", oid, ts, coupon.code).changes !== 1) {
        fail(409, 'coupon_used', '이미 사용된 쿠폰입니다.');
      }
      return Number(oid);
    });
    return { order: orderById(id), duplicate: false, ...(memberDiscountSkipped ? { memberDiscountSkipped } : {}), ...(couponIgnored ? { couponIgnored: true } : {}) };
  }

  function setStatus(id, status) {
    if (!ORDER_STATUSES.includes(status)) fail(400, 'bad_status', '상태 값이 올바르지 않습니다.');
    const o = get('SELECT * FROM orders WHERE id=?', id) || fail(404, 'no_order', '없는 주문입니다.');
    if (o.status === 'cancelled') fail(409, 'order_cancelled', '취소된 주문은 바꿀 수 없습니다.');
    if (o.status !== status) {
      tx(() => {
        const ts = now();
        run('UPDATE orders SET status=?, updated_at=?, cooking_at=? WHERE id=?', status, ts, status === 'cooking' ? ts : o.cooking_at, id);
        if (status === 'cancelled' && o.coupon_code) {
          run("UPDATE coupons SET status='issued', order_id=NULL, used_at=NULL WHERE code=? AND order_id=?", o.coupon_code, id);
        }
      });
    }
    return orderById(id);
  }
  function setPaid(id, paid) {
    if (typeof paid !== 'boolean') fail(400, 'bad_paid', 'paid는 true/false여야 합니다.');
    if (!get('SELECT 1 FROM orders WHERE id=?', id)) fail(404, 'no_order', '없는 주문입니다.');
    run('UPDATE orders SET paid=?, updated_at=? WHERE id=?', paid ? 1 : 0, now(), id);
    return orderById(id);
  }
  function guestCancel(tableId, id) {
    const t = tableRow(tableId);
    const o = get('SELECT * FROM orders WHERE id=? AND table_id=? AND seat=?', id, tableId, t.seat) || fail(404, 'no_order', '없는 주문입니다.');
    if (o.status !== 'pending' || o.paid) fail(409, 'not_cancellable', '이미 접수되었거나 결제된 주문은 직원에게 문의해 주세요.');
    return setStatus(id, 'cancelled');
  }

  // ---------- rewards / games / coupons ----------
  function rewardsView(tableId, seat) {
    return rewards.rewards.map((r) => {
      const s = get('SELECT stock, issued FROM reward_stock WHERE id=?', r.id);
      const base = { id: r.id, game: r.game, label: r.label, type: r.type, amount: r.amount ?? null, item: r.item ?? null, threshold: r.threshold };
      if (tableId == null) return { ...base, stock: s.stock, issued: s.issued, remaining: s.stock - s.issued };
      const got = !!get("SELECT 1 FROM coupons WHERE table_id=? AND seat=? AND source='score' AND reward_id=?", tableId, seat, r.id);
      return { ...base, soldOut: s.issued >= s.stock, got };
    });
  }
  function setStock(id, stock) {
    if (!Number.isInteger(stock) || stock < 0 || stock > 100000) fail(400, 'bad_stock', '재고는 0 이상의 정수여야 합니다.');
    const r = get('SELECT issued FROM reward_stock WHERE id=?', id) || fail(404, 'no_reward', '없는 보상입니다.');
    if (stock < r.issued) fail(400, 'stock_below_issued', '이미 발급한 수량보다 적게 설정할 수 없습니다.', { issued: r.issued });
    run('UPDATE reward_stock SET stock=? WHERE id=?', stock, id);
    invalidate();
  }

  function startPlay(tableId, device, game) {
    const t = tableRow(tableId);
    const g = typeof game === 'string' && Object.hasOwn(games, game) ? games[game] : fail(400, 'bad_game', '알 수 없는 게임입니다.');
    const dev = get('SELECT COUNT(*) n, MAX(started_at) last FROM plays WHERE device=?', device);
    if (dev.n >= MAX_PLAYS_PER_DEVICE) fail(429, 'device_limit', '이 기기에서 할 수 있는 게임 횟수를 모두 사용했습니다.');
    const seatP = get('SELECT COUNT(*) n, MAX(started_at) last, SUM(finished_at IS NULL AND started_at>?) open FROM plays WHERE table_id=? AND seat=?', now() - MAX_PLAY_MS, tableId, t.seat);
    if (seatP.n >= L.seatPlayMax) fail(429, 'seat_limit', '이 테이블에서 할 수 있는 게임 횟수를 모두 사용했습니다.');
    if ((seatP.open || 0) >= L.seatOpenMax) fail(429, 'too_many_open', '진행 중인 게임이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
    const wait = Math.max(dev.last == null ? 0 : dev.last + PLAY_GAP_MS - now(), seatP.last == null ? 0 : seatP.last + L.seatPlayGapMs - now());
    if (wait > 0) fail(429, 'rate_limited', '잠시 후에 다시 시작해 주세요.', { retryAfterMs: wait });
    const ts = now();
    const playId = Number(run('INSERT INTO plays(table_id,seat,game,device,started_at) VALUES(?,?,?,?,?)', tableId, t.seat, game, device, ts).lastInsertRowid);
    return { playId, game, startedAt: ts, maxScore: g.maxScore };
  }

  function finishPlay(tableId, device, playId, score) {
    const t = tableRow(tableId);
    if (!Number.isInteger(playId)) fail(400, 'bad_play', 'playId가 올바르지 않습니다.');
    if (typeof score !== 'number' || !Number.isInteger(score)) fail(400, 'bad_score', 'score는 정수여야 합니다.');
    const play = get('SELECT * FROM plays WHERE id=? AND table_id=? AND seat=? AND device=?', playId, tableId, t.seat, device) || fail(404, 'no_play', '게임 기록을 찾을 수 없습니다.');
    if (play.finished_at != null) fail(409, 'already_finished', '이미 제출된 게임입니다.');
    const g = games[play.game];
    const ts = now();
    const dur = ts - play.started_at;
    const reject = (code, message) => {
      run('UPDATE plays SET finished_at=?, rejected=1 WHERE id=?', ts, playId);
      fail(400, code, message);
    };
    if (score < 0 || score > g.maxScore) reject('bad_score', '점수가 올바르지 않습니다.');
    if (dur < g.minDurationMs) reject('too_fast', '게임 시간이 너무 짧습니다.');
    if (dur > MAX_PLAY_MS) reject('too_slow', '게임 시간이 너무 깁니다.');
    return tx(() => {
      const nick = get('SELECT nick FROM nicks WHERE device=? AND table_id=? AND seat=?', device, tableId, t.seat)?.nick ?? null;
      run('UPDATE plays SET finished_at=?, score=?, nick=? WHERE id=?', ts, score, nick, playId);
      invalidate();
      const results = [];
      const issued = [];
      for (const r of rewards.rewards.filter((x) => x.game === play.game)) {
        const res = { rewardId: r.id, label: r.label };
        if (score < r.threshold) res.result = 'low_score';
        else if (get("SELECT 1 FROM coupons WHERE table_id=? AND seat=? AND source='score' AND reward_id=?", tableId, t.seat, r.id)) res.result = 'already_got';
        else if (run('UPDATE reward_stock SET issued=issued+1 WHERE id=? AND issued<stock', r.id).changes !== 1) res.result = 'sold_out';
        else {
          const c = insertCoupon({ rewardId: r.id, source: 'score', type: r.type, amount: r.amount ?? null, label: r.label, item: r.item ?? null, tableId, seat: t.seat });
          issued.push(c);
          res.result = 'issued';
          res.coupon = c;
        }
        results.push(res);
      }
      return { score, coupons: issued, rewards: results };
    });
  }

  function redeem(code) {
    const c = get('SELECT * FROM coupons WHERE code=?', String(code || '').trim().toUpperCase()) || fail(404, 'no_coupon', '없는 쿠폰 코드입니다.');
    if (c.status !== 'issued') fail(409, 'already_used', '이미 사용된 쿠폰입니다.', { usedAt: c.used_at, orderId: c.order_id });
    run("UPDATE coupons SET status='used', used_at=? WHERE code=?", now(), c.code);
    return { ...couponOut(get('SELECT * FROM coupons WHERE code=?', c.code)), stale: c.seat !== get('SELECT seat FROM tables WHERE id=?', c.table_id).seat };
  }

  function hourRanking(start) {
    const rows = all('SELECT table_id, game, MAX(score) s FROM plays WHERE score IS NOT NULL AND finished_at>=? AND finished_at<? GROUP BY table_id, game', start, start + HOUR);
    const by = new Map();
    for (const r of rows) {
      const e = by.get(r.table_id) || { table: r.table_id, score: 0, games: {} };
      e.games[r.game] = r.s;
      e.score += r.s;
      by.set(r.table_id, e);
    }
    const list = [...by.values()].filter((e) => e.score > 0 && e.table <= tableCount).sort((a, b) => b.score - a.score || a.table - b.table).slice(0, 5);
    for (const e of list) {
      e.nick = get('SELECT nick FROM plays WHERE table_id=? AND score IS NOT NULL AND finished_at>=? AND finished_at<? ORDER BY score DESC, finished_at LIMIT 1', e.table, start, start + HOUR)?.nick ?? null;
    }
    return list;
  }
  const hourStartOf = (ms) => Math.floor(ms / HOUR) * HOUR;
  const hourAwarded = (start) => !!get("SELECT 1 FROM coupons WHERE source='hour' AND reward_id=?", 'hour:' + start);
  function hourInfo(start) {
    const hit = memo.hours.get(start);
    if (hit && now() - hit.at < MEMO_MS) return hit.v;
    const ranking = hourRanking(start);
    const v = { start, end: start + HOUR, ranking, top: ranking[0] || null, awarded: hourAwarded(start) };
    memo.hours.set(start, { at: now(), v });
    return v;
  }
  function awardHour(start) {
    const cur = hourStartOf(now());
    if (start == null) start = cur;
    if (!Number.isInteger(start) || start % HOUR !== 0 || start > cur) fail(400, 'bad_hour', 'hourStart가 올바르지 않습니다.');
    invalidate();
    return tx(() => {
      if (hourAwarded(start)) fail(409, 'already_awarded', '이 시간대 보상은 이미 지급했습니다.');
      const top = hourRanking(start)[0] || fail(404, 'no_ranking', '이 시간대 게임 기록이 없습니다.');
      const h = rewards.hourly || { label: '안주 1개 서비스' };
      const t = tableRow(top.table);
      const coupon = insertCoupon({ rewardId: 'hour:' + start, source: 'hour', type: 'item', label: h.label, item: h.item ?? h.label, tableId: top.table, seat: t.seat });
      return { coupon, table: top.table, score: top.score, hourStart: start };
    });
  }

  // ---------- nick / calls / waitlist ----------
  function setNick(device, tableId, nick) {
    const t = tableRow(tableId);
    const n = cleanNick(nick);
    if (!get('SELECT 1 FROM nicks WHERE device=? AND table_id=? AND seat=?', device, tableId, t.seat)
      && get('SELECT COUNT(*) n FROM nicks WHERE table_id=? AND seat=?', tableId, t.seat).n >= MAX_NICKS_PER_SEAT) {
      fail(429, 'too_many_nicks', '이 테이블에서 설정할 수 있는 닉네임 수를 넘었습니다. 직원에게 문의해 주세요.');
    }
    invalidate();
    run('INSERT INTO nicks(device,table_id,seat,nick) VALUES(?,?,?,?) ON CONFLICT(device,table_id,seat) DO UPDATE SET nick=excluded.nick', device, tableId, t.seat, n);
    return n;
  }
  function addCall(tableId, type) {
    const t = tableRow(tableId);
    if (!CALL_TYPES.includes(type)) fail(400, 'bad_call', '호출 종류가 올바르지 않습니다.', { allowed: CALL_TYPES });
    const open = get('SELECT * FROM calls WHERE table_id=? AND seat=? AND type=? AND resolved_at IS NULL', tableId, t.seat, type);
    if (open) return { call: { id: open.id, type, createdAt: open.created_at }, duplicate: true };
    if (get('SELECT COUNT(*) n FROM calls WHERE table_id=? AND seat=?', tableId, t.seat).n >= MAX_CALLS_PER_SEAT) fail(429, 'too_many_calls', '직원 호출이 너무 많습니다. 직원에게 직접 말씀해 주세요.');
    const ts = now();
    const id = Number(run('INSERT INTO calls(table_id,seat,type,created_at) VALUES(?,?,?,?)', tableId, t.seat, type, ts).lastInsertRowid);
    return { call: { id, type, createdAt: ts }, duplicate: false };
  }
  function resolveCall(id) {
    if (run('UPDATE calls SET resolved_at=? WHERE id=? AND resolved_at IS NULL', now(), id).changes !== 1) fail(404, 'no_call', '없거나 이미 처리된 호출입니다.');
  }

  const waitOpen = () => setting('wait_open', '1') === '1';
  function setWaitOpen(open) { run('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', 'wait_open', open ? '1' : '0'); }
  function clearWait() { return run("UPDATE waitlist SET status='cancelled' WHERE status IN ('waiting','called')").changes; }
  const waitInfo = () => ({ open: waitOpen(), waitingTotal: get("SELECT COUNT(*) n FROM waitlist WHERE status='waiting'").n });
  function addWait(device, nick, size) {
    if (!waitOpen()) fail(403, 'wait_closed', '지금은 대기 등록을 받지 않습니다.');
    const n = cleanNick(nick);
    if (!Number.isInteger(size) || size < 1 || size > 10) fail(400, 'bad_size', '인원은 1~10명으로 입력해 주세요.');
    if (get("SELECT COUNT(*) n FROM waitlist WHERE device=? AND status IN ('waiting','called')", device).n >= 3) fail(429, 'too_many', '이 기기에서 등록할 수 있는 대기 수를 넘었습니다.');
    if (get("SELECT COUNT(*) n FROM waitlist WHERE status='waiting'").n >= 300) fail(503, 'wait_full', '대기 명단이 가득 찼습니다.');
    const t = now();
    while (waitTimes.length && waitTimes[0] < t - 60000) waitTimes.shift();
    if (waitTimes.length >= MAX_WAIT_PER_MIN) fail(429, 'wait_rate', '대기 등록이 몰리고 있습니다. 잠시 후 다시 시도해 주세요.');
    run("DELETE FROM waitlist WHERE status IN ('seated','cancelled') AND created_at<?", t - WAIT_KEEP_MS);
    waitTimes.push(t);
    const secret = crypto.randomBytes(12).toString('base64url');
    const id = Number(run('INSERT INTO waitlist(nick,size,secret,device,created_at) VALUES(?,?,?,?,?)', n, size, secret, device, now()).lastInsertRowid);
    return { id, secret };
  }
  function waitRow(id, secret) {
    const w = get('SELECT * FROM waitlist WHERE id=?', id);
    const a = Buffer.from(String(secret || ''));
    const b = Buffer.from(w ? w.secret : '');
    if (!w || a.length !== b.length || !crypto.timingSafeEqual(a, b)) fail(404, 'no_wait', '대기 정보를 찾을 수 없습니다.');
    return w;
  }
  function waitStatus(id, secret) {
    const w = waitRow(id, secret);
    const ahead = w.status === 'waiting' ? get("SELECT COUNT(*) n FROM waitlist WHERE status='waiting' AND id<?", w.id).n : 0;
    return {
      id: w.id, nick: w.nick, size: w.size, status: w.status, ahead, position: w.status === 'waiting' ? ahead + 1 : null,
      waitingTotal: get("SELECT COUNT(*) n FROM waitlist WHERE status='waiting'").n, open: waitOpen(),
    };
  }
  function waitCancel(id, secret) {
    const w = waitRow(id, secret);
    if (w.status === 'waiting' || w.status === 'called') run("UPDATE waitlist SET status='cancelled' WHERE id=?", id);
  }
  function waitAction(id, action) {
    const to = { call: 'called', seat: 'seated', cancel: 'cancelled' }[action];
    const w = get('SELECT * FROM waitlist WHERE id=?', id) || fail(404, 'no_wait', '없는 대기 번호입니다.');
    if (w.status === 'seated' || w.status === 'cancelled') fail(409, 'wait_closed', '이미 처리된 대기입니다.');
    run('UPDATE waitlist SET status=?, called_at=? WHERE id=?', to, to === 'called' ? now() : w.called_at, id);
  }

  // ---------- snapshots ----------
  function guestState(tableId, device) {
    const t = tableRow(tableId);
    return {
      table: { number: t.id, seat: t.seat },
      orderingOpen: orderingOpen(),
      memberDiscountPct: memberPct(),
      menu: menuView(),
      // cancelled orders: only the newest 5 are shown
      orders: loadOrders(all("SELECT * FROM orders WHERE table_id=? AND seat=? AND (status!='cancelled' OR id IN (SELECT id FROM orders WHERE table_id=? AND seat=? AND status='cancelled' ORDER BY id DESC LIMIT 5)) ORDER BY id DESC", tableId, t.seat, tableId, t.seat)),
      coupons: all('SELECT * FROM coupons WHERE table_id=? AND seat=? ORDER BY created_at, code', tableId, t.seat).map(couponOut),
      calls: all('SELECT id, type, created_at FROM calls WHERE table_id=? AND seat=? AND resolved_at IS NULL ORDER BY id', tableId, t.seat).map((c) => ({ id: c.id, type: c.type, createdAt: c.created_at })),
      nick: get('SELECT nick FROM nicks WHERE device=? AND table_id=? AND seat=?', device, tableId, t.seat)?.nick ?? null,
      rewards: rewardsView(tableId, t.seat),
      games: games,
      callTypes: CALL_TYPES,
    };
  }

  function tablesView() {
    const ts = now();
    return all('SELECT * FROM tables WHERE id<=? ORDER BY id', tableCount).map((t) => {
      const o = get("SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN paid=0 THEN total END),0) unpaid, MIN(created_at) first FROM orders WHERE table_id=? AND seat=? AND status!='cancelled'", t.id, t.seat);
      const p = get('SELECT MIN(started_at) first FROM plays WHERE table_id=? AND seat=?', t.id, t.seat);
      const firsts = [o.first, p.first].filter((x) => x != null);
      return {
        number: t.id, seat: t.seat, status: firsts.length ? 'occupied' : 'empty', orderCount: o.n, unpaidTotal: o.unpaid,
        minutesSeated: firsts.length ? Math.floor((ts - Math.min(...firsts)) / 60000) : null,
        openCalls: get('SELECT COUNT(*) n FROM calls WHERE table_id=? AND seat=? AND resolved_at IS NULL', t.id, t.seat).n,
      };
    });
  }

  function staffState() {
    const cur = hourStartOf(now());
    return {
      orderingOpen: orderingOpen(),
      waitOpen: waitOpen(),
      // cancelled orders only stay on the board for 10 minutes
      orders: loadOrders(all("SELECT o.* FROM orders o JOIN tables t ON t.id=o.table_id AND t.seat=o.seat WHERE t.id<=? AND (o.status!='cancelled' OR o.updated_at>?) ORDER BY o.id", tableCount, now() - 600000)),
      tables: tablesView(),
      calls: all('SELECT id, table_id, type, created_at FROM calls WHERE resolved_at IS NULL AND table_id<=? ORDER BY id', tableCount).map((c) => ({ id: c.id, table: c.table_id, type: c.type, createdAt: c.created_at })),
      waitlist: all("SELECT * FROM waitlist WHERE status IN ('waiting','called') ORDER BY id").map((w) => ({ id: w.id, nick: w.nick, size: w.size, status: w.status, createdAt: w.created_at, calledAt: w.called_at })),
      coupons: all("SELECT c.* FROM coupons c JOIN tables t ON t.id=c.table_id AND t.seat=c.seat WHERE c.status='issued' AND t.id<=? ORDER BY c.created_at DESC", tableCount).map(couponOut),
      rewards: rewardsView(),
      hourly: rewards.hourly || { label: '안주 1개 서비스' },
      hour: hourInfo(cur),
      prevHour: hourInfo(cur - HOUR),
      memberDiscountPct: memberPct(),
      memberEnabled,
      menu: menuView(true),
    };
  }

  function kitchenState() {
    const orders = loadOrders(all("SELECT o.* FROM orders o JOIN tables t ON t.id=o.table_id AND t.seat=o.seat WHERE o.status='cooking' AND t.id<=? ORDER BY o.cooking_at, o.id", tableCount));
    const agg = new Map();
    for (const o of orders) for (const i of o.items) {
      const a = agg.get(i.id) || { id: i.id, name: i.name, qty: 0 };
      a.qty += i.qty;
      agg.set(i.id, a);
    }
    return {
      items: [...agg.values()].sort((a, b) => b.qty - a.qty),
      orders: orders.map((o) => ({ id: o.id, table: o.table, member: o.member, note: o.note, items: o.items.map((i) => ({ id: i.id, name: i.name, qty: i.qty })), since: o.cookingAt })),
    };
  }

  function boardState() {
    if (memo.board && now() - memo.boardAt < MEMO_MS) return memo.board;
    const cur = hourStartOf(now());
    const g = {};
    for (const name of Object.keys(games)) {
      g[name] = all('SELECT table_id, nick, MAX(score) score, finished_at FROM plays WHERE game=? AND score IS NOT NULL AND table_id<=? GROUP BY table_id ORDER BY score DESC, finished_at LIMIT 10', name, tableCount)
        .map((r, i) => ({ rank: i + 1, table: r.table_id, nick: r.nick, score: r.score }));
    }
    const h = hourInfo(cur);
    const p = hourInfo(cur - HOUR);
    memo.boardAt = now();
    return memo.board = {
      hour: { start: h.start, end: h.end, ranking: h.ranking, awarded: h.awarded },
      prevHour: { start: p.start, winner: p.top, awarded: p.awarded },
      hourly: rewards.hourly || { label: '안주 1개 서비스' },
      games: g,
      gameInfo: games,
      rewards: rewardsView().map((r) => ({ id: r.id, label: r.label, remaining: r.remaining, stock: r.stock })),
    };
  }

  // ---------- table ops ----------
  function clearTable(n, force) {
    const t = tableRow(n);
    const u = get("SELECT SUM(paid=0) unpaid, COALESCE(SUM(CASE WHEN paid=0 THEN total END),0) unpaidTotal, SUM(status IN ('pending','cooking')) unserved FROM orders WHERE table_id=? AND seat=? AND status!='cancelled'", n, t.seat);
    if (!force && ((u.unpaid || 0) > 0 || (u.unserved || 0) > 0)) {
      fail(409, 'unsettled', '미입금 또는 서빙 전 주문이 남아 있습니다.', { unpaid: u.unpaid || 0, unserved: u.unserved || 0, unpaidTotal: u.unpaidTotal });
    }
    invalidate();
    tx(() => {
      run('UPDATE tables SET seat=seat+1 WHERE id=?', n);
      run('UPDATE calls SET resolved_at=? WHERE table_id=? AND resolved_at IS NULL', now(), n);
    });
    return get('SELECT seat FROM tables WHERE id=?', n).seat;
  }
  function moveTable(a, b) {
    if (!Number.isInteger(a) || !Number.isInteger(b) || a === b) fail(400, 'bad_tables', '옮길 테이블 번호가 올바르지 않습니다.');
    const A = tableRow(a);
    const B = tableRow(b);
    invalidate();
    return tx(() => {
      const mv = (tbl, set = '') => run(`UPDATE ${tbl} SET table_id=?, seat=?${set} WHERE table_id=? AND seat=?`, b, B.seat, a, A.seat).changes;
      // moved orders get a derived key so equal idempotency keys in both seats cannot collide
      const moved = { orders: mv('orders', ", key=key||'~m'||id"), coupons: mv('coupons'), plays: mv('plays') };
      // the source is now a new seating: it cannot re-earn rewards in the old one
      run('UPDATE tables SET seat=seat+1 WHERE id=?', a);
      run('UPDATE calls SET resolved_at=? WHERE table_id=? AND resolved_at IS NULL', now(), a);
      return { ...moved, fromSeat: A.seat + 1 };
    });
  }

  // ---------- sales ----------
  function sales() {
    const totals = get("SELECT COUNT(*) orders, COALESCE(SUM(total),0) revenue, COALESCE(SUM(discount+member_discount),0) discount, COALESCE(SUM(member_discount),0) memberDiscount, COALESCE(SUM(member_discount>0),0) memberOrders, COALESCE(SUM(CASE WHEN paid=1 THEN total END),0) paidRevenue FROM orders WHERE status!='cancelled'");
    totals.unpaidRevenue = totals.revenue - totals.paidRevenue;
    return {
      totals,
      byHour: all("SELECT (created_at/3600000)*3600000 h, COUNT(*) n, SUM(total) revenue, SUM(discount+member_discount) discount FROM orders WHERE status!='cancelled' GROUP BY h ORDER BY h")
        .map((r) => ({ hour: r.h, label: kst(r.h), orders: r.n, revenue: r.revenue, discount: r.discount })),
      byItem: all("SELECT oi.item_id id, oi.name, SUM(oi.qty) qty, SUM(oi.qty*oi.unit_price) gross, MAX(oi.rowid) lastrow FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.status!='cancelled' GROUP BY oi.item_id ORDER BY qty DESC, oi.item_id")
        .map((r) => ({ id: r.id, name: r.name, qty: r.qty, gross: r.gross })),
      coupons: all("SELECT CASE WHEN source='hour' THEN 'hour' ELSE reward_id END rid, label, type, COUNT(*) issued, SUM(status='used') used FROM coupons GROUP BY rid, label, type ORDER BY rid")
        .map((r) => ({ rewardId: r.rid, label: r.label, type: r.type, issued: r.issued, used: r.used })),
    };
  }
  function salesCsv() {
    const s = sales();
    const esc = (v) => { const x = String(v ?? ''); return /[",\r\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; };
    const line = (...c) => c.map(esc).join(',');
    const out = [
      line('[요약]'), line('주문수', '매출', '할인', '입금확인', '미입금', '회원할인액', '회원할인 건수'),
      line(s.totals.orders, s.totals.revenue, s.totals.discount, s.totals.paidRevenue, s.totals.unpaidRevenue, s.totals.memberDiscount, s.totals.memberOrders), '',
      line('[시간대별 매출]'), line('시간', '주문수', '매출', '할인'),
      ...s.byHour.map((r) => line(r.label, r.orders, r.revenue, r.discount)), '',
      line('[메뉴별 판매]'), line('메뉴', '수량', '금액(할인 전)'),
      ...s.byItem.map((r) => line(r.name, r.qty, r.gross)), '',
      line('[쿠폰]'), line('쿠폰', '종류', '발급', '사용'),
      ...s.coupons.map((r) => line(r.label, r.type === 'discount' ? '할인' : '메뉴', r.issued, r.used)),
    ];
    return '﻿' + out.join('\r\n') + '\r\n';
  }

  function reset() {
    invalidate();
    tx(() => {
      for (const t of ['order_items', 'orders', 'coupons', 'plays', 'nicks', 'calls', 'waitlist']) run(`DELETE FROM ${t}`);
      run('UPDATE menu_items SET sold_out=0'); // the menu itself and the settings (member pct) survive a reset
      run("DELETE FROM sqlite_sequence WHERE name IN ('orders','plays','calls','waitlist')");
      run('UPDATE tables SET seat=1');
      run("DELETE FROM settings WHERE k IN ('ordering_open','wait_open')");
      for (const r of rewards.rewards) run('UPDATE reward_stock SET issued=0, stock=? WHERE id=?', r.stock, r.id);
    });
  }

  // ---------- staff sessions / tokens / backup ----------
  // only sha256 of session ids / login keys is stored, so a copied booth.db or backup holds no usable credential
  function newSession(ttlMs) {
    const id = crypto.randomBytes(24).toString('base64url');
    run('DELETE FROM sessions WHERE expires_at<?', now());
    run('INSERT INTO sessions(id, expires_at) VALUES(?,?)', sha(id), now() + ttlMs);
    return id;
  }
  const validSession = (id) => typeof id === 'string' && !!get('SELECT 1 FROM sessions WHERE id=? AND expires_at>?', sha(id), now());
  const endSession = (id) => run('DELETE FROM sessions WHERE id=?', sha(id));

  // booth_k: long-lived trusted-device key for staff (exempt from the global login lock)
  function newLoginKey() {
    const k = crypto.randomBytes(24).toString('base64url');
    run('DELETE FROM login_keys WHERE created_at<?', now() - 30 * 24 * HOUR);
    run('DELETE FROM login_keys WHERE hash NOT IN (SELECT hash FROM login_keys ORDER BY created_at DESC LIMIT 49)'); // at most 50 rows
    run('INSERT INTO login_keys(hash, created_at) VALUES(?,?)', sha(k), now());
    return k;
  }
  const validLoginKey = (k) => typeof k === 'string' && !!get('SELECT 1 FROM login_keys WHERE hash=?', sha(k));
  const loginKeyOk = (k) => run('UPDATE login_keys SET fails=0 WHERE hash=?', sha(k));
  // returns the number of consecutive failures; the key is revoked at 5
  function loginKeyFail(k) {
    run('UPDATE login_keys SET fails=fails+1 WHERE hash=?', sha(k));
    const r = get('SELECT fails FROM login_keys WHERE hash=?', sha(k));
    if (r && r.fails >= 5) run('DELETE FROM login_keys WHERE hash=?', sha(k));
    return r ? r.fails : 5;
  }

  const tokens = () => all('SELECT id, token FROM tables WHERE id<=? ORDER BY id', tableCount);

  // keeps the newest `keep` copies plus the oldest copy of each of the 8 most recent older hours (within 48 h).
  // periodic backups are skipped (logged once) while the DB file exceeds backupSkipBytes.
  async function backup(dir, keep = 12, { periodic = false } = {}) {
    if (periodic && fs.statSync(dbFile).size > backupSkipBytes) {
      if (!skipLogged) { skipLogged = true; console.error(`booth.db is larger than ${backupSkipBytes} bytes: periodic backups are skipped`); }
      return false;
    }
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '-').slice(0, 19);
    await sqliteBackup(db, path.join(dir, `booth-${stamp}.db`));
    const files = fs.readdirSync(dir).filter((f) => /^booth-\d{8}-\d{6}(-\d{3})?\.db$/.test(f)).sort();
    const stampMs = (f) => { const m = /^booth-(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)/.exec(f); return Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]); };
    const older = files.slice(0, Math.max(0, files.length - keep));
    const firstOfHour = new Map(); // hour key -> oldest file (files are sorted ascending)
    for (const f of older) if (now() - stampMs(f) <= 48 * HOUR && !firstOfHour.has(f.slice(6, 17))) firstOfHour.set(f.slice(6, 17), f);
    const keepHourly = new Set([...firstOfHour.keys()].sort().slice(-8).map((h) => firstOfHour.get(h)));
    for (const f of older) if (!keepHourly.has(f)) fs.unlinkSync(path.join(dir, f));
    return true;
  }

  return {
    createOrder, setStatus, setPaid, guestCancel, menuView, setSoldOut, setOrdering, orderingOpen,
    deviceSecret, createItem, updateItem, deleteItem, createCategory, renameCategory, deleteCategory, reorderMenu, memberPct, setMemberPct,
    startPlay, finishPlay, redeem, awardHour, setStock, setNick, addCall, resolveCall,
    addWait, waitStatus, waitCancel, waitAction, setWaitOpen, clearWait, waitInfo,
    newLoginKey, validLoginKey, loginKeyOk, loginKeyFail,
    guestState, staffState, kitchenState, boardState, clearTable, moveTable, sales, salesCsv, reset,
    newSession, validSession, endSession, tokens, backup, orderById,
    close: () => db.close(),
  };
}

module.exports = { createStore, HttpError, CALL_TYPES };

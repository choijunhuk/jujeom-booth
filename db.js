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
const REWARD_MAX = 12;
const HOURLY_DEFAULT = { enabled: true, label: '안주 1개 서비스', type: 'item', amount: null, item: '안주 1개 서비스' };
const PHOTO_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const PHOTO_NAME_RE = /^\d+-[a-f0-9]{8}\.(jpg|png|webp)$/;
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
  member_discount INTEGER NOT NULL DEFAULT 0, member_id INTEGER, depositor TEXT, paid_by TEXT, notice_id INTEGER,
  created_by TEXT, member_rule TEXT, paid_amount INTEGER NOT NULL DEFAULT 0, paid_method TEXT, paid_at INTEGER, written_off INTEGER NOT NULL DEFAULT 0, written_off_at INTEGER, written_off_clear INTEGER,
  coupon_code TEXT, note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  cooking_at INTEGER, UNIQUE(table_id, seat, key));
CREATE INDEX IF NOT EXISTS orders_ts ON orders(table_id, seat);
CREATE TABLE IF NOT EXISTS order_items(order_id INTEGER NOT NULL, item_id TEXT NOT NULL, name TEXT NOT NULL, unit_price INTEGER NOT NULL, qty INTEGER NOT NULL, service INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS order_items_o ON order_items(order_id);
CREATE TABLE IF NOT EXISTS menu_categories(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS menu_items(
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, price INTEGER NOT NULL, category_id INTEGER NOT NULL, descr TEXT NOT NULL DEFAULT '',
  hidden INTEGER NOT NULL DEFAULT 0, sold_out INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL DEFAULT 0, photo TEXT, stock_left INTEGER, stock_auto INTEGER NOT NULL DEFAULT 0);
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
  status TEXT NOT NULL DEFAULT 'waiting', created_at INTEGER NOT NULL, called_at INTEGER, recalled INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS login_keys(hash TEXT PRIMARY KEY, fails INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS deposit_notices(
  id INTEGER PRIMARY KEY AUTOINCREMENT, received_at INTEGER NOT NULL, raw TEXT NOT NULL, norm TEXT NOT NULL, amount INTEGER, depositor TEXT,
  status TEXT NOT NULL, order_id INTEGER, matched_at INTEGER, matched_by TEXT, duplicate_of INTEGER, reasons TEXT, amount_guessed INTEGER NOT NULL DEFAULT 0, repeat_count INTEGER NOT NULL DEFAULT 1, last_at INTEGER);
CREATE INDEX IF NOT EXISTS deposit_norm ON deposit_notices(norm, received_at);
CREATE TABLE IF NOT EXISTS refunds(
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, amount INTEGER NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL,
  done_at INTEGER, done_method TEXT, done_note TEXT);
CREATE INDEX IF NOT EXISTS refunds_order ON refunds(order_id);
CREATE TABLE IF NOT EXISTS table_clears(id INTEGER PRIMARY KEY AUTOINCREMENT, table_id INTEGER NOT NULL, old_seat INTEGER NOT NULL, new_seat INTEGER NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit_log(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, summary TEXT NOT NULL, summary_ko TEXT);
CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, amount INTEGER NOT NULL, method TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS payments_o ON payments(order_id);
CREATE TABLE IF NOT EXISTS day_reports(id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, created_at INTEGER NOT NULL, summary TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS nicks_ts ON nicks(table_id, seat);
CREATE INDEX IF NOT EXISTS plays_fin ON plays(finished_at);
`;

// ---- bank deposit notice parsing ----
// The sender controls the depositor text printed in the bank SMS, so EVERY character is attacker-controlled. Display parsing may be lenient,
// but automatic confirmation needs `autoEligible`: exactly one amount-shaped number, exactly one plain 2..10 letter name, and the name and the
// amount not touching each other on one line. Anything else carries `reasons` and falls to staff.
const BANK_WORDS = new Set(['신한', '국민', '우리', '하나', '농협', 'nh', '카카오', '카카오뱅크', '카뱅', '토스', '토스뱅크', '기업', 'ibk', 'sc', '제일', 'sc제일', '케이뱅크', '새마을', '새마을금고', '우체국', '부산', '대구', '광주', '전북', '제주', '수협', '신협', '씨티']);
const BANK_RE = /^(신한|국민|우리|하나|농협|nh|카카오|카뱅|토스|기업|ibk|sc|제일|케이|새마을|우체국|부산|대구|광주|전북|제주|수협|신협|씨티)(은행|뱅크|금고|농협)?$/i;
const NOT_NAMES = /^(입금|입출금|잔액|출금|이체|계좌|통장|원$|web발신|웹발신|sms|문자|체크|타행|당행|모바일|스마트폰|인터넷|전자금융|뱅킹|from|총|합계)/i;
const IGNORE_WORD_RE = /(?<!입)출금|취소|정정|오류|반환|실패|입금\s*(계좌|취소|은행|예정|한도)/; // 입출금통장 (KakaoBank) is a template word, not a withdrawal
const spaces = (n) => ' '.repeat(n);
function parseDeposit(rawText) {
  const text = String(rawText).normalize('NFKC').replace(/[\u2028\u2029]/g, ' ').replace(/\r/g, '\n'); // full-width digits become ASCII; no exotic line starts
  if (!text.includes('입금')) return { kind: 'ignore' }; // withdrawals and everything that is not a deposit
  const w = text
    .replace(/\d{4}[-./]\d{1,2}[-./]\d{1,2}/g, ' ') // dates
    .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, ' ') // times
    .replace(/\d{1,2}\/\d{1,2}/g, ' ')
    .replace(/\b\d{1,2}\.\d{1,2}\b/g, ' ')
    .replace(/\d*\*+[\d*-]*/g, ' ') // masked account fragments, as whole tokens
    .replace(/\d{2,}-[\d*-]+/g, ' ') // hyphenated account numbers
    .replace(/\d{2,}-+(?=\s|$)/g, ' ')
    .replace(/^[ \t]*잔액[ \t]*[:：]?[ \t]*[\d,]+[ \t]*원?/gm, ' '); // a balance only counts when it STARTS a line: a sender-typed "잔액" mid-line must not hide the real amount
  const reasons = [];
  const nums = [...w.matchAll(/(\d{1,3}(?:,\d{3})+|\d+)(\s*원)?/g)].map((m) => ({ v: Number(m[1].replace(/,/g, '')), start: m.index, end: m.index + m[0].length, strong: m[0].includes(',') || m[0].includes('원') }));
  const ok = (n) => Number.isInteger(n.v) && n.v >= 100 && n.v <= 10000000;
  if (nums.length > 1) reasons.push('multiple_amounts');
  const valid = nums.filter(ok);
  if (nums.length === 0) reasons.push('no_amount'); else if (nums.length === 1 && !valid.length) reasons.push('amount_range');
  // best guess for display (nearest to the word 입금, ties go to "after")
  const idx = w.indexOf('입금');
  const pool = valid.some((n) => n.strong) ? valid.filter((n) => n.strong) : valid;
  const dist = (n) => (n.start >= idx ? n.start - idx - 2 : idx - n.end + 0.5);
  const pick = [...pool].sort((x, y) => dist(x) - dist(y))[0];
  // name candidates: blank out numbers, brackets and punctuation (keeping positions), keep tokens that are not bank / template words
  let nameText = w;
  for (const n of nums) nameText = nameText.slice(0, n.start) + spaces(n.end - n.start) + nameText.slice(n.end);
  nameText = nameText.replace(/\[[^\]]*\]/g, (m) => spaces(m.length)).replace(/[()（）:：,·\[\]]/g, ' ');
  const names = [];
  for (const m of nameText.matchAll(/\S+/g)) {
    const t = m[0].replace(/(님이|님께서|님은|님)$/, '');
    if ([...t].length < 2 || BANK_WORDS.has(t.toLowerCase()) || BANK_RE.test(t) || NOT_NAMES.test(t) || /(했습니다|했어요|되었습니다|완료|확인)$/.test(t)) continue;
    names.push({ t, start: m.index, end: m.index + m[0].length });
  }
  const depositor = names[0]?.t ?? null;
  if (depositor === null) reasons.push('no_name');
  else if (/\p{Nd}/u.test(depositor)) reasons.push('name_has_digit');
  else if (!/^[가-힣A-Za-z]{2,10}$/.test(depositor)) reasons.push('name_shape');
  if (names.length > 1) reasons.push('several_names'); // template words next to the name: do not guess
  // the name and the amount must be on different lines or be separated by the literal word 입금; otherwise the sender's text touches the amount
  if (!reasons.length && nums.length === 1 && names.length === 1) {
    const a = nums[0]; const nm = names[0];
    const between = nm.start < a.start ? w.slice(nm.end, a.start) : w.slice(a.end, nm.start);
    if (!between.includes('\n') && !between.includes('입금')) reasons.push('amount_adjacent_to_name');
  }
  if (String(rawText).length > 300) reasons.push('text_too_long');
  const review = IGNORE_WORD_RE.test(text) || String(rawText).length > 300; // contains 입금 AND a reversal / correction / withdrawal word (or is oddly long): manual review, never auto
  if (IGNORE_WORD_RE.test(text)) reasons.unshift('ignore_word');
  const amount = pick ? pick.v : null;
  return { kind: review ? 'review' : 'deposit', amount, depositor, autoEligible: !reasons.length && amount !== null, reasons };
}
const depKey = (x) => String(x).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
// auto-confirm name rule: equal after normalisation, nothing else (a prefix rule would let a guest guess only the first characters of someone's name)
function sameDepositor(noticeName, orderName) {
  const x = depKey(noticeName); const y = depKey(orderName);
  return !!x && !!y && x === y;
}
const PAY_DEFAULT = { bank: '', account: '', holder: '', tossEnabled: false, kakaoPayUrl: '', requireDepositor: false, changedAt: null };

function createStore({ dataDir, menu, rewards, tableCount, limits = {}, maxDbBytes = 256 * 1024 * 1024, backupSkipBytes = 128 * 1024 * 1024, memberEnabled = false, photoMaxBytes = 40 * 1024 * 1024, payEnv = {}, waitCallTimeoutMin = 5 }) {
  const L = { seatPlayGapMs: 1000, seatPlayMax: 300, seatOpenMax: 20, memberOrderMax: 20, ...limits };
  const waitTimes = []; // ponytail: in-memory insert times for the global wait-list rate cap (resets on restart)
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'booth.db'));
  db.exec(SCHEMA);
  // migrations for databases created by older code (CREATE TABLE IF NOT EXISTS does not touch existing tables)
  const colsOf = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  if (!colsOf('orders').includes('member_discount')) db.exec('ALTER TABLE orders ADD COLUMN member_discount INTEGER NOT NULL DEFAULT 0');
  if (!colsOf('orders').includes('member_id')) db.exec('ALTER TABLE orders ADD COLUMN member_id INTEGER');
  for (const [col, ddl] of [['depositor', 'TEXT'], ['paid_by', 'TEXT'], ['notice_id', 'INTEGER']]) {
    if (!colsOf('orders').includes(col)) db.exec(`ALTER TABLE orders ADD COLUMN ${col} ${ddl}`);
  }
  if (!colsOf('orders').includes('paid_amount')) {
    for (const [col, ddl] of [['created_by', 'TEXT'], ['member_rule', 'TEXT'], ['paid_amount', 'INTEGER NOT NULL DEFAULT 0'], ['paid_method', 'TEXT'], ['paid_at', 'INTEGER'],
      ['written_off', 'INTEGER NOT NULL DEFAULT 0'], ['written_off_at', 'INTEGER'], ['written_off_clear', 'INTEGER']]) {
      if (!colsOf('orders').includes(col)) db.exec(`ALTER TABLE orders ADD COLUMN ${col} ${ddl}`);
    }
    // what was marked paid before is taken as paid in full, by the method it was confirmed with
    db.exec("UPDATE orders SET paid_amount=total, paid_method=CASE WHEN paid_by='auto' THEN 'transfer' ELSE 'other' END, paid_at=updated_at WHERE paid=1 AND total>0");
    // orders from before member_rule existed keep their discount when edited: a fixed rule equal to what they got
    db.exec("UPDATE orders SET member_rule=json_object('mode','fixed','pct',0,'amount',member_discount,'maxDiscount',0,'minOrder',0,'legacy',1) WHERE member_discount>0 AND member_rule IS NULL");
  }
  if (!colsOf('audit_log').includes('summary_ko')) db.exec('ALTER TABLE audit_log ADD COLUMN summary_ko TEXT');
  if (!colsOf('order_items').includes('service')) db.exec('ALTER TABLE order_items ADD COLUMN service INTEGER NOT NULL DEFAULT 0');
  if (!colsOf('menu_items').includes('stock_left')) db.exec('ALTER TABLE menu_items ADD COLUMN stock_left INTEGER');
  if (!colsOf('menu_items').includes('stock_auto')) db.exec('ALTER TABLE menu_items ADD COLUMN stock_auto INTEGER NOT NULL DEFAULT 0');
  if (!colsOf('waitlist').includes('recalled')) db.exec('ALTER TABLE waitlist ADD COLUMN recalled INTEGER NOT NULL DEFAULT 0');
  for (const [col, ddl] of [['duplicate_of', 'INTEGER'], ['reasons', 'TEXT'], ['amount_guessed', 'INTEGER NOT NULL DEFAULT 0'], ['repeat_count', 'INTEGER NOT NULL DEFAULT 1'], ['last_at', 'INTEGER']]) {
    if (!colsOf('deposit_notices').includes(col)) db.exec(`ALTER TABLE deposit_notices ADD COLUMN ${col} ${ddl}`);
  }
  if (!colsOf('menu_items').includes('photo')) db.exec('ALTER TABLE menu_items ADD COLUMN photo TEXT');
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
  let dryMode = false; // dry(): every tx runs and is rolled back, so a preview shows exactly what the real call would do and writes nothing
  const dry = (fn) => { dryMode = true; try { return fn(); } finally { dryMode = false; } };
  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec(dryMode ? 'ROLLBACK' : 'COMMIT'); return r; } catch (e) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
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
  { // the table count is a staff setting; tables.json only seeds it on the first boot
    const tc = get("SELECT v FROM settings WHERE k='table_count'");
    if (tc) tableCount = Number(tc.v); else run("INSERT INTO settings(k,v) VALUES('table_count',?)", String(tableCount));
  }
  for (let i = 1; i <= tableCount; i++) {
    if (!get('SELECT 1 FROM tables WHERE id=?', i)) run('INSERT INTO tables(id, token) VALUES(?,?)', i, crypto.randomBytes(12).toString('base64url'));
  }

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
  // append-only log of staff actions (never PINs, tokens, secrets or account numbers); kept to the newest 5000 rows.
  // Money-moving actions call this INSIDE their transaction.
  const W = (n) => `${Number(n).toLocaleString('en-US')}원`;
  const MKO = { transfer: '계좌이체', cash: '현금', other: '기타' };
  const SKO = { pending: '접수 대기', cooking: '조리 중', served: '서빙 완료', cancelled: '취소' };
  function audit(action, target, summary, ko) { // `summary` machine text (English), `ko` the Korean sentence staff read; never secrets
    run('INSERT INTO audit_log(at,action,target,summary,summary_ko) VALUES(?,?,?,?,?)', now(), String(action), String(target ?? ''), String(summary ?? '').slice(0, 200), String(ko ?? summary ?? '').slice(0, 200));
    run('DELETE FROM audit_log WHERE id <= (SELECT MAX(id) FROM audit_log) - 5000');
  }
  const nextTs = (o) => Math.max(now(), (o ? o.updated_at : 0) + 1); // updated_at strictly increases per order (stale detection)
  // re-reads the order (call inside a tx) and rejects a stale client view: 409 stale + the current order
  function freshOrder(id, expectedUpdatedAt) {
    const o = get('SELECT * FROM orders WHERE id=?', id) || fail(404, 'no_order', '없는 주문입니다.');
    if (expectedUpdatedAt != null) {
      if (!Number.isInteger(expectedUpdatedAt)) fail(400, 'bad_expected', 'expectedUpdatedAt은 정수여야 합니다.');
      if (expectedUpdatedAt !== o.updated_at) fail(409, 'stale', '다른 직원이 먼저 이 주문을 바꿨습니다. 최신 상태를 확인해 주세요.', { order: orderById(id) });
    }
    return o;
  }
  // per-item stock counter (null = unlimited). Both helpers run inside the order transaction.
  function takeStock(itemId, qty) {
    const r = get('SELECT name, stock_left, sold_out FROM menu_items WHERE id=?', itemId);
    if (!r || r.stock_left == null) return;
    if (r.stock_left < qty) fail(409, 'insufficient_stock', `${r.name}은(는) ${r.stock_left}개만 남았습니다.`, { id: itemId, left: r.stock_left, ids: [itemId], names: [r.name], items: [{ id: itemId, name: r.name, left: r.stock_left }] });
    const left = r.stock_left - qty;
    run('UPDATE menu_items SET stock_left=? WHERE id=?', left, itemId);
    if (left === 0 && !r.sold_out) run('UPDATE menu_items SET sold_out=1, stock_auto=1 WHERE id=?', itemId); // automatic sold-out
  }
  function giveStock(itemId, qty) {
    const r = get('SELECT stock_left, stock_auto FROM menu_items WHERE id=?', itemId);
    if (!r || r.stock_left == null) return;
    const left = Math.min(9999, r.stock_left + qty);
    run('UPDATE menu_items SET stock_left=? WHERE id=?', left, itemId);
    if (left > 0 && r.stock_auto) run('UPDATE menu_items SET sold_out=0, stock_auto=0 WHERE id=?', itemId); // only an AUTOMATIC sold-out is lifted
  }
  // refund bookkeeping: the open refund entries of an order always add up to what is still owed to the guest
  const refundDoneSum = (oid) => get('SELECT COALESCE(SUM(amount),0) s FROM refunds WHERE order_id=? AND done_at IS NOT NULL', oid).s;
  // ONE definition of "money held" and "still to pay": received minus refunds already handed back
  const heldSql = (a = 'orders') => `(${a}.paid_amount - COALESCE((SELECT SUM(r.amount) FROM refunds r WHERE r.order_id=${a}.id AND r.done_at IS NOT NULL), 0))`;
  const heldOf = (o) => o.paid_amount - refundDoneSum(o.id);
  const balanceOf = (o) => Math.max(0, o.total - heldOf(o));
  const refundOpenSum = (oid) => get('SELECT COALESCE(SUM(amount),0) s FROM refunds WHERE order_id=? AND done_at IS NULL', oid).s;
  function syncRefund(oid, reason, ts) { // inside a tx, after the order row changed
    const o = get('SELECT * FROM orders WHERE id=?', oid);
    const target = o.status === 'cancelled' ? Math.max(0, heldOf(o)) : Math.max(0, heldOf(o) - o.total);
    let open = refundOpenSum(oid);
    if (target > open) run('INSERT INTO refunds(order_id,amount,reason,created_at) VALUES(?,?,?,?)', oid, target - open, reason, ts ?? now());
    else if (target < open) {
      for (const e of all('SELECT id, amount FROM refunds WHERE order_id=? AND done_at IS NULL ORDER BY id DESC', oid)) {
        if (open <= target) break;
        const cut = Math.min(e.amount, open - target);
        if (cut === e.amount) run('DELETE FROM refunds WHERE id=?', e.id); else run('UPDATE refunds SET amount=amount-? WHERE id=?', cut, e.id);
        open -= cut;
      }
    }
  }
  const clearWrittenOff = (oid) => run('UPDATE orders SET written_off=0, written_off_at=NULL, written_off_clear=NULL WHERE id=? AND written_off=1', oid);
  // adds money received for an order (inside a tx): partial payments keep the order unpaid with a balance, overpayments create a refund entry
  function addPayment(o, amount, method, by, ts, noticeId) {
    const paidAmount = o.paid_amount + amount;
    const net = heldOf({ ...o, paid_amount: paidAmount });
    const flag = net >= o.total && (paidAmount > 0 || o.total === 0) ? 1 : 0;
    run('UPDATE orders SET paid=?, paid_amount=?, paid_method=?, paid_at=?, paid_by=?, notice_id=COALESCE(?, notice_id), updated_at=? WHERE id=?',
      flag, paidAmount, method, flag ? ts : o.paid_at, by, noticeId ?? null, nextTs(o), o.id);
    if (amount > 0) run('INSERT INTO payments(order_id,amount,method,at) VALUES(?,?,?,?)', o.id, amount, method, ts); // per-payment ledger (sales by method)
    if (flag) clearWrittenOff(o.id);
    syncRefund(o.id, 'overpaid');
  }
  // guests get visible items only; admin=true (staff) also gets hidden ones plus ids/sort/usage
  function menuView(admin = false) {
    const cats = all('SELECT id, name, sort FROM menu_categories ORDER BY sort, id');
    const rows = all(`SELECT i.*, c.name cat${admin ? ', (SELECT COUNT(*) FROM order_items oi WHERE oi.item_id=i.id) used' : ''} FROM menu_items i JOIN menu_categories c ON c.id=i.category_id ORDER BY c.sort, c.id, i.sort, i.rowid`);
    const vis = admin ? rows : rows.filter((r) => !r.hidden);
    const out = {
      categories: (admin ? cats : cats.filter((c) => vis.some((r) => r.category_id === c.id))).map((c) => c.name),
      items: vis.map((r) => ({
        id: r.id, name: r.name, price: r.price, cat: r.cat, desc: r.descr, soldOut: !!r.sold_out, photo: r.photo ? '/photos/' + r.photo : null,
        stockLeft: admin ? (r.stock_left ?? null) : (r.stock_left != null && r.stock_left <= 5 ? r.stock_left : null), // guests only see small counts ("N개 남음")
        ...(admin ? { hidden: !!r.hidden, sortOrder: r.sort, categoryId: r.category_id, inUse: r.used > 0, stockAuto: !!r.stock_auto } : {}),
      })),
    };
    if (admin) out.categoryList = cats.map((c) => ({ id: c.id, name: c.name, sortOrder: c.sort, itemCount: rows.filter((r) => r.category_id === c.id).length }));
    return out;
  }
  function setSoldOut(itemId, soldOut) {
    if (run('UPDATE menu_items SET sold_out=?, stock_auto=0 WHERE id=?', soldOut ? 1 : 0, itemId).changes !== 1) fail(404, 'no_item', '없는 메뉴입니다.'); // a manual toggle is never undone by the stock counter
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

  const checkStockLeft = (v) => { if (!Number.isInteger(v) || v < 0 || v > 9999) fail(400, 'bad_stock_left', '남은 수량은 0~9999 사이 정수이거나 비워 두어야 합니다.'); return v; };
  function createItem(body) {
    const name = cleanLabel(body.name, 1, 30, 'bad_name', '메뉴 이름');
    const price = checkPrice(body.price);
    const descr = body.desc == null ? '' : cleanLabel(body.desc, 0, 60, 'bad_desc', '설명');
    const cat = cleanLabel(body.category, 1, 12, 'bad_category', '카테고리 이름');
    if (body.hidden != null && typeof body.hidden !== 'boolean') fail(400, 'bad_hidden', 'hidden은 true/false여야 합니다.');
    const stockLeft = body.stockLeft == null ? null : checkStockLeft(body.stockLeft);
    if (nameTaken(name)) fail(409, 'name_taken', '같은 이름의 메뉴가 이미 있습니다.');
    if (get('SELECT COUNT(*) n FROM menu_items').n >= MENU_MAX_ITEMS) fail(409, 'too_many_items', `메뉴는 ${MENU_MAX_ITEMS}개까지 만들 수 있습니다.`);
    const id = tx(() => {
      const nid = 'm' + crypto.randomBytes(5).toString('hex');
      run('INSERT INTO menu_items(id,name,price,category_id,descr,hidden,sort,stock_left,sold_out,stock_auto) VALUES(?,?,?,?,?,?,(SELECT COALESCE(MAX(sort), -1) + 1 FROM menu_items),?,?,?)', nid, name, price, categoryByName(cat), descr, body.hidden ? 1 : 0, stockLeft, stockLeft === 0 ? 1 : 0, stockLeft === 0 ? 1 : 0);
      audit('menu_create', `item ${nid}`, `price ${price}`, `메뉴 추가 · ${name} · ${W(price)}`);
      return nid;
    });
    return adminItem(id);
  }
  function updateItem(id, body) {
    const cur = get('SELECT * FROM menu_items WHERE id=?', id) || fail(404, 'no_item', '없는 메뉴입니다.');
    const has = (k) => Object.hasOwn(body, k);
    if (!['name', 'price', 'category', 'desc', 'hidden', 'sortOrder', 'stockLeft'].some(has)) fail(400, 'nothing_to_update', '바꿀 항목이 없습니다.');
    const name = has('name') ? cleanLabel(body.name, 1, 30, 'bad_name', '메뉴 이름') : cur.name;
    const price = has('price') ? checkPrice(body.price) : cur.price;
    const descr = has('desc') ? cleanLabel(body.desc, 0, 60, 'bad_desc', '설명') : cur.descr;
    const cat = has('category') ? cleanLabel(body.category, 1, 12, 'bad_category', '카테고리 이름') : null;
    if (has('hidden') && typeof body.hidden !== 'boolean') fail(400, 'bad_hidden', 'hidden은 true/false여야 합니다.');
    if (has('sortOrder') && (!Number.isInteger(body.sortOrder) || body.sortOrder < 0 || body.sortOrder > 100000)) fail(400, 'bad_sort', 'sortOrder가 올바르지 않습니다.');
    const stockLeft = has('stockLeft') ? (body.stockLeft === null ? null : checkStockLeft(body.stockLeft)) : cur.stock_left;
    if (nameTaken(name, id)) fail(409, 'name_taken', '같은 이름의 메뉴가 이미 있습니다.');
    tx(() => {
      run('UPDATE menu_items SET name=?, price=?, descr=?, category_id=?, hidden=?, sort=? WHERE id=?', name, price, descr, cat ? categoryByName(cat) : cur.category_id,
        has('hidden') ? (body.hidden ? 1 : 0) : cur.hidden, has('sortOrder') ? body.sortOrder : cur.sort, id);
      if (has('stockLeft')) { // 0 = automatic sold-out; raising it (or clearing the limit) lifts an AUTOMATIC sold-out only
        run('UPDATE menu_items SET stock_left=? WHERE id=?', stockLeft, id);
        if (stockLeft === 0 && !cur.sold_out) run('UPDATE menu_items SET sold_out=1, stock_auto=1 WHERE id=?', id);
        else if ((stockLeft === null || stockLeft > 0) && cur.stock_auto) run('UPDATE menu_items SET sold_out=0, stock_auto=0 WHERE id=?', id);
      }
      const ch = [];
      const ko = [];
      if (price !== cur.price) { ch.push(`price ${cur.price}→${price}`); ko.push(`가격 ${W(cur.price)}→${W(price)}`); }
      if (name !== cur.name) { ch.push('name'); ko.push(`이름 ${cur.name}→${name}`); }
      if (has('hidden') && !!cur.hidden !== body.hidden) { ch.push(body.hidden ? 'hidden' : 'shown'); ko.push(body.hidden ? '숨김' : '표시'); }
      if (has('stockLeft')) { ch.push(`stock ${cur.stock_left ?? '∞'}→${stockLeft ?? '∞'}`); ko.push(`재고 ${cur.stock_left ?? '무제한'}→${stockLeft ?? '무제한'}`); }
      if (ch.length) audit('menu_update', `item ${id}`, ch.join(', '), `메뉴 수정 · ${name} · ${ko.join(' · ')}`);
    });
    return adminItem(id);
  }
  function deleteItem(id) {
    if (!get('SELECT 1 FROM menu_items WHERE id=?', id)) fail(404, 'no_item', '없는 메뉴입니다.');
    if (get('SELECT 1 FROM order_items WHERE item_id=? LIMIT 1', id)) fail(409, 'in_use', '주문 내역이 있는 메뉴는 삭제할 수 없습니다. 숨김 처리해 주세요.');
    const photo = get('SELECT photo FROM menu_items WHERE id=?', id).photo;
    run('DELETE FROM menu_items WHERE id=?', id);
    removePhotoFile(photo);
  }

  // ---------- photos (files live in DATA_DIR/photos, not in the SQLite backup) ----------
  const photosDir = path.join(dataDir, 'photos');
  fs.mkdirSync(photosDir, { recursive: true });
  function removePhotoFile(name) { if (name && PHOTO_NAME_RE.test(name)) { try { fs.unlinkSync(path.join(photosDir, name)); } catch { /* already gone */ } } }
  const photoBytes = (except) => fs.readdirSync(photosDir).filter((f) => PHOTO_NAME_RE.test(f) && f !== except).reduce((n, f) => n + fs.statSync(path.join(photosDir, f)).size, 0);
  function sniffImage(b) {
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    return null;
  }
  function setPhoto(itemId, buf, declaredType) {
    const row = get('SELECT rowid AS rid, photo FROM menu_items WHERE id=?', itemId) || fail(404, 'no_item', '없는 메뉴입니다.');
    if (!PHOTO_EXT[declaredType]) fail(415, 'unsupported_media_type', 'JPEG, PNG, WebP 이미지만 올릴 수 있습니다.');
    const real = buf.length ? sniffImage(buf) : null;
    if (!real) fail(400, 'bad_image', '이미지 파일이 아닙니다.');
    if (real !== declaredType) fail(415, 'type_mismatch', '선언한 형식과 실제 이미지 형식이 다릅니다.');
    if (photoBytes(row.photo) + buf.length > photoMaxBytes) fail(409, 'photo_storage_full', '사진 저장 공간이 가득 찼습니다. 안 쓰는 사진을 지워 주세요.');
    const name = `${row.rid}-${crypto.randomBytes(4).toString('hex')}.${PHOTO_EXT[real]}`;
    const tmp = path.join(photosDir, `.${crypto.randomBytes(6).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(tmp, buf, { flag: 'wx' });
      fs.renameSync(tmp, path.join(photosDir, name)); // atomic: readers never see a half-written photo
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
      if (e.code === 'ENOSPC') fail(503, 'storage_full', '저장 공간이 가득 찼습니다. 직원에게 문의해 주세요.');
      throw e;
    }
    try { run('UPDATE menu_items SET photo=? WHERE id=?', name, itemId); } catch (e) { removePhotoFile(name); throw e; }
    removePhotoFile(row.photo);
    return adminItem(itemId);
  }
  function deletePhoto(itemId) {
    const row = get('SELECT photo FROM menu_items WHERE id=?', itemId) || fail(404, 'no_item', '없는 메뉴입니다.');
    run('UPDATE menu_items SET photo=NULL WHERE id=?', itemId);
    removePhotoFile(row.photo);
    return adminItem(itemId);
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
  // ---- member discount settings (one JSON value in settings; the old member_discount_pct is migrated into it) ----
  const memberDefaults = () => ({ enabled: true, mode: 'percent', pct: 10, amount: 1000, minOrder: 0, maxDiscount: 0, includeAssociate: true, perMemberLimit: Math.min(100, L.memberOrderMax), stackWithCoupon: true });
  function memberSettings() {
    const v = setting('member_discount', null);
    if (v) { try { return { ...memberDefaults(), ...JSON.parse(v) }; } catch { /* fall through to defaults */ } }
    const d = memberDefaults();
    const old = setting('member_discount_pct', null);
    if (old != null && Number.isInteger(Number(old)) && Number(old) >= 0 && Number(old) <= 50) d.pct = Number(old);
    return d;
  }
  const memberPct = () => memberSettings().pct;
  function setMemberSettings(body) {
    const cur = memberSettings();
    const has = (k) => Object.hasOwn(body, k);
    if (!['enabled', 'mode', 'pct', 'amount', 'minOrder', 'maxDiscount', 'includeAssociate', 'perMemberLimit', 'stackWithCoupon'].some(has)) fail(400, 'nothing_to_update', '바꿀 항목이 없습니다.');
    const bool = (k, code) => { if (has(k)) { if (typeof body[k] !== 'boolean') fail(400, code, `${k}는 true/false여야 합니다.`); cur[k] = body[k]; } };
    const won = (k, code, max) => {
      if (!has(k)) return;
      if (!Number.isInteger(body[k]) || body[k] < 0 || body[k] > max || body[k] % 100 !== 0) fail(400, code, `${k}는 0~${max} 사이 100원 단위여야 합니다.`);
      cur[k] = body[k];
    };
    bool('enabled', 'bad_enabled'); bool('includeAssociate', 'bad_include_associate'); bool('stackWithCoupon', 'bad_stack_with_coupon');
    if (has('mode')) { if (body.mode !== 'percent' && body.mode !== 'fixed') fail(400, 'bad_mode', "mode는 'percent' 또는 'fixed' 여야 합니다."); cur.mode = body.mode; }
    if (has('pct')) { if (!Number.isInteger(body.pct) || body.pct < 0 || body.pct > 50) fail(400, 'bad_pct', '할인율은 0~50 사이 정수여야 합니다.'); cur.pct = body.pct; }
    won('amount', 'bad_amount', 50000); won('minOrder', 'bad_min_order', 1000000); won('maxDiscount', 'bad_max_discount', 1000000);
    if (has('perMemberLimit')) { if (!Number.isInteger(body.perMemberLimit) || body.perMemberLimit < 1 || body.perMemberLimit > 100) fail(400, 'bad_per_member_limit', 'perMemberLimit은 1~100 사이 정수여야 합니다.'); cur.perMemberLimit = body.perMemberLimit; }
    tx(() => { run("INSERT INTO settings(k,v) VALUES('member_discount',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", JSON.stringify(cur)); audit('member_discount', 'settings', `${cur.enabled ? 'on' : 'off'}, ${cur.mode} ${cur.mode === 'percent' ? cur.pct + '%' : cur.amount + ' won'}, min ${cur.minOrder}, cap ${cur.maxDiscount}`, `회원 할인 설정 · ${cur.enabled ? '켜짐' : '꺼짐'} · ${cur.mode === 'percent' ? `${cur.pct}%` : W(cur.amount)} · 최소 주문 ${W(cur.minOrder)} · 상한 ${cur.maxDiscount ? W(cur.maxDiscount) : '없음'}`); });
    return cur;
  }
  // staff banner shown on the guest page, the wait page and the board
  function bannerOut() {
    const v = setting('notice', null);
    if (!v) return null;
    try { const n = JSON.parse(v); return n.text ? { text: n.text, level: n.level } : null; } catch { return null; }
  }
  function setNotice(body) {
    const level = body.level ?? 'info';
    if (level !== 'info' && level !== 'warn') fail(400, 'bad_level', "level은 'info' 또는 'warn' 이어야 합니다.");
    const text = cleanLabel(body.text ?? '', 0, 80, 'bad_text', '공지');
    const was = bannerOut();
    tx(() => {
      if (!text) run("DELETE FROM settings WHERE k='notice'");
      else run("INSERT INTO settings(k,v) VALUES('notice',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", JSON.stringify({ text, level }));
      audit('notice', 'banner', `${was ? `${was.level}: ${was.text}` : '(none)'} → ${text ? `${level}: ${text}` : 'cleared'}`, `공지 ${text ? `변경 · ${was ? `“${was.text}” → ` : ''}“${text}”` : '내림'}`);
    });
    invalidate();
    return bannerOut();
  }
  function setOrdering(open) { tx(() => { const was = orderingOpen(); run('INSERT INTO settings(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v', 'ordering_open', open ? '1' : '0'); audit('ordering', 'settings', `${was}→${!!open}`, `주문 받기 ${open ? '켬' : '끔'}`); }); }

  const ITEMS_SQL = 'SELECT item_id, name, unit_price, qty, service FROM order_items WHERE order_id=? ORDER BY rowid';
  const loadOrders = (rows) => rows.map((o) => {
    const cancelled = o.status === 'cancelled';
    const refunded = refundDoneSum(o.id);
    const target = cancelled ? o.paid_amount - refunded : Math.max(0, o.paid_amount - refunded - o.total);
    return {
      id: o.id, table: o.table_id, seat: o.seat, status: o.status, paid: !!o.paid,
      items: all(ITEMS_SQL, o.id).map((it) => ({ id: it.item_id, name: it.name, qty: it.qty, unitPrice: it.unit_price, service: !!it.service })),
      subtotal: o.subtotal, discount: o.discount + o.member_discount, memberDiscount: o.member_discount, couponDiscount: o.discount,
      member: o.member_id != null, total: o.total, couponCode: o.coupon_code, note: o.note,
      depositor: o.depositor ?? null, paidBy: o.paid_by ?? null,
      createdBy: o.created_by || 'guest', memberRule: o.member_rule ? JSON.parse(o.member_rule) : null,
      paidAmount: o.paid_amount, paidMethod: o.paid_method ?? null, paidAt: o.paid_at ?? null,
      balanceDue: cancelled || o.paid ? 0 : balanceOf(o),
      overpaid: cancelled ? 0 : Math.max(0, o.paid_amount - refunded - o.total),
      refundedAmount: refunded, refundDue: Math.max(0, target),
      writtenOff: !!o.written_off && !o.paid && !cancelled,
      createdAt: o.created_at, updatedAt: o.updated_at, cookingAt: o.cooking_at,
    };
  });
  const orderById = (id) => loadOrders([get('SELECT * FROM orders WHERE id=?', id)])[0];
  // the member discount rule that was applied at order time is stored on the order, so edits and audits reproduce it
  const memberDiscountFor = (rule, subtotal) => {
    if (subtotal < (rule.minOrder || 0)) return 0;
    let want = rule.mode === 'percent' ? Math.floor(subtotal * rule.pct / 10000) * 100 : rule.amount; // percent rounds DOWN to 100 won
    if (rule.maxDiscount > 0) want = Math.min(want, rule.maxDiscount);
    return Math.max(0, Math.min(want, subtotal));
  };

  // staff = null for guests; for the staff "create order" endpoint { allowHidden, accept }
  function createOrder(tableId, body, { memberId = null, memberRole = null, staff = null } = {}) {
    const t = tableRow(tableId);
    const key = body.key;
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(key)) fail(400, 'bad_key', '주문 키가 올바르지 않습니다. (8~64자 영숫자)');
    const dup = get('SELECT id FROM orders WHERE table_id=? AND seat=? AND key=?', tableId, t.seat, key);
    if (dup) return { order: orderById(dup.id), duplicate: true };
    if (!staff && !orderingOpen()) fail(409, 'closed', '지금은 주문을 받지 않습니다.'); // staff may order while ordering is closed
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
      if (!m || (m.hidden && !(staff && staff.allowHidden))) unknown.push(l.id); else rows.set(l.id, m);
    }
    if (unknown.length) fail(400, 'unknown_item', '없는 메뉴가 있습니다.', { ids: unknown });
    const gone = lines.filter((l) => rows.get(l.id).sold_out && !rows.get(l.id).hidden).map((l) => l.id); // hidden items (staff only) are not sold-out checked
    if (gone.length) fail(409, 'sold_out', '품절된 메뉴가 있습니다.', { ids: gone, names: gone.map((id) => rows.get(id).name) });
    const short = lines.filter((l) => rows.get(l.id).stock_left != null && l.qty > rows.get(l.id).stock_left);
    if (short.length) {
      fail(409, 'insufficient_stock', '남은 수량이 부족한 메뉴가 있습니다.', {
        id: short[0].id, left: rows.get(short[0].id).stock_left, ids: short.map((l) => l.id), names: short.map((l) => rows.get(l.id).name),
        items: short.map((l) => ({ id: l.id, name: rows.get(l.id).name, left: rows.get(l.id).stock_left })),
      });
    }
    if (!staff && body.expectedTotal != null && !Number.isInteger(body.expectedTotal)) fail(400, 'bad_expected_total', 'expectedTotal은 정수여야 합니다.');
    let note = '';
    if (body.note != null) {
      if (typeof body.note !== 'string') fail(400, 'bad_note', '요청 사항이 올바르지 않습니다.');
      note = body.note.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').trim();
      if ([...note].length > 100) fail(400, 'bad_note', '요청 사항은 100자 이내로 적어 주세요.');
    }
    let depositor = null;
    if (body.depositor != null && body.depositor !== '') depositor = cleanDepositor(body.depositor);
    else if (!staff && payAll().requireDepositor) fail(400, 'depositor_required', '입금자명을 입력해 주세요.');
    if (get('SELECT COUNT(*) n FROM orders WHERE table_id=? AND seat=?', tableId, t.seat).n >= MAX_ORDERS_PER_SEAT * (staff ? 2 : 1)) {
      fail(429, 'too_many_orders', '이 테이블에서 받을 수 있는 주문 수를 넘었습니다. 직원에게 문의해 주세요.');
    }
    if (!staff && get("SELECT COUNT(*) n FROM orders WHERE table_id=? AND seat=? AND status='pending'", tableId, t.seat).n >= MAX_PENDING_PER_TABLE) {
      fail(429, 'too_many_pending', '접수 대기 중인 주문이 너무 많습니다. 직원에게 문의해 주세요.');
    }
    const subtotal = lines.reduce((s, l) => s + rows.get(l.id).price * l.qty, 0);
    // 1) the selected coupon is validated, 2) member discount (rule from the staff settings), 3) the coupon on what is left; total never below 0
    let couponRow = null;
    if (body.couponCode != null && body.couponCode !== '') {
      if (staff) fail(400, 'coupon_not_allowed', '직원이 만드는 주문에는 쿠폰을 적용할 수 없습니다.');
      couponRow = get('SELECT * FROM coupons WHERE code=?', String(body.couponCode).trim().toUpperCase());
      if (!couponRow || couponRow.table_id !== tableId || couponRow.seat !== t.seat) fail(400, 'bad_coupon', '쿠폰을 찾을 수 없습니다.');
      if (couponRow.status === 'void') fail(409, 'coupon_void', '무효 처리된 쿠폰입니다.');
      if (couponRow.status !== 'issued') fail(409, 'coupon_used', '이미 사용된 쿠폰입니다.');
      if (couponRow.type !== 'discount') fail(400, 'coupon_not_discount', '할인 쿠폰만 주문에 적용할 수 있습니다. 이 쿠폰은 직원에게 보여 주세요.');
    }
    const ms = memberSettings();
    const eligible = !staff && memberId != null && ms.enabled && (ms.includeAssociate || memberRole !== 'ASSOCIATE');
    let memberDiscount = 0;
    let memberDiscountSkipped = null;
    let memberRule = null;
    if (eligible) {
      const rule = { mode: ms.mode, pct: ms.pct, amount: ms.amount, maxDiscount: ms.maxDiscount, minOrder: ms.minOrder };
      const want = memberDiscountFor(rule, subtotal);
      if (want > 0) {
        if (couponRow && !ms.stackWithCoupon) memberDiscountSkipped = 'coupon';
        else if (get("SELECT COUNT(*) n FROM orders WHERE member_id=? AND member_discount>0 AND status!='cancelled'", memberId).n >= ms.perMemberLimit) memberDiscountSkipped = 'limit';
        else { memberDiscount = want; memberRule = JSON.stringify(rule); }
      }
    }
    let discount = 0;
    let coupon = couponRow;
    let couponIgnored = false;
    if (coupon) {
      discount = Math.min(coupon.amount, subtotal - memberDiscount);
      if (discount <= 0) { coupon = null; discount = 0; couponIgnored = true; } // nothing to discount: do not burn the coupon
    }
    const total = subtotal - memberDiscount - discount;
    if (!staff && body.expectedTotal != null && body.expectedTotal !== total) {
      fail(409, 'price_changed', '가격이 바뀌었습니다. 금액을 다시 확인해 주세요.', {
        expectedTotal: body.expectedTotal, total, subtotal, memberDiscount, couponDiscount: discount,
        items: lines.map((l) => ({ id: l.id, name: rows.get(l.id).name, qty: l.qty, unitPrice: rows.get(l.id).price })),
      });
    }
    let preview = null; // built inside the transaction so a dry run (rolled back) can still return it
    const id = tx(() => {
      const ts = now();
      const cooking = !!(staff && staff.accept);
      const oid = run('INSERT INTO orders(table_id,seat,key,status,subtotal,discount,member_discount,member_id,total,coupon_code,note,created_at,updated_at,depositor,cooking_at,created_by,member_rule) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        tableId, t.seat, key, cooking ? 'cooking' : 'pending', subtotal, discount, memberDiscount, eligible ? memberId : null, total, coupon ? coupon.code : null, note, ts, ts, depositor,
        cooking ? ts : null, staff ? 'staff' : 'guest', memberRule).lastInsertRowid;
      for (const l of lines) {
        const m = rows.get(l.id); // name and unit price are frozen into the order here
        run('INSERT INTO order_items(order_id,item_id,name,unit_price,qty) VALUES(?,?,?,?,?)', oid, m.id, m.name, m.price, l.qty);
        takeStock(m.id, l.qty);
      }
      if (coupon && run("UPDATE coupons SET status='used', order_id=?, used_at=? WHERE code=? AND status='issued'", oid, ts, coupon.code).changes !== 1) {
        fail(409, 'coupon_used', '이미 사용된 쿠폰입니다.');
      }
      if (staff) audit('order_create_staff', `order #${oid}`, `table ${tableId}, total ${total}${cooking ? ', cooking' : ''}`, `주문 #${oid} 직원 입력 · ${tableId}번 테이블 · ${W(total)}${cooking ? ' · 바로 접수' : ''}`);
      preview = orderById(Number(oid));
      return Number(oid);
    });
    return { order: preview, duplicate: false, ...(memberDiscountSkipped ? { memberDiscountSkipped } : {}), ...(couponIgnored ? { couponIgnored: true } : {}) };
  }

  function setStatus(id, status, expectedUpdatedAt) {
    if (!ORDER_STATUSES.includes(status)) fail(400, 'bad_status', '상태 값이 올바르지 않습니다.');
    return tx(() => {
      const o = freshOrder(id, expectedUpdatedAt);
      if (o.status === 'cancelled') fail(409, 'order_cancelled', '취소된 주문은 바꿀 수 없습니다.');
      if (o.status !== status) {
        const ts = nextTs(o);
        run('UPDATE orders SET status=?, updated_at=?, cooking_at=? WHERE id=?', status, ts, status === 'cooking' ? ts : o.cooking_at, id);
        if (status !== 'cancelled') audit('order_status', `order #${id}`, `${o.status}→${status}`, `주문 #${id} ${SKO[o.status]} → ${SKO[status]}`);
        if (status === 'cancelled') {
          if (o.coupon_code) run("UPDATE coupons SET status='issued', order_id=NULL, used_at=NULL WHERE code=? AND order_id=?", o.coupon_code, id);
          for (const l of all('SELECT item_id, qty FROM order_items WHERE order_id=?', id)) giveStock(l.item_id, l.qty);
          syncRefund(id, 'cancelled'); // money already received is now owed back
          audit('order_cancel', `order #${id}`, `table ${o.table_id}, paid ${o.paid_amount} won`, `주문 #${id} 취소 · ${o.table_id}번 테이블${heldOf(o) > 0 ? ` · 환불 대기 ${W(heldOf(o))}` : ''}`);
        }
      }
      return orderById(id);
    });
  }
  const PAY_METHODS = ['transfer', 'cash', 'other'];
  // paid:true adds a payment (amount defaults to the remaining balance); paid:false undoes all payments of the order
  function setPaid(id, paid, opts = {}) {
    if (typeof paid !== 'boolean') fail(400, 'bad_paid', 'paid는 true/false여야 합니다.');
    const method = opts.method ?? 'transfer';
    if (!PAY_METHODS.includes(method)) fail(400, 'bad_method', "method는 'transfer', 'cash', 'other' 중 하나여야 합니다.");
    if (opts.amount != null && (!Number.isInteger(opts.amount) || opts.amount < 0 || opts.amount > 10000000)) fail(400, 'bad_amount', 'amount는 0~10,000,000 사이 정수여야 합니다.');
    return tx(() => {
      const o = freshOrder(id, opts.expectedUpdatedAt);
      if (o.status === 'cancelled') fail(409, 'order_cancelled', '취소된 주문입니다.');
      const ts = now();
      if (paid) {
        if (o.paid && opts.amount == null) fail(409, 'stale', '이미 입금 확인된 주문입니다.', { order: orderById(id) }); // a second tap on another phone must not double-apply
        const amount = opts.amount ?? balanceOf(o);
        if (amount === 0 && o.total > 0) fail(400, 'bad_amount', '입금액은 0보다 커야 합니다.');
        addPayment(o, amount, method, 'staff', ts, null);
        audit('order_paid', `order #${id}`, `${method} ${amount} won (total ${o.total})`, `주문 #${id} 입금 확인 · ${MKO[method]} ${W(amount)} · 잔액 ${W(balanceOf(get('SELECT * FROM orders WHERE id=?', id)))}`);
      } else {
        if (refundDoneSum(id) > 0) fail(409, 'has_refunds', '환불이 완료된 주문은 입금 취소할 수 없습니다.');
        // undoing an automatic confirmation hands the deposit notice back to staff
        run("UPDATE deposit_notices SET status='pending', order_id=NULL, matched_at=NULL, matched_by=NULL WHERE order_id=? AND status='matched'", id); // EVERY notice linked to the order
        run('UPDATE orders SET paid=0, paid_amount=0, paid_method=NULL, paid_at=NULL, paid_by=NULL, notice_id=NULL, updated_at=? WHERE id=?', nextTs(o), id);
        run('DELETE FROM payments WHERE order_id=?', id);
        syncRefund(id, 'overpaid');
        audit('order_unpaid', `order #${id}`, `payments of ${o.paid_amount} won cleared`, `주문 #${id} 입금 취소 · ${W(o.paid_amount)} 되돌림`);
      }
      return orderById(id);
    });
  }
  // replaces the normal lines of an order (qty 0 removes); existing lines keep their ORIGINAL price and name, new lines use today's price;
  // service lines are kept unless listed with service:true
  function editItems(id, items, { expectedUpdatedAt } = {}) {
    if (!Array.isArray(items) || items.length > 40) fail(400, 'bad_items', '주문 항목이 올바르지 않습니다.');
    const wanted = new Map();
    for (const l of items) {
      if (!l || typeof l !== 'object' || typeof l.id !== 'string' || (l.service != null && typeof l.service !== 'boolean')) fail(400, 'bad_items', '주문 항목이 올바르지 않습니다.');
      if (!Number.isInteger(l.qty) || l.qty < 0 || l.qty > 20) fail(400, 'bad_qty', '수량은 0~20 사이 정수여야 합니다.', { id: l.id });
      const k = (l.service ? 's:' : 'n:') + l.id;
      if (wanted.has(k)) fail(400, 'dup_item', '같은 메뉴가 중복되었습니다.', { id: l.id });
      wanted.set(k, { id: l.id, qty: l.qty, service: !!l.service });
    }
    return tx(() => {
      const o = freshOrder(id, expectedUpdatedAt);
      if (o.status === 'cancelled') fail(409, 'order_cancelled', '취소된 주문은 고칠 수 없습니다.');
      const cur = all('SELECT * FROM order_items WHERE order_id=? ORDER BY rowid', id);
      const key = (r) => (r.service ? 's:' : 'n:') + r.item_id;
      const next = [];
      for (const w of wanted.values()) {
        if (w.qty === 0) continue;
        const ex = cur.find((r) => key(r) === (w.service ? 's:' : 'n:') + w.id);
        if (ex) {
          const m = itemRow(w.id);
          if (w.qty > ex.qty && m && m.sold_out && !m.hidden) fail(409, 'sold_out', '품절된 메뉴가 있습니다.', { ids: [w.id], names: [m.name] });
          next.push({ item_id: ex.item_id, name: ex.name, unit_price: ex.unit_price, qty: w.qty, service: ex.service });
        } else {
          const m = itemRow(w.id) || fail(400, 'unknown_item', '없는 메뉴가 있습니다.', { ids: [w.id] });
          if (m.hidden && !w.service) fail(400, 'unknown_item', '없는 메뉴가 있습니다.', { ids: [w.id] });
          if (m.sold_out && !m.hidden) fail(409, 'sold_out', '품절된 메뉴가 있습니다.', { ids: [w.id], names: [m.name] });
          next.push({ item_id: m.id, name: m.name, unit_price: w.service ? 0 : m.price, qty: w.qty, service: w.service ? 1 : 0 });
        }
      }
      for (const r of cur) if (r.service && !wanted.has(key(r))) next.push({ item_id: r.item_id, name: r.name, unit_price: 0, qty: r.qty, service: 1 });
      if (!next.some((l) => !l.service)) fail(400, 'no_lines', '주문에는 최소 한 줄이 필요합니다. 주문을 없애려면 취소해 주세요.');
      // stock counters follow the change in quantity per item (service lines count: the item still leaves the kitchen)
      const sum = (rowsList) => { const m = new Map(); for (const r of rowsList) m.set(r.item_id, (m.get(r.item_id) || 0) + r.qty); return m; };
      const before = sum(cur); const after = sum(next);
      for (const [item, b] of before) if ((after.get(item) || 0) < b) giveStock(item, b - (after.get(item) || 0));
      for (const [item, a] of after) if (a > (before.get(item) || 0)) takeStock(item, a - (before.get(item) || 0));
      run('DELETE FROM order_items WHERE order_id=?', id);
      for (const l of next) run('INSERT INTO order_items(order_id,item_id,name,unit_price,qty,service) VALUES(?,?,?,?,?,?)', id, l.item_id, l.name, l.unit_price, l.qty, l.service);
      const subtotal = next.reduce((n, l) => n + (l.service ? 0 : l.unit_price * l.qty), 0);
      const memberDisc = o.member_rule ? memberDiscountFor(JSON.parse(o.member_rule), subtotal) : Math.min(o.member_discount, subtotal); // no stored rule (order from before member_rule existed): keep its discount
      const coupon = o.coupon_code ? get('SELECT amount FROM coupons WHERE code=?', o.coupon_code) : null;
      const couponDisc = coupon ? Math.min(coupon.amount ?? 0, Math.max(0, subtotal - memberDisc)) : 0;
      const total = subtotal - memberDisc - couponDisc;
      const ts = now();
      const net = heldOf(o);
      const flag = net >= total && (o.paid_amount > 0 || (o.paid && total === 0)) ? 1 : 0; // fully paid again / balance due / refund due all follow from the amounts held
      run('UPDATE orders SET subtotal=?, discount=?, member_discount=?, total=?, paid=?, paid_at=?, updated_at=? WHERE id=?',
        subtotal, couponDisc, memberDisc, total, flag, flag ? (o.paid ? o.paid_at : ts) : null, nextTs(o), id);
      if (flag) clearWrittenOff(id);
      syncRefund(id, 'edit_lower_total');
      { const o2 = get('SELECT * FROM orders WHERE id=?', id); const rf = refundOpenSum(id); const bl = balanceOf(o2); audit('order_edit', `order #${id}`, `total ${o.total}→${total}, paid ${o.paid_amount}`, `주문 #${id} 수정 · 합계 ${W(o.total)}→${W(total)}${rf ? ` · 환불 ${W(rf)}` : ''}${bl && o2.paid_amount > 0 ? ` · 잔액 ${W(bl)}` : ''}`); }
      return orderById(id);
    });
  }
  // a free "service" line: unit price 0, never affects totals
  function addService(id, itemId, qty, { expectedUpdatedAt } = {}) {
    if (typeof itemId !== 'string') fail(400, 'bad_items', 'itemId가 올바르지 않습니다.');
    if (!Number.isInteger(qty) || qty < 1 || qty > 20) fail(400, 'bad_qty', '수량은 1~20 사이 정수여야 합니다.');
    return tx(() => {
      const o = freshOrder(id, expectedUpdatedAt);
      if (o.status === 'cancelled') fail(409, 'order_cancelled', '취소된 주문입니다.');
      const m = itemRow(itemId) || fail(400, 'unknown_item', '없는 메뉴입니다.', { ids: [itemId] });
      if (m.sold_out && !m.hidden) fail(409, 'sold_out', '품절된 메뉴가 있습니다.', { ids: [itemId], names: [m.name] });
      const ex = get('SELECT rowid AS rid, qty FROM order_items WHERE order_id=? AND item_id=? AND service=1', id, itemId);
      if (ex && ex.qty + qty > 20) fail(400, 'bad_qty', '서비스 수량은 한 메뉴당 20개까지입니다.');
      takeStock(itemId, qty);
      if (ex) run('UPDATE order_items SET qty=qty+? WHERE rowid=?', qty, ex.rid);
      else run('INSERT INTO order_items(order_id,item_id,name,unit_price,qty,service) VALUES(?,?,?,0,?,1)', id, itemId, m.name, qty);
      run('UPDATE orders SET updated_at=? WHERE id=?', nextTs(o), id);
      audit('order_service', `order #${id}`, `${m.name} x${qty} (service)`, `주문 #${id} 서비스 · ${m.name} ${qty}개`);
      return orderById(id);
    });
  }
  // moves one order (and the coupon applied to it) to another table's current seat
  function moveOrder(id, to, { expectedUpdatedAt } = {}) {
    if (!Number.isInteger(to)) fail(400, 'bad_tables', '옮길 테이블 번호가 올바르지 않습니다.');
    return tx(() => {
      const o = freshOrder(id, expectedUpdatedAt);
      if (o.status === 'cancelled') fail(409, 'order_cancelled', '취소된 주문은 옮길 수 없습니다.');
      if (!orderVisible(o)) fail(404, 'no_order', '없는 주문입니다.');
      const B = tableRow(to);
      if (B.id === o.table_id) fail(400, 'same_table', '같은 테이블입니다.');
      run("UPDATE orders SET table_id=?, seat=?, key=? || '~m' || id, updated_at=? WHERE id=?", B.id, B.seat, o.key.replace(/~m\d+$/, ''), nextTs(o), id);
      // the coupon row is NOT moved: it stays recorded as received by its original table+seat (one reward per seat, stock accounting); it is tied to the order by order_id
      audit('order_move', `order #${id}`, `table ${o.table_id}→${B.id}`, `주문 #${id} 이동 · ${o.table_id}번 → ${B.id}번 테이블`);
      return { order: orderById(id), from: o.table_id };
    });
  }
  function cleanDepositor(v) {
    if (typeof v !== 'string') fail(400, 'bad_depositor', '입금자명이 올바르지 않습니다.');
    const t = v.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
    const n = [...t].length;
    if (n < 1 || n > 10 || !/[\p{L}\p{N}\p{S}\p{P}]/u.test(t.normalize('NFKC').replace(INVISIBLE, ''))) fail(400, 'bad_depositor', '입금자명은 보이는 글자 1~10자로 입력해 주세요.');
    return t;
  }
  function setDepositor(tableId, orderId, value) {
    const t = tableRow(tableId);
    const o = get('SELECT * FROM orders WHERE id=? AND table_id=? AND seat=?', orderId, tableId, t.seat) || fail(404, 'no_order', '없는 주문입니다.');
    if (o.status === 'cancelled') fail(409, 'order_cancelled', '취소된 주문입니다.');
    if (o.paid) fail(409, 'already_paid', '이미 입금 확인된 주문은 바꿀 수 없습니다.');
    run('UPDATE orders SET depositor=?, updated_at=? WHERE id=?', cleanDepositor(value), nextTs(o), orderId);
    return orderById(orderId);
  }
  function guestCancel(tableId, id) {
    const t = tableRow(tableId);
    const o = get('SELECT * FROM orders WHERE id=? AND table_id=? AND seat=?', id, tableId, t.seat) || fail(404, 'no_order', '없는 주문입니다.');
    if (o.status !== 'pending' || o.paid || o.paid_amount > 0) fail(409, 'not_cancellable', '이미 접수되었거나 결제된 주문은 직원에게 문의해 주세요.');
    return setStatus(id, 'cancelled');
  }

  // ---------- table count / QR rotation ----------
  const tableHasOpenOrders = (t) => get("SELECT COUNT(*) n FROM orders o JOIN tables x ON x.id=o.table_id AND x.seat=o.seat WHERE x.id=? AND o.status!='cancelled' AND (o.paid=0 OR o.status IN ('pending','cooking'))", t).n > 0;
  const hiddenOpen = () => all('SELECT id FROM tables WHERE id>? ORDER BY id', tableCount).map((t) => t.id).filter(tableHasOpenOrders);
  function setTableCount(n, force) {
    if (!Number.isInteger(n) || n < 1 || n > 50) fail(400, 'bad_count', '테이블 수는 1~50 사이 정수여야 합니다.');
    if (n < tableCount && !force) {
      const open = [];
      for (let t = n + 1; t <= tableCount; t++) {
        if (tableHasOpenOrders(t)) open.push(t);
      }
      if (open.length) fail(409, 'unsettled', '미입금 또는 서빙 전 주문이 남은 테이블이 있습니다.', { tables: open });
    }
    tx(() => {
      run("INSERT INTO settings(k,v) VALUES('table_count',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", String(n));
      audit('table_count', 'settings', `${tableCount}→${n}${n < tableCount && force ? ' (forced)' : ''}`, `테이블 수 변경 · ${tableCount}개 → ${n}개${n < tableCount && force ? ' (강제)' : ''}`);
      for (let i = 1; i <= n; i++) { // rows of lowered tables are kept, so raising the count again brings their old QR codes back
        if (!get('SELECT 1 FROM tables WHERE id=?', i)) run('INSERT INTO tables(id, token) VALUES(?,?)', i, crypto.randomBytes(12).toString('base64url'));
      }
    });
    tableCount = n;
    invalidate();
    return n;
  }
  function rotateToken(n) {
    tableRow(n);
    const token = crypto.randomBytes(12).toString('base64url');
    tx(() => { run('UPDATE tables SET token=? WHERE id=?', token, n); audit('table_rotate', `table ${n}`, 'QR token replaced (value not logged)', `${n}번 테이블 QR 재발급`); });
    return token;
  }

  // ---------- payment settings ----------
  function payAll() {
    const v = setting('pay', null);
    try { return { ...PAY_DEFAULT, ...(v ? JSON.parse(v) : {}) }; } catch { return { ...PAY_DEFAULT }; }
  }
  const payInfo = () => { const { changedAt, ...p } = payAll(); return p; }; // what guests see
  function setPay(body) {
    const cur = payAll();
    const has = (k) => Object.hasOwn(body, k);
    if (!['bank', 'account', 'holder', 'tossEnabled', 'kakaoPayUrl', 'requireDepositor'].some(has)) fail(400, 'nothing_to_update', '바꿀 항목이 없습니다.');
    const next = { ...cur };
    if (has('bank')) next.bank = cleanLabel(body.bank, 1, 20, 'bad_bank', '은행 이름');
    if (has('holder')) next.holder = cleanLabel(body.holder, 1, 20, 'bad_holder', '예금주');
    if (has('account')) {
      const a = body.account;
      const digits = typeof a === 'string' ? a.replace(/-/g, '') : '';
      if (typeof a !== 'string' || !/^\d+(-\d+)*$/.test(a) || digits.length < 8 || digits.length > 20) fail(400, 'bad_account', '계좌번호는 숫자와 하이픈만, 숫자 8~20자리여야 합니다.');
      next.account = a;
    }
    for (const [k, code] of [['tossEnabled', 'bad_toss_enabled'], ['requireDepositor', 'bad_require_depositor']]) {
      if (has(k)) { if (typeof body[k] !== 'boolean') fail(400, code, `${k}는 true/false여야 합니다.`); next[k] = body[k]; }
    }
    if (has('kakaoPayUrl')) {
      const v = body.kakaoPayUrl;
      if (v === '') next.kakaoPayUrl = '';
      else {
        let u = null;
        try { if (typeof v === 'string' && v.length <= 200) u = new URL(v); } catch { u = null; }
        if (!u || u.protocol !== 'https:' || u.hostname !== 'qr.kakaopay.com' || u.username || u.password || u.port || u.pathname.length < 2) {
          fail(400, 'bad_kakao_url', '카카오페이 링크는 https://qr.kakaopay.com/ 으로 시작해야 합니다.');
        }
        next.kakaoPayUrl = u.href;
      }
    }
    if (next.bank !== cur.bank || next.account !== cur.account || next.holder !== cur.holder) { // typed-twice guard for the money destination
      const conf = body.confirmAccount;
      if (typeof conf !== 'string' || conf.replace(/-/g, '') !== next.account.replace(/-/g, '')) fail(400, 'account_mismatch', '계좌번호 확인 입력이 일치하지 않습니다.');
      next.changedAt = now();
    }
    tx(() => {
      run("INSERT INTO settings(k,v) VALUES('pay',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", JSON.stringify(next));
      const ch = ['bank', 'account', 'holder', 'tossEnabled', 'kakaoPayUrl', 'requireDepositor'].filter((k) => next[k] !== cur[k]); // field names only: never the account number
      const KOF = { bank: '은행', account: '계좌번호', holder: '예금주', tossEnabled: '토스 송금', kakaoPayUrl: '카카오페이 링크', requireDepositor: '입금자명 필수' };
      audit('pay_settings', 'settings', ch.join(', ') || 'no change', `결제 정보 변경 · ${ch.map((k) => KOF[k]).join(', ') || '변경 없음'}`); // field names only: never the account number
    });
    return payAll();
  }

  // ---------- deposit notices (a phone forwards bank SMS text; matching is conservative) ----------
  const DEPOSIT_WINDOW_MS = 6 * HOUR;
  const MANUAL_QUEUE_MAX = 1500;
  const autoConfirmOn = () => setting('deposit_auto_confirm', '0') === '1';
  const autoMax = () => Number(setting('deposit_auto_max', '30000'));
  function setAutoConfirm(body) {
    const has = (k) => Object.hasOwn(body, k);
    if (!has('autoConfirm') && !has('autoConfirmMaxAmount')) fail(400, 'bad_auto_confirm', 'autoConfirm은 true/false여야 합니다.');
    if (has('autoConfirm') && typeof body.autoConfirm !== 'boolean') fail(400, 'bad_auto_confirm', 'autoConfirm은 true/false여야 합니다.');
    if (has('autoConfirmMaxAmount') && (!Number.isInteger(body.autoConfirmMaxAmount) || body.autoConfirmMaxAmount < 0 || body.autoConfirmMaxAmount > 1000000)) {
      fail(400, 'bad_auto_max', 'autoConfirmMaxAmount는 0~1,000,000 사이 정수여야 합니다.');
    }
    tx(() => {
      const ch = []; const ko = [];
      if (has('autoConfirm')) { ko.push(`자동 확인 ${autoConfirmOn() ? '켬' : '끔'}→${body.autoConfirm ? '켬' : '끔'}`); ch.push(`autoConfirm ${autoConfirmOn()}→${body.autoConfirm}`); run("INSERT INTO settings(k,v) VALUES('deposit_auto_confirm',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", body.autoConfirm ? '1' : '0'); }
      if (has('autoConfirmMaxAmount')) { ko.push(`상한 ${W(autoMax())}→${W(body.autoConfirmMaxAmount)}`); ch.push(`max ${autoMax()}→${body.autoConfirmMaxAmount}`); run("INSERT INTO settings(k,v) VALUES('deposit_auto_max',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", String(body.autoConfirmMaxAmount)); }
      audit('deposit_auto_setting', 'settings', ch.join(', '), `입금 자동 확인 설정 · ${ko.join(' · ')}`);
    });
    return { autoConfirm: autoConfirmOn(), autoConfirmMaxAmount: autoMax() };
  }
  function depositSecret() {
    let v = setting('deposit_secret', null);
    if (!v) { v = crypto.randomBytes(32).toString('hex'); run("INSERT INTO settings(k,v) VALUES('deposit_secret',?)", v); }
    return v;
  }
  function rotateDepositSecret() {
    const v = crypto.randomBytes(32).toString('hex');
    tx(() => { run("INSERT INTO settings(k,v) VALUES('deposit_secret',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", v); audit('deposit_secret_rotate', 'settings', 'hook secret replaced (value not logged)', '입금 문자 전달 주소 재발급'); });
    return v;
  }
  const checkDepositSecret = (given) => typeof given === 'string' && crypto.timingSafeEqual(Buffer.from(sha(given)), Buffer.from(sha(depositSecret())));
  // only orders staff can see: the CURRENT seat of a table within the table count
  const depositCandidates = (amount) => all(`SELECT o.id, o.table_id, o.total, o.depositor, o.created_at, o.paid_by, o.total - ${heldSql('o')} AS balance FROM orders o JOIN tables t ON t.id=o.table_id AND t.seat=o.seat WHERE o.status!='cancelled' AND o.paid=0 AND o.total - ${heldSql('o')}=? AND ?>0 AND o.created_at>? AND t.id<=? ORDER BY o.id`, amount, amount, now() - DEPOSIT_WINDOW_MS, tableCount);
  // orders staff already marked paid by hand (no notice attached) for the same amount: the transfer may belong to one of them
  const handPaidSame = (amount) => all("SELECT o.id, o.table_id, o.total, o.depositor, o.created_at, o.paid_by FROM orders o JOIN tables t ON t.id=o.table_id AND t.seat=o.seat WHERE o.status!='cancelled' AND o.paid=1 AND o.paid_by='staff' AND o.notice_id IS NULL AND o.total=? AND o.created_at>? AND t.id<=? ORDER BY o.id", amount, now() - DEPOSIT_WINDOW_MS, tableCount);
  const orderVisible = (o) => !!get('SELECT 1 FROM tables t WHERE t.id=? AND t.seat=? AND t.id<=?', o.table_id, o.seat, tableCount);
  const candOut = (o) => ({ id: o.id, table: o.table_id, total: o.total, balance: o.balance ?? 0, depositor: o.depositor ?? null, createdAt: o.created_at });
  // the one decision function: used for real notices and for the staff "test" preview (which stores nothing)
  function decideDeposit(p, sameRecent) {
    if (p.kind === 'ignore') return { status: 'ignored', reasons: [] };
    if (p.kind === 'review') return { status: 'review', reasons: p.reasons };
    if (p.amount == null) return { status: 'unparsed', reasons: p.reasons };
    const reasons = [...p.reasons];
    if (sameRecent) reasons.push('duplicate');
    if (!autoConfirmOn()) reasons.push('auto_off');
    if (p.amount > autoMax()) reasons.push('over_max_amount');
    const cands = depositCandidates(p.amount);
    const handled = handPaidSame(p.amount);
    if (handled.length) reasons.push('maybe_already_handled');
    if (cands.length === 0) reasons.push('no_candidate');
    else if (cands.length > 1) reasons.push('several_candidates');
    let order = null;
    if (cands.length === 1) {
      if (!cands[0].depositor) reasons.push('no_depositor_on_order');
      else if (!p.depositor || !sameDepositor(p.depositor, cands[0].depositor)) reasons.push('name_mismatch');
      else order = cands[0];
    }
    if (reasons.length) return { status: 'pending', reasons, candidates: cands, handled };
    return { status: 'matched', reasons: [], order };
  }
  const sameTextRecent = (norm) => get('SELECT id, status, repeat_count, COALESCE(last_at, received_at) AS last_at FROM deposit_notices WHERE norm=? AND COALESCE(last_at, received_at)>? ORDER BY id DESC LIMIT 1', norm, now() - DEPOSIT_WINDOW_MS);
  const normText = (raw) => raw.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  function previewDeposit(text) {
    const raw = String(text);
    const p = parseDeposit(raw);
    const d = decideDeposit(p, !!sameTextRecent(normText(raw)));
    return {
      parsed: { kind: p.kind, amount: p.amount ?? null, name: p.depositor ?? null, autoEligible: !!p.autoEligible, reasons: p.reasons ?? [] },
      wouldMatch: { status: d.status, reasons: d.reasons, ...(d.order ? { orderId: d.order.id } : {}), candidates: (d.candidates || []).map(candOut), handledOrders: (d.handled || []).map(candOut) },
    };
  }
  function ingestDeposit(text) {
    const raw = String(text);
    const p = parseDeposit(raw);
    const norm = normText(raw);
    const t0 = now();
    const recent = sameTextRecent(norm);
    if (recent && t0 - recent.last_at < 5000) return { status: 'duplicate' }; // a forwarder retry: the only silent drop
    return tx(() => {
      const ts = now();
      // an identical text within 6 hours collapses into ONE open row (repeatCount / lastAt): flooding cannot create rows, and staff still see every repeat
      if (recent && ['pending', 'review', 'unparsed', 'ignored'].includes(recent.status)) {
        run('UPDATE deposit_notices SET repeat_count=repeat_count+1, last_at=? WHERE id=?', ts, recent.id);
        return { status: recent.status, id: recent.id, repeat: true, repeatCount: recent.repeat_count + 1 };
      }
      const d = decideDeposit(p, !!recent);
      // a full queue makes room by dropping the oldest unparsed row, then the oldest ignored one; pending / review / matched rows are never evicted
      if (get("SELECT COUNT(*) n FROM deposit_notices WHERE status IN ('pending','review','unparsed','ignored')").n >= MANUAL_QUEUE_MAX) {
        const victim = get("SELECT id FROM deposit_notices WHERE status='unparsed' ORDER BY id LIMIT 1") || get("SELECT id FROM deposit_notices WHERE status='ignored' ORDER BY id LIMIT 1");
        if (!victim) return { status: 'queue_full' };
        run('DELETE FROM deposit_notices WHERE id=?', victim.id);
      }
      const ins = (status, amount, guessed) => Number(run('INSERT INTO deposit_notices(received_at,raw,norm,amount,depositor,status,reasons,amount_guessed,repeat_count,last_at) VALUES(?,?,?,?,?,?,?,?,1,?)',
        ts, raw.trim().slice(0, 300), norm, amount, p.depositor ?? null, status, JSON.stringify(d.reasons), guessed ? 1 : 0, ts).lastInsertRowid);
      // only dismissed / ignored rows are pruned beyond the cap: pending, review, unparsed and matched rows are what staff and the audit trail need
      run("DELETE FROM deposit_notices WHERE status IN ('dismissed','ignored') AND id NOT IN (SELECT id FROM deposit_notices ORDER BY id DESC LIMIT 2000)");
      const guessed = !p.autoEligible && p.amount != null;
      if (d.status === 'matched') {
        const id = ins('pending', p.amount, false);
        const row = get('SELECT * FROM orders WHERE id=? AND paid=0', d.order.id);
        if (row) {
          addPayment(row, p.amount, 'transfer', 'auto', ts, id);
          run("UPDATE deposit_notices SET status='matched', order_id=?, matched_at=?, matched_by='auto' WHERE id=?", d.order.id, ts, id);
          audit('deposit_auto', `order #${d.order.id}`, `notice #${id}, ${p.amount} won`, `입금 자동 확인 · 주문 #${d.order.id} · ${W(p.amount)}`);
          return { status: 'matched', id, orderId: d.order.id, table: d.order.table_id };
        }
        return { status: 'pending', id };
      }
      const status = d.status;
      return { status, id: ins(status, status === 'ignored' || status === 'unparsed' ? null : p.amount, guessed && (status === 'pending' || status === 'review')) };
    });
  }
  const parseReasons = (v) => { try { return JSON.parse(v || '[]'); } catch { return []; } };
  function noticeOut(n) {
    const open = n.status === 'pending' && n.amount != null;
    return {
      id: n.id, receivedAt: n.received_at, text: n.raw, amount: n.amount, amountGuessed: !!n.amount_guessed, depositor: n.depositor, status: n.status, orderId: n.order_id,
      matchedAt: n.matched_at, matchedBy: n.matched_by, repeatCount: n.repeat_count ?? 1, lastAt: n.last_at ?? n.received_at, reasons: parseReasons(n.reasons),
      ...(() => { // at most 10 of each (a synthetic worst case of 200 notices x 190 same-total orders was 7 MB); the counts say how many exist
        const c = open ? depositCandidates(n.amount) : []; const h = open ? handPaidSame(n.amount) : [];
        return { candidates: c.slice(0, 10).map(candOut), candidateCount: c.length, handledOrders: h.slice(0, 10).map(candOut), handledCount: h.length };
      })(),
    };
  }
  function listDeposits({ before = null, limit = 200, open = false } = {}) {
    const lim = Math.min(Math.max(Number.isInteger(limit) ? limit : 200, 1), 200);
    const rows = all(`SELECT * FROM deposit_notices WHERE (? IS NULL OR id<?)${open ? " AND status IN ('pending','review','unparsed')" : ''} ORDER BY id DESC LIMIT ?`, before, before, lim);
    return { notices: rows.map(noticeOut), next: rows.length === lim ? rows[rows.length - 1].id : null };
  }
  const depositCounts = () => {
    const c = (st) => get('SELECT COUNT(*) n FROM deposit_notices WHERE status=?', st).n;
    const review = c('review');
    return { pending: c('pending') + review, unparsed: c('unparsed'), ignored: c('ignored'), review, autoConfirm: autoConfirmOn(), autoConfirmMaxAmount: autoMax() };
  };
  const MANUAL = ['pending', 'unparsed', 'review'];
  const needNote = (note) => cleanLabel(note, 1, 60, 'note_required', '사유(메모)');
  function assignDeposit(noticeId, orderId, force, note) {
    return tx(() => {
      const n = get('SELECT * FROM deposit_notices WHERE id=?', noticeId) || fail(404, 'no_notice', '없는 입금 알림입니다.');
      if (!MANUAL.includes(n.status)) fail(409, 'notice_closed', '이미 처리된 입금 알림입니다.');
      if (!Number.isInteger(orderId)) fail(400, 'bad_order', 'orderId가 올바르지 않습니다.');
      const o = get('SELECT * FROM orders WHERE id=?', orderId) || fail(404, 'no_order', '없는 주문입니다.');
      if (!orderVisible(o)) fail(404, 'no_order', '없는 주문입니다.'); // not the current seat of a visible table
      if (o.status === 'cancelled') fail(409, 'order_cancelled', '취소된 주문입니다.');
      if (o.paid) fail(409, 'order_paid', '이미 입금 확인된 주문입니다. 이미 직접 입금 확인한 주문에는 연결(attach)을 사용하세요.');
      if (n.status === 'review' && force !== true) fail(409, 'review_needs_force', '취소·정정 등 확인이 필요한 알림입니다. 확인 후 force로 연결해 주세요.');
      const bal = balanceOf(o); // a notice is compared with what is still to pay (partial cash + transfer of the rest matches cleanly)
      if (n.amount !== bal && force !== true) fail(409, 'amount_mismatch', '입금액과 남은 결제 금액이 다릅니다.', { noticeAmount: n.amount, orderTotal: o.total, orderBalance: bal });
      const mismatch = n.amount !== bal;
      const memo = mismatch ? needNote(note) : null; // a forced mismatch must be explained
      const ts = now();
      // the money received is the notice amount (unknown amount: the order balance is assumed); under / over payment follow the normal payment rules
      addPayment(o, n.amount ?? bal, 'transfer', 'staff', ts, noticeId);
      run("UPDATE deposit_notices SET status='matched', order_id=?, matched_at=?, matched_by='staff' WHERE id=?", orderId, ts, noticeId);
      audit('deposit_assign', `order #${orderId}`, `notice #${noticeId}, ${n.amount ?? '?'} won${memo ? `, note: ${memo}` : ''}`, `입금 알림 #${noticeId} 연결 · 주문 #${orderId} · ${W(n.amount ?? bal)}${memo ? ` · 사유: ${memo}` : ''} · 잔액 ${W(balanceOf(get('SELECT * FROM orders WHERE id=?', orderId)))}`);
      return { notice: noticeOut(get('SELECT * FROM deposit_notices WHERE id=?', noticeId)), order: orderById(orderId) };
    });
  }
  // link a notice to an order staff ALREADY marked paid by hand: the payment state is not changed
  function attachDeposit(noticeId, orderId, force, note) {
    return tx(() => {
      const n = get('SELECT * FROM deposit_notices WHERE id=?', noticeId) || fail(404, 'no_notice', '없는 입금 알림입니다.');
      if (!MANUAL.includes(n.status)) fail(409, 'notice_closed', '이미 처리된 입금 알림입니다.');
      if (!Number.isInteger(orderId)) fail(400, 'bad_order', 'orderId가 올바르지 않습니다.');
      const o = get('SELECT * FROM orders WHERE id=?', orderId) || fail(404, 'no_order', '없는 주문입니다.');
      if (!orderVisible(o)) fail(404, 'no_order', '없는 주문입니다.');
      if (o.status === 'cancelled') fail(409, 'order_cancelled', '취소된 주문입니다.');
      if (!o.paid) fail(409, 'order_unpaid', '아직 입금 확인되지 않은 주문입니다. 연결(assign)을 사용하세요.');
      if (o.notice_id) fail(409, 'order_has_notice', '이미 다른 입금 알림과 연결된 주문입니다.');
      if (n.status === 'review' && force !== true) fail(409, 'review_needs_force', '취소·정정 등 확인이 필요한 알림입니다. 확인 후 force로 연결해 주세요.');
      if (n.amount !== o.total && force !== true) fail(409, 'amount_mismatch', '입금액과 주문 금액이 다릅니다.', { noticeAmount: n.amount, orderTotal: o.total });
      const memo = n.amount !== o.total ? needNote(note) : null;
      run('UPDATE orders SET notice_id=?, updated_at=? WHERE id=?', noticeId, nextTs(o), orderId);
      run("UPDATE deposit_notices SET status='matched', order_id=?, matched_at=?, matched_by='staff' WHERE id=?", orderId, now(), noticeId);
      audit('deposit_attach', `order #${orderId}`, `notice #${noticeId}${memo ? `, note: ${memo}` : ''}`, `입금 알림 #${noticeId} 연결(이미 확인된 주문) · 주문 #${orderId}${memo ? ` · 사유: ${memo}` : ''}`);
      return { notice: noticeOut(get('SELECT * FROM deposit_notices WHERE id=?', noticeId)), order: orderById(orderId) };
    });
  }
  function dismissDeposit(noticeId) {
    const n = get('SELECT * FROM deposit_notices WHERE id=?', noticeId) || fail(404, 'no_notice', '없는 입금 알림입니다.');
    if (!MANUAL.includes(n.status)) fail(409, 'notice_closed', '이미 처리된 입금 알림입니다.');
    run("UPDATE deposit_notices SET status='dismissed' WHERE id=?", noticeId);
    audit('deposit_dismiss', `notice #${noticeId}`, n.status, `입금 알림 #${noticeId} 무시`);
    return noticeOut(get('SELECT * FROM deposit_notices WHERE id=?', noticeId));
  }

  // ---------- rewards / games / coupons ----------
  // Rewards live in the DB (seeded once from rewards.json). The games (maxScore / minDurationMs) stay constants from rewards.json.
  const rewardOut = (r) => ({
    id: r.id, label: r.label, game: r.game, threshold: r.threshold, type: r.type, amount: r.amount ?? null, item: r.item ?? null,
    stock: r.stock, issued: r.issued, remaining: r.stock - r.issued,
    used: get("SELECT COUNT(*) n FROM coupons WHERE reward_id=? AND status='used'", r.id).n, active: !!r.active,
  });
  const listRewards = () => all('SELECT * FROM rewards ORDER BY sort, rowid').map(rewardOut);
  function rewardsView(tableId, seat) {
    if (tableId == null) return listRewards(); // staff: every reward incl. inactive, with live counts
    return all('SELECT * FROM rewards WHERE active=1 ORDER BY sort, rowid').map((r) => ({
      id: r.id, game: r.game, label: r.label, type: r.type, amount: r.amount ?? null, item: r.item ?? null, threshold: r.threshold,
      soldOut: r.issued >= r.stock, got: !!get("SELECT 1 FROM coupons WHERE table_id=? AND seat=? AND source='score' AND reward_id=?", tableId, seat, r.id),
    }));
  }
  // validates a create body (cur = null) or an update body merged onto the current row
  function normalizeReward(body, cur) {
    const has = (k) => Object.hasOwn(body, k);
    const label = has('label') || !cur ? cleanLabel(body.label, 1, 20, 'bad_label', '보상 이름') : cur.label;
    const game = has('game') || !cur ? body.game : cur.game;
    if (typeof game !== 'string' || !Object.hasOwn(games, game)) fail(400, 'bad_game', `게임은 ${Object.keys(games).join(', ')} 중 하나여야 합니다.`);
    const threshold = has('threshold') || !cur ? body.threshold : cur.threshold;
    if (!Number.isInteger(threshold) || threshold < 0 || threshold > games[game].maxScore) fail(400, 'bad_threshold', `기준 점수는 0~${games[game].maxScore} 사이 정수여야 합니다.`);
    const type = has('type') || !cur ? body.type : cur.type;
    if (type !== 'discount' && type !== 'item') fail(400, 'bad_type', "type은 'discount' 또는 'item' 이어야 합니다.");
    let amount = null;
    if (type === 'discount') {
      amount = has('amount') ? body.amount : (cur && cur.type === 'discount' ? cur.amount : undefined);
      if (!Number.isInteger(amount) || amount < 100 || amount > 100000 || amount % 100 !== 0) fail(400, 'bad_amount', '할인 금액은 100~100,000원 사이 100원 단위여야 합니다.');
    }
    const stock = has('stock') || !cur ? body.stock : cur.stock;
    if (!Number.isInteger(stock) || stock < 0 || stock > 10000) fail(400, 'bad_stock', '재고는 0~10,000 사이 정수여야 합니다.');
    let active = cur ? !!cur.active : true;
    if (has('active')) { if (typeof body.active !== 'boolean') fail(400, 'bad_active', 'active는 true/false여야 합니다.'); active = body.active; }
    return { label, game, threshold, type, amount, stock, active };
  }
  const REWARD_FIELDS = ['label', 'game', 'threshold', 'type', 'amount', 'stock', 'active'];
  function createReward(body) {
    const n = normalizeReward(body, null);
    if (get('SELECT COUNT(*) n FROM rewards').n >= REWARD_MAX) fail(409, 'too_many_rewards', `보상은 ${REWARD_MAX}개까지 만들 수 있습니다.`);
    const id = 'r' + crypto.randomBytes(4).toString('hex');
    run('INSERT INTO rewards(id,label,game,threshold,type,amount,item,stock,active,sort) VALUES(?,?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(sort), -1) + 1 FROM rewards))',
      id, n.label, n.game, n.threshold, n.type, n.amount, n.type === 'item' ? n.label : null, n.stock, n.active ? 1 : 0);
    invalidate();
    return rewardOut(get('SELECT * FROM rewards WHERE id=?', id));
  }
  // type / amount / label changes only affect coupons issued AFTER the change: coupons store their own label, type and amount
  function updateReward(id, body) {
    const cur = get('SELECT * FROM rewards WHERE id=?', id) || fail(404, 'no_reward', '없는 보상입니다.');
    if (!REWARD_FIELDS.some((k) => Object.hasOwn(body, k))) fail(400, 'nothing_to_update', '바꿀 항목이 없습니다.');
    const n = normalizeReward(body, cur);
    if (n.stock < cur.issued) fail(400, 'stock_below_issued', '이미 발급한 수량보다 적게 설정할 수 없습니다.', { issued: cur.issued });
    const item = n.type === 'item' ? (Object.hasOwn(body, 'label') || cur.type !== 'item' ? n.label : (cur.item ?? n.label)) : null;
    run('UPDATE rewards SET label=?, game=?, threshold=?, type=?, amount=?, item=?, stock=?, active=? WHERE id=?', n.label, n.game, n.threshold, n.type, n.amount, item, n.stock, n.active ? 1 : 0, id);
    invalidate();
    return rewardOut(get('SELECT * FROM rewards WHERE id=?', id));
  }
  function deleteReward(id) {
    const r = get('SELECT * FROM rewards WHERE id=?', id) || fail(404, 'no_reward', '없는 보상입니다.');
    if (r.issued > 0 || get('SELECT 1 FROM coupons WHERE reward_id=? LIMIT 1', id)) fail(409, 'in_use', '이미 발급된 보상은 삭제할 수 없습니다. 비활성화해 주세요.');
    run('DELETE FROM rewards WHERE id=?', id);
    invalidate();
  }
  function setStock(id, stock) { // kept for older clients; same rules as updateReward({stock})
    if (!Number.isInteger(stock) || stock < 0 || stock > 10000) fail(400, 'bad_stock', '재고는 0~10,000 사이 정수여야 합니다.');
    const r = get('SELECT issued FROM rewards WHERE id=?', id) || fail(404, 'no_reward', '없는 보상입니다.');
    if (stock < r.issued) fail(400, 'stock_below_issued', '이미 발급한 수량보다 적게 설정할 수 없습니다.', { issued: r.issued });
    run('UPDATE rewards SET stock=? WHERE id=?', stock, id);
    invalidate();
  }
  function hourlyReward() {
    const v = setting('hourly_reward', null);
    try { return { ...HOURLY_DEFAULT, ...(v ? JSON.parse(v) : {}) }; } catch { return { ...HOURLY_DEFAULT }; }
  }
  function setHourlyReward(body) {
    const cur = hourlyReward();
    const has = (k) => Object.hasOwn(body, k);
    if (!['label', 'type', 'amount', 'enabled'].some(has)) fail(400, 'nothing_to_update', '바꿀 항목이 없습니다.');
    const next = { ...cur };
    if (has('label')) next.label = cleanLabel(body.label, 1, 20, 'bad_label', '보상 이름');
    if (has('type')) { if (body.type !== 'discount' && body.type !== 'item') fail(400, 'bad_type', "type은 'discount' 또는 'item' 이어야 합니다."); next.type = body.type; }
    if (has('enabled')) { if (typeof body.enabled !== 'boolean') fail(400, 'bad_enabled', 'enabled는 true/false여야 합니다.'); next.enabled = body.enabled; }
    if (has('amount')) next.amount = body.amount;
    if (next.type === 'discount') {
      if (!Number.isInteger(next.amount) || next.amount < 100 || next.amount > 100000 || next.amount % 100 !== 0) fail(400, 'bad_amount', '할인 금액은 100~100,000원 사이 100원 단위여야 합니다.');
    } else next.amount = null;
    if (has('label') || next.type !== cur.type) next.item = next.label;
    run("INSERT INTO settings(k,v) VALUES('hourly_reward',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", JSON.stringify(next));
    invalidate();
    return hourlyReward();
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
      for (const r of all('SELECT * FROM rewards WHERE game=? AND active=1 ORDER BY sort, rowid', play.game)) {
        const res = { rewardId: r.id, label: r.label };
        if (score < r.threshold) res.result = 'low_score';
        else if (get("SELECT 1 FROM coupons WHERE table_id=? AND seat=? AND source='score' AND reward_id=?", tableId, t.seat, r.id)) res.result = 'already_got';
        else if (run('UPDATE rewards SET issued=issued+1 WHERE id=? AND issued<stock AND active=1', r.id).changes !== 1) res.result = 'sold_out';
        else {
          const c = insertCoupon({ rewardId: r.id, source: 'score', type: r.type, amount: r.amount ?? null, label: r.label, item: r.type === 'item' ? (r.item ?? r.label) : null, tableId, seat: t.seat });
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
    if (c.status === 'void') fail(409, 'coupon_void', '무효 처리된 쿠폰입니다.');
    if (c.status !== 'issued') fail(409, 'already_used', '이미 사용된 쿠폰입니다.', { usedAt: c.used_at, orderId: c.order_id });
    tx(() => { run("UPDATE coupons SET status='used', used_at=? WHERE code=?", now(), c.code); audit('coupon_redeem', `coupon ${c.code}`, `${c.type} ${c.label}`, `쿠폰 ${c.code} 사용 처리 · ${c.label}`); });
    return { ...couponOut(get('SELECT * FROM coupons WHERE code=?', c.code)), stale: c.seat !== get('SELECT seat FROM tables WHERE id=?', c.table_id).seat };
  }

  // coupons made by staff by hand: not tied to reward stock, at most 20 per hour server-wide
  function createManualCoupon(n, body) {
    const t = tableRow(n);
    if (body.type !== 'discount' && body.type !== 'item') fail(400, 'bad_type', "type은 'discount' 또는 'item' 이어야 합니다.");
    const label = cleanLabel(body.label, 1, 20, 'bad_label', '쿠폰 이름');
    let amount = null;
    if (body.type === 'discount') {
      amount = body.amount;
      if (!Number.isInteger(amount) || amount < 100 || amount > 100000 || amount % 100 !== 0) fail(400, 'bad_amount', '할인 금액은 100~100,000원 사이 100원 단위여야 합니다.');
    }
    return tx(() => {
      if (get("SELECT COUNT(*) n FROM coupons WHERE source='staff' AND created_at>?", now() - HOUR).n >= 20) fail(409, 'manual_coupon_limit', '직원 쿠폰은 한 시간에 20장까지 만들 수 있습니다.');
      const c = insertCoupon({ rewardId: 'staff', source: 'staff', type: body.type, amount, label, item: body.type === 'item' ? label : null, tableId: n, seat: t.seat });
      audit('coupon_manual', `table ${n}`, `${c.type} ${amount ?? ''} ${label}`.trim(), `${n}번 테이블 직원 쿠폰 발급 · ${label}${amount ? ` ${W(amount)}` : ''}`);
      return c;
    });
  }
  function voidCoupon(code) {
    const c = get('SELECT * FROM coupons WHERE code=?', String(code || '').trim().toUpperCase()) || fail(404, 'no_coupon', '없는 쿠폰 코드입니다.');
    if (c.status === 'void') fail(409, 'coupon_void', '이미 무효 처리된 쿠폰입니다.');
    if (c.status !== 'issued') fail(409, 'coupon_used', '이미 사용된 쿠폰은 무효 처리할 수 없습니다.');
    tx(() => { run("UPDATE coupons SET status='void' WHERE code=?", c.code); audit('coupon_void', `coupon ${c.code}`, `${c.type} ${c.label}`, `쿠폰 ${c.code} 무효 처리 · ${c.label}`); });
    return couponOut(get('SELECT * FROM coupons WHERE code=?', c.code));
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
    const h0 = hourlyReward();
    if (!h0.enabled) fail(409, 'hourly_disabled', '시간대 랭킹 보상이 꺼져 있습니다.');
    invalidate();
    return tx(() => {
      if (hourAwarded(start)) fail(409, 'already_awarded', '이 시간대 보상은 이미 지급했습니다.');
      const top = hourRanking(start)[0] || fail(404, 'no_ranking', '이 시간대 게임 기록이 없습니다.');
      const h = h0;
      const t = tableRow(top.table);
      const coupon = insertCoupon({ rewardId: 'hour:' + start, source: 'hour', type: h.type, amount: h.type === 'discount' ? h.amount : null, label: h.label, item: h.type === 'item' ? (h.item ?? h.label) : null, tableId: top.table, seat: t.seat });
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
  const waitTimeoutMin = () => Number(setting('wait_call_timeout_min', String(waitCallTimeoutMin)));
  function setWaitTimeout(min) {
    if (!Number.isInteger(min) || min < 1 || min > 30) fail(400, 'bad_minutes', '호출 후 대기 시간은 1~30분 사이 정수여야 합니다.');
    tx(() => { const was = waitTimeoutMin(); run("INSERT INTO settings(k,v) VALUES('wait_call_timeout_min',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v", String(min)); audit('wait_timeout', 'settings', `${was}→${min} min`, `대기 호출 제한 시간 ${was}분 → ${min}분`); });
    sweepWait();
    return min;
  }
  // a called party that was not seated in time becomes a no-show (checked lazily on reads and on a timer); returns the number changed
  function sweepWait() { return run("UPDATE waitlist SET status='noshow' WHERE status='called' AND called_at<?", now() - waitTimeoutMin() * 60000).changes; }
  function clearWait() { sweepWait(); return run("UPDATE waitlist SET status='cancelled' WHERE status IN ('waiting','called','noshow')").changes; }
  const waitInfo = () => { sweepWait(); return { open: waitOpen(), waitingTotal: get("SELECT COUNT(*) n FROM waitlist WHERE status='waiting'").n, notice: bannerOut() }; };
  function addWait(device, nick, size) {
    if (!waitOpen()) fail(403, 'wait_closed', '지금은 대기 등록을 받지 않습니다.');
    const n = cleanNick(nick);
    if (!Number.isInteger(size) || size < 1 || size > 10) fail(400, 'bad_size', '인원은 1~10명으로 입력해 주세요.');
    if (get("SELECT COUNT(*) n FROM waitlist WHERE device=? AND status IN ('waiting','called')", device).n >= 3) fail(429, 'too_many', '이 기기에서 등록할 수 있는 대기 수를 넘었습니다.');
    if (get("SELECT COUNT(*) n FROM waitlist WHERE status='waiting'").n >= 300) fail(503, 'wait_full', '대기 명단이 가득 찼습니다.');
    const t = now();
    while (waitTimes.length && waitTimes[0] < t - 60000) waitTimes.shift();
    if (waitTimes.length >= MAX_WAIT_PER_MIN) fail(429, 'wait_rate', '대기 등록이 몰리고 있습니다. 잠시 후 다시 시도해 주세요.');
    run("DELETE FROM waitlist WHERE status IN ('seated','cancelled','noshow') AND created_at<?", t - WAIT_KEEP_MS);
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
    sweepWait();
    const w = waitRow(id, secret);
    const ahead = w.status === 'waiting' ? get("SELECT COUNT(*) n FROM waitlist WHERE status='waiting' AND id<?", w.id).n : 0;
    return {
      id: w.id, nick: w.nick, size: w.size, status: w.status, canRecall: w.status === 'noshow' && !w.recalled, ahead, position: w.status === 'waiting' ? ahead + 1 : null,
      waitingTotal: get("SELECT COUNT(*) n FROM waitlist WHERE status='waiting'").n, open: waitOpen(), notice: bannerOut(),
    };
  }
  function waitCancel(id, secret) {
    const w = waitRow(id, secret);
    if (w.status === 'waiting' || w.status === 'called' || w.status === 'noshow') run("UPDATE waitlist SET status='cancelled' WHERE id=?", id);
  }
  function waitAction(id, action) {
    sweepWait();
    const w = get('SELECT * FROM waitlist WHERE id=?', id) || fail(404, 'no_wait', '없는 대기 번호입니다.');
    if (w.status === 'seated' || w.status === 'cancelled') fail(409, 'wait_closed', '이미 처리된 대기입니다.');
    if (action === 'recall') { // a no-show may be called back once
      if (w.status !== 'noshow') fail(409, 'not_noshow', '미입장 처리된 대기만 다시 부를 수 있습니다.');
      if (w.recalled) fail(409, 'already_recalled', '이미 한 번 다시 불렀습니다.');
      run("UPDATE waitlist SET status='called', called_at=?, recalled=1 WHERE id=?", now(), id);
      return;
    }
    if (action === 'call' && w.status === 'noshow') fail(409, 'wait_noshow', '미입장 처리된 대기입니다. 다시 부르기(recall)를 사용하세요.');
    const to = { call: 'called', seat: 'seated', cancel: 'cancelled' }[action];
    run('UPDATE waitlist SET status=?, called_at=? WHERE id=?', to, to === 'called' ? now() : w.called_at, id);
  }

  // ---------- snapshots ----------
  function guestState(tableId, device) {
    const t = tableRow(tableId);
    return {
      table: { number: t.id, seat: t.seat },
      orderingOpen: orderingOpen(),
      memberDiscountPct: memberPct(),
      memberDiscount: (({ enabled, mode, pct, amount, minOrder, maxDiscount, stackWithCoupon }) => ({ enabled: enabled && memberEnabled, mode, pct, amount, minOrder, maxDiscount, stackWithCoupon }))(memberSettings()),
      menu: menuView(),
      // cancelled orders: only the newest 5 are shown
      orders: loadOrders(all("SELECT * FROM orders WHERE table_id=? AND seat=? AND (status!='cancelled' OR id IN (SELECT id FROM orders WHERE table_id=? AND seat=? AND status='cancelled' ORDER BY id DESC LIMIT 5)) ORDER BY id DESC", tableId, t.seat, tableId, t.seat)),
      coupons: all("SELECT * FROM coupons WHERE table_id=? AND seat=? AND status!='void' ORDER BY created_at, code", tableId, t.seat).map(couponOut),
      notice: bannerOut(),
      calls: all('SELECT id, type, created_at FROM calls WHERE table_id=? AND seat=? AND resolved_at IS NULL ORDER BY id', tableId, t.seat).map((c) => ({ id: c.id, type: c.type, createdAt: c.created_at })),
      nick: get('SELECT nick FROM nicks WHERE device=? AND table_id=? AND seat=?', device, tableId, t.seat)?.nick ?? null,
      rewards: rewardsView(tableId, t.seat),
      games: games,
      callTypes: CALL_TYPES,
      pay: payInfo(),
    };
  }

  function tablesView() {
    const ts = now();
    return all('SELECT * FROM tables WHERE id<=? ORDER BY id', tableCount).map((t) => {
      const o = get("SELECT COUNT(*) n, COALESCE(SUM(CASE WHEN paid=0 THEN MAX(0, total-paid_amount+(SELECT COALESCE(SUM(r.amount),0) FROM refunds r WHERE r.order_id=orders.id AND r.done_at IS NOT NULL)) END),0) unpaid, MIN(created_at) first FROM orders WHERE table_id=? AND seat=? AND status!='cancelled'", t.id, t.seat);
      const p = get('SELECT MIN(started_at) first FROM plays WHERE table_id=? AND seat=?', t.id, t.seat);
      const firsts = [o.first, p.first].filter((x) => x != null);
      return {
        number: t.id, seat: t.seat, status: firsts.length ? 'occupied' : 'empty', orderCount: o.n, unpaidTotal: o.unpaid,
        minutesSeated: firsts.length ? Math.floor((ts - Math.min(...firsts)) / 60000) : null,
        openCalls: get('SELECT COUNT(*) n FROM calls WHERE table_id=? AND seat=? AND resolved_at IS NULL', t.id, t.seat).n,
        unclearUntil: unclearCheck(t).ok ? unclearCheck(t).until : null,
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
      waitlist: (sweepWait(), all("SELECT * FROM waitlist WHERE status IN ('waiting','called','noshow') ORDER BY id").map((w) => ({ id: w.id, nick: w.nick, size: w.size, status: w.status, createdAt: w.created_at, calledAt: w.called_at, recalled: !!w.recalled }))),
      waitCallTimeoutMin: waitTimeoutMin(),
      notice: bannerOut(),
      refunds: all('SELECT r.*, o.table_id, o.updated_at AS order_updated_at FROM refunds r JOIN orders o ON o.id=r.order_id ORDER BY (r.done_at IS NULL) DESC, r.id DESC LIMIT 200').map(refundOut),
      coupons: all("SELECT c.* FROM coupons c JOIN tables t ON t.id=c.table_id AND t.seat=c.seat WHERE c.status='issued' AND t.id<=? ORDER BY c.created_at DESC", tableCount).map(couponOut),
      rewards: rewardsView(),
      games,
      hourly: hourlyReward(),
      hour: hourInfo(cur),
      prevHour: hourInfo(cur - HOUR),
      memberDiscountPct: memberPct(),
      memberEnabled,
      tableCount,
      hiddenTablesWithOpenOrders: hiddenOpen(),
      pay: payAll(),
      deposit: depositCounts(),
      depositNotices: listDeposits({ open: true, limit: 50 }).notices, // the newest 50 OPEN notices; everything else: GET /api/staff/deposits?before=&limit=
      memberDiscount: memberSettings(),
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
      orders: orders.map((o) => ({ id: o.id, table: o.table, member: o.member, note: o.note, items: o.items.map((i) => ({ id: i.id, name: i.name, qty: i.qty, service: i.service })), since: o.cookingAt })),
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
      hourly: hourlyReward(),
      games: g,
      gameInfo: games,
      rewards: rewardsView().filter((r) => r.active).map((r) => ({ id: r.id, label: r.label, remaining: r.remaining, stock: r.stock })),
      notice: bannerOut(),
    };
  }

  // ---------- table ops ----------
  function clearTable(n, force) {
    const t = tableRow(n);
    const u = get("SELECT SUM(paid=0) unpaid, COALESCE(SUM(CASE WHEN paid=0 THEN MAX(0, total-paid_amount+(SELECT COALESCE(SUM(r.amount),0) FROM refunds r WHERE r.order_id=orders.id AND r.done_at IS NOT NULL)) END),0) unpaidTotal, SUM(status IN ('pending','cooking')) unserved FROM orders WHERE table_id=? AND seat=? AND status!='cancelled'", n, t.seat);
    if (!force && ((u.unpaid || 0) > 0 || (u.unserved || 0) > 0)) {
      fail(409, 'unsettled', '미입금 또는 서빙 전 주문이 남아 있습니다.', { unpaid: u.unpaid || 0, unserved: u.unserved || 0, unpaidTotal: u.unpaidTotal });
    }
    invalidate();
    return tx(() => {
      const ts = now();
      const clearId = Number(run('INSERT INTO table_clears(table_id, old_seat, new_seat, at) VALUES(?,?,?,?)', n, t.seat, t.seat + 1, ts).lastInsertRowid);
      let writtenOff = { orders: 0, amount: 0 };
      if (force) { // unpaid orders of the seat are written off (미수금): out of revenue, listed in sales until paid
        const rows = all("SELECT id, total, paid_amount - (SELECT COALESCE(SUM(r.amount),0) FROM refunds r WHERE r.order_id=orders.id AND r.done_at IS NOT NULL) AS paid_amount FROM orders WHERE table_id=? AND seat=? AND status!='cancelled' AND paid=0", n, t.seat);
        for (const o of rows) run('UPDATE orders SET written_off=1, written_off_at=?, written_off_clear=? WHERE id=?', ts, clearId, o.id);
        writtenOff = { orders: rows.length, amount: rows.reduce((x, o) => x + Math.max(0, o.total - o.paid_amount), 0) };
      }
      run('UPDATE tables SET seat=seat+1 WHERE id=?', n);
      run('UPDATE calls SET resolved_at=? WHERE table_id=? AND resolved_at IS NULL', ts, n);
      audit('table_clear', `table ${n}`, `${force ? 'forced, ' : ''}written off ${writtenOff.orders} orders / ${writtenOff.amount} won`, `${n}번 테이블 ${force ? '강제 ' : ''}정리${writtenOff.orders ? ` · 미수금 ${writtenOff.orders}건 ${W(writtenOff.amount)}` : ''}`);
      return { seat: t.seat + 1, writtenOff };
    });
  }
  // undo of a clear: only within 10 minutes and only while the new seat is still completely empty
  const UNCLEAR_MS = 10 * 60000;
  function unclearCheck(t) {
    const c = get('SELECT * FROM table_clears WHERE table_id=? ORDER BY id DESC LIMIT 1', t.id);
    if (!c) return { ok: false, reason: 'no_clear' };
    if (c.new_seat !== t.seat) return { ok: false, reason: 'seat_changed' };
    if (now() - c.at > UNCLEAR_MS) return { ok: false, reason: 'too_old' };
    const used = {};
    for (const [k, sql] of [['orders', 'SELECT COUNT(*) n FROM orders WHERE table_id=? AND seat=?'], ['plays', 'SELECT COUNT(*) n FROM plays WHERE table_id=? AND seat=?'],
      ['coupons', 'SELECT COUNT(*) n FROM coupons WHERE table_id=? AND seat=?'], ['nicks', 'SELECT COUNT(*) n FROM nicks WHERE table_id=? AND seat=?'], ['calls', 'SELECT COUNT(*) n FROM calls WHERE table_id=? AND seat=?']]) {
      const n = get(sql, t.id, t.seat).n;
      if (n) used[k] = n;
    }
    if (Object.keys(used).length) return { ok: false, reason: 'seat_in_use', used };
    return { ok: true, clear: c, until: c.at + UNCLEAR_MS };
  }
  function unclearTable(n) {
    const t = tableRow(n);
    const chk = unclearCheck(t);
    if (!chk.ok) fail(409, 'cannot_undo', '테이블 정리를 되돌릴 수 없습니다.', { reason: chk.reason, ...(chk.used ? { used: chk.used } : {}) });
    invalidate();
    return tx(() => {
      run('UPDATE tables SET seat=? WHERE id=?', chk.clear.old_seat, n);
      const flags = run('UPDATE orders SET written_off=0, written_off_at=NULL, written_off_clear=NULL WHERE written_off_clear=?', chk.clear.id).changes;
      run('DELETE FROM table_clears WHERE id=?', chk.clear.id);
      audit('table_unclear', `table ${n}`, `seat back to ${chk.clear.old_seat}, ${flags} write-offs removed`, `${n}번 테이블 정리 되돌리기${flags ? ` · 미수금 ${flags}건 취소` : ''}`);
      return chk.clear.old_seat;
    });
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
      audit('table_move', `table ${a}`, `to table ${b}: ${moved.orders} orders, ${moved.coupons} coupons`, `${a}번 → ${b}번 테이블 옮기기 · 주문 ${moved.orders}건 · 쿠폰 ${moved.coupons}장`);
      return { ...moved, fromSeat: A.seat + 1 };
    });
  }

  // ---------- sales ----------
  // revenue = money actually received (paid amounts of ALL orders, cancelled ones included) minus refunds already paid back.
  // refundDue = refund entries still open; writtenOff = balances of unpaid orders of cleared seats (미수금), never part of revenue.
  const refundOut = (r) => ({ id: r.id, orderId: r.order_id, table: r.table_id, updatedAt: r.order_updated_at ?? null, amount: r.amount, reason: r.reason, createdAt: r.created_at, doneAt: r.done_at ?? null, method: r.done_method ?? null, note: r.done_note ?? null });
  function sales() {
    const o = all('SELECT id, table_id, status, total, discount, member_discount, paid, paid_amount, written_off, written_off_at, created_at, updated_at FROM orders');
    const done = all('SELECT order_id, amount FROM refunds WHERE done_at IS NOT NULL');
    const doneBy = new Map();
    for (const r of done) doneBy.set(r.order_id, (doneBy.get(r.order_id) || 0) + r.amount);
    const live = o.filter((x) => x.status !== 'cancelled');
    const totals = {
      orders: live.length,
      billed: live.reduce((n, x) => n + x.total, 0),
      discount: live.reduce((n, x) => n + x.discount + x.member_discount, 0),
      memberDiscount: live.reduce((n, x) => n + x.member_discount, 0),
      memberOrders: live.filter((x) => x.member_discount > 0).length,
      paidAmount: o.reduce((n, x) => n + x.paid_amount, 0),
      refundsDone: done.reduce((n, r) => n + r.amount, 0),
      paidRevenue: live.reduce((n, x) => n + x.paid_amount, 0),
    };
    totals.revenue = totals.paidAmount - totals.refundsDone;
    totals.refundDue = get('SELECT COALESCE(SUM(amount),0) s FROM refunds WHERE done_at IS NULL').s;
    const held = (x) => x.paid_amount - (doneBy.get(x.id) || 0);
    const wo = live.filter((x) => x.written_off && !x.paid);
    totals.writtenOff = wo.reduce((n, x) => n + Math.max(0, x.total - held(x)), 0);
    totals.unpaidRevenue = live.filter((x) => !x.paid && !x.written_off).reduce((n, x) => n + Math.max(0, x.total - held(x)), 0);
    const byMethod = {};
    for (const m of PAY_METHODS) byMethod[m] = { received: 0, refunded: 0, net: 0, count: 0 };
    for (const p of all('SELECT method, SUM(amount) s, COUNT(*) n FROM payments GROUP BY method')) if (byMethod[p.method]) { byMethod[p.method].received = p.s; byMethod[p.method].count = p.n; }
    for (const p of all('SELECT done_method m, SUM(amount) s FROM refunds WHERE done_at IS NOT NULL GROUP BY done_method')) if (byMethod[p.m]) byMethod[p.m].refunded = p.s;
    for (const m of PAY_METHODS) byMethod[m].net = byMethod[m].received - byMethod[m].refunded; // Σ net = revenue
    const hours = new Map();
    for (const x of o) {
      const h = Math.floor(x.created_at / HOUR) * HOUR;
      const r = hours.get(h) || { hour: h, label: kst(h), orders: 0, billed: 0, revenue: 0, discount: 0 };
      if (x.status !== 'cancelled') { r.orders++; r.billed += x.total; r.discount += x.discount + x.member_discount; }
      r.revenue += x.paid_amount - (doneBy.get(x.id) || 0);
      hours.set(h, r);
    }
    return {
      totals,
      byMethod,
      byHour: [...hours.values()].sort((x, y) => x.hour - y.hour),
      byItem: all("SELECT oi.item_id id, oi.name, SUM(CASE WHEN oi.service=0 THEN oi.qty ELSE 0 END) qty, SUM(CASE WHEN oi.service=1 THEN oi.qty ELSE 0 END) serviceQty, SUM(CASE WHEN oi.service=0 THEN oi.qty*oi.unit_price ELSE 0 END) gross, MAX(oi.rowid) lastrow FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.status!='cancelled' GROUP BY oi.item_id ORDER BY qty DESC, oi.item_id")
        .map((r) => ({ id: r.id, name: r.name, qty: r.qty, serviceQty: r.serviceQty, gross: r.gross })),
      coupons: all("SELECT CASE WHEN source='hour' THEN 'hour' ELSE reward_id END rid, label, type, COUNT(*) issued, SUM(status='used') used FROM coupons GROUP BY rid, label, type ORDER BY rid")
        .map((r) => ({ rewardId: r.rid, label: r.label, type: r.type, issued: r.issued, used: r.used })),
      unpaid: live.filter((x) => !x.paid && !x.written_off).map((x) => ({ orderId: x.id, table: x.table_id, total: x.total, paidAmount: held(x), balance: Math.max(0, x.total - held(x)), updatedAt: x.updated_at })),
      writtenOff: wo.map((x) => ({ orderId: x.id, table: x.table_id, total: x.total, paidAmount: held(x), balance: Math.max(0, x.total - held(x)), writtenOffAt: x.written_off_at, updatedAt: x.updated_at })),
      refunds: all('SELECT r.*, o.table_id, o.updated_at AS order_updated_at FROM refunds r JOIN orders o ON o.id=r.order_id ORDER BY r.id').map(refundOut),
    };
  }
  function salesCsv(summary) {
    const s = summary || sales();
    const esc = (v) => { let x = String(v ?? ''); if (typeof v === 'string' && /^[=+\-@\t\r]/.test(x)) x = "'" + x; /* spreadsheet formula injection */ return /[",\r\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; };
    const line = (...c) => c.map(esc).join(',');
    const t = s.totals;
    const out = [
      line('[요약]'), line('주문수', '주문금액(청구)', '실매출(받은 돈-환불)', '받은 돈', '환불 완료', '환불 예정', '미수금(기록)', '미입금(진행중)', '할인', '회원할인액', '회원할인 건수'),
      line(t.orders, t.billed, t.revenue, t.paidAmount, t.refundsDone, t.refundDue, t.writtenOff, t.unpaidRevenue, t.discount, t.memberDiscount, t.memberOrders), '',
      line('[결제수단별]'), line('수단', '받은 돈', '환불 완료', '순매출', '결제 건수'),
      ...PAY_METHODS.map((m) => line({ transfer: '계좌이체', cash: '현금', other: '기타' }[m], ...(s.byMethod ? [s.byMethod[m].received, s.byMethod[m].refunded, s.byMethod[m].net, s.byMethod[m].count] : ['', '', '', '']))), '',
      line('[시간대별 매출]'), line('시간', '주문수', '청구', '실매출', '할인'),
      ...s.byHour.map((r) => line(r.label, r.orders, r.billed, r.revenue, r.discount)), '',
      line('[메뉴별 판매]'), line('메뉴', '수량', '서비스', '금액(할인 전)'),
      ...s.byItem.map((r) => line(r.name, r.qty, r.serviceQty, r.gross)), '',
      line('[쿠폰]'), line('쿠폰', '종류', '발급', '사용'),
      ...s.coupons.map((r) => line(r.label, r.type === 'discount' ? '할인' : '메뉴', r.issued, r.used)), '',
      line('[미수금]'), line('주문', '테이블', '청구', '받은 돈', '남은 금액'),
      ...s.writtenOff.map((r) => line(r.orderId, r.table, r.total, r.paidAmount, r.balance)), '',
      line('[미결제(진행중)]'), line('주문', '테이블', '청구', '받은 돈', '남은 금액'),
      ...(s.unpaid || []).map((r) => line(r.orderId, r.table, r.total, r.paidAmount, r.balance)), '',
      ...(s.pendingNotices && s.pendingNotices.length ? [line('[미확인 입금 알림]'), line('알림', '금액', '상태'), ...s.pendingNotices.map((n) => line(n.id, n.amount ?? '', n.status)), ''] : []),
      line('[환불]'), line('번호', '주문', '테이블', '금액', '사유', '완료'),
      ...s.refunds.map((r) => line(r.id, r.orderId, r.table, r.amount, r.reason, r.doneAt ? '완료' : '대기')),
    ];
    return '﻿' + out.join('\r\n') + '\r\n';
  }
  function refundDone(id, { method, note, expectedUpdatedAt, amount } = {}) {
    if (!Number.isInteger(amount) || amount < 1) fail(400, 'bad_amount', 'amount(환불 금액)는 필수 정수입니다.');
    const m = method ?? 'cash';
    if (!PAY_METHODS.includes(m)) fail(400, 'bad_method', "method는 'transfer', 'cash', 'other' 중 하나여야 합니다.");
    const memo = note == null || note === '' ? null : cleanLabel(note, 1, 60, 'bad_note', '메모');
    return tx(() => {
      const r = get('SELECT * FROM refunds WHERE id=?', id) || fail(404, 'no_refund', '없는 환불 내역입니다.');
      if (r.done_at) fail(409, 'refund_done', '이미 환불 완료 처리되었습니다.');
      const o = freshOrder(r.order_id, expectedUpdatedAt);
      // bound to what staff saw: a concurrent edit that changed the amount must not be recorded as done
      if (r.amount !== amount) fail(409, 'refund_changed', '환불 금액이 바뀌었습니다. 최신 금액을 확인해 주세요.', { refund: refundOut({ ...r, table_id: o.table_id, order_updated_at: o.updated_at }) });
      const ts2 = nextTs(o);
      run('UPDATE refunds SET done_at=?, done_method=?, done_note=? WHERE id=?', now(), m, memo, id);
      run('UPDATE orders SET updated_at=? WHERE id=?', ts2, r.order_id);
      audit('refund_done', `order #${r.order_id}`, `${r.amount} won by ${m}${memo ? `, ${memo}` : ''}`, `주문 #${r.order_id} 환불 완료 · ${MKO[m]} ${W(r.amount)}${memo ? ` · ${memo}` : ''}`);
      return refundOut({ ...get('SELECT * FROM refunds WHERE id=?', id), table_id: o.table_id, order_updated_at: ts2 });
    });
  }
  // shared wipe of the day's data (reset and business-day close): menu, rewards, settings, tokens, audit log and day reports stay
  function wipeData() {
    for (const t of ['order_items', 'orders', 'payments', 'coupons', 'plays', 'nicks', 'calls', 'waitlist', 'deposit_notices', 'refunds', 'table_clears']) run(`DELETE FROM ${t}`); // notices go; the hook secret and pay settings stay
    run('UPDATE menu_items SET sold_out=0, stock_auto=0 WHERE 1'); // sold-out flags reset; stock counters keep their numbers
    run('UPDATE menu_items SET sold_out=1, stock_auto=1 WHERE stock_left=0'); // ...so an item that ran out by count stays sold out
    run("DELETE FROM sqlite_sequence WHERE name IN ('orders','plays','calls','waitlist','deposit_notices','refunds','table_clears')");
    run('UPDATE tables SET seat=1');
    run("DELETE FROM settings WHERE k IN ('ordering_open','wait_open','notice')");
    run('UPDATE rewards SET issued=0'); // definitions, active flags and configured stock stay; remaining returns to the configured stock
  }
  function reset() {
    invalidate();
    tx(() => { wipeData(); audit('reset', 'all', 'rehearsal data wiped', '데이터 초기화 (연습 데이터 삭제)'); });
  }
  // business day close: freeze the sales summary, then wipe like reset. Returns the report.
  // what would be lost from the live tables: staff must see it (or force)
  function closeCheck(force) {
    const refund = get('SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM refunds WHERE done_at IS NULL');
    const unpaid = get(`SELECT COUNT(*) n, COALESCE(SUM(MAX(0, total - ${heldSql()})),0) s FROM orders WHERE status!='cancelled' AND paid=0 AND written_off=0`);
    const wo = get(`SELECT COUNT(*) n, COALESCE(SUM(MAX(0, total - ${heldSql()})),0) s FROM orders WHERE status!='cancelled' AND paid=0 AND written_off=1`);
    const unserved = get("SELECT COUNT(*) n FROM orders WHERE status IN ('pending','cooking')").n;
    const pn = get("SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM deposit_notices WHERE status IN ('pending','review')");
    if (force === true) return;
    if (!get('SELECT 1 FROM orders LIMIT 1')) fail(409, 'nothing_to_close', '마감할 주문이 없습니다.');
    if (refund.n || unpaid.n || wo.n || unserved || pn.n) {
      fail(409, 'open_items', '환불 예정, 미입금, 서빙 전 주문 또는 미수금이 남아 있습니다. 확인 후 force로 마감하면 보고서에 그대로 기록됩니다.', {
        refundDue: { entries: refund.n, amount: refund.s }, unpaid: { orders: unpaid.n, amount: unpaid.s }, unserved: { orders: unserved }, writtenOff: { orders: wo.n, amount: wo.s }, pendingNotices: { count: pn.n, amount: pn.s },
      });
    }
  }
  // business day close: freeze the sales summary (open refunds, unpaid and written-off orders are itemised in it), then wipe like reset. Returns the report.
  function closeDay(force) {
    invalidate();
    return tx(() => {
      closeCheck(force);
      const first = get('SELECT MIN(created_at) m FROM orders').m;
      const label = new Date((first ?? now()) + 9 * HOUR).toISOString().slice(0, 10); // KST date of the first order (or today)
      const summary = sales();
      const id = Number(run('INSERT INTO day_reports(label, created_at, summary) VALUES(?,?,?)', label, now(), JSON.stringify({ ...summary, generatedAt: now(), forced: force === true, pendingNotices: all("SELECT id, received_at receivedAt, amount, status FROM deposit_notices WHERE status IN ('pending','review') ORDER BY id").map((n) => ({ ...n })) })).lastInsertRowid);
      wipeData();
      audit('day_close', `report ${id}`, `${label}: revenue ${summary.totals.revenue}, refund due ${summary.totals.refundDue}, unpaid ${summary.totals.unpaidRevenue}, written off ${summary.totals.writtenOff}${force === true ? ', forced' : ''}`, `영업 마감 · ${label} · 실매출 ${W(summary.totals.revenue)} · 환불 예정 ${W(summary.totals.refundDue)} · 미결제 ${W(summary.totals.unpaidRevenue)} · 미수금 ${W(summary.totals.writtenOff)}${force === true ? ' · 강제 마감' : ''}`);
      return { id, label, totals: summary.totals };
    });
  }
  const listDayReports = () => all('SELECT id, label, created_at, summary FROM day_reports ORDER BY id DESC').map((r) => ({ id: r.id, label: r.label, createdAt: r.created_at, totals: JSON.parse(r.summary).totals }));
  const dayReport = (id) => { const r = get('SELECT * FROM day_reports WHERE id=?', id) || fail(404, 'no_report', '없는 마감 보고서입니다.'); return { id: r.id, label: r.label, createdAt: r.created_at, ...JSON.parse(r.summary) }; };
  const dayReportCsv = (id) => salesCsv(dayReport(id));
  function listAudit(before, limit) {
    const lim = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 200) : 100;
    const rows = before != null ? all('SELECT * FROM audit_log WHERE id<? ORDER BY id DESC LIMIT ?', before, lim) : all('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?', lim);
    return { entries: rows.map((r) => ({ id: r.id, at: r.at, action: r.action, target: r.target, summary: r.summary, summaryKo: r.summary_ko || r.summary })), next: rows.length === lim ? rows[rows.length - 1].id : null };
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

  // ---------- one-time seeding of rewards from rewards.json (flag in settings; the file is never re-read afterwards) ----------
  {
    const flagged = !!get("SELECT 1 FROM settings WHERE k='rewards_seeded'");
    const empty = !get('SELECT 1 FROM rewards LIMIT 1');
    if (!flagged && !empty) run("INSERT INTO settings(k,v) VALUES('rewards_seeded','1')");
    else if (!flagged) {
      let problem = null;
      const rows = [];
      try {
        if (!Array.isArray(rewards.rewards)) throw new Error('rewards.json must have "rewards" (array)');
        if (rewards.rewards.length > REWARD_MAX) throw new Error(`more than ${REWARD_MAX} rewards`);
        const ids = new Set();
        for (const r of rewards.rewards) {
          if (!r || typeof r.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(r.id) || ids.has(r.id)) throw new Error(`bad or duplicate reward id ${JSON.stringify(r && r.id)}`);
          ids.add(r.id);
          try { rows.push({ id: r.id, n: normalizeReward(r, null), item: typeof r.item === 'string' && r.item ? r.item.slice(0, 40) : null }); } catch (e) { throw new Error(`reward ${r.id}: ${e.message}`); }
        }
      } catch (e) { problem = e.message; }
      if (problem) console.error(`rewards.json is invalid: ${problem}. Starting with NO rewards (create them as staff, or fix rewards.json and restart: it will be seeded then).`);
      else {
        const legacy = new Map(get("SELECT 1 x FROM sqlite_master WHERE type='table' AND name='reward_stock'") ? all('SELECT * FROM reward_stock').map((x) => [x.id, x]) : []);
        tx(() => {
          rows.forEach(({ id, n, item }, idx) => {
            const lg = legacy.get(id); // an upgraded database keeps its live stock and issued counts
            run('INSERT INTO rewards(id,label,game,threshold,type,amount,item,stock,issued,active,sort) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
              id, n.label, n.game, n.threshold, n.type, n.amount, n.type === 'item' ? (item ?? n.label) : null, lg ? lg.stock : n.stock, lg ? lg.issued : 0, n.active ? 1 : 0, idx);
          });
          const h = rewards.hourly;
          if (h && typeof h.label === 'string' && h.label.trim() && [...h.label.trim()].length <= 20 && !get("SELECT 1 FROM settings WHERE k='hourly_reward'")) {
            run("INSERT INTO settings(k,v) VALUES('hourly_reward',?)", JSON.stringify({ ...HOURLY_DEFAULT, label: h.label.trim(), item: typeof h.item === 'string' && h.item ? h.item : h.label.trim() }));
          }
          run("INSERT INTO settings(k,v) VALUES('rewards_seeded','1')");
        });
      }
    }
  }
  if (!get("SELECT 1 FROM settings WHERE k='member_discount'")) { // first boot, or an upgrade from the single member_discount_pct setting
    run("INSERT INTO settings(k,v) VALUES('member_discount',?)", JSON.stringify(memberSettings()));
  }
  if (!get("SELECT 1 FROM settings WHERE k='pay'")) { // first boot / upgrade: env PAY_* seeds the settings, afterwards the DB wins
    run("INSERT INTO settings(k,v) VALUES('pay',?)", JSON.stringify({ ...PAY_DEFAULT, bank: payEnv.bank || '', account: payEnv.account || '', holder: payEnv.holder || '' }));
  }
  depositSecret();
  // Boot self-heal. Older code (a roll-back to Release 1 and forward again, or a crash mid-migration) writes only the paid FLAG: wherever the flag
  // contradicts the money recorded, the flag is trusted. Idempotent: a second boot changes nothing.
  tx(() => {
    const fixed = new Set();
    for (const o of all("SELECT * FROM orders WHERE status!='cancelled' AND paid=1 AND total>0")) { // (a) flagged paid, money held < total
      if (heldOf(o) >= o.total) continue;
      run("UPDATE orders SET paid_amount=?, paid_method='other', paid_at=COALESCE(paid_at,updated_at) WHERE id=?", o.total + refundDoneSum(o.id), o.id);
      syncRefund(o.id, 'overpaid'); fixed.add(o.id);
    }
    for (const o of all("SELECT * FROM orders WHERE status!='cancelled' AND paid=0 AND total>0")) { // (b) flagged unpaid, money held covers the total
      if (heldOf(o) < o.total) continue;
      run('UPDATE orders SET paid_amount=?, paid_method=NULL, paid_at=NULL WHERE id=?', refundDoneSum(o.id), o.id);
      syncRefund(o.id, 'overpaid'); fixed.add(o.id);
    }
    for (const o of all("SELECT * FROM orders WHERE status='cancelled'")) { // (c) cancelled while paid: the money held is owed back
      if (o.paid === 1 && o.paid_amount === 0 && o.total > 0) { run("UPDATE orders SET paid_amount=?, paid_method=COALESCE(paid_method,'other') WHERE id=?", o.total, o.id); fixed.add(o.id); }
      const before = refundOpenSum(o.id);
      syncRefund(o.id, 'legacy_cancelled', o.updated_at); // dated with the cancellation, not with this boot
      if (refundOpenSum(o.id) !== before) fixed.add(o.id);
    }
    // per-payment ledger (sales by method) must add up to paid_amount: backfill / repair
    for (const o of all('SELECT id, paid_amount, paid_method, paid_at FROM orders')) {
      const s = get('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE order_id=?', o.id).s;
      if (s === o.paid_amount) continue;
      if (s > o.paid_amount) run('DELETE FROM payments WHERE order_id=?', o.id);
      const have = s > o.paid_amount ? 0 : s;
      if (o.paid_amount - have > 0) run('INSERT INTO payments(order_id,amount,method,at) VALUES(?,?,?,?)', o.id, o.paid_amount - have, o.paid_method || 'other', o.paid_at || now());
    }
    if (fixed.size) audit('migrated', 'boot', `${fixed.size} orders reconciled with their paid flag`, `1차 버전 데이터 보정 · 주문 ${fixed.size}건 (결제 상태와 받은 돈 맞춤)`);
  });
  if (!get("SELECT 1 FROM settings WHERE k='auto_confirm_default_v2'")) { // auto-confirm ships OFF: forced once on every existing database, staff can switch it on again
    run("INSERT INTO settings(k,v) VALUES('deposit_auto_confirm','0') ON CONFLICT(k) DO UPDATE SET v='0'");
    run("INSERT INTO settings(k,v) VALUES('auto_confirm_default_v2','1')");
  }
  { const hidden = hiddenOpen(); if (hidden.length) console.error(`WARNING: tables above the table count (${tableCount}) have open orders (unpaid or not served): ${hidden.join(', ')}. They are hidden from staff and guests until the count is raised again.`); }
  { // delete photo files no menu item references (leftovers of a crash, or of deleted items)
    const used = new Set(all('SELECT photo FROM menu_items WHERE photo IS NOT NULL').map((r) => r.photo));
    for (const f of fs.readdirSync(photosDir)) if (!used.has(f)) { try { fs.unlinkSync(path.join(photosDir, f)); } catch { /* ignore */ } }
  }

  return {
    audit, dry, editItems, addService, moveOrder, refundDone, unclearTable, setNotice, createManualCoupon, voidCoupon, setWaitTimeout, sweepWait, listAudit, closeCheck, closeDay, listDayReports, dayReport, dayReportCsv,
    createOrder, setStatus, setPaid, guestCancel, menuView, setSoldOut, setOrdering, orderingOpen,
    setTableCount, rotateToken, tableCountNow: () => tableCount, payInfo, staffPay: payAll, setPay, setDepositor, ingestDeposit, previewDeposit, listDeposits, depositCounts, assignDeposit, attachDeposit, dismissDeposit, setAutoConfirm, depositSecret, rotateDepositSecret, checkDepositSecret, deviceSecret, setPhoto, deletePhoto, photosDir, createReward, updateReward, deleteReward, hourlyReward, setHourlyReward, memberSettings, setMemberSettings, listRewards, createItem, updateItem, deleteItem, createCategory, renameCategory, deleteCategory, reorderMenu, memberPct,
    startPlay, finishPlay, redeem, awardHour, setStock, setNick, addCall, resolveCall,
    addWait, waitStatus, waitCancel, waitAction, setWaitOpen, clearWait, waitInfo,
    newLoginKey, validLoginKey, loginKeyOk, loginKeyFail,
    guestState, staffState, kitchenState, boardState, clearTable, moveTable, sales, salesCsv, reset,
    newSession, validSession, endSession, tokens, backup, orderById,
    close: () => db.close(),
  };
}

module.exports = { createStore, HttpError, CALL_TYPES, parseDeposit, sameDepositor };

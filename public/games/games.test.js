const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { scorePour, GLASSES, TARGETS } = require('./pour.js');
const { scoreCheers, progress, ROUNDS, DUR, FAKE } = require('./cheers.js');
const cfg = require(path.join(__dirname, '..', '..', 'rewards.json')).games;

test('pour: score in 0..100 and perfect pour = 100', () => {
  for (let l = -0.5; l <= 1.5; l += 0.01) {
    const s = scorePour(l, 0.8);
    assert.ok(Number.isInteger(s) && s >= 0 && s <= 100, `level ${l} -> ${s}`);
  }
  assert.equal(scorePour(0.8, 0.8), 100);
  assert.equal(scorePour(1, 0.8), 0);
  assert.equal(scorePour(NaN, 0.8), 0);
});

test('pour: monotonic in error on each side; overshoot never beats equal undershoot', () => {
  const t = 0.8;
  let prev = 101;
  for (let e = 0; e <= 0.2; e += 0.005) { const s = scorePour(t - e, t); assert.ok(s <= prev); prev = s; }
  prev = 101;
  for (let e = 0; e < 0.2; e += 0.005) { const s = scorePour(t + e, t); assert.ok(s <= prev); prev = s; }
  for (let e = 0.01; e < 0.2; e += 0.01) assert.ok(scorePour(t + e, t) <= scorePour(t - e, t));
});

test('cheers: score in 0..100, symmetric, monotonic in |error|', () => {
  assert.equal(scoreCheers(0), 100);
  assert.equal(scoreCheers(10000), 0);
  assert.equal(scoreCheers(NaN), 0);
  let prev = 101;
  for (let e = 0; e <= 600; e += 5) {
    const s = scoreCheers(e);
    assert.ok(Number.isInteger(s) && s >= 0 && s <= 100 && s <= prev);
    assert.equal(s, scoreCheers(-e));
    prev = s;
  }
});

test('cheers: approach progress is monotonic 0..1 for every fake-out strength', () => {
  for (const k of FAKE) {
    assert.equal(progress(0, k), 0);
    assert.ok(Math.abs(progress(1, k) - 1) < 1e-9);
    let prev = -1;
    for (let t = 0; t <= 1; t += 0.01) { const p = progress(t, k); assert.ok(p >= prev); prev = p; }
  }
  assert.equal(DUR.length, ROUNDS);
  assert.equal(FAKE.length, ROUNDS);
});

test('max totals never exceed the server maxScore', () => {
  assert.ok(GLASSES * scorePour(TARGETS[0], TARGETS[0]) <= cfg.pour.maxScore);
  assert.ok(ROUNDS * scoreCheers(0) <= cfg.cheers.maxScore);
});

// ---- 버그 잡기 (bug) and 타자 배틀 (typing) ----
const bug = require('./bug.js');
const typing = require('./typing.js');
// new games (ids bug / typing): bug max 500 / min 9000 ms, typing max 1000 / min 11000 ms
const SERVER = { bug: { max: 500, minMs: 9000 }, typing: { max: 1000, minMs: 11000 } };
let newCfg = null; try { newCfg = require(path.join(__dirname, '..', '..', 'rewards.json')).games; } catch (e) {}

function lcg(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

test('bug: per-bug score is an integer, never below 8, monotonic non-increasing in reaction time', () => {
  for (const life of [850, 1200, 1500]) for (const combo of [0, 3, 10, 50]) {
    let prev = Infinity;
    for (let r = 0; r <= life; r += 10) {
      const s = bug.scoreBug(r, life, combo);
      assert.ok(Number.isInteger(s) && s >= 8 && s <= 24, `${r}/${life}/${combo} -> ${s}`);
      assert.ok(s <= prev); prev = s;
    }
  }
  assert.equal(bug.scoreBug(NaN, 1000, 0), 0);
  assert.ok(bug.scoreBug(100, 1000, 10) >= bug.scoreBug(100, 1000, 0), 'combo never lowers the score');
});

test('bug: decoy costs points but the total stays in 0..max', () => {
  assert.equal(bug.applyDecoy(100), 100 - bug.DECOY_PENALTY);
  assert.equal(bug.applyDecoy(3), 0);
  for (const raw of [-5, 0, 250.4, 499.6, 500, 99999, NaN]) { const f = bug.finalScore(raw); assert.ok(Number.isInteger(f) && f >= 0 && f <= SERVER.bug.max, String(raw)); }
});

test('bug: even a perfect run (instant taps, never missing) is capped at the server max', () => {
  const sched = bug.makeSchedule(lcg(7));
  let raw = 0, combo = 0;
  for (const e of sched) if (e.kind === 'bug') { raw += bug.scoreBug(0, e.life, combo); combo++; }
  assert.ok(raw > bug.MAX, 'uncapped raw is above the cap, so the final clamp matters');
  assert.equal(bug.finalScore(raw), SERVER.bug.max);
});

test('bug: schedule is sane and a full run is far longer than the server minimum', () => {
  for (const seed of [1, 2, 3, 99]) {
    const sched = bug.makeSchedule(lcg(seed));
    assert.equal(sched.filter((e) => e.kind === 'bug').length, bug.BUGS);
    assert.ok(sched.every((e, i) => e.slot >= 0 && e.slot < 15 && e.life > 0 && (i === 0 || e.t >= 0)));
    assert.ok(bug.runLengthMs(sched) >= SERVER.bug.minMs + 5000, String(bug.runLengthMs(sched)));
  }
});

test('typing: score in 0..1000, monotonic up in correct chars and down in errors', () => {
  assert.equal(typing.scoreTyping(0, 30, 10, 0), 0);
  assert.equal(typing.scoreTyping(150, 30, 150, 0), 1000);
  assert.equal(typing.scoreTyping(10000, 30, 10000, 0), 1000, 'speed is capped');
  assert.equal(typing.scoreTyping(NaN, 30, 10, 0), 0);
  assert.equal(typing.scoreTyping(50, 0, 50, 0), 0);
  let prev = -1;
  for (let c = 0; c <= 200; c += 5) { const s = typing.scoreTyping(c, 30, Math.max(c, 1), 0); assert.ok(Number.isInteger(s) && s >= 0 && s <= 1000 && s >= prev); prev = s; }
  prev = Infinity;
  for (let e = 0; e <= 100; e += 2) { const s = typing.scoreTyping(100, 30, 100, e); assert.ok(s >= 0 && s <= prev); prev = s; }
});

test('typing: a full run cannot finish under the server minimum, totals within max', () => {
  assert.ok(typing.PLAY_MS + typing.COUNT_MS >= SERVER.typing.minMs + 5000);
  assert.ok(typing.scoreTyping(typing.PLAY_MS / 1000 * typing.CPS_CAP, typing.PLAY_MS / 1000, 999, 0) <= SERVER.typing.max);
});

test('typing: word list is Latin-only lowercase, prefix check and opponent are sane', () => {
  assert.ok(typing.WORDS.length > 30);
  for (const w of typing.WORDS) assert.match(w, /^[a-z0-9 .\-]+$/, w);
  assert.ok(typing.isPrefix('git push', 'git p'));
  assert.ok(typing.isPrefix('git push', 'GIT '));
  assert.ok(!typing.isPrefix('git push', 'gat'));
  let prev = -1; for (let t = 0; t <= 30000; t += 500) { const c = typing.oppChars(t); assert.ok(c >= 0); prev = c; }
  assert.ok(typing.oppChars(30000) > 20 && typing.oppChars(30000) < 200);
  const rand = lcg(3); let last = ''; for (let i = 0; i < 40; i++) { const w = typing.pickWord(i, last, rand); assert.notEqual(w, last); last = w; }
});

test('totals never exceed what rewards.json (the server config) allows', { skip: !(newCfg && newCfg.bug && newCfg.typing) }, () => {
  assert.equal(newCfg.bug.maxScore, SERVER.bug.max); assert.equal(newCfg.typing.maxScore, SERVER.typing.max);
  assert.ok(newCfg.bug.minDurationMs <= SERVER.bug.minMs && newCfg.typing.minDurationMs <= SERVER.typing.minMs);
});

test('typing: matcher accepts trailing space, case and composed commits', () => {
  assert.ok(typing.matches('ls', 'ls'));
  assert.ok(typing.matches('ls', 'ls '));          // keyboard auto-inserted space
  assert.ok(typing.matches('hello', 'HeLLo'));
  assert.ok(typing.matches('git push', '  git push  '));
  assert.ok(typing.matches('comhere', 'comhere'), 'a whole word committed in one input event');
  assert.ok(!typing.matches('ls', 'l'));
  assert.ok(!typing.matches('git push', 'git'));
  assert.ok(!typing.matches('sudo', 'sudoo'));
  assert.ok(typing.isPrefix('git push', 'git '), 'a prefix with a trailing space is not an error');
});

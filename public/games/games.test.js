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

/* 버그 잡기 (bug hunt), game id "bug". Max 500 points, a full run lasts ~22 s (server minimum 8 s).
   Tap the bugs on the code lines; the "feature" sparkle (기능) is a decoy and costs points. Clock-based (performance.now). */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BugGame = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var MAX = 500, BUGS = 28, DECOY_AFTER = [3, 7, 11, 15, 19, 23, 26], DECOY_PENALTY = 15, DECOY_LIFE = 1200;
  var COLS = 3, ROWS = 5, COUNT_MS = 2400, SUMMARY_MS = 2200;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // points for squashing one bug: faster reaction = more (8..16), combo (hits in a row before this one) multiplies up to x1.5
  function scoreBug(reactionMs, lifeMs, combo) {
    if (!(lifeMs > 0) || !(reactionMs >= 0)) return 0;
    var base = clamp(Math.round(16 - 8 * (reactionMs / lifeMs)), 8, 16);
    var mult = 1 + 0.05 * clamp(combo | 0, 0, 10);
    return Math.round(base * mult);
  }
  function applyDecoy(raw) { return Math.max(0, raw - DECOY_PENALTY); }
  function finalScore(raw) { return clamp(Math.round(raw) || 0, 0, MAX); }

  // spawn plan: pure, deterministic given rand(). t = ms after the countdown.
  function makeSchedule(rand) {
    rand = rand || Math.random;
    var ev = [], t = 500, i, k, gap, life;
    function pickSlot(at, lifeMs) {
      for (var tries = 0; tries < 30; tries++) {
        var s = Math.floor(rand() * COLS * ROWS), ok = true;
        for (var j = ev.length - 1; j >= 0; j--) if (ev[j].slot === s && ev[j].t + ev[j].life + 150 > at && ev[j].t - 150 < at + lifeMs) { ok = false; break; }
        if (ok) return s;
      }
      return Math.floor(rand() * COLS * ROWS);
    }
    for (i = 0; i < BUGS; i++) {
      k = i / (BUGS - 1); gap = Math.round(900 - 380 * k); life = Math.round(1500 - 650 * k);
      ev.push({ t: t, kind: 'bug', slot: pickSlot(t, life), life: life });
      if (DECOY_AFTER.indexOf(i) >= 0) { var dt = t + Math.round(gap / 2); ev.push({ t: dt, kind: 'decoy', slot: pickSlot(dt, DECOY_LIFE), life: DECOY_LIFE }); }
      t += gap;
    }
    return ev;
  }
  function runLengthMs(sched) { var m = 0; sched.forEach(function (e) { m = Math.max(m, e.t + e.life); }); return COUNT_MS + m + SUMMARY_MS; }

  var CODE = ['#include <y2k.h>', 'int main(void) {', '  int i, n = 1999;', '  char *buf = malloc(n);', '  for (i = 0; i < n; i++) {', '    if (buf[i] == NULL) {', '      printf("hello, 2000\\n");', '      continue;', '    }', '    buf[i] = i % 256;', '  }', '  while (!done) {', '    sleep(1);', '    update(&state);', '  }', '  free(buf);', '  return 0;', '}'];
  var BUG = ['..k....k..', '...k..k...', '..kkkkkk..', '.kllllllk.', 'kkllkkllkk', '..llllll..', 'kkllllllkk', '..llllll..', '.k.llll.k.', 'k..k..k..k'];
  var STAR = ['....y....', '....y....', '...yyy...', 'yyyyyyyyy', '.yyyyyyy.', '..yyyyy..', '.yyy.yyy.', '.yy...yy.', 'y.......y'];

  function mount(host, opts) {
    opts = opts || {};
    var reduced = !!opts.reduced, vib = opts.vibrate || function () {};
    var canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;user-select:none;-webkit-user-select:none';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', '버그 잡기 게임 화면. 코드 위에 나타나는 버그를 터치해서 잡고, 기능(반짝이)은 건드리지 마세요. 스페이스바로 가장 오래된 버그를 잡을 수 있어요.');
    host.appendChild(canvas);
    var ctx = canvas.getContext('2d'), W = 0, H = 0, dpr = 1;
    function resize() {
      var r = host.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 3); W = r.width; H = r.height;
      canvas.width = Math.max(1, Math.round(W * dpr)); canvas.height = Math.max(1, Math.round(H * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    try { if (document.fonts && document.fonts.load) document.fonts.load('16px NeoDgm'); } catch (e) {}

    var sched = makeSchedule(), nextEv = 0, ents = [], floats = [];
    var phase = 'count', phaseStart = -1, playStart = 0, now = 0, raw = 0, combo = 0, bestCombo = 0, errors = 0, warnings = 0, flash = 0, flashColor = '#ff3f9f';
    var alive = true, done = false, raf = 0, endAt = 0;
    var playEnd = sched.reduce(function (m, e) { return Math.max(m, e.t + e.life); }, 0);

    function areaTop() { return 40; } function areaBot() { return H - 28; }
    function cell(slot) {
      var cw = W / COLS, chh = (areaBot() - areaTop()) / ROWS, c = slot % COLS, r = Math.floor(slot / COLS);
      return { x: c * cw, y: areaTop() + r * chh, w: cw, h: chh };
    }
    function tapTime(e) { return (e && e.timeStamp && Math.abs(e.timeStamp - now) < 1000) ? e.timeStamp : now; }
    function hitAt(x, y, tt) {
      var best = null, bd = 1e9;
      ents.forEach(function (en) {
        if (en.done) return; var c = cell(en.ev.slot);
        if (x < c.x || x > c.x + c.w || y < c.y || y > c.y + c.h) return;
        var d = Math.abs(x - (c.x + c.w / 2)) + Math.abs(y - (c.y + c.h / 2)); if (d < bd) { bd = d; best = en; }
      });
      if (best) resolve(best, tt);
    }
    function resolve(en, tt) {
      en.done = true; var c = cell(en.ev.slot), cx = c.x + c.w / 2, cy = c.y + c.h / 2;
      if (en.ev.kind === 'bug') {
        var r = clamp(tt - en.spawn, 0, en.ev.life), pts = scoreBug(r, en.ev.life, combo);
        raw += pts; combo++; bestCombo = Math.max(bestCombo, combo);
        floats.push({ x: cx, y: cy, text: '+' + pts, color: '#b9ff3c', born: now }); en.hit = now; vib(12);
      } else {
        raw = applyDecoy(raw); combo = 0; warnings++; flash = now; flashColor = '#ff3f9f';
        floats.push({ x: cx, y: cy, text: '-' + DECOY_PENALTY + ' 기능이에요!', color: '#ffff55', born: now }); vib([30, 30, 30]);
      }
    }
    function onDown(e) {
      e.preventDefault(); if (phase !== 'play') return;
      var r = canvas.getBoundingClientRect(); hitAt(e.clientX - r.left, e.clientY - r.top, tapTime(e));
    }
    function onKey(e) {
      if (!((e.code === 'Space' || e.key === ' ' || e.key === 'Enter') && !e.repeat) || phase !== 'play') return;
      e.preventDefault();
      var oldest = null; ents.forEach(function (en) { if (!en.done && en.ev.kind === 'bug' && (!oldest || en.spawn < oldest.spawn)) oldest = en; });
      if (oldest) resolve(oldest, now);
    }
    function onVis() { if (document.hidden && alive) { destroy(); if (opts.onAbort) opts.onAbort(); } }
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    window.addEventListener('keydown', onKey); window.addEventListener('resize', resize); document.addEventListener('visibilitychange', onVis);

    function update(ts) {
      now = ts; if (phaseStart < 0) phaseStart = ts;
      if (phase === 'count') { if (ts - phaseStart >= COUNT_MS) { phase = 'play'; playStart = ts; } return; }
      if (phase === 'play') {
        var t = ts - playStart;
        while (nextEv < sched.length && sched[nextEv].t <= t) { ents.push({ ev: sched[nextEv], spawn: playStart + sched[nextEv].t, done: false }); nextEv++; }
        ents.forEach(function (en) {
          if (!en.done && ts >= en.spawn + en.ev.life) {
            en.done = true;
            if (en.ev.kind === 'bug') { errors++; combo = 0; flash = ts; flashColor = '#ff8080'; var c = cell(en.ev.slot); floats.push({ x: c.x + c.w / 2, y: c.y + c.h / 2, text: 'ERROR', color: '#ff8080', born: ts }); }
          }
        });
        if (t >= playEnd && nextEv >= sched.length) { phase = 'summary'; phaseStart = ts; }
      } else if (phase === 'summary') {
        if (ts - phaseStart >= SUMMARY_MS && !done) { done = true; alive = false; cleanup(); if (opts.onDone) opts.onDone(finalScore(raw), { errors: errors, warnings: warnings, combo: bestCombo }); }
      }
    }

    function sprite(art, pal, x, y, s) {
      for (var r = 0; r < art.length; r++) for (var c = 0; c < art[r].length; c++) { var ch = art[r][c]; if (ch !== '.') { ctx.fillStyle = pal[ch]; ctx.fillRect(Math.round(x + c * s), Math.round(y + r * s), s, s); } }
    }
    var MONO = '"NeoDgm", ui-monospace, Menlo, monospace';   // pixel font: 16px / 32px only
    var UI = 'system-ui, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif', CODEF = 'ui-monospace, Menlo, Consolas, monospace';
    function draw() {
      ctx.fillStyle = '#0000a8'; ctx.fillRect(0, 0, W, H);
      var top = areaTop(), bot = areaBot(), lh = 20, lines = Math.floor((bot - top) / lh);
      ctx.font = '14px ' + CODEF; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
      for (var i = 0; i < lines; i++) {
        ctx.fillStyle = '#8fa0ff'; ctx.fillText(String(i + 1), 6, top + i * lh + lh / 2);
        ctx.fillStyle = '#ffffff'; ctx.fillText(CODE[i % CODE.length], 34, top + i * lh + lh / 2);
      }
      // grid hint
      ctx.strokeStyle = 'rgba(143,160,255,.25)'; ctx.lineWidth = 1;
      for (var c = 1; c < COLS; c++) { ctx.beginPath(); ctx.moveTo(c * W / COLS, top); ctx.lineTo(c * W / COLS, bot); ctx.stroke(); }
      // entities
      var s = clamp(Math.floor(Math.min(W / COLS, (bot - top) / ROWS) / 13), 3, 6);
      ents.forEach(function (en) {
        var cc = cell(en.ev.slot), cx = cc.x + cc.w / 2, cy = cc.y + cc.h / 2, age = now - en.spawn, frac = clamp(age / en.ev.life, 0, 1);
        if (en.done && !(en.hit && now - en.hit < 220)) return;
        if (en.ev.kind === 'bug') {
          var jig = reduced || en.done ? 0 : (Math.floor(age / 120) % 2 ? 2 : -2);
          if (en.done) { ctx.fillStyle = '#ffff55'; ctx.fillRect(cx - s * 6, cy - s * 6, s * 12, s * 12); ctx.fillStyle = '#fff'; ctx.fillRect(cx - s * 3, cy - s * 3, s * 6, s * 6); return; }
          sprite(BUG, { k: '#000', l: '#b9ff3c' }, cx - 5 * s + jig, cy - 5 * s, s);
          ctx.fillStyle = '#000'; ctx.fillRect(cx - 5 * s, cy + 5 * s + 3, 10 * s, 5);
          ctx.fillStyle = frac > .66 ? '#ff3f9f' : '#b9ff3c'; ctx.fillRect(cx - 5 * s + 1, cy + 5 * s + 4, (10 * s - 2) * (1 - frac), 3);
        } else if (!en.done) {
          sprite(STAR, { y: '#ffe600' }, cx - 4.5 * s, cy - 5 * s, s);
          ctx.font = '700 14px ' + UI; ctx.textAlign = 'center'; ctx.fillStyle = '#ffff55'; ctx.fillText('기능', cx, cy + 5.5 * s + 4); ctx.textAlign = 'left';
        }
      });
      // floating text
      floats = floats.filter(function (f) { return now - f.born < 800; });
      ctx.font = '800 18px ' + UI; ctx.textAlign = 'center';
      floats.forEach(function (f) { var a = (now - f.born) / 800; ctx.globalAlpha = 1 - a; ctx.fillStyle = '#000'; ctx.fillText(f.text, f.x + 1, f.y - 24 * (reduced ? 0 : a) + 1); ctx.fillStyle = f.color; ctx.fillText(f.text, f.x, f.y - 24 * (reduced ? 0 : a)); }); ctx.globalAlpha = 1;
      if (!reduced && flash && now - flash < 160) { ctx.strokeStyle = flashColor; ctx.lineWidth = 6; ctx.strokeRect(3, 3, W - 6, H - 6); }
      // HUD
      ctx.fillStyle = '#c0c0c0'; ctx.fillRect(0, 0, W, 36); ctx.fillStyle = '#000'; ctx.fillRect(0, 36, W, 1);
      ctx.font = '800 18px ' + UI; ctx.textAlign = 'left'; ctx.fillStyle = '#000'; ctx.fillText('SCORE ' + finalScore(raw), 8, 18);
      ctx.textAlign = 'right'; ctx.fillStyle = combo >= 3 ? '#a0005a' : '#000'; ctx.fillText('COMBO x' + (1 + 0.05 * clamp(combo, 0, 10)).toFixed(2), W - 8, 18);
      // progress (segmented)
      var prog = phase === 'play' ? clamp((now - playStart) / playEnd, 0, 1) : phase === 'count' ? 0 : 1;
      ctx.fillStyle = '#c0c0c0'; ctx.fillRect(0, bot, W, 28); ctx.fillStyle = '#fff'; ctx.fillRect(6, bot + 6, W - 12, 16);
      var segs = 20, sw = (W - 16) / segs; ctx.fillStyle = '#000080';
      for (var q = 0; q < Math.round(segs * prog); q++) ctx.fillRect(8 + q * sw, bot + 8, sw - 2, 12);
      // overlays
      ctx.textAlign = 'center';
      if (phase === 'count') {
        var d = 3 - Math.floor((now - phaseStart) / 800);
        panel(d > 0 ? String(d) : 'GO!', ['버그만 잡고 ✨기능은 건드리지 마요'], '#ffff55');
      } else if (phase === 'summary') {
        panel('빌드 결과', [errors + ' errors, ' + warnings + ' warnings', 'SCORE ' + finalScore(raw)], errors === 0 && warnings === 0 ? '#b9ff3c' : '#ffff55');
      }
    }
    function panel(title, lines, color) {
      var pw = Math.min(W - 24, 300), ph = 58 + lines.length * 26, px = (W - pw) / 2, py = (H - ph) / 2 - 10;
      ctx.fillStyle = '#000'; ctx.fillRect(px + 4, py + 4, pw, ph); ctx.fillStyle = '#c0c0c0'; ctx.fillRect(px, py, pw, ph);
      ctx.fillStyle = '#000080'; ctx.fillRect(px + 3, py + 3, pw - 6, 24); ctx.fillStyle = '#fff'; ctx.font = '16px ' + MONO; ctx.textAlign = 'left'; ctx.fillText('debug.exe', px + 10, py + 16);
      ctx.textAlign = 'center'; ctx.fillStyle = '#000'; ctx.font = '32px ' + MONO; ctx.fillText(title, W / 2, py + 52);
      ctx.font = '700 16px ' + UI; lines.forEach(function (l, i) { ctx.fillStyle = '#000'; ctx.fillText(l, W / 2, py + 82 + i * 26); });
      ctx.textAlign = 'left';
    }

    function frame(ts) { if (!alive) return; update(ts); if (alive) { draw(); raf = requestAnimationFrame(frame); } }
    raf = requestAnimationFrame(frame);
    function cleanup() { cancelAnimationFrame(raf); window.removeEventListener('keydown', onKey); window.removeEventListener('resize', resize); document.removeEventListener('visibilitychange', onVis); }
    function destroy() { alive = false; cleanup(); if (canvas.parentNode) canvas.parentNode.removeChild(canvas); }
    return { destroy: destroy };
  }

  return { scoreBug: scoreBug, applyDecoy: applyDecoy, finalScore: finalScore, makeSchedule: makeSchedule, runLengthMs: runLengthMs, mount: mount, MAX: MAX, BUGS: BUGS, DECOY_PENALTY: DECOY_PENALTY };
});

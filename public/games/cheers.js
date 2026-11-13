/* 건배 타이밍 - tap the instant the two mugs clink. 10 rounds, max 1000. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CheersGame = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var ROUNDS = 10, SPAN_MS = 350;
  // approach duration per round (ms) and fake-out strength k (0 = steady, ~0.85 = slows mid-way then rushes)
  var DUR = [1300, 1250, 1250, 1200, 1150, 1150, 1100, 1050, 1000, 950];
  var FAKE = [0, 0, 0.85, 0, 0.3, 0.85, 0, 0.85, 0.3, 0.85];

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  // errMs: signed or absolute timing error in ms. 0 -> 100, >= SPAN_MS -> 0.
  function scoreCheers(errMs) {
    var e = Math.abs(errMs);
    if (!(e >= 0)) return 0;
    return clamp(Math.round(100 * (1 - e / SPAN_MS)), 0, 100);
  }
  // normalised approach progress, p(0)=0, p(1)=1, monotonic for k<1
  function progress(t, k) {
    t = clamp(t, 0, 1);
    return t + k * Math.sin(2 * Math.PI * t) / (2 * Math.PI);
  }
  function rate(s, err) {
    if (s === 0 && err === null) return '놓쳤어요';
    return s >= 90 ? '완벽한 건배!' : s >= 70 ? '좋아요' : s >= 40 ? (err < 0 ? '조금 빨랐어요' : '조금 늦었어요') : (err < 0 ? '너무 빨라요' : '너무 늦었어요');
  }

  function mount(host, opts) {
    opts = opts || {};
    var reduced = !!opts.reduced;
    var vib = opts.vibrate || function () {};
    var canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;user-select:none;-webkit-user-select:none';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', '건배 타이밍 게임 화면. 양쪽에서 잔이 다가오며, 부딪히는 순간 화면을 탭하세요. 스페이스바도 사용할 수 있어요.');
    host.appendChild(canvas);
    var ctx = canvas.getContext('2d');
    var W = 0, H = 0, dpr = 1;
    function resize() {
      var r = host.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 3);
      W = r.width; H = r.height;
      canvas.width = Math.max(1, Math.round(W * dpr));
      canvas.height = Math.max(1, Math.round(H * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();

    var phase = 'count', phaseStart = -1, ri = 0, tStart = 0, clinkAt = 0, resultEnd = 0;
    var scores = [], total = 0, msg = '', msgScore = 0, msgErr = null, flashAt = -1e9, sparks = [];
    var done = false, alive = true, raf = 0, now = 0, shake = 0;

    function startRound(ts) { phase = 'gap'; phaseStart = ts; }
    function tap(evTs) {
      if (phase !== 'approach' || done) return;
      var t = (evTs && Math.abs(evTs - now) < 1000) ? evTs : now;
      var err = t - clinkAt;
      var s = scoreCheers(err);
      record(s, err);
      resultEnd = Math.max(now + 750, clinkAt + 600);
      phase = 'result';
    }
    function record(s, err) {
      scores.push(s); total += s; msgScore = s; msgErr = err; msg = rate(s, err);
      vib(s >= 70 ? 20 : [10, 30, 10]);
    }
    function onDown(e) { e.preventDefault(); tap(e.timeStamp); }
    function onKeyDown(e) { if ((e.code === 'Space' || e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); tap(e.timeStamp); } }
    function onVis() { if (document.hidden && alive) { destroy(); if (opts.onAbort) opts.onAbort(); } }
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', onVis);

    function pos() { // p in 0..1 for current round
      if (phase === 'approach' || phase === 'result') return progress((now - tStart) / DUR[ri], FAKE[ri]);
      return 0;
    }

    function update(ts) {
      now = ts;
      if (phaseStart < 0) phaseStart = ts;
      if (phase === 'count') { if (ts - phaseStart > 2400) startRound(ts); }
      else if (phase === 'gap') { if (ts - phaseStart > 500) { phase = 'approach'; tStart = ts; clinkAt = ts + DUR[ri]; } }
      else if (phase === 'approach') {
        if (ts > clinkAt + SPAN_MS) { record(0, null); resultEnd = ts + 800; phase = 'result'; }
      } else if (phase === 'result') {
        if (flashAt < tStart && ts >= clinkAt) {
          flashAt = ts; shake = reduced ? 0 : 1;
          for (var i = 0; i < (reduced ? 0 : 16); i++) { var a = Math.random() * 6.283, sp = 120 + Math.random() * 220; sparks.push({ x: W / 2, y: H * 0.5, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 60, life: 1 }); }
        }
        if (ts >= resultEnd) {
          ri++;
          if (ri >= ROUNDS) { if (!done) { done = true; alive = false; cleanup(); if (opts.onDone) opts.onDone(total, scores); } }
          else startRound(ts);
        }
      }
      var dt = 16;
      for (var j = sparks.length - 1; j >= 0; j--) { var s = sparks[j]; s.life -= dt / 600; s.x += s.vx * dt / 1000; s.y += s.vy * dt / 1000; s.vy += 500 * dt / 1000; if (s.life <= 0) sparks.splice(j, 1); }
      shake = Math.max(0, shake - 0.08);
    }

    function mug(x, y, w, h, dir) { // dir: -1 handle on left (left mug), +1 handle on right
      var r = 8;
      ctx.save(); ctx.translate(x, y);
      // handle
      ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = 6;
      ctx.beginPath(); ctx.ellipse(dir * (w / 2 + 6), -h * 0.5, 14, h * 0.24, 0, 0, 7); ctx.stroke();
      // body
      ctx.beginPath(); ctx.moveTo(-w / 2 + r, -h); ctx.lineTo(w / 2 - r, -h); ctx.quadraticCurveTo(w / 2, -h, w / 2, -h + r);
      ctx.lineTo(w / 2 - 4, -4); ctx.quadraticCurveTo(w / 2 - 4, 0, w / 2 - 10, 0); ctx.lineTo(-w / 2 + 10, 0); ctx.quadraticCurveTo(-w / 2 + 4, 0, -w / 2 + 4, -4);
      ctx.lineTo(-w / 2, -h + r); ctx.quadraticCurveTo(-w / 2, -h, -w / 2 + r, -h); ctx.closePath();
      ctx.fillStyle = 'rgba(255,255,255,.07)'; ctx.fill();
      ctx.save(); ctx.clip();
      var lg = ctx.createLinearGradient(0, -h, 0, 0); lg.addColorStop(0, '#ffcf4a'); lg.addColorStop(1, '#c97a08');
      ctx.fillStyle = lg; ctx.fillRect(-w, -h * 0.82, w * 2, h);
      ctx.fillStyle = '#fff6df'; ctx.fillRect(-w, -h * 0.9, w * 2, h * 0.1);
      for (var i = 0; i < 4; i++) { ctx.beginPath(); ctx.arc(-w / 2 + (i + 0.5) * w / 4, -h * 0.9, h * 0.07, Math.PI, 0); ctx.fill(); }
      ctx.restore();
      ctx.strokeStyle = 'rgba(255,255,255,.6)'; ctx.lineWidth = 3; ctx.stroke();
      ctx.restore();
    }

    function draw() {
      var g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#1c1511'); g.addColorStop(1, '#0e0b09');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      ctx.save();
      if (shake > 0) ctx.translate((Math.random() - 0.5) * 8 * shake, (Math.random() - 0.5) * 8 * shake);
      for (var i = 0; i < 9; i++) {
        var lx = (i + 0.5) * W / 9, ly = 52 + Math.sin(i * 0.9) * 6;
        ctx.fillStyle = i % 2 ? 'rgba(255,176,32,.85)' : 'rgba(255,110,61,.85)';
        ctx.beginPath(); ctx.arc(lx, ly, 3.5, 0, 7); ctx.fill();
      }
      var cx = W / 2, floor = H * 0.64, mw = Math.min(W * 0.2, 96), mh = mw * 1.4;
      var cg = ctx.createLinearGradient(0, floor, 0, H);
      cg.addColorStop(0, '#5a3a22'); cg.addColorStop(1, '#2a1a0f');
      ctx.fillStyle = cg; ctx.fillRect(0, floor, W, H - floor);
      ctx.fillStyle = 'rgba(255,200,120,.25)'; ctx.fillRect(0, floor, W, 2);
      // center marker
      ctx.strokeStyle = 'rgba(255,176,32,.25)'; ctx.lineWidth = 2; ctx.setLineDash([4, 8]);
      ctx.beginPath(); ctx.moveTo(cx, floor - mh - 40); ctx.lineTo(cx, floor); ctx.stroke(); ctx.setLineDash([]);

      if (phase === 'approach' || phase === 'result') {
        var p = pos(), L = cx - mw / 2 + mw * 0.7;
        var off = L * (1 - p);
        mug(cx - mw / 2 - off, floor - 4, mw, mh, -1);
        mug(cx + mw / 2 + off, floor - 4, mw, mh, 1);
      }
      // sparks
      var since = now - flashAt;
      if (since >= 0 && since < 250 && phase === 'result') {
        ctx.strokeStyle = 'rgba(255,246,223,' + (1 - since / 250) + ')'; ctx.lineWidth = 3;
        for (var a = 0; a < 8; a++) { var ang = a * Math.PI / 4, r1 = 14 + since * 0.15, r2 = r1 + 18 + since * 0.1; ctx.beginPath(); ctx.moveTo(cx + Math.cos(ang) * r1, floor - mh * 0.55 + Math.sin(ang) * r1); ctx.lineTo(cx + Math.cos(ang) * r2, floor - mh * 0.55 + Math.sin(ang) * r2); ctx.stroke(); }
      }
      for (var k = 0; k < sparks.length; k++) { var s = sparks[k]; ctx.globalAlpha = Math.max(0, s.life); ctx.fillStyle = '#ffd36a'; ctx.beginPath(); ctx.arc(s.x, floor - mh * 0.55 + (s.y - H * 0.5), 3, 0, 7); ctx.fill(); }
      ctx.globalAlpha = 1;
      ctx.restore();

      // HUD
      ctx.textAlign = 'left'; ctx.fillStyle = '#f5efe6'; ctx.font = '800 20px system-ui,"Apple SD Gothic Neo","Noto Sans KR",sans-serif';
      ctx.fillText(Math.min(ri + 1, ROUNDS) + ' / ' + ROUNDS + '번째', 16, H - 22);
      ctx.textAlign = 'right'; ctx.fillStyle = '#ffb020'; ctx.fillText(total + '점', W - 16, H - 22);
      ctx.textAlign = 'center';
      if (phase === 'count') {
        var d = 3 - Math.floor((now - phaseStart) / 700);
        ctx.fillStyle = '#ffb020'; ctx.font = '900 ' + Math.round(Math.min(W, H) * 0.28) + 'px system-ui,sans-serif';
        ctx.fillText(d > 0 ? String(d) : '건배!', cx, H * 0.4);
        ctx.fillStyle = '#f5efe6'; ctx.font = '700 17px system-ui,"Apple SD Gothic Neo","Noto Sans KR",sans-serif';
        ctx.fillText('잔이 부딪히는 순간 화면을 탭!', cx, H * 0.4 + 40);
      } else if (phase === 'result') {
        ctx.fillStyle = msgScore >= 70 ? '#4cd08a' : msgScore >= 40 ? '#ffb020' : '#ff5a4d';
        ctx.font = '900 30px system-ui,"Apple SD Gothic Neo","Noto Sans KR",sans-serif';
        ctx.fillText(msg, cx, H * 0.2);
        ctx.fillStyle = '#f5efe6'; ctx.font = '700 20px system-ui,sans-serif';
        ctx.fillText('+' + msgScore + (msgErr === null ? '' : '   (' + (msgErr >= 0 ? '+' : '') + Math.round(msgErr) + 'ms)'), cx, H * 0.2 + 32);
      }
    }

    function frame(ts) {
      if (!alive) return;
      update(ts);
      if (alive) { draw(); raf = requestAnimationFrame(frame); }
    }
    raf = requestAnimationFrame(frame);

    function cleanup() {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVis);
    }
    function destroy() { alive = false; cleanup(); if (canvas.parentNode) canvas.parentNode.removeChild(canvas); }
    return { destroy: destroy };
  }

  return { scoreCheers: scoreCheers, progress: progress, mount: mount, ROUNDS: ROUNDS, DUR: DUR, FAKE: FAKE, MAX: ROUNDS * 100 };
});

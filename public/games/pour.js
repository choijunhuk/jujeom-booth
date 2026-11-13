/* 생맥 따르기 - hold to pour, release at the target line. 5 glasses, max 500. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PourGame = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var GLASSES = 5;
  var TARGETS = [0.80, 0.86, 0.74, 0.82, 0.78];
  var FILL_S = [3.0, 2.6, 2.2, 1.9, 1.6]; // seconds to fill 0..1, speeds up each glass
  var TOL = 0.5;

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // level: 0..1 (1 = rim). Overflow (>=1) scores 0; overshoot costs double the undershoot.
  function scorePour(level, target) {
    if (!(level >= 0)) level = 0;
    if (level >= 1) return 0;
    var err = level - target;
    var e = err > 0 ? err * 2 : -err;
    return clamp(Math.round(100 * (1 - e / TOL)), 0, 100);
  }
  function rate(score, over) {
    if (over) return '넘쳤어요!';
    return score >= 90 ? '완벽!' : score >= 70 ? '좋아요' : score >= 40 ? '아쉬워요' : '다시 감 잡아요';
  }

  function mount(host, opts) {
    opts = opts || {};
    var reduced = !!opts.reduced;
    var vib = opts.vibrate || function () {};
    var canvas = document.createElement('canvas');
    canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none;user-select:none;-webkit-user-select:none';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', '생맥 따르기 게임 화면. 화면을 누르고 있으면 맥주가 채워지고, 떼면 멈춥니다. 스페이스바도 사용할 수 있어요.');
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

    var phase = 'count', phaseT = 0, gi = 0, level = 0, over = false, scores = [], total = 0;
    var msg = '', msgScore = 0, parts = [], done = false, alive = true, last = 0, raf = 0, holdT = 0, hintOn = true;

    function setPhase(p) { phase = p; phaseT = 0; }
    function press() {
      if (phase !== 'ready' || done) return;
      setPhase('fill'); level = 0; over = false; holdT = 0; hintOn = false;
    }
    function release() {
      if (phase !== 'fill') return;
      finishGlass(false);
    }
    function finishGlass(isOver) {
      over = isOver;
      var s = isOver ? 0 : scorePour(level, TARGETS[gi]);
      scores.push(s); total += s; msg = rate(s, isOver); msgScore = s;
      vib(isOver ? [30, 40, 30] : 15);
      if (isOver && !reduced) for (var i = 0; i < 22; i++) parts.push({ x: W / 2 + (Math.random() - 0.5) * 120, y: gTop() - 6, vx: (Math.random() - 0.5) * 260, vy: -80 - Math.random() * 160, r: 3 + Math.random() * 6, life: 1 });
      setPhase('result');
    }

    var pid = null;
    function onDown(e) { e.preventDefault(); if (pid !== null) return; pid = e.pointerId; try { canvas.setPointerCapture(e.pointerId); } catch (x) {} press(); }
    function onUp(e) { e.preventDefault(); if (e.pointerId !== pid) return; pid = null; release(); }
    function onKeyDown(e) { if ((e.code === 'Space' || e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); press(); } }
    function onKeyUp(e) { if (e.code === 'Space' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); release(); } }
    function onVis() { if (document.hidden && alive) { destroy(); if (opts.onAbort) opts.onAbort(); } }
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', onVis);

    function gW() { return Math.min(W * 0.5, 210); }
    function gH() { return Math.min(H * 0.44, 310); }
    function gBot() { return H * 0.74; }
    function gTop() { return gBot() - gH(); }
    function hw(frac) { return gW() * 0.5 * (0.78 + 0.22 * frac); }

    function update(dt) {
      phaseT += dt;
      if (phase === 'count') { if (phaseT > 2600) setPhase('ready'); }
      else if (phase === 'fill') {
        holdT += dt;
        level += dt / 1000 / FILL_S[gi];
        if (!reduced && Math.random() < 0.5) parts.push({ x: W / 2 + (Math.random() - 0.5) * hw(0.3) * 1.4, y: gBot() - 8, vx: 0, vy: -30 - Math.random() * 40, r: 1.5 + Math.random() * 2.5, life: 1, bubble: 1 });
        if (level >= 1) { level = 1; finishGlass(true); }
      } else if (phase === 'result') {
        if (phaseT > 1000) {
          gi++;
          if (gi >= GLASSES) { if (!done) { done = true; setPhase('end'); alive = false; cleanup(); if (opts.onDone) opts.onDone(total, scores); } }
          else { level = 0; over = false; setPhase('ready'); }
        }
      }
      for (var i = parts.length - 1; i >= 0; i--) {
        var p = parts[i];
        p.life -= dt / (p.bubble ? 900 : 1200);
        p.x += p.vx * dt / 1000; p.y += p.vy * dt / 1000;
        if (!p.bubble) p.vy += 700 * dt / 1000;
        if (p.life <= 0) parts.splice(i, 1);
      }
    }

    function draw() {
      var g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#1c1511'); g.addColorStop(1, '#0e0b09');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      // string lights
      for (var i = 0; i < 9; i++) {
        var lx = (i + 0.5) * W / 9, ly = 10 + Math.sin(i * 0.9) * 6 + 42;
        ctx.fillStyle = i % 2 ? 'rgba(255,176,32,.85)' : 'rgba(255,110,61,.85)';
        ctx.beginPath(); ctx.arc(lx, ly, 3.5, 0, 7); ctx.fill();
        ctx.fillStyle = i % 2 ? 'rgba(255,176,32,.12)' : 'rgba(255,110,61,.12)';
        ctx.beginPath(); ctx.arc(lx, ly, 12, 0, 7); ctx.fill();
      }
      var cx = W / 2, top = gTop(), bot = gBot(), gh = gH(), gw = gW();
      // counter
      var cg = ctx.createLinearGradient(0, bot, 0, H);
      cg.addColorStop(0, '#5a3a22'); cg.addColorStop(1, '#2a1a0f');
      ctx.fillStyle = cg; ctx.fillRect(0, bot, W, H - bot);
      ctx.fillStyle = 'rgba(255,200,120,.25)'; ctx.fillRect(0, bot, W, 2);
      // nozzle
      var nzY = Math.max(78, top - gh * 0.55);
      ctx.fillStyle = '#7d7468'; ctx.fillRect(cx - 9, 70, 18, nzY - 70);
      ctx.fillStyle = '#a89c8e'; ctx.fillRect(cx - 16, nzY - 8, 32, 12);
      ctx.fillStyle = '#d9cfc0'; ctx.fillRect(cx - 5, nzY + 4, 10, 8);

      var slide = 1;
      if (!reduced && phase === 'ready') { slide = Math.min(1, phaseT / 320); slide = 1 - Math.pow(1 - slide, 3); }
      var ox = (1 - slide) * W * 0.8 * (gi > 0 ? 1 : 0);
      ctx.save(); ctx.translate(ox, 0);

      // glass back
      var gp = new Path2D();
      gp.moveTo(cx - hw(1), top); gp.lineTo(cx + hw(1), top); gp.lineTo(cx + hw(0), bot); gp.lineTo(cx - hw(0), bot); gp.closePath();
      ctx.fillStyle = 'rgba(255,255,255,.05)'; ctx.fill(gp);

      var lv = clamp(level, 0, 1);
      if (lv > 0) {
        var ly2 = bot - lv * gh;
        ctx.save(); ctx.clip(gp);
        var lg = ctx.createLinearGradient(0, ly2, 0, bot);
        lg.addColorStop(0, '#ffcf4a'); lg.addColorStop(1, '#c97a08');
        ctx.fillStyle = lg; ctx.fillRect(cx - gw, ly2, gw * 2, bot - ly2);
        // foam
        var fh = 8 + (phase === 'fill' ? 6 : 3) + lv * 8;
        ctx.fillStyle = '#fff6df';
        ctx.fillRect(cx - gw, ly2 - 1, gw * 2, fh * 0.5);
        for (var k = 0; k < 9; k++) {
          var fx = cx - gw * 0.5 + k * gw / 8.5, fr = fh * (0.55 + 0.25 * Math.sin(k * 2.3));
          ctx.beginPath(); ctx.arc(fx, ly2 + 1, fr, Math.PI, 0); ctx.fill();
        }
        ctx.restore();
        // stream
        if (phase === 'fill') {
          ctx.fillStyle = '#ffc02e';
          var sw = 7 + (reduced ? 0 : Math.sin(phaseT / 50) * 1.2);
          ctx.fillRect(cx - sw / 2, nzY + 12, sw, ly2 - nzY - 12);
        }
      } else if (phase === 'fill') {
        ctx.fillStyle = '#ffc02e'; ctx.fillRect(cx - 3.5, nzY + 12, 7, bot - nzY - 12);
      }
      // overflow foam
      if (over) {
        ctx.fillStyle = '#fff6df';
        for (var q = 0; q < 7; q++) { ctx.beginPath(); ctx.arc(cx - hw(1) + q * (2 * hw(1)) / 6, top - 4, 12 + (q % 2) * 5, Math.PI, 0); ctx.fill(); }
        ctx.fillStyle = '#ffcf4a';
        ctx.fillRect(cx - hw(1) - 4, top, 5, gh * 0.5); ctx.fillRect(cx + hw(1) - 1, top, 5, gh * 0.35);
      }
      // glass outline
      ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.stroke(gp);
      ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(cx - hw(0.85), top + gh * 0.12); ctx.lineTo(cx - hw(0.2), bot - gh * 0.12); ctx.stroke();
      // target line
      var ty = bot - TARGETS[gi < GLASSES ? gi : GLASSES - 1] * gh;
      ctx.strokeStyle = '#ff5a4d'; ctx.lineWidth = 3; ctx.setLineDash([8, 6]);
      ctx.beginPath(); ctx.moveTo(cx - hw(1) - 14, ty); ctx.lineTo(cx + hw(1) + 14, ty); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#ff5a4d'; ctx.font = '700 15px system-ui,"Apple SD Gothic Neo","Noto Sans KR",sans-serif'; ctx.textAlign = 'left';
      ctx.fillText('여기!', cx + hw(1) + 18, ty + 5);
      ctx.restore();

      // particles
      for (var n = 0; n < parts.length; n++) {
        var p = parts[n];
        ctx.globalAlpha = Math.max(0, p.life);
        ctx.fillStyle = p.bubble ? 'rgba(255,246,223,.8)' : '#fff6df';
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 7); ctx.fill();
      }
      ctx.globalAlpha = 1;

      // HUD
      ctx.textAlign = 'left'; ctx.fillStyle = '#f5efe6'; ctx.font = '800 20px system-ui,"Apple SD Gothic Neo","Noto Sans KR",sans-serif';
      ctx.fillText(Math.min(gi + 1, GLASSES) + ' / ' + GLASSES + '잔', 16, H - 22);
      ctx.textAlign = 'right'; ctx.fillStyle = '#ffb020';
      ctx.fillText(total + '점', W - 16, H - 22);
      ctx.textAlign = 'center';
      if (phase === 'count') {
        var d = 3 - Math.floor(phaseT / 700);
        ctx.fillStyle = '#ffb020'; ctx.font = '900 ' + Math.round(Math.min(W, H) * 0.28) + 'px system-ui,sans-serif';
        ctx.fillText(d > 0 ? String(d) : '시작!', cx, H * 0.38);
        ctx.fillStyle = '#f5efe6'; ctx.font = '700 17px system-ui,"Apple SD Gothic Neo","Noto Sans KR",sans-serif';
        ctx.fillText('꾹 누르면 따르고, 빨간 선에서 손을 떼요', cx, H * 0.38 + 40);
      } else if (phase === 'ready' && hintOn) {
        ctx.fillStyle = '#f5efe6'; ctx.font = '800 20px system-ui,"Apple SD Gothic Neo","Noto Sans KR",sans-serif';
        ctx.fillText('화면을 꾹 누르세요', cx, H * 0.2);
      } else if (phase === 'result') {
        ctx.fillStyle = over ? '#ff5a4d' : msgScore >= 70 ? '#4cd08a' : '#ffb020';
        ctx.font = '900 34px system-ui,"Apple SD Gothic Neo","Noto Sans KR",sans-serif';
        ctx.fillText(msg, cx, H * 0.2);
        ctx.fillStyle = '#f5efe6'; ctx.font = '800 22px system-ui,sans-serif';
        ctx.fillText('+' + msgScore, cx, H * 0.2 + 34);
      }
    }

    function frame(ts) {
      if (!alive) return;
      if (!last) last = ts;
      var dt = Math.min(50, ts - last); last = ts;
      update(dt);
      if (alive || done) draw();
      if (alive) raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    function cleanup() {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVis);
    }
    function destroy() { alive = false; cleanup(); if (canvas.parentNode) canvas.parentNode.removeChild(canvas); }
    return { destroy: destroy };
  }

  return { scorePour: scorePour, mount: mount, GLASSES: GLASSES, TARGETS: TARGETS, MAX: GLASSES * 100 };
});

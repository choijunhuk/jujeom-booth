/* 타자 배틀 (typing battle), game id "typing". Max 1000 points, a full run lasts ~35 s (server minimum 10 s).
   Latin-only words typed into a real <input>; a scripted "상대 해커" races you. Clock-based (performance.now). */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TypingGame = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var MAX = 1000, PLAY_MS = 30000, COUNT_MS = 2400, SUMMARY_MS = 2200, CPS_CAP = 5, GOAL_CHARS = 140, OPP_CPS = 3.3;
  var TIER1 = ['ls', 'cd', 'rm', 'mv', 'cp', 'vi', 'ip', 'ok', 'y2k', '1999', 'bug', 'fix', 'run', 'git', 'npm', 'pwd', 'cat', 'ssh'];
  var TIER2 = ['sudo', 'ping', 'coms', 'make', 'exit', 'echo', 'node', 'hello', 'comhere', 'build', 'push', 'pull', 'grep', 'chmod'];
  var TIER3 = ['git push', 'npm run', 'printf', 'hello world', 'git pull', 'git add .', 'ls -la', 'cd ..', 'make all', 'ping coms', 'sudo su'];

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // correctChars typed correctly in `seconds`; keys = characters typed in total; errs = characters that broke the word.
  // score = speed (capped at CPS_CAP chars/s) x accuracy, 0..1000
  function scoreTyping(correctChars, seconds, keys, errs) {
    if (!(seconds > 0) || !(keys > 0) || !(correctChars >= 0)) return 0;
    var speed = Math.min(correctChars / seconds / CPS_CAP, 1), acc = Math.max(0, 1 - (errs || 0) / keys);
    return clamp(Math.round(MAX * speed * acc), 0, MAX);
  }
  // scripted rival: characters typed after tMs (steady with a slight surge/stall wobble)
  function oppChars(tMs) { var s = Math.max(0, tMs) / 1000; return Math.max(0, OPP_CPS * s + 6 * Math.sin(s * 0.7)); }
  function pickWord(index, last, rand) {
    rand = rand || Math.random;
    var pool = index < 6 ? TIER1 : index < 14 ? TIER1.concat(TIER2) : TIER2.concat(TIER3), w, n = 0;
    do { w = pool[Math.floor(rand() * pool.length)]; } while (w === last && ++n < 10);
    return w;
  }
  function norm(v) { return String(v).replace(/^\s+/, '').toLowerCase(); }
  function isPrefix(target, typed) { return target.indexOf(norm(typed)) === 0; }
  // typed text counts as the word after trim + lower-case (a trailing space auto-inserted by a keyboard is fine)
  function matches(word, typed) { return String(typed).trim().toLowerCase() === String(word).trim().toLowerCase(); }

  function mount(host, opts) {
    opts = opts || {};
    var reduced = !!opts.reduced, vib = opts.vibrate || function () {};
    var el = document.createElement('div'); el.className = 'tb';
    el.innerHTML =
      '<div class="tb-head"><span>TIME <b id="tb-t">30</b>s</span><span>SCORE <b id="tb-s">0</b></span></div>' +
      '<div class="tb-race" aria-hidden="true"><div>나 <span class="tb-bar" id="tb-me"></span></div><div>상대 해커 <span class="tb-bar tb-opp" id="tb-op"></span></div></div>' +
      '<div class="tb-main"><div class="tb-word" id="tb-w" aria-live="off"></div><div class="tb-msg" id="tb-m"></div><div class="tb-log" id="tb-l"></div></div>' +
      '<label class="tb-in"><span>C:\\&gt;</span><input id="tb-i" type="text" inputmode="text" enterkeyhint="done" autocapitalize="off" autocomplete="off" autocorrect="off" spellcheck="false" maxlength="24" aria-label="화면에 나온 명령어를 입력하세요"></label>';
    host.appendChild(el);
    var $ = function (id) { return el.querySelector('#' + id); };
    var input = $('tb-i'), wordEl = $('tb-w'), msgEl = $('tb-m'), logEl = $('tb-l'), timeEl = $('tb-t'), scoreEl = $('tb-s'), meBar = $('tb-me'), opBar = $('tb-op');
    function mkBar(b) { var h = ''; for (var i = 0; i < 14; i++) h += '<i></i>'; b.innerHTML = h; }
    mkBar(meBar); mkBar(opBar);
    function setBar(b, frac) { var n = Math.round(14 * clamp(frac, 0, 1)); for (var i = 0; i < 14; i++) b.children[i].className = i < n ? 'on' : ''; }
    function fit() { el.classList.toggle('tb--tiny', host.clientHeight < 340); }
    fit();
    // keep the prompt above the on-screen keyboard: size the overlay to the visual viewport
    var vv = window.visualViewport, scr = host.closest ? host.closest('.gscr') : null;
    function onVV() { if (!vv || !scr) return; scr.style.setProperty('--vvh', vv.height + 'px'); scr.style.setProperty('--vvt', vv.offsetTop + 'px'); fit(); }
    if (vv) { vv.addEventListener('resize', onVV); vv.addEventListener('scroll', onVV); onVV(); }

    var phase = 'count', phaseStart = -1, playStart = 0, now = 0, alive = true, done = false, raf = 0;
    var word = '', idx = 0, prevVal = '', composing = false;
    var correctChars = 0, keys = 0, errs = 0, words = 0, last = '', lastRender = 0;

    function showWord() {
      var v = input.value, t = word, out = '';
      var typed = norm(v);
      for (var i = 0; i < t.length; i++) {
        var ch = t[i] === ' ' ? '&nbsp;' : t[i].replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; });
        var cls = i < typed.length ? (typed[i] === t[i] ? 'ok' : 'bad') : '';
        out += '<span class="' + cls + '">' + ch + '</span>';
      }
      wordEl.innerHTML = out;
    }
    function nextWord() { word = pickWord(idx++, last); last = word; input.value = ''; prevVal = ''; showWord(); }
    function log(w, ok) { var d = document.createElement('div'); d.textContent = '> ' + w + (ok ? '  OK' : ''); logEl.insertBefore(d, logEl.firstChild); while (logEl.children.length > 4) logEl.removeChild(logEl.lastChild); }

    function evaluate() {
      var v = input.value, added = v.length - prevVal.length;
      if (added > 0) { keys += added; if (!isPrefix(word, v)) { errs += added; vib(8); } }
      prevVal = v;
      if (matches(word, v)) { correctChars += word.length; words++; log(word, true); vib(10); nextWord(); return; }
      showWord();
    }
    function onInput(e) {
      if (phase !== 'play') { input.value = ''; prevVal = ''; return; }
      if (composing || (e && e.isComposing)) { showWord(); return; }   // IME (Gboard / Samsung): judge at commit, never reject text mid-composition
      evaluate();
    }
    function blockPaste(e) { e.preventDefault(); }
    function onBefore(e) { if (e.inputType === 'insertFromPaste' || e.inputType === 'insertFromDrop' || e.inputType === 'insertFromYank') e.preventDefault(); }   // autocorrect / suggestion taps (insertReplacementText, insertCompositionText) stay allowed
    function onCompStart() { composing = true; }
    function onCompEnd() { composing = false; if (phase === 'play') evaluate(); }
    function onBlur() { if (alive) setTimeout(function () { if (alive) { try { input.focus({ preventScroll: true }); } catch (e) {} } }, 0); }
    input.addEventListener('input', onInput); input.addEventListener('paste', blockPaste); input.addEventListener('drop', blockPaste); input.addEventListener('beforeinput', onBefore);
    input.addEventListener('compositionstart', onCompStart); input.addEventListener('compositionupdate', onCompStart); input.addEventListener('compositionend', onCompEnd); input.addEventListener('blur', onBlur);
    el.addEventListener('pointerdown', function (e) { if (e.target !== input) { e.preventDefault(); try { input.focus({ preventScroll: true }); } catch (x) {} } });
    function onVis() { if (document.hidden && alive) { destroy(); if (opts.onAbort) opts.onAbort(); } }
    document.addEventListener('visibilitychange', onVis);
    try { input.focus({ preventScroll: true }); } catch (e) {}

    function update(ts) {
      now = ts; if (phaseStart < 0) phaseStart = ts;
      if (phase === 'count') {
        var d = 3 - Math.floor((ts - phaseStart) / 800);
        wordEl.textContent = d > 0 ? String(d) : 'GO!'; msgEl.textContent = '나오는 명령어를 영어(소문자)로 빠르게!';
        if (ts - phaseStart >= COUNT_MS) { phase = 'play'; playStart = ts; msgEl.textContent = ''; nextWord(); }
      } else if (phase === 'play') {
        var t = ts - playStart, left = Math.max(0, PLAY_MS - t);
        if (ts - lastRender > 100) {
          lastRender = ts; timeEl.textContent = String(Math.ceil(left / 1000)); scoreEl.textContent = String(scoreTyping(correctChars, Math.max(t, 1000) / 1000, keys, errs));
          setBar(meBar, correctChars / GOAL_CHARS); setBar(opBar, oppChars(t) / GOAL_CHARS);
        }
        if (t >= PLAY_MS) {
          phase = 'summary'; phaseStart = ts; input.disabled = true;
          var sc = scoreTyping(correctChars, PLAY_MS / 1000, keys, errs), opp = oppChars(PLAY_MS);
          scoreEl.textContent = String(sc); setBar(meBar, correctChars / GOAL_CHARS); setBar(opBar, opp / GOAL_CHARS);
          wordEl.textContent = correctChars >= opp ? 'YOU WIN' : '상대 해커 승';
          msgEl.textContent = words + '단어 · 정확도 ' + (keys ? Math.round(100 * (1 - errs / keys)) : 0) + '%';
        }
      } else if (phase === 'summary') {
        if (ts - phaseStart >= SUMMARY_MS && !done) { done = true; alive = false; cleanup(); if (opts.onDone) opts.onDone(scoreTyping(correctChars, PLAY_MS / 1000, keys, errs), { words: words, keys: keys, errs: errs }); }
      }
    }
    function frame(ts) { if (!alive) return; update(ts); if (alive) raf = requestAnimationFrame(frame); }
    raf = requestAnimationFrame(frame);

    function cleanup() {
      cancelAnimationFrame(raf); document.removeEventListener('visibilitychange', onVis);
      if (vv) { vv.removeEventListener('resize', onVV); vv.removeEventListener('scroll', onVV); }
      input.removeEventListener('blur', onBlur);
    }
    function destroy() { alive = false; cleanup(); if (scr) { scr.style.removeProperty('--vvh'); scr.style.removeProperty('--vvt'); } if (el.parentNode) el.parentNode.removeChild(el); }
    return { destroy: destroy };
  }

  return { matches: matches, scoreTyping: scoreTyping, oppChars: oppChars, pickWord: pickWord, isPrefix: isPrefix, mount: mount, MAX: MAX, PLAY_MS: PLAY_MS, COUNT_MS: COUNT_MS, SUMMARY_MS: SUMMARY_MS, CPS_CAP: CPS_CAP, WORDS: TIER1.concat(TIER2, TIER3) };
});

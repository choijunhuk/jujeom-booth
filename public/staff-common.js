/* Shared helpers for staff, kitchen, board, wait and QR pages. Vanilla JS, no deps.
   All user-controlled text goes through h() which only ever uses textContent / text nodes. */
(function () {
  'use strict';
  var BASE = window.BASE || '';
  var SC = (window.SC = { BASE: BASE });

  // ---------- DOM builder ----------
  SC.h = function h(tag, props) {
    var el = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v == null || v === false) return;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'dataset') Object.keys(v).forEach(function (d) { el.dataset[d] = v[d]; });
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      });
    }
    for (var i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  };
  function add(el, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(function (x) { add(el, x); });
    else el.appendChild(c.nodeType ? c : document.createTextNode(String(c)));
  }
  var h = SC.h;
  // Replace children, flattening arrays and skipping null/false (unlike replaceChildren).
  SC.fill = function (el) { el.replaceChildren(); for (var i = 1; i < arguments.length; i++) add(el, arguments[i]); return el; };
  SC.$ = function (sel, root) { return (root || document).querySelector(sel); };

  // ---------- formatting ----------
  SC.won = function (n) { return Number(n || 0).toLocaleString('ko-KR') + '원'; };
  SC.agoText = function (ts, now) {
    var s = Math.max(0, Math.floor(((now || Date.now()) - ts) / 1000));
    if (s < 45) return '방금';
    var m = Math.round(s / 60);
    if (m < 60) return m + '분 전';
    return Math.floor(m / 60) + '시간 ' + (m % 60) + '분 전';
  };
  SC.durText = function (ts, now) {
    var m = Math.max(0, Math.floor(((now || Date.now()) - ts) / 60000));
    if (m < 60) return m + '분';
    return Math.floor(m / 60) + '시간 ' + (m % 60) + '분';
  };
  SC.clock = function (ts) {
    return new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul' });
  };
  // Self-updating relative time. kind: 'ago' ("7분 전") or 'dur' ("7분")
  SC.timeEl = function (ts, kind) {
    var el = h('span', { class: 'time', dataset: { ts: ts, kind: kind || 'ago' } });
    el.textContent = kind === 'dur' ? SC.durText(ts) : SC.agoText(ts);
    return el;
  };
  SC.tickTimes = function (root) {
    var now = Date.now();
    (root || document).querySelectorAll('[data-ts]').forEach(function (el) {
      var ts = Number(el.dataset.ts);
      var t = el.dataset.kind === 'dur' ? SC.durText(ts, now) : SC.agoText(ts, now);
      if (el.textContent !== t) el.textContent = t;
    });
  };
  setInterval(function () { SC.tickTimes(); }, 15000);

  // ---------- API ----------
  function mkErr(status, code, message, data) {
    var e = new Error(message || '요청에 실패했습니다.');
    e.status = status; e.code = code; e.data = data || {};
    return e;
  }
  SC.api = function (path, opts) {
    opts = opts || {};
    var method = opts.method || (opts.body !== undefined ? 'POST' : 'GET');
    var init = { method: method, headers: {}, cache: 'no-store' };
    if (method === 'POST') {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body === undefined ? {} : opts.body);
    }
    return fetch(BASE + path, init).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (res.ok) return data;
        if (res.status === 401 && !opts.noAuthRedirect && SC.onUnauthorized) SC.onUnauthorized();
        throw mkErr(res.status, data && data.error, (data && data.message) || '요청에 실패했습니다. (' + res.status + ')', data);
      });
    }, function () { throw mkErr(0, 'network', '네트워크 연결을 확인해 주세요.'); });
  };

  // ---------- toast ----------
  SC.toast = function (msg, kind, ms) {
    var box = document.getElementById('toasts');
    if (!box) { box = h('div', { id: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.appendChild(box); }
    var t = h('div', { class: 'toast ' + (kind || 'info'), role: kind === 'error' ? 'alert' : null }, msg);
    box.appendChild(t);
    while (box.children.length > 4) box.removeChild(box.firstChild);
    setTimeout(function () { t.classList.add('out'); setTimeout(function () { t.remove(); }, 250); }, ms || (kind === 'error' ? 5000 : 2600));
  };

  // ---------- confirm dialog ----------
  // opts: {title, message, ok, cancel, danger, typed}
  SC.confirm = function (opts) {
    return new Promise(function (resolve) {
      var dlg = h('dialog', { class: 'dlg', 'aria-labelledby': 'cf-title' });
      var done = false;
      function finish(v) { if (done) return; done = true; dlg.close(); dlg.remove(); resolve(v); }
      var input = null;
      var okBtn = h('button', { class: 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary'), type: 'button', onclick: function () { finish(true); } }, opts.ok || '확인');
      if (opts.typed) {
        okBtn.disabled = true;
        input = h('input', { class: 'field', type: 'text', autocomplete: 'off', 'aria-label': opts.typed + ' 입력', placeholder: opts.typed, oninput: function () { okBtn.disabled = input.value.trim() !== opts.typed; } });
      }
      dlg.appendChild(h('form', { class: 'dlg-body', method: 'dialog', onsubmit: function (e) { e.preventDefault(); if (!okBtn.disabled) finish(true); } },
        h('h2', { id: 'cf-title', class: 'dlg-title' }, opts.title || '확인'),
        opts.message ? h('p', { class: 'dlg-msg' }, opts.message) : null,
        opts.typed ? h('p', { class: 'dlg-msg' }, '계속하려면 "' + opts.typed + '"를 입력하세요.') : null,
        input,
        h('div', { class: 'dlg-actions' },
          h('button', { class: 'btn', type: 'button', onclick: function () { finish(false); } }, opts.cancel || '취소'),
          okBtn)));
      dlg.addEventListener('cancel', function (e) { e.preventDefault(); finish(false); });
      document.body.appendChild(dlg);
      dlg.showModal();
      (input || okBtn).focus();
    });
  };

  // ---------- preferences (localStorage, every access guarded) ----------
  var PREF_KEY = 'sc_alarm';
  var stored = {};
  try { stored = JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch (e) { stored = {}; }
  var prefs = Object.assign({ sound: true, notify: false, wake: false, vol: 1, everUnlocked: false }, stored);
  function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) { /* storage blocked */ } }
  SC.prefs = {
    get: function (k) { return prefs[k]; },
    set: function (k, v) { prefs[k] = v; savePrefs(); },
    // page-specific default that applies only until the user picks something
    defaults: function (d) { Object.keys(d).forEach(function (k) { if (!(k in stored)) prefs[k] = d[k]; }); },
  };

  // ---------- audio ----------
  var A = (SC.audio = { ctx: null, unlocked: false, onchange: null });
  var VOLS = [0.12, 0.3, 0.7]; // 작게 / 보통 / 크게 (peak gain of a square wave)
  SC.VOL_LABELS = ['작게', '보통', '크게'];
  function changed() { if (A.onchange) A.onchange(); }
  A.state = function () { return !A.unlocked ? 'off' : prefs.sound ? 'on' : 'muted'; };
  A.unlock = function () {
    try {
      var C = window.AudioContext || window.webkitAudioContext;
      if (!A.ctx && C) {
        A.ctx = new C();
        A.ctx.onstatechange = function () { A.unlocked = A.ctx.state === 'running'; changed(); };
      }
      if (A.ctx && A.ctx.state === 'suspended') A.ctx.resume();
      A.unlocked = !!A.ctx && A.ctx.state !== 'closed';
      prefs.sound = true; prefs.everUnlocked = true; savePrefs();
    } catch (e) { A.unlocked = false; }
    changed();
    return A.unlocked;
  };
  A.setSound = function (on) {
    if (on) { if (A.unlock()) A.beep('order'); return; }
    prefs.sound = false; savePrefs(); changed();
  };
  A.toggle = function () { A.setSound(A.state() !== 'on'); };
  A.setVol = function (i) { prefs.vol = Math.max(0, Math.min(2, i)); savePrefs(); changed(); };
  // Browsers need a gesture for audio. If sound was enabled before, re-unlock on the first tap.
  if (prefs.everUnlocked && prefs.sound) {
    var again = function () { document.removeEventListener('pointerdown', again, true); document.removeEventListener('keydown', again, true); A.unlock(); };
    document.addEventListener('pointerdown', again, true);
    document.addEventListener('keydown', again, true);
  }
  // [freq Hz, seconds, 's' = soft sine]; 0 Hz = rest. Each source sounds different.
  var PATTERNS = {
    order: [[784, 0.13], [0, 0.05], [1175, 0.22]],                                   // two rising beeps
    call: [[880, 0.08], [0, 0.07], [880, 0.08], [0, 0.07], [880, 0.08]],             // three short
    wait: [[523, 0.45, 's']],                                                         // one soft
    kitchen: [[659, 0.13], [0, 0.05], [988, 0.24]],                                   // two rising, lower
    called: [[880, 0.2], [0, 0.06], [1175, 0.4]],
    deposit: [[1568, 0.09], [0, 0.05], [1568, 0.09], [0, 0.05], [2093, 0.3]],        // bank deposit needs staff
    tick: [[1760, 0.05, 's']],                                                         // quiet: auto-matched
  };
  var lastHint = 0;
  A.beep = function (kind) {
    if (!prefs.sound) return false;
    if (!A.ctx || !A.unlocked) {
      if (Date.now() - lastHint > 20000) { lastHint = Date.now(); SC.toast('소리가 꺼져 있어요. 화면을 한 번 눌러 주세요.', 'error', 6000); }
      return false;
    }
    try {
      if (A.ctx.state === 'suspended') A.ctx.resume();
      var t = A.ctx.currentTime + 0.02, peak = VOLS[prefs.vol] != null ? VOLS[prefs.vol] : VOLS[1];
      (PATTERNS[kind] || PATTERNS.order).forEach(function (p) {
        if (p[0]) {
          var o = A.ctx.createOscillator(), g = A.ctx.createGain(), soft = p[2] === 's', pk = soft ? peak * 0.7 : peak;
          o.type = soft ? 'sine' : 'square'; o.frequency.value = p[0];
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(pk, t + 0.015);
          g.gain.exponentialRampToValueAtTime(0.0001, t + p[1]);
          o.connect(g); g.connect(A.ctx.destination);
          o.start(t); o.stop(t + p[1] + 0.02);
        }
        t += p[1];
      });
      return true;
    } catch (e) { return false; }
  };
  var flashTimer = 0;
  SC.flash = function () {
    var root = document.documentElement;
    root.classList.remove('sc-flash');
    void root.offsetWidth;
    root.classList.add('sc-flash');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { root.classList.remove('sc-flash'); }, 1600);
  };
  SC.attention = function (kind) { A.beep(kind); SC.flash(); };
  SC.setTitle = function (count, base) { document.title = (count > 0 ? '(' + count + ') ' : '') + base; };

  // Sound toggle button (top bar): 알림 켜기 -> 알림 켜짐 -> 알림 꺼짐
  SC.soundButton = function () {
    var b = h('button', { class: 'btn btn-sound', type: 'button', onclick: function () { A.toggle(); } });
    function sync() {
      var s = A.state();
      b.dataset.s = s;
      b.textContent = s === 'off' ? '알림 켜기' : s === 'on' ? '알림 켜짐' : '알림 꺼짐';
      b.setAttribute('aria-pressed', s === 'on' ? 'true' : 'false');
    }
    var prev = A.onchange;
    A.onchange = function () { if (prev) prev(); sync(); };
    sync();
    return b;
  };
  // Strip shown while audio is still locked, so a silent page is never a surprise.
  SC.audioStrip = function () {
    var el = h('button', { class: 'strip', type: 'button', role: 'status', onclick: function () { A.unlock(); } });
    function sync() {
      el.hidden = A.unlocked || !prefs.sound;
      el.textContent = prefs.everUnlocked ? '소리를 켜려면 화면을 한 번 눌러 주세요' : '알림 소리가 꺼져 있어요. 여기를 눌러 소리를 켜세요';
    }
    var prev = A.onchange;
    A.onchange = function () { if (prev) prev(); sync(); };
    sync();
    return el;
  };

  // ---------- desktop / phone notifications ----------
  var N = (SC.notif = {});
  N.reason = function () {
    if (!('Notification' in window)) return '이 브라우저는 화면 알림을 지원하지 않아요 (아이폰은 홈 화면에 추가해야 해요)';
    if (!window.isSecureContext) return '화면 알림은 https 주소에서만 쓸 수 있어요';
    if (Notification.permission === 'denied') return '브라우저 설정에서 이 사이트의 알림이 차단되어 있어요';
    return '';
  };
  // Ask permission only from a user tap. Resolves true when notifications are on.
  N.enable = function () {
    if (N.reason()) return Promise.resolve(false);
    var ask = window.BoothNotify ? BoothNotify.request() : Promise.resolve(Notification.requestPermission());
    return Promise.resolve(ask).then(function (p) { var ok = (p || (window.Notification && Notification.permission)) === 'granted'; SC.prefs.set('notify', ok); return ok; }, function () { return false; });
  };
  N.show = function (title, body, tag, force) {
    try {
      if (!prefs.notify || N.reason() || Notification.permission !== 'granted') return;
      if (!force && !document.hidden) return;
      if (window.BoothNotify) BoothNotify.show(String(title), { body: String(body || ''), tag: tag });
      else new Notification(String(title), { body: String(body || ''), tag: tag });
    } catch (e) { /* ignore */ }
  };
  SC.itemsText = function (items) {
    if (!items || !items.length) return '';
    return items[0].name + ' ×' + items[0].qty + (items.length > 1 ? ' 외 ' + (items.length - 1) : '');
  };

  // ---------- screen wake lock ----------
  var W = (SC.wake = { sentinel: null, active: function () { return true; } });
  W.reason = function () {
    if (!('wakeLock' in navigator)) return '이 브라우저는 화면 켜 두기를 지원하지 않아요';
    if (!window.isSecureContext) return '화면 켜 두기는 https 주소에서만 쓸 수 있어요';
    return '';
  };
  W.sync = function () {
    try {
      var want = prefs.wake && !W.reason() && document.visibilityState === 'visible' && W.active();
      if (want && !W.sentinel) {
        W.sentinel = 'pending';
        navigator.wakeLock.request('screen').then(function (s) {
          W.sentinel = s;
          s.addEventListener('release', function () { if (W.sentinel === s) W.sentinel = null; });
          if (!(prefs.wake && W.active())) W.release();
        }, function () { W.sentinel = null; });
      } else if (!want && W.sentinel && W.sentinel !== 'pending') W.release();
    } catch (e) { W.sentinel = null; }
  };
  W.release = function () { var s = W.sentinel; W.sentinel = null; try { if (s && s.release) s.release(); } catch (e) { /* ignore */ } };
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') W.release(); W.sync(); });

  // ---------- connection indicator ----------
  var CONN_LABEL = { live: '실시간', poll: '5초마다 갱신', off: '연결 끊김', wait: '연결 중' };
  SC.connIndicator = function () {
    var dot = h('span', { class: 'dot', 'aria-hidden': 'true' });
    var txt = h('span', { text: CONN_LABEL.wait });
    var el = h('div', { class: 'conn', 'data-s': 'wait', role: 'status' }, dot, txt);
    el.set = function (s) { el.dataset.s = s; txt.textContent = CONN_LABEL[s] || s; };
    return el;
  };

  // ---------- live data: SSE with polling fallback ----------
  // opts: {sse, poll, onState, onStatus, interval}. Returns {close, refresh}.
  SC.live = function (opts) {
    var es = null, timer = null, reopen = null, closed = false;
    var every = opts.interval || 5000;
    function status(s) { if (opts.onStatus) opts.onStatus(s); }
    function pollOnce() {
      return SC.api(opts.poll).then(function (d) { if (!closed) { opts.onState(d); if (!es || es.readyState !== 1) status('poll'); } return d; },
        function (e) { if (!closed && e.status !== 401) status('off'); });
    }
    function startPoll() { if (timer || closed) return; pollOnce(); timer = setInterval(pollOnce, every); }
    function stopPoll() { clearInterval(timer); timer = null; }
    function open() {
      if (closed || !window.EventSource) { startPoll(); return; }
      es = new EventSource(BASE + opts.sse);
      es.addEventListener('open', function () { stopPoll(); status('live'); });
      if (opts.hints) Object.keys(opts.hints).forEach(function (k) {
        es.addEventListener(k, function (ev) { try { opts.hints[k](JSON.parse(ev.data)); } catch (e) { /* ignore */ } });
      });
      es.addEventListener('state', function (ev) {
        try { opts.onState(JSON.parse(ev.data)); status('live'); } catch (e) { /* ignore bad frame */ }
      });
      es.addEventListener('error', function () {
        status('poll');
        startPoll();
        if (es && es.readyState === 2) { clearTimeout(reopen); reopen = setTimeout(function () { if (!closed) { es.close(); open(); } }, 10000); }
      });
    }
    open();
    var onVis = function () { if (document.visibilityState === 'visible') pollOnce(); };
    document.addEventListener('visibilitychange', onVis);
    return {
      refresh: pollOnce,
      close: function () { closed = true; stopPoll(); clearTimeout(reopen); if (es) es.close(); document.removeEventListener('visibilitychange', onVis); },
    };
  };

  // ---------- keyed list reconcile (avoids rebuilding untouched nodes) ----------
  // items: array; key(item) -> string; sig(item) -> string; build(item) -> Element; empty: Element|null
  SC.reconcile = function (parent, items, key, sig, build, empty) {
    var old = parent._rc || new Map();
    var next = new Map();
    var els = [];
    items.forEach(function (it) {
      var k = String(key(it)), s = sig(it), e = old.get(k);
      if (!e || e.sig !== s) e = { sig: s, el: build(it) };
      next.set(k, e);
      els.push(e.el);
    });
    parent._rc = next;
    if (!els.length && empty) els = [empty];
    var cur = Array.prototype.slice.call(parent.children);
    var same = cur.length === els.length && cur.every(function (n, i) { return n === els[i]; });
    if (!same) parent.replaceChildren.apply(parent, els);
  };

  // Run an async action bound to a button: disables while in flight, toasts errors.
  SC.act = function (btn, fn, okMsg) {
    if (btn.disabled) return Promise.resolve();
    btn.disabled = true; btn.classList.add('busy');
    return Promise.resolve().then(fn).then(function (r) { if (okMsg) SC.toast(okMsg, 'ok'); return r; },
      function (e) { SC.toast(e.message, 'error'); })
      .then(function (r) { btn.disabled = false; btn.classList.remove('busy'); return r; });
  };
})();

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

  // ---------- audio / attention ----------
  var A = (SC.audio = { ctx: null, unlocked: false, muted: false, onchange: null });
  function store(k, v) { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } }
  A.state = function () { return !A.unlocked ? 'off' : A.muted ? 'muted' : 'on'; };
  A.unlock = function () {
    try {
      var C = window.AudioContext || window.webkitAudioContext;
      if (!A.ctx && C) A.ctx = new C();
      if (A.ctx && A.ctx.state === 'suspended') A.ctx.resume();
      A.unlocked = !!A.ctx;
      A.muted = false;
      store('sc_sound', '1');
    } catch (e) { A.unlocked = false; }
    if (A.onchange) A.onchange();
    return A.unlocked;
  };
  A.toggle = function () {
    if (!A.unlocked) { if (A.unlock()) A.beep('order'); return; }
    A.muted = !A.muted;
    if (!A.muted) A.beep('order');
    if (A.onchange) A.onchange();
  };
  // If sound was enabled on a previous visit, re-unlock on the first tap (browsers need a gesture).
  if (store('sc_sound') === '1') {
    var again = function () { document.removeEventListener('pointerdown', again, true); document.removeEventListener('keydown', again, true); A.unlock(); };
    document.addEventListener('pointerdown', again, true);
    document.addEventListener('keydown', again, true);
  }
  var PATTERNS = {
    order: [[784, 0.12], [1047, 0.12], [1319, 0.22]],
    call: [[659, 0.14], [0, 0.06], [659, 0.14], [0, 0.06], [880, 0.26]],
    wait: [[523, 0.12], [659, 0.12], [523, 0.2]],
    kitchen: [[988, 0.16], [0, 0.05], [988, 0.16], [0, 0.05], [1319, 0.28]],
    called: [[880, 0.2], [0, 0.08], [880, 0.2], [0, 0.08], [1175, 0.4]],
  };
  A.beep = function (kind) {
    if (!A.ctx || !A.unlocked || A.muted) return;
    try {
      var t = A.ctx.currentTime + 0.02;
      (PATTERNS[kind] || PATTERNS.order).forEach(function (p) {
        if (p[0]) {
          var o = A.ctx.createOscillator(), g = A.ctx.createGain();
          o.type = 'square'; o.frequency.value = p[0];
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(0.18, t + 0.015);
          g.gain.exponentialRampToValueAtTime(0.0001, t + p[1]);
          o.connect(g); g.connect(A.ctx.destination);
          o.start(t); o.stop(t + p[1] + 0.02);
        }
        t += p[1];
      });
    } catch (e) { /* ignore */ }
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

  // Sound toggle button factory (keeps label in sync).
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

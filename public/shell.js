/* Shared staff shell: top bar + navigation hub, PIN login screen, auth gate. Used by staff, kitchen and QR pages. */
(function () {
  'use strict';
  var SC = window.SC, h = SC.h, $ = SC.$, BASE = SC.BASE;

  // ---------- navigation hub ----------
  var LINKS = [
    { id: 'staff', label: '주문 보드', href: '/staff', hint: '주문 · 테이블 · 쿠폰 · 메뉴 · 매출' },
    { id: 'kitchen', label: '주방', href: '/kitchen', hint: '만들 음식과 조리 중인 주문' },
    { id: 'qr', label: 'QR 인쇄', href: '/staff/qr', hint: '테이블 QR 카드 인쇄 · 저장' },
    { id: 'board', label: '전광판', href: '/board', hint: '게임 랭킹 화면', blank: true },
    { id: 'wait', label: '대기 화면', href: '/wait', hint: '입구 대기 등록 화면', blank: true },
  ];
  function linkEl(l, cur, cls, withHint) {
    var lbl = h('span', { class: 'lbl' }, l.label);
    var a = h('a', { class: cls, href: BASE + l.href }, lbl);
    if (l.blank) { a.target = '_blank'; a.rel = 'noopener'; lbl.appendChild(h('span', { class: 'ext', 'aria-hidden': 'true' }, ' ↗')); lbl.appendChild(h('span', { class: 'vh' }, ' (새 창)')); }
    if (withHint) a.appendChild(h('span', { class: 'hint' }, l.hint));
    if (l.id === cur) a.setAttribute('aria-current', 'page');
    return a;
  }
  // Big tiles for empty states / home areas.
  SC.hubTiles = function (cur) {
    return h('nav', { class: 'hub-tiles', 'aria-label': '바로가기 (타일)' }, LINKS.filter(function (l) { return l.id !== cur; }).map(function (l) { return linkEl(l, cur, 'hub-tile', true); }));
  };

  // opts: { page: 'staff'|'kitchen'|'qr', label: '스태프', kinds: ['order',...], onLogout: fn }
  SC.shell = function (opts) {
    var conn = SC.connIndicator();
    var nav = h('nav', { class: 'hub', 'aria-label': '바로가기' }, LINKS.map(function (l) { return linkEl(l, opts.page, 'hub-link'); }));
    var sheet = h('dialog', { class: 'dlg hub-sheet', 'aria-label': '바로가기' });
    sheet.appendChild(h('div', { class: 'dlg-body' },
      h('h2', { class: 'dlg-title' }, '바로가기'),
      h('nav', { class: 'hub-list', 'aria-label': '바로가기 (메뉴)' }, LINKS.map(function (l) { return linkEl(l, opts.page, 'hub-row', true); })),
      h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', type: 'button', onclick: function () { sheet.close(); } }, '닫기'))));
    sheet.addEventListener('click', function (e) { if (e.target === sheet) sheet.close(); });
    document.body.appendChild(sheet);
    var menuBtn = h('button', { class: 'btn hub-btn', type: 'button', 'aria-haspopup': 'dialog', onclick: function () { sheet.showModal(); } }, '메뉴');
    var logout = h('button', { class: 'btn', type: 'button', onclick: function () { if (opts.onLogout) opts.onLogout(); } }, '로그아웃');
    var el = h('header', { class: 'top noprint' },
      h('h1', { class: 'y2k-lockup top-brand' }, h('span', { class: 'y2k-ico', 'aria-hidden': 'true' }), h('span', { class: 'y2k-chrome-text' }, 'COMHERE'), h('span', { class: 'brand-page y2k-pixel' }, opts.label)),
      nav, menuBtn, conn, SC.soundButton(), SC.alarmMenu(opts.kinds || ['order']), logout);
    return { el: el, conn: conn };
  };

  // ---------- PIN login ----------
  // Fills `root` with the PIN screen; calls onDone() after a successful login. `where` names the destination.
  SC.login = function (root, onDone, where) {
    var lockedUntil = 0, timer = 0, busy = false;
    var input = h('input', { class: 'field pin-in', type: 'password', inputmode: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', maxlength: '64', 'aria-label': 'PIN', placeholder: 'PIN' });
    var msg = h('p', { class: 'login-msg', role: 'status', 'aria-live': 'polite' }, 'PIN을 입력하세요.');
    var pad = h('div', { class: 'keypad' });
    function locked() { return lockedUntil > Date.now(); }
    function setMsg(t, bad) { msg.textContent = t; msg.className = 'login-msg' + (bad ? ' bad' : ''); }
    function setKeys() { pad.querySelectorAll('button').forEach(function (b) { b.disabled = busy || locked(); }); input.disabled = busy || locked(); }
    function tickLock() {
      var left = Math.ceil((lockedUntil - Date.now()) / 1000);
      if (left > 0) setMsg('시도가 너무 많아요. ' + left + '초 후에 다시 입력할 수 있어요.', true);
      else { clearInterval(timer); timer = 0; setMsg('PIN을 입력하세요.', false); }
      setKeys();
    }
    // keypad taps insert at the caret so mixed keypad/keyboard entry keeps its order
    function press(d) {
      if (busy || locked()) return;
      var v = input.value, s = input.selectionStart == null ? v.length : input.selectionStart, e = input.selectionEnd == null ? s : input.selectionEnd;
      input.value = v.slice(0, s) + d + v.slice(e);
      input.setSelectionRange(s + d.length, s + d.length);
    }
    function back() {
      if (busy || locked()) return;
      var v = input.value, s = input.selectionStart == null ? v.length : input.selectionStart, e = input.selectionEnd == null ? s : input.selectionEnd;
      if (s === e) { if (!s) return; s -= 1; }
      input.value = v.slice(0, s) + v.slice(e);
      input.setSelectionRange(s, s);
    }
    function submit() {
      var pin = input.value;
      if (!pin || busy || locked()) return;
      busy = true; setKeys(); setMsg('확인 중…', false);
      SC.api('/api/staff/login', { body: { pin: pin }, noAuthRedirect: true }).then(function () {
        input.value = ''; busy = false; clearInterval(timer); onDone();
      }, function (e) {
        input.value = ''; busy = false;
        if (e.code === 'locked') {
          lockedUntil = Date.now() + (e.data.retryAfterSec || 30) * 1000;
          clearInterval(timer); timer = setInterval(tickLock, 1000); tickLock();
        } else if (e.code === 'bad_pin') setMsg('PIN이 올바르지 않아요. 남은 시도 ' + (e.data.attemptsLeft != null ? e.data.attemptsLeft + '회' : ''), true);
        else setMsg(e.message, true);
        setKeys();
        if (!locked() && matchMedia('(pointer: fine)').matches) input.focus();
      });
    }
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    '123456789'.split('').forEach(function (d) { pad.appendChild(h('button', { class: 'y2k-btn', type: 'button', 'aria-label': d, onclick: function () { press(d); } }, d)); });
    pad.appendChild(h('button', { class: 'y2k-btn fn', type: 'button', 'aria-label': '한 자리 지우기', onclick: back }, '지움'));
    pad.appendChild(h('button', { class: 'y2k-btn', type: 'button', 'aria-label': '0', onclick: function () { press('0'); } }, '0'));
    pad.appendChild(h('button', { class: 'y2k-btn y2k-btn--primary fn', type: 'button', onclick: submit }, '입장'));
    input.className = 'y2k-field pin-in';
    SC.fill(root, h('form', { class: 'login-card y2k-window', onsubmit: function (e) { e.preventDefault(); submit(); } },
      h('div', { class: 'y2k-title' }, h('span', { class: 'y2k-ico', 'aria-hidden': 'true', style: 'width:16px;height:18px;color:#fff' }), h('h1', { class: 'y2k-title-t', style: 'margin:0;font:inherit' }, 'COMHERE.exe - 스태프 로그인'),
        h('span', { class: 'y2k-title-btns', 'aria-hidden': 'true' }, h('span', { class: 'y2k-tb' }, '_'), h('span', { class: 'y2k-tb' }, '×'))),
      h('div', { class: 'login-body' },
        where ? h('p', { class: 'login-where' }, where + ' 화면은 스태프 PIN이 필요해요.') : null,
        input, msg, pad)));
    if (matchMedia('(pointer: fine)').matches) input.focus();
  };

  // ---------- auth gate ----------
  // opts: { app: Element, start(), stop(), where }. Shows the PIN screen in place when logged out and
  // continues on the same page after login (no redirect).
  SC.gate = function (opts) {
    var login = $('#login');
    if (!login) { login = h('div', { id: 'login', class: 'login', hidden: true }); document.body.insertBefore(login, document.body.firstChild); }
    var active = false;
    function enter() { login.hidden = true; opts.app.hidden = false; active = true; opts.start(); }
    function showLogin() {
      if (active) { active = false; if (opts.stop) opts.stop(); }
      opts.app.hidden = true; login.hidden = false; document.title = '로그인 · COMHERE';
      SC.login(login, enter, opts.where);
    }
    SC.onUnauthorized = function () { if (active) { showLogin(); SC.toast('로그인이 만료됐어요. PIN을 다시 입력해 주세요.', 'error'); } };
    SC.api('/api/staff/me', { noAuthRedirect: true }).then(enter, showLogin);
    return {
      showLogin: showLogin, enter: enter,
      logout: function () { return SC.api('/api/staff/logout', { body: {}, noAuthRedirect: true }).then(null, function () { }).then(showLogin); },
    };
  };
})();

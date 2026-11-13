/* Staff app: PIN login, orders, tables, calls/waitlist, coupons, menu, sales. */
(function () {
  'use strict';
  var SC = window.SC, h = SC.h, $ = SC.$, won = SC.won, BASE = SC.BASE;
  var TITLE = '스태프 · 주점 부스';
  var LABEL = { pending: '접수 대기', cooking: '조리 중', served: '서빙 완료', cancelled: '취소됨' };
  var STTAG = { pending: 'warn', cooking: 'info', served: 'ok', cancelled: 'mute' };
  var TABS = [['orders', '주문'], ['tables', '테이블'], ['calls', '호출·대기'], ['coupons', '쿠폰'], ['menu', '메뉴'], ['sales', '매출']];
  var S = { data: null, tab: 'orders', filter: 'pending', onlyUnpaid: false, billTable: null, moving: false, seen: null, live: null, sales: null, salesAt: 0, salesSig: '', result: null, awardMsg: '' };
  var V = {}; // views: {root, render}
  var conn, tabBtns = {}, badges = {}, bill;

  function api(path, body) { return SC.api(path, { body: body === undefined ? {} : body }); }
  function refresh() { return S.live ? S.live.refresh() : api('/api/staff/state').then(onState); }
  function abtn(cls, label, fn, okMsg) {
    var b = h('button', { class: cls, type: 'button', onclick: function () { SC.act(b, fn, okMsg); } }, label);
    return b;
  }
  function sig(x) { return JSON.stringify(x); }
  var emptyEl = function (t) { return h('div', { class: 'empty' }, t); };

  // =====================================================================
  // login
  // =====================================================================
  function buildLogin() {
    var root = $('#login');
    var lockedUntil = 0, timer = 0, busy = false;
    // Real input so any PIN characters work (server only requires >= 6 chars); keypad taps write into it.
    var input = h('input', { class: 'field pin-in', type: 'password', inputmode: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', maxlength: '64', 'aria-label': 'PIN', placeholder: 'PIN' });
    var msg = h('p', { class: 'login-msg', role: 'status', 'aria-live': 'polite' }, 'PIN을 입력하세요.');
    var pad = h('div', { class: 'keypad' });
    function locked() { return lockedUntil > Date.now(); }
    function setMsg(t, bad) { msg.textContent = t; msg.className = 'login-msg' + (bad ? ' bad' : ''); }
    function setKeys() { pad.querySelectorAll('button').forEach(function (b) { b.disabled = busy || locked(); }); input.disabled = busy || locked(); }
    function tickLock() {
      var left = Math.ceil((lockedUntil - Date.now()) / 1000);
      if (left > 0) { setMsg('시도가 너무 많아요. ' + left + '초 후에 다시 입력할 수 있어요.', true); } else {
        clearInterval(timer); timer = 0; setMsg('PIN을 입력하세요.', false);
      }
      setKeys();
    }
    // Insert at the caret so mixed keypad/keyboard entry keeps its order.
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
        input.value = ''; busy = false; afterLogin();
      }, function (e) {
        input.value = ''; busy = false;
        if (e.code === 'locked') {
          lockedUntil = Date.now() + (e.data.retryAfterSec || 30) * 1000;
          clearInterval(timer); timer = setInterval(tickLock, 1000); tickLock();
        } else if (e.code === 'bad_pin') {
          setMsg('PIN이 올바르지 않아요. 남은 시도 ' + (e.data.attemptsLeft != null ? e.data.attemptsLeft + '회' : ''), true);
        } else setMsg(e.message, true);
        setKeys();
        if (!locked() && matchMedia('(pointer: fine)').matches) input.focus();
      });
    }
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    '123456789'.split('').forEach(function (d) { pad.appendChild(h('button', { class: 'btn', type: 'button', 'aria-label': d, onclick: function () { press(d); } }, d)); });
    pad.appendChild(h('button', { class: 'btn fn', type: 'button', 'aria-label': '한 자리 지우기', onclick: back }, '지움'));
    pad.appendChild(h('button', { class: 'btn', type: 'button', 'aria-label': '0', onclick: function () { press('0'); } }, '0'));
    pad.appendChild(h('button', { class: 'btn btn-primary fn', type: 'button', onclick: submit }, '입장'));
    root.replaceChildren(h('form', { class: 'login-card', onsubmit: function (e) { e.preventDefault(); submit(); } },
      h('h1', { class: 'login-title' }, '주점 부스 ', h('span', null, '스태프')),
      input, msg, pad));
    if (matchMedia('(pointer: fine)').matches) input.focus();
  }
  function afterLogin() {
    var next = new URLSearchParams(location.search).get('next');
    var dest = { kitchen: '/kitchen', qr: '/staff/qr' }[next];
    if (dest) location.replace(BASE + dest); else startApp();
  }
  function showLogin() {
    if (S.live) { S.live.close(); S.live = null; }
    document.querySelectorAll('dialog[open]').forEach(function (d) {
      if (d.classList.contains('wide')) d.close(); else d.dispatchEvent(new Event('cancel', { cancelable: true })); // resolves pending confirms and removes the node
    });
    $('#app').hidden = true;
    document.title = '로그인 · 주점 부스';
    $('#login').hidden = false;
    buildLogin();
  }
  SC.onUnauthorized = function () {
    if (!$('#app').hidden) { showLogin(); SC.toast('로그인이 만료됐어요. PIN을 다시 입력해 주세요.', 'error'); }
  };

  // =====================================================================
  // app shell
  // =====================================================================
  function startApp() {
    $('#login').hidden = true;
    var app = $('#app');
    app.hidden = false;
    if (!app.firstChild) buildApp(app);
    S.data = null; S.seen = null; S.sales = null;
    if (S.live) S.live.close();
    conn.set('wait');
    S.live = SC.live({ sse: '/api/staff/events', poll: '/api/staff/state', onState: onState, onStatus: function (s) { conn.set(s); } });
    var want = location.hash.slice(1);
    setTab(V[want] ? want : S.tab);
  }

  function buildApp(app) {
    conn = SC.connIndicator();
    var logout = h('button', { class: 'btn', type: 'button', onclick: function () {
      SC.api('/api/staff/logout', { body: {}, noAuthRedirect: true }).then(null, function () { }).then(showLogin);
    } }, '로그아웃');
    var top = h('header', { class: 'top' },
      h('h1', null, '주점 부스 ', h('span', null, '스태프')),
      conn, SC.soundButton(),
      h('a', { class: 'btn', href: BASE + '/kitchen' }, '주방 화면'),
      logout);
    var tabs = h('nav', { class: 'tabs', 'aria-label': '메뉴' });
    TABS.forEach(function (t) {
      var b = h('button', { class: 'tab', type: 'button', onclick: function () { setTab(t[0]); } }, t[1]);
      var bd = h('span', { class: 'badge', hidden: true, 'aria-hidden': 'true' });
      b.appendChild(bd);
      tabs.appendChild(b);
      tabBtns[t[0]] = b; badges[t[0]] = bd;
    });
    var main = h('main');
    var builders = { orders: buildOrders, tables: buildTables, calls: buildCalls, coupons: buildCoupons, menu: buildMenu, sales: buildSales };
    TABS.forEach(function (t) {
      V[t[0]] = builders[t[0]]();
      V[t[0]].root.classList.add('view');
      V[t[0]].root.hidden = true;
      main.appendChild(V[t[0]].root);
    });
    bill = h('dialog', { class: 'dlg wide', 'aria-label': '테이블 계산서' });
    bill.addEventListener('close', function () { S.billTable = null; S.moving = false; bill._sig = ''; });
    app.append(top, tabs, main, bill);
    window.addEventListener('hashchange', function () { var t = location.hash.slice(1); if (V[t] && t !== S.tab) setTab(t); });
  }

  function setTab(id) {
    S.tab = id;
    TABS.forEach(function (t) {
      var on = t[0] === id;
      V[t[0]].root.hidden = !on;
      if (on) tabBtns[t[0]].setAttribute('aria-current', 'page'); else tabBtns[t[0]].removeAttribute('aria-current');
    });
    if (location.hash.slice(1) !== id) { try { history.replaceState(null, '', '#' + id); } catch (e) { /* ignore */ } }
    if (S.data) V[id].render();
    if (id === 'sales') loadSales();
    window.scrollTo(0, 0);
  }

  function onState(d) {
    S.data = d;
    detectNew(d);
    var pending = d.orders.filter(function (o) { return o.status === 'pending'; }).length;
    var waiting = d.waitlist.filter(function (w) { return w.status === 'waiting'; }).length;
    setBadge('orders', pending);
    setBadge('calls', d.calls.length + waiting);
    SC.setTitle(pending + d.calls.length, TITLE);
    V[S.tab].render();
    renderBill();
    if (S.tab === 'sales') {
      var s = d.orders.map(function (o) { return o.id + o.status + (o.paid ? 'p' : ''); }).join();
      if (s !== S.salesSig && Date.now() - S.salesAt > 6000) loadSales();
    }
  }
  function setBadge(id, n) {
    var b = badges[id];
    b.hidden = !n;
    b.textContent = n > 99 ? '99+' : String(n);
    tabBtns[id].setAttribute('aria-label', TABS.filter(function (t) { return t[0] === id; })[0][1] + (n ? ' ' + n + '건 대기' : ''));
  }
  function detectNew(d) {
    var ids = { o: new Set(d.orders.map(function (o) { return o.id; })), c: new Set(d.calls.map(function (c) { return c.id; })), w: new Set(d.waitlist.map(function (w) { return w.id; })) };
    var prev = S.seen;
    S.seen = ids;
    if (!prev) return;
    var no = d.orders.filter(function (o) { return !prev.o.has(o.id) && o.status === 'pending'; });
    var nc = d.calls.filter(function (c) { return !prev.c.has(c.id); });
    var nw = d.waitlist.filter(function (w) { return !prev.w.has(w.id); });
    if (no.length) { SC.attention('order'); SC.toast('새 주문 · ' + no.map(function (o) { return o.table + '번'; }).join(', ') + ' 테이블', 'ok'); }
    if (nc.length) {
      if (no.length) setTimeout(function () { SC.attention('call'); }, 800); else SC.attention('call');
      SC.toast('직원 호출 · ' + nc.map(function (c) { return c.table + '번 ' + c.type; }).join(', '), 'ok');
    }
    if (nw.length && !no.length && !nc.length) { SC.attention('wait'); SC.toast('새 대기 등록 ' + nw.length + '팀', 'ok'); }
  }

  // =====================================================================
  // orders
  // =====================================================================
  function buildOrders() {
    var root = h('section', { 'aria-label': '주문' });
    var chipRow = h('div', { class: 'chips phone-only' });
    var chips = {};
    ['pending', 'cooking', 'served', 'cancelled'].forEach(function (st) {
      var n = h('b', { class: 'num' }, '0');
      var c = h('button', { class: 'chip', type: 'button', 'aria-pressed': 'false', onclick: function () { S.filter = st; render(); } }, LABEL[st], n);
      chips[st] = { el: c, n: n };
      chipRow.appendChild(c);
    });
    var unpaidChip = h('button', { class: 'chip', type: 'button', 'aria-pressed': 'false', onclick: function () { S.onlyUnpaid = !S.onlyUnpaid; render(); } }, '미입금만 보기');
    var board = h('div', { class: 'board' });
    var cols = {};
    ['pending', 'cooking', 'served', 'cancelled'].forEach(function (st) {
      var n = h('span', { class: 'n num' }, '0');
      var list = h('div', { class: 'list' });
      cols[st] = { n: n, list: list };
      board.appendChild(h('section', { class: 'col ' + st, 'aria-label': LABEL[st] }, h('div', { class: 'col-head' }, h('span', null, LABEL[st]), n), list));
    });
    root.append(h('div', { class: 'view-head' }, h('h2', null, '주문'), h('div', { class: 'chips' }, unpaidChip)), chipRow, board);

    function render() {
      var by = { pending: [], cooking: [], served: [], cancelled: [] };
      S.data.orders.forEach(function (o) {
        if (S.onlyUnpaid && (o.paid || o.status === 'cancelled')) return;
        (by[o.status] || by.pending).push(o);
      });
      by.pending.sort(function (a, b) { return a.id - b.id; });
      by.cooking.sort(function (a, b) { return (a.cookingAt || a.updatedAt) - (b.cookingAt || b.updatedAt); });
      by.served.sort(function (a, b) { return b.id - a.id; });
      by.cancelled.sort(function (a, b) { return b.id - a.id; });
      board.dataset.f = S.filter;
      unpaidChip.setAttribute('aria-pressed', S.onlyUnpaid ? 'true' : 'false');
      Object.keys(by).forEach(function (st) {
        cols[st].n.textContent = by[st].length;
        chips[st].n.textContent = by[st].length;
        chips[st].el.setAttribute('aria-pressed', S.filter === st ? 'true' : 'false');
        SC.reconcile(cols[st].list, by[st], function (o) { return o.id; }, sig, orderCard, st === 'pending' ? emptyEl('새 주문을 기다리는 중') : emptyEl('없음'));
      });
    }
    return { root: root, render: render };
  }

  function setStatus(o, status) {
    return api('/api/staff/orders/' + o.id + '/status', { status: status }).then(function () {
      lockUntil = Date.now() + 700;
      lockButtons(V.orders.root, 700);
      return refresh();
    });
  }
  function setPaid(o, paid) { return api('/api/staff/orders/' + o.id + '/paid', { paid: paid }).then(refresh); }
  function payToggle(o, small) {
    var cls = 'btn pay' + (o.paid ? ' paid' : '') + (small ? ' btn-sm' : '');
    var b = abtn(cls, o.paid ? '✓ 입금 완료' : '입금 확인', function () {
      if (!o.paid) return setPaid(o, true);
      return SC.confirm({ title: '입금 확인을 취소할까요?', message: o.table + '번 테이블 주문 #' + o.id + '을 미입금으로 되돌려요.', ok: '미입금으로 변경' }).then(function (ok) { if (ok) return setPaid(o, false); });
    });
    if (o.paid) b.setAttribute('aria-label', '입금 완료. 누르면 미입금으로 되돌립니다');
    return b;
  }

  // After a status change the next action (or the next card) slides under the finger: ignore taps briefly.
  var lockUntil = 0;
  function lockButtons(root, ms) {
    var bs = root.querySelectorAll('button');
    bs.forEach(function (b) { b.disabled = true; });
    setTimeout(function () { bs.forEach(function (b) { if (!b.classList.contains('busy')) b.disabled = false; }); }, ms);
  }
  function memDisc(o) { return o.memberDiscount || 0; }
  function coupDisc(o) { return o.couponDiscount != null ? o.couponDiscount : Math.max(0, (o.discount || 0) - memDisc(o)); }
  function orderCard(o) {
    var card = orderCardBuild(o);
    if (Date.now() < lockUntil) lockButtons(card, lockUntil - Date.now());
    return card;
  }
  function orderCardBuild(o) {
    var live = o.status !== 'cancelled';
    var tags = [h('span', { class: 'tag ' + STTAG[o.status] }, LABEL[o.status])];
    if (live) tags.push(o.paid ? h('span', { class: 'tag ok' }, '✓ 입금 완료') : h('span', { class: 'tag bad solid' }, '! 미입금'));
    if (o.member) tags.push(h('span', { class: 'tag info' }, '★ COMS 회원'));
    if (o.couponCode) tags.push(h('span', { class: 'tag info' }, '쿠폰 ' + o.couponCode));
    var act = h('div', { class: 'oact' });
    if (o.status === 'pending') act.appendChild(abtn('btn btn-primary btn-block', '접수 · 조리 시작', function () { return setStatus(o, 'cooking'); }));
    if (o.status === 'cooking') act.appendChild(abtn('btn btn-primary btn-block', '조리 완료 · 서빙', function () { return setStatus(o, 'served'); }));
    if (live) {
      var row = h('div', { class: 'row' }, payToggle(o));
      if (o.status === 'cooking') row.appendChild(abtn('btn', '← 접수 대기로', function () { return setStatus(o, 'pending'); }));
      if (o.status === 'served') row.appendChild(abtn('btn', '← 조리 중으로', function () { return setStatus(o, 'cooking'); }));
      row.appendChild(abtn('btn btn-danger', '주문 취소', function () {
        return SC.confirm({
          title: o.table + '번 테이블 주문 #' + o.id + ' 취소', danger: true, ok: '주문 취소', cancel: '돌아가기',
          message: '취소한 주문은 되돌릴 수 없어요.' + (o.couponCode ? ' 쓴 쿠폰은 다시 쓸 수 있게 돌아가요.' : '') + (o.paid ? ' 이미 입금이 확인된 주문이니 환불은 직접 처리해 주세요.' : ''),
        }).then(function (ok) { if (ok) return setStatus(o, 'cancelled'); });
      }));
      act.appendChild(row);
    }
    return h('article', { class: 'ocard st-' + o.status + (live && !o.paid ? ' unpaid' : '') },
      h('div', { class: 'ohead' },
        h('div', { class: 'tno' }, h('span', { class: 'n', text: o.table }), h('span', { class: 'u', text: '번 테이블' })),
        h('div', { class: 'ometa' },
          h('div', { class: 'line' }, h('span', { class: 'oid' }, '#' + o.id), SC.timeEl(o.createdAt, 'ago')),
          h('div', { class: 'line' }, tags))),
      h('ul', { class: 'items' }, o.items.map(function (i) { return h('li', null, h('span', { class: 'q' }, '×' + i.qty), h('span', null, i.name)); })),
      o.note ? h('p', { class: 'note' }, h('b', null, '요청'), o.note) : null,
      h('div', { class: 'total' }, '합계 ' + won(o.total), o.discount > 0 ? h('s', null, won(o.subtotal)) : null, memDisc(o) > 0 ? h('span', { class: 'disc' }, '회원 −' + won(memDisc(o))) : null, coupDisc(o) > 0 ? h('span', { class: 'disc' }, '쿠폰 −' + won(coupDisc(o))) : null),
      act);
  }

  // =====================================================================
  // tables + bill
  // =====================================================================
  function buildTables() {
    var root = h('section', { 'aria-label': '테이블' });
    var grid = h('div', { class: 'tgrid' });
    root.append(h('div', { class: 'view-head' }, h('h2', null, '테이블'), h('p', { class: 'muted' }, '눌러서 계산서 · 자리 이동 · 정리')), grid);
    function render() {
      SC.reconcile(grid, S.data.tables.slice().sort(function (a, b) { return a.number - b.number; }), function (t) { return t.number; }, sig, tableCard, null);
    }
    return { root: root, render: render };
  }
  function tableCard(t) {
    var occ = t.status === 'occupied';
    var owes = occ && t.unpaidTotal > 0;
    return h('button', { class: 'tcard' + (occ ? ' occ' : '') + (owes ? ' owes' : ''), type: 'button', onclick: function () { openBill(t.number); }, 'aria-label': t.number + '번 테이블 ' + (occ ? '사용 중' : '비어 있음') },
      h('div', { class: 'n' }, String(t.number), h('small', null, '번')),
      h('div', null, occ ? h('span', { class: 'tag warn' }, '사용 중') : h('span', { class: 'tag mute' }, '비어 있음')),
      occ ? h('div', { class: 'meta' }, (t.minutesSeated != null ? t.minutesSeated + '분째' : '') + ' · 주문 ' + t.orderCount + '건') : null,
      owes ? h('div', { class: 'owe' }, '미입금 ' + won(t.unpaidTotal)) : (occ && t.orderCount ? h('div', { class: 'tag ok' }, '✓ 입금 완료') : null),
      t.openCalls ? h('div', null, h('span', { class: 'tag bad solid' }, '호출 ' + t.openCalls)) : null);
  }
  function openBill(n) {
    S.billTable = n; S.moving = false; bill._sig = '';
    renderBill();
    if (!bill.open) bill.showModal();
  }
  function closeBill() { if (bill.open) bill.close(); }
  function renderBill() {
    var n = S.billTable;
    if (!n || !S.data) return;
    var d = S.data;
    var t = d.tables.filter(function (x) { return x.number === n; })[0] || { number: n, status: 'empty' };
    var orders = d.orders.filter(function (o) { return o.table === n; }).sort(function (a, b) { return a.id - b.id; });
    var s = sig([orders, t, S.moving, S.moving ? d.tables.map(function (x) { return x.status; }) : 0]);
    if (bill._sig === s) return;
    bill._sig = s;
    var liveOrders = orders.filter(function (o) { return o.status !== 'cancelled'; });
    var total = 0, paid = 0, sub = 0, mem = 0, cou = 0;
    liveOrders.forEach(function (o) { total += o.total; sub += o.subtotal != null ? o.subtotal : o.total; mem += memDisc(o); cou += coupDisc(o); if (o.paid) paid += o.total; });
    var owe = total - paid;
    var body;
    if (S.moving) {
      body = h('div', { class: 'dlg-body' },
        h('h2', { class: 'dlg-title' }, n + '번 → 어느 테이블로 옮길까요?'),
        h('p', { class: 'dlg-msg' }, '주문 · 쿠폰 · 게임 기록이 모두 옮겨져요. 사용 중인 테이블을 고르면 합쳐져요.'),
        h('div', { class: 'pick' }, d.tables.filter(function (x) { return x.number !== n; }).sort(function (a, b) { return a.number - b.number; }).map(function (x) {
          return abtn('btn', [String(x.number), h('small', null, x.status === 'occupied' ? '사용 중 · 합석' : '비어 있음')], function () { return moveTo(n, x); });
        })),
        h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', type: 'button', onclick: function () { S.moving = false; renderBill(); } }, '← 계산서로')));
    } else {
      body = h('div', { class: 'dlg-body' },
        h('div', { class: 'view-head', style: 'margin:0' },
          h('h2', { class: 'dlg-title', style: 'margin-right:auto' }, n + '번 테이블 계산서'),
          t.status === 'occupied' ? h('span', { class: 'tag warn' }, '사용 중' + (t.minutesSeated != null ? ' · ' + t.minutesSeated + '분째' : '')) : h('span', { class: 'tag mute' }, '비어 있음'),
          h('button', { class: 'btn btn-sm', type: 'button', onclick: closeBill, 'aria-label': '닫기' }, '닫기')),
        h('div', { class: 'bill-list' }, orders.length ? orders.map(billOrder) : emptyEl('이 자리에는 주문이 없어요')),
        h('div', { class: 'bill-sum' },
          mem || cou ? h('div', null, h('span', null, '주문 금액'), h('span', { class: 'num' }, won(sub))) : null,
          mem ? h('div', null, h('span', null, '회원 할인'), h('span', { class: 'num' }, '−' + won(mem))) : null,
          cou ? h('div', null, h('span', null, '쿠폰 할인'), h('span', { class: 'num' }, '−' + won(cou))) : null,
          h('div', null, h('span', null, '결제 금액'), h('span', { class: 'num' }, won(total))),
          h('div', null, h('span', null, '입금 확인'), h('span', { class: 'num' }, won(paid))),
          h('div', { class: owe ? 'owe' : '' }, h('span', null, '미입금'), h('span', { class: 'num' }, won(owe)))),
        h('div', { class: 'dlg-actions' },
          abtn('btn btn-primary', '전체 입금 확인', function () { return payAll(liveOrders); }),
          h('button', { class: 'btn', type: 'button', onclick: function () { S.moving = true; renderBill(); } }, '자리 이동'),
          abtn('btn btn-danger', '테이블 정리', function () { return clearTable(n, orders, owe); })));
      if (!owe) body.querySelector('.btn-primary').disabled = true;
    }
    bill.replaceChildren(body);
  }
  function billOrder(o) {
    var live = o.status !== 'cancelled';
    return h('div', { class: 'bill-order' + (live ? '' : ' cancelled') },
      h('div', { class: 'line', style: 'display:flex;gap:6px;flex-wrap:wrap;align-items:center' },
        h('span', { class: 'oid' }, '#' + o.id), h('span', { class: 'tag ' + STTAG[o.status] }, LABEL[o.status]),
        live ? (o.paid ? h('span', { class: 'tag ok' }, '✓ 입금') : h('span', { class: 'tag bad' }, '미입금')) : null,
        h('b', { class: 'num', style: 'margin-left:auto' }, won(o.total))),
      h('ul', { class: 'items', style: 'font-size:1rem' }, o.items.map(function (i) { return h('li', null, h('span', { class: 'q' }, '×' + i.qty), h('span', null, i.name)); })),
      o.member ? h('div', null, h('span', { class: 'tag info' }, '★ COMS 회원'), memDisc(o) ? h('span', { class: 'muted' }, ' 회원 할인 −' + won(memDisc(o))) : null) : null,
      o.couponCode ? h('div', { class: 'muted' }, '쿠폰 ' + o.couponCode + ' · −' + won(coupDisc(o))) : null,
      o.note ? h('p', { class: 'note' }, h('b', null, '요청'), o.note) : null,
      live ? payToggle(o, true) : null);
  }
  function payAll(list) {
    var todo = list.filter(function (o) { return !o.paid; });
    var chain = Promise.resolve(), failed = null;
    todo.forEach(function (o) { chain = chain.then(function () { return api('/api/staff/orders/' + o.id + '/paid', { paid: true }); }).then(null, function (e) { failed = failed || e; }); });
    return chain.then(refresh).then(function () { if (failed) throw failed; SC.toast(todo.length + '건 입금 확인했어요', 'ok'); });
  }
  function clearTable(n, orders, owe) {
    var open = orders.filter(function (o) { return o.status === 'pending' || o.status === 'cooking'; }).length;
    var warn = [];
    if (owe > 0) warn.push('미입금 ' + won(owe) + '이 남아 있어요.');
    if (open) warn.push('아직 서빙하지 않은 주문이 ' + open + '건 있어요.');
    return SC.confirm({
      title: n + '번 테이블을 정리할까요?', danger: true, ok: '테이블 정리',
      message: (warn.length ? warn.join(' ') + '\n' : '') + '손님 화면의 주문 · 쿠폰 · 닉네임 · 호출이 비워져요. 매출 기록은 남아요.',
    }).then(function (ok) {
      if (!ok) return;
      function done() { closeBill(); SC.toast(n + '번 테이블을 정리했어요', 'ok'); return refresh(); }
      // Server refuses unsettled tables unless force:true (not yet in API.md): ask again with the server's numbers.
      return api('/api/staff/tables/' + n + '/clear').then(done, function (e) {
        if (e.code !== 'unsettled') throw e;
        return SC.confirm({
          title: '정산이 끝나지 않았어요', danger: true, ok: '그래도 정리', cancel: '돌아가기',
          message: '미입금 ' + (e.data.unpaid || 0) + '건 ' + won(e.data.unpaidTotal || 0) + ', 미완료 ' + (e.data.unserved || 0) + '건이 있습니다. 그래도 정리할까요?\n정리하면 손님 화면에서 사라지고 되돌릴 수 없어요.',
        }).then(function (ok) { if (ok) return api('/api/staff/tables/' + n + '/clear', { force: true }).then(done); });
      });
    });
  }
  function moveTo(from, x) {
    return SC.confirm({
      title: from + '번 → ' + x.number + '번 이동', ok: '이동하기',
      message: from + '번 테이블의 주문 · 쿠폰 · 게임 기록을 ' + x.number + '번으로 옮겨요.' + (x.status === 'occupied' ? ' ' + x.number + '번에 이미 손님이 있어 합쳐져요.' : '') + '\n' + from + '번 테이블은 새 손님용으로 비워지고(정리와 같음) 열린 호출도 처리돼요.',
    }).then(function (ok) {
      if (!ok) return;
      return api('/api/staff/tables/move', { from: from, to: x.number }).then(function (r) {
        SC.toast('주문 ' + r.orders + '건 · 쿠폰 ' + r.coupons + '개를 옮겼어요', 'ok');
        S.billTable = x.number; S.moving = false; bill._sig = '';
        return refresh().then(renderBill);
      });
    });
  }

  // =====================================================================
  // calls + waitlist
  // =====================================================================
  function buildCalls() {
    var root = h('section', { 'aria-label': '호출·대기' });
    var callsT = h('span', { class: 'num' }, '0'), waitT = h('span', { class: 'num' }, '0');
    var callList = h('div', { class: 'list' }), waitList = h('div', { class: 'list' }), waitCtl = h('div', { class: 'card switch-card' });
    root.append(h('div', { class: 'view-head' }, h('h2', null, '호출 · 대기')),
      h('div', { class: 'two' },
        h('div', null, h('h3', { class: 'sec-title' }, '직원 호출 ', callsT), callList),
        h('div', null, h('h3', { class: 'sec-title' }, '대기 명단 ', waitT), waitCtl, waitList)));
    function render() {
      var d = S.data;
      callsT.textContent = d.calls.length;
      SC.reconcile(callList, d.calls.slice().sort(function (a, b) { return a.createdAt - b.createdAt; }), function (c) { return c.id; }, sig, callCard, emptyEl('호출이 없어요'));
      var w = d.waitlist.slice().sort(function (a, b) { return a.createdAt - b.createdAt || a.id - b.id; });
      var idx = 0;
      w.forEach(function (x) { x._n = x.status === 'waiting' ? ++idx : 0; });
      waitT.textContent = idx + '팀 대기';
      renderWaitCtl(waitCtl, w.length);
      SC.reconcile(waitList, w, function (x) { return x.id; }, sig, waitCard, emptyEl('대기 중인 팀이 없어요'));
    }
    return { root: root, render: render };
  }
  // Waitlist switch + clear. State field name per backend: waitOpen (missing = treated as open).
  function renderWaitCtl(box, count) {
    var open = S.data.waitOpen !== false, s = sig([open, count]);
    if (box._sig === s) return;
    box._sig = s;
    box.className = 'card switch-card ' + (open ? 'open' : 'closed');
    SC.fill(box,
      h('span', { class: 'big' }, open ? '대기 접수 중' : '대기 접수 마감'),
      abtn('btn ' + (open ? 'btn-danger' : 'btn-primary'), open ? '접수 끄기' : '접수 켜기', function () {
        return SC.confirm({
          title: open ? '대기 접수를 끌까요?' : '대기 접수를 다시 받을까요?', danger: open, ok: open ? '접수 끄기' : '접수 켜기',
          message: open ? '새 대기 등록이 막혀요. 이미 등록한 팀은 그대로예요.' : '손님이 입구 QR로 다시 대기를 등록할 수 있어요.',
        }).then(function (ok) { if (ok) return api('/api/staff/waitlist/open', { open: !open }).then(refresh); });
      }),
      abtn('btn btn-danger', '대기 명단 비우기', function () {
        if (!count) { SC.toast('비울 대기 명단이 없어요.'); return Promise.resolve(); }
        return SC.confirm({ title: '대기 명단을 비울까요?', danger: true, ok: '명단 비우기', cancel: '돌아가기', message: '대기 중 · 호출한 ' + count + '팀의 대기가 모두 취소돼요. 되돌릴 수 없어요.' })
          .then(function (ok) { if (ok) return api('/api/staff/waitlist/clear').then(function () { SC.toast(count + '팀의 대기를 취소했어요', 'ok'); return refresh(); }); });
      }));
  }
  function callCard(c) {
    return h('div', { class: 'row-card hot' },
      h('div', { class: 'tno' }, h('span', { class: 'n', text: c.table }), h('span', { class: 'u', text: '번 테이블' })),
      h('div', { class: 'grow' }, h('span', { class: 'big' }, c.type), h('span', { class: 'muted' }, SC.timeEl(c.createdAt, 'ago'))),
      abtn('btn btn-primary', '처리 완료', function () { return api('/api/staff/calls/' + c.id + '/resolve').then(refresh); }));
  }
  function waitAct(x, what, label, okMsg, cls) {
    return abtn(cls || 'btn', label, function () {
      var go = function () { return api('/api/staff/wait/' + x.id + '/' + what).then(refresh); };
      if (what !== 'cancel') return go();
      return SC.confirm({ title: '대기 취소', message: x.nick + ' (' + x.size + '명) 대기를 취소할까요?', ok: '대기 취소', danger: true, cancel: '돌아가기' }).then(function (ok) { if (ok) return go(); });
    }, okMsg);
  }
  function waitCard(x) {
    var called = x.status === 'called';
    var btns = h('div', { class: 'btns' });
    if (!called) btns.appendChild(waitAct(x, 'call', '입장 호출', x.nick + ' 호출했어요', 'btn btn-primary'));
    btns.appendChild(waitAct(x, 'seat', '착석 완료', '', called ? 'btn btn-primary' : 'btn'));
    btns.appendChild(waitAct(x, 'cancel', '취소', '', 'btn btn-danger'));
    return h('div', { class: 'row-card ' + (called ? 'called' : '') },
      h('div', { class: 'grow' },
        h('span', { class: 'big' }, (x._n ? x._n + '. ' : '') + x.nick + ' · ' + x.size + '명'),
        h('span', { class: 'muted' }, '대기 ', SC.timeEl(x.createdAt, 'dur'), called ? ' · 호출 ' : '', called && x.calledAt ? SC.timeEl(x.calledAt, 'ago') : null)),
      called ? h('span', { class: 'tag ok' }, '호출함') : h('span', { class: 'tag warn' }, '대기 중'),
      btns);
  }

  // =====================================================================
  // coupons / rewards / hourly award
  // =====================================================================
  function buildCoupons() {
    var root = h('section', { 'aria-label': '쿠폰' });
    var input = h('input', {
      class: 'field code-in', type: 'text', maxlength: '6', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', inputmode: 'text',
      'aria-label': '쿠폰 코드 6자리', placeholder: 'XXXXXX',
      oninput: function () { var v = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); if (v !== input.value) input.value = v; },
      onkeydown: function (e) { if (e.key === 'Enter') { e.preventDefault(); go.click(); } },
    });
    var result = h('div', { role: 'status', 'aria-live': 'polite' });
    var go = h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: function () { SC.act(go, redeem); } }, '사용 처리');
    function showResult(r) { result.replaceChildren(r); }
    function redeem() {
      var code = input.value.trim();
      if (code.length !== 6) { showResult(resultBox('bad', '코드는 6자리예요', null, null, '손님 화면의 코드를 다시 확인해 주세요.')); input.focus(); return Promise.resolve(); }
      return api('/api/staff/coupons/redeem', { code: code }).then(function (r) {
        var c = r.coupon;
        showResult(resultBox('ok', '✓ 사용 처리 완료', c.label, c.table + '번 테이블',
          (c.type === 'discount' ? '할인 쿠폰 · ' + won(c.amount) + ' 할인' : '상품 쿠폰 · ' + (c.item || c.label) + ' 지급') + ' · 코드 ' + c.code,
          c.stale ? '이 쿠폰은 이전 손님 자리(정리된 자리)의 쿠폰이에요. 지급 여부는 직접 판단해 주세요.' : null));
        input.value = '';
        return refresh();
      }, function (e) {
        var sub = e.message;
        if (e.code === 'already_used') sub = '이미 사용된 쿠폰이에요' + (e.data.usedAt ? ' (' + SC.agoText(e.data.usedAt) + ' 사용)' : '') + (e.data.orderId ? ' · 주문 #' + e.data.orderId : '') + '.';
        showResult(resultBox('bad', e.code === 'already_used' ? '이미 사용된 쿠폰' : e.code === 'no_coupon' ? '없는 코드예요' : '사용 처리 실패', null, null, sub));
        input.select();
      });
    }
    var couponList = h('div', { class: 'list' }), rewardList = h('div', { class: 'list' }), award = h('div', { class: 'card' });
    var unredeemedT = h('span', { class: 'num' }, '0');
    root.append(h('div', { class: 'view-head' }, h('h2', null, '쿠폰')),
      h('div', { class: 'two' },
        h('div', { class: 'list' },
          h('div', { class: 'card redeem' },
            h('h3', { class: 'sec-title', style: 'margin:0' }, '쿠폰 코드 입력'),
            input, go, result,
            h('p', { class: 'muted' }, '할인 쿠폰은 손님이 주문할 때 자동으로 차감돼요. 상품(서비스) 쿠폰만 여기서 사용 처리해요.')),
          award,
          h('div', null, h('h3', { class: 'sec-title' }, '미사용 쿠폰 ', unredeemedT), couponList)),
        h('div', null, h('h3', { class: 'sec-title' }, '보상 재고'), rewardList)));
    function render() {
      var d = S.data;
      unredeemedT.textContent = d.coupons.length + '장';
      SC.reconcile(couponList, d.coupons, function (c) { return c.code; }, sig, function (c) {
        return h('div', { class: 'row-card' },
          h('div', { class: 'grow' },
            h('span', { class: 'code big' }, c.code),
            h('span', null, c.label),
            h('span', { class: 'muted' }, c.table + '번 테이블 · ' + (c.source === 'hour' ? '정시 시상' : '게임 보상') + ' · ', SC.timeEl(c.createdAt, 'ago'))),
          c.type === 'discount' ? h('span', { class: 'tag info' }, '주문 시 자동 사용') : abtn('btn btn-sm', '코드 입력', function () { input.value = c.code; input.focus(); return Promise.resolve(); }));
      }, emptyEl('미사용 쿠폰이 없어요'));
      SC.reconcile(rewardList, d.rewards, function (r) { return r.id; }, sig, rewardCard, emptyEl('보상이 없어요'));
      var s = sig([d.hour, d.prevHour, d.hourly, S.awardMsg]);
      if (award._sig !== s) { award._sig = s; renderAward(award); }
    }
    return { root: root, render: render };
  }
  function resultBox(kind, head, what, where, sub, warn) {
    return h('div', { class: 'result ' + kind },
      h('div', { class: 'head' }, head), what ? h('div', { class: 'what' }, what) : null, where ? h('div', { class: 'where' }, where) : null,
      sub ? h('div', { class: 'muted' }, sub) : null, warn ? h('div', { class: 'tag warn', style: 'white-space:normal;justify-self:center' }, '! ' + warn) : null);
  }
  function rewardCard(r) {
    var pct = r.stock > 0 ? Math.max(0, Math.min(100, Math.round(r.remaining / r.stock * 100))) : 0;
    var num = h('input', { class: 'field', type: 'number', inputmode: 'numeric', min: String(r.issued), value: String(r.stock), 'aria-label': r.label + ' 총 재고' });
    var card;
    function set(n) {
      card.querySelectorAll('button,input').forEach(function (x) { x.disabled = true; });
      return api('/api/staff/rewards/' + r.id + '/stock', { stock: n }).then(refresh, function (e) {
        card.querySelectorAll('button,input').forEach(function (x) { x.disabled = false; });
        if (e.code === 'stock_below_issued') throw new Error('이미 ' + (e.data.issued != null ? e.data.issued : r.issued) + '장 발급되어 그보다 적게 줄일 수 없습니다.');
        throw e;
      });
    }
    function step(dlt) {
      var b = abtn('btn btn-sm', (dlt > 0 ? '+' : '−') + Math.abs(dlt), function () { return set(r.stock + dlt); });
      if (r.stock + dlt < r.issued || r.stock + dlt < 0) b.disabled = true;
      return b;
    }
    card = h('div', { class: 'card reward' },
      h('div', { style: 'display:flex;gap:8px;align-items:baseline;flex-wrap:wrap' }, h('b', { style: 'font-size:1.2rem' }, r.label), h('span', { class: 'muted' }, '조건 ' + r.threshold + '점 이상'), r.remaining <= 0 ? h('span', { class: 'tag bad solid', style: 'margin-left:auto' }, '재고 소진') : null),
      h('div', { class: 'meter', role: 'img', 'aria-label': '남은 재고 ' + pct + '%' }, h('i', { style: 'width:' + pct + '%' })),
      h('div', null, h('b', { class: 'num', style: 'font-size:1.4rem' }, r.remaining + '개 남음'), h('span', { class: 'muted num' }, ' / 총 ' + r.stock + '개 · 발급 ' + r.issued + '개')),
      h('div', { class: 'stockctl' }, step(-5), step(-1), step(1), step(5), num, abtn('btn btn-sm', '총량 저장', function () {
        var n = Number(num.value);
        if (!Number.isInteger(n) || n < 0) { SC.toast('0 이상의 정수를 입력해 주세요.', 'error'); return Promise.resolve(); }
        return set(n);
      }, '재고를 바꿨어요')));
    return card;
  }
  function renderAward(box) {
    var d = S.data, top = d.hour && d.hour.top, prev = d.prevHour;
    function who(t) { return t.table + '번 테이블' + (t.nick ? ' · ' + t.nick : '') + ' · ' + t.score + '점'; }
    function award(t, hourStart, label) {
      return SC.confirm({ title: label, message: who(t) + '\n"' + (d.hourly && d.hourly.label) + '" 쿠폰을 이 테이블에 발급해요. 한 시간에 한 번만 시상할 수 있어요.', ok: '시상하기' }).then(function (ok) {
        if (!ok) return;
        return api('/api/staff/award-hour', hourStart ? { hourStart: hourStart } : {}).then(function (r) {
          S.awardMsg = r.table + '번 테이블에 ' + r.coupon.label + ' 쿠폰 발급 (' + SC.clock(r.hourStart) + ' 시간대)';
          SC.toast(S.awardMsg, 'ok');
          return refresh();
        });
      });
    }
    var cur = abtn('btn btn-primary btn-block', '이번 시간 1등 테이블 시상', function () { return award(top, null, '이번 시간 1등 시상'); });
    if (!top || d.hour.awarded) cur.disabled = true;
    SC.fill(box,
      h('h3', { class: 'sec-title', style: 'margin:0' }, '정시 1등 시상 ', d.hour.awarded ? h('span', { class: 'tag ok' }, '✓ 이번 시간 시상 완료') : null),
      h('div', { class: 'leader' },
        h('span', { class: 'muted' }, SC.clock(d.hour.start) + ' ~ ' + SC.clock(d.hour.end) + ' 현재 1등'),
        top ? h('span', { class: 'who' }, who(top)) : h('span', { class: 'who muted' }, '아직 게임한 테이블이 없어요'),
        d.hourly && d.hourly.label ? h('span', { class: 'muted' }, '상품: ' + d.hourly.label) : null),
      d.hour.ranking && d.hour.ranking.length ? h('ol', { class: 'rank-mini' }, d.hour.ranking.map(function (r, i) {
        return h('li', null, h('span', { class: 'r' }, String(i + 1)), h('span', null, r.table + '번 ' + (r.nick || '')), h('span', { class: 's' }, r.score + '점'));
      })) : null,
      cur,
      prev && prev.top && !prev.awarded ? abtn('btn btn-block', '지난 시간(' + SC.clock(prev.start) + ') 1등 ' + prev.top.table + '번 시상', function () { return award(prev.top, prev.start, '지난 시간 1등 시상'); }) : null,
      S.awardMsg ? h('p', { class: 'tag ok', style: 'white-space:normal;justify-self:start' }, S.awardMsg) : null);
  }

  // =====================================================================
  // menu
  // =====================================================================
  var MENU_ERR = {
    bad_name: '이름은 1~30자로 입력해 주세요.',
    bad_price: '가격은 100원 단위로 0~1,000,000원 사이여야 해요.',
    bad_desc: '설명은 60자 이하로 입력해 주세요.',
    bad_category: '분류 이름은 1~12자로 입력해 주세요.',
    name_taken: '같은 이름이 이미 있어요. 다른 이름을 써 주세요.',
    too_many_items: '메뉴는 최대 100개까지 만들 수 있어요.',
    too_many_categories: '분류는 최대 12개까지 만들 수 있어요.',
    in_use: '이미 주문된 메뉴는 삭제할 수 없어요.',
    category_not_empty: '메뉴가 남아 있는 분류는 삭제할 수 없어요. 메뉴를 옮기거나 삭제한 뒤 다시 시도해 주세요.',
    nothing_to_update: '바뀐 내용이 없어요.',
    no_item: '이미 삭제된 메뉴예요. 화면을 새로 불러올게요.',
    no_category: '이미 삭제된 분류예요. 화면을 새로 불러올게요.',
    bad_reorder: '순서를 바꾸지 못했어요. 다시 시도해 주세요.',
    bad_pct: '할인율은 0~50 사이 정수여야 해요.',
  };
  function menuMsg(e) { return MENU_ERR[e.code] || e.message; }
  function menuFail(e) { SC.toast(menuMsg(e), 'error'); if (e.code === 'no_item' || e.code === 'no_category') refresh(); }
  function catsOf(d) { return (d.menu.categoryList || []).slice().sort(function (x, y) { return x.sortOrder - y.sortOrder || x.id - y.id; }); }
  function itemsByCat(d) {
    var by = {};
    d.menu.items.forEach(function (i) { (by[i.categoryId] = by[i.categoryId] || []).push(i); });
    Object.keys(by).forEach(function (k) { by[k].sort(function (x, y) { return x.sortOrder - y.sortOrder; }); });
    return by;
  }
  function mapErr(fn) { return fn().then(null, function (e) { menuFail(e); }); }

  // small text prompt dialog -> Promise<string|null>
  function askText(title, label, value, max) {
    return new Promise(function (resolve) {
      var done = false;
      var input = h('input', { class: 'field', type: 'text', maxlength: String(max), value: value || '', 'aria-label': label });
      var dlg = h('dialog', { class: 'dlg' });
      function finish(v) { if (done) return; done = true; dlg.close(); dlg.remove(); resolve(v); }
      dlg.appendChild(h('form', { class: 'dlg-body', onsubmit: function (e) { e.preventDefault(); var v = input.value.trim(); if (v) finish(v); } },
        h('h2', { class: 'dlg-title' }, title), h('label', { class: 'lab' }, label, input),
        h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', type: 'button', onclick: function () { finish(null); } }, '취소'), h('button', { class: 'btn btn-primary', type: 'submit' }, '저장'))));
      dlg.addEventListener('cancel', function (e) { e.preventDefault(); finish(null); });
      document.body.appendChild(dlg); dlg.showModal(); input.focus(); input.select();
    });
  }

  function buildMenu() {
    var root = h('section', { 'aria-label': '메뉴' });
    var swBox = h('div'), listBox = h('div');
    var member = buildMemberCard();
    root.append(h('div', { class: 'view-head' }, h('h2', null, '메뉴 관리'),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: function () { openItemDialog(null); } }, '+ 메뉴 추가'),
      h('button', { class: 'btn', type: 'button', onclick: addCategory }, '+ 분류 추가')),
      swBox, h('h3', { class: 'menu-cat' }, '설정'), member.el, listBox);
    function render() {
      var d = S.data;
      renderOrdering(swBox, d);
      member.update(d);
      var s = sig(d.menu);
      if (listBox._sig !== s) { listBox._sig = s; renderMenuList(listBox, d); }
    }
    return { root: root, render: render };
  }

  function renderOrdering(box, d) {
    var s = sig(d.orderingOpen);
    if (box._sig === s) return;
    box._sig = s;
    var open = d.orderingOpen;
    SC.fill(box, h('div', { class: 'card switch-card ' + (open ? 'open' : 'closed') },
      h('span', { class: 'big' }, open ? '주문 받는 중' : '주문 마감됨'),
      h('span', { class: 'muted' }, open ? '손님이 지금 주문할 수 있어요' : '손님 화면의 주문이 막혀 있어요 (게임은 가능)'),
      abtn('btn ' + (open ? 'btn-danger' : 'btn-primary'), open ? '주문 마감하기' : '주문 다시 받기', function () {
        return SC.confirm({
          title: open ? '주문을 마감할까요?' : '주문을 다시 받을까요?', danger: open, ok: open ? '주문 마감' : '주문 받기',
          message: open ? '손님 화면에서 주문이 즉시 막혀요. 이미 들어온 주문은 그대로예요.' : '손님이 다시 주문할 수 있어요.',
        }).then(function (ok) { if (ok) return api('/api/staff/ordering', { open: !open }).then(refresh); });
      })));
  }

  // ---- COMS member discount setting ----
  function buildMemberCard() {
    var lastPct = null, current = 0;
    var num = h('input', { class: 'field', type: 'number', inputmode: 'numeric', min: '0', max: '50', step: '1', 'aria-label': '회원 할인율 (%)' });
    function clamp(n) { return Math.max(0, Math.min(50, n)); }
    function nudge(dlt) { num.value = String(clamp((parseInt(num.value, 10) || 0) + dlt)); }
    var minus = h('button', { class: 'btn', type: 'button', 'aria-label': '1% 내리기', onclick: function () { nudge(-1); } }, '−');
    var plus = h('button', { class: 'btn', type: 'button', 'aria-label': '1% 올리기', onclick: function () { nudge(1); } }, '+');
    var save = abtn('btn btn-primary', '저장', function () {
      var raw = num.value.trim(), n = Number(raw);
      if (raw === '' || !Number.isInteger(n) || n < 0 || n > 50) { SC.toast(MENU_ERR.bad_pct, 'error'); return Promise.resolve(); }
      if (n === current) { SC.toast('이미 ' + n + '%예요.'); return Promise.resolve(); }
      return SC.confirm({ title: '회원 할인을 바꿀까요?', ok: '바꾸기', message: 'COMS 회원 할인 ' + current + '% → ' + n + '%' + (n === 0 ? ' (할인 끔)' : '') + '\n새로 들어오는 주문부터 적용돼요. 이미 들어온 주문은 그대로예요.' })
        .then(function (ok) { if (ok) return api('/api/staff/member-discount', { pct: n }).then(function () { SC.toast('회원 할인을 ' + n + '%로 바꿨어요', 'ok'); return refresh(); }, function (e) { throw new Error(menuMsg(e)); }); });
    });
    var state = h('span', { class: 'tag' });
    var note = h('p', { class: 'muted' });
    var el = h('div', { class: 'card' },
      h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, h('b', { style: 'font-size:1.15rem' }, 'COMS 회원 할인'), state),
      h('div', { class: 'stockctl' }, minus, num, h('span', { style: 'font-weight:800' }, '%'), plus, save), note);
    function update(d) {
      var pct = d.memberDiscountPct || 0, enabled = d.memberEnabled !== false;
      current = pct;
      if (pct !== lastPct) { num.value = String(pct); lastPct = pct; }
      [minus, plus, save, num].forEach(function (x) { x.disabled = !enabled; });
      state.className = 'tag ' + (!enabled ? 'mute' : pct ? 'ok' : 'warn');
      state.textContent = !enabled ? '연동 없음' : pct ? '현재 ' + pct + '% 적용 중' : '꺼짐 (0%)';
      note.textContent = enabled ? 'COMS 사이트에 로그인한 손님 주문에 자동 적용돼요. 할인액은 100원 단위로 내림해요. (0~50%)' : '서버에 COMS 연동이 설정되지 않았어요.';
    }
    return { el: el, update: update };
  }

  // ---- menu list ----
  function renderMenuList(box, d) {
    var cats = catsOf(d), by = itemsByCat(d);
    function order(ci, ii, dir) {
      var lists = cats.map(function (c) { return (by[c.id] || []).map(function (i) { return i.id; }); });
      var l = lists[ci], j = ii + dir;
      if (j < 0 || j >= l.length) return Promise.resolve();
      var t = l[ii]; l[ii] = l[j]; l[j] = t;
      return api('/api/staff/menu/reorder', { items: [].concat.apply([], lists) }).then(refresh);
    }
    function orderCat(ci, dir) {
      var ids = cats.map(function (c) { return c.id; }), j = ci + dir;
      if (j < 0 || j >= ids.length) return Promise.resolve();
      var t = ids[ci]; ids[ci] = ids[j]; ids[j] = t;
      return api('/api/staff/menu/reorder', { categories: ids }).then(refresh);
    }
    function guard(fn) { return function () { return mapErr(fn); }; }
    if (!cats.length) { SC.fill(box, emptyEl('메뉴가 없어요. "+ 메뉴 추가"로 만들어 보세요.')); return; }
    SC.fill(box, cats.map(function (c, ci) {
      var items = by[c.id] || [];
      return h('div', { class: 'menu-group' },
        h('div', { class: 'cat-head' },
          h('h3', { class: 'menu-cat', style: 'margin:0' }, c.name), h('span', { class: 'tag mute' }, items.length + '개'),
          h('div', { class: 'btns' },
            abtn('btn btn-sm', '▲', guard(function () { return orderCat(ci, -1); })), abtn('btn btn-sm', '▼', guard(function () { return orderCat(ci, 1); })),
            abtn('btn btn-sm', '이름 변경', guard(function () {
              return askText('분류 이름 변경', '분류 이름 (1~12자)', c.name, 12).then(function (v) { if (v && v !== c.name) return api('/api/staff/menu/categories/' + c.id, { name: v }).then(refresh); });
            })),
            abtn('btn btn-sm btn-danger', '삭제', guard(function () {
              if (items.length) { SC.toast(MENU_ERR.category_not_empty, 'error'); return Promise.resolve(); }
              return SC.confirm({ title: '"' + c.name + '" 분류를 삭제할까요?', danger: true, ok: '삭제', message: '비어 있는 분류만 삭제돼요.' })
                .then(function (ok) { if (ok) return api('/api/staff/menu/categories/' + c.id + '/delete').then(refresh); });
            })))),
        h('div', { class: 'menu-grid' }, items.length ? items.map(function (i, ii) {
          var b = [];
          if (i.soldOut) b.push(h('span', { class: 'tag bad solid' }, '품절'));
          if (i.hidden) b.push(h('span', { class: 'tag mute' }, '숨김'));
          if (!i.soldOut && !i.hidden) b.push(h('span', { class: 'tag ok' }, '판매 중'));
          return h('div', { class: 'menu-item' + (i.soldOut ? ' out' : '') + (i.hidden ? ' hid' : '') },
            h('div', { class: 'grow' }, h('span', { class: 'nm' }, i.name), h('span', { class: 'muted' }, won(i.price) + (i.desc ? ' · ' + i.desc : ''))),
            h('div', { class: 'line', style: 'display:flex;gap:6px' }, b),
            h('div', { class: 'btns' },
              abtn('btn btn-sm' + (i.soldOut ? ' btn-primary' : ''), i.soldOut ? '판매 재개' : '품절', guard(function () {
                return api('/api/staff/menu/' + encodeURIComponent(i.id) + '/soldout', { soldOut: !i.soldOut }).then(function () { SC.toast(i.name + (i.soldOut ? ' 판매 재개' : ' 품절 처리'), 'ok'); return refresh(); });
              })),
              abtn('btn btn-sm' + (i.hidden ? ' btn-primary' : ''), i.hidden ? '숨김 해제' : '숨김', guard(function () {
                return api('/api/staff/menu/items/' + encodeURIComponent(i.id), { hidden: !i.hidden }).then(function () { SC.toast(i.name + (i.hidden ? ' 다시 보여요' : ' 손님에게 숨겼어요'), 'ok'); return refresh(); });
              })),
              h('button', { class: 'btn btn-sm', type: 'button', onclick: function () { openItemDialog(i); } }, '수정'),
              abtn('btn btn-sm', '▲', guard(function () { return order(ci, ii, -1); })), abtn('btn btn-sm', '▼', guard(function () { return order(ci, ii, 1); }))));
        }) : emptyEl('이 분류에는 메뉴가 없어요')));
    }));
  }
  function addCategory() {
    return askText('분류 추가', '분류 이름 (1~12자)', '', 12).then(function (v) {
      if (v) return mapErr(function () { return api('/api/staff/menu/categories', { name: v }).then(function () { SC.toast('"' + v + '" 분류를 만들었어요', 'ok'); return refresh(); }); });
    });
  }

  // ---- item create/edit dialog ----
  function openItemDialog(item) {
    var d = S.data, cats = catsOf(d), NEW = '__new';
    var editing = !!item;
    var name = h('input', { class: 'field', type: 'text', maxlength: '30', autocomplete: 'off', value: editing ? item.name : '', 'aria-label': '이름' });
    var price = h('input', { class: 'field', type: 'number', inputmode: 'numeric', step: '100', min: '0', max: '1000000', value: editing ? String(item.price) : '', placeholder: '예: 4500', 'aria-label': '가격 (원)' });
    var preview = h('output', { class: 'muted', 'aria-live': 'polite' });
    var sel = h('select', { class: 'field', 'aria-label': '분류' }, cats.map(function (c) { return h('option', { value: c.name }, c.name); }), h('option', { value: NEW }, '+ 새 분류 만들기'));
    var newCat = h('input', { class: 'field', type: 'text', maxlength: '12', placeholder: '새 분류 이름 (1~12자)', 'aria-label': '새 분류 이름', hidden: true });
    sel.value = editing ? item.cat : (cats[0] ? cats[0].name : NEW);
    var desc = h('input', { class: 'field', type: 'text', maxlength: '60', value: editing ? (item.desc || '') : '', 'aria-label': '설명 (선택)' });
    var hid = h('input', { type: 'checkbox', style: 'width:24px;height:24px' });
    hid.checked = editing && !!item.hidden;
    var err = h('p', { class: 'err', role: 'alert', style: 'color:var(--danger);font-weight:800;min-height:1.4em' });
    function priceOk() { var raw = price.value.trim(), n = Number(raw); return raw !== '' && Number.isInteger(n) && n >= 0 && n <= 1000000 && n % 100 === 0; }
    function syncPrice() { preview.textContent = priceOk() ? won(Number(price.value)) : (price.value.trim() === '' ? '' : '100원 단위로 입력해 주세요'); preview.style.color = priceOk() || !price.value ? '' : 'var(--danger)'; }
    function syncCat() { newCat.hidden = sel.value !== NEW; if (!newCat.hidden) newCat.focus(); }
    price.addEventListener('input', syncPrice); sel.addEventListener('change', syncCat);
    syncPrice(); newCat.hidden = sel.value !== NEW;
    var dlg = h('dialog', { class: 'dlg wide', 'aria-label': editing ? '메뉴 수정' : '메뉴 추가' });
    function close() { if (dlg.open) dlg.close(); dlg.remove(); }
    var saveBtn = h('button', { class: 'btn btn-primary', type: 'submit' }, '저장');

    function validate() {
      var n = name.value.trim(), c = sel.value === NEW ? newCat.value.trim() : sel.value;
      if (n.length < 1 || n.length > 30) return MENU_ERR.bad_name;
      if (!priceOk()) return MENU_ERR.bad_price;
      if (c.length < 1 || c.length > 12) return MENU_ERR.bad_category;
      if (desc.value.trim().length > 60) return MENU_ERR.bad_desc;
      return '';
    }
    function submit() {
      err.textContent = validate();
      if (err.textContent) return;
      var body = { name: name.value.trim(), price: Number(price.value), category: sel.value === NEW ? newCat.value.trim() : sel.value, desc: desc.value.trim() };
      saveBtn.disabled = true; saveBtn.classList.add('busy');
      var run;
      if (!editing) {
        if (hid.checked) body.hidden = true; // one request: never visible to guests
        run = api('/api/staff/menu/items', body);
      } else {
        var diff = {};
        if (body.name !== item.name) diff.name = body.name;
        if (body.price !== item.price) diff.price = body.price;
        if (body.category !== item.cat) diff.category = body.category;
        if (body.desc !== (item.desc || '')) diff.desc = body.desc;
        if (hid.checked !== !!item.hidden) diff.hidden = hid.checked;
        if (!Object.keys(diff).length) { saveBtn.disabled = false; saveBtn.classList.remove('busy'); close(); return; }
        var gate = diff.price !== undefined
          ? SC.confirm({ title: '가격을 바꿀까요?', ok: '가격 바꾸기', message: (diff.name || item.name) + ' ' + won(item.price) + ' → ' + won(diff.price) + '으로 바꿀까요?\n이미 들어온 주문은 그대로예요.' })
          : Promise.resolve(true);
        run = gate.then(function (ok) { if (!ok) return null; return api('/api/staff/menu/items/' + encodeURIComponent(item.id), diff); });
      }
      run.then(function (r) {
        saveBtn.disabled = false; saveBtn.classList.remove('busy');
        if (r === null) return;
        close(); SC.toast(editing ? '메뉴를 수정했어요' : '메뉴를 추가했어요', 'ok'); refresh();
      }, function (e) {
        saveBtn.disabled = false; saveBtn.classList.remove('busy');
        err.textContent = menuMsg(e);
        if (e.code === 'no_item') { close(); refresh(); }
      });
    }
    var delBtn = editing ? h('button', { class: 'btn btn-danger', type: 'button', onclick: function () { deleteItem(item, close); } }, '삭제') : null;
    dlg.appendChild(h('form', { class: 'dlg-body', novalidate: true, onsubmit: function (e) { e.preventDefault(); submit(); } },
      h('h2', { class: 'dlg-title' }, editing ? '메뉴 수정' : '메뉴 추가'),
      h('label', { class: 'lab' }, '이름 (1~30자)', name),
      h('label', { class: 'lab' }, '가격 (100원 단위, 최대 1,000,000원)', price, preview),
      h('label', { class: 'lab' }, '분류', sel, newCat),
      h('label', { class: 'lab' }, '설명 (선택, 60자 이하)', desc),
      h('label', { style: 'display:flex;gap:10px;align-items:center;font-weight:800' }, hid, '손님에게 숨기기'),
      err,
      h('div', { class: 'dlg-actions' }, delBtn, h('button', { class: 'btn', type: 'button', onclick: close }, '취소'), saveBtn)));
    dlg.addEventListener('cancel', function (e) { e.preventDefault(); close(); });
    document.body.appendChild(dlg); dlg.showModal(); name.focus();
  }
  function deleteItem(item, closeEditor) {
    return SC.confirm({ title: '"' + item.name + '" 메뉴를 삭제할까요?', danger: true, ok: '삭제', message: '되돌릴 수 없어요. 잠시 안 팔 거라면 "숨김"을 쓰세요.' }).then(function (ok) {
      if (!ok) return;
      return api('/api/staff/menu/items/' + encodeURIComponent(item.id) + '/delete').then(function () { closeEditor(); SC.toast('삭제했어요', 'ok'); return refresh(); }, function (e) {
        if (e.code !== 'in_use') { SC.toast(menuMsg(e), 'error'); if (e.code === 'no_item') { closeEditor(); refresh(); } return; }
        return SC.confirm({ title: '삭제할 수 없어요', ok: '숨김으로 바꾸기', cancel: '그냥 두기', message: '이미 주문된 메뉴는 삭제할 수 없어요. 숨김으로 바꿀까요?\n손님 메뉴에서 사라지고, 지난 주문 기록은 그대로예요.' }).then(function (ok2) {
          if (!ok2) return;
          return api('/api/staff/menu/items/' + encodeURIComponent(item.id), { hidden: true }).then(function () { closeEditor(); SC.toast(item.name + ' 숨김 처리', 'ok'); return refresh(); });
        });
      });
    });
  }

  // =====================================================================
  // sales
  // =====================================================================
  function buildSales() {
    var root = h('section', { 'aria-label': '매출' });
    var body = h('div', { class: 'list' }, emptyEl('불러오는 중…'));
    var reload = h('button', { class: 'btn', type: 'button', onclick: function () { SC.act(reload, loadSales); } }, '새로고침');
    root.append(h('div', { class: 'view-head' }, h('h2', null, '매출'), reload, h('a', { class: 'btn', href: BASE + '/api/staff/sales.csv', download: 'booth-sales.csv' }, 'CSV 다운로드')), body,
      h('div', { class: 'card danger-zone' },
        h('h3', { class: 'sec-title', style: 'margin:0' }, '행사 데이터 초기화'),
        h('p', { class: 'muted' }, '주문 · 쿠폰 · 게임 기록 · 닉네임 · 호출 · 대기 명단을 모두 지우고 테이블 자리와 재고를 처음 상태로 돌려요. 되돌릴 수 없어요. 리허설 후 본 행사 전에만 쓰세요.'),
        abtn('btn btn-solid-danger', '전체 초기화…', function () {
          return SC.confirm({ title: '모든 데이터를 초기화할까요?', danger: true, typed: '초기화', ok: '전체 초기화', message: '매출 CSV가 필요하면 먼저 내려받으세요. 이 작업은 되돌릴 수 없어요.' }).then(function (ok) {
            if (!ok) return;
            return api('/api/staff/reset', { confirm: '초기화' }).then(function () { SC.toast('초기화했어요', 'ok'); S.sales = null; return refresh().then(loadSales); });
          });
        })));
    S.salesBody = body;
    return { root: root, render: function () { if (S.sales) renderSales(body); } };
  }
  function loadSales() {
    S.salesAt = Date.now();
    S.salesSig = S.data ? S.data.orders.map(function (o) { return o.id + o.status + (o.paid ? 'p' : ''); }).join() : '';
    return SC.api('/api/staff/sales').then(function (r) { S.sales = r; renderSales(S.salesBody); }, function (e) { SC.toast(e.message, 'error'); });
  }
  function tile(k, v, cls) { return h('div', { class: 'tile ' + (cls || '') }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v)); }
  function renderSales(body) {
    var r = S.sales, t = r.totals;
    var maxH = Math.max.apply(null, [1].concat(r.byHour.map(function (x) { return x.revenue; })));
    var maxI = Math.max.apply(null, [1].concat(r.byItem.map(function (x) { return x.qty; })));
    body.replaceChildren(
      h('div', { class: 'tiles' },
        tile('총매출', won(t.revenue), 'hl'), tile('입금 확인', won(t.paidRevenue), 'ok'), tile('미입금', won(t.unpaidRevenue), t.unpaidRevenue ? 'bad' : ''),
        tile('주문 수', t.orders + '건'), tile('회원 할인', won(t.memberDiscount || 0) + ' · ' + (t.memberOrders || 0) + '건'), tile('할인 합계 (회원+쿠폰)', won(t.discount))),
      h('div', { class: 'two' },
        h('div', { class: 'card' }, h('h3', { class: 'sec-title', style: 'margin:0' }, '시간대별 매출'),
          r.byHour.length ? h('div', { class: 'bars' }, r.byHour.map(function (x) {
            return h('div', { class: 'bar' }, h('span', null, x.label.slice(5)), h('span', { class: 'track' }, h('i', { style: 'width:' + Math.max(2, Math.round(x.revenue / maxH * 100)) + '%' })), h('span', { class: 'v' }, won(x.revenue) + ' · ' + x.orders + '건'));
          })) : emptyEl('아직 매출이 없어요')),
        h('div', { class: 'card' }, h('h3', { class: 'sec-title', style: 'margin:0' }, '메뉴별 판매'),
          r.byItem.length ? h('div', { class: 'bars' }, r.byItem.slice().sort(function (a, b) { return b.qty - a.qty; }).map(function (x) {
            return h('div', { class: 'bar' }, h('span', { style: 'overflow-wrap:anywhere' }, x.name), h('span', { class: 'track' }, h('i', { style: 'width:' + Math.max(2, Math.round(x.qty / maxI * 100)) + '%' })), h('span', { class: 'v' }, x.qty + '개 · ' + won(x.gross)));
          })) : emptyEl('아직 판매가 없어요'))),
      h('div', { class: 'card' }, h('h3', { class: 'sec-title', style: 'margin:0' }, '쿠폰 사용 현황'),
        r.coupons.length ? h('table', { class: 'tbl' }, h('thead', null, h('tr', null, h('th', null, '쿠폰'), h('th', { class: 'r' }, '발급'), h('th', { class: 'r' }, '사용'))),
          h('tbody', null, r.coupons.map(function (c) { return h('tr', null, h('td', null, c.label), h('td', { class: 'r' }, String(c.issued)), h('td', { class: 'r' }, String(c.used))); }))) : emptyEl('발급된 쿠폰이 없어요')));
  }

  // =====================================================================
  // boot
  // =====================================================================
  SC.api('/api/staff/me', { noAuthRedirect: true }).then(function () { afterLogin(); }, function () { showLogin(); });
})();

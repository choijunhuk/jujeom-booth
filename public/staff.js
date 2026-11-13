/* Staff app: PIN login, orders, tables, calls/waitlist, coupons, menu, sales. */
(function () {
  'use strict';
  var SC = window.SC, h = SC.h, $ = SC.$, won = SC.won, BASE = SC.BASE;
  var TITLE = '스태프 · 주점 부스';
  // Nag alarm thresholds (ms): repeat the alert while something stays unhandled.
  var NAG_ORDER_MS = 60000, NAG_CALL_MS = 90000, NAG_REPEAT_MS = 20000, NAG_SNOOZE_MS = 5 * 60000;
  (function () { // local testing only: ?nag=3 shortens the thresholds on this viewer's own page
    var f = Number(new URLSearchParams(location.search).get('nag'));
    if (f > 0 && /^(127\.0\.0\.1|localhost)$/.test(location.hostname)) { NAG_ORDER_MS = NAG_CALL_MS = f * 1000; NAG_REPEAT_MS = Math.max(2000, f * 1000); }
  }());
  var LABEL = { pending: '접수 대기', cooking: '조리 중', served: '서빙 완료', cancelled: '취소됨' };
  var STTAG = { pending: 'warn', cooking: 'info', served: 'ok', cancelled: 'mute' };
  var TABS = [['orders', '주문'], ['deposits', '입금'], ['tables', '테이블'], ['calls', '호출'], ['coupons', '쿠폰'], ['menu', '메뉴'], ['settings', '설정'], ['sales', '매출']];
  var S = { data: null, tab: 'orders', filter: 'pending', onlyUnpaid: false, billTable: null, moving: false, seen: null, live: null, deposits: null, depPrev: null, depAlertAt: 0, depSig: '', nagBox: null, snoozeUntil: 0, lastNag: 0, sales: null, salesAt: 0, salesSig: '', result: null, awardMsg: '' };
  var V = {}; // views: {root, render}
  var shell, tabBtns = {}, badges = {}, bill;

  function api(path, body) { return SC.api(path, { body: body === undefined ? {} : body }); }
  function refresh() { return S.live ? S.live.refresh() : api('/api/staff/state').then(onState); }
  function abtn(cls, label, fn, okMsg) {
    var b = h('button', { class: cls, type: 'button', onclick: function () { SC.act(b, fn, okMsg); } }, label);
    return b;
  }
  function sig(x) { return JSON.stringify(x); }
  var emptyEl = function (t) { return h('div', { class: 'empty' }, t); };

  // =====================================================================
  // app shell
  // =====================================================================
  var gate;
  function stopApp() {
    if (S.live) { S.live.close(); S.live = null; }
    document.querySelectorAll('dialog[open]').forEach(function (d) {
      if (d.classList.contains('wide') || d.classList.contains('hub-sheet')) d.close(); else d.dispatchEvent(new Event('cancel', { cancelable: true })); // resolves pending confirms and removes the node
    });
    setNagHeight(0);
  }
  function startApp() {
    var app = $('#app');
    if (!app.firstChild) buildApp(app);
    S.data = null; S.seen = null; S.sales = null;
    if (S.live) S.live.close();
    shell.conn.set('wait');
    S.live = SC.live({ sse: '/api/staff/events', poll: '/api/staff/state', onState: onState, onStatus: function (st) { shell.conn.set(st); }, hints: { new_deposit: onNewDeposit, deposit_matched: onDepositMatched } });
    SC.wake.sync();
    var want = location.hash.slice(1);
    setTab(V[want] ? want : S.tab);
  }

  function buildApp(app) {
    SC.prefs.defaults({ vol: 1 });
    shell = SC.shell({ page: 'staff', label: '스태프', kinds: ['order', 'call', 'wait'], onLogout: function () { gate.logout(); } });
    var top = shell.el;
    var tabs = h('nav', { class: 'tabs', 'aria-label': '화면 구역' });
    TABS.forEach(function (t) {
      var b = h('button', { class: 'tab', type: 'button', onclick: function () { setTab(t[0]); } }, t[1]);
      var bd = h('span', { class: 'badge', hidden: true, 'aria-hidden': 'true' });
      b.appendChild(bd);
      tabs.appendChild(b);
      tabBtns[t[0]] = b; badges[t[0]] = bd;
    });
    var main = h('main');
    var builders = { orders: buildOrders, tables: buildTables, calls: buildCalls, coupons: buildCoupons, menu: buildMenu, settings: buildSettings, sales: buildSales, deposits: buildDeposits };
    TABS.forEach(function (t) {
      V[t[0]] = builders[t[0]]();
      V[t[0]].root.classList.add('view');
      V[t[0]].root.hidden = true;
      main.appendChild(V[t[0]].root);
    });
    bill = h('dialog', { class: 'dlg wide', 'aria-label': '테이블 계산서' });
    bill.addEventListener('close', function () { S.billTable = null; S.moving = false; bill._sig = ''; });
    if (window.ResizeObserver) new ResizeObserver(function () { document.documentElement.style.setProperty('--toph', top.offsetHeight + 'px'); }).observe(top);
    S.nagBox = buildNag();
    app.append(SC.audioStrip(), S.nagBox.el, top, tabs, main, bill);
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
    var depN = d.deposit ? (d.deposit.pending || 0) + (d.deposit.unparsed || 0) : 0;
    setBadge('deposits', depN);
    if (S.depPrev != null && depN > S.depPrev && Date.now() - S.depAlertAt > 3000) { S.depAlertAt = Date.now(); SC.attention('deposit'); SC.toast('입금 확인이 필요해요', 'ok'); } // polling fallback (no SSE hints)
    S.depPrev = depN;
    SC.setTitle(pending + d.calls.length + depN, TITLE);
    V[S.tab].render();
    renderBill();
    nagCheck();
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
    no.forEach(function (o) { SC.notif.show('새 주문 · ' + o.table + '번 테이블', SC.itemsText(o.items) + ' · ' + won(o.total), 'order-' + o.id); });
    nc.forEach(function (c) { SC.notif.show('직원 호출 · ' + c.table + '번 테이블', c.type, 'call-' + c.id); });
    nw.forEach(function (w) { SC.notif.show('새 대기 등록', w.nick + ' · ' + w.size + '명', 'wait-' + w.id); });
    if (no.length) { SC.attention('order'); SC.toast('새 주문 · ' + no.map(function (o) { return o.table + '번'; }).join(', ') + ' 테이블', 'ok'); }
    if (nc.length) {
      if (no.length) setTimeout(function () { SC.attention('call'); }, 800); else SC.attention('call');
      SC.toast('직원 호출 · ' + nc.map(function (c) { return c.table + '번 ' + c.type; }).join(', '), 'ok');
    }
    if (nw.length && !no.length && !nc.length) { SC.attention('wait'); SC.toast('새 대기 등록 ' + nw.length + '팀', 'ok'); }
  }

  // =====================================================================
  // nag alarm: repeat while orders / calls stay unhandled
  // =====================================================================
  function buildNag() {
    var go = h('button', { class: 'go', type: 'button' });
    var snz = h('button', { class: 'snz', type: 'button' });
    var el = h('div', { class: 'nag', role: 'alert', hidden: true }, go, snz);
    var box = { el: el, go: go, snz: snz, target: null };
    go.addEventListener('click', function () { jumpTo(box.target); });
    snz.addEventListener('click', function () {
      S.snoozeUntil = Date.now() < S.snoozeUntil ? 0 : Date.now() + NAG_SNOOZE_MS;
      nagCheck();
    });
    return box;
  }
  function setNagHeight(px) { document.documentElement.style.setProperty('--nagh', px + 'px'); }
  function jumpTo(t) {
    if (!t) return;
    if (t.tab === 'orders') { S.filter = 'pending'; S.onlyUnpaid = false; }
    setTab(t.tab);
    setTimeout(function () {
      var el = document.querySelector(t.sel);
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('hl');
      setTimeout(function () { el.classList.remove('hl'); }, 1700);
    }, 50);
  }
  function nagCheck() {
    var nb = S.nagBox;
    if (!nb || !S.data || $('#app').hidden) return;
    var now = Date.now(), d = S.data;
    var oo = d.orders.filter(function (o) { return o.status === 'pending' && now - o.createdAt > NAG_ORDER_MS; }).sort(function (a, b) { return a.createdAt - b.createdAt; });
    var cc = d.calls.filter(function (c) { return now - c.createdAt > NAG_CALL_MS; }).sort(function (a, b) { return a.createdAt - b.createdAt; });
    if (!oo.length && !cc.length) { if (!nb.el.hidden) { nb.el.hidden = true; setNagHeight(0); } return; }
    var parts = [];
    if (oo.length) parts.push('접수 안 된 주문 ' + oo.length + '건 · 가장 오래된 주문 ' + SC.agoText(oo[0].createdAt));
    if (cc.length) parts.push('처리 안 된 호출 ' + cc.length + '건 · ' + SC.agoText(cc[0].createdAt));
    var text = parts.join(' / ') + ' (눌러서 이동)';
    var quiet = now < S.snoozeUntil;
    if (nb.go.textContent !== text) nb.go.textContent = text;
    nb.snz.textContent = quiet ? '조용히 ' + Math.ceil((S.snoozeUntil - now) / 60000) + '분 남음 · 해제' : '5분간 조용히';
    nb.el.classList.toggle('quiet', quiet);
    nb.target = oo.length ? { tab: 'orders', sel: '[data-oid="' + oo[0].id + '"]' } : { tab: 'calls', sel: '[data-cid="' + cc[0].id + '"]' };
    if (nb.el.hidden) nb.el.hidden = false;
    setNagHeight(nb.el.offsetHeight);
    if (!quiet && now - S.lastNag >= NAG_REPEAT_MS) { S.lastNag = now; SC.attention(oo.length ? 'order' : 'call'); }
  }
  setInterval(nagCheck, 2000);

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
    var home = h('div', { class: 'home' },
      h('h3', { class: 'sec-title' }, '아직 주문이 없어요'),
      h('p', { class: 'muted' }, '새 주문이 들어오면 여기에 바로 떠요. 그동안 다른 화면으로 이동할 수 있어요.'),
      SC.hubTiles('staff'));
    var headChips = h('div', { class: 'chips' }, unpaidChip);
    root.append(h('div', { class: 'view-head' }, h('h2', null, '주문'), headChips), home, chipRow, board);

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
      var none = !S.data.orders.length;
      home.hidden = !none; board.hidden = none; chipRow.hidden = none; headChips.hidden = none;
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
      return SC.confirm({ title: '입금 확인을 취소할까요?', message: o.table + '번 테이블 주문 #' + o.id + '을 미입금으로 되돌려요.' + (o.paidBy === 'auto' ? '\n자동으로 확인된 입금 알림은 "입금" 탭의 확인 대기로 돌아가요.' : ''), ok: '미입금으로 변경' }).then(function (ok) { if (ok) return setPaid(o, false); });
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
    if (live) tags.push(o.paid ? h('span', { class: 'tag ok' }, o.paidBy === 'auto' ? '✓ 자동 확인' : '✓ 입금 완료') : h('span', { class: 'tag bad solid' }, '! 미입금'));
    if (live && !o.paid && o.depositor) tags.push(h('span', { class: 'tag mute' }, '입금자 ' + o.depositor));
    if (live && o.paid && o.depositor) tags.push(h('span', { class: 'tag mute' }, o.depositor));
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
    return h('article', { class: 'ocard st-' + o.status + (live && !o.paid ? ' unpaid' : ''), dataset: { oid: o.id } },
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
  function hiddenTablesText(list) { return list.map(function (t) { return t + '번'; }).join(', ') + ' 테이블에 처리 안 된 주문이 있는데 테이블 수 설정 때문에 가려져 있어요'; }
  function buildTables() {
    var root = h('section', { 'aria-label': '테이블' });
    var grid = h('div', { class: 'tgrid' }), warn = h('div');
    root.append(h('div', { class: 'view-head' }, h('h2', null, '테이블'), h('p', { class: 'muted' }, '눌러서 계산서 · 자리 이동 · 정리')), warn, grid);
    function render() {
      var hid = S.data.hiddenTablesWithOpenOrders || [];
      SC.fill(warn, hid.length ? h('div', { class: 'banner warn', role: 'alert' }, h('span', null, hiddenTablesText(hid)),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: function () { setTab('settings'); setTimeout(function () { var el = document.getElementById('set-tables'); if (el) el.scrollIntoView({ block: 'start' }); }, 80); } }, '테이블 수 늘리러 가기')) : null);
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
      o.depositor ? h('div', { class: 'muted' }, '입금자 ' + o.depositor + (o.paid && o.paidBy === 'auto' ? ' · 자동 확인' : '')) : null,
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
    return h('div', { class: 'row-card hot', dataset: { cid: c.id } },
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
    var couponList = h('div', { class: 'list' }), rewardList = h('div', { class: 'list' }), award = h('div', { class: 'card' }), hourlyCard = buildHourlyCard();
    var unredeemedT = h('span', { class: 'num' }, '0');
    root.append(h('div', { class: 'view-head' }, h('h2', null, '쿠폰')),
      h('div', { class: 'two' },
        h('div', { class: 'list' },
          h('div', { class: 'card redeem' },
            h('h3', { class: 'sec-title', style: 'margin:0' }, '쿠폰 코드 입력'),
            input, go, result,
            h('p', { class: 'muted' }, '할인 쿠폰은 손님이 주문할 때 자동으로 차감돼요. 상품(서비스) 쿠폰만 여기서 사용 처리해요.')),
          award, hourlyCard.el,
          h('div', null, h('h3', { class: 'sec-title' }, '미사용 쿠폰 ', unredeemedT), couponList)),
        h('div', null, h('div', { class: 'view-head', style: 'margin-bottom:8px' }, h('h3', { class: 'sec-title', style: 'margin:0;margin-right:auto' }, '보상 관리'), h('button', { class: 'btn btn-primary btn-sm', type: 'button', onclick: function () { openRewardDialog(null); } }, '+ 보상 추가')), h('p', { class: 'muted', style: 'margin-bottom:8px' }, '바꾼 내용은 이후에 발급되는 쿠폰부터 적용돼요.'), rewardList)));
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
      hourlyCard.update(d);
    }
    return { root: root, render: render };
  }
  function resultBox(kind, head, what, where, sub, warn) {
    return h('div', { class: 'result ' + kind },
      h('div', { class: 'head' }, head), what ? h('div', { class: 'what' }, what) : null, where ? h('div', { class: 'where' }, where) : null,
      sub ? h('div', { class: 'muted' }, sub) : null, warn ? h('div', { class: 'tag warn', style: 'white-space:normal;justify-self:center' }, '! ' + warn) : null);
  }
  function gameLabel(id) { var g = S.data && S.data.games && S.data.games[id]; return g ? g.label : id; }
  function rewardCard(r) {
    var pct = r.stock > 0 ? Math.max(0, Math.min(100, Math.round(r.remaining / r.stock * 100))) : 0;
    var card;
    function lockAll(on) { card.querySelectorAll('button').forEach(function (x) { x.disabled = on; }); }
    function set(n) {
      lockAll(true);
      return api('/api/staff/rewards/' + r.id + '/stock', { stock: n }).then(refresh, function (e) { lockAll(false); throw new Error(menuMsg(e)); });
    }
    function step(dlt) {
      var b = abtn('btn btn-sm', (dlt > 0 ? '+' : '−') + Math.abs(dlt), function () { return set(r.stock + dlt); });
      if (r.stock + dlt < r.issued || r.stock + dlt < 0 || r.stock + dlt > 10000) b.disabled = true;
      return b;
    }
    var typeText = r.type === 'discount' ? '할인 쿠폰 ' + won(r.amount) : '메뉴 교환권';
    card = h('div', { class: 'card reward' + (r.active ? '' : ' off') },
      h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' },
        h('b', { style: 'font-size:1.2rem' }, r.label),
        r.active ? null : h('span', { class: 'tag mute' }, '비활성'),
        r.active && r.remaining <= 0 ? h('span', { class: 'tag bad solid' }, '재고 소진') : null),
      h('div', { class: 'muted' }, gameLabel(r.game) + ' · ' + r.threshold + '점 이상 · ' + typeText),
      h('div', { class: 'meter', role: 'img', 'aria-label': '남은 재고 ' + pct + '%' }, h('i', { style: 'width:' + pct + '%' })),
      h('div', null, h('b', { class: 'num', style: 'font-size:1.3rem' }, r.remaining + '개 남음'), h('span', { class: 'muted num' }, ' / 재고 ' + r.stock + ' · 발급 ' + r.issued + ' · 사용 ' + r.used)),
      h('div', { class: 'stockctl' }, h('span', { class: 'muted' }, '재고'), step(-5), step(-1), step(1), step(5)),
      h('div', { class: 'al-seg' },
        abtn('btn btn-sm' + (r.active ? '' : ' btn-primary'), r.active ? '비활성으로' : '활성으로', function () {
          return api('/api/staff/rewards/' + r.id, { active: !r.active }).then(function () { SC.toast(r.label + (r.active ? ' 비활성화' : ' 활성화'), 'ok'); return refresh(); }, function (e) { throw new Error(menuMsg(e)); });
        }),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: function () { openRewardDialog(r); } }, '수정'),
        abtn('btn btn-sm btn-danger', '삭제', function () {
          return SC.confirm({ title: '"' + r.label + '" 보상을 삭제할까요?', danger: true, ok: '삭제', message: '되돌릴 수 없어요. 잠시 끄려면 "비활성으로"를 쓰세요.' }).then(function (ok) {
            if (!ok) return;
            return api('/api/staff/rewards/' + r.id + '/delete').then(function () { SC.toast('삭제했어요', 'ok'); return refresh(); }, function (e) {
              if (e.code !== 'in_use') { menuFail(e); return; }
              return SC.confirm({ title: '삭제할 수 없어요', ok: '비활성화로 바꾸기', cancel: '그냥 두기', message: '이미 발급된 쿠폰이 있는 보상은 삭제할 수 없어요. 비활성화하면 더 이상 발급되지 않고, 이미 받은 쿠폰은 그대로 써요.' }).then(function (ok2) {
                if (ok2) return api('/api/staff/rewards/' + r.id, { active: false }).then(function () { SC.toast(r.label + ' 비활성화', 'ok'); return refresh(); });
              });
            });
          });
        })));
    return card;
  }
  function openRewardDialog(r) {
    var d = S.data, games = d.games || {}, gids = Object.keys(games), editing = !!r;
    var label = h('input', { class: 'field', type: 'text', maxlength: '20', value: editing ? r.label : '', autocomplete: 'off', 'aria-label': '보상 이름' });
    var game = h('select', { class: 'field', 'aria-label': '게임' }, gids.map(function (g) { return h('option', { value: g }, games[g].label + ' (최고 ' + games[g].maxScore + '점)'); }));
    game.value = editing ? r.game : gids[0];
    var thr = h('input', { class: 'field', type: 'number', inputmode: 'numeric', min: '0', step: '10', value: editing ? String(r.threshold) : '', 'aria-label': '기준 점수' });
    var hint = h('output', { class: 'muted', 'aria-live': 'polite' });
    var type = h('select', { class: 'field', 'aria-label': '종류' }, h('option', { value: 'item' }, '메뉴 교환권 (이름대로 지급)'), h('option', { value: 'discount' }, '할인 쿠폰 (주문에서 차감)'));
    type.value = editing ? r.type : 'item';
    var amt = h('input', { class: 'field', type: 'number', inputmode: 'numeric', step: '100', min: '100', max: '100000', value: editing && r.amount ? String(r.amount) : '', 'aria-label': '할인 금액 (원)' });
    var amtRow = h('label', { class: 'lab' }, '할인 금액 (100원 단위, 100~100,000원)', amt);
    var stock = h('input', { class: 'field', type: 'number', inputmode: 'numeric', min: editing ? String(r.issued) : '0', max: '10000', value: editing ? String(r.stock) : '10', 'aria-label': '재고' });
    var active = h('input', { type: 'checkbox', style: 'width:24px;height:24px' }); active.checked = editing ? !!r.active : true;
    var err = h('p', { role: 'alert', style: 'color:var(--danger);font-weight:800;min-height:1.4em' });
    function maxScore() { return games[game.value] ? games[game.value].maxScore : 0; }
    function sync() {
      var n = Number(thr.value);
      hint.textContent = thr.value.trim() === '' ? '최고 점수 ' + maxScore() + '점' : '최고 점수 ' + maxScore() + '점 중 ' + n + '점 이상';
      amtRow.hidden = type.value !== 'discount';
    }
    [thr, game, type].forEach(function (x) { x.addEventListener('input', sync); x.addEventListener('change', sync); });
    sync();
    var dlg = h('dialog', { class: 'dlg wide', 'aria-label': editing ? '보상 수정' : '보상 추가' });
    function close() { if (dlg.open) dlg.close(); dlg.remove(); }
    var save = h('button', { class: 'btn btn-primary', type: 'submit' }, '저장');
    function validate() {
      var l = label.value.trim(), n = Number(thr.value), st = Number(stock.value), am = Number(amt.value);
      if (l.length < 1 || l.length > 20) return MENU_ERR.bad_label;
      if (!game.value) return MENU_ERR.bad_game;
      if (thr.value.trim() === '' || !Number.isInteger(n) || n < 0 || n > maxScore()) return '기준 점수는 0~' + maxScore() + '점 사이 정수여야 해요.';
      if (type.value === 'discount' && !(Number.isInteger(am) && am >= 100 && am <= 100000 && am % 100 === 0)) return MENU_ERR.bad_amount;
      if (stock.value.trim() === '' || !Number.isInteger(st) || st < 0 || st > 10000) return MENU_ERR.bad_stock;
      if (editing && st < r.issued) return '이미 ' + r.issued + '장 발급되어 그보다 적게 줄일 수 없습니다.';
      return '';
    }
    function submit() {
      err.textContent = validate();
      if (err.textContent) return;
      var body = { label: label.value.trim(), game: game.value, threshold: Number(thr.value), type: type.value, stock: Number(stock.value), active: active.checked };
      if (body.type === 'discount') body.amount = Number(amt.value);
      var call;
      if (!editing) call = api('/api/staff/rewards', body);
      else {
        var diff = {};
        Object.keys(body).forEach(function (k) { if (body[k] !== r[k]) diff[k] = body[k]; });
        if (diff.type === 'discount' && diff.amount === undefined) diff.amount = body.amount;
        if (!Object.keys(diff).length) { close(); return; }
        call = api('/api/staff/rewards/' + r.id, diff);
      }
      save.disabled = true; save.classList.add('busy');
      call.then(function () { close(); SC.toast(editing ? '보상을 수정했어요' : '보상을 추가했어요', 'ok'); return refresh(); }, function (e) {
        save.disabled = false; save.classList.remove('busy');
        err.textContent = menuMsg(e);
        if (e.code === 'no_reward') { close(); refresh(); }
      });
    }
    dlg.appendChild(h('form', { class: 'dlg-body', novalidate: true, onsubmit: function (e) { e.preventDefault(); submit(); } },
      h('h2', { class: 'dlg-title' }, editing ? '보상 수정' : '보상 추가'),
      h('label', { class: 'lab' }, '이름 (1~20자)', label),
      h('label', { class: 'lab' }, '게임', game),
      h('label', { class: 'lab' }, '기준 점수 (이 점수 이상이면 받아요)', thr, hint),
      h('label', { class: 'lab' }, '종류', type), amtRow,
      h('label', { class: 'lab' }, '재고 (총 발급 수량, 0~10,000' + (editing ? ', 이미 발급 ' + r.issued + '장 이상' : '') + ')', stock),
      h('label', { style: 'display:flex;gap:10px;align-items:center;font-weight:800' }, active, '사용 중 (끄면 더 이상 발급되지 않아요)'),
      h('p', { class: 'muted' }, '바꾼 내용은 이후에 발급되는 쿠폰부터 적용돼요. 이미 발급된 쿠폰은 그대로예요.'),
      err,
      h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', type: 'button', onclick: close }, '취소'), save)));
    dlg.addEventListener('cancel', function (e) { e.preventDefault(); close(); });
    document.body.appendChild(dlg); dlg.showModal(); label.focus();
  }

  // ---- hourly ranking reward setting ----
  function buildHourlyCard() {
    var sigv = '', cur = null;
    var label = h('input', { class: 'field', type: 'text', maxlength: '20', autocomplete: 'off', 'aria-label': '정시 시상 상품 이름' });
    var type = h('select', { class: 'field', 'aria-label': '정시 시상 종류' }, h('option', { value: 'item' }, '메뉴 교환권'), h('option', { value: 'discount' }, '할인 쿠폰'));
    var amt = h('input', { class: 'field', type: 'number', inputmode: 'numeric', step: '100', min: '100', max: '100000', 'aria-label': '할인 금액 (원)' });
    var amtRow = h('label', { class: 'lab' }, '할인 금액 (100원 단위)', amt);
    var state = h('span', { class: 'tag' });
    var err = h('p', { role: 'alert', style: 'color:var(--danger);font-weight:800' });
    type.addEventListener('change', function () { amtRow.hidden = type.value !== 'discount'; });
    var toggle = abtn('btn', '', function () {
      return api('/api/staff/hourly-reward', { enabled: !(cur && cur.enabled) }).then(refresh, function (e) { throw new Error(menuMsg(e)); });
    });
    var save = abtn('btn btn-primary', '저장', function () {
      var l = label.value.trim(), am = Number(amt.value);
      err.textContent = '';
      if (l.length < 1 || l.length > 20) { err.textContent = MENU_ERR.bad_label; return Promise.resolve(); }
      var body = { label: l, type: type.value };
      if (type.value === 'discount') {
        if (!(Number.isInteger(am) && am >= 100 && am <= 100000 && am % 100 === 0)) { err.textContent = MENU_ERR.bad_amount; return Promise.resolve(); }
        body.amount = am;
      }
      return api('/api/staff/hourly-reward', body).then(function () { SC.toast('정시 시상 설정을 저장했어요', 'ok'); return refresh(); }, function (e) { err.textContent = menuMsg(e); });
    });
    var el = h('div', { class: 'card' },
      h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, h('b', { style: 'font-size:1.15rem' }, '정시 1등 시상 설정'), state, toggle),
      h('label', { class: 'lab' }, '상품 이름 (1~20자)', label), h('label', { class: 'lab' }, '종류', type), amtRow, err, save,
      h('p', { class: 'muted' }, '매 정시 1등 테이블에게 주는 상품이에요. 끄면 시상 버튼이 비활성화되고, 바꾼 내용은 이후 시상부터 적용돼요.'));
    function update(d) {
      var hr = d.hourly || {}, s = sig(hr);
      cur = hr;
      state.className = 'tag ' + (hr.enabled ? 'ok' : 'mute'); state.textContent = hr.enabled ? '켜짐' : '꺼짐';
      toggle.textContent = hr.enabled ? '시상 끄기' : '시상 켜기';
      if (s !== sigv) { sigv = s; label.value = hr.label || ''; type.value = hr.type === 'discount' ? 'discount' : 'item'; amt.value = hr.amount ? String(hr.amount) : ''; amtRow.hidden = type.value !== 'discount'; err.textContent = ''; }
    }
    return { el: el, update: update };
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
    var hourlyOff = d.hourly && d.hourly.enabled === false;
    if (!top || d.hour.awarded || hourlyOff) cur.disabled = true;
    SC.fill(box,
      h('h3', { class: 'sec-title', style: 'margin:0' }, '정시 1등 시상 ', d.hour.awarded ? h('span', { class: 'tag ok' }, '✓ 이번 시간 시상 완료') : null),
      h('div', { class: 'leader' },
        h('span', { class: 'muted' }, SC.clock(d.hour.start) + ' ~ ' + SC.clock(d.hour.end) + ' 현재 1등'),
        top ? h('span', { class: 'who' }, who(top)) : h('span', { class: 'who muted' }, '아직 게임한 테이블이 없어요'),
        d.hourly && d.hourly.label ? h('span', { class: 'muted' }, '상품: ' + d.hourly.label) : null),
      d.hour.ranking && d.hour.ranking.length ? h('ol', { class: 'rank-mini' }, d.hour.ranking.map(function (r, i) {
        return h('li', null, h('span', { class: 'r' }, String(i + 1)), h('span', null, r.table + '번 ' + (r.nick || '')), h('span', { class: 's' }, r.score + '점'));
      })) : null,
      hourlyOff ? h('p', { class: 'tag mute', style: 'white-space:normal;justify-self:start' }, '정시 시상이 꺼져 있어서 시상할 수 없어요. 아래 "정시 1등 시상 설정"에서 켜 주세요.') : null,
      cur,
      prev && prev.top && !prev.awarded && !hourlyOff ? abtn('btn btn-block', '지난 시간(' + SC.clock(prev.start) + ') 1등 ' + prev.top.table + '번 시상', function () { return award(prev.top, prev.start, '지난 시간 1등 시상'); }) : null,
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
    bad_label: '이름은 1~20자로 입력해 주세요.',
    bad_game: '게임을 골라 주세요.',
    bad_threshold: '기준 점수는 0 이상, 그 게임의 최고 점수 이하 정수여야 해요.',
    bad_type: '종류를 골라 주세요.',
    bad_amount: '금액은 100원 단위의 올바른 값이어야 해요.',
    bad_stock: '재고는 0~10,000 사이 정수여야 해요.',
    bad_active: '사용 여부 값이 올바르지 않아요.',
    bad_enabled: '켜기/끄기 값이 올바르지 않아요.',
    bad_mode: '할인 방식을 정률(%) 또는 정액(원)으로 골라 주세요.',
    bad_min_order: '최소 주문 금액은 100원 단위, 0~1,000,000원이에요.',
    bad_max_discount: '최대 할인액은 100원 단위, 0~1,000,000원이에요. (0 = 제한 없음)',
    bad_include_associate: '준회원 포함 값이 올바르지 않아요.',
    bad_per_member_limit: '1인당 횟수는 1~100 사이 정수예요.',
    bad_stack_with_coupon: '쿠폰 함께 사용 값이 올바르지 않아요.',
    too_many_rewards: '보상은 최대 12개까지 만들 수 있어요.',
    no_reward: '이미 삭제된 보상이에요. 화면을 새로 불러올게요.',
    hourly_disabled: '정시 시상이 꺼져 있어요. 아래 설정에서 켜 주세요.',
    too_large: '사진이 너무 커요. 400KB 이하여야 해요.',
    unsupported_media_type: '지원하지 않는 사진 형식이에요. JPEG, PNG, WebP만 올릴 수 있어요.',
    type_mismatch: '사진 파일의 실제 형식이 선택한 형식과 달라요. 다른 사진을 골라 주세요.',
    bad_image: '사진 파일을 읽을 수 없어요. 다른 사진을 골라 주세요.',
    photo_storage_full: '사진 저장 공간이 가득 찼어요. 안 쓰는 메뉴 사진을 먼저 삭제해 주세요.',
    storage_full: '서버 저장 공간이 부족해요. 관리자에게 알려 주세요.',
    network: '네트워크 연결을 확인해 주세요.',
    bad_count: '테이블 수는 1~50 사이 정수예요.',
    no_table: '없는 테이블이에요. 화면을 새로 불러올게요.',
    account_mismatch: '계좌번호가 서로 달라요. 두 칸에 똑같이 입력해 주세요.',
    bad_kakao_url: '카카오페이 링크가 올바르지 않아요. https://qr.kakaopay.com/ 로 시작하는 링크만 쓸 수 있어요.',
    bad_bank: '은행 이름은 1~20자로 입력해 주세요.',
    bad_holder: '예금주는 1~20자로 입력해 주세요.',
    bad_account: '계좌번호는 숫자와 하이픈(-)만, 숫자 8~20자리로 입력해 주세요. (하이픈은 숫자 사이에만)',
    bad_toss_enabled: '토스 사용 값이 올바르지 않아요.',
    bad_require_depositor: '입금자명 필수 값이 올바르지 않아요.',
    amount_mismatch: '입금 금액과 주문 금액이 달라요.',
    notice_closed: '이미 처리된 입금 알림이에요. 목록을 새로 불러올게요.',
    order_paid: '이미 입금 확인된 주문이에요.',
    order_cancelled: '취소된 주문이에요.',
    bad_order: '주문을 고르지 못했어요. 다시 시도해 주세요.',
    no_notice: '없는 입금 알림이에요. 목록을 새로 불러올게요.',
    no_order: '지금 보이는 주문만 연결할 수 있어요. 화면을 새로 불러올게요.',
    bad_auto_confirm: '자동 확인 값이 올바르지 않아요.',
    rate_limited: '입금 알림이 너무 빨리 들어왔어요. 잠시 후 다시 시도해 주세요.',
    bad_body: '알림 내용(text)이 비어 있어요.',
    bad_json: '알림 형식이 올바르지 않아요.',
    not_found: '주소가 올바르지 않아요. 주소를 다시 불러와 주세요.',
    review_needs_force: '취소·정정 단어가 있는 문자는 내용을 확인하고 "그래도 확인"으로만 연결할 수 있어요.',
    order_unpaid: '아직 입금 확인 전인 주문이에요. "이 주문으로 확인"을 써 주세요.',
    order_has_notice: '이미 다른 입금 알림과 연결된 주문이에요.',
    bad_auto_max: '자동 확인 최대 금액은 0~1,000,000원이에요. (0 = 자동 확인 안 함)',
    queue_full: '입금 알림이 너무 많이 쌓였어요. 확인하거나 무시해서 비워 주세요.',
  };
  function menuMsg(e) {
    if (e.code === 'stock_below_issued') return '이미 ' + (e.data && e.data.issued != null ? e.data.issued : '') + '장 발급되어 그보다 적게 줄일 수 없습니다.';
    return MENU_ERR[e.code] || e.message;
  }
  function menuFail(e) { SC.toast(menuMsg(e), 'error'); if (e.code === 'no_item' || e.code === 'no_category' || e.code === 'no_reward' || e.code === 'no_table') refresh(); }
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
    root.append(h('div', { class: 'view-head' }, h('h2', null, '메뉴 관리'),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: function () { openItemDialog(null); } }, '+ 메뉴 추가'),
      h('button', { class: 'btn', type: 'button', onclick: addCategory }, '+ 분류 추가')),
      swBox, listBox);
    function render() {
      var d = S.data;
      renderOrdering(swBox, d);
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
            i.photo ? h('img', { class: 'thumb', src: SC.BASE + i.photo, alt: '', width: '64', height: '48', loading: 'lazy' }) : null,
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

  // ---- photos: client-side crop/resize/encode, then raw upload ----
  var PHOTO_MAX = 380 * 1024;
  function toBlobP(cv, type, q) { return new Promise(function (res) { cv.toBlob(res, type, q); }); }
  async function preparePhoto(file) {
    var bmp;
    try {
      try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { bmp = await createImageBitmap(file); }
    } catch (e) { throw new Error('사진을 읽을 수 없어요. (아이폰 HEIC 등은 JPEG로 바꿔 올려 주세요.)'); }
    var w = bmp.width, hh = bmp.height, sw, sh, sx = 0, sy = 0;
    if (w / hh > 4 / 3) { sh = hh; sw = Math.round(hh * 4 / 3); sx = Math.round((w - sw) / 2); } else { sw = w; sh = Math.round(w * 3 / 4); sy = Math.round((hh - sh) / 2); }
    var tw0 = Math.min(960, sw), cv = document.createElement('canvas'), ctx = cv.getContext('2d');
    var scales = [1, 0.85, 0.7, 0.55, 0.4], qs = [0.8, 0.7, 0.6, 0.5], types = ['image/webp', 'image/jpeg'];
    var skip = {};
    for (var si = 0; si < scales.length; si++) {
      var tw = Math.max(160, Math.round(tw0 * scales[si])), th = Math.round(tw * 3 / 4);
      cv.width = tw; cv.height = th;
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, tw, th);
      ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, tw, th);
      for (var ti = 0; ti < types.length; ti++) {
        var type = types[ti];
        if (skip[type]) continue;
        for (var qi = 0; qi < qs.length; qi++) {
          var q = type === 'image/jpeg' ? qs[qi] + 0.02 : qs[qi];
          var blob = await toBlobP(cv, type, q);
          if (!blob || blob.type !== type) { skip[type] = true; break; } // browser cannot encode this type
          if (blob.size <= PHOTO_MAX) { if (bmp.close) bmp.close(); return { blob: blob, w: tw, h: th }; }
        }
      }
    }
    if (bmp.close) bmp.close();
    throw new Error('사진을 400KB 이하로 줄이지 못했어요. 다른 사진을 골라 주세요.');
  }
  function uploadPhoto(id, blob) {
    return fetch(SC.BASE + '/api/staff/menu/items/' + encodeURIComponent(id) + '/photo', { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob, cache: 'no-store' }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (res.ok) return data;
        if (res.status === 401 && SC.onUnauthorized) SC.onUnauthorized();
        var e = new Error((data && data.message) || '업로드에 실패했어요. (' + res.status + ')');
        e.code = (data && data.error) || (res.status === 413 ? 'too_large' : res.status === 415 ? 'unsupported_media_type' : ''); e.status = res.status; e.data = data || {};
        throw e;
      });
    }, function () { var e = new Error('네트워크 연결을 확인해 주세요.'); e.code = 'network'; throw e; });
  }
  function kb(n) { return Math.round(n / 1024) + ' KB'; }

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
    // photo
    var pend = null;
    var pimg = h('img', { class: 'photo-prev', alt: '메뉴 사진 미리보기', hidden: true });
    var pinfo = h('p', { class: 'muted', role: 'status', 'aria-live': 'polite' });
    var fileIn = h('input', { type: 'file', accept: 'image/*', class: 'vh', 'aria-label': '사진 선택' });
    var delPhoto = h('button', { class: 'btn btn-danger btn-sm', type: 'button', onclick: function () {
      SC.confirm({ title: '사진을 삭제할까요?', danger: true, ok: '사진 삭제', message: '"' + item.name + '" 메뉴의 사진이 지워져요.' }).then(function (ok) {
        if (!ok) return;
        SC.act(delPhoto, function () {
          return api('/api/staff/menu/items/' + encodeURIComponent(item.id) + '/photo/delete').then(function () { item.photo = null; showCurrent(); SC.toast('사진을 삭제했어요', 'ok'); return refresh(); }, function (e) { throw new Error(menuMsg(e)); });
        });
      });
    } }, '사진 삭제');
    function showCurrent() {
      if (pend) return;
      var has = editing && item.photo;
      pimg.hidden = !has; if (has) pimg.src = SC.BASE + item.photo;
      pinfo.textContent = has ? '현재 사진' : '사진 없음 (선택 사항)';
      delPhoto.hidden = !has;
    }
    fileIn.addEventListener('change', function () {
      var f = fileIn.files && fileIn.files[0];
      if (!f) return;
      err.textContent = ''; pinfo.textContent = '사진을 줄이는 중…';
      preparePhoto(f).then(function (r) {
        if (pend) URL.revokeObjectURL(pend.url);
        pend = { blob: r.blob, url: URL.createObjectURL(r.blob) };
        pimg.src = pend.url; pimg.hidden = false; delPhoto.hidden = true;
        pinfo.textContent = '새 사진 · ' + kb(r.blob.size) + ' · ' + r.w + '×' + r.h + ' · ' + (r.blob.type === 'image/webp' ? 'WebP' : 'JPEG') + ' (저장하면 올라가요)';
      }, function (e) { pend = null; showCurrent(); err.textContent = e.message; });
      fileIn.value = '';
    });
    var photoBox = h('div', { class: 'lab' }, '사진 (4:3으로 잘라 줄여서 올려요)', pimg, pinfo,
      h('div', { class: 'al-seg' }, h('label', { class: 'btn' }, '사진 선택', fileIn), delPhoto));
    showCurrent();
    function priceOk() { var raw = price.value.trim(), n = Number(raw); return raw !== '' && Number.isInteger(n) && n >= 0 && n <= 1000000 && n % 100 === 0; }
    function syncPrice() { preview.textContent = priceOk() ? won(Number(price.value)) : (price.value.trim() === '' ? '' : '100원 단위로 입력해 주세요'); preview.style.color = priceOk() || !price.value ? '' : 'var(--danger)'; }
    function syncCat() { newCat.hidden = sel.value !== NEW; if (!newCat.hidden) newCat.focus(); }
    price.addEventListener('input', syncPrice); sel.addEventListener('change', syncCat);
    syncPrice(); newCat.hidden = sel.value !== NEW;
    var dlg = h('dialog', { class: 'dlg wide', 'aria-label': editing ? '메뉴 수정' : '메뉴 추가' });
    function close() { if (pend) URL.revokeObjectURL(pend.url); if (dlg.open) dlg.close(); dlg.remove(); }
    var saveBtn = h('button', { class: 'btn btn-primary', type: 'submit' }, '저장');

    function validate() {
      var n = name.value.trim(), c = sel.value === NEW ? newCat.value.trim() : sel.value;
      if (n.length < 1 || n.length > 30) return MENU_ERR.bad_name;
      if (!priceOk()) return MENU_ERR.bad_price;
      if (c.length < 1 || c.length > 12) return MENU_ERR.bad_category;
      if (desc.value.trim().length > 60) return MENU_ERR.bad_desc;
      return '';
    }
    // after the item is saved, upload the photo; a failed upload keeps the item and reports why
    function withPhoto(id, r) {
      if (!pend) return Promise.resolve(r);
      return uploadPhoto(id, pend.blob).then(function () { return r; }, function (e) { r.photoError = menuMsg(e); return r; });
    }
    function submit() {
      err.textContent = validate();
      if (err.textContent) return;
      var body = { name: name.value.trim(), price: Number(price.value), category: sel.value === NEW ? newCat.value.trim() : sel.value, desc: desc.value.trim() };
      saveBtn.disabled = true; saveBtn.classList.add('busy');
      var run;
      if (!editing) {
        if (hid.checked) body.hidden = true; // one request: never visible to guests
        run = api('/api/staff/menu/items', body).then(function (r) { return withPhoto(r.item.id, r); });
      } else {
        var diff = {};
        if (body.name !== item.name) diff.name = body.name;
        if (body.price !== item.price) diff.price = body.price;
        if (body.category !== item.cat) diff.category = body.category;
        if (body.desc !== (item.desc || '')) diff.desc = body.desc;
        if (hid.checked !== !!item.hidden) diff.hidden = hid.checked;
        if (!Object.keys(diff).length) {
          if (pend) { run = withPhoto(item.id, {}); diff = null; } else { saveBtn.disabled = false; saveBtn.classList.remove('busy'); close(); return; }
        }
        var gate = diff && diff.price !== undefined
          ? SC.confirm({ title: '가격을 바꿀까요?', ok: '가격 바꾸기', message: (diff.name || item.name) + ' ' + won(item.price) + ' → ' + won(diff.price) + '으로 바꿀까요?\n이미 들어온 주문은 그대로예요.' })
          : Promise.resolve(true);
        if (diff) run = gate.then(function (ok) { if (!ok) return null; return api('/api/staff/menu/items/' + encodeURIComponent(item.id), diff).then(function (r) { return withPhoto(item.id, r); }); });
      }
      run.then(function (r) {
        saveBtn.disabled = false; saveBtn.classList.remove('busy');
        if (r === null) return;
        close(); refresh();
        if (r && r.photoError) SC.toast((editing ? '메뉴는 저장됐지만' : '메뉴는 만들어졌지만') + ' 사진을 올리지 못했어요: ' + r.photoError + ' 수정에서 다시 올려 주세요.', 'error', 9000);
        else SC.toast(editing ? '메뉴를 수정했어요' : '메뉴를 추가했어요', 'ok');
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
      photoBox,
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
  // deposits (bank deposit notices): one-tap confirmation
  // =====================================================================
  function loadDeposits() {
    return SC.api('/api/staff/deposits').then(function (r) { S.deposits = r; if (V.deposits && S.tab === 'deposits') V.deposits.render(); return r; }, function () { return null; });
  }
  function noticeAmount(n) { return n.amount != null ? (n.amountGuessed ? '추정 ' : '') + won(n.amount) : '금액 읽기 실패'; }
  function onNewDeposit(ev) {
    S.depAlertAt = Date.now();
    SC.attention('deposit');
    SC.toast('입금 확인이 필요해요', 'ok');
    loadDeposits().then(function (r) {
      var n = r && r.notices.filter(function (x) { return x.id === ev.id; })[0];
      SC.notif.show('입금 확인 필요', n ? noticeAmount(n) + ' · ' + (n.depositor || '이름 없음') : '새 입금 알림', 'dep-' + ev.id);
    });
  }
  function onDepositMatched() { SC.audio.beep('tick'); loadDeposits(); }

  function confirmMismatch(n, o) {
    return SC.confirm({ title: '금액이 달라요', danger: true, ok: '그래도 확인', cancel: '돌아가기',
      message: '입금 ' + (n.amount != null ? won(n.amount) : '금액을 읽지 못함') + ' / ' + o.table + '번 주문 #' + o.id + ' ' + won(o.total) + '\n그래도 이 주문을 입금 확인할까요?' });
  }
  function assignNotice(n, o, force) {
    var pre = n.status === 'review'
      ? SC.confirm({ title: '취소·정정 문자일 수 있어요', danger: true, ok: '그래도 확인', cancel: '돌아가기', message: '문자: ' + n.text + '\n정말 ' + o.table + '번 주문 #' + o.id + ' (' + won(o.total) + ')의 입금이 맞나요?' })
      : Promise.resolve(true);
    return pre.then(function (ok) { if (ok) return doAssign(n, o, force || n.status === 'review'); });
  }
  function doAssign(n, o, force) {
    var body = force ? { orderId: o.id, force: true } : { orderId: o.id };
    return api('/api/staff/deposits/' + n.id + '/assign', body).then(function () {
      SC.toast(o.table + '번 테이블 주문 #' + o.id + ' 입금 확인했어요', 'ok');
      return Promise.all([refresh(), loadDeposits()]);
    }, function (e) {
      if (e.code === 'amount_mismatch' && !force) return confirmMismatch(n, o).then(function (ok) { if (ok) return doAssign(n, o, true); });
      menuFail(e);
      if (e.code === 'notice_closed' || e.code === 'order_paid' || e.code === 'order_cancelled' || e.code === 'no_notice') { refresh(); loadDeposits(); }
    });
  }
  function attachNotice(n, o) {
    return api('/api/staff/deposits/' + n.id + '/attach', { orderId: o.id }).then(function () {
      SC.toast(o.table + '번 주문 #' + o.id + '에 입금 알림을 연결했어요 (입금 상태는 그대로)', 'ok');
      return Promise.all([refresh(), loadDeposits()]);
    }, function (e) { menuFail(e); if (e.code === 'notice_closed' || e.code === 'order_unpaid' || e.code === 'order_has_notice') loadDeposits(); });
  }
  function pickOrder(n) {
    var orders = S.data.orders.filter(function (o) { return o.status !== 'cancelled' && !o.paid; });
    orders.sort(function (a, b) { var am = (a.total === n.amount) ? 0 : 1, bm = (b.total === n.amount) ? 0 : 1; return am - bm || b.id - a.id; });
    var dlg = h('dialog', { class: 'dlg wide', 'aria-label': '주문 고르기' });
    function close() { if (dlg.open) dlg.close(); dlg.remove(); }
    dlg.appendChild(h('div', { class: 'dlg-body' },
      h('h2', { class: 'dlg-title' }, '어느 주문의 입금인가요?'),
      h('p', { class: 'dlg-msg' }, '입금 ' + noticeAmount(n) + (n.depositor ? ' · ' + n.depositor : '')),
      h('div', { class: 'bill-list' }, orders.length ? orders.map(function (o) {
        var same = o.total === n.amount;
        return h('button', { class: 'btn pick-row', type: 'button', onclick: function () {
          close();
          if (same) assignNotice(n, o, false); else confirmMismatch(n, o).then(function (ok) { if (ok) assignNotice(n, o, true); });
        } }, h('b', null, o.table + '번 · ' + won(o.total)), h('span', { class: 'muted' }, (o.depositor ? '입금자 ' + o.depositor : '입금자명 없음') + ' · ' + SC.agoText(o.createdAt) + ' · #' + o.id), same ? h('span', { class: 'tag ok' }, '금액 일치') : h('span', { class: 'tag warn' }, '금액 다름'));
      }) : emptyEl('입금 대기 중인 주문이 없어요')),
      h('div', { class: 'dlg-actions' }, h('button', { class: 'btn', type: 'button', onclick: close }, '닫기'))));
    dlg.addEventListener('cancel', function (e) { e.preventDefault(); close(); });
    document.body.appendChild(dlg); dlg.showModal();
  }
  var REASON_TEXT = {
    multiple_amounts: '문자에 금액으로 보이는 숫자가 여러 개예요',
    no_amount: '문자에서 금액을 찾지 못했어요',
    amount_range: '금액이 읽을 수 있는 범위(100원~1,000만 원)를 벗어나요',
    no_name: '문자에서 입금자명을 찾지 못했어요',
    name_has_digit: '입금자명 형식이 평소와 달라요 (숫자가 섞여 있어요)',
    name_shape: '입금자명 형식이 평소와 달라요',
    several_names: '입금자명으로 보이는 이름이 여러 개예요',
    ignore_word: '취소·정정으로 보이는 문자예요. 실제 입금인지 확인하세요',
    duplicate: '같은 문자가 이미 처리된 뒤 또 들어왔어요',
    amount_adjacent_to_name: '금액이 입금자 문구와 같은 줄에 붙어 있어요',
    text_too_long: '문자가 너무 길어요 (300자 초과). 내용을 직접 확인하세요',
    auto_off: '자동 확인이 꺼져 있어요',
    over_max_amount: '자동 확인 최대 금액을 넘는 금액이에요',
    maybe_already_handled: '이미 손으로 입금 확인한 같은 금액 주문이 있어요',
    no_candidate: '금액이 같은 입금 대기 주문이 없어요 (손님이 아직 주문 전이거나 금액이 달라요)',
    several_candidates: '같은 금액 주문이 여러 건이라 어느 주문인지 몰라요',
    no_depositor_on_order: '주문에 입금자명이 없어요',
    name_mismatch: '입금자명이 주문과 달라요',
  };
  function reasonList(reasons, n, cands) {
    var out = (reasons || []).filter(function (r) { return r !== 'auto_off'; }).map(function (r) {
      var t = REASON_TEXT[r] || r;
      if (r === 'name_mismatch' && n && n.depositor && cands && cands.length === 1 && cands[0].depositor) t += ": 문자 '" + n.depositor + "' / 주문 '" + cands[0].depositor + "'";
      return t;
    });
    return out;
  }
  function whyBlock(n) {
    var list = reasonList(n.reasons, n, n.candidates);
    if (!list.length) return null;
    return h('div', { class: 'why' }, h('b', null, '자동 확인하지 않은 이유'), h('ul', null, list.map(function (t) { return h('li', null, t); })));
  }
  function rateBanner() { return h('div', { class: 'banner bad', role: 'alert' }, '입금 알림 주소로 요청이 너무 많이 들어오고 있어요. 주소가 노출됐다면 재발급하세요.'); }
  function normName(x) { return String(x || '').normalize('NFKC').replace(/\s/g, '').toLowerCase(); }
  function noticeCard(n) {
    var rec = null;
    if (n.status === 'pending' && n.depositor && (n.candidates || []).length === 1 && !reasonList(n.reasons).length && !(n.handledOrders || []).length) {
      var c0 = n.candidates[0];
      if (c0.depositor && normName(c0.depositor) === normName(n.depositor)) rec = c0;
    }
    var recBox = rec ? h('div', { class: 'rec' },
      h('div', { class: 'grow' }, h('span', { class: 'tag ok' }, '추천'), h('b', { style: 'font-size:1.15rem' }, rec.table + '번 · ' + won(rec.total)), h('span', { class: 'muted' }, '입금자 ' + rec.depositor + ' · 문자와 같은 이름 · ' + SC.agoText(rec.createdAt))),
      abtn('btn btn-primary btn-block rec-btn', '입금 확인', function () { return doAssign(n, { table: rec.table, id: rec.id, total: rec.total }, false); })) : null;
    var cands = (n.candidates || []).filter(function (c) { return !rec || c.id !== rec.id; }).map(function (c) {
      var o = { table: c.table, id: c.id, total: c.total };
      return h('div', { class: 'cand' },
        h('div', { class: 'grow' }, h('b', null, c.table + '번 · ' + won(c.total)), h('span', { class: 'muted' }, (c.depositor ? '입금자 ' + c.depositor : '입금자명 없음') + ' · ' + SC.agoText(c.createdAt))),
        abtn('btn btn-primary', '이 주문으로 확인', function () { return assignNotice(n, o, false); }));
    });
    var handled = (n.handledOrders && n.handledOrders.length) ? h('div', { class: 'cands' }, h('b', null, '이미 손으로 입금 확인한 같은 금액 주문 (' + n.handledOrders.length + ')'), h('span', { class: 'muted' }, '이 입금이 그 주문의 것이면 연결만 해 두세요. 입금 상태는 바뀌지 않아요.'), n.handledOrders.map(function (c) {
      var o = { table: c.table, id: c.id, total: c.total };
      return h('div', { class: 'cand' }, h('div', { class: 'grow' }, h('b', null, c.table + '번 · ' + won(c.total)), h('span', { class: 'muted' }, (c.depositor ? '입금자 ' + c.depositor : '입금자명 없음') + ' · ' + SC.agoText(c.createdAt) + ' · 입금 확인됨')),
        abtn('btn', '이 주문에 연결', function () { return attachNotice(n, o); }));
    })) : null;
    return h('article', { class: 'ocard dep ' + (n.status === 'unparsed' ? 'unparsed' : 'pending') },
      h('div', { class: 'ohead' },
        h('div', { class: 'ometa' },
          h('div', { class: 'dep-amt' }, noticeAmount(n)),
          h('div', { class: 'line' }, n.status === 'unparsed' ? h('span', { class: 'tag bad solid' }, '! 읽지 못함') : n.status === 'review' ? h('span', { class: 'tag bad solid' }, '! 취소·정정 단어 포함') : h('span', { class: 'tag warn' }, '확인 필요'),
            n.amountGuessed ? h('span', { class: 'tag mute' }, '추정 금액') : null,
            h('span', { class: 'tag mute' }, n.depositor ? '입금자 ' + n.depositor : '이름 없음'),
            n.repeatCount > 1 ? h('span', { class: 'tag warn' }, '같은 문자 ' + n.repeatCount + '번 수신') : null, SC.timeEl(n.lastAt || n.receivedAt, 'ago')))),
      h('pre', { class: 'rawtext' }, n.text),
      (n.status === 'pending' || n.status === 'review') ? h('div', { class: 'cands' }, recBox, rec ? null : whyBlock(n), cands.length ? [h('b', null, '금액이 같은 주문 (' + cands.length + ')'), cands] : null, handled) : h('p', { class: 'muted' }, '알림에서 금액을 읽지 못했어요. 아래에서 주문을 직접 고를 수 있어요.'),
      h('div', { class: 'row', style: 'display:flex;gap:8px;flex-wrap:wrap' },
        abtn('btn', '다른 주문 선택', function () { pickOrder(n); return Promise.resolve(); }),
        abtn('btn btn-danger', '무시', function () {
          return SC.confirm({ title: '이 입금 알림을 무시할까요?', danger: true, ok: '무시', message: noticeAmount(n) + (n.depositor ? ' · ' + n.depositor : '') + '\n주문과 연결하지 않고 목록에서 치워요.' }).then(function (ok) {
            if (ok) return api('/api/staff/deposits/' + n.id + '/dismiss').then(function () { return loadDeposits().then(refresh); }, function (e) { menuFail(e); loadDeposits(); });
          });
        })));
  }
  function buildDeposits() {
    var root = h('section', { 'aria-label': '입금 확인' });
    var pendBox = h('div', { class: 'list' }), histBox = h('div', { class: 'list' });
    var autoTag = h('span', { class: 'tag' });
    var histSum = h('summary', null, '처리된 입금');
    var hist = h('details', { class: 'hist' }, histSum, histBox);
    var rateBox = h('div'), ignBox = h('div', { class: 'list' }), ignSum = h('summary', null, '무시된 알림');
    var ign = h('details', { class: 'hist' }, ignSum, h('p', { class: 'muted' }, '출금·취소·정정 같은 문자는 입금으로 보지 않고 여기에 모아요. 읽기만 할 수 있어요.'), ignBox);
    root.append(h('div', { class: 'view-head' }, h('h2', null, '입금 확인'), autoTag), rateBox, h('p', { class: 'muted', style: 'margin-bottom:10px' }, '은행 입금 알림이 오면 여기에 떠요. 문자 내용과 주문을 비교해서 한 번 눌러 확인해요.'), pendBox, hist, ign);
    var none = emptyEl('확인할 입금이 없어요');
    function render() {
      var d = S.data;
      var ds = sig([d.deposit, d.orders.map(function (o) { return o.id + (o.paid ? 'p' : ''); }).join()]);
      if (ds !== S.depSig) { S.depSig = ds; loadDeposits(); }
      var auto = d.deposit ? d.deposit.autoConfirm : true;
      autoTag.className = 'tag ' + (auto ? 'ok' : 'mute'); autoTag.textContent = auto ? '자동 확인 켜짐' : '직접 확인 모드';
      SC.fill(rateBox, d.hookRateLimited ? rateBanner() : null);
      var notices = (S.deposits && S.deposits.notices) || [];
      var ignored = notices.filter(function (n) { return n.status === 'ignored'; }).sort(function (a, b) { return b.receivedAt - a.receivedAt; });
      ignSum.textContent = '무시된 알림 (' + (d.deposit && d.deposit.ignored != null ? d.deposit.ignored : ignored.length) + ')';
      SC.reconcile(ignBox, ignored.slice(0, 50), function (n) { return n.id; }, sig, function (n) {
        return h('div', { class: 'row-card' }, h('div', { class: 'grow' }, h('pre', { class: 'rawtext' }, n.text), h('span', { class: 'muted' }, SC.agoText(n.lastAt || n.receivedAt) + ' · 무시됨 (입금 아님)' + (n.repeatCount > 1 ? ' · ' + n.repeatCount + '번 수신' : ''))));
      }, emptyEl('없어요'));
      var open = notices.filter(function (n) { return n.status === 'pending' || n.status === 'unparsed' || n.status === 'review'; }).sort(function (a, b) { return b.receivedAt - a.receivedAt; });
      var done = notices.filter(function (n) { return n.status === 'matched' || n.status === 'dismissed'; }).sort(function (a, b) { return b.receivedAt - a.receivedAt; });
      SC.reconcile(pendBox, open, function (n) { return n.id; }, sig, noticeCard, none);
      histSum.textContent = '처리된 입금 (' + done.length + ')';
      SC.reconcile(histBox, done.slice(0, 50), function (n) { return n.id; }, sig, function (n) {
        var ord = n.orderId ? '→ 주문 #' + n.orderId + (n.matchedBy === 'auto' ? ' (자동)' : ' (직원)') : '';
        return h('div', { class: 'row-card' }, h('div', { class: 'grow' }, h('b', null, noticeAmount(n) + (n.depositor ? ' · ' + n.depositor : '')), h('span', { class: 'muted' }, SC.agoText(n.receivedAt) + ' · ' + (n.status === 'dismissed' ? '무시함' : '확인됨 ' + ord))));
      }, emptyEl('아직 없어요'));
    }
    return { root: root, render: render };
  }

  // =====================================================================
  // settings tab: sections are registered here, so 결제 / 테이블 / 입금 알림 can be added later
  // =====================================================================
  var SETTINGS_SECTIONS = []; // { id, title, build: () => ({ el, update(stateData) }) }
  function buildSettings() {
    var root = h('section', { 'aria-label': '설정' });
    var parts = SETTINGS_SECTIONS.map(function (sec) {
      var b = sec.build();
      root.appendChild(h('section', { class: 'set-sec', id: 'set-' + sec.id }, h('h3', { class: 'sec-title' }, sec.title), b.el));
      return b;
    });
    root.insertBefore(h('div', { class: 'view-head' }, h('h2', null, '설정')), root.firstChild);
    return { root: root, render: function () { parts.forEach(function (p) { p.update(S.data); }); } };
  }

  // ---- COMS member discount rule ----
  function buildMemberRule() {
    var DEF = { enabled: true, mode: 'percent', pct: 10, amount: 1000, minOrder: 0, maxDiscount: 0, includeAssociate: true, perMemberLimit: 20, stackWithCoupon: true };
    var st = Object.assign({}, DEF), sigv = '', dirty = false, serverOn = true;
    function numIn(label, attrs) { return h('input', Object.assign({ class: 'field', type: 'number', inputmode: 'numeric', 'aria-label': label }, attrs)); }
    var pct = numIn('할인율 (%)', { min: '0', max: '50', step: '1' });
    var amount = numIn('할인 금액 (원)', { min: '0', max: '50000', step: '100' });
    var minOrder = numIn('최소 주문 금액 (원)', { min: '0', max: '1000000', step: '100' });
    var maxDisc = numIn('최대 할인액 (원)', { min: '0', max: '1000000', step: '100' });
    var per = numIn('1인당 할인 횟수', { min: '1', max: '100', step: '1' });
    var valueLabel = h('b');
    function tgl(key, onText, offText) {
      var b = h('button', { class: 'btn al-sw', type: 'button', onclick: function () { st[key] = !st[key]; dirty = true; draw(); } });
      b.refresh = function () { b.setAttribute('aria-pressed', st[key] ? 'true' : 'false'); b.textContent = st[key] ? onText : offText; };
      return b;
    }
    var tEnabled = tgl('enabled', '사용 중', '꺼짐'), tAssoc = tgl('includeAssociate', '포함', '제외'), tStack = tgl('stackWithCoupon', '함께 사용 가능', '쿠폰이 우선');
    function modeBtn(m, text) { return h('button', { class: 'btn', type: 'button', onclick: function () { st.mode = m; dirty = true; draw(); } }, text); }
    var mPct = modeBtn('percent', '정률 (%)'), mFix = modeBtn('fixed', '정액 (원)');
    var example = h('p', { role: 'status', 'aria-live': 'polite', style: 'font-weight:900;font-size:1.05rem' });
    var err = h('p', { role: 'alert', style: 'color:var(--danger);font-weight:800;min-height:1.2em' });
    var reason = h('p', { class: 'tag warn', style: 'white-space:normal;justify-self:start' });
    var state = h('span', { class: 'tag' });
    function row(title, sub, ctl) { return h('div', { class: 'al-row' }, h('div', { class: 'al-txt' }, h('b', null, title), sub ? h('span', { class: 'muted' }, sub) : null), ctl); }
    var rowPct, rowAmt;
    var inputs = [pct, amount, minOrder, maxDisc, per];
    inputs.forEach(function (i) { i.addEventListener('input', function () { readInputs(); dirty = true; showExample(); }); });
    function readInputs() {
      st.pct = Number(pct.value); st.amount = Number(amount.value); st.minOrder = Number(minOrder.value); st.maxDiscount = Number(maxDisc.value); st.perMemberLimit = Number(per.value);
    }
    // same formula as the server
    function calc(sub) {
      if (sub < st.minOrder) return 0;
      var dsc = st.mode === 'percent' ? Math.floor(sub * st.pct / 100 / 100) * 100 : st.amount;
      if (st.maxDiscount > 0) dsc = Math.min(dsc, st.maxDiscount);
      return Math.max(0, Math.min(dsc, sub));
    }
    function showExample() {
      if (!st.enabled) { example.textContent = '회원 할인이 꺼져 있어요.'; return; }
      if (![st.pct, st.amount, st.minOrder, st.maxDiscount].every(Number.isFinite)) { example.textContent = ''; return; }
      var ex = Math.max(20000, st.minOrder), dsc = calc(ex);
      example.textContent = '예: ' + won(ex) + ' 주문 → ' + won(dsc) + ' 할인, 결제 ' + won(ex - dsc) + (st.minOrder > 0 ? ' (최소 주문 ' + won(st.minOrder) + ' 미만은 할인 없음)' : '');
    }
    function draw() {
      tEnabled.refresh(); tAssoc.refresh(); tStack.refresh();
      mPct.setAttribute('aria-pressed', st.mode === 'percent' ? 'true' : 'false'); mFix.setAttribute('aria-pressed', st.mode === 'fixed' ? 'true' : 'false');
      rowPct.hidden = st.mode !== 'percent'; rowAmt.hidden = st.mode !== 'fixed';
      state.className = 'tag ' + (!serverOn ? 'mute' : st.enabled ? 'ok' : 'warn');
      state.textContent = !serverOn ? '연동 없음' : st.enabled ? '사용 중' : '꺼짐';
      showExample();
    }
    function fill(r) {
      st = Object.assign({}, DEF, r);
      pct.value = String(st.pct); amount.value = String(st.amount); minOrder.value = String(st.minOrder); maxDisc.value = String(st.maxDiscount); per.value = String(st.perMemberLimit);
      draw();
    }
    function validate() {
      readInputs();
      var i = Number.isInteger, m100 = function (n, max) { return i(n) && n >= 0 && n <= max && n % 100 === 0; };
      if (st.mode === 'percent' && !(i(st.pct) && st.pct >= 0 && st.pct <= 50)) return MENU_ERR.bad_pct;
      if (st.mode === 'fixed' && !m100(st.amount, 50000)) return '할인 금액은 100원 단위, 0~50,000원이에요.';
      if (!m100(st.minOrder, 1000000)) return MENU_ERR.bad_min_order;
      if (!m100(st.maxDiscount, 1000000)) return MENU_ERR.bad_max_discount;
      if (!(i(st.perMemberLimit) && st.perMemberLimit >= 1 && st.perMemberLimit <= 100)) return MENU_ERR.bad_per_member_limit;
      return '';
    }
    var save = abtn('btn btn-primary', '저장', function () {
      err.textContent = validate();
      if (err.textContent) return Promise.resolve();
      var summary = (st.enabled ? (st.mode === 'percent' ? st.pct + '% 할인' : won(st.amount) + ' 할인') : '할인 끔') +
        '\n최소 주문 ' + (st.minOrder ? won(st.minOrder) : '없음') + ' · 최대 할인 ' + (st.maxDiscount ? won(st.maxDiscount) : '제한 없음') +
        '\n준회원 ' + (st.includeAssociate ? '포함' : '제외') + ' · 1인당 ' + st.perMemberLimit + '회 · 쿠폰 ' + (st.stackWithCoupon ? '함께 사용' : '우선');
      return SC.confirm({ title: '회원 할인 규칙을 저장할까요?', ok: '저장', message: summary + '\n새로 들어오는 주문부터 적용돼요. 이미 들어온 주문은 그대로예요.' }).then(function (ok) {
        if (!ok) return;
        return api('/api/staff/member-discount', { enabled: st.enabled, mode: st.mode, pct: st.pct, amount: st.amount, minOrder: st.minOrder, maxDiscount: st.maxDiscount, includeAssociate: st.includeAssociate, perMemberLimit: st.perMemberLimit, stackWithCoupon: st.stackWithCoupon })
          .then(function () { dirty = false; sigv = ''; SC.toast('회원 할인 규칙을 저장했어요', 'ok'); return refresh(); }, function (e) { err.textContent = menuMsg(e); });
      });
    });
    rowPct = row('할인율', '0~50%, 할인액은 100원 단위로 내림해요', h('div', { class: 'stockctl' }, pct, h('b', null, '%')));
    rowAmt = row('할인 금액', '100원 단위, 0~50,000원', h('div', { class: 'stockctl' }, amount, h('b', null, '원')));
    var el = h('div', { class: 'card' },
      h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, h('b', { style: 'font-size:1.15rem' }, 'COMS 사이트에 로그인한 손님'), state),
      reason,
      row('사용', 'COMS 사이트에 로그인한 손님 주문에 자동 적용돼요', tEnabled),
      row('방식', null, h('div', { class: 'al-seg' }, mPct, mFix)),
      rowPct, rowAmt,
      row('최소 주문 금액', '이 금액 미만이면 할인 없음 (0 = 제한 없음)', h('div', { class: 'stockctl' }, minOrder, h('b', null, '원'))),
      row('최대 할인액', '0 = 제한 없음', h('div', { class: 'stockctl' }, maxDisc, h('b', null, '원'))),
      row('준회원', '준회원도 할인을 받을지', tAssoc),
      row('1인당 횟수', '회원 한 명이 할인을 받을 수 있는 주문 수', h('div', { class: 'stockctl' }, per, h('b', null, '회'))),
      row('쿠폰과 함께', '끄면 쿠폰을 고른 주문에는 회원 할인이 붙지 않아요', tStack),
      example, err, save);
    var controls = [tEnabled, tAssoc, tStack, mPct, mFix, save].concat(inputs);
    function update(d) {
      serverOn = d.memberEnabled !== false;
      var rule = d.memberDiscount || { enabled: true, mode: 'percent', pct: d.memberDiscountPct || 0 };
      var s = sig(rule);
      if (s !== sigv && !dirty) { sigv = s; fill(rule); } else draw();
      reason.hidden = serverOn; reason.textContent = serverOn ? '' : '서버에 COMS 연동이 설정되지 않았어요. 연동 후에 쓸 수 있어요.';
      controls.forEach(function (c) { c.disabled = !serverOn; });
    }
    return { el: el, update: update };
  }
  // ---- shared settings helpers ----
  function srow(title, sub, ctl) { return h('div', { class: 'al-row' }, h('div', { class: 'al-txt' }, h('b', null, title), sub ? h('span', { class: 'muted' }, sub) : null), ctl); }
  function fieldIn(label, attrs) { return h('input', Object.assign({ class: 'field', 'aria-label': label }, attrs)); }
  function swBtn(getter, setter, onText, offText) {
    var b = h('button', { class: 'btn al-sw', type: 'button', onclick: function () { setter(!getter()); b.refresh(); } });
    b.refresh = function () { b.setAttribute('aria-pressed', getter() ? 'true' : 'false'); b.textContent = getter() ? onText : offText; };
    b.refresh();
    return b;
  }

  // ---- 테이블 ----
  function buildTablesSection() {
    var cur = 0, dirty = false;
    var num = fieldIn('테이블 수', { type: 'number', inputmode: 'numeric', min: '1', max: '50', step: '1' });
    num.addEventListener('input', function () { dirty = true; });
    function nudge(dlt) { num.value = String(Math.max(1, Math.min(50, (parseInt(num.value, 10) || cur) + dlt))); dirty = true; }
    var info = h('p', { class: 'muted' });
    var apply = abtn('btn btn-primary', '적용', function () {
      var n = Number(num.value);
      if (!Number.isInteger(n) || n < 1 || n > 50) { SC.toast(MENU_ERR.bad_count, 'error'); return Promise.resolve(); }
      if (n === cur) { SC.toast('이미 ' + n + '개예요.'); return Promise.resolve(); }
      var msg = n < cur
        ? (n + 1) + '번 이상 테이블은 주문할 수 없게 돼요. 다시 늘리면 같은 QR을 그대로 쓸 수 있어요.'
        : '새 테이블 ' + (cur + 1) + '~' + n + '번이 생겨요. QR 인쇄 화면에서 새 QR 카드를 뽑아 주세요.';
      function send(force) {
        return api('/api/staff/tables/count', force ? { count: n, force: true } : { count: n }).then(function () { dirty = false; SC.toast('테이블을 ' + n + '개로 바꿨어요', 'ok'); return refresh(); }, function (e) {
          if (e.code === 'unsettled' && !force) {
            var list = (e.data.tables || []).map(function (t) { return t + '번'; }).join(', ');
            return SC.confirm({ title: '정산이 안 끝난 테이블이 있어요', danger: true, ok: '그래도 줄이기', cancel: '돌아가기', message: list + ' 테이블에 아직 입금 전이거나 서빙 전인 주문이 있어요.\n그래도 줄이면 그 테이블 손님은 더 이상 주문할 수 없어요.' }).then(function (ok) { if (ok) return send(true); });
          }
          throw new Error(menuMsg(e));
        });
      }
      return SC.confirm({ title: '테이블을 ' + n + '개로 바꿀까요?', danger: n < cur, ok: '바꾸기', message: cur + '개 → ' + n + '개\n' + msg }).then(function (ok) { if (ok) return send(false); });
    });
    var warnBox = h('div');
    var el = h('div', { class: 'card' }, info, warnBox,
      srow('테이블 수', '1~50개', h('div', { class: 'stockctl' }, h('button', { class: 'btn', type: 'button', 'aria-label': '하나 줄이기', onclick: function () { nudge(-1); } }, '−'), num, h('button', { class: 'btn', type: 'button', 'aria-label': '하나 늘리기', onclick: function () { nudge(1); } }, '+'), apply)),
      h('p', { class: 'muted' }, '줄인 테이블의 QR은 잠시 쓸 수 없고, 다시 늘리면 같은 QR이 되살아나요. 한 테이블의 QR만 새로 만들고 싶으면 QR 인쇄 화면에서 "QR 재발급"을 쓰세요.'),
      h('a', { class: 'btn', href: SC.BASE + '/staff/qr' }, 'QR 인쇄 화면으로'));
    function update(d) {
      var n = d.tableCount || d.tables.length;
      if (n !== cur) { cur = n; if (!dirty || !num.value) num.value = String(n); }
      info.textContent = '지금 테이블 ' + cur + '개';
      var hid = d.hiddenTablesWithOpenOrders || [];
      SC.fill(warnBox, hid.length ? h('div', { class: 'banner warn', role: 'alert' }, h('span', null, hiddenTablesText(hid)),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: function () { num.value = String(Math.min(50, Math.max.apply(null, hid))); dirty = true; num.focus(); SC.toast('테이블 수를 ' + num.value + '개로 맞췄어요. 적용을 눌러 주세요.'); } }, Math.max.apply(null, hid) + '개로 늘리기')) : null);
    }
    return { el: el, update: update };
  }
  SETTINGS_SECTIONS.push({ id: 'tables', title: '테이블', build: buildTablesSection });

  // ---- 결제 ----
  function groupDigits(v) { var d = String(v).replace(/[^0-9]/g, ''); return d.replace(/(\d{4})(?=\d)/g, '$1 ').trim(); }
  function buildPaySection() {
    var pay = {}, sigv = '', dirty = false, tossOn = false, reqDep = false;
    var bank = fieldIn('은행', { type: 'text', maxlength: '20', autocomplete: 'off' });
    var account = fieldIn('계좌번호', { type: 'text', inputmode: 'numeric', maxlength: '24', autocomplete: 'off', placeholder: '110-123-456789' });
    var account2 = fieldIn('계좌번호 다시 입력', { type: 'text', inputmode: 'numeric', maxlength: '24', autocomplete: 'off', placeholder: '한 번 더 입력' });
    var holder = fieldIn('예금주', { type: 'text', maxlength: '20', autocomplete: 'off' });
    var kakao = fieldIn('카카오페이 송금 링크', { type: 'url', inputmode: 'url', maxlength: '200', autocomplete: 'off', placeholder: 'https://qr.kakaopay.com/...' });
    var grouped = h('output', { class: 'num', style: 'font-weight:900;letter-spacing:.04em', 'aria-live': 'polite' });
    var kakaoMsg = h('p', { role: 'status', style: 'font-weight:800;min-height:1.2em' });
    var confirmRow = h('label', { class: 'lab' }, '계좌번호 다시 입력 (은행·계좌·예금주를 바꿀 때 필수)', account2);
    var err = h('p', { role: 'alert', style: 'color:var(--danger);font-weight:800;min-height:1.2em' });
    var prev = h('div', { class: 'pay-prev' });
    var changed = h('p', { class: 'muted' });
    var KAKAO_RE = /^https:\/\/qr\.kakaopay\.com\/\S+$/;
    function accountOk(a) { return /^\d+(-\d+)*$/.test(a) && a.replace(/-/g, '').length >= 8 && a.replace(/-/g, '').length <= 20; }
    function checkKakao() {
      var v = kakao.value.trim();
      if (!v) { kakaoMsg.textContent = ''; return true; }
      var ok = KAKAO_RE.test(v) && v.length <= 200;
      kakaoMsg.textContent = ok ? '✓ 올바른 카카오페이 링크예요' : '! https://qr.kakaopay.com/ 로 시작하는 링크만 쓸 수 있어요';
      kakaoMsg.style.color = ok ? 'var(--success)' : 'var(--danger)';
      return ok;
    }
    function acctChanged() { return bank.value.trim() !== (pay.bank || '') || account.value.trim() !== (pay.account || '') || holder.value.trim() !== (pay.holder || ''); }
    function drawPrev() {
      grouped.textContent = groupDigits(account.value);
      confirmRow.hidden = !acctChanged();
      var b = bank.value.trim(), a = account.value.trim(), ho = holder.value.trim();
      SC.fill(prev, h('b', null, '손님 결제 화면 미리보기'),
        h('div', { class: 'pay-card' },
          h('div', { class: 'muted' }, '입금 계좌'),
          h('div', { style: 'font-size:1.2rem;font-weight:900' }, (b || '은행') + ' ' + (a || '계좌번호')),
          h('div', null, '예금주 ' + (ho || '-')),
          h('div', { class: 'al-seg', style: 'margin-top:8px' },
            h('span', { class: 'btn btn-sm', 'aria-hidden': 'true' }, '계좌 복사'),
            tossOn ? h('span', { class: 'btn btn-sm btn-primary', 'aria-hidden': 'true' }, '토스로 송금') : null,
            KAKAO_RE.test(kakao.value.trim()) ? h('span', { class: 'btn btn-sm', 'aria-hidden': 'true' }, '카카오페이로 보내기') : null),
          reqDep ? h('div', { class: 'tag warn', style: 'margin-top:8px' }, '주문할 때 입금자명을 꼭 적어야 해요') : null));
    }
    [bank, account, account2, holder, kakao].forEach(function (i) { i.addEventListener('input', function () { dirty = true; checkKakao(); drawPrev(); }); });
    var tToss = swBtn(function () { return tossOn; }, function (v) { tossOn = v; dirty = true; drawPrev(); }, '사용 중', '꺼짐');
    var tReq = swBtn(function () { return reqDep; }, function (v) { reqDep = v; dirty = true; drawPrev(); }, '필수', '선택');
    var save = abtn('btn btn-primary', '저장', function () {
      err.textContent = '';
      var b = bank.value.trim(), a = account.value.trim(), ho = holder.value.trim(), k = kakao.value.trim();
      if (b.length < 1 || b.length > 20) { err.textContent = MENU_ERR.bad_bank; return Promise.resolve(); }
      if (!accountOk(a)) { err.textContent = MENU_ERR.bad_account; return Promise.resolve(); }
      if (ho.length < 1 || ho.length > 20) { err.textContent = MENU_ERR.bad_holder; return Promise.resolve(); }
      if (k && !checkKakao()) { err.textContent = MENU_ERR.bad_kakao_url; return Promise.resolve(); }
      var body = {};
      if (b !== (pay.bank || '')) body.bank = b;
      if (a !== (pay.account || '')) body.account = a;
      if (ho !== (pay.holder || '')) body.holder = ho;
      if (acctChanged()) {
        if (account2.value.trim().replace(/-/g, '') !== a.replace(/-/g, '')) { err.textContent = MENU_ERR.account_mismatch; return Promise.resolve(); }
        body.confirmAccount = account2.value.trim();
      }
      if (tossOn !== !!pay.tossEnabled) body.tossEnabled = tossOn;
      if (k !== (pay.kakaoPayUrl || '')) body.kakaoPayUrl = k;
      if (reqDep !== !!pay.requireDepositor) body.requireDepositor = reqDep;
      if (!Object.keys(body).filter(function (x) { return x !== 'confirmAccount'; }).length) { SC.toast('바뀐 내용이 없어요.'); return Promise.resolve(); }
      var lines = [];
      if (acctChanged()) lines.push('입금 계좌: ' + b + ' ' + a + ' (' + ho + ')');
      if ('tossEnabled' in body) lines.push('토스 송금 버튼: ' + (tossOn ? '사용' : '끔'));
      if ('kakaoPayUrl' in body) lines.push('카카오페이 링크: ' + (k || '지움'));
      if ('requireDepositor' in body) lines.push('입금자명: ' + (reqDep ? '필수' : '선택'));
      return SC.confirm({ title: '결제 설정을 저장할까요?', danger: acctChanged(), ok: '저장', message: lines.join('\n') + (acctChanged() ? '\n입금 계좌가 바뀌면 손님이 바로 새 계좌를 보게 돼요. 한 번 더 확인해 주세요.' : '') }).then(function (ok) {
        if (!ok) return;
        return api('/api/staff/pay', body).then(function () { dirty = false; sigv = ''; account2.value = ''; SC.toast('결제 설정을 저장했어요', 'ok'); return refresh(); }, function (e) { err.textContent = menuMsg(e); });
      });
    });
    var el = h('div', { class: 'card' },
      h('label', { class: 'lab' }, '은행', bank),
      h('label', { class: 'lab' }, '계좌번호 (숫자와 -)', account, grouped),
      confirmRow,
      h('label', { class: 'lab' }, '예금주', holder),
      srow('토스 송금 버튼', '손님 화면에 토스로 바로 송금하는 버튼을 보여줘요', tToss),
      h('div', { class: 'lab' }, h('label', null, '카카오페이 송금 링크 (선택)', kakao), kakaoMsg, h('span', { class: 'muted' }, '카카오페이 앱 → 송금 → 코드 → 링크 복사. 비워 두면 버튼이 없어요.')),
      srow('입금자명', '켜면 손님이 주문할 때 입금자명을 꼭 적어야 해요 (입금 자동 확인에 쓰여요)', tReq),
      prev, changed, err, save);
    function update(d) {
      pay = d.pay || {};
      var s = sig(pay);
      if (s !== sigv && !dirty) {
        sigv = s; bank.value = pay.bank || ''; account.value = pay.account || ''; holder.value = pay.holder || ''; account2.value = '';
        kakao.value = pay.kakaoPayUrl || ''; tossOn = !!pay.tossEnabled; reqDep = !!pay.requireDepositor; tToss.refresh(); tReq.refresh(); checkKakao();
      }
      changed.textContent = pay.changedAt ? '계좌 마지막 변경: ' + new Date(pay.changedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false }) : '';
      drawPrev();
    }
    return { el: el, update: update };
  }
  SETTINGS_SECTIONS.push({ id: 'pay', title: '결제', build: buildPaySection });

  // ---- 입금 알림 연동 ----
  function buildHookSection() {
    var hook = null, shown = false;
    var url = h('input', { class: 'field', type: 'text', readonly: true, 'aria-label': '입금 알림 주소', value: '' });
    var reveal = h('button', { class: 'btn', type: 'button', onclick: function () { shown = !shown; if (shown && !hook) loadHook().then(draw); else draw(); } }, '보기');
    var copyBtn = h('button', { class: 'btn', type: 'button', onclick: function () { loadHook().then(function () { copyText(fullUrl()).then(function (ok) { SC.toast(ok ? '주소를 복사했어요' : '복사하지 못했어요. 주소를 보기로 열어 직접 복사해 주세요.', ok ? 'ok' : 'error'); }); }); } }, '복사');
    var rotate = abtn('btn btn-danger', '주소 재발급', function () {
      return SC.confirm({ title: '주소를 새로 만들까요?', danger: true, ok: '재발급', message: '기존 주소는 바로 쓸 수 없게 돼요. 입금 알림을 보내는 앱의 주소도 새 주소로 바꿔야 해요.' }).then(function (ok) {
        if (!ok) return;
        return api('/api/staff/deposit-hook/rotate').then(function (r) { hook = r; SC.toast('새 주소를 만들었어요. 알림 앱의 주소를 바꿔 주세요.', 'ok'); draw(); }, function (e) { throw new Error(menuMsg(e)); });
      });
    });
    function fullUrl() { return hook ? new URL(hook.url, location.origin).href : ''; }
    function loadHook() { return hook ? Promise.resolve(hook) : SC.api('/api/staff/deposit-hook').then(function (r) { hook = r; return r; }, function (e) { SC.toast(menuMsg(e), 'error'); }); }
    function copyText(t) {
      if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(t).then(function () { return true; }, function () { return false; });
      var ta = h('textarea', { style: 'position:fixed;left:-999px' }); ta.value = t; document.body.appendChild(ta); ta.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove(); return Promise.resolve(ok);
    }
    function draw() {
      url.type = shown ? 'text' : 'password'; url.value = hook ? fullUrl() : ''; reveal.textContent = shown ? '숨기기' : '보기';
      hdrVal.type = shown ? 'text' : 'password'; hdrVal.value = hook ? hook.secret : '';
      hdrUrl.value = hook && hook.headerUrl ? new URL(hook.headerUrl, location.origin).href : ''; hdrName.value = (hook && hook.header) || 'X-Booth-Hook';
    }
    var autoState = { v: true }, maxDirty = false;
    var maxIn = h('input', { class: 'field', type: 'number', inputmode: 'numeric', min: '0', max: '1000000', step: '1000', 'aria-label': '자동 확인 최대 금액 (원)' });
    maxIn.addEventListener('input', function () { maxDirty = true; });
    var maxSave = abtn('btn btn-sm btn-primary', '저장', function () {
      var n = Number(maxIn.value);
      if (maxIn.value.trim() === '' || !Number.isInteger(n) || n < 0 || n > 1000000) { SC.toast(MENU_ERR.bad_auto_max, 'error'); return Promise.resolve(); }
      return api('/api/staff/deposits/autoconfirm', { autoConfirmMaxAmount: n }).then(function () { maxDirty = false; SC.toast('자동 확인 최대 금액을 ' + won(n) + '으로 바꿨어요', 'ok'); return refresh(); }, function (e) { throw new Error(menuMsg(e)); });
    });
    function setAuto(v) {
      autoState.v = v;
      tAuto.refresh();
      api('/api/staff/deposits/autoconfirm', { autoConfirm: v }).then(refresh, function (e) { autoState.v = !v; tAuto.refresh(); menuFail(e); });
    }
    var tAuto = swBtn(function () { return autoState.v; }, function (v) {
      if (!v) { setAuto(false); return; }
      SC.confirm({ title: '자동 확인을 켤까요?', danger: true, ok: '그래도 켜기', cancel: '끈 채로 두기',
        message: '입금 문자의 이름 칸은 보내는 사람이 마음대로 적을 수 있어요. 자동 확인을 켜면 문자 내용만으로 입금 처리되므로, 금액을 속인 문자가 걸러지지 않을 가능성이 있습니다. 끈 상태에서도 입금 탭에서 한 번만 눌러 확인할 수 있어요. 그래도 켤까요?' })
        .then(function (ok) { if (ok) setAuto(true); });
    }, '켜짐', '꺼짐');
    // test sender
    var sample = h('textarea', { class: 'field', rows: '3', maxlength: '500', 'aria-label': '테스트 입금 문자', placeholder: '[입금] 18,000원 홍길동 11/13 21:03', style: 'min-height:84px;padding:10px' });
    var result = h('div', { role: 'status', 'aria-live': 'polite', class: 'test-result' });
    var send = abtn('btn', '테스트 보내기', function () {
      var t = sample.value.trim();
      if (!t) { SC.fill(result, h('p', null, '확인해 볼 문자 내용을 적어 주세요.')); return Promise.resolve(); }
      return api('/api/staff/deposit-hook/test', { text: t }).then(function (r) {
        var p = r.parsed || {}, m = r.wouldMatch || {};
        var kindText = { deposit: '입금 문자', review: '취소·정정 단어가 들어 있는 문자', ignored: '입금이 아닌 문자', unparsed: '읽지 못한 문자' }[p.kind] || String(p.kind || '');
        var status = { matched: '자동으로 주문과 맞춰 입금 확인됨', pending: '확인 대기 (입금 탭에서 한 번 눌러 확인)', review: '확인 대기 · 취소/정정 단어 때문에 강제 확인만 가능', unparsed: '읽지 못해 확인 대기', ignored: '입금이 아니라서 무시', duplicate: '방금 들어온 같은 문자라서 버려짐' }[m.status] || String(m.status || '');
        var cands = (m.candidates || []).map(function (c) { return c.table + '번 ' + won(c.total) + (c.depositor ? ' (' + c.depositor + ')' : ''); });
        var handled = (m.handledOrders || []).map(function (c) { return c.table + '번 ' + won(c.total); });
        SC.fill(result,
          h('p', { class: 'tag ok', style: 'white-space:normal' }, '실제로 저장되거나 입금 처리되지 않아요. 읽는 모습만 보여 줘요.'),
          h('ul', null,
            h('li', null, '종류: ' + kindText),
            h('li', null, '읽은 금액: ' + (p.amount != null ? won(p.amount) : '없음')),
            h('li', null, '읽은 입금자명: ' + (p.name || '없음')),
            h('li', null, '자동 확인 후보로 쓸 수 있는 문자인가요? ' + (p.autoEligible ? '예' : '아니요')),
            (p.reasons && p.reasons.length) ? h('li', null, '문자 쪽 이유: ' + reasonList(p.reasons).join(' / ')) : null,
            h('li', null, '실제로 들어오면: ' + status + (m.orderId ? ' → 주문 #' + m.orderId : '')),
            (m.reasons && m.reasons.length) ? h('li', null, '자동 확인 안 되는 이유: ' + reasonList(m.reasons, { depositor: p.name }, m.candidates).join(' / ')) : null,
            cands.length ? h('li', null, '금액이 같은 미입금 주문: ' + cands.join(', ')) : null,
            handled.length ? h('li', null, '이미 손으로 확인한 같은 금액 주문: ' + handled.join(', ')) : null));
      }, function (e) { SC.fill(result, h('p', { style: 'color:var(--danger);font-weight:800' }, menuMsg(e))); });
    });
    var guide = h('div', { class: 'guide' },
      h('p', { class: 'muted' }, '은행 앱에서 입금 문자 알림(SMS)을 받도록 설정돼 있어야 해요. 자동 확인을 켜도 한 줄짜리 은행 문자는 자동으로 확인하지 않고 "입금" 탭에 남겨요.'),
      h('details', null, h('summary', null, '안드로이드: 문자 전달 앱 쓰기'),
        h('ol', null,
          h('li', null, '"SMS Forwarder" 같은 문자/알림 전달 앱을 설치해요. (비밀번호·카드 정보를 보내는 앱은 쓰지 마세요)'),
          h('li', null, '앱이 사용자 지정 헤더를 지원하면 위의 "헤더 방식"(주소 + X-Booth-Hook 헤더)을 쓰는 게 더 안전해요. 지원하지 않으면 전달 주소(웹훅)에 "입금 알림 주소"를 붙여 넣어요. 방식은 POST.'),
          h('li', null, '본문은 JSON {"text":"문자 내용"} 으로 보내거나, 문자 내용만 그대로 보내도 돼요.'),
          h('li', null, '필터: 보낸 사람이 은행 번호이고 내용에 "입금"이 있을 때만 전달해요.'),
          h('li', null, '아래 "테스트 보내기"로 문자 예시를 보내 읽는 모습을 확인해요.'))),
      h('details', null, h('summary', null, '아이폰: 단축어 자동화'),
        h('ol', null,
          h('li', null, '단축어 앱 → 자동화 → 새 자동화 → "메시지"를 고르세요.'),
          h('li', null, '보낸 사람(은행) 또는 메시지에 "입금"이 포함될 때 → "즉시 실행"으로 설정해요.'),
          h('li', null, '동작 추가: "URL 콘텐츠 가져오기" → URL에 위 주소, 방법 POST, 요청 본문은 "파일/텍스트"로 메시지 내용을 넣어요. "헤더"를 추가할 수 있으면 X-Booth-Hook 헤더 방식을 쓰세요.'),
          h('li', null, '"실행 전에 묻기"를 끄면 입금 때마다 자동으로 전달돼요.'))));
    var hrateBox = h('div');
    var hdrUrl = h('input', { class: 'field', type: 'text', readonly: true, 'aria-label': '헤더 방식 주소', value: '' });
    var hdrName = h('input', { class: 'field', type: 'text', readonly: true, 'aria-label': '헤더 이름', value: 'X-Booth-Hook' });
    var hdrVal = h('input', { class: 'field', type: 'password', readonly: true, 'aria-label': '헤더 값', value: '' });
    function copyBtnFor(getter, label) { return h('button', { class: 'btn btn-sm', type: 'button', onclick: function () { loadHook().then(function () { copyText(getter()).then(function (ok) { SC.toast(ok ? label + ' 복사했어요' : '복사하지 못했어요. 직접 선택해서 복사해 주세요.', ok ? 'ok' : 'error'); }); }); } }, label + ' 복사'); }
    var headerBox = h('div', { class: 'lab' }, h('b', null, '헤더 방식 (권장)'), h('span', { class: 'muted' }, '비밀 값이 주소에 남지 않아서 더 안전해요. 문자 전달 앱이 사용자 지정 헤더를 지원하면 이 방식을 쓰세요.'),
      '주소', hdrUrl, '헤더 이름', hdrName, '헤더 값 (비밀)', hdrVal,
      h('div', { class: 'al-seg' }, copyBtnFor(function () { return new URL(hook.headerUrl, location.origin).href; }, '주소'), copyBtnFor(function () { return hook.header || 'X-Booth-Hook'; }, '헤더 이름'), copyBtnFor(function () { return hook.secret; }, '헤더 값')));
    var el = h('div', { class: 'card' }, hrateBox,
      srow('입금 자동 확인 (기본: 꺼짐)', '꺼져 있어도 "입금" 탭에서 한 번만 누르면 확인돼요. 켜기 전에 경고를 꼭 읽어 주세요.', tAuto),
      h('p', { class: 'tag warn', style: 'white-space:normal' }, '같은 금액의 미입금 주문이 하나뿐이고, 입금자명이 주문에 적힌 이름과 같을 때만 자동으로 확인돼요. 그 밖에는 여기서 한 번 눌러 확인합니다.'),
      srow('자동 확인 최대 금액', '이 금액을 넘는 입금은 자동으로 확인하지 않아요 (0 = 자동 확인 안 함)', h('div', { class: 'stockctl' }, maxIn, h('b', null, '원'), maxSave)),
      h('div', { class: 'lab' }, '입금 알림 주소 (비밀 주소예요. 남에게 보이지 마세요)', url, h('div', { class: 'al-seg' }, reveal, copyBtn, rotate)),
      headerBox, guide,
      h('div', { class: 'lab' }, '테스트 보내기', sample, send, result));
    draw();
    function update(d) { autoState.v = d.deposit ? d.deposit.autoConfirm !== false : true; tAuto.refresh(); if (!maxDirty && d.deposit && d.deposit.autoConfirmMaxAmount != null) maxIn.value = String(d.deposit.autoConfirmMaxAmount); SC.fill(hrateBox, d.hookRateLimited ? rateBanner() : null); }
    return { el: el, update: update };
  }
  SETTINGS_SECTIONS.push({ id: 'hook', title: '입금 알림 연동', build: buildHookSection });

  SETTINGS_SECTIONS.push({ id: 'member', title: '회원 할인', build: buildMemberRule });
  // future sections: SETTINGS_SECTIONS.push({ id: 'pay', title: '결제', build: ... }) (테이블, 입금 알림 ...)

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
  gate = SC.gate({ app: $('#app'), start: startApp, stop: stopApp, where: '스태프' });
})();

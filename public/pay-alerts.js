/* Payment alerts shared by the staff and kitchen pages (window.PW):
   - arrival banner when a bank notice needs staff (one-tap confirm for a recommended candidate)
   - "입금 확인" banner / toast when any order or cover share becomes paid (diffed from the payment ledger ids)
   Nothing is announced for data that is already there when the page loads or after a reconnect.
   All text goes through textContent (SC.h). */
(function () {
  'use strict';
  var SC = window.SC, h = SC.h, won = SC.won;
  var PW = window.PW = {};
  SC.prefs.defaults({ alertDeposit: true, alertPaid: true, kPaidOnly: false });

  PW.state = null;
  PW.mode = 'staff';            // 'kitchen': compact toast for confirmations
  PW.refresh = function () { return Promise.resolve(); };   // set by the page: reload state
  PW.openDeposits = function () { location.href = SC.BASE + '/staff#deposits'; };
  PW.onChange = null;           // kitchen: re-render cards when paid info changes
  var seenNotice = null, arr = {}, okList = [], dismissed = {};
  var wrap = PW.el = h('div', { class: 'pw-wrap', 'aria-live': 'polite' });
  var depBox = h('div', { class: 'pw-dep' }), okBox = h('div', { class: 'pw-ok' });
  wrap.append(depBox, okBox);

  function coverLabel(d) { return SC.safeText((d && d.cover && d.cover.label) || '입장료', 10) || '입장료'; }
  function isTest(o) { return !!(o && (o.test || o.table === 0)); }
  function tableName(o) { return isTest(o) ? '테스트' : o.table + '번 테이블'; }
  function amountText(n) { return n.amount != null ? (n.amountGuessed ? '추정 ' : '') + won(n.amount) : '금액 읽기 실패'; }
  function openStatus(n) { return n.status === 'pending' || n.status === 'unparsed' || n.status === 'review'; }
  // a guessed amount or any parse / match reason (auto_off alone is the normal "auto-confirm is off" state)
  function needsCheck(n) { return !!n.amountGuessed || (n.reasons || []).some(function (r) { return r !== 'auto_off'; }); }

  // One-tap confirm is offered ONLY when the server says oneTap === true (never derived from recommended / names / candidates).
  // A missing field fails safe: no one-tap.
  function recOf(n) {
    if (!n || n.status !== 'pending' || n.oneTap !== true || needsCheck(n)) return null;
    return (n.candidates || []).filter(function (x) { return x.recommended; })[0] || null;
  }
  PW.recOf = recOf; PW.needsCheck = needsCheck;

  // ---------------------------------------------------------------- arrival banners
  // untrusted names go in a bordered chip (SC.nameChip: sanitised, <= 12 chars) so they cannot pass as the app's own words
  function bannerParts(n, rec, d) {
    var who = n.depositor || '이름 없음';
    if (rec && rec.intent) return [rec.table + '번 테이블 · ' + coverLabel(d) + ' ' + rec.intent.shares + '명분 · ' + amountText(n) + ' · ', SC.nameChip(rec.intent.payer || who)];
    if (rec) return [rec.table + '번 테이블 입금 문자 도착 · ' + (n.amount != null ? won(n.amount) : amountText(n)) + ' · ', SC.nameChip(who)];
    if (needsCheck(n)) return ['입금 문자 도착 · 금액 확인 필요 · ', SC.nameChip(who)];
    return ['입금 문자 도착 · ' + amountText(n) + ' · ', SC.nameChip(who), ' · 주문을 골라 주세요'];
  }
  function openNotice(n) { dismissed[n.id] = true; renderDep(); PW.openDeposits(n.id); }
  // Never retried: any refusal (amount_guessed, intent_stale, stale, ...) sends staff to the 입금 tab with the server's message.
  function confirmOne(n, rec) {
    var body = { orderId: rec.id };
    if (rec.intent) body.intentId = rec.intent.id;
    return SC.api('/api/staff/deposits/' + n.id + '/assign', { body: body }).then(function () {
      dismissed[n.id] = true; delete arr[n.id]; renderDep();
      return PW.refresh();
    }, function (e) {
      SC.toast(SC.safeText(SC.errText ? SC.errText(e) : e.message, 120), 'error', 8000);
      PW.refresh();
      dismissed[n.id] = true; renderDep();
      PW.openDeposits(n.id);
    });
  }
  // re-check at tap time: the notice must still be one-tap and the same candidate as shown
  function tapConfirm(n, rec) {
    var cur = ((PW.state && PW.state.depositNotices) || []).filter(function (x) { return x.id === n.id; })[0], r2 = recOf(cur);
    if (!r2 || r2.id !== rec.id || (r2.intent ? r2.intent.id : null) !== (rec.intent ? rec.intent.id : null)) { SC.toast('입금 정보가 바뀌었어요. 입금 탭에서 확인해 주세요.', 'error', 6000); openNotice(n); return Promise.resolve(); }
    return confirmOne(n, rec);
  }
  function later(n) { dismissed[n.id] = true; renderDep(); }
  function renderDep() {
    var d = PW.state; if (!d) { SC.fill(depBox); return; }
    var open = {}; (d.depositNotices || []).forEach(function (n) { if (openStatus(n)) open[n.id] = n; });
    var items = Object.keys(arr).map(function (id) { return open[id]; }).filter(function (n) { return n && !dismissed[n.id]; }).sort(function (a, b) { return (b.lastAt || b.receivedAt) - (a.lastAt || a.receivedAt); });
    var shown = items.slice(0, 3);
    SC.fill(depBox, shown.map(function (n) {
      var rec = recOf(n);
      var chk = !rec && needsCheck(n);
      var b = h('div', { class: 'pw-banner dep' + (rec ? ' rec' : ''), role: 'alert', dataset: { nid: n.id } },
        h('div', { class: 'pw-txt' }, h('b', null, bannerParts(n, rec, d)), n.repeatCount > 1 ? h('span', { class: 'pw-sub' }, '같은 문자가 ' + n.repeatCount + '번 왔어요') : null, !rec && !chk && (n.reasons || []).indexOf('several_candidates') >= 0 ? h('span', { class: 'pw-sub' }, '같은 금액 후보가 여러 개라 직접 골라야 해요') : null, chk ? h('span', { class: 'pw-sub' }, '문자의 금액을 믿을 수 없어요. 은행 앱에서 확인해 주세요') : null),
        h('div', { class: 'pw-btns' },
          rec ? h('button', { class: 'btn btn-primary', type: 'button', onclick: function (e) { var el = e.currentTarget; if (el.disabled) return; el.disabled = true; tapConfirm(n, rec).then(function () { el.disabled = false; }); } }, '입금 확인')
            : h('button', { class: 'btn btn-primary', type: 'button', onclick: function () { openNotice(n); } }, chk ? '확인하러 가기' : '주문 고르기'),
          h('button', { class: 'btn', type: 'button', onclick: function () { later(n); } }, '나중에')));
      return b;
    }), items.length > 3 ? h('button', { class: 'pw-more', type: 'button', onclick: function () { PW.openDeposits(); } }, '외 ' + (items.length - 3) + '건 · 입금 탭에서 보기') : null);
  }
  function announceArrival(n, d) {
    if (SC.prefs.get('alertDeposit')) SC.attention('deposit'); else SC.flash();
    var rec = recOf(n);
    if (SC.prefs.get('alertDeposit')) SC.notif.show('입금 문자 도착', (rec ? rec.table + '번 테이블 · ' : '') + (!rec && needsCheck(n) ? '금액 확인 필요' : amountText(n)) + ' · [' + (SC.safeText(n.depositor, 12) || '이름 없음') + ']', 'dep-' + n.id + '-' + (n.repeatCount || 1));
  }
  // hint from SSE: refresh state; a repeated text re-alerts
  PW.hintDeposit = function (ev) {
    if (!ev || ev.id == null) return;
    if (seenNotice && seenNotice[ev.id]) { delete dismissed[ev.id]; arr[ev.id] = { announced: false, at: Date.now() }; }
    PW.refresh();
  };

  // ---------------------------------------------------------------- payment confirmed (live SSE hints only; never replayed)
  var queue = [], flushT = 0, recentHints = [], okSeq = 0;
  function msgFor(d, h0, o) {
    var tn = h0.test ? '테스트' : h0.table + '번 테이블', amt = h0.amount;
    if (h0.kind === 'cover') {
      var lab = coverLabel(d);
      if (h0.shares) return tn + ' ' + lab + ' ' + h0.shares + '명분 입금 확인 · ' + won(amt);
      return o && !o.paid ? tn + ' ' + lab + ' ' + won(amt) + ' 입금 · 잔액 ' + won(o.balanceDue || 0) : tn + ' ' + lab + ' 입금 확인 · ' + won(amt);
    }
    if (o) return o.paid ? tn + ' 입금 확인 · ' + won(o.total) : tn + ' ' + won(amt) + ' 입금 · 잔액 ' + won(o.balanceDue || 0);
    return tn + ' 입금 확인 · ' + won(amt);
  }
  PW.hintPayment = function (ev) {
    if (!ev || ev.orderId == null) return;
    if (ev.test && !SC.testSound()) return;
    recentHints.push({ orderId: ev.orderId, amount: ev.amount, method: ev.method, auto: !!ev.auto, at: Date.now() });
    if (recentHints.length > 30) recentHints.shift();
    queue.push(ev);
    clearTimeout(flushT);
    flushT = setTimeout(function () { var q = queue; queue = []; Promise.resolve(PW.refresh()).then(function () { flushPaid(q); }, function () { flushPaid(q); }); }, 300);
  };
  // "자동 / 직원" for the recent strip: from the live hint when we saw it, else inferred from the order
  PW.autoFor = function (o, p) {
    var hit = recentHints.filter(function (x) { return x.orderId === o.id && x.amount === p.amount && x.method === p.method; }).pop();
    if (hit) return hit.auto;
    return o.paidBy === 'auto' && p.method === 'transfer';
  };
  function flushPaid(list) {
    var d = PW.state; if (!d) return;
    // one row per payment, but one alert per order and burst (an intent excess is a second row of the same notice)
    var groups = {};
    list.forEach(function (ev) { var g = groups[ev.orderId]; if (!g) g = groups[ev.orderId] = { ev: Object.assign({}, ev), n: 0 }; else { g.ev.amount += ev.amount; if (ev.shares) g.ev.shares = (g.ev.shares || 0) + ev.shares; } g.n++; });
    var items = Object.keys(groups).map(function (k) { var ev = groups[k].ev, o = (d.orders || []).filter(function (x) { return x.id === ev.orderId; })[0]; return { msg: msgFor(d, ev, o), key: ev.orderId + '-' + Date.now() }; });
    announce(items, true);
  }
  PW.hintVoid = function (ev) {
    if (!ev || (ev.test && !SC.testSound())) return;
    var msg = (ev.test ? '테스트' : ev.table + '번 테이블') + ' 결제 1건 취소 · ' + won(ev.amount);
    SC.toast(msg, 'info', 5000);
    PW.refresh();
  };
  function announce(items, positive) {
    items.forEach(function (it) {
      if (PW.mode === 'kitchen') SC.toast(it.msg, 'ok', 5000);
      else {
        var id = ++okSeq, el = h('div', { class: 'pw-banner ok', role: 'status', dataset: { ok: id } }, h('b', null, it.msg), h('button', { class: 'pw-x', type: 'button', 'aria-label': '닫기', onclick: function () { drop(id); } }, '×'));
        okList.push({ id: id, el: el }); setTimeout(function () { drop(id); }, 9000);
      }
      if (SC.prefs.get('alertPaid')) SC.notif.show('입금 확인', it.msg, 'paid-' + it.key);
    });
    if (items.length && SC.prefs.get('alertPaid')) { SC.audio.beep('paid'); SC.flash(); }
    renderOk();
  }
  function drop(id) { okList = okList.filter(function (x) { return x.id !== id; }); renderOk(); }
  function renderOk() {
    if (okList.length > 3) okList = okList.slice(-3);
    SC.fill(okBox, okList.map(function (x) { return x.el; }));
  }

  // ---------------------------------------------------------------- feed
  PW.feed = function (d) {
    PW.state = d;
    var newNotices = [];
    // notices: only ones that appear after the first state
    var cur = {}; (d.depositNotices || []).forEach(function (n) { cur[n.id] = n; });
    if (seenNotice) {
      Object.keys(cur).forEach(function (id) { if (!seenNotice[id] && openStatus(cur[id]) && !arr[id]) { arr[id] = { announced: false, at: Date.now() }; } });
    }
    seenNotice = seenNotice || {};
    Object.keys(cur).forEach(function (id) { seenNotice[id] = 1; });
    Object.keys(arr).forEach(function (id) {
      var n = cur[id];
      if (n && openStatus(n) && !arr[id].announced) { arr[id].announced = true; newNotices.push(n); }
      if (!n && Date.now() - arr[id].at > 15000) delete arr[id]; // matched / dismissed elsewhere
      else if (n && !openStatus(n)) delete arr[id];
    });
    newNotices.forEach(function (n) { announceArrival(n, d); });
    renderDep();
    if (PW.onChange) PW.onChange();
  };
  PW.isPaid = function (orderId) {
    var d = PW.state; if (!d) return undefined;
    var o = (d.orders || []).filter(function (x) { return x.id === orderId; })[0];
    return o ? !!o.paid : undefined;
  };
  PW.reset = function () { queue = []; recentHints = []; seenNotice = null; arr = {}; dismissed = {}; okList = []; PW.state = null; SC.fill(depBox); SC.fill(okBox); };

  // kitchen page: its own connection to the staff stream
  var live = null;
  PW.start = function () {
    PW.stop();
    PW.mode = 'kitchen';
    PW.openDeposits = function () { SC.toast('직원 화면의 입금 탭에서 확인해 주세요', 'info', 6000); };   // the kitchen display never navigates away
    PW.refresh = function () { return live ? live.refresh() : Promise.resolve(); };
    live = SC.live({ sse: '/api/staff/events', poll: '/api/staff/state', onState: PW.feed, hints: { new_deposit: PW.hintDeposit, deposit_matched: function () { PW.refresh(); }, payment: PW.hintPayment, payment_void: PW.hintVoid } });
  };
  PW.stop = function () { if (live) { live.close(); live = null; } PW.reset(); };
})();

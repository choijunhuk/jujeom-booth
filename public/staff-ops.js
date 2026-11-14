/* Staff release-2 tools: "더보기" sheets (입금 받기 · 주문 수정 · 서비스 · 이동 · 취소 · 직접 주문 · 쿠폰 발급),
   refunds, notice, no-show timeout, audit log, day close. Loaded before staff.js; staff.js hands over its internals via SO.init(). */
(function () {
  'use strict';
  var SC = window.SC, h = SC.h, won = SC.won, BASE = SC.BASE;
  var SO = window.SO = {};
  var X = null; // bridge from staff.js: { S, api, refresh, abtn, sig, memDisc, coupDisc, emptyEl, openBill }
  SO.init = function (bridge) { X = bridge; };

  // ---------------------------------------------------------------- error text (every server code -> Korean)
  var STALE = '다른 기기에서 먼저 처리했어요. 다시 확인해 주세요.';
  var ERR = {
    stale: STALE,
    has_refunds: '이미 돌려준 환불이 있어서 입금 취소를 할 수 없어요.',
    no_lines: '메뉴가 1개 이상 남아야 해요. 주문을 없애려면 "주문 취소"를 써 주세요.',
    insufficient_stock: '남은 재고보다 많아요. 수량을 줄여 주세요.',
    sold_out: '품절된 메뉴는 수량을 늘릴 수 없어요.',
    bad_items: '메뉴 목록이 올바르지 않아요.',
    bad_qty: '수량은 1~20개 사이예요.',
    dup_item: '같은 메뉴가 두 번 들어 있어요.',
    unknown_item: '없는 메뉴예요. 화면을 새로 불러올게요.',
    same_table: '같은 테이블로는 옮길 수 없어요.',
    bad_tables: '테이블 번호가 올바르지 않아요.',
    order_cancelled: '이미 취소된 주문이에요.',
    no_order: '없는 주문이에요. 화면을 새로 불러올게요.',
    not_cancellable: '이 주문은 취소할 수 없어요.',
    already_paid: '이미 입금이 확인된 주문이에요.',
    bad_paid: '입금 값이 올바르지 않아요.',
    bad_method: '받은 방법을 골라 주세요.',
    bad_amount: '금액이 올바르지 않아요. 0~10,000,000원 사이 정수예요.',
    bad_expected: '화면 정보가 오래됐어요. 새로고침해 주세요.',
    no_refund: '없는 환불이에요. 화면을 새로 불러올게요.',
    refund_done: '이미 환불 완료로 기록된 건이에요.',
    bad_note: '메모는 1~60자로 입력해 주세요.',
    note_required: '금액이 다른 입금을 연결할 때는 사유 메모가 필요해요.',
    manual_coupon_limit: '직접 발급은 1시간에 20장까지예요. 잠시 뒤에 다시 해 주세요.',
    coupon_used: '이미 사용된 쿠폰은 무효로 만들 수 없어요.',
    coupon_void: '이미 무효 처리된 쿠폰이에요.',
    no_coupon: '없는 쿠폰이에요. 화면을 새로 불러올게요.',
    coupon_not_allowed: '직접 주문에는 쿠폰을 쓸 수 없어요.',
    bad_label: '이름은 1~20자로 입력해 주세요.',
    bad_type: '종류를 골라 주세요.',
    not_noshow: '노쇼 상태가 아니에요. 화면을 새로 불러올게요.',
    already_recalled: '이미 한 번 다시 부른 팀이에요.',
    wait_noshow: '노쇼 처리된 팀이에요. "다시 부르기"를 써 주세요.',
    no_wait: '이미 처리된 대기예요. 화면을 새로 불러올게요.',
    bad_minutes: '시간은 1~30분 사이 정수예요.',
    bad_text: '공지는 80자 이하로 입력해 주세요.',
    bad_level: '공지 종류가 올바르지 않아요.',
    bad_stock_left: '남은 수량은 0~9,999 사이 정수예요. (비우면 제한 없음)',
    nothing_to_close: '마감할 주문이 없어요.',
    open_items: '아직 정리되지 않은 항목이 있어요.',
    confirm_required: '"마감"을 정확히 입력해 주세요.',
    no_report: '없는 리포트예요.',
    bad_query: '조회 조건이 올바르지 않아요.',
    bad_key: '요청 번호가 올바르지 않아요. 다시 시도해 주세요.',
    too_many_orders: '이 자리의 주문이 너무 많아요.',
    too_many_lines: '한 주문에 담을 수 있는 메뉴 수를 넘었어요.',
    too_many_open: '처리 안 된 항목이 너무 많아요. 먼저 정리해 주세요.',
    bad_depositor: '입금자명이 올바르지 않아요.',
    unsettled: '정산이 끝나지 않았어요.',
    refund_changed: '환불 금액이 바뀌었어요. 다시 확인해 주세요.',
    seat_changed: '자리가 바뀌었어요.',
    network: '네트워크 연결을 확인해 주세요.',
    bad_json: '요청 형식이 올바르지 않아요.',
    unauthorized: '다시 로그인해 주세요.',
  };
  var UNDO_WHY = {
    no_clear: '되돌릴 정리 기록이 없어요.',
    seat_changed: '그 사이 자리가 바뀌어서 되돌릴 수 없어요.',
    too_old: '정리한 지 10분이 지나서 되돌릴 수 없어요.',
    seat_in_use: '새 손님이 이미 앉아 있어서 되돌릴 수 없어요.',
  };
  SC.errText = function (e) {
    if (e && e.code === 'cannot_undo') return UNDO_WHY[e.data && e.data.reason] || '정리를 되돌릴 수 없어요.';
    return (e && ERR[e.code]) || (e && e.message) || '요청에 실패했어요.';
  };
  SO.ERR = ERR;

  // ---------------------------------------------------------------- helpers
  var METHOD = { transfer: '계좌이체', cash: '현금', other: '기타' };
  var METHOD_BY = { transfer: '계좌이체로', cash: '현금으로', other: '기타 방법으로' };
  SO.METHOD = METHOD;
  function el(tag, cls, kids) { return h(tag, cls ? { class: cls } : null, kids); }
  function fresh(id) { return X.S.data && X.S.data.orders.filter(function (o) { return o.id === id; })[0] || null; }
  function holdOf(o) { return (o.paidAmount || 0) - (o.refundedAmount || 0); }
  function stripUnused(o) { return o; }
  // order mutation that carries the updatedAt the staff member was looking at (409 stale -> refresh + Korean text)
  SO.omut = function (o, path, body) {
    var b = Object.assign({}, body || {});
    if (o.updatedAt != null) b.expectedUpdatedAt = o.updatedAt;
    return X.api('/api/staff/orders/' + o.id + '/' + path, b).then(null, function (e) {
      if (e.code === 'stale') X.refresh();
      throw e;
    });
  };
  function toastErr(e) { SC.toast(SC.errText(e), 'error'); if (e.code === 'stale' || e.code === 'no_order' || e.code === 'unknown_item' || e.code === 'no_wait' || e.code === 'no_coupon' || e.code === 'no_refund' || e.code === 'not_noshow') X.refresh(); }
  SO.toastErr = toastErr;
  function menuItems(includeHidden) { return ((X.S.data.menu && X.S.data.menu.items) || []).filter(function (i) { return includeHidden || !i.hidden; }); }
  function catName(i) { return i.cat || ''; }

  // ---------------------------------------------------------------- sheet framework
  var sheets = [];
  function openSheet(label, build) {
    var dlg = h('dialog', { class: 'dlg wide sheet', 'aria-label': label });
    var s = { dlg: dlg, onState: null };
    function close() { if (dlg.open) dlg.close(); }
    dlg.addEventListener('close', function () { if (s.onClose) s.onClose(); dlg.remove(); sheets = sheets.filter(function (x) { return x !== s; }); });
    dlg.addEventListener('cancel', function (e) { e.preventDefault(); close(); });
    s.close = close;
    s.show = function (view) { if (s.onClose) { s.onClose(); s.onClose = null; } s.onState = s.nextOnState || null; s.nextOnState = null; dlg.replaceChildren(view); var sc = dlg.querySelector('.sheet-scroll'); if (sc) sc.scrollTop = 0; };
    document.body.appendChild(dlg);
    sheets.push(s);
    build(s);
    dlg.showModal();
    return s;
  }
  SO.onState = function (d) { sheets.slice().forEach(function (s) { if (s.onState) s.onState(d); }); };
  function head(s, title, sub, back) {
    return h('div', { class: 'sheet-head' },
      back ? h('button', { class: 'btn btn-sm', type: 'button', onclick: back }, '← 뒤로') : null,
      h('div', { class: 'grow' }, h('h2', { class: 'dlg-title' }, title), sub ? h('p', { class: 'muted' }, sub) : null),
      h('button', { class: 'btn btn-sm', type: 'button', onclick: s.close, 'aria-label': '닫기' }, '닫기'));
  }
  function view(s, title, sub, back, body, foot) {
    return h('div', { class: 'dlg-body sheet-body' },
      head(s, title, sub, back),
      h('div', { class: 'sheet-scroll' }, body),
      foot ? h('div', { class: 'sheet-foot' }, foot) : null);
  }
  // before -> after rows for any money action
  function beforeAfter(rows) {
    return h('div', { class: 'ba', role: 'group', 'aria-label': '변경 전과 후' }, rows.filter(Boolean).map(function (r) {
      var same = r[1] === r[2];
      return h('div', { class: 'ba-row' + (r[3] ? ' ' + r[3] : '') }, h('span', { class: 'k' }, r[0]), h('span', { class: 'b num' }, r[1]), h('span', { class: 'arr', 'aria-hidden': 'true' }, same ? '＝' : '→'), h('b', { class: 'a num' }, r[2]));
    }));
  }
  function note(kind, text) { return h('p', { class: 'sheet-note ' + kind, role: kind === 'bad' ? 'alert' : null }, text); }
  function stepper(get, set, min, max, label) {
    var out = h('output', { class: 'num qty', 'aria-live': 'polite' }, String(get()));
    function bump(d) { var v = Math.max(min, Math.min(max, get() + d)); set(v); out.textContent = String(v); minus.disabled = v <= min; plus.disabled = v >= max; }
    var minus = h('button', { class: 'btn btn-sm step', type: 'button', 'aria-label': label + ' 하나 줄이기', onclick: function () { bump(-1); } }, '−');
    var plus = h('button', { class: 'btn btn-sm step', type: 'button', 'aria-label': label + ' 하나 늘리기', onclick: function () { bump(1); } }, '+');
    minus.disabled = get() <= min; plus.disabled = get() >= max;
    var box = h('div', { class: 'stepper' }, minus, out, plus);
    box.refresh = function () { out.textContent = String(get()); minus.disabled = get() <= min; plus.disabled = get() >= max; };
    return box;
  }
  function searchBox(onInput) {
    return h('input', { class: 'field', type: 'search', placeholder: '메뉴 이름 검색', autocomplete: 'off', 'aria-label': '메뉴 검색', oninput: function () { onInput(this.value.trim().toLowerCase()); } });
  }
  // menu picker: list grouped by category, tap to add. onPick(item)
  function menuPicker(opts) {
    var q = '';
    var list = h('div', { class: 'picklist' });
    function render() {
      var items = menuItems(opts.hidden && opts.hidden()).filter(function (i) { return !q || i.name.toLowerCase().indexOf(q) >= 0; });
      var cats = [], by = {};
      items.forEach(function (i) { var c = catName(i); if (!by[c]) { by[c] = []; cats.push(c); } by[c].push(i); });
      SC.fill(list, items.length ? cats.map(function (c) {
        return h('div', { class: 'pgroup' }, c ? h('div', { class: 'pcat' }, c) : null, by[c].map(function (i) {
          var n = opts.count ? opts.count(i) : 0;
          var out = i.soldOut && !opts.allowSoldOut;
          return h('button', { class: 'btn prow' + (n ? ' on' : ''), type: 'button', disabled: out, onclick: function () { opts.onPick(i); render(); } },
            h('span', { class: 'nm' }, i.name), h('span', { class: 'muted num' }, opts.free ? '서비스' : won(i.price)),
            i.soldOut ? h('span', { class: 'tag bad solid' }, '품절') : i.stockLeft != null ? h('span', { class: 'tag warn' }, i.stockLeft + '개 남음') : null,
            n ? h('b', { class: 'cnt num' }, '×' + n) : null);
        }));
      }) : X.emptyEl('찾는 메뉴가 없어요'));
    }
    render();
    return { el: h('div', { class: 'picker' }, searchBox(function (v) { q = v; render(); }), list), render: render };
  }

  // ---------------------------------------------------------------- order sheet ("⋯ 더보기")
  var STATUS_TEXT = { pending: '접수 대기', cooking: '조리 중', served: '서빙 완료', cancelled: '취소됨' };
  function summary(o) {
    var live = o.status !== 'cancelled';
    var mem = X.memDisc(o), cou = X.coupDisc(o);
    return h('div', { class: 'osum' },
      h('ul', { class: 'items' }, o.items.map(function (i) { return h('li', null, h('span', { class: 'q' }, '×' + i.qty), h('span', null, i.name + (i.service ? ' (서비스)' : '')), i.service ? null : h('span', { class: 'muted num' }, won(i.unitPrice * i.qty))); })),
      h('div', { class: 'ba-plain' },
        h('div', null, h('span', null, '합계'), h('b', { class: 'num' }, won(o.total))),
        mem || cou ? h('div', { class: 'muted' }, h('span', null, (mem ? '회원 −' + won(mem) : '') + (mem && cou ? ' · ' : '') + (cou ? '쿠폰 −' + won(cou) : '')), h('span', null, '')) : null,
        o.paidAmount ? h('div', null, h('span', null, '받은 돈' + (o.paidMethod ? ' (' + (METHOD[o.paidMethod] || o.paidMethod) + ')' : '')), h('b', { class: 'num' }, won(o.paidAmount))) : null,
        o.refundedAmount ? h('div', null, h('span', null, '돌려준 돈'), h('b', { class: 'num' }, won(o.refundedAmount))) : null,
        live && o.balanceDue > 0 ? h('div', { class: 'owe' }, h('span', null, '남은 금액'), h('b', { class: 'num' }, won(o.balanceDue))) : null,
        o.refundDue > 0 ? h('div', { class: 'owe' }, h('span', null, '돌려줄 돈'), h('b', { class: 'num' }, won(o.refundDue))) : null,
        live && !o.paidAmount && !(o.balanceDue > 0) ? null : null));
  }
  function staleBanner(s, o, reopen) {
    var box = h('div');
    if (!fresh(o.id)) return box; // 미수금 order: no longer in the live state, nothing to watch
    s.nextOnState = function (d) {
      var cur = d.orders.filter(function (x) { return x.id === o.id; })[0];
      if (!cur) { SC.toast('이 주문이 목록에서 사라졌어요.', 'error'); s.close(); return; }
      if (cur.updatedAt !== o.updatedAt) {
        SC.fill(box, h('div', { class: 'banner warn', role: 'alert' }, h('span', null, '다른 기기에서 이 주문이 바뀌었어요.'), h('button', { class: 'btn btn-sm', type: 'button', onclick: function () { reopen(cur); } }, '새로 보기')));
      } else SC.fill(box);
    };
    return box;
  }
  SO.openOrderSheet = function (orderId) {
    var first = fresh(orderId);
    if (!first) return;
    openSheet('주문 더보기', function (s) { orderHome(s, first); });
  };
  function orderHome(s, o) {
    var live = o.status !== 'cancelled';
    function act(title, sub, cls, go) {
      return h('button', { class: 'btn bigact ' + (cls || ''), type: 'button', onclick: go }, h('b', null, title), h('span', { class: 'muted' }, sub));
    }
    var body = [staleBanner(s, o, function (cur) { orderHome(s, cur); }), summary(o)];
    if (live) {
      body.push(h('div', { class: 'bigacts' },
        act('입금 받기', o.balanceDue > 0 ? '남은 ' + won(o.balanceDue) + ' · 나눠서 받기 · 현금' : (o.refundDue > 0 ? '환불 대기 ' + won(o.refundDue) : '전액 받음'), '', function () { payView(s, o, function () { orderHome(s, o); }); }),
        act('주문 수정', '수량 바꾸기 · 메뉴 빼기 · 추가', '', function () { editView(s, o); }),
        act('서비스 추가', '공짜로 드리는 메뉴 (금액 그대로)', '', function () { serviceView(s, o); }),
        act('다른 테이블로 옮기기', '이 주문 1건만 · 쿠폰은 원래 자리에 남아요', '', function () { moveView(s, o); }),
        act('주문 취소', o.paidAmount ? '받은 ' + won(holdOf(o)) + '은 환불 대기에 올라가요' : '되돌릴 수 없어요', 'danger', function () { cancelView(s, o); })));
    } else body.push(note('info', '취소된 주문이에요. 돌려줄 돈이 있으면 "입금" 탭의 환불 대기에서 처리해요.'));
    s.show(view(s, o.table + '번 테이블 · 주문 #' + o.id, STATUS_TEXT[o.status] + ' · ' + SC.agoText(o.createdAt), null, body));
  }

  // ---- server dry run: the same endpoint with dryRun:true, debounced 300 ms, stale answers dropped
  function makeDry(run, render) {
    var seq = 0, timer = 0, d = { last: null, busy: false };
    function fire() {
      var my = ++seq; d.busy = true;
      render(d);
      Promise.resolve().then(run).then(function (r) { if (my !== seq) return; d.busy = false; d.last = { order: r.order }; render(d); },
        function (e) { if (my !== seq) return; d.busy = false; d.last = { err: e }; if (e && e.code === 'stale') X.refresh(); render(d); });
    }
    d.schedule = function () { clearTimeout(timer); seq++; d.busy = true; d.last = null; render(d); timer = setTimeout(fire, 300); };
    d.now = function () { clearTimeout(timer); fire(); };
    d.cancel = function () { clearTimeout(timer); seq++; };
    return d;
  }
  function errNote(e) { return note('bad', SC.errText(e)); }
  var CMP = ['subtotal', 'memberDiscount', 'couponDiscount', 'total', 'balanceDue', 'refundDue'];
  function sameNumbers(a, b) { return CMP.every(function (k) { return (a[k] || 0) === (b[k] || 0); }); }
  // after the real call: if the numbers differ from the last dry run, show them instead of closing silently
  function finishMoney(s, title, real, previewed, okMsg) {
    var ro = real && real.order;
    if (!ro || !previewed || sameNumbers(ro, previewed)) { SC.toast(okMsg, 'ok'); return X.refresh().then(function () { if (SO.reloadSales) SO.reloadSales(); s.close(); }); }
    SC.toast(okMsg + ' (미리본 금액과 달라요)', 'ok');
    return X.refresh().then(function () {
      s.show(view(s, title + ' · 저장됨', '서버가 저장한 금액이 미리본 금액과 달라요. 확인해 주세요.', null, [
        beforeAfter(CMP.map(function (k) { var lab = { subtotal: '주문 금액', memberDiscount: '회원 할인', couponDiscount: '쿠폰 할인', total: '합계', balanceDue: '남은 금액', refundDue: '돌려줄 돈' }[k]; return (previewed[k] || 0) === (ro[k] || 0) ? null : [lab, won(previewed[k] || 0), won(ro[k] || 0), 'bad']; })),
        note('warn', '왼쪽이 미리본 금액, 오른쪽이 실제로 저장된 금액이에요.')], h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: s.close }, '확인했어요')));
    });
  }
  function moneyRowsFrom(o, n) {
    var rows = [['주문 금액', won(o.subtotal != null ? o.subtotal : o.total), won(n.subtotal != null ? n.subtotal : n.total)]];
    if (X.memDisc(o) || X.memDisc(n)) rows.push(['회원 할인', '−' + won(X.memDisc(o)), '−' + won(X.memDisc(n))]);
    if (X.coupDisc(o) || X.coupDisc(n)) rows.push(['쿠폰 할인', '−' + won(X.coupDisc(o)), '−' + won(X.coupDisc(n))]);
    rows.push(['합계', won(o.total), won(n.total), n.total > o.total ? 'owe' : '']);
    return rows;
  }

  // ---- 입금 받기
  function payView(s, o, back) {
    var method = 'transfer', amount = String(Math.max(0, o.balanceDue || 0));
    var held = holdOf(o);
    var preview = h('div'), warn = h('div'), amountIn = h('input', { class: 'field amt', type: 'number', inputmode: 'numeric', min: '0', max: '10000000', step: '1', value: amount, 'aria-label': '받은 금액(원)', oninput: function () { amount = amountIn.value; update(); } });
    var segBtns = {};
    var seg = h('div', { class: 'al-seg', role: 'group', 'aria-label': '받은 방법' }, ['transfer', 'cash', 'other'].map(function (m) {
      var b = h('button', { class: 'btn', type: 'button', 'aria-pressed': m === method ? 'true' : 'false', onclick: function () { method = m; update(); } }, METHOD[m]);
      segBtns[m] = b; return b;
    }));
    function valid() { var n = Number(amount); return amount !== '' && Number.isInteger(n) && n >= 0 && n <= 10000000; }
    var dry = makeDry(function () { return SO.omut(o, 'paid', { paid: true, method: method, amount: Number(amount), dryRun: true }); }, draw);
    var confirmBtn = X.abtn('btn btn-primary btn-block', '입금 받기', function () {
      var n = Number(amount), seen = dry.last && dry.last.order;
      return SO.omut(o, 'paid', { paid: true, method: method, amount: n }).then(function (r) { return finishMoney(s, '입금 받기', r, seen, o.table + '번 #' + o.id + ' · ' + METHOD[method] + ' ' + won(n) + ' 받았어요' + (r.order && r.order.balanceDue > 0 ? ' (남은 ' + won(r.order.balanceDue) + ')' : '')); });
    });
    function draw() {
      var n = Number(amount), res = dry.last;
      confirmBtn.textContent = valid() ? won(n) + ' ' + METHOD_BY[method] + ' 받기' : '입금 받기';
      confirmBtn.disabled = !valid() || dry.busy || !(res && res.order) || confirmBtn.classList.contains('busy');
      if (!valid()) { SC.fill(preview); SC.fill(warn, note('bad', '금액을 0~10,000,000원 사이 정수로 입력해 주세요.')); return; }
      if (dry.busy || !res) { SC.fill(preview, h('p', { class: 'muted' }, '서버가 계산하는 중…')); SC.fill(warn); return; }
      if (res.err) { SC.fill(preview); SC.fill(warn, errNote(res.err)); return; }
      var a = res.order, hAfter = holdOf(a);
      SC.fill(preview, beforeAfter([
        ['받은 돈', won(held), won(hAfter)],
        ['남은 금액', won(o.balanceDue || 0), won(a.balanceDue || 0), a.balanceDue ? 'owe' : 'ok'],
        (a.refundDue || 0) > (o.refundDue || 0) ? ['돌려줄 돈 (초과 입금)', won(o.refundDue || 0), won(a.refundDue), 'owe'] : null]));
      SC.fill(warn, (a.refundDue || 0) > (o.refundDue || 0) ? note('warn', '주문 금액보다 ' + won(a.refundDue - (o.refundDue || 0)) + ' 더 받아요. 이 돈은 "입금" 탭의 환불 대기에 올라가요.') : null);
    }
    function update() {
      Object.keys(segBtns).forEach(function (m) { segBtns[m].setAttribute('aria-pressed', m === method ? 'true' : 'false'); });
      if (!valid()) { dry.cancel(); dry.last = null; draw(); return; }
      dry.schedule();
    }
    var quick = o.balanceDue > 0 ? X.abtn('btn btn-primary btn-block quick', '전액 입금 확인 · 계좌이체 · ' + won(o.balanceDue), function () {
      return SO.omut(o, 'paid', { paid: true, method: 'transfer' }).then(function (r) { return finishMoney(s, '입금 받기', r, { total: o.total, subtotal: o.subtotal, memberDiscount: o.memberDiscount, couponDiscount: o.couponDiscount, balanceDue: 0, refundDue: o.refundDue }, o.table + '번 #' + o.id + ' 입금 확인했어요'); });
    }) : note('ok', '이 주문은 이미 전액 받았어요.');
    var body = [staleBanner(s, o, function (cur) { payView(s, cur, back); }), summary(o), quick,
      h('h3', { class: 'sec-title' }, '나눠서 받거나 현금으로 받기'),
      h('div', { class: 'lab' }, '받은 방법', seg),
      h('label', { class: 'lab' }, '받은 금액 (원)', h('div', { class: 'amt-row' }, amountIn, h('button', { class: 'btn', type: 'button', onclick: function () { amount = String(Math.max(0, o.balanceDue || 0)); amountIn.value = amount; update(); } }, '전액'))),
      preview, warn];
    s.show(view(s, '입금 받기', o.table + '번 테이블 · 주문 #' + o.id, back, body, confirmBtn));
    s.onClose = dry.cancel;
    update();
  }
  SO.openPaySheet = function (orderId) { var o = fresh(orderId); if (o) openSheet('입금 받기', function (s) { payView(s, o, null); }); };
  SO.openPayFor = function (row) { // 미수금 / 미결제 row from sales (order may no longer be visible in staff state)
    var live = fresh(row.orderId);
    var o = live || { id: row.orderId, table: row.table, total: row.total, subtotal: row.total, paidAmount: row.paidAmount || 0, refundedAmount: 0, balanceDue: row.balance, refundDue: 0, items: [], status: 'served', createdAt: Date.now(), updatedAt: row.updatedAt };
    openSheet('입금 받기', function (s) { payView(s, o, null); });
  };

  // ---- 주문 수정
  function editView(s, o) {
    var lines = o.items.filter(function (i) { return !i.service; }).map(function (i) { return { id: i.id, name: i.name, unit: i.unitPrice, qty: i.qty, orig: i.qty }; });
    var svc = o.items.filter(function (i) { return i.service; });
    var rows = h('div', { class: 'elines' }), preview = h('div'), msg = h('div', { class: 'stack' }), adding = false, addBox = h('div');
    function normalLeft() { return lines.some(function (l) { return l.qty > 0; }); }
    function changed() { return lines.some(function (l) { return l.qty !== l.orig; }); }
    function payload() { return lines.map(function (l) { return { id: l.id, qty: l.qty }; }); }
    var dry = makeDry(function () { return SO.omut(o, 'items', { items: payload(), dryRun: true }); }, draw);
    var save = X.abtn('btn btn-primary btn-block', '수정 저장', function () {
      var seen = dry.last && dry.last.order;
      return SO.omut(o, 'items', { items: payload() }).then(function (r) { return finishMoney(s, '주문 수정', r, seen, '주문 #' + o.id + ' 수정했어요' + (r.order ? ' · 합계 ' + won(r.order.total) : '')); });
    });
    function draw() {
      var res = dry.last;
      save.disabled = !changed() || !normalLeft() || dry.busy || !(res && res.order) || save.classList.contains('busy');
      if (!normalLeft()) { SC.fill(preview); SC.fill(msg, note('bad', ERR.no_lines)); return; }
      if (!changed()) { SC.fill(preview); SC.fill(msg, note('info', '수량을 바꾸거나 메뉴를 추가하면 서버가 금액을 계산해서 보여 줘요.')); return; }
      if (dry.busy || !res) { SC.fill(preview, h('p', { class: 'muted' }, '서버가 계산하는 중…')); SC.fill(msg); return; }
      if (res.err) { SC.fill(preview); SC.fill(msg, errNote(res.err)); return; }
      var n = res.order, rowsBA = moneyRowsFrom(o, n);
      SC.fill(preview, beforeAfter(rowsBA));
      var held = holdOf(o), eff = null;
      if ((n.refundDue || 0) > (o.refundDue || 0)) eff = note('warn', '받은 돈이 새 합계보다 ' + won(n.refundDue - (o.refundDue || 0)) + ' 많아요. 저장하면 "입금" 탭의 환불 대기에 올라가요.');
      else if (held > 0 && n.balanceDue > 0) eff = note('warn', '새 합계가 받은 돈보다 ' + won(n.balanceDue) + ' 많아요. 저장하면 미입금으로 바뀌고 ' + won(n.balanceDue) + '을 더 받아야 해요.');
      else if (held === 0 && n.total !== o.total) eff = note('info', '아직 받은 돈이 없어서 받을 금액만 ' + won(n.total) + '으로 바뀌어요.');
      SC.fill(msg, eff);
    }
    function renderRows() {
      SC.fill(rows, lines.map(function (l) {
        var rowEl;
        var st = stepper(function () { return l.qty; }, function (v) { l.qty = v; rowEl.classList.toggle('gone', v === 0); dry.schedule(); }, 0, 20, l.name);
        rowEl = h('div', { class: 'eline' + (l.qty === 0 ? ' gone' : '') },
          h('div', { class: 'grow' }, h('span', { class: 'nm' }, l.name), h('span', { class: 'muted num' }, won(l.unit) + (l.isNew ? ' · 새로 추가' : ''))), st);
        return rowEl;
      }), svc.length ? h('div', { class: 'muted svc-note' }, '서비스: ' + svc.map(function (i) { return i.name + ' ×' + i.qty; }).join(', ') + ' (그대로 유지돼요)') : null);
    }
    function addItem(i) {
      var ex = lines.filter(function (l) { return l.id === i.id; })[0];
      if (ex) ex.qty = Math.min(20, ex.qty + 1);
      else lines.push({ id: i.id, name: i.name, unit: i.price, qty: 1, orig: 0, isNew: true });
      renderRows(); dry.schedule();
    }
    var picker = menuPicker({ onPick: addItem, count: function (i) { var l = lines.filter(function (x) { return x.id === i.id; })[0]; return l ? l.qty : 0; } });
    var addBtn = h('button', { class: 'btn btn-block', type: 'button', onclick: function () { adding = !adding; addBox.hidden = !adding; addBtn.textContent = adding ? '메뉴 목록 닫기' : '+ 메뉴 추가'; } }, '+ 메뉴 추가');
    addBox.hidden = true; addBox.appendChild(picker.el);
    renderRows();
    var body = [staleBanner(s, o, function (cur) { editView(s, cur); }), note('info', '이미 담긴 메뉴는 원래 가격 그대로예요. 새로 추가하는 메뉴만 지금 가격이에요. 수량을 0으로 하면 빠져요.'), rows, addBtn, addBox, h('h3', { class: 'sec-title' }, '금액 변화 (서버 계산)'), preview, msg];
    s.show(view(s, '주문 수정', o.table + '번 테이블 · 주문 #' + o.id, function () { orderHome(s, o); }, body, save));
    s.onClose = dry.cancel;
    draw();
  }

  // ---- 서비스 추가
  function serviceView(s, o) {
    var pick = null, qty = 1, info = h('div');
    var dry = makeDry(function () { return SO.omut(o, 'service', { itemId: pick.id, qty: qty, dryRun: true }); }, draw);
    var go = X.abtn('btn btn-primary btn-block', '서비스로 드리기', function () {
      var seen = dry.last && dry.last.order;
      return SO.omut(o, 'service', { itemId: pick.id, qty: qty }).then(function (r) { return finishMoney(s, '서비스 추가', r, seen, pick.name + ' ×' + qty + ' 서비스로 추가했어요'); });
    });
    function svcQty(ord) { return pick ? (ord.items || []).filter(function (i) { return i.service && i.id === pick.id; }).reduce(function (a, i) { return a + i.qty; }, 0) : 0; }
    function draw() {
      var res = dry.last;
      go.disabled = !pick || dry.busy || !(res && res.order) || go.classList.contains('busy');
      go.textContent = pick ? pick.name + ' ×' + qty + ' 서비스로 드리기' : '서비스로 드리기';
      if (!pick) { SC.fill(info, note('info', '드릴 메뉴를 골라 주세요.')); return; }
      if (dry.busy || !res) { SC.fill(info, h('p', { class: 'muted' }, '서버가 확인하는 중…')); return; }
      if (res.err) { SC.fill(info, errNote(res.err)); return; }
      var n = res.order;
      SC.fill(info, beforeAfter([['서비스 ' + pick.name, svcQty(o) + '개', svcQty(n) + '개'], ['합계', won(o.total), won(n.total)]]), note('info', '금액은 그대로이고 주방 화면에 "서비스"로 표시돼요.' + (pick.stockLeft != null ? ' 재고에서 빠져요.' : '')));
    }
    var st = stepper(function () { return qty; }, function (v) { qty = v; if (pick) dry.schedule(); }, 1, 20, '서비스 수량');
    var picker = menuPicker({ onPick: function (i) { pick = i; dry.schedule(); }, free: true, count: function (i) { return pick && pick.id === i.id ? qty : 0; } });
    var body = [staleBanner(s, o, function (cur) { serviceView(s, cur); }), h('div', { class: 'lab' }, '수량', st), picker.el, info];
    s.show(view(s, '서비스 추가', o.table + '번 테이블 · 주문 #' + o.id, function () { orderHome(s, o); }, body, go));
    s.onClose = dry.cancel;
    draw();
  }

  // ---- 이 주문만 옮기기
  function moveView(s, o) {
    var d = X.S.data, to = null, info = h('div');
    var go = X.abtn('btn btn-primary btn-block', '이 주문 옮기기', function () {
      return SO.omut(o, 'move', { to: to.number }).then(function () {
        SC.toast('주문 #' + o.id + ' → ' + to.number + '번 테이블로 옮겼어요', 'ok');
        return X.refresh().then(function () { s.close(); });
      });
    });
    go.disabled = true;
    var btns = {};
    var pick = h('div', { class: 'pick' }, d.tables.filter(function (t) { return t.number !== o.table; }).sort(function (a, b) { return a.number - b.number; }).map(function (t) {
      var b = h('button', { class: 'btn', type: 'button', 'aria-pressed': 'false', onclick: function () { to = t; Object.keys(btns).forEach(function (k) { btns[k].setAttribute('aria-pressed', String(Number(k) === t.number)); }); update(); } }, String(t.number), h('small', null, t.status === 'occupied' ? '사용 중' : '비어 있음'));
      btns[t.number] = b; return b;
    }));
    function update() {
      go.disabled = !to || go.classList.contains('busy');
      SC.fill(info, to ? [beforeAfter([['이 주문 #' + o.id, o.table + '번 테이블', to.number + '번 테이블'], ['' + o.table + '번 남은 주문', '유지', '유지']].slice(0, 1)),
        note('info', '이 주문 1건만 옮겨요. ' + (to.status === 'occupied' ? to.number + '번에 있는 손님과 한 계산서로 합쳐져요.' : to.number + '번은 비어 있어서 새 손님 자리가 돼요.') + (o.couponCode ? ' 쓴 쿠폰은 원래 자리에 남아요.' : ''))] : note('info', '옮길 테이블을 골라 주세요.'));
      go.textContent = to ? o.table + '번 → ' + to.number + '번으로 옮기기' : '이 주문 옮기기';
    }
    var body = [staleBanner(s, o, function (cur) { moveView(s, cur); }), pick, info];
    s.show(view(s, '다른 테이블로 옮기기', o.table + '번 테이블 · 주문 #' + o.id, function () { orderHome(s, o); }, body, go));
    update();
  }

  // ---- 주문 취소
  function cancelView(s, o) {
    var held = holdOf(o);
    var go = X.abtn('btn btn-solid-danger btn-block', '주문 #' + o.id + ' 취소하기', function () {
      return SO.omut(o, 'status', { status: 'cancelled' }).then(function () {
        SC.toast('주문 #' + o.id + ' 취소했어요' + (held > 0 ? ' · 환불 대기 ' + won(held) : ''), 'ok');
        return X.refresh().then(function () { s.close(); });
      });
    });
    var body = [staleBanner(s, o, function (cur) { cancelView(s, cur); }), summary(o),
      beforeAfter([['주문', STATUS_TEXT[o.status], '취소됨', 'bad'], held > 0 ? ['돌려줄 돈', won(o.refundDue || 0), won((o.refundDue || 0) + held), 'owe'] : null, ['합계', won(o.total), '0원']]),
      h('ul', { class: 'sheet-list' },
        held > 0 ? h('li', null, '받은 ' + won(held) + '은 "입금" 탭의 환불 대기에 올라가요. 직접 돌려준 뒤 "환불 완료"를 눌러 주세요.') : h('li', null, '받은 돈이 없어서 환불은 없어요.'),
        o.couponCode ? h('li', null, '쓴 쿠폰 ' + o.couponCode + '은 다시 쓸 수 있게 돌아가요.') : null,
        h('li', null, '재고를 센 메뉴는 재고가 돌아와요.'), h('li', null, '취소한 주문은 되돌릴 수 없어요.'))];
    s.show(view(s, '주문을 취소할까요?', o.table + '번 테이블 · 주문 #' + o.id, function () { orderHome(s, o); }, body, go));
  }

  // ---------------------------------------------------------------- table sheet (direct order, manual coupon)
  SO.openTableSheet = function (n) {
    openSheet('테이블 더보기', function (s) { tableHome(s, n); });
  };
  function tableHome(s, n) {
    function act(title, sub, go) { return h('button', { class: 'btn bigact', type: 'button', onclick: go }, h('b', null, title), h('span', { class: 'muted' }, sub)); }
    var closed = X.S.data && X.S.data.orderingOpen === false;
    s.show(view(s, n + '번 테이블 더보기', null, null, [
      h('div', { class: 'bigacts' },
        act('직접 주문 넣기', closed ? '주문 마감 중에도 직원은 넣을 수 있어요' : '손님 대신 주문을 입력해요', function () { directView(s, n); }),
        act('쿠폰 직접 발급', '할인 쿠폰 · 상품 쿠폰을 이 자리에 바로 줘요', function () { couponView(s, n); }))]));
  }
  function newKey() {
    try { if (window.crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) { /* fall through */ }
    return 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }
  function directView(s, n) {
    var qty = {}, key = newKey(), accept = true, hidden = false, noteIn = h('input', { class: 'field', type: 'text', maxlength: '60', placeholder: '요청 (선택)', 'aria-label': '요청 사항' });
    var depIn = h('input', { class: 'field', type: 'text', maxlength: '20', placeholder: '입금자명 (선택)', 'aria-label': '입금자명' });
    var info = h('div'), chosen = h('div', { class: 'chosen' });
    function body0() {
      var items = Object.keys(qty).filter(function (k) { return qty[k] > 0; }).map(function (k) { return { id: k, qty: qty[k] }; });
      var body = { key: key, items: items, accept: accept };
      if (noteIn.value.trim()) body.note = noteIn.value.trim();
      if (depIn.value.trim()) body.depositor = depIn.value.trim();
      if (hidden) body.allowHidden = true;
      return body;
    }
    function count() { return Object.keys(qty).reduce(function (a, k) { return a + qty[k]; }, 0); }
    var dry = makeDry(function () { return X.api('/api/staff/tables/' + n + '/orders', Object.assign(body0(), { dryRun: true })); }, draw);
    var go = X.abtn('btn btn-primary btn-block', '주문 넣기', function () {
      var seen = dry.last && dry.last.order;
      return X.api('/api/staff/tables/' + n + '/orders', body0()).then(function (r) {
        key = newKey();
        return finishMoney(s, '직접 주문', r, seen, n + '번 테이블에 주문을 넣었어요' + (r.order && r.order.total != null ? ' · ' + won(r.order.total) : ''));
      }); // on failure the same key stays, so a retry cannot double-create
    });
    function draw() {
      var c = count(), res = dry.last;
      go.disabled = !c || dry.busy || !(res && res.order) || go.classList.contains('busy');
      go.textContent = c && res && res.order ? '주문 넣기 · ' + c + '개 · ' + won(res.order.total) : '주문 넣기';
      if (!c) { SC.fill(info, note('info', '메뉴를 눌러 담아 주세요.')); return; }
      if (dry.busy || !res) { SC.fill(info, h('p', { class: 'muted' }, '서버가 계산하는 중…')); return; }
      if (res.err) { SC.fill(info, errNote(res.err)); return; }
      var o = res.order;
      SC.fill(info, beforeAfter([['주문 금액', '0원', won(o.subtotal != null ? o.subtotal : o.total)], X.memDisc(o) || X.coupDisc(o) ? ['할인', '0원', '−' + won(X.memDisc(o) + X.coupDisc(o))] : null, ['합계', '0원', won(o.total)]]));
    }
    function renderChosen() {
      SC.fill(chosen, Object.keys(qty).filter(function (k) { return qty[k] > 0; }).map(function (k) {
        var it = menuItems(true).filter(function (i) { return i.id === k; })[0]; if (!it) return null;
        var st = stepper(function () { return qty[k]; }, function (v) { qty[k] = v; renderChosen(); dry.schedule(); }, 0, 20, it.name);
        return h('div', { class: 'eline' }, h('div', { class: 'grow' }, h('span', { class: 'nm' }, it.name), h('span', { class: 'muted num' }, won(it.price) + ' × ' + qty[k])), st);
      }));
    }
    var picker = menuPicker({ onPick: function (i) { qty[i.id] = Math.min(20, (qty[i.id] || 0) + 1); renderChosen(); dry.schedule(); }, hidden: function () { return hidden; }, count: function (i) { return qty[i.id] || 0; } });
    var acceptBtn = h('button', { class: 'btn', type: 'button', 'aria-pressed': 'true', onclick: function () { accept = !accept; acceptBtn.setAttribute('aria-pressed', String(accept)); acceptBtn.textContent = accept ? '바로 접수함 (조리 시작)' : '접수 대기로 넣기'; if (count()) dry.schedule(); } }, '바로 접수함 (조리 시작)');
    var hidBtn = h('button', { class: 'btn', type: 'button', 'aria-pressed': 'false', onclick: function () { hidden = !hidden; hidBtn.setAttribute('aria-pressed', String(hidden)); hidBtn.textContent = hidden ? '숨긴 메뉴도 보는 중' : '숨긴 메뉴도 보기'; picker.render(); if (count()) dry.schedule(); } }, '숨긴 메뉴도 보기');
    [noteIn, depIn].forEach(function (i) { i.addEventListener('input', function () { if (count()) dry.schedule(); }); });
    var body = [X.S.data.orderingOpen === false ? note('info', '지금은 주문을 마감한 상태예요. 직원 주문은 마감 중에도 넣을 수 있어요.') : null,
      picker.el, chosen, h('div', { class: 'al-seg' }, acceptBtn, hidBtn), h('div', { class: 'two-in' }, noteIn, depIn), info];
    s.show(view(s, n + '번 테이블 직접 주문', '쿠폰은 쓸 수 없어요 · 같은 요청은 두 번 들어가지 않아요', function () { tableHome(s, n); }, body, go));
    s.onClose = dry.cancel;
    draw();
  }
  function couponView(s, n) {
    var type = 'discount', labelIn = h('input', { class: 'field', type: 'text', maxlength: '20', placeholder: '예: 사장님 서비스', 'aria-label': '쿠폰 이름' });
    var amtIn = h('input', { class: 'field', type: 'number', inputmode: 'numeric', min: '100', max: '100000', step: '100', value: '1000', 'aria-label': '할인 금액(원)' });
    var amtRow = h('label', { class: 'lab' }, '할인 금액 (100원 단위, 100~100,000원)', amtIn), info = h('div');
    var segBtns = {};
    var seg = h('div', { class: 'al-seg' }, [['discount', '할인 쿠폰'], ['item', '상품 쿠폰']].map(function (t) {
      var b = h('button', { class: 'btn', type: 'button', 'aria-pressed': String(t[0] === type), onclick: function () { type = t[0]; update(); } }, t[1]); segBtns[t[0]] = b; return b;
    }));
    var go = X.abtn('btn btn-primary btn-block', '쿠폰 발급', function () {
      var body = { type: type, label: labelIn.value.trim() };
      if (type === 'discount') body.amount = Number(amtIn.value);
      return X.api('/api/staff/tables/' + n + '/coupons', body).then(function (r) {
        SC.toast(n + '번 테이블에 "' + body.label + '" 쿠폰을 발급했어요' + (r.coupon ? ' · 코드 ' + r.coupon.code : ''), 'ok');
        return X.refresh().then(function () { s.close(); });
      });
    });
    function update() {
      Object.keys(segBtns).forEach(function (k) { segBtns[k].setAttribute('aria-pressed', String(k === type)); });
      amtRow.hidden = type !== 'discount';
      var a = Number(amtIn.value), lab = labelIn.value.trim();
      var ok = lab.length >= 1 && lab.length <= 20 && (type !== 'discount' || (Number.isInteger(a) && a >= 100 && a <= 100000 && a % 100 === 0));
      go.disabled = !ok || go.classList.contains('busy');
      SC.fill(info, note('info', (type === 'discount' ? '이 자리 손님이 주문할 때 ' + (Number.isInteger(a) ? won(a) : '') + ' 할인으로 쓸 수 있어요. ' : '이 자리 손님에게 "' + (lab || '상품') + '" 상품 쿠폰이 생겨요. 줄 때 "쿠폰" 탭에서 사용 처리해요. ') + '직접 발급은 1시간에 20장까지예요.'));
    }
    [labelIn, amtIn].forEach(function (i) { i.addEventListener('input', update); });
    s.show(view(s, n + '번 테이블 쿠폰 발급', null, function () { tableHome(s, n); }, [h('div', { class: 'lab' }, '종류', seg), h('label', { class: 'lab' }, '쿠폰 이름 (1~20자)', labelIn), amtRow, info], go));
    update();
  }

  // ---------------------------------------------------------------- coupon void
  SO.voidCoupon = function (c) {
    return SC.confirm({ title: '쿠폰 ' + c.code + '을 무효로 만들까요?', danger: true, ok: '무효 처리', cancel: '돌아가기', message: c.label + ' · ' + c.table + '번 테이블\n무효로 만들면 손님이 쓸 수 없고 되돌릴 수 없어요.' }).then(function (ok) {
      if (!ok) return;
      return X.api('/api/staff/coupons/' + encodeURIComponent(c.code) + '/void').then(function () { SC.toast('쿠폰 ' + c.code + ' 무효 처리했어요', 'ok'); return X.refresh(); }, toastErr);
    });
  };

  // ---------------------------------------------------------------- refunds (section of the 입금 tab)
  var REFUND_WHY = { cancelled: '주문 취소', overpaid: '초과 입금', edit_lower_total: '주문 수정으로 금액이 줄었어요' };
  SO.refundCount = function (d) { return (d.refunds || []).filter(function (r) { return !r.doneAt; }).length; };
  SO.buildRefunds = function () {
    var openBox = h('div', { class: 'list' }), doneBox = h('div', { class: 'list' }), doneSum = h('summary', null, '환불 완료'), title = h('h3', { class: 'sec-title' }, '환불 대기');
    var wrap = h('div', { class: 'refunds', hidden: true }, title, openBox, h('details', { class: 'hist' }, doneSum, doneBox));
    function update(d) {
      var all = (d.refunds || []).slice(), open = all.filter(function (r) { return !r.doneAt; }).sort(function (a, b) { return a.createdAt - b.createdAt; });
      var done = all.filter(function (r) { return r.doneAt; }).sort(function (a, b) { return b.doneAt - a.doneAt; });
      wrap.hidden = !all.length;
      title.textContent = '환불 대기 ' + open.length + '건' + (open.length ? ' · ' + won(open.reduce(function (a, r) { return a + r.amount; }, 0)) : '');
      SC.reconcile(openBox, open, function (r) { return r.id; }, X.sig, refundCard, X.emptyEl('돌려줄 돈이 없어요'));
      doneSum.textContent = '환불 완료 (' + done.length + ')';
      SC.reconcile(doneBox, done.slice(0, 50), function (r) { return r.id; }, X.sig, function (r) {
        return h('div', { class: 'row-card' }, h('div', { class: 'grow' }, h('b', null, r.table + '번 · ' + won(r.amount) + ' · ' + (METHOD[r.method] || r.method || '')), h('span', { class: 'muted' }, '주문 #' + r.orderId + ' · ' + (REFUND_WHY[r.reason] || r.reason) + ' · ' + SC.agoText(r.doneAt) + (r.note ? ' · ' + r.note : ''))));
      }, X.emptyEl('아직 없어요'));
    }
    return { el: wrap, update: update };
  };
  function refundCard(r) {
    return h('article', { class: 'ocard refund' },
      h('div', { class: 'ohead' }, h('div', { class: 'tno' }, h('span', { class: 'n', text: r.table }), h('span', { class: 'u', text: '번 테이블' })),
        h('div', { class: 'ometa' }, h('div', { class: 'dep-amt' }, won(r.amount)), h('div', { class: 'line' }, h('span', { class: 'tag warn' }, REFUND_WHY[r.reason] || r.reason), h('span', { class: 'tag mute' }, '주문 #' + r.orderId), SC.timeEl(r.createdAt, 'ago')))),
      h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: function () { refundSheet(((X.S.data && X.S.data.refunds) || []).filter(function (x) { return x.id === r.id && !x.doneAt; })[0] || r); } }, '환불 완료 처리'));
  }
  // The entry (amount + order updatedAt) is captured when the sheet opens; the server must see exactly that amount.
  function refundSheet(r0) {
    openSheet('환불 완료', function (s) {
      var method = 'cash', memo = '';
      function show(r, warnText) {
        var noteIn = h('input', { class: 'field', type: 'text', maxlength: '60', placeholder: '메모 (선택, 60자)', 'aria-label': '환불 메모', value: memo, oninput: function () { memo = noteIn.value; } });
        var segBtns = {};
        var seg = h('div', { class: 'al-seg' }, ['cash', 'transfer', 'other'].map(function (m) {
          var b = h('button', { class: 'btn', type: 'button', 'aria-pressed': String(m === method), onclick: function () { method = m; Object.keys(segBtns).forEach(function (k) { segBtns[k].setAttribute('aria-pressed', String(k === m)); }); } }, METHOD[m]); segBtns[m] = b; return b;
        }));
        var go = X.abtn('btn btn-primary btn-block', won(r.amount) + ' 돌려줬어요', function () {
          var body = { amount: r.amount, method: method };
          if (memo.trim()) body.note = memo.trim();
          if (r.updatedAt != null) body.expectedUpdatedAt = r.updatedAt;
          return X.api('/api/staff/refunds/' + r.id + '/done', body).then(function () {
            SC.toast(r.table + '번 · ' + won(r.amount) + ' 환불 완료로 기록했어요 (' + METHOD[method] + ')', 'ok');
            return X.refresh().then(function () { if (SO.reloadSales) SO.reloadSales(); s.close(); });
          }, function (e) {
            if (e.code === 'refund_changed' && e.data && e.data.refund) { // never resend silently: show the new entry and ask again
              var cur = e.data.refund;
              X.refresh();
              show(cur, '환불 금액이 ' + won(r.amount) + ' → ' + won(cur.amount) + '으로 바뀌었어요. 다시 확인해 주세요.');
              return;
            }
            if (e.code === 'stale') {
              return X.refresh().then(function () {
                var cur = ((X.S.data && X.S.data.refunds) || []).filter(function (x) { return x.id === r.id && !x.doneAt; })[0];
                if (!cur) { SC.toast(STALE, 'error'); s.close(); return; }
                show(cur, STALE + (cur.amount !== r.amount ? ' (환불 금액 ' + won(r.amount) + ' → ' + won(cur.amount) + ')' : ''));
              });
            }
            if (e.code === 'refund_done' || e.code === 'no_refund') { SC.toast(SC.errText(e), 'error'); X.refresh(); s.close(); return; }
            throw e;
          });
        });
        s.show(view(s, '돈을 돌려줬나요?', r.table + '번 테이블 · 주문 #' + r.orderId + ' · ' + (REFUND_WHY[r.reason] || r.reason), null, [
          warnText ? note('bad', warnText) : null,
          beforeAfter([['돌려줄 돈', won(r.amount), '0원', 'ok'], ['기록', '환불 대기', '환불 완료']]),
          h('div', { class: 'lab' }, '돌려준 방법', seg), h('label', { class: 'lab' }, '메모', noteIn),
          note('info', '손님에게 ' + won(r.amount) + '을 실제로 돌려준 뒤에 눌러 주세요. 기록은 되돌릴 수 없어요.')], go));
      }
      show(r0, null);
    });
  }

  // ---------------------------------------------------------------- notice strip (staff top) + settings sections
  SO.buildNoticeStrip = function () {
    var txt = h('span', { class: 'ntxt' }), box = h('div', { class: 'notice-strip', role: 'status', hidden: true }, h('b', null, '손님 화면 공지'), txt,
      h('button', { class: 'btn btn-sm', type: 'button', onclick: function () { if (SO.goSettings) SO.goSettings('notice'); } }, '고치기'));
    return { el: box, update: function (d) { var n = d.notice; box.hidden = !n; if (n) { box.dataset.level = n.level; if (txt.textContent !== n.text) txt.textContent = n.text; } } };
  };
  var NOTICE_PRESETS = ['재료가 거의 떨어졌어요', '주문이 밀려서 조금 늦어요', '10분 뒤에 다시 열어요'];
  SO.noticeSection = function () {
    var cur = null, dirty = false, level = 'info';
    var input = h('input', { class: 'field', type: 'text', maxlength: '80', placeholder: '손님 화면 위에 띄울 안내 (80자까지)', 'aria-label': '공지 내용', oninput: function () { dirty = true; count(); } });
    var cnt = h('span', { class: 'muted num' }), state = h('p', { class: 'muted' });
    var segBtns = {};
    var seg = h('div', { class: 'al-seg', role: 'group', 'aria-label': '공지 종류' }, [['info', '안내'], ['warn', '주의']].map(function (t) {
      var b = h('button', { class: 'btn', type: 'button', 'aria-pressed': String(t[0] === level), onclick: function () { level = t[0]; dirty = true; mark(); } }, t[1]); segBtns[t[0]] = b; return b;
    }));
    function mark() { Object.keys(segBtns).forEach(function (k) { segBtns[k].setAttribute('aria-pressed', String(k === level)); }); }
    function count() { cnt.textContent = input.value.length + ' / 80'; }
    function post(text, lv) {
      return X.api('/api/staff/notice', { text: text, level: lv }).then(function () { dirty = false; SC.toast(text ? '공지를 올렸어요' : '공지를 내렸어요', 'ok'); return X.refresh(); }, toastErr);
    }
    var save = X.abtn('btn btn-primary', '공지 올리기', function () {
      var t = input.value.trim();
      if (!t) { SC.toast('내용을 입력해 주세요. 내리려면 "공지 내리기"를 눌러요.', 'error'); return Promise.resolve(); }
      return post(t, level);
    });
    var clear = X.abtn('btn btn-danger', '공지 내리기', function () { input.value = ''; count(); return post('', level); });
    var presets = h('div', { class: 'al-seg' }, NOTICE_PRESETS.map(function (t) { return h('button', { class: 'btn btn-sm', type: 'button', onclick: function () { input.value = t; dirty = true; count(); } }, t); }));
    count();
    var el0 = h('div', { class: 'card' }, state, h('label', { class: 'lab' }, '공지 내용', input, cnt), h('div', { class: 'lab' }, '종류', seg), presets, h('div', { class: 'al-seg' }, save, clear),
      h('p', { class: 'muted' }, '손님 주문 화면 · 대기 화면 · 전광판에 같이 보여요. 영업 마감이나 전체 초기화 때 자동으로 내려가요.'));
    return { el: el0, update: function (d) {
      cur = d.notice;
      state.textContent = cur ? '지금 올라가 있는 공지 (' + (cur.level === 'warn' ? '주의' : '안내') + '): ' + cur.text : '지금 올라가 있는 공지가 없어요.';
      if (!dirty && document.activeElement !== input) { input.value = cur ? cur.text : ''; level = cur ? cur.level : 'info'; mark(); count(); }
    } };
  };
  SO.waitTimeoutSection = function () {
    var minutes = 5, dirty = false;
    var num = h('input', { class: 'field', type: 'number', inputmode: 'numeric', min: '1', max: '30', step: '1', 'aria-label': '호출 후 대기 시간(분)', oninput: function () { dirty = true; } });
    var apply = X.abtn('btn btn-primary', '적용', function () {
      var m = Number(num.value);
      if (!Number.isInteger(m) || m < 1 || m > 30) { SC.toast(ERR.bad_minutes, 'error'); return Promise.resolve(); }
      return X.api('/api/staff/waitlist/timeout', { minutes: m }).then(function () { dirty = false; SC.toast('호출 후 ' + m + '분 안에 안 오면 노쇼로 표시해요', 'ok'); return X.refresh(); }, toastErr);
    });
    function nudge(d) { num.value = String(Math.max(1, Math.min(30, (parseInt(num.value, 10) || minutes) + d))); dirty = true; }
    var box = h('div', { class: 'card' }, h('p', { class: 'muted' }, '대기 손님을 "입장 호출"한 뒤 이 시간 안에 앉지 않으면 "노쇼"로 표시돼요. 노쇼는 한 번 다시 부를 수 있어요.'),
      h('div', { class: 'stockctl' }, h('button', { class: 'btn btn-sm', type: 'button', onclick: function () { nudge(-1); }, 'aria-label': '1분 줄이기' }, '−'), num, h('span', null, '분'), h('button', { class: 'btn btn-sm', type: 'button', onclick: function () { nudge(1); }, 'aria-label': '1분 늘리기' }, '+'), apply));
    return { el: box, update: function (d) { minutes = d.waitCallTimeoutMin || 5; if (!dirty && document.activeElement !== num) num.value = String(minutes); } };
  };
  var AUDIT_LABEL = {
    order_create_staff: '직원 주문', order_status: '주문 상태', order_paid: '입금 받음', order_unpaid: '입금 취소', order_cancel: '주문 취소', order_edit: '주문 수정', order_service: '서비스 추가', order_move: '주문 이동',
    table_clear: '테이블 정리', table_unclear: '정리 되돌리기', table_move: '자리 이동', refund_done: '환불 완료', coupon_manual: '쿠폰 직접 발급', coupon_void: '쿠폰 무효', coupon_redeem: '쿠폰 사용',
    deposit_assign: '입금 연결', deposit_attach: '입금 알림 연결', deposit_dismiss: '입금 알림 무시', deposit_auto: '입금 자동 확인', deposit_auto_setting: '자동 확인 설정', deposit_secret_rotate: '알림 주소 재발급',
    menu_create: '메뉴 추가', menu_update: '메뉴 변경', pay_settings: '결제 설정', member_discount: '회원 할인 설정', notice: '공지', ordering: '주문 받기 켜기/끄기', table_count: '테이블 수', table_rotate: 'QR 교체',
    wait_timeout: '노쇼 시간', reset: '전체 초기화', day_close: '영업 마감', login: '로그인', lockout: '로그인 잠금', staff_action: '직원 작업',
  };
  SO.auditSection = function () {
    var list = h('div', { class: 'list' }), more = h('button', { class: 'btn btn-block', type: 'button' }, '더 보기'), next = null, loaded = false, opened = false;
    var box = h('details', { class: 'hist audit' }, h('summary', null, '작업 기록 보기'), h('p', { class: 'muted' }, '누가 언제 무엇을 바꿨는지 최신순으로 남아요. 읽기만 할 수 있어요.'), list, more);
    function row(e) {
      return h('div', { class: 'row-card audit-row' }, h('div', { class: 'grow' }, h('span', { class: 'tag mute' }, AUDIT_LABEL[e.action] || e.action), h('span', null, e.summaryKo || e.summary || ''), h('span', { class: 'muted' }, SC.clock(e.at) + ' · ' + SC.agoText(e.at))));
    }
    function load(reset) {
      var q = '/api/staff/audit?limit=50' + (!reset && next ? '&before=' + next : '');
      return SC.api(q).then(function (r) {
        if (reset) list.replaceChildren();
        r.entries.forEach(function (e) { list.appendChild(row(e)); });
        if (reset && !r.entries.length) list.appendChild(X.emptyEl('아직 기록이 없어요'));
        next = r.next; more.hidden = !next; loaded = true;
      }, toastErr);
    }
    more.addEventListener('click', function () { SC.act(more, function () { return load(false); }); });
    box.addEventListener('toggle', function () { if (box.open && !loaded) load(true); });
    var refresh = X.abtn('btn btn-sm', '새로고침', function () { return load(true); });
    box.insertBefore(refresh, list);
    return { el: box, update: function () { /* loads on open */ } };
  };
  SO.logAction = null;

  // ---------------------------------------------------------------- sales extras: 미수금 list, day close, past reports
  function moneyRow(r, kind) {
    return h('div', { class: 'row-card' },
      h('div', { class: 'grow' }, h('b', null, r.table + '번 · 주문 #' + r.orderId), h('span', { class: 'muted num' }, '합계 ' + won(r.total) + (r.paidAmount ? ' · 받은 ' + won(r.paidAmount) : '') + (r.writtenOffAt ? ' · ' + SC.agoText(r.writtenOffAt) + ' 정리' : ''))),
      h('b', { class: 'num owe-amt' }, '남은 ' + won(r.balance)),
      h('button', { class: 'btn ' + (kind === 'wo' ? 'btn-primary' : ''), type: 'button', onclick: function () { SO.openPayFor(r); } }, kind === 'wo' ? '나중에 받음' : '입금 받기'));
  }
  SO.salesExtras = function (r) {
    var out = [];
    var un = r.unpaid || [], wo = r.writtenOff || [];
    if (un.length) out.push(h('div', { class: 'card' }, h('h3', { class: 'sec-title', style: 'margin:0' }, '미결제 주문 ' + un.length + '건'), h('p', { class: 'muted' }, '테이블에 아직 앉아 있는 손님의 못 받은 돈이에요.'), un.map(function (x) { return moneyRow(x, 'un'); })));
    if (wo.length) out.push(h('div', { class: 'card' }, h('h3', { class: 'sec-title', style: 'margin:0' }, '미수금 ' + wo.length + '건 · ' + won(wo.reduce(function (a, x) { return a + x.balance; }, 0))), h('p', { class: 'muted' }, '테이블을 강제로 정리하면서 못 받은 돈이에요. 매출에는 들어가지 않고, 나중에 받으면 "나중에 받음"으로 기록해요.'), wo.map(function (x) { return moneyRow(x, 'wo'); })));
    return out;
  };
  var TILE_HELP = {
    revenue: '받은 돈에서 이미 돌려준 돈을 뺀 금액',
    billed: '취소 빼고, 할인 뒤 청구한 금액 합계',
    paid: '취소하지 않은 주문에서 실제로 받은 돈',
    unpaid: '테이블에 남아 있는 못 받은 돈',
    wo: '테이블 강제 정리로 못 받고 넘긴 돈 (매출 제외)',
    refundDue: '아직 손님에게 돌려주지 못한 돈',
    refundsDone: '손님에게 이미 돌려준 돈',
  };
  SO.TILE_HELP = TILE_HELP;
  // by payment method: received / refunded / net / count (server ledger; Σ net = 실제 받은 돈)
  SO.methodCard = function (bm) {
    if (!bm) return null;
    var tiles = ['transfer', 'cash', 'other'].map(function (m) {
      var x = bm[m] || { received: 0, refunded: 0, net: 0, count: 0 };
      return h('div', { class: 'tile' }, h('span', { class: 'k' }, METHOD[m] + ' · ' + x.count + '건'), h('span', { class: 'v' }, won(x.net)),
        h('span', { class: 'help' }, '받은 ' + won(x.received) + ' − 환불 ' + won(x.refunded)));
    });
    return h('div', { class: 'card' }, h('h3', { class: 'sec-title', style: 'margin:0' }, '결제 방법별'),
      h('p', { class: 'muted' }, '큰 숫자는 순수입(받은 돈 − 돌려준 돈)이고 세 방법을 더하면 "실제 받은 돈"과 같아요. 건수는 받은 횟수예요.'), h('div', { class: 'tiles' }, tiles));
  };
  SO.dayCloseCard = function (afterClose) {
    var reportsBox = h('div', { class: 'list' }), reportsSum = h('summary', null, '지난 영업일 리포트'), loaded = false;
    var det = h('details', { class: 'hist' }, reportsSum, reportsBox);
    function loadReports() {
      return SC.api('/api/staff/day/reports').then(function (r) {
        loaded = true; reportsSum.textContent = '지난 영업일 리포트 (' + r.reports.length + ')';
        SC.fill(reportsBox, r.reports.length ? r.reports.map(function (x) {
          return h('div', { class: 'row-card' },
            h('div', { class: 'grow' }, h('b', null, x.label), h('span', { class: 'muted num' }, '받은 돈 ' + won(x.totals && x.totals.revenue) + ' · 주문 ' + (x.totals ? x.totals.orders : 0) + '건')),
            h('button', { class: 'btn', type: 'button', onclick: function () { reportSheet(x.id); } }, '보기'),
            h('a', { class: 'btn', href: BASE + '/api/staff/day/reports/' + x.id + '.csv', download: 'booth-day-' + x.id + '.csv' }, 'CSV'));
        }) : X.emptyEl('아직 마감한 영업일이 없어요'));
      }, function () { /* silent: shown on next open */ });
    }
    det.addEventListener('toggle', function () { if (det.open) loadReports(); });
    function showNums(e, force) {
      var d = e.data || {}, rf = d.refundDue || {}, up = d.unpaid || {}, us = d.unserved || {}, wo = d.writtenOff || {};
      var rows = [];
      if (rf.entries) rows.push('환불 대기 ' + rf.entries + '건 · ' + won(rf.amount));
      if (up.orders) rows.push('미결제 주문 ' + up.orders + '건 · ' + won(up.amount));
      if (us.orders) rows.push('서빙 안 된 주문 ' + us.orders + '건');
      if (wo.orders) rows.push('미수금 ' + wo.orders + '건 · ' + won(wo.amount));
      return SC.confirm({ title: '아직 정리 안 된 게 있어요', danger: true, ok: '그래도 마감', cancel: '돌아가기', message: rows.join('\n') + '\n\n그래도 마감하면 이 항목들이 리포트에 그대로 적히고, 오늘 데이터는 지워져요.' });
    }
    function close(force) {
      var body = { confirm: '마감' };
      if (force) body.force = true;
      return X.api('/api/staff/day/close', body).then(function (r) {
        SC.toast('영업을 마감했어요 · 리포트 ' + (r.report && r.report.label || '') + ' 저장', 'ok');
        loaded = false; if (afterClose) afterClose();
        return X.refresh().then(function () { if (det.open) loadReports(); if (r.report) reportSheet(r.report.id); });
      }, function (e) {
        if (e.code === 'open_items') return showNums(e, force).then(function (ok) { if (ok) return close(true); });
        throw e;
      });
    }
    var card = h('div', { class: 'card' },
      h('h3', { class: 'sec-title', style: 'margin:0' }, '영업 마감'),
      h('p', { class: 'muted' }, '오늘 매출을 리포트로 저장하고 주문 · 쿠폰 · 호출 · 대기 명단을 비워요. 메뉴와 설정은 그대로 남고, 작업 기록과 지난 리포트도 남아요. 저장 전에 자동으로 백업해요.'),
      X.abtn('btn btn-solid-danger', '영업 마감…', function () {
        return SC.confirm({ title: '오늘 영업을 마감할까요?', danger: true, typed: '마감', ok: '영업 마감', message: '리포트를 저장한 뒤 오늘 데이터를 지워요. 되돌릴 수 없어요.' }).then(function (ok) { if (ok) return close(false); });
      }), det);
    return card;
  };
  function reportSheet(id) {
    openSheet('영업 리포트', function (s) {
      s.show(view(s, '리포트 불러오는 중…', null, null, [X.emptyEl('잠시만요')]));
      SC.api('/api/staff/day/reports/' + id).then(function (r) {
        var t = r.totals || {};
        function tile(k, v, c) { return h('div', { class: 'tile ' + (c || '') }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v)); }
        var body = [h('div', { class: 'tiles' }, tile('받은 돈', won(t.revenue), 'hl'), tile('주문', (t.orders || 0) + '건'), tile('환불 완료', won(t.refundsDone)), tile('환불 대기', won(t.refundDue), t.refundDue ? 'bad' : ''), tile('미결제', won(t.unpaidRevenue), t.unpaidRevenue ? 'bad' : ''), tile('미수금', won(t.writtenOff), t.writtenOff ? 'bad' : '')),
          SO.methodCard(r.byMethod),
          r.forced ? note('warn', '정리 안 된 항목이 있는 채로 마감한 리포트예요.') : null,
          (r.unpaid || []).length ? h('div', null, h('h3', { class: 'sec-title' }, '마감 때 미결제 ' + r.unpaid.length + '건'), r.unpaid.map(function (x) { return h('div', { class: 'row-card' }, h('div', { class: 'grow' }, h('b', null, x.table + '번 · #' + x.orderId), h('span', { class: 'muted num' }, '합계 ' + won(x.total) + ' · 받은 ' + won(x.paidAmount))), h('b', { class: 'num' }, '남은 ' + won(x.balance))); })) : null,
          (r.writtenOff || []).length ? h('div', null, h('h3', { class: 'sec-title' }, '미수금 ' + r.writtenOff.length + '건'), r.writtenOff.map(function (x) { return h('div', { class: 'row-card' }, h('div', { class: 'grow' }, h('b', null, x.table + '번 · #' + x.orderId), h('span', { class: 'muted num' }, '합계 ' + won(x.total))), h('b', { class: 'num' }, won(x.balance))); })) : null,
          (r.refunds || []).length ? h('div', null, h('h3', { class: 'sec-title' }, '환불 ' + r.refunds.length + '건'), r.refunds.map(function (x) { return h('div', { class: 'row-card' }, h('div', { class: 'grow' }, h('b', null, x.table + '번 · ' + won(x.amount)), h('span', { class: 'muted' }, (REFUND_WHY[x.reason] || x.reason) + ' · ' + (x.doneAt ? '돌려줌' : '못 돌려줌'))), x.doneAt ? h('span', { class: 'tag ok' }, '완료') : h('span', { class: 'tag bad' }, '대기')); })) : null,
          h('a', { class: 'btn btn-block', href: BASE + '/api/staff/day/reports/' + id + '.csv', download: 'booth-day-' + id + '.csv' }, 'CSV 내려받기')];
        s.show(view(s, r.label + ' 영업 리포트', '마감 후에는 바뀌지 않아요', null, body));
      }, function (e) { s.show(view(s, '리포트를 열 수 없어요', null, null, [note('bad', SC.errText(e))])); });
    });
  }
  SO.reportSheet = reportSheet;

  // ---------------------------------------------------------------- tables: undo clear + ticking countdown
  SO.undoClear = function (n) {
    return X.api('/api/staff/tables/' + n + '/unclear').then(function () { SC.toast(n + '번 테이블 정리를 되돌렸어요', 'ok'); return X.refresh(); }, function (e) { toastErr(e); X.refresh(); });
  };
  SO.untilText = function (until) { var m = Math.max(0, Math.ceil((until - Date.now()) / 60000)); return m + '분 남음'; };
  setInterval(function () {
    document.querySelectorAll('[data-until]').forEach(function (b) {
      var u = Number(b.dataset.until);
      if (u <= Date.now()) { b.hidden = true; return; }
      var t = '정리 되돌리기 (' + SO.untilText(u) + ')';
      if (b.textContent !== t) b.textContent = t;
    });
  }, 15000);
}());

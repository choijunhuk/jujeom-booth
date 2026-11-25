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
    amount_guessed: '문자에서 읽은 금액이 확실하지 않아요. 은행 앱에서 실제 입금액을 확인하고 직접 입력해 주세요.',
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
    seat_changed: '테이블 상황이 바뀌었습니다. 다시 확인해 주세요.',
    coupon_moved: '다른 직원이 먼저 이 쿠폰을 옮겼습니다.',
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
    test_table: '테스트 테이블과 실제 테이블 사이로는 옮길 수 없어요.',
    bad_member_preview: '"COMS 회원으로 보기" 값이 올바르지 않아요.',
    bad_show_in_kitchen: '"주방에 테스트 주문 표시" 값이 올바르지 않아요.',
    cover_order: '입장료 주문은 이 방법으로 바꿀 수 없어요. 테이블 화면의 입장료 칸에서 처리해 주세요.',
    cover_conflict: '두 테이블 모두 입장료가 있어서 합칠 수 없어요. 한쪽 입장료를 먼저 면제해 주세요.',
    party_set: '이미 인원이 입력됐어요. 화면을 새로 불러올게요.',
    party_not_asked: '손님에게 인원 묻기가 꺼져 있어요.',
    party_required: '인원을 먼저 입력해야 주문할 수 있어요.',
    bad_people: '인원은 1~30명 사이 정수예요.',
    bad_shares: '몇 명분인지 올바르지 않아요. 1명분 이상의 정수로, 1인당 입장료에만 쓸 수 있어요.',
    bad_payer: '이름은 눈에 보이는 글자 1~10자로 입력해 주세요.',
    no_payment: '없는 결제 기록이에요. 화면을 새로 불러올게요.',
    payment_void: '이미 취소된 결제 기록이에요.',
    cannot_void: '이미 돌려준 환불이 있어서 이 결제 기록을 지울 수 없어요.',
    no_cover: '이 자리에는 입장료 주문이 없어요.',
    bad_reason: '사유를 1~30자로 입력해 주세요.',
    bad_table: '테이블 번호가 올바르지 않아요.',
    no_intent: '이미 처리됐거나 만료된 "낼게요"예요. 화면을 새로 불러올게요.',
    too_many_shares: '남은 인원보다 많은 "낼게요"는 만들 수 없어요.',
    coupon_limit: '이 테이블은 할인 쿠폰을 더 쓸 수 없어요.',
    exceeds_balance: '남은 금액보다 많이 받을 수는 없어요. 화면을 새로 불러올게요.',
    bad_coupon_limit: '쿠폰 제한은 0 또는 1~50 사이 정수예요. (0 = 제한 없음)',
    bad_per_seat: '쿠폰 한도는 0~20장 사이 정수예요. (0 = 쿠폰 없음)',
    too_many_intents: '"낼게요" 요청이 너무 많아요.',
    bad_enabled: '켜기/끄기 값이 올바르지 않아요.',
    bad_mode: '방식을 1인당 또는 테이블당으로 골라 주세요.',
    bad_require_before_order: '인원 입력 필수 값이 올바르지 않아요.',
    bad_ask_guest: '손님에게 인원 묻기 값이 올바르지 않아요.',
    no_device: '손님 기기 정보가 없어요.',
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
    if (e && e.code === 'too_many_shares' && e.data && e.data.left != null) return '남은 몫은 ' + e.data.left + '명분이에요. 화면을 새로 불러올게요.';
    if (e && e.code === 'exceeds_balance' && e.data && e.data.balance != null) return '남은 금액은 ' + won(e.data.balance) + '이에요. 그보다 많이 받을 수 없어요. 화면을 새로 불러올게요.';
    if (e && e.code === 'coupon_limit') return '옮기려는 테이블은 이미 할인 쿠폰을 ' + (e.data && e.data.used != null ? e.data.used : '') + '장 썼어요' + (e.data && e.data.max != null ? ' (최대 ' + e.data.max + '장)' : '') + '.';
    if (e && e.code === 'intent_stale') return '이 요청의 인원이 남은 몫보다 많아요.';
    if (e && e.code === 'cannot_undo') {
      var u = e.data && e.data.used;
      if (e.data && e.data.reason === 'seat_in_use' && u) {
        var names = { orders: '주문', plays: '게임 기록', coupons: '쿠폰', nicks: '닉네임', calls: '호출', party: '인원', intents: '"낼게요" 요청' }, parts = [];
        Object.keys(names).forEach(function (k) { if (u[k]) parts.push(names[k] + (typeof u[k] === 'number' && k !== 'party' ? ' ' + u[k] + '건' : '')); });
        if (parts.length) return '새 손님 자리가 이미 쓰이고 있어서 되돌릴 수 없어요. (' + parts.join(' · ') + ')';
      }
      return UNDO_WHY[e.data && e.data.reason] || '정리를 되돌릴 수 없어요.';
    }
    return (e && ERR[e.code]) || (e && e.message) || '요청에 실패했어요.';
  };
  SO.ERR = ERR;

  // ---------------------------------------------------------------- helpers
  var METHOD = { transfer: '계좌이체', cash: '현금', other: '기타' };
  var METHOD_BY = { transfer: '계좌이체로', cash: '현금으로', other: '기타 방법으로' };
  SO.METHOD = METHOD;
  function el(tag, cls, kids) { return h(tag, cls ? { class: cls } : null, kids); }
  function tname(n) { return n === 0 ? '테스트' : n + '번 테이블'; }
  SO.tname = tname;
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
  function toastErr(e) { SC.toast(SC.errText(e), 'error'); if (e.code === 'stale' || e.code === 'seat_changed' || e.code === 'coupon_moved' || e.code === 'no_order' || e.code === 'unknown_item' || e.code === 'no_wait' || e.code === 'no_coupon' || e.code === 'no_refund' || e.code === 'not_noshow' || e.code === 'exceeds_balance') X.refresh(); }
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
        SC.isTestOrder(o) ? null : act('다른 테이블로 옮기기', '이 주문 1건만 · 쿠폰은 원래 자리에 남아요', '', function () { moveView(s, o); }),
        act('주문 취소', o.paidAmount ? '받은 ' + won(holdOf(o)) + '은 환불 대기에 올라가요' : '되돌릴 수 없어요', 'danger', function () { cancelView(s, o); })));
    } else body.push(note('info', '취소된 주문이에요. 돌려줄 돈이 있으면 "입금" 탭의 환불 대기에서 처리해요.'));
    if ((o.payments || []).length) body.push(h('div', null, h('h4', { class: 'sub-title' }, '결제 기록 ' + o.payments.length + '건'), paymentsList(s, o, function () { orderHome(s, o); })));
    s.show(view(s, tname(o.table) + ' · 주문 #' + o.id, STATUS_TEXT[o.status] + ' · ' + SC.agoText(o.createdAt), null, body));
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
    s.show(view(s, '입금 받기', tname(o.table) + ' · 주문 #' + o.id, back, body, confirmBtn));
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
    s.show(view(s, '주문 수정', tname(o.table) + ' · 주문 #' + o.id, function () { orderHome(s, o); }, body, save));
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
    s.show(view(s, '서비스 추가', tname(o.table) + ' · 주문 #' + o.id, function () { orderHome(s, o); }, body, go));
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
    s.show(view(s, '다른 테이블로 옮기기', tname(o.table) + ' · 주문 #' + o.id, function () { orderHome(s, o); }, body, go));
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
    s.show(view(s, '주문을 취소할까요?', tname(o.table) + ' · 주문 #' + o.id, function () { orderHome(s, o); }, body, go));
  }

  // ---------------------------------------------------------------- table sheet (direct order, manual coupon)
  // ================================================================ headcount + cover charge (입장료) + share payments
  function coverCfg() { return (X.S.data && X.S.data.cover) || { enabled: false, mode: 'per_person', amount: 0, label: '입장료' }; }
  function coverLabel() { return coverCfg().label || '입장료'; }
  // Korean particle by final consonant: jo('입장료','은','는')
  function jo(w, withFinal, without) { var c = String(w).charCodeAt(String(w).length - 1); return w + ((c >= 0xAC00 && c <= 0xD7A3) ? ((c - 0xAC00) % 28 === 0 ? without : withFinal) : without); }
  // table 0 (the guest test table) is not in state.tables: build the same shape from state.testTable
  function testAsTable(tt) { return Object.assign({}, tt, { number: 0, status: tt.people != null || tt.orderCount ? 'occupied' : 'empty', cover: tt.coverOrderId != null ? { orderId: tt.coverOrderId, status: 'served', waived: false } : null }); }
  function tableOf(n) { if (n === 0 && X.S.data && X.S.data.testTable) return testAsTable(X.S.data.testTable); return ((X.S.data && X.S.data.tables) || []).filter(function (t) { return t.number === n; })[0] || { number: n, status: 'empty' }; }
  function coverOrderOf(n) { var t = tableOf(n); return t.cover && t.cover.orderId != null ? fresh(t.cover.orderId) : null; }
  function anyCover() { return ((X.S.data && X.S.data.tables) || []).some(function (t) { return !!t.cover; }); }
  SO.coverUIOn = function () { return !!(X.S.data && (coverCfg().enabled || anyCover())); };
  SO.coverChip = function (t) {
    if (!t.cover) return null;
    var o = fresh(t.cover.orderId);
    if (t.cover.waived || (o && o.waived)) return { text: coverLabel() + ' 면제', cls: 'mute' };
    if (!o) return null;
    if (o.paid) return { text: coverLabel() + ' 완납', cls: 'ok' };
    if (o.shares && o.shares.paid > 0) return { text: o.shares.paid + '/' + o.shares.total + '명 납부', cls: 'warn' };
    if (holdOf(o) > 0) return { text: '일부 납부', cls: 'warn' };
    return { text: coverLabel() + ' 미납', cls: 'bad' };
  };
  SO.peopleText = function (t) { return t.people != null ? t.people + '명' : '인원 미입력'; };
  SO.tileSig = function (t) { var c = SO.coverChip(t); return [c && c.text, SO.coverUIOn()]; };
  function partyOf(t) { return t.people != null ? t.people + '명' : '인원 미입력'; }
  function payerOf(p) { return p.payer || '이름 없음'; }
  function tm(ts) { return SC.clock(ts); }

  SO.openTableSheet = function (n) { openSheet('테이블 더보기', function (s) { tableHome(s, n); }); };
  function tableHome(s, n) {
    var d = X.S.data, t = tableOf(n), co = coverOrderOf(n);
    function act(title, sub, go) { return h('button', { class: 'btn bigact', type: 'button', onclick: go }, h('b', null, title), h('span', { class: 'muted' }, sub)); }
    var closed = d && d.orderingOpen === false;
    var body = [h('div', { class: 'card tsum' },
      h('div', { class: 'row-card' }, h('div', { class: 'grow' }, h('span', { class: 'muted' }, '인원'), h('span', { class: 'big' }, partyOf(t) + (t.minutesSeated != null ? ' · ' + t.minutesSeated + '분째' : '')), partyWho(t) ? h('span', { class: 'muted' }, partyWho(t)) : null),
        h('div', { class: 'btns' },
          t.people != null && typeof t.headcountTrusted === 'boolean' ? h('span', { class: 'tag ' + (t.headcountTrusted ? 'ok' : 'warn') }, t.headcountTrusted ? '확인됨' : '손님 입력 (미확인)') : null,
          t.people != null && t.headcountTrusted === false ? X.abtn('btn btn-sm', '인원 확인', function () {   // re-posts the same number as staff: it then counts for the coupon limit
            var b = { people: t.people }; if (n !== 0 || t.partyUpdatedAt != null) b.expectedUpdatedAt = t.partyUpdatedAt || 0;
            return X.api('/api/staff/tables/' + n + '/party', b).then(function () { SC.toast(n + '번 인원 ' + t.people + '명을 확인했어요', 'ok'); return X.refresh(); }, toastErr);
          }) : null,
          h('button', { class: 'btn', type: 'button', onclick: function () { partyView(s, n); } }, '인원 바꾸기'))))];
    if (SO.coverUIOn()) body.push(coverSection(s, n, t, co));
    body.push(couponLimitRow(s, n, t));
    var coupons = d.coupons.filter(function (c) { return c.table === n; });
    if (coupons.length) body.push(h('div', { class: 'card' }, h('h3', { class: 'sec-title' }, '이 자리 미사용 쿠폰'), coupons.map(function (c) {
      return h('div', { class: 'row-card' }, h('div', { class: 'grow' }, h('span', { class: 'code big' }, c.code), h('span', null, c.label)),
        X.abtn('btn btn-sm', '다른 테이블로', function () { return SO.moveCoupon(c); }));
    })));
    var sig0 = X.sig([t, co, d.cover, d.couponLimits, t.couponLimitOverride, t.couponLimits, t.headcountTrusted, coupons, (d.coverIntents || []).filter(function (i) { return i.table === n; })]);
    body.push(h('div', { class: 'bigacts' },
      act('직접 주문 넣기', closed ? '주문 마감 중에도 직원은 넣을 수 있어요' : '손님 대신 주문을 입력해요', function () { directView(s, n); }),
      act('쿠폰 직접 발급', '할인 쿠폰 · 상품 쿠폰을 이 자리에 바로 줘요', function () { couponView(s, n); }),
      act('손님 화면 열기', '새 탭으로 이 테이블의 손님 화면을 열어요', function () { openGuestScreen(n); })));
    s.nextOnState = function (nd) {
      var t2 = tableOf(n), co2 = coverOrderOf(n);
      if (X.sig([t2, co2, nd.cover, nd.couponLimits, t2.couponLimitOverride, t2.couponLimits, t2.headcountTrusted, nd.coupons.filter(function (c) { return c.table === n; }), (nd.coverIntents || []).filter(function (i) { return i.table === n; })]) !== sig0) tableHome(s, n);
    };
    s.show(view(s, n + '번 테이블 더보기', null, null, body));
  }

  // ---- 인원 바꾸기 (headcount) with the cover re-price from the server dry run
  var SET_BY = { guest: '손님 입력', staff: '직원 입력', waitlist: '대기 명단' };
  function partyWho(t) { return t.people != null && t.partySetBy ? (SET_BY[t.partySetBy] || '') + (t.partySetAt ? ' · ' + SC.agoText(t.partySetAt) : '') : ''; }
  function partyView(s, n) {
    var t = tableOf(n), co = coverOrderOf(n);
    var stamp = t.partyUpdatedAt || 0; // captured when the view opens
    var people = t.people != null ? t.people : 2, info = h('div');
    function body(extra) { return Object.assign(n === 0 && t.partyUpdatedAt == null ? { people: people } : { people: people, expectedUpdatedAt: stamp }, extra || {}); }   // test table: no stamp in state, so no stale check
    var dry = makeDry(function () { return X.api('/api/staff/tables/' + n + '/party', body({ dryRun: true })).then(function (r) { return { order: r.coverOrder || null }; }); }, draw);
    var go = X.abtn('btn btn-primary btn-block', '인원 저장', function () {
      var seen = dry.last && dry.last.order;
      return X.api('/api/staff/tables/' + n + '/party', body()).then(function (r) {
        var msg = n + '번 테이블 인원을 ' + people + '명으로 바꿨어요';
        if (r.coverOrder && seen) return finishMoney(s, '인원 변경', { order: r.coverOrder }, seen, msg + ' · ' + coverLabel() + ' ' + won(r.coverOrder.total));
        return finishMoney(s, '인원 변경', null, null, msg + (r.coverOrder ? ' · ' + coverLabel() + ' ' + won(r.coverOrder.total) : ''));
      }, function (e) { if (e.code === 'stale') X.refresh(); throw e; });
    });
    var st = stepper(function () { return people; }, function (v) { people = v; dry.schedule(); }, 1, 30, '인원');
    function draw() {
      var res = dry.last;
      go.disabled = dry.busy || !res || !!res.err || go.classList.contains('busy');
      if (dry.busy || !res) { SC.fill(info, h('p', { class: 'muted' }, '서버가 계산하는 중…')); return; }
      if (res.err) { SC.fill(info, errNote(res.err)); return; }
      var a = res.order;
      if (!a) { SC.fill(info, note('info', SO.coverUIOn() ? coverLabel() + ' 금액은 이 인원으로 바뀌지 않아요.' : '인원은 방문 인원 통계에 쓰여요.')); return; }
      var rows = co ? [[coverLabel() + ' 합계', won(co.total), won(a.total), a.total > co.total ? 'owe' : ''], ['받은 돈', won(holdOf(co)), won(holdOf(a))], ['남은 금액', won(co.balanceDue || 0), won(a.balanceDue || 0), a.balanceDue ? 'owe' : 'ok'], (a.refundDue || 0) || (co.refundDue || 0) ? ['돌려줄 돈', won(co.refundDue || 0), won(a.refundDue || 0), 'owe'] : null, a.shares ? ['납부 인원', co.shares ? co.shares.paid + '/' + co.shares.total + '명' : '', a.shares.paid + '/' + a.shares.total + '명'] : null]
        : [[coverLabel() + ' 주문', '없음', won(a.total) + ' (' + people + '명 × ' + won(a.unitPrice || 0) + ')']];
      SC.fill(info, beforeAfter(rows), (a.refundDue || 0) > (co ? co.refundDue || 0 : 0) ? note('warn', '이미 받은 돈이 새 ' + coverLabel() + '보다 ' + won(a.refundDue) + ' 많아요. 저장하면 환불 대기에 올라가요.') : null, a.shares && a.shares.over > 0 ? note('warn', a.shares.over + '명분 초과 납부가 돼요. 초과한 돈은 환불 대기에 올라가요.') : null);
    }
    s.show(view(s, '인원 바꾸기', n + '번 테이블 · 지금 ' + partyOf(t) + (partyWho(t) ? ' (' + partyWho(t) + ')' : ''), function () { tableHome(s, n); }, [h('div', { class: 'lab' }, '인원', st), info], go));
    s.onClose = dry.cancel;
    dry.schedule();
  }

  // ---- 쿠폰 한도 row of the table sheet: limit in force for this seating, per-seating override (cleared when the guests leave)
  // trust and limits come from the server only (tables[] / testTable: headcountTrusted, couponLimits [{ rewardId, limit, limitSource }]); never computed here
  var SRC_TXT = { people: ' (인원수 기준)', fixed: ' (고정)', override: ' (직접 지정)' };
  function limitsInForce(t) {
    if (!Array.isArray(t.couponLimits)) return null;
    var rw = (X.S.data && X.S.data.rewards) || [], name = {};
    rw.forEach(function (r) { name[r.id] = r.label; });
    return t.couponLimits.map(function (l) { return (name[l.rewardId] || '보상') + ' ' + (l.limit === 0 ? '쿠폰 없음' : l.limit + '장') + (SRC_TXT[l.limitSource] || ''); });
  }
  function couponLimitRow(s, n, t) {
    var ov = t.couponLimitOverride, box = h('div', { class: 'card' }), val = ov != null ? ov : 1;   // override 0 = no coupons for this seating
    var lim = limitsInForce(t), cl = (X.S.data && X.S.data.couponLimits) || {};
    box.appendChild(h('h3', { class: 'sec-title', style: 'margin:0' }, '쿠폰 한도'));
    box.appendChild(lim ? h('p', null, h('b', null, lim.length ? lim.join(' · ') : '보상이 없어요'), typeof t.headcountCounted === 'number' ? h('span', { class: 'muted' }, ' · 인정 인원 ' + t.headcountCounted + '명') : null) : h('p', { class: 'muted' }, '한도 정보를 불러오지 못했어요'));
    if (t.couponsIssued != null) box.appendChild(h('p', { class: 'muted num' }, '이번 손님이 받은 쿠폰 ' + t.couponsIssued + '장' + (cl.maxPerSeat ? ' / 총 ' + cl.maxPerSeat + '장까지' : '') + ' · 사용한 할인 쿠폰 ' + (t.discountUses || 0) + '장' + (cl.maxDiscountUsesPerSeat ? ' / ' + cl.maxDiscountUsesPerSeat + '장까지' : '')));
    var st = stepper(function () { return val; }, function (v) { val = v; }, 0, 20, '쿠폰 한도');
    box.appendChild(h('div', { class: 'stockctl' }, st, X.abtn('btn btn-sm', '이 자리만 적용', function () { return setOverride(val); }), ov != null ? X.abtn('btn btn-sm', '원래대로', function () { return setOverride(null); }) : null));
    box.appendChild(h('p', { class: 'muted' }, '0장으로 정하면 이 손님은 쿠폰을 못 받아요. 이 손님이 나가면 원래대로 돌아가요.'));
    function setOverride(v) {
      return X.api('/api/staff/tables/' + n + '/coupon-limit', { perSeat: v }).then(function () { SC.toast(v == null ? '쿠폰 한도를 원래대로 되돌렸어요' : n + '번 테이블 쿠폰 한도를 ' + v + '장으로 정했어요', 'ok'); return X.refresh(); }, toastErr);
    }
    return box;
  }

  // ---- 입장료 section of the table sheet
  function coverSection(s, n, t, co) {
    var cfg = coverCfg(), lab = coverLabel(), box = h('div', { class: 'card csec' });
    box.appendChild(h('h3', { class: 'sec-title', style: 'margin:0' }, lab));
    if (!co) {
      box.appendChild(note('info', cfg.enabled ? (cfg.mode === 'per_person' ? '인원을 입력하면 ' + lab + ' 주문이 만들어져요.' : '첫 주문이나 인원이 들어오면 ' + lab + ' 주문이 만들어져요.') : lab + ' 설정이 꺼져 있어요.'));
      return box;
    }
    var chip = SO.coverChip(t) || { text: '', cls: 'mute' };
    box.appendChild(h('div', { class: 'row-card' }, h('div', { class: 'grow' }, co.waived ? h('s', { class: 'big muted' }, won(co.total)) : h('b', { class: 'big' }, won(co.total)), h('span', { class: 'muted num' }, '받은 ' + won(holdOf(co)) + (co.balanceDue > 0 ? ' · 남은 ' + won(co.balanceDue) : '') + (co.coverMode === 'per_person' ? ' · ' + won(co.unitPrice) + ' × ' + (co.shares ? co.shares.total : '') + '명' : ' · 테이블당'))), h('span', { class: 'tag ' + chip.cls }, chip.text)));
    if (co.shares && co.shares.over > 0) box.appendChild(h('div', null, h('span', { class: 'tag warn' }, co.shares.over + '명분 초과 납부'), h('span', { class: 'muted' }, ' 초과한 돈은 입금 탭의 환불 대기에 올라가 있어요')));
    if (co.shares && !co.waived) {
      var segs = []; for (var i = 0; i < Math.min(co.shares.total, 30); i++) segs.push(h('i', { class: i < co.shares.paid ? 'on' : '' }));
      box.appendChild(h('div', { class: 'sprog' }, h('span', { class: 'y2k-progress', role: 'img', 'aria-label': co.shares.paid + '명분 납부, ' + co.shares.left + '명분 남음' }, segs), h('b', { class: 'num' }, co.shares.paid + ' / ' + co.shares.total + '명분')));
    }
    if (co.waived) {
      box.appendChild(note('warn', lab + ' 면제됨' + (co.note ? ' · ' + String(co.note).replace(/^면제:\s*/, '') : '')));
      box.appendChild(X.abtn('btn btn-block', '면제 취소 (다시 받기)', function () {
        return SC.confirm({ title: lab + ' 면제를 취소할까요?', ok: '면제 취소', message: '현재 인원 ' + partyOf(t) + ' 기준으로 금액이 다시 계산돼요. 받은 돈이 있으면 그만큼 반영돼요.' }).then(function (ok) {
          if (!ok) return;
          return X.api('/api/staff/tables/' + n + '/cover/restore', { expectedUpdatedAt: co.updatedAt }).then(function (r) { SC.toast(lab + ' 면제를 취소했어요 · ' + won(r.order ? r.order.total : 0), 'ok'); return X.refresh(); });
        });
      }));
      return box;
    }
    var bal = co.balanceDue || 0, left = co.shares ? co.shares.left : 0, unit = co.unitPrice || 0;
    var quick = h('div', { class: 'quick-grid' });
    function qb(label, method, shares) {
      var b = X.abtn('btn', label, function () {
        var body = { paid: true, method: method };
        if (shares === 'rest') body.payBalance = true; else if (shares) body.shares = shares;
        return SO.omut(co, 'paid', body).then(function (r) { SC.toast(n + '번 · ' + METHOD[method] + ' ' + (shares > 0 ? shares + '명분 ' : shares === 'rest' ? '남은 ' + won(bal) + ' ' : '') + '받았어요' + (r.order && r.order.balanceDue > 0 ? ' (남은 ' + won(r.order.balanceDue) + ')' : ''), 'ok'); return X.refresh(); }, function (e) { if (e.code === 'too_many_shares' || e.code === 'exceeds_balance') X.refresh(); throw e; });
      });
      b.disabled = bal <= 0; quick.appendChild(b);
    }
    if (co.shares && left > 0) {
      // never offer a share button that would book more than the balance (held money is not always a whole number of shares)
      var fit = Math.min(left, unit > 0 ? Math.floor(bal / unit) : 0);
      if (fit >= 1) { qb('1명분 현금 · ' + won(unit), 'cash', 1); qb('1명분 이체 · ' + won(unit), 'transfer', 1); }
      if (fit >= 2 && fit === left) { qb('남은 전부 현금 · ' + left + '명분', 'cash', left); qb('남은 전부 이체 · ' + left + '명분', 'transfer', left); }
      if (unit > 0 && bal % unit !== 0) { qb('남은 ' + won(bal) + ' 받기 (현금)', 'cash', 'rest'); qb('남은 ' + won(bal) + ' 받기 (이체)', 'transfer', 'rest'); }
    } else {
      qb('전액 현금 · ' + won(bal), 'cash', 0); qb('전액 이체 · ' + won(bal), 'transfer', 0);
    }
    if (bal > 0) box.appendChild(quick);
    box.appendChild(h('button', { class: 'btn btn-block', type: 'button', onclick: function () { coverPayView(s, n, co); } }, '직접 입력 (몇 명분 · 금액 · 이름)'));
    // payments
    var pays = co.payments || [];
    box.appendChild(h('h4', { class: 'sub-title' }, '결제 기록 ' + pays.length + '건'));
    box.appendChild(paymentsList(s, co, function () { tableHome(s, n); }));
    // open intents of this table
    var its = ((X.S.data && X.S.data.coverIntents) || []).filter(function (i) { return i.table === n; });
    if (its.length) {
      box.appendChild(h('h4', { class: 'sub-title' }, '손님이 "낼게요"를 누른 건 ' + its.length + '건'));
      its.forEach(function (it) {
        box.appendChild(h('div', { class: 'row-card' }, h('div', { class: 'grow' }, h('b', null, it.payer + ' · ' + it.shares + '명분 · ' + won(it.amount)), h('span', { class: 'muted' }, SC.agoText(it.createdAt) + ' · 입금이 확인되면 자동으로 연결돼요')),
          X.abtn('btn btn-sm btn-danger', '취소', function () { return cancelIntent(it); })));
      });
    }
    box.appendChild(h('button', { class: 'btn btn-danger btn-block', type: 'button', onclick: function () { waiveView(s, n, co); } }, lab + ' 면제…'));
    return box;
  }
  function cancelIntent(it) {
    return X.api('/api/staff/cover/intents/' + it.id + '/cancel').then(function () { SC.toast('"' + it.payer + '" 낼게요 요청을 취소했어요', 'ok'); return X.refresh(); }, function (e) { toastErr(e); X.refresh(); });
  }
  SO.cancelIntent = cancelIntent;
  function paymentsList(s, o, back) {
    var pays = o.payments || [];
    if (!pays.length) return h('p', { class: 'muted' }, '아직 받은 기록이 없어요.');
    return h('div', { class: 'pays' }, pays.map(function (p) {
      return h('div', { class: 'row-card pay-row' }, h('div', { class: 'grow' }, h('b', null, payerOf(p) + (p.shares ? ' · ' + p.shares + '명분' : '') + ' · ' + won(p.amount)), h('span', { class: 'muted' }, (METHOD[p.method] || p.method || '') + ' · ' + tm(p.at))),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: function () { voidView(s, o, p, back); } }, '취소'));
    }));
  }

  // ---- 결제 기록 취소 (void): the entry was a mistake and no money was received
  function voidView(s, o, p, back) {
    var reasonIn = h('input', { class: 'field', type: 'text', maxlength: '30', placeholder: '사유 (1~30자) 예: 잘못 입력', 'aria-label': '취소 사유' }), err = h('div');
    var go = X.abtn('btn btn-solid-danger btn-block', '이 결제 기록 지우기', function () {
      var r = reasonIn.value.trim();
      if (!r) { SC.fill(err, note('bad', '사유를 적어 주세요. (1~30자)')); return Promise.resolve(); }
      SC.fill(err);
      var body = { reason: r };
      if (o.updatedAt != null) body.expectedUpdatedAt = o.updatedAt;
      return X.api('/api/staff/payments/' + p.id + '/void', body).then(function (res) {
        SC.toast('결제 기록을 지웠어요 · ' + payerOf(p) + ' ' + won(p.amount), 'ok');
        return X.refresh().then(function () { if (SO.reloadSales) SO.reloadSales(); s.close(); });
      }, function (e) { if (e.code === 'stale') X.refresh(); throw e; });
    });
    var held = holdOf(o), after = Math.max(0, held - p.amount), due = Math.max(0, o.total - after);
    s.show(view(s, '결제 기록을 지울까요?', tname(o.table) + ' · 주문 #' + o.id, back, [
      h('div', { class: 'osum' }, h('b', null, payerOf(p) + (p.shares ? ' · ' + p.shares + '명분' : '')), h('span', { class: 'muted' }, (METHOD[p.method] || '') + ' ' + won(p.amount) + ' · ' + tm(p.at))),
      beforeAfter([['받은 돈', won(held), won(after)], ['남은 금액', won(o.balanceDue || 0), won(due), due ? 'owe' : '']]),
      note('warn', '잘못 입력한 결제를 지워요. 실제로 돌려준 돈은 환불로 처리하세요.'),
      h('label', { class: 'lab' }, '사유', reasonIn), err], go));
  }
  SO.voidView = function (o, p) { openSheet('결제 기록 취소', function (s) { voidView(s, o, p, null); }); };

  // ---- 입장료 면제
  function waiveView(s, n, co) {
    var reasonIn = h('input', { class: 'field', type: 'text', maxlength: '30', placeholder: '사유 (1~30자) 예: 스태프 지인', 'aria-label': '면제 사유' }), err = h('div');
    var held = holdOf(co);
    var go = X.abtn('btn btn-solid-danger btn-block', coverLabel() + ' 면제하기', function () {
      var r = reasonIn.value.trim();
      if (!r) { SC.fill(err, note('bad', '사유를 적어 주세요. (1~30자)')); return Promise.resolve(); }
      SC.fill(err);
      return X.api('/api/staff/tables/' + n + '/cover/waive', { reason: r, expectedUpdatedAt: co.updatedAt }).then(function () {
        SC.toast(n + '번 ' + jo(coverLabel(), '을', '를') + ' 면제했어요' + (held > 0 ? ' · 환불 대기 ' + won(held) : ''), 'ok');
        return X.refresh().then(function () { s.close(); });
      }, function (e) { if (e.code === 'stale') X.refresh(); throw e; });
    });
    s.show(view(s, jo(coverLabel(), '을', '를') + ' 면제할까요?', n + '번 테이블', function () { tableHome(s, n); }, [
      beforeAfter([[coverLabel() + ' 합계', won(co.total), '0원 (면제)'], held > 0 ? ['돌려줄 돈', won(co.refundDue || 0), won((co.refundDue || 0) + held), 'owe'] : null]),
      held > 0 ? note('warn', '이미 받은 ' + won(held) + '은 환불 대기에 올라가요.') : null,
      note('info', '나중에 "면제 취소"로 되돌릴 수 있어요.'), h('label', { class: 'lab' }, '사유', reasonIn), err], go));
  }

  // ---- 직접 입력: shares or money, method, payer (server dry run)
  function coverPayView(s, n, co) {
    var maxSh = co.shares && co.unitPrice > 0 ? Math.min(co.shares.left, Math.floor((co.balanceDue || 0) / co.unitPrice)) : 0, perPerson = maxSh > 0, byShares = perPerson, shares = perPerson ? maxSh : 0, method = 'cash', amount = String(Math.max(0, co.balanceDue || 0));
    var payerIn = h('input', { class: 'field', type: 'text', maxlength: '10', placeholder: '이름 (선택, 10자)', 'aria-label': '낸 사람 이름', oninput: function () { dry.schedule(); } });
    var amountIn = h('input', { class: 'field amt', type: 'number', inputmode: 'numeric', min: '0', max: '10000000', value: amount, 'aria-label': '받은 금액(원)', oninput: function () { amount = amountIn.value; dry.schedule(); } });
    var preview = h('div'), segBtns = {}, modeBtns = {};
    function body0(extra) {
      var b = { paid: true, method: method };
      if (byShares) b.shares = shares; else b.amount = Number(amount);
      if (payerIn.value.trim()) b.payer = payerIn.value.trim();
      return Object.assign(b, extra || {});
    }
    function valid() { return byShares ? shares >= 1 : (amount !== '' && Number.isInteger(Number(amount)) && Number(amount) >= 0); }
    var dry = makeDry(function () { return SO.omut(co, 'paid', body0({ dryRun: true })); }, draw);
    var go = X.abtn('btn btn-primary btn-block', '입금 받기', function () {
      var seen = dry.last && dry.last.order;
      return SO.omut(co, 'paid', body0()).then(function (r) { return finishMoney(s, '입장료 받기', r, seen, n + '번 ' + coverLabel() + ' ' + (byShares ? shares + '명분 ' : '') + METHOD[method] + ' 받았어요'); }, function (e) { if (e.code === 'too_many_shares' || e.code === 'exceeds_balance') { X.refresh().then(function () { tableHome(s, n); }); } throw e; });
    });
    var seg = h('div', { class: 'al-seg', role: 'group', 'aria-label': '받은 방법' }, ['cash', 'transfer', 'other'].map(function (m) { var b = h('button', { class: 'btn', type: 'button', 'aria-pressed': String(m === method), onclick: function () { method = m; dry.schedule(); syncSeg(); } }, METHOD[m]); segBtns[m] = b; return b; }));
    function syncSeg() { Object.keys(segBtns).forEach(function (m) { segBtns[m].setAttribute('aria-pressed', String(m === method)); }); Object.keys(modeBtns).forEach(function (m) { modeBtns[m].setAttribute('aria-pressed', String((m === 'shares') === byShares)); }); }
    var st = perPerson ? stepper(function () { return shares; }, function (v) { shares = v; dry.schedule(); }, 1, maxSh, '명분') : null;
    var modeSeg = perPerson ? h('div', { class: 'al-seg' }, [['shares', '몇 명분'], ['money', '금액으로']].map(function (m) { var b = h('button', { class: 'btn', type: 'button', onclick: function () { byShares = m[0] === 'shares'; stWrap.hidden = !byShares; amtWrap.hidden = byShares; syncSeg(); dry.schedule(); } }, m[1]); modeBtns[m[0]] = b; return b; })) : null;
    var stWrap = h('div', { class: 'lab' }, '몇 명분 (' + maxSh + '명분까지)', st || ''), amtWrap = h('label', { class: 'lab' }, '받은 금액 (원)', amountIn);
    stWrap.hidden = !byShares; amtWrap.hidden = byShares;
    function draw() {
      var res = dry.last;
      go.disabled = !valid() || dry.busy || !(res && res.order) || go.classList.contains('busy');
      go.textContent = res && res.order && valid() ? (byShares ? shares + '명분 ' : '') + METHOD_BY[method] + ' 받기 · ' + won(holdOf(res.order) - holdOf(co)) : '입금 받기';
      if (!valid()) { SC.fill(preview, note('bad', '금액을 올바르게 입력해 주세요.')); return; }
      if (dry.busy || !res) { SC.fill(preview, h('p', { class: 'muted' }, '서버가 계산하는 중…')); return; }
      if (res.err) { SC.fill(preview, errNote(res.err)); return; }
      var a = res.order;
      SC.fill(preview, beforeAfter([['받은 돈', won(holdOf(co)), won(holdOf(a))], co.shares && a.shares ? ['납부 인원', co.shares.paid + '/' + co.shares.total + '명', a.shares.paid + '/' + a.shares.total + '명'] : null, ['남은 금액', won(co.balanceDue || 0), won(a.balanceDue || 0), a.balanceDue ? 'owe' : 'ok'], (a.refundDue || 0) > (co.refundDue || 0) ? ['돌려줄 돈', won(co.refundDue || 0), won(a.refundDue), 'owe'] : null]));
    }
    s.show(view(s, coverLabel() + ' 직접 입력', n + '번 테이블 · ' + won(co.balanceDue || 0) + ' 남음', function () { tableHome(s, n); }, [modeSeg, stWrap, amtWrap, h('div', { class: 'lab' }, '받은 방법', seg), h('label', { class: 'lab' }, '낸 사람', payerIn), preview], go));
    s.onClose = dry.cancel; syncSeg(); dry.schedule();
  }

  // ---- 입금 tab: guest "낼게요" intents that no bank notice matched yet
  SO.buildIntents = function () {
    var list = h('div', { class: 'list' }), title = h('h3', { class: 'sec-title' }, '보내는 중'), wrap = h('div', { class: 'intents', hidden: true }, title, h('p', { class: 'muted' }, '손님이 앱에서 "낼게요"를 눌렀지만 아직 입금 알림이 연결되지 않은 건이에요. 알림이 오면 자동으로 후보에 떠요. 현금으로 받았거나 앱에서 직접 확인했다면 여기서 바로 확인해요.'), list);
    function confirmIntent(it, method) {
      var co = coverOrderOf(it.table);
      if (!co) { SC.toast('이 자리의 ' + coverLabel() + ' 주문을 찾을 수 없어요.', 'error'); X.refresh(); return Promise.resolve(); }
      return SC.confirm({ title: it.table + '번 ' + it.payer + ' · ' + it.shares + '명분', ok: METHOD[method] + ' 받음으로 기록', message: won(it.amount) + '을 ' + METHOD_BY[method] + ' 받았나요?\n' + coverLabel() + ' 결제 기록이 생기고 이 "낼게요"는 닫혀요.' }).then(function (ok) {
        if (!ok) return;
        return SO.omut(co, 'paid', { paid: true, method: method, shares: it.shares, payer: it.payer }).then(function () {
          return X.api('/api/staff/cover/intents/' + it.id + '/cancel').then(null, function () { /* already closed by the payment */ });
        }).then(function () { SC.toast(it.table + '번 ' + it.payer + ' ' + it.shares + '명분 ' + METHOD[method] + ' 확인했어요', 'ok'); return X.refresh(); });
      });
    }
    function update(d) {
      var its = (d.coverIntents || []).filter(function (i) { return i.table >= 1; }).slice().sort(function (a, b) { return a.createdAt - b.createdAt; });
      wrap.hidden = !its.length;
      title.textContent = '보내는 중 ' + its.length + '건';
      SC.reconcile(list, its, function (i) { return i.id; }, X.sig, function (it) {
        return h('div', { class: 'row-card' }, h('div', { class: 'grow' }, h('b', null, it.table + '번 테이블 · ' + coverLabel() + ' ' + it.shares + '명분 · ' + it.payer), h('span', { class: 'muted' }, won(it.amount) + ' · ' + SC.agoText(it.createdAt))),
          h('div', { class: 'btns' }, X.abtn('btn btn-sm btn-primary', '이체 확인', function () { return confirmIntent(it, 'transfer'); }), X.abtn('btn btn-sm', '현금 받음', function () { return confirmIntent(it, 'cash'); }), X.abtn('btn btn-sm btn-danger', '취소', function () { return cancelIntent(it); })));
      }, null);
    }
    return { el: wrap, update: update };
  };

  // ---- order board: cover orders live in a compact strip, never in the kitchen columns
  SO.buildCoverStrip = function () {
    var box = h('div', { class: 'cover-strip', hidden: true });
    function update(d) {
      var os = d.orders.filter(function (o) { return o.kind === 'cover' && !SC.isTestOrder(o) && o.status !== 'cancelled' && !o.paid && !o.waived; }).sort(function (a, b) { return a.table - b.table; });
      box.hidden = !os.length;
      SC.fill(box, os.length ? [h('b', null, coverLabel() + ' 미납'), os.map(function (o) {
        var lab = o.shares ? o.shares.paid + '/' + o.shares.total + '명' : '미납';
        return h('button', { class: 'chip', type: 'button', onclick: function () { SO.openTableSheet(o.table); } }, o.table + '번 · ' + lab + ' · ' + won(o.balanceDue));
      })] : null);
    }
    return { el: box, update: update };
  };

  // ---- 주문 tab: the last 5 confirmed payments (from the payment ledger on every order)
  SO.buildRecentPays = function () {
    var list = h('div', { class: 'recent-list' }), box = h('div', { class: 'recent-pays', hidden: true }, h('b', { class: 'recent-title' }, '최근 입금'), list);
    function update(d) {
      var all = [];
      (d.orders || []).forEach(function (o) {
        if (SC.isTestOrder(o) && !SC.testSound()) return;
        (o.payments || []).forEach(function (p) { all.push({ o: o, p: p }); });
      });
      all.sort(function (a, b) { return b.p.at - a.p.at; });
      var top = all.slice(0, 5);
      box.hidden = !top.length;
      SC.reconcile(list, top, function (x) { return x.p.id; }, function (x) { return X.sig([x.p, x.o.table, x.o.paidBy, x.o.kind]); }, function (x) {
        var o = x.o, p = x.p, auto = PW.autoFor(o, p);
        var who = o.kind === 'cover' ? coverLabel() + (p.shares ? ' ' + p.shares + '명분' : '') : '';
        return h('button', { class: 'chip recent-chip', type: 'button', onclick: function () { if (o.kind === 'cover') SO.openTableSheet(o.table); else SO.openOrderSheet(o.id); } },
          h('span', { class: 'num' }, SC.clock(p.at)), h('b', null, tname(o.table) + (who ? ' · ' + who : '')), h('span', { class: 'num' }, won(p.amount)),
          h('span', { class: 'muted' }, (METHOD[p.method] || p.method || '') + ' · ' + (auto ? '자동' : '직원')),
          SC.isTestOrder(o) ? h('span', { class: 'tag tst' }, '테스트') : null);
      }, null);
    }
    return { el: box, update: update };
  };

  // ---- waitlist seat: optional table picker so the party size carries over
  SO.seatWait = function (x) {
    var d = X.S.data, tables = d.tables.slice().sort(function (a, b) { return a.number - b.number; });
    function done(r, tableNo) {
      if (tableNo != null) SC.toast(r && r.partySet ? tableNo + '번 테이블 인원을 ' + Math.min(x.size, 30) + '명으로 기록했어요' : tableNo + '번 테이블은 이미 인원이 있어서 그대로 뒀어요', 'ok');
      else SC.toast(x.nick + ' 착석 처리했어요', 'ok');
      return X.refresh();
    }
    if (!tables.length) return X.api('/api/staff/wait/' + x.id + '/seat').then(function (r) { return done(r, null); });
    return new Promise(function (resolve) {
      openSheet('착석', function (s) {
        var finished = false;
        function fin(p) { if (finished) return; finished = true; resolve(p); }
        s.dlg.addEventListener('close', function () { fin(Promise.resolve()); });
        function seat(no, seenSeat) {
          return X.api('/api/staff/wait/' + x.id + '/seat', no != null ? { table: no, ...(seenSeat != null ? { clear: true, seat: seenSeat } : {}) } : {}).then(function (r) { fin(done(r, no)); s.close(); }, function (e) {
            if (e.code === 'table_occupied' && no != null && seenSeat == null) return SC.confirm({ title: no + '번 테이블에 이전 손님 기록이 있어요. 정리하고 앉힐까요?', danger: true, ok: '정리하고 앉히기', cancel: '돌아가기' }).then(function (ok) { if (ok) return seat(no, e.data.seat); });
            toastErr(e);
          });
        }
        var btns = {};
        s.show(view(s, x.nick + ' · ' + x.size + '명 착석', '앉은 테이블을 고르면 인원 ' + Math.min(x.size, 30) + '명이 그 테이블에 기록돼요 (선택).', null, [
          h('div', { class: 'pick' }, tables.map(function (t) { return h('button', { class: 'btn', type: 'button', onclick: function () { seat(t.number); } }, String(t.number), h('small', null, t.status === 'occupied' || t.people != null ? '기록 있음' : '자리 선택')); })),
          note('info', '이전 손님 기록이 있는 테이블은 정리 여부를 확인해요. 테이블을 정하지 않고 착석만 처리할 수도 있어요.')],
          h('button', { class: 'btn btn-block', type: 'button', onclick: function () { seat(null); } }, '테이블 정하지 않고 착석')));
      });
    });
  };

  // ---- table merge conflict: both seats have a live cover order
  SO.coverConflict = function (from, to) {
    openSheet('입장료 충돌', function (s) {
      function waive(no) { s.close(); SO.openTableSheet(no); }
      s.show(view(s, '두 테이블 모두 ' + jo(coverLabel(), '이', '가') + ' 있어요', from + '번 → ' + to + '번', null, [
        note('warn', '두 테이블을 합치려면 한쪽 ' + jo(coverLabel(), '을', '를') + ' 먼저 면제해야 해요. 그러면 남은 쪽 ' + jo(coverLabel(), '이', '가') + ' 합친 인원으로 다시 계산돼요.'),
        h('div', { class: 'bigacts' },
          h('button', { class: 'btn bigact', type: 'button', onclick: function () { waive(from); } }, h('b', null, from + '번 ' + coverLabel() + ' 면제하러 가기'), h('span', { class: 'muted' }, '옮기는 쪽 입장료를 없애요')),
          h('button', { class: 'btn bigact', type: 'button', onclick: function () { waive(to); } }, h('b', null, to + '번 ' + coverLabel() + ' 면제하러 가기'), h('span', { class: 'muted' }, '받는 쪽 입장료를 없애요'))),
        note('info', '면제한 뒤 다시 "자리 이동"을 눌러 주세요.')]));
    });
  };

  // ---- sales: visitors, kind split
  SO.visitorsCard = function (v) {
    if (!v || !(v.total || v.parties || v.partiesUnknown)) return null;
    function tile(k, val, help) { return h('div', { class: 'tile' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, val), h('span', { class: 'help' }, help)); }
    var hours = (v.byHour || []), maxH = Math.max.apply(null, [1].concat(hours.map(function (x) { return x.people; })));
    return h('div', { class: 'card' }, h('h3', { class: 'sec-title', style: 'margin:0' }, '방문 인원'),
      h('div', { class: 'tiles' }, tile('총 인원', (v.total || 0) + '명', '인원이 기록된 자리의 인원 합계'), tile('팀 수', (v.parties || 0) + '팀', '인원이 기록된 자리 수 (자리마다 1팀)'), tile('평균 팀 인원', (v.avgPartySize || 0) + '명', '총 인원 ÷ 팀 수'), tile('인원 미입력', (v.partiesUnknown || 0) + '팀', '주문은 있었지만 인원을 적지 않은 자리')),
      hours.length ? h('div', { class: 'bars', role: 'list', 'aria-label': '시간대별 방문 인원' }, hours.map(function (x) {
        return h('div', { class: 'bar', role: 'listitem' }, h('span', null, x.label.slice(5)), h('span', { class: 'track' }, h('i', { style: 'width:' + Math.max(2, Math.round(x.people / maxH * 100)) + '%' })), h('span', { class: 'v' }, x.people + '명 · ' + x.parties + '팀'));
      })) : null,
      h('p', { class: 'muted' }, '자리에 처음 앉은 시각을 기준으로 시간대에 넣어요.'));
  };
  SO.kindCard = function (bk) {
    if (!bk || !bk.cover || !bk.cover.orders) return null;
    function col(title, x) {
      return h('div', { class: 'card' }, h('h4', { class: 'sub-title', style: 'margin-top:0' }, title + ' · ' + x.orders + '건'),
        h('div', { class: 'tiles' },
          kt('청구 금액', won(x.billed), TILE_HELP.billed), kt('실제 받은 돈', won(x.net), TILE_HELP.revenue), kt('받은 돈', won(x.received), '환불 전에 받은 돈'), kt('환불 완료', won(x.refunded), TILE_HELP.refundsDone), kt('미결제', won(x.unpaid), TILE_HELP.unpaid), kt('미수금', won(x.writtenOff), TILE_HELP.wo)));
    }
    function kt(k, v, help) { return h('div', { class: 'tile' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v), h('span', { class: 'help' }, help)); }
    return h('div', { class: 'card' }, h('h3', { class: 'sec-title', style: 'margin:0' }, '음식 / ' + coverLabel() + ' 나눠 보기'), h('p', { class: 'muted' }, '두 칸을 더하면 위의 전체 금액과 같아요.'), h('div', { class: 'two' }, col('음식', bk.food), col(coverLabel(), bk.cover)));
  };

  // ---- settings: 입장료
  SO.coverSection = function () {
    var dirty = false, enabled = false, mode = 'per_person', requireB = false, askG = true;
    var amountIn = h('input', { class: 'field', type: 'number', inputmode: 'numeric', min: '0', max: '100000', step: '100', 'aria-label': '입장료 금액(원)', oninput: function () { dirty = true; ex(); } });
    var labelIn = h('input', { class: 'field', type: 'text', maxlength: '12', 'aria-label': '입장료 이름', oninput: function () { dirty = true; ex(); } });
    var maxIn = h('input', { class: 'field', type: 'number', inputmode: 'numeric', min: '0', max: '30', step: '1', 'aria-label': '테이블당 최대 인원', oninput: function () { dirty = true; } });
    var example = h('p', { class: 'sheet-note info' }), err = h('div'), cfgNow = null;
    function tog(label, sub, get, set) {
      var b = h('button', { class: 'btn al-sw', type: 'button', onclick: function () { if (b.disabled) return; set(!get()); dirty = true; b.refresh(); ex(); } });
      var subEl = h('span', { class: 'muted' }, sub);
      b.refresh = function () { var lock = b.lockWhen && b.lockWhen(); b.disabled = !!lock; b.setAttribute('aria-pressed', String(lock ? true : get())); b.textContent = (lock || get()) ? '켜짐' : '꺼짐'; subEl.textContent = lock ? '필수로 켜면 손님에게 항상 물어봐요' : sub; }; b.refresh();
      return { row: h('div', { class: 'al-row' }, h('div', { class: 'al-txt' }, h('b', null, label), subEl), b), b: b };
    }
    var tEn = tog('입장료 받기', '켜면 자리마다 입장료 주문이 만들어져요', function () { return enabled; }, function (v) { enabled = v; });
    var tReq = tog('인원을 입력해야 주문 가능', '손님이 인원을 적기 전에는 주문할 수 없어요 (입장료 결제는 안 해도 돼요)', function () { return requireB; }, function (v) { requireB = v; tAsk.b.refresh(); });
    var tAsk = tog('손님에게 인원 묻기', '손님 화면에서 인원을 물어봐요 (입장료와 별개)', function () { return askG; }, function (v) { askG = v; });
    tAsk.b.lockWhen = function () { return requireB; }; tAsk.b.refresh();
    var modeBtns = {};
    var modeSeg = h('div', { class: 'al-seg', role: 'group', 'aria-label': '방식' }, [['per_person', '1인당'], ['per_table', '테이블당']].map(function (m) { var b = h('button', { class: 'btn', type: 'button', onclick: function () { mode = m[0]; dirty = true; ex(); } }, m[1]); modeBtns[m[0]] = b; return b; }));
    function ex() {
      Object.keys(modeBtns).forEach(function (k) { modeBtns[k].setAttribute('aria-pressed', String(k === mode)); });
      var a = Number(amountIn.value), l = labelIn.value.trim() || '입장료';
      example.textContent = Number.isInteger(a) && a >= 0 ? (mode === 'per_person' ? '예: 4명 테이블 → ' + won(a * 4) + ' (' + l + ' ' + won(a) + ' × 4명)' : '예: 몇 명이든 한 테이블에 ' + won(a)) : '금액을 100원 단위로 입력해 주세요.';
    }
    var save = X.abtn('btn btn-primary', '입장료 설정 저장', function () {
      var a = Number(amountIn.value), l = labelIn.value.trim();
      if (!Number.isInteger(a) || a < 0 || a > 100000 || a % 100 !== 0) { SC.fill(err, note('bad', '금액은 100원 단위, 0~100,000원이에요.')); return Promise.resolve(); }
      if (l.length < 1 || l.length > 12) { SC.fill(err, note('bad', '이름은 1~12자로 입력해 주세요.')); return Promise.resolve(); }
      var mx = Number(maxIn.value || 0);
      if (!Number.isInteger(mx) || mx < 0 || mx > 30) { SC.fill(err, note('bad', '테이블당 최대 인원은 0~30명이에요 (0 = 제한 없음).')); return Promise.resolve(); }
      if (enabled && a === 0) { SC.fill(err, note('bad', '금액이 0원이면 입장료 주문이 만들어지지 않아요. 금액을 넣거나 입장료를 꺼 주세요.')); return Promise.resolve(); }
      SC.fill(err);
      var c = cfgNow || {}, diff = {};
      if (enabled !== !!c.enabled) diff.enabled = enabled;
      if (mode !== c.mode) diff.mode = mode;
      if (a !== c.amount) diff.amount = a;
      if (l !== c.label) diff.label = l;
      if (requireB !== !!c.requireBeforeOrder) diff.requireBeforeOrder = requireB;
      if (askG !== (c.askGuest !== false)) diff.askGuest = askG;
      if (mx !== (c.maxPeople || 0)) diff.maxPeople = mx;
      if (!Object.keys(diff).length) { SC.toast('바뀐 내용이 없어요.'); return Promise.resolve(); }
      return X.api('/api/staff/cover/settings', diff).then(function () { dirty = false; SC.toast('입장료 설정을 저장했어요', 'ok'); return X.refresh(); });
    });
    var el0 = h('div', { class: 'card' }, tEn.row, h('div', { class: 'lab' }, '방식', modeSeg), h('label', { class: 'lab' }, '금액 (100원 단위)', amountIn), h('label', { class: 'lab' }, '이름 (기본 "입장료")', labelIn), example,
      tReq.row, tAsk.row, h('label', { class: 'lab' }, '테이블당 최대 인원 (0 = 제한 없음 · 손님 입력과 대기 등록에 적용, 직원 입력은 제한 없음)', maxIn), err, save, note('info', '설정을 바꿔도 이미 앉은 테이블의 입장료는 그대로예요. 새로 앉는 테이블부터 적용돼요.'));
    return { el: el0, update: function (d) {
      var c = d.cover || { enabled: false, mode: 'per_person', amount: 0, label: '입장료', requireBeforeOrder: false, askGuest: true };
      cfgNow = c;
      if (!dirty && !el0.contains(document.activeElement)) {
        enabled = !!c.enabled; mode = c.mode || 'per_person'; requireB = !!c.requireBeforeOrder; askG = c.askGuest !== false;
        amountIn.value = String(c.amount || 0); labelIn.value = c.label || '입장료'; maxIn.value = String(c.maxPeople || 0);
        tEn.b.refresh(); tReq.b.refresh(); tAsk.b.refresh(); ex();
      }
    } };
  };

  // real table's guest page in a new tab; orders placed there are real
  function openGuestScreen(n) {
    return SC.confirm({ title: n + '번 테이블 손님 화면을 열까요?', ok: '새 탭으로 열기', danger: true, message: '실제 테이블이에요. 여기서 넣은 주문은 실제 주문으로 들어가요.\n연습은 메뉴의 "손님 화면 테스트"를 써 주세요.' }).then(function (ok) {
      if (!ok) return;
      return SC.api('/api/staff/tables').then(function (r) {
        var t = (r.tables || []).filter(function (x) { return x.number === n; })[0];
        if (!t) { SC.toast('이 테이블의 주소를 찾을 수 없어요.', 'error'); return; }
        window.open(/^https?:/.test(t.url) ? t.url : location.origin + t.url, '_blank', 'noopener');
      }, toastErr);
    });
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

  SO.moveCoupon = function (c) {
    openSheet('쿠폰 옮기기', function (s) {
      var to = null, buttons = {}, tables = X.S.data.tables.filter(function (t) { return t.number !== c.table; }).sort(function (a, b) { return a.number - b.number; });
      var go = X.abtn('btn btn-primary btn-block', '쿠폰 옮기기', function () {
        var dest = to, destSeat = (tables.filter(function (t) { return t.number === dest; })[0] || {}).seat;
        return SC.confirm({ title: '쿠폰 ' + c.code + '을 ' + dest + '번 테이블로 옮길까요?', ok: '옮기기', message: c.label + ' · ' + c.table + '번 → ' + dest + '번 테이블' }).then(function (ok) {
          if (!ok) return;
          return X.api('/api/staff/coupons/' + encodeURIComponent(c.code) + '/move', { table: dest, toSeat: destSeat, fromTable: c.table, fromSeat: c.seat }).then(function () {
            SC.toast('쿠폰 ' + c.code + '을 ' + dest + '번 테이블로 옮겼어요', 'ok');
            return X.refresh().then(function () { s.close(); });
          }, toastErr);
        });
      });
      go.disabled = true;
      s.show(view(s, '쿠폰 ' + c.code + ' 옮기기', c.label + ' · ' + c.table + '번 테이블', null,
        tables.length ? h('div', { class: 'pick' }, tables.map(function (t) {
          var b = h('button', { class: 'btn', type: 'button', 'aria-pressed': 'false', onclick: function () { to = t.number; Object.keys(buttons).forEach(function (n) { buttons[n].setAttribute('aria-pressed', String(Number(n) === to)); }); go.disabled = go.classList.contains('busy'); } }, String(t.number), h('small', null, t.status === 'occupied' ? '사용 중' : '비어 있음'));
          buttons[t.number] = b; return b;
        })) : note('info', '옮길 다른 테이블이 없어요.'), go));
    });
  };

  // ---------------------------------------------------------------- refunds (section of the 입금 tab)
  var REFUND_WHY = { cancelled: '주문 취소', overpaid: '초과 입금', edit_lower_total: '주문 수정으로 금액이 줄었어요' };
  SO.refundCount = function (d) { return (d.refunds || []).filter(function (r) { return !r.doneAt && !r.test && r.table !== 0; }).length; };
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
      h('div', { class: 'ohead' }, r.table === 0 ? h('div', { class: 'tno' }, h('span', { class: 'n tst', text: '테스트' })) : h('div', { class: 'tno' }, h('span', { class: 'n', text: r.table }), h('span', { class: 'u', text: '번 테이블' })),
        h('div', { class: 'ometa' }, h('div', { class: 'dep-amt' }, won(r.amount)), h('div', { class: 'line' }, r.table === 0 ? h('span', { class: 'tag tst' }, '테스트') : null, h('span', { class: 'tag warn' }, REFUND_WHY[r.reason] || r.reason), h('span', { class: 'tag mute' }, '주문 #' + r.orderId), SC.timeEl(r.createdAt, 'ago')))),
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
  // ---- 설정 -> 테스트
  SO.testSection = function () {
    var tt = null;
    var urlBox = h('code', null, '…');
    var open = h('a', { class: 'btn', href: '#', target: '_blank', rel: 'noopener' }, '열기');
    function copyUrl() {
      var u = SC.testUrl || '';
      function fallback() { var ta = h('textarea', { 'aria-hidden': 'true', style: 'position:fixed;opacity:0' }); ta.value = u; document.body.appendChild(ta); ta.select(); var ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; } ta.remove(); SC.toast(ok ? '주소를 복사했어요' : '복사하지 못했어요. 주소를 길게 눌러 복사해 주세요.', ok ? 'ok' : 'error'); }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(u).then(function () { SC.toast('주소를 복사했어요', 'ok'); }, fallback); else fallback();
    }
    function tog(label, sub, get, set) {
      var b = h('button', { class: 'btn al-sw', type: 'button', onclick: function () { set(!get()); } });
      b.refresh = function () { b.setAttribute('aria-pressed', String(get())); b.textContent = get() ? '켜짐' : '꺼짐'; }; b.refresh();
      return { row: h('div', { class: 'al-row' }, h('div', { class: 'al-txt' }, h('b', null, label), h('span', { class: 'muted' }, sub)), b), b: b };
    }
    function post(body) { return X.api('/api/staff/test/settings', body).then(function () { return X.refresh(); }, function (e) { toastErr(e); return X.refresh(); }); }
    var tMem = tog('COMS 회원으로 보기', '테스트 화면에서만 회원 할인을 미리 볼 수 있어요 (동아리 서버를 부르지 않아요)', function () { return !!(tt && tt.memberPreview); }, function (v) { return post({ memberPreview: v }); });
    var tKit = tog('주방에 테스트 주문 표시', '끄면 주방 화면에 테스트 주문이 안 보여요', function () { return !!(tt && tt.showInKitchen); }, function (v) { return post({ showInKitchen: v }); });
    var tSnd = tog('테스트 주문도 소리 내기', '켜 두면 연습할 때도 실제 주문처럼 소리와 알림이 나요 (이 기기에만 적용)', function () { return SC.testSound(); }, function (v) { SC.testSound(v); tSnd.b.refresh(); });
    var count = h('p', { class: 'muted' });
    var reset = X.abtn('btn btn-danger', '테스트 데이터 지우기', function () {
      var n = tt ? tt.orderCount : 0;
      return SC.confirm({ title: '테스트 데이터를 지울까요?', danger: true, ok: '지우기', message: '테스트 주문 ' + n + '건과 테스트 쿠폰 · 게임 기록 · 호출 · 인원이 모두 지워져요. 실제 주문과 매출은 그대로예요.' }).then(function (ok) {
        if (!ok) return;
        return X.api('/api/staff/test/reset').then(function (r) { SC.toast('테스트 주문 ' + (r.orders != null ? r.orders : n) + '건을 지웠어요', 'ok'); return X.refresh(); }, toastErr);
      });
    });
    var rotate = X.abtn('btn', '테스트 주소 재발급', function () {
      return SC.confirm({ title: '테스트 주소를 새로 만들까요?', ok: '재발급', message: '이전 테스트 주소와 QR은 바로 열리지 않게 돼요. 열려 있는 테스트 화면도 닫혀요.' }).then(function (ok) {
        if (!ok) return;
        return X.api('/api/staff/test/rotate').then(function () { SC.toast('테스트 주소를 새로 만들었어요', 'ok'); return X.refresh(); }, toastErr);
      });
    });
    var el0 = h('div', { class: 'card' },
      h('p', null, '실제 매출·재고·쿠폰·랭킹에 섞이지 않는 연습용 테이블이에요.'), h('p', null, '주문 보드와 주방에는 \'테스트\' 표시로 나와요.'),
      h('div', { class: 'test-url' }, urlBox, open, h('button', { class: 'btn', type: 'button', onclick: copyUrl }, '복사')),
      tMem.row, tKit.row, tSnd.row, count, h('div', { class: 'al-seg' }, reset, rotate));
    return { el: el0, update: function (d) {
      tt = d.testTable || null;
      if (!tt) { urlBox.textContent = '테스트 테이블을 사용할 수 없어요 (서버를 업데이트해 주세요).'; open.hidden = true; return; }
      var u = SC.testUrl || tt.url;
      if (urlBox.textContent !== u) urlBox.textContent = u;
      open.href = u; open.hidden = false;
      count.textContent = '지금 테스트 주문 ' + (tt.orderCount || 0) + '건 · 호출 ' + (tt.openCalls || 0) + '건' + (tt.people != null ? ' · 인원 ' + tt.people + '명' : '');
      tMem.b.refresh(); tKit.b.refresh(); tSnd.b.refresh();
    } };
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
  // ---- settings: 쿠폰 제한 (addendum K)
  SO.couponLimitSection = function () {
    var dirty = false, cur = { maxPerSeat: 0, maxDiscountUsesPerSeat: 0 };
    function inp(label) { return h('input', { class: 'field', type: 'number', inputmode: 'numeric', min: '0', max: '50', step: '1', 'aria-label': label, oninput: function () { dirty = true; } }); }
    var totalIn = inp('한 테이블이 받을 수 있는 쿠폰 총 장수'), useIn = inp('한 테이블이 쓸 수 있는 할인 쿠폰 장수'), err = h('div');
    var save = X.abtn('btn btn-primary', '쿠폰 제한 저장', function () {
      var a = Number(totalIn.value), b = Number(useIn.value);
      if (!(Number.isInteger(a) && a >= 0 && a <= 50 && Number.isInteger(b) && b >= 0 && b <= 50)) { SC.fill(err, note('bad', '0 또는 1~50 사이 정수로 입력해 주세요. (0 = 제한 없음)')); return Promise.resolve(); }
      SC.fill(err);
      var diff = {};
      if (a !== cur.maxPerSeat) diff.maxPerSeat = a;
      if (b !== cur.maxDiscountUsesPerSeat) diff.maxDiscountUsesPerSeat = b;
      if (!Object.keys(diff).length) { SC.toast('바뀐 내용이 없어요.'); return Promise.resolve(); }
      return X.api('/api/staff/coupon-limits', diff).then(function () { dirty = false; SC.toast('쿠폰 제한을 저장했어요', 'ok'); return X.refresh(); }, function (e) { SC.fill(err, note('bad', SC.errText(e))); });
    });
    var box = h('div', { class: 'card' },
      h('label', { class: 'lab' }, '한 테이블이 받을 수 있는 쿠폰 총 장수 (0 = 제한 없음)', totalIn),
      h('p', { class: 'muted' }, '게임으로 받는 보상 쿠폰과 정시 시상을 합친 장수예요. 직원이 직접 발급한 쿠폰은 세지 않아요. 보상마다 정한 장수와 별개로 적용돼요.'),
      h('label', { class: 'lab' }, '한 테이블이 쓸 수 있는 할인 쿠폰 장수 (0 = 제한 없음)', useIn),
      h('p', { class: 'muted' }, '주문에 할인 쿠폰을 쓴 횟수예요. 직원이 직접 발급한 쿠폰도 세요. 주문을 취소하면 다시 쓸 수 있어요.'),
      note('info', '직원이 직접 발급한 쿠폰은 "받을 수 있는 쿠폰 총 장수"에는 세지 않지만, "쓸 수 있는 할인 쿠폰 장수"에는 세요.'),
      note('info', '폰 단위 제한은 브라우저 기준이라 완벽하지 않아요. 테이블당 장수와 전체 수량이 실제 상한이에요.'),
      note('info', '게임 점수는 손님 폰에서 계산돼요. 실제 상한은 테이블당 장수와 준비 수량이에요. 폰당 제한은 보조 장치예요.'),
      err, save);
    return { el: box, update: function (d) {
      cur = Object.assign({ maxPerSeat: 0, maxDiscountUsesPerSeat: 0 }, d.couponLimits || {});
      if (!dirty && !box.contains(document.activeElement)) { totalIn.value = String(cur.maxPerSeat); useIn.value = String(cur.maxDiscountUsesPerSeat); }
    } };
  };
  SO.waitTimeoutSection = function () {
    var minutes = 10, dirty = false;
    var num = h('input', { class: 'field', type: 'number', inputmode: 'numeric', min: '1', max: '30', step: '1', 'aria-label': '호출 후 대기 시간(분)', oninput: function () { dirty = true; } });
    var apply = X.abtn('btn btn-primary', '적용', function () {
      var m = Number(num.value);
      if (!Number.isInteger(m) || m < 1 || m > 30) { SC.toast(ERR.bad_minutes, 'error'); return Promise.resolve(); }
      return X.api('/api/staff/waitlist/timeout', { minutes: m }).then(function () { dirty = false; SC.toast('호출 후 ' + m + '분 안에 안 오면 노쇼로 표시해요', 'ok'); return X.refresh(); }, toastErr);
    });
    function nudge(d) { num.value = String(Math.max(1, Math.min(30, (parseInt(num.value, 10) || minutes) + d))); dirty = true; }
    var box = h('div', { class: 'card' }, h('p', { class: 'muted' }, '대기 손님을 "입장 호출"한 뒤 이 시간 안에 앉지 않으면 "노쇼"로 표시돼요. 노쇼는 한 번 다시 부를 수 있어요.'),
      h('div', { class: 'stockctl' }, h('button', { class: 'btn btn-sm', type: 'button', onclick: function () { nudge(-1); }, 'aria-label': '1분 줄이기' }, '−'), num, h('span', null, '분'), h('button', { class: 'btn btn-sm', type: 'button', onclick: function () { nudge(1); }, 'aria-label': '1분 늘리기' }, '+'), apply));
    return { el: box, update: function (d) { minutes = d.waitCallTimeoutMin || 10; if (!dirty && document.activeElement !== num) num.value = String(minutes); } };
  };
  SO.waitSmsSection = function () {
    var configured = false, info = h('p', { class: 'muted' });
    var url = h('input', { class: 'field', type: 'password', autocomplete: 'off', 'aria-label': 'MacroDroid 웹훅 URL', placeholder: 'https://trigger.macrodroid.com/…' });
    var phone = h('input', { class: 'field', type: 'tel', inputmode: 'numeric', autocomplete: 'tel', 'aria-label': '테스트 문자 받을 휴대폰 번호', placeholder: '010-1234-5678' });
    var save = X.abtn('btn btn-primary', '주소 저장', function () {
      if (!url.value.trim()) { SC.toast('웹훅 주소를 입력해 주세요.', 'error'); return Promise.resolve(); }
      return X.api('/api/staff/waitlist/sms', { url: url.value.trim() }).then(function () { url.value = ''; SC.toast('문자 호출 주소를 저장했어요', 'ok'); return X.refresh(); }, toastErr);
    });
    var clear = X.abtn('btn btn-danger', '주소 해제', function () {
      return X.api('/api/staff/waitlist/sms', { url: '' }).then(function () { url.value = ''; SC.toast('문자 호출 주소를 해제했어요', 'ok'); return X.refresh(); }, toastErr);
    });
    var testBtn = X.abtn('btn', '테스트 문자 보내기', function () {
      var digits = phone.value.replace(/[\s-]/g, '');
      if (!/^01[016789]\d{7,8}$/.test(digits)) { SC.toast('휴대폰 번호를 정확히 입력해 주세요.', 'error'); phone.focus(); return Promise.resolve(); }
      return X.api('/api/staff/waitlist/sms/test', { phone: digits }).then(function (r) { SC.toast(r.ok ? '테스트 문자를 보냈어요' : '문자 전송에 실패했어요' + (r.error ? ' (' + r.error + ')' : ''), r.ok ? 'ok' : 'error'); }, toastErr);
    });
    var toggle = h('button', { class: 'btn al-sw', type: 'button', onclick: function () {
      X.api('/api/staff/waitlist/auto-next', { on: toggle.getAttribute('aria-pressed') !== 'true' }).then(function () { SC.toast('자동 다음 호출 설정을 바꿨어요', 'ok'); X.refresh(); }, toastErr);
    } });
    var box = h('div', { class: 'card' }, info, h('label', { class: 'lab' }, 'MacroDroid 웹훅 URL', url), h('div', { class: 'al-seg' }, save, clear),
      h('label', { class: 'lab' }, '테스트 번호', phone), testBtn,
      h('div', { class: 'al-row' }, h('div', { class: 'al-txt' }, h('b', null, '자동 다음 호출'), h('span', { class: 'muted' }, '노쇼가 되면 기다리는 다음 팀을 불러요.')), toggle));
    return { el: box, update: function (d) {
      var sms = d.waitSms || {}; configured = !!sms.configured;
      info.textContent = configured ? '설정됨 …' + (sms.hint || '') : '문자 호출 주소가 설정되지 않았어요.';
      clear.disabled = !configured; testBtn.disabled = !configured;
      toggle.setAttribute('aria-pressed', String(d.waitAutoNext !== false)); toggle.textContent = d.waitAutoNext !== false ? '켜짐' : '꺼짐';
    } };
  };
  SO.boardShowSection = function () {
    var names = { wait: '대기 현황', stock: '상품 남은 개수', rewardDetail: '상품 점수·할인 상세', member: '회원 할인', hourly: '정시 1등 경품', games: '게임 순위' };
    var boxes = {}, row = Object.keys(names).map(function (key) {
      var input = h('input', { type: 'checkbox', onchange: function () {
        input.disabled = true;
        X.api('/api/staff/board', { [key]: input.checked }).then(function () { SC.toast('전광판 표시를 저장했어요', 'ok'); return X.refresh(); }, function (e) { input.checked = !input.checked; toastErr(e); }).finally(function () { input.disabled = false; });
      } });
      boxes[key] = input;
      return h('label', { class: 'al-row' }, h('span', { class: 'al-txt' }, h('b', null, names[key])), input);
    });
    return { el: h('div', { class: 'card' }, row), update: function (d) {
      Object.keys(boxes).forEach(function (key) { if (!boxes[key].disabled) boxes[key].checked = !d.boardShow || d.boardShow[key] !== false; });
    } };
  };
  var AUDIT_LABEL = {
    order_create_staff: '직원 주문', order_status: '주문 상태', order_paid: '입금 받음', order_unpaid: '입금 취소', order_cancel: '주문 취소', order_edit: '주문 수정', order_service: '서비스 추가', order_move: '주문 이동',
    table_clear: '테이블 정리', table_unclear: '정리 되돌리기', table_move: '자리 이동', refund_done: '환불 완료', coupon_manual: '쿠폰 직접 발급', coupon_void: '쿠폰 무효', coupon_redeem: '쿠폰 사용',
    deposit_assign: '입금 연결', deposit_attach: '입금 알림 연결', deposit_dismiss: '입금 알림 무시', deposit_auto: '입금 자동 확인', deposit_auto_setting: '자동 확인 설정', deposit_secret_rotate: '알림 주소 재발급',
    menu_create: '메뉴 추가', menu_update: '메뉴 변경', pay_settings: '결제 설정', member_discount: '회원 할인 설정', notice: '공지', ordering: '주문 받기 켜기/끄기', table_count: '테이블 수', table_rotate: 'QR 교체',
    wait_timeout: '노쇼 시간', wait_sms_url: '문자 호출 설정', wait_auto_next: '자동 다음 호출', board_show: '전광판 표시', party_set: '인원 변경', cover_settings: '입장료 설정', cover_create: '입장료 생성', cover_update: '입장료 변경', cover_waive: '입장료 면제', cover_restore: '입장료 면제 취소', cover_intent_cancel: '낼게요 취소', payment_void: '결제 기록 취소', reset: '전체 초기화', day_close: '영업 마감', login: '로그인', lockout: '로그인 잠금', staff_action: '직원 작업',
  };
  SO.auditSection = function () {
    var list = h('div', { class: 'list' }), more = h('button', { class: 'btn btn-block', type: 'button' }, '더 보기'), next = null, loaded = false, opened = false;
    var box = h('details', { class: 'hist audit' }, h('summary', null, '작업 기록 보기'), h('p', { class: 'muted' }, '누가 언제 무엇을 바꿨는지 최신순으로 남아요. 읽기만 할 수 있어요.'), list, more);
    function row(e) {
      return h('div', { class: 'row-card audit-row' }, h('div', { class: 'grow' }, h('span', { class: 'tag mute' }, AUDIT_LABEL[e.action] || e.action), e.test ? h('span', { class: 'tag tst' }, '테스트') : null, h('span', null, e.summaryKo || e.summary || ''), h('span', { class: 'muted' }, SC.clock(e.at) + ' · ' + SC.agoText(e.at))));
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
          SO.kindCard(r.byKind), SO.visitorsCard(r.visitors),
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

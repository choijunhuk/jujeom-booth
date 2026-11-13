(function () {
  'use strict';
  var BASE = window.BASE || '';
  var TOKEN = location.pathname.split('/').pop();
  var API = BASE + '/api/t/' + encodeURIComponent(TOKEN);
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var S = null;                 // latest server snapshot
  var tab = 'menu', cat = '전체';
  var cart = { items: {}, note: '', coupon: '' };
  var pend = null;              // {key, body}: frozen order request, persisted until a definitive answer
  var lastSse = 0, clearedSeat = null, gameSeq = 0;
  var sending = false, netFailed = false;
  var es = null, pollT = null, conn = true;
  var callCd = {}, cancelArm = {}, gameBusy = false, game = null;
  var REDUCED = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  var STEPS = ['pending', 'cooking', 'served'], STEP_L = ['접수 대기', '조리 중', '나감'];

  /* ---------- helpers ---------- */
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function won(n) { return Number(n || 0).toLocaleString('ko-KR') + '원'; }
  function hhmm(ms) { var d = new Date(ms); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function vib(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) {} }
  function newKey() {
    var a = '';
    try { var u = new Uint8Array(16); crypto.getRandomValues(u); for (var i = 0; i < u.length; i++) a += ('0' + u[i].toString(16)).slice(-2); }
    catch (e) { for (var j = 0; j < 32; j++) a += Math.floor(Math.random() * 16).toString(16); }
    return 'k' + a;
  }
  var toastT;
  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('on'); }, 2800);
  }
  function api(path, body) {
    var o = body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    return fetch(API + path, o).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, status: r.status, data: d }; });
    }, function () { var e = new Error('net'); e.net = true; throw e; });
  }
  function menuMap() { var m = {}; S.menu.items.forEach(function (i) { m[i.id] = i; }); return m; }
  function cartKey() { return 'jb:cart:' + TOKEN + ':' + (S ? S.table.seat : 0); }
  function saveCart() { lsSet(cartKey(), JSON.stringify(cart)); }
  function loadCart() {
    try { var c = JSON.parse(lsGet(cartKey()) || 'null'); if (c && c.items) cart = { items: c.items, note: c.note || '', coupon: c.coupon || '' }; } catch (e) {}
  }
  function fatal(title, msg) {
    document.body.innerHTML = '<div class="fatal"><h2>' + esc(title) + '</h2><p>' + esc(msg) + '</p></div>';
  }

  /* ---------- sheets ---------- */
  var sheetOpener = null, sheetKind = '';
  function openSheet(kind, html, onClose) {
    closeSheet(true);
    sheetKind = kind; sheetOpener = document.activeElement;
    var root = $('#sheet-root');
    root.innerHTML = '<div class="sheet-bk" data-a="bk"><div class="sheet" role="dialog" aria-modal="true" aria-label="' + esc(kind) + '" tabindex="-1"><button class="sx" data-a="sclose" aria-label="닫기">&times;</button>' + html + '</div></div>';
    root.firstChild._onClose = onClose;
    var sh = $('.sheet', root); sh.focus();
    return sh;
  }
  function closeSheet(silent) {
    var root = $('#sheet-root'), bk = root.firstChild;
    if (!bk) return;
    var cb = bk._onClose; root.innerHTML = ''; sheetKind = '';
    if (!silent && sheetOpener && sheetOpener.focus) try { sheetOpener.focus(); } catch (e) {}
    if (cb && !silent) cb();
  }
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });

  /* ---------- state application ---------- */
  function applyState(d) {
    var prev = S; S = d;
    if (!prev) { loadCart(); loadPend(); if (pend) netFailed = true; }
    else if (prev.table.seat !== d.table.seat) {
      lsSet('jb:cart:' + TOKEN + ':' + prev.table.seat, null); lsSet('jb:pend:' + TOKEN + ':' + prev.table.seat, null);
      if (clearedSeat === prev.table.seat) clearedSeat = null; else onCleared(true);
    }
    else detectChanges(prev, d);
    sanitizeCart();
    render();
  }
  function detectChanges(p, d) {
    var pm = {}; p.orders.forEach(function (o) { pm[o.id] = o; });
    d.orders.forEach(function (o) {
      var q = pm[o.id]; if (!q || q.status === o.status) return;
      if (o.status === 'cooking') toast(o.id + '번 주문 조리를 시작했어요');
      else if (o.status === 'served') { toast(o.id + '번 주문이 나왔어요! 받아가세요'); vib([60, 40, 60]); }
      else if (o.status === 'cancelled') toast(o.id + '번 주문이 취소됐어요');
    });
    if (p.orderingOpen && !d.orderingOpen) toast('주문이 마감됐어요');
    if (!p.orderingOpen && d.orderingOpen) toast('주문을 다시 받아요!');
  }
  function onCleared(fromSeat) {
    lsSet(cartKey(), null); if (!fromSeat && S) clearedSeat = S.table.seat;
    cart = { items: {}, note: '', coupon: '' }; pend = null; savePend(); sending = false; netFailed = false; cancelArm = {}; callCd = {};
    closeSheet(true); closeGame();
    tab = 'menu';
    toast('새 손님을 환영해요!');
    if (!fromSeat && S) { /* state event follows */ }
  }
  function sanitizeCart() {
    var m = menuMap(), ch = false;
    Object.keys(cart.items).forEach(function (id) { if (!m[id]) { delete cart.items[id]; ch = true; } });
    if (cart.coupon) {
      var ok = S.coupons.some(function (c) { return c.code === cart.coupon && c.status === 'issued' && c.type === 'discount'; });
      if (!ok) { cart.coupon = ''; ch = true; }
    }
    if (ch) saveCart();
  }
  function lines() {
    var m = menuMap();
    return Object.keys(cart.items).map(function (id) { return { id: id, it: m[id], qty: cart.items[id], soldOut: !!m[id].soldOut }; });
  }
  function totals() {
    var sub = 0, n = 0;
    lines().forEach(function (l) { if (!l.soldOut) { sub += l.it.price * l.qty; n += l.qty; } });
    var disc = 0;
    if (cart.coupon) { var c = S.coupons.filter(function (x) { return x.code === cart.coupon; })[0]; if (c) disc = Math.min(sub, c.amount || 0); }
    return { n: n, sub: sub, disc: disc, total: Math.max(0, sub - disc) };
  }
  function setQty(id, q) {
    q = Math.max(0, Math.min(20, q));
    if (q) cart.items[id] = q; else delete cart.items[id];
    dropPend(); saveCart(); render();
  }

  /* ---------- render ---------- */
  function render() {
    if (!S) return;
    $('#tno').innerHTML = '<b>' + S.table.number + '</b>번 테이블';
    $('#conn').hidden = conn;
    var bn = $('#banner');
    bn.hidden = S.orderingOpen;
    if (!S.orderingOpen) bn.textContent = '지금은 주문을 받지 않아요. 게임은 계속 즐길 수 있어요!';
    Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) { if (b.dataset.v === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    var act = S.orders.filter(function (o) { return o.status === 'pending' || o.status === 'cooking'; }).length;
    var cp = S.coupons.filter(function (c) { return c.status === 'issued'; }).length;
    var bo = $('#b-orders'), bc = $('#b-coupon');
    bo.hidden = !act; bo.textContent = act; bc.hidden = !cp; bc.textContent = cp;
    var p = $('#panel');
    p.innerHTML = tab === 'menu' ? htmlMenu() : tab === 'orders' ? htmlOrders() : tab === 'game' ? htmlGame() : htmlCoupons();
    var t = totals(), cb = $('#cartbar');
    cb.hidden = !(tab === 'menu' && t.n > 0);
    if (!cb.hidden) cb.innerHTML = '<span>장바구니 ' + t.n + '개</span><span>' + won(t.total) + ' 보기</span>';
    if (sheetKind === '장바구니') renderCart();
  }

  function htmlMenu() {
    var cats = ['전체'].concat(S.menu.categories);
    var h = '<div class="chips" role="group" aria-label="카테고리">' + cats.map(function (c) { return '<button class="chip" data-a="cat" data-v="' + esc(c) + '" aria-pressed="' + (c === cat) + '">' + esc(c) + '</button>'; }).join('') + '</div>';
    var items = S.menu.items.filter(function (i) { return cat === '전체' || i.cat === cat; });
    if (!items.length) return h + '<p class="empty">메뉴가 없어요</p>';
    return h + '<ul>' + items.map(function (i) {
      var q = cart.items[i.id] || 0, act;
      if (i.soldOut) act = '<span class="so-tag">품절</span>';
      else if (!q) act = '<button class="btn pri add" data-a="add" data-v="' + esc(i.id) + '" aria-label="' + esc(i.name) + ' 담기">담기</button>';
      else act = '<div class="step"><button data-a="dec" data-v="' + esc(i.id) + '" aria-label="' + esc(i.name) + ' 하나 빼기">&minus;</button><output>' + q + '</output><button data-a="inc" data-v="' + esc(i.id) + '" aria-label="' + esc(i.name) + ' 하나 더">+</button></div>';
      return '<li class="it' + (i.soldOut ? ' so' : '') + '"><div class="inf"><b>' + esc(i.name) + '</b>' + (i.desc ? '<p>' + esc(i.desc) + '</p>' : '') + '<span class="pr">' + won(i.price) + '</span></div>' + act + '</li>';
    }).join('') + '</ul>';
  }

  function htmlOrders() {
    var live = S.orders.filter(function (o) { return o.status !== 'cancelled'; });
    var total = 0, unpaid = 0;
    live.forEach(function (o) { total += o.total; if (!o.paid) unpaid += o.total; });
    var h = '<div class="card sumcard"><div><div style="color:var(--muted)">테이블 합계</div><div class="big">' + won(total) + '</div></div><div style="text-align:right"><div style="color:var(--muted)">아직 안 낸 금액</div><b>' + won(unpaid) + '</b></div></div>';
    h += '<div class="sec">직원 호출</div><div class="calls">' + S.callTypes.map(function (t) {
      var open = S.calls.some(function (c) { return c.type === t; }), cd = (callCd[t] || 0) > Date.now();
      return '<button class="btn" data-a="call" data-v="' + esc(t) + '"' + (open || cd ? ' disabled' : '') + '>' + esc(t) + (open ? ' (요청됨)' : '') + '</button>';
    }).join('') + '</div>';
    h += '<div class="sec">주문 내역</div>';
    if (!S.orders.length) return h + '<p class="empty">아직 주문이 없어요.<br>메뉴 탭에서 주문해 보세요!</p>';
    return h + S.orders.map(function (o) {
      var cx = o.status === 'cancelled', idx = STEPS.indexOf(o.status);
      var trk = cx ? '<span class="badge bad">취소됨</span>' : '<ol class="trk" aria-label="진행 상태">' + STEP_L.map(function (l, i) { return '<li class="' + (i < idx ? 'done' : i === idx ? 'cur' : '') + '">' + l + '</li>'; }).join('') + '</ol>';
      var pay = cx ? '' : o.paid ? '<span class="badge ok">입금 확인</span>' : o.total === 0 ? '<span class="badge ok">결제 불필요</span>' : '<span class="badge warn">미입금</span>';
      var acts = '';
      if (!cx && !o.paid && o.total > 0) acts += '<button class="btn sm" data-a="pay" data-v="' + o.id + '">송금 안내</button>';
      if (o.status === 'pending' && !o.paid) acts += '<button class="btn sm danger" data-a="cancel" data-v="' + o.id + '">' + (cancelArm[o.id] ? '정말 취소할게요' : '주문 취소') + '</button>';
      return '<article class="card ord' + (cx ? ' cx' : '') + '"><header><b>#' + o.id + ' <small style="color:var(--muted);font-weight:600">' + hhmm(o.createdAt) + '</small></b><span>' + (cx ? trk : pay) + '</span></header>' + (cx ? '' : trk) +
        '<ul>' + o.items.map(function (i) { return '<li><span>' + esc(i.name) + ' x ' + i.qty + '</span><span>' + won(i.unitPrice * i.qty) + '</span></li>'; }).join('') + '</ul>' +
        (o.discount ? '<div class="sum"><span>쿠폰 할인</span><span>-' + won(o.discount) + '</span></div>' : '') +
        '<div class="tt"><span>합계</span><span class="' + (cx ? 'del' : '') + '">' + won(o.total) + '</span></div>' +
        (o.note ? '<div class="nt">요청: ' + esc(o.note) + '</div>' : '') + (acts ? '<div class="acts">' + acts + '</div>' : '') + '</article>';
    }).join('');
  }

  function htmlGame() {
    var h = '<div class="nickrow"><span>' + (S.nick ? '닉네임 <b>' + esc(S.nick) + '</b>' : '게임 전에 닉네임을 정해요') + '</span><button class="btn sm" data-a="nick">' + (S.nick ? '변경' : '정하기') + '</button></div>';
    var desc = { pour: '화면을 꾹 눌러 잔을 채우고 빨간 선에서 손을 떼요. 5잔, 넘치면 0점!', cheers: '두 잔이 부딪히는 순간 탭! 10번 건배, 가짜 감속에 속지 마세요.' };
    ['pour', 'cheers'].forEach(function (g) {
      var info = S.games[g]; if (!info) return;
      var best = lsGet('jb:best:' + g);
      h += '<article class="card gc"><h3>' + esc(info.label) + '</h3><p>' + desc[g] + ' (최대 ' + info.maxScore + '점' + (best ? ', 내 최고 ' + best + '점' : '') + ')</p>';
      S.rewards.filter(function (r) { return r.game === g; }).forEach(function (r) {
        var st = r.got ? '<span class="badge ok">받음</span>' : r.soldOut ? '<span class="badge bad">재고 소진</span>' : '<span class="badge warn">받을 수 있어요</span>';
        h += '<div class="rw"><span><b>' + esc(r.label) + '</b> <small>' + r.threshold + '점 이상</small></span>' + st + '</div>';
      });
      h += '<button class="btn pri big" data-a="play" data-v="' + g + '"' + (gameBusy ? ' disabled' : '') + '>플레이</button></article>';
    });
    return h;
  }

  function couponCard(c) {
    var used = c.status === 'used';
    return '<article class="cp' + (used ? ' used' : '') + '"><div class="lb">' + esc(c.label) + '</div><div class="code" aria-label="쿠폰 코드 ' + esc(c.code.split('').join(' ')) + '">' + esc(c.code) + '</div><div class="hint">' + (used ? '사용 완료' : c.type === 'item' ? '직원에게 이 화면을 보여 주세요' : '주문할 때 장바구니에서 선택하세요') + '</div></article>';
  }
  function htmlCoupons() {
    if (!S.coupons.length) return '<p class="empty">아직 받은 쿠폰이 없어요.<br>게임에서 점수를 넘기면 쿠폰이 나와요!</p><button class="btn pri big" data-a="tab" data-v="game">게임하러 가기</button>';
    var cs = S.coupons.slice().sort(function (a, b) { return (a.status === 'used') - (b.status === 'used') || b.createdAt - a.createdAt; });
    return cs.map(couponCard).join('');
  }

  /* ---------- cart / order ---------- */
  function openCart() {
    var sh = openSheet('장바구니',
      '<h2>장바구니</h2><ul class="cl" id="cl"></ul>' +
      '<label class="fld">쿠폰<select id="cc"></select></label>' +
      '<label class="fld">요청사항 (선택)<input id="cn" maxlength="100" placeholder="예: 덜 맵게" autocomplete="off"></label>' +
      '<div class="sum"><span>상품 금액</span><span id="cs"></span></div><div class="sum" id="cdr"><span>쿠폰 할인</span><span id="cd"></span></div>' +
      '<div class="sum tot"><span>결제 금액</span><span id="ct"></span></div>' +
      '<button class="btn pri big" id="csub" data-a="submit"></button><p class="err" id="cerr" role="alert"></p>');
    var cn = $('#cn', sh); cn.value = cart.note;
    cn.addEventListener('input', function () { cart.note = cn.value; dropPend(); saveCart(); });
    $('#cc', sh).addEventListener('change', function (e) { cart.coupon = e.target.value; dropPend(); saveCart(); renderCart(); });
    renderCart();
  }
  function renderCart() {
    var L = lines(), t = totals();
    if (sheetKind !== '장바구니') return;
    if (!L.length) { closeSheet(); return; }
    $('#cl').innerHTML = L.map(function (l) {
      return '<li class="' + (l.soldOut ? 'so' : '') + '"><div class="n"><b>' + esc(l.it.name) + '</b><small>' + (l.soldOut ? '품절 - 주문에서 빠져요' : won(l.it.price)) + '</small></div><div class="step"><button data-a="dec" data-v="' + esc(l.id) + '" aria-label="' + esc(l.it.name) + ' 하나 빼기">&minus;</button><output>' + l.qty + '</output><button data-a="inc" data-v="' + esc(l.id) + '" aria-label="' + esc(l.it.name) + ' 하나 더">+</button></div></li>';
    }).join('');
    var opts = '<option value="">쿠폰 사용 안 함</option>';
    S.coupons.forEach(function (c) { if (c.status === 'issued' && c.type === 'discount') opts += '<option value="' + esc(c.code) + '"' + (c.code === cart.coupon ? ' selected' : '') + '>' + esc(c.label) + ' (' + esc(c.code) + ')</option>'; });
    var sel = $('#cc'); if (sel.innerHTML !== opts) sel.innerHTML = opts;
    $('#cs').textContent = won(t.sub); $('#cd').textContent = '-' + won(t.disc); $('#cdr').hidden = !t.disc; $('#ct').textContent = won(t.total);
    var b = $('#csub');
    b.disabled = sending || !t.n || !S.orderingOpen;
    b.textContent = !S.orderingOpen ? '지금은 주문을 받지 않아요' : sending ? '보내는 중…' : netFailed ? '다시 시도' : '주문하기 ' + won(t.total);
  }
  function pendKey() { return 'jb:pend:' + TOKEN + ':' + (S ? S.table.seat : 0); }
  function savePend() { lsSet(pendKey(), pend ? JSON.stringify(pend) : null); }
  function loadPend() { try { var p = JSON.parse(lsGet(pendKey()) || 'null'); if (p && p.key && p.body) pend = p; } catch (e) {} }
  function dropPend() { pend = null; netFailed = false; savePend(); }
  function cerr(m) { var e = $('#cerr'); if (e) e.textContent = m; }
  function submit() {
    if (sending || !S.orderingOpen) return;
    if (!pend) {   // freeze body + key at first attempt; every retry (even after reload) resends exactly this
      var L = lines().filter(function (l) { return !l.soldOut; });
      if (!L.length) return;
      var body = { items: L.map(function (l) { return { id: l.id, qty: l.qty }; }) };
      if (cart.coupon) body.couponCode = cart.coupon;
      if (cart.note.trim()) body.note = cart.note.trim();
      pend = { key: newKey(), body: body }; savePend();
    }
    sendPend();
  }
  function sendPend() {
    var body = {}; Object.keys(pend.body).forEach(function (k) { body[k] = pend.body[k]; }); body.key = pend.key;
    sending = true; cerr(''); renderCart();
    api('/orders', body).then(function (r) {
      sending = false;
      if (r.ok) {
        var o = r.data.order;
        dropPend(); cart = { items: {}, note: '', coupon: '' }; saveCart();
        if (!S.orders.some(function (x) { return x.id === o.id; })) S.orders.unshift(o);
        closeSheet(true); vib(40); openPay(o, true); render();
        return;
      }
      var d = r.data, e = d.error, msg = d.message || '주문하지 못했어요';
      if (r.status >= 500) { netFailed = true; render(); cerr(msg + ' 다시 시도를 눌러 주세요 (중복 주문은 되지 않아요).'); if (sheetKind !== '장바구니') toast(msg); return; }
      dropPend();   // definitive 4xx answer: the next attempt is a new request
      if (e === 'sold_out') {
        (d.ids || []).forEach(function (id) { delete cart.items[id]; }); saveCart();
        msg = (d.names && d.names.length ? d.names.join(', ') : '일부 메뉴') + ' 품절! 장바구니에서 뺐어요. 확인 후 다시 주문해 주세요.';
        api('').then(function (s) { if (s.ok) applyState(s.data); }, function () {});
      } else if (e === 'closed') { S.orderingOpen = false; }
      else if (e === 'too_many_orders') msg = '이 테이블의 주문 횟수 한도에 도달했어요. 스태프에게 말씀해 주세요.';
      else if (e === 'coupon_used' || e === 'bad_coupon' || e === 'coupon_not_discount') { cart.coupon = ''; saveCart(); }
      else if (e === 'unknown_item') { (d.ids || []).forEach(function (id) { delete cart.items[id]; }); saveCart(); }
      render(); if (sheetKind === '장바구니') cerr(msg); else toast(msg);
    }, function () {
      sending = false; netFailed = true; renderCart();
      cerr('네트워크가 불안정해요. 장바구니는 그대로예요. 다시 시도를 눌러 주세요 (중복 주문은 되지 않아요).');
      if (sheetKind !== '장바구니') toast('주문 전송을 확인하지 못했어요. 장바구니에서 다시 시도해 주세요.');
    });
  }
  function resumePend() {
    if (!pend || sending) return;
    toast('이전 주문 전송을 확인하는 중'); sendPend();
  }

  function copyText(txt) {
    function fb() {
      var ta = document.createElement('textarea'); ta.value = txt; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px';
      document.body.appendChild(ta); ta.focus(); ta.select(); ta.setSelectionRange(0, 999);
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) {} document.body.removeChild(ta); return ok;
    }
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(txt).then(function () { return true; }, function () { return fb(); });
    return Promise.resolve(fb());
  }
  function openPay(o, fresh) {
    var p = S.pay || {}, has = p.account;
    openSheet('송금 안내',
      '<h2>' + (fresh ? '주문이 접수됐어요!' : '송금 안내') + '</h2><p class="note" style="margin:-6px 0 10px">#' + o.id + ' 주문 ' + (fresh ? '· 직원이 확인하면 조리를 시작해요' : '') + '</p>' +
      (o.total > 0 ? '<div class="amt">' + won(o.total) + '</div>' + (has ? '<div class="acct"><div class="bank">' + esc(p.bank) + ' · 예금주 ' + esc(p.holder) + '</div><div class="no">' + esc(p.account) + '</div></div><button class="btn pri big" data-a="copy" data-v="' + esc(p.account) + '">계좌번호 복사</button>' : '<div class="acct">계좌 정보는 직원에게 문의해 주세요.</div>') +
        '<p class="note">송금 후 직원이 입금을 확인하면 주문현황에 "입금 확인"으로 바뀌어요.</p>' : '<div class="acct">쿠폰으로 전액 할인돼서 보낼 금액이 없어요.</div>') +
      '<button class="btn big" style="margin-top:14px" data-a="sclose">확인</button>',
      function () { if (fresh) { tab = 'orders'; render(); } });
  }
  function askNick(cb) {
    var sh = openSheet('닉네임',
      '<h2>닉네임을 정해요</h2><p class="note" style="margin:-6px 0 4px">전광판 랭킹에 표시돼요. (1~10자)</p>' +
      '<form id="nf"><input class="inp" id="ni" maxlength="10" autocomplete="off" enterkeyhint="done" placeholder="예: 맥주왕" aria-label="닉네임"><p class="err" id="ne" role="alert"></p><button class="btn pri big" type="submit">저장</button></form>');
    var ni = $('#ni', sh); ni.value = S.nick || ''; ni.focus();
    $('#nf', sh).addEventListener('submit', function (e) {
      e.preventDefault();
      var v = ni.value.trim(); if (!v) { $('#ne').textContent = '닉네임을 입력해 주세요'; return; }
      api('/nick', { nick: v }).then(function (r) {
        if (!r.ok) { $('#ne').textContent = r.data.message || '사용할 수 없는 닉네임이에요'; return; }
        S.nick = r.data.nick; closeSheet(true); render(); if (cb) cb();
      }, function () { $('#ne').textContent = '네트워크 오류예요. 다시 시도해 주세요.'; });
    });
  }

  /* ---------- games ---------- */
  var MODS = { pour: 'PourGame', cheers: 'CheersGame' };
  function loadMod(id) {
    if (window[MODS[id]]) return Promise.resolve();
    return new Promise(function (res, rej) {
      var s = document.createElement('script'); s.src = BASE + '/static/games/' + id + '.js';
      s.onload = res; s.onerror = function () { rej(new Error('load')); }; document.head.appendChild(s);
    });
  }
  function startPlay(id, tries) {
    return api('/plays/start', { game: id }).then(function (r) {
      if (!r.ok && r.data.error === 'rate_limited' && tries < 2) {
        return new Promise(function (res) { setTimeout(res, Math.min(4000, (r.data.retryAfterMs || 1000) + 100)); }).then(function () { return startPlay(id, tries + 1); });
      }
      return r;
    });
  }
  function playGame(id) {
    if (gameBusy) return;
    if (!S.nick) { askNick(function () { playGame(id); }); return; }
    gameBusy = true; render();
    loadMod(id).then(function () { return startPlay(id, 0); }).then(function (r) {
      gameBusy = false; render();
      if (!r.ok) {
        var m = r.data.message || '게임을 시작하지 못했어요';
        if (r.data.error === 'seat_limit') m = '이 자리에서 할 수 있는 게임 횟수를 모두 사용했어요.';
        else if (r.data.error === 'too_many_open') m = '끝나지 않은 게임이 너무 많아요. 잠시 후 다시 해 주세요.';
        else if (r.status === 429 && r.data.retryAfterMs) m = Math.ceil(r.data.retryAfterMs / 1000) + '초 뒤에 다시 시작할 수 있어요';
        else if (r.status >= 400 && r.status < 500 && !r.data.error) m += ' (쿠키를 차단했다면 허용해 주세요)';
        toast(m); return;
      }
      openGame(id, r.data, performance.now());
    }).catch(function () { gameBusy = false; render(); toast('연결이 불안정해요. 잠시 후 다시 해 주세요.'); });
  }
  function openGame(id, play, t0) {
    var root = $('#game-root');
    root.innerHTML = '<div class="gscr" role="dialog" aria-modal="true" aria-label="' + esc(S.games[id].label) + '"><div class="ghd"><button class="x" data-a="gexit" aria-label="게임 나가기">&times;</button><span class="gt">' + esc(S.games[id].label) + '</span></div><div class="ghost" id="ghost"></div></div>';
    document.body.style.overflow = 'hidden';
    var mod = window[MODS[id]], my = ++gameSeq;
    var h = mod.mount($('#ghost'), {
      reduced: REDUCED, vibrate: vib,
      onDone: function (score) { finishPlay(id, play, score, t0, my); },
      onAbort: function () { closeGame(); toast('화면이 가려져서 게임이 중단됐어요. 다시 도전해 보세요!'); }
    });
    game = { id: id, handle: h };
  }
  function closeGame() {
    if (game && game.handle) game.handle.destroy();
    gameSeq++; game = null; $('#game-root').innerHTML = ''; document.body.style.overflow = '';
  }
  function overlay(html) {
    var host = $('#ghost'); if (!host) return null;
    var o = $('.gover', host); if (!o) { o = document.createElement('div'); o.className = 'gover'; host.appendChild(o); }
    o.innerHTML = html; return o;
  }
  function finishPlay(id, play, score, t0, my) {
    overlay('<div class="spin" role="status"></div><div class="msg">점수를 집계하고 있어요…</div>');
    var min = (S.games[id] && S.games[id].minDurationMs) || 0;
    var wait = Math.max(0, min + 600 - (performance.now() - t0));   // never finish earlier than the server minimum
    setTimeout(function () { if (my === gameSeq) sendFinish(id, play, score, my); }, wait);
  }
  function sendFinish(id, play, score, my) {
    api('/plays/finish', { playId: play.playId, score: score }).then(function (r) {
      if (my !== gameSeq || !$('#ghost')) return;   // stale response: user left or started a newer game
      if (r.ok) return showResult(id, score, r.data);
      if (r.data.error === 'already_finished') { closeGame(); toast('이미 기록된 판이에요. 쿠폰 탭을 확인해 보세요'); poll(); return; }
      if (r.data.error === 'no_play') { closeGame(); toast('자리가 바뀌어 이번 판은 기록되지 않았어요'); return; }
      overlay('<div class="msg">' + esc(r.data.message || '점수를 저장하지 못했어요') + '</div><div class="row"><button class="btn pri" data-a="gagain" data-v="' + id + '">다시 도전</button><button class="btn" data-a="gexit">닫기</button></div>');
    }, function () {
      if (my !== gameSeq || !$('#ghost')) return;
      overlay('<div class="msg">네트워크가 불안정해요</div><p class="note">점수는 그대로예요. 다시 시도해 주세요.</p><div class="row"><button class="btn pri" id="rt">다시 시도</button><button class="btn" data-a="gexit">닫기</button></div>');
      $('#rt').onclick = function () { overlay('<div class="spin"></div>'); sendFinish(id, play, score, my); };
    });
  }
  function showResult(id, score, d) {
    var info = S.games[id], bk = 'jb:best:' + id, prevBest = Number(lsGet(bk) || 0), best = Math.max(prevBest, score);
    lsSet(bk, String(best));
    (d.coupons || []).forEach(function (c) { if (!S.coupons.some(function (x) { return x.code === c.code; })) S.coupons.push(c); });
    (d.rewards || []).forEach(function (r) { if (r.result === 'issued') S.rewards.forEach(function (x) { if (x.id === r.rewardId) x.got = true; }); });
    var h = '<div style="color:var(--muted);font-weight:700">' + esc(info.label) + '</div><div class="score">' + score + '</div><div class="best">' + (score > prevBest && prevBest ? '신기록! ' : '') + '내 최고 ' + best + '점 / ' + info.maxScore + '점</div>';
    var issued = (d.rewards || []).filter(function (r) { return r.result === 'issued' && r.coupon; });
    issued.forEach(function (r) { h += '<div class="reveal"><div style="font-size:20px;font-weight:900;color:var(--amber);margin-bottom:6px">쿠폰 당첨!</div>' + couponCard(r.coupon) + '<p class="note" style="margin:-4px 0 6px">쿠폰 탭에도 저장됐어요</p></div>'; });
    (d.rewards || []).forEach(function (r) {
      if (r.result === 'issued') return;
      var th = (S.rewards.filter(function (x) { return x.id === r.rewardId; })[0] || {}).threshold;
      var m = r.result === 'low_score' ? (issued.length ? '' : '<div class="msg">아쉬워요! ' + esc(r.label) + '까지 ' + (th ? Math.max(1, th - score) + '점 남았어요' : '조금만 더!') + '</div><p class="note">' + (th ? th + '점 이상이면 받을 수 있어요. ' : '') + '다시 도전!</p>')
        : r.result === 'already_got' ? '<p class="note">' + esc(r.label) + '은(는) 이미 받았어요</p>'
        : '<p class="note">' + esc(r.label) + ' 재고가 모두 소진됐어요</p>';
      h += m;
    });
    h += '<div class="row"><button class="btn pri" data-a="gagain" data-v="' + id + '">다시 도전</button>' + (issued.length ? '<button class="btn" data-a="gcoupon">쿠폰 보기</button>' : '<button class="btn" data-a="gexit">닫기</button>') + '</div>';
    var o = overlay(h);
    if (issued.length && o && !REDUCED) {
      var cf = document.createElement('div'); cf.className = 'conf'; var cols = ['#ffb020', '#ff6e3d', '#4cd08a', '#f5efe6', '#ff5a4d'];
      for (var i = 0; i < 36; i++) { var e = document.createElement('i'); e.style.cssText = 'left:' + Math.random() * 100 + '%;background:' + cols[i % 5] + ';animation-delay:' + Math.random() * 0.8 + 's;animation-duration:' + (1.8 + Math.random() * 1.4) + 's'; cf.appendChild(e); }
      o.appendChild(cf); vib([80, 40, 80, 40, 160]);
    }
    render();
  }

  /* ---------- actions ---------- */
  document.addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-a]'); if (!b) return;
    var a = b.dataset.a, v = b.dataset.v;
    if (a === 'bk') { if (ev.target === b) closeSheet(); return; }
    switch (a) {
      case 'tab': tab = v; render(); window.scrollTo(0, 0); break;
      case 'cat': cat = v; render(); break;
      case 'add': setQty(v, 1); break;
      case 'inc': setQty(v, (cart.items[v] || 0) + 1); break;
      case 'dec': setQty(v, (cart.items[v] || 0) - 1); break;
      case 'cart': openCart(); break;
      case 'submit': submit(); break;
      case 'sclose': closeSheet(); break;
      case 'copy': copyText(v).then(function (ok) { toast(ok ? '계좌번호를 복사했어요' : '복사하지 못했어요. 길게 눌러 직접 복사해 주세요'); }); break;
      case 'pay': var o = S.orders.filter(function (x) { return x.id === Number(v); })[0]; if (o) openPay(o, false); break;
      case 'cancel':
        if (!cancelArm[v]) { cancelArm[v] = true; render(); setTimeout(function () { delete cancelArm[v]; if (S) render(); }, 3500); break; }
        delete cancelArm[v];
        api('/orders/' + encodeURIComponent(v) + '/cancel', {}).then(function (r) {
          toast(r.ok ? '주문을 취소했어요' : (r.data.message || '취소할 수 없어요'));
          return api('').then(function (s) { if (s.ok) applyState(s.data); });
        }, function () { toast('네트워크 오류예요. 다시 시도해 주세요.'); });
        break;
      case 'call':
        callCd[v] = Date.now() + 15000; render(); setTimeout(function () { if (S) render(); }, 15200);
        api('/calls', { type: v }).then(function (r) {
          if (r.ok) { toast(r.data.duplicate ? v + ' 요청이 이미 전달됐어요' : '직원을 불렀어요 (' + v + ')'); vib(30); }
          else { delete callCd[v]; toast(r.data.message || '호출하지 못했어요'); render(); }
        }, function () { delete callCd[v]; toast('네트워크 오류예요. 다시 눌러 주세요.'); render(); });
        break;
      case 'reload': location.reload(); break;
      case 'nick': askNick(); break;
      case 'play': playGame(v); break;
      case 'gexit': closeGame(); break;
      case 'gagain': closeGame(); playGame(v); break;
      case 'gcoupon': closeGame(); tab = 'coupon'; render(); window.scrollTo(0, 0); break;
    }
  });

  /* ---------- realtime ---------- */
  function setConn(v) { conn = v; var c = $('#conn'); if (c) c.hidden = v; }
  function poll() {
    var t = Date.now();
    api('').then(function (r) {
      if (lastSse > t && r.ok) return;   // a newer SSE frame already arrived
      if (r.status === 404) return fatal('QR 코드를 다시 찍어 주세요', '이 테이블 주소를 찾을 수 없어요.');
      if (r.ok) applyState(r.data);
    }, function () {});
  }
  function startPoll() { if (!pollT) pollT = setInterval(poll, 5000); }
  function stopPoll() { clearInterval(pollT); pollT = null; }
  var rcT = null;
  function connect() {
    clearTimeout(rcT); rcT = null;
    if (es) { es.onopen = es.onerror = null; es.close(); es = null; }
    if (!window.EventSource) { setConn(false); startPoll(); return; }
    es = new EventSource(API + '/events');
    es.onopen = function () { setConn(true); stopPoll(); };
    es.addEventListener('state', function (e) { lastSse = Date.now(); setConn(true); stopPoll(); try { applyState(JSON.parse(e.data)); } catch (x) {} });
    es.addEventListener('cleared', function () { onCleared(); });
    es.onerror = function () {
      setConn(false); startPoll();
      if (es.readyState === 2 && !rcT) { es.close(); rcT = setTimeout(connect, 5000); }
    };
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && S) poll(); });
  window.addEventListener('pagehide', function () { clearTimeout(rcT); if (es) { es.onopen = es.onerror = null; es.close(); es = null; } stopPoll(); });
  window.addEventListener('pageshow', function (e) { if (e.persisted && S) { connect(); poll(); } });

  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('#tabs [data-a="tab"]'); if (t) closeSheet(true);
  }, true);

  function boot() {
    api('').then(function (r) {
      if (r.status === 404) return fatal('QR 코드를 다시 찍어 주세요', '이 테이블 주소를 찾을 수 없어요. 테이블에 붙은 QR을 다시 찍어 주세요.');
      if (!r.ok) { $('#panel').innerHTML = '<p class="empty">' + esc(r.data.message || '불러오지 못했어요') + '</p><button class="btn pri big" data-a="reload">다시 불러오기</button>'; return; }
      applyState(r.data); connect(); resumePend();
    }, function () {
      $('#panel').innerHTML = '<p class="empty">연결할 수 없어요.<br>와이파이나 데이터를 확인해 주세요.</p><button class="btn pri big" data-a="reload">다시 불러오기</button>';
    });
  }
  boot();
})();

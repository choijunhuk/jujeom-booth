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
  var M = null, lastMemberCheck = 0, priceChg = null;   // M = {enabled, member, pct}
  var quietClear = false, shareAvail = null, partyN = 2, partyAsked = 0, pendingAfterParty = false, shareSel = { mode: 'one', n: 1 }, sharePayer = '', shareView = null;
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
  function toast(msg, ms) {
    var t = $('#toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(toastT); toastT = setTimeout(function () { t.classList.remove('on'); }, ms || 2800);
  }
  /* ---------- alarms: toast + chime + vibration + (hidden tab) notification ---------- */
  var actx = null, muted = lsGet('jb:mute') === '1', gamePlaying = false, alertQ = [], selfCancel = {};
  function unlockAudio() {
    try {
      if (actx) { if (actx.state === 'suspended') actx.resume().catch(function () {}); return; }
      var A = window.AudioContext || window.webkitAudioContext; if (!A) return;
      actx = new A(); if (actx.state === 'suspended') actx.resume().catch(function () {});
    } catch (e) {}
  }
  ['pointerdown', 'keydown', 'touchend'].forEach(function (ev) { document.addEventListener(ev, unlockAudio, { capture: true, passive: true }); });
  var CH = { info: [[659, 0], [880, 0.12]], served: [[523, 0], [659, 0.1], [784, 0.2], [1047, 0.32]], warn: [[587, 0], [440, 0.14]], coupon: [[1319, 0], [1568, 0.09], [1976, 0.18], [2349, 0.27]] };
  function chime(kind) {
    if (muted || !actx) return;
    try {
      if (actx.state === 'suspended') actx.resume();
      var t0 = actx.currentTime + 0.02, len = kind === 'served' ? 0.7 : 0.45;
      (CH[kind] || CH.info).forEach(function (n) {
        var o = actx.createOscillator(), g = actx.createGain(), at = t0 + n[1];
        o.type = 'sine'; o.frequency.value = n[0];
        g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.22, at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, at + len);
        o.connect(g); g.connect(actx.destination); o.start(at); o.stop(at + len + 0.1);
      });
    } catch (e) {}
  }
  function notifSupported() { return !!(window.BoothNotify && BoothNotify.supported()); }
  function notifOn() { return notifSupported() && lsGet('jb:notif') === '1' && BoothNotify.permission() === 'granted'; }
  function alertUser(kind, msg, tag) {
    if (gamePlaying) { alertQ.push([kind, msg, tag]); return; }   // never chime over a running game
    toast(msg, 3800); chime(kind); vib(kind === 'served' ? [80, 50, 80, 50, 160] : [60]);
    if (document.hidden && notifOn()) {
      BoothNotify.show('주점 부스 · ' + (S.table.isTest ? '테스트' : S.table.number + '번 테이블'), { body: msg, tag: tag, url: location.href });
    }
  }
  function flushAlerts() {
    if (gamePlaying || !alertQ.length) return;
    var q = alertQ; alertQ = [];
    if (q.length === 1) { alertUser(q[0][0], q[0][1], q[0][2]); return; }
    var kinds = q.map(function (x) { return x[0]; });
    toast(q.map(function (x) { return x[1]; }).join(' · '), 5000); chime(kinds.indexOf('served') >= 0 ? 'served' : kinds[0]); vib([80, 50, 80]);
    if (document.hidden && notifOn()) q.forEach(function (x) { BoothNotify.show('주점 부스 · ' + (S.table.isTest ? '테스트' : S.table.number + '번 테이블'), { body: x[1], tag: x[2], url: location.href }); });
  }
  function toggleNotif() {
    if (!notifSupported()) return;
    if (notifOn()) { lsSet('jb:notif', '0'); toast('알림을 껐어요'); render(); return; }
    if (BoothNotify.permission() === 'denied') { toast('브라우저 설정에서 알림을 허용해 주세요'); return; }
    BoothNotify.request().then(function (p) {
      if (p === 'granted') { lsSet('jb:notif', '1'); toast('알림을 켰어요. 화면이 꺼져 있어도 알려 드릴게요'); } else toast('알림이 허용되지 않았어요');
      var o = $('#notifOffer'); if (o) o.remove(); render();
    });
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
    document.body.innerHTML = '<div class="y2k-window" style="margin:16px 8px"><div class="y2k-title"><i class="y2k-ico"></i><span class="y2k-title-t">COMHERE.exe</span></div><div class="y2k-body fatal"><h2>' + esc(title) + '</h2><p>' + esc(msg) + '</p></div></div>';
  }

  /* ---------- sheets ---------- */
  var sheetOpener = null, sheetKind = '';
  function openSheet(kind, html, onClose) {
    closeSheet(true);
    sheetKind = kind; sheetOpener = document.activeElement;
    var root = $('#sheet-root');
    root.innerHTML = '<div class="sheet-bk" data-a="bk"><div class="sheet" role="dialog" aria-modal="true" aria-label="' + esc(kind) + '" tabindex="-1"><div class="y2k-title"><i class="y2k-ico" aria-hidden="true"></i><span class="y2k-title-t">' + esc(kind) + '</span><button class="sx" data-a="sclose" aria-label="닫기">&times;</button></div><div class="sbody">' + html + '</div></div></div>';
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
      if (d.table.seat < prev.table.seat) {   // staff undid a clear: the old seat is back
        cart = { items: {}, note: '', coupon: '' }; pend = null; loadCart(); loadPend(); closeSheet(true); closeGame(); toast('직원이 테이블을 이전 상태로 되돌렸어요');
      } else if (clearedSeat === prev.table.seat) clearedSeat = null; else onCleared(true);
    }
    else detectChanges(prev, d);
    if (S.menu.categories.indexOf(cat) < 0) cat = '전체';
    if (M && d.memberDiscount) {
      var rc = false;
      ['enabled', 'mode', 'pct', 'amount', 'minOrder', 'maxDiscount', 'stackWithCoupon'].forEach(function (k) { if (d.memberDiscount[k] !== undefined && M[k] !== d.memberDiscount[k]) { M[k] = d.memberDiscount[k]; rc = true; } });
      if (rc) checkMember(false);
    }
    sanitizeCart(prev);
    render();
  }
  function detectChanges(p, d) {
    var pm = {}, have = {};
    p.orders.forEach(function (o) { pm[o.id] = o; });
    p.coupons.forEach(function (c) { have[c.code] = 1; });
    d.orders.forEach(function (o) {
      var q = pm[o.id]; if (!q || o.kind === 'cover') return;
      if (q.status !== o.status) {
        if (o.status === 'cooking') alertUser('info', o.id + '번 주문 조리를 시작했어요', 'order-' + o.id + '-cooking');
        else if (o.status === 'served') alertUser('served', '주문하신 메뉴가 나갔어요 (' + o.id + '번 주문)', 'order-' + o.id + '-served');
        else if (o.status === 'cancelled' && !selfCancel[o.id]) alertUser('warn', o.id + '번 주문이 취소됐어요', 'order-' + o.id + '-cancelled');
      }
      if (o.status !== 'cancelled' && (q.total !== o.total || itemsSig(q) !== itemsSig(o))) alertUser('info', '직원이 주문을 수정했어요 (' + o.id + '번 주문, 금액 ' + won(o.total) + ')', 'order-' + o.id + '-edit');
      if (!q.paid && o.paid && o.status !== 'cancelled') alertUser('info', '입금이 확인됐어요 (' + o.id + '번 주문)', 'order-' + o.id + '-paid');
    });
    var dm = {}; d.orders.forEach(function (o) { dm[o.id] = 1; });
    p.orders.forEach(function (o) { if (!dm[o.id] && o.status !== 'cancelled' && o.kind !== 'cover') alertUser('info', o.id + '번 주문이 이 테이블에서 빠졌어요 (직원이 옮겼을 수 있어요)', 'order-' + o.id + '-gone'); });
    d.orders.forEach(function (o) { if (!pm[o.id] && o.kind !== 'cover') alertUser('info', '주문 목록이 바뀌었어요 (' + o.id + '번 주문)', 'order-' + o.id + '-new'); });
    d.coupons.forEach(function (c) {
      if (!have[c.code] && c.status === 'issued') alertUser('coupon', c.source === 'hour' ? '1등 상품 쿠폰이 도착했어요' : c.source === 'staff' ? '직원이 쿠폰을 보냈어요' : '쿠폰이 도착했어요', 'coupon-' + c.code);
    });
    if (p.party && d.party && p.party.people != null && d.party.people != null && p.party.people !== d.party.people) alertUser('info', '직원이 인원을 ' + d.party.people + '명으로 바꿨어요', 'party-' + d.party.people);
    if (p.cover && d.cover && p.cover.myIntents) {
      var nowI = {}; (d.cover.myIntents || []).forEach(function (x) { nowI[x.id] = x; });
      p.cover.myIntents.forEach(function (it) {
        var cur = nowI[it.id], paidUp = p.cover.shares && d.cover.shares && d.cover.shares.paid >= p.cover.shares.paid + it.shares;
        if (!cur) { if (!paidUp && !cancelledIntents[it.id]) alertUser('warn', Date.now() >= it.expiresAt ? '요청 시간이 지나 닫혔어요 (' + it.shares + '명분)' : '다른 분이 먼저 내서 요청이 닫혔어요', 'intent-' + it.id); }
        else if (cur.shares < it.shares) alertUser('warn', '다른 분이 먼저 내서 요청이 ' + cur.shares + '명분으로 줄었어요', 'intent-' + it.id + '-shrunk');
      });
    }
    if (p.cover && d.cover) {
      if (p.cover.shares && d.cover.shares && d.cover.shares.paid > p.cover.shares.paid) alertUser('info', '입장료 ' + (d.cover.shares.paid - p.cover.shares.paid) + '명분 입금이 확인됐어요', 'cover-paid-' + d.cover.shares.paid);
      else if (!d.cover.shares && d.cover.paid > p.cover.paid) alertUser('info', '입장료 입금이 확인됐어요', 'cover-paid-' + d.cover.paid);
    }
    if (p.orderingOpen && !d.orderingOpen) alertUser('warn', '주문이 마감됐어요', 'ordering');
    if (!p.orderingOpen && d.orderingOpen) alertUser('info', '주문을 다시 받아요!', 'ordering');
  }
  function onCleared(fromSeat) {
    lsSet(cartKey(), null); if (!fromSeat && S) clearedSeat = S.table.seat;
    cart = { items: {}, note: '', coupon: '' }; pend = null; savePend(); sending = false; netFailed = false; cancelArm = {}; callCd = {};
    closeSheet(true); closeGame();
    tab = 'menu';
    if (quietClear) quietClear = false; else toast('새 손님을 환영해요!');
    if (!fromSeat && S) { /* state event follows */ }
  }
  function sanitizeCart(prev) {
    var m = menuMap(), ch = false, gone = [], repriced = false, pm = {};
    if (prev) prev.menu.items.forEach(function (i) { pm[i.id] = i; });
    Object.keys(cart.items).forEach(function (id) {
      if (!m[id]) { gone.push(pm[id] ? pm[id].name : '메뉴'); delete cart.items[id]; ch = true; }
      else if (pm[id] && pm[id].price !== m[id].price) repriced = true;
    });
    Object.keys(cart.items).forEach(function (id) {
      var mx = maxQty(m[id]);
      if (cart.items[id] > mx) { if (mx > 0) cart.items[id] = mx; else delete cart.items[id]; ch = true; toast(m[id].name + ' 재고가 ' + mx + '개뿐이라 수량을 줄였어요'); }
    });
    if (gone.length) toast('메뉴에서 사라진 항목을 장바구니에서 뺐어요: ' + gone.join(', '));
    else if (repriced) toast('장바구니 메뉴의 가격이 바뀌었어요. 금액을 확인해 주세요');
    if (cart.coupon) {
      var ok = S.coupons.some(function (c) { return c.code === cart.coupon && c.status === 'issued' && c.type === 'discount'; });
      if (!ok) { cart.coupon = ''; ch = true; }
    }
    if (ch) saveCart();
  }
  function dueOf(o) { return o.balanceDue != null ? o.balanceDue : o.total; }
  function itemsSig(o) { return JSON.stringify((o.items || []).map(function (i) { return [i.id, i.qty, i.unitPrice, !!i.service]; })); }
  function maxQty(it) { return it && it.stockLeft != null ? Math.max(0, Math.min(20, it.stockLeft)) : 20; }
  function lines() {
    var m = menuMap();
    return Object.keys(cart.items).map(function (id) { return { id: id, it: m[id], qty: cart.items[id], soldOut: !!m[id].soldOut }; });
  }
  function ruleVal() { return !M ? 0 : M.mode === 'fixed' ? (M.amount || 0) : (M.pct || 0); }
  function ruleText() { return M.mode === 'fixed' ? won(M.amount) + ' 할인' : M.pct + '% 할인'; }
  function isMember() { return !!(M && M.enabled && M.member && ruleVal() > 0); }
  // mirrors the server: 0 below minOrder; percent floors to 100 won; fixed = amount; capped by maxDiscount (>0) and the subtotal
  function memberRaw(sub) {
    if (!isMember() || sub < (M.minOrder || 0)) return 0;
    var d = M.mode === 'fixed' ? M.amount : Math.floor(sub * M.pct / 10000) * 100;
    if (M.maxDiscount > 0) d = Math.min(d, M.maxDiscount);
    return Math.max(0, Math.min(d, sub));
  }
  function selCoupon() { return cart.coupon ? S.coupons.filter(function (x) { return x.code === cart.coupon; })[0] : null; }
  function checkMember(manual) {
    lastMemberCheck = Date.now();
    return api('/member').then(function (r) {
      if (!r.ok) return;
      var was = isMember(), had = !!M; M = r.data; if (had && !was && isMember() && !manual) toast('COMS 회원 할인이 적용돼요');
      if (manual) toast(isMember() ? 'COMS 회원으로 확인됐어요' : '아직 로그인이 확인되지 않았어요. 로그인 후 다시 확인해 주세요');
      render();
    }, function () { if (manual) toast('네트워크 오류예요. 다시 눌러 주세요.'); });
  }
  function totals() {
    var sub = 0, n = 0;
    lines().forEach(function (l) { if (!l.soldOut) { sub += l.it.price * l.qty; n += l.qty; } });
    var raw = memberRaw(sub), c = selCoupon(), sup = !!(c && M && !M.stackWithCoupon && raw > 0), mem = sup ? 0 : raw, disc = 0;
    if (c) disc = Math.min(sub - mem, c.amount || 0);
    return { n: n, sub: sub, raw: raw, sup: sup, mem: mem, disc: disc, total: Math.max(0, sub - mem - disc) };
  }
  function setQty(id, q) {
    var it = S && menuMap()[id], mx = maxQty(it);
    if (q > mx) { if (it && it.stockLeft != null) toast(it.name + '은(는) ' + it.stockLeft + '개만 남았어요'); q = mx; }
    q = Math.max(0, Math.min(20, q));
    if (q) cart.items[id] = q; else delete cart.items[id];
    dropPend(); saveCart(); render();
  }

  /* ---------- render ---------- */
  function render() {
    if (!S) return;
    var isT = !!(S.table && S.table.isTest);
    $('#tno').textContent = isT ? 'COMHERE.exe — 테스트' : 'COMHERE.exe — ' + S.table.number + '번 테이블';
    document.title = isT ? 'COMHERE · 테스트 모드' : 'COMHERE · ' + S.table.number + '번 테이블';
    $('#tm').hidden = !isT; $('#tstrip').hidden = !isT;
    var nt = $('#notice'), nn = S.notice && S.notice.text ? S.notice : null, nsig = nn ? nn.level + '|' + nn.text : '';
    nt.hidden = !nn;
    if (nn && nt.dataset.sig !== nsig) {
      nt.dataset.sig = nsig; nt.className = 'y2k-marquee gnotice' + (nn.level === 'warn' ? ' warn' : '');
      nt.innerHTML = (nn.level === 'warn' ? '<svg class="y2k-i" aria-hidden="true"><use href="' + ICO + '#i-warning"/></svg>' : '') + '<span>' + esc(nn.text) + '</span>';
      nt.setAttribute('aria-label', '공지: ' + nn.text);
    }
    $('#mbt').textContent = 'C:\\COMHERE\\' + ({ menu: 'MENU', orders: 'ORDERS', game: 'GAMES', coupon: 'COUPON' }[tab] || '');
    $('#conn').hidden = conn;
    var mu = $('#mute'); mu.setAttribute('aria-label', muted ? '알림음 켜기' : '알림음 끄기'); mu.setAttribute('aria-pressed', String(muted));
    var mb = $('#mb'); mb.hidden = !isMember(); if (isMember()) mb.textContent = 'COMS 회원 ' + ruleText();
    var bn = $('#banner');
    bn.hidden = S.orderingOpen;
    if (!S.orderingOpen) bn.textContent = '주문 접수가 닫혔습니다. 게임은 계속 즐길 수 있어요!';
    Array.prototype.forEach.call(document.querySelectorAll('#tabs button[data-v]'), function (b) { if (b.dataset.v === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); });
    var act = S.orders.filter(function (o) { return o.status === 'pending' || o.status === 'cooking'; }).length;
    var cp = S.coupons.filter(function (c) { return c.status === 'issued'; }).length;
    var bo = $('#b-orders'), bc = $('#b-coupon');
    bo.hidden = !act; bo.textContent = act; bc.hidden = !cp; bc.textContent = cp;
    var p = $('#panel');
    p.innerHTML = tab === 'menu' ? htmlMenu() : tab === 'orders' ? htmlOrders() : tab === 'game' ? htmlGame() : htmlCoupons();
    var t = totals(), cb = $('#cartbar');
    cb.hidden = !(tab === 'menu' && t.n > 0);
    if (!cb.hidden) cb.innerHTML = '<span>장바구니 ' + t.n + '개</span><span>' + won(t.total) + ' &gt;&gt;</span>';
    if (sheetKind === '장바구니') renderCart();
    if (sheetKind === '송금 안내') refreshPay();
    if (sheetKind === '입장료 송금') renderShareTransfer();
    if (sheetKind === '입장료 내기') { if (S.cover && S.cover.shares && S.cover.shares.left > 0) { var sp = $('#shp'); if (sp) sharePayer = sp.value; } }
    if (sheetKind === '인원' && S.party && !S.party.canSet) { closeSheet(true); pendingAfterParty = false; }
    var stt = $('#stat'); if (stt) { var pp = S.party && S.party.people, can = S.party && S.party.canSet; stt.hidden = !pp && !can; var py = $('#pty'); py.hidden = !pp; if (pp) py.textContent = pp + '명'; if (pp) { $('#st1').textContent = pp + '명'; $('#st2').textContent = (S.party.setBy === 'staff' || S.party.setBy === 'waitlist' ? '직원이 입력한 인원이에요. ' : '') + '인원이 바뀌면 직원에게 말씀해 주세요'; } else if (can) { $('#st1').textContent = '인원 ?'; $('#st2').innerHTML = '<button class="lnk" data-a="pt-open">인원 알려 주기</button>'; } }
    maybeAskParty();
  }

  var ICO = BASE + '/static/brand/icons.svg';
  var badPhoto = {};
  document.addEventListener('error', function (e) {   // img load failure: fall back to the text-only row (error does not bubble, so capture)
    var t = e.target; if (!t || t.tagName !== 'IMG' || !t.classList.contains('mph')) return;
    badPhoto[t.getAttribute('src').slice(BASE.length)] = 1;
    var b = t.closest('.ph'), li = t.closest('.it'); if (b) b.remove(); if (li) li.classList.remove('hasph');
    var big = t.closest('.bigph'); if (big) big.remove();
  }, true);
  function openPhoto(id) {
    var i = menuMap()[id]; if (!i) return;
    var act = i.soldOut ? '<span class="so-tag">품절</span>' : '<button class="y2k-btn big" data-a="padd" data-v="' + esc(id) + '">장바구니에 담기</button>';
    openSheet('메뉴 사진', '<h2>' + esc(i.name) + '</h2>' + (i.photo && !badPhoto[i.photo] ? '<div class="bigph"><img class="mph" src="' + esc(BASE + i.photo) + '" alt="' + esc(i.name) + '" decoding="async"></div>' : '') +
      '<div class="pr" style="font-size:22px;margin:10px 0 4px">' + won(i.price) + '</div>' + (i.desc ? '<p class="note" style="margin:0 0 14px">' + esc(i.desc) + '</p>' : '') + act);
  }
  function htmlMenu() {
    var cats = ['전체'].concat(S.menu.categories);
    var h = '<div class="addr" aria-hidden="true"><svg class="y2k-i"><use href="' + ICO + '#i-folder"/></svg>C:\\COMHERE\\메뉴\\' + esc(cat === '전체' ? '' : cat) + '</div>' +
      '<div class="y2k-tabs chips" role="group" aria-label="카테고리">' + cats.map(function (c) { return '<button class="y2k-tab" data-a="cat" data-v="' + esc(c) + '" aria-pressed="' + (c === cat) + '">' + esc(c) + '</button>'; }).join('') + '</div>';
    var items = S.menu.items.filter(function (i) { return cat === '전체' || i.cat === cat; });
    if (!items.length) return h + '<div class="mlist"><p class="empty">메뉴가 없습니다.</p></div>';
    return h + '<ul class="mlist">' + items.map(function (i) {
      var q = cart.items[i.id] || 0, act;
      if (i.soldOut) act = '<span class="so-tag">품절</span>';
      else if (!q) act = '<button class="y2k-btn add" data-a="add" data-v="' + esc(i.id) + '" aria-label="' + esc(i.name) + ' 담기"><svg class="y2k-i" aria-hidden="true"><use href="' + ICO + '#i-cart"/></svg>담기</button>';
      else act = '<div class="step"><button data-a="dec" data-v="' + esc(i.id) + '" aria-label="' + esc(i.name) + ' 하나 빼기">&minus;</button><output>' + q + '</output><button data-a="inc" data-v="' + esc(i.id) + '" aria-label="' + esc(i.name) + ' 하나 더">+</button></div>';
      var ph = i.photo && !badPhoto[i.photo] ? '<button class="ph" data-a="photo" data-v="' + esc(i.id) + '" aria-label="' + esc(i.name) + ' 사진 크게 보기"><img class="mph" src="' + esc(BASE + i.photo) + '" alt="' + esc(i.name) + '" loading="lazy" decoding="async" width="72" height="54"></button>' : '';
      return '<li class="it' + (i.soldOut ? ' so' : '') + (ph ? ' hasph' : '') + '">' + ph + '<div class="inf"><b>' + esc(i.name) + '</b>' + (i.desc ? '<p>' + esc(i.desc) + '</p>' : '') + '<span class="pr">' + won(i.price) + '</span>' + (i.stockLeft != null && i.stockLeft > 0 && !i.soldOut ? ' <span class="left">' + i.stockLeft + '개 남음</span>' : '') + '</div>' + act + '</li>';
    }).join('') + '</ul>';
  }

  function breakdown(o) {
    var mem = o.memberDiscount || 0, cp = o.couponDiscount != null ? o.couponDiscount : (o.discount || 0) - mem;
    if (!mem && !cp) return '';
    return '<div class="sum"><span>주문 금액</span><span>' + won(o.subtotal) + '</span></div>' + (mem ? '<div class="sum"><span>COMS 회원 할인</span><span>-' + won(mem) + '</span></div>' : '') + (cp > 0 ? '<div class="sum"><span>쿠폰 할인</span><span>-' + won(cp) + '</span></div>' : '');
  }
  /* ---------- headcount, cover charge, share payments ---------- */
  function coverOrder() { return S.orders.filter(function (o) { return o.kind === 'cover'; })[0] || null; }
  function foodOrders() { return S.orders.filter(function (o) { return o.kind !== 'cover'; }); }
  function pdKey() { return 'jb:pd:' + TOKEN + ':' + (S ? S.table.seat : 0); }
  function stepHtml(act, n, unit) {
    return '<div class="bigstep"><button class="y2k-btn" data-a="' + act + '-dec" aria-label="하나 줄이기">&minus;</button><output aria-live="polite"><span class="y2k-pixel--3x n">' + n + '</span><span class="u">' + unit + '</span></output><button class="y2k-btn" data-a="' + act + '-inc" aria-label="하나 늘리기">+</button></div>';
  }
  function maybeAskParty() {
    if (!S || !S.party || !S.party.canSet || sheetKind || gamePlaying || game) return;
    if (lsGet(pdKey()) === '1' || partyAsked === S.table.seat) return;
    partyAsked = S.table.seat; openParty();
  }
  function openParty() {
    var cv = S.cover && S.cover.enabled;
    openSheet('인원', '<div id="partybody"></div>', function () { if (!S.party || S.party.canSet) lsSet(pdKey(), '1'); pendingAfterParty = false; });
    renderParty(cv);
  }
  function renderParty(cv) {
    var b = $('#partybody'); if (!b) return; if (cv === undefined) cv = S.cover && S.cover.enabled;
    b.innerHTML = '<h2>몇 명이세요?</h2><p class="note" style="margin:-4px 0 10px">' + (cv ? '입장료와 자리 안내에 써요.' : '자리 안내에 써요.') + (pendingAfterParty ? ' 인원을 알려 주시면 주문이 이어져요.' : '') + '</p>' + stepHtml('pt', partyN, '명') + '<p class="err" id="pterr" role="alert"></p><div class="two">' + (pendingAfterParty ? '' : '<button class="y2k-btn big" data-a="pt-later">나중에</button>') + '<button class="y2k-btn big" data-a="pt-ok">확인</button></div><p class="note" style="margin-top:8px">인원이 바뀌면 직원에게 말씀해 주세요.</p>';
  }
  function setParty() {
    api('/party', { people: partyN, seat: S.party && S.party.seat != null ? S.party.seat : S.table.seat }).then(function (r) {
      if (!r.ok) {
        var e = r.data.error, m = r.data.message || '인원을 저장하지 못했어요';
        if (e === 'seat_changed' || e === 'bad_seat') {   // the page belongs to a previous seating: reload and ask again for the new one
          closeSheet(true); partyAsked = 0; quietClear = true; toast(e === 'seat_changed' ? '새 손님으로 자리가 바뀌었어요' : '자리 정보를 새로 불러왔어요', 4000);
          api('').then(function (x) { if (x.ok) { applyState(x.data); quietClear = false; if (S.party && S.party.canSet) { partyAsked = S.table.seat; openParty(); } } else quietClear = false; }); return;
        }
        if (e === 'party_set' || e === 'party_not_asked') { api('').then(function (x) { if (x.ok) applyState(x.data); }); m = e === 'party_set' ? '이미 인원이 정해졌어요. 바뀌면 직원에게 말씀해 주세요.' : m; closeSheet(true); toast(m); pendingAfterParty = false; return; }
        var er = $('#pterr'); if (er) er.textContent = m; return;
      }
      S.party = r.data.party || S.party; lsSet(pdKey(), null); var again = pendingAfterParty; pendingAfterParty = false; closeSheet(true);
      toast(partyN + '명으로 알려 드렸어요');
      api('').then(function (x) { if (x.ok) applyState(x.data); if (again) { openCart(); submit(); } });
    }, function () { var er = $('#pterr'); if (er) er.textContent = '네트워크 오류예요. 다시 눌러 주세요.'; });
  }
  function coverCard() {
    var c = S.cover, co = coverOrder();
    if (c && c.waived) return '<p class="note cvw">' + esc(c.label || '입장료') + ' 면제</p>';   // the waived cover order is cancelled, so this must come before the order check
    if (!(c && co && co.status !== 'cancelled')) return '';   // driven by the cover order, not the setting: a cover still owed stays visible after staff turn the setting off
    var label = esc(c.label || '입장료');
    var refund = co.refundDue > 0 ? '<div class="meta"><span class="tag bad">환불 예정</span> ' + won(co.refundDue) + ' · 직원에게 문의해 주세요</div>' : '';
    var h = '<section class="y2k-window cv" aria-label="' + label + '"><div class="y2k-title"><svg class="y2k-i y2k-i--2x" aria-hidden="true"><use href="' + ICO + '#i-ticket"/></svg><span class="y2k-title-t">' + label + '.dat</span></div><div class="y2k-body">';
    if (c.mode === 'per_table' || !c.shares) {
      h += '<div class="cv-eq">' + label + ' ' + won(c.total) + ' (테이블 1건)</div><div class="sum"><span>받은 금액</span><span>' + won(c.paid) + '</span></div><div class="sum"><b>남은 금액</b><b>' + won(c.left) + '</b></div>' + refund +
        (c.left > 0 ? '<button class="y2k-btn big" style="margin-top:10px" data-a="pay" data-v="' + co.id + '">송금 안내</button>' : '<p class="note ok-line" style="margin-top:8px">' + label + ' 납부 완료</p>');
      return h + '</div></section>';
    }
    var sh = c.shares, segs = '';
    for (var k = 0; k < sh.total; k++) segs += '<i' + (k < sh.paid ? ' class="on"' : '') + '></i>';
    h += '<div class="cv-eq">' + label + ' ' + sh.total + '명 × ' + won(c.unitPrice) + ' = ' + won(c.total) + '</div>' +
      '<div class="y2k-progress" role="img" aria-label="' + sh.paid + '명 납부, ' + sh.left + '명 남음">' + segs + '</div>' +
      '<div class="cv-st"><b>' + sh.paid + '명 납부 · ' + sh.left + '명 남음</b></div>' + (sh.over > 0 ? '<div class="meta cv-over"><span class="tag bad">초과</span> ' + sh.over + '명분 초과 납부 · 환불 예정</div>' : '') +
      '<div class="sum"><b>남은 금액</b><b>' + won(c.left) + '</b></div>';
    if (c.payments && c.payments.length) h += '<div class="cv-sec">낸 사람</div><ul class="cv-list">' + c.payments.map(function (p) { return '<li><span>' + esc(p.payer || '이름 없음') + '</span><span>' + (p.shares ? p.shares + '명분' : '금액 입금') + ' · ' + hhmm(p.at) + '</span></li>'; }).join('') + '</ul>';
    var my = c.myIntents || [];
    if (my.length) h += '<div class="cv-sec">보내는 중</div><ul class="cv-list">' + my.map(function (it) { return '<li class="int"><span>' + esc(it.payer) + ' · ' + it.shares + '명분 · ' + won(it.amount) + '<small>' + hhmm(it.expiresAt) + '까지</small></span><span class="ib"><button class="y2k-btn sm" data-a="sh-view" data-v="' + it.id + '">송금 안내</button><button class="y2k-btn sm" data-a="sh-cancel" data-v="' + it.id + '">취소</button></span></li>'; }).join('') + '</ul>';
    h += refund + (sh.left > 0 ? '<button class="y2k-btn big" style="margin-top:10px" data-a="sh-open">' + label + ' 내기 (각자 내기)</button>' : c.left > 0 ? '<p class="note" style="margin-top:8px">남은 ' + label + ' ' + won(c.left) + '은 직원에게 말씀해 주세요.</p>' : '<p class="note ok-line" style="margin-top:8px">' + label + ' 납부 완료</p>');
    return h + '</div></section>';
  }
  function availLeft() { var l = S.cover.shares.left; return shareAvail != null ? Math.max(0, Math.min(shareAvail, l)) : l; }
  function shareN() { var l = availLeft(); if (l < 1) return 1; return shareSel.mode === 'one' ? 1 : shareSel.mode === 'all' ? l : Math.max(1, Math.min(l, shareSel.n)); }
  function openShare() {
    if (!S.cover || !S.cover.shares || S.cover.shares.left <= 0) return;
    shareSel = { mode: 'one', n: 1 }; shareAvail = null; sharePayer = lsGet('jb:dep') || '';
    openSheet('입장료 내기', '<div id="sharebody"></div>', function () { shareView = null; });
    renderShare('');
  }
  function renderShare(err) {
    var b = $('#sharebody'); if (!b) return; var c = S.cover, left = availLeft(), n = shareN(), u = c.unitPrice;
    if (shareSel.mode === 'n') shareSel.n = n;
    b.innerHTML = '<h2>' + esc(c.label || '입장료') + ' 내기</h2><p class="note" style="margin:-4px 0 8px">1명분 ' + won(u) + ' · ' + (shareAvail != null ? '지금 낼 수 있는 몫 ' : '남은 몫 ') + left + '명분</p>' +
      '<div class="opts" role="group" aria-label="낼 몫">' +
      '<button class="y2k-btn opt" data-a="sh-one" aria-pressed="' + (shareSel.mode === 'one') + '">내 몫만 (1명분 ' + won(u) + ')</button>' +
      '<button class="y2k-btn opt" data-a="sh-n" aria-pressed="' + (shareSel.mode === 'n') + '">몇 명분 낼래요</button>' + (shareSel.mode === 'n' ? stepHtml('sh', n, '명분') : '') +
      '<button class="y2k-btn opt" data-a="sh-all" aria-pressed="' + (shareSel.mode === 'all') + '">남은 전부 (' + left + '명분 ' + won(left * u) + ')</button></div>' +
      '<label class="fld">보내는 분 이름 (필수)<input id="shp" maxlength="10" autocomplete="name" enterkeyhint="done" placeholder="예: 홍길동"></label><p class="note" style="margin:4px 0 0">입금자명과 같아야 직원이 알아봐요</p>' +
      '<div class="sum tot"><span>보낼 금액 (' + n + '명분)</span><span>' + won(n * u) + '</span></div><p class="err" id="sherr" role="alert">' + esc(err || '') + '</p>' +
      '<button class="y2k-btn big" data-a="sh-go"' + (left < 1 ? ' disabled' : '') + '>이 금액으로 보내기</button>';
    var inp = $('#shp', b); if (inp) inp.value = sharePayer;
  }
  function shareGo() {
    var inp = $('#shp'), payer = (inp ? inp.value : sharePayer).trim(); sharePayer = payer;
    if (!payer) { renderShare('보내는 분 이름을 입력해 주세요'); var i2 = $('#shp'); if (i2) i2.focus(); return; }
    var n = shareN(), base = S.cover.shares.paid; lsSet('jb:dep', payer);
    api('/cover/intents', { payer: payer, shares: n }).then(function (r) {
      if (r.ok) { shareView = { id: r.data.id, amount: r.data.amount, shares: r.data.shares, payer: r.data.payer || payer, expiresAt: r.data.expiresAt, base: base }; api('').then(function (x) { if (x.ok) applyState(x.data); }); showShareTransfer(); return; }
      var d = r.data, e = d.error;
      if (e === 'too_many_shares') { api('').then(function (x) { if (x.ok) { applyState(x.data); if (S.cover.shares && S.cover.shares.left > 0) { shareSel = { mode: 'one', n: 1 }; shareAvail = d.left != null ? d.left : null; renderShare(d.left === 0 ? '남은 몫을 다른 분이 이미 내는 중이에요. 그분이 보내면 입장료가 끝나요. 시간이 지나도 안 끝나면 다시 눌러 주세요.' : '다른 분이 일부 몫을 이미 내는 중이에요. 지금 낼 수 있는 몫은 ' + (d.left != null ? d.left : S.cover.shares.left) + '명분이에요. 아래에서 다시 골라 주세요.'); } else { closeSheet(true); toast('남은 입장료가 없어요'); } } }); return; }
      renderShare(e === 'too_many_intents' ? '잠시 후 다시 시도해 주세요. (너무 자주 눌렀거나 진행 중인 요청이 많아요)' : e === 'no_device' ? '쿠키를 허용해 주세요. 그래야 요청을 보낼 수 있어요.' : (d.message || '요청하지 못했어요'));
    }, function () { renderShare('네트워크 오류예요. 다시 눌러 주세요.'); });
  }
  function showShareTransfer() {
    var v = shareView; if (!v) return;
    if ($('#sharebody')) { sheetKind = '입장료 송금'; } else openSheet('입장료 송금', '<div id="sharebody"></div>', function () { shareView = null; });
    sheetKind = '입장료 송금'; renderShareTransfer();
  }
  function renderShareTransfer() {
    var b = $('#sharebody'), v = shareView, p = S.pay || {}; if (!b || !v) return;
    var my = (S.cover.myIntents || []).some(function (x) { return x.id === v.id; });
    if (!my) {
      var ok = S.cover.shares && S.cover.shares.paid >= v.base + v.shares;
      b.innerHTML = ok ? '<h2>입금이 확인됐어요</h2><div class="amt">' + won(v.amount) + '</div><p class="note" style="text-align:center">입장료 ' + v.shares + '명분 입금이 확인됐어요.</p><button class="y2k-btn big" style="margin-top:14px" data-a="sclose">확인</button>'
        : '<h2>요청이 끝났어요</h2><p class="note">' + (cancelledIntents[v.id] ? '요청을 취소했어요.' : Date.now() >= v.expiresAt ? '시간이 지나 요청이 닫혔어요. 다시 요청해 주세요.' : '다른 분이 먼저 내서 요청이 닫혔어요. 이미 보냈다면 직원에게 말씀해 주세요.') + '</p><button class="y2k-btn big" style="margin-top:14px" data-a="sclose">확인</button>';
      return;
    }
    var h = '<h2>' + esc(S.cover.label || '입장료') + ' ' + v.shares + '명분 보내기</h2><p class="note" style="margin:-4px 0 6px">' + hhmm(v.expiresAt) + '까지 보내 주세요 (30분)</p><div class="amt">' + won(v.amount) + '</div>';
    if (p.account) {
      h += '<div class="acct"><div class="bank">' + esc(p.bank) + ' · 예금주 ' + esc(p.holder) + '</div><div class="no">' + esc(p.account) + '</div></div>';
      if (p.tossEnabled && MOBILE) h += '<a class="y2k-btn y2k-btn--primary big pl" data-a="toss" href="' + esc(tossHref(p, v.amount)) + '">토스로 보내기</a>';
      if (p.kakaoPayUrl && kakaoOk(p.kakaoPayUrl)) h += '<a class="y2k-btn big pl kk" data-a="kakao" href="' + esc(p.kakaoPayUrl) + '" target="_blank" rel="noopener noreferrer">카카오페이로 보내기</a><p class="note" style="margin:4px 0 0">금액 ' + won(v.amount) + '을 직접 입력해 주세요</p>';
      h += '<div class="two"><button class="y2k-btn" data-a="copy" data-amt="' + v.amount + '" data-k="acct">계좌번호 복사</button><button class="y2k-btn" data-a="copy" data-amt="' + v.amount + '" data-k="amt">금액 복사</button></div><p class="note nextstep" id="paynext" hidden></p>';
    } else h += '<div class="acct">계좌 정보는 직원에게 문의해 주세요.</div>';
    var fd = foodOrders().filter(function (o) { return o.status !== 'cancelled' && !o.paid; }).reduce(function (t, o) { return t + dueOf(o); }, 0);
    h += (fd > 0 ? '<div class="split"><b>음식 ' + won(fd) + '은 따로 보내 주세요 (이 금액에 들어 있지 않아요)</b></div>' : '') + '<div class="memrow"><span>입금자명은 <b style="color:#000">' + esc(v.payer) + '</b>(으)로 보내 주세요</span></div><p class="note">직원이 입금을 확인하면 이 화면이 바뀌어요.</p><div class="two" style="margin-top:12px"><button class="y2k-btn" data-a="sclose">닫기</button><button class="y2k-btn y2k-btn--danger danger" data-a="sh-cancel" data-v="' + v.id + '">요청 취소</button></div>';
    b.innerHTML = h;
  }
  var cancelledIntents = {};
  function cancelIntent(id) {
    cancelledIntents[id] = 1;
    api('/cover/intents/' + encodeURIComponent(id) + '/cancel', {}).then(function (r) {
      toast(r.ok ? '요청을 취소했어요' : (r.data.message || '취소할 수 없어요'));
      api('').then(function (x) { if (x.ok) applyState(x.data); });
    }, function () { toast('네트워크 오류예요. 다시 눌러 주세요.'); });
  }

  function splitHelper(cvDue, foodDue) {
    if (!(cvDue > 0 && foodDue > 0)) return '';
    return '<div class="split"><b>입장료 ' + won(cvDue) + '과 음식 ' + won(foodDue) + '은 따로 보내 주세요</b><div class="two"><button class="y2k-btn" data-a="cv-pay">입장료 ' + won(cvDue) + ' 보내기</button><button class="y2k-btn" data-a="food-pay">음식 ' + won(foodDue) + ' 보내기</button></div></div>';
  }
  function openCoverPay() {
    var co = coverOrder(); if (!co) return;
    if (S.cover && S.cover.mode === 'per_person' && S.cover.shares) openShare(); else openPay(co, false);
  }
  function openFoodPay() {
    var un = foodOrders().filter(function (o) { return o.status !== 'cancelled' && !o.paid && dueOf(o) > 0; });
    if (!un.length) return;
    if (un.length === 1) { openPay(un[0], false); return; }
    openSheet('음식 송금', '<h2>음식 주문 송금</h2><p class="note" style="margin:-4px 0 8px">주문마다 따로 보내요. 보낼 주문을 골라 주세요.</p><ul class="cv-list">' + un.map(function (o) { return '<li class="int"><span>#' + o.id + ' · ' + won(dueOf(o)) + '</span><span class="ib"><button class="y2k-btn sm" data-a="pay" data-v="' + o.id + '">송금 안내</button></span></li>'; }).join('') + '</ul><button class="y2k-btn big" style="margin-top:10px" data-a="sclose">닫기</button>');
  }
  function htmlOrders() {
    var food = foodOrders(), cvOn = S.cover && coverOrder() && coverOrder().status !== 'cancelled' && !S.cover.waived && !coverOrder().waived, cv = cvOn ? S.cover : null;
    var live = food.filter(function (o) { return o.status !== 'cancelled'; });
    var total = 0, unpaid = 0;
    live.forEach(function (o) { total += o.total; if (!o.paid) unpaid += dueOf(o); });
    var h = coverCard();
    if (notifSupported()) {
      h += BoothNotify.permission() === 'denied' ? '<div class="nrow"><span>알림 받기<small>브라우저에서 알림이 차단돼 있어요</small></span></div>'
        : '<div class="nrow"><span>알림 받기<small>화면이 꺼져 있어도 알려 드려요</small></span><button class="sw" role="switch" aria-checked="' + notifOn() + '" aria-label="알림 받기" data-a="notif"><i></i></button></div>';
    }
    h += '<div class="toolbar" role="group" aria-label="직원 호출"><b>호출</b>' + S.callTypes.map(function (t) {
      var open = S.calls.some(function (c) { return c.type === t; }), cd = (callCd[t] || 0) > Date.now();
      return '<button class="y2k-btn" data-a="call" data-v="' + esc(t) + '"' + (open || cd ? ' disabled' : '') + '>' + esc(t) + (open ? ' (요청됨)' : '') + '</button>';
    }).join('') + '</div>';
    h += '<section class="y2k-term gterm" aria-label="주문 게시판"><div class="hi">COMHERE 주문 게시판 &lt;' + (S.table.isTest ? '테스트' : S.table.number + '번 테이블') + '&gt;</div>' + (cv ? '<div class="tsum"><span>입장료</span><span class="sm">' + won(cv.total) + '</span></div><div class="meta">입장료 남은 금액 ' + won(cv.left) + '</div>' : '') + '<div class="tsum"><span>' + (cv ? '음식' : '합계') + '</span><span class="big">' + won(total) + '</span></div><div class="meta">미입금 ' + won(unpaid) + '</div>' + (cv ? '<hr><div class="tsum"><span>전체 남은 금액</span><span class="big">' + won(cv.left + unpaid) + '</span></div>' : '') + (coverOrder() && coverOrder().refundDue > 0 ? '<div class="meta"><span class="tag bad">환불 예정</span> 입장료 ' + won(coverOrder().refundDue) + ' · 직원에게 문의해 주세요</div>' : '') + splitHelper(cv ? cv.left : 0, unpaid) + '<hr>';
    if (!food.length) return h + '<p>주문 내역이 없습니다.</p><p class="y2k-cursor">(C)ontinue</p><button class="y2k-btn big" style="margin-top:10px" data-a="tab" data-v="menu">메뉴 보러 가기</button></section>';
    h += '<div class="th"><span>번호</span><span>메뉴</span><span>상태</span></div><hr>';
    return h + food.map(function (o) {
      var cx = o.status === 'cancelled', idx = STEPS.indexOf(o.status);
      var first = o.items[0] ? o.items[0].name + (o.items.length > 1 ? ' 외 ' + (o.items.length - 1) : '') : '';
      var stTxt = cx ? '취소됨' : STEP_L[idx];
      var prog = cx ? '' : '<div class="y2k-progress" role="img" aria-label="진행 상태: ' + stTxt + ' (' + (idx + 1) + '/3)">' + [0, 1, 2].map(function (k) { return '<i' + (k <= idx ? ' class="on"' : '') + '></i>'; }).join('') + '</div><div class="plabels" aria-hidden="true">' + STEP_L.map(function (l, k) { return '<span' + (k === idx ? ' class="cur"' : '') + '>' + (k === idx ? '&#9650; ' : '') + l + '</span>'; }).join('') + '</div>';
      var pay = cx ? '' : o.paid ? '<span class="tag ok">입금확인</span>' : o.total === 0 ? '<span class="tag ok">결제불필요</span>' : (o.paidAmount > 0 && dueOf(o) > 0) ? '<span class="tag warn">일부 입금</span>' : '<span class="tag warn">미입금</span>';
      var acts = '';
      if (!cx && !o.paid && dueOf(o) > 0) acts += '<button class="y2k-btn sm" data-a="pay" data-v="' + o.id + '">송금 안내</button>';
      if (o.status === 'pending' && !o.paid) acts += '<button class="y2k-btn y2k-btn--danger danger sm" data-a="cancel" data-v="' + o.id + '">' + (cancelArm[o.id] ? '정말 취소할게요' : '주문 취소') + '</button>';
      return '<article class="trow' + (cx ? ' cx' : '') + '"><div class="tr1"><span class="hi">#' + o.id + '</span><span class="mn">' + esc(first) + '</span><span class="st">' + stTxt + '</span></div>' + prog +
        '<div class="meta">' + hhmm(o.createdAt) + ' ' + pay + '</div>' +
        '<ul class="lines">' + o.items.map(function (i) { return '<li><span>' + esc(i.name) + ' x ' + i.qty + '</span><span>' + (i.service ? '<span class="tag ok">서비스</span>' : won(i.unitPrice * i.qty)) + '</span></li>'; }).join('') + '</ul>' +
        breakdown(o) +
        '<div class="tt"><span>' + (breakdown(o) ? '결제 금액' : '합계') + '</span><span class="' + (cx ? 'del' : '') + '">' + won(o.total) + '</span></div>' +
        (!cx && !o.paid && o.paidAmount > 0 ? '<div class="sum"><span>받은 금액</span><span>' + won(o.paidAmount) + '</span></div><div class="sum"><b>남은 금액</b><b>' + won(dueOf(o)) + '</b></div>' : '') +
        (o.refundDue > 0 ? '<div class="meta"><span class="tag bad">환불 예정</span> ' + won(o.refundDue) + ' · 직원에게 문의해 주세요</div>' : '') +
        (o.note ? '<div class="meta">요청: ' + esc(o.note) + '</div>' : '') + (!cx && !o.paid ? '<div class="meta">입금자명: ' + (o.depositor ? esc(o.depositor) : '없음') + ' · <button class="y2k-btn sm dep" data-a="dep" data-v="' + o.id + '">' + (o.depositor ? '수정' : '입력') + '</button></div>' : '') + (acts ? '<div class="acts">' + acts + '</div>' : '') + '</article>';
    }).join('') + '<p class="y2k-cursor" style="margin-top:6px">&gt;</p></section>';
  }

  function htmlGame() {
    var h = '<div class="nickrow"><span class="nlab" id="nlab">닉네임</span><div class="y2k-field nickval" role="textbox" aria-readonly="true" aria-labelledby="nlab">' + (S.nick ? esc(S.nick) : '<span class="ph0">아직 없어요</span>') + '</div><button class="y2k-btn sm" data-a="nick">' + (S.nick ? '변경' : '정하기') + '</button></div>';
    h += '<div class="ggrid">';
    gameIds().forEach(function (g) {
      var info = S.games[g]; if (!info) return;
      var best = lsGet('jb:best:' + g);
      h += '<article class="y2k-window gc"><div class="y2k-title"><svg class="y2k-i y2k-i--2x" aria-hidden="true"><use href="' + ICO + '#' + (GICO[g] || 'i-floppy') + '"/></svg><h3 class="y2k-title-t" style="font-size:16px">' + esc(info.label) + '.exe</h3></div><div class="y2k-body"><p>' + (GDESC[g] || '') + ' (최대 ' + info.maxScore + '점' + (best ? ', 내 최고 ' + best + '점' : '') + ')</p>';
      var rws = S.rewards.filter(function (r) { return r.game === g; }).sort(function (a, b) { return a.threshold - b.threshold; });
      if (!rws.length) h += '<div class="rw"><span>재미로 한 판!</span><small>지금은 보상이 없어요</small></div>';
      rws.forEach(function (r) {
        var K = r.seatLimit != null, why = '';
        var st = K ? (r.canEarn ? '<span class="badge warn">받을 수 있어요</span>' : r.blockedBy === 'stock_out' ? '<span class="badge bad">소진</span>' : '<span class="badge ok">' + (r.blockedBy === 'seat_limit' ? '이미 받았어요' : '더 못 받아요') + '</span>')
          : r.got ? '<span class="badge ok">이미 받았어요</span>' : r.soldOut ? '<span class="badge bad">소진</span>' : '<span class="badge warn">받을 수 있어요</span>';
        if (K) {
          why = '이 테이블 ' + r.seatIssued + '/' + r.seatLimit + '장 받음';
          if (r.blockedBy === 'device_limit') why += ' · 이 폰으로는 이미 받았어요';
          else if (r.blockedBy === 'table_total_limit') why += ' · 이 테이블이 받을 수 있는 쿠폰을 다 받았어요';
          else if (r.blockedBy === 'stock_out') why += ' · 소진';
          // only when the server says a headcount would change the limit (never for device / table-total / stock blocks or cap 1)
          // server-decided hints only: a guest can raise the limit by typing a headcount only with a per-person cover charge; otherwise staff must confirm
          if (r.moreWithHeadcount === true) why += '<br>입장료를 낸 인원만큼 한도가 늘어요' + (r.seatCap > 0 ? ' (최대 ' + r.seatCap + '장)' : '');
          else if (r.moreWithStaffConfirm === true) why += '<br>직원이 인원을 확인하면 한도가 늘어요' + (r.seatCap > 0 ? ' (최대 ' + r.seatCap + '장)' : '');
        }
        h += '<div class="rw"><span><b>' + esc(r.label) + '</b> <small>' + r.threshold + '점 이상</small>' + (why ? '<br><small>' + why + '</small>' : '') + '</span>' + st + '</div>';
      });
      h += '<button class="y2k-btn big" style="margin-top:6px" data-a="play" data-v="' + g + '"' + (gameBusy ? ' disabled' : '') + '>&#9654; 실행</button></div></article>';
    });
    return h + '</div>';
  }

  function couponCard(c) {
    var used = c.status === 'used';
    return '<article class="y2k-window cp' + (used ? ' used' : '') + '"><div class="y2k-title"><svg class="y2k-i" aria-hidden="true"><use href="' + ICO + '#i-ticket"/></svg><span class="y2k-title-t">COUPON.dat</span></div><div class="y2k-body"><div class="lb">' + esc(c.label) + '</div><div class="code" aria-label="쿠폰 코드 ' + esc(c.code.split('').join(' ')) + '">' + esc(c.code) + '</div><div class="hint">' + (used ? '<span class="stamp">사용 완료</span>' : c.type === 'item' ? '직원에게 이 화면을 보여 주세요' : '주문할 때 장바구니에서 선택하세요') + '</div></div></article>';
  }
  function htmlCoupons() {
    if (!S.coupons.length) return '<div class="y2k-term"><p>쿠폰이 없습니다.</p><p>게임에서 점수를 넘기면 쿠폰이 나와요!</p><p class="y2k-cursor">(C)ontinue</p></div><button class="y2k-btn big" style="margin-top:10px" data-a="tab" data-v="game">게임하러 가기</button>';
    var cs = S.coupons.slice().sort(function (a, b) { return (a.status === 'used') - (b.status === 'used') || b.createdAt - a.createdAt; });
    return cs.map(couponCard).join('');
  }

  /* ---------- cart / order ---------- */
  function openCart() {
    var sh = openSheet('장바구니',
      '<h2>장바구니</h2><ul class="cl" id="cl"></ul>' +
      '<label class="fld">쿠폰<select id="cc"></select></label><p class="note" id="clim" hidden></p><div class="cmp" id="ccmp" hidden></div>' +
      '<label class="fld"><span id="cdpl">입금자명</span><input id="cdp" maxlength="10" autocomplete="name" enterkeyhint="done" placeholder="예: 홍길동"></label><p class="note" style="margin:4px 0 0">보내는 분 이름과 같아야 입금이 자동 확인돼요</p>' +
      '<label class="fld">요청사항 (선택)<input id="cn" maxlength="100" placeholder="예: 덜 맵게" autocomplete="off"></label>' +
      '<p class="note" id="cmin" hidden></p><div class="memrow" id="cnm" hidden><span id="cnmt"></span><span class="mr-btns"><button class="y2k-btn sm" data-a="mlogin">COMS 로그인</button><button class="y2k-btn sm" data-a="mrecheck">다시 확인</button></span></div>' +
      '<div class="sum"><span>상품 금액</span><span id="cs"></span></div><div class="sum" id="cmr"><span>COMS 회원 할인</span><span id="cm"></span></div><div class="sum" id="cdr"><span>쿠폰 할인</span><span id="cd"></span></div>' +
      '<div class="sum tot"><span>결제 금액</span><span id="ct"></span></div>' +
      '<button class="y2k-btn y2k-btn--primary big" id="csub" data-a="submit"></button><p class="err" id="cerr" role="alert"></p>');
    var cd = $('#cdp', sh); cd.value = lsGet('jb:dep') || '';
    cd.addEventListener('input', function () { lsSet('jb:dep', cd.value.trim()); dropPend(); });
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
    var cs = S.couponSeat || {}, capped = cs.maxDiscountUsesPerSeat > 0 && cs.discountUses >= cs.maxDiscountUsesPerSeat;
    if (capped && cart.coupon) { cart.coupon = ''; saveCart(); sel.value = ''; }
    sel.disabled = capped;
    var lim = $('#clim'); if (lim) { lim.hidden = !capped; lim.textContent = capped ? '이 테이블은 할인 쿠폰을 ' + cs.maxDiscountUsesPerSeat + '장까지 쓸 수 있어요 (이미 ' + cs.discountUses + '장 사용)' : ''; }
    $('#cm').textContent = t.mem ? '-' + won(t.mem) : '쿠폰과 함께 쓸 수 없어요'; $('#cmr').hidden = !(t.mem || t.sup);
    var rv = M && M.enabled && ruleVal() > 0;
    var nm = $('#cnm'); nm.hidden = !(rv && !M.member); if (rv) $('#cnmt').textContent = 'COMS 회원이면 ' + ruleText();
    var mn = $('#cmin'); mn.hidden = !(rv && M.minOrder > 0 && t.sub < M.minOrder); mn.textContent = rv ? won(M.minOrder) + ' 이상 주문 시 COMS 회원 할인' : '';
    var cmp = $('#ccmp'), best = null, cc = selCoupon();
    S.coupons.forEach(function (c) { if (c.status === 'issued' && c.type === 'discount' && (!best || c.amount > best.amount)) best = c; });
    cc = cc || best;
    if (rv && M.member && !M.stackWithCoupon && t.raw > 0 && cc) {
      var tc = Math.max(0, t.sub - Math.min(t.sub, cc.amount || 0)), tm = t.sub - t.raw;
      cmp.hidden = false;
      cmp.innerHTML = '<div class="sum' + (tc <= tm ? ' bt' : '') + '"><span>쿠폰 쓰면 (회원 할인 없음)</span><b>' + won(tc) + '</b></div><div class="sum' + (tm < tc ? ' bt' : '') + '"><span>회원 할인만 쓰면</span><b>' + won(tm) + '</b></div><p class="note">쿠폰과 회원 할인은 함께 쓸 수 없어요. 더 저렴한 쪽을 골라 주세요.</p>';
    } else cmp.hidden = true;
    $('#cs').textContent = won(t.sub); $('#cd').textContent = '-' + won(t.disc); $('#cdr').hidden = !t.disc; $('#ct').textContent = won(t.total);
    var req = !!(S.pay && S.pay.requireDepositor); $('#cdpl').textContent = req ? '입금자명 (필수)' : '입금자명 (선택)';
    var b = $('#csub');
    b.disabled = sending || !t.n || !S.orderingOpen;
    b.textContent = !S.orderingOpen ? '지금은 주문을 받지 않아요' : sending ? '보내는 중…' : netFailed ? '다시 시도' : '주문하기 ' + won(t.total);
  }
  function pendKey() { return 'jb:pend:' + TOKEN + ':' + (S ? S.table.seat : 0); }
  function savePend() { lsSet(pendKey(), pend ? JSON.stringify(pend) : null); }
  function loadPend() { try { var p = JSON.parse(lsGet(pendKey()) || 'null'); if (p && p.key && p.body) pend = p; } catch (e) {} }
  function dropPend() { pend = null; netFailed = false; savePend(); }
  function cerr(m) { var e = $('#cerr'); if (e) e.textContent = m; }
  var expectOverride = null;
  function submit() {
    if (sending || !S.orderingOpen) { expectOverride = null; return; }
    if (!pend) {   // freeze body + key at first attempt; every retry (even after reload) resends exactly this
      var L = lines().filter(function (l) { return !l.soldOut; });
      if (!L.length) { expectOverride = null; return; }
      var body = { items: L.map(function (l) { return { id: l.id, qty: l.qty }; }) };
      if (cart.coupon) body.couponCode = cart.coupon;
      if (cart.note.trim()) body.note = cart.note.trim();
      var dep = ($('#cdp') ? $('#cdp').value : lsGet('jb:dep') || '').trim();
      if (S.pay && S.pay.requireDepositor && !dep) { expectOverride = null; cerr('입금자명을 입력해 주세요 (송금하시는 분 이름)'); var di = $('#cdp'); if (di) di.focus(); return; }
      if (dep) body.depositor = dep;
      body.expectedTotal = (expectOverride != null ? expectOverride : totals().total); expectOverride = null;
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
        if (r.data.couponIgnored) toast('쿠폰은 사용되지 않았어요 (할인 금액 0원)');
        else if (r.data.memberDiscountSkipped === 'limit') toast('회원 할인 한도를 넘어 이번 주문은 할인 없이 접수됐어요');
        else if (r.data.memberDiscountSkipped === 'coupon') toast('쿠폰과 함께 쓸 수 없어 회원 할인은 적용되지 않았어요');
        return;
      }
      var d = r.data, e = d.error, msg = d.message || '주문하지 못했어요';
      if (r.status >= 500) { netFailed = true; render(); cerr(msg + ' 다시 시도를 눌러 주세요 (중복 주문은 되지 않아요).'); if (sheetKind !== '장바구니') toast(msg); return; }
      if (e !== 'party_required') dropPend();   // definitive 4xx answer: the next attempt is a new request (party_required keeps the same frozen body + key)
      if (e === 'price_changed') { priceChanged(d); return; }
      if (e === 'party_required') { pendingAfterParty = true; closeSheet(true); msg = '먼저 인원을 알려 주세요'; openParty(); return; }
      if (e === 'insufficient_stock') {
        var its = d.items && d.items.length ? d.items : [{ id: d.id, name: '', left: d.left }];
        its.forEach(function (i) { if (i.left > 0) cart.items[i.id] = Math.min(cart.items[i.id] || i.left, i.left); else delete cart.items[i.id]; }); saveCart();
        var mm = menuMap();
        msg = its.map(function (i) { var n = i.name || (mm[i.id] && mm[i.id].name) || '메뉴'; return i.left > 0 ? n + ' ' + i.left + '개까지 주문할 수 있어요' : its.length > 1 ? n + ' 재고 부족' : n + ' 품절'; }).join(', ') + '. 장바구니를 맞췄어요. 확인 후 다시 주문해 주세요.';
        api('').then(function (s) { if (s.ok) applyState(s.data); }, function () {});
      } else if (e === 'sold_out') {
        (d.ids || []).forEach(function (id) { delete cart.items[id]; }); saveCart();
        msg = (d.names && d.names.length ? d.names.join(', ') : '일부 메뉴') + ' 품절! 장바구니에서 뺐어요. 확인 후 다시 주문해 주세요.';
        api('').then(function (s) { if (s.ok) applyState(s.data); }, function () {});
      } else if (e === 'closed') { S.orderingOpen = false; }
      else if (e === 'too_many_orders') msg = '이 테이블의 주문 횟수 한도에 도달했어요. 스태프에게 말씀해 주세요.';
      else if (e === 'coupon_limit') { cart.coupon = ''; saveCart(); msg = '이 테이블은 할인 쿠폰을 ' + (d.max != null ? d.max + '장까지 ' : '') + '쓸 수 있어요' + (d.used != null ? ' (이미 ' + d.used + '장 사용)' : '') + '. 쿠폰 없이 다시 주문해 주세요.'; api('').then(function (s) { if (s.ok) applyState(s.data); }, function () {}); }
      else if (e === 'coupon_used' || e === 'coupon_void' || e === 'bad_coupon' || e === 'coupon_not_discount') { cart.coupon = ''; saveCart(); }
      else if (e === 'unknown_item') { (d.ids || []).forEach(function (id) { delete cart.items[id]; }); saveCart(); }
      render(); if (sheetKind === '장바구니') cerr(msg); else toast(msg);
    }, function () {
      sending = false; netFailed = true; renderCart();
      cerr('네트워크가 불안정해요. 장바구니는 그대로예요. 다시 시도를 눌러 주세요 (중복 주문은 되지 않아요).');
      if (sheetKind !== '장바구니') toast('주문 전송을 확인하지 못했어요. 장바구니에서 다시 시도해 주세요.');
    });
  }
  function priceChanged(d) {
    priceChg = d;
    openSheet('가격이 바뀌었어요',
      '<h2>가격이 바뀌었어요</h2><p class="note" style="margin:-6px 0 10px">메뉴 가격이나 할인이 달라져서 주문을 보내지 않았어요. 금액을 확인해 주세요.</p>' +
      '<div class="sum"><span>이전 금액</span><span class="del">' + won(d.expectedTotal) + '</span></div>' +
      '<div class="sum tot"><span>현재 금액</span><span>' + won(d.total) + '</span></div>' +
      '<button class="y2k-btn y2k-btn--primary big" data-a="pconfirm">' + won(d.total) + '으로 주문하기</button><button class="y2k-btn big" style="margin-top:10px" data-a="sclose">장바구니로 돌아가기</button>',
      function () { openCart(); });
    api('').then(function (r) { if (r.ok) applyState(r.data); }, function () {}); checkMember(false);
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
  var payId = 0, payFresh = false, lastPayWasPaid = false;
  var MOBILE = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
  function digits(x) { return String(x || '').replace(/\D/g, ''); }
  function tossHref(p, total) {
    var bank = String(p.bank || '').replace(/(.)은행$/, '$1');   // 신한은행 -> 신한; 카카오뱅크, 토스뱅크 stay
    return 'supertoss://send?bank=' + encodeURIComponent(bank) + '&accountNo=' + encodeURIComponent(digits(p.account)) + '&amount=' + encodeURIComponent(String(total));
  }
  function kakaoOk(u) { try { var x = new URL(u); return x.protocol === 'https:' && x.hostname === 'qr.kakaopay.com' && !x.username && !x.password && !x.port; } catch (e) { return false; } }
  function depRow(o) {
    return '<div class="memrow"><span>' + (o.depositor ? '입금자명: <b style="color:var(--text)">' + esc(o.depositor) + '</b>' : '입금자명을 입력하면 입금 확인이 빨라요') + '</span><button class="y2k-btn sm" data-a="dep" data-v="' + o.id + '">' + (o.depositor ? '수정' : '입력') + '</button></div>';
  }
  function payInner(o, fresh) {
    var p = S.pay || {};
    if (o.status === 'cancelled') return '<h2>취소된 주문이에요</h2><p class="note">#' + o.id + ' 주문은 취소됐어요.</p><button class="y2k-btn big" style="margin-top:14px" data-a="sclose">확인</button>';
    if (o.paid) return '<h2>입금이 확인됐어요</h2><div class="amt">' + won(o.total) + '</div>' + (o.refundDue > 0 ? '<p class="note" style="text-align:center"><span class="tag bad">환불 예정</span> ' + won(o.refundDue) + ' · 직원에게 문의해 주세요</p>' : '') + '<p class="note" style="text-align:center">' + (o.paidBy === 'auto' ? '입금이 자동으로 확인됐어요.' : '직원이 입금을 확인했어요.') + ' #' + o.id + ' 주문 준비를 시작해요.</p><button class="y2k-btn big" style="margin-top:14px" data-a="sclose">확인</button>';
    var h = '<h2>' + (fresh ? '주문이 접수됐어요!' : '송금 안내') + '</h2><p class="note" style="margin:-6px 0 10px">#' + o.id + ' 주문 ' + (fresh ? '· 직원이 확인하면 조리를 시작해요' : '') + '</p>';
    var due = dueOf(o);
    if (due <= 0) return h + (o.refundDue > 0 ? '<div class="acct">보낼 금액이 없어요. 환불 예정 ' + won(o.refundDue) + ' · 직원에게 문의해 주세요.</div>' : '<div class="acct">쿠폰으로 전액 할인돼서 보낼 금액이 없어요.</div>') + '<button class="y2k-btn big" style="margin-top:14px" data-a="sclose">확인</button>';
    var cvDueNow = o.kind !== 'cover' && S.cover && coverOrder() && coverOrder().status !== 'cancelled' && !S.cover.waived && S.cover.left > 0 ? S.cover.left : 0;
    var part = o.paidAmount > 0 && due > 0;
    h += (cvDueNow ? '<div class="split"><b>입장료 ' + won(cvDueNow) + '은 이 금액에 들어 있지 않아요. 따로 보내 주세요.</b><button class="y2k-btn" data-a="cv-pay">입장료 보내기</button></div>' : '') + breakdown(o) + (part ? '<div class="sum"><span>받은 금액</span><span>' + won(o.paidAmount) + '</span></div>' : '') + '<div class="note" style="text-align:center;margin:8px 0 0">' + (part ? '남은 금액' : breakdown(o) ? '결제 금액' : '보낼 금액') + '</div><div class="amt">' + won(due) + '</div>';
    if (p.account) {
      h += '<div class="acct"><div class="bank">' + esc(p.bank) + ' · 예금주 ' + esc(p.holder) + '</div><div class="no">' + esc(p.account) + '</div></div>';
      if (p.tossEnabled && MOBILE) h += '<a class="y2k-btn y2k-btn--primary big pl" data-a="toss" data-v="' + o.id + '" href="' + esc(tossHref(p, due)) + '">토스로 보내기</a>';
      if (p.kakaoPayUrl && kakaoOk(p.kakaoPayUrl)) h += '<a class="y2k-btn big pl kk" data-a="kakao" href="' + esc(p.kakaoPayUrl) + '" target="_blank" rel="noopener noreferrer">카카오페이로 보내기</a><p class="note" style="margin:4px 0 0">금액 ' + won(due) + '을 직접 입력해 주세요</p>';
      h += '<div class="two"><button class="y2k-btn" data-a="copy" data-v="' + o.id + '" data-k="acct">계좌번호 복사</button><button class="y2k-btn" data-a="copy" data-v="' + o.id + '" data-k="amt">금액 복사</button></div><p class="note nextstep" id="paynext" hidden></p>';
    } else h += '<div class="acct">계좌 정보는 직원에게 문의해 주세요.</div>';
    h += (o.kind === 'cover' ? '' : depRow(o)) + '<p class="note">송금 후 직원이 입금을 확인하면 주문현황에 "입금 확인"으로 바뀌어요.</p>';
    if (fresh && notifSupported() && BoothNotify.permission() === 'default' && lsGet('jb:notif') !== '1') h += '<div class="memrow" id="notifOffer"><span>음식이 나오면 알려 드릴까요?</span><button class="y2k-btn sm" data-a="notif">알림 받기</button></div>';
    return h + '<button class="y2k-btn big" style="margin-top:14px" data-a="sclose">확인</button>';
  }
  function openPay(o, fresh) {
    payId = o.id; payFresh = !!fresh; lastPayWasPaid = !!o.paid;
    openSheet('송금 안내', '<div id="paybody">' + payInner(o, fresh) + '</div>', function () { if (fresh) { tab = 'orders'; render(); } });
  }
  function refreshPay() {   // called from render(): keeps an open pay sheet in sync (e.g. paid while open)
    var b = $('#paybody'); if (!b) return;
    var o = S.orders.filter(function (x) { return x.id === payId; })[0]; if (!o) return;
    var nxt = $('#paynext', b), keep = nxt && !nxt.hidden ? nxt.textContent : '';
    var wasPaid = lastPayWasPaid; b.innerHTML = payInner(o, payFresh); lastPayWasPaid = !!o.paid; if (o.paid && !wasPaid) vib([40, 40, 80]);
    if (keep) { var n2 = $('#paynext', b); if (n2) { n2.textContent = keep; n2.hidden = false; } }
  }
  function openDep(o) {
    var back = sheetKind === '송금 안내' || sheetKind === '토스 앱이 열리지 않으면';
    var sh = openSheet('입금자명', '<h2>입금자명</h2><p class="note" style="margin:-6px 0 4px">보내는 분 이름과 같아야 입금이 자동 확인돼요. (1~10자)</p><form id="df"><input class="inp" id="di" maxlength="10" autocomplete="name" enterkeyhint="done" aria-label="입금자명"><p class="err" id="de" role="alert"></p><button class="y2k-btn big" type="submit">저장</button></form>',
      function () { if (back) openPay(S.orders.filter(function (x) { return x.id === o.id; })[0] || o, false); });
    var di = $('#di', sh); di.value = o.depositor || lsGet('jb:dep') || ''; di.focus();
    $('#df', sh).addEventListener('submit', function (e) {
      e.preventDefault(); var v = di.value.trim(); if (!v) { $('#de').textContent = '입금자명을 입력해 주세요'; return; }
      api('/orders/' + o.id + '/depositor', { depositor: v }).then(function (r) {
        if (!r.ok) { $('#de').textContent = r.data.message || '저장하지 못했어요'; return; }
        lsSet('jb:dep', r.data.order.depositor || v);
        S.orders = S.orders.map(function (x) { return x.id === o.id ? r.data.order : x; });
        closeSheet(); toast('입금자명을 저장했어요'); render();
      }, function () { $('#de').textContent = '네트워크 오류예요. 다시 시도해 주세요.'; });
    });
  }
  function tossFallback() {
    var o = S.orders.filter(function (x) { return x.id === payId; })[0]; if (!o || o.paid) return;
    var p = S.pay || {};
    openSheet('토스 앱이 열리지 않으면', '<h2>토스 앱이 열리지 않으면</h2><p class="note" style="margin:-6px 0 10px">아래 정보를 복사해서 은행 앱에서 직접 보내 주세요.</p><div class="acct"><div class="bank">' + esc(p.bank) + ' · 예금주 ' + esc(p.holder) + '</div><div class="no">' + esc(p.account) + '</div></div><div class="two"><button class="y2k-btn" data-a="copy" data-v="' + o.id + '" data-k="acct">계좌번호 복사</button><button class="y2k-btn" data-a="copy" data-v="' + o.id + '" data-k="amt">금액 복사</button></div><p class="note nextstep" id="paynext" hidden></p><button class="y2k-btn big" style="margin-top:14px" data-a="sclose">닫기</button>',
      function () { openPay(S.orders.filter(function (x) { return x.id === o.id; })[0] || o, false); });
  }
  // COMS login in place. Posts to the COMS backend at the origin root (not the booth API); the booth server never sees the password.
  function openLogin() {
    var sh = openSheet('COMS 로그인',
      '<h2>COMS 로그인</h2><p class="note" style="margin:-6px 0 4px">COMS 동아리 계정으로 로그인하면 회원 할인이 바로 적용돼요.</p>' +
      '<form id="lf"><label class="fld">아이디(학번 또는 이메일)<input class="inp" id="li" maxlength="100" autocomplete="username" autocapitalize="off" spellcheck="false" aria-label="아이디(학번 또는 이메일)"></label>' +
      '<label class="fld">비밀번호<input class="inp" id="lp" type="password" maxlength="128" autocomplete="current-password" enterkeyhint="go" aria-label="비밀번호"></label>' +
      '<p class="err" id="le" role="alert"></p><button class="y2k-btn big" id="lb" type="submit">로그인</button></form>' +
      '<p class="note" style="margin:10px 0 0;text-align:center"><a href="/login" target="_blank" rel="noopener noreferrer">회원가입 · 비밀번호 찾기는 COMS 사이트에서</a></p>',
      function () { openCart(); });
    var li = $('#li', sh), lp = $('#lp', sh), lb = $('#lb', sh), le = $('#le', sh), busy = false;
    var GENERIC = '로그인하지 못했어요. 잠시 후 다시 시도해 주세요.';
    li.focus();
    function live() { return document.body.contains(lb); }
    function fail(msg) {
      if (msg && !live()) { toast(msg.indexOf('이메일 인증') >= 0 ? msg + ' COMS 사이트에서 인증해 주세요' : msg); return; } // sheet already closed: the inline error would be invisible
      le.textContent = msg || '';
      if (msg && msg.indexOf('이메일 인증') >= 0) {
        var a = document.createElement('a'); a.href = '/login'; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = 'COMS 사이트에서 인증하기';
        le.appendChild(document.createTextNode(' ')); le.appendChild(a);
      }
    }
    $('#lf', sh).addEventListener('submit', function (e) {
      e.preventDefault(); if (busy) return;
      var id = li.value.trim(), pw = lp.value;
      if (!id || !pw) { fail('아이디와 비밀번호를 입력해 주세요'); return; }
      busy = true; lb.disabled = true; fail('');
      fetch('/api/auth/login', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ identifier: id, password: pw, rememberMe: false }) })
        .then(function (res) {
          return res.json().then(function (d) { return d; }, function () { return null; }).then(function (d) { return { ok: res.ok, d: d }; });
        })
        .then(function (r) {
          lp.value = '';
          if (r.ok) {
            if (live()) closeSheet(); // the guest may have closed this sheet (and opened another) while the request was in flight
            return checkMember(false).then(function () {
              toast(isMember() ? '회원 확인됐어요. 할인이 적용돼요' : '로그인은 됐지만 회원 확인이 안 됐어요. 잠시 후 다시 확인을 눌러 주세요');
            });
          }
          var m = r.d && r.d.message;
          fail(typeof m === 'string' && /[가-힣]/.test(m) ? m.slice(0, 120) : GENERIC);
        }, function () { lp.value = ''; fail(GENERIC); })
        .then(function () { busy = false; lb.disabled = false; if (live() && le.textContent) lp.focus(); });
    });
  }
  function askNick(cb) {
    var sh = openSheet('닉네임',
      '<h2>닉네임을 정해요</h2><p class="note" style="margin:-6px 0 4px">전광판 랭킹에 표시돼요. (1~10자)</p>' +
      '<form id="nf"><input class="inp" id="ni" maxlength="10" autocomplete="off" enterkeyhint="done" placeholder="예: 맥주왕" aria-label="닉네임"><p class="err" id="ne" role="alert"></p><button class="y2k-btn big" type="submit">저장</button></form>');
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
  var MODS = { pour: 'PourGame', cheers: 'CheersGame', bug: 'BugGame', typing: 'TypingGame' };
  var GDESC = { pour: '화면을 꾹 눌러 잔을 채우고, 빨간 선에서 손을 떼요. 5잔, 넘치면 0점!', cheers: '두 잔이 부딪히는 순간 탭! 10번 건배, 가짜 감속에 속지 마세요.', bug: '코드 속에 숨은 버그를 터치해서 잡아요. 기능(✨)은 건드리면 감점! 콤보를 이어 가요.', typing: '화면에 뜨는 명령어를 빨리 정확하게 입력해요. 상대 해커보다 먼저!' };
  var GICO = { pour: 'i-mug', cheers: 'i-clink', bug: 'i-bug', typing: 'i-keyboard' };
  function gameIds() { var order = ['pour', 'cheers', 'bug', 'typing'], ks = Object.keys(S.games || {}); return order.filter(function (k) { return ks.indexOf(k) >= 0; }).concat(ks.filter(function (k) { return order.indexOf(k) < 0 && MODS[k]; })); }
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
    root.innerHTML = '<div class="gscr" role="dialog" aria-modal="true" aria-label="' + esc(S.games[id].label) + '"><div class="gwindow"><div class="y2k-title"><svg class="y2k-i y2k-i--2x" aria-hidden="true"><use href="' + ICO + '#' + (GICO[id] || 'i-floppy') + '"/></svg><span class="y2k-title-t">' + esc(S.games[id].label) + '.exe</span><button class="x" data-a="gexit" aria-label="게임 나가기">&times;</button></div><div class="ghost" id="ghost"></div></div></div>';
    document.body.style.overflow = 'hidden'; gamePlaying = true;
    var mod = window[MODS[id]], my = ++gameSeq;
    var h = mod.mount($('#ghost'), {
      reduced: REDUCED, vibrate: vib,
      onDone: function (score) { gamePlaying = false; flushAlerts(); finishPlay(id, play, score, t0, my); },
      onAbort: function () { closeGame(); toast('화면이 가려져서 게임이 중단됐어요. 다시 도전해 보세요!'); }
    });
    game = { id: id, handle: h };
  }
  function closeGame() {
    if (game && game.handle) game.handle.destroy();
    gameSeq++; game = null; $('#game-root').innerHTML = ''; document.body.style.overflow = ''; gamePlaying = false; flushAlerts();
  }
  function overlay(html) {
    var host = $('#ghost'); if (!host) return null;
    var o = $('.gover', host); if (!o) { o = document.createElement('div'); o.className = 'gover'; host.appendChild(o); }
    o.innerHTML = html; return o;
  }
  function finishPlay(id, play, score, t0, my) {
    overlay('<div class="spin y2k-progress" role="status" aria-label="집계 중"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div><div class="msg">점수를 집계하고 있어요…</div>');
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
      overlay('<div class="msg">' + esc(r.data.message || '점수를 저장하지 못했어요') + '</div><div class="row"><button class="y2k-btn" data-a="gagain" data-v="' + id + '">다시 도전</button><button class="y2k-btn" data-a="gexit">닫기</button></div>');
    }, function () {
      if (my !== gameSeq || !$('#ghost')) return;
      overlay('<div class="msg">네트워크가 불안정해요</div><p class="note">점수는 그대로예요. 다시 시도해 주세요.</p><div class="row"><button class="y2k-btn" id="rt">다시 시도</button><button class="y2k-btn" data-a="gexit">닫기</button></div>');
      $('#rt').onclick = function () { overlay('<div class="spin y2k-progress" role="status"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>'); sendFinish(id, play, score, my); };
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
    var low = (d.rewards || []).filter(function (r) { return r.result === 'low_score'; }).map(function (r) { return { label: r.label, th: (S.rewards.filter(function (x) { return x.id === r.rewardId; })[0] || {}).threshold || 0 }; }).sort(function (a, b) { return a.th - b.th; });
    if (low.length) h += '<div class="msg">' + (issued.length ? '다음 보상까지 ' : '아쉬워요! ') + esc(low[0].label) + (low[0].th ? '까지 ' + Math.max(1, low[0].th - score) + '점 남았어요' : '') + '</div><p class="note">' + (low[0].th ? low[0].th + '점 이상이면 받을 수 있어요. ' : '') + '다시 도전!</p>';
    else if (!issued.length && !(d.rewards || []).length) h += '<div class="msg">재미로 한 판, 수고했어요!</div>';
    (d.rewards || []).forEach(function (r) {
      var L = esc(r.label);
      if (r.reason === 'seat_limit') h += '<p class="note">' + L + '은(는) 이 테이블이 받을 수 있는 만큼 이미 받았어요</p>';
      else if (r.reason === 'device_limit') h += '<p class="note">' + L + '은(는) 이 폰으로는 이미 받았어요</p>';
      else if (r.reason === 'table_total_limit') h += '<p class="note">이 테이블이 받을 수 있는 쿠폰을 다 받았어요. ' + L + '은(는) 받지 못했어요</p>';
      else if (r.reason === 'stock_out') h += '<p class="note">' + L + ' 재고가 모두 소진됐어요</p>';
      else if (r.result === 'already_got') h += '<p class="note">' + L + '은(는) 이미 받았어요</p>';
      else if (r.result === 'sold_out') h += '<p class="note">' + L + ' 재고가 모두 소진됐어요</p>';
    });
    h += '<div class="row"><button class="y2k-btn" data-a="gagain" data-v="' + id + '">다시 도전</button>' + (issued.length ? '<button class="y2k-btn" data-a="gcoupon">쿠폰 보기</button>' : '<button class="y2k-btn" data-a="gexit">닫기</button>') + '</div>';
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
      case 'party-open': openParty(); break;
      case 'add': setQty(v, 1); break;
      case 'inc': setQty(v, (cart.items[v] || 0) + 1); break;
      case 'dec': setQty(v, (cart.items[v] || 0) - 1); break;
      case 'cart': openCart(); break;
      case 'submit': submit(); break;
      case 'sclose': closeSheet(); break;
      case 'copy': {
        var co = S.orders.filter(function (x) { return x.id === Number(v); })[0], isAcct = b.dataset.k === 'acct', fixed = b.dataset.amt != null ? Number(b.dataset.amt) : null;
        if (!co && fixed == null) break;
        var dueV = fixed != null ? fixed : dueOf(co);
        copyText(isAcct ? digits((S.pay || {}).account) : String(dueV)).then(function (ok) {
          toast(ok ? (isAcct ? '계좌번호를 복사했어요' : '금액을 복사했어요') : '복사하지 못했어요. 길게 눌러 직접 복사해 주세요');
          var nx = $('#paynext'); if (ok && isAcct && nx) { nx.textContent = '은행 앱에서 붙여넣고 ' + won(dueV) + '을 보내 주세요'; nx.hidden = false; }
        }); break;
      }
      case 'toss': setTimeout(function () { if (!document.hidden) tossFallback(); }, 1500); break;   // link navigates by itself; still visible = app not installed
      case 'dep': var dor = S.orders.filter(function (x) { return x.id === Number(v); })[0]; if (dor) openDep(dor); break;
      case 'pay': var o = S.orders.filter(function (x) { return x.id === Number(v); })[0]; if (o) openPay(o, false); break;
      case 'cancel':
        if (!cancelArm[v]) { cancelArm[v] = true; render(); setTimeout(function () { delete cancelArm[v]; if (S) render(); }, 3500); break; }
        delete cancelArm[v]; selfCancel[v] = 1;
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
      case 'photo': openPhoto(v); break;
      case 'padd': setQty(v, (cart.items[v] || 0) + 1); closeSheet(); toast('장바구니에 담았어요'); break;
      case 'start': openSheet('시작', '<div class="y2k-lockup glogo"><i class="y2k-ico" aria-hidden="true"></i><span class="y2k-chrome-text">COMHERE</span></div><div class="y2k-term" style="margin-top:8px"><div class="hi">COMHERE.exe</div><div>' + (S.table.isTest ? '테스트' : S.table.number + '번 테이블') + '</div><div>주문 접수: ' + (S.orderingOpen ? '열림' : '닫힘') + '</div><div class="dim">1999 밤샘 코딩 아지트</div></div><p class="note" style="margin-top:10px">메뉴에서 담고, 주문현황에서 송금하고, 게임으로 쿠폰을 받아 보세요. 쿠폰 코드는 직원에게 보여 주면 돼요.</p><button class="y2k-btn big" style="margin-top:10px" data-a="sclose">확인</button>'); break;
      case 'notice': if (S.notice && S.notice.text) openSheet('공지', '<p style="font-size:18px;line-height:1.5;white-space:pre-wrap">' + esc(S.notice.text) + '</p><button class="y2k-btn big" style="margin-top:14px" data-a="sclose">확인</button>'); break;
      case 'pt-open': openParty(); break;
      case 'pt-dec': partyN = Math.max(1, partyN - 1); renderParty(); break;
      case 'pt-inc': partyN = Math.min(30, partyN + 1); renderParty(); break;
      case 'pt-later': closeSheet(); break;
      case 'pt-ok': setParty(); break;
      case 'sh-open': openShare(); break;
      case 'sh-one': shareSel = { mode: 'one', n: 1 }; sharePayer = ($('#shp') || {}).value || sharePayer; renderShare(''); break;
      case 'sh-n': shareSel = { mode: 'n', n: Math.max(2, shareSel.n) }; sharePayer = ($('#shp') || {}).value || sharePayer; renderShare(''); break;
      case 'sh-all': shareSel = { mode: 'all', n: 1 }; sharePayer = ($('#shp') || {}).value || sharePayer; renderShare(''); break;
      case 'sh-dec': shareSel.n = Math.max(1, shareN() - 1); sharePayer = ($('#shp') || {}).value || sharePayer; renderShare(''); break;
      case 'sh-inc': shareSel.n = Math.min(availLeft(), shareN() + 1); sharePayer = ($('#shp') || {}).value || sharePayer; renderShare(''); break;
      case 'sh-go': shareGo(); break;
      case 'sh-view': var iv = (S.cover.myIntents || []).filter(function (x) { return String(x.id) === String(v); })[0]; if (iv) { shareView = { id: iv.id, amount: iv.amount, shares: iv.shares, payer: iv.payer, expiresAt: iv.expiresAt, base: S.cover.shares.paid }; closeSheet(true); showShareTransfer(); } break;
      case 'sh-cancel': cancelIntent(v); if (sheetKind === '입장료 송금') closeSheet(true); break;
      case 'cv-pay': openCoverPay(); break;
      case 'food-pay': openFoodPay(); break;
      case 'mute': muted = !muted; lsSet('jb:mute', muted ? '1' : '0'); render(); if (!muted) chime('info'); break;
      case 'notif': toggleNotif(); break;
      case 'mrecheck': checkMember(true); break;
      case 'mlogin': openLogin(); break;
      case 'pconfirm': if (priceChg) { expectOverride = priceChg.total; priceChg = null; closeSheet(true); openCart(); submit(); } break;
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
  document.addEventListener('visibilitychange', function () { if (!document.hidden && S) { poll(); if (Date.now() - lastMemberCheck > 10000) checkMember(false); } });
  window.addEventListener('pagehide', function () { clearTimeout(rcT); if (es) { es.onopen = es.onerror = null; es.close(); es = null; } stopPoll(); });
  window.addEventListener('pageshow', function (e) { if (e.persisted && S) { connect(); poll(); } });

  document.addEventListener('click', function (ev) {
    var t = ev.target.closest('#tabs [data-a="tab"]'); if (t) closeSheet(true);
  }, true);

  function boot() {
    api('').then(function (r) {
      if (r.status === 404) return fatal('QR 코드를 다시 찍어 주세요', '이 테이블 주소를 찾을 수 없어요. 테이블에 붙은 QR을 다시 찍어 주세요.');
      if (!r.ok) { $('#panel').innerHTML = '<p class="empty">' + esc(r.data.message || '불러오지 못했어요') + '</p><button class="y2k-btn big" data-a="reload">다시 불러오기</button>'; return; }
      applyState(r.data); connect(); checkMember(false); resumePend();
    }, function () {
      $('#panel').innerHTML = '<p class="empty">연결할 수 없어요.<br>와이파이나 데이터를 확인해 주세요.</p><button class="y2k-btn big" data-a="reload">다시 불러오기</button>';
    });
  }
  boot();
})();

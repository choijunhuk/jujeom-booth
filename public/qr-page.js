(function () {
  'use strict';
  var SC = window.SC, h = SC.h, $ = SC.$;
  $('#print').addEventListener('click', function () { window.print(); });

  SC.onUnauthorized = function () {
    $('#sheets').replaceChildren();
    $('#print').disabled = true;
    $('#info').replaceChildren(h('div', { class: 'err' }, h('p', null, 'QR 데이터를 불러오려면 스태프 로그인이 필요해요.'),
      h('a', { class: 'btn btn-primary', href: SC.BASE + '/staff?next=qr' }, 'PIN으로 로그인')));
  };

  function abs(u) { return /^https?:\/\//i.test(u) ? u : location.origin + u; }
  function half(label, big, bigCls, url, caption, sub, flip) {
    var box = h('div', { class: 'qrbox', role: 'img', 'aria-label': caption + ' QR 코드' });
    box.innerHTML = QR.svg(url, { margin: 2 }); // SVG generated locally from our own encoder; url is not interpolated as HTML
    return h('div', { class: 'half' + (flip ? ' flip' : '') },
      h('div', { class: 'id' }, h('span', { class: 'l' }, label), h('span', { class: 'n ' + bigCls }, String(big))),
      box, h('div', { class: 'cap' }, caption, h('small', null, sub)));
  }
  function card(label, big, bigCls, url, caption, sub) {
    return h('div', { class: 'card' },
      half(label, big, bigCls, url, caption, sub, true),
      h('div', { class: 'fold', 'aria-hidden': 'true' }, h('span', null, '접는 선')),
      half(label, big, bigCls, url, caption, sub, false),
      h('div', { class: 'url noprint' }, url));
  }

  SC.api('/api/staff/tables').then(function (d) {
    var cards = [card('입구', '대기', 'w', abs(d.waitUrl), 'QR 찍고 대기 등록', '자리가 나면 알려 드려요')];
    d.tables.slice().sort(function (a, b) { return a.number - b.number; }).forEach(function (t) {
      var s = String(t.number);
      cards.push(card('테이블', t.number, 'd' + Math.min(3, s.length), abs(t.url), 'QR 찍고 주문 · 게임', '쿠폰도 받아 가세요'));
    });
    var sheets = [];
    for (var i = 0; i < cards.length; i += 4) sheets.push(h('section', { class: 'sheet', 'aria-label': '인쇄 ' + (i / 4 + 1) + '쪽' }, cards.slice(i, i + 4)));
    $('#sheets').replaceChildren.apply($('#sheets'), sheets);
    $('#print').disabled = false;
    var info = [h('p', { class: 'muted' }, '카드 ' + cards.length + '장 (대기 1 + 테이블 ' + d.tables.length + ') · A4 ' + sheets.length + '장. 가운데 점선으로 접어 세우면 양쪽 손님이 모두 읽을 수 있어요. 인쇄 설정에서 배율 100%(실제 크기)로 인쇄하세요.')];
    if (!d.origin) info.push(h('div', { class: 'warn' }, '서버에 PUBLIC_ORIGIN이 설정되어 있지 않아 지금 열린 주소(' + location.origin + ')로 QR을 만들었어요. 실제 행사 주소에서 이 페이지를 열어 인쇄해야 손님 휴대폰에서 열려요.'));
    $('#info').replaceChildren.apply($('#info'), info);
    fit();
  }, function (e) { if (e.status !== 401) $('#info').replaceChildren(h('div', { class: 'err' }, h('p', null, e.message))); });

  function fit() { var w = 190 * 3.7795 + 16; $('#sheets').style.setProperty('--z', String(Math.min(1, Math.max(0.3, innerWidth / w)))); }
  window.addEventListener('resize', fit);
})();

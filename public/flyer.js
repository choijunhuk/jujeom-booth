/* Staff flyer: two identical copies of the current booth promotion. */
(function () {
  'use strict';
  var SC = window.SC, h = SC.h, $ = SC.$, won = SC.won;
  var sheet = $('#fl-sheet'), status = $('#fl-status'), print = $('#fl-print');
  var fields = ['date', 'time', 'location'].map(function (key) { return $('#fl-' + key); });
  var storageKey = 'comhere-flyer-event:' + SC.BASE;
  var shell, gate, pending, running = false;
  var printHint = 'A4 가로 · 배율 100% (실제 크기) · 한 장에 전단지 2부';

  function fit() {
    sheet.querySelectorAll('.fl-details').forEach(function (box) {
      var content = box.firstElementChild;
      box.classList.remove('fl-compact');
      box.style.fontSize = '';
      function overflows() { return content.getBoundingClientRect().height > box.getBoundingClientRect().height; }
      for (var size = 15.5; size >= 14 && overflows(); size -= 0.5) box.style.fontSize = size + 'px';
      if (!overflows()) return;
      box.classList.add('fl-compact');
      box.style.fontSize = '';
      for (var compact = 15.5; compact >= 1 && overflows(); compact -= 0.5) box.style.fontSize = compact + 'px';
    });
  }

  function eventText() {
    return fields.map(function (field) { return SC.safeText(field.value, field.maxLength); }).filter(Boolean).join(' · ');
  }

  function updateEvent() {
    var value = eventText();
    sheet.querySelectorAll('.fl-event').forEach(function (el) { el.textContent = value; el.hidden = !value; });
    fit();
  }

  function menuSection(menu) {
    var items = menu.items.filter(function (item) { return !item.hidden && !item.soldOut; });
    var groups = menu.categories.map(function (cat) {
      var group = items.filter(function (item) { return item.cat === cat; });
      if (!group.length) return null;
      return h('div', { class: 'fl-menu-group' },
        h('h3', { class: 'fl-category' }, cat),
        group.map(function (item) {
          return h('div', { class: 'fl-item' },
            h('div', { class: 'fl-item-line' }, h('span', null, item.name), h('span', { class: 'fl-price fl-num' }, won(item.price))),
            item.components && item.desc ? h('p', { class: 'fl-desc' }, item.desc) : null);
        }));
    });
    return h('section', { class: 'fl-section' }, h('h2', null, '메뉴'),
      items.length ? h('div', { class: 'fl-menu' }, groups) : h('p', null, '판매 중인 메뉴가 없어요.'));
  }

  function memberOffer(state) {
    var rule = state.memberDiscount;
    if (!state.memberEnabled || !rule.enabled) return '';
    if (rule.mode === 'percent' && rule.pct > 0) {
      return 'COMS 회원 ' + rule.pct + '% 할인' + (rule.maxDiscount > 0 ? ' (최대 ' + won(rule.maxDiscount) + ')' : '');
    }
    if (rule.mode === 'fixed' && rule.amount > 0) {
      return 'COMS 회원 ' + won(rule.maxDiscount > 0 ? Math.min(rule.amount, rule.maxDiscount) : rule.amount) + ' 할인';
    }
    return '';
  }

  function prizeSection(state, data) {
    var prizes = data.rewards.filter(function (reward) { return reward.active; }).map(function (reward) {
      return h('li', null, data.games[reward.game].label + ' ',
        h('span', { class: 'fl-num' }, reward.threshold.toLocaleString('ko-KR')), '점 이상 → ', reward.label);
    });
    if (data.hourly.enabled) prizes.push(h('li', null, '매 정시 1등 테이블: ' + data.hourly.label));
    var member = memberOffer(state);
    if (member) prizes.push(h('li', { class: 'fl-num' }, member));
    return prizes.length ? h('section', { class: 'fl-section' },
      h('h2', null, '게임 & 혜택'), h('ul', { class: 'fl-prizes' }, prizes)) : null;
  }

  function render(state, rewards, tables) {
    var qr = h('div', { class: 'fl-qr', role: 'img', 'aria-label': '대기 등록 QR 코드' });
    qr.innerHTML = QR.svg(new URL(tables.waitUrl, location.origin).href, { margin: 4 });
    var page = h('article', { class: 'fl-page' }, h('div', { class: 'fl-window' },
      h('header', { class: 'fl-title' },
        h('img', { src: SC.BASE + '/static/brand/coms-logo.svg', alt: '' }), 'COMHERE.exe',
        h('span', { class: 'fl-buttons', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'))),
      h('div', { class: 'fl-hero' },
        h('h1', { class: 'fl-headline' }, 'COMHERE'),
        h('p', { class: 'fl-hook' }, 'QR로 주문하고 미니게임으로 쿠폰 받기'),
        h('p', { class: 'fl-event' })),
      h('div', { class: 'fl-details' }, h('div', { class: 'fl-details-content' },
        menuSection(state.menu), prizeSection(state, rewards))),
      h('section', { class: 'fl-wait' }, qr, h('div', null,
        h('strong', null, 'QR 찍고 대기 등록'),
        h('p', null, '자리가 나면 문자로 알려드려요'))),
      h('footer', { class: 'fl-footer' }, "COM's")));
    sheet.replaceChildren(page, page.cloneNode(true));
    updateEvent();
    document.fonts.ready.then(fit);
    status.textContent = printHint + (tables.origin ? '' : ' · 손님이 접속할 수 있는 행사 주소에서 인쇄해 주세요.');
  }

  function load() {
    if (pending) return pending;
    var task = Promise.all([SC.api('/api/staff/state'), SC.api('/api/staff/rewards'), SC.api('/api/staff/tables')])
      .then(function (results) {
        if (pending !== task) return false;
        render(results[0], results[1], results[2]);
        shell.conn.set('live');
        print.disabled = false;
        return true;
      }).catch(function (error) {
        if (pending === task && error.status !== 401) {
          shell.conn.set('off');
          status.textContent = '전단지 정보를 새로 불러오지 못했어요. ' + error.message;
          print.disabled = false;
        }
        return false;
      }).finally(function () { if (pending === task) pending = null; });
    pending = task;
    return task;
  }

  function start() {
    document.title = '전단지 인쇄 · COMHERE';
    if (!shell) {
      shell = SC.shell({ page: 'flyer', label: '전단지 인쇄', kinds: ['order'], onLogout: function () { gate.logout(); } });
      $('#app').insertBefore(shell.el, $('#main'));
    }
    running = true;
    status.textContent = '전단지 정보를 불러오는 중이에요.';
    load();
  }

  function stop() {
    running = false;
    pending = null;
    print.disabled = true;
    sheet.replaceChildren();
  }

  fields.forEach(function (field) {
    try { field.value = localStorage.getItem(storageKey + ':' + field.id) || ''; } catch (e) { /* storage blocked */ }
    field.addEventListener('input', function () {
      try { localStorage.setItem(storageKey + ':' + field.id, field.value); } catch (e) { /* storage blocked */ }
      updateEvent();
    });
  });

  print.addEventListener('click', async function () {
    print.disabled = true;
    if (await load()) {
      await document.fonts.ready;
      if (running) window.print();
    }
  });
  window.addEventListener('resize', fit);
  window.addEventListener('beforeprint', fit);
  window.addEventListener('afterprint', fit);
  window.matchMedia('print').addEventListener('change', fit);
  function refresh() { if (running && document.visibilityState === 'visible') load(); }
  setInterval(refresh, 15000);
  document.addEventListener('visibilitychange', refresh);
  gate = SC.gate({ app: $('#app'), start: start, stop: stop, where: '전단지 인쇄' });
})();

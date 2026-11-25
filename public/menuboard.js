/* Print one A4 menu and ordering QR per guest table. */
(function () {
  'use strict';
  var SC = window.SC, h = SC.h, $ = SC.$, common = window.PrintCommon;
  var sheet = $('#mb-sheet'), picker = $('#mb-table'), all = $('#mb-all'), one = $('#mb-one');
  var status = $('#mb-status'), origin = $('#mb-origin'), overflow = $('#mb-overflow');
  var shell, gate, pending, lastSig = '', running = false, printing = false, requestingPrint = false;
  var printMq = window.matchMedia('print');

  function inPrint() { return printing || printMq.matches; }

  function fit() {
    sheet.classList.add('mb-printing'); // Measure against the paper layout even on a narrow screen.
    var tooLong = false;
    sheet.querySelectorAll('.mb-details').forEach(function (box) {
      if (!box.getClientRects().length) return;
      var menu = box.firstElementChild.firstElementChild;
      box.style.fontSize = '';
      function overflows() { return menu.scrollHeight > menu.clientHeight || box.scrollHeight > box.clientHeight; }
      for (var size = parseFloat(getComputedStyle(box).fontSize) - 0.5; size >= 9 && overflows(); size -= 0.5) {
        box.style.fontSize = size + 'px';
      }
      if (overflows()) tooLong = true;
    });
    if (!printing) sheet.classList.remove('mb-printing');
    overflow.hidden = !tooLong;
  }

  function makePage(table, details) {
    var qr = h('div', { class: 'mb-qr', role: 'img', 'aria-label': table.number + '번 테이블 주문 QR 코드' });
    qr.innerHTML = QR.svg(table.url, { margin: 4 });
    return h('article', { class: 'mb-page', dataset: { table: table.number } },
      h('header', { class: 'y2k-title mb-title' },
        h('img', { src: SC.BASE + '/static/brand/coms-logo.svg', alt: '' }),
        h('span', { class: 'y2k-title-t' }, 'COMHERE.exe'),
        h('span', { class: 'y2k-title-btns', 'aria-hidden': 'true' },
          h('span', { class: 'y2k-tb' }, '_'), h('span', { class: 'y2k-tb' }, '□'), h('span', { class: 'y2k-tb' }, '×'))),
      h('h1', { class: 'mb-number' }, h('span', { class: 'y2k-num' }, table.number), '번 테이블'),
      h('section', { class: 'mb-order' }, qr,
        h('div', { class: 'mb-order-copy' },
          h('h2', null, 'QR 찍고 바로 주문'),
          h('p', null, '직원 안 불러도 주문 · 결제 · 직원 호출까지 휴대폰으로 돼요'),
          h('ol', { class: 'mb-steps', role: 'list' },
            h('li', null, '① 휴대폰 카메라로 QR 찍기'),
            h('li', null, '② 메뉴 담고 주문'),
            h('li', null, '③ 안내에 따라 계좌이체'))),
        h('p', { class: 'mb-url' }, table.url)),
      details.cloneNode(true),
      h('footer', { class: 'mb-footer' }, "COM's"));
  }

  function syncControls() {
    var available = running && !!sheet.firstElementChild && !requestingPrint;
    all.disabled = picker.disabled = !available;
    one.disabled = !available || !picker.value;
  }

  function selectTable() {
    var selected = picker.value;
    sheet.querySelectorAll('.mb-page').forEach(function (page) {
      page.classList.toggle('mb-other', !!selected && page.dataset.table !== selected);
    });
    syncControls();
    fit();
  }

  function render(state, rewards, data) {
    var tables = common.tableLinks(data);
    var warning = common.originWarning(data);
    var details = h('div', { class: 'mb-details' }, h('div', { class: 'mb-details-content' },
      common.menuSection(state.menu, true), common.prizeSection(state, rewards)));
    var sig = JSON.stringify([tables, warning, details.innerHTML]);
    if (sig === lastSig) return;

    var selected = picker.value;
    var pages = tables.map(function (table) { return makePage(table, details); });
    SC.fill(picker, h('option', { value: '' }, '전체'), tables.map(function (table) {
      return h('option', { value: table.number }, table.number + '번');
    }));
    picker.value = tables.some(function (table) { return String(table.number) === selected; }) ? selected : '';
    sheet.replaceChildren.apply(sheet, pages);
    origin.textContent = warning;
    origin.hidden = !warning;
    lastSig = sig;
    selectTable();
    document.fonts.ready.then(function () { if (!inPrint()) fit(); });
  }

  function load() {
    if (pending) return pending;
    var task = Promise.all(['/api/staff/state', '/api/staff/rewards', '/api/staff/tables'].map(function (path) {
      return SC.api(path, { noAuthRedirect: true });
    })).then(function (results) {
      if (pending !== task || inPrint()) return false;
      render(results[0], results[1], results[2]);
      status.textContent = '';
      shell.conn.set('live');
      syncControls();
      return true;
    }).catch(function (error) {
      if (pending !== task || inPrint()) return false;
      if (error.status === 401) SC.onUnauthorized();
      else {
        shell.conn.set('off');
        status.textContent = '테이블 메뉴판을 새로 불러오지 못했어요. ' + error.message;
      }
      return false;
    }).finally(function () { if (pending === task) pending = null; });
    pending = task;
    return task;
  }

  function start() {
    document.title = '테이블 메뉴판 · COMHERE';
    if (!shell) {
      shell = SC.shell({ page: 'menuboard', label: '테이블 메뉴판', kinds: ['order'], onLogout: function () { gate.logout(); } });
      $('#app').insertBefore(shell.el, $('#main'));
    }
    running = true;
    status.textContent = '테이블 메뉴판을 불러오는 중이에요.';
    load();
  }

  function stop() {
    running = false;
    pending = null;
    lastSig = '';
    sheet.replaceChildren();
    SC.fill(picker, h('option', { value: '' }, '전체'));
    syncControls();
  }

  async function print(showAll) {
    if (inPrint() || requestingPrint) return;
    requestingPrint = true;
    syncControls();
    try {
      if (!await load()) return;
      await document.fonts.ready;
      if (!running || inPrint() || (!showAll && !picker.value)) return;
      sheet.classList.toggle('mb-print-all', showAll);
      window.print();
    } finally {
      requestingPrint = false;
      if (!inPrint()) sheet.classList.remove('mb-print-all');
      syncControls();
    }
  }

  function refresh() { if (running && document.visibilityState === 'visible' && !inPrint()) load(); }
  all.addEventListener('click', function () { print(true); });
  one.addEventListener('click', function () { print(false); });
  picker.addEventListener('change', selectTable);
  window.addEventListener('resize', function () { if (!inPrint()) fit(); });
  window.addEventListener('beforeprint', function () {
    printing = true;
    fit();
  });
  window.addEventListener('afterprint', function () {
    printing = false;
    sheet.classList.remove('mb-printing', 'mb-print-all');
    fit();
    refresh();
  });
  if (printMq.addEventListener) printMq.addEventListener('change', fit); else if (printMq.addListener) printMq.addListener(fit);
  setInterval(refresh, 15000);
  document.addEventListener('visibilitychange', refresh);
  gate = SC.gate({ app: $('#app'), start: start, stop: stop, where: '테이블 메뉴판' });
})();

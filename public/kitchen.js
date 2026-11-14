/* Kitchen display: aggregated "what to cook" + cooking orders oldest first. Same components as the staff board, larger scale. */
(function () {
  'use strict';
  var SC = window.SC, h = SC.h, $ = SC.$;
  var TITLE = '주방 · COMHERE';
  var seen = null, itemSigs = null, changed = {}, live = null, lockUntil = 0, shell = null, gate = null;

  var make = $('#make'), jobs = $('#jobs');
  var emptyMake = h('div', { class: 'empty' }, '만들 음식이 없어요'), emptyJobs = h('div', { class: 'empty' }, '조리 중인 주문이 없어요');

  function lateOf(since) { var m = (Date.now() - since) / 60000; return m >= 20 ? 2 : m >= 10 ? 1 : 0; }
  function paintLate() {
    jobs.querySelectorAll('.ocard').forEach(function (el) {
      var l = lateOf(Number(el.dataset.since)), w = el.querySelector('.late');
      el.classList.toggle('late1', l === 1); el.classList.toggle('late2', l === 2);
      w.hidden = !l;
      w.textContent = l === 2 ? '! 지연' : '! 오래 걸림';
      w.className = 'tag late ' + (l === 2 ? 'bad solid' : 'warn');
      var ch = el.querySelector('.chg');
      if (ch) ch.hidden = !(changed[el.dataset.oid] && Date.now() - changed[el.dataset.oid] < 90000);
    });
  }

  function jobCard(o) {
    var b = h('button', { class: 'btn btn-primary btn-block', type: 'button', onclick: function () {
      if (Date.now() < lockUntil) return;
      SC.act(b, function () {
        return SC.api('/api/staff/orders/' + o.id + '/status', { body: { status: 'served' } }).then(function () {
          // the next order slides under the finger: lock every 완료 button briefly
          lockUntil = Date.now() + 700;
          var all = jobs.querySelectorAll('.btn-primary');
          all.forEach(function (x) { x.disabled = true; });
          setTimeout(function () { all.forEach(function (x) { if (!x.classList.contains('busy')) x.disabled = false; }); }, 700);
          return live.refresh();
        });
      });
    } }, '완료');
    b.appendChild(h('span', { class: 'vh' }, ' ' + o.table + '번 테이블'));
    return h('article', { class: 'ocard st-cooking xl' + (changed[o.id] && Date.now() - changed[o.id] < 4000 ? ' hl' : ''), dataset: { since: o.since, oid: o.id } },
      h('div', { class: 'ohead' },
        h('div', { class: 'tno' }, h('span', { class: 'n', text: o.table }), h('span', { class: 'u', text: '번 테이블' })),
        h('div', { class: 'ometa' },
          h('div', { class: 'line' }, h('span', { class: 'oid' }, '#' + o.id), SC.timeEl(o.since, 'dur')),
          h('div', { class: 'line' }, h('span', { class: 'tag info' }, '조리 중'), o.member ? h('span', { class: 'tag info' }, '★ COMS 회원') : null, h('span', { class: 'tag late', hidden: true }), h('span', { class: 'tag bad solid chg', hidden: true }, '주문 변경됨')))),
      h('ul', { class: 'items' }, o.items.map(function (i) { return h('li', null, h('span', { class: 'q' }, '×' + i.qty), h('span', null, i.name), i.service ? h('span', { class: 'tag ok' }, '서비스') : null); })),
      o.note ? h('p', { class: 'note' }, h('b', null, '요청'), o.note) : null,
      h('div', { class: 'oact' }, b));
  }

  function onState(d) {
    var ids = new Set(d.orders.map(function (o) { return o.id; }));
    if (seen) {
      var fresh = d.orders.filter(function (o) { return !seen.has(o.id); });
      fresh.forEach(function (o) { SC.notif.show('새 조리 주문 · ' + o.table + '번 테이블', SC.itemsText(o.items), 'cook-' + o.id); });
      if (fresh.length) { SC.attention('kitchen'); SC.toast('새 주문 · ' + fresh.map(function (o) { return o.table + '번'; }).join(', ') + ' 테이블', 'ok'); }
    }
    seen = ids;
    var sigs = {};
    d.orders.forEach(function (o) { sigs[o.id] = JSON.stringify(o.items); });
    if (itemSigs) {
      var edited = d.orders.filter(function (o) { return itemSigs[o.id] != null && itemSigs[o.id] !== sigs[o.id]; });
      edited.forEach(function (o) { changed[o.id] = Date.now(); SC.notif.show('주문 변경 · ' + o.table + '번 테이블', SC.itemsText(o.items), 'chg-' + o.id + '-' + Date.now()); });
      if (edited.length) { SC.attention('kitchen'); SC.toast('주문 변경 · ' + edited.map(function (o) { return o.table + '번'; }).join(', ') + ' 테이블', 'ok'); }
    }
    itemSigs = sigs;
    var total = d.items.reduce(function (a, i) { return a + i.qty; }, 0);
    $('#mk-n').textContent = total ? '총 ' + total + '개' : ''; $('#mk-n').hidden = !total;
    $('#jb-n').textContent = d.orders.length ? d.orders.length + '건' : ''; $('#jb-n').hidden = !d.orders.length;
    SC.reconcile(make, d.items, function (i) { return i.id; }, JSON.stringify, function (i) {
      return h('div', { class: 'tile xl' }, h('span', { class: 'q' }, String(i.qty)), h('span', { class: 'nm' }, i.name));
    }, emptyMake);
    SC.reconcile(jobs, d.orders, function (o) { return o.id; }, JSON.stringify, jobCard, emptyJobs);
    SC.setTitle(d.orders.length, TITLE);
    paintLate();
  }

  function start() {
    var app = $('#app');
    if (!shell) {
      SC.prefs.defaults({ vol: 2 }); // kitchen is noisy: loudest by default
      shell = SC.shell({ page: 'kitchen', label: '주방', kinds: ['kitchen'], onLogout: function () { gate.logout(); } });
      app.insertBefore(SC.audioStrip(), app.firstChild);
      app.insertBefore(shell.el, $('#main'));
    }
    seen = null;
    shell.conn.set('wait');
    live = SC.live({ sse: '/api/kitchen/events', poll: '/api/kitchen', onState: onState, onStatus: function (s) { shell.conn.set(s); } });
    SC.wake.sync();
  }
  function stop() { if (live) { live.close(); live = null; } document.querySelectorAll('dialog[open]').forEach(function (d) { d.close(); }); }

  setInterval(paintLate, 15000);
  gate = SC.gate({ app: $('#app'), start: start, stop: stop, where: '주방' });
})();

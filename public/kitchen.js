/* Kitchen display: aggregated "what to cook" + cooking orders oldest first. */
(function () {
  'use strict';
  var SC = window.SC, h = SC.h, $ = SC.$;
  var TITLE = '주방 · 주점 부스';
  var seen = null, live = null, lockUntil = 0;

  SC.onUnauthorized = function () { location.replace(SC.BASE + '/staff?next=kitchen'); };

  var conn = SC.connIndicator();
  $('#top').append(h('h1', null, '주방 ', h('span', null, '화면')), conn, SC.soundButton(), h('a', { class: 'btn', href: SC.BASE + '/staff' }, '스태프 화면'));

  var make = $('#make'), jobs = $('#jobs');
  var emptyMake = h('div', { class: 'empty k-empty' }, '만들 음식이 없어요'), emptyJobs = h('div', { class: 'empty k-empty' }, '조리 중인 주문이 없어요');

  function lateClass(since) { var m = (Date.now() - since) / 60000; return m >= 20 ? 'l2' : m >= 10 ? 'l1' : ''; }
  function lateLabel(since) { var m = (Date.now() - since) / 60000; return m >= 20 ? '지연' : m >= 10 ? '오래 걸림' : ''; }
  function paintLate() {
    jobs.querySelectorAll('.job').forEach(function (el) {
      var since = Number(el.dataset.since), c = lateClass(since), w = el.querySelector('.w');
      el.classList.toggle('l1', c === 'l1'); el.classList.toggle('l2', c === 'l2');
      var t = lateLabel(since);
      w.textContent = t ? '! ' + t : '';
      w.className = 'w tag ' + (c === 'l2' ? 'bad solid' : 'warn');
      w.hidden = !t;
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
    var el = SC.timeEl(o.since, 'dur');
    el.classList.add('t');
    b.appendChild(h('span', { class: 'vh' }, ' ' + o.table + '번 테이블'));
    return h('article', { class: 'job', dataset: { since: o.since } },
      h('div', { class: 'job-head' },
        h('div', { class: 'tn' }, String(o.table), h('small', null, '번 테이블 · #' + o.id)),
        h('div', { class: 'el' }, el, h('span', { class: 'w tag', hidden: true }))),
      h('ul', { class: 'items' }, o.items.map(function (i) { return h('li', null, h('span', { class: 'q' }, '×' + i.qty), h('span', null, i.name)); })),
      o.note ? h('p', { class: 'note' }, h('b', null, '요청'), o.note) : null,
      b);
  }

  function onState(d) {
    var ids = new Set(d.orders.map(function (o) { return o.id; }));
    if (seen) {
      var fresh = d.orders.filter(function (o) { return !seen.has(o.id); });
      if (fresh.length) { SC.attention('kitchen'); SC.toast('새 주문 · ' + fresh.map(function (o) { return o.table + '번'; }).join(', ') + ' 테이블', 'ok'); }
    }
    seen = ids;
    $('#mk-n').textContent = d.items.reduce(function (a, i) { return a + i.qty; }, 0) ? '총 ' + d.items.reduce(function (a, i) { return a + i.qty; }, 0) + '개' : '';
    $('#jb-n').textContent = d.orders.length ? d.orders.length + '건' : '';
    SC.reconcile(make, d.items, function (i) { return i.id; }, JSON.stringify, function (i) {
      return h('div', { class: 'mk' }, h('span', { class: 'q' }, String(i.qty)), h('span', { class: 'nm' }, i.name));
    }, emptyMake);
    SC.reconcile(jobs, d.orders, function (o) { return o.id; }, JSON.stringify, jobCard, emptyJobs);
    SC.setTitle(d.orders.length, TITLE);
    paintLate();
  }

  setInterval(paintLate, 15000);
  SC.api('/api/staff/me', { noAuthRedirect: true }).then(function () {
    live = SC.live({ sse: '/api/kitchen/events', poll: '/api/kitchen', onState: onState, onStatus: conn.set });
  }, function () { SC.onUnauthorized(); });
})();

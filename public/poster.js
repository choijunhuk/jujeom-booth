/* Staff booth promotion and entrance waitlist QR. */
(function () {
  'use strict';
  var SC = window.SC, $ = SC.$, common = window.PrintCommon;
  var poster = $('#bp-poster'), qr = $('#bp-qr'), link = $('#bp-wait-link'), print = $('#bp-print');
  var status = $('#bp-status'), origin = $('#bp-origin'), coverOff = $('#bp-cover-off');
  var fields = [$('#fl-date'), $('#fl-time'), $('#fl-location')];
  var storagePrefix = 'comhere-flyer-event:' + SC.BASE + ':';
  var today = new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' });
  var settings = { noAuthRedirect: true };
  var printMedia = window.matchMedia('print');
  var shell, gate, pending, refreshTimer, printing = false;

  function updateEvent() {
    var parts = fields.map(function (field) { return SC.safeText(field.value, field.maxLength); });
    parts[0] = parts[0] || today.format(new Date());
    $('#bp-event').textContent = parts.filter(Boolean).join(' · ');
  }

  function renderCover(cover) {
    var label = cover.label.trim();
    var benefit = /^입장료\s*\((.+)\)$/.exec(label);
    $('#bp-unit').textContent = cover.mode === 'per_person' ? '1인당' : '테이블당';
    $('#bp-value').textContent = SC.won(cover.amount);
    var benefitText = benefit ? benefit[1] : label === '입장료' ? '' : label;
    $('#bp-benefit').textContent = benefitText;
    $('#bp-benefit').hidden = !benefitText;
    $('#bp-cover').hidden = !(cover.amount > 0);
    coverOff.hidden = cover.enabled;
  }

  function renderTeasers(menu, rewards) {
    var items = menu.items.filter(function (item) { return !item.hidden; });
    var featured = menu.categories.map(function (category) {
      return items.find(function (item) { return item.cat === category; });
    }).filter(Boolean);
    if (featured.length < 3) {
      featured = featured.concat(items.filter(function (item) { return !featured.includes(item); }));
    }
    var list = $('#bp-items'), reward = $('#bp-reward');
    var available = rewards.rewards.filter(function (entry) { return entry.active && entry.remaining > 0; });
    list.replaceChildren(...featured.slice(0, 4).map(function (item) {
      return SC.h('li', { title: item.name }, item.name);
    }));
    list.hidden = !list.childElementCount;
    reward.textContent = available.some(function (entry) { return entry.type === 'discount'; })
      ? '게임 이기면 할인 쿠폰' : '게임 이기면 쿠폰';
    reward.hidden = !available.length;
    $('#bp-menu').hidden = list.hidden && reward.hidden;
  }

  function load() {
    if (pending) return pending;
    var request = Promise.all([
      SC.api('/api/staff/state', settings),
      SC.api('/api/staff/rewards', settings),
      SC.api('/api/staff/tables', settings)
    ]).then(function ([state, rewards, tables]) {
      if (pending !== request) return false;
      var href = common.absoluteUrl(tables.waitUrl);
      if (link.href !== href) {
        qr.innerHTML = QR.svg(href, { margin: 4 });
        qr.firstElementChild.setAttribute('aria-hidden', 'true');
        link.href = href;
      }
      renderCover(state.cover);
      renderTeasers(state.menu, rewards);
      updateEvent();
      origin.textContent = common.originWarning(tables);
      origin.hidden = !origin.textContent;
      status.textContent = '';
      shell.conn.set('live');
      poster.hidden = false;
      if (!printing) print.disabled = false;
      return true;
    }).catch(function (error) {
      if (pending !== request) return false;
      if (error.status === 401) SC.onUnauthorized();
      else {
        shell.conn.set('off');
        status.textContent = '부스 포스터를 새로 불러오지 못했어요. ' + error.message;
      }
      return false;
    }).finally(function () { if (pending === request) pending = null; });
    pending = request;
    return request;
  }

  function refresh() {
    if (refreshTimer && !printing && !printMedia.matches && document.visibilityState === 'visible') load();
  }

  function start() {
    if (!shell) {
      shell = SC.shell({ page: 'poster', label: '부스 포스터', kinds: ['order'], onLogout: function () { gate.logout(); } });
      $('#app').insertBefore(shell.el, $('#main'));
    }
    status.textContent = '부스 포스터를 불러오는 중이에요.';
    load();
    refreshTimer = setInterval(refresh, 15000);
  }

  function stop() {
    clearInterval(refreshTimer);
    refreshTimer = pending = null;
    poster.hidden = origin.hidden = coverOff.hidden = print.disabled = true;
    qr.replaceChildren();
    link.removeAttribute('href');
  }

  function restoreEvent() {
    fields.forEach(function (field) {
      try { field.value = localStorage.getItem(storagePrefix + field.id) || ''; } catch (e) { /* storage blocked */ }
    });
    updateEvent();
  }

  restoreEvent();
  fields.forEach(function (field) {
    field.addEventListener('input', function () {
      try { localStorage.setItem(storagePrefix + field.id, field.value); } catch (e) { /* storage blocked */ }
      updateEvent();
    });
  });
  window.addEventListener('storage', function (event) {
    if (event.key === null || fields.some(function (field) { return event.key === storagePrefix + field.id; })) restoreEvent();
  });
  window.addEventListener('pageshow', function (event) { if (event.persisted) restoreEvent(); });
  window.addEventListener('beforeprint', updateEvent);
  print.addEventListener('click', async function () {
    printing = print.disabled = true;
    try {
      if (!await load()) return;
      await document.fonts.ready;
      if (!poster.hidden) window.print();
    } finally {
      printing = false;
      print.disabled = poster.hidden;
    }
  });
  document.addEventListener('visibilitychange', refresh);
  gate = SC.gate({ app: $('#app'), start: start, stop: stop, where: '부스 포스터' });
})();

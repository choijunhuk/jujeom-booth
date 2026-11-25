/* Print the entrance waitlist QR using the staff tables API. */
(function () {
  'use strict';
  var SC = window.SC, $ = SC.$, common = window.PrintCommon;
  var poster = $('#wp-poster'), qr = $('#wp-qr'), url = $('#wp-url'), button = $('#wp-print');
  var warning = $('#wp-origin'), status = $('#wp-status');
  var shell, gate, pending, refreshTimer, printing = false;

  function load() {
    if (pending) return pending;
    var request = SC.api('/api/staff/tables', { noAuthRedirect: true }).then(function (data) {
      if (pending !== request) return false;
      var href = common.absoluteUrl(data.waitUrl);
      if (url.href !== href) {
        qr.innerHTML = QR.svg(href, { margin: 4 });
        qr.firstElementChild.setAttribute('aria-hidden', 'true');
        url.href = url.textContent = href;
      }
      warning.textContent = common.originWarning(data);
      warning.hidden = !warning.textContent;
      status.textContent = '';
      poster.hidden = false;
      shell.conn.set('live');
      if (!printing) button.disabled = false;
      return true;
    }).catch(function (error) {
      if (pending !== request) return false;
      if (error.status === 401) SC.onUnauthorized();
      else {
        shell.conn.set('off');
        status.textContent = '대기 포스터를 새로 불러오지 못했어요. ' + error.message;
      }
      return false;
    }).finally(function () { if (pending === request) pending = null; });
    pending = request;
    return request;
  }

  function refresh() {
    if (refreshTimer && !printing && document.visibilityState === 'visible') load();
  }

  function start() {
    document.title = '대기 포스터 · COMHERE';
    if (!shell) {
      shell = SC.shell({ page: 'waitposter', label: '대기 포스터', kinds: ['order'], onLogout: function () { gate.logout(); } });
      $('#app').insertBefore(shell.el, $('#main'));
    }
    status.textContent = '대기 포스터를 불러오는 중이에요.';
    load();
    refreshTimer = setInterval(refresh, 15000);
  }

  function stop() {
    clearInterval(refreshTimer);
    refreshTimer = pending = null;
    poster.hidden = warning.hidden = button.disabled = true;
    qr.replaceChildren();
    url.removeAttribute('href');
    url.textContent = '';
  }

  button.addEventListener('click', async function () {
    printing = button.disabled = true;
    try {
      if (!await load()) return;
      await document.fonts.ready;
      if (!poster.hidden) window.print();
    } finally {
      printing = false;
      button.disabled = poster.hidden;
    }
  });
  document.addEventListener('visibilitychange', refresh);
  gate = SC.gate({ app: $('#app'), start: start, stop: stop, where: '대기 포스터' });
})();

/* Shared notification helper: window.BoothNotify. Goes through the booth service worker (needed on Android). */
(function () {
  'use strict';
  var BASE = window.BASE || '', regP = null;
  function supported() { return 'Notification' in window; }
  function permission() { return supported() ? Notification.permission : 'denied'; }
  function getReg() {
    if (regP) return regP;
    if (!('serviceWorker' in navigator)) return (regP = Promise.resolve(null));
    regP = Promise.resolve().then(function () { return navigator.serviceWorker.register(BASE + '/sw.js', { scope: BASE + '/' }); }).then(function (r) {
      if (r.active) return r;
      var w = r.installing || r.waiting; if (!w) return r;
      return new Promise(function (res) {
        w.addEventListener('statechange', function () { if (w.state === 'activated') res(r); });
        setTimeout(function () { res(r); }, 4000);
      });
    }).catch(function () { return null; });
    return regP;
  }
  function request() {
    if (!supported()) return Promise.resolve('denied');
    getReg();
    return new Promise(function (resolve) {
      var done = false; function fin(p) { if (!done) { done = true; resolve(p || permission()); } }
      try { var r = Notification.requestPermission(fin); if (r && r.then) r.then(fin, function () { fin('denied'); }); } catch (e) { fin('denied'); }
    });
  }
  function show(title, o) {
    o = o || {};
    var opts = { body: String(o.body || ''), tag: o.tag ? String(o.tag) : undefined, data: { url: o.url || location.href }, renotify: false };
    return getReg().then(function (r) {
      if (r && r.showNotification) return r.showNotification(String(title), opts);
      try { var n = new Notification(String(title), { body: opts.body, tag: opts.tag }); n.onclick = function () { window.focus(); n.close(); }; } catch (e) {}
    }).catch(function () {});
  }
  window.BoothNotify = { supported: supported, permission: permission, request: request, show: show };
})();

/* Booth service worker: notifications only. No fetch handler, no caching. */
var BASE = "__BASE__";
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
function inBooth(u) {
  try { var x = new URL(u, self.location.origin); return x.origin === self.location.origin && (x.pathname === BASE || x.pathname.indexOf(BASE + '/') === 0); } catch (e) { return false; }
}
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var d = e.notification.data, url = d && typeof d.url === 'string' ? d.url : '';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) if (inBooth(list[i].url) && list[i].focus) return list[i].focus();
    if (inBooth(url)) return self.clients.openWindow(url);
  }));
});

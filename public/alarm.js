/* Alarm settings dialog shared by staff and kitchen pages: sound, volume, notifications, wake lock, test sounds. */
(function () {
  'use strict';
  var SC = window.SC, h = SC.h, A = SC.audio;

  var NAMES = { order: '주문음', call: '호출음', wait: '대기음', kitchen: '주방음' };

  function row(title, sub, control) {
    return h('div', { class: 'al-row' }, h('div', { class: 'al-txt' }, h('b', null, title), sub ? h('span', { class: 'muted' }, sub) : null), control);
  }
  function toggle(on, onclick, disabled) {
    var b = h('button', { class: 'btn al-sw', type: 'button', 'aria-pressed': on ? 'true' : 'false', onclick: onclick }, on ? '켜짐' : '꺼짐');
    if (disabled) b.disabled = true;
    return b;
  }

  // kinds: sound names to offer as test buttons, e.g. ['order','call','wait']
  SC.alarmMenu = function (kinds) {
    var dlg = h('dialog', { class: 'dlg', 'aria-label': '알림 설정' });
    dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
    function build() {
      var notifWhy = SC.notif.reason(), wakeWhy = SC.wake.reason();
      var soundOn = A.state() === 'on';
      var vols = h('div', { class: 'al-seg', role: 'group', 'aria-label': '볼륨' }, SC.VOL_LABELS.map(function (l, i) {
        return h('button', { class: 'btn', type: 'button', 'aria-pressed': SC.prefs.get('vol') === i ? 'true' : 'false', onclick: function () { A.setVol(i); A.beep(kinds[0]); build(); } }, l);
      }));
      var tests = h('div', { class: 'al-seg' }, kinds.map(function (k) {
        return h('button', { class: 'btn', type: 'button', onclick: function () { if (!A.unlocked) A.unlock(); A.beep(k); SC.flash(); } }, NAMES[k] + ' 테스트');
      }));
      var notifOn = SC.prefs.get('notify') && !notifWhy && Notification.permission === 'granted';
      dlg.replaceChildren(h('div', { class: 'dlg-body' },
        h('h2', { class: 'dlg-title' }, '알림 설정'),
        row('소리', A.unlocked ? '새 주문·호출이 오면 소리가 나요' : '아직 잠겨 있어요. 켜면 바로 풀려요', toggle(soundOn, function () { A.setSound(!soundOn); build(); })),
        row('볼륨', null, vols),
        row('화면 알림', notifWhy || '다른 탭·화면을 보고 있을 때 알림창을 띄워요', toggle(notifOn, function () {
          if (notifOn) { SC.prefs.set('notify', false); build(); return; }
          SC.notif.enable().then(function (ok) { if (!ok) SC.toast(SC.notif.reason() || '알림 권한이 허용되지 않았어요.', 'error'); build(); });
        }, !!notifWhy)),
        notifOn ? h('div', { class: 'al-seg' }, h('button', { class: 'btn btn-sm', type: 'button', onclick: function () { SC.notif.show('알림 테스트', '이렇게 표시돼요', 'test', true); } }, '화면 알림 테스트')) : null,
        row('화면 켜 두기', wakeWhy || '이 화면이 보이는 동안 화면이 꺼지지 않게 해요', toggle(SC.prefs.get('wake') && !wakeWhy, function () {
          SC.prefs.set('wake', !SC.prefs.get('wake')); SC.wake.sync(); build();
        }, !!wakeWhy)),
        h('div', { class: 'al-row', style: 'display:grid' }, h('b', null, '소리 테스트'), tests),
        h('div', { class: 'dlg-actions' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: function () { dlg.close(); } }, '닫기'))));
    }
    document.body.appendChild(dlg);
    return h('button', { class: 'btn', type: 'button', onclick: function () { build(); dlg.showModal(); } }, '알림 설정');
  };
})();

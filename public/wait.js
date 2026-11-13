/* Public waitlist page: register, live position, "입장하세요" state. Place in line survives reloads. */
(function () {
  'use strict';
  var SC = window.SC, h = SC.h, $ = SC.$;
  var KEY = 'booth_wait';
  var main = $('#main'), calledEl = $('#called'), connEl = $('#conn');
  var entry = null, live = null, prevStatus = null, vibTimer = 0, size = 2, infoTimer = 0;

  SC.wake.active = function () { return !!entry; }; // keep the screen on only while waiting
  function save(v) { try { if (v) localStorage.setItem(KEY, JSON.stringify(v)); else localStorage.removeItem(KEY); } catch (e) { /* storage blocked */ } }
  function load() { try { var v = JSON.parse(localStorage.getItem(KEY)); return v && v.id && v.secret ? v : null; } catch (e) { return null; } }
  function q() { return '?secret=' + encodeURIComponent(entry.secret); }
  var LBL = { live: '실시간', poll: '5초마다 갱신', off: '연결 끊김', wait: '연결 중' };

  function stopLive() { clearInterval(infoTimer); if (live) { live.close(); live = null; } clearInterval(vibTimer); calledEl.hidden = true; connEl.hidden = true; }

  // ---------- form ----------
  function showForm(msg) {
    stopLive(); entry = null; prevStatus = null;
    document.title = '대기 등록 · 주점 부스';
    var nick = h('input', { class: 'field', type: 'text', maxlength: '10', autocomplete: 'nickname', required: true, 'aria-label': '대기 이름', placeholder: '예: 맥주왕 (최대 10자)' });
    var out = h('output', { 'aria-live': 'polite' }, String(size), h('small', null, '명'));
    var err = h('p', { class: 'err', role: 'alert' }, msg || '');
    function setSize(n) { size = Math.max(1, Math.min(10, n)); out.firstChild.textContent = String(size); minus.disabled = size <= 1; plus.disabled = size >= 10; }
    var minus = h('button', { class: 'btn', type: 'button', 'aria-label': '인원 줄이기', onclick: function () { setSize(size - 1); } }, '−');
    var plus = h('button', { class: 'btn', type: 'button', 'aria-label': '인원 늘리기', onclick: function () { setSize(size + 1); } }, '+');
    var go = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, '대기 등록');
    var form = h('form', { class: 'w-form', onsubmit: function (e) {
      e.preventDefault();
      var name = nick.value.trim();
      if (!name) { err.textContent = '이름(닉네임)을 입력해 주세요.'; nick.focus(); return; }
      err.textContent = '';
      SC.audio.unlock(); // user gesture: lets us beep when called
      SC.act(go, function () {
        return SC.api('/api/wait', { body: { nick: name, size: size }, noAuthRedirect: true }).then(function (r) {
          entry = { id: r.id, secret: r.secret }; save(entry); start();
        }, function (e2) { err.textContent = e2.code === 'wait_rate' ? '잠시 후 다시 시도해 주세요.' : e2.code === 'wait_closed' ? '지금은 대기 접수를 받지 않아요.' : e2.message; });
      });
    } },
      h('label', { class: 'lab' }, '이름 (닉네임)', nick),
      h('div', { class: 'lab' }, '인원', h('div', { class: 'stepper' }, minus, out, plus)),
      err, go,
      h('p', { class: 'hint' }, '전화번호는 받지 않아요. 자리가 나면 이 화면이 바뀌고 진동으로 알려 드려요. 화면을 켜 두거나, 이 페이지를 닫지 말아 주세요.'));
    var notice = h('p', { class: 'w-sub', role: 'status', 'aria-live': 'polite' }, '대기를 등록하면 순번을 알려 드려요.');
    main.replaceChildren(h('h1', { class: 'w-h' }, '자리가 날 때까지', h('br'), '여기서 기다려 주세요'), notice, form);
    setSize(size);
    function applyInfo(i) {
      form.hidden = !i.open;
      notice.className = i.open ? 'w-sub' : 'err';
      notice.textContent = i.open ? '현재 ' + (i.waitingTotal || 0) + '팀 대기 중' : '지금은 대기 접수를 받지 않아요';
    }
    function poll() { SC.api('/api/wait/info', { noAuthRedirect: true }).then(applyInfo, function () { /* keep last state */ }); }
    poll();
    infoTimer = setInterval(poll, 15000);
  }

  // ---------- ticket ----------
  var T = {};
  function buildTicket() {
    T.pos = h('div', { class: 'pos' }); T.ahead = h('div', { class: 'ahead' }); T.who = h('div', { class: 'who' }); T.total = h('div', { class: 'k' });
    var cancel = h('button', { class: 'btn btn-danger btn-block', type: 'button', onclick: function () {
      SC.confirm({ title: '대기를 취소할까요?', message: '취소하면 순번이 사라져요.', ok: '대기 취소', cancel: '계속 기다리기', danger: true }).then(function (ok) {
        if (!ok) return;
        SC.act(cancel, function () { return SC.api('/api/wait/' + entry.id + '/cancel', { body: { secret: entry.secret }, noAuthRedirect: true }).then(null, function (e) { if (e.status !== 404) throw e; }).then(function () { end('cancelled'); }); });
      });
    } }, '대기 취소');
    T.cancel = cancel;
    main.replaceChildren(
      SC.audioStrip(),
      h('div', { class: 'ticket' }, h('div', { class: 'k' }, '내 순번'), T.pos, T.ahead, h('div', { class: 'perf' }), T.who, T.total),
      h('p', { class: 'hint' }, '순서가 되면 이 화면이 "입장하세요"로 바뀌어요. 다른 앱을 쓰다 와도 괜찮지만 이 페이지는 닫지 말아 주세요.'),
      alertControls(),
      cancel);
  }

  // Optional helpers for the guest: notification on call, keep screen on. Permission is requested only on tap.
  function alertControls() {
    var box = h('div', { class: 'ctl' });
    function draw() {
      var nWhy = SC.notif.reason(), wWhy = SC.wake.reason();
      var nOn = SC.prefs.get('notify') && !nWhy && Notification.permission === 'granted';
      var nb = h('button', { class: 'btn btn-block', type: 'button', 'aria-pressed': nOn ? 'true' : 'false', onclick: function () {
        if (nOn) { SC.prefs.set('notify', false); draw(); return; }
        SC.notif.enable().then(function (ok) { if (!ok) SC.toast(SC.notif.reason() || '알림이 허용되지 않았어요.', 'error'); draw(); });
      } }, nOn ? '✓ 순서가 되면 알림 받기 (켜짐)' : '순서가 되면 알림 받기');
      if (nWhy) nb.disabled = true;
      var wOn = SC.prefs.get('wake') && !wWhy;
      var wb = h('button', { class: 'btn btn-block', type: 'button', 'aria-pressed': wOn ? 'true' : 'false', onclick: function () {
        SC.prefs.set('wake', !wOn); SC.wake.sync(); draw();
      } }, wOn ? '✓ 화면 켜 두기 (켜짐)' : '화면 켜 두기');
      if (wWhy) wb.disabled = true;
      SC.fill(box, nb, nWhy ? h('p', { class: 'hint' }, nWhy) : null, wb, wWhy ? h('p', { class: 'hint' }, wWhy) : null);
    }
    draw();
    return box;
  }

  function render(d) {
    if (d.status === 'seated' || d.status === 'cancelled') { end(d.status); return; }
    if (!T.pos || !main.contains(T.pos)) buildTicket();
    var called = d.status === 'called';
    if (called) {
      if (prevStatus !== 'called') { showCalled(d); notifyCalled(); }
    } else { calledEl.hidden = true; clearInterval(vibTimer); }
    prevStatus = d.status;
    T.pos.replaceChildren(String(d.position != null ? d.position : '-'), h('small', null, '번째'));
    T.ahead.textContent = d.ahead != null ? (d.ahead === 0 ? '다음이 내 차례예요!' : '내 앞에 ' + d.ahead + '팀') : '';
    T.who.textContent = d.nick + ' · ' + d.size + '명';
    T.total.textContent = d.waitingTotal != null ? '현재 대기 ' + d.waitingTotal + '팀' : '';
    document.title = called ? '입장하세요! · 주점 부스' : (d.position ? '(' + d.position + '번째) 대기 · 주점 부스' : '대기 · 주점 부스');
  }
  function showCalled(d) {
    calledEl.replaceChildren(
      h('h1', { id: 'called-h' }, '입장하세요'),
      h('p', null, d.nick + ' · ' + d.size + '명'),
      h('p', null, '입구 스태프에게 이 화면을 보여 주세요'),
      h('button', { class: 'btn', type: 'button', onclick: function () { calledEl.hidden = true; clearInterval(vibTimer); try { if (navigator.vibrate) navigator.vibrate(0); } catch (e) { /* ignore */ } } }, '확인했어요'));
    calledEl.hidden = false;
  }
  // Chime (+ vibration) every 4 s for up to 2 minutes, or until the guest taps 확인.
  var CHIME_MS = 4000, CHIME_MAX_MS = 120000;
  function notifyCalled() {
    function vib() { try { if (navigator.vibrate) navigator.vibrate([500, 200, 500, 200, 800]); } catch (e) { /* unsupported */ } }
    SC.audio.beep('called'); vib(); SC.flash();
    SC.notif.show('입장하세요!', '대기 순서가 되었어요. 입구로 와 주세요.', 'wait-called');
    clearInterval(vibTimer);
    var t0 = Date.now();
    vibTimer = setInterval(function () {
      if (Date.now() - t0 >= CHIME_MAX_MS || calledEl.hidden) { clearInterval(vibTimer); return; }
      SC.audio.beep('called'); vib();
    }, CHIME_MS);
  }
  function end(kind) {
    stopLive(); save(null); entry = null; T = {}; SC.wake.sync();
    document.title = '주점 부스';
    main.replaceChildren(h('div', { class: 'end' },
      h('h1', { class: 'w-h' }, kind === 'seated' ? '즐거운 시간 보내세요!' : '대기가 취소됐어요'),
      h('p', { class: 'w-sub' }, kind === 'seated' ? '입장해 주셔서 고마워요. 테이블 QR을 찍으면 주문과 게임을 할 수 있어요.' : '다시 기다리고 싶다면 새로 등록해 주세요.'),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: function () { showForm(); } }, '새로 대기 등록')));
  }

  function start() {
    prevStatus = null; T = {}; SC.wake.sync();
    main.replaceChildren(h('p', { class: 'w-sub' }, '순번을 불러오는 중…'));
    live = SC.live({
      sse: '/api/wait/' + entry.id + '/events' + q(), poll: '/api/wait/' + entry.id + q(),
      onState: render,
      onStatus: function (s) { connEl.hidden = false; connEl.dataset.s = s; $('#conn-t').textContent = LBL[s]; },
    });
  }

  // ---------- boot: resume place in line ----------
  var saved = load();
  if (saved) {
    entry = saved;
    SC.api('/api/wait/' + saved.id + q(), { noAuthRedirect: true }).then(function (d) {
      if (d.status === 'seated' || d.status === 'cancelled') { save(null); entry = null; showForm(); } else start();
    }, function (e) {
      if (e.status === 404) { save(null); entry = null; showForm('이전 대기 정보가 만료됐어요. 다시 등록해 주세요.'); } else start();
    });
  } else showForm();
})();

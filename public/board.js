/* Public scoreboard. Live via SSE (polling fallback). All text via textContent. */
(function () {
  'use strict';
  var SC = window.SC, h = SC.h, $ = SC.$;
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var state = null;
  var TITLE = (new URLSearchParams(location.search).get('title') || '').slice(0, 24) || '주점 부스';
  var nf = function (n) { return Number(n || 0).toLocaleString('ko-KR'); };

  $('#title').textContent = TITLE;
  $('#title').appendChild(h('span', null, ' · 게임 랭킹'));
  document.title = '전광판 · ' + TITLE;

  // ---------- FLIP list ----------
  function FlipList(el, mk, fill) { this.el = el; this.mk = mk; this.fill = fill; this.rows = new Map(); }
  FlipList.prototype.update = function (items, key) {
    var self = this, first = new Map(), order = [];
    this.rows.forEach(function (r, k) { first.set(k, r.el.getBoundingClientRect().top); });
    items.forEach(function (it, i) {
      var k = String(key(it)), r = self.rows.get(k), isNew = false;
      if (!r) { r = { el: self.mk(), score: null }; self.rows.set(k, r); isNew = true; }
      var prevScore = r.score;
      r.score = self.fill(r.el, it, i);
      if (!isNew && prevScore != null && r.score > prevScore && !reduce) { r.el.classList.remove('bump'); void r.el.offsetWidth; r.el.classList.add('bump'); }
      r.isNew = isNew; order.push(k);
    });
    this.rows.forEach(function (r, k) { if (order.indexOf(k) < 0) { r.el.remove(); self.rows.delete(k); } });
    order.forEach(function (k) { self.el.appendChild(self.rows.get(k).el); });
    if (reduce) return;
    order.forEach(function (k) {
      var r = self.rows.get(k), f = first.get(k);
      if (r.isNew) { r.el.classList.remove('enter'); void r.el.offsetWidth; r.el.classList.add('enter'); return; }
      var now = r.el.getBoundingClientRect().top;
      if (f != null && Math.abs(f - now) > 1) {
        r.el.style.transition = 'none'; r.el.style.transform = 'translateY(' + (f - now) + 'px)';
        void r.el.offsetWidth;
        r.el.style.transition = 'transform .75s cubic-bezier(.2,.8,.2,1)'; r.el.style.transform = '';
      }
    });
  };

  // hour list rows: rank, "N번", nick, score
  function hourRow() { return h('li', { class: 'rk' }, h('span', { class: 'pos' }), h('span', { class: 'tb' }), h('span', { class: 'nk' }), h('span', { class: 'sc' })); }
  function fillHour(el, r) {
    el.dataset.r = r.rank;
    el.children[0].textContent = r.rank;
    el.children[1].textContent = r.table + '번';
    el.children[2].textContent = r.nick || '';
    el.children[3].textContent = nf(r.score) + '점';
    return r.score;
  }
  var hourList = new FlipList($('#hour-list'), hourRow, fillHour);

  function gameRow() { return h('li', { class: 'rk' }, h('span', { class: 'pos' }), h('span', { class: 'who2' }, h('span', { class: 'tb' }), h('span', { class: 'nk' })), h('span', { class: 'sc' })); }
  function fillGame(el, r, i) {
    el.dataset.r = i + 1;
    el.children[0].textContent = i + 1;
    el.children[1].children[0].textContent = r.table + '번';
    el.children[1].children[1].textContent = r.nick || '';
    el.children[2].textContent = nf(r.score) + '점';
    return r.score;
  }
  var gamePanels = {}; // id -> {panel, title, list}
  function ensureGame(id, label) {
    var g = gamePanels[id];
    if (!g) {
      var title = h('span'), ol = h('ol', { class: 'rklist' });
      g = gamePanels[id] = { el: h('section', { class: 'panel', 'aria-label': label }, h('h2', { class: 'p-title' }, title, h('b', null, 'BEST')), ol), title: title, list: new FlipList(ol, gameRow, fillGame), empty: h('li', { class: 'rk', style: 'justify-content:center;grid-template-columns:1fr;color:var(--muted);font-weight:800;height:4.4rem' }, '첫 도전자를 기다려요') };
      $('#games').appendChild(g.el);
    }
    g.title.textContent = label;
    return g;
  }

  // ---------- leader hero ----------
  var lead = $('#lead'), leadKey = null;
  function renderLead(top, hourly) {
    var key = top ? top.table : 'none';
    var swapped = leadKey !== null && leadKey !== key;
    leadKey = key;
    if (!top) {
      lead.replaceChildren(h('p', { class: 'nobody' }, '아직 도전자가 없어요', h('br'), h('span', null, '지금 1등이 되어 보세요!')));
    } else {
      lead.replaceChildren(h('div', { class: 'lead' + (swapped && !reduce ? ' swap' : '') },
        h('div', { class: 'no', text: top.table }),
        h('div', { class: 'who' }, h('span', { class: 'tb' }, '번 테이블'), top.nick ? h('span', { class: 'nk' }, top.nick) : null, h('span', { class: 'pt' }, h('b', null, nf(top.score)), ' 점'))));
    }
    var pz = $('#prize');
    pz.hidden = !(hourly && hourly.label);
    if (!pz.hidden) pz.replaceChildren('이 시간 1등 테이블 상품 · ', h('b', null, hourly.label));
  }

  function render() {
    var d = state;
    if (!d) return;
    var rank = (d.hour && d.hour.ranking) || [];
    renderLead(rank[0] || null, d.hourly);
    $('#hour-range').textContent = d.hour ? SC.clock(d.hour.start) + ' ~ ' + SC.clock(d.hour.end) : '';
    // hero shows rank 1; the list shows ranks 2..5
    hourList.update(rank.slice(1, 5).map(function (r, i) { return Object.assign({}, r, { rank: i + 2 }); }), function (r) { return r.table; });

    var ids = Object.keys(d.gameInfo || d.games || {});
    $('#games').style.setProperty('--n', Math.max(1, Math.min(ids.length, 3)));
    ids.forEach(function (id) {
      var g = ensureGame(id, (d.gameInfo && d.gameInfo[id] && d.gameInfo[id].label) || id);
      var list = (d.games && d.games[id] || []).slice(0, 5);
      g.list.update(list, function (r) { return r.table; });
      if (!list.length) { if (!g.empty.parentNode) g.list.el.appendChild(g.empty); } else if (g.empty.parentNode) g.empty.remove();
    });
    var pw = d.prevHour && d.prevHour.winner;
    SC.fill($('#prev'), pw ? ['지난 시간 1등 ', h('b', null, pw.table + '번 테이블' + (pw.nick ? ' · ' + pw.nick : '')), d.prevHour.awarded ? ' · 시상 완료' : ''] : []);
    renderStock();
  }

  function renderStock() {
    var list = state && state.rewards;
    var box = $('#stock');
    box.hidden = !(list && list.length);
    if (box.hidden) return;
    SC.fill(box, h('span', { class: 'lab' }, '남은 보상'), list.map(function (r) {
      var left = r.remaining != null ? r.remaining : r.stock;
      return h('span', { class: 'pill' + (left <= 0 ? ' out' : '') }, r.label + ' ', left <= 0 ? '소진' : h('b', null, left + '개'));
    }));
  }

  // ---------- clock ----------
  function tick() {
    if (!state || !state.hour) return;
    var left = Math.max(0, state.hour.end - Date.now());
    var m = Math.floor(left / 60000), s = Math.floor(left / 1000) % 60;
    $('#clock').textContent = String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }
  setInterval(tick, 1000);

  // ---------- connection / chrome ----------
  var connEl = $('#conn');
  var LBL = { live: '실시간', poll: '5초마다 갱신', off: '연결 끊김 · 다시 연결하는 중', wait: '연결 중' };
  function setConn(s) { connEl.dataset.s = s; $('#conn-t').textContent = LBL[s]; }
  var mt = 0;
  document.addEventListener('mousemove', function () { document.body.classList.add('mouse'); clearTimeout(mt); mt = setTimeout(function () { document.body.classList.remove('mouse'); }, 3000); });
  $('#fs').addEventListener('click', function () { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'f' || e.key === 'F') $('#fs').click(); });

  SC.live({ sse: '/api/board/events', poll: '/api/board', onStatus: setConn, onState: function (d) { state = d; render(); tick(); } });
})();

/* COMHERE scoreboard. Live via SSE (polling fallback). All text via textContent. */
(function () {
  'use strict';
  var SC = window.SC, h = SC.h, $ = SC.$;
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var state = null;
  var nf = function (n) { return Number(n || 0).toLocaleString('ko-KR'); };

  document.title = '전광판 · COMHERE';

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
        r.el.style.transition = 'transform .75s steps(8)'; r.el.style.transform = '';
      }
    });
  };

  // row: rank | table | nickname | score
  function rowEl() { return h('li', { class: 'rk' }, h('span', { class: 'pos' }), h('span', { class: 'tb' }), h('span', { class: 'nk' }), h('span', { class: 'sc' })); }
  function fillRow(el, r) {
    el.dataset.r = r.rank;
    el.children[0].textContent = r.rank;
    el.children[1].textContent = r.table + '번';
    el.children[2].textContent = r.nick || '';
    el.children[3].textContent = nf(r.score);
    return r.score;
  }
  var hourList = new FlipList($('#hour-list'), rowEl, fillRow);
  var gamePanels = {};
  function ensureGame(id, label) {
    var g = gamePanels[id];
    if (!g) {
      var gname = h('span', { class: 'gname' }), ol = h('ol', { class: 'rklist' });
      var top = h('span', { class: 'top10' }, 'TOP 10');
      g = gamePanels[id] = { el: h('section', { class: 'game', 'aria-label': label }, h('h2', null, top, gname), ol), gname: gname, top: top, list: new FlipList(ol, rowEl, fillRow), empty: h('li', { class: 'none' }, '첫 도전자를 기다려요') };
      $('#games').appendChild(g.el);
    }
    g.gname.textContent = label;
    g.top.textContent = 'TOP ' + (document.getElementById('games').classList.contains('grid4') ? 5 : 10);
    return g;
  }

  // ---------- leader hero ----------
  var lead = $('#lead'), leadKey = null;
  function renderLead(top, hourly) {
    var key = top ? top.table : 'none';
    var swapped = leadKey !== null && leadKey !== key;
    leadKey = key;
    if (!top) {
      SC.fill(lead, h('p', { class: 'nobody' }, '아직 도전자가 없어요', h('br'), h('span', null, '지금 1등이 되어 보세요!')));
    } else {
      SC.fill(lead, h('div', { class: 'lead' + (swapped && !reduce ? ' swap' : '') },
        h('div', { class: 'no', text: top.table }),
        h('div', { class: 'who' }, h('span', { class: 'tb' }, '번 테이블'), top.nick ? h('span', { class: 'nk' }, top.nick) : null, h('span', { class: 'pt' }, h('b', null, nf(top.score)), '점'))));
    }
    var pz = $('#prize');
    pz.hidden = !(hourly && hourly.label && hourly.enabled !== false);
    if (!pz.hidden) SC.fill(pz, '이 시간 1등 테이블 상품 · ', hourly.label);
  }

  function render() {
    var d = state;
    if (!d) return;
    var rank = (d.hour && d.hour.ranking) || [];
    renderLead(rank[0] || null, d.hourly);
    $('#hour-range').textContent = d.hour ? SC.clock(d.hour.start) + '~' + SC.clock(d.hour.end) : '';
    hourList.update(rank.slice(1, 5).map(function (r, i) { return Object.assign({}, r, { rank: i + 2 }); }), function (r) { return r.table; });

    var all = Object.keys(d.gameInfo || d.games || {});
    // two panels fit a projector: the games that have scores (fall back to the first two)
    var withScores = all.filter(function (id) { return d.games && d.games[id] && d.games[id].length; });
    var four = withScores.length > 2;
    var ids = (withScores.length ? withScores : all).slice(0, four ? 4 : 2);
    var topN = four ? 5 : 10;
    $('#games').classList.toggle('grid4', four);
    Object.keys(gamePanels).forEach(function (id) { if (ids.indexOf(id) < 0) { gamePanels[id].el.remove(); delete gamePanels[id]; } });
    ids.forEach(function (id) {
      var g = ensureGame(id, (d.gameInfo && d.gameInfo[id] && d.gameInfo[id].label) || id);
      var list = (d.games && d.games[id] || []).slice(0, topN).map(function (r, i) { return Object.assign({}, r, { rank: r.rank || i + 1 }); });
      g.list.update(list, function (r) { return r.table; });
      if (!list.length) { if (!g.empty.parentNode) g.list.el.appendChild(g.empty); } else if (g.empty.parentNode) g.empty.remove();
    });
    var pw = d.prevHour && d.prevHour.winner;
    SC.fill($('#prev'), pw ? ['지난 시간 1등 ', h('b', null, pw.table + '번 테이블' + (pw.nick ? ' · ' + pw.nick : '')), d.prevHour.awarded ? ' · 시상 완료' : ''] : null);
    renderStock();
    renderTicker();
  }

  function renderStock() {
    var list = state && state.rewards;
    var box = $('#stock');
    box.hidden = !(list && list.length);
    if (box.hidden) return;
    SC.fill(box, list.map(function (r) {
      var left = r.remaining != null ? r.remaining : r.stock, total = r.stock || 0;
      var on = total > 0 ? Math.min(10, Math.ceil(left / total * 10)) : 0;
      var segs = []; for (var i = 0; i < 10; i++) segs.push(h('i', { class: i < on ? 'on' : '' }));
      return h('div', { class: 'stock' + (left <= 0 ? ' out' : left / (total || 1) <= 0.2 ? ' low' : '') },
        h('span', { class: 'lab' }, r.label), h('span', { class: 'y2k-progress', role: 'img', 'aria-label': r.label + ' 남은 수량 ' + left + '개' }, segs), h('span', { class: 'n' }, left <= 0 ? '소진' : left + '개'));
    }));
  }

  // ticker: staff notice (server payload only, never the URL) + call to action + the hourly prize
  var lastTicker = '', warnIcon = null;
  function renderTicker() {
    var parts = [], n = state && state.notice && state.notice.text ? state.notice : null;
    if (n) parts.push(n.text);
    parts.push('QR 찍고 도전!');
    parts.push('테이블 QR로 게임하고 쿠폰을 받아 가세요');
    if (state && state.hourly && state.hourly.label && state.hourly.enabled !== false) parts.push('매 정시 1등 테이블에게 ' + state.hourly.label);
    var t = (n && n.level === 'warn' ? 'W|' : '') + parts.join('   ★   ');
    if (t !== lastTicker) {
      lastTicker = t;
      var tk = $('#ticker');
      tk.textContent = parts.join('   ★   ');
      if (n && n.level === 'warn') {
        var ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg'), use = document.createElementNS(ns, 'use');
        svg.setAttribute('class', 'y2k-i b-warn'); svg.setAttribute('aria-hidden', 'true');
        use.setAttribute('href', SC.BASE + '/static/brand/icons.svg#i-warning'); svg.appendChild(use);
        tk.insertBefore(svg, tk.firstChild);
      }
    }
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

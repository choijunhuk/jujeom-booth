/* QR print page: print all / selected / one card, save card or QR as PNG (all local). */
(function () {
  'use strict';
  var SC = window.SC, h = SC.h, $ = SC.$, common = window.PrintCommon;
  var data = null, sig = '', sel = new Set(), cells = {}, shell = null, gate = null, running = false;
  var FONT = 'system-ui, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';

  function cardList(d) {
    var list = [{ key: 'wait', label: '입구', big: '대기', cls: 'w', url: common.absoluteUrl(d.waitUrl), caption: 'QR 찍고 대기 등록', sub: '자리가 나면 알려 드려요', file: 'booth-wait', title: '입구 대기' }];
    common.tableLinks(d).forEach(function (t) {
      list.push({ key: String(t.number), label: '테이블', big: String(t.number), cls: 'd' + Math.min(3, String(t.number).length), url: t.url, caption: 'QR 찍고 주문 · 게임', sub: '쿠폰도 받아 가세요', file: 'booth-table-' + t.number, title: t.number + '번 테이블' });
    });
    return list;
  }

  // ---------- DOM card ----------
  function cardEl(c) {
    var box = h('div', { class: 'qrbox', role: 'img', 'aria-label': c.caption + ' QR 코드' });
    box.innerHTML = QR.svg(c.url, { margin: 4 }); // SVG built locally by our own encoder; no user text is interpolated. 4-module quiet zone.
    return h('div', { class: 'card' }, h('div', { class: 'win' },
      h('div', { class: 'tbar' }, h('img', { src: SC.BASE + '/static/brand/coms-logo.svg', alt: '' }), h('span', { class: 'tt' }, 'COMHERE.exe'), h('span', { class: 'tb3', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'))),
      h('div', { class: 'id' }, h('span', { class: 'l' }, c.label), h('span', { class: 'n ' + c.cls }, c.big)),
      box,
      h('div', { class: 'cap' }, c.caption),
      h('div', { class: 'sub' }, c.sub),
      h('div', { class: 'foot' }, "COM's")));
  }

  // ---------- PNG rendering (canvas, white background) ----------
  function drawQR(ctx, text, x, y, box, quiet) {
    var q = QR.encode(text), mods = q.size + quiet * 2, m = box / mods;
    ctx.fillStyle = '#000';
    for (var r = 0; r < q.size; r++) for (var col = 0; col < q.size; col++) {
      if (q.get(col, r)) {
        var x0 = Math.round(x + (col + quiet) * m), y0 = Math.round(y + (r + quiet) * m);
        ctx.fillRect(x0, y0, Math.round(x + (col + quiet + 1) * m) - x0, Math.round(y + (r + quiet + 1) * m) - y0);
      }
    }
  }
  function text(ctx, str, x, y, mm, s, weight, color) {
    ctx.font = weight + ' ' + (mm * s) + 'px ' + FONT;
    ctx.fillStyle = color || '#000';
    ctx.fillText(str, x * s, y * s);
  }
  var logoImg = null;
  function loadLogo() {
    if (logoImg) return Promise.resolve(logoImg);
    return new Promise(function (res) { var i = new Image(); i.onload = function () { logoImg = i; res(i); }; i.onerror = function () { res(null); }; i.src = SC.BASE + '/static/brand/coms-logo.svg'; });
  }
  // Card PNG: same layout as the printed card. The bitmap font is used only for the 16px title bar text (no digits in it).
  function cardCanvas(c) {
    var fontsReady = document.fonts && document.fonts.load ? Promise.all([document.fonts.load('16px NeoDgm'), document.fonts.ready]) : Promise.resolve();
    return Promise.all([fontsReady, loadLogo()]).then(function (r) {
      var logo = r[1];
      var W = 1200, s = W / 95, H = Math.round(138 * s), k = s / 3.7795;
      function fpx(css) { return Math.max(16, Math.round(css * k / 16) * 16); }
      var PIX = '"NeoDgm", "Apple SD Gothic Neo", "Noto Sans KR", monospace', UI = 'system-ui, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';
      var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
      var ctx = cv.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
      // mm layout mirrors qr.html: 3 mm margin, window 89 x 132, rows 24px bar / 30 id / 72 QR / 9 caption / 6.5 sub / foot
      var wx = 3, wy = 3, ww = 89, wh = 132, tb = 24 / 3.7795, cx = wx + ww / 2;
      ctx.strokeStyle = '#000'; ctx.lineWidth = 2 * k; ctx.strokeRect(wx * s + ctx.lineWidth / 2, wy * s + ctx.lineWidth / 2, ww * s - ctx.lineWidth, wh * s - ctx.lineWidth);
      ctx.fillStyle = '#000'; ctx.fillRect(wx * s, wy * s, ww * s, tb * s);
      var lx = (wx + 1.6) * s;
      if (logo) { // black logo recoloured white
        var lh = 4.2 * s, lw = lh * logo.naturalWidth / logo.naturalHeight, t = document.createElement('canvas'); t.width = Math.ceil(lw); t.height = Math.ceil(lh);
        var tc = t.getContext('2d'); tc.drawImage(logo, 0, 0, t.width, t.height); tc.globalCompositeOperation = 'source-in'; tc.fillStyle = '#fff'; tc.fillRect(0, 0, t.width, t.height);
        ctx.drawImage(t, lx, (wy + (tb - 4.2) / 2) * s); lx += lw + 1.4 * s;
      }
      ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.fillStyle = '#fff'; ctx.font = fpx(16) + 'px ' + PIX;
      ctx.fillText('COMHERE.exe', lx, (wy + tb / 2) * s + 2);
      for (var i = 0; i < 3; i++) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.5 * k; var bx = (wx + ww - 2 - (3 - i) * 3.1) * s; ctx.strokeRect(bx, (wy + tb / 2 - 1.2) * s, 2.4 * s, 2.4 * s); }
      // label + big number on one baseline, centred as a pair
      var idTop = wy + tb, base = (idTop + 24) * s, gap = 3 * s;
      var css = c.cls === 'w' ? 80 : c.cls === 'd3' ? 88 : 108;
      var lf = '800 ' + Math.round(7 * s) + 'px ' + UI, nf = '900 ' + Math.round(css * k) + 'px ' + UI; // digits use the bold system face: the bitmap font's 4 reads as 9
      ctx.font = lf; var lwid = ctx.measureText(c.label).width;
      ctx.font = nf; var nwid = ctx.measureText(c.big).width;
      var x0 = cx * s - (lwid + gap + nwid) / 2;
      ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left'; ctx.fillStyle = '#000';
      ctx.font = lf; ctx.fillText(c.label, x0, base);
      ctx.font = nf; ctx.fillText(c.big, x0 + lwid + gap, base);
      var qy = idTop + 30;
      drawQR(ctx, c.url, (cx - 36) * s, qy * s, 72 * s, 4);
      ctx.textAlign = 'center';
      ctx.font = '900 ' + Math.round(6 * s) + 'px ' + UI; ctx.fillText(c.caption, cx * s, (qy + 72 + 8.4) * s);
      ctx.textBaseline = 'middle';
      ctx.font = '700 ' + Math.round(4 * s) + 'px ' + UI; ctx.fillText(c.sub, cx * s, (qy + 72 + 9 + 3.25) * s);
      ctx.font = '700 ' + Math.round(11 * k) + 'px ' + UI; ctx.fillText("COM's", cx * s, (qy + 72 + 9 + 6.5 + (wy + wh - (qy + 72 + 15.5)) / 2) * s);
      ctx.strokeStyle = '#888'; ctx.lineWidth = 3; ctx.setLineDash([14, 10]); ctx.strokeRect(2, 2, W - 4, H - 4); ctx.setLineDash([]); // cut line
      return cv;
    });
  }
  function qrCanvas(c) {
    var cv = document.createElement('canvas'); cv.width = 1000; cv.height = 1000;
    var ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 1000, 1000);
    var mods = QR.encode(c.url).size + 8, m = Math.floor(1000 / mods), box = m * mods, off = Math.floor((1000 - box) / 2);
    drawQR(ctx, c.url, off, off, box, 4);
    return cv;
  }
  function save(cv, name) {
    return new Promise(function (resolve, reject) {
      cv.toBlob(function (blob) {
        if (!blob) { reject(new Error('이미지를 만들지 못했어요.')); return; }
        var url = URL.createObjectURL(blob);
        var a = h('a', { href: url, download: name, style: 'display:none' });
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
        resolve();
      }, 'image/png');
    });
  }

  // ---------- clipboard ----------
  function copy(str) {
    function fallback() {
      var ta = h('textarea', { style: 'position:fixed;left:-999px;top:0' }); ta.value = str;
      document.body.appendChild(ta); ta.select();
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      ta.remove(); return ok;
    }
    var p = navigator.clipboard && window.isSecureContext ? navigator.clipboard.writeText(str).then(function () { return true; }, fallback) : Promise.resolve(fallback());
    return p.then(function (ok) { SC.toast(ok ? '주소를 복사했어요' : '복사하지 못했어요. 주소를 길게 눌러 복사해 주세요.', ok ? 'ok' : 'error'); });
  }

  // ---------- printing ----------
  function doPrint(cls, cell) {
    document.body.classList.add(cls);
    if (cell) cell.classList.add('one');
    function done() { document.body.classList.remove(cls); if (cell) cell.classList.remove('one'); window.removeEventListener('afterprint', done); }
    window.addEventListener('afterprint', done);
    window.print();
  }

  // ---------- page ----------
  var bar = {};
  function buildBar() {
    bar.all = h('button', { class: 'btn btn-primary', type: 'button', onclick: function () { doPrint('print-all'); } }, '전체 인쇄');
    bar.sel = h('button', { class: 'btn', type: 'button', onclick: function () { doPrint('print-sel'); } }, '선택한 것만 인쇄');
    bar.count = h('span', { class: 'muted', role: 'status' });
    var morePanel = h('div', { class: 'more-panel' },
      h('button', { class: 'btn', type: 'button', onclick: function () { setAll(true); } }, '전체 선택'),
      h('button', { class: 'btn', type: 'button', onclick: function () { setAll(false); } }, '선택 해제'));
    var moreBtn = h('button', { class: 'btn more-btn', type: 'button', 'aria-expanded': 'false', onclick: function () {
      var open = morePanel.classList.toggle('open'); moreBtn.setAttribute('aria-expanded', open ? 'true' : 'false'); } }, '더보기');
    SC.fill($('#bar'), h('h2', null, 'QR 인쇄'), bar.count, moreBtn, bar.sel, bar.all, morePanel);
  }
  function syncBar() {
    bar.sel.disabled = !sel.size; bar.all.disabled = !data;
    bar.count.textContent = '선택 ' + sel.size + '장';
    Object.keys(cells).forEach(function (k) { cells[k].el.classList.toggle('sel', sel.has(k)); cells[k].box.checked = sel.has(k); });
  }
  function setAll(on) { sel = new Set(on ? Object.keys(cells) : []); syncBar(); }

  function render(d) {
    var list = cardList(d), s = JSON.stringify(list.map(function (c) { return [c.key, c.url]; }));
    if (s === sig) return;
    sig = s; cells = {};
    var keep = new Set(); list.forEach(function (c) { if (sel.has(c.key)) keep.add(c.key); }); sel = keep;
    var els = list.map(function (c) {
      var box = h('input', { type: 'checkbox', 'aria-label': c.title + ' 선택', onchange: function () { if (box.checked) sel.add(c.key); else sel.delete(c.key); syncBar(); } });
      var el = h('div', { class: 'cell', dataset: { key: c.key } },
        h('label', { class: 'pick noprint' }, box, c.title),
        cardEl(c),
        h('div', { class: 'urlline noprint' }, c.url),
        h('div', { class: 'acts noprint' },
          h('button', { class: 'btn btn-sm', type: 'button', onclick: function () { copy(c.url); } }, '주소 복사'),
          h('button', { class: 'btn btn-sm', type: 'button', onclick: function () { doPrint('print-one', el); } }, '이 카드만 인쇄'),
          h('button', { class: 'btn btn-sm', type: 'button', onclick: function (e) { SC.act(e.currentTarget, function () { return cardCanvas(c).then(function (cv) { return save(cv, c.file + '.png'); }); }, '이미지를 저장했어요'); } }, '이미지 저장'),
          h('button', { class: 'btn btn-sm', type: 'button', onclick: function (e) { SC.act(e.currentTarget, function () { return save(qrCanvas(c), c.file + '-qr.png'); }, 'QR 이미지를 저장했어요'); } }, 'QR만 저장'),
          c.key === 'wait' ? null : h('button', { class: 'btn btn-sm btn-danger', type: 'button', onclick: function (e) {
            var btn = e.currentTarget;
            SC.confirm({ title: c.title + ' QR을 재발급할까요?', danger: true, ok: 'QR 재발급', cancel: '돌아가기', message: '이 테이블의 기존 QR은 더 이상 쓸 수 없게 됩니다. 인쇄물을 다시 뽑아야 해요.' }).then(function (ok) {
              if (!ok) return;
              SC.act(btn, function () {
                return SC.api('/api/staff/tables/' + c.key + '/rotate', { body: {} }).then(function () { sig = ''; return load(); });
              }, c.title + ' QR을 새로 만들었어요. 새 QR 카드를 다시 인쇄해 주세요.');
            });
          } }, 'QR 재발급')));
      cells[c.key] = { el: el, box: box };
      return el;
    });
    $('#cards').replaceChildren.apply($('#cards'), els);
    var info = [h('p', { class: 'muted' }, '카드 ' + list.length + '장 (대기 1 + 테이블 ' + d.tables.length + '). 접지 않는 한 면 카드예요. 바깥 점선을 따라 잘라 코팅하세요 (A6 코팅지·A6 아크릴 꽂이에 맞는 크기). 무광 코팅이면 조명 반사가 적어 QR이 더 잘 찍혀요. 인쇄 설정에서 배율 100%(실제 크기), A4 세로로 인쇄하세요. 한 장에 4개씩 나와요.')];
    var warning = common.originWarning(d);
    if (warning) info.push(h('div', { class: 'warn' }, warning));
    SC.fill($('#info'), info);
    syncBar();
  }

  function load() {
    return SC.api('/api/staff/tables').then(function (d) { data = d; if (shell) shell.conn.set('live'); render(d); }, function (e) { if (shell && e.status !== 401) shell.conn.set('off'); if (e.status !== 401) SC.toast(e.message, 'error'); });
  }
  function start() {
    var app = $('#app');
    if (!shell) {
      shell = SC.shell({ page: 'qr', label: 'QR 인쇄', kinds: ['order'], onLogout: function () { gate.logout(); } });
      app.insertBefore(SC.audioStrip(), app.firstChild);
      app.insertBefore(shell.el, $('#main'));
      buildBar(); syncBar();
    }
    running = true; sig = '';
    load();
  }
  function stop() { running = false; data = null; document.querySelectorAll('dialog[open]').forEach(function (d) { d.close(); }); }
  // table list can change at runtime (new count / re-issued QR): refresh periodically and when the tab returns
  setInterval(function () { if (running && document.visibilityState === 'visible') load(); }, 15000);
  document.addEventListener('visibilitychange', function () { if (running && document.visibilityState === 'visible') load(); });
  gate = SC.gate({ app: $('#app'), start: start, stop: stop, where: 'QR 인쇄' });
})();

/* QR print page: print all / selected / one card, save card or QR as PNG (all local). */
(function () {
  'use strict';
  var SC = window.SC, h = SC.h, $ = SC.$;
  var data = null, sig = '', sel = new Set(), cells = {}, shell = null, gate = null, running = false;
  var FONT = 'system-ui, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif';

  function abs(u) { return /^https?:\/\//i.test(u) ? u : location.origin + u; }
  function cardList(d) {
    var list = [{ key: 'wait', label: '입구', big: '대기', cls: 'w', url: abs(d.waitUrl), caption: 'QR 찍고 대기 등록', sub: '자리가 나면 알려 드려요', file: 'booth-wait', title: '입구 대기' }];
    d.tables.slice().sort(function (a, b) { return a.number - b.number; }).forEach(function (t) {
      list.push({ key: String(t.number), label: '테이블', big: String(t.number), cls: 'd' + Math.min(3, String(t.number).length), url: abs(t.url), caption: 'QR 찍고 주문 · 게임', sub: '쿠폰도 받아 가세요', file: 'booth-table-' + t.number, title: t.number + '번 테이블' });
    });
    return list;
  }

  // ---------- DOM card ----------
  function half(c, flip) {
    var box = h('div', { class: 'qrbox', role: 'img', 'aria-label': c.caption + ' QR 코드' });
    box.innerHTML = QR.svg(c.url, { margin: 4 }); // SVG built locally by our own encoder; no user text is interpolated. 4-module quiet zone.
    return h('div', { class: 'half' + (flip ? ' flip' : '') }, h('div', { class: 'win' },
      h('div', { class: 'tbar' }, h('img', { src: SC.BASE + '/static/brand/coms-logo.svg', alt: '' }), h('span', { class: 'tt' }, 'COMHERE.exe'), h('span', { class: 'tb3', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'))),
      h('div', { class: 'hbody' }, h('div', { class: 'id' }, h('span', { class: 'l' }, c.label), h('span', { class: 'n ' + c.cls }, c.big)), box),
      h('div', { class: 'cap' }, c.caption),
      h('div', { class: 'foot' }, "COM's")));
  }
  function cardEl(c) {
    return h('div', { class: 'card' }, half(c, true), h('div', { class: 'fold', 'aria-hidden': 'true' }, h('span', null, '접는 선')), half(c, false));
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
  // Card PNG: same layout as the printed card. The bitmap font is drawn only at multiples of 16px (brand rule).
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
      function bottomHalf() { // one half, drawn at y 69..138 mm; the top half is this rotated 180 degrees about the card centre
        var oy = 69, wx = 3, wy = oy + 3, ww = 89, wh = 63, tb = 6.4;
        ctx.fillStyle = '#fff'; ctx.fillRect(wx * s, wy * s, ww * s, wh * s);
        ctx.strokeStyle = '#000'; ctx.lineWidth = 0.55 * k; ctx.strokeRect(wx * s + ctx.lineWidth / 2, wy * s + ctx.lineWidth / 2, ww * s - ctx.lineWidth, wh * s - ctx.lineWidth);
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
        var cx = 26.5, cy = wy + tb + 20;
        ctx.textAlign = 'center'; ctx.fillStyle = '#000';
        ctx.font = '800 ' + Math.round(14 * k) + 'px ' + UI; ctx.fillText(c.label, cx * s, (wy + tb + 3.4) * s);
        var css = c.cls === 'w' ? 64 : c.cls === 'd1' ? 128 : c.cls === 'd2' ? 96 : 64;
        if (c.cls === 'w') ctx.font = '900 ' + Math.round(60 * k) + 'px ' + UI; else ctx.font = fpx(css) + 'px ' + PIX; // Korean words use the system font; only digits use the bitmap font
        ctx.fillText(c.big, cx * s, (oy + 33.5) * s);
        drawQR(ctx, c.url, 48 * s, (wy + tb + 2.2) * s, 42 * s, 4);
        ctx.font = '900 ' + Math.round(5.4 * s) + 'px ' + UI; ctx.fillText(c.caption, (wx + ww / 2) * s, (oy + 58.4) * s);
        ctx.font = '700 ' + Math.round(11 * k) + 'px ' + UI; ctx.fillText("COM's", (wx + ww / 2) * s, (oy + 63.6) * s);
      }
      bottomHalf();
      ctx.save(); ctx.translate(W, H); ctx.rotate(Math.PI); bottomHalf(); ctx.restore();
      ctx.strokeStyle = '#888'; ctx.lineWidth = 3; ctx.setLineDash([14, 10]);
      ctx.beginPath(); ctx.moveTo(0, 69 * s); ctx.lineTo(W, 69 * s); ctx.stroke();
      ctx.strokeRect(2, 2, W - 4, H - 4);
      ctx.setLineDash([]); ctx.fillStyle = '#fff'; ctx.fillRect(W / 2 - 4 * s, 69 * s - 1.8 * s, 8 * s, 3.6 * s);
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#666'; ctx.font = Math.round(2.4 * s) + 'px ' + UI; ctx.fillText('접는 선', W / 2, 69 * s);
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
    var info = [h('p', { class: 'muted' }, '카드 ' + list.length + '장 (대기 1 + 테이블 ' + d.tables.length + '). 가운데 점선으로 접어 세우면 양쪽 손님이 읽을 수 있어요. 인쇄 설정에서 배율 100%(실제 크기), A4 세로로 인쇄하세요. 한 장에 4개씩 나와요.')];
    if (!d.origin) info.push(h('div', { class: 'warn' }, '서버에 PUBLIC_ORIGIN이 설정되어 있지 않아 지금 열린 주소(' + location.origin + ')로 QR을 만들었어요. 실제 행사 주소에서 이 페이지를 열어 인쇄해야 손님 휴대폰에서 열려요.'));
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

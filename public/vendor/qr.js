/* Minimal QR Code encoder: byte mode, error correction level M, versions 1-40, auto mask.
   Original implementation for this project (no third-party code).
   API: QR.encode(text) -> { size, get(x, y) }   QR.svg(text, {margin}) -> SVG string */
(function (root) {
  'use strict';
  // Level M tables, index = version (0 unused).
  var ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
  var NUM_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
  var FORMAT_M = 0; // 2-bit indicator for level M is 00

  function rawModules(v) {
    var r = (16 * v + 128) * v + 64;
    if (v >= 2) {
      var n = Math.floor(v / 7) + 2;
      r -= (25 * n - 10) * n - 55;
      if (v >= 7) r -= 36;
    }
    return r;
  }
  function dataCodewords(v) {
    return Math.floor(rawModules(v) / 8) - ECC_PER_BLOCK[v] * NUM_BLOCKS[v];
  }

  // GF(256) Reed-Solomon, poly 0x11D
  function rsDivisor(deg) {
    var res = [];
    for (var i = 0; i < deg - 1; i++) res.push(0);
    res.push(1);
    var root = 1;
    for (var i2 = 0; i2 < deg; i2++) {
      for (var j = 0; j < res.length; j++) {
        res[j] = gmul(res[j], root);
        if (j + 1 < res.length) res[j] ^= res[j + 1];
      }
      root = gmul(root, 2);
    }
    return res;
  }
  function gmul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }
  function rsRemainder(data, div) {
    var res = div.map(function () { return 0; });
    data.forEach(function (b) {
      var f = b ^ res.shift();
      res.push(0);
      div.forEach(function (c, i) { res[i] ^= gmul(c, f); });
    });
    return res;
  }

  function utf8(str) {
    var out = [];
    var bytes = unescape(encodeURIComponent(str));
    for (var i = 0; i < bytes.length; i++) out.push(bytes.charCodeAt(i));
    return out;
  }

  function buildCodewords(bytes, v) {
    var bits = [];
    function put(val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
    put(4, 4); // byte mode
    put(bytes.length, v < 10 ? 8 : 16);
    bytes.forEach(function (b) { put(b, 8); });
    var cap = dataCodewords(v) * 8;
    put(0, Math.min(4, cap - bits.length));
    while (bits.length % 8) bits.push(0);
    for (var pad = 0xEC; bits.length < cap; pad ^= 0xEC ^ 0x11) put(pad, 8);
    var data = [];
    for (var i = 0; i < bits.length; i += 8) {
      var b = 0;
      for (var j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      data.push(b);
    }
    // split into blocks, add ECC, interleave
    var nb = NUM_BLOCKS[v], el = ECC_PER_BLOCK[v];
    var raw = Math.floor(rawModules(v) / 8);
    var shortBlocks = nb - (raw % nb);
    var shortLen = Math.floor(raw / nb) - el;
    var div = rsDivisor(el);
    var blocks = [];
    for (var k = 0, off = 0; k < nb; k++) {
      var len = shortLen + (k < shortBlocks ? 0 : 1);
      var d = data.slice(off, off + len);
      off += len;
      var ecc = rsRemainder(d, div);
      if (k < shortBlocks) d.push(0); // placeholder so columns line up
      blocks.push(d.concat(ecc));
    }
    var out = [];
    for (var c = 0; c < blocks[0].length; c++) {
      for (var bi = 0; bi < blocks.length; bi++) {
        if (c !== shortLen || bi >= shortBlocks) out.push(blocks[bi][c]);
      }
    }
    return out;
  }

  function encode(text) {
    var bytes = utf8(String(text));
    var v = 1;
    for (; ; v++) {
      if (v > 40) throw new Error('QR: text too long');
      var capBits = dataCodewords(v) * 8;
      if (4 + (v < 10 ? 8 : 16) + bytes.length * 8 <= capBits) break;
    }
    var codewords = buildCodewords(bytes, v);
    var size = v * 4 + 17;
    var m = [], fn = [];
    for (var y = 0; y < size; y++) { m.push(new Array(size).fill(false)); fn.push(new Array(size).fill(false)); }
    function setFn(x, y2, dark) {
      if (x < 0 || y2 < 0 || x >= size || y2 >= size) return;
      m[y2][x] = dark; fn[y2][x] = true;
    }
    // timing
    for (var i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
    // finders + separators
    [[3, 3], [size - 4, 3], [3, size - 4]].forEach(function (p) {
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var dist = Math.max(Math.abs(dx), Math.abs(dy));
        setFn(p[0] + dx, p[1] + dy, dist !== 2 && dist !== 4);
      }
    });
    // alignment
    var pos = [];
    if (v > 1) {
      var n = Math.floor(v / 7) + 2;
      var step = v === 32 ? 26 : Math.ceil((v * 4 + 4) / (n * 2 - 2)) * 2;
      pos = [6];
      for (var q = size - 7; pos.length < n; q -= step) pos.splice(1, 0, q);
    }
    pos.forEach(function (ax, ai) {
      pos.forEach(function (ay, aj) {
        if ((ai === 0 && aj === 0) || (ai === 0 && aj === pos.length - 1) || (ai === pos.length - 1 && aj === 0)) return;
        for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) setFn(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      });
    });
    // reserve format + version areas
    function drawFormat(mask) {
      var data = (FORMAT_M << 3) | mask;
      var rem = data;
      for (var i2 = 0; i2 < 10; i2++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      var bits = ((data << 10) | rem) ^ 0x5412;
      function bit(k) { return ((bits >>> k) & 1) !== 0; }
      for (var a = 0; a <= 5; a++) setFn(8, a, bit(a));
      setFn(8, 7, bit(6)); setFn(8, 8, bit(7)); setFn(7, 8, bit(8));
      for (var b = 9; b < 15; b++) setFn(14 - b, 8, bit(b));
      for (var c = 0; c < 8; c++) setFn(size - 1 - c, 8, bit(c));
      for (var d = 8; d < 15; d++) setFn(8, size - 15 + d, bit(d));
      setFn(8, size - 8, true);
    }
    drawFormat(0);
    if (v >= 7) {
      var rem = v;
      for (var i3 = 0; i3 < 12; i3++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      var vbits = (v << 12) | rem;
      for (var k = 0; k < 18; k++) {
        var bt = ((vbits >>> k) & 1) !== 0;
        var a2 = size - 11 + (k % 3), b2 = Math.floor(k / 3);
        setFn(a2, b2, bt); setFn(b2, a2, bt);
      }
    }
    // place data (zigzag)
    var idx = 0, total = codewords.length * 8;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j;
          var up = ((right + 1) & 2) === 0;
          var yy = up ? size - 1 - vert : vert;
          if (!fn[yy][x] && idx < total) {
            m[yy][x] = ((codewords[idx >>> 3] >>> (7 - (idx & 7))) & 1) !== 0;
            idx++;
          }
        }
      }
    }
    // choose mask by penalty
    var maskFns = [
      function (x, y2) { return (x + y2) % 2 === 0; },
      function (x, y2) { return y2 % 2 === 0; },
      function (x) { return x % 3 === 0; },
      function (x, y2) { return (x + y2) % 3 === 0; },
      function (x, y2) { return (Math.floor(x / 3) + Math.floor(y2 / 2)) % 2 === 0; },
      function (x, y2) { return x * y2 % 2 + x * y2 % 3 === 0; },
      function (x, y2) { return (x * y2 % 2 + x * y2 % 3) % 2 === 0; },
      function (x, y2) { return ((x + y2) % 2 + x * y2 % 3) % 2 === 0; },
    ];
    function applyMask(k) {
      for (var yy2 = 0; yy2 < size; yy2++) for (var xx = 0; xx < size; xx++) if (!fn[yy2][xx] && maskFns[k](xx, yy2)) m[yy2][xx] = !m[yy2][xx];
    }
    function penalty() {
      var res = 0, dark = 0;
      function runs(get) {
        for (var a = 0; a < size; a++) {
          var prev = get(a, 0), cnt = 1;
          for (var b = 1; b < size; b++) {
            if (get(a, b) === prev) cnt++; else { if (cnt >= 5) res += cnt - 2; prev = get(a, b); cnt = 1; }
          }
          if (cnt >= 5) res += cnt - 2;
          // finder-like pattern 1:1:3:1:1 with 4 light on a side
          var s = '';
          for (var c = 0; c < size; c++) s += get(a, c) ? '1' : '0';
          var re = /(?=(00001011101|10111010000))/g, mt;
          while ((mt = re.exec(s))) { res += 40; re.lastIndex = mt.index + 1; }
        }
      }
      runs(function (a, b) { return m[a][b]; });
      runs(function (a, b) { return m[b][a]; });
      for (var y2 = 0; y2 < size; y2++) for (var x2 = 0; x2 < size; x2++) {
        if (m[y2][x2]) dark++;
        if (x2 + 1 < size && y2 + 1 < size && m[y2][x2] === m[y2][x2 + 1] && m[y2][x2] === m[y2 + 1][x2] && m[y2][x2] === m[y2 + 1][x2 + 1]) res += 3;
      }
      var tot = size * size;
      res += (Math.ceil(Math.abs(dark * 20 - tot * 10) / tot) - 1) * 10;
      return res;
    }
    var best = 0, bestP = Infinity;
    for (var mk = 0; mk < 8; mk++) {
      applyMask(mk);
      drawFormat(mk);
      var p = penalty();
      if (p < bestP) { bestP = p; best = mk; }
      applyMask(mk); // undo
    }
    applyMask(best);
    drawFormat(best);
    return { size: size, version: v, mask: best, get: function (x, y2) { return m[y2][x]; } };
  }

  function svg(text, opts) {
    var margin = opts && opts.margin != null ? opts.margin : 4;
    var q = encode(text);
    var n = q.size + margin * 2;
    var d = '';
    for (var y = 0; y < q.size; y++) {
      var x = 0;
      while (x < q.size) {
        if (q.get(x, y)) {
          var s = x;
          while (x < q.size && q.get(x, y)) x++;
          d += 'M' + (s + margin) + ' ' + (y + margin) + 'h' + (x - s) + 'v1h-' + (x - s) + 'z';
        } else x++;
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n + '" shape-rendering="crispEdges" role="img">' +
      '<rect width="' + n + '" height="' + n + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
  }

  var api = { encode: encode, svg: svg };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.QR = api;
})(typeof window !== 'undefined' ? window : this);

'use strict';

// MacroDroid webhook parameters land in shared variables, so calls must stay serial and spaced.
function createSmsSender({ fetchFn = fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), nowFn = Date.now } = {}) {
  let tail = Promise.resolve(), pending = 0, lastStart = null;
  function send(targetFn, id, timeoutMs) {
    if (pending >= 50) return Promise.resolve({ ok: false, error: 'queue_full' });
    pending++;
    return new Promise((resolve) => {
      const controller = new AbortController();
      let settled = false;
      const finish = (result) => { if (!settled) { settled = true; resolve(result); } };
      const timer = timeoutMs == null ? null : setTimeout(() => { controller.abort(); finish({ ok: false, error: 'TimeoutError' }); }, timeoutMs);
      tail = tail.then(async () => {
        try {
          if (settled) return;
          while (!settled && lastStart !== null && nowFn() - lastStart < 2500) await sleep(2500 - (nowFn() - lastStart));
          if (settled) return;
          const target = targetFn();
          if (!target) { finish({ skipped: true }); return; }
          const url = new URL(target.url);
          url.search = new URLSearchParams({ phone: target.phone, msg: target.msg }).toString();
          lastStart = nowFn();
          const res = await fetchFn(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.any([AbortSignal.timeout(5000), controller.signal]) });
          await res.body?.cancel().catch(() => {});
          finish(res.status >= 200 && res.status < 300 ? { ok: true } : { ok: false, error: String(res.status) });
        } catch (e) {
          const name = /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(e?.name || '') ? e.name : 'Error';
          finish({ ok: false, error: name });
        } finally {
          if (timer) clearTimeout(timer);
          pending--;
        }
      });
    });
  }
  return { send };
}

module.exports = { createSmsSender };

// Stale-deploy recovery guard. Extracted from an inline <script> in index.html
// so the Content-Security-Policy can keep `script-src 'self'` strict (no
// 'unsafe-inline', no per-build hash to maintain). Loaded as a classic script
// in <head> BEFORE the module bundle so its capture-phase 'error' listener is
// registered in time to catch a failed /assets/*.js load.
//
// Why this exists: a browser- or edge-cached index.html can reference a hashed
// bundle that a later deploy rotated away. Because Workers Assets uses
// not_found_handling=single-page-application, the missing /assets/*.js is
// answered with the HTML shell (200, text/html), so the browser refuses it
// ("Expected a JavaScript module but got text/html") and the app never mounts.
// Catch that failed asset load and reload once to fetch fresh HTML + current
// hashes. Guarded to at most one reload per 10s to prevent loops.
(function () {
  window.addEventListener(
    'error',
    function (event) {
      var el = event && event.target;
      if (!el || (el.tagName !== 'SCRIPT' && el.tagName !== 'LINK')) return;
      var url = el.src || el.href || '';
      if (url.indexOf('/assets/') === -1) return;
      try {
        var KEY = 'fv:asset-reload-at';
        var now = Date.now();
        if (now - parseInt(sessionStorage.getItem(KEY) || '0', 10) < 10000) return;
        sessionStorage.setItem(KEY, String(now));
      } catch (e) {
        return; // no sessionStorage -> can't guard a loop, so don't reload
      }
      window.location.reload();
    },
    true // capture phase: resource load errors don't bubble
  );
})();

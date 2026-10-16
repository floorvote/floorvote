// Applies the color mode before the first paint: the `dark` class on <html>
// when the stored choice is Dark, or System (the default) and the device is
// dark. A classic external script so the CSP keeps `script-src 'self'`.
// web/src/lib/colorMode.ts takes over once the app loads; keep the storage key
// and the rule in step with it.
(function () {
  var mode = null;
  try { mode = localStorage.getItem('fv:color-mode'); } catch (e) { /* storage blocked */ }
  var dark = mode === 'dark' ||
    (mode !== 'light' && !!window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
})();

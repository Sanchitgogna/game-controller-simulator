// Isolated-world bridge: background worker <-> page (inject.js).
(() => {
  let port = null, retry = null;
  function open() {
    clearTimeout(retry); retry = null;
    if (port) return;
    try { port = chrome.runtime.connect({ name: 'phonepad' }); } catch { return; } // extension reloaded
    port.onMessage.addListener((data) => {
      window.dispatchEvent(new CustomEvent('phonepad:in', { detail: data }));
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // expected when the page is cached or the worker restarts
      port = null;
      window.dispatchEvent(new CustomEvent('phonepad:in', { detail: '{"t":"padgone"}' }));
      if (!document.hidden) retry = setTimeout(open, 1000);
    });
  }
  window.addEventListener('phonepad:out', (e) => { if (port && typeof e.detail === 'string') port.postMessage(e.detail); });
  // Page restored from the back/forward cache, or tab shown again: reconnect.
  window.addEventListener('pageshow', open);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) open(); });
  open();
})();

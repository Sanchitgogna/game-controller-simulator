// Holds the WebSocket to the local relay server and fans messages out to xbox.com tabs.
const URL_WS = 'ws://127.0.0.1:8765/ws?role=game';
const ports = new Set();
let ws = null, retry = null, padOnline = false;

function connect() {
  if (ws || ports.size === 0) return;
  ws = new WebSocket(URL_WS);
  ws.onopen = () => badge();
  ws.onmessage = (e) => {
    const data = e.data;
    if (data.startsWith('{"t":"status"')) { try { padOnline = JSON.parse(data).pads > 0; } catch {} badge(); }
    if (data === '{"t":"padgone"}') { padOnline = false; badge(); }
    for (const p of ports) p.postMessage(data);
  };
  ws.onclose = () => {
    ws = null; padOnline = false; badge();
    for (const p of ports) p.postMessage('{"t":"padgone"}');
    if (ports.size) retry = setTimeout(() => { retry = null; connect(); }, 1000);
  };
  ws.onerror = () => {};
}

function badge() {
  const serverUp = ws && ws.readyState === WebSocket.OPEN;
  chrome.action.setBadgeText({ text: !serverUp ? 'OFF' : padOnline ? 'ON' : '…' });
  chrome.action.setBadgeBackgroundColor({ color: !serverUp ? '#8b949e' : padOnline ? '#2ea043' : '#d29922' });
  chrome.action.setTitle({ title: !serverUp ? 'Phone Pad: server not running (node server.js)' : padOnline ? 'Phone Pad: phone connected' : 'Phone Pad: waiting for phone' });
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'phonepad') return;
  ports.add(port);
  port.onMessage.addListener((msg) => { if (ws && ws.readyState === 1) ws.send(msg); });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    ports.delete(port);
    if (ports.size === 0 && ws) { ws.close(); }
  });
  connect();
  if (padOnline) port.postMessage('{"t":"status","pads":1}');
});

// WebSocket traffic keeps the MV3 service worker alive while a tab is open.
setInterval(() => { if (ws && ws.readyState === 1) ws.send('{"t":"ping"}'); }, 20000);
badge();

// Page-world script: presents the phone as a standard Xbox gamepad via the Gamepad API.
(() => {
  if (window.__phonePad) return;
  window.__phonePad = true;

  const ID = 'Xbox 360 Controller (XInput STANDARD GAMEPAD)';
  const NBTN = 17, TIMEOUT_MS = 3000;
  const realGetGamepads = Navigator.prototype.getGamepads;

  let connected = false, lastMsg = 0, index = 0;
  let mask = 0, axes = [0, 0, 0, 0], trig = [1, 1], ts = performance.now(); // trig: analog LT/RT values
  let snapshot = null;
  let showHud = false, hud = null, lastCalls = 0, events = 0;
  let lastRumble = 0, lastRumbleStrength = 0;

  const actuator = {
    type: 'dual-rumble',
    effects: ['dual-rumble', 'trigger-rumble'],
    playEffect(type, params = {}) {
      const strength = Math.max(params.strongMagnitude || 0, params.weakMagnitude || 0,
        params.leftTrigger || 0, params.rightTrigger || 0);
      const now = performance.now();
      const s = Math.round(strength * 100) / 100;
      // Forward changes promptly (the phone app plays them on its vibration motor),
      // but don't flood the Wi-Fi with identical updates.
      if (s !== lastRumbleStrength || now - lastRumble > 80) {
        lastRumble = now; lastRumbleStrength = s;
        window.dispatchEvent(new CustomEvent('phonepad:out', { detail: JSON.stringify({ t: 'rumble', s, d: params.duration || 120 }) }));
      }
      return Promise.resolve('complete');
    },
    reset() {
      if (lastRumbleStrength !== 0) {
        lastRumbleStrength = 0;
        window.dispatchEvent(new CustomEvent('phonepad:out', { detail: '{"t":"rumble","s":0,"d":0}' }));
      }
      return Promise.resolve('complete');
    },
  };

  // Make objects that pass `instanceof Gamepad` / `GamepadButton` checks, like Chrome's own.
  const GP = window.Gamepad && Gamepad.prototype, GB = window.GamepadButton && GamepadButton.prototype;
  // ONE live object, updated in place. The game may keep the object it got from the
  // 'gamepadconnected' event and keep reading it, so it must never go stale.
  const data = (v) => ({ value: v, enumerable: true, writable: true });
  const liveButtons = [];
  for (let i = 0; i < NBTN; i++) {
    liveButtons.push(Object.create(GB || Object.prototype, { pressed: data(false), touched: data(false), value: data(0) }));
  }
  const liveAxes = [0, 0, 0, 0];
  snapshot = Object.create(GP || Object.prototype, {
    id: data(ID), index: data(0), connected: data(false), mapping: data('standard'),
    timestamp: data(ts), axes: data(liveAxes), buttons: data(liveButtons),
    vibrationActuator: data(actuator), hapticActuators: data([]),
  });
  function build() {
    for (let i = 0; i < NBTN; i++) {
      const p = !!(mask & (1 << i)), b = liveButtons[i];
      const v = p ? (i === 6 ? trig[0] : i === 7 ? trig[1] : 1) : 0;
      b.pressed = p; b.touched = p; b.value = v;
    }
    for (let i = 0; i < 4; i++) liveAxes[i] = axes[i];
    snapshot.index = index; snapshot.connected = connected; snapshot.timestamp = ts;
  }

  function realPads() {
    try { return Array.from(realGetGamepads.call(navigator) || []); } catch { return []; }
  }

  let calls = 0;
  let pressedReads = 0, peak = 0, iframePatched = 0;
  // Debug: which Xbox script file is reading the controller (sampled).
  const callers = new Map();
  function noteCaller() {
    const lines = String(new Error().stack || '').split('\n').slice(3);
    for (const l of lines) {
      const m = l.match(/\/([A-Za-z0-9_.-]+?)-[A-Za-z0-9_]{8}\.js/);
      if (m) { callers.set(m[1], (callers.get(m[1]) || 0) + 1); return; }
    }
    callers.set('?', (callers.get('?') || 0) + 1);
  }
  function getGamepads() {
    calls++;
    if ((calls & 7) === 0) noteCaller();
    if (connected && mask) pressedReads++;
    const list = realPads();
    while (list.length < 4) list.push(null);
    if (connected) {
      if (list[index]) { // a real pad took our slot — move
        const free = list.findIndex((g) => !g);
        index = free === -1 ? list.length : free;
        build();
      }
      list[index] = snapshot;
    }
    return list;
  }
  const ourGetGamepads = function getGamepads_() { return getGamepads(); };
  Object.defineProperty(Navigator.prototype, 'getGamepads', { value: ourGetGamepads, configurable: true, writable: true });

  // Newer Chrome fires 'gamepadrawinputchanged' events, and when
  // `'ongamepadrawinputchanged' in window` is true the in-game stream ONLY listens to
  // those events instead of polling getGamepads(). Our pad can't fire real ones, so hide
  // the feature: the stream then polls, and polling sees the phone.
  // The page can switch the feature back on after load (e.g. an origin-trial token), so
  // keep hiding it. If the stream still picks event mode, fireRawInput() below feeds it.
  let rawEventHidden = false, rawEventReappeared = 0;
  function hideRawEvent() {
    let found = false;
    for (let o = window; o; o = Object.getPrototypeOf(o)) {
      if (Object.prototype.hasOwnProperty.call(o, 'ongamepadrawinputchanged')) {
        found = true;
        try { delete o.ongamepadrawinputchanged; } catch {}
      }
    }
    rawEventHidden = !('ongamepadrawinputchanged' in window);
    return found;
  }
  hideRawEvent();
  document.addEventListener('readystatechange', () => { if (hideRawEvent()) rawEventReappeared++; });
  setInterval(() => { if (hideRawEvent()) rawEventReappeared++; }, 50);

  // Xbox Cloud Gaming can read controllers from a background worker
  // (gamepadInput.worker), which never sees our phone pad. It falls back to reading
  // on the page when that worker can't be used, so block just that worker:
  // 1) refuse to start it, and 2) fail its "can we hand data channels to a worker?" probe.
  let workerBlocked = 0;
  const RealWorker = window.Worker;
  if (RealWorker) {
    window.Worker = new Proxy(RealWorker, {
      construct(target, args, newTarget) {
        if (/gamepadInput\.worker/i.test(String(args[0]))) {
          workerBlocked++;
          console.log('[Phone Pad] blocked controller worker so input stays on the page');
          throw new Error('Phone Pad: gamepad worker disabled');
        }
        return Reflect.construct(target, args, newTarget);
      },
    });
  }
  const realClone = window.structuredClone;
  if (realClone && window.RTCDataChannel) {
    window.structuredClone = function structuredClone(value, options) {
      if (value instanceof RTCDataChannel && value.label === 'xbox-transfer-capability-probe') {
        workerBlocked++;
        throw new DOMException('Phone Pad: data channel transfer disabled', 'DataCloneError');
      }
      return realClone.call(this, value, options);
    };
  }

  // Pages can grab a clean getGamepads from a fresh same-origin <iframe> before any
  // extension script runs there. Patch every child window the moment it's touched.
  function patchChild(w) {
    try {
      if (!w || w === window || !w.Navigator) return;
      if (w.Navigator.prototype.getGamepads === ourGetGamepads) return;
      Object.defineProperty(w.Navigator.prototype, 'getGamepads', { value: ourGetGamepads, configurable: true, writable: true });
      iframePatched++;
    } catch {} // cross-origin: not reachable, and the content script covers it instead
  }
  for (const [proto, prop, toWin] of [
    [HTMLIFrameElement.prototype, 'contentWindow', (v) => v],
    [HTMLIFrameElement.prototype, 'contentDocument', (v) => v && v.defaultView],
    [HTMLFrameElement.prototype, 'contentWindow', (v) => v],
    [HTMLObjectElement.prototype, 'contentWindow', (v) => v],
  ]) {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.get) continue;
    Object.defineProperty(proto, prop, { ...d, get() { const v = d.get.call(this); patchChild(toWin(v)); return v; } });
  }

  function fire(type) {
    const ev = new Event(type);
    if (window.GamepadEvent) Object.setPrototypeOf(ev, GamepadEvent.prototype);
    Object.defineProperty(ev, 'gamepad', { value: snapshot });
    window.dispatchEvent(ev);
  }

  // Do what a real controller does in newer Chrome: announce every change with a
  // 'gamepadrawinputchanged' event. In event mode the stream reads input ONLY from these.
  let rawFired = 0;
  function fireRawInput() {
    if (!connected) return;
    const ev = new Event('gamepadrawinputchanged');
    Object.defineProperty(ev, 'gamepad', { value: snapshot });
    window.dispatchEvent(ev);
    rawFired++;
  }

  function setConnected(on) {
    if (on === connected) return;
    if (on) {
      const list = realPads();
      const free = list.findIndex((g) => !g);
      index = free === -1 ? list.length : free;
      connected = true; ts = performance.now(); build();
      fire('gamepadconnected');
      fireRawInput();
      console.log('[Phone Pad] controller connected at index', index);
    } else {
      mask = 0; axes = [0, 0, 0, 0]; ts = performance.now();
      connected = false; build();
      fire('gamepaddisconnected');
      console.log('[Phone Pad] controller disconnected');
    }
  }

  window.addEventListener('phonepad:in', (e) => {
    let m; try { m = JSON.parse(e.detail); } catch { return; }
    if (m.t === 's') {
      lastMsg = performance.now();
      if (!connected) setConnected(true);
      const a = Array.isArray(m.a) && m.a.length === 4 ? m.a.map(Number) : axes;
      const tr = Array.isArray(m.tr) && m.tr.length === 2 ? m.tr.map((v) => Math.max(0, Math.min(1, Number(v) || 0))) : null;
      const nt = tr ? [tr[0] || 1, tr[1] || 1] : [1, 1];
      if (m.b !== mask || a.some((v, i) => v !== axes[i]) || nt[0] !== trig[0] || nt[1] !== trig[1]) {
        mask = m.b | 0; axes = a; trig = nt; ts = performance.now(); build();
        fireRawInput();
      }
    } else if (m.t === 'padgone') {
      setConnected(false);
    } else if (m.t === 'reconnect') {
      replug('requested from phone');
    } else if (m.t === 'debug') {
      showHud = !!m.on;
      if (hud) hud.style.display = showHud ? '' : 'none';
    }
  });

  // The in-game stream registers controllers from 'gamepadconnected' events fired
  // while it is running, so "re-plug" the virtual pad whenever a stream starts.
  let lastReplug = 0;
  function replug(reason) {
    if (!connected) return;
    const now = performance.now();
    if (now - lastReplug < 3000) return;
    lastReplug = now;
    console.log('[Phone Pad] re-plugging controller:', reason);
    const keepMask = mask, keepAxes = axes;
    setConnected(false);
    setTimeout(() => {
      setConnected(true);
      mask = keepMask; axes = keepAxes; ts = performance.now(); build();
      lastMsg = performance.now();
    }, 250);
  }
  // Media events don't bubble, but they do pass through the capture phase.
  document.addEventListener('playing', (e) => {
    if (e.target instanceof HTMLVideoElement) {
      replug('game stream started');
      setTimeout(() => replug('game stream settled'), 4000); // once more after the stream finishes setting up
    }
  }, true);

  // Phone sends a keep-alive every 500 ms; drop the pad if it goes quiet.
  setInterval(() => { if (connected && performance.now() - lastMsg > TIMEOUT_MS) setConnected(false); }, 500);
  build();

  // Debug: capture the stream's own log lines about input/controllers.
  const logLines = [];
  for (const lvl of ['log', 'info', 'debug', 'warn', 'error']) {
    const orig = console[lvl];
    if (typeof orig !== 'function') continue;
    console[lvl] = function (...args) {
      try {
        const s = args.map((a) => (typeof a === 'string' ? a : '')).join(' ');
        if (/input manager|gamepad|PollGamepads|worker input|InputManager/i.test(s) && !s.includes('[Phone Pad]')) {
          logLines.push(s.replace(/\s+/g, ' ').slice(0, 110));
          if (logLines.length > 5) logLines.shift();
        }
      } catch {}
      return orig.apply(this, args);
    };
  }
  // Debug: count messages the stream sends to Xbox's servers, per data channel.
  const sends = new Map();
  if (window.RTCDataChannel) {
    const origSend = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function (d) {
      try { sends.set(this.label, (sends.get(this.label) || 0) + 1); } catch {}
      return origSend.call(this, d);
    };
  }

  // ---------- Debug panel (top-left of the page; off unless turned on from the phone) ----------
  const isTop = window === window.top;
  window.addEventListener('gamepadconnected', () => events++, true);
  setInterval(() => {
    const rate = calls - lastCalls; lastCalls = calls; if (rate > peak) peak = rate;
    if (!showHud || !document.body) return;
    if (!hud) {
      hud = document.createElement('div');
      hud.style.cssText = 'position:fixed;left:6px;top:' + (isTop ? 6 : 60) + 'px;z-index:2147483647;pointer-events:none;' +
        'font:600 11px/1.35 ui-monospace,Menlo,monospace;color:#fff;background:rgba(0,0,0,.75);padding:4px 7px;border-radius:6px;white-space:pre';
      document.documentElement.appendChild(hud);
    }
    const pressed = []; for (let i = 0; i < NBTN; i++) if (mask & (1 << i)) pressed.push(i);
    const patched = Navigator.prototype.getGamepads === ourGetGamepads && !Object.prototype.hasOwnProperty.call(navigator, 'getGamepads');
    const videos = [...document.querySelectorAll('video')].filter((v) => !v.paused).length;
    const callerText = [...callers].map(([k, v]) => `${k}:${v * 8}`).join(' ') || 'none';
    const sendText = [...sends].map(([k, v]) => `${k}:${v}`).join(' ') || 'none';
    hud.textContent = `PhonePad 1.3.0 ${isTop ? 'top' : 'frame ' + location.host}  focus:${document.hasFocus() ? 'yes' : 'NO'}\n` +
      `readers: ${callerText}\n` +
      `sent: ${sendText}\n` +
      (logLines.length ? 'log: ' + logLines.join('\nlog: ') + '\n' : 'log: (none)\n') +
      `pad:${connected ? 'ON' : 'off'} idx:${index} reads/s:${rate} peak:${peak} patch:${patched ? 'ok' : 'LOST'}\n` +
      `reads-while-pressed:${pressedReads} worker-blocked:${workerBlocked} raw-ev:${rawEventHidden ? "hidden" : "PRESENT"} back:${rawEventReappeared} fired:${rawFired}\n` +
      `btn:[${pressed.join(',')}] ax:${axes.map((v) => v.toFixed(1)).join(',')} video:${videos} ev:${events}`;
  }, 1000);
})();

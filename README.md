# Game Controller Simulator (Phone Pad)

Use your **iPhone as a game controller** for **Xbox Cloud Gaming in Chrome on a Mac**. Open a
web page on the phone, and the browser sees a standard Xbox-layout gamepad. Menus and in-game
input both work.

```
iPhone (web page)  ──Wi-Fi──▶  server.js on your Mac  ──▶  Chrome extension on xbox.com/play
  touch controls                relays input                 appears as a standard gamepad
```

> Not affiliated with or endorsed by Microsoft or Xbox. It only works inside the browser:
> macOS and other apps won't see a controller.

## What you need

- A Mac with [Node.js](https://nodejs.org) 18 or newer
- Chrome (or another Chromium browser: Edge, Brave, Arc). Safari on the Mac isn't supported.
- An iPhone on the same Wi-Fi as the Mac

## Setup (once)

1. **Get the code:** download this repository (Code → Download ZIP) and unzip it, or `git clone` it.
2. **Load the Chrome extension:**
   - Open `chrome://extensions` and turn on **Developer mode** (top right)
   - Click **Load unpacked** and pick the `extension` folder
   - Pin the **Phone Pad** icon so you can see its badge
3. **Start the server** in Terminal, from the downloaded folder:
   ```bash
   node server.js
   ```
   If macOS asks whether `node` may accept incoming network connections, click **Allow**.
   The server prints an address like `http://192.168.1.20:8765`.
4. **On your iPhone**, open that address in Safari. For full screen: Share → **Add to Home Screen**,
   then open it from the Home Screen in landscape.

## Playing

1. Run `node server.js` on the Mac and open the controller on the iPhone.
2. Open https://www.xbox.com/play in Chrome. The extension badge turns **ON** (green) and the
   phone shows **Connected**.
3. Start a game. When Xbox shows **Click to start playing**, click it with the **trackpad**:
   Chrome only lets a real click start the stream, so the phone can't press that button.
4. Play with the phone. Keep Chrome in front: Xbox ignores controllers while its window isn't active.
5. Full screen: press **⌃⌘F**, or use Xbox's ⋯ menu → Full screen.

Badge: **OFF** = server not running, **…** = server running but no phone, **ON** = phone connected.

## Controls

| Phone | Controller |
|---|---|
| Left / right stick zones | Left / right stick (put your thumb down anywhere in the zone) |
| Double-tap a stick zone and hold | L3 / R3 (stick click) |
| LT / RT | Analog triggers: touch near the top for a light press, slide down for full |
| LB / RB | Bumpers |
| ⧉ / Home / ≡ | View / Guide / Menu |
| ⚙︎ (status bar) | Stick size, dead zone, analog triggers, haptics, rumble glow, invert right stick Y, reconnect, debug info |

You can slide a finger from one face button to another without lifting it. The status bar shows
the phone↔Mac latency.

## Troubleshooting

- **Badge stays OFF:** the server isn't running, or the Xbox tab was open before the extension
  was loaded. Reload the tab with ⌘R.
- **Port 8765 already in use:** the server is already running. To restart it:
  `lsof -ti :8765 | xargs kill`, then `node server.js`.
- **Game stops responding:** on the phone, ⚙︎ → **Reconnect to game**.
- **Debugging:** ⚙︎ → **Show debug info on Mac** shows a status panel on the Xbox page.
- **After updating the extension files:** `chrome://extensions` → ↻ on Phone Pad, then reload the
  Xbox tab.
- **Different port:** `PORT=9000 node server.js`, and change `8765` in `extension/background.js`.

## Haptics and rumble on iPhone

Web pages on iOS can only trigger haptics through a trick that works on iOS 18 to 26.4; Apple
blocked it in iOS 26.5. On those versions the controller ticks on press and/or release
(⚙︎ → Haptics, then **Test haptics**). Game rumble can't vibrate the phone from a web page, so the
screen edges glow instead.

## How it works

- `public/index.html`: the touch controller. It sends the controller state to the Mac over a WebSocket.
- `server.js`: a zero-dependency Node server. It serves the page and relays input between the
  phone and the browser. It also announces itself on the local network (Bonjour).
- `extension/`: a Chrome extension that presents the phone as a standard gamepad on xbox.com:
  - It overrides `navigator.getGamepads()` and keeps one live gamepad object updated in place.
  - Xbox Cloud Gaming's in-game code in newer Chrome only takes input from
    `gamepadrawinputchanged` events, which a real controller fires on every change. So the
    extension fires those for the phone too, and hides the feature where it can, so the stream
    falls back to polling.
  - It keeps Xbox's optional controller worker from starting, because that worker can't see the phone.
  - It forwards in-game rumble to the phone.

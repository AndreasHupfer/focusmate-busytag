# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Extension Identity

- **UUID / install path**: `focusmate-busytag@reales`
- **Installed at**: `~/.local/share/gnome-shell/extensions/focusmate-busytag@reales/` → symlink to this folder
- **Compatible GNOME Shell**: 45–48
- **Language**: GJS (ES6 modules, `gi://` imports — no npm, no transpiler)

## Common Commands

```bash
# Reload extension after code changes
gnome-extensions disable focusmate-busytag@reales && gnome-extensions enable focusmate-busytag@reales

# Recompile GSettings schema (only needed after editing the .gschema.xml)
glib-compile-schemas schemas/

# Live log output from GNOME Shell
journalctl /usr/bin/gnome-shell -f | grep focusmate

# Test API key directly
curl -s -w "\nHTTP: %{http_code}\n" \
  -H "X-API-KEY: $(gsettings --schemadir schemas get org.gnome.shell.extensions.focusmate-busytag api-key | tr -d "'")" \
  "https://api.focusmate.com/v1/sessions?start=$(date -u +%Y-%m-%dT%H:%M:%SZ)&end=$(date -u -d '+24 hours' +%Y-%m-%dT%H:%M:%SZ)"

# Read/write a GSettings key
gsettings --schemadir schemas get org.gnome.shell.extensions.focusmate-busytag api-key
gsettings --schemadir schemas set org.gnome.shell.extensions.focusmate-busytag api-key "YOUR-KEY"
```

> Under **Wayland**, `disable/enable` is sufficient for code changes. Schema changes or first-time installs require a full logout/login.

## Architecture

```
extension.js   ←→   scheduler.js   ←→   focusmate.js   (API client)
                          ↕
                      busytag.js         (USB device client)
```

### `scheduler.js` — the core

State machine with four states: `IDLE → UPCOMING → ACTIVE → ERROR`.

- Drives everything via two timers: `_pollTimerId` (API polling, adaptive interval) and `_countdownTimerId` (1 sec tick, only in UPCOMING/ACTIVE).
- Emits three GObject signals: `state-changed(state, session)`, `tick(remainingSecs)`, `error(message)`.
- **Adaptive polling**: 5 min when idle or session is far away; 1 min when session ≤15 min away; waits until session end when ACTIVE.

### `extension.js` — panel UI and lifecycle

- Creates `FocusmateIndicator` (a `PanelMenu.Button`) with a colored dot + label.
- Subscribes to scheduler signals to update the UI.
- Reconnects the scheduler automatically if the API key changes in settings.

### `focusmate.js` — API client

- Single method: `fetchSessions()` → returns normalized array.
- **Auth header**: `Authorization: Bearer <api_key>` (NOT `X-API-KEY`).
- Handles two response shapes (`array` or `{ sessions: [...] }`) and flexible field names (`start`/`startTime`, duration in sec or ms).
- Error classes: `AuthError` (401/403), `NetworkError`.
- Uses a manual Promise wrapper for `send_and_read_async` (required by this GJS version):
  ```js
  function sendAndRead(session, msg) {
      return new Promise((resolve, reject) => {
          session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (src, result) => {
              try { resolve(src.send_and_read_finish(result)); }
              catch (e) { reject(e); }
          });
      });
  }
  ```

### `busytag.js` — USB LED device

- Watches `Gio.VolumeMonitor` for a mount named/pathed `BUSYTAG`.
- Writes `config.json` on the USB volume to control LED color and which LEDs are lit (`led_bits` bitmask, 1–127).
- 2-second debounce + deduplication to avoid redundant writes.

### `prefs.js` — settings window

- Four `Adw.PreferencesGroup` sections: API, Behaviour, BusyTag, Advanced.
- `_testApi()` and `_testBusyTag()` provide in-UI verification.

## GSettings Keys

| Key | Type | Default | Notes |
|---|---|---|---|
| `api-key` | string | `''` | Focusmate API key |
| `lookahead-minutes` | int | `10` | Minutes before session to enter UPCOMING |
| `color-active` | string | `'FF0000'` | Hex, no `#` |
| `color-idle` | string | `'00FF00'` | Hex, no `#` |
| `led-bits` | int | `127` | Bitmask, 127 = all 7 LEDs |
| `show-when-idle` | bool | `false` | Show panel icon in IDLE state |
| `poll-interval-far` | int | `300` | Seconds, session >15 min away |
| `poll-interval-near` | int | `60` | Seconds, session ≤15 min away |

## GJS-Specific Notes

- All GNOME libraries are imported via `gi://Soup?version=3.0`, `gi://Gio`, etc.
- **Do not use** `Gio._promisify` for libsoup methods — it does not work reliably in this environment. Use the manual callback-based Promise wrapper shown above.
- `GObject.registerClass` is required for classes that emit signals or use GObject properties.
- Logging: `console.log('[focusmate-busytag] …')` — visible in `journalctl`.

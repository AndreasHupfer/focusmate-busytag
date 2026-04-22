# Focusmate BusyTag — GNOME Shell Extension

A GNOME Shell extension that displays your [Focusmate](https://focusmate.com) session countdown in the panel and automatically controls a [BusyTag](https://busy-tag.com) USB LED device.

![GNOME Shell 45–48](https://img.shields.io/badge/GNOME_Shell-45–48-blue)
![License MIT](https://img.shields.io/badge/license-MIT-green)

---

## Features

- **Panel indicator** — colored dot + live countdown (`↓ 2:45` before session, `● 47:12` during session)
- **BusyTag LED control** — automatically sets LED color on the USB device
- **BusyTag display** — writes `BUSY` (red) or `FREE` (green) as a text image to the device's screen
- **Adaptive API polling** — 5 min when idle, 1 min when session is ≤ 15 min away
- **Auto-reconnect** — picks up a BusyTag that is plugged in after GNOME Shell starts

## Screenshots

| Panel: UPCOMING | Panel: ACTIVE | BusyTag: FREE | BusyTag: BUSY |
|---|---|---|---|
| `↓ 2:45` | `● 47:12` | Green bg | Red bg |

## Requirements

- GNOME Shell 45, 46, 47, or 48
- A [Focusmate](https://focusmate.com) account + API key
- (Optional) A BusyTag USB device

## Installation

```bash
# Clone into the GNOME extensions folder
git clone https://github.com/AndreasHupfer/focusmate-busytag \
    ~/.local/share/gnome-shell/extensions/focusmate-busytag@reales

# Compile the GSettings schema
glib-compile-schemas ~/.local/share/gnome-shell/extensions/focusmate-busytag@reales/schemas/

# Enable the extension (X11: reload shell first with Alt+F2 → r)
gnome-extensions enable focusmate-busytag@reales
```

Then open **Preferences** and enter your Focusmate API key.

## Configuration

Open the extension preferences via the panel icon → **Einstellungen** or via GNOME Extensions app.

| Setting | Default | Description |
|---|---|---|
| API Key | — | Focusmate API key (from your profile settings) |
| Lookahead | 10 min | Minutes before session start to enter UPCOMING state |
| Active color | `FF0000` | BusyTag LED color during an active session (hex, no `#`) |
| Idle color | `00FF00` | BusyTag LED color when no session is active |
| LED bits | `127` | Bitmask for which LEDs to light (127 = all 7) |
| Show when idle | off | Keep panel icon visible even with no session scheduled |
| Poll interval (far) | 300 s | API polling interval when next session is > 15 min away |
| Poll interval (near) | 60 s | API polling interval when next session is ≤ 15 min away |

## Architecture

```
extension.js   ←→   scheduler.js   ←→   focusmate.js   (API client)
                          ↕
                      busytag.js         (USB device client)
```

### State machine (`scheduler.js`)

```
IDLE  →  UPCOMING  →  ACTIVE  →  IDLE
                              ↘  ERROR
```

- **IDLE** — no session within the lookahead window
- **UPCOMING** — session starts within `lookahead-minutes`; countdown shown
- **ACTIVE** — session is running; countdown shown, BusyTag set to active color + `BUSY` image
- **ERROR** — API auth failure or network error

### BusyTag device (`busytag.js`)

Watches `Gio.VolumeMonitor` for a USB volume named/pathed `BUSYTAG`. On state change, writes two files to the device:

1. `busy.png` or `free.png` — 240×280 px display image (from `assets/`)
2. `config.json` — sets `image`, `solid_color.color`, `solid_color.led_bits`

## Development

```bash
# Reload after code changes (Wayland — requires new login for first load)
gnome-extensions disable focusmate-busytag@reales && gnome-extensions enable focusmate-busytag@reales

# Recompile schema (only after editing .gschema.xml)
glib-compile-schemas schemas/

# Live logs
journalctl /usr/bin/gnome-shell -f | grep focusmate

# Test API key
curl -s -H "Authorization: Bearer YOUR_KEY" \
  "https://api.focusmate.com/v1/sessions?start=$(date -u +%Y-%m-%dT%H:%M:%SZ)&end=$(date -u -d '+24 hours' +%Y-%m-%dT%H:%M:%SZ)"
```

> **Note on Wayland module caching**: GJS caches ES modules within a session.  
> After code changes to `lib/*.js`, a full GNOME Shell restart (log out → log in) is required for the new code to take effect.

## License

MIT — see [LICENSE](LICENSE)

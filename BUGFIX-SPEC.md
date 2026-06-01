# Bugfix-Spezifikation: focusmate-busytag@reales

Erstellt: 2026-06-01  
Grundlage: Code Review (high effort, recall-biased), alle Befunde verifiziert.

---

## Übersicht

Fünf bestätigte Bugs (CONFIRMED) und fünf wahrscheinliche Probleme/Cleanups (PLAUSIBLE/Cleanup).  
Reihenfolge: Schwere absteigend. Bugfixes 1–5 sind kritisch, 6–7 wichtig, 8–10 optional.

---

## Bug 1 — Race Condition: gleichzeitige config.json-Writes

**Datei:** `lib/busytag.js`  
**Betroffene Methoden:** `setState()` (Z. 95) und `_writeCountdownToDevice()` (Z. 272)  
**Schwere:** Kritisch — Gerätezustand wird korrumpiert

### Problem

`setState()` schützt seinen Write mit `_writeInProgress`. `_writeCountdownToDevice()` ignoriert dieses Flag vollständig. Beide Methoden lesen `config.json`, modifizieren Felder und schreiben die Datei zurück. Da `_writeCountdownToDevice()` sekündlich feuert (via `updateCountdownDisplay()`), überlappen die Writes regelmäßig:

1. `setState()` setzt `_writeInProgress = true`, startet Write
2. Countdown-Tick ruft `_writeCountdownToDevice()` auf — kein Check auf `_writeInProgress`
3. Beide lesen `config.json` — beide bekommen den alten Stand
4. `setState()` schreibt `config.image = 'busy.png'` und `solid_color`
5. `_writeCountdownToDevice()` schreibt `config.image = 'countdown.png'` (überschreibt Schritt 4)
6. Gerät hat falsches `image`-Feld

### Fix

`_writeCountdownToDevice()` muss denselben `_writeInProgress`-Guard respektieren wie `setState()`. Da Countdown-Writes Low-Priority sind, ist ein einfaches Skip bei laufendem Write korrekt:

```js
async _writeCountdownToDevice(pngPath) {
    if (!this._mount) return;
    // Skip wenn ein setState-Write läuft — setState hat Vorrang
    if (this._writeInProgress) return;

    // ... restlicher Code unverändert
}
```

Alternativ (robuster): Eine gemeinsame private `_patchConfig(patchFn)` Methode schreiben, die `_writeInProgress` für alle config.json-Zugriffe serialisiert.

---

## Bug 2 — Debounce verwirft State-Transitionen ohne Retry

**Datei:** `lib/busytag.js`  
**Betroffene Methode:** `setState()` (Z. 108)  
**Schwere:** Kritisch — BusyTag zeigt dauerhaft falschen Zustand

### Problem

```js
if (!force && (this._writeInProgress || (now - this._lastWriteTime) < DEBOUNCE_MS)) {
    return; // SILENT DROP
}
```

Wird `setState()` während `_writeInProgress = true` oder innerhalb von 2 Sekunden nach dem letzten Write aufgerufen, wird der Aufruf lautlos verworfen. `_applyBusyTag()` im Scheduler wird nur bei `_transitionTo()` und dem `'connected'`-Signal aufgerufen, nicht periodisch. Folge: Bei UPCOMING→ACTIVE-Transition innerhalb des Debounce-Fensters bleibt der BusyTag dauerhaft auf UPCOMING-Farbe.

### Fix

**Option A (minimal):** Nach dem Write in `setState()` prüfen, ob sich der Ziel-State seit dem Drop geändert hat. Dazu den aktuell gewünschten State zwischenspeichern:

```js
async setState(hexColor, displayState, force = false) {
    if (!this._mount) return;

    const stateKey = `${hexColor}:${displayState}`;
    if (!force && stateKey === this._lastStateKey) return;

    const now = Date.now();
    if (!force && (this._writeInProgress || (now - this._lastWriteTime) < DEBOUNCE_MS)) {
        // Gewünschten State vormerken statt verwerfen
        this._pendingStateKey = stateKey;
        this._pendingHexColor = hexColor;
        this._pendingDisplayState = displayState;
        return;
    }

    this._pendingStateKey = null;
    this._writeInProgress = true;
    try {
        await this._writeToDevice(hexColor, displayState);
        this._lastStateKey = stateKey;
        this._lastWriteTime = Date.now();
        this._currentColor = hexColor;
        this._lastCountdownMin = -1;
    } catch (e) {
        throw e;
    } finally {
        this._writeInProgress = false;
        // Pending State nachholen falls vorhanden
        if (this._pendingStateKey && this._pendingStateKey !== this._lastStateKey) {
            const h = this._pendingHexColor, d = this._pendingDisplayState;
            this._pendingStateKey = null;
            this._pendingHexColor = null;
            this._pendingDisplayState = null;
            this.setState(h, d).catch(e => console.log(`[focusmate-busytag] pending setState failed: ${e}`));
        }
    }
}
```

**Option B (einfacher):** `force = true` in `_applyBusyTag()` immer übergeben und das Debounce vollständig entfernen. Das Dedup (`_lastStateKey`) verhindert redundante Writes bereits. Debounce ist bei USB-Schreiboperationen nicht nötig, da das Gerät sowieso auf den letzten Wert konvergiert.

Option B ist vorzuziehen, da einfacher und korrekter.

---

## Bug 3 — `led-bits` GSettings-Einstellung wird nie angewendet

**Datei:** `lib/busytag.js`  
**Betroffene Methode:** `_writeConfig()` (Z. 182)  
**Schwere:** Mittel — Nutzereinstellung wirkungslos

### Problem

```js
config.solid_color = {
    ...(config.solid_color ?? {}),
    led_bits: 127, // hardcoded — ignoriert GSettings 'led-bits'
    color: hexColor,
};
```

Der GSettings-Key `led-bits` ist korrekt definiert und in den Preferences als SpinRow exponiert. `BusyTagClient` hat aber keinen Zugriff auf `settings`, da der Konstruktor nur `extensionPath` entgegennimmt.

### Fix

`BusyTagClient` den `settings`-Parameter übergeben:

```js
// busytag.js
_init(extensionPath, settings) {
    super._init();
    this._extensionPath = extensionPath;
    this._settings = settings;
    // ...
}

async _writeConfig(root, hexColor, imageName) {
    // ...
    const ledBits = this._settings?.get_int('led-bits') ?? 127;
    config.solid_color = {
        ...(config.solid_color ?? {}),
        led_bits: ledBits,
        color: hexColor,
    };
    // ...
}
```

Aufrufstellen anpassen:

```js
// extension.js
this._busyTagClient = new BusyTagClient(this._extensionPath, this._settings);

// prefs.js _testBusyTag()
const client = new BusyTagClient(this.path, settings);
```

---

## Bug 4 — `client.destroy()` fehlt im Fehler-Pfad von `_testBusyTag()`

**Datei:** `prefs.js`  
**Betroffene Methode:** `_testBusyTag()` (Z. 243)  
**Schwere:** Mittel — VolumeMonitor-Signal-Leak

### Problem

`client.enable()` verbindet zwei VolumeMonitor-Signale. `client.destroy()` wird nur im Happy-Path und im `isConnected === false`-Branch aufgerufen. Wirft `client.setState()` eine Exception, läuft der `catch`-Block ohne `destroy()` — die Signal-Verbindungen akkumulieren sich bei wiederholten Test-Klicks.

### Fix

`client.destroy()` in den `finally`-Block verschieben:

```js
async _testBusyTag(settings, button) {
    button.sensitive = false;
    button.label = '…';

    let client = null;
    try {
        const { BusyTagClient } = await import('./lib/busytag.js');
        client = new BusyTagClient(this.path, settings);
        client.enable();

        await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        }));

        if (!client.isConnected) {
            button.label = 'Nicht gefunden';
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
                button.sensitive = true;
                button.label = 'Testen';
                return GLib.SOURCE_REMOVE;
            });
            return;
        }

        await client.setState(settings.get_string('color-active'), 'active');
        await new Promise(resolve => GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        }));
        await client.setState(settings.get_string('color-idle'), 'idle');
    } catch (e) {
        console.log(`[focusmate-busytag] BusyTag test error: ${e}`);
    } finally {
        client?.destroy(); // immer aufräumen
        button.sensitive = true;
        button.label = 'Testen';
    }
}
```

---

## Bug 5 — Partner-Lookup schlägt fehl wenn `requestingUserId` fehlt

**Datei:** `lib/focusmate.js`  
**Betroffene Methode:** `_normalizeSessions()` (Z. 111)  
**Schwere:** Mittel — falscher Partnername in der Anzeige

### Problem

```js
partner: s.users?.find(u => u.userId !== s.requestingUserId)?.name
    ?? s.partner?.name
    ?? null,
```

`s.requestingUserId` ist nicht in der `known`-Feldliste und wird nicht zwischengespeichert. Fehlt es in der API-Response, ist `s.requestingUserId === undefined`. Dann gilt `u.userId !== undefined` für jeden User mit einer ID — `find()` gibt immer den ersten User zurück, nicht den Partner.

### Fix

Fallback auf den zweiten User wenn `requestingUserId` fehlt, mit klarerer Logik:

```js
partner: (() => {
    if (s.users?.length > 0) {
        // Wenn requestingUserId bekannt: den anderen User wählen
        if (s.requestingUserId !== undefined) {
            return s.users.find(u => u.userId !== s.requestingUserId)?.name ?? null;
        }
        // Fallback: zweiter User ist der Partner (Index 1)
        return s.users[1]?.name ?? s.users[0]?.name ?? null;
    }
    return s.partner?.name ?? null;
})(),
```

Außerdem `'requestingUserId'` in die `known`-Liste aufnehmen (Z. 87), damit es nicht als unbekanntes Feld geloggt wird.

---

## Bug 6 — Duration-Normierung: Threshold 100000 ms ist fehleranfällig

**Datei:** `lib/focusmate.js`  
**Betroffene Methode:** `_normalizeSessions()` (Z. 97)  
**Schwere:** Niedrig (Focusmate-Sessions sind ≥25 min, also sicher)

### Problem

```js
if (durationMs > 0 && durationMs < 100000)
    durationMs *= 1000; // war in Sekunden
```

Durations zwischen 100 ms und 99999 ms werden als Sekunden interpretiert und mit 1000 multipliziert (z.B. 90000 ms → 90 000 000 ms = 25h). Realistic bei künftigen API-Änderungen oder Test-Sessions.

### Fix

API-Response-Format einmalig beim ersten Call detektieren und cachen, statt einen fragilen Threshold zu verwenden. Kurzfristig: Kommentar mit Begründung ergänzen und den Threshold auf die kleinste reale Session-Länge (25 min = 1500000 ms) anheben:

```js
// Focusmate API gibt duration mal in Sekunden (≤3600), mal in ms (>3600000).
// Schwellwert: 3600 Sekunden (1h) — keine valide Session ist kürzer als 1s in ms oder länger als 1h in s.
if (durationMs > 0 && durationMs <= 3600)
    durationMs *= 1000;
```

---

## Bug 7 — Hardcoded `/tmp/busytag-countdown.png` (Multi-Instanz-Kollision)

**Datei:** `lib/busytag.js`  
**Betroffene Methode:** `_generateCountdownPng()` (Z. 233)  
**Schwere:** Niedrig (tritt nur beim Extension-Reload ohne Logout auf)

### Problem

Zwei gleichzeitig laufende Extension-Instanzen (möglich nach Reload) schreiben in dieselbe Temp-Datei ohne Locking.

### Fix

Instanz-spezifischen Dateinamen verwenden:

```js
_init(extensionPath, settings) {
    // ...
    this._tmpPngPath = `/tmp/busytag-countdown-${GLib.get_monotonic_time()}.png`;
}

// in _generateCountdownPng():
const pngPath = this._tmpPngPath;

// in destroy(): Temp-Datei aufräumen
destroy() {
    try {
        if (this._tmpPngPath)
            Gio.File.new_for_path(this._tmpPngPath).delete(null);
    } catch (_) {}
    // ...
}
```

---

## Cleanup 8 — BusyTag-Erkennung in `prefs.js` inkonsistent zu `busytag.js`

**Datei:** `prefs.js`  
**Betroffene Methode:** `_updateMountStatus()` (Z. 188)

### Problem

`busytag.js._isBusyTag()` erkennt das Gerät auch per Fallback (`config.json` + `readme.txt`). `prefs.js._updateMountStatus()` prüft nur Name und Pfad — zeigt "Nicht gefunden" für Geräte, die busytag.js korrekt erkennt.

### Fix

`_isBusyTag()` als exportierte Hilfsfunktion aus `busytag.js` exportieren und in `prefs.js` importieren:

```js
// busytag.js — exportieren
export function isBusyTagMount(mount) { /* bisherige _isBusyTag-Logik */ }

// prefs.js
import { BusyTagClient, isBusyTagMount } from './lib/busytag.js';

_updateMountStatus(label) {
    const mounts = Gio.VolumeMonitor.get().get_mounts();
    const found = mounts.find(m => isBusyTagMount(m));
    if (found) {
        label.label = `Gefunden: ${found.get_root()?.get_path()}`;
        label.add_css_class('success');
    } else {
        label.label = 'Nicht gefunden';
        label.add_css_class('warning');
    }
}
```

---

## Cleanup 9 — `sendAndRead()` in zwei Dateien dupliziert

**Dateien:** `lib/focusmate.js` (Z. 4) und `prefs.js` (Z. 8)

### Problem

Identische Funktion an zwei Stellen. Fixes müssen synchron gepflegt werden.

### Fix

In eine gemeinsame Datei `lib/utils.js` auslagern:

```js
// lib/utils.js
import GLib from 'gi://GLib';
export function sendAndRead(session, msg) {
    return new Promise((resolve, reject) => {
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (src, result) => {
            try { resolve(src.send_and_read_finish(result)); }
            catch (e) { reject(e); }
        });
    });
}
```

```js
// focusmate.js
import { sendAndRead } from './utils.js';

// prefs.js
import { sendAndRead } from './lib/utils.js';
```

---

## Cleanup 10 — config.json-Lese/Schreib-Boilerplate dupliziert

**Datei:** `lib/busytag.js`  
**Betroffene Methoden:** `_writeConfig()` (Z. 159) und `_writeCountdownToDevice()` (Z. 272)

### Problem

Beide Methoden enthalten denselben ~20-Zeilen-Block: `load_contents_async` → `JSON.parse` → Felder setzen → `JSON.stringify` → `replace_contents_async`. Formatänderungen müssen an zwei Stellen gepflegt werden.

### Fix

Private Hilfsmethode `_patchConfig(root, patchFn)`:

```js
async _patchConfig(root, patchFn) {
    const configFile = root.get_child('config.json');
    const [, contents] = await new Promise((resolve, reject) => {
        configFile.load_contents_async(null, (f, res) => {
            try { resolve(f.load_contents_finish(res)); }
            catch (e) { reject(e); }
        });
    });
    let config;
    try { config = JSON.parse(new TextDecoder().decode(contents)); }
    catch (e) { throw new Error(`config.json JSON-Fehler: ${e.message}`); }

    patchFn(config); // Caller-spezifische Felder setzen

    const newContents = new TextEncoder().encode(JSON.stringify(config, null, 4));
    await new Promise((resolve, reject) => {
        configFile.replace_contents_async(
            GLib.Bytes.new(newContents), null, false,
            Gio.FileCreateFlags.NONE, null,
            (f, res) => {
                try { f.replace_contents_finish(res); resolve(); }
                catch (e) { reject(e); }
            }
        );
    });
}

// _writeConfig() wird zu:
async _writeConfig(root, hexColor, imageName) {
    const ledBits = this._settings?.get_int('led-bits') ?? 127;
    await this._patchConfig(root, config => {
        config.image = imageName;
        config.solid_color = { ...(config.solid_color ?? {}), led_bits: ledBits, color: hexColor };
        config.activate_pattern = false;
        config.show_after_drop = false;
    });
}

// _writeCountdownToDevice() config-Teil wird zu:
await this._patchConfig(root, config => { config.image = 'countdown.png'; });
```

Diese Refaktorierung löst gleichzeitig Bug 1 (Race Condition), wenn `_patchConfig` `_writeInProgress` setzt.

---

## Empfohlene Reihenfolge

| Priorität | Bugs | Begründung |
|---|---|---|
| 1 | Bug 1 + Bug 2 | Gerätezustand korrumpiert/stuck — sichtbar für jeden Nutzer |
| 2 | Bug 3 | Nutzereinstellung komplett wirkungslos |
| 3 | Bug 4 | Resource-Leak beim Testen |
| 4 | Bug 5 | Falscher Partnername |
| 5 | Bug 6 + Bug 7 | Defensive Fixes |
| Optional | Cleanup 8–10 | Code-Qualität |

**Empfehlung:** Cleanup 10 (`_patchConfig`) zusammen mit Bug 1 und Bug 3 umsetzen — die Refaktorierung löst Bug 1 und vereinfacht Bug 3 gleichzeitig, ohne Mehraufwand.

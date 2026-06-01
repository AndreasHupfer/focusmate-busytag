import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Cairo from 'gi://cairo';

export function isBusyTagMount(mount) {
    const name = mount.get_name() ?? '';
    if (name.toUpperCase().includes('BUSYTAG'))
        return true;

    const root = mount.get_root();
    if (!root)
        return false;

    const path = root.get_path() ?? '';
    if (path.toUpperCase().includes('BUSYTAG'))
        return true;

    // Fallback: prüfe ob config.json + readme.txt vorhanden
    const hasConfig = root.get_child('config.json').query_exists(null);
    const hasReadme = root.get_child('readme.txt').query_exists(null);
    return hasConfig && hasReadme;
}

export const BusyTagClient = GObject.registerClass({
    Signals: {
        'connected': {},
        'disconnected': {},
    },
}, class BusyTagClient extends GObject.Object {
    _init(extensionPath, settings) {
        super._init();
        this._extensionPath = extensionPath;
        this._settings = settings;
        this._volumeMonitor = Gio.VolumeMonitor.get();
        this._mount = null;
        this._lastStateKey = null;
        this._writeInProgress = false;
        this._connections = [];
        this._currentColor = null;
        this._lastCountdownMin = -1;
        this._tmpPngPath = `/tmp/busytag-countdown-${GLib.get_monotonic_time()}.png`;
    }

    enable() {
        this._connections.push(
            this._volumeMonitor.connect('mount-added', (_mon, mount) => {
                if (this._mount === null && isBusyTagMount(mount)) {
                    this._mount = mount;
                    console.log(`[focusmate-busytag] BusyTag connected: ${mount.get_root().get_path()}`);
                    this.emit('connected');
                }
            }),
            this._volumeMonitor.connect('mount-removed', (_mon, mount) => {
                if (this._mount && this._mountsEqual(this._mount, mount)) {
                    this._mount = null;
                    this._lastStateKey = null;
                    console.log('[focusmate-busytag] BusyTag disconnected');
                    this.emit('disconnected');
                }
            })
        );

        this._scanMounts();
    }

    _scanMounts() {
        for (const mount of this._volumeMonitor.get_mounts()) {
            if (isBusyTagMount(mount)) {
                this._mount = mount;
                console.log(`[focusmate-busytag] BusyTag found at startup: ${mount.get_root().get_path()}`);
                break;
            }
        }
    }

    _mountsEqual(a, b) {
        try {
            return a.get_root()?.get_path() === b.get_root()?.get_path();
        } catch {
            return false;
        }
    }

    get isConnected() {
        return this._mount !== null;
    }

    get mountPath() {
        return this._mount?.get_root()?.get_path() ?? null;
    }

    // displayState: 'idle' | 'upcoming' | 'active'
    async setState(hexColor, displayState, force = false) {
        if (!this._mount) {
            console.log('[focusmate-busytag] setState: BusyTag not mounted, skipping');
            return;
        }

        const stateKey = `${hexColor}:${displayState}`;
        if (!force && stateKey === this._lastStateKey) {
            console.log(`[focusmate-busytag] setState: already ${stateKey}, skipping`);
            return;
        }

        if (this._writeInProgress) {
            console.log('[focusmate-busytag] setState: write in progress, skipping');
            return;
        }

        this._writeInProgress = true;
        try {
            await this._writeToDevice(hexColor, displayState);
            this._lastStateKey = stateKey;
            this._currentColor = hexColor;
            this._lastCountdownMin = -1;
            console.log(`[focusmate-busytag] BusyTag state set to ${stateKey}`);
        } catch (e) {
            console.log(`[focusmate-busytag] setState failed: ${e}`);
            throw e;
        } finally {
            this._writeInProgress = false;
        }
    }

    async _writeToDevice(hexColor, displayState) {
        const root = this._mount.get_root();
        const imageName = displayState === 'active' ? 'busy.png' : 'free.png';

        // Bild aus Extension-Assets lesen und auf BusyTag schreiben
        const srcFile = Gio.File.new_for_path(`${this._extensionPath}/assets/${imageName}`);
        const [, imgContents] = await new Promise((resolve, reject) => {
            srcFile.load_contents_async(null, (f, res) => {
                try { resolve(f.load_contents_finish(res)); }
                catch (e) { reject(e); }
            });
        });

        const imgFile = root.get_child(imageName);
        await new Promise((resolve, reject) => {
            imgFile.replace_contents_async(
                GLib.Bytes.new(imgContents),
                null, false,
                Gio.FileCreateFlags.NONE,
                null,
                (f, res) => {
                    try { f.replace_contents_finish(res); resolve(); }
                    catch (e) { reject(e); }
                }
            );
        });

        await this._writeConfig(root, hexColor, imageName);
    }

    async _patchConfig(root, patchFn) {
        const configFile = root.get_child('config.json');
        const [, contents] = await new Promise((resolve, reject) => {
            configFile.load_contents_async(null, (f, res) => {
                try { resolve(f.load_contents_finish(res)); }
                catch (e) { reject(e); }
            });
        });

        let config;
        try {
            config = JSON.parse(new TextDecoder().decode(contents));
        } catch (e) {
            throw new Error(`config.json JSON-Fehler: ${e.message}`);
        }

        patchFn(config);

        const newContents = new TextEncoder().encode(JSON.stringify(config, null, 4));
        await new Promise((resolve, reject) => {
            configFile.replace_contents_async(
                GLib.Bytes.new(newContents),
                null, false,
                Gio.FileCreateFlags.NONE,
                null,
                (f, res) => {
                    try { f.replace_contents_finish(res); resolve(); }
                    catch (e) { reject(e); }
                }
            );
        });
    }

    async _writeConfig(root, hexColor, imageName) {
        const ledBits = this._settings?.get_int('led-bits') ?? 127;
        await this._patchConfig(root, config => {
            config.image = imageName;
            config.solid_color = {
                ...(config.solid_color ?? {}),
                led_bits: ledBits,
                color: hexColor,
            };
            config.activate_pattern = false;
            config.show_after_drop = false;
        });
    }

    updateCountdownDisplay(remainingSecs, isActive) {
        if (!this._mount || !this._currentColor)
            return;

        const currentMin = Math.floor(remainingSecs / 60);
        if (currentMin === this._lastCountdownMin)
            return;
        this._lastCountdownMin = currentMin;

        let pngPath;
        try {
            pngPath = this._generateCountdownPng(remainingSecs, isActive);
        } catch (e) {
            console.log(`[focusmate-busytag] countdown PNG generation failed: ${e}`);
            return;
        }
        this._writeCountdownToDevice(pngPath).catch(e => {
            console.log(`[focusmate-busytag] countdown display update failed: ${e}`);
        });
    }

    _generateCountdownPng(remainingSecs, isActive) {
        const width = 240;
        const height = 280;
        const pngPath = this._tmpPngPath;

        const surface = new Cairo.ImageSurface(Cairo.Format.RGB24, width, height);
        const cr = new Cairo.Context(surface);

        cr.setSourceRGB(0, 0, 0);
        cr.paint();
        cr.setSourceRGB(1, 1, 1);

        // Status-Label oben
        cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
        cr.setFontSize(28);
        const statusText = isActive ? 'BUSY' : 'BALD';
        const statusExt = cr.textExtents(statusText);
        cr.moveTo((width - statusExt.width) / 2 - statusExt.xBearing, 62);
        cr.showText(statusText);

        // Große Zeitanzeige in der Mitte
        const mins = Math.floor(remainingSecs / 60);
        const secs = remainingSecs % 60;
        const timeStr = `${mins}:${String(secs).padStart(2, '0')}`;
        cr.selectFontFace('Monospace', Cairo.FontSlant.NORMAL, Cairo.FontWeight.BOLD);
        cr.setFontSize(62);
        const timeExt = cr.textExtents(timeStr);
        cr.moveTo((width - timeExt.width) / 2 - timeExt.xBearing, height / 2 + 24);
        cr.showText(timeStr);

        // Untertitel unten
        cr.selectFontFace('Sans', Cairo.FontSlant.NORMAL, Cairo.FontWeight.NORMAL);
        cr.setFontSize(18);
        const subText = isActive ? 'Session laeuft' : 'bis Session';
        const subExt = cr.textExtents(subText);
        cr.moveTo((width - subExt.width) / 2 - subExt.xBearing, height - 28);
        cr.showText(subText);

        surface.writeToPNG(pngPath);
        return pngPath;
    }

    async _writeCountdownToDevice(pngPath) {
        if (!this._mount)
            return;
        // Skip wenn ein setState-Write läuft — setState hat Vorrang
        if (this._writeInProgress)
            return;

        const root = this._mount.get_root();
        const srcFile = Gio.File.new_for_path(pngPath);

        const [, imgContents] = await new Promise((resolve, reject) => {
            srcFile.load_contents_async(null, (f, res) => {
                try { resolve(f.load_contents_finish(res)); }
                catch (e) { reject(e); }
            });
        });

        const destFile = root.get_child('countdown.png');
        await new Promise((resolve, reject) => {
            destFile.replace_contents_async(
                GLib.Bytes.new(imgContents),
                null, false,
                Gio.FileCreateFlags.NONE,
                null,
                (f, res) => {
                    try { f.replace_contents_finish(res); resolve(); }
                    catch (e) { reject(e); }
                }
            );
        });

        await this._patchConfig(root, config => { config.image = 'countdown.png'; });
        console.log(`[focusmate-busytag] countdown.png updated on BusyTag`);
    }

    destroy() {
        for (const id of this._connections)
            this._volumeMonitor.disconnect(id);
        this._connections = [];
        this._mount = null;
        this._lastCountdownMin = -1;
        try {
            if (this._tmpPngPath)
                Gio.File.new_for_path(this._tmpPngPath).delete(null);
        } catch (_) {}
    }
});

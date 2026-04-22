import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

const DEBOUNCE_MS = 2000;

export const BusyTagClient = GObject.registerClass({
    Signals: {
        'connected': {},
        'disconnected': {},
    },
}, class BusyTagClient extends GObject.Object {
    _init(extensionPath) {
        super._init();
        this._extensionPath = extensionPath;
        this._volumeMonitor = Gio.VolumeMonitor.get();
        this._mount = null;
        this._lastStateKey = null;
        this._lastWriteTime = 0;
        this._writeInProgress = false;
        this._connections = [];
    }

    enable() {
        this._connections.push(
            this._volumeMonitor.connect('mount-added', (_mon, mount) => {
                if (this._mount === null && this._isBusyTag(mount)) {
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
            if (this._isBusyTag(mount)) {
                this._mount = mount;
                console.log(`[focusmate-busytag] BusyTag found at startup: ${mount.get_root().get_path()}`);
                break;
            }
        }
    }

    _isBusyTag(mount) {
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

    async setState(hexColor, isBusy) {
        if (!this._mount) {
            console.log('[focusmate-busytag] setState: BusyTag not mounted, skipping');
            return;
        }

        const stateKey = `${hexColor}:${isBusy}`;
        if (stateKey === this._lastStateKey) {
            console.log(`[focusmate-busytag] setState: already ${stateKey}, skipping`);
            return;
        }

        const now = Date.now();
        if (this._writeInProgress || (now - this._lastWriteTime) < DEBOUNCE_MS) {
            console.log('[focusmate-busytag] setState: debounced, skipping');
            return;
        }

        this._writeInProgress = true;
        try {
            await this._writeToDevice(hexColor, isBusy);
            this._lastStateKey = stateKey;
            this._lastWriteTime = Date.now();
            console.log(`[focusmate-busytag] BusyTag state set to ${stateKey}`);
        } catch (e) {
            console.log(`[focusmate-busytag] setState failed: ${e}`);
            throw e;
        } finally {
            this._writeInProgress = false;
        }
    }

    async _writeToDevice(hexColor, isBusy) {
        const root = this._mount.get_root();
        const imageName = isBusy ? 'busy.png' : 'free.png';

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

    async _writeConfig(root, hexColor, imageName) {
        const configFile = root.get_child('config.json');

        const [, contents] = await new Promise((resolve, reject) => {
            configFile.load_contents_async(null, (file, result) => {
                try {
                    resolve(file.load_contents_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
        });

        let config;
        try {
            config = JSON.parse(new TextDecoder().decode(contents));
        } catch (e) {
            throw new Error(`config.json JSON-Fehler: ${e.message}`);
        }

        config.image = imageName;
        config.solid_color = {
            ...(config.solid_color ?? {}),
            led_bits: 127,
            color: hexColor,
        };
        config.activate_pattern = false;
        config.show_after_drop = false;

        const newContents = new TextEncoder().encode(JSON.stringify(config, null, 4));

        await new Promise((resolve, reject) => {
            configFile.replace_contents_async(
                GLib.Bytes.new(newContents),
                null,  // etag
                false, // make_backup
                Gio.FileCreateFlags.NONE,
                null,  // cancellable
                (file, result) => {
                    try {
                        file.replace_contents_finish(result);
                        resolve();
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    destroy() {
        for (const id of this._connections)
            this._volumeMonitor.disconnect(id);
        this._connections = [];
        this._mount = null;
    }
});

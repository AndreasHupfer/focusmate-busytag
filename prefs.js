import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import { sendAndRead } from './lib/utils.js';
import { isBusyTagMount } from './lib/busytag.js';

export default class FocusmateBusyTagPrefs extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Focusmate BusyTag',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        page.add(this._buildApiGroup(settings, window));
        page.add(this._buildBehaviorGroup(settings));
        page.add(this._buildBusyTagGroup(settings));
        page.add(this._buildAdvancedGroup(settings));
    }

    _buildApiGroup(settings, window) {
        const group = new Adw.PreferencesGroup({
            title: 'Focusmate API',
        });

        // API Key Row
        const apiKeyRow = new Adw.PasswordEntryRow({
            title: 'API Key',
        });
        settings.bind('api-key', apiKeyRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        group.add(apiKeyRow);

        // Test API Button
        const testRow = new Adw.ActionRow({
            title: 'API-Verbindung testen',
            subtitle: 'Prüft ob der API Key gültig ist',
        });
        const testBtn = new Gtk.Button({
            label: 'Testen',
            valign: Gtk.Align.CENTER,
        });
        testBtn.connect('clicked', () => this._testApi(settings, testBtn, window));
        testRow.add_suffix(testBtn);
        group.add(testRow);

        return group;
    }

    _buildBehaviorGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Verhalten',
        });

        // Lookahead
        const lookaheadRow = new Adw.SpinRow({
            title: 'Vorwarnung',
            subtitle: 'Minuten vor Session-Start in UPCOMING wechseln',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 60,
                step_increment: 1,
            }),
        });
        settings.bind('lookahead-minutes', lookaheadRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(lookaheadRow);

        // Show when idle
        const showIdleRow = new Adw.SwitchRow({
            title: 'Icon im Idle-Zustand anzeigen',
            subtitle: 'Panel-Icon auch wenn keine Session naht',
        });
        settings.bind('show-when-idle', showIdleRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(showIdleRow);

        return group;
    }

    _buildBusyTagGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'BusyTag',
        });

        // Mount status (read-only)
        const statusRow = new Adw.ActionRow({
            title: 'Gerät-Status',
        });
        const statusLabel = new Gtk.Label({
            valign: Gtk.Align.CENTER,
        });
        this._updateMountStatus(statusLabel);
        statusRow.add_suffix(statusLabel);
        group.add(statusRow);

        // Color active
        const colorActiveRow = new Adw.EntryRow({
            title: 'Farbe bei aktiver Session (Hex)',
        });
        settings.bind('color-active', colorActiveRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        group.add(colorActiveRow);

        // Color upcoming
        const colorUpcomingRow = new Adw.EntryRow({
            title: 'Farbe im Upcoming-Zustand (Hex)',
        });
        settings.bind('color-upcoming', colorUpcomingRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        group.add(colorUpcomingRow);

        // Color idle
        const colorIdleRow = new Adw.EntryRow({
            title: 'Farbe im Idle-Zustand (Hex)',
        });
        settings.bind('color-idle', colorIdleRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        group.add(colorIdleRow);

        // LED bits
        const ledBitsRow = new Adw.SpinRow({
            title: 'LED-Bitmaske',
            subtitle: '127 = alle 7 LEDs',
            adjustment: new Gtk.Adjustment({
                lower: 1,
                upper: 127,
                step_increment: 1,
            }),
        });
        settings.bind('led-bits', ledBitsRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(ledBitsRow);

        // Test BusyTag button
        const testRow = new Adw.ActionRow({
            title: 'BusyTag testen',
            subtitle: 'Setzt LED 3 Sekunden auf aktive Farbe, dann idle',
        });
        const testBtn = new Gtk.Button({
            label: 'Testen',
            valign: Gtk.Align.CENTER,
        });
        testBtn.connect('clicked', () => this._testBusyTag(settings, testBtn));
        testRow.add_suffix(testBtn);
        group.add(testRow);

        return group;
    }

    _buildAdvancedGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Erweitert',
        });

        const pollFarRow = new Adw.SpinRow({
            title: 'Polling-Intervall (weit)',
            subtitle: 'Sekunden — wenn nächste Session >15 Min entfernt',
            adjustment: new Gtk.Adjustment({
                lower: 60,
                upper: 3600,
                step_increment: 30,
            }),
        });
        settings.bind('poll-interval-far', pollFarRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(pollFarRow);

        const pollNearRow = new Adw.SpinRow({
            title: 'Polling-Intervall (nah)',
            subtitle: 'Sekunden — wenn nächste Session ≤15 Min entfernt',
            adjustment: new Gtk.Adjustment({
                lower: 10,
                upper: 300,
                step_increment: 10,
            }),
        });
        settings.bind('poll-interval-near', pollNearRow, 'value', Gio.SettingsBindFlags.DEFAULT);
        group.add(pollNearRow);

        return group;
    }

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

    async _testApi(settings, button, window) {
        const apiKey = settings.get_string('api-key');
        if (!apiKey) {
            this._showToast(window, 'Bitte zuerst einen API Key eingeben');
            return;
        }

        button.sensitive = false;
        button.label = '…';

        try {
            const session = new Soup.Session({ timeout: 10 });
            const now = new Date();
            const end = new Date(now.getTime() + 24 * 60 * 60 * 1000);
            const url = `https://api.focusmate.com/v1/sessions?start=${now.toISOString()}&end=${end.toISOString()}`;
            const msg = Soup.Message.new('GET', url);
            msg.request_headers.append('X-API-KEY', apiKey);

            const bytes = await sendAndRead(session, msg);
            const statusCode = msg.get_status();

            if (statusCode === 200) {
                const text = new TextDecoder().decode(bytes.get_data());
                const data = JSON.parse(text);
                const count = Array.isArray(data) ? data.length : (data.sessions?.length ?? '?');
                this._showToast(window, `✓ API OK — ${count} Session(s) gefunden`);
            } else if (statusCode === 401 || statusCode === 403) {
                this._showToast(window, '✗ Ungültiger API Key (401/403)');
            } else {
                this._showToast(window, `✗ API Fehler: HTTP ${statusCode}`);
            }
        } catch (e) {
            this._showToast(window, `✗ Netzwerkfehler: ${e.message}`);
        } finally {
            button.sensitive = true;
            button.label = 'Testen';
        }
    }

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
            client?.destroy();
            button.sensitive = true;
            button.label = 'Testen';
        }
    }

    _showToast(window, message) {
        const toast = new Adw.Toast({ title: message, timeout: 4 });
        window.add_toast(toast);
    }
}

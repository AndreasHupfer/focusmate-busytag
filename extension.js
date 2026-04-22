import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St from 'gi://St';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';

import { FocusmateClient } from './lib/focusmate.js';
import { BusyTagClient } from './lib/busytag.js';
import { Scheduler, State } from './lib/scheduler.js';

const FocusmateIndicator = GObject.registerClass(
class FocusmateIndicator extends PanelMenu.Button {
    _init(settings, extensionPath) {
        super._init(0.0, 'Focusmate BusyTag');

        this._settings = settings;
        this._extensionPath = extensionPath;
        this._scheduler = null;

        this._buildUi();
        this._buildMenu();
        this._startScheduler();
    }

    _buildUi() {
        const box = new St.BoxLayout({
            style_class: 'focusmate-indicator',
            vertical: false,
        });

        this._dot = new St.Widget({ style_class: 'focusmate-dot focusmate-dot-idle' });

        this._label = new St.Label({
            style_class: 'focusmate-label',
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
        });

        box.add_child(this._dot);
        box.add_child(this._label);
        this.add_child(box);

        this._applyIdleVisibility();
    }

    _buildMenu() {
        this._sessionItems = [];
        this._noSessionItem = new PopupMenu.PopupMenuItem('Lade Sessions…', { reactive: false });
        this.menu.addMenuItem(this._noSessionItem);

        this._menuSeparator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(this._menuSeparator);

        const refreshItem = new PopupMenu.PopupMenuItem('Jetzt aktualisieren');
        refreshItem.connect('activate', () => this._scheduler?.forceRefresh());
        this.menu.addMenuItem(refreshItem);

        const testItem = new PopupMenu.PopupMenuItem('BusyTag testen (rot 3s)');
        testItem.connect('activate', () => this._testBusyTag());
        this.menu.addMenuItem(testItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        const prefsItem = new PopupMenu.PopupMenuItem('Einstellungen');
        prefsItem.connect('activate', () => {
            const ext = Extension.lookupByUUID('focusmate-busytag@reales');
            ext?.openPreferences();
        });
        this.menu.addMenuItem(prefsItem);
    }

    _startScheduler() {
        const apiKey = this._settings.get_string('api-key');
        if (!apiKey) {
            this._setErrorState('API Key in Einstellungen eintragen');
            return;
        }

        this._focusmateClient = new FocusmateClient(apiKey);
        this._busyTagClient = new BusyTagClient(this._extensionPath);
        this._busyTagClient.enable();

        this._scheduler = new Scheduler(
            this._focusmateClient,
            this._busyTagClient,
            this._settings
        );

        this._scheduler.connect('state-changed', (_src, state, session) => {
            this._onStateChanged(state, session);
        });
        this._scheduler.connect('tick', (_src, remainingSecs) => {
            this._onTick(remainingSecs);
        });
        this._scheduler.connect('error', (_src, message) => {
            this._setErrorState(message);
        });

        this._scheduler.enable();

        this._settingsChangedId = this._settings.connect('changed::api-key', () => {
            this._restartScheduler();
        });
    }

    _restartScheduler() {
        this._stopScheduler();
        this._startScheduler();
    }

    _stopScheduler() {
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        this._scheduler?.destroy();
        this._scheduler = null;
        this._focusmateClient?.destroy();
        this._focusmateClient = null;
        this._busyTagClient?.destroy();
        this._busyTagClient = null;
    }

    _onStateChanged(state, _session) {
        switch (state) {
        case State.IDLE:
            this._dot.style_class = 'focusmate-dot focusmate-dot-idle';
            this._label.text = '';
            this._applyIdleVisibility();
            break;
        case State.UPCOMING:
            this.show();
            this._dot.style_class = 'focusmate-dot focusmate-dot-upcoming';
            break;
        case State.ACTIVE:
            this.show();
            this._dot.style_class = 'focusmate-dot focusmate-dot-active';
            break;
        case State.ERROR:
            this.show();
            this._dot.style_class = 'focusmate-dot focusmate-dot-error';
            this._label.text = '⚠';
            break;
        }

        this._rebuildSessionItems();
    }

    _rebuildSessionItems() {
        for (const item of this._sessionItems)
            item.destroy();
        this._sessionItems = [];

        const sessions = this._scheduler?.sessions ?? [];
        const now = Date.now();

        if (sessions.length === 0) {
            this._noSessionItem.label.text = 'Keine Session geplant';
            this._noSessionItem.visible = true;
            return;
        }

        this._noSessionItem.visible = false;

        const sepIdx = this.menu._getMenuItems().indexOf(this._menuSeparator);
        for (let i = 0; i < sessions.length; i++) {
            const s = sessions[i];
            const isActive = now >= s.startMs && now < s.endMs;
            const prefix = isActive ? '● ' : '○ ';
            const endIso = new Date(s.endMs).toISOString();
            const timeRange = `${_formatTime(s.startTime)}–${_formatTime(endIso)}`;
            const item = new PopupMenu.PopupMenuItem(`${prefix}${timeRange}`, { reactive: false });
            this.menu.addMenuItem(item, sepIdx + i);
            this._sessionItems.push(item);
        }
    }

    _onTick(remainingSecs) {
        const mins = Math.floor(remainingSecs / 60);
        const secs = remainingSecs % 60;
        const timeStr = `${mins}:${String(secs).padStart(2, '0')}`;

        const scheduler = this._scheduler;
        if (scheduler?.currentState === State.UPCOMING)
            this._label.text = `↓ ${timeStr}`;
        else if (scheduler?.currentState === State.ACTIVE)
            this._label.text = `● ${timeStr}`;
    }

    _setErrorState(message) {
        this.show();
        this._dot.style_class = 'focusmate-dot focusmate-dot-error';
        this._label.text = '⚠';
        this.set_accessible_name(`Focusmate: ${message}`);
        console.log(`[focusmate-busytag] Error: ${message}`);
    }

    _applyIdleVisibility() {
        if (this._settings.get_boolean('show-when-idle'))
            this.show();
        else
            this.hide();
    }

    _testBusyTag() {
        if (!this._busyTagClient?.isConnected) {
            Main.notify('Focusmate BusyTag', 'BusyTag nicht gefunden');
            return;
        }
        const activeColor = this._settings.get_string('color-active');
        const idleColor = this._settings.get_string('color-idle');
        this._busyTagClient.setState(activeColor, true).then(() => {
            GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
                this._busyTagClient?.setState(idleColor, false);
                return GLib.SOURCE_REMOVE;
            });
        }).catch(e => {
            console.log(`[focusmate-busytag] BusyTag test failed: ${e}`);
        });
    }

    destroy() {
        this._stopScheduler();
        super.destroy();
    }
});

function _formatTime(isoString) {
    const d = new Date(isoString);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default class FocusmateBusyTagExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new FocusmateIndicator(this._settings, this.path);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        console.log('[focusmate-busytag] Extension enabled');
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
        console.log('[focusmate-busytag] Extension disabled');
    }
}

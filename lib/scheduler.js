import GLib from 'gi://GLib';
import GObject from 'gi://GObject';

import { AuthError, NetworkError } from './focusmate.js';

export const State = Object.freeze({
    IDLE: 0,
    UPCOMING: 1,
    ACTIVE: 2,
    ERROR: 3,
});

const ERROR_RETRY_SECS = 120;
const NEAR_THRESHOLD_MINS = 15;

export const Scheduler = GObject.registerClass({
    Signals: {
        'state-changed': { param_types: [GObject.TYPE_INT, GObject.TYPE_JSOBJECT] },
        'tick': { param_types: [GObject.TYPE_INT] },
        'error': { param_types: [GObject.TYPE_STRING] },
    },
}, class Scheduler extends GObject.Object {
    _init(focusmateClient, busyTagClient, settings) {
        super._init();
        this._focusmateClient = focusmateClient;
        this._busyTagClient = busyTagClient;
        this._settings = settings;

        this._state = State.IDLE;
        this._currentSession = null;
        this._sessions = [];
        this._pollTimerId = null;
        this._countdownTimerId = null;
        this._busyTagConnId = null;
    }

    get sessions() {
        return this._sessions;
    }

    get currentState() {
        return this._state;
    }

    enable() {
        // BusyTag connect/disconnect → State neu bewerten
        this._busyTagConnId = this._busyTagClient.connect('connected', () => {
            this._applyBusyTag();
        });

        this._poll();
    }

    forceRefresh() {
        this._clearPollTimer();
        this._poll();
    }

    async _poll() {
        console.log('[focusmate-busytag] Polling Focusmate API…');

        let sessions;
        try {
            sessions = await this._focusmateClient.fetchSessions();
        } catch (e) {
            if (e instanceof AuthError)
                this._enterError('Ungültiger API Key');
            else
                this._enterError('Offline — Netzwerkfehler');
            this._scheduleNextPoll(null, ERROR_RETRY_SECS);
            return;
        }

        const now = Date.now();
        const upcoming = sessions
            .filter(s => s.endMs > now)
            .sort((a, b) => a.startMs - b.startMs);

        this._sessions = upcoming;
        const nextSession = upcoming[0] ?? null;

        this._currentSession = nextSession;
        this._computeAndApplyState(now, nextSession);
    }

    _computeAndApplyState(now, session) {
        const lookaheadMs = this._settings.get_int('lookahead-minutes') * 60 * 1000;

        let newState;
        if (!session) {
            newState = State.IDLE;
        } else if (now >= session.startMs && now < session.endMs) {
            newState = State.ACTIVE;
        } else if (session.startMs - now <= lookaheadMs) {
            newState = State.UPCOMING;
        } else {
            newState = State.IDLE;
        }

        this._transitionTo(newState, session);
        this._scheduleNextPollForSession(now, session);
    }

    _transitionTo(newState, session) {
        const prevState = this._state;
        this._state = newState;

        // Countdown-Timer nur in UPCOMING/ACTIVE
        if (newState === State.UPCOMING || newState === State.ACTIVE) {
            this._ensureCountdownTimer();
        } else {
            this._clearCountdownTimer();
        }

        // setState() in busytag.js dedupliziert, daher immer aufrufen (auch IDLE→IDLE)
        this._applyBusyTag();

        this.emit('state-changed', newState, session);
        console.log(`[focusmate-busytag] State: ${_stateName(prevState)} → ${_stateName(newState)}`);
    }

    _applyBusyTag() {
        if (!this._busyTagClient.isConnected)
            return;

        let color, displayState;
        if (this._state === State.ACTIVE) {
            color = this._settings.get_string('color-active');
            displayState = 'active';
        } else if (this._state === State.UPCOMING) {
            color = this._settings.get_string('color-upcoming');
            displayState = 'upcoming';
        } else {
            color = this._settings.get_string('color-idle');
            displayState = 'idle';
        }

        this._busyTagClient.setState(color, displayState, true).catch(e => {
            console.log(`[focusmate-busytag] BusyTag write failed: ${e}`);
        });
    }

    _enterError(message) {
        this._state = State.ERROR;
        this._clearCountdownTimer();
        this.emit('error', message);
        this.emit('state-changed', State.ERROR, null);
        console.log(`[focusmate-busytag] ERROR: ${message}`);
    }

    _scheduleNextPollForSession(now, session) {
        if (!session) {
            // Kein Session: alle 5 Min pollen
            this._scheduleNextPoll(null, this._settings.get_int('poll-interval-far'));
            return;
        }

        if (this._state === State.ACTIVE) {
            // Während ACTIVE: kein API-Poll, Ende ist deterministisch
            // Timer für Session-Ende planen
            const secsUntilEnd = Math.ceil((session.endMs - now) / 1000);
            this._scheduleNextPoll(null, Math.max(1, secsUntilEnd));
            return;
        }

        const minsUntilStart = (session.startMs - now) / 60000;
        if (minsUntilStart > NEAR_THRESHOLD_MINS)
            this._scheduleNextPoll(null, this._settings.get_int('poll-interval-far'));
        else
            this._scheduleNextPoll(null, this._settings.get_int('poll-interval-near'));
    }

    _scheduleNextPoll(_session, delaySecs) {
        this._clearPollTimer();
        this._pollTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delaySecs, () => {
            this._pollTimerId = null;
            this._poll();
            return GLib.SOURCE_REMOVE;
        });
    }

    _ensureCountdownTimer() {
        if (this._countdownTimerId !== null)
            return;

        this._countdownTimerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            try {
                this._onCountdownTick();
            } catch (e) {
                console.log(`[focusmate-busytag] Countdown tick error: ${e}`);
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _onCountdownTick() {
        const now = Date.now();
        const session = this._currentSession;

        if (!session) {
            this._clearCountdownTimer();
            return;
        }

        // State neu prüfen (Session kann währenddessen starten oder enden)
        if (now >= session.endMs) {
            this._clearCountdownTimer();
            this._poll();
            return;
        }

        if (this._state === State.UPCOMING && now >= session.startMs)
            this._transitionTo(State.ACTIVE, session);

        const remainingSecs = this._state === State.ACTIVE
            ? Math.max(0, Math.ceil((session.endMs - now) / 1000))
            : Math.max(0, Math.ceil((session.startMs - now) / 1000));

        this.emit('tick', remainingSecs);

        if (this._busyTagClient.isConnected) {
            const isActive = this._state === State.ACTIVE;
            this._busyTagClient.updateCountdownDisplay(remainingSecs, isActive);
        }
    }

    _clearPollTimer() {
        if (this._pollTimerId !== null) {
            GLib.source_remove(this._pollTimerId);
            this._pollTimerId = null;
        }
    }

    _clearCountdownTimer() {
        if (this._countdownTimerId !== null) {
            GLib.source_remove(this._countdownTimerId);
            this._countdownTimerId = null;
        }
    }

    destroy() {
        this._clearPollTimer();
        this._clearCountdownTimer();
        if (this._busyTagConnId !== null) {
            this._busyTagClient.disconnect(this._busyTagConnId);
            this._busyTagConnId = null;
        }
    }
});

function _stateName(state) {
    return ['IDLE', 'UPCOMING', 'ACTIVE', 'ERROR'][state] ?? '?';
}

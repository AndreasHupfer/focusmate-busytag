import Soup from 'gi://Soup?version=3.0';
import GLib from 'gi://GLib';

function sendAndRead(session, msg) {
    return new Promise((resolve, reject) => {
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (src, result) => {
            try { resolve(src.send_and_read_finish(result)); }
            catch (e) { reject(e); }
        });
    });
}

const BASE_URL = 'https://api.focusmate.com/v1';

export class AuthError extends Error {}
export class NetworkError extends Error {}

export class FocusmateClient {
    constructor(apiKey) {
        this._apiKey = apiKey;
        this._session = new Soup.Session({ timeout: 10 });
        this._firstCall = true;
    }

    /**
     * Lädt Sessions für das nächste 24h-Fenster.
     * Gibt Array von Session-Objekten zurück (normalisiert).
     * Beim ersten Aufruf wird die rohe Response geloggt.
     */
    async fetchSessions() {
        const now = new Date();
        const end = new Date(now.getTime() + 24 * 60 * 60 * 1000);
        const url = `${BASE_URL}/sessions?start=${encodeURIComponent(now.toISOString())}&end=${encodeURIComponent(end.toISOString())}`;

        let bytes;
        try {
            const msg = Soup.Message.new('GET', url);
            msg.request_headers.append('X-API-KEY', this._apiKey);
            bytes = await sendAndRead(this._session, msg);

            const statusCode = msg.get_status();
            if (statusCode === 401 || statusCode === 403)
                throw new AuthError(`HTTP ${statusCode}`);
            if (statusCode < 200 || statusCode >= 300)
                throw new NetworkError(`HTTP ${statusCode}`);
        } catch (e) {
            if (e instanceof AuthError || e instanceof NetworkError)
                throw e;
            throw new NetworkError(e.message ?? String(e));
        }

        const text = new TextDecoder().decode(bytes.get_data());

        if (this._firstCall) {
            console.log(`[focusmate-busytag] API Response (raw): ${text}`);
            this._firstCall = false;
        }

        let data;
        try {
            data = JSON.parse(text);
        } catch (e) {
            throw new NetworkError(`JSON parse error: ${e.message}`);
        }

        return this._normalizeSessions(data);
    }

    /**
     * Normalisiert die API-Response in ein einheitliches Format.
     * Loggt unbekannte Felder damit wir das Schema zur Laufzeit verstehen.
     */
    _normalizeSessions(data) {
        // API kann entweder ein Array oder { sessions: [...] } zurückgeben
        let raw;
        if (Array.isArray(data)) {
            raw = data;
        } else if (data && Array.isArray(data.sessions)) {
            raw = data.sessions;
        } else {
            console.log(`[focusmate-busytag] Unexpected API response shape: ${JSON.stringify(data).slice(0, 200)}`);
            return [];
        }

        return raw.map(s => {
            // Felder die wir noch nicht kennen loggen
            const known = ['sessionId', 'start', 'startTime', 'duration', 'status', 'userId',
                'users', 'requester', 'partner', 'sessionTitle', 'videoUrl'];
            const unknown = Object.keys(s).filter(k => !known.includes(k));
            if (unknown.length > 0)
                console.log(`[focusmate-busytag] Unknown session fields: ${unknown.join(', ')}`);

            // Startzeit — API nutzt entweder 'start' oder 'startTime'
            const startTime = s.startTime ?? s.start;

            // Duration in Millisekunden (falls in Sekunden → *1000)
            let durationMs = s.duration ?? 0;
            if (durationMs > 0 && durationMs < 100000)
                durationMs *= 1000; // war in Sekunden

            // Status — cancelled Sessions filtern wir heraus
            const status = s.status ?? 'confirmed';

            return {
                sessionId: s.sessionId,
                startTime,
                startMs: new Date(startTime).getTime(),
                durationMs,
                endMs: new Date(startTime).getTime() + durationMs,
                status,
                partner: s.users?.find(u => u.userId !== s.requestingUserId)?.name
                    ?? s.partner?.name
                    ?? null,
            };
        }).filter(s => s.status !== 'cancelled' && s.status !== 'rejected' && s.startMs > 0);
    }

    destroy() {
        this._session.abort();
    }
}

import GLib from 'gi://GLib';

export function sendAndRead(session, msg) {
    return new Promise((resolve, reject) => {
        session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (src, result) => {
            try { resolve(src.send_and_read_finish(result)); }
            catch (e) { reject(e); }
        });
    });
}

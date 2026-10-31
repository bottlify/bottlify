/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A sign-in, as a store's sign-in page (`<store>/signin.html`) runs it: in
 * that page, an extension page that lives as long as the launcher shows it, at
 * the priority of the tab it is shown in -- not in the service worker, which
 * Chrome keeps at a low priority and may stop when it is idle, while a QR
 * sign-in waits on a person.
 *
 * Steam is asked over the page's own CM connection, so the password goes to
 * Steam sealed and the token Steam answers comes to this page, which seals it
 * into the extension's own database (vault.js) at once; neither reaches the
 * launcher's page, which cannot read this one. The page's steps go in as messages:
 * `{ start: 'qr' }` or `{ start: 'credentials', accountName, password }`, and
 * `{ code, type }` when Steam Guard asks for one; out come `{ event:
 * 'challenge', url }`, `{ event: 'scanned' }`, `{ event: 'guard', types, hint }`,
 * `{ event: 'wrongCode' }`, then `{ done: { name } }` or `{ error }`. A new
 * start ends the sign-in going on.
 */

/** @typedef {import('./stores/steam/auth.js').SignedIn} SignedIn */

/**
 * A store's sign-ins and where its session is kept.
 *
 * @typedef {Object} Kept
 * @property {{ set(session: any): Promise<void> }} vault
 * @property {(options: { onChallenge: (url: string) => void, onScanned: () => void,
 *     signal: AbortSignal }) => Promise<SignedIn>} qr
 * @property {(options: { accountName: string, password: string,
 *     onGuard: (asked: { types: number[], hint: string }) => void,
 *     takeCode: (signal: AbortSignal) => Promise<{ code: string, type: number }>,
 *     onWrongCode: () => void, signal: AbortSignal }) => Promise<SignedIn>} credentials
 */

/**
 * @param {Object} options
 * @param {Kept} options.kept
 * @param {(message: Record<string, any>) => void} options.send  To the page's steps.
 */
export function createSignIn({ kept, send }){
    /** @type {AbortController | null} */
    let going = null;
    /** Codes given and not taken yet, and a sign-in waiting for one. */
    const codes = /** @type {Array<{ code: string, type: number }>} */ ([]);
    /** @type {((code: { code: string, type: number }) => void) | null} */
    let waiting = null;
    /** @param {AbortSignal} signal */
    const takeCode = signal=>new Promise((resolve, reject)=>{
        const given = codes.shift();
        if (given)
        {
            resolve(given);
            return;
        }
        waiting = resolve;
        signal.addEventListener('abort', ()=>reject(signal.reason), { once: true });
    });

    return {
        /** @param {Record<string, any>} message */
        async heard(message){
            if (typeof message?.code === 'string' && Number.isInteger(message.type))
            {
                const code = { code: message.code.trim(), type: message.type };
                if (waiting)
                {
                    const take = waiting;
                    waiting = null;
                    take(code);
                }
                else
                {
                    codes.push(code);
                }
                return;
            }
            if (message?.start !== 'qr' && message?.start !== 'credentials')
            {
                return;
            }
            going?.abort(new Error('a new sign-in began'));
            const stop = new AbortController();
            going = stop;
            codes.length = 0;
            waiting = null;
            try
            {
                const { signal } = stop;
                const signedIn = message.start === 'qr'
                    ? await kept.qr({ signal, onChallenge: url=>send({ event: 'challenge', url }),
                        onScanned: ()=>send({ event: 'scanned' }) })
                    : await kept.credentials({ signal,
                        accountName: String(message.accountName ?? ''),
                        password: String(message.password ?? ''),
                        onGuard: ({ types, hint })=>send({ event: 'guard', types, hint }),
                        takeCode, onWrongCode: ()=>send({ event: 'wrongCode' }) });
                await kept.vault.set({ accountName: signedIn.accountName,
                    refreshToken: signedIn.refreshToken, id: crypto.randomUUID() });
                if (going === stop)
                {
                    send({ done: { name: signedIn.accountName } });
                }
            }
            catch (e){
                if (going === stop)
                {
                    send({ error: String(/** @type {Error} */ (e)?.message ?? e) });
                }
            }
            finally
            {
                if (going === stop)
                {
                    going = null;
                }
            }
        },

        /** The page went: the sign-in going on ends. */
        stop(){
            const now = going;
            going = null;
            now?.abort(new Error('the sign-in page went'));
        },
    };
}

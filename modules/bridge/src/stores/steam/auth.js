/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Signing in: by a QR code, or by account name and password with Steam Guard.
 *
 * By QR code, the client asks the Authentication service for a session and is
 * given a challenge URL to show as a QR code. The person scans it with the
 * Steam mobile app and approves there: that is their Steam Guard, and no
 * password passes through here. By name and password, the password is sealed
 * with the account's RSA key, as the service gives it, and the session asks
 * for what the account's Steam Guard allows: a code from an email or the
 * mobile authenticator, or an approval in the app. Either way the client then
 * polls the session; a QR code's challenge may be replaced while it waits,
 * and once approved the poll answers with the account name and a refresh
 * token -- a SteamClient one, which is what a client logs on with.
 *
 * `connect` gives what calls the service: a CM connection or Steam's web API
 * (webapi.js), which GameHub's service worker uses so the token comes to it
 * alone.
 */

import {
    Authentication, EResult, GAMING_DEVICE_PC, Guard, OS_WINDOWS_10, PERSISTENT,
    PLATFORM_STEAM_CLIENT,
} from './messages.js';

/**
 * What calls the Authentication service's methods: a CM connection, or the
 * web API.
 *
 * @typedef {{ call: (method: string, requestSchema: any, request: Record<string, any>,
 *     responseSchema: any, options?: { get?: boolean, authed?: boolean }) =>
 *     Promise<{ eresult: number, body: Record<string, any>, message?: string }> }} Service
 */

/**
 * @typedef {Object} SignedIn
 * @property {string} accountName
 * @property {string} refreshToken  Logs on now and later; the caller decides
 *           whether and where it is kept.
 */

/** @param {number} ms @param {AbortSignal} [signal] */
const pause = (ms, signal)=>new Promise((resolve, reject)=>{
    if (signal?.aborted)
    {
        reject(signal.reason ?? new Error('aborted'));
        return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', ()=>{
        clearTimeout(timer);
        reject(signal.reason ?? new Error('aborted'));
    }, { once: true });
});

/**
 * Signs in by QR code; resolves once the person has approved it.
 *
 * @param {() => Promise<Service>} connect  An open connection, a new one
 *        when the last has closed: a manager drops a connection that has not
 *        logged on after a minute or so, and the sign-in, which the service
 *        keeps, goes on over the next.
 * @param {Object} options
 * @param {(challengeUrl: string) => void} options.onChallenge  Show this as a
 *        QR code; called again when the code changes.
 * @param {() => void} [options.onScanned]  The code was scanned and waits
 *        for approval in the app.
 * @param {string} [options.deviceName]  What the app shows the person as the
 *        device asking.
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<SignedIn>}
 */
export async function signInWithQr(connect, options){
    const { onChallenge, onScanned, deviceName = 'Bottlify', signal } = options;
    const begun = await (await connect()).call('Authentication.BeginAuthSessionViaQR#1',
        Authentication.BeginAuthSessionViaQRRequest, {
            // The device alone, as a desktop client describes itself; a
            // website named beside it made the app show the sign-in as a
            // browser's.
            device_details: {
                device_friendly_name: deviceName,
                platform_type: PLATFORM_STEAM_CLIENT,
                os_type: OS_WINDOWS_10,
                gaming_device_type: GAMING_DEVICE_PC,
            },
        }, Authentication.BeginAuthSessionViaQRResponse);
    if (begun.eresult !== EResult.OK)
    {
        throw new Error(`steam: a QR sign-in could not begin (EResult ${begun.eresult})`);
    }
    onChallenge(begun.body.challenge_url);
    return pollSession(connect, { clientId: /** @type {bigint} */ (begun.body.client_id),
        requestId: /** @type {Uint8Array} */ (begun.body.request_id),
        interval: begun.body.interval, signal, onScanned, onChallenge });
}

/**
 * Polls a sign-in's session until it is approved.
 *
 * @param {() => Promise<Service>} connect
 * @param {Object} session
 * @param {bigint} session.clientId @param {Uint8Array} session.requestId
 * @param {number} [session.interval]  Seconds between polls, as the service asks.
 * @param {AbortSignal} [session.signal]
 * @param {() => void} [session.onScanned]
 * @param {(challengeUrl: string) => void} [session.onChallenge]
 * @returns {Promise<SignedIn>}
 */
async function pollSession(connect, { clientId, requestId, interval, signal, onScanned,
    onChallenge })
{
    // Every client id the session has had, the newest last. The service
    // replaces the code every twenty seconds or so, a scan included: a code
    // scanned just before it was replaced is approved under the id it had,
    // and the newer one is then answered FileNotFound.
    const clientIds = [clientId];
    const every = Math.max(1, interval ?? 5) * 1000;
    for (;;)
    {
        await pause(every, signal);
        const current = clientIds[clientIds.length - 1];
        const polled = await (await connect()).call('Authentication.PollAuthSessionStatus#1',
            Authentication.PollAuthSessionStatusRequest,
            { client_id: current, request_id: requestId },
            Authentication.PollAuthSessionStatusResponse);
        if (polled.eresult === EResult.FileNotFound && clientIds.length > 1)
        {
            clientIds.pop();
            continue;
        }
        if (polled.eresult !== EResult.OK)
        {
            const expired = polled.eresult === EResult.Expired
                || polled.eresult === EResult.FileNotFound;
            const what = expired ? 'the sign-in\'s session is gone' : 'the sign-in failed';
            const detail = polled.message ? `: ${polled.message}` : '';
            throw new Error(`steam: ${what} (EResult ${polled.eresult}${detail})`);
        }
        const body = polled.body;
        if (body.had_remote_interaction)
        {
            onScanned?.();
        }
        if (body.new_client_id && body.new_client_id !== current)
        {
            clientIds.push(body.new_client_id);
        }
        if (body.new_challenge_url)
        {
            onChallenge?.(body.new_challenge_url);
        }
        if (body.refresh_token)
        {
            return { accountName: body.account_name, refreshToken: body.refresh_token };
        }
    }
}

/**
 * A password sealed for Steam: RSA with PKCS#1 v1.5 padding under the
 * account's key, base64 -- what GetPasswordRSAPublicKey's key is for, and a
 * padding WebCrypto does not offer.
 *
 * @param {string} password @param {string} modulusHex @param {string} exponentHex
 * @returns {string}
 */
export function encryptPassword(password, modulusHex, exponentHex){
    const n = BigInt(`0x${modulusHex}`);
    const e = BigInt(`0x${exponentHex}`);
    const size = Math.ceil(n.toString(16).length / 2);
    const message = new TextEncoder().encode(password);
    if (message.length > size - 11)
    {
        throw new Error('steam: the password is too long');
    }
    const block = new Uint8Array(size);
    block[1] = 2;
    const padding = block.subarray(2, size - message.length - 1);
    crypto.getRandomValues(padding);
    for (let i = 0; i < padding.length; i++)
    {
        while (padding[i] === 0)
        {
            padding[i] = crypto.getRandomValues(new Uint8Array(1))[0];
        }
    }
    block.set(message, size - message.length);
    let m = 0n;
    for (const byte of block)
    {
        m = (m << 8n) | BigInt(byte);
    }
    let c = 1n;
    for (let base = m % n, power = e; power > 0n; power >>= 1n, base = (base * base) % n)
    {
        if (power & 1n)
        {
            c = (c * base) % n;
        }
    }
    const out = new Uint8Array(size);
    for (let i = size - 1; i >= 0; i--, c >>= 8n)
    {
        out[i] = Number(c & 0xFFn);
    }
    return btoa(String.fromCharCode(...out));
}

/**
 * What a sign-in by name and password asks of the person: the confirmations
 * the account's Steam Guard allows, any of which approves it.
 *
 * @typedef {{ types: number[], hint: string }} GuardAsked  `types` of `Guard`;
 *     `hint` what Steam says of where a code went (an email's domain).
 */

/**
 * Signs in by account name and password; resolves once Steam Guard is passed.
 *
 * @param {() => Promise<Service>} connect
 * @param {Object} options
 * @param {string} options.accountName
 * @param {string} options.password  Sealed here with the account's key; kept nowhere.
 * @param {(asked: GuardAsked) => void} [options.onGuard]  The person is asked
 *        for a code or an approval; not called for an account without Steam Guard.
 * @param {(signal: AbortSignal) => Promise<{ code: string, type: number }>} [options.takeCode]
 *        The next code the person gives, of `Guard.EmailCode` or `Guard.DeviceCode`.
 * @param {(eresult: number) => void} [options.onWrongCode]  Steam refused a code; another is taken.
 * @param {string} [options.deviceName]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<SignedIn>}
 */
export async function signInWithCredentials(connect, options){
    const { accountName, password, onGuard, takeCode, onWrongCode, deviceName = 'Bottlify',
        signal } = options;
    const service = await connect();
    const key = await service.call('Authentication.GetPasswordRSAPublicKey#1',
        Authentication.GetPasswordRSAPublicKeyRequest, { account_name: accountName },
        Authentication.GetPasswordRSAPublicKeyResponse, { get: true });
    if (key.eresult !== EResult.OK || !key.body.publickey_mod)
    {
        throw new Error(`steam: no key for the password (EResult ${key.eresult})`);
    }
    const begun = await (await connect()).call('Authentication.BeginAuthSessionViaCredentials#1',
        Authentication.BeginAuthSessionViaCredentialsRequest, {
            account_name: accountName,
            encrypted_password: encryptPassword(password, key.body.publickey_mod,
                key.body.publickey_exp),
            encryption_timestamp: key.body.timestamp,
            remember_login: true,
            platform_type: PLATFORM_STEAM_CLIENT,
            persistence: PERSISTENT,
            website_id: 'Client',
            device_details: {
                device_friendly_name: deviceName,
                platform_type: PLATFORM_STEAM_CLIENT,
                os_type: OS_WINDOWS_10,
                gaming_device_type: GAMING_DEVICE_PC,
            },
        }, Authentication.BeginAuthSessionViaCredentialsResponse);
    if (begun.eresult !== EResult.OK)
    {
        const wrong = begun.eresult === EResult.InvalidPassword
            ? 'the account name or password is wrong' : 'the sign-in could not begin';
        throw new Error(`steam: ${wrong} (EResult ${begun.eresult})`);
    }
    const { client_id: clientId, request_id: requestId, steamid: steamId, interval } = begun.body;
    /** @type {Array<{ confirmation_type: number, associated_message?: string }>} */
    const allowed = begun.body.allowed_confirmations ?? [];
    const types = allowed.map(one=>one.confirmation_type);
    if (!types.includes(Guard.None))
    {
        const hint = allowed.find(one=>one.associated_message)?.associated_message ?? '';
        onGuard?.({ types, hint });
    }
    // Codes are sent as the person gives them while the session is polled: an
    // approval in the app ends the sign-in as well as a code does.
    const stop = new AbortController();
    const both = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
    const asksCode = types.some(type=>type === Guard.EmailCode || type === Guard.DeviceCode);
    const codes = async()=>{
        if (!takeCode || !asksCode)
        {
            return;
        }
        for (;;)
        {
            const { code, type } = await takeCode(both);
            const sent = await (await connect()).call(
                'Authentication.UpdateAuthSessionWithSteamGuardCode#1',
                Authentication.UpdateAuthSessionWithSteamGuardCodeRequest,
                { client_id: clientId, steamid: BigInt(steamId), code, code_type: type },
                Authentication.UpdateAuthSessionWithSteamGuardCodeResponse);
            if (sent.eresult === EResult.OK)
            {
                return;
            }
            if (sent.eresult !== EResult.InvalidLoginAuthCode
                && sent.eresult !== EResult.TwoFactorCodeMismatch)
            {
                throw new Error(`steam: the code was not taken (EResult ${sent.eresult})`);
            }
            onWrongCode?.(sent.eresult);
        }
    };
    try
    {
        return await Promise.race([
            pollSession(connect, { clientId, requestId, interval, signal: both }),
            codes().then(()=>new Promise(()=>{})),
        ]);
    }
    finally
    {
        stop.abort(new Error('signed in'));
    }
}

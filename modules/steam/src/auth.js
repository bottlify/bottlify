/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Signing in with a QR code.
 *
 * The client asks the Authentication service for a session and is given a
 * challenge URL to show as a QR code. The person scans it with the Steam
 * mobile app and approves there: that is their Steam Guard, and no password
 * passes through here. Until they do, the client polls the session; the
 * challenge may be replaced while it waits (the code shown changes), and once
 * approved the poll answers with the account name and a refresh token -- a
 * SteamClient one, which is what a client logs on with.
 */

import {
    Authentication, EResult, GAMING_DEVICE_PC, OS_WINDOWS_10, PLATFORM_STEAM_CLIENT,
} from './messages.js';

/** @typedef {import('./connection.js').CmConnection} CmConnection */

/**
 * @typedef {Object} SignedIn
 * @property {string} accountName
 * @property {string} refreshToken  Logs on now and later; the caller decides
 *           whether and where it is kept.
 */

/** @param {number} ms @param {AbortSignal} [signal] */
const pause = (ms, signal)=>new Promise((resolve, reject)=>{
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', ()=>{
        clearTimeout(timer);
        reject(signal.reason ?? new Error('aborted'));
    }, { once: true });
});

/**
 * Signs in by QR code; resolves once the person has approved it.
 *
 * @param {() => Promise<CmConnection>} connect  An open connection, a new
 *        one when the last has closed: a manager drops a connection that has
 *        not logged on after a minute or so, and the sign-in, which the
 *        service keeps, goes on over the next.
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
    let clientId = /** @type {bigint} */ (begun.body.client_id);
    const requestId = /** @type {Uint8Array} */ (begun.body.request_id);
    const interval = Math.max(1, begun.body.interval ?? 5) * 1000;
    onChallenge(begun.body.challenge_url);
    for (;;)
    {
        await pause(interval, signal);
        const polled = await (await connect()).call('Authentication.PollAuthSessionStatus#1',
            Authentication.PollAuthSessionStatusRequest,
            { client_id: clientId, request_id: requestId },
            Authentication.PollAuthSessionStatusResponse);
        if (polled.eresult !== EResult.OK)
        {
            const expired = polled.eresult === EResult.Expired
                || polled.eresult === EResult.FileNotFound;
            const what = expired ? 'the QR session is gone' : 'the QR sign-in failed';
            const detail = polled.message ? `: ${polled.message}` : '';
            throw new Error(`steam: ${what} (EResult ${polled.eresult}${detail})`);
        }
        const body = polled.body;
        if (body.had_remote_interaction)
        {
            onScanned?.();
        }
        if (body.new_client_id)
        {
            clientId = body.new_client_id;
        }
        if (body.new_challenge_url)
        {
            onChallenge(body.new_challenge_url);
        }
        if (body.refresh_token)
        {
            return { accountName: body.account_name, refreshToken: body.refresh_token };
        }
    }
}

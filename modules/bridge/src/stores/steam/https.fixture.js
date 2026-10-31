/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Steam's authentication over HTTPS, made up for tests: a QR sign-in, and
 * sign-ins by name and password whose Steam Guard is, by account name,
 * - `plain`: none;
 * - `email`: a code by email (`EMAIL1`), sent to the domain it hints;
 * - `device`: a code from the mobile authenticator (`DEV42`) or an approval;
 * - `confirm`: an approval in the app, given at the second poll.
 * The password is `hunter2`, and is read back with the key's private half, so a
 * test sees what Steam would. Each sign-in ends in a token `refresh-<name>-<secret>`.
 */

import { decode, encode } from '../../../../core/src/steam/protobuf.js';
import { Authentication, EResult, Guard } from './messages.js';

export const PASSWORD = 'hunter2';
export const CODES = Object.freeze({ email: 'EMAIL1', device: 'DEV42' });
export const SECRET = 'fixture-secret-signature';
const SUBJECT = btoa(JSON.stringify({ sub: '76561197960265729' })).replace(/=+$/, '');
/** @param {string} name */
export const tokenOf = name=>`eyJhbGciOiJFZERTQSJ9.${SUBJECT}.refresh-${name}-${SECRET}`;

/** @param {string} text */
const bigOf64 = text=>BigInt(`0x${[...atob(text.replace(/-/g, '+').replace(/_/g, '/'))]
    .map(c=>c.charCodeAt(0).toString(16).padStart(2, '0')).join('')}`);

/** @param {bigint} base @param {bigint} power @param {bigint} n */
const modPow = (base, power, n)=>{
    let out = 1n;
    for (base %= n; power > 0n; power >>= 1n, base = (base * base) % n)
    {
        if (power & 1n)
        {
            out = (out * base) % n;
        }
    }
    return out;
};

/** A made-up Steam, and what it was given. */
export async function fakeSteamHttps(){
    const pair = /** @type {CryptoKeyPair} */ (await crypto.subtle.generateKey({ name: 'RSA-OAEP',
        modulusLength: 1024, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true,
    ['encrypt', 'decrypt']));
    const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
    const n = bigOf64(/** @type {string} */ (jwk.n));
    const d = bigOf64(/** @type {string} */ (jwk.d));
    const seen = { passwords: /** @type {string[]} */ ([]), codes: /** @type {string[]} */ ([]),
        urls: /** @type {string[]} */ ([]) };
    /** By client id. @type {Map<bigint, { name: string, approved: boolean, polls: number }>} */
    const sessions = new Map();
    let next = 1n;

    /** @param {string} sealed */
    const unseal = sealed=>{
        let m = modPow(bigOf64(sealed), d, n);
        const bytes = [];
        for (; m > 0n; m >>= 8n)
        {
            bytes.unshift(Number(m & 0xFFn));
        }
        // 0x02, the padding, 0x00, the password (the leading 0x00 is not in the number).
        return new TextDecoder().decode(Uint8Array.from(bytes.slice(bytes.indexOf(0, 1) + 1)));
    };
    /** @param {any} schema @param {Record<string, any>} body @param {number} [eresult] */
    const answer = (schema, body, eresult = EResult.OK)=>new Response(
        /** @type {any} */ (encode(schema, body)), { headers: { 'x-eresult': String(eresult) } });

    /** @type {typeof fetch} */
    const fetchSteam = async(url, init)=>{
        const where = new URL(String(url));
        seen.urls.push(where.pathname);
        const form = where.searchParams.get('input_protobuf_encoded') ?? new URLSearchParams(
            String(init?.body ?? '')).get('input_protobuf_encoded') ?? '';
        const input = Uint8Array.from(atob(form), c=>c.charCodeAt(0));
        const method = where.pathname.split('/')[2];
        if (method === 'GetPasswordRSAPublicKey')
        {
            if (init?.method === 'POST')
            {
                return new Response(null, { status: 405 });
            }
            return answer(Authentication.GetPasswordRSAPublicKeyResponse, {
                publickey_mod: n.toString(16), publickey_exp: '10001', timestamp: 1234n });
        }
        if (method === 'BeginAuthSessionViaQR')
        {
            const id = next++;
            sessions.set(id, { name: 'scanned', approved: true, polls: 0 });
            return answer(Authentication.BeginAuthSessionViaQRResponse, { client_id: id,
                challenge_url: 'https://s.team/q/1/1', request_id: Uint8Array.of(1), interval: 1 });
        }
        if (method === 'BeginAuthSessionViaCredentials')
        {
            const asked = decode(Authentication.BeginAuthSessionViaCredentialsRequest, input);
            const password = unseal(asked.encrypted_password);
            seen.passwords.push(password);
            if (password !== PASSWORD || asked.encryption_timestamp !== 1234n)
            {
                return answer(Authentication.BeginAuthSessionViaCredentialsResponse, {},
                    EResult.InvalidPassword);
            }
            const name = asked.account_name;
            const id = next++;
            sessions.set(id, { name, approved: name === 'plain', polls: 0 });
            /** @type {Record<string, Array<{ confirmation_type: number, associated_message?: string }>>} */
            const guard = {
                plain: [{ confirmation_type: Guard.None }],
                email: [{ confirmation_type: Guard.EmailCode, associated_message: 'example.com' }],
                device: [{ confirmation_type: Guard.DeviceCode },
                    { confirmation_type: Guard.DeviceConfirmation }],
                confirm: [{ confirmation_type: Guard.DeviceConfirmation }],
            };
            return answer(Authentication.BeginAuthSessionViaCredentialsResponse, { client_id: id,
                request_id: Uint8Array.of(2), interval: 1, steamid: 76561197960265729n,
                allowed_confirmations: guard[name] ?? guard.plain });
        }
        if (method === 'UpdateAuthSessionWithSteamGuardCode')
        {
            const asked = decode(Authentication.UpdateAuthSessionWithSteamGuardCodeRequest, input);
            seen.codes.push(asked.code);
            const session = sessions.get(asked.client_id);
            const right = session?.name === 'email' ? asked.code === CODES.email
                && asked.code_type === Guard.EmailCode
                : asked.code === CODES.device && asked.code_type === Guard.DeviceCode;
            if (!session || !right)
            {
                return answer(Authentication.UpdateAuthSessionWithSteamGuardCodeResponse, {},
                    session?.name === 'email' ? EResult.InvalidLoginAuthCode
                        : EResult.TwoFactorCodeMismatch);
            }
            session.approved = true;
            return answer(Authentication.UpdateAuthSessionWithSteamGuardCodeResponse, {});
        }
        if (method === 'PollAuthSessionStatus')
        {
            const asked = decode(Authentication.PollAuthSessionStatusRequest, input);
            const session = sessions.get(asked.client_id);
            if (!session)
            {
                return answer(Authentication.PollAuthSessionStatusResponse, {},
                    EResult.FileNotFound);
            }
            session.polls++;
            if (session.name === 'confirm' && session.polls >= 2)
            {
                session.approved = true;
            }
            return answer(Authentication.PollAuthSessionStatusResponse, session.approved
                ? { had_remote_interaction: true, refresh_token: tokenOf(session.name),
                    account_name: session.name }
                : {});
        }
        return new Response(null, { status: 404 });
    };
    return { fetch: fetchSteam, seen };
}

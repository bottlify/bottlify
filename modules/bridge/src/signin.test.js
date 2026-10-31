/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A store's sign-in page and the worker (serveSignIn) over a port that carries
 * JSON, the worker signing in over a made-up HTTPS Steam: by QR code, and by
 * name and password through each of Steam Guard's paths. What the worker sends
 * the page is read for the token; what Steam was given, for the password.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serveSignIn } from './serve.js';
import { portPair } from './port.fixture.js';
import { signInWithCredentials, signInWithQr } from './stores/steam/auth.js';
import { webApi } from './stores/steam/webapi.js';
import { Guard } from './stores/steam/messages.js';
import { CODES, PASSWORD, SECRET, fakeSteamHttps, tokenOf } from './stores/steam/https.fixture.js';

/**
 * A sign-in from the page's end: `start` sent, then each code in turn when
 * Steam Guard asks for one or refuses the last.
 *
 * @param {Record<string, any>} start
 * @param {Array<{ code: string, type: number }>} [codes]
 */
async function signIn(start, codes = []){
    const steam = await fakeSteamHttps();
    const kept = { session: /** @type {any} */ (null) };
    const api = async()=>/** @type {any} */ (webApi({ fetch: steam.fetch }));
    const pair = portPair();
    serveSignIn(/** @type {any} */ (pair.worker), { store: 'steam', stores: { steam: {
        vault: { get: async()=>kept.session, set: async one=>{
            kept.session = one;
        } },
        qr: options=>signInWithQr(api, options),
        credentials: options=>signInWithCredentials(api, options),
    } } });
    /** @type {Record<string, any>[]} */
    const heard = [];
    const ended = new Promise(resolve=>pair.page.onMessage.addListener((/** @type {any} */ message)=>{
        heard.push(message);
        if (message.event === 'guard' || message.event === 'wrongCode')
        {
            const code = codes.shift();
            if (code)
            {
                pair.page.postMessage(code);
            }
        }
        if (message.done || message.error)
        {
            resolve(message);
        }
    }));
    pair.page.postMessage(start);
    const end = /** @type {Record<string, any>} */ (await ended);
    pair.drop();
    return { end, heard, kept, steam };
}

/** @param {unknown} value */
const text = value=>JSON.stringify(value);

/** The token in nothing the page was sent; kept by the worker. @param {any} run @param {string} name */
const signedInAs = (run, name)=>{
    assert.deepEqual(run.end, { done: { name } });
    assert.equal(run.kept.session.refreshToken, tokenOf(name));
    assert.match(run.kept.session.id, /^[0-9a-f-]{36}$/);
    assert.doesNotMatch(text(run.heard), new RegExp(`${SECRET}|eyJ`), 'no token sent to the page');
};

test('by QR code: the page is sent the challenge and the name', async()=>{
    const run = await signIn({ start: 'qr' });
    signedInAs(run, 'scanned');
    assert.deepEqual(run.heard.filter(one=>one.event).map(one=>one.event),
        ['challenge', 'scanned']);
    assert.equal(run.heard[0].url, 'https://s.team/q/1/1');
});

test('by password without Steam Guard: Steam is given the password sealed under its key', async()=>{
    const run = await signIn({ start: 'credentials', accountName: 'plain', password: PASSWORD });
    signedInAs(run, 'plain');
    assert.deepEqual(run.steam.seen.passwords, [PASSWORD], 'read back with the private key');
    assert.ok(run.steam.seen.urls.includes('/IAuthenticationService/GetPasswordRSAPublicKey/v1/'));
    assert.ok(!run.heard.some(one=>one.event === 'guard'));
});

test('a wrong password is answered as one', async()=>{
    const run = await signIn({ start: 'credentials', accountName: 'plain', password: 'nope' });
    assert.match(run.end.error, /account name or password is wrong \(EResult 5\)/);
    assert.equal(run.kept.session, null);
});

test('an email code: asked with its hint, a wrong one refused, the right one taken', async()=>{
    const run = await signIn({ start: 'credentials', accountName: 'email', password: PASSWORD },
        [{ code: 'WRONG', type: Guard.EmailCode },
            { code: ` ${CODES.email} `, type: Guard.EmailCode }]);
    signedInAs(run, 'email');
    const guard = run.heard.find(one=>one.event === 'guard');
    assert.deepEqual([guard?.types, guard?.hint], [[Guard.EmailCode], 'example.com']);
    assert.equal(run.heard.filter(one=>one.event === 'wrongCode').length, 1);
    assert.deepEqual(run.steam.seen.codes, ['WRONG', CODES.email], 'the code trimmed');
});

test('a mobile authenticator code', async()=>{
    const run = await signIn({ start: 'credentials', accountName: 'device', password: PASSWORD },
        [{ code: CODES.device, type: Guard.DeviceCode }]);
    signedInAs(run, 'device');
    assert.deepEqual(run.heard.find(one=>one.event === 'guard')?.types,
        [Guard.DeviceCode, Guard.DeviceConfirmation]);
});

test('an approval in the Steam app, no code given', async()=>{
    const run = await signIn({ start: 'credentials', accountName: 'confirm', password: PASSWORD });
    signedInAs(run, 'confirm');
    assert.deepEqual(run.steam.seen.codes, []);
});

test('a sign-in stops when its page goes', async()=>{
    const steam = await fakeSteamHttps();
    const pair = portPair();
    let stopped = /** @type {unknown} */ (null);
    serveSignIn(/** @type {any} */ (pair.worker), { store: 'steam', stores: { steam: {
        vault: { get: async()=>null, set: async()=>{} },
        qr: ({ signal })=>new Promise((_resolve, reject)=>signal.addEventListener('abort', ()=>{
            stopped = signal.reason;
            reject(signal.reason);
        })),
        credentials: options=>signInWithCredentials(async()=>/** @type {any} */ (
            webApi({ fetch: steam.fetch })), options),
    } } });
    pair.page.postMessage({ start: 'qr' });
    await new Promise(resolve=>setTimeout(resolve, 10));
    pair.drop();
    assert.match(String(stopped), /the sign-in page went/);
});

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A store's sign-in (signin-flow.js), as its sign-in page runs it, against a
 * made-up Steam authentication service: by QR code, and by name and password through each of
 * Steam Guard's paths. What the page's steps are sent is read for the token;
 * what Steam was given, for the password; the session kept, for the token.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSignIn } from './signin-flow.js';
import { signInWithCredentials, signInWithQr } from './stores/steam/auth.js';
import { Guard } from './stores/steam/messages.js';
import { CODES, PASSWORD, SECRET, fakeSteamAuth, tokenOf } from './stores/steam/auth.fixture.js';

/**
 * A sign-in from the page's end: `start` sent, then each code in turn when
 * Steam Guard asks for one or refuses the last.
 *
 * @param {Record<string, any>} start
 * @param {Array<{ code: string, type: number }>} [codes]
 */
async function signIn(start, codes = []){
    const steam = await fakeSteamAuth();
    const kept = { session: /** @type {any} */ (null) };
    const api = async()=>/** @type {any} */ (steam.service);
    /** @type {Record<string, any>[]} */
    const heard = [];
    /** @type {(end: Record<string, any>) => void} */
    let finish = ()=>{};
    const ended = new Promise(resolve=>{
        finish = resolve;
    });
    const flow = createSignIn({ kept: {
        vault: { set: async one=>{
            kept.session = one;
        } },
        qr: options=>signInWithQr(api, options),
        credentials: options=>signInWithCredentials(api, options),
    }, send: message=>{
        heard.push(message);
        if (message.event === 'guard' || message.event === 'wrongCode')
        {
            const code = codes.shift();
            if (code)
            {
                queueMicrotask(()=>flow.heard(code));
            }
        }
        if (message.done || message.error)
        {
            finish(message);
        }
    } });
    flow.heard(start);
    const end = /** @type {Record<string, any>} */ (await ended);
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

test('a sign-in stops when its page goes, and says nothing after', async()=>{
    let stopped = /** @type {unknown} */ (null);
    /** @type {Record<string, any>[]} */
    const heard = [];
    const flow = createSignIn({ send: message=>heard.push(message), kept: {
        vault: { set: async()=>{} },
        qr: ({ signal })=>new Promise((_resolve, reject)=>signal.addEventListener('abort', ()=>{
            stopped = signal.reason;
            reject(signal.reason);
        })),
        credentials: ()=>Promise.reject(new Error('not asked')),
    } });
    const going = flow.heard({ start: 'qr' });
    flow.stop();
    await going;
    assert.match(String(stopped), /the sign-in page went/);
    assert.deepEqual(heard, []);
});

test('a Steam that stops answering fails the sign-in, which says so', async()=>{
    /** @type {Record<string, any>[]} */
    const heard = [];
    const flow = createSignIn({ send: message=>heard.push(message), kept: {
        vault: { set: async()=>{} },
        qr: ()=>Promise.reject(new Error(
            'steam: Authentication.PollAuthSessionStatus#1 was not answered in 30 s')),
        credentials: ()=>Promise.reject(new Error('not asked')),
    } });
    await flow.heard({ start: 'qr' });
    assert.deepEqual(heard, [{ error:
        'steam: Authentication.PollAuthSessionStatus#1 was not answered in 30 s' }]);
});

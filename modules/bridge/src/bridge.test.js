/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CDN_DOMAINS, createBridge } from './bridge.js';

const TOKEN = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiI3NjU2MTE5Nzk2MDI2NTcyOSJ9.secret-signature';

/** A Steam that answers from memory, and what was asked of it. */
function fakeSteam(){
    const asked = /** @type {string[]} */ ([]);
    const connection = ()=>({ closed: false, close(){
        this.closed = true;
    } });
    return {
        asked,
        connectCm: async()=>connection(),
        logOnAnonymously: async()=>{
            asked.push('anonymous');
            return { steamId: 90071992547409920n };
        },
        logOn: async(/** @type {any} */ _c, /** @type {any} */ session)=>{
            asked.push(`logOn ${session.accountName} ${session.refreshToken === TOKEN}`);
            return { steamId: 76561197960265729n, licenses: [{ package_id: 1 }] };
        },
        ownedApps: async()=>[220, 400],
        depotKey: async(/** @type {any} */ _c, /** @type {number} */ app, /** @type {number} */ depot)=>{
            asked.push(`key ${app} ${depot}`);
            return new Uint8Array(32);
        },
        appOwnershipTicket: async(/** @type {any} */ _c, /** @type {number} */ app)=>{
            asked.push(`ticket ${app}`);
            return app === 400 ? Uint8Array.of(4, 0, 0, 0) : null;
        },
        manifestRequestCode: async(/** @type {any} */ _c, /** @type {number} */ _app,
            /** @type {number} */ _depot, /** @type {bigint} */ gid)=>gid + 1n,
        contentServers: async()=>[
            { host: 'a:443', vhost: 'cache1-fra1.steamcontent.com', type: 'CDN' },
            { host: 'b', vhost: 'steampipe.akamaized.net', type: 'CDN' },
            { host: 'c', vhost: 'lancache.example.org', type: 'SteamCache' },
        ],
        signInWithQr: async(/** @type {any} */ _next, /** @type {any} */ options)=>{
            options.onChallenge('https://s.team/q/1/1');
            options.onScanned();
            return { accountName: 'someone', refreshToken: TOKEN };
        },
    };
}

/** @param {Record<string, boolean>} [platforms] */
function bridgeOver(platforms = { steam: true }){
    const steam = fakeSteam();
    const kept = { session: /** @type {any} */ (null) };
    const store = { get: async()=>kept.session, set: async(/** @type {any} */ s)=>{
        kept.session = s;
    } };
    const bridge = createBridge({ steam, store, managers: async()=>['cm:443'], version: '0.1.0',
        platforms });
    const events = /** @type {any[]} */ ([]);
    /** @param {string} op @param {Record<string, any>} [args] @param {number} [id] */
    const ask = (op, args = {}, id = 1)=>bridge.handle({ id, op, args },
        (event, data)=>events.push({ id, event, data }));
    return { steam, kept, ask, events };
}

test('a sign-in streams its code, keeps the token and answers only the account name', async()=>{
    const { steam, kept, ask, events } = bridgeOver();
    const answer = await ask('signIn');
    assert.deepEqual(answer, { accountName: 'someone' });
    assert.deepEqual(events, [
        { id: 1, event: 'challenge', data: { url: 'https://s.team/q/1/1' } },
        { id: 1, event: 'scanned', data: {} },
    ]);
    assert.equal(kept.session.refreshToken, TOKEN);
    const account = await ask('account');
    assert.deepEqual(account,
        { steamId: '76561197960265729', accountName: 'someone', apps: [220, 400], licenses: 1 });
    // Fresh logs on again rather than answering from the logon held.
    await ask('account');
    await ask('account', { fresh: true });
    assert.equal(steam.asked.filter((/** @type {string} */ one)=>one.startsWith('logOn')).length, 2);
    // Nothing the page was given carries the token.
    assert.doesNotMatch(JSON.stringify([answer, events, account]), /secret-signature|eyJ/);
});

test('without a session the ops log on anonymously and there is no account', async()=>{
    const { steam, ask } = bridgeOver();
    assert.equal((await ask('depotKey', { app: 228980, depot: 228990 })).length, 32);
    assert.equal(await ask('manifestCode', { app: 1, depot: 2, gid: '18446744073709551614' }),
        '18446744073709551615');
    assert.equal(await ask('account'), null);
    // One logon for every op: the connection is held.
    assert.deepEqual(steam.asked, ['anonymous', 'key 228980 228990']);
});

test('signing in or out changes the logon the next op uses', async()=>{
    const { steam, kept, ask } = bridgeOver();
    await ask('depotKey', { app: 1, depot: 2 });
    await ask('signIn');
    await ask('depotKey', { app: 1, depot: 2 });
    await ask('signOut');
    assert.equal(kept.session, null);
    await ask('depotKey', { app: 1, depot: 2 });
    assert.deepEqual(steam.asked, ['anonymous', 'key 1 2', 'logOn someone true', 'key 1 2',
        'anonymous', 'key 1 2']);
});

test('a session another page kept is what the next op logs on with', async()=>{
    const { steam, kept, ask } = bridgeOver();
    await ask('depotKey', { app: 1, depot: 2 });
    kept.session = { accountName: 'elsewhere', refreshToken: TOKEN };
    await ask('depotKey', { app: 1, depot: 2 });
    kept.session = null;
    await ask('depotKey', { app: 1, depot: 2 });
    assert.deepEqual(steam.asked, ['anonymous', 'key 1 2', 'logOn elsewhere true', 'key 1 2',
        'anonymous', 'key 1 2']);
});

test('an ownership ticket is the signed-in account\'s, for an app it owns only', async()=>{
    const { steam, ask } = bridgeOver();
    assert.equal(await ask('appOwnershipTicket', { app: 400 }), null, 'signed out: none');
    await ask('signIn');
    assert.deepEqual(await ask('appOwnershipTicket', { app: 400 }), Uint8Array.of(4, 0, 0, 0));
    assert.equal(await ask('appOwnershipTicket', { app: 480 }), null, 'not owned: none');
    assert.deepEqual(steam.asked.filter(line=>line.startsWith('ticket')),
        ['ticket 400', 'ticket 480']);
});

test('a sign-in is cancelled by its id', async()=>{
    const { steam, ask } = bridgeOver();
    steam.signInWithQr = (_next, options)=>new Promise((_resolve, reject)=>{
        options.signal.addEventListener('abort', ()=>reject(options.signal.reason));
    });
    const going = ask('signIn', {}, 7);
    await ask('cancel', { target: 7 }, 8);
    await assert.rejects(going, /cancelled/);
});

test('only content servers the ruleset opens to the page are offered', async()=>{
    const { ask } = bridgeOver();
    const servers = await ask('contentServers');
    assert.deepEqual(servers.map((/** @type {any} */ s)=>s.vhost),
        ['cache1-fra1.steamcontent.com', 'steampipe.akamaized.net']);
    const rules = JSON.parse(readFileSync(new URL('../rules/steam.json', import.meta.url), 'utf8'));
    const cors = rules.find((/** @type {any} */ rule)=>rule.action.responseHeaders);
    for (const domain of CDN_DOMAINS)
    {
        assert.ok(cors.condition.requestDomains.includes(domain), domain);
    }
});

test('Steam switched off for the site: hello says so and nothing else is answered', async()=>{
    const { steam, ask } = bridgeOver({ steam: false });
    assert.deepEqual(await ask('hello'), { version: '0.1.0', platforms: { steam: false } });
    await assert.rejects(ask('depotKey', { app: 1, depot: 2 }), /switched off/);
    await assert.rejects(ask('signIn'), /switched off/);
    assert.deepEqual(steam.asked, []);
});

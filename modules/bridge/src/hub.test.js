/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * GameHub's hub and its Steam store over a Steam that answers from memory:
 * the store-neutral ops, the session kept apart from what the page is given,
 * the anonymous logon beside an account's, and a store switched off.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHub } from './hub.js';
import { CDN_DOMAINS, steamStore } from './stores/steam/store.js';

const TOKEN = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiI3NjU2MTE5Nzk2MDI2NTcyOSJ9.secret-signature';

/** What Steam tells anyone of an app. @param {number} app */
const appInfo = app=>({
    common: { type: app === 228980 ? 'Config' : 'Game', name: `App ${app}`, icon: 'x' },
    config: app === 70 ? { launch: { 0: { executable: 'bin/game.exe', arguments: '-w' } } } : {},
    extended: app === 70 ? { installscript: 'install.vdf' } : {},
    depots: app === 228980 ? { 228990: { manifests: { public: { gid: '2222', size: '9' } } } }
        : { 1: { manifests: { public: { gid: '5', size: '1000' }, beta: { gid: '6' } } },
            228990: { depotfromapp: '228980' } },
    ufs: { quota: 1 },
});

/** A Steam that answers from memory, and what was asked of it. */
function fakeSteam(){
    const asked = /** @type {string[]} */ ([]);
    const connection = ()=>({ closed: false, anonymous: false, close(){
        this.closed = true;
    } });
    return {
        asked,
        connectCm: async()=>connection(),
        logOnAnonymously: async(/** @type {any} */ link)=>{
            link.anonymous = true;
            asked.push('anonymous');
            return { steamId: 90071992547409920n };
        },
        logOn: async(/** @type {any} */ _c, /** @type {any} */ session)=>{
            asked.push(`logOn ${session.accountName} ${session.refreshToken === TOKEN}`);
            return { steamId: 76561197960265729n, licenses: [{ package_id: 1 }] };
        },
        ownedApps: async()=>[70, 400, 999],
        depotKey: async(/** @type {any} */ _c, /** @type {number} */ app, /** @type {number} */ depot)=>{
            asked.push(`key ${app} ${depot}`);
            return new Uint8Array(32).fill(depot & 0xff);
        },
        appOwnershipTicket: async(/** @type {any} */ _c, /** @type {number} */ app)=>{
            asked.push(`ticket ${app}`);
            return app === 400 ? Uint8Array.of(4, 0, 0, 0) : null;
        },
        manifestRequestCode: async(/** @type {any} */ _c, /** @type {number} */ _app,
            /** @type {number} */ _depot, /** @type {bigint} */ gid)=>gid + 1n,
        /** What Steam tells each logon of apps: an account's, a hash and no data. */
        productInfo: async(/** @type {any} */ link, /** @type {{ apps: number[] }} */ { apps })=>{
            asked.push(`info ${link.anonymous ? 'anonymous' : 'account'} ${apps.join(',')}`);
            return { apps: new Map(apps.filter(app=>app !== 999 && link.anonymous)
                .map(app=>[app, appInfo(app)])) };
        },
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
        fetchClientFiles: async()=>({ version: '1',
            files: { 'steamclient.dll': Uint8Array.of(77, 90) } }),
    };
}

/** @param {Record<string, unknown>} [platforms] */
function hubOver(platforms = {}){
    const steam = fakeSteam();
    const kept = { session: /** @type {any} */ (null) };
    const vault = { get: async()=>kept.session, set: async(/** @type {any} */ one)=>{
        kept.session = one;
    } };
    const hub = createHub({ version: '0.2.0', platforms, stores: { steam: steamStore({ vault,
        steam, socket: ()=>/** @type {any} */ (null), managers: async()=>['cm:443'] }) } });
    const events = /** @type {any[]} */ ([]);
    /** @param {string} op @param {Record<string, any>} [args] @param {number} [id] */
    const ask = (op, args = {}, id = 1)=>hub.handle({ id, op, args: { store: 'steam', ...args } },
        (event, data)=>events.push({ id, event, data }));
    return { steam, kept, ask, events, hub };
}

test('hello names the stores and which the site has on', async()=>{
    assert.deepEqual(await hubOver().ask('hello'),
        { version: '0.2.0', stores: [{ id: 'steam', name: 'Steam', on: true }] });
    const off = hubOver({ steam: false });
    assert.deepEqual((await off.ask('hello')).stores, [{ id: 'steam', name: 'Steam', on: false }]);
    await assert.rejects(off.ask('account'), /Steam is switched off/);
    await assert.rejects(off.ask('signIn'), /switched off/);
    assert.deepEqual(off.steam.asked, [], 'Steam is not spoken to');
    await assert.rejects(hubOver().ask('list', { store: 'gog' }), /no store gog/);
});

test('a sign-in streams its code, keeps the token and answers only the account\'s name', async()=>{
    const { steam, kept, ask, events } = hubOver();
    const answer = await ask('signIn');
    assert.deepEqual(answer, { name: 'someone' });
    assert.deepEqual(events, [
        { id: 1, event: 'challenge', data: { url: 'https://s.team/q/1/1' } },
        { id: 1, event: 'scanned', data: {} },
    ]);
    assert.equal(kept.session.refreshToken, TOKEN);
    assert.deepEqual(await ask('account'), { name: 'someone' });
    await ask('account');
    await ask('account', { fresh: true });
    assert.equal(steam.asked.filter(one=>one.startsWith('logOn')).length, 2,
        'fresh logs on again rather than answering from the logon held');
    const list = await ask('list');
    assert.doesNotMatch(JSON.stringify([answer, events, list]), /secret-signature|eyJ/);
    assert.deepEqual(await ask('signOut'), {});
    assert.equal(kept.session, null);
    assert.equal(await ask('account'), null);
});

test('the list is the account\'s games, as Steam tells anyone of them', async()=>{
    const { steam, kept, ask } = hubOver();
    assert.deepEqual(await ask('list'), [], 'nobody signed in: none');
    kept.session = { accountName: 'someone', refreshToken: TOKEN };
    const list = await ask('list');
    assert.deepEqual(list.map((/** @type {any} */ game)=>({ ...game, covers: undefined })), [
        { id: '400', name: 'App 400', bytes: 1000, exact: false, installable: false,
            covers: undefined },
        { id: '70', name: 'App 70', bytes: 1000, exact: false, installable: true,
            covers: undefined },
    ], 'by name; an app Steam does not describe left out');
    assert.equal(list[1].covers.capsule, await ask('cover', { game: '70', kind: 'capsule' }));
    assert.deepEqual(steam.asked, ['logOn someone true', 'anonymous', 'info anonymous 70,400,999'],
        'product info over an anonymous logon of its own beside the account\'s');
    await ask('list');
    assert.equal(steam.asked.length, 3, 'read a while ago: not asked again');
    assert.equal(await ask('cover', { game: '70', kind: 'capsule' }),
        'https://shared.steamstatic.com/store_item_assets/steam/apps/70/library_600x900.jpg');
});

test('download answers what an install needs, the redistributables under their owner', async()=>{
    const { steam, kept, ask } = hubOver();
    kept.session = { accountName: 'someone', refreshToken: TOKEN };
    const answer = await ask('download', { game: '70' });
    assert.equal(answer.name, 'App 70');
    assert.deepEqual(answer.launch, { executable: 'bin/game.exe', arguments: '-w' });
    assert.equal(answer.installscript, 'install.vdf');
    assert.deepEqual(answer.servers.map((/** @type {any} */ one)=>one.vhost),
        ['cache1-fra1.steamcontent.com', 'steampipe.akamaized.net'],
        'only the content servers the ruleset opens to the page');
    assert.deepEqual(answer.depots.map((/** @type {any} */ one)=>({ ...one, key: one.key[0] })), [
        { depot: 1, gid: '5', shared: false, key: 1, code: '6' },
        { depot: 228990, gid: '2222', shared: true, key: 228990 & 0xff, code: '2223' },
    ]);
    assert.deepEqual(steam.asked.filter(one=>one.startsWith('key')),
        ['key 70 1', 'key 228980 228990']);
    assert.match(answer.art.hero, /\/70\/library_hero\.jpg$/);
    await assert.rejects(ask('download', { game: '999' }), /does not describe app 999/);
    const rules = JSON.parse(readFileSync(new URL('../rules/steam.json', import.meta.url), 'utf8'));
    const cors = rules.find((/** @type {any} */ rule)=>rule.condition.resourceTypes.includes('xmlhttprequest'));
    for (const domain of CDN_DOMAINS)
    {
        assert.ok(cors.condition.requestDomains.includes(domain), domain);
    }
});

test('run data: Steam running for the account, the ticket, Valve\'s client files', async()=>{
    const { steam, kept, ask } = hubOver();
    assert.deepEqual(await ask('runData', { game: '400' }), {}, 'signed out: nothing');
    kept.session = { accountName: 'someone', refreshToken: TOKEN };
    const run = (await ask('runData', { game: '400' })).win32.steam;
    assert.deepEqual([run.steamId, run.accountName, run.apps, run.appId],
        ['76561197960265729', 'someone', [70, 400, 999], 400]);
    assert.deepEqual(run.ownershipTickets, { 400: Uint8Array.of(4, 0, 0, 0) });
    assert.deepEqual(run.clientFiles, { 'steamclient.dll': Uint8Array.of(77, 90) });
    const other = (await ask('runData', { game: '480' })).win32.steam;
    assert.equal(other.ownershipTickets, undefined, 'an app it does not own has no ticket');
    assert.deepEqual(steam.asked.filter(one=>one.startsWith('ticket')),
        ['ticket 400', 'ticket 480']);
    assert.doesNotMatch(JSON.stringify(run), /secret-signature|eyJ/);
});

test('a sign-in is cancelled by its id, and what the page held goes with it', async()=>{
    const { steam, ask, hub } = hubOver();
    steam.signInWithQr = (_next, options)=>new Promise((_resolve, reject)=>{
        options.signal.addEventListener('abort', ()=>reject(options.signal.reason));
    });
    const going = ask('signIn', {}, 7);
    await hub.handle({ id: 8, op: 'cancel', args: { target: 7 } }, ()=>{});
    await assert.rejects(going, /cancelled/);
    const again = ask('signIn', {}, 9);
    hub.close();
    await assert.rejects(again, /the page went/);
});

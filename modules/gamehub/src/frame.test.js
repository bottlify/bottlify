/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The whole path in one process: a page's requests and Steam's session frame
 * with Steam's own protocol code over a connection manager made up here (or a
 * Steam made up at the protocol's level), the session read from the
 * extension's database -- to see where the token goes: into a logon, never
 * to the page.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFrame } from './frame.js';
import { steamStore } from './stores/steam/store.js';
import { fakeSteam } from './stores/steam/steam.fixture.js';
import { FakeSocket } from './socket.fixture.js';
import { buildFrame, parseFrame } from './stores/steam/connection.js';
import {
    ClientLicenseList, ClientLogonResponse, EMsg, PICSProductInfoResponse,
} from './stores/steam/messages.js';
import { encode } from '../../core/src/steam/protobuf.js';
import { TOKEN } from './stores/steam/steam.fixture.js';

const SECRET = 'secret-signature';
const STEAM_ID = 76561197960265729n;

/** A connection manager: answers a logon, a licence list and product info, and keeps every frame. */
class FakeCm extends FakeSocket {
    /** @param {string} url @param {{ logons: number, frames: Uint8Array[] }} seen */
    constructor(url, seen){
        super(url);
        this.seen = seen;
    }

    /** @param {number} emsg @param {Record<string, any>} header @param {Uint8Array} body */
    answer(emsg, header, body){
        const frame = buildFrame(emsg, { steamid: STEAM_ID, client_sessionid: 7, ...header }, body);
        setTimeout(()=>this.onmessage?.({ data: frame.buffer }), 0);
    }

    /** @param {Uint8Array} data */
    send(data){
        super.send(data);
        this.seen.frames.push(new Uint8Array(data));
        const message = parseFrame(new Uint8Array(data));
        if (message?.emsg === EMsg.ClientLogon)
        {
            this.seen.logons++;
            this.answer(EMsg.ClientLogOnResponse, {},
                encode(ClientLogonResponse, { eresult: 1, heartbeat_seconds: 30 }));
            this.answer(EMsg.ClientLicenseList, {},
                encode(ClientLicenseList, { eresult: 1, licenses: [] }));
        }
        else if (message?.emsg === EMsg.ClientPICSProductInfoRequest)
        {
            this.answer(EMsg.ClientPICSProductInfoResponse,
                { jobid_target: message.header.jobid_source },
                encode(PICSProductInfoResponse,
                    { apps: [], packages: [], response_pending: false }));
        }
    }
}

/** Steam's directory, as the frame fetches it. @type {typeof fetch} */
const steamHttps = async url=>(String(url).startsWith('https://api.steampowered.com/ISteamDirectory/')
    ? Response.json({ response: { serverlist: [{ endpoint: 'cm.example:443' }] } })
    : new Response(null, { status: 404 }));

/**
 * A page and Steam's session frame, its session in a database made up.
 *
 * @param {Record<string, any>} [steam]  Steam's protocol made up, in place of the CM made up.
 */
function rig(steam){
    const seen = { logons: 0, frames: /** @type {Uint8Array[]} */ ([]) };
    const disk = { session: /** @type {any} */ ({ accountName: 'someone', refreshToken: TOKEN, id: 'a' }),
        reads: 0 };
    /** @type {FakeCm[]} */
    const sockets = [];
    /** @type {Record<string, any>[]} Everything the page was posted. */
    const page = [];
    const frame = startFrame({ store: 'steam', toPage: answer=>page.push(answer),
        enabled: async()=>['steam'],
        kept: { get: async()=>{
            disk.reads++;
            return disk.session;
        }, set: async one=>{
            disk.session = one;
        } },
        make: vault=>steamStore({ vault, fetch: steamHttps, ...steam ? { steam } : {},
            socket: url=>{
                const one = new FakeCm(url, seen);
                sockets.push(one);
                return /** @type {any} */ (one);
            } }) });
    let next = 0;
    /** @param {string} op @param {Record<string, any>} [args] */
    const ask = async(op, args = {})=>{
        const id = ++next;
        frame.request({ to: 'bottlify-gamehub', id, op, args });
        for (let i = 0; i < 1000; i++)
        {
            const done = page.find(one=>one.id === id && ('result' in one || 'error' in one));
            if (done)
            {
                return done;
            }
            await new Promise(resolve=>setTimeout(resolve, 5));
        }
        throw new Error(`${op} was not answered`);
    };
    return { seen, disk, sockets, page, ask, frame };
}

/** @param {unknown} value */
const text = value=>JSON.stringify(value, (_, one)=>(one instanceof Uint8Array
    ? new TextDecoder('latin1').decode(one) : typeof one === 'bigint' ? String(one) : one));

test('the frame says it is ready, and its token goes into a logon alone', async()=>{
    const { seen, page, ask, frame } = rig();
    frame.ready();
    assert.deepEqual(page[0], { from: 'bottlify-gamehub', ready: true });
    assert.deepEqual((await ask('account', { store: 'steam' })).result, { name: 'someone' });
    assert.deepEqual((await ask('list', { store: 'steam' })).result, []);
    assert.deepEqual((await ask('account', { store: 'steam', fresh: true })).result,
        { name: 'someone' });
    assert.equal(seen.logons, 2);
    const logons = seen.frames.filter(one=>text(one).includes(SECRET));
    assert.equal(logons.length, 2, 'each put into a logon');
    assert.ok(logons.every(one=>parseFrame(one)?.emsg === EMsg.ClientLogon));
    assert.doesNotMatch(text(page), new RegExp(`${SECRET}|eyJ`), 'nothing the page was posted');
    frame.close();
});

test('every op an account has: the token in nothing the page is posted', async()=>{
    const steam = fakeSteam();
    const { page, ask, frame } = rig(steam);
    assert.deepEqual((await ask('account', { store: 'steam' })).result, { name: 'someone' });
    assert.equal((await ask('list', { store: 'steam' })).result.length, 2);
    const download = (await ask('download', { store: 'steam', game: '70' })).result;
    assert.equal(download.depots.length, 2, 'keys and codes given');
    const run = (await ask('runData', { store: 'steam', game: '400' })).result.win32.steam;
    assert.ok(run.ownershipTickets[400] && run.clientFiles['steamclient.dll']);
    assert.ok(page.every(one=>!('error' in one)), JSON.stringify(page.filter(one=>one.error)));
    assert.doesNotMatch(text(page), new RegExp(`${SECRET}|eyJ`), 'nothing the page was posted');
    assert.equal(steam.asked.filter(one=>one.startsWith('logOn')).length, 1);
    assert.deepEqual((await ask('signOut', { store: 'steam' })).result, {});
    assert.equal((await ask('account', { store: 'steam' })).result, null);
    frame.close();
});

test('a sign-in elsewhere: the next op logs on with the new session', async()=>{
    const { seen, disk, ask, frame } = rig();
    assert.deepEqual((await ask('account', { store: 'steam' })).result, { name: 'someone' });
    disk.session = { accountName: 'other', refreshToken: TOKEN, id: 'b' };
    assert.deepEqual((await ask('account', { store: 'steam' })).result, { name: 'other' });
    assert.equal(seen.logons, 2);
    frame.close();
});

test('what the frame refuses, and a store switched off', async()=>{
    const { ask, frame } = rig();
    assert.match((await ask('signIn', { store: 'steam' })).error, /no op signIn/);
    assert.match((await ask('depotKey', { app: 1, depot: 2 })).error, /no op depotKey/);
    assert.match((await ask('account', { store: 'gog' })).error, /no store gog/);
    assert.match((await ask('account', { store: 'Steam!' })).error, /store is not a valid store/);
    frame.close();
    /** @type {Record<string, any>[]} */
    const page = [];
    const off = startFrame({ store: 'steam', toPage: answer=>page.push(answer),
        enabled: async()=>[], kept: { get: async()=>null, set: async()=>{} },
        make: vault=>steamStore({ vault, fetch: steamHttps }) });
    await off.request({ to: 'bottlify-gamehub', id: 1, op: 'account', args: { store: 'steam' } });
    assert.match(page[0].error, /Steam is switched off/);
});

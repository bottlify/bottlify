/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The whole path in one process: a page's requests, GameHub in the tab with
 * Steam's own protocol code over a connection manager made up here, a JSON
 * port, and the worker keeping the session -- to see where the token goes, and
 * that a worker stopped and started again still gives a logon its token.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTab } from './tab.js';
import { FETCHED, serveTab } from './serve.js';
import { createWire } from './wire.js';
import { FakeSocket, portPair } from './port.fixture.js';
import { buildFrame, parseFrame } from './stores/steam/connection.js';
import {
    ClientLicenseList, ClientLogonResponse, EMsg, PICSProductInfoResponse,
} from './stores/steam/messages.js';
import { encode } from '../../core/src/steam/protobuf.js';

const SECRET = 'not-a-signature-but-the-secret-part';
const TOKEN = `eyJhbGciOiJFZERTQSJ9.${Buffer.from('{"sub":"76561197960265729"}')
    .toString('base64url')}.${SECRET}`;
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

/** Steam's directory, as the worker fetches it. @type {typeof fetch} */
const steamHttps = async url=>(String(url).startsWith(FETCHED[0])
    ? Response.json({ response: { serverlist: [{ endpoint: 'cm.example:443' }] } })
    : new Response(null, { status: 404 }));

/**
 * A page, GameHub in its tab, and the worker: each port served by a worker
 * started anew, as Chrome starts one after it stopped, over one database.
 *
 */
function rig(){
    const seen = { logons: 0, frames: /** @type {Uint8Array[]} */ ([]) };
    /** The worker's database: what outlives the worker. */
    const disk = { session: /** @type {any} */ ({ accountName: 'someone', refreshToken: TOKEN, id: 'a' }) };
    const stores = { steam: {
        vault: { get: async()=>disk.session, set: async(/** @type {any} */ one)=>{
            disk.session = one;
        } },
        qr: ()=>Promise.reject(new Error('signs in from its own page')),
        credentials: ()=>Promise.reject(new Error('signs in from its own page')),
    } };
    /** @type {ReturnType<typeof portPair>[]} */
    const pairs = [];
    /** @type {FakeCm[]} */
    const sockets = [];
    /** @type {Record<string, any>[]} Everything the page was posted. */
    const page = [];
    const tab = startTab({ version: '0.2.0', platforms: {},
        toPage: answer=>page.push(answer),
        socket: url=>{
            const one = new FakeCm(url, seen);
            sockets.push(one);
            return /** @type {any} */ (one);
        },
        connect: ()=>{
            const pair = portPair();
            pairs.push(pair);
            serveTab(/** @type {any} */ (pair.worker),
                { switch: async()=>({ steam: true }), stores, fetch: steamHttps });
            return pair.page;
        } });
    let next = 0;
    /** @param {string} op @param {Record<string, any>} [args] */
    const ask = async(op, args = {})=>{
        const id = ++next;
        tab.request({ to: 'bottlify-bridge', id, op, args });
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
    /** Every message the ports carried, read back as their ends read them. */
    const carried = ()=>pairs.flatMap(pair=>{
        const reader = createWire(()=>{});
        return pair.carried.flatMap(({ raw })=>{
            const message = reader.receive(raw);
            return message ? [message] : [];
        });
    });
    return { seen, disk, pairs, sockets, page, ask, carried, tab };
}

/** @param {unknown} value */
const text = value=>JSON.stringify(value, (_, one)=>(one instanceof Uint8Array
    ? new TextDecoder('latin1').decode(one) : typeof one === 'bigint' ? String(one) : one));

test('the token is asked of the worker for a logon alone, and the page is given none', async()=>{
    const { seen, pairs, page, ask, carried, tab } = rig();
    assert.deepEqual((await ask('hello')).result.stores,
        [{ id: 'steam', name: 'Steam', on: true }]);
    assert.deepEqual((await ask('account', { store: 'steam' })).result, { name: 'someone' });
    assert.deepEqual((await ask('list', { store: 'steam' })).result, []);
    assert.deepEqual((await ask('account', { store: 'steam', fresh: true })).result,
        { name: 'someone' });
    assert.equal(seen.logons, 2);

    const messages = carried();
    const asked = new Map(messages.filter(one=>one.ask).map(one=>[one.ask.id, one.ask.op]));
    const carrying = messages.filter(one=>text(one).includes(SECRET));
    assert.deepEqual(carrying.map(one=>asked.get(one.answer?.id)), ['token', 'token'],
        'over the port: only the answers to `token`, one a logon');
    const logons = seen.frames.filter(frame=>text(frame).includes(SECRET));
    assert.equal(logons.length, 2, 'each put into a logon');
    assert.ok(logons.every(frame=>parseFrame(frame)?.emsg === EMsg.ClientLogon));
    assert.doesNotMatch(text(page), new RegExp(`${SECRET}|eyJ`), 'nothing the page was posted');
    pairs.at(-1)?.drop();
    tab.close();
});

test('a page cannot sign in through the tab', async()=>{
    const { ask, pairs, tab } = rig();
    assert.match((await ask('signIn', { store: 'steam' })).error, /no op signIn/);
    assert.match((await ask('cancel', { target: 1 })).error, /no op cancel/);
    pairs.at(-1)?.drop();
    tab.close();
});

test('after the worker stopped, the CM session goes on and a logon is given its token', async()=>{
    const { seen, pairs, sockets, page, ask, tab } = rig();
    assert.deepEqual((await ask('account', { store: 'steam' })).result, { name: 'someone' });
    assert.equal(seen.logons, 1);
    pairs[0].drop();
    assert.equal(sockets[0].closed, false, 'the tab\'s socket is not the worker\'s');
    assert.deepEqual((await ask('account', { store: 'steam' })).result, { name: 'someone' });
    assert.equal(seen.logons, 1, 'the logon held');
    assert.equal(pairs.length, 2, 'a new port to a worker started again');
    pairs[1].drop();
    assert.deepEqual((await ask('account', { store: 'steam', fresh: true })).result,
        { name: 'someone' });
    assert.equal(seen.logons, 2, 'a logon with the token the new worker read');
    assert.ok(page.every(one=>!('error' in one)));
    pairs.at(-1)?.drop();
    tab.close();
});

test('what the tab and the worker refuse', async()=>{
    const { ask, pairs, tab } = rig();
    assert.match((await ask('depotKey', { app: 1, depot: 2 })).error, /no op depotKey/);
    assert.match((await ask('account', { store: 'gog' })).error, /no store gog/);
    assert.match((await ask('account', { store: 'Steam!' })).error, /store is not a valid store/);
    pairs.at(-1)?.drop();
    tab.close();

    const pair = portPair();
    serveTab(/** @type {any} */ (pair.worker), { switch: async()=>({}), stores: {},
        fetch: steamHttps });
    const wire = createWire(raw=>pair.page.postMessage(raw));
    /** @type {Record<string, any>[]} */
    const answers = [];
    pair.page.onMessage.addListener((/** @type {any} */ raw)=>answers.push(wire.receive(raw)?.answer));
    wire.send({ ask: { id: 1, op: 'fetch', args: { url: 'https://example.com/' } } });
    wire.send({ ask: { id: 2, op: 'token', args: { store: 'gog' } } });
    wire.send({ ask: { id: 3, op: 'eval', args: {} } });
    await new Promise(resolve=>setTimeout(resolve, 20));
    assert.deepEqual(answers.map(one=>one.error).sort(), ['GameHub does not fetch https://example.com/',
        'GameHub has no store gog', 'no op eval']);
});

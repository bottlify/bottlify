/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The whole path in one process: a page's request, the content script's pipe,
 * a JSON port, the worker's hub and its Steam store with Steam's own protocol
 * code, the socket the pipe opens, and a connection manager made up here --
 * to see what crosses the port and what the page is answered.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPipe } from './pipe.js';
import { servePort } from './serve.js';
import { createWire } from './wire.js';
import { FakeSocket, portPair } from './port.fixture.js';
import { STEAM, steamStore } from './stores/steam/store.js';
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

/** @param {Uint8Array} haystack @param {Uint8Array} needle */
const contains = (haystack, needle)=>{
    outer: for (let at = 0; at + needle.length <= haystack.length; at++)
    {
        for (let i = 0; i < needle.length; i++)
        {
            if (haystack[at + i] !== needle[i])
            {
                continue outer;
            }
        }
        return true;
    }
    return false;
};

/**
 * A page, its content script and the worker, each port's worker end served as
 * GameHub's worker serves it.
 */
function rig(){
    const seen = { logons: 0, frames: /** @type {Uint8Array[]} */ ([]) };
    const kept = { session: /** @type {any} */ ({ accountName: 'someone', refreshToken: TOKEN }) };
    const vault = { get: async()=>kept.session, set: async(/** @type {any} */ one)=>{
        kept.session = one;
    } };
    /** @type {ReturnType<typeof portPair>[]} */
    const pairs = [];
    /** @type {FakeCm[]} */
    const sockets = [];
    /** @type {Record<string, any>[]} */
    const page = [];
    const pipe = startPipe({ platforms: {}, toPage: answer=>page.push(answer),
        socket: url=>{
            const one = new FakeCm(url, seen);
            sockets.push(one);
            return /** @type {any} */ (one);
        },
        connect: ()=>{
            const pair = portPair();
            pairs.push(pair);
            servePort(/** @type {any} */ (pair.worker), { version: '0.2.0', switch: async()=>({ steam: true }),
                stores: socket=>({ steam: steamStore({ vault, socket, steam: STEAM,
                    managers: async()=>['cm.example:443'],
                    fetch: async()=>new Response(null, { status: 404 }) }) }) });
            return pair.page;
        } });
    let next = 0;
    /** @param {string} op @param {Record<string, any>} [args] */
    const ask = async(op, args = {})=>{
        const id = ++next;
        pipe.request({ to: 'bottlify-bridge', id, op, args });
        for (let i = 0; i < 400; i++)
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
    return { seen, kept, pairs, sockets, page, ask };
}

test('the token crosses the port only inside a logon frame, never to the page', async()=>{
    const { seen, pairs, page, ask } = rig();
    assert.deepEqual((await ask('hello')).result.stores,
        [{ id: 'steam', name: 'Steam', on: true }]);
    assert.deepEqual((await ask('account', { store: 'steam' })).result, { name: 'someone' });
    assert.equal(seen.logons, 1);

    const token = new TextEncoder().encode(TOKEN);
    const secret = new TextEncoder().encode(SECRET);
    // Every message the port carried, either way, read back as the ends read it.
    const reader = createWire(()=>{});
    const frames = [];
    let elsewhere = '';
    for (const { raw } of pairs[0].carried)
    {
        const message = reader.receive(raw);
        if (!message)
        {
            continue;
        }
        const data = message.send?.data ?? message.frame?.data;
        if (data)
        {
            frames.push(data);
        }
        else
        {
            elsewhere += JSON.stringify(message, (_, value)=>(value instanceof Uint8Array
                ? new TextDecoder('latin1').decode(value) : value));
        }
    }
    const carrying = frames.filter(frame=>contains(frame, secret));
    assert.equal(carrying.length, 1, 'one frame carries the token');
    assert.equal(parseFrame(carrying[0])?.emsg, EMsg.ClientLogon, 'the logon');
    assert.ok(contains(carrying[0], token));
    assert.doesNotMatch(elsewhere, new RegExp(SECRET), 'in nothing else the port carried');
    assert.doesNotMatch(JSON.stringify(page), new RegExp(SECRET), 'and nothing the page was given');
    assert.ok(seen.frames.some(frame=>contains(frame, secret)), 'the CM had it');
    pairs[0].drop();
});

test('a worker that stopped is connected again by the next request, which logs on again', async()=>{
    const { seen, pairs, sockets, page, ask } = rig();
    assert.deepEqual((await ask('account', { store: 'steam' })).result, { name: 'someone' });
    assert.equal(seen.logons, 1);
    pairs[0].drop();
    assert.equal(sockets[0].closed, true, 'the page closes the socket with the port');
    assert.deepEqual((await ask('account', { store: 'steam' })).result, { name: 'someone' });
    assert.equal(pairs.length, 2, 'a new port');
    assert.equal(seen.logons, 2, 'a logon over a socket of its own');
    assert.equal(sockets.length, 2);
    assert.ok(page.every(one=>!('error' in one)));
    pairs[1].drop();
});

test('a store the site switches off is refused, and an op not in the protocol is too', async()=>{
    const { ask, pairs } = rig();
    assert.match((await ask('depotKey', { app: 1, depot: 2 })).error, /no op depotKey/);
    assert.match((await ask('account', { store: 'gog' })).error, /no store gog/);
    assert.match((await ask('account', { store: 'Steam!' })).error, /store is not a valid store/);
    pairs[0].drop();
});

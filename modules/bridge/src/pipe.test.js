/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The content script's pipe (pipe.js) and the worker's relayed sockets
 * (relay.js), over a port that carries JSON as a runtime port does.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPipe } from './pipe.js';
import { createRelay } from './relay.js';
import { createWire } from './wire.js';
import { FakeSocket, portPair } from './port.fixture.js';

const tick = ()=>new Promise(resolve=>setTimeout(resolve, 5));

test('the pipe opens the worker\'s sockets and carries their frames both ways', async()=>{
    const pair = portPair();
    /** @type {FakeSocket[]} */
    const sockets = [];
    const pipe = startPipe({ connect: ()=>pair.page, toPage: ()=>{}, platforms: { steam: true },
        socket: url=>{
            const one = new FakeSocket(url);
            sockets.push(one);
            return /** @type {any} */ (one);
        } });
    const wire = createWire(raw=>pair.worker.postMessage(raw));
    const relay = createRelay(message=>wire.send(message));
    /** @type {Record<string, any>[]} What the worker heard that was not a socket's. */
    const heard = [];
    pair.worker.onMessage.addListener((/** @type {any} */ raw)=>{
        const message = wire.receive(raw);
        if (message && !relay.heard(message))
        {
            heard.push(message);
        }
    });
    /** @type {any[]} */
    const events = [];

    pipe.request({ id: 1 });
    await tick();
    assert.deepEqual(heard.map(one=>Object.keys(one)[0]), ['hello', 'request'],
        'the site\'s switches first, then the request');
    assert.deepEqual(heard[0].hello.platforms, { steam: true });

    const socket = relay.socket('wss://cm.example:443/cmsocket/');
    socket.onopen = ()=>events.push('open');
    socket.onmessage = (/** @type {any} */ event)=>events.push(new Uint8Array(event.data));
    socket.onclose = (/** @type {any} */ event)=>events.push(`closed ${event.code}`);
    await tick();
    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].url, 'wss://cm.example:443/cmsocket/');
    assert.equal(sockets[0].binaryType, 'arraybuffer');
    assert.deepEqual(events, ['open']);

    const out = Uint8Array.from({ length: 300 }, (_, i)=>i & 0xff);
    socket.send(out);
    await tick();
    assert.deepEqual(sockets[0].sent, [out], 'worker to page, as it was');

    const big = Uint8Array.from({ length: 9 * 2 ** 20 + 5 }, (_, i)=>(i * 7) & 0xff);
    for (const frame of [Uint8Array.of(1, 2, 3), big])
    {
        sockets[0].onmessage({ data: frame.buffer });
    }
    await tick();
    assert.deepEqual(events.slice(1), [Uint8Array.of(1, 2, 3), big], 'page to worker, as it was');
    assert.ok(pair.carried.every(({ raw })=>JSON.stringify(raw).length < 6 * 2 ** 20),
        'a large frame crosses in pieces');

    socket.close();
    await tick();
    await tick();
    assert.equal(sockets[0].closed, true);
    assert.equal(events.at(-1), 'closed 1000');
});

test('a dropped port closes its sockets and fails its requests; the next reconnects',
    async()=>{
        /** @type {ReturnType<typeof portPair>[]} */
        const pairs = [];
        /** @type {FakeSocket[]} */
        const sockets = [];
        /** @type {Record<string, any>[]} */
        const page = [];
        const pipe = startPipe({ platforms: {}, toPage: answer=>page.push(answer),
            connect: ()=>{
                const pair = portPair();
                pairs.push(pair);
                return pair.page;
            },
            socket: url=>{
                const one = new FakeSocket(url);
                sockets.push(one);
                return /** @type {any} */ (one);
            } });
        pipe.request({ id: 1 });
        const wire = createWire(raw=>pairs[0].worker.postMessage(raw));
        wire.send({ open: { socket: 1, url: 'wss://cm.example/cmsocket/' } });
        wire.send({ reply: { id: 1, event: 'challenge', data: { url: 'x' } } });
        await tick();
        assert.deepEqual(page, [{ id: 1, event: 'challenge', data: { url: 'x' } }]);
        assert.equal(sockets.length, 1);

        pairs[0].drop();
        assert.equal(sockets[0].closed, true, 'the socket goes with the port');
        assert.deepEqual(page.at(-1), { id: 1, error: 'GameHub was restarted; ask again' });

        pipe.request({ id: 2 });
        assert.equal(pairs.length, 2, 'a new port');
        await tick();
        const second = pairs[1].carried.filter(({ to })=>to === 'worker')
            .map(({ raw })=>Object.keys(raw.$message ?? {})[0]);
        assert.deepEqual(second, ['hello', 'request'], 'said hello again');
    });

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The relay on a port: what it admits before a link is a peer.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createRelayServer } from './index.js';

/**
 * Whether a WebSocket to this port opens, or is refused.
 *
 * @param {number} port @param {any} t
 * @returns {Promise<boolean>}
 */
function opens(port, t){
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    t.after(()=>socket.close());
    return new Promise(resolve=>{
        socket.addEventListener('open', ()=>resolve(true), { once: true });
        socket.addEventListener('error', ()=>resolve(false), { once: true });
    });
}

test('one address cannot hold more links than it is allowed', async t=>{
    const relay = createRelayServer({ port: 0, maxConnectionsPerAddress: 2 });
    const port = await relay.listen();
    t.after(()=>relay.close());

    assert.ok(await opens(port, t));
    assert.ok(await opens(port, t));
    assert.equal(await opens(port, t), false);
    assert.equal(relay.diagnostics().links, 2);
});

test('the relay holds no more links than allowed, and a closed one frees its place', async t=>{
    const relay = createRelayServer({ port: 0, maxConnections: 1 });
    const port = await relay.listen();
    t.after(()=>relay.close());

    const first = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise(resolve=>first.addEventListener('open', resolve, { once: true }));
    assert.equal(await opens(port, t), false);

    first.close();
    await waitFor(()=>relay.diagnostics().links === 0);
    assert.ok(await opens(port, t));
});

test('the address a link is counted under can come from the proxy in front', async t=>{
    /** @type {string[]} */
    const asked = [];
    const relay = createRelayServer({
        port: 0, maxConnectionsPerAddress: 1,
        addressOf: request=>{
            asked.push(String(request.headers.host));
            return 'one';
        },
    });
    const port = await relay.listen();
    t.after(()=>relay.close());

    assert.ok(await opens(port, t));
    assert.equal(await opens(port, t), false, 'two links named by the proxy as one address');
    assert.ok(asked.length >= 2);
});

test('the pages admitted can be decided per request', async t=>{
    /** @type {string[]} */
    const hosts = [];
    let admit = false;
    const relay = createRelayServer({
        port: 0,
        origins: request=>{
            hosts.push(String(request.headers.host));
            return admit;
        },
    });
    const port = await relay.listen();
    t.after(()=>relay.close());

    assert.equal(await opens(port, t), false, 'refused when the answer is no');
    admit = true;
    assert.ok(await opens(port, t));
    assert.ok(hosts.every(host=>host === `127.0.0.1:${port}`), 'asked with the request it judges');
});

/** @param {() => any} ready */
async function waitFor(ready, within = 4000){
    const until = Date.now() + within;
    for (;;)
    {
        if (ready())
        {
            return;
        }
        if (Date.now() > until)
        {
            throw new Error('timed out');
        }
        await new Promise(resolve=>setTimeout(resolve, 5));
    }
}

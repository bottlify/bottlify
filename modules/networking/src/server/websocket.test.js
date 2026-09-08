/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The handshake and the framing, against a client nobody here wrote.
 *
 * Node's own WebSocket is the point of these: a framer tested only against its
 * own encoder agrees with itself and with nothing else, which is exactly the
 * mistake worth ruling out when the protocol is somebody else's specification.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createWebSocketServer } from './websocket.js';

/**
 * A listening server, and a client already connected to it.
 *
 * @param {any} t
 * @param {{ allow?: (request: any) => boolean }} [options]
 */
async function pair(t, options = {}){
    /** @type {any[]} */
    const received = [];
    /** @type {any} */
    let connection = null;
    let closed = 0;

    const server = createWebSocketServer({ port: 0, allow: options.allow }, made=>{
        connection = made;
        made.on('message', (/** @type {any} */ data, /** @type {boolean} */ binary)=>
            received.push({ data, binary }));
        made.on('close', ()=>{
            closed++;
        });
    });
    const port = await server.listen();
    t.after(()=>server.close());

    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    client.binaryType = 'arraybuffer';
    /** @type {any[]} */
    const fromServer = [];
    client.addEventListener('message', event=>fromServer.push(event.data));
    t.after(()=>client.close());

    await new Promise((resolve, reject)=>{
        client.addEventListener('open', resolve, { once: true });
        client.addEventListener('error', ()=>reject(new Error('never connected')),
            { once: true });
    });

    return {
        client,
        received,
        fromServer,
        get connection(){
            return connection;
        },
        get closed(){
            return closed;
        },
    };
}

/** @param {() => any} ready */
async function waitFor(ready, within = 4000){
    const until = Date.now() + within;
    for (;;)
    {
        const answer = ready();
        if (answer)
        {
            return answer;
        }
        if (Date.now() > until)
        {
            throw new Error('timed out');
        }
        await new Promise(resolve=>setTimeout(resolve, 5));
    }
}

test('the handshake completes and text arrives as text', async t=>{
    const { client, received } = await pair(t);

    client.send('hello there');
    await waitFor(()=>received.length > 0);

    assert.equal(received[0].binary, false);
    assert.equal(received[0].data, 'hello there');
});

test('binary arrives as bytes, unmasked correctly', async t=>{
    // A client always masks and a server that skips the unmask reads noise --
    // noise that still has the right length, which is what makes it survive a
    // careless test.
    const { client, received } = await pair(t);
    const payload = new Uint8Array(300);
    for (let at = 0; at < payload.length; at++)
    {
        payload[at] = (at * 7) & 0xff;
    }

    client.send(payload);
    await waitFor(()=>received.length > 0);

    assert.equal(received[0].binary, true);
    assert.deepEqual([...received[0].data], [...payload]);
});

test('a message needing a 16-bit length survives', async t=>{
    const { client, received } = await pair(t);
    const payload = new Uint8Array(1000).fill(0xab);

    client.send(payload);
    await waitFor(()=>received.length > 0);

    assert.equal(received[0].data.length, 1000);
});

test('a message needing a 64-bit length survives', async t=>{
    // Over 65535 the length field changes shape again, and the high word has to
    // be read even though it is always zero here.
    const { client, received } = await pair(t);
    const payload = new Uint8Array(70000).fill(0xcd);

    client.send(payload);
    await waitFor(()=>received.length > 0);

    assert.equal(received[0].data.length, 70000);
    assert.equal(received[0].data[69999], 0xcd);
});

test('two messages in one read are two messages', async t=>{
    // A socket delivers bytes, not frames. Small sends coalesce, and a framer
    // that assumes one read is one frame loses everything after the first.
    const { client, received } = await pair(t);

    client.send('one');
    client.send('two');
    client.send('three');
    await waitFor(()=>received.length === 3);

    assert.deepEqual(received.map(entry=>entry.data), ['one', 'two', 'three']);
});

test('the server can send both kinds back', async t=>{
    const held = await pair(t);
    const connection = await waitFor(()=>held.connection);

    connection.sendText('from the server');
    connection.sendBinary(new Uint8Array([4, 5, 6]));
    await waitFor(()=>held.fromServer.length === 2);

    assert.equal(held.fromServer[0], 'from the server');
    assert.deepEqual([...new Uint8Array(held.fromServer[1])], [4, 5, 6]);
});

test('a close from the server reaches the client and is reported once', async t=>{
    const held = await pair(t);
    const connection = await waitFor(()=>held.connection);
    const closedClient = new Promise(resolve=>
        held.client.addEventListener('close', resolve, { once: true }));

    connection.close();
    connection.close();
    await closedClient;

    assert.equal(held.closed, 1, 'closing twice is one close, not two');
});

test('a client going away is reported', async t=>{
    const held = await pair(t);
    await waitFor(()=>held.connection);

    held.client.close();
    await waitFor(()=>held.closed > 0);

    assert.equal(held.closed, 1);
});

test('a refused origin never becomes a connection', async t=>{
    const server = createWebSocketServer({ port: 0, allow: ()=>false }, ()=>{
        assert.fail('the upgrade should not have been accepted');
    });
    const port = await server.listen();
    t.after(()=>server.close());

    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise(resolve=>{
        client.addEventListener('error', resolve, { once: true });
        client.addEventListener('close', resolve, { once: true });
    });
});

test('a plain GET is answered, so a health check does not look like a fault', async t=>{
    const server = createWebSocketServer({ port: 0 }, ()=>{});
    const port = await server.listen();
    t.after(()=>server.close());

    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /relay/);
});

test('closing the server with a peer still connected finishes', async t=>{
    // An upgraded socket never ends by itself, so http.close() on its own waits
    // for it forever: the shutdown hangs until something kills the process.
    const server = createWebSocketServer({ port: 0 }, ()=>{});
    const port = await server.listen();
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    t.after(()=>client.close());
    await new Promise(resolve=>client.addEventListener('open', resolve, { once: true }));

    await Promise.race([
        server.close(),
        new Promise((_, reject)=>setTimeout(()=>reject(new Error('close hung')), 3000)),
    ]);
});

test('writing to a closed connection is ignored rather than thrown', async t=>{
    const held = await pair(t);
    const connection = await waitFor(()=>held.connection);

    connection.close();
    connection.sendBinary(new Uint8Array([1]));
    connection.sendText('x');
});

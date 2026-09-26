/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The routing, driven directly.
 *
 * A peer here is three functions and a list, so every case that matters -- a
 * refusal, a room filling up, a peer vanishing while a dial is in flight -- is
 * an ordinary test rather than something that needs a port and a wait.
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import test from 'node:test';

import {
    BROADCAST, FLAG_HALF, FLAG_REJECT, FLAG_STREAM, Op, PROTOCOL_VERSION, Wsa,
    decodeControl, decodeFrame, encodeControl, encodeFrame, formatIp, parseIp, unpackAddresses,
    unpackError,
} from '../protocol.js';
import { createRelay } from './relay.js';

/**
 * A peer that records what the relay said to it.
 *
 * @param {any} relay
 */
function join(relay, room = 'room', { silent = false } = {}){
    /** @type {any[]} */
    const frames = [];
    /** @type {any[]} */
    const control = [];
    let disconnected = false;

    const session = relay.connect({
        sendBinary: (/** @type {Uint8Array} */ bytes)=>frames.push(decodeFrame(bytes)),
        sendText: (/** @type {string} */ text)=>control.push(decodeControl(text)),
        disconnect: ()=>{
            disconnected = true;
        },
    });

    if (!silent)
    {
        session.message(
            encodeControl({ t: 'hello', protocol: PROTOCOL_VERSION, room }), false);
    }

    return {
        session,
        frames,
        control,
        get disconnected(){
            return disconnected;
        },
        get address(){
            const welcome = control.find(message=>message?.t === 'welcome');
            return welcome ? parseIp(welcome.address) : 0;
        },
        /** @param {Partial<import('../protocol.js').Frame> & { op: number }} frame */
        send(frame){
            session.message(encodeFrame(frame), true);
        },
        /** @param {number} op */
        first(op){
            return frames.find(frame=>frame?.op === op) ?? null;
        },
        /** @param {number} op */
        all(op){
            return frames.filter(frame=>frame?.op === op);
        },
    };
}

/** Lets the relay's own promises settle -- the policy check is asynchronous. */
const settle = ()=>new Promise(resolve=>setImmediate(resolve));

test('a peer is welcomed onto its room network with an address of its own', ()=>{
    const relay = createRelay();
    const first = join(relay);
    const second = join(relay);

    assert.equal(first.control[0].t, 'welcome');
    assert.equal(first.control[0].address, '10.86.0.1');
    assert.equal(second.control[0].address, '10.86.0.2');
    assert.deepEqual(second.control[0].peers, ['10.86.0.1'],
        'the second peer is told who was already there');
    assert.deepEqual(first.control[1], { t: 'peer', address: '10.86.0.2', joined: true });
});

test('an address is reused once its peer has gone', ()=>{
    const relay = createRelay();
    const first = join(relay);
    join(relay);
    first.session.close();

    assert.equal(join(relay).control[0].address, '10.86.0.1');
});

test('leaving is announced to whoever is left', ()=>{
    const relay = createRelay();
    const first = join(relay);
    const second = join(relay);
    second.session.close();

    assert.deepEqual(first.control.at(-1), {
        t: 'peer', address: '10.86.0.2', joined: false,
    });
});

test('two rooms cannot see each other', ()=>{
    const relay = createRelay();
    const here = join(relay, 'here');
    const there = join(relay, 'there');

    assert.deepEqual(here.control[0].peers, []);
    assert.deepEqual(there.control[0].peers, [],
        'a room is an isolation boundary, not a label');
    assert.equal(here.control.length, 1, 'nobody was told about the other room');

    there.send({ op: Op.LISTEN, toPort: 6112 });
    here.send({ op: Op.DATAGRAM, toIp: BROADCAST, toPort: 6112, fromPort: 6112 });
    assert.equal(there.all(Op.DATAGRAM).length, 0,
        'a broadcast reaches the room and stops there');
});

test('a broadcast reaches every listening peer but never its sender', ()=>{
    const relay = createRelay();
    const host = join(relay);
    const guest = join(relay);
    const other = join(relay);
    guest.send({ op: Op.LISTEN, toPort: 6112 });
    other.send({ op: Op.LISTEN, toPort: 6112 });

    host.send({
        op: Op.DATAGRAM, toIp: BROADCAST, toPort: 6112, fromPort: 6112,
        payload: new Uint8Array([7]),
    });

    assert.equal(guest.all(Op.DATAGRAM).length, 1);
    assert.equal(other.all(Op.DATAGRAM).length, 1);
    assert.equal(host.all(Op.DATAGRAM).length, 0);
    // Stamped with the sender's room address, not with whatever it claimed: a
    // peer that could choose its own source address could impersonate another.
    assert.equal(guest.first(Op.DATAGRAM).fromIp, host.address);
    assert.deepEqual([...guest.first(Op.DATAGRAM).payload], [7]);
});

test('a datagram to a port nobody is listening on is dropped', ()=>{
    const relay = createRelay();
    const host = join(relay);
    const guest = join(relay);
    guest.send({ op: Op.LISTEN, toPort: 1000 });

    host.send({ op: Op.DATAGRAM, toIp: guest.address, toPort: 2000, fromPort: 1 });
    assert.equal(guest.all(Op.DATAGRAM).length, 0);

    host.send({ op: Op.DATAGRAM, toIp: guest.address, toPort: 1000, fromPort: 1 });
    assert.equal(guest.all(Op.DATAGRAM).length, 1);
});

test('unlistening stops delivery', ()=>{
    const relay = createRelay();
    const host = join(relay);
    const guest = join(relay);
    guest.send({ op: Op.LISTEN, toPort: 6112 });
    guest.send({ op: Op.UNLISTEN, toPort: 6112 });

    host.send({ op: Op.DATAGRAM, toIp: guest.address, toPort: 6112, fromPort: 1 });
    assert.equal(guest.all(Op.DATAGRAM).length, 0);
});

test('a stream between two peers carries bytes both ways', ()=>{
    const relay = createRelay();
    const server = join(relay);
    const client = join(relay);
    server.send({ op: Op.LISTEN, flags: FLAG_STREAM, toPort: 6112 });

    client.send({ op: Op.DIAL, tag: 5, toIp: server.address, toPort: 6112, fromPort: 40000 });

    const accepted = server.first(Op.ACCEPTED);
    assert.ok(accepted, 'the listening peer is told a connection arrived');
    assert.equal(accepted.toPort, 6112);
    assert.equal(accepted.fromIp, client.address);
    assert.equal(accepted.fromPort, 40000);
    assert.ok(client.first(Op.OPENED), 'and the dialling peer is told it succeeded');

    client.send({ op: Op.STREAM, tag: 5, payload: new Uint8Array([1, 2]) });
    assert.deepEqual([...server.all(Op.STREAM)[0].payload], [1, 2]);
    assert.equal(server.all(Op.STREAM)[0].tag, accepted.tag);

    server.send({ op: Op.STREAM, tag: accepted.tag, payload: new Uint8Array([3]) });
    assert.deepEqual([...client.all(Op.STREAM)[0].payload], [3]);
    assert.equal(client.all(Op.STREAM)[0].tag, 5);
});

test('the accepting end is given a tag that cannot collide with its own', ()=>{
    // Both peers allocate stream ids from one, and the relay allocates the
    // accepting side's. Overlapping ranges splice two connections together.
    const relay = createRelay();
    const server = join(relay);
    const client = join(relay);
    server.send({ op: Op.LISTEN, flags: FLAG_STREAM, toPort: 6112 });
    client.send({ op: Op.DIAL, tag: 1, toIp: server.address, toPort: 6112 });

    assert.ok(server.first(Op.ACCEPTED).tag >= 0x80000000);
});

test('dialling a peer that is not listening is refused, and says so', ()=>{
    const relay = createRelay();
    const server = join(relay);
    const client = join(relay);

    client.send({ op: Op.DIAL, tag: 5, toIp: server.address, toPort: 6112 });

    const hangup = client.first(Op.HANGUP);
    assert.ok(hangup, 'a dial that cannot succeed still answers');
    assert.equal(hangup.tag, 5, 'and it answers the dial that was made');
    assert.ok(hangup.flags & FLAG_REJECT);
    assert.equal(unpackError(hangup.payload), Wsa.CONNREFUSED);
});

test('dialling an address in the room that nobody holds is refused', ()=>{
    const relay = createRelay();
    const client = join(relay);

    client.send({ op: Op.DIAL, tag: 5, toIp: parseIp('10.86.9.9'), toPort: 6112 });
    assert.ok(client.first(Op.HANGUP).flags & FLAG_REJECT);
});

test('a peer leaving hangs up every stream it held', ()=>{
    const relay = createRelay();
    const server = join(relay);
    const client = join(relay);
    server.send({ op: Op.LISTEN, flags: FLAG_STREAM, toPort: 6112 });
    client.send({ op: Op.DIAL, tag: 5, toIp: server.address, toPort: 6112 });

    server.session.close();

    const hangup = client.first(Op.HANGUP);
    assert.ok(hangup, 'a peer parked in recv has to learn the far end is gone');
    assert.equal(hangup.tag, 5);
    assert.equal(unpackError(hangup.payload), Wsa.CONNRESET);
});

test('a half close reaches the far end as a half close', ()=>{
    const relay = createRelay();
    const server = join(relay);
    const client = join(relay);
    server.send({ op: Op.LISTEN, flags: FLAG_STREAM, toPort: 6112 });
    client.send({ op: Op.DIAL, tag: 5, toIp: server.address, toPort: 6112 });
    const accepted = server.first(Op.ACCEPTED).tag;

    client.send({ op: Op.HANGUP, tag: 5, flags: FLAG_HALF });

    const hangup = server.first(Op.HANGUP);
    assert.ok(hangup.flags & FLAG_HALF, 'the stream is finished for reading only');
    assert.equal(hangup.tag, accepted);

    // Still open the other way: that is the whole point of a half close.
    server.send({ op: Op.STREAM, tag: accepted, payload: new Uint8Array([1]) });
    assert.equal(client.all(Op.STREAM).length, 1);
});

test('nothing outside the room is reachable without a policy that says so', async()=>{
    const relay = createRelay();
    const client = join(relay);

    client.send({ op: Op.DIAL, tag: 5, toIp: parseIp('93.184.216.34'), toPort: 80 });
    await settle();

    const hangup = client.first(Op.HANGUP);
    assert.ok(hangup, 'an unconfigured relay is a private LAN, not an open proxy');
    assert.ok(hangup.flags & FLAG_REJECT);
});

test('a policy that throws refuses rather than admits', async()=>{
    const relay = createRelay({
        policy: ()=>{
            throw new Error('the registry is down');
        },
    });
    const client = join(relay);

    client.send({ op: Op.DIAL, tag: 5, toIp: parseIp('93.184.216.34'), toPort: 80 });
    await settle();

    assert.ok(client.first(Op.HANGUP).flags & FLAG_REJECT);
});

test('the policy is asked about the name a peer resolved, not just the address', async()=>{
    /** @type {any[]} */
    const asked = [];
    const relay = createRelay({
        policy: request=>{
            asked.push(request);
            return request.protocol === 'dns';
        },
    });
    const client = join(relay);
    // Nothing resolved this address, so the policy sees it as an address; the
    // name path is covered where a lookup actually happened.
    client.send({ op: Op.DIAL, tag: 1, toIp: parseIp('93.184.216.34'), toPort: 80 });
    await settle();

    assert.equal(asked[0].protocol, 'tcp');
    assert.equal(asked[0].host, '93.184.216.34');
    assert.equal(asked[0].port, 80);
    assert.equal(asked[0].room, 'room');
    assert.equal(asked[0].peer, '10.86.0.1');
});

test('a real connection is opened, carries bytes and closes', async t=>{
    /** @type {any} */
    let seen = null;
    const echo = createServer(socket=>{
        socket.on('data', chunk=>{
            seen = chunk;
            socket.write(Buffer.from([...chunk].reverse()));
        });
    });
    await new Promise(resolve=>echo.listen(0, '127.0.0.1', ()=>resolve(null)));
    const port = /** @type {any} */ (echo.address()).port;
    t.after(()=>echo.close());

    const relay = createRelay({ policy: ()=>true });
    const client = join(relay);
    client.send({ op: Op.DIAL, tag: 3, toIp: parseIp('127.0.0.1'), toPort: port });

    await waitFor(()=>client.first(Op.OPENED));
    client.send({ op: Op.STREAM, tag: 3, payload: new Uint8Array([1, 2, 3]) });

    await waitFor(()=>client.all(Op.STREAM).length > 0);
    assert.deepEqual([...seen], [1, 2, 3]);
    assert.deepEqual([...client.all(Op.STREAM)[0].payload], [3, 2, 1]);
    client.session.close();
});

test('a connection to a closed port is refused, not left hanging', async()=>{
    // Find a port nothing is on by opening one and letting it go.
    const idle = createServer();
    await new Promise(resolve=>idle.listen(0, '127.0.0.1', ()=>resolve(null)));
    const port = /** @type {any} */ (idle.address()).port;
    await new Promise(resolve=>idle.close(()=>resolve(null)));

    const relay = createRelay({ policy: ()=>true });
    const client = join(relay);
    client.send({ op: Op.DIAL, tag: 3, toIp: parseIp('127.0.0.1'), toPort: port });

    const hangup = await waitFor(()=>client.first(Op.HANGUP));
    assert.ok(hangup.flags & FLAG_REJECT, 'a dial that never connected is a refusal');
    assert.equal(unpackError(hangup.payload), Wsa.CONNREFUSED);
});

test('a peer that leaves mid-dial does not leave a socket behind', async()=>{
    const relay = createRelay({ policy: ()=>true });
    const client = join(relay);
    // 192.0.2.0/24 is reserved for documentation and routes nowhere, so this
    // dial stays in flight for as long as the test needs it to.
    client.send({ op: Op.DIAL, tag: 3, toIp: parseIp('192.0.2.1'), toPort: 80 });
    await settle();

    client.session.close();
    assert.equal(relay.diagnostics().peers, 0);
    // Closing twice is what a socket that both errored and closed produces.
    client.session.close();
});

test('a frame before hello is refused', ()=>{
    const relay = createRelay();
    const peer = join(relay, 'room', { silent: true });

    peer.send({ op: Op.DIAL, tag: 1 });
    assert.ok(peer.disconnected);
    assert.equal(peer.control[0].t, 'error');
});

test('a hello with the wrong protocol version is refused', ()=>{
    const relay = createRelay();
    const peer = join(relay, 'room', { silent: true });

    peer.session.message(
        encodeControl({ t: 'hello', protocol: 99, room: 'room' }), false);
    assert.ok(peer.disconnected);
    assert.match(peer.control[0].reason, /protocol/);
});

test('a nameless room is refused', ()=>{
    const relay = createRelay();
    const peer = join(relay, 'room', { silent: true });

    peer.session.message(
        encodeControl({ t: 'hello', protocol: PROTOCOL_VERSION, room: '' }), false);
    assert.ok(peer.disconnected);
});

test('a room stops admitting peers at its limit', ()=>{
    const relay = createRelay({ maxPeersPerRoom: 2 });
    join(relay);
    join(relay);
    const third = join(relay);

    assert.equal(third.control[0].t, 'error');
    assert.ok(third.disconnected);
});

test('a peer cannot open unlimited sockets', async t=>{
    // A local listener that holds what it accepts: the two dials allowed stay
    // open whatever a network outside the machine would do with them -- one
    // that refuses at once frees the slots before the third dial is made.
    /** @type {import('node:net').Socket[]} */
    const held = [];
    const sink = createServer(socket=>held.push(socket));
    await new Promise(resolve=>sink.listen(0, '127.0.0.1', ()=>resolve(null)));
    const port = /** @type {any} */ (sink.address()).port;
    t.after(()=>{
        held.forEach(socket=>socket.destroy());
        sink.close();
    });

    const relay = createRelay({ policy: ()=>true, maxSocketsPerPeer: 2 });
    const client = join(relay);
    t.after(()=>client.session.close());
    for (let tag = 1; tag <= 3; tag++)
    {
        client.send({ op: Op.DIAL, tag, toIp: parseIp('127.0.0.1'), toPort: port });
        await settle();
    }

    const refused = client.all(Op.HANGUP).filter(frame=>frame.flags & FLAG_REJECT);
    assert.equal(refused.length, 1);
    assert.equal(refused[0].tag, 3);
});

test('a peer cannot forge the relay side of a session', ()=>{
    const relay = createRelay();
    const server = join(relay);
    const client = join(relay);

    // ACCEPTED only ever travels outward. A relay that acted on one would let a
    // peer manufacture connections into another peer's listening ports.
    client.send({ op: Op.ACCEPTED, tag: 1, toPort: 6112 });
    client.send({ op: Op.OPENED, tag: 1 });
    client.send({ op: Op.RESOLVED, tag: 1 });

    assert.equal(server.frames.length, 0);
    assert.equal(client.frames.length, 0);
});

test('bytes for a stream that does not exist are dropped', ()=>{
    const relay = createRelay();
    const client = join(relay);

    client.send({ op: Op.STREAM, tag: 999, payload: new Uint8Array([1]) });
    client.send({ op: Op.HANGUP, tag: 999 });
    assert.equal(client.frames.length, 0);
});

test('a name is refused unless the policy allows it, and the refusal is an empty answer', async()=>{
    const relay = createRelay();
    const client = join(relay);

    client.send({ op: Op.RESOLVE, tag: 4, payload: new TextEncoder().encode('example.com') });
    await settle();

    const answer = client.first(Op.RESOLVED);
    assert.ok(answer, 'a lookup always answers, or gethostbyname never returns');
    assert.equal(answer.tag, 4);
    assert.equal(answer.payload.length, 0);
});

test('a name that does not resolve answers empty rather than not at all', async()=>{
    const relay = createRelay({ policy: ()=>true });
    const client = join(relay);

    client.send({
        op: Op.RESOLVE, tag: 4,
        payload: new TextEncoder().encode('nothing.invalid'),
    });

    const answer = await waitFor(()=>client.first(Op.RESOLVED));
    assert.equal(answer.payload.length, 0);
});

test('localhost resolves, and the answer is usable as an address', async()=>{
    const relay = createRelay({ policy: ()=>true });
    const client = join(relay);

    client.send({ op: Op.RESOLVE, tag: 4, payload: new TextEncoder().encode('localhost') });

    const answer = await waitFor(()=>client.first(Op.RESOLVED));
    // A count is the wrong thing to assert: a name resolves to a list, and how
    // long that list is belongs to the host running the relay -- a machine whose
    // hosts file names loopback twice answers with two, and the test read that
    // as a defect. What the caller needs is that each answer is whole and
    // usable, which is what a hostent's address list promises.
    const addresses = unpackAddresses(answer.payload);
    assert.ok(addresses.length > 0, 'localhost resolved to something');
    for (const address of addresses)
    {
        assert.equal(address >>> 24, 127, `${formatIp(address)} is loopback`);
    }
});

/**
 * @param {() => any} ready
 */
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

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The browser half, twice over.
 *
 * Once against a socket this file controls, because the cases that matter are
 * the ones where the link fails at an awkward moment and nothing but a fake can
 * put it there reliably. Once against a real relay over a real WebSocket,
 * because a client tested only against a fake agrees with the fake.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
    BROADCAST, Op, PROTOCOL_VERSION, Wsa, decodeControl, decodeFrame, encodeControl,
    encodeFrame, parseIp,
} from '../protocol.js';
import { createRelayServer } from '../server/index.js';
import { connectRelay } from './index.js';

/**
 * A WebSocket whose other end is this test.
 *
 * Written rather than mocked so the awkward moments are reachable: a link that
 * dies between a dial and its answer, or while a name lookup is outstanding.
 */
class FakeSocket {
    /** @param {string} url */
    constructor(url){
        this.url = url;
        this.readyState = 0;
        this.binaryType = 'blob';
        /** @type {any[]} */
        this.sent = [];
        /** @type {Map<string, Function[]>} */
        this.listeners = new Map();
    }

    /** @param {string} type @param {Function} handler */
    addEventListener(type, handler){
        const held = this.listeners.get(type) ?? [];
        held.push(handler);
        this.listeners.set(type, held);
    }

    /** @param {string} type @param {Function} handler */
    removeEventListener(type, handler){
        this.listeners.set(type,
            (this.listeners.get(type) ?? []).filter(held=>held !== handler));
    }

    /** @param {string} type @param {any} [event] */
    emit(type, event = {}){
        for (const handler of [...(this.listeners.get(type) ?? [])])
        {
            handler(event);
        }
    }

    /** @param {any} data */
    send(data){
        this.sent.push(data);
    }

    close(){
        if (this.readyState === 3)
        {
            return;
        }
        this.readyState = 3;
        this.emit('close');
    }

    /** Completes the handshake and puts this socket in a room. */
    welcome(address = '10.86.0.1', room = 'room'){
        this.readyState = 1;
        this.emit('open');
        this.emit('message', {
            data: encodeControl({ t: 'welcome', address, room, peers: [] }),
        });
    }

    /** @param {Partial<import('../protocol.js').Frame> & { op: number }} frame */
    deliver(frame){
        const bytes = encodeFrame(frame);
        this.emit('message', {
            data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        });
    }

    /** The frames this client sent, decoded. */
    frames(){
        return this.sent.filter(data=>data instanceof Uint8Array).map(decodeFrame);
    }

    /** @param {number} op */
    firstFrame(op){
        return this.frames().find(frame=>frame?.op === op) ?? null;
    }

    /** The control messages this client sent, decoded. */
    control(){
        return this.sent.filter(data=>typeof data === 'string').map(decodeControl);
    }
}

/**
 * A joined transport, and the socket underneath it.
 *
 * @param {{ onRoster?: (event: any) => void }} [options]
 */
async function joined(options = {}){
    /** @type {any} */
    let socket = null;
    class Captured extends FakeSocket {
        /** @param {string} url */
        constructor(url){
            super(url);
            socket = this;
            // The transport only sends after the welcome, so the handshake is
            // completed on the next turn rather than inside the constructor.
            queueMicrotask(()=>this.welcome());
        }
    }
    const transport = await connectRelay({
        url: 'wss://relay.invalid', room: 'room',
        WebSocketImpl: /** @type {any} */ (Captured),
        ...options,
    });
    return { transport, socket: /** @type {FakeSocket} */ (socket) };
}

/** Collects the inbound calls a transport makes. */
function inboundRecorder(){
    /** @type {any[]} */
    const seen = [];
    return {
        seen,
        /** @param {string} what */
        of(what){
            return seen.filter(entry=>entry.what === what);
        },
        handlers: {
            /** @param {number} port @param {number} streamId @param {any} remote */
            accepted: (port, streamId, remote)=>
                seen.push({ what: 'accepted', port, streamId, remote }),
            /** @param {number} streamId @param {Uint8Array} bytes */
            received: (streamId, bytes)=>seen.push({ what: 'received', streamId, bytes }),
            /** @param {number} streamId @param {number} [error] */
            disconnected: (streamId, error)=>
                seen.push({ what: 'disconnected', streamId, error }),
            /** @param {number} port @param {any} from @param {Uint8Array} bytes */
            datagram: (port, from, bytes)=>seen.push({ what: 'datagram', port, from, bytes }),
            /** @param {number} error */
            lost: error=>seen.push({ what: 'lost', error }),
        },
    };
}

test('joining sends a hello and answers with the address the relay gave', async()=>{
    const { transport, socket } = await joined();

    assert.deepEqual(socket.control()[0], {
        t: 'hello', protocol: PROTOCOL_VERSION, room: 'room',
    });
    assert.equal(transport.localAddress(), parseIp('10.86.0.1'));
    assert.equal(transport.diagnostics().address, '10.86.0.1');
});

test('the handshake listeners let go once the welcome has arrived', async()=>{
    // Left attached, the next ordinary frame looks to them like a frame sent
    // before the welcome, and they close a connection that was working.
    const { transport, socket } = await joined();

    socket.deliver({ op: Op.STREAM, tag: 1, payload: new Uint8Array([1]) });

    assert.equal(socket.readyState, 1, 'the link is still up');
    assert.equal(transport.diagnostics().connected, true);
});

test('a relay that refuses the join rejects rather than hanging', async()=>{
    class Refusing extends FakeSocket {
        /** @param {string} url */
        constructor(url){
            super(url);
            queueMicrotask(()=>{
                this.readyState = 1;
                this.emit('open');
                this.emit('message', {
                    data: encodeControl({ t: 'error', reason: 'room full' }),
                });
            });
        }
    }

    await assert.rejects(
        connectRelay({
            url: 'wss://relay.invalid', room: 'room',
            WebSocketImpl: /** @type {any} */ (Refusing),
        }),
        /room full/);
});

test('a relay that never answers gives up instead of waiting forever', async()=>{
    class Silent extends FakeSocket {
        /** @param {string} url */
        constructor(url){
            super(url);
            queueMicrotask(()=>{
                this.readyState = 1;
                this.emit('open');
            });
        }
    }

    await assert.rejects(
        connectRelay({
            url: 'wss://relay.invalid', room: 'room', joinTimeoutMs: 20,
            WebSocketImpl: /** @type {any} */ (Silent),
        }),
        /in time/);
});

test('a dial becomes a frame, and its answer settles the promise', async()=>{
    const { transport, socket } = await joined();

    const dial = transport.connect(7, { host: parseIp('10.86.0.2'), port: 6112 });
    const frame = socket.firstFrame(Op.DIAL);
    assert.equal(frame?.tag, 7);
    assert.equal(frame?.toIp, parseIp('10.86.0.2'));
    assert.equal(frame?.toPort, 6112);

    socket.deliver({ op: Op.OPENED, tag: 7, fromPort: 40001 });
    assert.deepEqual(await dial, { local: { host: parseIp('10.86.0.1'), port: 40001 } });
});

test('a refused dial settles with the reason the relay gave', async()=>{
    const { transport, socket } = await joined();

    const dial = transport.connect(7, { host: parseIp('93.184.216.34'), port: 80 });
    socket.deliver({
        op: Op.HANGUP, tag: 7, flags: 1,
        payload: new Uint8Array(new Uint32Array([Wsa.NETUNREACH]).buffer),
    });

    assert.deepEqual(await dial, { error: Wsa.NETUNREACH });
});

test('a hangup on a dial in flight answers the dial, not a disconnection', async()=>{
    // Reported as a disconnection instead, the promise never settles and the
    // guest thread stays parked in connect for the rest of the run.
    const { transport, socket } = await joined();
    const recorder = inboundRecorder();
    transport.attach(recorder.handlers);

    const dial = transport.connect(7, { host: parseIp('10.86.0.2'), port: 6112 });
    socket.deliver({ op: Op.HANGUP, tag: 7, flags: 1 });

    assert.deepEqual(await dial, { error: Wsa.CONNREFUSED });
    assert.equal(recorder.of('disconnected').length, 0);
});

test('stream bytes and datagrams reach the inbound side unchanged', async()=>{
    const { transport, socket } = await joined();
    const recorder = inboundRecorder();
    transport.attach(recorder.handlers);

    socket.deliver({ op: Op.STREAM, tag: 3, payload: new Uint8Array([1, 2, 3]) });
    socket.deliver({
        op: Op.DATAGRAM, toPort: 6112,
        fromIp: parseIp('10.86.0.2'), fromPort: 40000,
        payload: new Uint8Array([9]),
    });

    assert.deepEqual([...recorder.of('received')[0].bytes], [1, 2, 3]);
    const arrived = recorder.of('datagram')[0];
    assert.equal(arrived.port, 6112);
    assert.deepEqual(arrived.from, { host: parseIp('10.86.0.2'), port: 40000 });
});

test('an accepted connection is announced with the port it arrived on', async()=>{
    const { transport, socket } = await joined();
    const recorder = inboundRecorder();
    transport.attach(recorder.handlers);

    socket.deliver({
        op: Op.ACCEPTED, tag: 0x80000001, toPort: 6112,
        fromIp: parseIp('10.86.0.5'), fromPort: 40000,
    });

    const accepted = recorder.of('accepted')[0];
    assert.equal(accepted.port, 6112);
    assert.equal(accepted.streamId, 0x80000001);
    assert.deepEqual(accepted.remote, { host: parseIp('10.86.0.5'), port: 40000 });
});

test('a half close travels as a half close', async()=>{
    const { transport, socket } = await joined();

    transport.disconnect(4, true);
    transport.disconnect(5, false);

    const frames = socket.frames().filter(frame=>frame !== null && frame.op === Op.HANGUP);
    assert.equal(frames.length, 2);
    assert.equal(Number(frames[0]?.flags) & 0x02, 0x02);
    assert.equal(Number(frames[1]?.flags) & 0x02, 0);
});

test('a broadcast keeps its broadcast address', async()=>{
    const { transport, socket } = await joined();

    transport.sendTo({ host: parseIp('10.86.0.1'), port: 6112 },
        { host: BROADCAST, port: 6112 }, new Uint8Array([1]));

    assert.equal(socket.firstFrame(Op.DATAGRAM)?.toIp, BROADCAST);
});

test('a name lookup answers with what the relay found', async()=>{
    const { transport, socket } = await joined();

    const asked = transport.resolve('example.com');
    const frame = socket.firstFrame(Op.RESOLVE);
    assert.equal(new TextDecoder().decode(frame?.payload), 'example.com');

    socket.deliver({
        op: Op.RESOLVED, tag: frame?.tag,
        payload: new Uint8Array(new Uint32Array([0x5db8d822]).buffer),
    });
    assert.deepEqual(await asked, [0x5db8d822]);
});

test('the link dropping settles a dial that was in flight', async()=>{
    // The whole reason this is worth a test: a promise nobody settles is a guest
    // thread parked in connect until the process ends.
    const { transport, socket } = await joined();

    const dial = transport.connect(7, { host: parseIp('10.86.0.2'), port: 6112 });
    socket.close();

    assert.deepEqual(await dial, { error: Wsa.NETDOWN });
});

test('the link dropping settles a name lookup that was in flight', async()=>{
    const { transport, socket } = await joined();

    const asked = transport.resolve('example.com');
    socket.close();

    assert.deepEqual(await asked, [],
        'an empty answer is WSAHOST_NOT_FOUND, which is a return; silence is not');
});

test('the link dropping tells the runtime the network has gone', async()=>{
    const { transport, socket } = await joined();
    const recorder = inboundRecorder();
    transport.attach(recorder.handlers);

    socket.close();

    assert.deepEqual(recorder.of('lost')[0], { what: 'lost', error: Wsa.NETDOWN });
    assert.equal(transport.diagnostics().connected, false);
});

test('a link that drops twice is reported once', async()=>{
    const { transport, socket } = await joined();
    const recorder = inboundRecorder();
    transport.attach(recorder.handlers);

    socket.emit('error');
    socket.close();
    transport.dispose();

    assert.equal(recorder.of('lost').length, 1);
});

test('nothing is written to a dropped link, and a later dial fails at once', async()=>{
    const { transport, socket } = await joined();
    socket.close();
    const before = socket.sent.length;

    transport.send(1, new Uint8Array([1]));
    transport.listen(true, 6112);
    transport.sendTo({ host: 0, port: 1 }, { host: 2, port: 3 }, new Uint8Array([1]));

    assert.equal(socket.sent.length, before);
    assert.deepEqual(await transport.connect(9, { host: 1, port: 2 }),
        { error: Wsa.NETDOWN });
    assert.deepEqual(await transport.resolve('example.com'), []);
});

test('a roster change is reported to whoever asked for it', async()=>{
    /** @type {any[]} */
    const roster = [];
    const { socket } = await joined({ onRoster: event=>roster.push(event) });

    socket.emit('message', {
        data: encodeControl({ t: 'peer', address: '10.86.0.2', joined: true }),
    });
    socket.close();

    assert.deepEqual(roster[0], { type: 'joined', address: '10.86.0.2' });
    assert.deepEqual(roster[1], { type: 'lost' });
});

test('two runtimes on one relay reach each other, over a real socket', async t=>{
    // The end-to-end pass: a client tested only against a fake agrees with the
    // fake. This one goes through the protocol, the WebSocket and the relay.
    const server = createRelayServer({ port: 0 });
    const port = await server.listen();
    t.after(()=>server.close());

    const url = `ws://127.0.0.1:${port}`;
    const host = await connectRelay({ url, room: 'a-game' });
    const guest = await connectRelay({ url, room: 'a-game' });
    t.after(()=>{
        host.dispose();
        guest.dispose();
    });

    const atHost = inboundRecorder();
    const atGuest = inboundRecorder();
    host.attach(atHost.handlers);
    guest.attach(atGuest.handlers);

    // The host serves a port; the guest finds it by broadcasting, as a game's
    // LAN discovery does, and then connects to whoever answered.
    host.listen(false, 6112);
    host.listen(true, 6112);
    guest.listen(false, 6112);

    guest.sendTo({ host: guest.localAddress(), port: 6112 },
        { host: BROADCAST, port: 6112 }, new Uint8Array([0xaa]));
    const asked = await waitFor(()=>atHost.of('datagram')[0]);
    assert.deepEqual([...asked.bytes], [0xaa]);
    assert.equal(asked.from.host, guest.localAddress());

    const opened = await guest.connect(1, { host: host.localAddress(), port: 6112 });
    assert.ok(!opened.error, `the connection should have opened: ${opened.error}`);

    const accepted = await waitFor(()=>atHost.of('accepted')[0]);
    assert.equal(accepted.port, 6112);
    assert.equal(accepted.remote.host, guest.localAddress());

    guest.send(1, new Uint8Array([1, 2, 3]));
    const arrived = await waitFor(()=>atGuest.of('received')[0]
        || atHost.of('received')[0]);
    assert.deepEqual([...arrived.bytes], [1, 2, 3]);

    host.send(accepted.streamId, new Uint8Array([4, 5]));
    const back = await waitFor(()=>atGuest.of('received')[0]);
    assert.deepEqual([...back.bytes], [4, 5]);
    assert.equal(back.streamId, 1);
});

test('a runtime whose relay goes away learns it, over a real socket', async t=>{
    const server = createRelayServer({ port: 0 });
    const port = await server.listen();
    const transport = await connectRelay({ url: `ws://127.0.0.1:${port}`, room: 'a-game' });
    t.after(()=>transport.dispose());
    const recorder = inboundRecorder();
    transport.attach(recorder.handlers);

    await server.close();

    const lost = await waitFor(()=>recorder.of('lost')[0]);
    assert.equal(lost.error, Wsa.NETDOWN);
});

/** @param {() => any} ready */
async function waitFor(ready, within = 5000){
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

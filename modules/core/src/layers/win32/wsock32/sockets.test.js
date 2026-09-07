/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The socket model, with no guest anywhere near it. Everything here is about
 * what a socket does; how a program asks for it is the surface's business.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSocketRegistry } from './sockets.js';
import { createLoopbackAdapter } from './loopback.js';
import {
    AF_INET, INADDR_ANY, INADDR_LOOPBACK, SD_SEND, SOCK_DGRAM, SOCK_STREAM,
    SO_ERROR, WSAECONNREFUSED, WSAENOTCONN, WSAEWOULDBLOCK,
} from './constants.js';

const PORT = 6112;
const bytes = (/** @type {string} */ text)=>new TextEncoder().encode(text);
const text = (/** @type {Uint8Array} */ raw)=>new TextDecoder().decode(raw);

/** A registry over its own address space, and a helper that makes sockets in it. */
function fixture(){
    const registry = createSocketRegistry({ adapter: createLoopbackAdapter() });
    /** @param {number} type */
    const make = (type = SOCK_STREAM)=>{
        const made = registry.create(AF_INET, type);
        assert.equal(made.error, undefined, 'the fixture could not make a socket');
        return registry.get(made.value);
    };
    return { registry, make };
}

/** A listener already bound and listening on PORT. */
function listening(){
    const { registry, make } = fixture();
    const server = make(SOCK_STREAM);
    assert.deepEqual(registry.bind(server, { host: INADDR_ANY, port: PORT }), { value: 0 });
    assert.deepEqual(registry.listen(server), { value: 0 });
    return { registry, make, server };
}

test('a connection is accepted, carries bytes both ways, and is closed', ()=>{
    const { registry, make, server } = listening();
    const client = make(SOCK_STREAM);

    assert.deepEqual(registry.connect(client, { host: INADDR_LOOPBACK, port: PORT }),
        { value: 0 });

    const accepted = registry.get(registry.accept(server).value);
    assert.equal(accepted.connected, true);

    assert.equal(registry.send(client, bytes('ping')).value, 4);
    assert.equal(text(registry.receive(accepted, 64).bytes), 'ping');

    assert.equal(registry.send(accepted, bytes('pong')).value, 4);
    assert.equal(text(registry.receive(client, 64).bytes), 'pong');

    assert.deepEqual(registry.close(client), { value: 0 });
    assert.deepEqual(registry.close(accepted), { value: 0 });
});

test('a stream has no message boundaries', ()=>{
    // Two sends, one recv: a reader that got one recv per send would break the
    // first time a sender coalesced, and every real stream coalesces.
    const { registry, make, server } = listening();
    const client = make(SOCK_STREAM);
    registry.connect(client, { host: INADDR_LOOPBACK, port: PORT });
    const accepted = registry.get(registry.accept(server).value);

    registry.send(client, bytes('abc'));
    registry.send(client, bytes('def'));
    assert.equal(text(registry.receive(accepted, 64).bytes), 'abcdef');

    // And the other way: one send, two recvs, the second continuing the first.
    registry.send(client, bytes('123456'));
    assert.equal(text(registry.receive(accepted, 2).bytes), '12');
    assert.equal(text(registry.receive(accepted, 64).bytes), '3456');
});

test('a peer that hangs up makes the next read return zero, not block', ()=>{
    const { registry, make, server } = listening();
    const client = make(SOCK_STREAM);
    registry.connect(client, { host: INADDR_LOOPBACK, port: PORT });
    const accepted = registry.get(registry.accept(server).value);

    // Before the close there is nothing to read and the socket says so.
    assert.deepEqual(registry.receive(accepted, 64), { error: WSAEWOULDBLOCK });

    registry.close(client);
    const read = registry.receive(accepted, 64);
    assert.equal(read.value, 0, 'end of stream is a zero-length read');
    assert.equal(read.error, undefined, 'and not an error');
});

test('bytes sent before a close are readable after it', ()=>{
    // The order that matters: a close must not discard what the peer already
    // delivered, or a short-lived sender loses its last message every time.
    const { registry, make, server } = listening();
    const client = make(SOCK_STREAM);
    registry.connect(client, { host: INADDR_LOOPBACK, port: PORT });
    const accepted = registry.get(registry.accept(server).value);

    registry.send(client, bytes('last words'));
    registry.close(client);

    assert.equal(text(registry.receive(accepted, 64).bytes), 'last words');
    assert.equal(registry.receive(accepted, 64).value, 0);
});

test('shutdown for sending finishes the peer without closing this end', ()=>{
    const { registry, make, server } = listening();
    const client = make(SOCK_STREAM);
    registry.connect(client, { host: INADDR_LOOPBACK, port: PORT });
    const accepted = registry.get(registry.accept(server).value);

    assert.deepEqual(registry.shutdown(client, SD_SEND), { value: 0 });
    assert.equal(registry.receive(accepted, 64).value, 0, 'the peer sees the end');

    // The half that was not shut down still carries bytes the other way.
    assert.equal(registry.send(accepted, bytes('still here')).value, 10);
    assert.equal(text(registry.receive(client, 64).bytes), 'still here');
});

test('a read parked on an empty stream is woken by a close', async()=>{
    const { registry, make, server } = listening();
    const client = make(SOCK_STREAM);
    registry.connect(client, { host: INADDR_LOOPBACK, port: PORT });
    const accepted = registry.get(registry.accept(server).value);

    const waiting = registry.readableSoon(accepted);
    registry.close(client);
    await waiting;

    assert.equal(registry.receive(accepted, 64).value, 0);
});

test('connecting where nothing listens is refused, and the reason is kept', ()=>{
    const { registry, make } = fixture();
    const client = make(SOCK_STREAM);

    assert.deepEqual(registry.connect(client, { host: INADDR_LOOPBACK, port: 9 }),
        { error: WSAECONNREFUSED });
    assert.equal(registry.readOption(client, SO_ERROR), WSAECONNREFUSED,
        'a non-blocking connect reads the reason here, not from the call');
    assert.equal(registry.readOption(client, SO_ERROR), 0,
        'and reading it clears it, which frameworks depend on');
});

test('a datagram does not land in a stream sharing its port', ()=>{
    // Two address spaces, not one. A discovery datagram arriving in a stream is
    // both wrong and a way for one protocol to corrupt the other.
    const { registry, make, server } = listening();
    const receiver = make(SOCK_DGRAM);
    assert.deepEqual(registry.bind(receiver, { host: INADDR_ANY, port: PORT }), { value: 0 },
        'the same port number is free in the datagram space');

    const sender = make(SOCK_DGRAM);
    registry.send(sender, bytes('discover'), { host: INADDR_LOOPBACK, port: PORT });

    assert.equal(registry.available(server), 0, 'the listener saw nothing');
    const got = registry.receive(receiver, 64);
    assert.equal(text(got.bytes), 'discover');
    assert.deepEqual(got.from, sender.local, 'and it says who sent it');
});

test('one recvfrom yields exactly one datagram, whole or truncated', ()=>{
    const { registry, make } = fixture();
    const receiver = make(SOCK_DGRAM);
    registry.bind(receiver, { host: INADDR_ANY, port: PORT });
    const sender = make(SOCK_DGRAM);

    registry.send(sender, bytes('first'), { host: INADDR_LOOPBACK, port: PORT });
    registry.send(sender, bytes('second'), { host: INADDR_LOOPBACK, port: PORT });

    assert.equal(text(registry.receive(receiver, 64).bytes), 'first',
        'boundaries are kept: two datagrams do not merge');

    const short = registry.receive(receiver, 3);
    assert.equal(text(short.bytes), 'sec');
    assert.equal(short.truncated, true);
    assert.deepEqual(registry.receive(receiver, 64), { error: WSAEWOULDBLOCK },
        'the remainder is dropped, not kept for next time');
});

test('a datagram to nobody is not an error', ()=>{
    const { registry, make } = fixture();
    const sender = make(SOCK_DGRAM);
    assert.equal(registry.send(sender, bytes('hello'), { host: INADDR_LOOPBACK, port: 9 }).value,
        5, 'that is what unreliable means');
});

test('a datagram socket with no destination has nowhere to send', ()=>{
    const { registry, make } = fixture();
    assert.deepEqual(registry.send(make(SOCK_DGRAM), bytes('x')), { error: WSAENOTCONN });
});

test('the sender keeps no reference to the buffer it was handed', ()=>{
    // The guest owns that memory and may overwrite it the instant send returns.
    const { registry, make, server } = listening();
    const client = make(SOCK_STREAM);
    registry.connect(client, { host: INADDR_LOOPBACK, port: PORT });
    const accepted = registry.get(registry.accept(server).value);

    const buffer = bytes('original');
    registry.send(client, buffer);
    buffer.fill(0x21);

    assert.equal(text(registry.receive(accepted, 64).bytes), 'original');
});

test('binding to any interface and to the loopback name one place', ()=>{
    // Otherwise a server on 0.0.0.0 is unreachable at 127.0.0.1, which is how
    // every host on this machine would actually be addressed.
    const { registry, server } = listening();
    assert.equal(server.local.host, INADDR_LOOPBACK);
    assert.equal(registry.bind(registry.get(registry.create(AF_INET, SOCK_STREAM).value),
        { host: INADDR_LOOPBACK, port: PORT }).error !== undefined, true,
    'and the address is then taken');
});

test('an unbound socket gets a port of its own when it needs one', ()=>{
    const { registry, make, server } = listening();
    const client = make(SOCK_STREAM);
    registry.connect(client, { host: INADDR_LOOPBACK, port: PORT });

    assert.equal(client.bound, true);
    assert.ok(client.local.port >= 49152, `ephemeral, got ${client.local.port}`);
    assert.notEqual(client.local.port, server.local.port);
});

test('select sees a socket that is ready and one that is not', ()=>{
    const { registry, make, server } = listening();
    const client = make(SOCK_STREAM);
    registry.connect(client, { host: INADDR_LOOPBACK, port: PORT });
    const accepted = registry.get(registry.accept(server).value);

    assert.deepEqual(registry.poll([accepted], [], []).read, [],
        'nothing to read yet');
    registry.send(client, bytes('now'));
    assert.deepEqual(registry.poll([accepted], [], []).read, [accepted]);

    assert.deepEqual(registry.poll([], [client], []).write, [client],
        'a connected stream is always writable here: a send takes the whole buffer');
});

test('a listener with a connection waiting is readable', ()=>{
    const { registry, make, server } = listening();
    assert.deepEqual(registry.poll([server], [], []).read, []);
    registry.connect(make(SOCK_STREAM), { host: INADDR_LOOPBACK, port: PORT });
    assert.deepEqual(registry.poll([server], [], []).read, [server],
        'which is how select tells a program to call accept');
});

test('waiting on several sockets settles once and detaches from all of them', async()=>{
    // A waiter left attached fires for a call that returned long ago -- and in
    // select's case writes an fd_set into a buffer the program has since reused.
    const { registry, make, server } = listening();
    const client = make(SOCK_STREAM);
    registry.connect(client, { host: INADDR_LOOPBACK, port: PORT });
    const accepted = registry.get(registry.accept(server).value);
    const other = make(SOCK_DGRAM);
    registry.bind(other, { host: INADDR_ANY, port: 7777 });

    const waiting = registry.anyReadableSoon([accepted, other], null);
    registry.send(client, bytes('go'));
    await waiting;

    assert.deepEqual(accepted.waiters, [], 'the waiter is gone from the one that fired');
    assert.deepEqual(other.waiters, [], 'and from the one that did not');
});

test('a wait with a timeout gives up on its own, and cancels its timer', async()=>{
    const { registry, make } = fixture();
    const idle = make(SOCK_DGRAM);
    registry.bind(idle, { host: INADDR_ANY, port: 7778 });

    const started = Date.now();
    await registry.anyReadableSoon([idle], 20);
    assert.ok(Date.now() - started >= 15, 'it actually waited');
    assert.deepEqual(idle.waiters, [], 'and let go afterwards');
});

test('a wait answered before its timeout leaves no timer running', async()=>{
    const { registry, make } = fixture();
    const receiver = make(SOCK_DGRAM);
    registry.bind(receiver, { host: INADDR_ANY, port: 7779 });
    const sender = make(SOCK_DGRAM);

    // If the timer outlived the wait, node would hold the process open past
    // this test and the fd_set it would have written belongs to a dead call.
    const waiting = registry.anyReadableSoon([receiver], 60_000);
    registry.send(sender, bytes('x'), { host: INADDR_LOOPBACK, port: 7779 });
    await waiting;

    assert.deepEqual(receiver.waiters, []);
});

test('closing a listener closes what it never accepted', ()=>{
    const { registry, make, server } = listening();
    const client = make(SOCK_STREAM);
    registry.connect(client, { host: INADDR_LOOPBACK, port: PORT });

    registry.close(server);
    assert.equal(registry.receive(client, 64).value, 0,
        'the client is told, rather than waiting for a server that is gone');
});

test('a socket closed twice is a return code, not a fault', ()=>{
    const { registry, make } = fixture();
    const socket = make(SOCK_STREAM);
    assert.deepEqual(registry.close(socket), { value: 0 });
    assert.ok(registry.close(socket).error, 'programs do close a socket twice');
});

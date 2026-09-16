/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The seam: guest calls, over a network that is not this runtime.
 *
 * Everything here is driven through the Winsock surface a program actually
 * calls, against a transport this file controls -- so what is being checked is
 * the whole path, from a guest pointer to a frame the embedder would send, and
 * back. The transport is a recorder rather than a relay because the questions
 * are about routing and about the awkward moments: what reaches the transport,
 * what stays local, and what a guest sees when the network fails underneath it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWinsockFunctions } from './functions.js';
import { createSocketRegistry } from './sockets.js';
import { createLoopbackAdapter } from './loopback.js';
import { asNetwork, asTransport } from './transport.js';
import {
    AF_INET, INVALID_SOCKET, SOCKET_ERROR, SOCK_DGRAM, SOCK_STREAM, SOL_SOCKET,
    SO_ERROR, WSAECONNREFUSED, WSAENETDOWN, WSAENETUNREACH, WSAHOST_NOT_FOUND,
} from './constants.js';
import { SOCKADDR_IN_SIZE, parseAddress, readSockaddr, writeSockaddr } from './sockaddr.js';

const PORT = 6112;
const NAME = 0x100;
const NAME2 = 0x120;
const BUFFER = 0x200;
const OUT = 0x300;

const REMOTE = parseAddress('93.184.216.34');
const PEER = parseAddress('10.86.0.2');
const OURS = parseAddress('10.86.0.1');

/**
 * A transport that records what it was asked and can be made to answer.
 *
 * @param {{ localAddress?: number, resolve?: boolean }} [options]
 */
function recorder(options = {}){
    /** @type {any[]} */
    const calls = [];
    /** @type {any} */
    let inbound = null;
    /** @type {Map<number, (opened: any) => void>} */
    const dialling = new Map();
    /** @type {((found: number[]) => void)[]} */
    const asking = [];

    const transport = {
        /** @param {any} handlers */
        attach(handlers){
            inbound = handlers;
        },
        localAddress: ()=>options.localAddress ?? OURS,
        /** @param {number} streamId @param {any} to */
        connect(streamId, to){
            calls.push({ what: 'connect', streamId, to });
            return new Promise(settle=>dialling.set(streamId, settle));
        },
        /** @param {number} streamId @param {Uint8Array} bytes */
        send(streamId, bytes){
            calls.push({ what: 'send', streamId, bytes });
        },
        /** @param {number} streamId @param {boolean} half */
        disconnect(streamId, half){
            calls.push({ what: 'disconnect', streamId, half });
        },
        /** @param {any} from @param {any} to @param {Uint8Array} bytes */
        sendTo(from, to, bytes){
            calls.push({ what: 'sendTo', from, to, bytes });
        },
        /** @param {boolean} stream @param {number} port */
        listen(stream, port){
            calls.push({ what: 'listen', stream, port });
        },
        /** @param {boolean} stream @param {number} port */
        release(stream, port){
            calls.push({ what: 'release', stream, port });
        },
        resolve: options.resolve === false ? null : (/** @type {string} */ name)=>{
            calls.push({ what: 'resolve', name });
            return new Promise(settle=>asking.push(settle));
        },
        diagnostics: ()=>({ transport: 'recorder' }),
    };

    return {
        transport,
        calls,
        /** @param {string} what */
        of(what){
            return calls.filter(call=>call.what === what);
        },
        /** @param {string} what */
        last(what){
            return [...calls].reverse().find(call=>call.what === what) ?? null;
        },
        get inbound(){
            return inbound;
        },
        /** @param {number} streamId @param {any} answer */
        answerDial(streamId, answer){
            const settle = dialling.get(streamId);
            assert.ok(settle, `nothing dialled stream ${streamId}`);
            dialling.delete(streamId);
            settle(answer);
        },
        /** @param {number[]} found */
        answerResolve(found){
            const settle = asking.shift();
            assert.ok(settle, 'nothing asked for a name');
            settle(found);
        },
    };
}

/**
 * A guest, and a Winsock over the given transport.
 *
 * @param {any} [network]
 */
function fixture(network){
    const bytes = new Uint8Array(0x1000);
    let nextHeap = 0x800;
    const thread = { name: 'main' };

    const host = {
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
        /** @param {number} address @param {number} maxLength */
        readCString(address, maxLength){
            let text = '';
            for (let at = 0; at < maxLength && bytes[address + at] !== 0; at++)
            {
                text += String.fromCharCode(bytes[address + at]);
            }
            return text;
        },
        currentThread: ()=>thread,
        heap: {
            /** @param {number} size */
            allocate(size){
                const at = nextHeap;
                nextHeap += size;
                return at;
            },
        },
        registry: createSocketRegistry({ adapter: network }),
        post: ()=>{},
        signalEvent: ()=>{},
    };

    const winsock = createWinsockFunctions(host);
    /** @type {any} */
    const table = winsock.sockets;
    const call = (/** @type {string} */ name, /** @type {number[]} */ args = [])=>
        table[name].handler(args);

    call('WSAStartup', [0x0202, 0]);

    return {
        bytes, host, call,
        registry: host.registry,
        /** @param {number} address @param {string} text */
        put(address, text){
            bytes.set(new TextEncoder().encode(`${text}\0`), address);
        },
        /** @param {number} at @param {number} port @param {number} host32 */
        address(at, host32, port){
            writeSockaddr(host.writeMemory, at, { host: host32, port });
        },
        /** @param {number} address @param {number} length */
        read: (address, length)=>[...bytes.subarray(address, address + length)],
    };
}

test('with no transport, the loopback still works exactly as it did', ()=>{
    const fx = fixture();
    const server = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    fx.address(NAME, 0, PORT);
    assert.equal(fx.call('bind', [server, NAME, SOCKADDR_IN_SIZE]), 0);
    assert.equal(fx.call('listen', [server, 5]), 0);

    const client = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    assert.equal(fx.call('connect', [client, NAME, SOCKADDR_IN_SIZE]), 0,
        'a transport is an addition, not a replacement for what was already here');
});

test('with no transport, anything outside this runtime is unreachable', async()=>{
    // Unreachable, not refused: nothing answered because there is no route at
    // all, and a program told "refused" retries a machine that does not exist.
    const fx = fixture();
    const client = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    fx.address(NAME, REMOTE, 80);

    assert.equal(await fx.call('connect', [client, NAME, SOCKADDR_IN_SIZE]), SOCKET_ERROR);
    assert.equal(fx.call('WSAGetLastError', []), WSAENETUNREACH);
});

test('with no transport, a name nobody can answer for stays a synchronous failure', ()=>{
    // gethostbyname returns a pointer, and a resolver that is not there is not a
    // reason to suspend a guest thread to be told what it already knew.
    const fx = fixture();
    fx.put(BUFFER, 'example.com');

    const answer = fx.call('gethostbyname', [BUFFER]);
    assert.equal(answer, 0);
    assert.equal(fx.call('WSAGetLastError', []), WSAHOST_NOT_FOUND);
});

test('a plain address-space adapter is still accepted as one', ()=>{
    // One configuration slot carries two unrelated notions and they are told
    // apart by shape. An adapter that started being read as a transport would
    // route every local connection out to a network that is not there.
    const adapter = createLoopbackAdapter();
    const sorted = asNetwork(adapter);

    assert.equal(sorted.adapter, adapter);
    assert.equal(sorted.transport.resolve, null, 'an adapter supplies no resolver');
});

test('a transport supplying nothing at all is a working offline transport', ()=>{
    const filled = asTransport({});

    assert.equal(filled.localAddress(), parseAddress('127.0.0.1'));
    assert.doesNotThrow(()=>filled.send(1, new Uint8Array(1)));
    assert.doesNotThrow(()=>filled.listen(true, 1));
});

test('connecting outside goes to the transport, and its answer is the call\'s', async()=>{
    const net = recorder();
    const fx = fixture(net.transport);
    const client = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    fx.address(NAME, REMOTE, 80);

    const pending = fx.call('connect', [client, NAME, SOCKADDR_IN_SIZE]);
    assert.ok(pending instanceof Promise, 'reaching outside takes a round trip');

    const dial = net.last('connect');
    assert.deepEqual(dial.to, { host: REMOTE, port: 80 });
    net.answerDial(dial.streamId, { local: { host: OURS, port: 40001 } });

    assert.equal(await pending, 0);
    assert.equal(fx.call('getsockname', [client, NAME2, 0]), 0);
    assert.deepEqual(readSockaddr(fx.host.readMemory, NAME2),
        { family: AF_INET, host: OURS, port: 40001 },
        'the local end reported is the one the network actually gave us');
});

test('a refused dial fails the call and is left in SO_ERROR', async()=>{
    // A non-blocking connect reads the reason from getsockopt and never sees the
    // return value, so recording it there is not optional.
    const net = recorder();
    const fx = fixture(net.transport);
    const client = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    fx.address(NAME, REMOTE, 80);

    const pending = fx.call('connect', [client, NAME, SOCKADDR_IN_SIZE]);
    net.answerDial(net.last('connect').streamId, { error: WSAECONNREFUSED });

    assert.equal(await pending, SOCKET_ERROR);
    assert.equal(fx.call('WSAGetLastError', []), WSAECONNREFUSED);
    assert.equal(fx.call('getsockopt', [client, SOL_SOCKET, SO_ERROR, OUT, 0]), 0);
    assert.deepEqual(fx.read(OUT, 2), [WSAECONNREFUSED & 0xff, WSAECONNREFUSED >> 8]);
});

test('bytes sent on a remote stream go out, and bytes arriving come back', async()=>{
    const net = recorder();
    const fx = fixture(net.transport);
    const client = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    fx.address(NAME, REMOTE, 80);
    const pending = fx.call('connect', [client, NAME, SOCKADDR_IN_SIZE]);
    const streamId = net.last('connect').streamId;
    net.answerDial(streamId, {});
    await pending;

    fx.bytes.set([1, 2, 3], BUFFER);
    assert.equal(fx.call('send', [client, BUFFER, 3, 0]), 3);
    assert.deepEqual([...net.last('send').bytes], [1, 2, 3]);
    assert.equal(net.last('send').streamId, streamId);

    net.inbound.received(streamId, new Uint8Array([9, 8]));
    assert.equal(fx.call('recv', [client, OUT, 16, 0]), 2);
    assert.deepEqual(fx.read(OUT, 2), [9, 8]);
});

test('what a guest sends is not the buffer it may reuse', async()=>{
    const net = recorder();
    const fx = fixture(net.transport);
    const client = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    fx.address(NAME, REMOTE, 80);
    const pending = fx.call('connect', [client, NAME, SOCKADDR_IN_SIZE]);
    net.answerDial(net.last('connect').streamId, {});
    await pending;

    fx.bytes.set([1, 2, 3], BUFFER);
    fx.call('send', [client, BUFFER, 3, 0]);
    fx.bytes.set([0, 0, 0], BUFFER);

    assert.deepEqual([...net.last('send').bytes], [1, 2, 3],
        'the guest owns that buffer and overwrites it the instant send returns');
});

test('a blocking recv parked on a remote stream is woken by bytes arriving', async()=>{
    const net = recorder();
    const fx = fixture(net.transport);
    const client = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    fx.address(NAME, REMOTE, 80);
    const dialled = fx.call('connect', [client, NAME, SOCKADDR_IN_SIZE]);
    const streamId = net.last('connect').streamId;
    net.answerDial(streamId, {});
    await dialled;

    const pending = fx.call('recv', [client, OUT, 16, 0]);
    assert.ok(pending instanceof Promise, 'nothing has arrived, so it waits');

    net.inbound.received(streamId, new Uint8Array([7]));
    assert.equal(await pending, 1);
    assert.deepEqual(fx.read(OUT, 1), [7]);
});

test('the far end hanging up ends the stream rather than blocking forever', async()=>{
    const net = recorder();
    const fx = fixture(net.transport);
    const client = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    fx.address(NAME, REMOTE, 80);
    const dialled = fx.call('connect', [client, NAME, SOCKADDR_IN_SIZE]);
    const streamId = net.last('connect').streamId;
    net.answerDial(streamId, {});
    await dialled;

    const pending = fx.call('recv', [client, OUT, 16, 0]);
    net.inbound.disconnected(streamId);

    assert.equal(await pending, 0, 'end of stream is a zero-length read, not an error');
});

test('a far end that only finished sending leaves this end able to send', async()=>{
    // shutdown(SD_SEND) on the other side is how a request is written before its
    // answer is read. Treating it as a full disconnection detaches the stream,
    // and the answer this end still has to write fails with WSAENOTCONN.
    const net = recorder();
    const fx = fixture(net.transport);
    const client = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    fx.address(NAME, REMOTE, 80);
    const dialled = fx.call('connect', [client, NAME, SOCKADDR_IN_SIZE]);
    const streamId = net.last('connect').streamId;
    net.answerDial(streamId, {});
    await dialled;

    net.inbound.disconnected(streamId);
    assert.equal(fx.call('recv', [client, OUT, 16, 0]), 0, 'reading is finished');

    fx.bytes.set([1], BUFFER);
    assert.equal(fx.call('send', [client, BUFFER, 1, 0]), 1, 'writing is not');
    assert.equal(net.last('send').streamId, streamId);
});

test('losing the network wakes every parked read and leaves a reason', async()=>{
    // A read parked on a link that has gone waits for bytes that cannot come.
    const net = recorder();
    const fx = fixture(net.transport);
    const client = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    fx.address(NAME, REMOTE, 80);
    const dialled = fx.call('connect', [client, NAME, SOCKADDR_IN_SIZE]);
    net.answerDial(net.last('connect').streamId, {});
    await dialled;

    const pending = fx.call('recv', [client, OUT, 16, 0]);
    net.inbound.lost(WSAENETDOWN);

    assert.equal(await pending, 0);
    assert.equal(fx.call('getsockopt', [client, SOL_SOCKET, SO_ERROR, OUT, 0]), 0);
    assert.deepEqual(fx.read(OUT, 2), [WSAENETDOWN & 0xff, WSAENETDOWN >> 8]);
});

test('closing a remote stream tells the transport, and a half close says so', async()=>{
    const net = recorder();
    const fx = fixture(net.transport);
    const client = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    fx.address(NAME, REMOTE, 80);
    const dialled = fx.call('connect', [client, NAME, SOCKADDR_IN_SIZE]);
    const streamId = net.last('connect').streamId;
    net.answerDial(streamId, {});
    await dialled;

    assert.equal(fx.call('shutdown', [client, 1]), 0);
    assert.deepEqual(net.last('disconnect'), { what: 'disconnect', streamId, half: true });

    assert.equal(fx.call('closesocket', [client]), 0);
    assert.deepEqual(net.last('disconnect'), { what: 'disconnect', streamId, half: false });
});

test('listening is announced, and a connection the transport brings is accepted', ()=>{
    const net = recorder();
    const fx = fixture(net.transport);
    const server = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    fx.address(NAME, 0, PORT);
    fx.call('bind', [server, NAME, SOCKADDR_IN_SIZE]);

    assert.equal(net.of('listen').length, 0,
        'a bound stream socket is not reachable until it listens');
    fx.call('listen', [server, 5]);
    assert.deepEqual(net.last('listen'), { what: 'listen', stream: true, port: PORT });

    net.inbound.accepted(PORT, 77, { host: PEER, port: 40000 });
    const accepted = fx.call('accept', [server, NAME2, 0]);
    assert.notEqual(accepted, INVALID_SOCKET);
    assert.deepEqual(readSockaddr(fx.host.readMemory, NAME2),
        { family: AF_INET, host: PEER, port: 40000 });

    net.inbound.received(77, new Uint8Array([5]));
    assert.equal(fx.call('recv', [accepted, OUT, 16, 0]), 1);
    assert.deepEqual(fx.read(OUT, 1), [5]);
});

test('a connection to a port nobody serves is hung up rather than queued', ()=>{
    const net = recorder();
    fixture(net.transport);

    net.inbound.accepted(9999, 77, { host: PEER, port: 40000 });

    assert.deepEqual(net.last('disconnect'), { what: 'disconnect', streamId: 77, half: false });
});

test('closing a listener stops the transport routing to it', ()=>{
    const net = recorder();
    const fx = fixture(net.transport);
    const server = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    fx.address(NAME, 0, PORT);
    fx.call('bind', [server, NAME, SOCKADDR_IN_SIZE]);
    fx.call('listen', [server, 5]);

    fx.call('closesocket', [server]);
    assert.deepEqual(net.last('release'), { what: 'release', stream: true, port: PORT });
});

test('a datagram bound port is announced at bind, being reachable at once', ()=>{
    const net = recorder();
    const fx = fixture(net.transport);
    const socket = fx.call('socket', [AF_INET, SOCK_DGRAM, 0]);
    fx.address(NAME, 0, PORT);

    fx.call('bind', [socket, NAME, SOCKADDR_IN_SIZE]);
    assert.deepEqual(net.last('listen'), { what: 'listen', stream: false, port: PORT });
});

test('a datagram outside this runtime goes to the transport, and replies come back', ()=>{
    const net = recorder();
    const fx = fixture(net.transport);
    const socket = fx.call('socket', [AF_INET, SOCK_DGRAM, 0]);
    fx.address(NAME, 0, PORT);
    fx.call('bind', [socket, NAME, SOCKADDR_IN_SIZE]);

    fx.address(NAME2, PEER, 6113);
    fx.bytes.set([4, 4], BUFFER);
    assert.equal(fx.call('sendto', [socket, BUFFER, 2, 0, NAME2, SOCKADDR_IN_SIZE]), 2);
    assert.deepEqual(net.last('sendTo').to, { host: PEER, port: 6113 });
    assert.deepEqual([...net.last('sendTo').bytes], [4, 4]);

    net.inbound.datagram(PORT, { host: PEER, port: 6113 }, new Uint8Array([6]));
    assert.equal(fx.call('recvfrom', [socket, OUT, 16, 0, NAME2, 0]), 1);
    assert.deepEqual(fx.read(OUT, 1), [6]);
    assert.deepEqual(readSockaddr(fx.host.readMemory, NAME2),
        { family: AF_INET, host: PEER, port: 6113 });
});

test('a broadcast reaches the transport rather than being dropped', ()=>{
    // A LAN game finds its peers by broadcasting, so this is the one datagram
    // that must not be quietly swallowed by a local address lookup.
    const net = recorder();
    const fx = fixture(net.transport);
    const socket = fx.call('socket', [AF_INET, SOCK_DGRAM, 0]);
    fx.address(NAME, 0, PORT);
    fx.call('bind', [socket, NAME, SOCKADDR_IN_SIZE]);

    fx.address(NAME2, 0xffffffff, PORT);
    fx.bytes.set([1], BUFFER);
    assert.equal(fx.call('sendto', [socket, BUFFER, 1, 0, NAME2, SOCKADDR_IN_SIZE]), 1);

    assert.deepEqual(net.last('sendTo').to, { host: 0xffffffff, port: PORT });
});

test('a datagram between two sockets of this runtime never touches the transport', ()=>{
    const net = recorder();
    const fx = fixture(net.transport);
    const listener = fx.call('socket', [AF_INET, SOCK_DGRAM, 0]);
    fx.address(NAME, 0, PORT);
    fx.call('bind', [listener, NAME, SOCKADDR_IN_SIZE]);

    const sender = fx.call('socket', [AF_INET, SOCK_DGRAM, 0]);
    fx.bytes.set([2], BUFFER);
    fx.call('sendto', [sender, BUFFER, 1, 0, NAME, SOCKADDR_IN_SIZE]);

    assert.equal(net.of('sendTo').length, 0, 'a relay round trip to reach ourselves');
    assert.equal(fx.call('recvfrom', [listener, OUT, 16, 0, 0, 0]), 1);
});

test('every name for this machine is the same place, whatever the transport calls us', ()=>{
    // A guest binds to 0.0.0.0 and connects to 127.0.0.1, and the two have to
    // name one socket -- otherwise a server is bound under one key and looked
    // for under another, and is unreachable from its own process.
    const net = recorder();
    const fx = fixture(net.transport);
    const server = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    fx.address(NAME, 0, PORT);
    fx.call('bind', [server, NAME, SOCKADDR_IN_SIZE]);
    fx.call('listen', [server, 5]);

    const client = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    fx.address(NAME2, parseAddress('127.0.0.1'), PORT);
    assert.equal(fx.call('connect', [client, NAME2, SOCKADDR_IN_SIZE]), 0);

    const second = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    fx.address(NAME2, OURS, PORT);
    assert.equal(fx.call('connect', [second, NAME2, SOCKADDR_IN_SIZE]), 0,
        'the address the network gave us is us too');
    assert.equal(net.of('connect').length, 0);
});

test('a name goes to the resolver, and its answer becomes the hostent', async()=>{
    const net = recorder();
    const fx = fixture(net.transport);
    fx.put(BUFFER, 'example.com');

    const pending = fx.call('gethostbyname', [BUFFER]);
    assert.ok(pending instanceof Promise);
    assert.equal(net.last('resolve').name, 'example.com');

    net.answerResolve([REMOTE]);
    const record = await pending;
    assert.notEqual(record, 0);

    // h_addr_list -> the first address, in network order as a sockaddr holds it.
    const view = new DataView(fx.bytes.buffer);
    const list = view.getUint32(record + 12, true);
    assert.equal(view.getUint32(view.getUint32(list, true), false), REMOTE);
});

test('a name the resolver cannot answer for fails rather than pointing at loopback', async()=>{
    // A program told a name resolved will connect to it and fail somewhere
    // further away, with less to go on.
    const net = recorder();
    const fx = fixture(net.transport);
    fx.put(BUFFER, 'nothing.invalid');

    const pending = fx.call('gethostbyname', [BUFFER]);
    net.answerResolve([]);

    assert.equal(await pending, 0);
    assert.equal(fx.call('WSAGetLastError', []), WSAHOST_NOT_FOUND);
});

test('the names this host is are answered without asking the network', ()=>{
    const net = recorder();
    const fx = fixture(net.transport);
    fx.put(BUFFER, 'localhost');

    assert.notEqual(fx.call('gethostbyname', [BUFFER]), 0);
    fx.put(BUFFER, '10.0.0.7');
    assert.notEqual(fx.call('gethostbyname', [BUFFER]), 0, 'a literal resolves to itself');
    assert.equal(net.of('resolve').length, 0);
});

test('the transport reports itself in diagnostics', ()=>{
    const net = recorder();
    const fx = fixture(net.transport);

    assert.equal(fx.registry.diagnostics().transport, 'recorder');
    assert.equal(fixture().registry.diagnostics().transport, 'offline');
});

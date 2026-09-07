/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The guest surface: handles into sockets, pointers into addresses and buffers,
 * outcomes into a return value and an error slot. What a socket *does* is
 * checked in sockets.test.js; this is about the translation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWinsockFunctions } from './functions.js';
import { createSocketRegistry } from './sockets.js';
import { createLoopbackAdapter } from './loopback.js';
import {
    AF_INET, FIONBIO, FIONREAD, INVALID_SOCKET, SOCKET_ERROR, SOCK_DGRAM, SOCK_STREAM,
    SOL_SOCKET, SO_TYPE, WSADATA, WSAEMSGSIZE, WSAENOTSOCK, WSAEWOULDBLOCK,
    WSAHOST_NOT_FOUND, WSANOTINITIALISED, WSA_IO_PENDING, WS2_32_ORDINALS, WSOCK32_ORDINALS,
} from './constants.js';
import { SOCKADDR_IN_SIZE, writeSockaddr } from './sockaddr.js';

const PORT = 6112;

/** Addresses the fixtures use; nothing about them matters but that they differ. */
const NAME = 0x100;
const NAME2 = 0x120;
const BUFFER = 0x200;
const OUT = 0x300;
/** Far enough from OUT that a received payload cannot reach it. */
const OUT2 = 0x380;
const WSABUF = 0x400;
const FDSET = 0x500;
const TIMEVAL = 0x600;

/**
 * A guest and a Winsock over it.
 *
 * `readMemory` hands back a view rather than a copy, exactly as the real memory
 * layer may, so anything that keeps what it read has to say so.
 */
function fixture(){
    const bytes = new Uint8Array(0x1000);
    let nextHeap = 0x800;
    let thread = { name: 'main' };

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
        registry: createSocketRegistry({ adapter: createLoopbackAdapter() }),
    };

    const winsock = createWinsockFunctions(host);
    /** @type {any} */
    const sockets = winsock.sockets;
    /** @type {any} */
    const extensions = winsock.extensions;
    const call = (/** @type {string} */ name, /** @type {number[]} */ args = [])=>
        sockets[name].handler(args);
    const extension = (/** @type {string} */ name, /** @type {number[]} */ args = [])=>
        extensions[name].handler(args);

    call('WSAStartup', [0x0202, 0]);

    return {
        bytes, host, winsock, call, extension,
        registry: host.registry,
        /** @param {any} next */
        onThread(next){
            thread = next;
        },
        /** @param {number} address */
        dword: address=>new DataView(bytes.buffer).getUint32(address, true),
        /** @param {number} address @param {number} value */
        setDword(address, value){
            new DataView(bytes.buffer).setUint32(address, value, true);
        },
        /** @param {string} text */
        put(address = BUFFER, text = ''){
            bytes.set(new TextEncoder().encode(text), address);
            return text.length;
        },
        /** @param {number} address @param {number} length */
        read: (address, length)=>
            new TextDecoder().decode(bytes.subarray(address, address + length)),
    };
}

/**
 * A listening socket and a connected pair, through the guest surface.
 *
 * @param {ReturnType<typeof fixture>} fx
 */
function connected(fx){
    const server = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    writeSockaddr(fx.host.writeMemory, NAME, { host: 0, port: PORT });
    assert.equal(fx.call('bind', [server, NAME, SOCKADDR_IN_SIZE]), 0);
    assert.equal(fx.call('listen', [server, 5]), 0);

    const client = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    assert.equal(fx.call('connect', [client, NAME, SOCKADDR_IN_SIZE]), 0);
    const accepted = fx.call('accept', [server, NAME2, 0]);
    return { server, client, accepted };
}

test('nothing works until WSAStartup, and then it does', ()=>{
    const fx = fixture();
    fx.call('WSACleanup', []);

    assert.equal(fx.call('socket', [AF_INET, SOCK_STREAM, 0]), INVALID_SOCKET);
    assert.equal(fx.call('WSAGetLastError', []), WSANOTINITIALISED);

    assert.equal(fx.call('WSAStartup', [0x0202, 0]), 0);
    assert.notEqual(fx.call('socket', [AF_INET, SOCK_STREAM, 0]), INVALID_SOCKET);
});

test('WSAStartup fills in the version it agreed to', ()=>{
    const fx = fixture();
    assert.equal(fx.call('WSAStartup', [0x0101, OUT & ~3]), 0);

    const view = new DataView(fx.bytes.buffer);
    assert.equal(view.getUint16((OUT & ~3) + WSADATA.wVersion, true), 0x0101,
        'the version negotiated is the one asked for');
    assert.equal(view.getUint16((OUT & ~3) + WSADATA.wHighVersion, true), 0x0202,
        'the high version is what we could do');
});

test('the last error belongs to the thread that caused it', ()=>{
    // A worker thread that fails a call must not have its reason overwritten by
    // whatever the main thread did in between.
    const fx = fixture();
    const main = fx.host.currentThread();
    const worker = { name: 'worker' };

    assert.equal(fx.call('closesocket', [999]), SOCKET_ERROR);
    assert.equal(fx.call('WSAGetLastError', []), WSAENOTSOCK);

    fx.onThread(worker);
    assert.equal(fx.call('WSAGetLastError', []), 0, 'a fresh thread has no error');
    fx.call('WSASetLastError', [WSAEWOULDBLOCK]);
    assert.equal(fx.call('WSAGetLastError', []), WSAEWOULDBLOCK);

    fx.onThread(main);
    assert.equal(fx.call('WSAGetLastError', []), WSAENOTSOCK,
        'the main thread still has its own');
});

test('an address goes out through bind and comes back through getsockname', ()=>{
    const fx = fixture();
    const socket = fx.call('socket', [AF_INET, SOCK_DGRAM, 0]);
    writeSockaddr(fx.host.writeMemory, NAME, { host: 0x7f000001, port: PORT });

    assert.equal(fx.call('bind', [socket, NAME, SOCKADDR_IN_SIZE]), 0);
    assert.equal(fx.call('getsockname', [socket, NAME2, OUT]), 0);

    assert.deepEqual([...fx.bytes.subarray(NAME2, NAME2 + 8)],
        [...fx.bytes.subarray(NAME, NAME + 8)]);
    assert.equal(fx.dword(OUT), SOCKADDR_IN_SIZE, 'and it says how long the structure is');
});

test('a sockaddr shorter than one is refused rather than read', ()=>{
    const fx = fixture();
    const socket = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    writeSockaddr(fx.host.writeMemory, NAME, { host: 0x7f000001, port: PORT });
    assert.equal(fx.call('bind', [socket, NAME, 4]), SOCKET_ERROR);
});

test('a stale handle is a return code, never a fault', ()=>{
    const fx = fixture();
    for (const name of ['closesocket', 'listen', 'shutdown'])
    {
        assert.equal(fx.call(name, [4242, 0, 0]), SOCKET_ERROR, name);
        assert.equal(fx.call('WSAGetLastError', []), WSAENOTSOCK, name);
    }
});

test('send and recv carry bytes through guest memory', async()=>{
    const fx = fixture();
    const { client, accepted } = connected(fx);

    fx.put(BUFFER, 'hello');
    assert.equal(fx.call('send', [client, BUFFER, 5, 0]), 5);

    assert.equal(await fx.call('recv', [accepted, OUT, 16, 0]), 5);
    assert.equal(fx.read(OUT, 5), 'hello');
});

test('a recv with nothing there waits, and a non-blocking one does not', async()=>{
    const fx = fixture();
    const { client, accepted } = connected(fx);

    // Non-blocking first: it must answer immediately rather than park.
    fx.setDword(OUT2, 1);
    assert.equal(fx.call('ioctlsocket', [accepted, FIONBIO, OUT2]), 0);
    assert.equal(fx.call('recv', [accepted, OUT, 16, 0]), SOCKET_ERROR);
    assert.equal(fx.call('WSAGetLastError', []), WSAEWOULDBLOCK);

    // Blocking: the answer is a promise the bridge parks the guest on.
    fx.setDword(OUT2, 0);
    fx.call('ioctlsocket', [accepted, FIONBIO, OUT2]);
    const pending = fx.call('recv', [accepted, OUT, 16, 0]);
    assert.ok(pending instanceof Promise, 'a blocking call answers with a promise');

    fx.put(BUFFER, 'later');
    fx.call('send', [client, BUFFER, 5, 0]);
    assert.equal(await pending, 5);
    assert.equal(fx.read(OUT, 5), 'later');
});

test('a datagram round trip reports who sent it', async()=>{
    const fx = fixture();
    const receiver = fx.call('socket', [AF_INET, SOCK_DGRAM, 0]);
    writeSockaddr(fx.host.writeMemory, NAME, { host: 0, port: PORT });
    assert.equal(fx.call('bind', [receiver, NAME, SOCKADDR_IN_SIZE]), 0);

    const sender = fx.call('socket', [AF_INET, SOCK_DGRAM, 0]);
    fx.put(BUFFER, 'discover');
    assert.equal(fx.call('sendto', [sender, BUFFER, 8, 0, NAME, SOCKADDR_IN_SIZE]), 8);

    assert.equal(await fx.call('recvfrom', [receiver, OUT, 32, 0, NAME2, OUT2]), 8);
    assert.equal(fx.read(OUT, 8), 'discover');
    assert.equal(fx.dword(OUT2), SOCKADDR_IN_SIZE);
    assert.equal(fx.bytes[NAME2], AF_INET, 'and the address it came from');
});

test('a datagram that does not fit hands over what did and then says so', async()=>{
    const fx = fixture();
    const receiver = fx.call('socket', [AF_INET, SOCK_DGRAM, 0]);
    writeSockaddr(fx.host.writeMemory, NAME, { host: 0, port: PORT });
    fx.call('bind', [receiver, NAME, SOCKADDR_IN_SIZE]);
    const sender = fx.call('socket', [AF_INET, SOCK_DGRAM, 0]);

    fx.put(BUFFER, 'too long for this');
    fx.call('sendto', [sender, BUFFER, 17, 0, NAME, SOCKADDR_IN_SIZE]);

    assert.equal(await fx.call('recvfrom', [receiver, OUT, 3, 0, 0, 0]), SOCKET_ERROR);
    assert.equal(fx.call('WSAGetLastError', []), WSAEMSGSIZE);
    assert.equal(fx.read(OUT, 3), 'too', 'the bytes that fitted were still delivered');
});

test('FIONREAD says how much is waiting; getsockopt says what kind of socket it is', async()=>{
    const fx = fixture();
    const { client, accepted } = connected(fx);
    fx.put(BUFFER, 'four');
    fx.call('send', [client, BUFFER, 4, 0]);

    assert.equal(fx.call('ioctlsocket', [accepted, FIONREAD, OUT]), 0);
    assert.equal(fx.dword(OUT), 4);

    assert.equal(fx.call('getsockopt', [accepted, SOL_SOCKET, SO_TYPE, OUT, OUT2]), 0);
    assert.equal(fx.dword(OUT), SOCK_STREAM);
});

test('overlapped WSARecv reports pending and writes nothing back', ()=>{
    // The count belongs to the completion packet. Writing it here is what makes
    // a program read a byte count for data that has not arrived.
    const fx = fixture();
    const { accepted } = connected(fx);

    fx.setDword(WSABUF, 16);
    fx.setDword(WSABUF + 4, BUFFER);
    fx.setDword(OUT, 0xdeadbeef);
    fx.setDword(OUT2, 0xdeadbeef);

    assert.equal(fx.call('WSARecv', [accepted, WSABUF, 1, OUT, OUT2, 0x700, 0]), SOCKET_ERROR);
    assert.equal(fx.call('WSAGetLastError', []), WSA_IO_PENDING);
    assert.equal(fx.dword(OUT), 0xdeadbeef, 'the byte count was left alone');
    assert.equal(fx.dword(OUT2), 0xdeadbeef, 'and so were the flags');
});

test('an overlapped operation keeps the arguments it was given, not the ones it finds later', ()=>{
    // The async-callback invariant at this boundary: the WSABUF array is guest
    // memory the program may reuse the moment the call returns, so a completion
    // that went back for it would scatter bytes into whatever is there now.
    const fx = fixture();
    const { accepted } = connected(fx);
    const socket = fx.registry.get(accepted);

    fx.setDword(WSABUF, 16);
    fx.setDword(WSABUF + 4, BUFFER);
    fx.call('WSARecv', [accepted, WSABUF, 1, OUT, OUT2, 0x700, 0]);

    // The program reuses the array for something else entirely.
    fx.setDword(WSABUF, 1);
    fx.setDword(WSABUF + 4, 0xbadf00d);

    assert.deepEqual(socket.pending[0].buffers, [{ pointer: BUFFER, length: 16 }]);
    assert.equal(socket.pending[0].overlapped, 0x700,
        'and the overlapped pointer it was handed at call time');
});

test('WSASend gathers the buffers it is given', async()=>{
    const fx = fixture();
    const { client, accepted } = connected(fx);

    fx.put(BUFFER, 'ab');
    fx.put(BUFFER + 8, 'cde');
    fx.setDword(WSABUF, 2);
    fx.setDword(WSABUF + 4, BUFFER);
    fx.setDword(WSABUF + 8, 3);
    fx.setDword(WSABUF + 12, BUFFER + 8);

    assert.equal(fx.call('WSASend', [client, WSABUF, 2, OUT, 0, 0, 0]), 0);
    assert.equal(fx.dword(OUT), 5, 'the count is written on the immediate path');
    assert.equal(await fx.call('recv', [accepted, OUT2 + 4, 16, 0]), 5);
    assert.equal(fx.read(OUT2 + 4, 5), 'abcde');
});

test('select answers at once when something is ready', ()=>{
    const fx = fixture();
    const { client, accepted } = connected(fx);
    fx.put(BUFFER, 'x');
    fx.call('send', [client, BUFFER, 1, 0]);

    fx.setDword(FDSET, 1);
    fx.setDword(FDSET + 4, accepted);
    assert.equal(fx.call('select', [0, FDSET, 0, 0, 0]), 1);
    assert.equal(fx.dword(FDSET), 1, 'and rewrites the set with what is ready');
    assert.equal(fx.dword(FDSET + 4), accepted);
});

test('select with a timeout that expires answers nothing ready', async()=>{
    const fx = fixture();
    const { accepted } = connected(fx);

    fx.setDword(FDSET, 1);
    fx.setDword(FDSET + 4, accepted);
    fx.setDword(TIMEVAL, 0);
    fx.setDword(TIMEVAL + 4, 20_000);

    const started = Date.now();
    assert.equal(await fx.call('select', [0, FDSET, 0, 0, TIMEVAL]), 0);
    assert.ok(Date.now() - started >= 15, 'it waited for its timeout');
    assert.equal(fx.dword(FDSET), 0, 'and emptied the set');
});

test('select with a timeout that does not expire answers when the bytes arrive', async()=>{
    const fx = fixture();
    const { client, accepted } = connected(fx);

    fx.setDword(FDSET, 1);
    fx.setDword(FDSET + 4, accepted);
    fx.setDword(TIMEVAL, 60);
    fx.setDword(TIMEVAL + 4, 0);

    const waiting = fx.call('select', [0, FDSET, 0, 0, TIMEVAL]);
    fx.put(BUFFER, 'y');
    fx.call('send', [client, BUFFER, 1, 0]);

    assert.equal(await waiting, 1);
    assert.equal(fx.dword(FDSET + 4), accepted);
});

test('a zero timeout is a poll, not a wait', ()=>{
    const fx = fixture();
    const { accepted } = connected(fx);
    fx.setDword(FDSET, 1);
    fx.setDword(FDSET + 4, accepted);
    fx.setDword(TIMEVAL, 0);
    fx.setDword(TIMEVAL + 4, 0);

    const answer = /** @type {any} */ (fx.call('select', [0, FDSET, 0, 0, TIMEVAL]));
    assert.ok(!(answer instanceof Promise), 'it answers without parking anyone');
    assert.equal(answer, 0);
});

test('resolution answers for itself and refuses what it cannot know', ()=>{
    // A name pointed at the loopback would have the program connect to it and
    // fail somewhere further away with less to go on.
    const fx = fixture();

    fx.put(NAME, 'localhost');
    assert.notEqual(fx.call('gethostbyname', [NAME]), 0);

    fx.put(NAME2, '10.0.0.7');
    assert.notEqual(fx.call('gethostbyname', [NAME2]), 0, 'a literal resolves to itself');

    fx.put(BUFFER, 'blizzard.example');
    assert.equal(fx.call('gethostbyname', [BUFFER]), 0);
    assert.equal(fx.call('WSAGetLastError', []), WSAHOST_NOT_FOUND);
});

test('inet_addr and inet_ntoa are inverses through guest memory', ()=>{
    const fx = fixture();
    fx.put(NAME, '192.168.0.15');

    const network = fx.call('inet_addr', [NAME]);
    const back = fx.call('inet_ntoa', [network]);
    assert.equal(fx.host.readCString(back, 16), '192.168.0.15');
});

test('AcceptEx hands the connection to the socket the caller supplied', ()=>{
    const fx = fixture();
    const server = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    writeSockaddr(fx.host.writeMemory, NAME, { host: 0, port: PORT });
    fx.call('bind', [server, NAME, SOCKADDR_IN_SIZE]);
    fx.call('listen', [server, 5]);

    const client = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    const target = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    fx.call('connect', [client, NAME, SOCKADDR_IN_SIZE]);

    assert.equal(fx.extension('AcceptEx', [server, target, 0, 0, 0, 0, OUT, 0x700]), 1);

    const accepted = fx.registry.get(target);
    assert.equal(accepted.connected, true);
    assert.equal(accepted.peer, fx.registry.get(client), 'and the two ends know each other');
});

test('a connection accepted by AcceptEx is not one that immediately hung up', async()=>{
    // Folding the connection onto the caller's socket destroys the temporary one
    // it arrived on. A temporary still pointing at the client tells the client
    // its peer is finished -- so the client's first read returns end of stream
    // on a connection that was just established.
    const fx = fixture();
    const server = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    writeSockaddr(fx.host.writeMemory, NAME, { host: 0, port: PORT });
    fx.call('bind', [server, NAME, SOCKADDR_IN_SIZE]);
    fx.call('listen', [server, 5]);

    const client = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    const target = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    fx.call('connect', [client, NAME, SOCKADDR_IN_SIZE]);
    fx.extension('AcceptEx', [server, target, 0, 0, 0, 0, OUT, 0x700]);

    assert.equal(fx.registry.get(client).finished, false, 'the client was not told goodbye');

    fx.put(BUFFER, 'welcome');
    assert.equal(fx.call('send', [target, BUFFER, 7, 0]), 7);
    assert.equal(await fx.call('recv', [client, OUT, 16, 0]), 7);
    assert.equal(fx.read(OUT, 7), 'welcome');
});

test('every ordinal offered names a function this library has', ()=>{
    // A program that imports by number gets no name in its import table at all,
    // so an ordinal pointing at nothing is a call that binds and then jumps into
    // nowhere, with nothing anywhere to say what it was.
    const fx = fixture();
    for (const [library, table] of Object.entries(fx.winsock.ordinals))
    {
        for (const [ordinal, name] of Object.entries(table))
        {
            assert.ok(name in fx.winsock.sockets,
                `${library} ordinal ${ordinal} names ${name}, which is not implemented`);
        }
    }
});

test('an ordinal whose function does not exist is not offered at all', ()=>{
    // The reference table records what each number is, including entries this
    // does not implement. What is exported is the intersection, computed rather
    // than maintained, so the two cannot drift apart.
    const fx = fixture();
    assert.equal(WSOCK32_ORDINALS[51], 'gethostbyaddr', 'the reference still records it');
    assert.equal(51 in fx.winsock.ordinals.wsock32, false, 'and it is not offered');
    assert.ok(Object.keys(fx.winsock.ordinals.wsock32).length
        < Object.keys(WSOCK32_ORDINALS).length, 'something was filtered out');
    assert.equal(fx.winsock.ordinals.wsock32[52], 'gethostbyname',
        'while what does exist survives');
});

test('the two libraries disagree about three ordinals, and only those three', ()=>{
    const wsock32 = /** @type {Record<string, string>} */ (WSOCK32_ORDINALS);
    const ws2_32 = /** @type {Record<string, string>} */ (WS2_32_ORDINALS);
    const differing = Object.keys(wsock32).filter(
        ordinal=>wsock32[ordinal] !== ws2_32[ordinal]);
    assert.deepEqual(differing.sort(), ['10', '11', '12']);
    assert.equal(ws2_32[10], 'ioctlsocket');
    assert.equal(wsock32[10], 'inet_addr');
});

test('the ordinals a real program imports all resolve', ()=>{
    // Taken from the import table of a shipped executable, read by the launch
    // probe: these are the numbers that actually have to resolve, and asking of
    // the offered table rather than the reference is what makes this a check on
    // the implementation rather than on a list.
    const fx = fixture();
    const imported = [1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
        19, 20, 21, 23, 52, 57, 111, 115, 116, 151];
    for (const ordinal of imported)
    {
        const name = fx.winsock.ordinals.wsock32[ordinal];
        assert.ok(name, `ordinal ${ordinal} resolves to nothing`);
        assert.ok(name in fx.winsock.sockets, `ordinal ${ordinal} names ${name}`);
    }
});

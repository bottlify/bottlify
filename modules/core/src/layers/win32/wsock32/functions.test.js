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
    AF_INET, FD_ACCEPT, FD_CLOSE, FD_CONNECT, FD_READ, FD_WRITE, FIONBIO, FIONREAD,
    INVALID_SOCKET, SOCKET_ERROR, SOCK_DGRAM, SOCK_STREAM,
    SOL_SOCKET, SO_TYPE, WSADATA, WSAEINVAL, WSAEMSGSIZE, WSAENOTSOCK, WSAEWOULDBLOCK,
    WSAHOST_NOT_FOUND, WSANOTINITIALISED, WSA_IO_PENDING, WS2_32_ORDINALS, WSOCK32_ORDINALS,
} from './constants.js';
import { SOCKADDR_IN_SIZE, writeSockaddr } from './sockaddr.js';
import { decodeAnsi } from '../kernel32/locale.js';

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
function fixture(/** @type {Record<string, any>} */ extra = {}){
    const bytes = new Uint8Array(0x40000);
    let nextHeap = 0x800;
    let thread = { name: 'main' };
    /** @type {{ hwnd: number, message: number, wParam: number, lParam: number }[]} */
    const posted = [];
    /** @type {number[]} */
    const signalled = [];

    const host = {
        /** @param {number} address @param {number} length */
        readMemory: (address, length)=>bytes.subarray(address, address + length),
        /** @param {number} address @param {Uint8Array} data */
        writeMemory: (address, data)=>bytes.set(data, address),
        /**
         * As the memory layer reads an ANSI string: in Windows-1252, which is
         * what the Encoding standard calls latin1.
         *
         * @param {number} address @param {number} maxLength
         */
        readCString(address, maxLength){
            let end = address;
            while (end - address < maxLength && bytes[end] !== 0)
            {
                end++;
            }
            return decodeAnsi(bytes.subarray(address, end));
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
        /** @param {{ hwnd: number, message: number, wParam: number, lParam: number }} message */
        post: message=>posted.push(message),
        /** @param {number} handle */
        signalEvent: handle=>signalled.push(handle),
        ...extra,
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
        bytes, host, winsock, call, extension, posted, signalled,
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
    assert.equal(view.getUint16((OUT & ~3) + WSADATA.iMaxSockets, true), 32767,
        'a 1.x caller is told the socket limit Windows reports');
    assert.equal(view.getUint16((OUT & ~3) + WSADATA.iMaxUdpDg, true), 65467);

    assert.equal(fx.call('WSAStartup', [0x0202, OUT & ~3]), 0);
    assert.equal(view.getUint16((OUT & ~3) + WSADATA.iMaxSockets, true), 0,
        'Winsock 2 leaves the limits it says to ignore at zero');
    assert.equal(view.getUint16((OUT & ~3) + WSADATA.iMaxUdpDg, true), 0);
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

test('gethostbyaddr names the loopback with this host, and getservbyname reads the services', ()=>{
    // Imported by ordinal, 51 and 55: the reverse of the one address
    // answered without a resolver, and a service's port in network order.
    const fx = fixture();
    const view = new DataView(fx.bytes.buffer);
    /** @param {number} at */
    const text = at=>decodeAnsi(fx.bytes.subarray(at, fx.bytes.indexOf(0, at)));
    fx.bytes.set([127, 0, 0, 1], BUFFER);
    const hostent = fx.call('gethostbyaddr', [BUFFER, 4, AF_INET]);
    assert.notEqual(hostent, 0);
    assert.equal(text(view.getUint32(hostent, true)), 'bottlify');
    fx.bytes.set([10, 0, 0, 7], BUFFER);
    assert.equal(fx.call('gethostbyaddr', [BUFFER, 4, AF_INET]), 0);
    assert.equal(fx.call('WSAGetLastError', []), WSAHOST_NOT_FOUND);
    assert.equal(fx.call('gethostbyaddr', [BUFFER, 4, 23]), 0, 'AF_INET6 is not one');

    fx.put(NAME, 'HTTP');
    fx.put(NAME2, 'tcp');
    const servent = fx.call('getservbyname', [NAME, NAME2]);
    assert.notEqual(servent, 0);
    assert.equal(text(view.getUint32(servent, true)), 'http');
    assert.equal(view.getUint16(servent + 8, false), 80, 's_port, in network order');
    assert.equal(text(view.getUint32(servent + 12, true)), 'tcp');
    fx.put(NAME2, 'udp');
    assert.equal(fx.call('getservbyname', [NAME, NAME2]), 0, 'not listed for udp');
    assert.equal(fx.call('WSAGetLastError', []), 11004, 'WSANO_DATA');
    assert.notEqual(fx.call('getservbyname', [NAME, 0]), 0, 'any protocol');
    assert.deepEqual([fx.winsock.ordinals.wsock32[51], fx.winsock.ordinals.wsock32[55]],
        ['gethostbyaddr', 'getservbyname'], 'and both resolve by ordinal');
});

test('getservbyport finds a service by its port in network order', ()=>{
    // Ordinal 56 in both libraries: the port the program passes is already
    // htons'd, and the answer is getservbyname's record.
    const fx = fixture();
    const view = new DataView(fx.bytes.buffer);
    /** @param {number} at */
    const text = at=>decodeAnsi(fx.bytes.subarray(at, fx.bytes.indexOf(0, at)));
    const servent = fx.call('getservbyport', [0x1500, 0]);
    assert.notEqual(servent, 0);
    assert.equal(text(view.getUint32(servent, true)), 'ftp');
    assert.equal(view.getUint16(servent + 8, false), 21);
    assert.equal(text(view.getUint32(servent + 12, true)), 'tcp');
    fx.put(NAME2, 'UDP');
    const domain = fx.call('getservbyport', [0x3500, NAME2]);
    assert.equal(text(view.getUint32(domain, true)), 'domain');
    assert.equal(text(view.getUint32(domain + 12, true)), 'udp');
    assert.equal(fx.call('getservbyport', [0x1500, NAME2]), 0, 'ftp is not listed for udp');
    assert.equal(fx.call('WSAGetLastError', []), 11004, 'WSANO_DATA');
    assert.equal(fx.call('getservbyport', [0x3930, 0]), 0, 'port 12345 is no service');
    assert.deepEqual([fx.winsock.ordinals.wsock32[56], fx.winsock.ordinals.ws2_32[56]],
        ['getservbyport', 'getservbyport']);
});

test('a resolved name is named in the hostent by the bytes it was asked by', async()=>{
    // The name is read as Windows-1252, where 0x80 is the euro sign and 0x99
    // the trade mark, and h_name goes back in that page.
    const fx = fixture();
    fx.registry.resolve = ()=>Promise.resolve([0x0a000007]);
    fx.bytes.set([0x80, 0x99, 0x2e, 0x78, 0], BUFFER);
    const hostent = await fx.call('gethostbyname', [BUFFER]);
    assert.notEqual(hostent, 0);
    const name = fx.dword(hostent);
    assert.deepEqual([...fx.bytes.subarray(name, name + 5)], [0x80, 0x99, 0x2e, 0x78, 0]);
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
            assert.ok(name in fx.winsock.sockets
                || library === 'wsock32' && name in fx.winsock.extensions,
            `${library} ordinal ${ordinal} names ${name}, which is not implemented`);
        }
    }
});

test('an ordinal whose function does not exist is not offered at all', ()=>{
    // The reference table records what each number is, including entries this
    // does not implement. What is exported is the intersection, computed rather
    // than maintained, so the two cannot drift apart.
    const fx = fixture();
    for (const [library, reference] of /** @type {[string, Record<string, string>][]} */ ([
        ['wsock32', WSOCK32_ORDINALS], ['ws2_32', WS2_32_ORDINALS]]))
    {
        const offered = /** @type {Record<string, string>} */ (
            /** @type {any} */ (fx.winsock.ordinals)[library]);
        // wsock32 forwards three of mswsock's extensions by number too.
        const exported = library === 'wsock32'
            ? { ...fx.winsock.sockets, ...fx.winsock.extensions } : fx.winsock.sockets;
        assert.deepEqual(Object.keys(offered), Object.keys(reference)
            .filter(ordinal=>reference[ordinal] in exported),
        `${library} offers exactly the reference entries that exist`);
    }
    assert.equal(fx.winsock.ordinals.wsock32[52], 'gethostbyname',
        'while what does exist survives');
    // The 1.1 window-message resolver is imported by number by audio
    // middleware of the era, so its two ordinals are offered.
    assert.equal(fx.winsock.ordinals.wsock32[103], 'WSAAsyncGetHostByName');
    assert.equal(fx.winsock.ordinals.wsock32[108], 'WSACancelAsyncRequest');
    assert.equal(fx.winsock.ordinals.wsock32[1141], 'AcceptEx',
        'the extensions of mswsock, which wsock32 forwards by number');
    assert.equal(fx.winsock.ordinals.wsock32[1142], 'GetAcceptExSockaddrs');
});

test('the two libraries disagree about three ordinals, and only those three', ()=>{
    const wsock32 = /** @type {Record<string, string>} */ (WSOCK32_ORDINALS);
    const ws2_32 = /** @type {Record<string, string>} */ (WS2_32_ORDINALS);
    // Of the numbers both have: wsock32's forwards past 1100 are its own.
    const differing = Object.keys(wsock32).filter(
        ordinal=>ordinal in ws2_32 && wsock32[ordinal] !== ws2_32[ordinal]);
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

test('WSAIoctl is ioctlsocket with buffers, and refuses the extension lookup', ()=>{
    const fx = fixture();
    const handle = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    const FLAG = 0x900;
    const COUNT = 0x910;
    const RETURNED = 0x920;
    const SIO_GET_EXTENSION_FUNCTION_POINTER = 0xc8000006;

    fx.setDword(FLAG, 1);
    assert.equal(fx.call('WSAIoctl', [handle, FIONBIO, FLAG, 4, 0, 0, 0, 0, 0]), 0);
    assert.equal(fx.registry.get(handle).nonBlocking, true, 'the flag came from the input buffer');

    assert.equal(fx.call('WSAIoctl', [handle, FIONREAD, 0, 0, COUNT, 4, RETURNED, 0, 0]), 0);
    assert.equal(fx.dword(COUNT), 0, 'nothing waiting on a fresh socket');
    assert.equal(fx.dword(RETURNED), 4, 'and the count is a DWORD');
    assert.equal(fx.call('WSAIoctl', [handle, FIONREAD, 0, 0, COUNT, 2, RETURNED, 0, 0]),
        SOCKET_ERROR, 'a buffer too small for the count');

    assert.equal(fx.call('WSAIoctl',
        [handle, SIO_GET_EXTENSION_FUNCTION_POINTER, 0x930, 16, 0x940, 4, RETURNED, 0, 0]),
    SOCKET_ERROR);
    assert.equal(fx.call('WSAGetLastError'), 10045,
        'WSAEOPNOTSUPP sends a program to the plain calls');

    assert.equal(fx.call('WSAIoctl', [handle, 0x12345, 0, 0, 0, 0, 0, 0, 0]), SOCKET_ERROR);
    assert.equal(fx.call('WSAGetLastError'), 10022, 'WSAEINVAL for a command it has not got');
    assert.equal(fx.call('WSAIoctl', [0x7777, FIONBIO, FLAG, 4, 0, 0, 0, 0, 0]), SOCKET_ERROR);
    assert.equal(fx.call('WSAGetLastError'), 10038, 'WSAENOTSOCK');
});

test('the controls a socket is set up with: UDP resets, keep-alive, its base and its address',
    ()=>{
        const fx = fixture();
        const stream = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
        const datagram = fx.call('socket', [AF_INET, SOCK_DGRAM, 0]);
        const IN = 0x900;
        const ANSWER = 0x980;
        const RETURNED = 0x9f0;
        fx.setDword(IN, 0);
        assert.equal(fx.call('WSAIoctl', [datagram, 0x9800000c, IN, 4, 0, 0, RETURNED, 0, 0]), 0,
            'SIO_UDP_CONNRESET');
        assert.equal(fx.call('WSAIoctl', [datagram, 0x9800000f, IN, 4, 0, 0, RETURNED, 0, 0]), 0,
            'SIO_UDP_NETRESET');
        assert.equal(fx.call('WSAIoctl', [stream, 0x9800000c, IN, 4, 0, 0, RETURNED, 0, 0]),
            SOCKET_ERROR, 'a stream socket has no UDP resets');
        assert.equal(fx.call('WSAIoctl', [stream, 0x98000004, IN, 12, 0, 0, RETURNED, 0, 0]), 0,
            'SIO_KEEPALIVE_VALS');
        assert.equal(fx.call('WSAIoctl', [stream, 0x98000004, IN, 4, 0, 0, RETURNED, 0, 0]),
            SOCKET_ERROR, 'a tcp_keepalive is twelve bytes');
        assert.equal(fx.call('WSAIoctl', [stream, 0x98000010, IN, 4, 0, 0, RETURNED, 0, 0]), 0,
            'SIO_LOOPBACK_FAST_PATH');
        assert.equal(fx.call('WSAIoctl', [stream, 0x48000022, 0, 0, ANSWER, 4, RETURNED, 0, 0]),
            0);
        assert.equal(fx.dword(ANSWER), stream, 'SIO_BASE_HANDLE: its own base');
        assert.equal(fx.call('WSAIoctl', [stream, 0x48000016, 0, 0, ANSWER, 64, RETURNED, 0, 0]),
            0);
        assert.deepEqual([fx.dword(ANSWER), fx.dword(ANSWER + 4), fx.dword(ANSWER + 8)],
            [1, ANSWER + 12, 16],
            'SIO_ADDRESS_LIST_QUERY: one address, in the buffer after the list');
        assert.equal(fx.dword(RETURNED), 28);
        assert.equal(fx.call('WSAIoctl', [stream, 0x48000016, 0, 0, ANSWER, 8, RETURNED, 0, 0]),
            SOCKET_ERROR, 'too small a buffer');
        assert.equal(fx.dword(RETURNED), 28, 'and the size it needs');
        assert.equal(fx.call('WSAIoctl',
            [datagram, 0xc8000014, IN, 16, ANSWER, 16, RETURNED, 0, 0]), 0,
        'SIO_ROUTING_INTERFACE_QUERY');
        assert.equal(fx.dword(ANSWER) & 0xffff, AF_INET);
    });

test('SIO_GET_EXTENSION_FUNCTION_POINTER answers mswsock\'s export for each GUID mswsock.h names',
    async()=>{
        /** @type {string[]} */
        const asked = [];
        const exports = { AcceptEx: 0x7100, ConnectEx: 0x7110, GetAcceptExSockaddrs: 0x7120,
            DisconnectEx: 0x7130, TransmitFile: 0x7140 };
        const fx = fixture({
            /** @param {string} name */
            extension: name=>{
                asked.push(name);
                // ConnectEx as a library still loading answers it.
                return name === 'ConnectEx' ? Promise.resolve(exports[name])
                    : exports[/** @type {keyof typeof exports} */ (name)] ?? 0;
            },
        });
        const handle = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
        const GUID = 0x930, POINTER = 0x940, RETURNED = 0x950;
        const SIO_GET_EXTENSION_FUNCTION_POINTER = 0xc8000006;
        /** A GUID laid out as the structure holds it. @param {string} text */
        const putGuid = text=>{
            const [a, b, c, d, e] = text.split('-');
            const bytes = new Uint8Array(16);
            const view = new DataView(bytes.buffer);
            view.setUint32(0, parseInt(a, 16), true);
            view.setUint16(4, parseInt(b, 16), true);
            view.setUint16(6, parseInt(c, 16), true);
            bytes.set(Buffer.from(d + e, 'hex'), 8);
            fx.host.writeMemory(GUID, bytes);
        };
        const lookup = ()=>fx.call('WSAIoctl',
            [handle, SIO_GET_EXTENSION_FUNCTION_POINTER, GUID, 16, POINTER, 4, RETURNED, 0, 0]);
        const guids = {
            AcceptEx: 'b5367df1-cbac-11cf-95ca-00805f48a192',
            GetAcceptExSockaddrs: 'b5367df2-cbac-11cf-95ca-00805f48a192',
            TransmitFile: 'b5367df0-cbac-11cf-95ca-00805f48a192',
            DisconnectEx: '7fda2e11-8630-436f-a031-f536a6eec157',
        };
        for (const [name, guid] of Object.entries(guids))
        {
            putGuid(guid);
            fx.setDword(RETURNED, 0);
            assert.equal(lookup(), 0, name);
            assert.equal(fx.dword(POINTER), exports[/** @type {keyof typeof exports} */ (name)], name);
            assert.equal(fx.dword(RETURNED), 4, 'a pointer\'s size comes back');
        }
        putGuid('25a207b9-ddf3-4660-8ee9-76e58c74063e');
        assert.equal(await lookup(), 0, 'ConnectEx, once mswsock has loaded');
        assert.equal(fx.dword(POINTER), 0x7110);
        assert.deepEqual(asked, ['AcceptEx', 'GetAcceptExSockaddrs', 'TransmitFile',
            'DisconnectEx', 'ConnectEx']);

        // WSARecvMsg's GUID: an extension this provider does not have.
        putGuid('f689d7c8-6f1f-436b-8a53-e54fe351c322');
        assert.equal(lookup(), SOCKET_ERROR);
        assert.equal(fx.call('WSAGetLastError'), 10022, 'WSAEINVAL for a GUID it does not know');
        putGuid(guids.AcceptEx);
        assert.equal(fx.call('WSAIoctl',
            [handle, SIO_GET_EXTENSION_FUNCTION_POINTER, GUID, 16, POINTER, 2, RETURNED, 0, 0]),
        SOCKET_ERROR);
        assert.equal(fx.call('WSAGetLastError'), 10014, 'WSAEFAULT: no room for the pointer');
        assert.equal(fx.call('WSAIoctl',
            [handle, SIO_GET_EXTENSION_FUNCTION_POINTER, GUID, 8, POINTER, 4, RETURNED, 0, 0]),
        SOCKET_ERROR);
        assert.equal(fx.call('WSAGetLastError'), 10014, 'WSAEFAULT: half a GUID');
    });

/**
 * Readiness as a window message. `wParam` is always the socket; `lParam` is
 * WSAMAKESELECTREPLY(event, error) -- the event in the low word, the error
 * (0 on success) in the high word.
 */

test('WSAAsyncSelect posts FD_ACCEPT the moment a connection lands in the backlog', ()=>{
    const fx = fixture();
    const server = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    writeSockaddr(fx.host.writeMemory, NAME, { host: 0, port: PORT });
    fx.call('bind', [server, NAME, SOCKADDR_IN_SIZE]);
    fx.call('listen', [server, 5]);
    const HWND = 0x9001, MSG = 0x8001;
    assert.equal(fx.call('WSAAsyncSelect', [server, HWND, MSG, FD_ACCEPT]), 0);
    assert.equal(fx.posted.length, 0, 'nothing is waiting yet');

    const client = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    assert.equal(fx.call('connect', [client, NAME, SOCKADDR_IN_SIZE]), 0);

    assert.deepEqual(fx.posted, [{ hwnd: HWND, message: MSG, wParam: server, lParam: FD_ACCEPT }]);
});

test('WSAAsyncSelect posts FD_WRITE at once for a socket already writable, and not twice', ()=>{
    const fx = fixture();
    const { client } = connected(fx);
    const HWND = 0x9002, MSG = 0x8002;
    assert.equal(fx.call('WSAAsyncSelect', [client, HWND, MSG, FD_WRITE]), 0);
    assert.deepEqual(fx.posted, [{ hwnd: HWND, message: MSG, wParam: client, lParam: FD_WRITE }]);

    fx.call('send', [client, BUFFER, 0, 0]);
    assert.equal(fx.posted.length, 1, 'this engine never has send report WSAEWOULDBLOCK to clear');
});

test('FD_READ is level-triggered and only recv re-arms it', ()=>{
    const fx = fixture();
    const { client, accepted } = connected(fx);
    const HWND = 0x9003, MSG = 0x8003;
    assert.equal(fx.call('WSAAsyncSelect', [accepted, HWND, MSG, FD_READ]), 0);

    fx.put(BUFFER, 'a');
    fx.call('send', [client, BUFFER, 1, 0]);
    assert.deepEqual(fx.posted, [{ hwnd: HWND, message: MSG, wParam: accepted, lParam: FD_READ }]);

    fx.put(BUFFER, 'b');
    fx.call('send', [client, BUFFER, 1, 0]);
    assert.equal(fx.posted.length, 1, 'more data with no recv in between reports nothing new');

    fx.call('recv', [accepted, OUT, 1, 0]);
    assert.equal(fx.posted.length, 2, 'recv re-armed it, and a byte is still queued');
    assert.equal(fx.posted[1].lParam, FD_READ);

    fx.call('recv', [accepted, OUT, 1, 0]);
    assert.equal(fx.posted.length, 2, 'the queue is empty now, so re-arming reports nothing');
});

test('WSAAsyncSelect delivers FD_CONNECT and then FD_WRITE when a connect succeeds', ()=>{
    const fx = fixture();
    const server = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    writeSockaddr(fx.host.writeMemory, NAME, { host: 0, port: PORT });
    fx.call('bind', [server, NAME, SOCKADDR_IN_SIZE]);
    fx.call('listen', [server, 5]);

    const client = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    const HWND = 0x9004, MSG = 0x8004;
    assert.equal(fx.call('WSAAsyncSelect', [client, HWND, MSG, FD_CONNECT | FD_WRITE]), 0);
    assert.equal(fx.call('connect', [client, NAME, SOCKADDR_IN_SIZE]), 0);

    assert.deepEqual(fx.posted, [
        { hwnd: HWND, message: MSG, wParam: client, lParam: FD_CONNECT },
        { hwnd: HWND, message: MSG, wParam: client, lParam: FD_WRITE },
    ]);
});

test('WSAAsyncSelect reports a refused connect through FD_CONNECT\'s error half', ()=>{
    const fx = fixture();
    const client = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    writeSockaddr(fx.host.writeMemory, NAME, { host: 0, port: PORT }); // nobody listens here
    const HWND = 0x9005, MSG = 0x8005;
    fx.call('WSAAsyncSelect', [client, HWND, MSG, FD_CONNECT]);

    assert.equal(fx.call('connect', [client, NAME, SOCKADDR_IN_SIZE]), SOCKET_ERROR);
    assert.equal(fx.posted.length, 1);
    assert.equal(fx.posted[0].lParam & 0xffff, FD_CONNECT);
    assert.equal(fx.posted[0].lParam >>> 16, 10061, 'WSAECONNREFUSED in the high word');
});

test('FD_CLOSE fires once for a peer that finished, and closesocket posts nothing itself', ()=>{
    const fx = fixture();
    const { client, accepted } = connected(fx);
    const HWND = 0x9006, MSG = 0x8006;
    assert.equal(fx.call('WSAAsyncSelect', [accepted, HWND, MSG, FD_CLOSE]), 0);

    fx.call('shutdown', [client, 1]); // SD_SEND
    assert.deepEqual(fx.posted, [{ hwnd: HWND, message: MSG, wParam: accepted, lParam: FD_CLOSE }]);

    fx.call('closesocket', [accepted]);
    assert.equal(fx.posted.length, 1, 'closing this socket itself posts nothing more');
});

test('lEvent = 0 cancels a WSAAsyncSelect registration, and a second call replaces it', ()=>{
    const fx = fixture();
    const { client, accepted } = connected(fx);
    fx.call('WSAAsyncSelect', [accepted, 0x9007, 0x8007, FD_READ]);
    assert.equal(fx.call('WSAAsyncSelect', [accepted, 0, 0, 0]), 0);

    fx.put(BUFFER, 'z');
    fx.call('send', [client, BUFFER, 1, 0]);
    assert.equal(fx.posted.length, 0, 'nothing is armed any more');

    const HWND = 0x9008, MSG = 0x8008;
    assert.equal(fx.call('WSAAsyncSelect', [accepted, HWND, MSG, FD_READ]), 0);
    assert.deepEqual(fx.posted, [{ hwnd: HWND, message: MSG, wParam: accepted, lParam: FD_READ }],
        'data already waiting is reported at once, from the new registration');
});

test('select and WSAAsyncSelect are mutually exclusive on a socket', ()=>{
    const fx = fixture();
    const { accepted } = connected(fx);
    fx.call('WSAAsyncSelect', [accepted, 0x9009, 0x8009, FD_READ]);

    fx.setDword(FDSET, 1);
    fx.setDword(FDSET + 4, accepted);
    assert.equal(fx.call('select', [0, FDSET, 0, 0, 0]), SOCKET_ERROR);
    assert.equal(fx.call('WSAGetLastError'), WSAEINVAL);
});

test('WSAEventSelect signals a kernel event, and WSAEnumNetworkEvents reports and clears it', ()=>{
    const fx = fixture();
    const { client, accepted } = connected(fx);
    const EVENT_HANDLE = 0x77;
    const EVENTS = 0x700;

    assert.equal(fx.call('WSAEventSelect', [accepted, EVENT_HANDLE, FD_READ]), 0);
    assert.equal(fx.registry.get(accepted).nonBlocking, true, 'it sets non-blocking mode too');
    assert.deepEqual(fx.signalled, [], 'nothing waiting yet');

    fx.put(BUFFER, 'q');
    fx.call('send', [client, BUFFER, 1, 0]);
    assert.deepEqual(fx.signalled, [EVENT_HANDLE]);

    assert.equal(fx.call('WSAEnumNetworkEvents', [accepted, EVENT_HANDLE, EVENTS]), 0);
    assert.equal(fx.dword(EVENTS), FD_READ, 'lNetworkEvents carries the bit that fired');
    assert.equal(fx.dword(EVENTS + 4), 0, 'iErrorCode[0] -- FD_READ succeeded');

    assert.equal(fx.call('WSAEnumNetworkEvents', [accepted, EVENT_HANDLE, EVENTS]), 0);
    assert.equal(fx.dword(EVENTS), 0, 'reading it clears it');
});

test('WSAEnumNetworkEvents resets the event it is handed', ()=>{
    // A manual-reset event left signalled answers every wait at once: a
    // network thread that waits, enumerates and selects again spins on it.
    const kernel = fakeKernel();
    const fx = fixture({ kernel32: kernel.kernel32 });
    const { accepted } = connected(fx);
    const event = fx.call('WSACreateEvent');
    assert.equal(fx.call('WSASetEvent', [event]), 1);
    assert.equal(fx.call('WSAEventSelect', [accepted, event, FD_READ]), 0);
    assert.equal(fx.call('WSAEnumNetworkEvents', [accepted, event, 0x700]), 0);
    assert.equal(kernel.events.get(event)?.signalled, false);
});

test('WSAEventSelect cancels a prior WSAAsyncSelect on the same socket', ()=>{
    const fx = fixture();
    const { client, accepted } = connected(fx);
    fx.call('WSAAsyncSelect', [accepted, 0x900a, 0x800a, FD_READ]);
    fx.call('WSAEventSelect', [accepted, 0x88, FD_READ]);

    fx.put(BUFFER, 'w');
    fx.call('send', [client, BUFFER, 1, 0]);
    assert.equal(fx.posted.length, 0, 'the window registration no longer applies');
    assert.deepEqual(fx.signalled, [0x88]);
});

test('WSAAsyncGetHostByName posts the reply with the hostent in the caller\'s buffer',
    async()=>{
        const fx = fixture();
        const HWND = 0x900b, MSG = 0x800b;
        fx.put(NAME, 'localhost');
        const BUF = 0x900, BUFLEN = 128;

        const task = fx.call('WSAAsyncGetHostByName', [HWND, MSG, NAME, BUF, BUFLEN]);
        assert.notEqual(task, 0);
        assert.equal(fx.posted.length, 0, 'the reply is never synchronous');

        await Promise.resolve();
        await Promise.resolve();
        assert.equal(fx.posted.length, 1);
        const { hwnd, message, wParam, lParam } = fx.posted[0];
        assert.equal(hwnd, HWND);
        assert.equal(message, MSG);
        assert.equal(wParam, task);
        assert.equal(lParam & 0xffff, BUFLEN, 'WSAMAKEASYNCREPLY: the length in the low word');
        assert.equal(lParam >>> 16, 0, 'and no error in the high word');

        const nameAt = fx.dword(BUF);
        assert.ok(nameAt >= BUF && nameAt < BUF + BUFLEN, 'h_name lands inside the given buffer');
    });

test('WSACancelAsyncRequest stops the reply from ever being posted', async()=>{
    const fx = fixture();
    fx.put(NAME, 'localhost');
    const task = fx.call('WSAAsyncGetHostByName', [0x900c, 0x800c, NAME, 0x900, 128]);
    assert.equal(fx.call('WSACancelAsyncRequest', [task]), 0);

    await Promise.resolve();
    await Promise.resolve();
    assert.equal(fx.posted.length, 0, 'the cancelled task never posts');
});

/**
 * The kernel32 calls winsock reaches through its host: the events it makes
 * and waits on, and a file ReadFile reads from.
 *
 * @param {Uint8Array} [file]
 */
function fakeKernel(file = new Uint8Array(0)){
    /** @type {Map<number, { manual: boolean, signalled: boolean }>} */
    const events = new Map();
    /** @type {number[][]} */
    const waits = [];
    let next = 0x40;
    let lastError = 0;
    let position = 0;
    /** @type {any} */
    let memory = null;
    /** @type {any} */
    let waitAnswer = 0;
    /** @param {number} handle */
    const known = handle=>{
        if (!events.has(handle))
        {
            lastError = 6;
            return null;
        }
        return /** @type {{ manual: boolean, signalled: boolean }} */ (events.get(handle));
    };
    /** @type {Record<string, (args: number[]) => any>} */
    const table = {
        CreateEventA: ([, manual, initial])=>{
            next += 4;
            events.set(next, { manual: manual !== 0, signalled: initial !== 0 });
            return next;
        },
        CloseHandle: ([handle])=>(known(handle) && events.delete(handle) ? 1 : 0),
        SetEvent: ([handle])=>{
            const event = known(handle);
            return event ? (event.signalled = true, 1) : 0;
        },
        ResetEvent: ([handle])=>{
            const event = known(handle);
            return event ? (event.signalled = false, 1) : 0;
        },
        WaitForMultipleObjectsEx: args=>{
            waits.push(args);
            if (waitAnswer === 0xffffffff)
            {
                lastError = 6;
            }
            return waitAnswer;
        },
        GetLastError: ()=>lastError,
        ReadFile: ([handle, buffer, wanted, read])=>{
            if (handle !== 0x77)
            {
                lastError = 6;
                return 0;
            }
            const bytes = file.subarray(position, position + wanted);
            position += bytes.length;
            memory.writeMemory(buffer, bytes);
            memory.writeMemory(read, new Uint8Array(new Uint32Array([bytes.length]).buffer));
            return 1;
        },
    };
    return {
        events,
        waits,
        kernel32: (/** @type {string} */ name)=>table[name],
        /** @param {any} host */
        attach(host){
            memory = host;
        },
        /** @param {any} value */
        answerWaits(value){
            waitAnswer = value;
        },
    };
}

const WSA_INVALID_HANDLE = 6;
const WSA_NOT_ENOUGH_MEMORY = 8;
const WSA_INVALID_PARAMETER = 87;
const WSA_OPERATION_ABORTED = 995;
const WSA_IO_INCOMPLETE = 996;
const WSAEAFNOSUPPORT = 10047;
const WSAEFAULT = 10014;
const WSAEOPNOTSUPP = 10045;
const WSAESOCKTNOSUPPORT = 10044;
const WSANO_DATA = 11004;
const WSANO_RECOVERY = 11003;
const WSATYPE_NOT_FOUND = 10109;
const STATUS_PENDING = 0x103;
/** A WSAOVERLAPPED, and the event it names. */
const OVERLAPPED = 0x30000;
const EVENT = 0x1234;
/** Where the heap cannot reach in these tests: ADDRINFOA results, hints, a WSAPROTOCOL_INFO. */
const RESULT = 0x30100;
const HINTS = 0x30200;
const INFO = 0x30300;
const TEXT = 0x30400;
const TEXT2 = 0x30480;

/** @param {ReturnType<typeof fixture>} fx @param {number} hEvent */
function overlapped(fx, hEvent = EVENT){
    fx.bytes.fill(0xcc, OVERLAPPED, OVERLAPPED + 20);
    fx.setDword(OVERLAPPED + 16, hEvent);
    return OVERLAPPED;
}

/** @param {ReturnType<typeof fixture>} fx @param {number} address @param {string} text */
function cstring(fx, address, text){
    fx.bytes.set([...new TextEncoder().encode(text), 0], address);
    return address;
}

test('the WSA event calls are the kernel\'s event calls, a manual-reset event made', ()=>{
    const kernel = fakeKernel();
    const fx = fixture({ kernel32: kernel.kernel32 });
    const event = fx.call('WSACreateEvent');
    assert.notEqual(event, 0);
    assert.deepEqual(kernel.events.get(event), { manual: true, signalled: false },
        'manual reset and not signalled, as WSACreateEvent documents');
    assert.equal(fx.call('WSASetEvent', [event]), 1);
    assert.equal(kernel.events.get(event)?.signalled, true);
    assert.equal(fx.call('WSAResetEvent', [event]), 1);
    assert.equal(kernel.events.get(event)?.signalled, false);
    assert.equal(fx.call('WSACloseEvent', [event]), 1);

    // The kernel's reason is the one WSAGetLastError reports: one slot on Windows.
    assert.equal(fx.call('WSACloseEvent', [event]), 0);
    assert.equal(fx.call('WSAGetLastError'), WSA_INVALID_HANDLE);
    assert.equal(fx.call('WSASetEvent', [0x999]), 0);
    assert.equal(fx.call('WSAResetEvent', [0x999]), 0);
    assert.equal(fx.winsock.sockets.WSACreateEvent.argBytes, 0);
    assert.equal(fx.winsock.sockets.WSACloseEvent.argBytes, 4);
});

test('WSAWaitForMultipleEvents is WaitForMultipleObjectsEx with the same five arguments', async()=>{
    const kernel = fakeKernel();
    const fx = fixture({ kernel32: kernel.kernel32 });
    kernel.answerWaits(1);
    assert.equal(fx.call('WSAWaitForMultipleEvents', [2, 0x500, 0, 100, 1]), 1);
    assert.deepEqual(kernel.waits[0], [2, 0x500, 0, 100, 1]);

    kernel.answerWaits(Promise.resolve(0x102));
    assert.equal(await fx.call('WSAWaitForMultipleEvents', [1, 0x500, 1, 5, 0]), 0x102,
        'a wait that blocks answers when the kernel does');

    kernel.answerWaits(0xffffffff);
    assert.equal(fx.call('WSAWaitForMultipleEvents', [1, 0x500, 0, 0, 0]), 0xffffffff);
    assert.equal(fx.call('WSAGetLastError'), WSA_INVALID_HANDLE);

    for (const count of [0, 65])
    {
        assert.equal(fx.call('WSAWaitForMultipleEvents', [count, 0x500, 0, 0, 0]), 0xffffffff);
        assert.equal(fx.call('WSAGetLastError'), WSA_INVALID_PARAMETER);
    }
    assert.equal(kernel.waits.length, 3, 'a refused count never reaches the kernel');
});

test('without a kernel to reach, the event calls and TransmitFile are refused soundly', ()=>{
    /** @type {string[]} */
    const said = [];
    const fx = fixture({ divergence: (/** @type {string} */ api)=>said.push(api) });
    assert.equal(fx.call('WSACreateEvent'), 0, 'WSA_INVALID_EVENT');
    assert.equal(fx.call('WSAGetLastError'), WSA_NOT_ENOUGH_MEMORY);
    assert.equal(fx.call('WSACloseEvent', [0x40]), 0);
    assert.equal(fx.call('WSAGetLastError'), WSA_INVALID_HANDLE);
    assert.equal(fx.call('WSAWaitForMultipleEvents', [1, 0x500, 0, 0, 0]), 0xffffffff);
    assert.equal(fx.call('TransmitFile', [1, 0, 0, 0, 0, 0, 0]), 0);
    assert.equal(fx.call('WSAGetLastError'), WSAEOPNOTSUPP);
    assert.equal(fx.winsock.sockets.TransmitFile.argBytes, 28);
    assert.ok(said.includes('WSACreateEvent') && said.includes('TransmitFile'));
});

test('an overlapped WSARecv that waits completes in its WSAOVERLAPPED when bytes arrive',
    async()=>{
        const fx = fixture();
        const { client, accepted } = connected(fx);
        fx.setDword(WSABUF, 16);
        fx.setDword(WSABUF + 4, BUFFER);
        const ov = overlapped(fx);

        assert.equal(fx.call('WSARecv', [accepted, WSABUF, 1, OUT, OUT2, ov, 0]), SOCKET_ERROR);
        assert.equal(fx.call('WSAGetLastError'), WSA_IO_PENDING);
        assert.equal(fx.dword(ov), STATUS_PENDING, 'Internal says pending while it lasts');
        assert.equal(fx.call('WSAGetOverlappedResult', [accepted, ov, OUT, 0, OUT2]), 0);
        assert.equal(fx.call('WSAGetLastError'), WSA_IO_INCOMPLETE);
        const waited = fx.call('WSAGetOverlappedResult', [accepted, ov, OUT, 1, OUT2]);
        assert.ok(waited instanceof Promise, 'fWait waits for the completion');

        fx.put(TEXT, 'hello');
        fx.setDword(WSABUF + 8, 5);
        fx.setDword(WSABUF + 12, TEXT);
        assert.equal(fx.call('WSASend', [client, WSABUF + 8, 1, OUT2, 0, 0, 0]), 0);
        assert.equal(await waited, 1);
        assert.equal(fx.dword(OUT), 5, 'the count the completion carried');
        assert.equal(fx.read(BUFFER, 5), 'hello', 'into the buffers taken at the call');
        assert.equal(fx.dword(ov), 0, 'Internal: STATUS_SUCCESS');
        assert.equal(fx.dword(ov + 4), 5, 'InternalHigh: the bytes');
        assert.deepEqual(fx.signalled, [EVENT], 'and its event signalled');
        assert.equal(fx.registry.get(accepted).pending.length, 0, 'nothing left pending');
    });

test('an overlapped send completes at once, its event signalled as Windows does', ()=>{
    const fx = fixture();
    const { client } = connected(fx);
    fx.put(TEXT, 'abc');
    fx.setDword(WSABUF, 3);
    fx.setDword(WSABUF + 4, TEXT);
    const ov = overlapped(fx, EVENT | 1);
    assert.equal(fx.call('WSASend', [client, WSABUF, 1, OUT, 0, ov, 0]), 0);
    assert.equal(fx.dword(OUT), 3);
    assert.equal(fx.dword(ov), 0);
    assert.equal(fx.dword(ov + 4), 3);
    assert.deepEqual(fx.signalled, [EVENT], 'the low bit is not part of the handle');
    assert.equal(fx.call('WSAGetOverlappedResult', [client, ov, OUT2, 0, 0]), 1);
    assert.equal(fx.dword(OUT2), 3);
});

test('a socket closed under a pending receive aborts it', async()=>{
    const fx = fixture();
    const { accepted } = connected(fx);
    fx.setDword(WSABUF, 16);
    fx.setDword(WSABUF + 4, BUFFER);
    const ov = overlapped(fx);
    fx.call('WSARecv', [accepted, WSABUF, 1, OUT, OUT2, ov, 0]);
    const waited = fx.call('WSAGetOverlappedResult', [accepted, ov, OUT, 1, 0]);
    assert.equal(fx.call('closesocket', [accepted]), 0);
    // The socket is gone, so the result is asked about through the promise taken before.
    await waited.catch(()=>0);
    assert.notEqual(fx.dword(ov), STATUS_PENDING);
    assert.notEqual(fx.dword(ov), 0, 'not a success');
    assert.deepEqual(fx.signalled, [EVENT]);
    const other = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    assert.equal(fx.call('WSAGetOverlappedResult', [other, ov, OUT, 0, 0]), 0);
    assert.equal(fx.call('WSAGetLastError'), WSA_OPERATION_ABORTED);
});

test('WSASendTo and WSARecvFrom carry a datagram and who sent it', async()=>{
    const fx = fixture();
    const receiver = fx.call('socket', [AF_INET, SOCK_DGRAM, 0]);
    writeSockaddr(fx.host.writeMemory, NAME, { host: 0x7f000001, port: PORT });
    assert.equal(fx.call('bind', [receiver, NAME, SOCKADDR_IN_SIZE]), 0);
    const sender = fx.call('socket', [AF_INET, SOCK_DGRAM, 0]);

    fx.put(TEXT, 'ping');
    fx.setDword(WSABUF, 4);
    fx.setDword(WSABUF + 4, TEXT);
    assert.equal(fx.call('WSASendTo', [sender, WSABUF, 1, OUT, 0, NAME, 8, 0, 0]), SOCKET_ERROR,
        'a length that cannot hold a sockaddr_in');
    assert.equal(fx.call('WSAGetLastError'), WSAEFAULT);
    assert.equal(fx.call('WSASendTo', [sender, WSABUF, 1, OUT, 0, NAME, SOCKADDR_IN_SIZE, 0, 0]),
        0);
    assert.equal(fx.dword(OUT), 4);

    fx.setDword(WSABUF + 8, 16);
    fx.setDword(WSABUF + 12, BUFFER);
    fx.setDword(OUT2, 4);
    assert.equal(fx.call('WSARecvFrom', [receiver, WSABUF + 8, 1, OUT, 0, NAME2, OUT2, 0, 0]),
        SOCKET_ERROR, 'a from-length too short is refused before anything is taken');
    assert.equal(fx.call('WSAGetLastError'), WSAEFAULT);
    fx.setDword(OUT2, SOCKADDR_IN_SIZE);
    fx.setDword(TIMEVAL, 0xdead);
    assert.equal(fx.call('WSARecvFrom',
        [receiver, WSABUF + 8, 1, OUT, TIMEVAL, NAME2, OUT2, 0, 0]), 0);
    assert.equal(fx.dword(OUT), 4);
    assert.equal(fx.dword(TIMEVAL), 0, 'the flags come back empty');
    assert.equal(fx.read(BUFFER, 4), 'ping');
    assert.equal(fx.bytes[NAME2], AF_INET);
    assert.equal(fx.dword(OUT2), SOCKADDR_IN_SIZE);
    assert.equal(fx.winsock.sockets.WSARecvFrom.argBytes, 36);
    assert.equal(fx.winsock.sockets.WSASendTo.argBytes, 36);
});

test('a completion routine is refused, never accepted and left unrun', ()=>{
    const fx = fixture();
    const { client, accepted } = connected(fx);
    fx.setDword(WSABUF, 1);
    fx.setDword(WSABUF + 4, BUFFER);
    for (const [name, args] of /** @type {[string, number[]][]} */ ([
        ['WSARecv', [accepted, WSABUF, 1, OUT, OUT2, OVERLAPPED, 0x401000]],
        ['WSASend', [client, WSABUF, 1, OUT, 0, OVERLAPPED, 0x401000]],
        ['WSARecvFrom', [accepted, WSABUF, 1, OUT, OUT2, 0, 0, OVERLAPPED, 0x401000]],
        ['WSASendTo', [client, WSABUF, 1, OUT, 0, 0, 0, OVERLAPPED, 0x401000]],
    ]))
    {
        assert.equal(fx.call(name, args), SOCKET_ERROR, name);
        assert.equal(fx.call('WSAGetLastError'), WSAEOPNOTSUPP, name);
    }
});

test('WSAConnect connects and hands back no callee data', ()=>{
    const fx = fixture();
    const server = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    writeSockaddr(fx.host.writeMemory, NAME, { host: 0, port: PORT });
    fx.call('bind', [server, NAME, SOCKADDR_IN_SIZE]);
    fx.call('listen', [server, 5]);
    const client = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    fx.setDword(WSABUF, 99);
    assert.equal(fx.call('WSAConnect', [client, NAME, SOCKADDR_IN_SIZE, 0, WSABUF, 0, 0]), 0);
    assert.equal(fx.dword(WSABUF), 0, 'the WSABUF\'s length is zero');
    assert.notEqual(fx.call('accept', [server, 0, 0]), INVALID_SOCKET);
    assert.equal(fx.call('WSAConnect', [0x999, NAME, SOCKADDR_IN_SIZE, 0, 0, 0, 0]),
        SOCKET_ERROR);
    assert.equal(fx.call('WSAGetLastError'), WSAENOTSOCK);
});

test('WSASocketA takes FROM_PROTOCOL_INFO from the description it is handed', ()=>{
    const fx = fixture();
    fx.setDword(INFO + 76, AF_INET);
    fx.setDword(INFO + 88, SOCK_DGRAM);
    fx.setDword(INFO + 92, 17);
    const made = fx.call('WSASocketA', [0xffffffff, 0xffffffff, 0xffffffff, INFO, 0, 1]);
    assert.notEqual(made, INVALID_SOCKET);
    assert.equal(fx.registry.get(made).type, SOCK_DGRAM);
    const plain = fx.call('WSASocketA', [AF_INET, SOCK_STREAM, 6, 0, 0, 1]);
    assert.equal(fx.registry.get(plain).type, SOCK_STREAM);
    assert.equal(fx.call('WSASocketA', [AF_INET, SOCK_STREAM, 6, 0, 1, 0]), INVALID_SOCKET,
        'a socket group is not one this stack forms');
    assert.equal(fx.call('WSAGetLastError'), WSAEINVAL);
    assert.equal(fx.call('WSASocketA', [23, SOCK_STREAM, 0, 0, 0, 0]), INVALID_SOCKET);
    assert.equal(fx.call('WSAGetLastError'), WSAEAFNOSUPPORT);
});

/** @param {ReturnType<typeof fixture>} fx @param {number} node */
function addrinfoAt(fx, node){
    return {
        flags: fx.dword(node), family: fx.dword(node + 4), socktype: fx.dword(node + 8),
        protocol: fx.dword(node + 12), addrlen: fx.dword(node + 16),
        canonname: fx.dword(node + 20), addr: fx.dword(node + 24), next: fx.dword(node + 28),
    };
}

test('getaddrinfo answers a list of ADDRINFOA in guest memory, and freeaddrinfo takes it back',
    ()=>{
        /** @type {number[]} */
        const freed = [];
        const fx = fixture();
        /** @type {any} */ (fx.host.heap).free = (/** @type {number} */ address)=>
            freed.push(address);
        cstring(fx, TEXT, 'localhost');
        cstring(fx, TEXT2, 'http');
        fx.bytes.fill(0, HINTS, HINTS + 32);
        fx.setDword(HINTS, 2);
        fx.setDword(HINTS + 8, SOCK_STREAM);
        fx.setDword(HINTS + 12, 6);
        assert.equal(fx.call('getaddrinfo', [TEXT, TEXT2, HINTS, RESULT]), 0);
        const node = fx.dword(RESULT);
        const info = addrinfoAt(fx, node);
        assert.deepEqual({ ...info, canonname: info.canonname !== 0, addr: info.addr !== 0 }, {
            flags: 0, family: AF_INET, socktype: SOCK_STREAM, protocol: 6,
            addrlen: SOCKADDR_IN_SIZE, canonname: true, addr: true, next: 0,
        });
        assert.equal(fx.host.readCString(info.canonname, 64), 'localhost', 'AI_CANONNAME');
        assert.equal(fx.bytes[info.addr], AF_INET);
        assert.deepEqual([...fx.bytes.subarray(info.addr + 2, info.addr + 8)],
            [0, 80, 127, 0, 0, 1], 'the port and the address in network order');

        fx.call('freeaddrinfo', [node]);
        assert.deepEqual(freed, [node]);
        fx.call('freeaddrinfo', [node]);
        fx.call('freeaddrinfo', [0x1234]);
        assert.deepEqual(freed, [node], 'a node it did not make, or made and took back, is left');
    });

test('getaddrinfo with no node is the loopback, or any address with AI_PASSIVE', ()=>{
    const fx = fixture();
    cstring(fx, TEXT2, '6112');
    assert.equal(fx.call('getaddrinfo', [0, TEXT2, 0, RESULT]), 0);
    let info = addrinfoAt(fx, fx.dword(RESULT));
    assert.deepEqual([...fx.bytes.subarray(info.addr + 2, info.addr + 8)],
        [0x17, 0xe0, 127, 0, 0, 1]);
    assert.equal(info.canonname, 0);
    assert.equal(info.socktype, 0, 'the hints\' type, which was none');

    fx.bytes.fill(0, HINTS, HINTS + 32);
    fx.setDword(HINTS, 1);
    assert.equal(fx.call('getaddrinfo', [0, TEXT2, HINTS, RESULT]), 0);
    info = addrinfoAt(fx, fx.dword(RESULT));
    assert.equal(fx.dword(info.addr + 4), 0, 'INADDR_ANY');
});

test('getaddrinfo refuses what Windows refuses, with the code as its answer', ()=>{
    const fx = fixture();
    cstring(fx, TEXT, 'example.invalid');
    cstring(fx, TEXT2, 'no-such-service');
    const name = cstring(fx, TEXT + 0x20, '10.0.0.1');
    /** @param {number[]} hints @returns {number} */
    const hinted = hints=>{
        fx.bytes.fill(0, HINTS, HINTS + 32);
        hints.forEach((value, at)=>fx.setDword(HINTS + at * 4, value));
        return HINTS;
    };
    fx.setDword(RESULT, 0xdead);
    assert.equal(fx.call('getaddrinfo', [TEXT, 0, 0, RESULT]), WSAHOST_NOT_FOUND,
        'a name with no resolver to ask');
    assert.equal(fx.dword(RESULT), 0, 'and the result is NULL');
    assert.equal(fx.call('WSAGetLastError'), WSAHOST_NOT_FOUND, 'the slot holds it too');
    assert.equal(fx.call('getaddrinfo', [0, 0, 0, RESULT]), WSAHOST_NOT_FOUND);
    assert.equal(fx.call('getaddrinfo', [name, TEXT2, 0, RESULT]), WSATYPE_NOT_FOUND);
    assert.equal(fx.call('getaddrinfo', [name, 0, hinted([0, 23]), RESULT]), WSAEAFNOSUPPORT,
        'no IPv6 stack, as on an XP that did not install one');
    assert.equal(fx.call('getaddrinfo', [name, 0, hinted([0, 0, 9]), RESULT]), WSAESOCKTNOSUPPORT);
    assert.equal(fx.call('getaddrinfo', [name, 0, hinted([0x100]), RESULT]), WSAEINVAL);
    assert.equal(fx.call('getaddrinfo', [0, cstring(fx, TEXT2, '80'), hinted([2]), RESULT]),
        WSAEINVAL, 'AI_CANONNAME with no node');
    assert.equal(fx.call('getaddrinfo', [name, 0, hinted([0, 0, 0, 0, 16]), RESULT]),
        WSANO_RECOVERY, 'a hint whose other members are not zero');
    cstring(fx, TEXT, 'localhost');
    assert.equal(fx.call('getaddrinfo', [TEXT, 0, hinted([4]), RESULT]), WSAHOST_NOT_FOUND,
        'AI_NUMERICHOST and a name');
    assert.equal(fx.call('getaddrinfo', [name, 0, hinted([4]), RESULT]), 0);

    fx.call('WSACleanup');
    assert.equal(fx.call('getaddrinfo', [name, 0, 0, RESULT]), WSANOTINITIALISED);
});

test('getaddrinfo asks the transport\'s resolver and lists every address it gave', async()=>{
    const fx = fixture();
    fx.registry.resolve = ()=>Promise.resolve([0x0a000001, 0x0a000002]);
    cstring(fx, TEXT, 'server.example');
    const answered = fx.call('getaddrinfo', [TEXT, 0, 0, RESULT]);
    assert.ok(answered instanceof Promise);
    assert.equal(await answered, 0);
    const first = addrinfoAt(fx, fx.dword(RESULT));
    const second = addrinfoAt(fx, first.next);
    assert.equal(fx.dword(first.addr + 4), 0x0100000a);
    assert.equal(fx.dword(second.addr + 4), 0x0200000a);
    assert.equal(second.next, 0);

    fx.registry.resolve = ()=>Promise.resolve([]);
    assert.equal(await fx.call('getaddrinfo', [TEXT, 0, 0, RESULT]), WSAHOST_NOT_FOUND);
});

test('getnameinfo names the loopback and the services file\'s ports, numbers otherwise', ()=>{
    const fx = fixture();
    writeSockaddr(fx.host.writeMemory, NAME, { host: 0x7f000001, port: 80 });
    assert.equal(fx.call('getnameinfo', [NAME, SOCKADDR_IN_SIZE, TEXT, 64, TEXT2, 32, 0]), 0);
    assert.equal(fx.host.readCString(TEXT, 64), 'bottlify');
    assert.equal(fx.host.readCString(TEXT2, 32), 'http');
    assert.equal(fx.call('getnameinfo', [NAME, SOCKADDR_IN_SIZE, TEXT, 64, TEXT2, 32, 0x0a]), 0);
    assert.equal(fx.host.readCString(TEXT, 64), '127.0.0.1', 'NI_NUMERICHOST');
    assert.equal(fx.host.readCString(TEXT2, 32), '80', 'NI_NUMERICSERV');

    writeSockaddr(fx.host.writeMemory, NAME, { host: 0x0a000001, port: 6112 });
    assert.equal(fx.call('getnameinfo', [NAME, SOCKADDR_IN_SIZE, TEXT, 64, TEXT2, 32, 0]), 0);
    assert.equal(fx.host.readCString(TEXT, 64), '10.0.0.1');
    assert.equal(fx.host.readCString(TEXT2, 32), '6112');
    assert.equal(fx.call('getnameinfo', [NAME, SOCKADDR_IN_SIZE, TEXT, 64, 0, 0, 4]),
        WSAHOST_NOT_FOUND, 'NI_NAMEREQD and no name');
    assert.equal(fx.call('getnameinfo', [NAME, SOCKADDR_IN_SIZE, TEXT, 4, 0, 0, 0]), WSAEFAULT,
        'a buffer too small');
    assert.equal(fx.call('getnameinfo', [NAME, 8, TEXT, 64, 0, 0, 0]), WSAEFAULT);
    assert.equal(fx.call('getnameinfo', [NAME, SOCKADDR_IN_SIZE, 0, 0, 0, 0, 0]),
        WSAHOST_NOT_FOUND, 'nothing asked for');
    fx.bytes[NAME] = 23;
    assert.equal(fx.call('getnameinfo', [NAME, 28, TEXT, 64, 0, 0, 0]), WSAEAFNOSUPPORT);
});

test('getprotobyname and getprotobynumber read the protocol file, and wsock32 #53 is one', ()=>{
    const fx = fixture();
    /** @param {number} entry */
    const protoent = entry=>({
        name: fx.host.readCString(fx.dword(entry), 32),
        alias: fx.host.readCString(fx.dword(fx.dword(entry + 4)), 32),
        aliasesEnd: fx.dword(fx.dword(entry + 4) + 4),
        number: fx.dword(entry + 8) & 0xffff,
    });
    const tcp = fx.call('getprotobyname', [cstring(fx, TEXT, 'tcp')]);
    assert.deepEqual(protoent(tcp), { name: 'tcp', alias: 'TCP', aliasesEnd: 0, number: 6 });
    const udp = fx.call('getprotobyname', [cstring(fx, TEXT, 'UDP')]);
    assert.deepEqual(protoent(udp).number, 17, 'by its alias, in any case');
    assert.deepEqual(protoent(fx.call('getprotobynumber', [1])).name, 'icmp');
    assert.equal(fx.call('getprotobyname', [cstring(fx, TEXT, 'sctp')]), 0);
    assert.equal(fx.call('WSAGetLastError'), WSANO_DATA);
    assert.equal(fx.call('getprotobynumber', [132]), 0);
    assert.equal(fx.winsock.ordinals.wsock32[53], 'getprotobyname');
    assert.equal(fx.winsock.ordinals.wsock32[54], 'getprotobynumber');
});

test('TransmitFile sends the head, the file through ReadFile, and the tail as one', async()=>{
    const body = new TextEncoder().encode('-file-');
    const kernel = fakeKernel(body);
    const fx = fixture({ kernel32: kernel.kernel32 });
    kernel.attach(fx.host);
    const { client, accepted } = connected(fx);
    fx.put(TEXT, '<');
    fx.put(TEXT2, '>');
    fx.setDword(INFO, TEXT);
    fx.setDword(INFO + 4, 1);
    fx.setDword(INFO + 8, TEXT2);
    fx.setDword(INFO + 12, 1);
    const ov = overlapped(fx);
    assert.equal(fx.call('TransmitFile', [client, 0x77, 0, 0, ov, INFO, 0]), 1);
    assert.equal(fx.dword(ov + 4), 8);
    assert.deepEqual(fx.signalled, [EVENT]);
    assert.equal(await fx.call('recv', [accepted, BUFFER, 64, 0]), 8);
    assert.equal(fx.read(BUFFER, 8), '<-file->');

    assert.equal(fx.call('TransmitFile', [client, 0x66, 0, 0, 0, 0, 0]), 0,
        'a handle ReadFile refuses');
    assert.equal(fx.call('WSAGetLastError'), WSA_INVALID_HANDLE);
    assert.equal(fx.call('TransmitFile', [client, 0, 0, 0, 0, 0, 2]), 0,
        'TF_REUSE_SOCKET needs TF_DISCONNECT');
    assert.equal(fx.call('WSAGetLastError'), WSAEINVAL);
    assert.equal(fx.call('TransmitFile', [client, 0, 0, 0, 0, INFO, 1]), 1,
        'the buffers alone, then the disconnect');
    assert.equal(fx.call('send', [client, TEXT, 1, 0]), SOCKET_ERROR, 'shut down after');
});

test('WSASendMsg sends its WSABUFs to the address its WSAMSG names', async()=>{
    const fx = fixture();
    const receiver = fx.call('socket', [AF_INET, SOCK_DGRAM, 0]);
    writeSockaddr(fx.host.writeMemory, NAME, { host: 0, port: PORT });
    fx.call('bind', [receiver, NAME, SOCKADDR_IN_SIZE]);
    const sender = fx.call('WSASocketW', [AF_INET, SOCK_DGRAM, 0, 0, 0, 0]);
    assert.notEqual(sender, INVALID_SOCKET);
    fx.put(BUFFER, 'hello');
    fx.put(BUFFER + 0x20, 'there');
    fx.setDword(WSABUF, 5);
    fx.setDword(WSABUF + 4, BUFFER);
    fx.setDword(WSABUF + 8, 5);
    fx.setDword(WSABUF + 12, BUFFER + 0x20);
    const message = 0x700;
    for (const [at, value] of [[0, NAME], [4, SOCKADDR_IN_SIZE], [8, WSABUF], [12, 2], [16, 0],
        [20, 0], [24, 0]])
    {
        fx.setDword(message + at, value);
    }
    assert.equal(fx.call('WSASendMsg', [sender, message, 0, OUT, 0, 0]), 0);
    assert.equal(fx.dword(OUT), 10);
    assert.equal(await fx.call('recvfrom', [receiver, OUT2, 32, 0, 0, 0]), 10);
    assert.equal(fx.read(OUT2, 10), 'hellothere');
    assert.equal(fx.call('WSASendMsg', [sender, 0, 0, OUT, 0, 0]), SOCKET_ERROR);
    assert.equal(fx.call('WSAGetLastError', []), 10014, 'no WSAMSG: WSAEFAULT');
});

test('inet_pton and inet_ntop read and write both families\' text', ()=>{
    const fx = fixture();
    fx.put(BUFFER, '192.168.0.7\0');
    assert.equal(fx.call('inet_pton', [AF_INET, BUFFER, OUT]), 1);
    assert.deepEqual([...fx.bytes.subarray(OUT, OUT + 4)], [192, 168, 0, 7]);
    fx.put(BUFFER, '2001:DB8::1\0');
    assert.equal(fx.call('inet_pton', [23, BUFFER, OUT]), 1);
    assert.equal(fx.call('inet_ntop', [23, OUT, OUT2, 46]), OUT2);
    assert.equal(fx.read(OUT2, 12), '2001:db8::1\0');
    fx.put(BUFFER, '1.2.3\0');
    assert.equal(fx.call('inet_pton', [AF_INET, BUFFER, OUT]), 0, 'not an address');
    assert.equal(fx.call('inet_pton', [99, BUFFER, OUT]), SOCKET_ERROR);
    assert.equal(fx.call('WSAGetLastError', []), 10047, 'WSAEAFNOSUPPORT');
    fx.bytes.set([10, 0, 0, 1], OUT);
    assert.equal(fx.call('inet_ntop', [AF_INET, OUT, OUT2, 16]), OUT2);
    assert.equal(fx.read(OUT2, 9), '10.0.0.1\0');
    assert.equal(fx.call('inet_ntop', [AF_INET, OUT, OUT2, 8]), 0, 'no room for the terminator');
    assert.equal(fx.call('WSAGetLastError', []), 87);
});

test('the catalogue holds MSAFD\'s TCP and UDP, its path unexpanded; no name space answers',
    ()=>{
        const fx = fixture();
        const errno = 0x7f0;
        fx.setDword(OUT, 0);
        assert.equal(fx.call('WSCEnumProtocols', [0, 0, OUT, errno]), SOCKET_ERROR);
        assert.equal(fx.dword(errno), 10055, 'WSAENOBUFS');
        assert.equal(fx.dword(OUT), 2 * 628);
        const catalogue = 0x1000;
        assert.equal(fx.call('WSCEnumProtocols', [0, catalogue, OUT, errno]), 2);
        assert.equal(fx.dword(catalogue + 88), SOCK_STREAM);
        assert.equal(fx.dword(catalogue + 92), 6);
        assert.equal(fx.dword(catalogue + 628 + 88), SOCK_DGRAM);
        // Only UDP asked for.
        fx.setDword(0x7e0, 17);
        fx.setDword(0x7e4, 0);
        assert.equal(fx.call('WSAEnumProtocolsA', [0x7e0, catalogue, OUT]), 1);
        assert.equal(fx.read(catalogue + 116, 20), 'MSAFD Tcpip [UDP/IP]');

        const guid = 0x7c0;
        fx.bytes.set(fx.bytes.subarray(catalogue + 20, catalogue + 36), guid);
        fx.setDword(OUT, 4);
        assert.equal(fx.call('WSCGetProviderPath', [guid, OUT2, OUT, errno]), SOCKET_ERROR);
        assert.equal(fx.dword(errno), 10014);
        const length = fx.dword(OUT);
        assert.equal(fx.call('WSCGetProviderPath', [guid, 0x2000, OUT, errno]), 0);
        const path = new TextDecoder('utf-16le').decode(
            fx.bytes.subarray(0x2000, 0x2000 + (length - 1) * 2));
        assert.equal(path, '%SystemRoot%\\system32\\mswsock.dll');
        fx.bytes[guid] ^= 1;
        assert.equal(fx.call('WSCGetProviderPath', [guid, 0x2000, OUT, errno]), SOCKET_ERROR);
        assert.equal(fx.dword(errno), WSAEINVAL, 'another provider');

        fx.setDword(OUT, 0);
        assert.equal(fx.call('WSAEnumNameSpaceProvidersW', [OUT, 0]), 0, 'none installed');
        assert.equal(fx.call('WSALookupServiceBeginW', [0x1000, 0, OUT]), SOCKET_ERROR);
        assert.equal(fx.call('WSAGetLastError', []), 10108, 'WSASERVICE_NOT_FOUND');
        assert.equal(fx.call('WSALookupServiceEnd', [1]), SOCKET_ERROR);
        assert.equal(fx.call('WSASetServiceW', [0x1000, 0, 0]), SOCKET_ERROR);
    });

test('a socket is not duplicated into another process', ()=>{
    const fx = fixture();
    const socket = fx.call('socket', [AF_INET, SOCK_STREAM, 0]);
    assert.equal(fx.call('WSADuplicateSocketW', [socket, 1234, OUT]), SOCKET_ERROR);
    assert.equal(fx.call('WSAGetLastError', []), WSAEINVAL);
    assert.equal(fx.call('WSADuplicateSocketW', [999, 1234, OUT]), SOCKET_ERROR);
    assert.equal(fx.call('WSAGetLastError', []), WSAENOTSOCK);
});

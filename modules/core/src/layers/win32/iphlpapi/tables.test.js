/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIphlpapiFunctions } from './functions.js';

const SIZE = 0x10;
const TABLE = 0x100;
const OUT = 0x40;

/**
 * IP Helper over a memory of its own, on the network 10.86.0.7, with the
 * sockets the socket layer would hand it.
 *
 * @param {any[]} [sockets]
 */
function machine(sockets = []){
    const memory = new Uint8Array(0x10000);
    const view = new DataView(memory.buffer);
    let next = 0x8000;
    let nextHandle = 0x40;
    /** @type {number[]} */
    const signalled = [];
    let lastError = 0xdeadbeef;
    const fns = /** @type {any} */ (createIphlpapiFunctions({
        readMemory: (address, length)=>memory.slice(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        localAddress: ()=>0x0a560007,
        allocate: bytes=>{
            const at = next;
            next += bytes;
            return at;
        },
        handles: { open: ()=>nextHandle++, close: ()=>true },
        openEvent: ()=>nextHandle++,
        sockets: ()=>sockets,
        processId: ()=>0x1000,
        signalEvent: handle=>signalled.push(handle),
        setLastError: code=>{
            lastError = code;
        },
    }));
    /** @param {number} address */
    const ansi = address=>{
        let out = '';
        for (let at = address; memory[at] !== 0; at++)
        {
            out += String.fromCharCode(memory[at]);
        }
        return out;
    };
    return { memory, view, fns, ansi, signalled, error: ()=>lastError };
}

test('GetIfTable sizes itself, then lists the adapter and the loopback in index order', ()=>{
    const { view, fns } = machine();
    view.setUint32(SIZE, 0, true);
    assert.equal(fns.GetIfTable.handler([0, SIZE, 1]), 122, 'ERROR_INSUFFICIENT_BUFFER');
    const needed = view.getUint32(SIZE, true);
    assert.equal(needed, 4 + 2 * 860);
    assert.equal(fns.GetIfTable.handler([TABLE, SIZE, 1]), 0);
    assert.equal(view.getUint32(TABLE, true), 2);
    assert.equal(view.getUint32(TABLE + 4 + 512, true), 1, 'the adapter first');
    assert.equal(view.getUint32(TABLE + 4 + 860 + 516, true), 24, 'then the loopback');
});

test('the route table holds the network, the host, the loopback and multicast', ()=>{
    const { view, fns } = machine();
    view.setUint32(SIZE, 0x1000, true);
    assert.equal(fns.GetIpForwardTable.handler([TABLE, SIZE, 1]), 0);
    const count = view.getUint32(TABLE, true);
    const rows = Array.from({ length: count }, (_, i)=>({
        destination: view.getUint32(TABLE + 4 + i * 56, false),
        mask: view.getUint32(TABLE + 4 + i * 56 + 4, false),
        index: view.getUint32(TABLE + 4 + i * 56 + 16, true),
    }));
    assert.ok(rows.some(row=>row.destination === 0x0a560000 && row.mask === 0xffffff00
        && row.index === 1), 'the on-link network on the adapter');
    assert.ok(rows.some(row=>row.destination === 0x7f000000 && row.mask === 0xff000000
        && row.index === 2), 'the loopback network on the loopback');
    assert.ok(rows.some(row=>row.destination === 0xe0000000 && row.mask === 0xf0000000));
    assert.deepEqual(rows.map(row=>row.destination),
        [...rows.map(row=>row.destination)].sort((a, b)=>a - b), 'in order when asked');

    // The best route to the peer next door is the adapter's network.
    assert.equal(fns.GetBestRoute.handler([0x0900560a, 0, TABLE]), 0);
    assert.equal(view.getUint32(TABLE + 16, true), 1);
    assert.equal(fns.GetBestRoute.handler([0x08080808, 0, TABLE]), 1231,
        'no gateway, so no route beyond the network');
});

test('an interface goes by its index, LUID, name and alias, each way round', ()=>{
    const { view, fns, ansi } = machine();
    const LUID = 0x200;
    const NAME = 0x300;
    assert.equal(fns.ConvertInterfaceIndexToLuid.handler([2, LUID]), 0);
    assert.equal(fns.ConvertInterfaceLuidToNameA.handler([LUID, NAME, 64]), 0);
    assert.match(ansi(NAME), /^loopback_\d+$/);
    assert.equal(fns.ConvertInterfaceLuidToNameA.handler([LUID, NAME, 3]), 8,
        'ERROR_NOT_ENOUGH_MEMORY where it does not fit');
    view.setBigUint64(LUID, 0n, true);
    assert.equal(fns.ConvertInterfaceNameToLuidA.handler([NAME, LUID]), 0);
    assert.equal(fns.ConvertInterfaceLuidToIndex.handler([LUID, OUT]), 0);
    assert.equal(view.getUint32(OUT, true), 2);
    assert.equal(fns.if_nametoindex.handler([NAME]), 2);
    assert.equal(fns.ConvertInterfaceIndexToLuid.handler([9, LUID]), 2, 'no such index');
    assert.equal(fns.ConvertLengthToIpv4Mask.handler([20, OUT]), 0);
    assert.equal(view.getUint32(OUT, false), 0xfffff000);
    assert.equal(fns.ConvertLengthToIpv4Mask.handler([33, OUT]), 87);
    assert.equal(view.getUint32(OUT, true), 0xffffffff, 'INADDR_NONE');
});

test('the TCP and UDP tables list the socket layer\'s sockets, with the owner where asked', ()=>{
    const listener = { type: 1, bound: true, closed: false, listening: true, connected: false,
        local: { host: 0, port: 6112 } };
    const peer = { type: 1, bound: true, closed: false, listening: false, connected: true,
        local: { host: 0x7f000001, port: 50000 }, remote: { host: 0x7f000001, port: 6112 } };
    const datagram = { type: 2, bound: true, closed: false, local: { host: 0, port: 4000 } };
    const { view, fns } = machine([listener, peer, datagram]);
    view.setUint32(SIZE, 0x1000, true);
    assert.equal(fns.GetTcpTable.handler([TABLE, SIZE, 1]), 0);
    assert.equal(view.getUint32(TABLE, true), 2);
    assert.equal(view.getUint32(TABLE + 4, true), 2, 'MIB_TCP_STATE_LISTEN');
    assert.equal(view.getUint16(TABLE + 4 + 8, false), 6112);

    // TCP_TABLE_OWNER_PID_LISTENER: the listener alone, with the process's id.
    assert.equal(fns.GetExtendedTcpTable.handler([TABLE, SIZE, 1, 2, 3, 0]), 0);
    assert.equal(view.getUint32(TABLE, true), 1);
    assert.equal(view.getUint32(TABLE + 4 + 20, true), 0x1000);

    assert.equal(fns.GetUdpTable.handler([TABLE, SIZE, 1]), 0);
    assert.equal(view.getUint32(TABLE, true), 1);
    assert.equal(view.getUint16(TABLE + 4 + 4, false), 4000);
});

test('a change request cancelled completes as cancelled, its event and handle set', ()=>{
    const { view, fns, signalled, error } = machine();
    const overlapped = 0x400;
    view.setUint32(overlapped + 16, 0x99, true);
    assert.equal(fns.NotifyAddrChange.handler([OUT, overlapped]), 997);
    assert.equal(error(), 997, 'the last error says pending too');
    assert.equal(view.getUint32(overlapped, true), 0x103, 'STATUS_PENDING');
    const handle = view.getUint32(OUT, true);
    assert.equal(fns.CancelIPChangeNotify.handler([overlapped]), 1);
    assert.equal(view.getUint32(overlapped, true), 0xc0000120, 'STATUS_CANCELLED');
    assert.deepEqual(signalled, [0x99, handle]);
});

test('an echo is answered on this machine and times out beyond it', ()=>{
    const { view, fns, error, signalled } = machine();
    const handle = fns.IcmpCreateFile.handler([]);
    const DATA = 0x500;
    const REPLY = 0x600;
    view.setUint32(DATA, 0x61626364, true);
    assert.equal(fns.IcmpSendEcho.handler([handle, 0x0100007f, DATA, 4, 0, REPLY, 64, 1000]), 1);
    assert.equal(error(), 0);
    assert.equal(view.getUint32(REPLY + 4, true), 0, 'IP_SUCCESS');
    assert.equal(view.getUint16(REPLY + 12, true), 4);
    assert.equal(view.getUint32(REPLY + 28, true), 0x61626364, 'the data echoed');

    assert.equal(fns.IcmpSendEcho.handler([handle, 0x08080808, DATA, 4, 0, REPLY, 64, 1000]), 0);
    assert.equal(error(), 11010, 'IP_REQ_TIMED_OUT');
    assert.equal(fns.IcmpSendEcho.handler([handle, 0x0100007f, DATA, 4, 0, REPLY, 8, 1000]), 0);
    assert.equal(error(), 87, 'a reply buffer smaller than one reply');

    // With an event: pending, and the event set once the reply is in.
    assert.equal(fns.IcmpSendEcho2.handler([handle, 0x77, 0, 0, 0x0100007f, DATA, 4, 0, REPLY,
        64, 1000]), 0);
    assert.equal(error(), 997);
    assert.deepEqual(signalled, [0x77]);
    assert.equal(fns.IcmpParseReplies.handler([REPLY, 64]), 1);
    assert.equal(fns.IcmpCloseHandle.handler([handle]), 1);
    assert.equal(fns.IcmpCloseHandle.handler([handle]), 0, 'only once');
});

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    ADAPTER_ADDRESSES, ADAPTER_INFO, HARDWARE_ADDRESS, IFROW, IF_ROW2, PREFIX, UNICAST,
    createIphlpapiFunctions,
} from './functions.js';

/** @param {number} [localAddress] */
function machine(localAddress){
    const memory = new Uint8Array(0x1000);
    const view = new DataView(memory.buffer);
    const fns = createIphlpapiFunctions({
        readMemory: (address, length)=>memory.slice(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        ...(localAddress === undefined ? {} : { localAddress: ()=>localAddress }),
    });
    /** @param {number} address */
    const text = address=>{
        let out = '';
        for (let at = address; memory[at] !== 0; at++)
        {
            out += String.fromCharCode(memory[at]);
        }
        return out;
    };
    return { memory, view, fns, text };
}

const SIZE = 0x10;
const INFO = 0x100;

test('the size the list needs comes first, then the one adapter it holds', ()=>{
    // The usual two calls: one to learn the size, one with a buffer of it.
    const { view, fns, text } = machine(0xc0a80105);
    view.setUint32(SIZE, 0, true);
    assert.equal(fns.GetAdaptersInfo.handler([0, SIZE]), 111, 'ERROR_BUFFER_OVERFLOW');
    assert.equal(view.getUint32(SIZE, true), ADAPTER_INFO.SIZE);
    view.setUint32(SIZE, 100, true);
    assert.equal(fns.GetAdaptersInfo.handler([INFO, SIZE]), 111, 'short of it');
    assert.equal(fns.GetAdaptersInfo.handler([INFO, 0]), 87, 'no size at all');

    view.setUint32(SIZE, ADAPTER_INFO.SIZE, true);
    assert.equal(fns.GetAdaptersInfo.handler([INFO, SIZE]), 0);
    assert.equal(view.getUint32(INFO + ADAPTER_INFO.NEXT, true), 0, 'the only one');
    assert.equal(view.getUint32(INFO + ADAPTER_INFO.ADDRESS_LENGTH, true), 6);
    assert.deepEqual([...new Uint8Array(view.buffer, INFO + ADAPTER_INFO.ADDRESS, 6)],
        HARDWARE_ADDRESS, 'the same hardware address every run');
    assert.equal(view.getUint32(INFO + ADAPTER_INFO.TYPE, true), 6, 'Ethernet');
    assert.match(text(INFO + ADAPTER_INFO.ADAPTER_NAME), /^\{[0-9A-F-]{36}\}$/);
    assert.equal(text(INFO + ADAPTER_INFO.IP_ADDRESS_LIST + 4), '192.168.1.5',
        'the address the network gave');
    assert.equal(view.getUint32(INFO + ADAPTER_INFO.CURRENT_IP_ADDRESS, true),
        INFO + ADAPTER_INFO.IP_ADDRESS_LIST);
});

test('without a network the adapter is there with no address', ()=>{
    const { view, fns, text } = machine(0x7f000001);
    view.setUint32(SIZE, ADAPTER_INFO.SIZE, true);
    assert.equal(fns.GetAdaptersInfo.handler([INFO, SIZE]), 0);
    assert.equal(text(INFO + ADAPTER_INFO.IP_ADDRESS_LIST + 4), '0.0.0.0');
    assert.equal(text(INFO + ADAPTER_INFO.IP_ADDRESS_LIST + 20), '0.0.0.0');
});

test('the interface count holds the adapter and the loopback interface', ()=>{
    const { view, fns } = machine();
    assert.equal(fns.GetNumberOfInterfaces.handler([0x100]), 0);
    assert.equal(view.getUint32(0x100, true), 2);
    assert.equal(fns.GetNumberOfInterfaces.handler([0]), 87, 'no place for the answer');
});

test('GetIfEntry fills the row of the adapter or the loopback by the index asked', ()=>{
    const { view, memory, fns } = machine(0x0a000005);
    assert.equal(fns.GetIfEntry.handler([0]), 87, 'no row');
    view.setUint32(INFO + IFROW.INDEX, 1, true);
    assert.equal(fns.GetIfEntry.handler([INFO]), 0);
    assert.equal(view.getUint32(INFO + IFROW.TYPE, true), 6, 'Ethernet');
    assert.equal(view.getUint32(INFO + IFROW.OPER_STATUS, true), 5, 'operational: on a network');
    assert.deepEqual([...memory.slice(INFO + IFROW.PHYS_ADDR, INFO + IFROW.PHYS_ADDR + 6)],
        [...HARDWARE_ADDRESS]);
    view.setUint32(INFO + IFROW.INDEX, 2, true);
    assert.equal(fns.GetIfEntry.handler([INFO]), 0);
    assert.equal(view.getUint32(INFO + IFROW.TYPE, true), 24, 'the loopback');
    view.setUint32(INFO + IFROW.INDEX, 9, true);
    assert.equal(fns.GetIfEntry.handler([INFO]), 13, 'ERROR_INVALID_DATA for no such interface');
});

test('GetInterfaceInfo asks for its size, then lists the one adapter', ()=>{
    const { view, fns } = machine();
    assert.equal(fns.GetInterfaceInfo.handler([0, SIZE]), 122, 'ERROR_INSUFFICIENT_BUFFER');
    assert.equal(view.getUint32(SIZE, true), 264);
    assert.equal(fns.GetInterfaceInfo.handler([INFO, SIZE]), 0);
    assert.deepEqual([view.getUint32(INFO, true), view.getUint32(INFO + 4, true)], [1, 1]);
    assert.equal(view.getUint16(INFO + 8, true), 0x5c, 'the device name, from its backslash');
});

/** A machine with a heap for GetIfTable2 and the memory to read lists in. */
function wide(/** @type {number} */ localAddress){
    const memory = new Uint8Array(0x10000);
    const view = new DataView(memory.buffer);
    /** @type {number[]} */
    const freed = [];
    let next = 0x8000;
    const fns = createIphlpapiFunctions({
        readMemory: (address, length)=>memory.slice(address, address + length),
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        localAddress: ()=>localAddress,
        allocate: bytes=>{
            const at = next;
            next += bytes;
            return at;
        },
        free: address=>freed.push(address),
    });
    /** @param {number} address */
    const wideText = address=>{
        let out = '';
        for (let at = address; view.getUint16(at, true) !== 0; at += 2)
        {
            out += String.fromCharCode(view.getUint16(at, true));
        }
        return out;
    };
    /** @param {number} address */
    const text = address=>{
        let out = '';
        for (let at = address; memory[at] !== 0; at++)
        {
            out += String.fromCharCode(memory[at]);
        }
        return out;
    };
    return { memory, view, fns, wideText, text, freed };
}

test('GetAdaptersAddresses lists the adapter, then the loopback, as a linked list', ()=>{
    const { view, fns, wideText, text } = wide(0x0a560001);
    view.setUint32(SIZE, 0, true);
    assert.equal(fns.GetAdaptersAddresses.handler([0, 0x10, 0, 0, SIZE]), 111);
    const needed = view.getUint32(SIZE, true);
    assert.ok(needed > 2 * ADAPTER_ADDRESSES.SIZE);
    const list = 0x1000;
    assert.equal(fns.GetAdaptersAddresses.handler([0, 0x10, 0, list, SIZE]), 0);

    const A = ADAPTER_ADDRESSES;
    assert.equal(view.getUint32(list + A.LENGTH, true), A.SIZE);
    assert.equal(view.getUint32(list + A.IF_INDEX, true), 1);
    assert.match(text(view.getUint32(list + A.ADAPTER_NAME, true)), /^\{[0-9A-F-]+\}$/);
    assert.equal(wideText(view.getUint32(list + A.FRIENDLY_NAME, true)), 'Ethernet');
    assert.equal(wideText(view.getUint32(list + A.DESCRIPTION, true)), 'Ethernet Adapter');
    assert.equal(wideText(view.getUint32(list + A.DNS_SUFFIX, true)), '');
    assert.equal(view.getUint32(list + A.PHYSICAL_ADDRESS_LENGTH, true), 6);
    assert.deepEqual([...new Uint8Array(view.buffer, list + A.PHYSICAL_ADDRESS, 6)],
        HARDWARE_ADDRESS);
    assert.equal(view.getUint32(list + A.IF_TYPE, true), 6);
    assert.equal(view.getUint32(list + A.OPER_STATUS, true), 1, 'IfOperStatusUp');
    assert.ok(view.getUint32(list + A.FLAGS, true) & 0x80, 'IPv4 enabled');
    assert.equal(view.getBigUint64(list + A.LUID, true), (6n << 48n) | (1n << 24n));

    const unicast = view.getUint32(list + A.FIRST_UNICAST, true);
    assert.equal(view.getUint32(unicast, true), UNICAST.SIZE);
    assert.equal(view.getUint32(unicast + UNICAST.SOCKADDR_LENGTH, true), 16);
    const sockaddr = view.getUint32(unicast + UNICAST.SOCKADDR, true);
    assert.equal(view.getUint16(sockaddr, true), 2, 'AF_INET');
    assert.equal(view.getUint32(sockaddr + 4, false), 0x0a560001, 'the address, network order');
    assert.equal(view.getUint8(unicast + UNICAST.ON_LINK_PREFIX_LENGTH), 24);

    /** @type {[number, number][]} */
    const prefixes = [];
    for (let at = view.getUint32(list + A.FIRST_PREFIX, true); at !== 0;
        at = view.getUint32(at + PREFIX.NEXT, true))
    {
        prefixes.push([view.getUint32(view.getUint32(at + PREFIX.SOCKADDR, true) + 4, false),
            view.getUint32(at + PREFIX.PREFIX_LENGTH, true)]);
    }
    assert.deepEqual(prefixes, [[0x0a560000, 24], [0x0a560001, 32], [0x0a5600ff, 32]]);

    const loopback = view.getUint32(list + A.NEXT, true);
    assert.notEqual(loopback, 0);
    assert.equal(view.getUint32(loopback + A.IF_TYPE, true), 24);
    assert.equal(wideText(view.getUint32(loopback + A.FRIENDLY_NAME, true)),
        'Loopback Pseudo-Interface 1');
    const loopbackAddress = view.getUint32(loopback + A.FIRST_UNICAST, true);
    assert.equal(view.getUint32(view.getUint32(loopbackAddress + UNICAST.SOCKADDR, true) + 4,
        false), 0x7f000001);
    assert.equal(view.getUint32(loopback + A.NEXT, true), 0, 'the end of the list');
    assert.ok(view.getUint32(loopback + A.NEXT, true) < list + needed);

    assert.equal(fns.GetAdaptersAddresses.handler([23, 0, 0, list, SIZE]), 232,
        'no IPv6 stack: ERROR_NO_DATA');
    assert.equal(fns.GetAdaptersAddresses.handler([0, 0, 4, list, SIZE]), 87, 'Reserved');
    assert.equal(fns.GetAdaptersAddresses.handler([0, 1, 0, list, SIZE]), 0);
    assert.equal(view.getUint32(list + A.FIRST_UNICAST, true), 0, 'GAA_FLAG_SKIP_UNICAST');
});

test('without a network the adapter is down and has no address', ()=>{
    const { view, fns } = wide(0x7f000001);
    view.setUint32(SIZE, 0x2000, true);
    assert.equal(fns.GetAdaptersAddresses.handler([0, 0, 0, 0x1000, SIZE]), 0);
    assert.equal(view.getUint32(0x1000 + ADAPTER_ADDRESSES.OPER_STATUS, true), 2);
    assert.equal(view.getUint32(0x1000 + ADAPTER_ADDRESSES.FIRST_UNICAST, true), 0);
    view.setUint32(0x10, 0x08080808, true);
    assert.equal(fns.GetBestInterface.handler([0x08080808, 0x10]), 1231, 'no route');
    assert.equal(fns.GetBestInterface.handler([0x0100007f, 0x10]), 0);
    assert.equal(view.getUint32(0x10, true), 2, 'the loopback');
});

test('the Vista interface rows, by LUID or index, alone and as a table', ()=>{
    const { view, fns, wideText, freed } = wide(0x0a560001);
    const row = 0x1000;
    view.setUint32(row + IF_ROW2.INDEX, 1, true);
    assert.equal(fns.GetIfEntry2.handler([row]), 0);
    assert.equal(wideText(row + IF_ROW2.ALIAS), 'Ethernet');
    assert.equal(view.getUint32(row + IF_ROW2.TYPE, true), 6);
    assert.equal(view.getUint32(row + IF_ROW2.MTU, true), 1500);
    assert.equal(view.getUint32(row + IF_ROW2.OPER_STATUS, true), 1);
    assert.equal(view.getUint32(row + IF_ROW2.PHYS_ADDR_LEN, true), 6);
    assert.equal(view.getBigUint64(row + IF_ROW2.TRANSMIT_SPEED, true), 1000000000n);
    const luid = view.getBigUint64(row, true);

    new Uint8Array(view.buffer).fill(0, row, row + IF_ROW2.SIZE);
    view.setBigUint64(row, (24n << 48n) | (2n << 24n), true);
    assert.equal(fns.GetIfEntry2.handler([row]), 0, 'by LUID');
    assert.equal(view.getUint32(row + IF_ROW2.INDEX, true), 2);
    view.setBigUint64(row, 0n, true);
    view.setUint32(row + IF_ROW2.INDEX, 9, true);
    assert.equal(fns.GetIfEntry2.handler([row]), 2, 'ERROR_FILE_NOT_FOUND');

    assert.equal(fns.GetIfTable2.handler([0x20]), 0);
    const table = view.getUint32(0x20, true);
    assert.equal(view.getUint32(table, true), 2);
    assert.equal(view.getBigUint64(table + 8, true), luid);
    assert.equal(view.getUint32(table + 8 + IF_ROW2.SIZE + IF_ROW2.TYPE, true), 24);
    fns.FreeMibTable.handler([table]);
    assert.deepEqual(freed, [table]);

    // The adapter's GUID, as GetAdaptersAddresses names it, to its LUID.
    new Uint8Array(view.buffer).set(new Uint8Array(view.buffer, 0x1000 + IF_ROW2.GUID, 16), 0x40);
    view.setUint32(row + IF_ROW2.INDEX, 1, true);
    fns.GetIfEntry2.handler([row]);
    new Uint8Array(view.buffer).set(new Uint8Array(view.buffer, row + IF_ROW2.GUID, 16), 0x40);
    assert.equal(fns.ConvertInterfaceGuidToLuid.handler([0x40, 0x60]), 0);
    assert.equal(view.getBigUint64(0x60, true), luid);
    view.setUint8(0x40, view.getUint8(0x40) ^ 1);
    assert.equal(fns.ConvertInterfaceGuidToLuid.handler([0x40, 0x60]), 87);
});

test('a connection table with no rows; changes never come; DHCP cannot be asked', ()=>{
    const { view, fns } = wide(0x0a560001);
    view.setUint32(SIZE, 0, true);
    assert.equal(fns.GetExtendedTcpTable.handler([0, SIZE, 1, 2, 5, 0]), 122);
    assert.equal(view.getUint32(SIZE, true), 4);
    view.setUint32(0x100, 0xffffffff, true);
    assert.equal(fns.GetExtendedTcpTable.handler([0x100, SIZE, 1, 2, 5, 0]), 0);
    assert.equal(view.getUint32(0x100, true), 0, 'dwNumEntries');
    assert.equal(fns.GetExtendedTcpTable.handler([0x100, SIZE, 1, 7, 5, 0]), 87, 'family');

    const overlapped = 0x200;
    assert.equal(fns.NotifyAddrChange.handler([0x30, overlapped]), 997, 'ERROR_IO_PENDING');
    assert.equal(fns.CancelIPChangeNotify.handler([overlapped]), 1);
    assert.equal(fns.CancelIPChangeNotify.handler([overlapped]), 0, 'only once');
    assert.ok(fns.NotifyAddrChange.handler([0, 0]) instanceof Promise, 'a blocking call waits');

    view.setUint32(0x300, 1, true);
    assert.equal(fns.IpRenewAddress.handler([0x300]), 50);
    view.setUint32(0x300, 7, true);
    assert.equal(fns.IpReleaseAddress.handler([0x300]), 87);
});

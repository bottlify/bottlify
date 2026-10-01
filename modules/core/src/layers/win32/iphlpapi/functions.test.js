/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADAPTER_INFO, HARDWARE_ADDRESS, createIphlpapiFunctions } from './functions.js';

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

/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceRing } from './d3d10-ring.js';
import { COMMAND, SHADOW } from './block.js';
import { D3D10_COMMANDS } from '../d3d10/commands.js';

test('the ring\'s records reach the device where they lie in guest memory, copied by nothing', ()=>{
    const ram = new Uint8Array(1 << 20);
    const words = new DataView(ram.buffer);
    let next = 0x10000;
    /** @type {Uint8Array[]} */
    const handed = [];
    let copies = 0;
    const ring = createDeviceRing({
        allocate: bytes=>{
            const at = next;
            next += bytes;
            return at;
        },
        memory: {
            readMemory: (address, length)=>{
                copies++;
                return ram.slice(address, address + length);
            },
            windowMemory: (address, length)=>ram.subarray(address, address + length),
            writeMemory: (address, bytes)=>ram.set(bytes, address),
            fillMemory: (address, value, length)=>ram.fill(value, address, address + length),
            readU32: address=>words.getUint32(address, true),
        },
        device: {
            commands: (/** @type {Uint8Array} */ records)=>{
                handed.push(records);
                return 1;
            },
        },
        objectAt: ()=>null,
        refuse: detail=>assert.fail(detail),
    });
    assert.ok(ring);
    const block = ring.address();
    const at = words.getUint32(block + SHADOW.COMMANDS, true);
    // One record, as a routine writes it: ClearDepthStencilView of no view.
    words.setUint32(at + COMMAND.SLOT, D3D10_COMMANDS.commandSlot('ClearDepthStencilView'), true);
    words.setUint32(at + COMMAND.BYTES, 24, true);
    words.setUint32(block + SHADOW.COMMAND_HEAD, 24, true);
    ring.sync();
    assert.equal(handed.length, 1);
    assert.equal(handed[0].buffer, ram.buffer, 'a view of guest memory');
    assert.equal(handed[0].byteOffset, at);
    assert.equal(copies, 0, 'nothing read through a copy');
});

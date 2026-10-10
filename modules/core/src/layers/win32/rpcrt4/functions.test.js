/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRpcFunctions } from './functions.js';

test('a UUID is made random and read back from its braceless spelling', ()=>{
    const memory = new Uint8Array(128);
    const text = '6B29FC40-CA47-1067-B31D-00DD010662DA';
    for (let at = 0; at < text.length; at++)
    {
        memory[64 + at] = text.charCodeAt(at);
    }
    const fns = createRpcFunctions({
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        readCString: (address, max)=>{
            let read = '';
            for (let at = address; memory[at] !== 0 && read.length < max; at++)
            {
                read += String.fromCharCode(memory[at]);
            }
            return read;
        },
    });
    assert.equal(fns.UuidCreate.handler([0]), 0, 'RPC_S_OK');
    assert.equal(memory[7] >> 4, 4, 'version 4');
    assert.equal(memory[8] >> 6, 2, 'variant 1');
    assert.equal(fns.UuidFromStringA.handler([64, 16]), 0);
    assert.deepEqual([...memory.subarray(16, 32)], [0x40, 0xfc, 0x29, 0x6b, 0x47, 0xca, 0x67, 0x10,
        0xb3, 0x1d, 0x00, 0xdd, 0x01, 0x06, 0x62, 0xda]);
    memory[64 + 8] = 0x58;
    assert.equal(fns.UuidFromStringA.handler([64, 16]), 1705, 'RPC_S_INVALID_STRING_UUID');
    assert.equal(fns.UuidFromStringA.handler([0, 32]), 0, 'NULL is the nil UUID');
    assert.deepEqual([...memory.subarray(32, 48)], new Array(16).fill(0));
});

test('a UUID is spelled into a string the caller frees with RpcStringFree', ()=>{
    // Wine's rpcrt4 test_UuidFromString: UuidToStringA's string reads back
    // through UuidFromStringA as the same UUID.
    const memory = new Uint8Array(0x400);
    const view = new DataView(memory.buffer);
    /** @type {number[]} */
    const freed = [];
    const fns = createRpcFunctions({
        writeMemory: (address, bytes)=>memory.set(bytes, address),
        readMemory: (address, length)=>memory.slice(address, address + length),
        readCString: (address, max)=>{
            let text = '';
            for (let at = address; at < address + max && memory[at] !== 0; at++)
            {
                text += String.fromCharCode(memory[at]);
            }
            return text;
        },
        readWideString: address=>{
            let text = '';
            for (let at = address; view.getUint16(at, true) !== 0; at += 2)
            {
                text += String.fromCharCode(view.getUint16(at, true));
            }
            return text;
        },
        allocate: ()=>0x200,
        free: address=>{
            freed.push(address);
        },
    });
    memory.set([0x40, 0xfc, 0x29, 0x6b, 0x47, 0xca, 0x67, 0x10,
        0xb3, 0x1d, 0x00, 0xdd, 0x01, 0x06, 0x62, 0xda], 0x10);
    assert.equal(fns.UuidToStringA.argBytes, 8);
    assert.equal(fns.UuidToStringA.handler([0x10, 0x40]), 0, 'RPC_S_OK');
    assert.equal(view.getUint32(0x40, true), 0x200);
    let text = '';
    for (let at = 0x200; memory[at] !== 0; at++)
    {
        text += String.fromCharCode(memory[at]);
    }
    assert.equal(text, '6b29fc40-ca47-1067-b31d-00dd010662da');
    assert.equal(fns.UuidFromStringA.handler([0x200, 0x80]), 0);
    assert.deepEqual([...memory.subarray(0x80, 0x90)], [...memory.subarray(0x10, 0x20)]);

    assert.equal(fns.UuidToStringA.handler([0, 0x40]), 0, 'NULL is the nil UUID');
    assert.equal(fns.RpcStringFreeA.argBytes, 4);
    assert.equal(fns.RpcStringFreeA.handler([0x40]), 0);
    assert.deepEqual(freed, [0x200]);
    assert.equal(view.getUint32(0x40, true), 0, 'and the pointer is cleared');

    assert.equal(fns.UuidToStringW.argBytes, 8);
    assert.equal(fns.RpcStringFreeW.argBytes, 4);
    assert.equal(fns.UuidToStringW.handler([0x10, 0x40]), 0, 'RPC_S_OK');
    const wide = view.getUint32(0x40, true);
    let spelled = '';
    for (let at = wide; view.getUint16(at, true) !== 0; at += 2)
    {
        spelled += String.fromCharCode(view.getUint16(at, true));
    }
    assert.equal(spelled, '6b29fc40-ca47-1067-b31d-00dd010662da', 'the same spelling in UTF-16');
    assert.equal(fns.UuidFromStringW.argBytes, 8);
    assert.equal(fns.UuidFromStringW.handler([wide, 0xa0]), 0, 'the UTF-16 string reads back');
    assert.deepEqual([...memory.subarray(0xa0, 0xb0)], [...memory.subarray(0x10, 0x20)]);
    assert.equal(fns.RpcStringFreeW.handler([0x40]), 0);
    assert.equal(freed.at(-1), wide);
    assert.equal(view.getUint32(0x40, true), 0);
});
